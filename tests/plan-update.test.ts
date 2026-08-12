/**
 * 测试 7：plan submit 增量更新（pending 覆盖 / running 不动 / done 不动 / 新增加入）
 * 对应"修复 planSubmit：pending 自动覆盖"
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { planSubmit, claim, report, agentRegister, getTask, getStatus } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1'; // DB 1 测试隔离（bpi-03）
let redis: Redis;
const FIXTURES = join(import.meta.dirname, 'fixtures');
const temporaryPlans: string[] = [];

function makeAcceptancePlan(acceptanceForLine: string): string {
  const planDir = mkdtempSync(join(tmpdir(), 'biao-empty-acceptance-plan-'));
  temporaryPlans.push(planDir);
  const planId = `empty-acceptance-${temporaryPlans.length}`;
  mkdirSync(join(planDir, 'tasks'));
  writeFileSync(join(planDir, 'index.md'), `---
plan_id: ${planId}
title: 空验收来源应拒绝
project_path: /tmp/biao-empty-acceptance-project
phases:
  - id: impl
    name: 实现
  - id: qa
    name: 验收
---
`);
  writeFileSync(join(planDir, 'tasks', 'source.md'), `---
task_id: ${planId}-source
title: 来源任务
type: code
phase: impl
---
`);
  writeFileSync(join(planDir, 'tasks', 'acceptance.md'), `---
task_id: ${planId}-acceptance
title: 验收任务
type: acceptance
phase: qa
${acceptanceForLine}---
`);
  return planDir;
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
  redis.disconnect();
  for (const planDir of temporaryPlans) rmSync(planDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

describe('plan submit 增量更新', () => {
  it.each([
    ['缺失 acceptance_for', ''],
    ['空 acceptance_for', 'acceptance_for: []\n'],
  ])('拒绝 acceptance 任务%s，且不产生半提交', async (_label, acceptanceForLine) => {
    const planDir = makeAcceptancePlan(acceptanceForLine);
    const result = await planSubmit(redis, planDir);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PLAN_PARSE_ERROR' },
    });
    expect(result.error?.message).toContain('acceptance_for');
    expect(await redis.keys('biao:v1:hash:task:*')).toHaveLength(0);
  });

  it('首次提交：全部 created', async () => {
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan'));
    expect(r.ok).toBe(true);
    expect(r.data?.created).toBe(3);
    expect(r.data?.updated).toBe(0);
    expect(r.data?.task_count).toBe(3);
  });

  it('pending 任务被新 MD 覆盖', async () => {
    // 首次提交
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    // 读 T01 原始 priority（应为 5）
    const t1Before = await getTask(redis, 'test-m0-plan-01-be');
    expect(t1Before.data?.priority).toBe(5);
    expect(t1Before.data?.title).toBe('后端测试任务');

    // 用更新版 plan 重新提交（T01 priority 改 9，title 改"已更新"）
    const r2 = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));
    expect(r2.ok).toBe(true);
    expect(r2.data?.updated).toBeGreaterThanOrEqual(1); // T01 pending 被覆盖

    // 验证 T01 已被新 MD 覆盖
    const t1After = await getTask(redis, 'test-m0-plan-01-be');
    expect(t1After.data?.priority).toBe(9);
    expect(t1After.data?.title).toBe('后端测试任务（已更新）');
    expect(t1After.data?.goal_md).toContain('更新版内容');
  });

  it('running 任务不被覆盖', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    // claim T01 让它变 running
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    expect(claimed.data?.task_id).toBe('test-m0-plan-01-be');

    // 用更新版重新提交
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));
    expect(r.data?.skipped_running).toBe(1);

    // T01 应保持原版（priority 5，不是 9），因为 running 不动
    const t1 = await getTask(redis, 'test-m0-plan-01-be');
    expect(t1.data?.status).toBe('running');
    expect(t1.data?.priority).toBe(5); // 未被覆盖
  });

  it('done 任务不被覆盖', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    // 完成 T01
    const claimed = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: claimed.data!.task_id,
      agent_id: 'mock-1',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    // 用更新版重新提交
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));
    expect(r.data?.skipped_done).toBeGreaterThanOrEqual(1);

    // T01 保持 done + 原版
    const t1 = await getTask(redis, 'test-m0-plan-01-be');
    expect(t1.data?.status).toBe('done');
    expect(t1.data?.title).toBe('后端测试任务'); // 原版，未被覆盖
  });

  it('blocked 运行态与原始 MD 在重新 submit 时完整保留，不会复活为 pending', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    const taskId = 'test-m0-plan-01-be';
    const blockedAt = Date.now();
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.blocked, blockedAt, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'blocked',
      block_reason: 'waiting_dependency',
      blocked_at: String(blockedAt),
      blocked_question_id: '',
    });
    const before = await redis.hgetall(keys.hash.task(taskId));

    const result = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));

    expect(result).toMatchObject({ ok: true, data: { skipped_blocked: 1 } });
    expect(await redis.hgetall(keys.hash.task(taskId))).toEqual(before);
    expect(await redis.zscore(keys.zset.status.blocked, taskId)).not.toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, taskId)).toBeNull();
  });

  it('cancelled 运行态与审计在重新 submit 时完整保留，不会被本地 MD 复活', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    const taskId = 'test-m0-plan-01-be';
    const cancelledAt = Date.now();
    await redis.zrem(keys.zset.status.pending, taskId);
    await redis.zadd(keys.zset.status.cancelled, cancelledAt, taskId);
    await redis.hset(keys.hash.task(taskId), {
      status: 'cancelled',
      cancelled_at: String(cancelledAt),
    });
    const before = await redis.hgetall(keys.hash.task(taskId));

    const result = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));

    expect(result).toMatchObject({ ok: true, data: { skipped_cancelled: 1 } });
    expect(await redis.hgetall(keys.hash.task(taskId))).toEqual(before);
    expect(await redis.zscore(keys.zset.status.cancelled, taskId)).not.toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, taskId)).toBeNull();
  });

  it('新增任务自动入队', async () => {
    // 首次提交（3 任务）
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    let s = await getStatus(redis);
    expect(s.data).toMatchObject({ tasks: { pending: 3 } });

    // 用 v2（含新增 T04）重新提交
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));
    expect(r.data?.created).toBeGreaterThanOrEqual(1); // T04 新增

    // T04 应存在且 pending
    const t4 = await getTask(redis, 'test-m0-plan-04-new');
    expect(t4.data).not.toBeNull();
    expect(t4.data?.status).toBe('pending');
    expect(t4.data?.title).toBe('新增任务');
  });

  it('返回更新统计（created/updated/skipped）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'mock-1', 'mock', ['code']);

    // 完成 T01（变 done）
    const c1 = await claim(redis, { agent_id: 'mock-1', blocking: false });
    await report(redis, {
      task_id: c1.data!.task_id,
      agent_id: 'mock-1',
      claim_token: c1.data!.claim_token,
      status: 'done',
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    // v2 重新提交：T01 skipped_done（1），T04 created（1）
    const r = await planSubmit(redis, join(FIXTURES, 'test-plan-v2'));
    expect(r.ok).toBe(true);
    expect(r.data?.skipped_done).toBeGreaterThanOrEqual(1); // T01 done
    expect(r.data?.created).toBeGreaterThanOrEqual(1); // T04 新增
    // 统计字段都存在
    expect(typeof r.data?.created).toBe('number');
    expect(typeof r.data?.updated).toBe('number');
    expect(typeof r.data?.skipped_running).toBe('number');
    expect(typeof r.data?.skipped_done).toBe('number');
  });
});
