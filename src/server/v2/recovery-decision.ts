/**
 * Recovery decision：takeover/discard 签名决策 + 三崩溃点续跑 + batch 逐项
 * 结果 + RecoveryIsolation 三步分权（后续增强·车道 C）
 *
 * 覆盖审计项：
 * - 22.4-26：决策缺字段、签名错误、超过 15 分钟 TTL → 拒绝并幂等重新获取；
 * - 22.4-27：TTL 以单调坐标验：决策时间不得早于 candidate revision 时间-容差；
 * - 22.4-29：takeover 决策落库/attempt fencing/task 释放三崩溃点续跑，
 *   attempt CAS 保证不产生双 attempt；
 * - 22.4-31：batch takeover/discard 逐项 revision 与 error（单项失败不影响其余）；
 * - 22.4-06：RecoveryIsolation isolator/reviewer/resolve 三步分权，
 *   同一 actor 不能自建自审，review/resolve 字段与事件入审计。
 *
 * 签名密钥：复用控制面 signing key（credentials.ts 的 V2 credential keyring，
 * 本车道不新增密钥面；§13.4 独立 Recovery Signing Key 生命周期属后续车道）。
 * 密钥不可用时 fail-closed——绝不签发/接受无签名裁决（§18 矩阵）。
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type {
  AuditEventRow,
  OrphanRecoveryCandidateRow,
  RecoveryIsolationRow,
} from '../../types/v2-infra.js';
import type { V2CredentialKey } from './credentials.js';
import type { ApiResponse } from '../../types/index.js';

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail<T = never>(code: string, message: string): ApiResponse<T> {
  return { ok: false, data: null, error: { code, message } };
}

/* ================================================================== */
/* 22.4-26/27：签名决策信封                                             */
/* ================================================================== */

/** §4.4.1：decision 默认 TTL = 15 分钟；过期后按 candidate_id 幂等重新获取。 */
export const RECOVERY_DECISION_TTL_MS = 15 * 60 * 1000;

/**
 * §4.4.1 单调偏移容差：决策 issued_at 与 candidate revision 写入时间
 * （decided_at）的允许偏差。决策时间早于 revision 时间-容差 → 拒绝，
 * 不用宽松本地时间延长 TTL（22.4-27）。
 */
export const RECOVERY_DECISION_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** 决策动作（§4.4.1 decision 枚举的裁决子集）。 */
export type RecoveryDecisionAction = 'upload-and-reverify' | 'discard-after-audit';

/** 签名决策信封（canonical payload 固定字段序，§4.4.1）。 */
export interface RecoveryDecisionEnvelope {
  schema_version: 2;
  candidate_id: string;
  candidate_revision: number;
  attempt_id: string;
  decision: RecoveryDecisionAction;
  decided_by: string;
  issued_at: number;   // 毫秒
  expires_at: number;  // 毫秒 = issued_at + RECOVERY_DECISION_TTL_MS
  key_id: string;      // 签名 key 的 key_version
  signature: string;   // hex HMAC-SHA256
}

/** canonical payload：字段序固定（schema_version → … → key_id），不含 signature。 */
export function canonicalRecoveryDecisionPayload(env: Omit<RecoveryDecisionEnvelope, 'signature'>): string {
  return [
    env.schema_version,
    env.candidate_id,
    env.candidate_revision,
    env.attempt_id,
    env.decision,
    env.decided_by,
    env.issued_at,
    env.expires_at,
    env.key_id,
  ].join('\n');
}

function hmacDigest(key: V2CredentialKey, payload: string): string {
  return createHmac('sha256', key.material).update(payload, 'utf8').digest('hex');
}

/** 选最高 key_version 的密钥签发（复用控制面 signing key）。 */
function pickSigningKey(keyring: readonly V2CredentialKey[]): V2CredentialKey | null {
  if (keyring.length === 0) return null;
  return keyring.reduce((max, key) => (key.key_version > max.key_version ? key : max), keyring[0]!);
}

export interface SignRecoveryDecisionInput {
  candidate_id: string;
  candidate_revision: number;
  attempt_id: string;
  decision: RecoveryDecisionAction;
  decided_by: string;
  /** 签发时间（默认 now；测试可注入）。 */
  issued_at?: number;
}

/**
 * 签发决策信封（22.4-26）：含 candidate revision + decided_by + 15min TTL。
 * keyring 为空 → fail-closed NOT_CONFIGURED（不返回无签名裁决）。
 */
