/**
 * 故障注入器 — Phase 0b
 *
 * 1. 可控"网络分区"（拦截 fetch 的 fault-routes fetchImpl）
 * 2. 进程中断（kill 子进程句柄）
 * 3. 时钟偏差（注入 offset 的 now()）
 */

// ──────────────── 时钟偏差注入 ────────────────

let clockOffsetMs = 0;

/**
 * 获取当前时间（带注入偏差）。
 */
export function now(): number {
  return Date.now() + clockOffsetMs;
}

/**
 * 注入时钟偏差（毫秒）。正值 = 时钟快，负值 = 时钟慢。
 */
export function injectClockSkew(offsetMs: number): void {
  clockOffsetMs = offsetMs;
}

/**
 * 重置时钟偏差。
 */
export function resetClockSkew(): void {
  clockOffsetMs = 0;
}

// ──────────────── 网络分区注入 ────────────────

type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface FaultRoute {
  pattern: RegExp | string;
  /** 返回 true 表示拦截（模拟分区） */
  shouldBlock: () => boolean;
  /** 拦截时返回的错误 */
  error: Error;
}

const faultRoutes: FaultRoute[] = [];

/**
 * 添加网络分区规则。
 * pattern: URL 字符串或正则。
 * shouldBlock: 返回 true 时拦截请求。
 */
export function addFaultRoute(
  pattern: RegExp | string,
  shouldBlock: () => boolean,
  error = new Error('网络分区：连接被拒绝'),
): void {
  faultRoutes.push({ pattern, shouldBlock, error });
}

/**
 * 清除所有网络分区规则。
 */
export function clearFaultRoutes(): void {
  faultRoutes.splice(0);
}

/**
 * 包装 fetch 实现，注入故障路由。
 * 用法：const wrappedFetch = wrapFetchWithFaults(globalThis.fetch);
 */
export function wrapFetchWithFaults(originalFetch: FetchImpl): FetchImpl {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const route of faultRoutes) {
      const matches = typeof route.pattern === 'string'
        ? urlStr.includes(route.pattern)
        : route.pattern.test(urlStr);
      if (matches && route.shouldBlock()) {
        throw route.error;
      }
    }
    return originalFetch(url, init);
  };
}

// ──────────────── 进程中断注入 ────────────────

interface ManagedProcess {
  pid: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  killed: boolean;
}

const managedProcesses: ManagedProcess[] = [];

/**
 * 注册一个可管理的进程句柄。
 */
export function registerProcess(pid: number, killFn: (signal?: NodeJS.Signals) => boolean): ManagedProcess {
  const proc: ManagedProcess = { pid, kill: killFn, killed: false };
  managedProcesses.push(proc);
  return proc;
}

/**
 * 模拟进程中断：kill 所有已注册的进程。
 */
export function simulateProcessInterruption(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const proc of managedProcesses) {
    if (!proc.killed) {
      proc.killed = proc.kill(signal);
    }
  }
}

/**
 * 获取已注册进程的状态。
 */
export function getProcessStates(): Array<{ pid: number; killed: boolean }> {
  return managedProcesses.map((p) => ({ pid: p.pid, killed: p.killed }));
}

/**
 * 清理所有进程句柄。
 */
export function cleanupProcesses(): void {
  managedProcesses.splice(0);
}

// ──────────────── 统一清理 ────────────────

/**
 * 重置所有故障注入器状态。
 */
export function resetAllFaults(): void {
  resetClockSkew();
  clearFaultRoutes();
  cleanupProcesses();
}
