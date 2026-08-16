/**
 * Phase 1（车道 C）失败优先测试：V2 凭据原语 + V1 隔离门
 *
 * 覆盖（R1A-003 credential split 前置 / R1A-007 Attempt Token 签发、scope、
 * generation 校验）：
 * 1. src/server/v2/credentials.ts：签发/校验往返、篡改拒绝、scope 越权、
 *    generation fencing、fault-injector 时钟偏差时效、密钥未配置 fail-fast、
 *    密钥轮换（key_version）、泄漏语义（token 不含密钥材料、错误不回显 token）；
 * 2. src/server/v2/v1-isolation.ts + http-plugins 挂载：V2 项目上 V1 Worker
 *    派生 token 的 claim/report/renew/ownership declare/release 一律
 *    403 V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT；V1 项目行为不变；
 *    owner bearer 不受影响。plugin 级用可注入谓词测矩阵，真实链路用
 *    createHttpServer（0b fixture 的 test-plan + 真实 Redis）验证 task→project
 *    解析；
 * 3. registry 对齐门禁：node/task_attempt 数据面条目的 credentialBinding
 *    与 credentials.ts 实际导出的 verify 函数、Attempt token scope 枚举一致。
 *
 * Redis：6380 DB 15（与其他 distributed 测试共享，flush 隔离，串行执行）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as credentialsModule from '../../src/server/v2/credentials.js';
import {
  ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS,
  ATTEMPT_TOKEN_SCOPES,
  NODE_CREDENTIAL_DEFAULT_TTL_SECONDS,
  V2_CREDENTIAL_KEY_ENV,
  assertV2CredentialKeyConfigured,
  issueAttemptToken,
  issueNodeCredential,
  parseCredentialKey,
  parseCredentialKeyring,
  verifyAttemptToken,
  verifyNodeCredential,
  type V2CredentialKey,
} from '../../src/server/v2/credentials.js';
import {
  BIAO_V2_PROJECTS_ENV,
  V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT,
  V1_WORKER_GUARDED_PATHS,
  createV1IsolationGate,
  envV2EnabledProjectPredicate,
  isV2EnabledProject,
} from '../../src/server/v2/v1-isolation.js';
import { crossCuttingApiPlugin } from '../../src/server/http-plugins.js';
import { createHttpServer, deriveWorkerApiToken } from '../../src/server/http.js';
import { agentRegister, planSubmit } from '../../src/server/service.js';
import type { BiaoConfig } from '../../src/types/index.js';
import {
  V2_ROUTES,
  type V2RouteCredentialBinding,
} from '../../src/server/v2/routes/registry.js';
import {
  injectClockSkew,
  now as faultNow,
  resetAllFaults,
  resetClockSkew,
} from './fixtures/fault-injector.js';

const REDIS_URL = process.env.P1_CREDENTIALS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/15';
const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_PATH = '/tmp/biao-test';
const OTHER_PROJECT_PATH = '/tmp/biao-p1-other-project';
const TOKEN = 'p1-credentials-owner-token';
const WORKER_TOKEN = deriveWorkerApiToken(TOKEN);

/** 测试密钥（非生产；长度 ≥32 字节满足 HMAC 约束）。 */
const KEY_V1_HEX = 'c0ffee'.repeat(11); // 66 hex = 33 字节
const KEY_V2_HEX = 'deadbeef'.repeat(9); // 72 hex = 36 字节
const KEYS_V1: V2CredentialKey[] = parseCredentialKeyring(`1:${KEY_V1_HEX}`);
const KEYS_OVERLAP: V2CredentialKey[] = parseCredentialKeyring(`1:${KEY_V1_HEX},2:${KEY_V2_HEX}`);
const KEYS_V2_ONLY: V2CredentialKey[] = parseCredentialKeyring(`2:${KEY_V2_HEX}`);

const ATTEMPT_EXPECTED = {
  attemptId: 'att-p1-0001',
  taskId: 'task-p1-0001',
  generation: 4,
  scope: 'report' as const,
};

let redis: Redis;

// env 纪律：save/restore，避免 singleFork 串行污染
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // 快照 env（beforeEach 会删除这些键，afterAll 恢复）
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv[BIAO_V2_PROJECTS_ENV] = process.env[BIAO_V2_PROJECTS_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];

  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit().catch(() => undefined);
  // env 纪律：恢复快照
  for (const key of [V2_CREDENTIAL_KEY_ENV, BIAO_V2_PROJECTS_ENV, 'BIAO_V2_ENROLLMENT_TICKET']) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]!;
    } else {
      delete process.env[key];
    }
  }
});

