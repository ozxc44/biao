/**
 * V2 outbox / idempotency 最小服务函数。
 * 纯数据面，不接 HTTP；由 SqliteStore 承载持久化。
 *
 * 对应 docs/distributed-multi-node-development-plan.md §14.5（outbox 语义）、§20.1（字段定义）。
 */

import { createHash } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { OutboxEventRow, IdempotencyRecordRow } from '../../types/v2-infra.js';

/** 22.4-18：outbox stall 检测默认阈值（毫秒）：5 分钟。可通过 env BIAO_V2_OUTBOX_STALL_THRESHOLD_MS 调整。 */
export const OUTBOX_STALL_DEFAULT_THRESHOLD_MS = 5 * 60 * 1000;

// ──────────────── Outbox ────────────────

export interface AppendOutboxEventInput {
  event_id: string;
  project_id?: string | null;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  payload: unknown;  // 序列化后计算 digest
  compensates_event_id?: string;
}

/**
 * 追加 outbox 事件，计算 payload_digest 并设置首次重试时间为立即。
 * §14.5: 事务先写 outbox，提交后才投影到 Redis。
 */
export function appendOutboxEvent(store: SqliteStore, input: AppendOutboxEventInput): OutboxEventRow {
  const payloadDigest = createHash('sha256')
    .update(JSON.stringify(input.payload), 'utf8')
    .digest('hex');

  const row: OutboxEventRow = {
    event_id: input.event_id,
    project_id: input.project_id ?? null,
    aggregate_type: input.aggregate_type,
    aggregate_id: input.aggregate_id,
    aggregate_revision: input.aggregate_revision,
    payload_digest: payloadDigest,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: Date.now(),
    last_error: '',
    dead_lettered_at: null,
    compensates_event_id: input.compensates_event_id ?? '',
  };
  store.insertOutboxEvent(row);
  return row;
}

/**
 * 标记 outbox 事件状态（delivered / dead_letter / pending 重试）。
 * dead_letter 时自动记录 dead_lettered_at 时间戳。
 */
export function markOutboxStatus(
  store: SqliteStore,
  eventId: string,
  status: 'delivered' | 'dead_letter' | 'pending',
  options: { last_error?: string; next_attempt_at?: number } = {},
): void {
  const existing = store.getOutboxEvent(eventId);
  if (!existing) throw new Error(`outbox event not found: ${eventId}`);

  const now = Date.now();
  const fields: Partial<OutboxEventRow> = {
    status,
    attempt_count: existing.attempt_count + 1,
    last_error: options.last_error ?? existing.last_error,
    next_attempt_at: options.next_attempt_at ?? (status === 'pending' ? now + 60_000 : existing.next_attempt_at),
    dead_lettered_at: status === 'dead_letter' ? now : existing.dead_lettered_at,
  };

  store.updateOutboxEvent(eventId, fields);
}

/**
 * 列出可重试的 outbox 事件：pending 状态且 next_attempt_at 已过期。
 * §14.5: outbox dispatcher 按 attempt/backoff 调度。
 */
export function listRetryableOutbox(store: SqliteStore, limit = 50): OutboxEventRow[] {
  const now = Date.now();
  // 使用 store 的底层查询能力
  return store.listOutboxEvents('pending', limit)
    .filter((row) => row.next_attempt_at <= now);
}

// ──────────────── 22.4-18：Stall 检测 / Degraded / Revision 重放 ────────────────

export interface StalledOutboxEvent {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  next_attempt_at: number;
  stalled_ms: number;
}

/**
 * 22.4-18：检测 outbox stall——pending 事件的 next_attempt_at 超过阈值仍未投递。
 * 返回 stalled 清单（按 stalled 时长降序），供告警规则和 degraded 决策消费。
 */
export function detectStalledOutbox(
  store: SqliteStore,
  thresholdMs: number = OUTBOX_STALL_DEFAULT_THRESHOLD_MS,
  now?: number,
): StalledOutboxEvent[] {
  const ts = now ?? Date.now();
  const cutoff = ts - thresholdMs;
  return store.listOutboxEvents('pending', 500)
    .filter((row) => row.next_attempt_at <= cutoff)
    .map((row) => ({
      event_id: row.event_id,
      aggregate_type: row.aggregate_type,
      aggregate_id: row.aggregate_id,
      aggregate_revision: row.aggregate_revision,
      next_attempt_at: row.next_attempt_at,
      stalled_ms: ts - row.next_attempt_at,
    }))
    .sort((a, b) => b.stalled_ms - a.stalled_ms);
}

/**
 * 22.4-18：标记 outbox 事件为 degraded（写入 last_error 供人工/自动化排查）。
 * degraded 状态通过 last_error 前缀表达，不改变 status 字段（仍是 pending/dead_letter）。
 */
export function markOutboxDegraded(
  store: SqliteStore,
  eventId: string,
  reason: string,
): void {
  const existing = store.getOutboxEvent(eventId);
  if (!existing) throw new Error(`outbox event not found: ${eventId}`);
  store.updateOutboxEvent(eventId, {
    last_error: `[degraded] ${reason}`,
  });
}

