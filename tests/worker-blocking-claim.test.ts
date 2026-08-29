/**
 * 常驻 worker 的 blocking claim 长轮询回归：
 * - 空闲等待发生在服务端，本地不再重复睡 idlePollMs（请求频率由 timeout_ms 决定）；
 * - 旧中央秒拒 blocking 参数时自动降级回非阻塞 + 本地节拍，不热循环；
 * - 一次性 worker（exitOnIdle）保持即时非阻塞 claim；
 * - 优雅停止立即打断挂起中的长轮询。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runWorkerLoop } from '../src/worker/base.js';

interface ClaimRecord {
  blocking: boolean | undefined;
  timeout_ms: number | undefined;
  at: number;
}

interface FakeCentralOptions {
  /** blocking=true 的 claim 挂起多少 ms 后返回空结果。 */
  blockingHoldMs?: number;
  /** 对 blocking=true 立即返回 INVALID_REQUEST（模拟旧中央）。 */
  rejectBlocking?: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startFakeCentral(options: FakeCentralOptions = {}): Promise<{
  url: string;
  claims: () => ClaimRecord[];
}> {
  const claims: ClaimRecord[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* ignore */ }
      res.setHeader('Content-Type', 'application/json');
      const send = (payload: unknown) => res.end(JSON.stringify(payload));
      switch (req.url) {
        case '/register':
          return send({ ok: true, data: {} });
        case '/heartbeat':
          return send({ ok: true, data: {} });
        case '/agent/offline':
          return send({ ok: true, data: {} });
        case '/claim': {
          claims.push({
            blocking: typeof parsed.blocking === 'boolean' ? parsed.blocking : undefined,
            timeout_ms: typeof parsed.timeout_ms === 'number' ? parsed.timeout_ms : undefined,
            at: Date.now(),
          });
          if (parsed.blocking === true) {
            if (options.rejectBlocking) {
              return send({ ok: false, data: null, error: { code: 'INVALID_REQUEST', message: 'blocking not supported' } });
            }
            setTimeout(() => send({ ok: true, data: null }), options.blockingHoldMs ?? 1_000);
            return;
          }
          return send({ ok: true, data: null });
        }
        default:
          res.statusCode = 404;
          return send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: req.url } });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, claims: () => claims };
}

async function runResidentWorker(
  url: string,
  signal: AbortSignal,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await runWorkerLoop({
    agentId: 'blocking-claim-worker',
    agentType: 'cli',
    biaoUrl: url,
    maxTasks: 0,
    idlePollMs: 5_000,
    signal,
    execute: async () => ({
      run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
      changedFiles: [], backend: 'test', model: 'test',
    }),
    ...overrides,
  });
}

describe('常驻 worker blocking claim 长轮询', () => {
  it('空闲 claim 携带 blocking=true 与默认 50s timeout，等待在服务端', async () => {
    const central = await startFakeCentral({ blockingHoldMs: 2_200 });
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 5_000);
    await runResidentWorker(central.url, shutdown.signal);
    const records = central.claims();
    // 2200ms 挂起 × 3 轮 ≈ 5s：若仍在本地睡 idlePollMs=5000，只会出现 1 次 claim。
    expect(records.length).toBeGreaterThanOrEqual(3);
    for (const record of records) {
      expect(record.blocking).toBe(true);
      expect(record.timeout_ms).toBe(50_000);
    }
  }, 10_000);

  it('旧中央秒拒 blocking 时降级回非阻塞 + 本地节拍，不热循环', async () => {
    const central = await startFakeCentral({ rejectBlocking: true });
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 1_200);
    await runResidentWorker(central.url, shutdown.signal, { idlePollMs: 100 });
    const records = central.claims();
    expect(records[0]?.blocking).toBe(true);
    const afterDowngrade = records.filter((record) => record.blocking === false);
    expect(afterDowngrade.length).toBeGreaterThan(0);
    // idlePollMs=100 本地节拍下 1.2s 至多十几次；热循环会是数百次。
    expect(records.length).toBeLessThanOrEqual(30);
  }, 5_000);

  it('一次性 worker（exitOnIdle）保持即时非阻塞 claim 并正常退出', async () => {
    const central = await startFakeCentral();
    await runWorkerLoop({
      agentId: 'oneshot-worker',
      agentType: 'cli',
      biaoUrl: central.url,
      maxTasks: 1,
      execute: async () => ({
        run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
        changedFiles: [], backend: 'test', model: 'test',
      }),
    });
    const records = central.claims();
    expect(records).toHaveLength(1);
    expect(records[0].blocking).toBe(false);
    expect(records[0].timeout_ms).toBe(5_000);
  }, 5_000);

  it('优雅停止立即打断挂起中的 blocking 长轮询', async () => {
    const central = await startFakeCentral({ blockingHoldMs: 4_000 });
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 250);
    const startedAt = Date.now();
    await runResidentWorker(central.url, shutdown.signal);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(central.claims().length).toBeGreaterThanOrEqual(1);
  }, 5_000);
});