beforeEach(async () => {
  // 凭据原语的默认密钥路径读 env：保持未配置，保证 fail-fast/verify 默认路径确定。
  delete process.env[V2_CREDENTIAL_KEY_ENV];
  delete process.env[BIAO_V2_PROJECTS_ENV];
  const keys = await redis.keys('biao:*');
  if (keys.length > 0) await redis.del(...keys);
});

afterEach(() => {
  resetAllFaults();
  delete process.env[BIAO_V2_PROJECTS_ENV];
});

/* ================================================================== */
/* 1. 凭据原语：Node credential / Attempt token                        */
/* ================================================================== */

describe('Phase 1 凭据原语：签发/校验往返与 fencing', () => {
  it('Node credential 往返：claims 完整、generation/key_version 内嵌、默认 TTL 为长期', () => {
    const token = issueNodeCredential('node-p1-alpha', 7, { keys: KEYS_V1, now: 1_000 });
    expect(token).toMatch(/^bvn2_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = verifyNodeCredential(token, 'node-p1-alpha', { keys: KEYS_V1, now: 2_000, expectedGeneration: 7 });
    expect(result).toMatchObject({
      ok: true,
      claims: {
        node_id: 'node-p1-alpha',
        generation: 7,
        key_version: 1,
        issued_at: 1_000,
        expires_at: 1_000 + NODE_CREDENTIAL_DEFAULT_TTL_SECONDS * 1000,
        jti: expect.stringMatching(/^[0-9a-f]{16,64}$/),
      },
    });
  });

  it('Attempt token 往返：scope/generation fencing 字段内嵌，默认 TTL 短于 lease 周期', () => {
    const token = issueAttemptToken(
      ATTEMPT_EXPECTED.attemptId,
      ATTEMPT_EXPECTED.taskId,
      ATTEMPT_EXPECTED.generation,
      ATTEMPT_EXPECTED.scope,
      { keys: KEYS_V1, now: 1_000 },
    );
    expect(token).toMatch(/^bva2_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = verifyAttemptToken(token, ATTEMPT_EXPECTED, { keys: KEYS_V1, now: 2_000 });
    expect(result).toMatchObject({
      ok: true,
      claims: {
        attempt_id: ATTEMPT_EXPECTED.attemptId,
        task_id: ATTEMPT_EXPECTED.taskId,
        generation: ATTEMPT_EXPECTED.generation,
        scope: 'report',
        key_version: 1,
        issued_at: 1_000,
        expires_at: 1_000 + ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS * 1000,
      },
    });
    // §13.5：Attempt token 必须显著短于 Node credential。
    expect(ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS).toBeLessThan(NODE_CREDENTIAL_DEFAULT_TTL_SECONDS);
  });

  it('node_id 不符拒绝（SUBJECT_MISMATCH）', () => {
    const token = issueNodeCredential('node-p1-alpha', 7, { keys: KEYS_V1, now: 1_000 });
    expect(verifyNodeCredential(token, 'node-p1-beta', { keys: KEYS_V1, now: 2_000 }))
      .toEqual({ ok: false, reason: 'SUBJECT_MISMATCH' });
  });

  it('attempt/task 归属不符拒绝：单一 token 只能操作单任务', () => {
    const token = issueAttemptToken('att-a', 'task-a', 1, 'claim', { keys: KEYS_V1, now: 1_000 });
    expect(verifyAttemptToken(token, { attemptId: 'att-b', taskId: 'task-a', generation: 1, scope: 'claim' }, { keys: KEYS_V1, now: 2_000 }))
      .toEqual({ ok: false, reason: 'SUBJECT_MISMATCH' });
    expect(verifyAttemptToken(token, { attemptId: 'att-a', taskId: 'task-b', generation: 1, scope: 'claim' }, { keys: KEYS_V1, now: 2_000 }))
      .toEqual({ ok: false, reason: 'SUBJECT_MISMATCH' });
  });

  it('generation 不匹配拒绝：Node credential 与 Attempt token 都做 fencing（§4.2/§13.5）', () => {
    const nodeToken = issueNodeCredential('node-p1-alpha', 7, { keys: KEYS_V1, now: 1_000 });
    expect(verifyNodeCredential(nodeToken, 'node-p1-alpha', { keys: KEYS_V1, now: 2_000, expectedGeneration: 8 }))
      .toEqual({ ok: false, reason: 'GENERATION_MISMATCH' });

    const attemptToken = issueAttemptToken('att-a', 'task-a', 2, 'question', { keys: KEYS_V1, now: 1_000 });
    expect(
      verifyAttemptToken(attemptToken, { attemptId: 'att-a', taskId: 'task-a', generation: 3, scope: 'question' }, { keys: KEYS_V1, now: 2_000 }),
    ).toEqual({ ok: false, reason: 'GENERATION_MISMATCH' });
  });

  it('scope 越权拒绝：claim scope 的 token 不能调 report 面', () => {
    const token = issueAttemptToken('att-a', 'task-a', 1, 'claim', { keys: KEYS_V1, now: 1_000 });
    const reasons = ATTEMPT_TOKEN_SCOPES
      .filter((scope) => scope !== 'claim')
      .map((scope) => verifyAttemptToken(
        token,
        { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope },
        { keys: KEYS_V1, now: 2_000 },
      ));
    expect(reasons).toEqual(reasons.map(() => ({ ok: false, reason: 'SCOPE_MISMATCH' })));
  });

  it('scope 枚举外的入参在签发侧直接抛出（不产生可校验 token）', () => {
    expect(() => issueAttemptToken('att-a', 'task-a', 1, 'admin' as never, { keys: KEYS_V1, now: 1_000 }))
      .toThrow(/scope 非法/);
  });
});

describe('Phase 1 凭据原语：篡改与结构拒绝', () => {
  it('篡改 payload 段或签名段都被拒绝', () => {
    const token = issueAttemptToken('att-a', 'task-a', 1, 'report', { keys: KEYS_V1, now: 1_000 });
    const [header, signature] = token.split('.');

    // 篡改签名段：仍是合法 base64url，但 HMAC 不再匹配。
    const flippedSignature = `${header}.${'A'.repeat(signature.length)}`;
    expect(verifyAttemptToken(flippedSignature, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'report' }, { keys: KEYS_V1, now: 2_000 }))
      .toEqual({ ok: false, reason: 'BAD_SIGNATURE' });

    // 篡改 payload 段（保持 base64url 形状）：规范化重编码或签名校验必然失败。
    const tamperedPayload = `${header.slice(0, -4)}AAAA.${signature}`;
    const tampered = verifyAttemptToken(tamperedPayload, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'report' }, { keys: KEYS_V1, now: 2_000 });
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(['MALFORMED_TOKEN', 'BAD_SIGNATURE']).toContain(tampered.reason);

    // 用另一把密钥验签：签名不匹配。
    expect(verifyAttemptToken(token, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'report' }, { keys: KEYS_V2_ONLY, now: 2_000 }))
      .toEqual({ ok: false, reason: 'UNKNOWN_KEY_VERSION' });
  });

  it('前缀/结构/字段异常一律 MALFORMED_TOKEN，不抛出', () => {
    const nodeToken = issueNodeCredential('node-a', 1, { keys: KEYS_V1, now: 1_000 });
    const attemptToken = issueAttemptToken('att-a', 'task-a', 1, 'report', { keys: KEYS_V1, now: 1_000 });
    for (const malformed of [
      '',
      'bvn2_onlypayload',
      'bvn2_payload.sig.extra',
      `bva2_${attemptToken.slice(5)}`, // attempt token 冒充 node credential
      `bvn2_${nodeToken.slice(5).toUpperCase()}`, // 非规范 base64url 大小写重写
      'bvn2_####.####',
    ]) {
      expect(verifyNodeCredential(malformed, 'node-a', { keys: KEYS_V1, now: 2_000 }))
        .toEqual({ ok: false, reason: 'MALFORMED_TOKEN' });
    }
  });

  it('伪造 claims（自造 JSON + 自算签名缺失）不能通过', () => {
    const forged = `bvn2_${Buffer.from(
      JSON.stringify({ v: 'bvn2', kv: 1, node_id: 'node-a', generation: 1, iat: 1, exp: 99999999999999, jti: 'a'.repeat(16) }),
    ).toString('base64url')}.${'0'.repeat(43)}`;
    expect(verifyNodeCredential(forged, 'node-a', { keys: KEYS_V1, now: 2_000 }))
      .toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });
});

