import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-codex-pm-agent-'));
  tempDirs.push(dir);
  return dir;
}

function fakeCodex(dir: string, exitCode = 0): { bin: string; capture: string } {
  const bin = join(dir, 'fake-codex.mjs');
  const capture = join(dir, 'capture.json');
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin: readFileSync(0, 'utf8'),
  apiToken: process.env.BIAO_API_TOKEN ?? null,
  redisUrl: process.env.BIAO_REDIS_URL ?? null,
}), 'utf8');
process.exit(${exitCode});
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, capture };
}

function run(input: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [adapter], {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      BIAO_API_TOKEN: 'must-not-cross-into-codex',
      BIAO_REDIS_URL: 'redis://secret-host:6379',
      ...env,
    },
  });
}

describe('Codex PM Agent adapter', () => {
  it('把最小门铃转换为可执行 PM 契约，并用临时 Codex 会话处理', () => {
    const dir = tempDir();
    const { bin, capture } = fakeCodex(dir);
    const result = run(`${JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { question_asked: 1, review_requested: 1 },
      count: 2,
    })}\n`, {
      BIAO_CODEX_BIN: bin,
      BIAO_PREFERRED_PROJECT: dir,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(capture)).toBe(true);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as {
      argv: string[];
      stdin: string;
      apiToken: string | null;
      redisUrl: string | null;
    };
    expect(invoked.argv).toContain('exec');
    expect(invoked.argv).toContain('--ephemeral');
    expect(invoked.argv).toContain('--skip-git-repo-check');
    expect(invoked.argv).toContain('--ignore-user-config');
    expect(invoked.argv).toContain('--ignore-rules');
    expect(invoked.argv).toContain('sandbox_workspace_write.network_access=true');
    expect(invoked.argv).toContain('model_reasoning_effort="high"');
    expect(invoked.argv).toContain('--add-dir');
    expect(invoked.argv).toContain(dir);
    expect(invoked.stdin).toContain('plan-one');
    expect(invoked.stdin).toContain('.biao/pm-start --once');
    expect(invoked.stdin).toContain('question list');
    expect(invoked.stdin).toContain("question list --consumer 'pm-a' --status open --plan 'plan-one'");
    expect(invoked.stdin).toContain("question get <question_id> --consumer 'pm-a' --plan 'plan-one'");
    expect(invoked.stdin).toContain("question answer <question_id> --consumer 'pm-a' --plan 'plan-one'");
    expect(invoked.stdin).toContain("pm unacked --consumer 'pm-a' --plan 'plan-one' --type question_asked --json");
    expect(invoked.stdin).toContain("pm ack --consumer 'pm-a' --plan 'plan-one' --event-id <asked_event_id>");
    expect(invoked.stdin).toContain('question answer');
    expect(invoked.stdin).toContain('review');
    expect(invoked.stdin).toContain('.biao/pm task resolution <task_id>');
    expect(invoked.stdin).toContain('--action continue');
    expect(invoked.stdin).toContain('--action cancel');
    expect(invoked.stdin).toContain('只有 continue/cancel 成功后才 ack');
    expect(invoked.stdin).toContain('.biao/pm task get <task_id>');
    expect(invoked.stdin).toContain('.biao/pm task resume <task_id>');
    expect(invoked.stdin).toContain('.biao/pm watchdog --auto-fix');
    expect(invoked.stdin).toContain('waiting_dependency / waiting_file_release');
    expect(invoked.stdin).toContain('条件已经消失');
    expect(invoked.stdin).toContain('真正无法自治');
    expect(invoked.stdin).toContain('实际处置完成后');
    expect(invoked.stdin).toContain('ack');
    expect(invoked.stdin).toContain('不要向当前人类提问');
    expect(invoked.stdin).toContain('必须直接使用 shell/exec');
    expect(invoked.stdin).toContain('禁止使用 Computer Use');
    expect(invoked.stdin).toContain('不要读取或调用任何 skill');
    expect(invoked.stdin).toContain('不得改用浏览器');
    expect(invoked.apiToken).toBeNull();
    expect(invoked.redisUrl).toBeNull();
  });

  it('拒绝畸形或扩权的唤醒载荷，不启动 Codex', () => {
    const dir = tempDir();
    const { bin, capture } = fakeCodex(dir);
    const result = run(JSON.stringify({
      biaoUrl: 'file:///tmp/steal',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: {},
      count: 1,
      taskBody: '不得透传任务正文',
    }), { BIAO_CODEX_BIN: bin });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('门铃载荷');
    expect(existsSync(capture)).toBe(false);
  });

  it('把门铃 Plan 范围传给 PM 启动，并逐 Plan 读取 intake，避免混入其它计划', () => {
    const dir = tempDir();
    const { bin, capture } = fakeCodex(dir);
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one', 'plan-two'],
      kinds: { review_requested: 2 },
      count: 2,
    }), { BIAO_CODEX_BIN: bin });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { stdin: string };
    expect(invoked.stdin).toContain(".biao/pm-start --once --consumer 'pm-a' --plans 'plan-one,plan-two'");
    expect(invoked.stdin).toContain(".biao/pm pm intake --consumer 'pm-a' --plan 'plan-one'");
    expect(invoked.stdin).toContain(".biao/pm pm intake --consumer 'pm-a' --plan 'plan-two'");
    expect(invoked.stdin).toContain("question list --consumer 'pm-a' --status open --plan 'plan-two'");
    expect(invoked.stdin).toContain("pm unacked --consumer 'pm-a' --plan 'plan-two' --type question_asked --json");
    expect(invoked.stdin).not.toContain('.biao/pm pm intake --consumer pm-a` 主动读取详情');
  });

  it('Codex 执行失败时原样返回非零，交给共享 Supervisor 下轮重试', () => {
    const dir = tempDir();
    const { bin } = fakeCodex(dir, 7);
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), { BIAO_CODEX_BIN: bin });

    expect(result.status).toBe(7);
    expect(result.stderr).toContain('Codex PM Agent 未完成');
  });
});
