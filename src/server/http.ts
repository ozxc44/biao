/**
 * Biao HTTP 服务（Fastify）
 * 对应 docs/biao/05-biao-service-spec.md
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Redis from 'ioredis';
import { createMcpHttpRoutes } from '../mcp/http-route.js';
import {
  planSubmit,
  planCreate,
  planTaskUpsert,
  agentRegister,
  agentHeartbeat,
  agentOffline,
  claim,
  report,
  ownershipCheck,
  ownershipDeclare,
  ownershipRelease,
  getTask,
  getTasks,
  getPendingReviewTasks,
  cancelTask,
  supersedeTask,
  previewPlanSupersede,
  supersedePlan,
  taskReset,
  renewLease,
  taskBlock,
  taskResume,
  createQuestion,
  listQuestions,
  getQuestion,
  answerQuestion,
  getReviewInfo,
  getResolutionDecision,
  resolutionDecision,
  pmReview,
  getDbStatus,
  dbRestoreManual,
  getPlan,
  getPlans,
  getStatus,
  getEvents,
  getConflicts,
  getActiveOwnership,
  reconcileRuntimeState,
  runWatchdog,
  unackedEvents,
  ackEvent,
  pmIntake,
  getRestoreMaintenanceGate,
  appendExecutionReceipt,
  supervisorTick,
  connectProjectAgent,
  deleteProjectAgentBinding,
  getProjectAgentBinding,
  getProjectAgentRoster,
  listExecutionReceipts,
  listProjectAgentBindings,
  reserveProjectAgentTask,
} from './service.js';
import { keys } from '../redis/keys.js';
import type { BiaoConfig } from '../types/index.js';
import type { SqliteStore } from '../db/sqlite-store.js';
import { resolveAndValidateWorkspacePath } from './security.js';
import {
  cookieSecureFlag,
  issueLocalOwnerSession,
  localOwnerClearCookie,
  localOwnerSetCookie,
  readCookie,
} from './human-session.js';
// 共享横切 plugin（鉴权/permit/barrier）——Phase 0a-2 起 V1/V2 路由面复用同一基础设施。
import {
  addSecurityHeadersOnSend,
  configureRateLimiting,
  corsWhitelistOnRequest,
  crossCuttingApiPlugin,
  hasLocalOwnerSession,
  humanSessionClearCookie,
  humanSessionSetCookie,
  HUMAN_SESSION_COOKIE,
  localOwnerSessionAvailable,
  resolveCorsOrigins,
  resolveHumanSessionCredential,
} from './http-plugins.js';
// 方案 E：远程人类 Cookie 会话（bvh2）+ 一次性 enrollment（bhe2）。
import { createHumanIdentityService, type HumanIdentityService } from './v2/human-identity.js';
import { CredentialKeyringAuthority, loadV2CredentialKeyring, type V2CredentialKey } from './v2/credentials.js';
// V2 路由插件（Phase 1）
import { v2RoutesPlugin } from './v2/routes/v2-routes.js';
// P12 车道 B：Worker SSE 唤醒通道（实现见 v2/attempt-service.ts 尾部）
import { registerV2WorkerEventStream } from './v2/attempt-service.js';
// P12 §9：webhook dispatcher（周期轮询 Redis events stream / conflicts / incidents）
import { createWebhookDispatcher } from './v2/webhook-service.js';
import {
  QUESTION_ANSWER_MAX_CHARS,
  QUESTION_BODY_MAX_CHARS,
  QUESTION_CHECKPOINT_MAX_CHARS,
} from '../communication/question-context.js';

type ScopedBiaoConfig = BiaoConfig & { workerApiToken?: string };

const WORKER_TOKEN_CONTEXT = 'biao-worker-api-token-v1';

/** P12 §9：webhook dispatcher 按 store 去重（apiRoutes 根路径 + /api 前缀注册两次）。 */
const startedWebhookDispatchersPerStore = new WeakSet<object>();

/** Derive a one-way, scope-specific bearer without persisting a second secret. */
export function deriveWorkerApiToken(ownerToken: string): string {
  return createHmac('sha256', ownerToken).update(WORKER_TOKEN_CONTEXT).digest('hex');
}

const INSTALL_PACKAGE_PLACEHOLDER = '__BIAO_PKG_POSIX__';

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function renderInstallScript(template: string, packageDir: string): string {
  if (!packageDir || /[\x00-\x1f\x7f]/.test(packageDir)) {
    throw new Error('安装包路径不能为空或包含控制字符/换行');
  }
  const placeholderCount = template.split(INSTALL_PACKAGE_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) {
    throw new Error(`安装脚本模板 placeholder 数量必须为 1，实际为 ${placeholderCount}`);
  }
  return template.replace(INSTALL_PACKAGE_PLACEHOLDER, posixSingleQuote(packageDir));
}

/** API 目录（根路径，无 /api 前缀；同时兼容 /api 前缀访问） */
const API_ENDPOINTS: Record<string, string> = {
  version: 'GET /version',
  health: 'GET /health',
  status: 'GET /status',
  plan_submit: 'POST /plan/submit',
  plan_create: 'POST /plan/create',
  plan_status: 'GET /plan/:plan_id',
  plans_list: 'GET /plans',
  project_agent_binding_list: 'GET /project/agent-bindings?project_scope=',
  project_agent_binding_get: 'GET /project/agent-bindings/:binding_id?project_scope=',
  project_agent_binding_delete: 'DELETE /project/agent-bindings/:binding_id?project_scope=',
  project_agent_connection_create: 'POST /project/agent-connections',
  project_agent_roster: 'GET /project/agent-roster?project_scope=',
  project_agent_reserve: 'POST /project/agent-reservations',
  execution_receipt_append: 'POST /execution-receipts',
  execution_receipt_list: 'GET /execution-receipts?project_scope=&binding_id=&task_id=',
  claim: 'POST /claim',
  report: 'POST /report',
  register: 'POST /register',
  heartbeat: 'POST /heartbeat',
  agent_offline: 'POST /agent/offline',
  task_get: 'GET /task/:task_id',
  tasks_list: 'GET /tasks?plan_id=&status=&limit=',
  reviews_pending: 'GET /reviews/pending?plan_id=',
  task_cancel: 'POST /task/:task_id/cancel',
  task_supersede: 'POST /task/:task_id/supersede',
  task_reset: 'POST /task/:task_id/reset',
  task_block: 'POST /task/:task_id/block',
  task_resume: 'POST /task/:task_id/resume',
  question_create: 'POST /question',
  questions_list: 'GET /questions?consumer=&status=open|answered|all&plan_id=',
  question_get: 'GET /question/:question_id?consumer=',
  question_answer: 'POST /question/:question_id/answer',
  lease_renew: 'POST /lease/renew',
  review_get: 'GET /task/:task_id/review',
  review_post: 'POST /task/:task_id/review',
  resolution_get: 'GET /task/:task_id/resolution',
  resolution_post: 'POST /task/:task_id/resolution',
  db_status: 'GET /db/status',
  db_restore: 'POST /db/restore',
  ownership_check: 'GET /ownership?path=&agent_id=',
  ownership_declare: 'POST /ownership/declare',
  ownership_release: 'POST /ownership/release',
  ownership_active: 'GET /ownership/active',
  events: 'GET /events?since=&limit= | GET /events?after=<stream-id>&limit=',
  events_stream: 'GET /events/stream (SSE 实时推送)',
  intake: 'GET /intake?consumer=&plan_id=&project_path= (PM 主动轮询提醒，被动门铃)',
  intake_unacked: 'GET /intake/unacked?consumer=&limit=&type= (按 consumer 查未确认事件)',
  intake_ack: 'POST /intake/ack (按 consumer 幂等确认事件)',
  conflicts: 'GET /conflicts?limit=',
  runtime_reconcile: 'POST /reconcile',
  supervisor_tick: 'GET /supervisor/tick?consumers=&events_after=&binding_aware=1&plan_ids=',
  plan_supersede_preview: 'GET /plan/:plan_id/supersede-preview',
  plan_supersede: 'POST /plan/:plan_id/supersede',
  watchdog: 'GET /watchdog?auto_fix=',
  install: 'GET /install (shell script)',
  frontend: 'GET / (Accept: text/html)',
  // 方案 E：Web 控制台远程人类登录（enrollment code → bvh2 Cookie 会话）
  auth_human_session: 'POST /auth/human-session (enrollment_code 换 Cookie 会话) | GET /auth/human-session (会话状态) | DELETE /auth/human-session (登出+吊销)',
  v2_human_enrollments: 'POST /v2/human-enrollments (owner-only：生成一次性 enrollment_code，仅创建响应返回一次)',
  // P12：webhook / 备份自动化 / 监控外接
  v2_webhooks: 'POST /v2/webhooks (owner 注册) | GET /v2/webhooks | GET/DELETE /v2/webhooks/:id | POST /v2/webhooks/:id/reactivate | POST /v2/webhooks/dispatch',
  v2_backup_run: 'POST /v2/backup/run (自动化备份，失败开 incident) | GET /v2/backup/status (最近备份状态)',
  v2_metrics_prometheus: 'GET /v2/metrics/prometheus (Prometheus 文本格式导出)',
  // V2 路由（Phase 1）
  v2_projects: 'POST /v2/projects | GET /v2/projects | GET /v2/projects/:project_id',
  v2_mode_transitions: 'POST /v2/projects/:project_id/mode-transitions',
  v2_nodes_enroll: 'POST /v2/nodes/enroll',
  v2_nodes_register: 'POST /v2/nodes/register',
  v2_nodes_heartbeat: 'POST /v2/nodes/:node_id/heartbeat',
  v2_nodes_drain: 'POST /v2/nodes/:node_id/drain',
  v2_nodes_revoke: 'POST /v2/nodes/:node_id/revoke',
  v2_nodes_authorize: 'POST /v2/projects/:project_id/nodes/:node_id/authorize',
};

