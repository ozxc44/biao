import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type CliOutcome = { code: number; stdout: string; stderr: string };

async function runCli(args: string[], url: string, env: NodeJS.ProcessEnv = {}): Promise<CliOutcome> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: url, BIAO_AGENT_ID: 'pm-resolution', ...env },
      encoding: 'utf8',
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
}

async function resolutionServer(options: { fail?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, body: await readJson(req) });
    res.setHeader('content-type', 'application/json');
    if (options.fail) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, data: null, error: { code: 'RESOLUTION_CONTINUE_UNSAFE', message: '当前原因不能安全续跑' } }));
      return;
    }
    const action = requests.at(-1)?.body?.action ?? 'inspect';
    res.end(JSON.stringify({
      ok: true,
      data: {
        requested_task_id: 'source-task',
        root_task_id: 'source-task',
        state: action === 'continue' ? 'repairing' : action === 'cancel' ? 'cancelled' : 'needs_pm_decision',
        action: action === 'continue' ? 'repair' : action,
        reason: 'repair_retry_limit_reached',
        latest_repair_id: action === 'continue' ? 'source-task-repair-2' : 'source-task-repair-1',
        resolution_lineage: ['source-task-repair-1'],
        attempts: action === 'continue' ? 2 : 1,
        max_retries: 1,
        available_actions: action === 'cancel' ? ['inspect'] : ['inspect', 'continue', 'cancel'],
        ...(action === 'continue' ? { created_task_ids: ['source-task-repair-2'] } : {}),
      },
    }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock resolution server 未监听');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

describe('retry 耗尽后的 PM resolution CLI', () => {
  it('默认 inspect 通过 GET 读取根因、lineage 与可用动作', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli(['task', 'resolution', 'source-task'], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requests).toEqual([{ method: 'GET', path: '/task/source-task/resolution', body: undefined }]);
    expect(outcome.stdout).toContain('repair_retry_limit_reached');
    expect(outcome.stdout).toContain('source-task-repair-1');
    expect(outcome.stdout).toContain('inspect, continue, cancel');
  });

  it('inspect 支持 JSON，供一次性 PM Agent 无损读取', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli(['task', 'resolution', 'source-task', '--json'], mock.url);

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: { root_task_id: 'source-task', state: 'needs_pm_decision' },
    });
  });

  it('continue 用当前 PM 身份只新增一代 repair', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli([
      'task', 'resolution', 'source-task', '--action', 'continue',
    ], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requests).toEqual([{
      method: 'POST',
      path: '/task/source-task/resolution',
      body: { action: 'continue', decided_by: 'pm-resolution' },
    }]);
    expect(outcome.stdout).toContain('source-task-repair-2');
    expect(outcome.stdout).toContain('repairing');
  });

  it('cancel 可显式记录决策者，并支持 JSON 返回终态', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli([
      'task', 'resolution', 'source-task', '--action', 'cancel', '--decided-by', 'pm-owner', '--json',
    ], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requests[0]).toMatchObject({
      method: 'POST',
      body: { action: 'cancel', decided_by: 'pm-owner' },
    });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: true, data: { state: 'cancelled' } });
  });

  it.each([
    ['缺 task id', ['task', 'resolution'], 'task_id'],
    ['非法 action', ['task', 'resolution', 'source-task', '--action', 'retry'], 'inspect、continue 或 cancel'],
    ['空决策者', ['task', 'resolution', 'source-task', '--action', 'continue', '--decided-by', ''], '--decided-by'],
    ['inspect 不接受决策者', ['task', 'resolution', 'source-task', '--decided-by', 'pm-owner'], 'inspect'],
    ['服务端不支持 reason', ['task', 'resolution', 'source-task', '--action', 'continue', '--reason', '不应伪造'], '未知参数：--reason'],
    ['未知参数', ['task', 'resolution', 'source-task', '--force'], '未知参数：--force'],
    ['重复 action', ['task', 'resolution', 'source-task', '--action', 'continue', '--action', 'cancel'], '重复参数：--action'],
  ])('%s 在客户端 fail closed 且不发请求', async (_label, args, message) => {
    const mock = await resolutionServer();

    const outcome = await runCli(args, mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain(message);
    expect(mock.requests).toHaveLength(0);
  });

  it('服务端拒绝决策时保留错误并非零退出', async () => {
    const mock = await resolutionServer({ fail: true });

    const outcome = await runCli([
      'task', 'resolution', 'source-task', '--action', 'continue',
    ], mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('当前原因不能安全续跑');
    expect(mock.requests).toHaveLength(1);
  });

  it('help 不联网并明确三种动作与决策者', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli(['task', 'resolution', '--help'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('inspect|continue|cancel');
    expect(outcome.stdout).toContain('--decided-by');
    expect(mock.requests).toHaveLength(0);
  });

  it('PM CLI 总引导直接给出 retry 耗尽的三动作闭环', async () => {
    const mock = await resolutionServer();

    const outcome = await runCli(['pm', '--help'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('biao task resolution <task_id>');
    expect(outcome.stdout).toContain('--action continue');
    expect(outcome.stdout).toContain('--action cancel');
    expect(outcome.stdout).toContain('决策成功后');
    expect(mock.requests).toHaveLength(0);
  });
});
