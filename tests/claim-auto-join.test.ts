import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import {
  agentRegister,
  claim,
  createProjectAgentBinding,
  getProjectAgentRoster,
  listProjectAgentBindings,
  setSqliteStore,
} from '../src/server/service.js';

const REDIS_URL = process.env.CLAIM_AUTO_JOIN_REDIS_URL ?? 'redis://127.0.0.1:6380/14';
const project = '/tmp/biao-claim-auto-join';
const planId = 'claim-auto-join-plan';
let redis: Redis;
let store: SqliteStore;
let tempDir = '';

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
  setSqliteStore(null);
  store?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = mkdtempSync(join(tmpdir(), 'biao-claim-auto-join-'));
  store = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(store);

  await writePlanToRedis(redis, {
    plan_id: planId,
    title: 'claim auto join plan',
    project_path: project,
    default_priority: 5,
  }, 3);
});

afterAll(async () => {
  setSqliteStore(null);
  store?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  await redis.flushdb();
  redis.disconnect();
});

function claimRequest(agentId: string, registrationId: string, extra: Record<string, unknown> = {}) {
  return {
    agent_id: agentId,
    registration_id: registrationId,
    claim_request_id: `claim_${agentId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    blocking: false,
    ...extra,
  } as any;
}

describe('复制进入的 Worker：领取成功即默认已加入项目', () => {
  it('存在他人 binding 的 auto lane 不再阻塞普通 claim（offic 卡单回归）', async () => {
    await writeTaskToRedis(redis, {
      task_id: 'auto-task', title: 'auto lane', type: 'code', phase: 'impl',
      priority: 7, timeout_seconds: 120, verify: [], ownership: { files: [] },
    }, '# auto', planId, project, 5);
    await createProjectAgentBinding(project, {
      binding_id: 'binding-foreign', agent_id: 'foreign-agent', label: 'foreign',
      harness_kind: 'zcode', capabilities: ['code', 'review', 'docs', 'acceptance'],
      wake_mode: 'external_worker', policy: 'automatic',
    });
    expect((await agentRegister(
      redis, 'plain-worker', 'custom', ['code'], undefined, [project], 'reg_plain_worker_0001',
    )).ok).toBe(true);

    const claimed = await claim(redis, claimRequest('plain-worker', 'reg_plain_worker_0001', {
      preferred_project: project, preferred_types: ['code'], preferred_plan_ids: [planId],
    }));
    expect(claimed).toMatchObject({ ok: true, data: { task_id: 'auto-task' } });
  });

  it('领取成功自动创建 automatic 绑定，roster 默认显示已加入且无需前端添加', async () => {
    await writeTaskToRedis(redis, {
      task_id: 'fresh-task', title: 'fresh lane', type: 'code', phase: 'impl',
      priority: 7, timeout_seconds: 120, verify: [], ownership: { files: [] },
    }, '# fresh', planId, project, 5);
    expect((await agentRegister(
      redis, 'copy-entered-worker', 'zcode', ['code', 'review'], undefined, [project], 'reg_copy_entered_001',
    )).ok).toBe(true);

    const claimed = await claim(redis, claimRequest('copy-entered-worker', 'reg_copy_entered_001', {
      preferred_project: project, preferred_types: ['code'], preferred_plan_ids: [planId],
    }));
    expect(claimed).toMatchObject({ ok: true, data: { task_id: 'fresh-task' } });

    const bindings = await listProjectAgentBindings(project);
    expect(bindings.data?.bindings).toEqual([
      expect.objectContaining({
        agent_id: 'copy-entered-worker',
        harness_kind: 'zcode',
        capabilities: ['code', 'review'],
        wake_mode: 'external_worker',
        policy: 'automatic',
      }),
    ]);

    const roster = await getProjectAgentRoster(redis, project);
    expect(roster.data?.bound_agents.some((agent) => agent.agent_id === 'copy-entered-worker')).toBe(true);
    expect(roster.data?.online_candidates).toEqual([]);
  });

  it('binding 记账失败（SQLite 不可用）不影响领取结果', async () => {
    await writeTaskToRedis(redis, {
      task_id: 'no-store-task', title: 'no store', type: 'code', phase: 'impl',
      priority: 7, timeout_seconds: 120, verify: [], ownership: { files: [] },
    }, '# no store', planId, project, 5);
    setSqliteStore(null);
    expect((await agentRegister(
      redis, 'storeless-worker', 'custom', ['code'], undefined, [project], 'reg_storeless_00001',
    )).ok).toBe(true);

    const claimed = await claim(redis, claimRequest('storeless-worker', 'reg_storeless_00001', {
      preferred_project: project, preferred_types: ['code'], preferred_plan_ids: [planId],
    }));
    expect(claimed).toMatchObject({ ok: true, data: { task_id: 'no-store-task' } });
  });

  it('指派给 harness 的 lane 仍只对 binding 归属者开放普通 claim', async () => {
    await writeTaskToRedis(redis, {
      task_id: 'harness-lane-task', title: 'harness lane', type: 'code', phase: 'impl',
      assignee: 'zcode', priority: 7, timeout_seconds: 120, verify: [], ownership: { files: [] },
    }, '# harness lane', planId, project, 5);
    await createProjectAgentBinding(project, {
      binding_id: 'binding-lane-owner', agent_id: 'lane-owner', label: 'lane owner',
      harness_kind: 'zcode', capabilities: ['code'],
      wake_mode: 'external_worker', policy: 'automatic',
    });
    expect((await agentRegister(
      redis, 'stranger-worker', 'zcode', ['code'], undefined, [project], 'reg_stranger_0000001',
    )).ok).toBe(true);
    expect((await agentRegister(
      redis, 'lane-owner', 'zcode', ['code'], undefined, [project], 'reg_lane_owner_000001',
    )).ok).toBe(true);

    const stranger = await claim(redis, claimRequest('stranger-worker', 'reg_stranger_0000001', {
      preferred_project: project, preferred_types: ['code'], preferred_plan_ids: [planId],
    }));
    expect(stranger).toMatchObject({ ok: true, data: null });

    const owner = await claim(redis, claimRequest('lane-owner', 'reg_lane_owner_000001', {
      preferred_project: project, preferred_types: ['code'], preferred_plan_ids: [planId],
    }));
    expect(owner).toMatchObject({ ok: true, data: { task_id: 'harness-lane-task' } });
  });
});