export function signRecoveryDecision(
  input: SignRecoveryDecisionInput,
  keyring: readonly V2CredentialKey[],
): ApiResponse<RecoveryDecisionEnvelope> {
  const key = pickSigningKey(keyring);
  if (!key) {
    return fail('NOT_CONFIGURED', '控制面 signing key 未配置，fail-closed：不签发无签名 recovery decision（§18 矩阵）');
  }
  const issuedAt = input.issued_at ?? Date.now();
  const unsigned: Omit<RecoveryDecisionEnvelope, 'signature'> = {
    schema_version: 2,
    candidate_id: input.candidate_id,
    candidate_revision: input.candidate_revision,
    attempt_id: input.attempt_id,
    decision: input.decision,
    decided_by: input.decided_by,
    issued_at: issuedAt,
    expires_at: issuedAt + RECOVERY_DECISION_TTL_MS,
    key_id: `v${key.key_version}`,
  };
  return ok({ ...unsigned, signature: hmacDigest(key, canonicalRecoveryDecisionPayload(unsigned)) });
}

export interface VerifyRecoveryDecisionContext {
  /** 校验时刻（单调坐标；生产来自 heartbeat server time，测试注入）。 */
  now_ms: number;
  /** 信任 keyring（含历史公钥归档语义：按 key_id 匹配 material）。 */
  keyring: readonly V2CredentialKey[];
  /** 决策针对的 candidate 现状（revision/decided_at/消费标记）。 */
  candidate: OrphanRecoveryCandidateRow;
  /** 是否执行一次性消费检查（consume 场景 true；纯验签 false）。 */
  check_consumed?: boolean;
}

export type RecoveryDecisionRejectCode =
  | 'MISSING_FIELDS'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'SIGNATURE_INVALID'
  | 'DECISION_EXPIRED'
  | 'DECISION_ISSUED_IN_FUTURE'
  | 'REVISION_STALE'
  | 'DECISION_NOT_MONOTONIC'
  | 'DECISION_ALREADY_CONSUMED'
  | 'CANDIDATE_MISMATCH';

/**
 * 校验决策信封（22.4-26/27），按序检查：
 * 1. 字段完整 + schema_version；
 * 2. 签名（key_id 匹配信任 keyring 的 HMAC）；
 * 3. TTL 未过（now < expires_at）且 issued_at 不在未来容差外；
 * 4. REVISION_STALE：信封 revision ≠ candidate 当前 revision；
 * 5. 单调偏移防护：issued_at ≥ candidate revision 时间（decided_at）- 容差
 *    ——决策时间不得早于 candidate revision 时间-容差（22.4-27）；
 * 6. CANDIDATE_MISMATCH：candidate_id/attempt_id 与现状一致；
 * 7. 一次性消费：decision_consumed_at 非空 → 拒绝（防重放）。
 */
