/**
 * Phase 8 步骤 9（回退窗口）：五旗全开跑半条链 → 关旗 → §23.2 逐条断言（车道 C）
 *
 * 场景：一个 V2 project 上已有一条 merged delivery（完成口径）与一条
 * accepted-not-merged delivery（未合并 branch 保留），然后按 §23.2 回退：
 *
 *   1. 停止新 V2 claim（claim 404 V2_DISABLED / 分旗 404 V2_FLAG_DISABLED）；
 *   2. drain Nodes（关旗前完成，offline 留痕）；
 *   3. 保留已完成 Delivery/Artifact/Audit（行级字节不变、blob 在盘）；
 *   4. 未合并 branch 保留（远端 ref 在、BranchCleanup 不抢跑且面已关）；
 *   5. V1 服务可继续处理尚未迁移 Plan（planSubmit→claim→report→pmReview 全绿）；
 *   6. 不把 V2 task 强制降级回 project_path（V2 task 行不变；
 *      BIAO_V2_PROJECTS 隔离门照常拒绝 worker token）；
 *   7. accepted-not-merged 不降级给 V1（delivery 仍 accepted，V1 claim 拿不到它）；
 *   8. 回退记录：GET /v2/feature-flags 全关时仍可读（旗态可观测）+
 *      restore point 与未终态 Attempt/Delivery/MergeJob 清单可从库中枚举；
 *   9. 恢复后以 Project Binding 重新接管（重新开旗 → binding 完好 →
 *      accepted delivery 继续走 merge queue → merged 完成 V2 口径）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../../src/server/v2/feature-flags.js';
import { BIAO_V2_PROJECTS_ENV } from '../../src/server/v2/v1-isolation.js';
import { planSubmit, agentRegister, claim as v1Claim, report as v1Report, pmReview } from '../../src/server/service.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'p8-rollback-owner';
const ENROLLMENT_TICKET = 'p8-rollback-ticket';
const WORKER_TOKEN = 'p8-rollback-worker';
const TEST_KEY = 'ccbbaa99'.repeat(8);
const keyring = [parseCredentialKey(TEST_KEY, 1)];

const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl = '';
let dbPath = '';
let bare = '';
let projectId = '';
const nodeId = `node-p8-rb-${randomBytes(4).toString('hex')}`;
let nodeCredential = '';

let mergedDeliveryId = '';
let acceptedDeliveryId = '';
let acceptedAttemptId = '';
let acceptedBranchRef = '';
let artifactIdKept = '';
let auditCountBefore = 0;
let artifactRoot = '';
let v1RegistrationId = '';

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function remoteRefSha(ref: string): Promise<string | null> {
  try {
    const out = await git(['ls-remote', bare, ref]);
    return out ? out.split('\t')[0] : null;
  } catch {
    return null;
  }
}

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** 五旗 env 统一开关（依赖序合法：全开或全关）。 */
function setAllFlags(on: boolean): void {
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (on) process.env[key] = ALL_V2_FEATURE_FLAGS_ON_ENV[key];
    else delete process.env[key];
  }
}

/** （重）起控制面实例：同库同 Redis；旗态取当前 env（调用方先 set）。 */
async function bootServer(): Promise<void> {
  if (app) await app.close();
  if (store) store.close();
  store = new SqliteStore(dbPath);
  app = await createHttpServer(redis, {
    apiToken: OWNER_TOKEN,
    host: '127.0.0.1',
    port: 0,
    workspaceRoots: ['/tmp'],
    workerApiToken: WORKER_TOKEN,
  }, { sqliteStore: store, webDist: null, artifactRoot });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  serverUrl = `http://127.0.0.1:${port}`;
}

