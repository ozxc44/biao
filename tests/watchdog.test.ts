/**
 * PM 巡检（watchdog）测试（对应 biao-ph-pm-watchdog 验收）
 * 模拟各种异常状态：failed / stale running / stale agent / done 未验收，
 * 验证 watchdog 正确发现 + 分类 + auto-fix 安全边界（只动 stale running/agent）
 *
 * ⚠ 不要用生产 Redis 跑本测试：默认连 6380/DB1 测试实例。
 *   redis-server --port 6380 --daemonize yes
 *   REDIS_URL=redis://localhost:6380/1 npx vitest run tests/watchdog.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { join } from 'node:path';
import { runWatchdog, planSubmit, claim, report, agentRegister, getTask } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';
import { writeTaskToRedis } from '../src/redis/ownership.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const FIXTURES = join(import.meta.dirname, 'fixtures');

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
});

afterAll(() => {
  redis.disconnect();
});

/** 造全套异常状态：1 自动修复中的 failed + 1 stale running + 1 stale agent + 1 done 未验收 */
async function seedProblems() {
  await redis.flushdb();
  await planSubmit(redis, join(FIXTURES, 'test-plan'));
  await planSubmit(redis, join(FIXTURES, 'plan-other'));
  await agentRegister(redis, 'wd-worker', 'mock', ['code']);

  // done 未验收：先完成 DAG 根任务，不 review
  const c1 = await claim(redis, { agent_id: 'wd-worker', blocking: false, timeout_ms: 100 });
  await report(redis, {
    task_id: c1.data!.task_id,
    agent_id: 'wd-worker',
    claim_token: c1.data!.claim_token,
    status: 'done',
    verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
  });

  // stale running：先领取独立计划的任务，再让 lease 失效。
  const c2 = await claim(redis, { agent_id: 'wd-worker', blocking: false, timeout_ms: 100 });
  expect(c2.data?.task_id).toBe('test-other-01');
  await redis.del(keys.string.lease(c2.data!.task_id));

  // failed：独立种入一个不依赖 T01 的任务。不能把 T02 当作 failed，
  // 因为严格依赖门要求 T01 必须先经 PM accepted。
  await writeTaskToRedis(redis, {
    task_id: 'watchdog-failed',
    title: 'watchdog failed task',
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
  }, '# watchdog failed task', 'test-m0-plan', '/tmp/biao-test', 5);
  await agentRegister(redis, 'failure-worker', 'mock', ['code']);
  const failedClaim = await claim(redis, { agent_id: 'failure-worker', blocking: false, timeout_ms: 100 });
  expect(failedClaim.data?.task_id).toBe('watchdog-failed');
  await report(redis, {
    task_id: failedClaim.data!.task_id,
    agent_id: 'failure-worker',
    claim_token: failedClaim.data!.claim_token,
    status: 'failed',
  });

  // stale agent：注册一个心跳时间很旧的 agent
  await agentRegister(redis, 'ghost-worker', 'mock', ['code']);
  await redis.hset(keys.hash.agent('ghost-worker'), {
    last_heartbeat: String(Date.now() - 10 * 60_000), // 10 分钟前
    status: 'idle',
  });

  return { staleTaskId: c2.data!.task_id };
}

describe('runWatchdog 问题发现与分类', () => {
  it('发现 stale running / stale agent / done 未验收；自动修复中的 failed 不反复打扰 PM', async () => {
    await seedProblems();
    const r = await runWatchdog(redis);
    expect(r.ok).toBe(true);
    const types = r.data!.problems.map((p) => p.type);
    expect(types).not.toContain('failed');
    expect(types).toContain('stale_running');
    expect(types).toContain('stale_agent');
    expect(types).toContain('done_unreviewed');
    expect(r.data!.summary.healthy).toBe(false);

    // 安全边界：done 未验收不可自动处理；stale 类可自动处理。
    // failed 已进入 repair，不应把“下一步靠 Worker 自动做”的状态再推给 PM。
    const unreviewed = r.data!.problems.find((p) => p.type === 'done_unreviewed')!;
    const staleRun = r.data!.problems.find((p) => p.type === 'stale_running')!;
    const staleAgent = r.data!.problems.find((p) => p.type === 'stale_agent')!;
    expect(unreviewed.auto_fixable).toBe(false);
    expect(staleRun.auto_fixable).toBe(true);
    expect(staleAgent.auto_fixable).toBe(true);
    // 每个问题都有建议
    for (const p of r.data!.problems) expect(p.suggestion.length).toBeGreaterThan(0);
  });

  it('auto-fix 只处理 stale running + stale agent，不碰 repair 中失败任务 / done', async () => {
    const { staleTaskId } = await seedProblems();
    const r = await runWatchdog(redis, { autoFix: true });
    expect(r.ok).toBe(true);

    // stale running → 已 reset 回 pending
    const stale = await getTask(redis, staleTaskId);
    expect(stale.data?.status).toBe('pending');

    // stale agent → 已标记 offline
    const ghost = await redis.hgetall(keys.hash.agent('ghost-worker'));
    expect(ghost.status).toBe('offline');

    // failed → 不被 watchdog reset，仍由 repair 闭环接管。
    const failedIds = await redis.zrange(keys.zset.status.failed, 0, -1);
    expect(failedIds.length).toBe(1);
    expect(await redis.hget(keys.hash.task('watchdog-failed'), 'resolution_status')).toBe('repairing');

    // done 未验收 → 没被自动验收（pm_review_status 仍为空）
    const doneIds = await redis.zrange(keys.zset.status.done, 0, -1);
    expect(doneIds.length).toBe(1);
    const doneHash = await redis.hgetall(keys.hash.task(doneIds[0]));
    expect(doneHash.pm_review_status ?? '').toBe('');

    // 修复计数正确
    expect(r.data!.summary.fixed).toBe(2);
  });

  it('健康状态：无问题时 healthy=true', async () => {
    await redis.flushdb();
    const r = await runWatchdog(redis);
    expect(r.data!.summary.healthy).toBe(true);
    expect(r.data!.problems).toHaveLength(0);
  });
});
