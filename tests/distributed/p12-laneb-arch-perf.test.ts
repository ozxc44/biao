/**
 * P12 车道 B：架构优化（service 拆分 + claim 索引 + SSE 推送）测试
 *
 * 覆盖：
 * 1. AttemptService 第一批迁移（service.ts → src/server/v2/attempt-service.ts）：
 *    - facade re-export 的 17 个函数与实现模块是同一引用（零破坏迁移）；
 *    - service.ts 相对迁移前基线（14357 行）净减 ≥3000 行；
 *    - SERVICE_MAP 台账记录了迁移去向；
 *    - 迁移后行为：真实 Redis 上 claim/renewLease/Question/block/resume 全链。
 * 2. V2/V1 桥接 claim 性能：getFirstPendingTaskWithoutProject（status 索引 +
 *    LIMIT 1）替代 getAllTasks 全表扫描；行序与旧 find 语义等价；route 级
 *    project_id 索引优先、miss 后回退 + 回填。
 * 3. GET /v2/events/stream（bvn2 → task_ready SSE 推送）：
 *    - 旗门禁 / 鉴权 / 事件推送 / last_id 断线续读；
 *    - NodeApiClient.streamEvents 的 SSE 解析（data JSON、注释行、close/done）。
 * 4. daemon SSE 唤醒：收到 task_ready 后立即 claim（claim_interval_ms 调大，
 *    证明是唤醒驱动而非轮询）；轮询通道保留（间隔到期后仍会 claim）。
 * 5. BIAO_EXEC_CMD env → RealExecutor 执行命令模板（显式选项优先）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import * as service from '../../src/server/service.js';
import * as attemptService from '../../src/server/v2/attempt-service.js';
import { writePlanToRedis, writeTaskToRedis } from '../../src/redis/ownership.js';
import { keys } from '../../src/redis/keys.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import { NodeApiClient, type WorkerStreamEvent } from '../../src/node/transport.js';
import { NodeDaemon } from '../../src/node/daemon.js';
import { loadNodeConfig } from '../../src/node/config.js';
import type { FastifyInstance } from 'fastify';
import type { TaskRow } from '../../src/db/sqlite-store.js';

/* ---------------------------------------------------------------- */
/* 常量与 env 纪律（p23 教训：save/restore，singleFork 串行不泄漏）     */
/* ---------------------------------------------------------------- */

const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'p12-laneb-owner';
const ENROLLMENT_TICKET = 'p12-laneb-ticket';
const TEST_KEY = '00112233'.repeat(8);
const PROJECT_PATH = '/tmp/biao-p12-laneb';
/** 迁移前基线（git 413f3b1 时 service.ts 行数）；净减 ≥3000 是车道 B 的验收线。 */
const SERVICE_TS_BASELINE_LINES = 14_357;

const savedEnv: Record<string, string | undefined> = {};
let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl = '';
const tempDirs: string[] = [];

const execFileAsync = promisify(execFile);

/** 测试内 git（p8 loopback 同款语义）。 */
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(label: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `p12-${label}-bare-`));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), `p12-${label}-seed-`));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p12 ${label} fixture\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p12', '-c', 'user.email=p12@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
  return bare;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `biao-p12-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T, label: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
    await wait(100);
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
    headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function seedStoreTask(taskId: string, projectId: string | null, status = 'pending'): void {
  const planId = `plan-${projectId ?? 'v1'}-${taskId}`;
  store.upsertPlan({
    plan_id: planId,
    title: `p12 plan ${taskId}`,
    status: 'submitted',
    project_path: `${PROJECT_PATH}-${taskId}`,
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
    ...(projectId ? { project_id: projectId } : {}),
  } as never);
  store.upsertTask({
    task_id: taskId,
    plan_id: planId,
    title: `p12 ${taskId}`,
    type: 'implementation',
    phase: 'impl',
    status,
    priority: 5,
    assignee: 'auto',
    ownership_files: '[]',
    ownership_modules: '',
    depends_on: '',
    timeout_seconds: 300,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '[]',
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
    goal_md: `# ${taskId}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as TaskRow);
  // upsertTask 的固定列清单不含 §20.2 扩展列：project_id 必须走 updateTaskFields
  // 回填（与生产 claim 路径同一约束）。
  if (projectId) store.updateTaskFields(taskId, { project_id: projectId });
}

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

  const dir = makeTempDir('server');
  store = new SqliteStore(join(dir, 'biao.sqlite'));
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
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
  if (app) await app.close();
  if (store) store.close();
  if (redis) {
    await redis.flushdb();
    redis.disconnect();
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 30_000);

