/**
 * P9 一致性补强（车道 D）
 *
 * 1. 22.4-33 删除身份隔离路由矩阵：rbac 现有角色 × 删除类路由，拒绝路径逐断言。
 *    删除类路由 = membership 撤销 / authorization DELETE / node revoke&drain /
 *    session revoke / credential rotate / revoke-all / branch-cleanup / recovery
 *    isolation resolve / recovery candidate discard。
 * 2. 22.2-03 三方对账最小实现：SQLite（deliveries/artifacts 元数据）× artifact
 *    blob 目录 × git refs（经 provider 只读）三方计数 + digest 比对；注入单侧
 *    缺失/篡改 → 对账报告逐项命中。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import { createHttpServer } from '../../src/server/http.js';
import {
  V2_CREDENTIAL_KEY_ENV,
  issueAttemptToken,
  issueMergeBotToken,
  type IssueCredentialOptions,
} from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';
import { reconcileThreeWay } from '../../src/server/v2/reconcile-three-way.js';
import { V2_ROUTES } from '../../src/server/v2/routes/registry.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 14;
const OWNER_TOKEN = 'p9-consistency-owner';
const TEST_KEY = 'abcd1234'.repeat(8); // 32 bytes hex

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function sha256hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-p9c-'));
  tempDirs.push(dir);
  return join(dir, 'biao.sqlite');
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...headers };
    opts.body = JSON.stringify(body);
  } else {
    opts.headers = { ...headers };
  }
  const res = await fetch(`${serverUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(branch = 'main'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p9c-bare-'));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', branch, bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p9c-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p9c ${randomBytes(8).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p9c', '-c', 'user.email=p9c@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], seed);
  return bare;
}

function seedPlan(): void {
  store.upsertPlan({
    plan_id: 'plan-p9c',
    title: 'P9C Test Plan',
    status: 'submitted',
    project_path: '/tmp/p9c',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });
}

function seedTask(taskId: string, projectId: string): void {
  store.upsertTask({
    task_id: taskId,
    plan_id: 'plan-p9c',
    title: `P9C ${taskId}`,
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

/* ================================================================ */
/* 世界搭建（22.4-33 矩阵共用）                                      */
/* ================================================================ */

let projectId = '';
let nodeId = 'node-p9c-000000000001';
let nodeCredential = '';
let sessionProjectAdmin = '';
let sessionReviewer = '';
let sessionAuditor = '';
let attemptToken = '';
// 矩阵用 dummy 资源 id（避免真实撤销/吊销产生副作用）
const dummyMembershipId = 'mem-0000000000000000000000000000';
const dummySessionId = 'sess-00000000000000000000';
const dummyNodeId = 'node-dummy-000000000001';
const dummyCleanupId = 'bc-00000000000000000000';
const dummyIsolationId = 'iso-00000000000000000000';
const dummyCandidateId = 'orc-0000000000000000000';

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
  delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
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
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV];
  else delete process.env[V2_CREDENTIAL_KEY_ENV];
  if (savedEnv['BIAO_V2_ENROLLMENT_TICKET'] !== undefined) process.env['BIAO_V2_ENROLLMENT_TICKET'] = savedEnv['BIAO_V2_ENROLLMENT_TICKET'];
  else delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
});

/* ================================================================ */
/* 22.4-33 删除身份隔离路由矩阵                                     */
/* ================================================================ */

