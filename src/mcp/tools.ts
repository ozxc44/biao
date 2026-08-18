import type { BiaoApiEnvelope } from './client.js';
import type { LanMcpRuntime } from './runtime.js';
import { remoteErrorEnvelope, randomRuntimeId } from './runtime.js';
import { maybeEnsureSupervisor } from '../worker/ensure-supervisor.js';

// 这些工具成功后意味着本机刚产生/刚消费了会改变门铃队列的事件；
// opt-in 时顺带确认留守监视器在运行（pm-watch --ensure 幂等）。
const SUPERVISOR_ENSURE_TOOLS = new Set(['task_report', 'pm_review_decide', 'question_answer']);

export interface McpToolResult {
  payload: BiaoApiEnvelope;
  ok: boolean;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, runtime: LanMcpRuntime) => Promise<BiaoApiEnvelope>;
}

export class McpToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolInputError';
  }
}

function objectSchema(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

const nonEmptyString = { type: 'string', minLength: 1 };
const taskStatus = { type: 'string', enum: ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'] };
const taskType = { type: 'string', enum: ['code', 'review', 'research', 'docs', 'acceptance'] };

function assertExactKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new McpToolInputError(`不支持参数：${unknown}`);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new McpToolInputError(`${key} 必须是非空字符串`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new McpToolInputError(`${key} 必须是非空字符串`);
  return value.trim();
}

function optionalInteger(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new McpToolInputError(`${key} 必须是 ${min}..${max} 的整数`);
  }
  return value as number;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new McpToolInputError(`${key} 必须是 boolean`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new McpToolInputError(`${key} 必须是非空字符串数组`);
  }
  return value.map((entry) => (entry as string).trim());
}

function enumArg<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T {
  const value = stringArg(args, key);
  if (!values.includes(value as T)) throw new McpToolInputError(`${key} 必须是 ${values.join(' / ')} 之一`);
  return value as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

const omittedMetadataKeys = new Set([
  'project_path', 'result_path', 'result_json_path', 'claim_token', 'registration_id',
  'verify', 'verify_results', 'cmd', 'command', 'output', 'goal_md', 'result_md', 'result_json',
  'endpoint', 'receipts',
]);

function smallMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(smallMetadata);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (omittedMetadataKeys.has(key)) continue;
    result[key] = smallMetadata(entry);
  }
  return result;
}

function projectEnvelope(envelope: BiaoApiEnvelope, projector: (data: unknown) => unknown = smallMetadata): BiaoApiEnvelope {
  if (!envelope.ok) {
    const code = envelope.error?.code ?? 'REMOTE_API_REJECTED';
    // 业务 code 原样保留供 Harness 分支；远端自由文本可能含命令或中央机路径，
    // 不进入 MCP result。无路径/凭据形态的短业务消息按白名单透传，便于 Agent 排障。
    return { ok: false, data: null, error: { code, message: sanitizeRemoteMessage(envelope.error?.message, code) } };
  }
  return { ok: true, data: envelope.data === null ? null : projector(envelope.data) };
}

function sanitizeRemoteMessage(message: string | undefined, code: string): string {
  const fallback = `中央 Biao API 拒绝请求（${code}）`;
  if (!message) return fallback;
  const capped = message.length > 200 ? message.slice(0, 200) : message;
  if (/[/\\]/.test(capped) || /bearer|token/i.test(capped) || /[0-9a-f]{32,}/i.test(capped)) {
    return fallback;
  }
  return capped;
}

function resolveAgentId(args: Record<string, unknown>, runtime: LanMcpRuntime): string {
  const explicit = optionalString(args, 'agent_id');
  if (explicit) {
    runtime.rememberDefaultAgent(explicit);
    return explicit;
  }
  const remembered = runtime.defaultAgent();
  if (!remembered) throw new McpToolInputError('agent_id 必填（首次携带后本 MCP 会话会记住身份）');
  return remembered;
}

async function ensureRegistered(
  runtime: LanMcpRuntime,
  agentId: string,
  agentType: string,
  capabilities: string[],
): Promise<BiaoApiEnvelope | undefined> {
  const state = runtime.agent(agentId);
  if (state.registered) return undefined;
  const response = await runtime.client.request<{ registration_id?: string }>('/register', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: agentId,
      agent_type: agentType,
      capabilities,
      registration_id: state.registrationId,
    }),
  });
  if (!response.ok) return response;
  if (response.data?.registration_id && response.data.registration_id !== state.registrationId) {
    return {
      ok: false,
      data: null,
      error: { code: 'REMOTE_PROTOCOL_MISMATCH', message: '中央 Biao 返回了不一致的 registration epoch' },
    };
  }
  state.registered = true;
  return undefined;
}

