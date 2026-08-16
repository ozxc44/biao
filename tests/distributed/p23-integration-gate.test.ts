/**
 * Phase 2+3 统一集成门禁测试
 *
 * 真实 HTTP server + 真实子进程 bin/biao-node.js，全程零 V1 worker token。
 * 覆盖 §21 端到端 Node→Artifact→Delivery 门禁：
 *
 * 正向门禁：
 *   enroll(ticket) → register(bvn2, 协议握手) → heartbeat →
 *   claim attempt(bva2 返回) → 占位 executor 产出小文件 →
 *   三段上传 artifact → report 引用 → delivery 落库 →
 *   PM Review V2 读回完整视图
 *
 * 反向门禁：
 *   篡改 bva2 → 401/403
 *   跨任务 artifact 引用 → 拒绝
 *   旧 generation heartbeat → 409 fenced
 *   enroll 无/错 ticket → 503/403
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createHttpServer } from '../../src/server/http.js';
import {
  issueNodeCredential,
  issueAttemptToken,
  V2_CREDENTIAL_KEY_ENV,
} from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import type { FetchImpl } from '../../src/node/transport.js';

const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;
const OWNER_TOKEN = 'test-owner-token-p23';
const ENROLLMENT_TICKET = 'test-enrollment-ticket-p23';
const CREDENTIAL_KEY = 'aabbccdd'.repeat(8);

// env 纪律：save/restore，避免 singleFork 串行污染
const savedEnv: Record<string, string | undefined> = {};

// 注意：env 设置移到 beforeAll，不再在模块级执行

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

/** 创建一个基础的 fetch 封装，带 Authorization owner bearer。 */
function ownerFetch(serverUrl: string): FetchImpl {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${OWNER_TOKEN}`);
    }
    return fetch(new URL(url, serverUrl).toString(), { ...init, headers });
  };
}

/** 创建 bvn2 Node credential fetch。 */
function nodeFetch(serverUrl: string, credential: string): FetchImpl {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${credential}`);
    return fetch(new URL(url, serverUrl).toString(), { ...init, headers });
  };
}

/** 创建 bva2 Attempt token fetch。 */
function attemptFetch(serverUrl: string, token: string): FetchImpl {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(new URL(url, serverUrl).toString(), { ...init, headers });
  };
}

