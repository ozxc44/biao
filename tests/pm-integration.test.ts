/**
 * 被动式 PM 集成测试：服务层语义 + Supervisor 协同
 * 覆盖（服务+协调器组合下的关键验收点）：
 *  - acceptance_ready 在依赖满足时产生；reset 后可再次产生（恢复监视）
 *  - 自我验收禁止（acceptance 不能分给原任务执行者）
 *  - 单项目闭环后暂停（PM Review 全 accepted → isClosed）
 *  - 多项目全部闭环后进程退出（Supervisor.allClosed）
 *  - 待 PM 签核时不得误停（有 review_requested 时项目非闭环）
 *  - acceptance_ready 由 PM consumer 路由，ack 后 unacked 清空
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  agentRegister,
  claim,
  report,
  planSubmit,
  planCreate,
  pmReview,
  getPlan,
  unackedEvents,
  ackEvent,
  pmIntake,
  taskReset,
  setSqliteStore,
} from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';
import { Supervisor, SupervisedProject, type SupervisorHooks } from '../src/worker/supervisor.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const FIXTURES = join(import.meta.dirname, 'fixtures');

let redis: Redis;
const tmpDirs: string[] = [];

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterEach(() => {
  setSqliteStore(null);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 读取事件流原始条目（按类型过滤） */
async function eventsByType(type: string): Promise<Array<Record<string, string>>> {
  const raw = (await redis.xrange(keys.stream.events, '-', '+')) as [string, string[]][];
  return raw
    .map(([, fields]) => {
      const kv: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) kv[fields[i]] = fields[i + 1];
      return kv;
    })
    .filter((e) => e.type === type);
}

async function claimAs(agentId: string, type = 'mock') {
  await agentRegister(redis, agentId, type, ['code', 'acceptance']);
  return claim(redis, { agent_id: agentId, blocking: false, timeout_ms: 50 });
}

function writeResult(projectPath: string, taskId: string, content: string): string {
  const taskDir = join(projectPath, 'work', taskId);
  mkdirSync(taskDir, { recursive: true });
  tmpDirs.push(taskDir);
  const resultPath = join(taskDir, 'result.md');
  writeFileSync(resultPath, content);
  return resultPath;
}

describe('acceptance_ready 恢复与自我验收禁止', () => {
  it('reset 依赖任务后，acceptance_ready 可再次产生（恢复监视）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    // 完成 T01 + T02，使 T03 acceptance 就绪
    const c1 = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c1.data!.task_id, agent_id: 'w1', claim_token: c1.data!.claim_token,
      status: 'done', verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    await pmReview(redis, c1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });
    const c2 = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c2.data!.task_id, agent_id: 'w1', claim_token: c2.data!.claim_token,
      status: 'done',
    });
    expect((await eventsByType('acceptance_ready')).length).toBe(1);

    // reset T01（force，因已 done）→ 清除 acceptance_ready 去重标记
    await taskReset(redis, c1.data!.task_id, { force: true, reset_by: 'pm' });
    // 再完成 T01 → 依赖再次满足 → 应再产生一次 acceptance_ready
    const c1b = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    expect(c1b.data?.task_id).toBe(c1.data!.task_id);
    await report(redis, {
      task_id: c1b.data!.task_id, agent_id: 'w1', claim_token: c1b.data!.claim_token,
      status: 'done', verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect((await eventsByType('acceptance_ready')).length).toBe(2);
  });

  it('acceptance 在 claim 阶段拒绝原任务执行者，只允许独立 reviewer 领取', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    // w1 完成实现任务 T01
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c1 = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    expect(c1.data?.task_id).toBe('test-m0-plan-01-be');
    await report(redis, {
      task_id: c1.data!.task_id, agent_id: 'w1', claim_token: c1.data!.claim_token,
      status: 'done', verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    await pmReview(redis, c1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm' });
    // 完成另一实现任务，使 acceptance 就绪
    await agentRegister(redis, 'w2', 'mock', ['code']);
    const c2 = await claim(redis, { agent_id: 'w2', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c2.data!.task_id, agent_id: 'w2', claim_token: c2.data!.claim_token,
      status: 'done',
    });
    // T03 acceptance_for 含 T01：w1 在 claim 阶段就不能拿走验收，避免把自验收风险交给 report 才发现。
    const selfClaim = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    expect(selfClaim).toMatchObject({ ok: true, data: null });

    await agentRegister(redis, 'reviewer', 'mock', ['acceptance']);
    const c3 = await claim(redis, { agent_id: 'reviewer', blocking: false, timeout_ms: 50 });
    expect(c3.data?.task_id).toBe('test-m0-plan-03-qa');
    const plan = await getPlan(redis, 'test-m0-plan');
    const resultPath = writeResult(
      plan.data.project_path,
      'test-m0-plan-03-qa',
      '# 验收\n\n- 结论：✅ PASS\n',
    );
    const res = await report(redis, {
      task_id: 'test-m0-plan-03-qa', agent_id: 'reviewer', claim_token: c3.data!.claim_token,
      status: 'done', result_path: resultPath,
      verify_results: [{ cmd: 'manual', exit_code: 0, passed: true }],
    });
    expect(res.ok).toBe(true);
  });
});