function forgetInvalidLease(runtime: LanMcpRuntime, agentId: string, taskId: string, response: BiaoApiEnvelope): void {
  if (!response.ok && ['CLAIM_TOKEN_INVALID', 'LEASE_EXPIRED', 'TASK_NOT_RUNNING', 'CLAIM_OWNER_MISMATCH']
    .includes(response.error?.code ?? '')) {
    runtime.forgetClaim(agentId, taskId);
  }
}

const tools: McpToolSpec[] = [
  {
    name: 'health',
    description: '检查中央 Biao HTTP API 可达性与 v1 协议兼容性；不执行本地降级。',
    inputSchema: objectSchema(),
    handler: async (args, runtime) => {
      assertExactKeys(args, []);
      return runtime.client.health();
    },
  },
  {
    name: 'plan_list',
    description: '列出中央 Biao 的计划摘要；省略服务端本地绝对路径。',
    inputSchema: objectSchema(),
    handler: async (args, runtime) => {
      assertExactKeys(args, []);
      return projectEnvelope(await runtime.client.request('/plans'));
    },
  },
  {
    name: 'plan_status',
    description: '读取一个计划及其任务生命周期状态。',
    inputSchema: objectSchema({ plan_id: nonEmptyString }, ['plan_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['plan_id']);
      return projectEnvelope(await runtime.client.request(`/plan/${encodeURIComponent(stringArg(args, 'plan_id'))}`));
    },
  },
  {
    name: 'task_list',
    description: '按 plan/status 分页列出中央任务摘要。',
    inputSchema: objectSchema({
      plan_id: nonEmptyString,
      status: taskStatus,
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      offset: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['plan_id', 'status', 'limit', 'offset']);
      const status = optionalString(args, 'status');
      if (status && !['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded'].includes(status)) {
        throw new McpToolInputError('status 非法');
      }
      const path = `/tasks${query({
        plan_id: optionalString(args, 'plan_id'),
        status,
        limit: optionalInteger(args, 'limit', 1, 1000),
        offset: optionalInteger(args, 'offset', 0, 1_000_000),
      })}`;
      return projectEnvelope(await runtime.client.request(path));
    },
  },
  {
    name: 'task_get',
    description: '读取单个任务的小型控制面元数据与 goal 正文（不返回 verify 命令、Artifact 字节或服务端路径）。',
    inputSchema: objectSchema({ task_id: nonEmptyString }, ['task_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id']);
      const response = await runtime.client.request<Record<string, unknown>>(
        `/task/${encodeURIComponent(stringArg(args, 'task_id'))}`,
      );
      if (!response.ok || !response.data) return projectEnvelope(response);
      return {
        ok: true,
        data: {
          ...(smallMetadata(response.data) as Record<string, unknown>),
          goal_md: typeof response.data.goal_md === 'string' ? response.data.goal_md : '',
        },
      };
    },
  },
  {
    name: 'ownership_check',
    description: '通过中央 ownership API 检查路径动作；不会在本机重算或声明 ownership。agent_id 首次携带后可省略。',
    inputSchema: objectSchema({ path: nonEmptyString, agent_id: nonEmptyString }, ['path']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['path', 'agent_id']);
      return projectEnvelope(await runtime.client.request(`/ownership${query({
        path: stringArg(args, 'path'),
        agent_id: resolveAgentId(args, runtime),
      })}`));
    },
  },
  {
    name: 'pm_review_list',
    description: '列出中央事实源中当前待 PM Review 的交付。',
    inputSchema: objectSchema({ plan_id: nonEmptyString }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['plan_id']);
      return projectEnvelope(await runtime.client.request(`/reviews/pending${query({ plan_id: optionalString(args, 'plan_id') })}`));
    },
  },
  {
    name: 'pm_review_read',
    description: '读取待验收状态与小型证据摘要；Artifact 正文仍走专用通道。',
    inputSchema: objectSchema({ task_id: nonEmptyString }, ['task_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id']);
      const response = await runtime.client.request<Record<string, unknown>>(
        `/task/${encodeURIComponent(stringArg(args, 'task_id'))}/review`,
      );
      if (!response.ok || !response.data) return projectEnvelope(response);
      const data = response.data;
      const verify = Array.isArray(data.verify_results) ? data.verify_results : [];
      const changedFiles = Array.isArray(data.changed_files)
        ? data.changed_files.filter((entry): entry is string => typeof entry === 'string' && !entry.startsWith('/'))
        : [];
      return {
        ok: true,
        data: {
          ...(smallMetadata(data) as Record<string, unknown>),
          changed_files: changedFiles,
          verify_summary: {
            total: verify.length,
            passed: verify.filter((entry) => Boolean((entry as { passed?: unknown })?.passed)).length,
            failed: verify.filter((entry) => (entry as { passed?: unknown })?.passed === false).length,
          },
          result_ref: {
            task_id: data.task_id,
            result_md_available: typeof data.result_md === 'string' && data.result_md.length > 0,
            result_json_available: Boolean(data.result_json && typeof data.result_json === 'object'),
          },
          awaiting_independent_review: data.status === 'done' && !data.pm_review_status,
        },
      };
    },
  },
  {
    name: 'task_claim',
    description: '注册当前本机会话并通过中央 CAS 领取任务；响应含 goal 正文（verify 命令不外泄）。agent_id 首次携带后可省略。',
    inputSchema: objectSchema({
      agent_id: nonEmptyString,
      agent_type: nonEmptyString,
      capabilities: { type: 'array', items: nonEmptyString, uniqueItems: true },
      blocking: { type: 'boolean' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 60_000 },
      preferred_types: { type: 'array', items: taskType, uniqueItems: true },
      preferred_phases: { type: 'array', items: nonEmptyString, uniqueItems: true },
      preferred_project: nonEmptyString,
      preferred_plan_ids: { type: 'array', items: nonEmptyString, uniqueItems: true },
    }),
    handler: async (args, runtime) => {
      const allowed = [
        'agent_id', 'agent_type', 'capabilities', 'blocking', 'timeout_ms', 'preferred_types',
        'preferred_phases', 'preferred_project', 'preferred_plan_ids',
      ];
      assertExactKeys(args, allowed);
      const agentId = resolveAgentId(args, runtime);
      const capabilities = optionalStringArray(args, 'capabilities') ?? [];
      const registrationFailure = await ensureRegistered(
        runtime,
        agentId,
        optionalString(args, 'agent_type') ?? 'custom',
        capabilities,
      );
      if (registrationFailure) return projectEnvelope(registrationFailure);
      const state = runtime.agent(agentId);
      const response = await runtime.client.request<Record<string, unknown>>('/claim', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          registration_id: state.registrationId,
          claim_request_id: randomRuntimeId('claim'),
          blocking: optionalBoolean(args, 'blocking') ?? false,
          timeout_ms: optionalInteger(args, 'timeout_ms', 0, 60_000),
          preferred_types: optionalStringArray(args, 'preferred_types'),
          preferred_phases: optionalStringArray(args, 'preferred_phases'),
          preferred_project: optionalString(args, 'preferred_project'),
          preferred_plan_ids: optionalStringArray(args, 'preferred_plan_ids'),
        }),
      });
      if (!response.ok || response.data === null) return projectEnvelope(response);
      const taskId = response.data.task_id;
      const claimToken = response.data.claim_token;
      if (typeof taskId !== 'string' || typeof claimToken !== 'string' || !taskId || !claimToken) {
        return { ok: false, data: null, error: { code: 'REMOTE_PROTOCOL_MISMATCH', message: 'claim 响应缺少任务或 lease' } };
      }
      runtime.rememberClaim(agentId, taskId, claimToken);
      return {
        ok: true,
        data: {
          ...(smallMetadata(response.data) as Record<string, unknown>),
          goal_md: typeof response.data.goal_md === 'string' ? response.data.goal_md : '',
          goal_available: typeof response.data.goal_md === 'string' && response.data.goal_md.length > 0,
          verify_count: Array.isArray(response.data.verify) ? response.data.verify.length : 0,
        },
      };
    },
  },
  {
    name: 'task_heartbeat',
    description: '用本 MCP 会话的 registration epoch 向中央 Biao 发送 Worker heartbeat。',
    inputSchema: objectSchema({ agent_id: nonEmptyString, current_task: nonEmptyString }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['agent_id', 'current_task']);
      const agentId = resolveAgentId(args, runtime);
      const state = runtime.agent(agentId);
      if (!state.registered) {
        return { ok: false, data: null, error: { code: 'LOCAL_REGISTRATION_NOT_FOUND', message: '本 MCP 会话尚未注册该 Agent' } };
      }
      const currentTask = optionalString(args, 'current_task');
      // 先确认本会话确实持有 lease，再发送任一远端写，避免 heartbeat 已落盘后才发现
      // 无法 renew 的半成功状态。
      const claimToken = currentTask ? runtime.claimToken(agentId, currentTask) : undefined;
      const heartbeat = await runtime.client.request('/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          registration_id: state.registrationId,
          current_task: currentTask,
        }),
      });
      if (!heartbeat.ok || !currentTask || !claimToken) return projectEnvelope(heartbeat);
      const renew = await runtime.client.request('/lease/renew', {
        method: 'POST',
        body: JSON.stringify({ task_id: currentTask, claim_token: claimToken }),
      });
      if (!renew.ok) {
        forgetInvalidLease(runtime, agentId, currentTask, renew);
        return projectEnvelope(renew);
      }
      return {
        ok: true,
        data: {
          heartbeat: smallMetadata(heartbeat.data),
          lease: smallMetadata(renew.data),
        },
      };
    },
  },
  {
    name: 'task_report',
    description: '使用本 MCP 会话持有的 lease 上报 done/failed/partial；可内联携带产物正文（中央受控落盘）并请求中央代执行声明的 verify（execute_verify）；done 仍需独立 PM Review。',
    inputSchema: objectSchema({
      task_id: nonEmptyString,
      agent_id: nonEmptyString,
      status: { type: 'string', enum: ['done', 'failed', 'partial'] },
      result_path: nonEmptyString,
      result_json_path: nonEmptyString,
      result_md: { type: 'string', maxLength: 131072 },
      result_json: { type: 'string', maxLength: 262144 },
      execute_verify: { type: 'boolean' },
      verify_results: {
        type: 'array',
        items: objectSchema({
          cmd: nonEmptyString,
          exit_code: { type: 'integer' },
          passed: { type: 'boolean' },
          output: { type: 'string' },
        }, ['cmd', 'exit_code', 'passed']),
      },
    }, ['task_id', 'status']),
    handler: async (args, runtime) => {
      assertExactKeys(args, [
        'task_id', 'agent_id', 'status', 'result_path', 'result_json_path',
        'result_md', 'result_json', 'execute_verify', 'verify_results',
      ]);
      const taskId = stringArg(args, 'task_id');
      const agentId = resolveAgentId(args, runtime);
      const status = enumArg(args, 'status', ['done', 'failed', 'partial'] as const);
      const verifyResults = args.verify_results;
      if (verifyResults !== undefined && !Array.isArray(verifyResults)) {
        throw new McpToolInputError('verify_results 必须是数组');
      }
      const response = await runtime.client.request('/report', {
        method: 'POST',
        body: JSON.stringify({
          task_id: taskId,
          agent_id: agentId,
          claim_token: runtime.claimToken(agentId, taskId),
          status,
          result_path: optionalString(args, 'result_path'),
          result_json_path: optionalString(args, 'result_json_path'),
          result_md: optionalString(args, 'result_md'),
          result_json: optionalString(args, 'result_json'),
          execute_verify: optionalBoolean(args, 'execute_verify'),
          verify_results: verifyResults,
        }),
      });
      if (response.ok) runtime.forgetClaim(agentId, taskId);
      else forgetInvalidLease(runtime, agentId, taskId, response);
      return projectEnvelope(response);
    },
  },
  {
    name: 'task_block',
    description: '按中央校验把当前 lease 置为文件/依赖等待，并释放本地 lease 句柄。',
    inputSchema: objectSchema({
      task_id: nonEmptyString,
      agent_id: nonEmptyString,
      reason: { type: 'string', enum: ['waiting_file_release', 'waiting_dependency'] },
    }, ['task_id', 'reason']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'agent_id', 'reason']);
      const taskId = stringArg(args, 'task_id');
      const agentId = resolveAgentId(args, runtime);
      const response = await runtime.client.request(`/task/${encodeURIComponent(taskId)}/block`, {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          claim_token: runtime.claimToken(agentId, taskId),
          reason: enumArg(args, 'reason', ['waiting_file_release', 'waiting_dependency'] as const),
        }),
      });
      if (response.ok) runtime.forgetClaim(agentId, taskId);
      else forgetInvalidLease(runtime, agentId, taskId, response);
      return projectEnvelope(response);
    },
  },
  {
    name: 'question_ask',
    description: '以当前 lease 向该 Plan PM 创建 Question；成功后旧 lease 失效。',
    inputSchema: objectSchema({
      task_id: nonEmptyString,
      agent_id: nonEmptyString,
      body: { type: 'string', minLength: 1, maxLength: 8000 },
      checkpoint: { type: 'string', maxLength: 12000 },
      requested_ownership: objectSchema({
        files: { type: 'array', items: nonEmptyString, minItems: 1, maxItems: 64 },
        modules: { type: 'array', items: nonEmptyString, minItems: 1, maxItems: 64 },
      }),
    }, ['task_id', 'body']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'agent_id', 'body', 'checkpoint', 'requested_ownership']);
      const taskId = stringArg(args, 'task_id');
      const agentId = resolveAgentId(args, runtime);
      const requestedOwnership = args.requested_ownership;
      if (requestedOwnership !== undefined) {
        if (!requestedOwnership || typeof requestedOwnership !== 'object' || Array.isArray(requestedOwnership)) {
          throw new McpToolInputError('requested_ownership 必须是对象');
        }
        assertExactKeys(requestedOwnership as Record<string, unknown>, ['files', 'modules']);
      }
      const response = await runtime.client.request('/question', {
        method: 'POST',
        body: JSON.stringify({
          task_id: taskId,
          agent_id: agentId,
          claim_token: runtime.claimToken(agentId, taskId),
          body: stringArg(args, 'body'),
          checkpoint: optionalString(args, 'checkpoint'),
          requested_ownership: requestedOwnership,
        }),
      });
      if (response.ok) runtime.forgetClaim(agentId, taskId);
      else forgetInvalidLease(runtime, agentId, taskId, response);
      return projectEnvelope(response);
    },
  },
  {
    name: 'project_create',
    description: '注册 V2 项目（name + Git 远端 + 默认分支）；Worker 工作区按任务从该远端 clone。需要 Owner API Token 作用域。',
    inputSchema: objectSchema({
      name: nonEmptyString,
      repo_path: nonEmptyString,
      default_branch: nonEmptyString,
      read_only: { type: 'boolean' },
    }, ['name', 'repo_path']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['name', 'repo_path', 'default_branch', 'read_only']);
      const body: Record<string, unknown> = {
        name: stringArg(args, 'name'),
        repo_path: stringArg(args, 'repo_path'),
        default_branch: optionalString(args, 'default_branch') ?? 'main',
        execution_mode: optionalBoolean(args, 'read_only') ? 'read_only' : 'full',
      };
      return projectEnvelope(await runtime.client.request('/v2/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      }));
    },
  },
  {
    name: 'project_list',
    description: '列出中央 Biao 的 V2 项目（project_id、Git 远端、默认分支、执行模式）；不返回服务端本地路径之外的敏感字段。',
    inputSchema: objectSchema(),
    handler: async (args, runtime) => {
      assertExactKeys(args, []);
      return projectEnvelope(await runtime.client.request('/v2/projects'));
    },
  },
  {
    name: 'plan_create',
    description: '创建计划。skeleton=false 时只建空计划（配合 task_upsert 逐个建任务），默认生成示例骨架任务。',
    inputSchema: objectSchema({
      plan_id: nonEmptyString,
      project_path: nonEmptyString,
      title: nonEmptyString,
      pm_consumer: nonEmptyString,
      submit: { type: 'boolean' },
      skeleton: { type: 'boolean' },
    }, ['plan_id', 'project_path']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['plan_id', 'project_path', 'title', 'pm_consumer', 'submit', 'skeleton']);
      const body: Record<string, unknown> = {
        plan_id: stringArg(args, 'plan_id'),
        project_path: stringArg(args, 'project_path'),
      };
      const title = optionalString(args, 'title');
      const pmConsumer = optionalString(args, 'pm_consumer');
      const submit = optionalBoolean(args, 'submit');
      const skeleton = optionalBoolean(args, 'skeleton');
      if (title !== undefined) body.title = title;
      if (pmConsumer !== undefined) body.pm_consumer = pmConsumer;
      if (submit !== undefined) body.submit = submit;
      if (skeleton !== undefined) body.skeleton = skeleton;
      return projectEnvelope(await runtime.client.request('/plan/create', {
        method: 'POST',
        body: JSON.stringify(body),
      }));
    },
  },
  {
    name: 'task_upsert',
    description: '结构化直建或更新计划内单个任务（pending 覆盖、运行态/终态由平台保护）；远程 Agent 无需服务器 shell。',
    inputSchema: objectSchema({
      plan_id: nonEmptyString,
      task_id: nonEmptyString,
      title: nonEmptyString,
      type: taskType,
      phase: nonEmptyString,
      assignee: nonEmptyString,
      priority: { type: 'integer', minimum: 0, maximum: 9 },
      timeout_seconds: { type: 'integer', minimum: 60, maximum: 86400 },
      goal_md: { type: 'string', maxLength: 65536 },
      verify: {
        type: 'array',
        maxItems: 32,
        items: objectSchema({ cmd: nonEmptyString, expect_exit: { type: 'integer' } }, ['cmd']),
      },
      ownership: objectSchema({
        files: { type: 'array', maxItems: 64, items: nonEmptyString },
        modules: { type: 'array', maxItems: 64, items: nonEmptyString },
      }),
      depends_on: { type: 'array', maxItems: 64, items: nonEmptyString },
      acceptance_for: { type: 'array', maxItems: 64, items: nonEmptyString },
    }, ['plan_id', 'task_id', 'title']),
    handler: async (args, runtime) => {
      assertExactKeys(args, [
        'plan_id', 'task_id', 'title', 'type', 'phase', 'assignee', 'priority',
        'timeout_seconds', 'goal_md', 'verify', 'ownership', 'depends_on', 'acceptance_for',
      ]);
      const planId = stringArg(args, 'plan_id');
      const body: Record<string, unknown> = {
        task_id: stringArg(args, 'task_id'),
        title: stringArg(args, 'title'),
      };
      const passthrough = [
        'type', 'phase', 'assignee', 'priority', 'timeout_seconds', 'goal_md',
        'verify', 'ownership', 'depends_on', 'acceptance_for',
      ] as const;
      for (const key of passthrough) {
        const value = key === 'type' || key === 'phase' || key === 'assignee' || key === 'goal_md'
          ? optionalString(args, key)
          : args[key];
        if (value !== undefined) body[key] = value;
      }
      return projectEnvelope(await runtime.client.request(`/plan/${encodeURIComponent(planId)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }));
    },
  },
  {
    name: 'pm_review_decide',
    description: 'PM 验收决策（Owner 作用域）：accept 或 reject 当前交付；done 不等于 accepted。',
    inputSchema: objectSchema({
      task_id: nonEmptyString,
      verdict: { type: 'string', enum: ['accept', 'reject'] },
      comment: nonEmptyString,
      reject_reason: nonEmptyString,
      fix_instructions: nonEmptyString,
      reviewed_by: nonEmptyString,
    }, ['task_id', 'verdict', 'reviewed_by']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'verdict', 'comment', 'reject_reason', 'fix_instructions', 'reviewed_by']);
      const taskId = stringArg(args, 'task_id');
      const body: Record<string, unknown> = {
        verdict: enumArg(args, 'verdict', ['accept', 'reject'] as const),
        reviewed_by: stringArg(args, 'reviewed_by'),
      };
      const comment = optionalString(args, 'comment');
      const rejectReason = optionalString(args, 'reject_reason');
      const fixInstructions = optionalString(args, 'fix_instructions');
      if (comment !== undefined) body.comment = comment;
      if (rejectReason !== undefined) body.reject_reason = rejectReason;
      if (fixInstructions !== undefined) body.fix_instructions = fixInstructions;
      return projectEnvelope(await runtime.client.request(`/task/${encodeURIComponent(taskId)}/review`, {
        method: 'POST',
        body: JSON.stringify(body),
      }));
    },
  },
  {
    name: 'question_list',
    description: 'PM 列出待处理 Question 的最小路由信息（默认 consumer=pm、status=open）。',
    inputSchema: objectSchema({
      consumer: nonEmptyString,
      plan_id: nonEmptyString,
      status: { type: 'string', enum: ['open', 'answered', 'all'] },
    }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['consumer', 'plan_id', 'status']);
      return projectEnvelope(await runtime.client.request(`/questions${query({
        consumer: optionalString(args, 'consumer'),
        plan_id: optionalString(args, 'plan_id'),
        status: optionalString(args, 'status'),
      })}`));
    },
  },
  {
    name: 'question_get',
    description: 'PM 读取单个 Question 的正文、checkpoint 与扩权申请。',
    inputSchema: objectSchema({
      question_id: nonEmptyString,
      consumer: nonEmptyString,
      plan_id: nonEmptyString,
    }, ['question_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['question_id', 'consumer', 'plan_id']);
      return projectEnvelope(await runtime.client.request(
        `/question/${encodeURIComponent(stringArg(args, 'question_id'))}${query({
          consumer: optionalString(args, 'consumer') ?? 'pm',
          plan_id: optionalString(args, 'plan_id'),
        })}`,
      ));
    },
  },
  {
    name: 'question_answer',
    description: 'PM 答复 Question 并自动 ack 对应门铃；任务回到 pending，Worker 以新 claim 恢复。',
    inputSchema: objectSchema({
      question_id: nonEmptyString,
      answer: nonEmptyString,
      consumer: nonEmptyString,
      plan_id: nonEmptyString,
    }, ['question_id', 'answer']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['question_id', 'answer', 'consumer', 'plan_id']);
      const consumer = optionalString(args, 'consumer') ?? 'pm';
      const answered = await runtime.client.request<{ asked_event_id?: string }>(
        `/question/${encodeURIComponent(stringArg(args, 'question_id'))}/answer`,
        {
          method: 'POST',
          body: JSON.stringify({
            consumer,
            plan_id: optionalString(args, 'plan_id'),
            answer: stringArg(args, 'answer'),
          }),
        },
      );
      if (!answered.ok) return projectEnvelope(answered);
      let acked = false;
      const eventId = answered.data?.asked_event_id;
      if (eventId) {
        const ack = await runtime.client.request('/intake/ack', {
          method: 'POST',
          body: JSON.stringify({ consumer, event_id: eventId }),
        });
        acked = Boolean(ack.ok);
      }
      return {
        ok: true,
        data: {
          ...(smallMetadata(answered.data) as Record<string, unknown>),
          acked,
        },
      };
    },
  },
  {
    name: 'pm_next',
    description: 'PM 一站式最小待办（待验收、Question、失败/阻塞的门铃汇总）；数据为空表示当前无事可做。',
    inputSchema: objectSchema({ consumer: nonEmptyString, plan_id: nonEmptyString }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['consumer', 'plan_id']);
      return projectEnvelope(await runtime.client.request(`/intake${query({
        consumer: optionalString(args, 'consumer'),
        plan_id: optionalString(args, 'plan_id'),
      })}`));
    },
  },
  {
    name: 'agent_offline',
    description: 'Worker 正常退出时显式离线（幂等；需要本会话已注册该 Agent）。',
    inputSchema: objectSchema({
      agent_id: nonEmptyString,
      reason: {
        type: 'string',
        enum: ['worker_exit', 'worker_signal', 'plans_terminal', 'supervisor_signal', 'supervisor_exit'],
      },
    }),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['agent_id', 'reason']);
      const agentId = resolveAgentId(args, runtime);
      const state = runtime.agent(agentId);
      if (!state.registered) {
        return { ok: false, data: null, error: { code: 'LOCAL_REGISTRATION_NOT_FOUND', message: '本 MCP 会话尚未注册该 Agent' } };
      }
      return projectEnvelope(await runtime.client.request('/agent/offline', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          registration_id: state.registrationId,
          reason: optionalString(args, 'reason') ?? 'worker_exit',
        }),
      }));
    },
  },
];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

export function listMcpTools(): McpToolSpec[] {
  return tools;
}

export async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  runtime: LanMcpRuntime,
): Promise<McpToolResult> {
  const tool = byName.get(name);
  if (!tool) throw new McpToolInputError(`未知工具：${name}`);
  try {
    const payload = await tool.handler(args, runtime);
    if (payload.ok && SUPERVISOR_ENSURE_TOOLS.has(name)) maybeEnsureSupervisor();
    return { payload, ok: payload.ok };
  } catch (error) {
    if (error instanceof McpToolInputError) throw error;
    const payload = remoteErrorEnvelope(error);
    return { payload, ok: false };
  }
}
