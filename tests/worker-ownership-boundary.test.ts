import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOwnershipConflict, runWorkerLoop, type BiaoClient } from '../src/worker/base.js';
import type { ClaimedTask } from '../src/types/index.js';

let projectPath: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: projectPath, stdio: 'ignore' });
}

function task(ownershipFiles: string[]): ClaimedTask {
  return {
    task_id: 'ownership-boundary',
    title: 'ownership boundary',
    type: 'code',
    phase: 'impl',
    priority: 5,
    ownership_files: ownershipFiles,
    goal_md: '',
    timeout_seconds: 60,
    claim_token: 'claim-token',
    verify: [],
    project_path: projectPath,
    plan_id: 'ownership-plan',
  };
}

function clientFor(claimedTask: ClaimedTask, report = vi.fn(async () => ({ ok: true, data: {} }))): BiaoClient {
  return {
    register: vi.fn(async () => ({ ok: true, data: {} })),
    heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
    claim: vi.fn(async () => ({ ok: true, data: claimedTask })),
    getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'boundary-worker' } })),
    checkOwnership: vi.fn(async () => ({ ok: true, data: { occupied: false, action: 'proceed' } })),
    report,
  } as unknown as BiaoClient;
}

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'biao-ownership-boundary-'));
  mkdirSync(join(projectPath, 'src', 'owned'), { recursive: true });
  mkdirSync(join(projectPath, 'src', 'foreign'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'owned', 'modified.ts'), 'before\n');
  writeFileSync(join(projectPath, 'src', 'owned', 'deleted.ts'), 'delete me\n');
  writeFileSync(join(projectPath, 'src', 'owned', 'already-dirty.ts'), 'committed\n');
  writeFileSync(join(projectPath, 'src', 'foreign', 'already-dirty.ts'), 'committed\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Biao Test');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  // 领取前已有的其他人 dirty diff，不能归因给本 Worker。
  writeFileSync(join(projectPath, 'src', 'foreign', 'already-dirty.ts'), 'other worker before claim\n');
  // 同时准备一个领取前已 dirty、但会被当前 Worker 再次修改的 owned 文件。
  writeFileSync(join(projectPath, 'src', 'owned', 'already-dirty.ts'), 'dirty before claim\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectPath, { recursive: true, force: true });
});