describe('Phase 1 凭据原语：密钥 fail-fast、轮换与 fail-closed', () => {
  it('未配置密钥：启动断言 fail-fast 且给出生成指引；verify fail-closed；签发抛出', () => {
    expect(() => assertV2CredentialKeyConfigured({})).toThrow(/BIAO_V2_CREDENTIAL_KEY/);
    expect(() => assertV2CredentialKeyConfigured({})).toThrow(/openssl rand -hex 32/);
    expect(() => assertV2CredentialKeyConfigured({})).toThrow(/与 V1 BIAO_API_TOKEN 完全独立/);
    expect(() => issueNodeCredential('node-a', 1)).toThrow(/BIAO_V2_CREDENTIAL_KEY/);
    expect(verifyNodeCredential('bvn2_x.y', 'node-a')).toEqual({ ok: false, reason: 'NO_KEY_CONFIGURED' });
    expect(verifyAttemptToken('bva2_x.y', ATTEMPT_EXPECTED)).toEqual({ ok: false, reason: 'NO_KEY_CONFIGURED' });
  });

  it('密钥配置非法：启动断言抛出且不回显密钥值；verify 按无密钥处理', () => {
    for (const bad of ['tooshort', 'zz-not-hex', `${'a'.repeat(64)},1:${'b'.repeat(64)}`]) {
      expect(() => assertV2CredentialKeyConfigured({ [V2_CREDENTIAL_KEY_ENV]: bad })).toThrow();
      expect(() => assertV2CredentialKeyConfigured({ [V2_CREDENTIAL_KEY_ENV]: bad })).not.toThrow(/c0ffee|deadbeef/);
    }
    const token = issueNodeCredential('node-a', 1, { keys: KEYS_V1, now: 1_000 });
    expect(verifyNodeCredential(token, 'node-a', { now: 2_000 })).toEqual({ ok: false, reason: 'NO_KEY_CONFIGURED' });
  });

  it('密钥长度/格式校验：32 字节是下界，hex 之外拒绝', () => {
    expect(() => parseCredentialKey('a'.repeat(63), 1)).toThrow(/长度不足/);
    expect(() => parseCredentialKey('xyz', 1)).toThrow(/格式非法/);
    expect(parseCredentialKey('a'.repeat(64), 1).material.length).toBe(32);
    // 重复 key_version 无法确定验签语义。
    expect(() => parseCredentialKeyring(`1:${KEY_V1_HEX},1:${KEY_V2_HEX}`)).toThrow(/重复 key_version/);
  });

  it('密钥轮换：撤掉旧 version 后旧 Node credential 拒绝（UNKNOWN_KEY_VERSION，token 内嵌 key_version）', () => {
    const oldToken = issueNodeCredential('node-a', 1, { keys: KEYS_V1, now: 1_000 });
    // 轮换窗口内（1+2 双信任）：旧 token 仍可验。
    expect(verifyNodeCredential(oldToken, 'node-a', { keys: KEYS_OVERLAP, now: 2_000 }).ok).toBe(true);
    // 撤掉 v1 后：旧 token 因 key_version=1 不在密钥环被拒。
    const rejected = verifyNodeCredential(oldToken, 'node-a', { keys: KEYS_V2_ONLY, now: 2_000 });
    expect(rejected).toEqual({ ok: false, reason: 'UNKNOWN_KEY_VERSION' });
    // 新 token 由最高 version 签发，key_version 内嵌可见。
    const newToken = issueNodeCredential('node-a', 2, { keys: KEYS_V2_ONLY, now: 3_000 });
    const accepted = verifyNodeCredential(newToken, 'node-a', { keys: KEYS_V2_ONLY, now: 4_000, expectedGeneration: 2 });
    expect(accepted.ok && accepted.claims.key_version).toBe(2);
  });
});

