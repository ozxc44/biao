/**
 * Phase 1：领域身份数据层。
 * 对应 docs/distributed-multi-node-development-plan.md §4.1/§4.2/§4.3/§20.1/§20.2/§20.3。
 *
 * 六张领域表：projects、nodes、node_sessions、node_project_bindings、agent_slots、legacy_project_bindings。
 * plans/tasks/agent_registrations 扩展列（§20.2，全部可空过渡）。
 * 约束：node+project 唯一、revision 单调（触发器保证）、legacy binding 显式。
 */
import type Database from 'better-sqlite3';

export const version = '004';

const schemaSql = `
-- ──────────────── §4.1 projects ────────────────
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  repository_url TEXT NOT NULL DEFAULT '',
  repository_fingerprint TEXT NOT NULL DEFAULT '',
  default_branch TEXT NOT NULL DEFAULT '',
  merge_policy TEXT NOT NULL DEFAULT 'merge-queue'
    CHECK (merge_policy IN ('merge-queue', 'provider-pr')),
  execution_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (execution_mode IN ('full', 'read-only-acceptance')),
  mode_transition TEXT
    CHECK (mode_transition IN ('draining-to-read-only', 'validating-to-full')),
  mode_transition_id TEXT NOT NULL DEFAULT '',
  mode_transition_step TEXT,
  write_capability_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (write_capability_status IN ('ready', 'suspect', 'lost', 'disabled')),
  artifact_policy_id TEXT NOT NULL DEFAULT '',
  workspace_policy_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ──────────────── §4.2 nodes ────────────────
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT ''
    CHECK (os IN ('darwin', 'linux', 'windows', '')),
  arch TEXT NOT NULL DEFAULT '',
  node_version TEXT NOT NULL DEFAULT '',
  protocol_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'enrolling'
    CHECK (status IN ('enrolling', 'online', 'degraded', 'draining', 'offline', 'quarantined')),
  capabilities TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '[]',
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 1,
  memory_mb INTEGER,
  disk_free_mb INTEGER,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  clock_skew_ms INTEGER,
  server_cert_not_after TEXT NOT NULL DEFAULT '',
  trust_anchor_generation INTEGER NOT NULL DEFAULT 0,
  signing_key_generation INTEGER NOT NULL DEFAULT 0,
  accepted_control_plane_signing_key_generations TEXT NOT NULL DEFAULT '[]',
  -- §4.2 终态 TTL 字段
  terminal_state_at INTEGER,
  terminal_state_reason TEXT NOT NULL DEFAULT '',
  ttl_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ──────────────── §4.2 node_sessions ────────────────
CREATE TABLE IF NOT EXISTS node_sessions (
  session_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  node_session_generation INTEGER NOT NULL,
  credential_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'fenced', 'expired')),
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  fenced_at INTEGER,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_node_sessions_node
  ON node_sessions(node_id, status);

-- ──────────────── §4.3 node_project_bindings ────────────────
CREATE TABLE IF NOT EXISTS node_project_bindings (
  binding_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  local_cache_root TEXT NOT NULL DEFAULT '',
  checkout_mode TEXT NOT NULL DEFAULT 'worktree'
    CHECK (checkout_mode IN ('worktree', 'clone-per-attempt')),
  repository_fingerprint TEXT NOT NULL DEFAULT '',
  last_fetch_sha TEXT NOT NULL DEFAULT '',
  health TEXT NOT NULL DEFAULT 'ready'
    CHECK (health IN ('ready', 'syncing', 'dirty', 'diverged', 'unavailable')),
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  authorization_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (authorization_status IN ('pending', 'authorized', 'revoked')),
  authorized_by TEXT NOT NULL DEFAULT '',
  authorized_at INTEGER,
  authorization_revision INTEGER NOT NULL DEFAULT 0,
  applied_policy_revision INTEGER NOT NULL DEFAULT 0,
  write_credential_status TEXT NOT NULL DEFAULT 'none'
    CHECK (write_credential_status IN ('none', 'eligible', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE INDEX IF NOT EXISTS idx_node_project_bindings_node
  ON node_project_bindings(node_id);
CREATE INDEX IF NOT EXISTS idx_node_project_bindings_project
  ON node_project_bindings(project_id);
-- §20.3: (node_id, project_id) 唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_project_bindings_unique
  ON node_project_bindings(node_id, project_id);

-- ──────────────── §20.1 agent_slots ────────────────
CREATE TABLE IF NOT EXISTS agent_slots (
  slot_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  capability_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'claiming', 'executing', 'draining')),
  active_attempt_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (node_id) REFERENCES nodes(node_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_slots_node
  ON agent_slots(node_id, status);

-- ──────────────── §20.1 legacy_project_bindings（显式映射，禁止 hash 猜测 —— R1B-002） ────────────────
CREATE TABLE IF NOT EXISTS legacy_project_bindings (
  legacy_project_path TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository_fingerprint TEXT NOT NULL,
  repository_url TEXT NOT NULL DEFAULT '',
  default_branch TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL,
  -- §20.3: (legacy_project_path, repository_fingerprint) 唯一
  PRIMARY KEY (legacy_project_path, repository_fingerprint),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_project_bindings_project
  ON legacy_project_bindings(project_id);

-- ──────────────── §20.2 plans/tasks/agent_registrations 扩展列 ────────────────

-- plans 扩展列（全部可空过渡，不破坏 V1 读写）
ALTER TABLE plans ADD COLUMN project_id TEXT;
ALTER TABLE plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN source_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN schema_version TEXT NOT NULL DEFAULT '';

-- tasks 扩展列
ALTER TABLE tasks ADD COLUMN project_id TEXT;
ALTER TABLE tasks ADD COLUMN active_attempt_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN accepted_delivery_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN accepted_evidence_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN completion_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN blocked_since INTEGER;
ALTER TABLE tasks ADD COLUMN mode_transition_id TEXT NOT NULL DEFAULT '';

-- agent_registrations 扩展列
ALTER TABLE agent_registrations ADD COLUMN node_id TEXT;
ALTER TABLE agent_registrations ADD COLUMN slot_id TEXT;
ALTER TABLE agent_registrations ADD COLUMN protocol_version TEXT NOT NULL DEFAULT '';

-- ──────────────── §20.3 约束：authorization_revision 单调递增（触发器保证） ────────────────
CREATE TRIGGER IF NOT EXISTS trg_npb_auth_revision_monotonic
  BEFORE UPDATE OF authorization_revision ON node_project_bindings
  WHEN NEW.authorization_revision < OLD.authorization_revision
BEGIN
  SELECT RAISE(ABORT, 'authorization_revision must be monotonically non-decreasing');
END;

-- node_session generation 单调递增（同节点新 generation 必须大于旧 generation）
CREATE TRIGGER IF NOT EXISTS trg_node_session_gen_monotonic
  BEFORE INSERT ON node_sessions
  WHEN EXISTS (
    SELECT 1 FROM node_sessions
    WHERE node_id = NEW.node_id
      AND node_session_generation >= NEW.node_session_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'node_session_generation must be monotonically increasing per node');
END;
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
