/**
 * V2 基础设施表行类型与状态枚举。
 * 对应 docs/distributed-multi-node-development-plan.md §20.1 最小字段表、§4 状态机。
 *
 * 过渡决策：所有 project_id 暂允许 NULL（Phase 1 才有 projects 表的外键约束）。
 * 时间戳统一使用 INTEGER 毫秒（Date.now()），与 V1 TEXT ISO 格式并存。
 */

// ──────────────── §4.1 ProjectModeTransition 状态机 ────────────────

/** §4.1 execution_mode */
export type V2ExecutionMode = 'full' | 'read-only-acceptance';

/** §4.1 mode_transition 方向 */
export type V2ModeTransitionDirection = 'draining-to-read-only' | 'validating-to-full';

/** §4.1 mode_transition_step（双向统一枚举） */
export type V2ModeTransitionStep =
  | 'pause'
  | 'fence-attempts'
  | 'invalidate-lineage'
  | 'block-dependents'
  | 'validate-capability'
  | 'reconcile'
  | 'refresh-bindings'
  | 'revalidate-plans'
  | 'commit-mode';

/** full → read-only 合法 step 子集 */
export const DRAINING_STEPS: readonly V2ModeTransitionStep[] = [
  'pause', 'fence-attempts', 'invalidate-lineage', 'block-dependents', 'reconcile', 'commit-mode',
] as const;

/** read-only → full 合法 step 子集 */
export const VALIDATING_STEPS: readonly V2ModeTransitionStep[] = [
  'pause', 'validate-capability', 'reconcile', 'refresh-bindings', 'revalidate-plans', 'commit-mode',
] as const;

/** §4.1 project_mode_transitions.status */
export type V2TransitionStatus = 'running' | 'failed' | 'completed';

/**
 * 双向 mode transition 总 deadline（毫秒）= 24 小时。
 *
 * 出处：docs/distributed-multi-node-development-plan.md §12.1.1 结尾原文
 * 「双向 mode transition 的总 deadline 默认均为 24 小时」（§12.1.2 恢复同样
 * 「24 小时 deadline 超时仍保持 paused …并开 Incident」）；审计 22.3-20 指出
 * 实现曾误用 30 分钟，与矩阵不符——本常量是矩阵要求的最终权威值。
 */
export const MODE_TRANSITION_DEADLINE_MS = 24 * 60 * 60 * 1000;

/** §4.4.1 orphan_recovery_candidates.recovery_path */
export type V2RecoveryPath = 'node-driven' | 'control-plane-takeover';

/** §4.4.1 orphan_recovery_candidates.status */
export type V2OrphanCandidateStatus = 'pending' | 'decided' | 'executing' | 'resolved' | 'isolated';

/** §4.4.1 orphan_recovery_candidates.decision */
export type V2OrphanDecision = 'pending' | 'upload-and-reverify' | 'retain-evidence-only' | 'discard-after-audit';

/** §4.4.1 orphan_recovery_candidates.takeover_reason */
export type V2TakeoverReason = 'node-offline-timeout' | 'node-revoked' | 'operator-request';

/** §4.4.1 orphan_recovery_candidates.node_ack_status */
export type V2NodeAckStatus = 'not-required' | 'pending' | 'acked';

/**
 * §4.4.2 recovery_isolations.object_type。
 * 'mode-transition'（013 迁移扩展）：24h deadline 超期的 transition 自身作为
 * 隔离对象留证（22.4-05：durable RecoveryIsolation，重启后仍从正常 reconcile 排除）。
 */
export type V2IsolationObjectType =
  | 'remote-ref' | 'recovery-candidate' | 'artifact-manifest' | 'ownership-snapshot'
  | 'mode-transition';

/** §4.4.2 recovery_isolations.status */
export type V2IsolationStatus = 'isolated' | 'under-review' | 'resolved';

/** §4.4.2 branch_cleanups.status */
export type V2BranchCleanupStatus = 'pending' | 'deferred' | 'deleted' | 'failed';

/** §4.4.2 branch_cleanups.reason */
export type V2BranchCleanupReason =
  | 'rejected' | 'superseded' | 'conflict' | 'integration_failed' | 'invalidated' | 'mode_transition';

