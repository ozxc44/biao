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
      const items = (options.alwaysPending || intakeReads <= 2)
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

async function runSupervisor(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [supervisorScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时：${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsAlive(pid);
}

describe('Supervisor CLI integrated PM Agent doorbell', () => {
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
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(3);
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
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(3);
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
    expect(result.stderr).toContain('下个共享轮次重试');
    expect(paths.filter((path) => path.startsWith('GET /intake'))).toHaveLength(3);
    expect(paths.some((path) => /ack|review|answer/.test(path))).toBe(false);
  });

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
