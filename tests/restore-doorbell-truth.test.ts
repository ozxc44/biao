/**
 * Redis 非空时的 SQLite 强制恢复边界。
 *
 * 这组测试只使用独立 DB15，验证 stream 作为不可变审计保留，而 PM pending/doorbell
 * 必须始终服从当前 task / Question / plan 的 durable 真相。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, type PlanRow, type QuestionRow, type TaskRow } from '../src/db/sqlite-store.js';
import {
  ackEvent,
  dbRestore,
  dbRestoreManual,
  setSqliteStore,
  unackedEvents,
} from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.RESTORE_DOORBELL_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/15';
const PROJECT_PATH = '/tmp/biao-restore-doorbell-project';
const PLAN_ID = 'restore-doorbell-plan';
const TASK_ID = 'restore-doorbell-task';
const QUESTION_ID = 'restore-doorbell-question';
const OLD_DONE_AT = 1_700_000_000_000;
const NEW_DONE_AT = OLD_DONE_AT + 60_000;

let redis: Redis;
let store: SqliteStore;
let tempDir = '';

function planRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    plan_id: PLAN_ID,
    title: '恢复门铃计划',
    status: 'submitted',
    project_path: PROJECT_PATH,
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: String(OLD_DONE_AT - 10_000),
    submitted_at: String(OLD_DONE_AT - 9_000),
    pm_consumer: 'pm-a',
    ...overrides,
  };
}

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: TASK_ID,
    plan_id: PLAN_ID,
    title: '恢复门铃任务',
    type: 'code',
    phase: 'impl',
    status: 'done',
    priority: 5,
    assignee: 'auto',
    ownership_files: '',
    ownership_modules: '',
    depends_on: '',
    timeout_seconds: 120,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '[]',
    claimed_by: 'worker-a',
    claimed_at: String(OLD_DONE_AT - 2_000),
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: String(OLD_DONE_AT),
    retries: 0,
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    repair_ownership_extension: '',
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
    goal_md: '# restore doorbell task',
    created_at: String(OLD_DONE_AT - 5_000),
    updated_at: String(OLD_DONE_AT),
    ...overrides,
  };
}

function questionRow(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    question_id: QUESTION_ID,
    task_id: TASK_ID,
    plan_id: PLAN_ID,
    agent_id: 'worker-a',
    pm_consumer: 'pm-a',
    asked_event_id: `${OLD_DONE_AT}_question_asked_${QUESTION_ID}`,
    body: '恢复后还需要 PM 回答吗？',
    checkpoint: 'resume=restore-doorbell',
    status: 'open',
    created_at: String(OLD_DONE_AT),
    answered_at: '',
    answered_by: '',
    answer: '',
    ...overrides,
  };
}

async function reviewAuditEvents(): Promise<Array<Record<string, string>>> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw.map(([, fields]) => Object.fromEntries(
    Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
  )).filter((event) => event.type === 'review_requested');
}

async function addQuestionDoorbell(overrides: Record<string, string> = {}): Promise<string> {
  const fields: Record<string, string> = {
    event_id: `${OLD_DONE_AT}_question_asked_${QUESTION_ID}`,
    type: 'question_asked',
    task_id: TASK_ID,
    question_id: QUESTION_ID,
    plan_id: PLAN_ID,
    agent_id: 'worker-a',
    consumer: 'pm-a',
    acked: 'false',
    timestamp: String(OLD_DONE_AT),
    ...overrides,
  };
  const flat = Object.entries(fields).flat();
  return redis.xadd(keys.stream.events, '*', ...flat) as Promise<string>;
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  tempDir = mkdtempSync(join(tmpdir(), 'biao-restore-doorbell-'));
  store = new SqliteStore(join(tempDir, 'biao.sqlite'));
  store.upsertPlan(planRow());
  setSqliteStore(store);
});

afterEach(() => {
  setSqliteStore(null);
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => redis.disconnect());

describe('review_requested 恢复 generation', () => {
  it('SQLite 出现新的 done_at generation 时，不复用已 ack 的旧 event_id，而是生成新门铃', async () => {
    store.upsertTask(taskRow());
    await dbRestore(redis, store);

    const first = await unackedEvents(redis, { consumer: 'pm-a', type: 'review_requested' });
    const oldEventId = first.data?.[0]?.event_id;
    expect(oldEventId).toBe(`${OLD_DONE_AT}_review_${TASK_ID}`);
    await ackEvent(redis, { consumer: 'pm-a', event_id: oldEventId! });

    store.upsertTask(taskRow({ done_at: String(NEW_DONE_AT), updated_at: String(NEW_DONE_AT) }));
    await redis.flushdb();
    await dbRestoreManual(redis);

    expect(await redis.sismember(keys.reviewRequested.fired, TASK_ID)).toBe(0);
    expect(await redis.hget(keys.reviewRequested.eventByTask, TASK_ID)).toBeNull();

    const next = await unackedEvents(redis, { consumer: 'pm-a', type: 'review_requested' });
    expect(next.data).toEqual([
      expect.objectContaining({ event_id: `${NEW_DONE_AT}_review_${TASK_ID}`, task_id: TASK_ID }),
    ]);
    expect(await reviewAuditEvents()).toHaveLength(1);
  });

  it('非空目标上的重复恢复被拒绝，保留既有去重与 ack 静音', async () => {
    store.upsertTask(taskRow());
    await dbRestore(redis, store);
    const first = await unackedEvents(redis, { consumer: 'pm-a', type: 'review_requested' });
    const eventId = first.data?.[0]?.event_id;
    await ackEvent(redis, { consumer: 'pm-a', event_id: eventId! });

    expect(await dbRestoreManual(redis)).toMatchObject({
      ok: false,
      error: { code: 'RESTORE_TARGET_NOT_EMPTY' },
    });
    const afterRestore = await unackedEvents(redis, { consumer: 'pm-a', type: 'review_requested' });

    expect(afterRestore.data).toEqual([]);
    expect(await redis.sismember(keys.reviewRequested.fired, TASK_ID)).toBe(1);
    expect(await redis.hget(keys.reviewRequested.eventByTask, TASK_ID)).toBe(eventId);
    expect(await reviewAuditEvents()).toHaveLength(1);
  });

  it('SQLite 真相已不再是未验收 done 时，清除旧 review 映射与 consumer pending，但保留审计事件', async () => {
    store.upsertTask(taskRow());
    await dbRestore(redis, store);
    const first = await unackedEvents(redis, { consumer: 'pm-a', type: 'review_requested' });
    expect(first.data).toHaveLength(1);

    store.upsertTask(taskRow({
      pm_review_status: 'accepted',
      pm_reviewed_by: 'pm-a',
      pm_reviewed_at: String(NEW_DONE_AT),
      updated_at: String(NEW_DONE_AT),
    }));
    await redis.flushdb();
    await dbRestoreManual(redis);

    expect(await redis.zscore(keys.reviewRequested.pending, TASK_ID)).toBeNull();
    expect(await redis.sismember(keys.reviewRequested.fired, TASK_ID)).toBe(0);
    expect(await redis.hget(keys.reviewRequested.eventByTask, TASK_ID)).toBeNull();
    expect(await redis.zcard(keys.ack.consumerPending('pm-a'))).toBe(0);
    expect(await redis.hlen(keys.ack.consumerPendingPayload('pm-a'))).toBe(0);
    expect(await reviewAuditEvents()).toHaveLength(0);
  });
});

describe('question_asked consumer pending 当前真相', () => {
  it('Question open 且 task/plan/consumer 归属一致时正常返回最小门铃', async () => {
    store.upsertTask(taskRow({
      status: 'blocked',
      done_at: '',
      claimed_by: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: QUESTION_ID,
      blocked_at: String(OLD_DONE_AT),
    }));
    store.upsertQuestion(questionRow());
    await dbRestore(redis, store);
    await addQuestionDoorbell();

    const pending = await unackedEvents(redis, { consumer: 'pm-a', type: 'question_asked' });
    expect(pending.data).toEqual([
      expect.objectContaining({
        type: 'question_asked',
        task_id: TASK_ID,
        question_id: QUESTION_ID,
        plan_id: PLAN_ID,
        consumer: 'pm-a',
      }),
    ]);
  });

  it.each([
    ['task 已不再 blocked', { status: 'pending' }],
    ['block_reason 已不再等待 PM', { block_reason: 'waiting_dependency' }],
    ['blocked_question_id 已指向另一代问题', { blocked_question_id: 'another-question' }],
  ])('%s 时，即使 Question 仍 open 也懒清旧门铃', async (_label, taskMutation) => {
    store.upsertTask(taskRow({
      status: 'blocked',
      done_at: '',
      claimed_by: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: QUESTION_ID,
      blocked_at: String(OLD_DONE_AT),
    }));
    store.upsertQuestion(questionRow());
    await dbRestore(redis, store);
    await redis.hset(keys.hash.task(TASK_ID), taskMutation);
    await addQuestionDoorbell();

    expect((await unackedEvents(redis, { consumer: 'pm-a', type: 'question_asked' })).data).toEqual([]);
    expect(await redis.zcard(keys.ack.consumerPending('pm-a'))).toBe(0);
  });

  it('Question 在 SQLite 中已 answered 并恢复 task 后，懒清旧 pending 投影且不删除 stream 审计', async () => {
    store.upsertTask(taskRow({
      status: 'blocked',
      done_at: '',
      claimed_by: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: QUESTION_ID,
      blocked_at: String(OLD_DONE_AT),
    }));
    store.upsertQuestion(questionRow());
    await dbRestore(redis, store);
    const streamId = await addQuestionDoorbell();
    expect((await unackedEvents(redis, { consumer: 'pm-a', type: 'question_asked' })).data).toHaveLength(1);

    store.upsertTask(taskRow({
      status: 'pending',
      done_at: '',
      claimed_by: '',
      block_reason: '',
      blocked_question_id: '',
      blocked_at: '',
      last_question_id: QUESTION_ID,
      last_question_answer: '已回答',
      updated_at: String(NEW_DONE_AT),
    }));
    store.upsertQuestion(questionRow({
      status: 'answered',
      answered_at: String(NEW_DONE_AT),
      answered_by: 'pm-a',
      answer: '已回答',
    }));
    await redis.flushdb();
    await dbRestoreManual(redis);

    expect((await unackedEvents(redis, { consumer: 'pm-a', type: 'question_asked' })).data).toEqual([]);
    expect(await redis.zcard(keys.ack.consumerPending('pm-a'))).toBe(0);
    expect(await redis.hlen(keys.ack.consumerPendingPayload('pm-a'))).toBe(0);
    expect(await redis.xrange(keys.stream.events, streamId, streamId)).toHaveLength(0);
  });

  it('legacy 无 consumer 事件只投影给当前归属 PM，伪造 plan 的事件也不会跨边界泄漏', async () => {
    store.upsertTask(taskRow({
      status: 'blocked',
      done_at: '',
      claimed_by: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: QUESTION_ID,
      blocked_at: String(OLD_DONE_AT),
    }));
    store.upsertQuestion(questionRow());
    await dbRestore(redis, store);

    await addQuestionDoorbell({ consumer: '' });
    await addQuestionDoorbell({
      event_id: `${OLD_DONE_AT + 1}_question_asked_${QUESTION_ID}`,
      plan_id: 'foreign-plan',
    });

    const foreign = await unackedEvents(redis, { consumer: 'pm-b', type: 'question_asked' });
    expect(foreign.data).toEqual([]);
    expect(await redis.zcard(keys.ack.consumerPending('pm-b'))).toBe(0);

    const owner = await unackedEvents(redis, { consumer: 'pm-a', type: 'question_asked' });
    expect(owner.data).toEqual([
      expect.objectContaining({
        event_id: `${OLD_DONE_AT}_question_asked_${QUESTION_ID}`,
        plan_id: PLAN_ID,
        question_id: QUESTION_ID,
      }),
    ]);
    expect(await redis.zcard(keys.ack.consumerPending('pm-a'))).toBe(1);
    // restore 门铃 + legacy 同 event_id + 伪造 plan 事件都是不可变审计；
    // pending 投影才按语义 event_id 去重并校验当前路由。
    expect((await redis.xrange(keys.stream.events, '-', '+'))).toHaveLength(3);
  });
});

describe('Question restore open pointer 真相', () => {
  it('非空目标含旧 open pointer 时拒绝恢复且不改写 pointer', async () => {
    store.upsertTask(taskRow({
      status: 'pending',
      done_at: '',
      claimed_by: '',
      block_reason: '',
      blocked_question_id: '',
    }));
    store.upsertQuestion(questionRow({
      status: 'answered',
      answered_at: String(NEW_DONE_AT),
      answered_by: 'pm-a',
      answer: '已回答',
    }));
    await redis.set(keys.question.openByTask(TASK_ID), QUESTION_ID);
    await redis.hset(keys.question.openMetaByTask(TASK_ID), {
      question_id: QUESTION_ID,
      agent_id: 'worker-a',
      claim_token: 'old-token',
      pm_consumer: 'pm-a',
    });

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'RESTORE_TARGET_NOT_EMPTY' });

    expect(await redis.get(keys.question.openByTask(TASK_ID))).toBe(QUESTION_ID);
    expect(await redis.exists(keys.question.openMetaByTask(TASK_ID))).toBe(1);
  });

  it('非空目标含新一代 open Question 时拒绝恢复且保留新 pointer 与 metadata', async () => {
    const newQuestionId = 'restore-doorbell-new-open-question';
    store.upsertTask(taskRow({
      status: 'blocked',
      done_at: '',
      claimed_by: '',
      block_reason: 'waiting_pm_reply',
      blocked_question_id: newQuestionId,
    }));
    store.upsertQuestion(questionRow({
      status: 'answered',
      answered_at: String(NEW_DONE_AT),
      answered_by: 'pm-a',
      answer: '旧问题已回答',
    }));
    await redis.hset(keys.hash.question(newQuestionId), {
      question_id: newQuestionId,
      task_id: TASK_ID,
      plan_id: PLAN_ID,
      agent_id: 'worker-b',
      pm_consumer: 'pm-a',
      status: 'open',
      created_at: String(NEW_DONE_AT + 1),
    });
    await redis.set(keys.question.openByTask(TASK_ID), newQuestionId);
    await redis.hset(keys.question.openMetaByTask(TASK_ID), {
      question_id: newQuestionId,
      agent_id: 'worker-b',
      claim_token: 'new-token',
      pm_consumer: 'pm-a',
    });

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'RESTORE_TARGET_NOT_EMPTY' });

    expect(await redis.get(keys.question.openByTask(TASK_ID))).toBe(newQuestionId);
    expect(await redis.hgetall(keys.question.openMetaByTask(TASK_ID))).toMatchObject({
      question_id: newQuestionId,
      agent_id: 'worker-b',
      claim_token: 'new-token',
      pm_consumer: 'pm-a',
    });
  });
});
