import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与其他运行时产物一致：dist/worker 与 src/worker 都向上两级到包根。
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

// 门铃自愈是显式 opt-in：通用 CLI/MCP 会在未部署 pm-watch 的机器上运行，
// 默认绝不拉起任何常驻进程。设置 BIAO_SUPERVISOR_AUTO_ENSURE=1 才启用。
function isEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.BIAO_SUPERVISOR_AUTO_ENSURE ?? '');
}

let lastEnsureAtMs = 0;
// 只关心"监视器是否在运行"这一慢变量；常驻进程（MCP server、worker runtime）
// 内分钟级节流足够，避免每次上报都 fork 一层 shell 做判活。
const ENSURE_THROTTLE_MS = 60_000;

/**
 * worker 上报 / PM 处置成功后的本机自愈入口：在开启 opt-in 且存在
 * pm-watch 包装器时，以 --ensure 后台拉起一次。判活与去重由 pm-watch 的
 * 原子锁完成，重复调用幂等；任何失败都不影响调用方主流程。
 */
export function maybeEnsureSupervisor(): void {
  if (process.platform === 'win32' || !isEnabled()) return;
  const command = process.env.BIAO_PM_WATCH_CMD?.trim() || join(packageRoot, '.biao', 'pm-watch');
  try {
    if (!statSync(command).isFile()) return;
  } catch {
    return;
  }
  const now = Date.now();
  if (now - lastEnsureAtMs < ENSURE_THROTTLE_MS) return;
  lastEnsureAtMs = now;
  try {
    const child = spawn(command, ['--ensure'], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // 拉起失败不改变调用方行为；下一次完成事件或人工启动会再次兜底。
  }
}
