import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

async function mockService(body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return `http://127.0.0.1:${address.port}`;
}

describe('CLI 与当前产品能力保持一致', () => {
  it('总帮助列出版本、搁置、恢复及 PM 运维命令', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('biao version');
    expect(stdout).toContain('biao task block <task_id>');
    expect(stdout).toContain('biao task resume <task_id>');
    expect(stdout).toContain('biao db restore');
    expect(stdout).toContain('BIAO_API_TOKEN');
    expect(stdout).toContain('--reverify-only');
  });

  it('version 查询当前服务版本并支持 JSON 输出', async () => {
    const url = await mockService({ ok: true, data: { name: 'biao', version: '9.8.7' } });
    const { stdout } = await runCli(['version', '--json'], { BIAO_URL: url });
    expect(JSON.parse(stdout)).toEqual({ ok: true, data: { name: 'biao', version: '9.8.7' } });
  });

  it('health 返回业务失败时以非零退出，供 Agent 正确判断', async () => {
    const url = await mockService({
      ok: false,
      data: null,
      error: { code: 'REDIS_UNAVAILABLE', message: 'redis 不可达' },
    });
    await expect(runCli(['health'], { BIAO_URL: url })).rejects.toMatchObject({ code: 1 });
  });

  it('task edit 自动提交失败时不打印成功并以非零退出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'biao-cli-edit-'));
    tempRoots.push(root);
    const taskDir = join(root, 'plans', 'p1', 'tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(root, 'plans', 'p1', 'index.md'), `---
plan_id: p1
title: 编辑失败回归
project_path: ${root}
phases:
  - id: impl
    name: 实现
---
`);
    writeFileSync(join(taskDir, 't1.md'), `---
task_id: t1
title: 编辑失败回归
type: code
phase: impl
assignee: auto
verify: []
---

# task
`);
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/task/t1') {
        res.end(JSON.stringify({
          ok: true,
          data: { task_id: 't1', plan_id: 'p1', project_path: root, status: 'pending' },
        }));
      } else if (req.url === '/plan/p1') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            plan_id: 'p1',
            project_path: root,
            tasks: { pending: [{ task_id: 't1', status: 'pending' }], running: [], blocked: [], done: [], failed: [], cancelled: [] },
          },
        }));
      } else {
        res.end(JSON.stringify({ ok: false, data: null, error: { code: 'SUBMIT_FAILED', message: '提交失败' } }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');

    await expect(runCli(['task', 'edit', 't1'], {
      BIAO_URL: `http://127.0.0.1:${address.port}`,
      EDITOR: '/usr/bin/true',
    })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('fail') });
  });

  it('task list 用低噪声链路展示 failed → repair → PM 验收，而不掩盖原始状态', async () => {
    const url = await mockService({
      ok: true,
      data: {
        total: 4,
        tasks: [
          {
            task_id: 'source-failed', title: '原任务', type: 'code', phase: 'impl', status: 'failed',
            assignee: 'auto', priority: 5, failure_reason: 'verify failed', resolution_status: 'repairing',
            resolution_task_id: 'source-failed-repair-1',
          },
          {
            task_id: 'source-failed-repair-1', title: '修复任务', type: 'code', phase: 'impl', status: 'done',
            assignee: 'auto', priority: 6, fix_for: 'source-failed',
          },
          {
            task_id: 'ordinary-done', title: '普通交付', type: 'code', phase: 'impl', status: 'done',
            assignee: 'auto', priority: 5,
          },
          {
            task_id: 'manual-decision', title: '达到修复上限', type: 'code', phase: 'impl', status: 'failed',
            assignee: 'auto', priority: 5, resolution_status: 'needs_pm_decision',
          },
        ],
      },
    });

    const { stdout } = await runCli(['task', 'list'], { BIAO_URL: url });

    expect(stdout).toContain('source-failed');
    expect(stdout).toContain('failed'); // 原始失败审计不被修复态覆盖
    expect(stdout).toContain('修复中 → source-failed-repair-1');
    expect(stdout).toContain('修复待验收 ← source-failed');
    expect(stdout).toContain('待 PM 验收');
    expect(stdout).toContain('需 PM 决策');
    expect(stdout).toContain('不要手动 reset 原任务');
  });

  it('review reject 将受控 repair ownership JSON 原样传给平台', async () => {
    let received: Record<string, unknown> | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        data: {
          task_id: 'reviewable',
          review_status: 'rejected',
          fix_task_id: 'reviewable-repair-1',
          fix_task_ids: ['reviewable-repair-1', 'second-source-repair-1'],
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');

    const { stdout } = await runCli([
      'review', 'reviewable', '--reject', '--reason', '验收发现相邻文件需要修复',
      '--repair-ownership', '{"files":["apps/api/src/mcp/mailbox-v2.ts"],"modules":["mailbox-v2"]}',
    ], { BIAO_URL: `http://127.0.0.1:${address.port}` });

    expect(received).toMatchObject({
      verdict: 'reject',
      repair_ownership: {
        files: ['apps/api/src/mcp/mailbox-v2.ts'],
        modules: ['mailbox-v2'],
      },
    });
    expect(stdout).toContain('reviewable-repair-1, second-source-repair-1');
  });

  it('review --reverify-only 发送显式 reverify 模式并提示生成独立复验', async () => {
    let received: Record<string, unknown> | undefined;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        data: {
          task_id: 'evidence-acceptance',
          review_status: 'rejected',
          resolution_mode: 'reverify',
          fix_task_id: 'evidence-acceptance-reverify-1',
          fix_task_ids: ['evidence-acceptance-reverify-1'],
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');

    const { stdout } = await runCli([
      'review', 'evidence-acceptance', '--reject', '--reason', '仅验收证据不足', '--reverify-only',
    ], { BIAO_URL: `http://127.0.0.1:${address.port}` });

    expect(received).toMatchObject({ verdict: 'reject', resolution_mode: 'reverify' });
    expect(stdout).toContain('生成独立复验任务：evidence-acceptance-reverify-1');
  });

  it('review --reverify-only 没有 reject 时在客户端 fail closed', async () => {
    await expect(runCli(['review', 'evidence-acceptance', '--accept', '--reverify-only']))
      .rejects.toMatchObject({ code: 1 });
  });
});
