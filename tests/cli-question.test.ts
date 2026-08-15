/**
 * Question CLI contract: Worker/PM 必须经平台通讯，列表门铃不泄露正文。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function start(handler: (req: IncomingMessage) => Promise<unknown> | unknown): Promise<string> {
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(await handler(req)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return `http://127.0.0.1:${address.port}`;
}

describe('biao question CLI', () => {
  it('角色化帮助完整说明 Worker 提问、PM 答复与新 claim 恢复', async () => {
    const { stdout } = await runCli(['question', '--help'], { BIAO_URL: 'http://127.0.0.1:1' });
    expect(stdout).toContain('Worker → PM');
    expect(stdout).toContain('BIAO_QUESTION');
    expect(stdout).toContain('question answer');
    expect(stdout).toContain('新的 claim token');
    expect(stdout).toContain('不要询问当前人类');
    expect(stdout).toContain('--agent-id <current-worker-id>');
  });

  it('ask 的叶子帮助明确要求当前 Worker 身份，不会执行请求', async () => {
    const { stdout } = await runCli(['question', 'ask', '--help'], { BIAO_URL: 'http://127.0.0.1:1' });
    expect(stdout).toContain('用法：biao question ask');
    expect(stdout).toContain('--agent-id <current-worker-id>');
    expect(stdout).toContain('不得使用 pm-agent');
  });

  it('ask 即使继承了 PM wrapper 身份也必须显式传 --agent-id，且不发请求', async () => {
    let requests = 0;
    const url = await start(() => {
      requests++;
      return { ok: true, data: null };
    });
    await expect(runCli(
      ['question', 'ask', '--task', 't-1', '--claim-token', 'lease-1', '--body', '请确认范围'],
      { BIAO_URL: url, BIAO_AGENT_ID: 'pm-agent' },
    )).rejects.toMatchObject({ code: 1 });
    expect(requests).toBe(0);
  });

  it('ask 带当前 Worker、claim token 和正文经平台发送', async () => {
    let received: Record<string, unknown> | undefined;
    const url = await start(async (req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/question');
      received = await readJson(req);
      return {
        ok: true,
        data: {
          question_id: 'q-1', task_id: 't-1', pm_consumer: 'pm-alpha',
          asked_event_id: '1700000000000_question_asked_q-1',
        },
      };
    });
    const { stdout } = await runCli(
      [
        'question', 'ask', '--task', 't-1', '--claim-token', 'lease-1', '--body', '请确认范围',
        '--checkpoint', '已完成一半', '--agent-id', 'worker-1',
      ],
      { BIAO_URL: url, BIAO_AGENT_ID: 'pm-agent' },
    );
    expect(stdout).toContain('q-1');
    expect(stdout).toContain('旧 claim token 已失效');
    expect(received).toMatchObject({
      task_id: 't-1', agent_id: 'worker-1', claim_token: 'lease-1', body: '请确认范围', checkpoint: '已完成一半',
    });
  });

  it('ask 将结构化扩权 JSON 作为 requested_ownership 提交', async () => {
    let received: Record<string, unknown> | undefined;
    const url = await start(async (req) => {
      received = await readJson(req);
      return { ok: true, data: { question_id: 'q-scope', task_id: 't-1', pm_consumer: 'pm' } };
    });
    await runCli([
      'question', 'ask', '--task', 't-1', '--claim-token', 'lease-1', '--agent-id', 'worker-1',
      '--body', '需要新增测试', '--request-ownership', '{"files":["src/new.test.ts"],"modules":["tests"]}',
    ], { BIAO_URL: url });
    expect(received).toMatchObject({
      requested_ownership: { files: ['src/new.test.ts'], modules: ['tests'] },
    });
  });

  it('get 只按归属 consumer + plan 读取正文，并打印精确可复制 ack 命令', async () => {
    const url = await start((req) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/question/q-1?consumer=pm-alpha&plan_id=p-1');
      return {
        ok: true,
        data: {
          question_id: 'q-1', task_id: 't-1', plan_id: 'p-1', pm_consumer: 'pm-alpha',
          body: '只能在详情中看到', checkpoint: '已完成测试', status: 'open',
          asked_event_id: '1700000000000_question_asked_q-1', created_at: 1700000000000,
        },
      };
    });
    const { stdout } = await runCli(
      ['question', 'get', 'q-1', '--consumer', 'pm-alpha', '--plan', 'p-1'],
      { BIAO_URL: url },
    );
    expect(stdout).toContain('只能在详情中看到');
    expect(stdout).toContain('.biao/pm pm ack --consumer pm-alpha --plan p-1 --event-id 1700000000000_question_asked_q-1');
  });

  it('list 只显示门铃字段，不把 Question 正文泄露到监视输出', async () => {
    const url = await start((req) => {
      expect(req.url).toBe('/questions?consumer=pm-alpha&status=open');
      return {
        ok: true,
        data: [{ question_id: 'q-1', task_id: 't-1', plan_id: 'p-1', status: 'open', body: '不能出现在列表中的正文' }],
      };
    });
    const { stdout } = await runCli(['question', 'list', '--consumer', 'pm-alpha', '--status', 'open'], { BIAO_URL: url });
    expect(stdout).toContain('q-1');
    expect(stdout).not.toContain('不能出现在列表中的正文');
    expect(stdout).toContain('question answer');
  });

  it('answer 只向对应 Question 路径提交 PM consumer 与答复', async () => {
    let received: Record<string, unknown> | undefined;
    const url = await start(async (req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/question/q-1/answer');
      received = await readJson(req);
      return {
        ok: true,
        data: {
          question_id: 'q-1', task_id: 't-1', status: 'answered',
          plan_id: 'p-1', pm_consumer: 'pm-alpha',
          asked_event_id: '1700000000000_question_asked_q-1',
        },
      };
    });
    const { stdout } = await runCli(
      ['question', 'answer', 'q-1', '--consumer', 'pm-alpha', '--plan', 'p-1', '--answer', '按 A 方案继续'],
      { BIAO_URL: url },
    );
    expect(stdout).toContain('已回答 q-1');
    expect(stdout).toContain('.biao/pm pm ack --consumer pm-alpha --plan p-1 --event-id 1700000000000_question_asked_q-1');
    expect(received).toEqual({ consumer: 'pm-alpha', plan_id: 'p-1', answer: '按 A 方案继续' });
  });

  it.each([
    ['--approve-ownership', 'approved'],
    ['--reject-ownership', 'rejected'],
  ])('answer %s 提交显式扩权决策', async (flag, decision) => {
    let received: Record<string, unknown> | undefined;
    const url = await start(async (req) => {
      received = await readJson(req);
      return { ok: true, data: { question_id: 'q-1', status: 'answered' } };
    });
    await runCli(['question', 'answer', 'q-1', '--answer', '已审查', flag], { BIAO_URL: url });
    expect(received).toMatchObject({ ownership_decision: decision });
  });

  it('answer 拒绝同时批准和拒绝扩权，且不发送请求', async () => {
    let requests = 0;
    const url = await start(() => { requests++; return { ok: true, data: null }; });
    await expect(runCli([
      'question', 'answer', 'q-1', '--answer', '冲突', '--approve-ownership', '--reject-ownership',
    ], { BIAO_URL: url })).rejects.toMatchObject({ code: 1 });
    expect(requests).toBe(0);
  });
});
