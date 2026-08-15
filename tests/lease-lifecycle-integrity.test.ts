/**
 * 租约、ownership 与 report 的并发完整性回归。
 *
 * 使用独立 Redis DB 11：这些用例刻意并发调用同一个 service Redis client，验证不会因
 * Redis WATCH 的连接级语义而让第二个状态转换穿透第一个状态转换。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  getTask,
  ownershipDeclare,
  renewLease,
  planSubmit,
  report,
  setSqliteStore,
  taskBlock,
} from '../src/server/service.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import {
  activateOwnership,
  lazyReclaim,
  releaseOwnershipByAgent,
  writePlanToRedis,
  writeTaskToRedis,
} from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.LEASE_LIFECYCLE_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/11';
const PROJECT_PATH = '/tmp/biao-lease-lifecycle';
const FIXTURES = join(import.meta.dirname, 'fixtures');

let redis: Redis;

async function seedPlan(planId = 'lease-lifecycle-plan') {
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: planId,
    project_path: PROJECT_PATH,
    default_priority: 5,
    phases: [{ id: 'impl', name: '实现' }],
  }, 0);
}

async function seedTask(
  taskId: string,
  options: {
    assignee?: string;
    priority?: number;
    timeoutSeconds?: number;
    ownershipFiles?: string[];
  } = {},
) {
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: options.assignee ?? 'auto',
    priority: options.priority ?? 5,
    timeout_seconds: options.timeoutSeconds ?? 60,
    ownership: { files: options.ownershipFiles ?? [], modules: [] },
    verify: [],
  }, `# ${taskId}`, 'lease-lifecycle-plan', PROJECT_PATH, 5);
}

async function registerAndClaim(agentId: string, preferredProject = PROJECT_PATH) {
  await agentRegister(redis, agentId, 'cli', ['code'], undefined, [preferredProject]);
  const claimed = await claim(redis, {
    agent_id: agentId,
    blocking: false,
    preferred_project: preferredProject,
  });
  expect(claimed.ok).toBe(true);
  expect(claimed.data).not.toBeNull();
  return claimed.data!;
}

function eventCount(taskId: string, type: string) {
  return redis.xrange(keys.stream.events, '-', '+').then((raw) => raw.filter(([, fields]) => {
    const values = Object.fromEntries(fields.reduce<string[][]>((pairs, value, index) => {
      if (index % 2 === 0) pairs.push([value, fields[index + 1]]);
      return pairs;
    }, []));
    return values.task_id === taskId && values.type === type;
  }).length);
}

function taskDispatchCount(taskId: string) {
  return redis.xrange(keys.stream.tasks, '-', '+').then((raw) => raw.filter(([, fields]) => {
    const values = Object.fromEntries(fields.reduce<string[][]>((pairs, value, index) => {
      if (index % 2 === 0) pairs.push([value, fields[index + 1]]);
      return pairs;
    }, []));
    return values.task_id === taskId;
  }).length);
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
  await seedPlan();
});

afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
  setSqliteStore(null);
});

describe('lease / ownership / report integrity', () => {
  it('同一共享 Redis client 并发声明重叠 ownership 时只能有一个赢家', async () => {
    const [first, second] = await Promise.all([
      activateOwnership(redis, 'owner-a', 'task-a', 5, ['src/race/**'], 60, '', false),
      activateOwnership(redis, 'owner-b', 'task-b', 5, ['src/race/**'], 60, '', false),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const owner = JSON.parse((await redis.hget(keys.hash.fileOwnership, 'src/race/**'))!);
    expect(['owner-a', 'owner-b']).toContain(owner.agent_id);
  });

  it('同一个 claim token 并发 report 时只允许一个终态提交和一条完成事件', async () => {
    await seedTask('report-race', { assignee: 'reporter' });
    const task = await registerAndClaim('reporter');
    expect(task.task_id).toBe('report-race');

    const [first, second] = await Promise.all([
      report(redis, { task_id: task.task_id, agent_id: 'reporter', claim_token: task.claim_token, status: 'done' }),
      report(redis, { task_id: task.task_id, agent_id: 'reporter', claim_token: task.claim_token, status: 'done' }),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect((await getTask(redis, task.task_id)).data?.status).toBe('done');
    expect(await eventCount(task.task_id, 'task_completed')).toBe(1);
  });

  it('续租会同步延长当前任务的 ownership 过期时间', async () => {
    const glob = 'src/renew-lock/**';
    await seedTask('renew-owner', { assignee: 'renew-agent', timeoutSeconds: 60, ownershipFiles: [glob] });
    const task = await registerAndClaim('renew-agent');
    expect((await ownershipDeclare(redis, 'renew-agent', task.task_id, task.claim_token, [glob], true)).ok).toBe(true);
    const before = JSON.parse((await redis.hget(keys.hash.fileOwnership, glob))!);

    const renewed = await renewLease(redis, {
      task_id: task.task_id,
      claim_token: task.claim_token,
      extend_seconds: 120,
    });

    expect(renewed.ok).toBe(true);
    const after = JSON.parse((await redis.hget(keys.hash.fileOwnership, glob))!);
    expect(after.expires_at).toBe(renewed.data!.new_expire_at);
    expect(after.expires_at).toBeGreaterThan(before.expires_at);
  });

  it('释放一个 task 的 ownership 不会删除同 agent 其余 task 的反向索引', async () => {
    expect(await activateOwnership(redis, 'multi-owner', 'task-one', 5, ['src/task-one/**'], 60, '', false)).toBe(true);
    expect(await activateOwnership(redis, 'multi-owner', 'task-two', 5, ['src/task-two/**'], 60, '', false)).toBe(true);

    await releaseOwnershipByAgent(redis, 'multi-owner', 'task-one');

    expect(await redis.hget(keys.hash.fileOwnership, 'src/task-one/**')).toBeNull();
    expect(await redis.hget(keys.hash.fileOwnership, 'src/task-two/**')).not.toBeNull();
    expect(await redis.smembers(keys.set.ownerByAgent('multi-owner'))).toEqual(['src/task-two/**']);
  });

  it('旧 agent 释放同一 task 时不能删掉后来接手者的 ownership', async () => {
    const glob = 'src/reassigned/**';
    expect(await activateOwnership(redis, 'old-owner', 'handoff-task', 5, [glob], 60, '', false)).toBe(true);
    // 模拟旧 release 已取得反向索引、但此 task 在它写回前已由新 agent 重新持有。
    // 反向索引故意保留 old-owner，以覆盖延迟释放的最危险交错。
    await redis.hset(keys.hash.fileOwnership, glob, JSON.stringify({
      agent_id: 'new-owner', task_id: 'handoff-task', priority: 5,
      declared_at: Date.now(), expires_at: Date.now() + 60_000, base_commit_sha: '', mode: 'exclusive-write',
    }));
    await redis.sadd(keys.set.ownerByAgent('new-owner'), glob);

    await releaseOwnershipByAgent(redis, 'old-owner', 'handoff-task');

    expect(JSON.parse((await redis.hget(keys.hash.fileOwnership, glob))!)).toMatchObject({ agent_id: 'new-owner', task_id: 'handoff-task' });
    expect(await redis.sismember(keys.set.ownerByAgent('old-owner'), glob)).toBe(0);
    expect(await redis.sismember(keys.set.ownerByAgent('new-owner'), glob)).toBe(1);
  });

  it('两个客户端并发回收同一失效 lease 时只重试一次并只重新入队一次', async () => {
    await seedTask('reclaim-race', { assignee: 'expired-owner' });
    const task = await registerAndClaim('expired-owner');
    expect(task.task_id).toBe('reclaim-race');
    const beforeDispatches = await taskDispatchCount(task.task_id);

    await redis.del(keys.string.lease(task.task_id));
    await redis.zadd(keys.zset.status.running, 1, task.task_id);
    const [first, second] = await Promise.all([lazyReclaim(redis), lazyReclaim(redis)]);

    expect(first + second).toBe(1);
    const recovered = await redis.hgetall(keys.hash.task(task.task_id));
    expect(recovered).toMatchObject({ status: 'pending', retries: '1', claimed_by: '', expire_at: '' });
    expect(await taskDispatchCount(task.task_id)).toBe(beforeDispatches + 1);
  });

  it('过期 running 索引的旧快照不能覆盖已完成或等待 PM 答复的 task', async () => {
    await seedTask('stale-done', { assignee: 'done-owner' });
    const completed = await registerAndClaim('done-owner');
    await redis.del(keys.string.lease(completed.task_id));
    await redis.zadd(keys.zset.status.running, 1, completed.task_id);
    await redis.hset(keys.hash.task(completed.task_id), 'status', 'done');

    await seedTask('stale-question', { assignee: 'question-owner' });
    const waiting = await registerAndClaim('question-owner');
    await redis.del(keys.string.lease(waiting.task_id));
    await redis.zadd(keys.zset.status.running, 1, waiting.task_id);
    await redis.hset(keys.hash.task(waiting.task_id), 'status', 'blocked', 'block_reason', 'waiting_pm_reply');
    await redis.zadd(keys.zset.status.blocked, Date.now(), waiting.task_id);

    expect(await lazyReclaim(redis)).toBe(0);
    expect((await getTask(redis, completed.task_id)).data?.status).toBe('done');
    expect(await redis.hget(keys.hash.task(waiting.task_id), 'status')).toBe('blocked');
    expect(await redis.hget(keys.hash.task(waiting.task_id), 'block_reason')).toBe('waiting_pm_reply');
  });

  it('claim 懒回收后会同步 SQLite，避免灾难恢复带回旧 running 状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-reclaim-sqlite-'));
    const store = new SqliteStore(join(dir, 'biao.sqlite'));
    try {
      setSqliteStore(store);
      expect((await planSubmit(redis, join(FIXTURES, 'test-plan'))).ok).toBe(true);
      const owner = await registerAndClaim('sqlite-reclaim-owner', '/tmp/biao-test');
      const before = store.getAllTasks().find((task) => task.task_id === owner.task_id);
      expect(before).toMatchObject({ status: 'running', claimed_by: 'sqlite-reclaim-owner' });

      await redis.del(keys.string.lease(owner.task_id));
      await redis.zadd(keys.zset.status.running, 1, owner.task_id);
      await agentRegister(redis, 'sqlite-reclaimer', 'cli', ['code'], undefined, ['/tmp/no-match']);
      expect((await claim(redis, {
        agent_id: 'sqlite-reclaimer', blocking: false, preferred_project: '/tmp/no-match',
      })).data).toBeNull();

      expect(store.getAllTasks().find((task) => task.task_id === owner.task_id)).toMatchObject({
        status: 'pending', claimed_by: '', claimed_at: '', expire_at: '', retries: 1,
      });
    } finally {
      setSqliteStore(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claim 回收失效 lease 后会把等待该文件释放的任务恢复并只写一次 task_ready', async () => {
    const glob = 'src/reclaim-lock/**';
    await seedTask('reclaim-owner', { assignee: 'owner-agent', priority: 9, ownershipFiles: [glob] });
    await seedTask('reclaim-waiter', {
      assignee: 'waiter-agent',
      priority: 5,
      ownershipFiles: [glob],
    });

    const waiter = await registerAndClaim('waiter-agent');
    expect(waiter.task_id).toBe('reclaim-waiter');
    const owner = await registerAndClaim('owner-agent');
    expect(owner.task_id).toBe('reclaim-owner');
    expect((await ownershipDeclare(redis, 'owner-agent', owner.task_id, owner.claim_token, [glob], true)).ok).toBe(true);
    expect((await taskBlock(redis, waiter.task_id, 'waiter-agent', {
      claim_token: waiter.claim_token,
      reason: 'waiting_file_release',
    })).ok).toBe(true);

    // 以一个没有匹配任务的 agent 触发 claim 内的 lazy reclaim，避免它重新领走 owner。
    await redis.del(keys.string.lease(owner.task_id));
    await redis.zadd(keys.zset.status.running, 1, owner.task_id);
    await agentRegister(redis, 'reclaimer', 'cli', ['code'], undefined, ['/tmp/no-match']);
    const reclaimAttempt = await claim(redis, {
      agent_id: 'reclaimer',
      blocking: false,
      preferred_project: '/tmp/no-match',
    });
    expect(reclaimAttempt.data).toBeNull();

    expect((await getTask(redis, waiter.task_id)).data?.status).toBe('pending');
    expect(await eventCount(waiter.task_id, 'task_ready')).toBe(1);
  });
});
