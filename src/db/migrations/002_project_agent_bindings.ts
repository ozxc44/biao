import type Database from 'better-sqlite3';

export const version = '002';

const schemaSql = `
CREATE TABLE IF NOT EXISTS project_agent_bindings (
  binding_id TEXT PRIMARY KEY,
  project_scope TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  harness_kind TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  wake_mode TEXT NOT NULL CHECK (wake_mode IN ('visible_session', 'background_executor', 'external_worker')),
  policy TEXT NOT NULL CHECK (policy IN ('manual', 'on_demand', 'automatic')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_scope, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_project_agent_bindings_scope
  ON project_agent_bindings(project_scope, binding_id);

CREATE TABLE IF NOT EXISTS execution_receipts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_scope TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  harness_kind TEXT NOT NULL,
  wake_mode TEXT NOT NULL CHECK (wake_mode IN ('visible_session', 'background_executor', 'external_worker')),
  adapter_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'succeeded', 'failed')),
  started_at INTEGER NOT NULL,
  session_ref TEXT,
  visible_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_receipts_project_started
  ON execution_receipts(project_scope, started_at, attempt_id);
CREATE INDEX IF NOT EXISTS idx_execution_receipts_binding_started
  ON execution_receipts(binding_id, started_at, attempt_id);
CREATE INDEX IF NOT EXISTS idx_execution_receipts_task_started
  ON execution_receipts(task_id, started_at, attempt_id);

CREATE TRIGGER IF NOT EXISTS execution_receipts_append_only_update
BEFORE UPDATE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_receipts are append-only');
END;

CREATE TRIGGER IF NOT EXISTS execution_receipts_append_only_delete
BEFORE DELETE ON execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_receipts are append-only');
END;
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
