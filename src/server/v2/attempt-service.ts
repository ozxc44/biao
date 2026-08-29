/**
 * AttemptService（V1 对照实现 · SERVICE_MAP 第一批迁移）
 *
 * 从 src/server/service.ts 迁出的 claim/lease/Question/block/resume/ownership/
 * 任务读写/supersede/cancel 家族（SERVICE_MAP.md 的 AttemptService 17 函数）。
 * service.ts 保留同名 re-export（零破坏迁移），HTTP 面与既有调用方不受影响。
 *
 * 过渡期形态（后续批次继续迁出时消解）：
 * - 跨域私有助手（repair lineage / review doorbell / agent epoch 提交互斥等）
 *   仍在 service.ts，本文件经 `../service.js` 引用——两模块形成受控环，
 *   环上只有函数引用（无模块初始化期取值），ESM live binding 语义下安全。
 * - `sqliteStore` 组合根状态仍在 service.ts（setSqliteStore 唯一写入口），
 *   此处以只读 live binding 导入。
 * 台账见 src/server/v2/SERVICE_MAP.md；目标契约见 domain-interfaces.ts 的
 * AttemptService 接口。
 */

import type Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SqliteStore } from '../../db/sqlite-store.js';
import { verifyNodeCredential, type IssueCredentialOptions } from './credentials.js';
import {
  resolveAndValidateV2FeatureFlags,
  V2_FEATURE_FLAG_ENV_NAMES,
  type V2FeatureFlags,
} from './feature-flags.js';
import { getRestoreMaintenanceGate } from '../maintenance.js';
import { keys, pendingScore, runningScore, DEFAULT_PM_CONSUMER, isValidConsumerName } from '../../redis/keys.js';
import {
  lazyReclaimTaskIds,
  hashToTaskRecord,
  activateOwnership,
  releaseOwnershipByAgent,
  checkOwnership,
  globMatch,
  globsOverlap,
  generateToken,
} from '../../redis/ownership.js';
import type {
  QuestionCreateRequest,
  QuestionAnswerRequest,
  QuestionRecord,
  QuestionSummary,
  QuestionStatus,
  OwnershipScope,
  RepairOwnershipExtension,
  ClaimRequest,
  ClaimedTask,
  ReportRequest,
  ApiResponse,
  TaskRecord,
  OwnershipCheckResult,
} from '../../types/index.js';
import {
  QUESTION_ANSWER_MAX_CHARS,
  QUESTION_BODY_MAX_CHARS,
  QUESTION_CHECKPOINT_MAX_CHARS,
} from '../../communication/question-context.js';
import {
  readValidatedTaskArtifact,
  resolveAndValidateTaskArtifactPath,
  resolveAndValidateWorkspacePath,
} from '../security.js';

import {
  // ── 过渡期共享助手（service.ts，后续批次随所属域迁出） ──
  configuredWorkspaceRoots,
  normalizePmConsumer,
  projectAgentReservationKey,
  publicBinding,
  connectProjectAgent,
  persistTaskFromRedis,
  withMutationPermit,
  acquireMutationSection,
  AGENT_REGISTRATION_ID_PATTERN,
  withAgentEpochCommit,
  durableAgentEpochIsCurrent,
  isDependencySatisfied,
  checkDependencies,
  summarizeVerifyFailures,
  failureReasonForReport,
  normalizeRepairOwnership,
  splitOwnership,
  ownershipUnion,
  parseRepairOwnershipAudit,
  markResolutionNeedsPmDecision,
  ensureRepairTask,
  terminalizeSupersededPendingRepair,
  markRepairAwaitingReview,
  acceptanceSourceIds,
  acceptanceReviewerConflictTask,
  markAcceptanceFailureResolution,
  resolvePmConsumer,
  finalizeReclaimedTasks,
  acquirePmReviewLock,
  runWithPmDecisionLockCleanup,
  pendingMember,
  parseIndexedPendingEvent,
  isUnreviewedDoneTask,
  removeStalePendingReviews,
  ensureLegacyReviewIndexes,
  readConsumerPending,
  findEventForAck,
  PREFIX,
  scanKeys,
  getGitHeadSha,
  sqliteStore,
  type PmDecisionLock,
} from '../service.js';

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
local project_reservation_id = ARGV[11]

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
local task_reservation_id = redis.call('HGET', KEYS[1], 'wake_reservation_id') or ''
local task_reservation_expires = tonumber(redis.call('HGET', KEYS[1], 'wake_reservation_expires_at') or '0') or 0
if project_reservation_id ~= '' then
  if task_reservation_id ~= project_reservation_id or task_reservation_expires < tonumber(now) then
    return {'PROJECT_RESERVATION_INVALID'}
  end
  if (redis.call('HGET', KEYS[13], 'reservation_id') or '') ~= project_reservation_id or
     (redis.call('HGET', KEYS[13], 'task_id') or '') ~= task_id or
     (redis.call('HGET', KEYS[13], 'agent_id') or '') ~= agent_id or
     (redis.call('HGET', KEYS[13], 'status') or '') ~= 'reserved' or
     tonumber(redis.call('HGET', KEYS[13], 'expires_at') or '0') < tonumber(now) then
    return {'PROJECT_RESERVATION_INVALID'}
  end
