/**
 * Phase 0a-2：V2 基础设施最小 durable schema。
 * 对应 docs/distributed-multi-node-development-plan.md §20.1（基础设施最小字段表）。
 *
 * 覆盖十张基础设施表：audit_events、outbox_events、idempotency_records、
 * restore_points、backup_runs、project_mode_transitions、orphan_recovery_candidates、
 * recovery_isolations、branch_cleanups、external_merge_intents。
 *
 * 过渡决策：project_id 先允许 NULL，Phase 1 才有 projects 表的外键约束。
 * 时间戳统一 INTEGER 毫秒（Date.now()），与 V1 TEXT ISO 格式并存。
 *
 * 不含领域大表（projects/nodes/node_sessions 等，属 Phase 1+），
 * 但为 §20.2 的 plans/tasks 扩展列留注释占位（不实际加列）。
 */
import type Database from 'better-sqlite3';

export const version = '003';

const schemaSql = `
-- §20.1 audit_events — 审计事件（append-only）
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  project_id TEXT,                -- Phase 1 才有 projects 外键
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  evidence_digest TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL     -- 毫秒时间戳
);

CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
  ON audit_events(project_id, created_at, audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
  ON audit_events(correlation_id);

-- §20.1 outbox_events — 事件外发箱
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  payload_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  dead_lettered_at INTEGER,
  compensates_event_id TEXT NOT NULL DEFAULT ''
);

-- §20.3: (aggregate_type, aggregate_id, aggregate_revision) 可幂等定位
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_events_aggregate
  ON outbox_events(aggregate_type, aggregate_id, aggregate_revision);
CREATE INDEX IF NOT EXISTS idx_outbox_events_status_next
  ON outbox_events(status, next_attempt_at)
  WHERE status = 'pending';

-- §20.1 idempotency_records — 请求幂等记录
CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL DEFAULT '',
  response_entity_type TEXT NOT NULL DEFAULT '',
  response_entity_id TEXT NOT NULL DEFAULT '',
  response_revision INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, route, idempotency_key)  -- §20.3 三键唯一
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires
  ON idempotency_records(expires_at);

-- §20.1 restore_points — 恢复点
CREATE TABLE IF NOT EXISTS restore_points (
  restore_point_id TEXT PRIMARY KEY,
  db_revision INTEGER NOT NULL DEFAULT 0,
  git_refs_digest TEXT NOT NULL DEFAULT '',
  artifact_manifest_digest TEXT NOT NULL DEFAULT '',
  audit_high_water INTEGER NOT NULL DEFAULT 0,
  outbox_high_water INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'completed', 'failed')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restore_points_status
  ON restore_points(status, created_at);

-- §20.1 backup_runs — 备份运行记录
CREATE TABLE IF NOT EXISTS backup_runs (
  backup_run_id TEXT PRIMARY KEY,
  restore_point_id TEXT NOT NULL,
  component TEXT NOT NULL,
  manifest_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (restore_point_id) REFERENCES restore_points(restore_point_id)
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_restore
  ON backup_runs(restore_point_id, component);

-- §20.1 project_mode_transitions — 模式切换步骤记录
CREATE TABLE IF NOT EXISTS project_mode_transitions (
  transition_id TEXT PRIMARY KEY,
  project_id TEXT,
  from_mode TEXT NOT NULL CHECK (from_mode IN ('full', 'read-only-acceptance')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('full', 'read-only-acceptance')),
  step TEXT NOT NULL CHECK (step IN (
    'pause', 'fence-attempts', 'invalidate-lineage', 'block-dependents',
    'validate-capability', 'reconcile', 'refresh-bindings', 'revalidate-plans', 'commit-mode'
  )),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'failed', 'completed')),
  idempotency_key TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- §20.3: 每个 project 同时最多一个 running transition
-- 使用部分唯一索引（SQLite ≥ 3.8.0 支持 WHERE 子句）
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_mode_transitions_one_running
  ON project_mode_transitions(project_id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_project_mode_transitions_project
  ON project_mode_transitions(project_id, started_at, transition_id);

-- §20.1 orphan_recovery_candidates — 孤儿恢复候选
CREATE TABLE IF NOT EXISTS orphan_recovery_candidates (
  candidate_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  project_id TEXT,
  marker_ref TEXT NOT NULL DEFAULT '',
  branch_ref TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  bundle_manifest_digest TEXT NOT NULL DEFAULT '',
  recovery_path TEXT NOT NULL CHECK (recovery_path IN ('node-driven', 'control-plane-takeover')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'decided', 'executing', 'resolved', 'isolated')),
  decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'upload-and-reverify', 'retain-evidence-only', 'discard-after-audit')),
  takeover_reason TEXT NOT NULL DEFAULT '',
  takeover_at INTEGER,
  node_ack_status TEXT NOT NULL DEFAULT 'not-required'
    CHECK (node_ack_status IN ('not-required', 'pending', 'acked')),
  revision INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at INTEGER,
  resolved_at INTEGER,
  resolution_evidence_digest TEXT NOT NULL DEFAULT ''
);

-- §20.3: 每个 attempt 同时最多一个 pending candidate
CREATE UNIQUE INDEX IF NOT EXISTS idx_orphan_candidates_one_pending_per_attempt
  ON orphan_recovery_candidates(attempt_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_orphan_candidates_project_status
  ON orphan_recovery_candidates(project_id, status);

-- §20.1 recovery_isolations — 隔离记录
CREATE TABLE IF NOT EXISTS recovery_isolations (
  isolation_id TEXT PRIMARY KEY,
  project_id TEXT,
  transition_id TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL
    CHECK (object_type IN ('remote-ref', 'recovery-candidate', 'artifact-manifest', 'ownership-snapshot')),
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
  resolution_evidence TEXT NOT NULL DEFAULT ''  -- JSON 字符串
);

-- §20.3: 同一 object_type + object_id 同时最多一个未 resolved 记录
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_isolations_one_unresolved
  ON recovery_isolations(object_type, object_id)
  WHERE status != 'resolved';

CREATE INDEX IF NOT EXISTS idx_recovery_isolations_project_status
  ON recovery_isolations(project_id, status);

-- §20.1 branch_cleanups — 分支清理记录
CREATE TABLE IF NOT EXISTS branch_cleanups (
  cleanup_id TEXT PRIMARY KEY,
  project_id TEXT,
  delivery_id TEXT NOT NULL,
  branch_ref TEXT NOT NULL,
  expected_head_sha TEXT NOT NULL,
  reason TEXT NOT NULL
    CHECK (reason IN ('rejected', 'superseded', 'conflict', 'integration_failed', 'invalidated', 'mode_transition')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'deferred', 'deleted', 'failed')),
  eligible_at INTEGER NOT NULL,
  retention_until INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  completed_at INTEGER
);

-- §20.3: (delivery_id, branch_ref, expected_head_sha) 唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_cleanups_delivery_branch_sha
  ON branch_cleanups(delivery_id, branch_ref, expected_head_sha);

CREATE INDEX IF NOT EXISTS idx_branch_cleanups_project_status
  ON branch_cleanups(project_id, status);

-- §20.1 external_merge_intents — 外部合并意图
CREATE TABLE IF NOT EXISTS external_merge_intents (
  intent_id TEXT PRIMARY KEY,
  project_id TEXT,
  delivery_id TEXT NOT NULL,
  expected_target_sha TEXT NOT NULL,
  provider_actor TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared', 'reconciling', 'verified', 'failed')),
  final_sha TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_external_merge_intents_project
  ON external_merge_intents(project_id, created_at);

-- ──────────────── §20.2 占位注释 ────────────────
-- plans 扩展列（Phase 1）：project_id, revision, source_digest, schema_version
-- tasks 扩展列（Phase 1）：project_id, active_attempt_id, accepted_delivery_id,
--   accepted_evidence_id, completion_kind, blocked_reason, blocked_since, mode_transition_id
-- agent_registrations 扩展列（Phase 1）：node_id, slot_id, protocol_version
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