const API_HINT = 'API 路径在根路径（无 /api 前缀，也兼容 /api 前缀）。curl http://localhost:7331/health 验证。';

/**
 * Redis 的 `$` 只能安全用于一次阻塞式 XREAD。这里采用非阻塞轮询，如果每轮继续
 * 使用 `$`，游标会反复跳到“此刻最新”并永久漏掉连接后的事件。建连时将它冻结为
 * 当前 stream 尾部的真实 ID；显式 last_id 则原样保留用于断线续传。
 */
export async function resolveEventStreamCursor(redis: Redis, requested: string): Promise<string> {
  if (requested !== '$') return requested;
  const latest = await redis.xrevrange(keys.stream.events, '+', '-', 'COUNT', 1);
  return latest[0]?.[0] ?? '0-0';
}

/**
 * Session 的创建只能来自控制台自己的同源浏览器请求。loopback 绑定保证请求来自本机，
 * Origin + Sec-Fetch-Site 再阻断第三方页面把访问者静默登录为本机 Owner（login CSRF）。
 */
function isSameOriginBrowserRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  const fetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined;
  return Boolean(host && origin === `http://${host}` && fetchSite === 'same-origin');
}

/**
 * 方案 E：远程人类会话的同源校验。与 isSameOriginBrowserRequest 同语义，但
 * 额外接受 https Origin——NAS 常见部署是反向代理做 TLS 终止（浏览器 https、
 * 服务收到 http Host），Origin 与 Host 仅 scheme 差异仍视为同源；第三方
 * Origin（不同 host）依旧拒绝。
 */
function isHumanSessionSameOriginRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  const fetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined;
  return Boolean(host && (origin === `http://${host}` || origin === `https://${host}`) && fetchSite === 'same-origin');
}

const nonEmptyString = { type: 'string', minLength: 1 } as const;
const absolutePath = { type: 'string', minLength: 1, pattern: '^/' } as const;
const safeIdentifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } as const;
const registrationIdentifier = {
  type: 'string',
  minLength: 16,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$',
} as const;
const taskParamsSchema = {
  type: 'object',
  required: ['task_id'],
  additionalProperties: false,
  properties: { task_id: nonEmptyString },
} as const;
const planParamsSchema = {
  type: 'object',
  required: ['plan_id'],
  additionalProperties: false,
  properties: { plan_id: safeIdentifier },
} as const;
const questionParamsSchema = {
  type: 'object',
  required: ['question_id'],
  additionalProperties: false,
  properties: { question_id: nonEmptyString },
} as const;

/**
 * Fastify 默认会移除额外字段；repair ownership 是 PM 的显式扩权审计，不能把未知字段
 * 静默吞掉后继续处理。因此在 schema 前保留原请求体做一次不改写的严格检查。
 * service.ts 仍会重复校验，覆盖直接 service 调用和并发状态检查。
 */
function validateRepairOwnershipRequest(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const extension = (body as Record<string, unknown>).repair_ownership;
  if (extension === undefined) return undefined;
  if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
    return 'repair_ownership 必须是包含 files 和/或 modules 数组的对象';
  }
  const record = extension as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'files' && key !== 'modules')) {
    return 'repair_ownership 只允许 files 和 modules 字段';
  }

  let total = 0;
  for (const key of ['files', 'modules'] as const) {
    const entries = record[key];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return `repair_ownership.${key} 必须是字符串数组`;
    if (entries.length > 64) return `repair_ownership.${key} 最多 64 项`;
    total += entries.length;
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.trim()) return `repair_ownership.${key} 不能包含空字符串`;
      if (entry.trim().length > 512 || /[\u0000-\u001F\u007F,]/.test(entry)) {
        return `repair_ownership.${key} 每项最长 512 字符且不能包含控制字符或逗号`;
      }
    }
  }
  if (total === 0 || total > 64) return 'repair_ownership 必须至少包含一项，且总数最多 64 项';
  if ((body as Record<string, unknown>).verdict !== 'reject') return 'repair_ownership 只能用于 reject';
  return undefined;
}

function validateSupersedeRequestKeys(body: unknown, plan: boolean): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const allowed = new Set([
    'reason', 'superseded_by', 'confirmed',
    ...(plan ? ['preview_token'] : []),
  ]);
  const unknown = Object.keys(body as Record<string, unknown>).find((key) => !allowed.has(key));
  return unknown ? `supersede 请求包含未知字段：${unknown}` : undefined;
}

function validateExactRequestKeys(body: unknown, allowed: readonly string[]): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const accepted = new Set(allowed);
  const unknown = Object.keys(body as Record<string, unknown>).find((key) => !accepted.has(key));
  return unknown ? `请求包含未知字段：${unknown}` : undefined;
}

