import { describe, expect, it } from 'vitest';
import { createLanMcpRuntime } from '../src/mcp/runtime.js';
import { handleMcpMessage } from '../src/mcp/session.js';
import { resolveAutoHeartbeatIntervalMs } from '../src/mcp/auto-heartbeat.js';

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
}

type ScenarioHandler = (
  path: string,
  body: Record<string, unknown>,
  call: RecordedCall,
) => { status?: number; payload: Record<string, unknown> } | undefined;

function scenarioFetch(handler: ScenarioHandler): typeof fetch {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const call = { path, body };
    const handled = handler(path, body, call);
    if (handled) {
      return new Response(JSON.stringify(handled.payload), {
        status: handled.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function baseHandler(overrides: Record<string, (body: Record<string, unknown>) => { status?: number; payload: Record<string, unknown> }>): ScenarioHandler {
  return (path, body) => {
    if (path === '/health') return { payload: { ok: true, data: { version: 'v1' } } };
    if (path === '/register') return { payload: { ok: true, data: { registration_id: body.registration_id } } };
    if (path === '/claim') {
      return { payload: { ok: true, data: { task_id: 'auto-hb-task', plan_id: 'auto-hb-plan', claim_token: 'lease-token-1' } } };
    }
    const override = overrides[path];
    if (override) return override(body);
    return undefined;
  };
}

function rpcTool(runtime: ReturnType<typeof createLanMcpRuntime>, name: string, args: Record<string, unknown> = {}) {
  return handleMcpMessage({
    jsonrpc: '2.0',
    id: `${name}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  }, runtime);
}

async function toolPayload(
  runtime: ReturnType<typeof createLanMcpRuntime>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpcTool(runtime, name, args);
  const result = response?.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  return {
    isError: Boolean(result?.isError),
    payload: JSON.parse(result?.content?.[0]?.text ?? 'null') as {
      ok: boolean;
      data: any;
      error?: { code: string; message: string };
    },
  };
}

const HB_ENV = {
  BIAO_URL: 'http://127.0.0.1:7331',
  BIAO_API_TOKEN: 'auto-hb-secret',
  BIAO_MCP_AUTO_HEARTBEAT_MS: '1000',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MCP 执行期自动心跳', () => {
  it('claim 成功后周期性 heartbeat + lease/renew，携带本会话 epoch 与 claim token', async () => {
    const calls: RecordedCall[] = [];
    const runtime = createLanMcpRuntime(HB_ENV, {
      fetch: scenarioFetch((path, body, call) => {
        calls.push(call);
        return baseHandler({})(path, body, call);
      }),
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);

    await sleep(2300);
    const heartbeats = calls.filter((call) => call.path === '/heartbeat');
    const renews = calls.filter((call) => call.path === '/lease/renew');
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(renews.length).toBeGreaterThanOrEqual(2);
    const agentRegistration = calls.find((call) => call.path === '/register')?.body.registration_id as string;
    for (const beat of heartbeats) {
      expect(beat.body).toMatchObject({
        agent_id: 'auto-hb-agent',
        registration_id: agentRegistration,
        current_task: 'auto-hb-task',
      });
    }
    for (const renew of renews) {
      expect(renew.body).toMatchObject({ task_id: 'auto-hb-task', claim_token: 'lease-token-1' });
    }
    runtime.forgetClaim('auto-hb-agent', 'auto-hb-task');
  });

  it('task_report 成功后停止自动心跳', async () => {
    const calls: RecordedCall[] = [];
    const runtime = createLanMcpRuntime(HB_ENV, {
      fetch: scenarioFetch((path, body, call) => {
        calls.push(call);
        return baseHandler({
          '/report': () => ({ payload: { ok: true, data: { task_id: 'auto-hb-task', status: 'done' } } }),
        })(path, body, call);
      }),
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);
    const report = await toolPayload(runtime, 'task_report', {
      task_id: 'auto-hb-task',
      agent_id: 'auto-hb-agent',
      status: 'done',
    });
    expect(report.payload.ok).toBe(true);

    await sleep(1300);
    expect(calls.filter((call) => call.path === '/heartbeat')).toHaveLength(0);
  });

  it('lease/renew 判失效（LEASE_EXPIRED）时忘记本地 claim 并停止心跳', async () => {
    const calls: RecordedCall[] = [];
    const runtime = createLanMcpRuntime(HB_ENV, {
      fetch: scenarioFetch((path, body, call) => {
        calls.push(call);
        return baseHandler({
          '/lease/renew': () => ({
            status: 409,
            payload: { ok: false, data: null, error: { code: 'LEASE_EXPIRED', message: 'lease expired' } },
          }),
        })(path, body, call);
      }),
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);

    await sleep(2600);
    expect(calls.filter((call) => call.path === '/heartbeat')).toHaveLength(1);
    const denied = await toolPayload(runtime, 'task_report', {
      task_id: 'auto-hb-task',
      agent_id: 'auto-hb-agent',
      status: 'done',
    });
    expect(denied.payload).toMatchObject({ ok: false, error: { code: 'LOCAL_LEASE_NOT_FOUND' } });
  });

  it('heartbeat 业务拒绝时停止重试，但不动本地 lease', async () => {
    const calls: RecordedCall[] = [];
    const runtime = createLanMcpRuntime(HB_ENV, {
      fetch: scenarioFetch((path, body, call) => {
        calls.push(call);
        return baseHandler({
          '/heartbeat': () => ({
            status: 409,
            payload: { ok: false, data: null, error: { code: 'AGENT_REGISTRATION_REQUIRED', message: 'epoch gone' } },
          }),
        })(path, body, call);
      }),
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);

    await sleep(2600);
    expect(calls.filter((call) => call.path === '/heartbeat')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/lease/renew')).toHaveLength(0);
    // lease 未被忘记：report 请求应当真实发出（由远端裁决），而不是本地拒绝。
    const report = await toolPayload(runtime, 'task_report', {
      task_id: 'auto-hb-task',
      agent_id: 'auto-hb-agent',
      status: 'failed',
    });
    expect(report.payload.ok).toBe(true);
    expect(calls.some((call) => call.path === '/report')).toBe(true);
  });

  it('传输层失败按次数容忍后恢复', async () => {
    const calls: RecordedCall[] = [];
    let failNextTransport = 2;
    const runtime = createLanMcpRuntime(HB_ENV, {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/heartbeat' && failNextTransport > 0) {
          failNextTransport -= 1;
          throw new Error('central unreachable');
        }
        return scenarioFetch((p, body, call) => {
          calls.push(call);
          return baseHandler({})(p, body, call);
        })(input, init);
      },
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);

    await sleep(4500);
    const renews = calls.filter((call) => call.path === '/lease/renew');
    expect(renews.length).toBeGreaterThanOrEqual(2);
    runtime.forgetClaim('auto-hb-agent', 'auto-hb-task');
  });

  it('BIAO_MCP_AUTO_HEARTBEAT_MS=0 关闭自动心跳', async () => {
    const calls: RecordedCall[] = [];
    const runtime = createLanMcpRuntime({ ...HB_ENV, BIAO_MCP_AUTO_HEARTBEAT_MS: '0' }, {
      fetch: scenarioFetch((path, body, call) => {
        calls.push(call);
        return baseHandler({})(path, body, call);
      }),
    });
    const claim = await toolPayload(runtime, 'task_claim', { agent_id: 'auto-hb-agent' });
    expect(claim.payload.ok).toBe(true);

    await sleep(1300);
    expect(calls.filter((call) => call.path === '/heartbeat')).toHaveLength(0);
  });

  it('配置解析：默认 60s；非法值 fail fast', () => {
    expect(resolveAutoHeartbeatIntervalMs({})).toBe(60_000);
    expect(resolveAutoHeartbeatIntervalMs({ BIAO_MCP_AUTO_HEARTBEAT_MS: '0' })).toBe(0);
    expect(resolveAutoHeartbeatIntervalMs({ BIAO_MCP_AUTO_HEARTBEAT_MS: '5000' })).toBe(5000);
    for (const invalid of ['500', 'abc', '1000000', '1.5', '']) {
      expect(() => resolveAutoHeartbeatIntervalMs({ BIAO_MCP_AUTO_HEARTBEAT_MS: invalid })).toThrow();
    }
    expect(() => createLanMcpRuntime({ ...HB_ENV, BIAO_MCP_AUTO_HEARTBEAT_MS: 'nope' })).toThrow(/REMOTE_CONFIG_INVALID|BIAO_MCP_AUTO_HEARTBEAT_MS/);
  });
});
