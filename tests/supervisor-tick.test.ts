/**
 * Supervisor 聚合 tick 端点测试
 *
 * 验证：
 * (a) transport：tick 成功路径减少请求计数
 * (b) transport：mock 404 → 回落且行为与旧路径一致
 * (c) transport：字段缺失时回落
 * (d) BIAO_SUPERVISOR_TRANSPORT=legacy 强制回落
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BiaoSupervisorRuntime, type SupervisorTickResult } from '../src/worker/supervisor.js';

interface RequestLog {
  method: string;
  path: string;
  authorization?: string;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function createTickServer(options: {
  tick?: () => SupervisorTickResult | null;
  plans?: () => unknown;
  intake?: () => unknown;
  events?: () => unknown;
  reconcile?: () => unknown;
  tickStatus?: number;
}): { url: string; requests: RequestLog[] } {
  const requests: RequestLog[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/supervisor/tick') {
      if (options.tickStatus && options.tickStatus !== 200) {
        res.statusCode = options.tickStatus;
        res.end(JSON.stringify({ ok: false, data: null }));
        return;
      }
      const tick = options.tick?.();
      if (tick === null || tick === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND' } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: tick }));
      return;
    }

    if (url.pathname === '/plans') {
      const plans = options.plans?.() ?? [
        { plan_id: 'p1', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
      ];
      res.end(JSON.stringify({ ok: true, data: { total: (plans as unknown[]).length, plans } }));
      return;
    }
    if (url.pathname === '/intake') {
      res.end(JSON.stringify({ ok: true, data: options.intake?.() ?? { consumer: 'pm', cursor: '100-0', counts: {}, items: [] } }));
      return;
    }
    if (url.pathname === '/events') {
      res.end(JSON.stringify({ ok: true, data: options.events?.() ?? { events: [], next_cursor: '0-0' } }));
      return;
    }
    if (url.pathname === '/reconcile' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, data: options.reconcile?.() ?? { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } } }));
      return;
    }
    // 其他路由（register/heartbeat/claim 等 Worker 路径）
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  servers.push(server);
  // 使用同步 listen 使端口分配确定
  const address = server.address() as AddressInfo | null;
  // 需要异步 listen
  let resultUrl = '';
  (server as any).__url = new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resultUrl = `http://127.0.0.1:${addr.port}`;
      resolve(resultUrl);
    });
  });
  return {
    get url() { return resultUrl; },
    requests,
  };
}

async function waitForServer(server: { url: string }): Promise<string> {
  // 等待 server 实际 listen
  return (servers[servers.length - 1] as any).__url ?? server.url;
}

function sampleTickResult(): SupervisorTickResult {
  return {
    plans: [{ plan_id: 'p1', status: 'active', project_path: '/tmp/a' }],
    intakes: [{ consumer: 'pm', cursor: '100-0', counts: { review_requested: 1 }, items: [{ kind: 'review_requested', event_id: 'ev1', task_id: 't1', plan_id: 'p1', timestamp: 100 }] }],
    events: { events: [{ event_id: 'ev-ready', type: 'task_ready', task_id: 't2', plan_id: 'p1', agent_id: '', result_status: '', acked: 'false', timestamp: 101 }], next_cursor: '101-0' },
    reconciliation: { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } },
  };
}

describe('Supervisor tick transport', () => {
  it('tick 成功路径：请求计数减少到 1 次 tick 调用', async () => {
    const server = createTickServer({ tick: sampleTickResult });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    // tick 路径：只调 /supervisor/tick，不调 /plans、/intake、/events、/reconcile
    const tickRequests = server.requests.filter((r) => r.path.startsWith('/supervisor/tick'));
    const legacyRequests = server.requests.filter((r) =>
      r.path.startsWith('/plans') || r.path.startsWith('/intake') || r.path.startsWith('/events') || r.path === '/reconcile');
    expect(tickRequests).toHaveLength(1);
    expect(legacyRequests).toHaveLength(0);
  });

  it('tick 返回 404 → 静默回落到逐端点路径', async () => {
    const server = createTickServer({
      tick: () => null, // 返回 404
      plans: () => [
        { plan_id: 'p1', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
      ],
      intake: () => ({ consumer: 'pm', cursor: '100-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
      reconcile: () => ({ reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } }),
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    // 首轮：tick 尝试失败 → 回落到逐端点
    const tickRequests = server.requests.filter((r) => r.path.startsWith('/supervisor/tick'));
    expect(tickRequests).toHaveLength(1);

    // 逐端点被调用
    const plansRequests = server.requests.filter((r) => r.path.startsWith('/plans'));
    const intakeRequests = server.requests.filter((r) => r.path.startsWith('/intake'));
    const reconcileRequests = server.requests.filter((r) => r.path === '/reconcile');
    expect(plansRequests.length).toBeGreaterThanOrEqual(1);
    expect(intakeRequests.length).toBeGreaterThanOrEqual(1);
    expect(reconcileRequests.length).toBeGreaterThanOrEqual(1);
  });

  it('tick 返回字段缺失 → 回落到逐端点', async () => {
    const server = createTickServer({
      tick: () => ({ plans: [], intakes: [], events: { events: [], next_cursor: '0-0' } }) as any, // 缺少 reconciliation
      plans: () => [
        { plan_id: 'p1', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
      ],
      intake: () => ({ consumer: 'pm', cursor: '100-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
      reconcile: () => ({ reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } }),
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    // 字段缺失 → 回落
    const plansRequests = server.requests.filter((r) => r.path.startsWith('/plans'));
    expect(plansRequests.length).toBeGreaterThanOrEqual(1);
  });

  it('BIAO_SUPERVISOR_TRANSPORT=legacy 强制回落', async () => {
    const server = createTickServer({
      tick: sampleTickResult, // 服务端支持 tick
      plans: () => [
        { plan_id: 'p1', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
      ],
      intake: () => ({ consumer: 'pm', cursor: '100-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
      reconcile: () => ({ reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } }),
    });
    const url = await waitForServer(server);

    const originalEnv = process.env.BIAO_SUPERVISOR_TRANSPORT;
    process.env.BIAO_SUPERVISOR_TRANSPORT = 'legacy';
    try {
      const runtime = new BiaoSupervisorRuntime({
        biaoUrl: url,
        consumer: 'pm',
        pollIntervalMs: 1_000,
      });

      await runtime.runOnce();

      // legacy 模式：不调 tick，走逐端点
      const tickRequests = server.requests.filter((r) => r.path.startsWith('/supervisor/tick'));
      expect(tickRequests).toHaveLength(0);

      const plansRequests = server.requests.filter((r) => r.path.startsWith('/plans'));
      expect(plansRequests.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalEnv === undefined) delete process.env.BIAO_SUPERVISOR_TRANSPORT;
      else process.env.BIAO_SUPERVISOR_TRANSPORT = originalEnv;
    }
  });

  it('tick 成功后后续轮次继续使用 tick', async () => {
    let tickCallCount = 0;
    const server = createTickServer({
      tick: () => { tickCallCount++; return sampleTickResult(); },
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pollIntervalMs: 100,
    });

    // 跑两轮
    await runtime.runOnce();
    const firstRoundTickCount = tickCallCount;
    expect(firstRoundTickCount).toBe(1);

    await runtime.runOnce();
    expect(tickCallCount).toBe(2);

    // 逐端点从未被调用
    const legacyRequests = server.requests.filter((r) =>
      r.path.startsWith('/plans') || r.path.startsWith('/intake') || r.path === '/reconcile');
    expect(legacyRequests).toHaveLength(0);
  });

  it('tick 传递正确的查询参数', async () => {
    let capturedPath = '';
    const server = createTickServer({
      tick: () => {
        capturedPath = server.requests[server.requests.length - 1]?.path ?? '';
        return sampleTickResult();
      },
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pmConsumers: ['pm-a', 'pm-b'],
      planIds: ['plan-1'],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    expect(capturedPath).toContain('consumers=pm-a%2Cpm-b');
    expect(capturedPath).toContain('plan_ids=plan-1');
  });

  it('tick 传递 Owner auth token', async () => {
    let capturedAuth: string | undefined;
    const server = createTickServer({
      tick: () => {
        capturedAuth = server.requests[server.requests.length - 1]?.authorization;
        return sampleTickResult();
      },
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      apiToken: 'test-owner-token',
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    expect(capturedAuth).toBe('Bearer test-owner-token');
  });

  it('tick 首轮回落后第二轮不再尝试 tick', async () => {
    let tickAttempts = 0;
    const server = createTickServer({
      tick: () => { tickAttempts++; return null; },
      plans: () => [
        { plan_id: 'p1', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
      ],
      intake: () => ({ consumer: 'pm', cursor: '100-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
      reconcile: () => ({ reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } }),
    });
    const url = await waitForServer(server);
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm',
      pollIntervalMs: 1_000,
    });

    // 首轮：tick 探测失败
    await runtime.runOnce();
    expect(tickAttempts).toBe(1);

    // 第二轮：不再尝试 tick
    await runtime.runOnce();
    expect(tickAttempts).toBe(1); // 仍然是 1，不再尝试
  });
});
