import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { keys } from '../src/redis/keys.js';
import {
  agentRegister,
  claim,
  planSubmit,
  previewPlanSubmission,
} from '../src/server/service.js';

const REDIS_URL = process.env.PLAN_REVISE_CAS_REDIS_URL ?? 'redis://127.0.0.1:6380/14';
const project = '/tmp/biao-plan-revise-cas-project';
let redis: Redis;
let planDir = '';
const originalWorkspaceRoots = process.env.BIAO_WORKSPACE_ROOTS;

function writePlan(version: 'v1' | 'v2') {
  writeFileSync(join(planDir, 'index.md'), `---
plan_id: plan-revise-cas
title: Plan revise CAS
project_path: ${project}
phases:
  - id: impl
    name: implementation
---
`);
  writeFileSync(join(planDir, 'tasks', 'task.md'), `---
task_id: plan-revise-cas-task
title: ${version}
type: code
phase: impl
assignee: revise-agent
priority: 5
timeout_seconds: 120
ownership:
  files:
    - src/revise.ts
verify: []
---

# ${version}
`);
}

beforeAll(async () => {
  process.env.BIAO_WORKSPACE_ROOTS = [originalWorkspaceRoots, '/tmp'].filter(Boolean).join(delimiter);
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
  if (planDir) rmSync(planDir, { recursive: true, force: true });
  planDir = mkdtempSync('/tmp/biao-plan-revise-cas-');
  mkdirSync(join(planDir, 'tasks'));
  writePlan('v1');
});

afterAll(async () => {
  if (originalWorkspaceRoots === undefined) delete process.env.BIAO_WORKSPACE_ROOTS;
  else process.env.BIAO_WORKSPACE_ROOTS = originalWorkspaceRoots;
  if (planDir) rmSync(planDir, { recursive: true, force: true });
  await redis.flushdb();
  redis.disconnect();
});

describe('plan submit/revise pending CAS', () => {
  it('rejects the whole stale preview after claim and preserves running lease, ownership, and indexes', async () => {
    const initial = await planSubmit(redis, planDir);
    expect(initial.error).toBeUndefined();
    const preview = await previewPlanSubmission(redis, planDir);
    expect(preview).toMatchObject({
      ok: true,
      data: { tasks: [{ task_id: 'plan-revise-cas-task', status: 'pending' }] },
    });
    writePlan('v2');

    const registrationId = 'registration_revise_000000000001';
    await agentRegister(redis, 'revise-agent', 'custom', ['code'], undefined, [project], registrationId);
    const claimed = await claim(redis, {
      agent_id: 'revise-agent', registration_id: registrationId,
      claim_request_id: 'claim_plan_revise_00000001', blocking: false,
      preferred_project: project,
    });
    expect(claimed).toMatchObject({ ok: true, data: { task_id: 'plan-revise-cas-task' } });

    const revised = await planSubmit(redis, planDir, preview.data!);
    expect(revised).toMatchObject({
      ok: false,
      error: { code: 'PLAN_SUBMIT_STALE_PREVIEW' },
    });

    const task = await redis.hgetall(keys.hash.task('plan-revise-cas-task'));
    expect(task).toMatchObject({ status: 'running', title: 'v1', claimed_by: 'revise-agent' });
    expect(await redis.get(keys.string.lease('plan-revise-cas-task'))).toBe(claimed.data!.claim_token);
    expect(await redis.zscore(keys.zset.status.running, 'plan-revise-cas-task')).not.toBeNull();
    expect(await redis.zscore(keys.zset.status.pending, 'plan-revise-cas-task')).toBeNull();
    expect(await redis.hget(keys.hash.fileOwnership, 'src/revise.ts')).toContain('revise-agent');
  });
});
