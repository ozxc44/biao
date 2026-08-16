/**
 * V2 Artifact 领域类型（Phase 2）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §4.5/§4.6/§9/§15.4。
 * 时间戳统一 INTEGER 毫秒。
 */

// ──────────────── §4.6 Artifact ────────────────

/** §9.3 结果文件上限 */
export const ARTIFACT_RESULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
/** §9.3 Agent/Verify log 上限 */
export const ARTIFACT_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB
/** §9.3 单文件总上限 */
export const ARTIFACT_TOTAL_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

/** §4.6 kind 枚举 */
export type ArtifactKind =
  | 'result-md'
  | 'result-json'
  | 'verify-log'
  | 'agent-log'
  | 'patch'
  | 'recovery-bundle';

/** §9.2 上传状态 */
export type ArtifactUploadStatus = 'uploading' | 'complete' | 'rejected';

/** §4.6 artifacts 表行 */
export interface ArtifactRow {
  artifact_id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  kind: ArtifactKind | string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  storage_key: string;
  status: ArtifactUploadStatus;
  created_at: number;
  retention_until: number | null;
}

/** §9.4 artifact_blobs 表行（内容寻址去重层） */
export interface ArtifactBlobRow {
  sha256: string;
  size_bytes: number;
  ref_count: number;
  first_seen_at: number;
  gc_marked_at: number | null;
}

/** §9.2 上传会话（临时键） */
export interface ArtifactUploadSessionRow {
  upload_id: string;
  artifact_id: string;
  attempt_id: string;
  task_id: string;
  project_id: string;
  kind: string;
  sha256: string;
  size_bytes: number;
  received_bytes: number;
  chunk_sha256s: string;
  status: 'pending' | 'completed' | 'expired';
  created_at: number;
  expires_at: number;
}

// ──────────────── §4.5 Delivery ────────────────

/**
 * §4.5 delivery status。
 * Phase 4（007）追加 pending_review/reviewing/pending_recovery：
 * pending_review → reviewing → accepted|rejected|invalidated；
 * pending_recovery = finalize 已 push 但 Artifact 上传中断。
 * proposed 为 Phase 2 report 雏形状态，保留兼容。
 */
export type DeliveryStatus =
  | 'proposed'
  | 'pending_review'
  | 'reviewing'
  | 'pending_recovery'
  | 'accepted'
  | 'rejected'
  | 'merging'
  | 'merged'
  | 'conflict'
  | 'integration_failed'
  | 'superseded'
  | 'invalidated';

/** §4.5 deliveries 表行（最小字段） */
export interface DeliveryRow {
  delivery_id: string;
  task_id: string;
  attempt_id: string;
  project_id: string;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  branch_ref: string;
  changed_files: string;
  patch_digest: string;
  artifact_ids: string;
  verify_manifest_digest: string;
  status: DeliveryStatus;
  accepted_commit_sha: string;
  merged_commit_sha: string;
  invalidated_reason: string;
  /** §7.3 服务端独立 diff 复核摘要 JSON（DeliveryDiffSummary；007 列，旧路径可缺省）。 */
  diff_summary?: string;
  /** §7.3 服务端复核完成标记（007 列；0=未复核）。 */
  server_verified?: number;
  created_at: number;
  updated_at: number;
}

// ──────────────── §20.1 TaskAttempt ────────────────

/** §20.1 task_attempts.status */
export type TaskAttemptStatus =
  | 'pending'
  | 'claiming'
  | 'executing'
  | 'done'
  | 'failed'
  | 'lease_lost'
  | 'cancelled'
  | 'fenced'
  | 'pending_recovery';

/** §20.1 task_attempts 表行 */
export interface TaskAttemptRow {
  attempt_id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  session_id: string;
  attempt_generation: number;
  status: TaskAttemptStatus;
  lease_expires_at: number;
  lease_duration_ms: number;
  token_jti: string;
  artifact_ids: string;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
  failure_reason: string;
}

// ──────────────── §20.1 OwnershipSnapshot ────────────────

/** §20.1 ownership_snapshots 表行 */
export interface OwnershipSnapshotRow {
  snapshot_id: string;
  attempt_id: string;
  task_id: string;
  files: string;
  created_at: number;
  released_at: number | null;
}

// ──────────────── 请求/响应 DTO ────────────────

/** initiate 请求 */
export interface ArtifactInitiateRequest {
  attempt_id: string;
  kind: string;
  size_bytes: number;
  sha256: string;
}

/** initiate 响应 */
export interface ArtifactInitiateResponse {
  artifact_id: string;
  upload_id: string;
}

/** complete 响应 */
export interface ArtifactCompleteResponse {
  artifact_id: string;
  sha256: string;
  size_bytes: number;
  status: ArtifactUploadStatus;
}

/** Artifact 读取元数据响应 */
export interface ArtifactMetaResponse {
  artifact_id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  kind: string;
  sha256: string;
  size_bytes: number;
  status: ArtifactUploadStatus;
  created_at: number;
}