describe('Phase 1 凭据原语：时效（fault-injector 时钟偏差）', () => {
  afterEach(() => resetClockSkew());

  it('时钟快进越过 TTL：Attempt token EXPIRED，Node credential 仍在有效期内', () => {
    const issuedAt = faultNow();
    const attemptToken = issueAttemptToken('att-a', 'task-a', 1, 'report', { keys: KEYS_V1, now: issuedAt });
    const nodeToken = issueNodeCredential('node-a', 1, { keys: KEYS_V1, now: issuedAt });

    expect(verifyAttemptToken(attemptToken, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'report' }, { keys: KEYS_V1, now: faultNow() }).ok).toBe(true);

    injectClockSkew((ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS + 60) * 1000);
    expect(verifyAttemptToken(attemptToken, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'report' }, { keys: KEYS_V1, now: faultNow() }))
      .toEqual({ ok: false, reason: 'EXPIRED' });
    // Node credential 是长期凭据：同一偏差下仍有效，撤销靠 generation fencing。
    expect(verifyNodeCredential(nodeToken, 'node-a', { keys: KEYS_V1, now: faultNow() }).ok).toBe(true);

    injectClockSkew((NODE_CREDENTIAL_DEFAULT_TTL_SECONDS + 60) * 1000);
    expect(verifyNodeCredential(nodeToken, 'node-a', { keys: KEYS_V1, now: faultNow() }))
      .toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('时钟偏差影响的是校验时刻，签发时刻不受注入影响', () => {
    const before = faultNow();
    const token = issueAttemptToken('att-a', 'task-a', 1, 'claim', { keys: KEYS_V1, now: before, ttlSeconds: 60 });
    injectClockSkew(-30_000); // 时钟回拨：仍在有效期内
    expect(verifyAttemptToken(token, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'claim' }, { keys: KEYS_V1, now: faultNow() }).ok).toBe(true);
    injectClockSkew(120_000); // 越过 60s TTL
    expect(verifyAttemptToken(token, { attemptId: 'att-a', taskId: 'task-a', generation: 1, scope: 'claim' }, { keys: KEYS_V1, now: faultNow() }).ok).toBe(false);
  });
});