const requestSchemas = {
  projectAgentConnectionCreate: {
    body: {
      type: 'object',
      required: ['project_scope', 'agent_id'],
      additionalProperties: false,
      properties: { project_scope: absolutePath, agent_id: safeIdentifier },
    },
  },
  projectAgentReservation: {
    body: {
      type: 'object',
      required: ['project_scope', 'binding_id'],
      additionalProperties: false,
      properties: {
        project_scope: absolutePath,
        binding_id: safeIdentifier,
        task_id: safeIdentifier,
        preferred_plan_ids: { type: 'array', uniqueItems: true, items: safeIdentifier },
      },
    },
  },
  executionReceiptCreate: {
    body: {
      type: 'object',
      required: [
        'project_scope', 'attempt_id', 'task_id', 'binding_id', 'agent_id', 'registration_id',
        'harness_kind', 'wake_mode', 'adapter_id', 'status', 'started_at',
      ],
      additionalProperties: false,
      properties: {
        project_scope: absolutePath,
        attempt_id: safeIdentifier,
        task_id: safeIdentifier,
        binding_id: safeIdentifier,
        agent_id: safeIdentifier,
        registration_id: safeIdentifier,
        harness_kind: safeIdentifier,
        wake_mode: { type: 'string', enum: ['visible_session', 'background_executor', 'external_worker'] },
        adapter_id: { anyOf: [safeIdentifier, { type: 'null' }] },
        status: { type: 'string', enum: ['requested', 'succeeded', 'failed'] },
        started_at: { type: 'integer', minimum: 0 },
        session_ref: { type: 'string', minLength: 1, maxLength: 256 },
        visible_url: { type: 'string', minLength: 1, maxLength: 2048 },
      },
    },
  },
  planCreate: {
    body: {
      type: 'object',
      required: ['plan_id', 'project_path'],
      additionalProperties: false,
      properties: {
        plan_id: safeIdentifier,
        title: { type: 'string', minLength: 1 },
        project_path: absolutePath,
        base_dir: absolutePath,
        submit: { type: 'boolean' },
        skeleton: { type: 'boolean' },
        pm_consumer: safeIdentifier,
      },
    },
  },
  planSubmit: {
    body: {
      type: 'object',
      required: ['plan_dir'],
      additionalProperties: false,
      properties: {
        plan_dir: nonEmptyString,
        expected_preview: {
          type: 'object',
          required: ['plan_id', 'plan_revision', 'tasks'],
          additionalProperties: false,
          properties: {
            plan_id: safeIdentifier,
            plan_revision: { type: 'string', pattern: '^[0-9]+$' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                required: ['task_id', 'status', 'revision', 'lease_present'],
                additionalProperties: false,
                properties: {
                  task_id: safeIdentifier,
                  status: { type: 'string', minLength: 1, maxLength: 32 },
                  revision: { type: 'string', pattern: '^(?:missing|[a-f0-9]{64})$' },
                  lease_present: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  },
  planTaskUpsert: {
    params: planParamsSchema,
    body: {
      type: 'object',
      required: ['task_id', 'title'],
      additionalProperties: false,
      properties: {
        task_id: safeIdentifier,
        title: { type: 'string', minLength: 1, maxLength: 200 },
        type: { type: 'string', enum: ['code', 'review', 'research', 'docs', 'acceptance'] },
        phase: nonEmptyString,
        assignee: nonEmptyString,
        priority: { type: 'integer', minimum: 0, maximum: 9 },
        timeout_seconds: { type: 'integer', minimum: 60, maximum: 86_400 },
        goal_md: { type: 'string', maxLength: 65_536 },
        verify: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            required: ['cmd'],
            additionalProperties: false,
            properties: {
              cmd: { type: 'string', minLength: 1, maxLength: 2_000 },
              expect_exit: { type: 'integer', minimum: 0, maximum: 255 },
            },
          },
        },
        ownership: {
          type: 'object',
          additionalProperties: false,
          properties: {
            files: { type: 'array', maxItems: 64, items: nonEmptyString },
            modules: { type: 'array', maxItems: 64, items: nonEmptyString },
          },
        },
        depends_on: { type: 'array', maxItems: 64, items: nonEmptyString },
        acceptance_for: { type: 'array', maxItems: 64, items: nonEmptyString },
      },
    },
  },
  claim: {
    body: {
      type: 'object',
      required: ['agent_id', 'registration_id', 'claim_request_id'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        registration_id: registrationIdentifier,
        claim_request_id: registrationIdentifier,
        blocking: { type: 'boolean' },
        timeout_ms: { type: 'integer', minimum: 0, maximum: 60_000 },
        preferred_types: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', enum: ['code', 'review', 'research', 'docs', 'acceptance'] },
        },
        preferred_phases: { type: 'array', uniqueItems: true, items: nonEmptyString },
        preferred_project: nonEmptyString,
        preferred_plan_ids: { type: 'array', uniqueItems: true, items: safeIdentifier },
        reservation_id: { type: 'string', pattern: '^reservation_[a-f0-9]{32}$' },
      },
    },
  },
  register: {
    body: {
      type: 'object',
      required: ['agent_id', 'agent_type'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        agent_type: nonEmptyString,
        capabilities: { type: 'array', uniqueItems: true, items: nonEmptyString },
        endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
        projects: { type: 'array', uniqueItems: true, items: absolutePath },
        // 兼容旧自定义 Worker：register 可以不传，平台生成后返回；
        // 但后续 heartbeat/offline 必须携带返回值。
        registration_id: registrationIdentifier,
        // 注册即自动绑定：Agent 声明要加入的项目列表，平台自动创建绑定
        project_bindings: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            required: ['project_scope'],
            additionalProperties: false,
            properties: {
              project_scope: absolutePath,
              wake_mode: { type: 'string', enum: ['visible_session', 'background_executor', 'external_worker'] },
              policy: { type: 'string', enum: ['manual', 'on_demand', 'automatic'] },
            },
          },
        },
      },
    },
  },
  heartbeat: {
    body: {
      type: 'object',
      required: ['agent_id', 'registration_id'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        registration_id: registrationIdentifier,
        // 历史自定义 Worker 会显式传空串表示 idle。
        current_task: { type: 'string', maxLength: 128 },
      },
    },
  },
  agentOffline: {
    body: {
      type: 'object',
      required: ['agent_id', 'registration_id', 'reason'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        registration_id: registrationIdentifier,
        reason: {
          type: 'string',
          enum: ['worker_exit', 'worker_signal', 'plans_terminal', 'supervisor_signal', 'supervisor_exit'],
        },
      },
    },
  },
  report: {
    body: {
      type: 'object',
      required: ['task_id', 'agent_id', 'claim_token', 'status'],
      additionalProperties: false,
      properties: {
        task_id: nonEmptyString,
        agent_id: nonEmptyString,
        claim_token: nonEmptyString,
        status: { type: 'string', enum: ['done', 'failed', 'partial'] },
        result_path: nonEmptyString,
        result_json_path: nonEmptyString,
        result_md: { type: 'string', maxLength: 131072 },
        result_json: { type: 'string', maxLength: 262144 },
        execute_verify: { type: 'boolean' },
        verify_results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['cmd', 'exit_code', 'passed'],
            additionalProperties: false,
            properties: {
              cmd: nonEmptyString,
              exit_code: { type: 'integer' },
              passed: { type: 'boolean' },
              output: { type: 'string' },
            },
          },
        },
      },
    },
  },
  taskReset: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      additionalProperties: false,
      properties: { force: { type: 'boolean' }, reset_by: nonEmptyString },
    },
  },
  taskSupersede: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      required: ['reason', 'superseded_by', 'confirmed'],
      additionalProperties: false,
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 2_000 },
        superseded_by: { type: 'string', minLength: 1, maxLength: 128 },
        confirmed: { const: true },
      },
    },
  },
  planSupersede: {
    params: planParamsSchema,
    body: {
      type: 'object',
      required: ['reason', 'superseded_by', 'confirmed', 'preview_token'],
      additionalProperties: false,
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: 2_000 },
        superseded_by: { type: 'string', minLength: 1, maxLength: 128 },
        confirmed: { const: true },
        preview_token: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
  },
  taskBlock: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      required: ['agent_id', 'claim_token', 'reason'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        claim_token: nonEmptyString,
        reason: {
          type: 'string',
          enum: ['waiting_file_release', 'waiting_dependency'],
        },
        question_id: nonEmptyString,
      },
    },
  },
  taskResume: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      required: ['agent_id'],
      additionalProperties: false,
      properties: { agent_id: nonEmptyString },
    },
  },
  questionCreate: {
    body: {
      type: 'object',
      required: ['task_id', 'agent_id', 'claim_token', 'body'],
      additionalProperties: false,
      properties: {
        task_id: nonEmptyString,
        agent_id: nonEmptyString,
        claim_token: nonEmptyString,
        body: { type: 'string', minLength: 1, maxLength: QUESTION_BODY_MAX_CHARS },
        checkpoint: { type: 'string', maxLength: QUESTION_CHECKPOINT_MAX_CHARS },
        requested_ownership: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            files: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } },
            modules: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } },
          },
        },
      },
    },
  },
  questionAnswer: {
    params: questionParamsSchema,
    body: {
      type: 'object',
      required: ['consumer', 'answer'],
      additionalProperties: false,
      properties: {
        consumer: safeIdentifier,
        plan_id: safeIdentifier,
        answer: { type: 'string', minLength: 1, maxLength: QUESTION_ANSWER_MAX_CHARS },
        ownership_decision: { type: 'string', enum: ['approved', 'rejected'] },
      },
    },
  },
  taskReview: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      required: ['verdict', 'reviewed_by'],
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['accept', 'reject'] },
        reviewed_by: nonEmptyString,
        comment: { type: 'string' },
        reject_reason: { type: 'string' },
        fix_instructions: { type: 'string' },
        resolution_mode: { type: 'string', enum: ['repair', 'reverify'] },
        reverify: { type: 'boolean' },
        repair_ownership: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            files: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 512 },
            },
            modules: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 512 },
            },
          },
        },
      },
    },
  },
  resolutionDecision: {
    params: taskParamsSchema,
    body: {
      type: 'object',
      required: ['action', 'decided_by'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['inspect', 'continue', 'cancel'] },
        decided_by: nonEmptyString,
        repair_source_task_id: nonEmptyString,
        repair_source_task_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: nonEmptyString,
        },
      },
    },
  },
  ownershipDeclare: {
    body: {
      type: 'object',
      required: ['agent_id', 'task_id', 'claim_token', 'files'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        task_id: nonEmptyString,
        claim_token: nonEmptyString,
        files: { type: 'array', minItems: 1, uniqueItems: true, items: nonEmptyString },
        force: { type: 'boolean' },
      },
    },
  },
  ownershipRelease: {
    body: {
      type: 'object',
      required: ['agent_id', 'task_id', 'claim_token', 'files'],
      additionalProperties: false,
      properties: {
        agent_id: nonEmptyString,
        task_id: nonEmptyString,
        claim_token: nonEmptyString,
        files: { type: 'array', minItems: 1, uniqueItems: true, items: nonEmptyString },
      },
    },
  },
  dbRestore: {
    body: { type: 'object', additionalProperties: false },
  },
  intakeAck: {
    body: {
      type: 'object',
      required: ['consumer', 'event_id'],
      additionalProperties: false,
      properties: {
        consumer: safeIdentifier,
        event_id: nonEmptyString,
        plan_id: safeIdentifier,
      },
    },
  },
  // 方案 E：enrollment_code 换远程人类 Cookie 会话
  humanSessionCreate: {
    body: {
      type: 'object',
      required: ['enrollment_code'],
      additionalProperties: false,
      properties: {
        enrollment_code: { type: 'string', minLength: 8, maxLength: 256 },
      },
    },
  },
  // 方案 E：Owner 预登记人类身份（一次性 enrollment_code）
  humanEnrollmentCreate: {
    body: {
      type: 'object',
      required: ['subject', 'role'],
      additionalProperties: false,
      properties: {
        subject: safeIdentifier,
        role: { type: 'string', enum: ['owner', 'project_admin', 'reviewer', 'auditor'] },
        project_id: safeIdentifier,
        expires_in_hours: { type: 'integer', minimum: 1, maximum: 168 },
      },
    },
  },
} as const;

