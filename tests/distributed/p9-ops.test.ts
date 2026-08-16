/**
 * Phase 9 失败优先测试：告警调度 / SLO / 复发 / stale Delivery / ownership snapshot 重建
 *
 * 对应 §22.4-18（告警接线）、§22.4-36（resolution SLO / recurrence）、§22.4-37（stale
 * proposed Delivery）、§22.2-09（ownership snapshot 从 durable 表重建）与 §17.2/17.3。
 *
 * 所有告警用例注入假时钟 + 短间隔/单轮驱动，保证确定性；env 相关用例 save/restore。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { DeliveryRow } from '../../src/types/v2-artifact.js';
import { createIncidentService } from '../../src/server/v2/incident-service.js';
import { appendOutboxEvent, markOutboxStatus } from '../../src/server/v2/outbox.js';
import { createMetricsService, DEFAULT_RESOLUTION_SLA_MINUTES } from '../../src/server/v2/metrics.js';
import { createAlertScheduler, ALERT_INTERVAL_ENV } from '../../src/server/v2/alert-scheduler.js';

const tempDirs: string[] = [];

function makeStore(): SqliteStore {
  return new SqliteStore(':memory:');
}

function makeDeadLetter(store: SqliteStore): string {
  const eventId = `evt-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  appendOutboxEvent(store, {
    event_id: eventId,
    project_id: null,
    aggregate_type: 'test',
    aggregate_id: `agg-${randomBytes(4).toString('hex')}`,
    aggregate_revision: 1,
    payload: { data: 'p9' },
  });
  markOutboxStatus(store, eventId, 'dead_letter', { last_error: 'p9 max attempts' });
  return eventId;
}

function makeDelivery(store: SqliteStore, overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  const now = Date.now();
  const row: DeliveryRow = {
    delivery_id: `del-${randomBytes(4).toString('hex')}`,
    task_id: 'task-p9',
    attempt_id: `att-${randomBytes(4).toString('hex')}`,
    project_id: 'proj-p9',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    tree_sha: 'c'.repeat(40),
    branch_ref: 'refs/heads/biao/attempt/p9',
    changed_files: '[]',
    patch_digest: '',
    artifact_ids: '[]',
    verify_manifest_digest: '',
    status: 'pending_review',
    accepted_commit_sha: '',
    merged_commit_sha: '',
    invalidated_reason: '',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  store.insertDelivery(row);
  return row;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('告警调度接线（§22.4-18）', () => {
  it('runOnce 驱动告警求值：outbox 死信超阈值自动开 incident', () => {
    const store = makeStore();
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    const scheduler = createAlertScheduler({ store });
    const result = scheduler.runOnce();

    expect(result.incidents_created).toBeGreaterThanOrEqual(1);
    const inc = store.listIncidents(undefined, 'open', 10)[0];
    expect(inc.kind).toBe('alert:outbox_dead_letter_high');
    expect(inc.severity).toBe('warning');
    // §22.4-36 resolution_sla_minutes 写入（warning=1440 分钟）
    expect(inc.resolution_sla_minutes).toBe(DEFAULT_RESOLUTION_SLA_MINUTES.warning);
    expect(inc.recurrence).toBe(0);
  });

  it('去重：同 fingerprint 未 resolve 不重开', () => {
    const store = makeStore();
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    const scheduler = createAlertScheduler({ store });
    const first = scheduler.runOnce();
    expect(first.incidents_created).toBe(1);

    const second = scheduler.runOnce();
    expect(second.incidents_created).toBe(0);
    expect(store.listIncidents(undefined, 'open', 10).length).toBe(1);
  });

  it('ack 未 resolve 也不重开（dedup 覆盖 open+acked）', () => {
    const store = makeStore();
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    const scheduler = createAlertScheduler({ store });
    scheduler.runOnce();
    const inc = store.listIncidents(undefined, 'open', 10)[0];

    const service = createIncidentService({ store });
    expect(service.ackIncident(inc.incident_id, { acked_by: 'op' }).ok).toBe(true);

    const again = scheduler.runOnce();
    expect(again.incidents_created).toBe(0);
    expect(store.listIncidents(undefined, undefined, 10).length).toBe(1);
  });

  it('start() 定时驱动：短间隔注入触发周期并自动开单', async () => {
    const store = makeStore();
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    const cycles: number[] = [];
    const scheduler = createAlertScheduler({
      store,
      intervalMs: 10,
      onCycle: (r) => cycles.push(r.incidents_created),
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    scheduler.stop();

    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const open = store.listIncidents(undefined, 'open', 10);
    expect(open.some((i) => i.kind === 'alert:outbox_dead_letter_high')).toBe(true);
  });

  it('interval env 可调（save/restore 纪律）', () => {
    const saved = process.env[ALERT_INTERVAL_ENV];
    try {
      process.env[ALERT_INTERVAL_ENV] = '7';
      const store = makeStore();
      const scheduler = createAlertScheduler({ store });
      expect(scheduler.intervalMs).toBe(7);
    } finally {
      if (saved !== undefined) process.env[ALERT_INTERVAL_ENV] = saved;
      else delete process.env[ALERT_INTERVAL_ENV];
    }
  });
});

describe('resolution SLO / recurrence（§22.4-36）', () => {
  it('复发：resolve 后窗口内重开计 recurrence', () => {
    const store = makeStore();
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    const scheduler = createAlertScheduler({ store });
    scheduler.runOnce();
    const inc = store.listIncidents(undefined, 'open', 10)[0];

    const service = createIncidentService({ store });
    expect(service.resolveIncident(inc.incident_id, { resolved_by: 'op', evidence: 'fixed' }).ok).toBe(true);

    // 再次触发（同窗口内）→ 新 incident，recurrence=1
    const again = scheduler.runOnce();
    expect(again.incidents_created).toBe(1);
    const reopened = store.listIncidents(undefined, 'open', 10)[0];
    expect(reopened.kind).toBe(inc.kind);
    expect(reopened.recurrence).toBe(1);
  });

  it('超 resolution SLO 未 resolve 升级 severity 一次', () => {
    const store = makeStore();
    let now = 1_000_000_000;
    const scheduler = createAlertScheduler({ store, now: () => now });
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    scheduler.runOnce();
    const inc = store.listIncidents(undefined, 'open', 10).find((i) => i.kind === 'alert:outbox_dead_letter_high')!;
    expect(inc.severity).toBe('warning');
    expect(inc.resolution_sla_minutes).toBe(1440);

    // 推进时钟超过 resolution SLO
    now = inc.opened_at + inc.resolution_sla_minutes! * 60_000 + 1000;
    const result = scheduler.runOnce();
    expect(result.escalated).toBe(1);

    const after = store.getIncident(inc.incident_id)!;
    expect(after.severity).toBe('critical');
    expect(after.escalated).toBe(1);

    // 已升级的不再升（一次）
    now = after.opened_at + after.resolution_sla_minutes! * 60_000 + 2000;
    const again = scheduler.runOnce();
    expect(again.escalated).toBe(0);
    expect(store.getIncident(inc.incident_id)!.severity).toBe('critical');
  });

  it('升级写审计事件', () => {
    const store = makeStore();
    let now = 2_000_000_000;
    const scheduler = createAlertScheduler({ store, now: () => now });
    for (let i = 0; i < 11; i++) makeDeadLetter(store);

    scheduler.runOnce();
    const inc = store.listIncidents(undefined, 'open', 10).find((i) => i.kind === 'alert:outbox_dead_letter_high')!;
    now = inc.opened_at + inc.resolution_sla_minutes! * 60_000 + 1000;
    scheduler.runOnce();

    const events = store.listAuditEvents(undefined, 100).filter((e) => e.action === 'incident.escalated');
    expect(events.length).toBe(1);
    expect(events[0].subject_id).toBe(inc.incident_id);
  });
});

describe('stale proposed Delivery（§22.4-37）', () => {
  it('pending_review 超过阈值开 incident 且含 delivery_id/age', () => {
    const store = makeStore();
    const staleAt = Date.now() - 50 * 60 * 60 * 1000; // 50h 前
    makeDelivery(store, { delivery_id: 'del-stale-1', status: 'pending_review', created_at: staleAt });
    makeDelivery(store, { delivery_id: 'del-fresh', status: 'pending_review', created_at: Date.now() });

    const scheduler = createAlertScheduler({ store });
    const result = scheduler.runOnce();
    expect(result.incidents_created).toBe(1);

    const inc = store.listIncidents(undefined, 'open', 10).find((i) => i.kind === 'alert:stale_proposed_delivery')!;
    expect(inc).toBeDefined();
    expect(inc.related_entity_type).toBe('delivery');
    expect(inc.related_entity_id).toBe('del-stale-1');
    expect(inc.detail).toContain('delivery=del-stale-1');
    expect(inc.detail).toContain('age_min=');
    // 新鲜 delivery 不在告警明细中
    expect(inc.detail).not.toContain('del-fresh');
  });

  it('proposed 状态同样纳入 stale 检查', () => {
    const store = makeStore();
    makeDelivery(store, {
      delivery_id: 'del-stale-proposed',
      status: 'proposed',
      created_at: Date.now() - 49 * 60 * 60 * 1000,
    });

    const scheduler = createAlertScheduler({ store });
    const result = scheduler.runOnce();
    expect(result.incidents_created).toBe(1);
    const inc = store.listIncidents(undefined, 'open', 10).find((i) => i.kind === 'alert:stale_proposed_delivery')!;
    expect(inc.detail).toContain('delivery=del-stale-proposed');
  });

  it('阈值 env 可调（BIAO_V2_STALE_DELIVERY_HOURS save/restore）', () => {
    const saved = process.env.BIAO_V2_STALE_DELIVERY_HOURS;
    try {
      process.env.BIAO_V2_STALE_DELIVERY_HOURS = '1'; // 1 小时
      const store = makeStore();
      makeDelivery(store, {
        delivery_id: 'del-2h',
        status: 'pending_review',
        created_at: Date.now() - 2 * 60 * 60 * 1000,
      });

      const scheduler = createAlertScheduler({ store });
      const result = scheduler.runOnce();
      expect(result.incidents_created).toBe(1);
      const inc = store.listIncidents(undefined, 'open', 10).find((i) => i.kind === 'alert:stale_proposed_delivery')!;
      expect(inc).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.BIAO_V2_STALE_DELIVERY_HOURS = saved;
      else delete process.env.BIAO_V2_STALE_DELIVERY_HOURS;
    }
  });
});

describe('ownership snapshot 重建（§22.2-09）', () => {
  it('从 durable 表重建运行态索引：重启后 attempt_id→files 可复原', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p9-snap-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'snap.sqlite');
    const ts = Date.now();

    const store1 = new SqliteStore(dbPath);
    store1.insertOwnershipSnapshot({ snapshot_id: 'snap-a', attempt_id: 'att-a', task_id: 'task-a', files: '["src/**"]', created_at: ts, released_at: null });
    store1.insertOwnershipSnapshot({ snapshot_id: 'snap-b', attempt_id: 'att-b', task_id: 'task-b', files: '["*.ts"]', created_at: ts, released_at: null });
    // released（已释放）的快照不参与运行态索引重建
    store1.insertOwnershipSnapshot({ snapshot_id: 'snap-c', attempt_id: 'att-c', task_id: 'task-c', files: '[]', created_at: ts, released_at: ts });
    store1.close();

    // 模拟 Redis/内存清空 → 新 store 从 durable 表重建
    const store2 = new SqliteStore(dbPath);
    const index = store2.rebuildOwnershipSnapshotIndex();
    expect(index.size).toBe(2);
    expect(index.get('att-a')).toBe('["src/**"]');
    expect(index.get('att-b')).toBe('["*.ts"]');
    expect(index.has('att-c')).toBe(false);

    // 与 workspace/delivery 消费口径一致：listOwnershipSnapshotsByAttempt 可读
    expect(store2.listOwnershipSnapshotsByAttempt('att-a').length).toBe(1);
    store2.close();
  });

  it('listOwnershipSnapshots 支持 attemptId/activeOnly 过滤', () => {
    const store = makeStore();
    const ts = Date.now();
    store.insertOwnershipSnapshot({ snapshot_id: 's1', attempt_id: 'a1', task_id: 't1', files: '[]', created_at: ts, released_at: null });
    store.insertOwnershipSnapshot({ snapshot_id: 's2', attempt_id: 'a1', task_id: 't1', files: '["x"]', created_at: ts, released_at: ts });

    expect(store.listOwnershipSnapshots({ attemptId: 'a1' }).length).toBe(2);
    expect(store.listOwnershipSnapshots({ activeOnly: true }).length).toBe(1);
    expect(store.listOwnershipSnapshots({ attemptId: 'a1', activeOnly: true }).map((r) => r.snapshot_id)).toEqual(['s1']);
  });
});
