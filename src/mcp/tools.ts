import type { BiaoApiEnvelope } from './client.js';
import type { LanMcpRuntime } from './runtime.js';
import { remoteErrorEnvelope, randomRuntimeId } from './runtime.js';

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
    // 业务 code 原样保留供 Harness 分支；远端自由文本/details 可能含命令或中央机路径，
    // 不进入 MCP result。
    return { ok: false, data: null, error: { code, message: `中央 Biao API 拒绝请求（${code}）` } };
  }
  return { ok: true, data: envelope.data === null ? null : projector(envelope.data) };
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
    description: '读取单个任务的小型控制面元数据；不返回 verify 命令、Artifact 字节或服务端路径。',
    inputSchema: objectSchema({ task_id: nonEmptyString }, ['task_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id']);
      return projectEnvelope(await runtime.client.request(`/task/${encodeURIComponent(stringArg(args, 'task_id'))}`));
    },
  },
  {
    name: 'ownership_check',
    description: '通过中央 ownership API 检查路径动作；不会在本机重算或声明 ownership。',
    inputSchema: objectSchema({ path: nonEmptyString, agent_id: nonEmptyString }, ['path', 'agent_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['path', 'agent_id']);
      return projectEnvelope(await runtime.client.request(`/ownership${query({
        path: stringArg(args, 'path'),
        agent_id: stringArg(args, 'agent_id'),
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
    description: '注册当前本机会话并通过中央 CAS 领取任务；lease token 只保存在本进程内。',
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
    }, ['agent_id']),
    handler: async (args, runtime) => {
      const allowed = [
        'agent_id', 'agent_type', 'capabilities', 'blocking', 'timeout_ms', 'preferred_types',
        'preferred_phases', 'preferred_project', 'preferred_plan_ids',
      ];
      assertExactKeys(args, allowed);
      const agentId = stringArg(args, 'agent_id');
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
          goal_available: typeof response.data.goal_md === 'string' && response.data.goal_md.length > 0,
          verify_count: Array.isArray(response.data.verify) ? response.data.verify.length : 0,
        },
      };
    },
  },
  {
    name: 'task_heartbeat',
    description: '用本 MCP 会话的 registration epoch 向中央 Biao 发送 Worker heartbeat。',
    inputSchema: objectSchema({ agent_id: nonEmptyString, current_task: nonEmptyString }, ['agent_id']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['agent_id', 'current_task']);
      const agentId = stringArg(args, 'agent_id');
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
    description: '使用本 MCP 会话持有的 lease 上报 done/failed/partial；done 仍需独立 PM Review。',
    inputSchema: objectSchema({
      task_id: nonEmptyString,
      agent_id: nonEmptyString,
      status: { type: 'string', enum: ['done', 'failed', 'partial'] },
      result_path: nonEmptyString,
      result_json_path: nonEmptyString,
      verify_results: {
        type: 'array',
        items: objectSchema({
          cmd: nonEmptyString,
          exit_code: { type: 'integer' },
          passed: { type: 'boolean' },
          output: { type: 'string' },
        }, ['cmd', 'exit_code', 'passed']),
      },
    }, ['task_id', 'agent_id', 'status']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'agent_id', 'status', 'result_path', 'result_json_path', 'verify_results']);
      const taskId = stringArg(args, 'task_id');
      const agentId = stringArg(args, 'agent_id');
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
    }, ['task_id', 'agent_id', 'reason']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'agent_id', 'reason']);
      const taskId = stringArg(args, 'task_id');
      const agentId = stringArg(args, 'agent_id');
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
    }, ['task_id', 'agent_id', 'body']),
    handler: async (args, runtime) => {
      assertExactKeys(args, ['task_id', 'agent_id', 'body', 'checkpoint', 'requested_ownership']);
      const taskId = stringArg(args, 'task_id');
      const agentId = stringArg(args, 'agent_id');
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
    return { payload, ok: payload.ok };
  } catch (error) {
    if (error instanceof McpToolInputError) throw error;
    const payload = remoteErrorEnvelope(error);
    return { payload, ok: false };
  }
}
