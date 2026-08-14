import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerQuestion,
  cancelTask,
  createQuestion,
  dbRestore,
  getPlan,
  getPlans,
  getStatus,
  planSubmit,
  pmIntake,
  pmReview,
  reconcileResolutionBacklog,
  setSqliteStore,
  supersedeTask,
  taskReset,
} from '../src/server/service.js';
import { SqliteStore, type PlanRow, type TaskRow } from '../src/db/sqlite-store.js';
import { keys } from '../src/redis/keys.js';

// Dedicated non-production Redis DB. This suite must never share the product DB or
// another suite's DB because it deliberately seeds ten thousand historical tasks.
const REDIS_URL = process.env.STATUS_PROJECTION_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/13';
const PLAN_ID = 'status-projection-plan';
const PROJECT_PATH = join(tmpdir(), 'biao-status-projection-project');

let redis: Redis;
let verifier: Redis;
const temporaryPaths: string[] = [];

type RedisCommandLike = { name?: string; args?: unknown[] };

function commandScript(command: RedisCommandLike): string {
  return String(command.args?.[0] ?? '');
}

/**
 * 模拟“Redis 已提交，但进程在收到响应前退出/网络断开”。独立 verifier 在提交前
 * 清理旧 dirty，随后只检查 Redis 最终态；因此测试不能被事后 persist/补偿蒙混。
 */
async function failAfterCommittedCommand<T>(
  target: Redis,
  matcher: (command: RedisCommandLike) => boolean,
  operation: () => Promise<T>,
  beforeCommit?: () => Promise<void>,
): Promise<{ hit: boolean; value?: T; error?: unknown }> {
  const client = target as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
  const original = client.sendCommand;
  let hit = false;
  client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
    if (hit || !matcher(command)) return original.call(this, command, ...args) as Promise<unknown>;
    hit = true;
    return (async () => {
      if (beforeCommit) await beforeCommit();
      await original.call(this, command, ...args);
      throw new Error('injected_disconnect_after_redis_commit');
    })();
  } as typeof client.sendCommand;
  try {
    const value = await operation();
    return { hit, value };
  } catch (error) {
    return { hit, error };
  } finally {
    client.sendCommand = original;
  }
}

/** Multi/Pipeline internally uses callbacks and does not propagate a sendCommand override's
 * returned promise. Wrap the transaction's own exec to inject the same post-commit failure. */
async function failAfterCommittedMulti<T>(
  target: Redis,
  operation: () => Promise<T>,
  beforeCommit?: () => Promise<void>,
): Promise<{ hit: boolean; value?: T; error?: unknown }> {
  const originalMulti = target.multi;
  let hit = false;
  target.multi = function interceptMulti(...args: Parameters<Redis['multi']>) {
    const transaction = originalMulti.apply(this, args);
    if (hit) return transaction;
    const originalExec = transaction.exec.bind(transaction);
    transaction.exec = (async (...execArgs: Parameters<typeof transaction.exec>) => {
      if (beforeCommit) await beforeCommit();
      const result = await originalExec(...execArgs);
      hit = true;
      throw new Error('injected_disconnect_after_redis_commit');
    }) as typeof transaction.exec;
    return transaction;
  } as typeof target.multi;
  try {
    const value = await operation();
    return { hit, value };
  } catch (error) {
    return { hit, error };
  } finally {
    target.multi = originalMulti;
  }
}

async function seedPlan(planId = PLAN_ID, taskCount = 0): Promise<void> {
  await redis.hset(keys.hash.plan(planId), {
    plan_id: planId,
    title: planId,
    status: 'submitted',
    project_path: PROJECT_PATH,
    task_count: String(taskCount),
    created_at: '1700000000000',
    phases: '[]',
  });
}

async function seedTasks(
  tasks: Array<{
    task_id: string;
    status: string;
    pm_review_status?: string;
    resolution_status?: string;
    repair_root_task_id?: string;
    fix_for?: string;
    resolution_task_id?: string;
    resolution_task_ids?: string;
    resolved_by_task?: string;
    resolution_attempts?: string;
    max_retries?: string;
    pm_accept_effects_applied?: string;
    supersede_batch_size?: string;
  }>,
): Promise<void> {
  const pipeline = redis.pipeline();
  const now = 1_700_000_000_000;
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    pipeline.hset(keys.hash.task(task.task_id), {
      task_id: task.task_id,
      plan_id: PLAN_ID,
      title: task.task_id,
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: '5',
      status: task.status,
      depends_on: '',
      ownership_files: '',
      ownership_modules: '',
      timeout_seconds: '60',
      max_retries: task.max_retries ?? '2',
      retries: '0',
      acceptance_for: '',
      verify: '[]',
      goal_md: `# ${task.task_id}`,
      project_path: PROJECT_PATH,
      created_at: String(now + index),
      done_at: task.status === 'done' ? String(now + index) : '',
      pm_review_status: task.pm_review_status ?? '',
      pm_accept_effects_applied: task.pm_accept_effects_applied ?? (task.pm_review_status === 'accepted' ? 'true' : ''),
      resolution_status: task.resolution_status ?? '',
      resolution_action: '',
      resolution_task_id: task.resolution_task_id ?? '',
      resolution_task_ids: task.resolution_task_ids ?? '',
      resolved_by_task: task.resolved_by_task ?? '',
      repair_root_task_id: task.repair_root_task_id ?? '',
      fix_for: task.fix_for ?? '',
      resolution_attempts: task.resolution_attempts ?? '0',
      supersede_batch_size: task.supersede_batch_size ?? '0',
    });
    const statusKey = (keys.zset.status as Record<string, string>)[task.status];
    pipeline.zadd(statusKey, now + index, task.task_id);
  }
  const outcomes = await pipeline.exec();
  if (!outcomes || outcomes.some(([error]) => error)) throw new Error('failed to seed projection tasks');
}

async function seedAcceptedHistory(size: number): Promise<void> {
  await seedPlan(PLAN_ID, size);
  const batchSize = 1_000;
  for (let offset = 0; offset < size; offset += batchSize) {
    await seedTasks(Array.from({ length: Math.min(batchSize, size - offset) }, (_, index) => ({
      task_id: `accepted-history-${offset + index}`,
      status: 'done',
      pm_review_status: 'accepted',
    })));
  }
}

