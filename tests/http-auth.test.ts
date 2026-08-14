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
  const strings = new Map<string, { value: string; expiresAt: number }>();
  const currentValue = (key: string): string | undefined => {
    const entry = strings.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      strings.delete(key);
      return undefined;
    }
    return entry.value;
  };
  const client = {
    ping: async () => 'PONG',
    hgetall: async () => ({}),
    // PM reset/review uses the same owner-token lock contract as production:
    // SET key token PX ttl NX, renewal on a duplicate connection, and compare-delete.
    set: async (key: string, value: string, ...args: Array<string | number>) => {
      const nx = args.some((arg) => String(arg).toUpperCase() === 'NX');
      if (nx && currentValue(key) !== undefined) return null;
      const pxIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'PX');
      const ttl = pxIndex >= 0 ? Number(args[pxIndex + 1]) : 30_000;
      strings.set(key, { value, expiresAt: Date.now() + ttl });
      return 'OK';
    },
    get: async (key: string) => currentValue(key) ?? null,
    // 产品代码对未知/损坏门禁 fail closed；测试替身必须显式模拟 OPEN/ACQUIRED。
    eval: async (script: string, _keyCount?: number, ...args: Array<string | number>) => {
      if (script.includes("return 'OPEN'")) return 'OPEN';
      if (script.includes("return 'ACQUIRED'")) return 'ACQUIRED';
      if (script.includes('release-pm-review-lock-v1')) {
        const [key, owner] = args.map(String);
        if (currentValue(key) !== owner) return 0;
        strings.delete(key);
        return 1;
      }
      if (script.includes("redis.call('PEXPIRE', KEYS[1], ARGV[2])")) {
        const [key, owner, ttl] = args.map(String);
        if (currentValue(key) !== owner) return 0;
        strings.set(key, { value: owner, expiresAt: Date.now() + Number(ttl) });
        return 1;
      }
      return 1;
    },
    zrem: async () => 1,
    duplicate: () => client,
    disconnect: () => undefined,
  };
  return client as unknown as Redis;
}

describe('HTTP bearer authentication', () => {
  it.each(['/status', '/plans', '/questions?consumer=pm', '/ownership/active'])(
    'denies scoped Worker bearer access to control-plane read %s',
    async (url) => {
      const app = await createHttpServer(fakeRedis(), {
        ...config(),
        workerApiToken: 'worker-only-secret',
      } as BiaoConfig & { workerApiToken: string });

      try {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: 'Bearer worker-only-secret' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'WORKER_SCOPE_DENIED' },
        });
      } finally {
        await app.close();
      }
    },
  );

  it.each([
    ['/task/example/review', { verdict: 'accept', reviewed_by: 'forged-pm' }],
    ['/question/example/answer', { consumer: 'pm', answer: 'forged answer', answered_by: 'forged-pm' }],
    ['/task/example/resolution', { action: 'inspect', decided_by: 'forged-pm' }],
    ['/intake/ack', { consumer: 'pm', event_id: 'forged-event' }],
    ['/task/example/reset', {}],
  ])('rejects a scoped Worker bearer before PM-only mutation %s can trust request-body identity', async (url, payload) => {
    const app = await createHttpServer(fakeRedis(), {
      ...config(),
      workerApiToken: 'worker-only-secret',
    } as BiaoConfig & { workerApiToken: string });

    try {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer worker-only-secret' },
        payload,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        data: null,
        error: { code: 'WORKER_SCOPE_DENIED', message: 'Worker 凭据无权执行 PM/Owner 控制面操作' },
      });
    } finally {
      await app.close();
    }
  });

  it('keeps Worker lifecycle mutations available to the scoped Worker bearer', async () => {
    const app = await createHttpServer(fakeRedis(), {
      ...config(),
      workerApiToken: 'worker-only-secret',
    } as BiaoConfig & { workerApiToken: string });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/task/example/block',
        headers: { authorization: 'Bearer worker-only-secret' },
        payload: {
          agent_id: 'worker-1',
          claim_token: 'claim-token',
          reason: 'waiting_dependency',
        },
      });

      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    } finally {
      await app.close();
    }
  });

  it('lets a human establish a durable local Owner browser session without receiving the Agent bearer token', async () => {
    const app = await createHttpServer(fakeRedis(), config());
    const localBrowserHeaders = {
      host: '127.0.0.1:7331',
      origin: 'http://127.0.0.1:7331',
      'sec-fetch-site': 'same-origin',
    };

    try {
      const before = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual({
        ok: true,
        data: { authenticated: false, mode: 'local_owner', local_session_available: true },
      });

      const start = await app.inject({ method: 'POST', url: '/auth/local-session', headers: localBrowserHeaders });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toEqual({
        ok: true,
        data: { authenticated: true, mode: 'local_owner', local_session_available: true },
      });
      const cookie = start.headers['set-cookie'];
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).not.toContain('test-secret');

      const api = await app.inject({
        method: 'GET',
        url: '/',
        headers: { accept: 'application/json', cookie: String(cookie) },
      });
      expect(api.statusCode).toBe(200);
      expect(api.json()).toMatchObject({ ok: true, service: 'biao' });
    } finally {
      await app.close();
    }
  });

  it('does not mint a local Owner browser session for a non-loopback binding', async () => {
    const app = await createHttpServer(fakeRedis(), config({ host: '0.0.0.0' }));

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/local-session',
        headers: {
          host: 'biao.example.test:7331',
          origin: 'http://biao.example.test:7331',
          'sec-fetch-site': 'same-origin',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        data: null,
        error: { code: 'LOCAL_SESSION_UNAVAILABLE', message: '本机 Owner 会话只允许 loopback 部署' },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a cross-site request that tries to change a local Owner session', async () => {
    const app = await createHttpServer(fakeRedis(), config());

    try {
      const response = await app.inject({
        method: 'DELETE',
        url: '/auth/local-session',
        headers: {
          host: '127.0.0.1:7331',
          origin: 'https://untrusted.example',
          'sec-fetch-site': 'cross-site',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        ok: false,
        data: null,
        error: { code: 'LOCAL_SESSION_ORIGIN_DENIED', message: '本机 Owner 会话必须从控制台同源页面创建' },
      });
    } finally {
      await app.close();
    }
  });

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
