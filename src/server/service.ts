/**
 * Biao 核心服务：claim/report/plan submit 的业务逻辑
 * 对应 docs/biao/05-biao-service-spec.md, 06-dispatch-protocol.md
 */

import type Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keys, pendingScore, runningScore, DEFAULT_PM_CONSUMER, isValidConsumerName } from '../redis/keys.js';
import { SqliteStore, type TaskRow, type PlanRow, type AgentRegistrationRow } from '../db/sqlite-store.js';
import type {
  QuestionCreateRequest,
  QuestionAnswerRequest,
  QuestionRecord,
  QuestionSummary,
  QuestionStatus,
  OwnershipScope,
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

/**
 * 修改 task hash 时同时维护所有长期轮询索引。
 *
 * `persistTaskFromRedis` 是 Redis -> SQLite 的耐久副本同步，不能承担 Redis 内部
 * 投影正确性：进程可能在 HSET 成功后、调用 persist 前退出。这个 Lua 把 task 真相、
 * plan/task 注册、revision/dirty 以及当前 failed intake 候选放在同一个 Redis 原子
 * 边界。网络在 EVAL 返回时中断也只会形成“结果未知”，不会形成“真相已写但 dirty 未写”。
 */
const MUTATE_TASK_WITH_PLAN_PROJECTION = `
-- mutate-task-with-plan-projection-v1
local task_id = ARGV[1]
local expected_plan_id = ARGV[2]
local mode = ARGV[3]
local now = ARGV[4]
local existing_task_id = redis.call('HGET', KEYS[1], 'task_id')

if mode == 'create' then
  if existing_task_id then return {'TASK_EXISTS'} end
elseif not existing_task_id then
  return {'TASK_NOT_FOUND'}
end

local actual_plan_id = redis.call('HGET', KEYS[1], 'plan_id') or expected_plan_id
if actual_plan_id ~= expected_plan_id then return {'PLAN_CHANGED', actual_plan_id} end

for index = 5, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
end

-- create 必须把 identity 一并写入；update 则再次验证 mutation 没有改写 identity。
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= expected_plan_id then
  return {'IDENTITY_INVALID'}
end

redis.call('SADD', KEYS[2], expected_plan_id)
redis.call('SADD', KEYS[3], task_id)
redis.call('HINCRBY', KEYS[4], expected_plan_id, 1)
redis.call('SADD', KEYS[5], expected_plan_id)

local status = redis.call('HGET', KEYS[1], 'status') or ''
local resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''
local actionable = resolution == 'needs_pm_decision' or
  (status == 'failed' and resolution ~= 'repairing' and resolution ~= 'required' and
   resolution ~= 'resolved' and resolution ~= 'cancelled')
if actionable then
  local score = tonumber(redis.call('HGET', KEYS[1], 'done_at') or '') or tonumber(now)
  redis.call('ZADD', KEYS[6], score, task_id)
else
  redis.call('ZREM', KEYS[6], task_id)
end
return {mode == 'create' and 'CREATED' or 'UPDATED'}
`;

async function mutateTaskWithPlanProjection(
  redis: Redis,
  taskId: string,
  planId: string,
  fields: Record<string, string | number>,
  mode: 'create' | 'update' = 'update',
): Promise<'CREATED' | 'UPDATED' | 'TASK_EXISTS'> {
  if ((fields.task_id !== undefined && String(fields.task_id) !== taskId) ||
      (fields.plan_id !== undefined && String(fields.plan_id) !== planId)) {
    throw new Error(`task/projection mutation cannot change identity task=${taskId} plan=${planId}`);
  }
  const flatFields = Object.entries(fields).flatMap(([field, value]) => [field, String(value)]);
  const raw = (await redis.eval(
    MUTATE_TASK_WITH_PLAN_PROJECTION,
    6,
    keys.hash.task(taskId),
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(planId),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    taskId,
    planId,
    mode,
    String(Date.now()),
    ...flatFields,
  )) as string[];
  const outcome = String(raw?.[0] ?? 'UNKNOWN');
  if (outcome === 'TASK_EXISTS' && mode === 'create') return 'TASK_EXISTS';
  if (outcome !== 'UPDATED' && outcome !== 'CREATED') {
    throw new Error(`task/projection atomic mutation failed task=${taskId} outcome=${outcome}`);
  }
  return outcome;
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
  // Redis 内 task 真相与 plan/intake 投影必须已由各 mutation 的同一 Lua/MULTI 提交。
  // 本函数只负责跨引擎的 SQLite 耐久副本；把 Redis dirty 放在这里会重新引入
  // “真相已写、进程在 persist 前退出”的永久旧 aggregate 窗口。
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
    pm_accept_effects_applied: h.pm_accept_effects_applied ?? '',
    pm_reject_reason: h.pm_reject_reason ?? '',
    pm_fix_instructions: h.pm_fix_instructions ?? '',
    pm_rejection_resolution_mode: h.pm_rejection_resolution_mode ?? '',
    repair_ownership_extension: h.repair_ownership_extension ?? '',
    pm_repair_ownership_required: h.pm_repair_ownership_required ?? '',
    pm_repair_ownership_intent: h.pm_repair_ownership_intent ?? '',
    failure_reason: h.failed_reason ?? '',
    fix_for: h.fix_for ?? '',
    repair_root_task_id: h.repair_root_task_id ?? '',
    trigger_review_task_id: h.trigger_review_task_id ?? '',
    resolution_status: h.resolution_status ?? '',
    resolution_action: h.resolution_action ?? '',
    resolution_task_id: h.resolution_task_id ?? '',
    resolution_task_ids: h.resolution_task_ids ?? '',
    acceptance_repair_task_ids: h.acceptance_repair_task_ids ?? '',
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
    cancel_reason: h.cancel_reason ?? '',
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
  file_sizes: { main_bytes: number; wal_bytes: number };
  restore_projection: {
    restorable_tasks: number;
    restorable_plans: number;
    excluded: ReturnType<SqliteStore['getRestoreExclusionSummary']>;
  };
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
      file_sizes: sqliteStore.getFileSizes(),
      restore_projection: {
        restorable_tasks: sqliteStore.getRestorableTasks().length,
        restorable_plans: sqliteStore.getRestorablePlans().length,
        excluded: sqliteStore.getRestoreExclusionSummary(),
      },
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

type MutationSectionResult =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; error: { code: MaintenanceGateErrorCode; message: string } };

/**
 * claim 的阻塞等待不能占用全局 mutation permit；需要跨多个 helper 的候选扫描则
 * 显式打开一个短 mutation section，并在进入 XREAD 前释放。
 */
async function acquireMutationSection(redis: Redis): Promise<MutationSectionResult> {
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
    return permit;
  }
  let released = false;
  return {
    ok: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await releaseMutationPermit(redis, permit.owner);
      } finally {
        leaveLocalMutation();
      }
    },
  };
}

/** 手动触发恢复（对应 biao db restore）—— 仅在 Biao namespace 为空时重建 */
export async function dbRestoreManual(redis: Redis): Promise<ApiResponse<{
  restored: number;
  by_status: Record<string, number>;
  excluded: ReturnType<SqliteStore['getRestoreExclusionSummary']>;
}>> {
  if (!sqliteStore) {
    return { ok: false, data: null, error: { code: 'SQLITE_NOT_ENABLED', message: 'SQLite 持久化未启用' } };
  }
  try {
    const r = await dbRestore(redis, sqliteStore);
    return {
      ok: true,
      data: { restored: r.restored, by_status: r.byStatus, excluded: sqliteStore.getRestoreExclusionSummary() },
    };
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
    keys.planStatusProjection.ready,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.dirtyPlans,
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.agentIds,
    keys.planStatusProjection.agentIdsReady,
    keys.intakeActionableFailed.pending,
    keys.intakeActionableFailed.ready,
    keys.intakeActionableFailed.backfillLock,
  ]);
  for (const plan of projection.plans) {
    material.add(keys.hash.plan(plan.plan_id));
    material.add(keys.planStatusProjection.taskIdsByPlan(plan.plan_id));
    material.add(keys.planStatusProjection.aggregateByPlan(plan.plan_id));
  }
  for (const task of projection.tasks) material.add(keys.hash.task(task.task_id));
  for (const question of projection.questions) {
    material.add(keys.hash.question(question.question_id));
    if ((question.status ?? 'open') === 'open') {
      material.add(keys.question.openByTask(question.task_id));
      material.add(keys.question.openMetaByTask(question.task_id));
    }
  }
  for (const registration of projection.agentRegistrations) {
    material.add(keys.hash.agent(registration.agent_id));
    material.add(agentRegistrationHistoryKey(registration.agent_id));
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
  agentRegistrations: AgentRegistrationRow[];
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
  const tasks = sqlite.getRestorableTasks();
  const plans = sqlite.getRestorablePlans();
  sqlite.recoverRunningTasksForRestore(tasks.map((task) => task.task_id));
  // running 规范化发生在 SQLite 事务中；重新读取恢复集合，避免投影携带旧 running 行。
  const normalizedTasks = sqlite.getRestorableTasks();
  const taskIds = new Set(normalizedTasks.map((task) => task.task_id));
  const questions = sqlite.getAllQuestions().filter((question) => taskIds.has(question.task_id));
  const agentRegistrations = sqlite.getAllAgentRegistrations();

  const invalidStatusTask = normalizedTasks.find((task) => !RESTORABLE_TASK_STATUSES.has(task.status as TaskStatus));
  if (invalidStatusTask) throw invalidRestoredTaskStatus(invalidStatusTask);

  const tasksById = new Map(normalizedTasks.map((task) => [task.task_id, task]));
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
  for (const task of normalizedTasks) {
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
  for (const task of normalizedTasks) {
    if (task.status !== 'pending') continue;
    const plan = plansById.get(task.plan_id);
    const score = pendingScore(restoredPriority(task, plan), restoredPendingTimestamp(task, plan));
    if (!Number.isFinite(score)) throw invalidRestoredTaskScore(task.task_id);
    pendingScoresByTaskId.set(task.task_id, score);
  }

  const byStatus: Record<string, number> = {};
  for (const task of normalizedTasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  return {
    tasks: normalizedTasks,
    plans,
    questions,
    agentRegistrations,
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
  const { tasks, plans, questions, agentRegistrations, plansById, tasksById, pendingScoresByTaskId, byStatus } = projection;
  const taskStatesByPlan = new Map<string, PlanTaskState[]>();
  for (const task of tasks) {
    const states = taskStatesByPlan.get(task.plan_id) ?? [];
    states.push(planTaskStateFromRow(task));
    taskStatesByPlan.set(task.plan_id, states);
  }
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
      transaction.sadd(keys.planStatusProjection.planIds, plan.plan_id);
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
      transaction.hset(
        keys.planStatusProjection.aggregateByPlan(plan.plan_id),
        planStatusProjectionHash(buildPlanStatusProjection(taskStatesByPlan.get(plan.plan_id) ?? [])),
      );
      transaction.hset(keys.planStatusProjection.revisionByPlan, plan.plan_id, '0');
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
        pm_accept_effects_applied: task.pm_accept_effects_applied ?? '',
        pm_reject_reason: task.pm_reject_reason ?? '',
        pm_fix_instructions: task.pm_fix_instructions ?? '',
        pm_rejection_resolution_mode: task.pm_rejection_resolution_mode ?? '',
        repair_ownership_extension: task.repair_ownership_extension ?? '',
        pm_repair_ownership_required: task.pm_repair_ownership_required ?? '',
        pm_repair_ownership_intent: task.pm_repair_ownership_intent ?? '',
        failed_reason: task.failure_reason ?? '',
        fix_for: task.fix_for ?? '',
        repair_root_task_id: task.repair_root_task_id ?? '',
        trigger_review_task_id: task.trigger_review_task_id ?? '',
        resolution_status: task.resolution_status ?? '',
        resolution_action: task.resolution_action ?? '',
        resolution_task_id: task.resolution_task_id ?? '',
        resolution_task_ids: task.resolution_task_ids ?? '',
        acceptance_repair_task_ids: task.acceptance_repair_task_ids ?? '',
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
        cancel_reason: task.cancel_reason ?? '',
        superseded_at: restoredTimestampString(task.superseded_at),
        superseded_by: task.superseded_by ?? '',
        superseded_reason: task.superseded_reason ?? '',
        supersede_preview_token: task.supersede_preview_token ?? '',
        supersede_batch_size: String(task.supersede_batch_size ?? 0),
        verify_results: task.verify_results ?? '[]',
      });
      transaction.sadd(keys.planStatusProjection.taskIdsByPlan(task.plan_id), task.task_id);
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
        requested_ownership: question.requested_ownership ?? '',
        ownership_decision: question.ownership_decision ?? '',
        ownership_before: question.ownership_before ?? '',
        ownership_after: question.ownership_after ?? '',
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

    // 还原所有 retired ID，但只把最高 generation 投影为当前 Agent。
    // restore 不复活进程：当前代次以 offline 完成安全封口，新进程必须新注册。
    const currentAgentRegistrations = new Map<string, AgentRegistrationRow>();
    for (const registration of agentRegistrations) {
      transaction.sadd(agentRegistrationHistoryKey(registration.agent_id), registration.registration_id);
      const current = currentAgentRegistrations.get(registration.agent_id);
      if (!current || registration.generation > current.generation) {
        currentAgentRegistrations.set(registration.agent_id, registration);
      }
    }
    for (const registration of currentAgentRegistrations.values()) {
      transaction.sadd(keys.planStatusProjection.agentIds, registration.agent_id);
      transaction.hset(keys.hash.agent(registration.agent_id), {
        agent_id: registration.agent_id,
        agent_type: registration.agent_type ?? '',
        capabilities: registration.capabilities ?? '',
        endpoint: registration.endpoint ?? '',
        projects: registration.projects ?? '',
        registration_id: registration.registration_id,
        registration_generation: String(registration.generation),
        registration_source: registration.registration_source,
        registered_at: registration.registered_at ?? '',
        last_heartbeat: registration.registered_at ?? '',
        status: 'offline',
        current_task: '',
        offline_at: String(now),
        offline_reason: 'restore',
        claim_request_id: '',
        claim_request_task_id: '',
        claim_request_token: '',
        claim_request_payload: '',
      });
    }

    // ready 与 task/plan/aggregate 在同一个恢复发布事务中可见；成功恢复后的第一轮
    // `/status` 不需要、也不允许再把完整 SQLite 历史从 Redis 扫一遍。
    transaction.set(keys.planStatusProjection.ready, PLAN_STATUS_PROJECTION_VERSION);
    // Agent epoch 会恢复为 offline 审计/fencing 投影，不复活任何进程。
    transaction.set(keys.planStatusProjection.agentIdsReady, PLAN_STATUS_PROJECTION_VERSION);
    // restore 已遍历全部 SQLite failed。把当前 actionable failed 与 ready 一起发布，
    // 首轮 intake 不再回扫恢复后的 failed 历史。
    for (const task of tasks) {
      const resolutionStatus = task.resolution_status ?? '';
      const actionable = resolutionStatus === 'needs_pm_decision' ||
        (task.status === 'failed' && !['repairing', 'required', 'resolved', 'cancelled'].includes(resolutionStatus));
      if (!actionable) continue;
      transaction.zadd(
        keys.intakeActionableFailed.pending,
        parsePersistedTimestamp(task.done_at) ?? now,
        task.task_id,
      );
    }
    transaction.set(keys.intakeActionableFailed.ready, '1');

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
  globMatch,
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

    // writeTaskToRedis / writePlanToRedis 各自把真相与 plan registry/revision/dirty 放在
    // 同一 MULTI。这里不能再依赖一个循环结束后的“事后标脏”调用：进程可能在任意
    // 一个 task 已发布后退出，而已发布的 task 必须立即可被投影增量重建。
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
          pm_accept_effects_applied: existing?.pm_accept_effects_applied ?? '',
          pm_reject_reason: existing?.pm_reject_reason ?? '',
          pm_fix_instructions: existing?.pm_fix_instructions ?? '',
          pm_rejection_resolution_mode: existing?.pm_rejection_resolution_mode ?? '',
          repair_ownership_extension: existing?.repair_ownership_extension ?? '',
          pm_repair_ownership_required: existing?.pm_repair_ownership_required ?? '',
          pm_repair_ownership_intent: existing?.pm_repair_ownership_intent ?? '',
          fix_for: existing?.fix_for ?? '',
          repair_root_task_id: existing?.repair_root_task_id ?? '',
          trigger_review_task_id: existing?.trigger_review_task_id ?? '',
          resolution_status: existing?.resolution_status ?? '',
          resolution_action: existing?.resolution_action ?? '',
          resolution_task_id: existing?.resolution_task_id ?? '',
          resolution_task_ids: existing?.resolution_task_ids ?? '',
          acceptance_repair_task_ids: existing?.acceptance_repair_task_ids ?? '',
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
          cancel_reason: existing?.cancel_reason ?? '',
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

const AGENT_REGISTRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

function generatedAgentRegistrationId(): string {
  return `reg_${randomUUID().replaceAll('-', '')}`;
}

function agentRegistrationHistoryKey(agentId: string): string {
  // 不放在 hash:agent:* 命名空间，避免旧版 SCAN/HGETALL 把 SET 误当 hash。
  return `biao:v1:set:agent_registration_ids:${encodeURIComponent(agentId)}`;
}

// 单实例内把“SQLite generation 分配 -> Redis 发布”与生命周期最终授权串行化。
// 跨进程部署仍需外部单写者；默认 Biao 运行模式只有一个 server 进程。
const agentEpochCommitTails = new Map<string, Promise<void>>();

async function withAgentEpochCommit<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const previous = agentEpochCommitTails.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  agentEpochCommitTails.set(agentId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (agentEpochCommitTails.get(agentId) === tail) agentEpochCommitTails.delete(agentId);
  }
}

function durableAgentEpochIsCurrent(agentId: string, registrationId: string): boolean {
  const durableCurrent = sqliteStore?.getCurrentAgentRegistration(agentId);
  // 空表兼容升级前仅存在于 Redis 的 server-generated epoch；一旦 SQLite 有该
  // agent 的真相，任何不同 ID 都必须 fail closed，不能等 Redis 发布成功才 fencing。
  return !durableCurrent || durableCurrent.registration_id === registrationId;
}

const REGISTER_AGENT_EPOCH = `
local current_registration = redis.call('HGET', KEYS[1], 'registration_id') or ''
local requested_registration = ARGV[6]
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'registration_generation') or '0') or 0
local requested_generation = tonumber(ARGV[10]) or 0
if requested_generation <= 0 then requested_generation = current_generation + 1 end

-- SQLite 已经序列化分配 generation。Redis 提交即使反序，低代次也不能覆盖高代次。
if current_generation > requested_generation then
  return {'RETIRED', current_registration, tostring(current_generation)}
end

if current_registration == requested_registration then
  -- 同一注册请求的传输重试只刷新非生命周期元数据；绝不清空已领任务、
  -- 不复活已离线 epoch，也不改写 registered_at。
  redis.call('HSET', KEYS[1],
    'agent_id', ARGV[1],
    'agent_type', ARGV[2],
    'capabilities', ARGV[3],
    'endpoint', ARGV[4],
    'projects', ARGV[5],
    'registration_generation', tostring(requested_generation))
  redis.call('HDEL', KEYS[1], 'claim_request_payload')
  redis.call('SADD', KEYS[2], requested_registration)
  redis.call('SADD', KEYS[3], ARGV[1])
  redis.call('SET', KEYS[4], ARGV[8])
  return {'IDEMPOTENT', redis.call('HGET', KEYS[1], 'registered_at') or ARGV[7], tostring(requested_generation)}
end

if current_generation == requested_generation and current_registration ~= '' then
  return {'RETIRED', current_registration, tostring(current_generation)}
end

-- 一个 ID 曾经成为过该 agent 的 epoch，一旦被新 epoch 取代就永久退役。
-- 这会拦住“旧 register 响应丢失 -> 延迟重试 -> 夺回新会话”。
if redis.call('SISMEMBER', KEYS[2], requested_registration) == 1 then
  return {'RETIRED', current_registration}
end

redis.call('SADD', KEYS[2], requested_registration)
redis.call('HSET', KEYS[1],
  'agent_id', ARGV[1],
  'agent_type', ARGV[2],
  'capabilities', ARGV[3],
  'endpoint', ARGV[4],
  'projects', ARGV[5],
  'registration_id', requested_registration,
  'registration_generation', tostring(requested_generation),
  'registration_source', ARGV[9],
  'registered_at', ARGV[7],
  'last_heartbeat', ARGV[7],
  'status', 'idle',
  'current_task', '',
  'claim_request_id', '',
  'claim_request_task_id', '',
  'claim_request_token', '',
  'offline_at', '',
  'offline_reason', '')
redis.call('HDEL', KEYS[1], 'claim_request_payload')
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('SET', KEYS[4], ARGV[8])
return {'CREATED', ARGV[7], tostring(requested_generation)}
`;

/** agent register */
async function agentRegisterUnlocked(
  redis: Redis,
  agentId: string,
  agentType: string,
  capabilities: string[],
  endpoint?: string,
  projects?: string[],
  registrationId?: string,
): Promise<ApiResponse<{ agent_id: string; registration_id: string; registration_generation: number; registered_at: number }>> {
  const requestedRegistrationId = registrationId ?? generatedAgentRegistrationId();
  if (!AGENT_REGISTRATION_ID_PATTERN.test(requestedRegistrationId)) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'INVALID_REGISTRATION_ID',
        message: 'registration_id 必须是 16~128 位安全标识符',
      },
    };
  }
  const now = Date.now();
  let durableGeneration = 0;
  if (sqliteStore) {
    // 旧版只在 Redis 保存 epoch。首次新版 register 先收编该历史，
    // 避免升级窗口内的旧请求因 SQLite 空表被当作新代次。
    const [redisCurrent, redisHistory] = await Promise.all([
      redis.hgetall(keys.hash.agent(agentId)),
      redis.smembers(agentRegistrationHistoryKey(agentId)),
    ]);
    sqliteStore.seedAgentRegistrationHistory(
      agentId,
      redisHistory,
      redisCurrent.registration_id ? {
        agent_id: agentId,
        registration_id: redisCurrent.registration_id,
        registration_source: redisCurrent.registration_source === 'server' ? 'server' : 'client',
        agent_type: redisCurrent.agent_type ?? '',
        capabilities: redisCurrent.capabilities ?? '',
        endpoint: redisCurrent.endpoint ?? '',
        projects: redisCurrent.projects ?? '',
        registered_at: redisCurrent.registered_at ?? String(now),
      } : undefined,
    );
    const decision = sqliteStore.registerAgentEpoch({
      agent_id: agentId,
      registration_id: requestedRegistrationId,
      registration_source: registrationId ? 'client' : 'server',
      agent_type: agentType,
      capabilities: capabilities.join(','),
      endpoint: endpoint ?? '',
      projects: (projects ?? []).join(','),
      registered_at: String(now),
    });
    if (decision.outcome === 'retired') {
      return {
        ok: false,
        data: null,
        error: {
          code: 'AGENT_REGISTRATION_RETIRED',
          message: `Agent ${agentId} 的该 registration_id 已被新会话取代，不能重新激活。`,
        },
      };
    }
    durableGeneration = decision.current.generation;
  }
  const raw = await redis.eval(
    REGISTER_AGENT_EPOCH,
    4,
    keys.hash.agent(agentId),
    agentRegistrationHistoryKey(agentId),
    keys.planStatusProjection.agentIds,
    keys.planStatusProjection.agentIdsReady,
    agentId,
    agentType,
    capabilities.join(','),
    endpoint ?? '',
    (projects ?? []).join(','),
    requestedRegistrationId,
    String(now),
    PLAN_STATUS_PROJECTION_VERSION,
    registrationId ? 'client' : 'server',
    String(durableGeneration),
  );
  if (!Array.isArray(raw)) throw new Error(`failed to register agent ${agentId}`);
  const outcome = String(raw[0] ?? '');
  if (outcome === 'RETIRED') {
    return {
      ok: false,
      data: null,
      error: {
        code: 'AGENT_REGISTRATION_RETIRED',
        message: `Agent ${agentId} 的该 registration_id 已被新会话取代，不能重新激活。`,
      },
    };
  }
  if (outcome !== 'CREATED' && outcome !== 'IDEMPOTENT') {
    throw new Error(`failed to register agent ${agentId}: ${outcome || 'UNKNOWN'}`);
  }
  return {
    ok: true,
    data: {
      agent_id: agentId,
      registration_id: requestedRegistrationId,
      registration_generation: Number(raw[2] ?? durableGeneration),
      registered_at: Number(raw[1] ?? now),
    },
  };
}

export async function agentRegister(
  redis: Redis,
  agentId: string,
  agentType: string,
  capabilities: string[],
  endpoint?: string,
  projects?: string[],
  registrationId?: string,
): Promise<ApiResponse<{ agent_id: string; registration_id: string; registration_generation: number; registered_at: number }>> {
  return withAgentEpochCommit(agentId, () => agentRegisterUnlocked(
    redis, agentId, agentType, capabilities, endpoint, projects, registrationId,
  ));
}

/** heartbeat */
async function agentHeartbeatUnlocked(
  redis: Redis,
  agentId: string,
  registrationId: string | undefined,
  currentTask?: string,
): Promise<ApiResponse<unknown>> {
  // 仅兼容仓库内通过 server-generated epoch 的直接 service 调用；HTTP schema
  // 与显式 client epoch 仍必须携带，不存在网络边界降级。
  let effectiveRegistrationId = registrationId;
  if (!effectiveRegistrationId) {
    const current = await redis.hgetall(keys.hash.agent(agentId));
    if (current.registration_source === 'server') effectiveRegistrationId = current.registration_id;
  }
  if (!effectiveRegistrationId) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_REGISTRATION_REQUIRED', message: 'heartbeat 必须携带 register 返回的 registration_id' },
    };
  }
  if (!AGENT_REGISTRATION_ID_PATTERN.test(effectiveRegistrationId)) {
    return { ok: false, data: null, error: { code: 'INVALID_REGISTRATION_ID', message: 'registration_id 格式无效' } };
  }
  if (!durableAgentEpochIsCurrent(agentId, effectiveRegistrationId)) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_REGISTRATION_CHANGED', message: `Agent ${agentId} 已换用新会话；旧生命周期不能写心跳。` },
    };
  }
  const now = Date.now();
  const outcome = Number(await redis.eval(
    `if (redis.call('HGET', KEYS[1], 'agent_id') or '') == '' then return 0 end
     if (redis.call('HGET', KEYS[1], 'registration_id') or '') ~= ARGV[1] then return -1 end
     if (redis.call('HGET', KEYS[1], 'status') or '') == 'offline' then return -2 end
     redis.call('HSET', KEYS[1],
       'last_heartbeat', ARGV[2],
       'current_task', ARGV[3],
       'status', ARGV[4])
     return 1`,
    1,
    keys.hash.agent(agentId),
    effectiveRegistrationId,
    String(now),
    currentTask ?? '',
    currentTask ? 'busy' : 'idle',
  ));
  if (outcome === 0) {
    return { ok: false, data: null, error: { code: 'AGENT_NOT_REGISTERED', message: `Agent ${agentId} 尚未注册` } };
  }
  if (outcome === -1) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_REGISTRATION_CHANGED', message: `Agent ${agentId} 已换用新会话；旧生命周期不能写心跳。` },
    };
  }
  if (outcome === -2) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_ALREADY_OFFLINE', message: `Agent ${agentId} 的当前会话已离线，请用新 registration_id 重新注册。` },
    };
  }
  if (outcome !== 1) throw new Error(`failed to heartbeat agent ${agentId}: ${outcome}`);
  return { ok: true, data: { agent_id: agentId, ts: now } };
}

export async function agentHeartbeat(
  redis: Redis,
  agentId: string,
  registrationId: string | undefined,
  currentTask?: string,
): Promise<ApiResponse<unknown>> {
  return withAgentEpochCommit(agentId, () => agentHeartbeatUnlocked(redis, agentId, registrationId, currentTask));
}

/**
 * Agent 生命周期显式收口。保留注册/心跳与最后任务作审计，只清除“当前在线占用”投影。
 * 重复退出幂等；未注册 agent 也返回成功，避免终态 Supervisor 为从未启动的 slot
 * 反向创建一条伪审计记录。
 */
async function agentOfflineUnlocked(
  redis: Redis,
  agentId: string,
  reason: 'worker_exit' | 'worker_signal' | 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit',
  registrationId?: string,
): Promise<ApiResponse<{ agent_id: string; offline: boolean }>> {
  let effectiveRegistrationId = registrationId;
  if (!effectiveRegistrationId) {
    const current = await redis.hgetall(keys.hash.agent(agentId));
    if (current.registration_source === 'server') effectiveRegistrationId = current.registration_id;
  }
  if (!effectiveRegistrationId) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_REGISTRATION_REQUIRED', message: 'offline 必须携带 register 返回的 registration_id' },
    };
  }
  if (!AGENT_REGISTRATION_ID_PATTERN.test(effectiveRegistrationId)) {
    return { ok: false, data: null, error: { code: 'INVALID_REGISTRATION_ID', message: 'registration_id 格式无效' } };
  }
  if (!durableAgentEpochIsCurrent(agentId, effectiveRegistrationId)) {
    return {
      ok: false,
      data: null,
      error: { code: 'AGENT_REGISTRATION_CHANGED', message: `Agent ${agentId} 已重新注册；旧生命周期不能把新会话标记离线。` },
    };
  }
  const key = keys.hash.agent(agentId);
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await redis.hgetall(key);
    if (!current.agent_id) return { ok: true, data: { agent_id: agentId, offline: false } };
    const currentTask = current.current_task ?? '';
    const taskKey = keys.hash.task(currentTask || '__none__');
    // Supervisor 的 abort 只能停止调度，不能假定已发起的 Agent 执行立刻结束。
    // 在同一 Lua 中复核 task 真实状态：仍为 running 时保留 current_task，使 /status
    // 与 watchdog 能看见这个需要 lease 回收的执行；只有已终止时才清空当前指针。
    const outcome = Number(await redis.eval(
    `if (redis.call('HGET', KEYS[1], 'agent_id') or '') == '' then return 0 end
     if (redis.call('HGET', KEYS[1], 'registration_id') or '') ~= ARGV[1] then return -1 end
     if (redis.call('HGET', KEYS[1], 'status') or '') == 'offline' then return 3 end
     local actual_task = redis.call('HGET', KEYS[1], 'current_task') or ''
     if actual_task ~= ARGV[2] and actual_task ~= '' then return -2 end
     local preserve_running = actual_task ~= '' and
       (redis.call('HGET', KEYS[2], 'status') or '') == 'running'
     if actual_task ~= '' then
       redis.call('HSET', KEYS[1], 'last_task', actual_task)
     end
     if preserve_running then
       redis.call('HSET', KEYS[1],
         'status', 'offline',
         'offline_at', ARGV[3],
         'offline_reason', ARGV[4])
       return 2
     end
     redis.call('HSET', KEYS[1],
       'status', 'offline',
       'current_task', '',
       'offline_at', ARGV[3],
       'offline_reason', ARGV[4])
     return 1`,
    2,
    key,
    taskKey,
    effectiveRegistrationId,
    currentTask,
    String(now),
    reason,
    ));
    if (outcome === 1 || outcome === 2 || outcome === 3) {
      return { ok: true, data: { agent_id: agentId, offline: true } };
    }
    if (outcome === 0) return { ok: true, data: { agent_id: agentId, offline: false } };
    if (outcome === -1) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'AGENT_REGISTRATION_CHANGED',
          message: `Agent ${agentId} 已重新注册；旧生命周期不能把新会话标记离线。`,
        },
      };
    }
    // current_task 在读取与 Lua 提交之间改变时，使用新真相有限重试；不能谎报成功。
  }
  return {
    ok: false,
    data: null,
    error: {
      code: 'AGENT_CURRENT_TASK_CHANGED',
      message: `Agent ${agentId} 的 current_task 持续变化，未能原子标记离线。`,
    },
  };
}

