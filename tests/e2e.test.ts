/**
 * 测试 3：端到端 claim/report（M0 核心）
 * 对应 docs/biao/06-dispatch-protocol.md
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { planSubmit, claim, report, agentRegister, getStatus, getTask, pmReview } from '../src/server/service.js';
import { lazyReclaim } from '../src/redis/ownership.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 测试用 DB 1（生产是 DB 0），避免 beforeEach 清数据误伤生产（bpi-03）
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
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
  // 每个测试前清空 biao 数据
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

describe('plan submit', () => {
  it('提交正常 plan 成功', async () => {
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan'));
    expect(r.ok).toBe(true);
    expect(r.data?.task_count).toBe(3);
    expect(r.data?.plan_id).toBe('test-m0-plan');
  });

  it('提交循环 plan 被拒', async () => {
    const r = await planSubmit(redis, join(FIXTURES, 'cycle-plan'));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PLAN_CYCLE_DETECTED');
  });

  it('提交后 status 显示 pending', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    const s = await getStatus(redis);
    expect(s.data).toMatchObject({ tasks: { pending: 3, running: 0, done: 0, failed: 0 } });
  });
});

describe('claim + report 端到端', () => {
  beforeEach(async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);
  });

  it('agent 注册', async () => {
    const r = await agentRegister(redis, 'test-agent', 'mock', ['code']);
    expect(r.ok).toBe(true);
    expect(r.data?.agent_id).toBe('test-agent');
  });

  it('claim 拿到无依赖的任务（T01-be）', async () => {
    const r = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(r.ok).toBe(true);
    expect(r.data).not.toBeNull();
    // T01 无依赖，应被领
    expect(r.data?.task_id).toBe('test-m0-plan-01-be');
    expect(r.data?.claim_token).toMatch(/^tok_/);
    expect(r.data?.ownership_files).toContain('apps/server/**');
  });

  it('claim 后任务状态变 running', async () => {
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    const taskId = claimed.data!.task_id;
    const t = await getTask(redis, taskId);
    expect(t.data?.status).toBe('running');
    expect(t.data?.claimed_by).toBe('mock-1');
  });

  it('claim 依赖未满足的任务被跳过（T02-fe 依赖 T01-be 未完成）', async () => {
    // 先领 T01（不 report）
    await claim(redis, { agent_id: 'mock-1', blocking: false });
    // 再领应拿到 T03-qa? 不，T03 也依赖 T01。应返回 null（无更多可领）
    // 注意：T02/T03 都依赖 T01，T01 在 running，都不满足
    const r2 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(r2.data).toBeNull();
  });

  it('report 后任务状态变 done', async () => {
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    const artifacts = writeTaskArtifacts(claimed.data!.task_id, '# 执行结果\n\n- 状态：PASS ✅\n');
    const r = await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'mock-1',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect(r.ok).toBe(true);
    expect(r.data?.status).toBe('done');

    const t = await getTask(redis, claimed.data!.task_id);
    expect(t.data?.status).toBe('done');
  });

  it('report 释放所有权声明', async () => {
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(claimed.data?.ownership_files).toContain('apps/server/**');
    // 此时 apps/server/** 应被 mock-1 占用
    const beforeFile = await redis.hget('biao:v1:hash:file_ownership', 'apps/server/**');
    expect(beforeFile).not.toBeNull();

    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'mock-1',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    // report 后应释放
    const afterFile = await redis.hget('biao:v1:hash:file_ownership', 'apps/server/**');
    expect(afterFile).toBeNull();
  });

  it('错误的 claim_token report 被拒', async () => {
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    const r = await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'mock-1',
      claim_token: 'wrong_token',
      status: 'done',
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CLAIM_TOKEN_INVALID');
  });

  it('完整 DAG 流转：T01 → T02 → 独立 T03 验收 → PM review', async () => {
    // 1. 领 T01 并完成
    const t1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(t1.data?.task_id).toBe('test-m0-plan-01-be');
    const t1Report = await report(redis, {
      task_id: t1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect(t1Report.ok).toBe(true);

    // 2. 普通下游不只等 Worker done，还必须等 PM 接受 T01，避免未验收产物继续扩散。
    const t1Reviewed = await pmReview(redis, t1.data!.task_id, {
      verdict: 'accept',
      reviewed_by: 'pm-test',
      comment: 'T01 交付通过',
    });
    expect(t1Reviewed.ok).toBe(true);
    const t2 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(t2.data?.task_id).toBe('test-m0-plan-02-fe');
    const t2Report = await report(redis, {
      task_id: t2.data!.task_id,
      agent_id: 'mock-1',
      claim_token: t2.data!.claim_token,
      status: 'done',
    });
    expect(t2Report.ok).toBe(true);

    // 3. T03 必须由没有执行 T01/T02 的独立 agent 领取并给出验证证据。
    await agentRegister(redis, 'reviewer-1', 'mock', ['acceptance']);
    const t3 = await claim(redis, { agent_id: 'reviewer-1', blocking: false, preferred_types: ['acceptance'] });
    expect(t3.data?.task_id).toBe('test-m0-plan-03-qa');
    // 验收证据必须是当前项目 work/<task_id> 下的真实普通文件。
    const artifacts = writeTaskArtifacts(t3.data!.task_id, '# DAG 验收\n\n- T01: ✅\n- T02: ✅\n');
    const t3Report = await report(redis, {
      task_id: t3.data!.task_id,
      agent_id: 'reviewer-1',
      claim_token: t3.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
      verify_results: [{ cmd: 'DAG acceptance checklist', exit_code: 0, passed: true }],
    });
    expect(t3Report.ok).toBe(true);

    // 4. done 不是完成：T02/T03 仍必须再通过 PM review（T01 已作为 T02 前置验收）。
    for (const taskId of [t2.data!.task_id, t3.data!.task_id]) {
      const reviewed = await pmReview(redis, taskId, {
        verdict: 'accept',
        reviewed_by: 'pm-test',
        comment: '端到端验证通过',
      });
      expect(reviewed.ok).toBe(true);
    }

    const s = await getStatus(redis);
    expect(s.data?.tasks).toMatchObject({ pending: 0, running: 0, done: 3, failed: 0, blocked: 0, cancelled: 0 });
    expect(s.data?.reviews).toEqual({ pending: 0, accepted: 3, rejected: 0 });
    expect(s.data?.plans[0]?.status).toBe('completed');
  });
});

describe('惰性回收', () => {
  it('回收过期 running 任务', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    // 手动设一个短超时任务并 claim
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    const taskId = claimed.data!.task_id;

    // 把租约和 running score 都设到过去
    await redis.del(`biao:v1:string:lease:task:${taskId}`);
    await redis.zadd('biao:v1:zset:status:running', 1, taskId); // score=1（很久以前）

    const reclaimed = await lazyReclaim(redis);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const t = await getTask(redis, taskId);
    // 应回到 pending（重试次数 < max）或 failed
    expect(['pending', 'failed']).toContain(t.data?.status);
    expect(t.data?.retries).toBeGreaterThanOrEqual(1);
  });
});

describe('claim 竞态修复：同一 task 不能被两个 worker 同时 claim', () => {
  beforeEach(async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'worker-a', 'mock', ['code']);
    await agentRegister(redis, 'worker-b', 'mock', ['code']);
  });

  it('worker A claim 后，worker B 不能 claim 同一 task', async () => {
    // worker A 领取第一个任务
    const claimedA = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    expect(claimedA.ok).toBe(true);
    expect(claimedA.data).not.toBeNull();
    const taskIdA = claimedA.data!.task_id;
    const tokenA = claimedA.data!.claim_token;

    // 此时 task 状态应为 running
    const taskAfterA = await getTask(redis, taskIdA);
    expect(taskAfterA.data?.status).toBe('running');
    expect(taskAfterA.data?.claimed_by).toBe('worker-a');

    // worker B 尝试 claim：不应拿到 taskIdA（running 状态应被跳过）
    const claimedB = await claim(redis, { agent_id: 'worker-b', blocking: false, timeout_ms: 5000 });
    if (claimedB.data) {
      // B 可能领到别的 pending 任务，但不能是 A 已领的那个
      expect(claimedB.data.task_id).not.toBe(taskIdA);
    }
    // 如果 B 返回 null（没有其他任务了），也是正确的

    // 关键断言：task 仍属于 worker A，lease 里是 tokenA
    const taskFinal = await getTask(redis, taskIdA);
    expect(taskFinal.data?.claimed_by).toBe('worker-a');

    const leaseVal = await redis.get(`biao:v1:string:lease:task:${taskIdA}`);
    expect(leaseVal).toBe(tokenA);
  });

  it('worker A report 后，task done，其他 worker 也不会再领到它', async () => {
    const claimedA = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    const taskIdA = claimedA.data!.task_id;

    // A 完成
    await report(redis, {
      task_id: taskIdA,
      agent_id: 'worker-a',
      claim_token: claimedA.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    // B 不应领到已 done 的 task
    const claimedB = await claim(redis, { agent_id: 'worker-b', blocking: false, timeout_ms: 5000 });
    if (claimedB.data) {
      expect(claimedB.data.task_id).not.toBe(taskIdA);
    }
  });
});

describe('concurrent-claim-guard：一个 agent 不能同时 hold 两个 running task', () => {
  beforeEach(async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'worker-a', 'mock', ['code']);
  });

  it('worker A claim 后未 report，再次 claim 应返回 AGENT_BUSY', async () => {
    const c1 = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    expect(c1.ok).toBe(true);
    expect(c1.data).not.toBeNull();

    // 没_report_就再 claim → 应被拒
    const c2 = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    expect(c2.ok).toBe(false);
    expect(c2.error?.code).toBe('AGENT_BUSY');
  });

  it('worker A report done 后，可以 claim 新任务', async () => {
    const c1 = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    // report done 释放
    await report(redis, {
      task_id: c1.data!.task_id,
      agent_id: 'worker-a',
      claim_token: c1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    // 现在可以领新的
    const c2 = await claim(redis, { agent_id: 'worker-a', blocking: false, timeout_ms: 5000 });
    expect(c2.ok).toBe(true);
  });
});
