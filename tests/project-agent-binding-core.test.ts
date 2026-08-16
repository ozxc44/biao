import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { checksumFor, runMigrations } from '../src/db/migrate.js';
import * as baseline from '../src/db/migrations/001_baseline.js';
import {
  createProjectAgentBinding,
  deleteProjectAgentBinding,
  getProjectAgentBinding,
  listProjectAgentBindings,
  setSqliteStore,
} from '../src/server/service.js';
import { createHttpServer } from '../src/server/http.js';
import type { BiaoConfig } from '../src/types/index.js';

const PROJECT_A = '/workspace/project-a';
const PROJECT_B = '/workspace/project-b';
const BASELINE_MIGRATION = {
  version: baseline.version,
  checksumMaterial: baseline.checksumMaterial,
  up: baseline.up,
};

let tempDir = '';

afterEach(() => {
  setSqliteStore(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function databasePath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-binding-core-'));
  return join(tempDir, 'biao.sqlite');
}

describe('ProjectAgentBinding durable contract', () => {
  it('upgrades a populated v1 database without changing the immutable baseline checksum', () => {
    const path = databasePath();
    const db = new Database(path);
    runMigrations(db, { migrations: [BASELINE_MIGRATION], now: () => 'v1-applied' });
    db.prepare(`INSERT INTO agent_registrations
      (agent_id, registration_id, generation, registration_source, agent_type, capabilities, endpoint, projects, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('agent-a', 'registration_0000000000000001', 1, 'client', 'codex', 'code', '', PROJECT_A, '1');
    db.close();

    const store = new SqliteStore(path);
    // 迁移链会随阶段前进而增长（005/006/…），本测试只关心：基线校验和不变 +
    // 链条从 001 起连续无跳号。终态版本断言放 p0a1-migrations 套件。
    expect(store.getSchemaVersion()).toMatch(/^0(?:0[1-9]|[1-9]\d)$/);
    expect(store.getCurrentAgentRegistration('agent-a')).toMatchObject({
      registration_id: 'registration_0000000000000001',
      generation: 1,
    });
    expect(store.getProjectAgentBindings(PROJECT_A)).toEqual([]);
    const schemaVersion = store.getSchemaVersion();
    store.close();

    const check = new Database(path, { readonly: true });
    const records = check.prepare(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: string; checksum: string }>;
    expect(records[0]).toEqual({ version: '001', checksum: checksumFor(BASELINE_MIGRATION) });
    // 链条连续性：001 之后每个版本都是前一版本 +1（无跳号、无缺号，三位补零）
    for (let index = 1; index < records.length; index += 1) {
      expect(records[index].version).toBe(String(index + 1).padStart(3, '0'));
      expect(records[index].checksum).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(Number(schemaVersion)).toBe(records.length);
    check.close();
  });

  it('joins a project via agent-connections only and keeps manual binding CRUD closed', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    const fakeRedis = {
      eval: async (script: string) => script.includes("return 'OPEN'") ? 'OPEN' : 'ACQUIRED',
      zrem: async () => 1,
      smembers: async () => [],
      hgetall: async (key: string) => key === 'biao:v1:hash:agent:http-agent'
        ? {
            agent_id: 'http-agent', agent_type: 'custom', capabilities: 'code',
            projects: PROJECT_A, status: 'idle', last_heartbeat: String(Date.now()),
          }
        : {},
    } as never;
    const config: BiaoConfig = {
      port: 0, host: '127.0.0.1', redisUrl: '', authEnabled: false,
      workspaceRoots: ['/workspace'], sqlitePath: '', streamMaxlen: 100, conflictRetention: 100,
    };
    const app = await createHttpServer(fakeRedis, config, { webDist: false });
    try {
      // 绑定即加入项目：手工 CRUD 端点已收敛移除，不再绕过注册真相造绑定。
      const manualCreate = await app.inject({
        method: 'POST', url: '/project/agent-bindings',
        payload: {
          project_scope: PROJECT_A, binding_id: 'http-binding', agent_id: 'http-agent',
          label: 'HTTP Agent', harness_kind: 'custom', capabilities: ['code'],
          wake_mode: 'external_worker', policy: 'on_demand',
        },
      });
      expect(manualCreate.statusCode).toBe(404);
      const manualPatch = await app.inject({
        method: 'PATCH',
        url: `/project/agent-bindings/http-binding?project_scope=${encodeURIComponent(PROJECT_A)}`,
        payload: { label: 'Renamed' },
      });
      expect(manualPatch.statusCode).toBe(404);

      const rejected = await app.inject({
        method: 'POST', url: '/project/agent-connections',
        payload: { project_scope: PROJECT_A, agent_id: 'http-agent', command: 'secret-command' },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });

      const offline = await app.inject({
        method: 'POST', url: '/project/agent-connections',
        payload: { project_scope: PROJECT_A, agent_id: 'offline-agent' },
      });
      expect(offline.statusCode).toBe(200);
      expect(offline.json()).toMatchObject({ ok: false, error: { code: 'PROJECT_AGENT_NOT_ONLINE' } });

      const joined = await app.inject({
        method: 'POST', url: '/project/agent-connections',
        payload: { project_scope: PROJECT_A, agent_id: 'http-agent' },
      });
      expect(joined.statusCode).toBe(200);
      expect(joined.json()).toMatchObject({
        ok: true,
        data: {
          agent_id: 'http-agent',
          label: 'http-agent',
          harness_kind: 'custom',
          capabilities: ['code'],
          wake_mode: 'external_worker',
          policy: 'automatic',
        },
      });
      const bindingId: string = joined.json().data.binding_id;

      const rejoined = await app.inject({
        method: 'POST', url: '/project/agent-connections',
        payload: { project_scope: PROJECT_A, agent_id: 'http-agent' },
      });
      expect(rejoined.json()).toMatchObject({ ok: true, data: { binding_id: bindingId } });

      const listed = await app.inject({
        method: 'GET',
        url: `/project/agent-bindings?project_scope=${encodeURIComponent(PROJECT_A)}`,
      });
      expect(listed.json()).toMatchObject({
        ok: true, data: { project_scope: PROJECT_A, bindings: [{ binding_id: bindingId }] },
      });

      const wrongScope = await app.inject({
        method: 'GET',
        url: `/project/agent-bindings/${bindingId}?project_scope=${encodeURIComponent(PROJECT_B)}`,
      });
      expect(wrongScope.json()).toMatchObject({ ok: true, data: null });
    } finally {
      await app.close();
      store.close();
    }
  });

  it('keeps project bindings independent from registration epoch replacement and restart', async () => {
    const path = databasePath();
    let store = new SqliteStore(path);
    setSqliteStore(store);

    const created = await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-codex-a',
      agent_id: 'agent-a',
      label: 'Codex Desktop',
      harness_kind: 'codex',
      capabilities: ['code', 'review'],
      wake_mode: 'visible_session',
      policy: 'on_demand',
    });
    expect(created).toMatchObject({
      ok: true,
      data: {
        binding_id: 'binding-codex-a',
        project_scope: PROJECT_A,
        label: 'Codex Desktop',
      },
    });

    store.registerAgentEpoch({
      agent_id: 'agent-a', registration_id: 'registration_0000000000000001',
      registration_source: 'client', agent_type: 'codex', capabilities: 'code',
      endpoint: '', projects: PROJECT_A, registered_at: '1',
    });
    store.registerAgentEpoch({
      agent_id: 'agent-a', registration_id: 'registration_0000000000000002',
      registration_source: 'client', agent_type: 'codex', capabilities: 'code,review',
      endpoint: '', projects: PROJECT_A, registered_at: '2',
    });
    expect(store.getProjectAgentBindings(PROJECT_A)).toHaveLength(1);

    setSqliteStore(null);
    store.close();
    store = new SqliteStore(path);
    setSqliteStore(store);

    const read = await getProjectAgentBinding(PROJECT_A, 'binding-codex-a');
    expect(read).toMatchObject({
      ok: true,
      data: {
        agent_id: 'agent-a',
        capabilities: ['code', 'review'],
        wake_mode: 'visible_session',
        policy: 'on_demand',
      },
    });
    expect(store.getCurrentAgentRegistration('agent-a')?.registration_id)
      .toBe('registration_0000000000000002');
    store.close();
  });

  it('requires the caller project scope for read and delete', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'scope-bound-binding',
      agent_id: 'scope-agent',
      label: 'Scoped Agent',
      harness_kind: 'custom',
      capabilities: ['code'],
      wake_mode: 'external_worker',
      policy: 'on_demand',
    });

    await expect(getProjectAgentBinding(PROJECT_B, 'scope-bound-binding')).resolves.toMatchObject({
      ok: true, data: null,
    });
    await expect(deleteProjectAgentBinding(PROJECT_B, 'scope-bound-binding')).resolves.toMatchObject({
      ok: false, error: { code: 'BINDING_NOT_FOUND' },
    });

    const original = await getProjectAgentBinding(PROJECT_A, 'scope-bound-binding');
    expect(original.data).toMatchObject({ label: 'Scoped Agent', project_scope: PROJECT_A });
    store.close();
  });

  it('supports create, list, and delete without persisting secret-shaped fields', async () => {
    const path = databasePath();
    const store = new SqliteStore(path);
    setSqliteStore(store);
    const unsafe = {
      binding_id: 'safe-binding',
      agent_id: 'safe-agent',
      label: 'Safe label',
      harness_kind: 'custom',
      capabilities: ['code'],
      wake_mode: 'background_executor' as const,
      policy: 'automatic' as const,
      command: 'launch --token top-secret',
      target: 'private-session',
      Cookie: 'secret-cookie',
      bearer_token: 'Bearer secret',
      BIAO_API_TOKEN: 'api-secret',
    };
    await createProjectAgentBinding(PROJECT_A, unsafe);
    const created = await getProjectAgentBinding(PROJECT_A, 'safe-binding');
    expect(created.data).toMatchObject({ label: 'Safe label', capabilities: ['code'] });
    expect(created.data).not.toHaveProperty('command');
    expect(created.data).not.toHaveProperty('target');

    const listed = await listProjectAgentBindings(PROJECT_A);
    expect(listed.data).toMatchObject({ project_scope: PROJECT_A, bindings: [{ binding_id: 'safe-binding' }] });
    const bytes = readFileSync(path);
    for (const secret of ['top-secret', 'private-session', 'secret-cookie', 'Bearer secret', 'api-secret']) {
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }

    await expect(deleteProjectAgentBinding(PROJECT_A, 'safe-binding')).resolves.toMatchObject({
      ok: true, data: { binding_id: 'safe-binding', deleted: true },
    });
    await expect(listProjectAgentBindings(PROJECT_A)).resolves.toMatchObject({
      data: { bindings: [] },
    });
    store.close();
  });
});
