/**
 * Ownership HTTP 安全契约。
 *
 * 这个测试刻意使用独立 Redis DB 12，避免与其它并行回归套件的 flushdb 相互影响。
 * 只从 HTTP 边界验证：声明/释放必须绑定当前 running holder 的 lease token，调用者
 * 不能指定 priority，也不能删除别人的 registry 记录。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/server/http.js';
import { setSqliteStore } from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';
import type { BiaoConfig } from '../src/types/index.js';

const REDIS_URL = process.env.OWNERSHIP_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/12';
const PROJECT_PATH = '/tmp/biao-ownership-contract';

type Envelope<T = unknown> = {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string };
};

let redis: Redis;
let app: Awaited<ReturnType<typeof createHttpServer>>;
let tempDir: string;

function config(): BiaoConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: [PROJECT_PATH],
    sqlitePath: join(tempDir, 'biao.sqlite'),
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

async function post<T = unknown>(path: string, payload: unknown): Promise<{ status: number; body: Envelope<T> }> {
  const response = await app.inject({ method: 'POST', url: path, payload });
  return { status: response.statusCode, body: response.json() as Envelope<T> };
}

async function seedAndClaim(taskId: string, agentId: string, priority = 3) {
  await writePlanToRedis(redis, {
    plan_id: 'ownership-contract-plan',
    title: 'ownership contract',
    project_path: PROJECT_PATH,
    default_priority: priority,
  }, 1);
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: agentId,
    priority,
    timeout_seconds: 120,
    verify: [],
  }, `# ${taskId}`, 'ownership-contract-plan', PROJECT_PATH, priority);
  expect((await post('/register', {
    agent_id: agentId,
    agent_type: 'cli',
    capabilities: ['code'],
    projects: [PROJECT_PATH],
  })).body.ok).toBe(true);
  const claimed = await post<{ task_id: string; claim_token: string }>('/claim', {
    agent_id: agentId,
    blocking: false,
    preferred_project: PROJECT_PATH,
  });
  expect(claimed.body).toMatchObject({ ok: true, data: { task_id: taskId } });
  return claimed.body.data!;
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-ownership-contract-'));
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  setSqliteStore(null);
  app = await createHttpServer(redis, config());
});

beforeEach(async () => {
  setSqliteStore(null);
  await redis.flushdb();
});

afterAll(async () => {
  await app.close();
  await redis.flushdb();
  redis.disconnect();
  setSqliteStore(null);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ownership declaration/release current-holder contract', () => {
  it('HTTP claim 接受 preferred_plan_ids，并在同项目内于服务端过滤计划', async () => {
    await writePlanToRedis(redis, {
      plan_id: 'http-allowed-plan', title: 'allowed', project_path: PROJECT_PATH, default_priority: 1,
    }, 1);
    await writePlanToRedis(redis, {
      plan_id: 'http-other-plan', title: 'other', project_path: PROJECT_PATH, default_priority: 10,
    }, 1);
    await writeTaskToRedis(redis, {
      task_id: 'http-allowed-task', title: 'allowed', type: 'code', phase: 'impl', priority: 1,
      timeout_seconds: 60, verify: [],
    }, '# allowed', 'http-allowed-plan', PROJECT_PATH, 1);
    await writeTaskToRedis(redis, {
      task_id: 'http-other-task', title: 'other', type: 'code', phase: 'impl', priority: 10,
      timeout_seconds: 60, verify: [],
    }, '# other', 'http-other-plan', PROJECT_PATH, 10);
    expect((await post('/register', {
      agent_id: 'http-plan-filter-worker', agent_type: 'cli', capabilities: ['code'], projects: [PROJECT_PATH],
    })).body.ok).toBe(true);

    const claimed = await post<{ task_id: string; plan_id: string }>('/claim', {
      agent_id: 'http-plan-filter-worker',
      blocking: false,
      preferred_project: PROJECT_PATH,
      preferred_plan_ids: ['http-allowed-plan'],
    });

    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({
      ok: true,
      data: { task_id: 'http-allowed-task', plan_id: 'http-allowed-plan' },
    });
  });

  it('requires claim_token and derives declaration priority from the running task', async () => {
    const task = await seedAndClaim('ownership-owner', 'worker-owner', 3);
    const missingToken = await post('/ownership/declare', {
      agent_id: 'worker-owner', task_id: task.task_id, files: ['src/owner/**'], force: true,
    });
    expect(missingToken.status).toBe(400);

    const declared = await post('/ownership/declare', {
      agent_id: 'worker-owner',
      task_id: task.task_id,
      claim_token: task.claim_token,
      files: ['src/owner/**'],
      force: true,
    });
    expect(declared.body).toMatchObject({ ok: true, data: { declared: 1 } });
    const record = JSON.parse((await redis.hget(keys.hash.fileOwnership, 'src/owner/**'))!);
    expect(record).toMatchObject({ agent_id: 'worker-owner', task_id: task.task_id, priority: 3 });
  });

  it('rejects forged agent, stale token, and non-running holder without changing the registry', async () => {
    const task = await seedAndClaim('ownership-guarded', 'worker-guarded', 5);
    const glob = 'src/guarded/**';
    expect((await post('/ownership/declare', {
      agent_id: 'worker-guarded', task_id: task.task_id, claim_token: task.claim_token, files: [glob], force: true,
    })).body.ok).toBe(true);
    const before = await redis.hget(keys.hash.fileOwnership, glob);

    const forgedAgent = await post('/ownership/release', {
      agent_id: 'attacker', task_id: task.task_id, claim_token: task.claim_token, files: [glob],
    });
    expect(forgedAgent.body.error?.code).toBe('CLAIM_OWNER_MISMATCH');
    expect(await redis.hget(keys.hash.fileOwnership, glob)).toBe(before);

    const staleToken = await post('/ownership/release', {
      agent_id: 'worker-guarded', task_id: task.task_id, claim_token: 'stale-token', files: [glob],
    });
    expect(staleToken.body.error?.code).toBe('CLAIM_TOKEN_INVALID');
    expect(await redis.hget(keys.hash.fileOwnership, glob)).toBe(before);

    await redis.hset(keys.hash.task(task.task_id), 'status', 'pending');
    const nonRunning = await post('/ownership/release', {
      agent_id: 'worker-guarded', task_id: task.task_id, claim_token: task.claim_token, files: [glob],
    });
    expect(nonRunning.body.error?.code).toBe('TASK_NOT_RUNNING');
    expect(await redis.hget(keys.hash.fileOwnership, glob)).toBe(before);
  });

  it('only deletes a matching owner/task glob and makes repeated holder release idempotent', async () => {
    const task = await seedAndClaim('ownership-release', 'worker-release', 5);
    const ownGlob = 'src/release/**';
    const otherGlob = 'src/other/**';
    expect((await post('/ownership/declare', {
      agent_id: 'worker-release', task_id: task.task_id, claim_token: task.claim_token, files: [ownGlob], force: true,
    })).body.ok).toBe(true);
    await redis.hset(keys.hash.fileOwnership, otherGlob, JSON.stringify({
      agent_id: 'other-worker', task_id: 'other-task', priority: 9, declared_at: Date.now(), expires_at: Date.now() + 60_000,
    }));
    await redis.sadd(keys.set.ownerByAgent('other-worker'), otherGlob);

    const first = await post('/ownership/release', {
      agent_id: 'worker-release', task_id: task.task_id, claim_token: task.claim_token, files: [ownGlob, otherGlob],
    });
    expect(first.body).toMatchObject({ ok: true, data: { released: 1 } });
    expect(await redis.hget(keys.hash.fileOwnership, ownGlob)).toBeNull();
    expect(await redis.hget(keys.hash.fileOwnership, otherGlob)).not.toBeNull();

    const repeated = await post('/ownership/release', {
      agent_id: 'worker-release', task_id: task.task_id, claim_token: task.claim_token, files: [ownGlob],
    });
    expect(repeated.body).toMatchObject({ ok: true, data: { released: 0 } });
  });
});
