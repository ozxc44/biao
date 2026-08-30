import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与其他运行时产物一致：dist/worker 与 src/worker 都向上两级到包根。
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

// 显式 env 优先；未设置时，wrapper 同目录（bootstrap 布局即 .biao/）的
// config.env 里同名键可作为机器级 opt-in 兜底。MCP 适配器常由 harness 以
// 最小 env 启动，机器已在 config.env 声明 opt-in 时无需逐个客户端改 MCP 配置。
// 只读取这一个开关键，不读取任何凭据。
function isEnabled(command: string): boolean {
  const fromEnv = process.env.BIAO_SUPERVISOR_AUTO_ENSURE;
  if (fromEnv !== undefined) return /^(1|true|yes)$/i.test(fromEnv);
  try {
    const raw = readFileSync(join(dirname(command), 'config.env'), 'utf8');
    const match = raw.match(/^BIAO_SUPERVISOR_AUTO_ENSURE=(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
    return Boolean(match && /^(1|true|yes)$/i.test(match[1] ?? match[2] ?? match[3] ?? ''));
  } catch {
    // wrapper 同目录没有 config.env（npm 全局安装、裸源码目录）保持默认关闭。
    return false;
  }
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
  if (process.platform === 'win32') return;
  const command = process.env.BIAO_PM_WATCH_CMD?.trim() || join(packageRoot, '.biao', 'pm-watch');
  try {
    if (!statSync(command).isFile()) return;
  } catch {
    return;
  }
  if (!isEnabled(command)) return;
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

/** 仅供测试：清空节流窗口，隔离相邻用例的拉起判定。 */
export function resetEnsureThrottleForTests(): void {
  lastEnsureAtMs = 0;
}
