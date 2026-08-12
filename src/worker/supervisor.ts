/**
 * 客户端 Supervisor 协调器（被动式 PM/Worker 等待归一）
 *
 * 设计目标（对应任务书第 4 项）：
 *  - 把"PM 等待"与"多个 Worker 的等待"归一到同一台机器上唯一的一个客户端协调器，
 *    而不是每个 Agent 各起一套轮询循环。
 *  - 同一台机器、同一个 Biao 服务地址默认只允许一个实例：用本机锁文件实现，
 *    绝不用 Redis 全局锁（那会误伤其他客户端机器）。
 *  - 只维护一个事件游标 / 一个共享低频等待，对 PM 只产生最小门铃提醒，
 *    需要时通知 Worker 重新 claim。不复制平台详情。
 *  - 使用低资源定时读取和本机 wake doorbell；禁止每个 Worker 自行忙轮询。
 *  - 按项目管理等待生命周期：项目闭环（全部 done 且 PM Review 全 accepted，或已取消）
 *    后自动暂停该项目的提醒和 Worker 条件等待；全部受管项目闭环后进程干净退出。
 *
 * 重要边界：Supervisor 是可选客户端能力，不由 Biao 服务端启动。它只在本机调用
 * Biao 的被动 API（/intake、/claim 等），平台从不主动唤醒 PM。
 */

