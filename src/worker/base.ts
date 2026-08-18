/**
 * Worker 公共层（对应 08 号 md）
 * - 封装 Biao 6 接口（register/claim/check_ownership/declare/report/release）
 * - 主循环
 * - 错误处理
 * - verify 命令真实执行
 * - result.md/result.json 真实写入
 */

import {
  readdirSync,
  statSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ClaimRequest,
  ClaimedTask,
  OwnershipScope,
  VerifyCommand,
  VerifyResult,
} from '../types/index.js';
import {
  assertSecureTaskArtifactContext,
  atomicWriteWorkerArtifact,
  isWorkerArtifactPathDenied,
  readWorkerArtifact,
  registeredWorkerArtifactContext,
  releaseWorkerArtifactContext,
  secureStandaloneClaimRecoveryContext,
  unlinkWorkerArtifact,
  type WorkerArtifactContext,
} from './artifact-security.js';
import { maybeEnsureSupervisor } from './ensure-supervisor.js';

const DEFAULT_BIAO_URL = process.env.BIAO_URL ?? 'http://localhost:7331';
const API_MAX_ATTEMPTS = 3;
const API_RETRY_BASE_MS = 25;

/**
 * 非 BIAO_ 前缀的凭据类变量剥离清单（22.3-06）。
 * Biao 控制面/持久化的全部自产变量都以 BIAO_ 前缀剥离；这里只补
 * 会泄露服务凭据的外部变量。新增敏感变量时同步维护此清单与单测。
 */
const CREDENTIAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'REDIS_URL',
  'REDIS_PASSWORD',
  'REDISCLI_AUTH',
]);

/** 单个 env 键是否属于"不得继承给子进程"的凭据类变量。 */
function isSensitiveEnvKey(key: string): boolean {
  // 前缀规则覆盖全部 BIAO_*（API token、SQLite/Redis 连接、V2 密钥环、
  // 节点 owner token 等）——新增 BIAO_ 变量默认即被剥离，无需登记。
  return key.startsWith('BIAO_') || CREDENTIAL_ENV_KEYS.has(key);
}

/**
 * Agent 和 verify 子进程都不能继承 Biao 控制面/持久化凭据（22.3-06）。
 * - 剥离全部 BIAO_* 前缀变量与凭据类服务变量（REDIS_URL 等）；
 * - 白名单语义：其余变量（PATH/HOME/LANG、模型供应商 API key 等 Agent
 *   自身运行所需）原样保留；
 * - 返回全新对象，不修改 process.env 与传入的 overrides。
 */
export function sanitizedChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(childEnv)) {
    if (isSensitiveEnvKey(key)) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableTransportError(error: unknown): boolean {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 3 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = current as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    for (const value of [candidate.message, candidate.code, candidate.name]) {
      if (typeof value === 'string') parts.push(value);
    }
    current = candidate.cause;
  }
  const text = parts.join(' ');
  return /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|fetch failed|socket closed|network error)\b/i.test(text);
}

function waitForApiRetry(attempt: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, API_RETRY_BASE_MS * (attempt + 1)));
}

/** Biao SDK：封装 6 个接口 */
export class BiaoClient {
  /**
   * 一个 BiaoClient 实例就是一个 Agent 生命周期。由客户端先生成 epoch，
   * 使 `/register` 的网络重试复用同一个幂等键；服务端返回后，后续
   * heartbeat/offline 也始终携带这个不可猜的 fencing token。
   */
  private readonly registrationId = `reg_${randomUUID().replaceAll('-', '')}`;

  constructor(
    public readonly url: string,
    public readonly agentId: string,
    private readonly apiToken: string | undefined = process.env.BIAO_API_TOKEN,
  ) {}

  /** Stable epoch identifier used by append-only ExecutionReceipt audit records. */
  getRegistrationId(): string {
    return this.registrationId;
  }

  private async api(path: string, init?: RequestInit): Promise<any> {
    for (let attempt = 0; attempt < API_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.url}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
            ...(init?.headers ?? {}),
          },
        });
        if (isRetryableHttpStatus(res.status) && attempt < API_MAX_ATTEMPTS - 1) {
          await waitForApiRetry(attempt);
          continue;
        }
        const raw = await res.text();
        let body: any;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        if (body && typeof body === 'object') return body;
        return {
          ok: false,
          data: null,
          error: {
            code: `HTTP_${res.status}`,
            message: raw || `Biao API 返回了无法解析的响应（HTTP ${res.status}）`,
          },
        };
      } catch (error) {
        if (!isRetryableTransportError(error) || attempt === API_MAX_ATTEMPTS - 1) throw error;
        await waitForApiRetry(attempt);
      }
    }
    throw new Error('Biao API 重试意外耗尽');
  }

  async register(agentType: string, capabilities: string[], endpoint?: string, projects?: string[]): Promise<any> {
    return this.api('/register', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.agentId,
        agent_type: agentType,
        capabilities,
        endpoint,
        projects,
        registration_id: this.registrationId,
      }),
    });
  }

  async heartbeat(currentTask?: string): Promise<any> {
    return this.api('/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.agentId,
        registration_id: this.registrationId,
        current_task: currentTask,
      }),
    });
  }

  async offline(
    reason: 'worker_exit' | 'worker_signal' | 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit',
  ): Promise<any> {
    return this.api('/agent/offline', {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId, registration_id: this.registrationId, reason }),
    });
  }

  async claim(
    req: Omit<ClaimRequest, 'agent_id' | 'registration_id' | 'claim_request_id'>,
  ): Promise<{ ok: boolean; data: ClaimedTask | null }> {
    // 每次业务 claim 产生新 ID，api() 内的传输/5xx 重试复用同一 body。
    // 服务端因此可在“已提交但响应丢失”时重放原 claim token。
    const claimRequestId = `claim_${randomUUID().replaceAll('-', '')}`;
    return this.api('/claim', {
      method: 'POST',
      body: JSON.stringify({
        ...req,
        agent_id: this.agentId,
        registration_id: this.registrationId,
        claim_request_id: claimRequestId,
      }),
    });
  }

  async report(
    taskId: string,
    claimToken: string,
    status: 'done' | 'failed' | 'partial',
    resultPath?: string,
    resultJsonPath?: string,
    verifyResults?: VerifyResult[],
  ): Promise<any> {
    const response = await this.api('/report', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        agent_id: this.agentId,
        claim_token: claimToken,
        status,
        result_path: resultPath,
        result_json_path: resultJsonPath,
        verify_results: verifyResults,
      }),
    });
    // 上报成功即可能挂起新的 PM 门铃；opt-in 时顺带确认本机留守监视器在运行。
    if (response?.ok === true) maybeEnsureSupervisor();
    return response;
  }

  async checkOwnership(path: string): Promise<any> {
    return this.api(`/ownership?path=${encodeURIComponent(path)}&agent_id=${this.agentId}`);
  }

  async listActiveOwnership(): Promise<any> {
    return this.api('/ownership/active');
  }

  async getTask(taskId: string): Promise<{ ok: boolean; data: { status?: string; claimed_by?: string } | null }> {
    return this.api(`/task/${taskId}`);
  }

  async renewLease(taskId: string, claimToken: string, extendSeconds?: number): Promise<any> {
    return this.api('/lease/renew', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, claim_token: claimToken, extend_seconds: extendSeconds }),
    });
  }

  async declareOwnership(taskId: string, claimToken: string, files: string[], force = false): Promise<any> {
    return this.api('/ownership/declare', {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId, task_id: taskId, claim_token: claimToken, files, force }),
    });
  }

  async releaseOwnership(taskId: string, claimToken: string, files: string[]): Promise<any> {
    return this.api('/ownership/release', {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId, task_id: taskId, claim_token: claimToken, files }),
    });
  }

  /**
   * 释放当前 claim，转为可审计的 blocked 等待。
   *
   * 共享 Supervisor 使用它处理 ownership/dependency 条件：服务端会原子释放 lease
   * 与 ownership；文件/依赖等待可经受控 resume 回 pending，PM 决策必须使用 Question。
   */
  async blockTask(
    taskId: string,
    claimToken: string,
    reason: 'waiting_file_release' | 'waiting_dependency',
  ): Promise<any> {
    return this.api(`/task/${encodeURIComponent(taskId)}/block`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId, claim_token: claimToken, reason }),
    });
  }

  /**
   * Worker 向所属 plan 的 PM 发起持久化 Question。
   *
   * 这是唯一的提问出口：服务端会原子地校验 claim token、释放旧 lease/ownership、
   * 把任务转为 blocked，并只向对应 PM consumer 写一条最小门铃事件。Worker 不应把
   * 问题打印给当前人类会话后继续等待。
   */
  async createQuestion(
    taskId: string,
    claimToken: string,
    body: string,
    checkpoint?: string,
    requestedOwnership?: Partial<OwnershipScope>,
  ): Promise<any> {
    return this.api('/question', {
      method: 'POST',
      body: JSON.stringify({
        task_id: taskId,
        agent_id: this.agentId,
        claim_token: claimToken,
        body,
        checkpoint,
        requested_ownership: requestedOwnership,
      }),
    });
  }
}

