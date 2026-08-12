/**
 * SQLite 持久化存储（双写方案，对应 docs/biao/17-sqlite-persistence.md）
 * Redis 是运行时（claim/report 等实时操作），SQLite 是永久备份（防 FLUSHALL/重启丢数据）
 * service.ts 的 4 个状态流转函数在写 Redis 后同步写 SQLite
 */

import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PlanRow {
  plan_id: string;
  title: string;
  status: string;
  project_path: string;
  default_assignee: string;
  default_priority: number;
  phases: string;
  task_count: number;
  created_at: string;
  submitted_at: string;
  /** PM consumer 路由标识（被动轮询提醒按此路由）；旧库无此列时回退默认值 */
  pm_consumer?: string;
}

export interface TaskRow {
  task_id: string;
  plan_id: string;
  title: string;
  type: string;
  phase: string;
  status: string;
  priority: number;
  assignee: string;
  ownership_files: string;
  ownership_modules: string;
  depends_on: string;
  timeout_seconds: number;
  max_retries: number;
  model_override: string;
  acceptance_for: string;
  verify: string;
  claimed_by: string;
  claimed_at: string;
  expire_at: string;
  result_path: string;
  result_json_path: string;
  done_at: string;
  retries: number;
  pm_review_status: string;
  pm_reviewed_by: string;
  pm_reviewed_at: string;
  pm_review_comment: string;
  pm_reject_reason: string;
  pm_fix_instructions: string;
  pm_rejection_resolution_mode?: string;
  repair_ownership_extension?: string;
  failure_reason?: string;
  fix_for?: string;
  repair_root_task_id?: string;
  /** TEXT 存储；空串表示尚未进入 resolution，非空值与公共 ResolutionStatus 同步。 */
  resolution_status?: string;
  /** TEXT 存储；包含 PM 显式 continue/cancel 决策语义，避免 SQLite 恢复后类型降级。 */
  resolution_action?: string;
  resolution_task_id?: string;
  resolution_task_ids?: string;
  resolved_by_task?: string;
  resolution_generation?: number;
  resolution_attempts?: number;
  resolution_decision_reason?: string;
  blocked_at: string;
  block_reason: string;
  blocked_question_id: string;
  blocked_lease_remaining: string;
  last_question_id: string;
  last_question_answer: string;
  cancelled_at: string;
  superseded_at?: string;
  superseded_by?: string;
  superseded_reason?: string;
  supersede_preview_token?: string;
  supersede_batch_size?: number;
  verify_results: string;
  goal_md: string;
  created_at: string;
  updated_at: string;
}

