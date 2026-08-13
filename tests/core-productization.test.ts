import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  dbRestore,
  getPlan,
  getPlans,
  getQuestion,
  getStatus,
  getTask,
  listQuestions,
  pmReview,
  planCreate,
  planSubmit,
  report,
  setSqliteStore,
  taskBlock,
  taskReset,
  taskResume,
  cancelTask,
} from '../src/server/service.js';
import {
  activateOwnership,
  generateToken,
  writePlanToRedis,
  writeTaskToRedis,
} from '../src/redis/ownership.js';
import { keys, pendingScore } from '../src/redis/keys.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { Supervisor, SupervisedProject } from '../src/worker/supervisor.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT_PATH = '/tmp/biao-core-productization-project';

let redis: Redis;
const temporaryPaths: string[] = [];

beforeAll(async () => {
  mkdirSync(PROJECT_PATH, { recursive: true });
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterEach(() => {
  setSqliteStore(null);
  vi.restoreAllMocks();
});

afterAll(() => {
  redis.disconnect();
  for (const path of temporaryPaths) rmSync(path, { recursive: true, force: true });
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
});

async function seedPlan(planId = 'core-plan', projectPath = PROJECT_PATH): Promise<void> {
  await writePlanToRedis(
    redis,
    {
      plan_id: planId,
      title: planId,
      project_path: projectPath,
      default_assignee: 'auto',
      default_priority: 5,
      phases: [{ id: 'impl', name: '实现' }],
    },
    0,
  );
}

async function seedTask(
  taskId: string,
  overrides: Record<string, unknown> = {},
  planId = 'core-plan',
  projectPath = PROJECT_PATH,
): Promise<void> {
  await writeTaskToRedis(
    redis,
    {
      task_id: taskId,
      title: taskId,
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: 5,
      timeout_seconds: 60,
      verify: [],
      ...overrides,
    } as never,
    `# ${taskId}`,
    planId,
    projectPath,
    5,
  );
}

function writeTaskArtifacts(projectPath: string, taskId: string, markdown: string) {
  const resultDir = join(projectPath, 'work', taskId);
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  const resultJsonPath = join(resultDir, 'result.json');
  writeFileSync(resultPath, markdown);
  writeFileSync(resultJsonPath, JSON.stringify({ task_id: taskId, status: 'done' }));
  return { resultPath, resultJsonPath };
}

function createPlanDir(opts: {
  planId: string;
  projectPath: string;
  taskId: string;
  priority?: number;
  assignee?: string;
}): string {
  mkdirSync(opts.projectPath, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'biao-core-plan-'));
  temporaryPaths.push(dir);
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(
    join(dir, 'index.md'),
    `---\nplan_id: ${opts.planId}\ntitle: ${opts.planId}\nproject_path: ${opts.projectPath}\nphases:\n  - id: impl\n    name: 实现\n---\n\n# ${opts.planId}\n`,
  );
  writeFileSync(
    join(dir, 'tasks', 'T01.md'),
    `---\ntask_id: ${opts.taskId}\ntitle: ${opts.taskId}\ntype: code\nphase: impl\nassignee: ${opts.assignee ?? 'auto'}\npriority: ${opts.priority ?? 5}\ntimeout_seconds: 60\nverify: []\n---\n\n# ${opts.taskId}\n`,
  );
  return dir;
}

async function claimAs(agentId: string, agentType = 'mock') {
  await agentRegister(redis, agentId, agentType, ['code', 'acceptance']);
  return claim(redis, { agent_id: agentId, blocking: false, timeout_ms: 50 });
}

async function eventsForTask(taskId: string): Promise<Record<string, string>[]> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw.map(([, fields]) => {
    const event: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 2) event[fields[index]] = fields[index + 1];
    return event;
  }).filter((event) => event.task_id === taskId);
}

