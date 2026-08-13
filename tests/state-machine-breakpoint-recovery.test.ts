import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  agentRegister,
  cancelTask,
  dbRestore,
  pmReview,
  reconcileRuntimeState,
  runWatchdog,
  setSqliteStore,
  taskReset,
} from '../src/server/service.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { keys } from '../src/redis/keys.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT_PATH = '/tmp/biao-state-machine-breakpoint-recovery';
const PLAN_ID = 'state-machine-breakpoint-plan';

let redis: Redis;

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

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
  await writePlanToRedis(redis, {
    plan_id: PLAN_ID,
    title: PLAN_ID,
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-breakpoint',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => redis.disconnect());

describe('状态机断点恢复', () => {
  it('重复 reject 会为已写拒绝审计但尚无 resolution 的任务补建同一条 repair', async () => {
    await seedTask('reject-breakpoint');
    await redis.zrem(keys.zset.status.pending, 'reject-breakpoint');
    await redis.zadd(keys.zset.status.done, Date.now(), 'reject-breakpoint');
    await redis.hset(keys.hash.task('reject-breakpoint'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-breakpoint',
      pm_review_comment: '证据不足',
      pm_reject_reason: '实现未满足验收条件',
      pm_fix_instructions: '补齐行为并重新验证',
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    const replay = await pmReview(redis, 'reject-breakpoint', {
      verdict: 'reject',
      reviewed_by: 'pm-breakpoint',
      comment: '证据不足',
      reject_reason: '实现未满足验收条件',
      fix_instructions: '补齐行为并重新验证',
    });

    expect(replay).toMatchObject({
      ok: true,
      data: {
        review_status: 'rejected',
        fix_task_id: 'reject-breakpoint-repair-1',
        fix_task_ids: ['reject-breakpoint-repair-1'],
      },
    });
    expect(await redis.hgetall(keys.hash.task('reject-breakpoint-repair-1'))).toMatchObject({
      task_id: 'reject-breakpoint-repair-1',
      status: 'pending',
      fix_for: 'reject-breakpoint',
      repair_root_task_id: 'reject-breakpoint',
    });
    expect(await redis.hgetall(keys.hash.task('reject-breakpoint'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'repairing',
      resolution_task_id: 'reject-breakpoint-repair-1',
    });
  });

  it('重复 acceptance reject 会补建来源 repair 而不是返回空修复列表', async () => {
    await seedTask('acceptance-reject-source');
    await seedTask('acceptance-reject-breakpoint', {
      type: 'acceptance',
      depends_on: ['acceptance-reject-source'],
      acceptance_for: ['acceptance-reject-source'],
    });
    const now = Date.now();
    await redis.zrem(
      keys.zset.status.pending,
      'acceptance-reject-source',
      'acceptance-reject-breakpoint',
    );
    await redis.zadd(keys.zset.status.done, now, 'acceptance-reject-source');
    await redis.zadd(keys.zset.status.done, now, 'acceptance-reject-breakpoint');
    await redis.hset(keys.hash.task('acceptance-reject-source'), {
      status: 'done',
      pm_review_status: 'accepted',
    });
    await redis.hset(keys.hash.task('acceptance-reject-breakpoint'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-breakpoint',
      pm_reject_reason: '来源实现未通过独立验收',
      pm_fix_instructions: '修复来源后重新验收',
      pm_rejection_resolution_mode: 'repair',
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    const replay = await pmReview(redis, 'acceptance-reject-breakpoint', {
      verdict: 'reject',
      reviewed_by: 'pm-breakpoint',
      reject_reason: '来源实现未通过独立验收',
      fix_instructions: '修复来源后重新验收',
    });

    expect(replay).toMatchObject({
      ok: true,
      data: {
        review_status: 'rejected',
        resolution_mode: 'repair',
        fix_task_id: 'acceptance-reject-source-repair-1',
        fix_task_ids: ['acceptance-reject-source-repair-1'],
      },
    });
    expect(await redis.hgetall(keys.hash.task('acceptance-reject-source-repair-1'))).toMatchObject({
      status: 'pending',
      fix_for: 'acceptance-reject-source',
    });
    expect(await redis.hgetall(keys.hash.task('acceptance-reject-breakpoint'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'acceptance-reject-source-repair-1',
    });
  });

  it('常规 runtime reconcile 会在线补建 reject 审计断点后的 repair', async () => {
    await seedTask('reject-runtime-breakpoint');
    await redis.zrem(keys.zset.status.pending, 'reject-runtime-breakpoint');
    await redis.zadd(keys.zset.status.done, Date.now(), 'reject-runtime-breakpoint');
    await redis.hset(keys.hash.task('reject-runtime-breakpoint'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-breakpoint',
      pm_reject_reason: '已写拒绝审计但调度进程退出',
      pm_fix_instructions: '恢复后补建修复任务',
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    await reconcileRuntimeState(redis);

    expect(await redis.hgetall(keys.hash.task('reject-runtime-breakpoint-repair-1'))).toMatchObject({
      task_id: 'reject-runtime-breakpoint-repair-1',
      status: 'pending',
      fix_for: 'reject-runtime-breakpoint',
    });
    expect(await redis.hgetall(keys.hash.task('reject-runtime-breakpoint'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'reject-runtime-breakpoint-repair-1',
    });
  });

  it('重复 reject 会从来源 reject 审计恢复完全相同的显式 ownership 扩展', async () => {
    await seedTask('reject-ownership-breakpoint', {
      ownership: { files: ['src/source.ts'], modules: ['core'] },
    });
    await redis.zrem(keys.zset.status.pending, 'reject-ownership-breakpoint');
    await redis.zadd(keys.zset.status.done, Date.now(), 'reject-ownership-breakpoint');
    const intent = JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] });
    await redis.hset(keys.hash.task('reject-ownership-breakpoint'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm-breakpoint',
      pm_reject_reason: '需要修改相邻边界',
      pm_fix_instructions: '只按已授权扩展修复',
      pm_repair_ownership_required: 'true',
      pm_repair_ownership_intent: intent,
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    const replay = await pmReview(redis, 'reject-ownership-breakpoint', {
      verdict: 'reject',
      reviewed_by: 'pm-breakpoint',
      reject_reason: '需要修改相邻边界',
      fix_instructions: '只按已授权扩展修复',
      repair_ownership: { modules: ['adjacent'], files: ['src/adjacent.ts'] },
    });

    expect(replay).toMatchObject({
      ok: true,
      data: { fix_task_ids: ['reject-ownership-breakpoint-repair-1'] },
    });
    expect(await redis.hgetall(keys.hash.task('reject-ownership-breakpoint-repair-1'))).toMatchObject({
      ownership_files: 'src/source.ts,src/adjacent.ts',
      ownership_modules: 'core,adjacent',
      repair_ownership_extension: intent,
    });
    expect(await redis.hgetall(keys.hash.task('reject-ownership-breakpoint'))).toMatchObject({
      ownership_files: 'src/source.ts',
      ownership_modules: 'core',
      pm_repair_ownership_intent: intent,
      resolution_task_id: 'reject-ownership-breakpoint-repair-1',
    });
  });

  it('runtime reconcile 从持久化 reject intent 恢复扩权且重复调用不生成第二条 repair', async () => {
    await seedTask('reject-ownership-runtime', {
      ownership: { files: ['src/source.ts'], modules: ['core'] },
    });
    await redis.zrem(keys.zset.status.pending, 'reject-ownership-runtime');
    await redis.zadd(keys.zset.status.done, Date.now(), 'reject-ownership-runtime');
    const intent = JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] });
    await redis.hset(keys.hash.task('reject-ownership-runtime'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reject_reason: '扩权后修复',
      pm_fix_instructions: '按审计扩权恢复',
      pm_repair_ownership_required: 'true',
      pm_repair_ownership_intent: intent,
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    await reconcileRuntimeState(redis);
    await reconcileRuntimeState(redis);

    expect(await redis.hgetall(keys.hash.task('reject-ownership-runtime-repair-1'))).toMatchObject({
      ownership_files: 'src/source.ts,src/adjacent.ts',
      ownership_modules: 'core,adjacent',
      repair_ownership_extension: intent,
    });
    expect(await redis.keys(`${keys.hash.task('reject-ownership-runtime')}-repair-*`)).toHaveLength(1);
  });

  it('acceptance reject 崩溃窗口也从验收审计恢复来源 repair 的显式扩权', async () => {
    await seedTask('acceptance-ownership-source', {
      ownership: { files: ['src/source.ts'], modules: ['core'] },
    });
    await seedTask('acceptance-ownership-breakpoint', {
      type: 'acceptance',
      acceptance_for: ['acceptance-ownership-source'],
      depends_on: ['acceptance-ownership-source'],
    });
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'acceptance-ownership-source', 'acceptance-ownership-breakpoint');
    await redis.zadd(
      keys.zset.status.done,
      now,
      'acceptance-ownership-source',
      now,
      'acceptance-ownership-breakpoint',
    );
    await redis.hset(keys.hash.task('acceptance-ownership-source'), {
      status: 'done',
      pm_review_status: 'accepted',
    });
    const intent = JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] });
    await redis.hset(keys.hash.task('acceptance-ownership-breakpoint'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reject_reason: '来源需要相邻边界修复',
      pm_fix_instructions: '按审计扩权修复来源',
      pm_rejection_resolution_mode: 'repair',
      pm_repair_ownership_required: 'true',
      pm_repair_ownership_intent: intent,
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    await reconcileRuntimeState(redis);

    expect(await redis.hgetall(keys.hash.task('acceptance-ownership-source-repair-1'))).toMatchObject({
      fix_for: 'acceptance-ownership-source',
      ownership_files: 'src/source.ts,src/adjacent.ts',
      ownership_modules: 'core,adjacent',
      repair_ownership_extension: intent,
    });
    expect(await redis.hgetall(keys.hash.task('acceptance-ownership-breakpoint'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'acceptance-ownership-source-repair-1',
    });
  });

  it.each([
    ['missing', ''],
    ['damaged', '{not-json'],
    ['inconsistent', JSON.stringify({ files: ['src/source.ts'], modules: [] })],
  ])('显式扩权审计 %s 时 runtime reconcile fail-closed，不猜测 repair ownership', async (_case, intent) => {
    const taskId = `reject-ownership-${_case}`;
    await seedTask(taskId, {
      ownership: { files: ['src/source.ts'], modules: ['core'] },
    });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.done, Date.now(), taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reject_reason: '扩权审计异常',
      pm_repair_ownership_required: 'true',
      pm_repair_ownership_intent: intent,
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    await reconcileRuntimeState(redis);

    expect(await redis.exists(keys.hash.task(`${taskId}-repair-1`))).toBe(0);
    expect(await redis.hgetall(keys.hash.task(taskId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: expect.stringContaining('repair_ownership_intent'),
      ownership_files: 'src/source.ts',
      ownership_modules: 'core',
    });
  });

  it('SQLite restore 后 runtime reconcile 仍按 reject intent 恢复完全相同的 ownership 扩展', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-reject-intent-restore-'));
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    const intent = JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] });
    try {
      store.upsertPlan({
        plan_id: PLAN_ID,
        title: PLAN_ID,
        status: 'active',
        project_path: PROJECT_PATH,
        default_assignee: 'auto',
        default_priority: 5,
        phases: '[]',
        task_count: 1,
        created_at: '1700000000000',
        submitted_at: '1700000000000',
        pm_consumer: 'pm-breakpoint',
      });
      store.upsertTask({
        task_id: 'reject-ownership-restored',
        plan_id: PLAN_ID,
        title: 'reject-ownership-restored',
        type: 'code',
        phase: 'impl',
        status: 'done',
        priority: 5,
        assignee: 'auto',
        ownership_files: 'src/source.ts',
        ownership_modules: 'core',
        depends_on: '',
        timeout_seconds: 60,
        max_retries: 2,
        model_override: '',
        acceptance_for: '',
        verify: '[]',
        claimed_by: '', claimed_at: '', expire_at: '', result_path: '', result_json_path: '', done_at: '1700000001000',
        retries: 0,
        pm_review_status: 'rejected', pm_reviewed_by: 'pm-breakpoint', pm_reviewed_at: '1700000002000',
        pm_review_comment: '', pm_reject_reason: '扩权后修复', pm_fix_instructions: '按持久化意图恢复',
        pm_rejection_resolution_mode: '', repair_ownership_extension: '',
        pm_repair_ownership_required: 'true', pm_repair_ownership_intent: intent,
        failure_reason: '', fix_for: '', repair_root_task_id: '', resolution_status: '', resolution_action: '',
        resolution_task_id: '', resolution_task_ids: '', resolved_by_task: '', resolution_generation: 0,
        resolution_attempts: 0, resolution_decision_reason: '', blocked_at: '', block_reason: '', blocked_question_id: '',
        blocked_lease_remaining: '', last_question_id: '', last_question_answer: '', cancelled_at: '', verify_results: '[]',
        goal_md: '# restored', created_at: '1700000000000', updated_at: '1700000002000',
      });
      setSqliteStore(null);
      await redis.flushdb();

      await dbRestore(redis, store);
      await reconcileRuntimeState(redis);

      expect(await redis.hgetall(keys.hash.task('reject-ownership-restored-repair-1'))).toMatchObject({
        ownership_files: 'src/source.ts,src/adjacent.ts',
        ownership_modules: 'core,adjacent',
        repair_ownership_extension: intent,
      });
      expect(store.getAllTasks().find((task) => task.task_id === 'reject-ownership-restored')).toMatchObject({
        pm_repair_ownership_required: 'true',
        pm_repair_ownership_intent: intent,
      });
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('常规 runtime reconcile 会重放 accepted repair 尚未应用的闭环副作用', async () => {
    await seedTask('accepted-repair-source');
    await seedTask('accepted-repair-source-repair-1');
    await seedTask('accepted-repair-downstream', { depends_on: ['accepted-repair-source'] });
    const now = Date.now();

    await redis.zrem(
      keys.zset.status.pending,
      'accepted-repair-source',
      'accepted-repair-source-repair-1',
      'accepted-repair-downstream',
    );
    await redis.zadd(keys.zset.status.done, now, 'accepted-repair-source');
    await redis.zadd(keys.zset.status.done, now, 'accepted-repair-source-repair-1');
    await redis.zadd(keys.zset.status.blocked, now, 'accepted-repair-downstream');
    await redis.hset(keys.hash.task('accepted-repair-source'), {
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: 'accepted-repair-source-repair-1',
      resolution_task_ids: 'accepted-repair-source-repair-1',
      resolution_generation: '1',
      resolution_attempts: '1',
    });
    await redis.hset(keys.hash.task('accepted-repair-source-repair-1'), {
      status: 'done',
      pm_review_status: 'accepted',
      fix_for: 'accepted-repair-source',
      repair_root_task_id: 'accepted-repair-source',
    });
    await redis.hset(keys.hash.task('accepted-repair-downstream'), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(now),
    });

    await reconcileRuntimeState(redis);

    expect(await redis.hgetall(keys.hash.task('accepted-repair-source'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'resolved',
      resolution_action: 'repair',
      resolved_by_task: 'accepted-repair-source-repair-1',
    });
    expect(await redis.hgetall(keys.hash.task('accepted-repair-downstream'))).toMatchObject({
      status: 'pending',
      block_reason: '',
    });
    expect(await redis.zscore(keys.zset.status.blocked, 'accepted-repair-downstream')).toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, 'accepted-repair-downstream')).not.toBeNull();
  });

  it('pending 前置任务仍有 blocked 依赖者时拒绝取消', async () => {
    await seedTask('cancel-blocked-dependency-source');
    await seedTask('cancel-blocked-dependency-waiter', {
      depends_on: ['cancel-blocked-dependency-source'],
    });
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'cancel-blocked-dependency-waiter');
    await redis.zadd(keys.zset.status.blocked, now, 'cancel-blocked-dependency-waiter');
    await redis.hset(keys.hash.task('cancel-blocked-dependency-waiter'), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(now),
    });

    const cancelled = await cancelTask(redis, 'cancel-blocked-dependency-source');

    expect(cancelled).toMatchObject({
      ok: false,
      error: {
        code: 'TASK_HAS_DEPENDENTS',
      },
    });
    expect(cancelled.error?.message).toContain('cancel-blocked-dependency-waiter');
    expect(await redis.hget(keys.hash.task('cancel-blocked-dependency-source'), 'status')).toBe('pending');
    expect(await redis.zscore(keys.zset.status.pending, 'cancel-blocked-dependency-source')).not.toBeNull();
  });

  it('watchdog 回收 stale-running 时达到 max_retries 后进入 repair 而不是再次 pending', async () => {
    await seedTask('watchdog-retry-exhausted', { max_retries: 1 });
    await agentRegister(redis, 'watchdog-stale-worker', 'test', ['code']);
    const expiredAt = Date.now() - 1_000;
    await redis.zrem(keys.zset.status.pending, 'watchdog-retry-exhausted');
    await redis.zadd(keys.zset.status.running, expiredAt, 'watchdog-retry-exhausted');
    await redis.hset(keys.hash.task('watchdog-retry-exhausted'), {
      status: 'running',
      claimed_by: 'watchdog-stale-worker',
      claimed_at: String(expiredAt - 60_000),
      expire_at: String(expiredAt),
      retries: '1',
      max_retries: '1',
    });
    await redis.hset(keys.hash.agent('watchdog-stale-worker'), {
      status: 'busy',
      current_task: 'watchdog-retry-exhausted',
    });
    await redis.del(keys.string.lease('watchdog-retry-exhausted'));

    const watchdog = await runWatchdog(redis, { autoFix: true });

    expect(await redis.hgetall(keys.hash.task('watchdog-retry-exhausted'))).toMatchObject({
      status: 'failed',
      retries: '2',
      failed_reason: 'max_retries_exceeded',
      resolution_status: 'repairing',
      resolution_task_id: 'watchdog-retry-exhausted-repair-1',
    });
    expect(await redis.hgetall(keys.hash.task('watchdog-retry-exhausted-repair-1'))).toMatchObject({
      task_id: 'watchdog-retry-exhausted-repair-1',
      status: 'pending',
      fix_for: 'watchdog-retry-exhausted',
    });
    expect(await redis.zscore(keys.zset.status.pending, 'watchdog-retry-exhausted')).toBeNull();
    expect(watchdog.data?.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'stale_running',
        task_id: 'watchdog-retry-exhausted',
        auto_fixable: true,
        fixed: true,
        detail: expect.stringContaining('max_retries'),
      }),
    ]));
    expect(watchdog.data?.summary.fixed).toBeGreaterThanOrEqual(1);
  });

  it('reset accepted 任务时清除 accept 副作用幂等标记', async () => {
    await seedTask('accepted-reset-cycle');
    await redis.zrem(keys.zset.status.pending, 'accepted-reset-cycle');
    await redis.zadd(keys.zset.status.done, Date.now(), 'accepted-reset-cycle');
    await redis.hset(keys.hash.task('accepted-reset-cycle'), {
      status: 'done',
      pm_review_status: 'accepted',
      pm_accept_effects_applied: 'true',
    });

    expect(await taskReset(redis, 'accepted-reset-cycle', {
      force: true,
      reset_by: 'pm-breakpoint',
    })).toMatchObject({ ok: true, data: { to_status: 'pending' } });
    expect(await redis.hget(keys.hash.task('accepted-reset-cycle'), 'pm_accept_effects_applied')).toBe('');
  });
});