/* ================================================================ */
/* 1. AttemptService 第一批迁移                                      */
/* ================================================================ */

describe('P12 车道 B：AttemptService 迁移（service.ts → v2/attempt-service.ts）', () => {
  const MIGRATED = [
    'claim', 'report', 'renewLease',
    'createQuestion', 'listQuestions', 'getQuestion', 'answerQuestion',
    'taskBlock', 'taskResume',
    'ownershipCheck', 'ownershipDeclare', 'ownershipRelease',
    'getTask', 'getTasks', 'getPendingReviewTasks',
    'supersedeTask', 'cancelTask',
  ] as const;

  it('facade re-export 与实现模块是同一函数引用（17/17，零破坏）', () => {
    for (const name of MIGRATED) {
      const facade = (service as Record<string, unknown>)[name];
      const impl = (attemptService as Record<string, unknown>)[name];
      expect(typeof facade, `${name} 应为函数`).toBe('function');
      expect(impl).toBe(facade);
    }
  });

  it(`service.ts 相对迁移前基线净减 ≥3000 行（基线 ${SERVICE_TS_BASELINE_LINES}）`, () => {
    const here = new URL('.', import.meta.url);
    const serviceSource = readFileSync(new URL('../../src/server/service.ts', here), 'utf8');
    const attemptSource = readFileSync(new URL('../../src/server/v2/attempt-service.ts', here), 'utf8');
    const serviceLines = serviceSource.split('\n').length;
    const attemptLines = attemptSource.split('\n').length;
    expect(serviceLines).toBeLessThanOrEqual(SERVICE_TS_BASELINE_LINES - 3_000);
    expect(attemptLines).toBeGreaterThanOrEqual(3_000);
  });

  it('SERVICE_MAP 台账记录了迁移去向', () => {
    const here = new URL('.', import.meta.url);
    const map = readFileSync(new URL('../../src/server/v2/SERVICE_MAP.md', here), 'utf8');
    expect(map).toContain('第一批已迁移');
    expect(map).toContain('src/server/v2/attempt-service.ts');
  });

  it('迁移后行为：真实 Redis 上 claim → renewLease → Question → block/resume 全链', async () => {
    // seed：V1 路径（Redis 真相源）+ agent 注册（agentRegister 仍在 service.ts）
    await writePlanToRedis(redis, {
      plan_id: 'p12-migration-plan',
      title: 'p12 migration plan',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'p12-migration-task',
      title: 'p12 migration task',
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: 6,
      timeout_seconds: 120,
      verify: [],
    }, '# p12 migration', 'p12-migration-plan', PROJECT_PATH, 5);
    await writeTaskToRedis(redis, {
      task_id: 'p12-migration-blocked',
      title: 'p12 blocked task',
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: 5,
      timeout_seconds: 120,
      verify: [],
    }, '# p12 blocked', 'p12-migration-plan', PROJECT_PATH, 5);
    const registered = await service.agentRegister(redis, 'p12-worker-a', 'mock', ['code']);
    expect(registered.ok).toBe(true);

    // claim（已迁）
    const claimed = await service.claim(redis, { agent_id: 'p12-worker-a', blocking: false });
    if (!claimed.ok || !claimed.data) throw new Error(`claim 失败: ${JSON.stringify(claimed)}`);
    expect(claimed.data.task_id).toBe('p12-migration-task');
    const token = claimed.data!.claim_token;

    // renewLease（已迁）：错 token 拒绝，正确 token 续租
    const badRenew = await service.renewLease(redis, { task_id: 'p12-migration-task', claim_token: 'wrong' });
    expect(badRenew.ok).toBe(false);
    expect(badRenew.error?.code).toBe('CLAIM_TOKEN_INVALID');
    const renewed = await service.renewLease(redis, { task_id: 'p12-migration-task', claim_token: token, extend_seconds: 60 });
    expect(renewed.ok).toBe(true);

    // Question（已迁）：claim token 提问 → PM 回答
    const asked = await service.createQuestion(redis, {
      task_id: 'p12-migration-task',
      agent_id: 'p12-worker-a',
      claim_token: token,
      body: 'p12 迁移验证：可以继续吗？',
    });
    expect(asked.ok).toBe(true);
    const questionId = asked.data!.question_id;
    const listed = await service.listQuestions(redis, { status: 'open' });
    expect(listed.data?.some((q: { question_id: string }) => q.question_id === questionId)).toBe(true);
    const fetched = await service.getQuestion(redis, questionId, 'p12-worker-a');
    expect(fetched.data?.question_id).toBe(questionId);
    const answered = await service.answerQuestion(redis, questionId, {
      question_id: questionId,
      consumer: 'pm',
      answer: '继续',
    });
    expect(answered.ok).toBe(true);

    // getTask/getTasks 读面（已迁）
    const task = await service.getTask(redis, 'p12-migration-task');
    expect(task.data?.status).toBe('pending'); // Question 解答后回队
    const tasks = await service.getTasks(redis, { status: 'pending' });
    expect(tasks.data?.tasks.some((t: { task_id: string }) => t.task_id === 'p12-migration-task')).toBe(true);

    // cancel（已迁）收尾主任务
    const cancelled = await service.cancelTask(redis, 'p12-migration-task', { reason: 'p12 验证取消' });
    expect(cancelled.ok).toBe(true);

    // block → resume → supersede（已迁）：领取第二个任务后注入未满足依赖，
    // waiting_dependency 阻塞必须粘住（eligible 时会被立即重排队——V1 语义）。
    const claimed2 = await service.claim(redis, { agent_id: 'p12-worker-a', blocking: false });
    if (!claimed2.ok || !claimed2.data) throw new Error(`claim2 失败: ${JSON.stringify(claimed2)}`);
    expect(claimed2.data.task_id).toBe('p12-migration-blocked');
    await writeTaskToRedis(redis, {
      task_id: 'p12-dep-task', title: 'p12 dep', type: 'code', phase: 'impl', assignee: 'auto',
      priority: 5, timeout_seconds: 60, verify: [],
    }, '# dep', 'p12-migration-plan', PROJECT_PATH, 5);
    await redis.hset(keys.hash.task('p12-migration-blocked'), 'depends_on', 'p12-dep-task');
    const blocked = await service.taskBlock(redis, 'p12-migration-blocked', 'p12-worker-a', {
      claim_token: claimed2.data.claim_token,
      reason: 'waiting_dependency',
    });
    expect(blocked.ok).toBe(true);
    expect(blocked.data?.blocked).toBe(true);
    const blockedTask = await service.getTask(redis, 'p12-migration-blocked');
    expect(blockedTask.data?.status).toBe('blocked');
    // 依赖完成后 resume：复用 eligibility 判定（done + PM accepted 口径），重排队回 pending
    await redis.hset(keys.hash.task('p12-dep-task'), 'status', 'done', 'pm_review_status', 'accepted');
    const resumed = await service.taskResume(redis, 'p12-migration-blocked', 'p12-worker-a');
    expect(resumed.ok).toBe(true);
    const resumedTask = await service.getTask(redis, 'p12-migration-blocked');
    expect(resumedTask.data?.status).toBe('pending');
    // supersede 的候选口径是 done 且未经 PM 复核（isSupersedeCandidate）
    await redis.hset(keys.hash.task('p12-migration-blocked'), 'status', 'done');
    const superseded = await service.supersedeTask(redis, 'p12-migration-blocked', {
      reason: 'p12 验证替换',
      superseded_by: 'p12-worker-a',
      confirmed: true,
    });
    expect(superseded.ok).toBe(true);
  }, 30_000);
});

