import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';
import {
  agentRegister,
  claim,
  getTask,
  setSqliteStore,
  taskBlock,
} from '../src/server/service.js';
import * as service from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT_PATH = '/tmp/biao-runtime-reconciliation';

let redis: Redis;

async function seedPlan(planId = 'runtime-reconciliation-plan'): Promise<void> {
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: planId,
    project_path: PROJECT_PATH,
    default_assignee: 'auto',
    default_priority: 5,
    phases: [{ id: 'impl', name: '实现' }],
  }, 0);
}

async function seedTask(
  taskId: string,
  overrides: Record<string, unknown> = {},
  planId = 'runtime-reconciliation-plan',
): Promise<void> {
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    timeout_seconds: 60,
    verify: [],
    ...overrides,
  } as never, `# ${taskId}`, planId, PROJECT_PATH, 5);
}

async function eventCount(taskId: string, type: string): Promise<number> {
  const entries = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return entries.map(([, fields]) => Object.fromEntries(
    Array.from({ length: Math.floor(fields.length / 2) }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
  )).filter((event) => event.task_id === taskId && event.type === type).length;
}

function serverConfig(): BiaoConfig {
  return {
    port: 7331,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: true,
    apiToken: 'runtime-reconciliation-secret',
    workspaceRoots: ['/tmp'],
    sqlitePath: '/tmp/biao-runtime-reconciliation.sqlite',
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
  await seedPlan();
});

afterAll(() => redis.disconnect());

describe('task block 写入前的条件重验', () => {
  it('依赖已经 accepted 时直接释放旧 claim 回 pending，不留下永久 waiting_dependency', async () => {
    await seedTask('dependency-source');
    await seedTask('dependency-waiter', { depends_on: ['dependency-source'] });
    await redis.zrem(keys.zset.status.pending, 'dependency-source');
    await redis.zadd(keys.zset.status.done, Date.now(), 'dependency-source');
    await redis.hset(keys.hash.task('dependency-source'), {
      status: 'done',
      pm_review_status: 'accepted',
    });
    await agentRegister(redis, 'dependency-worker', 'test', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'dependency-worker',
      blocking: false,
      preferred_project: PROJECT_PATH,
    });
    expect(claimed.data?.task_id).toBe('dependency-waiter');

    const blocked = await taskBlock(redis, 'dependency-waiter', 'dependency-worker', {
      claim_token: claimed.data!.claim_token,
      reason: 'waiting_dependency',
    });

    expect(blocked).toMatchObject({ ok: true, data: { task_id: 'dependency-waiter', blocked: false } });
    expect((await getTask(redis, 'dependency-waiter')).data).toMatchObject({ status: 'pending' });
    expect(await redis.hmget(keys.hash.task('dependency-waiter'), 'claimed_by', 'block_reason')).toEqual(['', '']);
    expect(await redis.get(keys.string.lease('dependency-waiter'))).toBeNull();
    expect(await eventCount('dependency-waiter', 'dependency_ready')).toBe(1);
  });

  it('没有其他活跃 owner 时直接释放自己的 ownership 回 pending，不留下 waiting_file_release', async () => {
    await seedTask('file-waiter', { ownership: { files: ['src/runtime-shared/**'] } });
    await agentRegister(redis, 'file-worker', 'test', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'file-worker',
      blocking: false,
      preferred_project: PROJECT_PATH,
    });
    expect(claimed.data?.task_id).toBe('file-waiter');
    expect(await redis.hget(keys.hash.fileOwnership, 'src/runtime-shared/**')).not.toBeNull();

    const blocked = await taskBlock(redis, 'file-waiter', 'file-worker', {
      claim_token: claimed.data!.claim_token,
      reason: 'waiting_file_release',
    });

    expect(blocked).toMatchObject({ ok: true, data: { task_id: 'file-waiter', blocked: false } });
    expect((await getTask(redis, 'file-waiter')).data).toMatchObject({ status: 'pending' });
    expect(await redis.hget(keys.hash.fileOwnership, 'src/runtime-shared/**')).toBeNull();
    expect(await eventCount('file-waiter', 'task_ready')).toBe(1);
  });
});

