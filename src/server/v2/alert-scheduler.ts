/**
 * V2 告警调度器（§22.4-18 接线）
 *
 * 将 metrics.ts 的 runAlertEvaluation 从「存在但未接线」变为定期驱动：
 * setInterval 周期调用「告警求值 + 超 SLO 升级」，unref 不阻塞进程退出。
 *
 * 参数：
 * - intervalMs：轮询间隔，缺省读 env BIAO_V2_ALERT_INTERVAL_MS（默认 60000ms）；
 * - now：假时钟注入（测试）；
 * - runAlertCycle：单轮周期函数注入（测试可替换，避免真实定时）；
 * - onCycle：每轮完成回调（测试断言 / 可观测）；
 * - onError：单轮异常回调（默认 console.error，不中断后续轮次）。
 */

import type { SqliteStore } from '../../db/sqlite-store.js';
import { createMetricsService } from './metrics.js';

export const DEFAULT_ALERT_INTERVAL_MS = 60_000;
export const ALERT_INTERVAL_ENV = 'BIAO_V2_ALERT_INTERVAL_MS';

export interface AlertCycleResult {
  triggered: number;
  incidents_created: number;
  escalated: number;
}

export interface AlertSchedulerOptions {
  store: SqliteStore;
  /** 轮询间隔（毫秒）；缺省读 env BIAO_V2_ALERT_INTERVAL_MS（默认 60000）。 */
  intervalMs?: number;
  /** 假时钟注入；未注入使用 Date.now()。 */
  now?: () => number;
  /** 单轮周期函数注入（测试）；未注入为 runAlertEvaluation + escalateOverdueIncidents。 */
  runAlertCycle?: () => AlertCycleResult;
  /** 每轮完成回调（测试断言 / 日志）。 */
  onCycle?: (result: AlertCycleResult) => void;
  /** 单轮异常回调（默认 console.error）。 */
  onError?: (err: unknown) => void;
}

function readIntervalMsFromEnv(): number {
  const raw = Number(process.env[ALERT_INTERVAL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ALERT_INTERVAL_MS;
}

export function createAlertScheduler(options: AlertSchedulerOptions) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? readIntervalMsFromEnv();
  const metrics = createMetricsService({ store, now });
  const onError = options.onError ?? ((err: unknown) => console.error('[alert-scheduler] 周期失败:', err));

  let timer: ReturnType<typeof setInterval> | null = null;
  let inCycle = false;

  function defaultRunAlertCycle(): AlertCycleResult {
    const evaluation = metrics.runAlertEvaluation();
    const escalated = metrics.escalateOverdueIncidents();
    return { ...evaluation, escalated };
  }

  const runCycle = options.runAlertCycle ?? defaultRunAlertCycle;

  /** 单轮告警周期：去重开单 + 复发计数 + 超 SLO 升级。 */
  function runOnce(): AlertCycleResult {
    if (inCycle) return { triggered: 0, incidents_created: 0, escalated: 0 };
    inCycle = true;
    try {
      const result = runCycle();
      options.onCycle?.(result);
      return result;
    } catch (err) {
      onError(err);
      return { triggered: 0, incidents_created: 0, escalated: 0 };
    } finally {
      inCycle = false;
    }
  }

  /** 启动定时驱动（unref：不阻止进程退出）。重复 start 幂等。 */
  function start(): void {
    if (timer) return;
    timer = setInterval(runOnce, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 停止定时驱动。 */
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
    intervalMs,
  };
}
