/**
 * SQLite 持久化存储（双写方案，对应 docs/biao/17-sqlite-persistence.md）
 * Redis 是运行时（claim/report 等实时操作），SQLite 是永久备份（防 FLUSHALL/重启丢数据）
 * service.ts 的 4 个状态流转函数在写 Redis 后同步写 SQLite
 */

import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { getCurrentVersion, runMigrations } from './migrate.js';
import type {
  ExecutionReceiptRecord,
  ProjectAgentBinding,
} from '../types/index.js';
import type {
  AuditEventRow,
  OutboxEventRow,
  IdempotencyRecordRow,
  RestorePointRow,
  BackupRunRow,
  ProjectModeTransitionRow,
  OrphanRecoveryCandidateRow,
  RecoveryIsolationRow,
  BranchCleanupRow,
  ExternalMergeIntentRow,
  V2OutboxStatus,
  V2CredentialKeyRecordRow,
  V2CredentialStateRow,
  IncidentRow,
  WebhookRegistrationRow,
  WebhookDeliveryRow,
} from '../types/v2-infra.js';
import type {
  ProjectRow,
  NodeRow,
  NodeSessionRow,
  NodeProjectBindingRow,
  AgentSlotRow,
  LegacyProjectBindingRow,
  ProjectMembershipRow,
  HumanSessionRow,
  HumanEnrollmentRow,
  V2HumanRole,
} from '../types/v2-identity.js';
import type {
  ArtifactRow,
  ArtifactBlobRow,
  ArtifactUploadSessionRow,
  DeliveryRow,
  TaskAttemptRow,
  OwnershipSnapshotRow,
} from '../types/v2-artifact.js';
import type { AttemptWorkspaceRow } from '../types/v2-git.js';
import type { MergeJobRow } from '../types/v2-merge.js';

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
  /** §20.2 V2 扩展列（004 迁移）：plan→project 关联；显式传入时随 upsert 落库 */
  project_id?: string;
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
  accept_verify_results?: string;
  goal_md: string;
  created_at: string;
  updated_at: string;
  // §20.2 V2 扩展列（Phase 1 004 迁移添加，全部可空过渡）
  project_id?: string;
  active_attempt_id?: string;
  accepted_delivery_id?: string;
  accepted_evidence_id?: string;
  completion_kind?: string;
  blocked_reason?: string;
  blocked_since?: number;
  mode_transition_id?: string;
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

export interface ProjectAgentBindingRow extends Omit<ProjectAgentBinding, 'capabilities'> {
  capabilities: string;
}

export interface ExecutionReceiptRow extends Omit<ExecutionReceiptRecord, 'session_ref' | 'visible_url'> {
  session_ref: string | null;
  visible_url: string | null;
}

export interface ExecutionReceiptListOptions {
  binding_id?: string;
  task_id?: string;
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
    runMigrations(this.db);
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

  createProjectAgentBinding(row: ProjectAgentBindingRow): void {
    this.db.prepare(`INSERT INTO project_agent_bindings
      (binding_id, project_scope, agent_id, label, harness_kind, capabilities, wake_mode, policy, created_at, updated_at)
      VALUES (@binding_id, @project_scope, @agent_id, @label, @harness_kind, @capabilities, @wake_mode, @policy, @created_at, @updated_at)`
    ).run(row);
  }

  deleteProjectAgentBinding(projectScope: string, bindingId: string): boolean {
    return this.db.prepare(
      'DELETE FROM project_agent_bindings WHERE project_scope = ? AND binding_id = ?',
    ).run(projectScope, bindingId).changes === 1;
  }

  getProjectAgentBinding(projectScope: string, bindingId: string): ProjectAgentBindingRow | undefined {
    return this.db.prepare(
      'SELECT * FROM project_agent_bindings WHERE project_scope = ? AND binding_id = ?',
    ).get(projectScope, bindingId) as ProjectAgentBindingRow | undefined;
  }

  getProjectAgentBindings(projectScope: string): ProjectAgentBindingRow[] {
    return this.db.prepare(
      'SELECT * FROM project_agent_bindings WHERE project_scope = ? ORDER BY binding_id',
    ).all(projectScope) as ProjectAgentBindingRow[];
  }

  appendExecutionReceipt(row: ExecutionReceiptRow): void {
    this.db.prepare(`INSERT INTO execution_receipts
      (attempt_id, task_id, project_scope, binding_id, agent_id, registration_id, harness_kind,
       wake_mode, adapter_id, status, started_at, session_ref, visible_url)
      VALUES (@attempt_id, @task_id, @project_scope, @binding_id, @agent_id, @registration_id, @harness_kind,
       @wake_mode, @adapter_id, @status, @started_at, @session_ref, @visible_url)`
    ).run(row);
  }

  getExecutionReceipt(attemptId: string): ExecutionReceiptRow | undefined {
    return this.db.prepare(
      'SELECT * FROM execution_receipts WHERE attempt_id = ?',
    ).get(attemptId) as ExecutionReceiptRow | undefined;
  }

  getExecutionReceipts(projectScope: string, options: ExecutionReceiptListOptions = {}): ExecutionReceiptRow[] {
    const clauses = ['project_scope = @project_scope'];
    const params: Record<string, string> = { project_scope: projectScope };
    if (options.binding_id) {
      clauses.push('binding_id = @binding_id');
      params.binding_id = options.binding_id;
    }
    if (options.task_id) {
      clauses.push('task_id = @task_id');
      params.task_id = options.task_id;
    }
    return this.db.prepare(
      `SELECT * FROM execution_receipts WHERE ${clauses.join(' AND ')} ORDER BY started_at, attempt_id`,
    ).all(params) as ExecutionReceiptRow[];
  }

  /** 写入或更新 plan。
   *  必须用 ON CONFLICT DO UPDATE：better-sqlite3 默认强制外键，INSERT OR REPLACE
   *  会先 DELETE 旧行，被 tasks 引用时直接 FOREIGN KEY constraint failed。 */
  upsertPlan(plan: PlanRow): void {
    const normalized = {
      ...plan,
      default_assignee: plan.default_assignee ?? 'auto',
      default_priority: plan.default_priority ?? 5,
      phases: plan.phases ?? '[]',
      pm_consumer: plan.pm_consumer ?? '',
    };
    // project_id（004 扩展列）：显式传入时落库并随冲突更新；缺省保持旧行为
    const withProject = normalized.project_id !== undefined;
    this.db
      .prepare(
        `INSERT INTO plans
         (plan_id, title, status, project_path, default_assignee, default_priority, phases, task_count, created_at, submitted_at, pm_consumer${withProject ? ', project_id' : ''})
         VALUES
         (@plan_id, @title, @status, @project_path, @default_assignee, @default_priority, @phases, @task_count, @created_at, @submitted_at, @pm_consumer${withProject ? ', @project_id' : ''})
         ON CONFLICT(plan_id) DO UPDATE SET
           title = excluded.title, status = excluded.status, project_path = excluded.project_path,
           default_assignee = excluded.default_assignee, default_priority = excluded.default_priority,
           phases = excluded.phases, task_count = excluded.task_count, created_at = excluded.created_at,
           submitted_at = excluded.submitted_at, pm_consumer = excluded.pm_consumer${withProject ? ', project_id = excluded.project_id' : ''}`,
      )
      .run(normalized);
  }

