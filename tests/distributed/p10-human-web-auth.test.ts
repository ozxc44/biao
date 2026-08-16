/**
 * Phase 10（方案 E）：Web 控制台远程人类登录（bvh2 Cookie 会话 + enrollment）
 *
 * 验证矩阵（docs/runbooks/remote-console-auth.md）：
 * 1. enrollment 全生命周期：owner 创建 → code 仅返回一次（bhe2_ 前缀、只存
 *    sha256）→ 消费换取 bvh2 HttpOnly Cookie → 重放 409 ENROLLMENT_ALREADY_USED
 *    → 过期 403 ENROLLMENT_EXPIRED → 无效码 401 ENROLLMENT_NOT_FOUND；
 * 2. Cookie 会话端点 POST/GET/DELETE 完整往返：DELETE 即吊销（human_sessions
 *    落 revoked 行，旧 Cookie 立即 401）；
 * 3. 远程放行（非 loopback 绑定）：有效 bvh2 Cookie → V1 读面（/status、
 *    /plans）+ V1 PM 面（/intake）+ V2 读面（/v2/projects，经 RBAC 矩阵）；
 * 4. 越权：auditor 的 Cookie 对 V1 mutation（POST /plan/submit）403
 *    HUMAN_SCOPE_DENIED；reviewer 放行到 handler 层；
 * 5. 本机登录不受影响：loopback local session 仍可用（两条路并行）；
 * 6. enrollment 创建 owner-only：非 owner 的 Cookie 403 OWNER_REQUIRED。
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { humanSessionV1RequestAllowed } from '../../src/server/http-plugins.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';

const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;
const OWNER_TOKEN = 'p10-human-web-owner';
const TEST_KEY = '00112233'.repeat(8); // 32 字节 hex

let redis: Redis;
let store: SqliteStore;
let remoteApp: FastifyInstance;
let loopbackApp: FastifyInstance;
let serverUrl = '';
let loopbackUrl = '';
let projectId = '';

/* env 纪律（p23 教训）：save/restore，singleFork 串行不泄漏。 */
const savedEnv: Record<string, string | undefined> = {};

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  baseUrl = serverUrl,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    setCookie: res.headers.get('set-cookie'),
  };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };

/** 浏览器同源头（POST/DELETE /auth/human-session 的 login CSRF 防线）。 */
function sameOrigin(baseUrl = serverUrl): Record<string, string> {
  return { origin: baseUrl, 'sec-fetch-site': 'same-origin' };
}

/** 从 Set-Cookie 提取 name=value 对（供后续请求携带）。 */
function cookiePair(setCookie: string | null): { header: string; value: string } {
  expect(setCookie).toBeTruthy();
  const pair = setCookie!.split(';')[0];
  return { header: pair, value: pair.split('=').slice(1).join('=') };
}

/** Owner 预登记 → 返回一次性 enrollment_code（明文仅此一次）。 */
async function createEnrollment(
  subject: string,
  role: string,
  pid?: string,
): Promise<string> {
  const res = await api('POST', '/v2/human-enrollments', {
    subject, role, ...(pid ? { project_id: pid } : {}),
  }, owner);
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return res.body.data.enrollment_code as string;
}

/** enrollment code → bvh2 Cookie 会话（返回 Cookie header 与响应体）。 */
async function loginWithCode(code: string): Promise<{ cookie: string; body: any }> {
  const res = await api('POST', '/auth/human-session', { enrollment_code: code }, sameOrigin());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  return { cookie: cookiePair(res.setCookie).header, body: res.body };
}

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  store = new SqliteStore(':memory:');
  // 远程场景：绑定 0.0.0.0（非 loopback）→ 本机 Owner 会话不可用，只剩远程登录。
  remoteApp = await createHttpServer(redis, {
    apiToken: OWNER_TOKEN,
    host: '0.0.0.0',
    port: 0,
    workspaceRoots: [],
  }, { sqliteStore: store });
  await remoteApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = remoteApp.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  serverUrl = `http://127.0.0.1:${port}`;

  // 世界搭建：V2 project + memberships（alice=reviewer、bob=auditor、carol=project_admin）
  const project = await api('POST', '/v2/projects', {
    name: 'p10-human-web',
    repo_path: '/tmp/biao-p10-human-web',
    default_branch: 'main',
    execution_mode: 'full',
  }, owner);
  expect(project.body.ok).toBe(true);
  projectId = project.body.data.project_id as string;
  for (const [subject, role] of [['alice', 'reviewer'], ['bob', 'auditor'], ['carol', 'project_admin']] as const) {
    const grant = await api('POST', '/v2/project-memberships', {
      project_id: projectId, subject, role,
    }, owner);
    expect(grant.body.ok).toBe(true);
  }
}, 30_000);

