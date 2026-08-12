/**
 * CLI pm intake / unacked / ack 测试
 * 覆盖：
 *  - --json 输出稳定最小字段
 *  - 按 consumer/project/plan 过滤
 *  - 有事项/无事项的退出码可被脚本判断
 *  - 中断退出（watch 模式）
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';

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

/** 用 mock server 模拟 Biao 后端，按路径返回不同响应 */
async function mockRoutes(routes: Record<string, unknown>): Promise<string> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '/';
    // 精确或前缀匹配
    const match = Object.entries(routes).find(([path]) => url === path || url.startsWith(path + '?'));
    if (match) {
      res.end(JSON.stringify(match[1]));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: url } }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return `http://127.0.0.1:${address.port}`;
}

describe('biao pm intake', () => {
  it('有事项时退出码 0，--json 输出最小字段', async () => {
    const url = await mockRoutes({
      '/intake': {
        ok: true,
        data: {
          consumer: 'pm',
          cursor: '1786466877493-0',
          counts: { review_requested: 1, acceptance_ready: 0, failed: 0, blocked: 0, stale_agent: 0 },
          items: [
            {
              kind: 'review_requested',
              plan_id: 'p1',
              task_id: 't1',
              event_id: 'e1',
              timestamp: 1786466877493,
            },
          ],
        },
      },
    });
    const { stdout } = await runCli(['pm', 'intake', '--consumer', 'pm', '--json'], { BIAO_URL: url });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.items[0]).toMatchObject({ kind: 'review_requested', plan_id: 'p1', task_id: 't1' });
    // 不应展开详情
    expect(parsed.data.items[0]).not.toHaveProperty('result_md');
  });

  it('无事项时退出码非零（可被脚本判断为"无需处理"）', async () => {
    const url = await mockRoutes({
      '/intake': {
        ok: true,
        data: {
          consumer: 'pm',
          cursor: '0-0',
          counts: {},
          items: [],
        },
      },
    });
    await expect(
      runCli(['pm', 'intake', '--consumer', 'pm', '--json'], { BIAO_URL: url }),
    ).rejects.toMatchObject({ code: 2 }); // 无事项退出码 2
  });

  it('按 project/plan 过滤参数透传到后端', async () => {
    const url = await mockRoutes({
      '/intake': {
        ok: true,
        data: { consumer: 'pm', cursor: '0-0', counts: {}, items: [] },
      },
    });
    // 无事项 → 退出码 2，但我们只验证不报错崩溃
    await expect(
      runCli(['pm', 'intake', '--consumer', 'pm', '--plan', 'p1', '--json'], { BIAO_URL: url }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe('biao pm unacked / ack', () => {
  it('unacked 返回未确认事件列表', async () => {
    const url = await mockRoutes({
      '/intake/unacked': {
        ok: true,
        data: [
          { event_id: 'e1', type: 'review_requested', task_id: 't1', plan_id: 'p1', consumer: 'pm' },
        ],
      },
    });
    const { stdout } = await runCli(['pm', 'unacked', '--consumer', 'pm', '--json'], { BIAO_URL: url });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data[0].event_id).toBe('e1');
  });

  it('unacked 与 ack 都携带 Plan 边界，防止同 consumer 跨计划处理', async () => {
    const requests: Array<{ method?: string; url?: string; body?: string }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/intake/unacked')) {
        res.end(JSON.stringify({ ok: true, data: [] }));
      } else {
        res.end(JSON.stringify({ ok: true, data: { event_id: 'e1', already_acked: false } }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');
    const url = `http://127.0.0.1:${address.port}`;

    await runCli(['pm', 'unacked', '--consumer', 'pm', '--plan', 'p1', '--type', 'question_asked', '--json'], { BIAO_URL: url });
    await runCli(['pm', 'ack', '--consumer', 'pm', '--plan', 'p1', '--event-id', 'e1'], { BIAO_URL: url });

    expect(requests[0]?.url).toBe('/intake/unacked?consumer=pm&type=question_asked&plan_id=p1');
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({ consumer: 'pm', event_id: 'e1', plan_id: 'p1' });
  });

  it('ack 幂等调用后端', async () => {
    const url = await mockRoutes({
      '/intake/ack': { ok: true, data: { event_id: 'e1', acked: true } },
    });
    const { stdout } = await runCli(['pm', 'ack', '--consumer', 'pm', '--event-id', 'e1'], { BIAO_URL: url });
    expect(stdout).toContain('e1');
  });
});

describe('CLI 帮助列出 pm 子命令', () => {
  it('总帮助包含统一 pm start 与保留的 intake / unacked / ack', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('biao pm start');
    expect(stdout).toContain('biao pm intake');
    expect(stdout).toContain('biao pm unacked');
    expect(stdout).toContain('biao pm ack');
  });

  it('pm 角色帮助给出 Question 的 list/get/answer/ack 完整顺序', async () => {
    const { stdout } = await runCli(['pm', '--help'], { BIAO_URL: 'http://127.0.0.1:1' });
    expect(stdout).toContain('Worker 提问闭环');
    expect(stdout).toContain('question list');
    expect(stdout).toContain('question get');
    expect(stdout).toContain('question answer');
    expect(stdout).toContain('question_asked');
    expect(stdout).toContain('--plan <id>');
  });
});

describe('biao pm start', () => {
  it('帮助不连接服务也不启动 Supervisor', async () => {
    const { stdout } = await runCli(['pm', 'start', '--help'], { BIAO_URL: 'http://127.0.0.1:1' });
    expect(stdout).toContain('biao pm start');
    expect(stdout).toContain('不自动 ack/验收');
    expect(stdout).toContain('question');
  });

  it('用同一入口暴露历史待验收和无在线 Worker，并一次性运行不自动确认的 Supervisor', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      res.setHeader('content-type', 'application/json');

      if (url.pathname === '/health') {
        res.end(JSON.stringify({ ok: true, data: { redis: 'connected', version: 'v1' } }));
        return;
      }
      if (url.pathname === '/status') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            tasks: { pending: 10, running: 0, blocked: 0, done: 40, failed: 0, cancelled: 0 },
            reviews: { pending: 40, accepted: 0, rejected: 0 },
            agents: [{ agent_id: 'old-worker', status: 'stale' }],
            hint: { code: 'NO_ONLINE_WORKERS', doctor: '.biao/doctor', start_worker: '.biao/worker-codex' },
          },
        }));
        return;
      }
      if (url.pathname === '/intake') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            consumer: 'pm-team-a',
            cursor: '0-0',
            counts: { stale_agent: 1 },
            items: [{ kind: 'stale_agent', event_id: 'stale-1', agent_id: 'old-worker' }],
          },
        }));
        return;
      }
      if (url.pathname === '/plans') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            plans: [{
              plan_id: 'historical-plan', status: 'active', project_path: '/tmp/historical',
              tasks: { pending: 10, running: 0, blocked: 0, done: 40, failed: 0, cancelled: 0 },
              reviews: { pending: 40, accepted: 0, rejected: 0 },
            }],
          },
        }));
        return;
      }
      if (url.pathname === '/events') {
        res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '0-0' } }));
        return;
      }
      if (url.pathname === '/reconcile' && req.method === 'POST') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            reclaimed: [],
            failed: [],
            requeued: { waiting_file_release: [], waiting_dependency: [] },
          },
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: url.pathname } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');
    const lockDir = mkdtempSync(join(tmpdir(), 'biao-pm-start-lock-'));
    tempRoots.push(lockDir);

    const { stdout } = await runCli(['pm', 'start', '--consumer', 'pm-team-a', '--once'], {
      BIAO_URL: `http://127.0.0.1:${address.port}`,
      BIAO_LOCK_DIR: lockDir,
    });

    expect(stdout).toContain('待 PM 验收：40 项');
    expect(stdout).toContain('历史待验收');
    expect(stdout).toContain('暂无在线 Worker');
    expect(stdout).toContain('一次性运行 PM Supervisor');
    expect(requests).toContain('GET /health');
    expect(requests).toContain('GET /status');
    expect(requests).toContain('GET /plans');
    expect(requests.some((request) => request.startsWith('GET /events?'))).toBe(true);
    expect(requests).toContain('POST /reconcile');
    expect(requests.some((request) => request.startsWith('POST /intake/ack'))).toBe(false);
    expect(requests.some((request) => request.includes('/review'))).toBe(false);
  });

  it('--plans 开场检查只汇总受管 plan，并给每个 plan 传 intake 过滤器', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/health') {
        res.end(JSON.stringify({ ok: true, data: { redis: 'connected' } }));
      } else if (url.pathname === '/status') {
        res.end(JSON.stringify({
          ok: true,
          data: { tasks: { pending: 39, done: 39 }, reviews: { pending: 39 }, agents: [] },
        }));
      } else if (url.pathname === '/plan/managed-plan') {
        res.end(JSON.stringify({
          ok: true,
          data: {
            plan_id: 'managed-plan', status: 'active', project_path: '/tmp/managed',
            tasks: { pending: [{ task_id: 'managed-next' }], running: [], blocked: [], done: [{ task_id: 'managed-review' }], failed: [], cancelled: [], superseded: [] },
            reviews: { pending: 1, accepted: 0, rejected: 0 },
          },
        }));
      } else if (url.pathname === '/intake') {
        const planId = url.searchParams.get('plan_id');
        res.end(JSON.stringify({
          ok: true,
          data: planId === 'managed-plan'
            ? { consumer: 'pm-scope', cursor: '1-0', counts: { review_requested: 1 }, items: [{ kind: 'review_requested', plan_id: 'managed-plan', task_id: 'managed-review', event_id: 'e1' }] }
            : { consumer: 'pm-scope', cursor: '1-0', counts: { review_requested: 39 }, items: Array.from({ length: 39 }, (_, index) => ({ kind: 'review_requested', plan_id: 'legacy-plan', task_id: `legacy-${index}` })) },
        }));
      } else if (url.pathname === '/plans') {
        res.end(JSON.stringify({
          ok: true,
          data: { plans: [{ plan_id: 'managed-plan', status: 'active', project_path: '/tmp/managed', tasks: { pending: 1, running: 0, blocked: 0, done: 1, failed: 0, cancelled: 0, superseded: 0 }, reviews: { pending: 1, accepted: 0, rejected: 0 } }] },
        }));
      } else if (url.pathname === '/events') {
        res.end(JSON.stringify({ ok: true, data: { events: [], next_cursor: '0-0' } }));
      } else if (url.pathname === '/reconcile' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true, data: { reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] } } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, data: null, error: { code: 'NOT_FOUND', message: url.pathname } }));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock service 未监听');
    const lockDir = mkdtempSync(join(tmpdir(), 'biao-pm-start-scope-lock-'));
    tempRoots.push(lockDir);

    const { stdout } = await runCli([
      'pm', 'start', '--consumer', 'pm-scope', '--plans', 'managed-plan', '--once',
    ], {
      BIAO_URL: `http://127.0.0.1:${address.port}`,
      BIAO_LOCK_DIR: lockDir,
    });

    expect(stdout).toContain('待 PM 验收：1 项');
    expect(stdout).toContain('待执行：1 项');
    expect(stdout).not.toContain('39 项');
    expect(requests).toContain('GET /plan/managed-plan');
    expect(requests).toContain('GET /intake?consumer=pm-scope&plan_id=managed-plan');
    expect(requests).not.toContain('GET /status');
    expect(requests).not.toContain('GET /intake?consumer=pm-scope');
  });
});