export function verifyRecoveryDecisionEnvelope(
  envelope: RecoveryDecisionEnvelope,
  ctx: VerifyRecoveryDecisionContext,
): { ok: true } | { ok: false; code: RecoveryDecisionRejectCode; message: string } {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, code: 'MISSING_FIELDS', message: 'decision 信封缺失' };
  }
  const required: Array<keyof RecoveryDecisionEnvelope> = [
    'schema_version', 'candidate_id', 'candidate_revision', 'attempt_id',
    'decision', 'decided_by', 'issued_at', 'expires_at', 'key_id', 'signature',
  ];
  for (const field of required) {
    const value = envelope[field];
    if (value === undefined || value === null || value === '') {
      return { ok: false, code: 'MISSING_FIELDS', message: `decision 信封缺字段 ${String(field)}` };
    }
  }
  if (envelope.schema_version !== 2) {
    return { ok: false, code: 'SCHEMA_VERSION_UNSUPPORTED', message: `schema_version=${envelope.schema_version} 不受支持` };
  }
  const keyVersion = Number(String(envelope.key_id).replace(/^v/, ''));
  const key = ctx.keyring.find((k) => k.key_version === keyVersion);
  if (!key) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: `key_id=${envelope.key_id} 不在信任 keyring（已 revoke/未知 generation）` };
  }
  const { signature, ...unsigned } = envelope;
  const expected = hmacDigest(key, canonicalRecoveryDecisionPayload(unsigned));
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: 'SIGNATURE_INVALID', message: '决策签名不匹配' };
  }
  if (ctx.now_ms >= envelope.expires_at) {
    return { ok: false, code: 'DECISION_EXPIRED', message: `decision 已过 TTL（expires_at=${envelope.expires_at}，now=${ctx.now_ms}）；按 candidate_id 幂等重新获取` };
  }
  if (envelope.issued_at - ctx.now_ms > RECOVERY_DECISION_SKEW_TOLERANCE_MS) {
    return { ok: false, code: 'DECISION_ISSUED_IN_FUTURE', message: `decision issued_at=${envelope.issued_at} 超前当前单调坐标 ${ctx.now_ms} 超过容差` };
  }
  if (envelope.candidate_revision !== ctx.candidate.revision) {
    return { ok: false, code: 'REVISION_STALE', message: `decision revision=${envelope.candidate_revision} 落后 candidate revision=${ctx.candidate.revision}（CAS 已前滚）` };
  }
  const revisionTime = ctx.candidate.decided_at ?? 0;
  if (envelope.issued_at + RECOVERY_DECISION_SKEW_TOLERANCE_MS < revisionTime) {
    return {
      ok: false,
      code: 'DECISION_NOT_MONOTONIC',
      message: `decision issued_at=${envelope.issued_at} 早于 candidate revision 时间 ${revisionTime}-容差（单调偏移防护，22.4-27）`,
    };
  }
  if (envelope.candidate_id !== ctx.candidate.candidate_id || envelope.attempt_id !== ctx.candidate.attempt_id) {
    return { ok: false, code: 'CANDIDATE_MISMATCH', message: 'decision 与 candidate 身份不匹配' };
  }
  if (ctx.check_consumed && (ctx.candidate.decision_consumed_at ?? null) !== null) {
    return { ok: false, code: 'DECISION_ALREADY_CONSUMED', message: `decision 已于 ${ctx.candidate.decision_consumed_at} 消费（一次性，防重放）` };
  }
  return { ok: true };
}

/**
 * 消费决策（一次性）：验签通过后写 decision_consumed_at 并入审计。
 * 二次提交同一信封 → DECISION_ALREADY_CONSUMED（22.4-26 防重放）。
 */
export function consumeRecoveryDecision(
  store: SqliteStore,
  envelope: RecoveryDecisionEnvelope,
  ctx: Pick<VerifyRecoveryDecisionContext, 'now_ms' | 'keyring'>,
): ApiResponse<{ consumed_at: number }> {
  const candidate = store.getOrphanRecoveryCandidate(envelope.candidate_id);
  if (!candidate) return fail('NOT_FOUND', `candidate ${envelope.candidate_id} 不存在`);
  const verdict = verifyRecoveryDecisionEnvelope(envelope, { ...ctx, candidate, check_consumed: true });
  if (!verdict.ok) return fail(verdict.code, verdict.message);
  store.updateOrphanRecoveryCandidate(candidate.candidate_id, { decision_consumed_at: ctx.now_ms } as Partial<OrphanRecoveryCandidateRow>);
  audit(store, 'recovery_decision.consumed', 'orphan_recovery_candidate', candidate.candidate_id, envelope.decided_by, candidate.project_id);
  return ok({ consumed_at: ctx.now_ms });
}

/* ================================================================== */
/* 22.4-29：takeover 三崩溃点续跑                                        */
/* ================================================================== */

/** takeover 可续跑阶段（崩溃点注入只用于测试模拟 kill）。 */
export type TakeoverPhase = 'decide' | 'fence-attempt' | 'release-task';

export interface RunControlPlaneTakeoverInput {
  reason: string;
  decided_by: string;
  /** 测试注入：在该阶段后立即停止（模拟控制面崩溃）。 */
  halt_after?: TakeoverPhase;
  /** 签发时间（测试注入）。 */
  issued_at?: number;
}

export interface TakeoverRunResult {
  candidate: OrphanRecoveryCandidateRow;
  /** 本轮实际执行到的阶段（续跑收敛后为 null = 全部已完成）。 */
  halted_after: TakeoverPhase | null;
  envelope: RecoveryDecisionEnvelope | null;
  steps_executed: TakeoverPhase[];
}