describe('Phase 1 凭据原语：泄漏语义', () => {
  it('token 字符串不含密钥材料；校验结果不回显 token', () => {
    const nodeToken = issueNodeCredential('node-a', 1, { keys: KEYS_V1, now: 1_000 });
    const attemptToken = issueAttemptToken('att-a', 'task-a', 1, 'report', { keys: KEYS_V1, now: 1_000 });
    for (const token of [nodeToken, attemptToken]) {
      expect(token).not.toContain(KEY_V1_HEX);
      expect(token).not.toContain(KEY_V2_HEX);
    }
    // 失败结果序列化后不含 token 任何片段。
    const failures = [
      verifyNodeCredential(attemptToken, 'node-a', { keys: KEYS_V1, now: 2_000 }),
      verifyAttemptToken(nodeToken, ATTEMPT_EXPECTED, { keys: KEYS_V1, now: 2_000 }),
      verifyNodeCredential(nodeToken, 'node-b', { keys: KEYS_V1, now: 2_000 }),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(nodeToken);
      expect(JSON.stringify(failure)).not.toContain(attemptToken);
    }
  });

  it('fail-fast/签发错误信息不含密钥值', () => {
    try {
      assertV2CredentialKeyConfigured({ [V2_CREDENTIAL_KEY_ENV]: `1:${KEY_V1_HEX},1:${KEY_V2_HEX}` });
      expect.unreachable('重复 key_version 必须抛出');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(KEY_V1_HEX);
      expect(message).not.toContain(KEY_V2_HEX);
    }
  });
});

/* ================================================================== */
/* 2. V1 隔离门                                                        */
/* ================================================================== */

function writeTaskArtifacts(taskId: string): { resultPath: string; resultJsonPath: string } {
  const resultDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  const resultJsonPath = join(resultDir, 'result.json');
  writeFileSync(resultPath, '# P1 隔离门验证产物\n');
  writeFileSync(resultJsonPath, JSON.stringify({ task_id: taskId, status: 'done' }));
  return { resultPath, resultJsonPath };
}

/** plugin 级裸应用（与 p0a2-plugin-parity 同款装配）+ 可注入谓词。 */
async function buildBareApp(v2Projects: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  await crossCuttingApiPlugin(app, {
    redis,
    apiToken: TOKEN,
    workerApiToken: WORKER_TOKEN,
    host: '127.0.0.1',
    isV2EnabledProject: envV2EnabledProjectPredicate({ [BIAO_V2_PROJECTS_ENV]: v2Projects.join(',') }),
  });
  const stub = async () => ({ ok: true, data: { stub: true } });
  for (const path of V1_WORKER_GUARDED_PATHS) app.post(path, stub);
  app.post('/question', stub);
  app.get('/task/:task_id', stub);
  return app;
}