async function seedResolvedFailedHistory(size: number): Promise<void> {
  await seedPlan(PLAN_ID, size + 1);
  const batchSize = 1_000;
  for (let offset = 0; offset < size; offset += batchSize) {
    await seedTasks(Array.from({ length: Math.min(batchSize, size - offset) }, (_, index) => ({
      task_id: `resolved-failed-${offset + index}`,
      status: 'failed',
      resolution_status: 'resolved',
    })));
  }
  await seedTasks([{ task_id: 'actionable-failed', status: 'failed', resolution_status: 'needs_pm_decision' }]);
}

async function counted<T>(operation: () => Promise<T>): Promise<{
  result: T;
  commands: number;
  taskHashReads: number;
  terminalHistoryReads: number;
}> {
  const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
  const original = client.sendCommand;
  let commands = 0;
  let taskHashReads = 0;
  let terminalHistoryReads = 0;
  client.sendCommand = function countCommand(command: { name?: string; args?: unknown[] }, ...args: unknown[]) {
    commands++;
    const name = command?.name?.toLowerCase();
    const key = String(command.args?.[0] ?? '');
    if (name === 'hgetall' && key.startsWith('biao:v1:hash:task:')) taskHashReads++;
    if (name === 'zrange' && (key === keys.zset.status.done || key === keys.zset.status.failed)) {
      terminalHistoryReads++;
    }
    return original.call(this, command, ...args) as Promise<unknown>;
  } as typeof client.sendCommand;
  try {
    return { result: await operation(), commands, taskHashReads, terminalHistoryReads };
  } finally {
    client.sendCommand = original;
  }
}

function durableTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: 'restored-accepted',
    plan_id: PLAN_ID,
    title: 'restored-accepted',
    type: 'code',
    phase: 'impl',
    status: 'done',
    priority: 5,
    assignee: 'auto',
    ownership_files: '',
    ownership_modules: '',
    depends_on: '',
    timeout_seconds: 60,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '[]',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '1700000001000',
    retries: 0,
    pm_review_status: 'accepted',
    pm_reviewed_by: 'pm-test',
    pm_reviewed_at: '1700000002000',
    pm_review_comment: '',
    pm_accept_effects_applied: 'true',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    repair_ownership_extension: '',
    pm_repair_ownership_required: '',
    pm_repair_ownership_intent: '',
    failure_reason: '',
    fix_for: '',
    repair_root_task_id: '',
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: 0,
    resolution_attempts: 0,
    resolution_decision_reason: '',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    last_question_id: '',
    last_question_answer: '',
    cancelled_at: '',
    superseded_at: '',
    superseded_by: '',
    superseded_reason: '',
    supersede_preview_token: '',
    supersede_batch_size: 0,
    verify_results: '[]',
    goal_md: '# restored',
    created_at: '1700000000000',
    updated_at: '1700000002000',
    ...overrides,
  };
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  verifier = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const existing = await redis.dbsize();
  if (existing !== 0) {
    redis.disconnect();
    verifier.disconnect();
    throw new Error(`isolated Redis ${REDIS_URL} is not empty (${existing} keys); refusing to overwrite it`);
  }
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterAll(async () => {
  setSqliteStore(null);
  if (redis.status !== 'end') {
    await redis.flushdb();
    redis.disconnect();
  }
  if (verifier.status !== 'end') verifier.disconnect();
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
});

