/**
 * Phase 7a：Incident 持久化表。
 *
 * incidents 表承载 open→acked→resolved 状态机 + SLA 字段（ack_due_at / resolved_at）。
 * 触发点：merge integration_failed、降级 read_only、revoke-all、quarantine。
 * 对应 §4.8（ReadOnlyAcceptance 与 Incident）、§21 Phase 7 原文。
 */
import type Database from 'better-sqlite3';

export const version = '010';

const schemaSql = `
-- incidents — 事故记录（open→acked→resolved 状态机 + SLA）
CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acked', 'resolved')),
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  related_entity_type TEXT NOT NULL DEFAULT '',
  related_entity_id TEXT NOT NULL DEFAULT '',
  opened_at INTEGER NOT NULL,
  ack_due_at INTEGER,
  acked_at INTEGER,
  acked_by TEXT NOT NULL DEFAULT '',
  ack_note TEXT NOT NULL DEFAULT '',
  resolved_at INTEGER,
  resolved_by TEXT NOT NULL DEFAULT '',
  resolution_evidence TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_status
  ON incidents(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_incidents_project_status
  ON incidents(project_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_correlation
  ON incidents(correlation_id);
CREATE INDEX IF NOT EXISTS idx_incidents_severity_open
  ON incidents(severity)
  WHERE status != 'resolved';
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
