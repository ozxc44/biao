/**
 * biao-node 统一 lease watchdog（Phase 3 · §10.4，评审项 R1B-006）
 *
 * R1B-006：biao-node 统一拥有 lease watchdog，替代旧 runWorkerLoop
 * “renew 异常只打日志”的行为。本模块是全部 attempt 租约的唯一管理者：
 *
 * - 主动续租：在服务端租约到期前 lease_renew_margin_ms 开始续租，不等到
 *   失败才动作；
 * - 首次续租失败 → attempt 进入 lease_at_risk（本地观察态 + 审计事件，
 *   不是服务端 TaskAttemptV2.status，R2C-012）；
 * - 本地安全截止时间：到期前预留 lease_stop_window_ms 停止窗口，窗口
 *   起点（deadline - stop_window）仍无法确认租约时立即停止本地工作
 *   （Phase 3 占位 executor 只记录；Phase 4 对 Agent 进程树 TERM/KILL），
 *   并保存 recovery bundle 桩，不再把后续产出当作合法 Delivery；
 * - lease 丢失（服务端 409 / generation 变化 / 明确拒绝）→ 立即停止并
 *   上报，不走停止窗口；
 * - 所有截止时间用单调时钟坐标（NodeClock 维护服务端时间映射），
 *   不比较两台机器的墙钟。
 *
 * 续租通道当前为 server stub（/v2/attempts/:id/lease/renew →
 * NOT_IMPLEMENTED）：watchdog 按 fail-closed 处理——无法确认即 at_risk，
 * 到停止窗口即停。Phase 4 接通真实续租后行为不变。
 */

import type { TransportFailureKind } from './transport.js';

/** attempt 在 watchdog 眼中的状态（全部是本地观察态）。 */
export type WatchdogAttemptStatus = 'running' | 'lease_at_risk' | 'stopped' | 'lease_lost';

export type AttemptStopReason =
  | 'expiry_stop_window' // 到达停止窗口仍无法确认租约（§10.4 本地安全截止时间）
  | 'lease_lost' // 服务端明确拒绝/409/generation 变化
  | 'drain_cancel' // drain 超时后显式选择 cancel（§10.5）
  | 'fenced'; // session 被 fencing（重启/撤销）

export interface WatchdogAttempt {
  attempt_id: string;
  task_id: string;
  /** attempt_generation：lease 丢失判据之一。 */
  generation: number;
  /** 本地单调坐标下的租约截止时间。 */
  deadline_mono: number;
  status: WatchdogAttemptStatus;
  stop_reason?: AttemptStopReason;
  /** 最近一次续租尝试的单调时间；null=尚未续过。 */
  last_renew_at_mono: number | null;
  last_renew_failure: { kind: TransportFailureKind | string; code: string; message: string } | null;
  /**  adopted 的服务端 epoch（审计用）。 */
  adopted_at_wall: number;
}

export interface RenewOutcome {
  ok: boolean;
  /**
   * 续租成功时的新租约截止时间——由 daemon 侧先用 NodeClock 把服务端
   * epoch 折算成本地单调坐标后传入（§10.4：服务端时间是真相、本地只用
   * 单调时钟排期）；ok=false 时忽略。
   */
  newDeadlineMono?: number;
  /** 失败分类；ok=true 时忽略。 */
  failureKind?: TransportFailureKind | string;
  code?: string;
  message?: string;
}

export interface LeaseWatchdogCallbacks {
  /** 发起一次续租（daemon 把 HTTP 细节包在这里）。 */
  renew: (attempt: WatchdogAttempt) => Promise<RenewOutcome>;
  /** 停止本地工作（executor 的 stop 入口）。 */
  onStop: (attempt: WatchdogAttempt, reason: AttemptStopReason) => void | Promise<void>;
  /** 本地审计事件（写入 session ledger）。 */
  onEvent: (event: { attempt_id: string; type: 'lease_at_risk' | 'renew_ok' | 'renew_failed' | 'stopped' | 'lease_lost'; at_wall: number; detail?: Record<string, unknown> }) => void;
}

export interface LeaseWatchdogOptions {
  renewMarginMs: number;
  stopWindowMs: number;
  /** 两次续租尝试之间的最小间隔（避免打爆 server）。 */
  renewRetryIntervalMs?: number;
}

interface RegisterAttemptInput {
  attempt_id: string;
  task_id: string;
  generation: number;
  /** 已折算为本地单调坐标的截止时间。 */
  deadline_mono: number;
  adopted_at_wall: number;
}

export class LeaseWatchdog {
  private readonly attempts = new Map<string, WatchdogAttempt>();
  private readonly options: Required<LeaseWatchdogOptions>;
  private readonly callbacks: LeaseWatchdogCallbacks;
  private readonly now: () => number;
  private readonly wallNow: () => number;

  constructor(options: LeaseWatchdogOptions, callbacks: LeaseWatchdogCallbacks, clock: { mono: () => number; now: () => number } = { mono: () => performance.now(), now: () => Date.now() }) {
    if (options.stopWindowMs >= options.renewMarginMs) {
      throw new Error(`lease watchdog 参数非法：停止窗口（${options.stopWindowMs}ms）必须小于续租提前量（${options.renewMarginMs}ms）`);
    }
    this.options = { renewRetryIntervalMs: Math.max(50, Math.floor(options.stopWindowMs / 4)), ...options };
    this.callbacks = callbacks;
    this.now = clock.mono;
    this.wallNow = clock.now;
  }

