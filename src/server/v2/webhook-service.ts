/**
 * V2 Webhook 服务（P12 车道 C · §9 Webhook/通知集成）
 *
 * - POST /v2/webhooks（owner）：注册 webhook URL + HMAC secret + 订阅事件清单；
 * - 事件：task_done（任务完成）、review_requested（进入 PM 签核）、
 *   conflict_detected（文件占用冲突）、incident_opened（incident 开单）；
 * - 签名：HMAC-SHA256（X-Biao-Signature: sha256=<hex>，验签共用同一 secret）；
 * - 投递：Slack-compatible JSON payload；失败按指数退避重试，连续 3 次后把
 *   webhook 标记 failed（不再自动投递，owner 可重启用）；
 * - 投递记录持久化到 webhook_deliveries；dispatcher 游标持久化到
 *   webhook_dispatcher_state（重启恢复，断点续扫）。
 *
 * 事件源接线（不改 src/server/service.ts）：
 * - task_done / review_requested ← Redis events stream（type=task_completed /
 *   review_requested）；
 * - conflict_detected ← Redis list:ownership_conflicts（logConflict 写入）；
 * - incident_opened ← incidents 表（created_at 水位）。
 * createWebhookDispatcher 周期轮询三个源，按 (webhook_id, event_type, event_id)
 * 幂等去重（重复处理不产生重复投递）。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type Redis from 'ioredis';
import type { SqliteStore } from '../../db/sqlite-store.js';
import { keys as redisKeys } from '../../redis/keys.js';
import type { IncidentRow, WebhookDeliveryRow, WebhookRegistrationRow } from '../../types/v2-infra.js';

/** 受支持的 webhook 事件类型（§9 枚举）。 */
export const WEBHOOK_EVENT_TYPES = [
  'task_done',
  'review_requested',
  'conflict_detected',
  'incident_opened',
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

/** 连续失败次数上限：达到后 webhook 标记 failed（§9）。 */
export const WEBHOOK_MAX_ATTEMPTS = 3;

/** 投递退避间隔（毫秒）：第 n 次失败后的重试间隔。 */
export const WEBHOOK_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;

/** dispatcher 默认轮询间隔（毫秒），env BIAO_V2_WEBHOOK_INTERVAL_MS 可调。 */
export const DEFAULT_WEBHOOK_DISPATCH_INTERVAL_MS = 30_000;
export const WEBHOOK_DISPATCH_INTERVAL_ENV = 'BIAO_V2_WEBHOOK_INTERVAL_MS';

/** 领域事件 → webhook 投递负载的中间表示。 */
export interface WebhookEvent {
  type: WebhookEventType;
  event_id: string;
  task_id?: string;
  plan_id?: string;
  project_path?: string;
  agent_id?: string;
  result_status?: string;
  ts: number;
  /** 冲突/incident 等结构化的附加明细（Slack field 用）。 */
  details?: Record<string, unknown>;
}

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function fail<T = never>(code: string, message: string): { ok: false; data: null; error: { code: string; message: string } } {
  return { ok: false, data: null, error: { code, message } };
}

/** HMAC-SHA256 签名（hex）。payload 必须是投递时使用的原始 JSON 字符串。 */
export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** 常量时间比较验签（格式：`sha256=<hex>`）。 */
export function verifyWebhookSignature(secret: string, signature: string, payload: string): boolean {
  const expected = `sha256=${signWebhookPayload(secret, payload)}`;
  if (signature.length !== expected.length) return false;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return timingSafeEqual(a, b);
}

/**
 * Slack-compatible payload（Slack Incoming Webhook JSON 格式）：
 * text 是纯文本摘要，attachments 提供结构化字段，供 Slack/Teams/自建桥接解析。
 */
export function buildSlackCompatiblePayload(event: WebhookEvent): Record<string, unknown> {
  const title = webhookEventTitle(event);
  const fields: Array<{ title: string; value: string; short: boolean }> = [
    { title: 'Event', value: event.type, short: true },
  ];
  if (event.task_id) fields.push({ title: 'Task', value: event.task_id, short: true });
  if (event.plan_id) fields.push({ title: 'Plan', value: event.plan_id, short: true });
  if (event.project_path) fields.push({ title: 'Project', value: event.project_path, short: false });
  if (event.agent_id) fields.push({ title: 'Agent', value: event.agent_id, short: true });
  if (event.result_status) fields.push({ title: 'Result', value: event.result_status, short: true });
  if (event.details) {
    for (const [key, value] of Object.entries(event.details)) {
      fields.push({ title: key, value: String(value), short: true });
    }
  }
  return {
    text: title,
    attachments: [
      {
        color: eventColor(event.type),
        title,
        fields,
        ts: Math.floor(event.ts / 1000),
      },
    ],
  };
}

function eventColor(type: WebhookEventType): string {
  switch (type) {
    case 'task_done': return '#36a64f'; // green
    case 'review_requested': return '#3aa0e1'; // blue
    case 'conflict_detected': return '#eb6420'; // orange
    case 'incident_opened': return '#d00000'; // red
  }
}

function webhookEventTitle(event: WebhookEvent): string {
  const subject = event.task_id ? `task ${event.task_id}` : event.event_id;
  switch (event.type) {
    case 'task_done': return `✅ 任务完成：${subject}`;
    case 'review_requested': return `📋 待 PM 签核：${subject}`;
    case 'conflict_detected': return `⚠️ 文件占用冲突：${subject}`;
    case 'incident_opened': return `🚨 Incident 开单：${subject}`;
  }
}

/** 校验注册输入；返回规范化后的行（不含 id/时间戳）。 */
export function validateWebhookInput(input: {
  url: string;
  events?: string[];
  secret?: string;
}): { ok: true; value: { url: string; events: WebhookEventType[]; secret: string } } | { ok: false; data: null; error: { code: string; message: string } } {
  if (!input.url || typeof input.url !== 'string') {
    return fail('INVALID_URL', 'url 必填');
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail('INVALID_URL', `url 不是合法 URL：${input.url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail('INVALID_URL', 'url 必须使用 http/https 协议');
  }
  const events = input.events && input.events.length > 0 ? input.events : [...WEBHOOK_EVENT_TYPES];
  const invalid = events.find((event) => !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType));
  if (invalid) {
    return fail('INVALID_EVENT', `不支持的事件类型：${invalid}（允许 ${WEBHOOK_EVENT_TYPES.join(', ')}）`);
  }
  const secret = input.secret && input.secret.trim() ? input.secret.trim() : randomSecret();
  return { ok: true, value: { url: input.url, events: events as WebhookEventType[], secret } };
}

function randomSecret(): string {
  return createHmac('sha256', randomUUID()).update(String(Date.now())).digest('hex').slice(0, 32);
}

/* ──────────────────────────────────────────────────────────────── */
/* 注册管理                                                        */
/* ──────────────────────────────────────────────────────────────── */

export interface RegisterWebhookInput {
  url: string;
  events?: string[];
  /** 可选：调用方提供 secret（未提供自动生成并仅返回一次）。 */
  secret?: string;
}

export function registerWebhook(
  store: SqliteStore,
  input: RegisterWebhookInput,
  now = Date.now(),
): { ok: true; data: WebhookRegistrationRow } | { ok: false; data: null; error: { code: string; message: string } } {
  const validated = validateWebhookInput(input);
  if (!validated.ok) return validated;
  const webhookId = `wh-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const row: WebhookRegistrationRow = {
    webhook_id: webhookId,
    url: validated.value.url,
    secret: validated.value.secret,
    events: JSON.stringify(validated.value.events),
    status: 'active',
    failure_count: 0,
    last_delivered_at: null,
    created_by: 'owner',
    created_at: now,
    updated_at: now,
  };
  store.insertWebhookRegistration(row);
  return ok(row);
}

export function listWebhooks(store: SqliteStore, status?: string): { items: WebhookRegistrationRow[] } {
  const rows = status ? store.listWebhookRegistrations(status) : store.listWebhookRegistrations();
  // secret 是敏感字段：列表只回传脱敏视图（hash 前缀），详情/创建响应才含明文。
  return { items: rows.map((row) => ({ ...row, secret: maskSecret(row.secret) })) };
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function getWebhook(store: SqliteStore, webhookId: string): { ok: true; data: WebhookRegistrationRow } | { ok: false; data: null; error: { code: string; message: string } } {
  const row = store.getWebhookRegistration(webhookId);
  if (!row) return fail('WEBHOOK_NOT_FOUND', `webhook ${webhookId} 不存在`);
  return ok({ ...row, secret: maskSecret(row.secret) });
}

export function deleteWebhook(store: SqliteStore, webhookId: string): { ok: true; data: { webhook_id: string; deleted: true } } | { ok: false; data: null; error: { code: string; message: string } } {
  const row = store.getWebhookRegistration(webhookId);
  if (!row) return fail('WEBHOOK_NOT_FOUND', `webhook ${webhookId} 不存在`);
  store.deleteWebhookRegistration(webhookId);
  return ok({ webhook_id: webhookId, deleted: true });
}

/** owner 把 failed/disabled 的 webhook 重新启用（清空失败计数）。 */
export function reactivateWebhook(store: SqliteStore, webhookId: string, now = Date.now()): { ok: true; data: WebhookRegistrationRow } | { ok: false; data: null; error: { code: string; message: string } } {
  const row = store.getWebhookRegistration(webhookId);
  if (!row) return fail('WEBHOOK_NOT_FOUND', `webhook ${webhookId} 不存在`);
  store.updateWebhookRegistration(webhookId, {
    status: 'active',
    failure_count: 0,
    updated_at: now,
  });
  return ok(store.getWebhookRegistration(webhookId)!);
}

/* ──────────────────────────────────────────────────────────────── */
/* 投递                                                            */
/* ──────────────────────────────────────────────────────────────── */

export interface WebhookDispatchOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
}

function resolveFetch(opts: WebhookDispatchOptions): typeof fetch {
  return opts.fetchFn ?? globalThis.fetch;
}

/** 幂等：同一 (webhook, event_type, event_id) 已存在投递记录则跳过（不重复建）。 */
function deliveryExists(store: SqliteStore, webhookId: string, event: WebhookEvent): boolean {
  return store.listWebhookDeliveriesByWebhook(webhookId, 1000)
    .some((delivery) => delivery.event_type === event.type && delivery.event_id === event.event_id);
}

/**
 * 尝试立即投递一条 delivery。成功 → delivered；失败 → pending + 退避。
 * 达到 WEBHOOK_MAX_ATTEMPTS 后投递与 webhook 双双标记 failed。
 */
export async function attemptDelivery(
  store: SqliteStore,
  webhook: WebhookRegistrationRow,
  delivery: WebhookDeliveryRow,
  opts: WebhookDispatchOptions,
): Promise<{ delivered: boolean; attempt: number }> {
  const now = opts.now?.() ?? Date.now();
  const fetchFn = resolveFetch(opts);
  const attempt = delivery.attempt_count + 1;

  let responseStatus: number | null = null;
  let lastError = '';
  try {
    const res = await fetchFn(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'biao-webhook/1.0',
        'X-Biao-Signature': `sha256=${signWebhookPayload(webhook.secret, delivery.payload)}`,
        'X-Biao-Event': delivery.event_type,
      },
      body: delivery.payload,
    });
    responseStatus = res.status;
    if (res.ok) {
      store.updateWebhookDelivery(delivery.delivery_id, {
        status: 'delivered',
        attempt_count: attempt,
        last_error: '',
        delivered_at: now,
        response_status: responseStatus,
      });
      store.updateWebhookRegistration(webhook.webhook_id, {
        status: 'active',
        failure_count: 0,
        last_delivered_at: now,
        updated_at: now,
      });
      return { delivered: true, attempt };
    }
    lastError = `HTTP ${res.status}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  if (attempt >= WEBHOOK_MAX_ATTEMPTS) {
    store.updateWebhookDelivery(delivery.delivery_id, {
      status: 'failed',
      attempt_count: attempt,
      last_error: lastError,
      response_status: responseStatus,
      delivered_at: null,
    });
    store.updateWebhookRegistration(webhook.webhook_id, {
      status: 'failed',
      failure_count: attempt,
      updated_at: now,
    });
  } else {
    const backoff = WEBHOOK_RETRY_BACKOFF_MS[attempt - 1] ?? WEBHOOK_RETRY_BACKOFF_MS[0];
    store.updateWebhookDelivery(delivery.delivery_id, {
      status: 'pending',
      attempt_count: attempt,
      last_error: lastError,
      next_attempt_at: now + backoff,
      response_status: responseStatus,
    });
  }
  return { delivered: false, attempt };
}

/**
 * 把一条领域事件投递给所有订阅了该事件类型的 active webhook。
 * 幂等（webhook_deliveries 唯一键语义）+ 立即尝试一次；失败留 pending 由
 * processDueDeliveries 退避重试。返回创建/尝试的投递记录清单。
 */
export async function dispatchEventToWebhooks(
  store: SqliteStore,
  event: WebhookEvent,
  opts: WebhookDispatchOptions = {},
): Promise<{ created: number; attempted: number; delivered: number }> {
  const now = opts.now?.() ?? Date.now();
  const webhooks = store.listWebhookRegistrations('active')
    .filter((row) => subscribedEvents(row).includes(event.type));

  let created = 0;
  let attempted = 0;
  let delivered = 0;

  for (const webhook of webhooks) {
    if (deliveryExists(store, webhook.webhook_id, event)) continue;
    const payload = JSON.stringify(buildSlackCompatiblePayload(event));
    const delivery: WebhookDeliveryRow = {
      delivery_id: `dlv-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      webhook_id: webhook.webhook_id,
      event_type: event.type,
      event_id: event.event_id,
      payload,
      signature: signWebhookPayload(webhook.secret, payload),
      attempt_count: 0,
      status: 'pending',
      last_error: '',
      next_attempt_at: now,
      created_at: now,
      delivered_at: null,
      response_status: null,
    };
    store.insertWebhookDelivery(delivery);
    created++;
    attempted++;
    const result = await attemptDelivery(store, webhook, delivery, opts);
    if (result.delivered) delivered++;
  }
  return { created, attempted, delivered };
}