describe('22.4-33 删除身份隔离：rbac 角色 × 删除类路由拒绝路径', () => {
  it('世界搭建：项目/membership/会话/node/attempt token', async () => {
    const proj = await api('POST', '/v2/projects', {
      name: 'p9-consistency', repo_path: '/tmp/p9c', default_branch: 'main', execution_mode: 'full',
    }, owner);
    expect(proj.status).toBe(200);
    projectId = proj.body.data.project_id;

    const grants: Array<[string, string]> = [
      ['alice', 'reviewer'],
      ['carol', 'project_admin'],
      ['bob', 'auditor'],
      ['root-p9c', 'owner'],
    ];
    for (const [subject, role] of grants) {
      const res = await api('POST', '/v2/project-memberships', {
        project_id: projectId, subject, role,
      }, owner);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }

    const sessions: Array<[string, string]> = [
      ['root-p9c', 'owner'],
      ['carol', 'project_admin'],
      ['alice', 'reviewer'],
      ['bob', 'auditor'],
    ];
    for (const [subject, role] of sessions) {
      const res = await api('POST', '/v2/human-sessions', {
        subject, role, project_id: projectId,
      }, owner);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const token = res.body.data.token as string;
      if (subject === 'carol') sessionProjectAdmin = token;
      if (subject === 'alice') sessionReviewer = token;
      if (subject === 'bob') sessionAuditor = token;
    }
    const memberships = await api('GET', `/v2/project-memberships?project_id=${projectId}`, undefined, owner);
    expect(memberships.body.data.items.length).toBe(4);

    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: '', node_id: nodeId }, owner);
    expect(enroll.body.ok).toBe(true);
    nodeCredential = enroll.body.data.node_credential;
    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId, slots: 4, requested_project_ids: [projectId],
    }, bearer(nodeCredential));
    expect(register.status).toBe(200);
    const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
    expect(authorize.body.ok).toBe(true);

    seedPlan();
    seedTask('task-p9c-1', projectId);
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(10).toString('hex')}`, task_id: 'task-p9c-1',
    }, bearer(nodeCredential));
    expect(claim.status).toBe(200);
    attemptToken = issueAttemptToken(claim.body.data.attempt_id, 'task-p9c-1', claim.body.data.attempt_generation, 'report');
  });

  it('矩阵：owner/project_admin/reviewer/auditor/node/attempt × 删除类路由', async () => {
    const rows: Array<{ role: string; token: () => string }> = [
      { role: 'owner', token: () => OWNER_TOKEN },
      { role: 'project_admin', token: () => sessionProjectAdmin },
      { role: 'reviewer', token: () => sessionReviewer },
      { role: 'auditor', token: () => sessionAuditor },
      { role: 'node', token: () => nodeCredential },
      { role: 'attempt', token: () => attemptToken },
    ];

    // 期望表：键 = 路由，值 = 该行角色是否允许（owner 全放行；reviewer 级路由对
    // project_admin/reviewer 放行；其余仅 owner）。
    // 资源 id 全部用 dummy：RBAC 守卫在 handler 之前拒绝越权角色；owner 命中
    // 404 即可，避免矩阵测试真的撤销/吊销/轮换世界中的资源。
    const routes: Array<{
      label: string;
      method: string;
      path: string;
      body?: unknown;
      allowed: (role: string) => boolean;
    }> = [
      {
        label: 'DELETE node authorization',
        method: 'DELETE', path: `/v2/projects/${projectId}/nodes/${dummyNodeId}/authorization`,
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST membership revoke',
        method: 'POST', path: `/v2/project-memberships/${dummyMembershipId}/revoke`, body: { reason: 'x' },
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST session revoke',
        method: 'POST', path: `/v2/human-sessions/${dummySessionId}/revoke`, body: { reason: 'x' },
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST node revoke',
        method: 'POST', path: `/v2/nodes/${dummyNodeId}/revoke`, body: { reason: 'x' },
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST node drain',
        method: 'POST', path: `/v2/nodes/${dummyNodeId}/drain`, body: {},
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST node credential rotate',
        method: 'POST', path: `/v2/nodes/${dummyNodeId}/credential/rotate`, body: { reason: 'x' },
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST branch-cleanups/run',
        method: 'POST', path: '/v2/branch-cleanups/run', body: {},
        allowed: (r) => r === 'owner',
      },
      {
        label: 'POST branch-cleanup retry',
        method: 'POST', path: `/v2/branch-cleanups/${dummyCleanupId}/retry`, body: { reason: 'x' },
        allowed: (r) => ['owner', 'project_admin', 'reviewer'].includes(r),
      },
      {
        label: 'POST recovery isolation resolve',
        method: 'POST', path: `/v2/recovery-isolations/${dummyIsolationId}/resolve`,
        body: { resolved_by: 'x', resolution: 'x' },
        allowed: (r) => ['owner', 'project_admin', 'reviewer'].includes(r),
      },
      {
        label: 'POST recovery candidate discard',
        method: 'POST', path: `/v2/recovery-candidates/${dummyCandidateId}/discard`,
        body: { reason: 'x', decided_by: 'x' },
        allowed: (r) => r === 'owner',
      },
    ];

    const results: Array<{ route: string; role: string; allowed: boolean; status: number; code: string | null }> = [];
    for (const route of routes) {
      for (const row of rows) {
        const expected = route.allowed(row.role);
        const res = await api(route.method, route.path, route.body, bearer(row.token()));
        results.push({
          route: route.label, role: row.role, allowed: expected,
          status: res.status, code: res.body?.error?.code ?? null,
        });
        if (expected) {
          expect([200, 400, 404, 409], `${route.label} 对 ${row.role} 应放行（实际 ${res.status} body=${JSON.stringify(res.body)}）`).toContain(res.status);
        } else {
          expect(res.status, `${route.label} 对 ${row.role} 应拒绝（body=${JSON.stringify(res.body)}）`).toBe(403);
          expect(res.body?.error?.code ?? '').toMatch(/^RBAC_(SCOPE|ROLE)_DENIED$/);
        }
      }
    }

    // 对照表（供阅读）：每个拒绝行都是“谁不能删什么”的逐断言证据
    const denied = results.filter((r) => !r.allowed && r.status === 403);
    expect(denied.length).toBeGreaterThan(0);
    // 破坏性端点不允许 Node/attempt 越权删除
    for (const role of ['node', 'attempt']) {
      const nodeDenials = results.filter((r) => r.role === role && !r.allowed);
      expect(nodeDenials.length).toBe(routes.length);
    }
  });

  it('revoke-all-sessions 拒绝路径：非 owner 角色逐断言 403（破坏性端点不进矩阵；owner 放行由 p6 单独验证）', async () => {
    const roles: Array<{ role: string; token: string }> = [
      { role: 'project_admin', token: sessionProjectAdmin },
      { role: 'reviewer', token: sessionReviewer },
      { role: 'auditor', token: sessionAuditor },
      { role: 'node', token: nodeCredential },
      { role: 'attempt', token: attemptToken },
    ];
    for (const { role, token } of roles) {
      const res = await api('POST', '/v2/security/revoke-all-sessions', { reason: '越权尝试' }, bearer(token));
      expect(res.status, `revoke-all × ${role}`).toBe(403);
      expect(res.body.error.code).toMatch(/^RBAC_(SCOPE|ROLE)_DENIED$/);
    }
    // 注：不在此处用 owner 执行 revoke-all（会真实前滚密钥环，使本文件后续所有
    // token 失效）；owner 放行路径由 p6-rbac.test.ts 的破坏性端点 describe 覆盖。
  });

  it('merge_bot 凭据通过共享 plugin 放行后，对删除类路由被 RBAC 拒绝（缺口已由 PM 修复）', async () => {
    // 原缺口：http-plugins.ts 的 v2CredentialPresent 只放行 bvn2_/bva2_/bvh2_，
    // bvm2_ 在进入 /v2 路由前即被 401。修复后 bvm2_ 进入 RBAC 层：
    // merge_bot 对 Node 管理类删除路由无权限 → RBAC_ROLE_DENIED。
    const mergeBotToken = issueMergeBotToken(`merge-bot-${projectId}`, projectId, 'merge');
    const res = await api('DELETE', `/v2/projects/${projectId}/nodes/${nodeId}/authorization`, undefined, bearer(mergeBotToken));
    expect(res.status).toBe(403);
  });

  it('decision 路由已装配（PM 修复），cleanup/keep/isolate 语义可用', async () => {
    // 原缺口：路由仅存在于 V2_ROUTES，v2-routes.ts 未注册 handler。修复后
    // 已装配真实 handler：keep 只落 decision 不改终态（负向断言不破坏本文件
    // 的候选现场；cleanup/isolate 的行为学由 p9-recovery 套件覆盖）。
    const decision = V2_ROUTES.find((r) => r.id === 'POST /v2/recovery-candidates/:candidate_id/decision');
    expect(decision).toBeTruthy();
    expect(decision!.credentialScopes).toContain('recovery_reviewer');
    const probe = await api('POST', '/v2/recovery-candidates/nonexistent-candidate/decision', { action: 'keep', reason: 'probe' }, owner);
    expect(probe.status).toBe(404);
    expect(probe.body.error.code).toBe('CANDIDATE_NOT_FOUND');
  });
});

/* ================================================================ */
/* 22.2-03 三方对账最小实现                                          */
/* ================================================================ */

describe('22.2-03 三方对账：SQLite × artifact blob 目录 × git refs', () => {
  let bare = '';
  let artifactRoot = '';
  let reconcileStore: SqliteStore;
  let attemptId = '';
  let artifactId = '';
  let artifactSha = '';
  let deliveryId = '';
  let content: Buffer;

  async function setupWorld(): Promise<void> {
    bare = await createBareRemote();
    const now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'p9c-artifacts-'));
    tempDirs.push(dir);
    artifactRoot = join(dir, 'artifacts');

    reconcileStore = new SqliteStore(makeDbPath());
    const project: ProjectRow = {
      project_id: 'proj-reconcile',
      display_name: 'reconcile',
      repository_url: bare,
      repository_fingerprint: '',
      default_branch: 'main',
      merge_policy: 'merge-queue',
      execution_mode: 'full',
      mode_transition: null,
      mode_transition_id: '',
      mode_transition_step: null,
      write_capability_status: 'ready',
      artifact_policy_id: '',
      workspace_policy_id: '',
      status: 'active',
      revision: 1,
      created_at: now,
      updated_at: now,
    };
    reconcileStore.insertProject(project);
    reconcileStore.upsertPlan({
      plan_id: 'plan-rc',
      title: 'reconcile plan',
      status: 'submitted',
      project_path: '/tmp/p9c',
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 1,
      created_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
    });

    const task = 'task-reconcile-1';
    reconcileStore.upsertTask({
      task_id: task, plan_id: 'plan-rc', title: 'rc', type: 'implementation', phase: '1',
      status: 'pending', priority: 5, assignee: 'auto', ownership_files: '[]', ownership_modules: '',
      depends_on: '[]', timeout_seconds: 3600, max_retries: 2, model_override: '',
      acceptance_for: '', verify: '', claimed_by: '', claimed_at: '', expire_at: '',
      result_path: '', result_json_path: '', done_at: '', retries: 0, pm_review_status: '',
      pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '', pm_reject_reason: '',
      pm_fix_instructions: '', blocked_at: '', block_reason: '', blocked_question_id: '',
      blocked_lease_remaining: '', last_question_id: '', last_question_answer: '',
      cancelled_at: '', verify_results: '[]', goal_md: '',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), project_id: project.project_id,
    });

    attemptId = 'att-reconcile-1';
    reconcileStore.insertTaskAttempt({
      attempt_id: attemptId, task_id: task, project_id: project.project_id, node_id: nodeId,
      session_id: '', attempt_generation: 1, status: 'executing',
      lease_expires_at: now + 600000, lease_duration_ms: 600000, token_jti: '',
      artifact_ids: '[]', started_at: now, updated_at: now, completed_at: null, failure_reason: '',
    });

    content = Buffer.from(`reconcile artifact ${randomBytes(6).toString('hex')}`);
    artifactSha = sha256hex(content);
    artifactId = 'art-reconcile-1';
    reconcileStore.insertArtifact({
      artifact_id: artifactId, project_id: project.project_id, task_id: task, attempt_id: attemptId,
      kind: 'result-md', sha256: artifactSha, size_bytes: content.length,
      media_type: 'application/octet-stream',
      storage_key: `sha256/${artifactSha.slice(0, 2)}/${artifactSha}`,
      status: 'complete', created_at: now, retention_until: null,
    });
    reconcileStore.upsertArtifactBlob(artifactSha, content.length);

    // 写 blob 文件
    const blobPath = join(artifactRoot, 'sha256', artifactSha.slice(0, 2), artifactSha);
    mkdirSync(join(blobPath, '..'), { recursive: true });
    writeFileSync(blobPath, content);

    deliveryId = 'dl-reconcile-1';
    reconcileStore.insertDelivery({
      delivery_id: deliveryId, task_id: task, attempt_id: attemptId, project_id: project.project_id,
      base_sha: '0'.repeat(40), head_sha: '1'.repeat(40), tree_sha: '2'.repeat(40),
      branch_ref: `refs/heads/biao/attempt/${attemptId}`, changed_files: '[]',
      patch_digest: sha256hex(Buffer.from('patch')), artifact_ids: JSON.stringify([artifactId]),
      verify_manifest_digest: '', status: 'pending_review', accepted_commit_sha: '',
      merged_commit_sha: '', invalidated_reason: '', diff_summary: '[]', server_verified: 0,
      created_at: now, updated_at: now,
    });

    // 在 bare remote 建 attempt 分支 + marker ref（对齐 delivery.branch_ref）
    const seedRoot = mkdtempSync(join(tmpdir(), 'p9c-push-'));
    tempDirs.push(seedRoot);
    const seed = join(seedRoot, 'repo');
    await git(['clone', bare, seed]);
    writeFileSync(join(seed, 'result.md'), content);
    await git(['add', '.'], seed);
    await git(['-c', 'user.name=p9c', '-c', 'user.email=p9c@test', 'commit', '-m', 'attempt'], seed);
    await git(['push', 'origin', `HEAD:refs/heads/biao/attempt/${attemptId}`], seed);
    await git(['push', 'origin', `HEAD:refs/biao/attempt-markers/${attemptId}`], seed);
  }

  it('三方一致：reconcile 报告无偏差（各侧计数与 digest 齐全）', async () => {
    await setupWorld();
    const provider = new GenericGitProvider();
    const report = await reconcileThreeWay({
      store: reconcileStore,
      artifactRoot,
      gitProvider: provider,
      projectIds: ['proj-reconcile'],
    });

    expect(report.summary.sqlite.count).toBeGreaterThan(0);
    expect(report.summary.artifact_blobs.count).toBe(1);
    expect(report.summary.git_refs.count).toBe(2); // branch + marker
    expect(report.summary.sqlite.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.summary.artifact_blobs.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.summary.git_refs.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.discrepancies).toEqual([]);
  });

  it('单侧缺失：删除 blob 文件 → 命中 artifact_blob_missing', async () => {
    const blobPath = join(artifactRoot, 'sha256', artifactSha.slice(0, 2), artifactSha);
    expect(existsSync(blobPath)).toBe(true);
    rmSync(blobPath);
    const report = await reconcileThreeWay({
      store: reconcileStore,
      artifactRoot,
      gitProvider: new GenericGitProvider(),
      projectIds: ['proj-reconcile'],
    });
    const hit = report.discrepancies.find((d) => d.kind === 'artifact_blob_missing');
    expect(hit).toBeTruthy();
    expect(hit!.subjectId).toBe(artifactId);
    expect(hit!.severity).toBe('error');
    expect(report.summary.artifact_blobs.count).toBe(0);
  });

  it('单侧篡改：改写 blob 内容 → 命中 artifact_blob_tampered（文件名/大小不变仍捕获）', async () => {
    const blobPath = join(artifactRoot, 'sha256', artifactSha.slice(0, 2), artifactSha);
    mkdirSync(join(blobPath, '..'), { recursive: true });
    const tampered = Buffer.from(`tampered ${randomBytes(6).toString('hex')}`);
    writeFileSync(blobPath, tampered);
    const report = await reconcileThreeWay({
      store: reconcileStore,
      artifactRoot,
      gitProvider: new GenericGitProvider(),
      projectIds: ['proj-reconcile'],
    });
    const hit = report.discrepancies.find((d) => d.kind === 'artifact_blob_tampered');
    expect(hit).toBeTruthy();
    expect(hit!.subjectId).toBe(artifactId);
    expect(hit!.expected).toBe(artifactSha);
    expect(hit!.actual).not.toBe(artifactSha);
  });

  it('单侧多余：远端残留多余 attempt 分支 → 命中 git_ref_without_delivery（warning）', async () => {
    // 恢复合法 blob，让唯一偏差来自 git 面
    const blobPath = join(artifactRoot, 'sha256', artifactSha.slice(0, 2), artifactSha);
    writeFileSync(blobPath, content);

    const seedRoot = mkdtempSync(join(tmpdir(), 'p9c-extra-'));
    tempDirs.push(seedRoot);
    const seed = join(seedRoot, 'repo');
    await git(['clone', bare, seed]);
    await git(['checkout', 'main'], seed);
    await git(['push', 'origin', 'HEAD:refs/heads/biao/attempt/att-ghost'], seed);

    const report = await reconcileThreeWay({
      store: reconcileStore,
      artifactRoot,
      gitProvider: new GenericGitProvider(),
      projectIds: ['proj-reconcile'],
    });
    const hit = report.discrepancies.find((d) => d.kind === 'git_ref_without_delivery');
    expect(hit).toBeTruthy();
    expect(hit!.subjectId).toContain('att-ghost');
    expect(hit!.severity).toBe('warning');
    // 其它合法 blob 不应再报 missing/tampered
    expect(report.discrepancies.filter((d) => d.kind.startsWith('artifact_'))).toEqual([]);
  });

  it('gap 如实声明：git 面只做 ref 存在性与 digest 比对，不做 marker 内容验签', () => {
    // 对账的最小实现不读取 marker 内容验签（验签归 workspace 服务）；
    // 如需“marker 内容被篡改”检测，属后续增强。
    expect(true).toBe(true);
  });
});
