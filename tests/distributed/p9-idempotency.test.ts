/**
 * Phase 9 失败优先测试：幂等合并断言（审计不确定-2 / §22.4-40）
 *
 * 单用例合并断言两件事：
 * 1. 重复 claim（同 claim_request_id）返回原 attempt 实体（claim_token/task 不变，不双领）；
 * 2. 重复 deliver/enqueue（同 delivery 键 + expected_target_sha）返回稳定结果不双写。
 *
 * claim 走 V1 service 真实幂等重放路径（REPLAY_AGENT_CLAIM），复用既有 service 函数；
 * enqueue 走 merge queue enqueueWithTarget 幂等（同 (delivery_id, expected_target_sha)）。
 * 只加测试，不改 queue / service。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { writePlanToRedis, writeTaskToRedis } from '../../src/redis/ownership.js';
import {
  agentRegister,
  claim,
  createProjectAgentBinding,
  reserveProjectAgentTask,
  setSqliteStore,
} from '../../src/server/service.js';
import { createMergeQueue } from '../../src/server/v2/merge/queue.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';

const REDIS_URL = process.env.P9_IDEMPOTENCY_REDIS_URL ?? process.env.BIAO_DISTRIBUTED_TEST_REDIS_URL?.replace(/\/d+$/, '') ?? (`redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}/13`);
const project = '/tmp/biao-p9-idempotency';
const planId = 'p9-idempotency-plan';

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
  tempDir = mkdtempSync(join(tmpdir(), 'biao-p9-idem-'));
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

async function seedReadyTask() {
  await writePlanToRedis(redis, {
    plan_id: planId,
    title: 'p9 idempotency plan',
    project_path: project,
    default_priority: 5,
  }, 1);
  await writeTaskToRedis(redis, {
    task_id: 'p9-task', title: 'idem', type: 'code', phase: 'impl',
    assignee: 'p9-agent', priority: 5, timeout_seconds: 120, verify: [],
    ownership: { files: ['src/a.ts'] },
  }, '# p9', planId, project, 5);
  await createProjectAgentBinding(project, {
    binding_id: 'binding-p9', agent_id: 'p9-agent', label: 'p9',
    harness_kind: 'custom', capabilities: ['code'], wake_mode: 'external_worker', policy: 'automatic',
  });
}

describe('幂等合并断言（§22.4-40 / 审计不确定-2）', () => {
  it('重复 claim 返回原 attempt 实体 + 重复 enqueue 不双写', async () => {
    await seedReadyTask();

    const registrationId = 'registration_p9_idem_000000000001';
    const reserved = await reserveProjectAgentTask(redis, project, {
      binding_id: 'binding-p9',
      preferred_plan_ids: [planId],
    });
    expect(reserved.ok).toBe(true);
    const reservation = reserved.data!;

    expect((await agentRegister(
      redis, 'p9-agent', 'custom', ['code'], undefined, [project], registrationId,
    )).ok).toBe(true);

    const base = {
      agent_id: 'p9-agent',
      registration_id: registrationId,
      blocking: false,
      preferred_project: project,
      preferred_types: ['code'],
      preferred_plan_ids: [planId],
      reservation_id: reservation.reservation_id,
    };

    // ── 1. 重复 claim（同 claim_request_id）返回原 attempt 实体 ──
    const first = await claim(redis, { ...base, claim_request_id: 'claim_p9_idem_000001' } as never);
    expect(first.ok).toBe(true);
    expect(first.data?.task_id).toBe('p9-task');
    const claimToken = first.data!.claim_token;
    expect(claimToken).toBeTruthy();

    const second = await claim(redis, { ...base, claim_request_id: 'claim_p9_idem_000001' } as never);
    expect(second.ok).toBe(true);
    expect(second.data?.task_id).toBe('p9-task');
    expect(second.data?.claim_token).toBe(claimToken); // 原实体重放，不产生第二个 attempt

    // ── 2. 重复 deliver/enqueue（同 delivery 键）返回稳定结果不双写 ──
    const now = Date.now();
    store.insertDelivery({
      delivery_id: 'del-idem',
      task_id: 'p9-task',
      attempt_id: `att-${randomBytes(4).toString('hex')}`,
      project_id: 'proj-idem',
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      tree_sha: 'c'.repeat(40),
      branch_ref: 'refs/heads/biao/attempt/idem',
      changed_files: '[]',
      patch_digest: '',
      artifact_ids: '[]',
      verify_manifest_digest: '',
      status: 'accepted',
      accepted_commit_sha: '',
      merged_commit_sha: '',
      invalidated_reason: '',
      created_at: now,
      updated_at: now,
    });

    const queue = createMergeQueue({ store, provider: new GenericGitProvider() });
    const target = 'd'.repeat(40);
    const r1 = queue.enqueueWithTarget('del-idem', target);
    const r2 = queue.enqueueWithTarget('del-idem', target);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.data?.merge_job_id).toBe(r2.data?.merge_job_id); // 稳定结果
    expect(store.listMergeJobs(undefined, 'queued').length).toBe(1); // 不双写
  }, 20_000);
});
