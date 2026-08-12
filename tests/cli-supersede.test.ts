import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

async function runCli(args: string[], url: string) {
  try {
    const output = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: url }, encoding: 'utf8',
    });
    return { code: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
}

async function mockServer() {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', body: await readBody(req) });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({
        ok: true,
        data: {
          plan_id: 'legacy-plan', candidate_task_ids: ['a', 'b'], blockers: [], preview_token: 'a'.repeat(64),
        },
      }));
    } else if (req.url?.includes('/plan/')) {
      res.end(JSON.stringify({
        ok: true, data: { plan_id: 'legacy-plan', superseded_task_ids: ['a', 'b'], status: 'cancelled' },
      }));
    } else {
      res.end(JSON.stringify({ ok: true, data: { task_id: 'legacy-a', status: 'superseded' } }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('supersede CLI 显式确认与严格参数', () => {
  it.each([
    [['task', 'supersede', '--help'], 'done + pending review'],
    [['plan', 'supersede', '--help'], 'preview-token'],
  ])('%s 显示叶子命令帮助且不连接服务', async (args, expected) => {
    const mock = await mockServer();
    const outcome = await runCli(args, mock.url);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(expected);
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    ['缺少 --yes', ['task', 'supersede', 'legacy-a', '--reason', '伪完成']],
    ['缺少 reason', ['task', 'supersede', 'legacy-a', '--yes']],
    ['未知参数', ['task', 'supersede', 'legacy-a', '--reason', '伪完成', '--yes', '--froce']],
    ['plan 缺少 preview token', ['plan', 'supersede', 'legacy-plan', '--reason', '伪完成', '--yes']],
  ])('%s 时非零退出且不发请求', async (_label, args) => {
    const mock = await mockServer();
    const outcome = await runCli(args, mock.url);
    expect(outcome.code).not.toBe(0);
    expect(mock.requests).toHaveLength(0);
  });

  it('单任务携带 reason/by/confirmed 调用显式 API', async () => {
    const mock = await mockServer();
    const outcome = await runCli([
      'task', 'supersede', 'legacy-a', '--reason', '历史记录没有有效产物', '--by', 'pm-migration', '--yes',
    ], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requests).toEqual([{
      method: 'POST', path: '/task/legacy-a/supersede',
      body: { reason: '历史记录没有有效产物', superseded_by: 'pm-migration', confirmed: true },
    }]);
    expect(outcome.stdout).toContain('superseded');
  });

  it('Plan 先预览，再用明确 token + yes 应用同一快照', async () => {
    const mock = await mockServer();
    const preview = await runCli(['plan', 'supersede', 'legacy-plan', '--preview'], mock.url);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain('a'.repeat(64));
    const apply = await runCli([
      'plan', 'supersede', 'legacy-plan', '--reason', '历史伪完成批量退出', '--by', 'pm-migration',
      '--preview-token', 'a'.repeat(64), '--yes',
    ], mock.url);
    expect(apply.code).toBe(0);
    expect(mock.requests.at(-1)).toEqual({
      method: 'POST', path: '/plan/legacy-plan/supersede',
      body: {
        reason: '历史伪完成批量退出', superseded_by: 'pm-migration', confirmed: true,
        preview_token: 'a'.repeat(64),
      },
    });
  });
});