  /** 写入或更新 task（ON CONFLICT DO UPDATE 全字段覆盖；REPLACE 会先删行、触发 questions 外键） */
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
      accept_verify_results: task.accept_verify_results ?? '',
    };
    this.db
      .prepare(
        `INSERT INTO tasks
         (task_id, plan_id, title, type, phase, status, priority, assignee, ownership_files, ownership_modules, depends_on,
          timeout_seconds, max_retries, model_override, acceptance_for, verify, claimed_by, claimed_at, expire_at,
          result_path, result_json_path, done_at, retries, pm_review_status, pm_reviewed_by, pm_reviewed_at,
          pm_review_comment, pm_accept_effects_applied, pm_reject_reason, pm_fix_instructions, pm_rejection_resolution_mode, repair_ownership_extension, pm_repair_ownership_required, pm_repair_ownership_intent, failure_reason, fix_for, repair_root_task_id, trigger_review_task_id, resolution_status,
          resolution_action, resolution_task_id, resolution_task_ids, acceptance_repair_task_ids, resolved_by_task, resolution_generation, resolution_attempts, resolution_decision_reason,
          blocked_at, block_reason, blocked_question_id,
          blocked_lease_remaining, last_question_id, last_question_answer, cancelled_at, cancel_reason, superseded_at, superseded_by, superseded_reason, supersede_preview_token, supersede_batch_size, verify_results, accept_verify_results, goal_md, created_at, updated_at)
         VALUES
         (@task_id, @plan_id, @title, @type, @phase, @status, @priority, @assignee, @ownership_files, @ownership_modules, @depends_on,
          @timeout_seconds, @max_retries, @model_override, @acceptance_for, @verify, @claimed_by, @claimed_at, @expire_at,
          @result_path, @result_json_path, @done_at, @retries, @pm_review_status, @pm_reviewed_by, @pm_reviewed_at,
          @pm_review_comment, @pm_accept_effects_applied, @pm_reject_reason, @pm_fix_instructions, @pm_rejection_resolution_mode, @repair_ownership_extension, @pm_repair_ownership_required, @pm_repair_ownership_intent, @failure_reason, @fix_for, @repair_root_task_id, @trigger_review_task_id, @resolution_status,
          @resolution_action, @resolution_task_id, @resolution_task_ids, @acceptance_repair_task_ids, @resolved_by_task, @resolution_generation, @resolution_attempts, @resolution_decision_reason,
          @blocked_at, @block_reason, @blocked_question_id,
          @blocked_lease_remaining, @last_question_id, @last_question_answer, @cancelled_at, @cancel_reason, @superseded_at, @superseded_by, @superseded_reason, @supersede_preview_token, @supersede_batch_size, @verify_results, @accept_verify_results, @goal_md, @created_at, @updated_at)
         ON CONFLICT(task_id) DO UPDATE SET
           plan_id = excluded.plan_id, title = excluded.title, type = excluded.type, phase = excluded.phase,
           status = excluded.status, priority = excluded.priority, assignee = excluded.assignee,
           ownership_files = excluded.ownership_files, ownership_modules = excluded.ownership_modules,
           depends_on = excluded.depends_on, timeout_seconds = excluded.timeout_seconds,
           max_retries = excluded.max_retries, model_override = excluded.model_override,
           acceptance_for = excluded.acceptance_for, verify = excluded.verify,
           claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at, expire_at = excluded.expire_at,
           result_path = excluded.result_path, result_json_path = excluded.result_json_path,
           done_at = excluded.done_at, retries = excluded.retries,
           pm_review_status = excluded.pm_review_status, pm_reviewed_by = excluded.pm_reviewed_by,
           pm_reviewed_at = excluded.pm_reviewed_at, pm_review_comment = excluded.pm_review_comment, accept_verify_results = excluded.accept_verify_results,
           pm_accept_effects_applied = excluded.pm_accept_effects_applied,
           pm_reject_reason = excluded.pm_reject_reason, pm_fix_instructions = excluded.pm_fix_instructions,
           pm_rejection_resolution_mode = excluded.pm_rejection_resolution_mode,
           repair_ownership_extension = excluded.repair_ownership_extension,
           pm_repair_ownership_required = excluded.pm_repair_ownership_required,
           pm_repair_ownership_intent = excluded.pm_repair_ownership_intent,
           failure_reason = excluded.failure_reason, fix_for = excluded.fix_for,
           repair_root_task_id = excluded.repair_root_task_id,
           trigger_review_task_id = excluded.trigger_review_task_id,
           resolution_status = excluded.resolution_status, resolution_action = excluded.resolution_action,
           resolution_task_id = excluded.resolution_task_id, resolution_task_ids = excluded.resolution_task_ids,
           acceptance_repair_task_ids = excluded.acceptance_repair_task_ids,
           resolved_by_task = excluded.resolved_by_task, resolution_generation = excluded.resolution_generation,
           resolution_attempts = excluded.resolution_attempts,
           resolution_decision_reason = excluded.resolution_decision_reason,
           blocked_at = excluded.blocked_at, block_reason = excluded.block_reason,
           blocked_question_id = excluded.blocked_question_id,
           blocked_lease_remaining = excluded.blocked_lease_remaining,
           last_question_id = excluded.last_question_id, last_question_answer = excluded.last_question_answer,
           cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
           superseded_at = excluded.superseded_at, superseded_by = excluded.superseded_by,
           superseded_reason = excluded.superseded_reason,
           supersede_preview_token = excluded.supersede_preview_token,
           supersede_batch_size = excluded.supersede_batch_size, verify_results = excluded.verify_results,
           goal_md = excluded.goal_md, created_at = excluded.created_at, updated_at = excluded.updated_at`,
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
      EXISTS(SELECT 1 FROM agent_registrations LIMIT 1) OR
      EXISTS(SELECT 1 FROM project_agent_bindings LIMIT 1) OR
      EXISTS(SELECT 1 FROM execution_receipts LIMIT 1) AS present`).get() as { present: number };
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

  /** 写入或更新 Question（ON CONFLICT DO UPDATE 全字段覆盖） */
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
        `INSERT INTO questions
         (question_id, task_id, plan_id, agent_id, pm_consumer, asked_event_id, body, checkpoint, status, created_at, answered_at, answered_by, answer, requested_ownership, ownership_decision, ownership_before, ownership_after)
         VALUES
         (@question_id, @task_id, @plan_id, @agent_id, @pm_consumer, @asked_event_id, @body, @checkpoint, @status, @created_at, @answered_at, @answered_by, @answer, @requested_ownership, @ownership_decision, @ownership_before, @ownership_after)
         ON CONFLICT(question_id) DO UPDATE SET
           task_id = excluded.task_id, plan_id = excluded.plan_id, agent_id = excluded.agent_id,
           pm_consumer = excluded.pm_consumer, asked_event_id = excluded.asked_event_id,
           body = excluded.body, checkpoint = excluded.checkpoint, status = excluded.status,
           created_at = excluded.created_at, answered_at = excluded.answered_at,
           answered_by = excluded.answered_by, answer = excluded.answer,
           requested_ownership = excluded.requested_ownership,
           ownership_decision = excluded.ownership_decision,
           ownership_before = excluded.ownership_before, ownership_after = excluded.ownership_after`,
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

  /** 方案 E：用户名+密码账户 CRUD */
  insertHumanAccount(row: {
    username: string; password_hash: string; password_salt: string;
    role: string; project_id: string; status: string;
    created_at: number; updated_at: number; last_login_at: number | null;
  }): void {
    this.db.prepare(
      'INSERT INTO human_accounts (username, password_hash, password_salt, role, project_id, status, created_at, updated_at, last_login_at) VALUES (@username, @password_hash, @password_salt, @role, @project_id, @status, @created_at, @updated_at, @last_login_at)',
    ).run(row);
  }

  getHumanAccount(username: string): { username: string; password_hash: string; password_salt: string; role: string; project_id: string; status: string; created_at: number; updated_at: number; last_login_at: number | null } | undefined {
    return this.db.prepare('SELECT * FROM human_accounts WHERE username = ?').get(username) as never;
  }

  listHumanAccounts(): Array<{ username: string; role: string; project_id: string; status: string; created_at: number; last_login_at: number | null }> {
    return this.db.prepare('SELECT username, role, project_id, status, created_at, last_login_at FROM human_accounts ORDER BY username').all() as never;
  }

  updateHumanAccountLogin(username: string, at: number): void {
    this.db.prepare('UPDATE human_accounts SET last_login_at = ? WHERE username = ?').run(at, username);
  }

  updateHumanAccountStatus(username: string, status: string): void {
    this.db.prepare('UPDATE human_accounts SET status = ?, updated_at = ? WHERE username = ?').run(status, Date.now(), username);
  }

  deleteHumanAccount(username: string): boolean {
    return this.db.prepare('DELETE FROM human_accounts WHERE username = ?').run(username).changes > 0;
  }

  /** 当前已应用的最高迁移版本号（无迁移记录时返回 '0'） */
  getSchemaVersion(): string {
    return getCurrentVersion(this.db);
  }

  // ──────────────── V2 基础设施表方法（§20.1） ────────────────

  // ── audit_events（append-only: insert + list） ──

  insertAuditEvent(row: AuditEventRow): void {
    this.db.prepare(`INSERT INTO audit_events
      (audit_id, project_id, actor_id, action, subject_type, subject_id, correlation_id, evidence_digest, created_at)
      VALUES (@audit_id, @project_id, @actor_id, @action, @subject_type, @subject_id, @correlation_id, @evidence_digest, @created_at)`
    ).run(row);
  }

  listAuditEvents(projectId?: string, limit = 100): AuditEventRow[] {
    if (projectId) {
      return this.db.prepare(
        'SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
      ).all(projectId, limit) as AuditEventRow[];
    }
    return this.db.prepare(
      'SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as AuditEventRow[];
  }

  // ── outbox_events（insert + list + update status + listRetryable） ──

  insertOutboxEvent(row: OutboxEventRow): void {
    this.db.prepare(`INSERT INTO outbox_events
      (event_id, project_id, aggregate_type, aggregate_id, aggregate_revision, payload_digest,
       status, attempt_count, next_attempt_at, last_error, dead_lettered_at, compensates_event_id)
      VALUES (@event_id, @project_id, @aggregate_type, @aggregate_id, @aggregate_revision, @payload_digest,
       @status, @attempt_count, @next_attempt_at, @last_error, @dead_lettered_at, @compensates_event_id)`
    ).run(row);
  }

  getOutboxEvent(eventId: string): OutboxEventRow | undefined {
    return this.db.prepare(
      'SELECT * FROM outbox_events WHERE event_id = ?',
    ).get(eventId) as OutboxEventRow | undefined;
  }

  updateOutboxEvent(eventId: string, fields: Partial<OutboxEventRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'event_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE outbox_events SET ${sets} WHERE event_id = @event_id`,
    ).run({ ...fields, event_id: eventId });
  }

  listOutboxEvents(status?: V2OutboxStatus, limit = 100): OutboxEventRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM outbox_events WHERE status = ? ORDER BY next_attempt_at LIMIT ?',
      ).all(status, limit) as OutboxEventRow[];
    }
    return this.db.prepare(
      'SELECT * FROM outbox_events ORDER BY next_attempt_at LIMIT ?',
    ).all(limit) as OutboxEventRow[];
  }

  // ── idempotency_records（insert/query-by-key） ──

  insertIdempotencyRecord(row: IdempotencyRecordRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO idempotency_records
      (actor_id, route, idempotency_key, request_digest, response_entity_type, response_entity_id, response_revision, expires_at)
      VALUES (@actor_id, @route, @idempotency_key, @request_digest, @response_entity_type, @response_entity_id, @response_revision, @expires_at)`
    ).run(row);
  }

  getIdempotencyRecord(actorId: string, route: string, idempotencyKey: string): IdempotencyRecordRow | undefined {
    return this.db.prepare(
      'SELECT * FROM idempotency_records WHERE actor_id = ? AND route = ? AND idempotency_key = ?',
    ).get(actorId, route, idempotencyKey) as IdempotencyRecordRow | undefined;
  }

  // ── restore_points（insert + query + list-by-status） ──

  insertRestorePoint(row: RestorePointRow): void {
    this.db.prepare(`INSERT INTO restore_points
      (restore_point_id, db_revision, git_refs_digest, artifact_manifest_digest,
       audit_high_water, outbox_high_water, status, created_at)
      VALUES (@restore_point_id, @db_revision, @git_refs_digest, @artifact_manifest_digest,
       @audit_high_water, @outbox_high_water, @status, @created_at)`
    ).run(row);
  }

  getRestorePoint(restorePointId: string): RestorePointRow | undefined {
    return this.db.prepare(
      'SELECT * FROM restore_points WHERE restore_point_id = ?',
    ).get(restorePointId) as RestorePointRow | undefined;
  }

  listRestorePoints(status?: string): RestorePointRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM restore_points WHERE status = ? ORDER BY created_at DESC',
      ).all(status) as RestorePointRow[];
    }
    return this.db.prepare(
      'SELECT * FROM restore_points ORDER BY created_at DESC',
    ).all() as RestorePointRow[];
  }

  updateRestorePoint(restorePointId: string, fields: Partial<RestorePointRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'restore_point_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE restore_points SET ${sets} WHERE restore_point_id = @restore_point_id`,
    ).run({ ...fields, restore_point_id: restorePointId });
  }

  // ── backup_runs（insert + query + list-by-status） ──

  insertBackupRun(row: BackupRunRow): void {
    this.db.prepare(`INSERT INTO backup_runs
      (backup_run_id, restore_point_id, component, manifest_digest, status, started_at, completed_at, error)
      VALUES (@backup_run_id, @restore_point_id, @component, @manifest_digest, @status, @started_at, @completed_at, @error)`
    ).run(row);
  }

  getBackupRun(backupRunId: string): BackupRunRow | undefined {
    return this.db.prepare(
      'SELECT * FROM backup_runs WHERE backup_run_id = ?',
    ).get(backupRunId) as BackupRunRow | undefined;
  }

  updateBackupRun(backupRunId: string, fields: Partial<BackupRunRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'backup_run_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE backup_runs SET ${sets} WHERE backup_run_id = @backup_run_id`,
    ).run({ ...fields, backup_run_id: backupRunId });
  }

  listBackupRuns(restorePointId?: string): BackupRunRow[] {
    if (restorePointId) {
      return this.db.prepare(
        'SELECT * FROM backup_runs WHERE restore_point_id = ? ORDER BY started_at',
      ).all(restorePointId) as BackupRunRow[];
    }
    return this.db.prepare(
      'SELECT * FROM backup_runs ORDER BY started_at',
    ).all() as BackupRunRow[];
  }

  // ── webhook_registrations / webhook_deliveries / webhook_dispatcher_state（P12 §9） ──

  insertWebhookRegistration(row: WebhookRegistrationRow): void {
    this.db.prepare(`INSERT INTO webhook_registrations
      (webhook_id, url, secret, events, status, failure_count, last_delivered_at, created_by, created_at, updated_at)
      VALUES (@webhook_id, @url, @secret, @events, @status, @failure_count, @last_delivered_at, @created_by, @created_at, @updated_at)`
    ).run(row);
  }

  getWebhookRegistration(webhookId: string): WebhookRegistrationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM webhook_registrations WHERE webhook_id = ?',
    ).get(webhookId) as WebhookRegistrationRow | undefined;
  }

  listWebhookRegistrations(status?: string): WebhookRegistrationRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM webhook_registrations WHERE status = ? ORDER BY created_at',
      ).all(status) as WebhookRegistrationRow[];
    }
    return this.db.prepare(
      'SELECT * FROM webhook_registrations ORDER BY created_at',
    ).all() as WebhookRegistrationRow[];
  }

  updateWebhookRegistration(webhookId: string, fields: Partial<WebhookRegistrationRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'webhook_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE webhook_registrations SET ${sets} WHERE webhook_id = @webhook_id`,
    ).run({ ...fields, webhook_id: webhookId });
  }

  deleteWebhookRegistration(webhookId: string): void {
    this.db.prepare('DELETE FROM webhook_registrations WHERE webhook_id = ?').run(webhookId);
  }

  insertWebhookDelivery(row: WebhookDeliveryRow): void {
    this.db.prepare(`INSERT INTO webhook_deliveries
      (delivery_id, webhook_id, event_type, event_id, payload, signature, attempt_count,
       status, last_error, next_attempt_at, created_at, delivered_at, response_status)
      VALUES (@delivery_id, @webhook_id, @event_type, @event_id, @payload, @signature, @attempt_count,
       @status, @last_error, @next_attempt_at, @created_at, @delivered_at, @response_status)`
    ).run(row);
  }

  getWebhookDelivery(deliveryId: string): WebhookDeliveryRow | undefined {
    return this.db.prepare(
      'SELECT * FROM webhook_deliveries WHERE delivery_id = ?',
    ).get(deliveryId) as WebhookDeliveryRow | undefined;
  }

  listWebhookDeliveriesByStatus(status: string, limit = 100): WebhookDeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM webhook_deliveries WHERE status = ? ORDER BY next_attempt_at LIMIT ?',
    ).all(status, limit) as WebhookDeliveryRow[];
  }

  listDueWebhookDeliveries(now: number, limit = 50): WebhookDeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM webhook_deliveries WHERE status = ? AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?',
    ).all('pending', now, limit) as WebhookDeliveryRow[];
  }

  listWebhookDeliveriesByWebhook(webhookId: string, limit = 100): WebhookDeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(webhookId, limit) as WebhookDeliveryRow[];
  }

  updateWebhookDelivery(deliveryId: string, fields: Partial<WebhookDeliveryRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'delivery_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE webhook_deliveries SET ${sets} WHERE delivery_id = @delivery_id`,
    ).run({ ...fields, delivery_id: deliveryId });
  }

  getWebhookDispatcherState(key: string): string | undefined {
    const row = this.db.prepare(
      'SELECT value FROM webhook_dispatcher_state WHERE state_key = ?',
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setWebhookDispatcherState(key: string, value: string, now: number): void {
    this.db.prepare(`INSERT INTO webhook_dispatcher_state (state_key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, now);
  }

  // ── project_mode_transitions（insert + query + list-by-status） ──

  insertProjectModeTransition(row: ProjectModeTransitionRow): void {
    this.db.prepare(`INSERT INTO project_mode_transitions
      (transition_id, project_id, from_mode, to_mode, step, status, idempotency_key, deadline_at, last_error, started_at, completed_at)
      VALUES (@transition_id, @project_id, @from_mode, @to_mode, @step, @status, @idempotency_key, @deadline_at, @last_error, @started_at, @completed_at)`
    ).run(row);
  }

  getProjectModeTransition(transitionId: string): ProjectModeTransitionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM project_mode_transitions WHERE transition_id = ?',
    ).get(transitionId) as ProjectModeTransitionRow | undefined;
  }

  updateProjectModeTransition(transitionId: string, fields: Partial<ProjectModeTransitionRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'transition_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE project_mode_transitions SET ${sets} WHERE transition_id = @transition_id`,
    ).run({ ...fields, transition_id: transitionId });
  }

  listProjectModeTransitions(projectId?: string, status?: string): ProjectModeTransitionRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM project_mode_transitions ${where} ORDER BY started_at`,
    ).all(...params) as ProjectModeTransitionRow[];
  }

  // ── orphan_recovery_candidates（insert + query + list-by-status） ──

  insertOrphanRecoveryCandidate(row: OrphanRecoveryCandidateRow): void {
    this.db.prepare(`INSERT INTO orphan_recovery_candidates
      (candidate_id, attempt_id, project_id, marker_ref, branch_ref, head_sha, bundle_manifest_digest,
       recovery_path, status, decision, takeover_reason, takeover_at, node_ack_status,
       revision, decided_by, decided_at, resolved_at, resolution_evidence_digest)
      VALUES (@candidate_id, @attempt_id, @project_id, @marker_ref, @branch_ref, @head_sha, @bundle_manifest_digest,
       @recovery_path, @status, @decision, @takeover_reason, @takeover_at, @node_ack_status,
       @revision, @decided_by, @decided_at, @resolved_at, @resolution_evidence_digest)`
    ).run(row);
  }

  getOrphanRecoveryCandidate(candidateId: string): OrphanRecoveryCandidateRow | undefined {
    return this.db.prepare(
      'SELECT * FROM orphan_recovery_candidates WHERE candidate_id = ?',
    ).get(candidateId) as OrphanRecoveryCandidateRow | undefined;
  }

  updateOrphanRecoveryCandidate(candidateId: string, fields: Partial<OrphanRecoveryCandidateRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'candidate_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE orphan_recovery_candidates SET ${sets} WHERE candidate_id = @candidate_id`,
    ).run({ ...fields, candidate_id: candidateId });
  }

  listOrphanRecoveryCandidates(projectId?: string, status?: string): OrphanRecoveryCandidateRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM orphan_recovery_candidates ${where} ORDER BY revision DESC`,
    ).all(...params) as OrphanRecoveryCandidateRow[];
  }

  // ── recovery_isolations（insert + query + list-by-status） ──

  insertRecoveryIsolation(row: RecoveryIsolationRow): void {
    this.db.prepare(`INSERT INTO recovery_isolations
      (isolation_id, project_id, transition_id, object_type, object_id, evidence_digest, reason,
       status, isolated_by, isolated_at, retention_until, reviewed_by, reviewed_at,
       review_evidence_digest, resolved_by, resolved_at, resolution_evidence)
      VALUES (@isolation_id, @project_id, @transition_id, @object_type, @object_id, @evidence_digest, @reason,
       @status, @isolated_by, @isolated_at, @retention_until, @reviewed_by, @reviewed_at,
       @review_evidence_digest, @resolved_by, @resolved_at, @resolution_evidence)`
    ).run(row);
  }

  getRecoveryIsolation(isolationId: string): RecoveryIsolationRow | undefined {
    return this.db.prepare(
      'SELECT * FROM recovery_isolations WHERE isolation_id = ?',
    ).get(isolationId) as RecoveryIsolationRow | undefined;
  }

  updateRecoveryIsolation(isolationId: string, fields: Partial<RecoveryIsolationRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'isolation_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE recovery_isolations SET ${sets} WHERE isolation_id = @isolation_id`,
    ).run({ ...fields, isolation_id: isolationId });
  }

  listRecoveryIsolations(projectId?: string, status?: string): RecoveryIsolationRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM recovery_isolations ${where} ORDER BY isolated_at`,
    ).all(...params) as RecoveryIsolationRow[];
  }

  // ── branch_cleanups（insert + query + list-by-status） ──

  insertBranchCleanup(row: BranchCleanupRow): void {
    this.db.prepare(`INSERT INTO branch_cleanups
      (cleanup_id, project_id, delivery_id, branch_ref, expected_head_sha, reason,
       status, eligible_at, retention_until, last_error, completed_at)
      VALUES (@cleanup_id, @project_id, @delivery_id, @branch_ref, @expected_head_sha, @reason,
       @status, @eligible_at, @retention_until, @last_error, @completed_at)`
    ).run(row);
  }

  getBranchCleanup(cleanupId: string): BranchCleanupRow | undefined {
    return this.db.prepare(
      'SELECT * FROM branch_cleanups WHERE cleanup_id = ?',
    ).get(cleanupId) as BranchCleanupRow | undefined;
  }

  /** Phase 4：清理执行状态回写（deleted/failed + last_error）。 */
  updateBranchCleanup(cleanupId: string, fields: Partial<BranchCleanupRow>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== 'cleanup_id');
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(
      `UPDATE branch_cleanups SET ${sets} WHERE cleanup_id = @cleanup_id`,
    ).run({ cleanup_id: cleanupId, ...Object.fromEntries(entries) });
  }

  listBranchCleanups(projectId?: string, status?: string): BranchCleanupRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM branch_cleanups ${where} ORDER BY eligible_at`,
    ).all(...params) as BranchCleanupRow[];
  }

  // ── external_merge_intents（insert + query + list-by-status） ──

  insertExternalMergeIntent(row: ExternalMergeIntentRow): void {
    this.db.prepare(`INSERT INTO external_merge_intents
      (intent_id, project_id, delivery_id, expected_target_sha, provider_actor, approved_by,
       reason, status, final_sha, created_at, resolved_at)
      VALUES (@intent_id, @project_id, @delivery_id, @expected_target_sha, @provider_actor, @approved_by,
       @reason, @status, @final_sha, @created_at, @resolved_at)`
    ).run(row);
  }

  getExternalMergeIntent(intentId: string): ExternalMergeIntentRow | undefined {
    return this.db.prepare(
      'SELECT * FROM external_merge_intents WHERE intent_id = ?',
    ).get(intentId) as ExternalMergeIntentRow | undefined;
  }

  listExternalMergeIntents(projectId?: string, status?: string): ExternalMergeIntentRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM external_merge_intents ${where} ORDER BY created_at`,
    ).all(...params) as ExternalMergeIntentRow[];
  }

  updateExternalMergeIntent(intentId: string, fields: Partial<ExternalMergeIntentRow>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { intent_id: intentId };
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'intent_id') continue;
      sets.push(`${key} = @${key}`);
      params[key] = value;
    }
    if (sets.length === 0) return;
    this.db.prepare(
      `UPDATE external_merge_intents SET ${sets.join(', ')} WHERE intent_id = @intent_id`,
    ).run(params);
  }

  // ── incidents（Phase 7a：事故记录 CRUD） ──

  insertIncident(row: IncidentRow): void {
    this.db.prepare(`INSERT INTO incidents
      (incident_id, project_id, kind, severity, status, title, detail, correlation_id,
       related_entity_type, related_entity_id, opened_at, ack_due_at, acked_at, acked_by,
       ack_note, resolved_at, resolved_by, resolution_evidence, revision, created_at, updated_at)
      VALUES (@incident_id, @project_id, @kind, @severity, @status, @title, @detail, @correlation_id,
       @related_entity_type, @related_entity_id, @opened_at, @ack_due_at, @acked_at, @acked_by,
       @ack_note, @resolved_at, @resolved_by, @resolution_evidence, @revision, @created_at, @updated_at)`
    ).run(row);
  }

  getIncident(incidentId: string): IncidentRow | undefined {
    return this.db.prepare(
      'SELECT * FROM incidents WHERE incident_id = ?',
    ).get(incidentId) as IncidentRow | undefined;
  }

  updateIncident(incidentId: string, fields: Partial<IncidentRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'incident_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE incidents SET ${sets} WHERE incident_id = @incident_id`,
    ).run({ ...fields, incident_id: incidentId });
  }

  listIncidents(projectId?: string, status?: string, limit = 100): IncidentRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM incidents ${where} ORDER BY opened_at DESC LIMIT ?`,
    ).all(...params, limit) as IncidentRow[];
  }

  countIncidentsBySeverityOpen(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT severity, COUNT(*) as cnt FROM incidents WHERE status != 'resolved' GROUP BY severity`,
    ).all() as Array<{ severity: string; cnt: number }>;
    const result: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    for (const row of rows) result[row.severity] = row.cnt;
    return result;
  }

  // ── merge_jobs（Phase 5：合并队列 CRUD） ──

  insertMergeJob(row: MergeJobRow): void {
    this.db.prepare(`INSERT INTO merge_jobs
      (merge_job_id, delivery_id, project_id, expected_target_sha, source_sha,
       strategy, status, final_sha, cancel_reason, conflict_files, error_message,
       created_at, updated_at, completed_at)
      VALUES (@merge_job_id, @delivery_id, @project_id, @expected_target_sha, @source_sha,
       @strategy, @status, @final_sha, @cancel_reason, @conflict_files, @error_message,
       @created_at, @updated_at, @completed_at)`
    ).run(row);
  }

  getMergeJob(mergeJobId: string): MergeJobRow | undefined {
    return this.db.prepare(
      'SELECT * FROM merge_jobs WHERE merge_job_id = ?',
    ).get(mergeJobId) as MergeJobRow | undefined;
  }

  getMergeJobByDeliveryTarget(deliveryId: string, expectedTargetSha: string): MergeJobRow | undefined {
    return this.db.prepare(
      'SELECT * FROM merge_jobs WHERE delivery_id = ? AND expected_target_sha = ?',
    ).get(deliveryId, expectedTargetSha) as MergeJobRow | undefined;
  }

  listMergeJobs(projectId?: string, status?: string): MergeJobRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM merge_jobs ${where} ORDER BY created_at`,
    ).all(...params) as MergeJobRow[];
  }

  listMergeJobsByProject(projectId: string): MergeJobRow[] {
    return this.db.prepare(
      'SELECT * FROM merge_jobs WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as MergeJobRow[];
  }

  updateMergeJob(mergeJobId: string, fields: Partial<MergeJobRow>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { merge_job_id: mergeJobId };
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'merge_job_id') continue;
      sets.push(`${key} = @${key}`);
      params[key] = value;
    }
    if (sets.length === 0) return;
    this.db.prepare(
      `UPDATE merge_jobs SET ${sets.join(', ')} WHERE merge_job_id = @merge_job_id`,
    ).run(params);
  }

  countConsecutiveIntegrationFailures(projectId: string): number {
    const rows = this.db.prepare(
      `SELECT status FROM merge_jobs WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 10`,
    ).all(projectId) as Array<{ status: string }>;
    let count = 0;
    for (const row of rows) {
      if (row.status === 'integration_failed') count++;
      else break;
    }
    return count;
  }

  // ── evidence_acceptances（22.3-15：Artifact-only 完成的证据验收记录） ──

  insertEvidenceAcceptance(row: {
    acceptance_id: string;
    attempt_id: string;
    task_id: string;
    project_id: string;
    commit_sha: string;
    level: string;
    status: string;
    artifact_digests: string;
    created_at: number;
    updated_at: number;
  }): void {
    this.db.prepare(`INSERT INTO evidence_acceptances
      (acceptance_id, attempt_id, task_id, project_id, commit_sha, level,
       status, artifact_digests, created_at, updated_at)
      VALUES (@acceptance_id, @attempt_id, @task_id, @project_id, @commit_sha, @level,
       @status, @artifact_digests, @created_at, @updated_at)`
    ).run(row);
  }

  getEvidenceAcceptance(acceptanceId: string): {
    acceptance_id: string;
    attempt_id: string;
    task_id: string;
    project_id: string;
    commit_sha: string;
    level: string;
    status: string;
    artifact_digests: string;
    reviewed_by: string;
    reviewed_at: number | null;
    created_at: number;
    updated_at: number;
  } | undefined {
    return this.db.prepare(
      'SELECT * FROM evidence_acceptances WHERE acceptance_id = ?',
    ).get(acceptanceId) as any;
  }

  updateEvidenceAcceptance(acceptanceId: string, fields: Record<string, unknown>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'acceptance_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE evidence_acceptances SET ${sets} WHERE acceptance_id = @acceptance_id`,
    ).run({ ...fields, acceptance_id: acceptanceId });
  }

  listEvidenceAcceptances(projectId: string, attemptId?: string): Array<{
    acceptance_id: string;
    attempt_id: string;
    task_id: string;
    project_id: string;
    commit_sha: string;
    level: string;
    status: string;
    artifact_digests: string;
    created_at: number;
    updated_at: number;
  }> {
    if (attemptId) {
      return this.db.prepare(
        'SELECT * FROM evidence_acceptances WHERE project_id = ? AND attempt_id = ? ORDER BY created_at',
      ).all(projectId, attemptId) as any[];
    }
    return this.db.prepare(
      'SELECT * FROM evidence_acceptances WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as any[];
  }

  // ──────────────── V2 领域身份表方法（§4.1/§4.2/§4.3/§20.1） ────────────────

  // ── projects（CRUD + 按状态查询） ──

  insertProject(row: ProjectRow): void {
    this.db.prepare(`INSERT INTO projects
      (project_id, display_name, repository_url, repository_fingerprint, default_branch,
       merge_policy, execution_mode, mode_transition, mode_transition_id, mode_transition_step,
       write_capability_status, artifact_policy_id, workspace_policy_id, status, revision,
       created_at, updated_at, ref_acl_json, ref_acl_miss_count)
      VALUES (@project_id, @display_name, @repository_url, @repository_fingerprint, @default_branch,
       @merge_policy, @execution_mode, @mode_transition, @mode_transition_id, @mode_transition_step,
       @write_capability_status, @artifact_policy_id, @workspace_policy_id, @status, @revision,
       @created_at, @updated_at, @ref_acl_json, @ref_acl_miss_count)`
    ).run({
      ...row,
      // Migration 012 扩展列：可选字段统一落到列默认值（空 ACL / 计数 0）。
      ref_acl_json: row.ref_acl_json ?? '',
      ref_acl_miss_count: row.ref_acl_miss_count ?? 0,
    });
  }

  getProject(projectId: string): ProjectRow | undefined {
    return this.db.prepare(
      'SELECT * FROM projects WHERE project_id = ?',
    ).get(projectId) as ProjectRow | undefined;
  }

  updateProject(projectId: string, fields: Partial<ProjectRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'project_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE projects SET ${sets} WHERE project_id = @project_id`,
    ).run({ ...fields, project_id: projectId });
  }

  listProjects(status?: string): ProjectRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM projects WHERE status = ? ORDER BY created_at',
      ).all(status) as ProjectRow[];
    }
    return this.db.prepare(
      'SELECT * FROM projects ORDER BY created_at',
    ).all() as ProjectRow[];
  }

  // ── nodes（CRUD + 按状态查询） ──

  insertNode(row: NodeRow): void {
    this.db.prepare(`INSERT INTO nodes
      (node_id, display_name, os, arch, node_version, protocol_version, status,
       capabilities, labels, max_concurrent_tasks, memory_mb, disk_free_mb,
       last_seen_at, credential_generation, clock_skew_ms, server_cert_not_after,
       trust_anchor_generation, signing_key_generation, accepted_control_plane_signing_key_generations,
       terminal_state_at, terminal_state_reason, ttl_expires_at, created_at, updated_at)
      VALUES (@node_id, @display_name, @os, @arch, @node_version, @protocol_version, @status,
       @capabilities, @labels, @max_concurrent_tasks, @memory_mb, @disk_free_mb,
       @last_seen_at, @credential_generation, @clock_skew_ms, @server_cert_not_after,
       @trust_anchor_generation, @signing_key_generation, @accepted_control_plane_signing_key_generations,
       @terminal_state_at, @terminal_state_reason, @ttl_expires_at, @created_at, @updated_at)`
    ).run(row);
  }

  getNode(nodeId: string): NodeRow | undefined {
    return this.db.prepare(
      'SELECT * FROM nodes WHERE node_id = ?',
    ).get(nodeId) as NodeRow | undefined;
  }

  updateNode(nodeId: string, fields: Partial<NodeRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'node_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE nodes SET ${sets} WHERE node_id = @node_id`,
    ).run({ ...fields, node_id: nodeId });
  }

  listNodes(status?: string): NodeRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM nodes WHERE status = ? ORDER BY created_at',
      ).all(status) as NodeRow[];
    }
    return this.db.prepare(
      'SELECT * FROM nodes ORDER BY created_at',
    ).all() as NodeRow[];
  }

  // ── node_sessions（CRUD + generation fencing 查询） ──

  insertNodeSession(row: NodeSessionRow): void {
    this.db.prepare(`INSERT INTO node_sessions
      (session_id, node_id, node_session_generation, credential_generation, status,
       started_at, last_seen_at, fenced_at)
      VALUES (@session_id, @node_id, @node_session_generation, @credential_generation, @status,
       @started_at, @last_seen_at, @fenced_at)`
    ).run(row);
  }

  getNodeSession(sessionId: string): NodeSessionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM node_sessions WHERE session_id = ?',
    ).get(sessionId) as NodeSessionRow | undefined;
  }

  updateNodeSession(sessionId: string, fields: Partial<NodeSessionRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'session_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE node_sessions SET ${sets} WHERE session_id = @session_id`,
    ).run({ ...fields, session_id: sessionId });
  }

  listNodeSessions(nodeId?: string, status?: string): NodeSessionRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (nodeId) { clauses.push('node_id = ?'); params.push(nodeId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM node_sessions ${where} ORDER BY node_session_generation DESC`,
    ).all(...params) as NodeSessionRow[];
  }

  /** 获取节点当前代次 session（generation fencing 用） */
  getCurrentNodeSession(nodeId: string): NodeSessionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM node_sessions WHERE node_id = ? ORDER BY node_session_generation DESC LIMIT 1',
    ).get(nodeId) as NodeSessionRow | undefined;
  }

  // ── node_project_bindings（CRUD + 按 node/project 查询） ──

  insertNodeProjectBinding(row: NodeProjectBindingRow): void {
    this.db.prepare(`INSERT INTO node_project_bindings
      (binding_id, node_id, project_id, local_cache_root, checkout_mode, repository_fingerprint,
       last_fetch_sha, health, last_checked_at, authorization_status, authorized_by, authorized_at,
       authorization_revision, applied_policy_revision, write_credential_status, created_at, updated_at)
      VALUES (@binding_id, @node_id, @project_id, @local_cache_root, @checkout_mode, @repository_fingerprint,
       @last_fetch_sha, @health, @last_checked_at, @authorization_status, @authorized_by, @authorized_at,
       @authorization_revision, @applied_policy_revision, @write_credential_status, @created_at, @updated_at)`
    ).run(row);
  }

  getNodeProjectBinding(nodeId: string, projectId: string): NodeProjectBindingRow | undefined {
    return this.db.prepare(
      'SELECT * FROM node_project_bindings WHERE node_id = ? AND project_id = ?',
    ).get(nodeId, projectId) as NodeProjectBindingRow | undefined;
  }

  getNodeProjectBindingById(bindingId: string): NodeProjectBindingRow | undefined {
    return this.db.prepare(
      'SELECT * FROM node_project_bindings WHERE binding_id = ?',
    ).get(bindingId) as NodeProjectBindingRow | undefined;
  }

  updateNodeProjectBinding(bindingId: string, fields: Partial<NodeProjectBindingRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'binding_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE node_project_bindings SET ${sets} WHERE binding_id = @binding_id`,
    ).run({ ...fields, binding_id: bindingId });
  }

  listNodeProjectBindings(nodeId?: string, projectId?: string): NodeProjectBindingRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (nodeId) { clauses.push('node_id = ?'); params.push(nodeId); }
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM node_project_bindings ${where} ORDER BY created_at`,
    ).all(...params) as NodeProjectBindingRow[];
  }

  // ── agent_slots（CRUD + 按 node/status 查询） ──

  insertAgentSlot(row: AgentSlotRow): void {
    this.db.prepare(`INSERT INTO agent_slots
      (slot_id, node_id, session_id, capability_digest, status, active_attempt_id, updated_at)
      VALUES (@slot_id, @node_id, @session_id, @capability_digest, @status, @active_attempt_id, @updated_at)`
    ).run(row);
  }

  getAgentSlot(slotId: string): AgentSlotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM agent_slots WHERE slot_id = ?',
    ).get(slotId) as AgentSlotRow | undefined;
  }

  updateAgentSlot(slotId: string, fields: Partial<AgentSlotRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'slot_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE agent_slots SET ${sets} WHERE slot_id = @slot_id`,
    ).run({ ...fields, slot_id: slotId });
  }

  listAgentSlots(nodeId?: string, status?: string): AgentSlotRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (nodeId) { clauses.push('node_id = ?'); params.push(nodeId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM agent_slots ${where} ORDER BY updated_at`,
    ).all(...params) as AgentSlotRow[];
  }

  // ── legacy_project_bindings（CRUD + 按 project 查询） ──

  insertLegacyProjectBinding(row: LegacyProjectBindingRow): void {
    this.db.prepare(`INSERT INTO legacy_project_bindings
      (legacy_project_path, project_id, repository_fingerprint, repository_url, default_branch, verified_at)
      VALUES (@legacy_project_path, @project_id, @repository_fingerprint, @repository_url, @default_branch, @verified_at)`
    ).run(row);
  }

  getLegacyProjectBinding(legacyProjectPath: string, repositoryFingerprint: string): LegacyProjectBindingRow | undefined {
    return this.db.prepare(
      'SELECT * FROM legacy_project_bindings WHERE legacy_project_path = ? AND repository_fingerprint = ?',
    ).get(legacyProjectPath, repositoryFingerprint) as LegacyProjectBindingRow | undefined;
  }

  getLegacyBindingByPath(legacyProjectPath: string): LegacyProjectBindingRow | undefined {
    return this.db.prepare(
      'SELECT * FROM legacy_project_bindings WHERE legacy_project_path = ?',
    ).get(legacyProjectPath) as LegacyProjectBindingRow | undefined;
  }

  listLegacyProjectBindings(projectId?: string): LegacyProjectBindingRow[] {
    if (projectId) {
      return this.db.prepare(
        'SELECT * FROM legacy_project_bindings WHERE project_id = ? ORDER BY legacy_project_path',
      ).all(projectId) as LegacyProjectBindingRow[];
    }
    return this.db.prepare(
      'SELECT * FROM legacy_project_bindings ORDER BY legacy_project_path',
    ).all() as LegacyProjectBindingRow[];
  }

  // ── plans/tasks 按 project_id 查询（§20.2 扩展列） ──

  getPlansByProjectId(projectId: string): PlanRow[] {
    return this.db.prepare(
      'SELECT * FROM plans WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as PlanRow[];
  }

  getTasksByProjectId(projectId: string): TaskRow[] {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as TaskRow[];
  }

  /**
   * V2/V1 桥接回退（v2-routes claim）：第一个未归属 project 的 pending task。
   * 走 idx_tasks_status 索引 + LIMIT 1，替代旧 getAllTasks() 全表扫描的
   * `find(status==='pending' && !project_id)`——行序语义等价（status 索引内
   * 同状态按 rowid 升序，与全表扫描取到的首条一致）。空串视同未归属，
   * 与旧 JS 判定 `!project_id` 对齐。
   */
  getFirstPendingTaskWithoutProject(): TaskRow | undefined {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'pending' AND (project_id IS NULL OR project_id = '') LIMIT 1",
    ).get() as TaskRow | undefined;
  }

  // ── tasks 辅助查询 ──

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE task_id = ?',
    ).get(taskId) as TaskRow | undefined;
  }

  /** 通过 attempt_id（即 tasks.active_attempt_id 或 claimed_by）查找关联 task */
  getTaskByAttemptId(attemptId: string): TaskRow | undefined {
    // 先查 active_attempt_id
    const byActive = this.db.prepare(
      'SELECT * FROM tasks WHERE active_attempt_id = ?',
    ).get(attemptId) as TaskRow | undefined;
    if (byActive) return byActive;
    // 回退查 claimed_by
    return this.db.prepare(
      'SELECT * FROM tasks WHERE claimed_by = ?',
    ).get(attemptId) as TaskRow | undefined;
  }

  /** 查找关联某 artifact 的所有 upload sessions */
  getUploadSessionsByArtifact(artifactId: string): ArtifactUploadSessionRow[] {
    return this.db.prepare(
      'SELECT * FROM artifact_upload_sessions WHERE artifact_id = ? ORDER BY created_at',
    ).all(artifactId) as ArtifactUploadSessionRow[];
  }

  // ── artifacts（§4.6 / §9） ──

  insertArtifact(row: ArtifactRow): void {
    this.db.prepare(`INSERT INTO artifacts
      (artifact_id, project_id, task_id, attempt_id, kind, sha256, size_bytes,
       media_type, storage_key, status, created_at, retention_until)
      VALUES (@artifact_id, @project_id, @task_id, @attempt_id, @kind, @sha256, @size_bytes,
       @media_type, @storage_key, @status, @created_at, @retention_until)`
    ).run(row);
  }

  getArtifact(artifactId: string): ArtifactRow | undefined {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE artifact_id = ?',
    ).get(artifactId) as ArtifactRow | undefined;
  }

  getArtifactBySha256(sha256: string): ArtifactRow | undefined {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE sha256 = ? AND status = ? ORDER BY created_at LIMIT 1',
    ).get(sha256, 'complete') as ArtifactRow | undefined;
  }

  updateArtifactStatus(artifactId: string, status: string): void {
    this.db.prepare(
      'UPDATE artifacts SET status = ? WHERE artifact_id = ?',
    ).run(status, artifactId);
  }

  listArtifactsByAttempt(attemptId: string): ArtifactRow[] {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE attempt_id = ? AND status = ? ORDER BY created_at',
    ).all(attemptId, 'complete') as ArtifactRow[];
  }

  listArtifactsByTask(taskId: string): ArtifactRow[] {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE task_id = ? AND status = ? ORDER BY created_at',
    ).all(taskId, 'complete') as ArtifactRow[];
  }

  // ── artifact_blobs（§9.4 去重层） ──

  upsertArtifactBlob(sha256: string, sizeBytes: number): void {
    this.db.prepare(`INSERT INTO artifact_blobs (sha256, size_bytes, ref_count, first_seen_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(sha256, size_bytes) DO UPDATE SET ref_count = ref_count + 1`,
    ).run(sha256, sizeBytes, Date.now());
  }

  decrementBlobRef(sha256: string, sizeBytes: number): void {
    this.db.prepare(
      'UPDATE artifact_blobs SET ref_count = MAX(ref_count - 1, 0) WHERE sha256 = ? AND size_bytes = ?',
    ).run(sha256, sizeBytes);
  }

  getArtifactBlob(sha256: string, sizeBytes: number): ArtifactBlobRow | undefined {
    return this.db.prepare(
      'SELECT * FROM artifact_blobs WHERE sha256 = ? AND size_bytes = ?',
    ).get(sha256, sizeBytes) as ArtifactBlobRow | undefined;
  }

  listZeroRefBlobs(): ArtifactBlobRow[] {
    return this.db.prepare(
      'SELECT * FROM artifact_blobs WHERE ref_count = 0',
    ).all() as ArtifactBlobRow[];
  }

  deleteArtifactBlob(sha256: string, sizeBytes: number): void {
    this.db.prepare(
      'DELETE FROM artifact_blobs WHERE sha256 = ? AND size_bytes = ?',
    ).run(sha256, sizeBytes);
  }

  // ── artifact_upload_sessions（§9.2 分片上传） ──

  insertUploadSession(row: ArtifactUploadSessionRow): void {
    this.db.prepare(`INSERT INTO artifact_upload_sessions
      (upload_id, artifact_id, attempt_id, task_id, project_id, kind,
       sha256, size_bytes, received_bytes, chunk_sha256s, status, created_at, expires_at)
      VALUES (@upload_id, @artifact_id, @attempt_id, @task_id, @project_id, @kind,
       @sha256, @size_bytes, @received_bytes, @chunk_sha256s, @status, @created_at, @expires_at)`
    ).run(row);
  }

  getUploadSession(uploadId: string): ArtifactUploadSessionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM artifact_upload_sessions WHERE upload_id = ?',
    ).get(uploadId) as ArtifactUploadSessionRow | undefined;
  }

  updateUploadSessionProgress(uploadId: string, receivedBytes: number, chunkSha256s: string): void {
    this.db.prepare(
      'UPDATE artifact_upload_sessions SET received_bytes = ?, chunk_sha256s = ? WHERE upload_id = ?',
    ).run(receivedBytes, chunkSha256s, uploadId);
  }

  completeUploadSession(uploadId: string): void {
    this.db.prepare(
      "UPDATE artifact_upload_sessions SET status = 'completed' WHERE upload_id = ?",
    ).run(uploadId);
  }

  expireStaleUploadSessions(now: number): number {
    return this.db.prepare(
      "UPDATE artifact_upload_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
    ).run(now).changes;
  }

  // ── deliveries（§4.5；007 扩展 diff_summary/server_verified） ──

  insertDelivery(row: DeliveryRow): void {
    this.db.prepare(`INSERT INTO deliveries
      (delivery_id, task_id, attempt_id, project_id, base_sha, head_sha, tree_sha,
       branch_ref, changed_files, patch_digest, artifact_ids, verify_manifest_digest,
       status, accepted_commit_sha, merged_commit_sha, invalidated_reason,
       diff_summary, server_verified, created_at, updated_at)
      VALUES (@delivery_id, @task_id, @attempt_id, @project_id, @base_sha, @head_sha, @tree_sha,
       @branch_ref, @changed_files, @patch_digest, @artifact_ids, @verify_manifest_digest,
       @status, @accepted_commit_sha, @merged_commit_sha, @invalidated_reason,
       @diff_summary, @server_verified, @created_at, @updated_at)`
    ).run({
      ...row,
      diff_summary: row.diff_summary ?? '[]',
      server_verified: row.server_verified ?? 0,
    });
  }

  getDelivery(deliveryId: string): DeliveryRow | undefined {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE delivery_id = ?',
    ).get(deliveryId) as DeliveryRow | undefined;
  }

  getDeliveryByAttemptHead(attemptId: string, headSha: string): DeliveryRow | undefined {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE attempt_id = ? AND head_sha = ?',
    ).get(attemptId, headSha) as DeliveryRow | undefined;
  }

  updateDeliveryStatus(deliveryId: string, status: string, updatedAt: number): void {
    this.db.prepare(
      'UPDATE deliveries SET status = ?, updated_at = ? WHERE delivery_id = ?',
    ).run(status, updatedAt, deliveryId);
  }

  /** §4.5/§7.3 部分字段更新（状态机流转 + 服务端复核结果写回）。 */
  updateDelivery(deliveryId: string, fields: Partial<DeliveryRow>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== 'delivery_id');
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(
      `UPDATE deliveries SET ${sets} WHERE delivery_id = @delivery_id`,
    ).run({ delivery_id: deliveryId, ...Object.fromEntries(entries) });
  }

  listDeliveriesByTask(taskId: string): DeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE task_id = ? ORDER BY created_at',
    ).all(taskId) as DeliveryRow[];
  }

  listDeliveriesByProject(projectId: string): DeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at',
    ).all(projectId) as DeliveryRow[];
  }

  listDeliveriesByStatus(status: string): DeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE status = ? ORDER BY created_at',
    ).all(status) as DeliveryRow[];
  }

  listDeliveriesByAttempt(attemptId: string): DeliveryRow[] {
    return this.db.prepare(
      'SELECT * FROM deliveries WHERE attempt_id = ? ORDER BY created_at',
    ).all(attemptId) as DeliveryRow[];
  }

  // ── attempt_workspaces（§6.4/§6.5 Prepare/Finalize 状态机，007） ──

  insertAttemptWorkspace(row: AttemptWorkspaceRow): void {
    this.db.prepare(`INSERT INTO attempt_workspaces
      (attempt_id, project_id, task_id, node_id, workspace_dir, branch_ref, marker_ref,
       remote_url, remote_fingerprint, base_sha, prepare_state, prepare_error,
       finalize_state, finalize_error, head_sha, marker_sha, bva2_digest, delivery_id,
       created_at, updated_at)
      VALUES (@attempt_id, @project_id, @task_id, @node_id, @workspace_dir, @branch_ref, @marker_ref,
       @remote_url, @remote_fingerprint, @base_sha, @prepare_state, @prepare_error,
       @finalize_state, @finalize_error, @head_sha, @marker_sha, @bva2_digest, @delivery_id,
       @created_at, @updated_at)`
    ).run(row);
  }

  getAttemptWorkspace(attemptId: string): AttemptWorkspaceRow | undefined {
    return this.db.prepare(
      'SELECT * FROM attempt_workspaces WHERE attempt_id = ?',
    ).get(attemptId) as AttemptWorkspaceRow | undefined;
  }

  /** 部分字段更新；updated_at 由调用方时钟控制（缺省用 Date.now()）。 */
  updateAttemptWorkspace(attemptId: string, fields: Partial<AttemptWorkspaceRow>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== 'attempt_id');
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(
      `UPDATE attempt_workspaces SET ${sets} WHERE attempt_id = @attempt_id`,
    ).run({ attempt_id: attemptId, ...Object.fromEntries(entries) });
  }

  /** Phase 4 恢复扫描：Prepare/Finalize 停留在非终态执行中的工作区。 */
  listInterruptedAttemptWorkspaces(): Array<AttemptWorkspaceRow & { lease_expires_at: number }> {
    return this.db.prepare(`
      SELECT w.*, a.lease_expires_at AS lease_expires_at
      FROM attempt_workspaces w
      JOIN task_attempts a ON a.attempt_id = w.attempt_id
      WHERE w.prepare_state IN ('pending', 'cloning', 'checking_base', 'creating_branch')
         OR w.finalize_state IN ('committing', 'pushing', 'delivering', 'pending_recovery')
      ORDER BY w.created_at`
    ).all() as Array<AttemptWorkspaceRow & { lease_expires_at: number }>;
  }

  // ── task_attempts（§20.1） ──

  insertTaskAttempt(row: TaskAttemptRow): void {
    this.db.prepare(`INSERT INTO task_attempts
      (attempt_id, task_id, project_id, node_id, session_id, attempt_generation,
       status, lease_expires_at, lease_duration_ms, token_jti, artifact_ids,
       started_at, updated_at, completed_at, failure_reason)
      VALUES (@attempt_id, @task_id, @project_id, @node_id, @session_id, @attempt_generation,
       @status, @lease_expires_at, @lease_duration_ms, @token_jti, @artifact_ids,
       @started_at, @updated_at, @completed_at, @failure_reason)`
    ).run(row);
  }

  getTaskAttempt(attemptId: string): TaskAttemptRow | undefined {
    return this.db.prepare(
      'SELECT * FROM task_attempts WHERE attempt_id = ?',
    ).get(attemptId) as TaskAttemptRow | undefined;
  }

  updateTaskAttempt(attemptId: string, fields: Partial<TaskAttemptRow>): void {
    const entries = Object.entries(fields).filter(([k]) => k !== 'attempt_id');
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
    this.db.prepare(
      `UPDATE task_attempts SET ${sets} WHERE attempt_id = @attempt_id`,
    ).run({ attempt_id: attemptId, ...Object.fromEntries(entries) });
  }

  listTaskAttemptsByNode(nodeId: string, status?: string): TaskAttemptRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM task_attempts WHERE node_id = ? AND status = ? ORDER BY started_at',
      ).all(nodeId, status) as TaskAttemptRow[];
    }
    return this.db.prepare(
      'SELECT * FROM task_attempts WHERE node_id = ? ORDER BY started_at',
    ).all(nodeId) as TaskAttemptRow[];
  }

  listTaskAttemptsByTask(taskId: string): TaskAttemptRow[] {
    return this.db.prepare(
      'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY started_at',
    ).all(taskId) as TaskAttemptRow[];
  }

  listTaskAttemptsByProject(projectId: string, status?: string): TaskAttemptRow[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM task_attempts WHERE project_id = ? AND status = ? ORDER BY started_at',
      ).all(projectId, status) as TaskAttemptRow[];
    }
    return this.db.prepare(
      'SELECT * FROM task_attempts WHERE project_id = ? ORDER BY started_at',
    ).all(projectId) as TaskAttemptRow[];
  }

  listPendingRecoveryAttempts(nodeId: string): TaskAttemptRow[] {
    return this.db.prepare(
      "SELECT * FROM task_attempts WHERE node_id = ? AND status = 'pending_recovery' ORDER BY started_at",
    ).all(nodeId) as TaskAttemptRow[];
  }

  // ── ownership_snapshots（§20.1） ──

  insertOwnershipSnapshot(row: OwnershipSnapshotRow): void {
    this.db.prepare(`INSERT INTO ownership_snapshots
      (snapshot_id, attempt_id, task_id, files, created_at, released_at)
      VALUES (@snapshot_id, @attempt_id, @task_id, @files, @created_at, @released_at)`
    ).run(row);
  }

  getOwnershipSnapshot(snapshotId: string): OwnershipSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM ownership_snapshots WHERE snapshot_id = ?',
    ).get(snapshotId) as OwnershipSnapshotRow | undefined;
  }

  updateOwnershipSnapshot(snapshotId: string, updates: Partial<Pick<OwnershipSnapshotRow, 'released_at'>>): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (updates.released_at !== undefined) {
      sets.push('released_at = ?');
      params.push(updates.released_at);
    }
    if (sets.length === 0) return;
    params.push(snapshotId);
    this.db.prepare(`UPDATE ownership_snapshots SET ${sets.join(', ')} WHERE snapshot_id = ?`).run(...params);
  }

  listOwnershipSnapshotsByAttempt(attemptId: string): OwnershipSnapshotRow[] {
    return this.db.prepare(
      'SELECT * FROM ownership_snapshots WHERE attempt_id = ? ORDER BY created_at',
    ).all(attemptId) as OwnershipSnapshotRow[];
  }

  /** §22.2-09 列表查询：可按 attempt 过滤 / 只列未 release 的活跃快照。 */
  listOwnershipSnapshots(options?: { attemptId?: string; activeOnly?: boolean }): OwnershipSnapshotRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.attemptId) {
      clauses.push('attempt_id = ?');
      params.push(options.attemptId);
    }
    if (options?.activeOnly) {
      clauses.push('released_at IS NULL');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM ownership_snapshots ${where} ORDER BY created_at, snapshot_id`,
    ).all(...params) as OwnershipSnapshotRow[];
  }

  /**
   * §22.2-09 重建函数：从 durable ownership_snapshots 表重建运行态索引（attempt_id → files JSON）。
   * 语义：claim 落库后即使 Redis/内存快照被清空，也能从 SQLite 重建同 key 映射，
   * workspace/delivery 的 fail-closed 读取（listOwnershipSnapshotsByAttempt）不受影响。
   */
  rebuildOwnershipSnapshotIndex(): Map<string, string> {
    const index = new Map<string, string>();
    for (const row of this.listOwnershipSnapshots({ activeOnly: true })) {
      index.set(row.attempt_id, row.files);
    }
    return index;
  }

  // ──────────────── Phase 6（009）：Human Identity 与 RBAC ────────────────

  // ── project_memberships（CRUD + 撤销幂等） ──

  insertProjectMembership(row: ProjectMembershipRow): void {
    this.db.prepare(`INSERT INTO project_memberships
      (membership_id, project_id, subject, role, status, granted_by, created_at, updated_at, revoked_at, revoke_reason)
      VALUES (@membership_id, @project_id, @subject, @role, @status, @granted_by, @created_at, @updated_at, @revoked_at, @revoke_reason)`
    ).run(row);
  }

  /** (project_id, subject) 当前授予（唯一键；含 revoked 行，调用方判 status）。 */
  getProjectMembership(projectId: string, subject: string): ProjectMembershipRow | undefined {
    return this.db.prepare(
      'SELECT * FROM project_memberships WHERE project_id = ? AND subject = ?',
    ).get(projectId, subject) as ProjectMembershipRow | undefined;
  }

  getProjectMembershipById(membershipId: string): ProjectMembershipRow | undefined {
    return this.db.prepare(
      'SELECT * FROM project_memberships WHERE membership_id = ?',
    ).get(membershipId) as ProjectMembershipRow | undefined;
  }

  updateProjectMembership(membershipId: string, fields: Partial<ProjectMembershipRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'membership_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE project_memberships SET ${sets} WHERE membership_id = @membership_id`,
    ).run({ ...fields, membership_id: membershipId });
  }

  listProjectMemberships(projectId?: string, status?: string): ProjectMembershipRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM project_memberships ${where} ORDER BY created_at DESC, membership_id DESC`,
    ).all(...params) as ProjectMembershipRow[];
  }

  /** 活跃 membership 的最高角色 rank 输入（-1 = 无活跃授予）。 */
  getActiveMembershipRole(projectId: string, subject: string): V2HumanRole | null {
    const row = this.db.prepare(
      "SELECT role FROM project_memberships WHERE project_id = ? AND subject = ? AND status = 'active'",
    ).get(projectId, subject) as { role: V2HumanRole } | undefined;
    return row?.role ?? null;
  }

  // ── human_sessions（bvh2 会话吊销列表） ──

  insertHumanSession(row: HumanSessionRow): void {
    this.db.prepare(`INSERT INTO human_sessions
      (session_id, subject, role, project_id, token_jti, key_version, status,
       issued_at, expires_at, revoked_at, revoked_by, revoke_reason)
      VALUES (@session_id, @subject, @role, @project_id, @token_jti, @key_version, @status,
       @issued_at, @expires_at, @revoked_at, @revoked_by, @revoke_reason)`
    ).run(row);
  }

  getHumanSession(sessionId: string): HumanSessionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM human_sessions WHERE session_id = ?',
    ).get(sessionId) as HumanSessionRow | undefined;
  }

  getHumanSessionByJti(jti: string): HumanSessionRow | undefined {
    return this.db.prepare(
      'SELECT * FROM human_sessions WHERE token_jti = ?',
    ).get(jti) as HumanSessionRow | undefined;
  }

  updateHumanSession(sessionId: string, fields: Partial<HumanSessionRow>): void {
    const cols = Object.keys(fields).filter((k) => k !== 'session_id');
    if (cols.length === 0) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(
      `UPDATE human_sessions SET ${sets} WHERE session_id = @session_id`,
    ).run({ ...fields, session_id: sessionId });
  }

  listHumanSessions(filter: { subject?: string; projectId?: string; status?: string } = {}): HumanSessionRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.subject) { clauses.push('subject = ?'); params.push(filter.subject); }
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM human_sessions ${where} ORDER BY issued_at DESC, session_id DESC`,
    ).all(...params) as HumanSessionRow[];
  }

  /** revoke-all-sessions：全部活跃会话一次性置 revoked（幂等）。 */
  revokeAllHumanSessions(now: number, revokedBy: string, reason: string): number {
    return this.db.prepare(
      `UPDATE human_sessions SET status = 'revoked', revoked_at = @now, revoked_by = @revokedBy, revoke_reason = @reason
       WHERE status = 'active'`,
    ).run({ now, revokedBy, reason }).changes;
  }

  // ── human_enrollments（方案 E：一次性 enrollment，014 迁移） ──

  insertHumanEnrollment(row: HumanEnrollmentRow): void {
    this.db.prepare(`INSERT INTO human_enrollments
      (enrollment_id, code_hash, subject, role, project_id, created_by, created_at, expires_at, used_at, used_by_ip)
      VALUES (@enrollment_id, @code_hash, @subject, @role, @project_id, @created_by, @created_at, @expires_at, @used_at, @used_by_ip)`
    ).run(row);
  }

  getHumanEnrollmentByCodeHash(codeHash: string): HumanEnrollmentRow | undefined {
    return this.db.prepare(
      'SELECT * FROM human_enrollments WHERE code_hash = ?',
    ).get(codeHash) as HumanEnrollmentRow | undefined;
  }

  /**
   * 原子标记一次性消费：仅当 used_at 仍为 NULL 时置位（changes=0 = 已被并发
   * 消费，调用方按 ENROLLMENT_ALREADY_USED 拒绝，不可重放）。
   */
  markHumanEnrollmentUsed(enrollmentId: string, usedAt: number, usedByIp: string): boolean {
    return this.db.prepare(
      `UPDATE human_enrollments SET used_at = @used_at, used_by_ip = @used_by_ip
       WHERE enrollment_id = @enrollment_id AND used_at IS NULL`,
    ).run({ enrollment_id: enrollmentId, used_at: usedAt, used_by_ip: usedByIp }).changes === 1;
  }

  /** revoke-all-sessions / rotate：全部活跃 node session 一次性 fencing（R1C-013）。 */
  fenceAllNodeSessions(now: number): number {
    return this.db.prepare(
      `UPDATE node_sessions SET status = 'fenced', fenced_at = ? WHERE status = 'active'`,
    ).run(now).changes;
  }

  // ── v2_credential_keys / v2_credential_state（紧急撤销 durable 水位） ──

  insertCredentialKeyRecord(row: V2CredentialKeyRecordRow): void {
    this.db.prepare(`INSERT INTO v2_credential_keys
      (key_version, material_hex, created_at, created_by, reason)
      VALUES (@key_version, @material_hex, @created_at, @created_by, @reason)`
    ).run(row);
  }

  listCredentialKeyRecords(): V2CredentialKeyRecordRow[] {
    return this.db.prepare(
      'SELECT * FROM v2_credential_keys ORDER BY key_version',
    ).all() as V2CredentialKeyRecordRow[];
  }

  getCredentialState(): V2CredentialStateRow {
    return this.db.prepare('SELECT * FROM v2_credential_state WHERE id = 1').get() as V2CredentialStateRow;
  }

  /** 提升验签水位（只允许单调递增；小于当前值时抛错，防回滚降级）。 */
  raiseCredentialMinKeyVersion(minKeyVersion: number, now: number): void {
    if (!Number.isInteger(minKeyVersion) || minKeyVersion < 1) {
      throw new Error(`min_key_version 必须是正整数，实际为 ${minKeyVersion}`);
    }
    const current = this.getCredentialState();
    if (minKeyVersion < current.min_key_version) {
      throw new Error(`min_key_version 只能单调递增：当前 ${current.min_key_version}，尝试 ${minKeyVersion}`);
    }
    this.db.prepare('UPDATE v2_credential_state SET min_key_version = ?, updated_at = ? WHERE id = 1')
      .run(minKeyVersion, now);
  }

  /**
   * revoke-all-sessions 的原子落库（§20.4 迁移纪律：不分散写）：
   * 新签发密钥 + 水位前滚 + 全部活跃 human session 吊销 + 全部活跃 node session
   * fencing 在同一 SQLite 事务内完成；任一步失败整体回滚（凭据状态不变）。
   */
  applyEmergencyRevocation(
    newKey: V2CredentialKeyRecordRow,
    minKeyVersion: number,
    actor: { actor_id: string },
    reason: string,
  ): void {
    const apply = this.db.transaction(() => {
      this.insertCredentialKeyRecord(newKey);
      this.raiseCredentialMinKeyVersion(minKeyVersion, newKey.created_at);
      this.revokeAllHumanSessions(newKey.created_at, actor.actor_id, reason);
      this.fenceAllNodeSessions(newKey.created_at);
    });
    apply();
  }

  close(): void {
    this.db.close();
  }
}
