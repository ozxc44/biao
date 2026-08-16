/**
 * Migration 013：模式切换超期与恢复决策 durable 补列（22.3-20/22.4-26/27/29）
 *
 * - project_mode_transitions.expired_at：24h deadline 超期的 durable 标记
 *   （§12.1.1 双向 deadline 默认 24 小时；DB status 枚举保持
 *   running/failed/completed，expired_at 非空在 API 面投影为 status='expired'）。
 * - orphan_recovery_candidates.decision_envelope / decision_consumed_at：
 *   签名决策信封留档与一次性消费标记（§4.4.1 15 分钟 TTL、防重放）。
 * - recovery_isolations 表重建：object_type CHECK 追加 'mode-transition'
 *   （22.4-05 超期隔离留证：transition 自身作为隔离对象入库，重启后仍从
 *   正常 reconcile 排除，关闭需三步分权独立复核）。
 */

import type Database from 'better-sqlite3';

export const version = '013';

/** 与 up 内 DDL 一一对应的校验材料（schema_migrations checksum）。 */
export const checksumMaterial = 'mode_transition_expired_at + recovery_decision_envelope + isolation mode-transition 20260816';

export function up(db: Database.Database): void {
  // project_mode_transitions 超期标记列
  try {
    db.exec(`ALTER TABLE project_mode_transitions ADD COLUMN expired_at INTEGER`);
  } catch { /* 列已存在 */ }

  // orphan_recovery_candidates 决策信封与消费标记列
  try {
    db.exec(`ALTER TABLE orphan_recovery_candidates ADD COLUMN decision_envelope TEXT NOT NULL DEFAULT ''`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE orphan_recovery_candidates ADD COLUMN decision_consumed_at INTEGER`);
  } catch { /* 列已存在 */ }

  // recovery_isolations 重建：扩展 object_type CHECK 后原样搬运行数据与索引。
  // SQLite 不能就地修改 CHECK 约束；新表按 003 的 DDL 加 'mode-transition' 枚举，
  // 复制后删旧表、改名、重建两个索引（索引随表删除，必须重建）。
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recovery_isolations'",
  ).get();
  if (hasTable) {
    db.exec(`
      CREATE TABLE recovery_isolations_rebuild (
        isolation_id TEXT PRIMARY KEY,
        project_id TEXT,
        transition_id TEXT NOT NULL DEFAULT '',
        object_type TEXT NOT NULL
          CHECK (object_type IN ('remote-ref', 'recovery-candidate', 'artifact-manifest', 'ownership-snapshot', 'mode-transition')),
        object_id TEXT NOT NULL,
        evidence_digest TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'isolated'
          CHECK (status IN ('isolated', 'under-review', 'resolved')),
        isolated_by TEXT NOT NULL,
        isolated_at INTEGER NOT NULL,
        retention_until INTEGER NOT NULL,
        reviewed_by TEXT NOT NULL DEFAULT '',
        reviewed_at INTEGER,
        review_evidence_digest TEXT NOT NULL DEFAULT '',
        resolved_by TEXT NOT NULL DEFAULT '',
        resolved_at INTEGER,
        resolution_evidence TEXT NOT NULL DEFAULT ''
      );

      INSERT INTO recovery_isolations_rebuild
        (isolation_id, project_id, transition_id, object_type, object_id, evidence_digest,
         reason, status, isolated_by, isolated_at, retention_until, reviewed_by, reviewed_at,
         review_evidence_digest, resolved_by, resolved_at, resolution_evidence)
      SELECT
        isolation_id, project_id, transition_id, object_type, object_id, evidence_digest,
        reason, status, isolated_by, isolated_at, retention_until, reviewed_by, reviewed_at,
        review_evidence_digest, resolved_by, resolved_at, resolution_evidence
      FROM recovery_isolations;

      DROP TABLE recovery_isolations;
      ALTER TABLE recovery_isolations_rebuild RENAME TO recovery_isolations;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_isolations_one_unresolved
        ON recovery_isolations(object_type, object_id)
        WHERE status != 'resolved';
      CREATE INDEX IF NOT EXISTS idx_recovery_isolations_project_status
        ON recovery_isolations(project_id, status);
    `);
  }
}