type WorkerReportStatus = 'done' | 'failed' | 'partial';

/**
 * 把服务端的修复闭环响应收敛成一组短日志。Worker 只需要知道继续领任务、
 * 还是已移交 PM；不把完整 failure/verify 细节重复刷到常驻输出里。
 */
function logReportLifecycle(
  agentId: string,
  taskId: string,
  status: WorkerReportStatus,
  response: any,
): void {
  console.log(`[worker:${agentId}]   ✓ ${status}：${taskId}`);
  if (status === 'done') {
    console.log(`[worker:${agentId}]   已提交待独立 PM 验收；不要把 done 当作最终完成。`);
    return;
  }

  const resolution = response?.data?.resolution as {
    state?: 'required' | 'repairing' | 'needs_pm_decision';
    action?: 'repair' | 'reverify' | 'inspect';
    source_task_id?: string;
    repair_task_id?: string;
  } | undefined;
  const generatedFixes = Array.isArray(response?.data?.fix_tasks_generated)
    ? [...new Set(response.data.fix_tasks_generated.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))]
    : [];

  if (resolution?.repair_task_id) {
    console.log(`[worker:${agentId}]   自动修复：${resolution.source_task_id ?? taskId} → ${resolution.repair_task_id}`);
    console.log(`[worker:${agentId}]   下一步：不重置原任务，继续领取下一项；修复完成后将进入独立 PM 验收。`);
  } else if (generatedFixes.length > 0) {
    console.log(`[worker:${agentId}]   自动修复任务：${generatedFixes.join(', ')}`);
    console.log(`[worker:${agentId}]   下一步：不重置原任务，继续领取下一项；修复完成后将进入独立 PM 验收。`);
  } else if (resolution?.state === 'needs_pm_decision') {
    console.log(`[worker:${agentId}]   ⚠ 自动修复已到上限，平台已通知对应 PM；不要自行 reset 或向人类会话追问。`);
  } else {
    console.log(`[worker:${agentId}]   ⚠ 失败已记录但未收到修复任务；用 biao task get ${taskId} 核实闭环，勿盲目 reset。`);
  }
}

/** Agent 通过 stdout 请求 PM 决策的受控标记。 */
export interface WorkerQuestion {
  body: string;
  checkpoint?: string;
  requestedOwnership?: Partial<OwnershipScope>;
}

/**
 * `codex exec --json` 将最终 Agent 回复编码为 JSONL item.completed。
 * 一旦发现此类结构化流，只信任最后一个明确的 agent_message，避免把工具日志或
 * 其他 JSON 字段当作 Worker 对 PM 的控制指令。
 */
function finalCodexAgentMessage(stdout: string): { structured: boolean; text?: string } {
  let structured = false;
  let text: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== 'item.completed') continue;

    structured = true;
    const item = event.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const completed = item as Record<string, unknown>;
    if (completed.type === 'agent_message') {
      // 最后一条 agent_message 即使缺失 text，也不能回退到更早的消息。
      text = typeof completed.text === 'string' ? completed.text : undefined;
    }
  }

  return { structured, text };
}

/**
 * 解析 agent 的单行提问标记。
 *
 * 标记刻意使用 JSON，避免把普通日志或自然语言猜测成 PM 指令：
 * `BIAO_QUESTION: {"body":"需要确认…","checkpoint":"已完成…"}`。
 * 出现格式错误的标记会抛错，当前任务随后按失败处理，而不会退回到“问当前人类”。
 */
export function extractQuestionMarker(stdout: string): WorkerQuestion | undefined {
  const codexMessage = finalCodexAgentMessage(stdout);
  if (codexMessage.structured && !codexMessage.text) return undefined;

  const markerSource = codexMessage.text ?? stdout;
  const markerLines = markerSource.split(/\r?\n/).filter((line) => line.trim().startsWith('BIAO_QUESTION:'));
  if (markerLines.length === 0) return undefined;
  const raw = markerLines.at(-1)!.slice(markerLines.at(-1)!.indexOf('BIAO_QUESTION:') + 'BIAO_QUESTION:'.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BIAO_QUESTION 标记必须是单行 JSON：{"body":"...","checkpoint":"..."}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BIAO_QUESTION 标记必须是 JSON 对象');
  }
  const candidate = parsed as Record<string, unknown>;
  const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
  if (!body) throw new Error('BIAO_QUESTION.body 不能为空');
  const checkpoint = typeof candidate.checkpoint === 'string' ? candidate.checkpoint.trim() : undefined;
  let requestedOwnership: Partial<OwnershipScope> | undefined;
  if (candidate.requested_ownership !== undefined) {
    const value = candidate.requested_ownership;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('BIAO_QUESTION.requested_ownership 必须是 JSON 对象');
    }
    const scope = value as Record<string, unknown>;
    const parseEntries = (kind: 'files' | 'modules'): string[] | undefined => {
      const entries = scope[kind];
      if (entries === undefined) return undefined;
      if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
        throw new Error(`BIAO_QUESTION.requested_ownership.${kind} 必须是字符串数组`);
      }
      return entries;
    };
    requestedOwnership = { files: parseEntries('files'), modules: parseEntries('modules') };
  }
  return {
    body,
    ...(checkpoint ? { checkpoint } : {}),
    ...(requestedOwnership ? { requestedOwnership } : {}),
  };
}

/**
 * 轮询等待某个 ownership glob 被释放（对应 07 号 md 的冲突处理）
 * 不再硬等 5 分钟，改为每 pollMs 检查一次，最多等 maxWaitMs
 * @returns released=true 表示已释放（可继续），false 表示超时未释放
 */
export async function pollOwnershipRelease(
  client: BiaoClient,
  glob: string,
  pollMs = 30_000,
  maxWaitMs = 10 * 60_000,
): Promise<{ released: boolean; waitedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    const recheck = await client.checkOwnership(glob);
    // action=proceed 或 owner 是自己 → 已可用
    if (recheck.data?.action === 'proceed') {
      return { released: true, waitedMs: Date.now() - start };
    }
  }
  return { released: false, waitedMs: Date.now() - start };
}

/**
 * 处理单个 ownership glob 的冲突（preempt 抢占 / wait 轮询 / 超时放弃）
 * @returns true 表示可继续执行任务，false 表示应放弃当前任务
 * pollMs/maxWaitMs 可覆盖（测试用），默认 30s 轮询 / 最多 10 分钟
 */
export async function resolveOwnershipConflict(
  client: BiaoClient,
  glob: string,
  task: ClaimedTask,
  agentId: string,
  pollMs = 30_000,
  maxWaitMs = 10 * 60_000,
  mode: 'wait' | 'block' = 'wait',
): Promise<boolean> {
  const ownRes = await client.checkOwnership(glob);
  // action=proceed（含 owner 是自己）→ 直接通过
  if (!ownRes.data?.occupied || ownRes.data.action === 'proceed') {
    return true;
  }

  const owner = ownRes.data.owner;
  const myPri = task.priority ?? 5;
  const ownerPri = owner?.priority ?? 5;

  if (ownRes.data.action === 'preempt') {
    // 我的 priority 更高，抢占
    console.log(`[worker:${agentId}]   🔥 抢占 ${glob}：我的 pri=${myPri} > 占用者 pri=${ownerPri} (${owner?.agent_id})`);
    const declared = await client.declareOwnership(task.task_id, task.claim_token, [glob], true);
    if (!declared?.ok) {
      // check 与 force declare 之间 owner 可能已经变化。声明失败绝不能被投影为
      // proceed，否则 Worker 会在没有 ownership 的情况下执行。安全释放旧 claim，
      // 等平台 ownership doorbell 后再 fresh claim。
      const blocked = await client.blockTask(task.task_id, task.claim_token, 'waiting_file_release');
      if (!blocked?.ok) {
        throw new Error(
          `ownership 抢占失败且搁置失败：${declared?.error?.code ?? 'UNKNOWN'} / ` +
          `${blocked?.error?.code ?? 'UNKNOWN'}`,
        );
      }
      console.log(`[worker:${agentId}]   ⏸ ${glob} 抢占失败，已释放当前 claim，等待 ownership 恢复事件。`);
      return false;
    }
    return true;
  }

  // 共享 Supervisor 不允许每个 slot 各自 30 秒轮询：立即把旧 claim 安全搁置并
  // 释放 lease/ownership，等待 task_resumed/task_ready 等共享 doorbell 后再 fresh claim。
  if (mode === 'block') {
    const blocked = await client.blockTask(task.task_id, task.claim_token, 'waiting_file_release');
    if (!blocked?.ok) {
      throw new Error(`ownership 冲突搁置失败：${blocked?.error?.code ?? 'UNKNOWN'} ${blocked?.error?.message ?? ''}`.trim());
    }
    console.log(`[worker:${agentId}]   ⏸ ${glob} 被 ${owner?.agent_id} 占用，已释放当前 claim，等待共享 Supervisor 的恢复事件。`);
    return false;
  }

  // action=wait：仅保留给遗留独立 Worker 的兼容路径。文件占用是调度状态，
  // 不是产品决策；不应创建 Question，更不应向当前人类会话追问。
  console.log(`[worker:${agentId}]   ⏸ ${glob} 被 ${owner?.agent_id} (pri=${ownerPri}) 占用，我的 pri=${myPri}`);
  console.log(`[worker:${agentId}]      兼容等待：30s/次、最多10min；由平台处理文件释放，不打扰 PM 或人类。`);
  const waited = await pollOwnershipRelease(client, glob, pollMs, maxWaitMs);
  if (waited.released) {
    console.log(`[worker:${agentId}]   ✓ ${glob} 已释放（等了 ${Math.round(waited.waitedMs / 1000)}s），继续`);
    return true;
  }
  console.log(`[worker:${agentId}]   ⏰ 等待 10 分钟后 ${glob} 仍未释放，已转为平台内部等待`);
  const blocked = await client.blockTask(task.task_id, task.claim_token, 'waiting_file_release');
  if (!blocked?.ok) {
    throw new Error(`ownership 冲突搁置失败：${blocked?.error?.code ?? 'UNKNOWN'} ${blocked?.error?.message ?? ''}`.trim());
  }
  return false;
}