describe('Worker Git ownership boundary', () => {
  it('preempt 的 force declare 被平台拒绝时安全 block，绝不把失败当成 proceed', async () => {
    const claimedTask = task(['src/owned/**']);
    const blockTask = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      checkOwnership: vi.fn(async () => ({
        ok: true,
        data: { occupied: true, action: 'preempt', owner: { agent_id: 'other', priority: 3 } },
      })),
      declareOwnership: vi.fn(async () => ({
        ok: false,
        error: { code: 'OWNERSHIP_RACE', message: 'holder changed' },
      })),
      blockTask,
    } as unknown as BiaoClient;

    await expect(resolveOwnershipConflict(
      client, 'src/owned/**', claimedTask, 'boundary-worker', 1, 1, 'block',
    )).resolves.toBe(false);
    expect(blockTask).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'waiting_file_release',
    );
  });

  it('用执行前后 Git 内容快照记录新增、修改、删除，并排除执行前已存在的 dirty diff', async () => {
    const claimedTask = task(['src/owned/**']);
    const report = vi.fn(async () => ({ ok: true, data: {} }));

    await runWorkerLoop({
      agentId: 'boundary-worker',
      agentType: 'test',
      maxTasks: 1,
      client: clientFor(claimedTask, report),
      execute: async () => {
        writeFileSync(join(projectPath, 'src', 'owned', 'modified.ts'), 'after\n');
        writeFileSync(join(projectPath, 'src', 'owned', 'already-dirty.ts'), 'changed again during execution\n');
        writeFileSync(join(projectPath, 'src', 'owned', 'created.ts'), 'new\n');
        unlinkSync(join(projectPath, 'src', 'owned', 'deleted.ts'));
        // 模拟 Agent 自报缺失；平台仍必须以真实 Git 差异为准。
        return {
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(projectPath, 'work', claimedTask.task_id, 'result.json'), 'utf8'));
    expect(result.changed_files).toEqual([
      'src/owned/already-dirty.ts',
      'src/owned/created.ts',
      'src/owned/deleted.ts',
      'src/owned/modified.ts',
    ]);
    expect(result.changed_files).not.toContain('src/foreign/already-dirty.ts');
    expect(report).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'done', expect.any(String), expect.any(String), [],
    );
  });

  it('发现时间窗内的未授权真实变更时禁止 done，并把文件写入可审计失败产物', async () => {
    const claimedTask = task(['src/owned/**']);
    const report = vi.fn(async () => ({ ok: true, data: {} }));

    await runWorkerLoop({
      agentId: 'boundary-worker',
      agentType: 'test',
      maxTasks: 1,
      client: clientFor(claimedTask, report),
      execute: async () => {
        writeFileSync(join(projectPath, 'src', 'foreign', 'unauthorized.ts'), 'no grant\n');
        return {
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: ['src/owned/falsely-reported.ts'], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(projectPath, 'work', claimedTask.task_id, 'result.json'), 'utf8'));
    expect(result.changed_files).toEqual(['src/foreign/unauthorized.ts']);
    expect(result.ownership_violations).toEqual([
      { path: 'src/foreign/unauthorized.ts', changeType: 'created' },
    ]);
    expect(result.status).toBe('failed');
    expect(report).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'failed', expect.any(String), expect.any(String), [],
    );
    expect(report.mock.calls.some((args) => args[2] === 'done')).toBe(false);
  });

  it('共享工作区中由另一活跃 ownership 覆盖的并发变更不归责给当前 Worker', async () => {
    const claimedTask = task(['src/owned/**']);
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const client = clientFor(claimedTask, report);
    vi.mocked(client.checkOwnership).mockImplementation(async (path: string) => path === 'src/foreign/concurrent.ts'
      ? {
          ok: true,
          data: {
            occupied: true,
            action: 'wait',
            owner: { agent_id: 'other-worker', task_id: 'other-task', priority: 5 },
          },
        }
      : { ok: true, data: { occupied: false, action: 'proceed' } });

    await runWorkerLoop({
      agentId: 'boundary-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => {
        writeFileSync(join(projectPath, 'src', 'owned', 'created.ts'), 'mine\n');
        writeFileSync(join(projectPath, 'src', 'foreign', 'concurrent.ts'), 'other worker\n');
        return {
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: ['src/owned/created.ts'], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(projectPath, 'work', claimedTask.task_id, 'result.json'), 'utf8'));
    expect(result.changed_files).toEqual(['src/owned/created.ts']);
    expect(result.ownership_violations).toBeUndefined();
    expect(result.status).toBe('success');
    expect(report).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'done', expect.any(String), expect.any(String), [],
    );
  });

  it('另一 Worker 在本任务结束前已释放 ownership 时，仍按执行起点快照排除其并发变更', async () => {
    const claimedTask = task(['src/owned/**']);
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const client = clientFor(claimedTask, report);
    (client as any).listActiveOwnership = vi.fn(async () => ({
      ok: true,
      data: {
        ownership: [{
          path: 'src/foreign/**',
          agent_id: 'other-worker',
          task_id: 'other-task',
          priority: 5,
          declared_at: Date.now() - 1_000,
          expires_at: Date.now() + 60_000,
          base_commit_sha: 'fixture',
        }],
        total: 1,
      },
    }));
    // 模拟另一 Worker 已先完成并释放 ownership：结束时点查询已看不到 owner。
    vi.mocked(client.checkOwnership).mockResolvedValue({
      ok: true,
      data: { occupied: false, action: 'proceed' },
    });

    await runWorkerLoop({
      agentId: 'boundary-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => {
        writeFileSync(join(projectPath, 'src', 'owned', 'created.ts'), 'mine\n');
        writeFileSync(join(projectPath, 'src', 'foreign', 'concurrent.ts'), 'other worker\n');
        return {
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: ['src/owned/created.ts'], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(projectPath, 'work', claimedTask.task_id, 'result.json'), 'utf8'));
    expect(result.changed_files).toEqual(['src/owned/created.ts']);
    expect(result.ownership_violations).toBeUndefined();
    expect(result.status).toBe('success');
    expect(report).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'done', expect.any(String), expect.any(String), [],
    );
  });

  it('Agent 自报触碰了他人 ownership 文件时仍 fail closed，不得把 checkout 回滚伪装成并发改动', async () => {
    const claimedTask = task(['src/owned/**']);
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const client = clientFor(claimedTask, report);
    vi.mocked(client.checkOwnership).mockImplementation(async (path: string) =>
      path === 'src/foreign/already-dirty.ts'
        ? {
            ok: true,
            data: {
              occupied: true,
              action: 'wait',
              owner: { agent_id: 'other-worker', task_id: 'other-task', priority: 5 },
            },
          }
        : { ok: true, data: { occupied: false, action: 'proceed' } });

    await runWorkerLoop({
      agentId: 'boundary-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => {
        // 模拟 Agent 用 checkout/restore 覆盖了领取前的他人 dirty 内容，
        // 并且工具流明确上报过该路径。
        writeFileSync(join(projectPath, 'src', 'foreign', 'already-dirty.ts'), 'committed\n');
        return {
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: ['src/foreign/already-dirty.ts'], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(projectPath, 'work', claimedTask.task_id, 'result.json'), 'utf8'));
    expect(result.ownership_violations).toEqual([
      { path: 'src/foreign/already-dirty.ts', changeType: 'modified' },
    ]);
    expect(report).toHaveBeenCalledWith(
      claimedTask.task_id, claimedTask.claim_token, 'failed', expect.any(String), expect.any(String), [],
    );
  });
});
