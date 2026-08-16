/**
 * Phase 6 失败优先测试：Human Identity 与 RBAC（真实 HTTP）
 *
 * 覆盖（§21 Phase 6 验收原文三矩阵 + §13.2 威胁模型 + 凭据生命周期）：
 * 1. 三条硬规则：Worker（node/attempt 凭据）不能 Review/merge；Reviewer 不能
 *    管理 Node（enroll/authorize/revoke/drain）；跨项目 Artifact 不可读
 *    （membership 无该项目 → 403）。
 * 2. 角色越权矩阵全组合：owner/project_admin/reviewer/auditor × 关键路由组，
 *    允许/拒绝逐断言（含 auditor 只读面：plans/nodes/deliveries/projects 状态）。
 * 3. 会话吊销即时生效（revoke 即失效，R1C-013 同语义）；membership 撤销
 *    同样即时传导到派生会话。
 * 4. revoke-all-sessions：按 key_version 前滚后 bvn2/bva2/bvh2 全部旧 token
 *    立即失效；新版本签发可继续（re-enroll / claim / bvh2 签发全通）。
 * 5. Node credential 轮换：旧 token 409、新 token 通过、node session
 *    generation 单调递增。
 * 6. 审计事件完整性：敏感操作逐条入 audit_events，correlation_id 贯穿
 *    （请求头 x-correlation-id → 响应头 → 审计行）。
 * 7. registry 策略派生门禁：作用域细化（owner | human(role≥x) | node |
 *    attempt）与三条硬规则的路由声明一致性。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { V2_CREDENTIAL_KEY_ENV, issueAttemptToken } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import {
  V2_ROUTES,
  deriveCredentialPolicy,
} from '../../src/server/v2/routes/registry.js';
import { HUMAN_ROLE_RANK } from '../../src/server/v2/human-identity.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'p6-owner-token';
const TEST_KEY_HEX = '11223344'.repeat(8); // 32 bytes hex

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];

/* env 纪律（p23 教训）：save/restore，singleFork 串行不泄漏 */
const savedEnv: Record<string, string | undefined> = {};