/** §4.7 external_merge_intents.status */
export type V2ExternalMergeIntentStatus = 'declared' | 'reconciling' | 'verified' | 'failed';

/** §14.5 outbox_events.status */
export type V2OutboxStatus = 'pending' | 'delivered' | 'dead_letter';

/** restore_points.status */
export type V2RestorePointStatus = 'created' | 'completed' | 'failed';

/** backup_runs.status */
export type V2BackupRunStatus = 'running' | 'completed' | 'failed';

// ──────────────── §20.1 行类型 ────────────────

/** §20.1 audit_events — 审计事件（append-only） */
export interface AuditEventRow {
  audit_id: string;
  project_id: string | null;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  correlation_id: string;
  evidence_digest: string;
  created_at: number; // 毫秒
}

/** §20.1 outbox_events — 事件外发箱（append-only，status 可更新） */
export interface OutboxEventRow {
  event_id: string;
  project_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  payload_digest: string;
  status: V2OutboxStatus;
  attempt_count: number;
  next_attempt_at: number; // 毫秒
  last_error: string;
  dead_lettered_at: number | null; // 毫秒
  compensates_event_id: string;
}

/** §20.1 idempotency_records — 请求幂等记录 */
export interface IdempotencyRecordRow {
  actor_id: string;
  route: string;
  idempotency_key: string;
  request_digest: string;
  response_entity_type: string;
  response_entity_id: string;
  response_revision: number;
  expires_at: number; // 毫秒
}

/** §9（P12）webhook_registrations.status */
export type V2WebhookStatus = 'active' | 'failed' | 'disabled';

/** §9（P12）webhook_deliveries.status */
export type V2WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

