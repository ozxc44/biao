/**
 * Migration 012：evidence_acceptances 表 + ref ACL 扩展列（22.3-13/15）
 *
 * - evidence_acceptances：Artifact-only 完成的证据验收记录（D-041）。
 * - projects.ref_acl_json：per-project ref ACL 配置 JSON。
 * - projects.ref_acl_miss_count：ref ACL 连续丢失计数（22.3-17 熔断用）。
 */

import type Database from 'better-sqlite3';

export const version = '012';

export const checksumMaterial = 'evidence_acceptances_ref_acl_20260816';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_acceptances (
      acceptance_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('node', 'node_harness', 'pm')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
      artifact_digests TEXT NOT NULL DEFAULT '[]',
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_acceptances_attempt
      ON evidence_acceptances(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_evidence_acceptances_project
      ON evidence_acceptances(project_id);
  `);

  // projects 表扩展列（ALTER TABLE 安全：IF NOT EXISTS 语义）
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN ref_acl_json TEXT NOT NULL DEFAULT ''`);
  } catch { /* 列已存在 */ }
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN ref_acl_miss_count INTEGER NOT NULL DEFAULT 0`);
  } catch { /* 列已存在 */ }
}
