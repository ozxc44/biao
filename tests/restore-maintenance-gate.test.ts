import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { createHttpServer } from '../src/server/http.js';
import { startServer } from '../src/server/main.js';
import { keys } from '../src/redis/keys.js';
import {
  acquireRestoreLock,
  acquireMutationPermit,
  activeLocalMutationCount,
  beginLocalMutation,
  agentRegister,
  claim,
  dbRestore,
  isBiaoNamespaceEmpty,
  reconcileResolutionBacklog,
  releaseRestoreLock,
  releaseMutationPermit,
  renewRestoreLock,
  runWatchdog,
  setSqliteStore,
} from '../src/server/service.js';
import type { BiaoConfig } from '../src/types/index.js';

const REDIS_URL = process.env.RESTORE_MAINTENANCE_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/14';
const TOKEN = 'restore-maintenance-test-token';
const WRITER_PERMITS_KEY = keys.zset.maintenanceMutationPermits;
const RESTORE_LOCK_KEY = keys.string.dbRestoreLock;
const RESTORE_BARRIER_KEY = keys.string.dbRestoreBarrier;
const PLAN_ID = 'restore-maintenance-plan';
const TASK_ID = 'restore-maintenance-task';

let redis: Redis;
let store: SqliteStore;
let tempDir = '';

