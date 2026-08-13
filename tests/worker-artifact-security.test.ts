import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BiaoClient,
  clearClaimFile,
  createWorkerProgressTracker,
  runWorkerLoop,
  writeClaimFile,
  writeResult,
} from '../src/worker/base.js';
import { createCliWorkerConfig } from '../src/worker/cli.js';
import {
  atomicWriteWorkerArtifact,
  releaseWorkerArtifactContext,
} from '../src/worker/artifact-security.js';
import type { ClaimedTask } from '../src/types/index.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'biao-worker-artifact-security-'));
});

afterEach(async () => {
  if (server?.listening) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

function task(projectPath: string, taskId = 'artifact-task'): ClaimedTask {
  return {
    task_id: taskId,
    title: 'Worker artifact security',
    type: 'code',
    phase: 'impl',
    priority: 5,
    ownership_files: [],
    goal_md: '# Secure goal\n',
    timeout_seconds: 60,
    claim_token: 'secret-claim-token',
    verify: [],
    project_path: projectPath,
    plan_id: 'artifact-security-plan',
  };
}

function linkedTaskDirectory(taskId = 'artifact-task'): {
  projectPath: string;
  outside: string;
  workDir: string;
} {
  const projectPath = join(root, 'project');
  const outside = join(root, `outside-${taskId}`);
  mkdirSync(join(projectPath, 'work'), { recursive: true });
  mkdirSync(outside);
  const workDir = join(projectPath, 'work', taskId);
  symlinkSync(outside, workDir);
  return { projectPath, outside, workDir };
}

function runMock(url: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(REPO_ROOT, 'src/worker/mock.ts')],
      {
        cwd,
        env: {
          ...process.env,
          BIAO_URL: url,
          BIAO_AGENT_ID: 'artifact-security-mock',
          BIAO_MAX_TASKS: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => done({ code, stderr }));
  });
}

function swapAncestorToOutside(
  projectPath: string,
  taskId: string,
  ancestor: 'project' | 'work',
): { outsideTaskDir: string; originalTaskDir: string } {
  const originalTaskDir = join(projectPath, 'work', taskId);
  const moved = join(root, `original-${ancestor}-${taskId}`);
  const outsideProject = join(root, `outside-project-${ancestor}-${taskId}`);
  const outsideTaskDir = join(outsideProject, 'work', taskId);
  mkdirSync(outsideTaskDir, { recursive: true });

  if (ancestor === 'project') {
    renameSync(projectPath, moved);
    symlinkSync(outsideProject, projectPath);
  } else {
    renameSync(join(projectPath, 'work'), moved);
    symlinkSync(join(outsideProject, 'work'), join(projectPath, 'work'));
  }

  return {
    outsideTaskDir,
    originalTaskDir: ancestor === 'project' ? join(moved, 'work', taskId) : join(moved, taskId),
  };
}

