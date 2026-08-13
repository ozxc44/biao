import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import {
  acquireRestoreLock,
  agentRegister,
  claim,
  releaseRestoreLock,
  setSqliteStore,
} from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';

const REDIS_URL = process.env.BLOCKING_CLAIM_TEST_REDIS_URL
  ?? 'redis://127.0.0.1:6380/15';
const REDIS_DB = Number(new URL(REDIS_URL).pathname.slice(1) || '0');
const CONTROL_PLANE_BUDGET_MS = 150;

interface RedisClientRow {
  id: string;
  db: string;
  flags: string;
  cmd: string;
  name: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseClientList(raw: unknown): RedisClientRow[] {
  return String(raw)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => Object.fromEntries(
      line.trim().split(/\s+/).map((field) => {
        const separator = field.indexOf('=');
        return [field.slice(0, separator), field.slice(separator + 1)];
      }),
    ) as unknown as RedisClientRow);
}

async function clientRows(observer: Redis): Promise<RedisClientRow[]> {
  return parseClientList(await observer.call('CLIENT', 'LIST'))
    .filter((row) => Number(row.db) === REDIS_DB);
}

async function waitForBlockingXread(observer: Redis): Promise<RedisClientRow> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const row = (await clientRows(observer)).find(
      (candidate) => candidate.cmd === 'xread' && candidate.flags.includes('b'),
    );
    if (row) return row;
    await delay(5);
  }
  throw new Error('阻塞 claim 未在 1 秒内进入 XREAD BLOCK');
}

async function waitForConnectionCount(observer: Redis, expected: number): Promise<boolean> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    if ((await clientRows(observer)).length === expected) return true;
    await delay(5);
  }
  return false;
}

async function createRegisteredAgent(redis: Redis, suffix: string) {
  const agentId = `blocking-isolation-${suffix}`;
  const registrationId = `registration-blocking-${suffix}-0001`;
  const registered = await agentRegister(
    redis,
    agentId,
    'test',
    ['code'],
    undefined,
    undefined,
    registrationId,
  );
  expect(registered.ok).toBe(true);
  return { agentId, registrationId };
}

async function seedTask(redis: Redis, suffix: string): Promise<string> {
  const planId = `blocking-plan-${suffix}`;
  const taskId = `blocking-task-${suffix}`;
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: planId,
    project_path: '/tmp/biao-blocking-claim',
    default_assignee: 'auto',
    default_priority: 5,
    phases: [{ id: 'impl', name: '实现' }],
  }, 1);
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    timeout_seconds: 60,
    verify: [],
  }, `# ${taskId}`, planId, '/tmp/biao-blocking-claim', 5);
  return taskId;
}

