/**
 * Biao 核心类型定义
 * 对应 docs/biao/02-planning-md-standard.md 的 schema
 */

export type TaskType = 'code' | 'review' | 'research' | 'docs' | 'acceptance';
export type TaskStatus = 'pending' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled' | 'superseded';
export type Assignee = 'codex' | 'kimi' | 'mimo' | 'zcode' | 'auto' | string;
export type AgentStatus = 'idle' | 'busy' | 'offline';
export type ProjectAgentWakeMode = 'visible_session' | 'background_executor' | 'external_worker';
export type ProjectAgentBindingPolicy = 'manual' | 'on_demand' | 'automatic';
export type ProjectAgentAvailabilityStatus =
  | 'online_registered'
  | 'bound_wakeable'
  | 'background_only'
  | 'manual_required';
export type ExecutionReceiptStatus = 'requested' | 'succeeded' | 'failed';

/** 项目绑定是独立于 Agent 注册 epoch 的耐久控制面实体。 */
export interface ProjectAgentBinding {
  binding_id: string;
  project_scope: string;
  agent_id: string;
  label: string;
  harness_kind: string;
  capabilities: string[];
  wake_mode: ProjectAgentWakeMode;
  policy: ProjectAgentBindingPolicy;
  created_at: number;
  updated_at: number;
}

export interface ProjectAgentBindingCreateRequest {
  binding_id?: string;
  agent_id: string;
  label: string;
  harness_kind: string;
  capabilities?: string[];
  wake_mode: ProjectAgentWakeMode;
  policy: ProjectAgentBindingPolicy;
}

/** 注册时随请求携带的自动绑定声明（精简字段，平台补全默认值）。 */
export interface RegistrationProjectBinding {
  project_scope: string;
  wake_mode?: ProjectAgentWakeMode;
  policy?: ProjectAgentBindingPolicy;
}

/** UI/HTTP 状态投影；不包含注册 epoch、endpoint、command 或 target。 */
export interface ProjectAgentRosterItem extends Omit<ProjectAgentBinding, 'created_at' | 'updated_at'> {
  availability_status: ProjectAgentAvailabilityStatus;
  online_registered: boolean;
}

export interface ProjectAgentOnlineCandidate {
  agent_id: string;
  label: string;
  harness_kind: string;
  capabilities: string[];
  project_scope: string;
  /** Agent 当前注册声明的项目；只作名册信息，不限制 Owner 将它加入其它项目。 */
  registered_projects: string[];
  availability_status: 'online_registered';
}

/** SQLite 内部完整回执；registration_id 只用于耐久审计，不进入公共投影。 */
export interface ExecutionReceiptRecord {
  attempt_id: string;
  task_id: string;
  project_scope: string;
  binding_id: string;
  agent_id: string;
  registration_id: string;
  harness_kind: string;
  wake_mode: ProjectAgentWakeMode;
  adapter_id: string | null;
  status: ExecutionReceiptStatus;
  started_at: number;
  session_ref?: string;
  visible_url?: string;
}

export type ExecutionReceiptCreateRequest = Omit<ExecutionReceiptRecord, 'project_scope'>;

export type PublicExecutionReceipt = Omit<ExecutionReceiptRecord, 'registration_id'>;

/** 任务列表读视图（V1 service.ts → V2 domain-interfaces.ts 共享）。 */
export interface TaskListItem {
  task_id: string;
  title: string;
  type: string;
  phase: string;
  status: string;
  assignee: string;
  priority: number;
  plan_id: string;
  project_path: string;
  pm_review_status?: string;
  failure_reason?: string;
  block_reason?: string;
  fix_for?: string;
  repair_root_task_id?: string;
  resolution_status?: string;
  resolution_action?: string;
  resolution_task_id?: string;
  resolution_task_ids?: string[];
  resolved_by_task?: string;
  resolution_generation?: number;
  resolution_attempts?: number;
  superseded_at?: number;
  superseded_by?: string;
  superseded_reason?: string;
}

/** 修复/复验根任务的完整生命周期；cancelled 是 PM 显式终止后的终态。 */
export type ResolutionStatus = 'required' | 'repairing' | 'resolved' | 'needs_pm_decision' | 'cancelled';
/** resolution 的执行方向与 PM 决策动作；continue 只用于显式多放行一代。 */
export type ResolutionAction = 'repair' | 'reverify' | 'inspect' | 'continue' | 'cancel';
export type ResolutionDecisionAction = Extract<ResolutionAction, 'inspect' | 'continue' | 'cancel'>;

/** task.md frontmatter schema */
export interface TaskFrontmatter {
  task_id: string;
  title: string;
  type: TaskType;
  phase: string;
  depends_on?: string[];
  assignee: Assignee;
  ownership?: {
    files?: string[];
    modules?: string[];
    readonly?: string[];
  };
  priority?: number;
  timeout_seconds?: number;
  max_retries?: number;
  model_override?: string;
  acceptance_for?: string[];
  verify?: VerifyCommand[];
}