export interface ReplayByRevisionResult {
  replayed: number;
  skipped: number;
  failed: number;
  details: Array<{ event_id: string; revision: number; action: 'replayed' | 'skipped' | 'failed'; error?: string }>;
}

/**
 * 22.4-18：按 aggregate_revision 顺序幂等重放 outbox 事件。
 * - 跳过已成功的 revision（status=delivered）；
 * - 失败的重试到成功（status=dead_letter → pending + next_attempt_at=now）；
 * - 不跳号、不重复。
 */
export function replayOutboxByRevision(
  store: SqliteStore,
  aggregateType: string,
  aggregateId: string,
  fromRevision: number,
  now?: number,
): ReplayByRevisionResult {
  const ts = now ?? Date.now();
  const allEvents = store.listOutboxEvents(undefined, 1000)
    .filter((e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId && e.aggregate_revision >= fromRevision)
    .sort((a, b) => a.aggregate_revision - b.aggregate_revision);

  const details: ReplayByRevisionResult['details'] = [];
  let replayed = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of allEvents) {
    if (event.status === 'delivered') {
      details.push({ event_id: event.event_id, revision: event.aggregate_revision, action: 'skipped' });
      skipped++;
      continue;
    }
    if (event.status === 'dead_letter') {
      // 重放 dead_letter → pending（立即重试）
      store.updateOutboxEvent(event.event_id, {
        status: 'pending',
        next_attempt_at: ts,
        attempt_count: 0,
        last_error: '',
        dead_lettered_at: null,
      });
      details.push({ event_id: event.event_id, revision: event.aggregate_revision, action: 'replayed' });
      replayed++;
      continue;
    }
    if (event.status === 'pending') {
      // 已在 pending：强制立即重试
      store.updateOutboxEvent(event.event_id, {
        next_attempt_at: ts,
        attempt_count: 0,
        last_error: '',
      });
      details.push({ event_id: event.event_id, revision: event.aggregate_revision, action: 'replayed' });
      replayed++;
      continue;
    }
    // 未知状态
    details.push({ event_id: event.event_id, revision: event.aggregate_revision, action: 'failed', error: `unknown status: ${event.status}` });
    failed++;
  }

  return { replayed, skipped, failed, details };
}

/**
 * 22.4-18：收集 stalled outbox 统计（供 alert-scheduler 数据源接口）。
 * 返回摘要：stalled 总数、按 aggregate_type 分组计数、最大 stall 时长。
 */
export function collectStalledOutboxStats(
  store: SqliteStore,
  thresholdMs?: number,
  now?: number,
): { total: number; byAggregateType: Record<string, number>; maxStalledMs: number } {
  const stalled = detectStalledOutbox(store, thresholdMs, now);
  const byType: Record<string, number> = {};
  let maxMs = 0;
  for (const s of stalled) {
    byType[s.aggregate_type] = (byType[s.aggregate_type] ?? 0) + 1;
    if (s.stalled_ms > maxMs) maxMs = s.stalled_ms;
  }
  return { total: stalled.length, byAggregateType: byType, maxStalledMs: maxMs };
}

// ──────────────── Idempotency ────────────────

export interface RecordIdempotencyInput {
  actor_id: string;
  route: string;
  idempotency_key: string;
  request_body: unknown;  // 序列化后计算 digest
  response_entity_type: string;
  response_entity_id: string;
  response_revision: number;
  ttl_ms?: number;  // 默认 24 小时
}

/**
 * 记录幂等响应。同一 (actor_id, route, idempotency_key) 覆盖写入。
 * §14.5: Redis 成功而响应丢失时，同一 idempotency key 返回原实体。
 */
export function recordIdempotency(store: SqliteStore, input: RecordIdempotencyInput): IdempotencyRecordRow {
  const requestDigest = createHash('sha256')
    .update(JSON.stringify(input.request_body), 'utf8')
    .digest('hex');

  const row: IdempotencyRecordRow = {
    actor_id: input.actor_id,
    route: input.route,
    idempotency_key: input.idempotency_key,
    request_digest: requestDigest,
    response_entity_type: input.response_entity_type,
    response_entity_id: input.response_entity_id,
    response_revision: input.response_revision,
    expires_at: Date.now() + (input.ttl_ms ?? 24 * 60 * 60 * 1000),
  };
  store.insertIdempotencyRecord(row);
  return row;
}

export interface FindIdempotencyResult {
  found: boolean;
  record?: IdempotencyRecordRow;
  digest_match?: boolean;
}

/**
 * 查找幂等记录并比对 request_digest。
 * §14.5: 同一 idempotency key + 同一 request body 返回原实体；
 *          不同 body 返回冲突（found=true, digest_match=false）。
 */
export function findIdempotency(
  store: SqliteStore,
  actorId: string,
  route: string,
  idempotencyKey: string,
  requestBody: unknown,
): FindIdempotencyResult {
  const record = store.getIdempotencyRecord(actorId, route, idempotencyKey);
  if (!record) return { found: false };

  const requestDigest = createHash('sha256')
    .update(JSON.stringify(requestBody), 'utf8')
    .digest('hex');

  return {
    found: true,
    record,
    digest_match: record.request_digest === requestDigest,
  };
}
