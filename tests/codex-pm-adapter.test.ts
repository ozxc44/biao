import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  cwd: process.cwd(),
  apiToken: process.env.BIAO_API_TOKEN ?? null,
  redisUrl: process.env.BIAO_REDIS_URL ?? null,
}), 'utf8');
process.exit(${exitCode});
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, capture };
}

function fakeRuntime(dir: string, name = 'runtime'): string {
  const runtimeDir = join(dir, name);
  mkdirSync(runtimeDir);
  for (const launcher of ['pm-start', 'pm']) {
    const path = join(runtimeDir, launcher);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  return runtimeDir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function run(input: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [adapter], {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      BIAO_PM_TARGET: undefined,
      BIAO_PM_THREAD_ID: undefined,
      BIAO_API_TOKEN: 'must-not-cross-into-codex',
      BIAO_REDIS_URL: 'redis://secret-host:6379',
      ...env,
    },
  });
}

describe('Codex PM Agent adapter', () => {
  it('Supervisor 的通用 PM target 能恢复对应 Codex 会话', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    const threadId = '019ffe19-fc41-7c53-bb7d-4746b1ae583f';
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-routed'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
      BIAO_PM_TARGET: threadId,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[] };
    expect(invoked.argv).toContain('resume');
    expect(invoked.argv).toContain(threadId);
    expect(invoked.argv).not.toContain('--ephemeral');
  });

  it('Plan 路由 target 优先于兼容的全局 PM thread，避免唤醒错会话', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    const routedThreadId = '019ffe19-fc41-7c53-bb7d-4746b1ae583f';
    const legacyThreadId = '019aaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-routed'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
      BIAO_PM_TARGET: routedThreadId,
      BIAO_PM_THREAD_ID: legacyThreadId,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[] };
    expect(invoked.argv).toContain(routedThreadId);
    expect(invoked.argv).not.toContain(legacyThreadId);
  });

  it('配置原 PM 会话时必须 resume 该会话，不能另起 ephemeral 会话', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    const threadId = '019ffe19-fc41-7c53-bb7d-4746b1ae583f';
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
      BIAO_PM_THREAD_ID: threadId,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string };
    expect(invoked.argv).toContain('exec');
    expect(invoked.argv).toContain('resume');
    expect(invoked.argv).toContain(threadId);
    expect(invoked.argv).toContain('-');
    expect(invoked.argv).not.toContain('--ephemeral');
    expect(invoked.argv).toContain('mcp_servers={}');
    expect(invoked.argv).toContain('plugins={}');
    expect(invoked.argv).toContain('apps._default.enabled=false');
    expect(invoked.argv).toContain('features.apps=false');
    expect(invoked.argv).toContain('features.plugins=false');
    expect(invoked.stdin).toContain('plan-one');
  });

  it('把最小门铃转换为可执行 PM 契约，并用临时 Codex 会话处理', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    const result = run(`${JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { question_asked: 1, review_requested: 1 },
      count: 2,
    })}\n`, {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
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
    expect(invoked.argv).toContain(realpathSync(dir));
    expect(invoked.stdin).toContain('plan-one');
    const canonicalRuntime = realpathSync(runtimeDir);
    const pmStartLauncher = shellQuote(join(canonicalRuntime, 'pm-start'));
    const pmLauncher = shellQuote(join(canonicalRuntime, 'pm'));
    expect(invoked.stdin).toContain(`${pmStartLauncher} --once`);
    expect(invoked.stdin).toContain('question list');
    expect(invoked.stdin).toContain("question list --consumer 'pm-a' --status open --plan 'plan-one'");
    expect(invoked.stdin).toContain("question get <question_id> --consumer 'pm-a' --plan 'plan-one'");
    expect(invoked.stdin).toContain("question answer <question_id> --consumer 'pm-a' --plan 'plan-one'");
    expect(invoked.stdin).toContain('--approve-ownership');
    expect(invoked.stdin).toContain('--reject-ownership');
    expect(invoked.stdin).toContain('requested_ownership');
    expect(invoked.stdin).toContain('不得在缺少所有权决定时反复调用 answer');
    expect(invoked.stdin).toContain("pm unacked --consumer 'pm-a' --plan 'plan-one' --type question_asked --json");
    expect(invoked.stdin).toContain("pm ack --consumer 'pm-a' --plan 'plan-one' --event-id <asked_event_id>");
    expect(invoked.stdin).toContain('question answer');
    expect(invoked.stdin).toContain('review');
    expect(invoked.stdin).toContain('`reverify-only` 只允许 type=acceptance');
    expect(invoked.stdin).toContain('多来源 acceptance 若发现具体产品缺陷');
    expect(invoked.stdin).toContain('正常 reject 会先冻结拒绝审计');
    expect(invoked.stdin).toContain('普通 code/docs/research 任务');
    expect(invoked.stdin).toContain(`${pmLauncher} task resolution <task_id>`);
    expect(invoked.stdin).toContain('task resolution 不接受 --plan');
    expect(invoked.stdin).toContain('task resolution <task_id> --action inspect');
    expect(invoked.stdin).toContain('--repair-source-task <inspect 返回的合法来源>');
    expect(invoked.stdin).toContain('来源当前显示 accepted/resolved');
    expect(invoked.stdin).toContain('不得因“缺少新证据”“来源已解决”或“以前是空交付”保留同一门铃空转');
    expect(invoked.stdin).toContain('--action continue');
    expect(invoked.stdin).toContain('--action cancel');
    expect(invoked.stdin).toContain('只有 continue/cancel 成功后才 ack');
    expect(invoked.stdin).toContain(`${pmLauncher} task get <task_id>`);
    expect(invoked.stdin).toContain(`${pmLauncher} task resume <task_id>`);
    expect(invoked.stdin).toContain(`${pmLauncher} watchdog --auto-fix`);
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
    expect(invoked.stdin).toContain('pm intake 在“无待处理事项”时约定退出码为 2');
    expect(invoked.stdin).toContain('exit 2 是 drained 成功');
    expect(invoked.stdin).toContain('首波目标 3–4 条互不重叠的实现 lane');
    expect(invoked.stdin).toContain('不得提交该 DAG');
    expect(invoked.stdin).toContain('同一文件、模块或共享入口同时只能有一个写入者');
    expect(invoked.apiToken).toBeNull();
    expect(invoked.redisUrl).toBeNull();
  });

  it('从外置 runtime 启动，并在提示中只使用该 runtime 的绝对 launcher', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir, "runtime state with ' quote");
    const { bin, capture } = fakeCodex(dir);
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as {
      argv: string[];
      stdin: string;
      cwd: string;
    };
    const canonicalRuntime = realpathSync(runtimeDir);
    expect(invoked.argv[invoked.argv.indexOf('-C') + 1]).toBe(canonicalRuntime);
    expect(invoked.cwd).toBe(canonicalRuntime);
    expect(invoked.stdin).toContain(`${shellQuote(join(canonicalRuntime, 'pm-start'))} --once`);
    expect(invoked.stdin).toContain(`${shellQuote(join(canonicalRuntime, 'pm'))} pm intake`);
    expect(invoked.stdin).not.toContain('.biao/pm-start');
    expect(invoked.stdin).not.toContain('.biao/pm ');
  });

  it('固定符号链接祖先解析后的 canonical runtime 路径', () => {
    const dir = tempDir();
    const realParent = join(dir, 'real-parent');
    mkdirSync(realParent);
    const realRuntime = fakeRuntime(realParent, 'runtime');
    const linkedParent = join(dir, 'linked-parent');
    symlinkSync(realParent, linkedParent);
    const configuredRuntime = join(linkedParent, 'runtime');
    const { bin, capture } = fakeCodex(dir);

    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: configuredRuntime,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[]; stdin: string; cwd: string };
    const canonical = realpathSync(realRuntime);
    expect(invoked.cwd).toBe(canonical);
    expect(invoked.argv[invoked.argv.indexOf('-C') + 1]).toBe(canonical);
    expect(invoked.stdin).toContain(shellQuote(join(canonical, 'pm-start')));
    expect(invoked.stdin).not.toContain(configuredRuntime);
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

  it('拒绝 runtime 中的符号链接 launcher，不启动 Codex', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    rmSync(join(runtimeDir, 'pm'));
    symlinkSync(join(runtimeDir, 'pm-start'), join(runtimeDir, 'pm'));

    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), { BIAO_CODEX_BIN: bin, BIAO_RUNTIME_DIR: runtimeDir });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('runtime 配置无效');
    expect(result.stderr).toContain('符号链接');
    expect(existsSync(capture)).toBe(false);
  });

  it('把 project 与 workspace roots 固定后仅授予 canonical project', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const realWorkspace = join(dir, 'real-workspace');
    const realProject = join(realWorkspace, 'project');
    const linkedWorkspace = join(dir, 'linked-workspace');
    const secondRoot = join(dir, 'second-root');
    mkdirSync(realProject, { recursive: true });
    mkdirSync(secondRoot);
    symlinkSync(realWorkspace, linkedWorkspace);
    const configuredProject = join(linkedWorkspace, 'project');
    const { bin, capture } = fakeCodex(dir);

    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: configuredProject,
      BIAO_WORKSPACE_ROOTS: [linkedWorkspace, secondRoot].join(delimiter),
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { argv: string[] };
    expect(invoked.argv[invoked.argv.indexOf('--add-dir') + 1]).toBe(realpathSync(realProject));
    expect(invoked.argv).not.toContain(configuredProject);
    expect(invoked.argv).not.toContain(realpathSync(realWorkspace));
  });

  it('拒绝通过 project 最终符号链接逃出 canonical workspace roots', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const workspace = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    const projectLink = join(workspace, 'project-link');
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, projectLink);
    const { bin, capture } = fakeCodex(dir);

    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: projectLink,
      BIAO_WORKSPACE_ROOTS: workspace,
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('workspace 配置无效');
    expect(result.stderr).toContain('project 必须位于 workspace roots 内');
    expect(existsSync(capture)).toBe(false);
  });

  it('拒绝通过 project 祖先符号链接逃出 canonical workspace roots', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const workspace = join(dir, 'workspace');
    const outsideParent = join(dir, 'outside-parent');
    const outsideProject = join(outsideParent, 'project');
    const linkedParent = join(workspace, 'linked-parent');
    mkdirSync(workspace);
    mkdirSync(outsideProject, { recursive: true });
    symlinkSync(outsideParent, linkedParent);
    const { bin, capture } = fakeCodex(dir);

    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: join(linkedParent, 'project'),
      BIAO_WORKSPACE_ROOTS: workspace,
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('workspace 配置无效');
    expect(result.stderr).toContain('project 必须位于 workspace roots 内');
    expect(existsSync(capture)).toBe(false);
  });

  it('把门铃 Plan 范围传给 PM 启动，并逐 Plan 读取 intake，避免混入其它计划', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin, capture } = fakeCodex(dir);
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one', 'plan-two'],
      kinds: { review_requested: 2 },
      count: 2,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
    });

    expect(result.status).toBe(0);
    const invoked = JSON.parse(readFileSync(capture, 'utf8')) as { stdin: string };
    const canonicalRuntime = realpathSync(runtimeDir);
    const pmStartLauncher = shellQuote(join(canonicalRuntime, 'pm-start'));
    const pmLauncher = shellQuote(join(canonicalRuntime, 'pm'));
    expect(invoked.stdin).toContain(`${pmStartLauncher} --once --consumer 'pm-a' --plans 'plan-one,plan-two'`);
    expect(invoked.stdin).toContain(`${pmLauncher} pm intake --consumer 'pm-a' --plan 'plan-one'`);
    expect(invoked.stdin).toContain(`${pmLauncher} pm intake --consumer 'pm-a' --plan 'plan-two'`);
    expect(invoked.stdin).toContain("question list --consumer 'pm-a' --status open --plan 'plan-two'");
    expect(invoked.stdin).toContain("pm unacked --consumer 'pm-a' --plan 'plan-two' --type question_asked --json");
    expect(invoked.stdin).not.toContain('.biao/pm pm intake --consumer pm-a` 主动读取详情');
  });

  it('Codex 执行失败时原样返回非零，交给共享 Supervisor 下轮重试', () => {
    const dir = tempDir();
    const runtimeDir = fakeRuntime(dir);
    const { bin } = fakeCodex(dir, 7);
    const result = run(JSON.stringify({
      biaoUrl: 'http://127.0.0.1:7331',
      consumer: 'pm-a',
      planIds: ['plan-one'],
      kinds: { review_requested: 1 },
      count: 1,
    }), {
      BIAO_CODEX_BIN: bin,
      BIAO_RUNTIME_DIR: runtimeDir,
      BIAO_PREFERRED_PROJECT: dir,
      BIAO_WORKSPACE_ROOTS: dir,
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toContain('Codex PM Agent 未完成');
  });
});
