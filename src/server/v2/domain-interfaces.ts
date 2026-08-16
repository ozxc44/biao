/**
 * V2 领域服务接口层（Phase 0a-2 · 评审项 R1B-001）
 *
 * 依据 docs/distributed-multi-node-development-plan.md（v0.8.0-round7-revision）：
 * - §21 Phase 0a-2：先固定七个领域服务的边界，旧 service.ts 只作 facade；
 * - §13.1 身份分层：Human Owner / Planner / Reviewer·PM / Recovery Reviewer /
 *   Node / Task Attempt / Merge Bot，V1 的全局 Owner/Worker token 不进入 V2 写面；
 * - §14.5 durable-first 提交协议：mutation 带 idempotency key → SQLite 事务
 *   （业务实体 + outbox event + revision）→ 事务提交后才发布 Redis 投影；
 * - §15.6 API 通用要求：mutation 幂等、实体返回 generation/revision、错误码稳定、
 *   cursor 分页、correlation ID 贯穿请求与事件；
 * - §24 关键设计决策：D-002/D-026（project_id 身份）、D-004（每 Attempt 隔离
 *   workspace）、D-005（Artifact 引用替代路径）、D-006（Task/Attempt/Delivery/Merge
 *   分层）、D-007（Merge Bot 单写）、D-025（durable-first + outbox）。
 *
 * 本文件只定义接口与类型，不搬实现（实现按 SERVICE_MAP.md 台账在后续 Phase 分批
 * 迁入 src/server/services/*）。每个方法注明 V1 对照函数与 V2 语义差异，作为
 * Phase 1+ 搬迁与 API schema 生成的契约源。
 */

import type {
  ApiResponse,
  ClaimedTask,
  ProjectAgentBinding,
  ProjectAgentRosterItem,
  QuestionRecord,
  QuestionSummary,
  ReportRequest,
} from '../../types/index.js';

/**
 * 任务读视图。V1 对照：service.ts 的 TaskListItem（getTasks/getPendingReviewTasks
 * 返回结构）；此处按 V2 读面重新声明（project_id 身份 + revision），避免 V2 接口层
 * 反向依赖 V1 facade。
 */
export interface V2TaskView {
  task_id: string;
  plan_id: string;
  project_id: string;
  title: string;
  status: string;
  revision: number;
}

/* ------------------------------------------------------------------ */
/* 共享 V2 原语（§14.5 / §15.6）                                       */
/* ------------------------------------------------------------------ */

/**
 * 幂等键：客户端 mutation 必带；同一 key 重放返回原实体（§14.5 第 1/5 条）。
 * V1 仅 claim 有 claim_request_id，V2 扩展到全部写接口。
 */
export type V2IdempotencyKey = string;

/** 请求与事件贯穿的关联 ID（§15.6）；V1 没有等价物。 */
export type V2CorrelationId = string;

/** §13.1 身份分层中的 V2 凭据种类；V1 owner/worker/mcp token 不在其中。 */
export type V2ActorKind =
  | 'human_owner'
  | 'planner'
  | 'reviewer_pm'
  | 'recovery_reviewer'
  | 'auditor'
  | 'node'
  | 'task_attempt'
  | 'merge_bot';

/** 已认证 actor 的最小身份上下文；服务端不得信任请求体中的身份字段。 */
export interface V2ActorContext {
  actor_kind: V2ActorKind;
  /** human 用户名 / node_id / attempt_id / merge bot 标识。 */
  actor_id: string;
  /** 项目内操作时必填；跨项目请求在网关层即拒绝（§13.2 跨项目读取）。 */
  project_id?: string;
  /**
   * Node/Attempt 凭据的 fencing generation：node_session_generation 或
   * attempt_generation。旧 generation 的一切写请求直接拒绝（Phase 1 验收：
   * 旧 agent generation 不能覆盖新节点 session）。
   */
  generation?: number;
}

/** 所有 V2 mutation 的公共参数；读接口只需 actor + correlation_id。 */
export interface V2RequestMeta {
  idempotency_key: V2IdempotencyKey;
  correlation_id: V2CorrelationId;
}

/** 稳定 cursor 分页入参（§15.6：不按本机时间猜顺序）。 */
export interface V2PageRequest {
  cursor?: string;
  limit?: number;
}

/** 稳定 cursor 分页出参。 */
export interface V2Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** 实体 revision/generation 回执：所有 V2 实体响应必须携带（§15.6）。 */
export interface V2RevisionEnvelope {
  revision: number;
  updated_at: number;
}

/* ------------------------------------------------------------------ */
/* ProjectService：Project / Binding / Plan 导入（§15.1 / §27）        */
/* ------------------------------------------------------------------ */

/** Project 注册入参：repo 以 POSIX 规范路径 + 显式 legacy binding 声明身份（D-017/D-026）。 */
export interface V2ProjectCreateInput {
  name: string;
  repo_path: string;
  default_branch: string;
  /** 显式映射到既有 V1 project_scope 的 legacy binding；不存在则由 V1 基线迁移产生。 */
  legacy_project_scope?: string;
  execution_mode: 'full' | 'read_only';
}

