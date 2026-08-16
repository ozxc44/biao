/**
 * biao-node 守护进程（Phase 3 骨架 · §10 Node Runtime）
 *
 * 状态机（文字图，runbook 有运维视角版本）：
 *
 *   boot ──载入配置/凭据（失败→exit 2）
 *        ──协议协商（GET /version + 配置固定；不兼容→exit 4，fail-closed）
 *   registering ──POST /v2/nodes/register（409/fencing→fenced；401→回退 owner）
 *        ──孤儿扫描（旧 session attempt 只登记 pending recovery，不接管）
 *   running ──循环 tick：控制目录 poll → claim（inbox 占位 + server stub）
 *        │     → lease watchdog → 上报队列 → 心跳（§10.3 字段 + Date 头对时）
 *        │     ──心跳 409/GENERATION_MISMATCH → fenced
 *        │     ──SIGTERM/控制文件 → draining
 *   draining ──不再 claim；等待 running attempts 收口；超时按配置显式
 *        │     cancel 或继续等待（§10.5）→ 空 → offline → drained → exit 0
 *   fenced  ──watchdog 全量停止（fenced）→ 留痕 → exit 3（等待人工/重 enroll）
 *
 * 掉线恢复：进程重启后重新走 register（新 session generation，旧 session
 * 由服务端 fencing——Phase 1 已保证）；daemon 侧对 409/fenced 分类断言并
 * 停止一切本地工作，不重放旧 session 的 claim。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BIAO_EXEC_CMD_ENV,
  BIAO_NODE_INJECTED_CLOCK_OFFSET_ENV,
  BIAO_NODE_OWNER_TOKEN_ENV,
  type BiaoNodeRuntimeConfig,
  loadNodeConfig,
} from './config.js';
import { NodeClock } from './clock.js';
import { NodeApiClient, type FetchImpl, type AuthMode, type WorkerEventStreamHandle } from './transport.js';
import {
  NODE_PROTOCOL_VERSION_MAX,
  NODE_PROTOCOL_VERSION_MIN,
  extractAdvertisedProtocol,
  negotiateProtocolVersion,
  type ProtocolNegotiation,
} from './protocol.js';
import { readNodeCredential, type StoredNodeCredential } from './credentials-store.js';
import { LeaseWatchdog, type AttemptStopReason, type WatchdogAttempt } from './lease-watchdog.js';
import { PlaceholderExecutor, SlotTable, claimInboxAttempts, type AttemptIntake } from './slots.js';
import { RealExecutor, type RealExecutorOptions } from './real-executor.js';
import { appendLedgerEvent, scanOrphanedAttempts, type LedgerEvent, type OrphanedAttempt } from './ledger.js';

/** daemon 阶段（status.json 的 phase 字段； fenced/drained 是终态）。 */
export type DaemonPhase = 'boot' | 'registering' | 'running' | 'draining' | 'drained' | 'fenced';

/** 协商 fail-closed 拒绝：CLI 以退出码 4 结束并打印明确错误。 */
export class ProtocolRefusalError extends Error {
  constructor(public readonly negotiation: ProtocolNegotiation) {
    super(negotiation.compatible ? '协议协商异常' : negotiation.message);
    this.name = 'ProtocolRefusalError';
  }
}

/** 鉴权无法建立（无有效凭据且 owner 回退不可用）：退出码 2。 */
export class DaemonAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonAuthError';
  }
}

export interface NodeDaemonOptions {
  /** 测试注入的 fetch（fault-injector 包装/请求捕获）。 */
  fetchImpl?: FetchImpl;
  /** CLI 置 true；编程调用默认 false（测试进程不受信号影响）。 */
  installSignalHandlers?: boolean;
  ownerToken?: string;
  clock?: NodeClock;
  onRequest?: (info: { method: string; path: string; body?: unknown }) => void;
  env?: NodeJS.ProcessEnv;
  /** Phase 8 真执行器选项（注入后替换占位 executor）。 */
  realExecutorOptions?: Partial<RealExecutorOptions>;
  /** 强制使用真执行器（Phase 8 默认行为）。 */
  useRealExecutor?: boolean;
}

export interface DaemonStatusSnapshot {
  node_id: string;
  boot_id: string;
  pid: number;
  started_at_wall: number;
  updated_at_wall: number;
  phase: DaemonPhase;
  biao_url: string;
  auth_mode: AuthMode;
  protocol: { negotiated: number | null; source: 'advertised' | 'pinned' | null; daemon_min: number; daemon_max: number };
  register: { count: number; last_ok_at: number | null; last_error: { code: string; message: string } | null };
  heartbeat: {
    interval_ms: number;
    sent: number;
    last_at: number | null;
    last_ok: boolean;
    consecutive_failures: number;
    last_error: { code: string; message: string } | null;
    /** 最近一次心跳的完整请求体（§10.3 字段的可观测证据）。 */
    last_body: Record<string, unknown> | null;
  };
  clock: ReturnType<NodeClock['snapshot']>;
  slots: { capacity: number; in_use: number; attempts: Array<{ attempt_id: string; task_id: string; generation: number; status: string; deadline_at_wall: number | null; stop_reason?: string }> };
  claim: {
    inbox_claimed: number;
    server_claim_attempts: number;
    server_claim_last_code: string | null;
    invalid_intake: number;
    /** P12 车道 B：SSE 唤醒通道状态（task_ready → 立即 claim；断线降级轮询）。 */
    sse: {
      connected: boolean;
      events: number;
      wakes: number;
      reconnects: number;
      last_event_at: number | null;
      last_error: string | null;
    };
  };
  drain: { requested: boolean; reason: string | null; requested_at_wall: number | null; timeout_ms: number | null; action: 'cancel' | 'wait' | null; completed_at_wall: number | null; offline_pending: boolean };
  orphans: Array<Pick<OrphanedAttempt, 'attempt_id' | 'task_id' | 'generation' | 'boot_id'>>;
  recent_errors: Array<{ code: string; message: string; at_wall: number }>;
  exit_hint: number;
}

