import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/db/sqlite-store.js';
import {
  connectProjectAgent,
  getProjectAgentRoster,
  setSqliteStore,
} from '../src/server/service.js';

const PROJECT = '/workspace/project-a';
const OTHER_PROJECT = '/workspace/project-b';
let tempDir = '';

afterEach(() => {
  setSqliteStore(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function store(): SqliteStore {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-auto-connect-'));
  const value = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(value);
  return value;
}

function redisWithOnlineAgent(now: number) {
  return {
    smembers: async () => ['remote-glm'],
    hgetall: async (key: string) => key.endsWith(':remote-glm') ? {
      agent_id: 'remote-glm',
      agent_type: 'glm',
      capabilities: 'code,review',
      projects: OTHER_PROJECT,
      status: 'idle',
      last_heartbeat: String(now),
    } : {},
  } as never;
}

describe('Project Agent automatic connection', () => {
  it('lists online agents outside the project and connects one with automatic matching defaults', async () => {
    const db = store();
    const now = 1_800_000_000_000;
    const redis = redisWithOnlineAgent(now);

    const before = await getProjectAgentRoster(redis, PROJECT, now);
    expect(before.data).toMatchObject({
      project_scope: PROJECT,
      bound_agents: [],
      online_candidates: [{
        agent_id: 'remote-glm',
        harness_kind: 'glm',
        capabilities: ['code', 'review'],
        registered_projects: [OTHER_PROJECT],
      }],
    });

    const connected = await connectProjectAgent(redis, PROJECT, 'remote-glm', now);
    expect(connected).toMatchObject({
      ok: true,
      data: {
        project_scope: PROJECT,
        agent_id: 'remote-glm',
        label: 'remote-glm',
        harness_kind: 'glm',
        capabilities: ['code', 'review'],
        policy: 'automatic',
        wake_mode: 'external_worker',
      },
    });

    const after = await getProjectAgentRoster(redis, PROJECT, now);
    expect(after.data?.online_candidates).toEqual([]);
    expect(after.data?.bound_agents).toEqual([
      expect.objectContaining({
        agent_id: 'remote-glm',
        policy: 'automatic',
        online_registered: true,
        availability_status: 'bound_wakeable',
      }),
    ]);
    db.close();
  });

  it('rejects connection when the requested agent is not currently online', async () => {
    const db = store();
    const redis = { smembers: async () => [], hgetall: async () => ({}) } as never;

    await expect(connectProjectAgent(redis, PROJECT, 'missing-agent')).resolves.toMatchObject({
      ok: false,
      error: { code: 'PROJECT_AGENT_NOT_ONLINE' },
    });
    db.close();
  });
});
