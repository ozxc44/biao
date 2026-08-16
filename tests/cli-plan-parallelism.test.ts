import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeDag,
  type DagTaskFact,
} from '../src/cli/dag-analysis.js';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(task_id: string, depends_on: string[] = [], extra: Partial<DagTaskFact> = {}): DagTaskFact {
  return {
    task_id,
    type: 'code',
    status: 'pending',
    depends_on,
    ownership_files: [],
    ...extra,
  };
}

describe('纯函数 DAG 并行度分析', () => {
  it('单链只有一个首波槽位并给出完整关键路径', () => {
    const result = analyzeDag([
      task('a'),
      task('b', ['a']),
      task('c', ['b']),
      task('d', ['c']),
    ]);

    expect(result.counts).toMatchObject({ runnable_now: 1, dependency_waiting: 3 });
    expect(result.first_wave_width).toBe(1);
    expect(result.later_fan_out.max_width).toBe(1);
    expect(result.critical_path).toEqual({ length: 4, task_ids: ['a', 'b', 'c', 'd'] });
    expect(result.recommended_worker_slots).toBe(1);
    expect(result.top_blockers[0]).toMatchObject({ task_id: 'a', blocked_tasks: 3 });
  });

  it('菱形 DAG 报告后续两路 fan-out 与 fan-in', () => {
    const result = analyzeDag([
      task('root'),
      task('left', ['root']),
      task('right', ['root']),
      task('join', ['left', 'right']),
    ]);

    expect(result.projected_waves).toEqual([['root'], ['left', 'right'], ['join']]);
    expect(result.later_fan_out).toEqual({ max_width: 2, wave: 2, task_ids: ['left', 'right'] });
    expect(result.critical_path.length).toBe(3);
    expect(result.recommended_worker_slots).toBe(2);
  });

  it('三路 fan-out/fan-in 建议三个 Worker 槽位', () => {
    const result = analyzeDag([
      task('root'),
      task('one', ['root']),
      task('two', ['root']),
      task('three', ['root']),
      task('join', ['one', 'two', 'three']),
    ]);

    expect(result.projected_waves).toEqual([['root'], ['one', 'three', 'two'], ['join']]);
    expect(result.later_fan_out.max_width).toBe(3);
    expect(result.recommended_worker_slots).toBe(3);
  });

  it('repair 根只有 resolution resolved 才放行，accepted repair 本身也为 terminal', () => {
    const waiting = analyzeDag([
      task('source', [], {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'repairing',
        resolution_task_id: 'source-repair-1',
      }),
      task('source-repair-1', [], {
        status: 'done', pm_review_status: 'accepted', fix_for: 'source', repair_root_task_id: 'source',
      }),
      task('downstream', ['source']),
    ]);
    expect(waiting.task_ids.review_waiting).toContain('source');
    expect(waiting.task_ids.terminal).toContain('source-repair-1');
    expect(waiting.task_ids.dependency_waiting).toContain('downstream');

    const resolved = analyzeDag([
      task('source', [], {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'resolved',
        resolved_by_task: 'source-repair-1',
      }),
      task('source-repair-1', [], {
        status: 'done', pm_review_status: 'accepted', fix_for: 'source', repair_root_task_id: 'source',
      }),
      task('downstream', ['source']),
    ]);
    expect(resolved.task_ids.terminal).toEqual(expect.arrayContaining(['source', 'source-repair-1']));
    expect(resolved.task_ids.runnable_now).toEqual(['downstream']);
  });

  it('done 但 Review 未通过不会误放行普通下游，acceptance 可消费 done 来源', () => {
    const result = analyzeDag([
      task('delivery', [], { status: 'done' }),
      task('normal', ['delivery']),
      task('acceptance', ['delivery'], { type: 'acceptance' }),
    ]);

    expect(result.task_ids.review_waiting).toEqual(['delivery']);
    expect(result.task_ids.dependency_waiting).toEqual(['normal']);
    expect(result.task_ids.runnable_now).toEqual(['acceptance']);
  });

  it('当前 ownership 冲突优先标记 ownership_waiting', () => {
    const result = analyzeDag([
      task('free', [], { ownership_files: ['docs/free.md'] }),
      task('conflicted', [], { ownership_files: ['src/app/**'] }),
    ], [{ path: 'src/app/live.ts', task_id: 'other-running', agent_id: 'worker-a' }]);

    expect(result.task_ids.runnable_now).toEqual(['free']);
    expect(result.task_ids.ownership_waiting).toEqual(['conflicted']);
    expect(result.first_wave_width).toBe(1);
  });
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function mockService(
  responder: (request: { method: string; path: string; body: unknown }) => unknown,
): Promise<{ url: string; requests: Array<{ method: string; path: string; body: unknown }> }> {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const request = { method: req.method ?? 'GET', path: req.url ?? '/', body: await readBody(req) };
    requests.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(responder(request)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function runCli(args: string[], url: string) {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: url }, encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function makePreviewPlan(taskCount: number, missingDependency = false): string {
  const root = mkdtempSync(join(tmpdir(), 'biao-parallel-preview-'));
  tempRoots.push(root);
  const planDir = join(root, 'plans', 'parallel-preview');
  mkdirSync(join(planDir, 'tasks'), { recursive: true });
  writeFileSync(join(planDir, 'index.md'), `---\nplan_id: parallel-preview\ntitle: 并行度预览\nproject_path: ${root}\nphases:\n  - id: impl\n    name: 实现\n---\n`);
  for (let index = 0; index < taskCount; index++) {
    const dependency = index === 0
      ? (missingDependency ? ['missing'] : [])
      : [`task-${index - 1}`];
    writeFileSync(join(planDir, 'tasks', `task-${index}.md`), `---
task_id: task-${index}
title: Task ${index}
type: code
phase: impl
assignee: auto
depends_on: ${JSON.stringify(dependency)}
verify: []
---
`);
  }
  return planDir;
}

describe('plan CLI 并行度诊断', () => {
  it('plan status --json 输出真实可领取、依赖等待和稳定分析字段', async () => {
    const mock = await mockService((request) => {
      if (request.path === '/ownership/active') return { ok: true, data: { ownership: [], total: 0 } };
      return {
        ok: true,
        data: {
          plan_id: 'p1', status: 'active', project_path: '/tmp/p1',
          tasks: {
            pending: [task('root'), task('child', ['root'])],
            running: [], blocked: [], done: [], failed: [], cancelled: [], superseded: [],
          },
          reviews: { pending: 0, accepted: 0, rejected: 0 },
        },
      };
    });

    const outcome = await runCli(['plan', 'status', 'p1', '--json'], mock.url);
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: {
        parallelism: {
          schema_version: 1,
          counts: { runnable_now: 1, dependency_waiting: 1 },
          first_wave_width: 1,
          recommended_worker_slots: 1,
        },
      },
    });
  });

  it('plan submit --preview 对八任务单链显眼告警且保持只读', async () => {
    const planDir = makePreviewPlan(8);
    const outcome = await runCli(['plan', 'submit', planDir, '--preview', '--json'], 'http://127.0.0.1:1');

    expect(outcome.code).toBe(0);
    const result = JSON.parse(outcome.stdout);
    expect(result.data.parallelism).toMatchObject({ root_task_count: 8, first_wave_width: 1 });
    expect(result.data.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LOW_INITIAL_PARALLELISM' }),
    ]));
  });

  it('plan submit 正式提交前也输出串联提醒，不要求 PM 额外运行 preview', async () => {
    const planDir = makePreviewPlan(8);
    const mock = await mockService(() => ({ ok: true, data: { plan_id: 'parallel-preview' } }));

    const outcome = await runCli(['plan', 'submit', planDir], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain('LOW_INITIAL_PARALLELISM');
    expect(outcome.stderr).toContain('可移除的串行依赖');
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({ method: 'POST', path: '/plan/submit' });
  });

  it('plan submit --preview 对不存在依赖保持硬失败且不请求服务', async () => {
    const planDir = makePreviewPlan(8, true);
    const outcome = await runCli(['plan', 'submit', planDir, '--preview', '--json'], 'http://127.0.0.1:1');

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'PLAN_DEPENDENCY_NOT_FOUND' },
    });
  });
});
