/**
 * biao-node 节点时钟（Phase 3 · §10.3/§10.4，R1C-002）
 *
 * §10.4 固定规则：
 * - 服务端时间是 lease 真相；Node 使用每次响应返回的服务端时间与单调时钟
 *   计算本地截止时间，不直接比较两台机器的墙钟；
 * - 默认允许时钟偏差 30 秒、超过 60 秒进入 degraded、超过 120 秒
 *   quarantined；阈值可配置但不得由 Node 自行放宽。
 *
 * 实现说明：当前 V2 心跳响应不携带 server_now（server 侧接口缺口，见交付
 * 说明），因此骨架从每次 HTTP 响应的 Date 头（Node http 服务端自动设置）
 * 观测服务端时间；秒级粒度带来的误差对本阶段只影响 skew 的显示精度，
 * lease 截止时间一律走单调时钟换算，不受墙钟跳变影响。
 *
 * clock_skew_ms 约定：skew = 服务端时间 - 节点时间；正值 = 节点偏慢。
 * 心跳原样上报该值，是否 degraded/quarantined 由服务端裁决（§10.4）。
 */

/** §10.4 规定的时钟偏差阈值（毫秒）——配置只允许收紧，不允许放宽。 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;
export const CLOCK_SKEW_DEGRADED_MS = 60_000;
export const CLOCK_SKEW_QUARANTINE_MS = 120_000;

export type ClockSkewState = 'ok' | 'degraded' | 'quarantined';

export interface ClockObservation {
  /** 本轮观测到的 clock_skew_ms（服务端-节点；正=节点慢）。 */
  clock_skew_ms: number;
  /** 估算的往返时延（毫秒），用于 midpoint 校正。 */
  rtt_ms: number;
}

export interface NodeClockOptions {
  /**
   * 故障注入钩子（Phase 0b fault-injector 的子进程侧等价物）：
   * 仅测试通过 env BIAO_NODE_INJECTED_CLOCK_OFFSET_MS 设置，模拟节点时钟
   * 偏快（正）/偏慢（负）。生产不设置；不影响单调时钟。
   */
  injectedOffsetMs?: number;
  /** 偏差判定阈值：只能比 §10.4 默认更严格（更小），否则抛出。 */
  toleranceMs?: number;
  degradedMs?: number;
  quarantineMs?: number;
}

/**
 * 节点时钟：墙钟（可被故障注入偏移）+ 单调时钟 + 服务端时间估计。
 * 所有 lease 截止时间换算只依赖 mono()，服务端到期时间通过
 * applyServerObservation 维护的 serverOffset 折算成本地单调坐标。
 */
export class NodeClock {
  private readonly injectedOffsetMs: number;
  /** 服务端墙钟相对本节点墙钟的估计偏移：server_now ≈ wall() + serverOffsetMs。 */
  private serverOffsetMs = 0;
  private lastSkewMs: number | null = null;
  private lastRttMs: number | null = null;
  private readonly thresholds: { tolerance: number; degraded: number; quarantine: number };

  constructor(options: NodeClockOptions = {}) {
    this.injectedOffsetMs = Number.isFinite(options.injectedOffsetMs) ? (options.injectedOffsetMs as number) : 0;
    const tolerance = options.toleranceMs ?? CLOCK_SKEW_TOLERANCE_MS;
    const degraded = options.degradedMs ?? CLOCK_SKEW_DEGRADED_MS;
    const quarantine = options.quarantineMs ?? CLOCK_SKEW_QUARANTINE_MS;
    // §10.4：阈值可配置但不得由 Node 自行放宽——只接受更严格的值。
    if (tolerance > CLOCK_SKEW_TOLERANCE_MS || degraded > CLOCK_SKEW_DEGRADED_MS || quarantine > CLOCK_SKEW_QUARANTINE_MS) {
      throw new Error(
        `biao-node 时钟偏差阈值只能收紧不能放宽（§10.4 上限 30s/60s/120s），实际 ${tolerance}/${degraded}/${quarantine}`,
      );
    }
    if (!(tolerance <= degraded && degraded <= quarantine)) {
      throw new Error(`biao-node 时钟偏差阈值必须满足 tolerance ≤ degraded ≤ quarantine`);
    }
    this.thresholds = { tolerance, degraded, quarantine };
  }

  /** 节点墙钟（含故障注入偏移）。 */
  now(): number {
    return Date.now() + this.injectedOffsetMs;
  }

  /** 单调时钟（毫秒），不受墙钟调整/注入影响，用于全部截止时间。 */
  mono(): number {
    return performance.now();
  }

  /**
   * 观测一次服务端时间：以请求发出/收到之间的墙钟中点近似服务端打戳时刻
   * （Date 头秒级粒度），更新 serverOffset 并返回本轮 skew。
   */
  applyServerObservation(serverDateMs: number, sentAtWall: number, receivedAtWall: number): ClockObservation {
    if (!Number.isFinite(serverDateMs)) throw new Error('biao-node 收到非法的服务端时间观测');
    const midpoint = (sentAtWall + receivedAtWall) / 2;
    const skew = Math.round(serverDateMs - midpoint);
    this.lastSkewMs = skew;
    this.lastRttMs = Math.max(0, Math.round(receivedAtWall - sentAtWall));
    this.serverOffsetMs = skew;
    return { clock_skew_ms: skew, rtt_ms: this.lastRttMs };
  }

  /** 最近一次观测到的 skew（未观测过返回 0，心跳字段必须有值）。 */
  skewMs(): number {
    return this.lastSkewMs ?? 0;
  }

  rttMs(): number | null {
    return this.lastRttMs;
  }

  /** 服务端墙钟的当前估计值（用于把服务端 epoch 截止时间折算为本地单调坐标）。 */
  serverNow(): number {
    return this.now() + this.serverOffsetMs;
  }

  /** 把服务端 epoch 毫秒时间折算为本地单调坐标（lease 截止时间的唯一入口）。 */
  serverEpochToMono(serverEpochMs: number): number {
    // server_epoch - serverNow() ≈ 距现在的服务端时长；单调坐标同理平移。
    return this.mono() + (serverEpochMs - this.serverNow());
  }

  /** 按 §10.4 阈值判定当前偏差状态（本地观察态；服务端裁决为准）。 */
  skewState(): ClockSkewState {
    const abs = Math.abs(this.skewMs());
    if (abs > this.thresholds.quarantine) return 'quarantined';
    if (abs > this.thresholds.degraded) return 'degraded';
    return 'ok';
  }

  snapshot(): { clock_skew_ms: number; rtt_ms: number | null; server_offset_ms: number; state: ClockSkewState } {
    return {
      clock_skew_ms: this.skewMs(),
      rtt_ms: this.rttMs(),
      server_offset_ms: this.serverOffsetMs,
      state: this.skewState(),
    };
  }
}
