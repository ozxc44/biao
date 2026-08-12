/**
 * Redis 客户端封装 + 核心操作
 * 对应 docs/biao/04-redis-key-design.md, 06-dispatch-protocol.md, 07-ownership-registry.md
 */

import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { keys, pendingScore, runningScore, DEFAULT_PM_CONSUMER } from './keys.js';
import type {
  TaskRecord,
  TaskFrontmatter,
  OwnershipRecord,
  OwnershipCheckResult,
  PlanFrontmatter,
  RepairOwnershipExtension,
} from '../types/index.js';

/** 生成 claim_token */
export function generateToken(): string {
  return `tok_${randomBytes(24).toString('hex')}`;
}

/**
 * 释放某 agent 在一个 task 下的文件 ownership。
 *
 * 不能使用 JS 的“先读再 MULTI 删除”：在读取旧 record 后，新 owner 可能已经接手同一
 * glob，延迟的 HDEL 会删掉新 owner。此脚本在 Redis 单个原子单元中二次核对
 * `agent_id + task_id`；反向索引损坏时只移除本 agent 的陈旧 member，不猜测删除 hash。
 *
 * KEYS: file ownership hash, owner-by-agent set
 * ARGV: agent_id, task_id
 */
const RELEASE_OWNERSHIP_FOR_TASK_CAS = `
local agent_id = ARGV[1]
local task_id = ARGV[2]
local released = 0
local globs = redis.call('SMEMBERS', KEYS[2])

for _, glob in ipairs(globs) do
  local raw = redis.call('HGET', KEYS[1], glob)
  if not raw then
    redis.call('SREM', KEYS[2], glob)
  else
    local ok, record = pcall(cjson.decode, raw)
    if ok and record then
      if record.agent_id == agent_id and record.task_id == task_id then
        redis.call('HDEL', KEYS[1], glob)
        redis.call('SREM', KEYS[2], glob)
        released = released + 1
      elseif record.agent_id ~= agent_id then
        -- 新 owner 已接手同一 glob：仅清理当前 agent 的残留反向索引。
        redis.call('SREM', KEYS[2], glob)
      end
    else
      -- 无法证明该 hash 属于当前 task，保留主记录以免误删新 owner。
      redis.call('SREM', KEYS[2], glob)
    end
  end
end

return released
`;

/**
 * 原子回收一个过期 running task。
 *
 * 外层 zrangebyscore 只是候选发现；脚本内必须再次校验 running/status/owner/lease，
 * 防止旧快照覆盖刚 report、Question block 或重新 claim 的状态。
 *
 * KEYS: task hash, lease, running zset, pending zset, failed zset, tasks stream,
 *       file ownership hash, owner-by-agent set, agent hash, events stream
 * ARGV: task_id, expected_agent_id, now_ms
 */
