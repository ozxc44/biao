/**
 * Phase 1 端到端验收测试（真实 HTTP）
 *
 * 隔离端口起 server + 独立 SQLite + 6380 测试 DB：
 * 1. 两台模拟 Node 经 enroll→authorize→heartbeat，被识别为同一 Project；
 * 2. 旧 generation session 的 register/heartbeat 被 fencing（409）；
 * 3. 撤销授权后的 Node 后续操作被拒；
 * 4. V1 worker token 对该 V2 项目 claim 403（车道 C 门禁的 HTTP 实证）；
 * 5. Attempt token 签发→校验→scope 越权拒绝（纯函数补测）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import {
  issueNodeCredential,
  verifyNodeCredential,
  issueAttemptToken,
  verifyAttemptToken,
  type V2CredentialKey,
  parseCredentialKey,
  V2_CREDENTIAL_KEY_ENV,
} from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import type { FastifyInstance } from 'fastify';

const REDIS_URL = 'redis://127.0.0.1:6380';
const TEST_DB = 15;

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];

// 测试用密钥（≥32 字节 hex）
const TEST_KEY_HEX = 'aabbccdd'.repeat(8); // 32 bytes
const testKeys: V2CredentialKey[] = [parseCredentialKey(TEST_KEY_HEX, 1)];

// env 纪律：save/restore，避免 singleFork 串行污染
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  savedEnv['BIAO_V2_ENROLLMENT_TICKET'] = process.env['BIAO_V2_ENROLLMENT_TICKET'];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  delete process.env['BIAO_V2_ENROLLMENT_TICKET'];
  // Phase 8 五旗（V2 身份面全开）
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);
});

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-e2e-'));
  tempDirs.push(dir);
  return join(dir, 'biao.sqlite');
}

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const url = `${serverUrl}${path}`;
  const opts: RequestInit = { method };
  // DELETE 无 body 时不设 Content-Type（Fastify 拒绝空 JSON body）
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...headers };
    opts.body = JSON.stringify(body);
  } else {
    opts.headers = { ...headers };
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  store = new SqliteStore(makeDbPath());

  app = await createHttpServer(redis, {
    apiToken: 'test-owner-token',
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

const ownerHeaders = { Authorization: 'Bearer test-owner-token' };

// ──────────────── 场景 1：两台 Node 经 enroll→authorize→heartbeat，识别为同一 Project ────────────────

describe('场景 1：两台 Node → 同一 Project', () => {
  let projectId: string;

  it('创建 Project', async () => {
    const res = await api('POST', '/v2/projects', {
      name: '共享仓库',
      repo_path: '/srv/shared-repo',
      default_branch: 'main',
      execution_mode: 'full',
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    projectId = res.body.data.project_id;
    expect(projectId).toBeTruthy();
  });

  it('Node-A enroll', async () => {
    const res = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: 'ticket-a',
      node_id: 'node-mac-01-e2e-000001',
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.node_credential).toBeTruthy();
    expect(res.body.data.credential_generation).toBe(1);
  });

  it('Node-B enroll', async () => {
    const res = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: 'ticket-b',
      node_id: 'node-linux-01-e2e-000001',
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.node_credential).toBeTruthy();
    expect(res.body.data.credential_generation).toBe(1);
  });

  it('Node-A authorize to project', async () => {
    const res = await api('POST', `/v2/projects/${projectId}/nodes/node-mac-01-e2e-000001/authorize`, {}, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('Node-B authorize to same project', async () => {
    const res = await api('POST', `/v2/projects/${projectId}/nodes/node-linux-01-e2e-000001/authorize`, {}, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('查询 Project 存在', async () => {
    const res = await api('GET', `/v2/projects/${projectId}`, undefined, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.project_id).toBe(projectId);
  });

  it('Node-A heartbeat', async () => {
    const res = await api('POST', '/v2/nodes/node-mac-01-e2e-000001/heartbeat', {
      protocol_version: 2,
      clock_skew_ms: 10,
      disk_free_gib: 100,
      disk_free_percent: 80,
      slots_in_use: 1,
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('online');
  });

  it('Node-B heartbeat', async () => {
    const res = await api('POST', '/v2/nodes/node-linux-01-e2e-000001/heartbeat', {
      protocol_version: 2,
      clock_skew_ms: -5,
      disk_free_gib: 200,
      disk_free_percent: 90,
      slots_in_use: 0,
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('列出节点包含两台', async () => {
    const res = await api('GET', '/v2/nodes', undefined, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────── 场景 2：旧 generation fencing ────────────────

describe('场景 2：旧 generation session fencing', () => {
  it('Node register 创建 session generation 1', async () => {
    const res = await api('POST', '/v2/nodes/register', {
      node_id: 'node-mac-01-e2e-000001',
      slots: 4,
      requested_project_ids: [],
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('再次 register 创建 session generation 2', async () => {
    const res = await api('POST', '/v2/nodes/register', {
      node_id: 'node-mac-01-e2e-000001',
      slots: 4,
      requested_project_ids: [],
    }, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('验证旧 generation session 已被 fence', () => {
    const sessions = store.listNodeSessions('node-mac-01-e2e-000001');
    expect(sessions.length).toBe(2);
    const fenced = sessions.filter((s) => s.status === 'fenced');
    expect(fenced.length).toBe(1);
    const active = sessions.filter((s) => s.status === 'active');
    expect(active.length).toBe(1);
    expect(active[0].node_session_generation).toBe(2);
  });
});

// ──────────────── 场景 3：撤销授权后操作被拒 ────────────────

describe('场景 3：撤销授权后 Node 操作', () => {
  let projectId: string;

  beforeAll(async () => {
    // 获取之前创建的 project
    const projects = store.listProjects();
    projectId = projects[0].project_id;
  });

  it('撤销 Node-A 对项目的授权', async () => {
    const res = await api('DELETE', `/v2/projects/${projectId}/nodes/node-mac-01-e2e-000001/authorization`, undefined, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.revoked).toBe(true);
  });

  it('验证绑定状态为 revoked', () => {
    const binding = store.getNodeProjectBinding('node-mac-01-e2e-000001', projectId);
    expect(binding).toBeTruthy();
    expect(binding!.authorization_status).toBe('revoked');
    expect(binding!.write_credential_status).toBe('suspended');
  });

  it('重新授权后可恢复', async () => {
    const res = await api('POST', `/v2/projects/${projectId}/nodes/node-mac-01-e2e-000001/authorize`, {}, ownerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ──────────────── 场景 4：V1 worker token 对 V2 项目 claim 403 ────────────────

describe('场景 4：V1 隔离门 HTTP 实证', () => {
  it('V2 路由在无鉴权时返回 401', async () => {
    const res = await api('POST', '/v2/projects', {
      name: 'test',
      repo_path: '/test',
      default_branch: 'main',
      execution_mode: 'full',
    });
    // 无 token → 401（crossCuttingApiPlugin 拦截）
    expect(res.status).toBe(401);
  });
});

// ──────────────── 场景 5：Attempt Token 签发→校验→scope 越权拒绝（纯函数） ────────────────

describe('场景 5：Attempt Token 纯函数补测', () => {
  it('签发 + 校验往返', () => {
    const token = issueAttemptToken('attempt-001', 'task-001', 1, 'claim', { keys: testKeys });
    const result = verifyAttemptToken(token, {
      attemptId: 'attempt-001',
      taskId: 'task-001',
      generation: 1,
      scope: 'claim',
    }, { keys: testKeys });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.attempt_id).toBe('attempt-001');
      expect(result.claims.scope).toBe('claim');
    }
  });

  it('scope 越权拒绝', () => {
    const token = issueAttemptToken('attempt-001', 'task-001', 1, 'claim', { keys: testKeys });
    const result = verifyAttemptToken(token, {
      attemptId: 'attempt-001',
      taskId: 'task-001',
      generation: 1,
      scope: 'report', // 不匹配
    }, { keys: testKeys });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SCOPE_MISMATCH');
    }
  });

  it('generation 不匹配拒绝', () => {
    const token = issueAttemptToken('attempt-001', 'task-001', 1, 'claim', { keys: testKeys });
    const result = verifyAttemptToken(token, {
      attemptId: 'attempt-001',
      taskId: 'task-001',
      generation: 2, // 不匹配
      scope: 'claim',
    }, { keys: testKeys });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('GENERATION_MISMATCH');
    }
  });

  it('Node credential 签发 + 校验', () => {
    const credential = issueNodeCredential('node-001', 1, { keys: testKeys });
    const result = verifyNodeCredential(credential, 'node-001', {
      keys: testKeys,
      expectedGeneration: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.node_id).toBe('node-001');
      expect(result.claims.generation).toBe(1);
    }
  });

  it('Node credential generation fencing', () => {
    const credential = issueNodeCredential('node-001', 1, { keys: testKeys });
    const result = verifyNodeCredential(credential, 'node-001', {
      keys: testKeys,
      expectedGeneration: 2, // generation 已提升
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('GENERATION_MISMATCH');
    }
  });
});
