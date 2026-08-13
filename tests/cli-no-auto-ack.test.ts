/** PM 监视只能敲门，绝不能因打印一行就把待办事件 ack 掉。 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startWatchServer(options: { planStatus: string; items?: Array<Record<string, unknown>> }) {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/intake?')) {
      res.end(JSON.stringify({
        ok: true,
        data: { cursor: '101-0', items: options.items ?? [] },
      }));
      return;
    }
    if (req.url === '/plans') {
      res.end(JSON.stringify({
        ok: true,
        data: {
          plans: [{ plan_id: 'plan-1', status: options.planStatus }],
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

async function spawnWatch(url: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, 'pm', 'watch', '--consumer', 'pm-a'], {
    env: { ...process.env, BIAO_URL: url },
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
  return { child, closed, output: () => ({ stdout, stderr }) };
}

async function closesWithin(
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
): Promise<{ closed: boolean; result?: { code: number | null; signal: NodeJS.Signals | null } }> {
  return Promise.race([
    closed.then((result) => ({ closed: true, result })),
    new Promise<{ closed: false }>((resolve) => setTimeout(() => resolve({ closed: false }), timeoutMs)),
  ]);
}

it('pm watch --once 只输出门铃，不请求 intake/ack', async () => {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/intake?')) {
      res.end(JSON.stringify({
        ok: true,
        data: {
          cursor: '101-0',
          items: [{ kind: 'review_requested', event_id: 'evt-1', task_id: 'task-1', plan_id: 'plan-1' }],
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
  const url = `http://127.0.0.1:${address.port}`;

  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', cli, 'pm', 'watch', '--once', '--consumer', 'pm-a'], {
    env: { ...process.env, BIAO_URL: url }, encoding: 'utf8',
  });

  expect(stdout).toContain('发现 1 项待处理');
  expect(paths).toEqual([expect.stringMatching(/^GET \/intake\?consumer=pm-a$/)]);
  expect(paths.some((path) => path.includes('/intake/ack'))).toBe(false);
});

it('pm watch 在 intake 为空且所有 Plan 终结时自动 exit 0，不留定时器', async () => {
  const { url, paths } = await startWatchServer({ planStatus: 'completed' });
  const watch = await spawnWatch(url);
  const outcome = await closesWithin(watch.closed, 1_000);
  if (!outcome.closed) watch.child.kill('SIGTERM');

  expect(outcome).toMatchObject({ closed: true, result: { code: 0, signal: null } });
  expect(watch.output().stderr).toBe('');
  expect(paths).toEqual(expect.arrayContaining([
    'GET /intake?consumer=pm-a',
    'GET /plans',
  ]));
});

it.each([
  { label: '仍有 active Plan', planStatus: 'active', items: [] },
  {
    label: '仍有 actionable intake',
    planStatus: 'completed',
    items: [{ kind: 'review_requested', event_id: 'evt-1', task_id: 'task-1', plan_id: 'plan-1' }],
  },
])('pm watch 在$label时继续常驻', async ({ planStatus, items }) => {
  const { url } = await startWatchServer({ planStatus, items });
  const watch = await spawnWatch(url);
  const early = await closesWithin(watch.closed, 350);

  expect(early.closed).toBe(false);
  watch.child.kill('SIGTERM');
  const stopped = await closesWithin(watch.closed, 1_000);
  expect(stopped).toMatchObject({ closed: true, result: { code: 0, signal: null } });
});
