/**
 * 通用 CLI worker（我作为 agent 用这个）
 * 调任意命令执行任务。设计：把 task.goal_md 写入临时文件，命令读取它执行。
 *
 * 用法：
 *   BIAO_AGENT_ID=me-1 BIAO_EXEC_CMD="cat" node dist/worker/cli.js
 *   → 对每个任务，执行 cat <goal_md_file>
 *
 * 或更实用：BIAO_EXEC_CMD="your-script.sh"
 *   → your-script.sh <task_id> <goal_md_file> <work_dir>
 *
 * 这个 worker 让外部任意程序/脚本/人工充当 agent。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkerLoop, runAgentCli, type WorkerConfig } from './base.js';
import type { ClaimedTask } from '../types/index.js';
import { buildQuestionResumeContext } from '../communication/question-context.js';

export interface CliWorkerOptions extends Partial<WorkerConfig> {
  execCmd?: string;
  model?: string;
}

/** 可被共享 Supervisor 复用的通用执行器 slot。 */
export function createCliWorkerConfig(overrides: CliWorkerOptions = {}): WorkerConfig {
  const agentId = overrides.agentId ?? process.env.BIAO_AGENT_ID ?? 'cli-1';
  const maxTasks = overrides.maxTasks ?? Number(process.env.BIAO_MAX_TASKS ?? '0');
  const execCmd = overrides.execCmd ?? process.env.BIAO_EXEC_CMD;
  const model = overrides.model ?? process.env.BIAO_MODEL ?? 'human';
  const preferredProject = overrides.preferredProject ?? process.env.BIAO_PREFERRED_PROJECT;
  const idlePollMs = overrides.idlePollMs ?? (Number(process.env.BIAO_IDLE_POLL_MS ?? '5000') || 5000);
  const heartbeatMs = overrides.heartbeatMs ?? (Number(process.env.BIAO_HEARTBEAT_MS ?? '30000') || 30000);
  const exitOnIdle = overrides.exitOnIdle ?? (process.env.BIAO_EXIT_ON_IDLE
    ? /^(1|true|yes)$/i.test(process.env.BIAO_EXIT_ON_IDLE)
    : undefined);
  if (!execCmd) throw new Error('缺少 BIAO_EXEC_CMD（通用 Worker 需要执行命令）');

  return {
    agentId,
    agentType: overrides.agentType ?? 'cli',
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
    async execute(task: ClaimedTask, projectPath: string) {
      // 把 goal_md 写到 work 目录
      const workDir = join(projectPath, 'work', task.task_id);
      mkdirSync(workDir, { recursive: true });
      const goalMdPath = join(workDir, 'goal.md');
      writeFileSync(goalMdPath, buildCliGoal(task));

      // 拆分 execCmd 为 command + args（支持简单空格分隔）
      const parts = execCmd.split(/\s+/);
      const command = parts[0];
      const baseArgs = parts.slice(1);
      // 传 3 个参数：task_id, goal_md_file, work_dir
      const args = [...baseArgs, task.task_id, goalMdPath, workDir];

      console.log(`[cli-worker] 执行：${command} ${args.join(' ')}`);

      const run = await runAgentCli(command, args, projectPath, task.timeout_seconds ?? 1800);

      // 改动文件：从 git diff 解析
      const changedFiles = await getChangedFiles(projectPath).catch(() => []);

      return { run, changedFiles, backend: 'cli', model };
    },
    ...overrides,
  };
}

/** 构造交给自定义 CLI Agent 的目标文件，包含 Question 恢复上下文。 */
export function buildCliGoal(task: ClaimedTask): string {
  return `${task.goal_md}

## Biao PM 通讯协议

若缺少 PM 决策，不要向人类直接提问。结束命令时在 stdout 单独输出一行：

\`BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成/待恢复上下文"}\`

平台会保存问题、释放当前任务给其他 Worker；PM 回答后，你以新 claim 重新领取。
${buildQuestionResumeContext(task)}`;
}

export async function main(): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runWorkerLoop(createCliWorkerConfig({ signal: shutdown.signal }));
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** 用 git diff 解析本任务改动的文件（简化：返回 working tree 改动的文件） */
async function getChangedFiles(projectPath: string): Promise<string[]> {
  const { execSync } = await import('node:child_process');
  try {
    const out = execSync('git diff --name-only HEAD 2>/dev/null || git status --porcelain', {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 10000,
    });
    return out.split('\n').map((l) => l.trim().replace(/^.{2}\s*/, '')).filter(Boolean);
  } catch {
    return [];
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[cli-worker] 错误：', e);
    process.exit(1);
  });
}
