import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePlanDir } from '../src/plan/parser.js';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];
const tempRoots: string[] = [];

type CliOutcome = {
  code: number;
  stdout: string;
  stderr: string;
};

type MockRequest = {
  method: string;
  path: string;
  body: unknown;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliOutcome> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, ...env },
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function mockService(
  responder: (request: MockRequest) => unknown | Promise<unknown>,
): Promise<{ url: string; requests: MockRequest[] }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    const request = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      body: await readBody(req),
    };
    requests.push(request);
    const response = await responder(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function makePlan(planId = 'p1'): string {
  const root = mkdtempSync(join(tmpdir(), 'biao-cli-planning-'));
  tempRoots.push(root);
  const planDir = join(root, 'plans', planId);
  mkdirSync(join(planDir, 'tasks'), { recursive: true });
  writeFileSync(join(planDir, 'index.md'), `---
plan_id: ${planId}
title: CLI 产品化
project_path: ${root}
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
  - id: qa
    name: 验收
---

# CLI 产品化
`);
  return root;
}

function writeTask(root: string, taskId: string, options: { title?: string; body?: string; phase?: string } = {}): string {
  const path = join(root, 'plans', 'p1', 'tasks', `${taskId}.md`);
  writeFileSync(path, `---
task_id: ${taskId}
title: ${options.title ?? taskId}
type: code
phase: ${options.phase ?? 'impl'}
assignee: auto
priority: 5
timeout_seconds: 3600
verify: []
---

${options.body ?? '# 目标\n'}
`);
  return path;
}

function planResponse(root: string, buckets: Partial<Record<string, Array<Record<string, unknown>>>> = {}) {
  return {
    ok: true,
    data: {
      plan_id: 'p1',
      project_path: root,
      tasks: {
        pending: buckets.pending ?? [],
        running: buckets.running ?? [],
        blocked: buckets.blocked ?? [],
        done: buckets.done ?? [],
        failed: buckets.failed ?? [],
        cancelled: buckets.cancelled ?? [],
      },
    },
  };
}

describe('规划 CLI 的 Agent 机器合同', () => {
  it.each([
    [['plan', 'revise', '--help'], '--preview'],
    [['plan', 'intake', '--help'], '--text'],
    [['task', 'add', '--help'], '--task-id'],
    [['task', 'edit', '--help'], '--from-file'],
  ])('%j 输出具体帮助、零退出且不连接服务', async (args, expected) => {
    const outcome = await runCli(args, { BIAO_URL: 'http://127.0.0.1:1' });

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toContain(expected);
  });

  it.each([
    ['plan', 'intake'],
    ['task', 'edit'],
  ])('biao %s %s 的未知参数返回机器错误且不连接服务', async (group, command) => {
    const args = group === 'task'
      ? [group, command, 'edit-me', '--unknown', 'value', '--json']
      : [group, command, '--unknown', 'value', '--json'];
    const outcome = await runCli(args, { BIAO_URL: 'http://127.0.0.1:1' });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_OPTION' },
    });
  });

  it('plan intake --json 只输出一个稳定 JSON，并且同日同名需求不覆盖旧文件', async () => {
    const root = makePlan();
    const mock = await mockService(() => planResponse(root));

    const first = await runCli(['plan', 'intake', '--plan', 'p1', '--text', '新增邮件规则', '--json'], { BIAO_URL: mock.url });
    const second = await runCli(['plan', 'intake', '--plan', 'p1', '--text', '新增邮件规则', '--json'], { BIAO_URL: mock.url });

    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    const firstJson = JSON.parse(first.stdout);
    const secondJson = JSON.parse(second.stdout);
    expect(firstJson).toMatchObject({
      ok: true,
      data: { operation: 'plan_intake', plan_id: 'p1', stored: true },
    });
    expect(secondJson.data.intake_path).not.toBe(firstJson.data.intake_path);
    expect(readFileSync(firstJson.data.intake_path, 'utf8')).toContain('新增邮件规则');
    expect(readFileSync(secondJson.data.intake_path, 'utf8')).toContain('新增邮件规则');
  });

  it('plan intake 未提供文本时以机器错误退出，不声称未来编辑器会接管', async () => {
    const outcome = await runCli(['plan', 'intake', '--plan', 'p1', '--json'], {
      BIAO_URL: 'http://127.0.0.1:1',
    });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INTERACTIVE_INPUT_REQUIRED' },
    });
    expect(`${outcome.stdout}${outcome.stderr}`).not.toContain('v2 支持');
  });

  it('task add --json 生成可解析 MD、自动 submit，stdout 不混入人类提示', async () => {
    const root = makePlan();
    writeTask(root, 'base-task');
    const mock = await mockService((request) => {
      if (request.method === 'GET' && request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'base-task', status: 'pending' }],
      });
      if (request.method === 'GET' && request.path === '/task/new-task') return { ok: true, data: null };
      if (request.method === 'POST' && request.path === '/plan/submit') {
        return { ok: true, data: { plan_id: 'p1', created: 1, updated: 1, skipped_running: 0, skipped_done: 0 } };
      }
      return { ok: false, data: null, error: { code: 'UNEXPECTED', message: request.path } };
    });

    const outcome = await runCli([
      'task', 'add', '--plan', 'p1', '--task-id', 'new-task', '--title', '新增任务',
      '--phase', 'impl', '--depends-on', 'base-task', '--priority', '7', '--json',
    ], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    const result = JSON.parse(outcome.stdout);
    expect(result).toMatchObject({
      ok: true,
      data: {
        operation: 'task_add', plan_id: 'p1', task_id: 'new-task', submitted: true,
      },
    });
    expect(existsSync(result.data.task_path)).toBe(true);
    expect(parsePlanDir(join(root, 'plans', 'p1')).tasks.map((task) => task.fm.task_id)).toContain('new-task');
    expect(mock.requests.filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ path: '/plan/submit', body: { plan_dir: join(root, 'plans', 'p1') } }),
    ]);
  });

  it('task add 创建 acceptance 时缺少 verify 必须 fail-closed，不写文件不 submit', async () => {
    const root = makePlan();
    writeTask(root, 'base-task');
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'base-task', status: 'pending' }],
      });
      if (request.path === '/task/acceptance-task') return { ok: true, data: null };
      return { ok: true, data: {} };
    });

    const outcome = await runCli([
      'task', 'add', '--plan', 'p1', '--task-id', 'acceptance-task', '--title', '独立验收',
      '--type', 'acceptance', '--phase', 'qa', '--depends-on', 'base-task',
      '--acceptance-for', 'base-task', '--json',
    ], { BIAO_URL: mock.url });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'ACCEPTANCE_VERIFY_REQUIRED' },
    });
    expect(existsSync(join(root, 'plans', 'p1', 'tasks', 'acceptance-task.md'))).toBe(false);
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('task add 接受可重复 --verify-cmd，生成有序的结构化 verify', async () => {
    const root = makePlan();
    writeTask(root, 'base-task');
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'base-task', status: 'pending' }],
      });
      if (request.path === '/task/acceptance-task') return { ok: true, data: null };
      if (request.path === '/plan/submit') return { ok: true, data: { created: 1 } };
      return { ok: false, data: null, error: { code: 'UNEXPECTED', message: request.path } };
    });

    const outcome = await runCli([
      'task', 'add', '--plan', 'p1', '--task-id', 'acceptance-task', '--title', '独立验收',
      '--type', 'acceptance', '--phase', 'qa', '--depends-on', 'base-task',
      '--acceptance-for', 'base-task',
      '--verify-cmd', 'npm test -- auth',
      '--verify-cmd', 'npm run typecheck',
      '--json',
    ], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    const parsed = parsePlanDir(join(root, 'plans', 'p1'));
    expect(parsed.tasks.find((task) => task.fm.task_id === 'acceptance-task')?.fm.verify).toEqual([
      { cmd: 'npm test -- auth', expect_exit: 0 },
      { cmd: 'npm run typecheck', expect_exit: 0 },
    ]);
  });

  it.each([
    [['--priority', '10'], 'INVALID_PRIORITY'],
    [['--phase', 'missing'], 'INVALID_PHASE'],
    [['--depends-on', 'missing-task'], 'INVALID_DEPENDENCY'],
    [['--unknown', 'value'], 'UNKNOWN_OPTION'],
  ])('task add 拒绝无效参数 %j，且不写文件、不 submit', async (extra, code) => {
    const root = makePlan();
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root);
      if (request.path === '/task/new-task') return { ok: true, data: null };
      return { ok: true, data: {} };
    });

    const outcome = await runCli([
      'task', 'add', '--plan', 'p1', '--task-id', 'new-task', '--title', '新增任务', '--json', ...extra,
    ], { BIAO_URL: mock.url });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ ok: false, error: { code } });
    expect(existsSync(join(root, 'plans', 'p1', 'tasks', 'new-task.md'))).toBe(false);
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('task edit 在无 TTY 且无显式编辑来源时明确拒绝，不启动 vi', async () => {
    const root = makePlan();
    writeTask(root, 'edit-me');
    const mock = await mockService(() => ({
      ok: true,
      data: { task_id: 'edit-me', plan_id: 'p1', project_path: root, status: 'pending' },
    }));

    const outcome = await runCli(['task', 'edit', 'edit-me', '--json'], {
      BIAO_URL: mock.url,
      EDITOR: '',
      VISUAL: '',
    });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'INTERACTIVE_EDITOR_REQUIRED' },
    });
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('task edit --from-file 提供无 TTY 的安全编辑、JSON 和自动 submit 路径', async () => {
    const root = makePlan();
    const taskPath = writeTask(root, 'edit-me', { title: '旧标题' });
    const replacementDir = mkdtempSync(join(tmpdir(), 'biao-cli-replacement-'));
    tempRoots.push(replacementDir);
    const replacement = join(replacementDir, 'replacement.md');
    writeFileSync(replacement, readFileSync(taskPath, 'utf8').replace('旧标题', '新标题'));
    const mock = await mockService((request) => {
      if (request.path === '/task/edit-me') {
        return { ok: true, data: { task_id: 'edit-me', plan_id: 'p1', project_path: root, status: 'pending' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'edit-me', status: 'pending' }],
      });
      return { ok: true, data: { plan_id: 'p1', updated: 1, created: 0 } };
    });

    const outcome = await runCli(['task', 'edit', 'edit-me', '--from-file', replacement, '--json'], {
      BIAO_URL: mock.url,
      EDITOR: '',
    });

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: { operation: 'task_edit', task_id: 'edit-me', submitted: true, source: 'file' },
    });
    expect(readFileSync(taskPath, 'utf8')).toContain('新标题');
    expect(mock.requests.some((request) => request.method === 'POST' && request.path === '/plan/submit')).toBe(true);
  });

  it('task edit 可用可重复 --verify-cmd 直接修复历史 acceptance 的空 verify', async () => {
    const root = makePlan();
    writeTask(root, 'base-task');
    const taskPath = join(root, 'plans', 'p1', 'tasks', 'acceptance-task.md');
    writeFileSync(taskPath, `---
task_id: acceptance-task
title: 独立验收
type: acceptance
phase: qa
assignee: auto
depends_on:
  - base-task
acceptance_for:
  - base-task
verify: []
---

# 独立验收
`);
    const mock = await mockService((request) => {
      if (request.path === '/task/acceptance-task') {
        return { ok: true, data: { task_id: 'acceptance-task', plan_id: 'p1', project_path: root, status: 'pending' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [
          { task_id: 'base-task', status: 'pending' },
          { task_id: 'acceptance-task', status: 'pending' },
        ],
      });
      return { ok: true, data: { plan_id: 'p1', updated: 1 } };
    });

    const outcome = await runCli([
      'task', 'edit', 'acceptance-task',
      '--verify-cmd', 'npm test -- auth',
      '--verify-cmd', 'npm run typecheck',
      '--json',
    ], { BIAO_URL: mock.url, EDITOR: '' });

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: { operation: 'task_edit', task_id: 'acceptance-task', source: 'verify' },
    });
    expect(parsePlanDir(join(root, 'plans', 'p1')).tasks
      .find((task) => task.fm.task_id === 'acceptance-task')?.fm.verify).toEqual([
      { cmd: 'npm test -- auth', expect_exit: 0 },
      { cmd: 'npm run typecheck', expect_exit: 0 },
    ]);
  });

  it('task edit 把任务改为 acceptance 却不声明 verify 时回滚且不 submit', async () => {
    const root = makePlan();
    writeTask(root, 'base-task');
    const taskPath = writeTask(root, 'edit-me');
    const original = readFileSync(taskPath, 'utf8');
    const replacementDir = mkdtempSync(join(tmpdir(), 'biao-cli-replacement-'));
    tempRoots.push(replacementDir);
    const replacement = join(replacementDir, 'replacement.md');
    writeFileSync(replacement, original
      .replace('type: code', 'type: acceptance')
      .replace('verify: []', 'acceptance_for:\n  - base-task\nverify: []'));
    const mock = await mockService((request) => {
      if (request.path === '/task/edit-me') {
        return { ok: true, data: { task_id: 'edit-me', plan_id: 'p1', project_path: root, status: 'pending' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [
          { task_id: 'base-task', status: 'pending' },
          { task_id: 'edit-me', status: 'pending' },
        ],
      });
      return { ok: true, data: { plan_id: 'p1', updated: 1 } };
    });

    const outcome = await runCli([
      'task', 'edit', 'edit-me', '--from-file', replacement, '--json',
    ], { BIAO_URL: mock.url, EDITOR: '' });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'TASK_EDIT_INVALID', details: { rolled_back: true } },
    });
    expect(readFileSync(taskPath, 'utf8')).toBe(original);
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('task edit 提交失败时恢复原文件并返回非零 JSON', async () => {
    const root = makePlan();
    const taskPath = writeTask(root, 'edit-me', { title: '不可丢失的旧标题' });
    const original = readFileSync(taskPath, 'utf8');
    const replacementDir = mkdtempSync(join(tmpdir(), 'biao-cli-replacement-'));
    tempRoots.push(replacementDir);
    const replacement = join(replacementDir, 'replacement.md');
    writeFileSync(replacement, original.replace('不可丢失的旧标题', '提交失败的新标题'));
    const mock = await mockService((request) => {
      if (request.path === '/task/edit-me') {
        return { ok: true, data: { task_id: 'edit-me', plan_id: 'p1', project_path: root, status: 'pending' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'edit-me', status: 'pending' }],
      });
      return { ok: false, data: null, error: { code: 'PLAN_PARSE_ERROR', message: '提交失败' } };
    });

    const outcome = await runCli(['task', 'edit', 'edit-me', '--from-file', replacement, '--json'], {
      BIAO_URL: mock.url,
      EDITOR: '',
    });

    expect(outcome.code).not.toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      error: { code: 'TASK_EDIT_SUBMIT_FAILED', details: { rolled_back: true } },
    });
    expect(readFileSync(taskPath, 'utf8')).toBe(original);
  });

  it('task add 可依赖服务端保护 cancelled/blocked 历史并继续新增', async () => {
    const root = makePlan();
    writeTask(root, 'cancelled-task');
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root, {
        cancelled: [{ task_id: 'cancelled-task', status: 'cancelled' }],
      });
      if (request.path === '/task/new-task') return { ok: true, data: null };
      return { ok: true, data: { created: 1, skipped_cancelled: 1, skipped_blocked: 0 } };
    });

    const outcome = await runCli([
      'task', 'add', '--plan', 'p1', '--task-id', 'new-task', '--title', '不能误复活旧任务', '--json',
    ], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: { submitted: true, submit: { created: 1, skipped_cancelled: 1 } },
    });
    expect(existsSync(join(root, 'plans', 'p1', 'tasks', 'new-task.md'))).toBe(true);
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(true);
  });

  it('task edit 可依赖服务端跳过 cancelled MD，并只更新目标 pending 任务', async () => {
    const root = makePlan();
    const taskPath = writeTask(root, 'edit-me', { title: '保持原样' });
    const original = readFileSync(taskPath, 'utf8');
    writeTask(root, 'cancelled-task');
    const replacementDir = mkdtempSync(join(tmpdir(), 'biao-cli-replacement-'));
    tempRoots.push(replacementDir);
    const replacement = join(replacementDir, 'replacement.md');
    writeFileSync(replacement, original.replace('保持原样', '不应落盘'));
    const mock = await mockService((request) => {
      if (request.path === '/task/edit-me') {
        return { ok: true, data: { task_id: 'edit-me', plan_id: 'p1', project_path: root, status: 'pending' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'edit-me', status: 'pending' }],
        cancelled: [{ task_id: 'cancelled-task', status: 'cancelled' }],
      });
      return { ok: true, data: { updated: 1, skipped_cancelled: 1 } };
    });

    const outcome = await runCli(['task', 'edit', 'edit-me', '--from-file', replacement, '--json'], {
      BIAO_URL: mock.url,
      EDITOR: '',
    });

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: { submitted: true, submit: { updated: 1, skipped_cancelled: 1 } },
    });
    expect(readFileSync(taskPath, 'utf8')).toContain('不应落盘');
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(true);
  });

  it('task edit --force 对 running 只提交本地修改，并在 JSON 中明确平台不会覆盖', async () => {
    const root = makePlan();
    const taskPath = writeTask(root, 'running-task', { title: '运行中旧标题' });
    const replacementDir = mkdtempSync(join(tmpdir(), 'biao-cli-replacement-'));
    tempRoots.push(replacementDir);
    const replacement = join(replacementDir, 'replacement.md');
    writeFileSync(replacement, readFileSync(taskPath, 'utf8').replace('运行中旧标题', '仅本地新标题'));
    const mock = await mockService((request) => {
      if (request.path === '/task/running-task') {
        return { ok: true, data: { task_id: 'running-task', plan_id: 'p1', project_path: root, status: 'running' } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        running: [{ task_id: 'running-task', status: 'running' }],
      });
      return { ok: true, data: { updated: 0, skipped_running: 1 } };
    });

    const outcome = await runCli([
      'task', 'edit', 'running-task', '--from-file', replacement, '--force', '--json',
    ], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: {
        status: 'running',
        submitted: true,
        platform_update_expected: false,
        submit: { updated: 0, skipped_running: 1 },
      },
    });
    expect(readFileSync(taskPath, 'utf8')).toContain('仅本地新标题');
  });
});

