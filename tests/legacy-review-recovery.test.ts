/**
 * 历史待验收恢复回归。
 *
 * 这组数据刻意模拟上线前已经存在的状态：task 已是 done 且未 PM Review，
 * 但 event stream 从未写过 review_requested，plan hash 也没有 pm_consumer。
 * 所有写入只使用 6380/DB14，绝不触碰运行中的 6379。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ackEvent,
  agentRegister,
  claim,
  dbRestore,
  pmIntake,
  report,
  setSqliteStore,
  unackedEvents,
} from '../src/server/service.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { keys } from '../src/redis/keys.js';
import { SupervisedProject } from '../src/worker/supervisor.js';

const REDIS_URL = process.env.LEGACY_REVIEW_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/14';
const PROJECT_PATH = '/tmp/biao-legacy-review-project';

let redis: Redis;
const tempDirs: string[] = [];

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterEach(() => {
  setSqliteStore(null);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => redis.disconnect());

async function seedLegacyDone(opts: {
  planId?: string;
  taskId?: string;
  consumer?: string | undefined;
} = {}): Promise<{ planId: string; taskId: string }> {
  const planId = opts.planId ?? 'legacy-plan';
  const taskId = opts.taskId ?? 'legacy-done-task';
  const doneAt = Date.now() - 1_000;
  const plan: Record<string, string> = {
    plan_id: planId,
    title: '历史计划',
    status: 'submitted',
    project_path: PROJECT_PATH,
    default_assignee: 'auto',
    default_priority: '5',
    phases: '[]',
    task_count: '1',
    created_at: String(doneAt - 1_000),
  };
  // 历史 plan 缺失该字段（或 SQLite restore 还原为空串）都必须路由到默认 pm。
  if (opts.consumer !== undefined) plan.pm_consumer = opts.consumer;
  await redis.hset(keys.hash.plan(planId), plan);
  await redis.hset(keys.hash.task(taskId), {
    task_id: taskId,
    plan_id: planId,
    title: '历史完成但未验收',
    type: 'code',
    phase: 'impl',
    status: 'done',
    priority: '5',
    project_path: PROJECT_PATH,
    claimed_by: 'legacy-worker',
    done_at: String(doneAt),
    pm_review_status: '',
  });
  await redis.zadd(keys.zset.status.done, doneAt, taskId);
  return { planId, taskId };
}

async function reviewEvents(): Promise<Array<Record<string, string>>> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw
    .map(([, fields]) => Object.fromEntries(fields.reduce<string[][]>((pairs, field, index) => {
      if (index % 2 === 0) pairs.push([field, fields[index + 1] ?? '']);
      return pairs;
    }, [])))
    .filter((event) => event.type === 'review_requested');
}

describe('历史 done 未验收的 PM 门铃恢复', () => {
  it('缺 consumer 和历史 review 事件时，默认 pm 获得一次可确认门铃；ack 后状态仍可见且不刷重复事件', async () => {
    const { planId, taskId } = await seedLegacyDone();

    const first = await pmIntake(redis, { consumer: 'pm' });
    const bell = first.data?.items.find((item) => item.kind === 'review_requested' && item.task_id === taskId);
    expect(bell).toMatchObject({
      kind: 'review_requested',
      plan_id: planId,
      task_id: taskId,
      project_path: PROJECT_PATH,
    });
    expect(bell?.event_id).toBeTruthy();
    expect(await reviewEvents()).toHaveLength(1);

    // 已运行的共享 Supervisor 用 kind:event_id 去重。状态保留后必须沿用同一 event_id，
    // 否则 PM ack 会把同一 task 错当作新门铃而每轮再次提醒。
    const supervised = new SupervisedProject({
      planId,
      isClosed: async () => false,
      pendingItems: async () => (await pmIntake(redis, { consumer: 'pm' })).data!.items,
    });
    expect((await supervised.newItems()).some((item) => item.task_id === taskId)).toBe(true);

    const foreign = await pmIntake(redis, { consumer: 'pm-other' });
    expect(foreign.data?.items.some((item) => item.task_id === taskId)).toBe(false);

    const acknowledged = await ackEvent(redis, { consumer: 'pm', event_id: bell!.event_id! });
    expect(acknowledged).toMatchObject({ ok: true, data: { already_acked: false } });
    expect((await unackedEvents(redis, { consumer: 'pm', type: 'review_requested' })).data).toHaveLength(0);

    // 门铃可被确认，但 task 的未验收事实不能随 ack 消失；且不能每轮再写一条 stream 事件。
    const afterAck = await pmIntake(redis, { consumer: 'pm' });
    expect(afterAck.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review_requested', task_id: taskId, event_id: bell!.event_id }),
    ]));
    expect(await reviewEvents()).toHaveLength(1);
    supervised.markAcked(bell!.event_id!);
    expect(await supervised.newItems()).toHaveLength(0);
  });

  it('并发 PM 轮询只为同一条历史待验收任务补一条门铃，后续轮询不重扫历史 stream', async () => {
    await seedLegacyDone();
    await Promise.all([
      pmIntake(redis, { consumer: 'pm' }),
      pmIntake(redis, { consumer: 'pm' }),
      pmIntake(redis, { consumer: 'pm' }),
    ]);
    expect(await reviewEvents()).toHaveLength(1);

    const xrange = vi.spyOn(redis, 'xrange');
    await pmIntake(redis, { consumer: 'pm' });
    expect(xrange).toHaveBeenCalled();
    expect(xrange.mock.calls.every((call) => call[1] !== '-')).toBe(true);
  });

  it('门铃提交边界复核 resolution，不能把已进入修复链的旧快照重新通知 PM', async () => {
    const { taskId } = await seedLegacyDone({
      planId: 'review-resolution-race-plan',
      taskId: 'review-resolution-race-task',
    });

    const originalHgetall = redis.hgetall.bind(redis);
    let raced = false;
    redis.hgetall = (async (key: string) => {
      const snapshot = await originalHgetall(key);
      if (!raced && key === keys.hash.task(taskId) && snapshot.status === 'done') {
        raced = true;
        await redis.hset(key, 'resolution_status', 'repairing');
      }
      return snapshot;
    }) as typeof redis.hgetall;

    try {
      const intake = await pmIntake(redis, { consumer: 'pm' });
      expect(intake.data?.items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'review_requested', task_id: taskId }),
      ]));
    } finally {
      redis.hgetall = originalHgetall as typeof redis.hgetall;
    }

    expect(await reviewEvents()).toHaveLength(0);
    expect(await redis.zscore(keys.reviewRequested.pending, taskId)).toBeNull();
  });

  it('非法 legacy consumer 同样回退默认 pm，Lua 提交边界不会把门铃路由到无人 consumer', async () => {
    const { planId, taskId } = await seedLegacyDone({
      planId: 'invalid-consumer-plan',
      taskId: 'invalid-consumer-task',
      consumer: 'bad consumer!',
    });

    const intake = await pmIntake(redis, { consumer: 'pm' });
    expect(intake.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review_requested', plan_id: planId, task_id: taskId }),
    ]));
    expect(await redis.hget(keys.hash.plan(planId), 'pm_consumer')).toBe('pm');
    expect((await reviewEvents())[0]).toMatchObject({ consumer: 'pm', task_id: taskId });
  });

  it('新任务已经写入 review_requested 时不会被恢复逻辑重复补发', async () => {
    const planId = 'current-plan';
    const taskId = 'current-task';
    await redis.hset(keys.hash.plan(planId), {
      plan_id: planId,
      title: planId,
      status: 'submitted',
      project_path: PROJECT_PATH,
      pm_consumer: 'pm-current',
    });
    await redis.hset(keys.hash.task(taskId), {
      task_id: taskId,
      plan_id: planId,
      title: taskId,
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: '5',
      project_path: PROJECT_PATH,
      status: 'pending',
      timeout_seconds: '60',
      verify: '[]',
    });
    await redis.zadd(keys.zset.status.pending, Date.now(), taskId);
    await agentRegister(redis, 'current-worker', 'mock', ['code']);
    const claimed = await claim(redis, { agent_id: 'current-worker', blocking: false, timeout_ms: 1 });
    await report(redis, {
      task_id: taskId,
      agent_id: 'current-worker',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });
    expect(await reviewEvents()).toHaveLength(1);

    await pmIntake(redis, { consumer: 'pm-current' });
    expect(await reviewEvents()).toHaveLength(1);
  });

  it('SQLite 旧空 consumer 恢复为 pm，显式合法 consumer 原样保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-legacy-review-sqlite-'));
    tempDirs.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'blank-consumer-plan',
      title: 'blank-consumer-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 0,
      created_at: '1',
      submitted_at: '2',
      pm_consumer: '',
    });
    store.upsertPlan({
      plan_id: 'named-consumer-plan',
      title: 'named-consumer-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 0,
      created_at: '1',
      submitted_at: '2',
      pm_consumer: 'pm-named',
    });

    await dbRestore(redis, store);
    expect(await redis.hget(keys.hash.plan('blank-consumer-plan'), 'pm_consumer')).toBe('pm');
    expect(await redis.hget(keys.hash.plan('named-consumer-plan'), 'pm_consumer')).toBe('pm-named');
    store.close();
  });
});