/**
 * 退避重试：处理所有到期的 pending delivery。单条失败重试；达到
 * WEBHOOK_MAX_ATTEMPTS 的失败投递连同其 webhook 一并标记 failed。
 * 返回本轮投递结果统计（供调度器/手动端点观测）。
 */
export async function processDueDeliveries(
  store: SqliteStore,
  opts: WebhookDispatchOptions = {},
): Promise<{ processed: number; delivered: number; failed: number }> {
  const now = opts.now?.() ?? Date.now();
  const due = store.listDueWebhookDeliveries(now, 100);
  let processed = 0;
  let delivered = 0;
  let failed = 0;
  for (const delivery of due) {
    const webhook = store.getWebhookRegistration(delivery.webhook_id);
    if (!webhook || webhook.status === 'disabled') continue;
    processed++;
    const result = await attemptDelivery(store, webhook, delivery, opts);
    if (result.delivered) delivered++;
    else if (delivery.attempt_count + 1 >= WEBHOOK_MAX_ATTEMPTS) failed++;
  }
  return { processed, delivered, failed };
}

function subscribedEvents(row: WebhookRegistrationRow): WebhookEventType[] {
  try {
    const parsed = JSON.parse(row.events) as unknown[];
    return parsed.filter((event): event is WebhookEventType => WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType));
  } catch {
    return [];
  }
}

