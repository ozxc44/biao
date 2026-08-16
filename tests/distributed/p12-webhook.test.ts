/**
 * P12 车道 C：Webhook/通知集成 + 备份调度 + 监控外接 + 安全加固
 *
 * 验证矩阵：
 * 1. 纯函数：HMAC 签名/验签（篡改拒绝）、Slack-compatible payload、事件源映射
 *    （Redis stream → task_done/review_requested、conflict → conflict_detected、
 *    incident → incident_opened）、注册输入校验；
 * 2. HTTP 全链路：POST/GET/DELETE /v2/webhooks（owner-only，secret 列表脱敏）；
 *    GET /v2/backup/status、POST /v2/backup/run（写 backup_runs + 失败开 incident）；
 *    GET /v2/metrics/prometheus（Prometheus 文本格式）；
 *    安全响应头（X-Content-Type-Options / X-Frame-Options）；
 * 3. 投递：dispatchEventToWebhooks 幂等 + 签名 + Slack payload；连续 3 次失败
 *    → webhook 标记 failed；
 * 4. dispatcher 周期：Redis events stream 写入 task_completed → runWebhookDispatchCycle
 *    把 webhook 投递（签名 + payload 断言）；
 * 5. 速率限制：BIAO_RATE_LIMIT_ENABLED=1 时 /auth/human-login 10 req/min → 429。
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { createHttpServer } from '../../src/server/http.js';
import { keys as redisKeys } from '../../src/redis/keys.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import {
  buildSlackCompatiblePayload,
  dispatchEventToWebhooks,
  mapConflictToWebhookEvent,
  mapIncidentToWebhookEvent,
  mapStreamEntryToWebhookEvent,
  processDueDeliveries,
  registerWebhook,
  runWebhookDispatchCycle,
  signWebhookPayload,
  validateWebhookInput,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
} from '../../src/server/v2/webhook-service.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.BIAO_TEST_REDIS_PORT ?? '6380'}`;
const TEST_DB = 14;
const OWNER_TOKEN = 'p12-webhook-owner';
const TEST_KEY = '00112233'.repeat(8); // 32 字节 hex

let redis: Redis;
let store: SqliteStore;
let app: FastifyInstance;
let serverUrl = '';

/* env 纪律：save/restore，singleFork 串行不泄漏。 */
const savedEnv: Record<string, string | undefined> = {};

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body !== undefined
      ? { 'Content-Type': 'application/json', ...headers }
      : { ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
  };
}

const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };

/** 捕获投递请求的 mock fetch（返回 200 并记录 payload/签名）。 */
function capturingFetch(): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; headers: Headers; body: string }>;
} {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? null),
    });
    return new Response('ok', { status: 200 });
  };
  return { fetchFn, calls };
}

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  savedEnv.BIAO_V2_WEBHOOK_INTERVAL_MS = process.env.BIAO_V2_WEBHOOK_INTERVAL_MS;
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);
  // 抑制 dispatcher 自动周期（测试手动驱动 runWebhookDispatchCycle）。
  process.env.BIAO_V2_WEBHOOK_INTERVAL_MS = '3600000';

  redis = new Redis(REDIS_URL, { db: TEST_DB, lazyConnect: true });
  await redis.connect();
  await redis.flushdb();

  store = new SqliteStore(':memory:');
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
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV]!;
  else delete process.env[V2_CREDENTIAL_KEY_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
  if (savedEnv.BIAO_V2_WEBHOOK_INTERVAL_MS !== undefined) process.env.BIAO_V2_WEBHOOK_INTERVAL_MS = savedEnv.BIAO_V2_WEBHOOK_INTERVAL_MS!;
  else delete process.env.BIAO_V2_WEBHOOK_INTERVAL_MS;
});

/* ──────────────── 1. 纯函数 ──────────────── */

