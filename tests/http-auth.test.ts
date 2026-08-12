import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';

function config(overrides: Partial<BiaoConfig> = {}): BiaoConfig {
  return {
    port: 7331,
    host: '127.0.0.1',
    redisUrl: 'redis://localhost:6379/15',
    authEnabled: true,
    apiToken: 'test-secret',
    workspaceRoots: ['/tmp/biao-workspace'],
    sqlitePath: '/tmp/biao-http-auth.sqlite',
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
    ...overrides,
  };
}

function fakeRedis(): Redis {
  return {
    ping: async () => 'PONG',
    hgetall: async () => ({}),
    // 产品代码对未知/损坏门禁 fail closed；测试替身必须显式模拟 OPEN/ACQUIRED。
    eval: async (script: string) => {
      if (script.includes("return 'OPEN'")) return 'OPEN';
      if (script.includes("return 'ACQUIRED'")) return 'ACQUIRED';
      return 1;
    },
    zrem: async () => 1,
  } as unknown as Redis;
}

describe('HTTP bearer authentication', () => {
  it('API 目录向已认证客户端列出 CLI 已使用的版本与活跃 ownership 路由', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'application/json', authorization: 'Bearer test-secret' },
    });

    expect(response.json()).toMatchObject({
      ok: true,
      endpoints: {
        version: 'GET /version',
        ownership_active: 'GET /ownership/active',
        resolution_get: 'GET /task/:task_id/resolution',
        resolution_post: 'POST /task/:task_id/resolution',
      },
    });
    await app.close();
  });

  it('rejects mutation routes without a bearer token using the API error contract', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({ method: 'POST', url: '/task/example/reset', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      data: null,
      error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer API token' },
    });
    await app.close();
  });

  it('accepts the configured token for a mutation route', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({
      method: 'POST',
      url: '/task/example/reset',
      headers: { authorization: 'Bearer test-secret' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().error?.code).toBe('TASK_NOT_FOUND');
    await app.close();
  });

  it.each([
    '/status',
    '/api/status',
    '/ownership/active',
    '/api/ownership/active',
    '/events/stream',
    '/api/events/stream',
  ])(
    'rejects anonymous API reads when a token is configured: %s',
    async (url) => {
      const app = await createHttpServer(fakeRedis(), config());

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        ok: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer API token' },
      });
      await app.close();
    },
  );

  it.each(['/health', '/version', '/api/health', '/api/version'])(
    'keeps the explicitly public API endpoint anonymous: %s',
    async (url) => {
      const app = await createHttpServer(fakeRedis(), config());

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);
      await app.close();
    },
  );

  it('keeps the web entry and built static assets anonymous', async () => {
    const webDist = mkdtempSync(join(tmpdir(), 'biao-static-auth-'));
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>');
    writeFileSync(join(webDist, 'assets', 'app.js'), 'globalThis.__biaoUiLoaded = true;');
    const app = await createHttpServer(fakeRedis(), config(), { webDist });

    try {
      const entry = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
      const entryHead = await app.inject({ method: 'HEAD', url: '/', headers: { accept: 'text/html' } });
      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });

      expect(entry.statusCode).toBe(200);
      expect(entry.body).toContain('/assets/app.js');
      expect(entryHead.statusCode).toBe(200);
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('__biaoUiLoaded');
    } finally {
      await app.close();
      rmSync(webDist, { recursive: true, force: true });
    }
  });

  it('does not expose the API directory through a public HTML request when the web build is absent', async () => {
    const app = await createHttpServer(fakeRedis(), config(), { webDist: null });

    const response = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      data: null,
      error: { code: 'FRONTEND_UNAVAILABLE', message: '前端尚未构建' },
    });
    await app.close();
  });

  it('accepts the configured token for a read-only API route', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'application/json', authorization: 'Bearer test-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: 'biao' });
    await app.close();
  });

  it('protects watchdog reads regardless of auto_fix when a token is configured', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const readonlyResponse = await app.inject({ method: 'GET', url: '/watchdog?auto_fix=false' });
    const mutationResponse = await app.inject({ method: 'GET', url: '/api/watchdog?auto_fix=true' });

    expect(readonlyResponse.statusCode).toBe(401);
    expect(mutationResponse.statusCode).toBe(401);
    expect(readonlyResponse.json().error.code).toBe('UNAUTHORIZED');
    expect(mutationResponse.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('keeps local compatibility when no API token is configured', async () => {
    const app = await createHttpServer(fakeRedis(), config({ apiToken: undefined, authEnabled: false }));

    const response = await app.inject({ method: 'POST', url: '/task/example/reset', payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json().error?.code).toBe('TASK_NOT_FOUND');
    await app.close();
  });
});

describe('HTTP request validation', () => {
  it.each([
    ['/plan/create', { plan_id: '../escape', project_path: '/tmp/biao-workspace' }],
    ['/plan/create', { plan_id: 'safe-id', project_path: 'relative/path' }],
    ['/plan/submit', {}],
    ['/claim', { blocking: false }],
    ['/report', { task_id: 't1', agent_id: 'a1', claim_token: 'token', status: 'unknown' }],
    ['/task/t1/review', { verdict: 'accept', reviewed_by: '' }],
    ['/task/t1/review', { verdict: 'reject', reviewed_by: 'pm', resolution_mode: 'reset-source' }],
    ['/task/t1/review', { verdict: 'reject', reviewed_by: 'pm', repair_ownership: { files: ['src/a.ts'], unexpected: ['x'] } }],
    ['/task/t1/review', { verdict: 'reject', reviewed_by: 'pm', repair_ownership: { files: [] } }],
    ['/task/t1/review', { verdict: 'reject', reviewed_by: 'pm', repair_ownership: { files: Array.from({ length: 65 }, (_, index) => `src/${index}.ts`) } }],
    ['/task/t1/resolution', { action: 'retry', decided_by: 'pm' }],
    ['/task/t1/resolution', { action: 'continue', decided_by: '' }],
    ['/task/t1/reset', { force: 'yes' }],
    ['/task/t1/block', { agent_id: 'a1', reason: 'unknown' }],
    ['/task/t1/resume', {}],
    ['/ownership/declare', { agent_id: 'a1', task_id: 't1', claim_token: 'token', files: 'src/**' }],
    ['/ownership/release', { agent_id: 'a1', task_id: 't1', claim_token: 'token', files: [] }],
  ])('returns 400 for malformed %s input', async (url, payload) => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer test-secret' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      data: null,
      error: { code: 'INVALID_REQUEST' },
    });
    await app.close();
  });

  it('exposes authenticated inspect/continue/cancel resolution routes for PM and CLI', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const inspected = await app.inject({
      method: 'GET',
      url: '/task/missing/resolution',
      headers: { authorization: 'Bearer test-secret' },
    });
    const decided = await app.inject({
      method: 'POST',
      url: '/task/missing/resolution',
      headers: { authorization: 'Bearer test-secret' },
      payload: { action: 'inspect', decided_by: 'pm-http' },
    });

    expect(inspected.statusCode).toBe(200);
    expect(inspected.json()).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    await app.close();
  });

  it('rejects plan paths outside configured workspace roots before file access', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    const response = await app.inject({
      method: 'POST',
      url: '/plan/create',
      headers: { authorization: 'Bearer test-secret' },
      payload: { plan_id: 'safe-id', project_path: '/tmp/outside-workspace', submit: false },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      ok: false,
      data: null,
      error: { code: 'WORKSPACE_PATH_DENIED' },
    });
    await app.close();
  });
});
