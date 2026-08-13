import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, type PlanRow, type TaskRow } from '../src/db/sqlite-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function plan(planId: string, projectPath: string): PlanRow {
  return {
    plan_id: planId, title: planId, status: 'submitted', project_path: projectPath,
    default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
    created_at: '1700000000000', submitted_at: '1700000001000', pm_consumer: 'pm',
  };
}

function task(taskId: string, planId: string): TaskRow {
  return {
    task_id: taskId, plan_id: planId, title: taskId, type: 'code', phase: 'impl', status: 'pending',
    priority: 5, assignee: 'auto', ownership_files: '', ownership_modules: '', depends_on: '',
    timeout_seconds: 60, max_retries: 2, model_override: '', acceptance_for: '', verify: '[]',
    claimed_by: '', claimed_at: '', expire_at: '', result_path: '', result_json_path: '', done_at: '',
    retries: 0, pm_review_status: '', pm_reviewed_by: '', pm_reviewed_at: '', pm_review_comment: '',
    pm_reject_reason: '', pm_fix_instructions: '', pm_rejection_resolution_mode: '',
    repair_ownership_extension: '', failure_reason: '', fix_for: '', repair_root_task_id: '',
    resolution_status: '', resolution_action: '', resolution_task_id: '', resolution_task_ids: '',
    resolved_by_task: '', resolution_generation: 0, resolution_attempts: 0, resolution_decision_reason: '',
    blocked_at: '', block_reason: '', blocked_question_id: '', blocked_lease_remaining: '',
    last_question_id: '', last_question_answer: '', cancelled_at: '', superseded_at: '',
    superseded_by: '', superseded_reason: '', supersede_preview_token: '', supersede_batch_size: 0,
    verify_results: '[]', goal_md: `# ${taskId}`, created_at: '1700000001000', updated_at: '1700000001000',
  };
}

describe('SQLite disaster-restore projection boundary', () => {
  it('uses configured workspace roots, not task names, and keeps excluded rows as audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-restore-boundary-'));
    tempDirs.push(dir);
    const durableRoot = join(dir, 'configured-workspace');
    const outsideRoot = join(dir, 'unmanaged-fixture-workspace');
    const store = new SqliteStore(join(dir, 'archive.sqlite'), { restoreWorkspaceRoots: [durableRoot] });
    try {
      // 名称故意反转：恢复边界只能来自显式 workspace 元数据，不能依赖 ID 猜测。
      store.upsertPlan(plan('test-looking-durable-plan', join(durableRoot, 'customer-a')));
      store.upsertTask(task('test-looking-durable-task', 'test-looking-durable-plan'));
      store.upsertPlan(plan('production-looking-unmanaged-plan', join(outsideRoot, 'project')));
      store.upsertTask(task('production-looking-unmanaged-task', 'production-looking-unmanaged-plan'));

      expect(store.getRestorablePlans().map((row) => row.plan_id)).toEqual(['test-looking-durable-plan']);
      expect(store.getRestorableTasks().map((row) => row.task_id)).toEqual(['test-looking-durable-task']);
      expect(store.getAllPlans()).toHaveLength(2);
      expect(store.getAllTasks()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a workspace symlink that resolves outside the configured root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-restore-symlink-'));
    tempDirs.push(dir);
    const durableRoot = join(dir, 'configured-workspace');
    const outsideRoot = join(dir, 'outside-workspace');
    const linkedProject = join(durableRoot, 'linked-project');
    mkdirSync(durableRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    symlinkSync(outsideRoot, linkedProject, 'dir');

    const store = new SqliteStore(join(dir, 'archive.sqlite'), { restoreWorkspaceRoots: [durableRoot] });
    try {
      store.upsertPlan(plan('symlink-escape-plan', linkedProject));
      store.upsertTask(task('symlink-escape-task', 'symlink-escape-plan'));

      expect(store.getRestorablePlans()).toEqual([]);
      expect(store.getRestorableTasks()).toEqual([]);
      expect(store.getRestoreExclusionSummary()).toEqual({
        plan_count: 1,
        task_count: 1,
        by_reason: { outside_configured_workspace: { plans: 1, tasks: 1 } },
      });
    } finally {
      store.close();
    }
  });

  it('default installation restores durable projects and exposes temporary exclusions by reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-restore-default-'));
    tempDirs.push(dir);
    const simulatedSystemTemp = join(dir, 'system-temp');
    const durableProjects = join(dir, 'durable-projects');
    const store = new SqliteStore(join(dir, 'archive.sqlite'), {
      restoreWorkspaceRoots: [],
      excludeSystemTemporaryProjects: true,
      systemTemporaryRoots: [simulatedSystemTemp],
    });
    try {
      store.upsertPlan(plan('durable-plan', join(durableProjects, 'customer-a')));
      store.upsertTask(task('durable-task', 'durable-plan'));
      store.upsertPlan(plan('ephemeral-plan', join(simulatedSystemTemp, 'vitest-run')));
      store.upsertTask(task('ephemeral-task', 'ephemeral-plan'));

      expect(store.getRestorablePlans().map((row) => row.plan_id)).toEqual(['durable-plan']);
      expect(store.getRestorableTasks().map((row) => row.task_id)).toEqual(['durable-task']);
      expect(store.getRestoreExclusionSummary()).toEqual({
        plan_count: 1,
        task_count: 1,
        by_reason: { system_temporary_project: { plans: 1, tasks: 1 } },
      });
    } finally {
      store.close();
    }
  });
});
