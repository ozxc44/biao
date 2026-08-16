/**
 * 22.4-07 / 22.2-07 从严口径：V2 调度态（node session / attempt lease /
 * ownership snapshot）在 Redis FLUSHDB 后不开放半投影，从 durable（SQLite）重建。
 *
 * 实现现状（如实声明）：
 * - V2 调度态当前全部落在 SqliteStore（nodes / node_sessions / task_attempts /
 *   ownership_snapshots），不依赖 Redis 缓存投影；`src/redis/keys.ts` 的 v2Keys
 *   namespace（nodeSession/nodeActiveSession/attemptToken/nodeHeartbeat）声明但
 *   未被当前调度实现消费。因此“清空→重建”的验证对象是：Redis 丢失后 V2 服务仍以
 *   SQLite 为真相源正常工作，旧 generation 不被重开、lease 不复活、事件不重放。
 * - 若未来调度态改走 Redis 缓存（claim 落 Redis + SQLite 双写），本测试的
 *   “清空后重建”断言需随实现补强；当前如实标注该缺口。
 *
 * 断言目标：
 * 1. FLUSHDB 后 SQLite 侧调度态原样（attempt generation / lease expiry / task
 *    running / ownership snapshot / node session 计数均不变）。
 * 2. 已 executing 的 task 再次 claim → 409 ATTEMPT_ACTIVE（不重开旧 generation）。
 * 3. 旧 generation 的 bva2 token renew → 409 GENERATION_MISMATCH（fencing 不复活）。
 * 4. FLUSHDB + 一次普通读/心跳后，audit/outbox 不重复（计数不增长）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { V2_CREDENTIAL_KEY_ENV, issueAttemptToken } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';

const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;
const OWNER_TOKEN = 'p9-redis-rebuild-owner';
const TEST_KEY_HEX = '9a9a9a9a'.repeat(8); // 32 bytes hex

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-p9-redis-'));
  tempDirs.push(dir);
  return join(dir, 'biao.sqlite');
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...headers };
    opts.body = JSON.stringify(body);
  } else {
    opts.headers = { ...headers };
  }
  const res = await fetch(`${serverUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function seedPlan(): void {
  store.upsertPlan({
    plan_id: 'plan-p9r',
    title: 'P9R Test Plan',
    status: 'submitted',
    project_path: '/tmp/p9r',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: 1,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });
}

function seedTask(taskId: string, projectId: string): void {
  store.upsertTask({
    task_id: taskId,
    plan_id: 'plan-p9r',
    title: `P9R ${taskId}`,
    type: 'implementation',
    phase: '1',
    status: 'pending',
    priority: 5,
    assignee: 'auto',
    ownership_files: '[]',
    ownership_modules: '',
    depends_on: '[]',
    timeout_seconds: 3600,
    max_retries: 2,
    model_override: '',
    acceptance_for: '',
    verify: '',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '',
    retries: 0,
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    pm_reject_reason: '',
    pm_fix_instructions: '',
    blocked_at: '',
    block_reason: '',
    blocked_question_id: '',
    blocked_lease_remaining: '',
    last_question_id: '',
    last_question_answer: '',
    cancelled_at: '',
    verify_results: '[]',
    goal_md: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    project_id: projectId,
  });
}

let projectId = '';
let nodeId = 'node-p9r-0000000000001';
let nodeCredential = '';
let attemptId = '';
let attemptGeneration = 0;
let claimToken = '';
let leaseExpiryBefore = 0;

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  store = new SqliteStore(makeDbPath());
  app = await createHttpServer(redis, {
    apiToken: OWNER_TOKEN,
    host: '127.0.0.1',
    port: 0,
    workspaceRoots: [],
  }, { sqliteStore: store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  serverUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
  if (store) store.close();
  if (redis) {
    await redis.flushdb();
    redis.disconnect();
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV];
  else delete process.env[V2_CREDENTIAL_KEY_ENV];
  if (savedEnv['BIAO_V2_ENROLLMENT_TICKET'] !== undefined) process.env['BIAO_V2_ENROLLMENT_TICKET'] = savedEnv['BIAO_V2_ENROLLMENT_TICKET'];
  else delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
});

describe('22.4-07 Redis FLUSHDB 后 V2 调度态从 SQLite 重建', () => {
  it('世界搭建：project + node 会话 + claim 出 executing attempt（lease/ownership snapshot 落 SQLite）', async () => {
    const proj = await api('POST', '/v2/projects', {
      name: 'p9-redis-rebuild', repo_path: '/tmp/p9r', default_branch: 'main', execution_mode: 'full',
    }, owner);
    expect(proj.status).toBe(200);
    projectId = proj.body.data.project_id;

    const enroll = await api('POST', '/v2/nodes/enroll', { enrollment_ticket: '', node_id: nodeId }, owner);
    expect(enroll.body.ok).toBe(true);
    nodeCredential = enroll.body.data.node_credential;

    const register = await api('POST', '/v2/nodes/register', {
      node_id: nodeId, slots: 4, requested_project_ids: [projectId],
    }, bearer(nodeCredential));
    expect(register.status).toBe(200);

    const authorize = await api('POST', `/v2/projects/${projectId}/nodes/${nodeId}/authorize`, {}, owner);
    expect(authorize.body.ok).toBe(true);

    seedPlan();
    seedTask('task-p9r-1', projectId);
    const claim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(10).toString('hex')}`, task_id: 'task-p9r-1',
    }, bearer(nodeCredential));
    expect(claim.status).toBe(200);
    expect(claim.body.ok).toBe(true);
    attemptId = claim.body.data.attempt_id;
    attemptGeneration = claim.body.data.attempt_generation;
    claimToken = claim.body.data.attempt_token;
    expect(claimToken, `claim body=${JSON.stringify(claim.body)}`).toMatch(/^bva2_/);
    leaseExpiryBefore = claim.body.data.lease_expires_at;

    const attempt = store.getTaskAttempt(attemptId)!;
    expect(attempt.status).toBe('executing');
    expect(attempt.attempt_generation).toBe(attemptGeneration);
    const task = store.getTask('task-p9r-1')!;
    expect(task.status).toBe('running');
    expect(task.active_attempt_id).toBe(attemptId);
    const sessions = store.listNodeSessions(nodeId, 'active');
    expect(sessions.length).toBe(1);
    const snaps = store.listOwnershipSnapshots({ attemptId, activeOnly: true });
    expect(snaps.length).toBe(1);
  });

  it('FLUSHDB 后 SQLite 侧调度态原样：attempt/lease/task/snapshot/session 均不消失或复活', async () => {
    const auditBefore = store.listAuditEvents(undefined, 1000).length;
    const outboxBefore = store.listOutboxEvents(undefined, 1000).length;

    await redis.flushdb();

    const attempt = store.getTaskAttempt(attemptId)!;
    expect(attempt.status).toBe('executing');
    expect(attempt.attempt_generation).toBe(attemptGeneration);
    expect(attempt.lease_expires_at).toBe(leaseExpiryBefore);

    const task = store.getTask('task-p9r-1')!;
    expect(task.status).toBe('running');
    expect(task.active_attempt_id).toBe(attemptId);

    const sessions = store.listNodeSessions(nodeId, 'active');
    expect(sessions.length).toBe(1);
    const snaps = store.listOwnershipSnapshots({ attemptId, activeOnly: true });
    expect(snaps.length).toBe(1);

    // 一次普通读 + 一次心跳，确认服务在 Redis 清空后仍正常，且不产生新 audit/outbox
    const readTask = await api('GET', '/v2/plans/plan-p9r', undefined, owner);
    expect([200, 404]).toContain(readTask.status);
    const heartbeat = await api('POST', `/v2/nodes/${nodeId}/heartbeat`, {
      protocol_version: 2, clock_skew_ms: 0, disk_free_gib: 10, disk_free_percent: 50, slots_in_use: 1,
    }, bearer(nodeCredential));
    expect(heartbeat.status).toBe(200);

    const auditAfter = store.listAuditEvents(undefined, 1000).length;
    const outboxAfter = store.listOutboxEvents(undefined, 1000).length;
    // FLUSHDB 本身不触发重放；读/心跳也不应新增 audit/outbox（保持计数不变）
    expect(auditAfter).toBe(auditBefore);
    expect(outboxAfter).toBe(outboxBefore);
  });

  it('已 executing 的 task 在 FLUSHDB 后再次 claim → 409 ATTEMPT_ACTIVE（不开放旧 generation）', async () => {
    const reClaim = await api('POST', '/v2/tasks/claim', {
      project_id: projectId, agent_id: nodeId,
      claim_request_id: `cr-${randomBytes(10).toString('hex')}`, task_id: 'task-p9r-1',
    }, bearer(nodeCredential));
    expect(reClaim.status).toBe(409);
    expect(reClaim.body.error.code).toBe('ATTEMPT_ACTIVE');
  });

  it('旧 generation 的 bva2 token renew → 409 GENERATION_MISMATCH（lease 不复活）', async () => {
    expect(claimToken).toMatch(/^bva2_/);
    expect(attemptId).toBeTruthy();
    // 用当前 generation 的 token renew 应成功
    const good = await api('POST', `/v2/attempts/${attemptId}/lease/renew`, { extend_seconds: 60 }, bearer(claimToken));
    expect(good.status, `good renew body=${JSON.stringify(good.body)}`).toBe(200);
    const leaseAfterGood = store.getTaskAttempt(attemptId)!.lease_expires_at;

    // 伪造非当前 generation token（attempt_generation + 1；generation 必须 ≥1，
    // 因此不能用 0 模拟“旧”）。当前 executing 的 attempt 只认当前 generation，
    // 任何代际不一致都必须被 fencing，不允许 lease 复活。
    const staleToken = issueAttemptToken(attemptId, 'task-p9r-1', attemptGeneration + 1, 'claim');
    const bad = await api('POST', `/v2/attempts/${attemptId}/lease/renew`, { extend_seconds: 60 }, bearer(staleToken));
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('GENERATION_MISMATCH');

    // lease 未被代际不一致的 token 复活改写（保持 good renew 后的值）
    const attempt = store.getTaskAttempt(attemptId)!;
    expect(attempt.lease_expires_at).toBe(leaseAfterGood);
  });

  it('gap 如实声明：v2Keys Redis namespace 未被当前调度实现消费，清空重建验证以 SQLite 为真相源', () => {
    // 本测试不硬造“Redis 侧有缓存投影需重建”的断言；当前实现 node session /
    // attempt lease / ownership snapshot 全部直接落在 SqliteStore。
    // 若后续调度改走 Redis 缓存双写，需在 claim/heartbeat 路径补本测试的重建分支。
    expect(store.getTaskAttempt(attemptId)!.status).toBe('executing');
  });
});
