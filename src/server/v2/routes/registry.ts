/**
 * V2 声明式路由注册表（Phase 0a-2 骨架）
 *
 * 依据 docs/distributed-multi-node-development-plan.md §15（API V2 草案 §15.1~15.5）
 * 与 §15.6（API 通用要求）：V2 路由放 /v2/ 前缀，认证、maintenance barrier、
 * mutation permit、correlation/idempotency 由共享 Fastify plugin
 * （src/server/http-plugins.ts）提供，V1/V2 只复用基础设施，不混用 payload schema。
 *
 * 本文件是数据（registry），不是实现：
 * - handler 以 `Service.method` 字符串引用领域接口方法，类型层由
 *   `V2RouteHandlerRef` 约束（引用不存在的方法无法通过编译）；
 * - schema 先声明最小 JSON Schema 形状，随 Phase 1+ 逐路由补全；
 * - credentialScopes 只允许 §13.1 身份分层中的 V2 凭据；V1 的全局
 *   owner/worker/mcp token 禁入 V2 写面（Phase 1 硬门禁）；
 * - credentialBinding（Phase 1 起）把 node/task_attempt 数据面路由对齐到
 *   src/server/v2/credentials.ts 的 verify 函数与 Attempt token scope。
 *
 * 生成式门禁测试：tests/distributed/p0a2-route-registry.test.ts。
 */

import type {
  AttemptService,
  DeliveryService,
  IdentityService,
  IncidentService,
  MergeService,
  NodeService,
  ProjectService,
  ReconcileService,
  V2ActorKind,
  V2DomainServiceName,
} from '../domain-interfaces.js';
import type { AttemptTokenScope } from '../credentials.js';
import type { V2HumanRole } from '../../../types/v2-identity.js';
import { HUMAN_ROLE_RANK as HUMAN_ROLE_RANK_REF } from '../human-identity.js';

/** 提取接口的方法名（只要函数成员）。 */
type MethodNames<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** handler 引用：`<领域服务>.<接口方法>`，编译期校验方法真实存在。 */
export type V2RouteHandlerRef =
  | `ProjectService.${MethodNames<ProjectService>}`
  | `NodeService.${MethodNames<NodeService>}`
  | `AttemptService.${MethodNames<AttemptService>}`
  | `DeliveryService.${MethodNames<DeliveryService>}`
  | `MergeService.${MethodNames<MergeService>}`
  | `IncidentService.${MethodNames<IncidentService>}`
  | `ReconcileService.${MethodNames<ReconcileService>}`
  | `IdentityService.${MethodNames<IdentityService>}`;

/** V2 支持的 HTTP 方法。 */
export type V2HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * §13.1 身份分层中的合法凭据作用域。V1 的全局 owner/worker/mcp token
 * 不属于 V2 写面（见 LEGACY_V1_CREDENTIAL_SCOPES，门禁测试断言互斥）。
 * Phase 6 追加 'auditor'（只读观测角色，§21 Phase 6 Web/CLI 权限）。
 */
export const V2_CREDENTIAL_SCOPES: readonly V2ActorKind[] = [
  'human_owner',
  'planner',
  'reviewer_pm',
  'recovery_reviewer',
  'auditor',
  'node',
  'task_attempt',
  'merge_bot',
];

/** V1 全局凭据：禁入 V2 写面（Phase 1 起远程 Node 不得共用全局 token）。 */
export const LEGACY_V1_CREDENTIAL_SCOPES = ['owner', 'worker', 'mcp'] as const;

/* ------------------------------------------------------------------ */
/* Phase 6：凭据作用域细化（owner | human(role≥x) | node | attempt）    */
/* ------------------------------------------------------------------ */

/**
 * §13.1 人类身份种类 → §21 Phase 6 四角色（rank 见 human-identity.ts
 * HUMAN_ROLE_RANK：owner(4) ≥ project_admin(3) ≥ reviewer(2) ≥ auditor(1)）。
 * 条目含多个人类种类时取 rank 最小者作为该路由的 human 最低角色。
 */
export const V2_HUMAN_MIN_ROLE_BY_ACTOR_KIND: Readonly<Record<Exclude<V2ActorKind, 'node' | 'task_attempt' | 'merge_bot'>, V2HumanRole>> = {
  human_owner: 'owner',
  planner: 'project_admin',
  reviewer_pm: 'reviewer',
  recovery_reviewer: 'reviewer',
  auditor: 'auditor',
};

/** Phase 6 运行时凭据策略：rbac.ts 中间件按此执行允许/拒绝。 */
export interface V2RouteCredentialPolicy {
  /** 本机 Owner bearer / local-owner 会话：V2 全路由运维超集（V1 行为保持）。 */
  owner: boolean;
  /** 人类会话（bvh2）最低角色；undefined = 该路由不接受人类会话。 */
  human?: V2HumanRole;
  /** bvn2 Node credential。 */
  node: boolean;
  /** bva2 Attempt token。 */
  attempt: boolean;
  /** bvm2 Merge Bot token（22.3-04）。 */
  merge_bot: boolean;
}

/** 机器作用域覆盖（默认从 credentialScopes 派生；enroll 是唯一例外，见下）。 */
export interface V2RouteCredentialPolicyOverride {
  node?: boolean;
  attempt?: boolean;
}

/**
 * 从 credentialScopes 派生运行时策略（credentialPolicyOverride 可收紧机器面）：
 * - human：人类种类映射角色的 rank 最小值（auditor 只读面即在此放宽）；
 * - node/attempt：作用域含 node/task_attempt 即放行该凭据类——例外是
 *   enroll：作用域的 'node' 指 enrollment ticket（§10.2 票据换凭据），
 *   不是 bvn2 持有者可直接调用的管理面，PolicyOverride 显式 node:false。
 */