/** 执行 verify 命令（对应 P1） */
export function runVerifyCommands(verifyList: VerifyCommand[], projectPath: string): VerifyResult[] {
  const results: VerifyResult[] = [];
  for (const v of verifyList) {
    const timeout = (v.timeout ?? 300) * 1000;
    try {
      const projectRoot = resolve(projectPath);
      const scopeDir = v.scope && v.scope !== '.' ? resolve(projectRoot, v.scope) : projectRoot;
      const scopeRel = relative(projectRoot, scopeDir);
      if (
        v.scope?.includes('\0') ||
        scopeRel === '..' ||
        scopeRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(scopeRel)
      ) {
        throw new Error(`VERIFY_SCOPE_DENIED: scope 必须位于项目根目录内（${v.scope ?? ''}）`);
      }
      const output = execSyncCapture(v.cmd, scopeDir, timeout);
      results.push({
        cmd: v.cmd,
        exit_code: output.exitCode,
        passed: output.exitCode === (v.expect_exit ?? 0),
        output: output.stdout.slice(0, 5000),
      });
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; status?: number; message?: string };
      results.push({
        cmd: v.cmd,
        exit_code: err.code ?? err.status ?? -1,
        passed: false,
        output: (err.stdout ?? err.message ?? '').slice(0, 5000),
      });
    }
  }
  return results;
}

/** 同步捕获子进程输出（不抛异常，返回 exitCode） */
function execSyncCapture(cmd: string, cwd: string, timeoutMs: number): { exitCode: number; stdout: string } {
  try {
    const out = execSync(cmd, {
      cwd,
      env: sanitizedChildEnv(),
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: out };
  } catch (e: unknown) {
    const err = e as {
      status?: number;
      errno?: number | string;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    let exitCode: number;
    if (err.killed && err.signal) {
      exitCode = 124;
    } else if (typeof err.status === 'number') {
      exitCode = err.status;
    } else if (typeof err.errno === 'number') {
      exitCode = err.errno;
    } else {
      exitCode = 1;
    }
    const stdout = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? '');
    return { exitCode, stdout };
  }
}

/** 异步执行 agent CLI（带超时），返回 stdout/stderr/exitCode */
export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 外层 Worker/Supervisor 显式停止，不应作为业务失败交付。 */
  aborted?: boolean;
}

export type AgentTreeTerminationPlan =
  | { kind: 'process_group'; pid: number; signal: NodeJS.Signals }
  | { kind: 'taskkill'; command: 'taskkill.exe'; args: string[] };

/**
 * 进程树终止的跨平台契约。POSIX 子进程由 runAgentCli 以 detached 组 leader
 * 启动，因此负 pid 只会命中 Agent 自己的进程组，不会触及 Worker 父进程。
 * Windows 没有等价的负 pid 语义，使用系统 taskkill /T；SIGKILL 阶段增加 /F。
 */
export function agentTreeTerminationPlan(
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals,
): AgentTreeTerminationPlan {
  if (platform === 'win32') {
    return {
      kind: 'taskkill',
      command: 'taskkill.exe',
      args: ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
    };
  }
  return { kind: 'process_group', pid: -pid, signal };
}

const AGENT_ABORT_KILL_GRACE_MS = 1_000;
const AGENT_TIMEOUT_KILL_GRACE_MS = 5_000;

export function runAgentCli(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  env?: Record<string, string>,
  stdinInput?: string,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: 130,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      aborted: true,
    });
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const childEnv = sanitizedChildEnv(env);
    const useProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // POSIX 下让 Agent 成为独立进程组 leader，超时时可同时回收其工具/脚本孙进程。
      // Windows 没有负 pid 进程组信号，保持 ChildProcess.kill 兼容路径。
      detached: useProcessGroup,
    });

    if (stdinInput !== undefined) {
      // Agent 任务书可能很长且包含项目上下文。通过 stdin 传递可避免 argv 长度上限，
      // 也不会把正文暴露在 ps/process explorer 中。子进程提前退出时忽略 EPIPE，
      // 实际失败仍由 close/error 的退出码统一上报。
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(stdinInput);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminationReason: 'timeout' | 'abort' | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const signalAgentTree = (signal: NodeJS.Signals): void => {
      try {
        if (!child.pid) return;
        const plan = agentTreeTerminationPlan(process.platform, child.pid, signal);
        if (plan.kind === 'process_group') {
          process.kill(plan.pid, plan.signal);
        } else {
          const outcome = spawnSync(plan.command, plan.args, {
            windowsHide: true,
            stdio: 'ignore',
          });
          // taskkill.exe 是 Windows 标配；若运行环境损坏，至少回退终止直接子进程。
          if (outcome.error) child.kill(signal);
        }
      } catch (error) {
        // 进程可能恰好在检查与发送之间退出；其余信号失败仍写进 stderr 供结果审计。
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          stderr += `\n[${signal} failed: ${(error as Error).message}]`;
        }
      }
    };

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const beginTermination = (reason: 'timeout' | 'abort'): void => {
      if (terminationReason || child.exitCode !== null || child.signalCode !== null) return;
      terminationReason = reason;
      timedOut = reason === 'timeout';
      aborted = reason === 'abort';
      if (reason === 'abort' && timeoutTimer) clearTimeout(timeoutTimer);
      signalAgentTree('SIGTERM');
      forceKillTimer = setTimeout(() => {
        // child.killed 仅表示“信号发送成功”，不表示进程已经退出。必须读取真实
        // 退出状态，否则忽略 SIGTERM 的 Agent 会永久占住 Worker slot/lease。
        if (child.exitCode === null && child.signalCode === null) signalAgentTree('SIGKILL');
      }, reason === 'abort' ? AGENT_ABORT_KILL_GRACE_MS : AGENT_TIMEOUT_KILL_GRACE_MS);
      forceKillTimer.unref();
    };
    const onAbort = () => beginTermination('abort');

    timeoutTimer = setTimeout(() => beginTermination('timeout'), timeoutSeconds * 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
    // 覆盖 pre-check 与 listener 安装之间的竞态窗口。
    if (signal?.aborted) onAbort();

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 5 * 1024 * 1024) stdout = stdout.slice(-5 * 1024 * 1024);
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        // 保持旧 timeout 契约：进程若在 SIGTERM 后自行退出，保留它的真实 code；
        // 只有被信号终止导致 code=null 时才投影为 124。abort 则是独立的生命周期码 130。
        exitCode: aborted ? 130 : (code ?? (timedOut ? 124 : 1)),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
      });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        exitCode: aborted ? 130 : 127,
        stdout,
        stderr: stderr + '\n[spawn error]',
        durationMs: Date.now() - startedAt,
        timedOut: false,
        aborted,
      });
    });
  });
}

