/**
 * biao-node 真执行器（Phase 8 · §10.1 替换占位 → P12 真实执行）
 *
 * 收到 task attempt 后真实执行全链：
 * 1. workspace prepare（HTTP → 服务端 clone + 创建 attempt 分支）
 * 2. 拉取 task goal_md → 写入工作区 goal.md
 * 3. 在 attempt 工作区执行可配置命令（codex exec / kimi -p / claude -p / 自定义 shell）
 * 4. workspace finalize（HTTP → 服务端 commit + push）
 * 5. report（HTTP → 服务端生成 delivery）
 *
 * 执行器配置面：
 * - execCommand：执行命令（默认 'echo "placeholder"'；支持 ${workspace} ${goal_md_file} ${task_id} 变量）
 * - workspaceDir：工作区目录根
 * - biaoApiUrl：服务端 API 地址
 * - attemptToken：bva2 token（从 claim 响应获取）
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AttemptIntake } from './slots.js';
import type { WatchdogAttempt, AttemptStopReason } from './lease-watchdog.js';

export interface RealExecutorOptions {
  /** 服务端 API 地址 */
  biaoApiUrl: string;
  /** 工作区目录根（默认 <tmp>/biao-executor-workspaces） */
  workspaceDir?: string;
  /**
   * 执行命令（支持 ${workspace} ${goal_md_file} ${task_id} 变量替换）。
   * 示例：
   * - 'codex exec --quiet < ${goal_md_file}'
   * - 'kimi -p "$(cat ${goal_md_file})"'
   * - 'claude -p "$(cat ${goal_md_file})"'
   * - '/path/to/custom-script.sh ${task_id} ${goal_md_file} ${workspace}'
   */
  execCommand?: string;
  /** HTTP fetch 实现（测试注入） */
  fetchImpl?: typeof fetch;
  /** bva2 token 获取函数（从 claim 响应缓存） */
  getAttemptToken?: (attemptId: string) => string | undefined;
  /** bvn2 node credential */
  nodeCredential?: string;
  /** 执行超时（毫秒，默认 600000 = 10 分钟） */
  execTimeoutMs?: number;
}

export interface AttemptExecutionRecord {
  attempt_id: string;
  task_id: string;
  attempt_generation: number;
  adopted_at: number;
  lease_deadline_at: number;
  executor: 'real-phase8';
  prepare_state: 'pending' | 'started' | 'ready' | 'failed';
  execute_state: 'pending' | 'running' | 'done' | 'failed';
  finalize_state: 'pending' | 'started' | 'delivered' | 'failed';
  report_state: 'pending' | 'sent' | 'failed';
  workspace_path?: string;
  goal_md_file?: string;
  exec_command?: string;
  exec_exit_code?: number | null;
  exec_stdout?: string;
  exec_stderr?: string;
  error?: string;
  stopped_at?: number;
  stop_reason?: string;
}

export class RealExecutor {
  private readonly workspaceDir: string;
  private readonly execCommand: string;
  private readonly execTimeoutMs: number;
  private readonly biaoApiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAttemptToken: (attemptId: string) => string | undefined;
  private readonly nodeCredential: string | undefined;
  private readonly records = new Map<string, AttemptExecutionRecord>();

  constructor(options: RealExecutorOptions) {
    this.biaoApiUrl = options.biaoApiUrl;
    this.workspaceDir = options.workspaceDir ?? join(process.env.TMPDIR ?? '/tmp', 'biao-executor-workspaces');
    this.execCommand = options.execCommand ?? 'echo "biao placeholder: no execCommand configured"';
    this.execTimeoutMs = options.execTimeoutMs ?? 600_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.getAttemptToken = options.getAttemptToken ?? (() => undefined);
    this.nodeCredential = options.nodeCredential;
  }

  private headers(attemptId?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (attemptId) {
      const token = this.getAttemptToken(attemptId);
      if (token) h['Authorization'] = `Bearer ${token}`;
    } else if (this.nodeCredential) {
      h['Authorization'] = `Bearer ${this.nodeCredential}`;
    }
    return h;
  }

  /** 认领后记录工作快照 + 启动真实执行链。 */
  async recordAdopted(intake: AttemptIntake, deadlineWallMs: number, bootId: string): Promise<void> {
    const record: AttemptExecutionRecord = {
      attempt_id: intake.attempt_id,
      task_id: intake.task_id,
      attempt_generation: intake.attempt_generation,
      adopted_at: Date.now(),
      lease_deadline_at: deadlineWallMs,
      executor: 'real-phase8',
      prepare_state: 'pending',
      execute_state: 'pending',
      finalize_state: 'pending',
      report_state: 'pending',
    };
    this.records.set(intake.attempt_id, record);

    // 异步执行全链（不阻塞 tick）
    this.executeChain(intake.attempt_id, bootId).catch((err) => {
      const r = this.records.get(intake.attempt_id);
      if (r) {
        r.error = err instanceof Error ? err.message : String(err);
        r.execute_state = 'failed';
      }
    });
  }