const RECLAIM_EXPIRED_TASK_CAS = `
local task_id = ARGV[1]
local expected_agent = ARGV[2]
local now = tonumber(ARGV[3])

if redis.call('HGET', KEYS[1], 'task_id') == false then return {'TASK_NOT_FOUND', '0'} end
if (redis.call('HGET', KEYS[1], 'status') or '') ~= 'running' then return {'TASK_NOT_RUNNING', '0'} end
if (redis.call('HGET', KEYS[1], 'claimed_by') or '') ~= expected_agent then return {'OWNER_CHANGED', '0'} end
if redis.call('GET', KEYS[2]) ~= false then return {'LEASE_ACTIVE', '0'} end

local running_score = redis.call('ZSCORE', KEYS[3], task_id)
if not running_score or tonumber(running_score) > now then return {'RUNNING_SCORE_NOT_EXPIRED', '0'} end

local retries = (tonumber(redis.call('HGET', KEYS[1], 'retries') or '0') or 0) + 1
local max_retries = tonumber(redis.call('HGET', KEYS[1], 'max_retries') or '2') or 2
local priority = tonumber(redis.call('HGET', KEYS[1], 'priority') or '5') or 5
local released = 0
local globs = redis.call('SMEMBERS', KEYS[8])

for _, glob in ipairs(globs) do
  local raw = redis.call('HGET', KEYS[7], glob)
  if not raw then
    redis.call('SREM', KEYS[8], glob)
  else
    local ok, record = pcall(cjson.decode, raw)
    if ok and record then
      if record.agent_id == expected_agent and record.task_id == task_id then
        redis.call('HDEL', KEYS[7], glob)
        redis.call('SREM', KEYS[8], glob)
        released = released + 1
      elseif record.agent_id ~= expected_agent then
        redis.call('SREM', KEYS[8], glob)
      end
    else
      redis.call('SREM', KEYS[8], glob)
    end
  end
end

redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], task_id)
redis.call('ZREM', KEYS[4], task_id)
redis.call('ZREM', KEYS[5], task_id)

if retries > max_retries then
  redis.call('ZADD', KEYS[5], now, task_id)
  redis.call('HSET', KEYS[1],
    'status', 'failed',
    'retries', tostring(retries),
    'failed_reason', 'max_retries_exceeded',
    'claimed_by', '',
    'claimed_at', '',
    'expire_at', '')
else
  local score = priority * 10000000000000 - now
  redis.call('ZADD', KEYS[4], score, task_id)
  redis.call('HSET', KEYS[1],
    'status', 'pending',
    'retries', tostring(retries),
    'claimed_by', '',
    'claimed_at', '',
    'expire_at', '')
  redis.call('XADD', KEYS[6], '*', 'task_id', task_id, 'priority', tostring(priority))
  redis.call('XADD', KEYS[10], '*',
    'event_id', tostring(now) .. '_task_ready_' .. task_id .. '_lease_' .. tostring(retries),
    'type', 'task_ready',
    'task_id', task_id,
    'plan_id', redis.call('HGET', KEYS[1], 'plan_id') or '',
    'consumer', 'worker',
    'reason', 'stale_lease_reclaimed',
    'timestamp', tostring(now))
end

if expected_agent ~= '' and (redis.call('HGET', KEYS[9], 'current_task') or '') == task_id then
  redis.call('HSET', KEYS[9], 'status', 'idle', 'current_task', '')
end

return {'RECLAIMED', tostring(released)}
`;

/**
 * 惰性回收实际成功的 task id（供 service 同步 SQLite）。
 *
 * 保留下方的 number 版本以兼容已有 Redis 层调用；只有 service 知道 SQLite 副本，
 * 所以 claim 使用这个详细结果逐项落盘，避免灾难恢复把旧 running 状态带回。
 */
export async function lazyReclaimTaskIds(redis: Redis): Promise<string[]> {
  const now = Date.now();
  // 扫描 running 索引中 score < now 的任务
  const expired = await redis.zrangebyscore(keys.zset.status.running, '-inf', now);
  const reclaimedTaskIds: string[] = [];
  for (const taskId of expired) {
    // zset 是候选索引，不是状态真相。先取 expected owner 仅为了定位其反向索引；Lua
    // 脚本会再次核验 owner、lease 和 running 状态，任何并发状态变化都成为 no-op。
    const expectedAgent = (await redis.hget(keys.hash.task(taskId), 'claimed_by')) ?? '';
    if (!expectedAgent) continue;
    const raw = (await redis.eval(
      RECLAIM_EXPIRED_TASK_CAS,
      10,
      keys.hash.task(taskId),
      keys.string.lease(taskId),
      keys.zset.status.running,
      keys.zset.status.pending,
      keys.zset.status.failed,
      keys.stream.tasks,
      keys.hash.fileOwnership,
      keys.set.ownerByAgent(expectedAgent),
      keys.hash.agent(expectedAgent),
      keys.stream.events,
      taskId,
      expectedAgent,
      String(now),
    )) as string[];
    if (String(raw[0]) === 'RECLAIMED') reclaimedTaskIds.push(taskId);
  }
  return reclaimedTaskIds;
}

/** 惰性回收过期 running 任务（兼容旧 Redis 层 API）。 */
export async function lazyReclaim(redis: Redis): Promise<number> {
  return (await lazyReclaimTaskIds(redis)).length;
}