describe('P12 webhook 纯函数', () => {
  it('HMAC 签名/验签：round-trip + 篡改拒绝 + secret 不匹配拒绝', () => {
    const payload = JSON.stringify({ text: 'hello', attachments: [] });
    const sig = signWebhookPayload('secret-1', payload);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('secret-1', `sha256=${sig}`, payload)).toBe(true);
    expect(verifyWebhookSignature('secret-2', `sha256=${sig}`, payload)).toBe(false);
    expect(verifyWebhookSignature('secret-1', `sha256=${sig}`, payload + 'x')).toBe(false);
    expect(verifyWebhookSignature('secret-1', 'sha256=bad', payload)).toBe(false);
    expect(verifyWebhookSignature('secret-1', sig, payload)).toBe(false); // 缺 sha256= 前缀
  });

  it('Slack-compatible payload：text + attachments + 结构化字段', () => {
    const payload = buildSlackCompatiblePayload({
      type: 'task_done',
      event_id: 'e1',
      task_id: 't-1',
      plan_id: 'p-1',
      project_path: '/repo',
      agent_id: 'a-1',
      result_status: 'done',
      ts: 1_700_000_000_000,
    });
    expect(payload.text).toContain('任务完成');
    const attachment = (payload.attachments as Array<Record<string, unknown>>)[0];
    expect(attachment.color).toBe('#36a64f');
    const fields = attachment.fields as Array<{ title: string; value: string }>;
    expect(fields).toEqual(expect.arrayContaining([
      { title: 'Task', value: 't-1', short: true },
      { title: 'Result', value: 'done', short: true },
    ]));
  });

  it('事件源映射：stream task_completed→task_done、review_requested、无关类型 null', () => {
    const done = mapStreamEntryToWebhookEvent('1700000000000-0', {
      type: 'task_completed', task_id: 't1', plan_id: 'p1', result_status: 'done', timestamp: '1700000000000',
    });
    expect(done).toMatchObject({ type: 'task_done', task_id: 't1', result_status: 'done' });

    const review = mapStreamEntryToWebhookEvent('1700000000001-0', {
      type: 'review_requested', task_id: 't2', timestamp: '1700000000001',
    });
    expect(review).toMatchObject({ type: 'review_requested', task_id: 't2' });

    expect(mapStreamEntryToWebhookEvent('1700000000002-0', { type: 'task_claimed', task_id: 't3' })).toBeNull();
  });

  it('冲突/incident 映射', () => {
    const conflict = mapConflictToWebhookEvent(JSON.stringify({
      ts: 123, path: '/a.ts', winner: { agent_id: 'w', task_id: 't1' }, loser: { agent_id: 'l' }, action: 'preempt',
    }));
    expect(conflict).toMatchObject({
      type: 'conflict_detected', task_id: 't1',
      details: { path: '/a.ts', winner_agent: 'w', loser_agent: 'l' },
    });

    const incident = mapIncidentToWebhookEvent({
      incident_id: 'inc-1', project_id: null, kind: 'backup_failed', severity: 'warning',
      status: 'open', title: '备份失败', detail: '', correlation_id: '', related_entity_type: 'restore_point',
      related_entity_id: 'rp-1', opened_at: 0, ack_due_at: 0, acked_at: null, acked_by: '', ack_note: '',
      resolved_at: null, resolved_by: '', resolution_evidence: '', revision: 1, created_at: 456, updated_at: 456,
    });
    expect(incident).toMatchObject({
      type: 'incident_opened', event_id: 'inc-1',
      details: { incident_id: 'inc-1', severity: 'warning', title: '备份失败' },
    });
  });

  it('注册校验：非法 URL / 事件类型 / 自动生成 secret', () => {
    expect(validateWebhookInput({ url: 'not-a-url' }).ok).toBe(false);
    expect(validateWebhookInput({ url: 'ftp://x' }).ok).toBe(false);
    const badEvent = validateWebhookInput({ url: 'https://hooks.slack.com/x', events: ['task_done', 'bogus'] });
    expect(badEvent.ok).toBe(false);
    const good = validateWebhookInput({ url: 'https://hooks.slack.com/x' });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.events).toEqual(['task_done', 'review_requested', 'conflict_detected', 'incident_opened']);
      expect(good.value.secret).toBeTruthy();
    }
  });
});

/* ──────────────── 2. HTTP 全链路 ──────────────── */

