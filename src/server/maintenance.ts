/**
 * 恢复维护屏障与 mutation permit（从 service.ts 抽出的内聚模块）。
 *
 * 三层协调：本进程未结算 writer 计数（beginLocalMutation）、Redis mutation permit
 * zset（跨进程 writer 登记）、restore lock/barrier（恢复独占）。所有检查-登记都在
 * Lua 原子单元内完成，不留 TOCTOU 窗口。service.ts 重新导出全部公开符号，
 * 历史导入路径不变。
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { keys } from '../redis/keys.js';

const MAINTENANCE_PERMIT_TTL_MS = 120_000;
const RESTORE_LOCK_TTL_MS = 300_000;
const MAINTENANCE_RENEW_INTERVAL_MS = 30_000;
let localMutationCount = 0;

export type MaintenanceGateErrorCode =
  | 'RESTORE_IN_PROGRESS'
  | 'RESTORE_FAILED'
  | 'RESTORE_WRITERS_ACTIVE'
  | 'RESTORE_ACTIVE_RUNTIME_STATE'
  | 'RESTORE_TARGET_NOT_EMPTY'
  | 'RESTORE_LEASE_LOST';

export type MaintenanceGateResult =
  | { ok: true; owner: string }
  | { ok: false; error: { code: MaintenanceGateErrorCode; message: string } };

export function enterLocalMutation(): () => void {
  localMutationCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    localMutationCount = Math.max(0, localMutationCount - 1);
  };
}

export function activeLocalMutationCount(): number {
  return localMutationCount;
}

export function beginLocalMutation(): () => void {
  return enterLocalMutation();
}

const ACQUIRE_MUTATION_PERMIT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local expires_at = now + tonumber(ARGV[1])
local owner = ARGV[2]

local lock_owner = redis.call('GET', KEYS[2])
local barrier = redis.call('GET', KEYS[3])
if barrier then
  local ok, decoded = pcall(cjson.decode, barrier)
  if ok and decoded['phase'] == 'restoring' and lock_owner and decoded['owner'] == lock_owner then
    return 'RESTORE_IN_PROGRESS'
  end
  return 'RESTORE_FAILED'
end
if lock_owner then
  return 'RESTORE_IN_PROGRESS'
end
redis.call('ZADD', KEYS[1], expires_at, owner)
return 'ACQUIRED'
`;

const READ_RESTORE_GATE = `
local lock_owner = redis.call('GET', KEYS[1])
local barrier = redis.call('GET', KEYS[2])
if barrier then
  local ok, decoded = pcall(cjson.decode, barrier)
  if ok and decoded['phase'] == 'restoring' and lock_owner and decoded['owner'] == lock_owner then
    return 'RESTORE_IN_PROGRESS'
  end
  return 'RESTORE_FAILED'
end
if lock_owner then return 'RESTORE_IN_PROGRESS' end
return 'OPEN'
`;

const ACQUIRE_RESTORE_LOCK = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local owner = ARGV[1]
local ttl = tonumber(ARGV[2])

if redis.call('EXISTS', KEYS[3]) == 1 then
  return 'RESTORE_FAILED'
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 'RESTORE_IN_PROGRESS'
end
-- permit 过期只能说明续期中断，不能证明旧 handler 已停止写。为了不让 restore 越过
-- 一个可能会晚到的 writer，这里必须等待 owner finally 显式 release。
if redis.call('ZCARD', KEYS[1]) > 0 then
  return 'RESTORE_WRITERS_ACTIVE'
end
if redis.call('SET', KEYS[2], owner, 'NX', 'PX', ttl) then
  return 'ACQUIRED'
end
return 'RESTORE_IN_PROGRESS'
`;

const RENEW_RESTORE_LOCK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

const RELEASE_RESTORE_LOCK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const RELEASE_RESTORE_BARRIER = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local ok, decoded = pcall(cjson.decode, value)
if not ok or decoded['owner'] ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export const MARK_RESTORE_BARRIER_FAILED = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local ok, decoded = pcall(cjson.decode, value)
if not ok or decoded['owner'] ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const RETRY_EMPTY_FAILED_RESTORE = `
local barrier = redis.call('GET', KEYS[3])
if not barrier then return 'NO_BARRIER' end
local ok, decoded = pcall(cjson.decode, barrier)
if not ok or decoded['phase'] ~= 'failed' then return 'RESTORE_FAILED' end
if redis.call('EXISTS', KEYS[2]) == 1 then return 'RESTORE_IN_PROGRESS' end
if redis.call('ZCARD', KEYS[1]) > 0 then return 'RESTORE_WRITERS_ACTIVE' end
if not redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then
  return 'RESTORE_IN_PROGRESS'
end
redis.call('DEL', KEYS[3])
return 'ACQUIRED'
`;

export function maintenanceGateError(code: MaintenanceGateErrorCode, message: string): Error & { code: MaintenanceGateErrorCode } {
  const error = new Error(message) as Error & { code: MaintenanceGateErrorCode };
  error.code = code;
  return error;
}

/**
 * 进入一个会改变 Redis/SQLite 状态的短请求。检查 restore 锁/屏障和登记
 * 当前 owner 必须在同一个 Redis Lua 原子单元内，不能留下 TOCTOU 窗口。
 * permit 只能由 owner 在 handler settle 后 finally 释放；过期 score 只用于诊断。
 */