describe('Phase 1 V1 隔离门：谓词与判定单元', () => {
  it('默认谓词读 BIAO_V2_PROJECTS 逗号清单；未配置时恒 false（门禁 inert）', () => {
    const enabled = envV2EnabledProjectPredicate({ [BIAO_V2_PROJECTS_ENV]: `${PROJECT_PATH}, ${OTHER_PROJECT_PATH}/` });
    expect(enabled(PROJECT_PATH)).toBe(true);
    expect(enabled(`${PROJECT_PATH}/`)).toBe(true); // 尾斜杠归一
    expect(enabled('/tmp/biao-test-other')).toBe(false); // 前缀不相同即不同项目
    expect(enabled('/tmp/unrelated')).toBe(false);
    expect(envV2EnabledProjectPredicate({})(PROJECT_PATH)).toBe(false);
    // 任务书判据函数签名：默认直通 env 谓词。
    expect(isV2EnabledProject(PROJECT_PATH, { [BIAO_V2_PROJECTS_ENV]: PROJECT_PATH })).toBe(true);
    expect(isV2EnabledProject(PROJECT_PATH)).toBe(false);
  });

  it('guard 只约束五个数据面 POST；task 解析失败不拒绝（V1 语义由 handler 给出）', async () => {
    const gate = createV1IsolationGate({
      isV2EnabledProject: (projectId) => projectId === PROJECT_PATH,
      resolveTaskProject: async () => null,
      resolvePlanProject: async () => null,
    });
    expect(await gate.guard('GET', '/claim', {})).toEqual({ rejected: false });
    expect(await gate.guard('POST', '/question', {})).toEqual({ rejected: false });
    expect(await gate.guard('POST', '/report', {})).toEqual({ rejected: false }); // 无 task_id
    expect(await gate.guard('POST', '/report', { task_id: 'missing' })).toEqual({ rejected: false });
    expect(await gate.guard('POST', '/api/report', { task_id: 'missing' })).toEqual({ rejected: false });
  });

  it('claim 经 preferred_plan_ids 解析到 V2 项目同样拒绝', async () => {
    const gate = createV1IsolationGate({
      isV2EnabledProject: (projectId) => projectId === PROJECT_PATH,
      resolveTaskProject: async () => null,
      resolvePlanProject: async (planId) => (planId === 'plan-v2' ? PROJECT_PATH : OTHER_PROJECT_PATH),
    });
    expect(await gate.guard('POST', '/claim', { preferred_plan_ids: ['plan-v1'] })).toEqual({ rejected: false });
    expect(await gate.guard('POST', '/claim', { preferred_plan_ids: ['plan-v1', 'plan-v2'] }))
      .toEqual({ rejected: true, projectId: PROJECT_PATH });
  });
});

