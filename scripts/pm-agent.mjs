#!/usr/bin/env node
/**
 * 可选的 PM Agent 唤醒器。
 *
 * 这不是服务端推送，也不是 PM 自动化器：每次只主动读取一次 `/intake`，确认有
 * PM 事项才启动一次由用户显式配置的本地命令。它绝不会请求 review / question
 * answer / intake ack，也不会把任务详情、结果、正文或 token 交给子进程。
 *
 * 默认就是一次性模式，适合 cron / launchd。若多个触发器同时运行，同一台机器、
 * 同一 Biao 地址和 PM consumer 只会有一个实例取得本地锁；其余实例安静退出。
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_CONFIG = 3;
const EXIT_UNHANDLED = 4;
const LOCK_CONTENTION = Symbol('lock-contention');
const INTERNAL_LOCK_ARG = '--biao-internal-kernel-lock';
const INTERNAL_LOCK_ENV = 'BIAO_PM_AGENT_KERNEL_LOCK_NONCE';
const INTERNAL_LOCK_READ_FD = 3;
const INTERNAL_LOCK_ACK_FD = 4;
const INTERNAL_LOCK_FILE_FD = 5;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_BIAO_URL = 'http://127.0.0.1:7331';
const DEFAULT_CONSUMER = 'pm';
const DEFAULT_PM_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_PM_AGENT_TIMEOUT_MS = 100;
const MAX_PM_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
const PM_AGENT_KILL_GRACE_MS = 250;
const PM_ACTIONABLE_KINDS = new Set([
  'review_requested',
  'question_asked',
  'resolution_required',
  // 兼容未来服务把 resolution 状态直接投影为 kind 的版本。
  'needs_pm_decision',
  'failed',
  'blocked',
  // 服务端只会把仍持有 running task 的 stale agent 投影到 intake；普通 idle/stale
  // 注册已在服务端过滤，不能由唤醒器重新制造 PM 噪声。
  'stale_agent',
]);

function usage() {
  console.log(`Biao PM Agent 唤醒器（一次性、被动平台适配）

用法：
  node scripts/pm-agent.mjs [--once] [--require-drained] [--biao-url URL] [--consumer PM]
                            [--plans p1,p2] [--command 'agent command']

配置：
  BIAO_PM_AGENT_CMD='agent command'   # 有 PM 事项时唯一允许启动的命令
  BIAO_URL=http://127.0.0.1:7331
  BIAO_PM_CONSUMER=pm
  BIAO_API_TOKEN=...                  # 仅用于本脚本读取 intake，不会传给子进程
  BIAO_PM_AGENT_LOCK_DIR=/tmp/...     # 可选本机锁目录
  BIAO_PM_AGENT_TIMEOUT_MS=600000     # Agent 卡死后的回收时限；默认 10 分钟

行为：
  - 无事项：成功且静默，不启动任何 Agent。
  - 有事项：只向命令 stdin 传最小汇总 JSON；Agent 必须自行回平台读取详情，
    完成实际处理后才能自行 ack。
  - --require-drained：命令退出后再次读取 intake；仍有事项则返回退出码 4，供共享
    Supervisor 下轮重试。该检查不自动 review、answer 或 ack。
  - 本脚本从不自动 review、answer 或 ack。`);
}

function fail(message) {
  const error = new Error(message);
  error.exitCode = EXIT_CONFIG;
  throw error;
}

function readOptions(argv) {
  const values = new Map();
  const planValues = [];
  const valueFlags = new Set(['--biao-url', '--consumer', '--plans', '--plan', '--command', '--lock-dir', '--agent-timeout-ms']);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once' || arg === '--require-drained') continue;
    if (!valueFlags.has(arg)) fail(`未知参数：${arg}（使用 --help 查看用法）`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${arg} 需要一个值`);
    index++;
    if (arg === '--plans' || arg === '--plan') {
      planValues.push(value);
    } else if (values.has(arg)) {
      fail(`${arg} 只能指定一次`);
    } else {
      values.set(arg, value);
    }
  }

  const rawUrl = values.get('--biao-url') ?? process.env.BIAO_URL ?? DEFAULT_BIAO_URL;
  const biaoUrl = normalizeBiaoUrl(rawUrl);
  const consumer = (values.get('--consumer') ?? process.env.BIAO_PM_CONSUMER ?? DEFAULT_CONSUMER).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(consumer)) fail('consumer 名称非法（仅允许字母、数字、点、下划线和连字符）');

  const planIds = [...new Set(planValues
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
  const command = (values.get('--command') ?? process.env.BIAO_PM_AGENT_CMD ?? '').trim();
  const lockDir = (values.get('--lock-dir') ?? process.env.BIAO_PM_AGENT_LOCK_DIR ?? tmpdir()).trim();
  if (!lockDir) fail('锁目录不能为空');
  const rawTimeout = values.get('--agent-timeout-ms')
    ?? process.env.BIAO_PM_AGENT_TIMEOUT_MS
    ?? String(DEFAULT_PM_AGENT_TIMEOUT_MS);
  if (!/^\d+$/.test(rawTimeout)) fail('PM Agent timeout 必须是整数毫秒');
  const agentTimeoutMs = Number(rawTimeout);
  if (!Number.isSafeInteger(agentTimeoutMs)
    || agentTimeoutMs < MIN_PM_AGENT_TIMEOUT_MS
    || agentTimeoutMs > MAX_PM_AGENT_TIMEOUT_MS) {
    fail(`PM Agent timeout 必须在 ${MIN_PM_AGENT_TIMEOUT_MS}-${MAX_PM_AGENT_TIMEOUT_MS}ms 之间`);
  }

  return {
    biaoUrl,
    consumer,
    planIds,
    command,
    lockDir,
    agentTimeoutMs,
    requireDrained: argv.includes('--require-drained'),
  };
}

function normalizeBiaoUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('Biao URL 无法解析');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('Biao URL 只允许 http 或 https');
  // URL 中的凭据、查询和 hash 很容易把敏感信息带入子进程的最小唤醒 JSON，直接拒绝。
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('Biao URL 不得包含凭据、查询参数或 hash');
  return parsed.toString().replace(/\/$/, '');
}

function lockPath(biaoUrl, consumer, lockDir) {
  const key = createHash('sha256')
    .update(`${canonicalEndpoint(biaoUrl)}\u0000${consumer}`)
    .digest('hex')
    .slice(0, 24);
  return join(lockDir, `biao-pm-agent-${key}.lock`);
}

function canonicalEndpoint(biaoUrl) {
  const parsed = new URL(biaoUrl);
  let host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') host = '127.0.0.1';
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${host}:${port}`;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 先用 O_NOFOLLOW 打开稳定 inode，再把这个 FD 交给内核锁 helper。
 * helper 不再按路径二次打开，因此符号链接和检查后替换都不能改变锁目标。
 */
