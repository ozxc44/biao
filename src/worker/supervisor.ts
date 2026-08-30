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
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { isPlanTerminalStatus } from '../plan/status.js';
import { stableHash } from '../redis/keys.js';
import { BiaoClient, runWorkerLoop, type WorkerConfig } from './base.js';
import type {
  ClaimedTask,
  ExecutionReceiptCreateRequest,
  ProjectAgentBinding,
  ProjectAgentWakeMode,
  PublicExecutionReceipt,
  TaskType,
} from '../types/index.js';

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

/**
 * 常驻周期自证：锁文件可能被系统清理（历史默认在 tmpdir，macOS 会定期清空）或
 * 人工误删。文件丢失时立即原子重建（wx），被并发接管则 EEXIST 落入读取判定；
 * 内容已是另一个存活 Supervisor 时返回 false——调用方必须优雅退出，避免双
 * 实例互翻注册 epoch（表现为 worker 的 AGENT_REGISTRATION_CHANGED）。
 */
export function assertLocalLockStillMine(handle: LocalLockHandle): boolean {
  if (!handle.acquired || !handle.owner) return true;
  let raw = '';
  try {
    raw = readFileSync(handle.path, 'utf8').trim();
  } catch {
    // 丢失：原子重建。被并发接管时 wx 得 EEXIST，落入下方读取判定。
    try {
      const fd = openSync(handle.path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${handle.owner}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      // 重建失败（如已被接管）：读取现状判定。
    }
    try {
      raw = readFileSync(handle.path, 'utf8').trim();
    } catch {
      return true;
    }
  }
  if (raw === handle.owner) return true;
  const holderPid = Number(raw.split(':')[0]);
  if (Number.isSafeInteger(holderPid) && holderPid > 0 && holderPid !== process.pid && isProcessAlive(holderPid)) {
    return false;
  }
  // 持有者已死或内容损坏：本实例是仍在运行的合法持有者，重建自己的锁，
  // 避免长时间处于无锁状态放行第二个实例。
  try {
    unlinkSync(handle.path);
  } catch {
    // 已不存在则直接进入重建。
  }
  try {
    const fd = openSync(handle.path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${handle.owner}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 极端竞态下未能重建；下一轮自证再试。
  }
  return true;
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

/** 只读探测本机 Supervisor 锁状态（biao-mcp supervisor_status 用；不获取、不清理锁） */
export function probeLocalSupervisorLock(
  biaoUrl: string,
  lockDir: string,
): { running: boolean; holder_pid: number | null; holder_alive: boolean; lock_path: string } {
  const path = lockFilePath(biaoUrl, lockDir);
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return { running: false, holder_pid: null, holder_alive: false, lock_path: path };
  }
  const holderPid = Number(raw.split(':')[0]);
  if (!Number.isSafeInteger(holderPid) || holderPid <= 0) {
    // 锁文件损坏/正在创建中：保守视为“状态未知但存在”，不声称 running。
    return { running: false, holder_pid: null, holder_alive: false, lock_path: path };
  }
  return { running: true, holder_pid: holderPid, holder_alive: isProcessAlive(holderPid), lock_path: path };
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
  /** 事项所属的 PM intake consumer；仅用于本机槽位路由，不含任何业务正文。 */
  consumer?: string;
  plan_id?: string;
  task_id?: string;
  question_id?: string;
  agent_id?: string;
  event_id?: string;
  timestamp?: number;
}

/** 项目稳定去重键（同一事项只提醒一次） */
function itemDedupeKey(it: SupervisorItem): string {
  // event_id 是投递尝试，不是逻辑事项身份；服务重发同一任务的新 event_id 时不能
  // 绕过本机冷却并再次唤醒模型。Question/Agent 状态分别使用自己的稳定身份。
  const subject = it.question_id ?? it.task_id ?? it.agent_id ?? it.plan_id ?? '';
  return `${it.consumer ?? ''}:${it.kind}:${subject}`;
}

/** 单个受管项目：封装去重、闭环判定、claim/等待策略 */
export class SupervisedProject {
  readonly planId: string;
  private readonly opts: SupervisedProjectOptions;
  /** 已提醒过的事项去重集合（避免同一事项一轮内重复提醒） */
  private readonly reminded = new Set<string>();
  /** 已被 PM ack 的事项（静音，不再重复提醒，直到状态真正变化由 pendingItems 不再返回） */
  private readonly acked = new Set<string>();
  /** event ack 仍按平台 event_id 输入；映射回稳定逻辑键后静音。 */
  private readonly eventKeys = new Map<string, string>();
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
      if (it.event_id) this.eventKeys.set(it.event_id, key);
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
    const key = this.eventKeys.get(eventId);
    if (key) this.acked.add(key);
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

/* ======================== ProjectAgentBinding wake path ======================== */

export interface ProjectAgentWakeCandidate {
  task_id: string;
  plan_id: string;
  project_path: string;
  capability: string;
  binding_id?: string;
  reservation_id?: string;
  reservation_expires_at?: number;
}

export interface ProjectAgentAdapterReceipt {
  protocol: 'biao.worker-wake/v1';
  ok: true;
  adapter_id: string;
  registration_id: string;
  harness_kind: string;
  wake_mode: ProjectAgentWakeMode;
  task_id?: string;
  reservation_id?: string;
  session_ref?: string;
  visible_url?: string;
}

export interface ProjectAgentWakeSlot {
  /** 兼容旧配置的精确 binding；省略时按 agentId 匹配项目动态创建的 binding。 */
  bindingId?: string;
  agentId: string;
  harnessKind: string;
  wakeMode: ProjectAgentWakeMode;
  adapterId: string;
  /** Receives only the credential-free doorbell; the harness registers and claims itself. */
  wake: (request: {
    protocol: 'biao.worker-wake/v1';
    binding: ProjectAgentBinding;
    selector: { project: string; capability: string; planIds: string[] };
    reservation?: { reservation_id: string; task_id: string; expires_at: number };
  }) => Promise<unknown>;
}

export interface ProjectAgentWakeDispatchResult {
  selected: number;
  succeeded: number;
  failed: number;
  skipped: number;
  unbound: number;
}

const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_SESSION_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const RECEIPT_CREDENTIAL_MARKERS = [
  'authorization', 'bearer', 'biao_api_token', 'cookie', 'access_token', 'api_token', 'token', 'password', 'secret',
];

function containsReceiptCredential(value: string): boolean {
  const normalized = value.toLowerCase();
  return RECEIPT_CREDENTIAL_MARKERS.some((marker) => normalized.includes(marker));
}

function safeAdapterVisibleUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value)
      || value.startsWith('//') || containsReceiptCredential(value)) return undefined;
  try {
    if (value.startsWith('/')) {
      const relative = new URL(value, 'https://biao.invalid');
      return relative.origin === 'https://biao.invalid' && !relative.search && !relative.hash
        ? relative.pathname
        : undefined;
    }
    const absolute = new URL(value);
    return ['http:', 'https:'].includes(absolute.protocol) && !absolute.username && !absolute.password
      && !absolute.search && !absolute.hash
      ? absolute.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeAdapterSessionRef(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && SAFE_SESSION_REF.test(value) && !containsReceiptCredential(value)
    ? value
    : undefined;
}

/** Deterministic policy selection. Manual bindings reserve a route but are never auto-woken. */
export function selectProjectAgentBinding(
  bindings: ProjectAgentBinding[],
  candidate: ProjectAgentWakeCandidate,
): ProjectAgentBinding | undefined {
  const priority = { automatic: 0, on_demand: 1, manual: 2 } as const;
  return bindings
    .filter((binding) => binding.project_scope === candidate.project_path
      && (!candidate.binding_id || binding.binding_id === candidate.binding_id)
      && binding.policy !== 'manual'
      && binding.capabilities.includes(candidate.capability))
    .sort((left, right) => priority[left.policy] - priority[right.policy]
      || left.binding_id.localeCompare(right.binding_id))[0];
}

/** Validate the adapter response before any of its optional fields reach durable storage. */
export function normalizeProjectAgentAdapterReceipt(
  value: unknown,
  binding: ProjectAgentBinding,
  slot: ProjectAgentWakeSlot,
  candidate?: ProjectAgentWakeCandidate,
): ProjectAgentAdapterReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if ((slot.bindingId !== undefined && slot.bindingId !== binding.binding_id) || slot.agentId !== binding.agent_id
      || slot.harnessKind !== binding.harness_kind || slot.wakeMode !== binding.wake_mode
      || receipt.protocol !== 'biao.worker-wake/v1' || receipt.ok !== true
      || receipt.adapter_id !== slot.adapterId || receipt.registration_id === undefined
      || receipt.harness_kind !== binding.harness_kind || receipt.wake_mode !== binding.wake_mode
      || typeof receipt.adapter_id !== 'string' || !SAFE_RECEIPT_ID.test(receipt.adapter_id)
      || typeof receipt.registration_id !== 'string' || !SAFE_RECEIPT_ID.test(receipt.registration_id)) return undefined;
  if (candidate?.reservation_id && (
    receipt.task_id !== candidate.task_id || receipt.reservation_id !== candidate.reservation_id
  )) return undefined;
  const sessionRef = safeAdapterSessionRef(receipt.session_ref);
  const visibleUrl = safeAdapterVisibleUrl(receipt.visible_url);
  if ((receipt.session_ref !== undefined && !sessionRef) || (receipt.visible_url !== undefined && !visibleUrl)) {
    return undefined;
  }
  return {
    protocol: 'biao.worker-wake/v1', ok: true,
    adapter_id: receipt.adapter_id,
    registration_id: receipt.registration_id,
    harness_kind: binding.harness_kind,
    wake_mode: binding.wake_mode,
    ...(candidate?.reservation_id ? {
      task_id: candidate.task_id,
      reservation_id: candidate.reservation_id,
    } : {}),
    ...(sessionRef ? { session_ref: sessionRef } : {}),
    ...(visibleUrl ? { visible_url: visibleUrl } : {}),
  };
}

export interface ProjectAgentWakeDispatcherOptions {
  slots: ProjectAgentWakeSlot[];
  appendReceipt: (
    projectScope: string,
    receipt: ExecutionReceiptCreateRequest,
  ) => Promise<{ ok: boolean; data?: PublicExecutionReceipt }>;
  attemptId?: () => string;
  now?: () => number;
  /** Compatibility injection used by boundary tests; the binding path intentionally never calls it. */
  fallbackExecute?: (...args: unknown[]) => unknown;
  adapterTimeoutMs?: number;
}

export function buildBackgroundExecutionReceipt(
  binding: ProjectAgentBinding,
  task: Pick<ClaimedTask, 'task_id'> & { reservation_id?: string },
  registrationId: string,
  adapterId: string,
  options: { attemptId?: () => string; now?: () => number } = {},
): ExecutionReceiptCreateRequest {
  return {
    attempt_id: task.reservation_id ?? options.attemptId?.() ?? `wake-${randomUUID()}`,
    task_id: task.task_id,
    binding_id: binding.binding_id,
    agent_id: binding.agent_id,
    registration_id: registrationId,
    harness_kind: binding.harness_kind,
    wake_mode: 'background_executor',
    adapter_id: adapterId,
    status: 'succeeded',
    started_at: options.now?.() ?? Date.now(),
  };
}

/**
 * Credential-free wake dispatcher. It never registers or claims for visible/external modes.
 * Durable successful receipts are the restart fence; missing adapters and invalid responses append
 * a sanitized failed receipt and cannot fall back to a background executor.
 */
export class ProjectAgentWakeDispatcher {
  private readonly slots: ProjectAgentWakeSlot[];
  private readonly appendReceipt: ProjectAgentWakeDispatcherOptions['appendReceipt'];
  private readonly attemptId: () => string;
  private readonly now: () => number;
  private readonly adapterTimeoutMs: number;

  constructor(options: ProjectAgentWakeDispatcherOptions) {
    this.slots = options.slots;
    this.appendReceipt = options.appendReceipt;
    this.attemptId = options.attemptId ?? (() => `wake-${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.adapterTimeoutMs = Math.max(1, options.adapterTimeoutMs ?? 30_000);
  }

  async dispatch(
    candidates: ProjectAgentWakeCandidate[],
    bindings: ProjectAgentBinding[],
    receipts: PublicExecutionReceipt[],
  ): Promise<ProjectAgentWakeDispatchResult> {
    const result: ProjectAgentWakeDispatchResult = {
      selected: 0, succeeded: 0, failed: 0, skipped: 0, unbound: 0,
    };
    for (const candidate of candidates) {
      const selected = selectProjectAgentBinding(bindings, candidate);
      if (!selected) {
        result.unbound++;
        continue;
      }
      result.selected++;
      if (receipts.some((receipt) => receipt.task_id === candidate.task_id
        && receipt.binding_id === selected.binding_id && receipt.status === 'succeeded'
        && (!candidate.reservation_id || receipt.attempt_id === candidate.reservation_id))) {
        result.skipped++;
        continue;
      }
      const slot = this.slots.find((entry) => (entry.bindingId === undefined || entry.bindingId === selected.binding_id)
        && entry.agentId === selected.agent_id && entry.harnessKind === selected.harness_kind
        && entry.wakeMode === selected.wake_mode);
      const attemptId = candidate.reservation_id ?? this.attemptId();
      const startedAt = this.now();
      let normalized: ProjectAgentAdapterReceipt | undefined;
      if (slot && selected.wake_mode !== 'background_executor') {
        try {
          const wakeRequest: Parameters<ProjectAgentWakeSlot['wake']>[0] = {
            protocol: 'biao.worker-wake/v1', binding: selected,
            selector: {
              project: candidate.project_path,
              capability: candidate.capability,
              planIds: [candidate.plan_id],
            },
            ...(candidate.reservation_id ? {
              reservation: {
                reservation_id: candidate.reservation_id,
                task_id: candidate.task_id,
                expires_at: candidate.reservation_expires_at ?? 0,
              },
            } : {}),
          };
          const response = await Promise.race([
            slot.wake(wakeRequest),
            new Promise<undefined>((resolve) => {
              const timer = setTimeout(() => resolve(undefined), this.adapterTimeoutMs);
              timer.unref?.();
            }),
          ]);
          normalized = normalizeProjectAgentAdapterReceipt(response, selected, slot, candidate);
        } catch {
          // Failure details may contain command paths or credentials; only the sanitized failed receipt persists.
        }
      }
      const receipt: ExecutionReceiptCreateRequest = normalized ? {
        attempt_id: attemptId, task_id: candidate.task_id, binding_id: selected.binding_id,
        agent_id: selected.agent_id, registration_id: normalized.registration_id,
        harness_kind: selected.harness_kind, wake_mode: selected.wake_mode,
        adapter_id: normalized.adapter_id, status: 'succeeded', started_at: startedAt,
        ...(normalized.session_ref ? { session_ref: normalized.session_ref } : {}),
        ...(normalized.visible_url ? { visible_url: normalized.visible_url } : {}),
      } : {
        attempt_id: attemptId, task_id: candidate.task_id, binding_id: selected.binding_id,
        agent_id: selected.agent_id, registration_id: `wake-failed-${randomUUID()}`,
        harness_kind: selected.harness_kind, wake_mode: selected.wake_mode,
        adapter_id: null, status: 'failed', started_at: startedAt,
      };
      const appended = await this.appendReceipt(candidate.project_path, receipt);
      if (normalized && appended.ok && (!appended.data || appended.data.status === 'succeeded')) result.succeeded++;
      else result.failed++;
    }
    return result;
  }
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

/** tick 聚合端点响应结构 */
export interface SupervisorTickResult {
  plans: BiaoPlanSnapshot[];
  intakes: Array<{ consumer: string; cursor: string; counts: Record<string, number>; items: SupervisorItem[] }>;
  events: { events: BiaoRuntimeEvent[]; next_cursor: string };
  reconciliation: BiaoRuntimeReconciliation;
  bindings?: Array<{ project_scope: string; bindings: ProjectAgentBinding[] }>;
  receipts?: Array<{ project_scope: string; receipts: PublicExecutionReceipt[] }>;
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

  async pendingTasks(planId: string): Promise<ProjectAgentWakeCandidate[]> {
    const response = await this.api<{ tasks?: Array<{
      task_id: string; plan_id: string; project_path: string; type: string;
    }> }>(`/tasks?plan_id=${encodeURIComponent(planId)}&status=pending&limit=1000`);
    return (response.tasks ?? []).map((task) => ({
      task_id: task.task_id,
      plan_id: task.plan_id,
      project_path: task.project_path,
      capability: task.type,
    }));
  }

  async reserveProjectAgentTask(
    projectScope: string,
    bindingId: string,
    preferredPlanIds: string[],
  ): Promise<ProjectAgentWakeCandidate | null> {
    const response = await this.api<{ reservation?: {
      reservation_id: string;
      task_id: string;
      plan_id: string;
      project_path: string;
      capability: string;
      binding_id: string;
      expires_at: number;
    } | null }>('/project/agent-reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_scope: projectScope,
        binding_id: bindingId,
        preferred_plan_ids: preferredPlanIds,
      }),
    });
    const reservation = response.reservation;
    return reservation ? {
      task_id: reservation.task_id,
      plan_id: reservation.plan_id,
      project_path: reservation.project_path,
      capability: reservation.capability,
      binding_id: reservation.binding_id,
      reservation_id: reservation.reservation_id,
      reservation_expires_at: reservation.expires_at,
    } : null;
  }

  async projectAgentBindings(projectScope: string): Promise<ProjectAgentBinding[]> {
    const response = await this.api<{ bindings?: ProjectAgentBinding[] }>(
      `/project/agent-bindings?project_scope=${encodeURIComponent(projectScope)}`,
    );
    return response.bindings ?? [];
  }

  async executionReceipts(projectScope: string): Promise<PublicExecutionReceipt[]> {
    const response = await this.api<{ receipts?: PublicExecutionReceipt[] }>(
      `/execution-receipts?project_scope=${encodeURIComponent(projectScope)}`,
    );
    return response.receipts ?? [];
  }

  async appendExecutionReceipt(
    projectScope: string,
    receipt: ExecutionReceiptCreateRequest,
  ): Promise<{ ok: boolean; data?: PublicExecutionReceipt }> {
    try {
      const data = await this.api<PublicExecutionReceipt>('/execution-receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_scope: projectScope, ...receipt }),
      });
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
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
   * 聚合 tick 端点：一轮快照合成一次往返。
   * 返回 null 表示服务端不支持（404/405/字段缺失），调用方应回落到逐端点路径。
   */
  async tick(params: {
    consumers: string[];
    eventsAfter?: string;
    bindingAware?: boolean;
    planIds?: string[];
  }): Promise<SupervisorTickResult | null> {
    const query = new URLSearchParams();
    if (params.consumers.length > 0) query.set('consumers', params.consumers.join(','));
    if (params.eventsAfter) query.set('events_after', params.eventsAfter);
    if (params.bindingAware) query.set('binding_aware', '1');
    if (params.planIds && params.planIds.length > 0) query.set('plan_ids', params.planIds.join(','));
    const path = `/supervisor/tick?${query.toString()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.biaoUrl}${path}`, {
        headers: {
          Accept: 'application/json',
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        },
      });
    } catch {
      return null;
    }
    // 404/405 → 服务端不支持 tick，回落
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) return null;
    let parsed: BiaoApiEnvelope<SupervisorTickResult> | undefined;
    try {
      const raw = await response.text();
      parsed = raw ? JSON.parse(raw) as BiaoApiEnvelope<SupervisorTickResult> : undefined;
    } catch {
      return null;
    }
    if (!parsed?.ok || !parsed.data) return null;
    // 字段完整性校验：缺少核心字段则视为不兼容版本
    if (!Array.isArray(parsed.data.plans) || !Array.isArray(parsed.data.intakes)
        || !parsed.data.events || !parsed.data.reconciliation) return null;
    return parsed.data;
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
  /** 跨机 slot 的本地工作区：任务 project_path 本地不存在时在此执行。 */
  localWorkspace?: string;
  capabilities?: string[];
  /** 可领取 task type；默认由 capabilities 与 Biao TaskType 交集派生。 */
  preferredTypes?: TaskType[];
  heartbeatMs?: number;
  execute: WorkerConfig['execute'];
  /** Optional durable binding for a built-in/background executor. */
  bindingId?: string;
  harnessKind?: string;
  wakeMode?: 'background_executor';
  adapterId?: string;
}

interface ManagedWorkerSlot extends SupervisorWorkerSlot {
  client: BiaoClient;
  /** 仅表示当前 Coordinator 生命周期已经成功注册过该 client epoch。 */
  registered: boolean;
  running: boolean;
  settled?: Promise<void>;
}

export interface SharedWorkerCoordinatorOptions {
  biaoUrl: string;
  apiToken?: string;
  slots: SupervisorWorkerSlot[];
  /** 指定后，所有 slot 的服务端 claim 都只会领取这些 plan。 */
  planIds?: string[];
  /**
   * 同时执行的真实任务数上限；未传时不限制（每个 slot 本身一次只持有一个任务）。
   * 用于 slot 数多于机器并发能力时限制同时启动的执行器数量。
   */
  maxConcurrentTasks?: number;
  signal?: AbortSignal;
  /** 唯一 Supervisor 等待循环的 doorbell；不把任何 event 正文传给 Worker。 */
  onWake?: () => void;
  onError?: (message: string) => void;
  appendReceipt?: (
    projectScope: string,
    receipt: ExecutionReceiptCreateRequest,
  ) => Promise<{ ok: boolean; data?: PublicExecutionReceipt }>;
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
  /** 复活 plans_terminal 软停机时为 slot 重建全新 Agent 生命周期所需。 */
  private readonly biaoUrl: string;
  private readonly apiToken?: string;
  /** 同时执行的真实任务数上限；undefined = 不限制。 */
  private readonly maxConcurrentTasks?: number;
  private started = false;
  private scheduling = false;
  /** 当前 claim 调度轮次的完成信号；offlineAll 必须等待它发现并启动的任务。 */
  private scheduleSettled?: Promise<void>;
  private scheduleRequested = true;
  private offline = false;
  /** 所有并发关停调用共享同一个副作用过程，避免重复登记 offline。 */
  private offlining?: Promise<void>;
  private shutdownReason?: 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit';
  /** 连续相同的空闲心跳错误只提示一次；成功恢复后才允许再次提示。 */
  private readonly presenceErrors = new Map<string, string>();
  private readonly appendReceipt?: SharedWorkerCoordinatorOptions['appendReceipt'];
  private projectAgentBindings: ProjectAgentBinding[] = [];
  private eligibleBindingIds?: Set<string>;
  private eligibleBindingCapabilities?: Map<string, Set<string>>;
  private eligibleReservations = new Map<string, ProjectAgentWakeCandidate>();

  constructor(opts: SharedWorkerCoordinatorOptions) {
    this.signal = opts.signal;
    this.onWake = opts.onWake;
    this.onError = opts.onError;
    this.appendReceipt = opts.appendReceipt;
    this.biaoUrl = opts.biaoUrl;
    this.apiToken = opts.apiToken;
    this.maxConcurrentTasks = opts.maxConcurrentTasks && opts.maxConcurrentTasks > 0
      ? opts.maxConcurrentTasks
      : undefined;
    const planIds = [...new Set((opts.planIds ?? []).map((planId) => planId.trim()).filter(Boolean))];
    this.preferredPlanIds = planIds.length > 0 ? planIds : undefined;
    this.slots = opts.slots.map((slot) => ({
      ...slot,
      client: new BiaoClient(opts.biaoUrl, slot.agentId, opts.apiToken),
      registered: false,
      running: false,
      settled: undefined,
    }));
  }

  activeCount(): number {
    return this.slots.filter((slot) => slot.running).length;
  }

  updateProjectAgentBindings(
    bindings: ProjectAgentBinding[],
    eligibleBindingIds?: Iterable<string>,
    eligibleBindingCapabilities?: Map<string, Set<string>>,
    eligibleReservations?: Iterable<ProjectAgentWakeCandidate>,
  ): void {
    this.projectAgentBindings = [...bindings];
    this.eligibleBindingIds = eligibleBindingIds ? new Set(eligibleBindingIds) : undefined;
    this.eligibleBindingCapabilities = eligibleBindingCapabilities;
    this.eligibleReservations = new Map(
      [...(eligibleReservations ?? [])]
        .filter((candidate) => candidate.binding_id)
        .map((candidate) => [candidate.binding_id!, candidate]),
    );
  }

  /**
   * Supervisor 是共享 slot 注册的生命周期所有者，因此由它统一显式离线。
   * 服务端保留 registered_at/last_heartbeat/last_task 审计，不再等待 watchdog 猜测退出。
   */
  async offlineAll(reason: 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit'): Promise<void> {
    this.scheduleRequested = false;
    if (this.offline) return;
    if (this.offlining) {
      await this.offlining;
      return;
    }
    this.shutdownReason = reason;
    const offlining = this.finishOfflineAll(reason);
    this.offlining = offlining;
    try {
      await offlining;
    } finally {
      if (this.offlining === offlining) this.offlining = undefined;
    }
  }

  private async finishOfflineAll(reason: 'plans_terminal' | 'supervisor_signal' | 'supervisor_exit'): Promise<void> {
    // AbortSignal 已传到真实 Agent CLI；等进程树 TERM/KILL 后发出 close，且
    // runWorkerLoop 确认没有 report 业务终态，才可以把 slot 统一登记 offline。
    // 同时等待已在途的 claim 调度；它返回的 task 会先进入 slot.settled，再由下一轮
    // 快照纳入等待。这使 offline 成为停止完成证据，不是“已发送 abort”的乐观投影。
    for (;;) {
      const scheduleSettled = this.scheduleSettled;
      const activeSettlements = this.slots.flatMap((slot) => slot.settled ? [slot.settled] : []);
      const pending = scheduleSettled ? [scheduleSettled, ...activeSettlements] : activeSettlements;
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    if (this.offline) return;
    await Promise.all(this.slots.filter((slot) => slot.registered).map(async (slot) => {
      try {
        const response = await slot.client.offline(reason);
        if (response?.ok === false) {
          this.onError?.(`共享 Worker 离线登记失败（${slot.agentId}）：${response.error?.code ?? 'UNKNOWN'}`);
        }
      } catch (error) {
        this.onError?.(`共享 Worker 离线登记异常（${slot.agentId}）：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        slot.registered = false;
      }
    }));
    this.started = false;
    this.offline = true;
  }

  /**
   * plans_terminal 是“队列暂时清空”的软停机，不是进程终止：留守（stay-resident）
   * 或重入的 Supervisor 在后续轮次发现新的活跃项目时，slot 以全新 Agent 生命周期
   * （新 registration epoch）重新注册并继续调度。旧 epoch 已显式 offline，服务端
   * 按设计不复活它，因此这里必须换新 client。supervisor_signal/exit 是硬停机，
   * 永不复活；offlining 进行中也不允许复活。
   */
  reviveAfterPlansTerminal(): void {
    if (this.offlining || !this.offline) return;
    if (this.shutdownReason !== 'plans_terminal') return;
    if (this.signal?.aborted) return;
    // 复活必须原子：任何一个 slot 仍有在途任务都不动，等下一轮再试。
    if (this.slots.some((slot) => slot.running || slot.settled)) return;
    this.shutdownReason = undefined;
    this.offline = false;
    for (const slot of this.slots) {
      slot.client = new BiaoClient(this.biaoUrl, slot.agentId, this.apiToken);
      slot.registered = false;
    }
    // 软停机期间 wake() 被抑制，新工作的调度请求可能已丢失；复活即补发一次，
    // 让当轮 refreshIdlePresence/scheduleIfRequested 直接领取新任务。
    this.scheduleRequested = true;
  }

  /** 仅设置一个共享重试信号；所有 slot 都不会自行轮询。 */
  wake(): void {
    if (this.shutdownReason || this.offlining || this.offline) return;
    this.scheduleRequested = true;
    this.onWake?.();
  }

  /**
   * 复用 Supervisor 唯一低频刷新节拍维护空闲 slot 在线状态。
   * 这里没有 timer，也不发 claim；running slot 由 runWorkerLoop 负责携带 current_task
   * 的心跳和 lease 续租，避免重复流量。
   *
   * 注意：注册失败（如同名独立进程导致服务端拒绝本 epoch）会抛给调用方；本方法
   * 永不因单次注册/心跳失败而把 coordinator 标记为永久 offline——下一次共享轮次
   * 会用全新 registration epoch 重试，这是运行时对同名 agent 冲突保持鲁棒的关键。
   */
  async refreshIdlePresence(): Promise<void> {
    if (this.signal?.aborted || this.shutdownReason || this.offlining || this.offline) return;
    try {
      await this.ensureRegistered();
    } catch (error) {
      // 注册失败只影响本 slot 数据面；已注册成功的其它 slot 仍照常心跳。
      // 抛出前不吞掉错误，但也不让一个 slot 的失败中断其余 slot 的 presence。
      const first = error instanceof Error ? error.message : String(error);
      for (const slot of this.slots) {
        if (!slot.registered) continue;
        try {
          const heartbeat = await slot.client.heartbeat();
          if (heartbeat?.ok === false) {
            throw new Error(`${heartbeat.error?.code ?? 'UNKNOWN'} ${heartbeat.error?.message ?? ''}`.trim());
          }
          this.presenceErrors.delete(slot.agentId);
        } catch (heartbeatError) {
          const message = heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError);
          if (this.presenceErrors.get(slot.agentId) !== message) {
            this.onError?.(`共享空闲心跳失败（${slot.agentId}）：${message}`);
            this.presenceErrors.set(slot.agentId, message);
          }
        }
      }
      throw error instanceof Error ? error : new Error(first);
    }
    for (const slot of this.slots) {
      if (this.signal?.aborted || this.shutdownReason || this.offlining || this.offline || slot.running) continue;
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
    if (
      !this.scheduleRequested
      || this.scheduling
      || this.signal?.aborted
      || this.shutdownReason
      || this.offlining
      || this.offline
    ) return;
    this.scheduleRequested = false;
    this.scheduling = true;
    let notifyScheduleSettled!: () => void;
    const scheduleSettled = new Promise<void>((resolve) => { notifyScheduleSettled = resolve; });
    this.scheduleSettled = scheduleSettled;
    try {
      await this.ensureRegistered();
      // 只合并“完全相同 claim 条件”的空结果。不能只按 project 合并：例如 review
      // slot 先看到空队列时，后面的 code slot 仍必须有机会领取同一项目的 code 任务。
      const unavailableClaimScopes = new Set<string>();
      for (const slot of this.slots) {
        // 已发出的 claim 必须处理其返回值，避免把服务端已领取的任务静默丢弃；
        // 但关停开始后不再向后续 slot 发起新 claim。
        if (this.signal?.aborted || this.shutdownReason || this.offlining || this.offline) break;
        // 并发闸：同时执行的任务达到上限时本轮不再发起新 claim；在跑任务 settle
        // 后会再次 wake，下一轮自然补位，不会饿死后续 slot。
        if (this.maxConcurrentTasks !== undefined && this.activeCount() >= this.maxConcurrentTasks) break;
        if (slot.running) continue;
        let preferredTypes = normalizePreferredTypes(slot.preferredTypes ?? supportedTaskTypes(slot.capabilities));
        let backgroundBinding: ProjectAgentBinding | undefined;
        let bindingReservation: ProjectAgentWakeCandidate | undefined;
        if (slot.bindingId) {
          if (this.eligibleBindingIds && !this.eligibleBindingIds.has(slot.bindingId)) continue;
          backgroundBinding = this.projectAgentBindings.find((binding) => binding.binding_id === slot.bindingId
            && binding.project_scope === slot.preferredProject
            && binding.agent_id === slot.agentId
            && binding.harness_kind === (slot.harnessKind ?? slot.agentType)
            && binding.wake_mode === 'background_executor'
            && binding.policy !== 'manual'
            && preferredTypes.some((type) => binding.capabilities.includes(type)));
          // A configured binding slot cannot silently become an unbound legacy worker.
          if (!backgroundBinding) continue;
          bindingReservation = this.eligibleReservations.get(slot.bindingId);
          if (!bindingReservation || bindingReservation.binding_id !== slot.bindingId) continue;
          const selectedCapabilities = this.eligibleBindingCapabilities?.get(slot.bindingId);
          preferredTypes = preferredTypes.filter((type) => backgroundBinding!.capabilities.includes(type)
            && (!selectedCapabilities || selectedCapabilities.has(type))
            && type === bindingReservation!.capability);
          if (preferredTypes.length === 0) continue;
        }
        // assignee 可按 agent_id 或 agent_type 定向。即使 project/type/plan 完全相同，
        // Codex 的空 claim 也不能证明 Kimi/custom 槽位没有自己的定向任务。
        const key = `${slot.agentId}\u0000${slot.agentType}\u0000${slot.preferredProject ?? '*'}\u0000${preferredTypes.join(',')}\u0000${this.preferredPlanIds?.join(',') ?? '*'}`;
        // 一个完全相同的 claim 范围在同一轮已经明确空队列时，不再重复请求。
        if (unavailableClaimScopes.has(key)) continue;
        let claimed: { ok: boolean; data: ClaimedTask | null };
        try {
          // 共享轮次内的 claim 是“本轮已知可能有活”的即时探测，绝不 blocking：
          // scheduleIfRequested 串行驱动全部 slot 与 PM 门铃，一次最长 60s 的长轮询
          // 会冻结整个共享轮次。空闲拾取延迟由 Supervisor 轮次 + SSE 事件唤醒
          // （BIAO_SUPERVISOR_EVENT_WAKE=1）负责；常驻 worker loop 的空闲等待走
          // runWorkerLoop 的 blocking 长轮询（blockingClaimTimeoutMs）。
          claimed = await slot.client.claim({
            blocking: false,
            timeout_ms: 1,
            preferred_project: slot.preferredProject,
            preferred_types: preferredTypes,
            preferred_plan_ids: this.preferredPlanIds,
            ...(bindingReservation?.reservation_id ? { reservation_id: bindingReservation.reservation_id } : {}),
          } as Parameters<typeof slot.client.claim>[0] & { reservation_id?: string });
        } catch (error) {
          this.onError?.(`共享 claim 失败（${slot.agentId}）：${error instanceof Error ? error.message : String(error)}`);
          unavailableClaimScopes.add(key);
          continue;
        }
        if (!claimed.ok || !claimed.data) {
          unavailableClaimScopes.add(key);
          continue;
        }
        if (slot.bindingId) this.eligibleReservations.delete(slot.bindingId);
        await this.startTask(slot, claimed.data, backgroundBinding);
      }
    } finally {
      this.scheduling = false;
      if (this.scheduleSettled === scheduleSettled) this.scheduleSettled = undefined;
      notifyScheduleSettled();
      // 运行期间可能有其它 slot 完成或远端事件到来；只再跑一轮，避免递归/忙循环。
      if (
        this.scheduleRequested
        && !this.signal?.aborted
        && !this.shutdownReason
        && !this.offlining
        && !this.offline
      ) {
        queueMicrotask(() => { void this.scheduleIfRequested(); });
      }
    }
  }

  private async ensureRegistered(): Promise<void> {
    if (this.started || this.shutdownReason || this.offlining || this.offline) return;
    for (const slot of this.slots) {
      if (this.shutdownReason || this.offlining || this.offline) return;
      const registered = await slot.client.register(
        slot.agentType,
        slot.capabilities ?? ['code', 'review', 'research', 'docs', 'acceptance'],
        undefined,
        slot.preferredProject ? [slot.preferredProject] : undefined,
      );
      if (registered?.ok === false) {
        // 中途失败不能让 started 保持已置位：同一进程后续轮次要能用新的
        // registration epoch 重试注册（例如外部重启后服务端报
        // AGENT_REGISTRATION_CHANGED 的场景），否则该 slot 永久失去数据面。
        throw new Error(`共享 Worker 注册失败（${slot.agentId}）：${registered.error?.code ?? 'UNKNOWN'} ${registered.error?.message ?? ''}`.trim());
      }
      slot.registered = true;
    }
    if (this.shutdownReason || this.offlining || this.offline) return;
    this.started = true;
  }

  private async startTask(
    slot: ManagedWorkerSlot,
    task: ClaimedTask,
    binding?: ProjectAgentBinding,
  ): Promise<void> {
    if (binding) {
      const receipt = buildBackgroundExecutionReceipt(
        binding,
        task,
        slot.client.getRegistrationId(),
        slot.adapterId ?? `builtin-${slot.agentType}-v1`,
      );
      const appended = await this.appendReceipt?.(task.project_path, receipt);
      if (!appended?.ok || (appended.data && appended.data.status !== 'succeeded')) {
        this.onError?.(`后台执行回执写入失败（${slot.agentId}/${task.task_id}），已 fail closed`);
        try {
          await slot.client.blockTask(task.task_id, task.claim_token, 'waiting_dependency');
        } catch {
          // Lease expiry remains the final recovery fence; never execute without a durable receipt.
        }
        return;
      }
    }
    slot.running = true;
    const config: WorkerConfig = {
      agentId: slot.agentId,
      agentType: slot.agentType,
      preferredProject: slot.preferredProject,
      localWorkspace: slot.localWorkspace,
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
    const settled = runWorkerLoop(config)
      .catch((error) => this.onError?.(`Worker ${slot.agentId} 执行 ${task.task_id} 异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        slot.running = false;
        slot.settled = undefined;
        if (this.shutdownReason) {
          // offlineAll 正在等待这个 promise；由它在所有 slot settle 后统一登记。
          return;
        }
        // 正常 report / Question / failed 之后立刻再取下一项；没有任务时只留下共享等待。
        this.wake();
      });
    slot.settled = settled;
  }
}

export interface BiaoSupervisorRuntimeOptions {
  biaoUrl: string;
  consumer?: string;
  /**
   * 一个 Supervisor 共享轮次需要读取的 PM 队列。未传时保持单 consumer 兼容；
   * 传入后每个 consumer 各读一次 /intake，但 /plans、/events、/reconcile 仍只读一次。
   */
  pmConsumers?: string[];
  /** 只管理指定 plan；未传则从 /plans 全量发现。 */
  planIds?: string[];
  apiToken?: string;
  /** Worker data-plane bearer; never reused by the PM/Supervisor transport. */
  workerApiToken?: string;
  /** 同时执行的真实任务数上限；未传时不限制。来自 --max-concurrent-tasks / BIAO_MAX_CONCURRENT_TASKS。 */
  maxConcurrentTasks?: number;
  workers?: SupervisorWorkerSlot[];
  /** Harness-owned visible/external adapters; they never enter SharedWorkerCoordinator claim lifecycle. */
  projectAgentWakeSlots?: ProjectAgentWakeSlot[];
  pollIntervalMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /**
   * 订阅中央 GET /events/stream（SSE）：任何事件到达立即唤醒共享轮次，替代
   * 纯定时等待。断流自动指数退避重连；轮询定时器始终保留作为兜底，SSE 只会
   * 提前唤醒，绝不会延长轮次间隔。默认关闭（BIAO_SUPERVISOR_EVENT_WAKE=1 开启）。
   */
  eventWake?: boolean;
  /** SSE 事件唤醒时同步通知调用方（用于打断留守模式的定时睡眠）。 */
  onExternalWake?: () => void;
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
  private readonly pmConsumers: string[];
  private readonly plans = new Map<string, { snapshot: BiaoPlanSnapshot; project: SupervisedProject }>();
  private readonly intakeItems = new Map<string, SupervisorItem[]>();
  private readonly seenEvents = new Set<string>();
  private eventsSince = 0;
  private eventCursor = '0-0';
  /** /plans 投影中的 pending 数；仅在有新增可运行工作时唤醒一次共享 claim。 */
  private readonly planPendingCounts = new Map<string, number>();
  private readonly workers?: SharedWorkerCoordinator;
  private readonly bindingDispatcher?: ProjectAgentWakeDispatcher;
  private bindingCandidates: ProjectAgentWakeCandidate[] = [];
  private projectAgentBindings: ProjectAgentBinding[] = [];
  private executionReceipts: PublicExecutionReceipt[] = [];
  private readonly bindingAware: boolean;
  private readonly localBindingIds: Set<string>;
  /**
   * 本机唤醒 slot 的身份三元组（agent_id + harness_kind + wake_mode）。
   * binding_id 预填仍是首选匹配；未预填时，运行时用身份匹配把动态创建的项目
   * 连接（如控制台一键加入）也纳入 reservation 门控，与 dispatcher 的动态
   * 匹配规则保持一致——否则只在 dispatcher 层支持动态 binding 永远不会被触发。
   */
  private readonly localWakeSlotIdentities: Array<{
    bindingId?: string;
    agentId: string;
    harnessKind: string;
    wakeMode: ProjectAgentWakeMode;
  }>;
  private readonly supervisor: Supervisor;
  private readonly eventWakeEnabled: boolean;
  private readonly onExternalWake?: () => void;
  private readonly fetchImpl: typeof fetch;
  private eventStreamController?: AbortController;
  private lastEventStreamError?: string;
  private questionsWakeCount = 0;
  /** 同一段连续 transport 故障只报一次，避免低频重试把终端刷屏。 */
  private lastTransportError?: string;
  /**
   * tick 聚合传输状态：undefined=尚未探测；true=已确认可用；false=回落到逐端点。
   * BIAO_SUPERVISOR_TRANSPORT=legacy 强制回落（调试用）。
   */
  private tickSupported: boolean | undefined;
  private readonly tickDisabled: boolean;

  constructor(opts: BiaoSupervisorRuntimeOptions) {
    this.opts = { ...opts, consumer: opts.consumer ?? 'pm' };
    this.tickDisabled = process.env.BIAO_SUPERVISOR_TRANSPORT === 'legacy';
    const configuredConsumers = (opts.pmConsumers ?? []).map((value) => value.trim()).filter(Boolean);
    this.pmConsumers = configuredConsumers.length > 0
      ? [...new Set(configuredConsumers)]
      : [this.opts.consumer];
    this.transport = new BiaoSupervisorTransport({
      biaoUrl: opts.biaoUrl,
      apiToken: opts.apiToken,
      fetchImpl: opts.fetchImpl,
    });
    this.bindingAware = Boolean(opts.projectAgentWakeSlots?.length
      || opts.workers?.some((slot) => Boolean(slot.bindingId)));
    this.localBindingIds = new Set([
      ...(opts.projectAgentWakeSlots ?? []).map((slot) => slot.bindingId),
      ...(opts.workers ?? []).flatMap((slot) => slot.bindingId ? [slot.bindingId] : []),
    ].filter((bindingId): bindingId is string => Boolean(bindingId)));
    this.localWakeSlotIdentities = (opts.projectAgentWakeSlots ?? []).map((slot) => ({
      bindingId: slot.bindingId,
      agentId: slot.agentId,
      harnessKind: slot.harnessKind,
      wakeMode: slot.wakeMode,
    }));
    if (opts.projectAgentWakeSlots && opts.projectAgentWakeSlots.length > 0) {
      this.bindingDispatcher = new ProjectAgentWakeDispatcher({
        slots: opts.projectAgentWakeSlots,
        appendReceipt: (projectScope, receipt) => this.transport.appendExecutionReceipt(projectScope, receipt),
      });
    }
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
        if (!hasActiveProjects) {
          await this.workers?.offlineAll('plans_terminal');
          return;
        }
        // 上一轮曾因全部闭环软停机（留守或重入场景）：发现新活跃项目时先复活
        // slot 生命周期，再恢复 presence 与调度，避免协调器永久下线。
        this.workers?.reviveAfterPlansTerminal();
        // 两条分发 lane 必须互不影响：共享 Worker（background_executor）的注册/
        // presence 失败只属于该 slot 的数据面；harness 唤醒（visible/external）
        // lane 绝不能因此被跳过。真实环境里本机同名 agent 冲突会让
        // ensureRegistered 每轮都抛 AGENT_REGISTRATION_CHANGED（restart 后
        // registration_id 换新、started 永不复位），若让该异常继续向上抛，
        // dispatch/scheduleIfRequested 会被静默吞掉（run() 把它当可恢复错误，
        // 只低频重试同一轮，终端只有零星的离线/心跳报错），表现为零分发。
        try {
          await this.workers?.refreshIdlePresence();
        } catch (error) {
          // 注册/心跳属于 coordinator 数据面故障：报错后继续 harness lane，
          // 下一共享轮次照常重试注册，不抑制 Project Agent 唤醒分发。
          this.opts.onError?.(`共享 Worker presence 失败（不影响 Project Agent 唤醒分发）：${error instanceof Error ? error.message : String(error)}`);
        }
        const selectedRoutes = this.bindingCandidates.map((candidate) => ({
          candidate,
          binding: selectProjectAgentBinding(this.projectAgentBindings, candidate),
        }));
        const harnessCandidates = selectedRoutes
          .filter((route) => route.binding && route.binding.wake_mode !== 'background_executor')
          .map((route) => route.candidate);
        const backgroundBindingIds = selectedRoutes
          .filter((route) => route.binding?.wake_mode === 'background_executor')
          .map((route) => route.binding!.binding_id);
        const backgroundCapabilities = new Map<string, Set<string>>();
        for (const route of selectedRoutes) {
          if (route.binding?.wake_mode !== 'background_executor') continue;
          const capabilities = backgroundCapabilities.get(route.binding.binding_id) ?? new Set<string>();
          capabilities.add(route.candidate.capability);
          backgroundCapabilities.set(route.binding.binding_id, capabilities);
        }
        this.workers?.updateProjectAgentBindings(
          this.projectAgentBindings,
          backgroundBindingIds,
          backgroundCapabilities,
          selectedRoutes
            .filter((route) => route.binding?.wake_mode === 'background_executor')
            .map((route) => route.candidate),
        );
        const harnessBindings = this.projectAgentBindings.filter((binding) => binding.wake_mode !== 'background_executor');
        const dispatch = this.bindingDispatcher
          ? await this.bindingDispatcher.dispatch(harnessCandidates, harnessBindings, this.executionReceipts)
          : undefined;
        // Reservation fencing is per task, so visible/external failure cannot globally suppress an
        // unrelated ready background lane. Each coordinator slot independently redeems its own id.
        void dispatch;
        try {
          await this.workers?.scheduleIfRequested();
        } catch (error) {
          // 与 presence 同理：claim 调度失败属于 coordinator 数据面，不能把下一轮
          // 之前的 harness 唤醒成果（上方 dispatch 已写入的回执）或后续轮次一起拖垮。
          this.opts.onError?.(`共享 Worker 调度失败（不影响 Project Agent 唤醒分发）：${error instanceof Error ? error.message : String(error)}`);
        }
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
        // Programmatic callers predating scoped credentials keep working; the
        // production launcher always supplies workerApiToken explicitly.
        apiToken: opts.workerApiToken ?? opts.apiToken,
        slots: opts.workers,
        planIds: opts.planIds,
        maxConcurrentTasks: opts.maxConcurrentTasks,
        signal: opts.signal,
        onWake: () => this.supervisor.wake(),
        onError: opts.onError,
        appendReceipt: (projectScope, receipt) => this.transport.appendExecutionReceipt(projectScope, receipt),
      });
    }
    this.eventWakeEnabled = Boolean(opts.eventWake);
    this.onExternalWake = opts.onExternalWake;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (this.eventWakeEnabled) this.startEventStream();
  }

  /** 一次性运行：供 cron/launchd 或 CLI smoke 使用。 */
  async runOnce(): Promise<boolean> {
    return this.supervisor.runOnce();
  }

  /** 常驻运行：所有 plan 完成并验收后退出；下次启动会重新全量发现 reset/reject/new task。 */
  async run(): Promise<void> {
    try {
      await this.supervisor.run();
    } finally {
      await this.workers?.offlineAll(
        this.opts.signal?.aborted
          ? 'supervisor_signal'
          : this.supervisor.allClosed()
            ? 'plans_terminal'
            : 'supervisor_exit',
      );
    }
  }

  allClosed(): boolean {
    return this.supervisor.allClosed();
  }

  workerWakeCount(): number {
    return this.questionsWakeCount;
  }

  /** 立即停止 SSE 事件唤醒（进程收口/测试清理用；轮询定时器不受影响）。 */
  stopEventStream(): void {
    this.eventStreamController?.abort();
    this.eventStreamController = undefined;
  }

  private startEventStream(): void {
    if (this.eventStreamController) return;
    const controller = new AbortController();
    this.eventStreamController = controller;
    const stop = () => controller.abort();
    this.opts.signal?.addEventListener('abort', stop, { once: true });
    void this.runEventStreamLoop(controller).finally(() => {
      this.opts.signal?.removeEventListener('abort', stop);
      if (this.eventStreamController === controller) this.eventStreamController = undefined;
    });
  }

  /**
   * SSE 订阅循环：事件到达只做唤醒，不解析业务正文（正文仍由共享轮次从
   * /intake 等被动接口读取）。断流按 1s→2s→…→60s 指数退避重连；任何失败都
   * 只影响"提前唤醒"这一增强路径，绝不影响轮询兜底。
   */
  private async runEventStreamLoop(controller: AbortController): Promise<void> {
    let retryMs = 1_000;
    while (!controller.signal.aborted) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (this.opts.apiToken) headers.Authorization = `Bearer ${this.opts.apiToken}`;
        const response = await this.fetchImpl(`${this.opts.biaoUrl.replace(/\/$/, '')}/events/stream`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new SupervisorTransportError(
          `事件流订阅失败：HTTP ${response.status}`,
          response.status >= 500 || response.status === 429,
        );
        retryMs = 1_000;
        this.lastEventStreamError = undefined;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) this.handleEventStreamPayload(line.slice('data: '.length));
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        if (this.lastEventStreamError !== message) {
          this.lastEventStreamError = message;
          this.opts.onError?.(`SSE 事件唤醒中断（轮询兜底不受影响）：${message}`);
        }
      }
      if (controller.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, retryMs);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      retryMs = Math.min(60_000, retryMs * 2);
    }
  }

  /** SSE data 帧：合法 JSON 即唤醒一次（burst 由 wakePending 合并）。 */
  private handleEventStreamPayload(raw: string): void {
    try {
      JSON.parse(raw);
    } catch {
      return;
    }
    this.supervisor.wake();
    this.onExternalWake?.();
  }

  private async refresh(): Promise<void> {
    // tick 聚合路径：首轮探测，成功则后续复用；404/字段缺失时静默回落。
    if (!this.tickDisabled && this.tickSupported !== false) {
      const tickResult = await this.transport.tick({
        consumers: this.pmConsumers,
        eventsAfter: this.eventCursor !== '0-0' ? this.eventCursor : undefined,
        bindingAware: this.bindingAware,
        planIds: this.opts.planIds,
      });
      if (tickResult) {
        this.tickSupported = true;
        this.processTickResult(tickResult);
        return;
      }
      // tick 不可用（404/字段缺失/网络错误），回落到逐端点
      this.tickSupported = false;
    }

    // 逐端点回落路径（与旧版行为完全一致）
    const [plans, intakes, eventPage, reconciliation] = await Promise.all([
      this.transport.plans(),
      Promise.all(this.pmConsumers.map(async (consumer) => ({
        consumer,
        intake: await this.transport.intake(consumer, this.opts.planIds),
      }))),
      this.transport.events(this.eventCursor, this.eventsSince),
      this.transport.reconcile(),
    ]);
    // 一旦拿到完整快照，下一次相同错误应重新提示；连续相同错误只报一次。
    this.lastTransportError = undefined;
    const events = eventPage.events;
    if (eventPage.nextCursor) this.eventCursor = eventPage.nextCursor;
    const plansAddedRunnableWork = this.syncPlans(plans);
    if (this.bindingAware) await this.refreshProjectAgentSnapshot(plans);
    this.intakeItems.clear();
    for (const { consumer, intake } of intakes) {
      for (const item of intake.items) this.pushIntakeItem({ ...item, consumer });
    }

    this.processEventsAndReconciliation(events, reconciliation, plansAddedRunnableWork);
  }

  /** 处理 tick 聚合结果（与逐端点路径语义一致） */
  private processTickResult(tick: SupervisorTickResult): void {
    this.lastTransportError = undefined;
    if (tick.events.next_cursor) this.eventCursor = tick.events.next_cursor;
    const plansAddedRunnableWork = this.syncPlans(tick.plans);

    // binding-aware 快照来自 tick 响应
    if (this.bindingAware && tick.bindings) {
      this.projectAgentBindings = tick.bindings.flatMap((group) => group.bindings);
      this.executionReceipts = tick.receipts?.flatMap((group) => group.receipts) ?? [];
    }

    this.intakeItems.clear();
    for (const intake of tick.intakes) {
      for (const item of intake.items) this.pushIntakeItem({ ...item, consumer: intake.consumer });
    }

    this.processEventsAndReconciliation(tick.events.events, tick.reconciliation, plansAddedRunnableWork);
  }

  /** 共享的事件处理与 Worker 唤醒逻辑（tick 和逐端点路径复用） */
  private processEventsAndReconciliation(
    events: BiaoRuntimeEvent[],
    reconciliation: BiaoRuntimeReconciliation,
    plansAddedRunnableWork: boolean,
  ): void {
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
        // fresh acceptance/reverify 已进入普通 pending/claim 队列；它是 Worker 门铃，
        // 不能等下一次 plan 轮询才发现，否则 PM continue 后会出现最长一个监视频率
        // 的空窗。
        'acceptance_ready',
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

  private async refreshProjectAgentSnapshot(plans: BiaoPlanSnapshot[]): Promise<void> {
    const allowed = this.opts.planIds && this.opts.planIds.length > 0 ? new Set(this.opts.planIds) : undefined;
    const activePlans = plans.filter((plan) => !isPlanTerminalStatus(plan.status) && (!allowed || allowed.has(plan.plan_id)));
    const projects = [...new Set(activePlans.map((plan) => plan.project_path).filter(Boolean))];
    const [bindingLists, receiptLists] = await Promise.all([
      Promise.all(projects.map((project) => this.transport.projectAgentBindings(project))),
      Promise.all(projects.map((project) => this.transport.executionReceipts(project))),
    ]);
    this.projectAgentBindings = bindingLists.flat();
    this.executionReceipts = receiptLists.flat();
    const localBindings = this.projectAgentBindings.filter((binding) =>
      binding.policy !== 'manual' && (
        this.localBindingIds.has(binding.binding_id)
        || this.localWakeSlotIdentities.some((slot) =>
          (slot.bindingId === undefined || slot.bindingId === binding.binding_id)
          && slot.agentId === binding.agent_id
          && slot.harnessKind === binding.harness_kind
          && slot.wakeMode === binding.wake_mode)
      ));
    try {
      const reservations = await Promise.all(localBindings.map((binding) => this.transport.reserveProjectAgentTask(
        binding.project_scope,
        binding.binding_id,
        activePlans
          .filter((plan) => plan.project_path === binding.project_scope)
          .map((plan) => plan.plan_id),
      )));
      this.bindingCandidates = reservations.filter((candidate): candidate is ProjectAgentWakeCandidate => Boolean(candidate));
    } catch (error) {
      // A real HTTP/API failure is fail-closed. The narrow raw-error fallback keeps the pre-reservation
      // in-process adapter fixture usable while mixed-version local tests upgrade in one checkout.
      if (error instanceof SupervisorTransportError
          && !error.message.includes('unexpected /project/agent-reservations')) throw error;
      const legacyTaskLists = await Promise.all(activePlans.map((plan) => this.transport.pendingTasks(plan.plan_id)));
      this.bindingCandidates = legacyTaskLists.flat();
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
      if (!isPlanTerminalStatus(snapshot.status) && pending > 0 && (previousPending === undefined || pending > previousPending)) {
        addedRunnableWork = true;
      }
      this.planPendingCounts.set(snapshot.plan_id, Number.isFinite(pending) ? pending : 0);
      const existing = this.plans.get(snapshot.plan_id);
      if (existing) {
        existing.snapshot = snapshot;
        // 一个已完成项目若被 reset/reject/new task 重新激活，常驻 supervisor 立即恢复监控。
        existing.project.paused = isPlanTerminalStatus(snapshot.status);
        continue;
      }
      const project = new SupervisedProject({
        planId: snapshot.plan_id,
        isClosed: async () => isPlanTerminalStatus(this.plans.get(snapshot.plan_id)?.snapshot.status ?? 'active'),
        pendingItems: async () => this.intakeItems.get(snapshot.plan_id) ?? [],
      });
      project.paused = isPlanTerminalStatus(snapshot.status);
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