describe('report 在验证通过前不消耗运行态', () => {
  it('重新 claim 会清掉异常遗留的旧验收轮次，新的 report 只能重新等待 PM', async () => {
    await seedTask('fresh-review-round');
    await redis.hset(keys.hash.task('fresh-review-round'), {
      pm_review_status: 'accepted',
      pm_reviewed_by: 'stale-pm',
      pm_reviewed_at: '1',
      pm_review_comment: 'old round',
      pm_accept_effects_applied: 'true',
    });

    const claimed = await claimAs('fresh-round-worker');
    expect(claimed.data?.task_id).toBe('fresh-review-round');
    expect(await redis.hmget(
      keys.hash.task('fresh-review-round'),
      'pm_review_status',
      'pm_reviewed_by',
      'pm_accept_effects_applied',
    )).toEqual(['', '', '']);

    const reported = await report(redis, {
      task_id: 'fresh-review-round',
      agent_id: 'fresh-round-worker',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [],
    });
    expect(reported.ok).toBe(true);
    expect(await redis.hget(keys.hash.task('fresh-review-round'), 'pm_review_status')).toBe('');
    expect(await redis.zscore(keys.reviewRequested.pending, 'fresh-review-round')).not.toBeNull();
  });

  it('缺少声明的 verify 结果时保留 lease、ownership 和 running', async () => {
    await seedTask('verify-required', {
      ownership: { files: ['src/core/**'] },
      verify: [{ cmd: 'npm test', expect_exit: 0 }],
    });
    const claimed = await claimAs('worker-a');
    const token = claimed.data!.claim_token;

    const result = await report(redis, {
      task_id: 'verify-required',
      agent_id: 'worker-a',
      claim_token: token,
      status: 'done',
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFY_RESULTS_REQUIRED');
    expect(await redis.get(keys.string.lease('verify-required'))).toBe(token);
    expect(await redis.hget(keys.hash.fileOwnership, 'src/core/**')).not.toBeNull();
    expect((await getTask(redis, 'verify-required')).data?.status).toBe('running');
    expect((await redis.hgetall(keys.hash.agent('worker-a'))).status).toBe('busy');
  });

  it('verify 命令或期望退出码不匹配时拒绝 done', async () => {
    await seedTask('verify-mismatch', { verify: [{ cmd: 'npm test', expect_exit: 2 }] });
    const claimed = await claimAs('worker-a');

    const result = await report(redis, {
      task_id: 'verify-mismatch',
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'npm test', exit_code: 0, passed: true }],
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFY_RESULTS_MISMATCH');
    expect((await getTask(redis, 'verify-mismatch')).data?.status).toBe('running');
  });

  it('verify 结果中有额外命令时拒绝 done', async () => {
    await seedTask('verify-extra', { verify: [{ cmd: 'npm test', expect_exit: 0 }] });
    const claimed = await claimAs('worker-a');

    const result = await report(redis, {
      task_id: 'verify-extra',
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [
        { cmd: 'npm test', exit_code: 0, passed: true },
        { cmd: 'npm run build', exit_code: 0, passed: true },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VERIFY_RESULTS_MISMATCH');
  });
});

describe('acceptance 完成闸门', () => {
  async function seedAcceptance(): Promise<{ claimToken: string; resultPath: string; resultJsonPath: string }> {
    await seedTask('implementation', { verify: [{ cmd: 'echo ok', expect_exit: 0 }] });
    const impl = await claimAs('implementer');
    await report(redis, {
      task_id: 'implementation',
      agent_id: 'implementer',
      claim_token: impl.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo ok', exit_code: 0, passed: true }],
    });
    await seedTask('acceptance', {
      type: 'acceptance',
      acceptance_for: ['implementation'],
      verify: [],
    });
    const acceptance = await claimAs('reviewer');
    const artifacts = writeTaskArtifacts(PROJECT_PATH, 'acceptance', '# 验收\n\n- 结论：✅ PASS\n');
    return { claimToken: acceptance.data!.claim_token, ...artifacts };
  }

  it('acceptance done 没有任何验证结果时拒绝', async () => {
    const { claimToken, resultPath, resultJsonPath } = await seedAcceptance();
    const result = await report(redis, {
      task_id: 'acceptance',
      agent_id: 'reviewer',
      claim_token: claimToken,
      status: 'done',
      result_path: resultPath,
      result_json_path: resultJsonPath,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACCEPTANCE_VERIFY_REQUIRED');
    expect(await redis.get(keys.string.lease('acceptance'))).toBe(claimToken);
  });

  it('acceptance done 没有 result_path 时拒绝', async () => {
    const { claimToken } = await seedAcceptance();
    const result = await report(redis, {
      task_id: 'acceptance',
      agent_id: 'reviewer',
      claim_token: claimToken,
      status: 'done',
      verify_results: [{ cmd: 'manual acceptance', exit_code: 0, passed: true }],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACCEPTANCE_RESULT_REQUIRED');
  });

  it('acceptance done 的 result_path 越出受控根目录时拒绝', async () => {
    const { claimToken } = await seedAcceptance();
    const result = await report(redis, {
      task_id: 'acceptance',
      agent_id: 'reviewer',
      claim_token: claimToken,
      status: 'done',
      verify_results: [{ cmd: 'manual acceptance', exit_code: 0, passed: true }],
      result_path: '/etc/passwd',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESULT_PATH_OUTSIDE_WORKSPACE');
    expect((await getTask(redis, 'acceptance')).data?.status).toBe('running');
  });

  it('acceptance done 的 result_json_path 越出受控根目录时拒绝且不消耗租约', async () => {
    const { claimToken, resultPath } = await seedAcceptance();
    const result = await report(redis, {
      task_id: 'acceptance',
      agent_id: 'reviewer',
      claim_token: claimToken,
      status: 'done',
      verify_results: [{ cmd: 'manual acceptance', exit_code: 0, passed: true }],
      result_path: resultPath,
      result_json_path: '/etc/passwd',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESULT_PATH_OUTSIDE_WORKSPACE');
    expect(await redis.get(keys.string.lease('acceptance'))).toBe(claimToken);
    expect((await getTask(redis, 'acceptance')).data?.status).toBe('running');
  });
});

describe('PM review 与状态可见性', () => {
  it('有待领取任务且无 Worker 时返回 clone 后生成入口，不硬编码端口或不存在的文档', async () => {
    await seedPlan();
    await seedTask('pending-needs-worker');
    const status = await getStatus(redis);
    expect(status.data.hint).toEqual({
      code: 'NO_ONLINE_WORKERS',
      message: '暂无在线 Worker。请先完成 bootstrap，再启动至少一个执行者。',
      doctor: '.biao/doctor',
      pm_guide: '.biao/PM_AGENT.md',
      start_worker: '.biao/worker-codex、.biao/worker-kimi 或 .biao/worker-custom',
    });
  });

  it('全部计划已关闭时不因孤立 pending 审计提示启动 Worker', async () => {
    await seedPlan();
    await seedTask('completed-task');
    await redis.zrem(keys.zset.status.pending, 'completed-task');
    await redis.zadd(keys.zset.status.done, Date.now(), 'completed-task');
    await redis.hset(keys.hash.task('completed-task'), {
      status: 'done',
      pm_review_status: 'accepted',
    });
    // 防御历史损坏/升级残留：闭合 plan 外仍有孤立索引时也不应唤醒执行者。
    await redis.zadd(keys.zset.status.pending, Date.now() + 1, 'orphan-pending-audit');

    const status = await getStatus(redis);
    expect(status.data.hint).toBeNull();
  });

  it('计划仍 active 但只有孤立 pending 索引时也不提示启动 Worker', async () => {
    await seedPlan();
    await seedTask('running-keeps-plan-active');
    await redis.zrem(keys.zset.status.pending, 'running-keeps-plan-active');
    await redis.zadd(keys.zset.status.running, Date.now(), 'running-keeps-plan-active');
    await redis.hset(keys.hash.task('running-keeps-plan-active'), { status: 'running' });
    await redis.zadd(keys.zset.status.pending, Date.now() + 1, 'orphan-pending-audit');

    const status = await getStatus(redis);
    expect(status.data.hint).toBeNull();
  });

  it('非 done 任务不能执行 PM review', async () => {
    await seedTask('pending-review');
    const result = await pmReview(redis, 'pending-review', {
      verdict: 'accept',
      reviewed_by: 'pm',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TASK_NOT_DONE');
  });

  it('getPlan 单独返回 accepted/rejected/pending 评审计数及每任务 review_status', async () => {
    await seedPlan();
    await seedTask('review-rejected', { verify: [] });
    const claimed = await claimAs('worker-a');
    await report(redis, {
      task_id: 'review-rejected',
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, 'review-rejected', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '验收未通过',
    });

    const plan = await getPlan(redis, 'core-plan');
    expect(plan.data).toMatchObject({ reviews: { pending: 0, accepted: 0, rejected: 1 } });
    expect(plan.data.tasks.done[0].review_status).toBe('rejected');
    const status = await getStatus(redis);
    expect(status.data).toMatchObject({ reviews: { pending: 0, accepted: 0, rejected: 1 } });
  });

  it('全局状态保留原始计数，并把已闭环失败和拒绝归入历史而非当前异常', async () => {
    await seedPlan();
    for (const taskId of ['resolved-failed', 'current-failed', 'resolved-rejected', 'current-rejected']) {
      await seedTask(taskId);
      await redis.zrem(keys.zset.status.pending, taskId);
    }

    const now = Date.now();
    await redis.zadd(keys.zset.status.failed, now, 'resolved-failed', now + 1, 'current-failed');
    await redis.hset(keys.hash.task('resolved-failed'), {
      status: 'failed',
      resolution_status: 'resolved',
      resolved_by_task: 'resolved-failed-repair-1',
    });
    await redis.hset(keys.hash.task('current-failed'), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
    });

    await redis.zadd(keys.zset.status.done, now + 2, 'resolved-rejected', now + 3, 'current-rejected');
    await redis.hset(keys.hash.task('resolved-rejected'), {
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'resolved',
      resolved_by_task: 'resolved-rejected-repair-1',
    });
    await redis.hset(keys.hash.task('current-rejected'), {
      status: 'done',
      pm_review_status: 'rejected',
    });

    const status = await getStatus(redis);
    expect(status.data).toMatchObject({
      // 兼容字段仍是不可变审计总数。
      tasks: { failed: 2 },
      reviews: { rejected: 2 },
      // 新字段才用于首页的当前红色异常与历史审计。
      attention: { failed: 1, rejected: 1, needs_pm_decision: 1 },
      history: { resolved_failed: 1, resolved_rejected: 1 },
    });
  });

  it('blocked 和 cancelled 在 getPlan/getStatus 中都有独立桶', async () => {
    await seedPlan();
    await seedTask('block-dependency');
    await seedTask('to-block', { depends_on: ['block-dependency'] });
    await seedTask('to-cancel');
    const now = Date.now();
    await agentRegister(redis, 'worker-a', 'mock', ['code']);
    await redis.zrem(keys.zset.status.pending, 'to-block');
    await redis.zadd(keys.zset.status.running, now + 60_000, 'to-block');
    await redis.hset(keys.hash.task('to-block'), {
      status: 'running', claimed_by: 'worker-a', claimed_at: String(now), expire_at: String(now + 60_000),
    });
    await redis.hset(keys.hash.agent('worker-a'), { status: 'busy', current_task: 'to-block' });
    await redis.set(keys.string.lease('to-block'), 'to-block-token', 'EX', 60);
    await taskBlock(redis, 'to-block', 'worker-a', {
      claim_token: 'to-block-token',
      reason: 'waiting_dependency',
    });
    await cancelTask(redis, 'to-cancel');

    const plan = await getPlan(redis, 'core-plan');
    expect(plan.data.tasks.blocked.map((t: { task_id: string }) => t.task_id)).toContain('to-block');
    expect(plan.data.tasks.cancelled.map((t: { task_id: string }) => t.task_id)).toContain('to-cancel');
    const status = await getStatus(redis);
    expect(status.data).toMatchObject({ tasks: { blocked: 1, cancelled: 1 } });
  });

  it('plan 只有所有有效任务 PM accepted 后才派生 completed', async () => {
    await seedPlan();
    await seedTask('completion-gated');
    const claimed = await claimAs('worker-a');
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });
    expect((await getPlan(redis, 'core-plan')).data.status).toBe('active');

    await pmReview(redis, 'completion-gated', { verdict: 'accept', reviewed_by: 'pm' });

    const completedPlan = await getPlan(redis, 'core-plan');
    expect(completedPlan.data.status).toBe('completed');
    expect(completedPlan.data.tasks.done[0]).toMatchObject({
      review_status: 'accepted',
      pm_review_status: 'accepted',
    });
    expect((await getPlans(redis)).data!.plans.find((plan) => plan.plan_id === 'core-plan')?.status).toBe('completed');
    expect((await getStatus(redis)).data.plans[0].status).toBe('completed');
  });

  it('已验收当前任务不被历史 superseded 和 resolved failed 污染，Supervisor 按 completed 自动停止', async () => {
    await seedPlan();
    await seedTask('accepted-current');
    const claimed = await claimAs('current-worker');
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'current-worker',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, 'accepted-current', { verdict: 'accept', reviewed_by: 'pm' });

    await seedTask('resolved-failed-history');
    await redis.zrem(keys.zset.status.pending, 'resolved-failed-history');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'resolved-failed-history');
    await redis.hset(keys.hash.task('resolved-failed-history'), {
      status: 'failed',
      resolution_status: 'resolved',
      resolution_action: 'repair',
      resolved_by_task: 'accepted-current',
    });

    await seedTask('superseded-history');
    await redis.zrem(keys.zset.status.pending, 'superseded-history');
    await redis.zadd(keys.zset.status.superseded, Date.now(), 'superseded-history');
    await redis.hset(keys.hash.task('superseded-history'), {
      status: 'superseded',
      superseded_by: 'pm',
      superseded_reason: '误派的历史任务',
    });

    expect((await getPlan(redis, 'core-plan')).data.status).toBe('completed');
    expect((await getPlans(redis)).data!.plans.find((plan) => plan.plan_id === 'core-plan')?.status).toBe('completed');
    expect((await getStatus(redis)).data.plans.find((plan: { plan_id: string }) => plan.plan_id === 'core-plan')?.status).toBe('completed');

    const project = new SupervisedProject({
      planId: 'core-plan',
      isClosed: async () => ['completed', 'cancelled'].includes(
        ((await getPlan(redis, 'core-plan')).data as { status: string }).status,
      ),
      pendingItems: async () => [],
    });
    expect(await new Supervisor({ biaoUrl: 'memory://test', projects: [project], once: true }).runOnce()).toBe(false);
    expect(project.paused).toBe(true);
  });

  it('未闭合的 rejected/failed 是 failed，blocked 是 active，显式 cancelled 仍是 cancelled', async () => {
    const cases = [
      { planId: 'rejected-plan', taskId: 'unresolved-rejected', taskStatus: 'done', review: 'rejected', expected: 'failed' },
      { planId: 'failed-plan', taskId: 'unresolved-failed', taskStatus: 'failed', expected: 'failed' },
      { planId: 'blocked-plan', taskId: 'unresolved-blocked', taskStatus: 'blocked', expected: 'active' },
      { planId: 'cancelled-plan', taskId: 'explicit-cancelled', taskStatus: 'cancelled', expected: 'cancelled' },
    ] as const;

    for (const item of cases) {
      await seedPlan(item.planId);
      await seedTask(item.taskId, {}, item.planId);
      await redis.zrem(keys.zset.status.pending, item.taskId);
      await redis.zadd((keys.zset.status as Record<string, string>)[item.taskStatus], Date.now(), item.taskId);
      await redis.hset(keys.hash.task(item.taskId), {
        status: item.taskStatus,
        ...(item.review ? { pm_review_status: item.review } : {}),
      });
      expect((await getPlan(redis, item.planId)).data.status).toBe(item.expected);
    }
  });

  it('历史 superseded 与未闭合任务共存时不会把 failed 或 active 误降为 cancelled', async () => {
    const cases = [
      { planId: 'superseded-plus-failed', taskId: 'still-failed', taskStatus: 'failed', expected: 'failed' },
      { planId: 'superseded-plus-blocked', taskId: 'still-blocked', taskStatus: 'blocked', expected: 'active' },
    ] as const;

    for (const item of cases) {
      await seedPlan(item.planId);
      await seedTask(item.taskId, {}, item.planId);
      await redis.zrem(keys.zset.status.pending, item.taskId);
      await redis.zadd((keys.zset.status as Record<string, string>)[item.taskStatus], Date.now(), item.taskId);
      await redis.hset(keys.hash.task(item.taskId), 'status', item.taskStatus);

      const historyId = `${item.planId}-history`;
      await seedTask(historyId, {}, item.planId);
      await redis.zrem(keys.zset.status.pending, historyId);
      await redis.zadd(keys.zset.status.superseded, Date.now(), historyId);
      await redis.hset(keys.hash.task(historyId), {
        status: 'superseded',
        superseded_by: 'pm',
        superseded_reason: '历史退出',
      });

      expect((await getPlan(redis, item.planId)).data.status).toBe(item.expected);
    }
  });

  it('accepted 验收不可反向 reject，重复 accept 只幂等回放且不改写审计', async () => {
    await seedPlan();
    await seedTask('accepted-immutable');
    const claimed = await claimAs('implementation-worker');
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'implementation-worker',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });
    expect((await pmReview(redis, 'accepted-immutable', {
      verdict: 'accept',
      reviewed_by: 'pm-original',
      comment: '原始验收通过',
    })).ok).toBe(true);

    expect(await pmReview(redis, 'accepted-immutable', {
      verdict: 'reject',
      reviewed_by: 'pm-late',
      reject_reason: '迟到的反向决定',
    })).toMatchObject({
      ok: false,
      error: { code: 'PM_REVIEW_ALREADY_ACCEPTED' },
    });
    expect(await pmReview(redis, 'accepted-immutable', {
      verdict: 'accept',
      reviewed_by: 'pm-retry',
      comment: '网络重试不应改写',
    })).toEqual({
      ok: true,
      data: { task_id: 'accepted-immutable', review_status: 'accepted' },
    });

    expect(await redis.hgetall(keys.hash.task('accepted-immutable'))).toMatchObject({
      pm_review_status: 'accepted',
      pm_reviewed_by: 'pm-original',
      pm_review_comment: '原始验收通过',
      resolution_status: '',
      resolution_task_id: '',
    });
    expect(await redis.exists(keys.hash.task('accepted-immutable-repair-1'))).toBe(0);
  });

  it('并发 reject 只落一份不可变审计、一条事件和一条 repair', async () => {
    await seedPlan();
    await seedTask('concurrent-review');
    const claimed = await claimAs('concurrent-worker');
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'concurrent-worker',
      claim_token: claimed.data!.claim_token,
      status: 'done',
    });

    const decisions = await Promise.all([
      pmReview(redis, 'concurrent-review', {
        verdict: 'reject',
        reviewed_by: 'pm-a',
        reject_reason: 'A 原因',
        fix_instructions: '按 A 修复',
      }),
      pmReview(redis, 'concurrent-review', {
        verdict: 'reject',
        reviewed_by: 'pm-b',
        reject_reason: 'B 原因',
        fix_instructions: '按 B 修复',
      }),
    ]);

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.ok)).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'PM_REJECTION_ALREADY_RECORDED' }) }),
    ]);
    const audit = await redis.hgetall(keys.hash.task('concurrent-review'));
    expect([
      ['pm-a', 'A 原因', '按 A 修复'],
      ['pm-b', 'B 原因', '按 B 修复'],
    ]).toContainEqual([audit.pm_reviewed_by, audit.pm_reject_reason, audit.pm_fix_instructions]);
    expect(audit).toMatchObject({
      pm_review_status: 'rejected',
      resolution_task_id: 'concurrent-review-repair-1',
      resolution_task_ids: 'concurrent-review-repair-1',
    });
    const events = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(events.filter(([, fields]) =>
      fields.includes('pm_reviewed') && fields.includes('concurrent-review') && fields.includes('reject'),
    )).toHaveLength(1);
    expect(await redis.exists(keys.hash.task('concurrent-review-repair-2'))).toBe(0);
  });

  it('reset 已验收任务时清除旧结果与旧 PM review，要求重新验收', async () => {
    await seedPlan();
    await seedTask('reset-reviewed');
    const claimed = await claimAs('worker-a');
    const artifacts = writeTaskArtifacts(PROJECT_PATH, 'reset-reviewed', '# 交付结果\n\n- 状态：PASS ✅\n');
    const reported = await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
    });
    expect(reported.ok).toBe(true);
    await pmReview(redis, 'reset-reviewed', { verdict: 'accept', reviewed_by: 'pm' });

    expect((await taskReset(redis, 'reset-reviewed', { force: true, reset_by: 'pm' })).ok).toBe(true);

    const resetHash = await redis.hgetall(keys.hash.task('reset-reviewed'));
    expect(resetHash).toMatchObject({
      status: 'pending',
      result_path: '',
      result_json_path: '',
      done_at: '',
      pm_review_status: '',
      pm_reviewed_by: '',
      pm_reviewed_at: '',
      pm_review_comment: '',
    });
    expect((await getPlan(redis, 'core-plan')).data).toMatchObject({
      status: 'active',
      reviews: { pending: 0, accepted: 0, rejected: 0 },
    });
  });

  it('已 resolved 的 repair lineage 不能被 force reset 清空来源或修复任务的审计', async () => {
    await seedPlan();
    await seedTask('resolved-repair-source');
    const source = await claimAs('resolved-source-worker');
    await report(redis, {
      task_id: 'resolved-repair-source',
      agent_id: 'resolved-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    const rejected = await pmReview(redis, 'resolved-repair-source', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要补齐验收证据',
    });
    expect(rejected.ok).toBe(true);
    const repairId = rejected.data!.fix_task_id!;

    const repair = await claimAs('resolved-repair-worker');
    expect(repair.data?.task_id).toBe(repairId);
    await report(redis, {
      task_id: repairId,
      agent_id: 'resolved-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    expect((await pmReview(redis, repairId, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    const sourceAudit = await redis.hgetall(keys.hash.task('resolved-repair-source'));
    const repairAudit = await redis.hgetall(keys.hash.task(repairId));
    expect(sourceAudit).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'resolved',
      resolved_by_task: repairId,
    });

    expect(await taskReset(redis, 'resolved-repair-source', { force: true, reset_by: 'pm' })).toMatchObject({
      ok: false,
      error: { code: 'RESOLUTION_AUDIT_IMMUTABLE' },
    });
    expect(await taskReset(redis, repairId, { force: true, reset_by: 'pm' })).toMatchObject({
      ok: false,
      error: { code: 'RESOLUTION_AUDIT_IMMUTABLE' },
    });

    expect(await redis.hgetall(keys.hash.task('resolved-repair-source'))).toMatchObject({
      status: sourceAudit.status,
      pm_review_status: sourceAudit.pm_review_status,
      pm_reject_reason: sourceAudit.pm_reject_reason,
      resolution_status: sourceAudit.resolution_status,
      resolution_task_id: sourceAudit.resolution_task_id,
      resolved_by_task: sourceAudit.resolved_by_task,
    });
    expect(await redis.hgetall(keys.hash.task(repairId))).toMatchObject({
      status: repairAudit.status,
      pm_review_status: repairAudit.pm_review_status,
      fix_for: repairAudit.fix_for,
      repair_root_task_id: repairAudit.repair_root_task_id,
    });
  });

  it('已 resolved 的 failed 来源同样保留失败证据，不能被 force reset', async () => {
    await seedPlan();
    await seedTask('resolved-failed-source');
    const source = await claimAs('resolved-failed-source-worker');
    const failed = await report(redis, {
      task_id: 'resolved-failed-source',
      agent_id: 'resolved-failed-source-worker',
      claim_token: source.data!.claim_token,
      status: 'failed',
    });
    expect(failed.ok).toBe(true);
    const repairId = failed.data!.resolution!.repair_task_id!;

    const repair = await claimAs('resolved-failed-repair-worker');
    expect(repair.data?.task_id).toBe(repairId);
    await report(redis, {
      task_id: repairId,
      agent_id: 'resolved-failed-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    expect((await pmReview(redis, repairId, { verdict: 'accept', reviewed_by: 'pm' })).ok).toBe(true);

    const beforeReset = await redis.hgetall(keys.hash.task('resolved-failed-source'));
    expect(beforeReset).toMatchObject({ status: 'failed', resolution_status: 'resolved', resolved_by_task: repairId });
    expect(await taskReset(redis, 'resolved-failed-source', { force: true, reset_by: 'pm' })).toMatchObject({
      ok: false,
      error: { code: 'RESOLUTION_AUDIT_IMMUTABLE' },
    });
    expect(await redis.hgetall(keys.hash.task('resolved-failed-source'))).toMatchObject({
      status: beforeReset.status,
      failed_reason: beforeReset.failed_reason,
      resolution_status: beforeReset.resolution_status,
      resolved_by_task: beforeReset.resolved_by_task,
    });
  });
});