/* ──────────────────────────────────────────────────────────────── */
/* 事件源映射（Redis stream / ownership conflicts / incidents）      */
/* ──────────────────────────────────────────────────────────────── */

/** 把 Redis events stream 的一条记录映射为 webhook 事件；无关类型返回 null。 */
export function mapStreamEntryToWebhookEvent(
  streamId: string,
  fields: Record<string, string>,
): WebhookEvent | null {
  const type = fields.type ?? '';
  const ts = Number(fields.timestamp ?? streamId.split('-')[0] ?? Date.now()) || Date.now();
  const base = {
    event_id: fields.event_id ?? `${ts}_${fields.type ?? streamId}`,
    task_id: fields.task_id || undefined,
    plan_id: fields.plan_id || undefined,
    project_path: fields.project_path || undefined,
    agent_id: fields.agent_id || undefined,
    result_status: fields.result_status || undefined,
    ts,
  };
  if (type === 'task_completed') {
    return { ...base, type: 'task_done' };
  }
  if (type === 'review_requested') {
    return { ...base, type: 'review_requested' };
  }
  return null;
}

/** 把 ownership conflict 日志条目映射为 webhook 事件。 */
export function mapConflictToWebhookEvent(entry: unknown): WebhookEvent | null {
  if (typeof entry !== 'string') return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(entry) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
  const path = typeof parsed.path === 'string' ? parsed.path : '';
  const winner = (parsed.winner ?? {}) as Record<string, unknown>;
  const loser = (parsed.loser ?? {}) as Record<string, unknown>;
  const taskId = (typeof winner.task_id === 'string' && winner.task_id) || (typeof loser.task_id === 'string' && loser.task_id) || undefined;
  return {
    type: 'conflict_detected',
    event_id: `conflict-${ts}-${path}`,
    task_id: taskId,
    project_path: undefined,
    ts,
    details: {
      path: path || undefined,
      action: parsed.action ?? '',
      winner_agent: winner.agent_id ?? '',
      loser_agent: loser.agent_id ?? '',
    },
  };
}