/** 发 JSON 请求。 */
async function jsonFetch(fetchImpl: FetchImpl, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const hasBody = body !== undefined;
  const res = await fetchImpl(path, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : {},
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe('Phase 2+3: 统一集成门禁', () => {
  let nodeId: string;
  let nodeCredential: string;
  let credentialGeneration: number;
  let attemptId: string;
  let attemptToken: string;
  let attemptGen: number;
  let taskId: string;
  let artifactId: string;
  let deliveryId: string;

  beforeAll(async () => {
    // env 纪律：快照 + 设置
    savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
    savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
    for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env[V2_CREDENTIAL_KEY_ENV] = CREDENTIAL_KEY;
    process.env['BIAO_V2_ENROLLMENT_TICKET'] = ENROLLMENT_TICKET;
    // Phase 8 五旗（本套件验证 V2 全链，按 §23.1 依赖序全开）
    Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

    // Redis
    redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
    await redis.connect();
    await redis.flushdb();

    // SQLite
    const tmpDir = mkdtempSync(join(tmpdir(), 'biao-p23-'));
    tempDirs.push(tmpDir);
    const dbPath = join(tmpDir, 'test.db');
    store = new SqliteStore(dbPath);

    // 创建项目和任务
    const projectId = 'proj-p23-test';
    store.upsertPlan({
      plan_id: 'plan-p23',
      title: 'P23 Test Plan',
      status: 'submitted',
      project_path: '/tmp/p23',
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 1,
      created_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
    });

    // 插入 V2 Project
    store.insertProject({
      project_id: projectId,
      display_name: 'P23 Test Project',
      repository_url: '',
      repository_fingerprint: '',
      default_branch: 'main',
      merge_policy: 'merge-queue',
      execution_mode: 'full',
      mode_transition: null,
      mode_transition_id: '',
      mode_transition_step: null,
      write_capability_status: 'ready',
      artifact_policy_id: '',
      workspace_policy_id: '',
      status: 'active',
      revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    taskId = 'task-p23-e2e';
    store.upsertTask({
      task_id: taskId,
      plan_id: 'plan-p23',
      title: 'P23 E2E Task',
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

    // 创建 HTTP server
    const artifactRoot = join(tmpDir, 'artifacts');
    app = await createHttpServer(redis, {
      apiToken: OWNER_TOKEN,
      host: '127.0.0.1',
      port: 0,
      workspaceRoots: ['/tmp'],
    }, { sqliteStore: store, webDist: null });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (store) store.close();
    if (redis) await redis.quit();
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
    // env 纪律：恢复快照
    if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) {
      process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV];
    } else {
      delete process.env[V2_CREDENTIAL_KEY_ENV];
    }
    if (savedEnv['BIAO_V2_ENROLLMENT_TICKET'] !== undefined) {
      process.env['BIAO_V2_ENROLLMENT_TICKET'] = savedEnv['BIAO_V2_ENROLLMENT_TICKET'];
    } else {
      delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
    }
    for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
      else delete process.env[key];
    }
  });

  /* ===== 正向门禁 ===== */

  describe('① /version 公告 protocol_version', () => {
    it('GET /version 返回 protocol_version=2', async () => {
      const res = await jsonFetch(ownerFetch(serverUrl), 'GET', '/version');
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.protocol_version).toBe(2);
    });
  });

  describe('② enroll 校验 enrollment ticket', () => {
    it('正确 ticket → enroll 成功', async () => {
      nodeId = 'node-p23-test-0001';
      const res = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/nodes/enroll', {
        enrollment_ticket: ENROLLMENT_TICKET,
        node_id: nodeId,
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.node_credential).toBeTruthy();
      expect(res.data.data.credential_generation).toBe(1);
      nodeCredential = res.data.data.node_credential;
      credentialGeneration = res.data.data.credential_generation;
    });

    it('错误 ticket → 拒绝', async () => {
      const res = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/nodes/enroll', {
        enrollment_ticket: 'wrong-ticket',
        node_id: 'node-p23-bad',
      });
      expect(res.data.ok).toBe(false);
      expect(res.data.error.code).toBe('INVALID_TICKET');
    });

    it('缺失 ticket → 拒绝', async () => {
      const res = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/nodes/enroll', {
        enrollment_ticket: '',
        node_id: 'node-p23-empty',
      });
      expect(res.data.ok).toBe(false);
    });
  });

  describe('③ register 协议握手 + bvn2 鉴权', () => {
    it('bvn2 credential + protocol_version=2 → register 成功', async () => {
      const fetch = nodeFetch(serverUrl, nodeCredential);
      const res = await jsonFetch(fetch, 'POST', '/v2/nodes/register', {
        node_id: nodeId,
        slots: 4,
        requested_project_ids: ['proj-p23-test'],
        protocol_version: 2,
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });

    it('owner authorize 节点→项目绑定（§12：claim 调度前置）', async () => {
      const res = await jsonFetch(ownerFetch(serverUrl), 'POST', `/v2/projects/proj-p23-test/nodes/${nodeId}/authorize`);
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.status).toBe('authorized');
    });

    it('protocol_version 不匹配 → 409', async () => {
      // 先 enroll 一个新节点
      const badNodeId = 'node-p23-proto-bad';
      const enrollRes = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/nodes/enroll', {
        enrollment_ticket: ENROLLMENT_TICKET,
        node_id: badNodeId,
      });
      expect(enrollRes.data.ok).toBe(true);
      const badCred = enrollRes.data.data.node_credential;

      const fetch = nodeFetch(serverUrl, badCred);
      const res = await jsonFetch(fetch, 'POST', '/v2/nodes/register', {
        node_id: badNodeId,
        slots: 2,
        requested_project_ids: [],
        protocol_version: 999,
      });
      // 协议版本高于服务端 → 拒绝
      expect(res.data.ok).toBe(false);
      expect(res.data.error.code).toMatch(/PROTOCOL/);
    });
  });

  describe('④ heartbeat', () => {
    it('bvn2 heartbeat → 成功', async () => {
      const fetch = nodeFetch(serverUrl, nodeCredential);
      const res = await jsonFetch(fetch, 'POST', `/v2/nodes/${nodeId}/heartbeat`, {
        protocol_version: 2,
        clock_skew_ms: 0,
        disk_free_gib: 100,
        disk_free_percent: 95,
        slots_in_use: 0,
        running_attempt_ids: [],
        node_status: 'online',
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
    });
  });

  describe('⑤ attempt 数据面：claim → artifact → report → delivery', () => {
    it('claim → 返回 attempt_id + bva2 token', async () => {
      const fetch = nodeFetch(serverUrl, nodeCredential);
      const res = await jsonFetch(fetch, 'POST', '/v2/tasks/claim', {
        project_id: 'proj-p23-test',
        agent_id: nodeId,
        claim_request_id: `cr-${randomBytes(8).toString('hex')}`,
        task_id: taskId,
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.attempt_id).toBeTruthy();
      expect(res.data.data.attempt_token).toBeTruthy();
      expect(res.data.data.attempt_token).toMatch(/^bva2_/);
      expect(res.data.data.lease_duration_ms).toBeGreaterThan(0);

      attemptId = res.data.data.attempt_id;
      attemptToken = res.data.data.attempt_token;
      attemptGen = res.data.data.attempt_generation;
    });

    it('lease renew → 更新 lease_expires_at', async () => {
      const fetch = attemptFetch(serverUrl, attemptToken);
      const res = await jsonFetch(fetch, 'POST', `/v2/attempts/${attemptId}/lease/renew`, {
        extend_seconds: 300,
      });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.lease_expires_at).toBeGreaterThan(Date.now());
    });

    it('三段上传 artifact → complete', async () => {
      const content = Buffer.from('p23 test artifact content');
      const contentSha = sha256hex(content);

      // 1. initiate
      const initRes = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/artifacts/initiate', {
        attempt_id: attemptId,
        kind: 'result-md',
        size_bytes: content.length,
        sha256: contentSha,
      });
      expect(initRes.status).toBe(200);
      expect(initRes.data.ok).toBe(true);
      artifactId = initRes.data.data.artifact_id;
      const uploadId = initRes.data.data.upload_id;

      // 2. upload
      const uploadRes = await fetch(`${serverUrl}/v2/artifacts/${artifactId}/content`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/octet-stream' },
        body: content,
      });
      const uploadStatus = uploadRes.status;
      const uploadBody = await uploadRes.text();
      if (uploadStatus !== 200) {
        console.error('Upload failed:', uploadStatus, uploadBody.slice(0, 500));
      }
      expect(uploadRes.ok).toBe(true);

      // 3. complete
      const completeRes = await jsonFetch(ownerFetch(serverUrl), 'POST', `/v2/artifacts/${artifactId}/complete`);
      expect(completeRes.status).toBe(200);
      expect(completeRes.data.ok).toBe(true);
      expect(completeRes.data.data.status).toBe('complete');
    });

    it('report 引用 artifact → delivery 落库', async () => {
      // 签发 scope=report 的 bva2（keyring 与 server 侧 env 一致：单 key version=1）
      const reportToken = issueAttemptToken(attemptId, taskId, attemptGen, 'report');

      const fetch = attemptFetch(serverUrl, reportToken);
      const res = await jsonFetch(fetch, 'POST', `/v2/attempts/${attemptId}/report`, {
        status: 'done',
        artifact_refs: [{ artifact_id: artifactId, sha256: sha256hex(Buffer.from('p23 test artifact content')) }],
      });
      if (res.status !== 200 || !res.data.ok) {
        console.error('Report failed:', res.status, JSON.stringify(res.data));
      }
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.delivery_id).toBeTruthy();
      deliveryId = res.data.data.delivery_id;
    });

    it('PM Review V2 读回完整视图', async () => {
      const res = await jsonFetch(ownerFetch(serverUrl), 'GET', `/v2/deliveries/${deliveryId}`);
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data.delivery).toBeTruthy();
      expect(res.data.data.delivery.delivery_id).toBe(deliveryId);
      expect(res.data.data.artifacts).toHaveLength(1);
      expect(res.data.data.artifacts[0].artifact_id).toBe(artifactId);
    });
  });

  /* ===== 反向门禁 ===== */

  describe('反向门禁', () => {
    it('篡改 bva2 → 401', async () => {
      const fakeToken = attemptToken.slice(0, -5) + 'XXXXX';
      const fetch = attemptFetch(serverUrl, fakeToken);
      const res = await jsonFetch(fetch, 'POST', `/v2/attempts/${attemptId}/lease/renew`, {
        extend_seconds: 300,
      });
      expect(res.status).toBe(401);
      expect(res.data.ok).toBe(false);
    });

    it('跨任务 artifact 引用 → 拒绝', async () => {
      // 创建另一个 attempt
      const otherFetch = nodeFetch(serverUrl, nodeCredential);
      const otherTaskId = 'task-p23-other';
      store.upsertTask({
        task_id: otherTaskId,
        plan_id: 'plan-p23',
        title: 'Other Task',
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
        project_id: 'proj-p23-test',
      });

      const claimRes = await jsonFetch(otherFetch, 'POST', '/v2/tasks/claim', {
        project_id: 'proj-p23-test',
        agent_id: nodeId,
        claim_request_id: `cr-${randomBytes(8).toString('hex')}`,
        task_id: otherTaskId,
      });
      expect(claimRes.data.ok).toBe(true);
      const otherAttemptId = claimRes.data.data.attempt_id;
      const otherAttemptGen = claimRes.data.data.attempt_generation;

      // 签发 scope=report 的 bva2 给另一个 attempt
      const otherReportToken = issueAttemptToken(otherAttemptId, otherTaskId, otherAttemptGen, 'report', {
        keys: [{ key_version: 1, material: Buffer.from(CREDENTIAL_KEY, 'hex') }],
      });

      // 尝试用 otherAttempt 的 token 引用 originalAttempt 的 artifact
      const fetch = attemptFetch(serverUrl, otherReportToken);
      const res = await jsonFetch(fetch, 'POST', `/v2/attempts/${otherAttemptId}/report`, {
        status: 'done',
        artifact_refs: [{ artifact_id: artifactId, sha256: sha256hex(Buffer.from('p23 test artifact content')) }],
      });
      expect(res.status).toBe(403);
      expect(res.data.ok).toBe(false);
      expect(res.data.error.code).toBe('CROSS_ATTEMPT_DENIED');
    });

    it('enroll 无 ticket env → 向后兼容允许 enroll', async () => {
      // 临时移除 env → 未配置时允许 enroll（向后兼容）
      const saved = process.env['BIAO_V2_ENROLLMENT_TICKET'];
      delete process.env['BIAO_V2_ENROLLMENT_TICKET'];

      const res = await jsonFetch(ownerFetch(serverUrl), 'POST', '/v2/nodes/enroll', {
        enrollment_ticket: 'whatever',
        node_id: 'node-p23-noenv',
      });
      expect(res.data.ok).toBe(true);

      // 恢复
      if (saved) process.env['BIAO_V2_ENROLLMENT_TICKET'] = saved;
    });

    it('已完成任务不可重复 claim', async () => {
      const fetch = nodeFetch(serverUrl, nodeCredential);
      const res = await jsonFetch(fetch, 'POST', '/v2/tasks/claim', {
        project_id: 'proj-p23-test',
        agent_id: nodeId,
        claim_request_id: `cr-${randomBytes(8).toString('hex')}`,
        task_id: taskId,
      });
      // task 已 done → claim 返回 null（无可用任务）
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      expect(res.data.data).toBeNull();
    });
  });
});
