/**
 * SQLite 持久化存储（双写方案，对应 docs/biao/17-sqlite-persistence.md）
 * Redis 是运行时（claim/report 等实时操作），SQLite 是永久备份（防 FLUSHALL/重启丢数据）
 * service.ts 的 4 个状态流转函数在写 Redis 后同步写 SQLite
 */

import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
  /** accepted 后 dependency/lineage 副作用已完成；空串表示仍需幂等补偿。 */
  pm_accept_effects_applied?: string;
  pm_reject_reason: string;
  pm_fix_instructions: string;
  pm_rejection_resolution_mode?: string;
  repair_ownership_extension?: string;
  pm_repair_ownership_required?: string;
  pm_repair_ownership_intent?: string;
  failure_reason?: string;
  fix_for?: string;
  repair_root_task_id?: string;
  trigger_review_task_id?: string;
  /** TEXT 存储；空串表示尚未进入 resolution，非空值与公共 ResolutionStatus 同步。 */
  resolution_status?: string;
  /** TEXT 存储；包含 PM 显式 continue/cancel 决策语义，避免 SQLite 恢复后类型降级。 */
  resolution_action?: string;
  resolution_task_id?: string;
  resolution_task_ids?: string;
  acceptance_repair_task_ids?: string;
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
  cancel_reason?: string;
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
  requested_ownership?: string;
  ownership_decision?: string;
  ownership_before?: string;
  ownership_after?: string;
}

export interface AgentRegistrationRow {
  agent_id: string;
  registration_id: string;
  generation: number;
  registration_source: 'client' | 'server';
  agent_type: string;
  capabilities: string;
  endpoint: string;
  projects: string;
  registered_at: string;
}

export interface AgentRegistrationDecision {
  outcome: 'created' | 'idempotent' | 'retired';
  current: AgentRegistrationRow;
  requested?: AgentRegistrationRow;
}

export type RestoreExclusionReason =
  | 'outside_configured_workspace'
  | 'system_temporary_project'
  | 'missing_project_path';

export interface RestoreExclusionSummary {
  plan_count: number;
  task_count: number;
  by_reason: Partial<Record<RestoreExclusionReason, { plans: number; tasks: number }>>;
}

export interface SqliteStoreOptions {
  /** 非空时只恢复这些显式工作区内的项目；允许操作者明确选择位于临时盘的合法项目。 */
  restoreWorkspaceRoots?: string[];
  /** roots 为空的默认安装模式下，排除系统临时目录项目但保留 SQLite 审计行。 */
  excludeSystemTemporaryProjects?: boolean;
  /** 测试/嵌入式环境可注入；生产默认来自操作系统临时目录元数据。 */
  systemTemporaryRoots?: string[];
}

function normalizedPathForBoundary(path: string): string {
  try {
    // 存在的路径必须以最终真实位置为准，不能同时保留 lexical 路径；否则
    // workspace/link -> outside 会因为 lexical 路径仍在 workspace 内而逃逸。
    return realpathSync(path);
  } catch {
    // 项目可能已被移走；仍使用规范化后的绝对路径做可解释的保守判断。
    return resolve(path);
  }
}

