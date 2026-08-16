/**
 * Phase 8 步骤 4：故障注入 E2E（§18 矩阵抽样 · 车道 C）
 *
 * 全链路上注入四类故障（此前 p3/p4 是分段/单服务注入，本文件在完整
 * enroll→claim→workspace→artifact→delivery→merge 链路上注入）：
 *
 *   A. 节点掉线：SIGKILL node A（mid-finalize）→ lease 过期 →
 *      workspace-recovery 扫描 → orphan candidate → takeover 裁决 →
 *      attempt pending_recovery → 节点 B takeover 重 claim → 完成链路 merged；
 *   B. 网络分区：fault-injector fetch 拦截 → claim 停止、心跳超时 →
 *      quarantine 语义按现有实现断言（无自动降级，心跳 stale 不动状态）→
 *      分区恢复后自愈 + drain→offline→re-register（新 session fencing 旧）；
 *   C. merge 期间控制面重启：kill server 进程语义（close+新实例同库重启）→
 *      队列 job 跨重启持久 → dispatch 幂等收敛不双写（主分支恰好 +1 commit）；
 *   D. artifact 上传中断：finalize 引用未 complete 的 artifact →
 *      delivery pending_recovery → 补传 complete → recover 收敛 pending_review。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { loadNodeConfig } from '../../src/node/config.js';
import { NodeDaemon } from '../../src/node/daemon.js';
import { writeNodeCredential } from '../../src/node/credentials-store.js';
import type { FetchImpl } from '../../src/node/transport.js';
import { addFaultRoute, clearFaultRoutes, wrapFetchWithFaults } from './fixtures/fault-injector.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;
const OWNER_TOKEN = 'p8-fault-owner';
const ENROLLMENT_TICKET = 'p8-fault-ticket';
const TEST_KEY = '8899aabb'.repeat(8);
const keyring = [parseCredentialKey(TEST_KEY, 1)];

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NODE_BIN = join(REPO_ROOT, 'bin', 'biao-node.js');

const tempDirs: string[] = [];
const spawned: Array<{ proc: ChildProcess; exited: Promise<number | null> }> = [];
const worlds: Array<{ app: FastifyInstance; store: SqliteStore; redis: Redis }> = [];

const savedEnv: Record<string, string | undefined> = {};

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(tag: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `p8-fm-${tag}-`));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), `p8-fm-${tag}-seed-`));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p8 fault ${tag} ${randomBytes(6).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p8', '-c', 'user.email=p8@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
  return bare;
}

interface World {
  app: FastifyInstance;
  store: SqliteStore;
  redis: Redis;
  serverUrl: string;
  bare: string;
  projectId: string;
  dbPath: string | null;
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  remoteSha(ref: string): Promise<string | null>;
}

/** 一次测试世界：独立 bare + 独立 server（dbPath 给定时用文件库，供重启场景）。 */
async function makeWorld(tag: string, dbPath: string | null = null): Promise<World> {
  const bare = await createBareRemote(tag);
  const redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();
  const store = dbPath ? new SqliteStore(dbPath) : new SqliteStore(':memory:');
  const app = await createHttpServer(redis, {
    apiToken: OWNER_TOKEN,
    host: '127.0.0.1',
    port: 0,
    workspaceRoots: [],
  }, { sqliteStore: store, webDist: null });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const serverUrl = `http://127.0.0.1:${port}`;
  worlds.push({ app, store, redis });

  const project = await (async () => {
    const res = await fetch(`${serverUrl}/v2/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({ name: `p8-fault-${tag}`, repo_path: bare, default_branch: 'main', execution_mode: 'full' }),
    });
    const body = await res.json() as { ok: boolean; data: { project_id: string } };
    expect(body.ok).toBe(true);
    return body.data.project_id;
  })();

  const world: World = {
    app, store, redis, serverUrl, bare, projectId: project, dbPath,
    // 注意闭包读 world.serverUrl：重启场景（C）会替换实例与端口
    async api(method, path, body, headers) {
      const res = await fetch(`${world.serverUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async remoteSha(ref) {
      try {
        const out = await git(['ls-remote', bare, ref]);
        return out ? out.split('\t')[0] : null;
      } catch {
        return null;
      }
    },
  };
  return world;
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };

function seedTask(world: World, taskId: string, ownershipFiles: string[]): void {
  const planId = `plan-${world.projectId}`;
  const now = new Date().toISOString();
  world.store.upsertPlan({
    plan_id: planId, title: 'p8 fault plan', status: 'submitted',
    project_path: `/tmp/p8-fm-${world.projectId}`, default_assignee: 'auto', default_priority: 5,
    phases: '[]', task_count: 1, created_at: now, submitted_at: now,
  });
  world.store.upsertTask({
    task_id: taskId, plan_id: planId, title: `p8 ${taskId}`, type: 'implementation', phase: '1',
    status: 'pending', priority: 5, assignee: 'auto',
    ownership_files: JSON.stringify(ownershipFiles), ownership_modules: '', depends_on: '[]',
    timeout_seconds: 3600, max_retries: 2, model_override: '', acceptance_for: '', verify: '',
    claimed_by: '', claimed_at: '', expire_at: '', result_path: '', result_json_path: '', done_at: '',
    retries: 0, pm_review_status: '', pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '',
    pm_reject_reason: '', pm_fix_instructions: '', blocked_at: '', block_reason: '', blocked_question_id: '',
    blocked_lease_remaining: '', last_question_id: '', last_question_answer: '', cancelled_at: '',
    verify_results: '[]', goal_md: '', created_at: now, updated_at: now, project_id: world.projectId,
  });
  world.store.updateTaskFields(taskId, { project_id: world.projectId, updated_at: now });
}

/** HTTP enroll（owner + ticket）→ bvn2 credential。 */
async function enrollNode(world: World, nodeId: string): Promise<string> {
  const res = await world.api('POST', '/v2/nodes/enroll', {
    enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId,
  }, owner);
  expect(res.body.ok, `enroll 失败：${JSON.stringify(res.body)}`).toBe(true);
  await authorizeNode(world, nodeId);
  return res.body.data.node_credential as string;
}

/** owner authorize 节点→项目绑定（§12：claim 调度前置）。 */
async function authorizeNode(world: World, nodeId: string): Promise<void> {
  const res = await world.api('POST', `/v2/projects/${world.projectId}/nodes/${nodeId}/authorize`, {}, owner);
  expect(res.body.ok, `authorize ${nodeId} 失败：${JSON.stringify(res.body)}`).toBe(true);
}

function nodeBearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function attemptTokens(world: World, attemptId: string) {
  const attempt = world.store.getTaskAttempt(attemptId)!;
  return {
    ownership: issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'ownership', { keys: keyring }),
    report: issueAttemptToken(attemptId, attempt.task_id, attempt.attempt_generation, 'report', { keys: keyring }),
  };
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

/** claim（bvn2，project 维度自动取 pending task）。 */
async function claimPending(world: World, credential: string): Promise<string> {
  const res = await world.api('POST', '/v2/tasks/claim', {
    project_id: world.projectId,
    agent_id: 'p8',
    claim_request_id: `cr-${randomBytes(8).toString('hex')}`,
  }, nodeBearer(credential));
  expect(res.body.ok, `claim 失败：${JSON.stringify(res.body)}`).toBe(true);
  return res.body.data.attempt_id as string;
}

/** 执行链：prepare→写文件→[artifact?]→finalize→[report?]（accept 由调用方按场景推进）。 */
async function driveToAccepted(
  world: World,
  attemptId: string,
  relFile: string,
  content: string,
  options: { artifactComplete?: boolean; report?: boolean } = {},
): Promise<{ deliveryId: string; artifactId: string; artifactSha: string }> {
  const { artifactComplete = true, report = true } = options;
  const tokens = attemptTokens(world, attemptId);
  const prepared = await world.api('POST', `/v2/attempts/${attemptId}/workspace/prepare`, {}, nodeBearer(tokens.ownership));
  expect(prepared.body.ok, `prepare 失败：${JSON.stringify(prepared.body)}`).toBe(true);
  const dir = prepared.body.data.workspace_dir as string;
  mkdirSync(join(dir, relFile, '..'), { recursive: true });
  writeFileSync(join(dir, relFile), content);

  const artifactContent = Buffer.from(`p8-fm artifact ${attemptId} ${randomBytes(6).toString('hex')}\n`);
  const artifactSha = sha256hex(artifactContent);
  const init = await world.api('POST', '/v2/artifacts/initiate', {
    attempt_id: attemptId, kind: 'result-md', size_bytes: artifactContent.length, sha256: artifactSha,
  }, nodeBearer(tokens.report));
  expect(init.body.ok).toBe(true);
  const artifactId = init.body.data.artifact_id as string;
  const upload = await fetch(`${world.serverUrl}/v2/artifacts/${artifactId}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', ...nodeBearer(tokens.report) },
    body: new Uint8Array(artifactContent),
  });
  expect(upload.status).toBe(200);
  if (artifactComplete) {
    const complete = await world.api('POST', `/v2/artifacts/${artifactId}/complete`, {}, nodeBearer(tokens.report));
    expect(complete.body.ok, `complete 失败：${JSON.stringify(complete.body)} row=${JSON.stringify(world.store.getArtifact(artifactId))}`).toBe(true);
  }

  const finalized = await world.api('POST', `/v2/attempts/${attemptId}/workspace/finalize`, {
    artifact_refs: [{ artifact_id: artifactId }],
  }, nodeBearer(tokens.report));
  expect(finalized.body.ok, `finalize 失败：${JSON.stringify(finalized.body)}`).toBe(true);
  const deliveryId = finalized.body.data.delivery_id as string;

  if (report) {
    // report 校验 artifact 全部 complete（§9.2 第 7 条）——中断场景由调用方
    // 在补传收敛后自行 report
    const reported = await world.api('POST', `/v2/attempts/${attemptId}/report`, {
      status: 'done', artifact_refs: [{ artifact_id: artifactId, sha256: artifactSha }],
    }, nodeBearer(tokens.report));
    expect(reported.body.ok, `report 失败：${JSON.stringify(reported.body)}`).toBe(true);
  }
  return { deliveryId, artifactId, artifactSha };
}

async function acceptDelivery(world: World, deliveryId: string): Promise<void> {
  const res = await world.api('POST', `/v2/deliveries/${deliveryId}/review`, {
    verdict: 'accept', reviewed_by: 'pm-p8-fault',
  }, owner);
  expect(res.body.ok, `accept 失败：${JSON.stringify(res.body)}`).toBe(true);
}

async function mergeDelivery(world: World, deliveryId: string): Promise<string> {
  const head = await world.remoteSha('refs/heads/main');
  const enqueue = await world.api('POST', '/v2/merge-jobs', {
    project_id: world.projectId, delivery_id: deliveryId, expected_target_sha: head,
  }, owner);
  expect(enqueue.body.ok).toBe(true);
  const dispatch = await world.api('POST', `/v2/projects/${world.projectId}/merge-jobs/dispatch`, {}, owner);
  expect(dispatch.body.ok, `dispatch 失败：${JSON.stringify(dispatch.body)}`).toBe(true);
  expect(dispatch.body.data.status).toBe('merged');
  return dispatch.body.data.final_sha as string;
}

/* ---------------- 子进程 daemon（A 场景） ---------------- */

function runCli(args: string[], envExtra: Record<string, string>, timeoutMs: number) {
  const proc = spawn(process.execPath, [NODE_BIN, ...args], {
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, timeoutMs).unref();
  });
  spawned.push({ proc, exited });
  return { proc, exited };
}

async function setupSubprocessNode(world: World, label: string, slots: number): Promise<{ nodeId: string; configPath: string; credential: string }> {
  const dir = mkdtempSync(join(tmpdir(), `p8-fm-${label}-`));
  tempDirs.push(dir);
  const nodeId = `node-p8-fm-${label}-${randomBytes(4).toString('hex')}`;
  const ticketFile = join(dir, 'ticket.txt');
  writeFileSync(ticketFile, ENROLLMENT_TICKET);
  const configPath = join(dir, 'biao-node.config.json');
  const enroll = runCli([
    'enroll', '--url', world.serverUrl, '--node-id', nodeId,
    '--ticket-file', ticketFile, '--config', configPath, '--cache-root', join(dir, 'cache'),
  ], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 30_000);
  expect(await enroll.exited).toBe(0);
  await authorizeNode(world, nodeId);
  writeFileSync(configPath, JSON.stringify({
    biao_url: world.serverUrl, node_id: nodeId, slots,
    heartbeat_interval_ms: 300, watchdog_tick_ms: 100, claim_interval_ms: 250,
    lease_renew_margin_ms: 300_000, lease_stop_window_ms: 5_000,
    drain_timeout_ms: 1_500, drain_timeout_action: 'cancel',
    requested_project_ids: [world.projectId], server_protocol_version: 2,
    cache_root: join(dir, 'cache'),
  }, null, 2));
  // 读取 enroll 落盘的 bvn2（0600 文件；不重复 enroll 以免 generation 前滚 fencing 掉运行中的 daemon）
  const stored = JSON.parse(readFileSync(join(dir, 'node-credential.json'), 'utf8')) as { credential: string };
  return { nodeId, configPath, credential: stored.credential };
}

function statusOf(configPath: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(loadNodeConfig(configPath).status_file, 'utf8'));
  } catch {
    return null;
  }
}

/* ---------------- env / 生命周期 ---------------- */

beforeAll(() => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
  process.env['BIAO_V2_ENROLLMENT_TICKET'] = ENROLLMENT_TICKET;
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);
});

afterAll(async () => {
  clearFaultRoutes();
  for (const { proc } of spawned) {
    if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
  }
  await Promise.all(spawned.map(({ exited }) => exited)).catch(() => undefined);
  for (const world of worlds.splice(0)) {
    await world.app.close().catch(() => undefined);
    world.store.close();
    await world.redis.flushdb();
    world.redis.disconnect();
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

/* ================================================================ */
/* A. 节点掉线：SIGKILL mid-attempt → lease 回收 → B takeover       */
/* ================================================================ */

describe('Phase 8 故障 A：节点掉线（SIGKILL）→ takeover → 完成链路', () => {
  let world: World;
  let nodeA: { nodeId: string; configPath: string; credential: string };
  let nodeB: { nodeId: string; configPath: string; credential: string };
  let attemptA = '';

  beforeAll(async () => {
    world = await makeWorld('kill');
    seedTask(world, 'task-fm-kill', ['a/**']);
    nodeA = await setupSubprocessNode(world, 'kill-a', 1);
    runCli(['run', '--config', nodeA.configPath], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 180_000);
    await waitFor(() => statusOf(nodeA.configPath)?.phase === 'running', 'node A running', 20_000);
    // 只有一个 task：A 独占 claim 后再引入 B（保证 B 空闲待命 takeover）
    attemptA = await waitFor(() => {
      const task = world.store.getTask('task-fm-kill');
      return task?.active_attempt_id || undefined;
    }, 'A claim', 20_000);
    nodeB = await setupSubprocessNode(world, 'kill-b', 1);
    runCli(['run', '--config', nodeB.configPath], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 180_000);
    await waitFor(() => statusOf(nodeB.configPath)?.phase === 'running', 'node B running', 20_000);
  }, 90_000);

  it('A 执行到 finalize 中途被 SIGKILL（durable 状态停在 committing）', { timeout: 60_000 }, async () => {
    const tokens = attemptTokens(world, attemptA);
    const prepared = await world.api('POST', `/v2/attempts/${attemptA}/workspace/prepare`, {}, nodeBearer(tokens.ownership));
    expect(prepared.body.ok).toBe(true);
    const dir = prepared.body.data.workspace_dir as string;
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'from-a.md'), 'A 被杀前的改动\n');
    // 模拟 commit 中途进程死亡：workspace 持久状态停在 committing（p4 同款语义）
    world.store.updateAttemptWorkspace(attemptA, { finalize_state: 'committing' });
    const killer = spawned.find(({ proc }) => statusOf(nodeA.configPath)?.pid === proc.pid);
    killer?.proc.kill('SIGKILL');
    await killer?.exited;
    expect(world.store.getTaskAttempt(attemptA)!.status).toBe('executing');
  });

  it('lease 过期 → workspace-recovery 扫描 → orphan candidate（node-offline-timeout）', async () => {
    // lease 未过期：不产生候选（watchdog 前置判据）。scan 返回 {scanned,candidates} 平面对象
    const early = await world.api('POST', '/v2/workspace-recovery/scan', {}, owner);
    expect(early.body.candidates).toBe(0);
    // 时间前进到 lease 过期（模拟 watchdog 周期到达）
    world.store.updateTaskAttempt(attemptA, { lease_expires_at: Date.now() - 1_000, updated_at: Date.now() });
    const scan = await world.api('POST', '/v2/workspace-recovery/scan', {}, owner);
    expect(scan.body.candidates).toBe(1);
    const candidates = world.store.listOrphanRecoveryCandidates(world.projectId, 'pending');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].attempt_id).toBe(attemptA);
    expect(candidates[0].takeover_reason).toBe('node-offline-timeout');
    expect(candidates[0].recovery_path).toBe('control-plane-takeover');
  });

  it('takeover 裁决 → attempt pending_recovery（不再阻塞重 claim）→ 节点 B 重 claim 完成', { timeout: 90_000 }, async () => {
    const candidates = world.store.listOrphanRecoveryCandidates(world.projectId, 'pending');
    const takeover = await world.api('POST', `/v2/recovery-candidates/${candidates[0].candidate_id}/takeover`, {
      reason: '节点 A 掉线（SIGKILL），lease 过期', decided_by: 'recovery-reviewer-p8',
    }, owner);
    expect(takeover.body.ok).toBe(true);
    expect(takeover.body.data.status).toBe('decided');
    expect(takeover.body.data.decision).toBe('upload-and-reverify');
    // takeover 裁决传导：executing+过期 → pending_recovery
    expect(world.store.getTaskAttempt(attemptA)!.status).toBe('pending_recovery');

    // B takeover：重 claim 同一 task（generation +1）
    const attemptB = await claimPending(world, nodeB.credential);
    expect(attemptB).not.toBe(attemptA);
    expect(world.store.getTaskAttempt(attemptB)!.attempt_generation).toBe(2);
    expect(world.store.getTaskAttempt(attemptB)!.node_id).toBe(nodeB.nodeId);

    // B 完成链路到 merged
    const { deliveryId } = await driveToAccepted(world, attemptB, 'a/from-b-takeover.md', 'B 接管后的改动\n');
    await acceptDelivery(world, deliveryId);
    const finalSha = await mergeDelivery(world, deliveryId);
    expect(world.store.getDelivery(deliveryId)!.status).toBe('merged');
    expect(await world.remoteSha('refs/heads/main')).toBe(finalSha);
    // A 的 attempt 与候选记录留档（审计不丢）
    expect(world.store.getTaskAttempt(attemptA)!.status).toBe('pending_recovery');
    expect(world.store.getOrphanRecoveryCandidate(candidates[0].candidate_id)!.status).toBe('decided');
  });
});

/* ================================================================ */
/* B. 网络分区：fetch 拦截 → claim 停止 / 心跳超时 → 恢复自愈        */
/* ================================================================ */

describe('Phase 8 故障 B：网络分区（fetch 拦截）→ 恢复 re-register', () => {
  let world: World;
  let nodeId = '';
  let configPath = '';
  let partitioned = false;
  let daemon: NodeDaemon;
  let runPromise: Promise<number>;

  beforeAll(async () => {
    world = await makeWorld('partition');
    seedTask(world, 'task-fm-part-1', ['a/**']);
    seedTask(world, 'task-fm-part-2', ['b/**']);
    nodeId = `node-p8-fm-part-${randomBytes(4).toString('hex')}`;

    const credential = await enrollNode(world, nodeId);
    const dir = mkdtempSync(join(tmpdir(), 'p8-fm-part-'));
    tempDirs.push(dir);
    configPath = join(dir, 'biao-node.config.json');
    const cacheRoot = join(dir, 'cache');
    writeNodeCredential(join(dir, 'node-credential.json'), {
      node_id: nodeId, credential, credential_generation: 1, biao_url: world.serverUrl, enrolled_at: Date.now(),
    });
    writeFileSync(configPath, JSON.stringify({
      biao_url: world.serverUrl, node_id: nodeId, slots: 2,
      heartbeat_interval_ms: 250, watchdog_tick_ms: 100, claim_interval_ms: 200,
      lease_renew_margin_ms: 300_000, lease_stop_window_ms: 5_000,
      drain_timeout_ms: 1_500, drain_timeout_action: 'cancel',
      requested_project_ids: [world.projectId], server_protocol_version: 2, cache_root: cacheRoot,
    }, null, 2));

    // fault-injector 包装 fetch：分区开关控制对控制面的全部请求
    addFaultRoute(world.serverUrl, () => partitioned, new Error('网络分区：连接被拒绝'));
    daemon = NodeDaemon.fromConfig(loadNodeConfig(configPath), {
      node_id: nodeId, credential, credential_generation: 1, biao_url: world.serverUrl, enrolled_at: Date.now(),
    }, { fetchImpl: wrapFetchWithFaults(globalThis.fetch as FetchImpl), ownerToken: OWNER_TOKEN });
    runPromise = daemon.run();
    runPromise.catch(() => undefined);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 'daemon running（分区前）', 20_000);
  }, 60_000);

  it('分区前：两个 task 均被认领、心跳健康', async () => {
    await waitFor(() => {
      const tasks = world.store.getTasksByProjectId(world.projectId);
      return tasks.filter((t) => t.status === 'running').length === 2 ? true : undefined;
    }, '两个 task 被认领', 20_000);
    const status = statusOf(configPath)!;
    expect(status.heartbeat.last_ok).toBe(true);
  });

  it('注入分区 → claim 停止（无新 attempt）、心跳超时、节点状态不自动降级', async () => {
    partitioned = true;
    const attemptsBefore = world.store.getTasksByProjectId(world.projectId)
      .flatMap((t) => world.store.listTaskAttemptsByTask(t.task_id)).length;
    const seenBefore = world.store.getNode(nodeId)!.last_seen_at;

    await waitFor(() => statusOf(configPath)?.heartbeat?.last_ok === false, '心跳开始失败', 15_000);
    await waitFor(() => (statusOf(configPath)?.heartbeat?.consecutive_failures ?? 0) >= 2, '连续心跳失败≥2', 15_000);
    // 分区期间不再有新 attempt 落库（claim 停止）
    await new Promise((resolve) => setTimeout(resolve, 800));
    const attemptsAfter = world.store.getTasksByProjectId(world.projectId)
      .flatMap((t) => world.store.listTaskAttemptsByTask(t.task_id)).length;
    expect(attemptsAfter).toBe(attemptsBefore);
    // quarantine 语义（按现有实现）：心跳 stale 不自动改节点状态（自动
    // offline/quarantine 属 scheduler Phase 9 缺口），状态与 last_seen 冻结
    expect(world.store.getNode(nodeId)!.status).toBe('online');
    expect(world.store.getNode(nodeId)!.last_seen_at).toBe(seenBefore);
    // daemon 不退出：fail-closed 重试
    expect(statusOf(configPath)!.phase).toBe('running');
  }, 30_000);

  it('分区恢复 → 心跳自愈 → drain/offline → re-register（新 session，旧 fenced）', { timeout: 60_000 }, async () => {
    partitioned = false;
    await waitFor(() => statusOf(configPath)?.heartbeat?.last_ok === true, '心跳恢复', 15_000);
    await waitFor(() => world.store.getNode(nodeId)!.last_seen_at > 0
      && world.store.getNode(nodeId)!.status === 'online', '服务端 last_seen 前进', 15_000);

    // drain 收口（控制文件语义 = CLI drain）：offline → exit 0
    const config = loadNodeConfig(configPath);
    mkdirSync(config.state_control_dir, { recursive: true });
    writeFileSync(join(config.state_control_dir, 'drain.json'), JSON.stringify({ requested_at: Date.now() }));
    expect(await runPromise).toBe(0);
    await waitFor(() => world.store.getNode(nodeId)!.status === 'offline', 'offline', 10_000);

    // re-register：同一凭据重启 daemon（register 新 session generation，旧 fenced）
    const oldSession = world.store.getCurrentNodeSession(nodeId);
    const daemon2 = NodeDaemon.fromConfig(loadNodeConfig(configPath), {
      node_id: nodeId, credential: (await enrollNode(world, nodeId)), credential_generation: 2, biao_url: world.serverUrl, enrolled_at: Date.now(),
    }, { fetchImpl: wrapFetchWithFaults(globalThis.fetch as FetchImpl), ownerToken: OWNER_TOKEN });
    const run2 = daemon2.run();
    run2.catch(() => undefined);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 're-register 后 running', 20_000);
    await waitFor(() => {
      const session = world.store.getCurrentNodeSession(nodeId);
      return session && session.session_id !== oldSession?.session_id ? session : undefined;
    }, '新 session', 15_000);
    expect(world.store.getNodeSession(oldSession!.session_id)!.status).toBe('fenced');
    // 收口：drain 第二个 daemon
    const config2 = loadNodeConfig(configPath);
    writeFileSync(join(config2.state_control_dir, 'drain.json'), JSON.stringify({ requested_at: Date.now() }));
    expect(await run2).toBe(0);
  });
});

/* ================================================================ */
/* C. merge 期间控制面重启 → 队列持久 + 幂等收敛不双写                */
/* ================================================================ */

describe('Phase 8 故障 C：merge 期间控制面重启 → 幂等收敛', () => {
  let world: World;
  let dbDir: string;
  let deliveryId = '';
  let mergeJobId = '';
  let headBefore = '';

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'p8-fm-restart-'));
    tempDirs.push(dbDir);
    world = await makeWorld('restart', join(dbDir, 'biao.sqlite'));
    seedTask(world, 'task-fm-restart', ['a/**']);
  }, 60_000);

  it('重启前：链路推进到 merge job 已入队（尚未 dispatch）', { timeout: 90_000 }, async () => {
    const credential = await enrollNode(world, `node-p8-fm-restart-${randomBytes(3).toString('hex')}`);
    const attemptId = await claimPending(world, credential);
    const driven = await driveToAccepted(world, attemptId, 'a/restart.md', '重启前的改动\n');
    deliveryId = driven.deliveryId;
    await acceptDelivery(world, deliveryId);
    headBefore = (await world.remoteSha('refs/heads/main'))!;
    const enqueue = await world.api('POST', '/v2/merge-jobs', {
      project_id: world.projectId, delivery_id: deliveryId, expected_target_sha: headBefore,
    }, owner);
    expect(enqueue.body.ok).toBe(true);
    mergeJobId = enqueue.body.data.merge_job_id as string;
    expect(enqueue.body.data.status).toBe('queued');
  });

  it('控制面崩溃重启（同库同 bare）：job 持久、dispatch 收敛 merged、主分支恰好 +1 commit', { timeout: 90_000 }, async () => {
    // “kill 测试 server 进程”语义：关闭实例与连接，同库文件起第二个实例
    await world.app.close();
    world.store.close();
    const index = worlds.findIndex((w) => w.app === world.app);
    if (index >= 0) worlds.splice(index, 1);

    const redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
    await redis.connect();
    const store2 = new SqliteStore(world.dbPath!);
    const app2 = await createHttpServer(redis, {
      apiToken: OWNER_TOKEN, host: '127.0.0.1', port: 0, workspaceRoots: [],
    }, { sqliteStore: store2, webDist: null });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr = app2.server.address();
    world.app = app2;
    world.store = store2;
    world.redis = redis;
    world.serverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    worlds.push({ app: app2, store: store2, redis });

    // 重启后 job 仍在队列（durable）；delivery 仍 accepted
    const job = await world.api('GET', `/v2/merge-jobs/${mergeJobId}`, undefined, owner);
    expect(job.body.data.status).toBe('queued');

    // 重启后重复入队（同 delivery+target）幂等返回原 job，不产生第二个
    const reenqueue = await world.api('POST', '/v2/merge-jobs', {
      project_id: world.projectId, delivery_id: deliveryId, expected_target_sha: headBefore,
    }, owner);
    expect(reenqueue.body.data.merge_job_id).toBe(mergeJobId);

    // dispatch → merged；重复 dispatch 空转（不双写）
    const dispatch = await world.api('POST', `/v2/projects/${world.projectId}/merge-jobs/dispatch`, {}, owner);
    expect(dispatch.body.data.status).toBe('merged');
    const finalSha = dispatch.body.data.final_sha as string;
    const again = await world.api('POST', `/v2/projects/${world.projectId}/merge-jobs/dispatch`, {}, owner);
    expect(again.body.data).toBeNull();

    // 不双写：主分支第一父链从 headBefore 到 finalSha 恰好 1 个 merge commit
    // （--no-ff 合并；attempt 分支 commit 经第二父可达不计入）；最终 ref 不再变
    const countDir = mkdtempSync(join(tmpdir(), 'p8-fm-count-'));
    tempDirs.push(countDir);
    const repo = join(countDir, 'repo');
    await git(['clone', world.bare, repo]);
    const commitCount = await git(['rev-list', '--count', '--first-parent', `${headBefore}..${finalSha}`], repo);
    expect(Number(commitCount)).toBe(1);
    expect(await world.remoteSha('refs/heads/main')).toBe(finalSha);
    expect(world.store.getDelivery(deliveryId)!.status).toBe('merged');
  });
});

/* ================================================================ */
/* D. artifact 上传中断 → pending_recovery → 补传收敛                */
/* ================================================================ */

describe('Phase 8 故障 D：artifact 上传中断 → delivery pending_recovery → 补传收敛', () => {
  let world: World;

  beforeAll(async () => {
    world = await makeWorld('artifact');
    seedTask(world, 'task-fm-artifact', ['a/**']);
  }, 60_000);

  it('中断（finalize 引用未 complete 的 artifact）→ 补传 → recover → pending_review → merged', { timeout: 90_000 }, async () => {
    const credential = await enrollNode(world, `node-p8-fm-art-${randomBytes(3).toString('hex')}`);
    const attemptId = await claimPending(world, credential);
    const driven = await driveToAccepted(world, attemptId, 'a/artifact-recover.md', '待补传 artifact 的改动\n', { artifactComplete: false, report: false });

    // finalize 已发生（artifact 未 complete）→ delivery pending_recovery
    const delivery = world.store.getDelivery(driven.deliveryId)!;
    expect(delivery.status).toBe('pending_recovery');
    expect(world.store.getAttemptWorkspace(attemptId)!.finalize_state).toBe('pending_recovery');

    // 中断期间：report 被 §9.2 第 7 条拒绝（引用未 complete 的 artifact）
    const tokens = attemptTokens(world, attemptId);
    const earlyReport = await world.api('POST', `/v2/attempts/${attemptId}/report`, {
      status: 'done', artifact_refs: [{ artifact_id: driven.artifactId, sha256: driven.artifactSha }],
    }, nodeBearer(tokens.report));
    expect(earlyReport.body.ok).toBe(false);
    expect(earlyReport.body.error.code).toBe('ARTIFACT_NOT_COMPLETE');
    // review 同样被状态机拒绝（pending_recovery 不可直接审）
    const earlyReview = await world.api('POST', `/v2/deliveries/${driven.deliveryId}/review`, {
      verdict: 'accept', reviewed_by: 'pm-p8',
    }, owner);
    expect(earlyReview.body.ok).toBe(false);

    // 补传：complete artifact → recover-artifacts 收敛 pending_review
    const complete = await world.api('POST', `/v2/artifacts/${driven.artifactId}/complete`, {}, nodeBearer(tokens.report));
    expect(complete.body.ok).toBe(true);
    const recover = await world.api('POST', `/v2/deliveries/${driven.deliveryId}/recover-artifacts`, {}, owner);
    expect(recover.body.ok, `recover 失败：${JSON.stringify(recover.body)}`).toBe(true);
    expect(recover.body.data.status).toBe('pending_review');
    expect(recover.body.data.artifacts_complete).toBe(true);

    // 收敛后补 report + 正常走审 + 合并
    const reported = await world.api('POST', `/v2/attempts/${attemptId}/report`, {
      status: 'done', artifact_refs: [{ artifact_id: driven.artifactId, sha256: driven.artifactSha }],
    }, nodeBearer(tokens.report));
    expect(reported.body.ok).toBe(true);
    await acceptDelivery(world, driven.deliveryId);
    const finalSha = await mergeDelivery(world, driven.deliveryId);
    expect(world.store.getDelivery(driven.deliveryId)!.status).toBe('merged');
    expect(await world.remoteSha('refs/heads/main')).toBe(finalSha);
    // attempt 分支排入清理（pending，保留窗口内未删）
    const cleanups = await world.api('GET', `/v2/branch-cleanups?project_id=${world.projectId}`, undefined, owner);
    expect((cleanups.body.data.items as Array<{ branch_ref: string }>)
      .some((r) => r.branch_ref === delivery.branch_ref)).toBe(true);
  });
});