function openStableLockFile(biaoUrl, consumer, lockDir) {
  const requestedDir = resolve(lockDir);
  mkdirSync(requestedDir, { recursive: true, mode: 0o700 });
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(requestedDir);
  } catch (error) {
    fail(`无法检查锁目录：${error?.code ?? 'unknown'}`);
  }
  if (directoryMetadata.isSymbolicLink()) fail('锁目录不得是符号链接');
  if (!directoryMetadata.isDirectory()) fail('锁目录必须是目录');
  const path = lockPath(biaoUrl, consumer, realpathSync(requestedDir));
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === 'ELOOP') fail('锁文件不得是符号链接');
    fail(`无法安全打开锁文件：${error?.code ?? 'unknown'}`);
  }
  try {
    if (!fstatSync(fd).isFile()) fail('锁文件必须是普通文件');
    return { fd, path };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function kernelLockCommand(nonce) {
  const childArgs = [SCRIPT_PATH, INTERNAL_LOCK_ARG, nonce];
  if (process.platform === 'darwin') {
    const executable = '/usr/bin/lockf';
    if (!isExecutable(executable)) fail('macOS 缺少 /usr/bin/lockf，无法安全启动 PM Agent 本机锁');
    return {
      executable,
      args: ['-s', '-t', '0', '-k', `/dev/fd/${INTERNAL_LOCK_FILE_FD}`, process.execPath, ...childArgs],
      contentionCode: 75,
    };
  }
  if (process.platform === 'linux') {
    const executable = ['/usr/bin/flock', '/bin/flock'].find(isExecutable);
    if (!executable) fail('Linux 缺少 flock，无法安全启动 PM Agent 本机锁；请先安装 util-linux');
    return {
      executable,
      // flock 默认也用 1 表示冲突，会与 Node holder 自身的普通失败退出码混淆。
      // 固定成与 macOS lockf 一致的 75，才能把“已有同 consumer waker”与真实
      // holder 启动失败严格区分，避免 Supervisor 把后者静默当作已处理。
      args: ['-n', '-E', '75', String(INTERNAL_LOCK_FILE_FD), process.execPath, ...childArgs],
      contentionCode: 75,
    };
  }
  fail(`当前系统 ${process.platform} 没有受支持的内核锁适配器（仅支持 macOS lockf / Linux flock）`);
}

/**
 * holder 的唯一职责是在 helper 已持锁时确认 nonce，然后等待控制 pipe EOF。
 * 它永远不解析 Biao 业务参数，不读 intake，也不启动 PM child。
 */
function runKernelLockHolder(argv) {
  const index = argv.indexOf(INTERNAL_LOCK_ARG);
  const nonce = argv[index + 1];
  if (!nonce || !/^[0-9a-f-]{36}$/i.test(nonce)) fail('内部内核锁 holder 交接参数无效');

  let pipeNonce;
  try {
    pipeNonce = readFileSync(INTERNAL_LOCK_READ_FD, 'utf8').trim();
  } catch {
    fail('内部内核锁交接缺少受控输入');
  }
  if (process.env[INTERNAL_LOCK_ENV] !== nonce || pipeNonce !== nonce) {
    fail('内部内核锁 holder 交接验证失败');
  }
  try {
    writeFileSync(INTERNAL_LOCK_ACK_FD, `${nonce}\n`, 'utf8');
  } catch {
    fail('内部内核锁 holder 无法确认持锁进程');
  }
  // 父进程正常完成或崩溃都会关闭该 pipe；EOF 让 helper 进程退出并释放锁。
  try {
    readFileSync(0);
  } catch (error) {
    fail(`内部内核锁 holder 控制管道异常：${error?.code ?? 'unknown'}`);
  }
  return 0;
}

async function acquireKernelLock(options) {
  const nonce = randomUUID();
  const lock = kernelLockCommand(nonce);
  const lockFile = openStableLockFile(options.biaoUrl, options.consumer, options.lockDir);
  let child;
  try {
    child = spawn(lock.executable, lock.args, {
      shell: false,
      stdio: ['pipe', 'inherit', 'inherit', 'pipe', 'pipe', lockFile.fd],
      env: { ...process.env, [INTERNAL_LOCK_ENV]: nonce },
    });
  } finally {
    closeSync(lockFile.fd);
  }

  let acknowledgement = '';
  let acknowledged = false;
  let settleAcquisition;
  let rejectAcquisition;
  const acquisition = new Promise((resolvePromise, rejectPromise) => {
    settleAcquisition = resolvePromise;
    rejectAcquisition = rejectPromise;
  });
  const closed = new Promise((resolvePromise) => {
    child.once('close', (code, signal) => {
      const result = { code, signal };
      if (!acknowledged) {
        if (code === lock.contentionCode && !signal) settleAcquisition(LOCK_CONTENTION);
        else rejectAcquisition(new Error(
          `内核锁命令未启动 holder（退出码 ${code ?? 'unknown'}${signal ? `，信号 ${signal}` : ''}）`,
        ));
      }
      resolvePromise(result);
    });
  });
  child.once('error', (error) => {
    if (!acknowledged) rejectAcquisition(error);
  });
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', (chunk) => {
    acknowledgement += chunk;
    if (acknowledged || !acknowledgement.includes('\n')) return;
    if (acknowledgement.trim() !== nonce) {
      rejectAcquisition(new Error('内核锁 holder 返回了无效确认'));
      return;
    }
    acknowledged = true;
    settleAcquisition(undefined);
  });
  child.stdio[3].once('error', () => {
    // Linux flock 在无等待竞争时会先关闭交接 pipe，随后才以 contentionCode
    // close。不能让这一瞬态 ECONNRESET/EPIPE 抢先把“安静退出”误判成唤醒失败；
    // 未确认 holder 的其他启动错误由 close 分支给出确定结论。
  });
  child.stdin.once('error', () => {
    // release 时 holder 已退出可能产生 EPIPE，最终状态由 closed 结果判定。
  });
  child.stdio[3].end(`${nonce}\n`);

  const acquired = await acquisition;
  if (acquired === LOCK_CONTENTION) {
    if (process.env.BIAO_PM_AGENT_TRACE_LOCK === '1') {
      console.error(`[pm-agent] lock contention consumer=${options.consumer} path=${lockFile.path}`);
    }
    child.stdin.end();
    await closed;
    return undefined;
  }
  if (process.env.BIAO_PM_AGENT_TRACE_LOCK === '1') {
    console.error(`[pm-agent] lock acquired consumer=${options.consumer} path=${lockFile.path}`);
  }
  return {
    async release() {
      child.stdin.end();
      const result = await closed;
      if (result.signal || result.code !== 0) {
        throw new Error(`内核锁 holder 异常退出（退出码 ${result.code ?? 'unknown'}${result.signal ? `，信号 ${result.signal}` : ''}）`);
      }
    },
  };
}