function pathIsWithin(path: string, root: string): boolean {
  const candidate = normalizedPathForBoundary(path);
  const rootCandidate = normalizedPathForBoundary(root);
  const rel = relative(rootCandidate, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function defaultSystemTemporaryRoots(): string[] {
  const roots = new Set<string>();
  for (const value of [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]) {
    if (value?.trim()) roots.add(resolve(value));
  }
  // POSIX 同时存在每用户 TMPDIR 与公共临时根；这是操作系统类别，不是任务/夹具 ID 特例。
  if (process.platform !== 'win32') {
    roots.add(resolve('/tmp'));
    roots.add(resolve('/var/tmp'));
  }
  return [...roots];
}

export class SqliteStore {
  private db: Database.Database;
  private readonly restoreWorkspaceRoots?: string[];
  private readonly excludeSystemTemporaryProjects: boolean;
  private readonly systemTemporaryRoots: string[];
  private readonly dbPath: string;

  constructor(dbPath: string, options: SqliteStoreOptions = {}) {
    this.restoreWorkspaceRoots = options.restoreWorkspaceRoots?.map((root) => resolve(root));
    this.excludeSystemTemporaryProjects = options.excludeSystemTemporaryProjects ?? false;
    this.systemTemporaryRoots = (options.systemTemporaryRoots ?? defaultSystemTemporaryRoots()).map((root) => resolve(root));
    this.dbPath = dbPath;
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
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, title TEXT, type TEXT, phase TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5, assignee TEXT DEFAULT 'auto', ownership_files TEXT, ownership_modules TEXT, depends_on TEXT, timeout_seconds INTEGER DEFAULT 3600, max_retries INTEGER DEFAULT 2, model_override TEXT, acceptance_for TEXT, verify TEXT DEFAULT '[]', claimed_by TEXT, claimed_at TEXT, expire_at TEXT, result_path TEXT, result_json_path TEXT, done_at TEXT, retries INTEGER DEFAULT 0, pm_review_status TEXT, pm_reviewed_by TEXT, pm_reviewed_at TEXT, pm_review_comment TEXT, pm_accept_effects_applied TEXT, pm_reject_reason TEXT, pm_fix_instructions TEXT, pm_rejection_resolution_mode TEXT, repair_ownership_extension TEXT, pm_repair_ownership_required TEXT, pm_repair_ownership_intent TEXT, failure_reason TEXT, fix_for TEXT, repair_root_task_id TEXT, trigger_review_task_id TEXT, resolution_status TEXT, resolution_action TEXT, resolution_task_id TEXT, resolution_task_ids TEXT, acceptance_repair_task_ids TEXT, resolved_by_task TEXT, resolution_generation INTEGER DEFAULT 0, resolution_attempts INTEGER DEFAULT 0, resolution_decision_reason TEXT, blocked_at TEXT, block_reason TEXT, blocked_question_id TEXT, blocked_lease_remaining TEXT, last_question_id TEXT, last_question_answer TEXT, cancelled_at TEXT, cancel_reason TEXT, superseded_at TEXT, superseded_by TEXT, superseded_reason TEXT, supersede_preview_token TEXT, supersede_batch_size INTEGER, verify_results TEXT DEFAULT '[]', goal_md TEXT, created_at TEXT, updated_at TEXT, FOREIGN KEY (plan_id) REFERENCES plans(plan_id));
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
    if (!questionColumns.has('requested_ownership')) this.db.exec('ALTER TABLE questions ADD COLUMN requested_ownership TEXT');
    if (!questionColumns.has('ownership_decision')) this.db.exec('ALTER TABLE questions ADD COLUMN ownership_decision TEXT');
    if (!questionColumns.has('ownership_before')) this.db.exec('ALTER TABLE questions ADD COLUMN ownership_before TEXT');
    if (!questionColumns.has('ownership_after')) this.db.exec('ALTER TABLE questions ADD COLUMN ownership_after TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_registrations (
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
    CREATE INDEX IF NOT EXISTS idx_agent_registrations_current
      ON agent_registrations(agent_id, generation DESC);`);
  }

  /**
   * 将升级前 Redis 中的 epoch 历史一次性收编进 SQLite。
   * SET 没有历史顺序，因此只保证 current 拿到最大 generation；其余全是 retired，
   * 它们之间的相对顺序不影响 fencing。
   */
  seedAgentRegistrationHistory(
    agentId: string,
    registrationIds: string[],
    current: Omit<AgentRegistrationRow, 'generation'> | undefined,
  ): void {
    const seed = this.db.transaction(() => {
      const count = this.db.prepare(
        'SELECT COUNT(*) AS count FROM agent_registrations WHERE agent_id = ?',
      ).get(agentId) as { count: number };
      if (count.count > 0) return;
      const retired = [...new Set(registrationIds)]
        .filter((id) => id && id !== current?.registration_id)
        .sort();
      const insert = this.db.prepare(`INSERT INTO agent_registrations
        (agent_id, registration_id, generation, registration_source, agent_type, capabilities, endpoint, projects, registered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let generation = 0;
      for (const registrationId of retired) {
        generation++;
        insert.run(agentId, registrationId, generation, 'client', '', '', '', '', '');
      }
      if (current?.registration_id) {
        generation++;
        insert.run(
          agentId, current.registration_id, generation, current.registration_source,
          current.agent_type, current.capabilities, current.endpoint, current.projects, current.registered_at,
        );
      }
    });
    seed();
  }

  /** SQLite 先于 Redis 分配单调 generation，作为跨引擎的耐久 fencing 真相。 */
  registerAgentEpoch(input: Omit<AgentRegistrationRow, 'generation'>): AgentRegistrationDecision {
    const decide = this.db.transaction((): AgentRegistrationDecision => {
      const rows = this.db.prepare(
        'SELECT * FROM agent_registrations WHERE agent_id = ? ORDER BY generation DESC',
      ).all(input.agent_id) as AgentRegistrationRow[];
      const current = rows[0];
      const existing = rows.find((row) => row.registration_id === input.registration_id);
      if (existing && current && existing.generation < current.generation) {
        return { outcome: 'retired', current, requested: existing };
      }
      if (existing) {
        this.db.prepare(`UPDATE agent_registrations SET
          registration_source=@registration_source, agent_type=@agent_type, capabilities=@capabilities,
          endpoint=@endpoint, projects=@projects WHERE agent_id=@agent_id AND registration_id=@registration_id`
        ).run(input);
        return { outcome: 'idempotent', current: { ...existing, ...input }, requested: existing };
      }
      const row: AgentRegistrationRow = {
        ...input,
        generation: (current?.generation ?? 0) + 1,
      };
      this.db.prepare(`INSERT INTO agent_registrations
        (agent_id, registration_id, generation, registration_source, agent_type, capabilities, endpoint, projects, registered_at)
        VALUES (@agent_id, @registration_id, @generation, @registration_source, @agent_type, @capabilities, @endpoint, @projects, @registered_at)`
      ).run(row);
      return { outcome: 'created', current: row, requested: row };
    });
    return decide();
  }

  getAllAgentRegistrations(): AgentRegistrationRow[] {
    return this.db.prepare(
      'SELECT * FROM agent_registrations ORDER BY agent_id, generation',
    ).all() as AgentRegistrationRow[];
  }

  getCurrentAgentRegistration(agentId: string): AgentRegistrationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM agent_registrations WHERE agent_id = ? ORDER BY generation DESC LIMIT 1',
    ).get(agentId) as AgentRegistrationRow | undefined;
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
      pm_accept_effects_applied: task.pm_accept_effects_applied ?? '',
      pm_reject_reason: task.pm_reject_reason ?? '',
      pm_fix_instructions: task.pm_fix_instructions ?? '',
      pm_rejection_resolution_mode: task.pm_rejection_resolution_mode ?? '',
      repair_ownership_extension: task.repair_ownership_extension ?? '',
      pm_repair_ownership_required: task.pm_repair_ownership_required ?? '',
      pm_repair_ownership_intent: task.pm_repair_ownership_intent ?? '',
      failure_reason: task.failure_reason ?? '',
      fix_for: task.fix_for ?? '',
      repair_root_task_id: task.repair_root_task_id ?? '',
      trigger_review_task_id: task.trigger_review_task_id ?? '',
      resolution_status: task.resolution_status ?? '',
      resolution_action: task.resolution_action ?? '',
      resolution_task_id: task.resolution_task_id ?? '',
      resolution_task_ids: task.resolution_task_ids ?? '',
      acceptance_repair_task_ids: task.acceptance_repair_task_ids ?? '',
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
      cancel_reason: task.cancel_reason ?? '',
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
          pm_review_comment, pm_accept_effects_applied, pm_reject_reason, pm_fix_instructions, pm_rejection_resolution_mode, repair_ownership_extension, pm_repair_ownership_required, pm_repair_ownership_intent, failure_reason, fix_for, repair_root_task_id, trigger_review_task_id, resolution_status,
          resolution_action, resolution_task_id, resolution_task_ids, acceptance_repair_task_ids, resolved_by_task, resolution_generation, resolution_attempts, resolution_decision_reason,
          blocked_at, block_reason, blocked_question_id,
          blocked_lease_remaining, last_question_id, last_question_answer, cancelled_at, cancel_reason, superseded_at, superseded_by, superseded_reason, supersede_preview_token, supersede_batch_size, verify_results, goal_md, created_at, updated_at)
         VALUES
         (@task_id, @plan_id, @title, @type, @phase, @status, @priority, @assignee, @ownership_files, @ownership_modules, @depends_on,
          @timeout_seconds, @max_retries, @model_override, @acceptance_for, @verify, @claimed_by, @claimed_at, @expire_at,
          @result_path, @result_json_path, @done_at, @retries, @pm_review_status, @pm_reviewed_by, @pm_reviewed_at,
          @pm_review_comment, @pm_accept_effects_applied, @pm_reject_reason, @pm_fix_instructions, @pm_rejection_resolution_mode, @repair_ownership_extension, @pm_repair_ownership_required, @pm_repair_ownership_intent, @failure_reason, @fix_for, @repair_root_task_id, @trigger_review_task_id, @resolution_status,
          @resolution_action, @resolution_task_id, @resolution_task_ids, @acceptance_repair_task_ids, @resolved_by_task, @resolution_generation, @resolution_attempts, @resolution_decision_reason,
          @blocked_at, @block_reason, @blocked_question_id,
          @blocked_lease_remaining, @last_question_id, @last_question_answer, @cancelled_at, @cancel_reason, @superseded_at, @superseded_by, @superseded_reason, @supersede_preview_token, @supersede_batch_size, @verify_results, @goal_md, @created_at, @updated_at)`,
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
  recoverRunningTasksForRestore(taskIds?: string[]): number {
    if (taskIds && taskIds.length === 0) return 0;
    const recover = this.db.transaction(() => {
      const batches = taskIds
        ? Array.from({ length: Math.ceil(taskIds.length / 500) }, (_, index) => taskIds.slice(index * 500, (index + 1) * 500))
        : [undefined];
      let changes = 0;
      for (const batch of batches) {
        const scope = batch ? ` AND task_id IN (${batch.map(() => '?').join(',')})` : '';
        changes += this.db.prepare(
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
         updated_at = ?
       WHERE status = 'running'${scope}`,
        ).run(new Date().toISOString(), ...(batch ?? [])).changes;
      }
      return changes;
    });
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

  private restoreExclusionReason(plan: PlanRow): RestoreExclusionReason | undefined {
    const projectPath = plan.project_path?.trim();
    if (!projectPath) return 'missing_project_path';
    if (this.restoreWorkspaceRoots && this.restoreWorkspaceRoots.length > 0) {
      return this.restoreWorkspaceRoots.some((root) => pathIsWithin(projectPath, root))
        ? undefined
        : 'outside_configured_workspace';
    }
    if (this.excludeSystemTemporaryProjects && this.systemTemporaryRoots.some((root) => pathIsWithin(projectPath, root))) {
      return 'system_temporary_project';
    }
    return undefined;
  }

  /** 恢复投影专用 plan；通用 getAllPlans 仍保留完整不可变审计。 */
  getRestorablePlans(): PlanRow[] {
    return this.getAllPlans()
      .filter((plan) => this.restoreExclusionReason(plan) === undefined)
      .sort((a, b) => a.plan_id.localeCompare(b.plan_id));
  }

  /** 恢复投影专用 task；只跟随可恢复 plan，不按 task ID/名称猜测。 */
  getRestorableTasks(): TaskRow[] {
    const planIds = new Set(this.getRestorablePlans().map((plan) => plan.plan_id));
    return this.getAllTasks()
      .filter((task) => planIds.has(task.plan_id))
      .sort((a, b) => a.task_id.localeCompare(b.task_id));
  }

  getRestoreExclusionSummary(): RestoreExclusionSummary {
    const plans = this.getAllPlans();
    const taskCounts = new Map<string, number>();
    for (const task of this.getAllTasks()) taskCounts.set(task.plan_id, (taskCounts.get(task.plan_id) ?? 0) + 1);
    const summary: RestoreExclusionSummary = { plan_count: 0, task_count: 0, by_reason: {} };
    for (const plan of plans) {
      const reason = this.restoreExclusionReason(plan);
      if (!reason) continue;
      const tasks = taskCounts.get(plan.plan_id) ?? 0;
      summary.plan_count++;
      summary.task_count += tasks;
      const bucket = summary.by_reason[reason] ?? { plans: 0, tasks: 0 };
      bucket.plans++;
      bucket.tasks += tasks;
      summary.by_reason[reason] = bucket;
    }
    return summary;
  }

  /** task 总数 */
  getTaskCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }).count;
  }

  /** 主文件与 WAL 体积：仅用于 /db/status 观测展示，不触发任何自动清理。 */
  getFileSizes(): { main_bytes: number; wal_bytes: number } {
    if (this.dbPath === ':memory:') return { main_bytes: 0, wal_bytes: 0 };
    try {
      const mainBytes = statSync(this.dbPath).size;
      const walPath = `${this.dbPath}-wal`;
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      return { main_bytes: mainBytes, wal_bytes: walBytes };
    } catch {
      return { main_bytes: 0, wal_bytes: 0 };
    }
  }

  /** Redis 灾难恢复不能只看 task：Agent epoch 等空项目状态同样是安全真相。 */
  hasDurableState(): boolean {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM plans LIMIT 1) OR
      EXISTS(SELECT 1 FROM tasks LIMIT 1) OR
      EXISTS(SELECT 1 FROM questions LIMIT 1) OR
      EXISTS(SELECT 1 FROM agent_registrations LIMIT 1) AS present`).get() as { present: number };
    return Boolean(row.present);
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
      requested_ownership: q.requested_ownership ?? '',
      ownership_decision: q.ownership_decision ?? '',
      ownership_before: q.ownership_before ?? '',
      ownership_after: q.ownership_after ?? '',
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO questions
         (question_id, task_id, plan_id, agent_id, pm_consumer, asked_event_id, body, checkpoint, status, created_at, answered_at, answered_by, answer, requested_ownership, ownership_decision, ownership_before, ownership_after)
         VALUES
         (@question_id, @task_id, @plan_id, @agent_id, @pm_consumer, @asked_event_id, @body, @checkpoint, @status, @created_at, @answered_at, @answered_by, @answer, @requested_ownership, @ownership_decision, @ownership_before, @ownership_after)`,
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
