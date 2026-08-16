/**
 * Phase 8 步骤 2：两逻辑节点、同 OS E2E（§21 Phase 8 · 车道 C）
 *
 * 本机两个真实 biao-node 子进程（bin/biao-node.js，不同缓存根/不同数据目录/
 * 不同 session）并发 claim 两个 task（不同文件），各自走完整链到 delivery；
 * 一个 merge 成功后另一个基于新 HEAD 重排队再 merged（串行队列语义端到端）；
 * 节点 B drain 后新任务只由 A 领。
 *
 * 说明：Phase 3 daemon 的 executor 是占位实现（认领后记录，不执行 Git 链路，
 * 真实执行接线属 Phase 4 runbook §8 收尾项）——本测试由测试进程扮演
 * "attempt 执行器"，对 daemon 真实 claim 到的 attempt 以 owner/bva2 驱动
 * workspace→artifact→delivery 链路；节点身份、claim 竞争、心跳、drain、
 * 重启全部是真实子进程行为。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { parseCredentialKey, issueAttemptToken, V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import { loadNodeConfig } from '../../src/node/config.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;
const OWNER_TOKEN = 'p8-two-nodes-owner';
const ENROLLMENT_TICKET = 'p8-two-nodes-ticket';
const TEST_KEY = '44556677'.repeat(8);
const keyring = [parseCredentialKey(TEST_KEY, 1)];

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_BIN = join(REPO_ROOT, 'bin', 'biao-node.js');

const tempDirs: string[] = [];
const spawned: Array<{ proc: ChildProcess; exited: Promise<number | null> }> = [];

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl = '';
let bare = '';
let projectId = '';

const savedEnv: Record<string, string | undefined> = {};

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p8-2n-bare-'));
  tempDirs.push(dir);
  const barePath = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', barePath]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p8-2n-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', barePath, seed]);
  writeFileSync(join(seed, 'README.md'), `# p8 two-nodes fixture ${randomBytes(6).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p8', '-c', 'user.email=p8@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
  return barePath;
}

/** ls-remote 单引用 SHA（外部卷上偶发抖动：失败/空时短重试一次再判空）。 */
async function remoteRefSha(ref: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const out = await git(['ls-remote', bare, ref]);
      if (out) return out.split('\t')[0];
    } catch {
      // 重试
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };

/** V2 plan+task 种子（plans import 属 Phase 9 缺口）。 */
function seedTask(taskId: string, ownershipFiles: string[]): void {
  const planId = `plan-${projectId}`;
  store.upsertPlan({
    plan_id: planId,
    title: 'p8 two-nodes plan',
    status: 'submitted',
    project_path: `/tmp/p8-2n-${projectId}`,
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 2,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });
  store.upsertTask({
    task_id: taskId,
    plan_id: planId,
    title: `p8 two-nodes ${taskId}`,
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
  // tasks.project_id 扩展列的写入路径未接线（plan import 未回填，Phase 9 缺口）：
  // daemon 的 project 维度 claim 走 getTasksByProjectId，此处按导入器语义直写映射。
  store.updateTaskFields(taskId, { project_id: projectId, updated_at: new Date().toISOString() });
}

/* ---------------- 子进程工具（p3 同款语义） ---------------- */

function runCli(args: string[], envExtra: Record<string, string>, timeoutMs: number) {
  const proc = spawn(process.execPath, [NODE_BIN, ...args], {
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, timeoutMs).unref();
  });
  spawned.push({ proc, exited });
  return { proc, exited, stderr: () => stderr };
}

interface NodeConfig {
  nodeId: string;
  dir: string;
  configPath: string;
}

/** enroll + 快速周期配置（slots=1：一节点一 attempt，两节点各领一个 task）。 */
async function setupNode(label: string): Promise<NodeConfig> {
  const dir = mkdtempSync(join(tmpdir(), `p8-2n-${label}-`));
  tempDirs.push(dir);
  const nodeId = `node-p8-2n-${label}-${randomBytes(4).toString('hex')}`;
  const ticketFile = join(dir, 'enrollment-ticket.txt');
  writeFileSync(ticketFile, ENROLLMENT_TICKET);
  const configPath = join(dir, 'biao-node.config.json');
  const run = runCli([
    'enroll', '--url', serverUrl, '--node-id', nodeId,
    '--ticket-file', ticketFile,
    '--config', configPath,
    '--cache-root', join(dir, 'cache'), // 不同缓存根（节点本地 clone 缓存互不共享）
  ], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 30_000);
  const code = await run.exited;
  expect(code, `enroll ${label} 失败：${run.stderr()}`).toBe(0);
  // 覆盖为快速周期配置（凭据文件按默认 <配置目录>/node-credential.json 解析）
  writeFileSync(configPath, JSON.stringify({
    biao_url: serverUrl,
    node_id: nodeId,
    slots: 1,
    heartbeat_interval_ms: 300,
    watchdog_tick_ms: 100,
    claim_interval_ms: 250,
    lease_renew_margin_ms: 300_000, // 测试窗口内不触发本地停止（lease 600s）
    lease_stop_window_ms: 5_000,
    drain_timeout_ms: 1_500,
    drain_timeout_action: 'cancel',
    requested_project_ids: [projectId],
    server_protocol_version: 2,
    cache_root: join(dir, 'cache'),
  }, null, 2));
  return { nodeId, dir, configPath };
}

function spawnDaemon(configPath: string) {
  return runCli(['run', '--config', configPath], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 180_000);
}

function statusOf(configPath: string): Record<string, any> | null {
  try {
    const config = loadNodeConfig(configPath);
    return JSON.parse(readFileSync(config.status_file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitFor<T>(probe: () => T, label: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 对 daemon 真实 claim 到的 attempt 走完整执行链（测试进程扮演 executor）。 */
async function driveAttemptToDelivery(attemptId: string, relFile: string, content: string): Promise<string> {
  const attempt = store.getTaskAttempt(attemptId)!;
  const ownershipToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'ownership', { keys: keyring });
  const reportToken = issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'report', { keys: keyring });

  // prepare（bva2 ownership scope）
  const prepared = await api('POST', `/v2/attempts/${attemptId}/workspace/prepare`, {}, { Authorization: `Bearer ${ownershipToken}` });
  expect(prepared.status, `prepare 失败：${JSON.stringify(prepared.body)}`).toBe(200);
  expect(prepared.body.ok).toBe(true);
  const dir = prepared.body.data.workspace_dir as string;
  mkdirSync(join(dir, relFile, '..'), { recursive: true });
  writeFileSync(join(dir, relFile), content);

  // artifact 三段
  const artifactContent = Buffer.from(`p8-2n artifact ${attemptId} ${randomBytes(6).toString('hex')}\n`);
  const artifactSha = sha256hex(artifactContent);
  const init = await api('POST', '/v2/artifacts/initiate', {
    attempt_id: attemptId, kind: 'result-md', size_bytes: artifactContent.length, sha256: artifactSha,
  }, { Authorization: `Bearer ${reportToken}` });
  expect(init.body.ok, `initiate 失败：${JSON.stringify(init.body)}`).toBe(true);
  const artifactId = init.body.data.artifact_id as string;
  const upload = await fetch(`${serverUrl}/v2/artifacts/${artifactId}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${reportToken}` },
    body: new Uint8Array(artifactContent),
  });
  expect(upload.status, `upload 失败：${upload.status}`).toBe(200);
  const complete = await api('POST', `/v2/artifacts/${artifactId}/complete`, {}, { Authorization: `Bearer ${reportToken}` });
  expect(complete.body.ok, `complete 失败：${JSON.stringify(complete.body)}`).toBe(true);

  // finalize（含 artifact → pending_review）
  const finalized = await api('POST', `/v2/attempts/${attemptId}/workspace/finalize`, {
    artifact_refs: [{ artifact_id: artifactId }],
  }, { Authorization: `Bearer ${reportToken}` });
  expect(finalized.status, `finalize 失败：${JSON.stringify(finalized.body)}`).toBe(200);
  expect(finalized.body.ok, `finalize 失败：${JSON.stringify(finalized.body)}`).toBe(true);
  expect(finalized.body.data.status).toBe('pending_review');

  // report done
  const reported = await api('POST', `/v2/attempts/${attemptId}/report`, {
    status: 'done',
    artifact_refs: [{ artifact_id: artifactId, sha256: artifactSha }],
  }, { Authorization: `Bearer ${reportToken}` });
  expect(reported.body.ok, `report 失败：${JSON.stringify(reported.body)}`).toBe(true);

  // PM accept
  const deliveryId = finalized.body.data.delivery_id as string;
  const reviewed = await api('POST', `/v2/deliveries/${deliveryId}/review`, {
    verdict: 'accept', reviewed_by: 'pm-p8-two-nodes',
  }, owner);
  expect(reviewed.body.ok, `review 失败：${JSON.stringify(reviewed.body)}`).toBe(true);
  expect(reviewed.body.data.status).toBe('accepted');
  return deliveryId;
}

/* ---------------- 世界 ---------------- */

let nodeA!: NodeConfig;
let nodeB!: NodeConfig;
let daemonA!: ReturnType<typeof spawnDaemon>;
let daemonB!: ReturnType<typeof spawnDaemon>;
let attemptOfNode: Record<string, string> = {};

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

afterEach(() => {
  // 不杀常驻 daemon（describe 内逐步收口），只兜底清理意外残留
});

afterAll(async () => {
  for (const { proc } of spawned) {
    if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
  }
  await Promise.all(spawned.map(({ exited }) => exited)).catch(() => undefined);
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
}, 60_000);

describe('Phase 8 步骤 2：两逻辑节点（同 OS、真实子进程）', () => {
  it('① 世界：project + 两个 task（不同文件所有权）', async () => {
    bare = await createBareRemote();
    const res = await api('POST', '/v2/projects', {
      name: 'p8-two-nodes', repo_path: bare, default_branch: 'main', execution_mode: 'full',
    }, owner);
    expect(res.body.ok).toBe(true);
    projectId = res.body.data.project_id as string;
    seedTask('task-p8-2n-a', ['a/**']);
    seedTask('task-p8-2n-b', ['b/**']);
  }, 30_000);

  it('② 两个 biao-node 子进程 enroll 并运行（不同缓存根/session）', async () => {
    nodeA = await setupNode('a');
    nodeB = await setupNode('b');
    expect(nodeA.nodeId).not.toBe(nodeB.nodeId);
    // owner authorize 两个节点→项目绑定（§12：claim 调度前置）
    for (const node of [nodeA, nodeB]) {
      const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${node.nodeId}/authorize`, {}, owner);
      expect(authorize.status, `authorize ${node.nodeId} 失败：${JSON.stringify(authorize.body)}`).toBe(200);
      expect(authorize.body.ok).toBe(true);
    }
    daemonA = spawnDaemon(nodeA.configPath);
    daemonB = spawnDaemon(nodeB.configPath);
    await waitFor(() => statusOf(nodeA.configPath)?.phase === 'running', 'node A running', 20_000);
    await waitFor(() => statusOf(nodeB.configPath)?.phase === 'running', 'node B running', 20_000);
    // 两个 session（不同节点不同 session_id）
    const sessionA = store.getCurrentNodeSession(nodeA.nodeId);
    const sessionB = store.getCurrentNodeSession(nodeB.nodeId);
    expect(sessionA?.session_id).toBeTruthy();
    expect(sessionB?.session_id).toBeTruthy();
    expect(sessionA!.session_id).not.toBe(sessionB!.session_id);
  }, 60_000);

  it('③ 并发 claim：两个 task 各被一个节点认领（slots=1 保证一对一）', async () => {
    const claims = await waitFor(() => {
      const tasks = store.getTasksByProjectId(projectId);
      const claimed = tasks.filter((t) => t.status === 'running' && t.active_attempt_id);
      return claimed.length === 2 ? claimed : undefined;
    }, '两个 task 均被认领', 30_000);

    for (const task of claims) {
      const attempt = store.getTaskAttempt(task.active_attempt_id!)!;
      attemptOfNode[attempt.node_id] = attempt.attempt_id;
    }
    // 两个 attempt 分属两个节点（无重复赢家）
    expect(Object.keys(attemptOfNode).sort()).toEqual([nodeA.nodeId, nodeB.nodeId].sort());
    // claim 落了 ownership snapshot（写边界来自 task.ownership_files）
    for (const attemptId of Object.values(attemptOfNode)) {
      const snapshots = store.listOwnershipSnapshotsByAttempt(attemptId);
      expect(snapshots).toHaveLength(1);
    }
  }, 60_000);

  it('④ 各自走完整链到 delivery accepted（不同文件互不覆盖）', async () => {
    for (const [nodeIdKey, attemptId] of Object.entries(attemptOfNode)) {
      // 写哪个目录由 attempt 所属 task 的 ownership 决定（节点领哪个 task 是
      // 服务端分配的竞态结果，不得按节点身份假定）
      const task = store.getTask(store.getTaskAttempt(attemptId)!.task_id)!;
      const globs = JSON.parse(task.ownership_files) as string[];
      const label = globs[0].split('/')[0];
      const deliveryId = await driveAttemptToDelivery(attemptId, `${label}/from-${label}.md`, `节点 ${nodeIdKey} 的改动\n`);
      const delivery = store.getDelivery(deliveryId)!;
      expect(JSON.parse(delivery.changed_files)).toEqual([`${label}/from-${label}.md`]);
    }
    // 两条 attempt 分支在远端共存；默认分支未被动过
    for (const attemptId of Object.values(attemptOfNode)) {
      expect(await remoteRefSha(`refs/heads/biao/attempt/${attemptId}`)).toBeTruthy();
    }
    expect(await remoteRefSha('refs/heads/main')).toBeTruthy();
  }, 120_000);

  it('⑤ 串行队列语义：第一个 merge 成功后，第二个基于新 HEAD 重排队再 merged', async () => {
    const [nodeId1, nodeId2] = Object.keys(attemptOfNode);
    const delivery1 = store.listDeliveriesByTask(store.getTaskAttempt(attemptOfNode[nodeId1])!.task_id)
      .find((d) => d.status === 'accepted')!;
    const delivery2 = store.listDeliveriesByTask(store.getTaskAttempt(attemptOfNode[nodeId2])!.task_id)
      .find((d) => d.status === 'accepted')!;

    // 第一个：以当前 HEAD 入队 → merged
    const head1 = await remoteRefSha('refs/heads/main');
    const enqueue1 = await api('POST', '/v2/merge-jobs', {
      project_id: projectId, delivery_id: delivery1.delivery_id, expected_target_sha: head1,
    }, owner);
    expect(enqueue1.body.ok).toBe(true);
    const dispatch1 = await api('POST', `/v2/projects/${projectId}/merge-jobs/dispatch`, {}, owner);
    expect(dispatch1.body.data.status).toBe('merged');
    const head2 = await remoteRefSha('refs/heads/main');
    expect(head2).not.toBe(head1);

    // 第二个：基于新 HEAD 入队（串行队列语义：后到者排队头已前进）→ merged
    const enqueue2 = await api('POST', '/v2/merge-jobs', {
      project_id: projectId, delivery_id: delivery2.delivery_id, expected_target_sha: head2,
    }, owner);
    expect(enqueue2.body.ok).toBe(true);
    const dispatch2 = await api('POST', `/v2/projects/${projectId}/merge-jobs/dispatch`, {}, owner);
    expect(dispatch2.body.data.status).toBe('merged');
    const head3 = await remoteRefSha('refs/heads/main');
    expect(head3).not.toBe(head2);

    // 串行性：第二次 merge 的 commit 是第一次的子孙（无分叉双写）
    const verifyDir = mkdtempSync(join(tmpdir(), 'p8-2n-serial-'));
    tempDirs.push(verifyDir);
    const repo = join(verifyDir, 'repo');
    await git(['clone', bare, repo]);
    await git(['merge-base', '--is-ancestor', head2, head3], repo); // 非零退出会抛
    expect(store.getDelivery(delivery1.delivery_id)!.status).toBe('merged');
    expect(store.getDelivery(delivery2.delivery_id)!.status).toBe('merged');

    // 两条 merged delivery 的 attempt 分支均进入 BranchCleanup 排程（保留窗口）
    const cleanups = await api('GET', `/v2/branch-cleanups?project_id=${projectId}`, undefined, owner);
    const branchRefs = (cleanups.body.data.items as Array<{ branch_ref: string; status: string }>)
      .filter((r) => r.status === 'pending')
      .map((r) => r.branch_ref);
    expect(branchRefs).toContain(delivery1.branch_ref);
    expect(branchRefs).toContain(delivery2.branch_ref);
  }, 120_000);

  it('⑥ 节点 B drain（CLI 控制文件 → daemon 收口 offline）后，新任务只由 A 领', async () => {
    // drain B：CLI 触发控制文件；daemon 等待/取消本地 attempt → offline → exit 0
    const drainRun = runCli(['drain', '--config', nodeB.configPath, '--wait-ms', '15000'], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 30_000);
    await waitFor(() => statusOf(nodeB.configPath)?.drain?.requested === true, 'node B drain 确认', 15_000);
    const bExit = await daemonB.exited;
    expect(bExit).toBe(0);
    expect(statusOf(nodeB.configPath)!.phase).toBe('drained');
    await waitFor(() => store.getNode(nodeB.nodeId)!.status === 'offline', '服务端 node B offline', 10_000);
    const drainCode = await drainRun.exited;
    expect(drainCode).toBe(0);

    // A 的本地槽位还占着（占位 executor 不感知服务端完成）——重启 A 释放并
    // 重新 register（新 session generation，旧 session fenced：p3 已验语义）
    daemonA.proc.kill('SIGTERM');
    expect(await daemonA.exited).toBe(0);
    daemonA = spawnDaemon(nodeA.configPath);
    await waitFor(() => statusOf(nodeA.configPath)?.phase === 'running', 'node A 重启 running', 20_000);

    // 新任务：只有 A 在线，claim 只可能来自 A
    seedTask('task-p8-2n-c', ['c/**']);
    const attemptId = await waitFor(() => {
      const task = store.getTasksByProjectId(projectId).find((t) => t.task_id === 'task-p8-2n-c');
      return task && task.status === 'running' && task.active_attempt_id ? task.active_attempt_id : undefined;
    }, '新任务被认领', 30_000);
    const attempt = store.getTaskAttempt(attemptId!)!;
    expect(attempt.node_id).toBe(nodeA.nodeId); // 只由 A 领（B 已 offline）
    // B 的 offline 状态可在 /v2/nodes 读面看到
    const nodes = await api('GET', '/v2/nodes', undefined, owner);
    const rowB = nodes.body.data.items.find((n: { node_id: string }) => n.node_id === nodeB.nodeId);
    expect(rowB.status).toBe('offline');
  }, 120_000);

  it('⑦ 收口：SIGTERM A；指标与死信终检', async () => {
    daemonA.proc.kill('SIGTERM');
    expect(await daemonA.exited).toBe(0);
    await waitFor(() => store.getNode(nodeA.nodeId)!.status === 'offline', '服务端 node A offline', 10_000);

    const metrics = await fetch(`${serverUrl}/v2/metrics`, { headers: owner });
    const text = await metrics.text();
    expect(text).toMatch(/biao_merge_jobs\{status="merged"\} 2/);
    expect(text).toMatch(/biao_outbox_dead_letter_total 0/);
    const dead = await api('GET', '/v2/outbox/dead-letters', undefined, owner);
    expect(dead.body.data.count).toBe(0);
  }, 60_000);
});
