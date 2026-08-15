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
  SharedWorkerCoordinator,
  releaseLocalLock,
  tryAcquireLocalLock,
  type SupervisorWorkerSlot,
} from '../src/worker/supervisor.js';
import type { ClaimedTask } from '../src/types/index.js';

interface RequestLog {
  method: string;
  path: string;
  body: string;
  authorization?: string;
}

interface BiaoLikeServerOptions {
  plans?: () => Array<Record<string, unknown>>;
  events?: () => unknown;
  intake?: (scope: { consumer: string; planId?: string }) => Record<string, unknown>;
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
    req.on('end', async () => {
      requests.push({
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
      });
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
        const consumer = url.searchParams.get('consumer') ?? '';
        const planId = url.searchParams.get('plan_id') ?? undefined;
        res.end(JSON.stringify({
          ok: true,
          data: options.intake?.({ consumer, planId }) ?? {
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
      if (url.pathname === '/lease/renew') {
        res.end(JSON.stringify({ ok: true, data: {} }));
        return;
      }
      if (url.pathname === '/agent/offline') {
        res.end(JSON.stringify({ ok: true, data: {} }));
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
        res.end(JSON.stringify({ ok: true, data: await options.claim?.(body) ?? null }));
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
  it('keeps Owner auth on Supervisor transport while in-process Workers use only scoped auth', async () => {
    const { url, requests } = await startBiaoLikeServer({ events: () => [] });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      apiToken: 'owner-secret',
      workerApiToken: 'worker-secret',
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

    expect(requests.find((request) => request.path === '/plans')?.authorization).toBe('Bearer owner-secret');
    for (const path of ['/register', '/heartbeat', '/claim']) {
      expect(requests.find((request) => request.path === path)?.authorization).toBe('Bearer worker-secret');
    }
  });

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

  it('一个共享 transport 轮次读取多个 PM consumer 队列并保留队列归属', async () => {
    const { url, requests } = await startBiaoLikeServer({
      intake: ({ consumer }) => ({
        consumer,
        cursor: consumer === 'pm-a' ? '100-1' : '100-2',
        counts: consumer === 'pm-a' ? { review_requested: 1 } : { question_asked: 1 },
        items: consumer === 'pm-a'
          ? [{ kind: 'review_requested', event_id: 'evt-review-a', task_id: 'task-a', plan_id: 'open-a', timestamp: 100 }]
          : [{ kind: 'question_asked', event_id: 'evt-question-b', task_id: 'task-b', plan_id: 'open-b', timestamp: 101 }],
      }),
      events: () => ({ events: [], next_cursor: '0-0' }),
    });
    const bells: Array<{ planId: string; consumer: string | undefined; kinds: string[] }> = [];
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      pmConsumers: ['pm-a', 'pm-b'],
      onPmDoorbell: async (planId, items) => {
        bells.push({ planId, consumer: items[0]?.consumer, kinds: items.map((item) => item.kind) });
      },
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    expect(requests.filter((request) => request.path === '/plans')).toHaveLength(1);
    expect(requests.filter((request) => request.path.startsWith('/events'))).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/reconcile')).toHaveLength(1);
    expect(requests.filter((request) => request.path.startsWith('/intake')).map((request) => request.path).sort()).toEqual([
      '/intake?consumer=pm-a',
      '/intake?consumer=pm-b',
    ]);
    expect(requests.some((request) => request.path.startsWith('/intake/ack'))).toBe(false);
    expect(bells).toEqual([
      { planId: 'open-a', consumer: 'pm-a', kinds: ['review_requested'] },
      { planId: 'open-b', consumer: 'pm-b', kinds: ['question_asked'] },
    ]);
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

  it('acceptance_ready immediately wakes the shared Worker scheduler', async () => {
    const { url } = await startBiaoLikeServer({
      events: () => ({
        events: [{
          event_id: 'evt-acceptance-ready', type: 'acceptance_ready', task_id: 'fresh-reverify',
          plan_id: 'open-a', consumer: 'pm-a', timestamp: 202,
        }],
        next_cursor: '202-0',
      }),
      intake: () => ({ consumer: 'pm-a', cursor: '202-0', counts: {}, items: [] }),
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [{
        agentId: 'acceptance-a', agentType: 'test', preferredProject: '/tmp/a',
        capabilities: ['acceptance'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();

    expect(runtime.workerWakeCount()).toBe(1);
  });

  it('two identity-scoped idle slots each claim once and emit one presence heartbeat per shared refresh', async () => {
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
    expect(claims.map((request) => JSON.parse(request.body))).toEqual([
      expect.objectContaining({ agent_id: 'review-a', preferred_project: '/tmp/a', preferred_types: ['review'] }),
      expect.objectContaining({ agent_id: 'review-b', preferred_project: '/tmp/a', preferred_types: ['review'] }),
    ]);
    const heartbeats = requests.filter((request) => request.path === '/heartbeat').map((request) => JSON.parse(request.body));
    expect(heartbeats).toEqual([
      { agent_id: 'review-a', registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/) },
      { agent_id: 'review-b', registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/) },
    ]);

    await runtime.runOnce();

    expect(requests.filter((request) => request.path === '/register')).toHaveLength(2);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(2);
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
    // 本轮从未注册过 slot，就不能拿随机的新 epoch 去 offline 服务端可能仍保留的
    // 历史 epoch；否则每次空转巡检都会产生 AGENT_REGISTRATION_CHANGED 噪声。
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);
  });

  it('plans_terminal 软停机后新活跃计划出现时，以全新 epoch 复活 slot 并继续领取（留守/重入）', async () => {
    // 真实存在的项目目录：result.md/result.json 需要写入成功，任务才能 done 而不是降级 failed。
    const project = createTempDir('stay-resident-revive');
    // 阶段推进：active（有任务）→ terminal（全部闭环软停机）→ revived（留守轮发现新计划）。
    let phase: 'active' | 'terminal' | 'revived' = 'active';
    const delivered = new Set<string>();
    const reportedTasks: string[] = [];
    const reportedStatuses = new Map<string, string>();
    const reportWaiters = new Map<string, () => void>();
    const reportReceived = (taskId: string) => new Promise<void>((resolve) => reportWaiters.set(taskId, resolve));
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => {
        const closed = {
          plan_id: 'p-first', status: 'completed', project_path: project,
          tasks: { pending: 0, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0 },
          reviews: { pending: 0, accepted: 1, rejected: 0 },
        };
        if (phase === 'active') {
          return [{
            plan_id: 'p-first', status: 'active', project_path: project,
            tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
            reviews: { pending: 0, accepted: 0, rejected: 0 },
          }];
        }
        if (phase === 'terminal') return [closed];
        return [
          closed,
          {
            plan_id: 'p-second', status: 'active', project_path: project,
            tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
            reviews: { pending: 0, accepted: 0, rejected: 0 },
          },
        ];
      },
      claim: () => {
        const taskId = phase === 'active' ? 'task-first' : phase === 'revived' ? 'task-second' : '';
        if (!taskId || delivered.has(taskId)) return null;
        delivered.add(taskId);
        return {
          task_id: taskId, title: taskId, type: 'code', phase: 'impl', priority: 5,
          ownership_files: [], goal_md: '', timeout_seconds: 60, claim_token: `token-${taskId}`,
          verify: [], project_path: project, plan_id: taskId === 'task-first' ? 'p-first' : 'p-second',
        };
      },
      report: (body) => {
        const taskId = String(body.task_id);
        reportedTasks.push(taskId);
        reportedStatuses.set(taskId, String(body.status));
        reportWaiters.get(taskId)?.();
        return { ok: true, data: {} };
      },
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [{
        agentId: 'stay-worker', agentType: 'test', preferredProject: project, capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 1_000,
    });

    // 第一阶段：正常领取并完成 task-first。
    expect(await runtime.runOnce()).toBe(true);
    await reportReceived('task-first');

    // 第二阶段：全部受管计划闭环 → plans_terminal 软停机（显式 offline 一次）。
    phase = 'terminal';
    expect(await runtime.runOnce()).toBe(false);
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(1);

    // 第三阶段：留守轮发现新活跃计划 → slot 以全新 registration epoch 复活并继续领取。
    phase = 'revived';
    expect(await runtime.runOnce()).toBe(true);
    await reportReceived('task-second');

    const registrations = requests
      .filter((request) => request.path === '/register')
      .map((request) => (JSON.parse(request.body) as Record<string, unknown>).registration_id as string);
    // 两次注册必须使用不同 epoch：旧 epoch 已显式 offline，服务端不复活它。
    expect(registrations).toHaveLength(2);
    expect(registrations[0]).not.toEqual(registrations[1]);
    expect(reportedTasks).toEqual(['task-first', 'task-second']);
    // 复活前后都走真实交付路径（done），不是降级 failed report。
    expect(reportedStatuses.get('task-first')).toBe('done');
    expect(reportedStatuses.get('task-second')).toBe('done');
    // 软停机只发生一次；复活后未再次 offline。
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(1);
  });

  it('maxConcurrentTasks 限制同一轮实际启动的任务数，任务 settle 后下一轮补位', async () => {
    const project = createTempDir('max-concurrent');
    const taskQueue = ['task-a', 'task-b'];
    const claimed: string[] = [];
    const reportedTasks: string[] = [];
    const reportWaiters = new Map<string, () => void>();
    const reportReceived = (taskId: string) => new Promise<void>((resolve) => reportWaiters.set(taskId, resolve));
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const startedTasks: string[] = [];
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [{
        plan_id: 'p-cap', status: 'active', project_path: project,
        tasks: { pending: taskQueue.length, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      claim: () => {
        const taskId = taskQueue.shift();
        if (!taskId || claimed.includes(taskId)) return null;
        claimed.push(taskId);
        return {
          task_id: taskId, title: taskId, type: 'code', phase: 'impl', priority: 5,
          ownership_files: [], goal_md: '', timeout_seconds: 60, claim_token: `token-${taskId}`,
          verify: [], project_path: project, plan_id: 'p-cap',
        };
      },
      report: (body) => {
        const taskId = String(body.task_id);
        reportedTasks.push(taskId);
        reportWaiters.get(taskId)?.();
        return { ok: true, data: {} };
      },
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      maxConcurrentTasks: 1,
      workers: ['slot-a', 'slot-b'].map((slotId) => ({
        agentId: slotId, agentType: 'test', preferredProject: project, capabilities: ['code'],
        execute: async (task: ClaimedTask) => {
          startedTasks.push(task.task_id);
          if (task.task_id === 'task-a') await firstMayFinish;
          return {
            run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
            changedFiles: [], backend: 'test', model: 'test',
          };
        },
      })),
      pollIntervalMs: 1_000,
    });

    // 第一轮：并发闸 = 1，只允许一个 slot 领取；第二个任务不被领取。
    expect(await runtime.runOnce()).toBe(true);
    const startDeadline = Date.now() + 20_000;
    while (startedTasks.length < 1 && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(startedTasks).toEqual(['task-a']);
    expect(claimed).toEqual(['task-a']);

    // 放行第一个任务；settle 触发 wake，下一轮补位领取第二个任务。
    releaseFirst();
    await reportReceived('task-a');
    expect(await runtime.runOnce()).toBe(true);
    await reportReceived('task-b');

    expect(startedTasks.sort()).toEqual(['task-a', 'task-b']);
    expect(reportedTasks.sort()).toEqual(['task-a', 'task-b']);
  });

  it('signal abort explicitly takes every configured shared Worker offline', async () => {
    const controller = new AbortController();
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [{
        plan_id: 'signal-plan', status: 'active', project_path: '/tmp/a',
        tasks: { pending: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      signal: controller.signal,
      workers: [{
        agentId: 'signal-worker', agentType: 'test', preferredProject: '/tmp/a', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
      pollIntervalMs: 60_000,
    });

    const running = runtime.run();
    while (!requests.some((request) => request.path === '/heartbeat')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await running;

    const offline = requests.filter((request) => request.path === '/agent/offline');
    expect(offline).toHaveLength(1);
    expect(JSON.parse(offline[0].body)).toEqual({
      agent_id: 'signal-worker',
      registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/),
      reason: 'supervisor_signal',
    });
  });

  it('signal abort 等待全部运行 slot settle 后才最终 offline，不先伪装退出', async () => {
    const controller = new AbortController();
    const projectPath = createTempDir('biao-supervisor-await-slot-');
    let claimed = false;
    let executionStarted!: () => void;
    let closeExecution!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const executionClosed = new Promise<void>((resolve) => { closeExecution = resolve; });
    const task: ClaimedTask = {
      ...sampleTask(), task_id: 'await-slot-task', project_path: projectPath, timeout_seconds: 20,
    };
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [{
        plan_id: 'open-a', status: 'active', project_path: projectPath,
        tasks: { pending: claimed ? 0 : 1, running: claimed ? 1 : 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      claim: () => {
        if (claimed) return null;
        claimed = true;
        return task;
      },
      task: () => ({ ok: true, data: { status: 'running' } }),
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url, consumer: 'pm-a', signal: controller.signal, pollIntervalMs: 60_000,
      workers: [{
        agentId: 'await-slot-worker', agentType: 'test', preferredProject: projectPath, capabilities: ['code'],
        execute: async (_task, _project, signal) => {
          executionStarted();
          await new Promise<void>((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
          await executionClosed;
          return {
            run: { exitCode: 130, stdout: '', stderr: '', durationMs: 10, timedOut: false, aborted: true },
            changedFiles: [], backend: 'test', model: 'test',
          };
        },
      }],
    });

    const running = runtime.run();
    await started;
    controller.abort();
    let runtimeSettled = false;
    void running.then(() => { runtimeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(runtimeSettled).toBe(false);
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);
    closeExecution();
    await running;

    const offline = requests.filter((request) => request.path === '/agent/offline');
    expect(offline).toHaveLength(1);
    expect(JSON.parse(offline[0].body)).toEqual({
      agent_id: 'await-slot-worker',
      registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/),
      reason: 'supervisor_signal',
    });
    expect(requests.filter((request) => request.path === '/report')).toHaveLength(0);
  });

  it('signal abort stops renewing a still-running execution instead of hiding an immortal lease', async () => {
    const controller = new AbortController();
    const projectPath = createTempDir('biao-supervisor-abort-running-');
    let claimed = false;
    let releaseExecution!: () => void;
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => { executionStarted = resolve; });
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const task: ClaimedTask = {
      ...sampleTask(),
      task_id: 'abort-running-task',
      title: 'abort running task',
      project_path: projectPath,
      timeout_seconds: 1,
    };
    const { url, requests } = await startBiaoLikeServer({
      events: () => [],
      intake: () => ({ consumer: 'pm-a', cursor: '0-0', counts: {}, items: [] }),
      plans: () => [{
        plan_id: 'open-a', status: 'active', project_path: projectPath,
        tasks: { pending: claimed ? 0 : 1, running: claimed ? 1 : 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      claim: () => {
        if (claimed) return null;
        claimed = true;
        return task;
      },
      task: () => ({ ok: true, data: { status: 'running' } }),
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      signal: controller.signal,
      workers: [{
        agentId: 'abort-running-worker', agentType: 'test', preferredProject: projectPath, capabilities: ['code'],
        heartbeatMs: 1_000,
        execute: async () => {
          executionStarted();
          await executionGate;
          return {
            run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
            changedFiles: [], backend: 'test', model: 'test',
          };
        },
      }],
      pollIntervalMs: 60_000,
    });

    const running = runtime.run();
    await started;
    while (!requests.some((request) => request.path === '/lease/renew')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    const renewalsAtAbort = requests.filter((request) => request.path === '/lease/renew').length;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const renewalsAfterGrace = requests.filter((request) => request.path === '/lease/renew').length;
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);
    releaseExecution();
    await running;

    expect(renewalsAfterGrace).toBe(renewalsAtAbort);
    // abort 保留 running 指针，等真实执行 settle 后才只登记一次 offline；
    // 不把停止伪造成 done/failed report，由 lease 统一回收。
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(1);
    expect(requests.filter((request) => request.path === '/report')).toHaveLength(0);
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

  it('同项目同类型的 Kimi slot 不会被前一个 Codex 定向空 claim 饿死', async () => {
    const projectPath = createTempDir('biao-supervisor-kimi-affinity-');
    const kimiTask = { ...sampleTask(), task_id: 'kimi-only-task', project_path: projectPath, assignee: 'kimi' };
    const { url, requests } = await startBiaoLikeServer({
      events: () => ({ events: [], next_cursor: '0-0' }),
      plans: () => [{
        plan_id: 'open-a', status: 'active', project_path: projectPath,
        tasks: { pending: 1, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }],
      claim: (body) => body.agent_id === 'kimi-a' ? kimiTask : null,
    });
    const execute = async () => ({
      run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
      changedFiles: [], backend: 'test', model: 'test',
    });
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: url,
      consumer: 'pm-a',
      workers: [
        { agentId: 'codex-a', agentType: 'codex', preferredProject: projectPath, capabilities: ['code'], execute },
        { agentId: 'kimi-a', agentType: 'kimi', preferredProject: projectPath, capabilities: ['code'], execute },
      ],
      pollIntervalMs: 1_000,
    });

    await runtime.runOnce();
    // CI runner 被整套测试并行加载时，执行与上报可能远慢于 1 秒；只设宽松上限。
    const deadline = Date.now() + 20_000;
    while (!requests.some((request) => request.path === '/report') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const claims = requests.filter((request) => request.path === '/claim').map((request) => JSON.parse(request.body));
    expect(claims.map((claim) => claim.agent_id)).toEqual(['codex-a', 'kimi-a']);
    expect(requests.filter((request) => request.path === '/report').map((request) => JSON.parse(request.body))).toEqual([
      expect.objectContaining({ agent_id: 'kimi-a', task_id: 'kimi-only-task', status: 'done' }),
    ]);
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

describe('SharedWorkerCoordinator shutdown serialization', () => {
  it('延迟 claim 已在途时，等待调度和新启动的任务 settle 后才登记 offline', async () => {
    const projectPath = createTempDir('biao-supervisor-delayed-claim-');
    let releaseClaim!: () => void;
    let notifyClaimStarted!: () => void;
    let releaseExecution!: () => void;
    let notifyExecutionStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => { notifyClaimStarted = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const executionStarted = new Promise<void>((resolve) => { notifyExecutionStarted = resolve; });
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const { url, requests } = await startBiaoLikeServer({
      claim: async () => {
        notifyClaimStarted();
        await claimGate;
        return { ...sampleTask(), task_id: 'delayed-claim-task', project_path: projectPath };
      },
      task: () => ({ ok: true, data: { status: 'running', claimed_by: 'delayed-worker' } }),
    });
    const coordinator = new SharedWorkerCoordinator({
      biaoUrl: url,
      slots: [{
        agentId: 'delayed-worker', agentType: 'test', preferredProject: projectPath, capabilities: ['code'],
        execute: async () => {
          notifyExecutionStarted();
          await executionGate;
          return {
            run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
            changedFiles: [], backend: 'test', model: 'test',
          };
        },
      }],
    });

    const scheduling = coordinator.scheduleIfRequested();
    await claimStarted;
    let stopped = false;
    const stopping = coordinator.offlineAll('supervisor_exit').then(() => { stopped = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(stopped).toBe(false);
      expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);

      releaseClaim();
      await executionStarted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stopped).toBe(false);
      expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);

      releaseExecution();
      await Promise.all([scheduling, stopping]);
      const reportIndex = requests.findIndex((request) => request.path === '/report');
      const offlineIndex = requests.findIndex((request) => request.path === '/agent/offline');
      expect(reportIndex).toBeGreaterThanOrEqual(0);
      expect(offlineIndex).toBeGreaterThan(reportIndex);
      expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(1);
    } finally {
      // 回归再次出现时也释放测试门闩，避免残留 HTTP 请求拖死 afterEach。
      releaseClaim();
      releaseExecution();
      await Promise.allSettled([scheduling, stopping]);
    }
  });

  it('并发 offlineAll 共享同一个关停过程，每个 slot 只登记一次', async () => {
    const { url, requests } = await startBiaoLikeServer();
    const coordinator = new SharedWorkerCoordinator({
      biaoUrl: url,
      slots: [{
        agentId: 'single-offline-worker', agentType: 'test', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
    });

    await coordinator.refreshIdlePresence();
    await Promise.all([
      coordinator.offlineAll('supervisor_signal'),
      coordinator.offlineAll('supervisor_exit'),
    ]);

    expect(requests.filter((request) => request.path === '/register')).toHaveLength(1);
    const offline = requests.filter((request) => request.path === '/agent/offline');
    expect(offline).toHaveLength(1);
    expect(JSON.parse(offline[0].body)).toEqual({
      agent_id: 'single-offline-worker',
      registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/),
      reason: 'supervisor_signal',
    });
  });

  it('关停完成后 wake 不再触发注册或新 claim', async () => {
    const wakeSignals: string[] = [];
    const { url, requests } = await startBiaoLikeServer();
    const coordinator = new SharedWorkerCoordinator({
      biaoUrl: url,
      onWake: () => wakeSignals.push('wake'),
      slots: [{
        agentId: 'stopped-worker', agentType: 'test', capabilities: ['code'],
        execute: async () => ({
          run: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        }),
      }],
    });

    await coordinator.offlineAll('supervisor_exit');
    coordinator.wake();
    await coordinator.scheduleIfRequested();

    expect(wakeSignals).toEqual([]);
    expect(requests.filter((request) => request.path === '/agent/offline')).toHaveLength(0);
    expect(requests.filter((request) => request.path === '/register')).toHaveLength(0);
    expect(requests.filter((request) => request.path === '/claim')).toHaveLength(0);
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

  it('拒绝重复 PM consumer，避免两个槽位并发争抢同一待办身份', () => {
    const lockDir = createTempDir('biao-supervisor-pm-slot-lock-');
    const script = join(import.meta.dirname, '..', 'scripts', 'supervisor.mjs');
    const result = spawnSync(process.execPath, [script, '--once', '--biao-url', 'http://127.0.0.1:1'], {
      cwd: join(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        BIAO_LOCK_DIR: lockDir,
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_SLOTS: JSON.stringify([
          { id: 'pm-a', consumer: 'shared-consumer', command: process.execPath },
          { id: 'pm-b', consumer: 'shared-consumer', command: process.execPath },
        ]),
      },
    });

    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/consumer.*重复/);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('ECONNREFUSED');
  });

  it('custom slot 默认以 custom agent_type 注册，并允许显式安全 agentType', async () => {
    const { url, requests } = await startBiaoLikeServer({
      intake: ({ consumer }) => ({ consumer, cursor: '0-0', counts: {}, items: [] }),
      events: () => ({ events: [], next_cursor: '0-0' }),
    });
    const lockDir = createTempDir('biao-supervisor-custom-slot-');
    const script = join(import.meta.dirname, '..', 'scripts', 'supervisor.mjs');
    const child = spawn(process.execPath, [script, '--once', '--biao-url', url], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        BIAO_LOCK_DIR: lockDir,
        BIAO_PM_SLOTS: '',
        BIAO_PM_AGENT_ROUTES: '',
        BIAO_PM_AGENT_CMD: '',
        BIAO_WORKER_SLOTS: JSON.stringify([
          { kind: 'custom', agentId: 'unknown-agent', project: '/tmp/a', command: process.execPath },
          { kind: 'cli', agentId: 'named-agent', agentType: 'external-hht', project: '/tmp/b', command: process.execPath },
        ]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(requests.filter((request) => request.path === '/register').map((request) => {
      const body = JSON.parse(request.body) as { agent_id: string; agent_type: string };
      return { agentId: body.agent_id, agentType: body.agent_type };
    })).toEqual([
      { agentId: 'unknown-agent', agentType: 'custom' },
      { agentId: 'named-agent', agentType: 'external-hht' },
    ]);
  });
});