async function readIntake({ biaoUrl, consumer }) {
  const headers = { Accept: 'application/json' };
  const apiToken = process.env.BIAO_API_TOKEN;
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  let response;
  try {
    response = await fetch(`${biaoUrl}/intake?consumer=${encodeURIComponent(consumer)}`, { headers });
  } catch {
    throw new Error('读取 Biao PM intake 失败：无法连接服务');
  }
  if (!response.ok) throw new Error(`读取 Biao PM intake 失败：HTTP_${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('读取 Biao PM intake 失败：响应不是 JSON');
  }
  if (payload?.ok === false || !payload || typeof payload !== 'object') {
    throw new Error('读取 Biao PM intake 失败：服务未返回可用数据');
  }
  const data = payload.data ?? payload;
  return Array.isArray(data?.items) ? data.items : [];
}

/** 只保留 kind / plan_id 两个最小定位字段；任何正文、结果和 token 都在这里丢弃。 */
function summarizeActionable(items, planIds) {
  const selectedPlans = planIds.length > 0 ? new Set(planIds) : undefined;
  const kinds = new Map();
  let count = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    // 历史 repair 排队不应唤醒 PM；只有真正要求 PM 决策的 resolution 才会出现在 intake。
    if (!PM_ACTIONABLE_KINDS.has(kind) || (kind === 'resolution_required' && item.resolution_action === 'repair')) continue;
    const planId = typeof item.plan_id === 'string' ? item.plan_id : '';
    // 服务端仍可接收 plan_id 过滤；这里故意不传，确保多 plan 情形只有一次低成本读取，
    // 并在客户端做精确且可预测的范围过滤。
    if (selectedPlans && !selectedPlans.has(planId)) continue;
    count++;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  return {
    count,
    kinds: Object.fromEntries([...kinds.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function childEnvironment() {
  // 默认不继承父进程的凭据。PM Agent 应使用自己的本地凭据/配置，在收到门铃后自行
  // 回平台读取详情；这也保证 BIAO_API_TOKEN 不会跨进程泄露。
  const safeKeys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  ];
  const env = {};
  for (const key of safeKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 这些都是 bootstrap 生成的非凭据定位信息。内置 adapter 必须知道外置 runtime
  // 和受控 workspace；尤其 npm 安装布局中 packageRoot 内不会存在 `.biao`。
  for (const key of ['BIAO_RUNTIME_DIR', 'BIAO_PREFERRED_PROJECT', 'BIAO_WORKSPACE_ROOTS', 'BIAO_PM_TARGET']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.BIAO_PM_AGENT_WAKE = '1';
  env.BIAO_PM_AGENT_FETCH_DETAILS = 'required';
  env.BIAO_PM_AGENT_ACK = 'only_after_actual_handling';
  env.BIAO_PM_AGENT_AUTOMATION = 'forbidden';
  env.BIAO_PM_AGENT_INSTRUCTIONS = 'Read details from Biao yourself; process only the scoped PM items; only ack after actual handling; never auto-review, auto-answer, or auto-ack because of this wake.';
  return env;
}

function terminateAgentProcessGroup(child, signal) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    return;
  }
  child.kill(signal);
}

async function invokeAgent(command, payload, timeoutMs) {
  await new Promise((resolve, reject) => {
    // bootstrap 写入的是一个绝对 adapter 路径。若该完整字符串确实是文件，直接
    // exec，避免路径中的空格或 shell 元字符被拆分；只有显式的“命令 + 参数”字符串
    // 才保留 shell 兼容。来自 Biao 的字段从不进入命令行。
    let directExecutable;
    if (isAbsolute(command)) {
      try {
        if (statSync(command).isFile()) directExecutable = command;
      } catch {
        // 不是完整文件路径时按用户显式命令字符串处理，并由 shell 返回可诊断错误。
      }
    }
    const child = spawn(directExecutable ?? command, [], {
      shell: directExecutable === undefined,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: childEnvironment(),
      // 独立进程组使超时回收覆盖 adapter 启动的 codex/kimi 等后代；只杀外层
      // shell 会留下孤儿进程并永久占住真实 Agent 会话。
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let terminating = false;
    let closedDuringTermination = false;
    let killTimer;
    const signalHandlers = new Map();
    const removeSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      signalHandlers.clear();
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      removeSignalHandlers();
      callback(value);
    };
    const beginTermination = (message) => {
      if (settled || terminating) return;
      terminating = true;
      try {
        terminateAgentProcessGroup(child, 'SIGTERM');
      } catch (error) {
        settle(reject, error);
        return;
      }
      killTimer = setTimeout(() => {
        try {
          // 即使外层 adapter 已因 SIGTERM 退出，也要再次杀整个进程组；其后代可能
          // 忽略了 TERM，并且此时仍会让 Supervisor 误以为没有可重试空间。
          terminateAgentProcessGroup(child, 'SIGKILL');
        } catch (error) {
          settle(reject, error);
          return;
        }
        const suffix = closedDuringTermination ? '，已回收进程组' : '，已强制终止进程组';
        settle(reject, new Error(`${message}${suffix}；门铃保留供 Supervisor 下轮重试`));
      }, PM_AGENT_KILL_GRACE_MS);
    };
    child.once('error', (error) => settle(reject, error));
    child.once('close', (code, signal) => {
      if (terminating) {
        closedDuringTermination = true;
        return;
      }
      if (code === 0) settle(resolve);
      else settle(reject, new Error(signal
        ? `PM Agent 命令被信号 ${signal} 终止`
        : `PM Agent 命令退出码为 ${code ?? 'unknown'}`));
    });
    child.stdin.once('error', (error) => {
      // 命令可以在读取 stdin 前正常退出（例如健康检查用 /usr/bin/true）。此时
      // EPIPE 只是输入管道的竞态，最终成功与否应由 close 的退出码决定。
      if (error?.code !== 'EPIPE') settle(reject, error);
    });
    const timeout = setTimeout(() => {
      beginTermination(`PM Agent 命令超过 ${timeoutMs}ms 未退出`);
    }, timeoutMs);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => beginTermination(`PM Agent 唤醒器收到 ${signal}`);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    // 唯一跨进程数据：允许的五个字段；绝不含 task/event/result/body/token。
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function runLocked(options) {
  const items = await readIntake(options);
  const initialSummary = summarizeActionable(items, options.planIds);
  if (initialSummary.count === 0) return 0;
  if (!options.command) {
    console.error('发现 PM 待处理事项，但未配置 PM Agent 命令；请设置 BIAO_PM_AGENT_CMD 或传入 --command。');
    return EXIT_CONFIG;
  }

  // 首次扫描只负责发现候选门铃。真正启动模型前再读一次当前事实，收窄“另一 PM
  // 已处理，但本进程仍按旧快照唤醒”的竞态窗口。二次结果为空时必须继续静默退出。
  const summary = summarizeActionable(await readIntake(options), options.planIds);
  if (summary.count === 0) return 0;

  const wakePayload = {
    biaoUrl: options.biaoUrl,
    consumer: options.consumer,
    planIds: options.planIds,
    kinds: summary.kinds,
    count: summary.count,
  };
  await invokeAgent(options.command, wakePayload, options.agentTimeoutMs);
  if (options.requireDrained) {
    const remaining = summarizeActionable(await readIntake(options), options.planIds);
    if (remaining.count > 0) {
      console.error(`[pm-agent] PM Agent 已退出，但仍未处理 ${remaining.count} 个待办；共享 Supervisor 将在下轮重试。`);
      return EXIT_UNHANDLED;
    }
  }
  console.log(`[pm-agent] 已唤醒 PM Agent：kinds=${Object.keys(summary.kinds).join(',')} count=${summary.count}（详情须由 Agent 回平台读取）`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  // 内部参数只能进入“纯 holder”路径，这个路径不存在任何业务调用。
  // 即使外部调用者可伪造所有 argv/env/FD，也无法由此绕过锁执行 intake。
  if (argv.includes(INTERNAL_LOCK_ARG)) return runKernelLockHolder(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const options = readOptions(argv);
  const lease = await acquireKernelLock(options);
  if (!lease) return 0;
  try {
    return await runLocked(options);
  } finally {
    await lease.release();
  }
}

main()
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((error) => {
    console.error(`[pm-agent] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