export async function acquireMutationPermit(redis: Redis, owner = randomUUID()): Promise<MaintenanceGateResult> {
  const result = String(await redis.eval(
    ACQUIRE_MUTATION_PERMIT,
    3,
    keys.zset.maintenanceMutationPermits,
    keys.string.dbRestoreLock,
    keys.string.dbRestoreBarrier,
    String(MAINTENANCE_PERMIT_TTL_MS),
    owner,
  ));
  if (result === 'ACQUIRED') return { ok: true, owner };
  if (result === 'RESTORE_FAILED') {
    return {
      ok: false,
      error: { code: 'RESTORE_FAILED', message: '上一次数据库恢复失败或结果不确定，维护屏障仍然生效' },
    };
  }
  return {
    ok: false,
    error: { code: 'RESTORE_IN_PROGRESS', message: '数据库恢复进行中，暂不接受状态写入' },
  };
}

/** 普通读在返回 Redis 投影前后都检查，避免暴露失败恢复的半投影。 */
export async function getRestoreMaintenanceGate(
  redis: Redis,
): Promise<{ code: 'RESTORE_IN_PROGRESS' | 'RESTORE_FAILED'; message: string } | null> {
  const result = String(await redis.eval(
    READ_RESTORE_GATE,
    2,
    keys.string.dbRestoreLock,
    keys.string.dbRestoreBarrier,
  ));
  if (result === 'OPEN') return null;
  if (result === 'RESTORE_FAILED') {
    return {
      code: 'RESTORE_FAILED',
      message: '上一次数据库恢复失败或结果不确定，维护屏障仍然生效',
    };
  }
  return { code: 'RESTORE_IN_PROGRESS', message: '数据库恢复进行中，暂不提供运行态投影' };
}

export async function releaseMutationPermit(redis: Redis, owner: string): Promise<void> {
  await redis.zrem(keys.zset.maintenanceMutationPermits, owner);
}

/**
 * 恢复入口使用一个 Lua 原子完成：确认无 writer → SET NX PX。
 * 返回 owner token 后，续期和释放都必须再次比较 owner，不能删除后来者的锁。
 */
export async function acquireRestoreLock(redis: Redis, owner = randomUUID()): Promise<MaintenanceGateResult> {
  // 产品部署边界是单 Biao server 实例。Redis 重启/FLUSH 可能把远端
  // permit 与业务键一起丢失，但同进程已入场 handler 仍在；本地计数防止
  // 它重连后与 restore 重叠。跨实例需持久 fencing，当前明确禁止。
  if (localMutationCount > 0) {
    return {
      ok: false,
      error: { code: 'RESTORE_WRITERS_ACTIVE', message: '当前 Biao 服务进程仍有未完成的状态写入，拒绝数据库恢复' },
    };
  }
  const result = String(await redis.eval(
    ACQUIRE_RESTORE_LOCK,
    3,
    keys.zset.maintenanceMutationPermits,
    keys.string.dbRestoreLock,
    keys.string.dbRestoreBarrier,
    owner,
    String(RESTORE_LOCK_TTL_MS),
  ));
  if (result === 'ACQUIRED') return { ok: true, owner };
  if (result === 'RESTORE_FAILED') {
    return {
      ok: false,
      error: { code: 'RESTORE_FAILED', message: '上一次数据库恢复失败或结果不确定，维护屏障仍然生效' },
    };
  }
  if (result === 'RESTORE_WRITERS_ACTIVE') {
    return {
      ok: false,
      error: { code: 'RESTORE_WRITERS_ACTIVE', message: 'Redis 当前有进行中的状态写入，拒绝数据库恢复' },
    };
  }
  return {
    ok: false,
    error: { code: 'RESTORE_IN_PROGRESS', message: '数据库恢复进行中，暂不接受状态写入' },
  };
}

