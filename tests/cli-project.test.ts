import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const cli = join(import.meta.dirname, '..', 'src', 'cli', 'index.ts');

interface CapturedRequest {
  method: string;
  path: string;
  body?: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, ['--import', 'tsx', cli, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

/** 记录请求并按 path 返回预置响应的 mock 中央服务。 */
async function captureService(responses: Record<string, unknown>): Promise<{ url: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method ?? 'GET', path, body: raw ? JSON.parse(raw) : undefined });
      const payload = responses[path] ?? { ok: false, data: null, error: { code: 'NOT_FOUND', message: `unexpected ${path}` } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('capture service 未监听');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

const PROJECT_ROW = {
  project_id: 'proj-test123',
  name: 'offic',
  repo_path: 'http://git.example/offic.git',
  default_branch: 'main',
  execution_mode: 'full',
  status: 'active',
  revision: 1,
  updated_at: 1755300000000,
};

describe('biao project 命令组（V2 项目注册面）', () => {
  it('总帮助列出 project 命令并区分单机/分布式典型流程', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('biao project create <name> --repo <git-url>');
    expect(stdout).toContain('biao project authorize <project_id> <node_id>');
    expect(stdout).toContain('典型流程（单机 V1）');
    expect(stdout).toContain('典型流程（分布式 V2');
  });

  it('project --help 给出 V2 接入序列', async () => {
    const { stdout } = await runCli(['project', '--help']);
    expect(stdout).toContain('V2 分布式接入序列');
    expect(stdout).toContain('biao project authorize <project_id> <node_id>');
  });

  it('project create 发送 POST /v2/projects 并提示下一步', async () => {
    const { url, requests } = await captureService({
      '/v2/projects': { ok: true, data: PROJECT_ROW },
    });
    const { stdout } = await runCli(
      ['project', 'create', 'offic', '--repo', 'http://git.example/offic.git', '--branch', 'main'],
      { BIAO_URL: url },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v2/projects' });
    expect(requests[0].body).toEqual({
      name: 'offic',
      repo_path: 'http://git.example/offic.git',
      default_branch: 'main',
      execution_mode: 'full',
    });
    expect(stdout).toContain('proj-test123');
    expect(stdout).toContain('biao project authorize proj-test123');
  });

  it('project create 缺 name/repo 时打印用法并以非零退出', async () => {
    const { url, requests } = await captureService({ '/v2/projects': { ok: true, data: PROJECT_ROW } });
    await expect(runCli(['project', 'create', '--repo', 'http://git/x.git'], { BIAO_URL: url }))
      .rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(0);
  });

  it('project create --read-only 映射 read_only 执行模式', async () => {
    const { url, requests } = await captureService({
      '/v2/projects': { ok: true, data: { ...PROJECT_ROW, project_id: 'proj-ro', name: 'docs', execution_mode: 'read_only' } },
    });
    const { stdout } = await runCli(
      ['project', 'create', 'docs', '--repo', 'http://git.example/docs.git', '--read-only'],
      { BIAO_URL: url },
    );
    expect(requests[0].body).toMatchObject({ execution_mode: 'read_only' });
    expect(stdout).toContain('docs');
  });

  it('project create 服务端拒绝时以非零退出', async () => {
    const { url } = await captureService({
      '/v2/projects': { ok: false, data: null, error: { code: 'PROJECT_EXISTS', message: '同名项目已存在' } },
    });
    await expect(
      runCli(['project', 'create', 'dup', '--repo', 'http://git/dup.git'], { BIAO_URL: url }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('project list 渲染项目表', async () => {
    const { url, requests } = await captureService({
      '/v2/projects': { ok: true, data: { items: [PROJECT_ROW], next_cursor: null } },
    });
    const { stdout } = await runCli(['project', 'list'], { BIAO_URL: url });
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/v2/projects' });
    expect(stdout).toContain('proj-test123');
    expect(stdout).toContain('offic');
    expect(stdout).toContain('http://git.example/offic.git');
  });

  it('project nodes 渲染节点表并提示 authorize', async () => {
    const { url } = await captureService({
      '/v2/nodes': { ok: true, data: { items: [{ node_id: 'node-25', status: 'online', slots: 4, last_heartbeat_at: 1755300000000 }], next_cursor: null } },
    });
    const { stdout } = await runCli(['project', 'nodes'], { BIAO_URL: url });
    expect(stdout).toContain('node-25');
    expect(stdout).toContain('biao project authorize <project_id> <node_id>');
  });

  it('project authorize 命中授权端点', async () => {
    const { url, requests } = await captureService({
      '/v2/projects/proj-1/nodes/node-25/authorize': { ok: true, data: { binding_id: 'bind-1' } },
    });
    const { stdout } = await runCli(['project', 'authorize', 'proj-1', 'node-25'], { BIAO_URL: url });
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v2/projects/proj-1/nodes/node-25/authorize' });
    expect(stdout).toContain('node-25');
    expect(stdout).toContain('proj-1');
  });

  it('project deauthorize 命中撤销端点', async () => {
    const { url, requests } = await captureService({
      '/v2/projects/proj-1/nodes/node-25/authorization': { ok: true, data: { revoked: true } },
    });
    const { stdout } = await runCli(['project', 'deauthorize', 'proj-1', 'node-25'], { BIAO_URL: url });
    expect(requests[0]).toMatchObject({ method: 'DELETE', path: '/v2/projects/proj-1/nodes/node-25/authorization' });
    expect(stdout).toContain('撤销');
  });

  it('project authorize 缺参数时打印用法并以非零退出', async () => {
    const { url, requests } = await captureService({});
    await expect(runCli(['project', 'authorize', 'only-one'], { BIAO_URL: url })).rejects.toMatchObject({ code: 1 });
    await expect(runCli(['project', 'badsub'], { BIAO_URL: url })).rejects.toMatchObject({ code: 1 });
    await expect(
      runCli(['project', 'create', 'x', '--repo', 'r', '--unknown', '1'], { BIAO_URL: url }),
    ).rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(0);
  });
});