describe('Phase 1 V1 隔离门：plugin 触发矩阵（claim 显式项目）', () => {
  it.each(V1_WORKER_GUARDED_PATHS.map((path) => [path]))(
    '%s：V1 项目放行',
    async (path) => {
      const app = await buildBareApp([OTHER_PROJECT_PATH]);
      try {
        const body = path === '/claim'
          ? { preferred_project: PROJECT_PATH }
          : { task_id: 'task-x' };
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
          payload: body,
        });
        expect(response.statusCode, `V1 项目 ${path} 不应被隔离门拒绝`).toBe(200);
      } finally {
        await app.close();
      }
    },
  );

  it('worker token 对 V2 项目的 claim 403；owner bearer 不受影响；/api 前缀同样生效', async () => {
    const app = await buildBareApp([PROJECT_PATH]);
    try {
      const rejected = await app.inject({
        method: 'POST',
        url: '/claim',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { preferred_project: PROJECT_PATH },
      });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toEqual({
        ok: false,
        data: null,
        error: {
          code: V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT,
          message: expect.stringContaining(PROJECT_PATH),
        },
      });
      expect(rejected.json().error.message).not.toContain(WORKER_TOKEN);

      const viaPrefix = await app.inject({
        method: 'POST',
        url: '/api/claim',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { preferred_project: PROJECT_PATH },
      });
      expect(viaPrefix.statusCode).toBe(403);
      expect(viaPrefix.json().error.code).toBe(V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT);

      const owner = await app.inject({
        method: 'POST',
        url: '/claim',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { preferred_project: PROJECT_PATH },
      });
      expect(owner.statusCode).toBe(200);

      const anonymous = await app.inject({
        method: 'POST',
        url: '/claim',
        payload: { preferred_project: PROJECT_PATH },
      });
      expect(anonymous.statusCode).toBe(401); // 鉴权仍优先于隔离门
    } finally {
      await app.close();
    }
  });

  it('非守卫路由（/question、GET /task/:id）不经过隔离门（Phase 1 范围外）', async () => {
    const app = await buildBareApp([PROJECT_PATH]);
    try {
      const question = await app.inject({
        method: 'POST',
        url: '/question',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { task_id: 'task-x' },
      });
      expect(question.statusCode).toBe(200);
      const taskRead = await app.inject({
        method: 'GET',
        url: '/task/task-x',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      });
      expect(taskRead.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('Phase 1 V1 隔离门：真实 server（test-plan fixture + task→project 解析）', () => {
  const tempDirs: string[] = [];

  function serverConfig(): BiaoConfig {
    const dir = mkdtempSync(join(tmpdir(), 'biao-p1-cred-'));
    tempDirs.push(dir);
    return {
      port: 0,
      host: '127.0.0.1',
      redisUrl: REDIS_URL,
      authEnabled: true,
      apiToken: TOKEN,
      workspaceRoots: ['/tmp'],
      sqlitePath: join(dir, 'test.sqlite'),
      streamMaxlen: 1000,
      conflictRetention: 1000,
    };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  });

  async function submitFixturePlan(): Promise<string> {
    const submitted = await planSubmit(redis, join(FIXTURES, 'test-plan'));
    expect(submitted.ok).toBe(true);
    return submitted.data!.plan_id;
  }

  async function registerAgent(): Promise<string> {
    const registered = await agentRegister(redis, 'p1-cred-agent', 'mock', ['code']);
    expect(registered.ok).toBe(true);
    return registered.data!.registration_id;
  }

  it('V2 项目：worker token 的 claim/report/renew/ownership declare/release 全部 403，owner 可运维', async () => {
    process.env[BIAO_V2_PROJECTS_ENV] = PROJECT_PATH;
    const app = await createHttpServer(redis, { ...serverConfig(), workerApiToken: WORKER_TOKEN });
    try {
      await submitFixturePlan();
      const registrationId = await registerAgent();

      const claimBody = {
        agent_id: 'p1-cred-agent',
        registration_id: registrationId,
        claim_request_id: 'p1credclaimrequest0001',
        blocking: false,
      };

      // 1) worker claim（显式指向 V2 项目）→ 403。
      const workerClaim = await app.inject({
        method: 'POST',
        url: '/claim',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { ...claimBody, preferred_project: PROJECT_PATH },
      });
      expect(workerClaim.statusCode).toBe(403);
      expect(workerClaim.json().error.code).toBe(V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT);

      // 2) owner claim 不受影响，取 task/claim_token 供后续判定。
      const ownerClaim = await app.inject({
        method: 'POST',
        url: '/claim',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: claimBody,
      });
      expect(ownerClaim.statusCode).toBe(200);
      expect(ownerClaim.json().ok).toBe(true);
      const taskId = ownerClaim.json().data.task_id as string;
      const claimToken = ownerClaim.json().data.claim_token as string;

      // 3) worker 数据面四个 task 地址路由全部 403（task→project 经 getTask 解析）。
      const workerBodies = [
        { url: '/report', payload: { task_id: taskId, agent_id: 'p1-cred-agent', claim_token: claimToken, status: 'done' } },
        { url: '/lease/renew', payload: { task_id: taskId, claim_token: claimToken, extend_seconds: 60 } },
        { url: '/ownership/declare', payload: { agent_id: 'p1-cred-agent', task_id: taskId, claim_token: claimToken, files: [`${PROJECT_PATH}/work/${taskId}/result.md`] } },
        { url: '/ownership/release', payload: { agent_id: 'p1-cred-agent', task_id: taskId, claim_token: claimToken, files: [`${PROJECT_PATH}/work/${taskId}/result.md`] } },
      ];
      for (const { url, payload } of workerBodies) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
          payload,
        });
        expect(response.statusCode, `${url} 应被隔离门拒绝`).toBe(403);
        expect(response.json().error.code, url).toBe(V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT);
      }

      // 4) owner 运维通道不受影响：owner report 成功收口。
      const artifacts = writeTaskArtifacts(taskId);
      const ownerReport = await app.inject({
        method: 'POST',
        url: '/report',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          task_id: taskId,
          agent_id: 'p1-cred-agent',
          claim_token: claimToken,
          status: 'done',
          result_path: artifacts.resultPath,
          result_json_path: artifacts.resultJsonPath,
          verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
        },
      });
      expect(ownerReport.statusCode).toBe(200);
      expect(ownerReport.json().ok).toBe(true);
    } finally {
      await app.close();
      delete process.env[BIAO_V2_PROJECTS_ENV];
    }
  });

  it('V1 项目（未列入 BIAO_V2_PROJECTS）：worker token 主链路行为不变', async () => {
    process.env[BIAO_V2_PROJECTS_ENV] = OTHER_PROJECT_PATH;
    const app = await createHttpServer(redis, { ...serverConfig(), workerApiToken: WORKER_TOKEN });
    try {
      await submitFixturePlan();
      const registrationId = await registerAgent();
      const claimBody = {
        agent_id: 'p1-cred-agent',
        registration_id: registrationId,
        claim_request_id: 'p1credclaimrequest0002',
        blocking: false,
      };

      // 同一 fixture 项目显式 claim：不在 V2 清单 → 放行。
      const workerClaim = await app.inject({
        method: 'POST',
        url: '/claim',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { ...claimBody, preferred_project: PROJECT_PATH },
      });
      expect(workerClaim.statusCode).toBe(200);
      expect(workerClaim.json().ok).toBe(true);
      const taskId = workerClaim.json().data.task_id as string;
      const claimToken = workerClaim.json().data.claim_token as string;

      // worker renew/report 全链路不变。
      const renew = await app.inject({
        method: 'POST',
        url: '/lease/renew',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: { task_id: taskId, claim_token: claimToken, extend_seconds: 60 },
      });
      expect(renew.statusCode).toBe(200);
      expect(renew.json().ok).toBe(true);

      const artifacts = writeTaskArtifacts(taskId);
      const workerReport = await app.inject({
        method: 'POST',
        url: '/report',
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {
          task_id: taskId,
          agent_id: 'p1-cred-agent',
          claim_token: claimToken,
          status: 'done',
          result_path: artifacts.resultPath,
          result_json_path: artifacts.resultJsonPath,
          verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
        },
      });
      expect(workerReport.statusCode).toBe(200);
      expect(workerReport.json().ok).toBe(true);
    } finally {
      await app.close();
      delete process.env[BIAO_V2_PROJECTS_ENV];
    }
  });
});

