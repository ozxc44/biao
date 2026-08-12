/**
 * PM 拒绝独立验收后的来源修复与再次独立验收闭环。
 *
 * 验收结论本身没有代码 ownership，不能把它当成普通 code task 修复；必须修来源，
 * 来源修复被 PM 接受后再产生一个新的 acceptance attempt，且下游必须等该 attempt
 * 也被 PM 接受。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  dbRestore,
  getPlan,
  pmIntake,
  pmReview,
  reconcileResolutionBacklog,
  report,
  runWatchdog,
  setSqliteStore,
} from '../src/server/service.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.ACCEPTANCE_REVERIFY_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/14';
const PROJECT_PATH = '/tmp/biao-acceptance-reverify';
const VERIFY = [{ cmd: 'manual acceptance', expect_exit: 0 }];

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  rmSync(PROJECT_PATH, { recursive: true, force: true });
  mkdirSync(PROJECT_PATH, { recursive: true });
});

beforeEach(async () => {
  setSqliteStore(null);
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  await redis.flushdb();
  await writePlanToRedis(redis, {
    plan_id: 'acceptance-reverify-plan',
    title: 'Acceptance reverify',
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-acceptance-reverify',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => {
  setSqliteStore(null);
  redis.disconnect();
  rmSync(PROJECT_PATH, { recursive: true, force: true });
});

function writeResult(taskId: string, content: string): string {
  const taskDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(taskDir, { recursive: true });
  const resultPath = join(taskDir, 'result.md');
  writeFileSync(resultPath, content);
  return resultPath;
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
  } as never, `# ${taskId}\n`, 'acceptance-reverify-plan', PROJECT_PATH, 5);
}

async function claimAs(agentId: string, preferredTypes?: Array<'code' | 'acceptance'>) {
  await agentRegister(redis, agentId, 'mock', ['code', 'acceptance']);
  return claim(redis, {
    agent_id: agentId,
    blocking: false,
    timeout_ms: 1,
    preferred_types: preferredTypes,
  });
}

async function completeCode(taskId: string, agentId: string, ownership?: { files?: string[]; modules?: string[] }) {
  await seedTask(taskId, ownership ? { ownership } : {});
  const claimed = await claimAs(agentId, ['code']);
  expect(claimed.data?.task_id).toBe(taskId);
  expect((await report(redis, {
    task_id: taskId,
    agent_id: agentId,
    claim_token: claimed.data!.claim_token,
    status: 'done',
  })).ok).toBe(true);
}

async function completeAcceptance(
  taskId: string,
  sourceIds: string[],
  agentId: string,
): Promise<void> {
  await seedTask(taskId, {
    type: 'acceptance',
    depends_on: sourceIds,
    acceptance_for: sourceIds,
    verify: VERIFY,
  });
  const claimed = await claimAs(agentId, ['acceptance']);
  expect(claimed.data?.task_id).toBe(taskId);
  const resultPath = writeResult(taskId, '# 验收\n\n- 结论：✅ PASS\n');
  expect((await report(redis, {
    task_id: taskId,
    agent_id: agentId,
    claim_token: claimed.data!.claim_token,
    status: 'done',
    result_path: resultPath,
    verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 0, passed: true }],
  })).ok).toBe(true);
}

async function persistTaskFixture(store: SqliteStore, taskId: string): Promise<void> {
  const h = await redis.hgetall(keys.hash.task(taskId));
  store.upsertTask({
    task_id: h.task_id,
    plan_id: h.plan_id,
    title: h.title ?? taskId,
    type: h.type ?? 'code',
    phase: h.phase ?? 'impl',
    status: h.status ?? 'pending',
    priority: Number(h.priority ?? 5),
    assignee: h.assignee ?? 'auto',
    ownership_files: h.ownership_files ?? '',
    ownership_modules: h.ownership_modules ?? '',
    depends_on: h.depends_on ?? '',
    timeout_seconds: Number(h.timeout_seconds ?? 60),
    max_retries: Number(h.max_retries ?? 2),
    model_override: h.model_override ?? '',
    acceptance_for: h.acceptance_for ?? '',
    verify: h.verify ?? '[]',
    claimed_by: h.claimed_by ?? '',
    claimed_at: h.claimed_at ?? '',
    expire_at: h.expire_at ?? '',
    result_path: h.result_path ?? '',
    result_json_path: h.result_json_path ?? '',
    done_at: h.done_at ?? '',
    retries: Number(h.retries ?? 0),
    pm_review_status: h.pm_review_status ?? '',
    pm_reviewed_by: h.pm_reviewed_by ?? '',
    pm_reviewed_at: h.pm_reviewed_at ?? '',
    pm_review_comment: h.pm_review_comment ?? '',
    pm_reject_reason: h.pm_reject_reason ?? '',
    pm_fix_instructions: h.pm_fix_instructions ?? '',
    pm_rejection_resolution_mode: h.pm_rejection_resolution_mode ?? '',
    repair_ownership_extension: h.repair_ownership_extension ?? '',
    failure_reason: h.failed_reason ?? '',
    fix_for: h.fix_for ?? '',
    repair_root_task_id: h.repair_root_task_id ?? '',
    resolution_status: h.resolution_status ?? '',
    resolution_action: h.resolution_action ?? '',
    resolution_task_id: h.resolution_task_id ?? '',
    resolution_task_ids: h.resolution_task_ids ?? '',
    resolved_by_task: h.resolved_by_task ?? '',
    resolution_generation: Number(h.resolution_generation ?? 0),
    resolution_attempts: Number(h.resolution_attempts ?? 0),
    resolution_decision_reason: h.resolution_decision_reason ?? '',
    blocked_at: h.blocked_at ?? '',
    block_reason: h.block_reason ?? '',
    blocked_question_id: h.blocked_question_id ?? '',
    blocked_lease_remaining: h.blocked_lease_remaining ?? '',
    last_question_id: h.last_question_id ?? '',
    last_question_answer: h.last_question_answer ?? '',
    cancelled_at: h.cancelled_at ?? '',
    superseded_at: h.superseded_at ?? '',
    superseded_by: h.superseded_by ?? '',
    superseded_reason: h.superseded_reason ?? '',
    supersede_preview_token: h.supersede_preview_token ?? '',
    supersede_batch_size: Number(h.supersede_batch_size ?? 0),
    verify_results: h.verify_results ?? '[]',
    goal_md: h.goal_md ?? '',
    created_at: h.created_at ?? String(Date.now()),
    updated_at: String(Date.now()),
  });
}

describe('acceptance reject -> source repair -> independent reverify', () => {
  it('多来源 acceptance 可显式只重验：不修来源、继承范围与验证，且重复请求幂等', async () => {
    await completeCode('evidence-source-a', 'evidence-implementer-a', { files: ['src/a.ts'] });
    await completeCode('evidence-source-b', 'evidence-implementer-b', { files: ['src/b.ts'] });
    await completeCode('evidence-prerequisite-a', 'evidence-prerequisite-worker-a');
    await completeCode('evidence-prerequisite-b', 'evidence-prerequisite-worker-b');
    await pmReview(redis, 'evidence-source-a', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'evidence-source-b', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'evidence-prerequisite-a', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'evidence-prerequisite-b', { verdict: 'accept', reviewed_by: 'pm' });
    await completeAcceptance(
      'evidence-acceptance',
      ['evidence-source-a', 'evidence-source-b'],
      'evidence-reviewer-1',
    );
    await redis.hset(keys.hash.task('evidence-acceptance'), {
      depends_on: 'evidence-prerequisite-a,evidence-prerequisite-b',
      ownership_files: 'docs/evidence.md',
      ownership_modules: 'acceptance-evidence',
    });

    const request = {
      verdict: 'reject' as const,
      reviewed_by: 'pm',
      reject_reason: '来源实现无问题，仅验收报告证据不足',
      fix_instructions: '重新运行原验收命令并提交完整报告',
      resolution_mode: 'reverify' as const,
    };
    const rejected = await pmReview(redis, 'evidence-acceptance', request);

    expect(rejected).toMatchObject({
      ok: true,
      data: {
        review_status: 'rejected',
        resolution_mode: 'reverify',
        fix_task_id: 'evidence-acceptance-reverify-1',
        fix_task_ids: ['evidence-acceptance-reverify-1'],
      },
    });
    expect(await redis.exists(keys.hash.task('evidence-source-a-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('evidence-source-b-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('evidence-acceptance'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'reverify',
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: 'evidence-acceptance-reverify-1',
    });
    expect(await redis.hgetall(keys.hash.task('evidence-acceptance-reverify-1'))).toMatchObject({
      type: 'acceptance',
      status: 'pending',
      acceptance_for: 'evidence-source-a,evidence-source-b',
      depends_on: 'evidence-prerequisite-a,evidence-prerequisite-b',
      ownership_files: 'docs/evidence.md',
      ownership_modules: 'acceptance-evidence',
      verify: JSON.stringify(VERIFY),
      fix_for: 'evidence-acceptance',
      repair_root_task_id: 'evidence-acceptance',
    });
    expect((await claimAs('evidence-reviewer-1', ['acceptance'])).data).toBeNull();

    const eventsBeforeReplay = await redis.xlen(keys.stream.events);
    expect(await pmReview(redis, 'evidence-acceptance', request)).toEqual(rejected);
    expect(await redis.xlen(keys.stream.events)).toBe(eventsBeforeReplay);
    expect(await redis.zrange(keys.zset.status.pending, 0, -1)).toContain('evidence-acceptance-reverify-1');
  });

  it('acceptance 的拒绝处置模式不可改写，非 acceptance 不能使用 reverify-only', async () => {
    await completeCode('mode-source', 'mode-implementer');
    await pmReview(redis, 'mode-source', { verdict: 'accept', reviewed_by: 'pm' });
    await completeAcceptance('mode-acceptance', ['mode-source'], 'mode-reviewer');
    const first = await pmReview(redis, 'mode-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '只需补验收证据',
      resolution_mode: 'reverify',
    });
    expect(first.ok).toBe(true);
    const frozen = await redis.hgetall(keys.hash.task('mode-acceptance'));

    expect(await pmReview(redis, 'mode-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '只需补验收证据',
    })).toMatchObject({
      ok: false,
      error: { code: 'ACCEPTANCE_REJECTION_ALREADY_RECORDED' },
    });
    expect(await redis.hgetall(keys.hash.task('mode-acceptance'))).toEqual(frozen);
    expect(await redis.exists(keys.hash.task('mode-source-repair-1'))).toBe(0);

    await completeCode('ordinary-review', 'ordinary-worker');
    const ordinaryBefore = await redis.hgetall(keys.hash.task('ordinary-review'));
    expect(await pmReview(redis, 'ordinary-review', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '普通任务不能只重验',
      resolution_mode: 'reverify',
    })).toMatchObject({
      ok: false,
      error: { code: 'REVERIFY_ONLY_ACCEPTANCE_REQUIRED' },
    });
    expect(await redis.hgetall(keys.hash.task('ordinary-review'))).toEqual(ordinaryBefore);
  });

  it('reverify-only 在原 depends_on 尚未 accepted/resolved 时 fail closed', async () => {
    await completeCode('dependency-source', 'dependency-implementer');
    await pmReview(redis, 'dependency-source', { verdict: 'accept', reviewed_by: 'pm' });
    await completeCode('dependency-gate', 'dependency-gate-worker');
    await completeAcceptance('dependency-acceptance', ['dependency-source'], 'dependency-reviewer');
    await redis.hset(keys.hash.task('dependency-acceptance'), 'depends_on', 'dependency-gate');
    const before = await redis.hgetall(keys.hash.task('dependency-acceptance'));

    expect(await pmReview(redis, 'dependency-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      resolution_mode: 'reverify',
    })).toMatchObject({
      ok: false,
      error: { code: 'REVERIFY_ONLY_DEPENDENCY_NOT_ACCEPTED' },
    });
    expect(await redis.hgetall(keys.hash.task('dependency-acceptance'))).toEqual(before);
    expect(await redis.exists(keys.hash.task('dependency-acceptance-reverify-1'))).toBe(0);
  });

  it('fresh reverify 被 PM 以 reverify-only 拒绝时创建下一代，不复用已拒绝 attempt', async () => {
    await completeCode('repeat-source', 'repeat-implementer');
    await pmReview(redis, 'repeat-source', { verdict: 'accept', reviewed_by: 'pm' });
    await completeAcceptance('repeat-acceptance', ['repeat-source'], 'repeat-reviewer-1');
    await redis.hset(keys.hash.task('repeat-acceptance'), 'max_retries', '3');
    await pmReview(redis, 'repeat-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '首轮证据不足',
      resolution_mode: 'reverify',
    });
    const firstAttempt = await claimAs('repeat-reviewer-2', ['acceptance']);
    expect(firstAttempt.data?.task_id).toBe('repeat-acceptance-reverify-1');
    const resultPath = writeResult(firstAttempt.data!.task_id, '# 复验一\n\n- 结论：✅ PASS\n');
    expect((await report(redis, {
      task_id: firstAttempt.data!.task_id,
      agent_id: 'repeat-reviewer-2',
      claim_token: firstAttempt.data!.claim_token,
      status: 'done',
      result_path: resultPath,
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 0, passed: true }],
    })).ok).toBe(true);

    const rejectedAttempt = await pmReview(redis, firstAttempt.data!.task_id, {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '第二轮仍缺完整日志，仅需再次复验',
      resolution_mode: 'reverify',
    });
    expect(rejectedAttempt).toMatchObject({
      ok: true,
      data: {
        resolution_mode: 'reverify',
        fix_task_id: 'repeat-acceptance-reverify-2',
        fix_task_ids: ['repeat-acceptance-reverify-2'],
      },
    });
    expect(await redis.hgetall(keys.hash.task('repeat-acceptance-reverify-1'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'reverify',
    });
    expect(await redis.hgetall(keys.hash.task('repeat-acceptance'))).toMatchObject({
      resolution_task_id: 'repeat-acceptance-reverify-2',
      resolution_generation: '2',
    });
    expect((await claimAs('repeat-reviewer-2', ['acceptance'])).data).toBeNull();
    expect((await claimAs('repeat-reviewer-3', ['acceptance'])).data?.task_id).toBe('repeat-acceptance-reverify-2');
  });

  it('启动补偿会按持久化的 reverify 模式补建 fresh attempt，而不是退化成来源 repair', async () => {
    await completeCode('recover-source-a', 'recover-implementer-a');
    await completeCode('recover-source-b', 'recover-implementer-b');
    await pmReview(redis, 'recover-source-a', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'recover-source-b', { verdict: 'accept', reviewed_by: 'pm' });
    await completeAcceptance('recover-acceptance', ['recover-source-a', 'recover-source-b'], 'recover-reviewer');
    await redis.hset(keys.hash.task('recover-acceptance'), {
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm',
      pm_reject_reason: '证据不足',
      pm_rejection_resolution_mode: 'reverify',
    });

    expect(await reconcileResolutionBacklog(redis)).toMatchObject({
      repaired_task_ids: ['recover-acceptance'],
    });
    expect(await redis.exists(keys.hash.task('recover-acceptance-reverify-1'))).toBe(1);
    expect(await redis.exists(keys.hash.task('recover-source-a-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('recover-source-b-repair-1'))).toBe(0);
    expect(await reconcileResolutionBacklog(redis)).toEqual({
      repaired_task_ids: [],
      needs_pm_decision_task_ids: [],
    });
  });

  it('reverify-only 拒绝模式和 fresh attempt 可经 SQLite 重启恢复且保持幂等', async () => {
    const store = new SqliteStore(':memory:');
    store.upsertPlan({
      plan_id: 'acceptance-reverify-plan',
      title: 'Acceptance reverify',
      status: 'active',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 2,
      created_at: '1',
      submitted_at: '1',
      pm_consumer: 'pm-acceptance-reverify',
    });
    setSqliteStore(store);
    try {
      await completeCode('sqlite-source', 'sqlite-implementer');
      await pmReview(redis, 'sqlite-source', { verdict: 'accept', reviewed_by: 'pm' });
      // 测试 fixture 直接写 Redis 创建来源；显式镜像这条初始行，等价于正常 plan submit 双写。
      await persistTaskFixture(store, 'sqlite-source');
      await completeAcceptance('sqlite-acceptance', ['sqlite-source'], 'sqlite-reviewer');
      await pmReview(redis, 'sqlite-acceptance', {
        verdict: 'reject',
        reviewed_by: 'pm',
        reject_reason: '只重做验收证据',
        resolution_mode: 'reverify',
      });

      expect(store.getAllTasks().find((task) => task.task_id === 'sqlite-acceptance')).toMatchObject({
        pm_review_status: 'rejected',
        pm_rejection_resolution_mode: 'reverify',
        resolution_status: 'required',
        resolution_task_id: 'sqlite-acceptance-reverify-1',
      });
      expect(store.getAllTasks().map((task) => task.task_id)).toContain('sqlite-acceptance-reverify-1');
      expect(await redis.exists(keys.hash.task('sqlite-source-repair-1'))).toBe(0);

      await redis.flushdb();
      await dbRestore(redis, store);
      expect(await redis.hgetall(keys.hash.task('sqlite-acceptance'))).toMatchObject({
        pm_review_status: 'rejected',
        pm_rejection_resolution_mode: 'reverify',
        resolution_status: 'required',
        resolution_task_id: 'sqlite-acceptance-reverify-1',
      });
      expect(await redis.hgetall(keys.hash.task('sqlite-acceptance-reverify-1'))).toMatchObject({
        status: 'pending',
        type: 'acceptance',
        acceptance_for: 'sqlite-source',
      });
      expect(await redis.exists(keys.hash.task('sqlite-source-repair-1'))).toBe(0);
      expect(await reconcileResolutionBacklog(redis)).toEqual({
        repaired_task_ids: [],
        needs_pm_decision_task_ids: [],
      });
      expect(await redis.exists(keys.hash.task('sqlite-source-repair-1'))).toBe(0);
    } finally {
      setSqliteStore(null);
      store.close();
    }
  });

  it('拒绝验收只修来源；来源 repair accepted 后仍需新的独立验收才能解锁下游', async () => {
    await completeCode('source', 'implementer', { files: ['src/source.ts'], modules: ['source'] });
    await completeAcceptance('acceptance', ['source'], 'reviewer-1');
    await seedTask('downstream', { depends_on: ['acceptance'] });

    const rejected = await pmReview(redis, 'acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '验收发现来源实现缺少并发保护',
      fix_instructions: '修复来源实现后重新独立验收',
    });

    expect(rejected).toMatchObject({
      ok: true,
      data: {
        review_status: 'rejected',
        fix_task_id: 'source-repair-1',
        fix_task_ids: ['source-repair-1'],
      },
    });
    expect(await redis.exists(keys.hash.task('acceptance-repair-1'))).toBe(0);
    expect(await redis.hget(keys.hash.task('acceptance'), 'pm_review_status')).toBe('rejected');

    const attemptsAfterFirstReject = await redis.hget(keys.hash.task('acceptance'), 'resolution_attempts');
    const eventsAfterFirstReject = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    const rejectionEventCount = eventsAfterFirstReject.filter(([, fields]) =>
      fields.includes('pm_reviewed') && fields.includes('acceptance') && fields.includes('reject'),
    ).length;
    const repeated = await pmReview(redis, 'acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '验收发现来源实现缺少并发保护',
      fix_instructions: '修复来源实现后重新独立验收',
    });
    expect(repeated).toMatchObject({
      ok: true,
      data: { fix_task_id: 'source-repair-1', fix_task_ids: ['source-repair-1'] },
    });
    expect(await redis.hget(keys.hash.task('acceptance'), 'resolution_attempts')).toBe(attemptsAfterFirstReject);
    const eventsAfterRepeatedReject = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(eventsAfterRepeatedReject.filter(([, fields]) =>
      fields.includes('pm_reviewed') && fields.includes('acceptance') && fields.includes('reject'),
    )).toHaveLength(rejectionEventCount);

    const repair = await claimAs('repair-worker', ['code']);
    expect(repair.data?.task_id).toBe('source-repair-1');
    expect((await report(redis, {
      task_id: repair.data!.task_id,
      agent_id: 'repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    })).ok).toBe(true);
    expect((await pmReview(redis, repair.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    const originalAcceptance = await redis.hgetall(keys.hash.task('acceptance'));
    expect(originalAcceptance).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: 'acceptance-reverify-1',
    });
    expect(await redis.hgetall(keys.hash.task('acceptance-reverify-1'))).toMatchObject({
      type: 'acceptance',
      status: 'pending',
      acceptance_for: 'source',
      fix_for: 'acceptance',
      repair_root_task_id: 'acceptance',
    });
    expect(await redis.sismember(keys.acceptanceReady.fired, 'acceptance-reverify-1')).toBe(1);
    expect((await getPlan(redis, 'acceptance-reverify-plan')).data).toMatchObject({ status: 'active' });

    // 原实现者、原验收者和刚完成 repair 的 Worker 都不能领取复验；普通下游也仍未解锁。
    expect((await claimAs('implementer', ['acceptance'])).data).toBeNull();
    expect((await claimAs('reviewer-1', ['acceptance'])).data).toBeNull();
    expect((await claimAs('repair-worker', ['acceptance'])).data).toBeNull();
    expect((await claimAs('downstream-worker', ['code'])).data).toBeNull();

    const reverify = await claimAs('reviewer-2', ['acceptance']);
    expect(reverify.data?.task_id).toBe('acceptance-reverify-1');
    const resultPath = writeResult('acceptance-reverify-1', '# 独立复验\n\n- 结论：✅ PASS\n');
    expect((await report(redis, {
      task_id: reverify.data!.task_id,
      agent_id: 'reviewer-2',
      claim_token: reverify.data!.claim_token,
      status: 'done',
      result_path: resultPath,
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 0, passed: true }],
    })).ok).toBe(true);

    // Worker 交付复验仍不等于 PM 接受，下游继续被闸住。
    expect(await redis.hget(keys.hash.task('acceptance'), 'resolution_status')).toBe('required');
    expect((await claimAs('downstream-worker', ['code'])).data).toBeNull();
    expect((await pmReview(redis, reverify.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    expect(await redis.hget(keys.hash.task('acceptance'), 'resolution_status')).toBe('resolved');
    expect(await redis.hget(keys.hash.task('acceptance'), 'resolution_action')).toBe('reverify');
    expect(await redis.hget(keys.hash.task('acceptance'), 'pm_review_status')).toBe('rejected');
    expect((await claimAs('downstream-worker', ['code'])).data?.task_id).toBe('downstream');
  });

  it('reverify 再次失败会创建新的来源 repair 和新一代 reverify，通过后才闭合根验收', async () => {
    await completeCode('retry-source', 'retry-implementer');
    await redis.hset(keys.hash.task('retry-source'), 'max_retries', '3');
    await completeAcceptance('retry-acceptance', ['retry-source'], 'retry-reviewer-1');
    await redis.hset(keys.hash.task('retry-acceptance'), 'max_retries', '3');
    await seedTask('retry-downstream', { depends_on: ['retry-acceptance'] });

    const rejected = await pmReview(redis, 'retry-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '首轮验收未通过',
    });
    expect(rejected.data?.fix_task_id).toBe('retry-source-repair-1');

    const repair1 = await claimAs('retry-repair-worker-1', ['code']);
    expect(repair1.data?.task_id).toBe('retry-source-repair-1');
    await report(redis, {
      task_id: repair1.data!.task_id,
      agent_id: 'retry-repair-worker-1',
      claim_token: repair1.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repair1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    const reverify1 = await claimAs('retry-reviewer-2', ['acceptance']);
    expect(reverify1.data?.task_id).toBe('retry-acceptance-reverify-1');
    await report(redis, {
      task_id: reverify1.data!.task_id,
      agent_id: 'retry-reviewer-2',
      claim_token: reverify1.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 1, passed: false }],
    });
    const failedReverify1 = await redis.hgetall(keys.hash.task('retry-acceptance-reverify-1'));
    expect(failedReverify1).toMatchObject({
      status: 'failed',
      fix_for: 'retry-acceptance',
      repair_root_task_id: 'retry-acceptance',
    });

    const repair2 = await claimAs('retry-repair-worker-2', ['code']);
    expect(repair2.data?.task_id).toBe('retry-source-repair-2');
    await report(redis, {
      task_id: repair2.data!.task_id,
      agent_id: 'retry-repair-worker-2',
      claim_token: repair2.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repair2.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    const reverify2 = await claimAs('retry-reviewer-3', ['acceptance']);
    expect(reverify2.data?.task_id).toBe('retry-acceptance-reverify-2');
    const resultPath = writeResult(reverify2.data!.task_id, '# 第二代独立复验\n\n- 结论：✅ PASS\n');
    await report(redis, {
      task_id: reverify2.data!.task_id,
      agent_id: 'retry-reviewer-3',
      claim_token: reverify2.data!.claim_token,
      status: 'done',
      result_path: resultPath,
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 0, passed: true }],
    });
    await pmReview(redis, reverify2.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    expect(await redis.hgetall(keys.hash.task('retry-acceptance'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'resolved',
      resolution_action: 'reverify',
      resolution_task_id: 'retry-acceptance-reverify-2',
      resolved_by_task: 'retry-acceptance-reverify-2',
    });
    expect((await redis.hget(keys.hash.task('retry-acceptance'), 'resolution_task_ids') ?? '').split(',')).toEqual([
      'retry-source-repair-1',
      'retry-acceptance-reverify-1',
      'retry-source-repair-2',
      'retry-acceptance-reverify-2',
    ]);
    expect(await redis.hgetall(keys.hash.task('retry-acceptance-reverify-1'))).toEqual(failedReverify1);
    expect((await claimAs('retry-downstream-worker', ['code'])).data?.task_id).toBe('retry-downstream');
  });

  it('reverify 失败且来源 repair 已耗尽时，intake/watchdog 只告警原 acceptance 根任务', async () => {
    await completeCode('exhaust-source', 'exhaust-implementer');
    await redis.hset(keys.hash.task('exhaust-source'), 'max_retries', '1');
    await completeAcceptance('exhaust-acceptance', ['exhaust-source'], 'exhaust-reviewer-1');
    await redis.hset(keys.hash.task('exhaust-acceptance'), 'max_retries', '1');

    const rejected = await pmReview(redis, 'exhaust-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要修复后复验',
    });
    const repair = await claimAs('exhaust-repair-worker', ['code']);
    expect(repair.data?.task_id).toBe(rejected.data?.fix_task_id);
    await report(redis, {
      task_id: repair.data!.task_id,
      agent_id: 'exhaust-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repair.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    const reverify = await claimAs('exhaust-reviewer-2', ['acceptance']);
    expect(reverify.data?.task_id).toBe('exhaust-acceptance-reverify-1');
    await report(redis, {
      task_id: reverify.data!.task_id,
      agent_id: 'exhaust-reviewer-2',
      claim_token: reverify.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 1, passed: false }],
    });

    expect(await redis.hgetall(keys.hash.task('exhaust-acceptance'))).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: 'exhaust-acceptance-reverify-1',
      resolution_decision_reason: 'repair_retry_limit_reached:exhaust-source',
    });
    expect(await redis.hgetall(keys.hash.task('exhaust-acceptance-reverify-1'))).toMatchObject({
      status: 'failed',
      resolution_status: '',
      repair_root_task_id: 'exhaust-acceptance',
    });

    const relevant = (taskId?: string) => [
      'exhaust-source',
      'exhaust-source-repair-1',
      'exhaust-acceptance',
      'exhaust-acceptance-reverify-1',
    ].includes(taskId ?? '');
    const intake = await pmIntake(redis, {
      consumer: 'pm-acceptance-reverify',
      plan_id: 'acceptance-reverify-plan',
    });
    expect(intake.data?.items.filter((item) => relevant(item.task_id))).toEqual([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'exhaust-acceptance' }),
    ]);
    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems.filter((problem) => relevant(problem.task_id))).toEqual([
      expect.objectContaining({ type: 'failed', task_id: 'exhaust-acceptance' }),
    ]);

    const decisionEvents = (await redis.xrange(keys.stream.events, '-', '+') as [string, string[]][])
      .filter(([, fields]) => fields.includes('resolution_required'));
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0][1]).toEqual(expect.arrayContaining(['task_id', 'exhaust-acceptance']));
  });

  it('reverify 自身达到 max_retries 后不再创建新 attempt，只保留根决策与完整 lineage', async () => {
    await completeCode('reverify-limit-source', 'reverify-limit-implementer');
    await redis.hset(keys.hash.task('reverify-limit-source'), 'max_retries', '3');
    await completeAcceptance('reverify-limit-acceptance', ['reverify-limit-source'], 'reverify-limit-reviewer-1');
    await redis.hset(keys.hash.task('reverify-limit-acceptance'), 'max_retries', '1');

    const rejected = await pmReview(redis, 'reverify-limit-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要首轮修复',
    });
    const repair1 = await claimAs('reverify-limit-repair-1', ['code']);
    expect(repair1.data?.task_id).toBe(rejected.data?.fix_task_id);
    await report(redis, {
      task_id: repair1.data!.task_id,
      agent_id: 'reverify-limit-repair-1',
      claim_token: repair1.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repair1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    const reverify1 = await claimAs('reverify-limit-reviewer-2', ['acceptance']);
    expect(reverify1.data?.task_id).toBe('reverify-limit-acceptance-reverify-1');
    await report(redis, {
      task_id: reverify1.data!.task_id,
      agent_id: 'reverify-limit-reviewer-2',
      claim_token: reverify1.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 1, passed: false }],
    });
    const failedReverify = await redis.hgetall(keys.hash.task(reverify1.data!.task_id));

    const repair2 = await claimAs('reverify-limit-repair-2', ['code']);
    expect(repair2.data?.task_id).toBe('reverify-limit-source-repair-2');
    await report(redis, {
      task_id: repair2.data!.task_id,
      agent_id: 'reverify-limit-repair-2',
      claim_token: repair2.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repair2.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });

    expect(await redis.exists(keys.hash.task('reverify-limit-acceptance-reverify-2'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('reverify-limit-acceptance'))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: 'reverify-limit-source-repair-2',
      resolution_generation: '1',
      resolution_decision_reason: 'reverify_retry_limit_reached',
    });
    expect((await redis.hget(keys.hash.task('reverify-limit-acceptance'), 'resolution_task_ids') ?? '').split(',')).toEqual([
      'reverify-limit-source-repair-1',
      'reverify-limit-acceptance-reverify-1',
      'reverify-limit-source-repair-2',
    ]);
    expect(await redis.hgetall(keys.hash.task('reverify-limit-acceptance-reverify-1'))).toEqual(failedReverify);

    const intake = await pmIntake(redis, {
      consumer: 'pm-acceptance-reverify',
      plan_id: 'acceptance-reverify-plan',
    });
    expect(intake.data?.items.filter((item) => item.task_id?.startsWith('reverify-limit-'))).toEqual([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'reverify-limit-acceptance' }),
    ]);
  });

  it('多来源验收拒绝不接受语义不明确的 repair_ownership，并且不写拒绝审计', async () => {
    await completeCode('source-a', 'implementer-a', { files: ['src/a.ts'] });
    await completeCode('source-b', 'implementer-b', { files: ['src/b.ts'] });
    await completeAcceptance('multi-acceptance', ['source-a', 'source-b'], 'reviewer');
    const before = await redis.hgetall(keys.hash.task('multi-acceptance'));

    const rejected = await pmReview(redis, 'multi-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要扩权修复',
      repair_ownership: { files: ['src/shared.ts'] },
    });

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'AMBIGUOUS_ACCEPTANCE_REPAIR_OWNERSHIP' },
    });
    expect(await redis.hgetall(keys.hash.task('multi-acceptance'))).toEqual(before);
    expect(await redis.exists(keys.hash.task('multi-acceptance-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('source-a-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('source-b-repair-1'))).toBe(0);
  });

  it('单来源验收的显式扩权相对来源 ownership 校验，并只写入来源 repair', async () => {
    await completeCode('owned-source', 'implementer', { files: ['src/source.ts'], modules: ['core'] });
    await completeAcceptance('owned-acceptance', ['owned-source'], 'reviewer');

    const rejected = await pmReview(redis, 'owned-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      repair_ownership: { files: ['src/adjacent.ts'], modules: ['adjacent'] },
    });

    expect(rejected).toMatchObject({
      ok: true,
      data: { fix_task_ids: ['owned-source-repair-1'] },
    });
    expect(await redis.hgetall(keys.hash.task('owned-source-repair-1'))).toMatchObject({
      ownership_files: 'src/source.ts,src/adjacent.ts',
      ownership_modules: 'core,adjacent',
      repair_ownership_extension: JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] }),
    });
    expect(await redis.exists(keys.hash.task('owned-acceptance-repair-1'))).toBe(0);
  });

  it('reverify 确定性 ID 被不相干任务占用时 fail-closed，不改冲突任务且只敲一次 PM 门铃', async () => {
    await completeCode('collision-source', 'collision-implementer');
    await completeAcceptance('collision-acceptance', ['collision-source'], 'collision-reviewer');
    const rejected = await pmReview(redis, 'collision-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要修复来源后复验',
    });
    const repairId = rejected.data!.fix_task_id!;
    const repair = await claimAs('collision-repair-worker', ['code']);
    expect(repair.data?.task_id).toBe(repairId);
    expect((await report(redis, {
      task_id: repairId,
      agent_id: 'collision-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    })).ok).toBe(true);

    const collisionId = 'collision-acceptance-reverify-1';
    await seedTask(collisionId);
    await redis.hset(keys.hash.task(collisionId), {
      fix_for: 'unrelated-root',
      repair_root_task_id: 'unrelated-root',
    });
    const collisionBefore = await redis.hgetall(keys.hash.task(collisionId));

    expect((await pmReview(redis, repairId, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    expect(await redis.hgetall(keys.hash.task(collisionId))).toEqual(collisionBefore);
    const root = await redis.hgetall(keys.hash.task('collision-acceptance'));
    expect(root).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      // 冲突不得把已验收来源 repair 从 lineage/末次指针中抹掉。
      resolution_task_id: 'collision-source-repair-1',
      resolution_generation: '0',
    });
    expect((root.resolution_task_ids ?? '').split(',').filter(Boolean)).not.toContain(collisionId);
    expect(await redis.sismember(keys.acceptanceReady.fired, collisionId)).toBe(0);

    const resolutionEvents = async () => {
      const rows = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
      return rows.filter(([, fields]) => {
        const event = Object.fromEntries(
          Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
        );
        return event.type === 'resolution_required' && event.task_id === 'collision-acceptance';
      });
    };
    expect(await resolutionEvents()).toHaveLength(1);
    expect((await pmIntake(redis, { consumer: 'pm-acceptance-reverify' })).data?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'resolution_required', task_id: 'collision-acceptance' }),
      ]),
    );

    expect(await reconcileResolutionBacklog(redis)).toEqual({
      repaired_task_ids: [],
      needs_pm_decision_task_ids: [],
    });
    expect(await resolutionEvents()).toHaveLength(1);
    expect(await redis.hgetall(keys.hash.task(collisionId))).toEqual(collisionBefore);
  });

  it('启动补偿恢复已 accepted 的 reverify 时会闭合根验收并唤醒 blocked downstream', async () => {
    await completeCode('crash-source', 'crash-implementer');
    await completeAcceptance('crash-acceptance', ['crash-source'], 'crash-reviewer-1');
    await seedTask('crash-downstream', { depends_on: ['crash-acceptance'] });

    const rejected = await pmReview(redis, 'crash-acceptance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要修复来源后复验',
    });
    const repairId = rejected.data!.fix_task_id!;
    const repair = await claimAs('crash-repair-worker', ['code']);
    expect(repair.data?.task_id).toBe(repairId);
    expect((await report(redis, {
      task_id: repairId,
      agent_id: 'crash-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    })).ok).toBe(true);
    expect((await pmReview(redis, repairId, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    const blockedAt = Date.now();
    await redis.zrem(keys.zset.status.pending, 'crash-downstream');
    await redis.zadd(keys.zset.status.blocked, blockedAt, 'crash-downstream');
    await redis.hset(keys.hash.task('crash-downstream'), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(blockedAt),
    });

    const reverifyId = 'crash-acceptance-reverify-1';
    const reverify = await claimAs('crash-reviewer-2', ['acceptance']);
    expect(reverify.data?.task_id).toBe(reverifyId);
    const resultPath = writeResult(reverifyId, '# 独立复验\n\n- 结论：✅ PASS\n');
    expect((await report(redis, {
      task_id: reverifyId,
      agent_id: 'crash-reviewer-2',
      claim_token: reverify.data!.claim_token,
      status: 'done',
      result_path: resultPath,
      verify_results: [{ cmd: VERIFY[0].cmd, exit_code: 0, passed: true }],
    })).ok).toBe(true);

    // 模拟 pmReview 已写 accepted，但进程在 resolveRepairLineage/wakeDependents 前崩溃。
    await redis.hset(keys.hash.task(reverifyId), {
      pm_review_status: 'accepted',
      pm_reviewed_by: 'pm',
      pm_reviewed_at: String(Date.now()),
    });
    await redis.zrem(keys.reviewRequested.pending, reverifyId);
    expect(await redis.hget(keys.hash.task('crash-acceptance'), 'resolution_status')).toBe('required');
    expect(await redis.hget(keys.hash.task('crash-downstream'), 'status')).toBe('blocked');

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task('crash-acceptance'))).toMatchObject({
      resolution_status: 'resolved',
      resolution_action: 'reverify',
      resolution_task_id: reverifyId,
      resolved_by_task: reverifyId,
    });
    expect(await redis.hgetall(keys.hash.task('crash-downstream'))).toMatchObject({
      status: 'pending',
      block_reason: '',
    });
    expect(await redis.zscore(keys.zset.status.blocked, 'crash-downstream')).toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, 'crash-downstream')).not.toBeNull();

    const dependencyReadyEvents = async () => {
      const rows = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
      return rows.filter(([, fields]) => fields.includes('dependency_ready') && fields.includes('crash-downstream'));
    };
    expect(await dependencyReadyEvents()).toHaveLength(1);
    await reconcileResolutionBacklog(redis);
    expect(await dependencyReadyEvents()).toHaveLength(1);
    expect((await claimAs('crash-downstream-worker', ['code'])).data?.task_id).toBe('crash-downstream');
  });

  it('升级补偿对历史 done+rejected acceptance 复用来源 repair，重复运行不生成自身 repair', async () => {
    await completeCode('legacy-source', 'legacy-implementer');
    await completeAcceptance('legacy-acceptance', ['legacy-source'], 'legacy-reviewer');
    await redis.hset(keys.hash.task('legacy-acceptance'), {
      pm_review_status: 'rejected',
      pm_reject_reason: '旧版本验收拒绝但没有来源 repair。',
    });

    const first = await reconcileResolutionBacklog(redis);
    expect(first.repaired_task_ids).toContain('legacy-acceptance');
    expect(await redis.exists(keys.hash.task('legacy-source-repair-1'))).toBe(1);
    expect(await redis.exists(keys.hash.task('legacy-acceptance-repair-1'))).toBe(0);

    const second = await reconcileResolutionBacklog(redis);
    expect(second).toEqual({ repaired_task_ids: [], needs_pm_decision_task_ids: [] });
    expect(await redis.zrange(keys.zset.status.pending, 0, -1)).toContain('legacy-source-repair-1');
  });
});
