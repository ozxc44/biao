import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const adapter = join(repoRoot, 'scripts', 'codex-pm-agent.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function generatedCodexPrompt(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-parallel-prompt-'));
  tempDirs.push(dir);
  const runtimeDir = join(dir, 'runtime');
  mkdirSync(runtimeDir);
  for (const launcher of ['pm-start', 'pm']) {
    const path = join(runtimeDir, launcher);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const capture = join(dir, 'prompt.txt');
  const fakeCodex = join(dir, 'fake-codex.mjs');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, readFileSync(0, 'utf8'));
`, { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);

  const result = spawnSync(process.execPath, [adapter], {
    cwd: repoRoot,
    input: JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-test',
      planIds: ['parallel-plan'],
      kinds: { review_requested: 1 },
      count: 1,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      BIAO_CODEX_BIN: fakeCodex,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
    },
  });
  expect(result.status).toBe(0);
  return readFileSync(capture, 'utf8');
}

describe('PM 并行拆解提示', () => {
  it('一次性 Codex PM 提示以安全 ownership 约束首波 3–4 条实现 lane', () => {
    const prompt = generatedCodexPrompt();

    expect(prompt).toContain('lane ID、硬依赖、ownership、交付物、验证命令和验收者');
    expect(prompt).toContain('首波目标 3–4 条互不重叠的实现 lane');
    expect(prompt).toContain('48 个任务却只有 1 个首波 runnable 实现 lane');
    expect(prompt).toContain('不得提交该 DAG');
    expect(prompt).toContain('同一文件、模块或共享入口同时只能有一个写入者');
    expect(prompt).toContain('真实消费者');
    expect(prompt).toContain('同 phase、同里程碑或同优先级都不是依赖理由');
    expect(prompt).toContain('fan-in 汇合点');
    expect(prompt).toContain('全局阶段栅栏');
    expect(prompt).toContain('只读分析与测试');
    expect(prompt).toContain('review、Question 和 stale');
    expect(prompt).toContain('Worker 数大于 runnable 数');
    expect(prompt).toContain('runnable 数大于 Worker 数');
  });

  it('并行规划文档保留 done/accepted、Question、repair 与 ack 铁律', () => {
    const guide = readFileSync(join(repoRoot, 'docs', 'pm-parallel-planning.md'), 'utf8');

    expect(guide).toContain('done');
    expect(guide).toContain('accepted');
    expect(guide).toContain('Question');
    expect(guide).toContain('repair');
    expect(guide).toContain('ack');
    expect(guide).toContain('fan-in');
    expect(guide).toContain('不得提交该 DAG');
    expect(guide).toContain('同一文件、模块或共享入口同时只能有一个写入者');
  });
});