elseif task_reservation_id ~= '' and task_reservation_expires >= tonumber(now) then
  return {'TASK_RESERVED'}
else
  redis.call('HDEL', KEYS[1],
    'wake_reservation_id', 'wake_reservation_binding_id', 'wake_reservation_expires_at')
end
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
  'claim_request_token', claim_token,
  'claim_request_reservation_id', project_reservation_id)
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
if project_reservation_id ~= '' then
  redis.call('HSET', KEYS[13],
    'status', 'claimed',
    'claim_attempt_id', claim_attempt_id,
    'registration_id', registration_id,
    'claimed_at', now)
  redis.call('PEXPIRE', KEYS[13], tonumber(lease_ttl_ms))
  redis.call('HDEL', KEYS[1],
    'wake_reservation_id', 'wake_reservation_binding_id', 'wake_reservation_expires_at')
end
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
return {'REPLAY', task_id, claim_token, redis.call('HGET', KEYS[1], 'claim_request_reservation_id') or ''}
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

async function rebuildClaimPayload(
  redis: Redis,
  taskId: string,
  claimToken: string,
  reservationId = '',
): Promise<ClaimedTask | undefined> {
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
    ...(reservationId ? { reservation_id: reservationId } : {}),
    ...(task.model_override?.trim() ? { model_override: task.model_override.trim() } : {}),
    ...(questionAnswer ? { question_answer: questionAnswer } : {}),
    ...(questionId ? { question_id: questionId } : {}),
    ...(questionCheckpoint ? { question_checkpoint: questionCheckpoint } : {}),
  };
}

/** claim（核心，对应 06 号 md 完整流程） */
type ClaimRequestWithReservation = ClaimRequest & { reservation_id?: string };

async function claimUnlocked(
  redis: Redis,
  req: ClaimRequestWithReservation,
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
  const projectReservationId = req.reservation_id?.trim() ?? '';
  if (projectReservationId && !/^reservation_[a-f0-9]{32}$/.test(projectReservationId)) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_PROJECT_AGENT_RESERVATION', message: 'reservation_id 格式无效' },
    };
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
    const replayReservationId = String(replayRaw[3] ?? '');
    const replayed = replayTaskId && replayToken
      ? await rebuildClaimPayload(redis, replayTaskId, replayToken, replayReservationId)
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

  // A transport retry reaches this point after the original reservation has already changed from
  // `reserved` to `claimed`. Replay must therefore run before this new-claim validity check; a
  // different claim_request_id still fails closed here and cannot redeem the reservation twice.
  let projectReservation: Record<string, string> | undefined;
  if (projectReservationId) {
    projectReservation = await redis.hgetall(projectAgentReservationKey(projectReservationId));
    if (
      projectReservation.reservation_id !== projectReservationId ||
      projectReservation.status !== 'reserved' ||
      projectReservation.agent_id !== req.agent_id ||
      Number(projectReservation.expires_at ?? 0) < Date.now()
    ) {
      return {
        ok: false,
        data: null,
        error: { code: 'PROJECT_AGENT_RESERVATION_INVALID', message: 'reservation 已失效、已兑现或不属于当前 Agent' },
      };
    }
  }

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
    const pendingIds = projectReservation
      ? [projectReservation.task_id]
      : await redis.zrange(keys.zset.status.pending, 0, -1);
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
      const [taskReservationId = '', taskReservationExpiresRaw = '0'] = await redis.hmget(
        keys.hash.task(task.task_id),
        'wake_reservation_id',
        'wake_reservation_expires_at',
      );
      const taskReservationExpiresAt = Number(taskReservationExpiresRaw ?? 0);
      if (projectReservationId) {
        if (taskReservationId !== projectReservationId || projectReservation?.task_id !== task.task_id) continue;
      } else if (taskReservationId && taskReservationExpiresAt >= Date.now()) {
        continue;
      } else if (sqliteStore) {
        // 只有指派给特定 Agent/harness 的 binding 管理 lane 才对普通 claim 关闭；
        // auto lane 对所有已注册 Agent 开放（复制进入的 Worker 领取成功即自动加入
        // 项目，无需前端"添加"）。claimer 自己的 binding 不构成对自己的排除，
        // 活跃 reservation 由上方 taskReservationId 分支继续保护 wake 窗口。
        const bound = sqliteStore.getProjectAgentBindings(task.project_path).some((row) => {
          const binding = publicBinding(row);
          const bindingAssignee = task.assignee || 'auto';
          return binding.agent_id !== req.agent_id && binding.capabilities.includes(task.type) && (
            bindingAssignee === binding.agent_id || bindingAssignee === binding.harness_kind
          );
        });
        if (bound) continue;
      }
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
          !projectReservationId,
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
        ...(projectReservationId ? { reservation_id: projectReservationId } : {}),
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
        13,
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
        projectAgentReservationKey(projectReservationId || '__none__'),
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
        projectReservationId,
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
        if (projectReservationId && claimOutcome === 'PROJECT_RESERVATION_INVALID') {
          terminalClaimError = {
            code: 'PROJECT_AGENT_RESERVATION_INVALID',
            message: 'reservation 在 claim 提交前已失效或与目标 task 不一致',
          };
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

      // 领取成功即视为已加入该项目：从注册真相补全 automatic 绑定，复制进入的
      // Worker 默认"已添加"，无需再到前端点添加。roster 记账失败只影响显示，
      // 绝不影响已提交的领取结果。
      try {
        await connectProjectAgent(redis, task.project_path, req.agent_id);
      } catch {
        // 绑定竞态或 SQLite 异常不构成 claim 失败。
      }

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
  req: ClaimRequestWithReservation,
  signal?: AbortSignal,
): Promise<ApiResponse<ClaimedTask | null>> {
  return claimUnlocked(redis, req, signal);
}

