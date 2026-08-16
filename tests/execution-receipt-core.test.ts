import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/db/sqlite-store.js';
import {
  appendExecutionReceipt,
  createProjectAgentBinding,
  getProjectAgentRoster,
  listExecutionReceipts,
  setSqliteStore,
} from '../src/server/service.js';

const PROJECT_A = '/workspace/project-a';
const PROJECT_B = '/workspace/project-b';
let tempDir = '';

afterEach(() => {
  setSqliteStore(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function databasePath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-receipt-core-'));
  return join(tempDir, 'biao.sqlite');
}

function rosterRedis(agents: Record<string, Record<string, string>>) {
  return {
    smembers: async () => Object.keys(agents),
    hgetall: async (key: string) => agents[decodeURIComponent(key.split(':').at(-1) ?? '')] ?? {},
  } as never;
}

describe('ExecutionReceipt append-only contract', () => {
  it('persists a validated successful receipt and reads it after restart', async () => {
    const path = databasePath();
    let store = new SqliteStore(path);
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-visible', agent_id: 'agent-visible', label: 'Visible Codex',
      harness_kind: 'codex', capabilities: ['code'], wake_mode: 'visible_session', policy: 'on_demand',
    });

    const appended = await appendExecutionReceipt(PROJECT_A, {
      attempt_id: 'attempt-success-1', task_id: 'task-1', binding_id: 'binding-visible',
      agent_id: 'agent-visible', registration_id: 'registration_0000000000000001',
      harness_kind: 'codex', wake_mode: 'visible_session', adapter_id: 'codex-visible-v1',
      status: 'succeeded', started_at: 1_800_000_000_000,
      session_ref: 'session-public-7', visible_url: 'https://sessions.example.test/session-public-7',
    });
    expect(appended).toMatchObject({
      ok: true,
      data: {
        attempt_id: 'attempt-success-1', status: 'succeeded', adapter_id: 'codex-visible-v1',
        session_ref: 'session-public-7', visible_url: 'https://sessions.example.test/session-public-7',
      },
    });

    setSqliteStore(null);
    store.close();
    store = new SqliteStore(path);
    setSqliteStore(store);
    await expect(listExecutionReceipts(PROJECT_A, { binding_id: 'binding-visible' })).resolves.toMatchObject({
      ok: true,
      data: { receipts: [{ attempt_id: 'attempt-success-1', status: 'succeeded' }], total: 1 },
    });
    store.close();
  });

  it('downgrades success without an adapter to requested and never exposes session claims', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-no-adapter', agent_id: 'agent-no-adapter', label: 'No Adapter',
      harness_kind: 'custom', capabilities: ['code'], wake_mode: 'visible_session', policy: 'on_demand',
    });

    const receipt = await appendExecutionReceipt(PROJECT_A, {
      attempt_id: 'attempt-no-adapter', task_id: 'task-2', binding_id: 'binding-no-adapter',
      agent_id: 'agent-no-adapter', registration_id: 'registration_0000000000000002',
      harness_kind: 'custom', wake_mode: 'visible_session', adapter_id: null,
      status: 'succeeded', started_at: 1_800_000_000_001,
      session_ref: 'session-must-not-appear', visible_url: 'https://sessions.example.test/must-not-appear',
    });

    expect(receipt).toMatchObject({
      ok: true,
      data: { status: 'requested', adapter_id: null },
    });
    expect(receipt.data).not.toHaveProperty('session_ref');
    expect(receipt.data).not.toHaveProperty('visible_url');
    store.close();
  });

  it('rejects invalid session references and credential-bearing visible URLs before persistence', async () => {
    const path = databasePath();
    const store = new SqliteStore(path);
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-safe-url', agent_id: 'agent-safe-url', label: 'Safe URL',
      harness_kind: 'codex', capabilities: [], wake_mode: 'visible_session', policy: 'on_demand',
    });

    const rejected = await appendExecutionReceipt(PROJECT_A, {
      attempt_id: 'attempt-unsafe', task_id: 'task-3', binding_id: 'binding-safe-url',
      agent_id: 'agent-safe-url', registration_id: 'registration_0000000000000003',
      harness_kind: 'codex', wake_mode: 'visible_session', adapter_id: 'adapter-safe',
      status: 'succeeded', started_at: 1_800_000_000_002,
      session_ref: 'Bearer secret-session', visible_url: 'https://example.test/session?token=secret',
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_EXECUTION_RECEIPT' } });
    expect((await listExecutionReceipts(PROJECT_A)).data).toMatchObject({ receipts: [], total: 0 });
    expect(readFileSync(path).includes(Buffer.from('secret-session'))).toBe(false);
    store.close();
  });

  it('is append-only and project-scoped', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-append-only', agent_id: 'agent-append-only', label: 'Append only',
      harness_kind: 'custom', capabilities: [], wake_mode: 'external_worker', policy: 'on_demand',
    });
    const base = {
      attempt_id: 'attempt-fixed', task_id: 'task-4', binding_id: 'binding-append-only',
      agent_id: 'agent-append-only', registration_id: 'registration_0000000000000004',
      harness_kind: 'custom', wake_mode: 'external_worker' as const, adapter_id: 'worker-adapter-v1',
      status: 'requested' as const, started_at: 1_800_000_000_003,
    };
    await expect(appendExecutionReceipt(PROJECT_A, base)).resolves.toMatchObject({ ok: true });
    await expect(appendExecutionReceipt(PROJECT_A, { ...base, status: 'failed' })).resolves.toMatchObject({
      ok: false, error: { code: 'EXECUTION_RECEIPT_EXISTS' },
    });
    await expect(listExecutionReceipts(PROJECT_B)).resolves.toMatchObject({ data: { receipts: [], total: 0 } });
    await expect(appendExecutionReceipt(PROJECT_B, { ...base, attempt_id: 'attempt-cross-project' })).resolves.toMatchObject({
      ok: false, error: { code: 'BINDING_NOT_FOUND' },
    });
    expect((await listExecutionReceipts(PROJECT_A)).data).toMatchObject({
      receipts: [{ attempt_id: 'attempt-fixed', status: 'requested' }], total: 1,
    });
    store.close();
  });
});

