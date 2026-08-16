/**
 * V2 Metrics（Phase 7a + §22.4 后续增强：告警调度/SLO/复发）
 *
 * GET /v2/metrics（Prometheus 文本格式，无外部依赖）：
 * 队列深度（merge_jobs by status）、outbox pending/dead-letter、
 * incidents open by severity、nodes by status、delivery by status、GC/水位标量。
 *
 * 告警规则表：哪些指标阈值→incident 自动开单。
 * §22.4-18/36/37 增强：
 * - runAlertEvaluation 由 alert-scheduler 定期驱动（去重 + recurrence 计数）；
 * - 告警 incident 写入 resolution_sla_minutes（按 severity）；
 * - escalateOverdueIncidents()：超 resolution SLO 未 resolve 的 incident 升级 severity 一次；
 * - stale_proposed_delivery：proposed/pending_review 超过阈值（默认 48h，env 可调）开单。
 */

import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { IncidentRow, V2IncidentSeverity } from '../../types/v2-infra.js';
import type { DeliveryRow } from '../../types/v2-artifact.js';

export interface MetricsOptions {
  store: SqliteStore;
  now?: () => number;
}

/** 告警规则定义 */
export interface AlertRule {
  name: string;
  metric: string;
  threshold: number;
  severity: V2IncidentSeverity;
  message: string;
}

/** 默认告警规则 */
export const DEFAULT_ALERT_RULES: AlertRule[] = [
  { name: 'outbox_dead_letter_high', metric: 'biao_outbox_dead_letter_total', threshold: 10, severity: 'warning', message: 'outbox 死信数超过阈值' },
  { name: 'incidents_critical_open', metric: 'biao_incidents_open{severity="critical"}', threshold: 1, severity: 'critical', message: '存在未处理的 critical incident' },
  { name: 'merge_queue_depth', metric: 'biao_merge_jobs{status="queued"}', threshold: 20, severity: 'warning', message: '合并队列深度超过阈值' },
  { name: 'nodes_offline', metric: 'biao_nodes{status="offline"}', threshold: 3, severity: 'warning', message: '离线节点数超过阈值' },
  // §22.4-37 stale proposed Delivery：query-based（runAlertEvaluation 单独求值，
  // 不在 metric 循环中走 evaluateAlerts 统一路径，以携带 delivery_id/age 明细）。
  { name: 'stale_proposed_delivery', metric: 'biao_stale_proposed_delivery', threshold: 1, severity: 'warning', message: '存在超过阈值的 proposed/pending_review Delivery' },
];

/** 默认 resolution SLO（分钟，按 severity）。§4.8：Critical 4h / Warning 24h / Info 72h。 */
export const DEFAULT_RESOLUTION_SLA_MINUTES: Record<V2IncidentSeverity, number> = {
  critical: 240,
  warning: 1440,
  info: 4320,
};

/** stale proposed Delivery 默认阈值小时数（env BIAO_V2_STALE_DELIVERY_HOURS 可调）。 */
export const DEFAULT_STALE_DELIVERY_HOURS = 48;

const SEVERITY_ORDER: readonly V2IncidentSeverity[] = ['info', 'warning', 'critical'];

function nextSeverity(s: V2IncidentSeverity): V2IncidentSeverity | null {
  const idx = SEVERITY_ORDER.indexOf(s);
  return idx >= 0 && idx < SEVERITY_ORDER.length - 1 ? SEVERITY_ORDER[idx + 1] : null;
}

function staleDeliveryThresholdMsFromEnv(): number {
  const raw = Number(process.env.BIAO_V2_STALE_DELIVERY_HOURS);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_DELIVERY_HOURS;
  return hours * 60 * 60 * 1000;
}

export interface AlertEvaluationOptions {
  rules?: AlertRule[];
  /** 复发窗口（毫秒），默认 7 天。 */
  recurrenceWindowMs?: number;
  /** stale proposed Delivery 阈值（毫秒）；缺省读 env BIAO_V2_STALE_DELIVERY_HOURS（默认 48h）。 */
  staleDeliveryThresholdMs?: number;
  /** resolution SLO 覆盖（分钟，按 severity）。 */
  resolutionSlaMinutes?: Partial<Record<V2IncidentSeverity, number>>;
}