  private async executeChain(attemptId: string, bootId: string): Promise<void> {
    const record = this.records.get(attemptId);
    if (!record) return;

    const workspacePath = join(this.workspaceDir, bootId, attemptId);
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    record.workspace_path = workspacePath;

    // 1. workspace prepare
    record.prepare_state = 'started';
    try {
      const prepareRes = await this.fetchImpl(
        `${this.biaoApiUrl}/v2/attempts/${attemptId}/workspace/prepare`,
        {
          method: 'POST',
          headers: this.headers(attemptId),
          body: JSON.stringify({}),
        },
      );
      if (!prepareRes.ok) {
        const body = await prepareRes.text().catch(() => '');
        throw new Error(`workspace prepare 失败: HTTP ${prepareRes.status} ${body.slice(0, 200)}`);
      }
      record.prepare_state = 'ready';
    } catch (err) {
      record.prepare_state = 'failed';
      record.error = `prepare: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // 2. 拉取 task goal_md → 写入工作区 goal.md
    const goalMdFile = join(workspacePath, 'goal.md');
    record.goal_md_file = goalMdFile;
    let goalMd = '';
    try {
      const taskRes = await this.fetchImpl(
        `${this.biaoApiUrl}/tasks/${record.task_id}`,
        { method: 'GET', headers: this.headers() },
      );
      if (taskRes.ok) {
        const taskBody = await taskRes.json().catch(() => ({})) as { data?: { goal_md?: string } };
        goalMd = taskBody?.data?.goal_md ?? '';
      }
    } catch {
      // goal_md 获取失败不阻塞执行——命令可能不需要它
    }
    writeFileSync(goalMdFile, goalMd || `task ${record.task_id} (no goal_md available)`, { mode: 0o600 });

    // 3. 执行配置命令（在工作区中）
    record.execute_state = 'running';
    record.exec_command = this.execCommand;
    try {
      const { exitCode, stdout, stderr } = await this.spawnExecCommand(
        this.execCommand, workspacePath, goalMdFile, record.task_id, attemptId,
      );
      record.exec_exit_code = exitCode;
      record.exec_stdout = stdout.slice(0, 4096);
      record.exec_stderr = stderr.slice(0, 4096);

      writeFileSync(join(workspacePath, 'execution-record.json'), JSON.stringify({
        attempt_id: attemptId,
        task_id: record.task_id,
        command: this.execCommand,
        exit_code: exitCode,
        stdout_bytes: stdout.length,
        stderr_bytes: stderr.length,
        executed_at: Date.now(),
        executor: 'real-phase8',
      }, null, 2), { mode: 0o600 });

      if (exitCode !== 0) {
        record.execute_state = 'failed';
        record.error = `execute: command exited with code ${exitCode}`;
        return;
      }
      record.execute_state = 'done';
    } catch (err) {
      record.execute_state = 'failed';
      record.error = `execute: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // 4. workspace finalize
    record.finalize_state = 'started';
    try {
      const finalizeRes = await this.fetchImpl(
        `${this.biaoApiUrl}/v2/attempts/${attemptId}/workspace/finalize`,
        {
          method: 'POST',
          headers: this.headers(attemptId),
          body: JSON.stringify({}),
        },
      );
      if (!finalizeRes.ok) {
        const body = await finalizeRes.text().catch(() => '');
        throw new Error(`workspace finalize 失败: HTTP ${finalizeRes.status} ${body.slice(0, 200)}`);
      }
      record.finalize_state = 'delivered';
    } catch (err) {
      record.finalize_state = 'failed';
      record.error = `finalize: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // 5. report
    record.report_state = 'sent';
    try {
      const reportRes = await this.fetchImpl(
        `${this.biaoApiUrl}/v2/attempts/${attemptId}/report`,
        {
          method: 'POST',
          headers: this.headers(attemptId),
          body: JSON.stringify({ status: 'done', artifact_refs: [] }),
        },
      );
      if (!reportRes.ok) {
        const body = await reportRes.text().catch(() => '');
        throw new Error(`report 失败: HTTP ${reportRes.status} ${body.slice(0, 200)}`);
      }
    } catch (err) {
      record.report_state = 'failed';
      record.error = `report: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 执行配置的命令。支持 ${workspace} ${goal_md_file} ${task_id} ${attempt_id} 变量。
   * 命令通过 shell（/bin/sh -c）执行，支持管道/重定向等 shell 特性。
   */
  private spawnExecCommand(
    commandTemplate: string,
    workspace: string,
    goalMdFile: string,
    taskId: string,
    attemptId: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const command = commandTemplate
      .replace(/\$\{workspace\}/g, workspace)
      .replace(/\$\{goal_md_file\}/g, goalMdFile)
      .replace(/\$\{task_id\}/g, taskId)
      .replace(/\$\{attempt_id\}/g, attemptId);

    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: workspace,
        env: {
          ...process.env,
          BIAO_WORKSPACE: workspace,
          BIAO_GOAL_MD_FILE: goalMdFile,
          BIAO_TASK_ID: taskId,
          BIAO_ATTEMPT_ID: attemptId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.execTimeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });

      child.on('error', (err) => {
        resolve({ exitCode: 1, stdout, stderr: `spawn error: ${err.message}` });
      });
    });
  }

  /** 停止后记录状态。 */
  recordStopped(attempt: WatchdogAttempt, reason: AttemptStopReason, recoveryRoot: string): void {
    const record = this.records.get(attempt.attempt_id);
    if (record) {
      record.stopped_at = Date.now();
      record.stop_reason = reason;
    }

    // recovery bundle 桩（lease 相关原因）
    if (reason === 'expiry_stop_window' || reason === 'lease_lost' || reason === 'fenced') {
      mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(recoveryRoot, `${attempt.attempt_id}.json`), JSON.stringify({
        attempt_id: attempt.attempt_id,
        task_id: attempt.task_id,
        attempt_generation: attempt.generation,
        reason,
        saved_at: Date.now(),
        status: 'pending_recovery',
        note: 'real-executor recovery bundle',
      }, null, 2), { mode: 0o600 });
    }
  }

  /** 获取执行记录（测试用）。 */
  getRecord(attemptId: string): AttemptExecutionRecord | undefined {
    return this.records.get(attemptId);
  }
}
