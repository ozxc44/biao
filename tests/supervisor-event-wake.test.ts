/**
 * SSE 事件唤醒回归：中央 /events/stream 事件到达时，共享轮次在轮询间隔内被
 * 提前唤醒；断流按指数退避自动重连。轮询定时器始终是兜底，这里只验证增强路径。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BiaoSupervisorRuntime } from '../src/worker/supervisor.js';

interface FakeServerOptions {
  /** 连接建立后多少 ms 推送一条事件；不传则保持静默。 */
  pushEventAfterMs?: number;
  /** 推送事件后立即结束响应（模拟断流）。 */
  closeAfterPush?: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startFakeCentral(options: FakeServerOptions = {}): Promise<{
  url: string;
  intakeCount: () => number;
  streamConnections: () => number;
}> {
  let intakeCount = 0;
  let streamConnections = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/plans') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        data: {
          total: 1,
          plans: [{
            plan_id: 'open-a', status: 'active', project_path: '/tmp/a',
            tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
            reviews: { pending: 0, accepted: 0, rejected: 0 },
          }],
        },
      }));
      return;
    }
    if (url.pathname === '/intake') {
      intakeCount++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        data: {
          consumer: 'pm-a', cursor: '100-0', counts: {},
          items: [],
        },
      }));
      return;
    }
    if (url.pathname === '/events') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '0-0' } }));
      return;
    }
    if (url.pathname === '/reconcile') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data: { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } } }));
      return;
    }
    if (url.pathname === '/events/stream') {
      streamConnections++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (options.pushEventAfterMs !== undefined) {
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ type: 'review_requested', task_id: 't-1', ts: Date.now() })}\n\n`);
          if (options.closeAfterPush) res.end();
        }, options.pushEventAfterMs);
      }
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: url.pathname } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    intakeCount: () => intakeCount,
    streamConnections: () => streamConnections,
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

describe('BiaoSupervisorRuntime SSE 事件唤醒', () => {
  it('事件到达时共享轮次在轮询间隔内被提前唤醒', async () => {
    const central = await startFakeCentral({ pushEventAfterMs: 300 });
    const shutdown = new AbortController();
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: central.url,
      consumer: 'pm-a',
      pollIntervalMs: 60_000,
      signal: shutdown.signal,
      eventWake: true,
    });
    const running = runtime.run();
    try {
      // 300ms 推事件 → 唤醒 → 第二轮 /intake；轮询间隔 60s，若靠定时器 4s 内不可能有第二轮。
      const woken = await waitFor(() => central.intakeCount() >= 2, 4_000);
      expect(woken).toBe(true);
      expect(central.streamConnections()).toBeGreaterThanOrEqual(1);
    } finally {
      shutdown.abort();
      runtime.stopEventStream();
      await running;
    }
  });

  it('断流后按退避自动重连', async () => {
    const central = await startFakeCentral({ pushEventAfterMs: 100, closeAfterPush: true });
    const shutdown = new AbortController();
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: central.url,
      consumer: 'pm-a',
      pollIntervalMs: 60_000,
      signal: shutdown.signal,
      eventWake: true,
    });
    const running = runtime.run();
    try {
      // 首连 100ms 后断开 → 1s 退避重连 → 第二次连接。
      const reconnected = await waitFor(() => central.streamConnections() >= 2, 5_000);
      expect(reconnected).toBe(true);
    } finally {
      shutdown.abort();
      runtime.stopEventStream();
      await running;
    }
  });
});