/* ================================================================ */
/* 2. V2/V1 桥接 claim 性能                                          */
/* ================================================================ */

describe('P12 车道 B：claim 桥接回退（status 索引 + LIMIT 1）', () => {
  it('getFirstPendingTaskWithoutProject：未归属 pending 首行；归属/非 pending 不选；空串视同未归属', () => {
    seedStoreTask('p12-bound-1', 'proj-p12-a');
    seedStoreTask('p12-unbound-1', null);
    seedStoreTask('p12-done-unbound', null, 'done');

    const first = store.getFirstPendingTaskWithoutProject();
    expect(first?.task_id).toBe('p12-unbound-1');

    // 队列清空后 miss 返回 undefined
    store.updateTaskFields('p12-unbound-1', { status: 'running' });
    expect(store.getFirstPendingTaskWithoutProject()).toBeUndefined();

    // 空串 project_id 与旧 JS 判定 `!project_id` 等价（SQL 侧兼容）
    seedStoreTask('p12-emptystr-1', null);
    store.updateTaskFields('p12-emptystr-1', { project_id: '' });
    const emptyStr = store.getFirstPendingTaskWithoutProject();
    expect(emptyStr?.task_id).toBe('p12-emptystr-1');

    // 清理：本文件内多测试共享同一 store，不能把 pending 任务留给 route 级测试
    for (const id of ['p12-bound-1', 'p12-unbound-1', 'p12-done-unbound', 'p12-emptystr-1']) {
      store.updateTaskFields(id, { status: 'cancelled' });
    }
    expect(store.getFirstPendingTaskWithoutProject()).toBeUndefined();
  });

  it('route 级：project_id 索引优先；miss 后回退 V1 队列并回填 project_id', async () => {
    // 项目 + 节点 + 绑定（p8 loopback 同款流程；repo_path 需真实 git 仓库）
    const createProject = await api('POST', '/v2/projects', {
      name: 'p12-laneb-route',
      repo_path: await createBareRemote('route'),
      default_branch: 'main',
      execution_mode: 'full',
    }, owner);
    expect(createProject.body.ok).toBe(true);
    const projectId = createProject.body.data.project_id as string;

    const nodeId = 'p12-laneb-route-node1';
    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
    expect(enroll.body.ok).toBe(true);
    const nodeCredential = enroll.body.data.node_credential as string;
    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId, slots: 2, requested_project_ids: [projectId], protocol_version: 2,
    }, bearer(nodeCredential));
    expect(register.body.ok).toBe(true);
    const heartbeat = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, {
      protocol_version: 2, clock_skew_ms: 0, disk_free_gib: 100, disk_free_percent: 95,
      slots_in_use: 0, running_attempt_ids: [],
    }, bearer(nodeCredential));
    expect(heartbeat.body.ok).toBe(true);
    const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
    if (!authorize.body.ok) throw new Error(`authorize 失败: ${JSON.stringify(authorize.body)}`);
    expect(authorize.body.ok).toBe(true);

    // 同时存在：归属本项目的 pending（索引路径应优先）与未归属 pending（V1 桥接回退）
    seedStoreTask('p12-route-bound', projectId);
    seedStoreTask('p12-route-unbound', null);

    const claim1 = await api('POST', '/v2/tasks/claim', {
      project_id: projectId,
      agent_id: nodeId,
      claim_request_id: 'p12-cr-route-1',
    }, bearer(nodeCredential));
    expect(claim1.status).toBe(200);
    expect(claim1.body.ok).toBe(true);
    expect(claim1.body.data.attempt_id).toBeTruthy();
    expect(claim1.body.data.task_id).toBe('p12-route-bound'); // 索引路径优先

    // 归属任务领完后：回退到未归属 V1 任务，并回填 project_id
    const claim2 = await api('POST', '/v2/tasks/claim', {
      project_id: projectId,
      agent_id: nodeId,
      claim_request_id: 'p12-cr-route-2',
    }, bearer(nodeCredential));
    expect(claim2.body.ok).toBe(true);
    expect(claim2.body.data.task_id).toBe('p12-route-unbound');
    const bridged = store.getTask('p12-route-unbound')!;
    expect(bridged.project_id).toBe(projectId); // V1 桥接回填（旧行为保留）
    expect(bridged.status).toBe('running');
  }, 30_000);
});

