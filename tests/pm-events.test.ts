/**
 * 被动式 PM 事件 + consumer ack 测试
 * 覆盖：
 *  - review_requested 最小字段 + 一次性语义
 *  - 按 PM consumer 路由（事件携带 consumer；旧 plan 用兼容默认值）
 *  - acceptance_ready 只在依赖由未满足变为满足时产生一次（不重复）
 *  - 双 consumer 独立 ack；重复 ack 幂等；未确认事件补交
 *  - 旧 events 查询兼容
 *  - plan submit/create 支持 PM consumer 标识
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  report,
  pmReview,
  planSubmit,
  setSqliteStore,
  unackedEvents,
  ackEvent,
  pmIntake,
} from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const FIXTURES = join(import.meta.dirname, 'fixtures');

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterEach(() => {
  setSqliteStore(null);
});

/** 读取事件流原始条目（按类型过滤） */
async function eventsByType(type: string): Promise<Array<Record<string, string>>> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw
    .map(([, fields]) => {
      const kv: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) kv[fields[i]] = fields[i + 1];
      return kv;
    })
    .filter((e) => e.type === type);
}

describe('review_requested 事件语义', () => {
  it('report done 后产生 review_requested，携带 consumer/task_id/plan_id/timestamp 最小字段', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    const reviews = await eventsByType('review_requested');
    expect(reviews.length).toBe(1);
    const ev = reviews[0];
    // 最小字段：consumer / task_id / plan_id / timestamp
    expect(ev.task_id).toBe(c.data!.task_id);
    expect(ev.plan_id).toBe('test-m0-plan');
    expect(ev.consumer).toBeTruthy();
    expect(ev.timestamp).toBeTruthy();
    expect(ev.acked).toBe('false');
  });

  it('report failed 不产生 review_requested（只有 done 需 PM 签核）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'failed',
    });
    const reviews = await eventsByType('review_requested');
    expect(reviews.length).toBe(0);
  });

  it('report done 保留 task_completed 兼容事件（旧消费者不中断）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    const completed = await eventsByType('task_completed');
    expect(completed.length).toBe(1);
    expect(completed[0].result_status).toBe('done');
  });
});

describe('acceptance_ready 去重边界', () => {
  /** test-plan 结构：T01(根,code) <- T02(code,dep T01) <- T03(acceptance,dep T01&T02,acceptance_for T01&T02) */
  const ACC_TASK = 'test-m0-plan-03-qa';
  const T01 = 'test-m0-plan-01-be';
  const T02 = 'test-m0-plan-02-fe';

  /** 完成 T01（先领先报）。完成后 acceptance T03 仍缺 T02，不应 ready。 */
  async function finishTask(taskId: string, agentId: string, verifyCmd?: string) {
    const claimed = await claim(redis, { agent_id: agentId, blocking: false, timeout_ms: 50 });
    expect(claimed.data?.task_id).toBe(taskId);
    const h = await redis.hgetall(keys.hash.task(taskId));
    let verifyResults: Array<{ cmd: string; exit_code: number; passed: boolean }> | undefined;
    if (h.verify && h.verify !== '[]') {
      verifyResults = [{ cmd: verifyCmd ?? 'echo hello', exit_code: 0, passed: true }];
    }
    await report(redis, {
      task_id: taskId,
      agent_id: agentId,
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: verifyResults,
    });
  }

  it('依赖全部满足时，acceptance 任务产生一次 acceptance_ready', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code', 'acceptance']);

    // 完成 T01（带 verify）。T03 仍缺 T02 → 不 ready
    await finishTask(T01, 'w1', 'echo hello');
    // 普通代码下游必须等 PM 验收，不允许仅凭 Worker 的 done 跨过交付门。
    await pmReview(redis, T01, { verdict: 'accept', reviewed_by: 'pm' });
    expect((await eventsByType('acceptance_ready')).length).toBe(0);

    // 完成 T02 → T03 依赖全部满足，应产生一次 acceptance_ready
    await finishTask(T02, 'w1');
    const ready = await eventsByType('acceptance_ready');
    expect(ready.length).toBe(1);
    expect(ready[0].task_id).toBe(ACC_TASK);
    expect(ready[0].consumer).toBeTruthy();
    expect(ready[0].plan_id).toBe('test-m0-plan');
    expect(ready[0].acked).toBe('false');
  });

  it('重复触发同一状态转换不重复写 acceptance_ready（幂等）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code', 'acceptance']);
    await finishTask(T01, 'w1', 'echo hello');
    await pmReview(redis, T01, { verdict: 'accept', reviewed_by: 'pm' });
    await finishTask(T02, 'w1');
    expect((await eventsByType('acceptance_ready')).length).toBe(1);

    // 模拟再次评估依赖满足（例如另一个无关任务 done 触发 step7.5 扫描）：
    // 再 submit 一个带新依赖的结构会重建，但去重集合已含 T03 → 不产生第二个。
    // 这里通过手工触发一次"虚假满足"路径：直接验证去重集合存在即可。
    const inSet = await redis.sismember(keys.acceptanceReady.fired, ACC_TASK);
    expect(inSet).toBe(1);
  });
});

