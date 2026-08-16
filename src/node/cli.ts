/**
 * biao-node CLI（Phase 3 · §10.2 安装与启动）
 *
 * 子命令：
 * - enroll：登记向导。输入 enrollment ticket（只接受文件/标准输入/交互式
 *   输入，§10.2 禁止 token 进 argv/Shell 历史/日志）→ 调 /v2/nodes/enroll
 *   → 把 Node credential 写 0600 文件 → 生成初始 biao-node.config.json；
 * - run：daemon 主循环（register → 心跳 → drain/offline）；
 * - status：读取 status.json 展示节点/租约/心跳/时钟状态与存活判定；
 * - drain：向运行中的 daemon 投递控制文件触发优雅排空（跨平台，不依赖
 *   信号；Windows Service 停止脚本同样走这条路）。
 *
 * 退出码：0 正常收口；2 用法/配置/凭据错误；3 session 被 fencing；
 * 4 协议不兼容（fail-closed 拒绝注册）；124 drain 等待超时（仍在排空）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  BIAO_NODE_OWNER_TOKEN_ENV,
  generateNodeId,
  loadNodeConfig,
  validateNodeId,
  writeInitialConfig,
} from './config.js';
import { writeNodeCredential } from './credentials-store.js';
import { NodeApiClient } from './transport.js';
import { DaemonAuthError, NodeDaemon, ProtocolRefusalError } from './daemon.js';

const USAGE = `biao-node — Biao 分布式节点守护进程（Phase 3 骨架）

用法：
  biao-node enroll --url <biao_url> [--node-id <id>] [--ticket-file <path> | --ticket-stdin]
                   [--config <path>] [--slots N] [--cache-root <dir>] [--state-root <dir>]
                   [--project <project_id>]...
  biao-node run    [--config <path>]
  biao-node status [--config <path>] [--json]
  biao-node drain  [--config <path>] [--timeout-ms N] [--action cancel|wait] [--wait-ms N]

环境变量：
  ${BIAO_NODE_OWNER_TOKEN_ENV}          过渡期 owner 引导 token（enroll/首注册鉴权；不落盘、不进 argv）
  BIAO_NODE_INJECTED_CLOCK_OFFSET_MS  故障注入钩子（仅测试，生产不得设置）

详见 docs/runbooks/biao-node.md。`;

interface ParsedArgs {
  command: string | null;
  flags: Map<string, string>;
  repeated: Map<string, string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const [command = null, ...rest] = argv;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const value = eq === -1 ? rest[i + 1] : token.slice(eq + 1);
    if (eq === -1 && (value === undefined || value.startsWith('--'))) {
      flags.set(key, 'true');
      continue;
    }
    if (eq === -1) i += 1;
    if (key === 'project') {
      repeated.set('project', [...(repeated.get('project') ?? []), value]);
    } else {
      flags.set(key, value);
    }
  }
  return { command, flags, repeated };
}

function fatal(message: string, code = 2): never {
  console.error(`[biao-node] 错误：${message}`);
  process.exit(code);
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value || value === 'true') fatal(`缺少必填参数 --${name}\n\n${USAGE}`);
  return value;
}

/** 读取 enrollment ticket：文件 → stdin → 交互式（§10.2：不进 argv）。 */
async function readEnrollmentTicket(flags: Map<string, string>): Promise<string> {
  if (flags.has('ticket')) {
    fatal('enrollment ticket 不允许通过 --ticket <值> 传入（会进入 Shell 历史与进程列表）。请改用 --ticket-file <路径> 或 --ticket-stdin，或在交互提示中输入。');
  }
  const ticketFile = flags.get('ticket-file');
  if (ticketFile && ticketFile !== 'true') {
    let content: string;
    try {
      content = readFileSync(ticketFile, 'utf8');
    } catch (error) {
      fatal(`无法读取 enrollment ticket 文件 ${ticketFile}：${error instanceof Error ? error.message : String(error)}`);
    }
    const ticket = content.trim();
    if (!ticket) fatal(`enrollment ticket 文件为空：${ticketFile}`);
    return ticket;
  }
  if (flags.get('ticket-stdin') === 'true') {
    const content = await new Promise<string>((resolvePromise) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolvePromise(data));
      process.stdin.on('error', () => resolvePromise(''));
    });
    const ticket = content.trim();
    if (!ticket) fatal('标准输入中没有读到 enrollment ticket');
    return ticket;
  }
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ticket = (await rl.question('请输入一次性 enrollment ticket：')).trim();
    rl.close();
    if (!ticket) fatal('未输入 enrollment ticket');
    return ticket;
  }
  fatal(`缺少 enrollment ticket：请提供 --ticket-file <路径>、--ticket-stdin，或在交互终端运行。\n\n${USAGE}`);
}

