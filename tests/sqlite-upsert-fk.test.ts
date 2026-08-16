/**
 * SQLite upsert 外键回归：better-sqlite3 默认强制外键，旧行用 INSERT OR REPLACE
 * 更新被引用的父行（plans/tasks）会先 DELETE 再插入，直接 FOREIGN KEY constraint
 * failed（生产中表现为 Supervisor /reconcile 每 5 秒重试失败）。upsert 必须用
 * ON CONFLICT DO UPDATE。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteStore, type PlanRow, type TaskRow } from '../src/db/sqlite-store.js';

let rootDir: string;
let store: SqliteStore;

const plan: PlanRow = {
  plan_id: 'fk-plan',
  title: 'FK 回归',
  status: 'submitted',
  project_path: '/tmp/fk-project',
  default_assignee: 'auto',
  default_priority: 5,
  phases: '[]',
  task_count: 1,
  created_at: '1700000000000',
  submitted_at: '',
  pm_consumer: 'pm',
};

const task: TaskRow = {
  task_id: 'fk-task',
  plan_id: 'fk-plan',
  title: '引用 plan 的任务',
  type: 'code',
  phase: 'impl',
  status: 'pending',
  priority: 5,
  assignee: 'auto',
  ownership_files: '',
  ownership_modules: '',
  depends_on: '',
  timeout_seconds: 1800,
  max_retries: 2,
  model_override: '',
  acceptance_for: '',
  verify: '[]',
  claimed_by: '',
  claimed_at: '',
  expire_at: '',
  result_path: '',
  result_json_path: '',
  done_at: '',
  retries: 0,
  pm_review_status: '',
  pm_reviewed_by: '',
  pm_reviewed_at: '',
  pm_review_comment: '',
  failure_reason: '',
  fix_for: '',
  repair_root_task_id: '',
  trigger_review_task_id: '',
  resolution_status: '',
  resolution_action: '',
  resolution_task_id: '',
  resolution_task_ids: '',
  acceptance_repair_task_ids: '',
  resolved_by_task: '',
  resolution_generation: 0,
  resolution_attempts: 0,
  resolution_decision_reason: '',
  blocked_at: '',
  block_reason: '',
  blocked_question_id: '',
  blocked_lease_remaining: '',
  last_question_id: '',
  last_question_answer: '',
  cancelled_at: '',
  cancel_reason: '',
  superseded_at: '',
  superseded_by: '',
  superseded_reason: '',
  supersede_preview_token: '',
  supersede_batch_size: 0,
  verify_results: '[]',
  goal_md: '',
  created_at: '1700000000000',
  updated_at: '1700000000000',
};

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'biao-sqlite-fk-'));
  store = new SqliteStore(join(rootDir, 'biao.sqlite'));
});

afterAll(() => {
  store?.close();
  rmSync(rootDir, { recursive: true, force: true });
});

describe('upsert 不触发外键失败', () => {
  it('外键强制开启时，被 tasks 引用的 plan 可以重复 upsert', () => {
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
    store.upsertPlan(plan);
    store.upsertTask(task);

    // 旧行为（INSERT OR REPLACE）在这一步抛 FOREIGN KEY constraint failed
    expect(() => store.upsertPlan({ ...plan, title: '更新后的标题' })).not.toThrow();
    expect(store.getAllPlans().find((row) => row.plan_id === 'fk-plan')?.title).toBe('更新后的标题');
    expect(store.getAllTasks().find((row) => row.task_id === 'fk-task')?.plan_id).toBe('fk-plan');
  });

  it('被 questions 引用的 task 可以重复 upsert，且字段全量覆盖', () => {
    store.upsertQuestion({
      question_id: 'q-1',
      task_id: 'fk-task',
      plan_id: 'fk-plan',
      agent_id: 'worker-1',
      body: '决策问题',
      checkpoint: 'c1',
      status: 'open',
    });

    expect(() => store.upsertTask({ ...task, status: 'running', claimed_by: 'worker-1' })).not.toThrow();
    expect(store.getQuestion('q-1')?.task_id).toBe('fk-task');
    expect(store.getAllTasks().find((row) => row.task_id === 'fk-task')).toMatchObject({ status: 'running', claimed_by: 'worker-1' });

    expect(() => store.upsertQuestion({ question_id: 'q-1', task_id: 'fk-task', agent_id: 'worker-1', status: 'answered', answer: '继续' })).not.toThrow();
    expect(store.getQuestion('q-1')).toMatchObject({ status: 'answered', answer: '继续' });
  });
});
