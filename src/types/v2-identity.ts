/**
 * V2 领域身份表行类型与状态枚举。
 * 对应 docs/distributed-multi-node-development-plan.md §4.1/§4.2/§4.3/§20.1。
 *
 * 六张领域表：projects、nodes、node_sessions、node_project_bindings、agent_slots、legacy_project_bindings。
 * 时间戳统一使用 INTEGER 毫秒（Date.now()），与 V1 TEXT ISO 格式并存。
 */

// ──────────────── §4.1 Project 枚举 ────────────────

/** §4.1 execution_mode */
export type V2ProjectExecutionMode = 'full' | 'read-only-acceptance';

/** §4.1 merge_policy */
export type V2ProjectMergePolicy = 'merge-queue' | 'provider-pr';

/** §4.1 mode_transition 方向 */
export type V2ProjectModeTransition = 'draining-to-read-only' | 'validating-to-full';

/** §4.1 mode_transition_step（复用 v2-infra 已定义的 V2ModeTransitionStep） */
export type { V2ModeTransitionStep } from './v2-infra.js';

/** §4.1 write_capability_status */
export type V2WriteCapabilityStatus = 'ready' | 'suspect' | 'lost' | 'disabled';

/** §4.1 project status */
export type V2ProjectStatus = 'active' | 'paused' | 'archived';

// ──────────────── §4.2 Node 枚举 ────────────────

/** §4.2 Node 状态机全态（含 enrolling） */
export type V2NodeStatus =
  | 'enrolling'   // 初始注册，等待控制面确认
  | 'online'      // 正常运行
  | 'degraded'    // 降级（部分能力不可用）
  | 'draining'    // 正在排空任务，准备下线
  | 'offline'     // 已下线
  | 'quarantined'; // 被隔离（安全问题）

/** §4.2 Node OS */
export type V2NodeOs = 'darwin' | 'linux' | 'windows' | '';

/** §4.2 node_sessions.status */
export type V2NodeSessionStatus = 'active' | 'fenced' | 'expired';

// ──────────────── §4.3 NodeProjectBinding 枚举 ────────────────

/** §4.3 checkout_mode */
export type V2CheckoutMode = 'worktree' | 'clone-per-attempt';

/** §4.3 health */
export type V2NodeProjectHealth = 'ready' | 'syncing' | 'dirty' | 'diverged' | 'unavailable';

/** §4.3 authorization_status */
export type V2AuthorizationStatus = 'pending' | 'authorized' | 'revoked';

/** §4.3 write_credential_status */
export type V2WriteCredentialStatus = 'none' | 'eligible' | 'suspended';

// ──────────────── §20.1 agent_slots 枚举 ────────────────

/** §20.1 agent_slots.status */
export type V2AgentSlotStatus = 'idle' | 'claiming' | 'executing' | 'draining';

// ──────────────── §20.1 行类型 ────────────────

/** §4.1 + §20.1 projects — 项目注册表 */
export interface ProjectRow {
  project_id: string;
  display_name: string;
  repository_url: string;
  repository_fingerprint: string;
  default_branch: string;
  merge_policy: V2ProjectMergePolicy;
  execution_mode: V2ProjectExecutionMode;
  mode_transition: V2ProjectModeTransition | null;
  mode_transition_id: string;
  mode_transition_step: string | null;
  write_capability_status: V2WriteCapabilityStatus;
  artifact_policy_id: string;
  workspace_policy_id: string;
  status: V2ProjectStatus;
  revision: number;
  created_at: number; // 毫秒
  updated_at: number; // 毫秒
  /** Migration 012 扩展列：per-project ref ACL 配置 JSON（parseRefAcl 解析；空串 = 未配置）。 */
  ref_acl_json?: string | null;
  /** Migration 012 扩展列：ref ACL 连续丢失计数（22.3-17 熔断用）。 */
  ref_acl_miss_count?: number | null;
}

/** §4.2 + §20.1 nodes — 节点注册表（含 enrolling 状态与 TTL 终态字段） */
export interface NodeRow {
  node_id: string;
  display_name: string;
  os: V2NodeOs;
  arch: string;
  node_version: string;
  protocol_version: string;
  status: V2NodeStatus;
  capabilities: string;   // JSON array
  labels: string;          // JSON array
  max_concurrent_tasks: number;
  memory_mb: number | null;
  disk_free_mb: number | null;
  last_seen_at: number;    // 毫秒
  credential_generation: number;
  clock_skew_ms: number | null;
  server_cert_not_after: string;
  trust_anchor_generation: number;
  signing_key_generation: number;
  accepted_control_plane_signing_key_generations: string; // JSON array
  // §4.2 终态 TTL 字段
  terminal_state_at: number | null;   // 毫秒
  terminal_state_reason: string;
  ttl_expires_at: number | null;      // 毫秒
  created_at: number;                  // 毫秒
  updated_at: number;                  // 毫秒
}

