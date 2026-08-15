import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
const adapterKit = join(repoRoot, 'scripts', 'adapter-kit.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-adapter-kit-'));
  tempDirs.push(dir);
  return dir;
}

describe('陌生 Agent 接入包', () => {
  it('无需连接平台即可查看三步接入帮助', async () => {
    const { stdout } = await execFileAsync(process.execPath, [adapterKit, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(stdout).toContain('contract --role <pm|worker>');
    expect(stdout).toContain('scaffold --role <pm|worker>');
    expect(stdout).toContain('check --role <pm|worker>');
    expect(stdout).toContain('不读取 Biao Token');
  });

  it('以机器可读 JSON 给出 PM 最小门铃与退出码契约', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      adapterKit, 'contract', '--role', 'pm', '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    const contract = JSON.parse(stdout) as Record<string, any>;
    expect(contract).toMatchObject({
      ok: true,
      data: {
        protocol: 'biao.pm-adapter/v1',
        role: 'pm',
        input: {
          transport: 'stdin-json-line',
          fields: ['biaoUrl', 'consumer', 'planIds', 'kinds', 'count'],
        },
        target: { env: 'BIAO_PM_TARGET', required: false },
        runtime: { env: 'BIAO_RUNTIME_DIR', launchers: ['pm-start', 'pm'] },
        probe: {
          env: 'BIAO_ADAPTER_PROBE',
          value: '1',
          response: { ok: true, protocol: 'biao.pm-adapter/v1', role: 'pm' },
        },
        supervisor: {
          poolConfig: 'BIAO_PM_SLOTS',
          queueSelector: 'plan.pm_consumer == slot.consumer',
          routeOverride: 'BIAO_PM_AGENT_ROUTES',
        },
        exit: { success: 0, retry: 'nonzero' },
      },
    });
    expect(stdout).not.toContain('BIAO_API_TOKEN');
    expect(stdout).not.toContain('BIAO_REDIS_URL');
  });

  it('以机器可读 JSON 给出 Worker 执行器参数与 Question 契约', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      adapterKit, 'contract', '--role', 'worker', '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    const contract = JSON.parse(stdout) as Record<string, any>;
    expect(contract).toMatchObject({
      ok: true,
      data: {
        protocol: 'biao.worker-executor/v1',
        role: 'worker',
        input: {
          transport: 'argv',
          fields: ['taskId', 'goalFile', 'workDir'],
          cwd: 'projectPath',
        },
        question: { stdoutPrefix: 'BIAO_QUESTION: ' },
        probe: {
          env: 'BIAO_ADAPTER_PROBE',
          value: '1',
          response: { ok: true, protocol: 'biao.worker-executor/v1', role: 'worker' },
        },
        supervisor: { config: 'BIAO_WORKER_SLOTS', kind: 'custom' },
        exit: { success: 0, failed: 'nonzero' },
      },
    });
    expect(stdout).not.toContain('claim_token');
    expect(stdout).not.toContain('BIAO_API_TOKEN');
  });

  it('生成可执行且不含控制面凭据的 PM 适配器模板', async () => {
    const output = join(tempDir(), 'my-pm-adapter.mjs');
    const { stdout } = await execFileAsync(process.execPath, [
      adapterKit, 'scaffold', '--role', 'pm', '--output', output, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: { protocol: 'biao.pm-adapter/v1', role: 'pm', output },
    });
    expect(statSync(output).mode & 0o111).not.toBe(0);
    const template = readFileSync(output, 'utf8');
    expect(template).toContain("BIAO_ADAPTER_PROBE");
    expect(template).toContain("BIAO_PM_TARGET");
    expect(template).toContain("BIAO_RUNTIME_DIR");
    expect(template).not.toContain('BIAO_API_TOKEN');
    expect(template).not.toContain('BIAO_REDIS_URL');
  });

  it('生成接受三参数和 Question 单行输出的 Worker 执行器模板', async () => {
    const output = join(tempDir(), 'my-worker-executor.mjs');
    await execFileAsync(process.execPath, [
      adapterKit, 'scaffold', '--role', 'worker', '--output', output, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    const template = readFileSync(output, 'utf8');
    expect(statSync(output).mode & 0o111).not.toBe(0);
    expect(template).toContain("biao.worker-executor/v1");
    expect(template).toContain("process.argv.slice(2)");
    expect(template).toContain("BIAO_QUESTION: ");
    expect(template).toContain("BIAO_ADAPTER_PROBE");
    expect(template).not.toContain('claim_token');
    expect(template).not.toContain('BIAO_API_TOKEN');
  });

  it.each(['pm', 'worker'] as const)('用离线探针验证 %s 适配器能被平台识别', async (role) => {
    const output = join(tempDir(), `${role}-adapter.mjs`);
    await execFileAsync(process.execPath, [
      adapterKit, 'scaffold', '--role', role, '--output', output,
    ], { cwd: repoRoot, encoding: 'utf8' });

    const { stdout } = await execFileAsync(process.execPath, [
      adapterKit, 'check', '--role', role, '--adapter', output, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });

    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      data: {
        role,
        protocol: role === 'pm' ? 'biao.pm-adapter/v1' : 'biao.worker-executor/v1',
        adapter: output,
      },
    });
  });
});