describe('低频 runtime reconciliation', () => {
  it('无需后续业务 claim 即可回收死 Worker，重复调用仍只写一次 task_ready', async () => {
    await seedTask('dead-worker-task');
    await agentRegister(redis, 'dead-worker', 'test', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'dead-worker',
      blocking: false,
      preferred_project: PROJECT_PATH,
    });
    expect(claimed.data?.task_id).toBe('dead-worker-task');
    await redis.del(keys.string.lease('dead-worker-task'));
    await redis.zadd(keys.zset.status.running, 1, 'dead-worker-task');

    const reconcileRuntimeState = (service as unknown as {
      reconcileRuntimeState?: (client: Redis) => Promise<{
        ok: boolean;
        data: { reclaimed: string[]; failed: string[] };
      }>;
    }).reconcileRuntimeState;
    expect(reconcileRuntimeState).toBeTypeOf('function');

    const first = await reconcileRuntimeState!(redis);
    const second = await reconcileRuntimeState!(redis);

    expect(first).toMatchObject({ ok: true, data: { reclaimed: ['dead-worker-task'], failed: [] } });
    expect(second).toMatchObject({ ok: true, data: { reclaimed: [], failed: [] } });
    expect((await getTask(redis, 'dead-worker-task')).data).toMatchObject({ status: 'pending', retries: 1 });
    expect(await redis.hmget(keys.hash.task('dead-worker-task'), 'claimed_by', 'expire_at')).toEqual(['', '']);
    expect(await eventCount('dead-worker-task', 'task_ready')).toBe(1);
  });

  it('依赖就绪事件曾丢失时恢复 waiting_dependency，重复调用仍只写一次 dependency_ready', async () => {
    await seedTask('recovered-dependency');
    await seedTask('dependency-blocked', { depends_on: ['recovered-dependency'] });
    await redis.zrem(keys.zset.status.pending, 'dependency-blocked');
    await redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'dependency-blocked');
    await redis.hset(keys.hash.task('dependency-blocked'), {
      status: 'running',
      claimed_by: 'dependency-blocked-worker',
      claimed_at: String(Date.now()),
      expire_at: String(Date.now() + 60_000),
    });
    await redis.set(keys.string.lease('dependency-blocked'), 'dependency-blocked-token', 'EX', 60);
    await agentRegister(redis, 'dependency-blocked-worker', 'test', ['code']);
    await redis.hset(keys.hash.agent('dependency-blocked-worker'), {
      status: 'busy',
      current_task: 'dependency-blocked',
    });
    expect(await taskBlock(redis, 'dependency-blocked', 'dependency-blocked-worker', {
      claim_token: 'dependency-blocked-token',
      reason: 'waiting_dependency',
    })).toMatchObject({ ok: true, data: { blocked: true } });

    // 模拟服务重启/旧事件丢失：状态真相已经 accepted，但没有调用会即时唤醒下游的 pmReview。
    await redis.zrem(keys.zset.status.pending, 'recovered-dependency');
    await redis.zadd(keys.zset.status.done, Date.now(), 'recovered-dependency');
    await redis.hset(keys.hash.task('recovered-dependency'), {
      status: 'done',
      pm_review_status: 'accepted',
    });

    const first = await service.reconcileRuntimeState(redis);
    const second = await service.reconcileRuntimeState(redis);

    expect(first.data?.requeued.waiting_dependency).toEqual(['dependency-blocked']);
    expect(second.data?.requeued.waiting_dependency).toEqual([]);
    expect((await getTask(redis, 'dependency-blocked')).data).toMatchObject({ status: 'pending' });
    expect(await eventCount('dependency-blocked', 'dependency_ready')).toBe(1);
  });

  it('死 Worker 释放文件后恢复 waiting_file_release，重复调用仍只写一次 waiter 门铃', async () => {
    const glob = 'src/dead-owner/**';
    await seedTask('dead-file-owner', {
      assignee: 'dead-file-owner-agent',
      priority: 9,
      ownership: { files: [glob] },
    });
    await seedTask('dead-file-waiter', {
      assignee: 'dead-file-waiter-agent',
      priority: 5,
      ownership: { files: [glob] },
    });
    await agentRegister(redis, 'dead-file-waiter-agent', 'test', ['code']);
    const waiter = await claim(redis, {
      agent_id: 'dead-file-waiter-agent', blocking: false, preferred_project: PROJECT_PATH,
    });
    expect(waiter.data?.task_id).toBe('dead-file-waiter');
    await agentRegister(redis, 'dead-file-owner-agent', 'test', ['code']);
    const owner = await claim(redis, {
      agent_id: 'dead-file-owner-agent', blocking: false, preferred_project: PROJECT_PATH,
    });
    expect(owner.data?.task_id).toBe('dead-file-owner');
    expect(await taskBlock(redis, 'dead-file-waiter', 'dead-file-waiter-agent', {
      claim_token: waiter.data!.claim_token,
      reason: 'waiting_file_release',
    })).toMatchObject({ ok: true, data: { blocked: true } });

    await redis.del(keys.string.lease('dead-file-owner'));
    await redis.zadd(keys.zset.status.running, 1, 'dead-file-owner');
    const first = await service.reconcileRuntimeState(redis);
    const second = await service.reconcileRuntimeState(redis);

    expect(first.data).toMatchObject({
      reclaimed: ['dead-file-owner'],
      requeued: { waiting_file_release: ['dead-file-waiter'] },
    });
    expect(second.data).toMatchObject({
      reclaimed: [],
      requeued: { waiting_file_release: [] },
    });
    expect((await getTask(redis, 'dead-file-owner')).data).toMatchObject({ status: 'pending', retries: 1 });
    expect((await getTask(redis, 'dead-file-waiter')).data).toMatchObject({ status: 'pending' });
    expect(await eventCount('dead-file-owner', 'task_ready')).toBe(1);
    expect(await eventCount('dead-file-waiter', 'task_ready')).toBe(1);
  });

  it('永远不恢复 waiting_pm_reply，也不伪造 Worker 就绪事件', async () => {
    await seedTask('pm-question-task');
    await redis.zrem(keys.zset.status.pending, 'pm-question-task');
    await redis.zadd(keys.zset.status.blocked, Date.now(), 'pm-question-task');
    await redis.hset(keys.hash.task('pm-question-task'), {
      status: 'blocked',
      block_reason: 'waiting_pm_reply',
      blocked_at: String(Date.now()),
      blocked_question_id: 'question-still-open',
    });

    const first = await service.reconcileRuntimeState(redis);
    const second = await service.reconcileRuntimeState(redis);

    expect(first.data?.requeued).toEqual({ waiting_file_release: [], waiting_dependency: [] });
    expect(second.data?.requeued).toEqual({ waiting_file_release: [], waiting_dependency: [] });
    expect((await getTask(redis, 'pm-question-task')).data).toMatchObject({
      status: 'blocked',
      block_reason: 'waiting_pm_reply',
    });
    expect(await redis.hget(keys.hash.task('pm-question-task'), 'blocked_question_id')).toBe('question-still-open');
    expect(await eventCount('pm-question-task', 'task_ready')).toBe(0);
    expect(await eventCount('pm-question-task', 'dependency_ready')).toBe(0);
  });
});

describe('runtime reconciliation HTTP API', () => {
  it('受认证的低频调用无需业务 claim 即可执行一次 reconciliation', async () => {
    await seedTask('http-dead-worker-task');
    await agentRegister(redis, 'http-dead-worker', 'test', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'http-dead-worker', blocking: false, preferred_project: PROJECT_PATH,
    });
    expect(claimed.data?.task_id).toBe('http-dead-worker-task');
    await redis.del(keys.string.lease('http-dead-worker-task'));
    await redis.zadd(keys.zset.status.running, 1, 'http-dead-worker-task');
    const app = await createHttpServer(redis, serverConfig());

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/reconcile',
        headers: { authorization: 'Bearer runtime-reconciliation-secret' },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        data: { reclaimed: ['http-dead-worker-task'], failed: [] },
      });
      expect((await getTask(redis, 'http-dead-worker-task')).data).toMatchObject({ status: 'pending' });
    } finally {
      await app.close();
    }
  });
});
