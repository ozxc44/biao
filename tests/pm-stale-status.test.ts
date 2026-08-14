/**
 * /status 的 Agent 在线语义按心跳租约派生测试
 * 覆盖：
 *  - 超过 stale 阈值的 agent 不再显示 idle/online，而显示 stale/offline
 *  - 不需要 watchdog 先写状态
 *  - 在线计数和 hint 不因历史注册记录误判
 *  - 原始登记信息可审计
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { agentRegister, agentHeartbeat, agentOffline, getStatus } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const STALE_THRESHOLD_MS = 5 * 60_000;

let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
});

describe('agent 在线状态按心跳租约派生', () => {
  it('心跳新鲜的 agent 显示 idle/busy，计入在线', async () => {
    await agentRegister(redis, 'fresh-agent', 'mock', ['code']);
    const status = await getStatus(redis);
    const agent = status.data!.agents.find((a) => a.agent_id === 'fresh-agent');
    expect(agent).toBeDefined();
    expect(['idle', 'busy']).toContain(agent!.status);
    // 无 stale/offline，hint 为 null（有 agent 在线）
    expect(status.data!.hint).toBeNull();
  });

  it('心跳超过阈值派生 stale，不显示 idle/online，无需 watchdog 写状态', async () => {
    await agentRegister(redis, 'stale-agent', 'mock', ['code']);
    // 直接把心跳拨到很久以前，模拟 worker 停止心跳
    await redis.hset(keys.hash.agent('stale-agent'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
      status: 'idle', // 历史登记的状态仍是 idle，但派生语义应是 stale
    });

    const status = await getStatus(redis);
    const agent = status.data!.agents.find((a) => a.agent_id === 'stale-agent');
    expect(agent).toBeDefined();
    expect(['stale', 'offline']).toContain(agent!.status);
    expect(['idle', 'busy', 'online']).not.toContain(agent!.status);
  });

  it('没有待领取任务时不因历史 stale Agent 提示启动 Worker', async () => {
    await agentRegister(redis, 'stale-only', 'mock', ['code']);
    await redis.hset(keys.hash.agent('stale-only'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    const status = await getStatus(redis);
    expect(status.data!.hint).toBeNull();
  });

  it('有待领取任务且没有在线 Worker 时才返回接入提示', async () => {
    await agentRegister(redis, 'stale-only', 'mock', ['code']);
    await redis.hset(keys.hash.agent('stale-only'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    await redis.hset(keys.hash.plan('active-plan'), {
      plan_id: 'active-plan',
      title: 'active plan',
      project_path: '/tmp/active-plan',
      task_count: '1',
      status: 'submitted',
      created_at: String(Date.now()),
    });
    await redis.hset(keys.hash.task('pending-task'), {
      task_id: 'pending-task',
      plan_id: 'active-plan',
      project_path: '/tmp/active-plan',
      status: 'pending',
      type: 'code',
      depends_on: '',
    });
    await redis.zadd(keys.zset.status.pending, Date.now(), 'pending-task');

    const status = await getStatus(redis);
    expect(status.data!.hint).not.toBeNull();
  });

  it('只把在线或仍持有 running task 的 stale Agent 放在当前组，其余折叠为历史', async () => {
    await agentRegister(redis, 'fresh-agent', 'mock', ['code']);
    for (const agentId of ['stale-idle', 'stale-terminal', 'stale-running']) {
      await agentRegister(redis, agentId, 'mock', ['code']);
      await redis.hset(keys.hash.agent(agentId), {
        last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
      });
    }
    await redis.hset(keys.hash.agent('stale-terminal'), { current_task: 'terminal-task' });
    await redis.hset(keys.hash.task('terminal-task'), { task_id: 'terminal-task', status: 'done' });
    await redis.hset(keys.hash.agent('stale-running'), { current_task: 'running-task' });
    await redis.hset(keys.hash.task('running-task'), { task_id: 'running-task', status: 'running' });

    const status = await getStatus(redis);
    expect(status.data!.agents).toHaveLength(4); // 旧字段保留全部注册历史
    expect(status.data!.agent_groups.current.map((agent: { agent_id: string }) => agent.agent_id).sort())
      .toEqual(['fresh-agent', 'stale-running']);
    expect(status.data!.agent_groups.history.map((agent: { agent_id: string }) => agent.agent_id).sort())
      .toEqual(['stale-idle', 'stale-terminal']);
    expect(status.data!.agents.find((agent: { agent_id: string }) => agent.agent_id === 'stale-terminal'))
      .toMatchObject({ current_task: 'terminal-task', current_task_status: 'done' });
    expect(status.data).toMatchObject({
      attention: { stale_running_agents: 1 },
      history: { stale_agents: 2 },
    });
  });

  it('Supervisor 停止时仍在执行的 Agent 保留 current_task 作异常可见投影', async () => {
    await agentRegister(redis, 'shutdown-running-agent', 'mock', ['code']);
    await redis.hset(keys.hash.task('shutdown-running-task'), {
      task_id: 'shutdown-running-task',
      plan_id: 'shutdown-plan',
      status: 'running',
      claimed_by: 'shutdown-running-agent',
    });
    await redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'shutdown-running-task');
    await redis.hset(keys.hash.agent('shutdown-running-agent'), {
      status: 'busy',
      current_task: 'shutdown-running-task',
    });

    await agentOffline(redis, 'shutdown-running-agent', 'supervisor_signal');

    expect(await redis.hgetall(keys.hash.agent('shutdown-running-agent'))).toMatchObject({
      status: 'offline',
      current_task: 'shutdown-running-task',
      last_task: 'shutdown-running-task',
      offline_reason: 'supervisor_signal',
    });
    const status = await getStatus(redis);
    expect(status.data!.agent_groups.current).toEqual([
      expect.objectContaining({
        agent_id: 'shutdown-running-agent',
        status: 'offline',
        current_task: 'shutdown-running-task',
        current_task_status: 'running',
      }),
    ]);
    expect(status.data).toMatchObject({ attention: { stale_running_agents: 1 } });
  });

  it('同名 Agent 新注册成 idle 时，仍把旧 running lease 计为当前异常', async () => {
    await agentRegister(redis, 'restarted-agent', 'mock', ['code']);
    await redis.hset(keys.hash.task('orphan-running-task'), {
      task_id: 'orphan-running-task', status: 'running', claimed_by: 'restarted-agent',
    });
    await redis.zadd(keys.zset.status.running, Date.now() + 60_000, 'orphan-running-task');
    await redis.set(keys.string.lease('orphan-running-task'), 'old-token', 'PX', 60_000);
    await redis.hset(keys.hash.agent('restarted-agent'), { status: 'idle', current_task: '' });

    const status = await getStatus(redis);

    expect(status.data).toMatchObject({ attention: { stale_running_agents: 1 } });
  });

  it('原始登记信息可审计（registered_at/last_heartbeat 保留）', async () => {
    await agentRegister(redis, 'audit-agent', 'mock', ['code']);
    await redis.hset(keys.hash.agent('audit-agent'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    const status = await getStatus(redis);
    const agent = status.data!.agents.find((a) => a.agent_id === 'audit-agent');
    expect(agent).toBeDefined();
    expect(agent!.last_heartbeat).toBeGreaterThan(0);
    // 审计：登记的时间戳不应丢失
    const raw = await redis.hgetall(keys.hash.agent('audit-agent'));
    expect(raw.registered_at).toBeTruthy();
  });

  it('阈值边界：阈值内仍算在线，明显超过算 stale', async () => {
    await agentRegister(redis, 'edge-agent', 'mock', ['code']);
    // 阈值内（留 5s 余量，避免getStatus调用期间时钟漂移误判）
    await redis.hset(keys.hash.agent('edge-agent'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS + 5000),
    });
    const s1 = await getStatus(redis);
    const a1 = s1.data!.agents.find((a) => a.agent_id === 'edge-agent')!;
    expect(['idle', 'busy']).toContain(a1.status);

    // 明显超过阈值
    await redis.hset(keys.hash.agent('edge-agent'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    const s2 = await getStatus(redis);
    const a2 = s2.data!.agents.find((a) => a.agent_id === 'edge-agent')!;
    expect(['stale', 'offline']).toContain(a2.status);
  });

  it('心跳更新后 stale agent 恢复为在线（租约可续）', async () => {
    await agentRegister(redis, 'recovery-agent', 'mock', ['code']);
    await redis.hset(keys.hash.agent('recovery-agent'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    const s1 = await getStatus(redis);
    expect(['stale', 'offline']).toContain(
      s1.data!.agents.find((a) => a.agent_id === 'recovery-agent')!.status,
    );
    // 重新心跳
    await agentHeartbeat(redis, 'recovery-agent');
    const s2 = await getStatus(redis);
    expect(['idle', 'busy']).toContain(
      s2.data!.agents.find((a) => a.agent_id === 'recovery-agent')!.status,
    );
  });
});
