/**
 * Phase 5：Merge Queue 数据层。
 *
 * 对应 docs/distributed-multi-node-development-plan.md §4.7（MergeJob 模型）、
 * §12（Merge Queue）、§20.3（关键唯一约束：同 project 同时最多一个 running
 * merge job、merge_jobs(delivery_id, expected_target_sha) 唯一）。
 *
 * - merge_jobs：合并队列 durable 状态（queued/running/merged/conflict/
 *   integration_failed/cancelled/invalidated）。
 * - §20.3 唯一约束：
 *   1. (delivery_id, expected_target_sha) 唯一——同一 delivery 对同一 target
 *      只入队一次（幂等键，§14.5 第 7 条）。
 *   2. 同 project 同时最多一个 running merge job（部分唯一索引）。
 */
import type Database from 'better-sqlite3';

export const version = '008';

const schemaSql = `
-- ──────────────── §4.7 merge_jobs（合并队列 durable 状态） ────────────────
CREATE TABLE IF NOT EXISTS merge_jobs (
  merge_job_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  expected_target_sha TEXT NOT NULL DEFAULT '',
  source_sha TEXT NOT NULL DEFAULT '',
  strategy TEXT NOT NULL DEFAULT 'merge-ff'
    CHECK (strategy IN ('merge-ff', 'cherry-pick', 'provider-pr')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'merged', 'conflict', 'integration_failed', 'cancelled', 'invalidated')),
  final_sha TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  conflict_files TEXT NOT NULL DEFAULT '[]',
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- §20.3: merge_jobs(delivery_id, expected_target_sha) 唯一（幂等键）
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_jobs_delivery_target
  ON merge_jobs(delivery_id, expected_target_sha);

-- §20.3: 同 project 同时最多一个 running merge job（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_jobs_one_running_per_project
  ON merge_jobs(project_id)
  WHERE status = 'running';

-- 查询：按 project 列出队列（queued 在前，按 created_at 排序）
CREATE INDEX IF NOT EXISTS idx_merge_jobs_project_status
  ON merge_jobs(project_id, status, created_at);

-- 查询：按 delivery 查找 merge job
CREATE INDEX IF NOT EXISTS idx_merge_jobs_delivery
  ON merge_jobs(delivery_id);
`;

export const checksumMaterial = schemaSql;

export function up(db: Database.Database): void {
  db.exec(schemaSql);
}
