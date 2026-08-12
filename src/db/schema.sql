-- Biao SQLite 持久化 schema（对应 docs/biao/17-sqlite-persistence.md）
-- 引擎：better-sqlite3（WAL 模式）

CREATE TABLE IF NOT EXISTS plans (
  plan_id      TEXT PRIMARY KEY,
  title        TEXT,
  status       TEXT DEFAULT 'submitted',
  project_path TEXT,
  default_assignee TEXT DEFAULT 'auto',
  default_priority INTEGER DEFAULT 5,
  phases       TEXT DEFAULT '[]',
  task_count   INTEGER DEFAULT 0,
  created_at   TEXT,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id       TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL,
  title         TEXT,
  type          TEXT,
  phase         TEXT,
  status        TEXT DEFAULT 'pending',
  priority      INTEGER DEFAULT 5,
  assignee      TEXT DEFAULT 'auto',
  ownership_files TEXT,
  ownership_modules TEXT,
  depends_on    TEXT,
  timeout_seconds INTEGER DEFAULT 3600,
  max_retries   INTEGER DEFAULT 2,
  model_override TEXT,
  acceptance_for TEXT,
  verify         TEXT DEFAULT '[]',
  claimed_by    TEXT,
  claimed_at    TEXT,
  expire_at     TEXT,
  result_path   TEXT,
  result_json_path TEXT,
  done_at       TEXT,
  retries       INTEGER DEFAULT 0,
  pm_review_status TEXT,
  pm_reviewed_by    TEXT,
  pm_reviewed_at    TEXT,
  pm_review_comment TEXT,
  pm_reject_reason TEXT,
  pm_fix_instructions TEXT,
  pm_rejection_resolution_mode TEXT,
  repair_ownership_extension TEXT,
  failure_reason TEXT,
  fix_for TEXT,
  repair_root_task_id TEXT,
  -- required/repairing/resolved/needs_pm_decision/cancelled；空值表示尚未进入闭环。
  resolution_status TEXT,
  -- repair/reverify/inspect/continue/cancel；显式终止也必须可恢复、可审计。
  resolution_action TEXT,
  resolution_task_id TEXT,
  resolution_task_ids TEXT,
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
  superseded_at TEXT,
  superseded_by TEXT,
  superseded_reason TEXT,
  supersede_preview_token TEXT,
  supersede_batch_size INTEGER,
  verify_results TEXT DEFAULT '[]',
  goal_md       TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);

-- Question 状态机（Worker 向 PM 提问的真实持久化实体，替代旧 task block 字符串）
-- 一个 Question 绑定一个 task；提问时任务进入 blocked/waiting_pm_reply 并释放 ownership，
-- 让原 Agent 可以去领下一项；PM 回答后任务恢复为 pending（新 claim_token 重领）。
CREATE TABLE IF NOT EXISTS questions (
  question_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  plan_id       TEXT,
  agent_id      TEXT NOT NULL,
  pm_consumer   TEXT,
  asked_event_id TEXT,
  body          TEXT,
  checkpoint    TEXT,
  status        TEXT DEFAULT 'open',   -- open / answered / cancelled
  created_at    TEXT,
  answered_at   TEXT,
  answered_by   TEXT,
  answer        TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);
