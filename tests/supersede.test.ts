import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPlan,
  getTask,
  dbRestore,
  pmReview,
  previewPlanSupersede,
  resolutionDecision,
  setSqliteStore,
  supersedePlan,
  supersedeTask,
  taskReset,
  unackedEvents,
} from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';
import { SqliteStore } from '../src/db/sqlite-store.js';

const REDIS_URL = process.env.SUPERSEDE_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/11';
const PROJECT = '/tmp/biao-supersede-project';

let redis: Redis;
let app: Awaited<ReturnType<typeof createHttpServer>>;

async function seedPlan(planId = 'legacy-plan'): Promise<void> {
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: planId,
    project_path: PROJECT,
    pm_consumer: 'pm-legacy',
    default_priority: 5,
  }, 0);
}

async function seedTask(taskId: string, overrides: Record<string, unknown> = {}, planId = 'legacy-plan'): Promise<void> {
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
  } as never, `# ${taskId}`, planId, PROJECT, 5);
}

async function markDonePendingReview(taskId: string, doneAt = Date.now()): Promise<string> {
  const eventId = `${doneAt}_review_${taskId}`;
  await redis.zrem(keys.zset.status.pending, taskId);
  await redis.zadd(keys.zset.status.done, doneAt, taskId);
  await redis.hset(keys.hash.task(taskId), {
    status: 'done',
    done_at: String(doneAt),
    claimed_by: 'legacy-worker',
    result_path: `${PROJECT}/work/${taskId}/result.md`,
    result_json_path: `${PROJECT}/work/${taskId}/result.json`,
    verify_results: JSON.stringify([{ cmd: 'npm test', exit_code: 0, passed: true }]),
  });
  await redis.zadd(keys.reviewRequested.pending, doneAt, taskId);
  await redis.sadd(keys.reviewRequested.fired, taskId);
  await redis.hset(keys.reviewRequested.eventByTask, taskId, eventId);
  await redis.xadd(
    keys.stream.events,
    '*',
    'event_id', eventId,
    'type', 'review_requested',
    'task_id', taskId,
    'plan_id', 'legacy-plan',
    'consumer', 'pm-legacy',
    'timestamp', String(doneAt),
  );
  return eventId;
}

async function eventTypes(taskId: string): Promise<string[]> {
  const rows = await redis.xrange(keys.stream.events, '-', '+') as [string, string[]][];
  return rows.flatMap(([, fields]) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 2) record[fields[index]] = fields[index + 1];
    return record.task_id === taskId ? [record.type] : [];
  });
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  const config: BiaoConfig = {
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: ['/tmp'],
    sqlitePath: '/tmp/biao-supersede-unused.sqlite',
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
  app = await createHttpServer(redis, config);
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
  await seedPlan();
});

afterAll(async () => {
  await app.close();
  await redis.flushdb();
  redis.disconnect();
  setSqliteStore(null);
});

