/**
 * 真实 Supervisor CLI → 一次性 PM Agent 门铃闭环。
 * 验证 PM/Worker 共用一个 Supervisor 轮询进程，而不是再要求 cron/launchd 盯盘。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const supervisorScript = join(repoRoot, 'scripts', 'supervisor.mjs');
const cliScript = join(repoRoot, 'src', 'cli', 'index.ts');
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-supervisor-pm-agent-'));
  tempDirs.push(dir);
  return dir;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

async function startServer(options: { alwaysPending?: boolean; planStatus?: string } = {}): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  let intakeReads = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    paths.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/plans') {
      res.end(JSON.stringify({ ok: true, data: { total: 1, plans: [{
        plan_id: 'open-plan', status: options.planStatus ?? 'active', project_path: '/tmp/project',
        tasks: { pending: 0, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0 },
        reviews: { pending: 1, accepted: 0, rejected: 0 },
      }] } }));
      return;
    }
    if (url.pathname === '/intake') {
      intakeReads++;
      const items = (options.alwaysPending || intakeReads <= 3)
        ? [{ kind: 'review_requested', plan_id: 'open-plan', task_id: 'task-1', event_id: 'event-1' }]
        : [];
      res.end(JSON.stringify({ ok: true, data: { consumer: 'pm-a', cursor: '1-0', items } }));
      return;
    }
    if (url.pathname === '/events') {
      res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '1-0' } }));
      return;
    }
    if (url.pathname === '/reconcile' && req.method === 'POST') {
      res.end(JSON.stringify({
        ok: true,
        data: {
          reclaimed: [],
          failed: [],
          requeued: { waiting_file_release: [], waiting_dependency: [] },
        },
      }));
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, data: { registered: true } }));
      return;
    }
    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, data: { status: 'idle' } }));
      return;
    }
    if (url.pathname === '/claim' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, data: null }));
      return;
    }
    if (url.pathname === '/agent/offline' && req.method === 'POST') {
      res.end(JSON.stringify({ ok: true, data: { offline: true } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

async function startResolutionServer(): Promise<{
  url: string;
  paths: string[];
  decisions: Array<Record<string, unknown>>;
}> {
  const paths: string[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  let pending = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    paths.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/plans') {
      res.end(JSON.stringify({ ok: true, data: { total: 1, plans: [{
        plan_id: 'open-plan', status: 'active', project_path: '/tmp/project',
        tasks: { pending: 0, running: 0, blocked: 0, done: 0, failed: 1, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }] } }));
      return;
    }
    if (url.pathname === '/intake') {
      const items = pending
        ? [{ kind: 'resolution_required', plan_id: 'open-plan', task_id: 'source-task', event_id: 'resolution-event' }]
        : [];
      res.end(JSON.stringify({ ok: true, data: { consumer: 'pm-a', cursor: '1-0', items } }));
      return;
    }
    if (url.pathname === '/events') {
      res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '1-0' } }));
      return;
    }
    if (url.pathname === '/reconcile' && req.method === 'POST') {
      res.end(JSON.stringify({
        ok: true,
        data: { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } },
      }));
      return;
    }
    if (url.pathname === '/task/source-task/resolution' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      decisions.push(body);
      if (body.action === 'cancel' && body.decided_by === 'pm-resolution') pending = false;
      res.end(JSON.stringify({
        ok: true,
        data: {
          requested_task_id: 'source-task', root_task_id: 'source-task', state: 'cancelled', action: 'cancel',
          reason: 'repair_retry_limit_reached', latest_repair_id: 'source-task-repair-1',
          resolution_lineage: ['source-task-repair-1'], attempts: 1, max_retries: 1,
          available_actions: ['inspect'],
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock resolution server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, paths, decisions };
}

async function startPmPoolServer(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const intakeReads = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    paths.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/plans') {
      res.end(JSON.stringify({ ok: true, data: { total: 2, plans: [{
        plan_id: 'open-plan', status: 'active', project_path: '/tmp/project',
        tasks: { pending: 0, running: 0, blocked: 1, done: 1, failed: 0, cancelled: 0 },
        reviews: { pending: 1, accepted: 0, rejected: 0 },
      }, {
        plan_id: 'question-plan', status: 'active', project_path: '/tmp/question-project',
        tasks: { pending: 0, running: 0, blocked: 1, done: 1, failed: 0, cancelled: 0 },
        reviews: { pending: 0, accepted: 0, rejected: 0 },
      }] } }));
      return;
    }
    if (url.pathname === '/intake') {
      const consumer = url.searchParams.get('consumer') ?? '';
      const requestedPlan = url.searchParams.get('plan_id');
      const reads = (intakeReads.get(`${consumer}\u0000${requestedPlan ?? '*'}`) ?? 0) + 1;
      intakeReads.set(`${consumer}\u0000${requestedPlan ?? '*'}`, reads);
      const item = consumer === 'pm-review'
        ? { kind: 'review_requested', plan_id: 'open-plan', task_id: 'task-review', event_id: 'event-review' }
        : consumer === 'pm-question'
          ? { kind: 'question_asked', plan_id: 'question-plan', task_id: 'task-question', event_id: 'event-question', question_id: 'question-1' }
          : undefined;
      const matchesRequestedPlan = !requestedPlan || requestedPlan === item?.plan_id;
      // Supervisor 的共享快照会按 plan 带 plan_id 读取；PM Agent 自己则读取对应
      // consumer 的完整 intake 三次（初读、二次确认、require-drained 复核）。
      const visible = item && matchesRequestedPlan && (requestedPlan ? true : reads <= 2) ? [item] : [];
      res.end(JSON.stringify({
        ok: true,
        data: { consumer, cursor: `${reads}-0`, items: visible },
      }));
      return;
    }
    if (url.pathname === '/events') {
      res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '1-0' } }));
      return;
    }
    if (url.pathname === '/reconcile' && req.method === 'POST') {
      res.end(JSON.stringify({
        ok: true,
        data: { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock PM pool server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

async function runSupervisor(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [supervisorScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, BIAO_PM_SLOTS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时：${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Linux 已被 SIGKILL 的孤儿进程可能短暂显示为 zombie，直到 init 回收。
  // 它不能执行、写入或继续占用 Agent 生命周期，应视为已停止。
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 1).trimStart().startsWith('Z');
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsAlive(pid);
}

describe('Supervisor CLI integrated PM Agent doorbell', () => {
  it('按 Plan 路由到对应 PM 适配器，并把目标会话作为最小本机环境传入', async () => {
    const { url } = await startServer();
    const dir = tempDir();
    const capture = join(dir, 'route-capture.mjs');
    const output = join(dir, 'route-payload.json');
    writeFileSync(capture, `
      import { readFileSync, writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], JSON.stringify({
        target: process.env.BIAO_PM_TARGET,
        payload: JSON.parse(readFileSync(0, 'utf8')),
      }), 'utf8');
    `, 'utf8');
    const command = [process.execPath, capture, output].map(shellQuote).join(' ');

    const result = await runSupervisor([
      '--once', '--biao-url', url, '--consumer', 'pm-a', '--plans', 'open-plan',
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
      BIAO_PM_AGENT_ROUTES: JSON.stringify({
        'open-plan': { command, target: '019ffe19-fc41-7c53-bb7d-4746b1ae583f' },
      }),
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      target: '019ffe19-fc41-7c53-bb7d-4746b1ae583f',
      payload: {
        biaoUrl: url,
        consumer: 'pm-a',
        planIds: ['open-plan'],
        kinds: { review_requested: 1 },
        count: 1,
      },
    });
  });

  it('一个 Supervisor 并行唤醒两个独立 plan/consumer 的 PM slot，并按 plan/kind 精确筛选', async () => {
    const { url, paths } = await startPmPoolServer();
    const dir = tempDir();
    const adapter = join(dir, 'pool-adapter.mjs');
    const reviewStarted = join(dir, 'review.started');
    const questionStarted = join(dir, 'question.started');
    const reviewOutput = join(dir, 'review.json');
    const questionOutput = join(dir, 'question.json');
    writeFileSync(adapter, `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const [started, peerStarted, output] = process.argv.slice(2);
      writeFileSync(started, 'started', 'utf8');
      // CI runner 在整套测试并行时可能严重饥饿，两个 PM slot 的启动间隔需容忍慢机。
      const deadline = Date.now() + 30_000;
      while (!existsSync(peerStarted) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!existsSync(peerStarted)) process.exit(9);
      writeFileSync(output, JSON.stringify({
        target: process.env.BIAO_PM_TARGET,
        payload: JSON.parse(readFileSync(0, 'utf8')),
      }), 'utf8');
    `, 'utf8');
    const reviewCommand = [process.execPath, adapter, reviewStarted, questionStarted, reviewOutput].map(shellQuote).join(' ');
    const questionCommand = [process.execPath, adapter, questionStarted, reviewStarted, questionOutput].map(shellQuote).join(' ');

    const result = await runSupervisor([
      '--once', '--biao-url', url, '--plans', 'open-plan,question-plan',
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
      BIAO_PM_AGENT_ROUTES: '',
      BIAO_PM_SLOTS: JSON.stringify([
        {
          id: 'review-pm', consumer: 'pm-review', plans: ['open-plan'], kinds: ['review_requested'],
          command: reviewCommand, target: 'review-session',
        },
        {
          id: 'question-pm', consumer: 'pm-question', plans: ['question-plan'], kinds: ['question_asked'],
          command: questionCommand, target: 'question-session',
        },
      ]),
    });

    expect(result.code, `Supervisor stdout:\n${result.stdout}\nSupervisor stderr:\n${result.stderr}\nRequests:\n${paths.join('\n')}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(readFileSync(reviewOutput, 'utf8'))).toEqual({
      target: 'review-session',
      payload: {
        biaoUrl: url,
        consumer: 'pm-review',
        planIds: ['open-plan'],
        kinds: { review_requested: 1 },
        count: 1,
      },
    });
    expect(JSON.parse(readFileSync(questionOutput, 'utf8'))).toEqual({
      target: 'question-session',
      payload: {
        biaoUrl: url,
        consumer: 'pm-question',
        planIds: ['question-plan'],
        kinds: { question_asked: 1 },
        count: 1,
      },
    });
    expect(paths.filter((path) => path.includes('/intake?consumer=pm-review'))).toHaveLength(5);
    expect(paths.filter((path) => path.includes('/intake?consumer=pm-question'))).toHaveLength(5);
    expect(paths.some((path) => /\/intake\/ack|\/review(?:\/|\?|$)|\/answer(?:\/|\?|$)/.test(path))).toBe(false);
  }, 45_000);

  it('PM Agent 用 resolution cancel 完成决策后，require-drained 真实清空门铃', async () => {
    const { url, paths, decisions } = await startResolutionServer();
    const dir = tempDir();
    const agent = join(dir, 'resolution-agent.mjs');
    writeFileSync(agent, `
      import { spawnSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      readFileSync(0, 'utf8');
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', ${JSON.stringify(cliScript)},
        'task', 'resolution', 'source-task', '--action', 'cancel', '--decided-by', 'pm-resolution',
      ], {
        cwd: ${JSON.stringify(repoRoot)},
        env: { ...process.env, BIAO_URL: process.argv[2], BIAO_AGENT_ID: 'pm-resolution' },
        stdio: 'inherit',
      });
      process.exit(result.status ?? 1);
    `, 'utf8');
    const command = [process.execPath, agent, url].map(shellQuote).join(' ');

    const result = await runSupervisor([
      '--once', '--biao-url', url, '--consumer', 'pm-a', '--plans', 'open-plan',
      '--pm-agent-command', command,
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(decisions).toEqual([{ action: 'cancel', decided_by: 'pm-resolution' }]);
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(4);
    expect(paths).toContain('POST /task/source-task/resolution');
  });

  it('同一共享轮次只唤醒一次 PM Agent，确认已处理后不做任何自动处置', async () => {
    const { url, paths } = await startServer();
    const dir = tempDir();
    const capture = join(dir, 'capture.mjs');
    const output = join(dir, 'payload.json');
    writeFileSync(capture, `
      import { readFileSync, writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], readFileSync(0, 'utf8'), 'utf8');
    `, 'utf8');
    const command = [process.execPath, capture, output].map(shellQuote).join(' ');

    const result = await runSupervisor([
      '--once', '--biao-url', url, '--consumer', 'pm-a', '--plans', 'open-plan',
      '--pm-agent-command', command,
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: ['open-plan'],
      kinds: { review_requested: 1 },
      count: 1,
    });
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(4);
    expect(paths.some((path) => /ack|review|answer/.test(path))).toBe(false);
  });

  it('once 模式发现 PM Agent 未处理待办时返回非零，不能把启动成功冒充闭环', async () => {
    const { url, paths } = await startServer({ alwaysPending: true });
    const dir = tempDir();
    const capture = join(dir, 'capture.mjs');
    const output = join(dir, 'payload.json');
    writeFileSync(capture, `
      import { readFileSync, writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], readFileSync(0, 'utf8'), 'utf8');
    `, 'utf8');
    const command = [process.execPath, capture, output].map(shellQuote).join(' ');

    const result = await runSupervisor([
      '--once', '--biao-url', url, '--consumer', 'pm-a', '--plans', 'open-plan',
      '--pm-agent-command', command,
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
    });

    expect(existsSync(output)).toBe(true);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('wake_no_progress');
    expect(result.stderr).toContain('主动重试');
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(4);
    expect(paths.some((path) => /ack|review|answer/.test(path))).toBe(false);
  });

  it('常驻模式对同一未清空门铃冷却，不能每个共享轮次重复唤醒 PM', async () => {
    const { url } = await startServer({ alwaysPending: true });
    const dir = tempDir();
    const adapter = join(dir, 'cooldown-agent.mjs');
    const launches = join(dir, 'launches.txt');
    writeFileSync(adapter, `
      import { appendFileSync, readFileSync } from 'node:fs';
      readFileSync(0, 'utf8');
      appendFileSync(process.argv[2], 'launch\\n', 'utf8');
    `, 'utf8');
    const command = [process.execPath, adapter, launches].map(shellQuote).join(' ');
    const child = spawn(process.execPath, [
      supervisorScript,
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'open-plan',
      '--interval', '10',
      '--pm-agent-command', command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BIAO_LOCK_DIR: dir,
        BIAO_PM_AGENT_LOCK_DIR: dir,
        BIAO_API_TOKEN: '',
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_AGENT_CMD: '',
        BIAO_PM_RETRY_COOLDOWN_MS: '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });

    try {
      await waitForFile(launches);
      // 跨过至少一个 10s 共享轮次；旧实现会在这里启动第二个 PM。
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      expect(readFileSync(launches, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }, 15_000);

  it('常驻模式遇到 PM 无进展时短退避主动重试，不受一小时普通失败冷却阻塞', async () => {
    const { url } = await startServer({ alwaysPending: true });
    const dir = tempDir();
    const adapter = join(dir, 'no-progress-agent.mjs');
    const launches = join(dir, 'launches.txt');
    writeFileSync(adapter, `
      import { appendFileSync, readFileSync } from 'node:fs';
      readFileSync(0, 'utf8');
      appendFileSync(process.argv[2], 'launch\\n', 'utf8');
    `, 'utf8');
    const command = [process.execPath, adapter, launches].map(shellQuote).join(' ');
    const child = spawn(process.execPath, [
      supervisorScript,
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'open-plan',
      '--interval', '10',
      '--pm-agent-command', command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BIAO_LOCK_DIR: dir,
        BIAO_PM_AGENT_LOCK_DIR: dir,
        BIAO_API_TOKEN: '',
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_AGENT_CMD: '',
        BIAO_PM_RETRY_COOLDOWN_MS: '3600000',
        BIAO_PM_NO_PROGRESS_RETRY_MS: '100',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });

    try {
      await waitForFile(launches);
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      expect(readFileSync(launches, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }, 15_000);

  it('常驻 PM Agent 长时间运行时不阻塞共享 Supervisor 的后续轮询', async () => {
    const { url, paths } = await startServer({ alwaysPending: true });
    const dir = tempDir();
    const adapter = join(dir, 'blocking-pm-agent.mjs');
    const started = join(dir, 'started.txt');
    const workerSlots = join(dir, 'worker-slots.json');
    writeFileSync(workerSlots, JSON.stringify([{
      kind: 'custom', agentId: 'idle-worker', agentType: 'custom', command: 'true',
    }]), 'utf8');
    writeFileSync(adapter, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], 'started', 'utf8');
      setTimeout(() => process.exit(0), 12000);
    `, 'utf8');
    const command = [process.execPath, adapter, started].map(shellQuote).join(' ');
    const child = spawn(process.execPath, [
      supervisorScript,
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'open-plan',
      '--interval', '10',
      '--pm-agent-command', command,
      '--worker-slots', workerSlots,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BIAO_LOCK_DIR: dir,
        BIAO_PM_AGENT_LOCK_DIR: dir,
        BIAO_API_TOKEN: '',
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_AGENT_CMD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });

    try {
      await waitForFile(started);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(paths.some((path) => path === 'POST /register')).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  }, 15_000);

  it.each([
    { signal: 'SIGINT' as const, exitCode: 130 },
    { signal: 'SIGTERM' as const, exitCode: 143 },
  ])('$signal 中断正在运行的 PM Agent 时规范退出、不误报闭环且不残留 Agent 子进程', async ({ signal, exitCode }) => {
    const { url } = await startServer({ alwaysPending: true });
    const dir = tempDir();
    const capture = join(dir, 'blocking-agent.mjs');
    const started = join(dir, 'started.json');
    writeFileSync(capture, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const grandchild = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(process.argv[2], JSON.stringify({ agentPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');
      setTimeout(() => process.exit(0), 1200);
      setInterval(() => {}, 1000);
    `, 'utf8');
    const command = [process.execPath, capture, started].map(shellQuote).join(' ');
    const child = spawn(process.execPath, [
      supervisorScript,
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'open-plan',
      '--interval', '10',
      '--pm-agent-command', command,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BIAO_LOCK_DIR: dir,
        BIAO_PM_AGENT_LOCK_DIR: dir,
        BIAO_API_TOKEN: '',
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_AGENT_CMD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let pids: { agentPid: number; grandchildPid: number } | undefined;

    try {
      await waitForFile(started);
      pids = JSON.parse(readFileSync(started, 'utf8')) as { agentPid: number; grandchildPid: number };
      child.kill(signal);
      const result = await closed;
      const agentStopped = await waitForProcessExit(pids.agentPid);
      const grandchildStopped = await waitForProcessExit(pids.grandchildPid);

      expect.soft(result).toEqual({ code: exitCode, signal: null });
      expect.soft(stdout).not.toContain('所有受管项目已完成并验收');
      expect.soft(stderr).toContain(signal);
      expect.soft(agentStopped).toBe(true);
      expect.soft(grandchildStopped).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (const pid of pids ? [pids.agentPid, pids.grandchildPid] : []) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
    }
  }, 10_000);

  it('显式 plan 过滤未命中时不得把空集合误报为全部完成', async () => {
    const { url } = await startServer();
    const dir = tempDir();

    const result = await runSupervisor([
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'missing-plan',
      '--interval', '10',
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('所有受管项目已完成并验收');
    expect(result.stderr).toContain('missing-plan');
  });

  it('显式受管 plan 有终态证据时才输出闭环完成并正常退出', async () => {
    const { url, paths } = await startServer({ planStatus: 'completed' });
    const dir = tempDir();

    const result = await runSupervisor([
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'open-plan',
      '--interval', '10',
    ], {
      BIAO_LOCK_DIR: dir,
      BIAO_PM_AGENT_LOCK_DIR: dir,
      BIAO_API_TOKEN: '',
      BIAO_WORKER_SLOTS: '',
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('所有受管项目已完成并验收');
    expect(result.stderr).toBe('');
    expect(paths.filter((path) => path === 'GET /plans')).toHaveLength(2);
  });
});
