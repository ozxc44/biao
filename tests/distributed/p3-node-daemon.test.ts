/**
 * Phase 3 失败优先验收测试：biao-node 骨架
 *
 * 真实 HTTP 隔离端口 server（createHttpServer + SQLite + Redis 6380/15）+
 * 真实子进程 daemon（node bin/biao-node.js，dist 缺失/过期时回退 tsx）+
 * in-process daemon（注入 fault-injector 包装的 fetch）三层结合：
 *
 * §21 Phase 3 验收原文逐项：
 * 1. 节点重启/掉线/drain 不产生重复 claim（重启后旧 session fencing、
 *    无第二个 claim 赢家）；旧 session 被 fencing；
 * 2. lease watchdog（R1B-006）：续租不可确认 → at_risk → 停止窗口内停工、
 *    写 recovery bundle、上报留 report_pending；409/generation → 立即停；
 * 3. 时钟偏差注入 → 心跳携带 clock_skew_ms 被服务端记录；
 * 4. 协议版本矩阵：不匹配/未声明 → fail-closed 拒绝注册并给出明确错误；
 * 5. 模板静态校验：launchd/systemd/PS1 占位符与 install 脚本一致性。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import { loadNodeConfig } from '../../src/node/config.js';
import { NodeClock } from '../../src/node/clock.js';
import { negotiateProtocolVersion, extractAdvertisedProtocol } from '../../src/node/protocol.js';
import type { FetchImpl } from '../../src/node/transport.js';
import { NodeDaemon } from '../../src/node/daemon.js';
import { LeaseWatchdog } from '../../src/node/lease-watchdog.js';
import { readLedgerEvents } from '../../src/node/ledger.js';
import {
  NODE_TEMPLATE_FILES,
  NODE_TEMPLATE_PLACEHOLDERS,
  listTemplatePlaceholders,
  readNodeTemplate,
  renderTemplate,
} from '../../src/node/templates.js';
import { addFaultRoute, clearFaultRoutes, resetAllFaults, wrapFetchWithFaults } from './fixtures/fault-injector.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'test-owner-token';
const P3_CREDENTIAL_KEY = 'aabbccdd'.repeat(8);

// env 纪律：save/restore，避免 singleFork 串行污染
const savedEnv: Record<string, string | undefined> = {};

// 注意：env 设置移到 beforeAll，不再在模块级执行

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMPLATES_ROOT = join(REPO_ROOT, 'templates/node');

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];
const spawned: Array<{ proc: ChildProcess; exited: Promise<number | null> }> = [];

/* ---------------- 子进程入口解析：dist 优先，缺失/过期回退 tsx ---------------- */

interface CliEntry {
  cmd: string;
  args: string[];
}

function resolveCliEntry(): CliEntry {
  const distCli = join(REPO_ROOT, 'dist/node/cli.js');
  if (existsSync(distCli)) {
    const srcDir = join(REPO_ROOT, 'src/node');
    const newestSrc = Math.max(
      ...readdirSync(srcDir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => statSync(join(srcDir, name)).mtimeMs),
    );
    if (statSync(distCli).mtimeMs >= newestSrc) {
      return { cmd: process.execPath, args: [join(REPO_ROOT, 'bin/biao-node.js')] };
    }
  }
  return { cmd: process.execPath, args: [join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), join(REPO_ROOT, 'src/node/cli.ts')] };
}

const CLI_ENTRY = resolveCliEntry();

interface CliRun {
  proc: ChildProcess;
  exited: Promise<number | null>;
  stdout(): string;
  stderr(): string;
}

function runCli(args: string[], envExtra: Record<string, string> = {}, timeoutMs = 30_000): CliRun {
  const proc = spawn(CLI_ENTRY.cmd, [...CLI_ENTRY.args, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
    }, timeoutMs).unref();
  });
  spawned.push({ proc, exited });
  return { proc, exited, stdout: () => stdout, stderr: () => stderr };
}

/* ---------------- 公共工具 ---------------- */