describe('手工 resume 的被动阻塞恢复', () => {
  it('文件仍被占用时保留 waiting_file_release，不写错误的 worker 就绪事件', async () => {
    await seedPlan();
    await seedTask('resume-file-owner', {
      assignee: 'resume-file-owner-agent',
      ownership: { files: ['src/resume-locked/**'] },
    });
    await seedTask('resume-file-waiter', {
      assignee: 'resume-file-waiter-agent',
      ownership: { files: ['src/resume-locked/**'] },
    });
    expect((await claimAs('resume-file-owner-agent')).data?.task_id).toBe('resume-file-owner');

    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'resume-file-waiter');
    await redis.zadd(keys.zset.status.running, now + 60_000, 'resume-file-waiter');
    await redis.hset(keys.hash.task('resume-file-waiter'), {
      status: 'running', claimed_by: 'resume-file-waiter-agent', claimed_at: String(now), expire_at: String(now + 60_000),
    });
    await redis.set(keys.string.lease('resume-file-waiter'), 'resume-file-waiter-token', 'EX', 60);
    expect((await taskBlock(redis, 'resume-file-waiter', 'resume-file-waiter-agent', {
      claim_token: 'resume-file-waiter-token', reason: 'waiting_file_release',
    })).ok).toBe(true);

    expect(await taskResume(redis, 'resume-file-waiter', 'pm')).toMatchObject({
      ok: false,
      error: { code: 'WAITING_FILE_RELEASE' },
    });
    expect(await redis.hgetall(keys.hash.task('resume-file-waiter'))).toMatchObject({
      status: 'blocked',
      block_reason: 'waiting_file_release',
    });
    expect(await redis.zscore(keys.zset.status.pending, 'resume-file-waiter')).toBeNull();
    expect((await eventsForTask('resume-file-waiter')).map((event) => event.type)).not.toEqual(
      expect.arrayContaining(['task_ready', 'task_resumed']),
    );
  });

  it('依赖尚未形成有效交付时保留 waiting_dependency，不写错误的 worker 就绪事件', async () => {
    await seedPlan();
    await seedTask('resume-dependency-source');
    await seedTask('resume-dependency-waiter', {
      assignee: 'resume-dependency-waiter-agent',
      depends_on: ['resume-dependency-source'],
    });

    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'resume-dependency-waiter');
    await redis.zadd(keys.zset.status.running, now + 60_000, 'resume-dependency-waiter');
    await redis.hset(keys.hash.task('resume-dependency-waiter'), {
      status: 'running', claimed_by: 'resume-dependency-waiter-agent', claimed_at: String(now), expire_at: String(now + 60_000),
    });
    await redis.set(keys.string.lease('resume-dependency-waiter'), 'resume-dependency-waiter-token', 'EX', 60);
    expect((await taskBlock(redis, 'resume-dependency-waiter', 'resume-dependency-waiter-agent', {
      claim_token: 'resume-dependency-waiter-token', reason: 'waiting_dependency',
    })).ok).toBe(true);

    expect(await taskResume(redis, 'resume-dependency-waiter', 'pm')).toMatchObject({
      ok: false,
      error: { code: 'WAITING_DEPENDENCY' },
    });
    expect(await redis.hgetall(keys.hash.task('resume-dependency-waiter'))).toMatchObject({
      status: 'blocked',
      block_reason: 'waiting_dependency',
    });
    expect(await redis.zscore(keys.zset.status.pending, 'resume-dependency-waiter')).toBeNull();
    expect((await eventsForTask('resume-dependency-waiter')).map((event) => event.type)).not.toEqual(
      expect.arrayContaining(['dependency_ready', 'task_ready', 'task_resumed']),
    );
  });
});

