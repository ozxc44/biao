/**
 * 无人盯盘闭环的目标约束（RED）。
 *
 * 这些用例只定义产品应有的生命周期，不改写 service 实现：
 * - 普通 code 失败必须产生可审计、可由 PM Agent 处理的修复决议；
 * - PM reject 的修复被验收后必须闭合原任务，不可让 plan 永久 failed；
 * - PM Question 回答后再次提问必须再次通知对应 PM；文件/依赖等待不制造 PM 噪声；
 * - 普通代码依赖默认等前置任务被 PM 接受，避免 delivery 状态越过验收门。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  getPlan,
  getPlans,
  getReviewInfo,
  getStatus,
  getTask,
  pmIntake,
  pmReview,
  report,
  createQuestion,
  answerQuestion,
  cancelTask,
  reconcileResolutionBacklog,
  reconcileRuntimeState,
  resolutionDecision,
  runWatchdog,
  unackedEvents,
} from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';
import { Supervisor, SupervisedProject } from '../src/worker/supervisor.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT_PATH = '/tmp/biao-autonomous-resolution-project';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  rmSync(PROJECT_PATH, { recursive: true, force: true });
  mkdirSync(PROJECT_PATH, { recursive: true });
});

beforeEach(async () => {
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  await redis.flushdb();
  await writePlanToRedis(redis, {
    plan_id: 'autonomous-plan',
    title: '无人盯盘闭环',
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-autonomous',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => {
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
  } as never, `# ${taskId}`, 'autonomous-plan', PROJECT_PATH, 5);
}

async function claimAs(agentId: string) {
  await agentRegister(redis, agentId, 'mock', ['code', 'acceptance']);
  return claim(redis, { agent_id: agentId, blocking: false, timeout_ms: 1 });
}

describe('无人盯盘的修复与阻塞闭环（目标 RED）', () => {
  it('continue 在 BEGIN 后、创建 child 前中断时，reconcile 从持久 intent 恢复且不重复 child', async () => {
    const taskId = 'continue-before-child-breakpoint';
    await seedTask(taskId, { max_retries: 1 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.failed, 53_000, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'failed',
      failed_at: '53000',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_generation: '1',
      resolution_attempts: '1',
      resolution_task_id: `${taskId}-repair-1`,
      resolution_task_ids: `${taskId}-repair-1`,
      resolution_decision_reason: 'repair_retry_limit_reached',
    });

    const original = redis.hgetall.bind(redis);
    let interrupted = false;
    redis.hgetall = (async (key: string) => {
      if (!interrupted && key === keys.hash.task(`${taskId}-repair-1`) &&
          await redis.hget(keys.hash.task(taskId), 'resolution_continue_owner')) {
        interrupted = true;
        throw new Error('simulated interruption before continuation child');
      }
      return original(key);
    }) as typeof redis.hgetall;
    try {
      await expect(resolutionDecision(redis, taskId, {
        action: 'continue', decided_by: 'pm-before-child',
      })).rejects.toThrow('simulated interruption before continuation child');
    } finally {
      redis.hgetall = original as typeof redis.hgetall;
    }

    expect(interrupted).toBe(true);
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-2`))).toBe(0);
    expect(await redis.hget(keys.hash.task(taskId), 'resolution_continue_owner')).toBeTruthy();

    expect((await reconcileRuntimeState(redis)).ok).toBe(true);
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);
    expect(await redis.hgetall(keys.hash.task(taskId))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: `${taskId}-repair-2`,
      resolution_attempts: '2',
      resolution_decided_by: 'pm-before-child',
    });
    expect(await redis.hget(keys.hash.task(taskId), 'resolution_continue_owner')).toBeNull();
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-2`))).toBe(1);
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-3`))).toBe(0);
  });

  it('continue 已创建新 generation 却在审计提交前失锁时，runtime reconcile 幂等收口', async () => {
    const taskId = 'continue-audit-breakpoint';
    await seedTask(taskId, { max_retries: 1 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.failed, 54_000, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'failed',
      failed_at: '54000',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_generation: '1',
      resolution_attempts: '1',
      resolution_task_id: `${taskId}-repair-1`,
      resolution_task_ids: `${taskId}-repair-1`,
      resolution_decision_reason: 'repair_retry_limit_reached',
    });

    const contender = redis.duplicate();
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let lostAtAudit = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!lostAtAudit && command?.name?.toLowerCase() === 'eval' &&
          script.includes('commit-resolution-continue-round-fenced-v1')) {
        lostAtAudit = true;
        return contender.del(keys.string.pmReviewLock(taskId))
          .then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      expect(await resolutionDecision(redis, taskId, {
        action: 'continue', decided_by: 'pm-breakpoint',
      })).toMatchObject({
        ok: false, error: { code: 'RESOLUTION_DECISION_ROUND_CHANGED' },
      });
    } finally {
      client.sendCommand = original;
    }

    expect(lostAtAudit).toBe(true);
    expect(await redis.hgetall(keys.hash.task(taskId))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: `${taskId}-repair-2`,
      resolution_attempts: '2',
      resolution_continue_owner: expect.any(String),
    });
    expect(await redis.zscore(keys.runtimeReconcile.pending, taskId)).not.toBeNull();

    expect((await reconcileRuntimeState(redis)).ok).toBe(true);
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);

    const recovered = await redis.hgetall(keys.hash.task(taskId));
    expect(recovered).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: `${taskId}-repair-2`,
      resolution_attempts: '2',
      resolution_decided_by: 'pm-breakpoint',
    });
    expect(recovered.resolution_continue_owner).toBeUndefined();
    expect(await redis.zscore(keys.runtimeReconcile.pending, taskId)).toBeNull();
    expect(await redis.smembers(keys.planStatusProjection.taskIdsByPlan('autonomous-plan')))
      .toEqual(expect.arrayContaining([taskId, `${taskId}-repair-2`]));
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-3`))).toBe(0);

    const events = await redis.xrange(keys.stream.events, '-', '+') as [string, string[]][];
    const recoveredAudits = events.filter(([, fields]) => {
      const event = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
      );
      return event.type === 'resolution_decided' && event.task_id === taskId && event.resolution_action === 'continue';
    });
    expect(recoveredAudits).toHaveLength(1);
    contender.disconnect();
  });

  it('legacy 空 generation/attempts 的首次 continue 只创建一个 child 与一条审计', async () => {
    const taskId = 'legacy-empty-resolution-counters';
    await seedTask(taskId, { max_retries: 0 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.failed, 54_100, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'failed',
      failed_at: '54100',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_generation: '',
      resolution_attempts: '',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolution_decision_reason: 'repair_retry_limit_reached',
    });

    expect(await resolutionDecision(redis, taskId, {
      action: 'continue', decided_by: 'pm-legacy-empty',
    })).toMatchObject({ ok: true });
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);

    const root = await redis.hgetall(keys.hash.task(taskId));
    expect(root).toMatchObject({
      resolution_task_id: `${taskId}-repair-1`,
      resolution_attempts: '1',
      resolution_decided_by: 'pm-legacy-empty',
    });
    expect(root.resolution_continue_owner).toBeUndefined();
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-1`))).toBe(1);
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-2`))).toBe(0);

    const events = await redis.xrange(keys.stream.events, '-', '+') as [string, string[]][];
    const audits = events.filter(([, fields]) => {
      const event = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
      );
      return event.type === 'resolution_decided' && event.task_id === taskId && event.resolution_action === 'continue';
    });
    expect(audits).toHaveLength(1);
  });

  it('legacy 缺失 generation/attempts 在审计断点后由两次 reconcile 幂等收口', async () => {
    const taskId = 'legacy-missing-resolution-counters';
    await seedTask(taskId, { max_retries: 0 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.failed, 54_200, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'failed',
      failed_at: '54200',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: 'repair_retry_limit_reached',
    });
    await redis.hdel(
      keys.hash.task(taskId),
      'resolution_generation',
      'resolution_attempts',
      'resolution_task_id',
      'resolution_task_ids',
    );

    const contender = redis.duplicate();
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let lostAtAudit = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!lostAtAudit && command?.name?.toLowerCase() === 'eval' &&
          script.includes('commit-resolution-continue-round-fenced-v1')) {
        lostAtAudit = true;
        return contender.del(keys.string.pmReviewLock(taskId))
          .then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      expect(await resolutionDecision(redis, taskId, {
        action: 'continue', decided_by: 'pm-legacy-reconcile',
      })).toMatchObject({ ok: false, error: { code: 'RESOLUTION_DECISION_ROUND_CHANGED' } });
    } finally {
      client.sendCommand = original;
    }

    expect(lostAtAudit).toBe(true);
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);
    expect((await reconcileRuntimeState(redis)).ok).toBe(true);

    const root = await redis.hgetall(keys.hash.task(taskId));
    expect(root).toMatchObject({
      resolution_task_id: `${taskId}-repair-1`,
      resolution_attempts: '1',
      resolution_decided_by: 'pm-legacy-reconcile',
    });
    expect(root.resolution_continue_owner).toBeUndefined();
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-1`))).toBe(1);
    expect(await redis.exists(keys.hash.task(`${taskId}-repair-2`))).toBe(0);

    const events = await redis.xrange(keys.stream.events, '-', '+') as [string, string[]][];
    const audits = events.filter(([, fields]) => {
      const event = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
      );
      return event.type === 'resolution_decided' && event.task_id === taskId && event.resolution_action === 'continue';
    });
    expect(audits).toHaveLength(1);
    contender.disconnect();
  });

  it('决策锁过期后旧 continue 不能跨轮次覆盖后来已提交的 cancel', async () => {
    const taskId = 'expired-resolution-decision';
    await seedTask(taskId, { max_retries: 1 });
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.done, 55_000, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'done',
      done_at: '55000',
      pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_generation: '1',
      resolution_attempts: '1',
      resolution_task_id: `${taskId}-repair-1`,
      resolution_task_ids: `${taskId}-repair-1`,
      resolution_decision_reason: 'repair_retry_limit_reached',
    });

    const contender = redis.duplicate();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = redis as Redis & { sendCommand: (...args: any[]) => Promise<unknown> };
    const original = client.sendCommand;
    let held = false;
    client.sendCommand = function intercept(command: any, ...args: unknown[]) {
      const script = String(command?.args?.[0] ?? '');
      if (!held && command?.name?.toLowerCase() === 'eval' && script.includes('begin-resolution-continue-round-fenced-v1')) {
        held = true;
        entered();
        return releasePromise.then(() => original.call(this, command, ...args));
      }
      return original.call(this, command, ...args);
    };
    try {
      const staleContinue = resolutionDecision(redis, taskId, { action: 'continue', decided_by: 'pm-old' });
      await enteredPromise;
      await contender.pexpire(keys.string.pmReviewLock(taskId), 5);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(await resolutionDecision(contender, taskId, { action: 'cancel', decided_by: 'pm-new' })).toMatchObject({
        ok: true, data: { state: 'cancelled', action: 'cancel' },
      });
      release();
      expect(await staleContinue).toMatchObject({
        ok: false, error: { code: 'RESOLUTION_DECISION_ROUND_CHANGED' },
      });
      expect(await contender.hgetall(keys.hash.task(taskId))).toMatchObject({
        resolution_status: 'cancelled',
        resolution_action: 'cancel',
        resolution_decided_by: 'pm-new',
      });
      expect(await contender.exists(keys.hash.task(`${taskId}-repair-2`))).toBe(0);
    } finally {
      client.sendCommand = original;
      release?.();
      contender.disconnect();
    }
  });

  it('普通 code report failed 后生成持久化 repair 并交给 Worker，不打扰 PM 或自动 reset', async () => {
    await seedTask('failed-code', { verify: [{ cmd: 'npm test', expect_exit: 0 }] });
    const claimed = await claimAs('failed-worker');

    const failed = await report(redis, {
      task_id: 'failed-code',
      agent_id: 'failed-worker',
      claim_token: claimed.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'npm test', exit_code: 1, passed: false }],
    });

    expect(failed.ok).toBe(true);
    // 目标 API：失败不是只有一个 failed 桶，而是带下一步的持久化决议。
    expect(failed.data).toMatchObject({
      status: 'failed',
      resolution: {
        state: 'repairing',
        action: 'repair',
        source_task_id: 'failed-code',
      },
    });

    const intake = await pmIntake(redis, { consumer: 'pm-autonomous' });
    expect(intake.data?.items.some((item) => item.kind === 'resolution_required')).toBe(false);
    expect((await unackedEvents(redis, { consumer: 'pm-autonomous' })).data?.some(
      (event) => event.type === 'resolution_required',
    )).toBe(false);
    const rawEvents = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(rawEvents.some(([, fields]) => fields.includes('repair_scheduled'))).toBe(true);

    const repair = await claimAs('failed-repair-worker');
    expect(repair.data?.task_id).toBe('failed-code-repair-1');

    expect(await redis.hget(keys.hash.task('failed-code'), 'status')).toBe('failed');
  });

  it.each(['failed', 'partial'] as const)(
    '实时 acceptance report %s 遇到空 acceptance_for 时 fail-closed，只提醒一次 PM 且不生成 repair',
    async (status) => {
      const taskId = `live-empty-acceptance-${status}`;
      await seedTask(taskId, {
        type: 'acceptance',
        acceptance_for: [],
        depends_on: [],
      });
      const claimed = await claimAs(`empty-acceptance-${status}-worker`);

      const outcome = await report(redis, {
        task_id: taskId,
        agent_id: `empty-acceptance-${status}-worker`,
        claim_token: claimed.data!.claim_token,
        status,
      });

      expect(outcome).toMatchObject({
        ok: true,
        data: {
          task_id: taskId,
          status,
          resolution: {
            state: 'needs_pm_decision',
            action: 'inspect',
            source_task_id: taskId,
          },
        },
      });
      expect(await redis.hgetall(keys.hash.task(taskId))).toMatchObject({
        status: 'failed',
        resolution_status: 'needs_pm_decision',
        resolution_action: 'inspect',
        resolution_task_id: '',
        resolution_decision_reason: `acceptance_source_missing:${taskId}`,
      });
      expect(await redis.exists(keys.hash.task(`${taskId}-repair-1`))).toBe(0);

      const resolutionEvents = async () => {
        const events = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
        return events.filter(([, fields]) => fields.includes('resolution_required') && fields.includes(taskId));
      };
      expect(await resolutionEvents()).toHaveLength(1);
      expect((await pmIntake(redis, { consumer: 'pm-autonomous' })).data?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'resolution_required', task_id: taskId }),
        ]),
      );

      expect(await reconcileResolutionBacklog(redis)).toEqual({
        repaired_task_ids: [],
        needs_pm_decision_task_ids: [],
      });
      expect(await resolutionEvents()).toHaveLength(1);
    },
  );

  it('空闲的过期 agent 只在状态页保留审计，不会成为 PM intake 噪声', async () => {
    await agentRegister(redis, 'idle-stale-worker', 'mock', ['code']);
    await redis.hset(keys.hash.agent('idle-stale-worker'), {
      last_heartbeat: String(Date.now() - 10 * 60_000),
      current_task: '',
    });

    const intake = await pmIntake(redis, { consumer: 'pm-autonomous' });
    expect(intake.data?.items.some((item) => item.kind === 'stale_agent')).toBe(false);
  });

  it('acceptance report failed 生成的 repair 不会被失败的 acceptance 依赖永久阻断', async () => {
    await seedTask('acceptance-source');
    const source = await claimAs('acceptance-source-worker');
    await report(redis, {
      task_id: 'acceptance-source',
      agent_id: 'acceptance-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    await seedTask('acceptance-check', {
      type: 'acceptance',
      depends_on: ['acceptance-source'],
      acceptance_for: ['acceptance-source'],
    });
    const acceptance = await claimAs('acceptance-reviewer');
    const failed = await report(redis, {
      task_id: 'acceptance-check',
      agent_id: 'acceptance-reviewer',
      claim_token: acceptance.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'acceptance check', exit_code: 1, passed: false }],
    });

    const generated = failed.data?.fix_tasks_generated?.[0];
    expect(generated).toBeTruthy();
    const repair = await claimAs('acceptance-repair-worker');
    expect(repair.data?.task_id).toBe(generated);
  });

  it('独立验收失败后，来源 repair accepted 只安排新的独立复验；复验 accepted 才关闭失败验收', async () => {
    await seedTask('acceptance-resolution-source');
    const source = await claimAs('acceptance-resolution-source-worker');
    await report(redis, {
      task_id: 'acceptance-resolution-source',
      agent_id: 'acceptance-resolution-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    await seedTask('acceptance-resolution-check', {
      type: 'acceptance',
      depends_on: ['acceptance-resolution-source'],
      acceptance_for: ['acceptance-resolution-source'],
    });
    const acceptance = await claimAs('acceptance-resolution-reviewer');
    const failed = await report(redis, {
      task_id: 'acceptance-resolution-check',
      agent_id: 'acceptance-resolution-reviewer',
      claim_token: acceptance.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'acceptance check', exit_code: 1, passed: false }],
    });
    const repairId = failed.data!.fix_tasks_generated![0]!;

    const oldSourceAccept = await pmReview(redis, 'acceptance-resolution-source', {
      verdict: 'accept',
      reviewed_by: 'pm-autonomous',
    });
    expect(oldSourceAccept).toMatchObject({ ok: false, error: { code: 'RESOLUTION_ACTIVE' } });

    const repair = await claimAs('acceptance-resolution-repair-worker');
    expect(repair.data?.task_id).toBe(repairId);
    await report(redis, {
      task_id: repairId,
      agent_id: 'acceptance-resolution-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, repairId, { verdict: 'accept', reviewed_by: 'pm-autonomous' });

    expect(await redis.hget(keys.hash.task('acceptance-resolution-source'), 'resolution_status')).toBe('resolved');
    expect(await redis.hget(keys.hash.task('acceptance-resolution-check'), 'resolution_status')).toBe('required');
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'active' });

    const reverify = await claimAs('acceptance-resolution-reverify-reviewer');
    expect(reverify.data?.task_id).toBe('acceptance-resolution-check-reverify-1');
    const resultPath = writeResult(
      'acceptance-resolution-check-reverify-1',
      '# 独立复验\n\n- 结论：✅ PASS\n',
    );
    await report(redis, {
      task_id: reverify.data!.task_id,
      agent_id: 'acceptance-resolution-reverify-reviewer',
      claim_token: reverify.data!.claim_token,
      status: 'done',
      result_path: resultPath,
      verify_results: [{ cmd: 'acceptance reverify', exit_code: 0, passed: true }],
    });
    await pmReview(redis, reverify.data!.task_id, { verdict: 'accept', reviewed_by: 'pm-autonomous' });

    expect(await redis.hget(keys.hash.task('acceptance-resolution-check'), 'resolution_status')).toBe('resolved');
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'completed' });
  });

  it('PM 接受 repair 后闭合原 reject，计划可再次达到 completed', async () => {
    await seedTask('rejected-source');
    const source = await claimAs('source-worker');
    await report(redis, {
      task_id: 'rejected-source',
      agent_id: 'source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    const rejected = await pmReview(redis, 'rejected-source', {
      verdict: 'reject',
      reviewed_by: 'pm-autonomous',
      reject_reason: '需要补齐结果证据',
      fix_instructions: '补齐证据并验证',
    });
    const fixId = rejected.data!.fix_task_id!;

    const repair = await claimAs('repair-worker');
    expect(repair.data?.task_id).toBe(fixId);
    await report(redis, {
      task_id: fixId,
      agent_id: 'repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, fixId, { verdict: 'accept', reviewed_by: 'pm-autonomous' });

    // 原拒绝必须保留审计历史；单独 resolution 字段表明它已由 repair 关闭。
    expect(await redis.hget(keys.hash.task('rejected-source'), 'pm_review_status')).toBe('rejected');
    expect(await redis.hget(keys.hash.task('rejected-source'), 'resolution_status')).toBe('resolved');
    expect(await redis.hget(keys.hash.task('rejected-source'), 'resolved_by_task')).toBe(fixId);
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'completed' });
  });

  it('repair 自身失败或被 PM 拒绝时会进入下一代 repair，而不会卡在旧 done/failed repair', async () => {
    await seedTask('repair-retry-source', { max_retries: 3 });
    const source = await claimAs('repair-retry-source-worker');
    await report(redis, {
      task_id: 'repair-retry-source',
      agent_id: 'repair-retry-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    const rejected = await pmReview(redis, 'repair-retry-source', {
      verdict: 'reject',
      reviewed_by: 'pm-autonomous',
      reject_reason: '首轮证据不足',
    });
    const firstRepairId = rejected.data!.fix_task_id!;
    const firstRepair = await claimAs('repair-retry-worker-1');
    await report(redis, {
      task_id: firstRepairId,
      agent_id: 'repair-retry-worker-1',
      claim_token: firstRepair.data!.claim_token,
      status: 'failed',
    });

    const secondRepairId = 'repair-retry-source-repair-2';
    expect(await redis.hget(keys.hash.task('repair-retry-source'), 'resolution_task_id')).toBe(secondRepairId);
    expect(await redis.hget(keys.hash.task(firstRepairId), 'status')).toBe('failed');
    const secondRepair = await claimAs('repair-retry-worker-2');
    expect(secondRepair.data?.task_id).toBe(secondRepairId);
  });

  it('repair 耗尽重试后只向根任务告警，保留末次失败子任务和 CLI 决策数据', async () => {
    await seedTask('retry-limit-source', { max_retries: 1 });
    const source = await claimAs('retry-limit-source-worker');
    await report(redis, {
      task_id: 'retry-limit-source',
      agent_id: 'retry-limit-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    const rejected = await pmReview(redis, 'retry-limit-source', {
      verdict: 'reject',
      reviewed_by: 'pm-autonomous',
      reject_reason: '首次修复仍需验证',
    });
    expect(rejected.data?.fix_task_id).toBe('retry-limit-source-repair-1');

    const repair = await claimAs('retry-limit-repair-worker');
    expect(repair.data?.task_id).toBe('retry-limit-source-repair-1');
    await report(redis, {
      task_id: 'retry-limit-source-repair-1',
      agent_id: 'retry-limit-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'retry verify', exit_code: 1, passed: false }],
    });

    const root = await redis.hgetall(keys.hash.task('retry-limit-source'));
    expect(root).toMatchObject({
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: 'retry-limit-source-repair-1',
      resolution_task_ids: 'retry-limit-source-repair-1',
      resolution_attempts: '1',
      resolution_decision_reason: 'repair_retry_limit_reached',
    });

    const failedChild = await redis.hgetall(keys.hash.task('retry-limit-source-repair-1'));
    expect(failedChild).toMatchObject({
      status: 'failed',
      fix_for: 'retry-limit-source',
      repair_root_task_id: 'retry-limit-source',
    });

    const intake = await pmIntake(redis, { consumer: 'pm-autonomous', plan_id: 'autonomous-plan' });
    expect(intake.data?.items.filter((item) =>
      ['retry-limit-source', 'retry-limit-source-repair-1'].includes(item.task_id ?? ''),
    )).toEqual([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'retry-limit-source' }),
    ]);

    const watchdog = await runWatchdog(redis);
    expect(watchdog.data?.problems.filter((problem) =>
      ['retry-limit-source', 'retry-limit-source-repair-1'].includes(problem.task_id ?? ''),
    )).toEqual([
      expect.objectContaining({ type: 'failed', task_id: 'retry-limit-source' }),
    ]);

    const review = await getReviewInfo(redis, 'retry-limit-source');
    expect(review.data).toMatchObject({
      latest_repair_id: 'retry-limit-source-repair-1',
      resolution_lineage: ['retry-limit-source-repair-1'],
      resolution_decision: {
        state: 'needs_pm_decision',
        reason: 'repair_retry_limit_reached',
        attempts: 1,
        max_retries: 1,
        available_actions: ['inspect', 'continue', 'cancel'],
      },
    });

    await reconcileResolutionBacklog(redis);
    expect(await redis.hgetall(keys.hash.task('retry-limit-source-repair-1'))).toEqual(failedChild);
    const repeatedIntake = await pmIntake(redis, { consumer: 'pm-autonomous', plan_id: 'autonomous-plan' });
    expect(repeatedIntake.data?.items.filter((item) =>
      ['retry-limit-source', 'retry-limit-source-repair-1'].includes(item.task_id ?? ''),
    )).toHaveLength(1);

    const inspected = await resolutionDecision(redis, 'retry-limit-source', {
      action: 'inspect',
      decided_by: 'pm-autonomous',
    });
    expect(inspected.data).toMatchObject({
      root_task_id: 'retry-limit-source',
      state: 'needs_pm_decision',
      latest_repair_id: 'retry-limit-source-repair-1',
      available_actions: ['inspect', 'continue', 'cancel'],
    });

    const continued = await resolutionDecision(redis, 'retry-limit-source', {
      action: 'continue',
      decided_by: 'pm-autonomous',
    });
    expect(continued.data).toMatchObject({
      root_task_id: 'retry-limit-source',
      state: 'repairing',
      action: 'repair',
      latest_repair_id: 'retry-limit-source-repair-2',
      created_task_ids: ['retry-limit-source-repair-2'],
    });
    expect(await redis.hgetall(keys.hash.task('retry-limit-source'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'retry-limit-source-repair-2',
      resolution_task_ids: 'retry-limit-source-repair-1,retry-limit-source-repair-2',
      resolution_attempts: '2',
      resolution_decision_reason: '',
    });
    expect(await redis.zscore(keys.runtimeReconcile.pending, 'retry-limit-source')).not.toBeNull();
    expect(await redis.hgetall(keys.hash.task('retry-limit-source-repair-1'))).toEqual(failedChild);

    // continue 只明确放行一代；这一代再失败后重新等待 PM，不无限续跑。
    const repair2 = await claimAs('retry-limit-repair-worker-2');
    expect(repair2.data?.task_id).toBe('retry-limit-source-repair-2');
    await report(redis, {
      task_id: repair2.data!.task_id,
      agent_id: 'retry-limit-repair-worker-2',
      claim_token: repair2.data!.claim_token,
      status: 'failed',
    });
    const failedChild2 = await redis.hgetall(keys.hash.task('retry-limit-source-repair-2'));
    expect(await redis.hget(keys.hash.task('retry-limit-source'), 'resolution_status')).toBe('needs_pm_decision');
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'failed' });

    const waitingProject = new SupervisedProject({
      planId: 'autonomous-plan',
      isClosed: async () => ['completed', 'cancelled'].includes(
        ((await getPlan(redis, 'autonomous-plan')).data as { status: string }).status,
      ),
      pendingItems: async () => [],
    });
    expect(await new Supervisor({ biaoUrl: 'memory://test', projects: [waitingProject], once: true }).runOnce()).toBe(true);
    expect(waitingProject.paused).toBe(false);

    const cancelled = await resolutionDecision(redis, 'retry-limit-source', {
      action: 'cancel',
      decided_by: 'pm-autonomous',
    });
    expect(cancelled.data).toMatchObject({
      root_task_id: 'retry-limit-source',
      state: 'cancelled',
      action: 'cancel',
      latest_repair_id: 'retry-limit-source-repair-2',
      available_actions: ['inspect'],
    });
    expect(await redis.hgetall(keys.hash.task('retry-limit-source-repair-2'))).toEqual(failedChild2);
    expect((await getTask(redis, 'retry-limit-source')).data).toMatchObject({
      resolution_status: 'cancelled',
      resolution_action: 'cancel',
      resolution_decision_reason: 'cancelled:repair_retry_limit_reached',
    });
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'cancelled' });
    expect((await getPlans(redis)).data?.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan_id: 'autonomous-plan', status: 'cancelled' }),
    ]));
    expect((await getStatus(redis)).data.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan_id: 'autonomous-plan', status: 'cancelled' }),
    ]));

    const closedProject = new SupervisedProject({
      planId: 'autonomous-plan',
      isClosed: async () => ['completed', 'cancelled'].includes(
        ((await getPlan(redis, 'autonomous-plan')).data as { status: string }).status,
      ),
      pendingItems: async () => [],
    });
    expect(await new Supervisor({ biaoUrl: 'memory://test', projects: [closedProject], once: true }).runOnce()).toBe(false);
    expect(closedProject.paused).toBe(true);
    expect((await pmIntake(redis, { consumer: 'pm-autonomous', plan_id: 'autonomous-plan' })).data?.items.filter(
      (item) => item.task_id?.startsWith('retry-limit-source'),
    )).toEqual([]);
    expect((await runWatchdog(redis)).data?.problems.filter(
      (problem) => problem.task_id?.startsWith('retry-limit-source'),
    )).toEqual([]);
  });

  it('取消当前 repair 会升级成最小 PM 决策，而不是让原失败任务静默悬挂', async () => {
    await seedTask('repair-cancel-source');
    const source = await claimAs('repair-cancel-source-worker');
    await report(redis, {
      task_id: 'repair-cancel-source',
      agent_id: 'repair-cancel-source-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    const rejected = await pmReview(redis, 'repair-cancel-source', {
      verdict: 'reject',
      reviewed_by: 'pm-autonomous',
      reject_reason: '需要调整范围',
    });
    const repairId = rejected.data!.fix_task_id!;

    expect((await cancelTask(redis, repairId)).ok).toBe(true);
    expect(await redis.hmget(
      keys.hash.task('repair-cancel-source'),
      'resolution_status',
      'resolution_decision_reason',
      'resolution_task_id',
      'resolution_task_ids',
    )).toEqual([
      'needs_pm_decision',
      `repair_cancelled:${repairId}`,
      repairId,
      repairId,
    ]);
    expect((await pmIntake(redis, { consumer: 'pm-autonomous' })).data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'repair-cancel-source' }),
    ]));
  });

  it('升级补偿会为历史 failed/rejected 任务创建一次 repair，重复运行不产生并行修复', async () => {
    await seedTask('legacy-failed-source');
    await redis.zrem(keys.zset.status.pending, 'legacy-failed-source');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'legacy-failed-source');
    await redis.hset(keys.hash.task('legacy-failed-source'), {
      status: 'failed',
      failed_reason: '旧版本只记录 failed 状态。',
    });

    const first = await reconcileResolutionBacklog(redis);
    expect(first.repaired_task_ids).toEqual(['legacy-failed-source']);
    expect(await redis.hget(keys.hash.task('legacy-failed-source'), 'resolution_task_id')).toBe('legacy-failed-source-repair-1');
    const second = await reconcileResolutionBacklog(redis);
    expect(second).toEqual({ repaired_task_ids: [], needs_pm_decision_task_ids: [] });
    expect(await redis.zrange(keys.zset.status.pending, 0, -1)).toEqual(['legacy-failed-source-repair-1']);
  });

  it('repair 确定性 ID 被其他计划占用时不覆盖任务，并 fail-closed 提醒来源 PM', async () => {
    await seedTask('collision-source');
    const claimed = await claimAs('collision-source-worker');

    await writePlanToRedis(redis, {
      plan_id: 'foreign-plan',
      title: 'foreign-plan',
      project_path: '/tmp/biao-foreign-project',
      pm_consumer: 'pm-foreign',
      default_assignee: 'auto',
      default_priority: 5,
    }, 0);
    await writeTaskToRedis(redis, {
      task_id: 'collision-source-repair-1',
      title: '用户创建的同名普通任务',
      type: 'docs',
      phase: 'docs',
      assignee: 'auto',
      priority: 9,
      timeout_seconds: 60,
      verify: [],
    } as never, '# foreign task', 'foreign-plan', '/tmp/biao-foreign-project', 5);
    const collisionBefore = await redis.hgetall(keys.hash.task('collision-source-repair-1'));

    const failed = await report(redis, {
      task_id: 'collision-source',
      agent_id: 'collision-source-worker',
      claim_token: claimed.data!.claim_token,
      status: 'failed',
    });
    expect(failed).toMatchObject({
      ok: true,
      data: {
        resolution: {
          state: 'needs_pm_decision',
          action: 'inspect',
          source_task_id: 'collision-source',
        },
      },
    });
    expect(await redis.hgetall(keys.hash.task('collision-source-repair-1'))).toEqual(collisionBefore);
    expect(await redis.hgetall(keys.hash.task('collision-source'))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: '',
      resolution_decision_reason: 'repair_task_id_collision:collision-source-repair-1',
    });
    const intake = await pmIntake(redis, { consumer: 'pm-autonomous' });
    expect(intake.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'collision-source' }),
    ]));
    expect((await pmIntake(redis, { consumer: 'pm-foreign' })).data?.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resolution_required', task_id: 'collision-source' }),
    ]));

    const eventsBefore = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(await reconcileResolutionBacklog(redis)).toEqual({
      repaired_task_ids: [],
      needs_pm_decision_task_ids: [],
    });
    const eventsAfter = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('repair 确定性 ID 即使 lineage 相同，终态任务也不可复用并应 fail-closed', async () => {
    const sourceId = 'terminal-collision-source';
    const collisionId = `${sourceId}-repair-1`;
    await seedTask(sourceId);
    const claimed = await claimAs('terminal-collision-worker');

    await seedTask(collisionId);
    await redis.zrem(keys.zset.status.pending, collisionId);
    await redis.zadd(keys.zset.status.cancelled, Date.now(), collisionId);
    await redis.hset(keys.hash.task(collisionId), {
      status: 'cancelled',
      fix_for: sourceId,
      repair_root_task_id: sourceId,
    });
    const collisionBefore = await redis.hgetall(keys.hash.task(collisionId));

    const failed = await report(redis, {
      task_id: sourceId,
      agent_id: 'terminal-collision-worker',
      claim_token: claimed.data!.claim_token,
      status: 'failed',
    });

    expect(failed).toMatchObject({
      ok: true,
      data: {
        resolution: {
          state: 'needs_pm_decision',
          action: 'inspect',
          source_task_id: sourceId,
        },
      },
    });
    expect(await redis.hgetall(keys.hash.task(collisionId))).toEqual(collisionBefore);
    expect(await redis.hgetall(keys.hash.task(sourceId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: '',
      resolution_decision_reason: `repair_task_id_collision:${collisionId}`,
    });
  });

  it('空 acceptance_for 的历史验收会 fail-closed，并把旧 repairing 脏态幂等收敛为一次 PM 决策', async () => {
    const taskIds = ['legacy-empty-acceptance', 'legacy-dirty-empty-acceptance'];
    for (const taskId of taskIds) {
      await seedTask(taskId, {
        type: 'acceptance',
        acceptance_for: [],
        depends_on: [],
      });
      await redis.zrem(keys.zset.status.pending, taskId);
      await redis.zadd(keys.zset.status.failed, Date.now(), taskId);
      await redis.hset(keys.hash.task(taskId), {
        status: 'failed',
        failed_reason: '历史验收没有来源任务。',
      });
    }
    await redis.hset(keys.hash.task('legacy-dirty-empty-acceptance'), {
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_task_id: '',
    });

    const first = await reconcileResolutionBacklog(redis);
    expect(first.repaired_task_ids).toEqual([]);
    expect(first.needs_pm_decision_task_ids).toHaveLength(taskIds.length);
    expect(first.needs_pm_decision_task_ids).toEqual(expect.arrayContaining(taskIds));

    for (const taskId of taskIds) {
      expect(await redis.hgetall(keys.hash.task(taskId))).toMatchObject({
        status: 'failed',
        resolution_status: 'needs_pm_decision',
        resolution_action: 'inspect',
        resolution_task_id: '',
      });
      expect(await redis.exists(keys.hash.task(`${taskId}-repair-1`))).toBe(0);
      expect(await redis.exists(keys.hash.task(`${taskId}-reverify-1`))).toBe(0);
    }

    const firstEvents = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    const decisionEvents = firstEvents.filter(([, fields]) => {
      const event = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
      );
      return event.type === 'resolution_required' && taskIds.includes(event.task_id);
    });
    expect(decisionEvents).toHaveLength(taskIds.length);

    const intake = await pmIntake(redis, { consumer: 'pm-autonomous' });
    expect(intake.data?.items).toEqual(expect.arrayContaining(
      taskIds.map((taskId) => expect.objectContaining({ kind: 'resolution_required', task_id: taskId })),
    ));

    expect(await reconcileResolutionBacklog(redis)).toEqual({
      repaired_task_ids: [],
      needs_pm_decision_task_ids: [],
    });
    const secondEvents = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
    expect(secondEvents.filter(([, fields]) => fields.includes('resolution_required'))).toHaveLength(taskIds.length);
  });

  it('升级时会把旧式 -fix-1 接回 reject 根任务，再从失败 fix 续跑而不创建并行 repair', async () => {
    await seedTask('legacy-named-source', { max_retries: 3 });
    await seedTask('legacy-named-source-fix-1', { max_retries: 3 });
    await redis.zrem(keys.zset.status.pending, 'legacy-named-source', 'legacy-named-source-fix-1');
    await redis.zadd(keys.zset.status.done, Date.now(), 'legacy-named-source');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'legacy-named-source-fix-1');
    await redis.hset(keys.hash.task('legacy-named-source'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_reject_reason: '旧 PM 要求补证据。',
    });
    await redis.hset(keys.hash.task('legacy-named-source-fix-1'), {
      status: 'failed',
      failed_reason: '旧修复仍失败。',
    });

    const reconciled = await reconcileResolutionBacklog(redis);
    expect(reconciled.repaired_task_ids).toEqual(['legacy-named-source']);
    expect(await redis.hget(keys.hash.task('legacy-named-source-fix-1'), 'fix_for')).toBe('legacy-named-source');
    expect(await redis.hget(keys.hash.task('legacy-named-source'), 'resolution_task_id')).toBe('legacy-named-source-repair-2');
    expect(await redis.hget(keys.hash.task('legacy-named-source-repair-2'), 'fix_for')).toBe('legacy-named-source-fix-1');

    const repair = await claimAs('legacy-named-repair-worker');
    expect(repair.data?.task_id).toBe('legacy-named-source-repair-2');
    await report(redis, {
      task_id: repair.data!.task_id,
      agent_id: 'legacy-named-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    expect((await pmReview(redis, repair.data!.task_id, { verdict: 'accept', reviewed_by: 'pm-autonomous' })).ok).toBe(true);
    expect(await redis.hget(keys.hash.task('legacy-named-source-fix-1'), 'resolution_status')).toBe('resolved');
    expect(await redis.hget(keys.hash.task('legacy-named-source'), 'resolution_status')).toBe('resolved');
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'completed' });
  });

  it('半迁移的旧 fix 会接管尚未领取的自动 repair，避免升级后同时出现两条修复线', async () => {
    await seedTask('legacy-partial-source', { max_retries: 3 });
    await seedTask('legacy-partial-source-fix-1', { max_retries: 3 });
    await seedTask('legacy-partial-source-repair-1', { max_retries: 3 });
    await redis.zrem(
      keys.zset.status.pending,
      'legacy-partial-source',
      'legacy-partial-source-fix-1',
    );
    await redis.zadd(keys.zset.status.done, Date.now(), 'legacy-partial-source');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'legacy-partial-source-fix-1');
    await redis.hset(keys.hash.task('legacy-partial-source'), {
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'repairing',
      resolution_action: 'repair',
      resolution_task_id: 'legacy-partial-source-repair-1',
      resolution_task_ids: 'legacy-partial-source-repair-1',
      resolution_generation: '1',
      resolution_attempts: '1',
    });
    await redis.hset(keys.hash.task('legacy-partial-source-fix-1'), {
      status: 'failed',
      fix_for: 'legacy-partial-source',
    });
    await redis.hset(keys.hash.task('legacy-partial-source-repair-1'), {
      status: 'pending',
      fix_for: 'legacy-partial-source',
      repair_root_task_id: 'legacy-partial-source',
    });

    expect(await reconcileResolutionBacklog(redis)).toEqual({
      repaired_task_ids: [],
      needs_pm_decision_task_ids: [],
    });
    expect(await redis.hget(keys.hash.task('legacy-partial-source-fix-1'), 'repair_root_task_id')).toBe('legacy-partial-source');
    expect(await redis.hget(keys.hash.task('legacy-partial-source-repair-1'), 'fix_for')).toBe('legacy-partial-source-fix-1');
    expect(await redis.hget(keys.hash.task('legacy-partial-source'), 'resolution_task_ids')).toBe(
      'legacy-partial-source-fix-1,legacy-partial-source-repair-1',
    );

    const repair = await claimAs('legacy-partial-repair-worker');
    expect(repair.data?.task_id).toBe('legacy-partial-source-repair-1');
    await report(redis, {
      task_id: repair.data!.task_id,
      agent_id: 'legacy-partial-repair-worker',
      claim_token: repair.data!.claim_token,
      status: 'done',
    });
    expect((await pmReview(redis, repair.data!.task_id, { verdict: 'accept', reviewed_by: 'pm-autonomous' })).ok).toBe(true);
    expect(await redis.hget(keys.hash.task('legacy-partial-source-fix-1'), 'resolution_status')).toBe('resolved');
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'completed' });
  });

  it('Worker 向 PM 的 Question 回答后再次提问，会以新 question_id 重新提醒；文件等待不打扰 PM', async () => {
    await seedTask('reblocking-code');
    const firstClaim = await claimAs('blocking-worker');
    const firstQuestion = await createQuestion(redis, {
      task_id: 'reblocking-code',
      agent_id: 'blocking-worker',
      claim_token: firstClaim.data!.claim_token,
      body: '需要确认发布范围',
    });

    const project = new SupervisedProject({
      planId: 'autonomous-plan',
      isClosed: async () => false,
      pendingItems: async () => (await pmIntake(redis, { consumer: 'pm-autonomous' })).data!.items,
    });
    expect((await project.newItems()).some((item) => item.question_id === firstQuestion.data?.question_id)).toBe(true);

    await answerQuestion(redis, firstQuestion.data!.question_id, { consumer: 'pm-autonomous', answer: '仅发布 A 模块' });
    const secondClaim = await claim(redis, { agent_id: 'blocking-worker', blocking: false, timeout_ms: 1 });
    const secondQuestion = await createQuestion(redis, {
      task_id: 'reblocking-code',
      agent_id: 'blocking-worker',
      claim_token: secondClaim.data!.claim_token,
      body: 'A 模块是否需要灰度？',
    });

    expect(secondQuestion.data?.question_id).not.toBe(firstQuestion.data?.question_id);
    expect((await project.newItems()).some((item) => item.question_id === secondQuestion.data?.question_id)).toBe(true);
  });

  it('普通 code 依赖在前置任务 PM accepted 前不可领取，accepted 后才解除', async () => {
    await seedTask('accepted-prerequisite');
    await seedTask('dependent-code', { depends_on: ['accepted-prerequisite'] });

    const prerequisite = await claimAs('prerequisite-worker');
    expect(prerequisite.data?.task_id).toBe('accepted-prerequisite');
    await report(redis, {
      task_id: 'accepted-prerequisite',
      agent_id: 'prerequisite-worker',
      claim_token: prerequisite.data!.claim_token,
      status: 'done',
    });

    const beforeAcceptance = await claimAs('dependent-worker');
    expect(beforeAcceptance.data).toBeNull();

    await pmReview(redis, 'accepted-prerequisite', { verdict: 'accept', reviewed_by: 'pm-autonomous' });
    const afterAcceptance = await claim(redis, { agent_id: 'dependent-worker', blocking: false, timeout_ms: 1 });
    expect(afterAcceptance.data?.task_id).toBe('dependent-code');
  });
});