export async function renewRestoreLock(redis: Redis, owner: string): Promise<boolean> {
  const renewed = Number(await redis.eval(
    RENEW_RESTORE_LOCK,
    1,
    keys.string.dbRestoreLock,
    owner,
    String(RESTORE_LOCK_TTL_MS),
  ));
  return renewed === 1;
}

export async function releaseRestoreLock(redis: Redis, owner: string): Promise<void> {
  await redis.eval(RELEASE_RESTORE_LOCK, 1, keys.string.dbRestoreLock, owner);
}

export async function releaseRestoreBarrier(redis: Redis, owner: string): Promise<void> {
  await redis.eval(RELEASE_RESTORE_BARRIER, 1, keys.string.dbRestoreBarrier, owner);
}

export async function retryEmptyFailedRestore(
  redis: Redis,
  owner: string,
): Promise<MaintenanceGateResult> {
  // barrier 存在时所有内建 writer 均 fail closed，所以扫描到空目标后，
  // Lua 内再一次校验 barrier/lock/permit 并原子地换成新 restore lock。
  if (!(await isBiaoNamespaceEmpty(redis))) {
    return {
      ok: false,
      error: { code: 'RESTORE_FAILED', message: '上一次恢复遗留了未完整 Redis 投影，拒绝自动清除屏障' },
    };
  }
  const result = String(await redis.eval(
    RETRY_EMPTY_FAILED_RESTORE,
    3,
    keys.zset.maintenanceMutationPermits,
    keys.string.dbRestoreLock,
    keys.string.dbRestoreBarrier,
    owner,
    String(RESTORE_LOCK_TTL_MS),
  ));
  if (result === 'ACQUIRED') return { ok: true, owner };
  if (result === 'RESTORE_WRITERS_ACTIVE') {
    return { ok: false, error: { code: 'RESTORE_WRITERS_ACTIVE', message: 'Redis 当前有进行中的状态写入，拒绝数据库恢复' } };
  }
  if (result === 'RESTORE_IN_PROGRESS') {
    return { ok: false, error: { code: 'RESTORE_IN_PROGRESS', message: '数据库恢复进行中，暂不接受状态写入' } };
  }
  return {
    ok: false,
    error: { code: 'RESTORE_FAILED', message: '上一次数据库恢复失败或结果不确定，维护屏障仍然生效' },
  };
}

export function startMaintenanceRenewal(renew: () => Promise<boolean>): MaintenanceRenewal {
  const state: MaintenanceRenewal['state'] = { lost: false };
  const timer = setInterval(() => {
    void renew().then((ok) => {
      if (!ok) state.lost = true;
    }).catch((error: Error) => {
      state.lost = true;
      state.error = error;
    });
  }, MAINTENANCE_RENEW_INTERVAL_MS);
  timer.unref();
  return { timer, state };
}

export async function isBiaoNamespaceEmpty(redis: Redis): Promise<boolean> {
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', 'biao:v1:*', 'COUNT', 100);
    cursor = next;
    const materialKeys = found.filter((key) =>
      key !== keys.string.dbRestoreLock &&
      key !== keys.string.dbRestoreBarrier &&
      key !== keys.zset.maintenanceMutationPermits,
    );
    if (materialKeys.length > 0) return false;
  } while (cursor !== '0');
  return true;
}

export interface MaintenanceRenewal {
  timer: NodeJS.Timeout;
  state: { lost: boolean; error?: Error };
}