describe('P12 HTTP 路由', () => {
  let webhookId = '';

  it('POST /v2/webhooks：owner 注册成功（secret 返回一次），非 owner 401', async () => {
    const anonymous = await api('POST', '/v2/webhooks', { url: 'https://hooks.slack.com/services/x' });
    expect(anonymous.status).toBe(401);

    const res = await api('POST', '/v2/webhooks', {
      url: 'https://hooks.slack.com/services/T/B/TOKEN',
      events: ['task_done', 'incident_opened'],
    }, owner);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.webhook_id).toMatch(/^wh-/);
    expect(res.body.data.secret).toBeTruthy();
    expect(res.body.data.events).toBe(JSON.stringify(['task_done', 'incident_opened']));
    webhookId = res.body.data.webhook_id as string;
  });

  it('GET /v2/webhooks：列表 secret 脱敏（不泄露明文）', async () => {
    const res = await api('GET', '/v2/webhooks', undefined, owner);
    expect(res.status).toBe(200);
    const items = res.body.data.items as Array<Record<string, string>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const row = items.find((item) => item.webhook_id === webhookId)!;
    expect(row.secret).not.toContain('hooks.slack'); // 不是明文 secret
    expect(row.secret).toContain('...'); // 脱敏形态
  });

  it('GET /v2/webhooks/:id + DELETE + reactivate', async () => {
    const detail = await api('GET', `/v2/webhooks/${webhookId}`, undefined, owner);
    expect(detail.status).toBe(200);
    expect(detail.body.data.webhook_id).toBe(webhookId);

    const del = await api('DELETE', `/v2/webhooks/${webhookId}`, undefined, owner);
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    const gone = await api('GET', `/v2/webhooks/${webhookId}`, undefined, owner);
    expect(gone.status).toBe(404);
  });

  it('GET /v2/metrics/prometheus：Prometheus 文本格式', async () => {
    const res = await api('GET', '/v2/metrics/prometheus', undefined, owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await (await fetch(`${serverUrl}/v2/metrics/prometheus`, { headers: owner })).text();
    expect(text).toContain('# HELP biao_merge_jobs');
    expect(text).toContain('biao_metrics_timestamp');
  });

  it('POST /v2/backup/run 写 backup_runs + GET /v2/backup/status 可查', async () => {
    const run = await api('POST', '/v2/backup/run', undefined, owner);
    expect(run.status).toBe(200);
    expect(run.body.ok).toBe(true);
    expect(run.body.data.status).toBe('completed');
    expect(run.body.data.backup_runs).toHaveLength(3);
    expect(run.body.data.backup_runs.every((r: { status: string }) => r.status === 'completed')).toBe(true);

    const status = await api('GET', '/v2/backup/status', undefined, owner);
    expect(status.status).toBe(200);
    expect(status.body.data.latest).toBeTruthy();
    expect(status.body.data.restore_points.length).toBeGreaterThanOrEqual(1);
    expect(status.body.data.restore_points[0].summary).toMatchObject({ total: 3, completed: 3, failed: 0 });
  });

  it('安全响应头：X-Content-Type-Options / X-Frame-Options', async () => {
    const res = await api('GET', '/status', undefined, owner);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

/* ──────────────── 3. 投递服务层 ──────────────── */

describe('P12 webhook 投递', () => {
  it('dispatchEventToWebhooks：幂等 + 签名 + Slack payload 到订阅 webhook', async () => {
    const registered = registerWebhook(store, {
      url: 'https://capture.example/hook',
      events: ['task_done'],
      secret: 'hook-secret',
    });
    expect(registered.ok).toBe(true);
    const webhookId = registered.ok ? registered.data.webhook_id : '';

    const { fetchFn, calls } = capturingFetch();
    const event = { type: 'task_done' as const, event_id: 'evt-1', task_id: 't-1', ts: Date.now() };

    const first = await dispatchEventToWebhooks(store, event, { fetchFn });
    expect(first).toMatchObject({ created: 1, attempted: 1, delivered: 1 });

    // 幂等：同 event 不重复建 delivery
    const second = await dispatchEventToWebhooks(store, event, { fetchFn });
    expect(second).toMatchObject({ created: 0, attempted: 0, delivered: 0 });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://capture.example/hook');
    expect(call.headers.get('X-Biao-Signature')).toBe(`sha256=${signWebhookPayload('hook-secret', call.body)}`);
    expect(call.headers.get('X-Biao-Event')).toBe('task_done');
    const payload = JSON.parse(call.body) as { text: string; attachments: unknown[] };
    expect(payload.attachments).toHaveLength(1);

    const deliveryRow = store.listWebhookDeliveriesByWebhook(webhookId, 10)[0];
    expect(deliveryRow).toMatchObject({ status: 'delivered', event_type: 'task_done', event_id: 'evt-1' });
  });

  it('连续 3 次失败 → webhook 标记 failed；重启用后恢复投递', async () => {
    const registered = registerWebhook(store, {
      url: 'https://fail.example/hook',
      events: ['conflict_detected'],
      secret: 'fail-secret',
    });
    expect(registered.ok).toBe(true);
    const webhookId = registered.ok ? registered.data.webhook_id : '';

    const failingFetch = async () => new Response('nope', { status: 500 });

    // 第 1 次（立即）+ 第 2 次（重试 1）→ 仍 pending
    const evt = { type: 'conflict_detected' as const, event_id: 'evt-conflict', task_id: 't-x', ts: Date.now() };
    await dispatchEventToWebhooks(store, evt, { fetchFn: failingFetch });
    expect(store.getWebhookRegistration(webhookId)!.status).toBe('active');

    // 第 2 次重试（下一次到期）
    await processDueDeliveries(store, { fetchFn: failingFetch, now: () => Date.now() + 120_000 });
    expect(store.getWebhookRegistration(webhookId)!.status).toBe('active');

    // 第 3 次重试 → failed
    await processDueDeliveries(store, { fetchFn: failingFetch, now: () => Date.now() + 600_000 });
    const webhook = store.getWebhookRegistration(webhookId)!;
    expect(webhook.status).toBe('failed');
    expect(webhook.failure_count).toBe(WEBHOOK_MAX_ATTEMPTS);

    // 重启用 → 新事件（新 event_id）恢复投递
    store.updateWebhookRegistration(webhookId, { status: 'active', failure_count: 0, updated_at: Date.now() });
    const { fetchFn, calls } = capturingFetch();
    const evt2 = { ...evt, event_id: 'evt-conflict-2' };
    await dispatchEventToWebhooks(store, evt2, { fetchFn });
    expect(calls).toHaveLength(1);
  });
});

/* ──────────────── 4. dispatcher 周期 ──────────────── */

describe('P12 webhook dispatcher', () => {
  it('Redis events stream → task_completed → webhook 收到 task_done 投递', async () => {
    // 独立 store：不与前序测试注册的 webhook 共享订阅面，断言 created 精确 =1。
    const dispatcherStore = new SqliteStore(':memory:');
    try {
      const registered = registerWebhook(dispatcherStore, {
        url: 'https://dispatch.example/hook',
        events: ['task_done'],
        secret: 'dispatch-secret',
      });
      expect(registered.ok).toBe(true);

      const now = Date.now();
      const { fetchFn, calls } = capturingFetch();
      await redis.xadd(redisKeys.stream.events, '*',
        'event_id', `${now}_t1`,
        'type', 'task_completed',
        'task_id', 't1',
        'plan_id', 'p1',
        'project_path', '/repo',
        'agent_id', 'a1',
        'result_status', 'done',
        'timestamp', String(now),
      );

      const result = await runWebhookDispatchCycle(dispatcherStore, redis, { fetchFn });
      expect(result.created).toBe(1);
      expect(result.delivered).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.get('X-Biao-Event')).toBe('task_done');
      expect(JSON.parse(calls[0].body)).toMatchObject({ text: expect.stringContaining('任务完成') });

      // 游标推进：再跑一轮不重复投递（同一事件）
      const again = await runWebhookDispatchCycle(dispatcherStore, redis, { fetchFn });
      expect(again.created).toBe(0);
    } finally {
      dispatcherStore.close();
    }
  });
});

/* ──────────────── 5. 速率限制 ──────────────── */

describe('P12 速率限制（独立 app，env 显式开启）', () => {
  let rlApp: FastifyInstance;
  let rlUrl = '';
  const rlSavedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    rlSavedEnv.BIAO_RATE_LIMIT_ENABLED = process.env.BIAO_RATE_LIMIT_ENABLED;
    rlSavedEnv.BIAO_RATE_LIMIT_LOGIN_MAX = process.env.BIAO_RATE_LIMIT_LOGIN_MAX;
    rlSavedEnv.BIAO_RATE_LIMIT_GLOBAL_MAX = process.env.BIAO_RATE_LIMIT_GLOBAL_MAX;
    process.env.BIAO_RATE_LIMIT_ENABLED = '1';
    process.env.BIAO_RATE_LIMIT_LOGIN_MAX = '3';
    process.env.BIAO_RATE_LIMIT_GLOBAL_MAX = '1000';
    rlApp = await createHttpServer(redis, {
      apiToken: OWNER_TOKEN,
      host: '127.0.0.1',
      port: 0,
      workspaceRoots: [],
    }, { sqliteStore: store });
    await rlApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = rlApp.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    rlUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (rlApp) await rlApp.close();
    for (const key of ['BIAO_RATE_LIMIT_ENABLED', 'BIAO_RATE_LIMIT_LOGIN_MAX', 'BIAO_RATE_LIMIT_GLOBAL_MAX']) {
      if (rlSavedEnv[key] !== undefined) process.env[key] = rlSavedEnv[key]!;
      else delete process.env[key];
    }
  });

  it('/auth/human-login 超过 loginMax → 429', async () => {
    const attempt = async () => {
      const res = await fetch(`${rlUrl}/auth/human-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: rlUrl, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ username: 'u', password: 'p' }),
      });
      return res.status;
    };
    const statuses = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
    // max=3/min：并发下前 3 个请求进入 handler（401 未知用户 / 503 无 sqlite 全局实例），
    // 后 2 个被限流 429。并发的到达顺序不确定，只断言 429 数量 ≥2 且放行数量 ≥3。
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
    expect(statuses.filter((s) => s !== 429).length).toBeGreaterThanOrEqual(3);
  });
});