export interface V2Project
  extends V2ProjectCreateInput,
    V2RevisionEnvelope {
  project_id: string;
  status: 'active' | 'degraded' | 'read_only' | 'archived';
}

/** ProjectModeTransition 是可恢复、幂等的 durable 状态机（D-043/D-046）。 */
export interface V2ProjectModeTransition {
  transition_id: string;
  project_id: string;
  from_mode: 'full' | 'read_only';
  to_mode: 'full' | 'read_only';
  /** durable step 枚举 + deadline；控制面重启后从记录的 step 恢复。 */
  steps: Array<{ step: string; status: 'pending' | 'done' | 'failed'; updated_at: number }>;
  deadline_at: number;
  status: 'running' | 'completed' | 'expired' | 'rolled_back';
}

/**
 * 项目与项目绑定（V1 的 ProjectAgentBinding ≈ V2 的 NodeProjectBinding §4.3）。
 * 绑定必须由控制面显式授权，Node 不能自行声明（D-031）。
 */
export interface ProjectService {
  /** V1 对照：无（Phase 1 新增 Project Registry）。 */
  createProject(
    input: V2ProjectCreateInput,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Project>>;

  /** V1 对照：getPlans/getStatus 中的项目投影。V2：按 project_id 列出注册项目。 */
  listProjects(
    page: V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2Project>>>;

  /** V1 对照：getPlan。 */
  getProject(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Project | null>>;

  /** V1 对照：previewPlanSubmission（路径校验部分）。V2：注册前的 repo/分支可接入性校验。 */
  validateProject(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ repo_reachable: boolean; ref_acl_available: boolean }>>;

  /** V1 对照：无（策略散落在 env/workspaceRoots 配置）。V2：项目策略成为
   * Project 实体的可审计字段（写命令策略、acceptance 级别等）。 */
  updatePolicy(
    projectId: string,
    input: { policy: Record<string, unknown>; reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Project>>;

  /**
   * V1 对照：无。V2：full ↔ read-only 双向模式切换（D-040：pause/drain/reconcile
   * 后原子切换；D-042：ref ACL 确认丢失时先熔断再决策）。
   */
  applyModeTransition(
    projectId: string,
    input: { to_mode: 'full' | 'read_only'; reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2ProjectModeTransition>>;

  getModeTransition(
    projectId: string,
    transitionId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2ProjectModeTransition | null>>;

  /**
   * V1 对照：planSubmit（服务端读本地 plan_dir）。V2：上传 Plan Snapshot
   * （D-014），durable-first 落 Plan/Task 实体 + outbox，返回 plan revision。
   */
  importPlan(
    projectId: string,
    input: { snapshot: unknown },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ plan_id: string; task_count: number; revision: number }>>;

  /** V1 对照：getPlan(redis, planId)。V2：plan 读面按 project 鉴权。 */
  getPlan(
    planId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  /** V1 对照：previewPlanSupersede/supersedePlan。V2：preview token CAS 语义保留。 */
  previewPlanSupersede(
    planId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ preview_token: string; superseded_task_ids: string[] }>>;

  supersedePlan(
    planId: string,
    input: { reason: string; superseded_by: string; confirmed: true; preview_token: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ plan_id: string; superseded_task_ids: string[] }>>;

  /* ---- 绑定面（V1 对照：service.ts 的 project agent binding 族） ---- */

  /** V1 对照：createProjectAgentBinding(projectScope, input)。V2 差异：入参用
   * project_id 而非路径；绑定授权 revision 由控制面维护，Node 侧不可写。 */
  createBinding(
    projectId: string,
    input: import('../../types/index.js').ProjectAgentBindingCreateRequest,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<ProjectAgentBinding>>;

  /** V1 对照：getProjectAgentBinding。 */
  getBinding(
    projectId: string,
    bindingId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<ProjectAgentBinding | null>>;

  /** V1 对照：listProjectAgentBindings。 */
  listBindings(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<ProjectAgentBinding[]>>;

  /** V1 对照：deleteProjectAgentBinding。 */
  deleteBinding(
    projectId: string,
    bindingId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ binding_id: string; deleted: boolean }>>;

  /** V1 对照：connectProjectAgent。V2：节点加入项目必须校验 NodeProjectBinding。 */
  connectAgent(
    projectId: string,
    agentId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<ProjectAgentBinding>>;

  /** V1 对照：getProjectAgentRoster。 */
  getRoster(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<ProjectAgentRosterItem[]>>;

  /** V1 对照：reserveProjectAgentTask。V2：预留同样走 durable-first。 */
  reserveTask(
    projectId: string,
    input: { binding_id: string; task_id?: string; preferred_plan_ids?: string[] },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ reservation_id: string } | null>>;
}

/* ------------------------------------------------------------------ */
/* NodeService：Node 注册/心跳/生命周期 + 执行回执（§15.2 / §10）      */
/* ------------------------------------------------------------------ */

export interface V2NodeCreateInput {
  node_id: string;
  labels?: string[];
  slots: number;
  /** 声明接入的 project 列表；实际授权以 NodeProjectBinding 为准（D-031）。 */
  requested_project_ids: string[];
}

export interface V2Node extends V2RevisionEnvelope {
  node_id: string;
  status: 'online' | 'degraded' | 'draining' | 'offline' | 'quarantined';
  /** 节点凭据 generation：enroll/re-enroll 递增，旧 generation 立即 fencing（D-037）。 */
  credential_generation: number;
  slots: number;
  last_heartbeat_at: number;
}

export interface V2NodeHeartbeatInput {
  protocol_version: number;
  clock_skew_ms: number;
  disk_free_gib: number;
  disk_free_percent: number;
  slots_in_use: number;
  /** 控制面签名公钥/trust-anchor generation 的回报（§13.3/§13.4）。 */
  trust_anchor_generation?: number;
}

/**
 * 节点生命周期与运行证据。V1 的 agentRegister/agentHeartbeat/agentOffline 以
 * agent_id + registration_id 表达，V2 升级为 node_id + credential_generation，
 * 且 quarantine 等同安全撤权并立即 fencing（D-037），drain 支持升级编排（D-024）。
 */
export interface NodeService {
  /** V1 对照：agentRegister。V2 差异： enroll 阶段只换 enrollment ticket，register
   * 阶段才发节点凭据；不再共用全局 Worker token（Phase 1 硬门禁）。 */
  enroll(
    input: { enrollment_ticket: string; node_id: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ node_credential: string; credential_generation: number }>>;

  register(
    input: V2NodeCreateInput,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Node>>;

  /** V1 对照：agentHeartbeat。V2 差异：心跳承载 §10.3 全量内容 + trust anchor 回报；
   * 时钟偏差/磁盘水位越限在服务端转 degraded/quarantine。 */
  heartbeat(
    nodeId: string,
    input: V2NodeHeartbeatInput,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ status: V2Node['status']; config_revision: number }>>;

  /** V1 对照：无。V2：drain 后不再派新任务，等待活跃 Attempt 收口再升级。 */
  drain(
    nodeId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Node>>;

  /** V1 对照：agentOffline。V2：保留审计，清除在线投影；幂等。 */
  offline(
    nodeId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ node_id: string; offline: boolean }>>;

  /** V1 对照：无。V2：撤销即 fencing 全部 session/Attempt token（D-037）。 */
  revoke(
    nodeId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ node_id: string; revoked: boolean }>>;

  /** V1 对照：无。V2：Node→Project 显式授权（§15.2）。 */
  authorizeProject(
    nodeId: string,
    projectId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<ProjectAgentBinding>>;

  revokeProjectAuthorization(
    nodeId: string,
    projectId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ revoked: boolean }>>;

  /** V1 对照：无（getProjectAgentRoster 是项目视角）。V2：节点视角的全量清单。 */
  listNodes(
    page: V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2Node>>>;

  /* ---- 执行回执面（V1 对照：appendExecutionReceipt/listExecutionReceipts） ---- */

  /**
   * V1 对照：appendExecutionReceipt(projectScope, input, redis?)。V2 差异：
   * durable-first 落库 + outbox；回执归属 node_session_generation，旧 session
   * 的回执被 fencing。
   */
  appendExecutionReceipt(
    projectId: string,
    input: import('../../types/index.js').ExecutionReceiptCreateRequest,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<import('../../types/index.js').PublicExecutionReceipt>>;

  /** V1 对照：listExecutionReceipts。 */
  listExecutionReceipts(
    projectId: string,
    options: { binding_id?: string; task_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<import('../../types/index.js').PublicExecutionReceipt>>>;
}

/* ------------------------------------------------------------------ */
/* AttemptService：claim / lease / Question / 任务生命周期（§15.3）    */
/* ------------------------------------------------------------------ */

/** V2 claim 结果：attempt 分层（D-006）+ 短期 Attempt Token（§13.5）。 */
export interface V2AttemptClaimResult extends ClaimedTask {
  attempt_id: string;
  /** fencing 计数：attempt_id = task_id + attempt_generation（§14.5 确定性键）。 */
  attempt_generation: number;
  /** scope 固定为 attempt_id+task_id+project_id+attempt_generation+allowed mutations，
   * 期限短于 lease 最大值；新 generation 产生后立即失效。 */
  attempt_token: string;
  project_id: string;
  workspace_ref: string;
}

/**
 * 任务执行域。V1 的 claim/report/renewLease/Question/block/resume/ownership 族
 * 归入本服务；V2 核心差异是 Attempt 与 Task 分离（§5.1）+ attempt_generation
 * fencing：renew/question/artifact/delivery 全部同时校验 attempt_id、
 * attempt_generation、node_session_generation 与 token scope（§13.5）。
 */
export interface AttemptService {
  /**
   * V1 对照：claim(redis, req, signal)。V2 差异：
   * - 活跃 Attempt 不被盲目 preempt（D-012）；
   * - 成功后签发短期 Attempt Token 而不是长期 claim_token；
   * - durable-first：Attempt 实体 + outbox 先落库，再发布 Redis 运行态投影。
   */
  claimTask(
    projectId: string,
    input: import('../../types/index.js').ClaimRequest,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2AttemptClaimResult | null>>;

  /**
   * V1 对照：renewLease。V2 差异：attempt_generation 不匹配即拒绝；租约风险
   * 截止前由 Node 停止 Agent（D-013），而不是仅打印续期错误。
   */
  renewLease(
    attemptId: string,
    input: { extend_seconds?: number },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ attempt_id: string; new_expire_at: number }>>;

  /**
   * V1 对照：report。V2 差异：产出以 Artifact 引用替代 result_path（D-005）；
   * report 只收口 Attempt，交付质量由 Delivery/验收链判定（D-006）。
   */
  reportAttempt(
    attemptId: string,
    input: Omit<ReportRequest, 'result_path' | 'result_json_path'> & {
      artifact_refs?: Array<{ artifact_id: string; sha256: string }>;
    },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ attempt_id: string; status: string }>>;

  /* ---- Question 面（§27：Question 属 Attempt） ---- */

  /** V1 对照：createQuestion。V2 差异：claim_token 校验升级为 Attempt Token scope。 */
  askQuestion(
    attemptId: string,
    input: import('../../types/index.js').QuestionCreateRequest,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ question_id: string; asked_event_id: string }>>;

  /** V1 对照：listQuestions。 */
  listQuestions(
    projectId: string,
    options: { consumer?: string; status?: string; plan_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<QuestionSummary>>>;

  /** V1 对照：getQuestion（HTTP 面强制 consumer 归属）。 */
  getQuestion(
    questionId: string,
    options: { consumer: string; plan_id?: string },
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<QuestionRecord | null>>;

  /** V1 对照：answerQuestion。V2 差异：回答触发重领时签发新 Attempt Token。 */
  answerQuestion(
    questionId: string,
    input: import('../../types/index.js').QuestionAnswerRequest,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ question_id: string; status: string; new_attempt_token?: string }>>;

  /* ---- 任务生命周期读/写面 ---- */

  /** V1 对照：getTask/getTasks/getPendingReviewTasks。 */
  getTask(
    taskId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2TaskView | null>>;

  listTasks(
    projectId: string,
    options: { plan_id?: string; status?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2TaskView>>>;

  /** V1 对照：supersedeTask（历史伪完成退出验收）。V2：durable 状态机事件。 */
  supersedeTask(
    taskId: string,
    input: { reason: string; superseded_by: string; confirmed: true },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ task_id: string; status: string }>>;

  /** V1 对照：cancelTask。 */
  cancelTask(
    taskId: string,
    input: { reason?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ task_id: string; status: string }>>;

  /** V1 对照：taskBlock/taskResume（仅 lease holder 可搁置/受控恢复）。 */
  blockTask(
    taskId: string,
    input: { claim_token: string; reason: 'waiting_file_release' | 'waiting_dependency'; question_id?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ task_id: string; blocked: boolean }>>;

  resumeTask(
    taskId: string,
    input: { agent_id: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ task_id: string; lease_remaining: number }>>;

  /* ---- Ownership 面（V2 按 project 命名空间，D-011） ---- */

  /** V1 对照：ownershipDeclare/ownershipRelease/ownershipCheck。V2 差异：
   * ownership key 以 project_id 为命名空间；活跃 Attempt 不被抢占（D-012），
   * 并保留 Git diff 二次门禁（§7.3）。 */
  declareOwnership(
    attemptId: string,
    input: { files: string[]; force?: boolean },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  releaseOwnership(
    attemptId: string,
    input: { files: string[] },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  checkOwnership(
    projectId: string,
    input: { path: string; agent_id: string },
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<import('../../types/index.js').OwnershipCheckResult>>;
}

/* ------------------------------------------------------------------ */
/* DeliveryService：Artifact / Delivery / Review / repair / reverify   */
/*                     （§15.4 / §15.5 / §27）                         */
/* ------------------------------------------------------------------ */

export interface V2ArtifactRecord extends V2RevisionEnvelope {
  artifact_id: string;
  attempt_id: string;
  kind: string;
  sha256: string;
  size_bytes: number;
  status: 'uploading' | 'complete' | 'rejected';
}

/** Delivery 绑定 Git head；force-push 后 accept 失效（§13.2/D-028）。 */
export interface V2Delivery extends V2RevisionEnvelope {
  delivery_id: string;
  attempt_id: string;
  branch: string;
  head_sha: string;
  artifact_refs: Array<{ artifact_id: string; sha256: string }>;
  status: 'open' | 'review_pending' | 'accepted' | 'rejected' | 'invalidated';
}

/** Artifact-only 完成使用独立 EvidenceAcceptance durable record（D-041）。 */
export interface V2EvidenceAcceptance extends V2RevisionEnvelope {
  acceptance_id: string;
  attempt_id: string;
  commit_sha: string;
  level: 'node' | 'node_harness' | 'pm';
}

/**
 * 交付与验收域（§27：Review/repair 属 Delivery）。V1 的 pmReview/
 * getReviewInfo/resolutionDecision/taskReset 族归入本服务；V2 差异：
 * - Artifact 上传协议三段式 initiate/upload/complete，complete 复算 digest
 *   （§14.5 第 6 条）；
 * - delivery_id 由 (attempt_id, head_sha) 唯一约束重放（§14.5 确定性键）；
 * - 分布式写任务默认独立节点验收（D-027），Reviewer 从 Remote/Artifact 重算证据。
 */
export interface DeliveryService {
  /* ---- Artifact 面（§15.4） ---- */

  initiateArtifact(
    attemptId: string,
    input: { kind: string; size_bytes: number; sha256: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ artifact_id: string; upload_url: string }>>;

  /** PUT content 上传到临时键；complete 在同一 durable transaction 中发布记录。 */
  uploadArtifactContent(
    artifactId: string,
    chunk: AsyncIterable<Buffer>,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ received_bytes: number }>>;

  completeArtifact(
    artifactId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2ArtifactRecord>>;

  getArtifact(
    artifactId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2ArtifactRecord | null>>;

  /* ---- Delivery 面（§15.5） ---- */

  /** 首次 complete 生成 delivery_id，(attempt_id, head_sha) 唯一。 */
  createDelivery(
    attemptId: string,
    input: { branch: string; head_sha: string; artifact_refs: Array<{ artifact_id: string; sha256: string }> },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Delivery>>;

  getDelivery(
    deliveryId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Delivery | null>>;

  /** V1 对照：pmReview。V2 差异：review 落在 Delivery 上；reject 生成 repair
   * Delivery/Attempt 而不是原地改 task.status（D-006/D-008：repair/reverify
   * 语义保留）；Reviewer 重算关键证据而不是信任自报 Verify（D-027）。 */
  reviewDelivery(
    deliveryId: string,
    input: {
      verdict: 'accept' | 'reject';
      comment?: string;
      reject_reason?: string;
      fix_instructions?: string;
      repair_ownership?: { files?: string[]; modules?: string[] };
      resolution_mode?: 'repair' | 'reverify';
      reviewed_by: string;
    },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ delivery_id: string; review_status: string; fix_task_ids?: string[] }>>;

  /* ---- Git Workspace 面（Phase 4，§6.4/§6.5/§7.3） ---- */

  /** §6.4 Workspace Prepare 状态机（pending→…→ready，幂等可重入）。 */
  prepareWorkspace(
    attemptId: string,
    input: { attempt_token?: string; base_sha?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{
    attempt_id: string;
    prepare_state: string;
    workspace_dir: string;
    branch_ref: string;
    marker_ref: string;
    base_sha: string;
  }>>;

  /** §6.5 Workspace Finalize：commit_and_push + CAS + 服务端复核 + delivery。 */
  finalizeWorkspace(
    attemptId: string,
    input: { artifact_refs?: Array<{ artifact_id: string }>; author?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{
    attempt_id: string;
    finalize_state: string;
    delivery_id: string;
    head_sha: string;
    branch_ref: string;
    changed_files: string[];
    server_verified: boolean;
    status: string;
  }>>;

  /** 工作区状态读面（prepare/finalize 状态机诊断）。 */
  getWorkspace(
    attemptId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{
    attempt_id: string;
    prepare_state: string;
    finalize_state: string;
    branch_ref: string;
    marker_ref: string;
    base_sha: string;
    head_sha: string;
    delivery_id: string;
    prepare_error: string;
    finalize_error: string;
  } | null>>;

  /** §6.6/§21 中断恢复扫描：过期 attempt 的中断工作区 → orphan candidate。 */
  scanWorkspaceRecovery(
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ scanned: number; candidates: number }>>;

  /** §7.3 服务端独立复核（可对任意 delivery 重跑；不一致 → invalidated/rejected）。 */
  verifyDeliveryRemote(
    deliveryId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ verified: boolean; reason?: string }>>;

  /** §4.5 pending_review → reviewing。 */
  startDeliveryReview(
    deliveryId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ delivery_id: string; status: string }>>;

  /** §21 Artifact 中断收敛：pending_recovery → pending_review。 */
  recoverDeliveryArtifacts(
    deliveryId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ delivery_id: string; status: string; artifacts_complete: boolean }>>;

  /** §4.4.2/§6.6 BranchCleanup 到期执行（删除前复核远端 HEAD）。 */
  runBranchCleanups(
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ processed: number; deleted: number; already_missing: number; failed: number }>>;

  /* ---- Evidence acceptance 面（D-041） ---- */

  createEvidenceAcceptance(
    attemptId: string,
    input: { commit_sha: string; level: 'node' | 'node_harness' | 'pm' },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2EvidenceAcceptance>>;

  reviewEvidenceAcceptance(
    acceptanceId: string,
    input: { verdict: 'accept' | 'reject'; reviewed_by: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2EvidenceAcceptance>>;

  /* ---- repair/reverify 收口面（V1 对照：getReviewInfo/
   *      getResolutionDecision/resolutionDecision/taskReset） ---- */

  /** V1 对照：getReviewInfo。V2：证据来自 Artifact/Remote 重算结果。 */
  getReviewEvidence(
    taskId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  /** V1 对照：getResolutionDecision/resolutionDecision。V2：重试耗尽后的 PM
   * 决策同样走 durable 状态机事件，inspect/continue/cancel 语义保留。 */
  getResolutionDecision(
    taskId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  decideResolution(
    taskId: string,
    input: { action: 'inspect' | 'continue' | 'cancel'; decided_by: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** V1 对照：taskReset。V2：作为 repair 域原语保留（PM 手动重置到 pending）。 */
  resetTask(
    taskId: string,
    input: { force?: boolean; reset_by?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ task_id: string; from_status: string; to_status: string }>>;
}

/* ------------------------------------------------------------------ */
/* MergeService：Merge Queue / external intent（§12 / §15.5）          */
/* ------------------------------------------------------------------ */

export interface V2MergeJob extends V2RevisionEnvelope {
  merge_job_id: string;
  delivery_id: string;
  project_id: string;
  expected_target_sha: string;
  source_sha: string;
  final_sha: string | null;
  status: 'queued' | 'integrating' | 'merged' | 'conflict' | 'integration_failed' | 'cancelled';
}

/** 控制面之外发起的外部合并意图（人工/工具 push 后的 reconcile 入口）。 */
export interface V2ExternalMergeIntent extends V2RevisionEnvelope {
  intent_id: string;
  project_id: string;
  ref: string;
  before_sha: string;
  after_sha: string;
  status: 'pending' | 'reconciled' | 'rejected';
}

/**
 * 合并队列域（V1 无对应实现，为 V2 新增）。硬边界（§12.1）：
 * - Merge Bot 单写默认分支（D-007），Worker/Attempt 凭据不得触发合并；
 * - MergeJob 以 delivery_id + expected_target_sha 唯一（§14.5 第 7 条），
 *   Git 原子推送后 DB 写回失败由 reconcile 按 expected/source/final SHA 恢复；
 * - merged 才解锁普通下游（D-023）；
 * - 同时校验 branch HEAD 与 target CAS（D-028）。
 */
export interface MergeService {
  createMergeJob(
    projectId: string,
    input: { delivery_id: string; expected_target_sha: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2MergeJob>>;

  getMergeJob(
    mergeJobId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2MergeJob | null>>;

  cancelMergeJob(
    mergeJobId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2MergeJob>>;

  createExternalIntent(
    projectId: string,
    input: { ref: string; before_sha: string; after_sha: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2ExternalMergeIntent>>;

  /** 外部意图 reconcile：确认默认分支外的写是否合法，产出审计与 Incident 关联。 */
  reconcileExternalIntent(
    intentId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2ExternalMergeIntent>>;

  /** 列出项目的合并队列（§15.5）。 */
  listMergeJobs(
    projectId: string,
    options: { status?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2MergeJob>>>;

  /** integration_failed 重试（= 新 job）。 */
  retryMergeJob(
    mergeJobId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2MergeJob>>;

  /**
   * 触发队列 dispatch：取队头执行（§12.2 串行队列）。
   * Phase 8 补齐 HTTP 接线（E2E/运维触发点），实现见 merge-service。
   */
  dispatchMergeJob(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2MergeJob | null>>;

  /** 恢复写能力（降级后人工恢复）。 */
  restoreWriteCapability(
    projectId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ restored: boolean }>>;
}

/* ------------------------------------------------------------------ */
/* IncidentService：Incident / SLO（§4.8 / §15.5）                     */
/* ------------------------------------------------------------------ */

export interface V2Incident extends V2RevisionEnvelope {
  incident_id: string;
  project_id: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acked' | 'resolved';
  /** SLO 计时：ack/resolve 截止与实际时间（D-033：Incident 是持久领域实体）。 */
  opened_at: number;
  ack_due_at: number | null;
  acked_at: number | null;
  resolved_at: number | null;
  related_entity: { type: string; id: string } | null;
}

/**
 * 事故域（V1 无对应实现；watchdog 的 problems 汇总是其只读前身）。Incident
 * 承担 ack/SLO/解除审计（D-033），不能退化为页面横幅或日志行。
 */
export interface IncidentService {
  /** V1 对照：runWatchdog 只读路径（problems 汇总）。V2：巡检发现的问题
   * 落 Incident 实体而不是一次性响应。 */
  listIncidents(
    options: { status?: 'open' | 'acked' | 'resolved'; project_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2Incident>>>;

  ackIncident(
    incidentId: string,
    input: { acked_by: string; note?: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Incident>>;

  /** 解除必须附带证据引用（恢复动作、reconcile 结果或 canary 验证）。 */
  resolveIncident(
    incidentId: string,
    input: { resolved_by: string; evidence: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2Incident>>;
}

/* ------------------------------------------------------------------ */
/* ReconcileService：outbox / restore / orphan / ownership / 投影读面   */
/*                     （§14.5 / §14.6 / §15.5 / §4.4.1）              */
/* ------------------------------------------------------------------ */

export interface V2OutboxDeadLetter {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  revision: number;
  payload_digest: string;
  attempts: number;
  last_error: string | null;
  related_incident_id: string | null;
  status: 'pending' | 'dead_letter';
}

/** 三方 reconcile（DB、Git、Artifact）的孤儿/残留恢复裁决（D-022/D-047~D-052）。 */
export interface V2RecoveryCandidate {
  candidate_id: string;
  kind: 'orphan_attempt' | 'residual_branch' | 'residual_artifact' | 'lost_merge_writeback';
  status: 'pending' | 'decided' | 'taken_over';
  resolution_digest: string;
  decided_by: string | null;
}

/**
 * 对账与恢复域。V1 的 reconcileRuntimeState/runWatchdog/dbRestore*、事件与
 * intake 投影读面归入本服务；V2 差异：
 * - outbox dispatcher（owner lease、per-row backoff、dead-letter、指标）为
 *   新增核心（D-025）；
 * - dead-letter 只有受审计 requeue 或 compensating event，没有 skip/
 *   mark-delivered（D-045）；
 * - restore 以 restore point 水印编排（D-029/§14.6），恢复期间维护屏障语义
 *   与 V1 maintenance gate 一致；
 * - 孤儿恢复不继承原 Node 的 Verify 信任（D-032）。
 */
export interface ReconcileService {
  /* ---- outbox 面 ---- */

  listDeadLetters(
    options: V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<V2OutboxDeadLetter>>>;

  getDeadLetter(
    eventId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2OutboxDeadLetter | null>>;

  /** requeue 只允许原 event、原 aggregate revision、原幂等键重新进入 pending。 */
  requeueDeadLetter(
    eventId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2OutboxDeadLetter>>;

  /** payload 有缺陷时必须写新的 compensating event（带 compensates_event_id）。 */
  compensateDeadLetter(
    eventId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ compensating_event_id: string }>>;

  /* ---- 孤儿/恢复裁决面（§15.5） ---- */

  reconcileRecoveryCandidates(
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ scanned: number; created: number }>>;

  decideRecoveryCandidate(
    candidateId: string,
    input: { action: 'cleanup' | 'keep' | 'isolate'; reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2RecoveryCandidate>>;

  /** 永久失联 Node 的 Candidate 由控制面 CAS takeover（D-048/D-051）。 */
  takeoverRecoveryCandidate(
    candidateId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<V2RecoveryCandidate>>;

  /** 批量入口仍逐项留证（D-048），不能聚合成一次无审计的批量裁决。 */
  batchRecoveryCandidateActions(
    projectId: string,
    input: { candidate_ids: string[]; action: 'cleanup' | 'keep' | 'isolate'; reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ results: Array<{ candidate_id: string; ok: boolean }> }>>;

  /* ---- RecoveryIsolation / BranchCleanup 面（D-047/D-049/D-050/D-052） ---- */

  listRecoveryIsolations(
    options: { project_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<unknown>>>;

  /** 超期残留进入 durable isolation record；create 校验 Incident Owner 身份。 */
  createRecoveryIsolation(
    projectId: string,
    input: { scope: string; evidence: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ isolation_id: string }>>;

  /** 结构化三步分权第 2 步：review 强制 reviewer 与 isolator 不同（D-050）。 */
  reviewRecoveryIsolation(
    isolationId: string,
    input: { reviewed_by: string; verdict: 'confirm' | 'dispute' },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ isolation_id: string }>>;

  /** 第 3 步 resolve 由 Recovery Reviewer 独立复核，不能自隔离自关闭。 */
  resolveRecoveryIsolation(
    isolationId: string,
    input: { resolved_by: string; resolution: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ isolation_id: string }>>;

  listBranchCleanups(
    options: { project_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<V2Page<unknown>>>;

  /** retry 只允许 Incident Owner 或受限 Reconcile Operator 请求；实际 Git 删除
   * 由 ReconcileService 专用身份执行，调用者不能携带任意 branch ref。 */
  retryBranchCleanup(
    cleanupId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ cleanup_id: string; retried: boolean }>>;

  /* ---- restore 面（V1 对照：getDbStatus/dbRestoreManual/getRestoreMaintenanceGate） ---- */

  /** V1 对照：getRestoreMaintenanceGate（维护屏障读）。V2：restore point 水印
   * 与五组件清单状态（§14.6）。 */
  getRestoreGate(
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<
    ApiResponse<{ code: 'RESTORE_IN_PROGRESS' | 'RESTORE_FAILED'; message: string } | null>
  >;

  /** V1 对照：dbRestoreManual。V2：BackupCoordinator 编排的受控恢复入口。 */
  restoreFromPoint(
    input: { restore_point_id: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ restored: number }>>;

  /* ---- 运行态对账与巡检（V1 对照：reconcileRuntimeState/runWatchdog） ---- */

  /** V1 对照：reconcileRuntimeState。V2：durable revision 驱动的投影重放。 */
  reconcileRuntimeState(
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ replayed_events: number }>>;

  /** V1 对照：runWatchdog。V2：巡检只产生 Incident/reconcile 记录，auto_fix
   * 作为受审计的 compensating action。 */
  runWatchdog(
    input: { auto_fix: boolean },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ problems: unknown[]; summary: { total: number; fixed: number } }>>;

  /**
   * §23.1 五旗状态读面（Phase 8）：owner/auditor 巡检灰度进度与回退窗口。
   * 只读 env 派生状态，不做任何变更。
   */
  getFeatureFlags(
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<import('./feature-flags.js').V2FeatureFlagStatusView>>;

  /* ---- 投影与运维读面（V1 对照：getEvents/unackedEvents/ackEvent/
   *      pmIntake/getStatus/getConflicts/getActiveOwnership/supervisorTick） ---- */

  /** 事件流读取：cursor 分页语义与 V1 getEvents(after/cursor) 一致。 */
  listEvents(
    projectId: string | null,
    options: { after?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ events: unknown[]; next_cursor: string | null }>>;

  /** V1 对照：unackedEvents/ackEvent（consumer 投影读写）。 */
  listUnackedEvents(
    consumer: string,
    options: { type?: string; plan_id?: string } & V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ events: unknown[] }>>;

  ackEvent(
    consumer: string,
    eventId: string,
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<{ event_id: string; acked: boolean }>>;

  /** V1 对照：pmIntake（PM 轮询门铃汇总）。 */
  getIntake(
    consumer: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  /** V1 对照：getActiveOwnership/getConflicts（ownership 对账视图）。 */
  getActiveOwnership(
    projectId: string,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ ownership: unknown[]; total: number }>>;

  getConflicts(
    options: V2PageRequest,
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<{ conflicts: unknown[] }>>;
}

/* ------------------------------------------------------------------ */
/* IdentityService：Human Identity 与凭据生命周期（Phase 6，无 V1 对照） */
/* ------------------------------------------------------------------ */

/**
 * §13.1 身份分层的人类面 + §21 Phase 6 凭据轮换/紧急撤销。
 * 实现位于 src/server/v2/human-identity.ts（bvh2/membership）与
 * routes/v2-routes.ts 接线的 CredentialKeyringAuthority；本接口只声明
 * 路由可达的方法面（registry handler 引用）。
 */
export interface IdentityService {
  /** V1 对照：无（远程 Human Identity，Local Owner 仅 loopback——§13.2）。 */
  issueHumanSession(
    input: { subject: string; role: string; project_id?: string; ttl_seconds?: number },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** 会话吊销（revoke 即失效，R1C-013）。 */
  revokeHumanSession(
    sessionId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** 会话清单（Owner 运维视图）。 */
  listHumanSessions(
    query: { subject?: string; project_id?: string; status?: string },
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  /** 项目粒度角色授予（幂等改写）。 */
  grantProjectMembership(
    input: { project_id: string; subject: string; role: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** 撤销授予（派生会话随 resolve 即时失效）。 */
  revokeProjectMembership(
    membershipId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** 授予清单。 */
  listProjectMemberships(
    query: { project_id?: string; status?: string },
    meta: { actor: V2ActorContext; correlation_id: V2CorrelationId },
  ): Promise<ApiResponse<unknown>>;

  /** Node credential 轮换：老 generation 原子替换，旧 token 立即 fencing。 */
  rotateNodeCredential(
    nodeId: string,
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;

  /** 全局紧急撤销：按 key_version 前滚，bvn2/bva2/bvh2 全部旧 token 立即失效。 */
  revokeAllSessions(
    input: { reason: string },
    meta: V2RequestMeta & { actor: V2ActorContext },
  ): Promise<ApiResponse<unknown>>;
}

/* ------------------------------------------------------------------ */
/* 汇总类型：领域服务的名字与注册表（route registry 引用）              */
/* ------------------------------------------------------------------ */

/** 领域服务名；七个 V1 搬迁服务与 SERVICE_MAP.md 台账一一对应，IdentityService 为 Phase 6 新增（无 V1 对照）。 */
export type V2DomainServiceName =
  | 'ProjectService'
  | 'NodeService'
  | 'AttemptService'
  | 'DeliveryService'
  | 'MergeService'
  | 'IncidentService'
  | 'ReconcileService'
  | 'IdentityService';

/** 聚合接口，供后续 Phase 的组合根（composition root）装配 facade。 */
export interface V2DomainServices {
  project: ProjectService;
  node: NodeService;
  attempt: AttemptService;
  delivery: DeliveryService;
  merge: MergeService;
  incident: IncidentService;
  reconcile: ReconcileService;
  identity: IdentityService;
}
