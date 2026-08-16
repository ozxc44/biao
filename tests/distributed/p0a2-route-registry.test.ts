/**
 * Phase 0a-2 生成式门禁：V2 路由注册表（src/server/v2/routes/registry.ts）
 *
 * 门禁规则（对应任务 Phase 0a-2 目标 4 与主方案 §13.1/§15.6）：
 * 1. 每个 registry 条目必须声明 schema（mutation 必须有 body；带路径参数必须有
 *    params，且覆盖路径中的每个 :param）；
 * 2. 每个条目必须声明凭据作用域，且只允许 §13.1 身份分层中的 V2 凭据；
 *    V1 全局 owner/worker/mcp token 禁入 V2 写面（mutation 断言互斥）；
 * 3. 路径必须以 /v2/ 开头，且不得与 V1 冲突（用真实 createHttpServer 的路由表
 *    交叉验证：V1 不得占用 /v2 前缀，registry 条目也不得命中 V1 路由）；
 * 4. method+path 不得重复（并用真实 Fastify 实例装配一遍证明可注册）；
 * 5. handler 引用的服务前缀必须与条目归属服务一致（方法存在性由编译期
 *    V2RouteHandlerRef 约束）。
 *
 * 新增 V2 路由 = 在 registry 加一条数据；漏 schema/漏凭据/冲突路径会直接红。
 */

import Fastify from 'fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/http.js';
import type { BiaoConfig } from '../../src/types/index.js';
import {
  LEGACY_V1_CREDENTIAL_SCOPES,
  V2_API_PREFIX,
  V2_CREDENTIAL_SCOPES,
  V2_ROUTES,
  countRoutesByService,
  type V2RouteRegistryEntry,
} from '../../src/server/v2/routes/registry.js';

const REDIS_URL = process.env.P0A2_REGISTRY_TEST_REDIS_URL ?? (`redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}/15`);

let redis: Redis;

function config(): BiaoConfig {
  return {
    port: 7331,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: ['/tmp'],
    sqlitePath: '/tmp/biao-p0a2-registry.sqlite',
    streamMaxlen: 1000,
    conflictRetention: 1000,
  };
}

/** 提取路径中的 :param 名称。 */
function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

/** 把 :param 路径展开成判断两路径是否同形（结构冲突检测）。 */
function pathShape(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, ':param');
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

afterAll(async () => {
  await redis.quit().catch(() => undefined);
});

