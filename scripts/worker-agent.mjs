#!/usr/bin/env node
/**
 * Biao 按需 Worker Agent 唤醒器。
 *
 * Supervisor 只在发现与 slot selector 匹配的可领取工作、且该 slot 没有本机
 * Worker 子进程时调用本脚本。子命令收到的只是无凭据门铃；它必须通过本机已授权
 * 的 runtime/包装脚本自行注册并领取工作。这里不传 task、goal、claim token 或平台
 * Bearer token，也不代替 Worker 做 claim/report。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_WAKE_PROTOCOL = 'biao.worker-wake/v1';
export const EXIT_CONFIG = 3;
export const EXIT_RETRY = 4;

const DEFAULT_BIAO_URL = 'http://127.0.0.1:7331';
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
];

export function usage() {
  return `Biao 按需 Worker Agent 唤醒器（一次性）

用法：
  node scripts/worker-agent.mjs --once --slot <slot-id> --kind <worker-kind>
    [--model <model>] [--plan <plan-id> ... | --plans p1,p2]
    --command <本地可执行文件绝对路径> [--biao-url URL]
    [--runtime-dir <.biao 绝对路径>] [--lock-dir <本机锁目录>]

陌生 Agent 子命令契约：
  - stdin 只收到一行 ${WORKER_WAKE_PROTOCOL} JSON：
    { protocol, biaoUrl, slotId, selector: { kind, model, planIds } }
  - 门铃不包含任务详情或凭据；子命令必须通过本机授权的 Biao CLI 自行领取。
  - BIAO_RUNTIME_DIR（如配置）只用于定位本机 CLI；不会转交其他 BIAO_* 环境变量。
  - 子命令返回 0 表示本轮正常；非零表示 Supervisor 应在下一轮重试。
  - --command 是单个可执行文件。需要参数时请使用本地包装脚本，路径可以包含空格。

环境变量等价项：
  BIAO_WORKER_AGENT_CMD, BIAO_WORKER_SLOT, BIAO_WORKER_KIND,
  BIAO_WORKER_MODEL, BIAO_WORKER_PLANS, BIAO_RUNTIME_DIR,
  BIAO_WORKER_AGENT_LOCK_DIR, BIAO_URL`;
}

function configError(message) {
  const error = new Error(message);
  error.exitCode = EXIT_CONFIG;
  return error;
}

function optionValues(argv) {
  const single = new Map();
  const planValues = [];
  const valueFlags = new Set([
    '--biao-url',
    '--slot',
    '--kind',
    '--model',
    '--plan',
    '--plans',
    '--command',
    '--runtime-dir',
    '--lock-dir',
  ]);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') continue;
    if (!valueFlags.has(arg)) throw configError(`未知参数：${arg}（使用 --help 查看用法）`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw configError(`${arg} 需要一个值`);
    index++;
    if (arg === '--plan' || arg === '--plans') {
      planValues.push(value);
      continue;
    }
    if (single.has(arg)) throw configError(`${arg} 只能指定一次`);
    single.set(arg, value);
  }

  return { single, planValues };
}

function validateSelector(value, label, { optional = false } = {}) {
  if (optional && !value) return '';
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9._:@/+?-]+$/.test(trimmed)) {
    throw configError(`${label} 非法`);
  }
  return trimmed;
}

export function normalizeBiaoUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw configError('Biao URL 无法解析');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw configError('Biao URL 只允许 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configError('Biao URL 不得包含凭据、查询参数或 hash');
  }
  return parsed.toString().replace(/\/$/, '');
}

function resolveExecutable(requestedPath) {
  if (!isAbsolute(requestedPath)) throw configError('--command 必须是绝对路径');
  let metadata;
  try {
    metadata = lstatSync(requestedPath);
  } catch (error) {
    throw configError(`无法检查 --command：${error?.code ?? 'unknown'}`);
  }
  if (metadata.isSymbolicLink()) throw configError('--command 不能是符号链接');
  if (!metadata.isFile()) throw configError('--command 必须是普通文件');
  try {
    accessSync(requestedPath, constants.X_OK);
  } catch {
    throw configError('--command 必须可执行');
  }
  return realpathSync(requestedPath);
}

function resolveRuntimeDir(requestedPath) {
  if (!requestedPath) return '';
  if (!isAbsolute(requestedPath)) throw configError('--runtime-dir 必须是绝对路径');
  let path;
  try {
    path = realpathSync(requestedPath);
  } catch (error) {
    throw configError(`无法检查 --runtime-dir：${error?.code ?? 'unknown'}`);
  }
  if (!statSync(path).isDirectory()) throw configError('--runtime-dir 必须是目录');
  return path;
}

export function readOptions(argv, env = process.env) {
  const { single, planValues } = optionValues(argv);
  const biaoUrl = normalizeBiaoUrl(single.get('--biao-url') ?? env.BIAO_URL ?? DEFAULT_BIAO_URL);
  const slotId = validateSelector(single.get('--slot') ?? env.BIAO_WORKER_SLOT, 'slotId');
  const kind = validateSelector(single.get('--kind') ?? env.BIAO_WORKER_KIND, 'kind');
  const model = validateSelector(single.get('--model') ?? env.BIAO_WORKER_MODEL, 'model', { optional: true });
  const rawPlans = planValues.length > 0 ? planValues : [env.BIAO_WORKER_PLANS ?? ''];
  const planIds = [...new Set(rawPlans
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => validateSelector(value, 'planId')))];
  const requestedCommand = (single.get('--command') ?? env.BIAO_WORKER_AGENT_CMD ?? '').trim();
  if (!requestedCommand) throw configError('--command 不能为空');
  const command = resolveExecutable(requestedCommand);
  const runtimeDir = resolveRuntimeDir(single.get('--runtime-dir') ?? env.BIAO_RUNTIME_DIR ?? '');
  const lockDir = (single.get('--lock-dir') ?? env.BIAO_WORKER_AGENT_LOCK_DIR ?? tmpdir()).trim();
  if (!lockDir) throw configError('--lock-dir 不能为空');

  return { biaoUrl, slotId, kind, model, planIds, command, runtimeDir, lockDir };
}

export function buildWakePayload(options) {
  return {
    protocol: WORKER_WAKE_PROTOCOL,
    biaoUrl: options.biaoUrl,
    slotId: options.slotId,
    selector: {
      kind: options.kind,
      model: options.model,
      planIds: options.planIds,
    },
  };
}

function canonicalEndpoint(biaoUrl) {
  const parsed = new URL(biaoUrl);
  let host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') host = '127.0.0.1';
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${host}:${port}`;
}

function openStableLock(options) {
  const requestedDir = resolve(options.lockDir);
  mkdirSync(requestedDir, { recursive: true, mode: 0o700 });
  let directoryMetadata;
  try {
    directoryMetadata = lstatSync(requestedDir);
  } catch (error) {
    throw configError(`无法检查锁目录：${error?.code ?? 'unknown'}`);
  }
  if (directoryMetadata.isSymbolicLink()) throw configError('锁目录不能是符号链接');
  if (!directoryMetadata.isDirectory()) throw configError('锁目录必须是目录');
  const canonicalDir = realpathSync(requestedDir);
  const key = createHash('sha256')
    .update(`${canonicalEndpoint(options.biaoUrl)}\u0000${options.slotId}`)
    .digest('hex')
    .slice(0, 24);
  const path = join(canonicalDir, `biao-worker-agent-${key}.lock`);
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error?.code === 'ELOOP') throw configError('锁文件不能是符号链接');
    throw configError(`无法安全打开锁文件：${error?.code ?? 'unknown'}`);
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw configError('锁文件必须是普通文件');
  }
  return fd;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function lockCommand() {
  if (process.platform === 'darwin') {
    if (!isExecutable('/usr/bin/lockf')) throw configError('macOS 缺少 /usr/bin/lockf');
    return {
      executable: '/usr/bin/lockf',
      args: ['-s', '-t', '0', '-k', '/dev/fd/3'],
    };
  }
  if (process.platform === 'linux') {
    const executable = ['/usr/bin/flock', '/bin/flock'].find(isExecutable);
    if (!executable) throw configError('Linux 缺少 flock（util-linux）');
    return { executable, args: ['-n', '3'] };
  }
  throw configError(`当前系统 ${process.platform} 不支持安全 Worker slot 锁`);
}

export function childEnvironment(options, env = process.env) {
  const childEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  if (options.runtimeDir) childEnv.BIAO_RUNTIME_DIR = options.runtimeDir;
  return childEnv;
}

export async function runWorkerAgent(options) {
  const lockFd = openStableLock(options);
  const locker = lockCommand();
  const payload = `${JSON.stringify(buildWakePayload(options))}\n`;
  let child;
  try {
    child = spawn(locker.executable, [...locker.args, options.command], {
      env: childEnvironment(options),
      stdio: ['pipe', 'inherit', 'inherit', lockFd],
    });
  } catch (error) {
    closeSync(lockFd);
    throw error;
  }
  closeSync(lockFd);
  child.stdin.end(payload);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ error: null, code, signal }));
  });
  if (result.error) {
    console.error(`[biao-worker-agent] Worker 命令无法启动：${result.error.message}`);
    return EXIT_RETRY;
  }
  if (result.code !== 0) {
    console.error(`[biao-worker-agent] Worker 命令退出码 ${result.code ?? 'unknown'}${result.signal ? `（${result.signal}）` : ''}，等待 Supervisor 重试`);
    return EXIT_RETRY;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 0 || argv.some((arg) => ['--help', '-h', 'help'].includes(arg))) {
    console.log(usage());
    return 0;
  }
  try {
    return await runWorkerAgent(readOptions(argv, env));
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : EXIT_RETRY;
    console.error(`[biao-worker-agent] ${error instanceof Error ? error.message : String(error)}`);
    return exitCode;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
