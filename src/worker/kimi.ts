/**
 * Kimi worker（对应 08 号 md）
 * 调 PATH 中的 kimi（可用 BIAO_KIMI_BIN 覆盖）执行任务
 * 调用语法（经调研 zcode-pm + kimi 文档确认）：
 *   kimi -m kimi-code/k3 -p "<prompt>" --output-format stream-json
 * prompt 走 argv，cwd 设项目根，凭证自动读 ~/.kimi-code/credentials/
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runWorkerLoop, runAgentCli, type WorkerConfig } from './base.js';
import type { ClaimedTask } from '../types/index.js';
import { buildQuestionResumeContext } from '../communication/question-context.js';

const KIMI_BIN = process.env.BIAO_KIMI_BIN ?? 'kimi';
const KIMI_MODEL = process.env.BIAO_KIMI_MODEL ?? 'kimi-code/k3';

export interface KimiWorkerOptions extends Partial<WorkerConfig> {
  kimiBin?: string;
  kimiModel?: string;
}

/** task 显式模型优先；repair/reverify 会从来源继承该字段。 */
export function resolveKimiTaskModel(task: Pick<ClaimedTask, 'model_override'>, fallback: string): string {
  return task.model_override?.trim() || fallback;
}

/** 可被共享 Supervisor 复用的 Kimi slot，不在 import 时自行启动。 */
export function createKimiWorkerConfig(overrides: KimiWorkerOptions = {}): WorkerConfig {
  const agentId = overrides.agentId ?? process.env.BIAO_AGENT_ID ?? 'kimi-1';
  const maxTasks = overrides.maxTasks ?? Number(process.env.BIAO_MAX_TASKS ?? '0');
  const preferredProject = overrides.preferredProject ?? process.env.BIAO_PREFERRED_PROJECT;
  const idlePollMs = overrides.idlePollMs ?? (Number(process.env.BIAO_IDLE_POLL_MS ?? '5000') || 5000);
  const blockingClaimTimeoutMs = overrides.blockingClaimTimeoutMs
    ?? Number(process.env.BIAO_CLAIM_LONG_POLL_MS ?? '50000');
  const heartbeatMs = overrides.heartbeatMs ?? (Number(process.env.BIAO_HEARTBEAT_MS ?? '30000') || 30000);
  const exitOnIdle = overrides.exitOnIdle ?? (process.env.BIAO_EXIT_ON_IDLE
    ? /^(1|true|yes)$/i.test(process.env.BIAO_EXIT_ON_IDLE)
    : undefined);
  const kimiBin = overrides.kimiBin ?? KIMI_BIN;
  const kimiModel = overrides.kimiModel ?? KIMI_MODEL;

  return {
    agentId,
    agentType: overrides.agentType ?? 'kimi',
    maxTasks,
    preferredProject,
    idlePollMs,
    blockingClaimTimeoutMs,
    heartbeatMs,
    exitOnIdle,
    capabilities: overrides.capabilities ?? ['code', 'review', 'research', 'docs', 'acceptance'],
    signal: overrides.signal,
    client: overrides.client,
    biaoUrl: overrides.biaoUrl,
    preclaimedTask: overrides.preclaimedTask,
    skipRegistration: overrides.skipRegistration,
    heartbeatWhenIdle: overrides.heartbeatWhenIdle,
    async execute(task: ClaimedTask, projectPath: string, signal?: AbortSignal) {
      const taskModel = resolveKimiTaskModel(task, kimiModel);
      const prompt = buildKimiPrompt(task, agentId);
      console.log(`[kimi-worker] 调用 kimi（model=${taskModel}, cwd=${projectPath}）`);
      const run = await runAgentCli(
        kimiBin,
        ['-m', taskModel, '-p', prompt, '--output-format', 'stream-json'],
        projectPath,
        task.timeout_seconds ?? 1800,
        undefined,
        undefined,
        signal,
      );
      // 从 stream-json 输出解析改动文件 + 提取文本结果
      const { changedFiles, text } = parseKimiOutput(run.stdout);
      console.log(`[kimi-worker] kimi 退出 exit=${run.exitCode}，改动 ${changedFiles.length} 文件`);
      return { run: { ...run, stdout: text || run.stdout }, changedFiles, backend: 'kimi_code', model: taskModel };
    },
    ...overrides,
  };
}

