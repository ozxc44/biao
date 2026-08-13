import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type CliOutcome = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[], url: string): Promise<CliOutcome> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: url },
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

async function mockRestoreService(response: unknown) {
  const requests: Array<{ method?: string; path: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: new URL(req.url ?? '/', 'http://127.0.0.1').pathname });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock restore service 未监听');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

describe('db restore CLI 灾难恢复门槛', () => {
  it('没有 --yes 时 fail closed、打印停机检查指引且不发送请求', async () => {
    const mock = await mockRestoreService({ ok: true, data: { restored: 1, by_status: { pending: 1 } } });

    const outcome = await runCli(['db', 'restore'], mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('仅用于 Biao Redis namespace 空的灾难恢复');
    expect(outcome.stderr).toContain('先停止 Supervisor/Worker');
    expect(outcome.stderr).toContain('检查 biao db status');
    expect(outcome.stderr).toContain('显式添加 --yes');
    expect(mock.requests).toHaveLength(0);
  });

  it('restore 帮助说明拒绝条件、running 转换和旧 token 失效，且不发送请求', async () => {
    const mock = await mockRestoreService({ ok: true, data: null });

    const outcome = await runCli(['db', 'restore', '--help'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toContain('用法：biao db restore --yes');
    expect(outcome.stdout).toContain('仅用于 Biao Redis namespace 空的灾难恢复');
    expect(outcome.stdout).toContain('非空目标');
    expect(outcome.stdout).toContain('running');
    expect(outcome.stdout).toContain('lease');
    expect(outcome.stdout).toContain('ownership');
    expect(outcome.stdout).toContain('fresh pending');
    expect(outcome.stdout).toContain('旧 claim token 失效');
    expect(mock.requests).toHaveLength(0);
  });

  it.each([
    [['db', 'restore', '--force'], '未知参数：--force'],
    [['db', 'restore', '--yes', '--yes'], '重复参数：--yes'],
    [['db', 'restore', '--yes', 'extra'], '多余参数：extra'],
  ])('严格拒绝无效参数 %j，且不发送请求', async (args, expectedError) => {
    const mock = await mockRestoreService({ ok: true, data: { restored: 0, by_status: {} } });

    const outcome = await runCli(args, mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain(expectedError);
    expect(mock.requests).toHaveLength(0);
  });

  it('显式 --yes 后才向恢复 API 发出一次 POST', async () => {
    const mock = await mockRestoreService({ ok: true, data: { restored: 2, by_status: { pending: 2 } } });

    const outcome = await runCli(['db', 'restore', '--yes'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('恢复了 2 个 task');
    expect(mock.requests).toEqual([{ method: 'POST', path: '/db/restore' }]);
  });

  it('restore 明确显示保留在 SQLite 审计但未投影的项目与原因', async () => {
    const mock = await mockRestoreService({
      ok: true,
      data: {
        restored: 2,
        by_status: { pending: 2 },
        excluded: {
          plan_count: 1,
          task_count: 3,
          by_reason: { system_temporary_project: { plans: 1, tasks: 3 } },
        },
      },
    });

    const outcome = await runCli(['db', 'restore', '--yes'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('未投影 1 个 plan / 3 个 task');
    expect(outcome.stdout).toContain('system_temporary_project');
    expect(outcome.stdout).toContain('SQLite 审计');
  });

  it('db status 区分归档总量、可恢复投影与排除原因', async () => {
    const mock = await mockRestoreService({
      ok: true,
      data: {
        task_count: 5,
        plan_count: 2,
        by_status: { pending: 5 },
        restore_projection: {
          restorable_tasks: 2,
          restorable_plans: 1,
          excluded: {
            plan_count: 1,
            task_count: 3,
            by_reason: { outside_configured_workspace: { plans: 1, tasks: 3 } },
          },
        },
      },
    });

    const outcome = await runCli(['db', 'status'], mock.url);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('可恢复投影: 1 plans / 2 tasks');
    expect(outcome.stdout).toContain('排除但保留审计: 1 plans / 3 tasks');
    expect(outcome.stdout).toContain('outside_configured_workspace');
  });

  it('服务端拒绝时透传稳定错误码和消息并非零退出', async () => {
    const mock = await mockRestoreService({
      ok: false,
      data: null,
      error: { code: 'DB_RESTORE_TARGET_NOT_EMPTY', message: 'Redis namespace 非空，拒绝恢复' },
    });

    const outcome = await runCli(['db', 'restore', '--yes'], mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('DB_RESTORE_TARGET_NOT_EMPTY');
    expect(outcome.stderr).toContain('Redis namespace 非空，拒绝恢复');
    expect(mock.requests).toEqual([{ method: 'POST', path: '/db/restore' }]);
  });
});
