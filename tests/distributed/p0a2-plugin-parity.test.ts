/**
 * Phase 0a-2 等价性测试：共享横切 plugin（src/server/http-plugins.ts）
 *
 * 断言抽取到 http-plugins.ts 的三个横切钩子与 Phase 0a-2 之前 http.ts 内联实现
 * 行为一致（401 鉴权 / 403 Worker 作用域 / maintenance permit / preSerialization
 * barrier / permit 生命周期）。断言口径与既有套件一致：
 * - tests/http-auth.test.ts（UNAUTHORIZED / WORKER_SCOPE_DENIED 的精确响应体）；
 * - tests/restore-maintenance-gate.test.ts（RESTORE_IN_PROGRESS 409 /
 *   RESTORE_FAILED 503 / 诊断口豁免）。
 * 此外，http.ts 全量走同一 plugin（createHttpServer 装配），上述两个 V1 套件
 * 继续作为整体等价性的回归门禁。
 *
 * 装配方式与 http.ts 相同：在目标封装上下文内直接调用 plugin 函数
 * （不经过 app.register，避免 Fastify 封装上下文把钩子隔离到子作用域）。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossCuttingApiPlugin } from '../../src/server/http-plugins.js';
import {
  acquireRestoreLock,
  activeLocalMutationCount,
  releaseRestoreLock,
} from '../../src/server/maintenance.js';
import { keys } from '../../src/redis/keys.js';

const REDIS_URL = process.env.P0A2_PARITY_TEST_REDIS_URL ?? (`redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}/15`);
const TOKEN = 'p0a2-plugin-parity-owner-token';
const WORKER_TOKEN = createHmac('sha256', TOKEN).update('biao-worker-api-token-v1').digest('hex');

let redis: Redis;

/** 构建与 http.ts 装配方式一致的裸应用：横切 plugin + 模拟 V1 形状的路由桩。 */
async function buildApp(options: { apiToken?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await crossCuttingApiPlugin(app, {
    redis,
    apiToken: options.apiToken,
    workerApiToken: options.apiToken ? createHmac('sha256', options.apiToken).update('biao-worker-api-token-v1').digest('hex') : undefined,
    host: '127.0.0.1',
  });

  const stub = async () => ({ ok: true, data: { stub: true } });
  // 公开诊断口（onRequest 豁免；preHandler 读门禁豁免）。
  app.get('/health', stub);
  app.get('/version', stub);
  // 前端入口（Accept: text/html 时豁免鉴权）。
  app.get('/', stub);
  // PM 面（Worker 凭据禁入）。
  app.get('/plans', stub);
  app.post('/plan/create', stub);
  // Worker 数据面（workerRequestAllowed 白名单）。
  app.post('/claim', stub);
  app.get('/ownership', stub);
  app.get('/task/:task_id', stub);
  // watchdog auto_fix 是 writer；Worker 凭据同样禁入（fail-closed）。
  app.get('/watchdog', stub);
  // 中途落屏障：handler 执行时才让 restore barrier 出现，用于验证 preSerialization。
  app.get('/mid-flight-gate', async () => {
    await redis.set(
      keys.string.dbRestoreBarrier,
      JSON.stringify({ phase: 'failed', owner: 'mid-flight-owner' }),
    );
    return { ok: true, data: { leaked: true } };
  });
  return app;
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  await redis.flushdb();
});