/** 把 incidents 表新开的一行映射为 webhook 事件（dispatcher 水位扫描用）。 */
export function mapIncidentToWebhookEvent(incident: IncidentRow): WebhookEvent {
  return {
    type: 'incident_opened',
    event_id: incident.incident_id,
    task_id: incident.related_entity_type === 'task' ? incident.related_entity_id || undefined : undefined,
    ts: incident.created_at,
    details: {
      incident_id: incident.incident_id,
      severity: incident.severity,
      title: incident.title,
      kind: incident.kind,
    },
  };
}

/* ──────────────────────────────────────────────────────────────── */
/* Dispatcher（周期轮询三个事件源）                                  */
/* ──────────────────────────────────────────────────────────────── */

export interface WebhookDispatcherOptions extends WebhookDispatchOptions {
  store: SqliteStore;
  redis: Redis;
  /** 轮询间隔（毫秒）；缺省读 env BIAO_V2_WEBHOOK_INTERVAL_MS（默认 30000）。 */
  intervalMs?: number;
  /** 单轮周期函数注入（测试）；未注入为默认三源扫描。 */
  runCycle?: () => Promise<WebhookDispatchCycleResult>;
  onCycle?: (result: WebhookDispatchCycleResult) => void;
  onError?: (err: unknown) => void;
}

