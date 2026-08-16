/**
 * P12 车道 C：Webhook 注册 + 投递记录 + dispatcher 游标（§9 Webhook/通知集成）
 *
 * - webhook_registrations：owner 注册的 webhook URL + HMAC secret + 订阅事件清单。
 *   状态机：active → failed（连续 3 次投递失败后标记；disabled 为 owner 手动停用）。
 *   events 存 JSON 数组（task_done / review_requested / conflict_detected / incident_opened）。
 * - webhook_deliveries：每次投递尝试的持久化记录（attempt_count + 退避重试 + 终态）。
 *   幂等：同一 (webhook_id, event_type, event_id) 只建一条 delivery 记录。
 * - webhook_dispatcher_state：dispatcher 在 Redis events stream / ownership conflicts /
 *   incidents 表上的续传游标（重启恢复，避免断点重复或漏发）。
 */
import type Database from 'better-sqlite3';

export const version = '016';

const schemaSql = `
CREATE TABLE IF NOT EXISTS webhook_registrations (
  webhook_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'failed', 'disabled')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_delivered_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_registrations_status
  ON webhook_registrations(status, updated_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  response_status INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dedup
  ON webhook_deliveries(webhook_id, event_type, event_id);

CREATE TABLE IF NOT EXISTS webhook_dispatcher_state (
  state_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