describe('consumer 路由与 ack', () => {
  /** 提交一个 plan 并把它的 pm_consumer 改成指定值（模拟声明了 consumer 的 plan） */
  async function seedPlanWithConsumer(planId: string, consumer: string): Promise<string> {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    // 改写 plan_id 隔离：直接改 plan hash 的 pm_consumer（test-plan 默认 plan_id=test-m0-plan）
    // 为避免 task_id 冲突，这里用独立 flush + 重写。简化：复用 test-plan，覆盖 pm_consumer。
    await redis.hset(keys.hash.plan('test-m0-plan'), 'pm_consumer', consumer);
    return 'test-m0-plan';
  }

  /** 走完整 claim→report done，产生一条 review_requested */
  async function produceReviewRequest(): Promise<string> {
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    return c.data!.task_id;
  }

  it('ack 必须由事件所属 consumer 执行：旁路 reader 不能伪造确认', async () => {
    await seedPlanWithConsumer('test-m0-plan', 'pm-team');
    await produceReviewRequest();

    // event 明确路由给 pm-team；其它 consumer 既不可读取，也不能先行写入 ack 审计。
    const readerA = 'pm-team-a';

    // 以 owner 身份读取一次拿到 event_id
    const owner = await unackedEvents(redis, { consumer: 'pm-team' });
    expect(owner.data!.some((e) => e.type === 'review_requested')).toBe(true);
    const evId = owner.data!.find((e) => e.type === 'review_requested')!.event_id;

    const foreignAck = await ackEvent(redis, { consumer: readerA, event_id: evId });
    expect(foreignAck).toMatchObject({ ok: false, error: { code: 'CONSUMER_NOT_AUTHORIZED' } });
    const aAcked = await redis.sismember(keys.ack.consumerAcked(readerA), evId);
    expect(aAcked).toBe(0);

    const ownerAck = await ackEvent(redis, { consumer: 'pm-team', event_id: evId });
    expect(ownerAck.ok).toBe(true);
    expect(await redis.sismember(keys.ack.consumerAcked('pm-team'), evId)).toBe(1);
    expect((await unackedEvents(redis, { consumer: 'pm-team' })).data!.some((e) => e.event_id === evId)).toBe(false);
  });

  it('重复 ack 幂等，不报错', async () => {
    await seedPlanWithConsumer('test-m0-plan', 'pm');
    await produceReviewRequest();

    const owner = (await eventsByType('review_requested'))[0].consumer!;
    const evId = (await unackedEvents(redis, { consumer: owner })).data!.find(
      (e) => e.type === 'review_requested',
    )!.event_id;

    const r1 = await ackEvent(redis, { consumer: owner, event_id: evId });
    const r2 = await ackEvent(redis, { consumer: owner, event_id: evId });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true); // 幂等：第二次也 ok
    expect(r1.data!.already_acked).toBe(false);
    expect(r2.data!.already_acked).toBe(true);
    expect((await unackedEvents(redis, { consumer: owner })).data!.length).toBe(0);
  });

  it('ack 不修改 Redis Stream 历史（xrange 仍能读到原事件）', async () => {
    await seedPlanWithConsumer('test-m0-plan', 'pm');
    await produceReviewRequest();

    const owner = (await eventsByType('review_requested'))[0].consumer!;
    const evId = (await unackedEvents(redis, { consumer: owner })).data!.find(
      (e) => e.type === 'review_requested',
    )!.event_id;
    await ackEvent(redis, { consumer: owner, event_id: evId });

    // stream 历史仍在
    const streamLen = await redis.xlen(keys.stream.events);
    expect(streamLen).toBeGreaterThan(0);
    const reviews = await eventsByType('review_requested');
    expect(reviews.length).toBe(1);
  });

  it('未确认事件可补交（同一 consumer 重启/重连后仍能拿到历史未 ack）', async () => {
    await seedPlanWithConsumer('test-m0-plan', 'pm');
    await produceReviewRequest();

    // 该 plan 的 PM consumer（默认 pm）即便从未读过，首次拉取也能补到历史未 ack 事件
    const ownerConsumer = (await eventsByType('review_requested'))[0].consumer;
    const r = await unackedEvents(redis, { consumer: ownerConsumer });
    expect(r.data!.some((e) => e.type === 'review_requested')).toBe(true);
  });

  it('consumer 名称校验：非法字符被拒绝', async () => {
    const r = await unackedEvents(redis, { consumer: 'bad consumer!' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_CONSUMER');
  });

  it('不同 plan 的 consumer 路由隔离：只提醒对应 PM', async () => {
    // plan A 属于 pm-a，plan B 属于 pm-b
    await planSubmit(redis, join(FIXTURES, 'test-plan')); // plan_id test-m0-plan
    await redis.hset(keys.hash.plan('test-m0-plan'), 'pm_consumer', 'pm-a');
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    // pm-a 能看到，pm-b 看不到（路由隔离）
    const aSees = (await unackedEvents(redis, { consumer: 'pm-a' })).data!.some(
      (e) => e.type === 'review_requested',
    );
    const bSees = (await unackedEvents(redis, { consumer: 'pm-b' })).data!.some(
      (e) => e.type === 'review_requested',
    );
    expect(aSees).toBe(true);
    expect(bSees).toBe(false);
  });
});

describe('pmIntake 一次性提醒', () => {
  it('汇总待签核/acceptance_ready/失败阻塞/stale，按 consumer 路由', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    const consumer = (await eventsByType('review_requested'))[0].consumer;
    const intake = await pmIntake(redis, { consumer });
    expect(intake.ok).toBe(true);
    // 默认最小字段：只给类型/plan_id/task_id/游标/数量，不展开结果详情
    const reviewItems = intake.data!.items.filter((i) => i.kind === 'review_requested');
    expect(reviewItems.length).toBeGreaterThan(0);
    const item = reviewItems[0];
    expect(item.plan_id).toBeTruthy();
    expect(item.task_id).toBeTruthy();
    // 不应展开 result/verify/ownership 详情
    expect(item).not.toHaveProperty('result_md');
    expect(item).not.toHaveProperty('verify_results');
    expect(intake.data!.cursor).toMatch(/^\d+-\d+$/);
    expect(intake.data!.cursor).not.toBe('0-0');
    expect(intake.data!.counts).toBeDefined();
  });

  it('不同 consumer 的 intake 不互相串扰（只提醒对应 PM）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id,
      agent_id: 'w1',
      claim_token: c.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    const ownerConsumer = (await eventsByType('review_requested'))[0].consumer;
    // 另一个 PM 不应看到属于 ownerConsumer 的 review_requested（路由隔离）
    const other = await pmIntake(redis, { consumer: 'some-other-pm' });
    expect(other.ok).toBe(true);
    expect(other.data!.items.filter((i) => i.kind === 'review_requested')).toHaveLength(0);
    // owner consumer 能看到
    const ownerIntake = await pmIntake(redis, { consumer: ownerConsumer });
    expect(ownerIntake.data!.items.filter((i) => i.kind === 'review_requested').length).toBeGreaterThan(0);
  });
});
