/**
 * V2 Merge Queue 领域类型（Phase 5）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §4.7（MergeJob 模型）、
 * §12（Merge Queue 全节）、§5.2（Delivery 与 Merge 分离）、§15.5（API）。
 *
 * ExternalMergeIntentRow 已在 v2-infra.ts 定义，此处不重复。
 * 时间戳统一 INTEGER 毫秒。
 */

// ──────────────── §4.7 MergeJob ────────────────

/** §4.7 MergeJob status（§12.2 合并顺序 + §12.3 冲突策略）。 */
export type MergeJobStatus =
  | 'queued'
  | 'running'
  | 'merged'
  | 'conflict'
  | 'integration_failed'
  | 'cancelled'
  | 'invalidated';

/** §4.7 cancel_reason（CAS 失败 / 远端 ACL 丢失 / 人工取消）。 */
export type MergeJobCancelReason =
  | 'target-advanced'
  | 'remote-ref-acl-lost'
  | 'operator-cancelled';

/** §4.7 merge_jobs 表行。 */
export interface MergeJobRow {
  merge_job_id: string;
  delivery_id: string;
  project_id: string;
  /** 入队时记录的默认分支 HEAD（CAS 用）。 */
  expected_target_sha: string;
  /** delivery 的 head_sha（合并源）。 */
  source_sha: string;
  /** §12.2 合并策略。 */
  strategy: 'merge-ff' | 'cherry-pick' | 'provider-pr';
  status: MergeJobStatus;
  /** 合并成功后的最终 SHA。 */
  final_sha: string;
  cancel_reason: string;
  /** 冲突文件清单 JSON（审计用，§12.3）。 */
  conflict_files: string;
  /** integration_failed 时的错误详情。 */
  error_message: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

// ──────────────── 降级参数（§12.1.1） ────────────────

/** §12.1.1 连续失败降级阈值（默认 3 次）。 */
export const MERGE_DEGRADE_FAILURE_THRESHOLD = 3;

/** §12.1 write_capability_status 降级值。 */
export const MERGE_DEGRADED_WRITE_STATUS = 'degraded_read_only';