export function deriveCredentialPolicy(
  entry: Pick<V2RouteRegistryEntry, 'id' | 'credentialScopes' | 'credentialPolicyOverride'>,
): V2RouteCredentialPolicy {
  const humanRoles = entry.credentialScopes
    .filter((scope): scope is keyof typeof V2_HUMAN_MIN_ROLE_BY_ACTOR_KIND => scope in V2_HUMAN_MIN_ROLE_BY_ACTOR_KIND)
    .map((scope) => V2_HUMAN_MIN_ROLE_BY_ACTOR_KIND[scope]);
  const override = entry.credentialPolicyOverride ?? {};
  return {
    owner: true,
    human: humanRoles.length > 0
      ? humanRoles.reduce((min, role) => (HUMAN_ROLE_RANK_REF[role] < HUMAN_ROLE_RANK_REF[min] ? role : min))
      : undefined,
    node: override.node ?? entry.credentialScopes.includes('node'),
    attempt: override.attempt ?? entry.credentialScopes.includes('task_attempt'),
    merge_bot: entry.credentialScopes.includes('merge_bot'),
  };
}

/**
 * Phase 1（车道 C）：条目机器凭据与 src/server/v2/credentials.ts 的
 * verify 函数对齐声明（R1A-003/R1A-007）：
 * - verifyNodeCredential / verifyAttemptToken：credentials.ts 实际导出的
 *   校验入口，attemptScope 必须在 ATTEMPT_TOKEN_SCOPS 枚举内；
 * - enrollment_ticket：节点首次加入（票据换凭据），node credential 尚未
 *   存在，票据校验随 Phase 2 enrollment 落地；
 * - human 身份（human_owner/planner/reviewer_pm/recovery_reviewer）的远程
 *   校验是 Phase 2+ Human Identity 范围，本字段不声明。
 *
 * 门禁：credentialScopes 含 node/task_attempt 的条目必须声明本字段，
 * 且 verifier 与作用域一致（tests/distributed/p1-credentials.test.ts）。
 */
export type V2RouteCredentialBinding =
  | { verifier: 'verifyNodeCredential' }
  | { verifier: 'verifyAttemptToken'; attemptScope: AttemptTokenScope }
  | { verifier: 'enrollment_ticket' };

/** V2 路由统一前缀；V1 路由不得占用该前缀（§15.6：V1/V2 路由明确隔离）。 */
export const V2_API_PREFIX = '/v2';

/** JSON Schema 形状（与 Fastify route schema 组件一一对应）。 */
export interface V2RouteSchema {
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  querystring?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

/** registry 条目。 */
export interface V2RouteRegistryEntry {
  /** 稳定条目 ID（= method + path 的规范形式，测试与文档引用用）。 */
  id: string;
  method: V2HttpMethod;
  /** 必须以 /v2/ 开头。 */
  path: string;
  /** 归属的领域服务（与 SERVICE_MAP.md 七服务对应）。 */
  service: V2DomainServiceName;
  /** 领域接口方法引用；实现随 Phase 1+ 落地。 */
  handler: V2RouteHandlerRef;
  /** 至少声明一个 schema 组件（门禁测试断言）。 */
  schema: V2RouteSchema;
  /** 允许调用该路由的 V2 凭据作用域，至少一个（门禁测试断言）。 */
  credentialScopes: readonly V2ActorKind[];
  /**
   * 机器凭据（node/task_attempt）与 credentials.ts verify 函数的对齐声明；
   * credentialScopes 含 node/task_attempt 时必填（p1 门禁测试断言）。
   */
  credentialBinding?: V2RouteCredentialBinding;
  /**
   * Phase 6 运行时凭据策略覆盖（默认从 credentialScopes 派生，见
   * deriveCredentialPolicy）。只在语义需要收紧机器面时声明（如 enroll 的
   * 'node' 是 enrollment ticket 而非 bvn2）；human 最低角色一律走作用域派生。
   */
  credentialPolicyOverride?: V2RouteCredentialPolicyOverride;
  /** 是否写操作（mutation：必须支持 idempotency key，§15.6）。 */
  mutation: boolean;
  description: string;
}

/* ------------------------------------------------------------------ */
/* 复用的最小 schema 片段                                             */
/* ------------------------------------------------------------------ */

const idParam = (name: string): V2RouteSchema['params'] => ({
  type: 'object',
  required: [name],
  additionalProperties: false,
  properties: { [name]: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } },
});

const twoIdParams = (a: string, b: string): V2RouteSchema['params'] => ({
  type: 'object',
  required: [a, b],
  additionalProperties: false,
  properties: {
    [a]: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
    [b]: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
  },
});

/** 响应信封占位：Fastify 要求 response schema 按状态码嵌套（门禁装配时校验）。 */
const okResponse: Record<string, unknown> = { type: 'object' };

const cursorQuery: V2RouteSchema['querystring'] = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
};

/* ------------------------------------------------------------------ */
/* V2 路由注册表（§15.1 ~ §15.5 全量）                                */
/* ------------------------------------------------------------------ */