afterAll(async () => {
  if (remoteApp) await remoteApp.close();
  if (loopbackApp) await loopbackApp.close();
  if (store) store.close();
  if (redis) {
    await redis.flushdb();
    redis.disconnect();
  }
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV]!;
  else delete process.env[V2_CREDENTIAL_KEY_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
});

/* ──────────────── 0. 纯函数：V1 角色作用域矩阵 ──────────────── */

describe('P10 humanSessionV1RequestAllowed（V1 面角色作用域）', () => {
  it('读面全部 human 角色放行；auto_fix watchdog 例外仅 owner', () => {
    expect(humanSessionV1RequestAllowed('GET', '/status', 'auditor')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/plans', 'auditor')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/intake', 'reviewer')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/watchdog', 'auditor')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/watchdog', 'auditor', new URLSearchParams('auto_fix=true'))).toBe(false);
    expect(humanSessionV1RequestAllowed('GET', '/watchdog', 'owner', new URLSearchParams('auto_fix=1'))).toBe(true);
  });

  it('mutation：auditor 拒绝；reviewer/project_admin 限 PM 数据面；owner 超集', () => {
    expect(humanSessionV1RequestAllowed('POST', '/plan/submit', 'auditor')).toBe(false);
    expect(humanSessionV1RequestAllowed('POST', '/plan/submit', 'reviewer')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/plan/create', 'project_admin')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/task/t-1/review', 'reviewer')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/task/t-1/resolution', 'reviewer')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/question/q-1/answer', 'reviewer')).toBe(true);
    // 运维/Worker 面不在 PM 白名单：reviewer 也拒绝，owner 放行
    expect(humanSessionV1RequestAllowed('POST', '/db/restore', 'reviewer')).toBe(false);
    expect(humanSessionV1RequestAllowed('POST', '/db/restore', 'owner')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/claim', 'reviewer')).toBe(false);
    expect(humanSessionV1RequestAllowed('POST', '/claim', 'owner')).toBe(true);
    expect(humanSessionV1RequestAllowed('POST', '/plan/submit', 'owner')).toBe(true);
  });

  it('/api 前缀形态与根路径同判；/v2 面仅 owner（RBAC 矩阵另行判定）', () => {
    expect(humanSessionV1RequestAllowed('POST', '/api/plan/submit', 'auditor')).toBe(false);
    expect(humanSessionV1RequestAllowed('POST', '/api/plan/submit', 'reviewer')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/v2/projects', 'auditor')).toBe(false);
    expect(humanSessionV1RequestAllowed('GET', '/v2/projects', 'owner')).toBe(true);
    expect(humanSessionV1RequestAllowed('GET', '/api/v2/projects', 'owner')).toBe(true);
  });
});

/* ──────────────── 1-6. HTTP 全链路 ──────────────── */

