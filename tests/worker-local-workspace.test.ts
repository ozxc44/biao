/**
 * 跨机 slot 的本地工作区（localWorkspace / projectRoot）测试
 * 覆盖：
 *  - resolveExecutionProjectPath：任务路径本地存在优先；不存在回落 localWorkspace；都不可用原样返回
 *  - writeResult / writeClaimFile / progress tracker 在 task.project_path 非本地路径时
 *    通过显式 projectRoot（slot 本地 checkout）正常绑定与写入
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveExecutionProjectPath,
  writeClaimFile,
  writeResult,
  createWorkerProgressTracker,
} from '../src/worker/base.js';
import type { ClaimedTask } from '../src/worker/base.js';

const CENTRAL_ONLY_PATH = '/data/definitely-not-on-this-machine/proj';

function crossMachineTask(taskId: string): ClaimedTask {
  return {
    task_id: taskId,
    plan_id: 'plan-x',
    title: 'cross-machine task',
    type: 'code',
    phase: 'impl',
    status: 'running',
    assignee: 'auto',
    project_path: CENTRAL_ONLY_PATH,
    claim_token: 'claim-token-x',
    timeout_seconds: 600,
    retries: 0,
    resolution_task_ids: [],
    resolution_generation: 0,
    resolution_attempts: 0,
    ownership: { files: [], modules: [] },
    created_at: 0,
    claimed_at: 0,
    claimed_by: 'worker-x',
    expire_at: 0,
    max_retries: 2,
    verify: [],
    acceptance_for: [],
    pm_repair_ownership_required: false,
  } as ClaimedTask;
}

describe('跨机 slot 本地工作区', () => {
  it('resolveExecutionProjectPath：本地存在的任务路径优先', () => {
    const local = mkdtempSync(join(tmpdir(), 'biao-local-ws-'));
    try {
      expect(resolveExecutionProjectPath(local)).toBe(local);
      expect(resolveExecutionProjectPath(local, '/somewhere/else')).toBe(local);
      expect(resolveExecutionProjectPath(undefined, local)).toBe(local);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('resolveExecutionProjectPath：任务路径非本地目录时回落 localWorkspace', () => {
    const local = mkdtempSync(join(tmpdir(), 'biao-local-ws-'));
    try {
      expect(resolveExecutionProjectPath(CENTRAL_ONLY_PATH, local)).toBe(local);
      // 回落目标也不存在时原样返回任务路径，让执行错误自然暴露
      expect(resolveExecutionProjectPath(CENTRAL_ONLY_PATH, '/no/such/dir')).toBe(CENTRAL_ONLY_PATH);
      expect(resolveExecutionProjectPath(CENTRAL_ONLY_PATH)).toBe(CENTRAL_ONLY_PATH);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('writeResult/writeClaimFile/progress 用 projectRoot 绑定本地产物目录', () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'biao-local-ws-'));
    const task = crossMachineTask('cross-machine-task-1');
    const workDir = join(localRoot, 'work', task.task_id);
    try {
      const progress = createWorkerProgressTracker(workDir, task, 'worker-x', localRoot);
      expect(existsSync(join(workDir, '.progress.json'))).toBe(true);

      const claimPath = writeClaimFile(workDir, task, 'worker-x', localRoot);
      expect(claimPath).toContain(join(localRoot, 'work', task.task_id));

      const { resultMdPath } = writeResult(
        workDir,
        task,
        { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false },
        [],
        'worker-x',
        'test',
        'model-x',
        [],
        localRoot,
      );
      expect(existsSync(resultMdPath)).toBe(true);
      expect(readFileSync(resultMdPath, 'utf8')).toContain('cross-machine task');
      void progress;
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