/** 把 task frontmatter + body 写入 Redis（plan submit 时） */
export async function writeTaskToRedis(
  redis: Redis,
  fm: TaskFrontmatter,
  body: string,
  planId: string,
  projectPath: string,
  defaultPriority: number,
): Promise<void> {
  const now = Date.now();
  const existingCreatedAt = await redis.hget(keys.hash.task(fm.task_id), 'created_at');
  const createdAt = existingCreatedAt ? Number(existingCreatedAt) : now;
  const score = pendingScore(fm.priority ?? defaultPriority, createdAt);
  const hashData: Record<string, string> = {
    task_id: fm.task_id,
    plan_id: planId,
    title: fm.title,
    type: fm.type,
    phase: fm.phase,
    assignee: fm.assignee ?? 'auto',
    priority: String(fm.priority ?? defaultPriority),
    status: 'pending',
    depends_on: (fm.depends_on ?? []).join(','),
    ownership_files: (fm.ownership?.files ?? []).join(','),
    ownership_modules: (fm.ownership?.modules ?? []).join(','),
    timeout_seconds: String(fm.timeout_seconds ?? 1800),
    max_retries: String(fm.max_retries ?? 2),
    retries: '0',
    model_override: fm.model_override ?? '',
    acceptance_for: (fm.acceptance_for ?? []).join(','),
    verify: JSON.stringify(fm.verify ?? []),
    failed_reason: '',
    // resolution/fix 字段不是 Plan frontmatter，而是运行时的失败闭环账本。新任务必须
    // 显式初始化空值，避免 Redis 恢复或计划增量提交把旧字段误当成当前状态。
    fix_for: '',
    repair_root_task_id: '',
    resolution_status: '',
    resolution_action: '',
    resolution_task_id: '',
    resolution_task_ids: '',
    resolved_by_task: '',
    resolution_generation: '0',
    resolution_attempts: '0',
    repair_ownership_extension: '',
    pm_rejection_resolution_mode: '',
    goal_md: body,
    project_path: projectPath,
    created_at: String(createdAt),
  };

  await redis.hset(keys.hash.task(fm.task_id), hashData);
  await redis.zadd(keys.zset.status.pending, score, fm.task_id);
  await redis.xadd(keys.stream.tasks, '*', 'task_id', fm.task_id, 'priority', String(fm.priority ?? defaultPriority));
}

/** hash 转 TaskRecord */
export function hashToTaskRecord(hash: Record<string, string>): TaskRecord {
  let repairOwnershipExtension: RepairOwnershipExtension | undefined;
  if (hash.repair_ownership_extension) {
    try {
      const parsed = JSON.parse(hash.repair_ownership_extension) as RepairOwnershipExtension;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const files = Array.isArray(parsed.files) && parsed.files.every((value) => typeof value === 'string')
          ? parsed.files
          : undefined;
        const modules = Array.isArray(parsed.modules) && parsed.modules.every((value) => typeof value === 'string')
          ? parsed.modules
          : undefined;
        if (files?.length || modules?.length) repairOwnershipExtension = { ...(files ? { files } : {}), ...(modules ? { modules } : {}) };
      }
    } catch {
      // 历史/损坏数据不能影响普通 task 读取；审计字段安全省略。
    }
  }
  return {
    task_id: hash.task_id,
    plan_id: hash.plan_id,
    title: hash.title,
    type: hash.type as TaskRecord['type'],
    phase: hash.phase,
    assignee: hash.assignee,
    priority: Number(hash.priority),
    status: hash.status as TaskRecord['status'],
    depends_on: hash.depends_on ? hash.depends_on.split(',') : [],
    ownership: {
      files: hash.ownership_files ? hash.ownership_files.split(',') : [],
      modules: hash.ownership_modules ? hash.ownership_modules.split(',') : [],
    },
    timeout_seconds: Number(hash.timeout_seconds),
    max_retries: Number(hash.max_retries),
    retries: Number(hash.retries),
    model_override: hash.model_override || undefined,
    acceptance_for: hash.acceptance_for ? hash.acceptance_for.split(',') : [],
    verify: hash.verify ? JSON.parse(hash.verify) : [],
    goal_md: hash.goal_md,
    project_path: hash.project_path,
    created_at: Number(hash.created_at),
    claimed_at: hash.claimed_at ? Number(hash.claimed_at) : undefined,
    claimed_by: hash.claimed_by || undefined,
    done_at: hash.done_at ? Number(hash.done_at) : undefined,
    expire_at: hash.expire_at ? Number(hash.expire_at) : undefined,
    result_path: hash.result_path || undefined,
    result_json_path: hash.result_json_path || undefined,
    failure_reason: hash.failed_reason || undefined,
    block_reason: hash.block_reason || undefined,
    blocked_at: hash.blocked_at ? Number(hash.blocked_at) : undefined,
    fix_for: hash.fix_for || undefined,
    repair_root_task_id: hash.repair_root_task_id || undefined,
    resolution_status: (hash.resolution_status || undefined) as TaskRecord['resolution_status'],
    resolution_action: (hash.resolution_action || undefined) as TaskRecord['resolution_action'],
    resolution_task_id: hash.resolution_task_id || undefined,
    resolution_task_ids: hash.resolution_task_ids ? hash.resolution_task_ids.split(',').filter(Boolean) : [],
    resolved_by_task: hash.resolved_by_task || undefined,
    resolution_generation: hash.resolution_generation ? Number(hash.resolution_generation) : undefined,
    resolution_attempts: hash.resolution_attempts ? Number(hash.resolution_attempts) : undefined,
    resolution_decision_reason: hash.resolution_decision_reason || undefined,
    pm_review_status: (hash.pm_review_status || undefined) as TaskRecord['pm_review_status'],
    pm_reviewed_by: hash.pm_reviewed_by || undefined,
    pm_reviewed_at: hash.pm_reviewed_at ? Number(hash.pm_reviewed_at) : undefined,
    pm_review_comment: hash.pm_review_comment || undefined,
    pm_reject_reason: hash.pm_reject_reason || undefined,
    pm_fix_instructions: hash.pm_fix_instructions || undefined,
    pm_rejection_resolution_mode: (hash.pm_rejection_resolution_mode || undefined) as TaskRecord['pm_rejection_resolution_mode'],
    superseded_at: hash.superseded_at ? Number(hash.superseded_at) : undefined,
    superseded_by: hash.superseded_by || undefined,
    superseded_reason: hash.superseded_reason || undefined,
    repair_ownership_extension: repairOwnershipExtension,
  };
}