export async function agentOffline(
  redis: Redis,
  agentId: string,
  reason: 'worker_exit' | 'worker_signal' | 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit',
  registrationId?: string,
): Promise<ApiResponse<{ agent_id: string; offline: boolean }>> {
  return withAgentEpochCommit(agentId, () => agentOfflineUnlocked(redis, agentId, reason, registrationId));
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
      if (kind === 'files' && (
        value.startsWith('/') || value.startsWith('~') || value.includes('\\') || /^[A-Za-z]:/.test(value) ||
        value.split('/').some((segment) => segment === '.' || segment === '..')
      )) {
        return { error: 'repair_ownership.files 必须是项目内 POSIX 相对路径或 glob，不能越过项目边界。' };
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

function serializedRepairOwnership(value: NormalizedRepairOwnership): string {
  return JSON.stringify({ files: value.files, modules: value.modules });
}

/**
 * reject 与 repair child 之间存在进程崩溃窗口。显式扩权必须由来源 reject 审计
 * 自己携带，而不能从请求重试、child 或当前 ownership 猜测。required 是独立哨兵：
 * 它让“本来没有扩权”和“声明有扩权但 intent 丢失”可以确定地区分。
 */
function persistedRepairOwnershipIntent(
  auditTask: Record<string, string>,
  ownershipSource: Record<string, string>,
  root: Record<string, string>,
): { value?: NormalizedRepairOwnership; error?: string } {
  const required = auditTask.pm_repair_ownership_required ?? '';
  const raw = auditTask.pm_repair_ownership_intent ?? '';
  if (!required && !raw) return {};
  if (required !== 'true') {
    return { error: `repair_ownership_intent_marker_invalid:${auditTask.task_id}` };
  }
  if (!raw) return { error: `repair_ownership_intent_missing:${auditTask.task_id}` };
  if (!ownershipSource.task_id || !root.task_id) {
    return { error: `repair_ownership_intent_source_missing:${auditTask.task_id}` };
  }
  const parsed = parseRepairOwnershipAudit(raw);
  if (!parsed) return { error: `repair_ownership_intent_invalid:${auditTask.task_id}` };
  const delta = repairOwnershipDelta(ownershipSource, root, parsed);
  if (!delta.value || serializedRepairOwnership(delta.value) !== serializedRepairOwnership(parsed)) {
    return { error: `repair_ownership_intent_inconsistent:${auditTask.task_id}` };
  }
  return { value: delta.value };
}

function sameRepairOwnership(
  left: NormalizedRepairOwnership | undefined,
  right: NormalizedRepairOwnership | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return serializedRepairOwnership(left) === serializedRepairOwnership(right);
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

/**
 * pending child 的 hash 可能来自旧版非原子发布断点。只有状态真相仍是 pending 且
 * ZSET 缺 member 时才补入队并写一次 stream；已有 member 时绝不重复 XADD。
 */
async function ensurePendingTaskPublished(redis: Redis, task: Record<string, string>): Promise<boolean> {
  if (!task.task_id || !task.plan_id || task.status !== 'pending') return false;
  const score = pendingScore(Number(task.priority ?? 5), Number(task.created_at ?? Date.now()));
  const published = Number(await redis.eval(
    `if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= ARGV[1] then return 0 end
     if (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= ARGV[4] then return 0 end
     if (redis.call('HGET', KEYS[1], 'status') or '') ~= 'pending' then return 0 end
     redis.call('SADD', KEYS[4], ARGV[4])
     if redis.call('SADD', KEYS[5], ARGV[1]) == 1 then
       redis.call('HINCRBY', KEYS[6], ARGV[4], 1)
       redis.call('SADD', KEYS[7], ARGV[4])
     end
     redis.call('ZREM', KEYS[8], ARGV[1])
     local marked = (redis.call('HGET', KEYS[1], 'runtime_dispatch_published') or '') == 'true'
     if redis.call('ZSCORE', KEYS[2], ARGV[1]) ~= false then
       if not marked then redis.call('HSET', KEYS[1], 'runtime_dispatch_published', 'true') end
       return 0
     end
     redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
     if not marked then
       redis.call('XADD', KEYS[3], '*', 'task_id', ARGV[1], 'priority', ARGV[3])
     end
     redis.call('HSET', KEYS[1], 'runtime_dispatch_published', 'true')
     if marked then return 2 end
     return 1`,
    8,
    keys.hash.task(task.task_id),
    keys.zset.status.pending,
    keys.stream.tasks,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(task.plan_id),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    task.task_id,
    String(score),
    String(task.priority ?? 5),
    task.plan_id,
  ));
  return published > 0;
}

async function ensureRepairScheduledEvent(
  redis: Redis,
  root: Record<string, string>,
  repair: Record<string, string>,
  generation: number,
): Promise<void> {
  if (!root.task_id || !repair.task_id) return;
  const timestamp = Number(repair.created_at ?? Date.now());
  await redis.eval(
    `if (redis.call('HGET', KEYS[1], 'runtime_resolution_event_published') or '') == 'true' then return 0 end
     redis.call('XADD', KEYS[2], '*',
       'event_id', ARGV[1], 'type', 'repair_scheduled', 'task_id', ARGV[2],
       'plan_id', ARGV[3], 'project_path', ARGV[4], 'consumer', 'worker',
       'resolution_action', 'repair', 'repair_task_id', ARGV[5],
       'timestamp', ARGV[6], 'acked', 'false')
     redis.call('HSET', KEYS[1], 'runtime_resolution_event_published', 'true')
     return 1`,
    2,
    keys.hash.task(repair.task_id),
    keys.stream.events,
    `${timestamp}_resolution_${root.task_id}_${generation}`,
    root.task_id,
    root.plan_id ?? repair.plan_id ?? '',
    root.project_path ?? repair.project_path ?? '',
    repair.task_id,
    String(timestamp),
  );
}

async function ensureAcceptanceReadyEvent(
  redis: Redis,
  root: Record<string, string>,
  reverify: Record<string, string>,
): Promise<void> {
  if (!root.task_id || !reverify.task_id) return;
  const timestamp = Number(reverify.created_at ?? Date.now());
  const consumer = await resolvePmConsumer(redis, root.plan_id ?? '');
  await redis.eval(
    `if (redis.call('HGET', KEYS[1], 'runtime_acceptance_ready_published') or '') == 'true' then return 0 end
     local added = redis.call('SADD', KEYS[2], ARGV[1])
     if added == 0 then
       redis.call('HSET', KEYS[1], 'runtime_acceptance_ready_published', 'true')
       return 0
     end
     redis.call('XADD', KEYS[3], '*',
       'event_id', ARGV[2], 'type', 'acceptance_ready', 'task_id', ARGV[1],
       'plan_id', ARGV[3], 'project_path', ARGV[4], 'consumer', ARGV[5],
       'timestamp', ARGV[6], 'acked', 'false')
     redis.call('HSET', KEYS[1], 'runtime_acceptance_ready_published', 'true')
     return 1`,
    3,
    keys.hash.task(reverify.task_id),
    keys.acceptanceReady.fired,
    keys.stream.events,
    reverify.task_id,
    `${timestamp}_acceptance_ready_${reverify.task_id}`,
    root.plan_id ?? reverify.plan_id ?? '',
    root.project_path ?? reverify.project_path ?? '',
    consumer,
    String(timestamp),
  );
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
  await mutateTaskWithPlanProjection(redis, rootTaskId, root.plan_id ?? '', {
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
 * 异常 child 继承的是可调度的执行器亲和，而不是必然只剩一个的旧 agent_id。
 * - auto 保持 auto；显式 kind（kimi/codex/custom...）在没有同名 Agent 注册时原样保留；
 * - 如果 assignee 实际指向某个已注册 Agent，则降级为它的 agent_type，让同类空闲
 *   Worker 或 Supervisor 按需启动的同类 slot 都能接手，也避免 reverify 因独立性规则
 *   排除原 agent_id 后永久无人可领。
 */
async function inheritedResolutionAssignee(
  redis: Redis,
  source: Record<string, string>,
  root: Record<string, string>,
): Promise<string> {
  const explicit = (source.assignee || root.assignee || 'auto').trim() || 'auto';
  if (explicit === 'auto') return explicit;
  const explicitAgentType = await redis.hget(keys.hash.agent(explicit), 'agent_type');
  if (explicitAgentType?.trim()) return explicitAgentType.trim();
  const claimedBy = source.claimed_by || root.claimed_by || '';
  if (claimedBy && claimedBy === explicit) {
    const claimedAgentType = await redis.hget(keys.hash.agent(claimedBy), 'agent_type');
    if (claimedAgentType?.trim()) return claimedAgentType.trim();
  }
  return explicit;
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
    /** 触发本次来源修复的不可变验收拒绝，用于 reconcile 防止重复选源。 */
    triggerReviewTaskId?: string;
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

  // 显式选源 repair 必须把触发它的不可变 review 直接交给 Worker。只写“PM
  // continue”会迫使陌生 Agent 翻 work/ 或旧 PM 目录猜测缺陷，既浪费 token，也很
  // 容易再次提交空改动。这里不推断或改写审计，只投影平台已记录的原文。
  const triggerReview = context.triggerReviewTaskId
    ? await redis.hgetall(keys.hash.task(context.triggerReviewTaskId))
    : {};
  const triggerReviewEvidence = triggerReview.task_id
    ? [
        `触发本轮返修的不可变验收记录：\`${triggerReview.task_id}\`。`,
        `- 决议模式：${triggerReview.pm_rejection_resolution_mode || (triggerReview.status === 'failed' ? 'worker_failed' : 'repair')}`,
        `- 拒绝原因：${triggerReview.pm_reject_reason || triggerReview.failed_reason || '未记录'}`,
        `- PM 评语：${triggerReview.pm_review_comment || '未记录'}`,
        `- 修复要求：${triggerReview.pm_fix_instructions || '未记录'}`,
        '必须以这条最新记录为本轮缺陷来源，不得用更早的 result、旧 repair 报告或自行推测替代。',
      ].join('\n')
    : '';
  const goalContext = triggerReviewEvidence
    ? {
        ...context,
        reason: [context.reason?.trim(), triggerReviewEvidence].filter(Boolean).join('\n\n'),
        instructions: context.instructions?.trim() || triggerReview.pm_fix_instructions || undefined,
      }
    : context;

  // cancelled 是明确终止边界。resolved 通常也是终态，但新的独立 acceptance
  // 失败可以合法推翻上轮修复结论并开启下一代；其它触发仍不得重开。
  if (
    root.resolution_status === 'cancelled' ||
    (root.resolution_status === 'resolved' && context.source !== 'acceptance_failed')
  ) {
    return {
      rootTaskId: context.decisionRootTaskId || rootTaskId,
      state: 'needs_pm_decision',
      action: 'inspect',
      created: false,
    };
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
    // 显式 continue 已持久化自己的 owner/snapshot 时，根的 retry-limit 决策比旧 child
    // 的残缺 review 字段更权威。旧版本可能留下“根已 cancel，但末代 done child 没有
    // review 字段”的双写缺口；此时复用旧 child 会让 continue 永远无法增加 generation。
    const staleDoneChildDuringContinue = context.allowRetryLimitOverride &&
      Boolean(root.resolution_continue_owner) &&
      existingRepair.status === 'done' &&
      !existingRepair.pm_review_status;
    if (isActiveRepair && !staleDoneChildDuringContinue) {
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
  const repairAssignee = await inheritedResolutionAssignee(redis, source, root);
  const collidingTask = await redis.hgetall(keys.hash.task(repairTaskId));
  if (collidingTask.task_id) {
    const isReusableRepair = ['pending', 'running', 'blocked'].includes(collidingTask.status) ||
      (collidingTask.status === 'done' && !collidingTask.pm_review_status);
    const isSameRepair = isReusableRepair &&
      collidingTask.fix_for === sourceTaskId &&
      collidingTask.repair_root_task_id === rootTaskId &&
      collidingTask.plan_id === expectedPlanId &&
      collidingTask.project_path === expectedProjectPath &&
      collidingTask.type === expectedType &&
      (!context.triggerReviewTaskId || collidingTask.trigger_review_task_id === context.triggerReviewTaskId);
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
    await ensurePendingTaskPublished(redis, collidingTask);
    await mutateTaskWithPlanProjection(redis, rootTaskId, root.plan_id ?? expectedPlanId, {
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
      await mutateTaskWithPlanProjection(redis, sourceTaskId, source.plan_id ?? expectedPlanId, {
        resolution_status: awaitingReview ? 'required' : 'repairing',
        resolution_action: awaitingReview ? 'reverify' : 'repair',
        resolution_task_id: repairTaskId,
      });
      await persistTaskFromRedis(redis, sourceTaskId);
    }
    await ensureRepairScheduledEvent(redis, root, collidingTask, generation);
    await persistTaskFromRedis(redis, collidingTask.task_id);
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
  const repairCreateOutcome = await mutateTaskWithPlanProjection(redis, repairTaskId, expectedPlanId, {
    task_id: repairTaskId,
    plan_id: expectedPlanId,
    title: `修复：${source.title ?? sourceTaskId}`,
    type: expectedType,
    phase: source.phase ?? root.phase ?? 'impl',
    // 异常处理仍走普通 pending/claim 队列，但不能丢掉来源显式声明的执行器亲和。
    // 例如 assignee=kimi 的失败任务应继续由 Kimi Worker 修复；auto 仍保持可抢占。
    assignee: repairAssignee,
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
    goal_md: repairGoal(source, goalContext),
    repair_ownership_extension: context.repairOwnership ? JSON.stringify(context.repairOwnership) : '',
    project_path: expectedProjectPath,
    created_at: String(now),
    fix_for: sourceTaskId,
    repair_root_task_id: rootTaskId,
    trigger_review_task_id: context.triggerReviewTaskId ?? '',
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    acceptance_repair_task_ids: '',
    resolved_by_task: '',
    resolution_generation: '0',
    resolution_attempts: '0',
  }, 'create');
  if (repairCreateOutcome === 'TASK_EXISTS') {
    // 并发 reconcile 可能在我们确认“不存在”后先创建确定性 child。回到入口按
    // immutable identity 校验并复用；绝不覆盖先到者，也不把正常竞争当故障。
    return ensureRepairTask(redis, sourceTaskId, context);
  }
  await ensurePendingTaskPublished(redis, await redis.hgetall(keys.hash.task(repairTaskId)));

  const historicalIds = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  const nextIds = [...historicalIds, repairTaskId];
  await mutateTaskWithPlanProjection(redis, rootTaskId, root.plan_id ?? expectedPlanId, {
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
    await mutateTaskWithPlanProjection(redis, sourceTaskId, source.plan_id ?? expectedPlanId, {
      resolution_status: 'repairing',
      resolution_action: 'repair',
      resolution_task_id: repairTaskId,
    });
  }
  // repair 已进入 task stream，Worker/共享 Supervisor 会自行领取；事件和 child 上的
  // publication marker 由同一 Lua 原子提交，避免并发/崩溃重复或漏写。
  await ensureRepairScheduledEvent(
    redis,
    root,
    await redis.hgetall(keys.hash.task(repairTaskId)),
    generation,
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
 * 只有仍可能推进自动补偿的终态根才进入启动 backfill。普通 accepted/done 历史不应
 * 进入常驻轮询；当前版本的 accept 写路径会原子登记自己的短生命周期 dirty candidate。
 */
function needsRuntimeReconcileBackfill(task: Record<string, string>): boolean {
  if (!task.task_id || task.status === 'cancelled' || task.status === 'superseded') return false;
  // 升级前可能已提交 accepted 审计、却在 dependency/lineage 副作用完成前退出；旧写
  // 路径没有 dirty member，只能由首次历史 backfill 捕获。标记写成 true 后不会再入队。
  if (
    task.status === 'done' &&
    task.pm_review_status === 'accepted' &&
    task.pm_accept_effects_applied !== 'true'
  ) return true;
  const terminalFailure = task.status === 'failed' ||
    (task.status === 'done' && task.pm_review_status === 'rejected');
  if (!terminalFailure) return false;
  return !['resolved', 'cancelled', 'needs_pm_decision'].includes(task.resolution_status ?? '');
}

async function readTaskHashesInChunks(
  redis: Redis,
  taskIds: Iterable<string>,
): Promise<Array<Record<string, string>>> {
  const ids = [...new Set(taskIds)];
  const result: Array<Record<string, string>> = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    result.push(...await Promise.all(
      ids.slice(offset, offset + 500).map((taskId) => redis.hgetall(keys.hash.task(taskId))),
    ));
  }
  return result;
}

/**
 * intake failed 候选的唯一写入口。Lua 在提交点重读 hash，避免调用者较早的 HGETALL
 * 快照与并发 resolution 决定交错，把 resolved/repairing 历史重新放回常驻索引。
 */
const SYNC_INTAKE_ACTIONABLE_FAILED = `
  local task_id = redis.call('HGET', KEYS[1], 'task_id') or ''
if task_id == '' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
  end
  local repair_root = redis.call('HGET', KEYS[1], 'repair_root_task_id') or ''
  if repair_root ~= ARGV[3] then return -1 end
  local status = redis.call('HGET', KEYS[1], 'status') or ''
  local resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''
  if repair_root ~= '' and repair_root ~= task_id then
    local root_id = redis.call('HGET', KEYS[3], 'task_id') or ''
    local root_resolution = redis.call('HGET', KEYS[3], 'resolution_status') or ''
    if root_id == repair_root and (root_resolution == 'repairing' or root_resolution == 'required' or
       root_resolution == 'resolved' or root_resolution == 'cancelled' or
       root_resolution == 'needs_pm_decision') then
      redis.call('ZREM', KEYS[2], ARGV[1])
      return 0
    end
  end
  local actionable = resolution == 'needs_pm_decision' or
  (status == 'failed' and resolution ~= 'repairing' and resolution ~= 'required' and
   resolution ~= 'resolved' and resolution ~= 'cancelled')
if actionable then
  local score = tonumber(redis.call('HGET', KEYS[1], 'done_at') or '') or tonumber(ARGV[2])
  redis.call('ZADD', KEYS[2], score, ARGV[1])
  return 1
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 0
`;

async function syncIntakeActionableFailed(redis: Redis, taskId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const repairRoot = await redis.hget(keys.hash.task(taskId), 'repair_root_task_id') ?? '';
    const result = Number(await redis.eval(
      SYNC_INTAKE_ACTIONABLE_FAILED,
      3,
      keys.hash.task(taskId),
      keys.intakeActionableFailed.pending,
      keys.hash.task(repairRoot || '__none__'),
      taskId,
      String(Date.now()),
      repairRoot,
    ));
    if (result !== -1) return result === 1;
  }
  // 指针持续变化时宁可保留候选供下一轮复核，也不能用旧 root 快照误删 PM 待办。
  return false;
}

const RELEASE_INTAKE_FAILED_BACKFILL_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_BACKFILL_LOCK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

interface BackfillLockLease {
  state: { lost: boolean; error?: Error };
  stop: () => Promise<void>;
}

/**
 * 扫描型 legacy backfill 可能超过初始 TTL。独立连接按 owner-token 低频续租；
 * 发布仍必须在单 Lua 内比较 owner，因此续租只保证活 owner 可完成，不降低 fencing。
 */
function startBackfillLockRenewal(
  redis: Redis,
  lockKey: string,
  owner: string,
  ttlMs: number,
  intervalMsOverride?: number,
): BackfillLockLease {
  const renewal = redis.duplicate();
  const state: BackfillLockLease['state'] = { lost: false };
  let running = false;
  const renew = async () => {
    if (running || state.lost) return;
    running = true;
    try {
      const result = Number(await renewal.eval(RENEW_BACKFILL_LOCK, 1, lockKey, owner, String(ttlMs)));
      if (result !== 1) state.lost = true;
    } catch (error) {
      state.lost = true;
      state.error = error as Error;
    } finally {
      running = false;
    }
  };
  const intervalMs = intervalMsOverride ?? Math.max(10, Math.floor(ttlMs / 3));
  const timer = setInterval(() => { void renew(); }, intervalMs);
  timer.unref();
  return {
    state,
    stop: async () => {
      clearInterval(timer);
      while (running) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      renewal.disconnect();
    },
  };
}

const DELETE_INTAKE_READY_IF_OWNER = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[2])
`;

async function waitForIntakeFailedBackfill(redis: Redis): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await redis.get(keys.intakeActionableFailed.ready)) return;
    if (!(await redis.exists(keys.intakeActionableFailed.backfillLock))) {
      return ensureIntakeActionableFailedIndex(redis);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('intake actionable failed backfill timed out');
}

/**
 * standalone `pmIntake` 的 legacy upgrade 边界。只合并候选、不清空 pending；ready 发布
 * 后逐项 Lua 复核，因而 backfill 与并发 resolution 转换交错也不会遗留陈旧历史。
 */
async function ensureIntakeActionableFailedIndex(redis: Redis): Promise<void> {
  if (await redis.get(keys.intakeActionableFailed.ready)) return;
  const owner = randomUUID();
  const ttlMs = 30_000;
  const acquired = await redis.set(keys.intakeActionableFailed.backfillLock, owner, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return waitForIntakeFailedBackfill(redis);
  const renewal = startBackfillLockRenewal(
    redis,
    keys.intakeActionableFailed.backfillLock,
    owner,
    ttlMs,
  );

  try {
    if (await redis.get(keys.intakeActionableFailed.ready)) return;
    const [failedIds, doneIds] = await Promise.all([
      redis.zrange(keys.zset.status.failed, 0, -1),
      // legacy done+rejected roots may also be persistent needs_pm_decision facts. This is
      // one-time upgrade work only; ready steadystate never scans terminal history again.
      redis.zrange(keys.zset.status.done, 0, -1),
    ]);
    // failed zset 只提供 legacy 候选 id；actionability 必须在 fenced 发布 Lua 中按
    // 当前 hash 重读。这样 ready 可见时，pending 已经是同一原子快照，不存在先伪提醒
    // 再逐项清理的窗口。
    const candidateIds = [...new Set([
      ...failedIds,
      ...doneIds,
      ...await redis.zrange(keys.intakeActionableFailed.pending, 0, -1),
    ])];
    if (renewal.state.lost) {
      throw renewal.state.error ?? new Error('intake actionable failed backfill lease lost');
    }
    const publishKeys = [
      keys.intakeActionableFailed.backfillLock,
      keys.intakeActionableFailed.pending,
      keys.intakeActionableFailed.ready,
      ...candidateIds.map((taskId) => keys.hash.task(taskId)),
    ];
    // Lua receives candidate ids as argv and the parallel task hashes as KEYS.
    const published = Number(await redis.eval(
      `-- intake-actionable-failed-fenced-backfill-v1
       if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       local now = tonumber(ARGV[2])
       local count = tonumber(ARGV[3]) or 0
       for index = 1, count do
         local task_id = ARGV[3 + index]
         local task_key = KEYS[3 + index]
         local id = redis.call('HGET', task_key, 'task_id') or ''
         local status = redis.call('HGET', task_key, 'status') or ''
         local resolution = redis.call('HGET', task_key, 'resolution_status') or ''
         local actionable = id == task_id and (resolution == 'needs_pm_decision' or
           (status == 'failed' and resolution ~= 'repairing' and resolution ~= 'required' and
            resolution ~= 'resolved' and resolution ~= 'cancelled'))
         if actionable then
           local score = tonumber(redis.call('HGET', task_key, 'done_at') or '') or now
           redis.call('ZADD', KEYS[2], score, task_id)
         else
           redis.call('ZREM', KEYS[2], task_id)
         end
       end
       redis.call('SET', KEYS[3], '1')
       return 1`,
      publishKeys.length,
      ...publishKeys,
      owner,
      String(Date.now()),
      String(candidateIds.length),
      ...candidateIds,
    ));
    if (published !== 1) {
      await waitForIntakeFailedBackfill(redis);
      return;
    }
  } catch (error) {
    await redis.eval(
      DELETE_INTAKE_READY_IF_OWNER,
      2,
      keys.intakeActionableFailed.backfillLock,
      keys.intakeActionableFailed.ready,
      owner,
    ).catch(() => undefined);
    throw new Error(`intake actionable failed backfill failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await renewal.stop();
    await redis.eval(
      RELEASE_INTAKE_FAILED_BACKFILL_LOCK,
      1,
      keys.intakeActionableFailed.backfillLock,
      owner,
    ).catch(() => undefined);
  }
}

/**
 * marker 缺失（首次升级、Redis 清空、SQLite restore）时，从历史终态安全回建一次。
 * 只做 ZADD、不清空现有 dirty，避免 backfill 与并发异常转换交错时误删新候选。
 * candidates 先用 MULTI 合并；全部成功后才发布 marker。Redis MULTI 的单命令错误不
 * 回滚其它命令，因此失败路径必须删除 marker，宁可下轮重扫也不能永久跳过 backfill。
 */
async function ensureRuntimeReconcileBackfill(
  redis: Redis,
  force = false,
): Promise<string[]> {
  if (!force && await redis.get(keys.runtimeReconcile.backfillReady)) {
    return redis.zrange(keys.runtimeReconcile.pending, 0, -1);
  }

  const [failedIds, doneIds] = await Promise.all([
    redis.zrange(keys.zset.status.failed, 0, -1),
    redis.zrange(keys.zset.status.done, 0, -1),
  ]);
  const hashes = await readTaskHashesInChunks(redis, [...failedIds, ...doneIds]);
  const candidates = hashes.filter(needsRuntimeReconcileBackfill).map((task) => task.task_id);
  const now = Date.now();
  const tx = redis.multi();
  for (const taskId of candidates) tx.zadd(keys.runtimeReconcile.pending, now, taskId);
  const outcomes = await tx.exec();
  if (!outcomes || outcomes.some(([error]) => error)) {
    await redis.del(keys.runtimeReconcile.backfillReady).catch(() => undefined);
    throw new Error('runtime reconcile backfill 原子发布失败');
  }
  await redis.set(keys.runtimeReconcile.backfillReady, '1');
  return redis.zrange(keys.runtimeReconcile.pending, 0, -1);
}

/**
 * 候选清理也必须与 task 状态检查原子化：若新 reject/failure 在清理前已提交则保留；
 * 若在清理后提交，其状态事务会重新 ZADD。这样不会出现“旧轮次删除新异常”的竞态。
 */
const CLEAN_RUNTIME_RECONCILE_CANDIDATE = `
local status = redis.call('HGET', KEYS[1], 'status') or ''
local review = redis.call('HGET', KEYS[1], 'pm_review_status') or ''
local effects = redis.call('HGET', KEYS[1], 'pm_accept_effects_applied') or ''
local resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''

if status == 'done' and review == 'accepted' and effects ~= 'true' then
  return 0
end

local terminal_failure = status == 'failed' or (status == 'done' and review == 'rejected')
if terminal_failure and resolution ~= 'resolved' and resolution ~= 'cancelled' and resolution ~= 'needs_pm_decision' then
  return 0
end

return redis.call('ZREM', KEYS[2], ARGV[1])
`;

async function cleanRuntimeReconcileCandidate(redis: Redis, taskId: string): Promise<void> {
  await redis.eval(
    CLEAN_RUNTIME_RECONCILE_CANDIDATE,
    2,
    keys.hash.task(taskId),
    keys.runtimeReconcile.pending,
    taskId,
  );
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
      await mutateTaskWithPlanProjection(redis, legacyFix.task_id, legacyFix.plan_id ?? parent.plan_id ?? '', {
        fix_for: parentTaskId,
        repair_root_task_id: rootTaskId,
        resolution_status: 'repairing',
        resolution_action: 'repair',
        resolution_task_id: currentRepair.task_id,
      });
      await mutateTaskWithPlanProjection(redis, currentRepair.task_id, currentRepair.plan_id ?? parent.plan_id ?? '', {
        fix_for: legacyFix.task_id,
        repair_root_task_id: rootTaskId,
      });
      await mutateTaskWithPlanProjection(redis, parentTaskId, parent.plan_id ?? '', {
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

    await mutateTaskWithPlanProjection(redis, legacyFix.task_id, legacyFix.plan_id ?? parent.plan_id ?? '', {
      fix_for: parentTaskId,
      repair_root_task_id: rootTaskId,
      resolution_status: 'repairing',
      resolution_action: 'repair',
    });
    await mutateTaskWithPlanProjection(redis, parentTaskId, parent.plan_id ?? '', {
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
 * 清理旧版本“多来源验收失败 -> 对每个来源自动 fan-out repair”留下的待领取 child。
 *
 * 只能凭 repair 的不可变 goal 中精确记录的 acceptance task id 认领这批脏数据；不能
 * 按 repair 命名或来源状态猜测。已经开始执行、阻塞或交付待审的 child 保留现场，
 * 只有 pending child 会被审计式取消并从来源根的当前 resolution 指针中移除。
 */
async function cleanupLegacyMultiSourceAcceptanceFanout(
  redis: Redis,
  acceptance: Record<string, string>,
): Promise<string[]> {
  if (!acceptance.task_id) return [];
  const cancelledIds: string[] = [];
  const preservedIds = new Set<string>();
  const matchedIds = new Set<string>();
  const reasonMarkers = [
    `独立验收任务 ${acceptance.task_id} 失败`,
    `独立验收任务 ${acceptance.task_id} 被 PM 拒绝`,
  ];

  for (const sourceId of acceptanceSourceIds(acceptance)) {
    const source = await redis.hgetall(keys.hash.task(sourceId));
    if (!source.task_id) continue;
    const rootId = source.repair_root_task_id || source.task_id;
    const root = rootId === source.task_id ? source : await redis.hgetall(keys.hash.task(rootId));
    if (!root.task_id) continue;

    const historyIds = [...new Set([
      ...(root.resolution_task_ids ?? '').split(',').filter(Boolean),
      ...(root.resolution_task_id ? [root.resolution_task_id] : []),
      ...(source.task_id !== root.task_id && source.resolution_task_id ? [source.resolution_task_id] : []),
    ])];
    const cancelledForRoot = new Set<string>();
    for (const taskId of historyIds) {
      const child = await redis.hgetall(keys.hash.task(taskId));
      const belongsToRoot = child.task_id === taskId &&
        child.repair_root_task_id === root.task_id;
      const causedByAcceptance = belongsToRoot &&
        reasonMarkers.some((marker) => (child.goal_md ?? '').includes(marker));
      if (!causedByAcceptance) continue;
      matchedIds.add(taskId);
      if (child.status !== 'pending') {
        preservedIds.add(taskId);
        continue;
      }

      const now = Date.now();
      await mutateTaskWithPlanProjection(redis, taskId, child.plan_id ?? root.plan_id ?? '', {
        status: 'cancelled',
        cancelled_at: String(now),
        cancel_reason: `旧版多来源验收 ${acceptance.task_id} 错误扩散的未领取修复，平台升级后自动撤销`,
        resolution_decision_reason: `legacy_multi_source_acceptance_fanout_cancelled:${acceptance.task_id}`,
      });
      await redis.multi()
        .zrem(keys.zset.status.pending, taskId)
        .zadd(keys.zset.status.cancelled, now, taskId)
        .exec();
      await persistTaskFromRedis(redis, taskId);
      cancelledForRoot.add(taskId);
      cancelledIds.push(taskId);
    }

    if (cancelledForRoot.size === 0) continue;
    const remainingHistory = (root.resolution_task_ids ?? '').split(',')
      .filter(Boolean)
      .filter((taskId) => !cancelledForRoot.has(taskId));
    const pointerWasCancelled = cancelledForRoot.has(root.resolution_task_id ?? '');
    const remainingActiveChildren: Record<string, string>[] = [];
    for (const taskId of remainingHistory) {
      const child = await redis.hgetall(keys.hash.task(taskId));
      if (child.task_id && (
        ['pending', 'running', 'blocked'].includes(child.status) ||
        (child.status === 'done' && !child.pm_review_status)
      )) remainingActiveChildren.push(child);
    }
    const acceptedRoot = root.status === 'done' && root.pm_review_status === 'accepted';
    const fields: Record<string, string> = {
      resolution_task_ids: [...new Set(remainingHistory)].join(','),
    };
    if (pointerWasCancelled) {
      fields.resolution_task_id = remainingActiveChildren.at(-1)?.task_id ?? '';
    }
    if (acceptedRoot && remainingActiveChildren.length === 0) {
      fields.resolution_status = '';
      fields.resolution_action = '';
      fields.resolution_task_id = '';
      fields.resolved_by_task = '';
      fields.resolution_decision_reason = '';
    }
    await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', fields);
    await persistTaskFromRedis(redis, root.task_id);
  }

  // acceptance 根单独保存的 reviewer-independence 列表也不能继续引用已取消的
  // 错误 fan-out；运行中/待审的现场仍保留，供后续 reverify 排除同一执行者。
  const repairAuditIds = (acceptance.acceptance_repair_task_ids ?? '').split(',').filter(Boolean);
  const cleanedRepairAuditIds = repairAuditIds.filter((taskId) =>
    !matchedIds.has(taskId) || preservedIds.has(taskId),
  );
  if (cleanedRepairAuditIds.join(',') !== repairAuditIds.join(',')) {
    await mutateTaskWithPlanProjection(redis, acceptance.task_id, acceptance.plan_id ?? '', {
      acceptance_repair_task_ids: [...new Set(cleanedRepairAuditIds)].join(','),
    });
    await persistTaskFromRedis(redis, acceptance.task_id);
  }
  return cancelledIds;
}

async function terminalizePendingResolutionChildren(
  redis: Redis,
  root: Record<string, string>,
  childIds: Iterable<string>,
  reasonCode: string,
  reason: string,
): Promise<string[]> {
  const cancelled: string[] = [];
  const now = Date.now();
  for (const childId of new Set(childIds)) {
    if (!childId) continue;
    const child = await redis.hgetall(keys.hash.task(childId));
    if (
      child.task_id !== childId || child.status !== 'pending' ||
      child.repair_root_task_id !== root.task_id
    ) continue;
    await mutateTaskWithPlanProjection(redis, childId, child.plan_id ?? root.plan_id ?? '', {
      status: 'cancelled',
      cancelled_at: String(now),
      cancel_reason: reason,
      resolution_decision_reason: reasonCode,
    });
    await redis.multi()
      .zrem(keys.zset.status.pending, childId)
      .zadd(keys.zset.status.cancelled, now, childId)
      .exec();
    await persistTaskFromRedis(redis, childId);
    cancelled.push(childId);
  }
  return cancelled;
}

/**
 * A resolved source can legitimately receive a new repair after a later,
 * independent acceptance discovers another defect.  Such a task is not a stale
 * sibling of the old winner even though both share the source repair root.
 */
async function repairWasTriggeredAfterWinner(
  redis: Redis,
  child: Record<string, string>,
  winner: Record<string, string>,
): Promise<boolean> {
  if (!child.trigger_review_task_id) return false;
  const trigger = await redis.hgetall(keys.hash.task(child.trigger_review_task_id));
  if (!trigger.task_id) return false;
  const triggerAt = Number(trigger.pm_reviewed_at || trigger.done_at || trigger.created_at || 0);
  const winnerAt = Number(winner.pm_reviewed_at || winner.done_at || winner.created_at || 0);
  return triggerAt > winnerAt;
}

/**
 * 防止已被 accepted winner 收敛的旧 repair 在回收/升级窗口重新被领取。
 *
 * 这里只处理已经是 pending 的 child；running/blocked/done 现场始终保留给执行器或
 * PM，不能被后台清理打断。winner、root lineage 与 review 三项都必须闭合，避免仅凭
 * 一个陈旧 resolved 字段误杀合法的新一代修复。
 */
async function terminalizeSupersededPendingRepair(
  redis: Redis,
  child: Record<string, string>,
): Promise<boolean> {
  if (!child.task_id || child.status !== 'pending' || !child.fix_for) return false;
  const rootTaskId = child.repair_root_task_id || child.fix_for;
  const root = await redis.hgetall(keys.hash.task(rootTaskId));
  if (
    !root.task_id || root.resolution_status !== 'resolved' ||
    !root.resolved_by_task || root.resolved_by_task === child.task_id ||
    !(root.resolution_task_ids ?? '').split(',').filter(Boolean).includes(child.task_id)
  ) return false;
  const winner = await redis.hgetall(keys.hash.task(root.resolved_by_task));
  if (
    winner.task_id !== root.resolved_by_task ||
    winner.repair_root_task_id !== root.task_id ||
    winner.status !== 'done' || winner.pm_review_status !== 'accepted'
  ) return false;
  if (await repairWasTriggeredAfterWinner(redis, child, winner)) return false;
  const cancelled = await terminalizePendingResolutionChildren(
    redis,
    root,
    [child.task_id],
    `superseded_by_accepted_repair:${winner.task_id}`,
    `修复 ${winner.task_id} 已验收，回收的旧 sibling 不再重新执行`,
  );
  return cancelled.includes(child.task_id);
}

/**
 * 旧版本只在根任务记录 generation，child 一直是 0；部分 reverify 创建路径还会
 * 漏增 resolution_attempts。确定性 task id 已包含真实代次，可据此幂等回填，
 * 但绝不降低现有计数，也不把不属于该根的碰撞任务纳入 lineage。
 */
async function normalizeResolutionLineageMetadata(
  redis: Redis,
  root: Record<string, string>,
): Promise<boolean> {
  if (
    !root.task_id || root.type !== 'acceptance' || root.fix_for ||
    (root.repair_root_task_id && root.repair_root_task_id !== root.task_id)
  ) {
    return false;
  }
  let highestGeneration = Math.max(0, Number(root.resolution_generation ?? 0));
  let foundOwnedReverify = false;
  let changed = false;
  for (const childId of [...new Set((root.resolution_task_ids ?? '').split(',').filter(Boolean))]) {
    const child = await redis.hgetall(keys.hash.task(childId));
    if (child.task_id !== childId || child.repair_root_task_id !== root.task_id) continue;
    const match = childId.match(/-reverify-(\d+)$/);
    const generation = Number(match?.[1] ?? 0);
    if (!Number.isSafeInteger(generation) || generation <= 0) continue;
    foundOwnedReverify = true;
    highestGeneration = Math.max(highestGeneration, generation);
    if (Number(child.resolution_generation ?? 0) === generation) continue;
    await mutateTaskWithPlanProjection(redis, childId, child.plan_id ?? root.plan_id ?? '', {
      resolution_generation: String(generation),
    });
    await persistTaskFromRedis(redis, childId);
    changed = true;
  }
  if (foundOwnedReverify && (
    Number(root.resolution_generation ?? 0) < highestGeneration ||
    Number(root.resolution_attempts ?? 0) < highestGeneration
  )) {
    await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', {
      resolution_generation: String(highestGeneration),
      resolution_attempts: String(highestGeneration),
    });
    await persistTaskFromRedis(redis, root.task_id);
    changed = true;
  }
  return changed;
}

const LEGACY_CANCEL_REASON = '历史版本未记录撤销原因（不可恢复）';

/**
 * 旧版 cancelled 记录可能只有状态与时间，没有原因。这里只补“历史
 * 事实不可恢复”标记，不猜测行为人或原因，也绝不覆盖已有审计。
 */
async function backfillLegacyCancelledAudit(redis: Redis): Promise<void> {
  const taskIds = await redis.zrange(keys.zset.status.cancelled, 0, -1);
  for (const taskId of taskIds) {
    const task = await redis.hgetall(keys.hash.task(taskId));
    if (task.task_id !== taskId || task.status !== 'cancelled') continue;
    const fields: Record<string, string> = {};
    if (!task.cancel_reason) fields.cancel_reason = LEGACY_CANCEL_REASON;
    if (!task.cancelled_at) {
      const score = Number(await redis.zscore(keys.zset.status.cancelled, taskId));
      if (Number.isFinite(score) && score > 0) fields.cancelled_at = String(Math.floor(score));
    }
    if (Object.keys(fields).length === 0) continue;
    await mutateTaskWithPlanProjection(redis, taskId, task.plan_id ?? '', fields);
    await persistTaskFromRedis(redis, taskId);
  }
}

async function activeAcceptanceOwnsRepair(
  redis: Redis,
  root: Record<string, string>,
  repairTaskId: string,
): Promise<boolean> {
  if (!root.plan_id || !repairTaskId) return false;
  const planTaskIds = await redis.smembers(keys.planStatusProjection.taskIdsByPlan(root.plan_id));
  for (const taskId of planTaskIds) {
    const acceptance = await redis.hgetall(keys.hash.task(taskId));
    if (acceptance.type !== 'acceptance') continue;
    const repairIds = (acceptance.acceptance_repair_task_ids ?? '').split(',').filter(Boolean);
    if (!repairIds.includes(repairTaskId)) continue;
    const sources = acceptanceSourceIds(acceptance);
    const unresolvedFailure = acceptance.status === 'failed' ||
      (acceptance.status === 'done' && acceptance.pm_review_status === 'rejected');
    if (!unresolvedFailure || ['resolved', 'cancelled'].includes(acceptance.resolution_status ?? '')) continue;
    if (sources.length === 1 && sources[0] === root.task_id) return true;
    if (
      sources.includes(root.task_id) &&
      (await activeSelectedAcceptanceRepairs(redis, acceptance))
        .some((repair) => repair.task_id === repairTaskId)
    ) return true;
  }
  return false;
}

async function latestAcceptedResolutionChild(
  redis: Redis,
  root: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean).reverse();
  for (const taskId of history) {
    const child = await redis.hgetall(keys.hash.task(taskId));
    if (
      child.task_id === taskId && child.repair_root_task_id === root.task_id &&
      child.status === 'done' && child.pm_review_status === 'accepted'
    ) return child;
  }
  return undefined;
}

/**
 * 判断一个普通 repair 是否由多来源 acceptance 的显式选源决策创建。
 *
 * 这类 repair 被拒绝时，下一步决策仍属于 acceptance 根，而不是来源根。若把它
 * 当作普通 repair 继续处理，会先为来源根发出一次 resolution_required，随后
 * reconcile 才恢复已 accepted 的来源并改响 acceptance，造成 Supervisor 在同一
 * 轮看到两个互相冲突的 PM 门铃。
 */
async function selectedRepairAcceptanceRoot(
  redis: Redis,
  repair: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (!repair.task_id || !repair.trigger_review_task_id || !repair.fix_for) return undefined;
  const trigger = await redis.hgetall(keys.hash.task(repair.trigger_review_task_id));
  if (trigger.type !== 'acceptance') return undefined;
  const rootId = trigger.repair_root_task_id || trigger.task_id;
  const root = rootId === trigger.task_id ? trigger : await redis.hgetall(keys.hash.task(rootId));
  if (
    root.type !== 'acceptance' ||
    !acceptanceSourceIds(root).includes(repair.fix_for) ||
    !(root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean).includes(repair.task_id) ||
    ['resolved', 'cancelled'].includes(root.resolution_status ?? '')
  ) return undefined;
  return root;
}

/** 显式选源 repair 失败后恢复来源原有的 accepted 发布边界。 */
async function restoreAcceptedSourceAfterSelectedRepairReject(
  redis: Redis,
  repair: Record<string, string>,
): Promise<void> {
  const source = await redis.hgetall(keys.hash.task(repair.fix_for ?? ''));
  if (!source.task_id) return;
  const rootId = source.repair_root_task_id || source.task_id;
  const root = rootId === source.task_id ? source : await redis.hgetall(keys.hash.task(rootId));
  if (root.status !== 'done' || root.pm_review_status !== 'accepted') return;
  const acceptedWinner = await latestAcceptedResolutionChild(redis, root);
  await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', acceptedWinner
    ? {
        resolution_status: 'resolved',
        resolution_action: 'repair',
        resolution_task_id: acceptedWinner.task_id,
        resolved_by_task: acceptedWinner.task_id,
        resolution_decision_reason: '',
      }
    : {
        resolution_status: '',
        resolution_action: '',
        resolution_task_id: '',
        resolved_by_task: '',
        resolution_decision_reason: '',
      });
  await persistTaskFromRedis(redis, root.task_id);
}

/**
 * 为旧版本遗留的 failed/rejected 状态补建一次 repair 闭环。
 *
 * 新版本的 report/review 已同步创建 repair；此函数只服务于升级、SQLite restore 和
 * `watchdog --auto-fix`。它完全幂等：一旦根任务已有 resolution_status，就不会再创建
 * 新任务或重复通知 PM。对于历史 repair 链，优先回到失败/拒绝的根任务，避免把同一个
 * 问题拆成多个并行修复者。
 */
async function reconcileResolutionBacklogUnlocked(
  redis: Redis,
  opts: { migrateLegacyNamedFixes?: boolean; candidateIds?: Iterable<string> } = {},
): Promise<ResolutionReconciliation> {
  if (opts.migrateLegacyNamedFixes !== false) await migrateLegacyNamedFixes(redis);
  const candidateIds = opts.candidateIds === undefined
    ? new Set([
        ...(await redis.zrange(keys.zset.status.failed, 0, -1)),
        ...(await redis.zrange(keys.zset.status.done, 0, -1)),
      ])
    : new Set(opts.candidateIds);
  await recoverInterruptedResolutionContinues(redis, candidateIds);
  const repairedTaskIds: string[] = [];
  const needsPmDecisionTaskIds: string[] = [];
  const handledRoots = new Set<string>();

  for (const candidateId of candidateIds) {
    let candidate = await redis.hgetall(keys.hash.task(candidateId));
    if (await normalizeResolutionLineageMetadata(redis, candidate)) {
      candidate = await redis.hgetall(keys.hash.task(candidateId));
    }
    // 旧版本的多来源验收曾经把已经 accepted 的来源重新打开，并生成无人领取的
    // repair。accepted 是发布边界：只自动撤销尚未领取的错误 child；若 child 已经
    // 执行或交付则保留现场给 PM，避免升级过程打断正常 Worker/审计。
    if (
      candidate.task_id && candidate.status === 'done' && candidate.pm_review_status === 'accepted' &&
      ['required', 'repairing', 'needs_pm_decision'].includes(candidate.resolution_status ?? '')
    ) {
      const historyIds = [...new Set([
        ...(candidate.resolution_task_ids ?? '').split(',').filter(Boolean),
        ...(candidate.resolution_task_id ? [candidate.resolution_task_id] : []),
      ])];
      const ownedChildren: Array<Record<string, string>> = [];
      for (const taskId of historyIds) {
        const child = await redis.hgetall(keys.hash.task(taskId));
        if (child.task_id === taskId && child.repair_root_task_id === candidate.task_id) ownedChildren.push(child);
      }
      const hasStartedChild = ownedChildren.some((child) =>
        ['running', 'blocked'].includes(child.status) ||
        (child.status === 'done' && !child.pm_review_status),
      );
      const currentChildId = candidate.resolution_task_id ?? '';
      const currentChild = ownedChildren.find((child) => child.task_id === currentChildId);
      const currentOwnedByActiveAcceptance = currentChild?.status === 'pending' &&
        await activeAcceptanceOwnsRepair(redis, candidate, currentChildId);
      if (currentOwnedByActiveAcceptance && currentChild) {
        await terminalizePendingResolutionChildren(
          redis,
          candidate,
          ownedChildren.filter((child) => child.task_id !== currentChildId).map((child) => child.task_id),
          `superseded_by_current_repair:${currentChildId}`,
          `根任务当前修复已切换到 ${currentChildId}，旧 pending sibling 自动撤销`,
        );
        await ensurePendingTaskPublished(redis, currentChild);
        await ensureRepairScheduledEvent(
          redis,
          candidate,
          currentChild,
          Number(candidate.resolution_generation ?? 1),
        );
        await persistTaskFromRedis(redis, currentChild.task_id);
        await persistTaskFromRedis(redis, candidate.task_id);
      } else if (!hasStartedChild) {
        await terminalizePendingResolutionChildren(
          redis,
          candidate,
          ownedChildren.map((child) => child.task_id),
          'accepted_root_legacy_repair_cancelled',
          '已验收根任务的旧修复尚未启动，平台自动清理该无效修复',
        );
        await mutateTaskWithPlanProjection(redis, candidate.task_id, candidate.plan_id ?? '', {
          resolution_status: '',
          resolution_action: '',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        });
        await persistTaskFromRedis(redis, candidate.task_id);
      }
      handledRoots.add(candidate.task_id);
      continue;
    }
    const candidateNeedsRepair = candidate.status === 'failed' ||
      (candidate.status === 'done' && candidate.pm_review_status === 'rejected');
    if (!candidate.task_id || candidate.status === 'cancelled' || !candidateNeedsRepair) continue;

    // A rejected source repair selected by a multi-source acceptance belongs to
    // that acceptance decision, not to the source's ordinary retry loop. pmReview
    // already reopened the acceptance root; startup reconciliation must not mint
    // an unselected source repair before the PM makes the next explicit choice.
    const selectedAcceptance = await selectedRepairAcceptanceRoot(redis, candidate);
    if (selectedAcceptance?.task_id) {
      const normalized = await normalizeRepairSourcesDecisionReason(redis, selectedAcceptance);
      if (!needsPmDecisionTaskIds.includes(normalized.task_id)) {
        needsPmDecisionTaskIds.push(normalized.task_id);
      }
      handledRoots.add(candidate.repair_root_task_id || candidate.fix_for || candidate.task_id);
      continue;
    }

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
    // 根 repair 链已经由 accepted child 收敛，或由 PM 显式 cancel 终止后，历史上
    // 仍保持 failed/rejected 的 sibling/ancestor 只是不可变审计，不能再把根任务
    // 重新打开成 needs_pm_decision。否则每次 reconcile 都会再生同一 PM 门铃。
    if (['resolved', 'cancelled'].includes(resolutionOwner.resolution_status ?? '')) {
      await terminalizePendingResolutionChildren(
        redis,
        resolutionOwner,
        (resolutionOwner.resolution_task_ids ?? '').split(',').filter(Boolean),
        `resolution_root_closed:${resolutionOwner.resolution_status}`,
        `根任务已经 ${resolutionOwner.resolution_status}，遗留 pending sibling 自动撤销`,
      );
      handledRoots.add(rootTaskId);
      continue;
    }
    // PM 的显式 continue 已先用持久 owner 把根任务占位为 repairing，再创建下一代
    // child。这个很短的窗口里 pointer 仍可能指向旧失败 attempt；后台 reconcile
    // 若按旧 pointer 收敛，会清空新 pointer、重新触发 retry-limit，并撤销刚创建的
    // pending child。只要同一 PM 锁仍有效，就让原事务完成；失锁后由
    // recoverInterruptedResolutionContinues 按持久 intent 接管。
    if (
      resolutionOwner.resolution_continue_owner &&
      await redis.get(keys.string.pmReviewLock(resolutionOwner.task_id)) === resolutionOwner.resolution_continue_owner
    ) {
      handledRoots.add(rootTaskId);
      continue;
    }
    // PM 已为多来源验收显式选源且对应 repair 正在执行时，该选择就是当前
    // resolution。reconcile 只能恢复发布/投影，不能再次改回 needs_pm_decision；
    // 否则 Supervisor 会重复唤醒 PM，并可能重复创建来源修复。
    const activeSelectedRepairs = await activeSelectedAcceptanceRepairs(redis, resolutionOwner);
    if (activeSelectedRepairs.length > 0) {
      await markAcceptanceFailureResolution(
        redis,
        resolutionOwner.task_id,
        activeSelectedRepairs.map((repair) => repair.task_id),
        false,
      );
      for (const repair of activeSelectedRepairs) {
        await ensurePendingTaskPublished(redis, repair);
        await persistTaskFromRedis(redis, repair.task_id);
      }
      repairedTaskIds.push(...activeSelectedRepairs.map((repair) => repair.task_id));
      handledRoots.add(rootTaskId);
      continue;
    }
    if (resolutionOwner.resolution_status === 'needs_pm_decision') {
      const decisionReverify = resolutionOwner.resolution_task_id
        ? await redis.hgetall(keys.hash.task(resolutionOwner.resolution_task_id))
        : {};
      // A source repair may have been accepted after the rejection that originally
      // required it. Reconciliation must then leave source selection and return to
      // independent re-verification. We deliberately pass through the normal retry
      // gate: exhausted roots become `reverify_retry_limit_reached` for one explicit
      // PM continue, rather than silently minting unlimited acceptance attempts.
      const repairDecisionRecovered = resolutionOwner.type === 'acceptance' &&
        acceptanceSourceIds(resolutionOwner).length > 0 &&
        (
          (resolutionOwner.resolution_decision_reason ?? '').startsWith('repair_sources_required:') ||
          (resolutionOwner.resolution_decision_reason ?? '').startsWith('acceptance_repair_required:')
        ) &&
        (await acceptanceReverifyRepairGate(redis, resolutionOwner)).allowed;
      if (repairDecisionRecovered) {
        await mutateTaskWithPlanProjection(redis, resolutionOwner.task_id, resolutionOwner.plan_id ?? '', {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        });
        await persistTaskFromRedis(redis, resolutionOwner.task_id);
        const reverify = await ensureAcceptanceReverifyTask(
          redis,
          resolutionOwner.task_id,
          'startup-reconcile:accepted-repair',
          { trigger: 'repair_accepted' },
        );
        if (reverify.needsPmDecision || !reverify.taskId) {
          needsPmDecisionTaskIds.push(rootTaskId);
        } else if (reverify.created) {
          repairedTaskIds.push(rootTaskId);
        }
        handledRoots.add(rootTaskId);
        continue;
      }
      // 旧版对多来源 acceptance reverify 的 repair reject 曾经 fan-out 所有
      // acceptance_for，随后把先耗尽的无关来源写成根原因。即使根已在
      // needs_pm_decision，也要以当前 pointer 指向的最新不可变 reject 自愈；
      // 不自动选来源，只转换为 PM 可显式处理的决策。
      const latestMultiSourceRepairReject = resolutionOwner.type === 'acceptance' &&
        acceptanceSourceIds(resolutionOwner).length > 1 &&
        decisionReverify.type === 'acceptance' &&
        decisionReverify.status === 'done' &&
        decisionReverify.pm_review_status === 'rejected' &&
        decisionReverify.pm_rejection_resolution_mode !== 'reverify' &&
        decisionReverify.fix_for === resolutionOwner.task_id &&
        decisionReverify.repair_root_task_id === resolutionOwner.task_id;
      if (latestMultiSourceRepairReject) {
        // A source repair selected from this review may itself have been rejected
        // later.  Keep the root pointed at that newest immutable reject; falling
        // back to resolution_task_id would repeatedly dispatch Workers with stale
        // instructions from the older acceptance attempt.
        const latestReject = await latestAcceptanceRepairReject(redis, resolutionOwner);
        await markResolutionNeedsPmDecision(
          redis,
          resolutionOwner.task_id,
          `repair_sources_required:${latestReject?.task_id || decisionReverify.task_id}`,
        );
        needsPmDecisionTaskIds.push(resolutionOwner.task_id);
        handledRoots.add(rootTaskId);
        continue;
      }
      const hasRecoverableRootReverify = isMultiSourceAcceptanceReverifyDecision(resolutionOwner) &&
        isMatchingAcceptanceReverify(
          resolutionOwner,
          decisionReverify,
          acceptanceSourceIds(resolutionOwner),
        ) &&
        (
          ['pending', 'running', 'blocked'].includes(decisionReverify.status) ||
          (decisionReverify.status === 'done' && !decisionReverify.pm_review_status)
        );
      if (hasRecoverableRootReverify) {
        await mutateTaskWithPlanProjection(redis, resolutionOwner.task_id, resolutionOwner.plan_id ?? '', {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_decision_reason: '',
        });
        await ensurePendingTaskPublished(redis, decisionReverify);
        await ensureAcceptanceReadyEvent(redis, resolutionOwner, decisionReverify);
        await persistTaskFromRedis(redis, decisionReverify.task_id);
        await persistTaskFromRedis(redis, resolutionOwner.task_id);
        handledRoots.add(rootTaskId);
        continue;
      }
      await terminalizePendingResolutionChildren(
        redis,
        resolutionOwner,
        [
          ...(resolutionOwner.resolution_task_ids ?? '').split(',').filter(Boolean),
          resolutionOwner.resolution_task_id ?? '',
        ],
        'resolution_waiting_for_pm_decision',
        '根任务正在等待 PM 决策，pending child 已暂停并保留审计',
      );
      handledRoots.add(rootTaskId);
      continue;
    }
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
    // candidate 可能是同一根下较早的 failed/rejected reverify。是否已有当前活跃
    // 复验必须以 resolutionOwner（验收根）的最新指针判断，不能读取这个历史 child
    // 自己为空的 resolution_action；否则历史 child 先被扫描时会绕过这里，把刚由
    // PM continue 创建的 pending reverify 再次取消。
    const activeRootReverify = resolutionOwner.type === 'acceptance' &&
      resolutionOwner.resolution_action === 'reverify' &&
      currentRepair.task_id === resolutionOwner.resolution_task_id &&
      currentRepair.type === 'acceptance' &&
      currentRepair.fix_for === resolutionOwner.task_id &&
      currentRepair.repair_root_task_id === rootTaskId &&
      (
        ['pending', 'running', 'blocked'].includes(currentRepair.status) ||
        (currentRepair.status === 'done' && !currentRepair.pm_review_status)
      );
    if (activeRootReverify) {
      const gate = await acceptanceReverifyRepairGate(redis, resolutionOwner);
      if (!gate.allowed) {
        if (currentRepair.status === 'pending') {
          await terminalizePendingResolutionChildren(
            redis,
            resolutionOwner,
            [currentRepair.task_id],
            'acceptance_repair_required',
            `最新验收决定 ${gate.reviewTaskId} 要求修复，未有后续 accepted repair，已阻止无修复复验`,
          );
        }
        await markAcceptanceFailureResolution(redis, resolutionOwner.task_id, [], true);
        await markResolutionNeedsPmDecision(
          redis,
          rootTaskId,
          acceptanceSourceIds(resolutionOwner).length > 1
            ? `repair_sources_required:${gate.reviewTaskId}`
            : `acceptance_repair_required:${gate.reviewTaskId}`,
        );
        needsPmDecisionTaskIds.push(rootTaskId);
        handledRoots.add(rootTaskId);
        continue;
      }
      await ensurePendingTaskPublished(redis, currentRepair);
      await ensureAcceptanceReadyEvent(redis, resolutionOwner, currentRepair);
      await persistTaskFromRedis(redis, currentRepair.task_id);
      await persistTaskFromRedis(redis, resolutionOwner.task_id);
      handledRoots.add(rootTaskId);
      continue;
    }
    const multiSourceAcceptance = source.type === 'acceptance' &&
      (source.status === 'failed' || (source.status === 'done' && source.pm_review_status === 'rejected')) &&
      source.pm_rejection_resolution_mode !== 'reverify' &&
      acceptanceSourceIds(source).length > 1;
    if (multiSourceAcceptance) {
      handledRoots.add(rootTaskId);
      await cleanupLegacyMultiSourceAcceptanceFanout(redis, source);
      // 先移除所有不属于验收根的旧 lineage/pointer，再写 PM 决策原因。顺序反过来
      // 会让 markResolutionNeedsPmDecision 保留那个外来 pointer。
      await markAcceptanceFailureResolution(redis, source.task_id, [], true);
      const reason = source.status === 'done' && source.pm_review_status === 'rejected'
        ? `repair_sources_required:${source.task_id}`
        : `multi_source_acceptance_failure:${source.task_id}`;
      await markResolutionNeedsPmDecision(redis, rootTaskId, reason);
      needsPmDecisionTaskIds.push(rootTaskId);
      continue;
    }
    let recoveredRepairOwnership: NormalizedRepairOwnership | undefined;
    if (source.status === 'done' && source.pm_review_status === 'rejected') {
      let recovered: { value?: NormalizedRepairOwnership; error?: string } = {};
      if (source.type === 'acceptance') {
        const sourceIds = acceptanceSourceIds(source);
        if (source.pm_rejection_resolution_mode === 'reverify') {
          if (source.pm_repair_ownership_required || source.pm_repair_ownership_intent) {
            recovered = { error: `repair_ownership_intent_forbidden:${source.task_id}` };
          }
        } else if (sourceIds.length !== 1) {
          if (source.pm_repair_ownership_required || source.pm_repair_ownership_intent) {
            recovered = { error: `repair_ownership_intent_source_ambiguous:${source.task_id}` };
          }
        } else {
          const ownershipSource = await redis.hgetall(keys.hash.task(sourceIds[0]));
          const ownershipRootId = ownershipSource.repair_root_task_id || ownershipSource.task_id;
          const ownershipRoot = ownershipRootId === ownershipSource.task_id
            ? ownershipSource
            : await redis.hgetall(keys.hash.task(ownershipRootId));
          recovered = persistedRepairOwnershipIntent(source, ownershipSource, ownershipRoot);
        }
      } else {
        const ownershipRoot = rootTaskId === source.task_id
          ? source
          : await redis.hgetall(keys.hash.task(rootTaskId));
        recovered = persistedRepairOwnershipIntent(source, source, ownershipRoot);
      }
      if (recovered.error) {
        handledRoots.add(rootTaskId);
        await markResolutionNeedsPmDecision(redis, rootTaskId, recovered.error);
        if (source.type === 'acceptance') {
          await markAcceptanceFailureResolution(redis, source.task_id, [], true);
        }
        if (!needsPmDecisionTaskIds.includes(rootTaskId)) needsPmDecisionTaskIds.push(rootTaskId);
        continue;
      }
      recoveredRepairOwnership = recovered.value;
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
        await mutateTaskWithPlanProjection(redis, source.task_id, source.plan_id ?? '', {
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
    if (source.resolution_status && !continuationRequired) {
      // child/root 已写但调度索引或 SQLite 可能停在半发布断点；活跃 child 复用时
      // 幂等补齐，避免 hash-only repair 永久不可领取、dirty 永久不收敛。
      if (currentRepair.task_id && ['pending', 'running', 'blocked'].includes(currentRepair.status)) {
        await ensurePendingTaskPublished(redis, currentRepair);
        await ensureRepairScheduledEvent(
          redis,
          resolutionOwner,
          currentRepair,
          Number(resolutionOwner.resolution_generation ?? 1),
        );
        await persistTaskFromRedis(redis, currentRepair.task_id);
        await persistTaskFromRedis(redis, resolutionOwner.task_id);
        if (source.task_id !== resolutionOwner.task_id) await persistTaskFromRedis(redis, source.task_id);
      }
      continue;
    }
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
          repairOwnership: recoveredRepairOwnership,
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
      repairOwnership: recoveredRepairOwnership,
    });
    if (resolution.state === 'needs_pm_decision') needsPmDecisionTaskIds.push(rootTaskId);
    else if (resolution.repairTaskId) repairedTaskIds.push(rootTaskId);
  }

  // 处理“来源 repair 已在崩溃前 accepted、但 reverify task 尚未落盘”的窗口；
  // 已存在 attempt 时 ensureAcceptanceReverifyTask 会幂等复用。
  const reverifyRecovery = await scheduleReadyAcceptanceReverifications(
    redis,
    'startup-reconcile',
    opts.candidateIds === undefined ? undefined : candidateIds,
  );
  for (const taskId of reverifyRecovery.needsPmDecisionTaskIds) {
    if (!needsPmDecisionTaskIds.includes(taskId)) needsPmDecisionTaskIds.push(taskId);
  }

  return {
    repaired_task_ids: repairedTaskIds,
    needs_pm_decision_task_ids: needsPmDecisionTaskIds,
  };
}

/**
 * PM accepted 已经写入，但进程可能在 lineage / dependency 副作用完成前退出。
 * 该补偿只重放仍被未闭合父任务引用的 accepted repair/reverify，不扫描或改写
 * 已经闭合的历史 attempt；完成标记使重复 accept 与低频 reconcile 都是幂等的。
 */
export async function replayAcceptedRepairSideEffects(
  redis: Redis,
  repairTaskId: string,
  runtimeCandidateIds?: Iterable<string>,
): Promise<{ resolvedTaskIds: string[]; requeuedDependencyIds: string[] }> {
  const repair = await redis.hgetall(keys.hash.task(repairTaskId));
  if (!repair.task_id || repair.status !== 'done' || repair.pm_review_status !== 'accepted') {
    return { resolvedTaskIds: [], requeuedDependencyIds: [] };
  }
  if (repair.pm_accept_effects_applied === 'true') {
    // accepted 后若一个更早 BEGIN 的 continue intent 晚到，根可能再次被投影成
    // repairing。marker=true 不能因此永远跳过闭环重放：沿 fix_for 检查祖先，只在
    // 发现未 resolved 或残留 owner 时重新应用幂等 lineage/dependency 副作用。
    let current = repair;
    let lineageNeedsReplay = false;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const parentId = current.fix_for;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      const parent = await redis.hgetall(keys.hash.task(parentId));
      if (!parent.task_id) break;
      if (
        parent.resolution_status !== 'resolved' ||
        parent.resolution_continue_owner ||
        (parent.resolved_by_task && parent.resolution_task_id !== parent.resolved_by_task)
      ) {
        lineageNeedsReplay = true;
      }
      current = parent;
    }
    if (!lineageNeedsReplay) {
      // Redis 副作用已提交但 SQLite 可能在上一轮失败；只重试 durable marker。
      await persistTaskFromRedis(redis, repairTaskId);
      return { resolvedTaskIds: [], requeuedDependencyIds: [] };
    }
  }

  const requeuedDependencyIds = new Set(
    await wakeDependents(redis, repairTaskId, { allowAcceptance: true }),
  );
  const resolvedTaskIds = await resolveRepairLineage(redis, repairTaskId, runtimeCandidateIds);
  for (const resolvedTaskId of resolvedTaskIds) {
    for (const taskId of await wakeDependents(redis, resolvedTaskId, { allowAcceptance: true })) {
      requeuedDependencyIds.add(taskId);
    }
  }
  if (repair.pm_accept_effects_applied !== 'true') {
    await redis.hset(keys.hash.task(repairTaskId), 'pm_accept_effects_applied', 'true');
  }
  // Redis 是运行态提交点，SQLite 是灾难恢复证据。两者无法跨引擎事务，但此顺序保证
  // 任一中断只会导致下次幂等重放，不会把尚未执行的副作用错误记成已完成。
  try {
    await persistTaskFromRedis(redis, repairTaskId);
  } catch (error) {
    // 保留 Redis marker=true 与 dirty：下轮只重试 SQLite，不重复 dependency/event
    // 副作用；调用方因异常不会执行 candidate 清理。
    await redis.zadd(keys.runtimeReconcile.pending, Date.now(), repairTaskId);
    throw error;
  }
  return { resolvedTaskIds, requeuedDependencyIds: [...requeuedDependencyIds] };
}

async function replayPendingAcceptedRepairSideEffects(
  redis: Redis,
  runtimeCandidateIds?: Iterable<string>,
): Promise<string[]> {
  const candidateIds = runtimeCandidateIds === undefined
    ? [
        ...(await redis.zrange(keys.zset.status.failed, 0, -1)),
        ...(await redis.zrange(keys.zset.status.done, 0, -1)),
      ]
    : [...new Set(runtimeCandidateIds)];
  const repairIds = new Set<string>();
  for (const candidateId of candidateIds) {
    const candidate = await redis.hgetall(keys.hash.task(candidateId));
    if (!candidate.task_id) continue;
    // 当前 PM accept 的 dirty member 就是待重放 task 本身；历史/restore 补偿则从
    // 未闭合根的 resolution_task_id 找到 accepted repair/reverify。
    if (
      candidate.status === 'done' &&
      candidate.pm_review_status === 'accepted' &&
      // marker=true 只证明当时执行过副作用；父/root 可能随后被旧 continue/cancel
      // 覆盖，或保留了指向 rejected attempt 的旧 pointer。repair/reverify 在启动
      // 全量补偿时仍交给 replay 的祖先不变量检查，正常闭环会立即廉价返回。
      (candidate.pm_accept_effects_applied !== 'true' || Boolean(candidate.fix_for))
    ) repairIds.add(candidate.task_id);
    if (
      ['repairing', 'required'].includes(candidate.resolution_status ?? '') &&
      candidate.resolution_task_id
    ) repairIds.add(candidate.resolution_task_id);
    if (
      ['repairing', 'required', 'needs_pm_decision'].includes(candidate.resolution_status ?? '')
    ) {
      const history = (candidate.resolution_task_ids ?? '').split(',').filter(Boolean).reverse();
      for (const taskId of history) {
        const child = await redis.hgetall(keys.hash.task(taskId));
        if (
          child.task_id === taskId &&
          child.repair_root_task_id === candidate.task_id &&
          child.status === 'done' && child.pm_review_status === 'accepted'
        ) {
          repairIds.add(taskId);
          break;
        }
      }
    }
  }
  const requeuedDependencyIds = new Set<string>();
  for (const repairTaskId of repairIds) {
    const replayed = await replayAcceptedRepairSideEffects(redis, repairTaskId, runtimeCandidateIds);
    for (const taskId of replayed.requeuedDependencyIds) requeuedDependencyIds.add(taskId);
  }
  return [...requeuedDependencyIds];
}

/**
 * 启动补偿也会创建 repair/reverify 并双写 SQLite，因此直接调用必须与 HTTP writer
 * 使用同一跨进程门控。restore 内部已持有独占 owner，只调用上面的 unlocked 版本。
 */
export async function reconcileResolutionBacklog(redis: Redis): Promise<ResolutionReconciliation> {
  return withMutationPermitOrThrow(redis, async () => {
    // 显式 startup/restore 入口总是安全合并一次历史候选；常态 Supervisor 使用 marker
    // 后只读 dirty zset，不会重复承担全量扫描成本。
    const runtimeCandidateIds = await ensureRuntimeReconcileBackfill(redis, true);
    const result = await reconcileResolutionBacklogUnlocked(redis);
    // 显式 startup/restore reconcile 还要检查已经 needs_pm_decision、但历史 lineage
    // 里其实已有 accepted winner 的根；这类根按常态 dirty 规则已不再是候选。
    await replayPendingAcceptedRepairSideEffects(redis);
    for (const taskId of runtimeCandidateIds) await cleanRuntimeReconcileCandidate(redis, taskId);
    return result;
  });
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
    await mutateTaskWithPlanProjection(redis, parentId, parent.plan_id ?? '', {
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

function retryLimitRepairSourceId(reason: string): string | undefined {
  const prefix = 'repair_retry_limit_reached:';
  if (!reason.startsWith(prefix)) return undefined;
  return reason.slice(prefix.length).trim() || undefined;
}

function selectedRepairDecision(reason: string): { reviewTaskId: string; sourceIds: string[] } | undefined {
  const prefix = 'repair_sources_selected:';
  if (!reason.startsWith(prefix)) return undefined;
  const [reviewTaskId = '', selected = ''] = reason.slice(prefix.length).split(':', 2);
  const sourceIds = [...new Set(selected.split(',').map((id) => id.trim()).filter(Boolean))];
  if (!reviewTaskId.trim() || sourceIds.length === 0) return undefined;
  return { reviewTaskId: reviewTaskId.trim(), sourceIds };
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

type ReverifyRepairGate = { allowed: true } | { allowed: false; reviewTaskId: string };

async function latestAcceptanceRepairReject(
  redis: Redis,
  root: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const attemptIds = [...new Set([
    root.task_id,
    ...(root.resolution_task_ids ?? '').split(',').filter(Boolean),
    // PM 显式选出的来源 repair 也是这条 acceptance 决策链的一部分。它被拒绝后，
    // 下一代 Worker 必须拿到这条更新的拒绝原文，不能继续收到更早的 reverify。
    ...(root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean),
  ])];
  const sources = new Set(acceptanceSourceIds(root));
  let latest: Record<string, string> | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const attemptId of attemptIds) {
    const attempt = attemptId === root.task_id ? root : await redis.hgetall(keys.hash.task(attemptId));
    const rejectedAcceptance = attempt.type === 'acceptance' &&
      attempt.pm_rejection_resolution_mode !== 'reverify';
    const rejectedSelectedRepair = attempt.type !== 'acceptance' &&
      attempt.repair_root_task_id && sources.has(attempt.fix_for ?? '');
    // A selected source repair may finish after another sibling has already been
    // accepted and closed that source root.  A later reject of that stale delivery
    // is immutable audit evidence, but it is no longer an adverse acceptance
    // decision: treating it as one would reopen the parent acceptance forever.
    if (rejectedSelectedRepair) {
      const sourceRoot = await redis.hgetall(keys.hash.task(attempt.repair_root_task_id));
      if (
        sourceRoot.task_id === attempt.repair_root_task_id &&
        sourceRoot.resolution_status === 'resolved' &&
        sourceRoot.resolved_by_task && sourceRoot.resolved_by_task !== attempt.task_id
      ) {
        const winner = await redis.hgetall(keys.hash.task(sourceRoot.resolved_by_task));
        if (
          winner.task_id === sourceRoot.resolved_by_task &&
          winner.repair_root_task_id === sourceRoot.task_id &&
          winner.status === 'done' && winner.pm_review_status === 'accepted' &&
          !(await repairWasTriggeredAfterWinner(redis, attempt, winner))
        ) continue;
      }
    }
    const requiresRepair = attempt.status === 'done' &&
      attempt.pm_review_status === 'rejected' &&
      (rejectedAcceptance || rejectedSelectedRepair);
    if (!requiresRepair) continue;
    const at = Number(attempt.pm_reviewed_at || attempt.done_at || attempt.created_at || 0);
    if (latest && at < latestAt) continue;
    latest = attempt;
    latestAt = at;
  }
  return latest;
}

/** 多代验收历史里，repair_sources_required 必须始终指向最新不可变 repair reject。 */
async function normalizeRepairSourcesDecisionReason(
  redis: Redis,
  root: Record<string, string>,
): Promise<Record<string, string>> {
  if (
    root.type !== 'acceptance' ||
    acceptanceSourceIds(root).length <= 1 ||
    !(root.resolution_decision_reason ?? '').startsWith('repair_sources_required:')
  ) return root;
  const latestReject = await latestAcceptanceRepairReject(redis, root);
  if (!latestReject?.task_id) return root;
  const expected = `repair_sources_required:${latestReject.task_id}`;
  if (root.resolution_decision_reason === expected) return root;
  await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', {
    resolution_decision_reason: expected,
  });
  await persistTaskFromRedis(redis, root.task_id);
  return redis.hgetall(keys.hash.task(root.task_id));
}

/**
 * 返回由最新不可变 repair reject 显式选出的活跃来源修复。
 *
 * 旧运行实例在引入 trigger_review_task_id 前已经创建的显式 continue repair，
 * 只在“位于 acceptance 审计列表、创建晚于该 reject、goal 明确记录显式 continue”
 * 三项证据同时成立时补齐 provenance，避免把历史自动 fan-out 误认成 PM 选择。
 */
async function activeSelectedAcceptanceRepairs(
  redis: Redis,
  root: Record<string, string>,
): Promise<Array<Record<string, string>>> {
  if (root.type !== 'acceptance' || acceptanceSourceIds(root).length <= 1) return [];
  const latestReject = await latestAcceptanceRepairReject(redis, root);
  if (!latestReject?.task_id) return [];
  const rejectAt = Number(
    latestReject.pm_reviewed_at || latestReject.done_at || latestReject.created_at || 0,
  );
  const sources = new Set(acceptanceSourceIds(root));
  const active: Array<Record<string, string>> = [];
  for (const repairId of (root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean)) {
    let repair = await redis.hgetall(keys.hash.task(repairId));
    if (!repair.task_id || !sources.has(repair.fix_for ?? '')) continue;
    if (!repair.trigger_review_task_id) {
      const legacyExplicitSelection = Number(repair.created_at || 0) >= rejectAt &&
        (repair.goal_md ?? '').includes('显式 continue');
      if (legacyExplicitSelection) {
        await mutateTaskWithPlanProjection(redis, repair.task_id, repair.plan_id ?? root.plan_id ?? '', {
          trigger_review_task_id: latestReject.task_id,
        });
        await persistTaskFromRedis(redis, repair.task_id);
        repair = await redis.hgetall(keys.hash.task(repairId));
      }
    }
    if (repair.trigger_review_task_id !== latestReject.task_id) {
      // 旧状态可能让 PM inspect 返回较早的 repair reject，导致新 repair 带着旧
      // trigger id 创建。只在它确实引用同一 acceptance 的不可变 repair reject，且
      // repair 创建时间不早于最新 reject 时视为当前显式选择；保留原 trigger 审计，
      // 不在后台偷偷改写 provenance。
      const staleTrigger = await redis.hgetall(keys.hash.task(repair.trigger_review_task_id));
      const rootAttemptIds = new Set([
        root.task_id,
        ...(root.resolution_task_ids ?? '').split(',').filter(Boolean),
      ]);
      const staleExplicitSelection = rootAttemptIds.has(staleTrigger.task_id) &&
        staleTrigger.type === 'acceptance' &&
        staleTrigger.status === 'done' &&
        staleTrigger.pm_review_status === 'rejected' &&
        staleTrigger.pm_rejection_resolution_mode !== 'reverify' &&
        Number(repair.created_at || 0) >= rejectAt;
      if (!staleExplicitSelection) continue;
    }
    if (
      ['pending', 'running', 'blocked'].includes(repair.status) ||
      (repair.status === 'done' && !repair.pm_review_status)
    ) active.push(repair);
  }
  return active;
}

async function latestAcceptanceAdverseAttempt(
  redis: Redis,
  root: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  const attemptIds = [...new Set([
    root.task_id,
    ...(root.resolution_task_ids ?? '').split(',').filter(Boolean),
  ])];
  let latest: Record<string, string> | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const attemptId of attemptIds) {
    const attempt = attemptId === root.task_id ? root : await redis.hgetall(keys.hash.task(attemptId));
    if (attempt.type !== 'acceptance') continue;
    const adverse = attempt.status === 'failed' ||
      (attempt.status === 'done' && attempt.pm_review_status === 'rejected');
    if (!adverse) continue;
    const at = Number(attempt.pm_reviewed_at || attempt.done_at || attempt.created_at || 0);
    if (latest && at < latestAt) continue;
    latest = attempt;
    latestAt = at;
  }
  return latest;
}

/**
 * 复验拒绝/失败若明确要求 repair，只有该决定之后的 accepted repair
 * 才能重新打开 reverify。历史上更早的 accepted repair 不能覆盖新拒绝。
 * 新数据后续可用显式 trigger id 加强归因；本门禁也能对现有数据按不可变
 * review/done 时间 fail-closed，防止 generic continue 把 repair 偷换成无修复复验。
 */
async function acceptanceReverifyRepairGate(
  redis: Redis,
  root: Record<string, string>,
): Promise<ReverifyRepairGate> {
  // Worker failed 不能覆盖之前 PM 的 repair 裁决。否则只要再让一个复验
  // 因 ownership/网络/脚本失败，就会把“先修来源”偷换为“继续复验”。
  // 因此门禁追踪最新不可变 repair reject，直到它之后真的出现 accepted repair。
  const latestAdverse = await latestAcceptanceRepairReject(redis, root);
  if (!latestAdverse) return { allowed: true };
  const adverseAt = Number(
    latestAdverse.pm_reviewed_at || latestAdverse.done_at || latestAdverse.created_at || 0,
  );

  for (const repairId of (root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean)) {
    const repair = await redis.hgetall(keys.hash.task(repairId));
    if (repair.status !== 'done' || repair.pm_review_status !== 'accepted') continue;
    const acceptedAt = Number(repair.pm_reviewed_at || repair.done_at || 0);
    if (acceptedAt > adverseAt) return { allowed: true };
  }
  return { allowed: false, reviewTaskId: latestAdverse.task_id };
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
      if (isActiveReverify) {
        const gate = await acceptanceReverifyRepairGate(redis, root);
        // 不中断已经开始或已交付的现场；未领取的错误复验可安全撤销，
        // 并把根任务收敛回真正的 repair 决策。
        if (!gate.allowed && current.status === 'pending') {
          if ((await activeSelectedAcceptanceRepairs(redis, root)).length > 0) {
            return { created: false };
          }
          await terminalizePendingResolutionChildren(
            redis,
            root,
            [current.task_id],
            'acceptance_repair_required',
            `最新验收决定 ${gate.reviewTaskId} 要求修复，未有后续 accepted repair，已阻止无修复复验`,
          );
          await markResolutionNeedsPmDecision(
            redis,
            root.task_id,
            `acceptance_repair_required:${gate.reviewTaskId}`,
          );
          return { created: false, needsPmDecision: true };
        }
        await ensurePendingTaskPublished(redis, current);
        await ensureAcceptanceReadyEvent(redis, root, current);
        await persistTaskFromRedis(redis, current.task_id);
        await persistTaskFromRedis(redis, root.task_id);
        return { taskId: current.task_id, created: false };
      }
    }
  }

  const repairGate = await acceptanceReverifyRepairGate(redis, root);
  if (!repairGate.allowed) {
    // 最新拒绝要求先修来源，而 PM 已显式选定的来源 repair 仍在执行。此时
    // “尚不能复验”是正常中间态，不是新的 PM 异常决策。
    if ((await activeSelectedAcceptanceRepairs(redis, root)).length > 0) {
      return { created: false };
    }
    await markResolutionNeedsPmDecision(
      redis,
      root.task_id,
      `acceptance_repair_required:${repairGate.reviewTaskId}`,
    );
    return { created: false, needsPmDecision: true };
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
    await ensurePendingTaskPublished(redis, existing);
    const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
    await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', {
      resolution_status: 'required',
      resolution_action: 'reverify',
      resolution_task_id: reverifyTaskId,
      // Child HSET may have succeeded immediately before a process crash. Adopting
      // that deterministic child must also repair the durable reviewer-exclusion
      // lineage; the pointer alone is insufficient for later reverify attempts.
      resolution_task_ids: [...new Set([...history, reverifyTaskId])].join(','),
      resolution_generation: String(generation),
      resolution_attempts: String(Math.max(Number(root.resolution_attempts ?? 0), generation)),
      resolved_by_task: '',
      resolution_decision_reason: '',
    });
    if (Number(existing.resolution_generation ?? 0) !== generation) {
      await mutateTaskWithPlanProjection(redis, existing.task_id, existing.plan_id ?? root.plan_id ?? '', {
        resolution_generation: String(generation),
      });
    }
    await ensureAcceptanceReadyEvent(redis, root, existing);
    await persistTaskFromRedis(redis, existing.task_id);
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
  const reverifyAssignee = await inheritedResolutionAssignee(redis, root, root);
  const triggerReview = await latestAcceptanceAdverseAttempt(redis, root);
  const triggerReviewId = triggerReview?.task_id ?? root.task_id;
  const triggerReviewEvidence = triggerReview
    ? `\n\n## 本轮必须处理的最新不可变验收记录\n\n- review task: \`${triggerReviewId}\`\n- mode: \`${triggerReview.pm_rejection_resolution_mode || (triggerReview.status === 'failed' ? 'worker_failed' : 'repair')}\`\n- reject reason: ${triggerReview.pm_reject_reason || triggerReview.failed_reason || '未记录'}\n- PM comment: ${triggerReview.pm_review_comment || '未记录'}\n- fix instructions: ${triggerReview.pm_fix_instructions || '未记录'}\n\n不得用更早的验收记录或自行推测的拒绝原因替代上述记录。`
    : '';
  const reverifyCreateOutcome = await mutateTaskWithPlanProjection(redis, reverifyTaskId, root.plan_id ?? '', {
    task_id: reverifyTaskId,
    plan_id: root.plan_id ?? '',
    title: `独立复验：${root.title ?? root.task_id}`,
    type: 'acceptance',
    phase: root.phase ?? 'acceptance',
    // 复验同样继承验收根的执行器类型/Agent 亲和；独立性仍由 claim 阶段的
    // acceptanceReviewerConflictTask 以 agent_id 强制，不能因为继承亲和而自验收。
    assignee: reverifyAssignee,
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
      ? `# 独立复验：${root.title ?? root.task_id}\n\nPM 已明确判定来源实现无需修复，本次拒绝仅针对验收证据或报告。请重新执行原验收要求，读取最新触发 review 的拒绝原因，并提交新的 result.md、result.json 和 verify_results。不得修改来源实现，不得覆盖或复用原验收结果；复验交付仍需 PM Review accept。\n\n触发复验的 PM 决策：\`${resolvedByTaskId}\`${triggerReviewEvidence}`
      : `# 独立复验：${root.title ?? root.task_id}\n\n来源任务的修复已由 PM 接受。请重新执行原验收要求，读取最新触发 review 的拒绝原因与修复证据，并提交新的 result.md、result.json 和 verify_results。不得覆盖或复用原验收结果；复验交付仍需 PM Review accept。\n\n触发复验的已验收 repair：\`${resolvedByTaskId}\`${triggerReviewEvidence}`,
    trigger_review_task_id: triggerReviewId,
    repair_ownership_extension: '',
    project_path: root.project_path ?? '',
    created_at: String(now),
    fix_for: root.task_id,
    repair_root_task_id: root.task_id,
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    acceptance_repair_task_ids: '',
    resolved_by_task: '',
    resolution_generation: String(generation),
    resolution_attempts: '0',
  }, 'create');
  if (reverifyCreateOutcome === 'TASK_EXISTS') {
    return ensureAcceptanceReverifyTask(redis, acceptanceRootTaskId, resolvedByTaskId, options);
  }
  await ensurePendingTaskPublished(redis, await redis.hgetall(keys.hash.task(reverifyTaskId)));

  const history = (root.resolution_task_ids ?? '').split(',').filter(Boolean);
  await mutateTaskWithPlanProjection(redis, root.task_id, root.plan_id ?? '', {
    resolution_status: 'required',
    resolution_action: 'reverify',
    resolution_task_id: reverifyTaskId,
    resolution_task_ids: [...new Set([...history, reverifyTaskId])].join(','),
    resolved_by_task: '',
    resolution_generation: String(generation),
    resolution_attempts: String(Math.max(Number(root.resolution_attempts ?? 0), generation)),
    resolution_decision_reason: '',
  });
  await ensureAcceptanceReadyEvent(
    redis,
    root,
    await redis.hgetall(keys.hash.task(reverifyTaskId)),
  );
  await persistTaskFromRedis(redis, reverifyTaskId);
  await persistTaskFromRedis(redis, root.task_id);
  return { taskId: reverifyTaskId, created: true };
}

/**
 * 返回会与当前 acceptance 形成自验收冲突的历史任务。
 *
 * 普通 acceptance 只需排除 acceptance_for 的实现者；reverify 还必须排除原验收者、
 * 本轮/历轮 repair 执行者和最近一次真实 reverify 执行者。更早的独立复验者允许
 * 轮换回来，否则有限的静态 Worker 池会随 generation 增长被永久耗尽。
 */
async function acceptanceReviewerConflictTask(
  redis: Redis,
  task: TaskRecord,
  agentId: string,
): Promise<string | undefined> {
  if (task.type !== 'acceptance') return undefined;

  const independentFrom = new Set(task.acceptance_for ?? []);
  if (task.repair_root_task_id) {
    const root = await redis.hgetall(keys.hash.task(task.repair_root_task_id));
    for (const taskId of (root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean)) {
      independentFrom.add(taskId);
    }
    const priorResolutionIds = (root.resolution_task_ids ?? '')
      .split(',')
      .filter((taskId) => taskId && taskId !== task.task_id)
      .reverse();
    let priorReviewerFound = false;
    for (const taskId of priorResolutionIds) {
      if (await redis.hget(keys.hash.task(taskId), 'claimed_by')) {
        independentFrom.add(taskId);
        priorReviewerFound = true;
        break;
      }
    }
    // 第一代 reverify 必须与原验收者不同；之后只排除最近一次真实 reverify，允许
    // 两个独立验收槽位轮换。永久排除原验收者会让有限静态池在第二代后耗尽。
    if (!priorReviewerFound) independentFrom.add(task.repair_root_task_id);
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
  runtimeCandidateIds?: Iterable<string>,
): Promise<{ createdTaskIds: string[]; needsPmDecisionTaskIds: string[] }> {
  const candidateIds = runtimeCandidateIds === undefined
    ? [
        ...(await redis.zrange(keys.zset.status.failed, 0, -1)),
        ...(await redis.zrange(keys.zset.status.done, 0, -1)),
      ]
    : [...new Set(runtimeCandidateIds)];
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

  const acceptedRoot = root.status === 'done' && root.pm_review_status === 'accepted';
  if (acceptedRoot || ['resolved', 'cancelled'].includes(root.resolution_status ?? '')) return;

  // acceptance 根的 lineage 只能包含自己的 reverify/repair child。来源任务的
  // repair 属于各自的 root，把它们混入会导致重复 reconcile 无限计数。
  const ownsRoot = async (taskId: string): Promise<boolean> => {
    const child = await redis.hgetall(keys.hash.task(taskId));
    return child.task_id === taskId && child.repair_root_task_id === rootTaskId;
  };
  const rootHistory: string[] = [];
  for (const taskId of (root.resolution_task_ids ?? '').split(',').filter(Boolean)) {
    if (await ownsRoot(taskId)) rootHistory.push(taskId);
  }
  const ownedRepairTaskIds: string[] = [];
  for (const taskId of uniqueRepairTaskIds) {
    if (await ownsRoot(taskId)) ownedRepairTaskIds.push(taskId);
  }
  // 耗尽时没有新 repair id，不能因此清空指向末次失败 reverify 的指针。
  // 这个指针是 inspect/continue 必须的最短证据链。
  const currentPointerOwned = root.resolution_task_id && await ownsRoot(root.resolution_task_id)
    ? root.resolution_task_id
    : '';
  const latestTaskId = ownedRepairTaskIds.at(-1) || currentPointerOwned || rootHistory.at(-1) || '';
  await mutateTaskWithPlanProjection(redis, rootTaskId, root.plan_id ?? '', {
    resolution_status: needsPmDecision ? 'needs_pm_decision' : 'repairing',
    resolution_action: needsPmDecision ? 'inspect' : 'reverify',
    resolution_decision_reason: needsPmDecision ? (root.resolution_decision_reason ?? '') : '',
    resolution_task_id: latestTaskId,
    resolution_task_ids: [...new Set([...rootHistory, ...ownedRepairTaskIds])].join(','),
    resolved_by_task: '',
    // 来源 repair 不属于 acceptance 根 lineage，但仍必须单独保留，供独立性
    // 门控排除刚完成修复的 Worker。
    acceptance_repair_task_ids: [...new Set([
      ...(root.acceptance_repair_task_ids ?? '').split(',').filter(Boolean),
      ...uniqueRepairTaskIds,
    ])].join(','),
    resolution_generation: root.resolution_generation ?? '0',
    // acceptance 的尝试次数只由自身 reverify generation 推进；复用来源
    // repair 不是新的 acceptance attempt。
    resolution_attempts: String(Math.max(0, Number(root.resolution_generation ?? 0))),
  });
  await persistTaskFromRedis(redis, rootTaskId);

  // reverify attempt 是不可变的验收证据：它保持 failed/rejected 与原 result，
  // 后续修复与 PM 决策只写原 acceptance 根。原始 acceptance 则本身就是根，
  // 上面的一次写入已完成其闭环状态更新。
}

/** 已验收 repair 向上收敛其整个 fix 链；原 failed/rejected 历史保持不变。 */
async function resolveRepairLineage(
  redis: Redis,
  repairTaskId: string,
  runtimeCandidateIds?: Iterable<string>,
): Promise<string[]> {
  const resolved: string[] = [];
  const winner = await redis.hgetall(keys.hash.task(repairTaskId));
  const root = winner.repair_root_task_id
    ? await redis.hgetall(keys.hash.task(winner.repair_root_task_id))
    : {};
  if (root.task_id) {
    const supersededChildIds: string[] = [];
    for (const taskId of (root.resolution_task_ids ?? '').split(',').filter(Boolean)) {
      if (!taskId || taskId === repairTaskId) continue;
      const child = await redis.hgetall(keys.hash.task(taskId));
      if (!(await repairWasTriggeredAfterWinner(redis, child, winner))) {
        supersededChildIds.push(taskId);
      }
    }
    await terminalizePendingResolutionChildren(
      redis,
      root,
      supersededChildIds,
      `superseded_by_accepted_repair:${repairTaskId}`,
      `修复 ${repairTaskId} 已验收，其它未启动 sibling 自动撤销`,
    );
  }
  let childId = repairTaskId;
  for (let depth = 0; depth < 32; depth++) {
    const child = await redis.hgetall(keys.hash.task(childId));
    const parentId = child.fix_for;
    if (!parentId) break;
    const parent = await redis.hgetall(keys.hash.task(parentId));
    if (!parent.task_id) break;
    const isAcceptanceReverify = child.type === 'acceptance' && child.repair_root_task_id === parentId;
    await mutateTaskWithPlanProjection(redis, parentId, parent.plan_id ?? '', {
      resolution_status: 'resolved',
      resolution_action: isAcceptanceReverify ? 'reverify' : 'repair',
      // current pointer 与 resolved_by 必须共同指向最终被接受的 winner；若保留
      // 直接 child，会在多代 repair 链里把 UI/CLI 指回早先 rejected attempt。
      resolution_task_id: repairTaskId,
      resolved_by_task: repairTaskId,
      resolution_decision_reason: '',
      // accepted 是不可逆发布边界。若它与一次已 BEGIN、尚未完成审计的 continue
      // 竞态，闭环必须同时撤销该 intent，避免 reconcile 随后再生孤儿 repair。
      resolution_continue_owner: '',
      resolution_continue_snapshot_generation: '',
      resolution_continue_snapshot_repair_root: '',
      resolution_continue_snapshot_reason: '',
      resolution_continue_snapshot_task_ids: '',
      resolution_continue_snapshot_attempts: '',
      resolution_continue_snapshot_acceptance_repair_task_ids: '',
    });
    await persistTaskFromRedis(redis, parentId);
    resolved.push(parentId);
    childId = parentId;
  }
  await scheduleReadyAcceptanceReverifications(redis, repairTaskId, runtimeCandidateIds);
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
  const resolutionRootIds = new Set<string>();
  for (const taskId of reclaimedTaskIds) {
    await persistTaskFromRedis(redis, taskId);
    const reclaimed = await redis.hgetall(keys.hash.task(taskId));
    // running repair 在旧执行器退出后会先由 lease CAS 回到 pending。必须在任何
    // Worker 再次扫描 pending 之前重放它所属根的闭环：若根已由另一 accepted
    // repair 收敛，既有 sibling 清理会把这个失效 child 终态化为 cancelled；若根
    // 仍在 repairing，则保持 pending，允许 fresh claim。这样不打断活 Worker，也
    // 不会在 Supervisor 重启窗口复活已被赢家取代的重复 repair。
    if (reclaimed.fix_for) {
      resolutionRootIds.add(reclaimed.repair_root_task_id || reclaimed.fix_for);
      await terminalizeSupersededPendingRepair(redis, reclaimed);
    }
    if (reclaimed.status !== 'failed') continue;
    failedTaskIds.push(taskId);
    await ensureRepairTask(redis, taskId, {
      source: 'worker_failed',
      reason: reclaimed.failed_reason === 'max_retries_exceeded'
        ? 'Worker 租约多次过期，已达到任务重试上限。'
        : 'Worker 租约过期后的回收失败。',
    });
  }
  if (resolutionRootIds.size > 0) {
    await reconcileResolutionBacklogUnlocked(redis, {
      migrateLegacyNamedFixes: false,
      candidateIds: resolutionRootIds,
    });
  }
  return failedTaskIds;
}

/**
 * 把两类可安全回收的 running task 暴露给统一 lazyReclaim CAS：lease 已消失，或
 * lease 尚在但 claimed Agent 的当前注册已不再指向该任务。后者说明旧执行器已经
 * 被 registration epoch fencing，无法合法 renew/report，不需要等待长 lease 到期。
 */
async function exposeRecoverableRunningTasks(
  redis: Redis,
  now: number,
): Promise<Map<string, Record<string, string>>> {
  const exposedSnapshots = new Map<string, Record<string, string>>();
  for (const taskId of await redis.zrange(keys.zset.status.running, 0, -1)) {
    const task = await redis.hgetall(keys.hash.task(taskId));
    if (task.status !== 'running') continue;
    const agentKey = keys.hash.agent(task.claimed_by || '__missing__');
    const exposed = Number(await redis.eval(
      `local task_status = redis.call('HGET', KEYS[2], 'status') or ''
       if task_status ~= 'running' then return 0 end
       local lease_exists = redis.call('GET', KEYS[1]) ~= false
       local claimed_by = redis.call('HGET', KEYS[2], 'claimed_by') or ''
       local agent_id = redis.call('HGET', KEYS[4], 'agent_id') or ''
       local agent_task = redis.call('HGET', KEYS[4], 'current_task') or ''
       local agent_status = redis.call('HGET', KEYS[4], 'status') or ''
       local orphaned = lease_exists and
         (claimed_by == '' or agent_id == '' or agent_task ~= ARGV[1] or agent_status == 'offline')
       if (not lease_exists) or orphaned then
         if orphaned then redis.call('DEL', KEYS[1]) end
         redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
         return 1
       end
       return 0`,
      4,
      keys.string.lease(taskId),
      keys.hash.task(taskId),
      keys.zset.status.running,
      agentKey,
      taskId,
      String(now),
    ));
    if (exposed === 1) exposedSnapshots.set(taskId, task);
  }
  return exposedSnapshots;
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
  await backfillLegacyCancelledAudit(redis);
  // marker 缺失时（升级/restore）安全回建一次；此后常规轮次只处理当前 dirty 候选，
  // 不再对全部历史 done/failed 做三次扫描。
  const runtimeCandidateIds = await ensureRuntimeReconcileBackfill(redis);
  await reconcileResolutionBacklogUnlocked(redis, {
    migrateLegacyNamedFixes: false,
    candidateIds: runtimeCandidateIds,
  });
  const replayedDependencies = await replayPendingAcceptedRepairSideEffects(redis, runtimeCandidateIds);
  await exposeRecoverableRunningTasks(redis, Date.now());
  const reclaimed = await lazyReclaimTaskIds(redis);
  const failed = await finalizeReclaimedTasks(redis, reclaimed);
  const requeued = await reconcileBlockedWaiters(redis);
  requeued.waiting_dependency = [
    ...new Set([...replayedDependencies, ...requeued.waiting_dependency]),
  ];

  // lazy reclaim 可能在本轮新增 failed dirty；与初始快照一起按最新 task 状态原子清理。
  // 新异常若与清理并发，其事务会在清理前被状态谓词保留，或在清理后重新 ZADD。
  for (const taskId of new Set([...runtimeCandidateIds, ...failed])) {
    await cleanRuntimeReconcileCandidate(redis, taskId);
  }
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

const CLAIM_WITH_AGENT_EPOCH = `
local registration_id = ARGV[1]
local task_id = ARGV[2]
local claim_token = ARGV[3]
local now = ARGV[4]
local expire_at = ARGV[5]
local agent_id = ARGV[6]
local plan_id = ARGV[7]
local claim_request_id = ARGV[8]
local claim_attempt_id = ARGV[9]
local lease_ttl_ms = ARGV[10]

if (redis.call('HGET', KEYS[12], 'request_id') or '') ~= claim_request_id or
   (redis.call('HGET', KEYS[12], 'attempt_id') or '') ~= claim_attempt_id or
   (redis.call('HGET', KEYS[12], 'status') or '') ~= 'active' then
  return {'CLAIM_RESERVATION_LOST'}
end
if (redis.call('HGET', KEYS[5], 'agent_id') or '') == '' then return {'AGENT_NOT_REGISTERED'} end
if (redis.call('HGET', KEYS[5], 'registration_id') or '') ~= registration_id then
  return {'AGENT_REGISTRATION_CHANGED'}
end
if (redis.call('HGET', KEYS[5], 'status') or '') == 'offline' then return {'AGENT_ALREADY_OFFLINE'} end
local current_task = redis.call('HGET', KEYS[5], 'current_task') or ''
if current_task ~= '' then return {'AGENT_BUSY', current_task} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id then return {'TASK_NOT_FOUND'} end
if (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id then return {'TASK_CHANGED'} end
if (redis.call('HGET', KEYS[1], 'status') or '') ~= 'pending' then return {'TASK_NOT_PENDING'} end
if not redis.call('ZSCORE', KEYS[3], task_id) then return {'TASK_NOT_PENDING'} end
if not redis.call('SET', KEYS[2], claim_token, 'PX', lease_ttl_ms, 'NX') then return {'LEASE_CHANGED'} end

redis.call('ZREM', KEYS[3], task_id)
redis.call('ZADD', KEYS[4], tonumber(expire_at), task_id)
redis.call('HSET', KEYS[1],
  'status', 'running',
  'claimed_at', now,
  'claimed_by', agent_id,
  'expire_at', expire_at,
  -- pending -> running 是新交付轮次；任何旧/损坏的 review 字段必须在同一 claim
  -- CAS 内清空，不能等 report 后才消除“运行中但已 accepted”的矛盾状态。
  'pm_review_status', '',
  'pm_reviewed_by', '',
  'pm_reviewed_at', '',
  'pm_review_comment', '',
  'pm_accept_effects_applied', '',
  'pm_reject_reason', '',
  'pm_fix_instructions', '',
  'pm_rejection_resolution_mode', '')
redis.call('HSET', KEYS[5],
  'current_task', task_id,
  'status', 'busy',
  'claim_request_id', claim_request_id,
  'claim_request_task_id', task_id,
  'claim_request_token', claim_token)
-- 旧版本曾在 Agent hash 复制完整 goal/question 正文；新 claim 主动清除该副本。
redis.call('HDEL', KEYS[5], 'claim_request_payload')
redis.call('SADD', KEYS[6], plan_id)
redis.call('SADD', KEYS[7], task_id)
redis.call('HINCRBY', KEYS[8], plan_id, 1)
redis.call('SADD', KEYS[9], plan_id)
redis.call('ZREM', KEYS[10], task_id)
redis.call('XADD', KEYS[11], '*',
  'event_id', now .. '_claim_' .. task_id,
  'type', 'task_claimed',
  'task_id', task_id,
  'agent_id', agent_id,
  'plan_id', plan_id)
redis.call('DEL', KEYS[12])
return {'CLAIMED'}
`;

const REPLAY_AGENT_CLAIM = `
if (redis.call('HGET', KEYS[1], 'agent_id') or '') == '' then return {'AGENT_NOT_REGISTERED'} end
if (redis.call('HGET', KEYS[1], 'registration_id') or '') ~= ARGV[1] then
  return {'AGENT_REGISTRATION_CHANGED'}
end
if (redis.call('HGET', KEYS[1], 'status') or '') == 'offline' then return {'AGENT_ALREADY_OFFLINE'} end
if (redis.call('HGET', KEYS[1], 'claim_request_id') or '') ~= ARGV[2] then return {'NO_REPLAY'} end
local task_id = redis.call('HGET', KEYS[1], 'claim_request_task_id') or ''
local claim_token = redis.call('HGET', KEYS[1], 'claim_request_token') or ''
if task_id == '' or claim_token == '' then return {'NO_REPLAY'} end
if (redis.call('HGET', KEYS[1], 'current_task') or '') ~= task_id then return {'NO_REPLAY'} end
if (redis.call('HGET', KEYS[2], 'task_id') or '') ~= task_id or
   (redis.call('HGET', KEYS[2], 'status') or '') ~= 'running' or
   (redis.call('HGET', KEYS[2], 'claimed_by') or '') ~= ARGV[3] then return {'NO_REPLAY'} end
if (redis.call('GET', KEYS[3]) or '') ~= claim_token then return {'NO_REPLAY'} end
return {'REPLAY', task_id, claim_token}
`;

const CLAIM_RESERVATION_TTL_MS = 3_000;
const DEFAULT_BLOCKING_CLAIM_TIMEOUT_MS = 30_000;
const MAX_BLOCKING_CLAIM_TIMEOUT_MS = 60_000;

const RESERVE_AGENT_CLAIM = `
-- RESERVE_AGENT_CLAIM_TEST_MARKER
if (redis.call('HGET', KEYS[1], 'agent_id') or '') == '' then return {'AGENT_NOT_REGISTERED'} end
if (redis.call('HGET', KEYS[1], 'registration_id') or '') ~= ARGV[1] then
  return {'AGENT_REGISTRATION_CHANGED'}
end
if (redis.call('HGET', KEYS[1], 'status') or '') == 'offline' then return {'AGENT_ALREADY_OFFLINE'} end
local current_task = redis.call('HGET', KEYS[1], 'current_task') or ''
if current_task ~= '' then return {'AGENT_BUSY', current_task} end

local existing_registration = redis.call('HGET', KEYS[2], 'registration_id') or ''
if existing_registration ~= '' and existing_registration ~= ARGV[1] then
  redis.call('DEL', KEYS[2])
end
local existing_request = redis.call('HGET', KEYS[2], 'request_id') or ''
local existing_attempt = redis.call('HGET', KEYS[2], 'attempt_id') or ''
local existing_status = redis.call('HGET', KEYS[2], 'status') or ''
if existing_request == ARGV[2] and existing_status == 'empty' then return {'EMPTY'} end
if existing_request == ARGV[2] and existing_status == 'active' then
  if existing_attempt == ARGV[3] then return {'OWNER'} end
  return {'WAIT'}
end
if existing_request ~= '' and existing_status == 'active' then return {'IN_FLIGHT'} end
redis.call('HSET', KEYS[2],
  'registration_id', ARGV[1],
  'request_id', ARGV[2],
  'attempt_id', ARGV[3],
  'status', 'active')
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]))
return {'OWNER'}
`;

const COMPLETE_EMPTY_AGENT_CLAIM = `
if (redis.call('HGET', KEYS[1], 'request_id') or '') ~= ARGV[1] or
   (redis.call('HGET', KEYS[1], 'attempt_id') or '') ~= ARGV[2] or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= 'active' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'empty')
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

const RENEW_AGENT_CLAIM_RESERVATION = `
-- RENEW_AGENT_CLAIM_RESERVATION_TEST_MARKER
if (redis.call('HGET', KEYS[1], 'registration_id') or '') ~= ARGV[1] or
   (redis.call('HGET', KEYS[1], 'request_id') or '') ~= ARGV[2] or
   (redis.call('HGET', KEYS[1], 'attempt_id') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= 'active' then return 0 end
return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
`;

function startClaimReservationRenewal(
  redis: Redis,
  reservationKey: string,
  registrationId: string,
  claimRequestId: string,
  claimAttemptId: string,
  ttlMs: number,
): { owned: () => boolean; stop: () => Promise<void> } {
  let owned = true;
  let inFlight = Promise.resolve();
  const renew = () => {
    inFlight = inFlight.then(async () => {
      if (!owned) return;
      try {
        const renewed = Number(await redis.eval(
          RENEW_AGENT_CLAIM_RESERVATION,
          1,
          reservationKey,
          registrationId,
          claimRequestId,
          claimAttemptId,
          String(ttlMs),
        ));
        if (renewed !== 1) owned = false;
      } catch {
        // 续租结果未知时 fail closed；最终 Lua 仍会以 attempt token 再 fencing。
        owned = false;
      }
    });
  };
  const timer = setInterval(renew, Math.max(250, Math.floor(ttlMs / 3)));
  timer.unref?.();
  return {
    owned: () => owned,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}

function agentEpochError(
  agentId: string,
  code: 'AGENT_REGISTRATION_REQUIRED' | 'INVALID_REGISTRATION_ID' | 'AGENT_NOT_REGISTERED' |
    'AGENT_REGISTRATION_CHANGED' | 'AGENT_ALREADY_OFFLINE' | 'AGENT_BUSY',
  detail = '',
): { code: string; message: string } {
  const messages = {
    AGENT_REGISTRATION_REQUIRED: 'claim 必须携带 register 返回的 registration_id',
    INVALID_REGISTRATION_ID: 'registration_id 格式无效',
    AGENT_NOT_REGISTERED: `Agent ${agentId} 尚未注册`,
    AGENT_REGISTRATION_CHANGED: `Agent ${agentId} 已换用新会话；旧生命周期不能领取任务。`,
    AGENT_ALREADY_OFFLINE: `Agent ${agentId} 的当前会话已离线，请重新注册。`,
    AGENT_BUSY: `agent ${agentId} 已有 running task ${detail}，完成或 report 后才能领新任务`,
  } as const;
  return { code, message: messages[code] };
}

async function rebuildClaimPayload(redis: Redis, taskId: string, claimToken: string): Promise<ClaimedTask | undefined> {
  const taskHash = await redis.hgetall(keys.hash.task(taskId));
  if (!taskHash.task_id) return undefined;
  const task = hashToTaskRecord(taskHash);
  const questionId = taskHash.last_question_id ?? '';
  const questionAnswer = taskHash.last_question_answer ?? '';
  const questionCheckpoint = questionId
    ? (await redis.hget(keys.hash.question(questionId), 'checkpoint')) ?? ''
    : '';
  return {
    task_id: task.task_id,
    title: task.title,
    type: task.type,
    phase: task.phase,
    priority: task.priority ?? 5,
    ownership_files: task.ownership?.files ?? [],
    ownership_modules: task.ownership?.modules ?? [],
    goal_md: task.goal_md,
    timeout_seconds: task.timeout_seconds ?? 1800,
    claim_token: claimToken,
    verify: task.verify ?? [],
    project_path: task.project_path,
    plan_id: task.plan_id,
    ...(task.model_override?.trim() ? { model_override: task.model_override.trim() } : {}),
    ...(questionAnswer ? { question_answer: questionAnswer } : {}),
    ...(questionId ? { question_id: questionId } : {}),
    ...(questionCheckpoint ? { question_checkpoint: questionCheckpoint } : {}),
  };
}

/** claim（核心，对应 06 号 md 完整流程） */
async function claimUnlocked(
  redis: Redis,
  req: ClaimRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ClaimedTask | null>> {
  if (req.timeout_ms !== undefined &&
      (!Number.isSafeInteger(req.timeout_ms) || req.timeout_ms < 0 || req.timeout_ms > MAX_BLOCKING_CLAIM_TIMEOUT_MS)) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'INVALID_CLAIM_TIMEOUT',
        message: `timeout_ms 必须是 0-${MAX_BLOCKING_CLAIM_TIMEOUT_MS} 的整数`,
      },
    };
  }
  const blockingTimeoutMs = Math.max(1, req.timeout_ms ?? DEFAULT_BLOCKING_CLAIM_TIMEOUT_MS);
  if (signal?.aborted) {
    return { ok: false, data: null, error: { code: 'CLAIM_ABORTED', message: 'claim 等待已由客户端取消' } };
  }
  // 先快速失败，避免旧 epoch 触发回收/候选扫描；真正授权仍在领取 Lua 内
  // 与 task + presence 状态写入同一原子边界二次校验。
  const registeredAgent = await redis.hgetall(keys.hash.agent(req.agent_id));
  if (!registeredAgent.agent_id) {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_NOT_REGISTERED') };
  }
  // 仅供仓库内旧的直接 service 调用过渡：这些调用通过未显式传 ID 的
  // agentRegister 由服务端生成 epoch。HTTP claim schema 仍强制客户端携带，不存在
  // 外部降级路径；显式 client epoch 也绝不允许省略。
  const registrationId = req.registration_id
    ?? (registeredAgent.registration_source === 'server' ? registeredAgent.registration_id : undefined);
  if (!registrationId) {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_REGISTRATION_REQUIRED') };
  }
  if (!AGENT_REGISTRATION_ID_PATTERN.test(registrationId)) {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'INVALID_REGISTRATION_ID') };
  }
  if (!durableAgentEpochIsCurrent(req.agent_id, registrationId)) {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_REGISTRATION_CHANGED') };
  }
  if (registeredAgent.registration_id !== registrationId) {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_REGISTRATION_CHANGED') };
  }
  if (registeredAgent.status === 'offline') {
    return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_ALREADY_OFFLINE') };
  }
  const claimRequestId = req.claim_request_id ?? `internal_${randomUUID().replaceAll('-', '')}`;
  if (!AGENT_REGISTRATION_ID_PATTERN.test(claimRequestId)) {
    return { ok: false, data: null, error: { code: 'INVALID_CLAIM_REQUEST_ID', message: 'claim_request_id 格式无效' } };
  }

  // 先走幂等重放快路，不扫 pending/running，也不触发 lease 回收。
  // 脚本在同一原子读中复核 epoch + task + lease，只重放仍然有效的原 claim。
  const tryReplayClaim = async (): Promise<ApiResponse<ClaimedTask | null> | undefined> => {
    const replayRaw = await withAgentEpochCommit(req.agent_id, async () => {
      if (!durableAgentEpochIsCurrent(req.agent_id, registrationId)) return ['AGENT_REGISTRATION_CHANGED'];
      const latestAgent = await redis.hgetall(keys.hash.agent(req.agent_id));
      const replayTaskId = latestAgent.claim_request_task_id || '__none__';
      return redis.eval(
        REPLAY_AGENT_CLAIM,
        3,
        keys.hash.agent(req.agent_id),
        keys.hash.task(replayTaskId),
        keys.string.lease(replayTaskId),
        registrationId,
        claimRequestId,
        req.agent_id,
      );
    });
    if (Array.isArray(replayRaw) && String(replayRaw[0] ?? '') === 'AGENT_REGISTRATION_CHANGED') {
      return { ok: false, data: null, error: agentEpochError(req.agent_id, 'AGENT_REGISTRATION_CHANGED') };
    }
    if (!Array.isArray(replayRaw) || String(replayRaw[0] ?? '') !== 'REPLAY') return undefined;
    const replayTaskId = String(replayRaw[1] ?? '');
    const replayToken = String(replayRaw[2] ?? '');
    const replayed = replayTaskId && replayToken
      ? await rebuildClaimPayload(redis, replayTaskId, replayToken)
      : undefined;
    if (!replayed) {
      return {
        ok: false,
        data: null,
        error: { code: 'CLAIM_REPLAY_CORRUPT', message: '已提交 claim 的幂等重放索引损坏，拒绝重新领取' },
      };
    }
    return { ok: true, data: replayed };
  };
  const initialReplay = await tryReplayClaim();
  if (initialReplay) return initialReplay;

  // 同一 Agent 的 claim 先取得短 TTL 单飞 reservation。相同 request 的并发重试
  // 等待 owner 提交后走 replay；owner 崩溃则 reservation 自动过期，由重试接管。
  const claimAttemptId = `attempt_${randomUUID().replaceAll('-', '')}`;
  const reservationKey = keys.hash.claimReservation(req.agent_id);
  const reservationTtlMs = Math.max(
    CLAIM_RESERVATION_TTL_MS,
    req.blocking === true ? blockingTimeoutMs + CLAIM_RESERVATION_TTL_MS : 0,
  );
  const reservationDeadline = Date.now() + reservationTtlMs + 750;
  while (true) {
    const replay = await tryReplayClaim();
    if (replay) return replay;
    const reservationMutation = await withMutationPermit(redis, async () => ({
      ok: true,
      data: await withAgentEpochCommit(req.agent_id, async () => {
        if (!durableAgentEpochIsCurrent(req.agent_id, registrationId)) return ['AGENT_REGISTRATION_CHANGED'];
        return redis.eval(
          RESERVE_AGENT_CLAIM,
          2,
          keys.hash.agent(req.agent_id),
          reservationKey,
          registrationId,
          claimRequestId,
          claimAttemptId,
          String(reservationTtlMs),
        );
      }),
    }));
    if (!reservationMutation.ok) {
      return { ok: false, data: null, error: reservationMutation.error };
    }
    const reserved = reservationMutation.data;
    const reservationOutcome = Array.isArray(reserved) ? String(reserved[0] ?? '') : '';
    if (reservationOutcome === 'OWNER') break;
    if (reservationOutcome === 'EMPTY') return { ok: true, data: null };
    if (reservationOutcome === 'AGENT_BUSY') {
      const finalReplay = await tryReplayClaim();
      if (finalReplay) return finalReplay;
    }
    if (['AGENT_NOT_REGISTERED', 'AGENT_REGISTRATION_CHANGED', 'AGENT_ALREADY_OFFLINE', 'AGENT_BUSY'].includes(reservationOutcome)) {
      return {
        ok: false,
        data: null,
        error: agentEpochError(
          req.agent_id,
          reservationOutcome as 'AGENT_NOT_REGISTERED' | 'AGENT_REGISTRATION_CHANGED' | 'AGENT_ALREADY_OFFLINE' | 'AGENT_BUSY',
          String((reserved as unknown[])[1] ?? ''),
        ),
      };
    }
    if (reservationOutcome === 'IN_FLIGHT') {
      return {
        ok: false,
        data: null,
        error: { code: 'AGENT_CLAIM_IN_PROGRESS', message: `Agent ${req.agent_id} 正在处理另一个 claim 请求` },
      };
    }
    if (reservationOutcome !== 'WAIT') throw new Error(`failed to reserve claim: ${reservationOutcome || 'UNKNOWN'}`);
    if (Date.now() >= reservationDeadline) {
      const finalReplay = await tryReplayClaim();
      if (finalReplay) return finalReplay;
      return {
        ok: false,
        data: null,
        error: { code: 'CLAIM_IN_PROGRESS', message: '相同 claim_request_id 仍在提交中，请使用同一 ID 重试' },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const reservationRenewal = startClaimReservationRenewal(
    redis, reservationKey, registrationId, claimRequestId, claimAttemptId, reservationTtlMs,
  );
  let mutationSection: { release: () => Promise<void> } | undefined;
  try {
  const initialSection = await acquireMutationSection(redis);
  if (!initialSection.ok) return { ok: false, data: null, error: initialSection.error };
  mutationSection = initialSection;

  // 先固定当前 stream 游标，再扫调度真相。游标之后、XREAD 之前发布的任务会在
  // XREAD(cursor) 中立即可见；使用 `$` 会把这段窗口内的铃永久跳过。
  const latestTaskEvents = await redis.xrevrange(keys.stream.tasks, '+', '-', 'COUNT', 1);
  const blockingStreamCursor = latestTaskEvents[0]?.[0] ?? '0-0';

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
      // 两个同 request 的 HTTP 请求并发时，第一个可能在本请求的
      // 首次快路之后才提交；在报 busy 前再读一次，同 ID 仍能安全重放。
      const concurrentReplay = await tryReplayClaim();
      if (concurrentReplay) return concurrentReplay;
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

  const agentType = registeredAgent.agent_type ?? '';
  let terminalClaimError: { code: string; message: string } | undefined;

  const tryCandidates = async (): Promise<ClaimedTask | null> => {
    if (!reservationRenewal.owned()) return null;
    // Stream 只做唤醒通道；zset/hash 才是调度真相源，过滤不会消费或丢弃任务。
    const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
    const candidates: TaskRecord[] = [];
    for (const taskId of pendingIds) {
      const hash = await redis.hgetall(keys.hash.task(taskId));
      if (!hash.task_id || hash.status !== 'pending') continue;
      // 防御升级前已经遗留在 pending 的 sibling：即使它没有经过本进程的 lease
      // reclaim，也必须在候选进入调度前按 accepted winner 终态化。
      if (await terminalizeSupersededPendingRepair(redis, hash)) continue;
      candidates.push(hashToTaskRecord(hash));
    }
    candidates.sort(
      (a, b) =>
        (b.priority ?? 5) - (a.priority ?? 5) ||
        (a.created_at ?? 0) - (b.created_at ?? 0) ||
        a.task_id.localeCompare(b.task_id),
    );

    for (const task of candidates) {
      if (!reservationRenewal.owned()) return null;
      const assignee = task.assignee || 'auto';
      if (assignee !== 'auto' && assignee !== req.agent_id && assignee !== agentType) continue;
      if (req.preferred_types?.length && !req.preferred_types.includes(task.type)) continue;
      if (req.preferred_phases?.length && !req.preferred_phases.includes(task.phase)) continue;
      if (req.preferred_project && task.project_path !== req.preferred_project) continue;
      // Supervisor 指定 --plans 时必须在服务端领取前收窄范围；不能先把同项目的
      // 其它 plan 领走再由客户端退回，否则会短暂占有 lease / ownership。
      if (req.preferred_plan_ids?.length && !req.preferred_plan_ids.includes(task.plan_id)) continue;
      if (!(await checkDependencies(redis, task)).ok) continue;
      if (!reservationRenewal.owned()) return null;

      // 领取阶段即阻止普通自验收与 reverify 自验收；后者还要排除 repair/旧验收执行者。
      if (await acceptanceReviewerConflictTask(redis, task, req.agent_id)) continue;

      const claimToken = generateToken();
      const leaseKey = keys.string.lease(task.task_id);
      const timeoutSeconds = task.timeout_seconds ?? 1800;
      const ownershipFiles = task.ownership?.files ?? [];
      if (ownershipFiles.length > 0) {
        const baseSha = await getGitHeadSha(task.project_path).catch(() => '');
        if (!reservationRenewal.owned()) return null;
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
        if (!reservationRenewal.owned()) return null;
      }

      const now = Date.now();
      const expireAt = now + timeoutSeconds * 1000;
      // 问题回答上下文在 task 回到 pending 时已固定。首次响应在内存构造；Redis
      // 只原子保存 task/token/request_id，重放时从 task/question 真相重建，避免在
      // Agent hash 再复制 goal_md 与 Question 正文。
      const taskHashForPayload = await redis.hgetall(keys.hash.task(task.task_id));
      const questionId = taskHashForPayload.last_question_id ?? '';
      const questionAnswer = taskHashForPayload.last_question_answer ?? '';
      const questionCheckpoint = questionId
        ? (await redis.hget(keys.hash.question(questionId), 'checkpoint')) ?? ''
        : '';
      const claimPayload: ClaimedTask = {
        task_id: task.task_id,
        title: task.title,
        type: task.type,
        phase: task.phase,
        priority: task.priority ?? 5,
        ownership_files: ownershipFiles,
        ownership_modules: task.ownership?.modules ?? [],
        goal_md: task.goal_md,
        timeout_seconds: timeoutSeconds,
        claim_token: claimToken,
        verify: task.verify ?? [],
        project_path: task.project_path,
        plan_id: task.plan_id,
        ...(task.model_override?.trim() ? { model_override: task.model_override.trim() } : {}),
        ...(questionAnswer ? { question_answer: questionAnswer } : {}),
        ...(questionId ? { question_id: questionId } : {}),
        ...(questionCheckpoint ? { question_checkpoint: questionCheckpoint } : {}),
      };
      if (!reservationRenewal.owned()) return null;
      const rawClaim = await withAgentEpochCommit(req.agent_id, async () => {
        if (!durableAgentEpochIsCurrent(req.agent_id, registrationId)) return ['AGENT_REGISTRATION_CHANGED'];
        return redis.eval(
        CLAIM_WITH_AGENT_EPOCH,
        12,
        keys.hash.task(task.task_id),
        leaseKey,
        keys.zset.status.pending,
        keys.zset.status.running,
        keys.hash.agent(req.agent_id),
        keys.planStatusProjection.planIds,
        keys.planStatusProjection.taskIdsByPlan(task.plan_id),
        keys.planStatusProjection.revisionByPlan,
        keys.planStatusProjection.dirtyPlans,
        keys.intakeActionableFailed.pending,
        keys.stream.events,
        reservationKey,
        registrationId,
        task.task_id,
        claimToken,
        String(now),
        String(expireAt),
        req.agent_id,
        task.plan_id,
        claimRequestId,
        claimAttemptId,
        String(timeoutSeconds * 1000),
        );
      });
      const claimOutcome = Array.isArray(rawClaim) ? String(rawClaim[0] ?? '') : '';
      if (claimOutcome !== 'CLAIMED') {
        // 领取未提交时，只释放本 request 创建的 lease/所有权；不删别人的新状态。
        // reservation 已丢失表示 TTL takeover 可能已由同一 agent/task 继承 ownership；
        // 旧 attempt 此时不能按 agent/task 粗粒度释放新 owner 的合法占用。
        if (ownershipFiles.length > 0 && claimOutcome !== 'CLAIM_RESERVATION_LOST') {
          await releaseOwnershipByAgent(redis, req.agent_id, task.task_id);
        }
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          leaseKey,
          claimToken,
        );
        if (['AGENT_NOT_REGISTERED', 'AGENT_REGISTRATION_CHANGED', 'AGENT_ALREADY_OFFLINE', 'AGENT_BUSY'].includes(claimOutcome)) {
          terminalClaimError = agentEpochError(
            req.agent_id,
            claimOutcome as 'AGENT_NOT_REGISTERED' | 'AGENT_REGISTRATION_CHANGED' | 'AGENT_ALREADY_OFFLINE' | 'AGENT_BUSY',
            String((rawClaim as unknown[])[1] ?? ''),
          );
          return null;
        }
        // task/lease 已被其它合法转换改变，继续尝试下一候选。
        continue;
      }

      sqliteStore?.updateTaskFields(task.task_id, {
        status: 'running',
        claimed_by: req.agent_id,
        claimed_at: String(now),
        expire_at: String(expireAt),
      });

      return claimPayload;
    }
    return null;
  };

  const immediate = await tryCandidates();
  if (terminalClaimError) return { ok: false, data: null, error: terminalClaimError };
  if (immediate || req.blocking !== true) {
    if (!immediate) {
      // TTL takeover 可能已在旧 owner 扫描期间完成提交；最终一次 replay 防止旧请求
      // 把成功领取误报为空。
      const finalReplay = await tryReplayClaim();
      if (finalReplay) return finalReplay;
      await redis.eval(
        COMPLETE_EMPTY_AGENT_CLAIM, 1, reservationKey,
        claimRequestId, claimAttemptId, String(CLAIM_RESERVATION_TTL_MS),
      );
    }
    return { ok: true, data: immediate };
  }

  // 退出短 mutation section 前把 reservation 刷到完整的、有上限的等待 TTL；
  // 随后停止续租，确保纯等待阶段没有后台 writer。
  if (!reservationRenewal.owned()) {
    return { ok: false, data: null, error: { code: 'CLAIM_RESERVATION_LOST', message: 'claim reservation 已失效' } };
  }
  const reservationRefreshed = Number(await redis.eval(
    RENEW_AGENT_CLAIM_RESERVATION,
    1,
    reservationKey,
    registrationId,
    claimRequestId,
    claimAttemptId,
    String(reservationTtlMs),
  ));
  if (reservationRefreshed !== 1) {
    return { ok: false, data: null, error: { code: 'CLAIM_RESERVATION_LOST', message: 'claim reservation 已失效' } };
  }
  await reservationRenewal.stop();
  await mutationSection.release();
  mutationSection = undefined;

  // XREAD BLOCK 会冻结一条 Redis FIFO 连接。只把有界等待放到一次性连接上；
  // claim/epoch/lease/empty completion 等控制面读写始终留在主连接。
  const blockingWaiter = redis.duplicate();
  let waiterDisconnected = false;
  let aborted = signal?.aborted === true;
  const disconnectWaiter = () => {
    if (waiterDisconnected) return;
    waiterDisconnected = true;
    blockingWaiter.disconnect();
  };
  const abortWaiter = () => {
    aborted = true;
    disconnectWaiter();
  };
  signal?.addEventListener('abort', abortWaiter, { once: true });
  try {
    if (!aborted) {
      try {
        await blockingWaiter.xread(
          'COUNT',
          1,
          'BLOCK',
          blockingTimeoutMs,
          'STREAMS',
          keys.stream.tasks,
          blockingStreamCursor,
        );
      } catch (error) {
        if (!aborted) throw error;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abortWaiter);
    disconnectWaiter();
  }
  if (aborted) {
    // waiter 已释放后，在新的短 permit 中结束本次 reservation，避免断线客户端让
    // 同 Agent 的下一次 claim 被一个最长 63 秒的幽灵 IN_FLIGHT 卡住。
    const abortCleanupSection = await acquireMutationSection(redis);
    if (abortCleanupSection.ok) {
      mutationSection = abortCleanupSection;
      await redis.eval(
        COMPLETE_EMPTY_AGENT_CLAIM,
        1,
        reservationKey,
        claimRequestId,
        claimAttemptId,
        String(CLAIM_RESERVATION_TTL_MS),
      );
    }
    return { ok: false, data: null, error: { code: 'CLAIM_ABORTED', message: 'claim 等待已由客户端取消' } };
  }

  const finalSection = await acquireMutationSection(redis);
  if (!finalSection.ok) return { ok: false, data: null, error: finalSection.error };
  mutationSection = finalSection;
  const afterWake = await tryCandidates();
  if (terminalClaimError) return { ok: false, data: null, error: terminalClaimError };
  if (!afterWake) await redis.eval(
    COMPLETE_EMPTY_AGENT_CLAIM, 1, reservationKey,
    claimRequestId, claimAttemptId, String(CLAIM_RESERVATION_TTL_MS),
  );
  return { ok: true, data: afterWake };
  } finally {
    await mutationSection?.release();
    await reservationRenewal.stop();
  }
}

export async function claim(
  redis: Redis,
  req: ClaimRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ClaimedTask | null>> {
  return claimUnlocked(redis, req, signal);
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
            // 每次成功 report 都开启新的 review round。即使历史/人工修复留下了
            // pending+accepted 的异常组合，新交付也不能继承旧 PM 决定。
            pm_review_status: '',
            pm_reviewed_by: '',
            pm_reviewed_at: '',
            pm_review_comment: '',
            pm_accept_effects_applied: '',
            pm_reject_reason: '',
            pm_fix_instructions: '',
            pm_rejection_resolution_mode: '',
            ...suspiciousFields,
          });
        } else {
          tx.zadd(keys.zset.status.failed, now, req.task_id);
          // failed 真相与补偿候选同一个 WATCH/MULTI 提交；即使随后在 repair 创建前
          // 退出，共享 Supervisor 也能从 dirty 索引恢复，且不必扫描历史 failed。
          tx.zadd(keys.runtimeReconcile.pending, now, req.task_id);
          tx.hset(taskKey, {
            status: 'failed',
            result_path: resultPath,
            result_json_path: resultJsonPath,
            verify_results: JSON.stringify(req.verify_results ?? []),
            done_at: String(now),
            failed_reason: reportFailureReason,
            pm_review_status: '',
            pm_reviewed_by: '',
            pm_reviewed_at: '',
            pm_review_comment: '',
            pm_accept_effects_applied: '',
          });
        }
        if (req.status !== 'done') {
          // report failed 的 hash 与 actionable intake member 同一 Redis 提交；后续自动
          // repair 会经 persistTaskFromRedis/Lua 原子移除。这样崩溃在 repair 前也不漏 PM。
          tx.zadd(keys.intakeActionableFailed.pending, now, req.task_id);
        } else {
          tx.zrem(keys.intakeActionableFailed.pending, req.task_id);
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
        // report 的 claim token 只授权收口这一个 task，不授权覆盖同名 Agent
        // 已开始的新生命周期。只在 presence 仍指向本 task 时才清理。
        tx.eval(
          `if (redis.call('HGET', KEYS[1], 'current_task') or '') == ARGV[1] then
             redis.call('HSET', KEYS[1], 'current_task', '', 'status', 'idle')
             return 1
           end
           return 0`,
          1,
          keys.hash.agent(agentId),
          req.task_id,
        );
        tx.sadd(keys.planStatusProjection.planIds, currentTaskHash.plan_id);
        tx.sadd(keys.planStatusProjection.taskIdsByPlan(currentTaskHash.plan_id), req.task_id);
        tx.hincrby(keys.planStatusProjection.revisionByPlan, currentTaskHash.plan_id, 1);
        tx.sadd(keys.planStatusProjection.dirtyPlans, currentTaskHash.plan_id);
        const outcomes = await tx.exec();
        if (outcomes === null) continue;
        const commandError = outcomes.find(([error]) => error)?.[0];
        if (commandError) {
          // Redis MULTI 不会因单条命令失败而回滚：task 终态可能已写入，而 dirty
          // 候选写入失败。清掉一次性 backfill marker，让下一轮从耐久真相补回闭环。
          await redis.del(keys.runtimeReconcile.backfillReady).catch(() => undefined);
          await redis.del(keys.planStatusProjection.ready).catch(() => undefined);
          throw new Error(`任务 ${req.task_id} 的 report 状态提交失败: ${commandError.message}`);
        }
        committedAt = now;
        break;
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
      if (acceptanceFor.length > 1) {
        await markResolutionNeedsPmDecision(
          redis,
          reportedTaskHash.repair_root_task_id || req.task_id,
          `multi_source_acceptance_failure:${req.task_id}`,
        );
        return {
          ok: true,
          data: { task_id: req.task_id, status: req.status, fix_tasks_generated: [] },
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
    // claim token 只证明“谁在执行这个 task”，不授予 Worker 改写 task 边界的能力。
    // 扩权必须由 PM reject/review 写入 repair ownership，并通过 fresh claim 生效；
    // Worker 运行期间只能声明任务书已经列出的精确 ownership glob。
    const authorizedFiles = splitOwnership(task.ownership_files);
    const unauthorizedFiles = files.filter((file) => {
      if (authorizedFiles.includes(file)) return false;
      // Worker 可以在任务已授权 glob 内声明一个具体文件，但不能提交新的 glob 来扩大边界。
      // 先拒绝绝对路径和父目录穿越，避免用表面匹配绕到项目范围之外。
      const isConcretePath = !/[?*]/.test(file);
      const hasUnsafeSegment = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ||
        file.split(/[\\/]+/).some((segment) => segment === '..');
      if (!isConcretePath || hasUnsafeSegment) return true;
      return !authorizedFiles.some((authorized) => globMatch(authorized, file));
    });
    if (unauthorizedFiles.length > 0) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'OWNERSHIP_SCOPE_VIOLATION',
          message: `ownership 声明超出任务授权范围：${unauthorizedFiles.join(', ')}`,
        },
      };
    }

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

const COMMIT_SUPERSEDE_BATCH = `
-- commit-supersede-round-fenced-v1
local count = tonumber(ARGV[1]) or 0
local now = ARGV[2]
local reason = ARGV[3]
local superseded_by = ARGV[4]
local batch_plan_id = ARGV[5]
local preview_token = ARGV[6]
local plan_lock_token = ARGV[7]
local guard_count = tonumber(ARGV[8]) or 0
local revision_guard_count = tonumber(ARGV[9]) or 0
local expected_plan_count = tonumber(ARGV[10]) or 0

if batch_plan_id ~= '' and redis.call('GET', KEYS[12]) ~= plan_lock_token then
  return {'PLAN_LOCK_LOST'}
end
if batch_plan_id ~= '' and redis.call('SCARD', KEYS[7]) ~= expected_plan_count then
  return {'PREVIEW_CHANGED', 'plan_count'}
end

-- 所有候选先做 owner-token fencing 与 delivery round CAS，再做任何写入；批量操作
-- 因而只能全成或全败，旧 preview 不会部分覆盖后来的 review/reset。
for item = 0, count - 1 do
  local key_index = 13 + item * 3
  local arg_index = 11 + item * 7
  local task_key = KEYS[key_index]
  local task_id = ARGV[arg_index]
  local plan_id = ARGV[arg_index + 1]
  local done_at = ARGV[arg_index + 2]
  local review_status = ARGV[arg_index + 3]
  local resolution_status = ARGV[arg_index + 4]
  local lock_token = ARGV[arg_index + 6]
  if redis.call('GET', KEYS[key_index + 2]) ~= lock_token then return {'TASK_LOCK_LOST', task_id} end
  if (redis.call('HGET', task_key, 'task_id') or '') ~= task_id or
     (redis.call('HGET', task_key, 'plan_id') or '') ~= plan_id or
     (redis.call('HGET', task_key, 'status') or '') ~= 'done' or
     (redis.call('HGET', task_key, 'done_at') or '') ~= done_at or
     (redis.call('HGET', task_key, 'pm_review_status') or '') ~= review_status or
     (redis.call('HGET', task_key, 'resolution_status') or '') ~= resolution_status or
     string.match(review_status, '^%s*$') == nil or
     string.match(resolution_status, '^%s*$') == nil then
    return {'ROUND_CHANGED', task_id}
  end
end

-- preview 还包含非候选 task 与跨 plan 的活跃依赖者。它们不需要被写锁占有，但最终
-- Lua 必须逐字段复核；在预览重算和提交之间出现的新 blocker 会让整批 fail closed。
for item = 0, guard_count - 1 do
  local key_index = 13 + count * 3 + item
  local arg_index = 11 + count * 7 + item * 9
  if (redis.call('HGET', KEYS[key_index], 'task_id') or '') ~= ARGV[arg_index] or
     (redis.call('HGET', KEYS[key_index], 'plan_id') or '') ~= ARGV[arg_index + 1] or
     (redis.call('HGET', KEYS[key_index], 'status') or '') ~= ARGV[arg_index + 2] or
     (redis.call('HGET', KEYS[key_index], 'done_at') or '') ~= ARGV[arg_index + 3] or
     (redis.call('HGET', KEYS[key_index], 'pm_review_status') or '') ~= ARGV[arg_index + 4] or
     (redis.call('HGET', KEYS[key_index], 'resolution_status') or '') ~= ARGV[arg_index + 5] or
     (redis.call('HGET', KEYS[key_index], 'depends_on') or '') ~= ARGV[arg_index + 6] or
     (redis.call('HGET', KEYS[key_index], 'superseded_at') or '') ~= ARGV[arg_index + 7] or
     (redis.call('HGET', KEYS[key_index], 'supersede_preview_token') or '') ~= ARGV[arg_index + 8] then
    return {'PREVIEW_CHANGED', ARGV[arg_index]}
  end
end

for item = 0, revision_guard_count - 1 do
  local arg_index = 11 + count * 7 + guard_count * 9 + item * 2
  if (redis.call('HGET', KEYS[8], ARGV[arg_index]) or '') ~= ARGV[arg_index + 1] then
    return {'PREVIEW_CHANGED', ARGV[arg_index]}
  end
end

for item = 0, count - 1 do
  local key_index = 13 + item * 3
  local arg_index = 11 + item * 7
  local task_key = KEYS[key_index]
  local task_ids_key = KEYS[key_index + 1]
  local task_id = ARGV[arg_index]
  local plan_id = ARGV[arg_index + 1]
  local project_path = ARGV[arg_index + 5]
  redis.call('ZREM', KEYS[1], task_id)
  redis.call('ZADD', KEYS[2], tonumber(now), task_id)
  redis.call('HSET', task_key,
    'status', 'superseded',
    'superseded_at', now,
    'superseded_by', superseded_by,
    'superseded_reason', reason)
  if batch_plan_id ~= '' then
    redis.call('HSET', task_key,
      'supersede_preview_token', preview_token,
      'supersede_batch_size', tostring(count))
  end
  redis.call('ZREM', KEYS[3], task_id)
  redis.call('SREM', KEYS[4], task_id)
  redis.call('HDEL', KEYS[5], task_id)
  redis.call('SREM', KEYS[6], task_id)
  redis.call('SADD', KEYS[7], plan_id)
  redis.call('SADD', task_ids_key, task_id)
  redis.call('HINCRBY', KEYS[8], plan_id, 1)
  redis.call('SADD', KEYS[9], plan_id)
  redis.call('ZREM', KEYS[10], task_id)
  redis.call('XADD', KEYS[11], '*',
    'event_id', now .. '_task_superseded_' .. task_id,
    'type', 'task_superseded',
    'task_id', task_id,
    'plan_id', plan_id,
    'project_path', project_path,
    'from_status', 'done',
    'superseded_by', superseded_by,
    'reason', reason,
    'timestamp', now)
end
if batch_plan_id ~= '' then
  redis.call('XADD', KEYS[11], '*',
    'event_id', now .. '_plan_superseded_' .. batch_plan_id,
    'type', 'plan_tasks_superseded',
    'plan_id', batch_plan_id,
    'task_count', tostring(count),
    'preview_token', preview_token,
    'superseded_by', superseded_by,
    'reason', reason,
    'timestamp', now)
end
return {'COMMITTED'}
`;

async function applySupersedeBatch(
  redis: Redis,
  hashes: Record<string, string>[],
  req: TaskSupersedeRequest,
  locks: Map<string, PmDecisionLock>,
  planBatch?: {
    planId: string;
    previewToken: string;
    planLockToken: string;
    previewGuards: Record<string, string>[];
    planRevisionGuards: Array<[string, string]>;
    planCount: number;
  },
): Promise<'COMMITTED' | 'LOCK_LOST' | 'ROUND_CHANGED'> {
  const now = Date.now();
  const reason = req.reason.trim();
  const supersededBy = req.superseded_by.trim();
  const reviewEvents = new Map<string, string>();
  for (const hash of hashes) {
    reviewEvents.set(hash.task_id, await redis.hget(keys.reviewRequested.eventByTask, hash.task_id) ?? '');
  }

  const dynamicKeys = hashes.flatMap((hash) => [
    keys.hash.task(hash.task_id),
    keys.planStatusProjection.taskIdsByPlan(hash.plan_id ?? ''),
    keys.string.pmReviewLock(hash.task_id),
  ]);
  const taskArgs = hashes.flatMap((hash) => [
    hash.task_id,
    hash.plan_id ?? '',
    hash.done_at ?? '',
    hash.pm_review_status ?? '',
    hash.resolution_status ?? '',
    hash.project_path ?? '',
    locks.get(hash.task_id)?.token ?? '',
  ]);
  const guardKeys = (planBatch?.previewGuards ?? []).map((hash) => keys.hash.task(hash.task_id));
  const guardArgs = (planBatch?.previewGuards ?? []).flatMap((hash) => [
    hash.task_id,
    hash.plan_id ?? '',
    hash.status ?? '',
    hash.done_at ?? '',
    hash.pm_review_status ?? '',
    hash.resolution_status ?? '',
    hash.depends_on ?? '',
    hash.superseded_at ?? '',
    hash.supersede_preview_token ?? '',
  ]);
  const revisionArgs = (planBatch?.planRevisionGuards ?? []).flat();
  const result = (await redis.eval(
    COMMIT_SUPERSEDE_BATCH,
    12 + dynamicKeys.length + guardKeys.length,
    keys.zset.status.done,
    keys.zset.status.superseded,
    keys.reviewRequested.pending,
    keys.reviewRequested.fired,
    keys.reviewRequested.eventByTask,
    keys.acceptanceReady.fired,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    keys.stream.events,
    keys.string.planSupersedeLock(planBatch?.planId ?? ''),
    ...dynamicKeys,
    ...guardKeys,
    String(hashes.length),
    String(now),
    reason,
    supersededBy,
    planBatch?.planId ?? '',
    planBatch?.previewToken ?? '',
    planBatch?.planLockToken ?? '',
    String(guardKeys.length),
    String(planBatch?.planRevisionGuards.length ?? 0),
    String(planBatch?.planCount ?? 0),
    ...taskArgs,
    ...guardArgs,
    ...revisionArgs,
  )) as string[];
  const outcome = String(result?.[0] ?? 'UNKNOWN');
  if (outcome !== 'COMMITTED') {
    return outcome.includes('LOCK') ? 'LOCK_LOST' : 'ROUND_CHANGED';
  }

  for (const hash of hashes) {
    await persistTaskFromRedis(redis, hash.task_id);
    await withdrawReviewDoorbell(redis, hash.task_id, reviewEvents.get(hash.task_id) ?? '');
  }
  return 'COMMITTED';
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
  const decisionLock = await acquirePmReviewLock(redis, taskId);
  if (!decisionLock) {
    return { ok: false, data: null, error: { code: 'TASK_SUPERSEDE_IN_PROGRESS', message: `任务 ${taskId} 正在执行另一条 PM 决策。` } };
  }
  return runWithPmDecisionLockCleanup(redis, taskId, decisionLock, async () => {
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
    const outcome = await applySupersedeBatch(redis, [hash], req, new Map([[taskId, decisionLock]]));
    if (outcome !== 'COMMITTED') {
      return {
        ok: false,
        data: null,
        error: {
          code: 'TASK_SUPERSEDE_ROUND_CHANGED',
          message: `任务 ${taskId} 的锁或交付轮次已变化；旧 supersede 未写入，请重新检查。`,
        },
      };
    }
    return { ok: true, data: { task_id: taskId, status: 'superseded' } };
  });
}

function stableSupersedeToken(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function buildPlanSupersedePreview(
  redis: Redis,
  planId: string,
): Promise<{
  planExists: boolean;
  preview: PlanSupersedePreview;
  candidates: Record<string, string>[];
  previewGuards: Record<string, string>[];
  planRevisionGuards: Array<[string, string]>;
  planCount: number;
}> {
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
      depends_on: task.depends_on ?? '',
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
  const previewGuardIds = new Set(snapshotTasks.map((task) => task.task_id));
  const previewGuards = allTasks
    .filter((task) => previewGuardIds.has(task.task_id))
    .sort((left, right) => left.task_id.localeCompare(right.task_id));
  const projectionPlanIds = (await redis.smembers(keys.planStatusProjection.planIds)).sort();
  const planRevisionGuards = projectionPlanIds.map((projectionPlanId) => [
    projectionPlanId,
    '',
  ] as [string, string]);
  if (planRevisionGuards.length > 0) {
    const revisions = await redis.hmget(
      keys.planStatusProjection.revisionByPlan,
      ...planRevisionGuards.map(([projectionPlanId]) => projectionPlanId),
    );
    planRevisionGuards.forEach((guard, index) => { guard[1] = revisions[index] ?? ''; });
  }
  return {
    planExists: Boolean(plan.plan_id),
    preview,
    candidates,
    previewGuards,
    planRevisionGuards,
    planCount: projectionPlanIds.length,
  };
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
  const planLockKey = keys.string.planSupersedeLock(planId);
  const acquiredPlan = await redis.set(planLockKey, planLockToken, 'PX', 30_000, 'NX');
  if (acquiredPlan !== 'OK') {
    return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_IN_PROGRESS', message: `Plan ${planId} 正在执行另一条 supersede 决策。` } };
  }
  const planLease = startBackfillLockRenewal(redis, planLockKey, planLockToken, 30_000);
  const taskLocks: Array<{ taskId: string; lock: PmDecisionLock }> = [];
  let primaryFailure: unknown;
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
    // 所有 plan 都按 task_id 全序获取共享 PM 决策锁；并发批次不会形成 AB/BA 死锁。
    for (const taskId of [...initial.preview.candidate_task_ids].sort()) {
      const lock = await acquirePmReviewLock(redis, taskId);
      if (!lock) {
        return { ok: false, data: null, error: { code: 'PLAN_SUPERSEDE_TASK_BUSY', message: `任务 ${taskId} 正在执行另一条 PM 决策。` } };
      }
      taskLocks.push({ taskId, lock });
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
    const outcome = await applySupersedeBatch(
      redis,
      current.candidates,
      req,
      new Map(taskLocks.map(({ taskId, lock }) => [taskId, lock])),
      {
        planId,
        previewToken: req.preview_token,
        planLockToken,
        previewGuards: current.previewGuards,
        planRevisionGuards: current.planRevisionGuards,
        planCount: current.planCount,
      },
    );
    if (outcome !== 'COMMITTED') {
      return {
        ok: false,
        data: null,
        error: {
          code: 'PLAN_SUPERSEDE_PREVIEW_STALE',
          message: 'Plan 锁、候选任务锁或交付轮次已变化；未应用任何修改，请重新 preview。',
        },
      };
    }
    const plan = (await getPlan(redis, planId)).data as { status?: string } | null;
    return {
      ok: true,
      data: {
        plan_id: planId,
        superseded_task_ids: current.preview.candidate_task_ids,
        status: plan?.status ?? 'cancelled',
      },
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupPlanDecisionLocks(
      redis,
      planId,
      planLockToken,
      planLease,
      taskLocks,
    );
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        `PM decision lock cleanup failed plan=${planId}`,
      );
      if (primaryFailure === undefined) throw cleanupFailure;
      // finally 不能用 cleanup 错误覆盖原业务异常；记录附加故障，调用方仍收到原异常。
      console.error(`[biao] ${cleanupFailure.message}`, cleanupFailure);
    }
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
  const decisionLock = await acquirePmReviewLock(redis, taskId);
  if (!decisionLock) {
    return {
      ok: false,
      data: null,
      error: { code: 'TASK_DECISION_IN_PROGRESS', message: `任务 ${taskId} 正在执行另一条 PM 决策，请稍后重试。` },
    };
  }
  return runWithPmDecisionLockCleanup(redis, taskId, decisionLock, async () => {
    return await taskResetLocked(redis, taskId, req, decisionLock.token);
  });
}

const COMMIT_TASK_RESET = `
-- commit-task-reset-round-cas-v1
local task_id = ARGV[1]
local field_count = tonumber(ARGV[8]) or 0
if redis.call('GET', KEYS[13]) ~= ARGV[9 + field_count * 2] then return {'LOCK_LOST'} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id then return {'TASK_NOT_FOUND'} end
if (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[2] or
   (redis.call('HGET', KEYS[1], 'pm_review_status') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'resolution_status') or '') ~= ARGV[4] or
   (redis.call('HGET', KEYS[1], 'done_at') or '') ~= ARGV[5] then
  return {'ROUND_CHANGED'}
end
for index = 9, 8 + field_count * 2, 2 do
  redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
end
redis.call('ZREM', KEYS[2], task_id)
redis.call('SREM', KEYS[3], task_id)
redis.call('HDEL', KEYS[4], task_id)
redis.call('DEL', KEYS[5])
redis.call('ZREM', KEYS[6], task_id)
redis.call('ZADD', KEYS[7], tonumber(ARGV[7]), task_id)
redis.call('SADD', KEYS[8], ARGV[6])
redis.call('SADD', KEYS[9], task_id)
redis.call('HINCRBY', KEYS[10], ARGV[6], 1)
redis.call('SADD', KEYS[11], ARGV[6])
redis.call('ZREM', KEYS[12], task_id)
return {'COMMITTED'}
`;

async function taskResetLocked(
  redis: Redis,
  taskId: string,
  req: { force?: boolean; reset_by?: string },
  lockToken: string,
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

  // PM Review 的 rejected 是已经发生的审计事实；resolution cancelled 则表示平台已经
  // 对该失败/拒绝链作出终态处置。两者都不能通过 --force reset 清空，否则下游会把
  // 同一任务重新当作普通 pending，既重复执行，也失去拒绝、修复和取消的可追溯性。
  // 需要继续时走 resolution continue（它会保留旧链并创建新一代），普通重做则新建任务。
  const ownsResolutionAudit = Boolean(
    (hash.resolution_status ?? '').trim() ||
    (hash.resolution_task_id ?? '').trim() ||
    (hash.resolution_task_ids ?? '').trim() ||
    (hash.resolution_decision_reason ?? '').trim(),
  );
  if (hash.pm_review_status === 'rejected' ||
      (hash.resolution_status === 'cancelled' && ownsResolutionAudit)) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'RESOLUTION_AUDIT_IMMUTABLE',
        message: `任务 ${taskId} 已形成 rejected/cancelled 修复审计链，禁止 reset（包括 --force）。如需继续请使用 resolution continue；如需重做请新建任务。`,
      },
    };
  }

  // running 是 Worker 当前持有的执行现场，不是 PM 可任意打断的队列状态。只要 Redis
  // lease 或 hash expire_at 任一仍表明租约有效，就拒绝 reset（即使 --force）；真正
  // stale 的执行由 watchdog/reconcile 回收，或在 lease/expire_at 均失效后人工恢复。
  // 这也避免旧 PM 会话在被 Supervisor 唤醒后，把在线 Worker 的任务抢成自己的 claim。
  if (fromStatus === 'running') {
    const [hasLease, expireAt] = await Promise.all([
      redis.exists(keys.string.lease(taskId)),
      Promise.resolve(Number(hash.expire_at ?? 0)),
    ]);
    if (hasLease > 0 || expireAt > Date.now()) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'TASK_RUNNING_ACTIVE',
          message: `任务 ${taskId} 仍由在线 Worker 持有有效租约，禁止 reset（包括 --force）。请等待 Worker 结束；失联执行由 Supervisor/watchdog 自动回收。`,
        },
      };
    }
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

  // 当前 review 轮次清理、lease/status 真相和 projection dirty 必须同一次提交。
  // 任一后续 SQLite/ownership/event 步骤失败都不得让 summary 永久停在 reset 前。
  const fromZset = (keys.zset.status as Record<string, string>)[fromStatus];
  const priority = Number(hash.priority ?? 5);
  const score = pendingScore(priority, now);
  const resetFields = {
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
    pm_accept_effects_applied: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    pm_repair_ownership_required: '',
    pm_repair_ownership_intent: '',
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
  };
  const resetFlatFields = Object.entries(resetFields).flatMap(([field, value]) => [field, String(value)]);
  const resetOutcome = (await redis.eval(
    COMMIT_TASK_RESET,
    13,
    keys.hash.task(taskId),
    keys.reviewRequested.pending,
    keys.reviewRequested.fired,
    keys.reviewRequested.eventByTask,
    keys.string.lease(taskId),
    fromZset ?? keys.zset.status.pending,
    keys.zset.status.pending,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(hash.plan_id),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    keys.string.pmReviewLock(taskId),
    taskId,
    fromStatus,
    hash.pm_review_status ?? '',
    hash.resolution_status ?? '',
    hash.done_at ?? '',
    hash.plan_id,
    String(score),
    String(resetFlatFields.length / 2),
    ...resetFlatFields,
    lockToken,
  )) as string[];
  if (String(resetOutcome?.[0] ?? '') !== 'COMMITTED') {
    return {
      ok: false,
      data: null,
      error: {
        code: 'TASK_RESET_ROUND_CHANGED',
        message: `任务 ${taskId} 在 reset 提交前已进入新的状态或验收轮次，请重新读取后再操作。`,
      },
    };
  }
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
    pm_accept_effects_applied: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    pm_rejection_resolution_mode: '',
    pm_repair_ownership_required: '',
    pm_repair_ownership_intent: '',
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
 *  - 从 pending zset 移除，task hash 设 status=cancelled + cancelled_at + cancel_reason（审计）
 */
export async function cancelTask(
  redis: Redis,
  taskId: string,
  req?: { reason?: string },
): Promise<ApiResponse<{ task_id: string; status: string }>> {
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

  const cancelReason = req?.reason?.trim() ?? '';
  if (!cancelReason) {
    return {
      ok: false,
      data: null,
      error: { code: 'CANCEL_REASON_REQUIRED', message: '撤销任务必须提供非空 reason，作为异常闭环审计证据。' },
    };
  }

  // 检查是否被其他 pending/running/blocked task 依赖。waiting_dependency 已经释放
  // 旧 claim 但仍是活跃下游；漏掉它会允许取消前置并制造永久无法满足的 blocked。
  const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
  const runningIds = await redis.zrange(keys.zset.status.running, 0, -1);
  const blockedIds = await redis.zrange(keys.zset.status.blocked, 0, -1);
  const dependents: string[] = [];
  for (const otherId of [...new Set([...pendingIds, ...runningIds, ...blockedIds])]) {
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

  // 执行撤销：status/zset 与 plan projection 同一 MULTI；后续 SQLite 或 repair
  // 决策失败不会留下“已取消但 aggregate 仍是 active”的崩溃窗口。
  const cancelledAt = Date.now();
  const cancelTx = redis.multi();
  cancelTx.zrem(keys.zset.status.pending, taskId);
  cancelTx.zadd(keys.zset.status.cancelled, cancelledAt, taskId);
  cancelTx.hset(
    keys.hash.task(taskId),
    'status', 'cancelled',
    'cancelled_at', String(cancelledAt),
    'cancel_reason', cancelReason,
  );
  cancelTx.sadd(keys.planStatusProjection.planIds, hash.plan_id);
  cancelTx.sadd(keys.planStatusProjection.taskIdsByPlan(hash.plan_id), taskId);
  cancelTx.hincrby(keys.planStatusProjection.revisionByPlan, hash.plan_id, 1);
  cancelTx.sadd(keys.planStatusProjection.dirtyPlans, hash.plan_id);
  cancelTx.zrem(keys.intakeActionableFailed.pending, taskId);
  const cancelOutcomes = await cancelTx.exec();
  if (!cancelOutcomes || cancelOutcomes.some(([error]) => error)) {
    throw new Error(`任务 ${taskId} 的 cancel 真相与 plan projection 未能原子提交`);
  }
  // SQLite 双写：cancel 时 status → cancelled
  if (sqliteStore) {
    sqliteStore.updateTaskFields(taskId, {
      status: 'cancelled',
      cancelled_at: String(cancelledAt),
      cancel_reason: cancelReason,
    });
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
 *       blocked zset, agent, events stream, file ownership hash, owner-by-agent set,
 *       plan registry, plan task registry, plan revision hash, dirty-plan set,
 *       actionable-failed zset
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
local requested_ownership = ARGV[13]

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
if (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id then
  return {'PLAN_CHANGED'}
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
if (redis.call('HGET', KEYS[1], 'ownership_files') or '') ~= ARGV[15] or
   (redis.call('HGET', KEYS[1], 'ownership_modules') or '') ~= ARGV[16] then
  return {'OWNERSHIP_CHANGED'}
end

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
  'requested_ownership', requested_ownership,
  'ownership_before', ARGV[14],
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
if (redis.call('HGET', KEYS[8], 'current_task') or '') == task_id then
  redis.call('HSET', KEYS[8], 'status', 'idle', 'current_task', '')
end
redis.call('SADD', KEYS[12], plan_id)
redis.call('SADD', KEYS[13], task_id)
redis.call('HINCRBY', KEYS[14], plan_id, 1)
redis.call('SADD', KEYS[15], plan_id)
redis.call('ZREM', KEYS[16], task_id)
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
  const requested = normalizeRepairOwnership(req.requested_ownership as RepairOwnershipExtension | undefined);
  if (requested.error) {
    return { ok: false, data: null, error: { code: 'INVALID_REQUESTED_OWNERSHIP', message: requested.error.replaceAll('repair_ownership', 'requested_ownership') } };
  }
  const requestedOwnership = requested.value;
  const raw = (await redis.eval(
    CREATE_QUESTION_CAS,
    16,
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
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(planId),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
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
    requestedOwnership ? JSON.stringify(requestedOwnership) : '',
    JSON.stringify({ files: splitOwnership(taskHash.ownership_files), modules: splitOwnership(taskHash.ownership_modules) }),
    taskHash.ownership_files ?? '',
    taskHash.ownership_modules ?? '',
  )) as string[];
  const [outcome, resolvedQuestionId = '', resolvedConsumer = pmConsumer, resolvedEventId = ''] = raw.map(String);
  const errors: Record<string, { code: string; message: string }> = {
    TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
    TASK_NOT_RUNNING: { code: 'TASK_NOT_RUNNING', message: '只能对 running 任务提问' },
    CLAIM_OWNER_MISMATCH: { code: 'CLAIM_OWNER_MISMATCH', message: '任务不属于当前 Worker' },
    LEASE_EXPIRED: { code: 'LEASE_EXPIRED', message: '租约已失效，无法提问（请重新 claim）' },
    CLAIM_TOKEN_INVALID: { code: 'CLAIM_TOKEN_INVALID', message: '仅原持有 Worker 可用原 claim_token 幂等重试' },
    PLAN_CHANGED: { code: 'TASK_STATE_CONFLICT', message: '任务的 plan 绑定已变化，拒绝创建 Question' },
    OWNERSHIP_CHANGED: { code: 'TASK_STATE_CONFLICT', message: '任务 ownership 已变化，请基于当前范围重新提问' },
  };
  if (errors[outcome]) return { ok: false, data: null, error: errors[outcome] };

  // 首次创建与同 token 的幂等重放都从 Redis 最终态补偿 SQLite；重放绝不使用本次 body
  // 覆盖首个问题，但能修复“Redis 已提交、首次 SQLite 双写恰好失败”的短暂故障。
  await persistTaskFromRedis(redis, taskId);
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

function parseOwnershipScope(raw: string | undefined): OwnershipScope | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as OwnershipScope;
    return { files: value.files ?? [], modules: value.modules ?? [] };
  } catch { return undefined; }
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
    requested_ownership: parseOwnershipScope(h.requested_ownership),
    ownership_decision: (h.ownership_decision === 'approved' || h.ownership_decision === 'rejected') ? h.ownership_decision : undefined,
    ownership_before: parseOwnershipScope(h.ownership_before),
    ownership_after: parseOwnershipScope(h.ownership_after),
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
    requested_ownership: question.requested_ownership ?? '',
    ownership_decision: question.ownership_decision ?? '',
    ownership_before: question.ownership_before ?? '',
    ownership_after: question.ownership_after ?? '',
  });
}

/**
 * Question answer 的 Redis CAS。不能用共享 HTTP server Redis client 的 WATCH/MULTI：WATCH 是连接级
 * 状态，两个 Fastify 请求交错时会互相覆盖 watch 集。Lua 在 Redis 内一次执行完状态检查和所有写入，
 * 因而并发不同答案只能有一个胜出；相同答案则可靠地幂等重放。
 *
 * KEYS: question hash, task hash, open-question pointer, open-pointer metadata, blocked zset,
 * pending zset, task stream, event stream, plan registry, plan task registry,
 * plan revision hash, dirty-plan set, actionable-failed zset
 * ARGV: question id, consumer, answer, timestamp, default PM consumer, expected plan id
 */
const ANSWER_QUESTION_CAS = `
local question_id = ARGV[1]
local consumer = ARGV[2]
local answer = ARGV[3]
local now = ARGV[4]
local default_consumer = ARGV[5]
local expected_plan_id = ARGV[6]
local ownership_decision = ARGV[7]
local expected_files = ARGV[8]
local expected_modules = ARGV[9]
local ownership_after = ARGV[10]
local approved_files = ARGV[11]
local approved_modules = ARGV[12]

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
  local stored_decision = redis.call('HGET', KEYS[1], 'ownership_decision') or ''
  if stored_answer == answer and answered_by == consumer and stored_decision == ownership_decision then
    return {'IDEMPOTENT', task_id}
  end
  return {'ANSWER_CONFLICT', task_id}
end

if redis.call('HGET', KEYS[2], 'task_id') == false then
  return {'TASK_NOT_FOUND', task_id}
end
local task_status = redis.call('HGET', KEYS[2], 'status') or ''
if task_status == 'cancelled' or task_status == 'done' or task_status == 'failed' then
  redis.call('HSET', KEYS[1], 'status', 'answered', 'answered_at', now, 'answered_by', consumer, 'answer', answer,
    'ownership_decision', ownership_decision,
    'ownership_after', redis.call('HGET', KEYS[1], 'ownership_before') or '')
  if redis.call('GET', KEYS[3]) == question_id then
    redis.call('DEL', KEYS[3])
    redis.call('DEL', KEYS[4])
  end
  return {'TERMINAL_ANSWERED', task_id}
end
if task_status ~= 'blocked' or (redis.call('HGET', KEYS[2], 'blocked_question_id') or '') ~= question_id then
  return {'TASK_STATE_CONFLICT', task_id, task_status}
end

local plan_id = redis.call('HGET', KEYS[1], 'plan_id') or redis.call('HGET', KEYS[2], 'plan_id') or ''
if plan_id ~= expected_plan_id then return {'PLAN_CHANGED', task_id} end
if ownership_decision == 'approved' then
  if (redis.call('HGET', KEYS[2], 'ownership_files') or '') ~= expected_files or
     (redis.call('HGET', KEYS[2], 'ownership_modules') or '') ~= expected_modules then
    return {'OWNERSHIP_CHANGED', task_id}
  end
  redis.call('HSET', KEYS[2], 'ownership_files', approved_files, 'ownership_modules', approved_modules)
end

redis.call('HSET', KEYS[1], 'status', 'answered', 'answered_at', now, 'answered_by', consumer, 'answer', answer,
  'ownership_decision', ownership_decision, 'ownership_after', ownership_after)
if redis.call('GET', KEYS[3]) == question_id then
  redis.call('DEL', KEYS[3])
  redis.call('DEL', KEYS[4])
end

local priority = tonumber(redis.call('HGET', KEYS[2], 'priority') or '5')
local score = priority * 10000000000000 - tonumber(now)
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
redis.call('SADD', KEYS[9], plan_id)
redis.call('SADD', KEYS[10], task_id)
redis.call('HINCRBY', KEYS[11], plan_id, 1)
redis.call('SADD', KEYS[12], plan_id)
redis.call('ZREM', KEYS[13], task_id)
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
  if (normalizePmConsumer(questionBefore.pm_consumer) !== consumer) {
    return { ok: false, data: null, error: { code: 'CONSUMER_NOT_AUTHORIZED', message: '该 Question 不属于当前 consumer' } };
  }
  if (req.plan_id && questionBefore.plan_id !== req.plan_id) {
    return { ok: false, data: null, error: { code: 'PLAN_NOT_AUTHORIZED', message: `Question 不属于 plan=${req.plan_id}` } };
  }
  const requested = parseRepairOwnershipAudit(questionBefore.requested_ownership);
  const decision = req.ownership_decision ?? '';
  if (requested && !decision) {
    return { ok: false, data: null, error: { code: 'OWNERSHIP_DECISION_REQUIRED', message: '该 Question 包含扩权请求，PM 必须显式批准或拒绝' } };
  }
  if (!requested && decision) {
    return { ok: false, data: null, error: { code: 'OWNERSHIP_DECISION_FORBIDDEN', message: '该 Question 不包含扩权请求' } };
  }
  if (decision && decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, data: null, error: { code: 'INVALID_OWNERSHIP_DECISION', message: 'ownership_decision 只能是 approved 或 rejected' } };
  }
  const capturedBefore = parseOwnershipScope(questionBefore.ownership_before);
  const beforeFiles = capturedBefore?.files.join(',') ?? '';
  const beforeModules = capturedBefore?.modules.join(',') ?? '';
  const afterFiles = decision === 'approved' && requested ? ownershipUnion(beforeFiles, requested.files) : beforeFiles;
  const afterModules = decision === 'approved' && requested ? ownershipUnion(beforeModules, requested.modules) : beforeModules;
  const ownershipAfter = requested
    ? JSON.stringify({ files: splitOwnership(afterFiles), modules: splitOwnership(afterModules) })
    : '';
  const raw = (await redis.eval(
    ANSWER_QUESTION_CAS,
    13,
    keys.hash.question(questionId),
    keys.hash.task(boundTaskId),
    keys.question.openByTask(boundTaskId),
    keys.question.openMetaByTask(boundTaskId),
    keys.zset.status.blocked,
    keys.zset.status.pending,
    keys.stream.tasks,
    keys.stream.events,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(questionBefore.plan_id ?? ''),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    questionId,
    consumer,
    answer,
    String(now),
    DEFAULT_PM_CONSUMER,
    questionBefore.plan_id ?? '',
    decision,
    beforeFiles,
    beforeModules,
    ownershipAfter,
    afterFiles,
    afterModules,
  )) as string[];
  const [outcome, taskId = ''] = raw.map(String);

  const errors: Record<string, { code: string; message: string }> = {
    QUESTION_NOT_FOUND: { code: 'QUESTION_NOT_FOUND', message: `Question 不存在：${questionId}（不得伪造 question_id）` },
    CONSUMER_NOT_AUTHORIZED: { code: 'CONSUMER_NOT_AUTHORIZED', message: '该 Question 不属于当前 consumer' },
    QUESTION_CANCELLED: { code: 'QUESTION_CANCELLED', message: '该 Question 已取消' },
    ANSWER_CONFLICT: { code: 'ANSWER_CONFLICT', message: '该 Question 已被回答，冲突回答被拒绝' },
    TASK_NOT_FOUND: { code: 'TASK_NOT_FOUND', message: `任务不存在：${taskId}` },
    TASK_STATE_CONFLICT: { code: 'TASK_STATE_CONFLICT', message: '任务已不处于该 Question 对应的 blocked 状态，拒绝覆盖其后续状态' },
    PLAN_CHANGED: { code: 'TASK_STATE_CONFLICT', message: 'Question 与任务的 plan 绑定已变化，拒绝恢复任务' },
    OWNERSHIP_CHANGED: { code: 'TASK_STATE_CONFLICT', message: '任务 ownership 在 Question 等待期间已变化，拒绝覆盖' },
  };
  if (errors[outcome]) return { ok: false, data: null, error: errors[outcome] };

  // Lua 已写 Redis。包括 IDEMPOTENT 在内都重放 SQLite 副本：首次 Redis 成功但 SQLite 暂时失败时，
  // 同答案重试可补齐持久化；冲突回答在 Lua 层被拒，绝不会覆盖已存答案。
  if (outcome === 'ANSWERED' || outcome === 'TERMINAL_ANSWERED' || outcome === 'IDEMPOTENT') {
    await persistTaskFromRedis(redis, taskId);
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
local expected_plan_id = ARGV[8]

if redis.call('HGET', KEYS[1], 'task_id') == false then return {'TASK_NOT_FOUND'} end
local plan_id = redis.call('HGET', KEYS[1], 'plan_id') or ''
if plan_id ~= expected_plan_id then return {'TASK_NOT_FOUND'} end
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
  if (redis.call('HGET', KEYS[5], 'current_task') or '') == task_id then
    redis.call('HSET', KEYS[5], 'status', 'idle', 'current_task', '')
  end
  redis.call('SADD', KEYS[11], plan_id)
  redis.call('SADD', KEYS[12], task_id)
  redis.call('HINCRBY', KEYS[13], plan_id, 1)
  redis.call('SADD', KEYS[14], plan_id)
  redis.call('ZREM', KEYS[15], task_id)
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
if (redis.call('HGET', KEYS[5], 'current_task') or '') == task_id then
  redis.call('HSET', KEYS[5], 'status', 'idle', 'current_task', '')
end
redis.call('SADD', KEYS[11], plan_id)
redis.call('SADD', KEYS[12], task_id)
redis.call('HINCRBY', KEYS[13], plan_id, 1)
redis.call('SADD', KEYS[14], plan_id)
redis.call('ZREM', KEYS[15], task_id)
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
          15,
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
          keys.planStatusProjection.planIds,
          keys.planStatusProjection.taskIdsByPlan(current.plan_id ?? ''),
          keys.planStatusProjection.revisionByPlan,
          keys.planStatusProjection.dirtyPlans,
          keys.intakeActionableFailed.pending,
          taskId,
          agentId,
          req.claim_token,
          req.reason,
          req.question_id ?? '',
          String(now),
          conditionClear ? '1' : '0',
          current.plan_id ?? '',
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
        tx.sadd(keys.planStatusProjection.planIds, current.plan_id ?? '');
        tx.sadd(keys.planStatusProjection.taskIdsByPlan(current.plan_id ?? ''), taskId);
        tx.hincrby(keys.planStatusProjection.revisionByPlan, current.plan_id ?? '', 1);
        tx.sadd(keys.planStatusProjection.dirtyPlans, current.plan_id ?? '');
        tx.zrem(keys.intakeActionableFailed.pending, taskId);
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
async function wakeDependents(
  redis: Redis,
  completedTaskId: string,
  opts: { allowAcceptance?: boolean } = {},
): Promise<string[]> {
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
  return requeueDependencyWaiters(redis, completedTaskId);
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
  tx.sadd(keys.planStatusProjection.planIds, hash.plan_id ?? '');
  tx.sadd(keys.planStatusProjection.taskIdsByPlan(hash.plan_id ?? ''), taskId);
  tx.hincrby(keys.planStatusProjection.revisionByPlan, hash.plan_id ?? '', 1);
  tx.sadd(keys.planStatusProjection.dirtyPlans, hash.plan_id ?? '');
  tx.zrem(keys.intakeActionableFailed.pending, taskId);
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
  const resumeOutcomes = await tx.exec();
  if (!resumeOutcomes || resumeOutcomes.some(([error]) => error)) {
    await redis.del(keys.planStatusProjection.ready).catch(() => undefined);
    throw new Error(`任务 ${taskId} 的 resume 状态提交失败`);
  }
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

function isMultiSourceAcceptanceReverifyDecision(
  root: Record<string, string>,
  rawReason = root.resolution_decision_reason ?? '',
): boolean {
  const reason = rawReason.startsWith('cancelled:')
    ? rawReason.slice('cancelled:'.length)
    : rawReason;
  return root.type === 'acceptance' &&
    acceptanceSourceIds(root).length > 1 &&
    reason.startsWith('multi_source_acceptance_failure:');
}

function availableResolutionDecisionActions(hash: Record<string, string>): ResolutionDecisionAction[] {
  if (hash.resolution_status === 'needs_pm_decision') {
    const retryable = ['repair_retry_limit_reached', 'reverify_retry_limit_reached']
      .some((reason) => (hash.resolution_decision_reason ?? '').startsWith(reason));
    const requiresRepairSource = (hash.resolution_decision_reason ?? '').startsWith('repair_sources_required:');
    const canReverifyMultiSourceAcceptance = isMultiSourceAcceptanceReverifyDecision(hash);
    return retryable || requiresRepairSource || canReverifyMultiSourceAcceptance
      ? ['inspect', 'continue', 'cancel']
      : ['inspect', 'cancel'];
  }
  if (hash.resolution_status === 'cancelled') {
    // cancel 本身不自动复活；但 retry-limit 产生的旧终态必须允许操作者显式重新
    // 放行一代，否则其下游 pending 依赖会永久堆积，平台又没有任何可处理事项。
    const retryable = ['cancelled:repair_retry_limit_reached', 'cancelled:reverify_retry_limit_reached']
      .some((reason) => (hash.resolution_decision_reason ?? '').startsWith(reason));
    const canReverifyMultiSourceAcceptance = isMultiSourceAcceptanceReverifyDecision(hash);
    return retryable || canReverifyMultiSourceAcceptance ? ['inspect', 'continue'] : ['inspect'];
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
      pm_repair_ownership_required: hash.pm_repair_ownership_required === 'true',
      pm_repair_ownership_intent: parseRepairOwnershipAudit(hash.pm_repair_ownership_intent),
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
-- release-pm-review-lock-v1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface PmDecisionLock {
  token: string;
  lease: BackfillLockLease;
}

/**
 * PM review 的最终提交边界。外层短锁负责正常请求串行；这里仍按 done_at + status +
 * review/resolution 快照做 CAS，防锁过期、管理员修复或其它非锁写路径让旧验收跨轮次落盘。
 */
const COMMIT_PM_REVIEW_AUDIT = `
-- commit-pm-review-round-cas-v1
local task_id = ARGV[1]
local plan_id = ARGV[2]
local field_count = tonumber(ARGV[7]) or 0
if redis.call('GET', KEYS[9]) ~= ARGV[8 + field_count * 2] then return {'LOCK_LOST'} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id then return {'TASK_NOT_FOUND'} end
if (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= 'done' or
   (redis.call('HGET', KEYS[1], 'done_at') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'pm_review_status') or '') ~= ARGV[4] or
   (redis.call('HGET', KEYS[1], 'resolution_status') or '') ~= ARGV[5] then
  return {'ROUND_CHANGED'}
end
for index = 8, 7 + field_count * 2, 2 do
  redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
end
redis.call('ZREM', KEYS[2], task_id)
redis.call('ZADD', KEYS[3], tonumber(ARGV[6]), task_id)
redis.call('SADD', KEYS[4], plan_id)
redis.call('SADD', KEYS[5], task_id)
redis.call('HINCRBY', KEYS[6], plan_id, 1)
redis.call('SADD', KEYS[7], plan_id)
redis.call('ZREM', KEYS[8], task_id)
return {'COMMITTED'}
`;

async function commitPmReviewAudit(
  redis: Redis,
  taskId: string,
  snapshot: Record<string, string>,
  now: number,
  fields: Record<string, string>,
  lockToken: string,
): Promise<boolean> {
  const flatFields = Object.entries(fields).flat();
  const result = (await redis.eval(
    COMMIT_PM_REVIEW_AUDIT,
    9,
    keys.hash.task(taskId),
    keys.reviewRequested.pending,
    keys.runtimeReconcile.pending,
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(snapshot.plan_id ?? ''),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    keys.string.pmReviewLock(taskId),
    taskId,
    snapshot.plan_id ?? '',
    snapshot.done_at ?? '',
    snapshot.pm_review_status ?? '',
    snapshot.resolution_status ?? '',
    String(now),
    String(flatFields.length / 2),
    ...flatFields,
    lockToken,
  )) as string[];
  return String(result?.[0] ?? '') === 'COMMITTED';
}

/**
 * PM review 会同时写不可变审计、resolution、事件与依赖唤醒，必须按 task 串行。
 * 短锁只覆盖这段临界区；后到的网络重试等首个请求结束后重新读取真相，从而得到
 * 幂等回放或明确冲突，而不是双写 reviewer/reason/event。
 */
async function acquirePmReviewLock(redis: Redis, taskId: string): Promise<PmDecisionLock | null> {
  const token = randomUUID();
  const testTtl = process.env.NODE_ENV === 'test'
    ? Number(process.env.BIAO_TEST_PM_DECISION_LOCK_TTL_MS ?? '')
    : Number.NaN;
  const ttlMs = Number.isFinite(testTtl) && testTtl >= 30 ? testTtl : 30_000;
  for (let attempt = 0; attempt < 100; attempt++) {
    const lockKey = keys.string.pmReviewLock(taskId);
    const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      return { token, lease: startBackfillLockRenewal(redis, lockKey, token, ttlMs) };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  return null;
}

async function cleanupPmReviewLock(
  redis: Redis,
  taskId: string,
  lock: PmDecisionLock,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const stopped = await Promise.allSettled([lock.lease.stop()]);
  if (stopped[0].status === 'rejected') errors.push(stopped[0].reason);
  const released = await Promise.allSettled([
    redis.eval(RELEASE_PM_REVIEW_LOCK, 1, keys.string.pmReviewLock(taskId), lock.token),
  ]);
  if (released[0].status === 'rejected') errors.push(released[0].reason);
  return errors;
}

/**
 * 单任务 PM 决策与 plan 批量决策使用相同的 cleanup 规则：
 * - cleanup 永远尝试停止续租并释放 owner token；
 * - 原业务异常或结构化错误返回优先，cleanup 只能作为附加故障记录；
 * - 业务成功却未能完成 cleanup 时必须显式失败，不能谎报一次干净提交。
 */
async function runWithPmDecisionLockCleanup<T extends { ok: boolean }>(
  redis: Redis,
  taskId: string,
  lock: PmDecisionLock,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let primaryFailure: unknown;
  try {
    result = await operation();
    return result;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupErrors = await cleanupPmReviewLock(redis, taskId, lock);
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        `PM decision lock cleanup failed task=${taskId}`,
      );
      if (primaryFailure === undefined && result?.ok === true) throw cleanupFailure;
      console.error(`[biao] ${cleanupFailure.message}`, cleanupFailure);
    }
  }
}

async function cleanupPlanDecisionLocks(
  redis: Redis,
  planId: string,
  planLockToken: string,
  planLease: BackfillLockLease,
  taskLocks: Array<{ taskId: string; lock: PmDecisionLock }>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const taskStops = await Promise.allSettled(taskLocks.map(({ lock }) => lock.lease.stop()));
  for (const stopped of taskStops) if (stopped.status === 'rejected') errors.push(stopped.reason);

  // 即使某个 task renewal stop 失败，Plan renewal 也必须单独停止，不能因顺序 await
  // 提前退出而留下一个会无限续期的 owner token。
  const planStop = await Promise.allSettled([planLease.stop()]);
  if (planStop[0].status === 'rejected') errors.push(planStop[0].reason);

  // 所有 timer 已先停止后，再并发执行 owner-token release。任一 EVAL 失败不得阻断
  // 其它 task 或 plan 的释放；失败锁至多等待既有 TTL，自此不会再被后台续上。
  const releases = await Promise.allSettled([
    ...taskLocks.map(({ taskId, lock }) => redis.eval(
      RELEASE_PM_REVIEW_LOCK,
      1,
      keys.string.pmReviewLock(taskId),
      lock.token,
    )),
    redis.eval(
      RELEASE_PM_REVIEW_LOCK,
      1,
      keys.string.planSupersedeLock(planId),
      planLockToken,
    ),
  ]);
  for (const released of releases) if (released.status === 'rejected') errors.push(released.reason);
  return errors;
}

export interface ResolutionDecisionRequest {
  action: ResolutionDecisionAction;
  decided_by: string;
  /** 多来源验收拒绝的显式返修目标；必须是 acceptance_for 中的一项。 */
  repair_source_task_id?: string;
  /** 一次拒绝同时要求多个来源修复时，显式列出最小子集。 */
  repair_source_task_ids?: string[];
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
  /** repair_sources_required 时可传给 repair_source_task_id(s) 的完整合法集合。 */
  repair_source_candidates?: string[];
  created_task_ids?: string[];
}

const COMMIT_RESOLUTION_CANCEL = `
-- commit-resolution-cancel-round-fenced-v1
local task_id = ARGV[1]
local plan_id = ARGV[2]
if redis.call('GET', KEYS[7]) ~= ARGV[10] then return {'LOCK_LOST'} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'resolution_status') or '') ~= 'needs_pm_decision' or
   (redis.call('HGET', KEYS[1], 'resolution_generation') or '') ~= ARGV[5] or
   (redis.call('HGET', KEYS[1], 'repair_root_task_id') or '') ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'resolution_decision_reason') or '') ~= ARGV[7] then
  return {'ROUND_CHANGED'}
end
redis.call('HSET', KEYS[1],
  'resolution_status', 'cancelled',
  'resolution_action', 'cancel',
  'resolution_decision_reason', 'cancelled:' .. ARGV[8],
  'resolution_decided_by', ARGV[9],
  'resolution_decided_at', ARGV[11])
redis.call('SADD', KEYS[2], plan_id)
redis.call('SADD', KEYS[3], task_id)
redis.call('HINCRBY', KEYS[4], plan_id, 1)
redis.call('SADD', KEYS[5], plan_id)
redis.call('ZREM', KEYS[6], task_id)
redis.call('XADD', KEYS[8], '*',
  'event_id', ARGV[11] .. '_resolution_cancel_' .. task_id,
  'type', 'resolution_decided',
  'task_id', task_id,
  'plan_id', plan_id,
  'project_path', ARGV[12],
  'consumer', 'worker',
  'resolution_action', 'cancel',
  'decided_by', ARGV[9],
  'timestamp', ARGV[11])
return {'COMMITTED'}
`;

const COMMIT_RESOLUTION_REOPEN = `
-- commit-resolution-reopen-cancelled-round-fenced-v1
local task_id = ARGV[1]
local plan_id = ARGV[2]
if redis.call('GET', KEYS[7]) ~= ARGV[10] then return {'LOCK_LOST'} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'resolution_status') or '') ~= 'cancelled' or
   (redis.call('HGET', KEYS[1], 'resolution_generation') or '') ~= ARGV[5] or
   (redis.call('HGET', KEYS[1], 'repair_root_task_id') or '') ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'resolution_decision_reason') or '') ~= ARGV[7] then
  return {'ROUND_CHANGED'}
end
redis.call('HSET', KEYS[1],
  'resolution_status', 'needs_pm_decision',
  'resolution_action', 'inspect',
  'resolution_decision_reason', ARGV[8],
  'resolution_decided_by', ARGV[9],
  'resolution_decided_at', ARGV[11])
redis.call('SADD', KEYS[2], plan_id)
redis.call('SADD', KEYS[3], task_id)
redis.call('HINCRBY', KEYS[4], plan_id, 1)
redis.call('SADD', KEYS[5], plan_id)
redis.call('ZADD', KEYS[6], tonumber(ARGV[11]), task_id)
redis.call('ZADD', KEYS[8], tonumber(ARGV[11]), task_id)
redis.call('XADD', KEYS[9], '*',
  'event_id', ARGV[11] .. '_resolution_reopen_' .. task_id,
  'type', 'resolution_reopened',
  'task_id', task_id,
  'plan_id', plan_id,
  'project_path', ARGV[12],
  'consumer', 'pm',
  'resolution_action', 'continue',
  'decided_by', ARGV[9],
  'timestamp', ARGV[11])
return {'COMMITTED'}
`;

const BEGIN_RESOLUTION_CONTINUE = `
-- begin-resolution-continue-round-fenced-v1
if redis.call('GET', KEYS[7]) ~= ARGV[8] then return {'LOCK_LOST'} end
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= ARGV[1] or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= ARGV[2] or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'resolution_status') or '') ~= 'needs_pm_decision' or
   (redis.call('HGET', KEYS[1], 'resolution_generation') or '') ~= ARGV[5] or
   (redis.call('HGET', KEYS[1], 'repair_root_task_id') or '') ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'resolution_decision_reason') or '') ~= ARGV[7] then
  return {'ROUND_CHANGED'}
end
-- 先把 needs_pm_decision 原子占位为 repairing。即使 owner 随后因长暂停丢失 TTL，
-- 后来的 cancel/continue 也不能再从旧 decision round 起步；reconcile 可按 repair 指针恢复。
redis.call('HSET', KEYS[1],
  'resolution_status', 'repairing',
  'resolution_action', 'continue',
  'resolution_continue_owner', ARGV[8],
  'resolution_continue_snapshot_generation', ARGV[5],
  'resolution_continue_snapshot_repair_root', ARGV[6],
  'resolution_continue_snapshot_reason', ARGV[7],
  'resolution_continue_snapshot_task_ids', ARGV[11],
  'resolution_continue_snapshot_attempts', ARGV[12],
  'resolution_continue_snapshot_acceptance_repair_task_ids', ARGV[13],
  'resolution_decided_by', ARGV[9],
  'resolution_decided_at', ARGV[10])
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('HINCRBY', KEYS[4], ARGV[2], 1)
redis.call('SADD', KEYS[5], ARGV[2])
redis.call('ZREM', KEYS[6], ARGV[1])
redis.call('ZADD', KEYS[8], tonumber(ARGV[10]), ARGV[1])
return {'RESERVED'}
`;

const COMMIT_RESOLUTION_CONTINUE_AUDIT = `
-- commit-resolution-continue-round-fenced-v1
local task_id = ARGV[1]
local plan_id = ARGV[2]
if redis.call('GET', KEYS[2]) ~= ARGV[9] then return {'LOCK_LOST'} end
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'resolution_generation') or '0')
local current_attempts = tonumber(redis.call('HGET', KEYS[1], 'resolution_attempts') or '0')
local current_resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''
local source_repairs = redis.call('HGET', KEYS[1], 'acceptance_repair_task_ids') or ''
local snapshot_source_repairs = redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_acceptance_repair_task_ids') or ''
if (redis.call('HGET', KEYS[1], 'task_id') or '') ~= task_id or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= plan_id or
   (redis.call('HGET', KEYS[1], 'status') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'repair_root_task_id') or '') ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_owner') or '') ~= ARGV[9] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_generation') or '') ~= ARGV[5] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_repair_root') or '') ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_reason') or '') ~= ARGV[7] or
   (current_resolution ~= 'repairing' and current_resolution ~= 'required') or
   (redis.call('HGET', KEYS[1], 'resolution_decision_reason') or '') ~= '' or
   (current_generation <= (tonumber(ARGV[5]) or 0) and
    current_attempts <= (tonumber(ARGV[8]) or 0) and
    source_repairs == snapshot_source_repairs) or
   ((redis.call('HGET', KEYS[1], 'resolution_task_id') or '') == '' and
    source_repairs == snapshot_source_repairs) then
  return {'ROUND_CHANGED'}
end
redis.call('HSET', KEYS[1],
  'resolution_decided_by', ARGV[10],
  'resolution_decided_at', ARGV[11],
  'resolution_decision_generation', ARGV[5])
redis.call('XADD', KEYS[3], '*',
  'event_id', ARGV[11] .. '_resolution_continue_' .. task_id,
  'type', 'resolution_decided',
  'task_id', task_id,
  'plan_id', plan_id,
  'project_path', ARGV[12],
  'consumer', 'worker',
  'resolution_action', 'continue',
  'decided_by', ARGV[10],
  'created_tasks', ARGV[13],
  'timestamp', ARGV[11])
redis.call('HDEL', KEYS[1],
  'resolution_continue_owner',
  'resolution_continue_snapshot_generation',
  'resolution_continue_snapshot_repair_root',
  'resolution_continue_snapshot_reason',
  'resolution_continue_snapshot_task_ids',
  'resolution_continue_snapshot_attempts',
  'resolution_continue_snapshot_acceptance_repair_task_ids')
return {'COMMITTED'}
`;

const COMMIT_RECOVERED_RESOLUTION_CONTINUE_AUDIT = `
-- commit-recovered-resolution-continue-audit-v1
local owner = redis.call('HGET', KEYS[1], 'resolution_continue_owner') or ''
if owner == '' then return {'ALREADY_COMMITTED'} end
if owner ~= ARGV[6] or
   (redis.call('HGET', KEYS[1], 'task_id') or '') ~= ARGV[1] or
   (redis.call('HGET', KEYS[1], 'plan_id') or '') ~= ARGV[2] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_generation') or '') ~= ARGV[3] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_repair_root') or '') ~= ARGV[4] or
   (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_reason') or '') ~= ARGV[5] then
  return {'ROUND_CHANGED'}
end
local current_generation = tonumber(redis.call('HGET', KEYS[1], 'resolution_generation') or '0')
local current_attempts = tonumber(redis.call('HGET', KEYS[1], 'resolution_attempts') or '0')
local snapshot_attempts = tonumber(redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_attempts') or '0')
local current_resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''
local source_repairs = redis.call('HGET', KEYS[1], 'acceptance_repair_task_ids') or ''
local snapshot_source_repairs = redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_acceptance_repair_task_ids') or ''
if (current_resolution ~= 'repairing' and current_resolution ~= 'required') or
   (redis.call('HGET', KEYS[1], 'resolution_decision_reason') or '') ~= '' or
   (current_generation <= (tonumber(ARGV[3]) or 0) and
    current_attempts <= snapshot_attempts and
    source_repairs == snapshot_source_repairs) or
   ((redis.call('HGET', KEYS[1], 'resolution_task_id') or '') == '' and
    source_repairs == snapshot_source_repairs) then
  return {'NOT_READY'}
end
redis.call('XADD', KEYS[2], '*',
  'event_id', ARGV[8] .. '_resolution_continue_' .. ARGV[1],
  'type', 'resolution_decided',
  'task_id', ARGV[1],
  'plan_id', ARGV[2],
  'project_path', ARGV[9],
  'consumer', 'worker',
  'resolution_action', 'continue',
  'decided_by', ARGV[7],
  'created_tasks', ARGV[10],
  'timestamp', ARGV[8])
redis.call('HSET', KEYS[1],
  'resolution_decided_by', ARGV[7],
  'resolution_decided_at', ARGV[8],
  'resolution_decision_generation', ARGV[3])
redis.call('HDEL', KEYS[1],
  'resolution_continue_owner',
  'resolution_continue_snapshot_generation',
  'resolution_continue_snapshot_repair_root',
  'resolution_continue_snapshot_reason',
  'resolution_continue_snapshot_task_ids',
  'resolution_continue_snapshot_attempts',
  'resolution_continue_snapshot_acceptance_repair_task_ids')
redis.call('ZREM', KEYS[3], ARGV[1])
return {'COMMITTED'}
`;

const ROLLBACK_INTERRUPTED_RESOLUTION_CONTINUE = `
-- rollback-interrupted-resolution-continue-v1
if (redis.call('HGET', KEYS[1], 'resolution_continue_owner') or '') ~= ARGV[2] then
  return {'ROUND_CHANGED'}
end
local resolution = redis.call('HGET', KEYS[1], 'resolution_status') or ''
if resolution == 'repairing' then
  if (redis.call('HGET', KEYS[1], 'resolution_generation') or '') ~= ARGV[4] or
     (redis.call('HGET', KEYS[1], 'resolution_task_ids') or '') ~= ARGV[5] or
     (redis.call('HGET', KEYS[1], 'resolution_attempts') or '') ~= ARGV[6] or
     (redis.call('HGET', KEYS[1], 'acceptance_repair_task_ids') or '') ~=
       (redis.call('HGET', KEYS[1], 'resolution_continue_snapshot_acceptance_repair_task_ids') or '') then
    return {'NOT_READY'}
  end
  redis.call('HSET', KEYS[1],
    'resolution_status', 'needs_pm_decision',
    'resolution_action', 'inspect',
    'resolution_decision_reason', ARGV[7])
elseif resolution ~= 'needs_pm_decision' then
  return {'NOT_READY'}
end
redis.call('HDEL', KEYS[1],
  'resolution_continue_owner',
  'resolution_continue_snapshot_generation',
  'resolution_continue_snapshot_repair_root',
  'resolution_continue_snapshot_reason',
  'resolution_continue_snapshot_task_ids',
  'resolution_continue_snapshot_attempts',
  'resolution_continue_snapshot_acceptance_repair_task_ids')
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return {'ROLLED_BACK'}
`;

function resolutionRoundArgs(root: Record<string, string>): string[] {
  return [
    root.task_id,
    root.plan_id ?? '',
    root.status ?? '',
    root.resolution_status ?? '',
    root.resolution_generation ?? '',
    root.repair_root_task_id ?? '',
    root.resolution_decision_reason ?? '',
  ];
}

async function beginResolutionContinue(
  redis: Redis,
  root: Record<string, string>,
  lockToken: string,
  decidedBy: string,
  decidedAt: number,
): Promise<boolean> {
  const result = (await redis.eval(
    BEGIN_RESOLUTION_CONTINUE,
    8,
    keys.hash.task(root.task_id),
    keys.planStatusProjection.planIds,
    keys.planStatusProjection.taskIdsByPlan(root.plan_id ?? ''),
    keys.planStatusProjection.revisionByPlan,
    keys.planStatusProjection.dirtyPlans,
    keys.intakeActionableFailed.pending,
    keys.string.pmReviewLock(root.task_id),
    keys.runtimeReconcile.pending,
    ...resolutionRoundArgs(root),
    lockToken,
    decidedBy,
    String(decidedAt),
    root.resolution_task_ids ?? '',
    root.resolution_attempts ?? '',
    root.acceptance_repair_task_ids ?? '',
  )) as string[];
  return String(result?.[0] ?? '') === 'RESERVED';
}

type ResolutionContinueWork =
  | { ok: true; createdTaskIds: string[] }
  | { ok: false; message: string };

/** 创建显式 continue 放行的下一代；确定性 task id 使 API 与 reconcile 可安全重放。 */
async function performResolutionContinueWork(
  redis: Redis,
  root: Record<string, string>,
  decidedBy: string,
): Promise<ResolutionContinueWork> {
  const reason = root.resolution_continue_snapshot_reason || root.resolution_decision_reason || '';
  const createdTaskIds: string[] = [];
  const reverifyGate = root.type === 'acceptance'
    ? await acceptanceReverifyRepairGate(redis, root)
    : { allowed: true as const };
  if (root.type === 'acceptance' && (
    reason.startsWith('reverify_retry_limit_reached') ||
    isMultiSourceAcceptanceReverifyDecision(root, reason)
  ) && reverifyGate.allowed) {
    const result = await ensureAcceptanceReverifyTask(
      redis,
      root.task_id,
      `pm-continue:${decidedBy}`,
      {
        allowRetryLimitOverride: true,
        trigger: isMultiSourceAcceptanceReverifyDecision(root, reason) ? 'pm_reverify_only' : undefined,
      },
    );
    if (!result.taskId) return { ok: false, message: '未能为验收根创建新的 reverify generation。' };
    createdTaskIds.push(result.taskId);
    return { ok: true, createdTaskIds };
  }

  if (root.type === 'acceptance') {
    const sources = acceptanceSourceIds(root);
    const targetedSourceId = retryLimitRepairSourceId(reason);
    const selectedDecision = selectedRepairDecision(reason);
    const explicitlySelected = (selectedDecision?.sourceIds ?? []).filter((id) => sources.includes(id));
    const repairSources = explicitlySelected.length > 0
      ? explicitlySelected
      : targetedSourceId && sources.includes(targetedSourceId)
        ? [targetedSourceId]
      : sources.length === 1
        ? sources
        : [];
    if (repairSources.length === 0) {
      return { ok: false, message: '多来源验收不得 fan-out 来源 repair；请使用独立 reverify。' };
    }
    const repairTaskIds: string[] = [];
    for (const sourceTaskId of repairSources) {
      const result = await ensureRepairTask(redis, sourceTaskId, {
        source: 'acceptance_failed',
        reason: `PM ${decidedBy} 显式 continue，额外放行一代来源修复。`,
        decisionRootTaskId: root.task_id,
        allowRetryLimitOverride: true,
        triggerReviewTaskId: selectedDecision?.reviewTaskId,
      });
      if (result.repairTaskId) {
        repairTaskIds.push(result.repairTaskId);
        if (result.created) createdTaskIds.push(result.repairTaskId);
      }
    }
    if (repairTaskIds.length === 0) {
      return { ok: false, message: '未能为验收根创建新的来源 repair。' };
    }
    await markAcceptanceFailureResolution(redis, root.task_id, repairTaskIds, false);
    return { ok: true, createdTaskIds };
  }

  const latest = root.resolution_task_id
    ? await redis.hgetall(keys.hash.task(root.resolution_task_id))
    : {};
  const sourceTaskId = latest.fix_for || root.task_id;
  const result = await ensureRepairTask(redis, sourceTaskId, {
    source: 'worker_failed',
    reason: `PM ${decidedBy} 显式 continue，额外放行一代修复。`,
    allowRetryLimitOverride: true,
  });
  if (!result.repairTaskId) {
    return { ok: false, message: '未能创建新的 repair generation。' };
  }
  if (result.created) createdTaskIds.push(result.repairTaskId);
  return { ok: true, createdTaskIds };
}

function continuationCreatedTaskIds(root: Record<string, string>): string[] {
  const before = new Set([
    ...(root.resolution_continue_snapshot_task_ids ?? '').split(','),
    ...(root.resolution_continue_snapshot_acceptance_repair_task_ids ?? '').split(','),
  ].filter(Boolean));
  return [
    ...(root.resolution_task_ids ?? '').split(','),
    ...(root.acceptance_repair_task_ids ?? '').split(','),
  ].filter((taskId) => taskId && !before.has(taskId));
}

async function rollbackInterruptedResolutionContinue(
  redis: Redis,
  root: Record<string, string>,
): Promise<void> {
  await redis.eval(
    ROLLBACK_INTERRUPTED_RESOLUTION_CONTINUE,
    3,
    keys.hash.task(root.task_id),
    keys.intakeActionableFailed.pending,
    keys.runtimeReconcile.pending,
    root.task_id,
    root.resolution_continue_owner ?? '',
    String(Date.now()),
    root.resolution_continue_snapshot_generation ?? '',
    root.resolution_continue_snapshot_task_ids ?? '',
    root.resolution_continue_snapshot_attempts ?? '',
    root.resolution_continue_snapshot_reason ?? 'repair_retry_limit_reached',
  );
}

/**
 * BEGIN 后进程中断或 owner 失锁时，低频 reconcile 重放确定性 child，
 * 再以 continuation owner 为幂等键补齐一次审计。活锁存在时不与原请求竞争。
 */
async function recoverInterruptedResolutionContinues(
  redis: Redis,
  candidateIds: Iterable<string>,
): Promise<void> {
  for (const taskId of new Set(candidateIds)) {
    let root = await redis.hgetall(keys.hash.task(taskId));
    if (!root.task_id || !root.resolution_continue_owner) continue;
    if (await redis.get(keys.string.pmReviewLock(root.task_id))) continue;

    // accepted/cancelled 可能在 continue 的 owner 锁过期后成为更新的不可逆结论。
    // 这种情况下只清理旧 intent，绝不能再创建下一代 child 覆盖后来决定。
    if (root.resolution_status === 'resolved' || root.resolution_status === 'cancelled') {
      await redis.hdel(
        keys.hash.task(root.task_id),
        'resolution_continue_owner',
        'resolution_continue_snapshot_generation',
        'resolution_continue_snapshot_repair_root',
        'resolution_continue_snapshot_reason',
        'resolution_continue_snapshot_task_ids',
        'resolution_continue_snapshot_attempts',
        'resolution_continue_snapshot_acceptance_repair_task_ids',
      );
      await redis.zrem(keys.runtimeReconcile.pending, root.task_id);
      await persistTaskFromRedis(redis, root.task_id);
      continue;
    }

    const work = await performResolutionContinueWork(
      redis,
      root,
      root.resolution_decided_by || 'pm-reconcile',
    );
    root = await redis.hgetall(keys.hash.task(taskId));
    if (!work.ok) {
      await rollbackInterruptedResolutionContinue(redis, root);
      continue;
    }

    const createdTaskIds = continuationCreatedTaskIds(root);
    const outcome = (await redis.eval(
      COMMIT_RECOVERED_RESOLUTION_CONTINUE_AUDIT,
      3,
      keys.hash.task(root.task_id),
      keys.stream.events,
      keys.runtimeReconcile.pending,
      root.task_id,
      root.plan_id ?? '',
      root.resolution_continue_snapshot_generation ?? '',
      root.resolution_continue_snapshot_repair_root ?? '',
      root.resolution_continue_snapshot_reason ?? '',
      root.resolution_continue_owner ?? '',
      root.resolution_decided_by || 'pm-reconcile',
      root.resolution_decided_at || String(Date.now()),
      root.project_path ?? '',
      createdTaskIds.join(','),
    )) as string[];
    const state = String(outcome?.[0] ?? '');
    if (state === 'NOT_READY') await rollbackInterruptedResolutionContinue(redis, root);
  }
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
  const requiresRepairSource = (root.resolution_decision_reason ?? '').startsWith('repair_sources_required:');
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
    ...(requiresRepairSource ? { repair_source_candidates: acceptanceSourceIds(root) } : {}),
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
  const decisionLock = await acquirePmReviewLock(redis, rootTaskId);
  if (!decisionLock) {
    return {
      ok: false,
      data: null,
      error: { code: 'RESOLUTION_DECISION_IN_PROGRESS', message: `任务 ${rootTaskId} 正在执行另一条决策，请稍后重试。` },
    };
  }

  return runWithPmDecisionLockCleanup(redis, rootTaskId, decisionLock, async () => {
    const resolved = await resolveDecisionRoot(redis, rootTaskId);
    if (!resolved) {
      return { ok: false, data: null, error: { code: 'TASK_NOT_FOUND', message: `任务不存在：${rootTaskId}` } };
    }
    let root = resolved.root;

    root = await normalizeRepairSourcesDecisionReason(redis, root);

    const acceptedWinner = await latestAcceptedResolutionChild(redis, root);
    if (acceptedWinner) {
      // accepted 是不可逆的产品闭合边界。后续某个冗余 generation 被 reject 后，PM
      // 选择 cancel 只能停止冗余尝试，不能把已经验收的根任务降级成 cancelled。
      // 同一分支也修复旧版本已经写入的 cancelled 脏态。
      await replayAcceptedRepairSideEffects(redis, acceptedWinner.task_id);
      root = await redis.hgetall(keys.hash.task(rootTaskId));
      if (req.action === 'continue') {
        return {
          ok: false,
          data: null,
          error: {
            code: 'RESOLUTION_ALREADY_RESOLVED',
            message: `根任务 ${rootTaskId} 已由 ${acceptedWinner.task_id} 验收闭环，不能继续创建新 generation。`,
          },
        };
      }
      if (req.action === 'cancel') {
        const now = Date.now();
        await redis.xadd(
          keys.stream.events,
          '*',
          'event_id', `${now}_resolution_redundant_cancel_${rootTaskId}`,
          'type', 'resolution_decided',
          'task_id', rootTaskId,
          'plan_id', root.plan_id ?? '',
          'project_path', root.project_path ?? '',
          'consumer', 'worker',
          'resolution_action', 'retain_accepted',
          'resolved_by_task', acceptedWinner.task_id,
          'decided_by', req.decided_by.trim(),
          'timestamp', String(now),
        );
        return { ok: true, data: resolutionDecisionData(taskId, root) };
      }
    }

    if (req.action === 'cancel' && root.resolution_status === 'cancelled') {
      return { ok: true, data: resolutionDecisionData(taskId, root) };
    }
    const cancelledRetryReason = (root.resolution_decision_reason ?? '').startsWith('cancelled:')
      ? (root.resolution_decision_reason ?? '').slice('cancelled:'.length)
      : '';
    const canReopenCancelled = req.action === 'continue' && root.resolution_status === 'cancelled' &&
      (cancelledRetryReason.startsWith('repair_retry_limit_reached') ||
       cancelledRetryReason.startsWith('reverify_retry_limit_reached') ||
       isMultiSourceAcceptanceReverifyDecision(root, cancelledRetryReason));
    if (root.resolution_status !== 'needs_pm_decision' && !canReopenCancelled) {
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
      const referencedChildren = [...new Set([
        root.resolution_task_id,
        ...(root.resolution_task_ids ?? '').split(','),
      ].map((taskId) => taskId.trim()).filter(Boolean))];
      for (const childTaskId of referencedChildren) {
        const child = await redis.hgetall(keys.hash.task(childTaskId));
        const active = child.task_id && (
          ['pending', 'running', 'blocked'].includes(child.status) ||
          (child.status === 'done' && !child.pm_review_status)
        );
        if (active) {
          return {
            ok: false,
            data: null,
            error: {
              code: 'RESOLUTION_CHILD_ACTIVE',
              message: `根任务 ${rootTaskId} 的子任务 ${childTaskId} 仍在 ${child.status}；请先终止或验收该子任务，再取消闭环。`,
            },
          };
        }
      }
      const originalReason = root.resolution_decision_reason || 'operator_cancelled';
      const outcome = (await redis.eval(
        COMMIT_RESOLUTION_CANCEL,
        8,
        keys.hash.task(rootTaskId),
        keys.planStatusProjection.planIds,
        keys.planStatusProjection.taskIdsByPlan(root.plan_id ?? ''),
        keys.planStatusProjection.revisionByPlan,
        keys.planStatusProjection.dirtyPlans,
        keys.intakeActionableFailed.pending,
        keys.string.pmReviewLock(rootTaskId),
        keys.stream.events,
        rootTaskId,
        root.plan_id ?? '',
        root.status ?? '',
        root.resolution_status ?? '',
        root.resolution_generation ?? '',
        root.repair_root_task_id ?? '',
        root.resolution_decision_reason ?? '',
        originalReason,
        req.decided_by.trim(),
        decisionLock.token,
        String(now),
        root.project_path ?? '',
      )) as string[];
      if (String(outcome?.[0] ?? '') !== 'COMMITTED') {
        return {
          ok: false,
          data: null,
          error: {
            code: 'RESOLUTION_DECISION_ROUND_CHANGED',
            message: `根任务 ${rootTaskId} 的决策锁或 resolution 轮次已变化；旧 cancel 未写入。`,
          },
        };
      }
      await persistTaskFromRedis(redis, rootTaskId);
      const cancelled = await redis.hgetall(keys.hash.task(rootTaskId));
      return { ok: true, data: resolutionDecisionData(taskId, cancelled) };
    }

    if (canReopenCancelled) {
      const outcome = (await redis.eval(
        COMMIT_RESOLUTION_REOPEN,
        9,
        keys.hash.task(rootTaskId),
        keys.planStatusProjection.planIds,
        keys.planStatusProjection.taskIdsByPlan(root.plan_id ?? ''),
        keys.planStatusProjection.revisionByPlan,
        keys.planStatusProjection.dirtyPlans,
        keys.intakeActionableFailed.pending,
        keys.string.pmReviewLock(rootTaskId),
        keys.runtimeReconcile.pending,
        keys.stream.events,
        rootTaskId,
        root.plan_id ?? '',
        root.status ?? '',
        root.resolution_status ?? '',
        root.resolution_generation ?? '',
        root.repair_root_task_id ?? '',
        root.resolution_decision_reason ?? '',
        cancelledRetryReason,
        req.decided_by.trim(),
        decisionLock.token,
        String(now),
        root.project_path ?? '',
      )) as string[];
      if (String(outcome?.[0] ?? '') !== 'COMMITTED') {
        return {
          ok: false,
          data: null,
          error: {
            code: 'RESOLUTION_DECISION_ROUND_CHANGED',
            message: `根任务 ${rootTaskId} 的决策锁或 cancelled 轮次已变化；旧 continue 未重开。`,
          },
        };
      }
      await persistTaskFromRedis(redis, rootTaskId);
      root = await redis.hgetall(keys.hash.task(rootTaskId));
    }

    let reason = root.resolution_decision_reason ?? '';
    if (reason.startsWith('repair_sources_required:')) {
      const requestedSourceIds = [...new Set([
        ...(req.repair_source_task_ids ?? []),
        ...(req.repair_source_task_id ? [req.repair_source_task_id] : []),
      ].map((id) => id.trim()).filter(Boolean))];
      if (requestedSourceIds.length === 0) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'REPAIR_SOURCE_TASK_REQUIRED',
            message: '多来源验收返修必须显式指定 repair_source_task_id，平台不会自动 fan-out。',
          },
        };
      }
      const sourceIds = acceptanceSourceIds(root);
      const invalidSourceId = requestedSourceIds.find((id) => !sourceIds.includes(id));
      if (invalidSourceId) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'INVALID_REPAIR_SOURCE_TASK',
            message: `返修来源 ${invalidSourceId} 不在验收任务 ${rootTaskId} 的 acceptance_for 中。`,
          },
        };
      }
      const reviewTaskId = reason.slice('repair_sources_required:'.length).trim();
      reason = `repair_sources_selected:${reviewTaskId}:${requestedSourceIds.join(',')}`;
      await mutateTaskWithPlanProjection(redis, rootTaskId, root.plan_id ?? '', {
        resolution_decision_reason: reason,
      });
      await persistTaskFromRedis(redis, rootTaskId);
      root = await redis.hgetall(keys.hash.task(rootTaskId));
    } else if (req.repair_source_task_id !== undefined || req.repair_source_task_ids !== undefined) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'REPAIR_SOURCE_TASK_NOT_APPLICABLE',
          message: 'repair_source_task_id 只能用于 repair_sources_required 决策。',
        },
      };
    }
    const retryable = reason.startsWith('repair_retry_limit_reached') ||
      reason.startsWith('repair_sources_selected:') ||
      reason.startsWith('reverify_retry_limit_reached') ||
      isMultiSourceAcceptanceReverifyDecision(root, reason);
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

    // continue 的第一条有副作用写入前必须重新验证 owner token 与完整决策轮次。
    // 正常长操作由低频续租维持；即使 TTL 被人为缩短或进程停顿导致失锁，旧请求也
    // 会在创建新 generation 前 fail closed，而不是跨过后来 PM 的 cancel/reset。
    if (!(await beginResolutionContinue(redis, root, decisionLock.token, req.decided_by.trim(), now))) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'RESOLUTION_DECISION_ROUND_CHANGED',
          message: `根任务 ${rootTaskId} 的决策锁或 resolution 轮次已变化；旧 continue 未执行。`,
        },
      };
    }

    const work = await performResolutionContinueWork(redis, root, req.decided_by.trim());
    if (!work.ok) {
      const reserved = await redis.hgetall(keys.hash.task(rootTaskId));
      await rollbackInterruptedResolutionContinue(redis, reserved);
      await persistTaskFromRedis(redis, rootTaskId);
      return {
        ok: false,
        data: null,
        error: { code: 'RESOLUTION_CONTINUE_FAILED', message: work.message },
      };
    }
    const createdTaskIds = work.createdTaskIds;

    const continued = await redis.hgetall(keys.hash.task(rootTaskId));
    const continueAudit = (await redis.eval(
      COMMIT_RESOLUTION_CONTINUE_AUDIT,
      3,
      keys.hash.task(rootTaskId),
      keys.string.pmReviewLock(rootTaskId),
      keys.stream.events,
      ...resolutionRoundArgs(root),
      root.resolution_attempts ?? '',
      decisionLock.token,
      req.decided_by.trim(),
      String(now),
      root.project_path ?? '',
      createdTaskIds.join(','),
    )) as string[];
    if (String(continueAudit?.[0] ?? '') !== 'COMMITTED') {
      return {
        ok: false,
        data: null,
        error: {
          code: 'RESOLUTION_DECISION_ROUND_CHANGED',
          message: `根任务 ${rootTaskId} 的决策锁或 resolution generation 已变化；旧 continue 审计未提交。`,
        },
      };
    }
    return { ok: true, data: resolutionDecisionData(taskId, continued, createdTaskIds) };
  });
}