export const V2_ROUTES: readonly V2RouteRegistryEntry[] = [
  /* ---- §15.1 Project ---- */
  {
    id: 'POST /v2/projects',
    method: 'POST',
    path: '/v2/projects',
    service: 'ProjectService',
    handler: 'ProjectService.createProject',
    schema: {
      body: {
        type: 'object',
        required: ['name', 'repo_path', 'default_branch', 'execution_mode'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 128 },
          repo_path: { type: 'string', minLength: 1 },
          default_branch: { type: 'string', minLength: 1 },
          legacy_project_scope: { type: 'string' },
          execution_mode: { type: 'string', enum: ['full', 'read_only'] },
        },
      },
      response: { 200: okResponse },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '注册 Project（project_id 身份，D-002/D-026）',
  },
  {
    id: 'GET /v2/projects',
    method: 'GET',
    path: '/v2/projects',
    service: 'ProjectService',
    handler: 'ProjectService.listProjects',
    schema: { querystring: cursorQuery, response: { 200: okResponse } },
    credentialScopes: ['human_owner', 'planner', 'reviewer_pm', 'auditor'],
    mutation: false,
    description: '列出 Project（cursor 分页；auditor 只读面）',
  },
  {
    id: 'GET /v2/projects/:project_id',
    method: 'GET',
    path: '/v2/projects/:project_id',
    service: 'ProjectService',
    handler: 'ProjectService.getProject',
    schema: { params: idParam('project_id'), response: { 200: okResponse } },
    credentialScopes: ['human_owner', 'planner', 'reviewer_pm', 'auditor'],
    mutation: false,
    description: '查询单个 Project（auditor 只读面）',
  },
  {
    id: 'POST /v2/projects/:project_id/validate',
    method: 'POST',
    path: '/v2/projects/:project_id/validate',
    service: 'ProjectService',
    handler: 'ProjectService.validateProject',
    schema: { params: idParam('project_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '校验 repo 可接入性与 ref ACL',
  },
  {
    id: 'PATCH /v2/projects/:project_id/policy',
    method: 'PATCH',
    path: '/v2/projects/:project_id/policy',
    service: 'ProjectService',
    handler: 'ProjectService.updatePolicy',
    schema: { params: idParam('project_id'), body: { type: 'object', additionalProperties: true } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '更新项目策略',
  },
  {
    id: 'POST /v2/projects/:project_id/mode-transitions',
    method: 'POST',
    path: '/v2/projects/:project_id/mode-transitions',
    service: 'ProjectService',
    handler: 'ProjectService.applyModeTransition',
    schema: {
      params: idParam('project_id'),
      body: {
        type: 'object',
        required: ['to_mode', 'reason'],
        additionalProperties: false,
        properties: {
          to_mode: { type: 'string', enum: ['full', 'read_only'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: 'full↔read-only 模式切换（durable 状态机，D-043/D-046）',
  },
  {
    id: 'GET /v2/projects/:project_id/mode-transitions/:transition_id',
    method: 'GET',
    path: '/v2/projects/:project_id/mode-transitions/:transition_id',
    service: 'ProjectService',
    handler: 'ProjectService.getModeTransition',
    schema: { params: twoIdParams('project_id', 'transition_id') },
    credentialScopes: ['human_owner'],
    mutation: false,
    description: '查询模式切换进度（重启后可恢复）',
  },

  /* ---- §15.2 Node ---- */
  {
    id: 'POST /v2/nodes/enroll',
    method: 'POST',
    path: '/v2/nodes/enroll',
    service: 'NodeService',
    handler: 'NodeService.enroll',
    schema: {
      body: {
        type: 'object',
        required: ['enrollment_ticket', 'node_id'],
        additionalProperties: false,
        properties: {
          enrollment_ticket: { type: 'string', minLength: 1 },
          node_id: { type: 'string', minLength: 16, maxLength: 128 },
        },
      },
    },
    credentialScopes: ['node', 'human_owner'],
    mutation: true,
    credentialBinding: { verifier: 'enrollment_ticket' },
    credentialPolicyOverride: { node: false },
    description: '节点首次加入（enrollment ticket 换节点凭据；ticket 在 body，bvn2 不得作为该路由凭据；管理面 owner 可驱动）',
  },
  {
    id: 'POST /v2/nodes/register',
    method: 'POST',
    path: '/v2/nodes/register',
    service: 'NodeService',
    handler: 'NodeService.register',
    schema: {
      body: {
        type: 'object',
        required: ['node_id', 'slots', 'requested_project_ids'],
        additionalProperties: false,
        properties: {
          node_id: { type: 'string', minLength: 16, maxLength: 128 },
          labels: { type: 'array', items: { type: 'string' } },
          slots: { type: 'integer', minimum: 1, maximum: 256 },
          requested_project_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    credentialScopes: ['node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyNodeCredential' },
    description: '节点注册（credential_generation fencing 起点）',
  },
  {
    id: 'POST /v2/nodes/:node_id/heartbeat',
    method: 'POST',
    path: '/v2/nodes/:node_id/heartbeat',
    service: 'NodeService',
    handler: 'NodeService.heartbeat',
    schema: {
      params: idParam('node_id'),
      body: {
        type: 'object',
        required: ['protocol_version', 'clock_skew_ms', 'disk_free_gib', 'disk_free_percent', 'slots_in_use'],
        additionalProperties: false,
        properties: {
          protocol_version: { type: 'integer', minimum: 1 },
          clock_skew_ms: { type: 'integer' },
          disk_free_gib: { type: 'number', minimum: 0 },
          disk_free_percent: { type: 'number', minimum: 0, maximum: 100 },
          slots_in_use: { type: 'integer', minimum: 0 },
          trust_anchor_generation: { type: 'integer', minimum: 1 },
        },
      },
    },
    credentialScopes: ['node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyNodeCredential' },
    description: '节点心跳（§10.3 全量内容 + trust anchor 回报）',
  },
  {
    id: 'POST /v2/nodes/:node_id/drain',
    method: 'POST',
    path: '/v2/nodes/:node_id/drain',
    service: 'NodeService',
    handler: 'NodeService.drain',
    schema: { params: idParam('node_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '排空节点（升级/维护，D-024）',
  },
  {
    id: 'POST /v2/nodes/:node_id/offline',
    method: 'POST',
    path: '/v2/nodes/:node_id/offline',
    service: 'NodeService',
    handler: 'NodeService.offline',
    schema: {
      params: idParam('node_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 512 } },
      },
    },
    credentialScopes: ['node', 'human_owner'],
    mutation: true,
    credentialBinding: { verifier: 'verifyNodeCredential' },
    description: '节点下线（幂等，保留审计）',
  },
  {
    id: 'POST /v2/nodes/:node_id/revoke',
    method: 'POST',
    path: '/v2/nodes/:node_id/revoke',
    service: 'NodeService',
    handler: 'NodeService.revoke',
    schema: {
      params: idParam('node_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 512 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '撤销节点（等同安全撤权并立即 fencing，D-037）',
  },
  {
    id: 'POST /v2/projects/:project_id/nodes/:node_id/authorize',
    method: 'POST',
    path: '/v2/projects/:project_id/nodes/:node_id/authorize',
    service: 'NodeService',
    handler: 'NodeService.authorizeProject',
    schema: { params: twoIdParams('project_id', 'node_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: 'Node→Project 显式授权（D-031）',
  },
  {
    id: 'DELETE /v2/projects/:project_id/nodes/:node_id/authorization',
    method: 'DELETE',
    path: '/v2/projects/:project_id/nodes/:node_id/authorization',
    service: 'NodeService',
    handler: 'NodeService.revokeProjectAuthorization',
    schema: { params: twoIdParams('project_id', 'node_id') },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '撤销 Node→Project 授权',
  },
  {
    id: 'GET /v2/nodes',
    method: 'GET',
    path: '/v2/nodes',
    service: 'NodeService',
    handler: 'NodeService.listNodes',
    schema: { querystring: cursorQuery },
    credentialScopes: ['human_owner', 'auditor'],
    mutation: false,
    description: '节点清单（Owner 视角；nodes 状态对 auditor 只读开放）',
  },

  /* ---- §15.3 Plan / Task / Attempt ---- */
  {
    id: 'POST /v2/plans/import',
    method: 'POST',
    path: '/v2/plans/import',
    service: 'ProjectService',
    handler: 'ProjectService.importPlan',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'snapshot'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          snapshot: { type: 'object' },
        },
      },
    },
    credentialScopes: ['planner'],
    mutation: true,
    description: '上传 Plan Snapshot（D-014；Planner 不自动拥有 Review 权限）',
  },
  {
    id: 'GET /v2/plans/:plan_id',
    method: 'GET',
    path: '/v2/plans/:plan_id',
    service: 'ProjectService',
    handler: 'ProjectService.getPlan',
    schema: { params: idParam('plan_id') },
    credentialScopes: ['human_owner', 'planner', 'reviewer_pm', 'auditor'],
    mutation: false,
    description: '查询 Plan（含任务状态投影；auditor 只读面）',
  },
  {
    id: 'POST /v2/tasks/claim',
    method: 'POST',
    path: '/v2/tasks/claim',
    service: 'AttemptService',
    handler: 'AttemptService.claimTask',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'agent_id', 'claim_request_id'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          agent_id: { type: 'string', minLength: 1 },
          claim_request_id: { type: 'string', minLength: 16, maxLength: 128 },
          blocking: { type: 'boolean' },
          timeout_ms: { type: 'integer', minimum: 0, maximum: 60000 },
          preferred_types: { type: 'array', items: { type: 'string' } },
          preferred_phases: { type: 'array', items: { type: 'string' } },
          preferred_plan_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    credentialScopes: ['node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyNodeCredential' },
    description: '认领任务（返回 attempt_generation + 短期 Attempt Token，§13.5）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/lease/renew',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/lease/renew',
    service: 'AttemptService',
    handler: 'AttemptService.renewLease',
    schema: {
      params: idParam('attempt_id'),
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { extend_seconds: { type: 'integer', minimum: 1 } },
      },
    },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'claim' },
    description: '续租（attempt_generation fencing）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/question',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/question',
    service: 'AttemptService',
    handler: 'AttemptService.askQuestion',
    schema: {
      params: idParam('attempt_id'),
      body: {
        type: 'object',
        required: ['body'],
        additionalProperties: false,
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 8000 },
          checkpoint: { type: 'string', maxLength: 8000 },
          requested_ownership: { type: 'object' },
        },
      },
    },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'question' },
    description: 'Worker→PM 受控提问（不通过事件流广播正文）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/report',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/report',
    service: 'AttemptService',
    handler: 'AttemptService.reportAttempt',
    schema: {
      params: idParam('attempt_id'),
      body: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['done', 'failed', 'partial'] },
          artifact_refs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['artifact_id', 'sha256'],
              additionalProperties: false,
              properties: {
                artifact_id: { type: 'string' },
                sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              },
            },
          },
        },
      },
    },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: 'Attempt 收口（Artifact 引用替代本地路径，D-005）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/cancel',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/cancel',
    service: 'AttemptService',
    handler: 'AttemptService.cancelTask',
    schema: {
      params: idParam('attempt_id'),
      body: { type: 'object', additionalProperties: false },
    },
    credentialScopes: ['task_attempt', 'human_owner'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'claim' },
    description: '取消 attempt（attempt → cancelled，task → pending 允许重试）',
  },

  /* ---- §15.4 Artifact ---- */
  {
    id: 'POST /v2/artifacts/initiate',
    method: 'POST',
    path: '/v2/artifacts/initiate',
    service: 'DeliveryService',
    handler: 'DeliveryService.initiateArtifact',
    schema: {
      body: {
        type: 'object',
        required: ['attempt_id', 'kind', 'size_bytes', 'sha256'],
        additionalProperties: false,
        properties: {
          attempt_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          kind: { type: 'string', minLength: 1, maxLength: 64 },
          size_bytes: { type: 'integer', minimum: 1 },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
    },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: 'Artifact 三段式上传第 1 步（临时键，§14.5）',
  },
  {
    id: 'PUT /v2/artifacts/:artifact_id/content',
    method: 'PUT',
    path: '/v2/artifacts/:artifact_id/content',
    service: 'DeliveryService',
    handler: 'DeliveryService.uploadArtifactContent',
    schema: { params: idParam('artifact_id') },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '上传内容（流式，超限/跨任务引用被拒）',
  },
  {
    id: 'POST /v2/artifacts/:artifact_id/complete',
    method: 'POST',
    path: '/v2/artifacts/:artifact_id/complete',
    service: 'DeliveryService',
    handler: 'DeliveryService.completeArtifact',
    schema: { params: idParam('artifact_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '完成上传（服务端复算 SHA-256 后同一 durable 事务发布）',
  },
  {
    id: 'GET /v2/artifacts/:artifact_id',
    method: 'GET',
    path: '/v2/artifacts/:artifact_id',
    service: 'DeliveryService',
    handler: 'DeliveryService.getArtifact',
    schema: { params: idParam('artifact_id') },
    credentialScopes: ['task_attempt', 'reviewer_pm', 'human_owner'],
    mutation: false,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '读取 Artifact 元数据（跨项目引用被拒）',
  },

  /* ---- §15.5 Delivery / Review / Merge / Incident / Recovery / Outbox ---- */
  {
    id: 'POST /v2/deliveries',
    method: 'POST',
    path: '/v2/deliveries',
    service: 'DeliveryService',
    handler: 'DeliveryService.createDelivery',
    schema: {
      body: {
        type: 'object',
        required: ['attempt_id', 'branch', 'head_sha', 'artifact_refs'],
        additionalProperties: false,
        properties: {
          attempt_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          branch: { type: 'string', minLength: 1 },
          head_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
          artifact_refs: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    credentialScopes: ['task_attempt'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '创建 Delivery（(attempt_id, head_sha) 唯一，§14.5）',
  },
  {
    id: 'GET /v2/deliveries/:delivery_id',
    method: 'GET',
    path: '/v2/deliveries/:delivery_id',
    service: 'DeliveryService',
    handler: 'DeliveryService.getDelivery',
    schema: { params: idParam('delivery_id') },
    credentialScopes: ['task_attempt', 'reviewer_pm', 'human_owner', 'auditor'],
    mutation: false,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '查询 Delivery（deliveries 状态对 auditor 只读开放）',
  },
  {
    id: 'POST /v2/deliveries/:delivery_id/review',
    method: 'POST',
    path: '/v2/deliveries/:delivery_id/review',
    service: 'DeliveryService',
    handler: 'DeliveryService.reviewDelivery',
    schema: {
      params: idParam('delivery_id'),
      body: {
        type: 'object',
        required: ['verdict', 'reviewed_by'],
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['accept', 'reject'] },
          reviewed_by: { type: 'string', minLength: 1 },
          comment: { type: 'string' },
          reject_reason: { type: 'string' },
          fix_instructions: { type: 'string' },
          repair_ownership: { type: 'object' },
          resolution_mode: { type: 'string', enum: ['repair', 'reverify'] },
        },
      },
    },
    credentialScopes: ['reviewer_pm'],
    mutation: true,
    description: 'PM 验收（Reviewer 从 Remote/Artifact 重算证据，D-027）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/workspace/prepare',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/workspace/prepare',
    service: 'DeliveryService',
    handler: 'DeliveryService.prepareWorkspace',
    schema: {
      params: idParam('attempt_id'),
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attempt_token: { type: 'string' },
          base_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        },
      },
    },
    credentialScopes: ['task_attempt', 'node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'ownership' },
    description: '§6.4 Workspace Prepare 状态机（幂等可重入，水位/指纹/可达/marker 七项检查）',
  },
  {
    id: 'POST /v2/attempts/:attempt_id/workspace/finalize',
    method: 'POST',
    path: '/v2/attempts/:attempt_id/workspace/finalize',
    service: 'DeliveryService',
    handler: 'DeliveryService.finalizeWorkspace',
    schema: {
      params: idParam('attempt_id'),
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifact_refs: {
            type: 'array',
            items: {
              type: 'object',
              required: ['artifact_id'],
              additionalProperties: false,
              properties: { artifact_id: { type: 'string', minLength: 1 } },
            },
          },
          author: { type: 'string', minLength: 1 },
        },
      },
    },
    credentialScopes: ['task_attempt', 'node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '§6.5 commit_and_push：ownership 门禁 + CAS push + 服务端复核 + delivery',
  },
  {
    id: 'GET /v2/attempts/:attempt_id/workspace',
    method: 'GET',
    path: '/v2/attempts/:attempt_id/workspace',
    service: 'DeliveryService',
    handler: 'DeliveryService.getWorkspace',
    schema: { params: idParam('attempt_id') },
    credentialScopes: ['human_owner', 'reviewer_pm'],
    mutation: false,
    description: '工作区状态机读面（prepare/finalize 诊断）',
  },
  {
    id: 'POST /v2/workspace-recovery/scan',
    method: 'POST',
    path: '/v2/workspace-recovery/scan',
    service: 'DeliveryService',
    handler: 'DeliveryService.scanWorkspaceRecovery',
    schema: { body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner', 'recovery_reviewer'],
    mutation: true,
    description: '§6.6/§21 中断恢复扫描：过期 attempt 的中断工作区落 orphan candidate',
  },
  {
    id: 'POST /v2/deliveries/:delivery_id/verify',
    method: 'POST',
    path: '/v2/deliveries/:delivery_id/verify',
    service: 'DeliveryService',
    handler: 'DeliveryService.verifyDeliveryRemote',
    schema: { params: idParam('delivery_id') },
    credentialScopes: ['human_owner', 'reviewer_pm'],
    mutation: true,
    description: '§7.3 服务端独立 diff 复核（远端不一致 → invalidated/rejected）',
  },
  {
    id: 'POST /v2/deliveries/:delivery_id/review/start',
    method: 'POST',
    path: '/v2/deliveries/:delivery_id/review/start',
    service: 'DeliveryService',
    handler: 'DeliveryService.startDeliveryReview',
    schema: { params: idParam('delivery_id') },
    credentialScopes: ['reviewer_pm'],
    mutation: true,
    description: '§4.5 pending_review → reviewing',
  },
  {
    id: 'POST /v2/deliveries/:delivery_id/recover-artifacts',
    method: 'POST',
    path: '/v2/deliveries/:delivery_id/recover-artifacts',
    service: 'DeliveryService',
    handler: 'DeliveryService.recoverDeliveryArtifacts',
    schema: { params: idParam('delivery_id') },
    credentialScopes: ['task_attempt', 'node', 'human_owner'],
    mutation: true,
    credentialBinding: { verifier: 'verifyAttemptToken', attemptScope: 'report' },
    description: '§21 Artifact 中断收敛：pending_recovery → pending_review',
  },
  {
    id: 'POST /v2/branch-cleanups/run',
    method: 'POST',
    path: '/v2/branch-cleanups/run',
    service: 'DeliveryService',
    handler: 'DeliveryService.runBranchCleanups',
    schema: { body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '§4.4.2/§6.6 到期 BranchCleanup 执行（删除前复核远端 HEAD）',
  },
  {
    id: 'POST /v2/evidence-acceptances',
    method: 'POST',
    path: '/v2/evidence-acceptances',
    service: 'DeliveryService',
    handler: 'DeliveryService.createEvidenceAcceptance',
    schema: {
      body: {
        type: 'object',
        required: ['attempt_id', 'commit_sha', 'level'],
        additionalProperties: false,
        properties: {
          attempt_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          commit_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
          level: { type: 'string', enum: ['node', 'node_harness', 'pm'] },
        },
      },
    },
    credentialScopes: ['node'],
    mutation: true,
    credentialBinding: { verifier: 'verifyNodeCredential' },
    description: 'Artifact-only 完成的证据验收记录（D-041，独立节点验收）',
  },
  {
    id: 'POST /v2/evidence-acceptances/:acceptance_id/review',
    method: 'POST',
    path: '/v2/evidence-acceptances/:acceptance_id/review',
    service: 'DeliveryService',
    handler: 'DeliveryService.reviewEvidenceAcceptance',
    schema: {
      params: idParam('acceptance_id'),
      body: {
        type: 'object',
        required: ['verdict', 'reviewed_by'],
        additionalProperties: false,
        properties: {
          verdict: { type: 'string', enum: ['accept', 'reject'] },
          reviewed_by: { type: 'string', minLength: 1 },
        },
      },
    },
    credentialScopes: ['reviewer_pm'],
    mutation: true,
    description: 'EvidenceAcceptance 复核',
  },
  {
    id: 'POST /v2/merge-jobs',
    method: 'POST',
    path: '/v2/merge-jobs',
    service: 'MergeService',
    handler: 'MergeService.createMergeJob',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'delivery_id', 'expected_target_sha'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          delivery_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          expected_target_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        },
      },
    },
    credentialScopes: ['reviewer_pm', 'merge_bot'],
    mutation: true,
    description: '入合并队列（merge approval；执行由 Merge Bot 单写，D-007）',
  },
  {
    id: 'GET /v2/merge-jobs/:merge_job_id',
    method: 'GET',
    path: '/v2/merge-jobs/:merge_job_id',
    service: 'MergeService',
    handler: 'MergeService.getMergeJob',
    schema: { params: idParam('merge_job_id') },
    credentialScopes: ['human_owner', 'reviewer_pm', 'merge_bot'],
    mutation: false,
    description: '查询合并任务',
  },
  {
    id: 'POST /v2/merge-jobs/:merge_job_id/cancel',
    method: 'POST',
    path: '/v2/merge-jobs/:merge_job_id/cancel',
    service: 'MergeService',
    handler: 'MergeService.cancelMergeJob',
    schema: {
      params: idParam('merge_job_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['reviewer_pm', 'human_owner'],
    mutation: true,
    description: '取消合并任务',
  },
  {
    id: 'POST /v2/merge-jobs/external-intents',
    method: 'POST',
    path: '/v2/merge-jobs/external-intents',
    service: 'MergeService',
    handler: 'MergeService.createExternalIntent',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'ref', 'before_sha', 'after_sha'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          ref: { type: 'string', minLength: 1 },
          before_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
          after_sha: { type: 'string', pattern: '^[a-f0-9]{40,64}$' },
        },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '登记外部合并意图（控制面之外的 push）',
  },
  {
    id: 'POST /v2/merge-jobs/external-intents/:intent_id/reconcile',
    method: 'POST',
    path: '/v2/merge-jobs/external-intents/:intent_id/reconcile',
    service: 'MergeService',
    handler: 'MergeService.reconcileExternalIntent',
    schema: { params: idParam('intent_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '外部意图对账',
  },
  {
    id: 'GET /v2/projects/:project_id/merge-jobs',
    method: 'GET',
    path: '/v2/projects/:project_id/merge-jobs',
    service: 'MergeService',
    handler: 'MergeService.listMergeJobs',
    schema: { params: idParam('project_id'), querystring: cursorQuery },
    credentialScopes: ['human_owner', 'reviewer_pm', 'auditor'],
    mutation: false,
    description: '合并队列视图（按 project 列出；auditor 只读面）',
  },
  {
    id: 'POST /v2/projects/:project_id/merge-jobs/dispatch',
    method: 'POST',
    path: '/v2/projects/:project_id/merge-jobs/dispatch',
    service: 'MergeService',
    handler: 'MergeService.dispatchMergeJob',
    schema: {
      params: idParam('project_id'),
      body: { type: 'object', additionalProperties: false },
      response: { 200: okResponse },
    },
    credentialScopes: ['human_owner', 'reviewer_pm', 'merge_bot'],
    mutation: true,
    description: '触发队头 merge 执行（§12.2 串行队列；Phase 8 HTTP 接线）',
  },
  {
    id: 'POST /v2/merge-jobs/:merge_job_id/retry',
    method: 'POST',
    path: '/v2/merge-jobs/:merge_job_id/retry',
    service: 'MergeService',
    handler: 'MergeService.retryMergeJob',
    schema: { params: idParam('merge_job_id') },
    credentialScopes: ['reviewer_pm', 'human_owner', 'merge_bot'],
    mutation: true,
    description: 'integration_failed 重试（= 新 job）',
  },
  {
    id: 'POST /v2/projects/:project_id/write-capability/restore',
    method: 'POST',
    path: '/v2/projects/:project_id/write-capability/restore',
    service: 'MergeService',
    handler: 'MergeService.restoreWriteCapability',
    schema: { params: idParam('project_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '恢复写能力（降级后人工恢复）',
  },
  {
    id: 'GET /v2/incidents',
    method: 'GET',
    path: '/v2/incidents',
    service: 'IncidentService',
    handler: 'IncidentService.listIncidents',
    schema: { querystring: cursorQuery },
    credentialScopes: ['human_owner', 'reviewer_pm'],
    mutation: false,
    description: 'Incident 清单（持久领域实体，D-033）',
  },
  {
    id: 'POST /v2/incidents/:incident_id/ack',
    method: 'POST',
    path: '/v2/incidents/:incident_id/ack',
    service: 'IncidentService',
    handler: 'IncidentService.ackIncident',
    schema: {
      params: idParam('incident_id'),
      body: {
        type: 'object',
        required: ['acked_by'],
        additionalProperties: false,
        properties: {
          acked_by: { type: 'string', minLength: 1 },
          note: { type: 'string', maxLength: 2000 },
        },
      },
    },
    credentialScopes: ['human_owner', 'reviewer_pm'],
    mutation: true,
    description: '确认 Incident（SLO 计时）',
  },
  {
    id: 'POST /v2/incidents/:incident_id/resolve',
    method: 'POST',
    path: '/v2/incidents/:incident_id/resolve',
    service: 'IncidentService',
    handler: 'IncidentService.resolveIncident',
    schema: {
      params: idParam('incident_id'),
      body: {
        type: 'object',
        required: ['resolved_by', 'evidence'],
        additionalProperties: false,
        properties: {
          resolved_by: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
    credentialScopes: ['human_owner', 'reviewer_pm'],
    mutation: true,
    description: '解除 Incident（必须附证据引用）',
  },
  {
    id: 'POST /v2/recovery-candidates/reconcile',
    method: 'POST',
    path: '/v2/recovery-candidates/reconcile',
    service: 'ReconcileService',
    handler: 'ReconcileService.reconcileRecoveryCandidates',
    schema: { body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner', 'recovery_reviewer'],
    mutation: true,
    description: '扫描孤儿/残留并产生 Candidate（D-022）',
  },
  {
    id: 'POST /v2/recovery-candidates/:candidate_id/decision',
    method: 'POST',
    path: '/v2/recovery-candidates/:candidate_id/decision',
    service: 'ReconcileService',
    handler: 'ReconcileService.decideRecoveryCandidate',
    schema: {
      params: idParam('candidate_id'),
      body: {
        type: 'object',
        required: ['action', 'reason'],
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['cleanup', 'keep', 'isolate'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    credentialScopes: ['recovery_reviewer'],
    mutation: true,
    description: 'Candidate 裁决（孤儿恢复不继承 Verify 信任，D-032）',
  },
  {
    id: 'POST /v2/recovery-candidates/:candidate_id/takeover',
    method: 'POST',
    path: '/v2/recovery-candidates/:candidate_id/takeover',
    service: 'ReconcileService',
    handler: 'ReconcileService.takeoverRecoveryCandidate',
    schema: { params: idParam('candidate_id'), body: { type: 'object', additionalProperties: false } },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '永久失联 Node 的 Candidate 控制面 CAS 接管（D-048/D-051）',
  },
  {
    id: 'POST /v2/recovery-candidates/batch-actions',
    method: 'POST',
    path: '/v2/recovery-candidates/batch-actions',
    service: 'ReconcileService',
    handler: 'ReconcileService.batchRecoveryCandidateActions',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'candidate_ids', 'action', 'reason'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          candidate_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
          action: { type: 'string', enum: ['cleanup', 'keep', 'isolate'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '批量裁决入口（仍逐项留证）',
  },
  {
    id: 'GET /v2/recovery-isolations',
    method: 'GET',
    path: '/v2/recovery-isolations',
    service: 'ReconcileService',
    handler: 'ReconcileService.listRecoveryIsolations',
    schema: { querystring: cursorQuery },
    credentialScopes: ['human_owner', 'recovery_reviewer'],
    mutation: false,
    description: '隔离记录清单（D-047）',
  },
  {
    id: 'POST /v2/recovery-isolations',
    method: 'POST',
    path: '/v2/recovery-isolations',
    service: 'ReconcileService',
    handler: 'ReconcileService.createRecoveryIsolation',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'scope', 'evidence'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          scope: { type: 'string', minLength: 1, maxLength: 4000 },
          evidence: { type: 'string', minLength: 1, maxLength: 8000 },
        },
      },
    },
    credentialScopes: ['recovery_reviewer'],
    mutation: true,
    description: '创建隔离记录（三步分权第 1 步，D-050）',
  },
  {
    id: 'POST /v2/recovery-isolations/:isolation_id/review',
    method: 'POST',
    path: '/v2/recovery-isolations/:isolation_id/review',
    service: 'ReconcileService',
    handler: 'ReconcileService.reviewRecoveryIsolation',
    schema: {
      params: idParam('isolation_id'),
      body: {
        type: 'object',
        required: ['reviewed_by', 'verdict'],
        additionalProperties: false,
        properties: {
          reviewed_by: { type: 'string', minLength: 1 },
          verdict: { type: 'string', enum: ['confirm', 'dispute'] },
        },
      },
    },
    credentialScopes: ['recovery_reviewer'],
    mutation: true,
    description: '隔离复核（reviewer 必须与 isolator 不同）',
  },
  {
    id: 'POST /v2/recovery-isolations/:isolation_id/resolve',
    method: 'POST',
    path: '/v2/recovery-isolations/:isolation_id/resolve',
    service: 'ReconcileService',
    handler: 'ReconcileService.resolveRecoveryIsolation',
    schema: {
      params: idParam('isolation_id'),
      body: {
        type: 'object',
        required: ['resolved_by', 'resolution'],
        additionalProperties: false,
        properties: {
          resolved_by: { type: 'string', minLength: 1 },
          resolution: { type: 'string', minLength: 1, maxLength: 4000 },
        },
      },
    },
    credentialScopes: ['recovery_reviewer'],
    mutation: true,
    description: '隔离解除（独立复核后收口）',
  },
  {
    id: 'GET /v2/branch-cleanups',
    method: 'GET',
    path: '/v2/branch-cleanups',
    service: 'ReconcileService',
    handler: 'ReconcileService.listBranchCleanups',
    schema: { querystring: cursorQuery },
    credentialScopes: ['human_owner', 'recovery_reviewer'],
    mutation: false,
    description: '分支清理清单（覆盖所有非 merged 终态，D-049/D-052）',
  },
  {
    id: 'GET /v2/feature-flags',
    method: 'GET',
    path: '/v2/feature-flags',
    service: 'ReconcileService',
    handler: 'ReconcileService.getFeatureFlags',
    schema: { response: { 200: okResponse } },
    credentialScopes: ['human_owner', 'auditor'],
    mutation: false,
    description: '§23.1 五旗状态（Phase 8 灰度/回退窗口可观测面；全关时仍可用）',
  },
  {
    id: 'POST /v2/branch-cleanups/:cleanup_id/retry',
    method: 'POST',
    path: '/v2/branch-cleanups/:cleanup_id/retry',
    service: 'ReconcileService',
    handler: 'ReconcileService.retryBranchCleanup',
    schema: {
      params: idParam('cleanup_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner', 'recovery_reviewer'],
    mutation: true,
    description: '重试分支清理（实际 Git 删除由 Reconcile 专用身份执行）',
  },
  {
    id: 'GET /v2/outbox/dead-letters',
    method: 'GET',
    path: '/v2/outbox/dead-letters',
    service: 'ReconcileService',
    handler: 'ReconcileService.listDeadLetters',
    schema: { querystring: cursorQuery },
    credentialScopes: ['human_owner'],
    mutation: false,
    description: 'dead-letter 清单（无 skip/mark-delivered 接口，D-045）',
  },
  {
    id: 'GET /v2/outbox/dead-letters/:event_id',
    method: 'GET',
    path: '/v2/outbox/dead-letters/:event_id',
    service: 'ReconcileService',
    handler: 'ReconcileService.getDeadLetter',
    schema: { params: idParam('event_id') },
    credentialScopes: ['human_owner'],
    mutation: false,
    description: 'dead-letter 详情（revision/payload digest/attempt 历史）',
  },
  {
    id: 'POST /v2/outbox/dead-letters/:event_id/requeue',
    method: 'POST',
    path: '/v2/outbox/dead-letters/:event_id/requeue',
    service: 'ReconcileService',
    handler: 'ReconcileService.requeueDeadLetter',
    schema: {
      params: idParam('event_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '原幂等键受审计 requeue（Incident owner 修复根因后）',
  },
  {
    id: 'POST /v2/outbox/dead-letters/:event_id/compensate',
    method: 'POST',
    path: '/v2/outbox/dead-letters/:event_id/compensate',
    service: 'ReconcileService',
    handler: 'ReconcileService.compensateDeadLetter',
    schema: {
      params: idParam('event_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '写 compensating event（带 compensates_event_id 与审计）',
  },

  /* ---- §13.1/§21 Phase 6 Human Identity 与凭据生命周期（IdentityService） ---- */
  {
    id: 'POST /v2/human-sessions',
    method: 'POST',
    path: '/v2/human-sessions',
    service: 'IdentityService',
    handler: 'IdentityService.issueHumanSession',
    schema: {
      body: {
        type: 'object',
        required: ['subject', 'role'],
        additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 1, maxLength: 128 },
          role: { type: 'string', enum: ['owner', 'project_admin', 'reviewer', 'auditor'] },
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          ttl_seconds: { type: 'integer', minimum: 1 },
        },
      },
      response: { 200: okResponse },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: 'Owner 签发 bvh2 人类会话（HMAC+exp+role+project 绑定；membership 前置校验）',
  },
  {
    id: 'POST /v2/human-sessions/:session_id/revoke',
    method: 'POST',
    path: '/v2/human-sessions/:session_id/revoke',
    service: 'IdentityService',
    handler: 'IdentityService.revokeHumanSession',
    schema: {
      params: idParam('session_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '吊销人类会话（revoke 即失效，R1C-013 同语义）',
  },
  {
    id: 'GET /v2/human-sessions',
    method: 'GET',
    path: '/v2/human-sessions',
    service: 'IdentityService',
    handler: 'IdentityService.listHumanSessions',
    schema: { querystring: cursorQuery, response: { 200: okResponse } },
    credentialScopes: ['human_owner'],
    mutation: false,
    description: '人类会话清单（吊销列表运维视图）',
  },
  {
    id: 'POST /v2/project-memberships',
    method: 'POST',
    path: '/v2/project-memberships',
    service: 'IdentityService',
    handler: 'IdentityService.grantProjectMembership',
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'subject', 'role'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          subject: { type: 'string', minLength: 1, maxLength: 128 },
          role: { type: 'string', enum: ['owner', 'project_admin', 'reviewer', 'auditor'] },
        },
      },
      response: { 200: okResponse },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '授予项目粒度 membership（(project_id, subject) 幂等改写）',
  },
  {
    id: 'POST /v2/project-memberships/:membership_id/revoke',
    method: 'POST',
    path: '/v2/project-memberships/:membership_id/revoke',
    service: 'IdentityService',
    handler: 'IdentityService.revokeProjectMembership',
    schema: {
      params: idParam('membership_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '撤销 membership（派生会话随 resolve 即时失效）',
  },
  {
    id: 'GET /v2/project-memberships',
    method: 'GET',
    path: '/v2/project-memberships',
    service: 'IdentityService',
    handler: 'IdentityService.listProjectMemberships',
    schema: { querystring: cursorQuery, response: { 200: okResponse } },
    credentialScopes: ['human_owner'],
    mutation: false,
    description: 'membership 清单（按 project 过滤）',
  },
  {
    id: 'POST /v2/nodes/:node_id/credential/rotate',
    method: 'POST',
    path: '/v2/nodes/:node_id/credential/rotate',
    service: 'IdentityService',
    handler: 'IdentityService.rotateNodeCredential',
    schema: {
      params: idParam('node_id'),
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: 'Node credential 轮换：credential_generation 原子前滚 + 旧 token 立即 fencing + 新 token 签发',
  },
  {
    id: 'POST /v2/security/revoke-all-sessions',
    method: 'POST',
    path: '/v2/security/revoke-all-sessions',
    service: 'IdentityService',
    handler: 'IdentityService.revokeAllSessions',
    schema: {
      body: {
        type: 'object',
        required: ['reason'],
        additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
      response: { 200: okResponse },
    },
    credentialScopes: ['human_owner'],
    mutation: true,
    description: '全局紧急撤销：按 key_version 前滚（durable 水位），bvn2/bva2/bvh2 全部旧 token 立即失效',
  },
];

/** 按服务统计条目数（门禁测试与交付说明引用）。 */
export function countRoutesByService(): Record<V2DomainServiceName, number> {
  const counts = {
    ProjectService: 0,
    NodeService: 0,
    AttemptService: 0,
    DeliveryService: 0,
    MergeService: 0,
    IncidentService: 0,
    ReconcileService: 0,
    IdentityService: 0,
  } as Record<V2DomainServiceName, number>;
  for (const entry of V2_ROUTES) counts[entry.service] += 1;
  return counts;
}
