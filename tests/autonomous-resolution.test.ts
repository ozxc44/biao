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
  getTasks,
  getReviewInfo,
  getResolutionDecision,
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
  replayAcceptedRepairSideEffects,
  resolutionDecision,
  runWatchdog,
  taskReset,
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
  it('task list 分页时 total 始终报告完整匹配数，不把当前页长度伪装成总数', async () => {
    for (let index = 0; index < 105; index++) {
      const taskId = `paged-task-${String(index).padStart(3, '0')}`;
      await seedTask(taskId);
      if (index >= 102) {
        await redis.zrem(keys.zset.status.pending, taskId);
        await redis.zadd(keys.zset.status.failed, index, taskId);
        await redis.hset(keys.hash.task(taskId), { status: 'failed' });
      }
    }

    const first = await getTasks(redis, { plan_id: 'autonomous-plan', limit: 100 });
    expect(first.data).toMatchObject({ total: 105, offset: 0, limit: 100, has_more: true });
    expect(first.data?.tasks).toHaveLength(100);

    const second = await getTasks(redis, { plan_id: 'autonomous-plan', limit: 100, offset: 100 });
    expect(second.data).toMatchObject({ total: 105, offset: 100, limit: 100, has_more: false });
    expect(second.data?.tasks).toHaveLength(5);
    expect(second.data?.tasks.filter((task) => task.status === 'failed')).toHaveLength(3);
  });

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

  it('repair 进入普通 pending 队列并继承来源的 Worker 类型与模型亲和', async () => {
    await seedTask('kimi-affinity-source', {
      assignee: 'kimi',
      model_override: 'kimi-code/k3-affinity',
      verify: [{ cmd: 'npm test', expect_exit: 0 }],
    });
    await agentRegister(redis, 'kimi-source-worker', 'kimi', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'kimi-source-worker', blocking: false, timeout_ms: 1,
    });
    expect(claimed.data?.task_id).toBe('kimi-affinity-source');
    expect(claimed.data?.model_override).toBe('kimi-code/k3-affinity');

    expect((await report(redis, {
      task_id: 'kimi-affinity-source',
      agent_id: 'kimi-source-worker',
      claim_token: claimed.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'npm test', exit_code: 1, passed: false }],
    })).ok).toBe(true);

    expect(await redis.hgetall(keys.hash.task('kimi-affinity-source-repair-1'))).toMatchObject({
      status: 'pending',
      assignee: 'kimi',
      model_override: 'kimi-code/k3-affinity',
    });
    expect(await redis.zrange(keys.zset.status.pending, 0, -1)).toContain('kimi-affinity-source-repair-1');

    await agentRegister(redis, 'codex-affinity-worker', 'codex', ['code']);
    expect((await claim(redis, {
      agent_id: 'codex-affinity-worker', blocking: false, timeout_ms: 1,
    })).data).toBeNull();
    await agentRegister(redis, 'kimi-repair-worker', 'kimi', ['code']);
    expect((await claim(redis, {
      agent_id: 'kimi-repair-worker', blocking: false, timeout_ms: 1,
    })).data).toMatchObject({
      task_id: 'kimi-affinity-source-repair-1',
      model_override: 'kimi-code/k3-affinity',
    });
  });

  it('异常 child 把旧的精确 agentId 归一为 agent_type，避免同一 Agent 自验收或离线后堆积', async () => {
    await seedTask('exact-agent-source', {
      assignee: 'kimi-exact-1',
      model_override: 'kimi-code/k3',
      verify: [{ cmd: 'npm test', expect_exit: 0 }],
    });
    await agentRegister(redis, 'kimi-exact-1', 'kimi', ['code']);
    const claimed = await claim(redis, {
      agent_id: 'kimi-exact-1', blocking: false, timeout_ms: 1,
    });
    expect(claimed.data?.task_id).toBe('exact-agent-source');
    expect((await report(redis, {
      task_id: 'exact-agent-source',
      agent_id: 'kimi-exact-1',
      claim_token: claimed.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'npm test', exit_code: 1, passed: false }],
    })).ok).toBe(true);

    expect(await redis.hgetall(keys.hash.task('exact-agent-source-repair-1'))).toMatchObject({
      status: 'pending',
      assignee: 'kimi',
      model_override: 'kimi-code/k3',
    });
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

  it('多来源 acceptance 失败时 fail-closed，不重开已 accepted 来源也不在 reconcile 中膨胀 lineage', async () => {
    for (const sourceId of ['multi-source-a', 'multi-source-b']) {
      await seedTask(sourceId);
      const claimed = await claimAs(`${sourceId}-worker`);
      await report(redis, {
        task_id: sourceId,
        agent_id: `${sourceId}-worker`,
        claim_token: claimed.data!.claim_token,
        status: 'done',
      });
      expect((await pmReview(redis, sourceId, {
        verdict: 'accept', reviewed_by: 'pm-autonomous',
      })).ok).toBe(true);
    }
    await seedTask('multi-source-acceptance', {
      type: 'acceptance',
      depends_on: ['multi-source-a', 'multi-source-b'],
      acceptance_for: ['multi-source-a', 'multi-source-b'],
    });
    const acceptance = await claimAs('multi-source-reviewer');
    const failed = await report(redis, {
      task_id: 'multi-source-acceptance',
      agent_id: 'multi-source-reviewer',
      claim_token: acceptance.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'multi-source acceptance', exit_code: 1, passed: false }],
    });

    expect(failed.data?.fix_tasks_generated ?? []).toEqual([]);
    expect(await redis.hgetall(keys.hash.task('multi-source-acceptance'))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_attempts: '0',
      resolution_task_ids: '',
    });
    for (const sourceId of ['multi-source-a', 'multi-source-b']) {
      expect(await redis.hgetall(keys.hash.task(sourceId))).toMatchObject({
        status: 'done',
        pm_review_status: 'accepted',
        resolution_status: '',
      });
      expect(await redis.exists(keys.hash.task(`${sourceId}-repair-1`))).toBe(0);
    }

    const before = await redis.hmget(
      keys.hash.task('multi-source-acceptance'),
      'resolution_attempts',
      'resolution_task_ids',
      'resolution_task_id',
    );
    await reconcileRuntimeState(redis);
    await reconcileRuntimeState(redis);
    expect(await redis.hmget(
      keys.hash.task('multi-source-acceptance'),
      'resolution_attempts',
      'resolution_task_ids',
      'resolution_task_id',
    )).toEqual(before);
  });

  it('多来源 acceptance 的 retry-limit 原因点名来源时，continue 只续派该来源而不 fan-out', async () => {
    for (const sourceId of ['targeted-source-a', 'targeted-source-b']) {
      await seedTask(sourceId, { assignee: sourceId.endsWith('-b') ? 'kimi' : 'codex' });
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done',
        pm_review_status: 'accepted',
        pm_reviewed_by: `pm-${sourceId}`,
        done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'targeted-multi-acceptance';
    await seedTask(acceptanceId, {
      type: 'acceptance',
      acceptance_for: ['targeted-source-a', 'targeted-source-b'],
      depends_on: ['targeted-source-a', 'targeted-source-b'],
      max_retries: 2,
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.failed, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: 'repair_retry_limit_reached:targeted-source-b',
      resolution_generation: '1',
      resolution_attempts: '1',
    });

    const continued = await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-targeted-repair',
    });

    expect(continued).toMatchObject({
      ok: true,
      data: {
        root_task_id: acceptanceId,
        state: 'repairing',
        action: 'reverify',
        created_task_ids: ['targeted-source-b-repair-1'],
      },
    });
    expect(await redis.exists(keys.hash.task('targeted-source-a-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('targeted-source-b-repair-1'))).toMatchObject({
      status: 'pending',
      type: 'code',
      assignee: 'kimi',
      fix_for: 'targeted-source-b',
      repair_root_task_id: 'targeted-source-b',
    });
    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'repairing',
      resolution_action: 'reverify',
    });
  });

  it('历史多来源验收拒绝必须由 PM 点名返修来源，continue 只续派该来源', async () => {
    for (const sourceId of ['selected-source-a', 'selected-source-b']) {
      await seedTask(sourceId, { assignee: sourceId.endsWith('-b') ? 'kimi' : 'codex' });
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'selected-multi-acceptance';
    await seedTask(acceptanceId, {
      type: 'acceptance',
      acceptance_for: ['selected-source-a', 'selected-source-b'],
      depends_on: ['selected-source-a', 'selected-source-b'],
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.done, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${acceptanceId}`,
    });

    expect(await getResolutionDecision(redis, acceptanceId)).toMatchObject({
      ok: true,
      data: {
        repair_source_candidates: ['selected-source-a', 'selected-source-b'],
      },
    });

    expect((await resolutionDecision(redis, acceptanceId, {
      action: 'continue', decided_by: 'pm-selector',
    })).error?.code).toBe('REPAIR_SOURCE_TASK_REQUIRED');
    expect((await resolutionDecision(redis, acceptanceId, {
      action: 'continue', decided_by: 'pm-selector', repair_source_task_id: 'not-a-source',
    })).error?.code).toBe('INVALID_REPAIR_SOURCE_TASK');

    const continued = await resolutionDecision(redis, acceptanceId, {
      action: 'continue', decided_by: 'pm-selector', repair_source_task_id: 'selected-source-b',
    });
    expect(continued).toMatchObject({
      ok: true,
      data: { created_task_ids: ['selected-source-b-repair-1'] },
    });
    expect(await redis.exists(keys.hash.task('selected-source-a-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('selected-source-b-repair-1'))).toMatchObject({
      fix_for: 'selected-source-b',
      assignee: 'kimi',
      trigger_review_task_id: acceptanceId,
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_decision_reason: '',
      acceptance_repair_task_ids: 'selected-source-b-repair-1',
    });
  });

  it('显式选源 repair 被拒绝后只重新打开 acceptance，不短暂再生来源根门铃', async () => {
    // fixture 需要让旧 acceptance review 的审计时间晚于本轮真实 reject，才能模拟
    // 生产中的单调时间序。余量必须远大于整测套件负载下的时钟漂移（曾用 +100ms
    // 导致全量运行时偶发“最新不可变拒绝记录”选序翻转），固定 10s/20s 消除竞态。
    const seededReviewAt = Date.now() + 10_000;
    const laterReviewAt = seededReviewAt + 10_000;
    for (const sourceId of ['reselect-source-a', 'reselect-source-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'reselect-acceptance';
    const reviewId = `${acceptanceId}-reverify-1`;
    const latestReviewId = `${acceptanceId}-reverify-2`;
    await seedTask(acceptanceId, {
      type: 'acceptance',
      acceptance_for: ['reselect-source-a', 'reselect-source-b'],
      depends_on: ['reselect-source-a', 'reselect-source-b'],
    });
    await seedTask(reviewId, {
      type: 'acceptance',
      acceptance_for: ['reselect-source-a', 'reselect-source-b'],
      depends_on: ['reselect-source-a', 'reselect-source-b'],
      fix_for: acceptanceId,
      repair_root_task_id: acceptanceId,
    });
    await seedTask(latestReviewId, {
      type: 'acceptance',
      acceptance_for: ['reselect-source-a', 'reselect-source-b'],
      depends_on: ['reselect-source-a', 'reselect-source-b'],
      fix_for: acceptanceId,
      repair_root_task_id: acceptanceId,
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId, reviewId, latestReviewId);
    await redis.zadd(
      keys.zset.status.done,
      Date.now(), acceptanceId,
      Date.now() + 1, reviewId,
      Date.now() + 2, latestReviewId,
    );
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'done', pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision', resolution_action: 'inspect',
      resolution_task_id: latestReviewId, resolution_task_ids: `${reviewId},${latestReviewId}`,
      resolution_generation: '2', resolution_attempts: '2',
      resolution_decision_reason: `repair_sources_required:${reviewId}`,
    });
    await redis.hset(keys.hash.task(reviewId), {
      status: 'done', pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      pm_reject_reason: '实时 applying 状态不可观察',
      pm_review_comment: '真实 E2E 未看到 applying 过渡态',
      pm_fix_instructions: '保持 applying 可观察，并补段落和表格时序断言',
      fix_for: acceptanceId, repair_root_task_id: acceptanceId,
    });
    await redis.hset(keys.hash.task(latestReviewId), {
      status: 'done', pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      pm_reject_reason: '最新拒绝：快速同步仍缺少可观察状态',
      pm_review_comment: '最新真实 E2E 仍未看到 applying',
      pm_fix_instructions: '以最新拒绝为准补齐时序状态机',
      pm_reviewed_at: String(seededReviewAt),
      fix_for: acceptanceId, repair_root_task_id: acceptanceId,
    });

    expect(await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-reselect',
      repair_source_task_id: 'reselect-source-b',
    })).toMatchObject({
      ok: true,
      data: { created_task_ids: ['reselect-source-b-repair-1'] },
    });

    const repairId = 'reselect-source-b-repair-1';
    expect(await redis.hget(keys.hash.task(repairId), 'goal_md')).toContain(
      `触发本轮返修的不可变验收记录：\`${latestReviewId}\``,
    );
    expect(await redis.hget(keys.hash.task(repairId), 'goal_md')).toContain(
      '最新真实 E2E 仍未看到 applying',
    );
    expect(await redis.hget(keys.hash.task(repairId), 'goal_md')).toContain(
      '以最新拒绝为准补齐时序状态机',
    );
    await redis.zrem(keys.zset.status.pending, repairId);
    await redis.zadd(keys.zset.status.done, Date.now(), repairId);
    await redis.hset(keys.hash.task(repairId), {
      status: 'done', done_at: String(Date.now()), claimed_by: 'worker-reselect',
    });
    const rejected = await pmReview(redis, repairId, {
      verdict: 'reject',
      reviewed_by: 'pm-reselect-reviewer',
      reject_reason: '修复仍不完整',
      fix_instructions: '重新选择来源并补齐闭环',
    });

    expect(rejected).toMatchObject({
      ok: true,
      data: { task_id: repairId, review_status: 'rejected', fix_task_ids: [] },
    });
    expect(await redis.hgetall(keys.hash.task('reselect-source-b'))).toMatchObject({
      status: 'done', pm_review_status: 'accepted', resolution_status: '', resolution_task_id: '',
    });
    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${repairId}`,
    });
    const intake = await pmIntake(redis, { consumer: 'pm-autonomous' });
    expect(intake.data?.items.filter((item) => item.kind === 'resolution_required').map((item) => item.task_id))
      .toEqual([acceptanceId]);
    expect(await redis.exists(keys.hash.task('reselect-source-b-repair-2'))).toBe(0);

    // fixture 的旧 acceptance review 使用了未来时间；把本轮真实后继 reject 调整为
    // 单调更晚，模拟生产中不可变审计的正常时间顺序。
    await redis.hset(keys.hash.task(repairId), 'pm_reviewed_at', String(laterReviewAt));
    await reconcileResolutionBacklog(redis);
    expect(await redis.hget(keys.hash.task(acceptanceId), 'resolution_decision_reason'))
      .toBe(`repair_sources_required:${repairId}`);
    expect(await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-reselect-next',
      repair_source_task_id: 'reselect-source-b',
    })).toMatchObject({
      ok: true,
      data: { created_task_ids: ['reselect-source-b-repair-2'] },
    });
    const nextGoal = await redis.hget(keys.hash.task('reselect-source-b-repair-2'), 'goal_md');
    expect(nextGoal).toContain(`触发本轮返修的不可变验收记录：\`${repairId}\``);
    expect(nextGoal).toContain('修复仍不完整');
    expect(nextGoal).toContain('重新选择来源并补齐闭环');
  });

  it('已闭合来源的迟到 sibling reject 只保留审计，不重开验收选源', async () => {
    const now = Date.now();
    for (const sourceId of ['stale-audit-source-a', 'stale-audit-source-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, now, sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(now),
      });
    }
    const rootId = 'stale-audit-acceptance';
    const winnerId = 'stale-audit-source-a-repair-1';
    const siblingId = 'stale-audit-source-a-repair-2';
    await seedTask(rootId, {
      type: 'acceptance',
      acceptance_for: ['stale-audit-source-a', 'stale-audit-source-b'],
      depends_on: ['stale-audit-source-a', 'stale-audit-source-b'],
      max_retries: 2,
    });
    await seedTask(winnerId);
    await seedTask(siblingId);
    await redis.zrem(keys.zset.status.pending, rootId, winnerId, siblingId);
    await redis.zadd(keys.zset.status.failed, now, rootId);
    await redis.zadd(keys.zset.status.done, now + 1, winnerId, now + 2, siblingId);
    await redis.hset(keys.hash.task(rootId), {
      status: 'failed',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      pm_reviewed_at: String(now),
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${siblingId}`,
      resolution_generation: '2',
      resolution_attempts: '2',
      acceptance_repair_task_ids: `${winnerId},${siblingId}`,
    });
    await redis.hset(keys.hash.task('stale-audit-source-a'), {
      resolution_status: 'resolved',
      resolution_action: 'repair',
      resolution_task_id: winnerId,
      resolution_task_ids: `${winnerId},${siblingId}`,
      resolved_by_task: winnerId,
    });
    await redis.hset(keys.hash.task(winnerId), {
      status: 'done', pm_review_status: 'accepted',
      // 未来时间戳只用于固化“winner 早于迟到 sibling reject”的审计顺序；余量放大到
      // 10s/20s，避免整测套件负载下真实时钟越过 ±1s 窗口翻转选序（同上例竞态）。
      pm_reviewed_at: String(now + 10_000),
      fix_for: 'stale-audit-source-a', repair_root_task_id: 'stale-audit-source-a',
    });
    await redis.hset(keys.hash.task(siblingId), {
      status: 'done', pm_review_status: 'rejected',
      pm_reviewed_at: String(now + 20_000),
      fix_for: 'stale-audit-source-a', repair_root_task_id: 'stale-audit-source-a',
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task(rootId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: 'reverify_retry_limit_reached',
      resolution_task_id: '',
    });
    expect(await redis.exists(keys.hash.task('stale-audit-source-a-repair-3'))).toBe(0);
  });

  it('一条验收拒绝要求多个来源时，PM 可一次选定最小返修子集', async () => {
    const sourceIds = ['batch-source-a', 'batch-source-b', 'batch-source-c'];
    for (const sourceId of sourceIds) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'batch-source-acceptance';
    await seedTask(acceptanceId, {
      type: 'acceptance', acceptance_for: sourceIds, depends_on: sourceIds,
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.done, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'done', pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision', resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${acceptanceId}`,
    });

    const continued = await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-batch-selector',
      repair_source_task_ids: ['batch-source-a', 'batch-source-c'],
    });

    expect(continued).toMatchObject({
      ok: true,
      data: { created_task_ids: ['batch-source-a-repair-1', 'batch-source-c-repair-1'] },
    });
    expect(await redis.exists(keys.hash.task('batch-source-b-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('batch-source-a-repair-1'))).toMatchObject({
      trigger_review_task_id: acceptanceId,
    });
    expect(await redis.hgetall(keys.hash.task('batch-source-c-repair-1'))).toMatchObject({
      trigger_review_task_id: acceptanceId,
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_decision_reason: '',
      acceptance_repair_task_ids: 'batch-source-a-repair-1,batch-source-c-repair-1',
    });
  });

  it('已在 needs_pm_decision 的多来源验收会以最新不可变 reject 更正旧的错误来源归因', async () => {
    for (const sourceId of ['migrated-source-a', 'migrated-source-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    const rootId = 'migrated-multi-acceptance';
    const reviewId = `${rootId}-reverify-6`;
    await seedTask(rootId, {
      type: 'acceptance',
      acceptance_for: ['migrated-source-a', 'migrated-source-b'],
      depends_on: ['migrated-source-a', 'migrated-source-b'],
    });
    await seedTask(reviewId, {
      type: 'acceptance',
      acceptance_for: ['migrated-source-a', 'migrated-source-b'],
      depends_on: ['migrated-source-a', 'migrated-source-b'],
    });
    await redis.zrem(keys.zset.status.pending, rootId, reviewId);
    await redis.zadd(keys.zset.status.failed, Date.now(), rootId);
    await redis.zadd(keys.zset.status.done, Date.now(), reviewId);
    await redis.hset(keys.hash.task(rootId), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: reviewId,
      resolution_task_ids: reviewId,
      resolution_decision_reason: 'repair_retry_limit_reached:migrated-source-b',
    });
    await redis.hset(keys.hash.task(reviewId), {
      status: 'done',
      done_at: String(Date.now()),
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      fix_for: rootId,
      repair_root_task_id: rootId,
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task(rootId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${reviewId}`,
    });
  });

  it('启动补偿会撤销越过最新 repair reject 的未领取复验，并改为 PM 选源决策', async () => {
    for (const sourceId of ['gated-source-a', 'gated-source-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    const rootId = 'gated-multi-acceptance';
    const rejectedId = `${rootId}-reverify-2`;
    const failedId = `${rootId}-reverify-3`;
    const pendingId = `${rootId}-reverify-4`;
    await seedTask(rootId, {
      type: 'acceptance',
      acceptance_for: ['gated-source-a', 'gated-source-b'],
      depends_on: ['gated-source-a', 'gated-source-b'],
    });
    for (const id of [rejectedId, failedId, pendingId]) {
      await seedTask(id, {
        type: 'acceptance',
        acceptance_for: ['gated-source-a', 'gated-source-b'],
        depends_on: ['gated-source-a', 'gated-source-b'],
      });
      await redis.hset(keys.hash.task(id), { fix_for: rootId, repair_root_task_id: rootId });
    }
    await redis.zrem(keys.zset.status.pending, rootId, rejectedId, failedId);
    await redis.zadd(keys.zset.status.failed, Date.now(), rootId);
    await redis.zadd(keys.zset.status.failed, Date.now(), failedId);
    await redis.zadd(keys.zset.status.done, Date.now(), rejectedId);
    await redis.hset(keys.hash.task(rootId), {
      status: 'failed',
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_task_id: pendingId,
      resolution_task_ids: `${rejectedId},${failedId},${pendingId}`,
    });
    await redis.hset(keys.hash.task(rejectedId), {
      status: 'done', done_at: String(Date.now() - 1_000),
      pm_review_status: 'rejected', pm_rejection_resolution_mode: 'repair',
      pm_reviewed_at: String(Date.now()),
    });
    await redis.hset(keys.hash.task(failedId), {
      status: 'failed', done_at: String(Date.now() + 1_000),
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task(pendingId))).toMatchObject({
      status: 'cancelled',
      resolution_decision_reason: 'acceptance_repair_required',
    });
    expect(await redis.hgetall(keys.hash.task(rootId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `repair_sources_required:${rejectedId}`,
    });
  });

  it('多来源 acceptance 的 reverify Worker 自身失败后，显式 continue 只重排独立复验、不误修来源', async () => {
    for (const sourceId of ['child-reverify-source-a', 'child-reverify-source-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done',
        pm_review_status: 'accepted',
        done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'child-reverify-multi-acceptance';
    const failedReverifyId = `${acceptanceId}-reverify-1`;
    await seedTask(acceptanceId, {
      type: 'acceptance',
      acceptance_for: ['child-reverify-source-a', 'child-reverify-source-b'],
      depends_on: ['child-reverify-source-a', 'child-reverify-source-b'],
      max_retries: 2,
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.failed, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_decision_reason: `multi_source_acceptance_failure:${failedReverifyId}`,
      resolution_task_id: failedReverifyId,
      resolution_task_ids: failedReverifyId,
      resolution_generation: '1',
      resolution_attempts: '1',
    });
    await seedTask(failedReverifyId, {
      type: 'acceptance',
      acceptance_for: ['child-reverify-source-a', 'child-reverify-source-b'],
      depends_on: ['child-reverify-source-a', 'child-reverify-source-b'],
      fix_for: acceptanceId,
      repair_root_task_id: acceptanceId,
    });
    await redis.zrem(keys.zset.status.pending, failedReverifyId);
    await redis.zadd(keys.zset.status.failed, Date.now(), failedReverifyId);
    await redis.hset(keys.hash.task(failedReverifyId), { status: 'failed' });

    const continued = await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-child-reverify',
    });

    expect(continued).toMatchObject({
      ok: true,
      data: {
        root_task_id: acceptanceId,
        created_task_ids: [`${acceptanceId}-reverify-2`],
      },
    });
    expect(await redis.hgetall(keys.hash.task(`${acceptanceId}-reverify-2`))).toMatchObject({
      status: 'pending',
      type: 'acceptance',
      fix_for: acceptanceId,
      repair_root_task_id: acceptanceId,
      trigger_review_task_id: failedReverifyId,
    });
    expect(await redis.exists(keys.hash.task('child-reverify-source-a-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('child-reverify-source-b-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'required',
      resolution_action: 'reverify',
    });
  });

  it('错误排队的 reverify 即使交付也不能越过未闭合的 repair 决定直接 accept', async () => {
    await seedTask('guard-source');
    await redis.zrem(keys.zset.status.pending, 'guard-source');
    await redis.zadd(keys.zset.status.done, 10, 'guard-source');
    await redis.hset(keys.hash.task('guard-source'), {
      status: 'done', pm_review_status: 'accepted', pm_reviewed_at: '10', done_at: '9',
    });
    await seedTask('guard-acceptance', {
      type: 'acceptance', acceptance_for: ['guard-source'], depends_on: ['guard-source'],
    });
    await redis.zrem(keys.zset.status.pending, 'guard-acceptance');
    await redis.zadd(keys.zset.status.done, 20, 'guard-acceptance');
    await redis.hset(keys.hash.task('guard-acceptance'), {
      status: 'done',
      pm_review_status: 'rejected',
      pm_rejection_resolution_mode: 'repair',
      pm_reviewed_at: '20',
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: 'guard-acceptance-reverify-1',
      resolution_task_ids: 'guard-acceptance-reverify-1',
      resolution_generation: '1',
    });
    await seedTask('guard-acceptance-reverify-1', {
      type: 'acceptance',
      acceptance_for: ['guard-source'],
      depends_on: ['guard-source'],
      fix_for: 'guard-acceptance',
      repair_root_task_id: 'guard-acceptance',
    });
    await redis.zrem(keys.zset.status.pending, 'guard-acceptance-reverify-1');
    await redis.zadd(keys.zset.status.done, 30, 'guard-acceptance-reverify-1');
    await redis.hset(keys.hash.task('guard-acceptance-reverify-1'), {
      status: 'done',
      claimed_by: 'review-worker',
      done_at: '30',
      fix_for: 'guard-acceptance',
      repair_root_task_id: 'guard-acceptance',
    });

    expect(await pmReview(redis, 'guard-acceptance-reverify-1', {
      verdict: 'accept', reviewed_by: 'pm',
    })).toMatchObject({
      ok: false,
      error: { code: 'ACCEPTANCE_REPAIR_REQUIRED' },
    });
    expect(await redis.hget(keys.hash.task('guard-acceptance-reverify-1'), 'pm_review_status')).toBeFalsy();
  });

  it('升级 reconcile 会清理多来源 acceptance 的跨根 lineage 与虚高 attempts', async () => {
    for (const sourceId of ['legacy-multi-a', 'legacy-multi-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
      await seedTask(`${sourceId}-repair-1`, {
        fix_for: sourceId,
        repair_root_task_id: sourceId,
      });
      await redis.zrem(keys.zset.status.pending, `${sourceId}-repair-1`);
      await redis.zadd(keys.zset.status.done, Date.now(), `${sourceId}-repair-1`);
      await redis.hset(keys.hash.task(`${sourceId}-repair-1`), {
        status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
      });
    }
    await seedTask('legacy-multi-acceptance', {
      type: 'acceptance',
      depends_on: ['legacy-multi-a', 'legacy-multi-b'],
      acceptance_for: ['legacy-multi-a', 'legacy-multi-b'],
    });
    await redis.zrem(keys.zset.status.pending, 'legacy-multi-acceptance');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'legacy-multi-acceptance');
    await redis.hset(keys.hash.task('legacy-multi-acceptance'), {
      status: 'failed',
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_task_id: 'legacy-multi-b-repair-1',
      resolution_task_ids: 'legacy-multi-a-repair-1,legacy-multi-b-repair-1',
      resolution_generation: '0',
      resolution_attempts: '157',
    });

    await reconcileResolutionBacklog(redis);
    expect(await redis.hgetall(keys.hash.task('legacy-multi-acceptance'))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolution_generation: '0',
      resolution_attempts: '0',
      resolution_decision_reason: 'multi_source_acceptance_failure:legacy-multi-acceptance',
    });
    expect(await redis.hgetall(keys.hash.task('legacy-multi-a'))).toMatchObject({
      status: 'done', pm_review_status: 'accepted', resolution_status: '',
    });
  });

  it('已取消的多来源 acceptance Worker failure 由显式 continue 重开独立复验、不 fan-out 来源', async () => {
    for (const sourceId of ['cancelled-multi-a', 'cancelled-multi-b']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done',
        pm_review_status: 'accepted',
        pm_reviewed_by: `implementer-${sourceId}`,
        done_at: String(Date.now()),
      });
    }
    const acceptanceId = 'cancelled-multi-acceptance';
    await seedTask(acceptanceId, {
      type: 'acceptance',
      depends_on: ['cancelled-multi-a', 'cancelled-multi-b'],
      acceptance_for: ['cancelled-multi-a', 'cancelled-multi-b'],
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.failed, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'failed',
      resolution_status: 'cancelled',
      resolution_action: 'cancel',
      resolution_decision_reason: `cancelled:multi_source_acceptance_failure:${acceptanceId}`,
    });

    expect((await resolutionDecision(redis, acceptanceId, {
      action: 'inspect',
      decided_by: 'pm-reverify',
    })).data).toMatchObject({
      state: 'cancelled',
      available_actions: ['inspect', 'continue'],
    });
    const continued = await resolutionDecision(redis, acceptanceId, {
      action: 'continue',
      decided_by: 'pm-reverify',
    });
    expect(continued).toMatchObject({
      ok: true,
      data: { created_task_ids: [`${acceptanceId}-reverify-1`] },
    });
    expect(await redis.hgetall(keys.hash.task(`${acceptanceId}-reverify-1`))).toMatchObject({
      status: 'pending', type: 'acceptance', repair_root_task_id: acceptanceId,
    });
    expect(await redis.exists(keys.hash.task('cancelled-multi-a-repair-1'))).toBe(0);
    expect(await redis.exists(keys.hash.task('cancelled-multi-b-repair-1'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      status: 'failed',
      resolution_status: 'required',
      resolution_action: 'reverify',
    });
  });

  it('升级 reconcile 只撤销多来源 acceptance 错误扩散的 pending repair，保留已开始现场', async () => {
    const acceptanceId = 'legacy-fanout-acceptance';
    for (const sourceId of ['legacy-fanout-pending', 'legacy-fanout-running']) {
      await seedTask(sourceId);
      await redis.zrem(keys.zset.status.pending, sourceId);
      await redis.zadd(keys.zset.status.done, Date.now(), sourceId);
      await redis.hset(keys.hash.task(sourceId), {
        status: 'done',
        pm_review_status: 'accepted',
        done_at: String(Date.now()),
        resolution_status: 'repairing',
        resolution_action: 'repair',
        resolution_task_id: `${sourceId}-repair-1`,
        resolution_task_ids: `${sourceId}-repair-1`,
        resolution_generation: '1',
        resolution_attempts: '1',
      });
      await seedTask(`${sourceId}-repair-1`, {
        fix_for: sourceId,
        repair_root_task_id: sourceId,
      });
      await redis.hset(keys.hash.task(`${sourceId}-repair-1`), {
        fix_for: sourceId,
        repair_root_task_id: sourceId,
        goal_md: `# 修复\n\n原任务 ${sourceId} 因独立验收失败进入修复闭环。\n\n原因：独立验收任务 ${acceptanceId} 失败。`,
      });
    }
    await redis.zrem(keys.zset.status.pending, 'legacy-fanout-running-repair-1');
    await redis.zadd(keys.zset.status.running, Date.now(), 'legacy-fanout-running-repair-1');
    await redis.hset(keys.hash.task('legacy-fanout-running-repair-1'), {
      status: 'running',
      claimed_by: 'existing-kimi',
      claim_token: 'existing-claim',
    });

    await seedTask(acceptanceId, {
      type: 'acceptance',
      depends_on: ['legacy-fanout-pending', 'legacy-fanout-running'],
      acceptance_for: ['legacy-fanout-pending', 'legacy-fanout-running'],
    });
    await redis.zrem(keys.zset.status.pending, acceptanceId);
    await redis.zadd(keys.zset.status.failed, Date.now(), acceptanceId);
    await redis.hset(keys.hash.task(acceptanceId), {
      status: 'failed',
      acceptance_repair_task_ids: [
        'legacy-fanout-pending-repair-1',
        'legacy-fanout-running-repair-1',
      ].join(','),
      resolution_status: 'repairing',
      resolution_action: 'reverify',
      resolution_task_id: 'legacy-fanout-pending-repair-1',
      resolution_task_ids: 'legacy-fanout-pending-repair-1,legacy-fanout-running-repair-1',
      resolution_attempts: '9',
    });

    expect(await redis.hmget(
      keys.hash.task('legacy-fanout-pending-repair-1'),
      'repair_root_task_id',
      'goal_md',
      'status',
    )).toEqual([
      'legacy-fanout-pending',
      `# 修复\n\n原任务 legacy-fanout-pending 因独立验收失败进入修复闭环。\n\n原因：独立验收任务 ${acceptanceId} 失败。`,
      'pending',
    ]);

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task('legacy-fanout-pending-repair-1'))).toMatchObject({
      status: 'cancelled',
      cancel_reason: `旧版多来源验收 ${acceptanceId} 错误扩散的未领取修复，平台升级后自动撤销`,
      resolution_decision_reason: `legacy_multi_source_acceptance_fanout_cancelled:${acceptanceId}`,
    });
    expect(await redis.zscore(keys.zset.status.pending, 'legacy-fanout-pending-repair-1')).toBeNull();
    expect(await redis.zscore(keys.zset.status.cancelled, 'legacy-fanout-pending-repair-1')).not.toBeNull();
    expect(await redis.hgetall(keys.hash.task('legacy-fanout-pending'))).toMatchObject({
      status: 'done',
      pm_review_status: 'accepted',
      resolution_status: '',
      resolution_task_id: '',
      resolution_task_ids: '',
    });

    expect(await redis.hgetall(keys.hash.task('legacy-fanout-running-repair-1'))).toMatchObject({
      status: 'running',
      claimed_by: 'existing-kimi',
      claim_token: 'existing-claim',
    });
    expect(await redis.hgetall(keys.hash.task('legacy-fanout-running'))).toMatchObject({
      resolution_status: 'repairing',
      resolution_task_id: 'legacy-fanout-running-repair-1',
      resolution_task_ids: 'legacy-fanout-running-repair-1',
    });
    expect(await redis.hgetall(keys.hash.task(acceptanceId))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: '',
      resolution_task_ids: '',
      resolution_attempts: '0',
      acceptance_repair_task_ids: 'legacy-fanout-running-repair-1',
    });
  });

  it('升级 reconcile 会撤销 accepted 根被旧验收错误生成的未领取 repair', async () => {
    await seedTask('accepted-reopened-root');
    const source = await claimAs('accepted-reopened-worker');
    await report(redis, {
      task_id: 'accepted-reopened-root',
      agent_id: 'accepted-reopened-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, 'accepted-reopened-root', { verdict: 'accept', reviewed_by: 'pm-autonomous' });
    await seedTask('accepted-reopened-root-repair-1', {
      fix_for: 'accepted-reopened-root',
      repair_root_task_id: 'accepted-reopened-root',
    });
    await redis.hset(keys.hash.task('accepted-reopened-root-repair-1'), {
      fix_for: 'accepted-reopened-root',
      repair_root_task_id: 'accepted-reopened-root',
      goal_md: '# 修复\n\n原任务因独立验收失败进入修复闭环。',
    });
    await redis.hset(keys.hash.task('accepted-reopened-root'), {
      resolution_status: 'repairing',
      resolution_action: 'repair',
      resolution_task_id: 'accepted-reopened-root-repair-1',
      resolution_task_ids: 'accepted-reopened-root-repair-1',
      resolution_generation: '1',
      resolution_attempts: '1',
    });

    await reconcileResolutionBacklog(redis);
    expect(await redis.hgetall(keys.hash.task('accepted-reopened-root'))).toMatchObject({
      status: 'done',
      pm_review_status: 'accepted',
      resolution_status: '',
      resolution_action: '',
      resolution_task_id: '',
    });
    expect(await redis.hgetall(keys.hash.task('accepted-reopened-root-repair-1'))).toMatchObject({
      status: 'cancelled',
      fix_for: 'accepted-reopened-root',
      repair_root_task_id: 'accepted-reopened-root',
      resolution_decision_reason: 'accepted_root_legacy_repair_cancelled',
    });
    expect(await redis.zscore(keys.zset.status.pending, 'accepted-reopened-root-repair-1')).toBeNull();
  });

  it('clean accepted 来源被单来源独立验收推翻时进入可审计 repair', async () => {
    await seedTask('accepted-terminal-source');
    const source = await claimAs('accepted-terminal-worker');
    await report(redis, {
      task_id: 'accepted-terminal-source',
      agent_id: 'accepted-terminal-worker',
      claim_token: source.data!.claim_token,
      status: 'done',
    });
    await pmReview(redis, 'accepted-terminal-source', { verdict: 'accept', reviewed_by: 'pm-autonomous' });
    await seedTask('accepted-terminal-check', {
      type: 'acceptance',
      depends_on: ['accepted-terminal-source'],
      acceptance_for: ['accepted-terminal-source'],
    });
    const acceptance = await claimAs('accepted-terminal-reviewer');
    await report(redis, {
      task_id: 'accepted-terminal-check',
      agent_id: 'accepted-terminal-reviewer',
      claim_token: acceptance.data!.claim_token,
      status: 'failed',
    });

    expect(await redis.hgetall(keys.hash.task('accepted-terminal-source'))).toMatchObject({
      status: 'done', pm_review_status: 'accepted', resolution_status: 'repairing',
    });
    expect(await redis.hgetall(keys.hash.task('accepted-terminal-source-repair-1'))).toMatchObject({
      status: 'pending', fix_for: 'accepted-terminal-source',
    });
    expect(await redis.hget(keys.hash.task('accepted-terminal-check'), 'resolution_status')).toBe('repairing');

    await redis.zrem(keys.zset.status.pending, 'accepted-terminal-source-repair-1');
    await reconcileResolutionBacklog(redis);
    expect(await redis.zscore(keys.zset.status.pending, 'accepted-terminal-source-repair-1')).not.toBeNull();
  });

  it('reconcile terminalizes a pending child while its root is waiting for PM decision', async () => {
    await seedTask('decision-paused-root');
    await redis.zrem(keys.zset.status.pending, 'decision-paused-root');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'decision-paused-root');
    await redis.hset(keys.hash.task('decision-paused-root'), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: 'decision-paused-root-repair-1',
      resolution_task_ids: 'decision-paused-root-repair-1',
      resolution_decision_reason: 'repair_ownership_intent_marker_invalid:test',
    });
    await seedTask('decision-paused-root-repair-1', {
      fix_for: 'decision-paused-root', repair_root_task_id: 'decision-paused-root',
    });
    await redis.hset(keys.hash.task('decision-paused-root-repair-1'), {
      fix_for: 'decision-paused-root', repair_root_task_id: 'decision-paused-root',
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task('decision-paused-root-repair-1'))).toMatchObject({
      status: 'cancelled',
      resolution_decision_reason: 'resolution_waiting_for_pm_decision',
    });
    expect(await redis.zscore(keys.zset.status.pending, 'decision-paused-root-repair-1')).toBeNull();
    expect(await redis.hgetall(keys.hash.task('decision-paused-root'))).toMatchObject({
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_task_id: 'decision-paused-root-repair-1',
    });
  });

  it('reconcile restores the latest accepted lineage winner instead of keeping a stale continue child active', async () => {
    await seedTask('accepted-winner-root');
    await redis.zrem(keys.zset.status.pending, 'accepted-winner-root');
    await redis.zadd(keys.zset.status.done, Date.now(), 'accepted-winner-root');
    await redis.hset(keys.hash.task('accepted-winner-root'), {
      status: 'done', pm_review_status: 'rejected',
      resolution_status: 'needs_pm_decision', resolution_action: 'inspect',
      resolution_task_id: 'accepted-winner-root-repair-2',
      resolution_task_ids: 'accepted-winner-root-repair-1,accepted-winner-root-repair-2',
      resolution_decision_reason: 'repair_ownership_intent_marker_invalid:test',
    });
    for (const [taskId, status, review] of [
      ['accepted-winner-root-repair-1', 'done', 'accepted'],
      ['accepted-winner-root-repair-2', 'pending', ''],
    ] as const) {
      await seedTask(taskId);
      await redis.zrem(keys.zset.status.pending, taskId);
      await redis.zadd((keys.zset.status as Record<string, string>)[status], Date.now(), taskId);
      await redis.hset(keys.hash.task(taskId), {
        status, pm_review_status: review, fix_for: 'accepted-winner-root',
        repair_root_task_id: 'accepted-winner-root',
        ...(review === 'accepted' ? { pm_accept_effects_applied: 'true' } : {}),
      });
    }

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task('accepted-winner-root'))).toMatchObject({
      resolution_status: 'resolved',
      resolution_task_id: 'accepted-winner-root-repair-1',
      resolved_by_task: 'accepted-winner-root-repair-1',
    });
    expect(await redis.hgetall(keys.hash.task('accepted-winner-root-repair-2'))).toMatchObject({
      status: 'cancelled',
    });
  });

  it('explicit continue refuses to create a new generation when the lineage already has an accepted winner', async () => {
    await seedTask('continue-after-accepted-root');
    await redis.zrem(keys.zset.status.pending, 'continue-after-accepted-root');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'continue-after-accepted-root');
    await redis.hset(keys.hash.task('continue-after-accepted-root'), {
      status: 'failed', resolution_status: 'needs_pm_decision', resolution_action: 'inspect',
      resolution_task_id: 'continue-after-accepted-root-repair-1',
      resolution_task_ids: 'continue-after-accepted-root-repair-1',
      resolution_decision_reason: 'repair_retry_limit_reached',
      resolution_attempts: '1', resolution_generation: '1', max_retries: '1',
    });
    await seedTask('continue-after-accepted-root-repair-1');
    await redis.zrem(keys.zset.status.pending, 'continue-after-accepted-root-repair-1');
    await redis.zadd(keys.zset.status.done, Date.now(), 'continue-after-accepted-root-repair-1');
    await redis.hset(keys.hash.task('continue-after-accepted-root-repair-1'), {
      status: 'done', pm_review_status: 'accepted', pm_accept_effects_applied: 'true',
      fix_for: 'continue-after-accepted-root', repair_root_task_id: 'continue-after-accepted-root',
    });

    const continued = await resolutionDecision(redis, 'continue-after-accepted-root', {
      action: 'continue', decided_by: 'pm-stale',
    });

    expect(continued).toMatchObject({ ok: false, error: { code: 'RESOLUTION_ALREADY_RESOLVED' } });
    expect(await redis.exists(keys.hash.task('continue-after-accepted-root-repair-2'))).toBe(0);
    expect(await redis.hgetall(keys.hash.task('continue-after-accepted-root'))).toMatchObject({
      resolution_status: 'resolved', resolved_by_task: 'continue-after-accepted-root-repair-1',
    });
  });

  it('cancel of a redundant rejected generation retains an earlier accepted winner and repairs legacy cancelled state', async () => {
    await seedTask('cancel-after-accepted-root');
    await redis.zrem(keys.zset.status.pending, 'cancel-after-accepted-root');
    await redis.zadd(keys.zset.status.done, Date.now(), 'cancel-after-accepted-root');
    await redis.hset(keys.hash.task('cancel-after-accepted-root'), {
      status: 'done', pm_review_status: 'accepted',
      resolution_status: 'cancelled', resolution_action: 'cancel',
      resolution_task_id: 'cancel-after-accepted-root-repair-2',
      resolution_task_ids: 'cancel-after-accepted-root-repair-1,cancel-after-accepted-root-repair-2',
      resolution_decision_reason: 'cancelled:repair_retry_limit_reached',
      resolution_attempts: '2', resolution_generation: '2', max_retries: '2',
    });
    await seedTask('cancel-after-accepted-root-repair-1', {
      fix_for: 'cancel-after-accepted-root',
      repair_root_task_id: 'cancel-after-accepted-root',
    });
    await redis.zrem(keys.zset.status.pending, 'cancel-after-accepted-root-repair-1');
    await redis.zadd(keys.zset.status.done, Date.now(), 'cancel-after-accepted-root-repair-1');
    await redis.hset(keys.hash.task('cancel-after-accepted-root-repair-1'), {
      status: 'done', pm_review_status: 'accepted', pm_accept_effects_applied: 'true',
      fix_for: 'cancel-after-accepted-root', repair_root_task_id: 'cancel-after-accepted-root',
    });
    await seedTask('cancel-after-accepted-root-repair-2', {
      fix_for: 'cancel-after-accepted-root',
      repair_root_task_id: 'cancel-after-accepted-root',
    });
    await redis.zrem(keys.zset.status.pending, 'cancel-after-accepted-root-repair-2');
    await redis.zadd(keys.zset.status.done, Date.now(), 'cancel-after-accepted-root-repair-2');
    await redis.hset(keys.hash.task('cancel-after-accepted-root-repair-2'), {
      status: 'done', pm_review_status: 'rejected',
      fix_for: 'cancel-after-accepted-root', repair_root_task_id: 'cancel-after-accepted-root',
    });

    const cancelled = await resolutionDecision(redis, 'cancel-after-accepted-root', {
      action: 'cancel', decided_by: 'pm-clean-redundant-generation',
    });

    expect(cancelled).toMatchObject({
      ok: true,
      data: {
        root_task_id: 'cancel-after-accepted-root',
        state: 'resolved',
        latest_repair_id: 'cancel-after-accepted-root-repair-1',
      },
    });
    expect(await redis.hgetall(keys.hash.task('cancel-after-accepted-root'))).toMatchObject({
      resolution_status: 'resolved',
      resolved_by_task: 'cancel-after-accepted-root-repair-1',
    });
  });

  it('a multi-generation accepted winner becomes the current pointer on every ancestor', async () => {
    await seedTask('winner-pointer-root');
    await seedTask('winner-pointer-root-repair-1', {
      fix_for: 'winner-pointer-root', repair_root_task_id: 'winner-pointer-root',
    });
    await seedTask('winner-pointer-root-repair-2', {
      fix_for: 'winner-pointer-root-repair-1', repair_root_task_id: 'winner-pointer-root',
    });
    await redis.zrem(
      keys.zset.status.pending,
      'winner-pointer-root',
      'winner-pointer-root-repair-1',
      'winner-pointer-root-repair-2',
    );
    await redis.zadd(keys.zset.status.failed, Date.now(), 'winner-pointer-root');
    await redis.zadd(keys.zset.status.done, Date.now(), 'winner-pointer-root-repair-1');
    await redis.zadd(keys.zset.status.done, Date.now(), 'winner-pointer-root-repair-2');
    await redis.hset(keys.hash.task('winner-pointer-root'), {
      status: 'failed', resolution_status: 'repairing',
      resolution_task_id: 'winner-pointer-root-repair-1',
      resolution_task_ids: 'winner-pointer-root-repair-1,winner-pointer-root-repair-2',
    });
    await redis.hset(keys.hash.task('winner-pointer-root-repair-1'), {
      status: 'done', pm_review_status: 'rejected', fix_for: 'winner-pointer-root',
      repair_root_task_id: 'winner-pointer-root',
    });
    await redis.hset(keys.hash.task('winner-pointer-root-repair-2'), {
      status: 'done', pm_review_status: 'accepted', fix_for: 'winner-pointer-root-repair-1',
      repair_root_task_id: 'winner-pointer-root', pm_accept_effects_applied: 'true',
    });

    await reconcileResolutionBacklog(redis);

    expect(await redis.hgetall(keys.hash.task('winner-pointer-root'))).toMatchObject({
      resolution_status: 'resolved',
      resolution_task_id: 'winner-pointer-root-repair-2',
      resolved_by_task: 'winner-pointer-root-repair-2',
    });
  });

  it('accepting a repair terminalizes every older pending sibling in the same root lineage', async () => {
    await seedTask('winner-cleans-siblings-root');
    await redis.zrem(keys.zset.status.pending, 'winner-cleans-siblings-root');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'winner-cleans-siblings-root');
    await redis.hset(keys.hash.task('winner-cleans-siblings-root'), {
      status: 'failed', resolution_status: 'repairing',
      resolution_task_id: 'winner-cleans-siblings-repair-2',
      resolution_task_ids: 'winner-cleans-siblings-repair-1,winner-cleans-siblings-repair-2',
    });
    for (const [taskId, status, review] of [
      ['winner-cleans-siblings-repair-1', 'pending', ''],
      ['winner-cleans-siblings-repair-2', 'done', 'accepted'],
    ] as const) {
      await seedTask(taskId);
      await redis.zrem(keys.zset.status.pending, taskId);
      await redis.zadd((keys.zset.status as Record<string, string>)[status], Date.now(), taskId);
      await redis.hset(keys.hash.task(taskId), {
        status, pm_review_status: review, fix_for: 'winner-cleans-siblings-root',
        repair_root_task_id: 'winner-cleans-siblings-root',
      });
    }

    await replayAcceptedRepairSideEffects(redis, 'winner-cleans-siblings-repair-2');

    expect(await redis.hgetall(keys.hash.task('winner-cleans-siblings-root'))).toMatchObject({
      resolution_status: 'resolved', resolved_by_task: 'winner-cleans-siblings-repair-2',
    });
    expect(await redis.hgetall(keys.hash.task('winner-cleans-siblings-repair-1'))).toMatchObject({
      status: 'cancelled',
      resolution_decision_reason: 'superseded_by_accepted_repair:winner-cleans-siblings-repair-2',
    });
  });

  it('late sibling delivery cannot displace an already accepted repair winner', async () => {
    await seedTask('late-sibling-root');
    await seedTask('late-sibling-root-repair-1');
    await seedTask('late-sibling-root-repair-2');
    const now = Date.now();
    await redis.zrem(
      keys.zset.status.pending,
      'late-sibling-root',
      'late-sibling-root-repair-1',
      'late-sibling-root-repair-2',
    );
    await redis.zadd(keys.zset.status.done, now, 'late-sibling-root');
    await redis.zadd(keys.zset.status.done, now, 'late-sibling-root-repair-1');
    await redis.zadd(keys.zset.status.done, now + 1, 'late-sibling-root-repair-2');
    await redis.hset(keys.hash.task('late-sibling-root'), {
      status: 'done',
      pm_review_status: 'rejected',
      resolution_status: 'resolved',
      resolution_action: 'repair',
      resolution_task_id: 'late-sibling-root-repair-1',
      resolution_task_ids: 'late-sibling-root-repair-1,late-sibling-root-repair-2',
      resolved_by_task: 'late-sibling-root-repair-1',
    });
    await redis.hset(keys.hash.task('late-sibling-root-repair-1'), {
      status: 'done',
      pm_review_status: 'accepted',
      fix_for: 'late-sibling-root',
      repair_root_task_id: 'late-sibling-root',
    });
    await redis.hset(keys.hash.task('late-sibling-root-repair-2'), {
      status: 'done',
      pm_review_status: '',
      fix_for: 'late-sibling-root',
      repair_root_task_id: 'late-sibling-root',
    });

    const rejectedReview = await pmReview(redis, 'late-sibling-root-repair-2', {
      verdict: 'reject',
      reviewed_by: 'pm-late',
      comment: 'late empty delivery',
    });
    expect(rejectedReview).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_SUPERSEDED_BY_ACCEPTED_WINNER' },
    });

    const acceptedReview = await pmReview(redis, 'late-sibling-root-repair-2', {
      verdict: 'accept',
      reviewed_by: 'pm-late',
      comment: 'late green delivery',
    });

    expect(acceptedReview).toMatchObject({
      ok: false,
      error: { code: 'REPAIR_SUPERSEDED_BY_ACCEPTED_WINNER' },
    });
    expect(await redis.hgetall(keys.hash.task('late-sibling-root'))).toMatchObject({
      resolution_status: 'resolved',
      resolution_task_id: 'late-sibling-root-repair-1',
      resolved_by_task: 'late-sibling-root-repair-1',
    });
    expect(await redis.hget(keys.hash.task('late-sibling-root-repair-2'), 'pm_review_status')).toBe('');
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
      available_actions: ['inspect', 'continue'],
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

    const resolutionEventCount = async () => {
      const events = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
      return events.filter(([, fields]) =>
        fields.includes('resolution_required') && fields.includes('retry-limit-source'),
      ).length;
    };
    const eventsBeforeReconcile = await resolutionEventCount();
    await reconcileResolutionBacklog(redis);
    expect((await getTask(redis, 'retry-limit-source')).data).toMatchObject({
      resolution_status: 'cancelled',
      resolution_action: 'cancel',
    });
    expect(await resolutionEventCount()).toBe(eventsBeforeReconcile);

    const forbiddenReset = await taskReset(redis, 'retry-limit-source', {
      force: true,
      reset_by: 'pm-must-not-erase-reject',
    });
    expect(forbiddenReset).toMatchObject({
      ok: false,
      error: { code: 'RESOLUTION_AUDIT_IMMUTABLE' },
    });

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

    // 兼容旧数据：根已明确 cancel，但末代 child 的 review 字段因旧双写缺口丢失。
    // 根的 retry-limit/cancel 决策仍是权威，显式 continue 不能把这个旧 done child
    // 误当成当前待验收工作并再次卡死。
    await redis.hset(keys.hash.task('retry-limit-source-repair-2'), {
      status: 'done',
      pm_review_status: '',
    });
    const legacyUnreviewedChild = await redis.hgetall(keys.hash.task('retry-limit-source-repair-2'));

    // cancelled 仍保持静默终态；只有操作者显式 continue 才重新放行一代，且旧 child
    // 与 cancel 审计均不被 reset/覆盖。这样历史旧链可迁入普通 Worker 队列，而不会
    // 因 retry limit 永久堵住下游 pending 依赖。
    const reopened = await resolutionDecision(redis, 'retry-limit-source', {
      action: 'continue',
      decided_by: 'operator-override',
    });
    expect(reopened.data).toMatchObject({
      root_task_id: 'retry-limit-source',
      state: 'repairing',
      action: 'repair',
      latest_repair_id: 'retry-limit-source-repair-3',
      created_task_ids: ['retry-limit-source-repair-3'],
    });
    expect(await redis.hgetall(keys.hash.task('retry-limit-source-repair-2'))).toEqual(legacyUnreviewedChild);
    expect(await redis.hgetall(keys.hash.task('retry-limit-source-repair-3'))).toMatchObject({
      status: 'pending',
      fix_for: 'retry-limit-source',
      repair_root_task_id: 'retry-limit-source',
    });
    expect((await getPlan(redis, 'autonomous-plan')).data).toMatchObject({ status: 'active' });
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

    expect((await cancelTask(redis, repairId, { reason: 'PM 决定停止当前修复并重新评估' })).ok).toBe(true);
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

  it('runtime reconcile 只为旧 cancelled 空审计补事实标记且不覆盖已有原因', async () => {
    await seedTask('legacy-cancel-missing-reason');
    await seedTask('legacy-cancel-with-reason');
    for (const taskId of ['legacy-cancel-missing-reason', 'legacy-cancel-with-reason']) {
      await redis.zrem(keys.zset.status.pending, taskId);
      await redis.zadd(keys.zset.status.cancelled, 17_000, taskId);
      await redis.hset(keys.hash.task(taskId), { status: 'cancelled', cancelled_at: '17000' });
    }
    await redis.hset(keys.hash.task('legacy-cancel-with-reason'), 'cancel_reason', '原始原因必须保留');

    await reconcileRuntimeState(redis);
    await reconcileRuntimeState(redis);

    expect(await redis.hgetall(keys.hash.task('legacy-cancel-missing-reason'))).toMatchObject({
      status: 'cancelled',
      cancelled_at: '17000',
      cancel_reason: '历史版本未记录撤销原因（不可恢复）',
    });
    expect(await redis.hgetall(keys.hash.task('legacy-cancel-with-reason'))).toMatchObject({
      cancel_reason: '原始原因必须保留',
    });
  });

  it('resolution cancel 在当前 child 仍 active 时安全拒绝，不产生 cancelled root + pending child 矛盾', async () => {
    await seedTask('cancel-active-root');
    await redis.zrem(keys.zset.status.pending, 'cancel-active-root');
    await redis.zadd(keys.zset.status.failed, Date.now(), 'cancel-active-root');
    await redis.hset(keys.hash.task('cancel-active-root'), {
      status: 'failed',
      resolution_status: 'needs_pm_decision',
      resolution_action: 'inspect',
      resolution_generation: '1',
      resolution_attempts: '1',
      resolution_task_id: 'cancel-active-root-repair-1',
      resolution_task_ids: 'cancel-active-root-repair-1',
      resolution_decision_reason: 'repair_retry_limit_reached',
    });
    await seedTask('cancel-active-root-repair-1', {
      fix_for: 'cancel-active-root',
      repair_root_task_id: 'cancel-active-root',
    });

    const cancelled = await resolutionDecision(redis, 'cancel-active-root', {
      action: 'cancel', decided_by: 'pm-autonomous',
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: 'RESOLUTION_CHILD_ACTIVE' },
    });
    expect(await redis.hget(keys.hash.task('cancel-active-root'), 'resolution_status')).toBe('needs_pm_decision');
    expect(await redis.hget(keys.hash.task('cancel-active-root-repair-1'), 'status')).toBe('pending');
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
