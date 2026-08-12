/**
 * PM Agent 唤醒器：平台只提供最小 intake，外部 Agent 仅在有事项时由显式命令启动。
 * 本文件故意通过真实子进程验证 stdin/env/本机锁边界，避免把“没有自动 ack”测成 mock 假象。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
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
    };
    appendFileSync(outputPath, JSON.stringify(record) + '\\n');
    if (startPath) writeFileSync(startPath, 'started');
    while (releasePath && !existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  `, 'utf8');
  return [process.execPath, child, outputPath, opts.startPath ?? '', opts.releasePath ?? ''].map(shellQuote).join(' ');
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
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
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
    ]);
  });

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
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
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
    expect(paths).toEqual(['GET /intake?consumer=pm-a']);
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
      });
      expect(second).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(readRecords(output)).toHaveLength(1);
      expect(paths).toEqual(['GET /intake?consumer=pm-a']);

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
});