export interface VerifyCommand {
  cmd: string;
  expect_exit?: number;
  scope?: string;
  timeout?: number;
}

/** index.md frontmatter schema */
export interface PlanFrontmatter {
  plan_id: string;
  title: string;
  status?: string;
  created_at?: string;
  project_path: string;
  default_assignee?: Assignee;
  default_priority?: number;
  phases?: PhaseDef[];
  global_constraints?: string[];
  /** 该 plan 的 PM consumer 标识（被动轮询提醒按此路由）；不声明时回退默认值 */
  pm_consumer?: string;
}

export interface PhaseDef {
  id: string;
  name: string;
  description?: string;
  depends_on?: string[];
}

/** Question 状态（Worker 向 PM 提问的真实持久化实体） */
export type QuestionStatus = 'open' | 'answered' | 'cancelled';

export interface OwnershipScope {
  files: string[];
  modules: string[];
}

export type OwnershipDecision = 'approved' | 'rejected';

/** Worker 创建 Question 的请求（POST /question） */
export interface QuestionCreateRequest {
  task_id: string;
  agent_id: string;
  /** 当前 running lease 的 claim token；没有它不能代表该 Worker 提问。 */
  claim_token: string;
  /** 提问正文（Worker 想问 PM 的问题） */
  body: string;
  /** 可恢复 checkpoint/context：回答后重领时附带的上下文（如已完成的步骤、临时状态） */
  checkpoint?: string;
  /** Worker 发现合法工作需要超出原任务范围时，向 PM 请求的结构化范围；不能自行生效。 */
  requested_ownership?: Partial<OwnershipScope>;
}

/** PM 回答 Question 的请求（POST /question/:id/answer） */
export interface QuestionAnswerRequest {
  question_id: string;
  /** 回答的 consumer（必须等于该 Question 绑定的 plan 的 pm_consumer） */
  consumer: string;
  plan_id?: string;
  answer: string;
  /** requested_ownership 存在时必须由 PM 显式批准或拒绝。 */
  ownership_decision?: OwnershipDecision;
}

/** 持久化的 Question 记录 */
export interface QuestionRecord {
  question_id: string;
  task_id: string;
  plan_id: string;
  agent_id: string;
  pm_consumer: string;
  asked_event_id: string;
  body: string;
  checkpoint: string;
  status: QuestionStatus;
  created_at: number;
  answered_at?: number;
  answered_by?: string;
  answer?: string;
  requested_ownership?: OwnershipScope;
  ownership_decision?: OwnershipDecision;
  ownership_before?: OwnershipScope;
  ownership_after?: OwnershipScope;
}

/**
 * Question 列表的最小门铃元数据。
 * 正文、checkpoint 与 PM answer 只能经 GET /question/:question_id 按 consumer 二次读取，
 * 避免列表、看板和默认 JSON 输出意外携带决策内容。
 */
export interface QuestionSummary {
  question_id: string;
  task_id: string;
  plan_id: string;
  agent_id: string;
  pm_consumer: string;
  status: QuestionStatus;
  created_at: number;
  answered_at?: number;
  answered_by?: string;
}