describe('文件占用解除后的自动恢复', () => {
  it('PM reset 释放最后一个占用后只唤醒 file waiter 一次，且不误解锁 PM Question', async () => {
    await seedPlan();
    await seedTask('reset-owner', {
      assignee: 'owner-agent',
      ownership: { files: ['src/shared/**'] },
    });
    await seedTask('file-waiter', {
      assignee: 'waiter-agent',
      ownership: { files: ['src/shared/**'] },
    });
    await seedTask('pm-question-waiter', {
      assignee: 'pm-waiter-agent',
      ownership: { files: ['src/shared/**'] },
    });

    const owner = await claimAs('owner-agent');
    expect(owner.data?.task_id).toBe('reset-owner');
    await agentRegister(redis, 'waiter-agent', 'mock', ['code']);

    // file-waiter 已拿到一个不冲突的执行片段、随后发现 shared 文件仍被 owner 占用；
    // 直接搭建该运行态以验证 /block → reset-release 的恢复状态机，而不是模拟 ownership 冲突本身。
    const now = Date.now();
    await redis.zrem(keys.zset.status.pending, 'file-waiter', 'pm-question-waiter');
    await redis.zadd(keys.zset.status.running, now + 60_000, 'file-waiter');
    await redis.hset(keys.hash.task('file-waiter'), {
      status: 'running', claimed_by: 'waiter-agent', claimed_at: String(now), expire_at: String(now + 60_000),
    });
    await redis.set(keys.string.lease('file-waiter'), 'waiter-token', 'EX', 60);
    await redis.hset(keys.hash.agent('waiter-agent'), { status: 'busy', current_task: 'file-waiter' });
    expect((await taskBlock(redis, 'file-waiter', 'waiter-agent', {
      claim_token: 'waiter-token', reason: 'waiting_file_release',
    })).ok).toBe(true);

    // 另一个等待 PM 回复的 task 恰好声明了同一文件，也必须保持 blocked。
    await redis.hset(keys.hash.task('pm-question-waiter'), {
      status: 'blocked', block_reason: 'waiting_pm_reply', blocked_at: String(now),
    });
    await redis.zadd(keys.zset.status.blocked, now, 'pm-question-waiter');

    expect((await taskReset(redis, 'reset-owner', { reset_by: 'pm' })).ok).toBe(true);
    expect(await redis.hget(keys.hash.task('file-waiter'), 'status')).toBe('pending');
    expect(await redis.hget(keys.hash.task('pm-question-waiter'), 'status')).toBe('blocked');

    const taskReadyEvents = ((await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][])
      .map(([, fields]) => Object.fromEntries(fields.reduce<string[][]>((pairs, value, index) => {
        if (index % 2 === 0) pairs.push([value, fields[index + 1]]);
        return pairs;
      }, [])))
      .filter((event) => event.type === 'task_ready' && event.task_id === 'file-waiter');
    expect(taskReadyEvents).toHaveLength(1);

    // 再次 reset 已经 pending 的 owner 是幂等 no-op，不能产生第二次 doorbell。
    expect((await taskReset(redis, 'reset-owner', { reset_by: 'pm' })).ok).toBe(true);
    const taskReadyAfterReplay = ((await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][])
      .filter(([, fields]) => fields.includes('task_ready') && fields.includes('file-waiter'));
    expect(taskReadyAfterReplay).toHaveLength(1);
  });
});