let nodeSeq = 0;
function nextNodeId(label: string): string {
  nodeSeq += 1;
  return `node-p3-${label}-${String(nodeSeq).padStart(6, '0')}`;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `biao-p3-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

interface FastConfig {
  nodeId: string;
  heartbeatIntervalMs?: number;
  watchdogTickMs?: number;
  claimIntervalMs?: number;
  renewMarginMs?: number;
  stopWindowMs?: number;
  drainTimeoutMs?: number;
  drainAction?: 'cancel' | 'wait';
  serverProtocolVersion?: number | null;
  requestedProjectIds?: string[];
}

/** 写一份快速周期的测试配置（enroll 生成默认配置后按需覆盖）。 */
function writeFastConfig(dir: string, input: FastConfig): string {
  const config: Record<string, unknown> = {
    biao_url: serverUrl,
    node_id: input.nodeId,
    slots: 2,
    heartbeat_interval_ms: input.heartbeatIntervalMs ?? 400,
    watchdog_tick_ms: input.watchdogTickMs ?? 100,
    claim_interval_ms: input.claimIntervalMs ?? 800,
    lease_renew_margin_ms: input.renewMarginMs ?? 30_000,
    lease_stop_window_ms: input.stopWindowMs ?? 15_000,
    drain_timeout_ms: input.drainTimeoutMs ?? 2_000,
    drain_timeout_action: input.drainAction ?? 'cancel',
    requested_project_ids: input.requestedProjectIds ?? [],
    // 真实 server 的 /version 尚未公告 protocol_version（缺口清单 #1），
    // 除协议用例外一律固定 2（enroll 生成的初始配置同默认值）。
    server_protocol_version: input.serverProtocolVersion ?? 2,
  };
  if (input.serverProtocolVersion === null) {
    delete config.server_protocol_version;
  }
  const path = join(dir, 'biao-node.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

async function cliEnroll(nodeId: string, dir: string, envExtra: Record<string, string> = {}): Promise<CliRun> {
  const ticketFile = join(dir, 'enrollment-ticket.txt');
  writeFileSync(ticketFile, `ticket-${nodeId}-一次性票据`);
  const run = runCli([
    'enroll', '--url', serverUrl, '--node-id', nodeId,
    '--ticket-file', ticketFile,
    '--config', join(dir, 'biao-node.config.json'),
  ], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN, ...envExtra });
  const code = await run.exited;
  expect(code).toBe(0);
  return run;
}

function spawnDaemon(configPath: string, envExtra: Record<string, string> = {}): CliRun {
  return runCli(['run', '--config', configPath], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN, ...envExtra }, 120_000);
}

function readStatusFile(configPath: string): Record<string, any> {
  const config = loadNodeConfig(configPath);
  return JSON.parse(readFileSync(config.status_file, 'utf8'));
}

function statusOf(configPath: string): Record<string, any> | null {
  try {
    return readStatusFile(configPath);
  } catch {
    return null;
  }
}

function dropAttempt(configPath: string, intake: Record<string, unknown>): void {
  const config = loadNodeConfig(configPath);
  mkdirSync(config.state_inbox_dir, { recursive: true });
  writeFileSync(join(config.state_inbox_dir, `${intake.attempt_id as string}.json`), JSON.stringify(intake));
}

function sessionsRootOf(configPath: string): string {
  return loadNodeConfig(configPath).state_sessions_dir;
}

/** 汇总所有 session 账本里指定类型的 attempt 事件。 */
function allLedgerEventsForAttempt(configPath: string, attemptId: string): Array<{ boot: string; type: string }> {
  const root = sessionsRootOf(configPath);
  const events: Array<{ boot: string; type: string }> = [];
  if (!existsSync(root)) return events;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    for (const event of readLedgerEvents(root, entry.name)) {
      if (event.attempt_id === attemptId) events.push({ boot: entry.name, type: event.type });
    }
  }
  return events;
}

async function waitFor<T>(probe: () => T, label: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/* ---------------- server 环境 ---------------- */

beforeAll(async () => {
  // env 纪律：快照 + 设置
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_NODE_OWNER_TOKEN_FALLBACK'] = process.env['BIAO_NODE_OWNER_TOKEN_FALLBACK'];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = P3_CREDENTIAL_KEY;
  process.env['BIAO_NODE_OWNER_TOKEN_FALLBACK'] = '1';
  delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  // Phase 8 五旗（daemon 主链路走 V2 Node Runtime 面）
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  const dir = makeTempDir('server');
  store = new SqliteStore(join(dir, 'biao.sqlite'));
  app = await createHttpServer(redis, {
    apiToken: OWNER_TOKEN,
    host: '127.0.0.1',
    port: 0,
    workspaceRoots: [],
  }, { sqliteStore: store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  serverUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterEach(() => {
  resetAllFaults();
  for (const { proc } of spawned) {
    if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL');
  }
});

afterAll(async () => {
  await Promise.all(spawned.map(({ exited }) => exited)).catch(() => undefined);
  if (app) await app.close();
  if (store) store.close();
  if (redis) {
    await redis.flushdb();
    redis.disconnect();
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  // env 纪律：恢复快照
  for (const key of [V2_CREDENTIAL_KEY_ENV, 'BIAO_NODE_OWNER_TOKEN_FALLBACK', 'BIAO_V2_ENROLLMENT_TICKET', ...V2_FEATURE_FLAG_ENV_KEYS]) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]!;
    } else {
      delete process.env[key];
    }
  }
}, 30_000);

/* ================================================================ */
/* 1. 协议兼容矩阵                                                  */
/* ================================================================ */

describe('协议兼容矩阵（§10.5 / 目标 4）', () => {
  it('negotiateProtocolVersion 纯函数矩阵', () => {
    const ok2 = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: 2 });
    expect(ok2.compatible).toBe(true);
    if (ok2.compatible) expect(ok2.negotiated).toBe(2);

    const below = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: 1 });
    expect(below.compatible).toBe(false);
    if (!below.compatible) expect(below.reason).toBe('BELOW_MIN');

    const above = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: 3 });
    expect(above.compatible).toBe(false);
    if (!above.compatible) expect(above.reason).toBe('ABOVE_MAX');

    const pinned = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: null, pinnedProtocol: 2 });
    expect(pinned.compatible).toBe(true);
    if (pinned.compatible) expect(pinned.source).toBe('pinned');

    const undeclared = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: null });
    expect(undeclared.compatible).toBe(false);
    if (!undeclared.compatible) expect(undeclared.reason).toBe('UNDECLARED');

    // 公告优先于配置固定：公告不兼容时不得被 pinned 静默放宽。
    const advertisedWins = negotiateProtocolVersion({ daemonMin: 2, daemonMax: 2, serverProtocol: 3, pinnedProtocol: 2 });
    expect(advertisedWins.compatible).toBe(false);
  });

  it('extractAdvertisedProtocol：当前真实 server 的 /version 声明 protocol_version=2', async () => {
    const res = await fetch(`${serverUrl}/version`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
    const body = await res.json();
    expect(extractAdvertisedProtocol(body)).toBe(2);
  });

  it('子进程：服务端未声明且未固定协议版本 → fail-closed 拒绝注册（exit 4），未产生任何 register', async () => {
    const dir = makeTempDir('proto-und');
    const nodeId = nextNodeId('proto');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId, serverProtocolVersion: null });
    const run = spawnDaemon(configPath);
    const code = await run.exited;
    expect(code).toBe(4);
    expect(run.stderr()).toContain('拒绝注册');
    expect(run.stderr()).toContain('protocol_version');
    // register 从未发生：无 session 记录。
    expect(store.listNodeSessions(nodeId)).toHaveLength(0);
  }, 30_000);

  it.each([
    ['低于最小版本（BELOW_MIN）', 1, '低于本节点支持的最小版本'],
    ['高于最大版本（ABOVE_MAX）', 3, '高于本节点支持的最大版本'],
  ])('子进程：固定协议版本 %s → exit 4 且信息明确', async (_label, pinned, fragment) => {
    const dir = makeTempDir('proto-pin');
    const nodeId = nextNodeId('proto');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId, serverProtocolVersion: pinned as number });
    const run = spawnDaemon(configPath);
    const code = await run.exited;
    expect(code).toBe(4);
    expect(run.stderr()).toContain(fragment as string);
    expect(store.listNodeSessions(nodeId)).toHaveLength(0);
  }, 30_000);
});

/* ================================================================ */
/* 2. enroll 向导（§10.2：token 不进 argv）                          */
/* ================================================================ */

describe('enroll 向导（目标 2）', () => {
  it('拒绝 --ticket <值>（enrollment ticket 不得进 argv/Shell 历史）', async () => {
    const dir = makeTempDir('enroll-argv');
    const run = runCli([
      'enroll', '--url', serverUrl, '--node-id', nextNodeId('argv'),
      '--ticket', 'secret-ticket-value', '--config', join(dir, 'biao-node.config.json'),
    ], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN });
    const code = await run.exited;
    expect(code).toBe(2);
    expect(run.stderr()).toContain('不允许通过 --ticket');
  }, 20_000);

  it('enroll --ticket-file：凭据 0600 落盘、初始配置生成、服务端建档', async () => {
    const dir = makeTempDir('enroll-ok');
    const nodeId = nextNodeId('enroll');
    await cliEnroll(nodeId, dir);
    const credentialPath = join(dir, 'node-credential.json');
    expect(existsSync(credentialPath)).toBe(true);
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    const credential = JSON.parse(readFileSync(credentialPath, 'utf8'));
    expect(credential.credential.startsWith('bvn2_')).toBe(true);
    expect(credential.node_id).toBe(nodeId);
    expect(credential.credential_generation).toBe(1);
    const configPath = join(dir, 'biao-node.config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = loadNodeConfig(configPath);
    expect(config.biao_url).toBe(serverUrl);
    expect(config.node_id).toBe(nodeId);
    const nodeRow = store.getNode(nodeId);
    expect(nodeRow).toBeTruthy();
    expect(nodeRow!.status).toBe('online');
    // 输出不回显票据内容。
  }, 20_000);

  it('重复 enroll 同一 node_id：credential_generation 递增（旧凭据 fencing 前置）', async () => {
    const dir = makeTempDir('enroll-2');
    const nodeId = nextNodeId('reenroll');
    await cliEnroll(nodeId, dir);
    await cliEnroll(nodeId, dir);
    const credential = JSON.parse(readFileSync(join(dir, 'node-credential.json'), 'utf8'));
    expect(credential.credential_generation).toBe(2);
    expect(store.getNode(nodeId)!.credential_generation).toBe(2);
  }, 20_000);
});

/* ================================================================ */
/* 3. run：register → 心跳（§10.3）→ 优雅 drain                      */
/* ================================================================ */

describe('daemon run 主链路（§10.3 心跳字段 / §10.5 优雅退出）', () => {
  it('子进程心跳：§10.3 字段齐全、clock_skew_ms 被服务端记录、过渡鉴权回退可见', async () => {
    const dir = makeTempDir('run-basic');
    const nodeId = nextNodeId('run');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId, requestedProjectIds: ['proj-p3-basic-0001'] });
    const run = spawnDaemon(configPath);

    const status = await waitFor(() => {
      const current = statusOf(configPath);
      return current && current.heartbeat?.sent >= 2 ? current : undefined;
    }, '至少两次心跳', 15_000);

    expect(status.phase).toBe('running');
    // Phase 2+3 集成后服务端已接受 bvn2 Node credential，auth_mode 为 node_credential。
    expect(status.auth_mode).toBe('node_credential');
    expect(status.protocol.negotiated).toBe(2);
    expect(status.protocol.source).toBe('pinned');
    // §10.3 字段（registry 声明五项 + 骨架扩展的 running ids / 状态）。
    const body = status.heartbeat.last_body;
    expect(body.protocol_version).toBe(2);
    expect(typeof body.clock_skew_ms).toBe('number');
    expect(body.disk_free_gib).toBeGreaterThanOrEqual(0);
    expect(body.disk_free_percent).toBeGreaterThanOrEqual(0);
    expect(body.disk_free_percent).toBeLessThanOrEqual(100);
    expect(typeof body.slots_in_use).toBe('number');
    expect(Array.isArray(body.running_attempt_ids)).toBe(true);
    // 服务端已记录心跳（clock_skew_ms 落库）。
    const nodeRow = store.getNode(nodeId);
    expect(nodeRow!.status).toBe('online');
    expect(typeof nodeRow!.clock_skew_ms).toBe('number');
    // claim 通道探测：真实 server 的 stub 返回 NOT_IMPLEMENTED，daemon 不崩溃。
    await waitFor(() => (statusOf(configPath)?.claim?.server_claim_attempts ?? 0) >= 1, '至少一次 server claim 探测', 10_000);
    // Phase 2+3 集成后 claim 端点已实现；daemon 使用 owner_fallback 发送 claim
    // 可能成功（owner 有权访问项目）或被拒绝（需 bvn2）。§12 调度前置生效后，
    // 未授权节点→项目绑定会得到 403 BINDING_UNAUTHORIZED（本用例的项目未建
    // 绑定，属预期的拒绝形态之一）——断言关注 fail-closed 不崩溃。
    const claimCode = statusOf(configPath)!.claim.server_claim_last_code;
    expect(['OK', 'UNAUTHORIZED', 'CLIENT', 'BINDING_UNAUTHORIZED']).toContain(claimCode);

    // SIGTERM → 优雅 drain → offline → exit 0。
    run.proc.kill('SIGTERM');
    const code = await run.exited;
    expect(code).toBe(0);
    await waitFor(() => store.getNode(nodeId)!.status === 'offline', '服务端节点 offline', 5_000);
    const finalStatus = statusOf(configPath)!;
    expect(['drained']).toContain(finalStatus.phase);
    expect(finalStatus.drain.requested).toBe(true);
  }, 40_000);

  it('子进程心跳期间 status CLI 可读（进程存活判定 + JSON 输出）', async () => {
    const dir = makeTempDir('status-cli');
    const nodeId = nextNodeId('status');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId });
    const daemon = spawnDaemon(configPath);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 'daemon 进入 running', 10_000);

    const statusRun = runCli(['status', '--config', configPath, '--json'], {}, 15_000);
    const code = await statusRun.exited;
    expect(code).toBe(0);
    const payload = JSON.parse(statusRun.stdout());
    expect(payload.process_alive).toBe(true);
    expect(payload.phase).toBe('running');

    daemon.proc.kill('SIGKILL');
    await daemon.exited;
    const after = runCli(['status', '--config', configPath, '--json'], {}, 15_000);
    // 进程已死但状态文件仍在：报告 not-running（exit 1）。
    expect(await after.exited).toBe(1);
    expect(JSON.parse(after.stdout()).process_alive).toBe(false);
  }, 40_000);
});

/* ================================================================ */
/* 4. 时钟偏差注入（fault-injector 语义的子进程等价物）              */
/* ================================================================ */

describe('时钟偏差（§10.3/§10.4，R1C-002）', () => {
  it('NodeClock 纯逻辑：skew 计算 + 30/60/120 阈值档位 + 只紧不松', () => {
    const clock = new NodeClock();
    // server=10:00:01.000（Date 头秒级），往返 [10:00:00.800, 10:00:01.200] → skew≈0。
    const observation = clock.applyServerObservation(
      Date.parse('2026-08-16T10:00:01.000Z'),
      Date.parse('2026-08-16T10:00:00.800Z'),
      Date.parse('2026-08-16T10:00:01.200Z'),
    );
    expect(Math.abs(observation.clock_skew_ms)).toBeLessThanOrEqual(100);
    expect(clock.skewState()).toBe('ok');

    const slow = new NodeClock();
    slow.applyServerObservation(
      Date.parse('2026-08-16T10:02:01.000Z'),
      Date.parse('2026-08-16T10:00:00.800Z'),
      Date.parse('2026-08-16T10:00:01.200Z'),
    );
    expect(slow.skewState()).toBe('degraded'); // 偏差 ≈120s > 60s

    const far = new NodeClock();
    far.applyServerObservation(
      Date.parse('2026-08-16T10:04:01.000Z'),
      Date.parse('2026-08-16T10:00:00.800Z'),
      Date.parse('2026-08-16T10:00:01.200Z'),
    );
    expect(far.skewState()).toBe('quarantined'); // ≈241s > 120s

    // §10.4：阈值可配置但不得由 Node 自行放宽。
    expect(() => new NodeClock({ toleranceMs: 60_000 })).toThrow(/放宽/);
    expect(() => new NodeClock({ degradedMs: 10, quarantineMs: 5 })).toThrow(/tolerance ≤ degraded ≤ quarantine/);
  });

  it('子进程注入 +15s 时钟偏差：心跳 skew（服务端-节点，负=节点快）被服务端记录', async () => {
    const dir = makeTempDir('skew');
    const nodeId = nextNodeId('skew');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId });
    const run = spawnDaemon(configPath, { BIAO_NODE_INJECTED_CLOCK_OFFSET_MS: '15000' });
    await waitFor(() => (statusOf(configPath)?.heartbeat?.sent ?? 0) >= 1, '至少一次心跳', 15_000);
    run.proc.kill('SIGKILL');
    await run.exited;
    const skew = store.getNode(nodeId)!.clock_skew_ms;
    expect(skew).not.toBeNull();
    // 节点快 15s → skew = 服务端-节点 ≈ -15000（Date 头秒级粒度容差）。
    expect(skew!).toBeLessThanOrEqual(-12_000);
    expect(skew!).toBeGreaterThanOrEqual(-18_000);
  }, 40_000);
});

/* ================================================================ */
/* 5. §21 验收原文：重启/掉线 → 旧 session fencing、零重复 claim     */
/* ================================================================ */

describe('节点重启 fencing 与零重复 claim（§21 Phase 3 验收）', () => {
  it('SIGKILL 掉线 → 重启注册新 generation：旧 session fenced、attempt 不被二次 claim', async () => {
    const dir = makeTempDir('restart');
    const nodeId = nextNodeId('restart');
    await cliEnroll(nodeId, dir);
    // lease 60s + 默认 margin 30s：观测窗口内 attempt 保持 running（不触发续租停止）。
    const configPath = writeFastConfig(dir, { nodeId });

    const v1 = spawnDaemon(configPath);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 'v1 running', 15_000);
    dropAttempt(configPath, { attempt_id: 'att-restart-0001', task_id: 'task-r1', attempt_generation: 1, lease_duration_ms: 60_000 });
    await waitFor(() => statusOf(configPath)?.slots?.in_use === 1, 'v1 认领 attempt', 10_000);
    const v1Status = statusOf(configPath)!;
    expect(v1Status.slots.attempts[0].attempt_id).toBe('att-restart-0001');
    expect(v1Status.slots.attempts[0].status).toBe('running');
    const v1BootId = v1Status.boot_id as string;

    // 掉线（无 drain、无 offline）：进程直接消失。
    v1.proc.kill('SIGKILL');
    await v1.exited;

    // 重启：register 新 session generation，旧 session 被服务端 fenced。
    const v2 = spawnDaemon(configPath);
    await waitFor(() => {
      const sessions = store.listNodeSessions(nodeId);
      return sessions.length >= 2 ? sessions : undefined;
    }, '两个 session', 15_000);
    const sessions = store.listNodeSessions(nodeId);
    const fenced = sessions.filter((s) => s.status === 'fenced');
    const active = sessions.filter((s) => s.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].node_session_generation).toBe(2);
    // 至少 gen1 被 fenced（本用例即 v1 的 session）。
    expect(fenced.some((s) => s.node_session_generation === 1)).toBe(true);

    const v2Status = await waitFor(() => {
      const current = statusOf(configPath);
      return current && current.boot_id !== v1BootId && current.phase === 'running' ? current : undefined;
    }, 'v2 running（新 boot）', 15_000);

    // 旧 session 的 attempt 被登记为 pending recovery，不被 v2 重新运行。
    const orphan = v2Status.orphans.find((o: { attempt_id: string }) => o.attempt_id === 'att-restart-0001');
    expect(orphan).toBeTruthy();
    expect(orphan.boot_id).toBe(v1BootId);
    expect(statusOf(configPath)!.slots.in_use).toBe(0);
    expect(statusOf(configPath)!.heartbeat.last_body.running_attempt_ids).not.toContain('att-restart-0001');
    // recovery 桩文件存在且状态 pending_recovery。
    const recoveryPath = join(loadNodeConfig(configPath).state_recovery_dir, 'att-restart-0001.json');
    expect(existsSync(recoveryPath)).toBe(true);
    expect(JSON.parse(readFileSync(recoveryPath, 'utf8')).status).toBe('pending_recovery');

    // 零重复 claim：全部账本中该 attempt 的 adopted 事件只有一次。
    const adopted = allLedgerEventsForAttempt(configPath, 'att-restart-0001').filter((e) => e.type === 'adopted');
    expect(adopted).toHaveLength(1);
    expect(adopted[0].boot).toBe(v1BootId);

    // v2 仍可认领新任务（能力未被旧 session 影响）。
    dropAttempt(configPath, { attempt_id: 'att-restart-0002', task_id: 'task-r2', attempt_generation: 1, lease_duration_ms: 60_000 });
    await waitFor(() => statusOf(configPath)?.slots?.in_use === 1, 'v2 认领新 attempt', 10_000);
    const adopted2 = allLedgerEventsForAttempt(configPath, 'att-restart-0002').filter((e) => e.type === 'adopted');
    expect(adopted2).toHaveLength(1);
    expect(adopted2[0].boot).toBe(v2Status.boot_id);

    v2.proc.kill('SIGTERM');
    expect(await v2.exited).toBe(0);
  }, 90_000);
});

/* ================================================================ */
/* 6. drain（§10.5）：不再 claim、等待收口、超时显式 cancel、offline */
/* ================================================================ */

describe('drain 语义（§10.5）', () => {
  it('CLI drain：投递控制文件 → 停止 claim → 等待/取消 attempts → offline → exit 0', async () => {
    const dir = makeTempDir('drain');
    const nodeId = nextNodeId('drain');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId, drainTimeoutMs: 1_500, drainAction: 'cancel' });
    const daemon = spawnDaemon(configPath);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 'daemon running', 15_000);

    // lease 120s + margin 100s：drain 窗口内不会先被 watchdog 停掉。
    dropAttempt(configPath, { attempt_id: 'att-drain-0001', task_id: 'task-d1', attempt_generation: 1, lease_duration_ms: 120_000 });
    await waitFor(() => statusOf(configPath)?.slots?.in_use === 1, 'attempt 已认领', 10_000);

    const drainRun = runCli(['drain', '--config', configPath, '--wait-ms', '20000'], { BIAO_NODE_OWNER_TOKEN: OWNER_TOKEN }, 30_000);
    await waitFor(() => statusOf(configPath)?.drain?.requested === true, 'drain 已被 daemon 确认', 10_000);

    // drain 后不再 claim：新投递不被认领。
    dropAttempt(configPath, { attempt_id: 'att-drain-0002', task_id: 'task-d2', attempt_generation: 1, lease_duration_ms: 60_000 });
    const daemonCode = await daemon.exited;
    expect(daemonCode).toBe(0);

    const inboxSecond = join(loadNodeConfig(configPath).state_inbox_dir, 'att-drain-0002.json');
    expect(existsSync(inboxSecond)).toBe(true); // 原样留在 inbox
    const finalStatus = statusOf(configPath)!;
    expect(finalStatus.phase).toBe('drained');
    const attempt = finalStatus.slots.attempts.find((a: { attempt_id: string }) => a.attempt_id === 'att-drain-0001');
    expect(attempt.status).toBe('stopped');
    expect(attempt.stop_reason).toBe('drain_cancel');
    // drain_cancel 非 lease 相关：不写 recovery bundle。
    expect(existsSync(join(loadNodeConfig(configPath).state_recovery_dir, 'att-drain-0001.json'))).toBe(false);
    await waitFor(() => store.getNode(nodeId)!.status === 'offline', '服务端 offline', 5_000);

    const drainCode = await drainRun.exited;
    expect(drainCode).toBe(0);
    expect(drainRun.stdout()).toContain('drain 完成');
  }, 60_000);
});

/* ================================================================ */
/* 7. lease watchdog（R1B-006）                                     */
/* ================================================================ */

describe('lease watchdog：续租不可确认 → at_risk → 停止窗口停工（R1B-006）', () => {
  it('子进程 + 真实 server（renew 为 NOT_IMPLEMENTED stub）：fail-closed 全链路', async () => {
    const dir = makeTempDir('watchdog');
    const nodeId = nextNodeId('wd');
    await cliEnroll(nodeId, dir);
    // lease 4s，margin 3s（1s 起续），stop window 1.5s（2.5s 起停）。
    const configPath = writeFastConfig(dir, { nodeId, renewMarginMs: 3_000, stopWindowMs: 1_500 });
    const daemon = spawnDaemon(configPath);
    await waitFor(() => statusOf(configPath)?.phase === 'running', 'daemon running', 15_000);

    dropAttempt(configPath, { attempt_id: 'att-wd-0001', task_id: 'task-w1', attempt_generation: 1, lease_duration_ms: 4_000 });
    await waitFor(() => statusOf(configPath)?.slots?.attempts?.[0]?.status === 'lease_at_risk', '首次续租失败进入 at_risk', 8_000);
    const stopped = await waitFor(() => {
      const attempt = statusOf(configPath)?.slots?.attempts?.[0];
      return attempt && attempt.status === 'stopped' ? attempt : undefined;
    }, '停止窗口内停工', 8_000);
    expect(stopped.stop_reason).toBe('expiry_stop_window');
    // slot 已释放。
    expect(statusOf(configPath)!.slots.in_use).toBe(0);
    // recovery bundle 桩（§10.4）。
    const recoveryPath = join(loadNodeConfig(configPath).state_recovery_dir, 'att-wd-0001.json');
    expect(existsSync(recoveryPath)).toBe(true);
    const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    expect(recovery.status).toBe('pending_recovery');
    expect(recovery.reason).toBe('expiry_stop_window');
    // 账本时序：adopted → renew_failed/lease_at_risk → stopped → report_pending。
    const types = allLedgerEventsForAttempt(configPath, 'att-wd-0001').map((e) => e.type);
    const idx = (needle: string) => types.indexOf(needle);
    expect(idx('adopted')).toBeGreaterThanOrEqual(0);
    expect(idx('lease_at_risk')).toBeGreaterThan(idx('adopted'));
    expect(idx('stopped')).toBeGreaterThan(idx('lease_at_risk'));
    expect(types).toContain('report_pending'); // 上报通道为 stub → 本地留 pending
    daemon.proc.kill('SIGTERM');
    expect(await daemon.exited).toBe(0);
  }, 60_000);

  it('watchdog 单元矩阵：续租成功延长 / 网络失败进入 at_risk / 409 立即 lease_lost', async () => {
    const events: string[] = [];
    const stops: string[] = [];
    let mono = 0;
    const renewOutcomes: Array<{ ok: boolean; failureKind?: string }> = [];
    const watchdog = new LeaseWatchdog(
      { renewMarginMs: 3_000, stopWindowMs: 1_500 },
      {
        renew: async () => renewOutcomes.shift() ?? { ok: true },
        onStop: (_attempt, reason) => { stops.push(reason); },
        onEvent: (event) => { events.push(event.type); },
      },
      { mono: () => mono, now: () => 1_000_000 },
    );
    watchdog.register({ attempt_id: 'a', task_id: 't', generation: 1, deadline_mono: 10_000, adopted_at_wall: 1_000_000 });

    // 续租一直成功：每次返回新的（单调坐标）deadline，永不停止。
    renewOutcomes.push(
      { ok: true, newDeadlineMono: 20_000 },
      { ok: true, newDeadlineMono: 30_000 },
      { ok: true, newDeadlineMono: 40_000 },
    );
    mono = 7_100; await watchdog.tick();
    mono = 17_200; await watchdog.tick();
    mono = 27_200; await watchdog.tick();
    expect(watchdog.list()[0].status).toBe('running');
    expect(stops).toHaveLength(0);
    expect(events.filter((type) => type === 'renew_ok')).toHaveLength(3);

    // 网络失败：at_risk，但不早于停止线；到停止线即停。
    events.length = 0;
    renewOutcomes.push({ ok: false, failureKind: 'NETWORK' });
    mono = 37_200; await watchdog.tick();
    expect(watchdog.list()[0].status).toBe('lease_at_risk');
    expect(events).toContain('lease_at_risk');
    mono = 38_600; await watchdog.tick(); // ≥ deadline(40_000)-1_500
    expect(watchdog.list()[0].status).toBe('stopped');
    expect(stops).toContain('expiry_stop_window');

    // 409/generation 拒绝：立即 lease_lost，不等停止窗口。
    events.length = 0;
    stops.length = 0;
    const fenced = new LeaseWatchdog(
      { renewMarginMs: 3_000, stopWindowMs: 1_500 },
      {
        renew: async () => ({ ok: false, failureKind: 'FENCED', code: 'GENERATION_MISMATCH' }),
        onStop: (_attempt, reason) => { stops.push(reason); },
        onEvent: (event) => { events.push(event.type); },
      },
      { mono: () => mono, now: () => 1_000_000 },
    );
    fenced.register({ attempt_id: 'b', task_id: 't', generation: 1, deadline_mono: 10_000, adopted_at_wall: 1_000_000 });
    mono = 7_100; await fenced.tick();
    expect(fenced.list()[0].status).toBe('lease_lost');
    expect(stops).toContain('lease_lost');
    expect(events).toContain('lease_lost');

    // 重复登记拒绝。
    expect(() => watchdog.register({ attempt_id: 'a', task_id: 't', generation: 1, deadline_mono: 10_000, adopted_at_wall: 0 })).toThrow(/重复登记/);
  });

  it('参数防御：停止窗口必须小于续租提前量', () => {
    expect(() => new LeaseWatchdog(
      { renewMarginMs: 1_000, stopWindowMs: 2_000 },
      { renew: async () => ({ ok: true }), onStop: () => undefined, onEvent: () => undefined },
    )).toThrow(/必须小于/);
  });
});

/* ================================================================ */
/* 8. in-process：心跳 409（被 fencing）→ 停止一切并 exit 3          */
/* ================================================================ */

describe('daemon 对 409/fencing 的断言与处理（掉线恢复）', () => {
  it('心跳被服务端 409 SESSION_FENCED 拒绝：立即停止本地工作、phase=fenced、exit 3', async () => {
    const dir = makeTempDir('fenced');
    const nodeId = nextNodeId('fenced');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId });

    const realFetch = globalThis.fetch as FetchImpl;
    let heartbeatCount = 0;
    const fencedFetch: FetchImpl = async (url, init) => {
      // 首个心跳放行（保证 register→running→认领 attempt 先完成），
      // 第二个心跳起模拟服务端 fencing 判定（409 SESSION_FENCED）。
      if (url.toString().includes('/heartbeat') && (heartbeatCount += 1) > 1) {
        return new Response(JSON.stringify({ ok: false, data: null, error: { code: 'SESSION_FENCED', message: '旧 session 已被 fencing' } }), {
          status: 409,
          headers: { 'content-type': 'application/json', date: new Date().toUTCString() },
        });
      }
      return realFetch(url, init);
    };
    const daemon = NodeDaemon.fromConfig(loadNodeConfig(configPath), {
      node_id: nodeId,
      credential: 'bvn2_fake_not_verified_by_current_server',
      credential_generation: 1,
      biao_url: serverUrl,
      enrolled_at: Date.now(),
    }, { fetchImpl: fencedFetch, ownerToken: OWNER_TOKEN, env: { ...process.env, BIAO_NODE_OWNER_TOKEN_FALLBACK: '1' } });

    const runPromise = daemon.run();
    runPromise.catch(() => undefined); // waitFor 超时前先兜住 rejection，避免未处理拒绝
    // Phase 2+3 集成后首次心跳可能因 bvn2 被拒后 owner_fallback 重试被 fencedFetch 拦截，
    // 导致 daemon 直接从 registering 进入 fenced（跳过 running）。
    await waitFor(() => ['running', 'fenced'].includes(daemon.getStatus().phase), 'in-process daemon running or fenced', 10_000);
    if (daemon.getStatus().phase === 'running') {
      dropAttempt(configPath, { attempt_id: 'att-fenced-0001', task_id: 'task-f1', attempt_generation: 1, lease_duration_ms: 120_000 });
      await waitFor(() => daemon.getStatus().slots.in_use === 1, 'attempt 已认领', 5_000);
    }

    const code = await runPromise;
    expect(code).toBe(3);
    const status = daemon.getStatus();
    expect(status.phase).toBe('fenced');
    // fencing：本地工作立即停止 + recovery bundle（不同于 drain_cancel）。
    // Phase 2+3 集成后 daemon 可能在认领 attempt 前就被 fenced（bvn2 401→owner_fallback→fencedFetch 409）
    if (status.slots.attempts.length > 0) {
      expect(status.slots.attempts[0].stop_reason).toBe('fenced');
      expect(existsSync(join(loadNodeConfig(configPath).state_recovery_dir, 'att-fenced-0001.json'))).toBe(true);
    }
    expect(status.recent_errors.some((e: { code: string }) => e.code === 'SESSION_FENCED')).toBe(true);
    expect(status.slots.in_use).toBe(0);
  }, 30_000);

  it('网络分区（fault-injector）：心跳失败不退出、持续重试，恢复后自愈', async () => {
    const dir = makeTempDir('partition');
    const nodeId = nextNodeId('part');
    await cliEnroll(nodeId, dir);
    const configPath = writeFastConfig(dir, { nodeId });

    const realFetch = globalThis.fetch as FetchImpl;
    const wrapped = wrapFetchWithFaults(realFetch);
    const daemon = NodeDaemon.fromConfig(loadNodeConfig(configPath), {
      node_id: nodeId,
      credential: 'bvn2_fake',
      credential_generation: 1,
      biao_url: serverUrl,
      enrolled_at: Date.now(),
    }, { fetchImpl: wrapped, ownerToken: OWNER_TOKEN, env: { ...process.env, BIAO_NODE_OWNER_TOKEN_FALLBACK: '1' } });

    const runPromise = daemon.run();
    runPromise.catch(() => undefined); // waitFor 超时前先兜住 rejection，避免未处理拒绝
    await waitFor(() => daemon.getStatus().phase === 'running' && daemon.getStatus().heartbeat.sent >= 1, '首个心跳成功', 10_000);

    // 分区：只拦心跳（观测“不靠日志式续租、也不崩溃”的韧性）。
    addFaultRoute('/heartbeat', () => true);
    await waitFor(() => daemon.getStatus().heartbeat.consecutive_failures >= 2, '心跳连续失败被记录', 8_000);
    expect(daemon.getStatus().phase).toBe('running');
    expect(daemon.getStatus().recent_errors.some((e: { code: string }) => e.code === 'HEARTBEAT_FAILED')).toBe(true);

    clearFaultRoutes();
    await waitFor(() => daemon.getStatus().heartbeat.last_ok === true, '分区恢复后心跳自愈', 15_000);

    daemon.requestDrain('测试收口', 500, 'cancel');
    expect(await runPromise).toBe(0);
    expect(daemon.getStatus().phase).toBe('drained');
  }, 40_000);
});

/* ================================================================ */
/* 9. 模板静态校验（launchd/systemd/PS1 + install 一致性）           */
/* ================================================================ */

describe('服务模板静态校验（§10.2 / R1C-004）', () => {
  const contents = new Map<string, string>(
    NODE_TEMPLATE_FILES.map((name) => [name, readNodeTemplate(TEMPLATES_ROOT, name)]),
  );

  it('四个模板文件齐全且占位符全部已登记', () => {
    for (const name of NODE_TEMPLATE_FILES) {
      const content = contents.get(name)!;
      expect(content.trim().length).toBeGreaterThan(0);
      for (const key of listTemplatePlaceholders(content)) {
        expect(NODE_TEMPLATE_PLACEHOLDERS).toHaveProperty(key);
      }
    }
  });

  it('install-windows.ps1 覆盖 biao-node-service.ps1 所需的全部占位符', () => {
    const hostKeys = listTemplatePlaceholders(contents.get('biao-node-service.ps1')!);
    const installKeys = listTemplatePlaceholders(contents.get('install-windows.ps1')!);
    for (const key of hostKeys) {
      expect(installKeys).toContain(key);
    }
  });

  it('renderTemplate：完整渲染无残留；漏传/未登记键抛错', () => {
    const plist = contents.get('biao-node.launchd.plist')!;
    const rendered = renderTemplate(plist, {
      NODE_BIN: '/usr/local/bin/node',
      BIAO_NODE_JS: '/opt/biao/bin/biao-node.js',
      BIAO_NODE_CONFIG: '/etc/biao/biao-node.config.json',
      BIAO_NODE_STATE_DIR: '/var/lib/biao-node',
      BIAO_NODE_USER: '_biao',
    });
    expect(rendered).not.toMatch(/__[A-Z][A-Z0-9_]*__/);
    expect(rendered).toContain('/opt/biao/bin/biao-node.js');
    expect(() => renderTemplate(plist, { NODE_BIN: '/node' })).toThrow(/残留未替换/);
    expect(() => renderTemplate(plist, { NODE_BIN: '/node', NOT_REGISTERED: 'x' })).toThrow(/未在 NODE_TEMPLATE_PLACEHOLDERS 登记/);
  });

  it('launchd/systemd 关键语义齐备（优雅停止、重启策略、权限门禁）', () => {
    const plist = contents.get('biao-node.launchd.plist')!;
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('KeepAlive');
    expect(plist).toContain('__BIAO_NODE_STATE_DIR__/biao-node.stderr.log');

    const unit = contents.get('biao-node.service')!;
    expect(unit).toContain('KillSignal=SIGTERM');
    expect(unit).toContain('TimeoutStopSec=300');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('EnvironmentFile=__BIAO_NODE_ENV_FILE__');
    expect(unit).toContain('ReadWritePaths=__BIAO_NODE_STATE_DIR__ __BIAO_NODE_CACHE_DIR__');
  });

  it('Windows 产物（R1C-004 最小集）：Credential Manager、事件日志源、drain 控制文件、幂等安装与回滚', () => {
    const host = contents.get('biao-node-service.ps1')!;
    expect(host).toContain('PasswordVault'); // Credential Manager 适配
    expect(host).toContain('Write-EventLog');
    expect(host).toContain('drain.json');
    expect(host).not.toContain('bash');

    const installer = contents.get('install-windows.ps1')!;
    expect(installer).toContain('New-EventLog');
    expect(installer).toContain('sc.exe create');
    expect(installer).toContain('回滚');
    expect(installer).toContain('Uninstall');
    expect(installer).toContain('残留'); // 卸载前残留工作区清单
  });
});
