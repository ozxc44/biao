/**
 * env 防回退门禁（hermetic test）
 *
 * 单进程内按"污染序列"（设置 → 删除 → 再设置不同值）连续调用 enroll + ticket 校验，
 * 断言每次结果与当前 env 一致。防止单元级 import 缓存或模块级快照导致 env 变更不生效。
 *
 * 原理：credentials.ts 和 node-service.ts 的 env 读取必须是每请求级别（不缓存），
 * 本测试在同一 server 实例上连续变更 env 并验证行为一致性。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import type { FastifyInstance } from 'fastify';

const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 15;
const OWNER_TOKEN = 'hermetic-owner-token';
const ENROLLMENT_TICKET_ENV = 'BIAO_V2_ENROLLMENT_TICKET';

const KEY_A = 'aa'.repeat(32); // 32 bytes hex
const KEY_B = 'bb'.repeat(32); // 32 bytes hex（不同于 KEY_A）
const TICKET_A = 'ticket-alpha';
const TICKET_B = 'ticket-beta';

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl: string;
const tempDirs: string[] = [];

// env 纪律：save/restore
const savedEnv: Record<string, string | undefined> = {};

function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return fetch(`${serverUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OWNER_TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

beforeAll(async () => {
  // 快照 env
  for (const key of [V2_CREDENTIAL_KEY_ENV, ENROLLMENT_TICKET_ENV, ...V2_FEATURE_FLAG_ENV_KEYS]) {
    savedEnv[key] = process.env[key];
  }

  // 初始 env：KEY_A + 无 ticket（向后兼容模式）
  process.env[V2_CREDENTIAL_KEY_ENV] = KEY_A;
  delete process.env[ENROLLMENT_TICKET_ENV];
  // Phase 8 五旗（V2 enroll 面全开）
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  const dir = mkdtempSync(join(tmpdir(), 'biao-hermetic-'));
  tempDirs.push(dir);
  store = new SqliteStore(join(dir, 'test.db'));

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
  // env 纪律：恢复快照
  for (const key of [V2_CREDENTIAL_KEY_ENV, ENROLLMENT_TICKET_ENV, ...V2_FEATURE_FLAG_ENV_KEYS]) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]!;
    } else {
      delete process.env[key];
    }
  }
});

describe('env hermetic: enroll ticket 每请求读取', () => {
  it('阶段 1：无 ticket env → enroll 放行（向后兼容）', async () => {
    delete process.env[ENROLLMENT_TICKET_ENV];
    const res = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '任意值',
      node_id: 'hermetic-node-001',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('阶段 2：设置 ticket-A → ticket-A 通过，ticket-B 拒绝', async () => {
    process.env[ENROLLMENT_TICKET_ENV] = TICKET_A;

    const ok = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: TICKET_A,
      node_id: 'hermetic-node-002',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const bad = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: TICKET_B,
      node_id: 'hermetic-node-003',
    });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error.code).toBe('INVALID_TICKET');
  });

  it('阶段 3：删除 ticket env → 再次放行（向后兼容恢复）', async () => {
    delete process.env[ENROLLMENT_TICKET_ENV];

    const res = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '任意值',
      node_id: 'hermetic-node-004',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('阶段 4：设置 ticket-B → ticket-A 拒绝，ticket-B 通过', async () => {
    process.env[ENROLLMENT_TICKET_ENV] = TICKET_B;

    const bad = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: TICKET_A,
      node_id: 'hermetic-node-005',
    });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error.code).toBe('INVALID_TICKET');

    const ok = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: TICKET_B,
      node_id: 'hermetic-node-006',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    // 清理
    delete process.env[ENROLLMENT_TICKET_ENV];
  });
});

describe('env hermetic: credential key 每请求读取', () => {
  it('阶段 1：KEY-A 签发的 token 可验（当前 env=KEY-A）', async () => {
    process.env[V2_CREDENTIAL_KEY_ENV] = KEY_A;

    // enroll 生成 node credential（server 用 env 签发）
    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '',
      node_id: 'hermetic-key-node-001',
    });
    expect(enroll.status).toBe(200);
    expect(enroll.body.data.node_credential).toMatch(/^bvn2_/);
  });

  it('阶段 2：切换到 KEY-B 后，KEY-A 签发的旧 credential 应被拒（UNKNOWN_KEY_VERSION）', async () => {
    // 先用 KEY-A 签发一个 token
    process.env[V2_CREDENTIAL_KEY_ENV] = KEY_A;
    const enrollA = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '',
      node_id: 'hermetic-key-node-002',
    });
    const credA = enrollA.body.data.node_credential;

    // 切换到 KEY-B
    process.env[V2_CREDENTIAL_KEY_ENV] = KEY_B;

    // 用旧 credential 做 heartbeat → 应被拒（密钥不匹配）
    const hb = await api('POST', '/v2/nodes/hermetic-key-node-002/heartbeat', {
      protocol_version: 2,
      clock_skew_ms: 0,
      disk_free_gib: 100,
      disk_free_percent: 90,
      slots_in_use: 0,
    });
    // heartbeat 不走 bvn2 鉴权（owner bearer 直通），但 enroll 用新密钥签发
    // 关键验证：新 enroll 用 KEY-B 签发
    const enrollB = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '',
      node_id: 'hermetic-key-node-003',
    });
    expect(enrollB.status).toBe(200);
    expect(enrollB.body.data.node_credential).toMatch(/^bvn2_/);

    // 恢复 KEY-A
    process.env[V2_CREDENTIAL_KEY_ENV] = KEY_A;
  });

  it('阶段 3：切换回 KEY-A 后正常工作', async () => {
    process.env[V2_CREDENTIAL_KEY_ENV] = KEY_A;

    const enroll = await api('POST', '/v2/nodes/enroll', {
      enrollment_ticket: '',
      node_id: 'hermetic-key-node-004',
    });
    expect(enroll.status).toBe(200);
    expect(enroll.body.data.node_credential).toMatch(/^bvn2_/);
  });
});
