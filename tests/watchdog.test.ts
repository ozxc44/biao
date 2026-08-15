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
import { runWatchdog, planSubmit, claim, report, agentRegister, agentOffline, getTask, reconcileRuntimeState } from '../src/server/service.js';
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

/** 造全套异常状态：1 自动修复中的 failed + 1 stale running + 1 历史 stale agent + 1 done 未验收 */
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
  it('legacy failed 只读巡检只建议 watchdog auto-fix，执行后生成 repair 闭环', async () => {
    await redis.flushdb();
    await writeTaskToRedis(redis, {
      task_id: 'legacy-failed-without-resolution',
      title: 'legacy failed without resolution',
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: 5,
    }, '# legacy failed without resolution', 'legacy-plan', '/tmp/biao-test', 5);
    await redis.zrem(keys.zset.status.pending, 'legacy-failed-without-resolution');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'legacy-failed-without-resolution');
    await redis.hset(keys.hash.task('legacy-failed-without-resolution'), {
      status: 'failed',
      failed_reason: 'legacy failure',
      resolution_status: '',
      resolution_task_id: '',
    });

    const readonly = await runWatchdog(redis);
    const legacyProblem = readonly.data?.problems.find((problem) => problem.task_id === 'legacy-failed-without-resolution');
    expect(legacyProblem).toMatchObject({
      type: 'failed',
      suggestion: 'biao watchdog --auto-fix',
      auto_fixable: true,
    });
    expect(legacyProblem?.suggestion).not.toMatch(/\b(?:reset|cancel)\b/);
    expect(await redis.hget(keys.hash.task('legacy-failed-without-resolution'), 'resolution_status')).toBe('');

    await runWatchdog(redis, { autoFix: true });

    expect(await redis.hgetall(keys.hash.task('legacy-failed-without-resolution'))).toMatchObject({
      status: 'failed',
      resolution_status: 'repairing',
      resolution_task_id: 'legacy-failed-without-resolution-repair-1',
    });
    expect(await redis.hgetall(keys.hash.task('legacy-failed-without-resolution-repair-1'))).toMatchObject({
      status: 'pending',
      fix_for: 'legacy-failed-without-resolution',
      repair_root_task_id: 'legacy-failed-without-resolution',
    });
  });

  it('explicitly offline historical agent stays auditable without making watchdog unhealthy', async () => {
    await redis.flushdb();
    await agentRegister(redis, 'retired-worker', 'mock', ['code']);
    await redis.hset(keys.hash.agent('retired-worker'), 'current_task', 'historical-task', 'status', 'busy');

    await agentOffline(redis, 'retired-worker', 'worker_exit');
    await redis.hset(keys.hash.agent('retired-worker'), 'last_heartbeat', String(Date.now() - 10 * 60_000));

    const agent = await redis.hgetall(keys.hash.agent('retired-worker'));
    expect(agent).toMatchObject({
      agent_id: 'retired-worker', status: 'offline', current_task: '',
      last_task: 'historical-task', offline_reason: 'worker_exit',
    });
    expect(Number(agent.registered_at)).toBeGreaterThan(0);
    expect(Number(agent.offline_at)).toBeGreaterThan(0);

    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems.some((problem) => problem.agent_id === 'retired-worker')).toBe(false);
    expect(watchdog.data?.summary.healthy).toBe(true);
  });

  it('发现 stale running / done 未验收；自动修复中的 failed 与历史 idle agent 不反复打扰 PM', async () => {
    await seedProblems();
    const r = await runWatchdog(redis);
    expect(r.ok).toBe(true);
    const types = r.data!.problems.map((p) => p.type);
    expect(types).not.toContain('failed');
    expect(types).toContain('stale_running');
    expect(types).not.toContain('stale_agent');
    expect(types).toContain('done_unreviewed');
    expect(r.data!.summary.healthy).toBe(false);

    // 安全边界：done 未验收不可自动处理；stale 类可自动处理。
    // failed 已进入 repair，不应把“下一步靠 Worker 自动做”的状态再推给 PM。
    const unreviewed = r.data!.problems.find((p) => p.type === 'done_unreviewed')!;
    const staleRun = r.data!.problems.find((p) => p.type === 'stale_running')!;
    expect(unreviewed.auto_fixable).toBe(false);
    expect(staleRun.auto_fixable).toBe(true);
    expect(staleRun.suggestion).toBe('biao watchdog --auto-fix');
    expect(staleRun.suggestion).not.toMatch(/\btask reset\b/);
    // 每个问题都有建议
    for (const p of r.data!.problems) expect(p.suggestion.length).toBeGreaterThan(0);
  });

  it('auto-fix 只处理 stale running，不碰历史 idle agent / repair 中失败任务 / done', async () => {
    const { staleTaskId } = await seedProblems();
    const r = await runWatchdog(redis, { autoFix: true });
    expect(r.ok).toBe(true);

    // stale running → 已 reset 回 pending
    const stale = await getTask(redis, staleTaskId);
    expect(stale.data?.status).toBe('pending');

    // 纯历史 stale idle agent 不是当前问题，不应被 auto-fix 改写审计状态。
    const ghost = await redis.hgetall(keys.hash.agent('ghost-worker'));
    expect(ghost.status).toBe('idle');

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
    expect(r.data!.summary.fixed).toBe(1);
  });

  it('同名 Worker 新注册后，即使旧 lease 未过期也回收不再被 Agent 指向的 running 任务', async () => {
    const { staleTaskId } = await seedProblems();
    // 先恢复 lease，模拟 Supervisor 停止时 Agent 已退出、但长租约仍在。
    await redis.set(keys.string.lease(staleTaskId), 'orphan-token', 'PX', 60_000);
    await agentRegister(
      redis,
      'wd-worker',
      'mock',
      ['code'],
      undefined,
      undefined,
      'replacement-registration-0001',
    );
    expect(await redis.hget(keys.hash.agent('wd-worker'), 'current_task')).toBe('');
    expect(await redis.get(keys.string.lease(staleTaskId))).toBe('orphan-token');

    const readonly = await runWatchdog(redis);
    expect(readonly.data?.problems).toContainEqual(expect.objectContaining({
      type: 'stale_running', task_id: staleTaskId, auto_fixable: true,
    }));

    const reconciled = await reconcileRuntimeState(redis);

    expect(reconciled.data?.reclaimed).toContain(staleTaskId);
    expect((await getTask(redis, staleTaskId)).data?.status).toBe('pending');
    expect(await redis.get(keys.string.lease(staleTaskId))).toBeNull();
  });

  it('纯历史 stale idle agent 不进 problems，不影响 healthy', async () => {
    await redis.flushdb();
    await agentRegister(redis, 'historical-idle', 'mock', ['code']);
    await redis.hset(keys.hash.agent('historical-idle'), {
      last_heartbeat: String(Date.now() - 10 * 60_000),
      status: 'idle',
      current_task: '',
    });

    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems).toEqual([]);
    expect(watchdog.data?.summary).toMatchObject({ total_problems: 0, healthy: true });
  });

  it('指向已终结任务的 stale agent 只作历史审计，不进 problems', async () => {
    await redis.flushdb();
    await agentRegister(redis, 'historical-terminal', 'mock', ['code']);
    await redis.hset(keys.hash.task('historical-done-task'), {
      task_id: 'historical-done-task',
      status: 'done',
      pm_review_status: 'accepted',
      resolution_status: 'resolved',
    });
    await redis.hset(keys.hash.agent('historical-terminal'), {
      last_heartbeat: String(Date.now() - 10 * 60_000),
      status: 'busy',
      current_task: 'historical-done-task',
    });

    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems).toEqual([]);
    expect(watchdog.data?.summary.healthy).toBe(true);
  });

  it('只有 current_task 对应真实 running 时才将 stale agent 列为当前异常', async () => {
    await redis.flushdb();
    await agentRegister(redis, 'stale-running-agent', 'mock', ['code']);
    await redis.hset(keys.hash.task('active-running-task'), {
      task_id: 'active-running-task',
      status: 'running',
      claimed_by: 'stale-running-agent',
    });
    await redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'active-running-task');
    await redis.set(keys.string.lease('active-running-task'), 'active-token', 'EX', 60);
    await redis.hset(keys.hash.agent('stale-running-agent'), {
      last_heartbeat: String(Date.now() - 10 * 60_000),
      status: 'busy',
      current_task: 'active-running-task',
    });

    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems).toEqual([
      expect.objectContaining({
        type: 'stale_agent',
        agent_id: 'stale-running-agent',
        auto_fixable: true,
      }),
    ]);
    expect(watchdog.data?.summary.healthy).toBe(false);
  });

  it('显式 offline 但仍持有 running task 时，lease 失效仍经 stale_running 可见并回收', async () => {
    await redis.flushdb();
    await agentRegister(redis, 'offline-running-agent', 'mock', ['code']);
    await redis.hset(keys.hash.task('offline-running-task'), {
      task_id: 'offline-running-task',
      status: 'running',
      claimed_by: 'offline-running-agent',
      retries: '0',
      max_retries: '2',
      priority: '5',
    });
    await redis.zadd(keys.zset.status.running, Date.now() - 1, 'offline-running-task');
    await redis.hset(keys.hash.agent('offline-running-agent'), {
      status: 'busy',
      current_task: 'offline-running-task',
    });
    await agentOffline(redis, 'offline-running-agent', 'supervisor_signal');

    const watchdog = await runWatchdog(redis, { autoFix: true });
    expect(watchdog.data?.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'stale_running',
        task_id: 'offline-running-task',
        fixed: true,
      }),
    ]));
    expect((await getTask(redis, 'offline-running-task')).data?.status).toBe('pending');
  });

  it('健康状态：无问题时 healthy=true', async () => {
    await redis.flushdb();
    const r = await runWatchdog(redis);
    expect(r.data!.summary.healthy).toBe(true);
    expect(r.data!.problems).toHaveLength(0);
  });
});
