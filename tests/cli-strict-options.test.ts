import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type CliOutcome = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[], url: string): Promise<CliOutcome> {
  try {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: { ...process.env, BIAO_URL: url },
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

async function countingServer() {
  let requests = 0;
  let lastBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    requests++;
    lastBody = await readJson(req);
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/questions') {
      res.end(JSON.stringify({ ok: true, data: [] }));
    } else if (path === '/question') {
      res.end(JSON.stringify({ ok: true, data: { question_id: 'q-1', task_id: 't-1', pm_consumer: 'pm' } }));
    } else if (path === '/intake/ack') {
      res.end(JSON.stringify({ ok: true, data: { event_id: 'event-1', already_acked: false } }));
    } else {
      res.end(JSON.stringify({
        ok: true,
        data: {
          consumer: 'pm', cursor: '1-0', counts: { question_asked: 1 },
          items: [{ kind: 'question_asked', event_id: 'event-1', task_id: 't-1', plan_id: 'p-1' }],
        },
      }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock service 未监听');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    body: () => lastBody,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
}

describe('Question / PM CLI 严格参数路由', () => {
  it.each([
    ['Question 拼错 option', ['question', 'list', '--stauts', 'open'], '--stauts'],
    ['Question 多余 option', ['question', 'get', 'q-1', '--consumer', 'pm', '--verbose'], '--verbose'],
    ['Question 拼错 option 后跟 help', ['question', 'list', '--stauts', 'open', '--help'], '--stauts'],
    ['PM 拼错 option', ['pm', 'intake', '--consuemr', 'pm', '--json'], '--consuemr'],
    ['PM 多余 option', ['pm', 'ack', '--consumer', 'pm', '--event-id', 'event-1', '--force'], '--force'],
    ['PM 拼错 option 后跟 help', ['pm', 'start', '--bogus', '--help'], '--bogus'],
  ])('%s 必须非零退出且不得发请求', async (_label, args, badOption) => {
    const mock = await countingServer();

    const outcome = await runCli(args, mock.url);

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain(`未知参数：${badOption}`);
    expect(mock.requestCount()).toBe(0);
  });

  it('重复的已知 option 也拒绝，避免后值静默覆盖前值', async () => {
    const mock = await countingServer();

    const outcome = await runCli(
      ['question', 'list', '--consumer', 'pm-a', '--consumer', 'pm-b'],
      mock.url,
    );

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('重复参数：--consumer');
    expect(mock.requestCount()).toBe(0);
  });

  it('已知字符串 option 保留以短横线开头的正文和负值', async () => {
    const mock = await countingServer();

    const outcome = await runCli([
      'question', 'ask', '--task', 't-1', '--claim-token', 'claim-1',
      '--body', '--只发布-A', '--checkpoint', '-1', '--agent-id', 'worker-1',
    ], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requestCount()).toBe(1);
    expect(mock.body()).toMatchObject({ body: '--只发布-A', checkpoint: '-1' });
  });

  it('作为已知 option 值的 --help 是正文，不会被误判为帮助开关', async () => {
    const mock = await countingServer();

    const outcome = await runCli([
      'question', 'ask', '--task', 't-1', '--claim-token', 'claim-1', '--body', '--help', '--agent-id', 'worker-1',
    ], mock.url);

    expect(outcome.code).toBe(0);
    expect(mock.requestCount()).toBe(1);
    expect(mock.body()).toMatchObject({ body: '--help' });
  });
});