/**
 * 控制面 CAS takeover（§4.4.1 control-plane-takeover / §5.1）：
 *
 *   decide        candidate pending → decided（CAS revision+1，信封留档）
 *   fence-attempt attempt executing（且 lease 已过期）→ pending_recovery
 *   release-task  task.active_attempt_id===旧 attempt → 回 pending
 *
 * 三崩溃点（决策落库后/attempt fencing 后/task 释放后）重启重入：每阶段幂等
 * ——已完成的阶段直接跳过，不重复 cancel/invalidate、不产生第二个 attempt
 * （attempt CAS：executing→pending_recovery 条件更新 + task 指针条件释放；
 * 新 attempt 已被其它节点 claim 后重入不再触碰 task/attempt）。
 */
export function runControlPlaneTakeover(
  store: SqliteStore,
  candidateId: string,
  input: RunControlPlaneTakeoverInput,
  keyring: readonly V2CredentialKey[],
): ApiResponse<TakeoverRunResult> {
  const candidate = store.getOrphanRecoveryCandidate(candidateId);
  if (!candidate) return fail('NOT_FOUND', `candidate ${candidateId} 不存在`);
  if (['resolved', 'isolated'].includes(candidate.status)) {
    return fail('INVALID_STATUS', `candidate ${candidateId} 已 ${candidate.status}，不可 takeover`);
  }

  const steps: TakeoverPhase[] = [];
  const now = Date.now();
  let envelope: RecoveryDecisionEnvelope | null = null;
  let current = candidate;

  // ── 阶段 1：decide（决策落库；CAS pending → decided） ──
  if (current.status === 'pending') {
    const signed = signRecoveryDecision(
      {
        candidate_id: current.candidate_id,
        candidate_revision: current.revision + 1,
        attempt_id: current.attempt_id,
        decision: 'upload-and-reverify',
        decided_by: input.decided_by,
        issued_at: input.issued_at ?? now,
      },
      keyring,
    );
    if (!signed.ok) return fail(signed.error!.code, signed.error!.message);
    envelope = signed.data;
    store.updateOrphanRecoveryCandidate(candidateId, {
      status: 'decided' as const,
      decision: 'upload-and-reverify' as const,
      takeover_reason: input.reason,
      takeover_at: now,
      decided_by: input.decided_by,
      decided_at: now,
      revision: current.revision + 1,
      decision_envelope: JSON.stringify(signed.data),
      decision_consumed_at: null,
    } as Partial<OrphanRecoveryCandidateRow>);
    steps.push('decide');
    current = store.getOrphanRecoveryCandidate(candidateId)!;
    audit(store, 'recovery_decision.takeover_decided', 'orphan_recovery_candidate', candidateId, input.decided_by, current.project_id);
    if (input.halt_after === 'decide') {
      return ok({ candidate: current, halted_after: 'decide', envelope, steps_executed: steps });
    }
  } else if (current.status === 'decided' && current.decision === 'upload-and-reverify') {
    // 崩溃重入：决策已落库，从 durable 状态续跑（不重复 CAS，不提前消费）
    envelope = current.decision_envelope ? JSON.parse(current.decision_envelope) as RecoveryDecisionEnvelope : null;
  }

  // ── 阶段 2：fence-attempt（attempt CAS：executing + lease 过期才 fencing） ──
  const attempt = store.getTaskAttempt(current.attempt_id);
  if (attempt) {
    if (attempt.status === 'executing') {
      if (attempt.lease_expires_at > now) {
        return fail('TAKEOVER_PRECONDITION_FAILED', `attempt ${attempt.attempt_id} lease 未过期（${attempt.lease_expires_at}），watchdog/session fencing 前不得 takeover`);
      }
      store.updateTaskAttempt(attempt.attempt_id, {
        status: 'pending_recovery',
        failure_reason: 'node-offline-takeover',
        updated_at: now,
      });
      steps.push('fence-attempt');
    } else if (!['pending_recovery', 'done', 'failed', 'cancelled', 'fenced', 'lease_lost'].includes(attempt.status)) {
      // 非 executing 的活跃中间态（claiming 等）同样按 lease 判定 fencing
      if (attempt.lease_expires_at <= now) {
        store.updateTaskAttempt(attempt.attempt_id, {
          status: 'pending_recovery',
          failure_reason: 'node-offline-takeover',
          updated_at: now,
        });
        steps.push('fence-attempt');
      }
    }
    // 已 pending_recovery/终态：崩溃重入幂等跳过
    if (input.halt_after === 'fence-attempt' && steps.includes('fence-attempt')) {
      return ok({
        candidate: store.getOrphanRecoveryCandidate(candidateId)!,
        halted_after: 'fence-attempt',
        envelope,
        steps_executed: steps,
      });
    }

    // ── 阶段 3：release-task（task 指针 CAS：active_attempt_id===旧 attempt 才释放） ──
    const task = store.getTask(attempt.task_id);
    if (task && task.active_attempt_id === attempt.attempt_id
      && !['done', 'cancelled', 'superseded'].includes(task.status)) {
      store.updateTaskFields(task.task_id, {
        status: 'pending',
        active_attempt_id: '',
        claimed_by: '',
        claimed_at: '',
        updated_at: new Date(now).toISOString(),
      });
      steps.push('release-task');
    }
    // active_attempt_id 已指向新 attempt（其它节点已重 claim）或任务已终态：
    // 不触碰——保证不产生双 attempt、不覆盖新 attempt
  }

  // 收敛完成：决策已按信封执行，落一次性消费标记（防重放；幂等：已消费跳过）
  const finalized = store.getOrphanRecoveryCandidate(candidateId)!;
  if ((finalized.decision_consumed_at ?? null) === null) {
    store.updateOrphanRecoveryCandidate(candidateId, {
      decision_consumed_at: now,
    } as Partial<OrphanRecoveryCandidateRow>);
  }

  return ok({
    candidate: store.getOrphanRecoveryCandidate(candidateId)!,
    halted_after: null,
    envelope,
    steps_executed: steps,
  });
}