/** 写 result.md + result.json（对应 P4 真实格式） */
export function writeResult(
  workDir: string,
  task: ClaimedTask,
  agentRun: AgentRunResult,
  verifyResults: VerifyResult[],
  agentId: string,
  backend: string,
  model: string,
  changedFiles: string[],
): { resultMdPath: string; resultJsonPath: string } {
  const artifactContext = assertSecureTaskArtifactContext(workDir, task.task_id, task.project_path);

  const passedCount = verifyResults.filter((v) => v.passed).length;
  const failedCount = verifyResults.length - passedCount;
  const overallStatus = agentRun.timedOut
    ? 'timeout'
    : agentRun.exitCode === 0 && failedCount === 0
      ? 'success'
      : 'failed';

  const resultMd = `# 任务结果：${task.title}

## 执行摘要
- agent: ${agentId}（${backend}）
- 模型: ${model}
- 退出码: ${agentRun.exitCode}${agentRun.timedOut ? '（超时）' : ''}
- 耗时: ${(agentRun.durationMs / 1000).toFixed(1)}s

## 改动文件
${changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join('\n') : '（未检测到改动，或 agent 未报告）'}

## 验证结果
${verifyResults.length > 0 ? verifyResults.map((v) => `- ${v.cmd}: ${v.passed ? 'PASS' : 'FAIL'}（exit=${v.exit_code}）`).join('\n') : '- 无验证命令'}

${failedCount > 0 ? `## 失败详情\n${verifyResults.filter((v) => !v.passed).map((v) => '```\n' + (v.output ?? '') + '\n```').join('\n')}` : ''}

## 残留风险
- 由 ${backend} worker 产出
`;

  const resultJson = {
    status: overallStatus,
    worker: agentId,
    backend,
    model,
    returncode: agentRun.exitCode,
    timed_out: agentRun.timedOut,
    verify_results: verifyResults,
    changed_files: changedFiles,
    duration_seconds: Number((agentRun.durationMs / 1000).toFixed(1)),
    stdout_tail: agentRun.stdout.slice(-2000),
    stderr_tail: agentRun.stderr.slice(-2000),
  };

  atomicWriteWorkerArtifact(artifactContext, 'result.md', resultMd);
  atomicWriteWorkerArtifact(
    artifactContext,
    'result.json',
    JSON.stringify(resultJson, null, 2),
  );
  // 保持既有 report 契约：返回 task.project_path 体系下的路径；写入本身使用规范目录。
  const resultMdPath = join(workDir, 'result.md');
  const resultJsonPath = join(workDir, 'result.json');

  return { resultMdPath, resultJsonPath };
}

/** crash recovery：claim 成功后把不可逆的领取元数据持久化到 work 目录。
 *  Redis 被清 / lease 过期时，.claim.json 可供人工核对“这个 worker 当时在跑什么”；
 *  文件不包含原始 claim token，不能用于恢复或冒充领取。 */
export interface ClaimFile {
  task_id: string;
  /** 只用于人工比对，不可还原为可用凭据。 */
  claim_fingerprint: string;
  agent_id: string;
  claimed_at: number;
}

export function writeClaimFile(workDir: string, task: ClaimedTask, agentId: string): string {
  const expectedTaskWorkDir = resolve(task.project_path || process.cwd(), 'work', task.task_id);
  // 正式 Worker 只能走 project/work/task 绑定；旧 crash-recovery 测试所需的独立
  // 临时目录由专用能力承接，不再向任意 artifact API 暴露 allowStandalone。
  const artifactContext = resolve(workDir) === expectedTaskWorkDir
    ? assertSecureTaskArtifactContext(workDir, task.task_id, task.project_path)
    : secureStandaloneClaimRecoveryContext(workDir);
  const data: ClaimFile = {
    task_id: task.task_id,
    claim_fingerprint: createHash('sha256').update(task.claim_token).digest('hex').slice(0, 16),
    agent_id: agentId,
    claimed_at: Date.now(),
  };
  return atomicWriteWorkerArtifact(artifactContext, '.claim.json', JSON.stringify(data, null, 2));
}

export function clearClaimFile(workDir: string, task?: ClaimedTask): void {
  const artifactContext = registeredWorkerArtifactContext(
    workDir,
    task?.task_id,
    task?.project_path,
  );
  // unlinkWorkerArtifact 自身忽略 ENOENT；身份不可信必须向上传播，不能静默吞掉。
  unlinkWorkerArtifact(artifactContext, '.claim.json');
}

/**
 * 外层 Worker 调度器的可审计进度。执行 Agent 无权写这个文件；其中刻意不保存
 * claim token、API token、stdout/stderr 或异常正文，避免把控制面凭据复制到项目目录。
 */
export type WorkerProgressStage =
  | 'claimed'
  | 'running'
  | 'verifying'
  | 'reporting'
  | 'blocked'
  | 'finished'
  | 'failed';

export type WorkerProgressReportDelivery =
  | 'pending'
  | 'reported'
  | 'confirmed_after_uncertain_response'
  | 'rejected'
  | 'unknown';

export type WorkerProgressFailureReason =
  | 'waiting_file_release'
  | 'lease_stale'
  | 'waiting_pm_reply'
  | 'execution_or_verification_failed'
  | 'report_delivery_unknown'
  | 'claim_token_invalid'
  | 'report_rejected'
  | 'worker_exception';

export interface WorkerProgressUpdate {
  artifactsWritten?: boolean;
  reportStatus?: 'done' | 'failed' | 'partial';
  reportDelivery?: WorkerProgressReportDelivery;
  /** 只允许调度器生成的受控分类；不得传入原始异常或远端响应正文。 */
  failureReason?: WorkerProgressFailureReason;
}

export interface WorkerProgressFile {
  schema_version: 1;
  task_id: string;
  agent_id: string;
  attempt_id: string;
  status: 'running' | 'blocked' | 'done' | 'failed';
  stage: WorkerProgressStage;
  started_at: string;
  updated_at: string;
  artifacts: {
    result_md: boolean;
    result_json: boolean;
  };
  report?: {
    status: 'done' | 'failed' | 'partial';
    delivery: WorkerProgressReportDelivery;
  };
  failure_reason?: WorkerProgressFailureReason;
  history: Array<{ stage: WorkerProgressStage; at: string }>;
}

function progressStatus(stage: WorkerProgressStage): WorkerProgressFile['status'] {
  if (stage === 'finished') return 'done';
  if (stage === 'failed') return 'failed';
  if (stage === 'blocked') return 'blocked';
  return 'running';
}

/** 同目录临时文件 + rename，保证读者只会看到完整 JSON；最终文件始终收紧为 0600。 */
function persistWorkerProgress(context: WorkerArtifactContext, value: WorkerProgressFile): void {
  atomicWriteWorkerArtifact(context, '.progress.json', JSON.stringify(value, null, 2));
}

export class WorkerProgressTracker {
  private readonly value: WorkerProgressFile;
  private readonly artifactContext: WorkerArtifactContext;

  constructor(
    workDir: string,
    task: ClaimedTask,
    agentId: string,
  ) {
    this.artifactContext = assertSecureTaskArtifactContext(workDir, task.task_id, task.project_path);
    const now = new Date().toISOString();
    this.value = {
      schema_version: 1,
      task_id: task.task_id,
      agent_id: agentId,
      attempt_id: randomUUID(),
      status: 'running',
      stage: 'claimed',
      started_at: now,
      updated_at: now,
      artifacts: { result_md: false, result_json: false },
      history: [{ stage: 'claimed', at: now }],
    };
    persistWorkerProgress(this.artifactContext, this.value);
  }

  get stage(): WorkerProgressStage {
    return this.value.stage;
  }

  advance(stage: WorkerProgressStage, update: WorkerProgressUpdate = {}): void {
    const now = new Date().toISOString();
    this.value.stage = stage;
    this.value.status = progressStatus(stage);
    this.value.updated_at = now;
    if (update.artifactsWritten !== undefined) {
      this.value.artifacts = {
        result_md: update.artifactsWritten,
        result_json: update.artifactsWritten,
      };
    }
    if (update.reportStatus !== undefined) {
      this.value.report = {
        status: update.reportStatus,
        delivery: update.reportDelivery ?? 'pending',
      };
    }
    if (update.failureReason !== undefined) this.value.failure_reason = update.failureReason;
    this.value.history.push({ stage, at: now });
    persistWorkerProgress(this.artifactContext, this.value);
  }
}

export function createWorkerProgressTracker(
  workDir: string,
  task: ClaimedTask,
  agentId: string,
): WorkerProgressTracker {
  return new WorkerProgressTracker(workDir, task, agentId);
}

/** 进度审计故障不能阻止 Worker 释放 lease/report；磁盘问题仍会留下明确本地警告。 */
function advanceWorkerProgress(
  tracker: WorkerProgressTracker | undefined,
  stage: WorkerProgressStage,
  update: WorkerProgressUpdate = {},
): void {
  try {
    tracker?.advance(stage, update);
  } catch (error) {
    console.warn(`[worker-progress] ${stage} 写入失败：${(error as Error).message}`);
  }
}

/* ---------------- plan MD 违规检测（MD 职责分离的技术执行） ---------------- */

/** plan MD 快照：plans 下所有 .md 的 {相对路径: contentHash} 字典 */
export type PlanMdSnapshot = Record<string, string>;

/** 递归收集目录下所有 .md 文件的 {相对路径: hash} */
function snapshotPlanMd(projectPath: string): PlanMdSnapshot {
  const plansDir = join(projectPath, 'plans');
  const snap: PlanMdSnapshot = {};
  if (!existsSync(plansDir)) return snap;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && name.endsWith('.md')) {
        try {
          const content = readFileSync(full, 'utf8');
          const rel = relative(plansDir, full).split(sep).join('/');
          snap[rel] = createHash('md5').update(content).digest('hex');
        } catch {
          // 读失败跳过
        }
      }
    }
  };
  walk(plansDir);
  return snap;
}

export interface PlanMdViolation {
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

/** 对比前后快照，返回违规（worker 改动/新增/删除的 plan MD） */
function diffPlanMd(before: PlanMdSnapshot, after: PlanMdSnapshot): PlanMdViolation[] {
  const violations: PlanMdViolation[] = [];
  const allPaths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const p of allPaths) {
    const inBefore = p in before;
    const inAfter = p in after;
    if (inBefore && !inAfter) {
      violations.push({ path: p, changeType: 'deleted' });
    } else if (!inBefore && inAfter) {
      violations.push({ path: p, changeType: 'created' });
    } else if (before[p] !== after[p]) {
      violations.push({ path: p, changeType: 'modified' });
    }
  }
  return violations;
}

/**
 * 将 Agent 报告/执行证据中的项目相对或绝对路径归一为 plans/ 内的相对路径。
 * 只接受真正落在当前项目 plans/ 中的 Markdown，防止 `..`/绝对路径误匹配。
 */
function reportedPlanMdPath(projectPath: string, reportedPath: string): string | undefined {
  const raw = reportedPath.trim();
  if (!raw) return undefined;
  const plansDir = resolve(projectPath, 'plans');
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectPath, raw);
  const planRelative = relative(plansDir, absolute);
  if (
    !planRelative ||
    isAbsolute(planRelative) ||
    planRelative === '..' ||
    planRelative.startsWith(`..${sep}`) ||
    !planRelative.toLowerCase().endsWith('.md')
  ) {
    return undefined;
  }
  return planRelative.split(sep).join('/');
}

/**
 * 全局哈希差只能证明“Worker 运行期间文件变了”，不能证明“是该 Agent 改的”。
 * 因此它只作为变更事实校验；归因边界必须再与 Agent 返回的 changedFiles 证据取交集。
 */
function attributablePlanMdViolations(
  projectPath: string,
  before: PlanMdSnapshot,
  after: PlanMdSnapshot,
  changedFiles: string[],
): PlanMdViolation[] {
  const reportedPlanFiles = new Set(
    changedFiles
      .map((path) => reportedPlanMdPath(projectPath, path))
      .filter((path): path is string => path !== undefined),
  );
  if (reportedPlanFiles.size === 0) return [];
  return diffPlanMd(before, after).filter((violation) => reportedPlanFiles.has(violation.path));
}

/* ---------------- Git 工作树边界（Worker 真实 changed_files 与 ownership gate） ---------------- */

export type ProjectFileSnapshot = Record<string, string>;

export interface ProjectFileChange {
  path: string;
  changeType: 'modified' | 'created' | 'deleted';
}

/**
 * 对 Git 已跟踪文件和未忽略的 untracked 文件做内容快照。
 *
 * 不能只保存 `git status` 的路径：一个文件在领取前已经 dirty，Worker 随后再次
 * 修改时，前后 status 仍然都是 `M`。内容 hash 才能同时做到“排除原有 dirty”与
 * “识别 dirty 文件在本次执行窗口内的再次变化”。忽略文件不属于交付源代码事实源；
 * work/ 是 Biao 自己的控制面产物，也明确排除。
 */
export function snapshotProjectFiles(projectPath: string): ProjectFileSnapshot | undefined {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: projectPath, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (listed.status !== 0 || !listed.stdout) return undefined;

  const paths = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  const snapshot: ProjectFileSnapshot = {};
  for (const gitPath of new Set(paths)) {
    const normalized = gitPath.split('\\').join('/');
    if (normalized === 'work' || normalized.startsWith('work/')) continue;
    const absolute = resolve(projectPath, gitPath);
    const rel = relative(resolve(projectPath), absolute);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        snapshot[normalized] = `symlink:${readlinkSync(absolute)}`;
      } else if (stat.isFile()) {
        snapshot[normalized] = `file:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
      } else {
        snapshot[normalized] = `other:${stat.mode}`;
      }
    } catch (error) {
      // tracked 但当前已删除的文件仍由 ls-files --cached 返回。缺失本身是快照状态，
      // 这样领取前已有的删除不会被误归因，本次执行中的删除则会产生 hash -> missing。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') snapshot[normalized] = 'missing';
      else throw error;
    }
  }
  return snapshot;
}

