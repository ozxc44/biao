import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  dbRestore,
  pmReview,
  reconcileResolutionBacklog,
  reconcileRuntimeState,
  report,
  setSqliteStore,
} from '../src/server/service.js';
import { SqliteStore, type PlanRow, type TaskRow } from '../src/db/sqlite-store.js';
import { keys } from '../src/redis/keys.js';
import { lazyReclaimTaskIds, writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';

// Dedicated non-production database for the scalability regression. Do not point this
// suite at the product Redis (6379) or at another suite's occupied database.
const REDIS_URL = process.env.RUNTIME_RECONCILE_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/10';
const PROJECT_PATH = join(tmpdir(), 'biao-runtime-reconcile-project');
const PLAN_ID = 'runtime-reconcile-dirty-index-plan';
const DIRTY_KEY = 'biao:v1:zset:runtime_reconcile_pending';
const BACKFILL_READY_KEY = 'biao:v1:string:runtime_reconcile_backfill_ready:v1';

let redis: Redis;

async function seedPlan(): Promise<void> {
  await writePlanToRedis(redis, {
    plan_id: PLAN_ID,
    title: PLAN_ID,
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-runtime-performance',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
}

async function seedTask(taskId: string, overrides: Record<string, unknown> = {}): Promise<void> {
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
  } as never, `# ${taskId}`, PLAN_ID, PROJECT_PATH, 5);
}

async function makeDoneUnreviewed(taskId: string): Promise<void> {
  const now = Date.now();
  await redis.zrem(keys.zset.status.pending, taskId);
  await redis.zadd(keys.zset.status.done, now, taskId);
  await redis.hset(keys.hash.task(taskId), {
    status: 'done',
    done_at: String(now),
    pm_review_status: '',
    resolution_status: '',
    pm_accept_effects_applied: '',
  });
  await redis.zadd(keys.reviewRequested.pending, now, taskId);
}

async function seedCleanAcceptedHistory(size: number): Promise<void> {
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (let index = 0; index < size; index++) {
    const taskId = `clean-accepted-${index}`;
    pipeline.hset(keys.hash.task(taskId), {
      task_id: taskId,
      plan_id: PLAN_ID,
      title: taskId,
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: '5',
      status: 'done',
      depends_on: '',
      ownership_files: '',
      ownership_modules: '',
      timeout_seconds: '60',
      max_retries: '2',
      retries: '0',
      acceptance_for: '',
      verify: '[]',
      goal_md: `# ${taskId}`,
      project_path: PROJECT_PATH,
      created_at: String(now + index),
      done_at: String(now + index),
      pm_review_status: 'accepted',
      pm_accept_effects_applied: 'true',
      resolution_status: '',
      resolution_action: '',
      resolution_task_id: '',
      resolution_task_ids: '',
      repair_root_task_id: '',
      fix_for: '',
    });
    pipeline.zadd(keys.zset.status.done, now + index, taskId);
  }
  const outcomes = await pipeline.exec();
  if (!outcomes || outcomes.some(([error]) => error)) throw new Error('failed to seed clean history');
}

function durableTaskRow(
  taskId: string,
  overrides: Partial<TaskRow & { pm_accept_effects_applied: string }> = {},
): TaskRow & { pm_accept_effects_applied: string } {
  return {
    task_id: taskId,
    plan_id: PLAN_ID,
    title: taskId,
    type: 'code',
    phase: 'impl',
    status: 'pending',
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
    done_at: '',
    retries: 0,
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_accept_effects_applied: '',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    last_question_id: '',
    last_question_answer: '',
    cancelled_at: '',
    verify_results: '[]',
    goal_md: `# ${taskId}`,
    created_at: '1700000000000',
    updated_at: '1700000000000',
    ...overrides,
  };
}

async function countedRuntimeRound(): Promise<{ commands: number; taskHashReads: number }> {
  const client = redis as Redis & {
    sendCommand: (...args: any[]) => Promise<unknown>;
  };
  const original = client.sendCommand;
  let commands = 0;
  let taskHashReads = 0;
  client.sendCommand = function counted(command: { name?: string; args?: unknown[] }, ...args: unknown[]) {
    commands++;
    if (
      command?.name?.toLowerCase() === 'hgetall' &&
      String(command.args?.[0] ?? '').startsWith('biao:v1:hash:task:')
    ) taskHashReads++;
    return original.call(this, command, ...args) as Promise<unknown>;
  } as typeof client.sendCommand;
  try {
    const result = await reconcileRuntimeState(redis);
    expect(result.ok).toBe(true);
    return { commands, taskHashReads };
  } finally {
    client.sendCommand = original;
  }
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const existing = await redis.dbsize();
  if (existing !== 0) {
    redis.disconnect();
    throw new Error(`isolated Redis ${REDIS_URL} is not empty (${existing} keys); refusing to overwrite it`);
  }
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
  await seedPlan();
});