describe('P10 方案 E：远程人类登录（enrollment → bvh2 Cookie 会话）', () => {
  let aliceCode = '';
  let aliceCookie = '';
  let aliceSessionId = '';
  let bobCookie = '';

  it('① enrollment 创建：owner-only；code（bhe2_）仅返回一次、落库只存 sha256', async () => {
    // 非 owner 的匿名请求在 onRequest 层 401（enrollment 路由不豁免鉴权）
    const anonymous = await api('POST', '/v2/human-enrollments', { subject: 'eve', role: 'auditor' });
    expect(anonymous.status).toBe(401);

    aliceCode = await createEnrollment('alice', 'reviewer', projectId);
    expect(aliceCode).toMatch(/^bhe2_[0-9a-f]{64}$/);
    // 落库只有 hash；明文不可再查（无查询端点，响应即终点）
    const row = store.getHumanEnrollmentByCodeHash(sha256hex(aliceCode));
    expect(row).toMatchObject({ subject: 'alice', role: 'reviewer', project_id: projectId, used_at: null, used_by_ip: '' });
    expect(row!.created_by).toBe('owner');
  });

  it('② 消费 code 换 bvh2 HttpOnly Cookie（SameSite=Strict、30 天）+ token 备用响应体', async () => {
    const res = await api('POST', '/auth/human-session', { enrollment_code: aliceCode }, sameOrigin());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      authenticated: true, subject: 'alice', role: 'reviewer', project_id: projectId,
    });
    expect(res.body.data.token).toMatch(/^bvh2_/);
    aliceSessionId = res.body.data.session_id as string;

    expect(res.setCookie).toContain('biao_human_session=');
    expect(res.setCookie).toContain('HttpOnly');
    expect(res.setCookie).toContain('SameSite=Strict');
    expect(res.setCookie).toContain('Max-Age=2592000');
    aliceCookie = cookiePair(res.setCookie).header;

    // 一次性：used_at 落库（含来源 IP），code 已烧
    const row = store.getHumanEnrollmentByCodeHash(sha256hex(aliceCode))!;
    expect(row.used_at).not.toBeNull();
    expect(row.used_at!).toBeGreaterThan(0);
    expect(row.used_by_ip).toBe('127.0.0.1');
  });

  it('③ 重放拒绝 409 ENROLLMENT_ALREADY_USED；过期 403；无效码 401', async () => {
    const replay = await api('POST', '/auth/human-session', { enrollment_code: aliceCode }, sameOrigin());
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('ENROLLMENT_ALREADY_USED');

    // 过期 enrollment：直接落库一条 expires_at 已过的登记（模拟等待超时）
    const expiredCode = `bhe2_${randomBytes(32).toString('hex')}`;
    store.insertHumanEnrollment({
      enrollment_id: `bhe-${randomBytes(10).toString('hex')}`,
      code_hash: sha256hex(expiredCode),
      subject: 'alice', role: 'reviewer', project_id: projectId,
      created_by: 'owner', created_at: Date.now() - 7200_000, expires_at: Date.now() - 1000,
      used_at: null, used_by_ip: '',
    });
    const expired = await api('POST', '/auth/human-session', { enrollment_code: expiredCode }, sameOrigin());
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('ENROLLMENT_EXPIRED');

    const invalid = await api('POST', '/auth/human-session', { enrollment_code: `bhe2_${'ab'.repeat(32)}` }, sameOrigin());
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('ENROLLMENT_NOT_FOUND');
  });

  it('④ 跨站登录拒绝（Origin ≠ Host）：login CSRF 防线', async () => {
    const code = await createEnrollment('carol', 'project_admin', projectId);
    const crossSite = await api('POST', '/auth/human-session', { enrollment_code: code }, {
      origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe('HUMAN_SESSION_ORIGIN_DENIED');
    // 防线在消费之前：code 未被烧，可继续正常使用
    const ok = await loginWithCode(code);
    expect(ok.body.data.subject).toBe('carol');
  });

  it('⑤ GET 会话状态（不回传 token）→ DELETE 登出即吊销 → 旧 Cookie 立即失效', async () => {
    const status = await api('GET', '/auth/human-session', undefined, { cookie: aliceCookie });
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ authenticated: true, subject: 'alice', role: 'reviewer' });
    expect(status.body.data.token).toBeUndefined();

    const logout = await api('DELETE', '/auth/human-session', undefined, {
      ...sameOrigin(), cookie: aliceCookie,
    });
    expect(logout.status).toBe(200);
    expect(logout.body.data.authenticated).toBe(false);
    expect(logout.setCookie).toContain('biao_human_session=;');
    expect(logout.setCookie).toContain('Max-Age=0');

    // human_sessions 吊销行落库（R1C-013：即时生效）
    expect(store.getHumanSession(aliceSessionId)).toMatchObject({ status: 'revoked', revoke_reason: 'web_console_logout' });

    const afterStatus = await api('GET', '/auth/human-session', undefined, { cookie: aliceCookie });
    expect(afterStatus.body.data.authenticated).toBe(false);

    const afterStatusV1 = await api('GET', '/status', undefined, { cookie: aliceCookie });
    expect(afterStatusV1.status).toBe(401);
  });

  it('⑥ 远程放行：非 loopback 部署 + 有效 bvh2 Cookie → V1 读面 + V1 PM 面 + V2 读面', async () => {
    // 远程部署下本机会话不可用（对照：login 页只有 enrollment 一条路）
    const sessionInfo = await api('GET', '/auth/session');
    expect(sessionInfo.body.data).toMatchObject({ authenticated: false, local_session_available: false });

    // bob（auditor）走完整 enrollment 登录
    const bobCode = await createEnrollment('bob', 'auditor', projectId);
    const bob = await loginWithCode(bobCode);
    bobCookie = bob.cookie;

    // V1 读面
    for (const path of ['/status', '/plans', '/intake?consumer=pm']) {
      const res = await api('GET', path, undefined, { cookie: bobCookie });
      expect(res.status, `GET ${path} 应放行`).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    // V2 读面：Cookie 在 onRequest 层注入 Authorization → RBAC 矩阵（auditor 只读面）
    const projects = await api('GET', '/v2/projects', undefined, { cookie: bobCookie });
    expect(projects.status).toBe(200);
    expect(projects.body.ok).toBe(true);
    const project = await api('GET', `/v2/projects/${projectId}`, undefined, { cookie: bobCookie });
    expect(project.status).toBe(200);
    expect(project.body.ok).toBe(true);
  });

  it('⑦ 越权：auditor 的 Cookie 对 V1 mutation（POST /plan/submit）403；reviewer 放行到 handler', async () => {
    const denied = await api('POST', '/plan/submit', {}, { cookie: bobCookie });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('HUMAN_SCOPE_DENIED');

    // reviewer（alice）重新登录：mutation 门放行 → 进入 handler 的 schema 校验（400 而非 403）
    const aliceCode2 = await createEnrollment('alice', 'reviewer', projectId);
    const alice2 = await loginWithCode(aliceCode2);
    const allowed = await api('POST', '/plan/submit', {}, { cookie: alice2.cookie });
    expect(allowed.status).toBe(400);
    expect(allowed.body.error.code).toBe('INVALID_REQUEST');

    // auditor 对 Worker 数据面同样拒绝（不在 PM 白名单）
    const claim = await api('POST', '/claim', {}, { cookie: bobCookie });
    expect(claim.status).toBe(403);
  });

  it('⑧ V2 写面越权由 RBAC 矩阵拒绝：auditor Cookie → POST /v2/projects 403', async () => {
    // POST /v2/projects registry 策略 human 最低角色 = owner；auditor 被 RBAC 拒
    const res = await api('POST', '/v2/projects', {
      name: 'p10-forbidden', repo_path: '/tmp/p10-forbidden', default_branch: 'main', execution_mode: 'full',
    }, { cookie: bobCookie });
    expect(res.status).toBe(403);
    expect([ 'RBAC_ROLE_DENIED', 'RBAC_SCOPE_DENIED' ]).toContain(res.body.error.code);
  });

  it('⑨ enrollment 创建 owner-only：auditor 的 Cookie 403 OWNER_REQUIRED', async () => {
    const res = await api('POST', '/v2/human-enrollments', {
      subject: 'eve', role: 'auditor', project_id: projectId,
    }, { cookie: bobCookie });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_REQUIRED');
  });

  it('⑩ 本机登录不受影响：loopback local session 与远程登录并行可用', async () => {
    loopbackApp = await createHttpServer(redis, {
      apiToken: OWNER_TOKEN,
      host: '127.0.0.1',
      port: 0,
      workspaceRoots: [],
    });
    await loopbackApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = loopbackApp.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    loopbackUrl = `http://127.0.0.1:${port}`;

    const before = await api('GET', '/auth/session', undefined, undefined, loopbackUrl);
    expect(before.body.data).toMatchObject({ local_session_available: true });

    const start = await api('POST', '/auth/local-session', undefined, sameOrigin(loopbackUrl), loopbackUrl);
    expect(start.status).toBe(200);
    const localCookie = cookiePair(start.setCookie).header;
    expect(localCookie).toContain('biao_local_owner=');

    const status = await api('GET', '/status', undefined, { cookie: localCookie }, loopbackUrl);
    expect(status.status).toBe(200);
    expect(status.body.ok).toBe(true);
  });

  it('⑪ membership 撤销 → 派生远程会话即时失效（每请求复核）', async () => {
    const code = await createEnrollment('carol', 'project_admin', projectId);
    const carol = await loginWithCode(code);
    const okBefore = await api('GET', '/status', undefined, { cookie: carol.cookie });
    expect(okBefore.status).toBe(200);

    // owner 撤销 carol 的 membership → 会话随 resolve 即时失效
    const memberships = await api('GET', `/v2/project-memberships?project_id=${projectId}`, undefined, owner);
    const carolMembership = memberships.body.data.items.find((m: { subject: string }) => m.subject === 'carol');
    const revoke = await api('POST', `/v2/project-memberships/${carolMembership.membership_id}/revoke`, {
      reason: 'p10 membership 撤销验证',
    }, owner);
    expect(revoke.body.ok).toBe(true);

    const deniedAfter = await api('GET', '/status', undefined, { cookie: carol.cookie });
    expect(deniedAfter.status).toBe(401);
  });

  it('⑫ revoke-all-sessions 紧急撤销同样收口远程 Cookie 会话', async () => {
    const code = await createEnrollment('alice', 'reviewer', projectId);
    const alice3 = await loginWithCode(code);
    const okBefore = await api('GET', '/status', undefined, { cookie: alice3.cookie });
    expect(okBefore.status).toBe(200);

    const revokeAll = await api('POST', '/v2/security/revoke-all-sessions', { reason: 'p10 紧急撤销' }, owner);
    expect(revokeAll.body.ok).toBe(true);

    const deniedAfter = await api('GET', '/status', undefined, { cookie: alice3.cookie });
    expect(deniedAfter.status).toBe(401);
  });

  it('⑬ 密钥环未配置时 fail-closed：登录码消费返回 ISSUE_FAILED，不放行无签名会话', async () => {
    // 隔离实例（主 store 在 ⑫ revoke-all 后已有 DB 轮换密钥，无法模拟空密钥环）。
    const isolatedStore = new SqliteStore(':memory:');
    let isolatedApp: FastifyInstance | undefined;
    const savedKey = process.env[V2_CREDENTIAL_KEY_ENV];
    delete process.env[V2_CREDENTIAL_KEY_ENV];
    try {
      isolatedApp = await createHttpServer(redis, {
        apiToken: OWNER_TOKEN,
        host: '0.0.0.0',
        port: 0,
        workspaceRoots: [],
      }, { sqliteStore: isolatedStore });
      await isolatedApp.listen({ port: 0, host: '127.0.0.1' });
      const addr = isolatedApp.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;

      // owner 角色 enrollment 无需项目/membership
      const create = await api('POST', '/v2/human-enrollments', {
        subject: 'rootless', role: 'owner',
      }, owner, baseUrl);
      expect(create.body.ok).toBe(true);
      const code = create.body.data.enrollment_code as string;

      const res = await api('POST', '/auth/human-session', { enrollment_code: code }, sameOrigin(baseUrl), baseUrl);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ISSUE_FAILED');
      // 一次性语义优先：签发失败的 code 也已烧毁（不可反复尝试）
      const row = isolatedStore.getHumanEnrollmentByCodeHash(sha256hex(code))!;
      expect(row.used_at).not.toBeNull();
      const replay = await api('POST', '/auth/human-session', { enrollment_code: code }, sameOrigin(baseUrl), baseUrl);
      expect(replay.status).toBe(409);
    } finally {
      process.env[V2_CREDENTIAL_KEY_ENV] = savedKey;
      await isolatedApp?.close().catch(() => undefined);
      isolatedStore.close();
    }
  });
});