/** §9（P12）webhook_registrations — PM 事件推送到外部系统的注册 */
export interface WebhookRegistrationRow {
  webhook_id: string;
  url: string;
  /** HMAC-SHA256 签名密钥（注册时明文落库，投递签名与验签共用）。 */
  secret: string;
  /** 订阅事件类型 JSON 数组（task_done / review_requested / conflict_detected / incident_opened）。 */
  events: string;
  status: V2WebhookStatus;
  failure_count: number;
  last_delivered_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** §9（P12）webhook_deliveries — 单次投递尝试的持久化记录 */
export interface WebhookDeliveryRow {
  delivery_id: string;
  webhook_id: string;
  event_type: string;
  event_id: string;
  payload: string;
  signature: string;
  attempt_count: number;
  status: V2WebhookDeliveryStatus;
  last_error: string;
  next_attempt_at: number;
  created_at: number;
  delivered_at: number | null;
  response_status: number | null;
}

/** §20.1 restore_points — 恢复点 */
export interface RestorePointRow {
  restore_point_id: string;
  db_revision: number;
  git_refs_digest: string;
  artifact_manifest_digest: string;
  audit_high_water: number;
  outbox_high_water: number;
  status: V2RestorePointStatus;
  created_at: number; // 毫秒
}

/** §20.1 backup_runs — 备份运行记录 */
export interface BackupRunRow {
  backup_run_id: string;
  restore_point_id: string;
  component: string;
  manifest_digest: string;
  status: V2BackupRunStatus;
  started_at: number; // 毫秒
  completed_at: number | null; // 毫秒
  error: string;
}

/** §20.1 project_mode_transitions — 模式切换步骤记录 */
export interface ProjectModeTransitionRow {
  transition_id: string;
  project_id: string | null;
  from_mode: V2ExecutionMode;
  to_mode: V2ExecutionMode;
  step: V2ModeTransitionStep;
  status: V2TransitionStatus;
  idempotency_key: string;
  deadline_at: number; // 毫秒
  last_error: string;
  started_at: number; // 毫秒
  completed_at: number | null; // 毫秒
  /** 24h deadline 超期标记（013 列）：非空时 API 面投影 status='expired'，
   * 同时落 RecoveryIsolation（object_type='mode-transition'）留证。 */
  expired_at?: number | null; // 毫秒
}

/** §20.1 orphan_recovery_candidates — 孤儿恢复候选 */
export interface OrphanRecoveryCandidateRow {
  candidate_id: string;
  attempt_id: string;
  project_id: string | null;
  marker_ref: string;
  branch_ref: string;
  head_sha: string;
  bundle_manifest_digest: string;
  recovery_path: V2RecoveryPath;
  status: V2OrphanCandidateStatus;
  decision: V2OrphanDecision;
  takeover_reason: string;
  takeover_at: number | null; // 毫秒
  node_ack_status: V2NodeAckStatus;
  revision: number;
  decided_by: string;
  decided_at: number | null; // 毫秒
  resolved_at: number | null; // 毫秒
  resolution_evidence_digest: string;
  /** 最近一次签名决策信封 JSON 留档（013 列；§4.4.2 audit 保留与重验用）。 */
  decision_envelope?: string;
  /** 决策一次性消费标记（013 列；§4.4.1 防重放：非空即拒绝再次消费）。 */
  decision_consumed_at?: number | null; // 毫秒
}

/** §20.1 recovery_isolations — 隔离记录 */
export interface RecoveryIsolationRow {
  isolation_id: string;
  project_id: string | null;
  transition_id: string;
  object_type: V2IsolationObjectType;
  object_id: string;
  evidence_digest: string;
  reason: string;
  status: V2IsolationStatus;
  isolated_by: string;
  isolated_at: number; // 毫秒
  retention_until: number; // 毫秒
  reviewed_by: string;
  reviewed_at: number | null; // 毫秒
  review_evidence_digest: string;
  resolved_by: string;
  resolved_at: number | null; // 毫秒
  resolution_evidence: string;
}

/** §20.1 branch_cleanups — 分支清理记录 */
export interface BranchCleanupRow {
  cleanup_id: string;
  project_id: string | null;
  delivery_id: string;
  branch_ref: string;
  expected_head_sha: string;
  reason: V2BranchCleanupReason;
  status: V2BranchCleanupStatus;
  eligible_at: number; // 毫秒
  retention_until: number; // 毫秒
  last_error: string;
  completed_at: number | null; // 毫秒
}

/** §20.1 external_merge_intents — 外部合并意图 */
export interface ExternalMergeIntentRow {
  intent_id: string;
  project_id: string | null;
  delivery_id: string;
  expected_target_sha: string;
  provider_actor: string;
  approved_by: string;
  reason: string;
  status: V2ExternalMergeIntentStatus;
  final_sha: string;
  created_at: number; // 毫秒
  resolved_at: number | null; // 毫秒
}

/* ──────────────── §13.2/§21 Phase 6：凭据紧急撤销 durable 支撑（009 迁移） ──────────────── */

/** revoke-all-sessions 落库的轮换密钥（版本必须大于 env 密钥环最高版本） */
export interface V2CredentialKeyRecordRow {
  key_version: number;
  material_hex: string;
  created_at: number; // 毫秒
  created_by: string;
  reason: string;
}

/** 单行水位：低于 min_key_version 的全部 bvn2/bva2/bvh2 立即失效 */
export interface V2CredentialStateRow {
  id: number;
  min_key_version: number;
  updated_at: number; // 毫秒
}

// ──────────────── §4.8 / Phase 7a Incident ────────────────

/** incidents.status */
export type V2IncidentStatus = 'open' | 'acked' | 'resolved';

/** incidents.severity */
export type V2IncidentSeverity = 'info' | 'warning' | 'critical';

/** incidents 行类型 */
export interface IncidentRow {
  incident_id: string;
  project_id: string | null;
  kind: string;
  severity: V2IncidentSeverity;
  status: V2IncidentStatus;
  title: string;
  detail: string;
  correlation_id: string;
  related_entity_type: string;
  related_entity_id: string;
  opened_at: number;
  ack_due_at: number | null;
  acked_at: number | null;
  acked_by: string;
  ack_note: string;
  resolved_at: number | null;
  resolved_by: string;
  resolution_evidence: string;
  revision: number;
  created_at: number;
  updated_at: number;
  /** §22.4-36 resolution SLO（分钟，按 severity 写入；告警调度据此判定超时升级）。 */
  resolution_sla_minutes?: number | null;
  /** §22.4-36 复发计数：同 fingerprint resolve 后复发窗口内重开时递增（字段留档）。 */
  recurrence?: number;
  /** §22.4-36 超 SLO 升级标记（0=未升级，1=已升级一次）。 */
  escalated?: number;
}