function sha256hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-p6-'));
  tempDirs.push(dir);
  return join(dir, 'biao.sqlite');
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  rawBody?: Buffer,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const opts: RequestInit = { method };
  if (rawBody !== undefined) {
    opts.headers = { 'Content-Type': 'application/octet-stream', ...headers };
    opts.body = new Uint8Array(rawBody);
  } else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...headers };
    opts.body = JSON.stringify(body);
  } else {
    opts.headers = { ...headers };
  }
  const res = await fetch(`${serverUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => { responseHeaders[key] = value; });
  return { status: res.status, body: json, headers: responseHeaders };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/* ---------------------------------------------------------------- */
/* 世界状态（describe 间按文件顺序共享）                             */
/* ---------------------------------------------------------------- */

let projectP1 = '';
let projectP2 = '';
let projectP3 = '';
let nodeId = 'node-p6-main-000000000001';
let nodeCredential = '';
let rotatedCredential = '';
let attemptP1a = '';
let attemptP1aToken = '';
let attemptP1b = '';
let attemptP2 = '';
let artifactP1 = '';
let artifactP2 = '';
let deliveryP1 = '';
let deliveryReview = '';
let artifactP1Sha = '';

let sessionAlice = ''; // reviewer @ P1
let sessionBob = '';   // auditor @ P1
let sessionCarol = ''; // project_admin @ P1
let sessionDave = '';  // reviewer @ P2
let sessionRoot = '';  // owner（平台级）
let aliceSessionId = '';
let bobSessionId = '';
let daveSessionId = '';
let reportTokenMain = ''; // attemptP1a 的 scope=report bva2（读面矩阵行用）

function seedTask(taskId: string, projectId: string): void {
  store.upsertTask({
    task_id: taskId,
    plan_id: 'plan-p6',
    title: `P6 ${taskId}`,
    type: 'implementation',
    phase: '1',
    status: 'pending',
    priority: 5,
    assignee: 'auto',
    ownership_files: '[]',
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

async function createArtifact(attemptId: string, marker: string): Promise<string> {
  const content = Buffer.from(`p6 artifact ${marker} ${randomBytes(6).toString('hex')}`);
  const sha = sha256hex(content);
  const init = await api('POST', '/v2/artifacts/initiate', {
    attempt_id: attemptId,
    kind: 'result-md',
    size_bytes: content.length,
    sha256: sha,
  }, owner);
  expect(init.status).toBe(200);
  expect(init.body.ok).toBe(true);
  const artifactId = init.body.data.artifact_id as string;
  const upload = await api('PUT', `/v2/artifacts/${artifactId}/content`, undefined, owner, content);
  expect(upload.status).toBe(200);
  const complete = await api('POST', `/v2/artifacts/${artifactId}/complete`, {}, owner);
  expect(complete.status).toBe(200);
  expect(complete.body.ok).toBe(true);
  return artifactId;
}

function seedPlan(): void {
  store.upsertPlan({
    plan_id: 'plan-p6',
    title: 'P6 RBAC Test Plan',
    status: 'submitted',
    project_path: '/tmp/p6',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 3,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });
}

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  // Phase 8 五旗（RBAC 覆盖 V2 全路由组）
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  store = new SqliteStore(makeDbPath());

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
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) {
    process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV];
  } else {
    delete process.env[V2_CREDENTIAL_KEY_ENV];
  }
  if (savedEnv['BIAO_V2_ENROLLMENT_TICKET'] !== undefined) {
    process.env['BIAO_V2_ENROLLMENT_TICKET'] = savedEnv['BIAO_V2_ENROLLMENT_TICKET'];
  } else {
    delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  }
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
});

/* ================================================================ */
/* 0. 世界搭建：项目 / membership / 人类会话 / Worker 数据面         */
/* ================================================================ */

describe('Phase 6 世界搭建', () => {
  it('创建三个项目（P1/P2 主场景，P3 模式切换专用）', async () => {
    for (const name of ['p6-alpha', 'p6-beta', 'p6-gamma']) {
      const res = await api('POST', '/v2/projects', {
        name,
        repo_path: `/tmp/biao-${name}`,
        default_branch: 'main',
        execution_mode: 'full',
      }, owner);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      if (name === 'p6-alpha') projectP1 = res.body.data.project_id;
      if (name === 'p6-beta') projectP2 = res.body.data.project_id;
      if (name === 'p6-gamma') projectP3 = res.body.data.project_id;
    }
    expect(projectP1).toBeTruthy();
    expect(projectP2).toBeTruthy();
    expect(projectP3).toBeTruthy();
  });

  it('Owner 授予 memberships：alice=reviewer@P1、bob=auditor@P1、carol=project_admin@P1、dave=reviewer@P2', async () => {
    const grants: Array<[string, string, string]> = [
      [projectP1, 'alice', 'reviewer'],
      [projectP1, 'bob', 'auditor'],
      [projectP1, 'carol', 'project_admin'],
      [projectP2, 'dave', 'reviewer'],
    ];
    for (const [projectId, subject, role] of grants) {
      const res = await api('POST', '/v2/project-memberships', {
        project_id: projectId, subject, role,
      }, owner);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    const list = await api('GET', `/v2/project-memberships?project_id=${projectP1}`, undefined, owner);
    expect(list.body.data.items).toHaveLength(3);
  });

  it('membership 缺失时拒绝签发对应角色会话（bob 不能拿 reviewer 会话）', async () => {
    const res = await api('POST', '/v2/human-sessions', {
      subject: 'bob', role: 'reviewer', project_id: projectP1,
    }, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('MEMBERSHIP_REQUIRED');
  });

  it('Owner 签发 bvh2 人类会话（token 前缀/绑定校验）', async () => {
    const issues: Array<{ subject: string; role: string; projectId: string }> = [
      { subject: 'alice', role: 'reviewer', projectId: projectP1 },
      { subject: 'bob', role: 'auditor', projectId: projectP1 },
      { subject: 'carol', role: 'project_admin', projectId: projectP1 },
      { subject: 'dave', role: 'reviewer', projectId: projectP2 },
      { subject: 'root-p6', role: 'owner', projectId: '' },
    ];
    for (const item of issues) {
      const res = await api('POST', '/v2/human-sessions', {
        subject: item.subject,
        role: item.role,
        ...(item.projectId ? { project_id: item.projectId } : {}),
      }, owner);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.token).toMatch(/^bvh2_/);
      if (item.subject === 'alice') { sessionAlice = res.body.data.token; aliceSessionId = res.body.data.session_id; }
      if (item.subject === 'bob') { sessionBob = res.body.data.token; bobSessionId = res.body.data.session_id; }
      if (item.subject === 'carol') sessionCarol = res.body.data.token;
      if (item.subject === 'dave') { sessionDave = res.body.data.token; daveSessionId = res.body.data.session_id; }
      if (item.subject === 'root-p6') sessionRoot = res.body.data.token;
    }
    expect(sessionAlice).toBeTruthy();
  });

  it('enroll→register→authorize(P1/P2) 主节点，claim 出 attempt/bva2，制造两侧 Artifact 与 Delivery', async () => {
    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '', node_id: nodeId,
    }, owner);
    expect(enroll.body.ok).toBe(true);
    nodeCredential = enroll.body.data.node_credential;
    expect(nodeCredential).toMatch(/^bvn2_/);

    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId, slots: 4, requested_project_ids: [projectP1],
    }, bearer(nodeCredential));
    expect(register.status).toBe(200);
    expect(register.body.ok).toBe(true);

    const authorize = await api('POST', `/v2/projects/${projectP1}/nodes/${nodeId}/authorize`, {}, owner);
    expect(authorize.body.ok).toBe(true);

    seedPlan();
    seedTask('task-p6-a1', projectP1);
    seedTask('task-p6-b1', projectP1);
    seedTask('task-p6-p2', projectP2);

    async function claim(taskId: string): Promise<{ attemptId: string; token: string; generation: number }> {
      const res = await api('POST', '/v2/tasks/claim', {
        project_id: projectP1,
        agent_id: nodeId,
        claim_request_id: `cr-${randomBytes(10).toString('hex')}`,
        task_id: taskId,
      }, bearer(nodeCredential));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      return {
        attemptId: res.body.data.attempt_id,
        token: res.body.data.attempt_token,
        generation: res.body.data.attempt_generation,
      };
    }

    const first = await claim('task-p6-a1');
    attemptP1a = first.attemptId;
    attemptP1aToken = first.token;

    // P2 侧 attempt（claim 用 P2 project_id；§12 调度前置：P2 也需 owner 授权绑定）
    const authorizeP2 = await api('POST', `/v2/projects/${projectP2}/nodes/${nodeId}/authorize`, {}, owner);
    expect(authorizeP2.body.ok).toBe(true);
    const claimP2 = await api('POST', '/v2/tasks/claim', {
      project_id: projectP2,
      agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(10).toString('hex')}`,
      task_id: 'task-p6-p2',
    }, bearer(nodeCredential));
    expect(claimP2.body.ok).toBe(true);
    attemptP2 = claimP2.body.data.attempt_id;

    artifactP1 = await createArtifact(attemptP1a, 'p1');
    artifactP2 = await createArtifact(attemptP2, 'p2');

    // bva2(scope=report) 收口 → delivery（P1 主交付）
    const reportToken = issueAttemptToken(attemptP1a, 'task-p6-a1', first.generation, 'report');
    reportTokenMain = reportToken;
    const report = await api('POST', `/v2/attempts/${attemptP1a}/report`, {
      status: 'done',
      artifact_refs: [{ artifact_id: artifactP1, sha256: store.getArtifact(artifactP1)!.sha256 }],
    }, bearer(reportToken));
    expect(report.status).toBe(200);
    expect(report.body.ok, JSON.stringify(report.body)).toBe(true);
    deliveryP1 = report.body.data.delivery_id;
    expect(deliveryP1).toBeTruthy();

    // 第二个 attempt + owner 直接建 delivery（review 矩阵专用）
    const second = await claim('task-p6-b1');
    attemptP1b = second.attemptId;
    const createDelivery = await api('POST', '/v2/deliveries', {
      attempt_id: attemptP1b,
      branch: 'refs/heads/biao/attempt/task-p6-b1',
      head_sha: randomBytes(20).toString('hex'),
      artifact_refs: [],
    }, owner);
    expect(createDelivery.status).toBe(200);
    expect(createDelivery.body.ok).toBe(true);
    deliveryReview = createDelivery.body.data.delivery_id;
    expect(deliveryReview).toBeTruthy();
  });
});