describe('Phase 0a-2 V2 route registry 门禁', () => {
  it('registry 非空且七个领域服务都有路由', () => {
    expect(V2_ROUTES.length).toBeGreaterThan(0);
    const counts = countRoutesByService();
    for (const [service, count] of Object.entries(counts)) {
      expect(count, `${service} 至少应有一条路由`).toBeGreaterThan(0);
    }
  });

  it('每条路由必须以 /v2/ 前缀声明（§15.6：V1/V2 路由明确隔离）', () => {
    for (const entry of V2_ROUTES) {
      expect(
        entry.path.startsWith(`${V2_API_PREFIX}/`),
        `${entry.id} 必须以 ${V2_API_PREFIX}/ 开头`,
      ).toBe(true);
    }
  });

  it('每条路由必须声明 schema，且形状与 method/路径参数匹配', () => {
    for (const entry of V2_ROUTES) {
      const components = Object.keys(entry.schema).filter((key) => {
        const value = (entry.schema as Record<string, unknown>)[key];
        return value !== undefined && value !== null && Object.keys(value as object).length > 0;
      });
      expect(components.length, `${entry.id} 必须至少声明一个非空 schema 组件`).toBeGreaterThan(0);

      if (MUTATION_METHODS.has(entry.method)) {
        // body 或 params 至少其一：JSON mutation 声明 body；二进制流式上传
        // （PUT /v2/artifacts/:id/content）声明 params。
        expect(
          entry.schema.body !== undefined || entry.schema.params !== undefined,
          `${entry.id} 是 mutation，必须声明 body 或 params schema`,
        ).toBe(true);
      }
      const params = pathParams(entry.path);
      if (params.length > 0) {
        expect(entry.schema.params, `${entry.id} 带路径参数，必须声明 params schema`).toBeDefined();
        const required = (entry.schema.params as { required?: string[] }).required ?? [];
        for (const name of params) {
          expect(
            required.includes(name),
            `${entry.id} 的 params schema 必须覆盖 :${name}`,
          ).toBe(true);
        }
      }
    }
  });

  it('mutation 标记必须与 HTTP method 一致', () => {
    for (const entry of V2_ROUTES) {
      expect(
        entry.mutation === MUTATION_METHODS.has(entry.method),
        `${entry.id} 的 mutation 标记与 ${entry.method} 不一致`,
      ).toBe(true);
    }
  });

  it('每条路由必须声明凭据作用域，且只允许 §13.1 的 V2 凭据', () => {
    for (const entry of V2_ROUTES) {
      expect(entry.credentialScopes.length, `${entry.id} 必须声明至少一个凭据作用域`).toBeGreaterThan(0);
      for (const scope of entry.credentialScopes) {
        expect(
          V2_CREDENTIAL_SCOPES.includes(scope),
          `${entry.id} 的作用域 ${scope} 不在 §13.1 V2 身份分层内`,
        ).toBe(true);
      }
    }
  });

  it('V1 全局 owner/worker/mcp 凭据禁入 V2 写面（§13.1/Phase 1 硬门禁）', () => {
    for (const entry of V2_ROUTES) {
      const legacyHits = entry.credentialScopes.filter(
        (scope) => (LEGACY_V1_CREDENTIAL_SCOPES as readonly string[]).includes(scope),
      );
      expect(legacyHits, `${entry.id} 使用了 V1 全局凭据`).toEqual([]);
      if (entry.mutation) {
        // 写面同时不允许空作用域或匿名访问。
        expect(entry.credentialScopes.length, `${entry.id} 是写面，凭据作用域不能为空`).toBeGreaterThan(0);
      }
    }
  });

  it('handler 引用的服务前缀必须与条目归属服务一致', () => {
    for (const entry of V2RouteRegistryEntries()) {
      expect(
        entry.handler.startsWith(`${entry.service}.`),
        `${entry.id} 的 handler ${entry.handler} 不属于 ${entry.service}`,
      ).toBe(true);
    }
  });

  it('method+path 不得重复，且可在真实 Fastify 实例上完成装配', async () => {
    const seen = new Map<string, V2RouteRegistryEntry>();
    for (const entry of V2_ROUTES) {
      const key = `${entry.method} ${pathShape(entry.path)}`;
      expect(seen.has(key), `路由重复：${key}（与 ${seen.get(key)?.id}）`).toBe(false);
      seen.set(key, entry);
    }

    // 用真实 Fastify 装配一遍：路径形状/参数冲突会直接抛 FST_ERR_DUPLICATED_ROUTE。
    const app = Fastify();
    for (const entry of V2_ROUTES) {
      app.route({
        method: entry.method,
        url: entry.path,
        schema: entry.schema as Record<string, unknown>,
        handler: async () => ({ ok: true, data: { registry: entry.id, stub: true } }),
      });
    }
    await app.ready();
    for (const entry of V2_ROUTES) {
      expect(
        app.hasRoute({ method: entry.method, url: entry.path }),
        `${entry.id} 未成功装配`,
      ).toBe(true);
    }
    await app.close();
  });

  it('registry 路径不得与 V1 冲突：V1 路由表不得占用 /v2 前缀', async () => {
    await redis.flushdb();
    const app = await createHttpServer(redis, config());
    try {
      // Fastify v5 没有 app.routes 枚举；printRoutes(commonPrefix:false) 输出完整
      // 路径树。V1 若注册了任何 /v2 路径，树里必然出现 v2 段。
      const routeTree = app.printRoutes({ commonPrefix: false });
      expect(routeTree.length).toBeGreaterThan(0);
      expect(
        /\bv2\b/.test(routeTree),
        'V1 路由表占用了 /v2 前缀（V1/V2 路由必须隔离，§15.6）',
      ).toBe(false);

      // 逐条精确校验：registry 的每条路由在 V1 实例上都必须不存在。
      for (const entry of V2_ROUTES) {
        expect(
          app.hasRoute({ method: entry.method, url: entry.path }),
          `${entry.id} 与 V1 路由冲突`,
        ).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});

/** 迭代辅助（与 V2_ROUTES 同源，仅让断言消息携带类型信息）。 */
function* V2RouteRegistryEntries(): Generator<V2RouteRegistryEntry> {
  for (const entry of V2_ROUTES) yield entry;
}
