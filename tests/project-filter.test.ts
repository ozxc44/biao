/**
 * 测试 6：项目过滤（preferred_project）
 * 对应主线 A
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { planSubmit, claim, agentRegister } from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { join } from 'node:path';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1'; // DB 1 测试隔离（bpi-03）
let redis: Redis;
const FIXTURES = join(import.meta.dirname, 'fixtures');

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
  redis.disconnect();
});

beforeEach(async () => {
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

describe('preferred_project 过滤', () => {
  it('提交两个不同项目的 plan', async () => {
    const r1 = await planSubmit(redis, join(FIXTURES, 'test-plan')); // project=/tmp/biao-test
    const r2 = await planSubmit(redis, join(FIXTURES, 'plan-other')); // project=/tmp/biao-other-project
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('不传 preferred_project 时领任意项目任务', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await planSubmit(redis, join(FIXTURES, 'plan-other'));
    await agentRegister(redis, 'me-1', 'cli', ['code']);

    const c = await claim(redis, { agent_id: 'me-1', blocking: false });
    expect(c.data).not.toBeNull();
    // 应该领到某个任务（两个项目都行）
    expect(c.data?.task_id).toBeDefined();
  });

  it('传 preferred_project 只领该项目的任务', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan')); // /tmp/biao-test
    await planSubmit(redis, join(FIXTURES, 'plan-other')); // /tmp/biao-other-project
    await agentRegister(redis, 'me-1', 'cli', ['code']);

    // 只领 /tmp/biao-other-project 的任务
    const c = await claim(redis, { agent_id: 'me-1', blocking: false, preferred_project: '/tmp/biao-other-project' });
    expect(c.data).not.toBeNull();
    expect(c.data?.task_id).toBe('test-other-01');
    expect(c.data?.project_path).toBe('/tmp/biao-other-project');
  });

  it('传 preferred_project 领该项目所有任务后返回 null', async () => {
    await planSubmit(redis, join(FIXTURES, 'plan-other')); // 只有 1 个任务
    await agentRegister(redis, 'me-1', 'cli', ['code']);

    const c1 = await claim(redis, { agent_id: 'me-1', blocking: false, preferred_project: '/tmp/biao-other-project' });
    expect(c1.data?.task_id).toBe('test-other-01');

    // 再领应返回 null（该项目无更多任务）
    const c2 = await claim(redis, { agent_id: 'me-1', blocking: false, preferred_project: '/tmp/biao-other-project' });
    expect(c2.data).toBeNull();
  });

  it('preferred_plan_ids 在同一项目内也只领取指定 plan', async () => {
    const projectPath = '/tmp/biao-shared-plan-project';
    await writePlanToRedis(redis, {
      plan_id: 'allowed-plan',
      title: 'allowed plan',
      project_path: projectPath,
      default_priority: 1,
    }, 1);
    await writePlanToRedis(redis, {
      plan_id: 'other-plan',
      title: 'other plan',
      project_path: projectPath,
      default_priority: 10,
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'allowed-task', title: 'allowed task', type: 'code', phase: 'impl', priority: 1,
      timeout_seconds: 60, verify: [],
    }, '# allowed', 'allowed-plan', projectPath, 1);
    await writeTaskToRedis(redis, {
      // 优先级更高，若服务端忽略 plan 条件会先被领取，能覆盖同 project 串领回归。
      task_id: 'other-task', title: 'other task', type: 'code', phase: 'impl', priority: 10,
      timeout_seconds: 60, verify: [],
    }, '# other', 'other-plan', projectPath, 10);
    await agentRegister(redis, 'me-plan-filter', 'cli', ['code']);

    const c = await claim(redis, {
      agent_id: 'me-plan-filter',
      blocking: false,
      preferred_project: projectPath,
      preferred_plan_ids: ['allowed-plan'],
    });

    expect(c.data?.task_id).toBe('allowed-task');
    expect(c.data?.plan_id).toBe('allowed-plan');
  });
});

describe('共享消费者组：过滤不匹配的消息对其他 worker 仍可见（claim-filter-starvation 修复）', () => {
  beforeEach(async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan')); // project=/tmp/biao-test
    await planSubmit(redis, join(FIXTURES, 'plan-other')); // project=/tmp/biao-other-project
    await agentRegister(redis, 'worker-a', 'cli', ['code']);
    await agentRegister(redis, 'worker-b', 'cli', ['code']);
  });

  it('worker A 只领 P1 任务后，P2 任务对 worker B 仍可见', async () => {
    // worker A 只领 /tmp/biao-test，会过滤掉 /tmp/biao-other-project 的消息
    // 修复前：过滤的消息被 XACK 销毁，worker B 永远领不到 P2
    // 修复后：过滤的消息重入流，worker B 仍能领
    const claimedA = await claim(redis, { agent_id: 'worker-a', blocking: false, preferred_project: '/tmp/biao-test' });
    expect(claimedA.data).not.toBeNull();
    expect(claimedA.data?.project_path).toBe('/tmp/biao-test');

    // worker B 领 /tmp/biao-other-project 的任务——应能拿到（关键断言）
    const claimedB = await claim(redis, { agent_id: 'worker-b', blocking: false, preferred_project: '/tmp/biao-other-project' });
    expect(claimedB.data).not.toBeNull();
    expect(claimedB.data?.project_path).toBe('/tmp/biao-other-project');
  });

  it('一次 claim 不会把同一 task 重复重入流（去重）', async () => {
    // 多次 claim 触发过滤重入流，验证不会无限堆积（readded Set 去重）
    for (let i = 0; i < 5; i++) {
      await claim(redis, { agent_id: 'worker-a', blocking: false, preferred_project: '/tmp/biao-test' });
    }
    // stream 长度不应爆炸（重入流的去重生效）
    const streamLen = await redis.xlen('biao:v1:stream:tasks');
    expect(streamLen).toBeLessThan(50); // 原始任务数 + 少量重入流，不是 50 倍放大
  });
});