/** Question 行（questions 表） */
export interface QuestionRow {
  question_id: string;
  task_id: string;
  plan_id: string;
  agent_id: string;
  pm_consumer: string;
  asked_event_id?: string;
  body: string;
  checkpoint: string;
  status: string;
  created_at: string;
  answered_at: string;
  answered_by: string;
  answer: string;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const fileBacked = dbPath !== ':memory:';
    if (fileBacked) {
      // Question 正文、项目路径和验收记录都属于本机私有审计数据。先以 0600 创建/
      // 收紧主文件，再开启 WAL，使 SQLite 创建的 sidecar 继承同一权限；不能等服务
      // 完成启动后才修，因为那会留下一个可被同机其他用户读取的窗口。
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      const fd = openSync(dbPath, 'a', 0o600);
      closeSync(fd);
      chmodSync(dbPath, 0o600);
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
    if (fileBacked) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
    }
  }

  private initSchema(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    // schema.sql 在 src/db/ 和 dist/db/ 都可能存在（tsc 不复制 .sql），多路径查找
    const candidates = [
      join(here, 'schema.sql'),        // dist/db/schema.sql（手动复制或软链）
      join(here, '..', '..', 'src', 'db', 'schema.sql'),  // dist/db → ../../src/db（开发态）
    ];
    let sql = '';
    for (const p of candidates) {
      try {
        sql = readFileSync(p, 'utf8');
        break;
      } catch {
        // 继续找下一个
      }
    }
    if (!sql) {
      // 兜底：内联 schema（避免找不到文件导致启动失败）
      sql = `CREATE TABLE IF NOT EXISTS plans (plan_id TEXT PRIMARY KEY, title TEXT, status TEXT DEFAULT 'submitted', project_path TEXT, default_assignee TEXT DEFAULT 'auto', default_priority INTEGER DEFAULT 5, phases TEXT DEFAULT '[]', task_count INTEGER DEFAULT 0, created_at TEXT, submitted_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, title TEXT, type TEXT, phase TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5, assignee TEXT DEFAULT 'auto', ownership_files TEXT, ownership_modules TEXT, depends_on TEXT, timeout_seconds INTEGER DEFAULT 3600, max_retries INTEGER DEFAULT 2, model_override TEXT, acceptance_for TEXT, verify TEXT DEFAULT '[]', claimed_by TEXT, claimed_at TEXT, expire_at TEXT, result_path TEXT, result_json_path TEXT, done_at TEXT, retries INTEGER DEFAULT 0, pm_review_status TEXT, pm_reviewed_by TEXT, pm_reviewed_at TEXT, pm_review_comment TEXT, pm_reject_reason TEXT, pm_fix_instructions TEXT, pm_rejection_resolution_mode TEXT, repair_ownership_extension TEXT, failure_reason TEXT, fix_for TEXT, repair_root_task_id TEXT, resolution_status TEXT, resolution_action TEXT, resolution_task_id TEXT, resolution_task_ids TEXT, resolved_by_task TEXT, resolution_generation INTEGER DEFAULT 0, resolution_attempts INTEGER DEFAULT 0, resolution_decision_reason TEXT, blocked_at TEXT, block_reason TEXT, blocked_question_id TEXT, blocked_lease_remaining TEXT, last_question_id TEXT, last_question_answer TEXT, cancelled_at TEXT, superseded_at TEXT, superseded_by TEXT, superseded_reason TEXT, supersede_preview_token TEXT, supersede_batch_size INTEGER, verify_results TEXT DEFAULT '[]', goal_md TEXT, created_at TEXT, updated_at TEXT, FOREIGN KEY (plan_id) REFERENCES plans(plan_id));
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);`;
    }
    this.db.exec(sql);
    this.migrateSchema();
  }

  /** CREATE TABLE IF NOT EXISTS 不会给旧库补列，启动时执行可重入的轻量迁移。 */
  private migrateSchema(): void {
    const ensureColumns = (table: 'plans' | 'tasks', definitions: Record<string, string>) => {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      for (const [column, definition] of Object.entries(definitions)) {
        if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    ensureColumns('plans', {
      default_assignee: "TEXT DEFAULT 'auto'",
      default_priority: 'INTEGER DEFAULT 5',
      phases: "TEXT DEFAULT '[]'",
      pm_consumer: "TEXT DEFAULT ''",
    });
    ensureColumns('tasks', {
      ownership_modules: 'TEXT',
      max_retries: 'INTEGER DEFAULT 2',
      model_override: 'TEXT',
      acceptance_for: 'TEXT',
      verify: "TEXT DEFAULT '[]'",
      pm_reject_reason: 'TEXT',
      pm_fix_instructions: 'TEXT',
      pm_rejection_resolution_mode: 'TEXT',
      repair_ownership_extension: 'TEXT',
      failure_reason: 'TEXT',
      fix_for: 'TEXT',
      repair_root_task_id: 'TEXT',
      resolution_status: 'TEXT',
      resolution_action: 'TEXT',
      resolution_task_id: 'TEXT',
      resolution_task_ids: 'TEXT',
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
      superseded_at: 'TEXT',
      superseded_by: 'TEXT',
      superseded_reason: 'TEXT',
      supersede_preview_token: 'TEXT',
      supersede_batch_size: 'INTEGER',
      verify_results: "TEXT DEFAULT '[]'",
    });
    // questions 表：CREATE TABLE IF NOT EXISTS 已在 schema.sql，旧库（无该表）兜底建一次。
    this.db.exec(`CREATE TABLE IF NOT EXISTS questions (
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
      answer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id);
    CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);`);
    const questionColumns = new Set(
      (this.db.prepare('PRAGMA table_info(questions)').all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!questionColumns.has('asked_event_id')) this.db.exec('ALTER TABLE questions ADD COLUMN asked_event_id TEXT');
  }

  /** 写入或更新 plan */
  upsertPlan(plan: PlanRow): void {
    const normalized = {
      ...plan,
      default_assignee: plan.default_assignee ?? 'auto',
      default_priority: plan.default_priority ?? 5,
      phases: plan.phases ?? '[]',
      pm_consumer: plan.pm_consumer ?? '',
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO plans
         (plan_id, title, status, project_path, default_assignee, default_priority, phases, task_count, created_at, submitted_at, pm_consumer)
         VALUES
         (@plan_id, @title, @status, @project_path, @default_assignee, @default_priority, @phases, @task_count, @created_at, @submitted_at, @pm_consumer)`,
      )
      .run(normalized);
  }

  /** 写入或更新 task（INSERT OR REPLACE，全字段覆盖） */
  upsertTask(task: TaskRow): void {
    const normalized = {
      ...task,
      ownership_modules: task.ownership_modules ?? '',
      max_retries: task.max_retries ?? 2,
      model_override: task.model_override ?? '',
      acceptance_for: task.acceptance_for ?? '',
      verify: task.verify ?? '[]',
      pm_reject_reason: task.pm_reject_reason ?? '',
      pm_fix_instructions: task.pm_fix_instructions ?? '',
      pm_rejection_resolution_mode: task.pm_rejection_resolution_mode ?? '',
      repair_ownership_extension: task.repair_ownership_extension ?? '',
      failure_reason: task.failure_reason ?? '',
      fix_for: task.fix_for ?? '',
      repair_root_task_id: task.repair_root_task_id ?? '',
      resolution_status: task.resolution_status ?? '',
      resolution_action: task.resolution_action ?? '',
      resolution_task_id: task.resolution_task_id ?? '',
      resolution_task_ids: task.resolution_task_ids ?? '',
      resolved_by_task: task.resolved_by_task ?? '',
      resolution_generation: task.resolution_generation ?? 0,
      resolution_attempts: task.resolution_attempts ?? 0,
      resolution_decision_reason: task.resolution_decision_reason ?? '',
      blocked_at: task.blocked_at ?? '',
      block_reason: task.block_reason ?? '',
      blocked_question_id: task.blocked_question_id ?? '',
      blocked_lease_remaining: task.blocked_lease_remaining ?? '',
      last_question_id: task.last_question_id ?? '',
      last_question_answer: task.last_question_answer ?? '',
      cancelled_at: task.cancelled_at ?? '',
      superseded_at: task.superseded_at ?? '',
      superseded_by: task.superseded_by ?? '',
      superseded_reason: task.superseded_reason ?? '',
      supersede_preview_token: task.supersede_preview_token ?? '',
      supersede_batch_size: task.supersede_batch_size ?? 0,
      verify_results: task.verify_results ?? '[]',
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks
         (task_id, plan_id, title, type, phase, status, priority, assignee, ownership_files, ownership_modules, depends_on,
          timeout_seconds, max_retries, model_override, acceptance_for, verify, claimed_by, claimed_at, expire_at,
          result_path, result_json_path, done_at, retries, pm_review_status, pm_reviewed_by, pm_reviewed_at,
          pm_review_comment, pm_reject_reason, pm_fix_instructions, pm_rejection_resolution_mode, repair_ownership_extension, failure_reason, fix_for, repair_root_task_id, resolution_status,
          resolution_action, resolution_task_id, resolution_task_ids, resolved_by_task, resolution_generation, resolution_attempts, resolution_decision_reason,
          blocked_at, block_reason, blocked_question_id,
          blocked_lease_remaining, last_question_id, last_question_answer, cancelled_at, superseded_at, superseded_by, superseded_reason, supersede_preview_token, supersede_batch_size, verify_results, goal_md, created_at, updated_at)
         VALUES
         (@task_id, @plan_id, @title, @type, @phase, @status, @priority, @assignee, @ownership_files, @ownership_modules, @depends_on,
          @timeout_seconds, @max_retries, @model_override, @acceptance_for, @verify, @claimed_by, @claimed_at, @expire_at,
          @result_path, @result_json_path, @done_at, @retries, @pm_review_status, @pm_reviewed_by, @pm_reviewed_at,
          @pm_review_comment, @pm_reject_reason, @pm_fix_instructions, @pm_rejection_resolution_mode, @repair_ownership_extension, @failure_reason, @fix_for, @repair_root_task_id, @resolution_status,
          @resolution_action, @resolution_task_id, @resolution_task_ids, @resolved_by_task, @resolution_generation, @resolution_attempts, @resolution_decision_reason,
          @blocked_at, @block_reason, @blocked_question_id,
          @blocked_lease_remaining, @last_question_id, @last_question_answer, @cancelled_at, @superseded_at, @superseded_by, @superseded_reason, @supersede_preview_token, @supersede_batch_size, @verify_results, @goal_md, @created_at, @updated_at)`,
      )
      .run(normalized);
  }

  /** 增量更新 task 的部分字段（claim/report/reset/cancel 时用） */
  updateTaskFields(taskId: string, fields: Record<string, unknown>): void {
    const cols = Object.keys(fields);
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    const params: Record<string, unknown> = { ...fields, task_id: taskId, updated_at: new Date().toISOString() };
    this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE task_id = @task_id`).run(params);
  }

  /**
   * 灾难恢复不能复活进程崩溃前的执行现场。先在一个 SQLite 事务中把所有 persisted
   * running 规范化为可重新领取的 pending；只清 claim/lease/block 上下文，保留
   * last_question_id/last_question_answer 作为下一位 Worker 的 durable PM 上下文。
   */
  recoverRunningTasksForRestore(): number {
    const recover = this.db.transaction(() => this.db.prepare(
      `UPDATE tasks SET
         status = 'pending',
         claimed_by = '',
         claimed_at = '',
         expire_at = '',
         failure_reason = 'recovered_from_persisted_running',
         blocked_at = '',
         block_reason = '',
         blocked_question_id = '',
         blocked_lease_remaining = '',
         updated_at = @updated_at
       WHERE status = 'running'`,
    ).run({ updated_at: new Date().toISOString() }).changes);
    return recover();
  }

  /** 读取所有 task（恢复 Redis 时用） */
  getAllTasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks').all() as TaskRow[];
  }

  /** 读取所有 plan */
  getAllPlans(): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans').all() as PlanRow[];
  }

  /** task 总数 */
  getTaskCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }).count;
  }

  /** 按状态统计 task */
  getTaskCountByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) as c FROM tasks GROUP BY status').all() as Array<{ status: string; c: number }>;
    const result: Record<string, number> = {};
    for (const r of rows) result[r.status] = r.c;
    return result;
  }

  /** plan 总数 */
  getPlanCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM plans').get() as { count: number }).count;
  }

  /** 写入或更新 Question（INSERT OR REPLACE，全字段覆盖） */
  upsertQuestion(q: QuestionRow): void {
    const n = {
      question_id: q.question_id,
      task_id: q.task_id,
      plan_id: q.plan_id ?? '',
      agent_id: q.agent_id,
      pm_consumer: q.pm_consumer ?? '',
      asked_event_id: q.asked_event_id ?? '',
      body: q.body ?? '',
      checkpoint: q.checkpoint ?? '',
      status: q.status ?? 'open',
      created_at: q.created_at ?? '',
      answered_at: q.answered_at ?? '',
      answered_by: q.answered_by ?? '',
      answer: q.answer ?? '',
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO questions
         (question_id, task_id, plan_id, agent_id, pm_consumer, asked_event_id, body, checkpoint, status, created_at, answered_at, answered_by, answer)
         VALUES
         (@question_id, @task_id, @plan_id, @agent_id, @pm_consumer, @asked_event_id, @body, @checkpoint, @status, @created_at, @answered_at, @answered_by, @answer)`,
      )
      .run(n);
  }

  /** 读取单个 Question（恢复 / 二次读取用） */
  getQuestion(questionId: string): QuestionRow | undefined {
    return this.db.prepare('SELECT * FROM questions WHERE question_id = ?').get(questionId) as
      | QuestionRow
      | undefined;
  }

  /** 读取全部 Question（Redis 恢复时用） */
  getAllQuestions(): QuestionRow[] {
    return this.db.prepare('SELECT * FROM questions').all() as QuestionRow[];
  }

  close(): void {
    this.db.close();
  }
}
