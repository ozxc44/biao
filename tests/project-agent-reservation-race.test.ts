import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import {
  agentRegister,
  appendExecutionReceipt,
  claim,
  createProjectAgentBinding,
  reserveProjectAgentTask,
  setSqliteStore,
} from '../src/server/service.js';

const REDIS_URL = process.env.PROJECT_AGENT_RESERVATION_REDIS_URL ?? 'redis://127.0.0.1:6380/13';
const project = '/tmp/biao-project-agent-reservation';
const planId = 'project-agent-reservation-plan';
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
  tempDir = mkdtempSync(join(tmpdir(), 'biao-ready-reservation-'));
  store = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(store);
});

afterAll(async () => {
  setSqliteStore(null);
  store?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  await redis.flushdb();
  redis.disconnect();
});

async function seed() {
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: 'reservation plan',
    project_path: project,
    default_priority: 5,
  }, 3);
  await writeTaskToRedis(redis, {
    task_id: 'dependency-source', title: 'dependency', type: 'code', phase: 'impl',
    assignee: 'source-agent', priority: 9, timeout_seconds: 120, verify: [],
    ownership: { files: ['src/source.ts'] },
  }, '# source', planId, project, 5);
  await writeTaskToRedis(redis, {
    task_id: 'dependency-waiting', title: 'waiting', type: 'code', phase: 'impl',
    assignee: 'waiting-agent', depends_on: ['dependency-source'], priority: 8,
    timeout_seconds: 120, verify: [], ownership: { files: ['src/waiting.ts'] },
  }, '# waiting', planId, project, 5);
  await writeTaskToRedis(redis, {
    task_id: 'ready-task', title: 'ready', type: 'code', phase: 'impl',
    assignee: 'ready-agent', priority: 7, timeout_seconds: 120, verify: [],
    ownership: { files: ['src/ready.ts'] },
  }, '# ready', planId, project, 5);
  await createProjectAgentBinding(project, {
    binding_id: 'binding-waiting', agent_id: 'waiting-agent', label: 'waiting',
    harness_kind: 'custom', capabilities: ['code'], wake_mode: 'external_worker', policy: 'automatic',
  });
  await createProjectAgentBinding(project, {
    binding_id: 'binding-ready', agent_id: 'ready-agent', label: 'ready',
    harness_kind: 'custom', capabilities: ['code'], wake_mode: 'external_worker', policy: 'automatic',
  });
}

describe('atomic Project Agent reservation', () => {
  it('does not reserve dependency-waiting work and lets only one supervisor reserve a ready task', async () => {
    await seed();

    const waiting = await reserveProjectAgentTask(redis, project, {
      binding_id: 'binding-waiting', preferred_plan_ids: [planId],
    });
    expect(waiting).toMatchObject({ ok: true, data: null });

    const raced = await Promise.all([
      reserveProjectAgentTask(redis, project, { binding_id: 'binding-ready', preferred_plan_ids: [planId] }),
      reserveProjectAgentTask(redis, project, { binding_id: 'binding-ready', preferred_plan_ids: [planId] }),
    ]);
    const winners = raced.flatMap((result) => result.data ? [result.data] : []);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      task_id: 'ready-task', binding_id: 'binding-ready', capability: 'code',
      reservation_id: expect.stringMatching(/^reservation_/),
    });
  });

  it('redeems only the reserved task once and accepts success only after matching the actual claim', async () => {
    await seed();
    const reserved = await reserveProjectAgentTask(redis, project, {
      binding_id: 'binding-ready', preferred_plan_ids: [planId],
    });
    expect(reserved.ok).toBe(true);
    const reservation = reserved.data!;
    const registrationId = 'registration_ready_000000000001';
    expect((await agentRegister(
      redis, 'ready-agent', 'custom', ['code'], undefined, [project], registrationId,
    )).ok).toBe(true);

    const premature = await appendExecutionReceipt(project, {
      attempt_id: reservation.reservation_id,
      task_id: reservation.task_id,
      binding_id: reservation.binding_id,
      agent_id: 'ready-agent',
      registration_id: registrationId,
      harness_kind: 'custom',
      wake_mode: 'external_worker',
      adapter_id: 'external-v2',
      status: 'succeeded',
      started_at: Date.now(),
    }, redis);
    expect(premature).toMatchObject({ ok: false, error: { code: 'RESERVATION_NOT_REDEEMED' } });

    const claimed = await claim(redis, {
      agent_id: 'ready-agent',
      registration_id: registrationId,
      claim_request_id: 'claim_ready_reservation_000001',
      blocking: false,
      preferred_project: project,
      preferred_types: ['code'],
      preferred_plan_ids: [planId],
      reservation_id: reservation.reservation_id,
    } as any);
    expect(claimed).toMatchObject({
      ok: true,
      data: { task_id: 'ready-task', reservation_id: reservation.reservation_id },
    });

    const replayed = await claim(redis, {
      agent_id: 'ready-agent',
      registration_id: registrationId,
      claim_request_id: 'claim_ready_reservation_000001',
      blocking: false,
      preferred_project: project,
      preferred_types: ['code'],
      preferred_plan_ids: [planId],
      reservation_id: reservation.reservation_id,
    } as any);
    expect(replayed).toMatchObject({
      ok: true,
      data: {
        task_id: 'ready-task',
        claim_token: claimed.data!.claim_token,
        reservation_id: reservation.reservation_id,
      },
    });

    const receipt = await appendExecutionReceipt(project, {
      attempt_id: reservation.reservation_id,
      task_id: reservation.task_id,
      binding_id: reservation.binding_id,
      agent_id: 'ready-agent',
      registration_id: registrationId,
      harness_kind: 'custom',
      wake_mode: 'external_worker',
      adapter_id: 'external-v2',
      status: 'succeeded',
      started_at: Date.now(),
    }, redis);
    expect(receipt).toMatchObject({ ok: true, data: { status: 'succeeded', task_id: 'ready-task' } });

    const replayWithNewRequest = await claim(redis, {
      agent_id: 'ready-agent',
      registration_id: registrationId,
      claim_request_id: 'claim_ready_reservation_000002',
      blocking: false,
      reservation_id: reservation.reservation_id,
    } as any);
    expect(replayWithNewRequest).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_AGENT_RESERVATION_INVALID' },
    });
  });
});