function httpConfig(): BiaoConfig {
  return {
    port: 7331,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    apiToken: '',
    workspaceRoots: ['/tmp'],
    sqlitePath: '/tmp/biao-blocking-claim.sqlite',
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

describe('blocking claim Redis connection isolation', () => {
  let control: Redis;
  let observer: Redis;
  const extraConnections: Redis[] = [];

  beforeEach(async () => {
    control = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    observer = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    await observer.flushdb();
    setSqliteStore(null);
  });

  afterEach(async () => {
    setSqliteStore(null);
    for (const connection of extraConnections.splice(0)) connection.disconnect();
    control.disconnect();
    observer.disconnect();
  });

  it('keeps PING on the shared control-plane client below 150ms while claim waits', async () => {
    await control.client('SETNAME', 'biao-blocking-control-plane');
    const { agentId, registrationId } = await createRegisteredAgent(control, 'ping');

    const claimPromise = claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-isolation-ping-0001',
      blocking: true,
      timeout_ms: 700,
      preferred_types: ['code'],
    });
    await waitForBlockingXread(observer);

    const startedAt = performance.now();
    let pingElapsedMs = Number.POSITIVE_INFINITY;
    const pingPromise = control.ping().then(() => {
      pingElapsedMs = performance.now() - startedAt;
    });
    const pingCompletedWithinBudget = await Promise.race([
      pingPromise.then(() => true),
      delay(CONTROL_PLANE_BUDGET_MS).then(() => false),
    ]);

    const claimed = await claimPromise;
    await pingPromise;

    expect(claimed.ok).toBe(true);
    expect(claimed.data).toBeNull();
    expect(
      pingCompletedWithinBudget,
      `共享 Redis 连接被阻塞 claim 冻结了 ${Math.round(pingElapsedMs)}ms`,
    ).toBe(true);
    expect(pingElapsedMs).toBeLessThan(CONTROL_PLANE_BUDGET_MS);
  });

  it('uses a disposable blocking connection and releases it after XREAD timeout', async () => {
    await control.client('SETNAME', 'biao-blocking-lifecycle-control');
    const { agentId, registrationId } = await createRegisteredAgent(control, 'timeout');
    const baselineConnectionCount = (await clientRows(observer)).length;

    const claimPromise = claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-isolation-timeout-0001',
      blocking: true,
      timeout_ms: 350,
      preferred_types: ['code'],
    });
    await waitForBlockingXread(observer);
    const waitingConnectionCount = (await clientRows(observer)).length;
    const claimed = await claimPromise;
    const connectionsReturnedToBaseline = await waitForConnectionCount(
      observer,
      baselineConnectionCount,
    );

    expect(claimed.ok).toBe(true);
    expect(claimed.data).toBeNull();
    expect.soft(
      waitingConnectionCount,
      'XREAD BLOCK 等待期间应恰好多一条 disposable 连接',
    ).toBe(baselineConnectionCount + 1);
    expect.soft(
      connectionsReturnedToBaseline,
      'XREAD timeout 后独立连接必须在 finally 中 disconnect',
    ).toBe(true);
  });

  it('disconnects the disposable waiter when XREAD throws', async () => {
    const { agentId, registrationId } = await createRegisteredAgent(control, 'error');
    const baselineConnectionCount = (await clientRows(observer)).length;
    const waiter = control.duplicate();
    extraConnections.push(waiter);
    await waiter.ping();

    const disconnectSpy = vi.spyOn(waiter, 'disconnect');
    vi.spyOn(waiter, 'xread').mockRejectedValueOnce(new Error('forced XREAD failure'));
    const duplicateSpy = vi.spyOn(control, 'duplicate').mockReturnValueOnce(waiter);
    try {
      await expect(claim(control, {
        agent_id: agentId,
        registration_id: registrationId,
        claim_request_id: 'claim-blocking-isolation-error-0001',
        blocking: true,
        timeout_ms: 700,
        preferred_types: ['code'],
      })).rejects.toThrow('forced XREAD failure');
    } finally {
      duplicateSpy.mockRestore();
    }

    const connectionsReturnedToBaseline = await waitForConnectionCount(
      observer,
      baselineConnectionCount,
    );
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(connectionsReturnedToBaseline).toBe(true);
  });

  it('records the stream cursor before the immediate scan so a task published in the gap is not lost', async () => {
    const { agentId, registrationId } = await createRegisteredAgent(control, 'cursor');
    const waiter = control.duplicate();
    extraConnections.push(waiter);
    const originalXread = waiter.xread.bind(waiter);
    let allowXread!: () => void;
    const xreadGate = new Promise<void>((resolve) => { allowXread = resolve; });
    const xreadSpy = vi.spyOn(waiter, 'xread').mockImplementation(async (...args) => {
      await xreadGate;
      return originalXread(...args as Parameters<typeof waiter.xread>);
    });
    vi.spyOn(control, 'duplicate').mockReturnValueOnce(waiter);

    const startedAt = performance.now();
    const claimPromise = claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-cursor-0001',
      blocking: true,
      timeout_ms: 700,
      preferred_types: ['code'],
    });
    while (xreadSpy.mock.calls.length === 0) await delay(5);
    const taskId = await seedTask(observer, 'cursor');
    allowXread();
    const claimed = await claimPromise;

    expect(claimed.ok).toBe(true);
    expect(claimed.data?.task_id).toBe(taskId);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('does not hold a global mutation permit during the pure blocking wait', async () => {
    const { agentId, registrationId } = await createRegisteredAgent(control, 'restore');
    const claimPromise = claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-restore-0001',
      blocking: true,
      timeout_ms: 350,
      preferred_types: ['code'],
    });
    await waitForBlockingXread(observer);

    const lock = await acquireRestoreLock(observer, 'restore-during-blocking-wait');
    expect(lock).toEqual({ ok: true, owner: 'restore-during-blocking-wait' });
    if (lock.ok) await releaseRestoreLock(observer, lock.owner);
    await expect(claimPromise).resolves.toMatchObject({ ok: true, data: null });
  });

  it('rejects an excessive timeout at both service and HTTP schema boundaries', async () => {
    const { agentId, registrationId } = await createRegisteredAgent(control, 'timeout-limit');
    await expect(claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-timeout-limit-0001',
      blocking: false,
      timeout_ms: 60_001,
      preferred_types: ['code'],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_CLAIM_TIMEOUT' },
    });

    const app = await createHttpServer(control, httpConfig(), { webDist: null });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/claim',
        payload: {
          agent_id: agentId,
          registration_id: registrationId,
          claim_request_id: 'claim-blocking-timeout-http-0001',
          blocking: false,
          timeout_ms: 60_001,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    } finally {
      await app.close();
    }
  });

  it('releases the disposable waiter when the caller aborts', async () => {
    const { agentId, registrationId } = await createRegisteredAgent(control, 'abort');
    const abortController = new AbortController();
    const startedAt = performance.now();
    const claimPromise = (claim as unknown as (
      redis: Redis,
      request: Parameters<typeof claim>[1],
      signal?: AbortSignal,
    ) => ReturnType<typeof claim>)(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-abort-0001',
      blocking: true,
      timeout_ms: 700,
      preferred_types: ['code'],
    }, abortController.signal);
    await waitForBlockingXread(observer);
    abortController.abort();
    const claimed = await claimPromise;

    expect(claimed).toMatchObject({ ok: false, error: { code: 'CLAIM_ABORTED' } });
    expect(performance.now() - startedAt).toBeLessThan(500);
    await expect(claim(control, {
      agent_id: agentId,
      registration_id: registrationId,
      claim_request_id: 'claim-blocking-after-abort-0001',
      blocking: false,
      timeout_ms: 1,
      preferred_types: ['code'],
    })).resolves.toMatchObject({ ok: true, data: null });
  });
});