export async function main(): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runWorkerLoop(createKimiWorkerConfig({ signal: shutdown.signal }));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

export function buildKimiPrompt(task: ClaimedTask, agentId = 'kimi'): string {
  return `${task.goal_md}

## 执行上下文
- 你的 agent_id：${agentId}
- 任务 ID：${task.task_id}
- 项目根目录：${task.project_path}
- 文件所有权：${(task.ownership_files ?? []).join(', ') || '未声明'}（你只能改这些文件）
- 验证命令：${(task.verify ?? []).map((v) => v.cmd).join(', ') || '无'}

## 要求
- 在项目根目录下工作，使用相对路径
- 完成所有 Required Work 后再退出
- 不要修改声明所有权之外的文件
- 禁止对所有权之外的文件执行 git checkout/restore/reset/clean 或任何“清理变更”；那些变更可能属于并行 Agent。发现时应保留现场并通过 BIAO_QUESTION 交给 PM
- 若需要 PM 决策，不要向当前人类直接提问。最终输出一行 JSON 标记：
  BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成/待恢复上下文"}
  若问题是申请新增文件/模块范围，必须同时包含："requested_ownership":{"files":["相对路径或 glob"],"modules":["模块名"]}；文字中的“允许扩权”不会生效。
  运行层会将其写入 Biao Question；回答后新 claim 会附带 answer/checkpoint。
${buildQuestionResumeContext(task)}
`;
}

/** 解析 kimi --output-format stream-json 的输出 */
export function parseKimiOutput(stdout: string): { changedFiles: string[]; text: string } {
  const changedFiles = new Set<string>();
  const textParts: string[] = [];

  const asRecord = (value: unknown): Record<string, unknown> | undefined => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  );
  const addPaths = (value: unknown) => {
    const input = asRecord(value);
    if (!input) return;
    if (typeof input.file_path === 'string') changedFiles.add(input.file_path);
    if (typeof input.path === 'string') changedFiles.add(input.path);
  };
  const parseArguments = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const isWriteTool = (name: unknown) => (
    typeof name === 'string' && ['write', 'edit'].includes(name.toLowerCase())
  );
  const consumePart = (value: unknown) => {
    const part = asRecord(value);
    if (!part) return;
    if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
    if (part.type === 'tool_use' && (part.name === undefined || isWriteTool(part.name))) {
      addPaths(part.input);
    }
    // Kimi stream-json 的实机事件还会把工具调用放在
    // part={type:"tool",tool:"write",state:{input:{...}}} 中。
    if (part.type === 'tool' && isWriteTool(part.tool)) {
      addPaths(asRecord(part.state)?.input);
    }
  };

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Kimi v0.29 的增量事件使用 type/part；内部事件还可能包一层 event。
      consumePart(obj.part);
      consumePart(asRecord(obj.event)?.part);

      // 助手消息文本
      if (obj.role === 'assistant') {
        // content 可能是字符串（简短回复）或数组（含 tool_use）
        if (typeof obj.content === 'string') {
          textParts.push(obj.content);
        } else if (Array.isArray(obj.content)) {
          for (const c of obj.content) consumePart(c);
        }

        // Kimi v0.29 CLI 当前发布版把工具调用放在 role/tool_calls envelope 中。
        if (Array.isArray(obj.tool_calls)) {
          for (const callValue of obj.tool_calls) {
            const call = asRecord(callValue);
            const fn = asRecord(call?.function);
            if (fn && isWriteTool(fn.name)) addPaths(parseArguments(fn.arguments));
          }
        }
      }
      // tool_result 行的文件操作（部分版本）
      if (obj.type === 'tool_result' && obj.content) {
        // tool_result 一般不含文件路径，跳过
      }
    } catch {
      // 非 JSON 行跳过
    }
  }
  return { changedFiles: [...changedFiles], text: textParts.join('\n') };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[kimi-worker] 错误：', e);
    process.exit(1);
  });
}