const MAX_RECENT_ERRORS = 12;
const MAX_AUTH_FAILURES = 3;
const OFFLINE_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInjectedClockOffset(env: NodeJS.ProcessEnv): number {
  const raw = env[BIAO_NODE_INJECTED_CLOCK_OFFSET_ENV];
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${BIAO_NODE_INJECTED_CLOCK_OFFSET_ENV} 需要整数毫秒（故障注入钩子，生产不得设置）`);
  }
  return Math.round(value);
}

export class NodeDaemon {
  readonly config: BiaoNodeRuntimeConfig;
  readonly credential: StoredNodeCredential;
  private readonly client: NodeApiClient;
  private readonly clock: NodeClock;
  private readonly slots: SlotTable;
  private readonly executor: PlaceholderExecutor;
  private readonly realExecutor: RealExecutor | null;
  private readonly watchdog: LeaseWatchdog;
  private readonly reportQueue: Array<{ attempt: WatchdogAttempt; reason: AttemptStopReason }> = [];
  private readonly recentErrors: DaemonStatusSnapshot['recent_errors'] = [];
  private readonly bootId = randomUUID();
  private readonly startedAtWall = Date.now();
  private readonly env: NodeJS.ProcessEnv;

  private phase: DaemonPhase = 'boot';
  private negotiation: ProtocolNegotiation | null = null;
  private registerCount = 0;
  private lastRegisterOkAt: number | null = null;
  private lastRegisterError: { code: string; message: string } | null = null;
  private heartbeatSent = 0;
  private lastHeartbeatAt: number | null = null;
  private lastHeartbeatOk = false;
  private heartbeatFailures = 0;
  private authFailures = 0;
  private lastHeartbeatError: { code: string; message: string } | null = null;
  private lastHeartbeatBody: Record<string, unknown> | null = null;
  private drainState: DaemonStatusSnapshot['drain'] = {
    requested: false, reason: null, requested_at_wall: null, timeout_ms: null, action: null, completed_at_wall: null, offline_pending: false,
  };
  private claimStats = {
    inbox_claimed: 0,
    server_claim_attempts: 0,
    server_claim_last_code: null as string | null,
    invalid_intake: 0,
    /** SSE 唤醒通道观测（P12 车道 B）：断线时自动降级轮询，connected=false。 */
    sse: {
      connected: false,
      events: 0,
      wakes: 0,
      reconnects: 0,
      last_event_at: null as number | null,
      last_error: null as string | null,
    },
  };
  private orphanList: DaemonStatusSnapshot['orphans'] = [];
  /** attempt token 缓存（claim 响应 → executor 用于 workspace/report 鉴权） */
  private readonly attemptTokenCache = new Map<string, string>();
  /** SSE 唤醒通道（GET /v2/events/stream）：句柄 + 重连状态。 */
  private sseHandle: WorkerEventStreamHandle | null = null;
  private sseReconnectTimer: NodeJS.Timeout | null = null;
  private sseReconnectAttempt = 0;
  private sseStopped = false;
  private sseLastEventId: string | null = null;
  private serverClaimInFlight = false;
  private signalDrainRequested = false;
  private signalForced = false;
  private lastStatus: DaemonStatusSnapshot | null = null;
  private diskStats = { disk_free_gib: 0, disk_free_percent: 0, last_error: null as string | null };
  private readonly shouldInstallSignalHandlers: boolean;

  private constructor(config: BiaoNodeRuntimeConfig, credential: StoredNodeCredential, options: NodeDaemonOptions = {}) {
    this.config = config;
    this.credential = credential;
    this.env = options.env ?? process.env;
    this.shouldInstallSignalHandlers = options.installSignalHandlers ?? false;
    this.clock = options.clock ?? new NodeClock({ injectedOffsetMs: parseInjectedClockOffset(this.env) });
    this.client = new NodeApiClient({
      baseUrl: config.biao_url,
      fetchImpl: options.fetchImpl,
      nodeCredential: credential.credential,
      ownerToken: options.ownerToken ?? this.env[BIAO_NODE_OWNER_TOKEN_ENV],
      onRequest: options.onRequest,
      env: this.env,
      // 服务端时间观测用节点时钟打点：故障注入的时钟偏差才能进入 skew。
      now: () => this.clock.now(),
    });
    this.slots = new SlotTable(config.slots);
    this.executor = new PlaceholderExecutor(config.state_sessions_dir, this.bootId);
    // Phase 8+P12：真执行器（useRealExecutor 或 realExecutorOptions 存在时启用）
    // P12 车道 B：执行命令模板可经 BIAO_EXEC_CMD env 配置（显式选项优先）。
    const execCommandFromEnv = this.env[BIAO_EXEC_CMD_ENV]?.trim() || undefined;
    this.realExecutor = (options.useRealExecutor || options.realExecutorOptions || execCommandFromEnv)
      ? new RealExecutor({
          biaoApiUrl: config.biao_url,
          nodeCredential: credential.credential,
          fetchImpl: options.fetchImpl as unknown as typeof globalThis.fetch,
          getAttemptToken: (attemptId) => this.attemptTokenCache.get(attemptId),
          ...(execCommandFromEnv ? { execCommand: execCommandFromEnv } : {}),
          ...options.realExecutorOptions,
        })
      : null;
    this.watchdog = new LeaseWatchdog(
      { renewMarginMs: config.lease_renew_margin_ms, stopWindowMs: config.lease_stop_window_ms },
      {
        renew: async (attempt) => this.renewAttempt(attempt),
        onStop: (attempt, reason) => this.handleAttemptStopped(attempt, reason),
        onEvent: (event) => this.ledgerEvent(event.type, event.detail, event.attempt_id),
      },
      { mono: () => this.clock.mono(), now: () => this.clock.now() },
    );
  }

  /** 从配置文件构造（CLI 入口；凭据缺失/权限过宽直接抛错）。 */
  static fromConfigFile(configPath: string, options: NodeDaemonOptions = {}): NodeDaemon {
    const config = loadNodeConfig(configPath);
    const credential = readNodeCredential(config.credential_file);
    return new NodeDaemon(config, credential, options);
  }

  /** 编程构造（p3 测试的 in-process 用法）。 */
  static fromConfig(config: BiaoNodeRuntimeConfig, credential: StoredNodeCredential, options: NodeDaemonOptions = {}): NodeDaemon {
    return new NodeDaemon(config, credential, options);
  }

  /* ---------------------------------------------------------------- */
  /* 基础设施                                                          */
  /* ---------------------------------------------------------------- */

  private ledgerEvent(type: LedgerEvent['type'], detail?: Record<string, unknown>, attemptId?: string): void {
    appendLedgerEvent(this.config.state_sessions_dir, this.bootId, { at_wall: this.clock.now(), type, attempt_id: attemptId, detail });
  }

  private recordError(code: string, message: string): void {
    this.recentErrors.unshift({ code, message: message.slice(0, 300), at_wall: this.clock.now() });
    if (this.recentErrors.length > MAX_RECENT_ERRORS) this.recentErrors.length = MAX_RECENT_ERRORS;
  }

  private writeStatus(): void {
    const snapshot = this.buildStatus();
    this.lastStatus = snapshot;
    const file = this.config.status_file;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  }

  private buildStatus(): DaemonStatusSnapshot {
    const attempts = this.watchdog.list().map((attempt) => ({
      attempt_id: attempt.attempt_id,
      task_id: attempt.task_id,
      generation: attempt.generation,
      status: attempt.status,
      deadline_at_wall: Math.round(this.clock.now() + (attempt.deadline_mono - this.clock.mono())),
      ...(attempt.stop_reason ? { stop_reason: attempt.stop_reason } : {}),
    }));
    return {
      node_id: this.config.node_id,
      boot_id: this.bootId,
      pid: process.pid,
      started_at_wall: this.startedAtWall,
      updated_at_wall: this.clock.now(),
      phase: this.phase,
      biao_url: this.config.biao_url,
      auth_mode: this.client.getAuthMode(),
      protocol: {
        negotiated: this.negotiation?.compatible ? this.negotiation.negotiated : null,
        source: this.negotiation?.compatible ? this.negotiation.source : null,
        daemon_min: NODE_PROTOCOL_VERSION_MIN,
        daemon_max: NODE_PROTOCOL_VERSION_MAX,
      },
      register: { count: this.registerCount, last_ok_at: this.lastRegisterOkAt, last_error: this.lastRegisterError },
      heartbeat: {
        interval_ms: this.config.heartbeat_interval_ms,
        sent: this.heartbeatSent,
        last_at: this.lastHeartbeatAt,
        last_ok: this.lastHeartbeatOk,
        consecutive_failures: this.heartbeatFailures,
        last_error: this.lastHeartbeatError,
        last_body: this.lastHeartbeatBody,
      },
      clock: this.clock.snapshot(),
      slots: { capacity: this.slots.capacity, in_use: this.slots.inUse(), attempts },
      claim: this.claimStats,
      drain: this.drainState,
      orphans: this.orphanList,
      recent_errors: this.recentErrors,
      exit_hint: this.phase === 'fenced' ? 3 : this.phase === 'drained' ? 0 : 1,
    };
  }

  getStatus(): DaemonStatusSnapshot {
    return this.lastStatus ?? this.buildStatus();
  }

  getBootId(): string {
    return this.bootId;
  }

  private bootstrapDirectories(): void {
    for (const dir of [
      this.config.state_root,
      this.config.cache_root,
      this.config.state_inbox_dir,
      this.config.state_control_dir,
      this.config.state_sessions_dir,
      this.config.state_recovery_dir,
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private installSignalHandlers(): void {
    const handler = (signal: NodeJS.Signals) => {
      if (this.signalDrainRequested) {
        // 第二次信号：放弃等待，立即取消并收口（§10.5 超时的显式选择）。
        this.signalForced = true;
        return;
      }
      this.signalDrainRequested = true;
      this.recordError('SIGNAL', `收到 ${signal}，进入优雅 drain（等待 running attempts 收口）`);
    };
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }

  /* ---------------------------------------------------------------- */
  /* 注册与协议协商                                                    */
  /* ---------------------------------------------------------------- */

  /** GET /version → 协商；失败直接抛 ProtocolRefusalError（fail-closed）。 */
  private async negotiate(): Promise<number> {
    let advertised: number | null = null;
    let lastNetworkError: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await this.client.getVersion();
      if (res.failure !== 'NETWORK') {
        advertised = res.ok ? extractAdvertisedProtocol(res.data) : null;
        lastNetworkError = null;
        break;
      }
      lastNetworkError = res.error?.message ?? '网络不可达';
      await sleep(400);
    }
    if (lastNetworkError) {
      throw new ProtocolRefusalError({
        compatible: false,
        reason: 'UNDECLARED',
        message: `无法访问控制面 ${this.config.biao_url}/version 完成协议协商：${lastNetworkError}。biao-node 拒绝注册（fail-closed）。`,
      });
    }
    const negotiation = negotiateProtocolVersion({
      daemonMin: NODE_PROTOCOL_VERSION_MIN,
      daemonMax: NODE_PROTOCOL_VERSION_MAX,
      serverProtocol: advertised,
      pinnedProtocol: this.config.server_protocol_version,
    });
    this.negotiation = negotiation;
    if (!negotiation.compatible) throw new ProtocolRefusalError(negotiation);
    return negotiation.negotiated;
  }

  private async registerSession(): Promise<void> {
    this.phase = 'registering';
    this.writeStatus();
    let lastError: { code: string; message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await this.client.register({
        node_id: this.config.node_id,
        labels: this.config.labels,
        slots: this.config.slots,
        requested_project_ids: this.config.requested_project_ids,
      });
      if (res.serverDateMs && res.timing) {
        this.clock.applyServerObservation(res.serverDateMs, res.timing.sent_at_wall, res.timing.received_at_wall);
      }
      if (res.ok) {
        this.registerCount += 1;
        this.lastRegisterOkAt = this.clock.now();
        this.lastRegisterError = null;
        this.phase = 'running';
        this.ledgerEvent('session_start', {
          boot_id: this.bootId,
          auth_mode: res.authMode,
          protocol: this.negotiation?.compatible ? this.negotiation.negotiated : null,
        });
        return;
      }
      lastError = res.error ?? { code: `HTTP_${res.status}`, message: '' };
      if (res.failure === 'FENCED') {
        // 旧 session/credential 被 fencing（Phase 1 语义）：停止一切并退出 3。
        this.enterFenced(`register 被服务端拒绝（${lastError.code}）`);
        return;
      }
      if (res.failure === 'UNAUTHORIZED') {
        throw new DaemonAuthError(
          `register 鉴权失败（${lastError.code}）：当前 server 尚不接受 bvn2 Node credential（缺口清单 #6）。` +
            `请设置 env ${BIAO_NODE_OWNER_TOKEN_ENV} 提供过渡期 owner 引导 token，或在关闭鉴权的控制面上运行。`,
        );
      }
      this.recordError('REGISTER_FAILED', `register 失败（${lastError.code}）：${lastError.message}`);
      await sleep(400);
    }
    this.lastRegisterError = lastError;
    throw new Error(`register 连续失败：${lastError ? `${lastError.code} ${lastError.message}` : '未知错误'}`);
  }

  /** 重启后的孤儿扫描：旧 session 的未收口 attempt 只登记，不接管。 */
  private scanOrphans(): void {
    const orphans = scanOrphanedAttempts(this.config.state_sessions_dir, this.bootId);
    for (const orphan of orphans) {
      this.ledgerEvent('orphaned', {
        task_id: orphan.task_id,
        generation: orphan.generation,
        origin_boot_id: orphan.boot_id,
        reason: 'session_fenced_on_restart',
        status: 'pending_recovery',
      }, orphan.attempt_id);
      const recoveryFile = join(this.config.state_recovery_dir, `${orphan.attempt_id}.json`);
      if (!existsSync(recoveryFile)) {
        writeFileSync(recoveryFile, `${JSON.stringify({
          attempt_id: orphan.attempt_id,
          task_id: orphan.task_id,
          attempt_generation: orphan.generation,
          origin_boot_id: orphan.boot_id,
          discovered_by_boot_id: this.bootId,
          discovered_at: this.clock.now(),
          reason: 'session_fenced_on_restart',
          status: 'pending_recovery',
          note: 'Phase 3 桩：等待服务端按 attempt generation 裁决（Phase 4 recovery-candidates 接口）',
        }, null, 2)}\n`, { mode: 0o600 });
      }
    }
    this.orphanList = orphans.map(({ attempt_id, task_id, generation, boot_id }) => ({ attempt_id, task_id, generation, boot_id }));
  }

  /* ---------------------------------------------------------------- */
  /* 主循环                                                            */
  /* ---------------------------------------------------------------- */

  async run(): Promise<number> {
    this.bootstrapDirectories();
    if (this.shouldInstallSignalHandlers) this.installSignalHandlers();
    this.writeStatus();
    await this.negotiate();
    await this.registerSession();
    if (this.currentPhase() === 'fenced') {
      this.writeStatus();
      return 3;
    }
    this.scanOrphans();
    if (this.signalDrainRequested) {
      this.enterDraining('启动期间收到停止信号', this.config.drain_timeout_ms, this.config.drain_timeout_action);
    }
    // P12 车道 B：SSE 唤醒通道（task_ready → 立即 claim）。轮询保留为
    // fallback——SSE 断线/服务端未开 NODE_RUNTIME 旗时自动降级，行为不变。
    this.startEventStream();
    while (this.currentPhase() === 'running' || this.currentPhase() === 'draining') {
      await this.tick();
      if (this.currentPhase() === 'drained' || this.currentPhase() === 'fenced') break;
      await sleep(Math.min(this.config.watchdog_tick_ms, 250));
    }
    this.stopEventStream();
    this.writeStatus();
    return this.currentPhase() === 'fenced' ? 3 : 0;
  }

  /**
   * phase 读取器：watchdog/信号回调会在 await 点之间改写 this.phase，
   * 经由方法读取可避免控制流分析把类型收窄成过期状态。
   */
  private currentPhase(): DaemonPhase {
    return this.phase;
  }

  private async tick(): Promise<void> {
    this.pollControlDir();
    if (this.signalDrainRequested && this.phase === 'running') {
      this.enterDraining('SIGTERM 优雅退出', this.config.drain_timeout_ms, this.config.drain_timeout_action);
    }
    if (this.signalForced && this.phase === 'draining') {
      // 第二次信号 = 显式选择 cancel（§10.5：超时必须显式选择）。
      this.watchdog.cancelAll('drain_cancel');
    }
    if (this.phase === 'running') {
      await this.claimTick();
    }
    await this.watchdog.tick();
    await this.processReportQueue();
    await this.heartbeatTick();
    if (this.phase === 'draining') {
      await this.drainProgressTick();
    }
    this.writeStatus();
  }

  /* ---- claim（Phase 3 inbox + P12 V2 claim 集成：SSE 唤醒优先，轮询 fallback） ---- */

  private lastServerClaimWall = 0;

  private async claimTick(): Promise<void> {
    const free = this.slots.freeCount();
    if (free <= 0) return;
    // 1) 轮询 fallback：SSE 唤醒（wakeClaim）会即时刷新 lastServerClaimWall，
    //    所以 SSE 在线时这里的间隔计时基本不会到期；SSE 断线后自动回到
    //    每 claim_interval_ms 一轮的轮询节奏（P12 车道 B 降级语义）。
    const nowWall = this.clock.now();
    if (
      this.config.requested_project_ids.length > 0 &&
      nowWall - this.lastServerClaimWall >= this.config.claim_interval_ms
    ) {
      await this.serverClaimOnce();
    }
    // 2) inbox 占位通道：原子 rename 认领（见 slots.ts 注释）。
    const { claimed, invalid } = claimInboxAttempts(
      this.config.state_inbox_dir,
      this.config.state_sessions_dir,
      this.bootId,
      this.slots.freeCount(),
    );
    this.claimStats.invalid_intake += invalid.length;
    for (const message of invalid) this.recordError('INTAKE_INVALID', message);
    for (const intake of claimed) this.adoptAttempt(intake);
  }

  /**
   * 真实 V2 claim（带 bvn2/过渡期凭据）：领到 → 缓存 attempt token →
   * 走统一 adoption 路径（RealExecutor prepare→execute→finalize→report 全链）。
   * tick 轮询与 SSE 唤醒共用；in-flight 防重入。
   */
  private async serverClaimOnce(): Promise<void> {
    if (this.serverClaimInFlight) return;
    this.serverClaimInFlight = true;
    try {
      this.lastServerClaimWall = this.clock.now();
      this.claimStats.server_claim_attempts += 1;
      const res = await this.client.claim({
        project_id: this.config.requested_project_ids[0],
        agent_id: this.config.node_id,
        claim_request_id: `cr-${randomUUID()}`,
      });
      this.claimStats.server_claim_last_code = res.ok ? 'OK' : (res.error?.code ?? 'NETWORK');
      if (!res.ok && res.failure !== 'NOT_IMPLEMENTED') {
        this.recordError('CLAIM_FAILED', `server claim 失败（${this.claimStats.server_claim_last_code}）：${res.error?.message ?? ''}`);
      }
      if (res.ok && res.data && typeof (res.data as { attempt_id?: unknown }).attempt_id === 'string') {
        // 缓存 attempt token（executor 用于 workspace/report 鉴权）
        const attId = (res.data as { attempt_id: string }).attempt_id;
        const attToken = (res.data as { attempt_token?: string }).attempt_token;
        if (attToken) this.attemptTokenCache.set(attId, attToken);

        // Phase 4+P12 落地真实 claim 后走同一 adoption 路径。
        this.adoptAttempt({
          attempt_id: attId,
          task_id: (res.data as { task_id?: string }).task_id ?? '',
          attempt_generation: Number((res.data as { attempt_generation?: unknown }).attempt_generation ?? 1),
          ...(typeof (res.data as { lease_duration_ms?: unknown }).lease_duration_ms === 'number'
            ? { lease_duration_ms: (res.data as { lease_duration_ms: number }).lease_duration_ms }
            : { lease_expires_at: Number((res.data as { lease_expires_at?: unknown }).lease_expires_at ?? Date.now() + 600_000) }),
        });
      }
    } finally {
      this.serverClaimInFlight = false;
    }
  }

  /* ---- SSE 唤醒通道（P12 车道 B：task_ready → 立即 claim，替代高频轮询） ---- */

  private static readonly SSE_RECONNECT_BASE_MS = 3_000;
  private static readonly SSE_RECONNECT_MAX_MS = 30_000;
  /** 同一节点两次 wake claim 的最小间隔：任务风暴下合并唤醒，防 claim 洪泛。 */
  private static readonly SSE_WAKE_CLAIM_MIN_INTERVAL_MS = 500;

  /** running 状态下启动 SSE 订阅（幂等）；断线由 done 回调按退避重连。 */
  private startEventStream(): void {
    if (this.sseStopped || this.sseHandle || this.sseReconnectTimer) return;
    if (this.currentPhase() !== 'running') return;
    const handle = this.client.streamEvents({
      lastId: this.sseLastEventId ?? undefined,
      onOpen: () => {
        this.sseReconnectAttempt = 0;
        this.claimStats.sse.connected = true;
        this.claimStats.sse.last_error = null;
      },
      onEvent: (event) => {
        if (event.id) this.sseLastEventId = event.id;
        const isTaskReady = event.event === 'task_ready' || event.data?.type === 'task_ready';
        if (!isTaskReady) return;
        this.claimStats.sse.events += 1;
        this.claimStats.sse.last_event_at = this.clock.now();
        void this.wakeClaim();
      },
    });
    this.sseHandle = handle;
    void handle.done.then(() => {
      this.sseHandle = null;
      const wasConnected = this.claimStats.sse.connected;
      this.claimStats.sse.connected = false;
      if (this.sseStopped || this.currentPhase() !== 'running') return;
      // 断线自动降级轮询（claimTick 的间隔通道），并按退避重连 SSE。
      if (wasConnected) {
        this.claimStats.sse.last_error = '连接断开，降级轮询并重连中';
        this.recordError('SSE_DISCONNECTED', 'task_ready 唤醒流断开：claim 回退轮询（claim_interval_ms），SSE 按退避重连');
      }
      this.scheduleSseReconnect();
    });
  }

  private scheduleSseReconnect(): void {
    if (this.sseStopped || this.sseReconnectTimer || this.sseHandle) return;
    const delay = Math.min(
      NodeDaemon.SSE_RECONNECT_MAX_MS,
      NodeDaemon.SSE_RECONNECT_BASE_MS * 2 ** Math.min(this.sseReconnectAttempt, 4),
    );
    this.sseReconnectAttempt += 1;
    this.claimStats.sse.reconnects += 1;
    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      this.startEventStream();
    }, delay);
    this.sseReconnectTimer.unref?.();
  }

  /** 收到 task_ready：立即 claim（间隔守门 + phase/slot 检查）。 */
  private async wakeClaim(): Promise<void> {
    if (this.currentPhase() !== 'running') return;
    if (this.config.requested_project_ids.length === 0) return;
    if (this.slots.freeCount() <= 0) return;
    const nowWall = this.clock.now();
    if (nowWall - this.lastServerClaimWall < NodeDaemon.SSE_WAKE_CLAIM_MIN_INTERVAL_MS) return;
    this.claimStats.sse.wakes += 1;
    await this.serverClaimOnce();
  }

  /** 停止 SSE 订阅与重连定时器（drain/fenced/进程收口时调用）。 */
  private stopEventStream(): void {
    this.sseStopped = true;
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    this.sseHandle?.close();
    this.sseHandle = null;
    this.claimStats.sse.connected = false;
  }

  private adoptAttempt(intake: AttemptIntake): void {
    if (!this.slots.occupy(intake.attempt_id)) return;
    const deadlineMono = intake.lease_duration_ms !== undefined
      ? this.clock.mono() + intake.lease_duration_ms
      : this.clock.serverEpochToMono(intake.lease_expires_at ?? 0);
    const deadlineWall = Math.round(this.clock.now() + (deadlineMono - this.clock.mono()));
    // Phase 8：真执行器优先
    if (this.realExecutor) {
      this.realExecutor.recordAdopted(intake, deadlineWall, this.bootId);
    } else {
      this.executor.recordAdopted(intake, deadlineWall);
    }
    this.watchdog.register({
      attempt_id: intake.attempt_id,
      task_id: intake.task_id,
      generation: intake.attempt_generation,
      deadline_mono: deadlineMono,
      adopted_at_wall: this.clock.now(),
    });
    this.claimStats.inbox_claimed += 1;
    this.ledgerEvent('adopted', { task_id: intake.task_id, generation: intake.attempt_generation, lease_deadline_at: deadlineWall }, intake.attempt_id);
  }

  /* ---- lease watchdog 回调 ---- */

  private async renewAttempt(attempt: WatchdogAttempt): Promise<{ ok: boolean; newDeadlineMono?: number; failureKind?: string; code?: string; message?: string }> {
    const remainingMs = Math.max(1000, attempt.deadline_mono - this.clock.mono());
    const res = await this.client.renewLease(attempt.attempt_id, { extend_seconds: Math.round(remainingMs / 1000) });
    if (res.ok) {
      const serverExpiry = res.data?.lease_expires_at;
      return {
        ok: true,
        ...(typeof serverExpiry === 'number' ? { newDeadlineMono: this.clock.serverEpochToMono(serverExpiry) } : {}),
      };
    }
    return { ok: false, failureKind: res.failure ?? 'UNKNOWN', code: res.error?.code, message: res.error?.message };
  }

  private handleAttemptStopped(attempt: WatchdogAttempt, reason: AttemptStopReason): void {
    if (this.realExecutor) {
      this.realExecutor.recordStopped(attempt, reason, this.config.state_recovery_dir);
    } else {
      this.executor.recordStopped(attempt, reason, this.config.state_recovery_dir);
    }
    this.attemptTokenCache.delete(attempt.attempt_id);
    this.slots.release(attempt.attempt_id);
    // 上报（可能失败——report 通道为 stub 时落为 report_pending，本地审计）。
    this.reportQueue.push({ attempt, reason });
  }

  private async processReportQueue(): Promise<void> {
    if (this.phase === 'fenced') return; // fencing 后不再以本 session 身份上报
    while (this.reportQueue.length > 0) {
      const { attempt, reason } = this.reportQueue.shift()!;
      const res = await this.client.reportAttempt(attempt.attempt_id, {
        status: 'failed', // stopped/lease_lost/cancel 不属于 done；registry 枚举只有 done|failed|partial
        artifact_refs: [],
      });
      if (res.ok) {
        this.ledgerEvent('report_attempted', { reason, outcome: 'accepted' }, attempt.attempt_id);
      } else {
        // NOT_IMPLEMENTED/网络失败：本地留 report_pending，网络恢复后可重放（Phase 4 幂等键）。
        this.ledgerEvent('report_pending', { reason, code: res.error?.code ?? `HTTP_${res.status}` }, attempt.attempt_id);
        this.recordError('REPORT_PENDING', `attempt ${attempt.attempt_id} 上报未确认（${res.error?.code ?? res.status}）`);
      }
    }
  }

  /* ---- 心跳（§10.3） ---- */

  private async refreshDiskStats(): Promise<void> {
    try {
      const stats = await statfs(this.config.cache_root);
      const blockSize = Number(stats.bsize) || 4096;
      const freeBytes = Number(stats.bavail) * blockSize;
      const totalBytes = Number(stats.blocks) * blockSize;
      this.diskStats = {
        disk_free_gib: Math.round((freeBytes / 1024 ** 3) * 100) / 100,
        disk_free_percent: totalBytes > 0 ? Math.round((Number(stats.bavail) / Number(stats.blocks)) * 10000) / 100 : 0,
        last_error: null,
      };
    } catch (error) {
      this.diskStats = { disk_free_gib: 0, disk_free_percent: 0, last_error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildHeartbeatBody(): Record<string, unknown> {
    // registry 声明的五个必填字段 + trust_anchor_generation 可选；
    // running_attempt_ids/node_status 是 §10.3 要求、declared schema 尚未
    // 承认的字段（缺口清单 #4——运行时未启用 schema 校验故可携带）。
    return {
      protocol_version: this.negotiation?.compatible ? this.negotiation.negotiated : NODE_PROTOCOL_VERSION_MAX,
      clock_skew_ms: this.clock.skewMs(),
      disk_free_gib: this.diskStats.disk_free_gib,
      disk_free_percent: this.diskStats.disk_free_percent,
      slots_in_use: this.slots.inUse(),
      running_attempt_ids: this.watchdog.runningAttemptIds(),
      node_status: this.phase === 'draining' ? 'draining' : 'online',
    };
  }

  private async heartbeatTick(): Promise<void> {
    const nowWall = this.clock.now();
    if (this.lastHeartbeatAt !== null && nowWall - this.lastHeartbeatAt < this.config.heartbeat_interval_ms) return;
    await this.refreshDiskStats();
    this.lastHeartbeatAt = nowWall;
    this.lastHeartbeatBody = this.buildHeartbeatBody();
    const res = await this.client.heartbeat(this.config.node_id, this.lastHeartbeatBody);
    if (res.serverDateMs && res.timing) {
      this.clock.applyServerObservation(res.serverDateMs, res.timing.sent_at_wall, res.timing.received_at_wall);
    }
    this.heartbeatSent += 1;
    if (res.ok) {
      this.lastHeartbeatOk = true;
      this.heartbeatFailures = 0;
      this.authFailures = 0;
      this.lastHeartbeatError = null;
      return;
    }
    this.lastHeartbeatOk = false;
    this.lastHeartbeatError = res.error ?? { code: `HTTP_${res.status}`, message: '' };
    if (res.failure === 'FENCED') {
      // 服务端判定本 session 已被 fencing（generation 变化）：立即停止一切。
      this.enterFenced(`心跳被服务端拒绝（${this.lastHeartbeatError.code}）：session 已被 fencing`);
      return;
    }
    this.heartbeatFailures += 1;
    if (res.failure === 'UNAUTHORIZED') {
      this.authFailures += 1;
      if (this.authFailures >= MAX_AUTH_FAILURES) {
        throw new DaemonAuthError(
          `心跳连续 ${this.authFailures} 次鉴权失败（${this.lastHeartbeatError.code}）。检查 env ${BIAO_NODE_OWNER_TOKEN_ENV} 与凭据文件。`,
        );
      }
    } else {
      this.recordError('HEARTBEAT_FAILED', `心跳失败（${this.lastHeartbeatError.code}）：${this.lastHeartbeatError.message}`);
    }
  }

  /* ---- drain / offline / fenced ---- */

  /** 运行中请求 drain（CLI 控制文件、SIGTERM、in-process 测试共用入口）。 */
  requestDrain(reason: string, timeoutMs: number, action: 'cancel' | 'wait'): void {
    this.enterDraining(reason, timeoutMs, action);
  }

  private enterDraining(reason: string, timeoutMs: number, action: 'cancel' | 'wait'): void {
    if (this.phase !== 'running') return;
    this.phase = 'draining';
    // drain = 不再 claim：唤醒通道随之关闭（wakeClaim 的 phase 守门是第二道）。
    this.stopEventStream();
    this.drainState = {
      requested: true,
      reason,
      requested_at_wall: this.clock.now(),
      timeout_ms: timeoutMs,
      action,
      completed_at_wall: null,
      offline_pending: false,
    };
    this.ledgerEvent('drain_started', { reason, timeout_ms: timeoutMs, action });
  }

  private async drainProgressTick(): Promise<void> {
    if (this.watchdog.activeCount() === 0) {
      await this.finishDrain();
      return;
    }
    const waited = this.clock.now() - (this.drainState.requested_at_wall ?? this.clock.now());
    if (waited <= (this.drainState.timeout_ms ?? this.config.drain_timeout_ms)) return;
    if (this.drainState.action === 'cancel') {
      // §10.5：超时必须显式选择——cancel 即对剩余 attempts 停止并上报。
      this.recordError('DRAIN_TIMEOUT', `drain 超时（${Math.round(waited)}ms），按配置 cancel 剩余 attempts`);
      this.watchdog.cancelAll('drain_cancel');
    } else {
      // wait：继续等待，每个超时周期记一次审计（不静默无限等）。
      if (!this.drainWaitLogged) {
        this.drainWaitLogged = true;
        this.recordError('DRAIN_TIMEOUT', `drain 超时（${Math.round(waited)}ms），按配置继续等待 attempts 收口`);
      }
    }
  }

  private drainWaitLogged = false;

  private async finishDrain(): Promise<void> {
    // 幂等：draining → offline → drained。
    if (this.phase !== 'draining') return;
    this.phase = 'drained';
    this.drainState.completed_at_wall = this.clock.now();
    this.ledgerEvent('drain_completed', { reason: this.drainState.reason });
    for (let attempt = 0; attempt < OFFLINE_RETRIES; attempt += 1) {
      const res = await this.client.offline(this.config.node_id, `biao-node drain：${this.drainState.reason ?? 'unknown'}`);
      if (res.ok) return;
      this.recordError('OFFLINE_FAILED', `offline 上报失败（${res.error?.code ?? res.status}），重试 ${attempt + 1}/${OFFLINE_RETRIES}`);
      await sleep(300);
    }
    // 本地工作已收口；offline 未确认只影响服务端在线投影（TTL 会兜底）。
    this.drainState.offline_pending = true;
  }

  private enterFenced(reason: string): void {
    if (this.phase === 'fenced' || this.phase === 'drained') return;
    this.phase = 'fenced';
    this.recordError('SESSION_FENCED', reason);
    // fencing：全部本地工作立即停止（watchdog 记账 + recovery bundle 桩）。
    this.stopEventStream();
    this.watchdog.cancelAll('fenced');
    this.ledgerEvent('fenced', { reason });
  }

  /* ---- 控制目录（跨进程、跨平台的 drain 请求通道） ---- */

  private pollControlDir(): void {
    const file = join(this.config.state_control_dir, 'drain.json');
    if (!existsSync(file)) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      this.recordError('CONTROL_INVALID', `drain 控制文件无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      unlinkSync(file);
    } catch {
      /* 并发消费时由赢家删除 */
    }
    const request = (parsed && typeof parsed === 'object' ? parsed : {}) as { reason?: unknown; timeout_ms?: unknown; action?: unknown };
    this.enterDraining(
      typeof request.reason === 'string' && request.reason ? request.reason : '操作者请求 drain（控制文件）',
      Number.isFinite(request.timeout_ms) && (request.timeout_ms as number) >= 0 ? (request.timeout_ms as number) : this.config.drain_timeout_ms,
      request.action === 'wait' ? 'wait' : 'cancel',
    );
  }

  /** 清理当前 boot 的运行残留（测试辅助；生产由 drain/offline 收口）。 */
  cleanupState(): void {
    rmSync(this.config.status_file, { force: true });
  }
}
