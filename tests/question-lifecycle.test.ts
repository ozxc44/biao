/**
 * Worker → PM Question 的真实 Redis / SQLite / HTTP 回归。
 * 不 mock service：通过 Fastify inject 验证请求契约，再用 SQLite restore 验证重启后仍能处理。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/server/http.js';
import { SqliteStore, type PlanRow, type TaskRow } from '../src/db/sqlite-store.js';
import { setSqliteStore, dbRestore, agentRegister, claim, taskBlock, taskResume, pmIntake } from '../src/server/service.js';
import { keys, pendingScore } from '../src/redis/keys.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import type { BiaoConfig } from '../src/types/index.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT = '/tmp/biao-question-project';
let redis: Redis;
let app: Awaited<ReturnType<typeof createHttpServer>>;
let store: SqliteStore;
let tempDir = '';

function config(): BiaoConfig {
  return {
    port: 7398,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: ['/tmp'],
    sqlitePath: join(tempDir, 'biao.sqlite'),
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

async function seed(): Promise<void> {
  await writePlanToRedis(redis, {
    plan_id: 'question-plan',
    title: 'Question plan',
    project_path: PROJECT,
    pm_consumer: 'pm-a',
    default_assignee: 'auto',
    default_priority: 5,
  }, 1);
  await writeTaskToRedis(redis, {
    task_id: 'question-task', title: 'Question task', type: 'code', phase: 'impl', assignee: 'auto',
    priority: 5, timeout_seconds: 120, ownership: { files: ['src/question/**'] }, verify: [],
  }, '# Question task', 'question-plan', PROJECT, 5);
  // 真实 server 会在 plan submit/create 阶段双写 SQLite。该测试直接 seed Redis，
  // 所以显式补齐同一持久化父记录，确保 Question FK 与重启恢复路径都被真正覆盖。
  store.upsertPlan({
    plan_id: 'question-plan', title: 'Question plan', status: 'submitted', project_path: PROJECT,
    default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
    created_at: String(Date.now()), submitted_at: String(Date.now()), pm_consumer: 'pm-a',
  } as PlanRow);
  store.upsertTask({
    task_id: 'question-task', plan_id: 'question-plan', title: 'Question task', type: 'code', phase: 'impl',
    status: 'pending', priority: 5, assignee: 'auto', ownership_files: 'src/question/**', ownership_modules: '',
    depends_on: '', timeout_seconds: 120, max_retries: 2, model_override: '', acceptance_for: '', verify: '[]',
    claimed_by: '', claimed_at: '', expire_at: '', result_path: '', result_json_path: '', done_at: '', retries: 0,
    pm_review_status: '', pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '', pm_reject_reason: '',
    pm_fix_instructions: '', blocked_at: '', block_reason: '', blocked_question_id: '', blocked_lease_remaining: '',
    last_question_id: '', last_question_answer: '', cancelled_at: '', verify_results: '[]', goal_md: '# Question task',
    created_at: String(Date.now()), updated_at: String(Date.now()),
  } as TaskRow);
  await agentRegister(redis, 'worker-a', 'mock', ['code']);
}

async function http(method: string, url: string, payload?: unknown) {
  return app.inject({ method, url, payload });
}

function body(response: Awaited<ReturnType<typeof http>>): any {
  return response.json();
}

async function eventFields(type: string): Promise<Record<string, string>[]> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw.map(([, fields]) => {
    const parsed: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) parsed[fields[i]] = fields[i + 1];
    return parsed;
  }).filter((event) => event.type === type);
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  tempDir = mkdtempSync(join(tmpdir(), 'biao-question-'));
  store = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(store);
  app = await createHttpServer(redis, config());
  await seed();
});

afterEach(async () => {
  await app.close();
  setSqliteStore(null);
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => redis.disconnect());

describe('Question HTTP 生命周期', () => {
  it('只有实际 lease 持有者能提问，正文不泄露到门铃；回答后必须 fresh claim 才能拿到上下文', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const token = claimed.data!.claim_token;

    const spoofed = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: 'bad-token', body: '是否改接口？', checkpoint: 'step=1',
    }));
    expect(spoofed.error.code).toBe('CLAIM_TOKEN_INVALID');
    expect(await redis.get(keys.string.lease('question-task'))).toBe(token);

    const asked = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: token, body: '是否改接口？', checkpoint: 'step=1',
    }));
    expect(asked).toMatchObject({
      ok: true,
      data: {
        task_id: 'question-task', plan_id: 'question-plan', pm_consumer: 'pm-a',
        asked_event_id: expect.stringMatching(/_question_asked_/),
      },
    });
    const questionId = asked.data.question_id as string;
    const askedEventId = asked.data.asked_event_id as string;
    expect(await redis.get(keys.string.lease('question-task'))).toBeNull();
    expect(await redis.hget(keys.hash.fileOwnership, 'src/question/**')).toBeNull();
    expect(await redis.hget(keys.hash.task('question-task'), 'status')).toBe('blocked');

    const bells = await eventFields('question_asked');
    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({ task_id: 'question-task', question_id: questionId, plan_id: 'question-plan', consumer: 'pm-a' });
    expect(bells[0].event_id).toBe(askedEventId);
    expect(JSON.stringify(bells[0])).not.toContain('是否改接口');
    expect(JSON.stringify(bells[0])).not.toContain('step=1');

    // 同一请求重试是幂等；陌生 token/agent 不能借 task_id 探测或重放。
    const retry = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: token, body: '是否改接口？', checkpoint: 'step=1',
    }));
    expect(retry.data.question_id).toBe(questionId);
    const leakedRetry = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: 'another', body: 'x',
    }));
    expect(leakedRetry.error.code).toBe('CLAIM_TOKEN_INVALID');

    const pmB = body(await http('GET', '/questions?consumer=pm-b&status=open'));
    expect(pmB.data).toEqual([]);
    const pmA = body(await http('GET', '/questions?consumer=pm-a&status=open'));
    expect(pmA.data[0]).toMatchObject({ question_id: questionId, task_id: 'question-task', plan_id: 'question-plan', status: 'open' });
    expect(pmA.data[0]).not.toHaveProperty('body');
    expect(pmA.data[0]).not.toHaveProperty('checkpoint');
    expect(pmA.data[0]).not.toHaveProperty('answer');
    expect(pmA.data[0]).not.toHaveProperty('asked_event_id');
    // 正文与 checkpoint 仅能通过单项读取取得。
    const pmADetail = body(await http('GET', `/question/${questionId}?consumer=pm-a&plan_id=question-plan`));
    expect(pmADetail.data).toMatchObject({
      body: '是否改接口？', checkpoint: 'step=1', asked_event_id: askedEventId,
    });
    const wrongPlanRead = body(await http('GET', `/question/${questionId}?consumer=pm-a&plan_id=other-plan`));
    expect(wrongPlanRead.error.code).toBe('PLAN_NOT_AUTHORIZED');
    const forbiddenRead = body(await http('GET', `/question/${questionId}?consumer=pm-b`));
    expect(forbiddenRead.error.code).toBe('CONSUMER_NOT_AUTHORIZED');

    const wrongPm = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-b', answer: '不可以' }));
    expect(wrongPm.error.code).toBe('CONSUMER_NOT_AUTHORIZED');
    const wrongPlanAnswer = body(await http('POST', `/question/${questionId}/answer`, {
      consumer: 'pm-a', plan_id: 'other-plan', answer: '不应跨计划',
    }));
    expect(wrongPlanAnswer.error.code).toBe('PLAN_NOT_AUTHORIZED');
    const answered = body(await http('POST', `/question/${questionId}/answer`, {
      consumer: 'pm-a', plan_id: 'question-plan', answer: '可以，保持兼容',
    }));
    expect(answered).toMatchObject({
      ok: true,
      data: {
        question_id: questionId, task_id: 'question-task', plan_id: 'question-plan',
        pm_consumer: 'pm-a', asked_event_id: askedEventId, status: 'answered', new_claim_token: '',
      },
    });
    expect(await redis.hget(keys.hash.task('question-task'), 'status')).toBe('pending');
    expect(await redis.exists(keys.question.openMetaByTask('question-task'))).toBe(0);

    const answerBells = await eventFields('question_answered');
    expect(answerBells[0]).toMatchObject({ task_id: 'question-task', question_id: questionId, consumer: 'worker' });
    expect(JSON.stringify(answerBells[0])).not.toContain('可以，保持兼容');

    const reclaimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    expect(reclaimed.data).toMatchObject({ task_id: 'question-task', question_id: questionId, question_answer: '可以，保持兼容', question_checkpoint: 'step=1' });
    expect(reclaimed.data!.claim_token).not.toBe(token);
  });

  it('错误 consumer 被拒、相同回答幂等、冲突回答拒绝，并且 PM intake 只含 Question ID 不含正文', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const asked = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token, body: '正文不可广播', checkpoint: 'secret checkpoint',
    }));
    const questionId = asked.data.question_id as string;
    const intake = body(await http('GET', '/intake?consumer=pm-a'));
    const bell = intake.data.items.find((item: any) => item.kind === 'question_asked');
    expect(bell).toMatchObject({ question_id: questionId, task_id: 'question-task', plan_id: 'question-plan' });
    expect(JSON.stringify(bell)).not.toContain('正文不可广播');
    expect(JSON.stringify(bell)).not.toContain('secret checkpoint');

    const first = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: 'same answer' }));
    expect(first.ok).toBe(true);
    const idempotent = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: 'same answer' }));
    expect(idempotent).toMatchObject({ ok: true, data: { status: 'answered' } });
    const conflict = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: 'different answer' }));
    expect(conflict.error.code).toBe('ANSWER_CONFLICT');
  });

  it('旧版缺少 pm_consumer 的 Question 列表只归属默认 PM，不向其它 consumer 暴露元数据', async () => {
    await redis.hset(keys.hash.question('legacy-question-without-consumer'), {
      question_id: 'legacy-question-without-consumer',
      task_id: 'question-task',
      plan_id: 'question-plan',
      agent_id: 'worker-a',
      status: 'open',
      created_at: '1',
    });

    const defaultPm = body(await http('GET', '/questions?consumer=pm&status=open'));
    const foreignPm = body(await http('GET', '/questions?consumer=pm-foreign&status=open'));

    expect(defaultPm.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ question_id: 'legacy-question-without-consumer', pm_consumer: 'pm' }),
    ]));
    expect(foreignPm.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ question_id: 'legacy-question-without-consumer' }),
    ]));
  });

  it('拒绝无界 Question body、checkpoint 和 PM answer', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const bodyTooLarge = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token,
      body: '问'.repeat(2_001), checkpoint: 'ok',
    }));
    expect(bodyTooLarge.ok).toBe(false);

    const checkpointTooLarge = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token,
      body: '正常问题', checkpoint: '点'.repeat(4_001),
    }));
    expect(checkpointTooLarge.ok).toBe(false);

    const asked = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token,
      body: '正常问题', checkpoint: '正常恢复点',
    }));
    const answerTooLarge = body(await http('POST', `/question/${asked.data.question_id}/answer`, {
      consumer: 'pm-a', answer: '答'.repeat(4_001),
    }));
    expect(answerTooLarge.ok).toBe(false);
  });

  it('SQLite restore 保留未答复 Question，恢复后仍可由原 PM 回答并重新领取', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const asked = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token, body: '重启后还在吗？', checkpoint: 'resume=42',
    }));
    const questionId = asked.data.question_id as string;

    await redis.flushdb();
    await dbRestore(redis, store);
    const restored = body(await http('GET', '/question/' + questionId + '?consumer=pm-a'));
    expect(restored.data).toMatchObject({
      body: '重启后还在吗？', checkpoint: 'resume=42', status: 'open',
      asked_event_id: asked.data.asked_event_id,
    });
    expect(await redis.hgetall(keys.question.openMetaByTask('question-task'))).toMatchObject({
      question_id: questionId,
      agent_id: 'worker-a',
      claim_token: '',
      pm_consumer: 'pm-a',
    });
    expect((await pmIntake(redis, { consumer: 'pm-a' })).data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'question_asked',
        task_id: 'question-task',
        question_id: questionId,
        event_id: asked.data.asked_event_id,
      }),
    ]));
    const answered = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: '还在' }));
    expect(answered.ok).toBe(true);
    // Agent epoch 是进程生命周期，SQLite restore 不恢复旧 presence。
    // Worker 必须新注册后才能领取恢复的任务。
    await agentRegister(redis, 'worker-a', 'cli', ['code']);
    const reclaimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    expect(reclaimed.data).toMatchObject({ task_id: 'question-task', question_answer: '还在', question_checkpoint: 'resume=42' });
  });

  it('文件条件已清除时 block 直接释放旧 lease 与 ownership 回 pending，由 fresh claim 重新绑定 agent', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    expect(await taskBlock(redis, 'question-task', 'worker-a', {
      claim_token: claimed.data!.claim_token,
      reason: 'waiting_file_release',
    })).toMatchObject({ ok: true, data: { blocked: false } });
    expect(await redis.get(keys.string.lease('question-task'))).toBeNull();
    expect(await redis.hget(keys.hash.fileOwnership, 'src/question/**')).toBeNull();
    expect(await redis.hget(keys.hash.task('question-task'), 'claimed_by')).toBe('');
    expect(await redis.hget(keys.hash.task('question-task'), 'status')).toBe('pending');
    expect(await taskResume(redis, 'question-task', 'someone-else')).toMatchObject({
      ok: false,
      error: { code: 'TASK_NOT_BLOCKED' },
    });
    await agentRegister(redis, 'worker-b', 'mock', ['code']);
    const reclaimed = await claim(redis, { agent_id: 'worker-b', blocking: false });
    expect(reclaimed.data?.task_id).toBe('question-task');
    expect(reclaimed.data?.claim_token).not.toBe(claimed.data!.claim_token);
  });

  it('Question 已不再对应 blocked 状态时，回答被拒且 Question 保持 open，避免覆盖后续任务状态', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const asked = body(await http('POST', '/question', {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token, body: '状态冲突？',
    }));
    const questionId = asked.data.question_id as string;
    // 模拟 PM/系统已把 task 推进到另一个状态，而 Question 仍未答复。
    await redis.hset(keys.hash.task('question-task'), { status: 'pending', blocked_question_id: '' });
    await redis.zrem(keys.zset.status.blocked, 'question-task');
    await redis.zadd(keys.zset.status.pending, pendingScore(5, Date.now()), 'question-task');

    const response = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: '不能覆盖' }));
    expect(response).toMatchObject({ ok: false, error: { code: 'TASK_STATE_CONFLICT' } });
    expect(await redis.hget(keys.hash.question(questionId), 'status')).toBe('open');
    expect(await redis.hget(keys.hash.question(questionId), 'answer')).toBeNull();
  });

  it('Redis 已提交而 SQLite 暂时失败时，同一请求重放会补齐 Question 与 answer 副本', async () => {
    const claimed = await claim(redis, { agent_id: 'worker-a', blocking: false });
    const askPayload = {
      task_id: 'question-task', agent_id: 'worker-a', claim_token: claimed.data!.claim_token,
      body: 'SQLite 补偿问题', checkpoint: 'resume=sqlite',
    };

    const originalUpsertQuestion = store.upsertQuestion.bind(store);
    let failCreateOnce = true;
    store.upsertQuestion = (question) => {
      if (failCreateOnce) {
        failCreateOnce = false;
        throw new Error('simulated SQLite create outage');
      }
      originalUpsertQuestion(question);
    };
    const firstAttempt = await http('POST', '/question', askPayload);
    expect(firstAttempt.statusCode).toBe(500);
    const questionId = await redis.get(keys.question.openByTask('question-task'));
    expect(questionId).toBeTruthy();

    store.upsertQuestion = originalUpsertQuestion;
    const replay = body(await http('POST', '/question', askPayload));
    expect(replay).toMatchObject({ ok: true, data: { question_id: questionId } });
    expect(store.getAllQuestions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ question_id: questionId, body: 'SQLite 补偿问题', checkpoint: 'resume=sqlite', status: 'open' }),
    ]));

    let failAnswerOnce = true;
    store.upsertQuestion = (question) => {
      if (failAnswerOnce) {
        failAnswerOnce = false;
        throw new Error('simulated SQLite answer outage');
      }
      originalUpsertQuestion(question);
    };
    const firstAnswer = await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: '继续执行' });
    expect(firstAnswer.statusCode).toBe(500);
    store.upsertQuestion = originalUpsertQuestion;

    const answerReplay = body(await http('POST', `/question/${questionId}/answer`, { consumer: 'pm-a', answer: '继续执行' }));
    expect(answerReplay).toMatchObject({ ok: true, data: { status: 'answered' } });
    expect(store.getAllQuestions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ question_id: questionId, status: 'answered', answer: '继续执行' }),
    ]));
  });

  it('events 用精确排他 stream cursor 分页：同毫秒多条不重不漏；since 保持数组兼容', async () => {
    const ms = Date.now();
    await redis.xadd(
      keys.stream.events, `${ms}-0`,
      'event_id', 'cursor-event-a', 'type', 'question_answered', 'task_id', 'question-task', 'timestamp', String(ms),
    );
    await redis.xadd(
      keys.stream.events, `${ms}-1`,
      'event_id', 'cursor-event-b', 'type', 'task_resumed', 'task_id', 'question-task', 'timestamp', String(ms),
    );

    const first = body(await http('GET', '/events?after=0-0&limit=1'));
    expect(first).toMatchObject({ ok: true, data: { events: [{ event_id: 'cursor-event-a' }], next_cursor: `${ms}-0` } });
    expect(first.data.events).toHaveLength(1);

    const second = body(await http('GET', `/events?after=${encodeURIComponent(first.data.next_cursor)}&limit=1`));
    expect(second).toMatchObject({ ok: true, data: { events: [{ event_id: 'cursor-event-b' }], next_cursor: `${ms}-1` } });
    expect(second.data.events).toHaveLength(1);

    const empty = body(await http('GET', `/events?cursor=${encodeURIComponent(second.data.next_cursor)}&limit=1`));
    expect(empty).toMatchObject({ ok: true, data: { events: [], next_cursor: `${ms}-1` } });

    // 无 after/cursor 时维持旧 CLI 的 data 数组形状与 since 毫秒语义。
    const legacy = body(await http('GET', `/events?since=${ms}&limit=10`));
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(legacy.data.map((event: { event_id: string }) => event.event_id)).toEqual(['cursor-event-a', 'cursor-event-b']);

    const invalid = body(await http('GET', '/events?after=not-a-stream-id'));
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_CURSOR' } });
  });
});