describe('Worker artifact path containment', () => {
  it('standalone crash-recovery 能力只允许 claim，不能升级为通用产物写权限', () => {
    const workDir = mkdtempSync(join(root, 'standalone-claim-'));
    const claimedTask = task(join(root, 'unrelated-project'), 'standalone-task');
    writeClaimFile(workDir, claimedTask, 'security-worker');

    expect(() => atomicWriteWorkerArtifact(workDir, 'result.md', 'must-not-write')).toThrow(
      /WORKER_ARTIFACT_PATH_DENIED/,
    );
    expect(existsSync(join(workDir, '.claim.json'))).toBe(true);
    expect(existsSync(join(workDir, 'result.md'))).toBe(false);
  });

  it('同一 task 上下文绑定后不能通过普通目录替换重新绑定到新 inode', () => {
    const taskId = 'replace-with-directory';
    const projectPath = join(root, 'project-rebind');
    const workDir = join(projectPath, 'work', taskId);
    mkdirSync(workDir, { recursive: true });
    const claimedTask = task(projectPath, taskId);
    writeClaimFile(workDir, claimedTask, 'security-worker');

    renameSync(join(projectPath, 'work'), join(root, 'original-work-rebind'));
    mkdirSync(workDir, { recursive: true });
    const replacementClaim = join(workDir, '.claim.json');
    writeFileSync(replacementClaim, 'replacement-must-not-change');

    expect(() => writeClaimFile(workDir, claimedTask, 'security-worker')).toThrow(
      /WORKER_ARTIFACT_PATH_DENIED/,
    );
    expect(readFileSync(replacementClaim, 'utf8')).toBe('replacement-must-not-change');
  });

  it('任务闭环释放上下文后允许同一路径由下一次 fresh claim 绑定新 inode', () => {
    const taskId = 'released-context';
    const projectPath = join(root, 'project-release');
    const workDir = join(projectPath, 'work', taskId);
    mkdirSync(workDir, { recursive: true });
    const claimedTask = task(projectPath, taskId);
    writeClaimFile(workDir, claimedTask, 'security-worker');

    expect(releaseWorkerArtifactContext(workDir, taskId, projectPath)).toBe(true);
    renameSync(workDir, join(root, 'completed-task-directory'));
    mkdirSync(workDir);

    expect(() => writeClaimFile(workDir, claimedTask, 'security-worker')).not.toThrow();
    expect(existsSync(join(workDir, '.claim.json'))).toBe(true);
  });

  for (const ancestor of ['project', 'work'] as const) {
    it(`Tracker 创建后 ${ancestor} 祖先被替换时禁止把 progress 写到项目外`, () => {
      const taskId = `swap-progress-${ancestor}`;
      const projectPath = join(root, `project-progress-${ancestor}`);
      const workDir = join(projectPath, 'work', taskId);
      mkdirSync(workDir, { recursive: true });
      const claimedTask = task(projectPath, taskId);
      const progress = createWorkerProgressTracker(workDir, claimedTask, 'security-worker');
      const { outsideTaskDir, originalTaskDir } = swapAncestorToOutside(projectPath, taskId, ancestor);
      const outsideProgress = join(outsideTaskDir, '.progress.json');
      writeFileSync(outsideProgress, 'outside-progress-must-not-change');

      expect(() => progress.advance('running')).toThrow(/WORKER_ARTIFACT_PATH_DENIED/);
      expect(readFileSync(outsideProgress, 'utf8')).toBe('outside-progress-must-not-change');
      expect(JSON.parse(readFileSync(join(originalTaskDir, '.progress.json'), 'utf8')).stage).toBe('claimed');
    });

    it(`claim 写入后 ${ancestor} 祖先被替换时禁止删除项目外 claim`, () => {
      const taskId = `swap-claim-${ancestor}`;
      const projectPath = join(root, `project-claim-${ancestor}`);
      const workDir = join(projectPath, 'work', taskId);
      mkdirSync(workDir, { recursive: true });
      const claimedTask = task(projectPath, taskId);
      writeClaimFile(workDir, claimedTask, 'security-worker');
      const { outsideTaskDir, originalTaskDir } = swapAncestorToOutside(projectPath, taskId, ancestor);
      const outsideClaim = join(outsideTaskDir, '.claim.json');
      writeFileSync(outsideClaim, 'outside-claim-must-not-delete');

      expect(() => clearClaimFile(workDir, claimedTask)).toThrow(/WORKER_ARTIFACT_PATH_DENIED/);
      expect(readFileSync(outsideClaim, 'utf8')).toBe('outside-claim-must-not-delete');
      expect(existsSync(join(originalTaskDir, '.claim.json'))).toBe(true);
    });
  }

  it('result、claim 和 progress 在任务目录链接到项目外时全部 fail closed', () => {
    for (const writer of ['result', 'claim', 'progress'] as const) {
      const taskId = `linked-${writer}`;
      const { projectPath, outside, workDir } = linkedTaskDirectory(taskId);
      const claimedTask = task(projectPath, taskId);

      const invoke = () => {
        if (writer === 'result') {
          writeResult(
            workDir,
            claimedTask,
            { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
            [],
            'security-worker',
            'test',
            'test',
            [],
          );
        } else if (writer === 'claim') {
          writeClaimFile(workDir, claimedTask, 'security-worker');
        } else {
          createWorkerProgressTracker(workDir, claimedTask, 'security-worker');
        }
      };

      expect(invoke).toThrow(/WORKER_ARTIFACT_PATH_DENIED/);
      expect(readdirSync(outside)).toEqual([]);
    }
  });

  it('Custom CLI 的 goal.md 在任务目录链接到项目外时 fail closed', async () => {
    const { projectPath, outside } = linkedTaskDirectory('linked-cli-goal');
    const config = createCliWorkerConfig({
      agentId: 'security-cli-worker',
      execCmd: process.execPath,
      maxTasks: 1,
    });

    await expect(config.execute(task(projectPath, 'linked-cli-goal'), projectPath)).rejects.toThrow(
      /WORKER_ARTIFACT_PATH_DENIED/,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('正常目录支持平台合法的大写、点和下划线 task id，并写入全部产物', async () => {
    const projectPath = join(root, 'normal-project');
    mkdirSync(projectPath);
    const claimedTask = task(projectPath, 'Task_A.1');
    const workDir = join(projectPath, 'work', claimedTask.task_id);

    const progress = createWorkerProgressTracker(workDir, claimedTask, 'normal-worker');
    const claimPath = writeClaimFile(workDir, claimedTask, 'normal-worker');
    const result = writeResult(
      workDir,
      claimedTask,
      { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
      [],
      'normal-worker',
      'test',
      'test',
      [],
    );
    const config = createCliWorkerConfig({ execCmd: process.execPath, maxTasks: 1 });
    await config.execute(claimedTask, projectPath);
    progress.advance('finished', { artifactsWritten: true, reportStatus: 'done', reportDelivery: 'reported' });

    for (const artifact of [
      claimPath,
      result.resultMdPath,
      result.resultJsonPath,
      join(workDir, '.progress.json'),
      join(workDir, 'goal.md'),
    ]) {
      expect(existsSync(artifact)).toBe(true);
    }
  });

  it('正式 Worker 遇到不安全目录只返回本地错误，不把任务误报 failed', async () => {
    const { projectPath, outside } = linkedTaskDirectory('linked-loop');
    const claimedTask = task(projectPath, 'linked-loop');
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const heartbeat = vi.fn(async () => ({ ok: true, data: {} }));
    const offline = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat,
      offline,
      claim: vi.fn(async () => ({ ok: true, data: claimedTask })),
      report,
    } as unknown as BiaoClient;

    await expect(runWorkerLoop({
      agentId: 'security-loop-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => ({
        run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
        changedFiles: [],
        backend: 'test',
        model: 'test',
      }),
    })).rejects.toThrow(/WORKER_ARTIFACT_PATH_DENIED/);

    expect(report).not.toHaveBeenCalled();
    expect(heartbeat.mock.calls.at(-1)?.[0]).toBe('linked-loop');
    expect(offline).toHaveBeenCalledWith('worker_exit');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('Mock Worker 在任务目录链接到项目外时退出失败且不写项目外文件', async () => {
    const taskId = 'linked-mock';
    const { projectPath, outside } = linkedTaskDirectory(taskId);
    let claimed = false;
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/register') {
          response.end(JSON.stringify({ ok: true, data: { registration_id: 'mock-reg-security' } }));
          return;
        }
        if (request.url === '/heartbeat' || request.url === '/agent/offline') {
          response.end(JSON.stringify({ ok: true, data: {} }));
          return;
        }
        if (request.url === '/claim' && !claimed) {
          claimed = true;
          response.end(JSON.stringify({ ok: true, data: task(projectPath, taskId) }));
          return;
        }
        if (request.url === '/report') {
          response.end(JSON.stringify({ ok: false, error: { code: 'UNEXPECTED_REPORT' } }));
          return;
        }
        response.end(JSON.stringify({ ok: true, data: null }));
      });
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock test server unavailable');

    const run = await runMock(`http://127.0.0.1:${address.port}`, projectPath);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('WORKER_ARTIFACT_PATH_DENIED');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('已有最终产物链接时 fail closed，不覆盖链接目标', async () => {
    for (const artifact of ['result.md', '.claim.json', '.progress.json', 'goal.md'] as const) {
      const taskId = `target-${artifact.replace(/[^a-z]+/g, '-')}`;
      const projectPath = join(root, `project-${taskId}`);
      const workDir = join(projectPath, 'work', taskId);
      const outside = join(root, `outside-${taskId}.txt`);
      mkdirSync(workDir, { recursive: true });
      writeFileSync(outside, 'victim-must-not-change');
      symlinkSync(outside, join(workDir, artifact));
      const claimedTask = task(projectPath, taskId);

      const invoke = async () => {
        if (artifact === 'result.md') {
          writeResult(
            workDir,
            claimedTask,
            { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
            [],
            'security-worker',
            'test',
            'test',
            [],
          );
        } else if (artifact === '.claim.json') {
          writeClaimFile(workDir, claimedTask, 'security-worker');
        } else if (artifact === '.progress.json') {
          createWorkerProgressTracker(workDir, claimedTask, 'security-worker');
        } else {
          const config = createCliWorkerConfig({ execCmd: process.execPath, maxTasks: 1 });
          await config.execute(claimedTask, projectPath);
        }
      };

      await expect(invoke()).rejects.toThrow(/WORKER_ARTIFACT_PATH_DENIED/);
      expect(readFileSync(outside, 'utf8')).toBe('victim-must-not-change');
      expect(existsSync(join(workDir, artifact))).toBe(true);
    }
  });
});
