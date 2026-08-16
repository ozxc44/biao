/**
 * Phase 7a 后续增强（§22.4-36）：Incident resolution SLO / recurrence / escalation。
 *
 * 在 010 基础上追加三列（全部可空过渡，不破坏既有 insertIncident 显式列清单）：
 * - resolution_sla_minutes：按 severity 的 resolution SLO（分钟），告警调度据此判定
 *   超时并升级；NULL 表示未声明（既有 incident-service 创建的 incident 不自动获得）。
 * - recurrence：同 fingerprint 在 resolve 后复发窗口内重开时递增，字段留档。
 * - escalated：升级标记（0=未升级，1=已升级一次），保证「超 SLO 升级 severity 一次」。
 */
import type Database from 'better-sqlite3';

export const version = '011';

const schemaSql = `
ALTER TABLE incidents ADD COLUMN resolution_sla_minutes INTEGER;
ALTER TABLE incidents ADD COLUMN recurrence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incidents ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0;
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
