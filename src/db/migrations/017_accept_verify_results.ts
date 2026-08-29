/**
 * Migration 017：Bors-lite accept 复验结果列
 *
 * pmReview(reverify=true) 验收通过后，中央复验结果写入 tasks.accept_verify_results
 * （JSON 数组：cmd/exit_code/passed[/output]），随验收审计一起持久化并在
 * getReviewInfo 证据卡投影为 evidence.accept_reverify。
 */

import type Database from 'better-sqlite3';

export const version = '017';

/** 与 up 内 DDL 一一对应的校验材料（schema_migrations checksum）。 */
export const checksumMaterial = 'tasks.accept_verify_results 20260829';

export function up(db: Database.Database): void {
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN accept_verify_results TEXT DEFAULT ''`);
  } catch { /* 列已存在 */ }
}