async function cmdEnroll(flags: Map<string, string>, repeated: Map<string, string[]>): Promise<number> {
  const biaoUrl = requireFlag(flags, 'url').replace(/\/+$/, '');
  const nodeId = flags.has('node-id') ? validateNodeId(requireFlag(flags, 'node-id')) : generateNodeId();
  const configPath = resolve(flags.get('config') ?? './biao-node.config.json');
  const slots = Number(flags.get('slots') ?? 2);
  if (!Number.isInteger(slots) || slots < 1 || slots > 256) fatal('--slots 需要 1~256 的整数');
  const ticket = await readEnrollmentTicket(flags);
  const ownerToken = process.env[BIAO_NODE_OWNER_TOKEN_ENV];

  const client = new NodeApiClient({ baseUrl: biaoUrl, ownerToken });
  const res = await client.enroll({ enrollment_ticket: ticket, node_id: nodeId });
  if (!res.ok) {
    if (res.failure === 'UNAUTHORIZED') {
      fatal(
        `enroll 被拒绝（${res.error?.code}）：当前服务端鉴权需要 owner 引导。请设置 env ${BIAO_NODE_OWNER_TOKEN_ENV} 后重试（token 不进 argv/日志）。`,
      );
    }
    fatal(`enroll 失败（${res.error?.code ?? res.status}）：${res.error?.message ?? ''}`);
  }
  const { node_credential, credential_generation } = res.data!;

  // 凭据先落盘（0600、原子写），再写配置——失败时不会留下“有配置没凭据”的半态。
  const credentialFile = flags.get('credential-file')
    ? resolve(flags.get('credential-file')!)
    : resolve(dirname(configPath), 'node-credential.json');
  writeNodeCredential(credentialFile, {
    node_id: nodeId,
    credential: node_credential,
    credential_generation,
    biao_url: biaoUrl,
    enrolled_at: Date.now(),
  });

  const projects = repeated.get('project') ?? [];
  if (existsSync(configPath)) {
    console.log(`[biao-node] 配置已存在，跳过生成（凭据已更新）：${configPath}`);
  } else {
    writeInitialConfig({
      configPath,
      biaoUrl,
      nodeId,
      slots,
      cacheRoot: flags.get('cache-root') ? resolve(flags.get('cache-root')!) : undefined,
      stateRoot: flags.get('state-root') ? resolve(flags.get('state-root')!) : undefined,
      credentialFile,
      requestedProjectIds: projects,
    });
  }

  console.log('[biao-node] enroll 完成：');
  console.log(`  node_id              = ${nodeId}`);
  console.log(`  credential_generation = ${credential_generation}`);
  console.log(`  凭据文件（0600）      = ${credentialFile}`);
  console.log(`  配置文件              = ${configPath}`);
  console.log(`  控制面                = ${biaoUrl}`);
  console.log('后续步骤：');
  console.log('  1. 启动：biao-node run --config <配置路径>');
  console.log('  2. 服务化（launchd/systemd/Windows Service）：docs/runbooks/biao-node.md');
  console.log('  3. enrollment ticket 为一次性凭据，登记后应立即在服务端失效（当前服务端未校验，见缺口清单）。');
  return 0;
}

async function cmdRun(flags: Map<string, string>): Promise<number> {
  const configPath = resolve(flags.get('config') ?? './biao-node.config.json');
  const daemon = NodeDaemon.fromConfigFile(configPath, { installSignalHandlers: true });
  console.log(`[biao-node] 启动：node_id=${daemon.config.node_id} 控制面=${daemon.config.biao_url} boot_id=${daemon.getBootId()}`);
  const code = await daemon.run();
  console.log(`[biao-node] 退出：phase=${daemon.getStatus().phase} exit=${code}`);
  return code;
}

interface StatusFile {
  node_id?: string;
  phase?: string;
  pid?: number;
  boot_id?: string;
  updated_at_wall?: number;
  heartbeat?: { sent?: number; last_ok?: boolean; last_at?: number | null; last_body?: Record<string, unknown> | null };
  slots?: { capacity?: number; in_use?: number; attempts?: Array<{ attempt_id: string; status: string }> };
  clock?: { clock_skew_ms?: number; state?: string };
  drain?: { requested?: boolean; reason?: string | null; action?: string | null };
}

