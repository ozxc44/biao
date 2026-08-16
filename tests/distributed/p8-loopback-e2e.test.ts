/**
 * Phase 8 步骤 1：单机 V2 loopback E2E（§21 Phase 8 · 车道 C）
 *
 * 五旗全开，一个测试进程内走完整业务闭环（此前 Phase 1-7a 均为分段验证，
 * 本文件第一次用一次断言链贯穿整条链路）：
 *
 *   建 project → enroll → register → heartbeat → claim(bva2) →
 *   workspace prepare → 写文件（占位 executor）→ artifact 三段上传 →
 *   finalize push → delivery(pending_review) → report(attempt done) →
 *   PM accept → merge queue 入队 → dispatch → merged → 默认分支验证 →
 *   BranchCleanup 排程 → 指标断言（merge_jobs=merged、outbox 无死信）
 *
 * 另含 §23.1 五旗矩阵的纯函数断言（默认值/开/乱序 fail-fast 指明缺哪面旗/
 * 脏值 fail-fast/路径→旗映射）——HTTP 层的全关 404 断言在
 * p8-rollback-window.test.ts（同一套 resolve 结果驱动路由门禁）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { parseCredentialKey, issueAttemptToken, V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
  describeV2FeatureFlags,
  isV2FeatureFlagOrderValid,
  missingPrerequisiteFlags,
  requiredV2FeatureFlagForPath,
  resolveAndValidateV2FeatureFlags,
  resolveV2FeatureFlags,
  V2FeatureFlagOrderError,
  V2FeatureFlagValueError,
} from '../../src/server/v2/feature-flags.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'p8-loopback-owner';
const ENROLLMENT_TICKET = 'p8-loopback-ticket';
const TEST_KEY = '00112233'.repeat(8); // 32 字节 hex
const keyring = [parseCredentialKey(TEST_KEY, 1)];

const tempDirs: string[] = [];
let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl = '';

/* env 纪律（p23 教训）：save/restore，singleFork 串行不泄漏 */
const savedEnv: Record<string, string | undefined> = {};

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 测试内 git（与 fixture 同款语义；独立实现，不 import 既有 fixture）。 */
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** 创建带一个初始 commit 的 bare remote。 */
async function createBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p8-lb-bare-'));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p8-lb-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p8 loopback fixture ${randomBytes(6).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p8', '-c', 'user.email=p8@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
  return bare;
}

