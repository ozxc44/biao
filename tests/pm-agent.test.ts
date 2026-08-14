/**
 * PM Agent 唤醒器：平台只提供最小 intake，外部 Agent 仅在有事项时由显式命令启动。
 * 本文件故意通过真实子进程验证 stdin/env/本机锁边界，避免把“没有自动 ack”测成 mock 假象。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = join(import.meta.dirname, '..', 'scripts', 'pm-agent.mjs');
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function lockKeyForTest(biaoUrl: string, consumer: string): string {
  const parsed = new URL(biaoUrl);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const endpoint = `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
  return createHash('sha256').update(`${endpoint}\u0000${consumer}`).digest('hex').slice(0, 24);
}

function captureCommand(outputPath: string, opts: { startPath?: string; releasePath?: string } = {}): string {
  const dir = createTempDir('biao-pm-agent-child-');
  const child = join(dir, 'capture.mjs');
  writeFileSync(child, `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    const [outputPath, startPath, releasePath] = process.argv.slice(2);
    const record = {
      stdin: readFileSync(0, 'utf8').trim(),
      apiToken: process.env.BIAO_API_TOKEN ?? null,
      fetchDetails: process.env.BIAO_PM_AGENT_FETCH_DETAILS ?? null,
      ack: process.env.BIAO_PM_AGENT_ACK ?? null,
      automation: process.env.BIAO_PM_AGENT_AUTOMATION ?? null,
      runtimeDir: process.env.BIAO_RUNTIME_DIR ?? null,
      preferredProject: process.env.BIAO_PREFERRED_PROJECT ?? null,
      workspaceRoots: process.env.BIAO_WORKSPACE_ROOTS ?? null,
    };
    appendFileSync(outputPath, JSON.stringify(record) + '\\n');
    if (startPath) writeFileSync(startPath, 'started');
    while (releasePath && !existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  `, 'utf8');
  return [process.execPath, child, outputPath, opts.startPath ?? '', opts.releasePath ?? ''].map(shellQuote).join(' ');
}

function captureFirstInvocationCommand(outputPath: string, startPath: string, releasePath: string): string {
  const dir = createTempDir('biao-pm-agent-first-child-');
  const child = join(dir, 'capture-first.mjs');
  writeFileSync(child, `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    const [outputPath, startPath, releasePath] = process.argv.slice(2);
    const first = !existsSync(outputPath);
    appendFileSync(outputPath, readFileSync(0, 'utf8').trim() + '\\n');
    if (first) {
      writeFileSync(startPath, 'started');
      while (!existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
  `, 'utf8');
  return [process.execPath, child, outputPath, startPath, releasePath].map(shellQuote).join(' ');
}

async function runForgedInternalHandoff(
  args: string[],
  env: NodeJS.ProcessEnv,
  nonce: string,
): Promise<{ code: number | null; stdout: string; stderr: string; acknowledgement: string }> {
  const child = spawn(process.execPath, [script, '--biao-internal-kernel-lock', nonce, ...args], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ...env, BIAO_PM_AGENT_KERNEL_LOCK_NONCE: nonce },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let acknowledgement = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdio[4].setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdio[4].on('data', (chunk) => { acknowledgement += chunk; });
  child.stdin.end();
  child.stdio[3].end(`${nonce}\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr, acknowledgement: acknowledgement.trim() };
}

function blockLockHolderOnceCommand(outputPath: string, crashMarkerPath: string): string {
  const dir = createTempDir('biao-pm-agent-crash-child-');
  const child = join(dir, 'block-parent-once.mjs');
  writeFileSync(child, `#!/usr/bin/env node
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(outputPath)}, readFileSync(0, 'utf8').trim() + '\\n');
    if (!existsSync(${JSON.stringify(crashMarkerPath)})) {
      writeFileSync(${JSON.stringify(crashMarkerPath)}, String(process.pid));
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
  `, { mode: 0o755 });
  chmodSync(child, 0o755);
  return child;
}

function hangingProcessTreeCommand(parentPidPath: string, childPidPath: string): string {
  const dir = createTempDir('biao-pm-agent-timeout-child-');
  const child = join(dir, 'hang-with-child.mjs');
  writeFileSync(child, `#!/usr/bin/env node
    import { spawn } from 'node:child_process';
    import { readFileSync, writeFileSync } from 'node:fs';
    readFileSync(0, 'utf8');
    writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    writeFileSync(${JSON.stringify(childPidPath)}, String(grandchild.pid));
    setInterval(() => {}, 1000);
  `, { mode: 0o755 });
  chmodSync(child, 0o755);
  return child;
}

async function startIntakeServer(items: unknown[]): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    paths.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/intake') {
      res.end(JSON.stringify({ ok: true, data: { consumer: 'pm-a', cursor: '1-0', items } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock intake server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, paths };
}

async function runWaker(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const result = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(result.code ?? 1), stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待文件超时：${path}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`进程 ${pid} 在超时后仍存活`);
}

function readRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('PM Agent one-shot waker', () => {
  it('无事项时安静成功且绝不启动 child', async () => {
    const { url, paths } = await startIntakeServer([]);
    const dir = createTempDir('biao-pm-agent-empty-');
    const output = join(dir, 'child.jsonl');
    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
      BIAO_API_TOKEN: 'platform-token-must-not-be-printed',
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readRecords(output)).toEqual([]);
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
  });

  it('只有 pending acceptance_ready 时保留平台可见性，但不启动 PM 模型', async () => {
    const { url, paths } = await startIntakeServer([
      { kind: 'acceptance_ready', plan_id: 'p1', task_id: 'acceptance-pending', event_id: 'ready-1' },
    ]);
    const dir = createTempDir('biao-pm-agent-acceptance-ready-');
    const output = join(dir, 'child.jsonl');

    const result = await runWaker(['--once', '--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
    });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readRecords(output)).toEqual([]);
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
  });

  it('首次扫描后事项已被其他 PM 消解时，启动模型前二次确认并静默退出', async () => {
    const paths: string[] = [];
    let reads = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      paths.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
      res.setHeader('content-type', 'application/json');
      reads++;
      const items = reads === 1
        ? [{ kind: 'review_requested', plan_id: 'p1', task_id: 'task-1', event_id: 'event-old' }]
        : [];
      res.end(JSON.stringify({ ok: true, data: { consumer: 'pm-a', cursor: `${reads}-0`, items } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock intake server 未监听');
    const dir = createTempDir('biao-pm-agent-race-');
    const output = join(dir, 'child.jsonl');

    const result = await runWaker([
      '--once', '--biao-url', `http://127.0.0.1:${address.port}`, '--consumer', 'pm-a', '--lock-dir', dir,
    ], { BIAO_PM_AGENT_CMD: captureCommand(output) });

    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readRecords(output)).toEqual([]);
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  });

  it('有 PM 事项时只启动一次，并仅交付无详情的汇总 payload', async () => {
    const { url, paths } = await startIntakeServer([
      { kind: 'review_requested', plan_id: 'p1', task_id: 'task-1', event_id: 'e1', result: 'forbidden', body: 'forbidden', token: 'forbidden' },
      { kind: 'question_asked', plan_id: 'p1', task_id: 'task-2', event_id: 'e2', body: 'must never cross stdin' },
      { kind: 'resolution_required', plan_id: 'p1', task_id: 'task-3', resolution_action: 'repair' },
      { kind: 'needs_pm_decision', plan_id: 'p1', task_id: 'task-4', result: 'also forbidden' },
    ]);
    const dir = createTempDir('biao-pm-agent-wake-');
    const output = join(dir, 'child.jsonl');
    const result = await runWaker(['--once', '--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
      BIAO_API_TOKEN: 'platform-token-must-not-cross-process',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('count=3');
    const records = readRecords(output);
    expect(records).toHaveLength(1);
    expect(records[0].apiToken).toBeNull();
    expect(records[0]).toMatchObject({
      fetchDetails: 'required',
      ack: 'only_after_actual_handling',
      automation: 'forbidden',
    });
    const payload = JSON.parse(String(records[0].stdin)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['biaoUrl', 'consumer', 'planIds', 'kinds', 'count'].sort());
    expect(payload).toEqual({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: [],
      kinds: { needs_pm_decision: 1, question_asked: 1, review_requested: 1 },
      count: 3,
    });
    expect(JSON.stringify(payload)).not.toContain('forbidden');
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  });

  it('显式 PM adapter 是含空格的绝对路径时不经 shell 拆分', async () => {
    const { url } = await startIntakeServer([
      { kind: 'review_requested', plan_id: 'p1', task_id: 'task-1' },
    ]);
    const dir = createTempDir('biao-pm-agent-direct-');
    const commandDir = join(dir, "adapter directory with spaces and ' quote");
    mkdirSync(commandDir);
    const output = join(dir, 'direct-child.json');
    const command = join(commandDir, 'pm adapter');
    writeFileSync(command, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(output)}, readFileSync(0, 'utf8'), 'utf8');
`, { mode: 0o755 });
    chmodSync(command, 0o755);

    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: command,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      consumer: 'pm-a',
      count: 1,
      kinds: { review_requested: 1 },
    });
  });

  it('把外置 runtime/workspace 传给内置 Codex adapter 并完成真实进程桥接', async () => {
    const { url } = await startIntakeServer([
      { kind: 'review_requested', plan_id: 'p1', task_id: 'task-1' },
    ]);
    const dir = createTempDir('biao-pm-adapter-bridge-');
    const runtimeDir = join(dir, "consumer runtime with ' quote");
    const workspace = join(dir, 'workspace');
    const binDir = join(dir, 'bin');
    mkdirSync(runtimeDir);
    mkdirSync(workspace);
    mkdirSync(binDir);
    for (const launcher of ['pm', 'pm-start']) {
      const path = join(runtimeDir, launcher);
      writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      chmodSync(path, 0o755);
    }
    const capture = join(dir, 'codex-invocation.json');
    const fakeCodex = join(binDir, 'codex');
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin: readFileSync(0, 'utf8'),
  cwd: process.cwd(),
}), 'utf8');
`, { mode: 0o755 });
    chmodSync(fakeCodex, 0o755);
    const adapter = join(import.meta.dirname, '..', 'scripts', 'codex-pm-agent.mjs');

    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: adapter,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: workspace,
      BIAO_WORKSPACE_ROOTS: workspace,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    });

    expect(result.code).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string; cwd: string };
    const canonicalRuntime = realpathSync(runtimeDir);
    expect(invoked.cwd).toBe(canonicalRuntime);
    expect(invoked.argv[invoked.argv.indexOf('-C') + 1]).toBe(canonicalRuntime);
    expect(invoked.argv).toContain(realpathSync(workspace));
    expect(invoked.stdin).toContain(shellQuote(join(canonicalRuntime, 'pm-start')));
    expect(invoked.stdin).toContain(shellQuote(join(canonicalRuntime, 'pm')));
    expect(invoked.stdin).toContain('旧 attempt 的失败字段绝不能冒充当前交付结果');
    expect(invoked.stdin).toContain('`changed_files=[]` 也不是自动拒绝条件');
  });

  it('有事项却没有显式 command 时给出可辨识配置失败，不启动 child', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-no-command-');
    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('BIAO_PM_AGENT_CMD');
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
  });

  it('require-drained：Agent 退出成功但事项未处理时返回失败，供共享 Supervisor 重试', async () => {
    const { url, paths } = await startIntakeServer([
      { kind: 'review_requested', plan_id: 'p1', task_id: 'task-1', event_id: 'e1' },
    ]);
    const dir = createTempDir('biao-pm-agent-undrained-');
    const output = join(dir, 'child.jsonl');
    const result = await runWaker([
      '--once',
      '--require-drained',
      '--biao-url', url,
      '--consumer', 'pm-a',
      '--plans', 'p1',
      '--lock-dir', dir,
    ], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
    });

    expect(readRecords(output)).toHaveLength(1);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('仍未处理');
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  });

  it('PM Agent 卡死时终止整个进程组、释放锁并让 Supervisor 下轮重试', async () => {
    const { url, paths } = await startIntakeServer([
      { kind: 'review_requested', plan_id: 'p1', task_id: 'task-1', event_id: 'e1' },
    ]);
    const dir = createTempDir('biao-pm-agent-timeout-');
    const parentPidPath = join(dir, 'parent.pid');
    const childPidPath = join(dir, 'child.pid');
    const command = hangingProcessTreeCommand(parentPidPath, childPidPath);

    const timedOut = await runWaker(['--once', '--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: command,
      BIAO_PM_AGENT_TIMEOUT_MS: '3000',
    });

    expect(timedOut.code).toBe(1);
    expect(timedOut.stderr).toContain('超过 3000ms');
    const parentPid = Number(readFileSync(parentPidPath, 'utf8'));
    const childPid = Number(readFileSync(childPidPath, 'utf8'));
    await Promise.all([waitForProcessExit(parentPid), waitForProcessExit(childPid)]);

    const retried = await runWaker(['--once', '--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: '/usr/bin/true',
      BIAO_PM_AGENT_TIMEOUT_MS: '3000',
    });
    expect(retried.code).toBe(0);
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  }, 10_000);

  it('plans 只在客户端过滤，且只唤醒被允许范围内的事项', async () => {
    const { url, paths } = await startIntakeServer([
      { kind: 'question_asked', plan_id: 'p1', task_id: 'question-task', body: 'private' },
      { kind: 'review_requested', plan_id: 'p2', task_id: 'review-task', result: 'private' },
      { kind: 'failed', plan_id: 'p3', task_id: 'ignored-task' },
    ]);
    const dir = createTempDir('biao-pm-agent-filter-');
    const output = join(dir, 'child.jsonl');
    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--plans', 'p1', '--lock-dir', dir, '--command', captureCommand(output)], {
      BIAO_PM_AGENT_CMD: '',
    });

    expect(result.code).toBe(0);
    const [record] = readRecords(output);
    expect(JSON.parse(String(record.stdin))).toEqual({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: ['p1'],
      kinds: { question_asked: 1 },
      count: 1,
    });
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  });

  it('服务端确认仍持有 running task 的 stale_agent 时才唤醒，且不泄露 agent 详情', async () => {
    // idle/stale 注册不会由 pmIntake 产生此类 item；这里仅验证它已经被服务端判定为
    // PM 边界时，唤醒器不丢失提醒，也不会把 agent_id 交给外部命令。
    const { url, paths } = await startIntakeServer([
      { kind: 'stale_agent', plan_id: 'p-running', agent_id: 'worker-private-id', current_task: 'task-private-id' },
    ]);
    const dir = createTempDir('biao-pm-agent-stale-running-');
    const output = join(dir, 'child.jsonl');
    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
    });

    expect(result.code).toBe(0);
    const [record] = readRecords(output);
    const payload = JSON.parse(String(record.stdin)) as Record<string, unknown>;
    expect(payload).toEqual({
      biaoUrl: url,
      consumer: 'pm-a',
      planIds: [],
      kinds: { stale_agent: 1 },
      count: 1,
    });
    expect(JSON.stringify(payload)).not.toContain('worker-private-id');
    expect(JSON.stringify(payload)).not.toContain('task-private-id');
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
  });

  it('重叠 cron/launchd 触发只允许一个 PM Agent child 和一次 intake', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-lock-');
    const output = join(dir, 'child.jsonl');
    const started = join(dir, 'child-started');
    const release = join(dir, 'child-release');
    const command = captureCommand(output, { startPath: started, releasePath: release });
    const env = { ...process.env, BIAO_PM_AGENT_CMD: command, BIAO_PM_AGENT_LOCK_DIR: dir };
    const first = spawn(process.execPath, [script, '--biao-url', url, '--consumer', 'pm-a'], {
      cwd: join(import.meta.dirname, '..'),
      env,
      stdio: 'ignore',
    });

    try {
      await waitForFile(started);
      const second = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
        BIAO_PM_AGENT_CMD: command,
        // 单独伪造环境 marker 不能让内层绕过内核锁。
        BIAO_PM_AGENT_KERNEL_LOCK_NONCE: '00000000-0000-4000-8000-000000000000',
      });
      expect(second).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(readRecords(output)).toHaveLength(1);
      expect(paths).toEqual([
        'GET /intake?consumer=pm-a',
        'GET /intake?consumer=pm-a',
      ]);

      writeFileSync(release, 'release');
      const code = await new Promise<number | null>((resolve, reject) => {
        first.once('error', reject);
        first.once('close', resolve);
      });
      expect(code).toBe(0);
    } finally {
      if (!first.killed && first.exitCode === null) first.kill('SIGTERM');
    }
  }, 10_000);

  it('伪造完整 argv/env/fd3/fd4 内部交接也不能绕过正在持有的内核锁', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-forged-handoff-');
    const output = join(dir, 'child.jsonl');
    const started = join(dir, 'child-started');
    const release = join(dir, 'child-release');
    const command = captureFirstInvocationCommand(output, started, release);
    const args = ['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir];
    const env = { ...process.env, BIAO_PM_AGENT_CMD: command, BIAO_PM_AGENT_LOCK_DIR: dir };
    const first = spawn(process.execPath, [script, ...args], {
      cwd: join(import.meta.dirname, '..'),
      env,
      stdio: 'ignore',
    });

    try {
      await waitForFile(started);
      const nonce = '00000000-0000-4000-8000-000000000000';
      const forged = await runForgedInternalHandoff(args, env, nonce);
      expect(forged).toEqual({ code: 0, stdout: '', stderr: '', acknowledgement: nonce });
      expect(readRecords(output)).toHaveLength(1);
      expect(paths).toEqual([
        'GET /intake?consumer=pm-a',
        'GET /intake?consumer=pm-a',
      ]);
    } finally {
      writeFileSync(release, 'release');
      if (first.exitCode === null) {
        await new Promise<void>((resolve) => first.once('close', () => resolve()));
      }
      if (!first.killed && first.exitCode === null) first.kill('SIGTERM');
    }
  }, 10_000);

  it('历史锁文件的存在和内容不代表持锁，内核锁成功后保留稳定 inode', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-stale-lock-');
    const output = join(dir, 'child.jsonl');
    const stalePath = join(dir, `biao-pm-agent-${lockKeyForTest(url, 'pm-a')}.lock`);
    writeFileSync(stalePath, 'stale-content-that-is-not-an-owner-record', 'utf8');
    const inode = statSync(stalePath).ino;

    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
    });

    expect(result.code).toBe(0);
    expect(readRecords(output)).toHaveLength(1);
    expect(paths).toEqual([
      'GET /intake?consumer=pm-a',
      'GET /intake?consumer=pm-a',
    ]);
    expect(readFileSync(stalePath, 'utf8')).toBe('stale-content-that-is-not-an-owner-record');
    expect(statSync(stalePath).ino).toBe(inode);
  });

  it('拒绝符号链接锁路径，不跟随到任意文件上持锁', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-symlink-lock-');
    const victim = join(dir, 'victim.txt');
    const output = join(dir, 'child.jsonl');
    const linkedLock = join(dir, `biao-pm-agent-${lockKeyForTest(url, 'pm-a')}.lock`);
    writeFileSync(victim, 'must-not-be-used-as-lock', 'utf8');
    symlinkSync(victim, linkedLock);

    const result = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      BIAO_PM_AGENT_CMD: captureCommand(output),
    });

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('符号链接');
    expect(readRecords(output)).toEqual([]);
    expect(paths).toEqual([]);
    expect(readFileSync(victim, 'utf8')).toBe('must-not-be-used-as-lock');
  });

  it('受保护进程崩溃后由内核自动释放锁，下一次触发可立即接管', async () => {
    const { url, paths } = await startIntakeServer([{ kind: 'review_requested', plan_id: 'p1' }]);
    const dir = createTempDir('biao-pm-agent-crash-release-');
    const output = join(dir, 'child.jsonl');
    const crashMarker = join(dir, 'crashed-once');
    const command = blockLockHolderOnceCommand(output, crashMarker);
    const crashed = spawn(process.execPath, [script, '--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, BIAO_PM_AGENT_CMD: command },
      stdio: 'ignore',
    });
    const crashedClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      crashed.once('error', reject);
      crashed.once('close', (code, signal) => resolve({ code, signal }));
    });
    let agentPid: number | undefined;
    try {
      await waitForFile(crashMarker);
      agentPid = Number(readFileSync(crashMarker, 'utf8'));
      expect(Number.isInteger(agentPid) && agentPid > 1).toBe(true);

      crashed.kill('SIGKILL');
      const crashedResult = await crashedClosed;
      expect(crashedResult.code).not.toBe(0);
      expect(crashedResult.signal).toBe('SIGKILL');

      // PM Agent 被内核终止后，命令子进程可能成为孤儿；它不持锁，但测试必须回收它。
      try { process.kill(agentPid!, 'SIGKILL'); } catch { /* 已退出 */ }

      const recovered = await runWaker(['--biao-url', url, '--consumer', 'pm-a', '--lock-dir', dir], {
        BIAO_PM_AGENT_CMD: command,
      });
      expect(recovered.code).toBe(0);
      expect(readRecords(output)).toHaveLength(2);
      expect(paths).toEqual([
        'GET /intake?consumer=pm-a',
        'GET /intake?consumer=pm-a',
        'GET /intake?consumer=pm-a',
        'GET /intake?consumer=pm-a',
      ]);
    } finally {
      if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill('SIGKILL');
      if (agentPid) {
        try { process.kill(agentPid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
    }
  });
});