/** PM 验收（POST /task/:id/review）—— accept 记录通过 / reject 生成修复 task（软门，不改 done） */
export async function pmReview(
  redis: Redis,
  taskId: string,
  req: PmReviewRequest,
): Promise<PmReviewResponse> {
  const decisionLock = await acquirePmReviewLock(redis, taskId);
  if (!decisionLock) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'PM_REVIEW_IN_PROGRESS',
        message: `任务 ${taskId} 正在执行另一条验收决定，请稍后重试。`,
      },
    };
  }
  return runWithPmDecisionLockCleanup(redis, taskId, decisionLock, async () => {
    return await pmReviewLocked(redis, taskId, req, decisionLock.token);
  });
}

async function pmReviewLocked(
  redis: Redis,
  taskId: string,
  req: PmReviewRequest,
  lockToken: string,
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
  // Review 是独立于执行的第二道门。即使调用方拥有 PM token，也不能用与
  // claimed_by 相同的审计身份给自己的交付签字；否则 PM/Worker 入口一旦被误用，
  // 平台会把“自报完成”错误升级成 accepted。既有 accepted/rejected 仍允许精确
  // 幂等回放，避免升级后改写已经冻结的历史决定。
  if (!hash.pm_review_status && hash.claimed_by && req.reviewed_by === hash.claimed_by) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'PM_REVIEW_SELF_FORBIDDEN',
        message: `任务 ${taskId} 由 ${hash.claimed_by} 执行，必须由不同的 PM/验收身份独立复核。`,
      },
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
      await replayAcceptedRepairSideEffects(redis, taskId);
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
  // 旧 Worker 可能在 accepted winner 收敛根任务之前已经开始执行 sibling，并在
  // winner 生效之后才交付。该 late delivery 必须保留为审计，但不能再次 accept
  // 并篡改根的 resolved_by_task；只有同一 lineage 中真实 done+accepted winner 才
  // 构成这个拒绝门禁，避免陈旧 resolved 字段误伤合法 repair。
  if (!hash.pm_review_status && hash.fix_for) {
    const rootTaskId = hash.repair_root_task_id || hash.fix_for;
    const root = await redis.hgetall(keys.hash.task(rootTaskId));
    const belongsToRoot = (root.resolution_task_ids ?? '').split(',').filter(Boolean).includes(taskId);
    if (
      belongsToRoot && root.resolution_status === 'resolved' &&
      root.resolved_by_task && root.resolved_by_task !== taskId
    ) {
      const winner = await redis.hgetall(keys.hash.task(root.resolved_by_task));
      if (
        winner.task_id === root.resolved_by_task &&
        winner.repair_root_task_id === root.task_id &&
        winner.status === 'done' && winner.pm_review_status === 'accepted' &&
        !(await repairWasTriggeredAfterWinner(redis, hash, winner))
      ) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'REPAIR_SUPERSEDED_BY_ACCEPTED_WINNER',
            message: `任务 ${taskId} 是迟到的修复交付；根任务已由 ${winner.task_id} 验收闭环，保留交付审计但不能用新的 accept/reject 改写 winner 或重开根任务。`,
          },
        };
      }
    }
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

  if (
    req.verdict === 'accept' && hash.type === 'acceptance' &&
    hash.repair_root_task_id && hash.repair_root_task_id !== hash.task_id
  ) {
    const acceptanceRoot = await redis.hgetall(keys.hash.task(hash.repair_root_task_id));
    if (acceptanceRoot.type === 'acceptance') {
      const gate = await acceptanceReverifyRepairGate(redis, acceptanceRoot);
      if (!gate.allowed) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'ACCEPTANCE_REPAIR_REQUIRED',
            message: `最新验收决定 ${gate.reviewTaskId} 要求修复，尚无其后 accepted repair；当前复验不能直接关闭根任务。`,
          },
        };
      }
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
    let fixTaskIds = historicalTasks
      .filter((task) => task.task_id && (storedResolutionMode === 'reverify' ? task.type === 'acceptance' : task.type !== 'acceptance'))
      .map((task) => task.task_id);
    const sameText = req.reviewed_by === (hash.pm_reviewed_by ?? '') &&
      (req.comment ?? '') === (hash.pm_review_comment ?? '') &&
      (req.reject_reason ?? '') === (hash.pm_reject_reason ?? '') &&
      (req.fix_instructions ?? '') === (hash.pm_fix_instructions ?? '');
    let storedOwnership: NormalizedRepairOwnership | undefined;
    let requestedOwnership: NormalizedRepairOwnership | undefined;
    if (storedResolutionMode === 'reverify') {
      if (hash.pm_repair_ownership_required || hash.pm_repair_ownership_intent) {
        const reason = `repair_ownership_intent_forbidden:${taskId}`;
        await markResolutionNeedsPmDecision(redis, hash.repair_root_task_id || taskId, reason);
        await markAcceptanceFailureResolution(redis, taskId, [], true);
        return {
          ok: false,
          data: null,
          error: { code: 'REPAIR_OWNERSHIP_INTENT_INVALID', message: `验收拒绝扩权审计不一致：${reason}` },
        };
      }
    } else if (acceptanceFor.length !== 1 && (hash.pm_repair_ownership_required || hash.pm_repair_ownership_intent)) {
      const reason = `repair_ownership_intent_source_ambiguous:${taskId}`;
      await markResolutionNeedsPmDecision(redis, hash.repair_root_task_id || taskId, reason);
      await markAcceptanceFailureResolution(redis, taskId, [], true);
      return {
        ok: false,
        data: null,
        error: { code: 'REPAIR_OWNERSHIP_INTENT_INVALID', message: `显式 repair ownership 审计无法安全重放：${reason}` },
      };
    } else if (acceptanceFor.length === 1) {
      const source = await redis.hgetall(keys.hash.task(acceptanceFor[0]));
      const rootId = source.repair_root_task_id || source.task_id;
      const root = rootId === source.task_id ? source : await redis.hgetall(keys.hash.task(rootId));
      const stored = persistedRepairOwnershipIntent(hash, source, root);
      if (stored.error) {
        await markResolutionNeedsPmDecision(redis, hash.repair_root_task_id || taskId, stored.error);
        await markAcceptanceFailureResolution(redis, taskId, [], true);
        return {
          ok: false,
          data: null,
          error: { code: 'REPAIR_OWNERSHIP_INTENT_INVALID', message: `显式 repair ownership 审计无法安全重放：${stored.error}` },
        };
      }
      storedOwnership = stored.value;
      if (req.repair_ownership !== undefined) {
        const normalized = normalizeRepairOwnership(req.repair_ownership);
        const delta = normalized.value ? repairOwnershipDelta(source, root, normalized.value) : {};
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
        requestedOwnership = delta.value;
      }
    }
    const sameOwnership = sameRepairOwnership(storedOwnership, requestedOwnership);

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
    if (fixTaskIds.length === 0) {
      if (storedResolutionMode === 'reverify') {
        const reverify = await ensureAcceptanceReverifyTask(
          redis,
          hash.repair_root_task_id || taskId,
          `pm-reject-replay:${req.reviewed_by}`,
          { trigger: 'pm_reverify_only' },
        );
        fixTaskIds = reverify.taskId ? [reverify.taskId] : [];
      } else {
        if (acceptanceFor.length > 1) {
          const decisionRootId = hash.repair_root_task_id || hash.task_id;
          await markAcceptanceFailureResolution(redis, taskId, [], true);
          await markResolutionNeedsPmDecision(redis, decisionRootId, `repair_sources_required:${taskId}`);
        } else {
          const resolutions: ResolutionResult[] = [];
          for (const sourceTaskId of acceptanceFor) {
            resolutions.push(await ensureRepairTask(redis, sourceTaskId, {
              source: 'acceptance_failed',
              reason: `独立验收任务 ${taskId} 被 PM 拒绝。${hash.pm_reject_reason ? ` 原因：${hash.pm_reject_reason}` : ''}`,
              instructions: hash.pm_fix_instructions,
              repairOwnership: storedOwnership,
              decisionRootTaskId: hash.repair_root_task_id || hash.task_id,
            }));
          }
          fixTaskIds = resolutions.flatMap((resolution) => resolution.repairTaskId ? [resolution.repairTaskId] : []);
          await markAcceptanceFailureResolution(
            redis,
            taskId,
            fixTaskIds,
            resolutions.some((resolution) => resolution.state === 'needs_pm_decision'),
          );
        }
      }
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
    let fixTaskIds = historicalTasks.filter((task) => task.task_id).map((task) => task.task_id);
    const sameText = req.reviewed_by === (hash.pm_reviewed_by ?? '') &&
      (req.comment ?? '') === (hash.pm_review_comment ?? '') &&
      (req.reject_reason ?? '') === (hash.pm_reject_reason ?? '') &&
      (req.fix_instructions ?? '') === (hash.pm_fix_instructions ?? '');
    const rootId = hash.repair_root_task_id || hash.task_id;
    const root = rootId === hash.task_id ? hash : await redis.hgetall(keys.hash.task(rootId));
    const stored = persistedRepairOwnershipIntent(hash, hash, root);
    if (stored.error) {
      await markResolutionNeedsPmDecision(redis, rootId, stored.error);
      return {
        ok: false,
        data: null,
        error: { code: 'REPAIR_OWNERSHIP_INTENT_INVALID', message: `显式 repair ownership 审计无法安全重放：${stored.error}` },
      };
    }
    let requestedOwnership: NormalizedRepairOwnership | undefined;
    if (req.repair_ownership !== undefined) {
      const normalized = normalizeRepairOwnership(req.repair_ownership);
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
      requestedOwnership = delta.value;
    }
    const sameOwnership = sameRepairOwnership(stored.value, requestedOwnership);
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
    // 进程可能在“写入不可变 reject 审计”与“创建 repair”之间退出。精确重复
    // reject 不能把空 repair 列表当作成功闭环；在同一 PM review 锁内幂等补建。
    if (fixTaskIds.length === 0) {
      const resolution = await ensureRepairTask(redis, taskId, {
        source: 'pm_rejected',
        reason: hash.pm_reject_reason,
        instructions: hash.pm_fix_instructions,
        repairOwnership: stored.value,
      });
      fixTaskIds = resolution.repairTaskId ? [resolution.repairTaskId] : [];
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
    const accepted = await commitPmReviewAudit(redis, taskId, hash, now, {
      pm_review_status: 'accepted',
      pm_reviewed_by: req.reviewed_by,
      pm_reviewed_at: String(now),
      pm_review_comment: req.comment ?? '',
    }, lockToken);
    if (!accepted) {
      return {
        ok: false,
        data: null,
        error: {
          code: 'TASK_REVIEW_ROUND_CHANGED',
          message: `任务 ${taskId} 在验收提交前已进入新的状态或交付轮次，请重新读取后再验收。`,
        },
      };
    }
    sqliteStore?.updateTaskFields(taskId, {
      pm_review_status: 'accepted',
      pm_reviewed_by: req.reviewed_by,
      pm_reviewed_at: String(now),
      pm_review_comment: req.comment ?? '',
    });
    // PM accept 是普通下游真正的 dependency-ready 边界。副作用通过同一个幂等
    // replay 入口提交，使网络重试和低频 reconcile 都能补偿 accepted 写入后的崩溃。
    await replayAcceptedRepairSideEffects(redis, taskId);
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
  const repairOwnershipIntent = repairOwnership ? serializedRepairOwnership(repairOwnership) : '';
  const rejected = await commitPmReviewAudit(redis, taskId, hash, now, {
    pm_review_status: 'rejected',
    pm_reviewed_by: req.reviewed_by,
    pm_reviewed_at: String(now),
    pm_review_comment: req.comment ?? '',
    pm_reject_reason: req.reject_reason ?? '',
    pm_fix_instructions: req.fix_instructions ?? '',
    pm_rejection_resolution_mode: hash.type === 'acceptance' ? requestedResolutionMode : '',
    pm_repair_ownership_required: repairOwnership ? 'true' : '',
    pm_repair_ownership_intent: repairOwnershipIntent,
    ...(hash.type === 'acceptance' && requestedResolutionMode === 'reverify'
      ? {
          resolution_status: 'required',
          resolution_action: 'reverify',
          resolution_task_id: '',
          resolved_by_task: '',
          resolution_decision_reason: '',
        }
      : {}),
  }, lockToken);
  if (!rejected) {
    return {
      ok: false,
      data: null,
      error: {
        code: 'TASK_REVIEW_ROUND_CHANGED',
        message: `任务 ${taskId} 在验收提交前已进入新的状态或交付轮次，请重新读取后再验收。`,
      },
    };
  }
  sqliteStore?.updateTaskFields(taskId, {
    pm_review_status: 'rejected',
    pm_reviewed_by: req.reviewed_by,
    pm_reviewed_at: String(now),
    pm_review_comment: req.comment ?? '',
    pm_reject_reason: req.reject_reason ?? '',
    pm_fix_instructions: req.fix_instructions ?? '',
    pm_rejection_resolution_mode: hash.type === 'acceptance' ? requestedResolutionMode : '',
    pm_repair_ownership_required: repairOwnership ? 'true' : '',
    pm_repair_ownership_intent: repairOwnershipIntent,
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
    } else if (acceptanceFor.length > 1) {
      // 多来源验收发现产品缺陷时，先冻结本次 reject 审计，再进入现有的
      // repair_sources_required 两阶段决策。PM 必须 inspect 后显式点名最小来源；
      // 在点名前绝不自动 fan-out，也不能因为门禁报错让 review 门铃永久重放。
      await markAcceptanceFailureResolution(redis, taskId, [], true);
      await markResolutionNeedsPmDecision(
        redis,
        hash.repair_root_task_id || hash.task_id,
        `repair_sources_required:${taskId}`,
      );
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
    const acceptanceOwner = await selectedRepairAcceptanceRoot(redis, {
      ...hash,
      pm_review_status: 'rejected',
    });
    if (acceptanceOwner) {
      // 返修来源是 PM 对多来源验收的显式选择。拒绝该返修只应重新打开同一个
      // acceptance 决策，不得短暂为来源根再生第二个 resolution_required。
      await restoreAcceptedSourceAfterSelectedRepairReject(redis, hash);
      await markAcceptanceFailureResolution(redis, acceptanceOwner.task_id, [], true);
      await markResolutionNeedsPmDecision(
        redis,
        acceptanceOwner.task_id,
        // 这次来源 repair 的 PM reject 才是下一代必须执行的最新不可变要求。
        // 旧 trigger 仍保留在被拒 child 上作 provenance，但不能继续充当新任务说明。
        `repair_sources_required:${taskId}`,
      );
    } else {
      resolutions.push(await ensureRepairTask(redis, taskId, {
        source: 'pm_rejected',
        reason: req.reject_reason,
        instructions: req.fix_instructions,
        repairOwnership,
      }));
    }
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
  fix_for?: string;
  resolution_status?: string;
  repair_root_task_id?: string;
  resolution_task_id?: string;
  resolution_task_ids?: string[];
  resolved_by_task?: string;
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
  const hasActiveCurrentChild = (task: PlanTaskState) => {
    const child = task.resolution_task_id ? byId.get(task.resolution_task_id) : undefined;
    return Boolean(child && (
      ['pending', 'running', 'blocked'].includes(child.status) ||
      (child.status === 'done' && !child.review_status)
    ));
  };
  // 终态规则：
  // - completed：所有非历史根任务均 done+accepted 或 resolved；
  // - cancelled：没有任何有效根任务，或有显式 task/resolution cancel，或执行过 plan 批量 supersede；
  // - failed：未闭合 rejected/failed 或 needs_pm_decision；
  // - active：其余 pending/running/blocked/repairing/required 状态。
  // 单任务 supersede 只退出历史伪完成，不应污染已闭合的真实范围。
  // 一旦 task 进入 resolution，旧的 done/accepted 不再构成完成依据。
  if (effective.some((task) =>
    !completed(task) && !resolutionCancelled(task) && !hasActiveCurrentChild(task) &&
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

type PlanTaskCounters = {
  pending: number;
  running: number;
  blocked: number;
  done: number;
  failed: number;
  cancelled: number;
  superseded: number;
};

type RootTaskLifecycleCounters = {
  total: number;
  pending: number;
  running: number;
  blocked: number;
  review_pending: number;
  accepted: number;
  failed: number;
  needs_pm_decision: number;
  cancelled: number;
};

type RootTaskLifecycleSummary = RootTaskLifecycleCounters & {
  declared_total: number;
  consistent: boolean;
};

interface PlanStatusProjection {
  status: 'submitted' | 'active' | 'failed' | 'completed' | 'cancelled';
  tasks: PlanTaskCounters;
  /** 原始 attempt 审计计数，兼容旧 CLI/API。 */
  reviews: { pending: number; accepted: number; rejected: number };
  /** 面向产品任务的根谱系计数；repair/reverify 不会重复增加任务数。 */
  rootReviews: { pending: number; accepted: number; rejected: number };
  rootTasks: RootTaskLifecycleCounters;
  attention: { failed: number; rejected: number; needs_pm_decision: number };
  history: { resolved_failed: number; resolved_rejected: number };
  runtimeTaskCount: number;
}

// v5 additionally makes root lifecycle counters prefer the active current child over a stale
// needs_pm_decision marker. Bumping the version is required so existing v4 aggregates rebuild.
const PLAN_STATUS_PROJECTION_VERSION = '5';
const PLAN_STATUS_VALUES = new Set(['submitted', 'active', 'failed', 'completed', 'cancelled']);
const PLAN_TASK_STATUS_VALUES = ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'] as const;

function emptyPlanTaskCounters(): PlanTaskCounters {
  return { pending: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0, superseded: 0 };
}

function emptyRootTaskLifecycleCounters(): RootTaskLifecycleCounters {
  return {
    total: 0, pending: 0, running: 0, blocked: 0, review_pending: 0,
    accepted: 0, failed: 0, needs_pm_decision: 0, cancelled: 0,
  };
}

function rootTaskLifecycleSummary(
  counters: RootTaskLifecycleCounters,
  declaredTotal: number,
): RootTaskLifecycleSummary {
  return { ...counters, declared_total: declaredTotal, consistent: counters.total === declaredTotal };
}

function planTaskStateFromHash(task: Record<string, string>): PlanTaskState {
  return {
    task_id: task.task_id,
    status: task.status,
    review_status: task.pm_review_status || undefined,
    fix_for: task.fix_for || undefined,
    resolution_status: task.resolution_status || undefined,
    repair_root_task_id: task.repair_root_task_id || undefined,
    resolution_task_id: task.resolution_task_id || undefined,
    resolution_task_ids: task.resolution_task_ids ? task.resolution_task_ids.split(',').filter(Boolean) : undefined,
    resolved_by_task: task.resolved_by_task || undefined,
    supersede_batch_size: task.supersede_batch_size ? Number(task.supersede_batch_size) : undefined,
  };
}

function planTaskStateFromRow(task: TaskRow): PlanTaskState {
  return {
    task_id: task.task_id,
    status: task.status,
    review_status: task.pm_review_status || undefined,
    fix_for: task.fix_for || undefined,
    resolution_status: task.resolution_status || undefined,
    repair_root_task_id: task.repair_root_task_id || undefined,
    resolution_task_id: task.resolution_task_id || undefined,
    resolution_task_ids: task.resolution_task_ids ? task.resolution_task_ids.split(',').filter(Boolean) : undefined,
    resolved_by_task: task.resolved_by_task || undefined,
    supersede_batch_size: task.supersede_batch_size || undefined,
  };
}

/** 单个 plan 的完整统计真相；只在 backfill、状态转换或当前 plan 轮询时重建。 */
function buildPlanStatusProjection(tasks: PlanTaskState[]): PlanStatusProjection {
  const counters = emptyPlanTaskCounters();
  const reviews = { pending: 0, accepted: 0, rejected: 0 };
  const rootReviews = { pending: 0, accepted: 0, rejected: 0 };
  const rootTasks = emptyRootTaskLifecycleCounters();
  const attention = { failed: 0, rejected: 0, needs_pm_decision: 0 };
  const history = { resolved_failed: 0, resolved_rejected: 0 };
  const isClosedResolution = (status: string | undefined) => status === 'resolved' || status === 'cancelled';
  const isActiveResolution = (status: string | undefined) => status === 'required' || status === 'repairing';
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const activeCurrentChild = (root: PlanTaskState): PlanTaskState | undefined => {
    const child = root.resolution_task_id ? byId.get(root.resolution_task_id) : undefined;
    return child && (
      ['pending', 'running', 'blocked'].includes(child.status) ||
      (child.status === 'done' && !child.review_status)
    ) ? child : undefined;
  };
  const effectiveRoot = (task: PlanTaskState): PlanTaskState => {
    const rootId = task.repair_root_task_id;
    return rootId && rootId !== task.task_id ? byId.get(rootId) ?? task : task;
  };
  const effectiveResolution = (task: PlanTaskState): string | undefined => {
    const root = effectiveRoot(task);
    return root.resolution_status || task.resolution_status;
  };
  const rejectedAttentionRoots = new Set<string>();
  const failedAttentionRoots = new Set<string>();
  const decisionRoots = new Set<string>();

  for (const task of tasks) {
    if (PLAN_TASK_STATUS_VALUES.includes(task.status as typeof PLAN_TASK_STATUS_VALUES[number])) {
      counters[task.status as keyof PlanTaskCounters]++;
    }
    if (task.status === 'done') {
      if (task.review_status === 'accepted') reviews.accepted++;
      else if (task.review_status === 'rejected') {
        reviews.rejected++;
        const root = effectiveRoot(task);
        const resolution = effectiveResolution(task);
        if (resolution === 'resolved') history.resolved_rejected++;
        else if (!isClosedResolution(resolution) && !isActiveResolution(resolution)) {
          if (root.task_id ?? task.task_id) rejectedAttentionRoots.add((root.task_id ?? task.task_id)!);
        }
        if (resolution === 'needs_pm_decision' && !activeCurrentChild(root) && (root.task_id ?? task.task_id)) {
          decisionRoots.add((root.task_id ?? task.task_id)!);
        }
      } else {
        reviews.pending++;
      }
    }
    if (task.status === 'failed') {
      const root = effectiveRoot(task);
      const resolution = effectiveResolution(task);
      if (resolution === 'resolved') history.resolved_failed++;
      else if (!isClosedResolution(resolution) && !isActiveResolution(resolution)) {
        if (root.task_id ?? task.task_id) failedAttentionRoots.add((root.task_id ?? task.task_id)!);
      }
      if (resolution === 'needs_pm_decision' && !activeCurrentChild(root) && (root.task_id ?? task.task_id)) {
        decisionRoots.add((root.task_id ?? task.task_id)!);
      }
    }
  }

  const declaredRoots = tasks.filter((task) =>
    !task.fix_for && (!task.repair_root_task_id || task.repair_root_task_id === task.task_id),
  );
  const isAcceptedResolution = (root: PlanTaskState): boolean => {
    if (root.resolution_status !== 'resolved' || !root.task_id || !root.resolved_by_task) return false;
    const acceptedChild = byId.get(root.resolved_by_task);
    return Boolean(
      acceptedChild &&
      acceptedChild.task_id === root.resolved_by_task &&
      acceptedChild.repair_root_task_id === root.task_id &&
      acceptedChild.status === 'done' &&
      acceptedChild.review_status === 'accepted',
    );
  };
  for (const root of declaredRoots) {
    rootTasks.total++;
    const acceptedResolution = isAcceptedResolution(root);
    const activeChild = activeCurrentChild(root);
    if (['cancelled', 'superseded'].includes(root.status) || root.resolution_status === 'cancelled') {
      rootTasks.cancelled++;
    } else if (acceptedResolution || (!root.resolution_status && root.status === 'done' && root.review_status === 'accepted')) {
      rootTasks.accepted++;
    } else if (activeChild?.status === 'pending') {
      rootTasks.pending++;
    } else if (activeChild?.status === 'running') {
      rootTasks.running++;
    } else if (activeChild?.status === 'blocked') {
      rootTasks.blocked++;
    } else if (activeChild?.status === 'done' && !activeChild.review_status) {
      rootTasks.review_pending++;
    } else if (root.resolution_status === 'needs_pm_decision') {
      rootTasks.needs_pm_decision++;
    } else if (['required', 'repairing'].includes(root.resolution_status ?? '')) {
      const current = root.resolution_task_id ? byId.get(root.resolution_task_id) : undefined;
      if (current?.status === 'pending') rootTasks.pending++;
      else if (current?.status === 'running') rootTasks.running++;
      else if (current?.status === 'blocked') rootTasks.blocked++;
      else if (current?.status === 'done' && !current.review_status) rootTasks.review_pending++;
      else rootTasks.failed++;
    } else if (root.status === 'pending') rootTasks.pending++;
    else if (root.status === 'running') rootTasks.running++;
    else if (root.status === 'blocked') rootTasks.blocked++;
    else if (root.status === 'done' && !root.review_status) rootTasks.review_pending++;
    else rootTasks.failed++;

    if (['cancelled', 'superseded'].includes(root.status) || root.resolution_status === 'cancelled') continue;
    if (acceptedResolution || (!root.resolution_status && root.status === 'done' && root.review_status === 'accepted')) {
      rootReviews.accepted++;
      continue;
    }
    if (['required', 'repairing'].includes(root.resolution_status ?? '')) {
      const current = root.resolution_task_id ? byId.get(root.resolution_task_id) : undefined;
      if (current?.status === 'done' && !current.review_status) rootReviews.pending++;
      else if (current?.status === 'done' && current.review_status === 'rejected') rootReviews.rejected++;
      continue;
    }
    if (root.status === 'done') {
      if (!root.review_status) rootReviews.pending++;
      else if (root.review_status === 'rejected') rootReviews.rejected++;
    } else if (root.status === 'failed' || root.resolution_status === 'needs_pm_decision' || root.resolution_status === 'resolved') {
      // bare/stale resolved marker 不能成为绿色验收；没有可验证 accepted child 时 fail-closed。
      rootReviews.rejected++;
    }
  }

  attention.rejected = rejectedAttentionRoots.size;
  attention.failed = failedAttentionRoots.size;
  attention.needs_pm_decision = decisionRoots.size;

  return {
    status: derivePlanStatus(tasks),
    tasks: counters,
    reviews,
    rootReviews,
    rootTasks,
    attention,
    history,
    runtimeTaskCount: tasks.length,
  };
}

function planStatusProjectionHash(projection: PlanStatusProjection): Record<string, string> {
  return {
    version: PLAN_STATUS_PROJECTION_VERSION,
    status: projection.status,
    runtime_task_count: String(projection.runtimeTaskCount),
    task_pending: String(projection.tasks.pending),
    task_running: String(projection.tasks.running),
    task_blocked: String(projection.tasks.blocked),
    task_done: String(projection.tasks.done),
    task_failed: String(projection.tasks.failed),
    task_cancelled: String(projection.tasks.cancelled),
    task_superseded: String(projection.tasks.superseded),
    review_pending: String(projection.reviews.pending),
    review_accepted: String(projection.reviews.accepted),
    review_rejected: String(projection.reviews.rejected),
    root_review_pending: String(projection.rootReviews.pending),
    root_review_accepted: String(projection.rootReviews.accepted),
    root_review_rejected: String(projection.rootReviews.rejected),
    root_task_total: String(projection.rootTasks.total),
    root_task_pending: String(projection.rootTasks.pending),
    root_task_running: String(projection.rootTasks.running),
    root_task_blocked: String(projection.rootTasks.blocked),
    root_task_review_pending: String(projection.rootTasks.review_pending),
    root_task_accepted: String(projection.rootTasks.accepted),
    root_task_failed: String(projection.rootTasks.failed),
    root_task_needs_pm_decision: String(projection.rootTasks.needs_pm_decision),
    root_task_cancelled: String(projection.rootTasks.cancelled),
    attention_failed: String(projection.attention.failed),
    attention_rejected: String(projection.attention.rejected),
    attention_needs_pm_decision: String(projection.attention.needs_pm_decision),
    history_resolved_failed: String(projection.history.resolved_failed),
    history_resolved_rejected: String(projection.history.resolved_rejected),
  };
}

function parseProjectionInteger(hash: Record<string, string>, field: string): number | undefined {
  const value = Number(hash[field]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function planStatusProjectionFromHash(hash: Record<string, string>): PlanStatusProjection | undefined {
  if (hash.version !== PLAN_STATUS_PROJECTION_VERSION || !PLAN_STATUS_VALUES.has(hash.status)) return undefined;
  const fields = [
    'runtime_task_count',
    ...PLAN_TASK_STATUS_VALUES.map((status) => `task_${status}`),
    'review_pending', 'review_accepted', 'review_rejected',
    'root_review_pending', 'root_review_accepted', 'root_review_rejected',
    'root_task_total', 'root_task_pending', 'root_task_running', 'root_task_blocked',
    'root_task_review_pending', 'root_task_accepted', 'root_task_failed',
    'root_task_needs_pm_decision', 'root_task_cancelled',
    'attention_failed', 'attention_rejected', 'attention_needs_pm_decision',
    'history_resolved_failed', 'history_resolved_rejected',
  ];
  const values = new Map(fields.map((field) => [field, parseProjectionInteger(hash, field)]));
  if ([...values.values()].some((value) => value === undefined)) return undefined;
  const read = (field: string) => values.get(field)!;
  return {
    status: hash.status as PlanStatusProjection['status'],
    runtimeTaskCount: read('runtime_task_count'),
    tasks: {
      pending: read('task_pending'), running: read('task_running'), blocked: read('task_blocked'),
      done: read('task_done'), failed: read('task_failed'), cancelled: read('task_cancelled'),
      superseded: read('task_superseded'),
    },
    reviews: {
      pending: read('review_pending'), accepted: read('review_accepted'), rejected: read('review_rejected'),
    },
    rootReviews: {
      pending: read('root_review_pending'), accepted: read('root_review_accepted'), rejected: read('root_review_rejected'),
    },
    rootTasks: {
      total: read('root_task_total'), pending: read('root_task_pending'), running: read('root_task_running'),
      blocked: read('root_task_blocked'), review_pending: read('root_task_review_pending'),
      accepted: read('root_task_accepted'), failed: read('root_task_failed'),
      needs_pm_decision: read('root_task_needs_pm_decision'), cancelled: read('root_task_cancelled'),
    },
    attention: {
      failed: read('attention_failed'), rejected: read('attention_rejected'),
      needs_pm_decision: read('attention_needs_pm_decision'),
    },
    history: {
      resolved_failed: read('history_resolved_failed'),
      resolved_rejected: read('history_resolved_rejected'),
    },
  };
}

const COMMIT_PLAN_STATUS_PROJECTION = `
local current = redis.call('HGET', KEYS[1], ARGV[1]) or '0'
if current ~= ARGV[2] then return 0 end
local field_count = tonumber(ARGV[3]) or 0
local fields_end = 3 + field_count * 2
for index = 4, fields_end, 2 do
  redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
end
-- stale membership is derived from the exact same revision snapshot. It must not be
-- deleted before the CAS: a concurrent task create/reindex may have made it valid again.
for index = fields_end + 1, #ARGV do
  redis.call('SREM', KEYS[4], ARGV[index])
end
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`;

/**
 * 重建单个 plan。revision CAS 避免“读取 task 后、写 aggregate 前”发生的新转换被
 * SREM 吞掉；冲突时 dirty 会保留，下一轮（或本轮重试）继续处理。
 */
async function refreshPlanStatusProjection(redis: Redis, planId: string): Promise<PlanStatusProjection> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = await redis.hget(keys.planStatusProjection.revisionByPlan, planId) ?? '0';
    const taskIds = await redis.smembers(keys.planStatusProjection.taskIdsByPlan(planId));
    const hashes = await readTaskHashesInChunks(redis, taskIds);
    const valid = hashes.filter((task) => task.task_id && task.plan_id === planId);
    const validTaskIds = new Set(valid.map((task) => task.task_id));
    const staleIds = taskIds.filter((taskId) => !validTaskIds.has(taskId));
    const projection = buildPlanStatusProjection(valid.map(planTaskStateFromHash));
    const fields = Object.entries(planStatusProjectionHash(projection)).flat();
    const committed = Number(await redis.eval(
      COMMIT_PLAN_STATUS_PROJECTION,
      4,
      keys.planStatusProjection.revisionByPlan,
      keys.planStatusProjection.aggregateByPlan(planId),
      keys.planStatusProjection.dirtyPlans,
      keys.planStatusProjection.taskIdsByPlan(planId),
      planId,
      revision,
      String(fields.length / 2),
      ...fields,
      ...staleIds,
    ));
    if (committed === 1) return projection;
  }
  // 高频转换下宁可保留 dirty 并返回最后一次当前快照，也不能误清标志。
  const taskIds = await redis.smembers(keys.planStatusProjection.taskIdsByPlan(planId));
  const hashes = await readTaskHashesInChunks(redis, taskIds);
  return buildPlanStatusProjection(
    hashes.filter((task) => task.task_id && task.plan_id === planId).map(planTaskStateFromHash),
  );
}

async function refreshDirtyPlanStatusProjections(redis: Redis): Promise<void> {
  const dirtyPlans = await redis.smembers(keys.planStatusProjection.dirtyPlans);
  for (let offset = 0; offset < dirtyPlans.length; offset += 20) {
    await Promise.all(dirtyPlans.slice(offset, offset + 20).map((planId) => refreshPlanStatusProjection(redis, planId)));
  }
}

async function readHashesByKeysInChunks(
  redis: Redis,
  hashKeys: Iterable<string>,
): Promise<Array<Record<string, string>>> {
  const allKeys = [...hashKeys];
  const hashes: Array<Record<string, string>> = [];
  for (let offset = 0; offset < allKeys.length; offset += 500) {
    hashes.push(...await Promise.all(allKeys.slice(offset, offset + 500).map((key) => redis.hgetall(key))));
  }
  return hashes;
}

const RELEASE_PLAN_STATUS_BACKFILL_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Backfill 的唯一发布点。扫描可以超过 lock TTL；只有发布瞬间仍持有 owner token 的
 * 调用者能触碰 live aggregate/registries/ready。旧 owner 晚到时返回 0，不会覆盖新
 * owner 的 snapshot，也不会清掉新 owner 留下的 dirty。
 *
 * KEYS: lock, ready, plan registry, agent registry, agent-ready,
 *       then [task-registry, aggregate] for every encoded plan.
 * ARGV: owner, version, agent-count, agents..., plan-count,
 *       then per plan: plan-id, task-count, task ids..., field-count, field/value...
 */
const PUBLISH_PLAN_STATUS_BACKFILL_FENCED = `
-- plan-status-projection-fenced-backfill-v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local cursor = 3
local agent_count = tonumber(ARGV[cursor]) or 0
cursor = cursor + 1
-- agent 索引是 append-only 注册审计：register/restore 会随时增量 SADD，
-- 本快照只做并集补充，绝不能 DEL 清空后再重建（会丢掉与 backfill 并发注册的 Agent）。
for index = 1, agent_count do
  redis.call('SADD', KEYS[4], ARGV[cursor])
  cursor = cursor + 1
end
redis.call('SET', KEYS[5], ARGV[2])

local plan_count = tonumber(ARGV[cursor]) or 0
cursor = cursor + 1
redis.call('DEL', KEYS[3])
for plan_index = 1, plan_count do
  local plan_id = ARGV[cursor]
  cursor = cursor + 1
  local task_count = tonumber(ARGV[cursor]) or 0
  cursor = cursor + 1
  local task_key = KEYS[4 + plan_index * 2]
  local aggregate_key = KEYS[5 + plan_index * 2]
  redis.call('DEL', task_key)
  redis.call('DEL', aggregate_key)
  redis.call('SADD', KEYS[3], plan_id)
  for task_index = 1, task_count do
    redis.call('SADD', task_key, ARGV[cursor])
    cursor = cursor + 1
  end
  local field_count = tonumber(ARGV[cursor]) or 0
  cursor = cursor + 1
  for field_index = 1, field_count do
    redis.call('HSET', aggregate_key, ARGV[cursor], ARGV[cursor + 1])
    cursor = cursor + 2
  end
end

-- ready 必须是最后一个写入；任何 WRONGTYPE/脚本错误都不能发布半投影。
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const DELETE_PLAN_STATUS_READY_IF_OWNER = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[2])
`;

async function waitForPlanStatusBackfill(redis: Redis): Promise<void> {
  // 正常万级升级只需数百毫秒。并发首读等待同一份 durable marker，不各自重扫历史；
  // owner 崩溃时锁会自动过期，随后当前请求接管重建。
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await redis.get(keys.planStatusProjection.ready) === PLAN_STATUS_PROJECTION_VERSION) return;
    if (!(await redis.exists(keys.planStatusProjection.backfillLock))) return ensurePlanStatusProjection(redis);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('plan status projection backfill timed out');
}

/** 首次升级一次性回建；ready 发布后，稳态永远不再扫描历史 task keys。 */
async function ensurePlanStatusProjection(redis: Redis): Promise<void> {
  if (await redis.get(keys.planStatusProjection.ready) === PLAN_STATUS_PROJECTION_VERSION) {
    await refreshDirtyPlanStatusProjections(redis);
    return;
  }

  const backfillOwner = randomUUID();
  const backfillTtlMs = 30_000;
  const acquired = await redis.set(
    keys.planStatusProjection.backfillLock,
    backfillOwner,
    'PX',
    backfillTtlMs,
    'NX',
  );
  if (acquired !== 'OK') {
    await waitForPlanStatusBackfill(redis);
    await refreshDirtyPlanStatusProjections(redis);
    return;
  }
  const renewal = startBackfillLockRenewal(
    redis,
    keys.planStatusProjection.backfillLock,
    backfillOwner,
    backfillTtlMs,
  );

  try {
    // ready 可能在 SET NX 前由上一位 owner 发布；持锁后二次检查避免无意义重扫。
    if (await redis.get(keys.planStatusProjection.ready) === PLAN_STATUS_PROJECTION_VERSION) {
      await refreshDirtyPlanStatusProjections(redis);
      return;
    }

    const includeLegacyAgents = await redis.get(keys.planStatusProjection.agentIdsReady) !==
      PLAN_STATUS_PROJECTION_VERSION;
    const [taskKeys, planKeys, agentKeys] = await Promise.all([
      scanKeys(redis, `${PREFIX}:hash:task:*`),
      scanKeys(redis, `${PREFIX}:hash:plan:*`),
      includeLegacyAgents ? scanKeys(redis, `${PREFIX}:hash:agent:*`) : Promise.resolve([]),
    ]);
    const [taskHashes, planHashes, agentHashes] = await Promise.all([
      readHashesByKeysInChunks(redis, taskKeys),
      readHashesByKeysInChunks(redis, planKeys),
      readHashesByKeysInChunks(redis, agentKeys),
    ]);
    const statesByPlan = new Map<string, PlanTaskState[]>();
    const idsByPlan = new Map<string, string[]>();
    for (const task of taskHashes) {
      if (!task.task_id || !task.plan_id) continue;
      const states = statesByPlan.get(task.plan_id) ?? [];
      states.push(planTaskStateFromHash(task));
      statesByPlan.set(task.plan_id, states);
      const ids = idsByPlan.get(task.plan_id) ?? [];
      ids.push(task.task_id);
      idsByPlan.set(task.plan_id, ids);
    }
    const planIds = new Set([
      ...planHashes.map((plan) => plan.plan_id).filter(Boolean),
      ...statesByPlan.keys(),
    ]);

    const scannedAgentIds = agentHashes.map((agent) => agent.agent_id).filter(Boolean);
    // agentIdsReady 只证明索引已被增量维护，不证明本快照包含全部成员：
    // fresh namespace 中 Worker 可能在首个 /status 触发本 backfill 之前完成注册。
    // 发布快照必须与既有索引求并集，否则跳过 legacy 扫描时会用空快照覆盖注册索引。
    // 索引是 append-only 注册审计，多余成员由读取端按 hash.agent_id 存在性过滤。
    const indexedAgentIds = await redis.smembers(keys.planStatusProjection.agentIds);
    const agentIds = [...new Set([...indexedAgentIds, ...scannedAgentIds])];
    const orderedPlanIds = [...planIds].sort();
    const publishKeys = [
      keys.planStatusProjection.backfillLock,
      keys.planStatusProjection.ready,
      keys.planStatusProjection.planIds,
      keys.planStatusProjection.agentIds,
      keys.planStatusProjection.agentIdsReady,
      ...orderedPlanIds.flatMap((planId) => [
        keys.planStatusProjection.taskIdsByPlan(planId),
        keys.planStatusProjection.aggregateByPlan(planId),
      ]),
    ];
    const publishArgs: string[] = [
      backfillOwner,
      PLAN_STATUS_PROJECTION_VERSION,
      String(agentIds.length),
      ...agentIds,
      String(orderedPlanIds.length),
    ];
    for (const planId of orderedPlanIds) {
      const ids = idsByPlan.get(planId) ?? [];
      const aggregate = Object.entries(
        planStatusProjectionHash(buildPlanStatusProjection(statesByPlan.get(planId) ?? [])),
      );
      publishArgs.push(
        planId,
        String(ids.length),
        ...ids,
        String(aggregate.length),
        ...aggregate.flat(),
      );
    }
    if (renewal.state.lost) {
      throw renewal.state.error ?? new Error('plan status projection backfill lease lost');
    }
    const published = Number(await redis.eval(
      PUBLISH_PLAN_STATUS_BACKFILL_FENCED,
      publishKeys.length,
      ...publishKeys,
      ...publishArgs,
    ));
    if (published !== 1) {
      // lock 过期后另一 owner 可接管；旧 owner 只等待/复用其结果，绝不能发布旧快照。
      await waitForPlanStatusBackfill(redis);
      await refreshDirtyPlanStatusProjections(redis);
      return;
    }
    // backfill 期间发生的转换会留下 dirty+revision；marker 发布后马上收敛，且绝不
    // 清空 dirty set，避免吞掉并发状态转换。
    await refreshDirtyPlanStatusProjections(redis);
  } catch (error) {
    // 只能让仍持锁的失败 owner 撤销自己的 ready。过期旧 owner 不得删除后来 owner
    // 已发布的 marker，这是固定 TTL 锁真正需要的 fencing 边界。
    await redis.eval(
      DELETE_PLAN_STATUS_READY_IF_OWNER,
      2,
      keys.planStatusProjection.backfillLock,
      keys.planStatusProjection.ready,
      backfillOwner,
    ).catch(() => undefined);
    throw new Error(`plan status projection backfill failed: ${(error as Error).message}`, { cause: error });
  } finally {
    await renewal.stop();
    await redis.eval(
      RELEASE_PLAN_STATUS_BACKFILL_LOCK,
      1,
      keys.planStatusProjection.backfillLock,
      backfillOwner,
    ).catch(() => undefined);
  }
}

interface LoadedPlanStatusSummary {
  summary: BiaoPlanSummary;
  projection: PlanStatusProjection;
}

async function loadPlanStatusSummaries(redis: Redis): Promise<LoadedPlanStatusSummary[]> {
  await ensurePlanStatusProjection(redis);
  const planIds = await redis.smembers(keys.planStatusProjection.planIds);
  const planHashes = (await readHashesByKeysInChunks(
    redis,
    planIds.map((planId) => keys.hash.plan(planId)),
  )).filter((plan) => Boolean(plan.plan_id));
  let aggregateHashes = await readHashesByKeysInChunks(
    redis,
    planHashes.map((plan) => keys.planStatusProjection.aggregateByPlan(plan.plan_id)),
  );

  // 正常状态转换会 durable 标记 dirty；只有投影缺失/损坏才按 plan 自愈。即使一个
  // active plan 内已有万级 accepted 历史，稳态轮询也不能重复读取那些 task hash。
  const refreshIds = planHashes.flatMap((plan, index) => {
    const projection = planStatusProjectionFromHash(aggregateHashes[index] ?? {});
    return !projection ? [plan.plan_id] : [];
  });
  for (let offset = 0; offset < refreshIds.length; offset += 20) {
    await Promise.all(refreshIds.slice(offset, offset + 20).map((planId) => refreshPlanStatusProjection(redis, planId)));
  }
  if (refreshIds.length > 0) {
    const refreshed = new Map((await readHashesByKeysInChunks(
      redis,
      refreshIds.map((planId) => keys.planStatusProjection.aggregateByPlan(planId)),
    )).map((hash, index) => [refreshIds[index], hash]));
    aggregateHashes = aggregateHashes.map((hash, index) => refreshed.get(planHashes[index].plan_id) ?? hash);
  }

  return planHashes.map((plan, index) => {
    const projection = planStatusProjectionFromHash(aggregateHashes[index] ?? {}) ?? buildPlanStatusProjection([]);
    return {
      projection,
      summary: {
        plan_id: plan.plan_id,
        title: plan.title,
        status: projection.status,
        created_at: Number(plan.created_at ?? 0),
        project_path: plan.project_path,
        task_count: Number(plan.task_count ?? 0),
        runtime_task_count: projection.runtimeTaskCount,
        tasks: projection.tasks,
        reviews: projection.reviews,
        root_reviews: projection.rootReviews,
        root_tasks: rootTaskLifecycleSummary(projection.rootTasks, Number(plan.task_count ?? 0)),
      },
    };
  });
}

/** get plan（对应 05 号 md 接口 10：GET /plan/{plan_id}）
 *  返回任务详情数组（title/type/assignee/ownership 等），供前端看板展示
 */
export async function getPlan(redis: Redis, planId: string): Promise<ApiResponse<unknown>> {
  // 详情接口与 /plans、/status 共享同一版本化投影门禁；陌生客户端可能直接打开
  // 项目页，不能依赖它先访问列表页来完成升级 backfill。
  await ensurePlanStatusProjection(redis);
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
    created_at?: number;
    updated_at?: number;
    review_status?: string;
    pm_review_status?: string;
    pm_reviewed_by?: string;
    pm_reviewed_at?: number;
    pm_review_comment?: string;
    pm_reject_reason?: string;
    pm_fix_instructions?: string;
    pm_rejection_resolution_mode?: string;
    repair_ownership_extension?: RepairOwnershipExtension;
    pm_repair_ownership_required?: boolean;
    pm_repair_ownership_intent?: RepairOwnershipExtension;
    failure_reason?: string;
    blocked_reason?: string;
    blocked_at?: number;
    cancelled_at?: number;
    cancel_reason?: string;
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
  const taskIds = await redis.smembers(keys.planStatusProjection.taskIdsByPlan(planId));
  const taskHashes = await readTaskHashesInChunks(redis, taskIds);
  for (const h of taskHashes) {
      if (!h.task_id || h.plan_id !== planId) continue;
      const status = Object.hasOwn(statusBuckets, h.status) ? h.status : 'failed';
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
        created_at: h.created_at ? Number(h.created_at) : undefined,
        updated_at: h.updated_at ? Number(h.updated_at) : undefined,
        review_status: h.pm_review_status || undefined,
        pm_review_status: h.pm_review_status || undefined,
        pm_reviewed_by: h.pm_reviewed_by || undefined,
        pm_reviewed_at: h.pm_reviewed_at ? Number(h.pm_reviewed_at) : undefined,
        pm_review_comment: h.pm_review_comment || undefined,
        pm_reject_reason: h.pm_reject_reason || undefined,
        pm_fix_instructions: h.pm_fix_instructions || undefined,
        pm_rejection_resolution_mode: h.pm_rejection_resolution_mode || undefined,
        repair_ownership_extension: parseRepairOwnershipAudit(h.repair_ownership_extension),
        pm_repair_ownership_required: h.pm_repair_ownership_required === 'true' || undefined,
        pm_repair_ownership_intent: parseRepairOwnershipAudit(h.pm_repair_ownership_intent),
        failure_reason: h.failed_reason || undefined,
        blocked_reason: h.block_reason || undefined,
        blocked_at: h.blocked_at ? Number(h.blocked_at) : undefined,
        cancelled_at: h.cancelled_at ? Number(h.cancelled_at) : undefined,
        cancel_reason: h.cancel_reason || undefined,
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

  // Redis sets do not preserve insertion order. Keep the detail API stable so
  // callers receive the same lifecycle ordering across refreshes/rebuilds.
  for (const bucket of Object.values(statusBuckets)) {
    bucket.sort((a, b) =>
      (a.created_at ?? 0) - (b.created_at ?? 0)
      || a.task_id.localeCompare(b.task_id),
    );
  }

  const reviews = { pending: 0, accepted: 0, rejected: 0 };
  for (const task of planTasks.filter((item) => item.status === 'done')) {
    if (task.review_status === 'accepted') reviews.accepted++;
    else if (task.review_status === 'rejected') reviews.rejected++;
    else reviews.pending++;
  }
  const projection = buildPlanStatusProjection(planTasks);
  const rootReviews = projection.rootReviews;

  return {
    ok: true,
    data: {
      plan_id: planHash.plan_id,
      title: planHash.title,
      status: projection.status,
      declared_status: planHash.status,
      project_path: planHash.project_path,
      task_count: Number(planHash.task_count ?? 0),
      declared_task_count: Number(planHash.task_count ?? 0),
      runtime_task_count: planTasks.length,
      root_tasks: rootTaskLifecycleSummary(projection.rootTasks, Number(planHash.task_count ?? 0)),
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
      root_reviews: rootReviews,
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
  const loadedPlans = await loadPlanStatusSummaries(redis);
  const plans = loadedPlans.map(({ summary: plan }) => ({
    plan_id: plan.plan_id,
    title: plan.title,
    status: plan.status,
    project_path: plan.project_path,
    task_count: plan.task_count,
    runtime_task_count: plan.runtime_task_count,
    root_reviews: plan.root_reviews,
    root_tasks: plan.root_tasks,
  }));

  // agents 列表使用注册索引；Redis SCAN 即使带 MATCH 仍会走过万级 task keyspace。
  const now = Date.now();
  const agentIds = await redis.smembers(keys.planStatusProjection.agentIds);
  const agentKeys = agentIds.map((agentId) => keys.hash.agent(agentId));
  interface StatusAgent {
    agent_id: string;
    agent_type: string;
    status: string;
    current_task: string;
    current_task_status?: string;
    last_heartbeat: number;
  }
  const agents: StatusAgent[] = [];
  const currentAgents: StatusAgent[] = [];
  const historicalAgents: StatusAgent[] = [];
  let onlineAgents = 0;
  let staleRunningAgents = 0;
  const staleRunningTaskIds = new Set<string>();
  for (const ak of agentKeys) {
    const h = await redis.hgetall(ak);
    if (h.agent_id) {
      const lastHb = Number(h.last_heartbeat ?? 0);
      // 在线语义按心跳租约派生：超阈值的 agent 不再显示 idle/online，避免 PM 误判有执行者在线。
      const derived = deriveAgentStatus(h.status, lastHb, now);
      const currentTask = h.current_task ?? '';
      const currentTaskStatus = currentTask
        ? await redis.hget(keys.hash.task(currentTask), 'status') ?? undefined
        : undefined;
      const agent: StatusAgent = {
        agent_id: h.agent_id,
        agent_type: h.agent_type ?? '',
        status: derived,
        current_task: currentTask,
        ...(currentTaskStatus ? { current_task_status: currentTaskStatus } : {}),
        last_heartbeat: lastHb,
      };
      agents.push(agent);

      if (['idle', 'busy', 'online'].includes(derived)) {
        onlineAgents++;
        currentAgents.push(agent);
      } else if (currentTaskStatus === 'running') {
        // 心跳失联但 Redis 仍显示 running 时不能静默丢进历史，交给 PM 关注回收。
        staleRunningAgents++;
        staleRunningTaskIds.add(currentTask);
        currentAgents.push(agent);
      } else {
        // stale idle、已结束 current_task 等都只是注册审计，不占据首页当前资源列表。
        historicalAgents.push(agent);
      }
    }
  }
  // 同名 Worker 新注册会把 Agent 投影恢复成 idle/current_task=''；旧 task 即使仍有
  // 长 lease，也已不可能由被 epoch fencing 的旧执行器合法续租或回传。把这种
  // task-centric 孤儿态并入现有 attention，避免“Worker 在线”掩盖真实无人负责。
  for (const taskId of await redis.zrange(keys.zset.status.running, 0, -1)) {
    if (staleRunningTaskIds.has(taskId)) continue;
    const health = await runningTaskExecutionHealth(redis, taskId);
    if (health.orphaned) {
      staleRunningAgents++;
      staleRunningTaskIds.add(taskId);
    }
  }

  // 在线计数与 hint 不得因历史注册记录误判：只有真正在线（心跳新鲜）的 agent 才算。

  // reviews/attention/history 直接汇总 plan 物化投影。终态历史 hash 只在首次升级时
  // backfill，稳态轮询不能再 ZRANGE done/failed 后逐条 HGETALL。
  let reviewPending = 0;
  let reviewAccepted = 0;
  let reviewRejected = 0;
  let rootReviewPending = 0;
  let rootReviewAccepted = 0;
  let rootReviewRejected = 0;
  const rootTasks = emptyRootTaskLifecycleCounters();
  let declaredRootTasks = 0;
  let currentFailed = 0;
  let currentRejected = 0;
  let resolvedFailed = 0;
  let resolvedRejected = 0;
  let needsPmDecision = 0;
  for (const { projection, summary } of loadedPlans) {
    reviewPending += projection.reviews.pending;
    reviewAccepted += projection.reviews.accepted;
    reviewRejected += projection.reviews.rejected;
    rootReviewPending += projection.rootReviews.pending;
    rootReviewAccepted += projection.rootReviews.accepted;
    rootReviewRejected += projection.rootReviews.rejected;
    for (const field of Object.keys(rootTasks) as Array<keyof RootTaskLifecycleCounters>) {
      rootTasks[field] += projection.rootTasks[field];
    }
    declaredRootTasks += summary.task_count;
    currentFailed += projection.attention.failed;
    currentRejected += projection.attention.rejected;
    needsPmDecision += projection.attention.needs_pm_decision;
    resolvedFailed += projection.history.resolved_failed;
    resolvedRejected += projection.history.resolved_rejected;
  }

  // hint 只看活跃计划中真实可领取的 pending task，不能被孤立 ZSET 索引、已关闭计划、
  // 未满足依赖或残留 lease 唤醒 Worker。任务原始 pending 计数仍保留给旧客户端审计。
  const activePlanIds = new Set(
    plans.filter((plan) => plan.status === 'submitted' || plan.status === 'active').map((plan) => plan.plan_id),
  );
  let hasClaimablePending = false;
  if (onlineAgents === 0 && pending > 0 && activePlanIds.size > 0) {
    const pendingIds = await redis.zrange(keys.zset.status.pending, 0, -1);
    for (const taskId of pendingIds) {
      const task = await redis.hgetall(keys.hash.task(taskId));
      if (task.task_id !== taskId || task.status !== 'pending' || !activePlanIds.has(task.plan_id)) continue;
      if (await redis.exists(keys.string.lease(taskId))) continue;

      const dependencyIds = (task.depends_on ?? '').split(',').map((dep) => dep.trim()).filter(Boolean);
      let dependenciesSatisfied = true;
      for (const dependencyId of dependencyIds) {
        const dependency = await redis.hgetall(keys.hash.task(dependencyId));
        if (!isDependencySatisfied(dependency, task.type === 'acceptance')) {
          dependenciesSatisfied = false;
          break;
        }
      }
      if (dependenciesSatisfied) {
        hasClaimablePending = true;
        break;
      }
    }
  }

  // 在线语义仍按真实心跳判断，历史注册但已失联的 Agent 不算"有执行者在"。
  const hint =
    hasClaimablePending
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
      root_reviews: { pending: rootReviewPending, accepted: rootReviewAccepted, rejected: rootReviewRejected },
      root_tasks: rootTaskLifecycleSummary(rootTasks, declaredRootTasks),
      attention: {
        failed: currentFailed,
        rejected: currentRejected,
        needs_pm_decision: needsPmDecision,
        stale_running_agents: staleRunningAgents,
      },
      history: {
        resolved_failed: resolvedFailed,
        resolved_rejected: resolvedRejected,
        stale_agents: historicalAgents.length,
      },
      plans,
      agents,
      agent_groups: { current: currentAgents, history: historicalAgents },
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

const REMOVE_STALE_PENDING_REVIEW = `
local status = redis.call('HGET', KEYS[2], 'status') or ''
local review = redis.call('HGET', KEYS[2], 'pm_review_status') or ''
local resolution = redis.call('HGET', KEYS[2], 'resolution_status') or ''
local function blank(value) return string.match(value, '^%s*$') ~= nil end
if status == 'done' and blank(review) and blank(resolution) then return 0 end
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

/**
 * 只在提交边界复核 task 仍不是“当前 done 未验收”时清理索引。普通 MULTI ZREM
 * 会在 reset → fresh done 并发中误删新一代 member，造成 PM 永久漏单。
 */
async function removeStalePendingReviews(redis: Redis, taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const cleanup = redis.multi();
  for (const taskId of taskIds) {
    cleanup.eval(
      REMOVE_STALE_PENDING_REVIEW,
      2,
      keys.reviewRequested.pending,
      keys.hash.task(taskId),
      taskId,
    );
  }
  const outcomes = await cleanup.exec();
  if (!outcomes || outcomes.some(([error]) => error)) {
    throw new Error('failed to clean stale PM review entries');
  }
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
local resolution_status = redis.call('HGET', KEYS[1], 'resolution_status') or ''
if string.match(resolution_status, '%S') then return {'TASK_IN_RESOLUTION', ''} end
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
  const staleIds: string[] = [];

  for (const taskId of pendingIds) {
    const task = await redis.hgetall(keys.hash.task(taskId));
    if (!isUnreviewedDoneTask(task)) {
      staleIds.push(taskId);
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

  await removeStalePendingReviews(redis, staleIds);
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
      // acceptance_ready 是给 Worker/Supervisor 的可执行信号，不是 PM 必须手工
      // ack 的永久待办。一旦 task 已被 claim、交付、撤销或取代，就从
      // consumer pending 投影撤回；stream 中的不可变历史仍完整保留。
      if (indexed.event.type === 'acceptance_ready') {
        const task = indexed.event.task_id
          ? await redis.hgetall(keys.hash.task(indexed.event.task_id))
          : {};
        if (task.status !== 'pending') {
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

function taskListItemFromHash(h: Record<string, string>, status = h.status ?? ''): TaskListItem {
  return {
    task_id: h.task_id,
    title: h.title ?? '',
    type: h.type ?? '',
    phase: h.phase ?? '',
    status,
    assignee: h.assignee ?? 'auto',
    priority: Number(h.priority ?? 0),
    plan_id: h.plan_id ?? '',
    project_path: h.project_path ?? '',
    pm_review_status: h.pm_review_status?.trim() || undefined,
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
  };
}

export async function getTasks(
  redis: Redis,
  opts: { plan_id?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<ApiResponse<{ tasks: TaskListItem[]; total: number; offset: number; limit: number; has_more: boolean }>> {
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  // status 过滤：若指定了单个 status，只查那个 zset。
  const allStatuses = ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'];
  const statuses = opts.status && allStatuses.includes(opts.status) ? [opts.status] : allStatuses;

  const matched: TaskListItem[] = [];
  for (const st of statuses) {
    const zsetKey = (keys.zset.status as Record<string, string>)[st];
    const ids = await redis.zrange(zsetKey, 0, -1);
    for (const id of ids) {
      const h = await redis.hgetall(keys.hash.task(id));
      if (!h.task_id) continue;
      // plan_id 过滤
      if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
      matched.push(taskListItemFromHash(h, st));
    }
  }

  const tasks = matched.slice(offset, offset + limit);
  return {
    ok: true,
    data: {
      tasks,
      total: matched.length,
      offset,
      limit,
      has_more: offset + tasks.length < matched.length,
    },
  };
}

/**
 * PM 待验收专用查询。只遍历当前 pending-review zset，不经过 done 历史窗口，
 * 因而不会在长期运行累计大量 accepted/rejected 记录后静默漏单。
 */
export async function getPendingReviewTasks(
  redis: Redis,
  opts: { plan_id?: string } = {},
): Promise<ApiResponse<{ tasks: TaskListItem[]; total: number }>> {
  // 该接口必须可独立作为 PM 首入口。升级后即使尚未运行 pm-start/intake，
  // 也要先一次性从旧 done/event 事实补建 pending-review 索引，不能静默报空。
  await ensureLegacyReviewIndexes(redis);
  const ids = await redis.zrange(keys.reviewRequested.pending, 0, -1);
  const items: TaskListItem[] = [];
  const staleIds: string[] = [];

  for (const taskId of ids) {
    const h = await redis.hgetall(keys.hash.task(taskId));
    if (!h.task_id || !isUnreviewedDoneTask(h)) {
      staleIds.push(taskId);
      continue;
    }
    if (opts.plan_id && h.plan_id !== opts.plan_id) continue;
    items.push(taskListItemFromHash(h, 'done'));
  }

  if (staleIds.length > 0) {
    await removeStalePendingReviews(redis, staleIds);
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
  runtime_task_count: number;
  tasks: { pending: number; running: number; blocked: number; done: number; failed: number; cancelled: number; superseded: number };
  reviews: { pending: number; accepted: number; rejected: number };
  root_reviews: { pending: number; accepted: number; rejected: number };
  root_tasks: RootTaskLifecycleSummary;
}

export async function getPlans(
  redis: Redis,
): Promise<ApiResponse<{ plans: BiaoPlanSummary[]; total: number }>> {
  const plans = (await loadPlanStatusSummaries(redis)).map(({ summary }) => summary);
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

  /**
   * retry 上限与 PM continue 可能在并发边界短暂留下
   * `needs_pm_decision + active child`。此时 PM 的 continue/cancel 都会被 active-child
   * 门禁拒绝，真正的下一步仍是 Worker/验收者处理 child，因此 intake 必须静默。
   */
  const hasActiveResolutionChild = async (root: Record<string, string>): Promise<boolean> => {
    const childIds = [...new Set([
      root.resolution_task_id,
      ...(root.resolution_task_ids ?? '').split(','),
      ...(root.acceptance_repair_task_ids ?? '').split(','),
    ].map((taskId) => taskId.trim()).filter(Boolean))];
    for (const childId of childIds) {
      const child = await redis.hgetall(keys.hash.task(childId));
      if (!child.task_id) continue;
      if (['pending', 'running', 'blocked'].includes(child.status)) return true;
      if (child.status === 'done' && !child.pm_review_status) return true;
    }
    return false;
  };

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
      if (await hasActiveResolutionChild(task)) continue;
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
  const staleReviewIds: string[] = [];
  for (const taskId of pendingReviewIds) {
    const h = await redis.hgetall(keys.hash.task(taskId));
    if (!isUnreviewedDoneTask(h)) {
      staleReviewIds.push(taskId);
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
  await removeStalePendingReviews(redis, staleReviewIds);

  // 3. 当前状态兜底。failed 只读当前 actionable 索引；resolved/repairing 历史只在
  // standalone 首次升级 backfill 一次。blocked 仍是非终态当前集合，可直接读 zset。
  await ensureIntakeActionableFailedIndex(redis);
  const staleFailedCandidates: string[] = [];
  const failedRootsToSync = new Set<string>();
  const collectStatusTasks = async (statusKey: string, kind: IntakeItem['kind']) => {
    const ids = await redis.zrange(statusKey, 0, -1);
    for (const tid of ids) {
      let h = await redis.hgetall(keys.hash.task(tid));
      if (!h.task_id) {
        if (kind === 'failed') staleFailedCandidates.push(tid);
        continue;
      }
      let effectiveTaskId = tid;
      let observedAt = Number(h.blocked_at ?? h.done_at ?? 0) || undefined;
      // 终态 repair/reverify child 只是根任务的失败证据，不是第二个
      // PM 待办。根链还在自动进行时完全静默；只在根链耗尽时将它
      // 折叠为唯一的根任务 resolution_required。
      if (kind === 'failed' && h.repair_root_task_id && h.repair_root_task_id !== h.task_id) {
        const root = await redis.hgetall(keys.hash.task(h.repair_root_task_id));
        if (root.task_id && ['repairing', 'required', 'resolved', 'cancelled'].includes(root.resolution_status ?? '')) {
          staleFailedCandidates.push(tid);
          continue;
        }
        if (root.task_id && root.resolution_status === 'needs_pm_decision') {
          // 当前索引以“可行动根”为稳态单位。历史 child 只在本轮折叠展示，随后
          // 用原子 actionability Lua 把根补入并删除 child，避免 N 个失败 attempt
          // 让每轮 intake 重新读取 N 个 hash。
          staleFailedCandidates.push(tid);
          failedRootsToSync.add(root.task_id);
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
      if (kind === 'failed' && ['repairing', 'required', 'resolved', 'cancelled'].includes(h.resolution_status ?? '')) {
        staleFailedCandidates.push(tid);
        continue;
      }
      if (kind === 'failed' && h.resolution_status === 'needs_pm_decision' && await hasActiveResolutionChild(h)) {
        continue;
      }
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
  await collectStatusTasks(keys.intakeActionableFailed.pending, 'failed');
  await collectStatusTasks(keys.zset.status.blocked, 'blocked');
  for (const rootTaskId of failedRootsToSync) {
    await syncIntakeActionableFailed(redis, rootTaskId);
  }
  const uniqueStaleFailedCandidates = [...new Set(staleFailedCandidates)];
  for (let offset = 0; offset < uniqueStaleFailedCandidates.length; offset += 100) {
    // 读到 stale 后 task 可能并发进入 needs_pm_decision。不能用旧快照直接 ZREM；
    // 每项都在 Lua 提交点重读当前 status/resolution，必要时反而补回候选。
    await Promise.all(
      uniqueStaleFailedCandidates
        .slice(offset, offset + 100)
        .map((taskId) => syncIntakeActionableFailed(redis, taskId)),
    );
  }

  // 4. stale agent 只有仍持有 running task 时才进入 PM intake。纯 idle/stale
  // 注册是可自行恢复的历史噪声，/status 已能展示，不该每轮催 PM 清理。
  if (!(await redis.get(keys.planStatusProjection.agentIdsReady))) {
    const legacyAgentKeys = await scanKeys(redis, `${PREFIX}:hash:agent:*`);
    const legacyAgents = await readHashesByKeysInChunks(redis, legacyAgentKeys);
    const legacyIds = legacyAgents.map((agent) => agent.agent_id).filter(Boolean);
    const transaction = redis.multi();
    if (legacyIds.length > 0) transaction.sadd(keys.planStatusProjection.agentIds, ...legacyIds);
    transaction.set(keys.planStatusProjection.agentIdsReady, PLAN_STATUS_PROJECTION_VERSION);
    const outcomes = await transaction.exec();
    if (!outcomes || outcomes.some(([error]) => error)) {
      await redis.del(keys.planStatusProjection.agentIdsReady).catch(() => undefined);
      throw new Error('legacy agent index backfill failed');
    }
  }
  const agentIds = await redis.smembers(keys.planStatusProjection.agentIds);
  const agentKeys = agentIds.map((agentId) => keys.hash.agent(agentId));
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
  const lastId = await redis.xrevrange(keys.stream.events, '+', '-', 'COUNT', 1);
  const cursor = Array.isArray(lastId) && lastId.length > 0 ? lastId[0][0] : '0-0';

  return { ok: true, data: { consumer, cursor, counts, items } };
}

/**
 *  发现需要人工动作的 failed / stale_running / stale_agent / blocked_long / done_unreviewed。
 *  autoFix=true 时只处理安全项：stale running/agent 回收，以及为无 resolution
 *  的 legacy failed 补建不可变 repair 闭环。
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

async function runningTaskExecutionHealth(
  redis: Redis,
  taskId: string,
): Promise<{ task: Record<string, string>; leaseAlive: boolean; orphaned: boolean }> {
  const task = await redis.hgetall(keys.hash.task(taskId));
  if (task.status !== 'running') return { task, leaseAlive: false, orphaned: false };
  const leaseAlive = await redis.get(keys.string.lease(taskId)) !== null;
  if (!leaseAlive) return { task, leaseAlive, orphaned: false };
  if (!task.claimed_by) return { task, leaseAlive, orphaned: true };
  const agent = await redis.hgetall(keys.hash.agent(task.claimed_by));
  return {
    task,
    leaseAlive,
    orphaned: !agent.agent_id || agent.status === 'offline' || agent.current_task !== taskId,
  };
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

  // 显式 --auto-fix 复用 Supervisor 的 CAS 运行态补偿：stale lease 的 retries 与
  // max_retries 必须使用同一口径，不能由通用 taskReset 无限放回 pending。
  // 普通巡检仍保持只读、低成本。
  if (opts.autoFix) {
    const staleSnapshots = await exposeRecoverableRunningTasks(redis, now);
    const reconciled = await reconcileRuntimeStateUnlocked(redis);
    const reclaimed = reconciled.data?.reclaimed ?? [];
    const failed = new Set(reconciled.data?.failed ?? []);
    for (const taskId of reclaimed) {
      const snapshot = staleSnapshots.get(taskId);
      const retryExhausted = failed.has(taskId);
      problems.push({
        type: 'stale_running',
        task_id: taskId,
        detail: retryExhausted
          ? `running lease 已失效；自动回收后超过 max_retries，任务已进入 failed→repair 闭环`
          : `running lease 已失效；已自动回收并返回 pending（原 worker ${snapshot?.claimed_by || '?'}）`,
        suggestion: retryExhausted
          ? `biao task get ${taskId}（查看自动生成的 repair 与失败审计）`
          : `等待 Worker fresh claim ${taskId}`,
        auto_fixable: true,
        fixed: true,
      });
    }
  }

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
        : 'biao watchdog --auto-fix',
      auto_fixable: !needsDecision,
    });
  }

  // 2. stale running（status=running 但 lease 已失效：worker 崩了/退了，lazyReclaim 要等下次 claim 才触发）
  const runningIds = await redis.zrange(keys.zset.status.running, 0, -1);
  for (const tid of runningIds) {
    const health = await runningTaskExecutionHealth(redis, tid);
    if (health.leaseAlive && !health.orphaned) continue;
    const h = health.task;
    if (h.status !== 'running') continue;
    const p: WatchdogProblem = {
      type: 'stale_running',
      task_id: tid,
      detail: health.orphaned
        ? `running lease 仍在，但 worker ${h.claimed_by || '?'} 的当前注册不再指向该任务`
        : `running 但 lease 已失效，worker ${h.claimed_by || '?'} 可能已退出`,
      suggestion: 'biao watchdog --auto-fix',
      auto_fixable: true,
    };
    // autoFix 已在本轮开头统一经过 lazyReclaim CAS。若 lease 恰好在该 CAS 之后
    // 才过期，此处只报告当前事实，留给下一低频轮次回收，避免维护第二套迁移语义。
    problems.push(p);
  }

  // 3. stale agents（last_heartbeat 超过 5 分钟）
  // 纯 idle 或 current_task 已终结的失联注册只是历史审计，不是当前
  // 故障。只有仍指向真实 running task 时才提醒/自动离线，与
  // /status 及 PM intake 的 current-attention 口径保持一致。
  const agentKeys = await scanKeys(redis, `${PREFIX}:hash:agent:*`);
  for (const ak of agentKeys) {
    const h = await redis.hgetall(ak);
    if (!h.agent_id) continue;
    if (h.status === 'offline') continue;
    const lastHb = Number(h.last_heartbeat ?? 0);
    if (now - lastHb > STALE_AGENT_THRESHOLD_MS && h.current_task) {
      const currentTaskStatus = await redis.hget(keys.hash.task(h.current_task), 'status');
      if (currentTaskStatus !== 'running') continue;
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