export function diffProjectFiles(
  before: ProjectFileSnapshot,
  after: ProjectFileSnapshot,
): ProjectFileChange[] {
  const changes: ProjectFileChange[] = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforeValue = before[path];
    const afterValue = after[path];
    if (beforeValue === afterValue) continue;
    const beforeExists = beforeValue !== undefined && beforeValue !== 'missing';
    const afterExists = afterValue !== undefined && afterValue !== 'missing';
    changes.push({
      path,
      changeType: beforeExists && !afterExists
        ? 'deleted'
        : !beforeExists && afterExists
          ? 'created'
          : 'modified',
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function globPatternMatchesPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.trim().replace(/^\.\//, '').split('\\').join('/');
  if (!normalizedPattern) return false;
  let regex = '^';
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i];
    if (char === '*' && normalizedPattern[i + 1] === '*') {
      i++;
      if (normalizedPattern[i + 1] === '/') {
        i++;
        regex += '(?:.*/)?';
      } else {
        regex += '.*';
      }
    } else if (char === '*') {
      regex += '[^/]*';
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${regex}$`).test(filePath);
}

function ownershipViolations(task: ClaimedTask, changes: ProjectFileChange[]): ProjectFileChange[] {
  const ownershipFiles = task.ownership_files ?? [];
  // ownership_modules 是语义/审计字段，不是文件路径授权。文件写门禁只接受
  // claim 中由平台激活过的 ownership_files，避免把 module 标签隐式解释成扩权。
  return changes.filter(({ path }) =>
    !ownershipFiles.some((pattern) => globPatternMatchesPath(pattern, path)),
  );
}

/**
 * 共享工作区里另一个 Worker 在本执行窗口内落盘时，全局 Git 快照会同时看到它。
 * 若该路径当前由另一个 Agent 的有效 ownership 覆盖，就不能把变更归责给本 Worker。
 * 没有他人 ownership 的未授权变化仍保留为 fail-closed，避免模型漏报绕过门禁。
 */
async function excludeChangesOwnedByOtherWorkers(
  client: BiaoClient,
  agentId: string,
  changes: ProjectFileChange[],
  agentReportedPaths: ReadonlySet<string>,
  ownershipAtExecutionStart: readonly { path: string; agent_id: string }[] = [],
): Promise<ProjectFileChange[]> {
  const decisions = await Promise.all(changes.map(async (change) => {
    // Kimi/Codex 工具流已明确记录当前 Agent 触碰该文件时，不能再用
    // “当前由他人 ownership 覆盖”把它排除。这正是 checkout/restore 覆盖
    // 他人未提交变更的高风险场景，必须 fail closed。
    if (agentReportedPaths.has(change.path)) return true;
    // 另一 Worker 可能先完成并释放 ownership，导致结束时查询看不到它；执行起点的
    // ownership 快照仍能证明该路径属于并发 lane。只对 Agent 未自报的路径生效，
    // 因此 checkout/restore 覆盖他人文件仍会按上面的 fail-closed 规则处理。
    if (ownershipAtExecutionStart.some((owner) =>
      owner.agent_id !== agentId && globPatternMatchesPath(owner.path, change.path),
    )) return false;
    try {
      const ownership = await client.checkOwnership(change.path);
      const ownerId = ownership?.data?.owner?.agent_id;
      return !(ownership?.data?.occupied && ownerId && ownerId !== agentId);
    } catch {
      // 无法证明属于他人时继续归入本 Worker 的安全审计边界。
      return true;
    }
  }));
  return changes.filter((_, index) => decisions[index]);
}

/** 执行前检查 lease 是否仍有效（crash recovery 核心判断）
 *  worker 走 HTTP 拿不到 lease key 本身，用 task 状态做代理：
 *  claim 后 task 应是 running 且 claimed_by=自己；若回 pending / 易主 / 查不到 → lease 已失效 */
export async function isLeaseStale(client: BiaoClient, taskId: string, agentId: string): Promise<boolean> {
  const r = await client.getTask(taskId);
  if (!r.ok || !r.data) return true; // task 查不到 → Redis 大概率被清
  if (r.data.status !== 'running') return true;
  if (r.data.claimed_by && r.data.claimed_by !== agentId) return true;
  return false;
}

type ReportDelivery =
  | { state: 'reported'; response: any }
  | { state: 'confirmed_after_uncertain_response'; response?: any }
  | { state: 'rejected'; response: any }
  | { state: 'unknown'; error?: unknown; response?: any };

function reportResponseMayBeAmbiguous(response: any): boolean {
  const code = String(response?.error?.code ?? '');
  return code === 'CLAIM_TOKEN_INVALID' ||
    code === 'TASK_NOT_RUNNING' ||
    /^HTTP_(?:408|429|5\d\d)$/.test(code);
}

async function confirmReportedTaskState(
  client: BiaoClient,
  taskId: string,
  agentId: string,
  intendedStatus: 'done' | 'failed',
): Promise<boolean> {
  try {
    const task = await client.getTask(taskId);
    return task.ok === true &&
      task.data?.status === intendedStatus &&
      task.data?.claimed_by === agentId;
  } catch {
    return false;
  }
}

/**
 * report 是写入终态的请求。若连接在服务端提交后断开，重复提交会因旧 token 被拒；
 * 此时只能读取 task 状态确认，绝不能将“响应未知”转换成新的 failed report。
 */
async function deliverReport(
  client: BiaoClient,
  task: ClaimedTask,
  agentId: string,
  status: 'done' | 'failed',
  resultMdPath: string | undefined,
  resultJsonPath: string | undefined,
  verifyResults: VerifyResult[],
): Promise<ReportDelivery> {
  try {
    const response = await client.report(
      task.task_id,
      task.claim_token,
      status,
      resultMdPath,
      resultJsonPath,
      verifyResults,
    );
    if (response?.ok) return { state: 'reported', response };
    if (reportResponseMayBeAmbiguous(response) && await confirmReportedTaskState(client, task.task_id, agentId, status)) {
      return { state: 'confirmed_after_uncertain_response', response };
    }
    return { state: 'rejected', response };
  } catch (error) {
    if (await confirmReportedTaskState(client, task.task_id, agentId, status)) {
      return { state: 'confirmed_after_uncertain_response' };
    }
    return { state: 'unknown', error };
  }
}

/** 主循环（公共，各 agent worker 复用） */
export interface WorkerConfig {
  agentId: string;
  agentType: string;
  biaoUrl?: string;
  maxTasks?: number; // 0 = 无限
  /** 空队列轮询间隔；maxTasks=0 时默认常驻轮询 */
  idlePollMs?: number;
  /** 显式要求空队列立即退出（一次性 worker） */
  exitOnIdle?: boolean;
  /** agent 心跳间隔 */
  heartbeatMs?: number;
  /** 注册时上报的能力；默认包含 acceptance，避免 Worker 自报能力与实际调度不一致。 */
  capabilities?: string[];
  /**
   * 由共享 Supervisor 已领取的任务。设定后本循环不会再次请求 /claim，
   * 只负责该任务的执行、续租、Question/report 收尾。
   */
  preclaimedTask?: ClaimedTask;
  /** Supervisor 已集中注册 slot 时跳过重复 register。 */
  skipRegistration?: boolean;
  /**
   * 是否在空闲时发 heartbeat。遗留单 Worker 入口默认 true；共享 Supervisor
   * 传 false，因此 idle slot 不会产生常驻心跳流量。
   */
  heartbeatWhenIdle?: boolean;
  /**
   * 共享 Supervisor 的 preclaimed 执行路径。文件 ownership 冲突时立即安全 block，
   * 不在 slot 内做 30 秒轮询；遗留单 Worker 保持 wait 兼容语义。
   */
  ownershipConflictMode?: 'wait' | 'block';
  /** 优雅停止信号 */
  signal?: AbortSignal;
  /** 可注入 client，便于嵌入与隔离测试 */
  client?: BiaoClient;
  /** 按项目过滤（只领该项目的任务）；undefined = 不过滤 */
  preferredProject?: string;
  /** 执行函数：task → (agentRun, changedFiles)，可通过 question 交回 PM 决策。 */
  execute: (task: ClaimedTask, projectPath: string, signal?: AbortSignal) => Promise<{
    run: AgentRunResult;
    changedFiles: string[];
    backend: string;
    model: string;
    question?: WorkerQuestion;
  }>;
}

export async function runWorkerLoop(cfg: WorkerConfig): Promise<void> {
  const client = cfg.client ?? new BiaoClient(cfg.biaoUrl ?? DEFAULT_BIAO_URL, cfg.agentId);
  const maxTasks = cfg.maxTasks ?? 0;
  const idlePollMs = Math.max(10, cfg.idlePollMs ?? 5000);
  const exitOnIdle = cfg.exitOnIdle ?? maxTasks > 0;
  const heartbeatMs = Math.max(1000, cfg.heartbeatMs ?? 30_000);
  const heartbeatWhenIdle = cfg.heartbeatWhenIdle ?? true;

  // 注册
  let ownsRegistration = false;
  if (!cfg.skipRegistration) {
    const registered = await client.register(
      cfg.agentType,
      cfg.capabilities ?? ['code', 'review', 'research', 'docs', 'acceptance'],
      undefined,
      cfg.preferredProject ? [cfg.preferredProject] : undefined,
    );
    if (registered?.ok === false) {
      throw new Error(`worker 注册失败：${registered.error?.code ?? 'UNKNOWN'} ${registered.error?.message ?? ''}`.trim());
    }
    ownsRegistration = true;
    console.log(`[worker:${cfg.agentId}] 注册为 ${cfg.agentType}${cfg.preferredProject ? `（项目: ${cfg.preferredProject}）` : ''}`);
  }

  let count = 0;
  let currentTask: string | undefined;
  let heartbeatInFlight = false;
  const sendHeartbeat = async () => {
    if (cfg.signal?.aborted) return;
    if (!heartbeatWhenIdle && !currentTask) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const r = await client.heartbeat(currentTask);
      if (r?.ok === false) {
        console.warn(`[worker:${cfg.agentId}] 心跳失败：${r.error?.code ?? 'UNKNOWN'}`);
      }
    } catch (e) {
      console.warn(`[worker:${cfg.agentId}] 心跳异常：${(e as Error).message}`);
    } finally {
      heartbeatInFlight = false;
    }
  };
  if (heartbeatWhenIdle) await sendHeartbeat();
  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, heartbeatMs);
  let preclaimedTask = cfg.preclaimedTask;
  let consecutiveClaimTransportFailures = 0;

  try {
  while (!cfg.signal?.aborted && (maxTasks === 0 || count < maxTasks)) {
    let claimRes: { ok: boolean; data: ClaimedTask | null };
    try {
      claimRes = preclaimedTask
        ? { ok: true, data: preclaimedTask }
        : await client.claim({ blocking: false, timeout_ms: 5000, preferred_project: cfg.preferredProject });
      consecutiveClaimTransportFailures = 0;
    } catch (error) {
      // 一次性 Worker 仍要把连接错误交给调用方；只有显式常驻的遗留入口在服务
      // 闪断时留在进程内恢复。新的多 harness 模式由 Supervisor 按需唤醒，不依赖
      // 这个循环轮询，但兼容入口也不能因约 150ms 的 SDK 重试耗尽而永久退出。
      if (exitOnIdle) throw error;
      consecutiveClaimTransportFailures += 1;
      const backoffMs = Math.min(
        60_000,
        Math.max(10, idlePollMs) * (2 ** Math.min(consecutiveClaimTransportFailures - 1, 6)),
      );
      console.warn(
        `[worker:${cfg.agentId}] 领取连接异常：${error instanceof Error ? error.message : String(error)}` +
        `；保留常驻进程，${Math.ceil(backoffMs / 1000)}s 后重试`,
      );
      await waitForNextPoll(backoffMs, cfg.signal);
      continue;
    }
    preclaimedTask = undefined;
    if (!claimRes.ok || !claimRes.data) {
      if (!claimRes.ok) {
        console.warn(`[worker:${cfg.agentId}] 领取失败：${(claimRes as any).error?.code ?? 'UNKNOWN'}，稍后重试`);
      }
      if (exitOnIdle) {
        console.log(`[worker:${cfg.agentId}] 无更多任务，退出（共完成 ${count} 个）`);
        break;
      }
      await waitForNextPoll(idlePollMs, cfg.signal);
      continue;
    }

    const task = claimRes.data;
    currentTask = task.task_id;
    await sendHeartbeat();
    console.log(`[worker:${cfg.agentId}] 领取任务：${task.task_id}（${task.title}）`);

    let renewTimer: NodeJS.Timeout | undefined;
    let stopRenewingOnAbort: (() => void) | undefined;
    let preserveRunningProjectionOnAbort = false;
    // catch 路径也需要在 failed report 成功后清理 claim，因此不能只在 try 作用域内声明。
    const workDir = join(task.project_path || process.cwd(), 'work', task.task_id);
    let progress: WorkerProgressTracker | undefined;
    try {
      // 任务的 project_path 作为工作根目录（claim 返回带这个字段）
      const projectPath = task.project_path || process.cwd();

      // `.progress.json` 只能由外层调度器写；claimed 必须早于 Agent 执行和任何最终产物。
      try {
        progress = createWorkerProgressTracker(workDir, task, cfg.agentId);
      } catch (error) {
        console.warn(`[worker-progress] claimed 写入失败：${(error as Error).message}`);
      }

      // crash recovery：本地持久化 claim 凭证（Redis 被清时可人工核对）
      writeClaimFile(workDir, task, cfg.agentId);

      // plan MD 违规检测：execute 前对 plans/ 目录做快照（MD 职责分离，worker 不应改 plan MD）
      const planMdBefore = snapshotPlanMd(projectPath);

      // 执行前查占用（对所有 ownership_files，逐个检查冲突）
      let conflictAborted = false;
      for (const glob of task.ownership_files ?? []) {
        const canProceed = await resolveOwnershipConflict(
          client,
          glob,
          task,
          cfg.agentId,
          30_000,
          10 * 60_000,
          cfg.ownershipConflictMode ?? 'wait',
        );
        if (!canProceed) {
          if (cfg.ownershipConflictMode === 'block') clearClaimFile(workDir, task);
          conflictAborted = true;
          break; // 某个 glob 超时放弃，跳过整个任务
        }
      }
      if (conflictAborted) {
        advanceWorkerProgress(progress, 'blocked', {
          failureReason: 'waiting_file_release',
        });
        count++;
        continue; // 旧 claim/ownership 已释放；回到主循环领下一个任务
      }

      // crash recovery：执行前确认 lease 仍有效（Redis 被清 / lease 过期 → task 已回 pending）
      // 不要默默继续跑——stale claim 的工作成果无法 report，会浪费算力
      if (await isLeaseStale(client, task.task_id, cfg.agentId)) {
        console.error(
          `[worker:${cfg.agentId}] ⚠ task ${task.task_id} 的 lease 在 Redis 里已失效（可能 Redis 被清或 lease 过期）。` +
            `当前工作无法 report；保留产物并交给共享 Supervisor 回收状态，随后使用 fresh claim 继续，禁止绕过平台带外找人。` +
            `本地领取元数据（不含原始 token）保留在 ${workDir}/.claim.json`,
        );
        advanceWorkerProgress(progress, 'failed', { failureReason: 'lease_stale' });
        count++;
        continue; // 回到主循环：若任务已恢复为 pending，下一轮会带着新 token 重新 claim
      }

      advanceWorkerProgress(progress, 'running');

      // Worker 执行窗口的真实文件基线。它在 claim/ownership/lease 都确认后、Agent
      // 启动前建立，因此领取前已有的 dirty diff 不会自动算给当前 Worker。
      const projectFilesBefore = snapshotProjectFiles(projectPath);
      const ownershipAtExecutionStart = typeof client.listActiveOwnership === 'function'
        ? await client.listActiveOwnership()
          .then((response) => Array.isArray(response?.data?.ownership) ? response.data.ownership : [])
          .catch(() => [])
        : [];

      // lease 续租：execute 前启动定时器，每 timeout/3 秒续一次，避免长任务 lease 过期被回收
      const leaseTimeout = task.timeout_seconds ?? 1800;
      const renewIntervalMs = (leaseTimeout * 1000) / 3;
      const stopLeaseRenewal = () => {
        if (renewTimer) clearInterval(renewTimer);
        renewTimer = undefined;
      };
      renewTimer = setInterval(async () => {
        if (cfg.signal?.aborted) {
          stopLeaseRenewal();
          return;
        }
        try {
          const r = await client.renewLease(task.task_id, task.claim_token);
          if (!r.ok) {
            console.log(`[worker:${cfg.agentId}]   ⚠ 续租失败：${r.error?.code}`);
            const taskInfo = await client.getTask(task.task_id);
            if (taskInfo.data?.status === 'pending') {
              console.log(`[worker:${cfg.agentId}]   ⚠ task 已被回收回 pending（lease 过期）`);
              console.log(`[worker:${cfg.agentId}]      选项：(a) 重新 claim+继续 (b) 放弃（work 目录保留）`);
            }
          }
        } catch (e) {
          console.warn(`[worker:${cfg.agentId}]   ⚠ 续租异常：${(e as Error).message}`);
        }
      }, renewIntervalMs);
      stopRenewingOnAbort = stopLeaseRenewal;
      if (cfg.signal?.aborted) stopLeaseRenewal();
      else cfg.signal?.addEventListener('abort', stopLeaseRenewal, { once: true });

      // 执行
      const execution = await cfg.execute(task, projectPath, cfg.signal);
      const { run, changedFiles: reportedChangedFiles, backend, model } = execution;
      console.log(`[worker:${cfg.agentId}]   执行完成 exit=${run.exitCode}${run.timedOut ? '（超时）' : ''}`);

      const projectFilesAfter = projectFilesBefore ? snapshotProjectFiles(projectPath) : undefined;
      let projectFileChanges = projectFilesBefore && projectFilesAfter
        ? diffProjectFiles(projectFilesBefore, projectFilesAfter)
        : undefined;
      if (projectFileChanges) {
        // plans/*.md 允许 PM 在 Worker 运行期间并发维护。保留既有职责分离归因规则：
        // 只有 Agent 自报也指向同一 plan MD 时才归给 Worker；普通项目文件完全以
        // 内容快照为事实源，不再相信模型自报。
        const reportedPlans = new Set(
          reportedChangedFiles
            .map((path) => reportedPlanMdPath(projectPath, path))
            .filter((path): path is string => path !== undefined)
            .map((path) => `plans/${path}`),
        );
        projectFileChanges = projectFileChanges.filter((change) =>
          !change.path.startsWith('plans/') || !change.path.toLowerCase().endsWith('.md') || reportedPlans.has(change.path),
        );
        const normalizedReportedPaths = new Set(reportedChangedFiles.map((path) => {
          const absolute = isAbsolute(path) ? path : resolve(projectPath, path);
          return relative(resolve(projectPath), absolute).split('\\').join('/');
        }).filter((path) => path && path !== '..' && !path.startsWith('../')));
        projectFileChanges = await excludeChangesOwnedByOtherWorkers(
          client,
          cfg.agentId,
          projectFileChanges,
          normalizedReportedPaths,
          ownershipAtExecutionStart,
        );
      }
      const actualChangedFiles = projectFileChanges
        ? projectFileChanges.map((change) => change.path)
        : [...new Set(reportedChangedFiles)].sort();
      const ownershipBoundaryViolations = projectFileChanges
        ? ownershipViolations(task, projectFileChanges)
        : [];

      // 续租定时器已在 execute 前启动，这里清除（execute 完成，不再需要续租）
      clearInterval(renewTimer);
      if (run.aborted || cfg.signal?.aborted) {
        // 停止是 Worker/Supervisor 生命周期事件，不是业务交付。不写 result、不 verify/report、
        // 不清 claim/current_task；只有等真实 Agent 子进程 close 后才能走 finally/offline，
        // 使 lease 按原有语义过期并由 lazyReclaim 安全计数、续跑或进入 repair。
        preserveRunningProjectionOnAbort = true;
        console.log(`[worker:${cfg.agentId}]   已停止执行；保留 running/claim 审计，等待 lease 安全回收`);
        break;
      }
      const question = execution.question ?? extractQuestionMarker(run.stdout);
      if (question) {
        const asked = question.requestedOwnership
          ? await client.createQuestion(
              task.task_id,
              task.claim_token,
              question.body,
              question.checkpoint,
              question.requestedOwnership,
            )
          : await client.createQuestion(task.task_id, task.claim_token, question.body, question.checkpoint);
        if (!asked?.ok) {
          throw new Error(`Question 创建失败：${asked?.error?.code ?? 'UNKNOWN'} ${asked?.error?.message ?? ''}`.trim());
        }
        console.log(`[worker:${cfg.agentId}]   已通过平台提交 Question ${asked.data?.question_id ?? ''}，当前 slot 将继续领取其他任务`);
        advanceWorkerProgress(progress, 'blocked', { failureReason: 'waiting_pm_reply' });
        clearClaimFile(workDir, task);
        count++;
        continue;
      }
      // 运行 verify
      advanceWorkerProgress(progress, 'verifying');
      const verifyResults = runVerifyCommands(task.verify ?? [], projectPath);

      // 写 result
      const { resultMdPath, resultJsonPath } = writeResult(
        workDir, task, run, verifyResults, cfg.agentId, backend, model, actualChangedFiles,
      );

      if (ownershipBoundaryViolations.length > 0) {
        console.log(`[worker:${cfg.agentId}]   ⚠ 检测到未授权文件变更，禁止 done：`);
        for (const violation of ownershipBoundaryViolations) {
          console.log(`[worker:${cfg.agentId}]     ${violation.path} (${violation.changeType})`);
        }
        const artifactContext = registeredWorkerArtifactContext(workDir, task.task_id, task.project_path);
        const resultJson = JSON.parse(readWorkerArtifact(artifactContext, 'result.json'));
        resultJson.status = 'failed';
        resultJson.ownership_violations = ownershipBoundaryViolations;
        atomicWriteWorkerArtifact(artifactContext, 'result.json', JSON.stringify(resultJson, null, 2));
        const resultMd = readWorkerArtifact(artifactContext, 'result.md');
        atomicWriteWorkerArtifact(
          artifactContext,
          'result.md',
          `${resultMd}\n## Ownership 门禁失败\n${ownershipBoundaryViolations
            .map((violation) => `- ${violation.path} (${violation.changeType})`)
            .join('\n')}\n\n未获得 ownership_files 授权，平台禁止以 done 交付；需要 PM 显式扩权后由 fresh claim 修复。\n`,
        );
      }

      // plan MD 违规检测：快照证明文件实际变更，changedFiles 证明变更可归因给当前 Agent。
      // 不能把 PM/另一 Worker 的并发修改仅因为发生在 execute 时间窗内就判给当前 Agent。
      const planMdAfter = snapshotPlanMd(projectPath);
      const planMdViolations = attributablePlanMdViolations(
        projectPath, planMdBefore, planMdAfter, actualChangedFiles,
      );
      if (planMdViolations.length > 0) {
        console.log(`[worker:${cfg.agentId}]   ⚠ 检测到 worker 改动了 plan MD 文件（违反 MD 职责分离）：`);
        for (const v of planMdViolations) {
          console.log(`[worker:${cfg.agentId}]     ${v.path} (${v.changeType})`);
        }
        console.log(`[worker:${cfg.agentId}]   worker 不应直接改 plan MD，应通过 question 机制问 PM。违规已记录到 report。`);
        // 把 violations 写入 result.json（供 PM review 时看到）
        try {
          const artifactContext = registeredWorkerArtifactContext(workDir, task.task_id, task.project_path);
          const rj = JSON.parse(readWorkerArtifact(artifactContext, 'result.json'));
          rj.plan_md_violations = planMdViolations;
          atomicWriteWorkerArtifact(artifactContext, 'result.json', JSON.stringify(rj, null, 2));
        } catch {
          // result.json 读写失败不阻塞 report
        }
      }

      // 回写——verify 强制：任一 verify 命令 fail 则 status=failed（即使 execute exit=0）
      const verifyFailed = verifyResults.some((v) => !v.passed);
      let status: 'done' | 'failed';
      if (run.exitCode !== 0) {
        status = 'failed';
      } else if (ownershipBoundaryViolations.length > 0) {
        status = 'failed';
        console.log(`[worker:${cfg.agentId}]   ⚠ ownership 门禁未通过，强制 status=failed`);
      } else if (verifyFailed && (task.verify ?? []).length > 0) {
        status = 'failed'; // verify 有 fail 强制 failed（bpi-01）
        console.log(`[worker:${cfg.agentId}]   ⚠ verify 未全过，强制 status=failed`);
      } else {
        status = 'done';
      }
      advanceWorkerProgress(progress, 'reporting', {
        artifactsWritten: true,
        reportStatus: status,
        reportDelivery: 'pending',
      });
      const reportDelivery = await deliverReport(
        client,
        task,
        cfg.agentId,
        status,
        resultMdPath,
        resultJsonPath,
        verifyResults,
      );
      if (reportDelivery.state === 'reported') {
        advanceWorkerProgress(progress, status === 'done' ? 'finished' : 'failed', {
          artifactsWritten: true,
          reportStatus: status,
          reportDelivery: 'reported',
          failureReason: status === 'failed' ? 'execution_or_verification_failed' : undefined,
        });
        logReportLifecycle(cfg.agentId, task.task_id, status, reportDelivery.response);
        clearClaimFile(workDir, task); // report 成功，本地凭证使命完成
      } else if (reportDelivery.state === 'confirmed_after_uncertain_response') {
        advanceWorkerProgress(progress, status === 'done' ? 'finished' : 'failed', {
          artifactsWritten: true,
          reportStatus: status,
          reportDelivery: 'confirmed_after_uncertain_response',
          failureReason: status === 'failed' ? 'execution_or_verification_failed' : undefined,
        });
        console.warn(`[worker:${cfg.agentId}]   ⚠ report 响应中断，但平台已确认 task=${status}；不补报 failed。`);
        clearClaimFile(workDir, task);
      } else if (reportDelivery.state === 'unknown') {
        advanceWorkerProgress(progress, 'reporting', {
          artifactsWritten: true,
          reportStatus: status,
          reportDelivery: 'unknown',
          failureReason: 'report_delivery_unknown',
        });
        const message = reportDelivery.error instanceof Error ? reportDelivery.error.message : 'UNKNOWN';
        console.error(
          `[worker:${cfg.agentId}]   ⚠ report 送达状态未知（${message}）；保留本地 claim 与产出，` +
            '不补报 failed，等待平台恢复后按 task 状态核实。',
        );
      } else if (reportDelivery.response?.error?.code === 'CLAIM_TOKEN_INVALID') {
        advanceWorkerProgress(progress, 'failed', {
          artifactsWritten: true,
          reportStatus: status,
          reportDelivery: 'rejected',
          failureReason: 'claim_token_invalid',
        });
        // crash recovery：lease 已失效（Redis 被清 / 过期）→ 保留产出 + 根据 task 状态给引导
        let taskStatus = 'unknown';
        try {
          taskStatus = (await client.getTask(task.task_id)).data?.status ?? 'unknown';
        } catch {
          // 读取也失败时保持 unknown；此路径不得再落入外层 catch 报 failed。
        }
        console.error(
          `[worker:${cfg.agentId}]   ⚠ report 失败：claim token 无效。task 当前状态：${taskStatus}`,
        );
        console.error(
          `[worker:${cfg.agentId}]      ${workDir}/ 的产出与领取元数据已保留（result.md / result.json / .claim.json；不含原始 token）`,
        );
        console.error(`[worker:${cfg.agentId}]      选项：`);
        if (taskStatus === 'pending') {
          console.error(`[worker:${cfg.agentId}]      [a] task=pending → 重新 claim 拿新 token → report done（代码已就绪可直接复用）`);
        } else if (taskStatus === 'done' || taskStatus === 'failed') {
          console.error(`[worker:${cfg.agentId}]      [b] task=${taskStatus}（已被别人完成或失败）→ 无需再 report，退出`);
        } else {
          console.error(`[worker:${cfg.agentId}]      [c] task=${taskStatus}（lease 过期未回收）→ 交给共享 Supervisor 回收，再用 fresh claim 继续`);
        }
      } else {
        advanceWorkerProgress(progress, 'failed', {
          artifactsWritten: true,
          reportStatus: status,
          reportDelivery: 'rejected',
          failureReason: 'report_rejected',
        });
        console.error(`[worker:${cfg.agentId}]   ✗ report 被平台拒绝：`, reportDelivery.response?.error);
      }
      count++;
    } catch (e) {
      if (isWorkerArtifactPathDenied(e)) {
        // 本地 work/result 路径不可信不是任务执行失败。不得 report failed 或清空
        // current_task；让平台按原 lease/offline 语义安全回收，再由 fresh claim 重试。
        preserveRunningProjectionOnAbort = true;
        console.error(`[worker:${cfg.agentId}]   本地产物路径被拒绝：${(e as Error).message}`);
        throw e;
      }
      if (cfg.signal?.aborted) {
        // 自定义 execute 可能以 AbortError/其它异常表示子进程已关闭。
        // 显式停止仍然是生命周期事件，绝不得落入通用 failed report 路径。
        preserveRunningProjectionOnAbort = true;
        console.log(
          `[worker:${cfg.agentId}]   执行器已因停止信号关闭；保留 running/claim 审计，等待 lease 安全回收`,
        );
        break;
      }
      console.error(`[worker:${cfg.agentId}]   任务异常：`, e);
      if (renewTimer) clearInterval(renewTimer); // 异常路径也清续租定时器
      // 尝试 report failed；异常路径也必须把自动修复/PM 决策交接打印出来，
      // 否则 Worker 看起来像“失败后没有下一步”。
      const resultArtifactsWritten = existsSync(join(workDir, 'result.md')) && existsSync(join(workDir, 'result.json'));
      if (progress?.stage !== 'reporting') {
        advanceWorkerProgress(progress, 'reporting', {
          artifactsWritten: resultArtifactsWritten,
          reportStatus: 'failed',
          reportDelivery: 'pending',
        });
      }
      try {
        const failedReport = await client.report(task.task_id, task.claim_token, 'failed', undefined, undefined, []);
        if (failedReport?.ok) {
          advanceWorkerProgress(progress, 'failed', {
            artifactsWritten: resultArtifactsWritten,
            reportStatus: 'failed',
            reportDelivery: 'reported',
            failureReason: 'worker_exception',
          });
          logReportLifecycle(cfg.agentId, task.task_id, 'failed', failedReport);
          clearClaimFile(workDir, task);
        } else {
          advanceWorkerProgress(progress, 'failed', {
            artifactsWritten: resultArtifactsWritten,
            reportStatus: 'failed',
            reportDelivery: 'rejected',
            failureReason: 'worker_exception',
          });
          console.error(`[worker:${cfg.agentId}]   ✗ 异常后的 failed report 失败：${failedReport?.error?.code ?? 'UNKNOWN'}`);
        }
      } catch {
        advanceWorkerProgress(progress, 'failed', {
          artifactsWritten: resultArtifactsWritten,
          reportStatus: 'failed',
          reportDelivery: 'unknown',
          failureReason: 'worker_exception',
        });
        console.error(`[worker:${cfg.agentId}]   ✗ 异常后的 failed report 未送达；本地 claim 与产出保留，等待下一轮恢复。`);
      }
      count++;
    } finally {
      if (stopRenewingOnAbort) cfg.signal?.removeEventListener('abort', stopRenewingOnAbort);
      if (renewTimer) clearInterval(renewTimer);
      if (!preserveRunningProjectionOnAbort) {
        currentTask = undefined;
        await sendHeartbeat();
      }
      releaseWorkerArtifactContext(workDir, task.task_id, task.project_path);
    }
  }
  } finally {
    clearInterval(heartbeatTimer);
    if (ownsRegistration && typeof client.offline === 'function') {
      try {
        const offline = await client.offline(cfg.signal?.aborted ? 'worker_signal' : 'worker_exit');
        if (offline?.ok === false) {
          console.warn(`[worker:${cfg.agentId}] 离线登记失败：${offline.error?.code ?? 'UNKNOWN'}`);
        }
      } catch (error) {
        console.warn(`[worker:${cfg.agentId}] 离线登记异常：${(error as Error).message}`);
      }
    }
  }
  console.log(`[worker:${cfg.agentId}] 总计完成 ${count} 个任务`);
}

/** 可被 AbortSignal 提前打断的空队列等待，支持进程优雅退出。 */
async function waitForNextPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveWait();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
