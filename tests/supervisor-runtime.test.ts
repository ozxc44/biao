/**
 * 生产 Supervisor 运行时回归：不用 mock fetch，而是接入一个真实本地 HTTP 服务。
 *
 * 这里验证的不是服务端业务规则，而是客户端运行边界：
 * - 所有 plan 共用一轮 /plans、/intake、/events 拉取；
 * - PM 只收到最小门铃，Supervisor 永远不自行 ack；
 * - question_answered 只触发一次 retry-claim 唤醒，正文不会流向 Worker；
 * - 多 slot 的空闲检查由一个协调器串行发起，而非每个 slot 自己常驻轮询。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  BiaoSupervisorRuntime,
  releaseLocalLock,
  tryAcquireLocalLock,
  type SupervisorWorkerSlot,
} from '../src/worker/supervisor.js';
import type { ClaimedTask } from '../src/types/index.js';

interface RequestLog {
  method: string;
  path: string;
  body: string;
}

interface BiaoLikeServerOptions {
  plans?: () => Array<Record<string, unknown>>;
  events?: () => unknown;
  intake?: () => Record<string, unknown>;
  claim?: (body: Record<string, unknown>) => unknown;
  heartbeat?: (body: Record<string, unknown>) => unknown;
  report?: (body: Record<string, unknown>) => unknown;
  task?: (taskId: string) => unknown;
  failPlans?: () => boolean;
  reconcile?: () => Record<string, unknown>;
}

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface LockChild {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  result: Promise<{ acquired: boolean }>;
  exited: Promise<void>;
}

/** 独立 Node 进程同时抢同一个锁，验证不是“同进程顺序调用”的假并发。 */
function spawnLockContender(lockDir: string, biaoUrl: string): LockChild {
  const sourceUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'worker', 'supervisor.ts')).href;
  const script = `
    import { tryAcquireLocalLock, releaseLocalLock } from ${JSON.stringify(sourceUrl)};
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      const handle = tryAcquireLocalLock(${JSON.stringify(biaoUrl)}, ${JSON.stringify(lockDir)});
      process.stdout.write(JSON.stringify({ acquired: handle.acquired }) + '\\n');
      setTimeout(() => { releaseLocalLock(handle); process.exit(0); }, 750);
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (value: { acquired: boolean }) => void;
  let rejectResult!: (error: Error) => void;
  let resolveExited!: () => void;
  let rejectExited!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const result = new Promise<{ acquired: boolean }>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const exited = new Promise<void>((resolve, reject) => { resolveExited = resolve; rejectExited = reject; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line === 'READY') resolveReady();
      else {
        try { resolveResult(JSON.parse(line) as { acquired: boolean }); }
        catch { rejectResult(new Error(`锁子进程输出无法解析：${line}`)); }
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.once('error', (error) => {
    rejectReady(error);
    rejectResult(error);
    rejectExited(error);
  });
  child.once('close', (code) => {
    if (code === 0) resolveExited();
    else {
      const error = new Error(`锁子进程退出 ${code}: ${stderr}`);
      rejectReady(error);
      rejectResult(error);
      rejectExited(error);
    }
  });
  return { child, ready, result, exited };
}

async function startBiaoLikeServer(options: BiaoLikeServerOptions = {}): Promise<{ url: string; requests: RequestLog[] }> {
  const requests: RequestLog[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/plans') {
        if (options.failPlans?.()) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, data: null, error: { code: 'SERVICE_UNAVAILABLE', message: 'temporary' } }));
          return;
        }
        const plans = options.plans?.() ?? [
          { plan_id: 'open-a', status: 'active', project_path: '/tmp/a', tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 }, reviews: { pending: 0, accepted: 0, rejected: 0 } },
          { plan_id: 'open-b', status: 'active', project_path: '/tmp/b', tasks: { pending: 0, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0 }, reviews: { pending: 1, accepted: 0, rejected: 0 } },
        ];
        res.end(JSON.stringify({
          ok: true,
          data: {
            total: plans.length,
            plans,
          },
        }));
        return;
      }
      if (url.pathname === '/intake') {
        res.end(JSON.stringify({
          ok: true,
          data: options.intake?.() ?? {
            consumer: 'pm-a',
            cursor: '100-0',
            counts: { review_requested: 1 },
            items: [{ kind: 'review_requested', event_id: 'evt-review', task_id: 'task-review', plan_id: 'open-b', timestamp: 100 }],
          },
        }));
        return;
      }
      if (url.pathname === '/events') {
        res.end(JSON.stringify({
          ok: true,
          data: options.events?.() ?? [{
            event_id: 'evt-question-answer',
            type: 'question_answered',
            task_id: 'task-question',
            plan_id: 'open-a',
            agent_id: 'worker-a',
            consumer: 'worker',
            timestamp: 101,
            result_status: '',
            acked: 'false',
            // 服务端事件不该携带正文；即使未来误加，运行时也不能把它交给 Worker。
            body: 'never forward this',
          }],
        }));
        return;
      }
      if (url.pathname === '/reconcile' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true, data: options.reconcile?.() ?? {
          reclaimed: [], failed: [],
          requeued: { waiting_file_release: [], waiting_dependency: [] },
        } }));
        return;
      }
      if (url.pathname === '/register') {
        res.end(JSON.stringify({ ok: true, data: {} }));
        return;
      }
      if (url.pathname === '/heartbeat') {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* test server returns normal envelope */ }
        res.end(JSON.stringify(options.heartbeat?.(body) ?? { ok: true, data: {} }));
        return;
      }
      if (url.pathname === '/report') {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* test server returns normal envelope */ }
        res.end(JSON.stringify(options.report?.(body) ?? { ok: true, data: {} }));
        return;
      }
      if (url.pathname === '/claim') {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* test server returns normal envelope */ }
        res.end(JSON.stringify({ ok: true, data: options.claim?.(body) ?? null }));
        return;
      }
      if (url.pathname.startsWith('/task/')) {
        const taskId = decodeURIComponent(url.pathname.slice('/task/'.length));
        res.end(JSON.stringify(options.task?.(taskId) ?? { ok: true, data: { status: 'running' } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, data: null }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function sampleTask(): ClaimedTask {
  return {
    task_id: 'sample', title: 'sample', type: 'code', phase: 'impl', priority: 5,
    ownership_files: [], goal_md: '', timeout_seconds: 60, claim_token: 'token', verify: [],
    project_path: '/tmp/a', plan_id: 'open-a',
  };
}

describe('BiaoSupervisorRuntime production transport', () => {
  it('all plans share one passive polling round and PM doorbell never auto-acks', async () => {
    const { url, requests } = await startBiaoLikeServer();
    const bell: Array<{ planId: string; kinds: string[] }> = [];
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      onPmDoorbell: async (planId, items) => bell.push({ planId, kinds: items.map((item) => item.kind) }),
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    expect(requests.filter((request) => request.path.startsWith('/plans'))).toHaveLength(1);
    expect(requests.filter((request) => request.path.startsWith('/intake'))).toHaveLength(1);
    expect(requests.filter((request) => request.path.startsWith('/events'))).toHaveLength(1);
    expect(requests.some((request) => request.path.startsWith('/intake/ack'))).toBe(false);
    expect(bell).toEqual([{ planId: 'open-b', kinds: ['review_requested'] }]);

    // 老服务仍是时间戳 since；首次探测到数组响应后，后续轮次自动回退，不会卡在 after 参数上。
    await runtime.runOnce();
    const eventRequests = requests.filter((request) => request.path.startsWith('/events'));
    expect(eventRequests).toHaveLength(2);
    expect(eventRequests[0].path).toContain('after=0-0');
    expect(eventRequests[1].path).toContain('since=101');
  });

  it('新服务返回 next_cursor 时持续使用 stream after，不退回时间戳轮询', async () => {
    let calls = 0;
    const { url, requests } = await startBiaoLikeServer({
      events: () => {
        calls++;
        return {
          events: calls === 1 ? [{
            event_id: 'evt-cursor-1', type: 'task_ready', task_id: 'late-task', plan_id: 'open-a', timestamp: 200,
          }] : [],
          next_cursor: calls === 1 ? '200-7' : '200-8',
        };
      },
    });
    const runtime = new BiaoSupervisorRuntime({ biaoUrl: url, consumer: 'pm-a', pollIntervalMs: 1_000 });

    await runtime.runOnce();
    await runtime.runOnce();

    const eventRequests = requests.filter((request) => request.path.startsWith('/events'));
    expect(eventRequests).toHaveLength(2);
    expect(eventRequests[0].path).toContain('after=0-0');
    expect(eventRequests[1].path).toContain('after=200-7');
    expect(eventRequests[1].path).not.toContain('since=');
  });

  it('历史 Question 只由 intake 的当前待办决定，不会在 Supervisor 重启时重放 PM 门铃', async () => {
    const { url } = await startBiaoLikeServer({
      intake: () => ({ consumer: 'pm-a', cursor: '200-2', counts: {}, items: [] }),
      events: () => ({
        // 已被 PM 处理的历史 stream 记录仍可审计，但不能重新变成 PM 待办。
        events: [{
          event_id: 'historic-question', type: 'question_asked', task_id: 'old-task',
          plan_id: 'open-a', question_id: 'old-question', consumer: 'pm-a', timestamp: 200,
        }],
        next_cursor: '200-2',
      }),
    });
    const bell: Array<{ planId: string; kinds: string[] }> = [];
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      pollIntervalMs: 1_000,
      onPmDoorbell: async (planId, items) => bell.push({ planId, kinds: items.map((item) => item.kind) }),
    });

    await runtime.runOnce();

    expect(bell).toEqual([]);
  });

  it('PM doorbell 返回失败时运行时保留待办并在下一共享轮次重试', async () => {
    const { url } = await startBiaoLikeServer({
      events: () => ({ events: [], next_cursor: '0-0' }),
    });
    let attempts = 0;
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      pollIntervalMs: 1_000,
      onPmDoorbell: async () => {
        attempts++;
        return attempts > 1;
      },
    });

    await runtime.runOnce();
    await runtime.runOnce();
    await runtime.runOnce();

    expect(attempts).toBe(2);
  });

  it('短暂服务错误会低频重试，而不会让常驻 Supervisor 退出', async () => {
    let failed = false;
    const errors: string[] = [];
    const { url, requests } = await startBiaoLikeServer({
      failPlans: () => {
        if (failed) return false;
        failed = true;
        return true;
      },
      plans: () => [{
        plan_id: 'closed', status: 'completed', project_path: '/tmp/closed',
        tasks: { pending: 0, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 1, rejected: 0 },
      }],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      pollIntervalMs: 1_000,
      onError: (message) => errors.push(message),
    });

    await runtime.run();

    expect(requests.filter((request) => request.path === '/plans')).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('SERVICE_UNAVAILABLE');
  }, 5_000);

  it('question answer wakes one shared scheduler without forwarding question content to worker slots', async () => {
    const { url } = await startBiaoLikeServer();
    const seenExecuteInputs: unknown[] = [];
    const slot: SupervisorWorkerSlot = {
      agentId: 'worker-a',
      agentType: 'test',
      preferredProject: '/tmp/a',
      execute: async (task) => {
        seenExecuteInputs.push(task);
        return { run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }, changedFiles: [], backend: 'test', model: 'test' };
      },
    };
    const runtime = new BiaoSupervisorRuntime({ biaoUrl: url, consumer: 'pm-a', workers: [slot], pollIntervalMs: 1_000 });

    await runtime.runOnce();

    expect(runtime.workerWakeCount()).toBe(1);
    expect(seenExecuteInputs).toEqual([]);
    expect(sampleTask().question_answer).toBeUndefined();
  });

  it('two idle slots share one claim attempt and each emit one presence heartbeat per shared refresh', async () => {
    const { url, requests } = await startBiaoLikeServer();
    const execute = async () => ({
      run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
      changedFiles: [], backend: 'test', model: 'test',
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [
        { agentId: 'review-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['review'], execute },
        { agentId: 'review-b', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['review'], execute },
      ],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    const claims = requests.filter((request) => request.path === '/claim');
    expect(claims).toHaveLength(1);
    expect(JSON.parse(claims[0].body)).toMatchObject({
      agent_id: 'review-a', preferred_project: '/tmp/a', preferred_types: ['review'],
    });
    const heartbeats = requests.filter((request) => request.path === '/heartbeat').map((request) => JSON.parse(request.body));
    expect(heartbeats).toEqual([
      { agent_id: 'review-a' },
      { agent_id: 'review-b' },
    ]);

    await runtime.runOnce();

    expect(requests.filter((request) => request.path === '/register')).toHaveLength(2);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/heartbeat')).toHaveLength(4);
  });

  it('an idle heartbeat failure is deduplicated and does not interrupt the shared claim round', async () => {
    const errors: string[] = [];
    const { url, requests } = await startBiaoLikeServer({
      heartbeat: () => ({ ok: false, data: null, error: { code: 'TEMPORARY', message: 'presence unavailable' } }),
      events: () => [],
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
      onError: (message) => errors.push(message),
    });

    expect(await runtime.runOnce()).toBe(true);
    expect(await runtime.runOnce()).toBe(true);

    expect(requests.filter((request) => request.path === '/heartbeat')).toHaveLength(2);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TEMPORARY');
  });

  it('a running slot is excluded from coordinator presence while its Worker owns task heartbeats', async () => {
    const project = createTempDir('biao-supervisor-running-');
    let claimed = false;
    let resolveExecute!: () => void;
    let notifyExecuteStarted!: () => void;
    let notifyReportReceived!: () => void;
    const executeStarted = new Promise<void>((resolve) => { notifyExecuteStarted = resolve; });
    const executeMayFinish = new Promise<void>((resolve) => { resolveExecute = resolve; });
    const reportReceived = new Promise<void>((resolve) => { notifyReportReceived = resolve; });
    const { url, requests } = await startBiaoLikeServer({
      plans: () => [{
        plan_id: 'running-plan', status: 'active', project_path: project,
        tasks: { pending: claimed ? 0 : 1, running: claimed ? 1 : 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      claim: () => {
        if (claimed) return null;
        claimed = true;
        return { ...sampleTask(), project_path: project, plan_id: 'running-plan' };
      },
      task: () => ({ ok: true, data: { status: 'running', claimed_by: 'code-a' } }),
      report: () => {
        notifyReportReceived();
        return { ok: true, data: {} };
      },
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: ['running-plan'],
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: project, capabilities: ['code'], heartbeatMs: 60_000,
        execute: async () => {
          notifyExecuteStarted();
          await executeMayFinish;
          return {
            run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
            changedFiles: [], backend: 'test', model: 'test',
          };
        },
      }],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();
    await executeStarted;
    await runtime.runOnce();

    const heartbeatsBeforeFinish = requests
      .filter((request) => request.path === '/heartbeat')
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
    expect(heartbeatsBeforeFinish.filter((body) => body.current_task === undefined)).toHaveLength(1);
    expect(heartbeatsBeforeFinish.filter((body) => body.current_task === 'sample')).toHaveLength(1);

    resolveExecute();
    await reportReceived;
    expect(requests.filter((request) => request.path === '/report')).toHaveLength(1);
  });

  it('限定 planIds 时活跃目标计划仍会正常领取，且同项目的其它计划不会混入 claim 条件', async () => {
    const project = '/tmp/shared-plan-scope';
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [
        {
          plan_id: 'target-plan', status: 'active', project_path: project,
          tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
          reviews: { pending: 0, accepted: 0, rejected: 0 },
        },
        {
          // 项目路径相同，不能因为 preferred_project 一样而被 slot 误领取。
          plan_id: 'other-plan', status: 'active', project_path: project,
          tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
          reviews: { pending: 0, accepted: 0, rejected: 0 },
        },
      ],
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: ['target-plan'],
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: project, capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    expect(await runtime.runOnce()).toBe(true);

    const claims = requests.filter((request) => request.path === '/claim');
    expect(requests.filter((request) => request.path === '/register')).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(JSON.parse(claims[0].body)).toMatchObject({
      agent_id: 'code-a',
      preferred_project: project,
      preferred_plan_ids: ['target-plan'],
      preferred_types: ['code'],
    });
  });

  it('所有受管计划闭环时不注册也不领取，即使同项目还有未受管计划', async () => {
    const project = '/tmp/closed-plan-scope';
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [
        {
          plan_id: 'closed-target', status: 'completed', project_path: project,
          tasks: { pending: 0, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0 },
          reviews: { pending: 0, accepted: 1, rejected: 0 },
        },
        {
          plan_id: 'cancelled-target', status: 'cancelled', project_path: project,
          tasks: { pending: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 1 },
          reviews: { pending: 0, accepted: 0, rejected: 0 },
        },
        {
          // 这项虽然活跃，但不在 --plans 范围内，不能让受管 worker 残留 claim。
          plan_id: 'unmanaged-active', status: 'active', project_path: project,
          tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
          reviews: { pending: 0, accepted: 0, rejected: 0 },
        },
      ],
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: ['closed-target', 'cancelled-target'],
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: project, capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    expect(await runtime.runOnce()).toBe(false);
    expect(requests.filter((request) => request.path === '/register')).toHaveLength(0);
    expect(requests.filter((request) => request.path === '/heartbeat')).toHaveLength(0);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(0);
  });

  it('同项目的异能力 slot 不会被前一个空 claim 饿死', async () => {
    const { url, requests } = await startBiaoLikeServer({ events: () => [] });
    const execute = async () => ({
      run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
      changedFiles: [], backend: 'test', model: 'test',
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [
        { agentId: 'review-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['review'], execute },
        { agentId: 'code-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['code'], execute },
      ],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    const claims = requests.filter((request) => request.path === '/claim').map((request) => JSON.parse(request.body));
    expect(claims).toHaveLength(2);
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'review-a', preferred_types: ['review'] }),
      expect.objectContaining({ agent_id: 'code-a', preferred_types: ['code'] }),
    ]));
  });

  it('新计划或新增 pending 任务在下一次共享快照中只唤醒一次 retry claim', async () => {
    let pending = 0;
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      plans: () => [{
        plan_id: 'late-plan', status: 'active', project_path: '/tmp/a',
        tasks: { pending, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(1);

    pending = 1;
    await runtime.runOnce();
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(2);

    // 没有新的 pending/work event 时，第三轮只读共享状态，不产生额外 claim。
    await runtime.runOnce();
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(2);
  });

  it('同一低频共享轮次调用一次 reconciliation，有恢复结果时唤醒一次 Worker claim', async () => {
    let reconcileCalls = 0;
    const { url, requests } = await startBiaoLikeServer({
      events: () => ({ events: [], next_cursor: '0-0' }),
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [{
        plan_id: 'reconcile-plan', status: 'active', project_path: '/tmp/a',
        tasks: { pending: 0, running: 1, blocked: 1, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      reconcile: () => {
        reconcileCalls++;
        return reconcileCalls === 2
          ? {
              reclaimed: ['stale-task'], failed: [],
              requeued: { waiting_file_release: ['file-waiter'], waiting_dependency: [] },
            }
          : {
              reclaimed: [], failed: [],
              requeued: { waiting_file_release: [], waiting_dependency: [] },
            };
      },
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [{
        agentId: 'code-a', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();
    await runtime.runOnce();
    await runtime.runOnce();

    expect(requests.filter((request) => request.method === 'POST' && request.path === '/reconcile')).toHaveLength(3);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(2);
  });
});

describe('Supervisor local lock', () => {
  it('stale lock can be safely replaced and an old owner cannot remove a newer lock', () => {
    const dir = createTempDir('biao-supervisor-lock-');
    const url = 'http://127.0.0.1:7991';
    const initial = tryAcquireLocalLock(url, dir);
    expect(initial.acquired).toBe(true);
    writeFileSync(initial.path, '99999999:dead-host:stale\n');
    const replacement = tryAcquireLocalLock(url, dir);
    expect(replacement.acquired).toBe(true);
    releaseLocalLock(initial);
    expect(existsSync(replacement.path)).toBe(true);
    releaseLocalLock(replacement);
    expect(existsSync(replacement.path)).toBe(false);
  });

  it('concurrent processes acquire the same local URL lock exactly once', async () => {
    const dir = createTempDir('biao-supervisor-race-');
    const url = 'http://127.0.0.1:7992';
    const contenders = Array.from({ length: 6 }, () => spawnLockContender(dir, url));
    try {
      await Promise.all(contenders.map((contender) => contender.ready));
      for (const contender of contenders) contender.child.stdin.write('go\n');
      const results = await Promise.all(contenders.map((contender) => contender.result));
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      await Promise.all(contenders.map((contender) => contender.exited));
    } finally {
      for (const contender of contenders) {
        if (!contender.child.killed) contender.child.kill('SIGTERM');
      }
    }
  }, 15_000);
});

describe('Supervisor CLI slot validation', () => {
  it('拒绝重复 agent ID，且在联网前失败', () => {
    const lockDir = createTempDir('biao-supervisor-cli-lock-');
    const script = join(import.meta.dirname, '..', 'scripts', 'supervisor.mjs');
    const result = spawnSync(process.execPath, [script, '--once', '--biao-url', 'http://127.0.0.1:1'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        BIAO_LOCK_DIR: lockDir,
        BIAO_WORKER_SLOTS: JSON.stringify([
          { kind: 'codex', agentId: 'same-agent', project: '/tmp/a' },
          { kind: 'kimi', agentId: 'same-agent', project: '/tmp/a' },
        ]),
      },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/重复.*agentId|agentId.*重复/);
  });
});
