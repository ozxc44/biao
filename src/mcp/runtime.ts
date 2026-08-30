import { randomBytes } from 'node:crypto';
import { BiaoHttpClient, BiaoRemoteError, type BiaoApiEnvelope, type BiaoHttpClientOptions } from './client.js';
import { startAutoHeartbeat, resolveAutoHeartbeatIntervalMs, type AutoHeartbeatHandle } from './auto-heartbeat.js';

export interface LanMcpRuntimeOptions extends BiaoHttpClientOptions {}

interface AgentRuntimeState {
  registrationId: string;
  registered: boolean;
  claims: Map<string, string>;
}

export interface LanMcpRuntime {
  client: BiaoHttpClient;
  agent(agentId: string): AgentRuntimeState;
  claimToken(agentId: string, taskId: string): string;
  rememberClaim(agentId: string, taskId: string, claimToken: string): void;
  forgetClaim(agentId: string, taskId: string): void;
  /** 首次显式携带 agent_id 的调用后记住身份；后续调用可省略该参数。 */
  rememberDefaultAgent(agentId: string): void;
  defaultAgent(): string | undefined;
}

function randomRuntimeId(prefix: 'reg' | 'claim'): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function configuredTimeout(env: NodeJS.ProcessEnv): number {
  const value = Number(env.BIAO_MCP_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(value) || value < 10 || value > 60_000) {
    throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', 'BIAO_MCP_TIMEOUT_MS 必须是 10..60000 的整数');
  }
  return value;
}

export function createLanMcpRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: LanMcpRuntimeOptions = {},
): LanMcpRuntime {
  const biaoUrl = env.BIAO_URL?.trim();
  const apiToken = env.BIAO_API_TOKEN?.trim();
  if (!biaoUrl) throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', '必须通过本机运行时提供 BIAO_URL');
  if (!apiToken) throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', '必须通过本机运行时提供 BIAO_API_TOKEN');

  const states = new Map<string, AgentRuntimeState>();
  const autoHeartbeats = new Map<string, AutoHeartbeatHandle>();
  const autoHeartbeatMs = resolveAutoHeartbeatIntervalMs(env);
  let defaultAgentId: string | undefined;
  const client = new BiaoHttpClient(biaoUrl, apiToken, {
    ...options,
    timeoutMs: options.timeoutMs ?? configuredTimeout(env),
  });

  const agent = (agentId: string): AgentRuntimeState => {
    let state = states.get(agentId);
    if (!state) {
      state = { registrationId: randomRuntimeId('reg'), registered: false, claims: new Map() };
      states.set(agentId, state);
    }
    return state;
  };

  const heartbeatKey = (agentId: string, taskId: string) => JSON.stringify([agentId, taskId]);

  return {
    client,
    agent,
    claimToken(agentId, taskId) {
      const token = states.get(agentId)?.claims.get(taskId);
      if (!token) {
        throw new BiaoRemoteError('LOCAL_LEASE_NOT_FOUND', '本 MCP 会话未持有该任务 lease，拒绝写操作');
      }
      return token;
    },
    rememberClaim(agentId, taskId, claimToken) {
      const key = heartbeatKey(agentId, taskId);
      autoHeartbeats.get(key)?.stop();
      if (autoHeartbeatMs > 0) {
        autoHeartbeats.set(key, startAutoHeartbeat(agentId, taskId, autoHeartbeatMs, {
          client,
          registrationId: () => states.get(agentId)?.registrationId,
          claimToken: () => states.get(agentId)?.claims.get(taskId),
          forgetClaim: () => {
            states.get(agentId)?.claims.delete(taskId);
            autoHeartbeats.delete(key);
          },
        }));
      }
      agent(agentId).claims.set(taskId, claimToken);
    },
    forgetClaim(agentId, taskId) {
      const key = heartbeatKey(agentId, taskId);
      autoHeartbeats.get(key)?.stop();
      autoHeartbeats.delete(key);
      states.get(agentId)?.claims.delete(taskId);
    },
    rememberDefaultAgent(agentId) {
      defaultAgentId = agentId;
    },
    defaultAgent() {
      return defaultAgentId;
    },
  };
}

export function remoteErrorEnvelope(error: unknown): BiaoApiEnvelope<never> {
  if (error instanceof BiaoRemoteError) {
    return { ok: false, data: null, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    data: null,
    error: { code: 'MCP_ADAPTER_FAILED', message: 'MCP 适配器拒绝了未分类异常，未执行本地回退' },
  };
}

export { randomRuntimeId };