export interface WebhookDispatchCycleResult {
  delivered: number;
  created: number;
  retried: number;
  failed: number;
}

function readIntervalMsFromEnv(): number {
  const raw = Number(process.env[WEBHOOK_DISPATCH_INTERVAL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WEBHOOK_DISPATCH_INTERVAL_MS;
}

/**
 * 单轮三源扫描：
 * 1. Redis events stream 增量（游标持久化到 webhook_dispatcher_state）；
 * 2. ownership conflicts 列表新增（ts 水位）；
 * 3. incidents 表新增（created_at 水位）。
 * 每个源各自处理完一批后调用 processDueDeliveries 推进 pending 退避重试。
 */
export async function runWebhookDispatchCycle(
  store: SqliteStore,
  redis: Redis,
  opts: WebhookDispatchOptions = {},
): Promise<WebhookDispatchCycleResult> {
  const now = opts.now?.() ?? Date.now();
  const state = {
    get: (key: string) => store.getWebhookDispatcherState(key),
    set: (key: string, value: string) => store.setWebhookDispatcherState(key, value, now),
  };
  let delivered = 0;
  let created = 0;

  // 1) Redis events stream
  const cursor = state.get('events_cursor') ?? '0-0';
  let nextCursor = cursor;
  const batches = (await (redis as unknown as {
    xread(...args: unknown[]): Promise<[string, [string, string[]][]][] | null>;
  }).xread('COUNT', 100, 'STREAMS', redisKeys.stream.events, cursor)) as [string, [string, string[]][]][] | null;
  if (batches) {
    for (const [, entries] of batches) {
      for (const [msgId, fields] of entries) {
        nextCursor = msgId;
        const kv: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) kv[fields[i]] = fields[i + 1];
        const event = mapStreamEntryToWebhookEvent(msgId, kv);
        if (!event) continue;
        const result = await dispatchEventToWebhooks(store, event, opts);
        created += result.created;
        delivered += result.delivered;
      }
    }
  }
  if (nextCursor !== cursor) state.set('events_cursor', nextCursor);

  // 2) ownership conflicts（LPUSH 新条目在 list 头部；按 ts 水位去重）
  const conflictWatermark = Number(state.get('conflict_watermark') ?? '0') || 0;
  let maxConflictTs = conflictWatermark;
  try {
    const conflicts = await redis.lrange(redisKeys.list.ownershipConflicts, 0, -1);
    for (const entry of conflicts) {
      const event = mapConflictToWebhookEvent(entry);
      if (!event) continue;
      if (event.ts <= conflictWatermark) continue;
      if (event.ts > maxConflictTs) maxConflictTs = event.ts;
      const result = await dispatchEventToWebhooks(store, event, opts);
      created += result.created;
      delivered += result.delivered;
    }
  } catch {
    // list 不存在（从未冲突）→ 跳过
  }
  if (maxConflictTs > conflictWatermark) state.set('conflict_watermark', String(maxConflictTs));

  // 3) incidents 表（created_at 水位；open 才算开单事件）
  const incidentWatermark = Number(state.get('incident_watermark') ?? '0') || 0;
  let maxIncidentTs = incidentWatermark;
  try {
    const incidents = store.listIncidents(undefined, undefined, 1000);
    for (const incident of incidents) {
      if (incident.status === 'resolved') continue;
      if (incident.created_at <= incidentWatermark) continue;
      if (incident.created_at > maxIncidentTs) maxIncidentTs = incident.created_at;
      const result = await dispatchEventToWebhooks(store, mapIncidentToWebhookEvent(incident), opts);
      created += result.created;
      delivered += result.delivered;
    }
  } catch {
    // incidents 表可能不存在（纯 V1 无 V2 设施）→ 跳过
  }
  if (maxIncidentTs > incidentWatermark) state.set('incident_watermark', String(maxIncidentTs));

  // 推进 pending 退避重试
  const retry = await processDueDeliveries(store, opts);

  return {
    delivered: delivered + retry.delivered,
    created,
    retried: retry.processed,
    failed: retry.failed,
  };
}

/** 创建周期调度器（setInterval，unref 不阻塞进程退出；重复 start 幂等）。 */
export function createWebhookDispatcher(options: WebhookDispatcherOptions) {
  const { store, redis } = options;
  const intervalMs = options.intervalMs ?? readIntervalMsFromEnv();
  const onError = options.onError ?? ((err: unknown) => console.error('[webhook-dispatcher] 周期失败:', err));

  let timer: ReturnType<typeof setInterval> | null = null;
  let inCycle = false;

  const runCycle = options.runCycle ?? (() => runWebhookDispatchCycle(store, redis, options));

  async function runOnce(): Promise<WebhookDispatchCycleResult> {
    if (inCycle) return { delivered: 0, created: 0, retried: 0, failed: 0 };
    inCycle = true;
    try {
      const result = await runCycle();
      options.onCycle?.(result);
      return result;
    } catch (err) {
      onError(err);
      return { delivered: 0, created: 0, retried: 0, failed: 0 };
    } finally {
      inCycle = false;
    }
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => void runOnce(), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce, intervalMs };
}
