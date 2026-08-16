/**
 * Phase 2：Artifact Store 数据层。
 * 对应 docs/distributed-multi-node-development-plan.md §4.5/§4.6/§9/§20.1。
 *
 * 三张表：artifacts、artifact_blobs、deliveries。
 * artifacts 与 artifact_blobs 分离：artifacts 记录归属（project/task/attempt），
 * artifact_blobs 记录内容寻址去重（sha256 + ref_count）。
 * deliveries 记录交付元数据（§4.5 最小字段）。
 */
import type Database from 'better-sqlite3';

export const version = '005';

const schemaSql = `
-- ──────────────── §9.1 artifact_blobs（内容寻址去重层） ────────────────
CREATE TABLE IF NOT EXISTS artifact_blobs (
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  gc_marked_at INTEGER,
  PRIMARY KEY (sha256, size_bytes)
);

-- ──────────────── §4.6 artifacts（归属层） ────────────────
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'complete', 'rejected')),
  created_at INTEGER NOT NULL,
  retention_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_artifacts_sha256
  ON artifacts(sha256);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt
  ON artifacts(attempt_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task
  ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_project
  ON artifacts(project_id);

-- ──────────────── §9.2 upload_sessions（分片上传临时会话） ────────────────
CREATE TABLE IF NOT EXISTS artifact_upload_sessions (
  upload_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  chunk_sha256s TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_artifact
  ON artifact_upload_sessions(artifact_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status
  ON artifact_upload_sessions(status, expires_at);

-- ──────────────── §4.5 deliveries（交付记录，最小字段） ────────────────
CREATE TABLE IF NOT EXISTS deliveries (
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
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'merging',
      'merged', 'conflict', 'integration_failed', 'superseded', 'invalidated')),
  accepted_commit_sha TEXT NOT NULL DEFAULT '',
  merged_commit_sha TEXT NOT NULL DEFAULT '',
  invalidated_reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_attempt_head
  ON deliveries(attempt_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_deliveries_task
  ON deliveries(task_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_project
  ON deliveries(project_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON deliveries(status);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