/** report（核心） */
function workspaceInlineResultError(error: unknown): ApiResponse<never> {
  const code = (error as { code?: string })?.code === 'WORKSPACE_PATH_DENIED'
    ? 'WORKSPACE_PATH_DENIED'
    : 'RESULT_MATERIALIZE_FAILED';
  return { ok: false, data: null, error: { code, message: '内联产物无法在中央工作区落盘' } };
}

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

  // 远程 Worker（经 MCP 接入的 harness 会话）没有中央工作区的文件系统访问：
  // report 可直接携带产物正文，由中央在受控 work 目录落盘；显式路径仍然优先。
  const inlineResultMd = typeof req.result_md === 'string' ? req.result_md : undefined;
  const inlineResultJson = typeof req.result_json === 'string' ? req.result_json : undefined;
  let serverProjectRoot: string | undefined;
  let serverWorkDir: string | undefined;
  if (inlineResultMd !== undefined || inlineResultJson !== undefined || req.execute_verify === true) {
    try {
      serverProjectRoot = resolveAndValidateWorkspacePath(taskHash.project_path, configuredWorkspaceRoots());
      serverWorkDir = join(serverProjectRoot, 'work', req.task_id);
      mkdirSync(serverWorkDir, { recursive: true });
    } catch (error) {
      return workspaceInlineResultError(error);
    }
  }

  const reportFailureReason = req.status === 'done'
    ? ''
    : failureReasonForReport(req.status, req.verify_results ?? []);

  // execute_verify 的中央执行结果必须与 Worker 自报结果走同一条持久化路径；
  // 否则 PM Review 只能看到空 verify 证据，done≠accepted 的证据链断裂。
  let finalVerifyResults = req.verify_results ?? [];

  let resultPath = req.result_path ?? '';
  let resultJsonPath = req.result_json_path ?? '';
  if (inlineResultMd !== undefined && !resultPath) {
    resultPath = join(serverWorkDir!, 'result.md');
    writeFileSync(resultPath, inlineResultMd);
  }
  if (inlineResultJson !== undefined && !resultJsonPath) {
    resultJsonPath = join(serverWorkDir!, 'result.json');
    writeFileSync(resultJsonPath, inlineResultJson);
  }

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
    let verifyResults = req.verify_results ?? [];
    // execute_verify：中央在任务工作区代执行声明的 verify 并记录真实退出码。
    // verify 命令本身不回传 Agent；远程 Worker 不必能在本地复现服务端路径。
    if (req.execute_verify === true && verifyResults.length === 0 && declaredVerify.length > 0) {
      if (!serverProjectRoot) {
        return workspaceInlineResultError(new Error('missing project root'));
      }
      verifyResults = declaredVerify.map((declared) => {
        const run = spawnSync(declared.cmd, {
          shell: true,
          cwd: serverProjectRoot,
          timeout: 120_000,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        });
        const exitCode = run.status ?? 1;
        return {
          cmd: declared.cmd,
          exit_code: exitCode,
          passed: exitCode === (declared.expect_exit ?? 0),
          output: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(0, 4096) || '(no output)',
        };
      });
    }
    finalVerifyResults = verifyResults;
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
            verify_results: JSON.stringify(finalVerifyResults),
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
            verify_results: JSON.stringify(finalVerifyResults),
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
      verify_results: JSON.stringify(finalVerifyResults),
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
  const verifyFailed = finalVerifyResults.some((v) => !v.passed);
  if (req.status !== 'done') {
    const failures = summarizeVerifyFailures(finalVerifyResults);
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

export function supersedeValidation(req: Partial<TaskSupersedeRequest>): { code: string; message: string } | null {
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

export function isSupersedeCandidate(hash: Record<string, string>): boolean {
  return hash.status === 'done' &&
    !(hash.pm_review_status ?? '').trim() &&
    !(hash.resolution_status ?? '').trim();
}

export function taskDependsOn(hash: Record<string, string>, taskId: string): boolean {
  return (hash.depends_on ?? '').split(',').filter(Boolean).includes(taskId);
}

export function isAbandonedTerminal(hash: Record<string, string>): boolean {
  return hash.status === 'cancelled' || hash.status === 'superseded';
}

export async function allTaskHashes(redis: Redis): Promise<Record<string, string>[]> {
  const taskKeys = await scanKeys(redis, `${PREFIX}:hash:task:*`);
  const hashes = await Promise.all(taskKeys.map((key) => redis.hgetall(key)));
  return hashes.filter((hash) => Boolean(hash.task_id));
}

export async function activeDependents(
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

export async function applySupersedeBatch(
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

export function stableSupersedeToken(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
export async function requeueBlockedEligible(
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
export async function requeueFileWaiters(redis: Redis): Promise<string[]> {
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
export async function requeueDependencyWaiters(redis: Redis, completedTaskId: string): Promise<string[]> {
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
 * 一个依赖结点转为“有效完成”后唤醒其直接下游。
 *
 * 这里是唯一的依赖 ready 出口：report done 只能放开独立 acceptance，PM accept 或
 * repair resolution 才会放开普通下游；这样普通代码不会绕过 PM 验收，而验收任务也
 * 不会反向卡住自身。
 */
export async function wakeDependents(
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

/* ════════════════════════════════════════════════════════════════════ */
/* V2 Worker SSE 唤醒通道（P12 车道 B · 复用 V1 /events/stream 轮询骨架） */
/* ════════════════════════════════════════════════════════════════════ */

/**
 * GET /v2/events/stream —— Worker 专用 task_ready 推送端点。
 *
 * 目标（§ 调度唤醒）：100 台 Worker 轮询 claim（每台 12 req/min）改为服务端
 * 有任务时才推 `task_ready`，空闲时网络归零；daemon 侧保留轮询 fallback
 * （SSE 断线自动降级，见 src/node/daemon.ts）。
 *
 * 鉴权：bvn2 Node credential（与 claim 同一凭据面）。唤醒只是提示——
 * 真正的 binding/write_capability/generation 校验仍在 POST /v2/tasks/claim
 * 内 fail-closed 完成，越权的 Worker 顶多被叫醒后空手而归。
 *
 * 事件源：keys.stream.tasks（V1 调度唤醒流，plan 提交/重排队/Question 解答
 * 每次有任务进入 pending 都会 XADD）。复用 V1 SSE 的非阻塞骨架：
 * XREAD 不带 BLOCK + setTimeout 让出事件循环，15s 注释行心跳防代理超时。
 *
 * 旗门禁：NODE_RUNTIME（依赖序保证 DISTRIBUTED_MODE/ARTIFACTS 已开）；
 * 关旗 → 404，与 v2-routes 的 V2_FLAG_DISABLED 语义一致。
 */

export interface V2WorkerEventStreamOptions {
  store: SqliteStore;
  redis: Redis;
  credentialOptions?: IssueCredentialOptions;
  featureFlags?: V2FeatureFlags;
}

/** SSE 心跳/轮询节奏（与 V1 /events/stream 一致）。 */
const V2_EVENT_STREAM_POLL_INTERVAL_MS = 2_000;
const V2_EVENT_STREAM_HEARTBEAT_MS = 15_000;
const V2_EVENT_STREAM_RECONNECT_HINT_MS = 5_000;

function verifyWorkerEventStreamCredential(
  token: string,
  store: SqliteStore,
  credOpts: IssueCredentialOptions,
): { ok: true; nodeId: string } | { ok: false; code: string; message: string } {
  if (!token.startsWith('bvn2_')) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'events/stream 需要 bvn2 Node credential' };
  }
  for (const node of store.listNodes()) {
    const result = verifyNodeCredential(token, node.node_id, {
      ...credOpts,
      expectedGeneration: node.credential_generation,
    });
    if (result.ok) return { ok: true, nodeId: node.node_id };
  }
  return { ok: false, code: 'UNAUTHORIZED', message: 'bvn2 Node credential 无效或已过期' };
}

/** 注册 GET /v2/events/stream（http.ts 的 apiRoutes 作用域内调用一次）。 */
export function registerV2WorkerEventStream(
  app: FastifyInstance,
  options: V2WorkerEventStreamOptions,
): void {
  const featureFlags = options.featureFlags ?? resolveAndValidateV2FeatureFlags(process.env);

  app.get('/v2/events/stream', async (req, reply) => {
    if (!featureFlags.NODE_RUNTIME) {
      return reply.status(404).send({
        ok: false,
        data: null,
        error: {
          code: featureFlags.DISTRIBUTED_MODE ? 'V2_FLAG_DISABLED' : 'V2_DISABLED',
          message: `${V2_FEATURE_FLAG_ENV_NAMES.NODE_RUNTIME} 未开启：GET /v2/events/stream 已关闭`,
        },
      });
    }

    const bearer = (req.headers.authorization ?? '');
    const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
    const auth = verifyWorkerEventStreamCredential(token, options.store, options.credentialOptions ?? {});
    if (!auth.ok) {
      return reply.status(401).send({
        ok: false,
        data: null,
        error: { code: auth.code, message: auth.message },
      });
    }

    // 接管原始响应（SSE 长连接）：必须显式 hijack，否则 Fastify 认为该请求
    // 未收口，app.close()（测试 teardown/进程收口）会一直等这条连接。
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Biao-Node-Id': auth.nodeId,
    });
    reply.raw.write(`retry: ${V2_EVENT_STREAM_RECONNECT_HINT_MS}\n`);

    // last_id：缺省 '$'（只推连接后的新唤醒，避免重连风暴回放全量）；
    // 显式 stream id 则从该点续读（断线重连的 at-least-once 补齐）。
    const requested = (req.query as { last_id?: string }).last_id ?? '$';
    let cursor = '0-0';
    if (/^\d+-\d+$/.test(requested)) {
      cursor = requested;
    } else {
      const latest = await options.redis.xrevrange(keys.stream.tasks, '+', '-', 'COUNT', 1);
      cursor = latest[0]?.[0] ?? '0-0';
    }

    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;

    const poll = async () => {
      while (!closed) {
        try {
          if (await getRestoreMaintenanceGate(options.redis)) {
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            reply.raw.end();
            break;
          }
          const msgs = (await (options.redis as unknown as {
            xread(...args: unknown[]): Promise<[string, [string, string[]][]][] | null>;
          }).xread('COUNT', 50, 'STREAMS', keys.stream.tasks, cursor)) as [string, [string, string[]][]][] | null;
          if (await getRestoreMaintenanceGate(options.redis)) {
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            reply.raw.end();
            break;
          }
          if (msgs) {
            for (const [, entries] of msgs) {
              for (const [msgId, fields] of entries) {
                cursor = msgId;
                const kv: Record<string, string> = {};
                for (let i = 0; i < fields.length; i += 2) kv[fields[i]] = fields[i + 1];
                reply.raw.write(
                  `event: task_ready\n` +
                  `data: ${JSON.stringify({
                    type: 'task_ready',
                    task_id: kv.task_id ?? '',
                    priority: kv.priority ?? '',
                    ts: Number(msgId.split('-')[0]),
                  })}\n\n`,
                );
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, V2_EVENT_STREAM_POLL_INTERVAL_MS));
        } catch {
          break; // 连接关闭或 Redis 错误
        }
      }
    };
    void poll();

    heartbeat = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        // ignore
      }
    }, V2_EVENT_STREAM_HEARTBEAT_MS);

    req.raw.on('close', () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
    });
  });
}