/** Redis hash:task:{id} 的运行时结构 */
export interface TaskRecord extends TaskFrontmatter {
  plan_id: string;
  status: TaskStatus;
  goal_md: string;
  project_path: string;
  retries: number;
  created_at: number;
  claimed_at?: number;
  claimed_by?: string;
  done_at?: number;
  expire_at?: number;
  result_path?: string;
  result_json_path?: string;
  /** Worker failed/partial 或超时失败的最小原因摘要（不复制完整日志）。 */
  failure_reason?: string;
  /** 当前受控阻塞原因；PM Question 使用独立 Question 实体。 */
  block_reason?: string;
  blocked_at?: number;
  /** 撤销时间与原因属于不可变审计；读取接口必须与 Redis/SQLite 真相一致。 */
  cancelled_at?: number;
  cancel_reason?: string;
  /** 修复任务指向的原始任务；保留原任务失败/拒绝审计，不改写历史。 */
  fix_for?: string;
  /** 一条自动修复链的根任务，用于限制重试并把最终验收回传给源任务。 */
  repair_root_task_id?: string;
  /** 生成 reverify 时绑定的最新不可变 review/failed attempt，禁止误读更早拒绝。 */
  trigger_review_task_id?: string;
  /** 失败、拒绝或验收失败后的可审计闭环状态。 */
  resolution_status?: ResolutionStatus;
  resolution_action?: ResolutionAction;
  resolution_task_id?: string;
  resolution_task_ids?: string[];
  resolved_by_task?: string;
  resolution_generation?: number;
  resolution_attempts?: number;
  /** 自动恢复无法安全继续时供 PM 查看的一行稳定原因码。 */
  resolution_decision_reason?: string;
  pm_review_status?: 'accepted' | 'rejected';
  pm_reviewed_by?: string;
  pm_reviewed_at?: number;
  pm_review_comment?: string;
  pm_reject_reason?: string;
  pm_fix_instructions?: string;
  /** PM 拒绝 acceptance 时选择的不可变处置模式；缺失的历史记录按 repair 解释。 */
  pm_rejection_resolution_mode?: 'repair' | 'reverify';
  /** 历史伪完成被显式退出验收后的不可变审计；原 result/review 字段不改写。 */
  superseded_at?: number;
  superseded_by?: string;
  superseded_reason?: string;
  /** Plan 批量 supersede 的精确快照令牌；单任务 supersede 为空。 */
  supersede_preview_token?: string;
  /** 同一批次的任务数，用于重试时检测标记缺失并 fail closed。 */
  supersede_batch_size?: number;
  /** PM reject 时仅写在 repair 上的额外 ownership 授权审计。 */
  repair_ownership_extension?: RepairOwnershipExtension;
  /** reject 审计是否包含显式 repair ownership；用于识别 intent 缺失/损坏而 fail closed。 */
  pm_repair_ownership_required?: boolean;
  /** reject 写入与 repair 创建之间崩溃时，用于确定性重放的规范化 ownership 扩展。 */
  pm_repair_ownership_intent?: RepairOwnershipExtension;
  claim_token?: string;
}

/**
 * PM 在拒绝交付时可为新 repair 显式增加的最小所有权范围。
 * 它只能扩展 repair，不能改写来源任务的 ownership。
 */
export interface RepairOwnershipExtension {
  files?: string[];
  modules?: string[];
}

/** Redis hash:file_ownership field 的 value */
export interface OwnershipRecord {
  agent_id: string;
  task_id: string;
  priority: number;
  declared_at: number;
  expires_at: number;
  base_commit_sha?: string;
  mode?: 'exclusive-write' | 'shared-read';
}

/** POST /claim 请求 */
export interface ClaimRequest {
  agent_id: string;
  /** register 返回的 Agent 生命周期 fencing token。 */
  registration_id?: string;
  /** 一次 claim 调用的幂等 ID；传输重试必须复用。 */
  claim_request_id?: string;
  blocking?: boolean;
  timeout_ms?: number;
  preferred_types?: TaskType[];
  preferred_phases?: string[];
  /** 按项目路径过滤（agent 只领该项目的任务）；不传 = 不过滤 */
  preferred_project?: string;
  /** 按 plan 过滤；不传 = 不过滤。用于同一 project 下 Supervisor 的受管计划隔离。 */
  preferred_plan_ids?: string[];
}

/** POST /claim 响应里的 task */
export interface ClaimedTask {
  task_id: string;
  title: string;
  type: TaskType;
  phase: string;
  priority: number;
  ownership_files: string[];
  ownership_modules?: string[];
  goal_md: string;
  timeout_seconds: number;
  claim_token: string;
  verify: VerifyCommand[];
  project_path: string;
  plan_id: string;
  /** 任务显式模型；repair/reverify 从来源继承，执行器必须优先于 slot 默认值使用。 */
  model_override?: string;
  /** 若该任务是因 Question 被回答而回到 pending，附带的回答上下文（PM 的答复） */
  question_answer?: string;
  question_id?: string;
  question_checkpoint?: string;
}

/** POST /report 请求 */
export interface ReportRequest {
  task_id: string;
  agent_id: string;
  claim_token: string;
  status: 'done' | 'failed' | 'partial';
  result_path?: string;
  result_json_path?: string;
  verify_results?: VerifyResult[];
  /** 远程 Worker 无服务端文件系统访问时，直接携带产物正文，由中央受控落盘。 */
  result_md?: string;
  result_json?: string;
  /** 由中央在任务工作区代执行声明的 verify 并记录真实退出码；verify 命令本身仍不外泄。 */
  execute_verify?: boolean;
}

export interface VerifyResult {
  cmd: string;
  exit_code: number;
  passed: boolean;
  output?: string;
}

/** GET /ownership 响应 */
export interface OwnershipCheckResult {
  path: string;
  occupied: boolean;
  owner?: OwnershipRecord;
  your_priority?: number;
  action: 'proceed' | 'preempt' | 'wait';
}

/** 统一 API 响应 */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string; details?: unknown };
}

/** Biao 配置 */
export interface BiaoConfig {
  port: number;
  host: string;
  redisUrl: string;
  authEnabled: boolean;
  apiToken?: string;
  workspaceRoots: string[];
  sqlitePath: string;
  streamMaxlen: number;
  conflictRetention: number;
}
