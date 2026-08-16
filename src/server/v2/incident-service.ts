/**
 * V2 Incident Service（Phase 7a）
 *
 * 对应 §4.8（ReadOnlyAcceptance 与 Incident）、§21 Phase 7 原文。
 * 状态机：open → acked → resolved + SLA 字段（ack_due_at / resolved_at）。
 * 触发点：merge integration_failed、降级 read_only、revoke-all、quarantine。
 */

import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { IncidentRow, V2IncidentSeverity, V2IncidentStatus } from '../../types/v2-infra.js';
import type { ApiResponse } from '../../types/index.js';

export type IncidentServiceApiResponse<T> = ApiResponse<T>;

function ok<T>(data: T): IncidentServiceApiResponse<T> {
  return { ok: true, data };
}

function fail<T = never>(code: string, message: string): IncidentServiceApiResponse<T> {
  return { ok: false, data: null, error: { code, message } };
}

/** SLA 默认值（毫秒）：warning=4h, critical=1h, info=24h */
const SLA_ACK_MS: Record<V2IncidentSeverity, number> = {
  info: 24 * 60 * 60 * 1000,
  warning: 4 * 60 * 60 * 1000,
  critical: 60 * 60 * 1000,
};

export interface CreateIncidentInput {
  project_id?: string | null;
  kind: string;
  severity?: V2IncidentSeverity;
  title: string;
  detail?: string;
  correlation_id?: string;
  related_entity_type?: string;
  related_entity_id?: string;
}

export interface IncidentServiceOptions {
  store: SqliteStore;
  now?: () => number;
}

export function createIncidentService(options: IncidentServiceOptions) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());

  function createIncident(input: CreateIncidentInput): IncidentServiceApiResponse<IncidentRow> {
    const ts = now();
    const severity = input.severity ?? 'warning';
    const row: IncidentRow = {
      incident_id: `inc-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: input.project_id ?? null,
      kind: input.kind,
      severity,
      status: 'open',
      title: input.title,
      detail: input.detail ?? '',
      correlation_id: input.correlation_id ?? '',
      related_entity_type: input.related_entity_type ?? '',
      related_entity_id: input.related_entity_id ?? '',
      opened_at: ts,
      ack_due_at: ts + SLA_ACK_MS[severity],
      acked_at: null,
      acked_by: '',
      ack_note: '',
      resolved_at: null,
      resolved_by: '',
      resolution_evidence: '',
      revision: 1,
      created_at: ts,
      updated_at: ts,
    };
    store.insertIncident(row);
    // 写审计事件
    store.insertAuditEvent({
      audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: input.project_id ?? null,
      actor_id: 'system',
      action: 'incident.opened',
      subject_type: 'incident',
      subject_id: row.incident_id,
      correlation_id: row.correlation_id,
      evidence_digest: '',
      created_at: ts,
    });
    return ok(row);
  }

  function getIncident(incidentId: string): IncidentServiceApiResponse<IncidentRow> {
    const row = store.getIncident(incidentId);
    if (!row) return fail('INCIDENT_NOT_FOUND', `incident ${incidentId} 不存在`);
    return ok(row);
  }

  function listIncidents(options: {
    project_id?: string;
    status?: V2IncidentStatus;
    limit?: number;
  }): IncidentServiceApiResponse<{ items: IncidentRow[] }> {
    const items = store.listIncidents(options.project_id, options.status, options.limit);
    return ok({ items });
  }

  function ackIncident(
    incidentId: string,
    input: { acked_by: string; note?: string },
  ): IncidentServiceApiResponse<IncidentRow> {
    const row = store.getIncident(incidentId);
    if (!row) return fail('INCIDENT_NOT_FOUND', `incident ${incidentId} 不存在`);
    if (row.status !== 'open') {
      return fail('INVALID_TRANSITION', `incident ${incidentId} 状态 ${row.status}，不能 ack`);
    }
    const ts = now();
    store.updateIncident(incidentId, {
      status: 'acked',
      acked_at: ts,
      acked_by: input.acked_by,
      ack_note: input.note ?? '',
      revision: row.revision + 1,
      updated_at: ts,
    });
    store.insertAuditEvent({
      audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: row.project_id,
      actor_id: input.acked_by,
      action: 'incident.acked',
      subject_type: 'incident',
      subject_id: incidentId,
      correlation_id: row.correlation_id,
      evidence_digest: '',
      created_at: ts,
    });
    return ok(store.getIncident(incidentId)!);
  }

  function resolveIncident(
    incidentId: string,
    input: { resolved_by: string; evidence: string },
  ): IncidentServiceApiResponse<IncidentRow> {
    const row = store.getIncident(incidentId);
    if (!row) return fail('INCIDENT_NOT_FOUND', `incident ${incidentId} 不存在`);
    if (row.status === 'resolved') {
      return fail('ALREADY_RESOLVED', `incident ${incidentId} 已 resolved`);
    }
    if (!input.evidence || input.evidence.trim() === '') {
      return fail('EVIDENCE_REQUIRED', 'resolve 必须附带 evidence');
    }
    const ts = now();
    store.updateIncident(incidentId, {
      status: 'resolved',
      resolved_at: ts,
      resolved_by: input.resolved_by,
      resolution_evidence: input.evidence,
      revision: row.revision + 1,
      updated_at: ts,
    });
    store.insertAuditEvent({
      audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: row.project_id,
      actor_id: input.resolved_by,
      action: 'incident.resolved',
      subject_type: 'incident',
      subject_id: incidentId,
      correlation_id: row.correlation_id,
      evidence_digest: '',
      created_at: ts,
    });
    return ok(store.getIncident(incidentId)!);
  }

  /**
   * 事件源接线：merge integration_failed、降级 read_only、revoke-all、quarantine 触发点写入 incident。
   */
  function emitIncidentFromEvent(event: {
    kind: string;
    project_id?: string | null;
    severity?: V2IncidentSeverity;
    title: string;
    detail?: string;
    correlation_id?: string;
    related_entity_type?: string;
    related_entity_id?: string;
  }): IncidentServiceApiResponse<IncidentRow> {
    return createIncident(event);
  }

  return {
    createIncident,
    getIncident,
    listIncidents,
    ackIncident,
    resolveIncident,
    emitIncidentFromEvent,
  };
}
