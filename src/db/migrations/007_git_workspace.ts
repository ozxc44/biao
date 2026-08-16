/**
 * Phase 4：Git Workspace 与 Delivery 状态机数据层。
 *
 * 对应 docs/distributed-multi-node-development-plan.md §6.2/§6.4/§6.5/§4.5/§7.3。
 *
 * - attempt_workspaces：Prepare/Finalize 两条独立状态机的 durable 状态
 *   （每步先落库再执行，中断后按状态幂等重入）。
 * - deliveries 重建：status 追加 Phase 4 状态机值（pending_review/reviewing/
 *   pending_recovery），新增服务端独立 diff 复核结果列（diff_summary /
 *   server_verified，§7.3 二次门禁不信任 Node 上报）。
 *   旧值 proposed 等全部保留（Phase 2 report 雏形兼容）。
 * - branch_cleanups 复用 003（§4.4.2 已有最小 schema），本迁移不加表。
 */
import type Database from 'better-sqlite3';

export const version = '007';

const schemaSql = `
-- ──────────────── §6.4/§6.5 attempt_workspaces（Prepare/Finalize 状态机） ────────────────
CREATE TABLE IF NOT EXISTS attempt_workspaces (
  attempt_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  workspace_dir TEXT NOT NULL DEFAULT '',
  branch_ref TEXT NOT NULL DEFAULT '',
  marker_ref TEXT NOT NULL DEFAULT '',
  remote_url TEXT NOT NULL DEFAULT '',
  remote_fingerprint TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  prepare_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (prepare_state IN ('pending', 'cloning', 'checking_base', 'creating_branch', 'ready')
      OR prepare_state LIKE 'failed:%'),
  prepare_error TEXT NOT NULL DEFAULT '',
  finalize_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (finalize_state IN ('idle', 'committing', 'pushing', 'delivering', 'delivered', 'pending_recovery')
      OR finalize_state LIKE 'failed:%'),
  finalize_error TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  marker_sha TEXT NOT NULL DEFAULT '',
  bva2_digest TEXT NOT NULL DEFAULT '',
  delivery_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempt_workspaces_project
  ON attempt_workspaces(project_id);
CREATE INDEX IF NOT EXISTS idx_attempt_workspaces_prepare_state
  ON attempt_workspaces(prepare_state);
CREATE INDEX IF NOT EXISTS idx_attempt_workspaces_finalize_state
  ON attempt_workspaces(finalize_state);

-- ──────────────── §4.5/§7.3 deliveries 重建（扩展状态机 + 服务端复核列） ────────────────
CREATE TABLE IF NOT EXISTS deliveries_p4 (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  tree_sha TEXT NOT NULL DEFAULT '',
  branch_ref TEXT NOT NULL DEFAULT '',
  changed_files TEXT NOT NULL DEFAULT '[]',
  patch_digest TEXT NOT NULL DEFAULT '',
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  verify_manifest_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'pending_review', 'reviewing', 'pending_recovery',
      'accepted', 'rejected', 'merging', 'merged', 'conflict', 'integration_failed',
      'superseded', 'invalidated')),
  accepted_commit_sha TEXT NOT NULL DEFAULT '',
  merged_commit_sha TEXT NOT NULL DEFAULT '',
  invalidated_reason TEXT NOT NULL DEFAULT '',
  diff_summary TEXT NOT NULL DEFAULT '[]',
  server_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const rebuildSql = `
INSERT INTO deliveries_p4 (
  delivery_id, task_id, attempt_id, project_id, base_sha, head_sha, tree_sha,
  branch_ref, changed_files, patch_digest, artifact_ids, verify_manifest_digest,
  status, accepted_commit_sha, merged_commit_sha, invalidated_reason,
  diff_summary, server_verified, created_at, updated_at
)
SELECT
  delivery_id, task_id, attempt_id, project_id, base_sha, head_sha, tree_sha,
  branch_ref, changed_files, patch_digest, artifact_ids, verify_manifest_digest,
  status, accepted_commit_sha, merged_commit_sha, invalidated_reason,
  '[]', 0, created_at, updated_at
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_p4 RENAME TO deliveries;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_attempt_head
  ON deliveries(attempt_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_deliveries_task
  ON deliveries(task_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_project
  ON deliveries(project_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON deliveries(status);
`;

export const checksumMaterial = schemaSql + rebuildSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
  // 重建幂等只对全新库执行一次：迁移按版本单次运行，deliveries 必然来自 005。
  db.exec(rebuildSql);
}