/* ================================================================ */
/* 1. §21 Phase 6 验收原文：三条硬规则                               */
/* ================================================================ */

describe('硬规则 1：Worker（node/attempt 凭据）不能 Review/merge', () => {
  it('bvn2 与 bva2 对 review / review-start / merge / cancel 全部 403', async () => {
    const reviewBody = { verdict: 'accept', reviewed_by: 'worker' };
    for (const [label, headers] of [['bvn2', bearer(nodeCredential)], ['bva2', bearer(attemptP1aToken)]] as const) {
      const review = await api('POST', `/v2/deliveries/${deliveryReview}/review`, reviewBody, headers);
      expect(review.status).toBe(403);
      expect(review.body.error.code).toBe('RBAC_SCOPE_DENIED');

      const start = await api('POST', `/v2/deliveries/${deliveryReview}/review/start`, {}, headers);
      expect(start.status).toBe(403);

      const merge = await api('POST', '/v2/merge-jobs', {
        project_id: projectP1, delivery_id: deliveryReview, expected_target_sha: 'a'.repeat(40),
      }, headers);
      expect(merge.status).toBe(403);
      expect(merge.body.error.code).toBe('RBAC_SCOPE_DENIED');

      const cancel = await api('POST', '/v2/merge-jobs/mj-nonexistent/cancel', { reason: 'x' }, headers);
      expect(cancel.status).toBe(403);
      expect(label).toBeTruthy();
    }
  });
});

describe('硬规则 2：Reviewer 不能管理 Node（enroll/authorize/revoke/drain）', () => {
  it('alice（reviewer）对四类 Node 管理面全部 403', async () => {
    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '', node_id: 'node-p6-forbidden-01',
    }, bearer(sessionAlice));
    expect(enroll.status).toBe(403);

    const drain = await api('POST', `/v2/nodes/${nodeId}/drain`, {}, bearer(sessionAlice));
    expect(drain.status).toBe(403);
    expect(drain.body.error.code).toBe('RBAC_ROLE_DENIED');

    const revoke = await api('POST', `/v2/nodes/${nodeId}/revoke`, { reason: 'nope' }, bearer(sessionAlice));
    expect(revoke.status).toBe(403);

    const authorize = await api('POST', `/v2/projects/${projectP1}/nodes/${nodeId}/authorize`, {}, bearer(sessionAlice));
    expect(authorize.status).toBe(403);

    const deauthorize = await api('DELETE', `/v2/projects/${projectP1}/nodes/${nodeId}/authorization`, undefined, bearer(sessionAlice));
    expect(deauthorize.status).toBe(403);
  });

  it('bvn2 持有者同样不能调用 enroll（ticket 在 body，bvn2 不是 enroll 凭据）', async () => {
    const res = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '', node_id: 'node-p6-forbidden-02',
    }, bearer(nodeCredential));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RBAC_SCOPE_DENIED');
  });
});

