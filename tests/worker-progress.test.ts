import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiaoClient, runWorkerLoop } from '../src/worker/base.js';
import type { ClaimedTask } from '../src/types/index.js';

let projectPath: string;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'biao-worker-progress-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectPath, { recursive: true, force: true });
});

function task(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    task_id: 'progress-task',
    title: '调度器进度审计',
    type: 'code',
    phase: 'impl',
    priority: 5,
    ownership_files: [],
    goal_md: '由外层 Worker 维护进度。',
    timeout_seconds: 60,
    claim_token: 'claim-token-must-never-enter-progress',
    verify: [],
    project_path: projectPath,
    plan_id: 'progress-plan',
    ...overrides,
  };
}

function progressPath(taskId = 'progress-task'): string {
  return join(projectPath, 'work', taskId, '.progress.json');
}

function readProgress(taskId = 'progress-task'): Record<string, any> {
  return JSON.parse(readFileSync(progressPath(taskId), 'utf8')) as Record<string, any>;
}

function baseClient(claimedTask: ClaimedTask, report: ReturnType<typeof vi.fn>): BiaoClient {
  return {
    register: vi.fn(async () => ({ ok: true, data: {} })),
    heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
    claim: vi.fn(async () => ({ ok: true, data: claimedTask })),
    getTask: vi.fn(async () => ({
      ok: true,
      data: { status: 'running', claimed_by: 'progress-worker' },
    })),
    report,
  } as unknown as BiaoClient;
}

describe('Worker scheduler .progress.json', () => {
  it('由外层调度器原子写入私密的完整成功阶段，并只在 result/report 落地后标记 finished', async () => {
    const claimedTask = task();
    const workDir = join(projectPath, 'work', claimedTask.task_id);
    const resultMdPath = join(workDir, 'result.md');
    const resultJsonPath = join(workDir, 'result.json');
    const probe = [
      "const fs = require('node:fs')",
      `const p = ${JSON.stringify(progressPath())}`,
      "const value = JSON.parse(fs.readFileSync(p, 'utf8'))",
      "process.exit(value.stage === 'verifying' ? 0 : 9)",
    ].join(';');
    claimedTask.verify = [{
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(probe)}`,
      expect_exit: 0,
    }];

    const report = vi.fn(async (
      _taskId: string,
      _claimToken: string,
      status: string,
      reportedMdPath: string,
      reportedJsonPath: string,
    ) => {
      expect(status).toBe('done');
      expect(readProgress()).toMatchObject({
        stage: 'reporting',
        artifacts: { result_md: true, result_json: true },
        report: { status: 'done', delivery: 'pending' },
      });
      expect(reportedMdPath).toBe(resultMdPath);
      expect(reportedJsonPath).toBe(resultJsonPath);
      expect(existsSync(resultMdPath)).toBe(true);
      expect(existsSync(resultJsonPath)).toBe(true);
      expect(statSync(resultMdPath).mode & 0o777).toBe(0o600);
      expect(statSync(resultJsonPath).mode & 0o777).toBe(0o600);
      return { ok: true, data: { task_id: claimedTask.task_id, status: 'done' } };
    });

    await runWorkerLoop({
      agentId: 'progress-worker',
      agentType: 'test',
      maxTasks: 1,
      client: baseClient(claimedTask, report),
      execute: async () => {
        expect(readProgress().stage).toBe('running');
        return {
          run: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false },
          changedFiles: ['src/worker/base.ts'],
          backend: 'test',
          model: 'test',
        };
      },
    });

    const raw = readFileSync(progressPath(), 'utf8');
    const progress = JSON.parse(raw) as Record<string, any>;
    expect(progress).toMatchObject({
      schema_version: 1,
      task_id: claimedTask.task_id,
      agent_id: 'progress-worker',
      status: 'done',
      stage: 'finished',
      artifacts: { result_md: true, result_json: true },
      report: { status: 'done', delivery: 'reported' },
    });
    expect(progress.history.map((event: { stage: string }) => event.stage)).toEqual([
      'claimed',
      'running',
      'verifying',
      'reporting',
      'finished',
    ]);
    expect(raw).not.toContain(claimedTask.claim_token);
    expect(raw).not.toContain('BIAO_API_TOKEN');
    expect(statSync(progressPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(workDir).filter((name) => name.startsWith('.progress.json.tmp-'))).toEqual([]);
  });

  it('Agent 异常时仍保留 failed 终态和失败上报事实，不伪造 result 产物', async () => {
    const claimedTask = task({
      task_id: 'progress-exception',
      claim_token: 'exception-token-must-never-enter-progress',
    });
    const report = vi.fn(async (
      _taskId: string,
      _claimToken: string,
      status: string,
    ) => {
      expect(status).toBe('failed');
      expect(readProgress(claimedTask.task_id)).toMatchObject({
        stage: 'reporting',
        artifacts: { result_md: false, result_json: false },
        report: { status: 'failed', delivery: 'pending' },
      });
      return { ok: true, data: { task_id: claimedTask.task_id, status: 'failed' } };
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'progress-worker',
      agentType: 'test',
      maxTasks: 1,
      client: baseClient(claimedTask, report),
      execute: async () => {
        expect(readProgress(claimedTask.task_id).stage).toBe('running');
        throw new Error('agent crashed with private context');
      },
    });

    const raw = readFileSync(progressPath(claimedTask.task_id), 'utf8');
    const progress = JSON.parse(raw) as Record<string, any>;
    expect(progress).toMatchObject({
      status: 'failed',
      stage: 'failed',
      failure_reason: 'worker_exception',
      artifacts: { result_md: false, result_json: false },
      report: { status: 'failed', delivery: 'reported' },
    });
    expect(progress.history.map((event: { stage: string }) => event.stage)).toEqual([
      'claimed',
      'running',
      'reporting',
      'failed',
    ]);
    expect(raw).not.toContain(claimedTask.claim_token);
    expect(raw).not.toContain('private context');
    expect(statSync(progressPath(claimedTask.task_id)).mode & 0o777).toBe(0o600);
    expect(errors).toHaveBeenCalled();
  });

  it('report 送达状态未知时停留 reporting，不把未确认提交伪装成 finished 或 failed 终态', async () => {
    const claimedTask = task({
      task_id: 'progress-report-unknown',
      claim_token: 'unknown-report-token-must-never-enter-progress',
    });
    const report = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const getTask = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { status: 'running', claimed_by: 'progress-worker' } })
      .mockResolvedValueOnce({ ok: true, data: { status: 'running', claimed_by: 'progress-worker' } });
    const client = baseClient(claimedTask, report) as unknown as Record<string, unknown>;
    client.getTask = getTask;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'progress-worker',
      agentType: 'test',
      maxTasks: 1,
      client: client as unknown as BiaoClient,
      execute: async () => ({
        run: { exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false },
        changedFiles: [], backend: 'test', model: 'test',
      }),
    });

    const progress = readProgress(claimedTask.task_id);
    expect(progress).toMatchObject({
      status: 'running',
      stage: 'reporting',
      artifacts: { result_md: true, result_json: true },
      report: { status: 'done', delivery: 'unknown' },
      failure_reason: 'report_delivery_unknown',
    });
    expect(progress.history.map((event: { stage: string }) => event.stage)).toEqual([
      'claimed',
      'running',
      'verifying',
      'reporting',
      'reporting',
    ]);
    expect(errors).toHaveBeenCalled();
  });
});
