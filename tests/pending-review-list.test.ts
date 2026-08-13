import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { getPendingReviewTasks } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(() => {
  redis.disconnect();
});

describe('待验收任务专用索引', () => {
  it('不受超过 5000 条 done 历史截断影响，并返回真实 plan 过滤总数', async () => {
    const history = redis.pipeline();
    for (let index = 0; index < 5_001; index++) {
      const taskId = `accepted-${index}`;
      history.hset(keys.hash.task(taskId), {
        task_id: taskId,
        plan_id: 'history-plan',
        title: taskId,
        type: 'code',
        phase: 'impl',
        status: 'done',
        assignee: 'auto',
        priority: '5',
        pm_review_status: 'accepted',
      });
      history.zadd(keys.zset.status.done, index, taskId);
    }
    const outcomes = await history.exec();
    expect(outcomes?.every(([error]) => error === null)).toBe(true);

    await redis.hset(keys.hash.task('pending-review'), {
      task_id: 'pending-review',
      plan_id: 'active-plan',
      title: '真正待验收',
      type: 'acceptance',
      phase: 'gate',
      status: 'done',
      assignee: 'auto',
      priority: '9',
      pm_review_status: '',
      resolution_status: '',
    });
    await redis.zadd(keys.zset.status.done, 6_000, 'pending-review');
    await redis.zadd(keys.reviewRequested.pending, 6_000, 'pending-review');

    await expect(getPendingReviewTasks(redis, { plan_id: 'active-plan' })).resolves.toEqual({
      ok: true,
      data: {
        total: 1,
        tasks: [expect.objectContaining({ task_id: 'pending-review', plan_id: 'active-plan' })],
      },
    });
  });

  it('清理已裁决或已进入 resolution 的过期 pending 索引', async () => {
    await redis.hset(keys.hash.task('stale-review'), {
      task_id: 'stale-review',
      plan_id: 'p',
      status: 'done',
      pm_review_status: 'accepted',
    });
    await redis.zadd(keys.reviewRequested.pending, 1, 'stale-review');

    await expect(getPendingReviewTasks(redis)).resolves.toEqual({
      ok: true,
      data: { tasks: [], total: 0 },
    });
    expect(await redis.zscore(keys.reviewRequested.pending, 'stale-review')).toBeNull();
  });

  it('直接调用时先为升级前 done 未验收任务补建 legacy 索引', async () => {
    await redis.hset(keys.hash.task('legacy-pending-review'), {
      task_id: 'legacy-pending-review',
      plan_id: 'legacy-plan',
      title: '升级前待验收',
      type: 'code',
      phase: 'impl',
      status: 'done',
      assignee: 'auto',
      priority: '5',
      done_at: '123',
      pm_review_status: '',
      resolution_status: '',
    });
    await redis.zadd(keys.zset.status.done, 123, 'legacy-pending-review');
    expect(await redis.zcard(keys.reviewRequested.pending)).toBe(0);

    const result = await getPendingReviewTasks(redis, { plan_id: 'legacy-plan' });
    expect(result.data).toEqual({
      total: 1,
      tasks: [expect.objectContaining({ task_id: 'legacy-pending-review' })],
    });
    expect(await redis.zscore(keys.reviewRequested.pending, 'legacy-pending-review')).not.toBeNull();
  });

  it('统一把 legacy 空白 review 状态序列化为未验收，而不是泄露空白字符串', async () => {
    await redis.hset(keys.hash.task('legacy-whitespace-review'), {
      task_id: 'legacy-whitespace-review',
      plan_id: 'legacy-plan',
      title: '空白状态',
      type: 'code',
      phase: 'impl',
      status: 'done',
      assignee: 'auto',
      priority: '5',
      done_at: '321',
      pm_review_status: '   ',
      resolution_status: ' ',
    });
    await redis.zadd(keys.zset.status.done, 321, 'legacy-whitespace-review');

    const result = await getPendingReviewTasks(redis);
    expect(result.data).toEqual({
      total: 1,
      tasks: [expect.objectContaining({
        task_id: 'legacy-whitespace-review',
        pm_review_status: undefined,
      })],
    });
  });

  it('清理提交前原子重验，不能误删并发 reset 后的新一代待验收 member', async () => {
    const taskId = 'review-generation-race';
    await redis.hset(keys.hash.task(taskId), {
      task_id: taskId,
      plan_id: 'race-plan',
      title: '并发新一代',
      type: 'code',
      phase: 'impl',
      status: 'done',
      assignee: 'auto',
      priority: '5',
      pm_review_status: 'accepted',
      resolution_status: '',
      done_at: '100',
    });
    await redis.zadd(keys.reviewRequested.pending, 100, taskId);
    await redis.set(keys.reviewRequested.legacyIndexesReady, '1');

    const originalHgetall = redis.hgetall.bind(redis);
    let raced = false;
    redis.hgetall = (async (key: string) => {
      const snapshot = await originalHgetall(key);
      if (!raced && key === keys.hash.task(taskId)) {
        raced = true;
        await redis.hset(key, {
          status: 'done',
          pm_review_status: '',
          resolution_status: '',
          done_at: '200',
        });
        await redis.zadd(keys.reviewRequested.pending, 200, taskId);
      }
      return snapshot;
    }) as typeof redis.hgetall;

    try {
      expect((await getPendingReviewTasks(redis)).data).toEqual({ tasks: [], total: 0 });
    } finally {
      redis.hgetall = originalHgetall as typeof redis.hgetall;
    }

    expect(await redis.zscore(keys.reviewRequested.pending, taskId)).toBe('200');
    expect((await getPendingReviewTasks(redis)).data).toEqual({
      total: 1,
      tasks: [expect.objectContaining({ task_id: taskId, pm_review_status: undefined })],
    });
  });
});
