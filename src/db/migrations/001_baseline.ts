import type Database from 'better-sqlite3';

export const version = '001';

/**
 * V1 的不可变建表基线。后续 schema 变化必须新增迁移，不能修改本文件的迁移材料。
 */
const createSchemaSql = `
CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT DEFAULT 'submitted',
  project_path TEXT,
  default_assignee TEXT DEFAULT 'auto',
  default_priority INTEGER DEFAULT 5,
  phases TEXT DEFAULT '[]',
  task_count INTEGER DEFAULT 0,
  created_at TEXT,
  submitted_at TEXT,
  pm_consumer TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  title TEXT,
  type TEXT,
  phase TEXT,
  status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 5,
  assignee TEXT DEFAULT 'auto',
  ownership_files TEXT,
  ownership_modules TEXT,
  depends_on TEXT,
  timeout_seconds INTEGER DEFAULT 3600,
  max_retries INTEGER DEFAULT 2,
  model_override TEXT,
  acceptance_for TEXT,
  verify TEXT DEFAULT '[]',
  claimed_by TEXT,
  claimed_at TEXT,
  expire_at TEXT,
  result_path TEXT,
  result_json_path TEXT,
  done_at TEXT,
  retries INTEGER DEFAULT 0,
  pm_review_status TEXT,
  pm_reviewed_by TEXT,
  pm_reviewed_at TEXT,
  pm_review_comment TEXT,
  pm_accept_effects_applied TEXT,
  pm_reject_reason TEXT,
  pm_fix_instructions TEXT,
  pm_rejection_resolution_mode TEXT,
  repair_ownership_extension TEXT,
  pm_repair_ownership_required TEXT,
  pm_repair_ownership_intent TEXT,
  failure_reason TEXT,
  fix_for TEXT,
  repair_root_task_id TEXT,
  trigger_review_task_id TEXT,
  resolution_status TEXT,
  resolution_action TEXT,
  resolution_task_id TEXT,
  resolution_task_ids TEXT,
  acceptance_repair_task_ids TEXT,
  resolved_by_task TEXT,
  resolution_generation INTEGER DEFAULT 0,
  resolution_attempts INTEGER DEFAULT 0,
  resolution_decision_reason TEXT,
  blocked_at TEXT,
  block_reason TEXT,
  blocked_question_id TEXT,
  blocked_lease_remaining TEXT,
  last_question_id TEXT,
  last_question_answer TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  superseded_at TEXT,
  superseded_by TEXT,
  superseded_reason TEXT,
  supersede_preview_token TEXT,
  supersede_batch_size INTEGER,
  verify_results TEXT DEFAULT '[]',
  goal_md TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
);

CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  plan_id TEXT,
  agent_id TEXT NOT NULL,
  pm_consumer TEXT,
  asked_event_id TEXT,
  body TEXT,
  checkpoint TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT,
  answered_at TEXT,
  answered_by TEXT,
  answer TEXT,
  requested_ownership TEXT,
  ownership_decision TEXT,
  ownership_before TEXT,
  ownership_after TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE TABLE IF NOT EXISTS agent_registrations (
  agent_id TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  registration_source TEXT NOT NULL,
  agent_type TEXT,
  capabilities TEXT,
  endpoint TEXT,
  projects TEXT,
  registered_at TEXT,
  PRIMARY KEY (agent_id, registration_id),
  UNIQUE (agent_id, generation)
);
`;

/** 这些列覆盖当前 V1 曾由 sqlite-store 隐式 ALTER 的全部升级路径。 */
const legacyColumns = {
  plans: {
    default_assignee: "TEXT DEFAULT 'auto'",
    default_priority: 'INTEGER DEFAULT 5',
    phases: "TEXT DEFAULT '[]'",
    pm_consumer: "TEXT DEFAULT ''",
  },
  tasks: {
    ownership_modules: 'TEXT',
    max_retries: 'INTEGER DEFAULT 2',
    model_override: 'TEXT',
    acceptance_for: 'TEXT',
    verify: "TEXT DEFAULT '[]'",
    pm_accept_effects_applied: 'TEXT',
    pm_reject_reason: 'TEXT',
    pm_fix_instructions: 'TEXT',
    pm_rejection_resolution_mode: 'TEXT',
    repair_ownership_extension: 'TEXT',
    pm_repair_ownership_required: 'TEXT',
    pm_repair_ownership_intent: 'TEXT',
    failure_reason: 'TEXT',
    fix_for: 'TEXT',
    repair_root_task_id: 'TEXT',
    trigger_review_task_id: 'TEXT',
    resolution_status: 'TEXT',
    resolution_action: 'TEXT',
    resolution_task_id: 'TEXT',
    resolution_task_ids: 'TEXT',
    acceptance_repair_task_ids: 'TEXT',
    resolved_by_task: 'TEXT',
    resolution_generation: 'INTEGER DEFAULT 0',
    resolution_attempts: 'INTEGER DEFAULT 0',
    resolution_decision_reason: 'TEXT',
    blocked_at: 'TEXT',
    block_reason: 'TEXT',
    blocked_question_id: 'TEXT',
    blocked_lease_remaining: 'TEXT',
    last_question_id: 'TEXT',
    last_question_answer: 'TEXT',
    cancelled_at: 'TEXT',
    cancel_reason: 'TEXT',
    superseded_at: 'TEXT',
    superseded_by: 'TEXT',
    superseded_reason: 'TEXT',
    supersede_preview_token: 'TEXT',
    supersede_batch_size: 'INTEGER',
    verify_results: "TEXT DEFAULT '[]'",
  },
  questions: {
    asked_event_id: 'TEXT',
    requested_ownership: 'TEXT',
    ownership_decision: 'TEXT',
    ownership_before: 'TEXT',
    ownership_after: 'TEXT',
  },
} as const;

const createIndexesSql = `
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS idx_agent_registrations_current
  ON agent_registrations(agent_id, generation DESC);
`;

export const checksumMaterial = JSON.stringify({ createSchemaSql, legacyColumns, createIndexesSql });

export function up(db: Database.Database): void {
  db.exec(createSchemaSql);
  for (const [table, definitions] of Object.entries(legacyColumns)) {
    const existing = new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name),
    );
    for (const [column, definition] of Object.entries(definitions)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(createIndexesSql);
}