/** discard 决策（留证收口，不接管 attempt）。 */
export function runControlPlaneDiscard(
  store: SqliteStore,
  candidateId: string,
  input: RunControlPlaneTakeoverInput,
  keyring: readonly V2CredentialKey[],
): ApiResponse<{ candidate: OrphanRecoveryCandidateRow; envelope: RecoveryDecisionEnvelope | null }> {
  const candidate = store.getOrphanRecoveryCandidate(candidateId);
  if (!candidate) return fail('NOT_FOUND', `candidate ${candidateId} 不存在`);
  if (candidate.status === 'resolved') {
    // 幂等重入：已 resolved 直接返回（不重复签名/递增 revision）
    const prior = candidate.decision_envelope ? JSON.parse(candidate.decision_envelope) as RecoveryDecisionEnvelope : null;
    return ok({ candidate, envelope: prior });
  }
  if (candidate.status === 'isolated') {
    return fail('INVALID_STATUS', `candidate ${candidateId} 已隔离，处置走 RecoveryIsolation 三步分权`);
  }
  const now = Date.now();
  const signed = signRecoveryDecision(
    {
      candidate_id: candidate.candidate_id,
      candidate_revision: candidate.revision + 1,
      attempt_id: candidate.attempt_id,
      decision: 'discard-after-audit',
      decided_by: input.decided_by,
      issued_at: input.issued_at ?? now,
    },
    keyring,
  );
  if (!signed.ok) return fail(signed.error!.code, signed.error!.message);
  store.updateOrphanRecoveryCandidate(candidateId, {
    status: 'resolved' as const,
    decision: 'discard-after-audit' as const,
    decided_by: input.decided_by,
    decided_at: now,
    resolved_at: now,
    resolution_evidence_digest: createHash('sha256').update(input.reason, 'utf8').digest('hex'),
    revision: candidate.revision + 1,
    decision_envelope: JSON.stringify(signed.data),
    decision_consumed_at: now,
  } as Partial<OrphanRecoveryCandidateRow>);
  audit(store, 'recovery_decision.discard', 'orphan_recovery_candidate', candidateId, input.decided_by, candidate.project_id);
  return ok({ candidate: store.getOrphanRecoveryCandidate(candidateId)!, envelope: signed.data });
}

/* ================================================================== */
/* 22.4-31：batch 逐项结果                                              */
/* ================================================================== */

export interface BatchRecoveryActionItemResult {
  candidate_id: string;
  ok: boolean;
  /** 成功项：决策落库后的 candidate revision。 */
  candidate_revision: number | null;
  /** 成功项：最终状态（takeover=decided / discard=resolved）。 */
  final_status: string | null;
  /** 失败项：错误码。 */
  error_code: string | null;
  error_message: string | null;
}

