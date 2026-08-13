/**
 * Codex worker（对应 08 号 md）
 * 调 codex exec 执行任务
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runWorkerLoop, runAgentCli, type WorkerConfig } from './base.js';
import type { ClaimedTask } from '../types/index.js';
import { buildQuestionResumeContext } from '../communication/question-context.js';

/** 供共享 Supervisor 复用的 Codex slot 定义；不在 import 时自行启动循环。 */
export function createCodexWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const agentId = overrides.agentId ?? process.env.BIAO_AGENT_ID ?? 'codex-1';
  const maxTasks = overrides.maxTasks ?? Number(process.env.BIAO_MAX_TASKS ?? '0');
  const preferredProject = overrides.preferredProject ?? process.env.BIAO_PREFERRED_PROJECT;
  const idlePollMs = overrides.idlePollMs ?? (Number(process.env.BIAO_IDLE_POLL_MS ?? '5000') || 5000);
  const heartbeatMs = overrides.heartbeatMs ?? (Number(process.env.BIAO_HEARTBEAT_MS ?? '30000') || 30000);
  const exitOnIdle = overrides.exitOnIdle ?? (process.env.BIAO_EXIT_ON_IDLE
    ? /^(1|true|yes)$/i.test(process.env.BIAO_EXIT_ON_IDLE)
    : undefined);

  return {
    agentId,
    agentType: overrides.agentType ?? 'codex',
    maxTasks,
    preferredProject,
    idlePollMs,
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
      const invocation = buildCodexInvocation(task, agentId);
      const run = await runAgentCli(
        process.env.BIAO_CODEX_BIN?.trim() || 'codex',
        invocation.args,
        projectPath,
        task.timeout_seconds ?? 1800,
        undefined,
        invocation.stdin,
        signal,
      );
      const changedFiles = parseChangedFiles(run.stdout);
      return { run, changedFiles, backend: 'codex_exec', model: 'codex' };
    },
    ...overrides,
  };
}

/** Codex 从 stdin 读取任务书，避免把完整目标暴露在进程参数或碰到 argv 长度上限。 */
export function buildCodexInvocation(
  task: ClaimedTask,
  agentId = 'codex',
): { args: string[]; stdin: string } {
  return {
    // Worker 只继承 Codex 认证，不继承用户/项目级 rules 和 config；否则一台机器上的
    // “PM-first”等全局指令会改写平台已分配的 Worker 角色。ephemeral 也避免常驻
    // Supervisor 为每个短任务积累会话。网络仅在 Agent 实际运行期间开放。
    args: [
      'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
      '--color', 'never',
      '-c', 'sandbox_workspace_write.network_access=true',
      '-c', 'model_reasoning_effort="high"',
      '-s', 'workspace-write',
      '--json', '-',
    ],
    stdin: buildCodexPrompt(task, agentId),
  };
}

export async function main(): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await runWorkerLoop(createCodexWorkerConfig({ signal: shutdown.signal }));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/**
 * 生成给嵌入式 Codex 执行 Agent 的任务提示。
 *
 * `work/<task>/` 下的四个审计文件属于 Worker 调度器：它要基于 CLI 退出状态、
 * 标准输出和独立验证结果统一写入并上报。执行 Agent 若自行写入，会覆盖或伪造
 * 这些证据，因此这里只把它们作为明确的只读边界传达给 Agent。
 */
export function buildCodexPrompt(task: ClaimedTask, agentId = 'codex'): string {
  const workDir = `work/${task.task_id}`;
  const protectedArtifacts = [
    `${workDir}/result.md`,
    `${workDir}/result.json`,
    `${workDir}/.claim.json`,
    `${workDir}/.progress.json`,
  ];

  return `${task.goal_md}

## 执行上下文
- 你的 agent_id：${agentId}
- 任务 ID：${task.task_id}
- 文件所有权：${(task.ownership_files ?? []).join(', ') || '未声明'}（你只能改这些文件）
- 验证命令：${(task.verify ?? []).map((v) => v.cmd).join(', ') || '无'}

## 调度器审计产物边界（强制）
- 不得创建或修改以下文件：${protectedArtifacts.join('、')}。
- 这些文件由 Worker 调度器专属维护；你退出后，调度器会根据执行结果与验证结果生成并提交可审计产物。
- 不要自行写报告文件；请在最终输出清楚写明改动摘要和验证摘要，供调度器收集。
- 最终输出还必须单独包含一行机器可读清单：
  BIAO_CHANGED_FILES: ["相对路径/文件一", "相对路径/文件二"]
  只列本任务实际修改过的相对路径；没有修改时写 []，不要写绝对路径或审计产物路径。
- 若确实缺少 PM 决策：不要向当前人类会话提问、不要修改 plan；停止后在最终输出单独一行
  BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成和待恢复的上下文"}
  平台会持久化问题、释放当前 claim，回答后重新 claim 时会携带 answer/checkpoint。
${buildQuestionResumeContext(task)}
`;
}

export function parseChangedFiles(stdout: string): string[] {
  // 尝试从 codex --json 输出解析改动文件（格式因 codex 版本而异，简化处理）
  const files: string[] = [];
  try {
    const lines = stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'file_change' && obj.path) files.push(obj.path);
        if (obj.changed_files && Array.isArray(obj.changed_files)) files.push(...obj.changed_files);
        if (obj.type === 'item.completed' && obj.item?.type === 'agent_message' && typeof obj.item.text === 'string') {
          files.push(...parseChangedFilesMarker(obj.item.text));
        }
      } catch {
        // 非 JSON 行跳过
      }
    }
  } catch {
    // 忽略
  }
  return [...new Set(files)];
}

function parseChangedFilesMarker(text: string): string[] {
  const marker = text.match(/^BIAO_CHANGED_FILES:\s*(\[[^\r\n]*\])\s*$/m);
  if (!marker) return [];

  try {
    const files = JSON.parse(marker[1]);
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
  } catch {
    return [];
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[codex-worker] 错误：', e);
    process.exit(1);
  });
}