/** §4.2 + §20.1 node_sessions — 节点会话（generation/credential_generation/fenced_at） */
export interface NodeSessionRow {
  session_id: string;
  node_id: string;
  node_session_generation: number;
  credential_generation: number;
  status: V2NodeSessionStatus;
  started_at: number;       // 毫秒
  last_seen_at: number;     // 毫秒
  fenced_at: number | null; // 毫秒
}

/** §4.3 + §20.1 node_project_bindings — 节点-项目绑定 */
export interface NodeProjectBindingRow {
  binding_id: string;
  node_id: string;
  project_id: string;
  local_cache_root: string;
  checkout_mode: V2CheckoutMode;
  repository_fingerprint: string;
  last_fetch_sha: string;
  health: V2NodeProjectHealth;
  last_checked_at: number;   // 毫秒
  authorization_status: V2AuthorizationStatus;
  authorized_by: string;
  authorized_at: number | null; // 毫秒
  authorization_revision: number;
  applied_policy_revision: number;
  write_credential_status: V2WriteCredentialStatus;
  created_at: number;        // 毫秒
  updated_at: number;        // 毫秒
}

/** §20.1 agent_slots — Agent 槽位 */
export interface AgentSlotRow {
  slot_id: string;
  node_id: string;
  session_id: string;
  capability_digest: string;
  status: V2AgentSlotStatus;
  active_attempt_id: string;
  updated_at: number; // 毫秒
}

/** §20.1 legacy_project_bindings — 显式 V1→V2 映射（禁止按路径 hash 猜 project_id —— R1B-002） */
export interface LegacyProjectBindingRow {
  legacy_project_path: string;
  project_id: string;
  repository_fingerprint: string;
  repository_url: string;
  default_branch: string;
  verified_at: number; // 毫秒
}

/* ──────────────── §13.1/§21 Phase 6：Human Identity 与 RBAC（009 迁移） ──────────────── */

/**
 * §21 Phase 6 Human 角色枚举（§13.1 身份分层的人类面收敛为四角色）：
 * rank 语义 owner(4) ≥ project_admin(3) ≥ reviewer(2) ≥ auditor(1)，
 * 声明在 src/server/v2/human-identity.ts 的 HUMAN_ROLE_RANK。
 */
export type V2HumanRole = 'owner' | 'project_admin' | 'reviewer' | 'auditor';

/** §20.1 project_memberships — 项目粒度 Human 角色（撤销即对派生会话生效） */
export interface ProjectMembershipRow {
  membership_id: string;
  project_id: string;
  subject: string;
  role: V2HumanRole;
  status: 'active' | 'revoked';
  granted_by: string;
  created_at: number;  // 毫秒
  updated_at: number;  // 毫秒
  revoked_at: number | null; // 毫秒
  revoke_reason: string;
}

/** §13.1 human_sessions — Owner 签发的 bvh2 会话（吊销列表） */
export interface HumanSessionRow {
  session_id: string;
  subject: string;
  role: V2HumanRole;
  /** 空串 = 平台级（owner 角色）；否则绑定单一 project。 */
  project_id: string;
  token_jti: string;
  key_version: number;
  status: 'active' | 'revoked';
  issued_at: number;   // 毫秒
  expires_at: number;  // 毫秒
  revoked_at: number | null; // 毫秒
  revoked_by: string;
  revoke_reason: string;
}

/**
 * 方案 E（014 迁移）human_enrollments — 远程控制台登录的一次性登记。
 * code_hash = sha256(enrollment_code)，明文仅创建响应返回一次；used_at 非空即不可重放。
 */
export interface HumanEnrollmentRow {
  enrollment_id: string;
  code_hash: string;
  subject: string;
  role: V2HumanRole;
  /** 空串 = 平台级（owner 角色）；否则绑定单一 project。 */
  project_id: string;
  created_by: string;
  created_at: number;      // 毫秒
  expires_at: number;      // 毫秒
  used_at: number | null;  // 毫秒；NULL = 未使用
  used_by_ip: string;
}
