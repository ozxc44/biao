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
import { agentRegister, agentHeartbeat, getStatus } from '../src/server/service.js';
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

  it('在线计数不把历史 stale 注册算进去（hint 反映真实在线数）', async () => {
    await agentRegister(redis, 'stale-only', 'mock', ['code']);
    await redis.hset(keys.hash.agent('stale-only'), {
      last_heartbeat: String(Date.now() - STALE_THRESHOLD_MS - 60_000),
    });
    const status = await getStatus(redis);
    // 全是 stale → 等同于无在线 worker，应给出引导 hint
    expect(status.data!.hint).not.toBeNull();
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
