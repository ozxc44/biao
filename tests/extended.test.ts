/**
 * 测试 4：新增功能（getPlan / 修复任务自动生成 / acceptance 闭环）
 * 对应 05 号 md 接口 10 + 06 号 md step 8
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { planSubmit, claim, report, agentRegister, getPlan, getTask, getStatus, pmReview } from '../src/server/service.js';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1'; // DB 1 测试隔离（bpi-03）
let redis: Redis;
const FIXTURES = join(import.meta.dirname, 'fixtures');
const PROJECT_PATH = '/tmp/biao-test';

function writeTaskArtifacts(taskId: string, markdown: string) {
  const resultDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  const resultJsonPath = join(resultDir, 'result.json');
  writeFileSync(resultPath, markdown);
  writeFileSync(resultJsonPath, JSON.stringify({ task_id: taskId, status: 'done' }));
  return { resultPath, resultJsonPath };
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
  redis.disconnect();
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
});

beforeEach(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

describe('getPlan', () => {
  it('返回 plan 详情 + 任务分组', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    const r = await getPlan(redis, 'test-m0-plan');
    expect(r.ok).toBe(true);
    expect(r.data).not.toBeNull();
    expect(r.data).toMatchObject({
      plan_id: 'test-m0-plan',
      title: 'M0 测试规划',
      task_count: 3,
    });
    expect(r.data.tasks.pending).toHaveLength(3);
    expect(r.data.tasks.done).toHaveLength(0);
  });

  it('不存在的 plan 返回 null', async () => {
    const r = await getPlan(redis, 'nonexistent-plan');
    expect(r.ok).toBe(true);
    expect(r.data).toBeNull();
  });

  it('任务完成后 tasks 分组正确更新', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    const t1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: t1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    const r = await getPlan(redis, 'test-m0-plan');
    expect(r.data.tasks.done.map((t: { task_id: string }) => t.task_id)).toContain('test-m0-plan-01-be');
    expect(r.data.tasks.pending).toHaveLength(2);
  });
});

describe('acceptance 失败自动生成修复任务', () => {
  it('acceptance 报失败 + verify 失败时生成修复任务', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);
    await agentRegister(redis, 'reviewer-1', 'mock', ['acceptance']);

    // 完成 T01, T02（T01 先 PM accepted，普通 T02 才可领；acceptance 只需来源 done）
    const t1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: t1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect((await pmReview(redis, t1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm-test' })).ok).toBe(true);
    const t2 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: t2.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t2.data!.claim_token,
      status: 'done',
    });

    // 领 T03（acceptance）并报失败 + verify 失败
    const t3 = await claim(redis, { agent_id: 'reviewer-1', blocking: false });
    expect(t3.data?.task_id).toBe('test-m0-plan-03-qa');
    expect(t3.data?.type).toBe('acceptance');

    const r = await report(redis, {
      task_id: t3.data!.task_id,
      agent_id: 'reviewer-1',
      claim_token: t3.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'npm test', exit_code: 1, passed: false }],
    });

    expect(r.ok).toBe(true);
    expect(r.data?.fix_tasks_generated).toBeDefined();
    expect(r.data?.fix_tasks_generated).toHaveLength(2); // T01-fix + T02-fix

    // 修复任务应继承原任务 ownership，priority+1
    const fixId = r.data!.fix_tasks_generated![0];
    const fixTask = await getTask(redis, fixId);
    expect(fixTask.data).not.toBeNull();
    expect(fixTask.data?.type).toBe('code');
    expect(fixTask.data?.priority).toBe(6); // 原 priority 5 + 1
    expect(fixTask.data?.ownership?.files).toContain('apps/server/**');
    expect(fixTask.data?.depends_on).toEqual([]);
    expect(fixTask.data?.fix_for).toBe('test-m0-plan-01-be');
  });

  it('acceptance 成功时不生成修复任务', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);
    await agentRegister(redis, 'reviewer-1', 'mock', ['acceptance']);

    const t1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: t1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect((await pmReview(redis, t1.data!.task_id, { verdict: 'accept', reviewed_by: 'pm-test' })).ok).toBe(true);
    const t2 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: t2.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t2.data!.claim_token,
      status: 'done',
    });

    const t3 = await claim(redis, { agent_id: 'reviewer-1', blocking: false });
    const artifacts = writeTaskArtifacts(t3.data!.task_id, '# 验收\n\n- 实现任务：✅ PASS\n');
    const r = await report(redis, {
      task_id: t3.data!.task_id,
      agent_id: 'reviewer-1',
      claim_token: t3.data!.claim_token,
      status: 'done', // 成功
      verify_results: [{ cmd: 'npm test', exit_code: 0, passed: true }],
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
    });

    expect(r.ok).toBe(true);
    expect(r.data?.fix_tasks_generated).toBeUndefined();

    // status 应为 done:3，无新增
    const s = await getStatus(redis);
    expect(s.data).toMatchObject({ tasks: { done: 3, pending: 0 } });
  });

  it('普通任务失败也生成独立 repair，原 failed 审计不被 reset 覆盖', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    const t1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    const r = await report(redis, {
      task_id: t1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t1.data!.claim_token,
      status: 'failed',
      verify_results: [{ cmd: 'npm test', exit_code: 1, passed: false }],
    });

    expect(r.ok).toBe(true);
    expect(r.data?.resolution).toMatchObject({
      source_task_id: 'test-m0-plan-01-be',
      repair_task_id: 'test-m0-plan-01-be-repair-1',
      state: 'repairing',
    });
    expect((await getTask(redis, 'test-m0-plan-01-be')).data?.status).toBe('failed');
    expect((await getTask(redis, 'test-m0-plan-01-be-repair-1')).data).toMatchObject({
      status: 'pending',
      fix_for: 'test-m0-plan-01-be',
      depends_on: [],
    });
  });
});

describe('所有权双重校验（kross 协议）', () => {
  it('force=true 抢占时记录冲突', async () => {
    const { activateOwnership, logConflict } = await import('../src/redis/ownership.js');
    const { keys } = await import('../src/redis/keys.js');
    // 先让 codex-1 占用
    await activateOwnership(redis, 'codex-1', 'T1', 5, ['apps/x/**'], 1800, '');
    // mimo-1 force 抢占（该用例验证底层 registry 的冲突审计，而非受 token 保护的
    // service 边界）。
    await activateOwnership(redis, 'mimo-1', 'T2', 7, ['apps/x/**'], 1800, '', true);

    // 应有冲突记录
    const conflicts = await redis.lrange(keys.list.ownershipConflicts, 0, -1);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(conflicts[0]);
    expect(latest.path).toBe('apps/x/**');
    expect(latest.winner.agent_id).toBe('mimo-1');
    expect(latest.loser.agent_id).toBe('codex-1');
    expect(latest.action).toBe('preempt');
  });
});