describe('硬规则 3：跨项目 Artifact 不可读（membership 无该项目 → 403）', () => {
  it('dave（reviewer@P2）读 P1 Artifact → 403 CROSS_PROJECT_DENIED；alice 反向同理', async () => {
    const daveReadsP1 = await api('GET', `/v2/artifacts/${artifactP1}`, undefined, bearer(sessionDave));
    expect(daveReadsP1.status).toBe(403);
    expect(daveReadsP1.body.error.code).toBe('CROSS_PROJECT_DENIED');

    const aliceReadsP2 = await api('GET', `/v2/artifacts/${artifactP2}`, undefined, bearer(sessionAlice));
    expect(aliceReadsP2.status).toBe(403);
    expect(aliceReadsP2.body.error.code).toBe('CROSS_PROJECT_DENIED');

    const aliceReadsP2Delivery = await api('GET', `/v2/deliveries/${deliveryP1}`, undefined, bearer(sessionDave));
    expect(aliceReadsP2Delivery.status).toBe(403);

    // 有 membership 的一侧正常读
    const aliceReadsP1 = await api('GET', `/v2/artifacts/${artifactP1}`, undefined, bearer(sessionAlice));
    expect(aliceReadsP1.status).toBe(200);
    expect(aliceReadsP1.body.ok).toBe(true);
  });

  it('机器凭据同样受限：attempt token 只读自己 attempt 的 Artifact；node 需项目授权', async () => {
    const reportTokenP1a = issueAttemptToken(
      attemptP1a, 'task-p6-a1',
      store.getTaskAttempt(attemptP1a)!.attempt_generation, 'report',
    );
    const own = await api('GET', `/v2/artifacts/${artifactP1}`, undefined, bearer(reportTokenP1a));
    expect(own.status).toBe(200);

    const foreign = await api('GET', `/v2/artifacts/${artifactP2}`, undefined, bearer(reportTokenP1a));
    expect([401, 403]).toContain(foreign.status);

    // bvn2 不在 Artifact 读面作用域内（§15.4：Artifact 读取 = attempt/human；
    // Node 的项目内资源读走 attempt token），授权与否都拒绝
    const bound = await api('GET', `/v2/artifacts/${artifactP1}`, undefined, bearer(nodeCredential));
    expect(bound.status).toBe(403);
    expect(bound.body.error.code).toBe('RBAC_SCOPE_DENIED');
    const unbound = await api('GET', `/v2/artifacts/${artifactP2}`, undefined, bearer(nodeCredential));
    expect(unbound.status).toBe(403);
  });
});

/* ================================================================ */
/* 2. 角色越权矩阵全组合                                             */
/* ================================================================ */

