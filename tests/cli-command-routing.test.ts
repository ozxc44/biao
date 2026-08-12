import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');

type CliOutcome = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[]): Promise<CliOutcome> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: 'http://127.0.0.1:1' },
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

describe('CLI 命令路由拒绝假绿', () => {
  it.each(['questions', 'reply', 'not-a-biao-command'])(
    '未知一级命令 %s 即使带 --help 也明确报错并非零退出',
    async (command) => {
      const outcome = await runCli([command, '--help']);

      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain(`未知命令：${command}`);
      expect(outcome.stderr).toContain('biao --help');
      expect(outcome.stdout).not.toContain('Biao CLI 用法');
    },
  );

  it.each([
    ['pm', 'unexpected'],
    ['plan', 'unexpected'],
    ['task', 'unexpected'],
    ['question', 'reply'],
    ['db', 'unexpected'],
    ['ownership', 'unexpected'],
  ])('未知二级命令 biao %s %s 明确报错并非零退出', async (group, command) => {
    const outcome = await runCli([group, command]);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain(`未知子命令：biao ${group} ${command}`);
    expect(outcome.stderr).toContain(`biao ${group} --help`);
  });

  it.each([
    ['--help'],
    ['pm', '--help'],
    ['plan', '--help'],
    ['task', '--help'],
    ['question', '--help'],
    ['db', '--help'],
    ['ownership', '--help'],
  ])('有效帮助 biao %s 保持零退出', async (...args) => {
    const outcome = await runCli(args);

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toMatch(/用法|Biao CLI/);
  });

  it.each(['health', 'status', 'version', 'review', 'events', 'conflicts', 'watchdog'])(
    '有效一级命令 biao %s --help 不连接服务且零退出',
    async (command) => {
      const outcome = await runCli([command, '--help']);

      expect(outcome.code).toBe(0);
      expect(outcome.stderr).toBe('');
      expect(outcome.stdout).toContain(`用法：biao ${command}`);
    },
  );

  it.each([
    ['pm', 'ack'],
    ['plan', 'list'],
    ['task', 'add'],
    ['task', 'get'],
    ['task', 'resume'],
    ['task', 'resolution'],
    ['question', 'ask'],
    ['db', 'restore'],
    ['ownership', 'check'],
  ])('有效二级命令 biao %s %s --help 不执行业务且零退出', async (group, command) => {
    const outcome = await runCli([group, command, '--help']);

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toMatch(/用法|Biao CLI/);
  });
});