function config(): BiaoConfig {
  return {
    port: 7331,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: true,
    apiToken: TOKEN,
    workspaceRoots: ['/tmp'],
    sqlitePath: join(tempDir, 'biao.sqlite'),
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

async function post(url: string, payload: Record<string, unknown> = {}) {
  const app = await createHttpServer(redis, config());
  try {
    return await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  tempDir = mkdtempSync(join(tmpdir(), 'biao-restore-maintenance-'));
  store = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(store);
});

function seedPersistedRunningTask(): void {
  store.upsertPlan({
    plan_id: PLAN_ID,
    title: '恢复维护计划',
    status: 'submitted',
    project_path: '/tmp/biao-restore-maintenance',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: '1700000000000',
    submitted_at: '1700000001000',
    pm_consumer: 'pm',
  });
  store.upsertTask({
    task_id: TASK_ID,
    plan_id: PLAN_ID,
    title: '崩溃中的任务',
    type: 'code',
    phase: 'impl',
    status: 'running',
    priority: 5,
    assignee: 'auto',
    ownership_files: 'src/**',
    ownership_modules: '',
    depends_on: '',
    timeout_seconds: 60,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '[]',
    claimed_by: 'crashed-worker',
    claimed_at: '1700000002000',
    expire_at: '1700000062000',
    result_path: '', result_json_path: '', done_at: '', retries: 0,
    pm_review_status: '', pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '',
    pm_reject_reason: '', pm_fix_instructions: '', pm_rejection_resolution_mode: '',
    repair_ownership_extension: '', failure_reason: '', fix_for: '', repair_root_task_id: '',
    resolution_status: '', resolution_action: '', resolution_task_id: '', resolution_task_ids: '',
    resolved_by_task: '', resolution_generation: 0, resolution_attempts: 0,
    resolution_decision_reason: '', blocked_at: '', block_reason: '', blocked_question_id: '',
    blocked_lease_remaining: '', last_question_id: 'old-question', last_question_answer: 'old-answer',
    cancelled_at: '', superseded_at: '', superseded_by: '', superseded_reason: '',
    supersede_preview_token: '', supersede_batch_size: 0, verify_results: '[]', goal_md: '# running',
    created_at: '1700000001000', updated_at: '1700000002000',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setSqliteStore(null);
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => redis.disconnect());

describe('database restore maintenance gate', () => {
  it('fails closed when an in-flight mutation permit entered first', async () => {
    await redis.zadd(WRITER_PERMITS_KEY, Date.now() + 60_000, 'writer-before-restore');

    const response = await post('/db/restore');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      data: null,
      error: {
        code: 'RESTORE_WRITERS_ACTIVE',
        message: 'Redis 当前有进行中的状态写入，拒绝数据库恢复',
      },
    });
  });

  it('rejects restore while this server process still has an unsettled writer even after Redis lost permits', async () => {
    const leaveLocalMutation = beginLocalMutation();
    try {
      await redis.flushdb();
      await expect(acquireRestoreLock(redis, 'restore-after-redis-loss')).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'RESTORE_WRITERS_ACTIVE',
          message: '当前 Biao 服务进程仍有未完成的状态写入，拒绝数据库恢复',
        },
      });
    } finally {
      leaveLocalMutation();
    }

    await expect(acquireRestoreLock(redis, 'restore-after-writer-settled')).resolves.toEqual({
      ok: true,
      owner: 'restore-after-writer-settled',
    });
    await releaseRestoreLock(redis, 'restore-after-writer-settled');
  });

  it('does not leak the local writer drain marker when permit acquisition throws', async () => {
    const directEvalFailure = vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('simulated permit Redis outage'));
    await expect(runWatchdog(redis, { autoFix: true })).rejects.toThrow('simulated permit Redis outage');
    expect(activeLocalMutationCount()).toBe(0);
    directEvalFailure.mockRestore();

    const app = await createHttpServer(redis, config());
    try {
      vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('simulated HTTP permit Redis outage'));
      const response = await app.inject({
        method: 'POST',
        url: '/reconcile',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(response.statusCode).toBe(500);
      expect(activeLocalMutationCount()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['/claim', { agent_id: 'worker-during-restore', blocking: false }],
    ['/report', { task_id: 'task-during-restore', agent_id: 'worker-during-restore', claim_token: 'token', status: 'failed' }],
    ['/reconcile', {}],
  ])('rejects mutation %s when restore entered first', async (url, payload) => {
    await redis.set(RESTORE_LOCK_KEY, 'restore-before-writer', 'PX', 60_000);

    const response = await post(url, payload);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      ok: false,
      data: null,
      error: {
        code: 'RESTORE_IN_PROGRESS',
        message: '数据库恢复进行中，暂不提供运行态投影',
      },
    });
  });

  it('rejects a direct resolution backlog reconciliation while restore owns the database', async () => {
    await redis.set(RESTORE_LOCK_KEY, 'restore-before-direct-reconcile', 'PX', 60_000);

    await expect(reconcileResolutionBacklog(redis)).rejects.toMatchObject({
      code: 'RESTORE_IN_PROGRESS',
      message: '数据库恢复进行中，暂不接受状态写入',
    });
  });

  it('rejects a direct watchdog auto-fix while restore owns the database', async () => {
    await redis.set(RESTORE_LOCK_KEY, 'restore-before-direct-watchdog', 'PX', 60_000);

    await expect(runWatchdog(redis, { autoFix: true })).resolves.toEqual({
      ok: false,
      data: null,
      error: {
        code: 'RESTORE_IN_PROGRESS',
        message: '数据库恢复进行中，暂不接受状态写入',
      },
    });
  });

  it.each(['/intake?consumer=pm', '/intake/unacked?consumer=pm', '/ownership?path=src%2Findex.ts&agent_id=worker']) (
    'rejects stateful PM projection read %s while restore owns the database',
    async (url) => {
      await redis.set(RESTORE_LOCK_KEY, 'restore-before-intake', 'PX', 60_000);
      const app = await createHttpServer(redis, config());
      try {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toEqual({
          code: 'RESTORE_IN_PROGRESS',
          message: '数据库恢复进行中，暂不提供运行态投影',
        });
      } finally {
        await app.close();
      }
    },
  );

  it.each(['/status', '/plans', '/tasks', '/events', '/intake?consumer=pm']) (
    'never exposes material projection read %s while a failed restore barrier exists',
    async (url) => {
      await redis.hset(keys.hash.plan('half-plan'), { plan_id: 'half-plan' });
      await redis.set(RESTORE_BARRIER_KEY, JSON.stringify({
        phase: 'failed', owner: 'failed-restore', error_code: 'RESTORE_REDIS_TRANSACTION_FAILED',
      }));
      const app = await createHttpServer(redis, config());
      try {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().error).toMatchObject({ code: 'RESTORE_FAILED' });
      } finally {
        await app.close();
      }
    },
  );

  it('reports maintenance not-ready on health while preserving db diagnostics', async () => {
    await redis.set(RESTORE_BARRIER_KEY, JSON.stringify({
      phase: 'failed', owner: 'failed-restore', error_code: 'RESTORE_REDIS_TRANSACTION_FAILED', message: '模拟失败',
    }));
    const app = await createHttpServer(redis, config());
    try {
      const headers = { authorization: `Bearer ${TOKEN}` };
      const health = await app.inject({ method: 'GET', url: '/health' });
      const status = await app.inject({ method: 'GET', url: '/db/status', headers });
      const version = await app.inject({ method: 'GET', url: '/version' });

      expect(health.statusCode).toBe(503);
      expect(health.json().error).toMatchObject({ code: 'RESTORE_FAILED' });
      expect(status.statusCode).toBe(200);
      expect(status.json().data.maintenance).toMatchObject({
        state: 'failed',
        barrier_phase: 'failed',
        barrier_error_code: 'RESTORE_REDIS_TRANSACTION_FAILED',
        barrier_message: '模拟失败',
      });
      expect(version.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('distinguishes a failed barrier from an active restore for new writers', async () => {
    await redis.set(RESTORE_BARRIER_KEY, JSON.stringify({ phase: 'failed', owner: 'failed-restore' }));

    await expect(acquireMutationPermit(redis, 'writer-after-failure')).resolves.toEqual({
      ok: false,
      error: {
        code: 'RESTORE_FAILED',
        message: '上一次数据库恢复失败或结果不确定，维护屏障仍然生效',
      },
    });
  });

  it.each([
    ['running task', async () => redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'active-running')],
    ['active lease', async () => redis.set(keys.string.lease('active-lease'), 'claim-token', 'PX', 60_000)],
    ['active ownership', async () => redis.hset(keys.hash.fileOwnership, 'src/**', JSON.stringify({
      agent_id: 'worker-owner', task_id: 'active-owner', priority: 5,
      declared_at: Date.now(), expires_at: Date.now() + 60_000, base_commit_sha: '',
    }))],
  ])('fails closed when Redis contains %s', async (_label, seedRuntimeState) => {
    await seedRuntimeState();

    const response = await post('/db/restore');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      ok: false,
      data: null,
      error: { code: 'RESTORE_ACTIVE_RUNTIME_STATE' },
    });
  });

  it('rejects a non-empty Biao namespace even when no runtime state is active', async () => {
    await redis.hset(keys.hash.plan('unrelated-plan'), { plan_id: 'unrelated-plan' });

    const response = await post('/db/restore');

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: 'RESTORE_TARGET_NOT_EMPTY',
      message: 'Redis 的 Biao namespace 非空，拒绝覆盖现有状态',
    });
  });

  it('treats unrelated Redis keys as outside the Biao recovery target namespace', async () => {
    await redis.set('unrelated:application:key', 'preserved');

    expect(await isBiaoNamespaceEmpty(redis)).toBe(true);
    await dbRestore(redis, store);

    expect(await redis.get('unrelated:application:key')).toBe('preserved');
  });

  it('recovers persisted running as fresh pending without a lease, owner, or old claim context', async () => {
    seedPersistedRunningTask();

    await dbRestore(redis, store);

    expect(await redis.hgetall(keys.hash.task(TASK_ID))).toMatchObject({
      status: 'pending',
      claimed_by: '',
      claimed_at: '',
      expire_at: '',
      blocked_at: '',
      block_reason: '',
      blocked_question_id: '',
      blocked_lease_remaining: '',
      last_question_id: 'old-question',
      last_question_answer: 'old-answer',
      failed_reason: 'recovered_from_persisted_running',
    });
    expect(await redis.zscore(keys.zset.status.running, TASK_ID)).toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, TASK_ID)).not.toBeNull();
    expect(await redis.get(keys.string.lease(TASK_ID))).toBeNull();
    expect(await redis.hlen(keys.hash.fileOwnership)).toBe(0);
    expect(store.getAllTasks().find((task) => task.task_id === TASK_ID)).toMatchObject({
      status: 'pending', claimed_by: '', claimed_at: '', expire_at: '',
      failure_reason: 'recovered_from_persisted_running',
      last_question_id: 'old-question', last_question_answer: 'old-answer',
    });

    await agentRegister(redis, 'fresh-worker', 'test', ['code']);
    const freshClaim = await claim(redis, {
      agent_id: 'fresh-worker',
      blocking: false,
      preferred_project: '/tmp/biao-restore-maintenance',
    });
    expect(freshClaim.data).toMatchObject({
      task_id: TASK_ID,
      question_id: 'old-question',
      question_answer: 'old-answer',
    });
  });

  it('returns a stable error and releases its own lock when restore throws', async () => {
    store.getAllTasks = () => [{ task_id: 'invalid-status', status: 'mystery' }] as never;

    const response = await post('/db/restore');

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      ok: false,
      data: null,
      error: { code: 'SQLITE_TASK_STATUS_INVALID' },
    });
    expect(await redis.get(RESTORE_LOCK_KEY)).toBeNull();
  });

  it('publishes no material Redis keys when the atomic restore commit fails', async () => {
    seedPersistedRunningTask();
    const originalDuplicate = redis.duplicate.bind(redis);
    redis.duplicate = ((...args: Parameters<Redis['duplicate']>) => {
      const transactionRedis = originalDuplicate(...args);
      const originalMulti = transactionRedis.multi.bind(transactionRedis);
      transactionRedis.multi = ((...multiArgs: Parameters<typeof transactionRedis.multi>) => {
        const transaction = originalMulti(...multiArgs);
        transaction.exec = async () => {
          throw new Error('simulated atomic restore commit outage');
        };
        return transaction;
      }) as typeof transactionRedis.multi;
      return transactionRedis;
    }) as typeof redis.duplicate;

    try {
      await expect(dbRestore(redis, store)).rejects.toThrow('simulated atomic restore commit outage');
    } finally {
      redis.duplicate = originalDuplicate as typeof redis.duplicate;
    }

    expect(await isBiaoNamespaceEmpty(redis)).toBe(true);
    expect(store.getAllTasks().find((task) => task.task_id === TASK_ID)).toMatchObject({
      status: 'pending',
      failure_reason: 'recovered_from_persisted_running',
      last_question_id: 'old-question',
      last_question_answer: 'old-answer',
    });
  });

  it('fails closed before Redis writes when SQLite has multiple open Questions for one task', async () => {
    seedPersistedRunningTask();
    store.updateTaskFields(TASK_ID, {
      status: 'blocked',
      claimed_by: '',
      claimed_at: '',
      expire_at: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: 'duplicate-open-a',
      blocked_at: '1700000003000',
      blocked_lease_remaining: '30',
    });
    for (const suffix of ['a', 'b']) {
      store.upsertQuestion({
        question_id: `duplicate-open-${suffix}`,
        task_id: TASK_ID,
        plan_id: PLAN_ID,
        agent_id: 'crashed-worker',
        pm_consumer: 'pm',
        body: `问题 ${suffix}`,
        checkpoint: `checkpoint=${suffix}`,
        status: 'open',
        created_at: `170000000300${suffix === 'a' ? '0' : '1'}`,
        answered_at: '',
        answered_by: '',
        answer: '',
      });
    }

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'SQLITE_OPEN_QUESTION_CONFLICT' });
    expect(await isBiaoNamespaceEmpty(redis)).toBe(true);
  });

  it('fails closed when a task waits for PM but has no matching open Question', async () => {
    seedPersistedRunningTask();
    store.updateTaskFields(TASK_ID, {
      status: 'blocked',
      claimed_by: '',
      claimed_at: '',
      expire_at: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: 'missing-question',
    });

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'SQLITE_OPEN_QUESTION_STATE_INVALID' });
    expect(await isBiaoNamespaceEmpty(redis)).toBe(true);
  });

  it('fails before Redis publication when a pending score is not finite', async () => {
    seedPersistedRunningTask();
    store.updateTaskFields(TASK_ID, { priority: Number.MAX_VALUE });

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'SQLITE_TASK_SCORE_INVALID' });
    expect(await isBiaoNamespaceEmpty(redis)).toBe(true);
    expect(await redis.get(RESTORE_BARRIER_KEY)).toBeNull();
  });

  it('uses Redis server time for permit expiry even when the process clock is skewed', async () => {
    const [seconds, microseconds] = await redis.time();
    const redisNow = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
    vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000_000);

    const permit = await acquireMutationPermit(redis, 'clock-skewed-writer');

    expect(permit).toEqual({ ok: true, owner: 'clock-skewed-writer' });
    expect(Number(await redis.zscore(WRITER_PERMITS_KEY, 'clock-skewed-writer'))).toBeLessThanOrEqual(redisNow + 121_000);
    await releaseMutationPermit(redis, 'clock-skewed-writer');
    vi.restoreAllMocks();
  });

  it('only the current restore owner can renew or release the lock', async () => {
    const acquired = await acquireRestoreLock(redis, 'original-restore-owner');
    expect(acquired).toEqual({ ok: true, owner: 'original-restore-owner' });
    await redis.set(RESTORE_LOCK_KEY, 'new-restore-owner', 'PX', 60_000);

    expect(await renewRestoreLock(redis, 'original-restore-owner')).toBe(false);
    await releaseRestoreLock(redis, 'original-restore-owner');

    expect(await redis.get(RESTORE_LOCK_KEY)).toBe('new-restore-owner');
  });

  it('stops before the next persisted record when restore ownership is lost', async () => {
    for (const planId of ['lease-loss-plan-a', 'lease-loss-plan-b']) {
      store.upsertPlan({
        plan_id: planId,
        title: planId,
        status: 'submitted',
        project_path: '/tmp/biao-restore-maintenance',
        default_assignee: 'auto',
        default_priority: 5,
        phases: '[]',
        task_count: 0,
        created_at: '1700000000000',
        submitted_at: '1700000001000',
        pm_consumer: 'pm',
      });
    }

    const originalDuplicate = redis.duplicate.bind(redis);
    redis.duplicate = ((...args: Parameters<Redis['duplicate']>) => {
      const transactionRedis = originalDuplicate(...args);
      const originalGet = transactionRedis.get.bind(transactionRedis);
      transactionRedis.get = (async (key: string) => {
        const observedOwner = await originalGet(key);
        if (key === RESTORE_LOCK_KEY) {
          await redis.set(RESTORE_LOCK_KEY, 'replacement-restore-owner', 'PX', 60_000);
        }
        return observedOwner;
      }) as typeof transactionRedis.get;
      return transactionRedis;
    }) as typeof redis.duplicate;

    try {
      await expect(dbRestore(redis, store)).rejects.toMatchObject({
        code: 'RESTORE_LEASE_LOST',
        message: '数据库恢复锁已失效，恢复已中止',
      });
    } finally {
      redis.duplicate = originalDuplicate as typeof redis.duplicate;
    }

    const restoredPlanKeys = await redis.keys('biao:v1:hash:plan:lease-loss-plan-*');
    expect(restoredPlanKeys).toHaveLength(0);
    expect(await redis.get(RESTORE_LOCK_KEY)).toBe('replacement-restore-owner');
  });

  it('does not infer that an expired permit means its old writer has stopped', async () => {
    await redis.zadd(WRITER_PERMITS_KEY, Date.now() - 1, 'crashed-writer');

    const acquired = await acquireRestoreLock(redis, 'restore-after-crash');

    expect(acquired).toMatchObject({ ok: false, error: { code: 'RESTORE_WRITERS_ACTIVE' } });
    expect(await redis.zcard(WRITER_PERMITS_KEY)).toBe(1);
  });

  it('does not open the HTTP service when automatic restore validation fails', async () => {
    const startupDir = mkdtempSync(join(tmpdir(), 'biao-startup-restore-failure-'));
    const startupPath = join(startupDir, 'biao.sqlite');
    const startupStore = new SqliteStore(startupPath);
    seedPersistedRunningTask();
    startupStore.upsertPlan(store.getAllPlans()[0]);
    startupStore.upsertTask({ ...store.getAllTasks()[0], status: 'mystery' });
    startupStore.close();

    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    let startupError: unknown;
    try {
      started = await startServer({
        port: 0,
        redisUrl: REDIS_URL,
        sqlitePath: startupPath,
        host: '127.0.0.1',
      });
    } catch (error) {
      startupError = error;
    } finally {
      if (started) await started.close();
      rmSync(startupDir, { recursive: true, force: true });
    }

    expect(startupError).toMatchObject({ code: 'SQLITE_TASK_STATUS_INVALID' });
  });
});
