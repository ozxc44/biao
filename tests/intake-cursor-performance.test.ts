/**
 * PM intake 的增量游标/待确认索引回归。
 *
 * 目标不是缩短首次历史回放（那是新 consumer 必需的一次性成本），而是证明同一
 * consumer 已初始化后只读取 stream 尾部，同时未 ack 事项仍可跨进程重启、按精确
 * stream 顺序继续处理。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { ackEvent, unackedEvents } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(() => redis.disconnect());

async function addPmEvent(eventId: string, consumer: string, id = '*'): Promise<string> {
  const taskId = `task-${eventId}`;
  const streamId = await redis.xadd(
    keys.stream.events,
    id,
    'event_id', eventId,
    'type', 'review_requested',
    'task_id', taskId,
    'plan_id', 'intake-plan',
    'consumer', consumer,
    'timestamp', String(Date.now()),
    'acked', 'false',
  );
  if (!streamId) throw new Error(`failed to append PM event ${eventId}`);

  // review_requested 是“当前 done 且未验收”的门铃投影。生产代码会主动清理
  // 缺少对应任务真相的孤儿/已撤回门铃，因此性能回归夹具也必须构造合法状态。
  await redis.hset(keys.hash.task(taskId), {
    task_id: taskId,
    plan_id: 'intake-plan',
    status: 'done',
    done_at: streamId.split('-')[0],
    pm_review_status: '',
    resolution_status: '',
  });
  return streamId;
}

async function addNoiseEvent(index: number): Promise<void> {
  await redis.xadd(
    keys.stream.events,
    '*',
    'event_id', `noise-${index}`,
    'type', 'task_completed',
    'task_id', `noise-task-${index}`,
    'timestamp', String(Date.now()),
  );
}

describe('consumer intake 增量索引', () => {
  it('首次历史回放后持久化游标，下一轮只扫描新增尾部且不会丢失旧未 ack 事项', async () => {
    // 让首次回放跨过多个 XRANGE page；其中只有一项是 PM 门铃。
    for (let i = 0; i < 410; i++) await addNoiseEvent(i);
    await addPmEvent('historic-review', 'pm-cursor');

    const initial = await unackedEvents(redis, { consumer: 'pm-cursor' });
    expect(initial.data?.map((event) => event.event_id)).toEqual(['historic-review']);

    const persistedCursor = await redis.get(keys.ack.consumerCursor('pm-cursor'));
    expect(persistedCursor).toMatch(/^\d+-\d+$/);

    for (let i = 0; i < 260; i++) await addNoiseEvent(500 + i);
    await addPmEvent('tail-review', 'pm-cursor');

    const xrange = vi.spyOn(redis, 'xrange');
    const next = await unackedEvents(redis, { consumer: 'pm-cursor' });
    expect(next.data?.map((event) => event.event_id)).toEqual(['historic-review', 'tail-review']);

    // 已初始化 consumer 的轮询必须从 durable cursor 严格排他地读取新尾部，
    // 不能每次又从 '-' 扫完整个 event stream。
    expect(xrange).toHaveBeenCalled();
    expect(xrange.mock.calls.every((call) => call[1] !== '-')).toBe(true);

    const acked = await ackEvent(redis, { consumer: 'pm-cursor', event_id: 'historic-review' });
    expect(acked).toMatchObject({ ok: true, data: { already_acked: false } });
    const afterAck = await unackedEvents(redis, { consumer: 'pm-cursor' });
    expect(afterAck.data?.map((event) => event.event_id)).toEqual(['tail-review']);
  });

  it('同毫秒事件按精确 stream 顺序分页；ack 和游标在重新连接后仍可继续', async () => {
    const ms = Date.now() + 10_000;
    await addPmEvent('same-ms-a', 'pm-restart', `${ms}-0`);
    await addPmEvent('same-ms-b', 'pm-restart', `${ms}-1`);
    await addPmEvent('same-ms-c', 'pm-restart', `${ms}-2`);

    const first = await unackedEvents(redis, { consumer: 'pm-restart', limit: 1 });
    expect(first.data?.map((event) => event.event_id)).toEqual(['same-ms-a']);
    await ackEvent(redis, { consumer: 'pm-restart', event_id: 'same-ms-a' });

    // 模拟服务进程重启：只重连 Redis，不依赖任何进程内缓存。
    const restarted = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    try {
      const second = await unackedEvents(restarted, { consumer: 'pm-restart', limit: 1 });
      expect(second.data?.map((event) => event.event_id)).toEqual(['same-ms-b']);
      await ackEvent(restarted, { consumer: 'pm-restart', event_id: 'same-ms-b' });
      const third = await unackedEvents(restarted, { consumer: 'pm-restart', limit: 1 });
      expect(third.data?.map((event) => event.event_id)).toEqual(['same-ms-c']);
    } finally {
      restarted.disconnect();
    }
  });

  it('不同 consumer 各自首次历史回放且路由隔离，已初始化 consumer 并发轮询不产生重复索引', async () => {
    await addPmEvent('for-a', 'pm-a');
    await addPmEvent('for-b', 'pm-b');

    const a = await unackedEvents(redis, { consumer: 'pm-a' });
    const b = await unackedEvents(redis, { consumer: 'pm-b' });
    expect(a.data?.map((event) => event.event_id)).toEqual(['for-a']);
    expect(b.data?.map((event) => event.event_id)).toEqual(['for-b']);

    const ms = Date.now() + 20_000;
    await addPmEvent('tail-a-0', 'pm-a', `${ms}-0`);
    await addPmEvent('tail-a-1', 'pm-a', `${ms}-1`);
    await Promise.all([
      unackedEvents(redis, { consumer: 'pm-a' }),
      unackedEvents(redis, { consumer: 'pm-a' }),
      unackedEvents(redis, { consumer: 'pm-a' }),
    ]);

    const allA = await unackedEvents(redis, { consumer: 'pm-a' });
    expect(allA.data?.map((event) => event.event_id)).toEqual(['for-a', 'tail-a-0', 'tail-a-1']);
  });
});