describe('project Agent status projection', () => {
  it('does not disguise an online registration as a wakeable binding', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    const now = Date.now();
    const redis = rosterRedis({
      'online-only': {
        agent_id: 'online-only', agent_type: 'kimi', capabilities: 'research', projects: PROJECT_A,
        status: 'idle', last_heartbeat: String(now), registration_id: 'registration_online_00000001',
      },
    });

    const projection = await getProjectAgentRoster(redis, PROJECT_A, now);
    expect(projection).toMatchObject({
      ok: true,
      data: {
        project_scope: PROJECT_A,
        bound_agents: [],
        online_candidates: [{
          agent_id: 'online-only', harness_kind: 'kimi', availability_status: 'online_registered',
        }],
        receipts: [],
      },
    });
    store.close();
  });

  it('projects bound wake modes separately and never returns registration or transport secrets', async () => {
    const store = new SqliteStore(databasePath());
    setSqliteStore(store);
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-visible-status', agent_id: 'bound-visible', label: 'Visible',
      harness_kind: 'codex', capabilities: ['code'], wake_mode: 'visible_session', policy: 'on_demand',
    });
    await createProjectAgentBinding(PROJECT_A, {
      binding_id: 'binding-background-status', agent_id: 'bound-background', label: 'Background',
      harness_kind: 'custom', capabilities: ['code'], wake_mode: 'background_executor', policy: 'automatic',
    });
    const redis = rosterRedis({
      'bound-visible': {
        agent_id: 'bound-visible', agent_type: 'codex', capabilities: 'code', projects: PROJECT_A,
        status: 'idle', last_heartbeat: String(Date.now()), registration_id: 'registration_secret_0000001',
        endpoint: 'https://internal.example/wake',
      },
    });

    const projection = await getProjectAgentRoster(redis, PROJECT_A);
    expect(projection.data).toMatchObject({
      bound_agents: [
        { binding_id: 'binding-background-status', availability_status: 'background_only' },
        { binding_id: 'binding-visible-status', availability_status: 'bound_wakeable' },
      ],
      online_candidates: [],
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/registration_secret|internal\.example|endpoint|registration_id/);
    store.close();
  });
});
