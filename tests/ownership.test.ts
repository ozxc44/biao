/**
 * 测试 2：所有权登记簿 + glob 匹配
 * 对应 docs/biao/07-ownership-registry.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import {
  globMatch,
  activateOwnership,
  releaseOwnershipByAgent,
  checkOwnership,
  logConflict,
} from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1'; // DB 1 测试隔离（bpi-03）
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL);
  // 清理测试数据
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
});

afterAll(async () => {
  // 兜底清理，避免测试数据污染运行中的 server
  const testKeys = await redis.keys('biao:v1:*');
  if (testKeys.length > 0) await redis.del(...testKeys);
  redis.disconnect();
});

describe('globMatch', () => {
  it('匹配 ** 通配', () => {
    expect(globMatch('apps/server/**', 'apps/server/auth.ts')).toBe(true);
    expect(globMatch('apps/server/**', 'apps/server/sub/dir/x.ts')).toBe(true);
    expect(globMatch('apps/server/**', 'apps/web/x.ts')).toBe(false);
  });

  it('匹配单 * 通配', () => {
    expect(globMatch('apps/*/*.ts', 'apps/server/x.ts')).toBe(true);
    expect(globMatch('apps/*/*.ts', 'apps/server/sub/x.ts')).toBe(false);
  });

  it('精确路径', () => {
    expect(globMatch('docs/arch.md', 'docs/arch.md')).toBe(true);
    expect(globMatch('docs/arch.md', 'docs/other.md')).toBe(false);
  });
});

describe('所有权声明与查询', () => {
  it('激活声明后查询显示占用', async () => {
    await activateOwnership(redis, 'codex-1', 'T1', 5, ['apps/server/**'], 1800, 'abc');
    const r = await checkOwnership(redis, 'apps/server/auth.ts', 'kimi-1', 3);
    expect(r.occupied).toBe(true);
    expect(r.owner?.agent_id).toBe('codex-1');
    expect(r.action).toBe('wait'); // kimi priority 3 < codex 5
  });

  it('自己占用的文件 action=proceed', async () => {
    const r = await checkOwnership(redis, 'apps/server/auth.ts', 'codex-1', 5);
    expect(r.occupied).toBe(true);
    expect(r.owner?.agent_id).toBe('codex-1');
    expect(r.action).toBe('proceed');
  });

  it('更高 priority 的 agent 可抢占', async () => {
    const r = await checkOwnership(redis, 'apps/server/auth.ts', 'mimo-1', 7);
    expect(r.action).toBe('preempt'); // mimo 7 > codex 5
  });

  it('释放后查询显示未占用', async () => {
    await releaseOwnershipByAgent(redis, 'codex-1', 'T1');
    const r = await checkOwnership(redis, 'apps/server/auth.ts', 'kimi-1', 5);
    expect(r.occupied).toBe(false);
    expect(r.action).toBe('proceed');
  });

  it('未占用的文件直接 proceed', async () => {
    const r = await checkOwnership(redis, 'some/random/path.ts', 'codex-1', 5);
    expect(r.occupied).toBe(false);
    expect(r.action).toBe('proceed');
  });
});

describe('冲突日志', () => {
  it('记录冲突条目', async () => {
    await logConflict(
      redis,
      'apps/conflict.ts',
      { agent_id: 'codex-1', task_id: 'T1', priority: 7 },
      { agent_id: 'kimi-1', task_id: 'T2', priority: 3 },
      'preempt',
    );
    const len = await redis.llen(keys.list.ownershipConflicts);
    expect(len).toBeGreaterThanOrEqual(1);
    const latest = await redis.lindex(keys.list.ownershipConflicts, 0);
    const parsed = JSON.parse(latest);
    expect(parsed.path).toBe('apps/conflict.ts');
    expect(parsed.action).toBe('preempt');
  });
});