function seedTask(taskId: string, ownershipFiles: string[]): void {
  const planId = `plan-${projectId}`;
  const now = new Date().toISOString();
  store.upsertPlan({
    plan_id: planId, title: 'p8 rollback plan', status: 'submitted',
    project_path: `/tmp/p8-rb-${projectId}`, default_assignee: 'auto', default_priority: 5,
    phases: '[]', task_count: 1, created_at: now, submitted_at: now,
  });
  store.upsertTask({
    task_id: taskId, plan_id: planId, title: `p8 ${taskId}`, type: 'implementation', phase: '1',
    status: 'pending', priority: 5, assignee: 'auto',
    ownership_files: JSON.stringify(ownershipFiles), ownership_modules: '', depends_on: '[]',
    timeout_seconds: 3600, max_retries: 2, model_override: '', acceptance_for: '', verify: '',
    claimed_by: '', claimed_at: '', expire_at: '', result_path: '', result_json_path: '', done_at: '',
    retries: 0, pm_review_status: '', pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '',
    pm_reject_reason: '', pm_fix_instructions: '', blocked_at: '', block_reason: '', blocked_question_id: '',
    blocked_lease_remaining: '', last_question_id: '', last_question_answer: '', cancelled_at: '',
    verify_results: '[]', goal_md: '', created_at: now, updated_at: now, project_id: projectId,
  });
  store.updateTaskFields(taskId, { project_id: projectId, updated_at: now });
}

/** 一次 attempt 的完整执行链（复用 loopback 同款 HTTP 语义）。 */
async function driveAttempt(taskId: string, relFile: string): Promise<{ attemptId: string; deliveryId: string; artifactId: string }> {
  const claim = await api('POST', '/v2/tasks/claim', {
    project_id: projectId, agent_id: nodeId,
    claim_request_id: `cr-${randomBytes(8).toString('hex')}`, task_id: taskId,
  }, { Authorization: `Bearer ${nodeCredential}` });
  expect(claim.body.ok, `claim 失败：${JSON.stringify(claim.body)}`).toBe(true);
  const attemptId = claim.body.data.attempt_id as string;
  const gen = claim.body.data.attempt_generation as number;
  const ownershipToken = issueAttemptToken(attemptId, taskId, gen, 'ownership', { keys: keyring });
  const reportToken = issueAttemptToken(attemptId, taskId, gen, 'report', { keys: keyring });
  const nodeBearer = { Authorization: `Bearer ${nodeCredential}` };
  const attemptBearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const prepared = await api('POST', `/v2/attempts/${attemptId}/workspace/prepare`, {}, attemptBearer(ownershipToken));
  expect(prepared.body.ok).toBe(true);
  const dir = prepared.body.data.workspace_dir as string;
  mkdirSync(join(dir, relFile, '..'), { recursive: true });
  writeFileSync(join(dir, relFile), `rollback 窗口 ${relFile}\n`);

  const content = Buffer.from(`p8-rb artifact ${attemptId}\n`);
  const sha = createHash('sha256').update(content).digest('hex');
  const init = await api('POST', '/v2/artifacts/initiate', {
    attempt_id: attemptId, kind: 'result-md', size_bytes: content.length, sha256: sha,
  }, attemptBearer(reportToken));
  expect(init.body.ok).toBe(true);
  const artifact = init.body.data.artifact_id as string;
  const upload = await fetch(`${serverUrl}/v2/artifacts/${artifact}/content`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...attemptBearer(reportToken) },
    body: new Uint8Array(content),
  });
  expect(upload.status).toBe(200);
  const complete = await api('POST', `/v2/artifacts/${artifact}/complete`, {}, attemptBearer(reportToken));
  expect(complete.body.ok).toBe(true);

  const finalized = await api('POST', `/v2/attempts/${attemptId}/workspace/finalize`, {
    artifact_refs: [{ artifact_id: artifact }],
  }, attemptBearer(reportToken));
  expect(finalized.body.ok, `finalize 失败：${JSON.stringify(finalized.body)}`).toBe(true);
  const deliveryId = finalized.body.data.delivery_id as string;

  const reported = await api('POST', `/v2/attempts/${attemptId}/report`, {
    status: 'done', artifact_refs: [{ artifact_id: artifact, sha256: sha }],
  }, attemptBearer(reportToken));
  expect(reported.body.ok).toBe(true);
  void nodeBearer;
  return { attemptId, deliveryId, artifactId: artifact };
}

async function acceptDelivery(deliveryId: string): Promise<void> {
  const res = await api('POST', `/v2/deliveries/${deliveryId}/review`, {
    verdict: 'accept', reviewed_by: 'pm-p8-rollback',
  }, owner);
  expect(res.body.ok, `accept 失败：${JSON.stringify(res.body)}`).toBe(true);
}