describe('项目闭环生命周期', () => {
  it('单项目闭环：全部 done + PM accepted 后 isClosed 判定成立', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'biao-close-'));
    tmpDirs.push(projectDir);
    await planCreate(redis, { plan_id: 'close-plan', project_path: projectDir, pm_consumer: 'pm-close' });

    // 实现 + 验收 全部完成
    const impl = await claimAs('impl-w');
    await report(redis, {
      task_id: impl.data!.task_id, agent_id: 'impl-w', claim_token: impl.data!.claim_token,
      status: 'done',
    });
    const resultPath = writeResult(projectDir, 'close-plan-02-qa', '# 验收\n\n- PASS ✅\n');
    const acc = await claimAs('acc-w');
    await report(redis, {
      task_id: acc.data!.task_id, agent_id: 'acc-w', claim_token: acc.data!.claim_token,
      status: 'done', result_path: resultPath,
      verify_results: [{ cmd: "printf 'PASS: acceptance evidence recorded\\n'", exit_code: 0, passed: true }],
    });

    // PM Review 全部 accept → 项目 completed
    await pmReview(redis, 'close-plan-01-impl', { verdict: 'accept', reviewed_by: 'pm' });
    await pmReview(redis, 'close-plan-02-qa', { verdict: 'accept', reviewed_by: 'pm' });
    const plan = await getPlan(redis, 'close-plan');
    expect(plan.data.status).toBe('completed');
  });

  it('待 PM 签核时项目不闭环（不得误停）', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'biao-reviewing-'));
    tmpDirs.push(projectDir);
    await planCreate(redis, { plan_id: 'rev-plan', project_path: projectDir });
    const impl = await claimAs('impl-w2');
    await report(redis, {
      task_id: impl.data!.task_id, agent_id: 'impl-w2', claim_token: impl.data!.claim_token,
      status: 'done',
    });
    // done 但未 review → 项目 active，intake 有 review_requested
    const plan = await getPlan(redis, 'rev-plan');
    expect(plan.data.status).toBe('active');
    const intake = await pmIntake(redis, { consumer: 'pm' });
    expect(intake.data!.items.some((i) => i.kind === 'review_requested')).toBe(true);
  });
});

describe('Supervisor 多项目协同', () => {
  function makeHooks(): { hooks: SupervisorHooks; remindCount: () => number } {
    let n = 0;
    const hooks: SupervisorHooks = {
      async onPmReminder() { n++; },
    };
    return { hooks, remindCount: () => n };
  }

  it('多项目全部闭环后 Supervisor 自动退出（allClosed）', async () => {
    const { hooks } = makeHooks();
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [
        new SupervisedProject({ planId: 'a', isClosed: async () => true }),
        new SupervisedProject({ planId: 'b', isClosed: async () => true }),
      ],
      hooks,
      pollIntervalMs: 5,
    });
    await sup.runOnce();
    expect(sup.allClosed()).toBe(true);
  });

  it('单项目闭环只移除该项目，其余继续提醒', async () => {
    const { hooks, remindCount } = makeHooks();
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [
        new SupervisedProject({
          planId: 'open',
          isClosed: async () => false,
          pendingItems: async () => [{ kind: 'review_requested', plan_id: 'open', task_id: 't1', event_id: 'e1' }],
        }),
        new SupervisedProject({ planId: 'closed', isClosed: async () => true }),
      ],
      hooks,
      pollIntervalMs: 5,
    });
    await sup.runOnce();
    expect(remindCount()).toBe(1); // 只提醒 open 项目
    expect(sup.activeProjects().map((p) => p.planId)).toEqual(['open']);
  });
});

describe('consumer ack 闭环（intake → 处理 → ack）', () => {
  it('PM 用 intake/unacked 取事项 → ack 后 unacked 清空', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'w1', 'mock', ['code']);
    const c = await claim(redis, { agent_id: 'w1', blocking: false, timeout_ms: 50 });
    await report(redis, {
      task_id: c.data!.task_id, agent_id: 'w1', claim_token: c.data!.claim_token,
      status: 'done', verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    const owner = (await eventsByType('review_requested'))[0].consumer;
    // intake 拿到事项
    const before = await pmIntake(redis, { consumer: owner });
    const evId = before.data!.items.find((i) => i.kind === 'review_requested')!.event_id!;
    expect(evId).toBeTruthy();
    // 处理后 ack
    await ackEvent(redis, { consumer: owner, event_id: evId });
    // unacked 清空
    const unacked = await unackedEvents(redis, { consumer: owner });
    expect(unacked.data!.filter((e) => e.type === 'review_requested')).toHaveLength(0);
  });
});