/** 推断 web/dist 路径（packages/biao/web/dist） */
function findWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server/http.js → ../../web/dist
  const candidates = [
    join(here, '..', '..', 'web', 'dist'),
    join(here, '..', '..', '..', 'web', 'dist'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function createHttpServer(
  redis: Redis,
  config: ScopedBiaoConfig,
  options: { webDist?: string | null; sqliteStore?: SqliteStore; artifactRoot?: string } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: 'info' },
    ajv: { customOptions: { coerceTypes: false } },
  });

  // V2 Artifact 上传接受 application/octet-stream（三段式上传 PUT content）
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // 子插件会继承注册时已存在的错误处理器，因此必须在挂载 API 路由前配置。
  app.setErrorHandler((err: unknown, _req, reply) => {
    app.log.error(err);
    const e = err as { code?: string; message?: string; statusCode?: number };
    const code = e.code;
    const validationError = code === 'FST_ERR_VALIDATION';
    // P12 §11：@fastify/rate-limit 抛出的 429 带 statusCode，必须原样透传
    // （否则会被下面默认分支折叠成 500，限流响应失真）。
    const statusCode = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500
      ? e.statusCode
      : null;
    const httpStatus = statusCode ?? (validationError ? 400 : code === 'WORKSPACE_PATH_DENIED' ? 403 : 500);
    reply.status(httpStatus).send({
      ok: false,
      data: null,
      error: {
        code: statusCode === 429 ? 'RATE_LIMIT_EXCEEDED' : validationError ? 'INVALID_REQUEST' : code ?? 'INTERNAL_ERROR',
        message: e.message ?? '内部错误',
      },
    });
  });

  // biao 包根目录（dist/server/http.js → ../../）
  const here = dirname(fileURLToPath(import.meta.url));
  const biaoPkgDir = join(here, '..', '..');

  const webDist = options.webDist === undefined ? findWebDist() : options.webDist;

  // P12 §11：全局速率限制（@fastify/rate-limit；test runtime 默认不启用）。
  // 必须在路由注册前装配（global: true 的 onRequest 钩子覆盖全部子作用域路由）。
  // 返回的配置同时用于登录/enrollment 端点的更严路由级限流（env 可调）。
  const rateLimitConfig = await configureRateLimiting(app, { redis });

  // P12 §14：安全响应头（X-Content-Type-Options / X-Frame-Options）全响应统一加。
  addSecurityHeadersOnSend(app);

  // P12 §14：CORS 白名单（BIAO_CORS_ORIGINS 逗号分隔；未配置不改变现状）。
  corsWhitelistOnRequest(app, resolveCorsOrigins());

  // API 路由（根路径 + /api 前缀各注册一次，内容一致）
  const apiRoutes = async (app: FastifyInstance) => {
    // 方案 E：远程人类会话身份服务。密钥环权威与 v2-routes.ts 同源构造
    // （env ∪ DB 轮换密钥，按 min_key_version 水位过滤）——两个实例共享同一
    // SQLite store，吊销/撤销对彼此立即可见（每请求复核）。
    const identityStore = options.sqliteStore;
    const humanIdentityKeyring = identityStore
      ? new CredentialKeyringAuthority({
          loadEnvKeys: (): V2CredentialKey[] => {
            try {
              return loadV2CredentialKeyring();
            } catch {
              return [];
            }
          },
          loadPersistedKeys: () => identityStore.listCredentialKeyRecords(),
          loadMinKeyVersion: () => identityStore.getCredentialState().min_key_version,
        })
      : null;
    const humanIdentity: HumanIdentityService | undefined = identityStore && humanIdentityKeyring
      ? createHumanIdentityService(identityStore, { keyring: (): V2CredentialKey[] => humanIdentityKeyring.resolve() })
      : undefined;

    // 横切关注点（onRequest 鉴权 / preHandler 维护屏障+mutation permit /
    // preSerialization 二次门控 + permit 释放）由共享 plugin 提供——Phase 0a-2
    // 抽出，V1/V2 路由面复用同一基础设施；行为与旧内联实现逐行等价。
    await crossCuttingApiPlugin(app, {
      redis,
      apiToken: config.apiToken,
      workerApiToken: config.workerApiToken,
      host: config.host,
      humanIdentity,
    });

    // MCP 装配点：P0 LAN MVP 只提供各开发机本地 stdio 适配器（scripts/mcp-server.mjs），
    // 中央 Streamable HTTP MCP 等 RBAC 后以独立变更启用；当前插件有意不注册路由。
    await app.register(createMcpHttpRoutes(redis, {
      biaoUrl: `http://${config.host}:${config.port}`,
      lockDir: process.env.BIAO_LOCK_DIR?.trim() || tmpdir(),
    }));

    // 人类 PM 使用 HttpOnly 的本机 Owner 会话；Agent 继续走 Bearer Token。Cookie 从不携带
    // BIAO_API_TOKEN，本机服务重启也可用同一配置密钥验证；旋转 API Token 会立即失效全部会话。
    app.get('/auth/session', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!config.apiToken) {
        return { ok: true, data: { authenticated: true, mode: 'auth_disabled', local_session_available: false } };
      }
      return {
        ok: true,
        data: {
          authenticated: hasLocalOwnerSession(req.headers.cookie, config),
          mode: 'local_owner',
          local_session_available: localOwnerSessionAvailable(config),
        },
      };
    });

    app.post('/auth/local-session', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!localOwnerSessionAvailable(config)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: { code: 'LOCAL_SESSION_UNAVAILABLE', message: '本机 Owner 会话只允许 loopback 部署' },
        });
      }
      if (!isSameOriginBrowserRequest(req.headers)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: { code: 'LOCAL_SESSION_ORIGIN_DENIED', message: '本机 Owner 会话必须从控制台同源页面创建' },
        });
      }
      reply.header('Set-Cookie', localOwnerSetCookie(issueLocalOwnerSession(config.apiToken!)));
      return { ok: true, data: { authenticated: true, mode: 'local_owner', local_session_available: true } };
    });

    // 方案 E 增补：用户名+密码登录（同一账户可反复登录）
    // P12 §11：用户名+密码登录是暴力破解面 → loginMax req/min 独立限流（默认 10）。
    app.post('/auth/human-login', { config: { rateLimit: { max: rateLimitConfig.loginMax, timeWindow: 60_000 } } }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const body = req.body as { username?: string; password?: string };
      if (!body?.username || !body?.password) {
        return reply.status(400).send({
          ok: false, data: null,
          error: { code: 'INVALID_REQUEST', message: '需要 username 和 password' },
        });
      }
      // 用户名密码登录不做 Origin/Sec-Fetch-Site 校验：用户主动输入凭据，
      // 无 CSRF 风险；且 NAS 反代/端口映射场景下 Origin 头可能不精确匹配。
      const { verifyHumanAccount, issueHumanSessionToken } = await import('./v2/human-identity.js');
      const { getSqliteStore } = await import('./service.js');
      const sqliteStoreInstance = getSqliteStore();
      if (!sqliteStoreInstance) {
        return reply.status(503).send({ ok: false, data: null, error: { code: 'CONTROL_PLANE_UNAVAILABLE', message: '控制面不可用' } });
      }
      const verified = await verifyHumanAccount(sqliteStoreInstance, body.username, body.password);
      if (!verified.ok || !verified.data) {
        return reply.status(401).send(verified);
      }
      const keyring = loadV2CredentialKeyring();
      if (!keyring || keyring.length === 0) {
        return reply.status(503).send({ ok: false, data: null, error: { code: 'V2_CREDENTIAL_KEY_MISSING', message: '服务端未配置 BIAO_V2_CREDENTIAL_KEY' } });
      }
      // 用 issueSession 正确写 human_sessions 行（否则 resolveCredential 会因无会话记录而拒绝）
      if (!humanIdentity) {
        return reply.status(503).send({ ok: false, data: null, error: { code: 'HUMAN_IDENTITY_UNAVAILABLE', message: '人类身份服务不可用' } });
      }
      const session = humanIdentity.issueSession(
        { subject: verified.data.username, role: verified.data.role as 'owner', project_id: verified.data.project_id || '' },
        { actor_id: verified.data.username, correlation_id: 'human-login-' + Date.now() },
      );
      if (!session.ok || !session.data) {
        return reply.status(500).send({ ok: false, data: null, error: session.error ?? { code: 'SESSION_ISSUE_FAILED', message: '会话签发失败' } });
      }
      const ttl = 30 * 24 * 60 * 60;
      // P12 §14：BIAO_HTTPS=1 时该 Cookie 同样加 Secure flag（与 humanSessionSetCookie 一致）。
      reply.header('Set-Cookie', 'biao_human_session=' + session.data.token + '; Path=/; Max-Age=' + ttl + '; HttpOnly; SameSite=Strict' + cookieSecureFlag());
      return {
        ok: true,
        data: { authenticated: true, subject: verified.data.username, role: verified.data.role },
      };
    });

    // Owner 创建用户账户
    app.post('/auth/human-accounts', async (req, reply) => {
      if (req.headers.authorization !== 'Bearer ' + config.apiToken && !hasLocalOwnerSession(req.headers.cookie, config)) {
        return reply.status(401).send({ ok: false, data: null, error: { code: 'UNAUTHORIZED', message: '需要 Owner 权限' } });
      }
      const body = req.body as { username: string; password: string; role: string; project_id?: string };
      const { createHumanAccount } = await import('./v2/human-identity.js');
      const { getSqliteStore } = await import('./service.js');
      const sqliteStoreInstance = getSqliteStore();
      if (!sqliteStoreInstance) {
        return { ok: false, data: null, error: { code: 'CONTROL_PLANE_UNAVAILABLE', message: '控制面不可用' } };
      }
      return createHumanAccount(sqliteStoreInstance, body);
    });

    app.delete('/auth/local-session', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isSameOriginBrowserRequest(req.headers)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: { code: 'LOCAL_SESSION_ORIGIN_DENIED', message: '本机 Owner 会话必须从控制台同源页面创建' },
        });
      }
      reply.header('Set-Cookie', localOwnerClearCookie());
      return {
        ok: true,
        data: {
          authenticated: false,
          mode: config.apiToken ? 'local_owner' : 'auth_disabled',
          local_session_available: localOwnerSessionAvailable(config),
        },
      };
    });

    // ── 方案 E：Web 控制台远程人类登录（bvh2 Cookie 会话 + 一次性 enrollment） ──
    // 公开会话端点（同 /auth/local-session）：不鉴权进入，靠 enrollment_code
    // 本身的持有证明 + 同源校验防 login CSRF。
    app.get('/auth/human-session', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!humanIdentity) {
        return { ok: true, data: { authenticated: false, available: false, expired: false } };
      }
      const session = resolveHumanSessionCredential(req.headers.cookie, humanIdentity);
      if (session) {
        return {
          ok: true,
          data: {
            authenticated: true,
            available: true,
            expired: false,
            subject: session.claims.subject,
            role: session.claims.role,
            project_id: session.claims.project_id,
            session_id: session.claims.session_id,
            expires_at: session.claims.expires_at,
          },
        };
      }
      // Cookie 存在但复核失败时仅提示过期语义（不回传 token、不区分其他失败原因）
      const rawCookie = readCookie(req.headers.cookie, HUMAN_SESSION_COOKIE);
      let expired = false;
      if (rawCookie) {
        const resolved = humanIdentity.resolveCredential(rawCookie);
        expired = !resolved.ok && resolved.reason === 'EXPIRED';
      }
      return { ok: true, data: { authenticated: false, available: true, expired } };
    });

    // P12 §11：enrollment code 消费按 IP 冷却 → enrollmentMax req/min（默认 5，防枚举暴力破解）。
    app.post('/auth/human-session', {
      schema: requestSchemas.humanSessionCreate,
      config: { rateLimit: { max: rateLimitConfig.enrollmentMax, timeWindow: 60_000 } },
    }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!humanIdentity) {
        return reply.status(503).send({
          ok: false,
          data: null,
          error: { code: 'HUMAN_SESSION_UNAVAILABLE', message: '远程人类会话未启用（服务需要 SQLite 持久化与 BIAO_V2_CREDENTIAL_KEY）' },
        });
      }
      if (!isHumanSessionSameOriginRequest(req.headers)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: { code: 'HUMAN_SESSION_ORIGIN_DENIED', message: '远程人类会话必须从控制台同源页面创建' },
        });
      }
      const { enrollment_code } = req.body as { enrollment_code: string };
      const result = humanIdentity.consumeEnrollment(enrollment_code, {
        used_by_ip: req.ip,
        correlation_id: `corr-${Date.now()}`,
      });
      if (!result.ok || !result.data) {
        const code = result.ok ? 'INTERNAL_ERROR' : (result.error?.code ?? 'LOGIN_FAILED');
        const status = code === 'ENROLLMENT_ALREADY_USED' ? 409
          : code === 'ENROLLMENT_EXPIRED' ? 403
            : code === 'ENROLLMENT_NOT_FOUND' ? 401
              : 400;
        return reply.status(status).send({
          ok: false,
          data: null,
          error: result.error ?? { code, message: '登录失败' },
        });
      }
      reply.header('Set-Cookie', humanSessionSetCookie(result.data.token));
      return {
        ok: true,
        data: {
          authenticated: true,
          subject: result.data.subject,
          role: result.data.role,
          project_id: result.data.project_id,
          session_id: result.data.session_id,
          expires_at: result.data.expires_at,
          // 主通道是 HttpOnly Cookie；token 同时放响应体供需要时存 sessionStorage 备用
          token: result.data.token,
        },
      };
    });

    app.delete('/auth/human-session', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isHumanSessionSameOriginRequest(req.headers)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: { code: 'HUMAN_SESSION_ORIGIN_DENIED', message: '远程人类会话必须从控制台同源页面创建' },
        });
      }
      // 吊销即时生效：human_sessions 落 revoked 行（R1C-013），再清 Cookie。
      const session = humanIdentity && resolveHumanSessionCredential(req.headers.cookie, humanIdentity);
      if (session) {
        humanIdentity!.revokeSession(session.claims.session_id, { reason: 'web_console_logout' }, {
          actor_id: session.claims.subject,
          correlation_id: `corr-${Date.now()}`,
        });
      }
      reply.header('Set-Cookie', humanSessionClearCookie());
      return { ok: true, data: { authenticated: false } };
    });

    // GET / → JSON 返回 API 目录；Accept: text/html 时返回前端看板
    app.get('/', async (req, reply) => {
      const accept = req.headers.accept ?? '';
      if (accept.includes('text/html') && !accept.includes('application/json')) {
        if (webDist) return reply.sendFile('index.html');
        return reply.status(404).send({
          ok: false,
          data: null,
          error: { code: 'FRONTEND_UNAVAILABLE', message: '前端尚未构建' },
        });
      }
      return {
        ok: true,
        service: 'biao',
        version: '0.1.0',
        endpoints: API_ENDPOINTS,
        hint: API_HINT,
      };
    });

    // GET /install → 返回安装脚本；包路径会按 POSIX shell 单引号规则注入唯一占位点。
    // 用户可见输出保持英文，避免非 UTF-8 locale 下管道执行时乱码
    app.get('/install', async (_req, reply) => {
      const tpl = readFileSync(join(biaoPkgDir, 'scripts', 'install.sh'), 'utf8');
      const script = renderInstallScript(tpl, biaoPkgDir);
      reply.header('Content-Type', 'text/x-shellscript; charset=utf-8').send(script);
    });

    app.get('/version', async () => {
      return { ok: true, data: { version: '0.1.0', name: 'biao', protocol_version: 2 } };
    });

    app.get('/health', async (_req, reply) => {
      try {
        await redis.ping();
        const gate = await getRestoreMaintenanceGate(redis);
        if (gate) {
          return reply.status(503).send({ ok: false, data: null, error: gate });
        }
        return { ok: true, data: { redis: 'connected', version: 'v1' } };
      } catch {
        return reply.status(503).send({ ok: false, data: null, error: { code: 'REDIS_UNAVAILABLE', message: 'redis 不可达' } });
      }
    });

    app.post('/register', {
      schema: requestSchemas.register,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, [
          'agent_id', 'agent_type', 'capabilities', 'endpoint', 'projects', 'registration_id', 'project_bindings',
        ]);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { agent_id, agent_type, capabilities, endpoint, projects, registration_id, project_bindings } = req.body as {
        agent_id: string;
        agent_type: string;
        capabilities?: string[];
        endpoint?: string;
        projects?: string[];
        registration_id?: string;
        project_bindings?: Array<{ project_scope: string; wake_mode?: string; policy?: string }>;
      };
      const validatedProjects = projects?.map((project) => resolveAndValidateWorkspacePath(project, config.workspaceRoots));
      const validatedBindings = project_bindings?.map((pb) => ({
        project_scope: resolveAndValidateWorkspacePath(pb.project_scope, config.workspaceRoots),
        ...(pb.wake_mode ? { wake_mode: pb.wake_mode as 'visible_session' | 'background_executor' | 'external_worker' } : {}),
        ...(pb.policy ? { policy: pb.policy as 'manual' | 'on_demand' | 'automatic' } : {}),
      }));
      return agentRegister(redis, agent_id, agent_type, capabilities ?? [], endpoint, validatedProjects, registration_id, validatedBindings);
    });

    app.post('/heartbeat', {
      schema: requestSchemas.heartbeat,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, ['agent_id', 'registration_id', 'current_task']);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { agent_id, registration_id, current_task } = req.body as {
        agent_id: string;
        registration_id: string;
        current_task?: string;
      };
      return agentHeartbeat(redis, agent_id, registration_id, current_task);
    });

    app.post('/agent/offline', {
      schema: requestSchemas.agentOffline,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, ['agent_id', 'registration_id', 'reason']);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { agent_id, registration_id, reason } = req.body as {
        agent_id: string;
        registration_id: string;
        reason: Parameters<typeof agentOffline>[2];
      };
      return agentOffline(redis, agent_id, reason, registration_id);
    });

    app.post('/claim', {
      schema: requestSchemas.claim,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, [
          'agent_id', 'registration_id', 'claim_request_id', 'blocking', 'timeout_ms', 'preferred_types',
          'preferred_phases', 'preferred_project', 'preferred_plan_ids', 'reservation_id',
        ]);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req, reply) => {
      const body = { ...(req.body as Parameters<typeof claim>[1]) };
      if (body.preferred_project) {
        body.preferred_project = resolveAndValidateWorkspacePath(body.preferred_project, config.workspaceRoots);
      }
      const abortController = new AbortController();
      const abortClaim = () => {
        if (!reply.raw.writableEnded) abortController.abort();
      };
      req.raw.once('aborted', abortClaim);
      reply.raw.once('close', abortClaim);
      try {
        return await claim(redis, body, abortController.signal);
      } finally {
        req.raw.off('aborted', abortClaim);
        reply.raw.off('close', abortClaim);
      }
    });

    app.get('/task/:task_id', async (req) => {
      const { task_id } = req.params as { task_id: string };
      return getTask(redis, task_id);
    });

    // GET /tasks?plan_id=&status=&limit=&offset= —— 批量查询任务（对应 biao task list）
    app.get('/tasks', async (req) => {
      const { plan_id, status, limit, offset } = req.query as {
        plan_id?: string; status?: string; limit?: string; offset?: string;
      };
      const opts: { plan_id?: string; status?: string; limit?: number; offset?: number } = {};
      if (plan_id) opts.plan_id = plan_id;
      if (status) opts.status = status;
      if (limit) {
        const n = Number(limit);
        if (!Number.isNaN(n)) opts.limit = n;
      }
      if (offset) {
        const n = Number(offset);
        if (!Number.isNaN(n)) opts.offset = n;
      }
      return getTasks(redis, opts);
    });

    // GET /reviews/pending?plan_id= —— 直接按当前待验收索引列出，不扫描/截断 done 历史
    app.get('/reviews/pending', async (req) => {
      const { plan_id } = req.query as { plan_id?: string };
      return getPendingReviewTasks(redis, plan_id ? { plan_id } : {});
    });

    // POST /task/:task_id/cancel —— 撤销 pending 任务（对应 biao task cancel）
    app.post('/task/:task_id/cancel', async (req) => {
      const { task_id } = req.params as { task_id: string };
      return cancelTask(redis, task_id, req.body as { reason?: string });
    });

    // 历史伪完成退出验收：不复用 reset，不清空 result/review；必须带理由与显式确认。
    app.post('/task/:task_id/supersede', {
      schema: requestSchemas.taskSupersede,
      preValidation: async (req, reply) => {
        const message = validateSupersedeRequestKeys(req.body, false);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      return supersedeTask(redis, task_id, req.body as Parameters<typeof supersedeTask>[2]);
    });

    // POST /task/:task_id/reset —— 重置任务到 pending（PM 手动，对应 P22）
    app.post('/task/:task_id/reset', { schema: requestSchemas.taskReset }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      const body = req.body as { force?: boolean; reset_by?: string };
      return taskReset(redis, task_id, body ?? {});
    });

    // POST /task/:task_id/block —— 仅当前 lease holder 可搁置文件/依赖等待；PM Question 走 /question。
    app.post('/task/:task_id/block', { schema: requestSchemas.taskBlock }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      const body = req.body as { agent_id: string; claim_token: string; reason: 'waiting_file_release' | 'waiting_dependency'; question_id?: string };
      return taskBlock(redis, task_id, body.agent_id, {
        claim_token: body.claim_token,
        reason: body.reason,
        question_id: body.question_id,
      });
    });

    // POST /task/:task_id/resume —— 仅文件/依赖等待可由受控恢复转 pending；Question 必须 answer。
    app.post('/task/:task_id/resume', { schema: requestSchemas.taskResume }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      const body = req.body as { agent_id: string };
      return taskResume(redis, task_id, body.agent_id);
    });

    // Worker → PM 的受控通信。Question 正文不通过事件流广播；PM 仅被最小门铃唤醒后再二次读取。
    app.post('/question', { schema: requestSchemas.questionCreate }, async (req) => {
      return createQuestion(redis, req.body as Parameters<typeof createQuestion>[1]);
    });

    app.get('/questions', async (req) => {
      const { consumer, status, plan_id } = req.query as {
        consumer?: string;
        status?: string;
        plan_id?: string;
      };
      if (status && !['open', 'answered', 'all'].includes(status)) {
        return { ok: false, data: null, error: { code: 'INVALID_STATUS', message: 'status 仅支持 open、answered 或 all' } };
      }
      return listQuestions(redis, { consumer, status, plan_id });
    });

    app.get('/question/:question_id', async (req) => {
      const { question_id } = req.params as { question_id: string };
      const { consumer, plan_id } = req.query as { consumer?: string; plan_id?: string };
      // HTTP 读正文必须提供归属 PM consumer；service 内部调用仍可省略以维持兼容。
      if (!consumer) {
        return { ok: false, data: null, error: { code: 'CONSUMER_REQUIRED', message: '读取 Question 正文必须提供 consumer' } };
      }
      return getQuestion(redis, question_id, { consumer, plan_id });
    });

    app.post('/question/:question_id/answer', { schema: requestSchemas.questionAnswer }, async (req) => {
      const { question_id } = req.params as { question_id: string };
      return answerQuestion(redis, question_id, req.body as Parameters<typeof answerQuestion>[2]);
    });

    // POST /lease/renew —— 租约续期（worker 跑长任务时定期调，避免 lease 过期被回收）
    app.post('/lease/renew', async (req) => {
      const body = req.body as { task_id: string; claim_token: string; extend_seconds?: number };
      return renewLease(redis, body);
    });

    // GET /task/:task_id/review —— 查看 worker 产出供 PM 验收
    app.get('/task/:task_id/review', async (req) => {
      const { task_id } = req.params as { task_id: string };
      return getReviewInfo(redis, task_id);
    });

    // POST /task/:task_id/review —— PM 验收（accept 记录 / reject 生成修复 task）
    app.post('/task/:task_id/review', {
      schema: requestSchemas.taskReview,
      preValidation: async (req, reply) => {
        const message = validateRepairOwnershipRequest(req.body);
        if (message) {
          return reply.status(400).send({
            ok: false,
            data: null,
            error: { code: 'INVALID_REQUEST', message },
          });
        }
      },
    }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      const body = req.body as {
        verdict: 'accept' | 'reject';
        comment?: string;
        reject_reason?: string;
        fix_instructions?: string;
        resolution_mode?: 'repair' | 'reverify';
        repair_ownership?: { files?: string[]; modules?: string[] };
        reviewed_by: string;
      };
      return pmReview(redis, task_id, body);
    });

    // 重试耗尽后的显式 PM/CLI 决策：GET 纯读 lineage，POST 串行执行一次决策。
    app.get('/task/:task_id/resolution', async (req) => {
      const { task_id } = req.params as { task_id: string };
      return getResolutionDecision(redis, task_id);
    });

    app.post('/task/:task_id/resolution', { schema: requestSchemas.resolutionDecision }, async (req) => {
      const { task_id } = req.params as { task_id: string };
      return resolutionDecision(
        redis,
        task_id,
        req.body as Parameters<typeof resolutionDecision>[2],
      );
    });

    // GET /db/status —— SQLite 持久化状态
    app.get('/db/status', async () => getDbStatus(redis));

    // POST /db/restore —— 仅在运行态静止且 Biao namespace 为空时从 SQLite 灾难恢复
    app.post('/db/restore', { schema: requestSchemas.dbRestore }, async (_req, reply) => {
      const result = await dbRestoreManual(redis);
      if (!result.ok && [
        'RESTORE_IN_PROGRESS',
        'RESTORE_FAILED',
        'RESTORE_WRITERS_ACTIVE',
        'RESTORE_ACTIVE_RUNTIME_STATE',
        'RESTORE_TARGET_NOT_EMPTY',
        'RESTORE_LEASE_LOST',
      ].includes(result.error?.code ?? '')) reply.status(409);
      return result;
    });

    app.post('/report', { schema: requestSchemas.report }, async (req) => {
      const body = { ...(req.body as Parameters<typeof report>[1]) };
      if (body.result_path) {
        body.result_path = resolveAndValidateWorkspacePath(body.result_path, config.workspaceRoots);
      }
      if (body.result_json_path) {
        body.result_json_path = resolveAndValidateWorkspacePath(body.result_json_path, config.workspaceRoots);
      }
      return report(redis, body);
    });

    app.get('/ownership', async (req) => {
      const { path, agent_id } = req.query as { path: string; agent_id: string };
      return ownershipCheck(redis, path, agent_id);
    });

    app.post('/ownership/declare', { schema: requestSchemas.ownershipDeclare }, async (req) => {
      const { agent_id, task_id, claim_token, files, force } = req.body as {
        agent_id: string;
        task_id: string;
        claim_token: string;
        files: string[];
        force?: boolean;
      };
      return ownershipDeclare(redis, agent_id, task_id, claim_token, files, force ?? false);
    });

    app.post('/ownership/release', { schema: requestSchemas.ownershipRelease }, async (req) => {
      const { agent_id, task_id, claim_token, files } = req.body as {
        agent_id: string;
        task_id: string;
        claim_token: string;
        files: string[];
      };
      return ownershipRelease(redis, agent_id, task_id, claim_token, files);
    });

    app.post('/plan/submit', { schema: requestSchemas.planSubmit }, async (req) => {
      const { plan_dir, expected_preview } = req.body as {
        plan_dir: string;
        expected_preview?: Parameters<typeof planSubmit>[2];
      };
      return planSubmit(
        redis,
        resolveAndValidateWorkspacePath(plan_dir, config.workspaceRoots),
        expected_preview,
      );
    });

    app.post('/plan/create', { schema: requestSchemas.planCreate }, async (req) => {
      const body = req.body as {
        plan_id: string;
        title?: string;
        project_path: string;
        base_dir?: string;
        submit?: boolean;
      };
      return planCreate(redis, {
        ...body,
        project_path: resolveAndValidateWorkspacePath(body.project_path, config.workspaceRoots),
        base_dir: body.base_dir
          ? resolveAndValidateWorkspacePath(body.base_dir, config.workspaceRoots)
          : undefined,
      });
    });

    app.get('/plan/:plan_id', async (req) => {
      const { plan_id } = req.params as { plan_id: string };
      return getPlan(redis, plan_id);
    });

    // POST /plan/:plan_id/tasks —— 结构化直建/更新单个任务（PM/远程 Agent 无需
    // 服务器 shell 生成 MD；写盘与提交仍走 plan_dir 的权威解析路径）。
    app.post('/plan/:plan_id/tasks', { schema: requestSchemas.planTaskUpsert }, async (req) => {
      const { plan_id } = req.params as { plan_id: string };
      return planTaskUpsert(redis, plan_id, req.body as Parameters<typeof planTaskUpsert>[2]);
    });

    app.post('/project/agent-connections', {
      schema: requestSchemas.projectAgentConnectionCreate,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, ['project_scope', 'agent_id']);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { project_scope, agent_id } = req.body as { project_scope: string; agent_id: string };
      return connectProjectAgent(
        redis,
        resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots),
        agent_id,
      );
    });

    app.get('/project/agent-bindings', {
      schema: {
        querystring: {
          type: 'object', required: ['project_scope'], additionalProperties: false,
          properties: { project_scope: absolutePath },
        },
      },
    }, async (req) => {
      const { project_scope } = req.query as { project_scope: string };
      return listProjectAgentBindings(resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots));
    });

    app.get('/project/agent-bindings/:binding_id', {
      schema: {
        params: { type: 'object', required: ['binding_id'], properties: { binding_id: safeIdentifier } },
        querystring: {
          type: 'object', required: ['project_scope'], additionalProperties: false,
          properties: { project_scope: absolutePath },
        },
      },
    }, async (req) => {
      const { binding_id } = req.params as { binding_id: string };
      const { project_scope } = req.query as { project_scope: string };
      return getProjectAgentBinding(resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots), binding_id);
    });

    app.delete('/project/agent-bindings/:binding_id', {
      schema: {
        params: { type: 'object', required: ['binding_id'], properties: { binding_id: safeIdentifier } },
        querystring: {
          type: 'object', required: ['project_scope'], additionalProperties: false,
          properties: { project_scope: absolutePath },
        },
      },
    }, async (req) => {
      const { binding_id } = req.params as { binding_id: string };
      const { project_scope } = req.query as { project_scope: string };
      return deleteProjectAgentBinding(resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots), binding_id);
    });

    app.get('/project/agent-roster', {
      schema: {
        querystring: {
          type: 'object', required: ['project_scope'], additionalProperties: false,
          properties: { project_scope: absolutePath },
        },
      },
    }, async (req) => {
      const { project_scope } = req.query as { project_scope: string };
      return getProjectAgentRoster(redis, resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots));
    });

    app.post('/project/agent-reservations', {
      schema: requestSchemas.projectAgentReservation,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, [
          'project_scope', 'binding_id', 'task_id', 'preferred_plan_ids',
        ]);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { project_scope, binding_id, task_id, preferred_plan_ids } = req.body as {
        project_scope: string;
        binding_id: string;
        task_id?: string;
        preferred_plan_ids?: string[];
      };
      const projectScope = resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots);
      const reserved = await reserveProjectAgentTask(redis, projectScope, { binding_id, task_id, preferred_plan_ids });
      return reserved.ok
        ? { ok: true, data: { reservation: reserved.data } }
        : reserved;
    });

    app.post('/execution-receipts', {
      schema: requestSchemas.executionReceiptCreate,
      preValidation: async (req, reply) => {
        const message = validateExactRequestKeys(req.body, [
          'project_scope', 'attempt_id', 'task_id', 'binding_id', 'agent_id', 'registration_id',
          'harness_kind', 'wake_mode', 'adapter_id', 'status', 'started_at', 'session_ref', 'visible_url',
        ]);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { project_scope, ...body } = req.body as {
        project_scope: string;
      } & Parameters<typeof appendExecutionReceipt>[1];
      return appendExecutionReceipt(
        resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots),
        body,
        redis,
      );
    });

    app.get('/execution-receipts', {
      schema: {
        querystring: {
          type: 'object', required: ['project_scope'], additionalProperties: false,
          properties: { project_scope: absolutePath, binding_id: safeIdentifier, task_id: safeIdentifier },
        },
      },
    }, async (req) => {
      const { project_scope, binding_id, task_id } = req.query as {
        project_scope: string; binding_id?: string; task_id?: string;
      };
      return listExecutionReceipts(
        resolveAndValidateWorkspacePath(project_scope, config.workspaceRoots),
        { binding_id, task_id },
      );
    });

    // Plan 批量退出采用 preview token 乐观门控；状态变化时 POST 会 fail closed。
    app.get('/plan/:plan_id/supersede-preview', { schema: { params: planParamsSchema } }, async (req) => {
      const { plan_id } = req.params as { plan_id: string };
      return previewPlanSupersede(redis, plan_id);
    });

    app.post('/plan/:plan_id/supersede', {
      schema: requestSchemas.planSupersede,
      preValidation: async (req, reply) => {
        const message = validateSupersedeRequestKeys(req.body, true);
        if (message) return reply.status(400).send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message } });
      },
    }, async (req) => {
      const { plan_id } = req.params as { plan_id: string };
      return supersedePlan(redis, plan_id, req.body as Parameters<typeof supersedePlan>[2]);
    });

    // GET /plans —— 列出所有 plan + 任务状态计数（对应 biao plan list）
    app.get('/plans', async () => getPlans(redis));

    app.get('/status', async () => getStatus(redis));

    // GET /events?since=<ts>&limit=<n> —— 旧 CLI 兼容的时间戳查询（data 仍为数组）。
    // GET /events?after=<stream-id>&limit=<n> —— 新的排他精确游标分页（data={events,next_cursor}）。
    app.get('/events', async (req) => {
      const { since, limit, after, cursor } = req.query as { since?: string; limit?: string; after?: string; cursor?: string };
      const opts: { since?: number; limit?: number; after?: string } = {};
      if (since) {
        const n = Number(since);
        if (!Number.isNaN(n)) opts.since = n;
      }
      if (limit) {
        const n = Number(limit);
        if (!Number.isNaN(n)) opts.limit = n;
      }
      // cursor 是早期客户端使用的别名；两者同时传且不一致时拒绝，避免悄悄跳页。
      if (after && cursor && after !== cursor) {
        return { ok: false, data: null, error: { code: 'INVALID_CURSOR', message: 'after 与 cursor 不一致' } };
      }
      if (after || cursor) opts.after = after ?? cursor;
      return getEvents(redis, opts);
    });

    // GET /conflicts?limit=<n> —— 文件占用冲突历史（对应 biao conflicts）
    app.get('/conflicts', async (req) => {
      const { limit } = req.query as { limit?: string };
      const opts: { limit?: number } = {};
      if (limit) {
        const n = Number(limit);
        if (!Number.isNaN(n)) opts.limit = n;
      }
      return getConflicts(redis, opts);
    });

    // GET /ownership/active —— 当前活跃的文件占用（PM 看"谁卡着谁"）
    // PM 补提：worker 在 ownership-conflict-guide task 里实现了 service+CLI，缺这个路由挂载
    app.get('/ownership/active', async () => getActiveOwnership(redis));

    // GET /intake?consumer=&plan_id=&project_path= —— PM 主动轮询的一次性提醒（被动门铃）
    // 平台不主动唤醒 PM，只把"现在有哪些事项需要注视"汇总成最小字段供 PM 拉取。
    app.get('/intake', async (req) => {
      const { consumer, plan_id, project_path } = req.query as {
        consumer?: string;
        plan_id?: string;
        project_path?: string;
      };
      const opts: { consumer?: string; plan_id?: string; project_path?: string } = {};
      if (consumer) opts.consumer = consumer;
      if (plan_id) opts.plan_id = plan_id;
      if (project_path) {
        // project_path 过滤按受控根校验（与 claim 一致），越界路径会抛错 → 400
        opts.project_path = resolveAndValidateWorkspacePath(project_path, config.workspaceRoots);
      }
      return pmIntake(redis, opts);
    });

    // GET /intake/unacked?consumer=&limit=&type= —— 按 consumer 查询未确认事件
    app.get('/intake/unacked', async (req) => {
      const { consumer, limit, type, plan_id } = req.query as {
        consumer?: string;
        limit?: string;
        type?: string;
        plan_id?: string;
      };
      const opts: { consumer: string; limit?: number; type?: string; plan_id?: string } = { consumer: consumer ?? 'pm' };
      if (limit) {
        const n = Number(limit);
        if (!Number.isNaN(n)) opts.limit = n;
      }
      if (type) opts.type = type;
      if (plan_id) opts.plan_id = plan_id;
      return unackedEvents(redis, opts);
    });

    // POST /intake/ack —— 按 consumer 幂等确认事件（不影响其他 consumer，不改 stream 历史）
    app.post('/intake/ack', { schema: requestSchemas.intakeAck }, async (req) => {
      const { consumer, event_id, plan_id } = req.body as { consumer: string; event_id: string; plan_id?: string };
      return ackEvent(redis, { consumer, event_id, plan_id });
    });

    // POST /reconcile —— Supervisor 的低频、幂等运行态补偿；不领取任务、不处理 PM Question。
    app.post('/reconcile', async () => reconcileRuntimeState(redis));

    // GET /supervisor/tick —— Supervisor 聚合快照：一轮 plans+intake+events+reconcile+binding 合成一次往返。
    // 心跳不并入 tick（各 slot 心跳保持独立节流语义），详见 docs/runbooks/supervisor-tick.md。
    app.get('/supervisor/tick', async (req) => {
      const { consumers, events_after, binding_aware, plan_ids } = req.query as {
        consumers?: string; events_after?: string; binding_aware?: string; plan_ids?: string;
      };
      return supervisorTick(redis, {
        consumers: consumers ? consumers.split(',').map((value) => value.trim()).filter(Boolean) : [],
        events_after: events_after || undefined,
        binding_aware: binding_aware === '1' || binding_aware === 'true',
        plan_ids: plan_ids ? plan_ids.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
      });
    });

    // GET /watchdog?auto_fix=<bool> —— PM 巡检（对应 biao watchdog）
    app.get('/watchdog', async (req) => {
      const { auto_fix } = req.query as { auto_fix?: string };
      return runWatchdog(redis, { autoFix: auto_fix === 'true' || auto_fix === '1' });
    });

    // GET /events/stream —— SSE 实时推送（非阻塞版，修复 XREAD BLOCK 卡死事件循环的 bug）
    // 关键：XREAD 不带 BLOCK（立即返回）+ setTimeout 让出事件循环，不占住 Fastify 单线程
    app.get('/events/stream', async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const lastId = (req.query as { last_id?: string }).last_id ?? '$';
      let cursor = await resolveEventStreamCursor(redis, lastId);
      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;

      // 非阻塞轮询：XREAD(COUNT, 不带 BLOCK) 立即返回 + setTimeout 让出事件循环
      const poll = async () => {
        while (!closed) {
          try {
            if (await getRestoreMaintenanceGate(redis)) {
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
              reply.raw.end();
              break;
            }
            const msgs = (await (redis as unknown as {
              xread(...args: unknown[]): Promise<[string, [string, string[]][]][] | null>;
            }).xread('COUNT', 50, 'STREAMS', keys.stream.events, cursor)) as [string, [string, string[]][]][] | null;
            // raw SSE 不走 preSerialization；XREAD 后必须再检查一次，命中就丢弃已读数据。
            if (await getRestoreMaintenanceGate(redis)) {
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
              reply.raw.end();
              break;
            }
            if (msgs) {
              for (const [, entries] of msgs) {
                for (const [msgId, fields] of entries) {
                  cursor = msgId;
                  const kv: Record<string, string> = {};
                  for (let i = 0; i < fields.length; i += 2) kv[fields[i]] = fields[i + 1];
                  const event = {
                    type: kv.type ?? 'unknown',
                    task_id: kv.task_id ?? '',
                    agent_id: kv.agent_id ?? '',
                    result_status: kv.result_status ?? '',
                    ts: Number(msgId.split('-')[0]),
                  };
                  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
                }
              }
            }
            // 让出事件循环 2 秒（不带 BLOCK，靠 setTimeout 控制频率）
            await new Promise((resolve) => setTimeout(resolve, 2000));
          } catch {
            break; // 连接关闭或 Redis 错误
          }
        }
      };
      void poll();

      // 心跳：每 15s 发注释行，防代理超时
      heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          // ignore
        }
      }, 15000);

      req.raw.on('close', () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
      });
    });

    // 方案 E：Owner 预登记人类身份（一次性 enrollment_code）。
    // 注册在 apiRoutes 作用域（routes/v2/** 不动）：RBAC 守卫不覆盖本路由，
    // owner-only 判定在 handler 内 fail-closed 完成。仅在配置 SQLite store 时
    // 注册（远程登录依赖人类身份持久化；无 store 的纯 V1 实例保持路由树不变）。
    if (humanIdentity) {
      /** owner 凭据判定：owner bearer / 本机 Owner 会话 / owner 角色远程会话。 */
      const isOwnerCredential = (headers: { cookie?: string; authorization?: string }): boolean => {
        if (!config.apiToken) return true; // auth_disabled：与 RBAC 分类一致，全部视为 owner
        if (headers.authorization === `Bearer ${config.apiToken}`) return true;
        if (hasLocalOwnerSession(headers.cookie, config)) return true;
        const session = resolveHumanSessionCredential(headers.cookie, humanIdentity);
        return Boolean(session && session.claims.role === 'owner');
      };

      app.post('/v2/human-enrollments', { schema: requestSchemas.humanEnrollmentCreate }, async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!isOwnerCredential(req.headers)) {
          return reply.status(403).send({
            ok: false,
            data: null,
            error: { code: 'OWNER_REQUIRED', message: 'enrollment 创建仅限 Owner（Bearer token / 本机会话 / owner 角色远程会话）' },
          });
        }
        const body = req.body as {
          subject: string;
          role: 'owner' | 'project_admin' | 'reviewer' | 'auditor';
          project_id?: string;
          expires_in_hours?: number;
        };
        const actorId = config.apiToken && req.headers.authorization === `Bearer ${config.apiToken}`
          ? 'owner'
          : 'local-owner';
        const result = humanIdentity.createEnrollment(
          {
            subject: body.subject,
            role: body.role,
            project_id: body.project_id,
            expires_in_hours: body.expires_in_hours,
          },
          { actor_id: actorId, correlation_id: `corr-${Date.now()}` },
        );
        // enrollment_code 仅本次响应返回一次（后续不可查）；响应体不可缓存。
        if (!result.ok || !result.data) {
          return reply.status(400).send({
            ok: false,
            data: null,
            error: result.error ?? { code: 'ENROLLMENT_FAILED', message: 'enrollment 创建失败' },
          });
        }
        return result;
      });
    }

    // V2 路由装配（Phase 1 + Phase 6 RBAC）：/v2/* 路由，走 registry 声明 + 共享 plugin
    // 必须在 apiRoutes 闭包内注册，以继承 crossCuttingApiPlugin 的鉴权钩子；
    // apiToken/host 传入供 RBAC 守卫做凭据分类（owner bearer / local-owner 会话）。
    if (options.sqliteStore) {
      await app.register(v2RoutesPlugin, {
        store: options.sqliteStore,
        apiToken: config.apiToken,
        host: config.host,
        ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
      });
      // P12 车道 B：Worker SSE 唤醒通道（bvn2 → task_ready 推送，NODE_RUNTIME 旗门禁）。
      registerV2WorkerEventStream(app, { store: options.sqliteStore, redis });
      // P12 §9：webhook dispatcher（周期轮询事件源 → 投递外部系统）。
      // 按 store 去重：apiRoutes 注册两次（根路径 + /api 前缀），只启动一轮。
      if (!startedWebhookDispatchersPerStore.has(options.sqliteStore)) {
        startedWebhookDispatchersPerStore.add(options.sqliteStore);
        createWebhookDispatcher({ store: options.sqliteStore, redis }).start();
      }
    }
  };

  await app.register(apiRoutes);            // 根路径（spec 标准）
  await app.register(apiRoutes, { prefix: '/api' }); // /api 前缀兼容

  // 404：返回 JSON 错误 + 可用端点提示（API 发现性）
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      ok: false,
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: `路径不存在: ${req.method} ${req.raw.url}。可用接口见 GET /（Accept: application/json）。`,
        available_endpoints: API_ENDPOINTS,
      },
    });
  });

  // 托管前端静态文件（若 web/dist 存在）——放所有 API 路由之后，wildcard 兜底
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
    });
    app.log.info(`[biao] 托管前端：${webDist}`);
  } else {
    app.log.warn('[biao] 未找到 web/dist，不托管前端（仅 API 模式）');
  }

  return app;
}