async function mergeDelivery(deliveryId: string): Promise<void> {
  const head = await remoteRefSha('refs/heads/main');
  const enqueue = await api('POST', '/v2/merge-jobs', {
    project_id: projectId, delivery_id: deliveryId, expected_target_sha: head,
  }, owner);
  expect(enqueue.body.ok).toBe(true);
  const dispatch = await api('POST', `/v2/projects/${projectId}/merge-jobs/dispatch`, {}, owner);
  expect(dispatch.body.ok, `dispatch 失败：${JSON.stringify(dispatch.body)}`).toBe(true);
  expect(dispatch.body.data.status).toBe('merged');
}

/* ---------------- 世界 ---------------- */

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  savedEnv[BIAO_V2_PROJECTS_ENV] = process.env[BIAO_V2_PROJECTS_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
  process.env['BIAO_V2_ENROLLMENT_TICKET'] = ENROLLMENT_TICKET;
  delete process.env[BIAO_V2_PROJECTS_ENV];

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  const dir = mkdtempSync(join(tmpdir(), 'p8-rb-'));
  tempDirs.push(dir);
  dbPath = join(dir, 'biao.sqlite');
  artifactRoot = join(dir, 'artifacts');
  setAllFlags(true);
  await bootServer();

  // bare remote + project
  const bareDir = mkdtempSync(join(tmpdir(), 'p8-rb-bare-'));
  tempDirs.push(bareDir);
  bare = join(bareDir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p8-rb-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p8 rollback fixture ${randomBytes(6).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p8', '-c', 'user.email=p8@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);

  const project = await api('POST', '/v2/projects', {
    name: 'p8-rollback', repo_path: bare, default_branch: 'main', execution_mode: 'full',
  }, owner);
  expect(project.body.ok).toBe(true);
  projectId = project.body.data.project_id as string;

  // enroll → register（bvn2）
  const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
  expect(enroll.body.ok).toBe(true);
  nodeCredential = enroll.body.data.node_credential as string;
  const register = await api('POST', '/v2/nodes/register', {
    node_id: nodeId, slots: 2, requested_project_ids: [projectId], protocol_version: 2,
  }, { Authorization: `Bearer ${nodeCredential}` });
  expect(register.body.ok).toBe(true);
  const binding = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
  expect(binding.body.ok).toBe(true); // Project Binding（恢复后重新接管的锚点）
}, 60_000);

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
  if (savedEnv[BIAO_V2_PROJECTS_ENV] !== undefined) process.env[BIAO_V2_PROJECTS_ENV] = savedEnv[BIAO_V2_PROJECTS_ENV]!;
  else delete process.env[BIAO_V2_PROJECTS_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
}, 60_000);