import { openSync, closeSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { stableHash } from '../redis/keys.js';
import { BiaoClient, runWorkerLoop, type WorkerConfig } from './base.js';
import type { ClaimedTask, TaskType } from '../types/index.js';

/** 本机锁句柄 */
export interface LocalLockHandle {
  acquired: boolean;
  path: string;
  /** 仅当前持有者知道的锁内容；release 时防止误删后来者的锁。 */
  owner?: string;
  /** 同机重复获取时的失败句柄也带 reason，便于诊断 */
  reason?: string;
}

/**
 * 把客户端写法规整为服务端点身份；锁只按服务端点区分，不能因为 `/`、默认端口或
 * localhost/127.0.0.1 这种等价本机写法而在同机起出两个 Supervisor。
 * 路径故意不参与锁：Biao 同时兼容根路径和 /api 前缀，它们仍是同一个服务。
 */
function canonicalSupervisorEndpoint(biaoUrl: string): string {
  try {
    const parsed = new URL(biaoUrl);
    const protocol = parsed.protocol.toLowerCase();
    let hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') hostname = '127.0.0.1';
    const port = parsed.port || (protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '');
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  } catch {
    // 让调用方后续请求仍按原 URL 失败；这里只提供稳定且保守的锁键，避免异常地址放大实例数。
    return biaoUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

/** 把 Biao 服务地址映射到本机锁文件路径（同一服务端点共用一个锁文件） */
function lockFilePath(biaoUrl: string, lockDir: string): string {
  return join(lockDir, `biao-supervisor-${stableHash(canonicalSupervisorEndpoint(biaoUrl))}.lock`);
}

/**
 * 尝试获取本机 Supervisor 单实例锁（同机同服务只允许一个）。
 * 实现：用独占创建 + 写入 pid/hostname 的锁文件。已存在且持有者存活 → 失败。
 * 这不是 Redis 全局锁，只影响本机，不会误伤其他客户端机器。
 */
export function tryAcquireLocalLock(biaoUrl: string, lockDir: string): LocalLockHandle {
  mkdirSync(lockDir, { recursive: true });
  const path = lockFilePath(biaoUrl, lockDir);
  const owner = `${process.pid}:${hostname()}:${biaoUrl}:${Date.now()}:${process.hrtime.bigint().toString(36)}`;

  // 最多两轮：首轮原子创建，若遇到明确的死锁文件才删除并再尝试一次。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${owner}\n`);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, path, owner };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      // 锁已存在：只有确认 pid 已退出才尝试清理。unlink 与下一轮 wx 都是原子的；
      // 若另一个进程抢先接管，下一轮会再得到 EEXIST 而不是双持有。
      let raw = '';
      try {
        raw = readFileSync(path, 'utf8').trim();
      } catch {
        // 对方可能刚释放；下一轮重新 wx 即可。
        continue;
      }
      const holderPid = Number(raw.split(':')[0]);
      if (!Number.isSafeInteger(holderPid) || holderPid <= 0) {
        // `wx` 成功到写入 owner 之间可短暂读到空文件。此时宁可保守拒绝，
        // 也绝不能把另一个刚创建的活锁删掉；损坏锁可由人工移除。
        return { acquired: false, path, reason: '锁文件内容尚未完成或已损坏，拒绝并发接管' };
      }
      if (isProcessAlive(holderPid)) {
        return { acquired: false, path, reason: `已被本机 pid=${holderPid} 占用` };
      }
      try {
        // 仅当内容仍是刚刚读取的死锁记录才删除，避免删掉并发接管者的新锁。
        if (readFileSync(path, 'utf8').trim() === raw) unlinkSync(path);
      } catch {
        // 竞争下保守失败/重试，不覆盖任何锁。
      }
    }
  }
  return { acquired: false, path, reason: '锁文件正在被另一个本机 Supervisor 创建或接管' };
}

/** 释放本机锁（中断清理 / 正常退出时调用） */
export function releaseLocalLock(handle: LocalLockHandle): void {
  if (!handle.acquired || !handle.owner) return;
  try {
    // 不能无条件 unlink：旧进程退出时不得删除新进程已接管的锁。
    if (readFileSync(handle.path, 'utf8').trim() === handle.owner) unlinkSync(handle.path);
  } catch {
    // 已不存在则忽略
  }
}

/** 判断某 pid 是否存活（跨平台：信号 0 探测） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 一个受管项目的能力接口（由调用方注入；生产实现调 Biao API，测试可注入纯函数） */
export interface SupervisedProjectOptions {
  planId: string;
  /** 项目是否已闭环（全部有效任务 done 且 PM Review accepted，或已取消） */
  isClosed: () => Promise<boolean>;
  /** 当前待 PM 处理事项（最小字段，不展开详情） */
  pendingItems?: () => Promise<Array<SupervisorItem>>;
  /** 下一个可领取任务（Worker 完成后立即调用以决定是否继续 claim） */
  nextClaimable?: () => Promise<{ task_id: string } | null>;
  /** 无可领任务时的等待原因分类：dependency/ownership/none */
  waitReason?: () => Promise<'dependency' | 'ownership' | 'none'>;
}

/** Supervisor 内部流转的最小事项（与 PM intake 的 IntakeItem 对齐） */
export interface SupervisorItem {
  kind: string;
  plan_id?: string;
  task_id?: string;
  question_id?: string;
  agent_id?: string;
  event_id?: string;
  timestamp?: number;
}

/** 项目稳定去重键（同一事项只提醒一次） */
function itemDedupeKey(it: SupervisorItem): string {
  return `${it.kind}:${it.event_id ?? it.task_id ?? it.agent_id ?? ''}`;
}

/** 单个受管项目：封装去重、闭环判定、claim/等待策略 */
export class SupervisedProject {
  readonly planId: string;
  private readonly opts: SupervisedProjectOptions;
  /** 已提醒过的事项去重集合（避免同一事项一轮内重复提醒） */
  private readonly reminded = new Set<string>();
  /** 已被 PM ack 的事项（静音，不再重复提醒，直到状态真正变化由 pendingItems 不再返回） */
  private readonly acked = new Set<string>();
  /** 是否已暂停（项目闭环后暂停提醒/等待） */
  paused = false;

  constructor(opts: SupervisedProjectOptions) {
    this.planId = opts.planId;
    this.opts = opts;
  }

  async isClosed(): Promise<boolean> {
    return this.opts.isClosed();
  }

  async pendingItems(): Promise<SupervisorItem[]> {
    return this.opts.pendingItems ? this.opts.pendingItems() : [];
  }

  get nextClaimable() {
    return this.opts.nextClaimable;
  }

  get waitReason() {
    return this.opts.waitReason;
  }

  /** 返回本轮新出现的事项（去重 + 已 ack 的静音），并记录到 reminded */
  async newItems(): Promise<SupervisorItem[]> {
    const all = await this.pendingItems();
    const fresh: SupervisorItem[] = [];
    for (const it of all) {
      const key = itemDedupeKey(it);
      // 已 ack：静音（不再响铃）；去重集合里已存在：本轮不重复
      if (this.acked.has(key)) continue;
      if (this.reminded.has(key)) continue;
      this.reminded.add(key);
      fresh.push(it);
    }
    return fresh;
  }

  /**
   * 门铃交付/处理失败时撤销本轮去重预留，让同一事项在下一个共享轮次重试。
   * 这里只操作本机去重键，不修改平台事件，更不会代替 PM ack。
   */
  retryItems(items: SupervisorItem[]): void {
    for (const item of items) {
      this.reminded.delete(itemDedupeKey(item));
    }
  }

  /** PM ack 后把对应事项加入静音集合（不再重复提醒）。
   *  真正的状态变化由 pendingItems 不再返回该事项来体现；Supervisor 不复制平台详情。 */
  markAcked(eventId: string): void {
    for (const key of [...this.reminded]) {
      if (key.endsWith(`:${eventId}`)) {
        this.acked.add(key);
      }
    }
  }
}

/** Supervisor 钩子：PM 门铃提醒、Worker 重新 claim 通知 */
export interface SupervisorHooks {
  /**
   * 发现新事项时对 PM 产生最小门铃提醒（不展开详情）。显式返回 false 表示本轮
   * 没有完成交付/处置，Supervisor 会撤销去重预留并在下一个共享轮次重试。
   */
  onPmReminder?: (planId: string, items: SupervisorItem[]) => Promise<boolean | void>;
  /** 依赖满足 / ownership 释放后通知 Worker 重新 claim */
  onNotifyClaim?: (planId: string) => Promise<void>;
}

export interface SupervisorConfig {
  biaoUrl: string;
  projects: SupervisedProject[];
  hooks?: SupervisorHooks;
  /** 正常轮询间隔（ms），低频默认 */
  pollIntervalMs?: number;
  /** 空闲最小退避（ms） */
  minBackoffMs?: number;
  /** 空闲最大退避（ms） */
  maxBackoffMs?: number;
  /** 一次性模式（跑一轮即停，供 cron/launchd 低频唤起） */
  once?: boolean;
  /** 优雅停止信号 */
  signal?: AbortSignal;
  /**
   * 生产运行时每轮刷新项目集合。保留原 projects 参数，让嵌入式/单元使用保持兼容；
   * 运行时提供该 hook 后，所有 plan 从同一份快照同步，避免每个 plan 各发一个请求。
   */
  refreshProjects?: () => Promise<SupervisedProject[]>;
  /** 每轮开始前刷新共享 transport 缓存（/plans、/intake、/events 各一次）。 */
  beforeRunOnce?: () => Promise<void>;
  /** 本轮活跃项目已确认后执行的轻量后处理；用于避免闭环时启动 Worker。 */
  afterRunOnce?: (hasActiveProjects: boolean) => Promise<void>;
  /**
   * 仅 transport 等可恢复故障的低频重试出口。普通业务/编程错误仍直接抛出，
   * 避免把配置错误静默藏成一个永久循环。
   */
  isRecoverableError?: (error: unknown) => boolean;
  onRecoverableError?: (error: unknown, retryMs: number) => Promise<void> | void;
}

/**
 * Supervisor 协调器：本机单实例，多项目共享一个轮询循环。
 *
 * Worker 正常流程固定为"完成当前任务 → 立即领取下一个"；只有没有可领取任务且
 * 原因是依赖未满足或 ownership 占用时，才进入共享轻量等待。依赖满足或 ownership
 * 释放后通知重新 claim。空闲时指数退避 + 随机抖动，绝不忙循环。
 */
export class Supervisor {
  readonly biaoUrl: string;
  private projects: SupervisedProject[];
  private readonly hooks: SupervisorHooks;
  private readonly pollIntervalMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly signal?: AbortSignal;
  private readonly refreshProjects?: () => Promise<SupervisedProject[]>;
  private readonly beforeRunOnce?: () => Promise<void>;
  private readonly afterRunOnce?: (hasActiveProjects: boolean) => Promise<void>;
  private readonly isRecoverableError?: (error: unknown) => boolean;
  private readonly onRecoverableError?: (error: unknown, retryMs: number) => Promise<void> | void;
  private wakeResolver?: () => void;
  private wakePending = false;
  /** 每个项目的当前退避（空闲时增长） */
  private readonly backoff = new Map<string, number>();

  constructor(cfg: SupervisorConfig) {
    this.biaoUrl = cfg.biaoUrl;
    this.projects = cfg.projects;
    this.hooks = cfg.hooks ?? {};
    this.pollIntervalMs = Math.max(1_000, cfg.pollIntervalMs ?? 60_000);
    this.minBackoffMs = Math.max(1_000, cfg.minBackoffMs ?? 5_000);
    this.maxBackoffMs = Math.max(this.minBackoffMs, cfg.maxBackoffMs ?? 300_000);
    this.signal = cfg.signal;
    this.refreshProjects = cfg.refreshProjects;
    this.beforeRunOnce = cfg.beforeRunOnce;
    this.afterRunOnce = cfg.afterRunOnce;
    this.isRecoverableError = cfg.isRecoverableError;
    this.onRecoverableError = cfg.onRecoverableError;
  }

  /**
   * 唤醒唯一等待循环。Worker 完成、远端 task 完成、Question 回答等都只调用这里，
   * 不为每个 slot 再启动轮询或 timer。
   */
  wake(): void {
    const resolve = this.wakeResolver;
    if (resolve) {
      this.wakeResolver = undefined;
      resolve();
    } else {
      this.wakePending = true;
    }
  }

  /** 当前仍活跃（未暂停/未移除）的项目 */
  activeProjects(): SupervisedProject[] {
    return this.projects.filter((p) => !p.paused);
  }

  /** 是否全部项目都已闭环 */
  allClosed(): boolean {
    return this.projects.every((p) => p.paused);
  }

  /** 标记某项目的某事件已被 PM ack（清除去重记录） */
  markAcked(planId: string, eventId: string): void {
    const p = this.projects.find((x) => x.planId === planId);
    p?.markAcked(eventId);
  }

  /** 跑一轮：检查各项目闭环状态、新事项提醒、Worker claim/等待决策。
   *  返回本轮是否还有活跃项目。 */
  async runOnce(): Promise<boolean> {
    if (this.signal?.aborted) return false;
    if (this.beforeRunOnce) await this.beforeRunOnce();
    if (this.refreshProjects) this.projects = await this.refreshProjects();
    const stillActive: SupervisedProject[] = [];
    for (const proj of this.projects) {
      if (proj.paused) continue;
      const closed = await proj.isClosed();
      if (closed) {
        // 项目闭环：暂停该项目（单项目闭环只移除该项目）
        proj.paused = true;
        continue;
      }
      stillActive.push(proj);

      // 1. PM 门铃：新事项去重后提醒
      const fresh = await proj.newItems();
      if (fresh.length > 0 && this.hooks.onPmReminder) {
        let handled = false;
        try {
          handled = (await this.hooks.onPmReminder(proj.planId, fresh)) !== false;
        } finally {
          if (!handled) proj.retryItems(fresh);
        }
        // 重置空闲退避（有事可做）
        this.backoff.set(proj.planId, this.pollIntervalMs);
      } else {
        // 空闲：退避增长
        const prev = this.backoff.get(proj.planId) ?? this.minBackoffMs;
        const jitter = Math.floor(prev * 0.2 * pseudoRandom());
        const next = Math.min(this.maxBackoffMs, prev * 2 + jitter);
        this.backoff.set(proj.planId, next);
      }

      // 2. Worker claim/等待决策：完成当前任务后立即领下一个
      if (proj.nextClaimable) {
        const next = await proj.nextClaimable();
        if (next) {
          // 有可领任务 → 通知 Worker 重新 claim（立即，不等待）
          if (this.hooks.onNotifyClaim) await this.hooks.onNotifyClaim(proj.planId);
          this.backoff.set(proj.planId, this.pollIntervalMs);
        } else if (proj.waitReason) {
          // 无可领任务：只在依赖未满足 / ownership 占用时进入共享轻量等待
          const reason = await proj.waitReason();
          if (reason === 'none') {
            // 既无任务、也无依赖/ownership 阻塞 → 项目可能即将闭环，短退避
            this.backoff.set(proj.planId, this.minBackoffMs);
          }
          // dependency/ownership → 保持当前退避（不忙循环，等被通知唤醒）
        }
      }
    }
    const hasActiveProjects = stillActive.length > 0;
    await this.afterRunOnce?.(hasActiveProjects);
    return hasActiveProjects;
  }

  /** 常驻运行：循环 runOnce 直到全部项目闭环或收到停止信号。
   *  全部受管项目闭环时自动干净退出（释放锁、停等待、不遗留子进程）。 */
  async run(): Promise<void> {
    // 失败重试与正常 PM 轮询分开：生产正常 idle 可保持 60s，短暂网络/服务错误
    // 从至多 5s 的低频退避开始，随后指数增长，既不退出也不形成忙循环。
    let retryMs = Math.max(1_000, Math.min(5_000, this.pollIntervalMs));
    while (!this.signal?.aborted) {
      let hasActive: boolean;
      try {
        hasActive = await this.runOnce();
        retryMs = Math.max(1_000, Math.min(5_000, this.pollIntervalMs));
      } catch (error) {
        if (!this.isRecoverableError?.(error)) throw error;
        await this.onRecoverableError?.(error, retryMs);
        await this.waitForWakeOrTimeout(retryMs);
        retryMs = Math.min(this.maxBackoffMs, retryMs * 2);
        continue;
      }
      if (!hasActive) {
        // 全部闭环 → 干净退出
        break;
      }
      // 等待到下一轮（取所有活跃项目的最小退避，避免忙循环）
      const minWait = Math.min(
        this.pollIntervalMs,
        ...this.activeProjects().map((p) => this.backoff.get(p.planId) ?? this.minBackoffMs),
      );
      await this.waitForWakeOrTimeout(Math.max(1_000, minWait));
    }
  }

  private async waitForWakeOrTimeout(ms: number): Promise<void> {
    if (this.signal?.aborted) return;
    if (this.wakePending) {
      this.wakePending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.wakeResolver = undefined;
        this.signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => done();
      const onWake = () => done();
      timer = setTimeout(done, ms);
      this.wakeResolver = onWake;
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 伪随机（0~1）：Supervisor 不依赖 Math.random 做安全决策，仅用于退避抖动；
 *  这里用单调计数近似，避免在某些禁用 Math.random 的运行时（如 workflow）报错。 */
let _jitterSeq = 0;
function pseudoRandom(): number {
  _jitterSeq = (_jitterSeq + 1) % 1000;
  return (_jitterSeq * 2654435761) % 1000 / 1000;
}

/* ======================== 生产 transport / 共享 worker runtime ======================== */

interface BiaoApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error?: { code?: string; message?: string };
}

export interface BiaoPlanSnapshot {
  plan_id: string;
  status: string;
  project_path: string;
  tasks?: Record<string, number>;
  reviews?: Record<string, number>;
}

export interface BiaoRuntimeEvent {
  event_id: string;
  type: string;
  task_id?: string;
  plan_id?: string;
  question_id?: string;
  agent_id?: string;
  consumer?: string;
  timestamp?: number;
}

export interface BiaoRuntimeReconciliation {
  reclaimed: string[];
  failed: string[];
  requeued: {
    waiting_file_release: string[];
    waiting_dependency: string[];
  };
}

export interface BiaoSupervisorTransportOptions {
  biaoUrl: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}

/** 仅标记可由常驻 Supervisor 低频恢复的 HTTP/网络故障。 */
class SupervisorTransportError extends Error {
  constructor(message: string, readonly recoverable: boolean) {
    super(message);
    this.name = 'SupervisorTransportError';
  }
}

/**
 * 生产 HTTP adapter。它不保留业务正文、不做 ack，只负责将三个被动端点
 * (/plans、/intake、/events) 读入同一 Supervisor 轮次。
 */
export class BiaoSupervisorTransport {
  readonly biaoUrl: string;
  private readonly apiToken?: string;
  private readonly fetchImpl: typeof fetch;
  /** undefined=尚未探测；false=旧服务只支持 since 毫秒参数。 */
  private streamCursorSupported: boolean | undefined;

  constructor(opts: BiaoSupervisorTransportOptions) {
    this.biaoUrl = opts.biaoUrl.replace(/\/+$/, '');
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async plans(): Promise<BiaoPlanSnapshot[]> {
    const response = await this.api<{ plans?: BiaoPlanSnapshot[] }>('/plans');
    return response.plans ?? [];
  }

  async intake(consumer: string, planIds?: string[]): Promise<{ cursor?: string; items: SupervisorItem[] }> {
    const scopedPlanIds = [...new Set((planIds ?? []).map((planId) => planId.trim()).filter(Boolean))];
    if (scopedPlanIds.length === 0) {
      const response = await this.api<{ cursor?: string; items?: SupervisorItem[] }>(`/intake?consumer=${encodeURIComponent(consumer)}`);
      return { cursor: response.cursor, items: response.items ?? [] };
    }

    // 显式受管 plan 不能先读取全局 intake 再在客户端丢弃，否则历史遗留计划仍会
    // 制造无关流量和噪声。每个受管 plan 使用服务端过滤，并在本轮共享合并结果。
    const responses = await Promise.all(scopedPlanIds.map((planId) => (
      this.api<{ cursor?: string; items?: SupervisorItem[] }>(
        `/intake?consumer=${encodeURIComponent(consumer)}&plan_id=${encodeURIComponent(planId)}`,
      )
    )));
    return {
      cursor: responses.at(-1)?.cursor,
      items: responses.flatMap((response) => response.items ?? []),
    };
  }

  /**
   * 低频、幂等运行态补偿。服务端只回收 stale lease/恢复被动 waiter；不会领取任务、
   * 处理 Question 或替 PM 决策。由唯一共享 Supervisor 每轮最多调用一次。
   */
  async reconcile(): Promise<BiaoRuntimeReconciliation> {
    return this.api<BiaoRuntimeReconciliation>('/reconcile', { method: 'POST' });
  }

  /**
   * 优先使用 Redis stream cursor (`after` / `next_cursor`)；旧服务会返回数组，
   * 则自动回退到 `since` 毫秒 + event_id 去重，不阻断已部署实例。
   */
  async events(after?: string, since?: number): Promise<{ events: BiaoRuntimeEvent[]; nextCursor?: string }> {
    const params = new URLSearchParams({ limit: '200' });
    if (this.streamCursorSupported !== false && after) params.set('after', after);
    else if (since && since > 0) params.set('since', String(since));
    const response = await this.api<BiaoRuntimeEvent[] | { events?: BiaoRuntimeEvent[]; next_cursor?: string; nextCursor?: string }>(`/events?${params.toString()}`);
    if (Array.isArray(response)) {
      this.streamCursorSupported = false;
      return { events: response };
    }
    this.streamCursorSupported = true;
    return {
      events: response.events ?? [],
      nextCursor: response.next_cursor ?? response.nextCursor,
    };
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.biaoUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new SupervisorTransportError(
        `Supervisor 请求 ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new SupervisorTransportError(
        `Supervisor 读取 ${path} 响应失败：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    let parsed: BiaoApiEnvelope<T> | undefined;
    try {
      parsed = raw ? JSON.parse(raw) as BiaoApiEnvelope<T> : undefined;
    } catch {
      // 下方报出一条不包含 token 的简短 transport 错误。
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new SupervisorTransportError(
        `Supervisor 请求 ${path} 失败：${parsed?.error?.code ?? `HTTP_${response.status}`} ${parsed?.error?.message ?? ''}`.trim(),
        retryable,
      );
    }
    if (!parsed?.ok || parsed.data === null || parsed.data === undefined) {
      throw new SupervisorTransportError(
        `Supervisor 请求 ${path} 失败：${parsed?.error?.code ?? `HTTP_${response.status}`} ${parsed?.error?.message ?? ''}`.trim(),
        false,
      );
    }
    return parsed.data;
  }
}

export interface SupervisorWorkerSlot {
  agentId: string;
  agentType: string;
  preferredProject?: string;
  capabilities?: string[];
  /** 可领取 task type；默认由 capabilities 与 Biao TaskType 交集派生。 */
  preferredTypes?: TaskType[];
  heartbeatMs?: number;
  execute: WorkerConfig['execute'];
}

interface ManagedWorkerSlot extends SupervisorWorkerSlot {
  client: BiaoClient;
  running: boolean;
}

export interface SharedWorkerCoordinatorOptions {
  biaoUrl: string;
  apiToken?: string;
  slots: SupervisorWorkerSlot[];
  /** 指定后，所有 slot 的服务端 claim 都只会领取这些 plan。 */
  planIds?: string[];
  signal?: AbortSignal;
  /** 唯一 Supervisor 等待循环的 doorbell；不把任何 event 正文传给 Worker。 */
  onWake?: () => void;
  onError?: (message: string) => void;
}

/**
 * 多 Agent slot 的共享调度器。
 *
 * - idle 时不启动 child agent、不让每个 slot 自己起 timer/claim poll；共享刷新轮次
 *   只为每个空闲 slot 发一次 presence heartbeat，避免服务端误判 stale；
 * - 一个被动唤醒只做一轮串行 claim，空队列按 preferred_project 分组后立即停止；
 * - task 完成/Question 创建后立即再次唤醒同一个调度器，尽量填满可用 slot；
 * - 正在跑的任务仍由原 worker lifecycle 续租和心跳，这是必要的活动成本。
 */
export class SharedWorkerCoordinator {
  private readonly slots: ManagedWorkerSlot[];
  private readonly preferredPlanIds?: string[];
  private readonly signal?: AbortSignal;
  private readonly onWake?: () => void;
  private readonly onError?: (message: string) => void;
  private started = false;
  private scheduling = false;
  private scheduleRequested = true;
  /** 连续相同的空闲心跳错误只提示一次；成功恢复后才允许再次提示。 */
  private readonly presenceErrors = new Map<string, string>();

  constructor(opts: SharedWorkerCoordinatorOptions) {
    this.signal = opts.signal;
    this.onWake = opts.onWake;
    this.onError = opts.onError;
    const planIds = [...new Set((opts.planIds ?? []).map((planId) => planId.trim()).filter(Boolean))];
    this.preferredPlanIds = planIds.length > 0 ? planIds : undefined;
    this.slots = opts.slots.map((slot) => ({
      ...slot,
      client: new BiaoClient(opts.biaoUrl, slot.agentId, opts.apiToken),
      running: false,
    }));
  }

  activeCount(): number {
    return this.slots.filter((slot) => slot.running).length;
  }

  /** 仅设置一个共享重试信号；所有 slot 都不会自行轮询。 */
  wake(): void {
    this.scheduleRequested = true;
    this.onWake?.();
  }

  /**
   * 复用 Supervisor 唯一低频刷新节拍维护空闲 slot 在线状态。
   * 这里没有 timer，也不发 claim；running slot 由 runWorkerLoop 负责携带 current_task
   * 的心跳和 lease 续租，避免重复流量。
   */
  async refreshIdlePresence(): Promise<void> {
    if (this.signal?.aborted) return;
    await this.ensureRegistered();
    for (const slot of this.slots) {
      if (this.signal?.aborted || slot.running) continue;
      try {
        const heartbeat = await slot.client.heartbeat();
        if (heartbeat?.ok === false) {
          throw new Error(`${heartbeat.error?.code ?? 'UNKNOWN'} ${heartbeat.error?.message ?? ''}`.trim());
        }
        this.presenceErrors.delete(slot.agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.presenceErrors.get(slot.agentId) !== message) {
          this.onError?.(`共享空闲心跳失败（${slot.agentId}）：${message}`);
          this.presenceErrors.set(slot.agentId, message);
        }
      }
    }
  }

  /**
   * 若有共享 doorbell 则尝试填充空闲 slot。没有 doorbell 时完全不发 /claim；
   * 因此资源随“状态变化”而非 slot 数量/时间线性增长。
   */
  async scheduleIfRequested(): Promise<void> {
    if (!this.scheduleRequested || this.scheduling || this.signal?.aborted) return;
    this.scheduleRequested = false;
    this.scheduling = true;
    try {
      await this.ensureRegistered();
      // 只合并“完全相同 claim 条件”的空结果。不能只按 project 合并：例如 review
      // slot 先看到空队列时，后面的 code slot 仍必须有机会领取同一项目的 code 任务。
      const unavailableClaimScopes = new Set<string>();
      for (const slot of this.slots) {
        if (this.signal?.aborted || slot.running) continue;
        const preferredTypes = normalizePreferredTypes(slot.preferredTypes ?? supportedTaskTypes(slot.capabilities));
        const key = `${slot.preferredProject ?? '*'}\u0000${preferredTypes.join(',')}\u0000${this.preferredPlanIds?.join(',') ?? '*'}`;
        // 一个完全相同的 claim 范围在同一轮已经明确空队列时，不再重复请求。
        if (unavailableClaimScopes.has(key)) continue;
        let claimed: { ok: boolean; data: ClaimedTask | null };
        try {
          claimed = await slot.client.claim({
            blocking: false,
            timeout_ms: 1,
            preferred_project: slot.preferredProject,
            preferred_types: preferredTypes,
            preferred_plan_ids: this.preferredPlanIds,
          });
        } catch (error) {
          this.onError?.(`共享 claim 失败（${slot.agentId}）：${error instanceof Error ? error.message : String(error)}`);
          unavailableClaimScopes.add(key);
          continue;
        }
        if (!claimed.ok || !claimed.data) {
          unavailableClaimScopes.add(key);
          continue;
        }
        this.startTask(slot, claimed.data);
      }
    } finally {
      this.scheduling = false;
      // 运行期间可能有其它 slot 完成或远端事件到来；只再跑一轮，避免递归/忙循环。
      if (this.scheduleRequested && !this.signal?.aborted) {
        queueMicrotask(() => { void this.scheduleIfRequested(); });
      }
    }
  }

  private async ensureRegistered(): Promise<void> {
    if (this.started) return;
    for (const slot of this.slots) {
      const registered = await slot.client.register(
        slot.agentType,
        slot.capabilities ?? ['code', 'review', 'research', 'docs', 'acceptance'],
        undefined,
        slot.preferredProject ? [slot.preferredProject] : undefined,
      );
      if (registered?.ok === false) {
        throw new Error(`共享 Worker 注册失败（${slot.agentId}）：${registered.error?.code ?? 'UNKNOWN'} ${registered.error?.message ?? ''}`.trim());
      }
    }
    this.started = true;
  }

  private startTask(slot: ManagedWorkerSlot, task: ClaimedTask): void {
    slot.running = true;
    const config: WorkerConfig = {
      agentId: slot.agentId,
      agentType: slot.agentType,
      preferredProject: slot.preferredProject,
      capabilities: slot.capabilities,
      heartbeatMs: slot.heartbeatMs,
      maxTasks: 1,
      exitOnIdle: true,
      preclaimedTask: task,
      skipRegistration: true,
      heartbeatWhenIdle: false,
      ownershipConflictMode: 'block',
      signal: this.signal,
      client: slot.client,
      execute: slot.execute,
    };
    void runWorkerLoop(config)
      .catch((error) => this.onError?.(`Worker ${slot.agentId} 执行 ${task.task_id} 异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        slot.running = false;
        // 正常 report / Question / failed 之后立刻再取下一项；没有任务时只留下共享等待。
        this.wake();
      });
  }
}

export interface BiaoSupervisorRuntimeOptions {
  biaoUrl: string;
  consumer?: string;
  /** 只管理指定 plan；未传则从 /plans 全量发现。 */
  planIds?: string[];
  apiToken?: string;
  workers?: SupervisorWorkerSlot[];
  pollIntervalMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /**
   * 仅传最小事项给 PM 的本地提醒出口。该回调不得 ack；显式返回 false 表示未完成
   * 交付/处置，运行时会在下一共享轮次重试同一事项。
   */
  onPmDoorbell?: (planId: string, items: SupervisorItem[]) => Promise<boolean | void>;
  onError?: (message: string) => void;
}

/**
 * 实际生产运行时：一个 transport 快照、一个 Supervisor 等待、可选一个共享 Worker 调度器。
 * 该类是 scripts/supervisor.mjs 的唯一业务实现；脚本只解析参数、拿本机锁并打印门铃。
 */
export class BiaoSupervisorRuntime {
  private readonly opts: Required<Pick<BiaoSupervisorRuntimeOptions, 'consumer'>> & BiaoSupervisorRuntimeOptions;
  private readonly transport: BiaoSupervisorTransport;
  private readonly plans = new Map<string, { snapshot: BiaoPlanSnapshot; project: SupervisedProject }>();
  private readonly intakeItems = new Map<string, SupervisorItem[]>();
  private readonly seenEvents = new Set<string>();
  private eventsSince = 0;
  private eventCursor = '0-0';
  /** /plans 投影中的 pending 数；仅在有新增可运行工作时唤醒一次共享 claim。 */
  private readonly planPendingCounts = new Map<string, number>();
  private readonly workers?: SharedWorkerCoordinator;
  private readonly supervisor: Supervisor;
  private questionsWakeCount = 0;
  /** 同一段连续 transport 故障只报一次，避免低频重试把终端刷屏。 */
  private lastTransportError?: string;

  constructor(opts: BiaoSupervisorRuntimeOptions) {
    this.opts = { ...opts, consumer: opts.consumer ?? 'pm' };
    this.transport = new BiaoSupervisorTransport({
      biaoUrl: opts.biaoUrl,
      apiToken: opts.apiToken,
      fetchImpl: opts.fetchImpl,
    });
    this.supervisor = new Supervisor({
      biaoUrl: opts.biaoUrl,
      projects: [],
      pollIntervalMs: opts.pollIntervalMs,
      // 生产默认严格按同一个共享间隔读取状态；不在 PM 无新状态时退回 5 秒探测。
      minBackoffMs: opts.pollIntervalMs ?? 60_000,
      maxBackoffMs: Math.max(opts.pollIntervalMs ?? 60_000, 300_000),
      signal: opts.signal,
      beforeRunOnce: async () => this.refresh(),
      // 先由共享 plan 快照判定是否仍有活跃受管项目，再允许 slot 注册/claim。
      // 这样 `--plans` 全部 completed/cancelled 时会直接退出，不遗留闲置 Worker。
      afterRunOnce: async (hasActiveProjects) => {
        if (!hasActiveProjects) return;
        await this.workers?.refreshIdlePresence();
        await this.workers?.scheduleIfRequested();
      },
      refreshProjects: async () => [...this.plans.values()].map((entry) => entry.project),
      isRecoverableError: (error) => error instanceof SupervisorTransportError && error.recoverable,
      onRecoverableError: async (error, retryMs) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastTransportError === message) return;
        this.lastTransportError = message;
        this.opts.onError?.(`${message}；将于约 ${Math.ceil(retryMs / 1000)} 秒后低频重试`);
      },
      hooks: {
        onPmReminder: async (planId, items) => {
          return this.opts.onPmDoorbell?.(planId, items);
        },
        onNotifyClaim: async () => {
          this.workers?.wake();
        },
      },
    });
    if (opts.workers && opts.workers.length > 0) {
      this.workers = new SharedWorkerCoordinator({
        biaoUrl: opts.biaoUrl,
        apiToken: opts.apiToken,
        slots: opts.workers,
        planIds: opts.planIds,
        signal: opts.signal,
        onWake: () => this.supervisor.wake(),
        onError: opts.onError,
      });
    }
  }

  /** 一次性运行：供 cron/launchd 或 CLI smoke 使用。 */
  async runOnce(): Promise<boolean> {
    return this.supervisor.runOnce();
  }

  /** 常驻运行：所有 plan 完成并验收后退出；下次启动会重新全量发现 reset/reject/new task。 */
  async run(): Promise<void> {
    await this.supervisor.run();
  }

  allClosed(): boolean {
    return this.supervisor.allClosed();
  }

  workerWakeCount(): number {
    return this.questionsWakeCount;
  }

  private async refresh(): Promise<void> {
    const [plans, intake, eventPage, reconciliation] = await Promise.all([
      this.transport.plans(),
      this.transport.intake(this.opts.consumer, this.opts.planIds),
      this.transport.events(this.eventCursor, this.eventsSince),
      this.transport.reconcile(),
    ]);
    // 一旦拿到完整快照，下一次相同错误应重新提示；连续相同错误只报一次。
    this.lastTransportError = undefined;
    const events = eventPage.events;
    if (eventPage.nextCursor) this.eventCursor = eventPage.nextCursor;
    const plansAddedRunnableWork = this.syncPlans(plans);
    this.intakeItems.clear();
    for (const item of intake.items) this.pushIntakeItem(item);

    let shouldWakeWorkers = false;
    for (const event of events) {
      if (!event.event_id || this.seenEvents.has(event.event_id)) continue;
      this.seenEvents.add(event.event_id);
      if (this.seenEvents.size > 2_000) {
        // 无需无限保留；cursor + 最近 id 足够覆盖同毫秒 replay。
        const oldest = this.seenEvents.values().next().value as string | undefined;
        if (oldest) this.seenEvents.delete(oldest);
      }
      this.eventsSince = Math.max(this.eventsSince, event.timestamp ?? 0);
      // PM 门铃只由 `/intake` 的当前未处理状态提供。绝不能从审计 stream 重建
      // `question_asked`，否则一个新 Supervisor 会把已处理的历史问题再次提醒给 PM。
      // Worker 永远不接收答案正文：这些事件只把共享 scheduler 从 wait 状态唤醒。
      if ([
        'question_answered',
        'task_reset',
        'task_completed',
        'pm_reviewed',
        // blocked task 只能在服务端明确回到 pending 后再 fresh claim；这些事件仅
        // 唤醒共享 coordinator，不把 Question/任务正文交给 Worker slot。
        'task_resumed',
        'task_ready',
        'dependency_ready',
        'ownership_released',
      ].includes(event.type)) {
        shouldWakeWorkers = true;
      }
    }
    if (plansAddedRunnableWork
      || reconciliation.reclaimed.length > 0
      || reconciliation.requeued.waiting_file_release.length > 0
      || reconciliation.requeued.waiting_dependency.length > 0) {
      shouldWakeWorkers = true;
    }
    if (shouldWakeWorkers) {
      this.questionsWakeCount++;
      this.workers?.wake();
    }
  }

  /**
   * 同步所有 plan，并只在 pending 工作新增时请求一次共享 claim。
   * 不能每轮都 wake：那会把“一个共享低频轮询”重新放大成持续 /claim 流量；
   * 也不能只依赖事件：新计划/老服务缺少 task_ready 事件时会饿死空闲 slot。
   */
  private syncPlans(snapshots: BiaoPlanSnapshot[]): boolean {
    const allowed = this.opts.planIds && this.opts.planIds.length > 0 ? new Set(this.opts.planIds) : undefined;
    const present = new Set<string>();
    let addedRunnableWork = false;
    for (const snapshot of snapshots) {
      if (allowed && !allowed.has(snapshot.plan_id)) continue;
      present.add(snapshot.plan_id);
      const pending = Number(snapshot.tasks?.pending ?? 0);
      const previousPending = this.planPendingCounts.get(snapshot.plan_id);
      if (!isPlanClosed(snapshot.status) && pending > 0 && (previousPending === undefined || pending > previousPending)) {
        addedRunnableWork = true;
      }
      this.planPendingCounts.set(snapshot.plan_id, Number.isFinite(pending) ? pending : 0);
      const existing = this.plans.get(snapshot.plan_id);
      if (existing) {
        existing.snapshot = snapshot;
        // 一个已完成项目若被 reset/reject/new task 重新激活，常驻 supervisor 立即恢复监控。
        existing.project.paused = isPlanClosed(snapshot.status);
        continue;
      }
      const project = new SupervisedProject({
        planId: snapshot.plan_id,
        isClosed: async () => isPlanClosed(this.plans.get(snapshot.plan_id)?.snapshot.status ?? 'active'),
        pendingItems: async () => this.intakeItems.get(snapshot.plan_id) ?? [],
      });
      project.paused = isPlanClosed(snapshot.status);
      this.plans.set(snapshot.plan_id, { snapshot, project });
    }
    // 已删除 plan 不应让常驻进程保留一个永远 active 的幽灵项目。
    for (const planId of this.plans.keys()) {
      if (!present.has(planId)) {
        this.plans.delete(planId);
        this.planPendingCounts.delete(planId);
      }
    }
    return addedRunnableWork;
  }

  private pushIntakeItem(item: SupervisorItem): void {
    if (!item.plan_id || !this.plans.has(item.plan_id)) return;
    const items = this.intakeItems.get(item.plan_id) ?? [];
    const key = itemDedupeKey(item);
    if (!items.some((existing) => itemDedupeKey(existing) === key)) items.push(item);
    this.intakeItems.set(item.plan_id, items);
  }
}

function isPlanClosed(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** Biao 的 capability 名与 TaskType 同名时才进入 claim 过滤，未知 capability 绝不扩大领取范围。 */
function supportedTaskTypes(capabilities?: string[]): TaskType[] {
  const supported = new Set<TaskType>(['code', 'review', 'research', 'docs', 'acceptance']);
  const selected = (capabilities ?? ['code', 'review', 'research', 'docs', 'acceptance'])
    .filter((capability): capability is TaskType => supported.has(capability as TaskType));
  return selected.length > 0 ? selected : ['code'];
}

/** claim 过滤条件的稳定序列化，供本轮空结果去重；不改变调用方声明的能力语义。 */
function normalizePreferredTypes(types: TaskType[]): TaskType[] {
  return [...new Set(types)].sort();
}