describe('plan revise 的 preview / diff / submit 闭环', () => {
  function reviseFixture() {
    const root = makePlan();
    writeTask(root, 'pending-task', { title: '磁盘新标题', body: '# 磁盘新目标\n' });
    writeTask(root, 'new-task', { title: '新增任务' });
    const taskRecords: Record<string, unknown> = {
      'pending-task': {
        ok: true,
        data: {
          task_id: 'pending-task', plan_id: 'p1', title: 'Redis 旧标题', type: 'code', phase: 'impl',
          status: 'pending', assignee: 'auto', priority: 5, ownership: { files: [], modules: [] },
          depends_on: [], timeout_seconds: 3600, max_retries: 2, acceptance_for: [], verify: [],
          goal_md: '# Redis 旧目标\n', project_path: root,
        },
      },
      'running-only': {
        ok: true,
        data: {
          task_id: 'running-only', plan_id: 'p1', title: '运行中', type: 'code', phase: 'impl',
          status: 'running', assignee: 'auto', priority: 5, ownership: { files: [], modules: [] },
          depends_on: [], timeout_seconds: 3600, max_retries: 2, acceptance_for: [], verify: [],
          goal_md: '# 平台任务\n', project_path: root,
        },
      },
    };
    return { root, taskRecords };
  }

  it('plan revise --preview --json 给出可执行差异摘要且不 submit', async () => {
    const { root, taskRecords } = reviseFixture();
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'pending-task', status: 'pending' }],
        running: [{ task_id: 'running-only', status: 'running' }],
      });
      const taskId = decodeURIComponent(request.path.replace('/task/', ''));
      return taskRecords[taskId] ?? { ok: true, data: null };
    });

    const outcome = await runCli(['plan', 'revise', 'p1', '--preview', '--json'], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    const result = JSON.parse(outcome.stdout);
    expect(result).toMatchObject({
      ok: true,
      data: {
        operation: 'plan_revise', mode: 'preview', plan_id: 'p1',
        summary: { create: 1, update: 1, missing_local: 1 },
      },
    });
    expect(result.data.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: 'pending-task', action: 'update' }),
      expect.objectContaining({ task_id: 'new-task', action: 'create' }),
      expect.objectContaining({ task_id: 'running-only', action: 'missing_local' }),
    ]));
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('plan revise --diff 显示 Redis 与磁盘字段差异且不 submit', async () => {
    const { root, taskRecords } = reviseFixture();
    const mock = await mockService((request) => {
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'pending-task', status: 'pending' }],
        running: [{ task_id: 'running-only', status: 'running' }],
      });
      return taskRecords[decodeURIComponent(request.path.replace('/task/', ''))] ?? { ok: true, data: null };
    });

    const outcome = await runCli(['plan', 'revise', 'p1', '--diff'], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('pending-task');
    expect(outcome.stdout).toContain('- Redis title: Redis 旧标题');
    expect(outcome.stdout).toContain('+ 磁盘 title: 磁盘新标题');
    expect(outcome.stdout).toContain('running-only');
    expect(outcome.stdout).toContain('磁盘不存在；submit 不会删除平台任务');
    expect(outcome.stdout).toContain('[1] 重新 submit');
    expect(outcome.stdout).toContain('[2] 加新任务');
    expect(outcome.stdout).toContain('[3] 强制 reset running');
    expect(outcome.stdout).toContain('[4] 查看 diff');
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('plan revise --submit --json 先形成 preview 再调用现有 submit API，并返回单个 JSON', async () => {
    const { root, taskRecords } = reviseFixture();
    const mock = await mockService((request) => {
      if (request.method === 'POST') {
        return { ok: true, data: { plan_id: 'p1', created: 1, updated: 1, skipped_running: 0, skipped_done: 0 } };
      }
      if (request.path === '/plan/p1') return planResponse(root, {
        pending: [{ task_id: 'pending-task', status: 'pending' }],
        running: [{ task_id: 'running-only', status: 'running' }],
      });
      return taskRecords[decodeURIComponent(request.path.replace('/task/', ''))] ?? { ok: true, data: null };
    });

    const outcome = await runCli(['plan', 'revise', 'p1', '--submit', '--json'], { BIAO_URL: mock.url });

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: true,
      data: {
        operation: 'plan_revise', mode: 'submit', submitted: true,
        summary: { create: 1, update: 1, missing_local: 1 },
        submit: { created: 1, updated: 1 },
      },
    });
    expect(mock.requests.filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ path: '/plan/submit', body: { plan_dir: join(root, 'plans', 'p1') } }),
    ]);
  });

  it('plan revise 未知或互斥参数非零退出且不连接服务', async () => {
    for (const args of [
      ['plan', 'revise', 'p1', '--wat', '--json'],
      ['plan', 'revise', 'p1', '-x', '--json'],
      ['plan', 'revise', 'p1', '--diff', '--submit', '--json'],
    ]) {
      const outcome = await runCli(args, { BIAO_URL: 'http://127.0.0.1:1' });
      expect(outcome.code).not.toBe(0);
      const result = JSON.parse(outcome.stdout);
      expect(result).toMatchObject({ ok: false });
      if (args.includes('-x')) expect(result.error.code).toBe('UNKNOWN_OPTION');
    }
  });

  it('plan revise 预览并提交时如实标记服务端会跳过 cancelled 历史', async () => {
    const root = makePlan();
    writeTask(root, 'cancelled-task');
    const mock = await mockService((request) => {
      if (request.method === 'POST') return { ok: true, data: { created: 0, skipped_cancelled: 1 } };
      if (request.path === '/plan/p1') return planResponse(root, {
        cancelled: [{ task_id: 'cancelled-task', status: 'cancelled' }],
      });
      if (request.path === '/task/cancelled-task') {
        return {
          ok: true,
          data: {
            task_id: 'cancelled-task', title: 'cancelled-task', type: 'code', phase: 'impl',
            status: 'cancelled', assignee: 'auto', priority: 5, ownership: { files: [], modules: [] },
            depends_on: [], timeout_seconds: 3600, max_retries: 2, acceptance_for: [], verify: [],
            goal_md: '# 目标\n', project_path: root,
          },
        };
      }
      return { ok: false, data: null, error: { code: 'UNEXPECTED', message: request.path } };
    });

    const preview = await runCli(['plan', 'revise', 'p1', '--preview', '--json'], { BIAO_URL: mock.url });
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      ok: true,
      data: { summary: { skip_cancelled: 1 } },
    });

    const submit = await runCli(['plan', 'revise', 'p1', '--submit', '--json'], { BIAO_URL: mock.url });
    expect(submit.code).toBe(0);
    expect(JSON.parse(submit.stdout)).toMatchObject({
      ok: true,
      data: { submitted: true, submit: { skipped_cancelled: 1 } },
    });
    expect(mock.requests.some((request) => request.method === 'POST')).toBe(true);
  });
});