describe('plan 跨项目身份冲突', () => {
  it('已属于另一 plan 的 task_id 不能被新 plan 覆盖', async () => {
    const first = createPlanDir({ planId: 'plan-a', projectPath: '/tmp/biao-project-a', taskId: 'shared-task' });
    const second = createPlanDir({ planId: 'plan-b', projectPath: '/tmp/biao-project-b', taskId: 'shared-task' });
    expect((await planSubmit(redis, first)).ok).toBe(true);

    const result = await planSubmit(redis, second);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TASK_ID_CONFLICT');
    expect(await redis.hget(keys.hash.task('shared-task'), 'plan_id')).toBe('plan-a');
    expect(await redis.exists(keys.hash.plan('plan-b'))).toBe(0);
  });

  it('已属于另一 project_path 的 plan_id 不能被覆盖', async () => {
    const first = createPlanDir({ planId: 'shared-plan', projectPath: '/tmp/biao-project-a', taskId: 'task-a' });
    const second = createPlanDir({ planId: 'shared-plan', projectPath: '/tmp/biao-project-b', taskId: 'task-b' });
    expect((await planSubmit(redis, first)).ok).toBe(true);

    const result = await planSubmit(redis, second);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PLAN_ID_CONFLICT');
    expect(await redis.hget(keys.hash.plan('shared-plan'), 'project_path')).toBe('/tmp/biao-project-a');
    expect(await redis.exists(keys.hash.task('task-b'))).toBe(0);
  });
});