export function createMetricsService(options: MetricsOptions) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());

  /**
   * 生成 Prometheus 文本格式指标。
   */
  function generateMetrics(): string {
    const lines: string[] = [];
    const ts = now();

    // merge_jobs by status
    const mergeJobsByStatus: Record<string, number> = {};
    try {
      const jobs = store.listMergeJobs();
      for (const job of jobs) {
        mergeJobsByStatus[job.status] = (mergeJobsByStatus[job.status] ?? 0) + 1;
      }
    } catch {
      // 表可能不存在
    }
    lines.push('# HELP biao_merge_jobs Merge jobs by status');
    lines.push('# TYPE biao_merge_jobs gauge');
    for (const [status, count] of Object.entries(mergeJobsByStatus)) {
      lines.push(`biao_merge_jobs{status="${status}"} ${count}`);
    }

    // outbox pending / dead_letter
    const outboxPending = store.listOutboxEvents('pending', 10000).length;
    const outboxDeadLetter = store.listOutboxEvents('dead_letter', 10000).length;
    lines.push('# HELP biao_outbox_pending_total Outbox events pending');
    lines.push('# TYPE biao_outbox_pending_total gauge');
    lines.push(`biao_outbox_pending_total ${outboxPending}`);
    lines.push('# HELP biao_outbox_dead_letter_total Outbox events dead-lettered');
    lines.push('# TYPE biao_outbox_dead_letter_total gauge');
    lines.push(`biao_outbox_dead_letter_total ${outboxDeadLetter}`);

    // incidents open by severity
    const incidentsBySeverity = store.countIncidentsBySeverityOpen();
    lines.push('# HELP biao_incidents_open Open incidents by severity');
    lines.push('# TYPE biao_incidents_open gauge');
    for (const [severity, count] of Object.entries(incidentsBySeverity)) {
      lines.push(`biao_incidents_open{severity="${severity}"} ${count}`);
    }

    // nodes by status
    const nodesByStatus: Record<string, number> = {};
    try {
      const nodes = store.listNodes();
      for (const node of nodes) {
        nodesByStatus[node.status] = (nodesByStatus[node.status] ?? 0) + 1;
      }
    } catch {
      // 表可能不存在
    }
    lines.push('# HELP biao_nodes Nodes by status');
    lines.push('# TYPE biao_nodes gauge');
    for (const [status, count] of Object.entries(nodesByStatus)) {
      lines.push(`biao_nodes{status="${status}"} ${count}`);
    }

    // deliveries by status
    const deliveriesByStatus: Record<string, number> = {};
    try {
      const statuses = ['pending_review', 'reviewing', 'accepted', 'rejected', 'merged', 'invalidated', 'pending_recovery'];
      for (const status of statuses) {
        const count = store.listDeliveriesByStatus(status).length;
        if (count > 0) deliveriesByStatus[status] = count;
      }
    } catch {
      // 表可能不存在
    }
    lines.push('# HELP biao_deliveries Deliveries by status');
    lines.push('# TYPE biao_deliveries gauge');
    for (const [status, count] of Object.entries(deliveriesByStatus)) {
      lines.push(`biao_deliveries{status="${status}"} ${count}`);
    }

    // §22.4-37 stale proposed Delivery（count + 阈值评估在 runAlertEvaluation）
    const staleDeliveries = collectStaleDeliveries(ts, staleDeliveryThresholdMsFromEnv());
    lines.push('# HELP biao_stale_proposed_delivery Stale proposed/pending_review deliveries');
    lines.push('# TYPE biao_stale_proposed_delivery gauge');
    lines.push(`biao_stale_proposed_delivery ${staleDeliveries.length}`);

    // GC/水位标量
    lines.push('# HELP biao_metrics_timestamp Metrics generation timestamp');
    lines.push('# TYPE biao_metrics_timestamp gauge');
    lines.push(`biao_metrics_timestamp ${ts}`);

    // restore_points 最新状态
    try {
      const rps = store.listRestorePoints();
      const latest = rps[0];
      if (latest) {
        lines.push('# HELP biao_restore_point_latest_status Latest restore point status (0=created,1=completed,2=failed)');
        lines.push('# TYPE biao_restore_point_latest_status gauge');
        const statusNum = latest.status === 'completed' ? 1 : latest.status === 'failed' ? 2 : 0;
        lines.push(`biao_restore_point_latest_status ${statusNum}`);
      }
    } catch {
      // 表可能不存在
    }

    return lines.join('\n') + '\n';
  }

  /**
   * 检查告警规则，返回触发的告警列表。
   */
  function evaluateAlerts(rules: AlertRule[] = DEFAULT_ALERT_RULES): Array<{
    rule: AlertRule;
    current_value: number;
    triggered: boolean;
  }> {
    const metricsText = generateMetrics();
    return rules.map((rule) => {
      // 简单解析指标值
      const match = metricsText.match(new RegExp(`^${escapeRegex(rule.metric)}\\s+(\\d+(?:\\.\\d+)?)`, 'm'));
      const currentValue = match ? parseFloat(match[1]) : 0;
      return {
        rule,
        current_value: currentValue,
        triggered: currentValue >= rule.threshold,
      };
    });
  }

  /**
   * 收集超过阈值的 proposed / pending_review Delivery。
   */
  function collectStaleDeliveries(ts: number, thresholdMs: number): DeliveryRow[] {
    const result: DeliveryRow[] = [];
    for (const status of ['proposed', 'pending_review'] as const) {
      try {
        for (const delivery of store.listDeliveriesByStatus(status)) {
          if (ts - delivery.created_at >= thresholdMs) result.push(delivery);
        }
      } catch {
        // 表可能不存在
      }
    }
    return result;
  }

  function findActiveIncidentByKind(kind: string): IncidentRow | undefined {
    const all = store.listIncidents(undefined, undefined, 1000);
    return all.find((inc) => inc.kind === kind && inc.status !== 'resolved');
  }

  function computeRecurrence(kind: string, ts: number, windowMs: number): number {
    const resolved = store.listIncidents(undefined, 'resolved', 1000);
    const recent = resolved.find((inc) => inc.kind === kind && inc.resolved_at != null && inc.resolved_at >= ts - windowMs);
    return recent ? (recent.recurrence ?? 0) + 1 : 0;
  }

  function insertAlertIncident(input: {
    kind: string;
    severity: V2IncidentSeverity;
    title: string;
    detail: string;
    related_entity_type: string;
    related_entity_id: string;
    slaMinutes: Partial<Record<V2IncidentSeverity, number>>;
    recurrence: number;
    ts: number;
  }): string {
    const incidentId = `inc-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    store.insertIncident({
      incident_id: incidentId,
      project_id: null,
      kind: input.kind,
      severity: input.severity,
      status: 'open',
      title: input.title,
      detail: input.detail,
      correlation_id: '',
      related_entity_type: input.related_entity_type,
      related_entity_id: input.related_entity_id,
      opened_at: input.ts,
      ack_due_at: input.ts + (input.severity === 'critical' ? 3600000 : 14400000),
      acked_at: null,
      acked_by: '',
      ack_note: '',
      resolved_at: null,
      resolved_by: '',
      resolution_evidence: '',
      revision: 1,
      created_at: input.ts,
      updated_at: input.ts,
    });
    // §22.4-36 新列走 updateIncident 落库（insertIncident 显式列清单为既有列，只增不改）。
    store.updateIncident(incidentId, {
      resolution_sla_minutes: input.slaMinutes[input.severity] ?? null,
      recurrence: input.recurrence,
      escalated: 0,
      updated_at: input.ts,
    });
    store.insertAuditEvent({
      audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: null,
      actor_id: 'system',
      action: 'incident.opened',
      subject_type: 'incident',
      subject_id: incidentId,
      correlation_id: '',
      evidence_digest: '',
      created_at: input.ts,
    });
    return incidentId;
  }

  /**
   * 执行告警评估并为触发的规则自动创建 incident。
   * 去重：同 fingerprint（kind）存在未 resolve incident 时不重开；
   * 复发：resolve 后窗口内重开时 recurrence 递增。
   */
  function runAlertEvaluation(opts: AlertEvaluationOptions = {}): { triggered: number; incidents_created: number } {
    const rules = opts.rules ?? DEFAULT_ALERT_RULES;
    const recurrenceWindowMs = opts.recurrenceWindowMs ?? 7 * 24 * 60 * 60 * 1000;
    const staleThresholdMs = opts.staleDeliveryThresholdMs ?? staleDeliveryThresholdMsFromEnv();
    const slaMinutes = { ...DEFAULT_RESOLUTION_SLA_MINUTES, ...opts.resolutionSlaMinutes };
    const ts = now();

    const alerts = evaluateAlerts(rules);
    const staleRule = rules.find((r) => r.name === 'stale_proposed_delivery');
    const staleDeliveries = staleRule ? collectStaleDeliveries(ts, staleThresholdMs) : [];

    let incidentsCreated = 0;

    // 1) metric-based rules（stale_proposed_delivery 走 query-based 分支，避免丢失明细）
    for (const alert of alerts) {
      if (!alert.triggered) continue;
      if (alert.rule.name === 'stale_proposed_delivery') continue;
      const kind = `alert:${alert.rule.name}`;
      if (findActiveIncidentByKind(kind)) continue;
      const recurrence = computeRecurrence(kind, ts, recurrenceWindowMs);
      insertAlertIncident({
        kind,
        severity: alert.rule.severity,
        title: alert.rule.message,
        detail: `指标 ${alert.rule.metric} 当前值 ${alert.current_value}，阈值 ${alert.rule.threshold}`,
        related_entity_type: 'metric',
        related_entity_id: alert.rule.metric,
        slaMinutes,
        recurrence,
        ts,
      });
      incidentsCreated++;
    }

    // 2) §22.4-37 stale proposed Delivery（query-based，detail 携带 delivery_id/age）
    if (staleRule && staleDeliveries.length > 0) {
      const kind = `alert:${staleRule.name}`;
      if (!findActiveIncidentByKind(kind)) {
        const recurrence = computeRecurrence(kind, ts, recurrenceWindowMs);
        const detail = staleDeliveries
          .map((d) => `delivery=${d.delivery_id} age_min=${Math.round((ts - d.created_at) / 60000)}`)
          .join('; ');
        insertAlertIncident({
          kind,
          severity: staleRule.severity,
          title: staleRule.message,
          detail,
          related_entity_type: 'delivery',
          related_entity_id: staleDeliveries[0].delivery_id,
          slaMinutes,
          recurrence,
          ts,
        });
        incidentsCreated++;
      }
    }

    const triggered = alerts.filter((a) => a.triggered && a.rule.name !== 'stale_proposed_delivery').length
      + (staleDeliveries.length > 0 ? 1 : 0);
    return { triggered, incidents_created: incidentsCreated };
  }

  /**
   * §22.4-36 超 resolution SLO 升级：对未 resolve 且已超 SLO 的 incident 升级 severity 一次
   * （escalated 标记保证只升一次；critical 已最高不升）。
   */
  function escalateOverdueIncidents(opts: { resolutionSlaMinutes?: Partial<Record<V2IncidentSeverity, number>> } = {}): number {
    const slaMinutes = { ...DEFAULT_RESOLUTION_SLA_MINUTES, ...opts.resolutionSlaMinutes };
    const ts = now();
    const open = store.listIncidents(undefined, undefined, 1000).filter((inc) => inc.status !== 'resolved');
    let escalated = 0;
    for (const inc of open) {
      if (inc.escalated) continue;
      const next = nextSeverity(inc.severity);
      if (!next) continue;
      const slaMin = inc.resolution_sla_minutes ?? slaMinutes[inc.severity];
      if (!slaMin) continue;
      if (ts < inc.opened_at + slaMin * 60_000) continue;
      store.updateIncident(inc.incident_id, {
        severity: next,
        escalated: 1,
        updated_at: ts,
        revision: inc.revision + 1,
      });
      store.insertAuditEvent({
        audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        project_id: inc.project_id,
        actor_id: 'system',
        action: 'incident.escalated',
        subject_type: 'incident',
        subject_id: inc.incident_id,
        correlation_id: inc.correlation_id,
        evidence_digest: '',
        created_at: ts,
      });
      escalated++;
    }
    return escalated;
  }

  return {
    generateMetrics,
    evaluateAlerts,
    runAlertEvaluation,
    escalateOverdueIncidents,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