describe('Phase 0a-2 plugin 等价性：onRequest 鉴权', () => {
  it('缺少或错误的 Bearer token 返回精确的 401 UNAUTHORIZED 响应体', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      for (const headers of [undefined, { authorization: 'Bearer wrong-token' }]) {
        const response = await app.inject({ method: 'GET', url: '/plans', headers });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          ok: false,
          data: null,
          error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer API token' },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('公开读口与前端入口豁免鉴权', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/version' })).statusCode).toBe(200);
      expect(
        (await app.inject({
          method: 'GET',
          url: '/',
          headers: { accept: 'text/html' },
        })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('auth_disabled（未配置 apiToken）时放行', async () => {
    const app = await buildApp({ apiToken: undefined });
    try {
      const response = await app.inject({ method: 'GET', url: '/plans' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('Worker token 只能进执行数据面，PM 面返回精确的 403 WORKER_SCOPE_DENIED', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      // 数据面白名单放行。
      expect((await app.inject({ method: 'POST', url: '/claim', headers: { authorization: `Bearer ${WORKER_TOKEN}` }, payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/ownership?path=/x', headers: { authorization: `Bearer ${WORKER_TOKEN}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/task/t-1', headers: { authorization: `Bearer ${WORKER_TOKEN}` } })).statusCode).toBe(200);

      // PM 读写面与未来新增端点一律 fail-closed。
      for (const request of [
        { method: 'GET', url: '/plans' },
        { method: 'POST', url: '/plan/create', payload: {} },
        { method: 'GET', url: '/watchdog?auto_fix=true' },
      ]) {
        const response = await app.inject({
          ...request,
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
          ok: false,
          data: null,
          error: { code: 'WORKER_SCOPE_DENIED', message: 'Worker 凭据无权执行 PM/Owner 控制面操作' },
        });
      }

      // Owner token 全通。
      expect((await app.inject({ method: 'GET', url: '/plans', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('Phase 0a-2 plugin 等价性：preHandler 维护屏障 + mutation permit', () => {
  it('restore 进行中：普通读返回 409 RESTORE_IN_PROGRESS，写返回 409 permit 拒绝', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    const restore = await acquireRestoreLock(redis, 'parity-restore-owner');
    expect(restore.ok).toBe(true);
    try {
      const read = await app.inject({ method: 'GET', url: '/plans', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(read.statusCode).toBe(409);
      expect(read.json().error).toMatchObject({ code: 'RESTORE_IN_PROGRESS' });

      const write = await app.inject({ method: 'POST', url: '/plan/create', headers: { authorization: `Bearer ${TOKEN}` }, payload: {} });
      expect(write.statusCode).toBe(409);
      expect(write.json().error).toMatchObject({ code: 'RESTORE_IN_PROGRESS' });

      // 诊断口豁免读门禁（health 由自身 handler 表达 not-ready）。
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await releaseRestoreLock(redis, 'parity-restore-owner');
      await app.close();
    }
  });

  it('restore 失败屏障：读返回 503 RESTORE_FAILED', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      await redis.set(
        keys.string.dbRestoreBarrier,
        JSON.stringify({ phase: 'failed', owner: 'parity-failed-owner' }),
      );
      const response = await app.inject({ method: 'GET', url: '/plans', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({ code: 'RESTORE_FAILED' });
    } finally {
      await app.close();
    }
  });

  it('mutation permit 在请求 settle 后按 owner 释放，本地写计数归零', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      const response = await app.inject({ method: 'POST', url: '/plan/create', headers: { authorization: `Bearer ${TOKEN}` }, payload: {} });
      expect(response.statusCode).toBe(200);

      // onResponse 已释放：permit zset 与进程内写计数都不能残留。
      // （inject 返回先于 onResponse 钩子的 finally 微任务，等它收口再断言。）
      expect(await redis.zcard(keys.zset.maintenanceMutationPermits)).toBe(0);
      await vi.waitFor(() => expect(activeLocalMutationCount()).toBe(0));

      // 释放后的下一个 writer 能立即取到 permit。
      const app2 = await buildApp({ apiToken: TOKEN });
      try {
        const again = await app2.inject({ method: 'POST', url: '/plan/create', headers: { authorization: `Bearer ${TOKEN}` }, payload: {} });
        expect(again.statusCode).toBe(200);
        expect(await redis.zcard(keys.zset.maintenanceMutationPermits)).toBe(0);
      } finally {
        await app2.close();
      }
    } finally {
      await app.close();
    }
  });
});

describe('Phase 0a-2 plugin 等价性：preSerialization 二次门控', () => {
  it('读先开始、restore 后进入的窗口被 barrier 关闭（响应被替换为门禁错误）', async () => {
    const app = await buildApp({ apiToken: TOKEN });
    try {
      // /mid-flight-gate 的 handler 在执行中落 failed barrier 并试图返回数据；
      // preSerialization 必须丢弃 payload，改为 503 + RESTORE_FAILED。
      const response = await app.inject({ method: 'GET', url: '/mid-flight-gate', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({ code: 'RESTORE_FAILED' });
      expect(body.data?.leaked).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