  /** 登记一个新 attempt（adopt 时调用）；deadline 由调用方用 NodeClock 折算。 */
  register(input: RegisterAttemptInput): WatchdogAttempt {
    if (this.attempts.has(input.attempt_id)) {
      throw new Error(`lease watchdog 重复登记 attempt：${input.attempt_id}`);
    }
    const attempt: WatchdogAttempt = {
      attempt_id: input.attempt_id,
      task_id: input.task_id,
      generation: input.generation,
      deadline_mono: input.deadline_mono,
      status: 'running',
      last_renew_at_mono: null,
      last_renew_failure: null,
      adopted_at_wall: input.adopted_at_wall,
    };
    this.attempts.set(input.attempt_id, attempt);
    return attempt;
  }

  has(attemptId: string): boolean {
    return this.attempts.has(attemptId);
  }

  /** 从管理中移除（上报完成/清理时）。 */
  remove(attemptId: string): WatchdogAttempt | undefined {
    const attempt = this.attempts.get(attemptId);
    this.attempts.delete(attemptId);
    return attempt;
  }

  list(): WatchdogAttempt[] {
    return [...this.attempts.values()];
  }

  activeCount(): number {
    return this.list().filter((attempt) => attempt.status === 'running' || attempt.status === 'lease_at_risk').length;
  }

  runningAttemptIds(): string[] {
    return this.list().filter((attempt) => attempt.status === 'running' || attempt.status === 'lease_at_risk').map((attempt) => attempt.attempt_id);
  }

  private markStopped(attempt: WatchdogAttempt, reason: AttemptStopReason, type: 'stopped' | 'lease_lost'): void {
    attempt.status = type === 'lease_lost' ? 'lease_lost' : 'stopped';
    attempt.stop_reason = reason;
    this.callbacks.onEvent({ attempt_id: attempt.attempt_id, type, at_wall: this.wallNow(), detail: { reason } });
    void this.callbacks.onStop(attempt, reason);
  }

  /** drain 超时后的显式 cancel（§10.5：超时必须显式选择）。 */
  cancelAll(reason: Extract<AttemptStopReason, 'drain_cancel' | 'fenced'>): void {
    for (const attempt of this.list()) {
      if (attempt.status === 'running' || attempt.status === 'lease_at_risk') {
        this.markStopped(attempt, reason, 'stopped');
      }
    }
  }

  /**
   * 一次 watchdog 巡检：对每个活跃 attempt 依次判定
   * 停止窗口 → 续租 → 维持。由 daemon 主循环按 watchdog_tick_ms 驱动。
   * 返回本轮发生的续租次数（测试观测用）。
   */
  async tick(): Promise<number> {
    let renewCount = 0;
    const nowMono = this.now();
    for (const attempt of this.list()) {
      if (attempt.status !== 'running' && attempt.status !== 'lease_at_risk') continue;

      // 1) 本地安全截止时间：deadline - stop_window 仍持有租约即停止。
      //    已处 at_risk 的 attempt 也在同一条线下停止（不无限占用 slot）。
      if (nowMono >= attempt.deadline_mono - this.options.stopWindowMs) {
        this.markStopped(attempt, 'expiry_stop_window', 'stopped');
        continue;
      }

      // 2) 续租窗口：deadline - renew_margin 之前不动；进入窗口且距上次
      //    尝试超过 renewRetryInterval 才续（at_risk 后持续重试到停止线）。
      const renewDue = nowMono >= attempt.deadline_mono - this.options.renewMarginMs;
      const retryCoolDown = attempt.last_renew_at_mono === null || nowMono - attempt.last_renew_at_mono >= this.options.renewRetryIntervalMs;
      if (!renewDue || !retryCoolDown) continue;

      attempt.last_renew_at_mono = nowMono;
      renewCount += 1;
      let outcome: RenewOutcome;
      try {
        outcome = await this.callbacks.renew(attempt);
      } catch (error) {
        outcome = { ok: false, failureKind: 'NETWORK', code: 'RENEW_THROWN', message: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.ok) {
        attempt.status = 'running';
        attempt.last_renew_failure = null;
        if (typeof outcome.newDeadlineMono === 'number' && Number.isFinite(outcome.newDeadlineMono)) {
          attempt.deadline_mono = outcome.newDeadlineMono;
        }
        this.callbacks.onEvent({ attempt_id: attempt.attempt_id, type: 'renew_ok', at_wall: this.wallNow() });
        continue;
      }
      attempt.last_renew_failure = { kind: outcome.failureKind ?? 'UNKNOWN', code: outcome.code ?? '', message: outcome.message ?? '' };
      // lease 丢失：服务端明确说这代 attempt 不再属于本节点 → 立即停止并上报。
      if (outcome.failureKind === 'FENCED') {
        this.markStopped(attempt, 'lease_lost', 'lease_lost');
        continue;
      }
      // 首次失败进入 at_risk；后续失败保持（每轮都记事件，审计可数）。
      const wasRunning = attempt.status === 'running';
      attempt.status = 'lease_at_risk';
      this.callbacks.onEvent({
        attempt_id: attempt.attempt_id,
        type: 'renew_failed',
        at_wall: this.wallNow(),
        detail: { first: wasRunning, kind: attempt.last_renew_failure.kind, code: attempt.last_renew_failure.code },
      });
      if (wasRunning) {
        this.callbacks.onEvent({ attempt_id: attempt.attempt_id, type: 'lease_at_risk', at_wall: this.wallNow(), detail: { kind: attempt.last_renew_failure.kind } });
      }
    }
    return renewCount;
  }
}
