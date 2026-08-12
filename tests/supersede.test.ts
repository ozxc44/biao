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