describe('planCreate 默认骨架可执行闭环', () => {
  it('新建计划可由独立实现/验收 worker 完成并经 PM 验收为 completed', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'biao-created-project-'));
    temporaryPaths.push(projectDir);
    const created = await planCreate(redis, {
      plan_id: 'created-plan',
      title: '新建项目',
      project_path: projectDir,
    });
    expect(created.ok).toBe(true);

    const implementation = await claimAs('implementer');
    expect(implementation.data?.task_id).toBe('created-plan-01-impl');
    expect((await report(redis, {
      task_id: implementation.data!.task_id,
      agent_id: 'implementer',
      claim_token: implementation.data!.claim_token,
      status: 'done',
    })).ok).toBe(true);

    const acceptance = await claimAs('reviewer');
    expect(acceptance.data?.task_id).toBe('created-plan-02-qa');
    expect(acceptance.data?.verify).toEqual([{ cmd: "printf 'PASS: acceptance evidence recorded\\n'", expect_exit: 0 }]);
    const artifacts = writeTaskArtifacts(projectDir, 'created-plan-02-qa', '# 验收\n\n- 默认闭环：PASS ✅\n');
    expect((await report(redis, {
      task_id: acceptance.data!.task_id,
      agent_id: 'reviewer',
      claim_token: acceptance.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
      verify_results: [{ cmd: "printf 'PASS: acceptance evidence recorded\\n'", exit_code: 0, passed: true }],
    })).ok).toBe(true);

    await pmReview(redis, 'created-plan-01-impl', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'created-plan-02-qa', { verdict: 'accept', reviewed_by: 'pm' });
    expect((await getPlan(redis, 'created-plan')).data.status).toBe('completed');
  });
});

describe('claim 调度语义', () => {
  it('按 priority 从高到低，同优先级按 created_at 从旧到新领取', async () => {
    await seedTask('low', { priority: 1 });
    await seedTask('high-new', { priority: 9 });
    await seedTask('high-old', { priority: 9 });
    await redis.hset(keys.hash.task('low'), 'created_at', '100');
    await redis.hset(keys.hash.task('high-new'), 'created_at', '300');
    await redis.hset(keys.hash.task('high-old'), 'created_at', '200');

    const result = await claimAs('worker-a');

    expect(result.data?.task_id).toBe('high-old');
  });

  it('assignee 只允许 auto、agent_id 或已注册 agent_type 匹配', async () => {
    await seedTask('assigned-other', { priority: 10, assignee: 'other-worker' });
    await seedTask('assigned-type', { priority: 9, assignee: 'hermes-a' });
    await seedTask('automatic', { priority: 1, assignee: 'auto' });

    const result = await claimAs('worker-a', 'hermes-a');

    expect(result.data?.task_id).toBe('assigned-type');
  });

  it('最高优先级候选的 lease NX 失败后继续下一候选', async () => {
    await seedTask('leased-high', { priority: 10 });
    await seedTask('available-low', { priority: 1 });
    await redis.set(keys.string.lease('leased-high'), 'somebody-else', 'EX', 60);

    const result = await claimAs('worker-a');

    expect(result.data?.task_id).toBe('available-low');
    expect((await getTask(redis, 'leased-high')).data?.status).toBe('pending');
  });
});

describe('ownership 安全', () => {
  it('claim token 不依赖 Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used for a security token');
    });
    expect(generateToken()).toMatch(/^tok_[a-f0-9]+$/);
  });

  it('对称重叠 glob 不能被低优先级声明静默覆盖', async () => {
    await activateOwnership(redis, 'owner-high', 'task-high', 9, ['src/app.ts'], 60, 'sha');

    // 这里验证的是 Redis ownership 层的对称 overlap / priority CAS，而不是受 claim
    // token 保护的 HTTP service 契约；直接走低层避免伪造一个不安全的 service 调用。
    const result = await activateOwnership(redis, 'owner-low', 'task-low', 2, ['src/**'], 60, 'sha', true);

    expect(result).toBe(false);
    expect(await redis.hget(keys.hash.fileOwnership, 'src/**')).toBeNull();
    expect(JSON.parse((await redis.hget(keys.hash.fileOwnership, 'src/app.ts'))!).agent_id).toBe('owner-high');
  });
});

