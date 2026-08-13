import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentHeartbeat,
  agentOffline,
  agentRegister,
  claim,
  dbRestore,
  setSqliteStore,
} from '../src/server/service.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { keys } from '../src/redis/keys.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';
import { BiaoClient } from '../src/worker/base.js';

const REDIS_URL = process.env.AGENT_EPOCH_TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/1';
const OLD_REGISTRATION = 'old_registration_0123456789abcdef';
const NEW_REGISTRATION = 'new_registration_0123456789abcdef';

let redis: Redis;
let app: Awaited<ReturnType<typeof createHttpServer>>;
let tempDir: string;
let liveUrl: string;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  setSqliteStore(null);
  tempDir = mkdtempSync(join(tmpdir(), 'biao-agent-epoch-'));
  const config: BiaoConfig = {
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: ['/tmp'],
    sqlitePath: join(tempDir, 'biao.sqlite'),
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
  app = await createHttpServer(redis, config);
  liveUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

beforeEach(async () => {
  await redis.flushdb();
  setSqliteStore(null);
});

afterAll(async () => {
  await app.close();
  await redis.flushdb();
  redis.disconnect();
  setSqliteStore(null);
  rmSync(tempDir, { recursive: true, force: true });
});

function racingRedis(luaResult: number): Redis {
  return {
    hgetall: async () => ({
      agent_id: 'racing-agent',
      registration_id: OLD_REGISTRATION,
      current_task: 'old-task',
    }),
    eval: async () => luaResult,
  } as unknown as Redis;
}

describe('agentOffline 竞态合同', () => {
  it.each([
    [-1, 'AGENT_REGISTRATION_CHANGED'],
    [-2, 'AGENT_CURRENT_TASK_CHANGED'],
  ])('Lua 返回 %i 时不谎报 offline=true', async (luaResult, code) => {
    const result = await agentOffline(
      racingRedis(luaResult),
      'racing-agent',
      'worker_exit',
      OLD_REGISTRATION,
    );
    expect(result).toEqual({
      ok: false,
      data: null,
      error: expect.objectContaining({ code }),
    });
  });

  it('新同名会话注册后，旧会话不能心跳复活或把新会话置离线', async () => {
    const oldRegistration = await agentRegister(
      redis,
      'epoch-worker',
      'cli',
      ['code'],
      undefined,
      undefined,
      OLD_REGISTRATION,
    );
    expect(oldRegistration).toMatchObject({
      ok: true,
      data: { agent_id: 'epoch-worker', registration_id: OLD_REGISTRATION },
    });

    const newRegistration = await agentRegister(
      redis,
      'epoch-worker',
      'cli',
      ['code'],
      undefined,
      undefined,
      NEW_REGISTRATION,
    );
    expect(newRegistration).toMatchObject({
      ok: true,
      data: { agent_id: 'epoch-worker', registration_id: NEW_REGISTRATION },
    });

    const staleHeartbeat = await agentHeartbeat(
      redis,
      'epoch-worker',
      OLD_REGISTRATION,
      'stale-task',
    );
    expect(staleHeartbeat).toMatchObject({
      ok: false,
      error: { code: 'AGENT_REGISTRATION_CHANGED' },
    });

    const staleOffline = await agentOffline(
      redis,
      'epoch-worker',
      'worker_exit',
      OLD_REGISTRATION,
    );
    expect(staleOffline).toMatchObject({
      ok: false,
      error: { code: 'AGENT_REGISTRATION_CHANGED' },
    });

    expect(await redis.hgetall(keys.hash.agent('epoch-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'idle',
      current_task: '',
    });

    const currentHeartbeat = await agentHeartbeat(
      redis,
      'epoch-worker',
      NEW_REGISTRATION,
      'fresh-task',
    );
    expect(currentHeartbeat.ok).toBe(true);
    expect(await redis.hgetall(keys.hash.agent('epoch-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'busy',
      current_task: 'fresh-task',
    });
  });

  it('旧注册请求的延迟重试不能在新会话后夺回 epoch', async () => {
    await agentRegister(redis, 'retry-worker', 'cli', ['code'], undefined, undefined, OLD_REGISTRATION);
    const first = await redis.hgetall(keys.hash.agent('retry-worker'));
    await agentRegister(redis, 'retry-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);
    const current = await redis.hgetall(keys.hash.agent('retry-worker'));

    const staleRetry = await agentRegister(
      redis,
      'retry-worker',
      'cli',
      ['code'],
      undefined,
      undefined,
      OLD_REGISTRATION,
    );
    expect(staleRetry).toMatchObject({
      ok: false,
      error: { code: 'AGENT_REGISTRATION_RETIRED' },
    });
    expect(await redis.hgetall(keys.hash.agent('retry-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      registered_at: current.registered_at,
    });

    await agentHeartbeat(redis, 'retry-worker', NEW_REGISTRATION, 'owned-by-new-session');
    const sameEpochRetry = await agentRegister(
      redis,
      'retry-worker',
      'cli',
      ['code'],
      undefined,
      undefined,
      NEW_REGISTRATION,
    );
    expect(sameEpochRetry.ok).toBe(true);
    expect(await redis.hgetall(keys.hash.agent('retry-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      registered_at: current.registered_at,
      status: 'busy',
      current_task: 'owned-by-new-session',
    });
    expect(first.registered_at).toBeTruthy();
  });

  it('一个 epoch 显式离线后，同 epoch 的在途心跳不能再复活它', async () => {
    await agentRegister(redis, 'sealed-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);
    expect((await agentOffline(redis, 'sealed-worker', 'worker_exit', NEW_REGISTRATION)).ok).toBe(true);

    const heartbeat = await agentHeartbeat(redis, 'sealed-worker', NEW_REGISTRATION);
    expect(heartbeat).toMatchObject({ ok: false, error: { code: 'AGENT_ALREADY_OFFLINE' } });
    expect(await redis.hgetall(keys.hash.agent('sealed-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'offline',
    });
  });

  it('未注册和旧 epoch 都不能 claim，只有当前 epoch 能原子写入 task 与 presence', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'epoch-claim-plan',
      title: 'epoch claim plan',
      project_path: '/tmp/epoch-claim',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'epoch-claim-task',
      title: 'epoch claim task',
      type: 'code',
      phase: 'impl',
      assignee: 'auto',
      priority: 5,
      timeout_seconds: 60,
      verify: [],
    }, '# epoch claim', 'epoch-claim-plan', '/tmp/epoch-claim', 5);

    const unregistered = await claim(redis, {
      agent_id: 'epoch-claim-worker',
      registration_id: NEW_REGISTRATION,
      blocking: false,
    } as Parameters<typeof claim>[1] & { registration_id: string });
    expect(unregistered).toMatchObject({ ok: false, error: { code: 'AGENT_NOT_REGISTERED' } });

    await agentRegister(redis, 'epoch-claim-worker', 'cli', ['code'], undefined, undefined, OLD_REGISTRATION);
    await agentRegister(redis, 'epoch-claim-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);

    const staleClaim = await claim(redis, {
      agent_id: 'epoch-claim-worker',
      registration_id: OLD_REGISTRATION,
      blocking: false,
    } as Parameters<typeof claim>[1] & { registration_id: string });
    expect(staleClaim).toMatchObject({ ok: false, error: { code: 'AGENT_REGISTRATION_CHANGED' } });
    expect(await redis.hgetall(keys.hash.task('epoch-claim-task'))).toMatchObject({ status: 'pending' });
    expect(await redis.hgetall(keys.hash.agent('epoch-claim-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'idle',
      current_task: '',
    });

    const currentClaim = await claim(redis, {
      agent_id: 'epoch-claim-worker',
      registration_id: NEW_REGISTRATION,
      blocking: false,
    } as Parameters<typeof claim>[1] & { registration_id: string });
    expect(currentClaim).toMatchObject({ ok: true, data: { task_id: 'epoch-claim-task' } });
    expect(await redis.hgetall(keys.hash.agent('epoch-claim-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'busy',
      current_task: 'epoch-claim-task',
    });
  });

  it('claim 最终提交与新注册按同一 Agent 串行，不能在两者之间形成混合 epoch', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'epoch-race-plan', title: 'epoch race plan', project_path: '/tmp/epoch-race',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'epoch-race-task', title: 'epoch race task', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# epoch race', 'epoch-race-plan', '/tmp/epoch-race', 5);
    await agentRegister(redis, 'epoch-race-worker', 'cli', ['code'], undefined, undefined, OLD_REGISTRATION);

    let releaseFinalClaim!: () => void;
    let notifyFinalClaim!: () => void;
    const finalClaimStarted = new Promise<void>((resolve) => { notifyFinalClaim = resolve; });
    const finalClaimGate = new Promise<void>((resolve) => { releaseFinalClaim = resolve; });
    const delayedRedis = new Proxy(redis, {
      get(target, property, receiver) {
        if (property === 'eval') {
          return async (script: string, ...args: unknown[]) => {
            if (script.includes('local registration_id = ARGV[1]')) {
              notifyFinalClaim();
              await finalClaimGate;
            }
            return (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const staleClaimPromise = claim(delayedRedis, {
      agent_id: 'epoch-race-worker', registration_id: OLD_REGISTRATION, blocking: false,
    });
    await finalClaimStarted;
    let registerSettled = false;
    const newerPromise = agentRegister(
      redis, 'epoch-race-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION,
    ).finally(() => { registerSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registerSettled).toBe(false);
    releaseFinalClaim();

    await expect(staleClaimPromise).resolves.toMatchObject({
      ok: true,
      data: { task_id: 'epoch-race-task' },
    });
    await expect(newerPromise).resolves.toMatchObject({ ok: true, data: { registration_id: NEW_REGISTRATION } });
    expect(await redis.exists(keys.string.lease('epoch-race-task'))).toBe(1);
    expect(await redis.hgetall(keys.hash.task('epoch-race-task'))).toMatchObject({
      status: 'running', claimed_by: 'epoch-race-worker',
    });
    expect(await redis.hgetall(keys.hash.agent('epoch-race-worker'))).toMatchObject({
      registration_id: NEW_REGISTRATION,
      status: 'idle',
      current_task: '',
    });
  });

  it('同一 claim_request_id 可重放服务端已提交的完整 claim，新 request 仍返回 busy', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'claim-replay-plan', title: 'claim replay plan', project_path: '/tmp/claim-replay',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'claim-replay-task', title: 'claim replay task', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# claim replay', 'claim-replay-plan', '/tmp/claim-replay', 5);
    await agentRegister(redis, 'claim-replay-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);

    const first = await claim(redis, {
      agent_id: 'claim-replay-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_request_0123456789abcdef', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string });
    expect(first).toMatchObject({
      ok: true,
      data: {
        task_id: 'claim-replay-task',
        claim_token: expect.any(String),
        project_path: '/tmp/claim-replay',
      },
    });
    expect(await redis.hexists(keys.hash.agent('claim-replay-worker'), 'claim_request_payload')).toBe(0);

    const replay = await claim(redis, {
      agent_id: 'claim-replay-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_request_0123456789abcdef', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string });
    expect(replay).toEqual(first);

    const differentRequest = await claim(redis, {
      agent_id: 'claim-replay-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_request_fedcba9876543210', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string });
    expect(differentRequest).toMatchObject({ ok: false, error: { code: 'AGENT_BUSY' } });
  });

  it('相同 claim_request_id 并发穿过首次 replay 时等待 owner 提交并重放同一 token', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'claim-concurrent-plan', title: 'claim concurrent plan', project_path: '/tmp/claim-concurrent',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'claim-concurrent-task', title: 'claim concurrent task', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# claim concurrent', 'claim-concurrent-plan', '/tmp/claim-concurrent', 5);
    await agentRegister(redis, 'claim-concurrent-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);

    let releaseFinalClaim!: () => void;
    let finalClaimStarted!: () => void;
    const finalClaimGate = new Promise<void>((resolve) => { releaseFinalClaim = resolve; });
    const finalClaimReached = new Promise<void>((resolve) => { finalClaimStarted = resolve; });
    let paused = false;
    const delayedRedis = new Proxy(redis, {
      get(target, property, receiver) {
        if (property === 'eval') {
          return async (script: string, ...args: unknown[]) => {
            if (!paused && script.includes('local claim_attempt_id')) {
              paused = true;
              finalClaimStarted();
              await finalClaimGate;
            }
            return (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const request = {
      agent_id: 'claim-concurrent-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_concurrent_request_0123456789', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string };

    const owner = claim(delayedRedis, request);
    await finalClaimReached;
    let retrySettled = false;
    const retry = claim(redis, request).finally(() => { retrySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(retrySettled).toBe(false);
    releaseFinalClaim();

    const [ownerResult, retryResult] = await Promise.all([owner, retry]);
    expect(ownerResult).toMatchObject({ ok: true, data: { task_id: 'claim-concurrent-task' } });
    expect(retryResult).toEqual(ownerResult);
    expect(retryResult.data?.claim_token).toBe(ownerResult.data?.claim_token);
  });

  it('首个 claim owner 卡死后 reservation TTL 允许同 request 接管且旧 owner 最终重放', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'claim-takeover-plan', title: 'claim takeover plan', project_path: '/tmp/claim-takeover',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'claim-takeover-task', title: 'claim takeover task', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# claim takeover', 'claim-takeover-plan', '/tmp/claim-takeover', 5);
    await agentRegister(redis, 'claim-takeover-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);

    let slowScanStarted!: () => void;
    const slowScanReached = new Promise<void>((resolve) => { slowScanStarted = resolve; });
    let reservationCreated = false;
    let scanPaused = false;
    const delayedRedis = new Proxy(redis, {
      get(target, property, receiver) {
        if (property === 'eval') {
          return async (script: string, ...args: unknown[]) => {
            if (script.includes('RENEW_AGENT_CLAIM_RESERVATION_TEST_MARKER')) {
              // 模拟 owner 的低频续租进程消失；原 reservation 依靠 TTL 自动释放。
              return 0;
            }
            const result = await (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
            if (script.includes('RESERVE_AGENT_CLAIM_TEST_MARKER') && Array.isArray(result) && String(result[0]) === 'OWNER') {
              reservationCreated = true;
            }
            return result;
          };
        }
        if (property === 'zrange') {
          return async (...args: unknown[]) => {
            if (reservationCreated && !scanPaused && args[0] === keys.zset.status.pending) {
              scanPaused = true;
              slowScanStarted();
              await new Promise((resolve) => setTimeout(resolve, 3_250));
            }
            return (target.zrange as (...callArgs: unknown[]) => Promise<string[]>).call(target, ...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const request = {
      agent_id: 'claim-takeover-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_takeover_request_0123456789', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string };

    const staleOwner = claim(delayedRedis, request);
    await slowScanReached;
    const takeoverPromise = claim(redis, request);
    const takeover = await takeoverPromise;
    expect(takeover).toMatchObject({ ok: true, data: { task_id: 'claim-takeover-task' } });

    await expect(staleOwner).resolves.toEqual(takeover);
    expect(await redis.get(keys.string.lease('claim-takeover-task'))).toBe(takeover.data?.claim_token);
  }, 10_000);

  it('依赖检查超过 reservation TTL 时 owner 低频续租且并发同 request 最终重放', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'claim-slow-plan', title: 'claim slow plan', project_path: '/tmp/claim-slow',
    }, 2);
    await writeTaskToRedis(redis, {
      task_id: 'claim-slow-dependency', title: 'dependency', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# dependency', 'claim-slow-plan', '/tmp/claim-slow', 5);
    await redis.hset(keys.hash.task('claim-slow-dependency'), {
      status: 'done', pm_review_status: 'accepted', done_at: String(Date.now()),
    });
    await redis.zrem(keys.zset.status.pending, 'claim-slow-dependency');
    await redis.zadd(keys.zset.status.done, Date.now(), 'claim-slow-dependency');
    await writeTaskToRedis(redis, {
      task_id: 'claim-slow-task', title: 'slow claim', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
      depends_on: ['claim-slow-dependency'],
    }, '# slow claim', 'claim-slow-plan', '/tmp/claim-slow', 5);
    await agentRegister(redis, 'claim-slow-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION);

    let reservationCreated = false;
    let slowDependencyStarted!: () => void;
    const dependencyReached = new Promise<void>((resolve) => { slowDependencyStarted = resolve; });
    let delayed = false;
    const slowRedis = new Proxy(redis, {
      get(target, property, receiver) {
        if (property === 'eval') {
          return async (script: string, ...args: unknown[]) => {
            const result = await (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
            if (script.includes('RESERVE_AGENT_CLAIM_TEST_MARKER') && Array.isArray(result) && String(result[0]) === 'OWNER') {
              reservationCreated = true;
            }
            return result;
          };
        }
        if (property === 'hgetall') {
          return async (key: string) => {
            if (reservationCreated && !delayed && key === keys.hash.task('claim-slow-dependency')) {
              delayed = true;
              slowDependencyStarted();
              await new Promise((resolve) => setTimeout(resolve, 3_250));
            }
            return target.hgetall(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const request = {
      agent_id: 'claim-slow-worker', registration_id: NEW_REGISTRATION,
      claim_request_id: 'claim_slow_request_0123456789', blocking: false,
    } as Parameters<typeof claim>[1] & { claim_request_id: string };

    const owner = claim(slowRedis, request);
    await dependencyReached;
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    expect(await redis.pttl(keys.hash.claimReservation('claim-slow-worker'))).toBeGreaterThan(0);
    const retry = claim(redis, request);
    const [ownerResult, retryResult] = await Promise.all([owner, retry]);
    expect(ownerResult).toMatchObject({ ok: true, data: { task_id: 'claim-slow-task' } });
    expect(retryResult).toEqual(ownerResult);
  }, 10_000);

  it('真实 HTTP 首次 claim 已提交但响应丢失时，BiaoClient 重试取回原 token', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'http-claim-replay-plan', title: 'http claim replay plan', project_path: '/tmp/http-claim-replay',
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'http-claim-replay-task', title: 'http claim replay task', type: 'code', phase: 'impl',
      assignee: 'auto', priority: 5, timeout_seconds: 60, verify: [],
    }, '# http claim replay', 'http-claim-replay-plan', '/tmp/http-claim-replay', 5);

    const client = new BiaoClient(liveUrl, 'http-claim-replay-worker');
    await expect(client.register('cli', ['code'])).resolves.toMatchObject({ ok: true });
    const realFetch = globalThis.fetch;
    let claimAttempts = 0;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (String(input).endsWith('/claim') && ++claimAttempts === 1) {
        // 先等真实服务端响应（表明 Redis 已提交），再模拟字节未送达客户端。
        await response.arrayBuffer();
        const error = new Error('fetch failed') as Error & { cause?: { code: string } };
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return response;
    });
    try {
      const claimed = await client.claim({ blocking: false });
      expect(claimAttempts).toBe(2);
      expect(claimed).toMatchObject({
        ok: true,
        data: { task_id: 'http-claim-replay-task', claim_token: expect.any(String) },
      });
      expect(await redis.get(keys.string.lease('http-claim-replay-task'))).toBe(claimed.data!.claim_token);

      // 新的业务 claim 调用使用新 request id，不得把旧任务误当重放。
      await expect(client.claim({ blocking: false })).resolves.toMatchObject({
        ok: false,
        error: { code: 'AGENT_BUSY' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('SQLite 恢复会重建当前代次与 retired 历史，灾前旧 register 不能夺回新代次', async () => {
    const store = new SqliteStore(join(tempDir, 'agent-epochs.sqlite'));
    setSqliteStore(store);
    try {
      await agentRegister(redis, 'durable-worker', 'cli', ['code'], undefined, ['/tmp'], OLD_REGISTRATION);
      await agentRegister(redis, 'durable-worker', 'cli', ['code'], undefined, ['/tmp'], NEW_REGISTRATION);

      await redis.flushdb();
      await dbRestore(redis, store);

      const restored = await redis.hgetall(keys.hash.agent('durable-worker'));
      expect(restored).toMatchObject({
        registration_id: NEW_REGISTRATION,
        registration_generation: '2',
        status: 'offline',
      });
      expect(await redis.sismember(
        'biao:v1:set:agent_registration_ids:durable-worker',
        OLD_REGISTRATION,
      )).toBe(1);

      // restore 可让当前 ID 的 register 传输重试幂等返回，但不得藉此
      // 复活灾前进程；心跳仍必须失败，新进程要生成新 epoch。
      const currentRetry = await agentRegister(
        redis, 'durable-worker', 'cli', ['code'], undefined, ['/tmp'], NEW_REGISTRATION,
      );
      expect(currentRetry).toMatchObject({
        ok: true,
        data: { registration_id: NEW_REGISTRATION, registration_generation: 2 },
      });
      expect(await redis.hget(keys.hash.agent('durable-worker'), 'status')).toBe('offline');
      await expect(agentHeartbeat(redis, 'durable-worker', NEW_REGISTRATION)).resolves.toMatchObject({
        ok: false,
        error: { code: 'AGENT_ALREADY_OFFLINE' },
      });

      const staleRetry = await agentRegister(
        redis, 'durable-worker', 'cli', ['code'], undefined, ['/tmp'], OLD_REGISTRATION,
      );
      expect(staleRetry).toMatchObject({ ok: false, error: { code: 'AGENT_REGISTRATION_RETIRED' } });
      expect(await redis.hget(keys.hash.agent('durable-worker'), 'registration_id')).toBe(NEW_REGISTRATION);
    } finally {
      setSqliteStore(null);
      store.close();
    }
  });

  it('同一 Agent 并发 register 在 SQLite 与 Redis 两层保持同一提交顺序', async () => {
    const store = new SqliteStore(join(tempDir, 'agent-generation-race.sqlite'));
    setSqliteStore(store);
    try {
      let releaseOld!: () => void;
      let oldReached!: () => void;
      const oldAtRedis = new Promise<void>((resolve) => { oldReached = resolve; });
      const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
      const delayedRedis = new Proxy(redis, {
        get(target, property, receiver) {
          if (property === 'eval') {
            return async (script: string, ...args: unknown[]) => {
              if (script.includes('local requested_generation') && args.includes(OLD_REGISTRATION)) {
                oldReached();
                await oldGate;
              }
              return (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const oldPromise = agentRegister(
        delayedRedis, 'generation-worker', 'cli', [], undefined, undefined, OLD_REGISTRATION,
      );
      await oldReached;
      let newerSettled = false;
      const newerPromise = agentRegister(
        redis, 'generation-worker', 'cli', [], undefined, undefined, NEW_REGISTRATION,
      ).finally(() => { newerSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(newerSettled).toBe(false);
      releaseOld();
      await expect(oldPromise).resolves.toMatchObject({ ok: true, data: { registration_generation: 1 } });
      await expect(newerPromise).resolves.toMatchObject({ ok: true, data: { registration_generation: 2 } });
      expect(await redis.hgetall(keys.hash.agent('generation-worker'))).toMatchObject({
        registration_id: NEW_REGISTRATION,
        registration_generation: '2',
      });
    } finally {
      setSqliteStore(null);
      store.close();
    }
  });

  it('新 generation SQLite 已提交但 Redis 持续失败时旧生命周期 fail closed，同 ID 重试发布后恢复', async () => {
    const store = new SqliteStore(join(tempDir, 'agent-generation-publish-failure.sqlite'));
    setSqliteStore(store);
    try {
      await agentRegister(redis, 'publish-failure-worker', 'cli', ['code'], undefined, undefined, OLD_REGISTRATION);
      const failingRedis = new Proxy(redis, {
        get(target, property, receiver) {
          if (property === 'eval') {
            return async (script: string, ...args: unknown[]) => {
              if (script.includes('local requested_generation') && args.includes(NEW_REGISTRATION)) {
                throw new Error('simulated Redis publication outage');
              }
              return (target.eval as (...callArgs: unknown[]) => Promise<unknown>).call(target, script, ...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await expect(agentRegister(
        failingRedis, 'publish-failure-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION,
      )).rejects.toThrow('simulated Redis publication outage');
      expect(await redis.hget(keys.hash.agent('publish-failure-worker'), 'registration_id')).toBe(OLD_REGISTRATION);

      await expect(agentHeartbeat(redis, 'publish-failure-worker', OLD_REGISTRATION)).resolves.toMatchObject({
        ok: false, error: { code: 'AGENT_REGISTRATION_CHANGED' },
      });
      await expect(claim(redis, {
        agent_id: 'publish-failure-worker', registration_id: OLD_REGISTRATION,
        claim_request_id: 'claim_publish_failure_0123456789', blocking: false,
      } as Parameters<typeof claim>[1])).resolves.toMatchObject({
        ok: false, error: { code: 'AGENT_REGISTRATION_CHANGED' },
      });
      await expect(agentOffline(
        redis, 'publish-failure-worker', 'worker_exit', OLD_REGISTRATION,
      )).resolves.toMatchObject({
        ok: false, error: { code: 'AGENT_REGISTRATION_CHANGED' },
      });

      await expect(agentRegister(
        redis, 'publish-failure-worker', 'cli', ['code'], undefined, undefined, NEW_REGISTRATION,
      )).resolves.toMatchObject({
        ok: true, data: { registration_id: NEW_REGISTRATION, registration_generation: 2 },
      });
      await expect(agentHeartbeat(redis, 'publish-failure-worker', NEW_REGISTRATION)).resolves.toMatchObject({ ok: true });
    } finally {
      setSqliteStore(null);
      store.close();
    }
  });

  it('HTTP 对旧自定义 Worker 只兼容首次 register，后续生命周期请求严格要求返回的 epoch', async () => {
    const registered = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { agent_id: 'legacy-http-worker', agent_type: 'custom', capabilities: ['code'] },
    });
    expect(registered.statusCode).toBe(200);
    const registrationId = registered.json().data.registration_id as string;
    expect(registrationId).toMatch(/^reg_[a-f0-9]{32}$/);

    const noEpochHeartbeat = await app.inject({
      method: 'POST',
      url: '/heartbeat',
      payload: { agent_id: 'legacy-http-worker', current_task: '' },
    });
    expect(noEpochHeartbeat.statusCode).toBe(400);
    expect(noEpochHeartbeat.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

    const noEpochClaim = await app.inject({
      method: 'POST',
      url: '/claim',
      payload: { agent_id: 'legacy-http-worker', blocking: false },
    });
    expect(noEpochClaim.statusCode).toBe(400);

    const noRequestIdClaim = await app.inject({
      method: 'POST',
      url: '/claim',
      payload: { agent_id: 'legacy-http-worker', registration_id: registrationId, blocking: false },
    });
    expect(noRequestIdClaim.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: 'POST',
      url: '/heartbeat',
      payload: { agent_id: 'legacy-http-worker', registration_id: registrationId, surprise: true },
    });
    expect(unknownField.statusCode).toBe(400);

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/heartbeat',
      payload: { agent_id: 'legacy-http-worker', registration_id: registrationId, current_task: '' },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ ok: true, data: { agent_id: 'legacy-http-worker' } });

    const offline = await app.inject({
      method: 'POST',
      url: '/agent/offline',
      payload: { agent_id: 'legacy-http-worker', registration_id: registrationId, reason: 'worker_exit' },
    });
    expect(offline.statusCode).toBe(200);
    expect(offline.json()).toMatchObject({ ok: true, data: { offline: true } });
  });
});
