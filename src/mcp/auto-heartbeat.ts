import { BiaoRemoteError, type BiaoHttpClient } from './client.js';

/**
 * task_claim 成功后的执行期自动心跳。
 *
 * 文档契约（docs/worker-integration.md）要求"slot 一旦运行任务，presence heartbeat
 * 停止，改由 Worker 自己维护带当前任务的 heartbeat 与 lease"；但 Harness 会话是
 * 模型驱动的，长任务执行中不再调用工具就会漏掉心跳，中央在 STALE_AGENT_THRESHOLD_MS
 * （5 分钟）后把仍在干活的 Agent 判成 stale，lease 到期还会回收重派。MCP stdio 进程
 * 与会话同生命周期，在这里兜底续租，比要求模型自觉调用 task_heartbeat 可靠。
 */

export interface AutoHeartbeatDeps {
  client: BiaoHttpClient;
  /** 本会话 registration epoch；领取后恒存在，失忆即停止。 */
  registrationId: () => string | undefined;
  /** 本会话对该任务持有的 claim token；lease 被忘记后返回 undefined。 */
  claimToken: () => string | undefined;
  /** renew 被判 lease 失效时清掉本地 claim 句柄（与 forgetInvalidLease 同语义）。 */
  forgetClaim: () => void;
}

export interface AutoHeartbeatHandle {
  stop(): void;
}

/** /lease/renew 的这组业务码意味着本地 lease 已不可用，镜像 forgetInvalidLease。 */
const LEASE_INVALID_CODES = new Set([
  'CLAIM_TOKEN_INVALID',
  'LEASE_EXPIRED',
  'TASK_NOT_RUNNING',
  'CLAIM_OWNER_MISMATCH',
]);

/**
 * 连续传输层失败（超时/不可达/鉴权异常）达到该次数后停止。60s 间隔下约等于中央
 * stale 阈值：到这一步时 Agent 已被投影为 stale，继续静默重试没有意义。
 */
const MAX_CONSECUTIVE_TRANSPORT_FAILURES = 5;

export const AUTO_HEARTBEAT_DISABLED = 0;
export const AUTO_HEARTBEAT_DEFAULT_MS = 60_000;
const AUTO_HEARTBEAT_MIN_MS = 1_000;
const AUTO_HEARTBEAT_MAX_MS = 600_000;

export function resolveAutoHeartbeatIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.BIAO_MCP_AUTO_HEARTBEAT_MS?.trim();
  if (raw === undefined) return AUTO_HEARTBEAT_DEFAULT_MS;
  if (raw === '') {
    throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', 'BIAO_MCP_AUTO_HEARTBEAT_MS 为空；如需关闭请显式设 0');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || (value !== AUTO_HEARTBEAT_DISABLED
    && (value < AUTO_HEARTBEAT_MIN_MS || value > AUTO_HEARTBEAT_MAX_MS))) {
    throw new BiaoRemoteError(
      'REMOTE_CONFIG_INVALID',
      `BIAO_MCP_AUTO_HEARTBEAT_MS 必须是 0 或 ${AUTO_HEARTBEAT_MIN_MS}..${AUTO_HEARTBEAT_MAX_MS} 的整数`,
    );
  }
  return value;
}

const noopHandle: AutoHeartbeatHandle = { stop: () => {} };

export function startAutoHeartbeat(
  agentId: string,
  taskId: string,
  intervalMs: number,
  deps: AutoHeartbeatDeps,
): AutoHeartbeatHandle {
  if (intervalMs <= AUTO_HEARTBEAT_DISABLED) return noopHandle;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let beating = false;
  let transportFailures = 0;

  const stop = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const beat = async () => {
    if (beating) return;
    beating = true;
    try {
      const registrationId = deps.registrationId();
      const claimToken = deps.claimToken();
      // 本地状态已不完整（忘记 lease / 会话重置）时无需再续。
      if (!registrationId || !claimToken) {
        stop();
        return;
      }
      const heartbeat = await deps.client.request('/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          registration_id: registrationId,
          current_task: taskId,
        }),
      });
      // heartbeat 的业务拒绝（epoch 失效、注册缺失等）对同一请求是永久性的，
      // 重试无意义；lease 是否仍有效用任务工具调用自己面对。
      if (!heartbeat.ok) {
        stop();
        return;
      }
      const renew = await deps.client.request('/lease/renew', {
        method: 'POST',
        body: JSON.stringify({ task_id: taskId, claim_token: claimToken }),
      });
      if (!renew.ok) {
        if (LEASE_INVALID_CODES.has(renew.error?.code ?? '')) deps.forgetClaim();
        stop();
        return;
      }
      transportFailures = 0;
    } catch {
      // 传输层失败（超时/中央不可达/协议错）按次数容忍，避免网络抖动杀死长任务续租。
      transportFailures += 1;
      if (transportFailures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES) stop();
    } finally {
      beating = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void beat().then(() => schedule());
    }, intervalMs);
    // stdio 会话随 stdin 关闭退出；续租定时器不得拖住进程。
    timer.unref();
  };

  schedule();
  return { stop };
}