describe('角色越权矩阵：四角色 × 关键路由组（允许/拒绝逐断言）', () => {
  interface MatrixRow {
    role: string;
    /** token 在 describe 收集期为空，必须运行期解析（世界搭建在 beforeAll 之后）。 */
    pick: () => string;
  }
  const rows: MatrixRow[] = [
    { role: 'owner', pick: () => sessionRoot },
    { role: 'project_admin', pick: () => sessionCarol },
    { role: 'reviewer', pick: () => sessionAlice },
    { role: 'auditor', pick: () => sessionBob },
    { role: 'node', pick: () => nodeCredential },
    { role: 'attempt', pick: () => reportTokenMain },
  ];

  /**
   * 允许/拒绝期望表：键 = 路由组，值 = 每行角色是否允许。
   * auditor 只读面（plans/nodes/deliveries/projects 状态）全放行；
   * 全部管理/评审/写面对 auditor 与两类 Worker 凭据拒绝。
   * （rotate/revoke-all 是破坏性端点，不进矩阵——它们的非 owner 拒绝
   * 在各自 describe 内单独断言。）
   */
  const expectations: Record<string, Record<string, boolean>> = {
    'GET /v2/projects': { owner: true, project_admin: true, reviewer: true, auditor: true, node: false, attempt: false },
    'GET /v2/plans/:id': { owner: true, project_admin: true, reviewer: true, auditor: true, node: false, attempt: false },
    'GET /v2/nodes': { owner: true, project_admin: true, reviewer: true, auditor: true, node: false, attempt: false },
    'GET /v2/deliveries/:id': { owner: true, project_admin: true, reviewer: true, auditor: true, node: false, attempt: true },
    'GET /v2/artifacts/:id': { owner: true, project_admin: true, reviewer: true, auditor: false, node: false, attempt: true },
    'POST /v2/projects': { owner: true, project_admin: false, reviewer: false, auditor: false, node: false, attempt: false },
    'POST mode-transitions': { owner: true, project_admin: false, reviewer: false, auditor: false, node: false, attempt: false },
    'POST /v2/plans/import': { owner: true, project_admin: true, reviewer: false, auditor: false, node: false, attempt: false },
    'POST node drain': { owner: true, project_admin: false, reviewer: false, auditor: false, node: false, attempt: false },
    'POST node enroll': { owner: true, project_admin: false, reviewer: false, auditor: false, node: false, attempt: false },
    'POST delivery review': { owner: true, project_admin: true, reviewer: true, auditor: false, node: false, attempt: false },
    'POST merge-jobs': { owner: true, project_admin: true, reviewer: true, auditor: false, node: false, attempt: false },
  };

  /** 每组执行一个代表性请求（允许断言只要求不落在 401/403，避免依赖业务状态）。 */
  async function callGroup(group: string, row: MatrixRow): Promise<number> {
    const headers = bearer(row.pick());
    switch (group) {
      case 'GET /v2/projects':
        return (await api('GET', '/v2/projects', undefined, headers)).status;
      case 'GET /v2/plans/:id':
        return (await api('GET', '/v2/plans/plan-p6', undefined, headers)).status;
      case 'GET /v2/nodes':
        return (await api('GET', '/v2/nodes', undefined, headers)).status;
      case 'GET /v2/deliveries/:id':
        return (await api('GET', `/v2/deliveries/${deliveryP1}`, undefined, headers)).status;
      case 'GET /v2/artifacts/:id':
        return (await api('GET', `/v2/artifacts/${artifactP1}`, undefined, headers)).status;
      case 'POST /v2/projects':
        return (await api('POST', '/v2/projects', {
          name: `p6-matrix-${randomBytes(4).toString('hex')}`,
          repo_path: '/tmp/biao-matrix', default_branch: 'main', execution_mode: 'full',
        }, headers)).status;
      case 'POST mode-transitions':
        return (await api('POST', `/v2/projects/${projectP3}/mode-transitions`, {
          to_mode: 'read_only', reason: 'p6 matrix',
        }, headers)).status;
      case 'POST /v2/plans/import':
        return (await api('POST', '/v2/plans/import', {
          project_id: projectP1, snapshot: { plan_id: 'plan-p6' },
        }, headers)).status;
      case 'POST node drain':
        return (await api('POST', `/v2/nodes/${nodeId}/drain`, {}, headers)).status;
      case 'POST node enroll':
        return (await api('POST', '/v2/nodes/enroll', {
          enrollment_ticket: '', node_id: 'node-p6-matrix-0001',
        }, headers)).status;
      case 'POST delivery review':
        return (await api('POST', `/v2/deliveries/${deliveryReview}/review`, {
          verdict: 'reject', reviewed_by: row.role, reject_reason: 'p6 matrix',
        }, headers)).status;
      case 'POST merge-jobs':
        return (await api('POST', '/v2/merge-jobs', {
          project_id: projectP1, delivery_id: 'dl-nonexistent', expected_target_sha: 'b'.repeat(40),
        }, headers)).status;
      default:
        throw new Error(`未知路由组：${group}`);
    }
  }

  it.each(
    Object.entries(expectations).flatMap(([group, byRole]) =>
      rows.map((row) => ({ group, role: row.role, allowed: byRole[row.role], pick: row.pick })),
    ),
  )('$group × $role → $allowed', async ({ group, role, allowed, pick }) => {
    const status = await callGroup(group, { role, pick });
    if (allowed) {
      expect([200, 400, 404, 409], `${group} 对 ${role} 应放行（实际 ${status}）`).toContain(status);
    } else {
      expect(status, `${group} 对 ${role} 应拒绝`).toBe(403);
    }
  });

  it('放行代表样本：root 会话评审真实通过、owner 会话数据面读通、attempt 凭据读自己 delivery', async () => {
    const rootList = await api('GET', '/v2/projects', undefined, bearer(sessionRoot));
    expect(rootList.status).toBe(200);
    expect(rootList.body.ok).toBe(true);

    const reportToken = issueAttemptToken(
      attemptP1a, 'task-p6-a1', store.getTaskAttempt(attemptP1a)!.attempt_generation, 'report',
    );
    const ownDelivery = await api('GET', `/v2/deliveries/${deliveryP1}`, undefined, bearer(reportToken));
    expect(ownDelivery.status).toBe(200);
  });
});

/* ================================================================ */
/* 3. 会话吊销与 membership 撤销的即时生效（R1C-013）                 */
/* ================================================================ */

describe('会话吊销即时生效', () => {
  it('吊销 alice 会话后同一 token 立即 401', async () => {
    const before = await api('GET', '/v2/plans/plan-p6', undefined, bearer(sessionAlice));
    expect(before.status).toBe(200);

    const revoke = await api('POST', `/v2/human-sessions/${aliceSessionId}/revoke`, {
      reason: 'p6 吊销验证',
    }, owner);
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok).toBe(true);

    const after = await api('GET', '/v2/plans/plan-p6', undefined, bearer(sessionAlice));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('HUMAN_SESSION_REVOKED');
  });

  it('撤销 bob 的 membership 后其 auditor 会话立即失效', async () => {
    const before = await api('GET', '/v2/nodes', undefined, bearer(sessionBob));
    expect(before.status).toBe(200);

    const memberships = await api('GET', `/v2/project-memberships?project_id=${projectP1}`, undefined, owner);
    const bobMembership = memberships.body.data.items.find((item: { subject: string }) => item.subject === 'bob');
    expect(bobMembership).toBeTruthy();

    const revoke = await api('POST', `/v2/project-memberships/${bobMembership.membership_id}/revoke`, {
      reason: 'p6 membership 撤销验证',
    }, owner);
    expect(revoke.body.ok).toBe(true);

    const after = await api('GET', '/v2/nodes', undefined, bearer(sessionBob));
    expect(after.status).toBe(401);
  });
});