/* ================================================================== */
/* 3. registry 凭据对齐门禁                                            */
/* ================================================================== */

describe('Phase 1 registry 门禁：credentialBinding 与 credentials.ts 对齐', () => {
  /** 期望矩阵：Phase 1 机器凭据数据面的路由 → verify 函数 + scope。 */
  const EXPECTED_BINDINGS: Record<string, V2RouteCredentialBinding> = {
    'POST /v2/nodes/enroll': { verifier: 'enrollment_ticket' },
    'POST /v2/nodes/register': { verifier: 'verifyNodeCredential' },
    'POST /v2/nodes/:node_id/heartbeat': { verifier: 'verifyNodeCredential' },
    'POST /v2/nodes/:node_id/offline': { verifier: 'verifyNodeCredential' },
    'POST /v2/tasks/claim': { verifier: 'verifyNodeCredential' },
    'POST /v2/attempts/:attempt_id/lease/renew': { verifier: 'verifyAttemptToken', attemptScope: 'claim' },
    'POST /v2/attempts/:attempt_id/question': { verifier: 'verifyAttemptToken', attemptScope: 'question' },
    'POST /v2/attempts/:attempt_id/report': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/artifacts/initiate': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'PUT /v2/artifacts/:artifact_id/content': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/artifacts/:artifact_id/complete': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'GET /v2/artifacts/:artifact_id': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/deliveries': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'GET /v2/deliveries/:delivery_id': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/attempts/:attempt_id/workspace/prepare': { verifier: 'verifyAttemptToken', attemptScope: 'ownership' },
    'POST /v2/attempts/:attempt_id/workspace/finalize': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/deliveries/:delivery_id/recover-artifacts': { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    'POST /v2/evidence-acceptances': { verifier: 'verifyNodeCredential' },
  };

  it('credentialScopes 含 node/task_attempt 的条目必须声明 credentialBinding，且与期望矩阵一致', () => {
    for (const entry of V2_ROUTES) {
      const needsBinding = entry.credentialScopes.some((scope) => scope === 'node' || scope === 'task_attempt');
      if (!needsBinding) {
        expect(entry.credentialBinding, `${entry.id} 不含机器凭据作用域，不应声明 credentialBinding`).toBeUndefined();
        continue;
      }
      const expected = EXPECTED_BINDINGS[entry.id];
      expect(expected, `${entry.id} 缺少期望的 credentialBinding 矩阵条目`).toBeDefined();
      expect(entry.credentialBinding, `${entry.id} 的 credentialBinding 与期望矩阵不一致`).toEqual(expected);
    }
    // 期望矩阵不允许漂移：每条都对应真实 registry 条目。
    const registryIds = new Set(V2_ROUTES.map((entry) => entry.id));
    for (const id of Object.keys(EXPECTED_BINDINGS)) {
      expect(registryIds.has(id), `期望矩阵引用了不存在的路由 ${id}`).toBe(true);
    }
  });

  it('verifier 名称必须是 credentials.ts 的真实导出；attemptScope 必须在枚举内', () => {
    for (const entry of V2_ROUTES) {
      const binding = entry.credentialBinding;
      if (!binding) continue;
      if (binding.verifier === 'verifyNodeCredential' || binding.verifier === 'verifyAttemptToken') {
        expect(typeof credentialsModule[binding.verifier], `${entry.id} 引用的 ${binding.verifier} 必须是 credentials.ts 真实导出`).toBe('function');
      }
      if (binding.verifier === 'verifyAttemptToken') {
        expect(ATTEMPT_TOKEN_SCOPES, `${entry.id} 的 attemptScope 必须在枚举内`).toContain(binding.attemptScope);
      }
    }
  });

  it('scope 枚举完整覆盖 §13.1 的四类 Attempt 能力', () => {
    expect([...ATTEMPT_TOKEN_SCOPES]).toEqual(['claim', 'report', 'ownership', 'question']);
  });
});