async function remoteRefSha(bare: string, ref: string): Promise<string | null> {
  try {
    const out = await git(['ls-remote', bare, ref]);
    return out ? out.split('\t')[0] : null;
  } catch {
    return null;
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** V2 plan+task 种子（/v2/plans/import 属 Phase 9 缺口，E2E 直接落库）。 */
function seedTask(taskId: string, projectId: string, ownershipFiles: string[]): void {
  const planId = `plan-${projectId}`;
  store.upsertPlan({
    plan_id: planId,
    title: `p8 loopback plan ${projectId}`,
    status: 'submitted',
    project_path: `/tmp/p8-${projectId}`,
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });
  store.upsertTask({
    task_id: taskId,
    plan_id: planId,
    title: `p8 loopback ${taskId}`,
    type: 'implementation',
    phase: '1',
    status: 'pending',
    priority: 5,
    assignee: 'auto',
    ownership_files: JSON.stringify(ownershipFiles),
    ownership_modules: '',
    depends_on: '[]',
    timeout_seconds: 3600,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '',
    retries: 0,
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    last_question_id: '',
    last_question_answer: '',
    cancelled_at: '',
    verify_results: '[]',
    goal_md: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    project_id: projectId,
  });
}

/* ──────────────── §23.1 五旗矩阵（纯函数级） ──────────────── */

describe('Phase 8 五旗矩阵（§23.1，纯函数）', () => {
  it('缺省全关 = 纯 V1（依赖序合法）', () => {
    const flags = resolveV2FeatureFlags({});
    expect(flags).toEqual({
      DISTRIBUTED_MODE: false,
      ARTIFACTS: false,
      NODE_RUNTIME: false,
      GIT_DELIVERY: false,
      MERGE_QUEUE: false,
    });
    expect(isV2FeatureFlagOrderValid(flags)).toBe(true);
    expect(describeV2FeatureFlags(flags).distributed_mode).toBe(false);
  });

  it('乱序 fail-fast：开 MERGE_QUEUE 而 DISTRIBUTED_MODE 未开 → 逐面列出全部前置缺旗', () => {
    expect(() => resolveAndValidateV2FeatureFlags({
      BIAO_V2_MERGE_QUEUE: '1',
    })).toThrowError(V2FeatureFlagOrderError);
    try {
      resolveAndValidateV2FeatureFlags({ BIAO_V2_MERGE_QUEUE: '1' });
    } catch (err) {
      expect((err as V2FeatureFlagOrderError).missing).toEqual([
        'DISTRIBUTED_MODE', 'ARTIFACTS', 'NODE_RUNTIME', 'GIT_DELIVERY',
      ]);
      expect((err as Error).message).toContain('BIAO_DISTRIBUTED_MODE');
    }
  });

  it('乱序 fail-fast：开 NODE_RUNTIME 而 ARTIFACTS 未开 → 指明缺 BIAO_V2_ARTIFACTS', () => {
    try {
      resolveAndValidateV2FeatureFlags({
        BIAO_DISTRIBUTED_MODE: '1',
        BIAO_V2_NODE_RUNTIME: '1',
      });
      expect.unreachable('应当抛 V2FeatureFlagOrderError');
    } catch (err) {
      expect(err).toBeInstanceOf(V2FeatureFlagOrderError);
      expect((err as V2FeatureFlagOrderError).missing).toEqual(['ARTIFACTS']);
      expect((err as Error).message).toContain('BIAO_V2_ARTIFACTS');
    }
  });

  it('乱序 fail-fast：开 GIT_DELIVERY 而前置未全开 → 逐面列出缺的旗', () => {
    const missing = missingPrerequisiteFlags(resolveV2FeatureFlags({
      BIAO_DISTRIBUTED_MODE: 'on',
      BIAO_V2_GIT_DELIVERY: 'yes',
    }));
    expect(missing.GIT_DELIVERY).toEqual(['ARTIFACTS', 'NODE_RUNTIME']);
  });

  it('按序全开合法；等价值拼写（on/yes/true）与关值（0/off/false/空串）都收', () => {
    expect(() => resolveAndValidateV2FeatureFlags({ ...ALL_V2_FEATURE_FLAGS_ON_ENV })).not.toThrow();
    const mixed = resolveV2FeatureFlags({
      BIAO_DISTRIBUTED_MODE: 'true',
      BIAO_V2_ARTIFACTS: 'yes',
      BIAO_V2_NODE_RUNTIME: 'on',
      BIAO_V2_GIT_DELIVERY: '1',
      BIAO_V2_MERGE_QUEUE: 'TRUE',
    });
    expect(mixed.MERGE_QUEUE).toBe(true);
    const off = resolveV2FeatureFlags({
      BIAO_DISTRIBUTED_MODE: '0',
      BIAO_V2_ARTIFACTS: 'off',
      BIAO_V2_NODE_RUNTIME: 'false',
      BIAO_V2_GIT_DELIVERY: '',
      BIAO_V2_MERGE_QUEUE: 'No',
    });
    expect(Object.values(off).every((v) => v === false)).toBe(true);
  });

  it('脏值 fail-fast：拼错的旗值直接抛错，不静默当关', () => {
    expect(() => resolveV2FeatureFlags({ BIAO_V2_ARTIFACTS: 'maybe' })).toThrowError(V2FeatureFlagValueError);
    try {
      resolveV2FeatureFlags({ BIAO_V2_MERGE_QUEUE: 'enbaled' });
      expect.unreachable('应当抛 V2FeatureFlagValueError');
    } catch (err) {
      expect((err as V2FeatureFlagValueError).envVar).toBe('BIAO_V2_MERGE_QUEUE');
    }
  });

  it('路径 → 管辖旗映射（路由分组门禁的依据）', () => {
    expect(requiredV2FeatureFlagForPath('/v2/tasks/claim')).toBe('NODE_RUNTIME');
    expect(requiredV2FeatureFlagForPath('/v2/nodes/register')).toBe('NODE_RUNTIME');
    expect(requiredV2FeatureFlagForPath('/v2/attempts/att-1/report')).toBe('NODE_RUNTIME');
    expect(requiredV2FeatureFlagForPath('/v2/attempts/att-1/lease/renew')).toBe('NODE_RUNTIME');
    expect(requiredV2FeatureFlagForPath('/v2/attempts/att-1/workspace/prepare')).toBe('GIT_DELIVERY');
    expect(requiredV2FeatureFlagForPath('/v2/attempts/att-1/workspace/finalize')).toBe('GIT_DELIVERY');
    expect(requiredV2FeatureFlagForPath('/v2/deliveries/del-1/review')).toBe('GIT_DELIVERY');
    expect(requiredV2FeatureFlagForPath('/v2/branch-cleanups/run')).toBe('GIT_DELIVERY');
    expect(requiredV2FeatureFlagForPath('/v2/merge-jobs')).toBe('MERGE_QUEUE');
    expect(requiredV2FeatureFlagForPath('/v2/projects/p-1/merge-jobs/dispatch')).toBe('MERGE_QUEUE');
    expect(requiredV2FeatureFlagForPath('/v2/artifacts/art-1/content')).toBe('ARTIFACTS');
    // 管理/观测面与状态端点不受分旗管辖（只需 DISTRIBUTED_MODE / 永不关）
    expect(requiredV2FeatureFlagForPath('/v2/projects')).toBeNull();
    expect(requiredV2FeatureFlagForPath('/v2/incidents')).toBeNull();
    expect(requiredV2FeatureFlagForPath('/v2/metrics')).toBeNull();
    expect(requiredV2FeatureFlagForPath('/v2/feature-flags')).toBeNull();
  });
});

/* ──────────────── 单机 V2 loopback：一次断言整条链 ──────────────── */

describe('Phase 8 步骤 1：单机 V2 loopback 完整业务闭环', () => {
  let bare = '';
  let projectId = '';
  const nodeId = `node-p8-lb-${randomBytes(4).toString('hex')}`;
  let nodeCredential = '';
  let attemptId = '';
  let attemptTokenClaim = '';
  let workspaceDir = '';
  let artifactId = '';
  let artifactSha = '';
  let deliveryId = '';
  let mergeJobId = '';
  let mergedFinalSha = '';

  beforeAll(async () => {
    savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
    savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
    for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
    process.env['BIAO_V2_ENROLLMENT_TICKET'] = ENROLLMENT_TICKET;
    Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

    redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
    await redis.connect();
    await redis.flushdb();

    store = new SqliteStore(':memory:');
    app = await createHttpServer(redis, {
      apiToken: OWNER_TOKEN,
      host: '127.0.0.1',
      port: 0,
      workspaceRoots: [],
    }, { sqliteStore: store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
    if (store) store.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV]!;
    else delete process.env[V2_CREDENTIAL_KEY_ENV];
    if (savedEnv['BIAO_V2_ENROLLMENT_TICKET'] !== undefined) process.env['BIAO_V2_ENROLLMENT_TICKET'] = savedEnv['BIAO_V2_ENROLLMENT_TICKET']!;
    else delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
    for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
      else delete process.env[key];
    }
  });

  it('① 五旗全开状态端点：GET /v2/feature-flags（owner）', async () => {
    const res = await api('GET', '/v2/feature-flags', undefined, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = res.body.data.flags as Array<{ flag: string; enabled: boolean; prerequisites_satisfied: boolean }>;
    expect(rows.map((r) => r.flag)).toEqual([
      'DISTRIBUTED_MODE', 'ARTIFACTS', 'NODE_RUNTIME', 'GIT_DELIVERY', 'MERGE_QUEUE',
    ]);
    expect(rows.every((r) => r.enabled && r.prerequisites_satisfied)).toBe(true);
    expect(res.body.data.distributed_mode).toBe(true);
    expect(res.body.data.order_valid).toBe(true);
  });

  it('② 建 project（repo_path 指向本地 bare remote）', async () => {
    bare = await createBareRemote();
    const res = await api('POST', '/v2/projects', {
      name: 'p8-loopback',
      repo_path: bare,
      default_branch: 'main',
      execution_mode: 'full',
    }, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    projectId = res.body.data.project_id as string;
    // 种一个 V2 task（plans import 属 Phase 9；ownership_files 即写边界）
    seedTask(`task-lb-${projectId}`, projectId, ['a/**']);
  });

  it('③ enroll（ticket）→ ④ register（bvn2+协议握手）→ ⑤ heartbeat', async () => {
    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: ENROLLMENT_TICKET,
      node_id: nodeId,
    }, owner);
    expect(enroll.status).toBe(200);
    expect(enroll.body.ok).toBe(true);
    nodeCredential = enroll.body.data.node_credential as string;
    expect(nodeCredential.startsWith('bvn2_')).toBe(true);

    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId,
      slots: 2,
      requested_project_ids: [projectId],
      protocol_version: 2,
    }, bearer(nodeCredential));
    expect(register.status).toBe(200);
    expect(register.body.ok).toBe(true);

    const heartbeat = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, {
      protocol_version: 2,
      clock_skew_ms: 0,
      disk_free_gib: 100,
      disk_free_percent: 95,
      slots_in_use: 0,
      running_attempt_ids: [],
    }, bearer(nodeCredential));
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.ok).toBe(true);

    // owner authorize 节点→项目绑定（§12：claim 调度前置）
    const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
    expect(authorize.status).toBe(200);
    expect(authorize.body.ok).toBe(true);

    // 节点在线可见（§17.1 Nodes 读面）
    const nodes = await api('GET', '/v2/nodes', undefined, owner);
    expect(nodes.body.data.items.some((n: { node_id: string; status: string }) => n.node_id === nodeId && n.status === 'online')).toBe(true);
  });

  it('⑥ claim（bvn2）→ bva2 + ownership snapshot（claim 收尾项闭环）', async () => {
    const res = await api('POST', '/v2/tasks/claim', {
      project_id: projectId,
      agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(8).toString('hex')}`,
      task_id: `task-lb-${projectId}`,
    }, bearer(nodeCredential));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    attemptId = res.body.data.attempt_id as string;
    attemptTokenClaim = res.body.data.attempt_token as string;
    expect(attemptTokenClaim.startsWith('bva2_')).toBe(true);
    expect(res.body.data.attempt_generation).toBe(1);
    expect(res.body.data.lease_duration_ms).toBeGreaterThan(0);

    // claim 落 ownership snapshot（task.ownership_files → 写边界；finalize fail-closed 依据）
    const snapshots = store.listOwnershipSnapshotsByAttempt(attemptId);
    expect(snapshots).toHaveLength(1);
    expect(JSON.parse(snapshots[0].files)).toEqual(['a/**']);
  });

  it('⑦ workspace prepare（bva2 ownership scope）→ ⑧ 占位 executor 写文件', { timeout: 60_000 }, async () => {
    const attempt = store.getTaskAttempt(attemptId)!;
    const ownershipToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'ownership', { keys: keyring });
    const res = await api('POST', `/v2/attempts/${attemptId}/workspace/prepare`, {}, bearer(ownershipToken));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.prepare_state).toBe('ready');
    workspaceDir = res.body.data.workspace_dir as string;
    expect(res.body.data.base_sha).toBeTruthy();

    // 占位 executor：写一个授权路径内的文件
    mkdirSync(join(workspaceDir, 'a'), { recursive: true });
    writeFileSync(join(workspaceDir, 'a', 'loopback.md'), `p8 loopback 改动 ${randomBytes(4).toString('hex')}\n`);
  });

  it('⑨ artifact 三段上传（bva2 report scope 数据面）', async () => {
    const attempt = store.getTaskAttempt(attemptId)!;
    const reportToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'report', { keys: keyring });
    const content = Buffer.from(`p8 loopback artifact ${randomBytes(8).toString('hex')}\n`);
    artifactSha = sha256hex(content);

    const init = await api('POST', '/v2/artifacts/initiate', {
      attempt_id: attemptId,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: artifactSha,
    }, bearer(reportToken));
    expect(init.status).toBe(200);
    expect(init.body.ok).toBe(true);
    artifactId = init.body.data.artifact_id as string;

    const upload = await fetch(`${serverUrl}/v2/artifacts/${artifactId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...bearer(reportToken) },
      body: new Uint8Array(content),
    });
    expect(upload.status).toBe(200);
    expect((await upload.json()).ok).toBe(true);

    const complete = await api('POST', `/v2/artifacts/${artifactId}/complete`, {}, bearer(reportToken));
    expect(complete.status).toBe(200);
    expect(complete.body.ok).toBe(true);
    expect(complete.body.data.status).toBe('complete');
  });

  it('⑩ finalize push → delivery(pending_review)（artifact 完整 → 不经 pending_recovery）', { timeout: 60_000 }, async () => {
    const attempt = store.getTaskAttempt(attemptId)!;
    const reportToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'report', { keys: keyring });
    const res = await api('POST', `/v2/attempts/${attemptId}/workspace/finalize`, {
      artifact_refs: [{ artifact_id: artifactId }],
      author: 'p8-loopback-executor',
    }, bearer(reportToken));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.finalize_state).toBe('delivered');
    expect(res.body.data.status).toBe('pending_review');
    deliveryId = res.body.data.delivery_id as string;
    expect(res.body.data.changed_files).toEqual(['a/loopback.md']);

    // attempt 分支已推到远端；marker ref 同步存在（§6.5）
    expect(await remoteRefSha(bare, `refs/heads/biao/attempt/${attemptId}`)).toBe(res.body.data.head_sha);
    expect(await remoteRefSha(bare, `refs/biao/attempt-markers/${attemptId}`)).toBeTruthy();
  });

  it('⑪ report（bva2 report scope）→ attempt done / task done', async () => {
    const attempt = store.getTaskAttempt(attemptId)!;
    const reportToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'report', { keys: keyring });
    const res = await api('POST', `/v2/attempts/${attemptId}/report`, {
      status: 'done',
      artifact_refs: [{ artifact_id: artifactId, sha256: artifactSha }],
    }, bearer(reportToken));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(store.getTaskAttempt(attemptId)!.status).toBe('done');
    expect(store.getTask(attempt.task_id)!.status).toBe('done');
  });

  it('⑫ PM accept（owner）→ delivery accepted', async () => {
    const res = await api('POST', `/v2/deliveries/${deliveryId}/review`, {
      verdict: 'accept',
      reviewed_by: 'pm-loopback',
    }, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('accepted');
  });

  it('⑬ merge queue 入队 + dispatch → merged；默认分支前进到 final_sha', { timeout: 60_000 }, async () => {
    const headBefore = await remoteRefSha(bare, 'refs/heads/main');
    expect(headBefore).toBeTruthy();

    const enqueue = await api('POST', '/v2/merge-jobs', {
      project_id: projectId,
      delivery_id: deliveryId,
      expected_target_sha: headBefore,
    }, owner);
    expect(enqueue.status).toBe(200);
    expect(enqueue.body.ok).toBe(true);
    mergeJobId = enqueue.body.data.merge_job_id as string;
    expect(enqueue.body.data.status).toBe('queued');

    const dispatch = await api('POST', `/v2/projects/${projectId}/merge-jobs/dispatch`, {}, owner);
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.ok).toBe(true);
    expect(dispatch.body.data.status).toBe('merged');
    mergedFinalSha = dispatch.body.data.final_sha as string;

    // 幂等收敛：队列已空，重复 dispatch 返回 data=null（不双写）
    const again = await api('POST', `/v2/projects/${projectId}/merge-jobs/dispatch`, {}, owner);
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(again.body.data).toBeNull();

    // delivery → merged；默认分支 = final_sha
    expect(store.getDelivery(deliveryId)!.status).toBe('merged');
    expect(await remoteRefSha(bare, 'refs/heads/main')).toBe(mergedFinalSha);
    expect(mergedFinalSha).not.toBe(headBefore);
  });

  it('⑭ 默认分支内容验证：merged commit 里能读到 attempt 的文件', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p8-lb-verify-'));
    tempDirs.push(dir);
    const repo = join(dir, 'repo');
    await git(['clone', bare, repo]);
    await git(['checkout', mergedFinalSha], repo);
    const content = readFileSync(join(repo, 'a', 'loopback.md'), 'utf8');
    expect(content).toContain('p8 loopback 改动');
    // merge commit 信息指向 delivery（审计可追溯）
    const subject = await git(['log', '-1', '--format=%s', mergedFinalSha], repo);
    expect(subject).toContain(deliveryId);
  });

  it('⑮ BranchCleanup 排程：merged delivery 的 attempt 分支进入清理队列（保留窗口）', async () => {
    const res = await api('GET', `/v2/branch-cleanups?project_id=${projectId}`, undefined, owner);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<{ branch_ref: string; status: string; eligible_at: number; retention_until: number }>;
    const record = items.find((r) => r.branch_ref === `refs/heads/biao/attempt/${attemptId}`);
    expect(record).toBeTruthy();
    expect(record!.status).toBe('pending');
    expect(record!.eligible_at).toBeGreaterThan(Date.now()); // §4.4.2 保留窗口未到，不立即删
    // 分支仍在（cleanup 只排程不抢跑）
    expect(await remoteRefSha(bare, `refs/heads/biao/attempt/${attemptId}`)).toBeTruthy();
  });

  it('⑯ 指标断言：merge_jobs=merged、outbox 无死信', async () => {
    const res = await fetch(`${serverUrl}/v2/metrics`, { headers: owner });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('# TYPE biao_merge_jobs gauge');
    expect(text).toMatch(/biao_merge_jobs\{status="merged"\} 1/);
    expect(text).toMatch(/biao_outbox_dead_letter_total 0/);
    expect(text).toMatch(/biao_nodes\{status="online"\} 1/);

    const dead = await api('GET', '/v2/outbox/dead-letters', undefined, owner);
    expect(dead.body.data.count).toBe(0);
  });
});