/* ================================================================ */
/* 4. Node credential 轮换                                           */
/* ================================================================ */

describe('Node credential 轮换：老 generation 原子替换', () => {
  it('轮换端点 owner-only：project_admin/reviewer(dave)/Worker 凭据全部 403（alice/bob 会话已在上一节吊销）', async () => {
    for (const headers of [bearer(sessionCarol), bearer(sessionDave), bearer(nodeCredential), bearer(reportTokenMain)]) {
      const res = await api('POST', `/v2/nodes/${nodeId}/credential/rotate`, { reason: '越权尝试' }, headers);
      expect(res.status).toBe(403);
    }
    // 越权尝试没有产生副作用
    expect(store.getNode(nodeId)!.credential_generation).toBe(1);
  });

  it('轮换返回新 token；旧 token 409；新 token 通过；session generation 单调', async () => {
    const sessionsBefore = store.listNodeSessions(nodeId).map((s) => s.node_session_generation);
    const genBefore = store.getNode(nodeId)!.credential_generation;

    const rotate = await api('POST', `/v2/nodes/${nodeId}/credential/rotate`, {
      reason: 'p6 例行轮换',
    }, owner);
    expect(rotate.status).toBe(200);
    expect(rotate.body.ok).toBe(true);
    expect(rotate.body.data.credential_generation).toBe(genBefore + 1);
    expect(rotate.body.data.node_credential).toMatch(/^bvn2_/);
    rotatedCredential = rotate.body.data.node_credential;

    const heartbeatBody = {
      protocol_version: 2, clock_skew_ms: 5, disk_free_gib: 80, disk_free_percent: 70, slots_in_use: 0,
    };
    const oldToken = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, heartbeatBody, bearer(nodeCredential));
    expect(oldToken.status).toBe(409);
    expect(oldToken.body.error.code).toBe('CREDENTIAL_FENCED');

    const newToken = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, heartbeatBody, bearer(rotatedCredential));
    expect(newToken.status).toBe(200);
    expect(newToken.body.ok).toBe(true);

    const sessionsAfter = store.listNodeSessions(nodeId).map((s) => s.node_session_generation);
    expect(Math.max(...sessionsAfter)).toBeGreaterThan(Math.max(...sessionsBefore));
    expect(new Set(sessionsAfter).size).toBe(sessionsAfter.length); // 单调无重复
    expect(store.getCurrentNodeSession(nodeId)!.status).toBe('active');
  });
});

/* ================================================================ */
/* 5. 全局紧急撤销（revoke-all-sessions）                            */
/* ================================================================ */