describe('历史 done + pending review 安全 supersede', () => {
  it.each([
    ['pmReview', (taskId: string) => pmReview(redis, taskId, { verdict: 'accept', reviewed_by: 'pm-cleanup' })],
    ['taskReset', (taskId: string) => taskReset(redis, taskId, { force: true, reset_by: 'pm-cleanup' })],
    ['supersedeTask', (taskId: string) => supersedeTask(redis, taskId, {
      reason: 'cleanup fault', superseded_by: 'pm-cleanup', confirmed: true,
    })],
    ['resolutionDecision', (taskId: string) => resolutionDecision(redis, taskId, {
      action: 'cancel', decided_by: 'pm-cleanup',
    })],
  ])('%s 的 cleanup 失败不覆盖原业务错误返回', async (_name, invoke) => {
    const taskId = `missing-cleanup-${_name}`;
    if (_name === 'resolutionDecision') await seedTask(taskId);
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let cleanupFailed = false;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!cleanupFailed && command?.name?.toLowerCase() === 'eval' &&
          script.includes('release-pm-review-lock-v1')) {
        cleanupFailed = true;
        return Promise.reject(new Error(`simulated ${_name} cleanup failure`));
      }
      return original.call(this, command, ...args);
    };
    try {
      await expect(invoke(taskId)).resolves.toMatchObject({
        ok: false,
        error: { code: _name === 'resolutionDecision' ? 'RESOLUTION_DECISION_NOT_PENDING' : 'TASK_NOT_FOUND' },
      });
      expect(cleanupFailed).toBe(true);
    } finally {
      client.sendCommand = original;
      console.error = originalConsoleError;
      await redis.del(keys.string.pmReviewLock(taskId));
    }
  });

  it('单任务业务异常与 cleanup 同时失败时保留原异常', async () => {
    const taskId = 'single-primary-cleanup-failure';
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const originalCommand = client.sendCommand;
    const originalHgetall = redis.hgetall.bind(redis);
    const originalConsoleError = console.error;
    let cleanupFailed = false;
    console.error = () => undefined;
    redis.hgetall = (async (key: string) => {
      if (key === keys.hash.task(taskId)) throw new Error('simulated single primary failure');
      return originalHgetall(key);
    }) as typeof redis.hgetall;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!cleanupFailed && command?.name?.toLowerCase() === 'eval' &&
          script.includes('release-pm-review-lock-v1')) {
        cleanupFailed = true;
        return Promise.reject(new Error('simulated single cleanup failure'));
      }
      return originalCommand.call(this, command, ...args);
    };
    try {
      await expect(taskReset(redis, taskId, { force: true, reset_by: 'pm-cleanup' }))
        .rejects.toThrow('simulated single primary failure');
      expect(cleanupFailed).toBe(true);
    } finally {
      redis.hgetall = originalHgetall as typeof redis.hgetall;
      client.sendCommand = originalCommand;
      console.error = originalConsoleError;
      await redis.del(keys.string.pmReviewLock(taskId));
    }
  });

  it('单任务业务成功但 cleanup 失败时明确暴露 cleanup 故障', async () => {
    const taskId = 'single-success-cleanup-failure';
    await seedTask(taskId);
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let cleanupFailed = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!cleanupFailed && command?.name?.toLowerCase() === 'eval' &&
          script.includes('release-pm-review-lock-v1')) {
        cleanupFailed = true;
        return Promise.reject(new Error('simulated successful cleanup failure'));
      }
      return original.call(this, command, ...args);
    };
    try {
      await expect(taskReset(redis, taskId, { reset_by: 'pm-cleanup' }))
        .rejects.toThrow('PM decision lock cleanup failed');
      expect(cleanupFailed).toBe(true);
      expect(await redis.hget(keys.hash.task(taskId), 'status')).toBe('pending');
    } finally {
      client.sendCommand = original;
      await redis.del(keys.string.pmReviewLock(taskId));
    }
  });

  it('锁过期后旧 supersede 不能覆盖后来已提交的 PM review', async () => {
    const taskId = 'supersede-expired-lock-race';
    await seedTask(taskId);
    await markDonePendingReview(taskId, 91_000);
    const contender = redis.duplicate();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let held = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!held && command?.name?.toLowerCase() === 'eval' && script.includes('commit-supersede-round-fenced-v1')) {
        held = true;
        entered();
        return releasePromise.then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      const staleSupersede = supersedeTask(redis, taskId, {
        reason: '旧请求不应覆盖新验收', superseded_by: 'pm-old', confirmed: true,
      });
      await enteredPromise;
      await contender.pexpire(keys.string.pmReviewLock(taskId), 5);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const newReview = await pmReview(contender, taskId, {
        verdict: 'reject', reviewed_by: 'pm-new', reject_reason: '新 PM 已判定需修复', fix_instructions: '补齐有效产物',
      });
      expect(newReview).toMatchObject({
        ok: true, data: { review_status: 'rejected' },
      });
      release();
      expect(await staleSupersede).toMatchObject({
        ok: false, error: { code: 'TASK_SUPERSEDE_ROUND_CHANGED' },
      });
      expect(await contender.hgetall(keys.hash.task(taskId))).toMatchObject({
        status: 'done', pm_review_status: 'rejected', pm_reviewed_by: 'pm-new',
      });
      expect(await contender.zscore(keys.zset.status.superseded, taskId)).toBeNull();
    } finally {
      client.sendCommand = original;
      release?.();
      contender.disconnect();
    }
  });

  it('HTTP 边界拒绝缺少确认或额外字段，并暴露 task/plan 显式路由', async () => {
    await seedTask('http-legacy');
    await markDonePendingReview('http-legacy');

    const malformed = await app.inject({
      method: 'POST',
      url: '/task/http-legacy/supersede',
      payload: { reason: '历史伪完成', superseded_by: 'pm', confirmed: true, force: true },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const preview = await app.inject({ method: 'GET', url: '/plan/legacy-plan/supersede-preview' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ ok: true, data: { candidate_task_ids: ['http-legacy'] } });

    const applied = await app.inject({
      method: 'POST',
      url: '/task/http-legacy/supersede',
      payload: { reason: '历史伪完成', superseded_by: 'pm', confirmed: true },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ ok: true, data: { status: 'superseded' } });
  });

  it('保留原结果并撤下待验收门铃，写入不可变 supersede 审计', async () => {
    await seedTask('legacy-fake-done');
    const eventId = await markDonePendingReview('legacy-fake-done', 1_723_456_789_000);
    const before = await redis.hgetall(keys.hash.task('legacy-fake-done'));
    expect((await unackedEvents(redis, { consumer: 'pm-legacy' })).data).toEqual([
      expect.objectContaining({ event_id: eventId, type: 'review_requested', task_id: 'legacy-fake-done' }),
    ]);

    const result = await supersedeTask(redis, 'legacy-fake-done', {
      reason: '旧版本误把占位记录标成 done，且没有可验收证据',
      superseded_by: 'pm-migration',
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: true, data: { task_id: 'legacy-fake-done', status: 'superseded' } });
    const after = await redis.hgetall(keys.hash.task('legacy-fake-done'));
    expect(after).toMatchObject({
      status: 'superseded',
      superseded_by: 'pm-migration',
      superseded_reason: '旧版本误把占位记录标成 done，且没有可验收证据',
      done_at: before.done_at,
      result_path: before.result_path,
      result_json_path: before.result_json_path,
      verify_results: before.verify_results,
      claimed_by: before.claimed_by,
    });
    expect(after.pm_review_status ?? '').toBe(before.pm_review_status ?? '');
    expect(Number(after.superseded_at)).toBeGreaterThan(0);
    expect(await redis.zscore(keys.zset.status.done, 'legacy-fake-done')).toBeNull();
    expect(await redis.zscore(keys.zset.status.superseded, 'legacy-fake-done')).not.toBeNull();
    expect(await redis.zscore(keys.reviewRequested.pending, 'legacy-fake-done')).toBeNull();
    expect(await redis.sismember(keys.reviewRequested.fired, 'legacy-fake-done')).toBe(0);
    expect(await redis.hget(keys.reviewRequested.eventByTask, 'legacy-fake-done')).toBeNull();
    expect((await unackedEvents(redis, { consumer: 'pm-legacy' })).data).toEqual([]);
    expect(await eventTypes('legacy-fake-done')).toEqual(['review_requested', 'task_superseded']);
    expect((await pmReview(redis, 'legacy-fake-done', { verdict: 'accept', reviewed_by: 'pm' })).error?.code).toBe('TASK_NOT_DONE');
    expect((await taskReset(redis, 'legacy-fake-done', { force: true, reset_by: 'pm' })).error?.code).toBe('TASK_TERMINAL');
  });

  it('相同决定幂等，冲突决定不能改写首次审计', async () => {
    await seedTask('legacy-idempotent');
    await markDonePendingReview('legacy-idempotent');
    const request = { reason: '无有效产物', superseded_by: 'pm-a', confirmed: true } as const;

    expect((await supersedeTask(redis, 'legacy-idempotent', request)).ok).toBe(true);
    expect((await supersedeTask(redis, 'legacy-idempotent', request)).ok).toBe(true);
    expect((await supersedeTask(redis, 'legacy-idempotent', {
      ...request,
      reason: '试图覆盖原因',
    })).error?.code).toBe('TASK_SUPERSEDE_ALREADY_RECORDED');
    expect((await redis.hgetall(keys.hash.task('legacy-idempotent'))).superseded_reason).toBe('无有效产物');
    expect((await eventTypes('legacy-idempotent')).filter((type) => type === 'task_superseded')).toHaveLength(1);
  });

  it('SQLite 恢复后仍是 superseded，且保留原结果和退出原因', async () => {
    await seedTask('durable-supersede');
    await markDonePendingReview('durable-supersede', 42_000);
    const dir = mkdtempSync(join(tmpdir(), 'biao-supersede-db-'));
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    try {
      store.upsertPlan({
        plan_id: 'legacy-plan', title: 'legacy-plan', status: 'submitted', project_path: PROJECT,
        default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
        created_at: '1', submitted_at: '1', pm_consumer: 'pm-legacy',
      });
      setSqliteStore(store);
      expect((await supersedeTask(redis, 'durable-supersede', {
        reason: '持久化历史退出', superseded_by: 'pm-db', confirmed: true,
      })).ok).toBe(true);

      await redis.flushdb();
      const restored = await dbRestore(redis, store);
      expect(restored.byStatus).toMatchObject({ superseded: 1 });
      expect((await getTask(redis, 'durable-supersede')).data).toMatchObject({
        status: 'superseded',
        done_at: 42_000,
        result_path: `${PROJECT}/work/durable-supersede/result.md`,
        superseded_by: 'pm-db',
        superseded_reason: '持久化历史退出',
      });
      expect(await redis.zscore(keys.zset.status.superseded, 'durable-supersede')).not.toBeNull();
      expect(await redis.zscore(keys.reviewRequested.pending, 'durable-supersede')).toBeNull();
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Redis 已提交但 SQLite 暂时失败时，相同单任务决定重试会补齐副本并可灾后恢复', async () => {
    await seedTask('durable-supersede-retry');
    await markDonePendingReview('durable-supersede-retry', 43_000);
    const dir = mkdtempSync(join(tmpdir(), 'biao-supersede-retry-db-'));
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    try {
      store.upsertPlan({
        plan_id: 'legacy-plan', title: 'legacy-plan', status: 'submitted', project_path: PROJECT,
        default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
        created_at: '1', submitted_at: '1', pm_consumer: 'pm-legacy',
      });
      const originalUpsertTask = store.upsertTask.bind(store);
      let failOnce = true;
      store.upsertTask = (task) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated SQLite supersede outage');
        }
        originalUpsertTask(task);
      };
      setSqliteStore(store);
      const request = {
        reason: '持久化短暂失败后补偿', superseded_by: 'pm-db', confirmed: true,
      } as const;

      await expect(supersedeTask(redis, 'durable-supersede-retry', request))
        .rejects.toThrow('simulated SQLite supersede outage');
      expect((await getTask(redis, 'durable-supersede-retry')).data?.status).toBe('superseded');

      expect(await supersedeTask(redis, 'durable-supersede-retry', request)).toMatchObject({
        ok: true, data: { task_id: 'durable-supersede-retry', status: 'superseded' },
      });
      await redis.flushdb();
      const restored = await dbRestore(redis, store);
      expect(restored.byStatus).toMatchObject({ superseded: 1 });
      expect((await getTask(redis, 'durable-supersede-retry')).data).toMatchObject({
        status: 'superseded', superseded_by: 'pm-db', superseded_reason: '持久化短暂失败后补偿',
      });
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('单任务有活跃依赖者时 fail closed，并返回可解释依赖列表', async () => {
    await seedTask('legacy-source');
    await seedTask('active-dependent', { depends_on: ['legacy-source'] });
    await markDonePendingReview('legacy-source');

    const result = await supersedeTask(redis, 'legacy-source', {
      reason: '历史伪完成', superseded_by: 'pm', confirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TASK_HAS_ACTIVE_DEPENDENTS' },
      data: { dependent_task_ids: ['active-dependent'] },
    });
    expect((await getTask(redis, 'legacy-source')).data?.status).toBe('done');
  });
});

describe('Plan supersede 预览令牌与依赖安全', () => {
  it('首个 release 失败也停止全部续租并释放其余 owner-token 锁', async () => {
    const previousTtl = process.env.BIAO_TEST_PM_DECISION_LOCK_TTL_MS;
    process.env.BIAO_TEST_PM_DECISION_LOCK_TTL_MS = '90';
    await seedTask('cleanup-lock-a');
    await seedTask('cleanup-lock-b');
    await markDonePendingReview('cleanup-lock-a', 71_000);
    await markDonePendingReview('cleanup-lock-b', 72_000);
    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let failedFirstRelease = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      const lockKey = String(command?.args?.[2] ?? '');
      if (!failedFirstRelease && command?.name?.toLowerCase() === 'eval' &&
          script.includes('release-pm-review-lock-v1') && lockKey === keys.string.pmReviewLock('cleanup-lock-a')) {
        failedFirstRelease = true;
        return Promise.reject(new Error('simulated first owner-token release failure'));
      }
      return original.call(this, command, ...args);
    };
    try {
      await expect(supersedePlan(redis, 'legacy-plan', {
        reason: 'cleanup failure injection',
        superseded_by: 'pm-cleanup',
        confirmed: true,
        preview_token: preview.data!.preview_token,
      })).rejects.toThrow('PM decision lock cleanup failed');

      expect(failedFirstRelease).toBe(true);
      // 后续 task 与 plan release 即使首个 EVAL 失败也必须执行。
      expect(await redis.get(keys.string.pmReviewLock('cleanup-lock-b'))).toBeNull();
      expect(await redis.get(keys.string.planSupersedeLock('legacy-plan'))).toBeNull();

      // 首个 owner-token 暂时残留，但所有 renewal 已先停止；缩短其剩余 TTL 后不会被
      // timer 再次续上，新 owner 可以正常接管。
      expect(await redis.pexpire(keys.string.pmReviewLock('cleanup-lock-a'), 30)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await redis.get(keys.string.pmReviewLock('cleanup-lock-a'))).toBeNull();
      expect(await redis.set(keys.string.pmReviewLock('cleanup-lock-a'), 'new-owner', 'PX', 90, 'NX')).toBe('OK');
    } finally {
      client.sendCommand = original;
      if (previousTtl === undefined) delete process.env.BIAO_TEST_PM_DECISION_LOCK_TTL_MS;
      else process.env.BIAO_TEST_PM_DECISION_LOCK_TTL_MS = previousTtl;
      await redis.del(
        keys.string.pmReviewLock('cleanup-lock-a'),
        keys.string.pmReviewLock('cleanup-lock-b'),
        keys.string.planSupersedeLock('legacy-plan'),
      );
    }
  });

  it('cleanup 同时失败时不覆盖原业务异常，并仍释放其它锁', async () => {
    await seedTask('cleanup-primary-a');
    await seedTask('cleanup-primary-b');
    await markDonePendingReview('cleanup-primary-a', 73_000);
    await markDonePendingReview('cleanup-primary-b', 74_000);
    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let failedBusiness = false;
    let failedCleanup = false;
    const originalConsoleError = console.error;
    console.error = () => undefined;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      const lockKey = String(command?.args?.[2] ?? '');
      if (!failedBusiness && command?.name?.toLowerCase() === 'eval' &&
          script.includes('commit-supersede-round-fenced-v1')) {
        failedBusiness = true;
        return Promise.reject(new Error('simulated primary supersede failure'));
      }
      if (!failedCleanup && command?.name?.toLowerCase() === 'eval' &&
          script.includes('release-pm-review-lock-v1') && lockKey === keys.string.pmReviewLock('cleanup-primary-a')) {
        failedCleanup = true;
        return Promise.reject(new Error('simulated secondary cleanup failure'));
      }
      return original.call(this, command, ...args);
    };
    try {
      await expect(supersedePlan(redis, 'legacy-plan', {
        reason: 'primary failure injection',
        superseded_by: 'pm-cleanup',
        confirmed: true,
        preview_token: preview.data!.preview_token,
      })).rejects.toThrow('simulated primary supersede failure');
      expect(failedBusiness).toBe(true);
      expect(failedCleanup).toBe(true);
      expect(await redis.get(keys.string.pmReviewLock('cleanup-primary-b'))).toBeNull();
      expect(await redis.get(keys.string.planSupersedeLock('legacy-plan'))).toBeNull();
    } finally {
      client.sendCommand = original;
      console.error = originalConsoleError;
      await redis.del(
        keys.string.pmReviewLock('cleanup-primary-a'),
        keys.string.pmReviewLock('cleanup-primary-b'),
        keys.string.planSupersedeLock('legacy-plan'),
      );
    }
  });

  it('最终提交复核 preview revision，拒绝重算后才出现的新依赖者', async () => {
    await seedTask('preview-race-source');
    await markDonePendingReview('preview-race-source', 99_000);
    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let held = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!held && command?.name?.toLowerCase() === 'eval' && script.includes('commit-supersede-round-fenced-v1')) {
        held = true;
        entered();
        return releasePromise.then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      const staleBatch = supersedePlan(redis, 'legacy-plan', {
        reason: '旧 preview', superseded_by: 'pm-old', confirmed: true,
        preview_token: preview.data!.preview_token,
      });
      await enteredPromise;
      await seedTask('late-dependent', { depends_on: ['preview-race-source'] });
      release();
      expect(await staleBatch).toMatchObject({ ok: false, error: { code: 'PLAN_SUPERSEDE_PREVIEW_STALE' } });
      expect(await redis.hget(keys.hash.task('preview-race-source'), 'status')).toBe('done');
      expect(await redis.hget(keys.hash.task('late-dependent'), 'status')).toBe('pending');
    } finally {
      client.sendCommand = original;
      release?.();
    }
  });

  it('批量提交中任一候选锁过期时整批失败，不用旧快照覆盖新 review', async () => {
    await seedTask('batch-race-a');
    await seedTask('batch-race-b');
    await markDonePendingReview('batch-race-a', 101_000);
    await markDonePendingReview('batch-race-b', 102_000);
    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    const contender = redis.duplicate();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let held = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!held && command?.name?.toLowerCase() === 'eval' && script.includes('commit-supersede-round-fenced-v1')) {
        held = true;
        entered();
        return releasePromise.then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      const staleBatch = supersedePlan(redis, 'legacy-plan', {
        reason: '旧批次', superseded_by: 'pm-old', confirmed: true,
        preview_token: preview.data!.preview_token,
      });
      await enteredPromise;
      await contender.pexpire(keys.string.pmReviewLock('batch-race-a'), 5);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const newReview = await pmReview(contender, 'batch-race-a', {
        verdict: 'reject', reviewed_by: 'pm-new', reject_reason: '新 PM 已判定需修复', fix_instructions: '补齐有效产物',
      });
      expect(newReview.ok).toBe(true);
      release();
      expect(await staleBatch).toMatchObject({ ok: false, error: { code: 'PLAN_SUPERSEDE_PREVIEW_STALE' } });
      expect(await contender.hgetall(keys.hash.task('batch-race-a'))).toMatchObject({
        status: 'done', pm_review_status: 'rejected',
      });
      expect(await contender.hget(keys.hash.task('batch-race-b'), 'status')).toBe('done');
      expect(await contender.zscore(keys.zset.status.superseded, 'batch-race-a')).toBeNull();
      expect(await contender.zscore(keys.zset.status.superseded, 'batch-race-b')).toBeNull();
    } finally {
      client.sendCommand = original;
      release?.();
      contender.disconnect();
    }
  });

  it('只对预览快照中的待验收任务批量终止，保留已验收任务并让 plan 明确 cancelled', async () => {
    await seedTask('legacy-a');
    await seedTask('legacy-b', { depends_on: ['legacy-a'] });
    await seedTask('valid-accepted');
    await markDonePendingReview('legacy-a', 1000);
    await markDonePendingReview('legacy-b', 2000);
    await markDonePendingReview('valid-accepted', 3000);
    await redis.hset(keys.hash.task('valid-accepted'), {
      pm_review_status: 'accepted', pm_reviewed_by: 'pm-old', pm_reviewed_at: '3001',
    });
    await redis.zrem(keys.reviewRequested.pending, 'valid-accepted');

    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    expect(preview).toMatchObject({
      ok: true,
      data: {
        plan_id: 'legacy-plan',
        candidate_task_ids: ['legacy-a', 'legacy-b'],
        blockers: [],
      },
    });
    expect(preview.data?.preview_token).toMatch(/^[a-f0-9]{64}$/);

    const stale = await supersedePlan(redis, 'legacy-plan', {
      reason: '迁移旧版本伪完成', superseded_by: 'pm-migration', confirmed: true, preview_token: '0'.repeat(64),
    });
    expect(stale.error?.code).toBe('PLAN_SUPERSEDE_PREVIEW_STALE');
    expect((await getTask(redis, 'legacy-a')).data?.status).toBe('done');

    const applied = await supersedePlan(redis, 'legacy-plan', {
      reason: '迁移旧版本伪完成',
      superseded_by: 'pm-migration',
      confirmed: true,
      preview_token: preview.data!.preview_token,
    });
    expect(applied).toMatchObject({
      ok: true,
      data: { plan_id: 'legacy-plan', superseded_task_ids: ['legacy-a', 'legacy-b'], status: 'cancelled' },
    });
    expect((await getTask(redis, 'valid-accepted')).data).toMatchObject({ status: 'done', pm_review_status: 'accepted' });
    expect((await getPlan(redis, 'legacy-plan')).data).toMatchObject({
      status: 'cancelled',
      tasks: { superseded: [{ task_id: 'legacy-a' }, { task_id: 'legacy-b' }] },
      reviews: { pending: 0, accepted: 1, rejected: 0 },
    });
  });

  it('预览列出非候选活跃状态并拒绝应用，不静默级联取消', async () => {
    await seedTask('legacy-only');
    await seedTask('still-running');
    await markDonePendingReview('legacy-only');
    await redis.zrem(keys.zset.status.pending, 'still-running');
    await redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'still-running');
    await redis.hset(keys.hash.task('still-running'), 'status', 'running');

    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    expect(preview.data?.blockers).toEqual([
      expect.objectContaining({ task_id: 'still-running', code: 'NON_TERMINAL_TASK', status: 'running' }),
    ]);
    const applied = await supersedePlan(redis, 'legacy-plan', {
      reason: '迁移旧版本伪完成', superseded_by: 'pm', confirmed: true,
      preview_token: preview.data!.preview_token,
    });
    expect(applied.error?.code).toBe('PLAN_SUPERSEDE_BLOCKED');
    expect((await getTask(redis, 'legacy-only')).data?.status).toBe('done');
  });

  it('Plan 批量 Redis 已提交但 SQLite 中途失败时，相同快照与决定重试会补齐整批副本', async () => {
    await seedTask('legacy-batch-a');
    await seedTask('legacy-batch-b', { depends_on: ['legacy-batch-a'] });
    await markDonePendingReview('legacy-batch-a', 11_000);
    await markDonePendingReview('legacy-batch-b', 12_000);
    const preview = await previewPlanSupersede(redis, 'legacy-plan');
    const request = {
      reason: '批量持久化短暂失败后补偿',
      superseded_by: 'pm-batch',
      confirmed: true,
      preview_token: preview.data!.preview_token,
    } as const;
    const dir = mkdtempSync(join(tmpdir(), 'biao-plan-supersede-retry-db-'));
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    try {
      store.upsertPlan({
        plan_id: 'legacy-plan', title: 'legacy-plan', status: 'submitted', project_path: PROJECT,
        default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 2,
        created_at: '1', submitted_at: '1', pm_consumer: 'pm-legacy',
      });
      const originalUpsertTask = store.upsertTask.bind(store);
      let writes = 0;
      store.upsertTask = (task) => {
        writes++;
        if (writes === 2) throw new Error('simulated SQLite batch supersede outage');
        originalUpsertTask(task);
      };
      setSqliteStore(store);

      await expect(supersedePlan(redis, 'legacy-plan', request))
        .rejects.toThrow('simulated SQLite batch supersede outage');
      expect((await getTask(redis, 'legacy-batch-a')).data?.status).toBe('superseded');
      expect((await getTask(redis, 'legacy-batch-b')).data?.status).toBe('superseded');

      expect(await supersedePlan(redis, 'legacy-plan', request)).toMatchObject({
        ok: true,
        data: {
          plan_id: 'legacy-plan',
          superseded_task_ids: ['legacy-batch-a', 'legacy-batch-b'],
          status: 'cancelled',
        },
      });
      await redis.flushdb();
      const restored = await dbRestore(redis, store);
      expect(restored.byStatus).toMatchObject({ superseded: 2 });
      expect((await getTask(redis, 'legacy-batch-a')).data?.status).toBe('superseded');
      expect((await getTask(redis, 'legacy-batch-b')).data?.status).toBe('superseded');
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