describe('Phase 8 步骤 9：V1 回退窗口（§23.2 逐条）', () => {
  it('① 五旗全开跑半条链：一条 merged + 一条 accepted-not-merged + restore point', { timeout: 120_000 }, async () => {
    seedTask('task-rb-1', ['a/**']);
    seedTask('task-rb-2', ['b/**']);

    // delivery 1：完整走完（merged）
    const d1 = await driveAttempt('task-rb-1', 'a/merged.md');
    mergedDeliveryId = d1.deliveryId;
    await acceptDelivery(d1.deliveryId);
    await mergeDelivery(d1.deliveryId);
    expect(store.getDelivery(d1.deliveryId)!.status).toBe('merged');

    // delivery 2：半条链（accepted-not-merged，branch 保留）
    const d2 = await driveAttempt('task-rb-2', 'b/pending.md');
    acceptedDeliveryId = d2.deliveryId;
    acceptedAttemptId = d2.attemptId;
    acceptedBranchRef = store.getDelivery(d2.deliveryId)!.branch_ref;
    artifactIdKept = d2.artifactId;
    await acceptDelivery(d2.deliveryId);
    expect(store.getDelivery(d2.deliveryId)!.status).toBe('accepted');
    expect(await remoteRefSha(acceptedBranchRef)).toBeTruthy();

    // 回退前的最后可恢复 restore point（§23.2 第 8 条记录项）
    const rp = await api('POST', '/v2/backup/restore-points', {}, owner);
    expect(rp.body.ok).toBe(true);
    auditCountBefore = store.listAuditEvents(projectId, 10_000).length;
    expect(auditCountBefore).toBeGreaterThan(0);
  }, 180_000);

  it('② drain Nodes（关旗前）：节点 offline 留痕', async () => {
    const drain = await api('POST', `/v2/nodes/${nodeId}/drain`, {}, owner);
    expect(drain.body.ok).toBe(true);
    const offline = await api('POST', `/v2/nodes/${nodeId}/offline`, { reason: '回退窗口：停用 V2 面' }, owner);
    expect(offline.body.ok).toBe(true);
    expect(store.getNode(nodeId)!.status).toBe('offline');
  });

  it('③ 关旗重启同库：V2 面 404（claim 停止）、状态端点仍可读', { timeout: 60_000 }, async () => {
    setAllFlags(false);
    await bootServer();
    // 停止新 V2 claim + V2 写面全关（404 关闭行为，非 5xx）
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId, claim_request_id: 'cr-rollback-blocked',
    }, { Authorization: `Bearer ${nodeCredential}` });
    expect(claim.status).toBe(404);
    expect(claim.body.error.code).toBe('V2_DISABLED');
    for (const path of ['/v2/artifacts/art-x', '/v2/deliveries/del-x', '/v2/merge-jobs/mj-x', '/v2/nodes', '/v2/metrics']) {
      const res = await api('GET', path, undefined, owner);
      expect(res.status, `${path} 应 404 V2_DISABLED`).toBe(404);
      expect(res.body.error.code).toBe('V2_DISABLED');
    }
    // GET /v2/feature-flags 全关时仍可读（回退可观测性）
    const flags = await api('GET', '/v2/feature-flags', undefined, owner);
    expect(flags.status).toBe(200);
    expect(flags.body.data.distributed_mode).toBe(false);
    expect(flags.body.data.flags.every((f: { enabled: boolean }) => f.enabled === false)).toBe(true);
  });

  it('④ 分旗门禁（仅 DISTRIBUTED_MODE 开）：数据面 404 V2_FLAG_DISABLED、管理面可用', { timeout: 60_000 }, async () => {
    // 关旗中途的中间态：只开总开关（依赖序合法子集），其余四旗关
    process.env.BIAO_DISTRIBUTED_MODE = '1';
    await bootServer();
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId, claim_request_id: 'cr-flag-off',
    }, { Authorization: `Bearer ${nodeCredential}` });
    expect(claim.status).toBe(404);
    expect(claim.body.error.code).toBe('V2_FLAG_DISABLED');
    expect(claim.body.error.message).toContain('BIAO_V2_NODE_RUNTIME');
    const artifacts = await api('GET', '/v2/artifacts/art-x', undefined, owner);
    expect(artifacts.status).toBe(404);
    expect(artifacts.body.error.code).toBe('V2_FLAG_DISABLED');
    const projects = await api('GET', '/v2/projects', undefined, owner);
    expect(projects.status).toBe(200); // 管理面不受分旗管辖
    // 回到全关（回退终态）
    delete process.env.BIAO_DISTRIBUTED_MODE;
    await bootServer();
  });

  it('⑤ V1 可继续处理未迁移 Plan（同 Redis 同实例：submit→claim→report→pmReview）', async () => {
    // V1 plan 目录（独立 plan_id/project_path，不与 fixture 冲突）
    const planDir = mkdtempSync(join(tmpdir(), 'p8-rb-plan-'));
    tempDirs.push(planDir);
    const projectPath = join(planDir, 'project');
    mkdirSync(join(planDir, 'tasks'), { recursive: true });
    writeFileSync(join(planDir, 'index.md'), `---
plan_id: plan-p8-rb-v1
title: P8 回退窗口 V1 未迁移 Plan
status: draft
created_at: 2026-08-16
project_path: ${projectPath}
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
    description: 回退窗口验证
---

# V1 未迁移 Plan
`);
    writeFileSync(join(planDir, 'tasks', 'T01.md'), `---
task_id: plan-p8-rb-v1-01
title: 回退窗口 V1 任务
type: code
phase: impl
assignee: auto
ownership:
  files:
    - apps/legacy/**
priority: 5
verify: []
---

# V1 任务正文
`);
    const submitted = await planSubmit(redis, planDir);
    expect(submitted.ok).toBe(true);
    const v1PlanId = submitted.data!.plan_id;

    await agentRegister(redis, 'p8-rb-v1-agent', 'mock', ['code']);
    const registered = await agentRegister(redis, 'p8-rb-v1-agent', 'mock', ['code']);
    v1RegistrationId = registered.data!.registration_id;
    const claimed = await v1Claim(redis, { agent_id: 'p8-rb-v1-agent', blocking: false });
    expect(claimed.ok).toBe(true);
    expect(claimed.data!.task_id).toBe('plan-p8-rb-v1-01');
    // V1 claim 拿到的是 V1 plan 的任务——不是 V2 accepted-not-merged 的 task
    expect(claimed.data!.task_id).not.toBe(store.getTaskAttempt(acceptedAttemptId)!.task_id);

    const workDir = join(projectPath, 'work', claimed.data!.task_id);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'result.md'), '# V1 结果\n');
    writeFileSync(join(workDir, 'result.json'), JSON.stringify({ task_id: claimed.data!.task_id, status: 'done' }));
    const reported = await v1Report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'p8-rb-v1-agent',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: join(workDir, 'result.md'),
      result_json_path: join(workDir, 'result.json'),
      verify_results: [],
    });
    expect(reported.ok).toBe(true);
    const reviewed = await pmReview(redis, claimed.data!.task_id, {
      verdict: 'accept', reviewed_by: 'pm-p8-rollback', comment: '回退窗口 V1 验收',
    });
    expect(reviewed.ok).toBe(true);

    // HTTP 层 V1 面同样活着（GET /plans 含该 plan）
    const plans = await api('GET', '/plans', undefined, owner);
    expect(plans.status).toBe(200);
    expect(JSON.stringify(plans.body)).toContain(v1PlanId);
  }, 60_000);

  it('⑥ V1 隔离门照常：worker token 对 V2 项目 claim 403（不强制降级给 V1）', { timeout: 60_000 }, async () => {
    // V1 侧项目标识 = project_path；将 V2 项目的 legacy scope 纳入隔离清单。
    // 隔离清单在装配期解析（env 快照），故先设 env 再起实例。
    const legacyScope = `/tmp/p8-rb-${projectId}`;
    process.env[BIAO_V2_PROJECTS_ENV] = legacyScope;
    await bootServer();
    const claimBody = {
      agent_id: 'p8-rb-v1-agent',
      registration_id: v1RegistrationId,
      claim_request_id: 'crrbworkerclaim0001',
      blocking: false,
      preferred_project: legacyScope,
    };
    const workerClaim = await api('POST', '/claim', claimBody, { Authorization: `Bearer ${WORKER_TOKEN}` });
    expect(workerClaim.status).toBe(403);
    expect(workerClaim.body.error.code).toBe('V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT');

    // 未列入清单的 V1 项目：worker claim 行为不变（隔离门不制造新错误面）
    delete process.env[BIAO_V2_PROJECTS_ENV];
    await bootServer();
    const normal = await api('POST', '/claim', {
      ...claimBody, claim_request_id: 'crrbworkerclaim0002',
    }, { Authorization: `Bearer ${WORKER_TOKEN}` });
    expect(normal.status).toBe(200);
  });

  it('⑦ V2 已完成数据完整保留（Delivery/Artifact/Audit 行级不变、blob 在盘）', () => {
    // merged/accepted 状态未被回退改写
    expect(store.getDelivery(mergedDeliveryId)!.status).toBe('merged');
    const accepted = store.getDelivery(acceptedDeliveryId)!;
    expect(accepted.status).toBe('accepted'); // 不降级、不改写
    // Artifact 元数据 + 内容 blob 保留
    const artifact = store.getArtifact(artifactIdKept)!;
    expect(artifact.status).toBe('complete');
    const sha = artifact.sha256;
    const blob = join(artifactRoot, 'sha256', sha.slice(0, 2), sha);
    expect(readdirSync(join(artifactRoot, 'sha256', sha.slice(0, 2)))).toContain(sha);
    expect(readFileSync(blob, 'utf8')).toContain('p8-rb artifact');
    // Audit 只增不减
    expect(store.listAuditEvents(projectId, 10_000).length).toBe(auditCountBefore);
    // V2 task 不强制降级回 project_path：行级字段不变
    const task = store.getTask(store.getTaskAttempt(acceptedAttemptId)!.task_id)!;
    expect(task.project_id).toBe(projectId);
    expect(task.status).toBe('done');
  });

  it('⑧ 未合并 branch 保留（远端 ref 在、无清理排程、清理面已关）', async () => {
    expect(await remoteRefSha(acceptedBranchRef)).toBeTruthy();
    // accepted（非终态）delivery 不落 BranchCleanup——保留正是语义本身；
    // 已 merged delivery 的分支才进入清理排程（保留窗口内 pending）
    const cleanups = store.listBranchCleanups(projectId, 'pending');
    expect(cleanups.some((c) => c.branch_ref === acceptedBranchRef)).toBe(false);
    expect(cleanups.some((c) => c.branch_ref === store.getDelivery(mergedDeliveryId)!.branch_ref)).toBe(true);
    const run = await api('POST', '/v2/branch-cleanups/run', {}, owner);
    expect(run.status).toBe(404); // 面已关——不可能误触发删除
    expect(await remoteRefSha(acceptedBranchRef)).toBeTruthy();
  });

  it('⑨ 回退记录：旗态可读 + restore point / 未终态清单可枚举', async () => {
    const flags = await api('GET', '/v2/feature-flags', undefined, owner);
    expect(flags.status).toBe(200);
    // 最后可恢复 restore point 存在（创建后即标记 completed）
    expect(store.listRestorePoints().length).toBeGreaterThanOrEqual(1);
    // 未终态 Attempt/Delivery/MergeJob 清单（回退留档，供恢复接管）
    const nonTerminalAttempts = store.listTaskAttemptsByTask(store.getTaskAttempt(acceptedAttemptId)!.task_id)
      .filter((a) => !['done', 'failed', 'cancelled'].includes(a.status));
    expect(nonTerminalAttempts).toHaveLength(0); // 本窗口无未收口 attempt
    const acceptedRow = store.getDelivery(acceptedDeliveryId)!;
    expect(['accepted']).toContain(acceptedRow.status); // 未终态 delivery 留档在案
    const jobs = store.listMergeJobs();
    expect(jobs.every((j) => j.status === 'merged')).toBe(true);
  });

  it('⑩ 恢复后以 Project Binding 重新接管：重新开旗 → accepted delivery 走完 merged 口径', { timeout: 120_000 }, async () => {
    setAllFlags(true);
    await bootServer();
    // Binding 完好（节点重新上线后按 binding 接管；这里以 owner 驱动收口）
    const binding = store.getNodeProjectBinding(nodeId, projectId);
    expect(binding?.authorization_status).toBe('authorized');

    // accepted-not-merged 继续：merge queue → merged（V2 完成口径，不降级）
    await mergeDelivery(acceptedDeliveryId);
    expect(store.getDelivery(acceptedDeliveryId)!.status).toBe('merged');

    // 重开旗后 claim 恢复
    const reEnroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
    expect(reEnroll.body.ok).toBe(true);
    nodeCredential = reEnroll.body.data.node_credential as string;
    seedTask('task-rb-3', ['c/**']);
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(8).toString('hex')}`, task_id: 'task-rb-3',
    }, { Authorization: `Bearer ${nodeCredential}` });
    expect(claim.body.ok, `恢复后 claim 失败：${JSON.stringify(claim.body)}`).toBe(true);

    // 指标：两条 merged、无死信
    const metrics = await fetch(`${serverUrl}/v2/metrics`, { headers: owner });
    const text = await metrics.text();
    expect(text).toMatch(/biao_merge_jobs\{status="merged"\} 2/);
    expect(text).toMatch(/biao_outbox_dead_letter_total 0/);
  }, 180_000);
});