export interface BatchRecoveryActionsInput {
  candidate_ids: string[];
  action: 'takeover' | 'discard';
  reason: string;
  decided_by: string;
}

/**
 * 批量 takeover/discard：逐项独立执行并返回逐项 revision 与 error；
 * 单项失败不影响其余（22.4-31）。重试时已成功项按幂等语义返回当前
 * revision/终态，不重复递增。
 */
export function runBatchRecoveryActions(
  store: SqliteStore,
  input: BatchRecoveryActionsInput,
  keyring: readonly V2CredentialKey[],
): ApiResponse<{ results: BatchRecoveryActionItemResult[] }> {
  const results: BatchRecoveryActionItemResult[] = [];
  for (const candidateId of input.candidate_ids) {
    try {
      const run = input.action === 'takeover'
        ? runControlPlaneTakeover(store, candidateId, { reason: input.reason, decided_by: input.decided_by }, keyring)
        : runControlPlaneDiscard(store, candidateId, { reason: input.reason, decided_by: input.decided_by }, keyring);
      if (run.ok) {
        const candidate: OrphanRecoveryCandidateRow = input.action === 'takeover'
          ? (run.data as TakeoverRunResult).candidate
          : (run.data as { candidate: OrphanRecoveryCandidateRow }).candidate;
        results.push({
          candidate_id: candidateId,
          ok: true,
          candidate_revision: candidate.revision,
          final_status: candidate.status,
          error_code: null,
          error_message: null,
        });
      } else {
        results.push({
          candidate_id: candidateId,
          ok: false,
          candidate_revision: null,
          final_status: null,
          error_code: run.error?.code ?? 'ACTION_FAILED',
          error_message: run.error?.message ?? '',
        });
      }
    } catch (error) {
      // 单项异常不中断批次（22.4-31：单项失败不影响其余）
      results.push({
        candidate_id: candidateId,
        ok: false,
        candidate_revision: null,
        final_status: null,
        error_code: 'ACTION_THREW',
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok({ results });
}

/* ================================================================== */
/* 22.4-06：RecoveryIsolation 三步分权                                  */
/* ================================================================== */

/** 第 3 步 resolve 的固定 reconcile 服务身份（API 面不接受其它 resolver）。 */
export const RECONCILE_SERVICE_ACTOR = 'reconcile-service';

/** 默认隔离保留期：30 天（§4.4.2 保留期）。 */
const ISOLATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function audit(
  store: SqliteStore,
  action: string,
  subjectType: string,
  subjectId: string,
  actor: string,
  projectId: string | null,
): void {
  const row: AuditEventRow = {
    audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: projectId,
    actor_id: actor,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    correlation_id: `corr-${randomUUID().slice(0, 12)}`,
    evidence_digest: '',
    created_at: Date.now(),
  };
  store.insertAuditEvent(row);
}

export interface CreateRecoveryIsolationInput {
  project_id: string | null;
  transition_id?: string;
  object_type: RecoveryIsolationRow['object_type'];
  object_id: string;
  evidence: string;
  reason: string;
  isolated_by: string;
}

/**
 * 三步分权第 1 步（isolator 创建）：status=isolated + 审计。
 * 同一 object 已有未 resolved 隔离 → 幂等返回既有记录（§20.3 唯一约束语义）。
 */
export function createRecoveryIsolationRecord(
  store: SqliteStore,
  input: CreateRecoveryIsolationInput,
): ApiResponse<RecoveryIsolationRow> {
  if (!input.evidence || input.evidence.trim() === '') {
    return fail('EVIDENCE_REQUIRED', 'isolation 创建必须附带 evidence');
  }
  const existing = store.listRecoveryIsolations(input.project_id ?? undefined).find(
    (i) => i.object_type === input.object_type && i.object_id === input.object_id && i.status !== 'resolved',
  );
  if (existing) {
    return ok(existing);
  }
  const now = Date.now();
  const row: RecoveryIsolationRow = {
    isolation_id: `iso-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: input.project_id,
    transition_id: input.transition_id ?? '',
    object_type: input.object_type,
    object_id: input.object_id,
    evidence_digest: createHash('sha256').update(input.evidence, 'utf8').digest('hex'),
    reason: input.reason,
    status: 'isolated',
    isolated_by: input.isolated_by,
    isolated_at: now,
    retention_until: now + ISOLATION_RETENTION_MS,
    reviewed_by: '',
    reviewed_at: null,
    review_evidence_digest: '',
    resolved_by: '',
    resolved_at: null,
    resolution_evidence: '',
  };
  store.insertRecoveryIsolation(row);
  audit(store, 'recovery_isolation.create', 'recovery_isolation', row.isolation_id, input.isolated_by, input.project_id);
  return ok(store.getRecoveryIsolation(row.isolation_id)!);
}

export interface ReviewRecoveryIsolationInput {
  reviewed_by: string;
  verdict: 'confirm' | 'dispute';
  evidence?: string;
}

/**
 * 三步分权第 2 步（reviewer 复核，≠ isolator）：
 * - 同一 actor 自建自审 → SELF_REVIEW_FORBIDDEN（强制校验，22.4-06）；
 * - confirm → under-review + reviewed_* 字段；
 * - dispute → 保持 isolated（复核未通过不写 reviewed 字段）；
 * review 字段与事件入审计。
 */
export function reviewRecoveryIsolationRecord(
  store: SqliteStore,
  isolationId: string,
  input: ReviewRecoveryIsolationInput,
): ApiResponse<RecoveryIsolationRow> {
  const isolation = store.getRecoveryIsolation(isolationId);
  if (!isolation) return fail('NOT_FOUND', `isolation ${isolationId} 不存在`);
  if (isolation.status !== 'isolated') {
    return fail('INVALID_STATUS', `isolation ${isolationId} status=${isolation.status}，只有 isolated 可复核`);
  }
  if (!input.reviewed_by || input.reviewed_by.trim() === '') {
    return fail('REVIEWER_REQUIRED', 'review 必须声明 reviewed_by');
  }
  if (input.reviewed_by === isolation.isolated_by) {
    return fail('SELF_REVIEW_FORBIDDEN', `reviewer ${input.reviewed_by} 与 isolator 相同：同一 actor 不能自建自审（22.4-06）`);
  }
  if (input.verdict === 'confirm') {
    store.updateRecoveryIsolation(isolationId, {
      status: 'under-review',
      reviewed_by: input.reviewed_by,
      reviewed_at: Date.now(),
      review_evidence_digest: createHash('sha256').update(input.evidence ?? '', 'utf8').digest('hex'),
    });
  }
  // dispute：保持 isolated，不写 reviewed 字段（复核未通过）
  audit(
    store,
    `recovery_isolation.review.${input.verdict}`,
    'recovery_isolation',
    isolationId,
    input.reviewed_by,
    isolation.project_id,
  );
  return ok(store.getRecoveryIsolation(isolationId)!);
}

export interface ResolveRecoveryIsolationInput {
  resolved_by: string;
  resolution: string;
}

/**
 * 三步分权第 3 步（reconcile 服务 resolve）：
 * - 必须先经独立 reviewer confirm（status=under-review）；
 * - resolved_by 固定为 reconcile 服务身份；
 * - resolution evidence 必填；字段与事件入审计。
 */
export function resolveRecoveryIsolationRecord(
  store: SqliteStore,
  isolationId: string,
  input: ResolveRecoveryIsolationInput,
): ApiResponse<RecoveryIsolationRow> {
  const isolation = store.getRecoveryIsolation(isolationId);
  if (!isolation) return fail('NOT_FOUND', `isolation ${isolationId} 不存在`);
  if (isolation.status !== 'under-review') {
    return fail('INVALID_STATUS', `isolation ${isolationId} status=${isolation.status}：resolve 前必须有独立 reviewer confirm（三步分权）`);
  }
  if (!input.resolution || input.resolution.trim() === '') {
    return fail('EVIDENCE_REQUIRED', 'resolve 必须附带 resolution evidence');
  }
  if (input.resolved_by !== RECONCILE_SERVICE_ACTOR) {
    return fail('RESOLVER_NOT_ALLOWED', `resolve 只能由 reconcile 服务（${RECONCILE_SERVICE_ACTOR}）执行，不接受 ${input.resolved_by}`);
  }
  store.updateRecoveryIsolation(isolationId, {
    status: 'resolved',
    resolved_by: input.resolved_by,
    resolved_at: Date.now(),
    resolution_evidence: input.resolution,
  });
  audit(store, 'recovery_isolation.resolve', 'recovery_isolation', isolationId, input.resolved_by, isolation.project_id);
  return ok(store.getRecoveryIsolation(isolationId)!);
}