/* ================================================================ */
/* 3. GET /v2/events/stream（Worker SSE 唤醒通道）                    */
/* ================================================================ */

describe('P12 车道 B：GET /v2/events/stream（bvn2 → task_ready）', () => {
  it('无凭据 / 无效凭据 → 401（JSON 信封，不开流）', async () => {
    const noAuth = await fetch(`${serverUrl}/v2/events/stream`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()).error.code).toBe('UNAUTHORIZED');

    const badAuth = await fetch(`${serverUrl}/v2/events/stream`, {
      headers: { Authorization: 'Bearer bvn2_not-a-real-token' },
    });
    expect(badAuth.status).toBe(401);
    expect((await badAuth.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('有效 bvn2 → text/event-stream + task_ready 推送 + last_id 续读', async () => {
    const nodeId = 'p12-laneb-sse-node1';
    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
    const nodeCredential = enroll.body.data.node_credential as string;

    // 历史事件（用于 last_id 续读断言）：先落一个哨兵，historic 的"已消费位"即它
    const sentinelId = await redis.xadd(keys.stream.tasks, '*', 'task_id', 'p12-sse-sentinel', 'priority', '5');
    const historicId = await redis.xadd(keys.stream.tasks, '*', 'task_id', 'p12-sse-historic', 'priority', '5');

    const res = await fetch(`${serverUrl}/v2/events/stream`, {
      headers: { Authorization: `Bearer ${nodeCredential}`, Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-biao-node-id')).toBe(nodeId);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 首块：retry 提示行（不推历史——缺省 '$' 只推连接后的新事件）
    const first = await reader.read();
    const firstBlock = decoder.decode(first.value ?? new Uint8Array());
    expect(firstBlock).toContain('retry:');

    // 新任务进入 pending（XADD 唤醒流）→ 2s 轮询窗口内收到 task_ready
    await redis.xadd(keys.stream.tasks, '*', 'task_id', 'p12-sse-live', 'priority', '3');
    let sawLive = false;
    const deadline = Date.now() + 8_000;
    while (!sawLive && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), wait(2_000).then(() => null)]);
      if (!chunk || !chunk.value) continue;
      const block = decoder.decode(chunk.value, { stream: true });
      if (block.includes('event: task_ready') && block.includes('p12-sse-live')) sawLive = true;
    }
    expect(sawLive, '连接后发布的新任务应在 8s 内收到 task_ready').toBe(true);
    await reader.cancel().catch(() => undefined);

    // last_id 续读：从历史 id 起连接 → 立即收到该历史事件（at-least-once 补齐）
    const replay = await fetch(`${serverUrl}/v2/events/stream?last_id=${sentinelId}`, {
      headers: { Authorization: `Bearer ${nodeCredential}` },
    });
    expect(replay.status).toBe(200);
    const replayReader = replay.body!.getReader();
    let sawHistoric = false;
    const replayDeadline = Date.now() + 6_000;
    while (!sawHistoric && Date.now() < replayDeadline) {
      const chunk = await Promise.race([replayReader.read(), wait(2_000).then(() => null)]);
      if (!chunk || !chunk.value) continue;
      const block = decoder.decode(chunk.value, { stream: true });
      if (block.includes('p12-sse-historic')) sawHistoric = true;
    }
    await replayReader.cancel().catch(() => undefined);
    expect(sawHistoric, 'last_id 指定历史游标时应回放该事件').toBe(true);
  }, 30_000);

  it('旗关 → 404（V2 面整体关闭语义）', async () => {
    // 独立 Fastify 实例注入全关旗（不动全局 env）
    const { registerV2WorkerEventStream } = await import('../../src/server/v2/attempt-service.js');
    const Fastify = (await import('fastify')).default;
    const flagsOffApp = Fastify();
    registerV2WorkerEventStream(flagsOffApp, {
      store,
      redis,
      featureFlags: {
        DISTRIBUTED_MODE: false, ARTIFACTS: false, NODE_RUNTIME: false, GIT_DELIVERY: false, MERGE_QUEUE: false,
      },
    });
    const res = await flagsOffApp.inject({ method: 'GET', url: '/v2/events/stream' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('V2_DISABLED');
    const flagOff = await flagsOffApp.inject({
      method: 'GET', url: '/v2/events/stream', headers: { authorization: 'Bearer whatever' },
    });
    // DISTRIBUTED_MODE 关：无论凭据如何，一律 V2_DISABLED（与 v2-routes 同语义）
    expect(flagOff.json().error.code).toBe('V2_DISABLED');
    await flagsOffApp.close();
  });
});

/* ================================================================ */
/* 4. NodeApiClient.streamEvents（daemon 侧 SSE 客户端）             */
/* ================================================================ */

describe('P12 车道 B：NodeApiClient.streamEvents 解析', () => {
  it('增量解析 event/data（JSON）/忽略注释行/lastId 透传/close → done', async () => {
    const encoder = new TextEncoder();
    const events: WorkerStreamEvent[] = [];
    let requestUrl = '';
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('retry: 1000\n\n'));
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
        controller.enqueue(encoder.encode(`event: task_ready\nid: 1-1\ndata: {"type":"task_ready","task_id":"t-1","priority":"5"}\n\n`));
        // 分块边界：一条事件被拆成两次 enqueue（增量解析必须正确拼接）
        controller.enqueue(encoder.encode('event: task_ready\nid: 1-2\ndata: {"type":"task_ready","task'));
        controller.enqueue(encoder.encode('_id":"t-2"}\n\n'));
        // 服务端结束流 → done 应随之 resolve（daemon 侧据此走重连）
        controller.close();
      },
    });
    const client = new NodeApiClient({
      baseUrl: serverUrl,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        void init;
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const handle = client.streamEvents({
      lastId: '0-9',
      onEvent: (event) => events.push(event),
    });
    await handle.done;
    expect(requestUrl).toContain('/v2/events/stream?last_id=0-9');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('task_ready');
    expect(events[0].data.task_id).toBe('t-1');
    expect(events[0].id).toBe('1-1');
    expect(events[1].data.task_id).toBe('t-2'); // 跨 chunk 拼接成功
  });

  it('非 2xx → onOpen 不触发、done 结束（上层走重连/降级轮询）', async () => {
    let opened = false;
    const client = new NodeApiClient({
      baseUrl: serverUrl,
      fetchImpl: async () => new Response('no', { status: 404 }),
    });
    const handle = client.streamEvents({ onOpen: () => { opened = true; }, onEvent: () => {} });
    await handle.done;
    expect(opened).toBe(false);
  });
});

/* ================================================================ */
/* 5. daemon SSE 唤醒 → 立即 claim（轮询 fallback 保留）              */
/* ================================================================ */

describe('P12 车道 B：daemon SSE 唤醒集成', () => {
  it('task_ready → 立即 claim（claim_interval_ms=60s，证明唤醒驱动）', { timeout: 60_000 }, async () => {
    // 项目 + 节点 + 绑定 + 可 claim 任务（验证 wake 后真实领取）
    const created = await api('POST', '/v2/projects', {
      name: 'p12-laneb-wake', repo_path: await createBareRemote('wake'), default_branch: 'main', execution_mode: 'full',
    }, owner);
    expect(created.body.ok).toBe(true);
    const projectId = created.body.data.project_id as string;

    const nodeId = 'p12-laneb-wake-node1';
    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
    const nodeCredential = enroll.body.data.node_credential as string;

    const dir = makeTempDir('wake');
    const credentialFile = join(dir, 'node-credential.json');
    writeFileSync(credentialFile, JSON.stringify({
      node_id: nodeId, credential: nodeCredential, credential_generation: 1,
    }));
    chmodSync(credentialFile, 0o600);
    const configPath = join(dir, 'biao-node.config.json');
    writeFileSync(configPath, JSON.stringify({
      biao_url: serverUrl,
      node_id: nodeId,
      slots: 2,
      heartbeat_interval_ms: 1_000,
      watchdog_tick_ms: 200,
      claim_interval_ms: 60_000, // 轮询通道基本关闭：任何 claim 都只能来自 SSE 唤醒
      lease_renew_margin_ms: 30_000,
      lease_stop_window_ms: 15_000,
      drain_timeout_ms: 2_000,
      drain_timeout_action: 'cancel',
      requested_project_ids: [projectId],
      server_protocol_version: 2,
    }));
    const config = loadNodeConfig(configPath);
    const daemon = NodeDaemon.fromConfig(config, {
      node_id: nodeId,
      credential: nodeCredential,
      credential_generation: 1,
      biao_url: serverUrl,
      enrolled_at: Date.now(),
    }, { installSignalHandlers: false, env: { ...process.env } });
    const runPromise = daemon.run();
    try {
      // SSE 建连 + running
      await waitFor(() => daemon.getStatus().claim.sse.connected, 'daemon SSE 建连', 15_000);
      expect(daemon.getStatus().phase).toBe('running');
      // 启动首轮 tick 必有一次轮询 claim（lastServerClaimWall 从 0 起算）；
      // 记为基线，此后 60s 间隔内不再有轮询 claim。
      const baseline = await waitFor(() =>
        daemon.getStatus().claim.server_claim_attempts >= 1 ? daemon.getStatus().claim.server_claim_attempts : undefined,
      '启动首轮轮询 claim', 10_000);
      await wait(1_500);
      expect(daemon.getStatus().claim.server_claim_attempts).toBe(baseline);
      expect(daemon.getStatus().claim.sse.wakes).toBe(0);

      // 发布可 claim 任务 + task_ready 唤醒
      seedStoreTask('p12-wake-task', projectId);
      const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
      expect(authorize.body.ok).toBe(true);
      await redis.xadd(keys.stream.tasks, '*', 'task_id', 'p12-wake-task', 'priority', '5');

      const status = await waitFor(() => {
        const s = daemon.getStatus();
        return s.claim.sse.wakes >= 1 && s.claim.server_claim_attempts > baseline ? s : undefined;
      }, 'task_ready 唤醒 → 立即 claim', 10_000);
      expect(status.claim.sse.events).toBeGreaterThanOrEqual(1);
      // 唤醒领取成功：占槽 + attempt 采纳
      await waitFor(() => daemon.getStatus().slots.in_use === 1, '唤醒 claim 领到任务并采纳', 10_000);
      expect(store.getTask('p12-wake-task')?.status).toBe('running');
    } finally {
      daemon.requestDrain('p12 测试收口', 1_000, 'cancel');
      await runPromise;
    }
  }, 90_000);
});

/* ================================================================ */
/* 6. BIAO_EXEC_CMD env → RealExecutor 执行命令模板                   */
/* ================================================================ */

describe('P12 车道 B：BIAO_EXEC_CMD env', () => {
  it('env 注入 execCommand；显式 realExecutorOptions 优先', async () => {
    const nodeId = 'p12-laneb-exec-node1';
    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: ENROLLMENT_TICKET, node_id: nodeId }, owner);
    const nodeCredential = enroll.body.data.node_credential as string;
    const dir = makeTempDir('exec');
    const configPath = join(dir, 'biao-node.config.json');
    writeFileSync(configPath, JSON.stringify({
      biao_url: serverUrl, node_id: nodeId, slots: 1,
      heartbeat_interval_ms: 5_000, watchdog_tick_ms: 500, claim_interval_ms: 5_000,
      lease_renew_margin_ms: 30_000, lease_stop_window_ms: 15_000,
      drain_timeout_ms: 2_000, drain_timeout_action: 'cancel',
      requested_project_ids: [], server_protocol_version: 2,
    }));
    const config = loadNodeConfig(configPath);
    const stored = {
      node_id: nodeId, credential: nodeCredential, credential_generation: 1,
      biao_url: serverUrl, enrolled_at: Date.now(),
    };

    // 仅 env：真执行器启用且命令来自 env
    const envDaemon = NodeDaemon.fromConfig(config, stored, { env: { BIAO_EXEC_CMD: 'claude -p "$(cat ${goal_md_file})"' } });
    const envExecutor = (envDaemon as unknown as { realExecutor: { execCommand: string } | null }).realExecutor;
    expect(envExecutor).not.toBeNull();
    expect(envExecutor!.execCommand).toBe('claude -p "$(cat ${goal_md_file})"');

    // env + 显式选项：选项优先
    const optDaemon = NodeDaemon.fromConfig(config, stored, {
      env: { BIAO_EXEC_CMD: 'from-env' },
      realExecutorOptions: { execCommand: 'from-options' },
    });
    const optExecutor = (optDaemon as unknown as { realExecutor: { execCommand: string } | null }).realExecutor;
    expect(optExecutor!.execCommand).toBe('from-options');

    // 都没有：真执行器不启用（保持 Phase 8 语义）
    const noneDaemon = NodeDaemon.fromConfig(config, stored, { env: {} });
    expect((noneDaemon as unknown as { realExecutor: unknown }).realExecutor).toBeNull();
    expect(existsSync(configPath)).toBe(true);
  });
});