/** 激活所有权声明（claim 时，对应 06 步骤 7） */
export async function activateOwnership(
  redis: Redis,
  agentId: string,
  taskId: string,
  priority: number,
  filesGlobs: string[],
  timeoutSeconds: number,
  baseCommitSha: string,
  allowPreempt = true,
): Promise<boolean> {
  if (filesGlobs.length === 0) return true;

  // WATCH 是连接级状态。claim/HTTP 请求共用的 Redis client 不能承载这里的乐观
  // 事务，否则并发调用会互相 EXEC/UNWATCH，第二个声明可能在失去 watch 后覆盖前者。
  // 每次声明使用短命专用连接，完整地包住“检查重叠 -> 写入/抢占”的 CAS 循环。
  const isolated = redis.duplicate();
  try {
    await isolated.ping();
    for (let attempt = 0; attempt < 5; attempt++) {
      await isolated.watch(keys.hash.fileOwnership);
      try {
        const now = Date.now();
        const expiresAt = now + timeoutSeconds * 1000;
        const allFields = await isolated.hgetall(keys.hash.fileOwnership);
        const liveOverlaps: Array<{ glob: string; owner: OwnershipRecord }> = [];

        for (const [existingGlob, raw] of Object.entries(allFields)) {
          try {
            const owner = JSON.parse(raw) as OwnershipRecord;
            if (owner.expires_at <= now) continue;
            if (!filesGlobs.some((requestedGlob) => globsOverlap(existingGlob, requestedGlob))) continue;
            if (owner.agent_id === agentId && owner.task_id === taskId) continue;
            liveOverlaps.push({ glob: existingGlob, owner });
          } catch {
            // 损坏记录不具有可信的活跃 ownership 语义，交给本次事务清理。
          }
        }

        const blocker = liveOverlaps.find(({ owner }) => !allowPreempt || priority <= owner.priority);
        if (blocker) return false;

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
        for (const glob of filesGlobs) {
          const record: OwnershipRecord = {
            agent_id: agentId,
            task_id: taskId,
            priority,
            declared_at: now,
            expires_at: expiresAt,
            base_commit_sha: baseCommitSha,
            mode: 'exclusive-write',
          };
          tx.hset(keys.hash.fileOwnership, glob, JSON.stringify(record));
          tx.sadd(keys.set.ownerByAgent(agentId), glob);
        }
        const result = await tx.exec();
        if (result !== null) return true;
      } finally {
        // EXEC 会自动清 watch；显式 unwatch 覆盖提前返回和失败重试路径。
        await isolated.unwatch().catch(() => undefined);
      }
    }
    return false;
  } finally {
    isolated.disconnect();
  }
}