describe('SQLite 完整恢复', () => {
  function fullTaskRow(taskId: string) {
    return {
      task_id: taskId,
      plan_id: 'sqlite-plan',
      title: taskId,
      type: 'acceptance',
      phase: 'qa',
      status: 'blocked',
      priority: 8,
      assignee: 'hermes-c',
      ownership_files: 'src/**',
      ownership_modules: 'scheduler,review',
      depends_on: 'source-task',
      timeout_seconds: 900,
      max_retries: 7,
      claimed_by: 'reviewer',
      claimed_at: '100',
      expire_at: '200',
      result_path: '/tmp/result.md',
      result_json_path: '/tmp/result.json',
      done_at: '',
      retries: 3,
      model_override: 'gpt-test',
      acceptance_for: 'source-task',
      verify: JSON.stringify([{ cmd: 'npm test', expect_exit: 0 }]),
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm',
      pm_reviewed_at: '300',
      pm_review_comment: 'needs fix',
      pm_reject_reason: 'broken',
      pm_fix_instructions: 'repair it',
      repair_ownership_extension: JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] }),
      goal_md: '# goal',
      created_at: '10',
      updated_at: '20',
    };
  }

  it('恢复 verify、phase、review、ownership_modules、repair ownership、max_retries、model_override 和 acceptance_for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-sqlite-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'sqlite-plan',
      title: 'sqlite-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      task_count: 1,
      created_at: '1',
      submitted_at: '2',
    });
    store.upsertTask(fullTaskRow('sqlite-task') as never);

    await dbRestore(redis, store);
    const hash = await redis.hgetall(keys.hash.task('sqlite-task'));

    expect(hash).toMatchObject({
      phase: 'qa',
      ownership_modules: 'scheduler,review',
      max_retries: '7',
      model_override: 'gpt-test',
      acceptance_for: 'source-task',
      pm_review_status: 'rejected',
      pm_reviewed_by: 'pm',
      pm_review_comment: 'needs fix',
      repair_ownership_extension: JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] }),
    });
    expect(JSON.parse(hash.verify)).toEqual([{ cmd: 'npm test', expect_exit: 0 }]);
    expect(await redis.zscore(keys.zset.status.blocked, 'sqlite-task')).not.toBeNull();
    expect((await getPlan(redis, 'sqlite-plan')).data.created_at).toBe(1);
    store.close();
  });

  it('旧 SQLite 的 epoch 毫秒、epoch 秒和 ISO 时间均能恢复排序，非法或缺失时间不产生 NaN 或丢任务', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-sqlite-time-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'sqlite-plan',
      title: 'sqlite-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 6,
      created_at: '2023-11-14T22:11:40.000Z',
      submitted_at: '2023-11-14T22:20:00.000Z',
    });
    // 为了验证全部 fallback 都非法时使用确定性 0，单独破坏该行的 plan 时间候选。
    store.upsertPlan({
      plan_id: 'invalid-time-plan',
      title: 'invalid-time-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 1,
      created_at: 'invalid',
      submitted_at: '',
    });

    const rows = [
      ['epoch-ms', '1700000000000', ''],
      ['epoch-seconds', '1700000100', ''],
      ['iso-time', '2023-11-14T22:16:40.000Z', ''],
      ['updated-fallback', 'not-a-time', '2023-11-14T22:18:20.000Z'],
      ['plan-submitted-fallback', '', ''],
      ['deterministic-zero-fallback', 'invalid', 'invalid'],
    ] as const;
    for (const [taskId, createdAt, updatedAt] of rows) {
      store.upsertTask({
        ...fullTaskRow(taskId),
        plan_id: taskId === 'deterministic-zero-fallback' ? 'invalid-time-plan' : 'sqlite-plan',
        status: 'pending',
        type: 'code',
        phase: 'impl',
        priority: 5,
        pm_review_status: '',
        created_at: createdAt,
        updated_at: updatedAt,
      } as never);
    }

    await expect(dbRestore(redis, store)).resolves.toMatchObject({ restored: 6, byStatus: { pending: 6 } });
    expect(await redis.zcard(keys.zset.status.pending)).toBe(6);
    expect(await redis.zscore(keys.zset.status.pending, 'epoch-ms')).toBe(String(pendingScore(5, 1_700_000_000_000)));
    expect(await redis.zscore(keys.zset.status.pending, 'epoch-seconds')).toBe(String(pendingScore(5, 1_700_000_100_000)));
    expect(await redis.zscore(keys.zset.status.pending, 'iso-time')).toBe(String(pendingScore(5, 1_700_000_200_000)));
    expect(await redis.zscore(keys.zset.status.pending, 'updated-fallback')).toBe(String(pendingScore(5, 1_700_000_300_000)));
    expect(await redis.zscore(keys.zset.status.pending, 'plan-submitted-fallback')).toBe(String(pendingScore(5, 1_700_000_400_000)));
    expect(await redis.zscore(keys.zset.status.pending, 'deterministic-zero-fallback')).toBe(String(pendingScore(5, 0)));

    const ordered = await redis.zrevrange(keys.zset.status.pending, 0, -1);
    expect(ordered).toEqual([
      'deterministic-zero-fallback',
      'epoch-ms',
      'epoch-seconds',
      'iso-time',
      'updated-fallback',
      'plan-submitted-fallback',
    ]);
    store.close();
  });

  it('恢复时统一把 plan/task/question/review 的 ISO 和 epoch 时间写为毫秒数字字符串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-sqlite-hash-time-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'sqlite-plan', title: 'sqlite-plan', status: 'submitted', project_path: PROJECT_PATH,
      default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 2,
      created_at: '2023-11-14T22:13:20.000Z', submitted_at: '1700000100', pm_consumer: 'pm-time',
    });
    store.upsertTask({
      ...fullTaskRow('timestamp-task'),
      status: 'failed',
      created_at: '2023-11-14T22:15:00.000Z',
      claimed_at: '1700000200',
      expire_at: '1700000300000',
      done_at: '2023-11-14T22:18:20.000Z',
      pm_reviewed_at: '1700000400',
      blocked_at: '2023-11-14T22:21:40.000Z',
      cancelled_at: '1700000600',
      superseded_at: '1700000700000',
      updated_at: '2023-11-14T22:26:40.000Z',
    } as never);
    store.upsertTask({
      ...fullTaskRow('review-pending'),
      type: 'code', status: 'done', pm_review_status: '',
      created_at: '2023-11-14T22:28:20.000Z',
      done_at: '2023-11-14T22:30:00.000Z',
      claimed_at: 'invalid', expire_at: 'invalid', pm_reviewed_at: 'invalid', blocked_at: 'invalid',
      cancelled_at: 'invalid', superseded_at: 'invalid', updated_at: 'invalid',
    } as never);
    store.upsertQuestion({
      question_id: 'question-time', task_id: 'review-pending', plan_id: 'sqlite-plan', agent_id: 'worker-time',
      pm_consumer: 'pm-time', asked_event_id: 'asked-time', body: '问题', checkpoint: '恢复点', status: 'answered',
      created_at: '2023-11-14T22:31:40.000Z', answered_at: '1700001200', answered_by: 'pm-time', answer: '答案',
    });

    await dbRestore(redis, store);
    expect(await redis.hgetall(keys.hash.plan('sqlite-plan'))).toMatchObject({ created_at: '1700000000000' });
    expect(await redis.hgetall(keys.hash.task('timestamp-task'))).toMatchObject({
      created_at: '1700000100000',
      claimed_at: '1700000200000',
      expire_at: '1700000300000',
      done_at: '1700000300000',
      pm_reviewed_at: '1700000400000',
      blocked_at: '1700000500000',
      cancelled_at: '1700000600000',
      superseded_at: '1700000700000',
    });
    expect(await redis.hgetall(keys.hash.task('review-pending'))).toMatchObject({
      created_at: '1700000900000', claimed_at: '', expire_at: '', done_at: '1700001000000',
      pm_reviewed_at: '', blocked_at: '', cancelled_at: '', superseded_at: '',
    });
    expect(await redis.zscore(keys.reviewRequested.pending, 'review-pending')).toBe('1700001000000');
    expect(await redis.hgetall(keys.hash.question('question-time'))).toMatchObject({
      created_at: '1700001100000', answered_at: '1700001200000',
    });

    expect((await getTask(redis, 'timestamp-task')).data).toMatchObject({
      created_at: 1_700_000_100_000,
      claimed_at: 1_700_000_200_000,
      expire_at: 1_700_000_300_000,
      done_at: 1_700_000_300_000,
      pm_reviewed_at: 1_700_000_400_000,
      blocked_at: 1_700_000_500_000,
      superseded_at: 1_700_000_700_000,
    });
    expect((await getPlan(redis, 'sqlite-plan')).data.created_at).toBe(1_700_000_000_000);
    expect((await getPlans(redis)).data?.plans.find((plan) => plan.plan_id === 'sqlite-plan')?.created_at).toBe(1_700_000_000_000);
    expect((await getQuestion(redis, 'question-time', { consumer: 'pm-time' })).data).toMatchObject({
      created_at: 1_700_001_100_000, answered_at: 1_700_001_200_000,
    });
    expect((await listQuestions(redis, { consumer: 'pm-time', status: 'all' })).data?.[0]).toMatchObject({
      created_at: 1_700_001_100_000, answered_at: 1_700_001_200_000,
    });
    store.close();
  });

  it('非空目标拒绝覆盖；目标清空后的重复灾后恢复只生成一份 done/accepted 投影', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-sqlite-status-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'sqlite-plan', title: 'sqlite-plan', status: 'submitted', project_path: PROJECT_PATH,
      default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
      created_at: '1', submitted_at: '2',
    });
    store.upsertTask({
      ...fullTaskRow('moved-to-done'),
      type: 'code', status: 'done', pm_review_status: 'accepted',
      created_at: '100', done_at: '200', updated_at: '300',
    } as never);

    // 模拟 Redis 还停在 running，SQLite 已双写成 done+accepted。
    await redis.zadd(keys.zset.status.running, 999, 'moved-to-done');
    await redis.hset(keys.hash.task('moved-to-done'), {
      task_id: 'moved-to-done', plan_id: 'sqlite-plan', status: 'running', expire_at: '999',
    });

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'RESTORE_ACTIVE_RUNTIME_STATE' });

    for (let run = 0; run < 2; run++) {
      await redis.flushdb();
      await dbRestore(redis, store);
      expect(await redis.zscore(keys.zset.status.running, 'moved-to-done')).toBeNull();
      expect(await redis.zscore(keys.zset.status.done, 'moved-to-done')).not.toBeNull();
      expect(await Promise.all(Object.entries(keys.zset.status)
        .filter(([status]) => status !== 'done')
        .map(([, zset]) => redis.zscore(zset, 'moved-to-done'))))
        .toEqual(Object.entries(keys.zset.status).filter(([status]) => status !== 'done').map(() => null));
      const plan = (await getPlan(redis, 'sqlite-plan')).data;
      expect(plan).toMatchObject({ status: 'completed', runtime_task_count: 1, reviews: { accepted: 1, pending: 0, rejected: 0 } });
      expect((await getPlans(redis)).data?.plans.find((item) => item.plan_id === 'sqlite-plan')).toMatchObject({
        status: 'completed', tasks: { done: 1, running: 0 }, reviews: { accepted: 1 },
      });
    }
    store.close();
  });

  it('未知 SQLite task status 在写入任何 Redis 状态前 fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-sqlite-invalid-status-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    store.upsertPlan({
      plan_id: 'invalid-status-plan', title: 'invalid-status-plan', status: 'submitted', project_path: PROJECT_PATH,
      default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
      created_at: '1', submitted_at: '2',
    });
    store.upsertTask({ ...fullTaskRow('invalid-status-task'), plan_id: 'invalid-status-plan', status: 'mystery' } as never);

    await expect(dbRestore(redis, store)).rejects.toMatchObject({ code: 'SQLITE_TASK_STATUS_INVALID' });
    expect(await redis.exists(keys.hash.plan('invalid-status-plan'))).toBe(0);
    expect(await redis.exists(keys.hash.task('invalid-status-task'))).toBe(0);
    expect(await Promise.all(Object.values(keys.zset.status).map((zset) => redis.zscore(zset, 'invalid-status-task'))))
      .toEqual(Object.values(keys.zset.status).map(() => null));
    store.close();
  });

  it('旧数据库启动时自动迁移新列', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-legacy-sqlite-'));
    temporaryPaths.push(dir);
    const dbPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE plans (plan_id TEXT PRIMARY KEY, title TEXT, status TEXT, project_path TEXT, task_count INTEGER, created_at TEXT, submitted_at TEXT);
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, title TEXT, type TEXT, phase TEXT, status TEXT,
        priority INTEGER, assignee TEXT, ownership_files TEXT, depends_on TEXT, timeout_seconds INTEGER,
        claimed_by TEXT, claimed_at TEXT, expire_at TEXT, result_path TEXT, result_json_path TEXT,
        done_at TEXT, retries INTEGER, pm_review_status TEXT, pm_reviewed_by TEXT, pm_reviewed_at TEXT,
        pm_review_comment TEXT, goal_md TEXT, created_at TEXT, updated_at TEXT
      );
    `);
    legacy.close();

    const store = new SqliteStore(dbPath);
    store.upsertPlan({
      plan_id: 'sqlite-plan',
      title: 'sqlite-plan',
      status: 'submitted',
      project_path: PROJECT_PATH,
      task_count: 1,
      created_at: '1',
      submitted_at: '2',
    });
    expect(() => store.upsertTask(fullTaskRow('legacy-task') as never)).not.toThrow();
    expect(store.getAllTasks()[0]).toMatchObject({
      ownership_modules: 'scheduler,review',
      max_retries: 7,
      repair_ownership_extension: JSON.stringify({ files: ['src/adjacent.ts'], modules: ['adjacent'] }),
    });
    store.close();
  });

  it('PM review 结果同步写入 SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-core-review-sqlite-'));
    temporaryPaths.push(dir);
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    setSqliteStore(store);
    const fixture = join(import.meta.dirname, 'fixtures', 'test-plan');
    await planSubmit(redis, fixture);
    const claimed = await claimAs('worker-a');
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'worker-a',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    await pmReview(redis, claimed.data!.task_id, { verdict: 'accept', reviewed_by: 'pm', comment: 'ok' });

    expect(store.getAllTasks().find((task) => task.task_id === claimed.data!.task_id)).toMatchObject({
      pm_review_status: 'accepted',
      pm_reviewed_by: 'pm',
      pm_review_comment: 'ok',
    });
    setSqliteStore(null);
    store.close();
  });
});
