/**
 * Phase 2+3 集成：task_attempts 与 ownership_snapshots 表。
 * 对应 docs/distributed-multi-node-development-plan.md §20.1。
 *
 * task_attempts：attempt 生命周期管理（claim → executing → done/failed），
 *   attempt_generation fencing、lease TTL、bva2 token 绑定。
 * ownership_snapshots：attempt 执行期间的文件 ownership 快照。
 */
import type Database from 'better-sqlite3';

export const version = '006';

const schemaSql = `
-- ──────────────── §20.1 task_attempts（attempt 生命周期） ────────────────
CREATE TABLE IF NOT EXISTS task_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  attempt_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claiming', 'executing', 'done', 'failed',
      'lease_lost', 'cancelled', 'fenced', 'pending_recovery')),
  lease_expires_at INTEGER NOT NULL,
  lease_duration_ms INTEGER NOT NULL DEFAULT 600000,
  token_jti TEXT NOT NULL DEFAULT '',
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_reason TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_task
  ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_node
  ON task_attempts(node_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_status
  ON task_attempts(status);
CREATE INDEX IF NOT EXISTS idx_task_attempts_lease
  ON task_attempts(lease_expires_at);

-- ──────────────── §20.1 ownership_snapshots（文件占用快照） ────────────────
CREATE TABLE IF NOT EXISTS ownership_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ownership_snapshots_attempt
  ON ownership_snapshots(attempt_id);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