afterAll(async () => {
  setSqliteStore(null);
  if (redis.status !== 'end') {
    await redis.flushdb();
    redis.disconnect();
  }
});

describe('runtime reconcile durable dirty index', () => {
  it('builds the legacy candidate projection once and marks it ready', async () => {
    await seedCleanAcceptedHistory(10);

    await reconcileResolutionBacklog(redis);

    expect(await redis.get(BACKFILL_READY_KEY)).toBe('1');
  });

  it('does not leave the backfill marker ready when a candidate write has the wrong Redis type', async () => {
    await seedTask('wrongtype-backfill-source');
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'wrongtype-backfill-source');
    await redis.zadd(keys.zset.status.failed, now, 'wrongtype-backfill-source');
    await redis.hset(keys.hash.task('wrongtype-backfill-source'), {
      status: 'failed',
      failed_reason: 'legacy failure',
      resolution_status: '',
    });
    await redis.set(DIRTY_KEY, 'wrong-type');

    await expect(reconcileRuntimeState(redis)).rejects.toThrow('backfill');

    expect(await redis.get(BACKFILL_READY_KEY)).toBeNull();
  });

  it('backfills a legacy accepted audit whose dependency side effects were not recorded', async () => {
    await seedTask('legacy-accepted-source');
    await seedTask('legacy-accepted-dependent', { depends_on: ['legacy-accepted-source'] });
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'legacy-accepted-source', 'legacy-accepted-dependent');
    await redis.zadd(keys.zset.status.done, now, 'legacy-accepted-source');
    await redis.hset(keys.hash.task('legacy-accepted-source'), {
      status: 'done',
      done_at: String(now),
      pm_review_status: 'accepted',
      pm_accept_effects_applied: '',
    });
    await redis.zadd(keys.zset.status.blocked, now, 'legacy-accepted-dependent');
    await redis.hset(keys.hash.task('legacy-accepted-dependent'), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(now),
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hmget(
      keys.hash.task('legacy-accepted-source'),
      'pm_review_status',
      'pm_accept_effects_applied',
    )).toEqual(['accepted', 'true']);
    expect(await redis.hgetall(keys.hash.task('legacy-accepted-dependent'))).toMatchObject({
      status: 'pending',
      block_reason: '',
    });
    expect(await redis.zscore(DIRTY_KEY, 'legacy-accepted-source')).toBeNull();
  });

  it('persists the accepted side-effect marker so Redis disaster restore does not replay it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-accept-effects-restore-'));
    const store = new SqliteStore(join(directory, 'biao.sqlite'));
    try {
      store.upsertPlan({
        plan_id: PLAN_ID,
        title: PLAN_ID,
        status: 'active',
        project_path: PROJECT_PATH,
        default_assignee: 'auto',
        default_priority: 5,
        phases: '[]',
        task_count: 2,
        created_at: '1700000000000',
        submitted_at: '1700000000000',
        pm_consumer: 'pm-runtime-performance',
      } satisfies PlanRow);
      store.upsertTask(durableTaskRow('restored-accepted-source', {
        status: 'done',
        done_at: '1700000001000',
        pm_review_status: 'accepted',
        pm_accept_effects_applied: 'true',
      }));
      store.upsertTask(durableTaskRow('restored-ready-dependent', {
        status: 'pending',
        depends_on: 'restored-accepted-source',
      }));
      expect(store.getAllTasks().find((task) => task.task_id === 'restored-accepted-source'))
        .toMatchObject({ pm_accept_effects_applied: 'true' });

      await redis.flushdb();
      await dbRestore(redis, store);
      expect(await redis.hget(
        keys.hash.task('restored-accepted-source'),
        'pm_accept_effects_applied',
      )).toBe('true');
      const taskStreamLengthAfterRestore = await redis.xlen(keys.stream.tasks);

      await reconcileResolutionBacklog(redis);

      // Restore already publishes the pending task once. A replay of the accepted source
      // would publish it again, so stable stream length proves the durable marker prevented it.
      expect(await redis.xlen(keys.stream.tasks)).toBe(taskStreamLengthAfterRestore);
      expect(await redis.zscore(DIRTY_KEY, 'restored-accepted-source')).toBeNull();
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a clean polling round independent from terminal history size after backfill', async () => {
    await seedCleanAcceptedHistory(100);
    await reconcileRuntimeState(redis);
    const small = await countedRuntimeRound();

    await redis.flushdb();
    await seedPlan();
    await seedCleanAcceptedHistory(1_000);
    await reconcileRuntimeState(redis);
    const large = await countedRuntimeRound();

    expect(large.taskHashReads).toBeLessThanOrEqual(small.taskHashReads + 2);
    expect(large.commands).toBeLessThanOrEqual(small.commands + 20);
  });

  it('atomically leaves a dirty candidate when PM reject crashes before repair creation', async () => {
    await seedTask('reject-crash-source');
    await makeDoneUnreviewed('reject-crash-source');
    await redis.set(BACKFILL_READY_KEY, '1');

    const original = redis.hgetall.bind(redis);
    redis.hgetall = (async (key: string) => {
      const value = await original(key);
      if (
        key === keys.hash.task('reject-crash-source') &&
        value.pm_review_status === 'rejected' &&
        !value.resolution_task_id
      ) throw new Error('simulated crash after reject audit');
      return value;
    }) as typeof redis.hgetall;
    try {
      await expect(pmReview(redis, 'reject-crash-source', {
        verdict: 'reject',
        reviewed_by: 'pm-runtime-performance',
        reject_reason: 'crash boundary',
        fix_instructions: 'create repair after restart',
      })).rejects.toThrow('simulated crash after reject audit');
    } finally {
      redis.hgetall = original as typeof redis.hgetall;
    }

    expect(await redis.hget(keys.hash.task('reject-crash-source'), 'pm_review_status')).toBe('rejected');
    expect(await redis.zscore(DIRTY_KEY, 'reject-crash-source')).not.toBeNull();

    await reconcileRuntimeState(redis);
    expect(await redis.hgetall(keys.hash.task('reject-crash-source-repair-1'))).toMatchObject({
      task_id: 'reject-crash-source-repair-1',
      status: 'pending',
      fix_for: 'reject-crash-source',
    });
  });

  it('republishes a matching hash-only repair left by a crash before pending enqueue', async () => {
    await seedTask('hash-only-repair-source');
    await makeDoneUnreviewed('hash-only-repair-source');
    const now = Date.now();
    await redis.hset(keys.hash.task('hash-only-repair-source'), {
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-runtime-performance',
      pm_reviewed_at: String(now),
      pm_reject_reason: 'crashed repair publication',
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });
    // This is exactly the old HSET→crash breakpoint: a valid child hash exists, but
    // neither pending ZSET nor task stream publication nor root pointer was committed.
    await redis.hset(keys.hash.task('hash-only-repair-source-repair-1'), {
      task_id: 'hash-only-repair-source-repair-1',
      plan_id: PLAN_ID,
      title: 'repair',
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
      verify: '[]',
      goal_md: '# repair',
      project_path: PROJECT_PATH,
      created_at: String(now),
      fix_for: 'hash-only-repair-source',
      repair_root_task_id: 'hash-only-repair-source',
    });

    await reconcileRuntimeState(redis);

    expect(await redis.zscore(keys.zset.status.pending, 'hash-only-repair-source-repair-1')).not.toBeNull();
    expect(await redis.hgetall(keys.hash.task('hash-only-repair-source'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'hash-only-repair-source-repair-1',
    });
    const streamEntries = await redis.xrange(keys.stream.tasks, '-', '+');
    expect(streamEntries.some(([, fields]) => {
      const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [
        fields[index * 2], fields[index * 2 + 1],
      ]));
      return data.task_id === 'hash-only-repair-source-repair-1';
    })).toBe(true);
  });

  it('coalesces concurrent reconcile publication of the same deterministic repair child', async () => {
    await seedTask('concurrent-repair-source');
    await makeDoneUnreviewed('concurrent-repair-source');
    const now = Date.now();
    await redis.hset(keys.hash.task('concurrent-repair-source'), {
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-runtime-performance',
      pm_reviewed_at: String(now),
      pm_reject_reason: 'concurrent recovery',
      resolution_status: '',
      resolution_task_id: '',
    });

    await Promise.all([reconcileRuntimeState(redis), reconcileRuntimeState(redis)]);

    expect(await redis.zscore(keys.zset.status.pending, 'concurrent-repair-source-repair-1')).not.toBeNull();
    const streamEntries = await redis.xrange(keys.stream.tasks, '-', '+');
    const childPublications = streamEntries.filter(([, fields]) => {
      const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [
        fields[index * 2], fields[index * 2 + 1],
      ]));
      return data.task_id === 'concurrent-repair-source-repair-1';
    });
    expect(childPublications).toHaveLength(1);
    const resolutionEvents = await redis.xrange(keys.stream.events, '-', '+');
    const repairScheduled = resolutionEvents.filter(([, fields]) => {
      const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [
        fields[index * 2], fields[index * 2 + 1],
      ]));
      return data.type === 'repair_scheduled' && data.repair_task_id === 'concurrent-repair-source-repair-1';
    });
    expect(repairScheduled).toHaveLength(1);

    // Restore/legacy projections may have the pending member but not the new child marker.
    // Reconciliation must adopt that index without writing a duplicate task stream entry.
    await redis.hdel(keys.hash.task('concurrent-repair-source-repair-1'), 'runtime_dispatch_published');
    const beforeReplay = await redis.xlen(keys.stream.tasks);
    await reconcileRuntimeState(redis);
    expect(await redis.xlen(keys.stream.tasks)).toBe(beforeReplay);
  });

  it('repairs marker=true but pending zset missing without duplicating the task stream event', async () => {
    await seedTask('half-published-repair-source');
    await makeDoneUnreviewed('half-published-repair-source');
    const now = Date.now();
    await redis.hset(keys.hash.task('half-published-repair-source'), {
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-runtime-performance',
      pm_reviewed_at: String(now),
      pm_reject_reason: 'half publication recovery',
      resolution_status: '',
      resolution_task_id: '',
    });
    await reconcileRuntimeState(redis);

    const childId = 'half-published-repair-source-repair-1';
    expect(await redis.hget(keys.hash.task(childId), 'runtime_dispatch_published')).toBe('true');
    const beforeReplay = await redis.xlen(keys.stream.tasks);

    // 模拟旧实现/外部 Redis 故障留下 hash+marker，但 pending ZSET member 丢失。
    await redis.zrem(keys.zset.status.pending, childId);
    await redis.zadd(keys.runtimeReconcile.pending, Date.now(), 'half-published-repair-source');
    await reconcileRuntimeState(redis);

    expect(await redis.zscore(keys.zset.status.pending, childId)).not.toBeNull();
    expect(await redis.xlen(keys.stream.tasks)).toBe(beforeReplay);
    await agentRegister(redis, 'half-publish-worker', 'mock', ['code'], undefined, [PROJECT_PATH]);
    const claimed = await claim(redis, {
      agent_id: 'half-publish-worker',
      capabilities: ['code'],
      preferred_project: PROJECT_PATH,
    });
    expect(claimed.data?.task_id).toBe(childId);
  });

  it('atomically publishes one acceptance_ready event for a concurrent reverify recovery', async () => {
    await seedTask('reverify-source');
    await seedTask('reverify-root', {
      type: 'acceptance',
      phase: 'acceptance',
      acceptance_for: ['reverify-source'],
      depends_on: ['reverify-source'],
    });
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'reverify-source', 'reverify-root');
    await redis.zadd(keys.zset.status.done, now, 'reverify-source', now, 'reverify-root');
    await redis.hset(keys.hash.task('reverify-source'), {
      status: 'done',
      pm_review_status: 'accepted',
      pm_accept_effects_applied: 'true',
      done_at: String(now),
    });
    await redis.hset(keys.hash.task('reverify-root'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'reverify',
      resolution_status: '',
      resolution_task_id: '',
      done_at: String(now),
    });

    await Promise.all([reconcileRuntimeState(redis), reconcileRuntimeState(redis)]);

    const reverifyTaskId = 'reverify-root-reverify-1';
    expect(await redis.zscore(keys.zset.status.pending, reverifyTaskId)).not.toBeNull();
    const events = await redis.xrange(keys.stream.events, '-', '+');
    const readyEvents = events.filter(([, fields]) => {
      const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [
        fields[index * 2], fields[index * 2 + 1],
      ]));
      return data.type === 'acceptance_ready' && data.task_id === reverifyTaskId;
    });
    expect(readyEvents).toHaveLength(1);

    // Upgraded instances may already have the legacy fired-set member while the
    // per-task publication marker has not been introduced yet. Adopt the legacy
    // proof without emitting a second PM doorbell.
    await redis.hdel(keys.hash.task(reverifyTaskId), 'runtime_acceptance_ready_published');
    await reconcileRuntimeState(redis);
    const replayedEvents = await redis.xrange(keys.stream.events, '-', '+');
    const replayedReadyEvents = replayedEvents.filter(([, fields]) => {
      const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, index) => [
        fields[index * 2], fields[index * 2 + 1],
      ]));
      return data.type === 'acceptance_ready' && data.task_id === reverifyTaskId;
    });
    expect(replayedReadyEvents).toHaveLength(1);
  });

  it('adopts a hash-only reverify into durable lineage and preserves reviewer independence', async () => {
    const sourceId = 'hash-only-reverify-source';
    const rootId = 'hash-only-reverify-root';
    const firstReverifyId = `${rootId}-reverify-1`;
    const previousReviewer = 'hash-only-reverify-reviewer-1';
    const now = Date.now();
    await seedTask(sourceId);
    await seedTask(rootId, {
      type: 'acceptance',
      phase: 'acceptance',
      acceptance_for: [sourceId],
      depends_on: [sourceId],
      verify: [{ cmd: 'hash-only reverify', expect_exit: 0 }],
    });
    await redis.zrem(keys.zset.status.pending, sourceId, rootId);
    await redis.zadd(keys.zset.status.done, now, sourceId, now, rootId);
    await redis.hset(keys.hash.task(sourceId), {
      status: 'done',
      pm_review_status: 'accepted',
      pm_accept_effects_applied: 'true',
      done_at: String(now),
    });
    await redis.hset(keys.hash.task(rootId), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'reverify',
      resolution_status: '',
      resolution_action: '',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolution_generation: '0',
      done_at: String(now),
    });
    // Exact HSET -> crash boundary: the deterministic child exists, but its
    // pending publication and root lineage pointer have not been committed.
    await redis.hset(keys.hash.task(firstReverifyId), {
      task_id: firstReverifyId,
      plan_id: PLAN_ID,
      title: 'hash-only reverify',
      type: 'acceptance',
      phase: 'acceptance',
      assignee: 'auto',
      priority: '6',
      status: 'pending',
      depends_on: sourceId,
      ownership_files: '',
      ownership_modules: '',
      timeout_seconds: '60',
      max_retries: '2',
      retries: '0',
      model_override: '',
      acceptance_for: sourceId,
      verify: JSON.stringify([{ cmd: 'hash-only reverify', expect_exit: 0 }]),
      goal_md: '# hash-only reverify',
      project_path: PROJECT_PATH,
      created_at: String(now),
      fix_for: rootId,
      repair_root_task_id: rootId,
      resolution_status: '',
      resolution_action: '',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolved_by_task: '',
      resolution_generation: '0',
      resolution_attempts: '0',
    });

    const store = new SqliteStore(':memory:');
    store.upsertPlan({
      plan_id: PLAN_ID,
      title: PLAN_ID,
      status: 'active',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 3,
      created_at: String(now),
      submitted_at: String(now),
      pm_consumer: 'pm-runtime-performance',
    } satisfies PlanRow);
    setSqliteStore(store);
    try {
      await reconcileRuntimeState(redis);

      expect(await redis.hgetall(keys.hash.task(rootId))).toMatchObject({
        resolution_status: 'required',
        resolution_task_id: firstReverifyId,
        resolution_task_ids: firstReverifyId,
        resolution_generation: '1',
      });
      expect(store.getAllTasks().find((task) => task.task_id === rootId)).toMatchObject({
        resolution_task_id: firstReverifyId,
        resolution_task_ids: firstReverifyId,
      });

      // Rejecting the recovered first attempt creates a second attempt. The
      // first reviewer must remain excluded through the repaired lineage.
      await redis.zrem(keys.zset.status.pending, firstReverifyId);
      await redis.zadd(keys.zset.status.done, now + 1, firstReverifyId);
      await redis.hset(keys.hash.task(firstReverifyId), {
        status: 'done',
        claimed_by: previousReviewer,
        done_at: String(now + 1),
      });
      const rejected = await pmReview(redis, firstReverifyId, {
        verdict: 'reject',
        reviewed_by: 'pm-runtime-performance',
        reject_reason: 'repeat independent verification',
        resolution_mode: 'reverify',
      });
      const secondReverifyId = `${rootId}-reverify-2`;
      expect(rejected.data?.fix_task_id).toBe(secondReverifyId);

      await agentRegister(redis, previousReviewer, 'test', ['acceptance']);
      expect((await claim(redis, {
        agent_id: previousReviewer,
        blocking: false,
        preferred_types: ['acceptance'],
      })).data).toBeNull();
      await agentRegister(redis, 'hash-only-reverify-reviewer-2', 'test', ['acceptance']);
      expect((await claim(redis, {
        agent_id: 'hash-only-reverify-reviewer-2',
        blocking: false,
        preferred_types: ['acceptance'],
      })).data?.task_id).toBe(secondReverifyId);
    } finally {
      setSqliteStore(null);
      store.close();
    }
  });

  it('does not report success when the failed-task dirty write errors inside MULTI', async () => {
    const taskId = 'report-wrongtype-source';
    const workerId = 'report-wrongtype-worker';
    const claimToken = 'report-wrongtype-token';
    const now = Date.now();
    await seedTask(taskId, { max_retries: 0 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.running, now, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'running',
      claimed_by: workerId,
      claimed_at: String(now),
      expire_at: String(now + 60_000),
      retries: '0',
      max_retries: '0',
    });
    await redis.hset(keys.hash.agent(workerId), {
      agent_id: workerId,
      status: 'busy',
      current_task: taskId,
    });
    await redis.set(keys.string.lease(taskId), claimToken, 'EX', 60);
    await redis.set(BACKFILL_READY_KEY, '1');
    await redis.set(DIRTY_KEY, 'wrong-type');

    await expect(report(redis, {
      task_id: taskId,
      agent_id: workerId,
      claim_token: claimToken,
      status: 'failed',
    })).rejects.toThrow(/report.*提交失败/);

    // Redis MULTI is not rollback-based: the task transition may already be
    // durable, so failure must invalidate the one-time backfill marker.
    expect(await redis.hget(keys.hash.task(taskId), 'status')).toBe('failed');
    expect(await redis.get(BACKFILL_READY_KEY)).toBeNull();

    await redis.del(DIRTY_KEY);
    await reconcileRuntimeState(redis);
    expect(await redis.hgetall(keys.hash.task(`${taskId}-repair-1`))).toMatchObject({
      task_id: `${taskId}-repair-1`,
      status: 'pending',
      fix_for: taskId,
    });
  });

  it('atomically leaves an accepted task dirty when dependency side effects crash', async () => {
    await seedTask('accept-crash-source');
    await seedTask('accept-crash-dependent', { depends_on: ['accept-crash-source'] });
    await makeDoneUnreviewed('accept-crash-source');
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'accept-crash-dependent');
    await redis.zadd(keys.zset.status.blocked, now, 'accept-crash-dependent');
    await redis.hset(keys.hash.task('accept-crash-dependent'), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(now),
    });
    await redis.set(BACKFILL_READY_KEY, '1');

    const original = redis.hgetall.bind(redis);
    redis.hgetall = (async (key: string) => {
      const value = await original(key);
      if (
        key === keys.hash.task('accept-crash-source') &&
        value.pm_review_status === 'accepted' &&
        value.pm_accept_effects_applied !== 'true'
      ) throw new Error('simulated crash before accepted dependency replay');
      return value;
    }) as typeof redis.hgetall;
    try {
      await expect(pmReview(redis, 'accept-crash-source', {
        verdict: 'accept',
        reviewed_by: 'pm-runtime-performance',
      })).rejects.toThrow('simulated crash before accepted dependency replay');
    } finally {
      redis.hgetall = original as typeof redis.hgetall;
    }

    expect(await redis.hget(keys.hash.task('accept-crash-source'), 'pm_review_status')).toBe('accepted');
    expect(await redis.zscore(DIRTY_KEY, 'accept-crash-source')).not.toBeNull();

    await reconcileRuntimeState(redis);
    expect(await redis.hmget(
      keys.hash.task('accept-crash-source'),
      'pm_review_status',
      'pm_accept_effects_applied',
    )).toEqual(['accepted', 'true']);
    expect(await redis.hgetall(keys.hash.task('accept-crash-dependent'))).toMatchObject({
      status: 'pending',
      block_reason: '',
    });
  });

  it('atomically leaves a failed candidate when lease reclaim crashes before finalization', async () => {
    await seedTask('lease-crash-source', { max_retries: 0 });
    const expiredAt = Date.now() - 1_000;
    await redis.zrem(keys.zset.status.pending, 'lease-crash-source');
    await redis.zadd(keys.zset.status.running, expiredAt, 'lease-crash-source');
    await redis.hset(keys.hash.task('lease-crash-source'), {
      status: 'running',
      claimed_by: 'lease-crash-worker',
      claimed_at: String(expiredAt - 1_000),
      expire_at: String(expiredAt),
      retries: '0',
      max_retries: '0',
    });
    await redis.hset(keys.hash.agent('lease-crash-worker'), {
      agent_id: 'lease-crash-worker',
      status: 'busy',
      current_task: 'lease-crash-source',
    });
    await redis.set(BACKFILL_READY_KEY, '1');

    // Only execute the atomic Redis reclaim step. Exiting here models a process crash
    // before service-level persistence/repair finalization gets a chance to run.
    expect(await lazyReclaimTaskIds(redis)).toEqual(['lease-crash-source']);
    expect(await redis.hget(keys.hash.task('lease-crash-source'), 'status')).toBe('failed');
    expect(await redis.zscore(DIRTY_KEY, 'lease-crash-source')).not.toBeNull();

    await reconcileRuntimeState(redis);
    expect(await redis.hgetall(keys.hash.task('lease-crash-source-repair-1'))).toMatchObject({
      task_id: 'lease-crash-source-repair-1',
      status: 'pending',
      fix_for: 'lease-crash-source',
    });
  });
});