describe('revoke-all-sessions：key_version 前滚，全部旧 token 立即失效', () => {
  it('紧急撤销端点 owner-only：project_admin/reviewer(dave)/Worker 凭据全部 403（未产生副作用）', async () => {
    for (const headers of [bearer(sessionCarol), bearer(sessionDave), bearer(rotatedCredential), bearer(reportTokenMain)]) {
      const res = await api('POST', '/v2/security/revoke-all-sessions', { reason: '越权尝试' }, headers);
      expect(res.status).toBe(403);
    }
    expect(store.getCredentialState().min_key_version).toBe(0);
    // dave 的会话仍有效（未被动过）
    const daveStill = await api('GET', '/v2/projects', undefined, bearer(sessionDave));
    expect(daveStill.status).toBe(200);
  });

  it('revoke-all 本身由 owner 执行并返回前滚信息', async () => {
    const res = await api('POST', '/v2/security/revoke-all-sessions', {
      reason: 'p6 紧急撤销演练',
    }, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.new_key_version).toBeGreaterThan(1);
    expect(res.body.data.min_key_version).toBe(res.body.data.new_key_version);
    expect(res.body.data.revoked_human_sessions).toBeGreaterThanOrEqual(2); // carol/dave/root（alice/bob 已先行吊销）

    // durable 水位落库
    expect(store.getCredentialState().min_key_version).toBe(res.body.data.new_key_version);
  });

  it('撤销后旧 bvn2/bva2/bvh2 全部失效（UNKNOWN_KEY_VERSION / 会话已吊销）', async () => {
    // 旧 bvn2（轮换后的新 token）心跳 → 401
    const heartbeat = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, {
      protocol_version: 2, clock_skew_ms: 5, disk_free_gib: 80, disk_free_percent: 70, slots_in_use: 0,
    }, bearer(rotatedCredential));
    expect(heartbeat.status).toBe(401);
    expect(heartbeat.body.error.code).toBe('UNKNOWN_KEY_VERSION');

    // 旧 bva2 续租 → 401
    const renew = await api('POST', `/v2/attempts/${attemptP1a}/lease/renew`, {
      extend_seconds: 300,
    }, bearer(attemptP1aToken));
    expect(renew.status).toBe(401);

    // 旧 bvh2（未单独吊销的 dave 会话）→ 401
    const daveRead = await api('GET', '/v2/projects', undefined, bearer(sessionDave));
    expect(daveRead.status).toBe(401);
  });

  it('新版本签发可继续：re-enroll 新 bvn2 可用、claim 新 bva2 可用、新 bvh2 可用', async () => {
    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '', node_id: nodeId,
    }, owner);
    expect(enroll.body.ok, JSON.stringify(enroll.body)).toBe(true);
    const newCredential = enroll.body.data.node_credential as string;
    expect(newCredential).toMatch(/^bvn2_/);

    // revoke-all fencing 了全部 node session：按 daemon 流程 register 建新 session 再心跳
    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId, slots: 4, requested_project_ids: [projectP1],
    }, bearer(newCredential));
    expect(register.status).toBe(200);
    expect(register.body.ok, JSON.stringify(register.body)).toBe(true);

    const heartbeat = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, {
      protocol_version: 2, clock_skew_ms: 5, disk_free_gib: 80, disk_free_percent: 70, slots_in_use: 0,
    }, bearer(newCredential));
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.ok, JSON.stringify(heartbeat.body)).toBe(true);

    seedTask('task-p6-post-revoke', projectP1);
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectP1,
      agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(10).toString('hex')}`,
      task_id: 'task-p6-post-revoke',
    }, bearer(newCredential));
    expect(claim.status).toBe(200);
    expect(claim.body.ok).toBe(true);
    const newAttemptToken = claim.body.data.attempt_token as string;

    const renew = await api('POST', `/v2/attempts/${claim.body.data.attempt_id}/lease/renew`, {
      extend_seconds: 300,
    }, bearer(newAttemptToken));
    expect(renew.status).toBe(200);
    expect(renew.body.ok).toBe(true);

    // 重新授予 membership + 签发新 bvh2（membership 未被 revoke-all 撤销）
    const reGrant = await api('POST', '/v2/project-memberships', {
      project_id: projectP1, subject: 'erin', role: 'reviewer',
    }, owner);
    expect(reGrant.body.ok).toBe(true);
    const session = await api('POST', '/v2/human-sessions', {
      subject: 'erin', role: 'reviewer', project_id: projectP1,
    }, owner);
    expect(session.body.ok).toBe(true);
    expect(session.body.data.token).toMatch(/^bvh2_/);
    const erinRead = await api('GET', '/v2/plans/plan-p6', undefined, bearer(session.body.data.token));
    expect(erinRead.status).toBe(200);
  });
});

/* ================================================================ */
/* 6. 审计事件完整性（audit_events + correlation_id 贯穿）           */
/* ================================================================ */

describe('审计事件完整性', () => {
  const CORR = `corr-p6-${randomBytes(6).toString('hex')}`;

  it('correlation_id 从请求头贯穿到响应头与审计行', async () => {
    // 授予 frank membership + 签发会话，两次敏感操作显式携带同一 correlation
    const grant = await api('POST', '/v2/project-memberships', {
      project_id: projectP1, subject: 'frank', role: 'auditor',
    }, { ...owner, 'x-correlation-id': CORR });
    expect(grant.status).toBe(200);
    expect(grant.body.ok).toBe(true);
    expect(grant.headers['x-correlation-id']).toBe(CORR);

    const res = await api('POST', '/v2/human-sessions', {
      subject: 'frank', role: 'auditor', project_id: projectP1,
    }, { ...owner, 'x-correlation-id': CORR });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['x-correlation-id']).toBe(CORR);

    const rows = store.listAuditEvents(undefined, 500);
    const matched = rows.filter((row) => row.correlation_id === CORR);
    expect(matched.length).toBeGreaterThanOrEqual(3); // membership.granted + human.session.issued + v2.mutation×2
    expect(matched.some((row) => row.action === 'membership.granted')).toBe(true);
    expect(matched.some((row) => row.action === 'human.session.issued')).toBe(true);
    expect(matched.some((row) => row.action === 'v2.mutation')).toBe(true);
  });

  it('本阶段全部敏感操作类型在 audit_events 有记录', () => {
    const rows = store.listAuditEvents(undefined, 1000);
    const actions = new Set(rows.map((row) => row.action));
    for (const action of [
      'human.session.issued',
      'human.session.revoked',
      'membership.granted',
      'membership.revoked',
      'node.credential_rotated',
      'security.revoke_all_sessions',
      'rbac.denied',
      'v2.mutation',
    ]) {
      expect(actions.has(action), `缺少审计动作 ${action}（现有：${[...actions].join(', ')}）`).toBe(true);
    }
    // 拒绝审计带 actor 与 correlation
    const denied = rows.filter((row) => row.action === 'rbac.denied');
    expect(denied.length).toBeGreaterThan(10);
    for (const row of denied) {
      expect(row.correlation_id).toMatch(/^corr-/);
      expect(row.subject_type).toBe('route');
    }
    // 紧急撤销审计记录新 key_version
    const revokeAll = rows.find((row) => row.action === 'security.revoke_all_sessions');
    expect(revokeAll!.subject_id).toMatch(/^key_version:/);
  });
});

/* ================================================================ */
/* 7. registry 策略派生门禁（三条硬规则的路由声明一致性）             */
/* ================================================================ */

describe('registry 凭据作用域细化门禁', () => {
  const REVIEW_MERGE_ROUTES = [
    'POST /v2/deliveries/:delivery_id/review',
    'POST /v2/deliveries/:delivery_id/review/start',
    'POST /v2/evidence-acceptances/:acceptance_id/review',
    'POST /v2/merge-jobs',
    'POST /v2/merge-jobs/:merge_job_id/cancel',
    'POST /v2/merge-jobs/:merge_job_id/retry',
  ];
  const NODE_MANAGEMENT_ROUTES = [
    'POST /v2/nodes/enroll',
    'POST /v2/nodes/:node_id/drain',
    'POST /v2/nodes/:node_id/revoke',
    'POST /v2/projects/:project_id/nodes/:node_id/authorize',
    'DELETE /v2/projects/:project_id/nodes/:node_id/authorization',
    'POST /v2/nodes/:node_id/credential/rotate',
  ];
  const AUDITOR_READ_ROUTES = [
    'GET /v2/plans/:plan_id',
    'GET /v2/nodes',
    'GET /v2/deliveries/:delivery_id',
    'GET /v2/projects',
    'GET /v2/projects/:project_id',
  ];

  it('Worker 不能 Review/merge：评审/合并路由派生策略禁 node/attempt，human ≥ reviewer', () => {
    for (const id of REVIEW_MERGE_ROUTES) {
      const entry = V2_ROUTES.find((candidate) => candidate.id === id);
      expect(entry, `${id} 必须在 registry`).toBeTruthy();
      const policy = deriveCredentialPolicy(entry!);
      expect(policy.node, `${id} 不得允许 node 凭据`).toBe(false);
      expect(policy.attempt, `${id} 不得允许 attempt 凭据`).toBe(false);
      expect(policy.human, `${id} 必须声明 human 最低角色`).toBeDefined();
      expect(HUMAN_ROLE_RANK[policy.human!]).toBeGreaterThanOrEqual(HUMAN_ROLE_RANK.reviewer);
    }
  });

  it('Reviewer 不能管理 Node：Node 管理面派生策略 owner-only（human=owner 或无 human、禁机器面）', () => {
    for (const id of NODE_MANAGEMENT_ROUTES) {
      const entry = V2_ROUTES.find((candidate) => candidate.id === id);
      expect(entry, `${id} 必须在 registry`).toBeTruthy();
      const policy = deriveCredentialPolicy(entry!);
      expect(policy.node, `${id} 不得允许 node 凭据`).toBe(false);
      expect(policy.attempt, `${id} 不得允许 attempt 凭据`).toBe(false);
      if (policy.human) {
        expect(policy.human, `${id} 的 human 最低角色必须是 owner`).toBe('owner');
      }
    }
  });

  it('跨项目 Artifact：读面路由开放 attempt/node/reviewer 时必须走资源绑定（mutation=false）', () => {
    for (const id of ['GET /v2/artifacts/:artifact_id', 'GET /v2/deliveries/:delivery_id']) {
      const entry = V2_ROUTES.find((candidate) => candidate.id === id);
      const policy = deriveCredentialPolicy(entry!);
      expect(entry!.mutation).toBe(false);
      expect(policy.attempt || policy.node || policy.human).toBeTruthy();
    }
  });

  it('auditor 只读面： widening 仅出现在 mutation=false 路由（写面不得放宽到 auditor）', () => {
    for (const entry of V2_ROUTES) {
      const policy = deriveCredentialPolicy(entry);
      if (policy.human && HUMAN_ROLE_RANK[policy.human] <= HUMAN_ROLE_RANK.auditor && entry.credentialScopes.includes('auditor')) {
        expect(entry.mutation, `${entry.id} 声明 auditor 作用域但不是只读路由`).toBe(false);
      }
      if (entry.mutation && entry.credentialScopes.includes('auditor')) {
        throw new Error(`${entry.id} 是写面却声明了 auditor 作用域`);
      }
    }
    for (const id of AUDITOR_READ_ROUTES) {
      const entry = V2_ROUTES.find((candidate) => candidate.id === id);
      const policy = deriveCredentialPolicy(entry!);
      expect(policy.human, `${id} 应对 auditor 开放`).toBe('auditor');
    }
  });

  it('策略派生与 credentialScopes 一致（node/attempt 由作用域派生，覆盖需显式声明）', () => {
    for (const entry of V2_ROUTES) {
      const policy = deriveCredentialPolicy(entry);
      const override = entry.credentialPolicyOverride ?? {};
      expect(policy.node).toBe(override.node ?? entry.credentialScopes.includes('node'));
      expect(policy.attempt).toBe(override.attempt ?? entry.credentialScopes.includes('task_attempt'));
      expect(policy.owner).toBe(true); // owner 是 V2 全路由运维超集（V1 行为保持）
      if (!entry.credentialScopes.some((scope) => ['human_owner', 'planner', 'reviewer_pm', 'recovery_reviewer', 'auditor'].includes(scope))) {
        expect(policy.human, `${entry.id} 无人类作用域不得派生 human 策略`).toBeUndefined();
      }
    }
  });
});