/** 释放某 agent 的所有权声明（report/reset/reclaim 时），返回实际释放数量。 */
export async function releaseOwnershipByAgent(redis: Redis, agentId: string, taskId: string): Promise<number> {
  if (!agentId) return 0;
  const released = await redis.eval(
    RELEASE_OWNERSHIP_FOR_TASK_CAS,
    2,
    keys.hash.fileOwnership,
    keys.set.ownerByAgent(agentId),
    agentId,
    taskId,
  );
  return Number(released) || 0;
}

/** 查询文件占用（对应 07 号 md） */
export async function checkOwnership(
  redis: Redis,
  path: string,
  agentId: string,
  myPriority: number,
): Promise<OwnershipCheckResult> {
  const now = Date.now();
  const allFields = await redis.hgetall(keys.hash.fileOwnership);
  let primaryOwner: OwnershipRecord | null = null;
  let primaryGlob = '';

  for (const [glob, raw] of Object.entries(allFields)) {
    if (globsOverlap(glob, path)) {
      try {
        const owner = JSON.parse(raw) as OwnershipRecord;
        if (owner.expires_at > now) {
          // 未过期
          if (!primaryOwner || owner.priority > primaryOwner.priority) {
            primaryOwner = owner;
            primaryGlob = glob;
          }
        }
      } catch {
        // 忽略损坏的 JSON
      }
    }
  }

  if (!primaryOwner) {
    return { path, occupied: false, action: 'proceed' };
  }

  if (primaryOwner.agent_id === agentId) {
    return { path, occupied: true, owner: primaryOwner, action: 'proceed' };
  }

  if (myPriority > primaryOwner.priority) {
    return {
      path,
      occupied: true,
      owner: primaryOwner,
      your_priority: myPriority,
      action: 'preempt',
    };
  }

  return {
    path,
    occupied: true,
    owner: primaryOwner,
    your_priority: myPriority,
    action: 'wait',
  };
}

/** glob 匹配（简化版，支持 ** 和 *） */
export function globMatch(pattern: string, path: string): boolean {
  // 把 glob 转成正则
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp('^' + regexStr + '$');
  return re.test(path);
}

/**
 * 对称判定两个路径/glob 是否可能重叠。
 * 先做双向完整匹配，再比较通配符前的静态目录前缀，
 * 使 `src/**` vs `src/app.ts` 和反向声明得到一致结果。
 */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b || globMatch(a, b) || globMatch(b, a)) return true;
  const staticPrefix = (value: string) => {
    const wildcardAt = value.search(/[?*]/);
    const prefix = wildcardAt === -1 ? value : value.slice(0, wildcardAt);
    const slashAt = prefix.lastIndexOf('/');
    return slashAt === -1 ? '' : prefix.slice(0, slashAt + 1);
  };
  const aPrefix = staticPrefix(a);
  const bPrefix = staticPrefix(b);
  if (!aPrefix || !bPrefix) return aPrefix === bPrefix;
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

/** 记录冲突日志 */
export async function logConflict(
  redis: Redis,
  path: string,
  winner: { agent_id: string; task_id: string; priority: number },
  loser: { agent_id: string; task_id: string; priority: number },
  action: string,
): Promise<void> {
  const entry = JSON.stringify({ ts: Date.now(), path, winner, loser, action });
  await redis.lpush(keys.list.ownershipConflicts, entry);
  await redis.ltrim(keys.list.ownershipConflicts, 0, 999);
}

/** 写 plan 元信息 */
export async function writePlanToRedis(redis: Redis, plan: PlanFrontmatter, taskCount: number): Promise<void> {
  await redis.hset(keys.hash.plan(plan.plan_id), {
    plan_id: plan.plan_id,
    title: plan.title,
    status: 'submitted',
    project_path: plan.project_path,
    default_assignee: plan.default_assignee ?? 'auto',
    default_priority: String(plan.default_priority ?? 5),
    phases: JSON.stringify(plan.phases ?? []),
    task_count: String(taskCount),
    created_at: String(Date.now()),
    // PM consumer 路由标识：未声明时回退到默认值，保证旧 plan 兼容
    pm_consumer: plan.pm_consumer ?? DEFAULT_PM_CONSUMER,
  });
}
