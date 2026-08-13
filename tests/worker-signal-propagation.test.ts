import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexWorkerConfig } from '../src/worker/codex.js';
import { createKimiWorkerConfig } from '../src/worker/kimi.js';
import { createCliWorkerConfig } from '../src/worker/cli.js';
import type { ClaimedTask } from '../src/types/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-worker-signal-'));
  tempDirs.push(dir);
  return dir;
}

function createCooperativeAgent(root: string, name: string): { executable: string; ready: string; term: string } {
  const executable = join(root, `${name}.mjs`);
  const ready = join(root, `${name}.ready`);
  const term = join(root, `${name}.term`);
  writeFileSync(executable, `#!/usr/bin/env node
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {
      writeFileSync(${JSON.stringify(term)}, 'term');
      process.exit(0);
    });
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setTimeout(() => process.exit(0), 2500);
    setInterval(() => {}, 1000);
  `, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { executable, ready, term };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`等待文件超时：${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function task(projectPath: string): ClaimedTask {
  return {
    task_id: 'signal-task', title: 'signal task', type: 'code', phase: 'impl', priority: 5,
    ownership_files: [], goal_md: '# signal', timeout_seconds: 20, claim_token: 'token', verify: [],
    project_path: projectPath, plan_id: 'signal-plan',
  };
}

describe('built-in Worker signal propagation', () => {
  it('Codex/Kimi/custom execute 都把 Worker AbortSignal 传给真实 CLI 子进程', async () => {
    const root = createTempDir();
    const originalCodexBin = process.env.BIAO_CODEX_BIN;
    const cases = [
      {
        name: 'codex',
        create: (executable: string) => {
          process.env.BIAO_CODEX_BIN = executable;
          return createCodexWorkerConfig({ agentId: 'signal-codex' });
        },
      },
      {
        name: 'kimi',
        create: (executable: string) => createKimiWorkerConfig({ agentId: 'signal-kimi', kimiBin: executable }),
      },
      {
        name: 'custom',
        create: (executable: string) => createCliWorkerConfig({
          agentId: 'signal-custom', execCmd: `${process.execPath} ${executable}`,
        }),
      },
    ];

    try {
      for (const item of cases) {
        const agent = createCooperativeAgent(root, item.name);
        const config = item.create(agent.executable);
        const controller = new AbortController();
        const executing = config.execute(task(root), root, controller.signal);
        await Promise.race([
          waitForFile(agent.ready),
          executing.then((result) => {
            throw new Error(`${item.name} 在 ready 前退出：${JSON.stringify(result.run)}`);
          }),
        ]);
        controller.abort();
        const result = await executing;

        expect(result.run, item.name).toMatchObject({ aborted: true, timedOut: false, exitCode: 130 });
        expect(existsSync(agent.term), item.name).toBe(true);
      }
    } finally {
      if (originalCodexBin === undefined) delete process.env.BIAO_CODEX_BIN;
      else process.env.BIAO_CODEX_BIN = originalCodexBin;
    }
  }, 12_000);
});