describe('plan/status materialized projection', () => {
  it('keeps steady /plans and /status Redis work constant with ten thousand historical tasks', async () => {
    await seedAcceptedHistory(10_000);
    // 保持 plan 为 active，证明轮询复杂度不是靠“只跳过 completed plan”取巧：
    // 同一 active plan 内 9,999 条 accepted 历史也不得被稳态重复读取。
    await redis.zrem(keys.zset.status.done, 'accepted-history-9999');
    await redis.zadd(keys.zset.status.running, 1_700_000_010_000, 'accepted-history-9999');
    await redis.hset(keys.hash.task('accepted-history-9999'), {
      status: 'running',
      pm_review_status: '',
      pm_accept_effects_applied: '',
      done_at: '',
    });

    // The first concurrent reads are the explicit legacy upgrade/backfill boundary. Only one
    // caller may publish the snapshot; waiters reuse its durable marker.
    const [initialStatus, initialPlans] = await Promise.all([getStatus(redis), getPlans(redis)]);
    expect(initialStatus.ok).toBe(true);
    expect(initialPlans.ok).toBe(true);

    const plansRound = await counted(() => getPlans(redis));
    const statusRound = await counted(() => getStatus(redis));
    const plans = plansRound.result.data?.plans ?? [];

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      plan_id: PLAN_ID,
      status: 'active',
      tasks: { done: 9_999, running: 1 },
      reviews: { accepted: 9_999 },
    });
    expect(plansRound.taskHashReads).toBe(0);
    // /status 允许读取当前 running task 来核对 lease 与 Agent current_task，
    // 以发现同名 Worker 重注册后被在线状态掩盖的孤儿；仍不得读取万级终态历史。
    expect(statusRound.taskHashReads).toBeLessThanOrEqual(1);
    expect(statusRound.terminalHistoryReads).toBe(0);
    expect(plansRound.commands).toBeLessThan(30);
    expect(statusRound.commands).toBeLessThan(50);
    // 保留可审计的精确命令数；CI 日志能直接证明万级历史稳态没有退化。
    console.info(JSON.stringify({
      planStatusProjectionCommandCounts: {
        historyTasks: 10_000,
        plans: plansRound.commands,
        status: statusRound.commands,
        taskHashReads: plansRound.taskHashReads + statusRound.taskHashReads,
        terminalHistoryReads: statusRound.terminalHistoryReads,
      },
    }));
  }, 40_000);

  it('preserves derived plan, review, attention and resolved-history semantics', async () => {
    await seedPlan(PLAN_ID, 6);
    await seedTasks([
      { task_id: 'pending', status: 'pending' },
      { task_id: 'accepted', status: 'done', pm_review_status: 'accepted' },
      { task_id: 'review-pending', status: 'done' },
      { task_id: 'rejected-resolved', status: 'done', pm_review_status: 'rejected', resolution_status: 'resolved' },
      { task_id: 'failed-decision', status: 'failed', resolution_status: 'needs_pm_decision' },
      { task_id: 'cancelled', status: 'cancelled' },
    ]);

    const plans = (await getPlans(redis)).data?.plans ?? [];
    expect(plans[0]).toMatchObject({
      status: 'failed',
      tasks: { pending: 1, done: 3, failed: 1, cancelled: 1 },
      reviews: { pending: 1, accepted: 1, rejected: 1 },
    });

    const status = (await getStatus(redis)).data as {
      reviews: { pending: number; accepted: number; rejected: number };
      attention: { failed: number; rejected: number; needs_pm_decision: number };
      history: { resolved_failed: number; resolved_rejected: number };
    };
    expect(status.reviews).toEqual({ pending: 1, accepted: 1, rejected: 1 });
    expect(status.attention).toMatchObject({ failed: 1, rejected: 0, needs_pm_decision: 1 });
    expect(status.history).toMatchObject({ resolved_failed: 0, resolved_rejected: 1 });
  });

  it('keeps rejected repair-chain ancestors as audit without counting resolved children as current attention', async () => {
    await seedPlan(PLAN_ID, 4);
    await seedTasks([
      {
        task_id: 'resolved-root', status: 'done', pm_review_status: 'rejected',
        resolution_status: 'resolved', resolution_task_id: 'resolved-repair-2',
        resolution_task_ids: 'resolved-repair-1,resolved-repair-2',
        resolved_by_task: 'resolved-repair-2',
      },
      {
        task_id: 'resolved-repair-1', status: 'done', pm_review_status: 'rejected',
        repair_root_task_id: 'resolved-root', fix_for: 'resolved-root',
      },
      {
        task_id: 'resolved-repair-2', status: 'done', pm_review_status: 'accepted',
        repair_root_task_id: 'resolved-root', fix_for: 'resolved-repair-1',
      },
      {
        task_id: 'current-rejected', status: 'done', pm_review_status: 'rejected',
      },
    ]);

    const status = (await getStatus(redis)).data as {
      reviews: { pending: number; accepted: number; rejected: number };
      attention: { failed: number; rejected: number; needs_pm_decision: number };
      history: { resolved_failed: number; resolved_rejected: number };
    };
    expect(status.reviews).toEqual({ pending: 0, accepted: 1, rejected: 3 });
    expect((status as typeof status & { root_reviews: typeof status.reviews }).root_reviews)
      .toEqual({ pending: 0, accepted: 1, rejected: 1 });
    expect(status.attention).toMatchObject({ rejected: 1, needs_pm_decision: 0 });
    expect(status.history).toMatchObject({ resolved_rejected: 2 });
  });

  it('publishes root review counts separately from immutable attempt audit counts', async () => {
    await seedPlan(PLAN_ID, 3);
    await seedTasks([
      { task_id: 'clean-accepted-root', status: 'done', pm_review_status: 'accepted' },
      {
        task_id: 'repaired-root', status: 'done', pm_review_status: 'rejected',
        resolution_status: 'resolved', resolution_task_id: 'repaired-root-repair-2',
        resolution_task_ids: 'repaired-root-repair-1,repaired-root-repair-2',
        resolved_by_task: 'repaired-root-repair-2',
      },
      {
        task_id: 'repaired-root-repair-1', status: 'done', pm_review_status: 'rejected',
        fix_for: 'repaired-root', repair_root_task_id: 'repaired-root',
      },
      {
        task_id: 'repaired-root-repair-2', status: 'done', pm_review_status: 'accepted',
        fix_for: 'repaired-root-repair-1', repair_root_task_id: 'repaired-root',
      },
      {
        task_id: 'reviewing-root', status: 'done', pm_review_status: 'rejected',
        resolution_status: 'required', resolution_task_id: 'reviewing-root-repair-1',
        resolution_task_ids: 'reviewing-root-repair-1',
      },
      {
        task_id: 'reviewing-root-repair-1', status: 'done',
        fix_for: 'reviewing-root', repair_root_task_id: 'reviewing-root',
      },
    ]);

    const plan = (await getPlans(redis)).data!.plans[0];
    expect(plan.reviews).toEqual({ pending: 1, accepted: 2, rejected: 3 });
    expect(plan.root_reviews).toEqual({ pending: 1, accepted: 2, rejected: 0 });

    const status = (await getStatus(redis)).data as {
      reviews: { pending: number; accepted: number; rejected: number };
      root_reviews: { pending: number; accepted: number; rejected: number };
    };
    expect(status.reviews).toEqual({ pending: 1, accepted: 2, rejected: 3 });
    expect(status.root_reviews).toEqual({ pending: 1, accepted: 2, rejected: 0 });
  });

  it('publishes a complete mutually exclusive root lifecycle whose total matches the declared plan', async () => {
    await seedPlan(PLAN_ID, 4);
    await seedTasks([
      { task_id: 'root-accepted', status: 'done', pm_review_status: 'accepted' },
      {
        task_id: 'root-repairing', status: 'done', pm_review_status: 'rejected',
        resolution_status: 'repairing', resolution_task_id: 'root-repairing-repair-1',
        resolution_task_ids: 'root-repairing-repair-1',
      },
      {
        task_id: 'root-repairing-repair-1', status: 'pending', fix_for: 'root-repairing',
        repair_root_task_id: 'root-repairing',
      },
      {
        task_id: 'root-decision', status: 'failed', resolution_status: 'needs_pm_decision',
      },
      {
        task_id: 'root-cancelled', status: 'done', pm_review_status: 'rejected',
        resolution_status: 'cancelled',
      },
    ]);

    const plan = (await getPlans(redis)).data!.plans[0] as unknown as {
      root_tasks: Record<string, number | boolean>;
    };
    expect(plan.root_tasks).toMatchObject({
      total: 4,
      declared_total: 4,
      accepted: 1,
      pending: 1,
      needs_pm_decision: 1,
      cancelled: 1,
      consistent: true,
    });
    const classified = ['pending', 'running', 'blocked', 'review_pending', 'accepted', 'failed', 'needs_pm_decision', 'cancelled']
      .reduce((sum, field) => sum + Number(plan.root_tasks[field]), 0);
    expect(classified).toBe(4);

    const status = (await getStatus(redis)).data as unknown as {
      root_tasks: Record<string, number>;
    };
    expect(status.root_tasks).toMatchObject({
      total: 4,
      accepted: 1,
      pending: 1,
      needs_pm_decision: 1,
      cancelled: 1,
    });
  });

  it('projects the current active child ahead of a stale needs-decision root marker', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([
      {
        task_id: 'stale-decision-root', status: 'failed', resolution_status: 'needs_pm_decision',
        resolution_task_id: 'stale-decision-root-reverify-3',
        resolution_task_ids: 'stale-decision-root-reverify-1,stale-decision-root-reverify-2,stale-decision-root-reverify-3',
      },
      {
        task_id: 'stale-decision-root-reverify-3', status: 'running',
        fix_for: 'stale-decision-root', repair_root_task_id: 'stale-decision-root',
      },
    ]);

    const plan = (await getPlans(redis)).data!.plans[0];
    expect(plan.status).toBe('active');
    expect(plan.root_tasks).toMatchObject({ running: 1, needs_pm_decision: 0 });
  });

  it('uses the plan task registry for both plan summary and detail even when a pending status index is missing', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'registry-root', status: 'failed' }]);
    await redis.hset(keys.hash.task('registry-ghost-repair'), {
      task_id: 'registry-ghost-repair', plan_id: PLAN_ID, project_path: PROJECT_PATH,
      title: 'registry ghost', type: 'code', phase: 'impl', assignee: 'auto', priority: '5',
      status: 'pending', fix_for: 'registry-root', repair_root_task_id: 'registry-root',
      ownership_files: '', depends_on: '', created_at: String(Date.now()),
    });
    await redis.sadd(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), 'registry-ghost-repair');
    await redis.sadd(keys.planStatusProjection.dirtyPlans, PLAN_ID);

    const summary = (await getPlans(redis)).data!.plans[0] as unknown as { runtime_task_count: number };
    const detail = (await getPlan(redis, PLAN_ID)).data as {
      runtime_task_count: number;
      tasks: { pending: Array<{ task_id: string }> };
    };
    expect(summary.runtime_task_count).toBe(2);
    expect(detail.runtime_task_count).toBe(2);
    expect(detail.tasks.pending.map((task) => task.task_id)).toContain('registry-ghost-repair');
  });

  it('publishes a ready, correct projection as part of SQLite restore', async () => {
    const store = new SqliteStore(':memory:');
    const plan: PlanRow = {
      plan_id: PLAN_ID,
      title: PLAN_ID,
      status: 'submitted',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 1,
      created_at: '1700000000000',
      submitted_at: '1700000001000',
      pm_consumer: 'pm-test',
    };
    try {
      store.upsertPlan(plan);
      store.upsertTask(durableTask());
      await dbRestore(redis, store);

      const first = await counted(() => getStatus(redis));
      const second = await counted(() => getPlans(redis));
      expect(first.result.data).toMatchObject({
        reviews: { accepted: 1 },
        plans: [{ plan_id: PLAN_ID, status: 'completed' }],
      });
      expect(second.result.data?.plans[0]).toMatchObject({
        status: 'completed',
        tasks: { done: 1 },
        reviews: { accepted: 1 },
      });
      expect(first.taskHashReads).toBe(0);
      expect(second.taskHashReads).toBe(0);
      expect(await redis.get(keys.planStatusProjection.ready)).toBe('5');
    } finally {
      store.close();
    }
  });

  it('rebuilds registries when the ready marker belongs to an older projection version', async () => {
    await seedPlan(PLAN_ID, 2);
    await seedTasks([
      { task_id: 'upgrade-root', status: 'done', pm_review_status: 'accepted' },
      {
        task_id: 'upgrade-root-repair-1',
        status: 'done',
        pm_review_status: 'accepted',
        fix_for: 'upgrade-root',
        repair_root_task_id: 'upgrade-root',
      },
    ]);
    await redis.set(keys.planStatusProjection.ready, '4');
    await redis.set(keys.planStatusProjection.agentIdsReady, '4');
    await redis.sadd(keys.planStatusProjection.planIds, 'stale-plan');
    await redis.sadd(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), 'missing-hash-task');
    await redis.hset(keys.planStatusProjection.aggregateByPlan(PLAN_ID), {
      version: '4', status: 'active', runtime_task_count: '1',
    });

    const detail = await getPlan(redis, PLAN_ID);

    expect(detail.data).toMatchObject({
      task_count: 2,
      runtime_task_count: 2,
      root_tasks: { total: 1, accepted: 1, consistent: false },
    });
    expect(await redis.get(keys.planStatusProjection.ready)).toBe('5');
    expect(await redis.get(keys.planStatusProjection.agentIdsReady)).toBe('5');
    expect(await redis.smembers(keys.planStatusProjection.planIds)).toEqual([PLAN_ID]);
    expect((await redis.smembers(keys.planStatusProjection.taskIdsByPlan(PLAN_ID))).sort()).toEqual([
      'upgrade-root',
      'upgrade-root-repair-1',
    ]);
  });

  it('moves a terminal plan back to current work through the transition-maintained dirty index', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'accepted', status: 'done', pm_review_status: 'accepted' }]);
    expect((await getPlans(redis)).data?.plans[0]).toMatchObject({ status: 'completed' });

    const reset = await taskReset(redis, 'accepted', { force: true, reset_by: 'pm-test' });
    expect(reset.ok).toBe(true);
    expect(await redis.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);

    const round = await counted(() => getPlans(redis));
    expect(round.result.data?.plans[0]).toMatchObject({
      status: 'active',
      tasks: { pending: 1, done: 0 },
      reviews: { pending: 0, accepted: 0, rejected: 0 },
    });
    expect(await redis.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(0);
    expect(round.taskHashReads).toBeLessThanOrEqual(2);
  });

  it.each([
    ['reset', async () => taskReset(redis, 'atomic-task', { force: true, reset_by: 'pm-test' }), 'pending', 'eval'],
    ['cancel', async () => cancelTask(redis, 'atomic-task', { reason: '原子投影测试' }), 'cancelled', 'multi'],
  ])('commits %s truth and projection dirty in the same Redis transaction', async (_name, operation, expectedStatus, commitKind) => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'atomic-task', status: expectedStatus === 'pending' ? 'done' : 'pending', pm_review_status: expectedStatus === 'pending' ? 'accepted' : '' }]);
    await getPlans(redis);

    const fault = commitKind === 'eval'
      ? await failAfterCommittedCommand(
          redis,
          (command) => command.name?.toLowerCase() === 'eval' &&
            commandScript(command).includes('commit-task-reset-round-cas-v1'),
          operation,
          async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
        )
      : await failAfterCommittedMulti(
          redis,
          operation,
          async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
        );

    expect(fault.hit).toBe(true);
    expect(String((fault.error as Error)?.message ?? '')).toContain('injected_disconnect_after_redis_commit');
    expect(await verifier.hget(keys.hash.task('atomic-task'), 'status')).toBe(expectedStatus);
    expect(await verifier.sismember(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), 'atomic-task')).toBe(1);
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);
  });

  it('atomically indexes a plan-submit task even when the caller disappears after EXEC', async () => {
    const planDir = mkdtempSync(join(tmpdir(), 'biao-projection-plan-submit-'));
    temporaryPaths.push(planDir);
    const projectDir = join(planDir, 'project');
    mkdirSync(join(planDir, 'tasks'));
    mkdirSync(projectDir);
    writeFileSync(join(planDir, 'index.md'), `---
plan_id: atomic-submit-plan
title: Atomic submit
project_path: ${projectDir}
phases:
  - id: impl
    name: impl
---
`);
    writeFileSync(join(planDir, 'tasks', 'task.md'), `---
task_id: atomic-submit-task
title: Atomic submit task
type: code
phase: impl
---
`);

    const fault = await failAfterCommittedMulti(
      redis,
      async () => planSubmit(redis, planDir),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, 'atomic-submit-plan').then(() => undefined),
    );

    expect(fault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task('atomic-submit-task'), 'status')).toBe('pending');
    expect(await verifier.sismember(keys.planStatusProjection.planIds, 'atomic-submit-plan')).toBe(1);
    expect(await verifier.sismember(keys.planStatusProjection.taskIdsByPlan('atomic-submit-plan'), 'atomic-submit-task')).toBe(1);
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, 'atomic-submit-plan')).toBe(1);
  });

  it('atomically marks a superseded truth dirty before later doorbell cleanup', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'supersede-atomic', status: 'done' }]);
    await getPlans(redis);

    const fault = await failAfterCommittedCommand(
      redis,
      (command) => command.name?.toLowerCase() === 'eval' &&
        commandScript(command).includes('commit-supersede-round-fenced-v1'),
      () => supersedeTask(redis, 'supersede-atomic', {
        confirmed: true,
        reason: 'fault-injection projection check',
        superseded_by: 'pm-test',
      }),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
    );

    expect(fault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task('supersede-atomic'), 'status')).toBe('superseded');
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);
  });

  it('atomically marks Question block and answer transitions dirty', async () => {
    const taskId = 'question-atomic';
    const agentId = 'question-worker';
    const claimToken = 'question-claim-token';
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: taskId, status: 'running' }]);
    await redis.hset(keys.hash.task(taskId), 'claimed_by', agentId, 'claimed_at', String(Date.now()));
    await redis.set(keys.string.lease(taskId), claimToken, 'EX', 60);
    await redis.hset(keys.hash.agent(agentId), {
      agent_id: agentId,
      status: 'busy',
      current_task: taskId,
      last_heartbeat: String(Date.now()),
    });
    await getPlans(redis);

    const blockedFault = await failAfterCommittedCommand(
      redis,
      (command) => command.name?.toLowerCase() === 'eval' && commandScript(command).includes("'question_asked'"),
      () => createQuestion(redis, {
        task_id: taskId,
        agent_id: agentId,
        claim_token: claimToken,
        body: '需要 PM 决策',
        checkpoint: 'atomic-question',
      }),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
    );
    expect(blockedFault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task(taskId), 'status')).toBe('blocked');
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);

    const questionId = await verifier.get(keys.question.openByTask(taskId));
    expect(questionId).toBeTruthy();
    const answerFault = await failAfterCommittedCommand(
      redis,
      (command) => command.name?.toLowerCase() === 'eval' && commandScript(command).includes("'_question_answered_'"),
      () => answerQuestion(redis, questionId!, { consumer: 'pm', answer: '按 A 方案继续' }),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
    );
    expect(answerFault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task(taskId), 'status')).toBe('pending');
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);
  });

  it('updates review and terminal status through the atomic PM-review dirty marker', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'awaiting-review', status: 'done' }]);
    expect((await getPlans(redis)).data?.plans[0]).toMatchObject({
      status: 'active',
      reviews: { pending: 1, accepted: 0 },
    });

    const reviewed = await pmReview(redis, 'awaiting-review', {
      verdict: 'accept',
      reviewed_by: 'pm-test',
    });
    expect(reviewed.ok).toBe(true);
    expect(await redis.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);

    expect((await getPlans(redis)).data?.plans[0]).toMatchObject({
      status: 'completed',
      reviews: { pending: 0, accepted: 1 },
    });
    expect(await redis.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(0);
  });

  it('never lets an older PM review commit accepted after a concurrent reset starts a new round', async () => {
    const taskId = 'review-reset-race';
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: taskId, status: 'done' }]);
    await redis.zadd(keys.reviewRequested.pending, Date.now(), taskId);

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let heldReviewSnapshot = false;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!heldReviewSnapshot && command.name?.toLowerCase() === 'hgetall' &&
          String(command.args?.[0] ?? '') === keys.hash.task(taskId)) {
        heldReviewSnapshot = true;
        return (async () => {
          const snapshot = await original.call(this, command, ...args);
          entered();
          await releasePromise;
          return snapshot;
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;

    const reviewPromise = pmReview(redis, taskId, { verdict: 'accept', reviewed_by: 'pm-race' });
    try {
      await enteredPromise;
      const resetPromise = taskReset(verifier, taskId, { force: true, reset_by: 'pm-reset' });
      // In the broken implementation reset does not share the decision lock and reaches pending
      // before the paused review commits. A fixed implementation may instead wait for the lock.
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await verifier.hget(keys.hash.task(taskId), 'status') === 'pending') break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      release();
      await Promise.all([reviewPromise, resetPromise]);
    } finally {
      release();
      client.sendCommand = original;
    }

    expect(heldReviewSnapshot).toBe(true);
    const final = await verifier.hgetall(keys.hash.task(taskId));
    expect({ status: final.status, review: final.pm_review_status }).not.toEqual({
      status: 'pending',
      review: 'accepted',
    });
    if (final.status === 'pending') expect(final.pm_review_status).toBe('');
  });

  it('rejects a PM review whose done generation changed after its snapshot', async () => {
    const taskId = 'review-generation-cas';
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: taskId, status: 'done' }]);
    await redis.zadd(keys.reviewRequested.pending, Date.now(), taskId);

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let heldReviewSnapshot = false;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!heldReviewSnapshot && command.name?.toLowerCase() === 'hgetall' &&
          String(command.args?.[0] ?? '') === keys.hash.task(taskId)) {
        heldReviewSnapshot = true;
        return (async () => {
          const snapshot = await original.call(this, command, ...args);
          entered();
          await releasePromise;
          return snapshot;
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;

    const reviewPromise = pmReview(redis, taskId, { verdict: 'accept', reviewed_by: 'pm-race' });
    try {
      await enteredPromise;
      await verifier.hset(keys.hash.task(taskId), {
        status: 'pending',
        done_at: '',
        pm_review_status: '',
      });
      await verifier.zrem(keys.zset.status.done, taskId);
      await verifier.zadd(keys.zset.status.pending, Date.now(), taskId);
      release();
      const review = await reviewPromise;
      expect(review.ok).toBe(false);
      expect(review.error?.code).toBe('TASK_REVIEW_ROUND_CHANGED');
    } finally {
      release();
      client.sendCommand = original;
    }

    expect(heldReviewSnapshot).toBe(true);
    expect(await verifier.hget(keys.hash.task(taskId), 'pm_review_status')).toBe('');
  });

  it('atomically marks needs_pm_decision and resolved lineage mutations dirty', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{
      task_id: 'decision-root',
      status: 'failed',
      resolution_attempts: '1',
      max_retries: '1',
    }]);
    await getPlans(redis);

    const decisionFault = await failAfterCommittedCommand(
      redis,
      (command) => command.name?.toLowerCase() === 'eval' &&
        commandScript(command).includes('mutate-task-with-plan-projection-v1') &&
        (command.args ?? []).some((value) => String(value) === 'needs_pm_decision'),
      () => reconcileResolutionBacklog(redis),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
    );
    expect(decisionFault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task('decision-root'), 'resolution_status')).toBe('needs_pm_decision');
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);

    await redis.flushdb();
    await seedPlan(PLAN_ID, 2);
    await seedTasks([
      {
        task_id: 'resolved-root',
        status: 'failed',
        resolution_status: 'repairing',
        resolution_task_id: 'resolved-repair',
        resolution_task_ids: 'resolved-repair',
      },
      {
        task_id: 'resolved-repair',
        status: 'done',
        fix_for: 'resolved-root',
        repair_root_task_id: 'resolved-root',
      },
    ]);
    await getPlans(redis);

    const resolvedFault = await failAfterCommittedCommand(
      redis,
      (command) => command.name?.toLowerCase() === 'eval' &&
        commandScript(command).includes('mutate-task-with-plan-projection-v1') &&
        (command.args ?? []).some((value) => String(value) === 'resolved'),
      () => pmReview(redis, 'resolved-repair', { verdict: 'accept', reviewed_by: 'pm-test' }),
      async () => verifier.srem(keys.planStatusProjection.dirtyPlans, PLAN_ID).then(() => undefined),
    );
    expect(resolvedFault.hit).toBe(true);
    expect(await verifier.hget(keys.hash.task('resolved-root'), 'resolution_status')).toBe('resolved');
    expect(await verifier.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);
  });

  it('atomically republishes a legacy hash-only repair child into plan and task projections', async () => {
    const rootTaskId = 'legacy-hash-only-root';
    const childTaskId = 'legacy-hash-only-repair';
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{
      task_id: rootTaskId,
      status: 'failed',
      resolution_status: 'repairing',
      resolution_task_id: childTaskId,
      resolution_task_ids: childTaskId,
    }]);

    // Finish the legacy projection backfill before introducing the orphan child. This models
    // an old process that committed only the task hash and exited before queue/index publish.
    await getPlans(redis);
    const revisionBefore = Number(await redis.hget(keys.planStatusProjection.revisionByPlan, PLAN_ID) ?? 0);
    await redis.hset(keys.hash.task(childTaskId), {
      task_id: childTaskId,
      plan_id: PLAN_ID,
      title: childTaskId,
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: '6',
      status: 'pending',
      depends_on: '',
      ownership_files: '',
      ownership_modules: '',
      timeout_seconds: '60',
      max_retries: '2',
      retries: '0',
      acceptance_for: '',
      verify: '[]',
      goal_md: `# ${childTaskId}`,
      project_path: PROJECT_PATH,
      created_at: '1700000001000',
      fix_for: rootTaskId,
      repair_root_task_id: rootTaskId,
      resolution_status: '',
      resolution_action: '',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolution_generation: '0',
      resolution_attempts: '0',
    });
    // Simulate both projection memberships missing, including the plan registry itself.
    await redis.srem(keys.planStatusProjection.planIds, PLAN_ID);
    await redis.srem(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), childTaskId);
    expect(await redis.zscore(keys.zset.status.pending, childTaskId)).toBeNull();

    await reconcileResolutionBacklog(redis);

    expect(await redis.sismember(keys.planStatusProjection.planIds, PLAN_ID)).toBe(1);
    expect(await redis.sismember(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), childTaskId)).toBe(1);
    expect(await redis.sismember(keys.planStatusProjection.dirtyPlans, PLAN_ID)).toBe(1);
    expect(Number(await redis.hget(keys.planStatusProjection.revisionByPlan, PLAN_ID))).toBeGreaterThan(revisionBefore);
    expect(await redis.zscore(keys.zset.status.pending, childTaskId)).not.toBeNull();
    expect(await redis.hget(keys.hash.task(childTaskId), 'runtime_dispatch_published')).toBe('true');

    const plan = (await getPlans(redis)).data?.plans[0];
    expect(plan).toMatchObject({
      plan_id: PLAN_ID,
      status: 'active',
      tasks: { failed: 1, pending: 1 },
    });
  });

  it('keeps stale task-id cleanup behind the same revision CAS as aggregate commit', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'cas-stale-task', status: 'done', pm_review_status: 'accepted' }]);
    await getPlans(redis);

    await redis.del(keys.hash.task('cas-stale-task'));
    await redis.hincrby(keys.planStatusProjection.revisionByPlan, PLAN_ID, 1);
    await redis.sadd(keys.planStatusProjection.dirtyPlans, PLAN_ID);

    let injected = false;
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!injected && command.name?.toLowerCase() === 'eval' && commandScript(command).includes('stale membership')) {
        injected = true;
        return (async () => {
          await verifier.hset(keys.hash.task('cas-stale-task'), {
            task_id: 'cas-stale-task',
            plan_id: PLAN_ID,
            status: 'running',
            pm_review_status: '',
            resolution_status: '',
          });
          await verifier.hincrby(keys.planStatusProjection.revisionByPlan, PLAN_ID, 1);
          await verifier.sadd(keys.planStatusProjection.dirtyPlans, PLAN_ID);
          return original.call(this, command, ...args);
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;
    try {
      const plans = await getPlans(redis);
      expect(plans.data?.plans[0]).toMatchObject({ tasks: { running: 1 }, status: 'active' });
    } finally {
      client.sendCommand = original;
    }
    expect(injected).toBe(true);
    expect(await verifier.sismember(keys.planStatusProjection.taskIdsByPlan(PLAN_ID), 'cas-stale-task')).toBe(1);
  });

  it('fences an expired backfill owner from overwriting the newer owner snapshot', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'fenced-task', status: 'done', pm_review_status: 'accepted' }]);

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let heldFirstPublisher = false;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!heldFirstPublisher && command.name?.toLowerCase() === 'eval' &&
          commandScript(command).includes('plan-status-projection-fenced-backfill-v1')) {
        heldFirstPublisher = true;
        entered();
        return (async () => {
          await releasePromise;
          return original.call(this, command, ...args);
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;

    const first = getPlans(redis);
    try {
      await enteredPromise;
      await verifier.pexpire(keys.planStatusProjection.backfillLock, 5);
      for (let attempt = 0; attempt < 50 && await verifier.exists(keys.planStatusProjection.backfillLock); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(await verifier.exists(keys.planStatusProjection.backfillLock)).toBe(0);

      await verifier.zrem(keys.zset.status.done, 'fenced-task');
      await verifier.zadd(keys.zset.status.running, Date.now(), 'fenced-task');
      await verifier.hset(keys.hash.task('fenced-task'), {
        status: 'running',
        pm_review_status: '',
      });

      const second = await getPlans(redis);
      expect(second.data?.plans[0]).toMatchObject({ status: 'active', tasks: { running: 1, done: 0 } });
      release();
      await first;
    } finally {
      release();
      client.sendCommand = original;
    }

    expect(heldFirstPublisher).toBe(true);
    const final = await getPlans(redis);
    expect(final.data?.plans[0]).toMatchObject({ status: 'active', tasks: { running: 1, done: 0 } });
  });

  it('renews a live backfill owner lease during a delayed scan', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'renewed-backfill-task', status: 'done', pm_review_status: 'accepted' }]);

    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let delayed = false;
    let ownerBefore = '';
    let ownerAfter = '';
    let renewedTtl = 0;
    vi.useFakeTimers();
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!delayed && command.name?.toLowerCase() === 'scan') {
        delayed = true;
        return (async () => {
          ownerBefore = await verifier.get(keys.planStatusProjection.backfillLock) ?? '';
          await verifier.pexpire(keys.planStatusProjection.backfillLock, 120);
          // Production interval is 10s for the 30s TTL. Advance only the JS clock:
          // Redis TTL remains real, so a successful owner-token PEXPIRE is directly observable.
          await vi.advanceTimersByTimeAsync(10_001);
          ownerAfter = await verifier.get(keys.planStatusProjection.backfillLock) ?? '';
          renewedTtl = await verifier.pttl(keys.planStatusProjection.backfillLock);
          return original.call(this, command, ...args);
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;
    try {
      const plans = await getPlans(redis);
      expect(plans.data?.plans[0]).toMatchObject({ status: 'completed', tasks: { done: 1 } });
    } finally {
      client.sendCommand = original;
      vi.useRealTimers();
    }
    expect(delayed).toBe(true);
    expect(ownerBefore).toBeTruthy();
    expect(ownerAfter).toBe(ownerBefore);
    expect(renewedTtl).toBeGreaterThan(20_000);
    expect(await verifier.get(keys.planStatusProjection.ready)).toBe('5');
  });

  it('an expired failed-index owner cannot delete the newer owner ready marker', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'intake-fenced-task', status: 'failed', resolution_status: 'needs_pm_decision' }]);
    await redis.set(keys.planStatusProjection.agentIdsReady, '1');

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let heldFirstPublisher = false;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!heldFirstPublisher && command.name?.toLowerCase() === 'eval' &&
          commandScript(command).includes('intake-actionable-failed-fenced-backfill-v1')) {
        heldFirstPublisher = true;
        entered();
        return (async () => {
          await releasePromise;
          throw new Error('old_intake_owner_failed_after_expiry');
        })();
      }
      return original.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;

    const first = pmIntake(redis, { consumer: 'pm' });
    try {
      await enteredPromise;
      await verifier.pexpire(keys.intakeActionableFailed.backfillLock, 5);
      for (let attempt = 0; attempt < 50 && await verifier.exists(keys.intakeActionableFailed.backfillLock); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(await verifier.exists(keys.intakeActionableFailed.backfillLock)).toBe(0);

      const second = await pmIntake(verifier, { consumer: 'pm' });
      expect(second.data?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'resolution_required', task_id: 'intake-fenced-task' }),
      ]));
      expect(await verifier.get(keys.intakeActionableFailed.ready)).toBe('1');
      release();
      await expect(first).rejects.toThrow('old_intake_owner_failed_after_expiry');
    } finally {
      release();
      client.sendCommand = original;
    }

    expect(heldFirstPublisher).toBe(true);
    expect(await verifier.get(keys.intakeActionableFailed.ready)).toBe('1');
    expect(await verifier.zscore(keys.intakeActionableFailed.pending, 'intake-fenced-task')).not.toBeNull();
  });

  it('does not publish ready when the legacy backfill has a Redis command error', async () => {
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: 'legacy-task', status: 'done', pm_review_status: 'accepted' }]);
    // 旧投影自身即使 WRONGTYPE 也应由版本升级删除并重建；这里破坏权威 task hash，
    // 验证真实扫描错误仍会 fail closed，绝不发布 ready。
    await redis.set(keys.hash.task('legacy-task'), 'wrong-type');

    await expect(getPlans(redis)).rejects.toThrow('backfill failed');
    expect(await redis.get(keys.planStatusProjection.ready)).toBeNull();
    expect(await redis.get(keys.planStatusProjection.backfillLock)).toBeNull();
  });

  it('keeps steady PM intake independent from ten thousand resolved failed tasks and keyspace size', async () => {
    await seedResolvedFailedHistory(10_000);
    // Standalone intake must perform the legacy backfill without requiring /status first.
    const first = await pmIntake(redis, { consumer: 'pm' });
    expect(first.ok).toBe(true);
    expect(first.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'actionable-failed' }),
    ]));
    expect(await redis.get(keys.intakeActionableFailed.ready)).toBe('1');

    const steady = await counted(() => pmIntake(redis, { consumer: 'pm' }));
    expect(steady.result.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'actionable-failed' }),
    ]));
    expect(steady.taskHashReads).toBeLessThan(10);
    expect(steady.terminalHistoryReads).toBe(0);
    expect(steady.commands).toBeLessThan(40);
    console.info(JSON.stringify({
      pmIntakeProjectionCommandCounts: {
        resolvedFailedHistory: 10_000,
        commands: steady.commands,
        taskHashReads: steady.taskHashReads,
        terminalHistoryReads: steady.terminalHistoryReads,
      },
    }));
  }, 40_000);

  it('removes a failed child candidate when its root has already entered automatic repair', async () => {
    await seedPlan(PLAN_ID, 2);
    await seedTasks([
      { task_id: 'repair-root', status: 'failed', resolution_status: 'repairing', resolution_task_ids: 'repair-child' },
      { task_id: 'repair-child', status: 'failed', repair_root_task_id: 'repair-root' },
    ]);
    await redis.zadd(keys.intakeActionableFailed.pending, Date.now(), 'repair-child');
    await redis.set(keys.intakeActionableFailed.ready, '1');
    await redis.set(keys.planStatusProjection.agentIdsReady, '1');

    const intake = await pmIntake(redis, { consumer: 'pm' });
    expect(intake.data?.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: 'repair-child' }),
    ]));
    expect(await redis.zscore(keys.intakeActionableFailed.pending, 'repair-child')).toBeNull();
  });

  it('converges failed child candidates to one actionable needs-decision root', async () => {
    await seedPlan(PLAN_ID, 2);
    await seedTasks([
      { task_id: 'decision-root', status: 'done', pm_review_status: 'rejected', resolution_status: 'needs_pm_decision', resolution_task_ids: 'decision-child' },
      { task_id: 'decision-child', status: 'failed', repair_root_task_id: 'decision-root' },
    ]);
    await redis.zadd(keys.intakeActionableFailed.pending, Date.now(), 'decision-root', Date.now() + 1, 'decision-child');
    await redis.set(keys.intakeActionableFailed.ready, '1');
    await redis.set(keys.planStatusProjection.agentIdsReady, '1');

    const intake = await pmIntake(redis, { consumer: 'pm' });
    expect(intake.data?.items.filter((item) => item.kind === 'resolution_required')).toEqual([
      expect.objectContaining({ task_id: 'decision-root' }),
    ]);
    expect(await redis.zrange(keys.intakeActionableFailed.pending, 0, -1)).toEqual(['decision-root']);
  });

  it('keeps needs-decision resolution silent while a referenced child is still active', async () => {
    await seedPlan(PLAN_ID, 2);
    await seedTasks([
      {
        task_id: 'active-decision-root',
        status: 'failed',
        resolution_status: 'needs_pm_decision',
        resolution_task_id: 'active-decision-child',
        resolution_task_ids: 'active-decision-child',
      },
      {
        task_id: 'active-decision-child',
        status: 'pending',
        repair_root_task_id: 'active-decision-root',
      },
    ]);
    await redis.zadd(keys.intakeActionableFailed.pending, Date.now(), 'active-decision-root');
    await redis.set(keys.intakeActionableFailed.ready, '1');
    await redis.set(keys.planStatusProjection.agentIdsReady, '1');

    const whileActive = await pmIntake(redis, { consumer: 'pm' });
    expect(whileActive.data?.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'active-decision-root' }),
    ]));

    await redis.hset(keys.hash.task('active-decision-child'), 'status', 'failed');
    const afterFailure = await pmIntake(redis, { consumer: 'pm' });
    expect(afterFailure.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'active-decision-root' }),
    ]));
  });

  it('does not delete a newly actionable failed candidate while cleaning a stale snapshot', async () => {
    const taskId = 'intake-stale-cleanup-race';
    await seedPlan(PLAN_ID, 1);
    await seedTasks([{ task_id: taskId, status: 'failed', resolution_status: 'repairing' }]);
    await redis.zadd(keys.intakeActionableFailed.pending, Date.now(), taskId);
    await redis.set(keys.intakeActionableFailed.ready, '1');
    await redis.set(keys.planStatusProjection.agentIdsReady, '1');

    const originalZrem = redis.zrem.bind(redis);
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const originalSendCommand = client.sendCommand;
    let injected = false;
    const makeActionable = async () => {
      if (injected) return;
      injected = true;
      await verifier.hset(keys.hash.task(taskId), 'resolution_status', 'needs_pm_decision');
      await verifier.zadd(keys.intakeActionableFailed.pending, Date.now() + 1, taskId);
    };
    redis.zrem = (async (key: string, ...members: (string | number)[]) => {
      if (!injected && key === keys.intakeActionableFailed.pending && members.map(String).includes(taskId)) {
        await makeActionable();
      }
      return originalZrem(key, ...members);
    }) as typeof redis.zrem;
    client.sendCommand = function intercept(command: RedisCommandLike, ...args: unknown[]) {
      if (!injected && command.name?.toLowerCase() === 'eval' &&
          commandScript(command).includes("local actionable = resolution == 'needs_pm_decision'")) {
        return (async () => {
          await makeActionable();
          return originalSendCommand.call(this, command, ...args);
        })();
      }
      return originalSendCommand.call(this, command, ...args) as Promise<unknown>;
    } as typeof client.sendCommand;
    try {
      await pmIntake(redis, { consumer: 'pm' });
    } finally {
      redis.zrem = originalZrem;
      client.sendCommand = originalSendCommand;
    }

    expect(injected).toBe(true);
    expect(await verifier.zscore(keys.intakeActionableFailed.pending, taskId)).not.toBeNull();
    const next = await pmIntake(verifier, { consumer: 'pm' });
    expect(next.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: taskId }),
    ]));
  });
});
