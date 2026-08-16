/**
 * V2 Git Workspace 领域类型（Phase 4）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §4.5（Delivery 状态机）、
 * §6.2（clone-per-attempt 目录）、§6.3（分支命名）、§6.4（Workspace Prepare）、
 * §6.5（Workspace Finalize）、§6.6（worktree/clone 约束）、§7.3（Git Diff 二次门禁）、
 * §4.4.2（BranchCleanup）。
 *
 * 时间戳统一 INTEGER 毫秒（与 v2-artifact.ts 一致）。
 */

// ──────────────── §6.4 Prepare 状态机 ────────────────

/**
 * Prepare 状态机：pending → cloning → checking_base → creating_branch → ready。
 * `failed:*` 为终态（remote_fingerprint_mismatch / base_unreachable /
 * disk_watermark / marker_write_failed / clone_failed / attempt_invalid …），
 * 失败后重入不再推进（需人工或新 generation attempt）。
 */
export type WorkspacePrepareState =
  | 'pending'
  | 'cloning'
  | 'checking_base'
  | 'creating_branch'
  | 'ready'
  | `failed:${string}`;

/**
 * Prepare 阶段确定性校验失败的稳定错误码（failed:<code>，终态）。
 * 可重试的瞬时失败（网络断、clone 中断、超时）不落终态，留在当前状态重入。
 */
export const WORKSPACE_PREPARE_FAILURES = [
  'remote_fingerprint_mismatch',
  'base_unreachable',
  'disk_watermark',
  'marker_write_failed',
  'attempt_invalid',
] as const;

// ──────────────── §6.5 Finalize 状态机 ────────────────

/**
 * Finalize 状态机（与 Prepare 独立）：idle → committing → pushing → delivering →
 * delivered。pending_recovery 表示 push 已成功但 Artifact/证据链未闭合；
 * `failed:*` 终态（ownership_violation / cas_conflict / push_failed /
 * marker_invalid / server_verify_failed …）。
 */
export type WorkspaceFinalizeState =
  | 'idle'
  | 'committing'
  | 'pushing'
  | 'delivering'
  | 'delivered'
  | 'pending_recovery'
  | `failed:${string}`;

// ──────────────── §4.5 Delivery 状态机（Phase 4 语义） ────────────────

/**
 * Phase 4 Delivery 状态机：pending_review → reviewing → accepted|rejected|invalidated。
 * pending_recovery：finalize 已 push 但 Artifact 上传中断（§21 Artifact 中断场景）。
 * 其余值继承 005 迁移 §4.5 全集（proposed 为 Phase 2 report 雏形状态，保留兼容）。
 */
export type DeliveryLifecycleStatus =
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

/** §4.5 invalidated_reason（Phase 4 追加后三项）。 */
export type DeliveryInvalidatedReason =
  | 'branch-head-changed'
  | 'verify-manifest-changed'
  | 'artifact-manifest-changed'
  | 'remote-ref-acl-lost'
  | 'remote-ref-exists'
  | 'merge-base-unreachable'
  | 'marker-invalid';

// ──────────────── diff 摘要（§7.3 / PM Review V2） ────────────────

/** 单文件 ± 统计（不含正文）。binary 行无行数统计。 */
export interface DeliveryDiffEntry {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** 服务端独立 diff 复核结果（不信任 Node 上报）。 */
export interface DeliveryDiffSummary {
  files: DeliveryDiffEntry[];
  /** 越界（ownership 外）文件相对 write_globs 的比对结果。 */
  ownership_violations: string[];
  /** 服务端是否已完成独立复核。 */
  server_verified: boolean;
  verified_at: number;
}

// ──────────────── attempt_workspaces 表行（007） ────────────────

export interface AttemptWorkspaceRow {
  attempt_id: string;
  project_id: string;
  task_id: string;
  node_id: string;
  /** clone-per-attempt 工作目录：<node_cache>/<project>/<attempt-id>（§6.2/§6.6）。 */
  workspace_dir: string;
  /** 完整 ref 落库（§6.3：不能靠重新拼接猜测），如 refs/heads/biao/attempt/att-x。 */
  branch_ref: string;
  /** refs/biao/attempt-markers/<attempt-id>。 */
  marker_ref: string;
  remote_url: string;
  /** 注册时记录的 remote fingerprint（v1:<anchor_sha>:<digest>）。 */
  remote_fingerprint: string;
  base_sha: string;
  prepare_state: WorkspacePrepareState;
  prepare_error: string;
  finalize_state: WorkspaceFinalizeState;
  finalize_error: string;
  head_sha: string;
  marker_sha: string;
  /** bva2 Attempt token 摘要（R1C-005 marker 内容项）。 */
  bva2_digest: string;
  delivery_id: string;
  created_at: number;
  updated_at: number;
}

// ──────────────── 常量（§6.3/§6.6/R1C-007/§6.5） ────────────────

/** §6.3 分支命名前缀（Phase 4 简化形：biao/attempt/<attempt-id>）。 */
export const ATTEMPT_BRANCH_PREFIX = 'biao/attempt/';

/** §6.5 marker ref 前缀。 */
export const ATTEMPT_MARKER_REF_PREFIX = 'refs/biao/attempt-markers/';

/** §6.5 owner-only marker 文件名。 */
export const ATTEMPT_MARKER_FILENAME = '.biao-attempt.json';

/** R1C-007 磁盘水位：使用率 ≥ 该值时拒绝新 prepare（默认 85%）。 */
export const DISK_WATERMARK_REJECT_PERCENT = 85;

/** §6.6/§4.4.2 分支清理默认保留期（30 天）。 */
export const BRANCH_CLEANUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** §6.5 marker schema 版本。 */
export const ATTEMPT_MARKER_SCHEMA_VERSION = 1;

/**
 * §6.5 signed marker canonical JSON 字段（R1C-005）。
 * Phase 4 以控制面 credential keyring 的 HMAC 作为 Node signing key 的进程内
 * 替身；daemon 接线（收尾项）换成 Node enrollment 本地密钥。
 */
export interface AttemptMarkerPayload {
  schema_version: typeof ATTEMPT_MARKER_SCHEMA_VERSION;
  attempt_id: string;
  task_id: string;
  attempt_generation: number;
  node_id: string;
  signing_key_generation: number;
  branch_ref: string;
  base_sha: string;
  /** finalize 阶段补充；prepare 阶段为空串。 */
  head_sha: string;
  bva2_digest: string;
  created_at: number;
}

/** marker 签名信封：canonical JSON + HMAC-SHA256。 */
export interface SignedAttemptMarker {
  payload: AttemptMarkerPayload;
  /** hex 签名（对 canonical JSON 计算）。 */
  signature: string;
}
