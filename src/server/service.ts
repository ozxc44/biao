/**
 * Biao 核心服务：claim/report/plan submit 的业务逻辑
 * 对应 docs/biao/05-biao-service-spec.md, 06-dispatch-protocol.md
 */

import type Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keys, pendingScore, runningScore, DEFAULT_PM_CONSUMER, isValidConsumerName } from '../redis/keys.js';
import { SqliteStore, type TaskRow, type PlanRow } from '../db/sqlite-store.js';
import type {
  QuestionCreateRequest,
  QuestionAnswerRequest,
  QuestionRecord,
  QuestionSummary,
  QuestionStatus,
  RepairOwnershipExtension,
  ResolutionAction,
  ResolutionDecisionAction,
  ResolutionStatus,
  TaskStatus,
} from '../types/index.js';
import {
  parseWorkspaceRoots,
  readValidatedTaskArtifact,
  resolveAndValidateTaskArtifactPath,
  resolveAndValidateWorkspacePath,
} from './security.js';
import {
  QUESTION_ANSWER_MAX_CHARS,
  QUESTION_BODY_MAX_CHARS,
  QUESTION_CHECKPOINT_MAX_CHARS,
} from '../communication/question-context.js';

function configuredWorkspaceRoots(): string[] {
  return parseWorkspaceRoots(process.env.BIAO_WORKSPACE_ROOTS);
}

/** Agent 心跳 stale 阈值（与 watchdog 一致：超过 5 分钟视为失联）。
 *  /status 与 pmIntake 的 stale 派生共用此口径，避免双标。 */
export const STALE_AGENT_THRESHOLD_MS = 5 * 60_000;

/** 按心跳租约派生 agent 在线状态（/status 用）。
 *  超过阈值 → 'stale'（不显示 idle/online，无需 watchdog 先写）；否则保留登记状态。 */
function deriveAgentStatus(registeredStatus: string, lastHeartbeat: number, now: number): string {
  if (now - lastHeartbeat > STALE_AGENT_THRESHOLD_MS) {
    // 已显式置 offline 的维持 offline；其余历史 idle/busy 在心跳失联后派生为 stale
    return registeredStatus === 'offline' ? 'offline' : 'stale';
  }
  return registeredStatus;
}

function workspaceError(e: unknown, fallbackCode: string): { code: string; message: string } {
  const error = e as Error & { code?: string };
  return {
    code: error.code === 'WORKSPACE_PATH_DENIED' ? 'WORKSPACE_PATH_DENIED' : fallbackCode,
    message: error.message,
  };
}

/**
 * PM consumer 的兼容归一化。
 *
 * 旧 Redis hash / SQLite 迁移列会把“未声明”表示成缺失、null 或空字符串；三者都应
 * 路由到默认 PM，而不能让空串成为永远无人消费的 consumer。显式的合法 consumer
 * 原样保留，非法值也安全回退默认值。
 */
function normalizePmConsumer(raw: string | null | undefined): string {
  const consumer = (raw ?? '').trim();
  return consumer && isValidConsumerName(consumer) ? consumer : DEFAULT_PM_CONSUMER;
}

/** SQLite 持久化单例（由 main.ts 注入，service 函数双写用）。null = 未启用 */
let sqliteStore: SqliteStore | null = null;

/** 注入 SQLite store（main.ts 启动时调） */
export function setSqliteStore(store: SqliteStore | null): void {
  sqliteStore = store;
}

/** 获取当前 store（供 CLI 的 db status/restore 用） */
export function getSqliteStore(): SqliteStore | null {
  return sqliteStore;
}

async function persistTaskFromRedis(redis: Redis, taskId: string): Promise<void> {
  if (!sqliteStore) return;
  const h = await redis.hgetall(keys.hash.task(taskId));
  if (!h.task_id) return;
  const nowIso = new Date().toISOString();
  sqliteStore.upsertTask({
    task_id: h.task_id,
    plan_id: h.plan_id,
    title: h.title ?? '',
    type: h.type ?? 'code',
    phase: h.phase ?? 'impl',
    status: h.status ?? 'pending',
    priority: Number(h.priority ?? 5),
    assignee: h.assignee ?? 'auto',
    ownership_files: h.ownership_files ?? '',
    ownership_modules: h.ownership_modules ?? '',
    depends_on: h.depends_on ?? '',
    timeout_seconds: Number(h.timeout_seconds ?? 3600),
    max_retries: Number(h.max_retries ?? 2),
    model_override: h.model_override ?? '',
    acceptance_for: h.acceptance_for ?? '',
    verify: h.verify ?? '[]',
    claimed_by: h.claimed_by ?? '',
    claimed_at: h.claimed_at ?? '',
    expire_at: h.expire_at ?? '',
    result_path: h.result_path ?? '',
    result_json_path: h.result_json_path ?? '',
    done_at: h.done_at ?? '',
    retries: Number(h.retries ?? 0),
    pm_review_status: h.pm_review_status ?? '',
    pm_reviewed_by: h.pm_reviewed_by ?? '',
    pm_reviewed_at: h.pm_reviewed_at ?? '',
    pm_review_comment: h.pm_review_comment ?? '',
    pm_reject_reason: h.pm_reject_reason ?? '',
    pm_fix_instructions: h.pm_fix_instructions ?? '',
    pm_rejection_resolution_mode: h.pm_rejection_resolution_mode ?? '',
    repair_ownership_extension: h.repair_ownership_extension ?? '',
    failure_reason: h.failed_reason ?? '',
    fix_for: h.fix_for ?? '',
    repair_root_task_id: h.repair_root_task_id ?? '',
    resolution_status: h.resolution_status ?? '',
    resolution_action: h.resolution_action ?? '',
    resolution_task_id: h.resolution_task_id ?? '',
    resolution_task_ids: h.resolution_task_ids ?? '',
    resolved_by_task: h.resolved_by_task ?? '',
    resolution_generation: Number(h.resolution_generation ?? 0),
    resolution_attempts: Number(h.resolution_attempts ?? 0),
    resolution_decision_reason: h.resolution_decision_reason ?? '',
    blocked_at: h.blocked_at ?? '',
    block_reason: h.block_reason ?? '',
    blocked_question_id: h.blocked_question_id ?? '',
    blocked_lease_remaining: h.blocked_lease_remaining ?? '',
    last_question_id: h.last_question_id ?? '',
    last_question_answer: h.last_question_answer ?? '',
    cancelled_at: h.cancelled_at ?? '',
    superseded_at: h.superseded_at ?? '',
    superseded_by: h.superseded_by ?? '',
    superseded_reason: h.superseded_reason ?? '',
    supersede_preview_token: h.supersede_preview_token ?? '',
    supersede_batch_size: Number(h.supersede_batch_size ?? 0),
    verify_results: h.verify_results ?? '[]',
    goal_md: h.goal_md ?? '',
    created_at: h.created_at ?? nowIso,
    updated_at: nowIso,
  });
}

export interface DbMaintenanceStatus {
  state: 'idle' | 'restoring' | 'failed';
  restore_lock: boolean;
  barrier_phase: string;
  barrier_error_code: string;
  barrier_message: string;
  writer_permit_count: number;
  expired_permit_count: number;
  recovery_hint: string;
}

/** SQLite 状态（对应 biao db status）—— task/plan 计数 + restore 诊断。 */
export async function getDbStatus(redis: Redis): Promise<ApiResponse<{
  task_count: number;
  plan_count: number;
  by_status: Record<string, number>;
  maintenance: DbMaintenanceStatus;
} | null>> {
  if (!sqliteStore) {
    return { ok: false, data: null, error: { code: 'SQLITE_NOT_ENABLED', message: 'SQLite 持久化未启用' } };
  }
  const [gate, lockValue, barrierValue, permitRows, redisClock] = await Promise.all([
    getRestoreMaintenanceGate(redis),
    redis.get(keys.string.dbRestoreLock),
    redis.get(keys.string.dbRestoreBarrier),
    redis.zrange(keys.zset.maintenanceMutationPermits, 0, -1, 'WITHSCORES'),
    redis.time(),
  ]);
  const redisNow = Number(redisClock[0]) * 1_000 + Math.floor(Number(redisClock[1]) / 1_000);
  let expiredPermitCount = 0;
  for (let index = 1; index < permitRows.length; index += 2) {
    if (Number(permitRows[index]) <= redisNow) expiredPermitCount++;
  }
  let barrier: { phase?: unknown; error_code?: unknown; message?: unknown } = {};
  if (barrierValue) {
    try {
      barrier = JSON.parse(barrierValue) as typeof barrier;
    } catch {
      barrier = { phase: 'invalid', error_code: 'RESTORE_FAILED', message: '恢复屏障内容损坏' };
    }
  }
  const maintenanceState: DbMaintenanceStatus['state'] = gate?.code === 'RESTORE_FAILED'
    ? 'failed'
    : gate?.code === 'RESTORE_IN_PROGRESS'
      ? 'restoring'
      : 'idle';
  return {
    ok: true,
    data: {
      task_count: sqliteStore.getTaskCount(),
      plan_count: sqliteStore.getPlanCount(),
      by_status: sqliteStore.getTaskCountByStatus(),
      maintenance: {
        state: maintenanceState,
        restore_lock: Boolean(lockValue),
        barrier_phase: typeof barrier.phase === 'string' ? barrier.phase : '',
        barrier_error_code: typeof barrier.error_code === 'string' ? barrier.error_code : '',
        barrier_message: typeof barrier.message === 'string' ? barrier.message : '',
        writer_permit_count: Math.floor(permitRows.length / 2),
        expired_permit_count: expiredPermitCount,
        recovery_hint: maintenanceState === 'failed'
          ? '停止所有 Biao Supervisor/Worker；保留屏障，核实并清理未完整 Redis 投影后再重试 restore。'
          : expiredPermitCount > 0
            ? '过期 permit 仅表示续期中断，不证明 writer 已停止；先停止所有 Biao 进程再人工处置。'
            : '',
      },
    },
  };
}

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

function enterLocalMutation(): () => void {
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

const MARK_RESTORE_BARRIER_FAILED = `
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

function maintenanceGateError(code: MaintenanceGateErrorCode, message: string): Error & { code: MaintenanceGateErrorCode } {
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

async function releaseRestoreBarrier(redis: Redis, owner: string): Promise<void> {
  await redis.eval(RELEASE_RESTORE_BARRIER, 1, keys.string.dbRestoreBarrier, owner);
}

async function retryEmptyFailedRestore(
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

function startMaintenanceRenewal(renew: () => Promise<boolean>): MaintenanceRenewal {
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

async function activeTaskLeaseIds(redis: Redis): Promise<string[]> {
  const active: string[] = [];
  let cursor = '0';
  do {
    const [next, leaseKeys] = await redis.scan(cursor, 'MATCH', keys.pattern.taskLeases, 'COUNT', 100);
    cursor = next;
    if (leaseKeys.length === 0) continue;
    const pipeline = redis.pipeline();
    for (const leaseKey of leaseKeys) pipeline.pttl(leaseKey);
    const results = await pipeline.exec();
    for (let index = 0; index < leaseKeys.length; index++) {
      const [error, ttl] = results?.[index] ?? [new Error('missing PTTL result'), -1];
      if (!error && Number(ttl) > 0) active.push(leaseKeys[index]);
    }
  } while (cursor !== '0');
  return active;
}

async function activeOwnershipCount(redis: Redis): Promise<number> {
  const [seconds, microseconds] = await redis.time();
  const now = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  const ownership = await redis.hgetall(keys.hash.fileOwnership);
  let active = 0;
  for (const raw of Object.values(ownership)) {
    try {
      const record = JSON.parse(raw) as { expires_at?: number };
      if (Number(record.expires_at ?? 0) > now) active++;
    } catch {
      // 损坏记录无法证明已失效；恢复覆盖它会隐藏真实冲突，因此同样 fail closed。
      active++;
    }
  }
  return active;
}

async function assertRestoreRuntimeIdle(redis: Redis): Promise<void> {
  const [runningTaskIds, leaseIds, ownershipCount] = await Promise.all([
    redis.zrange(keys.zset.status.running, 0, -1),
    activeTaskLeaseIds(redis),
    activeOwnershipCount(redis),
  ]);
  if (runningTaskIds.length === 0 && leaseIds.length === 0 && ownershipCount === 0) return;
  throw maintenanceGateError(
    'RESTORE_ACTIVE_RUNTIME_STATE',
    `Redis 存在活跃运行态（running=${runningTaskIds.length}, lease=${leaseIds.length}, ownership=${ownershipCount}），拒绝数据库恢复`,
  );
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

async function assertRestoreTargetEmpty(redis: Redis): Promise<void> {
  if (await isBiaoNamespaceEmpty(redis)) return;
  throw maintenanceGateError(
    'RESTORE_TARGET_NOT_EMPTY',
    'Redis 的 Biao namespace 非空，拒绝覆盖现有状态',
  );
}

async function assertRestoreOwner(redis: Redis, owner: string): Promise<void> {
  if (await renewRestoreLock(redis, owner)) return;
  throw maintenanceGateError('RESTORE_LEASE_LOST', '数据库恢复锁已失效，恢复已中止');
}

async function withMutationPermit<T>(redis: Redis, mutate: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const leaveLocalMutation = enterLocalMutation();
  let permit: MaintenanceGateResult;
  try {
    permit = await acquireMutationPermit(redis);
  } catch (error) {
    leaveLocalMutation();
    throw error;
  }
  if (!permit.ok) {
    leaveLocalMutation();
    return { ok: false, data: null, error: permit.error };
  }
  try {
    return await mutate();
  } finally {
    try {
      await releaseMutationPermit(redis, permit.owner);
    } finally {
      leaveLocalMutation();
    }
  }
}

async function withMutationPermitOrThrow<T>(redis: Redis, mutate: () => Promise<T>): Promise<T> {
  const leaveLocalMutation = enterLocalMutation();
  let permit: MaintenanceGateResult;
  try {
    permit = await acquireMutationPermit(redis);
  } catch (error) {
    leaveLocalMutation();
    throw error;
  }
  if (!permit.ok) {
    leaveLocalMutation();
    throw maintenanceGateError(permit.error.code, permit.error.message);
  }
  try {
    return await mutate();
  } finally {
    try {
      await releaseMutationPermit(redis, permit.owner);
    } finally {
      leaveLocalMutation();
    }
  }
}

/** 手动触发恢复（对应 biao db restore）—— 仅在 Biao namespace 为空时重建 */
export async function dbRestoreManual(redis: Redis): Promise<ApiResponse<{ restored: number; by_status: Record<string, number> }>> {
  if (!sqliteStore) {
    return { ok: false, data: null, error: { code: 'SQLITE_NOT_ENABLED', message: 'SQLite 持久化未启用' } };
  }
  try {
    const r = await dbRestore(redis, sqliteStore);
    return { ok: true, data: { restored: r.restored, by_status: r.byStatus } };
  } catch (e) {
    const error = e as Error & { code?: string };
    if (error.code === 'RESTORE_IN_PROGRESS' || error.code === 'RESTORE_FAILED' || error.code === 'RESTORE_WRITERS_ACTIVE' ||
      error.code === 'RESTORE_ACTIVE_RUNTIME_STATE' || error.code === 'RESTORE_TARGET_NOT_EMPTY' ||
      error.code === 'RESTORE_LEASE_LOST') {
      return { ok: false, data: null, error: { code: error.code, message: error.message } };
    }
    throw e;
  }
}

/**
 * 旧 SQLite 同时存在 epoch 毫秒、epoch 秒和 ISO 8601 时间。恢复排序分值前
 * 必须归一为有限毫秒数；无法解析时返回 undefined，不让 NaN 进入 Redis ZSET。
 */
function parsePersistedTimestamp(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) return undefined;
    // 现实 epoch seconds 至少九位；更小的历史测试/相对毫秒（如 42000）原样保留。
    // 12 位以上视为 epoch milliseconds。
    const milliseconds = numeric >= 100_000_000 && numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  // 只接受 ISO 风格的持久化时间，不依赖平台特定的自然语言 Date.parse。
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function restoredPendingTimestamp(task: TaskRow, plan: PlanRow | undefined): number {
  for (const candidate of [task.created_at, task.updated_at, plan?.submitted_at, plan?.created_at]) {
    const parsed = parsePersistedTimestamp(candidate);
    if (parsed !== undefined) return parsed;
  }
  // 确定性地当作最旧任务：既不丢任务，也不用 Date.now() 让每次恢复改变排序。
  return 0;
}

function restoredPriority(task: TaskRow, plan: PlanRow | undefined): number {
  for (const candidate of [task.priority, plan?.default_priority, 5]) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 5;
}

function restoredTimestampString(value: string | number | null | undefined): string {
  const parsed = parsePersistedTimestamp(value);
  return parsed === undefined ? '' : String(parsed);
}

function restoredPlanCreatedAt(plan: PlanRow | undefined): number {
  if (!plan) return 0;
  return parsePersistedTimestamp(plan.created_at) ?? parsePersistedTimestamp(plan.submitted_at) ?? 0;
}

const RESTORABLE_TASK_STATUSES = new Set<TaskStatus>([
  'pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded',
]);

function invalidRestoredTaskStatus(task: TaskRow): Error & { code: string } {
  const error = new Error(`SQLite 任务 ${task.task_id} 包含未知 status=${task.status}；恢复已终止，Redis 未写入。`) as Error & { code: string };
  error.code = 'SQLITE_TASK_STATUS_INVALID';
  return error;
}

function invalidRestoredOpenQuestions(taskId: string): Error & { code: string } {
  const error = new Error(`SQLite 任务 ${taskId} 存在多条 open Question；恢复已终止，Redis 未写入。`) as Error & { code: string };
  error.code = 'SQLITE_OPEN_QUESTION_CONFLICT';
  return error;
}

function invalidRestoredQuestionState(message: string): Error & { code: string } {
  const error = new Error(`${message}；恢复已终止，Redis 未写入。`) as Error & { code: string };
  error.code = 'SQLITE_OPEN_QUESTION_STATE_INVALID';
  return error;
}

function invalidRestoredTaskScore(taskId: string): Error & { code: string } {
  const error = new Error(`SQLite 任务 ${taskId} 生成了非有限 Redis 排序分值；恢复已终止，Redis 未写入。`) as Error & { code: string };
  error.code = 'SQLITE_TASK_SCORE_INVALID';
  return error;
}

/**
 * 从 SQLite 恢复 Redis（Redis 空但 SQLite 有数据时调，对应 biao db restore）。
 *
 * 低层重建逻辑只能在全局 restore owner 锁内运行；锁续期和 finally 释放都使用 owner
 * 比较，异常退出不会遗留自己的锁，也不会误删 TTL 后由另一个恢复者取得的新锁。
 */
export async function dbRestore(redis: Redis, sqlite: SqliteStore): Promise<{ restored: number; byStatus: Record<string, number> }> {
  let lock = await acquireRestoreLock(redis);
  if (!lock.ok && lock.error.code === 'RESTORE_FAILED') {
    lock = await retryEmptyFailedRestore(redis, randomUUID());
  }
  if (!lock.ok) throw maintenanceGateError(lock.error.code, lock.error.message);
  let renewal: MaintenanceRenewal | undefined = startMaintenanceRenewal(() => renewRestoreLock(redis, lock.owner));
  let projection: RestoreProjection | undefined;
  let barrierOwned = false;
  try {
    await assertRestoreRuntimeIdle(redis);
    await assertRestoreTargetEmpty(redis);
    projection = prepareRestoreProjection(sqlite);
    // SQLite 规范化/全量读取期间锁一直续期；发布前再确认目标和 owner。随后停止自身
    // PEXPIRE，避免 WATCH 把正常续期误判为 owner 变化并中止事务。
    await assertRestoreTargetEmpty(redis);
    await assertRestoreOwner(redis, lock.owner);
    const barrierCreated = await redis.set(keys.string.dbRestoreBarrier, JSON.stringify({
      phase: 'restoring',
      owner: lock.owner,
      started_at: new Date().toISOString(),
    }), 'NX');
    if (barrierCreated !== 'OK') {
      throw maintenanceGateError('RESTORE_FAILED', '无法取得数据库恢复发布屏障');
    }
    barrierOwned = true;
    if (!(await renewRestoreLock(redis, lock.owner))) {
      throw maintenanceGateError('RESTORE_LEASE_LOST', '数据库恢复锁已失效，恢复已中止');
    }
    clearInterval(renewal.timer);
    renewal = undefined;
    const result = await publishRestoreProjection(redis, lock.owner, projection);
    await releaseRestoreBarrier(redis, lock.owner);
    barrierOwned = false;
    return result;
  } catch (error) {
    // Redis MULTI 的运行时单命令错误不会回滚已执行命令。只有当我们仍同时
    // 持有 lock + barrier 时，才能在屏障内删除本次已知 projection 并重新开门。
    // 任一清理/确认失败都保留 failed barrier，读写继续 fail closed。
    const cleaned = barrierOwned && projection
      ? await cleanupFailedRestoreProjection(redis, lock.owner, projection).catch(() => false)
      : false;
    if (cleaned) {
      barrierOwned = false;
    } else if (barrierOwned) {
      const failedBarrier = JSON.stringify({
        phase: 'failed',
        owner: lock.owner,
        failed_at: new Date().toISOString(),
        error_code: (error as { code?: string }).code ?? 'RESTORE_FAILED',
        message: (error as Error).message,
      });
      await redis.eval(
        MARK_RESTORE_BARRIER_FAILED,
        1,
        keys.string.dbRestoreBarrier,
        lock.owner,
        failedBarrier,
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (renewal) clearInterval(renewal.timer);
    await releaseRestoreLock(redis, lock.owner);
  }
}

function restoreProjectionMaterialKeys(projection: RestoreProjection): string[] {
  const material = new Set<string>([
    keys.stream.tasks,
    keys.stream.events,
    ...Object.values(keys.zset.status),
    keys.reviewRequested.pending,
  ]);
  for (const plan of projection.plans) material.add(keys.hash.plan(plan.plan_id));
  for (const task of projection.tasks) material.add(keys.hash.task(task.task_id));
  for (const question of projection.questions) {
    material.add(keys.hash.question(question.question_id));
    if ((question.status ?? 'open') === 'open') {
      material.add(keys.question.openByTask(question.task_id));
      material.add(keys.question.openMetaByTask(question.task_id));
    }
  }
  return [...material];
}

async function restoreBarrierOwnedBy(redis: Redis, owner: string): Promise<boolean> {
  const raw = await redis.get(keys.string.dbRestoreBarrier);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { owner?: unknown }).owner === owner;
  } catch {
    return false;
  }
}

async function cleanupFailedRestoreProjection(
  redis: Redis,
  owner: string,
  projection: RestoreProjection,
): Promise<boolean> {
  if (await redis.get(keys.string.dbRestoreLock) !== owner || !(await restoreBarrierOwnedBy(redis, owner))) return false;
  const materialKeys = restoreProjectionMaterialKeys(projection);
  for (let offset = 0; offset < materialKeys.length; offset += 500) {
    if (!(await renewRestoreLock(redis, owner)) || !(await restoreBarrierOwnedBy(redis, owner))) return false;
    await redis.del(...materialKeys.slice(offset, offset + 500));
  }
  if (!(await renewRestoreLock(redis, owner)) || !(await restoreBarrierOwnedBy(redis, owner))) return false;
  if (!(await isBiaoNamespaceEmpty(redis))) return false;
  await releaseRestoreBarrier(redis, owner);
  return (await redis.get(keys.string.dbRestoreBarrier)) === null;
}

interface RestoreProjection {
  tasks: TaskRow[];
  plans: PlanRow[];
  questions: ReturnType<SqliteStore['getAllQuestions']>;
  plansById: Map<string, PlanRow>;
  tasksById: Map<string, TaskRow>;
  pendingScoresByTaskId: Map<string, number>;
  byStatus: Record<string, number>;
}

interface MaintenanceRenewal {
  timer: NodeJS.Timeout;
  state: { lost: boolean; error?: Error };
}

function prepareRestoreProjection(sqlite: SqliteStore): RestoreProjection {
  // 这一步先于 Redis 发布且自身是 SQLite 单事务。若后续 Redis 失败，pending 是比
  // 复活旧 running 更安全、并且可直接重试的 durable 真相。
  sqlite.recoverRunningTasksForRestore();
  const tasks = sqlite.getAllTasks();
  const plans = sqlite.getAllPlans();
  const questions = sqlite.getAllQuestions();

  const invalidStatusTask = tasks.find((task) => !RESTORABLE_TASK_STATUSES.has(task.status as TaskStatus));
  if (invalidStatusTask) throw invalidRestoredTaskStatus(invalidStatusTask);

  const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
  const plansById = new Map(plans.map((plan) => [plan.plan_id, plan]));
  const openQuestionByTask = new Map<string, string>();
  for (const question of questions) {
    if ((question.status ?? 'open') !== 'open') continue;
    if (openQuestionByTask.has(question.task_id)) throw invalidRestoredOpenQuestions(question.task_id);
    openQuestionByTask.set(question.task_id, question.question_id);
    const task = tasksById.get(question.task_id);
    const plan = task ? plansById.get(task.plan_id) : undefined;
    const consistent = Boolean(task && plan) &&
      task!.status === 'blocked' &&
      task!.block_reason === 'waiting_pm_reply' &&
      task!.blocked_question_id === question.question_id &&
      question.plan_id === task!.plan_id &&
      normalizePmConsumer(question.pm_consumer) === normalizePmConsumer(plan!.pm_consumer);
    if (!consistent) {
      throw invalidRestoredQuestionState(`SQLite open Question ${question.question_id} 与 task/plan 等待状态不一致`);
    }
  }

  // 反向一致性：task 不能声称正在等 PM，却没有唯一、匹配的 open Question。
  for (const task of tasks) {
    const expectsOpenQuestion = task.block_reason === 'waiting_pm_reply' || Boolean(task.blocked_question_id);
    if (!expectsOpenQuestion) continue;
    const openQuestionId = openQuestionByTask.get(task.task_id) ?? '';
    if (task.status !== 'blocked' || task.block_reason !== 'waiting_pm_reply' ||
      !task.blocked_question_id || openQuestionId !== task.blocked_question_id) {
      throw invalidRestoredQuestionState(`SQLite 任务 ${task.task_id} 的 PM 等待指针没有对应的 open Question`);
    }
  }

  // MULTI 中的命令运行时失败不会回滚其它命令。因此所有可控 ZADD
  // 参数必须在设置 durable barrier 之前完成预计算和校验。
  const pendingScoresByTaskId = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    const plan = plansById.get(task.plan_id);
    const score = pendingScore(restoredPriority(task, plan), restoredPendingTimestamp(task, plan));
    if (!Number.isFinite(score)) throw invalidRestoredTaskScore(task.task_id);
    pendingScoresByTaskId.set(task.task_id, score);
  }

  const byStatus: Record<string, number> = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  return {
    tasks,
    plans,
    questions,
    plansById,
    tasksById,
    pendingScoresByTaskId,
    byStatus,
  };
}

async function publishRestoreProjection(
  redis: Redis,
  restoreOwner: string,
  projection: RestoreProjection,
): Promise<{ restored: number; byStatus: Record<string, number> }> {
  const { tasks, plans, questions, plansById, tasksById, pendingScoresByTaskId, byStatus } = projection;
  const [seconds, microseconds] = await redis.time();
  const now = Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  const transactionRedis = redis.duplicate();
  try {
    await transactionRedis.watch(keys.string.dbRestoreLock);
    if (await transactionRedis.get(keys.string.dbRestoreLock) !== restoreOwner) {
      throw maintenanceGateError('RESTORE_LEASE_LOST', '数据库恢复锁已失效，恢复已中止');
    }

    const transaction = transactionRedis.multi();
    for (const plan of plans) {
      transaction.hset(keys.hash.plan(plan.plan_id), {
        plan_id: plan.plan_id,
        title: plan.title ?? '',
        status: plan.status ?? 'submitted',
        project_path: plan.project_path ?? '',
        default_assignee: plan.default_assignee ?? 'auto',
        default_priority: String(plan.default_priority ?? 5),
        phases: plan.phases ?? '[]',
        task_count: String(plan.task_count ?? 0),
        created_at: String(restoredPlanCreatedAt(plan)),
        pm_consumer: normalizePmConsumer(plan.pm_consumer),
      });
    }

    for (const task of tasks) {
      const taskPlan = plansById.get(task.plan_id);
      const createdAt = restoredPendingTimestamp(task, taskPlan);
      const doneAt = parsePersistedTimestamp(task.done_at);
      const restoredStatus = task.status as TaskStatus;
      transaction.hset(keys.hash.task(task.task_id), {
        task_id: task.task_id,
        plan_id: task.plan_id,
        title: task.title ?? '',
        type: task.type ?? 'code',
        phase: task.phase ?? 'impl',
        assignee: task.assignee ?? 'auto',
        priority: String(task.priority ?? 5),
        status: restoredStatus,
        depends_on: task.depends_on ?? '',
        ownership_files: task.ownership_files ?? '',
        ownership_modules: task.ownership_modules ?? '',
        timeout_seconds: String(task.timeout_seconds ?? 3600),
        max_retries: String(task.max_retries ?? 2),
        retries: String(task.retries ?? 0),
        model_override: task.model_override ?? '',
        acceptance_for: task.acceptance_for ?? '',
        verify: task.verify ?? '[]',
        goal_md: task.goal_md ?? '',
        project_path: taskPlan?.project_path ?? '',
        created_at: String(createdAt),
        claimed_by: task.claimed_by ?? '',
        claimed_at: restoredTimestampString(task.claimed_at),
        done_at: doneAt === undefined ? '' : String(doneAt),
        expire_at: restoredTimestampString(task.expire_at),
        result_path: task.result_path ?? '',
        result_json_path: task.result_json_path ?? '',
        pm_review_status: task.pm_review_status ?? '',
        pm_reviewed_by: task.pm_reviewed_by ?? '',
        pm_reviewed_at: restoredTimestampString(task.pm_reviewed_at),
        pm_review_comment: task.pm_review_comment ?? '',
        pm_reject_reason: task.pm_reject_reason ?? '',
        pm_fix_instructions: task.pm_fix_instructions ?? '',
        pm_rejection_resolution_mode: task.pm_rejection_resolution_mode ?? '',
        repair_ownership_extension: task.repair_ownership_extension ?? '',
        failed_reason: task.failure_reason ?? '',
        fix_for: task.fix_for ?? '',
        repair_root_task_id: task.repair_root_task_id ?? '',
        resolution_status: task.resolution_status ?? '',
        resolution_action: task.resolution_action ?? '',
        resolution_task_id: task.resolution_task_id ?? '',
        resolution_task_ids: task.resolution_task_ids ?? '',
        resolved_by_task: task.resolved_by_task ?? '',
        resolution_generation: String(task.resolution_generation ?? 0),
        resolution_attempts: String(task.resolution_attempts ?? 0),
        resolution_decision_reason: task.resolution_decision_reason ?? '',
        blocked_at: restoredTimestampString(task.blocked_at),
        block_reason: task.block_reason ?? '',
        blocked_question_id: task.blocked_question_id ?? '',
        blocked_lease_remaining: task.blocked_lease_remaining ?? '',
        last_question_id: task.last_question_id ?? '',
        last_question_answer: task.last_question_answer ?? '',
        cancelled_at: restoredTimestampString(task.cancelled_at),
        superseded_at: restoredTimestampString(task.superseded_at),
        superseded_by: task.superseded_by ?? '',
        superseded_reason: task.superseded_reason ?? '',
        supersede_preview_token: task.supersede_preview_token ?? '',
        supersede_batch_size: String(task.supersede_batch_size ?? 0),
        verify_results: task.verify_results ?? '[]',
      });
      const statusKey = (keys.zset.status as Record<string, string>)[restoredStatus];
      const statusScore = restoredStatus === 'pending'
        ? pendingScoresByTaskId.get(task.task_id)!
        : restoredStatus === 'running'
          ? runningScore(parsePersistedTimestamp(task.expire_at) ?? 0)
          : now;
      transaction.zadd(statusKey, statusScore, task.task_id);
      if (restoredStatus === 'done' && !(task.pm_review_status ?? '').trim()) {
        transaction.zadd(keys.reviewRequested.pending, doneAt ?? createdAt, task.task_id);
      }
      if (restoredStatus === 'pending') {
        transaction.xadd(keys.stream.tasks, '*', 'task_id', task.task_id, 'priority', String(task.priority ?? 5));
      }
      if (restoredStatus === 'pending' && task.failure_reason === 'recovered_from_persisted_running') {
        transaction.xadd(
          keys.stream.events,
          '*',
          'event_id', `${now}_task_ready_${task.task_id}_restore`,
          'type', 'task_ready',
          'task_id', task.task_id,
          'plan_id', task.plan_id,
          'consumer', 'worker',
          'reason', 'recovered_from_persisted_running',
          'timestamp', String(now),
        );
      }
    }

    for (const question of questions) {
      const questionTask = tasksById.get(question.task_id);
      const questionPlan = plansById.get(question.plan_id) ??
        (questionTask ? plansById.get(questionTask.plan_id) : undefined);
      const createdAt = parsePersistedTimestamp(question.created_at) ??
        (questionTask ? restoredPendingTimestamp(questionTask, questionPlan) : restoredPlanCreatedAt(questionPlan));
      const questionStatus = question.status ?? 'open';
      transaction.hset(keys.hash.question(question.question_id), {
        question_id: question.question_id,
        task_id: question.task_id,
        plan_id: question.plan_id ?? '',
        agent_id: question.agent_id,
        pm_consumer: normalizePmConsumer(question.pm_consumer),
        asked_event_id: question.asked_event_id || `${createdAt}_question_asked_${question.question_id}`,
        body: question.body ?? '',
        checkpoint: question.checkpoint ?? '',
        status: questionStatus,
        created_at: String(createdAt),
        answered_at: restoredTimestampString(question.answered_at),
        answered_by: question.answered_by ?? '',
        answer: question.answer ?? '',
      });
      if (questionStatus === 'open') {
        transaction.set(keys.question.openByTask(question.task_id), question.question_id);
        transaction.hset(keys.question.openMetaByTask(question.task_id), {
          question_id: question.question_id,
          agent_id: question.agent_id,
          // 恢复后的旧 claim 永远无效；metadata 只保存定位/路由，不伪造 token。
          claim_token: '',
          pm_consumer: normalizePmConsumer(question.pm_consumer),
        });
        const askedEventId = question.asked_event_id || `${createdAt}_question_asked_${question.question_id}`;
        transaction.xadd(
          keys.stream.events,
          '*',
          'event_id', askedEventId,
          'type', 'question_asked',
          'task_id', question.task_id,
          'question_id', question.question_id,
          'plan_id', question.plan_id,
          'agent_id', question.agent_id,
          'consumer', normalizePmConsumer(question.pm_consumer),
          'acked', 'false',
          'timestamp', String(createdAt),
        );
      }
    }

    const results = await transaction.exec();
    if (results === null) {
      throw maintenanceGateError('RESTORE_LEASE_LOST', '数据库恢复锁已失效，恢复已中止');
    }
    const commandFailure = results.find(([error]) => error)?.[0];
    if (commandFailure) {
      const error = new Error(`Redis 原子恢复事务失败：${commandFailure.message}`) as Error & { code: string };
      error.code = 'RESTORE_REDIS_TRANSACTION_FAILED';
      throw error;
    }
    return { restored: tasks.length, byStatus };
  } finally {
    transactionRedis.disconnect();
  }
}
import {
  lazyReclaimTaskIds,
  writeTaskToRedis,
  writePlanToRedis,
  hashToTaskRecord,
  activateOwnership,
  releaseOwnershipByAgent,
  checkOwnership,
  globsOverlap,
  generateToken,
} from '../redis/ownership.js';
import { parsePlanDir, detectCycle, validateAcceptanceFor, validatePhases } from '../plan/parser.js';
import type {
  ClaimRequest,
  ClaimedTask,
  ReportRequest,
  ApiResponse,
  TaskRecord,
  OwnershipCheckResult,
} from '../types/index.js';

/** plan create：通过 API 生成 plan 骨架并立即提交（对应前端创建项目） */
export interface PlanCreateRequest {
  plan_id: string;
  title?: string;
  project_path: string;
  /** 生成到哪个目录（默认 <project_path>/plans/） */
  base_dir?: string;
  /** 是否立即提交到 Redis（默认 true） */
  submit?: boolean;
  /** 该 plan 的 PM consumer 标识（PM 主动轮询时按此路由提醒）；不传用默认值 pm */
  pm_consumer?: string;
}

export async function planCreate(
  redis: Redis,
  req: PlanCreateRequest,
): Promise<ApiResponse<{ plan_id: string; plan_dir: string; submitted: boolean; task_count?: number }>> {
  try {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    const planId = req.plan_id;
    const title = req.title ?? planId;
    // 校验 pm_consumer（安全可校验）；空值/非法值均回退默认。
    const pmConsumer = normalizePmConsumer(req.pm_consumer);
    const roots = configuredWorkspaceRoots();
    const projectPath = resolveAndValidateWorkspacePath(req.project_path, roots);
    const baseDir = resolveAndValidateWorkspacePath(req.base_dir ?? join(projectPath, 'plans'), roots);
    const planDir = resolveAndValidateWorkspacePath(resolve(join(baseDir, planId)), roots);

    if (existsSync(planDir)) {
      return {
        ok: false,
        data: null,
        error: { code: 'PLAN_EXISTS', message: `plan 目录已存在：${planDir}` },
      };
    }

    mkdirSync(join(planDir, 'tasks'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);

    // index.md
    writeFileSync(
      join(planDir, 'index.md'),
      `---
plan_id: ${planId}
title: ${title}
status: draft
created_at: ${today}
project_path: ${projectPath}
pm_consumer: ${pmConsumer}
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
    description: 实现阶段
  - id: qa
    name: 验收
    description: 验收阶段
    depends_on: [impl]
global_constraints:
  - 不修改 secrets / .env
---

# ${title}

## 背景与目标

<描述这个 plan 要达成什么>

## 任务清单

| task_id | 标题 | phase | assignee | depends_on | ownership | priority |
|---------|------|-------|----------|-----------|-----------|----------|
| ${planId}-01-impl | 实现任务 | impl | auto | — | src/** | 5 |
| ${planId}-02-qa | 验收 | qa | auto | [01-impl] | — | 7 |
`,
    );

    // 示例 tasks
    writeFileSync(
      join(planDir, `tasks/${planId}-01-impl.md`),
      `---
task_id: ${planId}-01-impl
title: 实现任务
type: code
phase: impl
assignee: auto
ownership:
  files:
    - src/**
priority: 5
timeout_seconds: 1800
verify: []
---

# 实现任务

## Objective

<描述任务目标>

## Required Work

1. ...

## Acceptance Criteria

- [ ] 实现符合目标
`,
    );

    writeFileSync(
      join(planDir, `tasks/${planId}-02-qa.md`),
      `---
task_id: ${planId}-02-qa
title: 验收
type: acceptance
phase: qa
depends_on:
  - ${planId}-01-impl
assignee: auto
priority: 7
acceptance_for:
  - ${planId}-01-impl
verify:
  - cmd: "printf 'PASS: acceptance evidence recorded\\\\n'"
    expect_exit: 0
---

# 验收

## Objective

验收实现任务。
`,
    );

    // 是否立即提交
    const shouldSubmit = req.submit !== false;
    let taskCount: number | undefined;
    if (shouldSubmit) {
      const submitRes = await planSubmit(redis, planDir);
      if (!submitRes.ok) {
        return {
          ok: false,
          data: null,
          error: submitRes.error ?? { code: 'PLAN_SUBMIT_FAILED', message: '提交失败' },
        };
      }
      taskCount = submitRes.data?.task_count;
    }

    return {
      ok: true,
      data: {
        plan_id: planId,
        plan_dir: planDir,
        submitted: shouldSubmit,
        task_count: taskCount,
      },
    };
  } catch (e) {
    return {
      ok: false,
      data: null,
      error: workspaceError(e, 'PLAN_CREATE_ERROR'),
    };
  }
}

/** plan submit */
export async function planSubmit(redis: Redis, planDir: string): Promise<ApiResponse<{
  plan_id: string;
  task_count: number;
  created: number;
  updated: number;
  skipped_running: number;
  skipped_done: number;
  skipped_blocked: number;
  skipped_cancelled: number;
  skipped_superseded: number;
}>> {
  try {
    const roots = configuredWorkspaceRoots();
    const validatedPlanDir = resolveAndValidateWorkspacePath(planDir, roots);
    const { plan, tasks } = parsePlanDir(validatedPlanDir);
    plan.project_path = resolveAndValidateWorkspacePath(plan.project_path, roots);
    // YAML 的空值会解析成空字符串/undefined；写入 Redis 和 SQLite 前统一落成默认 PM，
    // 使后续恢复、Question 与 review 事件使用同一条路由规则。
    plan.pm_consumer = normalizePmConsumer(plan.pm_consumer);

    // 校验
    const cycle = detectCycle(tasks.map((t) => t.fm));
    if (cycle) {
      return {
        ok: false,
        data: null,
        error: { code: 'PLAN_CYCLE_DETECTED', message: `DAG 有环，涉及任务：${cycle.join(', ')}` },
      };
    }
    validateAcceptanceFor(tasks.map((t) => t.fm));
    validatePhases(plan, tasks.map((t) => t.fm));

    // 所有 identity 冲突在首次写入之前预检，避免半提交覆盖其他项目。
    const existingPlan = await redis.hgetall(keys.hash.plan(plan.plan_id));
    if (
      existingPlan.plan_id &&
      existingPlan.project_path &&
      resolve(existingPlan.project_path) !== resolve(plan.project_path)
    ) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PLAN_ID_CONFLICT',
          message: `plan_id ${plan.plan_id} 已属于其他 project_path：${existingPlan.project_path}`,
        },
      };
    }
    const sqlitePlan = sqliteStore?.getAllPlans().find((row) => row.plan_id === plan.plan_id);
    if (sqlitePlan && resolve(sqlitePlan.project_path) !== resolve(plan.project_path)) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PLAN_ID_CONFLICT',
          message: `plan_id ${plan.plan_id} 已在 SQLite 中属于其他 project_path：${sqlitePlan.project_path}`,
        },
      };
    }
    const sqliteTasks = sqliteStore?.getAllTasks() ?? [];
    for (const { fm } of tasks) {
      const existingTaskPlanId = await redis.hget(keys.hash.task(fm.task_id), 'plan_id');
      const sqliteTask = sqliteTasks.find((row) => row.task_id === fm.task_id);
      const conflictingPlanId = existingTaskPlanId || sqliteTask?.plan_id;
      if (conflictingPlanId && conflictingPlanId !== plan.plan_id) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'TASK_ID_CONFLICT',
            message: `task_id ${fm.task_id} 已属于 plan ${conflictingPlanId}，不能由 ${plan.plan_id} 覆盖`,
          },
        };
      }
    }

    // 幂等 + 增量更新策略：
    //   - 不存在 → 新建入队
    //   - pending → 用新 MD 覆盖（PM 改了需求，下次被领就是新内容）+ 重新入流
    //   - running/blocked → 不动（都是有 lease/阻塞上下文的活运行态）
    //   - done/failed/cancelled/superseded → 不动（保留不可变历史）
    // 只有明确的 pending 才允许被本地 MD 更新；任何未知已存状态也
    // fail-closed 保留，防止新版/损坏状态被当成“不存在”而复活。
    const defaultPriority = plan.default_priority ?? 5;
    let created = 0;
    let updated = 0;
    let skippedRunning = 0;
    let skippedDone = 0;
    let skippedBlocked = 0;
    let skippedCancelled = 0;
    let skippedSuperseded = 0;
    const preservedRuntimeTaskIds = new Set<string>();
    for (const { fm, body } of tasks) {
      // 按 task type 设默认 timeout（未显式声明时）：code/acceptance 3600s，review/research 2400s，docs 1800s
      if (fm.timeout_seconds === undefined) {
        const t = fm.type;
        fm.timeout_seconds = t === 'code' || t === 'acceptance' ? 3600 : t === 'review' || t === 'research' ? 2400 : 1800;
      }
      const existing = await redis.hget(keys.hash.task(fm.task_id), 'status');
      if (existing === 'done' || existing === 'failed') {
        skippedDone++;
        preservedRuntimeTaskIds.add(fm.task_id);
        continue; // 保留历史
      }
      if (existing === 'running') {
        skippedRunning++;
        preservedRuntimeTaskIds.add(fm.task_id);
        continue; // agent 正在跑，不强行改
      }
      if (existing === 'blocked') {
        skippedBlocked++;
        preservedRuntimeTaskIds.add(fm.task_id);
        continue;
      }
      if (existing === 'cancelled') {
        skippedCancelled++;
        preservedRuntimeTaskIds.add(fm.task_id);
        continue;
      }
      if (existing === 'superseded') {
        skippedSuperseded++;
        preservedRuntimeTaskIds.add(fm.task_id);
        continue;
      }
      if (existing === 'pending') {
        // 用新 MD 覆盖（HSET 重写 + 重新入流，让下次被领拿到新内容）
        await writeTaskToRedis(redis, fm, body, plan.plan_id, plan.project_path, defaultPriority);
        updated++;
        continue;
      }
      if (existing) {
        // 已存但当前版本不识别的状态：绝不能走“不存在”分支。
        preservedRuntimeTaskIds.add(fm.task_id);
        skippedDone++;
        continue;
      }
      // 不存在，新建
      await writeTaskToRedis(redis, fm, body, plan.plan_id, plan.project_path, defaultPriority);
      created++;
    }

    await writePlanToRedis(redis, plan, tasks.length);

    // SQLite 双写：plan + 所有 task（INSERT OR REPLACE，防 FLUSHALL 丢数据）
    if (sqliteStore) {
      const nowIso = new Date().toISOString();
      sqliteStore.upsertPlan({
        plan_id: plan.plan_id,
        title: plan.title ?? plan.plan_id,
        status: 'submitted',
        project_path: plan.project_path,
        default_assignee: plan.default_assignee ?? 'auto',
        default_priority: plan.default_priority ?? 5,
        phases: JSON.stringify(plan.phases ?? []),
        task_count: tasks.length,
        created_at: plan.created_at ?? nowIso,
        submitted_at: nowIso,
        pm_consumer: plan.pm_consumer ?? DEFAULT_PM_CONSUMER,
      } as PlanRow);
      for (const { fm, body } of tasks) {
        // Redis 中的非 pending 运行态已被明确保留，SQLite 必须同步同一个
        // 快照，不能在双写阶段又用 Plan MD 把 blocked/running/cancelled 改回 pending。
        if (preservedRuntimeTaskIds.has(fm.task_id)) {
          await persistTaskFromRedis(redis, fm.task_id);
          continue;
        }
        // 幂等保护：如果 SQLite 里该 task 已是终态(done/failed/cancelled/superseded)，不覆盖 status
        // （修复 fix-sqlite-status-sync：重新 submit 时不应把已完成的 task 改回 pending）
        const existing = sqliteStore.getAllTasks().find((t) => t.task_id === fm.task_id);
        const preservedStatus = existing && ['running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'].includes(existing.status)
          ? existing.status
          : 'pending';
        const preservedDoneAt = existing?.done_at ?? '';
        const preservedResultPath = existing?.result_path ?? '';
        const preservedResultJson = existing?.result_json_path ?? '';
        sqliteStore.upsertTask({
          task_id: fm.task_id,
          plan_id: plan.plan_id,
          title: fm.title,
          type: fm.type,
          phase: fm.phase,
          status: preservedStatus,
          priority: fm.priority ?? defaultPriority,
          assignee: fm.assignee ?? 'auto',
          ownership_files: (fm.ownership?.files ?? []).join(','),
          ownership_modules: (fm.ownership?.modules ?? []).join(','),
          depends_on: (fm.depends_on ?? []).join(','),
          timeout_seconds: fm.timeout_seconds ?? 3600,
          max_retries: fm.max_retries ?? 2,
          model_override: fm.model_override ?? '',
          acceptance_for: (fm.acceptance_for ?? []).join(','),
          verify: JSON.stringify(fm.verify ?? []),
          claimed_by: existing?.claimed_by ?? '',
          claimed_at: existing?.claimed_at ?? '',
          expire_at: existing?.expire_at ?? '',
          result_path: preservedResultPath,
          result_json_path: preservedResultJson,
          done_at: preservedDoneAt,
          retries: existing?.retries ?? 0,
          pm_review_status: existing?.pm_review_status ?? '',
          pm_reviewed_by: existing?.pm_reviewed_by ?? '',
          pm_reviewed_at: existing?.pm_reviewed_at ?? '',
          pm_review_comment: existing?.pm_review_comment ?? '',
          pm_reject_reason: existing?.pm_reject_reason ?? '',
          pm_fix_instructions: existing?.pm_fix_instructions ?? '',
          pm_rejection_resolution_mode: existing?.pm_rejection_resolution_mode ?? '',
          repair_ownership_extension: existing?.repair_ownership_extension ?? '',
          fix_for: existing?.fix_for ?? '',
          repair_root_task_id: existing?.repair_root_task_id ?? '',
          resolution_status: existing?.resolution_status ?? '',
          resolution_action: existing?.resolution_action ?? '',
          resolution_task_id: existing?.resolution_task_id ?? '',
          resolution_task_ids: existing?.resolution_task_ids ?? '',
          resolved_by_task: existing?.resolved_by_task ?? '',
          resolution_generation: existing?.resolution_generation ?? 0,
          resolution_attempts: existing?.resolution_attempts ?? 0,
          blocked_at: existing?.blocked_at ?? '',
          block_reason: existing?.block_reason ?? '',
          blocked_question_id: existing?.blocked_question_id ?? '',
          blocked_lease_remaining: existing?.blocked_lease_remaining ?? '',
          last_question_id: existing?.last_question_id ?? '',
          last_question_answer: existing?.last_question_answer ?? '',
          cancelled_at: existing?.cancelled_at ?? '',
          superseded_at: existing?.superseded_at ?? '',
          superseded_by: existing?.superseded_by ?? '',
          superseded_reason: existing?.superseded_reason ?? '',
          verify_results: existing?.verify_results ?? '[]',
          goal_md: body,
          created_at: existing?.created_at ?? nowIso,
          updated_at: nowIso,
        } as TaskRow);
      }
    }

    return {
      ok: true,
      data: {
        plan_id: plan.plan_id,
        task_count: tasks.length,
        created,
        updated,
        skipped_running: skippedRunning,
        skipped_done: skippedDone,
        skipped_blocked: skippedBlocked,
        skipped_cancelled: skippedCancelled,
        skipped_superseded: skippedSuperseded,
      },
    };
  } catch (e) {
    return {
      ok: false,
      data: null,
      error: workspaceError(e, 'PLAN_PARSE_ERROR'),
    };
  }
}

/** agent register */
export async function agentRegister(
  redis: Redis,
  agentId: string,
  agentType: string,
  capabilities: string[],
  endpoint?: string,
  projects?: string[],
): Promise<ApiResponse<{ agent_id: string }>> {
  const now = Date.now();
  await redis.hset(keys.hash.agent(agentId), {
    agent_id: agentId,
    agent_type: agentType,
    capabilities: capabilities.join(','),
    endpoint: endpoint ?? '',
    projects: (projects ?? []).join(','),
    registered_at: String(now),
    last_heartbeat: String(now),
    status: 'idle',
    current_task: '',
  });
  return { ok: true, data: { agent_id: agentId } };
}

/** heartbeat */
export async function agentHeartbeat(redis: Redis, agentId: string, currentTask?: string): Promise<ApiResponse<unknown>> {
  const now = Date.now();
  await redis.hset(keys.hash.agent(agentId), {
    last_heartbeat: String(now),
    current_task: currentTask ?? '',
    status: currentTask ? 'busy' : 'idle',
  });
  return { ok: true, data: { agent_id: agentId, ts: now } };
}

/**
 * 任务是否已经形成可供下游消费的有效交付。
 *
 * `done` 只是 Worker 上报，不是项目完成。普通任务必须等 PM accepted；当原任务
 * 被 reject/failed 后由独立 repair 闭环时，保留其原始审计并以 resolution_status=resolved
 * 作为唯一例外。acceptance 任务可以在其被验收的原任务 `done` 后执行，不能反过来被
 * PM review 门控形成死锁。
 */
function isDependencySatisfied(hash: Record<string, string>, forAcceptance = false): boolean {
  if (!hash.task_id) return false;
  // resolution 一旦存在，必须以它作为唯一完成口径：不能让旧的 PM accepted
  // 绕过一个正在 repair/reverify 的失败审计。只有独立 repair 已被 PM 接受后显式
  // 标记 resolved，才允许下游继续。
  if (hash.resolution_status) return hash.resolution_status === 'resolved';
  if (hash.status !== 'done') return false;
  return forAcceptance || hash.pm_review_status === 'accepted';
}

/** 检查任务依赖是否满足；claim 和 blocked 自动恢复必须使用同一口径。 */
async function checkDependencies(redis: Redis, task: TaskRecord): Promise<{ ok: boolean; missing?: string }> {
  const forAcceptance = task.type === 'acceptance';
  for (const dep of task.depends_on ?? []) {
    const depHash = await redis.hgetall(keys.hash.task(dep));
    if (!isDependencySatisfied(depHash, forAcceptance)) {
      return { ok: false, missing: dep };
    }
  }
  return { ok: true };
}

/** 把失败证据收敛成可安全写入 repair goal 的最小摘要，避免把完整日志/凭据复制到任务流。 */
function summarizeVerifyFailures(verifyResults: Array<{ cmd: string; exit_code: number; passed: boolean }> = []): string[] {
  return verifyResults
    .filter((result) => !result.passed)
    .map((result) => `- ${result.cmd}（exit=${result.exit_code}）`);
}

/** failed/partial 的最小审计摘要。完整 stdout/stderr 只保留在 result.json，避免看板和事件流泄露冗长输出。 */
function failureReasonForReport(
  status: 'failed' | 'partial',
  verifyResults: Array<{ cmd: string; exit_code: number; passed: boolean }> = [],
): string {
  const failed = summarizeVerifyFailures(verifyResults);
  if (failed.length > 0) return `验证未通过：${failed.map((line) => line.replace(/^-\s*/, '')).join('；')}`;
  return status === 'partial' ? 'Worker 上报 partial，未完成交付。' : 'Worker 上报 failed。';
}

const MAX_REPAIR_OWNERSHIP_ENTRIES = 64;
const MAX_REPAIR_OWNERSHIP_ENTRY_LENGTH = 512;

interface NormalizedRepairOwnership {
  files: string[];
  modules: string[];
}

function normalizeRepairOwnership(
  input: RepairOwnershipExtension | undefined,
): { value?: NormalizedRepairOwnership; error?: string } {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'repair_ownership 必须是包含 files 和/或 modules 数组的对象。' };
  }

  const record = input as Record<string, unknown>;
  const allowed = new Set(['files', 'modules']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { error: 'repair_ownership 只允许 files 和 modules 字段。' };
  }

  const normalized: NormalizedRepairOwnership = { files: [], modules: [] };
  let suppliedKinds = 0;
  let suppliedCount = 0;
  for (const kind of ['files', 'modules'] as const) {
    const entries = record[kind];
    if (entries === undefined) continue;
    suppliedKinds++;
    if (!Array.isArray(entries)) return { error: `repair_ownership.${kind} 必须是字符串数组。` };
    if (entries.length > MAX_REPAIR_OWNERSHIP_ENTRIES) {
      return { error: `repair_ownership.${kind} 最多 ${MAX_REPAIR_OWNERSHIP_ENTRIES} 项。` };
    }
    suppliedCount += entries.length;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== 'string') return { error: `repair_ownership.${kind} 只能包含字符串。` };
      const value = entry.trim();
      if (!value) return { error: `repair_ownership.${kind} 不能包含空字符串。` };
      if (value.length > MAX_REPAIR_OWNERSHIP_ENTRY_LENGTH || /[\u0000-\u001F\u007F,]/.test(value)) {
        return { error: `repair_ownership.${kind} 每项长度不得超过 ${MAX_REPAIR_OWNERSHIP_ENTRY_LENGTH}，且不能包含控制字符或逗号。` };
      }
      if (!seen.has(value)) {
        seen.add(value);
        normalized[kind].push(value);
      }
    }
  }
  if (suppliedKinds === 0 || suppliedCount === 0 || suppliedCount > MAX_REPAIR_OWNERSHIP_ENTRIES) {
    return { error: `repair_ownership 必须至少包含一项，且总数最多 ${MAX_REPAIR_OWNERSHIP_ENTRIES} 项。` };
  }
  if (normalized.files.length + normalized.modules.length === 0) {
    return { error: 'repair_ownership 去重后不能为空。' };
  }
  return { value: normalized };
}

function splitOwnership(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function ownershipUnion(base: string, extra: string[]): string {
  const values = splitOwnership(base);
  const seen = new Set(values);
  for (const value of extra) {
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values.join(',');
}

function repairOwnershipDelta(
  source: Record<string, string>,
  root: Record<string, string>,
  requested: NormalizedRepairOwnership,
): { value?: NormalizedRepairOwnership; error?: string } {
  const sourceFiles = source.ownership_files || root.ownership_files || '';
  const sourceModules = source.ownership_modules || root.ownership_modules || '';
  const existingFiles = new Set(splitOwnership(sourceFiles));
  const existingModules = new Set(splitOwnership(sourceModules));
  const value: NormalizedRepairOwnership = {
    files: requested.files.filter((item) => !existingFiles.has(item)),
    modules: requested.modules.filter((item) => !existingModules.has(item)),
  };
  if (value.files.length + value.modules.length === 0) {
    return { error: 'repair_ownership 没有新增来源任务未持有的 files 或 modules。' };
  }
  return { value };
}

function parseRepairOwnershipAudit(raw: string | undefined): NormalizedRepairOwnership | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as RepairOwnershipExtension;
    const normalized = normalizeRepairOwnership(parsed);
    return normalized.value;
  } catch {
    return undefined;
  }
}

function repairGoal(task: Record<string, string>, context: {
  source: 'worker_failed' | 'acceptance_failed' | 'pm_rejected';
  reason?: string;
  instructions?: string;
  failures?: string[];
  repairOwnership?: NormalizedRepairOwnership;
}): string {
  const sourceLabel = context.source === 'pm_rejected'
    ? 'PM 拒绝'
    : context.source === 'acceptance_failed'
      ? '独立验收失败'
      : 'Worker 执行或验证失败';
  const failures = context.failures?.length ? context.failures.join('\n') : '- 详见原任务的 result / verify 证据';
  const repairOwnership = context.repairOwnership && (context.repairOwnership.files.length || context.repairOwnership.modules.length)
    ? `\n\n## PM 授权的所有权扩展\n\n本次 repair 由 PM 在原 ownership 基础上显式扩权；原任务 ownership 未修改。仅可使用下列新增范围，不得扩大到其他文件或模块。\n\n${context.repairOwnership.files.length ? `- files：${context.repairOwnership.files.map((item) => `\`${item}\``).join('、')}\n` : ''}${context.repairOwnership.modules.length ? `- modules：${context.repairOwnership.modules.map((item) => `\`${item}\``).join('、')}\n` : ''}`
    : '';
  return `# 修复任务：${task.title ?? task.task_id}\n\n## 背景\n\n原任务 \`${task.task_id}\` 因${sourceLabel}进入修复闭环。\n\n## 原因\n\n${context.reason?.trim() || '请先读取原任务的 result.md、result.json 与验证结果。'}\n\n## 失败验证摘要\n\n${failures}\n\n## 修复要求\n\n${context.instructions?.trim() || '定位根因，完成修复，并重新执行原任务声明的 verify。'}${repairOwnership}\n\n## 验收标准\n\n- [ ] 保留原失败/拒绝审计，不覆盖原任务记录\n- [ ] 修复后提交 result.md、result.json 与完整 verify_results\n- [ ] 修复交付仍需独立 PM Review accept 才能闭环`;
}

interface ResolutionResult {
  rootTaskId: string;
  repairTaskId?: string;
  state: 'required' | 'repairing' | 'needs_pm_decision';
  action: 'repair' | 'reverify' | 'inspect';
  created: boolean;
}

async function markResolutionNeedsPmDecision(
  redis: Redis,
  rootTaskId: string,
  reason: string,
): Promise<void> {
  const root = await redis.hgetall(keys.hash.task(rootTaskId));
  if (!root.task_id) return;
  const alreadyRequired = root.resolution_status === 'needs_pm_decision' &&
    root.resolution_action === 'inspect';
  // needs_pm_decision 是修复链的终端状态，不是删除当前指针的理由。
  // 保留最后一代 child，PM/CLI 才能从根任务一步追溯失败证据；
  // 历史数据若已丢失当前指针，则仅从已记录 lineage 的末项恢复。
  const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  const latestTaskId = root.resolution_task_id || history.at(-1) || '';
  await redis.hset(keys.hash.task(rootTaskId), {
    resolution_status: 'needs_pm_decision',
    resolution_action: 'inspect',
    resolution_task_id: latestTaskId,
    resolution_decision_reason: reason,
  });
  if (!alreadyRequired) {
    const now = Date.now();
    const consumer = await resolvePmConsumer(redis, root.plan_id ?? '');
    await redis.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_resolution_decision_${rootTaskId}`,
      'type', 'resolution_required',
      'task_id', rootTaskId,
      'plan_id', root.plan_id ?? '',
      'project_path', root.project_path ?? '',
      'consumer', consumer,
      'resolution_action', 'inspect',
      'timestamp', String(now),
      'acked', 'false',
    );
  }
  await persistTaskFromRedis(redis, rootTaskId);
}

/**
 * 失败/拒绝后的确定性 repair 分派。
 *
 * 平台不假装自己修代码：它只把同一项目、原 ownership、原 verify 和最小故障证据
 * 转成一个可领取 repair task。每个根任务最多自动续航 `max_retries` 次；达到上限
 * 后保留 `needs_pm_decision`，由 PM Agent 通过平台详情决定下一步，而不是无限重跑。
 */
async function ensureRepairTask(
  redis: Redis,
  sourceTaskId: string,
  context: {
    source: 'worker_failed' | 'acceptance_failed' | 'pm_rejected';
    reason?: string;
    instructions?: string;
    failures?: string[];
    repairOwnership?: NormalizedRepairOwnership;
    /** acceptance/reverify 链耗尽时，只将决策门铃收敛到验收根。 */
    decisionRootTaskId?: string;
    /** 只能由显式 PM continue 使用：仅放行本次新 generation。 */
    allowRetryLimitOverride?: boolean;
  },
): Promise<ResolutionResult> {
  const source = await redis.hgetall(keys.hash.task(sourceTaskId));
  if (!source.task_id) {
    return { rootTaskId: sourceTaskId, state: 'needs_pm_decision', action: 'inspect', created: false };
  }
  const rootTaskId = source.repair_root_task_id || source.task_id;
  const root = rootTaskId === source.task_id ? source : await redis.hgetall(keys.hash.task(rootTaskId));
  if (!root.task_id) {
    return { rootTaskId, state: 'needs_pm_decision', action: 'inspect', created: false };
  }

  // 已存在尚未终止的 repair 时只重用；重复 report/reject 不会制造并行修复者。
  // 注意：PM 已 reject 的 done repair 不是活 repair，必须进入下一代，不能永久卡在
  // "已有 done task" 这条兼容分支里。
  const existingRepairId = root.resolution_task_id;
  if (existingRepairId) {
    const existingRepair = await redis.hgetall(keys.hash.task(existingRepairId));
    const isActiveRepair = existingRepair.task_id && (
      ['pending', 'running', 'blocked'].includes(existingRepair.status) ||
      (existingRepair.status === 'done' && !existingRepair.pm_review_status)
    );
    if (isActiveRepair) {
      if (existingRepair.status === 'done') {
        await markRepairAwaitingReview(redis, existingRepairId);
        return { rootTaskId, repairTaskId: existingRepairId, state: 'required', action: 'reverify', created: false };
      }
      return { rootTaskId, repairTaskId: existingRepairId, state: 'repairing', action: 'repair', created: false };
    }
  }

  const attempts = Number(root.resolution_attempts ?? 0);
  const maxAttempts = Math.max(1, Number(root.max_retries ?? source.max_retries ?? 2));
  if (attempts >= maxAttempts && !context.allowRetryLimitOverride) {
    const decisionRootTaskId = context.decisionRootTaskId || rootTaskId;
    const reason = decisionRootTaskId === rootTaskId
      ? 'repair_retry_limit_reached'
      : `repair_retry_limit_reached:${rootTaskId}`;
    await markResolutionNeedsPmDecision(redis, decisionRootTaskId, reason);
    return { rootTaskId: decisionRootTaskId, state: 'needs_pm_decision', action: 'inspect', created: false };
  }

  const generation = Number(root.resolution_generation ?? 0) + 1;
  const repairTaskId = `${rootTaskId}-repair-${generation}`;
  const now = Date.now();
  const expectedPlanId = source.plan_id ?? root.plan_id ?? '';
  const expectedProjectPath = source.project_path || root.project_path || '';
  const expectedType = source.type === 'acceptance' ? 'code' : (source.type ?? 'code');
  const collidingTask = await redis.hgetall(keys.hash.task(repairTaskId));
  if (collidingTask.task_id) {
    const isReusableRepair = ['pending', 'running', 'blocked'].includes(collidingTask.status) ||
      (collidingTask.status === 'done' && !collidingTask.pm_review_status);
    const isSameRepair = isReusableRepair &&
      collidingTask.fix_for === sourceTaskId &&
      collidingTask.repair_root_task_id === rootTaskId &&
      collidingTask.plan_id === expectedPlanId &&
      collidingTask.project_path === expectedProjectPath &&
      collidingTask.type === expectedType;
    if (!isSameRepair) {
      const decisionRootTaskId = context.decisionRootTaskId || rootTaskId;
      await markResolutionNeedsPmDecision(
        redis,
        decisionRootTaskId,
        `repair_task_id_collision:${repairTaskId}`,
      );
      return { rootTaskId: decisionRootTaskId, state: 'needs_pm_decision', action: 'inspect', created: false };
    }

    const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
    const awaitingReview = collidingTask.status === 'done' && !collidingTask.pm_review_status;
    await redis.hset(keys.hash.task(rootTaskId), {
      resolution_status: awaitingReview ? 'required' : 'repairing',
      resolution_action: awaitingReview ? 'reverify' : 'repair',
      resolution_task_id: repairTaskId,
      resolution_task_ids: [...new Set([...history, repairTaskId])].join(','),
      resolved_by_task: '',
      resolution_generation: String(Math.max(Number(root.resolution_generation ?? 0), generation)),
      resolution_attempts: String(Math.max(attempts + 1, Number(root.resolution_attempts ?? 0))),
      resolution_decision_reason: '',
    });
    if (sourceTaskId !== rootTaskId) {
      await redis.hset(keys.hash.task(sourceTaskId), {
        resolution_status: awaitingReview ? 'required' : 'repairing',
        resolution_action: awaitingReview ? 'reverify' : 'repair',
        resolution_task_id: repairTaskId,
      });
      await persistTaskFromRedis(redis, sourceTaskId);
    }
    await persistTaskFromRedis(redis, rootTaskId);
    return {
      rootTaskId,
      repairTaskId,
      state: awaitingReview ? 'required' : 'repairing',
      action: awaitingReview ? 'reverify' : 'repair',
      created: false,
    };
  }
  // repair 本身绝不 depends_on 一个 failed/rejected task：失败来源是证据，不是 DAG 前置条件。
  await redis.hset(keys.hash.task(repairTaskId), {
    task_id: repairTaskId,
    plan_id: expectedPlanId,
    title: `修复：${source.title ?? sourceTaskId}`,
    type: expectedType,
    phase: source.phase ?? root.phase ?? 'impl',
    assignee: 'auto',
    priority: String(Math.min(10, Number(source.priority ?? root.priority ?? 5) + 1)),
    status: 'pending',
    depends_on: '',
    ownership_files: context.repairOwnership?.files.length
      ? ownershipUnion(source.ownership_files || root.ownership_files || '', context.repairOwnership.files)
      : (source.ownership_files || root.ownership_files || ''),
    ownership_modules: context.repairOwnership?.modules.length
      ? ownershipUnion(source.ownership_modules || root.ownership_modules || '', context.repairOwnership.modules)
      : (source.ownership_modules || root.ownership_modules || ''),
    timeout_seconds: source.timeout_seconds || root.timeout_seconds || '1800',
    max_retries: source.max_retries || root.max_retries || '2',
    retries: '0',
    model_override: source.model_override || root.model_override || '',
    acceptance_for: '',
    verify: source.verify || root.verify || '[]',
    failed_reason: '',
    goal_md: repairGoal(source, context),
    repair_ownership_extension: context.repairOwnership ? JSON.stringify(context.repairOwnership) : '',
    project_path: expectedProjectPath,
    created_at: String(now),
    fix_for: sourceTaskId,
    repair_root_task_id: rootTaskId,
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: '0',
    resolution_attempts: '0',
  });
  await redis.zadd(keys.zset.status.pending, pendingScore(Math.min(10, Number(source.priority ?? root.priority ?? 5) + 1), now), repairTaskId);
  await redis.xadd(keys.stream.tasks, '*', 'task_id', repairTaskId, 'priority', String(Math.min(10, Number(source.priority ?? root.priority ?? 5) + 1)));

  const historicalIds = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  const nextIds = [...historicalIds, repairTaskId];
  await redis.hset(keys.hash.task(rootTaskId), {
    resolution_status: 'repairing',
    resolution_action: 'repair',
    resolution_task_id: repairTaskId,
    resolution_task_ids: nextIds.join(','),
    resolved_by_task: '',
    resolution_generation: String(generation),
    resolution_attempts: String(attempts + 1),
    resolution_decision_reason: '',
  });
  // 非根 repair 也保留目前正在修复哪个分支，便于详情/恢复审计。
  if (sourceTaskId !== rootTaskId) {
    await redis.hset(keys.hash.task(sourceTaskId), {
      resolution_status: 'repairing',
      resolution_action: 'repair',
      resolution_task_id: repairTaskId,
    });
  }
  // repair 已进入 task stream，Worker/共享 Supervisor 会自行领取；它不是 PM
  // 待办。PM 只在 repair 交付后的 review_requested 或重试耗尽时被提醒。
  await redis.xadd(
    keys.stream.events,
    '*',
    'event_id', `${now}_resolution_${rootTaskId}_${generation}`,
    'type', 'repair_scheduled',
    'task_id', rootTaskId,
    'plan_id', root.plan_id ?? source.plan_id ?? '',
    'project_path', root.project_path ?? source.project_path ?? '',
    'consumer', 'worker',
    'resolution_action', 'repair',
    'repair_task_id', repairTaskId,
    'timestamp', String(now),
    'acked', 'false',
  );
  await persistTaskFromRedis(redis, repairTaskId);
  await persistTaskFromRedis(redis, rootTaskId);
  if (sourceTaskId !== rootTaskId) await persistTaskFromRedis(redis, sourceTaskId);
  return { rootTaskId, repairTaskId, state: 'repairing', action: 'repair', created: true };
}

export interface ResolutionReconciliation {
  repaired_task_ids: string[];
  needs_pm_decision_task_ids: string[];
}

/**
 * 旧版 PM reject 曾生成过 `<source>-fix-<n>`，但没有 `fix_for`/repair root 字段。
 * 只在启动补偿时识别这一个明确、可逆的历史命名，接回原失败链；不能根据标题猜测，
 * 否则可能把用户手工创建的普通任务误连到 repair 流程。
 */
async function migrateLegacyNamedFixes(redis: Redis): Promise<void> {
  const taskKeys = await scanKeys(redis, `${PREFIX}:hash:task:*`);
  for (const taskKey of taskKeys) {
    const legacyFix = await redis.hgetall(taskKey);
    if (!legacyFix.task_id) continue;
    const match = legacyFix.task_id.match(/^(.*)-fix-(\d+)$/);
    if (!match) continue;
    const [, namedParentTaskId, generationText] = match;
    // 部分旧版本已写 fix_for，却没有 repair root/resolution 字段。只接受与明确
    // `<parent>-fix-n` 命名一致的值，避免把手工任务接到错误的根上。
    if (legacyFix.fix_for && legacyFix.fix_for !== namedParentTaskId) continue;
    const parentTaskId = legacyFix.fix_for || namedParentTaskId;
    const parent = await redis.hgetall(keys.hash.task(parentTaskId));
    const parentIsTerminalSource = parent.task_id && (
      parent.status === 'failed' ||
      (parent.status === 'done' && parent.pm_review_status === 'rejected')
    );
    if (!parentIsTerminalSource || parent.fix_for) continue;

    const generation = Math.max(1, Number(generationText) || 1);
    const rootTaskId = parent.repair_root_task_id || parentTaskId;
    const currentRepair = parent.resolution_task_id
      ? await redis.hgetall(keys.hash.task(parent.resolution_task_id))
      : {};

    // 服务已先为根创建了一条 pending repair 时，仍可无损把它改接到历史 fix：
    // pending 尚无 Worker 领取，不会改变任何执行中的 goal/ownership。这样 accept
    // 会按 repair -> legacy fix -> root 的链路逐层收敛，而不会遗留一个 failed 桶。
    const canAdoptPendingRepair = parent.resolution_status &&
      currentRepair.task_id &&
      currentRepair.status === 'pending' &&
      currentRepair.fix_for === parentTaskId &&
      (!currentRepair.repair_root_task_id || currentRepair.repair_root_task_id === rootTaskId);
    if (canAdoptPendingRepair) {
      const historicalIds = (parent.resolution_task_ids ?? '').split(',').filter(Boolean);
      const resolutionTaskIds = [legacyFix.task_id, ...historicalIds]
        .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
      await redis.hset(keys.hash.task(legacyFix.task_id), {
        fix_for: parentTaskId,
        repair_root_task_id: rootTaskId,
        resolution_status: 'repairing',
        resolution_action: 'repair',
        resolution_task_id: currentRepair.task_id,
      });
      await redis.hset(keys.hash.task(currentRepair.task_id), {
        fix_for: legacyFix.task_id,
        repair_root_task_id: rootTaskId,
      });
      await redis.hset(keys.hash.task(parentTaskId), {
        resolution_status: 'repairing',
        resolution_action: 'repair',
        resolution_task_ids: resolutionTaskIds.join(','),
      });
      await persistTaskFromRedis(redis, legacyFix.task_id);
      await persistTaskFromRedis(redis, currentRepair.task_id);
      await persistTaskFromRedis(redis, parentTaskId);
      continue;
    }

    // 有新 resolution 且当前 repair 已运行/交付时不改写它的祖先；保留给正常闭环
    // 或 needs_pm_decision 处理，避免升级过程干扰一个已经执行中的 Worker。
    if (parent.resolution_status) continue;

    await redis.hset(keys.hash.task(legacyFix.task_id), {
      fix_for: parentTaskId,
      repair_root_task_id: rootTaskId,
      resolution_status: 'repairing',
      resolution_action: 'repair',
    });
    await redis.hset(keys.hash.task(parentTaskId), {
      resolution_status: 'repairing',
      resolution_action: 'repair',
      resolution_task_id: legacyFix.task_id,
      resolution_task_ids: legacyFix.task_id,
      resolution_generation: String(generation),
      resolution_attempts: String(generation),
    });
    await persistTaskFromRedis(redis, legacyFix.task_id);
    await persistTaskFromRedis(redis, parentTaskId);
  }
}

/**
 * 为旧版本遗留的 failed/rejected 状态补建一次 repair 闭环。
 *
 * 新版本的 report/review 已同步创建 repair；此函数只服务于升级、SQLite restore 和
 * `watchdog --auto-fix`。它完全幂等：一旦根任务已有 resolution_status，就不会再创建
 * 新任务或重复通知 PM。对于历史 repair 链，优先回到失败/拒绝的根任务，避免把同一个
 * 问题拆成多个并行修复者。
 */
async function reconcileResolutionBacklogUnlocked(redis: Redis): Promise<ResolutionReconciliation> {
  await migrateLegacyNamedFixes(redis);
  const candidateIds = new Set([
    ...(await redis.zrange(keys.zset.status.failed, 0, -1)),
    ...(await redis.zrange(keys.zset.status.done, 0, -1)),
  ]);
  const repairedTaskIds: string[] = [];
  const needsPmDecisionTaskIds: string[] = [];
  const handledRoots = new Set<string>();

  for (const candidateId of candidateIds) {
    const candidate = await redis.hgetall(keys.hash.task(candidateId));
    const candidateNeedsRepair = candidate.status === 'failed' ||
      (candidate.status === 'done' && candidate.pm_review_status === 'rejected');
    if (!candidate.task_id || candidate.status === 'cancelled' || !candidateNeedsRepair) continue;

    // 新 repair task 有 fix_for 时向上寻找真正的失败根；若根不是终态，说明当前
    // candidate 自身才是失败点，仍以 candidate 为来源处理。
    let chainRoot = candidate;
    for (let depth = 0; depth < 32 && chainRoot.fix_for; depth++) {
      const parent = await redis.hgetall(keys.hash.task(chainRoot.fix_for));
      if (!parent.task_id) break;
      chainRoot = parent;
    }
    const rootNeedsRepair = chainRoot.status === 'failed' ||
      (chainRoot.status === 'done' && chainRoot.pm_review_status === 'rejected');
    // 历史 `-fix-n` 已经接回 repair 链时，必须从这个失败 fix 继续，而不是从
    // 原 source 新开一条平行 repair；这样 repair-2 accept 会沿 fix_for 逐层关闭。
    const source = candidate.fix_for && candidate.repair_root_task_id
      ? candidate
      : rootNeedsRepair
        ? chainRoot
        : candidate;
    const rootTaskId = source.repair_root_task_id || source.task_id;
    if (handledRoots.has(rootTaskId)) continue;

    const resolutionOwner = source.repair_root_task_id ? chainRoot : source;
    const currentRepair = resolutionOwner.resolution_task_id
      ? await redis.hgetall(keys.hash.task(resolutionOwner.resolution_task_id))
      : {};
    const continuationRequired =
      ['repairing', 'required'].includes(resolutionOwner.resolution_status ?? '') &&
      currentRepair.task_id &&
      (currentRepair.status === 'failed' || currentRepair.status === 'cancelled' ||
        (currentRepair.status === 'done' && currentRepair.pm_review_status === 'rejected'));

    // 旧版本可能留下没有 acceptance_for 的失败验收，甚至已错误标成
    // repairing/reverify 但没有 resolution_task_id。它无法自动推断修复来源，必须
    // fail-closed 给 PM；这个检查要早于 resolution_status 的兼容跳过，才能自愈旧脏态。
    const malformedAcceptance = source.type === 'acceptance' && acceptanceSourceIds(source).length === 0;
    if (malformedAcceptance) {
      if (source.resolution_status === 'needs_pm_decision' && source.resolution_action === 'inspect') continue;
      handledRoots.add(rootTaskId);
      await markResolutionNeedsPmDecision(
        redis,
        rootTaskId,
        `acceptance_source_missing:${source.task_id}`,
      );
      await markAcceptanceFailureResolution(redis, source.task_id, [], true);
      needsPmDecisionTaskIds.push(rootTaskId);
      continue;
    }
    // PM 显式选择 reverify-only 后，处置模式已作为拒绝审计持久化。即使进程在
    // “写 reject”与“创建 attempt”之间退出，启动补偿也必须继续创建 fresh
    // acceptance，而不能按旧默认退化成每个来源的 code repair。
    const directReverifyOnly = source.type === 'acceptance' &&
      source.status === 'done' &&
      source.pm_review_status === 'rejected' &&
      source.pm_rejection_resolution_mode === 'reverify' &&
      !['resolved', 'cancelled', 'needs_pm_decision'].includes(source.resolution_status ?? '');
    if (directReverifyOnly) {
      if (!['required', 'repairing'].includes(source.resolution_status ?? '')) {
        await redis.hset(keys.hash.task(source.task_id), {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        });
        await persistTaskFromRedis(redis, source.task_id);
      }
      const reverify = await ensureAcceptanceReverifyTask(
        redis,
        source.repair_root_task_id || source.task_id,
        'startup-reconcile:pm-reverify-only',
        { trigger: 'pm_reverify_only' },
      );
      handledRoots.add(rootTaskId);
      if (reverify.needsPmDecision || !reverify.taskId) needsPmDecisionTaskIds.push(rootTaskId);
      else if (reverify.created) repairedTaskIds.push(rootTaskId);
      continue;
    }
    if (source.resolution_status && !continuationRequired) continue;
    handledRoots.add(rootTaskId);

    if (
      source.type === 'acceptance' &&
      (source.status === 'failed' || (source.status === 'done' && source.pm_review_status === 'rejected'))
    ) {
      const sourceIds = acceptanceSourceIds(source);
      if (sourceIds.length === 0) {
        await markResolutionNeedsPmDecision(
          redis,
          rootTaskId,
          `acceptance_source_missing:${source.task_id}`,
        );
        needsPmDecisionTaskIds.push(rootTaskId);
        continue;
      }
      const repairIds: string[] = [];
      let needsDecision = false;
      for (const sourceId of sourceIds) {
        const resolution = await ensureRepairTask(redis, sourceId, {
          source: 'acceptance_failed',
          reason: source.status === 'failed'
            ? `历史独立验收任务 ${source.task_id} 失败，升级后补建来源修复闭环。`
            : `历史独立验收任务 ${source.task_id} 被 PM 拒绝，升级后补建来源修复闭环。${source.pm_reject_reason ? ` 原因：${source.pm_reject_reason}` : ''}`,
          instructions: source.pm_fix_instructions || undefined,
          decisionRootTaskId: source.repair_root_task_id || source.task_id,
        });
        if (resolution.repairTaskId) repairIds.push(resolution.repairTaskId);
        if (resolution.state === 'needs_pm_decision') needsDecision = true;
      }
      await markAcceptanceFailureResolution(redis, source.task_id, repairIds, needsDecision);
      if (needsDecision) needsPmDecisionTaskIds.push(rootTaskId);
      else repairedTaskIds.push(rootTaskId);
      continue;
    }

    const resolution = await ensureRepairTask(redis, source.task_id, {
      source: source.status === 'done' && source.pm_review_status === 'rejected' ? 'pm_rejected' : 'worker_failed',
      reason: source.pm_reject_reason || source.failed_reason || '历史 failed/rejected 任务，升级后补建自动修复闭环。',
      instructions: source.pm_fix_instructions || undefined,
    });
    if (resolution.state === 'needs_pm_decision') needsPmDecisionTaskIds.push(rootTaskId);
    else if (resolution.repairTaskId) repairedTaskIds.push(rootTaskId);
  }

  // 处理“来源 repair 已在崩溃前 accepted、但 reverify task 尚未落盘”的窗口；
  // 已存在 attempt 时 ensureAcceptanceReverifyTask 会幂等复用。
  const reverifyRecovery = await scheduleReadyAcceptanceReverifications(redis, 'startup-reconcile');
  for (const taskId of reverifyRecovery.needsPmDecisionTaskIds) {
    if (!needsPmDecisionTaskIds.includes(taskId)) needsPmDecisionTaskIds.push(taskId);
  }

  return {
    repaired_task_ids: repairedTaskIds,
    needs_pm_decision_task_ids: needsPmDecisionTaskIds,
  };
}

/**
 * 启动补偿也会创建 repair/reverify 并双写 SQLite，因此直接调用必须与 HTTP writer
 * 使用同一跨进程门控。restore 内部已持有独占 owner，只调用上面的 unlocked 版本。
 */
export async function reconcileResolutionBacklog(redis: Redis): Promise<ResolutionReconciliation> {
  return withMutationPermitOrThrow(redis, () => reconcileResolutionBacklogUnlocked(redis));
}

/** repair 已交付、尚待 PM Review 时，把失败来源统一标记为“待复验”。
 * 不写新的 PM 门铃：repair 自身的 review_requested 已足够，避免同一件事双响。 */
async function markRepairAwaitingReview(redis: Redis, repairTaskId: string): Promise<string[]> {
  const updated: string[] = [];
  let childId = repairTaskId;
  for (let depth = 0; depth < 32; depth++) {
    const child = await redis.hgetall(keys.hash.task(childId));
    const parentId = child.fix_for;
    if (!parentId) break;
    const parent = await redis.hgetall(keys.hash.task(parentId));
    if (!parent.task_id) break;
    await redis.hset(keys.hash.task(parentId), {
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: repairTaskId,
      resolved_by_task: '',
    });
    await persistTaskFromRedis(redis, parentId);
    updated.push(parentId);
    childId = parentId;
  }
  return updated;
}

function acceptanceSourceIds(hash: Record<string, string>): string[] {
  return [...new Set((hash.acceptance_for ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function sameStringSet(left: string[], right: string[]): boolean {
  return [...new Set(left)].sort().join(',') === [...new Set(right)].sort().join(',');
}

function isMatchingAcceptanceReverify(
  root: Record<string, string>,
  candidate: Record<string, string>,
  sources: string[],
): boolean {
  const dependencies = (root.depends_on ?? '').split(',').filter(Boolean);
  const expectedDependencies = dependencies.length ? dependencies : sources;
  return Boolean(candidate.task_id) &&
    candidate.type === 'acceptance' &&
    candidate.status !== 'cancelled' &&
    candidate.fix_for === root.task_id &&
    candidate.repair_root_task_id === root.task_id &&
    candidate.plan_id === (root.plan_id ?? '') &&
    candidate.project_path === (root.project_path ?? '') &&
    sameStringSet(acceptanceSourceIds(candidate), sources) &&
    sameStringSet((candidate.depends_on ?? '').split(',').filter(Boolean), expectedDependencies) &&
    candidate.verify === (root.verify ?? '[]') &&
    candidate.ownership_files === (root.ownership_files ?? '') &&
    candidate.ownership_modules === (root.ownership_modules ?? '');
}

/**
 * 为被拒绝/失败的 acceptance 创建一个新的、可独立领取的复验 attempt。
 *
 * 不能 reset 原 acceptance：reset 会覆盖旧 result/review 审计，而且同一路径的 Worker
 * 输出还可能重写历史产物。新的 task 通过 fix_for 指回原 acceptance，仅在它自身被 PM
 * accepted 后，resolveRepairLineage 才会关闭原 acceptance 的 resolution。
 */
async function ensureAcceptanceReverifyTask(
  redis: Redis,
  acceptanceRootTaskId: string,
  resolvedByTaskId: string,
  options: { allowRetryLimitOverride?: boolean; trigger?: 'repair_accepted' | 'pm_reverify_only' } = {},
): Promise<{ taskId?: string; created: boolean; needsPmDecision?: boolean }> {
  const root = await redis.hgetall(keys.hash.task(acceptanceRootTaskId));
  if (
    !root.task_id ||
    root.type !== 'acceptance' ||
    !(
      ['repairing', 'required'].includes(root.resolution_status ?? '') ||
      (options.allowRetryLimitOverride && root.resolution_status === 'needs_pm_decision')
    )
  ) return { created: false };

  const sources = acceptanceSourceIds(root);
  if (sources.length === 0) return { created: false };
  for (const sourceId of sources) {
    if (!isDependencySatisfied(await redis.hgetall(keys.hash.task(sourceId)))) return { created: false };
  }
  const rootDependencies = (root.depends_on ?? '').split(',').filter(Boolean);
  const reverifyDependencies = rootDependencies.length ? rootDependencies : sources;
  for (const dependencyId of reverifyDependencies) {
    if (!isDependencySatisfied(await redis.hgetall(keys.hash.task(dependencyId)))) return { created: false };
  }

  // 重启或重复 reconcile 时优先采用已经排队/执行/交付的同一 attempt。
  const currentTaskId = root.resolution_task_id;
  if (currentTaskId) {
    const current = await redis.hgetall(keys.hash.task(currentTaskId));
    const isCurrentReverify = isMatchingAcceptanceReverify(root, current, sources);
    if (isCurrentReverify) {
      // PM accepted 已写入、但进程在 lineage 回写前退出时，启动补偿直接闭合根验收。
      if (current.status === 'done' && current.pm_review_status === 'accepted') {
        const resolvedTaskIds = await resolveRepairLineage(redis, current.task_id);
        await wakeDependents(redis, current.task_id, { allowAcceptance: true });
        for (const resolvedTaskId of resolvedTaskIds) {
          await wakeDependents(redis, resolvedTaskId, { allowAcceptance: true });
        }
        return { taskId: current.task_id, created: false };
      }
      // 只复用仍在执行或等待 PM Review 的 attempt。failed/cancelled/已 rejected 都是
      // 不可变历史，必须继续创建下一代；否则 reverify-only 拒绝会永远回放旧 task。
      const isActiveReverify = ['pending', 'running', 'blocked'].includes(current.status) ||
        (current.status === 'done' && !current.pm_review_status);
      if (isActiveReverify) return { taskId: current.task_id, created: false };
    }
  }

  // resolution_generation 对 acceptance 根只在创建 reverify attempt 时递增，
  // 因此可以作为独立复验的稳定次数门。来源 repair 还能续跑不代表
  // 验收 attempt 可以无限生成；达上限后只保留根决策与已有 lineage。
  const reverifyAttempts = Number(root.resolution_generation ?? 0);
  const maxReverifyAttempts = Math.max(1, Number(root.max_retries ?? 2));
  if (reverifyAttempts >= maxReverifyAttempts && !options.allowRetryLimitOverride) {
    await markResolutionNeedsPmDecision(redis, root.task_id, 'reverify_retry_limit_reached');
    return { created: false, needsPmDecision: true };
  }

  const generation = Number(root.resolution_generation ?? 0) + 1;
  const reverifyTaskId = `${root.task_id}-reverify-${generation}`;
  const existing = await redis.hgetall(keys.hash.task(reverifyTaskId));
  if (existing.task_id) {
    const isSameReverify = isMatchingAcceptanceReverify(root, existing, sources);
    if (!isSameReverify) {
      await markResolutionNeedsPmDecision(redis, root.task_id, `reverify_task_id_collision:${reverifyTaskId}`);
      return { created: false, needsPmDecision: true };
    }
    await redis.hset(keys.hash.task(root.task_id), {
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: reverifyTaskId,
      resolution_generation: String(generation),
      resolved_by_task: '',
      resolution_decision_reason: '',
    });
    await persistTaskFromRedis(redis, root.task_id);
    if (existing.status === 'done' && existing.pm_review_status === 'accepted') {
      const resolvedTaskIds = await resolveRepairLineage(redis, existing.task_id);
      await wakeDependents(redis, existing.task_id, { allowAcceptance: true });
      for (const resolvedTaskId of resolvedTaskIds) {
        await wakeDependents(redis, resolvedTaskId, { allowAcceptance: true });
      }
    }
    return { taskId: reverifyTaskId, created: false };
  }

  const now = Date.now();
  const priority = Math.min(10, Number(root.priority ?? 5) + 1);
  await redis.hset(keys.hash.task(reverifyTaskId), {
    task_id: reverifyTaskId,
    plan_id: root.plan_id ?? '',
    title: `独立复验：${root.title ?? root.task_id}`,
    type: 'acceptance',
    phase: root.phase ?? 'acceptance',
    assignee: 'auto',
    priority: String(priority),
    status: 'pending',
    depends_on: reverifyDependencies.join(','),
    ownership_files: root.ownership_files ?? '',
    ownership_modules: root.ownership_modules ?? '',
    timeout_seconds: root.timeout_seconds ?? '1800',
    max_retries: root.max_retries ?? '2',
    retries: '0',
    model_override: root.model_override ?? '',
    acceptance_for: sources.join(','),
    verify: root.verify ?? '[]',
    failed_reason: '',
    goal_md: options.trigger === 'pm_reverify_only'
      ? `# 独立复验：${root.title ?? root.task_id}\n\nPM 已明确判定来源实现无需修复，本次拒绝仅针对验收证据或报告。请重新执行原验收要求，读取原验收 \`${root.task_id}\` 的拒绝原因，并提交新的 result.md、result.json 和 verify_results。不得修改来源实现，不得覆盖或复用原验收结果；复验交付仍需 PM Review accept。\n\n触发复验的 PM 决策：\`${resolvedByTaskId}\``
      : `# 独立复验：${root.title ?? root.task_id}\n\n来源任务的修复已由 PM 接受。请重新执行原验收要求，读取原验收 \`${root.task_id}\` 的拒绝原因与修复证据，并提交新的 result.md、result.json 和 verify_results。不得覆盖或复用原验收结果；复验交付仍需 PM Review accept。\n\n触发复验的已验收 repair：\`${resolvedByTaskId}\``,
    repair_ownership_extension: '',
    project_path: root.project_path ?? '',
    created_at: String(now),
    fix_for: root.task_id,
    repair_root_task_id: root.task_id,
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: '0',
    resolution_attempts: '0',
  });
  await redis.zadd(keys.zset.status.pending, pendingScore(priority, now), reverifyTaskId);
  await redis.xadd(keys.stream.tasks, '*', 'task_id', reverifyTaskId, 'priority', String(priority));

  const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  await redis.hset(keys.hash.task(root.task_id), {
    resolution_status: 'required',
    resolution_action: 'reverify',
    resolution_task_id: reverifyTaskId,
    resolution_task_ids: [...new Set([...history, reverifyTaskId])].join(','),
    resolved_by_task: '',
    resolution_generation: String(generation),
    resolution_decision_reason: '',
  });
  const consumer = await resolvePmConsumer(redis, root.plan_id ?? '');
  const firstReady = await redis.sadd(keys.acceptanceReady.fired, reverifyTaskId);
  if (firstReady === 1) {
    await redis.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_acceptance_ready_${reverifyTaskId}`,
      'type', 'acceptance_ready',
      'task_id', reverifyTaskId,
      'plan_id', root.plan_id ?? '',
      'project_path', root.project_path ?? '',
      'consumer', consumer,
      'timestamp', String(now),
      'acked', 'false',
    );
  }
  await persistTaskFromRedis(redis, reverifyTaskId);
  await persistTaskFromRedis(redis, root.task_id);
  return { taskId: reverifyTaskId, created: true };
}

/**
 * 返回会与当前 acceptance 形成自验收冲突的历史任务。
 *
 * 普通 acceptance 只需排除 acceptance_for 的实现者；reverify 还必须排除原验收者、
 * 本轮/历轮 repair 执行者和先前 reverify 执行者。否则写完 repair 的同一 Worker
 * 可以立即领取“独立复验”，在流程上绕过独立性门。
 */
async function acceptanceReviewerConflictTask(
  redis: Redis,
  task: TaskRecord,
  agentId: string,
): Promise<string | undefined> {
  if (task.type !== 'acceptance') return undefined;

  const independentFrom = new Set(task.acceptance_for ?? []);
  if (task.repair_root_task_id) {
    independentFrom.add(task.repair_root_task_id);
    const root = await redis.hgetall(keys.hash.task(task.repair_root_task_id));
    for (const taskId of (root.resolution_task_ids ?? '').split(',').filter(Boolean)) {
      if (taskId !== task.task_id) independentFrom.add(taskId);
    }
  }

  for (const taskId of independentFrom) {
    const reporter = await redis.hget(keys.hash.task(taskId), 'claimed_by');
    if (reporter && reporter === agentId) return taskId;
  }
  return undefined;
}

/** 来源 repair 全部 accepted 后只安排复验，绝不直接把旧 acceptance 判成 resolved。 */
async function scheduleReadyAcceptanceReverifications(
  redis: Redis,
  resolvedByTaskId: string,
): Promise<{ createdTaskIds: string[]; needsPmDecisionTaskIds: string[] }> {
  const candidateIds = [
    ...(await redis.zrange(keys.zset.status.failed, 0, -1)),
    ...(await redis.zrange(keys.zset.status.done, 0, -1)),
  ];
  const roots = new Set<string>();
  for (const candidateId of candidateIds) {
    const candidate = await redis.hgetall(keys.hash.task(candidateId));
    if (
      candidate.type !== 'acceptance' ||
      !['repairing', 'required'].includes(candidate.resolution_status ?? '')
    ) continue;
    roots.add(candidate.repair_root_task_id || candidate.task_id);
  }

  const created: string[] = [];
  const needsPmDecision: string[] = [];
  for (const rootId of roots) {
    const result = await ensureAcceptanceReverifyTask(redis, rootId, resolvedByTaskId);
    if (result.created && result.taskId) created.push(result.taskId);
    if (result.needsPmDecision) needsPmDecision.push(rootId);
  }
  return { createdTaskIds: created, needsPmDecisionTaskIds: needsPmDecision };
}

/** 独立 acceptance 失败本身也要有 resolution，否则来源 repair 已闭环后 plan 仍会永久 failed。 */
async function markAcceptanceFailureResolution(
  redis: Redis,
  acceptanceTaskId: string,
  repairTaskIds: string[],
  needsPmDecision: boolean,
): Promise<void> {
  const acceptance = await redis.hgetall(keys.hash.task(acceptanceTaskId));
  if (!acceptance.task_id) return;
  const uniqueRepairTaskIds = [...new Set(repairTaskIds.filter(Boolean))];
  const rootTaskId = acceptance.repair_root_task_id || acceptanceTaskId;
  const root = rootTaskId === acceptanceTaskId
    ? acceptance
    : await redis.hgetall(keys.hash.task(rootTaskId));
  if (!root.task_id) return;

  const rootHistory = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  // 耗尽时没有新 repair id，不能因此清空指向末次失败 reverify 的指针。
  // 这个指针是 inspect/continue 必须的最短证据链。
  const latestTaskId = uniqueRepairTaskIds.at(-1) || root.resolution_task_id || rootHistory.at(-1) || '';
  await redis.hset(keys.hash.task(rootTaskId), {
    resolution_status: needsPmDecision ? 'needs_pm_decision' : 'repairing',
    resolution_action: needsPmDecision ? 'inspect' : 'reverify',
    resolution_task_id: latestTaskId,
    resolution_task_ids: [...new Set([...rootHistory, ...uniqueRepairTaskIds])].join(','),
    resolved_by_task: '',
    resolution_generation: root.resolution_generation ?? '0',
    resolution_attempts: String(Number(root.resolution_attempts ?? 0) + uniqueRepairTaskIds.length),
  });
  await persistTaskFromRedis(redis, rootTaskId);

  // reverify attempt 是不可变的验收证据：它保持 failed/rejected 与原 result，
  // 后续修复与 PM 决策只写原 acceptance 根。原始 acceptance 则本身就是根，
  // 上面的一次写入已完成其闭环状态更新。
}

/** 已验收 repair 向上收敛其整个 fix 链；原 failed/rejected 历史保持不变。 */
async function resolveRepairLineage(redis: Redis, repairTaskId: string): Promise<string[]> {
  const resolved: string[] = [];
  let childId = repairTaskId;
  for (let depth = 0; depth < 32; depth++) {
    const child = await redis.hgetall(keys.hash.task(childId));
    const parentId = child.fix_for;
    if (!parentId) break;
    const parent = await redis.hgetall(keys.hash.task(parentId));
    if (!parent.task_id) break;
    const isAcceptanceReverify = child.type === 'acceptance' && child.repair_root_task_id === parentId;
    await redis.hset(keys.hash.task(parentId), {
      resolution_status: 'resolved',
      resolution_action: isAcceptanceReverify ? 'reverify' : 'repair',
      resolution_task_id: childId,
      resolved_by_task: repairTaskId,
    });
    await persistTaskFromRedis(redis, parentId);
    resolved.push(parentId);
    childId = parentId;
  }
  await scheduleReadyAcceptanceReverifications(redis, repairTaskId);
  return resolved;
}

/** 读取某 task 所属 plan 上声明的 PM consumer（旧 plan 无声明时回退到默认值）。
 *  PM 事件按此 consumer 路由，保证只提醒对应 PM；非法值回退默认。 */
async function resolvePmConsumer(redis: Redis, planId: string): Promise<string> {
  if (!planId) return DEFAULT_PM_CONSUMER;
  const planKey = keys.hash.plan(planId);
  const raw = await redis.hget(planKey, 'pm_consumer');
  const consumer = normalizePmConsumer(raw);
  // 读到旧的缺失/空/非法值时一次性回填。此处不会覆盖任何显式合法 consumer，
  // 后续低频 intake 也不必反复走兼容分支。
  if (raw !== consumer) await redis.hset(planKey, 'pm_consumer', consumer);
  return consumer;
}

/**
 * 把 Redis 原子 lease 回收结果同步到耐久层，并把重试耗尽者接入既有 repair 闭环。
 * 返回 failed 子集，供低频 reconciliation 输出最小摘要。
 */
async function finalizeReclaimedTasks(redis: Redis, reclaimedTaskIds: string[]): Promise<string[]> {
  const failedTaskIds: string[] = [];
  for (const taskId of reclaimedTaskIds) {
    await persistTaskFromRedis(redis, taskId);
    const reclaimed = await redis.hgetall(keys.hash.task(taskId));
    if (reclaimed.status !== 'failed') continue;
    failedTaskIds.push(taskId);
    await ensureRepairTask(redis, taskId, {
      source: 'worker_failed',
      reason: reclaimed.failed_reason === 'max_retries_exceeded'
        ? 'Worker 租约多次过期，已达到任务重试上限。'
        : 'Worker 租约过期后的回收失败。',
    });
  }
  return failedTaskIds;
}

export interface RuntimeReconciliationResult {
  reclaimed: string[];
  failed: string[];
  requeued: {
    waiting_file_release: string[];
    waiting_dependency: string[];
  };
}

/**
 * 低资源、幂等的运行态 reconciliation。
 *
 * 它不领取业务任务，只回收已经过期的 running lease；因此可由共享 Supervisor 按其唯一
 * 低频节拍调用。Redis CAS 同时写一次 task_ready，重复/并发调用不会重复恢复或重复鸣铃。
 */
async function reconcileRuntimeStateUnlocked(redis: Redis): Promise<ApiResponse<RuntimeReconciliationResult>> {
  const reclaimed = await lazyReclaimTaskIds(redis);
  const failed = await finalizeReclaimedTasks(redis, reclaimed);
  const requeued = await reconcileBlockedWaiters(redis);
  return {
    ok: true,
    data: {
      reclaimed,
      failed,
      requeued,
    },
  };
}

export async function reconcileRuntimeState(redis: Redis): Promise<ApiResponse<RuntimeReconciliationResult>> {
  return withMutationPermit(redis, () => reconcileRuntimeStateUnlocked(redis));
}

/** claim（核心，对应 06 号 md 完整流程） */
async function claimUnlocked(redis: Redis, req: ClaimRequest): Promise<ApiResponse<ClaimedTask | null>> {
  // 懒回收本身会释放文件 ownership。仅在实际有回收时检查 file waiter，避免每次
  // 无关 claim 扫描 blocked 队列；Question / dependency 等其它阻塞原因绝不受此影响。
  const reclaimedTaskIds = await lazyReclaimTaskIds(redis);
  await finalizeReclaimedTasks(redis, reclaimedTaskIds);
  if (reclaimedTaskIds.length > 0) await requeueFileWaiters(redis);

  // 一个 agent 只能持有一个 running 任务。
  const runningIds = await redis.zrange(keys.zset.status.running, 0, -1);
  for (const tid of runningIds) {
    const owner = await redis.hget(keys.hash.task(tid), 'claimed_by');
    if (owner === req.agent_id) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'AGENT_BUSY',
          message: `agent ${req.agent_id} 已有 running task ${tid}，完成或 report 后才能领新任务`,
        },
      };
    }
  }

  const agent = await redis.hgetall(keys.hash.agent(req.agent_id));
  const agentType = agent.agent_type ?? '';

  const tryCandidates = async (): Promise<ClaimedTask | null> => {
    // Stream 只做唤醒通道；zset/hash 才是调度真相源，过滤不会消费或丢弃任务。
    const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
    const candidates: TaskRecord[] = [];
    for (const taskId of pendingIds) {
      const hash = await redis.hgetall(keys.hash.task(taskId));
      if (!hash.task_id || hash.status !== 'pending') continue;
      candidates.push(hashToTaskRecord(hash));
    }
    candidates.sort(
      (a, b) =>
        (b.priority ?? 5) - (a.priority ?? 5) ||
        (a.created_at ?? 0) - (b.created_at ?? 0) ||
        a.task_id.localeCompare(b.task_id),
    );

    for (const task of candidates) {
      const assignee = task.assignee || 'auto';
      if (assignee !== 'auto' && assignee !== req.agent_id && assignee !== agentType) continue;
      if (req.preferred_types?.length && !req.preferred_types.includes(task.type)) continue;
      if (req.preferred_phases?.length && !req.preferred_phases.includes(task.phase)) continue;
      if (req.preferred_project && task.project_path !== req.preferred_project) continue;
      // Supervisor 指定 --plans 时必须在服务端领取前收窄范围；不能先把同项目的
      // 其它 plan 领走再由客户端退回，否则会短暂占有 lease / ownership。
      if (req.preferred_plan_ids?.length && !req.preferred_plan_ids.includes(task.plan_id)) continue;
      if (!(await checkDependencies(redis, task)).ok) continue;

      // 领取阶段即阻止普通自验收与 reverify 自验收；后者还要排除 repair/旧验收执行者。
      if (await acceptanceReviewerConflictTask(redis, task, req.agent_id)) continue;

      const claimToken = generateToken();
      const leaseKey = keys.string.lease(task.task_id);
      const timeoutSeconds = task.timeout_seconds ?? 1800;
      const acquired = await redis.set(leaseKey, claimToken, 'EX', timeoutSeconds, 'NX');
      if (acquired !== 'OK') continue;

      const ownershipFiles = task.ownership?.files ?? [];
      if (ownershipFiles.length > 0) {
        const baseSha = await getGitHeadSha(task.project_path).catch(() => '');
        const ownershipAcquired = await activateOwnership(
          redis,
          req.agent_id,
          task.task_id,
          task.priority ?? 5,
          ownershipFiles,
          timeoutSeconds,
          baseSha,
        );
        if (!ownershipAcquired) {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            leaseKey,
            claimToken,
          );
          continue;
        }
      }

      const now = Date.now();
      const expireAt = now + timeoutSeconds * 1000;
      const tx = redis.multi();
      tx.zrem(keys.zset.status.pending, task.task_id);
      tx.zadd(keys.zset.status.running, runningScore(expireAt), task.task_id);
      tx.hset(keys.hash.task(task.task_id), {
        status: 'running',
        claimed_at: String(now),
        claimed_by: req.agent_id,
        expire_at: String(expireAt),
      });
      tx.hset(keys.hash.agent(req.agent_id), 'current_task', task.task_id, 'status', 'busy');
      tx.xadd(
        keys.stream.events,
        '*',
        'event_id',
        `${now}_claim_${task.task_id}`,
        'type',
        'task_claimed',
        'task_id',
        task.task_id,
        'agent_id',
        req.agent_id,
        'plan_id',
        task.plan_id,
      );
      await tx.exec();

      sqliteStore?.updateTaskFields(task.task_id, {
        status: 'running',
        claimed_by: req.agent_id,
        claimed_at: String(now),
        expire_at: String(expireAt),
      });

      // last_question_* 是 task hash 的运行时上下文，不在 TaskRecord 投影中；
      // 领取已经提交后再读一次，避免引用候选收集循环中已离开作用域的 hash。
      const questionId = await redis.hget(keys.hash.task(task.task_id), 'last_question_id');
      const questionAnswer = await redis.hget(keys.hash.task(task.task_id), 'last_question_answer');

      return {
        task_id: task.task_id,
        title: task.title,
        type: task.type,
        phase: task.phase,
        priority: task.priority ?? 5,
        ownership_files: ownershipFiles,
        goal_md: task.goal_md,
        timeout_seconds: timeoutSeconds,
        claim_token: claimToken,
        verify: task.verify ?? [],
        project_path: task.project_path,
        plan_id: task.plan_id,
        // 若该任务是因 Question 被回答而回到 pending，附带回答上下文（PM 的答复 + checkpoint）。
        // candidates 里的 TaskRecord 不保留该运行时字段，因此从 task hash 读取。
        question_answer: questionAnswer || undefined,
        question_id: questionId || undefined,
        question_checkpoint: questionId
          ? (await redis.hget(keys.hash.question(questionId), 'checkpoint')) || undefined
          : undefined,
      };
    }
    return null;
  };

  const immediate = await tryCandidates();
  if (immediate || req.blocking !== true) return { ok: true, data: immediate };

  // 阻塞模式只等待一次有界唤醒，唤醒后重新按 zset 真实优先级选择。
  await redis.xread(
    'COUNT',
    1,
    'BLOCK',
    Math.max(1, req.timeout_ms ?? 30000),
    'STREAMS',
    keys.stream.tasks,
    '$',
  );
  return { ok: true, data: await tryCandidates() };
}

export async function claim(redis: Redis, req: ClaimRequest): Promise<ApiResponse<ClaimedTask | null>> {
  return withMutationPermit(redis, () => claimUnlocked(redis, req));
}

/** report（核心） */
async function reportUnlocked(
  redis: Redis,
  req: ReportRequest,
): Promise<ApiResponse<{
  task_id: string;
  status: string;
  fix_tasks_generated?: string[];
  resolution?: {
    state: 'required' | 'repairing' | 'needs_pm_decision';
    action: 'repair' | 'reverify' | 'inspect';
    source_task_id: string;
    repair_task_id?: string;
  };
}>> {
  const leaseKey = keys.string.lease(req.task_id);
  const storedToken = await redis.get(leaseKey);
  if (storedToken !== req.claim_token) {
    return {
      ok: false,
      data: null,
      error: { code: 'CLAIM_TOKEN_INVALID', message: '租约 token 无效或已过期' },
    };
  }

  const taskHash = await redis.hgetall(keys.hash.task(req.task_id));
  const agentId = req.agent_id;
  if (!taskHash.task_id || taskHash.status !== 'running') {
    return {
      ok: false,
      data: null,
      error: { code: 'TASK_NOT_RUNNING', message: `任务 ${req.task_id} 不在 running 状态` },
    };
  }
  if (taskHash.claimed_by && taskHash.claimed_by !== agentId) {
    return {
      ok: false,
      data: null,
      error: { code: 'CLAIM_OWNER_MISMATCH', message: `任务属于 ${taskHash.claimed_by}，不能由 ${agentId} report` },
    };
  }

  const reportFailureReason = req.status === 'done'
    ? ''
    : failureReasonForReport(req.status, req.verify_results ?? []);

  let resultPath = req.result_path ?? '';
  let resultJsonPath = req.result_json_path ?? '';

  // 所有 done 闸门都在 lease/ownership/状态变更之前执行。
  if (req.status === 'done') {
    let declaredVerify: Array<{ cmd: string; expect_exit?: number }> = [];
    try {
      declaredVerify = taskHash.verify ? JSON.parse(taskHash.verify) : [];
    } catch {
      return {
        ok: false,
        data: null,
        error: { code: 'VERIFY_DECLARATION_INVALID', message: '任务 verify 声明不是有效 JSON' },
      };
    }
    const verifyResults = req.verify_results ?? [];
    if (declaredVerify.length > 0 && verifyResults.length === 0) {
      return {
        ok: false,
        data: null,
        error: { code: 'VERIFY_RESULTS_REQUIRED', message: 'report done 必须上报任务声明的全部 verify 结果' },
      };
    }
    if (
      declaredVerify.length > 0 &&
      (declaredVerify.length !== verifyResults.length ||
        declaredVerify.some(
          (declared, index) =>
            declared.cmd !== verifyResults[index]?.cmd ||
            (declared.expect_exit ?? 0) !== verifyResults[index]?.exit_code,
        ))
    ) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'VERIFY_RESULTS_MISMATCH',
          message: 'report done 的 verify_results 必须与声明的 cmd/expect_exit 逐项完整匹配',
        },
      };
    }
    const verifyFailed = verifyResults.some((v) => !v.passed);
    if (verifyFailed) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'VERIFY_FAILED',
          message: `report done 被拒：verify 命令有失败项，必须 report failed。失败的 verify：${verifyResults.filter((v) => !v.passed).map((v) => v.cmd).join(', ')}`,
        },
      };
    }

    if (taskHash.type === 'acceptance') {
      if (verifyResults.length === 0) {
        return {
          ok: false,
          data: null,
          error: { code: 'ACCEPTANCE_VERIFY_REQUIRED', message: '验收任务 done 必须包含至少一项通过的验证结果' },
        };
      }
      if (!resultPath) {
        return {
          ok: false,
          data: null,
          error: { code: 'ACCEPTANCE_RESULT_REQUIRED', message: '验收任务 done 必须提供受控 result_path' },
        };
      }
      const conflictTaskId = await acceptanceReviewerConflictTask(redis, hashToTaskRecord(taskHash), agentId);
      if (conflictTaskId) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'SELF_REVIEW_FORBIDDEN',
            message: `验收违规：agent ${agentId} 参与过 ${conflictTaskId}，不能执行 ${req.task_id}。验收及复验必须由独立视角执行。`,
          },
        };
      }
      try {
        const md = readValidatedTaskArtifact(
          resultPath,
          taskHash.project_path,
          req.task_id,
          'result.md',
        );
        if (!/[✅❌⚠]|PASS|FAIL|通过|不通过/.test(md)) {
          throw new Error('result.md 缺少逐项验收结论');
        }
      } catch (e) {
        const artifactError = e as Error & { code?: string };
        return {
          ok: false,
          data: null,
          error: {
            code: artifactError.code === 'WORKSPACE_PATH_DENIED'
              ? 'RESULT_PATH_OUTSIDE_WORKSPACE'
              : 'ACCEPTANCE_INCOMPLETE',
            message: `验收任务 report done 被拒：${artifactError.message}`,
          },
        };
      }
    }
  }

  // 语义闸门之后再校验产物路径，使缺 verify/result 等错误保持稳定；但仍在任何
  // lease/ownership/状态变更之前，因此不可信路径绝不会消耗 Worker 的运行态。
  try {
    const roots = configuredWorkspaceRoots();
    const projectPath = resolveAndValidateWorkspacePath(taskHash.project_path, roots);
    if (resultPath) {
      resultPath = resolveAndValidateTaskArtifactPath(resultPath, projectPath, req.task_id, 'result.md');
    }
    if (resultJsonPath) {
      resultJsonPath = resolveAndValidateTaskArtifactPath(resultJsonPath, projectPath, req.task_id, 'result.json');
    }
  } catch (e) {
    return {
      ok: false,
      data: null,
      error: { code: 'RESULT_PATH_OUTSIDE_WORKSPACE', message: (e as Error).message },
    };
  }

  // Redis WATCH 是连接级状态。report 不能复用 Fastify 的共享 Redis client，否则并发
  // report/claim/renew 可能互相 EXEC 或 UNWATCH，导致第二个旧 report 穿透状态机。
  // 用专用连接把最终 token、owner、running 状态校验与终态写入放在同一 CAS 边界。
  const finalStatus = req.status === 'done' ? 'done' : 'failed';
  const pmConsumer = req.status === 'done'
    ? await resolvePmConsumer(redis, taskHash.plan_id ?? '')
    : '';
  const taskKey = keys.hash.task(req.task_id);
  const isolated = redis.duplicate();
  let committedAt = 0;
  try {
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      await isolated.watch(leaseKey, taskKey);
      try {
        const [currentToken, currentTaskHash] = await Promise.all([
          isolated.get(leaseKey),
          isolated.hgetall(taskKey),
        ]);
        if (currentToken !== req.claim_token) {
          return {
            ok: false,
            data: null,
            error: { code: 'CLAIM_TOKEN_INVALID', message: '租约 token 无效或已过期' },
          };
        }
        if (!currentTaskHash.task_id || currentTaskHash.status !== 'running') {
          return {
            ok: false,
            data: null,
            error: { code: 'TASK_NOT_RUNNING', message: `任务 ${req.task_id} 不在 running 状态` },
          };
        }
        if (currentTaskHash.claimed_by !== agentId) {
          return {
            ok: false,
            data: null,
            error: { code: 'CLAIM_OWNER_MISMATCH', message: `任务属于 ${currentTaskHash.claimed_by || '?'}，不能由 ${agentId} report` },
          };
        }

        const now = Date.now();
        const reviewEventId = `${now}_review_${req.task_id}`;
        const tx = isolated.multi();
        tx.del(leaseKey);
        tx.zrem(keys.zset.status.running, req.task_id);
        if (req.status === 'done') {
          tx.zadd(keys.zset.status.done, now, req.task_id);
          // “done 但未 PM Review”是持久状态，不可只依赖 transient event；ack 后仍由
          // 该索引让 intake 展示待验收事实。它和下面的门铃在同一 CAS 提交。
          tx.zadd(keys.reviewRequested.pending, now, req.task_id);
          // 防"秒 report"（bpi-04）：claim→report 间隔 < 10s 标记可疑（真实代码任务不可能秒完）
          const claimedAt = Number(currentTaskHash.claimed_at ?? '0');
          const durationSec = claimedAt > 0 ? Math.round((now - claimedAt) / 1000) : -1;
          const suspicious = durationSec >= 0 && durationSec < 10;
          const suspiciousFields: Record<string, string> = {};
          if (suspicious) {
            suspiciousFields.suspicious_fast_report = 'true';
            suspiciousFields.report_duration_sec = String(durationSec);
          }
          tx.hset(taskKey, {
            status: 'done',
            result_path: resultPath,
            result_json_path: resultJsonPath,
            verify_results: JSON.stringify(req.verify_results ?? []),
            done_at: String(now),
            failed_reason: '',
            ...suspiciousFields,
          });
        } else {
          tx.zadd(keys.zset.status.failed, now, req.task_id);
          tx.hset(taskKey, {
            status: 'failed',
            result_path: resultPath,
            result_json_path: resultJsonPath,
            verify_results: JSON.stringify(req.verify_results ?? []),
            done_at: String(now),
            failed_reason: reportFailureReason,
          });
        }
        // 事件写入（兼容 + 语义化）：
        //   - task_completed：保留旧事件类型，旧 CLI/SSE 消费者不中断（含 result_status）。
        //   - review_requested：仅在 done（需 PM 签核）时追加，携带路由字段。
        tx.xadd(
          keys.stream.events,
          '*',
          'event_id',
          `${now}_${req.task_id}`,
          'type',
          'task_completed',
          'task_id',
          req.task_id,
          'plan_id',
          currentTaskHash.plan_id ?? '',
          'project_path',
          currentTaskHash.project_path ?? '',
          'agent_id',
          agentId,
          'result_status',
          req.status,
          'acked',
          'false',
          'timestamp',
          String(now),
        );
        // done 即进入待 PM 签核状态（验收/通过由 PM 主动决策，平台不自动 accept）
        if (req.status === 'done') {
          // 当前实现直接生成门铃，因此同时写入恢复索引。这样下一轮历史恢复不会为
          // 新任务重复补发；event_id 映射也让 ack 后的持续状态使用同一去重键。
          tx.sadd(keys.reviewRequested.fired, req.task_id);
          tx.hset(keys.reviewRequested.eventByTask, req.task_id, reviewEventId);
          tx.xadd(
            keys.stream.events,
            '*',
            'event_id',
            reviewEventId,
            'type',
            'review_requested',
            'task_id',
            req.task_id,
            'plan_id',
            currentTaskHash.plan_id ?? '',
            'project_path',
            currentTaskHash.project_path ?? '',
            'agent_id',
            agentId,
            'consumer',
            pmConsumer,
            'result_status',
            req.status,
            'timestamp',
            String(now),
            'acked',
            'false',
          );
        }
        tx.hset(keys.hash.agent(agentId), 'current_task', '', 'status', 'idle');
        if ((await tx.exec()) !== null) {
          committedAt = now;
          break;
        }
      } finally {
        // EXEC 自动清理 watch；显式清理覆盖返回/重试路径。
        await isolated.unwatch().catch(() => undefined);
      }
    }
  } finally {
    isolated.disconnect();
  }
  if (committedAt === 0) {
    return {
      ok: false,
      data: null,
      error: { code: 'REPORT_RACE_RETRY_EXHAUSTED', message: 'report 提交期间状态持续变化，请重新获取任务后重试' },
    };
  }

  const releasedOwnership = await releaseOwnershipByAgent(redis, agentId, req.task_id);
  // 释放 ownership 是 event-driven 的唤醒点：只检查 blocked/waiting_file_release，
  // 不需要常驻扫描，也绝不会触碰 waiting_pm_reply。
  if (releasedOwnership > 0) await requeueFileWaiters(redis);

  // SQLite 双写：report 时 status → done/failed + result 路径
  if (sqliteStore) {
    sqliteStore.updateTaskFields(req.task_id, {
      status: finalStatus,
      result_path: resultPath,
      result_json_path: resultJsonPath,
      verify_results: JSON.stringify(req.verify_results ?? []),
      done_at: String(committedAt),
    });
  }

  const reportedTaskHash = await redis.hgetall(keys.hash.task(req.task_id));
  // 一个 repair 自己 done 后，来源状态从 repairing 转为 required。PM 只收到 repair
  // 的 review_requested，不需要再为同一件事多一条 resolution 门铃。
  if (req.status === 'done' && reportedTaskHash.fix_for) {
    await markRepairAwaitingReview(redis, req.task_id);
  }

  // `done` 只产生 review_requested；普通下游须等待 PM accepted。唯一例外是
  // acceptance 任务，它可以在原任务 done 后独立验证，避免验收自身被 PM review 卡住。
  if (req.status === 'done') await wakeDependents(redis, req.task_id, { allowAcceptance: true });

  // 失败统一进入可审计 repair 分派。普通 code 失败、独立 acceptance 失败和 repair
  // 自身失败都走此处；不再让任一失败孤立在 failed 桶里等待人工盯盘。
  const verifyFailed = (req.verify_results ?? []).some((v) => !v.passed);
  if (req.status !== 'done') {
    const failures = summarizeVerifyFailures(req.verify_results ?? []);
    // acceptance 是针对一个或多个原实现的验收：修复源是原实现，而不是失败的
    // acceptance task；这样 repair 不会依赖 failed acceptance 形成 DAG 死锁。
    if (reportedTaskHash.type === 'acceptance') {
      const acceptanceFor = acceptanceSourceIds(reportedTaskHash);
      if (acceptanceFor.length === 0) {
        await markResolutionNeedsPmDecision(
          redis,
          req.task_id,
          `acceptance_source_missing:${req.task_id}`,
        );
        return {
          ok: true,
          data: {
            task_id: req.task_id,
            status: req.status,
            resolution: {
              state: 'needs_pm_decision',
              action: 'inspect',
              source_task_id: req.task_id,
            },
          },
        };
      }
      const fixTasksGenerated: string[] = [];
      let needsPmDecision = false;
      for (const origTaskId of acceptanceFor) {
        const resolution = await ensureRepairTask(redis, origTaskId, {
          source: 'acceptance_failed',
          reason: `独立验收任务 ${req.task_id} 失败。`,
          failures,
          decisionRootTaskId: reportedTaskHash.repair_root_task_id || reportedTaskHash.task_id,
        });
        if (resolution.repairTaskId) fixTasksGenerated.push(resolution.repairTaskId);
        if (resolution.state === 'needs_pm_decision') needsPmDecision = true;
      }
      // failed acceptance 也要保留“等来源 repair 收敛”的状态；否则来源修好了，
      // acceptance 自己仍留在 failed 桶，整个 plan 无法自动完成。
      await markAcceptanceFailureResolution(redis, req.task_id, fixTasksGenerated, needsPmDecision);
      // 保留旧响应字段，让现有 CLI/集成不需要猜新的 repair id。
      return {
        ok: true,
        data: { task_id: req.task_id, status: req.status, fix_tasks_generated: [...new Set(fixTasksGenerated)] },
      };
    }
    const resolution = await ensureRepairTask(redis, req.task_id, {
      source: 'worker_failed',
      reason: verifyFailed ? '任务声明的 verify 未通过。' : 'Worker 上报 failed/partial。',
      failures,
    });
    return {
      ok: true,
      data: {
        task_id: req.task_id,
        status: req.status,
        resolution: {
          state: resolution.state,
          action: resolution.action,
          source_task_id: resolution.rootTaskId,
          repair_task_id: resolution.repairTaskId,
        },
      },
    };
  }

  return { ok: true, data: { task_id: req.task_id, status: req.status } };
}

export async function report(redis: Redis, req: ReportRequest) {
  return withMutationPermit(redis, () => reportUnlocked(redis, req));
}

/** ownership check */
export async function ownershipCheck(
  redis: Redis,
  path: string,
  agentId: string,
): Promise<ApiResponse<OwnershipCheckResult>> {
  // 取 agent 当前任务的 priority（简化：从 task hash 查）
  const agentHash = await redis.hgetall(keys.hash.agent(agentId));
  let myPriority = 5;
  if (agentHash.current_task) {
    const taskHash = await redis.hget(keys.hash.task(agentHash.current_task), 'priority');
    if (taskHash) myPriority = Number(taskHash);
  }
  const result = await checkOwnership(redis, path, agentId, myPriority);
  return { ok: true, data: result };
}

/** ownership declare */
export async function ownershipDeclare(
  redis: Redis,
  agentId: string,
  taskId: string,
  claimToken: string,
  files: string[],
  force = false,
): Promise<ApiResponse<unknown>> {
  return withOwnershipTransaction(redis, agentId, taskId, claimToken, async (isolated, task, now, leaseTtlMs) => {
    // priority 是调度真相的一部分，只能从当前 task hash 读取；不能信任 HTTP/SDK 调用者。
    const priority = Number(task.priority ?? 5);
    const allFields = await isolated.hgetall(keys.hash.fileOwnership);
    const liveOverlaps: Array<{ glob: string; owner: { agent_id: string; task_id: string; priority: number } }> = [];

    for (const [existingGlob, raw] of Object.entries(allFields)) {
      try {
        const owner = JSON.parse(raw) as {
          agent_id: string;
          task_id: string;
          priority: number;
          expires_at: number;
        };
        if (owner.expires_at <= now) continue;
        if (!files.some((requestedGlob) => globsOverlap(existingGlob, requestedGlob))) continue;
        if (owner.agent_id === agentId && owner.task_id === taskId) continue;
        liveOverlaps.push({ glob: existingGlob, owner });
      } catch {
        // 损坏记录不构成可信活跃 ownership；下一次合法声明会覆盖其精确 glob。
      }
    }

    const blocker = liveOverlaps.find(({ owner }) => !force || priority <= owner.priority);
    if (blocker) {
      return {
        ok: false,
        data: null,
        error: {
          code: force ? 'OWNERSHIP_PRIORITY_CONFLICT' : 'OWNERSHIP_CONFLICT',
          message: force
            ? '抢占被拒：存在同等或更高优先级的重叠 ownership'
            : '声明被拒：存在活跃的重叠 ownership，需等待释放或显式抢占',
        },
      };
    }

    const tx = isolated.multi();
    for (const { glob, owner } of liveOverlaps) {
      tx.hdel(keys.hash.fileOwnership, glob);
      tx.srem(keys.set.ownerByAgent(owner.agent_id), glob);
      tx.lpush(
        keys.list.ownershipConflicts,
        JSON.stringify({
          ts: now,
          path: glob,
          winner: { agent_id: agentId, task_id: taskId, priority },
          loser: { agent_id: owner.agent_id, task_id: owner.task_id, priority: owner.priority },
          action: 'preempt',
        }),
      );
      tx.ltrim(keys.list.ownershipConflicts, 0, 999);
    }
    for (const glob of files) {
      tx.hset(keys.hash.fileOwnership, glob, JSON.stringify({
        agent_id: agentId,
        task_id: taskId,
        priority,
        declared_at: now,
        // ownership 必须不会比 claim 更长；否则一个已失效 Worker 仍可挡住后续任务。
        expires_at: now + leaseTtlMs,
        base_commit_sha: '',
        mode: 'exclusive-write',
      }));
      tx.sadd(keys.set.ownerByAgent(agentId), glob);
    }
    const committed = await tx.exec();
    if (committed === null) return undefined;
    return { ok: true, data: { declared: files.length } };
  });
}

/** ownership release */
export async function ownershipRelease(
  redis: Redis,
  agentId: string,
  taskId: string,
  claimToken: string,
  files: string[],
): Promise<ApiResponse<unknown>> {
  const result = await withOwnershipTransaction(redis, agentId, taskId, claimToken, async (isolated) => {
    const records = await Promise.all(files.map(async (glob) => [glob, await isolated.hget(keys.hash.fileOwnership, glob)] as const));
    const releasable = records.filter(([_, raw]) => {
      if (!raw) return false;
      try {
        const rec = JSON.parse(raw) as { agent_id?: string; task_id?: string };
        // release 不能根据仅 task_id 的可猜字段删除记录；必须同时匹配当前调用者。
        return rec.task_id === taskId && rec.agent_id === agentId;
      } catch {
        return false;
      }
    }).map(([glob]) => glob);

    const tx = isolated.multi();
    for (const glob of releasable) {
      tx.hdel(keys.hash.fileOwnership, glob);
      tx.srem(keys.set.ownerByAgent(agentId), glob);
    }
    const committed = await tx.exec();
    if (committed === null) return undefined;
    return { ok: true, data: { released: releasable.length } };
  });
  if (result.ok && result.data && (result.data as { released?: number }).released! > 0) await requeueFileWaiters(redis);
  return result;
}

type OwnershipMutationError = { ok: false; data: null; error: { code: string; message: string } };
type OwnershipHolderValidation = { ok: true; task: Record<string, string>; leaseTtlMs: number } | OwnershipMutationError;

/**
 * ownership mutation 的授权锚点。
 *
 * 不使用共享 Redis 连接的 WATCH：调用方通过 withOwnershipTransaction 在专用连接上
 * watch task、lease 与 registry，并把校验和 mutation 放入同一 CAS 边界。这样 report /
 * reset / 过期回收不能在校验通过后插入并让旧 Worker 改动 ownership registry。
 */
function validateOwnershipHolder(
  task: Record<string, string>,
  lease: string | null,
  leaseTtlMs: number,
  agentId: string,
  taskId: string,
  claimToken: string,
): OwnershipHolderValidation {
  if (!task.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  if (task.status !== 'running') {
    return { ok: false, data: null, error: { code: 'TASK_NOT_RUNNING', message: '只有 running 任务可操作 ownership' } };
  }
  if (task.claimed_by !== agentId) {
    return { ok: false, data: null, error: { code: 'CLAIM_OWNER_MISMATCH', message: '任务不属于当前 Worker' } };
  }
  if (lease !== claimToken || leaseTtlMs <= 0) {
    return { ok: false, data: null, error: { code: 'CLAIM_TOKEN_INVALID', message: 'claim_token 无效或已过期' } };
  }
  return { ok: true, task, leaseTtlMs };
}

/**
 * 为 ownership mutation 建立独占事务连接。Redis WATCH 是连接级状态，不能借用 Fastify
 * 共用连接；每次调用只建一个短命连接，在 task/lease/registry 任一变动时重试。
 */
async function withOwnershipTransaction(
  redis: Redis,
  agentId: string,
  taskId: string,
  claimToken: string,
  mutate: (
    isolated: Redis,
    task: Record<string, string>,
    now: number,
    leaseTtlMs: number,
  ) => Promise<ApiResponse<unknown> | undefined>,
): Promise<ApiResponse<unknown>> {
  const isolated = redis.duplicate();
  const taskKey = keys.hash.task(taskId);
  const leaseKey = keys.string.lease(taskId);
  try {
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      await isolated.watch(taskKey, leaseKey, keys.hash.fileOwnership);
      try {
        const [task, lease, leaseTtlMs] = await Promise.all([
          isolated.hgetall(taskKey),
          isolated.get(leaseKey),
          isolated.pttl(leaseKey),
        ]);
        const holder = validateOwnershipHolder(task, lease, leaseTtlMs, agentId, taskId, claimToken);
        if (!holder.ok) return holder;
        const result = await mutate(isolated, holder.task, Date.now(), holder.leaseTtlMs);
        if (result) return result;
      } finally {
        // EXEC 后会自动 unwatch；显式调用覆盖校验失败/重试路径。
        await isolated.unwatch().catch(() => undefined);
      }
    }
    return {
      ok: false,
      data: null,
      error: { code: 'OWNERSHIP_RACE_RETRY_EXHAUSTED', message: 'ownership 并发更新过多，请重新检查后重试' },
    };
  } finally {
    isolated.disconnect();
  }
}

/** get task */
export async function getTask(redis: Redis, taskId: string): Promise<ApiResponse<TaskRecord | null>> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: true, data: null };
  }
  return { ok: true, data: hashToTaskRecord(hash) };
}

export interface TaskSupersedeRequest {
  reason: string;
  superseded_by: string;
  /** 防止脚本把缺少人工/Agent 决策的请求误当成迁移操作。 */
  confirmed: true;
}

export interface PlanSupersedeRequest extends TaskSupersedeRequest {
  /** 来自 previewPlanSupersede 的状态快照摘要；状态变化后必须重新预览。 */
  preview_token: string;
}

export interface PlanSupersedeBlocker {
  task_id: string;
  status: string;
  code: 'NON_TERMINAL_TASK' | 'ACTIVE_DEPENDENT';
  detail: string;
}

export interface PlanSupersedePreview {
  plan_id: string;
  candidate_task_ids: string[];
  blockers: PlanSupersedeBlocker[];
  preview_token: string;
}

function supersedeValidation(req: Partial<TaskSupersedeRequest>): { code: string; message: string } | null {
  if (req.confirmed !== true) {
    return { code: 'SUPERSEDE_CONFIRMATION_REQUIRED', message: 'supersede 是不可逆终止操作，必须显式 confirmed=true。' };
  }
  if (!req.reason?.trim()) {
    return { code: 'SUPERSEDE_REASON_REQUIRED', message: 'supersede 必须记录非空 reason。' };
  }
  if (req.reason.trim().length > 2_000) {
    return { code: 'SUPERSEDE_REASON_TOO_LONG', message: 'supersede reason 最长 2000 字符。' };
  }
  if (!req.superseded_by?.trim()) {
    return { code: 'SUPERSEDED_BY_REQUIRED', message: 'supersede 必须记录 superseded_by。' };
  }
  if (req.superseded_by.trim().length > 128) {
    return { code: 'SUPERSEDED_BY_TOO_LONG', message: 'superseded_by 最长 128 字符。' };
  }
  return null;
}

function isSupersedeCandidate(hash: Record<string, string>): boolean {
  return hash.status === 'done' &&
    !(hash.pm_review_status ?? '').trim() &&
    !(hash.resolution_status ?? '').trim();
}

function taskDependsOn(hash: Record<string, string>, taskId: string): boolean {
  return (hash.depends_on ?? '').split(',').filter(Boolean).includes(taskId);
}

function isAbandonedTerminal(hash: Record<string, string>): boolean {
  return hash.status === 'cancelled' || hash.status === 'superseded';
}

async function allTaskHashes(redis: Redis): Promise<Record<string, string>[]> {
  const taskKeys = await scanKeys(redis, `${PREFIX}:hash:task:*`);
  const hashes = await Promise.all(taskKeys.map((key) => redis.hgetall(key)));
  return hashes.filter((hash) => Boolean(hash.task_id));
}

async function activeDependents(
  redis: Redis,
  taskIds: Set<string>,
  allowedDependents: Set<string> = new Set(),
): Promise<Record<string, string>[]> {
  const tasks = await allTaskHashes(redis);
  return tasks
    .filter((task) => !allowedDependents.has(task.task_id))
    .filter((task) => !isAbandonedTerminal(task))
    .filter((task) => [...taskIds].some((taskId) => taskDependsOn(task, taskId)))
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
}

/**
 * review_requested 的 stream entry 是不可变审计；这里仅撤回各 consumer 的活跃投影。
 * 新 consumer 即使以后首次回放旧 stream，也会由 readConsumerPending 的状态校验丢弃，
 * 因而 supersede 不会通过历史门铃再次进入 PM 待办。
 */
async function withdrawReviewDoorbell(
  redis: Redis,
  taskId: string,
  eventId: string,
): Promise<void> {
  if (!eventId) return;
  const consumers = await redis.smembers(keys.ack.consumers);
  const historical = await findEventForAck(redis, eventId);
  for (const consumer of consumers) {
    const indexed = parseIndexedPendingEvent(
      await redis.hget(keys.ack.consumerPendingPayload(consumer), eventId),
    );
    const delivery = indexed ?? (
      historical && (historical.event.consumer ?? DEFAULT_PM_CONSUMER) === consumer
        ? historical
        : null
    );
    if (!delivery) continue;
    const tx = redis.multi();
    tx.zrem(keys.ack.consumerPending(consumer), pendingMember(delivery.stream_id, eventId));
    tx.hdel(keys.ack.consumerPendingPayload(consumer), eventId);
    const outcomes = await tx.exec();
    if (!outcomes || outcomes.some(([error]) => error)) {
      throw new Error(`failed to withdraw review doorbell task=${taskId} consumer=${consumer}`);
    }
  }
}

async function applySupersedeBatch(
  redis: Redis,
  hashes: Record<string, string>[],
  req: TaskSupersedeRequest,
  planBatch?: { planId: string; previewToken: string },
): Promise<void> {
  const now = Date.now();
  const reason = req.reason.trim();
  const supersededBy = req.superseded_by.trim();
  const reviewEvents = new Map<string, string>();
  for (const hash of hashes) {
    reviewEvents.set(hash.task_id, await redis.hget(keys.reviewRequested.eventByTask, hash.task_id) ?? '');
  }

  const tx = redis.multi();
  for (const hash of hashes) {
    tx.zrem(keys.zset.status.done, hash.task_id);
    tx.zadd(keys.zset.status.superseded, now, hash.task_id);
    // 只增加 terminal/audit 字段；done_at、result_path、verify_results 以及任何 PM 审计均不覆盖。
    tx.hset(keys.hash.task(hash.task_id), {
      status: 'superseded',
      superseded_at: String(now),
      superseded_by: supersededBy,
      superseded_reason: reason,
      ...(planBatch ? {
        supersede_preview_token: planBatch.previewToken,
        supersede_batch_size: String(hashes.length),
      } : {}),
    });
    tx.zrem(keys.reviewRequested.pending, hash.task_id);
    tx.srem(keys.reviewRequested.fired, hash.task_id);
    tx.hdel(keys.reviewRequested.eventByTask, hash.task_id);
    tx.srem(keys.acceptanceReady.fired, hash.task_id);
    tx.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_task_superseded_${hash.task_id}`,
      'type', 'task_superseded',
      'task_id', hash.task_id,
      'plan_id', hash.plan_id ?? '',
      'project_path', hash.project_path ?? '',
      'from_status', 'done',
      'superseded_by', supersededBy,
      'reason', reason,
      'timestamp', String(now),
    );
  }
  if (planBatch) {
    tx.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_plan_superseded_${planBatch.planId}`,
      'type', 'plan_tasks_superseded',
      'plan_id', planBatch.planId,
      'task_count', String(hashes.length),
      'preview_token', planBatch.previewToken,
      'superseded_by', supersededBy,
      'reason', reason,
      'timestamp', String(now),
    );
  }
  const outcomes = await tx.exec();
  if (!outcomes || outcomes.some(([error]) => error)) {
    throw new Error(`failed to persist supersede batch plan=${planBatch?.planId ?? hashes[0]?.plan_id ?? ''}`);
  }

  for (const hash of hashes) {
    await persistTaskFromRedis(redis, hash.task_id);
    await withdrawReviewDoorbell(redis, hash.task_id, reviewEvents.get(hash.task_id) ?? '');
  }
}

/**
 * 显式退出单个历史伪完成。只允许 done + review pending 且无 resolution 的任务；
 * 任何未一并退出的依赖者都会阻止操作，避免把下游留在无法解释的 DAG 状态。
 */
export async function supersedeTask(
  redis: Redis,
  taskId: string,
  req: TaskSupersedeRequest,
): Promise<ApiResponse<{ task_id: string; status: string; dependent_task_ids?: string[] }>> {
  const invalid = supersedeValidation(req);
  if (invalid) return { ok: false, data: null, error: invalid };
  const lockToken = await acquirePmReviewLock(redis, taskId);
  if (!lockToken) {
    return { ok: false, data: null, error: { code: 'TASK_SUPERSEDE_IN_PROGRESS', message: `任务 ${taskId} 正在执行另一条 PM 决策。` } };
  }
  try {
    const hash = await redis.hgetall(keys.hash.task(taskId));
    if (!hash.task_id) {
      return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
    }
    if (hash.status === 'superseded') {
      if (hash.superseded_by === req.superseded_by.trim() && hash.superseded_reason === req.reason.trim()) {
        // Redis 是先提交的运行时真相。若首次 SQLite 双写短暂失败，调用方会收到 500；
        // 相同决定的幂等重试必须重放持久副本，否则 Redis 丢失会把不可逆决定复活成 done。
        await persistTaskFromRedis(redis, taskId);
        return { ok: true, data: { task_id: taskId, status: 'superseded' } };
      }
      return {
        ok: false,
        data: null,
        error: {
          code: 'TASK_SUPERSEDE_ALREADY_RECORDED',
          message: `任务 ${taskId} 已有不可变 supersede 决定，不能覆盖首次操作者或原因。`,
        },
      };
    }
    if (!isSupersedeCandidate(hash)) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'TASK_NOT_SUPERSEDE_CANDIDATE',
          message: `只能退出 done + pending review 且未进入 resolution 的任务；当前 status=${hash.status} review=${hash.pm_review_status || 'pending'} resolution=${hash.resolution_status || 'none'}。`,
        },
      };
    }
    const dependents = await activeDependents(redis, new Set([taskId]));
    if (dependents.length > 0) {
      const dependentIds = dependents.map((task) => task.task_id);
      return {
        ok: false,
        data: { task_id: taskId, status: hash.status, dependent_task_ids: dependentIds },
        error: {
          code: 'TASK_HAS_ACTIVE_DEPENDENTS',
          message: `任务 ${taskId} 仍被以下非终态任务依赖：${dependentIds.join(', ')}。请使用经过预览的 plan supersede，或先显式处理依赖者。`,
          details: { dependent_task_ids: dependentIds },
        },
      };
    }
    await applySupersedeBatch(redis, [hash], req);
    return { ok: true, data: { task_id: taskId, status: 'superseded' } };
  } finally {
    await redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.pmReviewLock(taskId), lockToken);
  }
}

function stableSupersedeToken(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function buildPlanSupersedePreview(
  redis: Redis,
  planId: string,
): Promise<{ planExists: boolean; preview: PlanSupersedePreview; candidates: Record<string, string>[] }> {
  const plan = await redis.hgetall(keys.hash.plan(planId));
  const allTasks = await allTaskHashes(redis);
  const planTasks = allTasks
    .filter((task) => task.plan_id === planId)
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  const candidates = planTasks.filter(isSupersedeCandidate);
  const candidateIds = new Set(candidates.map((task) => task.task_id));
  const blockers: PlanSupersedeBlocker[] = [];

  for (const task of planTasks) {
    if (candidateIds.has(task.task_id) || isAbandonedTerminal(task)) continue;
    const completed = task.resolution_status === 'resolved' ||
      (task.status === 'done' && task.pm_review_status === 'accepted' && !task.resolution_status);
    if (!completed) {
      blockers.push({
        task_id: task.task_id,
        status: task.status,
        code: 'NON_TERMINAL_TASK',
        detail: `任务不属于 done + pending review 候选，也不是已验收/已解决终态（review=${task.pm_review_status || 'pending'}, resolution=${task.resolution_status || 'none'}）。`,
      });
    }
  }

  const dependents = await activeDependents(redis, candidateIds, candidateIds);
  for (const dependent of dependents) {
    blockers.push({
      task_id: dependent.task_id,
      status: dependent.status,
      code: 'ACTIVE_DEPENDENT',
      detail: `该任务依赖待 supersede 的 ${[...candidateIds].filter((id) => taskDependsOn(dependent, id)).join(', ')}，但不在同批候选中。`,
    });
  }
  blockers.sort((left, right) => left.task_id.localeCompare(right.task_id) || left.code.localeCompare(right.code));

  const snapshotTasks = allTasks
    .filter((task) => task.plan_id === planId || [...candidateIds].some((id) => taskDependsOn(task, id)))
    .map((task) => ({
      task_id: task.task_id,
      plan_id: task.plan_id,
      status: task.status,
      done_at: task.done_at ?? '',
      pm_review_status: task.pm_review_status ?? '',
      resolution_status: task.resolution_status ?? '',
      depends_on: (task.depends_on ?? '').split(',').filter(Boolean).sort(),
      superseded_at: task.superseded_at ?? '',
      supersede_preview_token: task.supersede_preview_token ?? '',
      supersede_batch_size: task.supersede_batch_size ?? '',
    }))
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  const preview = {
    plan_id: planId,
    candidate_task_ids: [...candidateIds].sort(),
    blockers,
    preview_token: stableSupersedeToken({ plan_id: planId, tasks: snapshotTasks, blockers }),
  };
  return { planExists: Boolean(plan.plan_id), preview, candidates };
}

/** 只读预览：列出会退出的 task、所有阻塞项和绑定当前状态的 SHA-256 token。 */
export async function previewPlanSupersede(
  redis: Redis,
  planId: string,
): Promise<ApiResponse<PlanSupersedePreview>> {
  const built = await buildPlanSupersedePreview(redis, planId);
  if (!built.planExists) {
    return { ok: false, data: null, error: { code: 'PLAN_NOT_FOUND', message: `Plan 不存在：${planId}` } };
  }
  return { ok: true, data: built.preview };
}

/**
 * 应用 Plan 预览快照。Plan 锁 + 候选 task PM 锁串行化验收决定；锁内再次计算 token，
 * 任何状态/依赖变化都会要求重新预览，不做隐式 cascade 或部分应用。
 */
export async function supersedePlan(
  redis: Redis,
  planId: string,
  req: PlanSupersedeRequest,
): Promise<ApiResponse<{ plan_id: string; superseded_task_ids: string[]; status: string }>> {
  const invalid = supersedeValidation(req);
  if (invalid) return { ok: false, data: null, error: invalid };
  if (!/^[a-f0-9]{64}$/.test(req.preview_token ?? '')) {
    return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_PREVIEW_REQUIRED', message: '必须提供 preview 返回的 64 位 preview_token。' } };
  }
  const planLockToken = randomUUID();
  const acquiredPlan = await redis.set(keys.string.planSupersedeLock(planId), planLockToken, 'PX', 30_000, 'NX');
  if (acquiredPlan !== 'OK') {
    return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_IN_PROGRESS', message: `Plan ${planId} 正在执行另一条 supersede 决策。` } };
  }
  const taskLocks: Array<{ taskId: string; token: string }> = [];
  try {
    const initial = await buildPlanSupersedePreview(redis, planId);
    if (!initial.planExists) {
      return { ok: false, data: null, error: { code: 'PLAN_NOT_FOUND', message: `Plan 不存在：${planId}` } };
    }
    // 批量 Redis MULTI 已提交、SQLite 逐项双写中途失败时，当前 preview 已因任务进入
    // superseded 而变化。用每个任务持久化的原 preview token 精确识别同一批决定，
    // 只补写副本，不重复写审计事件，也不接受相同 token 下的冲突操作者/原因。
    const replayTasks = (await allTaskHashes(redis))
      .filter((task) => task.plan_id === planId && task.status === 'superseded' && task.supersede_preview_token === req.preview_token)
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
    if (replayTasks.length > 0) {
      const expectedBatchSize = Number(replayTasks[0].supersede_batch_size ?? 0);
      const malformedBatch = !Number.isSafeInteger(expectedBatchSize) || expectedBatchSize <= 0 ||
        replayTasks.length !== expectedBatchSize ||
        replayTasks.some((task) => Number(task.supersede_batch_size ?? 0) !== expectedBatchSize);
      if (malformedBatch) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'PLAN_SUPERSEDE_REPLAY_INCOMPLETE',
            message: '已提交批次的任务标记不完整；拒绝部分补偿，请先恢复审计数据。',
          },
        };
      }
      const reason = req.reason.trim();
      const supersededBy = req.superseded_by.trim();
      if (replayTasks.some((task) => task.superseded_reason !== reason || task.superseded_by !== supersededBy)) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'PLAN_SUPERSEDE_ALREADY_RECORDED',
            message: '该 preview_token 已绑定其它不可变 supersede 操作者或原因，不能覆盖。',
          },
        };
      }
      for (const task of replayTasks) await persistTaskFromRedis(redis, task.task_id);
      const plan = (await getPlan(redis, planId)).data as { status?: string } | null;
      return {
        ok: true,
        data: {
          plan_id: planId,
          superseded_task_ids: replayTasks.map((task) => task.task_id),
          status: plan?.status ?? 'cancelled',
        },
      };
    }
    for (const taskId of initial.preview.candidate_task_ids) {
      const token = await acquirePmReviewLock(redis, taskId);
      if (!token) {
        return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_TASK_BUSY', message: `任务 ${taskId} 正在执行另一条 PM 决策。` } };
      }
      taskLocks.push({ taskId, token });
    }
    const current = await buildPlanSupersedePreview(redis, planId);
    if (current.preview.preview_token !== req.preview_token) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PLAN_SUPERSEDE_PREVIEW_STALE',
          message: 'Plan 状态或依赖关系自预览后已变化；未应用任何修改，请重新 preview。',
          details: current.preview,
        },
      };
    }
    if (current.preview.blockers.length > 0) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PLAN_SUPERSEDE_BLOCKED',
          message: `Plan ${planId} 有 ${current.preview.blockers.length} 个阻塞项；不会静默级联取消或部分应用。`,
          details: current.preview.blockers,
        },
      };
    }
    if (current.candidates.length === 0) {
      return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_EMPTY', message: `Plan ${planId} 没有 done + pending review 候选。` } };
    }
    await applySupersedeBatch(redis, current.candidates, req, { planId, previewToken: req.preview_token });
    const plan = (await getPlan(redis, planId)).data as { status?: string } | null;
    return {
      ok: true,
      data: {
        plan_id: planId,
        superseded_task_ids: current.preview.candidate_task_ids,
        status: plan?.status ?? 'cancelled',
      },
    };
  } finally {
    for (const lock of taskLocks.reverse()) {
      await redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.pmReviewLock(lock.taskId), lock.token);
    }
    await redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.planSupersedeLock(planId), planLockToken);
  }
}

/**
 * 返回已闭合 repair 链的根任务；不存在已闭合 repair 审计时返回空字符串。
 *
 * repair task 本身不会写 `resolution_status=resolved`，而是通过 `repair_root_task_id`
 * 指回来源。因此 reset 不能只检查当前 task：否则可以先保留来源、再把已验收 repair 的
 * result / PM review 清空，最终仍会破坏同一条 failed/rejected 的证据链。兼容旧数据时
 * 还沿 `fix_for` 向上追溯，最多 32 层以避免损坏数据中的循环链无限读取。
 */
async function resolvedRepairRootForReset(
  redis: Redis,
  taskId: string,
  initial: Record<string, string>,
): Promise<string> {
  let currentTaskId = taskId;
  let current = initial;
  const visited = new Set<string>();

  for (let depth = 0; depth < 32; depth++) {
    if (!current.task_id || visited.has(currentTaskId)) break;
    visited.add(currentTaskId);

    if (current.resolution_status === 'resolved') return current.task_id;

    const rootTaskId = current.repair_root_task_id?.trim();
    if (rootTaskId && !visited.has(rootTaskId)) {
      const root = await redis.hgetall(keys.hash.task(rootTaskId));
      if (root.task_id && root.resolution_status === 'resolved') return root.task_id;
    }

    const parentTaskId = current.fix_for?.trim();
    if (!parentTaskId) break;
    currentTaskId = parentTaskId;
    current = await redis.hgetall(keys.hash.task(currentTaskId));
  }
  return '';
}

/** 重置任务到 pending（PM 手动操作，对应 P22）
 *  - 任意状态（running/done/failed）→ pending
 *  - cancelled 是终态，不能 reset
 *  - done/failed 的 reset 需要 force=true（防误操作）
 *  - 释放 lease + ownership + 改状态 + 重新入流
 *  - 写审计字段（reset_at / reset_by / reset_from_status）
 */
export async function taskReset(
  redis: Redis,
  taskId: string,
  req: { force?: boolean; reset_by?: string },
): Promise<ApiResponse<{ task_id: string; from_status: string; to_status: string }>> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }

  const fromStatus = hash.status;

  // cancelled / superseded 是终态，不能 reset；后者尤其不能借 reset 清空历史结果。
  if (fromStatus === 'cancelled' || fromStatus === 'superseded') {
    return {
      ok: false,
      data: null,
      error: { code: 'TASK_TERMINAL', message: `任务 ${taskId} 已进入 ${fromStatus} 终态，不能 reset。如需重做请新建任务。` },
    };
  }

  // done/failed 需要 --force
  if ((fromStatus === 'done' || fromStatus === 'failed') && !req.force) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'FORCE_REQUIRED',
        message: `任务 ${taskId} 当前状态为 ${fromStatus}，reset 需要 --force 参数（防误操作）`,
      },
    };
  }

  // 自动 repair/reverify 已经持有这个失败事实的后续控制权。直接 reset 原任务会让
  // 原任务和 repair 并行执行，既破坏 ownership 也会把 plan 状态写成互相矛盾的两条线。
  // 当前 repair task 自身（没有 resolution_status）仍可被 PM 有意识地 reset。
  if (['repairing', 'required', 'needs_pm_decision'].includes(hash.resolution_status ?? '')) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'RESOLUTION_ACTIVE',
        message: `任务 ${taskId} 已进入自动修复闭环，请处理当前 repair task 或在平台中完成 PM 决策后再 reset。`,
      },
    };
  }

  // repair 已被独立 PM Review 接受后，来源仍保留 failed/rejected，repair 本身仍保留
  // accepted 与 verify 证据。两端任一 reset 都会让这条审计链不再可复核，因此即使
  // --force 也必须拒绝；需要再次工作时创建一条新的任务/修复链。
  const resolvedRepairRoot = await resolvedRepairRootForReset(redis, taskId, hash);
  if (resolvedRepairRoot) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'RESOLUTION_AUDIT_IMMUTABLE',
        message: `任务 ${taskId} 属于已闭合的修复链（根任务 ${resolvedRepairRoot}）。为保留 failed/rejected、PM Review、修复与验证审计，禁止 reset（包括 --force）；如需重做请新建任务。`,
      },
    };
  }

  // 已经是 pending，无需 reset
  if (fromStatus === 'pending') {
    return { ok: true, data: { task_id: taskId, from_status: 'pending', to_status: 'pending' } };
  }

  const now = Date.now();

  // 当前 review 轮次被 reset 后必须清空持续待办和门铃去重。下次重新 done 会产生
  // 新 event_id，不能被上一轮已经 ack 的 event_id 静音。
  await redis.zrem(keys.reviewRequested.pending, taskId);
  await redis.srem(keys.reviewRequested.fired, taskId);
  await redis.hdel(keys.reviewRequested.eventByTask, taskId);

  // 1. 删除 lease
  await redis.del(keys.string.lease(taskId));

  // 2. 从当前状态 zset 移除
  const fromZset = (keys.zset.status as Record<string, string>)[fromStatus];
  if (fromZset) {
    await redis.zrem(fromZset, taskId);
  }

  // 3. 添加到 pending zset
  const priority = Number(hash.priority ?? 5);
  const score = pendingScore(priority, now);
  await redis.zadd(keys.zset.status.pending, score, taskId);

  // 4. 更新 task hash + 审计字段
  await redis.hset(keys.hash.task(taskId), {
    status: 'pending',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '',
    verify_results: '[]',
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    failed_reason: '',
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: '0',
    resolution_attempts: '0',
    suspicious_fast_report: '',
    report_duration_sec: '',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    retries: String((Number(hash.retries ?? 0)) + 1),
    reset_at: String(now),
    reset_by: req.reset_by ?? 'pm',
    reset_from_status: fromStatus,
  });
  sqliteStore?.updateTaskFields(taskId, {
    status: 'pending',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '',
    verify_results: '[]',
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    failure_reason: '',
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: 0,
    resolution_attempts: 0,
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    retries: Number(hash.retries ?? 0) + 1,
  });

  // 5. 释放 ownership
  const releasedOwnership = await releaseOwnershipByAgent(redis, hash.claimed_by ?? '', taskId);
  // reset 同样可能释放某个 file waiter 的最后一个占用；按和 report/显式 release 相同的
  // 事件驱动口径唤醒，Question 等待不会被该扫描恢复。
  if (releasedOwnership > 0) await requeueFileWaiters(redis);

  // 5.1 reset 该 task → 清除其 acceptance_ready 去重标记，使依赖再次满足时可重新通知 PM。
  //     同时清除依赖此 task 的 acceptance 任务的去重标记（依赖链被重置后需重新评估）。
  await redis.srem(keys.acceptanceReady.fired, taskId);
  const pendingIdsForAcc = await redis.zrange(keys.zset.status.pending, 0, -1);
  for (const pid of pendingIdsForAcc) {
    const depRaw = await redis.hget(keys.hash.task(pid), 'depends_on');
    if (depRaw && depRaw.split(',').filter(Boolean).includes(taskId)) {
      await redis.srem(keys.acceptanceReady.fired, pid);
    }
  }

  // 6. 重新入流（让 worker 能 claim）
  await redis.xadd(keys.stream.tasks, '*', 'task_id', taskId, 'priority', String(priority));

  // 7. 写事件
  await redis.xadd(
    keys.stream.events,
    '*',
    'event_id',
    `${now}_reset_${taskId}`,
    'type',
    'task_reset',
    'task_id',
    taskId,
    'from_status',
    fromStatus,
    'reset_by',
    req.reset_by ?? 'pm',
  );

  return { ok: true, data: { task_id: taskId, from_status: fromStatus, to_status: 'pending' } };
}

/** 撤销 pending 任务（对应 biao task cancel）
 *  - 只能撤销 pending（running/done/failed/cancelled 拒绝）
 *  - 若被其他 task 依赖（在 depends_on 里），拒绝并返回依赖者列表
 *  - 从 pending zset 移除，task hash 设 status=cancelled + cancelled_at（审计）
 */
export async function cancelTask(redis: Redis, taskId: string): Promise<ApiResponse<{ task_id: string; status: string }>> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }

  if (hash.status !== 'pending') {
    return {
      ok: false,
      data: null,
      error: {
        code: 'TASK_NOT_CANCELLABLE',
        message: `只能撤销 pending 任务，当前状态为 ${hash.status}（running 任务需等其 done/failed，done/failed 保留历史）`,
      },
    };
  }

  // 检查是否被其他 pending/running task 依赖
  const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
  const runningIds = await redis.zrange(keys.zset.status.running, 0, -1);
  const dependents: string[] = [];
  for (const otherId of [...pendingIds, ...runningIds]) {
    if (otherId === taskId) continue;
    const depRaw = await redis.hget(keys.hash.task(otherId), 'depends_on');
    if (depRaw && depRaw.split(',').filter(Boolean).includes(taskId)) {
      dependents.push(otherId);
    }
  }
  if (dependents.length > 0) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'TASK_HAS_DEPENDENTS',
        message: `任务 ${taskId} 被以下任务依赖，不能撤销：${dependents.join(', ')}。请先撤销依赖者或调整 depends_on。`,
      },
    };
  }

  // 执行撤销：移出 pending zset + 标记 cancelled（保留 hash 作审计）
  const cancelledAt = Date.now();
  await redis.zrem(keys.zset.status.pending, taskId);
  await redis.zadd(keys.zset.status.cancelled, cancelledAt, taskId);
  await redis.hset(keys.hash.task(taskId), 'status', 'cancelled', 'cancelled_at', String(cancelledAt));
  // SQLite 双写：cancel 时 status → cancelled
  if (sqliteStore) {
    sqliteStore.updateTaskFields(taskId, { status: 'cancelled', cancelled_at: String(cancelledAt) });
  }

  // 取消当前自动 repair 不能悄悄把原失败任务永久留在 repairing。保留取消审计，
  // 同时把根任务提升为需要 PM 决策，下一轮 intake/supervisor 才有明确的收口事项。
  if (hash.fix_for) {
    const rootTaskId = hash.repair_root_task_id || hash.fix_for;
    const root = await redis.hgetall(keys.hash.task(rootTaskId));
    if (root.task_id && root.resolution_task_id === taskId) {
      await markResolutionNeedsPmDecision(redis, rootTaskId, `repair_cancelled:${taskId}`);
    }
  }
  return { ok: true, data: { task_id: taskId, status: 'cancelled' } };
}

/** 租约续期（对应 POST /lease/renew）
 *  worker 跑长任务时定期调，避免 lease 过期被 lazyReclaim 回收
 *  校验 claim_token → 同步延长 lease、running/task 到期时间和该 task 的 ownership。
 */
export async function renewLease(
  redis: Redis,
  req: { task_id: string; claim_token: string; extend_seconds?: number },
): Promise<ApiResponse<{ task_id: string; new_expire_at: number }>> {
  const leaseKey = keys.string.lease(req.task_id);
  const taskKey = keys.hash.task(req.task_id);
  const isolated = redis.duplicate();
  try {
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      // owner set 的 key 要由 task 当前 owner 决定。先做无状态预读，再把真实 key
      // 和 task/lease/registry 一起 watch；若 owner 在窗口中变化，下面会重试。
      const preOwner = (await isolated.hget(taskKey, 'claimed_by')) ?? '';
      const ownerSetKey = keys.set.ownerByAgent(preOwner || '__no_owner__');
      await isolated.watch(leaseKey, taskKey, keys.hash.fileOwnership, ownerSetKey);
      try {
        const [storedToken, taskHash] = await Promise.all([
          isolated.get(leaseKey),
          isolated.hgetall(taskKey),
        ]);
        if (storedToken !== req.claim_token) {
          return { ok: false, data: null, error: { code: 'CLAIM_TOKEN_INVALID', message: '租约 token 无效或已过期' } };
        }
        if (!taskHash.task_id) {
          return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${req.task_id}` } };
        }
        if (taskHash.status !== 'running' || !taskHash.claimed_by) {
          return { ok: false, data: null, error: { code: 'TASK_NOT_RUNNING', message: `任务 ${req.task_id} 不在 running 状态` } };
        }
        if (taskHash.claimed_by !== preOwner) continue;

        const requested = req.extend_seconds ?? Number(taskHash.timeout_seconds ?? 1800);
        const timeout = Number.isFinite(requested) ? Math.floor(requested) : 0;
        if (timeout <= 0) {
          return { ok: false, data: null, error: { code: 'INVALID_LEASE_TIMEOUT', message: 'extend_seconds 必须为正整数' } };
        }
        const now = Date.now();
        const newExpireAt = now + timeout * 1000;
        const globs = await isolated.smembers(ownerSetKey);
        const ownershipUpdates: Array<{ glob: string; raw: string }> = [];
        for (const glob of globs) {
          const raw = await isolated.hget(keys.hash.fileOwnership, glob);
          if (!raw) continue;
          try {
            const record = JSON.parse(raw) as { agent_id?: string; task_id?: string };
            if (record.agent_id === taskHash.claimed_by && record.task_id === req.task_id) {
              ownershipUpdates.push({ glob, raw });
            }
          } catch {
            // 损坏 registry 不被续租伪装为活锁；后续 claim/declare 会按既有口径清理。
          }
        }

        const tx = isolated.multi();
        tx.expire(leaseKey, timeout);
        tx.zadd(keys.zset.status.running, runningScore(newExpireAt), req.task_id);
        tx.hset(taskKey, 'expire_at', String(newExpireAt));
        for (const { glob, raw } of ownershipUpdates) {
          const record = JSON.parse(raw) as Record<string, unknown>;
          tx.hset(keys.hash.fileOwnership, glob, JSON.stringify({ ...record, expires_at: newExpireAt }));
        }
        if ((await tx.exec()) !== null) {
          sqliteStore?.updateTaskFields(req.task_id, { expire_at: String(newExpireAt) });
          return { ok: true, data: { task_id: req.task_id, new_expire_at: newExpireAt } };
        }
      } finally {
        await isolated.unwatch().catch(() => undefined);
      }
    }
    return {
      ok: false,
      data: null,
      error: { code: 'LEASE_RENEW_RACE_RETRY_EXHAUSTED', message: '续租期间状态持续变化，请重新领取任务' },
    };
  } finally {
    isolated.disconnect();
  }
}

/* ===================== Question 状态机（真实持久化实体） =====================
 * 替代旧"task block 的可选字符串"：Question 独立持久化并绑定 task/plan/agent/pm_consumer。
 * 提问时任务进入 blocked/waiting_pm_reply，安全终止旧 lease、释放 ownership（原 Agent 可去领下一项），
 * 记录可恢复 checkpoint/context；只发出最小 question_asked 门铃给对应 PM consumer（正文必须二次读取）。
 * 回答后持久化审计，任务恢复为 pending（必须用新 claim_token 重领），发出 question_answered 门铃给 Worker。
 * 不能恢复已取消/终态的任务。
 */

/** 生成 question_id（确定性不重要，唯一即可） */
function generateQuestionId(): string {
  return `q_${generateToken().slice(4)}`;
}

/**
 * 创建 Question 的 Redis CAS。
 *
 * 创建不能拆成“查 open pointer → 写 Question → 删除 lease → task blocked”的多次往返：
 * 同一 Worker 的 HTTP 重试可能并发抵达，并各自写出一条 Question / 门铃。该脚本把校验、
 * 幂等命中、ownership 释放、状态迁移和门铃写入收敛为一个 Redis 原子单元。
 *
 * KEYS: task, lease, open pointer, open-pointer metadata, new question, running zset,
 *       blocked zset, agent, events stream, file ownership hash, owner-by-agent set
 */
const CREATE_QUESTION_CAS = `
local task_id = ARGV[1]
local agent_id = ARGV[2]
local claim_token = ARGV[3]
local question_id = ARGV[4]
local plan_id = ARGV[5]
local pm_consumer = ARGV[6]
local body = ARGV[7]
local checkpoint = ARGV[8]
local now = ARGV[9]
local lease_fallback = tonumber(ARGV[10]) or 1800
local question_prefix = ARGV[11]
local event_id = ARGV[12]

local existing_id = redis.call('GET', KEYS[3])
if existing_id then
  -- 新版本用 metadata；旧 pointer 回退到已有 Question hash，保证升级后仍可幂等重试。
  local existing_agent = redis.call('HGET', KEYS[4], 'agent_id')
  local existing_token = redis.call('HGET', KEYS[4], 'claim_token')
  local existing_consumer = redis.call('HGET', KEYS[4], 'pm_consumer')
  local existing_status = nil
  if not existing_agent then
    local legacy_key = question_prefix .. existing_id
    existing_agent = redis.call('HGET', legacy_key, 'agent_id')
    existing_token = redis.call('HGET', legacy_key, 'claim_token')
    existing_consumer = redis.call('HGET', legacy_key, 'pm_consumer')
    existing_status = redis.call('HGET', legacy_key, 'status')
  else
    existing_status = redis.call('HGET', question_prefix .. existing_id, 'status')
  end
  if existing_status == 'open' then
    if existing_agent == agent_id and existing_token == claim_token then
      local existing_event_id = redis.call('HGET', question_prefix .. existing_id, 'asked_event_id') or ''
      return {'IDEMPOTENT', existing_id, existing_consumer or pm_consumer, existing_event_id}
    end
    return {'CLAIM_TOKEN_INVALID', existing_id}
  end
  -- 非 open 的残留 pointer 不得永久阻断本任务；Question 审计实体保留，仅清掉索引。
  redis.call('DEL', KEYS[3])
  redis.call('DEL', KEYS[4])
end

if redis.call('HGET', KEYS[1], 'task_id') == false then
  return {'TASK_NOT_FOUND'}
end
local task_status = redis.call('HGET', KEYS[1], 'status') or ''
if task_status ~= 'running' then
  return {'TASK_NOT_RUNNING', task_status}
end
local claimed_by = redis.call('HGET', KEYS[1], 'claimed_by') or ''
if claimed_by ~= agent_id then
  return {'CLAIM_OWNER_MISMATCH', claimed_by}
end
local lease_token = redis.call('GET', KEYS[2])
if not lease_token then return {'LEASE_EXPIRED'} end
if lease_token ~= claim_token then return {'CLAIM_TOKEN_INVALID'} end

local ttl = redis.call('TTL', KEYS[2])
if ttl == nil or ttl <= 0 then ttl = lease_fallback end

redis.call('HSET', KEYS[5],
  'question_id', question_id,
  'task_id', task_id,
  'plan_id', plan_id,
  'agent_id', agent_id,
  'pm_consumer', pm_consumer,
  'asked_event_id', event_id,
  'body', body,
  'checkpoint', checkpoint,
  'claim_token', claim_token,
  'status', 'open',
  'created_at', now)
redis.call('SET', KEYS[3], question_id)
redis.call('HSET', KEYS[4],
  'question_id', question_id,
  'agent_id', agent_id,
  'claim_token', claim_token,
  'pm_consumer', pm_consumer)

-- 释放仅属于本 task 的 ownership，不盲删该 agent 的其他异常残留。
local globs = redis.call('SMEMBERS', KEYS[11])
for _, glob in ipairs(globs) do
  local raw = redis.call('HGET', KEYS[10], glob)
  if not raw then
    redis.call('SREM', KEYS[11], glob)
  else
    local ok, rec = pcall(cjson.decode, raw)
    if (not ok) or (not rec) or rec.task_id == task_id then
      redis.call('HDEL', KEYS[10], glob)
      redis.call('SREM', KEYS[11], glob)
    end
  end
end

redis.call('DEL', KEYS[2])
redis.call('HSET', KEYS[1],
  'status', 'blocked',
  'block_reason', 'waiting_pm_reply',
  'blocked_at', now,
  'blocked_question_id', question_id,
  'blocked_lease_remaining', tostring(ttl),
  'claimed_by', '',
  'claimed_at', '',
  'expire_at', '')
redis.call('ZREM', KEYS[6], task_id)
redis.call('ZADD', KEYS[7], tonumber(now), task_id)
redis.call('HSET', KEYS[8], 'status', 'idle', 'current_task', '')
redis.call('XADD', KEYS[9], '*',
  'event_id', event_id,
  'type', 'question_asked',
  'task_id', task_id,
  'question_id', question_id,
  'plan_id', plan_id,
  'agent_id', agent_id,
  'consumer', pm_consumer,
  'acked', 'false',
  'timestamp', now)
return {'CREATED', question_id, pm_consumer, event_id, tostring(ttl)}
`;

/** 创建 Question（POST /question）—— Worker 向 PM 提问。
 *  返回给 Worker 的是最小载荷：question_id + task_id + status；门铃单独写事件流。 */
export async function createQuestion(
  redis: Redis,
  req: QuestionCreateRequest,
): Promise<ApiResponse<{ question_id: string; task_id: string; plan_id: string; status: string; pm_consumer: string; asked_event_id: string }>> {
  const taskId = req.task_id?.trim();
  const agentId = req.agent_id?.trim();
  const body = (req.body ?? '').trim();
  if (!taskId || !agentId) {
    return { ok: false, data: null, error: { code: 'INVALID_REQUEST', message: 'task_id 和 agent_id 不能为空' } };
  }
  if (!body) {
    return { ok: false, data: null, error: { code: 'EMPTY_BODY', message: '提问正文不能为空' } };
  }
  if (body.length > QUESTION_BODY_MAX_CHARS) {
    return { ok: false, data: null, error: { code: 'QUESTION_BODY_TOO_LARGE', message: `提问正文不能超过 ${QUESTION_BODY_MAX_CHARS} 字符` } };
  }
  if (!req.claim_token) {
    return { ok: false, data: null, error: { code: 'CLAIM_TOKEN_INVALID', message: 'claim_token 不能为空' } };
  }

  // 此预读只用于确定 plan 路由；权属/lease/task 状态都必须由下方 Lua 在同一原子边界校验。
  const taskHash = await redis.hgetall(keys.hash.task(taskId));
  if (!taskHash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }

  const planId = taskHash.plan_id ?? '';
  const pmConsumer = await resolvePmConsumer(redis, planId);
  const now = Date.now();
  const questionId = generateQuestionId();
  const checkpoint = (req.checkpoint ?? '').trim();
  if (checkpoint.length > QUESTION_CHECKPOINT_MAX_CHARS) {
    return { ok: false, data: null, error: { code: 'QUESTION_CHECKPOINT_TOO_LARGE', message: `checkpoint 不能超过 ${QUESTION_CHECKPOINT_MAX_CHARS} 字符` } };
  }
  const raw = (await redis.eval(
    CREATE_QUESTION_CAS,
    11,
    keys.hash.task(taskId),
    keys.string.lease(taskId),
    keys.question.openByTask(taskId),
    keys.question.openMetaByTask(taskId),
    keys.hash.question(questionId),
    keys.zset.status.running,
    keys.zset.status.blocked,
    keys.hash.agent(agentId),
    keys.stream.events,
    keys.hash.fileOwnership,
    keys.set.ownerByAgent(agentId),
    taskId,
    agentId,
    req.claim_token,
    questionId,
    planId,
    pmConsumer,
    body,
    checkpoint,
    String(now),
    String(Number(taskHash.timeout_seconds ?? 1800)),
    keys.hash.question(''),
    `${now}_question_asked_${questionId}`,
  )) as string[];
  const [outcome, resolvedQuestionId = '', resolvedConsumer = pmConsumer, resolvedEventId = ''] = raw.map(String);
  const errors: Record<string, { code: string; message: string }> = {
    TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
    TASK_NOT_RUNNING: { code: 'TASK_NOT_RUNNING', message: '只能对 running 任务提问' },
    CLAIM_OWNER_MISMATCH: { code: 'CLAIM_OWNER_MISMATCH', message: '任务不属于当前 Worker' },
    LEASE_EXPIRED: { code: 'LEASE_EXPIRED', message: '租约已失效，无法提问（请重新 claim）' },
    CLAIM_TOKEN_INVALID: { code: 'CLAIM_TOKEN_INVALID', message: '仅原持有 Worker 可用原 claim_token 幂等重试' },
  };
  if (errors[outcome]) return { ok: false, data: null, error: errors[outcome] };

  // 首次创建与同 token 的幂等重放都从 Redis 最终态补偿 SQLite；重放绝不使用本次 body
  // 覆盖首个问题，但能修复“Redis 已提交、首次 SQLite 双写恰好失败”的短暂故障。
  await reconcileQuestionSqlite(redis, resolvedQuestionId, taskId);

  const question = await redis.hgetall(keys.hash.question(resolvedQuestionId));
  return {
    ok: true,
    data: {
      question_id: resolvedQuestionId,
      task_id: taskId,
      plan_id: planId,
      status: 'open',
      pm_consumer: resolvedConsumer,
      asked_event_id: resolvedEventId || question.asked_event_id || `${question.created_at}_question_asked_${resolvedQuestionId}`,
    },
  };
}

/**
 * 列出某 consumer（PM）的 Question 门铃元数据（GET /questions?consumer=&status=）。
 * 不返回 body/checkpoint/answer；PM 必须用 GET /question/:id?consumer= 二次读取详情。 */
export async function listQuestions(
  redis: Redis,
  opts: { consumer?: string; status?: string; plan_id?: string },
): Promise<ApiResponse<QuestionSummary[]>> {
  if (opts.consumer !== undefined && !isValidConsumerName(opts.consumer)) {
    return { ok: false, data: null, error: { code: 'INVALID_CONSUMER', message: 'consumer 名称非法' } };
  }
  const consumer = opts.consumer ?? DEFAULT_PM_CONSUMER;
  const wantStatus = opts.status ?? 'open';
  // 用 open question 的索引快速定位待回答项，避免全量扫描
  // 这里取该 consumer 路由下、状态匹配的 questions
  const result: QuestionSummary[] = [];
  // 扫描所有 question hash（数量受限于活跃提问，远小于事件流历史）
  const qKeys = await scanKeys(redis, `${PREFIX}:hash:question:*`);
  for (const qk of qKeys) {
    const h = await redis.hgetall(qk);
    if (!h.question_id) continue;
    if (wantStatus !== 'all' && (h.status ?? 'open') !== wantStatus) continue;
    // consumer 路由：只返回路由给该 PM consumer 的提问（未声明 consumer 的放行默认）
    if (normalizePmConsumer(h.pm_consumer) !== consumer) continue;
    if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
    result.push(hashToQuestionSummary(h));
  }
  result.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return { ok: true, data: result };
}

function hashToQuestionSummary(h: Record<string, string>): QuestionSummary {
  return {
    question_id: h.question_id,
    task_id: h.task_id ?? '',
    plan_id: h.plan_id ?? '',
    agent_id: h.agent_id ?? '',
    pm_consumer: h.pm_consumer ?? DEFAULT_PM_CONSUMER,
    status: (h.status ?? 'open') as QuestionStatus,
    created_at: Number(h.created_at ?? 0),
    answered_at: h.answered_at ? Number(h.answered_at) : undefined,
    answered_by: h.answered_by || undefined,
  };
}

/** 读取单个 Question 全文（PM 二次取正文用） */
export async function getQuestion(
  redis: Redis,
  questionId: string,
  opts: { consumer?: string; plan_id?: string } = {},
): Promise<ApiResponse<QuestionRecord | null>> {
  if (opts.consumer !== undefined && !isValidConsumerName(opts.consumer)) {
    return { ok: false, data: null, error: { code: 'INVALID_CONSUMER', message: 'consumer 名称非法' } };
  }
  const h = await redis.hgetall(keys.hash.question(questionId));
  if (!h.question_id) {
    return { ok: false, data: null, error: { code: 'QUESTION_NOT_FOUND', message: `Question 不存在：${questionId}` } };
  }
  // Question 正文属于对应 PM；不带 consumer 的内部服务调用保留兼容，HTTP 必须传 consumer。
  if (opts.consumer && (h.pm_consumer ?? DEFAULT_PM_CONSUMER) !== opts.consumer) {
    return {
      ok: false,
      data: null,
      error: { code: 'CONSUMER_NOT_AUTHORIZED', message: `仅 consumer=${h.pm_consumer ?? DEFAULT_PM_CONSUMER} 可读取该 Question` },
    };
  }
  if (opts.plan_id && h.plan_id !== opts.plan_id) {
    return { ok: false, data: null, error: { code: 'PLAN_NOT_AUTHORIZED', message: `Question 不属于 plan=${opts.plan_id}` } };
  }
  return { ok: true, data: hashToQuestionRecord(h) };
}

function hashToQuestionRecord(h: Record<string, string>): QuestionRecord {
  return {
    question_id: h.question_id,
    task_id: h.task_id ?? '',
    plan_id: h.plan_id ?? '',
    agent_id: h.agent_id ?? '',
    pm_consumer: h.pm_consumer ?? DEFAULT_PM_CONSUMER,
    asked_event_id: h.asked_event_id || `${h.created_at}_question_asked_${h.question_id}`,
    body: h.body ?? '',
    checkpoint: h.checkpoint ?? '',
    status: (h.status ?? 'open') as QuestionStatus,
    created_at: Number(h.created_at ?? 0),
    answered_at: h.answered_at ? Number(h.answered_at) : undefined,
    answered_by: h.answered_by || undefined,
    answer: h.answer || undefined,
  };
}

/**
 * Redis 已先提交、SQLite 双写在进程抖动时失败后的补偿路径。
 *
 * Question 的 Redis 状态机必须先保证 lease/ownership 的原子安全，SQLite 是持久副本；因此不能
 * 把两者伪装成一个跨库事务。每个成功请求（包括 HTTP 幂等重试）都从 Redis 最终态重放一次 SQLite
 * 写入：若首次双写刚好失败，后续相同请求能修复副本；若仍失败则如实向调用方报错，不吞错误。
 */
async function reconcileQuestionSqlite(redis: Redis, questionId: string, fallbackTaskId = ''): Promise<void> {
  if (!sqliteStore) return;
  const question = await redis.hgetall(keys.hash.question(questionId));
  if (!question.question_id) return;
  const taskId = question.task_id || fallbackTaskId;
  const task = taskId ? await redis.hgetall(keys.hash.task(taskId)) : {};

  if (task.task_id) {
    sqliteStore.updateTaskFields(taskId, {
      status: task.status ?? 'pending',
      block_reason: task.block_reason ?? '',
      blocked_at: task.blocked_at ?? '',
      blocked_question_id: task.blocked_question_id ?? '',
      blocked_lease_remaining: task.blocked_lease_remaining ?? '',
      claimed_by: task.claimed_by ?? '',
      claimed_at: task.claimed_at ?? '',
      expire_at: task.expire_at ?? '',
      last_question_id: task.last_question_id ?? '',
      last_question_answer: task.last_question_answer ?? '',
    });
  }

  sqliteStore.upsertQuestion({
    question_id: question.question_id,
    task_id: taskId,
    plan_id: question.plan_id ?? '',
    agent_id: question.agent_id ?? '',
    pm_consumer: question.pm_consumer ?? DEFAULT_PM_CONSUMER,
    asked_event_id: question.asked_event_id || `${question.created_at}_question_asked_${question.question_id}`,
    body: question.body ?? '',
    checkpoint: question.checkpoint ?? '',
    status: question.status ?? 'open',
    created_at: question.created_at ?? '',
    answered_at: question.answered_at ?? '',
    answered_by: question.answered_by ?? '',
    answer: question.answer ?? '',
  });
}

/**
 * Question answer 的 Redis CAS。不能用共享 HTTP server Redis client 的 WATCH/MULTI：WATCH 是连接级
 * 状态，两个 Fastify 请求交错时会互相覆盖 watch 集。Lua 在 Redis 内一次执行完状态检查和所有写入，
 * 因而并发不同答案只能有一个胜出；相同答案则可靠地幂等重放。
 *
 * KEYS: question hash, task hash, open-question pointer, open-pointer metadata, blocked zset, pending zset, task stream, event stream
 * ARGV: question id, consumer, answer, timestamp, default PM consumer
 */
const ANSWER_QUESTION_CAS = `
local question_id = ARGV[1]
local consumer = ARGV[2]
local answer = ARGV[3]
local now = ARGV[4]
local default_consumer = ARGV[5]

if redis.call('HGET', KEYS[1], 'question_id') == false then
  return {'QUESTION_NOT_FOUND'}
end

local task_id = redis.call('HGET', KEYS[1], 'task_id') or ''
local expected = redis.call('HGET', KEYS[1], 'pm_consumer') or default_consumer
if expected ~= consumer then
  return {'CONSUMER_NOT_AUTHORIZED', task_id, expected}
end

local question_status = redis.call('HGET', KEYS[1], 'status') or 'open'
if question_status == 'cancelled' then
  return {'QUESTION_CANCELLED', task_id}
end
if question_status == 'answered' then
  local stored_answer = redis.call('HGET', KEYS[1], 'answer') or ''
  local answered_by = redis.call('HGET', KEYS[1], 'answered_by') or ''
  if stored_answer == answer and answered_by == consumer then
    return {'IDEMPOTENT', task_id}
  end
  return {'ANSWER_CONFLICT', task_id}
end

if redis.call('HGET', KEYS[2], 'task_id') == false then
  return {'TASK_NOT_FOUND', task_id}
end
local task_status = redis.call('HGET', KEYS[2], 'status') or ''
if task_status == 'cancelled' or task_status == 'done' or task_status == 'failed' then
  redis.call('HSET', KEYS[1], 'status', 'answered', 'answered_at', now, 'answered_by', consumer, 'answer', answer)
  if redis.call('GET', KEYS[3]) == question_id then
    redis.call('DEL', KEYS[3])
    redis.call('DEL', KEYS[4])
  end
  return {'TERMINAL_ANSWERED', task_id}
end
if task_status ~= 'blocked' or (redis.call('HGET', KEYS[2], 'blocked_question_id') or '') ~= question_id then
  return {'TASK_STATE_CONFLICT', task_id, task_status}
end

redis.call('HSET', KEYS[1], 'status', 'answered', 'answered_at', now, 'answered_by', consumer, 'answer', answer)
if redis.call('GET', KEYS[3]) == question_id then
  redis.call('DEL', KEYS[3])
  redis.call('DEL', KEYS[4])
end

local priority = tonumber(redis.call('HGET', KEYS[2], 'priority') or '5')
local score = priority * 10000000000000 - tonumber(now)
local plan_id = redis.call('HGET', KEYS[1], 'plan_id') or redis.call('HGET', KEYS[2], 'plan_id') or ''
redis.call('HSET', KEYS[2],
  'status', 'pending',
  'block_reason', '',
  'blocked_at', '',
  'blocked_question_id', '',
  'blocked_lease_remaining', '',
  'claimed_by', '',
  'claimed_at', '',
  'expire_at', '',
  'last_question_id', question_id,
  'last_question_answer', answer)
redis.call('ZREM', KEYS[5], task_id)
redis.call('ZADD', KEYS[6], score, task_id)
redis.call('XADD', KEYS[7], '*', 'task_id', task_id, 'priority', tostring(priority))
redis.call('XADD', KEYS[8], '*',
  'event_id', now .. '_question_answered_' .. question_id,
  'type', 'question_answered',
  'task_id', task_id,
  'question_id', question_id,
  'plan_id', plan_id,
  'consumer', 'worker',
  'acked', 'false',
  'timestamp', now)
return {'ANSWERED', task_id}
`;

/** PM 回答 Question（POST /question/:id/answer）。
 * 权限和状态流转在 Redis Lua CAS 内原子完成；answer 阶段不会伪造 claim token，
 * Worker 必须重新调用 /claim 才会获得新的真实 lease token。 */
export async function answerQuestion(
  redis: Redis,
  questionId: string,
  req: QuestionAnswerRequest,
): Promise<ApiResponse<{ question_id: string; task_id: string; plan_id: string; pm_consumer: string; asked_event_id: string; status: string; new_claim_token: string }>> {
  const consumer = req.consumer?.trim();
  const answer = (req.answer ?? '').trim();
  if (!isValidConsumerName(consumer ?? '')) {
    return { ok: false, data: null, error: { code: 'INVALID_CONSUMER', message: 'consumer 名称非法' } };
  }
  if (!answer) {
    return { ok: false, data: null, error: { code: 'EMPTY_ANSWER', message: '回答正文不能为空' } };
  }
  if (answer.length > QUESTION_ANSWER_MAX_CHARS) {
    return { ok: false, data: null, error: { code: 'QUESTION_ANSWER_TOO_LARGE', message: `回答正文不能超过 ${QUESTION_ANSWER_MAX_CHARS} 字符` } };
  }

  const now = Date.now();
  // 对不存在的 Question 先在应用层返回，避免为 Lua 组装一个空 task key；Lua 仍保留
  // QUESTION_NOT_FOUND 防竞态保护（例如记录在 hget 后被删除）。
  const questionBefore = await redis.hgetall(keys.hash.question(questionId));
  if (!questionBefore.question_id) {
    return { ok: false, data: null, error: { code: 'QUESTION_NOT_FOUND', message: `Question 不存在：${questionId}（不得伪造 question_id）` } };
  }
  const boundTaskId = questionBefore.task_id;
  if (req.plan_id && questionBefore.plan_id !== req.plan_id) {
    return { ok: false, data: null, error: { code: 'PLAN_NOT_AUTHORIZED', message: `Question 不属于 plan=${req.plan_id}` } };
  }
  const raw = (await redis.eval(
    ANSWER_QUESTION_CAS,
    8,
    keys.hash.question(questionId),
    keys.hash.task(boundTaskId),
    keys.question.openByTask(boundTaskId),
    keys.question.openMetaByTask(boundTaskId),
    keys.zset.status.blocked,
    keys.zset.status.pending,
    keys.stream.tasks,
    keys.stream.events,
    questionId,
    consumer,
    answer,
    String(now),
    DEFAULT_PM_CONSUMER,
  )) as string[];
  const [outcome, taskId = ''] = raw.map(String);

  const errors: Record<string, { code: string; message: string }> = {
    QUESTION_NOT_FOUND: { code: 'QUESTION_NOT_FOUND', message: `Question 不存在：${questionId}（不得伪造 question_id）` },
    CONSUMER_NOT_AUTHORIZED: { code: 'CONSUMER_NOT_AUTHORIZED', message: '该 Question 不属于当前 consumer' },
    QUESTION_CANCELLED: { code: 'QUESTION_CANCELLED', message: '该 Question 已取消' },
    ANSWER_CONFLICT: { code: 'ANSWER_CONFLICT', message: '该 Question 已被回答，冲突回答被拒绝' },
    TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
    TASK_STATE_CONFLICT: { code: 'TASK_STATE_CONFLICT', message: '任务已不处于该 Question 对应的 blocked 状态，拒绝覆盖其后续状态' },
  };
  if (errors[outcome]) return { ok: false, data: null, error: errors[outcome] };

  // Lua 已写 Redis。包括 IDEMPOTENT 在内都重放 SQLite 副本：首次 Redis 成功但 SQLite 暂时失败时，
  // 同答案重试可补齐持久化；冲突回答在 Lua 层被拒，绝不会覆盖已存答案。
  if (outcome === 'ANSWERED' || outcome === 'TERMINAL_ANSWERED' || outcome === 'IDEMPOTENT') {
    await reconcileQuestionSqlite(redis, questionId, taskId);
  }

  // new_claim_token 保持旧响应字段兼容，但永远为空；真正 token 只在下一次 /claim 产生。
  return {
    ok: true,
    data: {
      question_id: questionId,
      task_id: taskId,
      plan_id: questionBefore.plan_id ?? '',
      pm_consumer: questionBefore.pm_consumer ?? DEFAULT_PM_CONSUMER,
      asked_event_id: questionBefore.asked_event_id || `${questionBefore.created_at}_question_asked_${questionId}`,
      status: 'answered',
      new_claim_token: '',
    },
  };
}

/**
 * 搁置任务（POST /task/:id/block）—— 等待文件/依赖的受控 Worker 接口。
 *
 * blocked 不能继续持有 lease 或文件 ownership：否则一个 worker slot 去领下一项后，旧 task
 * 仍像运行中一样被任意 agent resume，形成双运行/双 ownership。恢复一律回 pending，后续由
 * 正常 claim 生成新 token 并重新获取 ownership。
 *
 * 注意：`waiting_pm_reply` 仅能由 createQuestion 产生，不能借通用 block 伪造；其恢复也只能
 * 由 answerQuestion 原子状态机完成，不能被 taskResume 绕过。 */
const TASK_BLOCK_CAS = `
local task_id = ARGV[1]
local agent_id = ARGV[2]
local claim_token = ARGV[3]
local reason = ARGV[4]
local question_id = ARGV[5]
local now = ARGV[6]
local condition_clear = ARGV[7] == '1'

if redis.call('HGET', KEYS[1], 'task_id') == false then return {'TASK_NOT_FOUND'} end
if (redis.call('HGET', KEYS[1], 'status') or '') ~= 'running' then
  return {'TASK_NOT_RUNNING', redis.call('HGET', KEYS[1], 'status') or ''}
end
if (redis.call('HGET', KEYS[1], 'claimed_by') or '') ~= agent_id then
  return {'CLAIM_OWNER_MISMATCH'}
end
local actual_token = redis.call('GET', KEYS[2])
if not actual_token or actual_token ~= claim_token then return {'CLAIM_TOKEN_INVALID'} end
local ttl = redis.call('TTL', KEYS[2])
if ttl == nil or ttl < 0 then ttl = 0 end

-- 只释放此 task 的 ownership；与 Question CAS 同样避免删掉异常情况下 agent 的另一 task 声明。
local globs = redis.call('SMEMBERS', KEYS[8])
for _, glob in ipairs(globs) do
  local raw = redis.call('HGET', KEYS[7], glob)
  if not raw then
    redis.call('SREM', KEYS[8], glob)
  else
    local ok, rec = pcall(cjson.decode, raw)
    if (not ok) or (not rec) or rec.task_id == task_id then
      redis.call('HDEL', KEYS[7], glob)
      redis.call('SREM', KEYS[8], glob)
    end
  end
end

redis.call('DEL', KEYS[2])
if condition_clear then
  local priority = tonumber(redis.call('HGET', KEYS[1], 'priority') or '5')
  local score = priority * 10000000000000 - tonumber(now)
  local event_type = reason == 'waiting_file_release' and 'task_ready' or 'dependency_ready'
  redis.call('HSET', KEYS[1],
    'status', 'pending',
    'blocked_at', '',
    'block_reason', '',
    'blocked_question_id', '',
    'blocked_lease_remaining', '',
    'claimed_by', '',
    'claimed_at', '',
    'expire_at', '')
  redis.call('ZREM', KEYS[3], task_id)
  redis.call('ZREM', KEYS[4], task_id)
  redis.call('ZADD', KEYS[9], score, task_id)
  redis.call('XADD', KEYS[10], '*', 'task_id', task_id, 'priority', tostring(priority))
  redis.call('HSET', KEYS[5], 'status', 'idle', 'current_task', '')
  redis.call('XADD', KEYS[6], '*',
    'event_id', now .. '_' .. event_type .. '_' .. task_id,
    'type', event_type,
    'task_id', task_id,
    'agent_id', agent_id,
    'consumer', 'worker',
    'timestamp', now)
  return {'READY', tostring(ttl)}
end

redis.call('HSET', KEYS[1],
  'status', 'blocked',
  'blocked_at', now,
  'block_reason', reason,
  'blocked_question_id', question_id,
  'blocked_lease_remaining', tostring(ttl),
  'claimed_by', '',
  'claimed_at', '',
  'expire_at', '')
redis.call('ZREM', KEYS[3], task_id)
redis.call('ZADD', KEYS[4], tonumber(now), task_id)
redis.call('HSET', KEYS[5], 'status', 'idle', 'current_task', '')
redis.call('XADD', KEYS[6], '*',
  'event_id', now .. '_task_blocked_' .. task_id,
  'type', 'task_blocked',
  'task_id', task_id,
  'agent_id', agent_id,
  'consumer', 'worker',
  'timestamp', now)
return {'BLOCKED', tostring(ttl)}
`;

type TaskBlockOutcome =
  | 'BLOCKED'
  | 'READY'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_RUNNING'
  | 'CLAIM_OWNER_MISMATCH'
  | 'CLAIM_TOKEN_INVALID'
  | 'RACE_RETRY_EXHAUSTED';

/**
 * 在写 blocked 之前观察 task、lease 与依赖快照。
 *
 * eligibility 读取和 TASK_BLOCK_CAS 通过同一个专用连接的 WATCH/MULTI 绑定；依赖或
 * ownership 在检查后发生任何变化都会让 EXEC 返回 null 并重试，避免把已经清除的条件
 * 永久写成等待。
 */
async function blockTaskWithEligibilityCheck(
  redis: Redis,
  taskId: string,
  agentId: string,
  req: { claim_token: string; reason: 'waiting_file_release' | 'waiting_dependency'; question_id?: string },
): Promise<[TaskBlockOutcome, string]> {
  const isolated = redis.duplicate();
  try {
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      const taskKey = keys.hash.task(taskId);
      const initial = await isolated.hgetall(taskKey);
      const dependencyIds = req.reason === 'waiting_dependency'
        ? (initial.depends_on ?? '').split(',').map((item) => item.trim()).filter(Boolean)
        : [];
      const watched = [
        taskKey,
        keys.string.lease(taskId),
        ...(req.reason === 'waiting_file_release' ? [keys.hash.fileOwnership] : []),
        ...dependencyIds.map((dependencyId) => keys.hash.task(dependencyId)),
      ];
      await isolated.watch(...watched);
      try {
        const current = await isolated.hgetall(taskKey);
        if ((current.depends_on ?? '') !== (initial.depends_on ?? '')) continue;

        let conditionClear = false;
        if (req.reason === 'waiting_dependency') {
          conditionClear = true;
          const forAcceptance = current.type === 'acceptance';
          for (const dependencyId of dependencyIds) {
            const dependency = await isolated.hgetall(keys.hash.task(dependencyId));
            if (!isDependencySatisfied(dependency, forAcceptance)) {
              conditionClear = false;
              break;
            }
          }
        } else {
          const ownership = await isolated.hgetall(keys.hash.fileOwnership);
          conditionClear = ownershipIsClearForBlockedTask(
            current,
            ownership,
            Date.now(),
            { taskId, agentId },
          );
        }

        const now = Date.now();
        const tx = isolated.multi();
        tx.eval(
          TASK_BLOCK_CAS,
          10,
          taskKey,
          keys.string.lease(taskId),
          keys.zset.status.running,
          keys.zset.status.blocked,
          keys.hash.agent(agentId),
          keys.stream.events,
          keys.hash.fileOwnership,
          keys.set.ownerByAgent(agentId),
          keys.zset.status.pending,
          keys.stream.tasks,
          taskId,
          agentId,
          req.claim_token,
          req.reason,
          req.question_id ?? '',
          String(now),
          conditionClear ? '1' : '0',
        );
        const committed = await tx.exec();
        if (committed === null) continue;
        const raw = committed[0]?.[1] as string[] | undefined;
        return [String(raw?.[0] ?? 'RACE_RETRY_EXHAUSTED') as TaskBlockOutcome, String(raw?.[1] ?? '0')];
      } finally {
        await isolated.unwatch().catch(() => undefined);
      }
    }
    return ['RACE_RETRY_EXHAUSTED', '0'];
  } finally {
    isolated.disconnect();
  }
}

type BlockedRequeueOutcome =
  | 'REQUEUED'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_BLOCKED'
  | 'QUESTION_ANSWER_REQUIRED'
  | 'WAITING_FILE_RELEASE'
  | 'WAITING_DEPENDENCY'
  | 'UNSUPPORTED_BLOCK_REASON'
  | 'RACE_RETRY_EXHAUSTED';

/**
 * 判定 blocked 任务声明的所有文件范围是否都已没有活跃 ownership。
 *
 * 这里刻意不沿用 claim 时的优先级抢占规则：被搁置的 Worker 不能因为自身优先级较高就
 * 抢占并恢复，必须等相关占用真正释放。这样不会把 `waiting_file_release` 变成争抢循环。
 */
function ownershipIsClearForBlockedTask(
  taskHash: Record<string, string>,
  ownership: Record<string, string>,
  now: number,
  ignoreOwner?: { taskId: string; agentId: string },
): boolean {
  const requested = (taskHash.ownership_files ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0) return true;

  for (const [existingGlob, raw] of Object.entries(ownership)) {
    try {
      const record = JSON.parse(raw) as { expires_at?: number; task_id?: string; agent_id?: string };
      if (Number(record.expires_at ?? 0) <= now) continue;
      // block 会在同一个原子脚本内释放当前 task 自己的 ownership；它不能成为“仍需等待”
      // 的依据。其它 task/agent 的重叠占用才是有效阻塞条件。
      if (ignoreOwner && record.task_id === ignoreOwner.taskId && record.agent_id === ignoreOwner.agentId) continue;
      if (requested.some((wanted) => globsOverlap(existingGlob, wanted))) return false;
    } catch {
      // 损坏的 registry 条目不是可信的活跃占用；claim 的 activateOwnership 会在下一次领取时清理它。
    }
  }
  return true;
}

/**
 * 安全地把一个符合条件的 blocked task 放回 pending。
 *
 * 必须同时观察 task、依赖 task 与 ownership registry。WATCH/MULTI 让“检查原因/依赖/占用”
 * 与“切换 pending + 写 worker 门铃”成为同一个乐观原子提交：检查窗口内任一相关 key 变化，
 * EXEC 失败并重新读取，绝不以旧快照提前唤醒。WATCH 是连接级状态，因此整个事务只使用
 * `redis.duplicate()` 的专用连接，不能污染或被 Fastify 的共享请求连接覆盖。
 */
async function requeueBlockedEligible(
  redis: Redis,
  taskId: string,
): Promise<BlockedRequeueOutcome> {
  const taskKey = keys.hash.task(taskId);
  const isolated = redis.duplicate();
  try {
    // 先等专用连接就绪；不使用主连接的 WATCH 状态。
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      const initial = await isolated.hgetall(taskKey);
      if (!initial.task_id) return 'TASK_NOT_FOUND';
      if (initial.status !== 'blocked') return 'TASK_NOT_BLOCKED';
      if (initial.block_reason === 'waiting_pm_reply') return 'QUESTION_ANSWER_REQUIRED';

      const reason = initial.block_reason;
      if (reason !== 'waiting_file_release' && reason !== 'waiting_dependency') {
        return 'UNSUPPORTED_BLOCK_REASON';
      }

      const dependencies = reason === 'waiting_dependency'
        ? (initial.depends_on ?? '').split(',').map((item) => item.trim()).filter(Boolean)
        : [];
      const watched = [
        taskKey,
        ...(reason === 'waiting_file_release' ? [keys.hash.fileOwnership] : []),
        ...dependencies.map((dep) => keys.hash.task(dep)),
      ];
      await isolated.watch(...watched);

      try {
        const current = await isolated.hgetall(taskKey);
        if (!current.task_id) return 'TASK_NOT_FOUND';
        if (current.status !== 'blocked') return 'TASK_NOT_BLOCKED';
        if (current.block_reason === 'waiting_pm_reply') return 'QUESTION_ANSWER_REQUIRED';
        if (current.block_reason !== reason) continue;

        if (reason === 'waiting_file_release') {
          const ownership = await isolated.hgetall(keys.hash.fileOwnership);
          if (!ownershipIsClearForBlockedTask(current, ownership, Date.now())) return 'WAITING_FILE_RELEASE';
        } else {
          const asAcceptance = current.type === 'acceptance';
          for (const dependency of dependencies) {
            const dependencyHash = await isolated.hgetall(keys.hash.task(dependency));
            if (!isDependencySatisfied(dependencyHash, asAcceptance)) return 'WAITING_DEPENDENCY';
          }
        }

        const now = Date.now();
        const priority = Number(current.priority ?? 5);
        const eventType = reason === 'waiting_file_release' ? 'task_ready' : 'dependency_ready';
        const tx = isolated.multi();
        tx.del(keys.string.lease(taskId));
        tx.hset(taskKey, {
          status: 'pending',
          blocked_at: '',
          block_reason: '',
          blocked_question_id: '',
          blocked_lease_remaining: '',
          claimed_by: '',
          claimed_at: '',
          expire_at: '',
        });
        tx.zrem(keys.zset.status.blocked, taskId);
        tx.zadd(keys.zset.status.pending, pendingScore(priority, now), taskId);
        tx.xadd(keys.stream.tasks, '*', 'task_id', taskId, 'priority', String(priority));
        // worker 门铃只提供重新领取所需的定位信息；实际任务内容仍由 /claim 读取。
        tx.xadd(
          keys.stream.events,
          '*',
          'event_id', `${now}_${eventType}_${taskId}`,
          'type', eventType,
          'task_id', taskId,
          'plan_id', current.plan_id ?? '',
          'consumer', 'worker',
          'timestamp', String(now),
        );
        if ((await tx.exec()) !== null) {
          await persistTaskFromRedis(redis, taskId);
          return 'REQUEUED';
        }
      } finally {
        // EXEC 后已经自动 UNWATCH；显式调用则覆盖所有提前 return/continue 分支。
        await isolated.unwatch().catch(() => undefined);
      }
    }
    return 'RACE_RETRY_EXHAUSTED';
  } finally {
    // 专用事务连接只服务本次恢复判定，避免空闲连接随 blocked 任务数量累积。
    isolated.disconnect();
  }
}

/** 某次文件 ownership 被释放后，只检查真正等待文件释放的 blocked task。 */
async function requeueFileWaiters(redis: Redis): Promise<string[]> {
  const blockedIds = await redis.zrange(keys.zset.status.blocked, 0, -1);
  const requeued: string[] = [];
  for (const taskId of blockedIds) {
    // 文件释放只能唤醒因文件占用而停下的任务。不能借此顺带恢复一个
    // 恰好已满足依赖的 waiting_dependency task；后者只由依赖完成事件处理。
    const hash = await redis.hgetall(keys.hash.task(taskId));
    if (hash.status !== 'blocked' || hash.block_reason !== 'waiting_file_release') continue;
    const outcome = await requeueBlockedEligible(redis, taskId);
    if (outcome === 'REQUEUED') requeued.push(taskId);
  }
  return requeued;
}

/** 某任务有效完成后，只恢复直接依赖它且所有依赖均已满足的 blocked task。 */
async function requeueDependencyWaiters(redis: Redis, completedTaskId: string): Promise<string[]> {
  const blockedIds = await redis.zrange(keys.zset.status.blocked, 0, -1);
  const requeued: string[] = [];
  for (const taskId of blockedIds) {
    const hash = await redis.hgetall(keys.hash.task(taskId));
    if (hash.status !== 'blocked' || hash.block_reason !== 'waiting_dependency') continue;
    const dependencies = (hash.depends_on ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    // 只响应真正使此 task 的依赖图发生变化的 done 事件。通用 eligibility
    // 判定仍会检查所有依赖，保证多依赖场景不会提前恢复。
    if (!dependencies.includes(completedTaskId)) continue;
    const outcome = await requeueBlockedEligible(redis, taskId);
    if (outcome === 'REQUEUED') requeued.push(taskId);
  }
  return requeued;
}

/**
 * 低频补偿所有被动 blocked 状态。
 *
 * 只扫描 blocked 索引一次，并只把两种无需 PM 决策的等待交给同一原子 eligibility
 * 判定。`waiting_pm_reply` 和未知原因绝不在这里恢复，避免绕过 Question/PM 状态机。
 */
async function reconcileBlockedWaiters(redis: Redis): Promise<RuntimeReconciliationResult['requeued']> {
  const result: RuntimeReconciliationResult['requeued'] = {
    waiting_file_release: [],
    waiting_dependency: [],
  };
  const blockedIds = await redis.zrange(keys.zset.status.blocked, 0, -1);
  for (const taskId of blockedIds) {
    const hash = await redis.hgetall(keys.hash.task(taskId));
    const reason = hash.block_reason;
    if (hash.status !== 'blocked' || (reason !== 'waiting_file_release' && reason !== 'waiting_dependency')) continue;
    const outcome = await requeueBlockedEligible(redis, taskId);
    if (outcome === 'REQUEUED') result[reason].push(taskId);
  }
  return result;
}

/**
 * 一个依赖结点转为“有效完成”后唤醒其直接下游。
 *
 * 这里是唯一的依赖 ready 出口：report done 只能放开独立 acceptance，PM accept 或
 * repair resolution 才会放开普通下游；这样普通代码不会绕过 PM 验收，而验收任务也
 * 不会反向卡住自身。
 */
async function wakeDependents(redis: Redis, completedTaskId: string, opts: { allowAcceptance?: boolean } = {}): Promise<void> {
  const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
  for (const pendingId of pendingIds) {
    const pendingHash = await redis.hgetall(keys.hash.task(pendingId));
    if (!pendingHash.task_id || pendingHash.status !== 'pending') continue;
    const dependencies = (pendingHash.depends_on ?? '').split(',').filter(Boolean);
    if (!dependencies.includes(completedTaskId)) continue;
    // report done 时只能尝试独立 acceptance；普通任务必须等 pmReview accept/resolution。
    if (!opts.allowAcceptance && pendingHash.type === 'acceptance') continue;
    const ready = await checkDependencies(redis, hashToTaskRecord(pendingHash));
    if (!ready.ok) continue;
    const priority = pendingHash.priority ?? '5';
    await redis.xadd(keys.stream.tasks, '*', 'task_id', pendingId, 'priority', priority);

    // acceptance 只有在其原任务 delivery 已到位时才鸣铃；同一 ready 轮次仍由
    // fired 集合去重，reset 会显式清掉该标记。
    if (pendingHash.type === 'acceptance') {
      const firstTime = await redis.sadd(keys.acceptanceReady.fired, pendingId);
      if (firstTime === 1) {
        const now = Date.now();
        const consumer = await resolvePmConsumer(redis, pendingHash.plan_id ?? '');
        await redis.xadd(
          keys.stream.events,
          '*',
          'event_id', `${now}_acceptance_ready_${pendingId}`,
          'type', 'acceptance_ready',
          'task_id', pendingId,
          'plan_id', pendingHash.plan_id ?? '',
          'project_path', pendingHash.project_path ?? '',
          'consumer', consumer,
          'timestamp', String(now),
          'acked', 'false',
        );
      }
    }
  }
  await requeueDependencyWaiters(redis, completedTaskId);
}

export async function taskBlock(
  redis: Redis,
  taskId: string,
  agentId: string,
  req: { claim_token: string; reason: 'waiting_file_release' | 'waiting_dependency'; question_id?: string },
): Promise<ApiResponse<{ task_id: string; blocked: boolean }>> {
  if (!req.claim_token) {
    return { ok: false, data: null, error: { code: 'CLAIM_TOKEN_INVALID', message: 'claim_token 不能为空' } };
  }
  const [outcome, remainingTtl = '0'] = await blockTaskWithEligibilityCheck(redis, taskId, agentId, req);
  const errors: Record<string, { code: string; message: string }> = {
    TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
    TASK_NOT_RUNNING: { code: 'TASK_NOT_RUNNING', message: '只能搁置 running 任务' },
    CLAIM_OWNER_MISMATCH: { code: 'CLAIM_OWNER_MISMATCH', message: '任务不属于当前 Worker' },
    CLAIM_TOKEN_INVALID: { code: 'CLAIM_TOKEN_INVALID', message: 'claim_token 无效或已过期' },
    RACE_RETRY_EXHAUSTED: { code: 'BLOCK_RACE_RETRY_EXHAUSTED', message: '阻塞条件持续发生并发变化，请重新读取任务后重试' },
  };
  if (errors[outcome]) return { ok: false, data: null, error: errors[outcome] };

  // Redis 已原子完成最终状态；从 Redis 回放 SQLite，覆盖 BLOCKED 与条件已清除的 READY。
  await persistTaskFromRedis(redis, taskId);
  return { ok: true, data: { task_id: taskId, blocked: outcome === 'BLOCKED' } };
}

/** 恢复搁置的任务（POST /task/:id/resume）—— 回 pending，下一次 claim 生成新 token。 */
export async function taskResume(
  redis: Redis,
  taskId: string,
  agentId: string,
): Promise<ApiResponse<{ task_id: string; lease_remaining: number }>> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  if (hash.status !== 'blocked') {
    return { ok: false, data: null, error: { code: 'TASK_NOT_BLOCKED', message: `只能恢复 blocked 任务，当前 ${hash.status}` } };
  }
  if (hash.block_reason === 'waiting_pm_reply') {
    return {
      ok: false,
      data: null,
      error: { code: 'QUESTION_ANSWER_REQUIRED', message: '等待 PM 答复的任务只能由对应 Question 的 answer 接口恢复' },
    };
  }

  // 文件/依赖等待是被动阻塞：手工 resume 也必须复用自动恢复的同一组原子 eligibility
  // 判定。否则仍被占用的文件或尚未 accepted/resolved 的依赖会被伪装成 pending，并向
  // Worker 发出错误的 task_ready。Question 路径在上方保持其既有的 answer-only 语义。
  if (hash.block_reason === 'waiting_file_release' || hash.block_reason === 'waiting_dependency') {
    const outcome = await requeueBlockedEligible(redis, taskId);
    if (outcome === 'REQUEUED') {
      return { ok: true, data: { task_id: taskId, lease_remaining: 0 } };
    }
    const errors: Partial<Record<BlockedRequeueOutcome, { code: string; message: string }>> = {
      WAITING_FILE_RELEASE: {
        code: 'WAITING_FILE_RELEASE',
        message: '声明的文件范围仍被有效 ownership 占用，任务保持 blocked，等待释放后会自动恢复。',
      },
      WAITING_DEPENDENCY: {
        code: 'WAITING_DEPENDENCY',
        message: '依赖尚未形成有效交付（普通任务需 PM accepted 或 repair resolved），任务保持 blocked。',
      },
      QUESTION_ANSWER_REQUIRED: {
        code: 'QUESTION_ANSWER_REQUIRED',
        message: '等待 PM 答复的任务只能由对应 Question 的 answer 接口恢复。',
      },
      TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
      TASK_NOT_BLOCKED: { code: 'TASK_STATE_CHANGED', message: '任务状态已在恢复检查期间变化，请重新读取任务状态。' },
      UNSUPPORTED_BLOCK_REASON: { code: 'TASK_STATE_CHANGED', message: '任务阻塞原因已在恢复检查期间变化，请重新读取任务状态。' },
      RACE_RETRY_EXHAUSTED: { code: 'BLOCK_REQUEUE_RACE_RETRY_EXHAUSTED', message: '恢复检查遇到并发更新，任务保持 blocked，请稍后重试。' },
    };
    return {
      ok: false,
      data: null,
      error: errors[outcome] ?? { code: 'TASK_STATE_CHANGED', message: '任务状态已变化，请重新读取后再恢复。' },
    };
  }

  const now = Date.now();
  const priority = Number(hash.priority ?? 5);
  const tx = redis.multi();
  tx.del(keys.string.lease(taskId));
  tx.hset(keys.hash.task(taskId), {
    status: 'pending',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
  });
  tx.zrem(keys.zset.status.blocked, taskId);
  tx.zadd(keys.zset.status.pending, pendingScore(priority, now), taskId);
  tx.xadd(keys.stream.tasks, '*', 'task_id', taskId, 'priority', String(priority));
  tx.xadd(
    keys.stream.events,
    '*',
    'event_id',
    `${now}_task_resumed_${taskId}`,
    'type',
    'task_resumed',
    'task_id',
    taskId,
    'plan_id',
    hash.plan_id ?? '',
    'consumer',
    'worker',
    'timestamp',
    String(now),
  );
  await tx.exec();

  // SQLite 双写
  if (sqliteStore) {
    sqliteStore.updateTaskFields(taskId, {
      status: 'pending',
      blocked_at: '',
      block_reason: '',
      blocked_question_id: '',
      blocked_lease_remaining: '',
      claimed_by: '',
      claimed_at: '',
      expire_at: '',
    });
  }
  return { ok: true, data: { task_id: taskId, lease_remaining: 0 } };
}

function availableResolutionDecisionActions(hash: Record<string, string>): ResolutionDecisionAction[] {
  if (hash.resolution_status === 'needs_pm_decision') {
    const retryable = ['repair_retry_limit_reached', 'reverify_retry_limit_reached']
      .some((reason) => (hash.resolution_decision_reason ?? '').startsWith(reason));
    return retryable ? ['inspect', 'continue', 'cancel'] : ['inspect', 'cancel'];
  }
  return ['inspect'];
}

/** 查看任务验收信息（GET /task/:id/review）—— 读 work/<task_id>/ 的产出供 PM 验收 */
export async function getReviewInfo(
  redis: Redis,
  taskId: string,
): Promise<ApiResponse<unknown>> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  // 读 result.md / result.json（路径在 task hash 的 result_path / result_json_path）
  let resultMd = '';
  let resultJson: Record<string, unknown> = {};
  let planMdViolations: unknown[] = [];
  let resultPath = '';
  let resultJsonPath = '';
  try {
    const projectPath = resolveAndValidateWorkspacePath(hash.project_path, configuredWorkspaceRoots());
    if (hash.result_path) {
      resultPath = resolveAndValidateTaskArtifactPath(hash.result_path, projectPath, taskId, 'result.md');
    }
    if (hash.result_json_path) {
      resultJsonPath = resolveAndValidateTaskArtifactPath(hash.result_json_path, projectPath, taskId, 'result.json');
    }
  } catch (e) {
    return {
      ok: false,
      data: null,
      error: { code: 'RESULT_ARTIFACT_INVALID', message: `任务结果产物不可信：${(e as Error).message}` },
    };
  }
  if (resultJsonPath) {
    try {
      const rj = JSON.parse(readValidatedTaskArtifact(
        resultJsonPath,
        hash.project_path,
        taskId,
        'result.json',
      ));
      resultJson = rj;
      planMdViolations = (rj.plan_md_violations as unknown[]) ?? [];
    } catch {
      // 解析失败忽略
    }
  }
  if (resultPath) {
    try {
      resultMd = readValidatedTaskArtifact(resultPath, hash.project_path, taskId, 'result.md');
    } catch {
      // 读失败忽略
    }
  }
  const resolutionLineage = hash.resolution_task_ids
    ? hash.resolution_task_ids.split(',').filter(Boolean)
    : [];
  const latestRepairId = hash.resolution_task_id || resolutionLineage.at(-1) || '';
  const resolutionDecision = hash.resolution_status === 'needs_pm_decision'
    ? {
        state: 'needs_pm_decision',
        reason: hash.resolution_decision_reason ?? '',
        attempts: Number(hash.resolution_attempts ?? 0),
        max_retries: Math.max(1, Number(hash.max_retries ?? 2)),
        // 顺序是 CLI 默认展示合同：先检查证据，再明确续跑或终止。
        // 详细参数仍由专用决策接口校验，不让 CLI 根据文案猜状态。
        available_actions: availableResolutionDecisionActions(hash),
      }
    : undefined;
  return {
    ok: true,
    data: {
      task_id: taskId,
      title: hash.title ?? '',
      status: hash.status,
      claimed_by: hash.claimed_by ?? '',
      done_at: hash.done_at ?? '',
      pm_review_status: hash.pm_review_status ?? '',
      pm_reject_reason: hash.pm_reject_reason ?? '',
      pm_fix_instructions: hash.pm_fix_instructions ?? '',
      pm_rejection_resolution_mode: hash.pm_rejection_resolution_mode ?? '',
      failure_reason: hash.failed_reason ?? '',
      block_reason: hash.block_reason ?? '',
      fix_for: hash.fix_for ?? '',
      repair_root_task_id: hash.repair_root_task_id ?? '',
      resolution_status: hash.resolution_status ?? '',
      resolution_action: hash.resolution_action ?? '',
      resolution_task_id: hash.resolution_task_id ?? '',
      resolution_task_ids: resolutionLineage,
      // 为 PM/CLI 提供稳定语义名，避免客户端分别猜测“当前指针”和
      // “历史列表末项”。保留旧字段以向后兼容。
      latest_repair_id: latestRepairId,
      resolution_lineage: resolutionLineage,
      resolution_decision: resolutionDecision,
      resolved_by_task: hash.resolved_by_task ?? '',
      resolution_generation: Number(hash.resolution_generation ?? 0),
      resolution_attempts: Number(hash.resolution_attempts ?? 0),
      resolution_decision_reason: hash.resolution_decision_reason ?? '',
      repair_ownership_extension: parseRepairOwnershipAudit(hash.repair_ownership_extension),
      result_md: resultMd,
      result_json: resultJson,
      changed_files: (resultJson.changed_files as string[]) ?? [],
      verify_results: (resultJson.verify_results as unknown[]) ?? [],
      plan_md_violations: planMdViolations,
    },
  };
}

interface PmReviewRequest {
  verdict: 'accept' | 'reject';
  comment?: string;
  reject_reason?: string;
  fix_instructions?: string;
  repair_ownership?: RepairOwnershipExtension;
  /** acceptance reject 的显式处置：默认 repair；reverify 表示来源无需修改，只重做验收证据。 */
  resolution_mode?: 'repair' | 'reverify';
  reviewed_by: string;
}

type PmReviewResponse = ApiResponse<{
  task_id: string;
  review_status: string;
  resolution_mode?: 'repair' | 'reverify';
  fix_task_id?: string;
  fix_task_ids?: string[];
}>;

const RELEASE_PM_REVIEW_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * PM review 会同时写不可变审计、resolution、事件与依赖唤醒，必须按 task 串行。
 * 短锁只覆盖这段临界区；后到的网络重试等首个请求结束后重新读取真相，从而得到
 * 幂等回放或明确冲突，而不是双写 reviewer/reason/event。
 */
async function acquirePmReviewLock(redis: Redis, taskId: string): Promise<string | null> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 100; attempt++) {
    const acquired = await redis.set(keys.string.pmReviewLock(taskId), token, 'PX', 30_000, 'NX');
    if (acquired === 'OK') return token;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return null;
}

export interface ResolutionDecisionRequest {
  action: ResolutionDecisionAction;
  decided_by: string;
}

export interface ResolutionDecisionData {
  requested_task_id: string;
  root_task_id: string;
  state: ResolutionStatus | TaskStatus | 'unknown';
  action: ResolutionAction;
  reason: string;
  latest_repair_id: string;
  resolution_lineage: string[];
  attempts: number;
  max_retries: number;
  available_actions: ResolutionDecisionAction[];
  created_task_ids?: string[];
}

function resolutionDecisionData(
  requestedTaskId: string,
  root: Record<string, string>,
  createdTaskIds?: string[],
): ResolutionDecisionData {
  const lineage = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  const knownStates = new Set<string>([
    'required', 'repairing', 'resolved', 'needs_pm_decision', 'cancelled',
    'pending', 'running', 'blocked', 'done', 'failed',
  ]);
  const rawState = root.resolution_status || root.status || 'unknown';
  const knownActions = new Set<string>(['repair', 'reverify', 'inspect', 'continue', 'cancel']);
  const rawAction = root.resolution_action || 'inspect';
  return {
    requested_task_id: requestedTaskId,
    root_task_id: root.task_id,
    state: (knownStates.has(rawState) ? rawState : 'unknown') as ResolutionDecisionData['state'],
    action: (knownActions.has(rawAction) ? rawAction : 'inspect') as ResolutionAction,
    reason: root.resolution_decision_reason || '',
    latest_repair_id: root.resolution_task_id || lineage.at(-1) || '',
    resolution_lineage: lineage,
    attempts: Number(root.resolution_attempts ?? 0),
    max_retries: Math.max(1, Number(root.max_retries ?? 2)),
    available_actions: availableResolutionDecisionActions(root),
    ...(createdTaskIds ? { created_task_ids: createdTaskIds } : {}),
  };
}

async function resolveDecisionRoot(
  redis: Redis,
  taskId: string,
): Promise<{ requested: Record<string, string>; root: Record<string, string> } | null> {
  const requested = await redis.hgetall(keys.hash.task(taskId));
  if (!requested.task_id) return null;
  const rootTaskId = requested.repair_root_task_id || requested.task_id;
  const root = rootTaskId === requested.task_id
    ? requested
    : await redis.hgetall(keys.hash.task(rootTaskId));
  return root.task_id ? { requested, root } : null;
}

/** PM/CLI 只读检查根决策与完整 lineage，不需要解析 review 文案。 */
export async function getResolutionDecision(
  redis: Redis,
  taskId: string,
): Promise<ApiResponse<ResolutionDecisionData>> {
  const resolved = await resolveDecisionRoot(redis, taskId);
  if (!resolved) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  return { ok: true, data: resolutionDecisionData(taskId, resolved.root) };
}

/**
 * 对 needs_pm_decision 做显式决策。
 *
 * - inspect：纯读；
 * - continue：只额外放行一个新 generation，不 reset/覆盖旧 child；
 * - cancel：终止自动闭环但保留根任务与所有失败历史，plan 仍是失败而非伪成功。
 */
export async function resolutionDecision(
  redis: Redis,
  taskId: string,
  req: ResolutionDecisionRequest,
): Promise<ApiResponse<ResolutionDecisionData>> {
  if (!['inspect', 'continue', 'cancel'].includes(req.action)) {
    return { ok: false, data: null, error: { code: 'INVALID_RESOLUTION_ACTION', message: '决策只支持 inspect、continue 或 cancel。' } };
  }
  if (!req.decided_by?.trim()) {
    return { ok: false, data: null, error: { code: 'DECIDED_BY_REQUIRED', message: '决策必须记录 decided_by。' } };
  }
  if (req.action === 'inspect') return getResolutionDecision(redis, taskId);

  const initial = await resolveDecisionRoot(redis, taskId);
  if (!initial) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  const rootTaskId = initial.root.task_id;
  const lockToken = await acquirePmReviewLock(redis, rootTaskId);
  if (!lockToken) {
    return {
      ok: false,
      data: null,
      error: { code: 'RESOLUTION_DECISION_IN_PROGRESS', message: `任务 ${rootTaskId} 正在执行另一条决策，请稍后重试。` },
    };
  }

  try {
    const resolved = await resolveDecisionRoot(redis, rootTaskId);
    if (!resolved) {
      return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${rootTaskId}` } };
    }
    const root = resolved.root;

    if (req.action === 'cancel' && root.resolution_status === 'cancelled') {
      return { ok: true, data: resolutionDecisionData(taskId, root) };
    }
    if (root.resolution_status !== 'needs_pm_decision') {
      return {
        ok: false,
        data: null,
        error: {
          code: 'RESOLUTION_DECISION_NOT_PENDING',
          message: `根任务 ${rootTaskId} 当前不在 needs_pm_decision（${root.resolution_status || 'none'}）。`,
        },
      };
    }

    const now = Date.now();
    if (req.action === 'cancel') {
      const originalReason = root.resolution_decision_reason || 'operator_cancelled';
      await redis.hset(keys.hash.task(rootTaskId), {
        resolution_status: 'cancelled',
        resolution_action: 'cancel',
        resolution_decision_reason: `cancelled:${originalReason}`,
      });
      await persistTaskFromRedis(redis, rootTaskId);
      await redis.xadd(
        keys.stream.events,
        '*',
        'event_id', `${now}_resolution_cancel_${rootTaskId}`,
        'type', 'resolution_decided',
        'task_id', rootTaskId,
        'plan_id', root.plan_id ?? '',
        'project_path', root.project_path ?? '',
        'consumer', 'worker',
        'resolution_action', 'cancel',
        'decided_by', req.decided_by.trim(),
        'timestamp', String(now),
      );
      const cancelled = await redis.hgetall(keys.hash.task(rootTaskId));
      return { ok: true, data: resolutionDecisionData(taskId, cancelled) };
    }

    const reason = root.resolution_decision_reason ?? '';
    const retryable = reason.startsWith('repair_retry_limit_reached') ||
      reason.startsWith('reverify_retry_limit_reached');
    if (!retryable) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'RESOLUTION_CONTINUE_UNSAFE',
          message: `决策原因 ${reason || 'unknown'} 不能通过单纯增加一次重试安全恢复，请先 inspect 后重新规划。`,
        },
      };
    }

    const createdTaskIds: string[] = [];
    if (root.type === 'acceptance' && reason.startsWith('reverify_retry_limit_reached')) {
      const result = await ensureAcceptanceReverifyTask(
        redis,
        rootTaskId,
        `pm-continue:${req.decided_by.trim()}`,
        { allowRetryLimitOverride: true },
      );
      if (result.taskId) createdTaskIds.push(result.taskId);
    } else if (root.type === 'acceptance') {
      const repairTaskIds: string[] = [];
      for (const sourceTaskId of acceptanceSourceIds(root)) {
        const result = await ensureRepairTask(redis, sourceTaskId, {
          source: 'acceptance_failed',
          reason: `PM ${req.decided_by.trim()} 显式 continue，额外放行一代来源修复。`,
          decisionRootTaskId: rootTaskId,
          allowRetryLimitOverride: true,
        });
        if (result.repairTaskId) {
          repairTaskIds.push(result.repairTaskId);
          if (result.created) createdTaskIds.push(result.repairTaskId);
        }
      }
      if (repairTaskIds.length === 0) {
        return {
          ok: false,
          data: null,
          error: { code: 'RESOLUTION_CONTINUE_FAILED', message: '未能为验收根创建新的来源 repair。' },
        };
      }
      await markAcceptanceFailureResolution(redis, rootTaskId, repairTaskIds, false);
    } else {
      const latest = root.resolution_task_id
        ? await redis.hgetall(keys.hash.task(root.resolution_task_id))
        : {};
      const sourceTaskId = latest.fix_for || rootTaskId;
      const result = await ensureRepairTask(redis, sourceTaskId, {
        source: 'worker_failed',
        reason: `PM ${req.decided_by.trim()} 显式 continue，额外放行一代修复。`,
        allowRetryLimitOverride: true,
      });
      if (!result.repairTaskId) {
        return {
          ok: false,
          data: null,
          error: { code: 'RESOLUTION_CONTINUE_FAILED', message: '未能创建新的 repair generation。' },
        };
      }
      if (result.created) createdTaskIds.push(result.repairTaskId);
    }

    const continued = await redis.hgetall(keys.hash.task(rootTaskId));
    await redis.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_resolution_continue_${rootTaskId}`,
      'type', 'resolution_decided',
      'task_id', rootTaskId,
      'plan_id', root.plan_id ?? '',
      'project_path', root.project_path ?? '',
      'consumer', 'worker',
      'resolution_action', 'continue',
      'decided_by', req.decided_by.trim(),
      'created_tasks', createdTaskIds.join(','),
      'timestamp', String(now),
    );
    return { ok: true, data: resolutionDecisionData(taskId, continued, createdTaskIds) };
  } finally {
    await redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.pmReviewLock(rootTaskId), lockToken);
  }
}

/** PM 验收（POST /task/:id/review）—— accept 记录通过 / reject 生成修复 task（软门，不改 done） */
export async function pmReview(
  redis: Redis,
  taskId: string,
  req: PmReviewRequest,
): Promise<PmReviewResponse> {
  const lockToken = await acquirePmReviewLock(redis, taskId);
  if (!lockToken) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'PM_REVIEW_IN_PROGRESS',
        message: `任务 ${taskId} 正在执行另一条验收决定，请稍后重试。`,
      },
    };
  }
  try {
    return await pmReviewLocked(redis, taskId, req);
  } finally {
    await redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.pmReviewLock(taskId), lockToken);
  }
}

async function pmReviewLocked(
  redis: Redis,
  taskId: string,
  req: PmReviewRequest,
): Promise<PmReviewResponse> {
  const hash = await redis.hgetall(keys.hash.task(taskId));
  if (!hash.task_id) {
    return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` } };
  }
  if (hash.status !== 'done') {
    return {
      ok: false,
      data: null,
      error: { code: 'TASK_NOT_DONE', message: `只能验收 done 任务，当前状态为 ${hash.status}` },
    };
  }
  if (req.repair_ownership !== undefined && req.verdict !== 'reject') {
    return {
      ok: false,
      data: null,
      error: { code: 'REPAIR_OWNERSHIP_REJECT_ONLY', message: 'repair_ownership 只能用于 reject，以创建新的受控 repair。' },
    };
  }
  if (req.resolution_mode !== undefined && !['repair', 'reverify'].includes(req.resolution_mode)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_REVIEW_RESOLUTION_MODE', message: 'resolution_mode 只支持 repair 或 reverify。' },
    };
  }
  if (req.resolution_mode !== undefined && req.verdict !== 'reject') {
    return {
      ok: false,
      data: null,
      error: { code: 'RESOLUTION_MODE_REJECT_ONLY', message: 'resolution_mode 只能用于 reject。' },
    };
  }
  if (req.resolution_mode === 'reverify' && hash.type !== 'acceptance') {
    return {
      ok: false,
      data: null,
      error: { code: 'REVERIFY_ONLY_ACCEPTANCE_REQUIRED', message: 'reverify-only 只能用于 acceptance 任务。' },
    };
  }
  if (req.resolution_mode === 'reverify' && req.repair_ownership !== undefined) {
    return {
      ok: false,
      data: null,
      error: { code: 'REVERIFY_ONLY_OWNERSHIP_FORBIDDEN', message: 'reverify-only 表示来源无需修改，不能同时扩展 repair ownership。' },
    };
  }

  // accepted 是不可逆的发布/依赖边界：下游可能已在本次验收后领取并开始执行。
  // 网络重试的重复 accept 只回放既有结果，不更新 reviewer/comment；任何后续 reject
  // 都必须通过新的任务/复验表达，不能回写已生效的验收结论。
  if (hash.pm_review_status === 'accepted') {
    if (req.verdict === 'accept') {
      return { ok: true, data: { task_id: taskId, review_status: 'accepted' } };
    }
    return {
      ok: false,
      data: null,
      error: {
        code: 'PM_REVIEW_ALREADY_ACCEPTED',
        message: `任务 ${taskId} 已验收通过；accepted 结论不可改写为 reject，请创建新的修复或复验任务。`,
      },
    };
  }
  if (hash.pm_review_status === 'rejected' && req.verdict === 'accept') {
    return {
      ok: false,
      data: null,
      error: {
        code: 'PM_REVIEW_ALREADY_REJECTED',
        message: `任务 ${taskId} 已记录不可变的 reject；请验收当前 repair/reverify，不可改写原决定。`,
      },
    };
  }
  if (req.verdict === 'accept' && (hash.result_path || hash.result_json_path)) {
    try {
      const projectPath = resolveAndValidateWorkspacePath(hash.project_path, configuredWorkspaceRoots());
      if (hash.result_path) {
        resolveAndValidateTaskArtifactPath(hash.result_path, projectPath, taskId, 'result.md');
      }
      if (hash.result_json_path) {
        resolveAndValidateTaskArtifactPath(hash.result_json_path, projectPath, taskId, 'result.json');
      }
    } catch (e) {
      return {
        ok: false,
        data: null,
        error: { code: 'RESULT_ARTIFACT_INVALID', message: `任务结果产物不可信，不能 accept：${(e as Error).message}` },
      };
    }
  }

  const acceptanceFor = hash.type === 'acceptance' ? acceptanceSourceIds(hash) : [];
  const requestedResolutionMode: 'repair' | 'reverify' = req.resolution_mode ?? 'repair';
  if (req.verdict === 'reject' && hash.type === 'acceptance' && acceptanceFor.length === 0) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'ACCEPTANCE_SOURCE_REQUIRED',
        message: `验收任务 ${taskId} 没有 acceptance_for，无法确定需要修复的来源任务。`,
      },
    };
  }
  if (req.repair_ownership !== undefined && hash.type === 'acceptance' && acceptanceFor.length !== 1) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'AMBIGUOUS_ACCEPTANCE_REPAIR_OWNERSHIP',
        message: '多来源 acceptance 的 repair_ownership 无法无歧义地分配；请分别拒绝/扩权来源任务，或不带扩权拒绝该验收。',
      },
    };
  }
  if (req.verdict === 'reject' && hash.type === 'acceptance' && requestedResolutionMode === 'reverify') {
    for (const sourceTaskId of acceptanceFor) {
      const source = await redis.hgetall(keys.hash.task(sourceTaskId));
      if (!source.task_id) {
        return {
          ok: false,
          data: null,
          error: { code: 'ACCEPTANCE_SOURCE_NOT_FOUND', message: `验收来源任务不存在：${sourceTaskId}` },
        };
      }
      if (!isDependencySatisfied(source)) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'REVERIFY_ONLY_SOURCE_NOT_ACCEPTED',
            message: `来源任务 ${sourceTaskId} 尚未 accepted/resolved，不能声明“来源无需修复”并直接复验。`,
          },
        };
      }
    }
    const acceptanceDependencies = (hash.depends_on ?? '').split(',').filter(Boolean);
    for (const dependencyId of acceptanceDependencies) {
      const dependency = await redis.hgetall(keys.hash.task(dependencyId));
      if (!isDependencySatisfied(dependency)) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'REVERIFY_ONLY_DEPENDENCY_NOT_ACCEPTED',
            message: `原验收前置任务 ${dependencyId} 尚未 accepted/resolved，不能直接创建复验。`,
          },
        };
      }
    }
  }

  // 网络重试可能让同一个 reject 请求再次到达。验收拒绝已经冻结审计并进入来源
  // repair/reverify 后，精确重复必须只回放现有 repair id，不能重复计数或鸣铃。
  if (req.verdict === 'reject' && hash.type === 'acceptance' && hash.pm_review_status === 'rejected') {
    const historicalIds = (hash.resolution_task_ids ?? '').split(',').filter(Boolean);
    const historicalTasks = await Promise.all(
      historicalIds.map((id) => redis.hgetall(keys.hash.task(id))),
    );
    const storedResolutionMode: 'repair' | 'reverify' = hash.pm_rejection_resolution_mode === 'reverify'
      ? 'reverify'
      : 'repair';
    const fixTaskIds = historicalTasks
      .filter((task) => task.task_id && (storedResolutionMode === 'reverify' ? task.type === 'acceptance' : task.type !== 'acceptance'))
      .map((task) => task.task_id);
    const sameText = req.reviewed_by === (hash.pm_reviewed_by ?? '') &&
      (req.comment ?? '') === (hash.pm_review_comment ?? '') &&
      (req.reject_reason ?? '') === (hash.pm_reject_reason ?? '') &&
      (req.fix_instructions ?? '') === (hash.pm_fix_instructions ?? '');
    let sameOwnership = req.repair_ownership === undefined &&
      historicalTasks.every((task) => task.type === 'acceptance' || !task.repair_ownership_extension);

    if (req.repair_ownership !== undefined && acceptanceFor.length === 1) {
      const normalized = normalizeRepairOwnership(req.repair_ownership);
      const source = await redis.hgetall(keys.hash.task(acceptanceFor[0]));
      const rootId = source.repair_root_task_id || source.task_id;
      const root = rootId === source.task_id ? source : await redis.hgetall(keys.hash.task(rootId));
      const delta: { value?: NormalizedRepairOwnership; error?: string } = normalized.value && source.task_id
        ? repairOwnershipDelta(source, root, normalized.value)
        : {};
      if (!normalized.value || !delta.value) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'INVALID_REPAIR_OWNERSHIP',
            message: normalized.error ?? delta.error ?? 'repair_ownership 无效。',
          },
        };
      }
      sameOwnership = historicalTasks
        .filter((task) => task.task_id && task.type !== 'acceptance')
        .some((task) => {
          const audit = parseRepairOwnershipAudit(task.repair_ownership_extension);
          return JSON.stringify(audit ?? { files: [], modules: [] }) === JSON.stringify(delta.value);
        });
    }

    const sameResolutionMode = requestedResolutionMode === storedResolutionMode;
    if (!sameText || !sameOwnership || !sameResolutionMode) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'ACCEPTANCE_REJECTION_ALREADY_RECORDED',
          message: `验收任务 ${taskId} 已有不可变的拒绝审计；请处理当前来源 repair/reverify，不可用重复 review 改写原因或 ownership。`,
        },
      };
    }
    return {
      ok: true,
      data: {
        task_id: taskId,
        review_status: 'rejected',
        resolution_mode: storedResolutionMode,
        fix_task_id: fixTaskIds[0],
        fix_task_ids: fixTaskIds,
      },
    };
  }

  if (req.verdict === 'reject' && hash.type !== 'acceptance' && hash.pm_review_status === 'rejected') {
    const historicalIds = (hash.resolution_task_ids || hash.resolution_task_id || '')
      .split(',')
      .filter(Boolean);
    const historicalTasks = await Promise.all(historicalIds.map((id) => redis.hgetall(keys.hash.task(id))));
    const fixTaskIds = historicalTasks.filter((task) => task.task_id).map((task) => task.task_id);
    const sameText = req.reviewed_by === (hash.pm_reviewed_by ?? '') &&
      (req.comment ?? '') === (hash.pm_review_comment ?? '') &&
      (req.reject_reason ?? '') === (hash.pm_reject_reason ?? '') &&
      (req.fix_instructions ?? '') === (hash.pm_fix_instructions ?? '');
    let sameOwnership = req.repair_ownership === undefined &&
      historicalTasks.every((task) => !task.repair_ownership_extension);
    if (req.repair_ownership !== undefined) {
      const normalized = normalizeRepairOwnership(req.repair_ownership);
      const rootId = hash.repair_root_task_id || hash.task_id;
      const root = rootId === hash.task_id ? hash : await redis.hgetall(keys.hash.task(rootId));
      const delta = normalized.value ? repairOwnershipDelta(hash, root, normalized.value) : {};
      if (!normalized.value || !delta.value) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'INVALID_REPAIR_OWNERSHIP',
            message: normalized.error ?? delta.error ?? 'repair_ownership 无效。',
          },
        };
      }
      sameOwnership = historicalTasks.some((task) => {
        const audit = parseRepairOwnershipAudit(task.repair_ownership_extension);
        return JSON.stringify(audit ?? { files: [], modules: [] }) === JSON.stringify(delta.value);
      });
    }
    if (!sameText || !sameOwnership) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PM_REJECTION_ALREADY_RECORDED',
          message: `任务 ${taskId} 已有不可变的拒绝审计；不可并发或重复改写 reviewer、原因、指令或 ownership。`,
        },
      };
    }
    return {
      ok: true,
      data: {
        task_id: taskId,
        review_status: 'rejected',
        fix_task_id: fixTaskIds[0],
        fix_task_ids: fixTaskIds,
      },
    };
  }

  let repairOwnership: NormalizedRepairOwnership | undefined;
  if (req.repair_ownership !== undefined) {
    const normalized = normalizeRepairOwnership(req.repair_ownership);
    if (!normalized.value) {
      return {
        ok: false,
        data: null,
        error: { code: 'INVALID_REPAIR_OWNERSHIP', message: normalized.error ?? 'repair_ownership 无效。' },
      };
    }
    const ownershipSource = hash.type === 'acceptance'
      ? await redis.hgetall(keys.hash.task(acceptanceFor[0]))
      : hash;
    if (!ownershipSource.task_id) {
      return {
        ok: false,
        data: null,
        error: { code: 'ACCEPTANCE_SOURCE_NOT_FOUND', message: `验收来源任务不存在：${acceptanceFor[0]}` },
      };
    }
    const rootTaskId = ownershipSource.repair_root_task_id || ownershipSource.task_id;
    const root = rootTaskId === ownershipSource.task_id
      ? ownershipSource
      : await redis.hgetall(keys.hash.task(rootTaskId));
    const delta = repairOwnershipDelta(ownershipSource, root, normalized.value);
    if (!delta.value) {
      return {
        ok: false,
        data: null,
        error: { code: 'INVALID_REPAIR_OWNERSHIP', message: delta.error ?? 'repair_ownership 无效。' },
      };
    }
    const activeRepairId = root.resolution_task_id;
    if (activeRepairId) {
      const activeRepair = await redis.hgetall(keys.hash.task(activeRepairId));
      const active = activeRepair.task_id && (
        ['pending', 'running', 'blocked'].includes(activeRepair.status) ||
        (activeRepair.status === 'done' && !activeRepair.pm_review_status)
      );
      if (active && activeRepairId !== taskId) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'REPAIR_OWNERSHIP_REPAIR_ACTIVE',
            message: `当前 repair ${activeRepairId} 正在执行或等待验收；为避免改写其既有 ownership，请先处理该 repair。`,
          },
        };
      }
    }
    repairOwnership = delta.value;
  }
  // 原任务进入 repair/reverify 后，不能用一次旧的 accept 把失败审计和仍在跑的
  // 修复链绕过去。PM 应验收当前 repair task；resolved 状态已经是最终闭环，不再改写。
  if (req.verdict === 'accept' && hash.resolution_status) {
    return {
      ok: false,
      data: null,
      error: {
        code: hash.resolution_status === 'resolved' ? 'RESOLUTION_ALREADY_CLOSED' : 'RESOLUTION_ACTIVE',
        message: hash.resolution_status === 'resolved'
          ? `任务 ${taskId} 已由独立修复闭环，原审计记录不可再次 accept。`
          : `任务 ${taskId} 正在${hash.resolution_status === 'required' ? '等待修复交付的 PM 复验' : '修复闭环'}，请验收当前 repair task。`,
      },
    };
  }
  const now = Date.now();

  if (req.verdict === 'accept') {
    await redis.hset(keys.hash.task(taskId), {
      pm_review_status: 'accepted',
      pm_reviewed_by: req.reviewed_by,
      pm_reviewed_at: String(now),
      pm_review_comment: req.comment ?? '',
    });
    await redis.zrem(keys.reviewRequested.pending, taskId);
    sqliteStore?.updateTaskFields(taskId, {
      pm_review_status: 'accepted',
      pm_reviewed_by: req.reviewed_by,
      pm_reviewed_at: String(now),
      pm_review_comment: req.comment ?? '',
    });
    // PM accept 是普通下游真正的 dependency-ready 边界。若当前 task 是 repair，
    // 同时把它的 fix 链逐层标为 resolved（不改写原 rejected/failed 审计）。
    await wakeDependents(redis, taskId, { allowAcceptance: true });
    const resolvedTaskIds = await resolveRepairLineage(redis, taskId);
    for (const resolvedTaskId of resolvedTaskIds) {
      await wakeDependents(redis, resolvedTaskId, { allowAcceptance: true });
    }
    const acceptedHash = await redis.hgetall(keys.hash.task(taskId));
    await redis.xadd(
      keys.stream.events,
      '*',
      'event_id', `${now}_pm_accepted_${taskId}`,
      'type', 'pm_reviewed',
      'task_id', taskId,
      'plan_id', acceptedHash.plan_id ?? '',
      'project_path', acceptedHash.project_path ?? '',
      'consumer', 'worker',
      'verdict', 'accept',
      'timestamp', String(now),
    );
    return { ok: true, data: { task_id: taskId, review_status: 'accepted' } };
  }

  // reject：记录拒绝并进入统一 repair resolution（不改原 task 的 done 状态）。
  await redis.hset(keys.hash.task(taskId), {
    pm_review_status: 'rejected',
    pm_reviewed_by: req.reviewed_by,
    pm_reviewed_at: String(now),
    pm_review_comment: req.comment ?? '',
    pm_reject_reason: req.reject_reason ?? '',
    pm_fix_instructions: req.fix_instructions ?? '',
    pm_rejection_resolution_mode: hash.type === 'acceptance' ? requestedResolutionMode : '',
    ...(hash.type === 'acceptance' && requestedResolutionMode === 'reverify'
      ? {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        }
      : {}),
  });
  await redis.zrem(keys.reviewRequested.pending, taskId);
  sqliteStore?.updateTaskFields(taskId, {
    pm_review_status: 'rejected',
    pm_reviewed_by: req.reviewed_by,
    pm_reviewed_at: String(now),
    pm_review_comment: req.comment ?? '',
    pm_reject_reason: req.reject_reason ?? '',
    pm_fix_instructions: req.fix_instructions ?? '',
    pm_rejection_resolution_mode: hash.type === 'acceptance' ? requestedResolutionMode : '',
    ...(hash.type === 'acceptance' && requestedResolutionMode === 'reverify'
      ? {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        }
      : {}),
  });
  const resolutions: ResolutionResult[] = [];
  let directReverifyTaskId: string | undefined;
  if (hash.type === 'acceptance') {
    if (requestedResolutionMode === 'reverify') {
      const reverify = await ensureAcceptanceReverifyTask(
        redis,
        hash.repair_root_task_id || taskId,
        `pm-reverify-only:${req.reviewed_by}`,
        { trigger: 'pm_reverify_only' },
      );
      directReverifyTaskId = reverify.taskId;
      if (!reverify.taskId && !reverify.needsPmDecision) {
        await markResolutionNeedsPmDecision(redis, hash.repair_root_task_id || taskId, 'reverify_schedule_failed');
      }
    } else {
      for (const sourceTaskId of acceptanceFor) {
        resolutions.push(await ensureRepairTask(redis, sourceTaskId, {
          source: 'acceptance_failed',
          reason: `独立验收任务 ${taskId} 被 PM 拒绝。${req.reject_reason ? ` 原因：${req.reject_reason}` : ''}`,
          instructions: req.fix_instructions,
          // 多来源已在写审计前拒绝扩权，因此这里只可能是单来源扩权或无扩权。
          repairOwnership,
          decisionRootTaskId: hash.repair_root_task_id || hash.task_id,
        }));
      }
      await markAcceptanceFailureResolution(
        redis,
        taskId,
        resolutions.flatMap((resolution) => resolution.repairTaskId ? [resolution.repairTaskId] : []),
        resolutions.some((resolution) => resolution.state === 'needs_pm_decision'),
      );
    }
  } else {
    resolutions.push(await ensureRepairTask(redis, taskId, {
      source: 'pm_rejected',
      reason: req.reject_reason,
      instructions: req.fix_instructions,
      repairOwnership,
    }));
  }
  const fixTaskIds = [...new Set([
    ...(directReverifyTaskId ? [directReverifyTaskId] : []),
    ...resolutions.flatMap((resolution) => resolution.repairTaskId ? [resolution.repairTaskId] : []),
  ])];
  await redis.xadd(
    keys.stream.events,
    '*',
    'event_id', `${now}_pm_rejected_${taskId}`,
    'type', 'pm_reviewed',
    'task_id', taskId,
    'plan_id', hash.plan_id ?? '',
    'project_path', hash.project_path ?? '',
    'consumer', 'worker',
    'verdict', 'reject',
    'fix_task', fixTaskIds[0] ?? '',
    'fix_tasks', fixTaskIds.join(','),
    'resolution_mode', hash.type === 'acceptance' ? requestedResolutionMode : 'repair',
    'timestamp', String(now),
  );

  return {
    ok: true,
    data: {
      task_id: taskId,
      review_status: 'rejected',
      ...(hash.type === 'acceptance' ? { resolution_mode: requestedResolutionMode } : {}),
      fix_task_id: fixTaskIds[0],
      fix_task_ids: fixTaskIds,
    },
  };
}

interface PlanTaskState {
  task_id?: string;
  status: string;
  review_status?: string;
  resolution_status?: string;
  repair_root_task_id?: string;
  resolution_task_ids?: string[];
  supersede_batch_size?: number;
}

function derivePlanStatus(tasks: PlanTaskState[]): 'submitted' | 'active' | 'failed' | 'completed' | 'cancelled' {
  const byId = new Map(tasks.filter((task) => task.task_id).map((task) => [task.task_id!, task]));
  const lineageChildren = new Set(tasks.flatMap((task) => task.resolution_task_ids ?? []));
  // repair/reverify attempt 是根任务的不可变历史证据，不是第二个产品任务。
  // 只要根仍存在且已进入 resolution，就由根状态代表整条链；否则旧失败 attempt
  // 会让 resolved/cancelled 根之后的 plan 永久保持 failed、Supervisor 永久空转。
  const isResolutionChild = (task: PlanTaskState) => {
    if (!task.task_id) return false;
    if (lineageChildren.has(task.task_id)) return true;
    if (!task.repair_root_task_id || task.repair_root_task_id === task.task_id) return false;
    return Boolean(byId.get(task.repair_root_task_id)?.resolution_status);
  };
  const roots = tasks.filter((task) => !isResolutionChild(task));
  const effective = roots.filter((task) => !['cancelled', 'superseded'].includes(task.status));
  if (tasks.length > 0 && effective.length === 0) return 'cancelled';
  if (effective.length === 0) return 'submitted';
  const completed = (task: PlanTaskState) =>
    task.resolution_status === 'resolved' ||
    (!task.resolution_status && task.status === 'done' && task.review_status === 'accepted');
  const resolutionCancelled = (task: PlanTaskState) => task.resolution_status === 'cancelled';
  // 终态规则：
  // - completed：所有非历史根任务均 done+accepted 或 resolved；
  // - cancelled：没有任何有效根任务，或有显式 task/resolution cancel，或执行过 plan 批量 supersede；
  // - failed：未闭合 rejected/failed 或 needs_pm_decision；
  // - active：其余 pending/running/blocked/repairing/required 状态。
  // 单任务 supersede 只退出历史伪完成，不应污染已闭合的真实范围。
  // 一旦 task 进入 resolution，旧的 done/accepted 不再构成完成依据。
  if (effective.some((task) =>
    !completed(task) && !resolutionCancelled(task) &&
    (task.resolution_status === 'needs_pm_decision' ||
      ((task.status === 'failed' || task.review_status === 'rejected') &&
        !['repairing', 'required'].includes(task.resolution_status ?? ''))),
  )) return 'failed';
  if (effective.every((task) => completed(task) || resolutionCancelled(task))) {
    const explicitlyCancelled = roots.some((task) =>
      task.status === 'cancelled' ||
      task.resolution_status === 'cancelled' ||
      (task.status === 'superseded' && (task.supersede_batch_size ?? 0) > 0),
    );
    // 显式放弃任务/修复闭环或整计划批量 supersede 是合法终态，但不能伪装成 completed。
    return explicitlyCancelled
      ? 'cancelled'
      : 'completed';
  }
  return 'active';
}

/** get plan（对应 05 号 md 接口 10：GET /plan/{plan_id}）
 *  返回任务详情数组（title/type/assignee/ownership 等），供前端看板展示
 */
export async function getPlan(redis: Redis, planId: string): Promise<ApiResponse<unknown>> {
  const planHash = await redis.hgetall(keys.hash.plan(planId));
  if (!planHash.plan_id) {
    return { ok: true, data: null };
  }

  // 任务摘要（前端看板卡片字段）
  interface TaskSummary {
    task_id: string;
    title: string;
    type: string;
    phase: string;
    status: string;
    assignee: string;
    priority: number;
    ownership_files: string[];
    depends_on: string[];
    claimed_by?: string;
    claimed_at?: number;
    expire_at?: number;
    done_at?: number;
    review_status?: string;
    pm_review_status?: string;
    pm_reviewed_by?: string;
    pm_reviewed_at?: number;
    pm_review_comment?: string;
    pm_reject_reason?: string;
    pm_fix_instructions?: string;
    pm_rejection_resolution_mode?: string;
    repair_ownership_extension?: RepairOwnershipExtension;
    failure_reason?: string;
    blocked_reason?: string;
    blocked_at?: number;
    retries?: number;
    max_retries?: number;
    fix_for?: string;
    repair_root_task_id?: string;
    resolution_status?: string;
    resolution_action?: string;
    resolution_task_id?: string;
    resolution_task_ids?: string[];
    resolved_by_task?: string;
    resolution_generation?: number;
    resolution_attempts?: number;
    superseded_at?: number;
    superseded_by?: string;
    superseded_reason?: string;
    supersede_batch_size?: number;
  }

  const statusBuckets: Record<string, TaskSummary[]> = {
    pending: [],
    running: [],
    blocked: [],
    done: [],
    failed: [],
    cancelled: [],
    superseded: [],
  };
  const planTasks: Array<TaskSummary & PlanTaskState> = [];
  for (const status of Object.keys(statusBuckets)) {
    const zsetKey = (keys.zset.status as Record<string, string>)[status];
    const ids = await redis.zrange(zsetKey, 0, -1);
    for (const id of ids) {
      const h = await redis.hgetall(keys.hash.task(id));
      if (h.plan_id !== planId) continue;
      const summary: TaskSummary = {
        task_id: h.task_id,
        title: h.title,
        type: h.type,
        phase: h.phase,
        status: h.status || status,
        assignee: h.assignee,
        priority: Number(h.priority ?? 0),
        ownership_files: h.ownership_files ? h.ownership_files.split(',').filter(Boolean) : [],
        depends_on: h.depends_on ? h.depends_on.split(',').filter(Boolean) : [],
        claimed_by: h.claimed_by || undefined,
        claimed_at: h.claimed_at ? Number(h.claimed_at) : undefined,
        expire_at: h.expire_at ? Number(h.expire_at) : undefined,
        done_at: h.done_at ? Number(h.done_at) : undefined,
        review_status: h.pm_review_status || undefined,
        pm_review_status: h.pm_review_status || undefined,
        pm_reviewed_by: h.pm_reviewed_by || undefined,
        pm_reviewed_at: h.pm_reviewed_at ? Number(h.pm_reviewed_at) : undefined,
        pm_review_comment: h.pm_review_comment || undefined,
        pm_reject_reason: h.pm_reject_reason || undefined,
        pm_fix_instructions: h.pm_fix_instructions || undefined,
        pm_rejection_resolution_mode: h.pm_rejection_resolution_mode || undefined,
        repair_ownership_extension: parseRepairOwnershipAudit(h.repair_ownership_extension),
        failure_reason: h.failed_reason || undefined,
        blocked_reason: h.block_reason || undefined,
        blocked_at: h.blocked_at ? Number(h.blocked_at) : undefined,
        retries: h.retries ? Number(h.retries) : undefined,
        max_retries: h.max_retries ? Number(h.max_retries) : undefined,
        fix_for: h.fix_for || undefined,
        repair_root_task_id: h.repair_root_task_id || undefined,
        resolution_status: h.resolution_status || undefined,
        resolution_action: h.resolution_action || undefined,
        resolution_task_id: h.resolution_task_id || undefined,
        resolution_task_ids: h.resolution_task_ids ? h.resolution_task_ids.split(',').filter(Boolean) : undefined,
        resolved_by_task: h.resolved_by_task || undefined,
        resolution_generation: h.resolution_generation ? Number(h.resolution_generation) : undefined,
        resolution_attempts: h.resolution_attempts ? Number(h.resolution_attempts) : undefined,
        superseded_at: h.superseded_at ? Number(h.superseded_at) : undefined,
        superseded_by: h.superseded_by || undefined,
        superseded_reason: h.superseded_reason || undefined,
        supersede_batch_size: h.supersede_batch_size ? Number(h.supersede_batch_size) : undefined,
      };
      statusBuckets[status].push(summary);
      planTasks.push({ ...summary, status });
    }
  }

  const reviews = { pending: 0, accepted: 0, rejected: 0 };
  for (const task of planTasks.filter((item) => item.status === 'done')) {
    if (task.review_status === 'accepted') reviews.accepted++;
    else if (task.review_status === 'rejected') reviews.rejected++;
    else reviews.pending++;
  }

  return {
    ok: true,
    data: {
      plan_id: planHash.plan_id,
      title: planHash.title,
      status: derivePlanStatus(planTasks),
      declared_status: planHash.status,
      project_path: planHash.project_path,
      task_count: Number(planHash.task_count ?? 0),
      declared_task_count: Number(planHash.task_count ?? 0),
      runtime_task_count: planTasks.length,
      created_at: Number(planHash.created_at ?? 0),
      phases: planHash.phases ? JSON.parse(planHash.phases) : [],
      tasks: {
        pending: statusBuckets.pending,
        running: statusBuckets.running,
        blocked: statusBuckets.blocked,
        done: statusBuckets.done,
        failed: statusBuckets.failed,
        cancelled: statusBuckets.cancelled,
        superseded: statusBuckets.superseded,
      },
      reviews,
    },
  };
}

/** 全局 status（含 plans 列表 + agents 列表，供前端展示） */
export async function getStatus(redis: Redis): Promise<ApiResponse<unknown>> {
  const [pending, running, blocked, done, failed, cancelled, superseded] = await Promise.all([
    redis.zcard(keys.zset.status.pending),
    redis.zcard(keys.zset.status.running),
    redis.zcard(keys.zset.status.blocked),
    redis.zcard(keys.zset.status.done),
    redis.zcard(keys.zset.status.failed),
    redis.zcard(keys.zset.status.cancelled),
    redis.zcard(keys.zset.status.superseded),
  ]);
  const conflictCount = await redis.llen(keys.list.ownershipConflicts);

  // 复用 plan 列表投影，确保全局摘要与 GET /plans 使用同一派生状态口径。
  const planList = await getPlans(redis);
  const plans = (planList.data?.plans ?? []).map((plan) => ({
    plan_id: plan.plan_id,
    title: plan.title,
    status: plan.status,
    project_path: plan.project_path,
    task_count: plan.task_count,
  }));

  // agents 列表（扫描 hash:agent:*）
  const now = Date.now();
  const agentKeys = await scanKeys(redis, `${PREFIX}:hash:agent:*`);
  const agents: Array<{ agent_id: string; agent_type: string; status: string; current_task: string; last_heartbeat: number }> = [];
  let onlineAgents = 0;
  for (const ak of agentKeys) {
    const h = await redis.hgetall(ak);
    if (h.agent_id) {
      const lastHb = Number(h.last_heartbeat ?? 0);
      // 在线语义按心跳租约派生：超阈值的 agent 不再显示 idle/online，避免 PM 误判有执行者在线。
      const derived = deriveAgentStatus(h.status, lastHb, now);
      if (derived === 'idle' || derived === 'busy') onlineAgents++;
      agents.push({
        agent_id: h.agent_id,
        agent_type: h.agent_type,
        status: derived,
        current_task: h.current_task,
        last_heartbeat: lastHb,
      });
    }
  }

  // 在线计数与 hint 不得因历史注册记录误判：只有真正在线（心跳新鲜）的 agent 才算。

  // reviews 计数：统计 done 任务的验收状态（pending=未验收 / accepted / rejected）
  const doneIds = await redis.zrange(keys.zset.status.done, 0, -1);
  let reviewPending = 0;
  let reviewAccepted = 0;
  let reviewRejected = 0;
  for (const did of doneIds) {
    const rs = await redis.hget(keys.hash.task(did), 'pm_review_status');
    if (rs === 'accepted') reviewAccepted++;
    else if (rs === 'rejected') reviewRejected++;
    else reviewPending++;
  }

  // 无在线 agent 时返回 worker 接入引导 hint（新 PM 体验：避免看到全是 stale 的看板卡住）。
  // 关键：以真实在线计数判断，历史注册但已失联的 agent 不算"有执行者在"。
  const hint =
    onlineAgents === 0
      ? {
          // 前端按稳定语义码本地化展示，message 保留给旧客户端与 CLI 兼容。
          code: 'NO_ONLINE_WORKERS',
          message: '暂无在线 Worker。请先完成 bootstrap，再启动至少一个执行者。',
          doctor: '.biao/doctor',
          pm_guide: '.biao/PM_AGENT.md',
          start_worker: '.biao/worker-codex、.biao/worker-kimi 或 .biao/worker-custom',
        }
      : null;

  return {
    ok: true,
    data: {
      tasks: { pending, running, blocked, done, failed, cancelled, superseded },
      ownership_conflicts: conflictCount,
      reviews: { pending: reviewPending, accepted: reviewAccepted, rejected: reviewRejected },
      plans,
      agents,
      hint,
    },
  };
}

/** 查询任务完成事件流（对应 spec 05: `biao events`，GET /events）
 *  从 stream:events XRANGE 读取，支持 since（时间戳或相对时间）+ limit
 *  事件由 report() 写入（service.ts 步骤 6），字段：event_id/type/task_id/agent_id/result_status/acked
 */
export interface BiaoEvent {
  event_id: string;
  type: string;
  task_id: string;
  agent_id: string;
  result_status: string;
  acked: string;
  timestamp: number;
  /** PM 路由标识（review_requested/acceptance_ready 携带；旧事件可能缺失） */
  consumer?: string;
  plan_id?: string;
  /** Question 事件携带；旧事件没有该字段。 */
  question_id?: string;
  /** repair/decision 事件的最小动作语义；旧事件没有该字段。 */
  resolution_action?: string;
}

/** 使用精确 Redis stream 游标时的分页载荷。
 * 为不破坏现有 CLI，只有请求显式携带 `after` / `cursor` 才返回该对象；`since` 仍返回数组。 */
export interface BiaoEventCursorPage {
  events: BiaoEvent[];
  /** 本页最后一条 Redis stream ID；空页时回显请求游标，可直接作为下一轮 after。 */
  next_cursor: string;
}

function isValidStreamCursor(cursor: string): boolean {
  return /^(?:0|[1-9]\d*)-\d+$/.test(cursor);
}

export async function getEvents(
  redis: Redis,
  opts: { since?: number; limit?: number; after?: string } = {},
): Promise<ApiResponse<BiaoEvent[] | BiaoEventCursorPage>> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const after = opts.after?.trim();
  if (after !== undefined && !isValidStreamCursor(after)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_CURSOR', message: 'after 必须是 Redis stream ID（例如 0-0 或 1786520030000-0）' },
    };
  }
  // XRANGE 按时间顺序返回；stream id 形如 "1786466877493-0"（毫秒时间戳）
  // `after` 是严格排他的精确游标；`since` 保持旧行为（毫秒、含该毫秒第一条）以免 CLI 断裂。
  const minId = after !== undefined
    ? `(${after}`
    : opts.since && opts.since > 0
      ? `${opts.since}-0`
      : '-';
  const raw = (await redis.xrange(keys.stream.events, minId, '+', 'COUNT', limit)) as [
    string,
    string[],
  ][];

  const events: BiaoEvent[] = raw.map(([id, fields]) => parseEventEntry(id, fields));
  if (after !== undefined) {
    return {
      ok: true,
      data: { events, next_cursor: raw.at(-1)?.[0] ?? after },
    };
  }
  return { ok: true, data: events };
}

/** 把 stream entry 的扁平 field 数组解析成 BiaoEvent（供 getEvents/unackedEvents/intake 复用） */
function parseEventEntry(id: string, fields: string[]): BiaoEvent {
  const kv: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    kv[fields[i]] = fields[i + 1];
  }
  return {
    event_id: kv.event_id ?? id,
    type: kv.type ?? '',
    task_id: kv.task_id ?? '',
    agent_id: kv.agent_id ?? '',
    result_status: kv.result_status ?? '',
    acked: kv.acked ?? 'false',
    timestamp: Number(id.split('-')[0]),
    consumer: kv.consumer || undefined,
    plan_id: kv.plan_id || undefined,
    question_id: kv.question_id || undefined,
    resolution_action: kv.resolution_action || undefined,
  };
}

/**
 * `unacked` 的 durable 索引契约。
 *
 * stream 仍是审计真相源，绝不因 ack 而改写或删除；但同一个 consumer 反复轮询时，
 * 从 stream 起点重扫会把空闲 PM 的成本放大为 O(全部历史)。因此用两个 durable key：
 *
 * - cursor：已成功写入 pending 索引的 stream 精确游标；
 * - pending zset/hash：尚未 ack 的最小 PM 事件投影，按精确 stream id 排序。
 *
 * 新 consumer 没有 cursor 时会完整历史回放一次（补交语义）；初始化后每轮只扫描
 * cursor 之后的新增尾部 O(新增事件)，并从 pending 索引 O(返回事项) 读取。索引写入
 * 先于 cursor 前进；崩溃只会造成幂等重扫，绝不会让 cursor 越过未写入的事件。
 */
interface IndexedPendingEvent {
  stream_id: string;
  event: BiaoEvent;
}

const INTAKE_STREAM_PAGE_SIZE = 200;
const INTAKE_PENDING_PAGE_SIZE = 200;
const ZERO_STREAM_CURSOR = '0-0';

/** Redis Lua 用字符串比较 stream id，避免 Lua number 在 64-bit sequence 上失精。 */
const ADVANCE_CONSUMER_CURSOR = `
local function greater(a, b)
  local adash = string.find(a, '-')
  local bdash = string.find(b, '-')
  local am, as = string.sub(a, 1, adash - 1), string.sub(a, adash + 1)
  local bm, bs = string.sub(b, 1, bdash - 1), string.sub(b, bdash + 1)
  if #am ~= #bm then return #am > #bm end
  if am ~= bm then return am > bm end
  if #as ~= #bs then return #as > #bs end
  return as > bs
end

local current = redis.call('GET', KEYS[1])
if not current or greater(ARGV[1], current) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

/**
 * ZSET 同一 score 下按 member 字典序排列。Redis stream 的数字部分最大为 uint64，
 * 固定补到 20 位后可保持毫秒 + sequence 的精确次序（包括同一毫秒内的 -0/-1/...）。
 */
function pendingOrderPrefix(streamId: string): string {
  const [millis, sequence] = streamId.split('-');
  // parseEventEntry 的 id 来自 Redis stream；仍保留保护，避免坏数据破坏 ZSET 排序。
  if (!millis || !sequence || !/^\d+$/.test(millis) || !/^\d+$/.test(sequence)) {
    throw new Error(`invalid Redis stream id for intake index: ${streamId}`);
  }
  return `${millis.padStart(20, '0')}-${sequence.padStart(20, '0')}`;
}

function pendingMember(streamId: string, eventId: string): string {
  // base64url 不含 ':'，可无歧义从 member 中还原 event_id；event id 本身可能含 '-' / '_'.
  return `${pendingOrderPrefix(streamId)}:${Buffer.from(eventId).toString('base64url')}`;
}

function eventIdFromPendingMember(member: string): string | null {
  const separator = member.indexOf(':');
  if (separator < 0) return null;
  try {
    const eventId = Buffer.from(member.slice(separator + 1), 'base64url').toString('utf8');
    return eventId || null;
  } catch {
    return null;
  }
}

function parseIndexedPendingEvent(raw: string | null): IndexedPendingEvent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IndexedPendingEvent;
    if (!parsed.stream_id || !parsed.event?.event_id || !isValidStreamCursor(parsed.stream_id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function advanceConsumerCursor(redis: Redis, consumer: string, candidate: string): Promise<void> {
  await redis.eval(ADVANCE_CONSUMER_CURSOR, 1, keys.ack.consumerCursor(consumer), candidate);
}

/**
 * 将 cursor 后的新 stream entry 以幂等方式加入该 consumer 的 pending 索引。
 * 每页先 EXEC 写入 payload/zset，再推进 cursor；如果中途进程退出，下次只会重放该页。
 */
async function indexConsumerEventTail(redis: Redis, consumer: string): Promise<void> {
  const cursorKey = keys.ack.consumerCursor(consumer);
  const savedCursor = await redis.get(cursorKey);
  let min = savedCursor ? `(${savedCursor}` : '-';
  let lastSeen = savedCursor ?? ZERO_STREAM_CURSOR;
  let sawEntry = false;

  while (true) {
    const raw = (await redis.xrange(
      keys.stream.events,
      min,
      '+',
      'COUNT',
      INTAKE_STREAM_PAGE_SIZE,
    )) as [string, string[]][];
    if (raw.length === 0) break;

    const tx = redis.multi();
    for (const [streamId, fields] of raw) {
      const event = parseEventEntry(streamId, fields);
      // 非 PM 门铃不写入 pending，但仍必须推进 cursor；否则噪声事件会被无休止重扫。
      if (isPmEvent(event) && (!event.consumer || event.consumer === consumer)) {
        tx.zadd(keys.ack.consumerPending(consumer), 0, pendingMember(streamId, event.event_id));
        tx.hset(
          keys.ack.consumerPendingPayload(consumer),
          event.event_id,
          JSON.stringify({ stream_id: streamId, event } satisfies IndexedPendingEvent),
        );
      }
    }
    const outcomes = await tx.exec();
    if (!outcomes || outcomes.some(([error]) => error)) {
      throw new Error(`failed to persist intake pending index for consumer=${consumer}`);
    }

    lastSeen = raw.at(-1)![0];
    sawEntry = true;
    // cursor 只能单调向前：并发 poll 若交错，最多重复 index，不会倒退导致持续重扫。
    await advanceConsumerCursor(redis, consumer, lastSeen);
    if (raw.length < INTAKE_STREAM_PAGE_SIZE) break;
    min = `(${lastSeen}`;
  }

  // 空 stream 也需要标记已初始化；之后新增事件会从 (0-0) 读取，而非再次执行历史初始化。
  if (!sawEntry && !savedCursor) await advanceConsumerCursor(redis, consumer, ZERO_STREAM_CURSOR);
}

/** 当前 task 是否仍是 PM 尚未裁决的交付。空字符串、旧库 null 等都代表未验收。 */
function isUnreviewedDoneTask(hash: Record<string, string>): boolean {
  // 来源任务一旦进入 repair/reverify 链，它的旧 done 门铃已被更具体的
  // 修复链状态取代。否则 repair 已验收甚至重试已耗尽时，PM 还会收到
  // 原始交付的过期 review_requested。
  return hash.status === 'done' &&
    !(hash.pm_review_status ?? '').trim() &&
    !(hash.resolution_status ?? '').trim();
}

/**
 * 历史 review_requested 事件必须对应当前这一次 done，才可写入任务→event 映射。
 * report() 在同一个 now 写 done_at 与事件 timestamp；给 Redis stream 时钟留少量误差，
 * 避免 task reset/re-done 后一条旧事件覆盖新轮次的映射。
 */
function eventMatchesCurrentReviewGeneration(task: Record<string, string>, event: BiaoEvent): boolean {
  const doneAt = Number(task.done_at ?? 0);
  return !doneAt || Math.abs(event.timestamp - doneAt) <= 5_000;
}

/**
 * question_asked stream entry 是不可变审计，不是永久待办。consumer pending 只有在
 * Question、task 与 plan 的当前真相仍共同指向同一等待边界时才有效；answer/reset/
 * cancel/重新提问或路由变化都只撤回投影，绝不删除历史事件。
 */
async function questionDoorbellMatchesCurrentTruth(
  redis: Redis,
  event: BiaoEvent,
  consumer: string,
): Promise<boolean> {
  const questionId = event.question_id ?? '';
  const taskId = event.task_id ?? '';
  const eventPlanId = event.plan_id ?? '';
  if (!questionId || !taskId || !eventPlanId) return false;

  const [question, task] = await Promise.all([
    redis.hgetall(keys.hash.question(questionId)),
    redis.hgetall(keys.hash.task(taskId)),
  ]);
  if (!question.question_id || question.status !== 'open' || question.task_id !== taskId) return false;
  if (!task.task_id) return false;
  if (task.status !== 'blocked' || task.block_reason !== 'waiting_pm_reply') return false;
  if (task.blocked_question_id !== questionId) return false;

  const taskPlanId = task.plan_id ?? '';
  if (!taskPlanId || question.plan_id !== taskPlanId || eventPlanId !== taskPlanId) return false;
  const plan = await redis.hgetall(keys.hash.plan(taskPlanId));
  if (plan.plan_id !== taskPlanId) return false;

  return normalizePmConsumer(question.pm_consumer) === consumer &&
    normalizePmConsumer(plan.pm_consumer) === consumer;
}

/**
 * 一次性把升级前的两类真相建成轻量索引：
 *
 * - 旧 event stream 中已有 review_requested 的 task：标记已发门铃，防止升级后重复补发；
 * - 旧 Redis / SQLite 恢复的 done 未验收 task：加入持续待验收索引。
 *
 * 标志只在两个索引均完成后才写入。并发首次轮询可能重复扫描，但写入均幂等；之后不再
 * 全量 XRANGE 或扫描 done zset，日常轮询只读取持续索引和 event tail。
 */
async function ensureLegacyReviewIndexes(redis: Redis): Promise<void> {
  if (await redis.get(keys.reviewRequested.legacyIndexesReady)) return;

  const latestReviewEventByTask = new Map<string, BiaoEvent>();
  let cursor = '-';
  while (true) {
    const raw = (await redis.xrange(
      keys.stream.events,
      cursor,
      '+',
      'COUNT',
      INTAKE_STREAM_PAGE_SIZE,
    )) as [string, string[]][];
    if (raw.length === 0) break;
    for (const [streamId, fields] of raw) {
      const event = parseEventEntry(streamId, fields);
      if (event.type === 'review_requested' && event.task_id) {
        latestReviewEventByTask.set(event.task_id, event);
      }
    }
    if (raw.length < INTAKE_STREAM_PAGE_SIZE) break;
    cursor = `(${raw.at(-1)![0]}`;
  }

  // 先吸收真实历史门铃。这里先核对当前 task 的 done generation，避免 reset/re-done
  // 期间用很早的 audit event 覆盖当前轮次的 task→event 映射。
  const historicalReviewIds = [...latestReviewEventByTask.keys()];
  for (let start = 0; start < historicalReviewIds.length; start += INTAKE_PENDING_PAGE_SIZE) {
    const ids = historicalReviewIds.slice(start, start + INTAKE_PENDING_PAGE_SIZE);
    const hashes = await Promise.all(ids.map((taskId) => redis.hgetall(keys.hash.task(taskId))));
    const tx = redis.multi();
    let writes = 0;
    for (let index = 0; index < ids.length; index++) {
      const taskId = ids[index];
      const event = latestReviewEventByTask.get(taskId)!;
      const hash = hashes[index];
      if (!isUnreviewedDoneTask(hash) || !eventMatchesCurrentReviewGeneration(hash, event)) continue;
      tx.sadd(keys.reviewRequested.fired, taskId);
      tx.hset(keys.reviewRequested.eventByTask, taskId, event.event_id);
      writes += 2;
    }
    if (writes > 0) {
      const outcomes = await tx.exec();
      if (!outcomes || outcomes.some(([error]) => error)) {
        throw new Error('failed to index historic review_requested events');
      }
    }
  }

  // 状态索引是 PM intake 的持续事实来源：门铃 ack 后仍可用同一 task/event id 看见
  // 待验收项，不必每次重新扫全部 task hash。
  const doneIds = await redis.zrange(keys.zset.status.done, 0, -1);
  for (let start = 0; start < doneIds.length; start += INTAKE_PENDING_PAGE_SIZE) {
    const ids = doneIds.slice(start, start + INTAKE_PENDING_PAGE_SIZE);
    const hashes = await Promise.all(ids.map((taskId) => redis.hgetall(keys.hash.task(taskId))));
    const tx = redis.multi();
    let writes = 0;
    for (let index = 0; index < ids.length; index++) {
      const hash = hashes[index];
      if (!isUnreviewedDoneTask(hash)) continue;
      const doneAt = Number(hash.done_at ?? 0) || Date.now();
      tx.zadd(keys.reviewRequested.pending, doneAt, ids[index]);
      writes++;
    }
    if (writes > 0) {
      const outcomes = await tx.exec();
      if (!outcomes || outcomes.some(([error]) => error)) {
        throw new Error('failed to index historic unreviewed done tasks');
      }
    }
  }

  await redis.set(keys.reviewRequested.legacyIndexesReady, '1');
}

/**
 * 某一 PM consumer 的待验收状态第一次出现时，原子补一条最小 review_requested 门铃。
 * SADD + XADD 在同一 Lua 脚本内，多个 PM/Supervisor 并发轮询至多写一条；事件被 ack
 * 后，pending zset 仍保留 task，供 pmIntake 返回持续事实。
 */
const EMIT_PENDING_REVIEW_DOORBELL = `
local task_id = ARGV[1]
local consumer = ARGV[2]
local event_id = ARGV[3]
local now = ARGV[4]

if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id then return {'TASK_NOT_FOUND', ''} end
if (redis.call('HGET', KEYS[1], 'status') or '') ~= 'done' then return {'TASK_NOT_DONE', ''} end
local review_status = redis.call('HGET', KEYS[1], 'pm_review_status') or ''
if string.match(review_status, '%S') then return {'TASK_REVIEWED', ''} end
if not redis.call('ZSCORE', KEYS[2], task_id) then return {'NOT_INDEXED', ''} end

local plan_consumer = redis.call('HGET', KEYS[6], 'pm_consumer') or ''
-- 这里不能假设 JS 已成功回填：脚本是最终提交边界，必须自己把空/非法 legacy
-- consumer 视为默认 PM，否则会出现 JS 认为是 pm、Lua 却拒绝发门铃的分裂路由。
local first = string.sub(plan_consumer, 1, 1)
if plan_consumer == '' or #plan_consumer > 128
  or not string.match(first, '^[A-Za-z0-9]$')
  or not string.match(plan_consumer, '^[A-Za-z0-9%._%-]+$') then
  plan_consumer = ARGV[5]
end
if plan_consumer ~= consumer then return {'ROUTED_OTHER', plan_consumer} end

if redis.call('SADD', KEYS[3], task_id) == 0 then
  return {'EXISTS', redis.call('HGET', KEYS[4], task_id) or ''}
end

redis.call('HSET', KEYS[4], task_id, event_id)
redis.call(
  'XADD', KEYS[5], '*',
  'event_id', event_id,
  'type', 'review_requested',
  'task_id', task_id,
  'plan_id', redis.call('HGET', KEYS[1], 'plan_id') or '',
  'project_path', redis.call('HGET', KEYS[1], 'project_path') or '',
  'agent_id', redis.call('HGET', KEYS[1], 'claimed_by') or '',
  'consumer', consumer,
  'result_status', 'done',
  'timestamp', now,
  'acked', 'false'
)
return {'CREATED', event_id}
`;

async function emitPendingReviewDoorbells(redis: Redis, consumer: string): Promise<void> {
  const pendingIds = await redis.zrange(keys.reviewRequested.pending, 0, -1);
  const planConsumers = new Map<string, string>();
  const stale = redis.multi();
  let hasStale = false;

  for (const taskId of pendingIds) {
    const task = await redis.hgetall(keys.hash.task(taskId));
    if (!isUnreviewedDoneTask(task)) {
      stale.zrem(keys.reviewRequested.pending, taskId);
      hasStale = true;
      continue;
    }
    const planId = task.plan_id ?? '';
    let taskConsumer = planConsumers.get(planId);
    if (!taskConsumer) {
      taskConsumer = await resolvePmConsumer(redis, planId);
      planConsumers.set(planId, taskConsumer);
    }
    if (taskConsumer !== consumer) continue;

    const doneAt = task.done_at || String(Date.now());
    const eventId = `${doneAt}_review_${taskId}`;
    await redis.eval(
      EMIT_PENDING_REVIEW_DOORBELL,
      6,
      keys.hash.task(taskId),
      keys.reviewRequested.pending,
      keys.reviewRequested.fired,
      keys.reviewRequested.eventByTask,
      keys.stream.events,
      keys.hash.plan(planId),
      taskId,
      consumer,
      eventId,
      String(Date.now()),
      DEFAULT_PM_CONSUMER,
    );
  }

  if (hasStale) {
    const outcomes = await stale.exec();
    if (!outcomes || outcomes.some(([error]) => error)) {
      throw new Error('failed to clean stale pending review index entries');
    }
  }
}

/** 从 durable pending 索引按 stream 精确顺序取回仍未 ack 的事件。 */
async function readConsumerPending(
  redis: Redis,
  opts: { consumer: string; limit: number; type?: string; plan_id?: string },
): Promise<BiaoEvent[]> {
  const pendingKey = keys.ack.consumerPending(opts.consumer);
  const payloadKey = keys.ack.consumerPendingPayload(opts.consumer);
  const ackedKey = keys.ack.consumerAcked(opts.consumer);
  const events: BiaoEvent[] = [];
  let lowerBound = '-';

  while (events.length < opts.limit) {
    // 所有 member 的 score 均为 0，ZRANGEBYLEX 因而按固定宽度 stream-id 前缀精确分页。
    const members = await redis.zrangebylex(
      pendingKey,
      lowerBound,
      '+',
      'LIMIT',
      0,
      INTAKE_PENDING_PAGE_SIZE,
    );
    if (members.length === 0) break;

    const eventIds = members.map(eventIdFromPendingMember);
    const validIds = eventIds.filter((id): id is string => id !== null);
    const ackPipeline = redis.pipeline();
    for (const eventId of validIds) ackPipeline.sismember(ackedKey, eventId);
    const [payloads, ackOutcomes] = await Promise.all([
      validIds.length > 0 ? redis.hmget(payloadKey, ...validIds) : Promise.resolve([] as (string | null)[]),
      validIds.length > 0 ? ackPipeline.exec() : Promise.resolve([]),
    ]);
    // 每页最多 200 个 SISMEMBER 合为一个 pipeline RTT，避免空闲 poll 因 pending 数量
    // 线性增加网络往返；错误按未 ack 对待，下次 poll 会重试而不会静默丢事项。
    const ackResults = (ackOutcomes ?? []).map((outcome) => Number(outcome?.[1] ?? 0));
    const payloadById = new Map(validIds.map((eventId, index) => [eventId, payloads[index] ?? null]));
    const ackedById = new Map(validIds.map((eventId, index) => [eventId, ackResults[index] === 1]));
    const cleanup = redis.multi();
    let hasCleanup = false;

    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      const eventId = eventIds[index];
      const indexed = eventId ? parseIndexedPendingEvent(payloadById.get(eventId) ?? null) : null;
      // payload 丢失/损坏、路由不匹配或已 ack 的孤儿索引都可安全清理；stream 审计历史不受影响。
      if (!eventId || !indexed || indexed.event.event_id !== eventId || indexed.event.consumer && indexed.event.consumer !== opts.consumer || ackedById.get(eventId)) {
        cleanup.zrem(pendingKey, member);
        if (eventId) cleanup.hdel(payloadKey, eventId);
        hasCleanup = true;
        continue;
      }
      // event_id 是语义幂等键。灾难恢复/旧审计回放可能让同一 event_id
      // 出现在多个 stream entry；payload hash 始终指向最新 entry，旧 member 只删
      // ZSET，不得删共用 payload，从而 PM 最多收到一次门铃且审计仍保留。
      if (pendingMember(indexed.stream_id, eventId) !== member) {
        cleanup.zrem(pendingKey, member);
        hasCleanup = true;
        continue;
      }
      // 旧版本会把“repair 已排队”也写成 PM 门铃。repairing/required/resolved
      // 都没有 PM 可执行动作；只保留真正达到边界的 needs_pm_decision。这里顺便
      // 清掉旧 pending 索引，审计 stream 本身不变，也不要求 PM 人工 ack 噪声事件。
      if (indexed.event.type === 'resolution_required') {
        const task = indexed.event.task_id
          ? await redis.hgetall(keys.hash.task(indexed.event.task_id))
          : {};
        if (task.resolution_status !== 'needs_pm_decision') {
          cleanup.zrem(pendingKey, member);
          cleanup.hdel(payloadKey, eventId);
          hasCleanup = true;
          continue;
        }
      }
      // Question 被回答或 task/plan 路由发生变化后，历史 question_asked 只能留在
      // stream 审计中，不能继续占据任何 consumer 的主动 pending 投影。
      if (indexed.event.type === 'question_asked' &&
          !(await questionDoorbellMatchesCurrentTruth(redis, indexed.event, opts.consumer))) {
        cleanup.zrem(pendingKey, member);
        cleanup.hdel(payloadKey, eventId);
        hasCleanup = true;
        continue;
      }
      // supersede/cancel/reset 等状态迁移会撤回待验收事实，但不可删除历史 stream。
      // 新 consumer 首次回放旧 review_requested 时在这里按当前 task 真相清理，避免
      // 已终止任务重新响铃；已有 consumer 的投影也由 supersede 主动移除。
      if (indexed.event.type === 'review_requested') {
        const task = indexed.event.task_id
          ? await redis.hgetall(keys.hash.task(indexed.event.task_id))
          : {};
        if (!isUnreviewedDoneTask(task)) {
          cleanup.zrem(pendingKey, member);
          cleanup.hdel(payloadKey, eventId);
          hasCleanup = true;
          continue;
        }
      }
      if (opts.type && indexed.event.type !== opts.type) continue;
      if (opts.plan_id && indexed.event.plan_id !== opts.plan_id) continue;
      events.push(indexed.event);
      if (events.length >= opts.limit) break;
    }
    if (hasCleanup) {
      const outcomes = await cleanup.exec();
      if (!outcomes || outcomes.some(([error]) => error)) {
        throw new Error(`failed to clean stale intake pending index for consumer=${opts.consumer}`);
      }
    }
    if (events.length >= opts.limit || members.length < INTAKE_PENDING_PAGE_SIZE) break;
    lowerBound = `(${members.at(-1)!}`;
  }
  return events;
}

/** consumer 未确认事件（对应 GET /intake/unacked?consumer=）。
 *
 * - 首次调用：完整历史回放并建立索引，保证新 PM 不漏此前门铃；
 * - 后续调用：只 XRANGE 新增尾部，并从 pending 索引读未确认事项；
 * - ack 只清理 consumer 的索引/ack 集，不会修改 Redis stream 历史，也不会影响其它 consumer。
 */
export async function unackedEvents(
  redis: Redis,
  opts: { consumer: string; limit?: number; type?: string; plan_id?: string },
): Promise<ApiResponse<BiaoEvent[]>> {
  if (!isValidConsumerName(opts.consumer)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_CONSUMER', message: 'consumer 名称非法（仅允许字母/数字/点/下划线/连字符，1~128 字符）' },
    };
  }
  const consumer = opts.consumer;
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  await redis.sadd(keys.ack.consumers, consumer);
  // 兼容升级前“已有 done 状态、没有 review_requested 事件”的现场。首次只建索引，
  // 当前 consumer 再原子补自己应接收的一次门铃；之后均是常数个索引读，不重扫历史。
  await ensureLegacyReviewIndexes(redis);
  await emitPendingReviewDoorbells(redis, consumer);
  await indexConsumerEventTail(redis, consumer);
  return { ok: true, data: await readConsumerPending(redis, { consumer, limit, type: opts.type, plan_id: opts.plan_id }) };
}

/** 判定是否为 PM 需关注的语义事件（仅这些进入未确认队列 / intake）。
 * repair_scheduled 是 Worker 队列事件；旧 resolution_required(action=repair) 同样
 * 降级为审计事件，只有 inspect/重试耗尽才需要 PM 判断。 */
function isPmEvent(event: BiaoEvent): boolean {
  return event.type === 'review_requested' || event.type === 'acceptance_ready' || event.type === 'question_asked' ||
    (event.type === 'resolution_required' && event.resolution_action !== 'repair');
}

/** consumer 确认事件（对应 POST /intake/ack）
 *  幂等：SADD 重复 ack 不报错、不改 stream 历史、不影响其他 consumer。 */
export async function ackEvent(
  redis: Redis,
  opts: { consumer: string; event_id: string; plan_id?: string },
): Promise<ApiResponse<{ event_id: string; acked: boolean; already_acked: boolean }>> {
  if (!isValidConsumerName(opts.consumer)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_CONSUMER', message: 'consumer 名称非法' },
    };
  }
  if (!opts.event_id) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_EVENT_ID', message: 'event_id 不能为空' },
    };
  }
  // 通常 ack 紧随 intake：直接读该 consumer 的 pending payload，无须重新扫描全部 stream。
  // 兼容旧客户端直接给历史 event_id / stream id 的情形：索引未命中时才做一次历史查找。
  let matching: IndexedPendingEvent | null = parseIndexedPendingEvent(
    await redis.hget(keys.ack.consumerPendingPayload(opts.consumer), opts.event_id),
  );
  if (!matching) matching = await findEventForAck(redis, opts.event_id);
  if (!matching) {
    return { ok: false, data: null, error: { code: 'EVENT_NOT_FOUND', message: 'event_id 不存在，不能确认' } };
  }
  const eventConsumer = matching.event.consumer ?? DEFAULT_PM_CONSUMER;
  if (eventConsumer !== opts.consumer) {
    return {
      ok: false,
      data: null,
      error: { code: 'CONSUMER_NOT_AUTHORIZED', message: `事件仅归属 consumer=${eventConsumer}` },
    };
  }
  if (opts.plan_id && matching.event.plan_id !== opts.plan_id) {
    return { ok: false, data: null, error: { code: 'PLAN_NOT_AUTHORIZED', message: `事件不属于 plan=${opts.plan_id}` } };
  }
  const canonicalEventId = matching.event.event_id;
  // SADD 返回 1=新增（首次 ack），0=已存在（幂等重放）。同时删本 consumer 的 pending
  // 投影，避免反复轮询读取已确认事项；审计 stream 不会被修改。
  const member = pendingMember(matching.stream_id, canonicalEventId);
  const tx = redis.multi();
  tx.sadd(keys.ack.consumerAcked(opts.consumer), canonicalEventId);
  tx.sadd(keys.ack.consumers, opts.consumer);
  tx.zrem(keys.ack.consumerPending(opts.consumer), member);
  tx.hdel(keys.ack.consumerPendingPayload(opts.consumer), canonicalEventId);
  const outcomes = await tx.exec();
  if (!outcomes || outcomes.some(([error]) => error)) {
    throw new Error(`failed to ack intake event for consumer=${opts.consumer}`);
  }
  const added = Number(outcomes?.[0]?.[1] ?? 0);
  return { ok: true, data: { event_id: canonicalEventId, acked: true, already_acked: added === 0 } };
}

/** 未进入当前 consumer 索引时的兼容性回退：按精确 stream id 直读，否则一次性历史查找。 */
async function findEventForAck(redis: Redis, eventId: string): Promise<IndexedPendingEvent | null> {
  if (isValidStreamCursor(eventId)) {
    const direct = (await redis.xrange(keys.stream.events, eventId, eventId)) as [string, string[]][];
    if (direct.length > 0) {
      const [streamId, fields] = direct[0];
      return { stream_id: streamId, event: parseEventEntry(streamId, fields) };
    }
  }

  let cursor = '-';
  while (true) {
    const raw = (await redis.xrange(keys.stream.events, cursor, '+', 'COUNT', INTAKE_STREAM_PAGE_SIZE)) as [string, string[]][];
    if (raw.length === 0) return null;
    for (const [streamId, fields] of raw) {
      const event = parseEventEntry(streamId, fields);
      if (event.event_id === eventId || streamId === eventId) {
        return { stream_id: streamId, event };
      }
    }
    if (raw.length < INTAKE_STREAM_PAGE_SIZE) return null;
    cursor = `(${raw.at(-1)![0]}`;
  }
}

/** 查询文件占用冲突历史（对应 spec 05: `biao conflicts`，GET /conflicts）
 *  从 list:ownership_conflicts LRANGE 读取（logConflict 写入，ownership.ts:259）
 *  每条是 JSON：{ts, path, winner:{agent_id,task_id,priority}, loser:{...}, action}
 */
export interface BiaoConflict {
  conflict_id: number;
  path: string;
  winner: { agent_id: string; task_id: string; priority: number };
  loser: { agent_id: string; task_id: string; priority: number };
  resolved: boolean;
  action: string;
  timestamp: number;
}

export async function getConflicts(
  redis: Redis,
  opts: { limit?: number } = {},
): Promise<ApiResponse<BiaoConflict[]>> {
  const limit = opts.limit ?? 20;
  // LRANGE 0 limit-1 返回最新 N 条（logConflict 用 LPUSH，所以 0 是最新）
  const raw = (await redis.lrange(keys.list.ownershipConflicts, 0, limit - 1)) as string[];

  const conflicts: BiaoConflict[] = raw.map((entry, idx) => {
    try {
      const c = JSON.parse(entry) as {
        ts: number;
        path: string;
        winner: { agent_id: string; task_id: string; priority: number };
        loser: { agent_id: string; task_id: string; priority: number };
        action: string;
      };
      return {
        conflict_id: idx,
        path: c.path,
        winner: c.winner,
        loser: c.loser,
        // action=preempt 表示发生了抢占；wait 表示一方在等。都没有"自动 resolved"语义，
        // 这里 resolved 暂时标记 false（历史记录本身都是已发生的事件）
        resolved: false,
        action: c.action,
        timestamp: c.ts,
      };
    } catch {
      return {
        conflict_id: idx,
        path: '',
        winner: { agent_id: '', task_id: '', priority: 0 },
        loser: { agent_id: '', task_id: '', priority: 0 },
        resolved: false,
        action: '',
        timestamp: 0,
      };
    }
  });

  return { ok: true, data: conflicts };
}

/** 批量查询任务（对应 spec 05: `biao task list`，GET /tasks）
 *  从 status zset 遍历 task_id，关联 hash:task 取详情，支持 plan_id / status / limit 过滤
 */
export interface TaskListItem {
  task_id: string;
  title: string;
  type: string;
  phase: string;
  status: string;
  assignee: string;
  priority: number;
  plan_id: string;
  project_path: string;
  pm_review_status?: string;
  failure_reason?: string;
  block_reason?: string;
  fix_for?: string;
  repair_root_task_id?: string;
  resolution_status?: string;
  resolution_action?: string;
  resolution_task_id?: string;
  resolution_task_ids?: string[];
  resolved_by_task?: string;
  resolution_generation?: number;
  resolution_attempts?: number;
  superseded_at?: number;
  superseded_by?: string;
  superseded_reason?: string;
}

export async function getTasks(
  redis: Redis,
  opts: { plan_id?: string; status?: string; limit?: number } = {},
): Promise<ApiResponse<{ tasks: TaskListItem[]; total: number }>> {
  const limit = opts.limit ?? 100;
  // status 过滤：若指定了单个 status，只查那个 zset。
  const allStatuses = ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'];
  const statuses = opts.status && allStatuses.includes(opts.status) ? [opts.status] : allStatuses;

  const items: TaskListItem[] = [];
  for (const st of statuses) {
    const zsetKey = (keys.zset.status as Record<string, string>)[st];
    const ids = await redis.zrange(zsetKey, 0, -1);
    for (const id of ids) {
      const h = await redis.hgetall(keys.hash.task(id));
      if (!h.task_id) continue;
      // plan_id 过滤
      if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
      items.push({
        task_id: h.task_id,
        title: h.title ?? '',
        type: h.type ?? '',
        phase: h.phase ?? '',
        status: st,
        assignee: h.assignee ?? 'auto',
        priority: Number(h.priority ?? 0),
        plan_id: h.plan_id ?? '',
        project_path: h.project_path ?? '',
        pm_review_status: h.pm_review_status || undefined,
        failure_reason: h.failed_reason || undefined,
        block_reason: h.block_reason || undefined,
        fix_for: h.fix_for || undefined,
        repair_root_task_id: h.repair_root_task_id || undefined,
        resolution_status: h.resolution_status || undefined,
        resolution_action: h.resolution_action || undefined,
        resolution_task_id: h.resolution_task_id || undefined,
        resolution_task_ids: h.resolution_task_ids ? h.resolution_task_ids.split(',').filter(Boolean) : undefined,
        resolved_by_task: h.resolved_by_task || undefined,
        resolution_generation: h.resolution_generation ? Number(h.resolution_generation) : undefined,
        resolution_attempts: h.resolution_attempts ? Number(h.resolution_attempts) : undefined,
        superseded_at: h.superseded_at ? Number(h.superseded_at) : undefined,
        superseded_by: h.superseded_by || undefined,
        superseded_reason: h.superseded_reason || undefined,
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }

  return { ok: true, data: { tasks: items, total: items.length } };
}

/** 列出所有 plan + 各状态任务计数（对应 spec 05: `biao plan list`，GET /plans）
 *  plan 元信息在 hash:plan:*；任务状态计数按 hash:task:* 的 plan_id + status 分组
 */
export interface BiaoPlanSummary {
  plan_id: string;
  title: string;
  status: string;
  created_at: number;
  project_path: string;
  task_count: number;
  tasks: { pending: number; running: number; blocked: number; done: number; failed: number; cancelled: number; superseded: number };
  reviews: { pending: number; accepted: number; rejected: number };
}

export async function getPlans(
  redis: Redis,
): Promise<ApiResponse<{ plans: BiaoPlanSummary[]; total: number }>> {
  const planKeys = await scanKeys(redis, `${PREFIX}:hash:plan:*`);
  const plans: BiaoPlanSummary[] = [];
  for (const pk of planKeys) {
    const h = await redis.hgetall(pk);
    if (h.plan_id) {
      plans.push({
        plan_id: h.plan_id,
        title: h.title,
        status: h.status,
        created_at: Number(h.created_at ?? 0),
        project_path: h.project_path,
        task_count: Number(h.task_count ?? 0),
        tasks: { pending: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0, superseded: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      });
    }
  }

  // 按 plan_id 分组统计任务状态
  const byPlan = new Map(plans.map((p) => [p.plan_id, p.tasks]));
  const reviewsByPlan = new Map(plans.map((p) => [p.plan_id, p.reviews]));
  const taskStatesByPlan = new Map<string, PlanTaskState[]>();
  const taskKeys = await scanKeys(redis, `${PREFIX}:hash:task:*`);
  for (const tk of taskKeys) {
    const t = await redis.hgetall(tk);
    const counter = t.plan_id ? byPlan.get(t.plan_id) : undefined;
    if (counter && ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'].includes(t.status)) {
      (counter as Record<string, number>)[t.status] += 1;
      const states = taskStatesByPlan.get(t.plan_id) ?? [];
      states.push({
        task_id: t.task_id,
        status: t.status,
        review_status: t.pm_review_status || undefined,
        resolution_status: t.resolution_status || undefined,
        repair_root_task_id: t.repair_root_task_id || undefined,
        resolution_task_ids: t.resolution_task_ids ? t.resolution_task_ids.split(',').filter(Boolean) : undefined,
        supersede_batch_size: t.supersede_batch_size ? Number(t.supersede_batch_size) : undefined,
      });
      taskStatesByPlan.set(t.plan_id, states);
      if (t.status === 'done') {
        const reviews = reviewsByPlan.get(t.plan_id)!;
        if (t.pm_review_status === 'accepted') reviews.accepted++;
        else if (t.pm_review_status === 'rejected') reviews.rejected++;
        else reviews.pending++;
      }
    }
  }

  for (const plan of plans) {
    plan.status = derivePlanStatus(taskStatesByPlan.get(plan.plan_id) ?? []);
  }

  return { ok: true, data: { plans, total: plans.length } };
}

/** 查询当前所有活跃的文件占用（对应 biao ownership list，GET /ownership/active）
 *  遍历 hash:file_ownership，过滤掉已过期的记录，返回每个 glob 的占用详情
 *  供 PM 查看"谁占着哪些文件"，识别潜在的 worker 卡死
 */
export interface ActiveOwnershipItem {
  path: string;
  agent_id: string;
  task_id: string;
  priority: number;
  declared_at: number;
  expires_at: number;
  base_commit_sha: string;
}

export async function getActiveOwnership(redis: Redis): Promise<ApiResponse<{ ownership: ActiveOwnershipItem[]; total: number }>> {
  const now = Date.now();
  const allFields = await redis.hgetall(keys.hash.fileOwnership);
  const items: ActiveOwnershipItem[] = [];
  for (const [path, raw] of Object.entries(allFields)) {
    try {
      const rec = JSON.parse(raw) as {
        agent_id: string;
        task_id: string;
        priority: number;
        declared_at: number;
        expires_at: number;
        base_commit_sha: string;
      };
      // 只返回未过期的
      if (rec.expires_at > now) {
        items.push({ path, ...rec });
      }
    } catch {
      // 损坏的 JSON 跳过
    }
  }
  // 按 priority 降序（高优先级在前，便于 PM 识别抢占关系）
  items.sort((a, b) => b.priority - a.priority);
  return { ok: true, data: { ownership: items, total: items.length } };
}

/** PM 主动轮询的一次性提醒（对应 GET /intake?consumer=）
 *  平台保持被动：只把"现在有哪些事项需要 PM 注视"汇总成最小门铃，PM 用 task/plan/review
 *  接口自行读取详情。默认只输出事件类型/Plan ID/Task ID/游标/数量，不展开结果/日志/verify/ownership。
 *
 *  事项来源：
 *   - review_requested / acceptance_ready：从事件流按 consumer 路由取未 ack；其中
 *     review_requested 在 ack 后仍由 review pending 状态索引保留最小待办，不能把 ack 当验收
 *   - unresolved legacy failed / Question / unknown blocked：当前确实需要 PM 决策的任务
 *   - stale_agent：心跳超过阈值的执行者（误判为在线）
 *  过滤：consumer / project_path / plan_id；consumer 决定只提醒对应 PM。
 *  游标：返回事件流当前最大 stream id，供客户端断点续读。
 */
export interface IntakeItem {
  kind: 'review_requested' | 'acceptance_ready' | 'question_asked' | 'resolution_required' | 'failed' | 'blocked' | 'stale_agent';
  /** 稳定去重键（event_id 或 task_id），供客户端 ack/去重用 */
  event_id?: string;
  task_id?: string;
  agent_id?: string;
  plan_id?: string;
  project_path?: string;
  /** Question 最小门铃所需的定位符；不含正文、checkpoint 或回答。 */
  question_id?: string;
  timestamp?: number;
}

export async function pmIntake(
  redis: Redis,
  opts: { consumer?: string; project_path?: string; plan_id?: string } = {},
): Promise<
  ApiResponse<{
    consumer: string;
    cursor: string;
    counts: Record<string, number>;
    items: IntakeItem[];
  }>
> {
  const consumer = opts.consumer && isValidConsumerName(opts.consumer) ? opts.consumer : DEFAULT_PM_CONSUMER;
  const now = Date.now();

  // 1. 事件流未 ack 事项（review_requested / acceptance_ready / Question / PM 决策）
  const unacked = await unackedEvents(redis, { consumer });
  const counts: Record<string, number> = {};
  const items: IntakeItem[] = [];
  const seen = new Set<string>();
  const reviewTasksAlreadyBell = new Set<string>();

  const planOf = async (taskId: string): Promise<{ plan_id: string; project_path: string; type: string }> => {
    const h = await redis.hgetall(keys.hash.task(taskId));
    return { plan_id: h.plan_id ?? '', project_path: h.project_path ?? '', type: h.type ?? '' };
  };

  for (const ev of unacked.data ?? []) {
    const meta = ev.task_id ? await planOf(ev.task_id) : { plan_id: ev.plan_id ?? '', project_path: '', type: '' };
    // 过滤
    if (opts.plan_id && meta.plan_id !== opts.plan_id) continue;
    if (opts.project_path && meta.project_path !== opts.project_path) continue;
    // 防御性二次判断：即使某个旧 consumer pending 索引尚未清理，也绝不把“repair
    // 已排队”当作 PM 提醒。真正的 PM 边界只能是 retry 耗尽后的 needs_pm_decision。
    if (ev.type === 'resolution_required' && ev.task_id) {
      const task = await redis.hgetall(keys.hash.task(ev.task_id));
      if (task.resolution_status !== 'needs_pm_decision') continue;
    }
    // review_requested 是门铃而不是不可撤销的事实。任务已被 PM reject/accept
    // 后，即使历史事件还没有 ack，也不应在新的 resolution_required 旁边
    // 再显示一个旧待验收提醒。
    if (ev.type === 'review_requested' && ev.task_id) {
      const task = await redis.hgetall(keys.hash.task(ev.task_id));
      if (!isUnreviewedDoneTask(task)) continue;
    }
    if (ev.type === 'acceptance_ready' && ev.task_id) {
      const task = await redis.hgetall(keys.hash.task(ev.task_id));
      // acceptance_ready 只表示该 attempt 当时可领取。一旦已领取、交付或
      // 失败，历史事件不得继续充当 PM 待办。
      if (task.status !== 'pending') continue;
    }
    // resolution_required 是“根任务仍需 PM 决策”的持续事实，事件和状态兜底必须
    // 用 task_id 合并，避免同一轮同时出现一次门铃和一次 fallback。
    const key = ev.type === 'resolution_required' && ev.task_id
      ? `resolution_required:task:${ev.task_id}`
      : `${ev.type}:${ev.event_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: ev.type as IntakeItem['kind'],
      event_id: ev.event_id,
      task_id: ev.task_id || undefined,
      plan_id: meta.plan_id || ev.plan_id || undefined,
      project_path: meta.project_path || undefined,
      question_id: ev.question_id,
      timestamp: ev.timestamp,
    });
    if (ev.type === 'review_requested' && ev.task_id) reviewTasksAlreadyBell.add(ev.task_id);
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  }

  // 2. done 未验收的持续事实。门铃已 ack 后它仍必须留在统一 intake；复用原 event_id
  // 让已运行的 Supervisor 继续按同一键静音，而不是把同一个 task 当成新提醒重复响铃。
  const pendingReviewIds = await redis.zrange(keys.reviewRequested.pending, 0, -1);
  const staleReview = redis.multi();
  let hasStaleReview = false;
  for (const taskId of pendingReviewIds) {
    const h = await redis.hgetall(keys.hash.task(taskId));
    if (!isUnreviewedDoneTask(h)) {
      staleReview.zrem(keys.reviewRequested.pending, taskId);
      hasStaleReview = true;
      continue;
    }
    const taskConsumer = await resolvePmConsumer(redis, h.plan_id ?? '');
    if (taskConsumer !== consumer) continue;
    if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
    if (opts.project_path && h.project_path !== opts.project_path) continue;
    if (reviewTasksAlreadyBell.has(taskId)) continue;

    const eventId = await redis.hget(keys.reviewRequested.eventByTask, taskId);
    const key = `review_requested:state:${taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      kind: 'review_requested',
      event_id: eventId || undefined,
      task_id: taskId,
      plan_id: h.plan_id || undefined,
      project_path: h.project_path || undefined,
      timestamp: Number(h.done_at ?? 0) || undefined,
    });
    counts.review_requested = (counts.review_requested ?? 0) + 1;
  }
  if (hasStaleReview) {
    const outcomes = await staleReview.exec();
    if (!outcomes || outcomes.some(([error]) => error)) {
      throw new Error('failed to clean stale PM review intake entries');
    }
  }

  // 3. 当前状态兜底。已在 repair 流中的 failed 不需要 PM 介入；只有重试耗尽才
  // 产生 resolution_required。文件/依赖等待由共享 Supervisor/Worker 自行恢复。
  const collectStatusTasks = async (statusKey: string, kind: IntakeItem['kind']) => {
    const ids = await redis.zrange(statusKey, 0, -1);
    for (const tid of ids) {
      let h = await redis.hgetall(keys.hash.task(tid));
      if (!h.task_id) continue;
      let effectiveTaskId = tid;
      let observedAt = Number(h.blocked_at ?? h.done_at ?? 0) || undefined;
      // 终态 repair/reverify child 只是根任务的失败证据，不是第二个
      // PM 待办。根链还在自动进行时完全静默；只在根链耗尽时将它
      // 折叠为唯一的根任务 resolution_required。
      if (kind === 'failed' && h.repair_root_task_id && h.repair_root_task_id !== h.task_id) {
        const root = await redis.hgetall(keys.hash.task(h.repair_root_task_id));
        if (root.task_id && ['repairing', 'required', 'resolved', 'cancelled'].includes(root.resolution_status ?? '')) continue;
        if (root.task_id && root.resolution_status === 'needs_pm_decision') {
          effectiveTaskId = root.task_id;
          h = root;
        }
      }
      // blocked/failed 同样是 PM 门铃，不能越过 plan 的 consumer 边界。
      // 旧 task 没有 plan 或 consumer 时 resolvePmConsumer 会兼容回退到默认 pm。
      const taskConsumer = await resolvePmConsumer(redis, h.plan_id ?? '');
      if (taskConsumer !== consumer) continue;
      if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
      if (opts.project_path && h.project_path !== opts.project_path) continue;
      if (kind === 'failed' && ['repairing', 'required', 'resolved', 'cancelled'].includes(h.resolution_status ?? '')) continue;
      if (kind === 'blocked' && ['waiting_file_release', 'waiting_dependency'].includes(h.block_reason ?? '')) continue;
      // waiting_pm_reply 由 Question 的持久事件/列表处理；若旧数据没有 Question 指针，
      // 才把它作为最小 blocked 门铃保留给 PM，避免无声丢失。
      if (kind === 'blocked' && h.block_reason === 'waiting_pm_reply' && h.blocked_question_id) continue;
      const effectiveKind: IntakeItem['kind'] = kind === 'failed' && h.resolution_status === 'needs_pm_decision'
        ? 'resolution_required'
        : kind;
      const key = effectiveKind === 'resolution_required'
        ? `resolution_required:task:${effectiveTaskId}`
        : `${effectiveKind}:${effectiveTaskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        kind: effectiveKind,
        task_id: effectiveTaskId,
        plan_id: h.plan_id || undefined,
        project_path: h.project_path || undefined,
        timestamp: observedAt,
      });
      counts[effectiveKind] = (counts[effectiveKind] ?? 0) + 1;
    }
  };
  await collectStatusTasks(keys.zset.status.failed, 'failed');
  await collectStatusTasks(keys.zset.status.blocked, 'blocked');

  // 4. stale agent 只有仍持有 running task 时才进入 PM intake。纯 idle/stale
  // 注册是可自行恢复的历史噪声，/status 已能展示，不该每轮催 PM 清理。
  const agentKeys = await scanKeys(redis, `${PREFIX}:hash:agent:*`);
  for (const ak of agentKeys) {
    const h = await redis.hgetall(ak);
    if (!h.agent_id) continue;
    const lastHb = Number(h.last_heartbeat ?? 0);
    if (now - lastHb <= STALE_AGENT_THRESHOLD_MS) continue;
    if (!h.current_task) continue;
    const activeTask = await redis.hgetall(keys.hash.task(h.current_task));
    if (activeTask.status !== 'running') continue;
    const key = `stale_agent:${h.agent_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: 'stale_agent', agent_id: h.agent_id, timestamp: lastHb || undefined });
    counts.stale_agent = (counts.stale_agent ?? 0) + 1;
  }

  // 游标：事件流当前最大 id（客户端下次从此续读；无事件时返回 0-0）
  const lastId = await redis.xrevrange(keys.stream.events, '+', '+', 'COUNT', 1);
  const cursor = Array.isArray(lastId) && lastId.length > 0 ? lastId[0][0] : '0-0';

  return { ok: true, data: { consumer, cursor, counts, items } };
}

/**
 *  发现需要人工动作的 failed / stale_running / stale_agent / blocked_long / done_unreviewed。
 *  autoFix=true 时只处理安全项：stale_running → reset 回 pending、stale_agent → 标记 offline。
 *  正在自动 repair/reverify 的失败以及文件/依赖等待不制造 PM 噪声；只有 retry 耗尽、
 *  Question 或未知阻塞才出现在 PM 的 watchdog 结果中。
 */
export interface WatchdogProblem {
  type: 'failed' | 'partial' | 'stale_running' | 'stale_agent' | 'blocked_long' | 'done_unreviewed';
  task_id?: string;
  agent_id?: string;
  detail: string;
  suggestion: string;
  auto_fixable: boolean;
  fixed?: boolean;
}

export async function runWatchdog(
  redis: Redis,
  opts: { autoFix?: boolean } = {},
): Promise<
  ApiResponse<{
    problems: WatchdogProblem[];
    summary: { total_problems: number; auto_fixable: number; fixed: number; healthy: boolean };
  }>
> {
  if (opts.autoFix) return withMutationPermit(redis, () => runWatchdogUnlocked(redis, opts));
  return runWatchdogUnlocked(redis, opts);
}

async function runWatchdogUnlocked(
  redis: Redis,
  opts: { autoFix?: boolean } = {},
): Promise<
  ApiResponse<{
    problems: WatchdogProblem[];
    summary: { total_problems: number; auto_fixable: number; fixed: number; healthy: boolean };
  }>
> {
  const problems: WatchdogProblem[] = [];
  const now = Date.now();

  // 正常新任务会在 report/review 时即时进入 repair。这里仅补偿升级前或异常写入
  // 遗留的终态；显式 --auto-fix 才会产生状态写入，普通巡检保持只读、低成本。
  if (opts.autoFix) await reconcileResolutionBacklogUnlocked(redis);

  // 1. failed tasks（含被 report partial 的——partial 走 failed 分支落库）。
  // repair/reverify 已有明确 Worker 闭环，watchdog 不重复要求 PM reset；retry 耗尽
  // 才留下 needs_pm_decision 这一项给 PM/平台 intake。
  const failedIds = await redis.zrange(keys.zset.status.failed, 0, -1);
  const reportedResolutionRoots = new Set<string>();
  for (const tid of failedIds) {
    let h = await redis.hgetall(keys.hash.task(tid));
    if (!h.task_id || h.status === 'cancelled') continue;
    let effectiveTaskId = tid;
    let evidence = h;
    if (h.repair_root_task_id && h.repair_root_task_id !== h.task_id) {
      const root = await redis.hgetall(keys.hash.task(h.repair_root_task_id));
      if (root.task_id && ['repairing', 'required', 'resolved', 'cancelled'].includes(root.resolution_status ?? '')) continue;
      if (root.task_id && root.resolution_status === 'needs_pm_decision') {
        effectiveTaskId = root.task_id;
        evidence = h;
        h = root;
      }
    }
    if (['repairing', 'required', 'resolved', 'cancelled'].includes(h.resolution_status ?? '')) continue;
    if (reportedResolutionRoots.has(effectiveTaskId)) continue;
    reportedResolutionRoots.add(effectiveTaskId);
    const needsDecision = h.resolution_status === 'needs_pm_decision';
    problems.push({
      type: 'failed',
      task_id: effectiveTaskId,
      detail: needsDecision
        ? `自动修复已达到上限，等待 PM 决策（${evidence.failed_reason || h.failed_reason || h.pm_reject_reason || '请查看任务证据'}）`
        : `遗留 failed task（${h.failed_reason || `retries=${h.retries ?? 0}，last by ${h.claimed_by || '?'}` }）`,
      suggestion: needsDecision
        ? `biao task get ${effectiveTaskId}（检查 lineage 后选择 continue 或 cancel）`
        : `biao task get ${effectiveTaskId}（核对失败证据后 reset 或 cancel；新失败会自动生成 repair）`,
      auto_fixable: false,
    });
  }

  // 2. stale running（status=running 但 lease 已失效：worker 崩了/退了，lazyReclaim 要等下次 claim 才触发）
  const runningIds = await redis.zrange(keys.zset.status.running, 0, -1);
  for (const tid of runningIds) {
    const leaseAlive = await redis.get(keys.string.lease(tid));
    if (leaseAlive !== null) continue;
    const h = await redis.hgetall(keys.hash.task(tid));
    const p: WatchdogProblem = {
      type: 'stale_running',
      task_id: tid,
      detail: `running 但 lease 已失效，worker ${h.claimed_by || '?'} 可能已退出`,
      suggestion: `biao task reset ${tid}（重置回 pending）`,
      auto_fixable: true,
    };
    if (opts.autoFix) {
      const r = await taskReset(redis, tid, { reset_by: 'watchdog' });
      p.fixed = r.ok;
    }
    problems.push(p);
  }

  // 3. stale agents（last_heartbeat 超过 5 分钟）
  const agentKeys = await scanKeys(redis, `${PREFIX}:hash:agent:*`);
  for (const ak of agentKeys) {
    const h = await redis.hgetall(ak);
    if (!h.agent_id) continue;
    if (h.status === 'offline') continue;
    const lastHb = Number(h.last_heartbeat ?? 0);
    if (now - lastHb > 5 * 60_000) {
      const p: WatchdogProblem = {
        type: 'stale_agent',
        agent_id: h.agent_id,
        detail: `心跳超过 5 分钟未更新（current_task=${h.current_task || '无'}）`,
        suggestion: '确认 worker 进程是否还在；不在则其 running 任务会被 stale_running 项回收',
        auto_fixable: true,
      };
      if (opts.autoFix) {
        await redis.hset(ak, 'status', 'offline');
        p.fixed = true;
      }
      problems.push(p);
    }
  }

  // 4+5. 遍历 task hash：blocked 超 30 分钟 / done 未验收
  const taskKeys = await scanKeys(redis, `${PREFIX}:hash:task:*`);
  for (const tk of taskKeys) {
    const h = await redis.hgetall(tk);
    if (!h.task_id) continue;
    if (h.status === 'blocked' && now - Number(h.blocked_at ?? h.claimed_at ?? 0) > 30 * 60_000) {
      // 文件占用和依赖等待只由 Worker/共享 Supervisor 的状态变化唤醒；它们不是 PM
      // 待办。避免 watchdog 又把低噪声设计反向变成“人盯看板”。
      if (['waiting_file_release', 'waiting_dependency'].includes(h.block_reason ?? '')) continue;
      const isQuestion = h.block_reason === 'waiting_pm_reply';
      problems.push({
        type: 'blocked_long',
        task_id: h.task_id,
        detail: isQuestion
          ? 'blocked 超过 30 分钟，仍有待 PM 答复的 Question'
          : `blocked 超过 30 分钟，原因=${h.block_reason || 'unknown'}`,
        suggestion: isQuestion ? 'biao question list --status open（读取并答复对应 Question）' : `biao task get ${h.task_id}（检查阻塞原因）`,
        auto_fixable: false,
      });
    }
    // repair source 处于 required 时，真正待验收的是 repair 自己；不要让旧 source
    // 的 done 状态再次把 PM 引向一个服务端已经拒绝 accept 的入口。
    if (h.status === 'done' && !h.pm_review_status && !h.resolution_status) {
      problems.push({
        type: 'done_unreviewed',
        task_id: h.task_id,
        detail: `done 但未验收${h.claimed_by ? `（by ${h.claimed_by}）` : ''}`,
        suggestion: `biao review ${h.task_id}（accept 或 reject）`,
        auto_fixable: false, // PM 必须看产出，不自动
      });
    }
  }

  const autoFixable = problems.filter((p) => p.auto_fixable).length;
  const fixed = problems.filter((p) => p.fixed).length;
  return {
    ok: true,
    data: {
      problems,
      summary: { total_problems: problems.length, auto_fixable: autoFixable, fixed, healthy: problems.length === 0 },
    },
  };
}

/** SCAN keys（避免 KEYS 阻塞） */
const PREFIX = 'biao:v1';
async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/** 获取 git HEAD sha（对应 P2 防漂移） */
async function getGitHeadSha(projectPath: string): Promise<string> {
  const { execSync } = await import('node:child_process');
  try {
    return execSync('git rev-parse HEAD', {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