function readStatusFile(path: string): StatusFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StatusFile;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStatus(flags: Map<string, string>): Promise<number> {
  const configPath = resolve(flags.get('config') ?? './biao-node.config.json');
  const config = loadNodeConfig(configPath);
  const status = readStatusFile(config.status_file);
  if (!status) {
    console.log(`[biao-node] 未运行（找不到状态文件 ${config.status_file}）。启动：biao-node run --config ${configPath}`);
    return 1;
  }
  const alive = isProcessAlive(status.pid);
  if (flags.get('json') === 'true') {
    console.log(JSON.stringify({ ...status, process_alive: alive }, null, 2));
    return alive || status.phase === 'drained' ? 0 : 1;
  }
  const ageSec = status.updated_at_wall ? Math.round((Date.now() - status.updated_at_wall) / 1000) : null;
  console.log(`node_id        ${status.node_id ?? '?'}`);
  console.log(`phase          ${status.phase ?? '?'}${alive ? '' : '（进程不在运行）'}`);
  console.log(`boot_id        ${status.boot_id ?? '?'}`);
  console.log(`pid            ${status.pid ?? '?'}`);
  console.log(`状态更新       ${ageSec === null ? '?' : `${ageSec}s 前`}`);
  console.log(`心跳           已发 ${status.heartbeat?.sent ?? 0} 次，最近 ${status.heartbeat?.last_ok ? '成功' : '失败/未发'}`);
  console.log(`clock_skew_ms  ${status.clock?.clock_skew_ms ?? '?'}（${status.clock?.state ?? '?'}）`);
  console.log(`slots          ${status.slots?.in_use ?? 0}/${status.slots?.capacity ?? '?'} 在用`);
  for (const attempt of status.slots?.attempts ?? []) {
    console.log(`  attempt ${attempt.attempt_id} → ${attempt.status}`);
  }
  if (status.drain?.requested) console.log(`drain          进行中（action=${status.drain.action}，原因=${status.drain.reason}）`);
  return 0;
}

async function cmdDrain(flags: Map<string, string>): Promise<number> {
  const configPath = resolve(flags.get('config') ?? './biao-node.config.json');
  const config = loadNodeConfig(configPath);
  const status = readStatusFile(config.status_file);
  if (!status || !isProcessAlive(status.pid)) {
    console.error('[biao-node] daemon 未在运行，无需 drain。');
    return 1;
  }
  const timeoutMs = Number(flags.get('timeout-ms') ?? config.drain_timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) fatal('--timeout-ms 需要 ≥0 的整数');
  const action = flags.get('action') === 'wait' ? 'wait' : flags.get('action') === 'cancel' ? 'cancel' : config.drain_timeout_action;
  const waitMs = Number(flags.get('wait-ms') ?? 30_000);
  if (!Number.isFinite(waitMs) || waitMs < 0) fatal('--wait-ms 需要 ≥0 的整数（0 表示只投递不等待）');

  // 控制文件投递（原子 rename）：daemon 主循环 pollControlDir 消费。
  const controlFile = join(config.state_control_dir, 'drain.json');
  mkdirSync(config.state_control_dir, { recursive: true, mode: 0o700 });
  const tmp = `${controlFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({
    requested_at: Date.now(),
    reason: 'biao-node drain CLI',
    timeout_ms: timeoutMs,
    action,
  })}\n`, 'utf8');
  renameSync(tmp, controlFile);
  console.log(`[biao-node] 已投递 drain 请求（timeout=${timeoutMs}ms action=${action}），等待收口…`);

  if (waitMs <= 0) return 0;
  const deadline = Date.now() + waitMs;
  for (;;) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    const current = readStatusFile(config.status_file);
    if (!current) continue;
    if (current.phase === 'drained') {
      console.log(`[biao-node] drain 完成（offline ${current.drain && 'offline_pending' in current.drain && current.drain.offline_pending ? '未确认' : '已确认'}）。`);
      return 0;
    }
    if (current.phase === 'fenced') {
      console.error('[biao-node] daemon 已被 fencing，请检查服务端节点状态。');
      return 3;
    }
    if (!isProcessAlive(current.pid)) {
      console.error(`[biao-node] daemon 进程在 drain 过程中退出（phase=${current.phase}）。`);
      return 1;
    }
    if (Date.now() >= deadline) {
      console.error(`[biao-node] 等待 drain 超时（${waitMs}ms），当前 phase=${current.phase}。daemon 仍在排空，可加 --wait-ms 继续等待。`);
      return 124;
    }
  }
}

// 控制文件投递见 cmdDrain；join 已在顶部引入。

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags, repeated } = parseArgs(argv);
  if (!command || command === 'help' || flags.get('help') === 'true') {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if (command === 'version') {
    console.log('biao-node 0.1.0 (phase3-skeleton)');
    return 0;
  }
  try {
    if (command === 'enroll') return await cmdEnroll(flags, repeated);
    if (command === 'run') return await cmdRun(flags);
    if (command === 'status') return await cmdStatus(flags);
    if (command === 'drain') return await cmdDrain(flags);
  } catch (error) {
    if (error instanceof ProtocolRefusalError) {
      console.error(`[biao-node] 协议不兼容，拒绝注册（fail-closed）：${error.negotiation.compatible ? '' : error.negotiation.message}`);
      return 4;
    }
    if (error instanceof DaemonAuthError) {
      console.error(`[biao-node] 鉴权失败：${error.message}`);
      return 2;
    }
    console.error(`[biao-node] 启动失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  fatal(`未知子命令：${command}\n\n${USAGE}`);
}

// 仅在作为可执行入口时自启：bin/biao-node.js 动态 import 本模块，或 tsx
// 直跑 src/node/cli.ts；被测试/其他模块 import 时不执行 CLI。
if (process.argv.some((arg) => arg.endsWith('biao-node.js') || arg.endsWith(join('src', 'node', 'cli.ts')))) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[biao-node] 未捕获错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
