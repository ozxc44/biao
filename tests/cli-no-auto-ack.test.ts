/** PM 监视只能敲门，绝不能因打印一行就把待办事件 ack 掉。 */

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

it('pm watch --once 只输出门铃，不请求 intake/ack', async () => {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/intake?')) {
      res.end(JSON.stringify({
        ok: true,
        data: {
          cursor: '101-0',
          items: [{ kind: 'review_requested', event_id: 'evt-1', task_id: 'task-1', plan_id: 'plan-1' }],
        },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server 未监听');
  const url = `http://127.0.0.1:${address.port}`;

  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', cli, 'pm', 'watch', '--once', '--consumer', 'pm-a'], {
    env: { ...process.env, BIAO_URL: url }, encoding: 'utf8',
  });

  expect(stdout).toContain('发现 1 项待处理');
  expect(paths).toEqual([expect.stringMatching(/^GET \/intake\?consumer=pm-a$/)]);
  expect(paths.some((path) => path.includes('/intake/ack'))).toBe(false);
});
