import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const workerAgent = join(repoRoot, 'scripts', 'worker-agent.mjs');
const workerAgentBin = join(repoRoot, 'bin', 'biao-worker-agent.js');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-worker-agent-'));
  tempDirs.push(dir);
  return dir;
}

function writeAdapter(dir: string, body: string, name = 'worker adapter with spaces.mjs'): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function baseArgs(dir: string, command: string): string[] {
  return [
    workerAgent,
    '--once',
    '--biao-url', 'http://127.0.0.1:7331',
    '--slot', 'kimi-slot-1',
    '--kind', 'kimi',
    '--model', 'kimi-code/k3-256k',
    '--plans', 'plan-a,plan-b,plan-a',
    '--command', command,
    '--lock-dir', join(dir, 'locks'),
    '--runtime-dir', repoRoot,
  ];
}

function run(dir: string, command: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, baseArgs(dir, command), {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      BIAO_API_TOKEN: 'must-not-reach-worker-agent',
      BIAO_REDIS_URL: 'redis://secret-host:6379/0',
      BIAO_CLAIM_TOKEN: 'must-not-reach-worker-agent',
      ...extraEnv,
    },
  });
}

describe('按需 Worker Agent 唤醒器', () => {
  it('用无凭据的最小门铃启动含空格路径的本地 Worker 命令', () => {
    const dir = tempDir();
    const capture = join(dir, 'capture.json');
    const adapter = writeAdapter(dir, `
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  wake: JSON.parse(readFileSync(0, 'utf8')),
  token: process.env.BIAO_API_TOKEN ?? null,
  redis: process.env.BIAO_REDIS_URL ?? null,
  claim: process.env.BIAO_CLAIM_TOKEN ?? null,
  runtimeDir: process.env.BIAO_RUNTIME_DIR ?? null,
  argv: process.argv.slice(2),
}), 'utf8');
`);

    const result = run(dir, adapter);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const captured = JSON.parse(readFileSync(capture, 'utf8')) as Record<string, any>;
    expect(captured.wake).toEqual({
      protocol: 'biao.worker-wake/v1',
      biaoUrl: 'http://127.0.0.1:7331',
      slotId: 'kimi-slot-1',
      selector: {
        kind: 'kimi',
        model: 'kimi-code/k3-256k',
        planIds: ['plan-a', 'plan-b'],
      },
    });
    expect(captured).toMatchObject({
      token: null,
      redis: null,
      claim: null,
      runtimeDir: repoRoot,
      argv: [],
    });
    expect(JSON.stringify(captured.wake)).not.toContain('taskId');
    expect(JSON.stringify(captured.wake)).not.toContain('goal');
  });

  it('Worker 命令非零退出时返回可重试退出码', () => {
    const dir = tempDir();
    const adapter = writeAdapter(dir, 'process.exit(17);');

    const result = run(dir, adapter);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('Worker 命令退出码 17');
  });

  it('拒绝相对路径、符号链接和非法 selector', () => {
    const dir = tempDir();
    const adapter = writeAdapter(dir, 'process.exit(0);', 'real-adapter.mjs');
    const linked = join(dir, 'linked-adapter.mjs');
    symlinkSync(adapter, linked);

    const relative = run(dir, './relative-adapter.mjs');
    expect(relative.status).toBe(3);
    expect(relative.stderr).toContain('--command 必须是绝对路径');

    const symlink = run(dir, linked);
    expect(symlink.status).toBe(3);
    expect(symlink.stderr).toContain('不能是符号链接');

    const invalidSelector = spawnSync(process.execPath, [
      ...baseArgs(dir, adapter),
      '--plan', 'bad\nplan',
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(invalidSelector.status).toBe(3);
    expect(invalidSelector.stderr).toContain('planId 非法');
  });

  it('同一个 slot 并发唤醒时最多启动一个本地子进程', async () => {
    const dir = tempDir();
    const started = join(dir, 'started');
    const adapter = writeAdapter(dir, `
import { appendFileSync, readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(started)}, 'started\\n');
await new Promise((resolve) => setTimeout(resolve, 500));
`);
    const args = baseArgs(dir, adapter);

    const first = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'ignore' });
    const deadline = Date.now() + 2_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(started)).toBe(true);

    const second = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
    expect(second.status).toBe(4);

    const firstExit = await new Promise<number | null>((resolve) => first.once('close', resolve));
    expect(firstExit).toBe(0);
    expect(readFileSync(started, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('帮助中公开陌生 Agent 可实现的门铃和重试契约', () => {
    const result = spawnSync(process.execPath, [workerAgentBin, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('biao.worker-wake/v1');
    expect(result.stdout).toContain('stdin');
    expect(result.stdout).toContain('不包含任务详情或凭据');
    expect(result.stdout).toContain('非零');
  });
});
