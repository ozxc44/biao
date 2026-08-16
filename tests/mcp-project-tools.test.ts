import { describe, expect, it } from 'vitest';
import { createLanMcpRuntime } from '../src/mcp/runtime.js';
import { handleMcpMessage } from '../src/mcp/session.js';

/**
 * project_create / project_list 的 MCP 工具层契约：
 * 请求形状（POST /v2/projects 的 body 映射与默认值）、输入校验、
 * 错误信封透传。中央侧路由行为由 tests/distributed/* 覆盖。
 */

interface RecordedRequest {
  path: string;
  method: string;
  body?: unknown;
  authorization?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRuntime(responses: Array<(req: RecordedRequest) => Response>) {
  const recorded: RecordedRequest[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const req: RecordedRequest = {
      path: new URL(String(input)).pathname,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    };
    recorded.push(req);
    if (req.path === '/health') return jsonResponse({ ok: true, data: { version: 'v1' } });
    const handler = responses[recorded.length - 1] ?? responses[responses.length - 1];
    return handler(req);
  };
  const runtime = createLanMcpRuntime(
    { BIAO_URL: 'http://127.0.0.1:7331', BIAO_API_TOKEN: 'mcp-project-owner-token' },
    { fetch: mockFetch },
  );
  return { runtime, recorded };
}

async function callTool(
  runtime: ReturnType<typeof createLanMcpRuntime>,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: `${name}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  }, runtime);
  const result = response?.result as { content?: Array<{ text: string }>; isError?: boolean } | undefined;
  return {
    isError: Boolean(result?.isError),
    payload: JSON.parse(result?.content?.[0]?.text ?? 'null') as {
      ok: boolean;
      data: unknown;
      error?: { code: string; message: string };
    },
    message: result?.content?.[0]?.text ?? '',
    // McpToolInputError 走 JSON-RPC error（-32602），不进 tool result。
    rpcErrorMessage: (response as { error?: { message?: string } } | undefined)?.error?.message ?? '',
  };
}

describe('MCP project_create / project_list 工具契约', () => {
  it('project_create 发送 POST /v2/projects，默认 main/full', async () => {
    const { runtime, recorded } = makeRuntime([
      () => jsonResponse({ ok: true, data: { project_id: 'proj-abc', name: 'offic', repo_path: 'http://git/offic.git', default_branch: 'main', execution_mode: 'full' } }),
    ]);
    const result = await callTool(runtime, 'project_create', { name: 'offic', repo_path: 'http://git/offic.git' });
    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({ ok: true, data: { project_id: 'proj-abc' } });

    const create = recorded.find((r) => r.path === '/v2/projects')!;
    expect(create.method).toBe('POST');
    expect(create.body).toEqual({
      name: 'offic',
      repo_path: 'http://git/offic.git',
      default_branch: 'main',
      execution_mode: 'full',
    });
    expect(create.authorization).toBe('Bearer mcp-project-owner-token');
  });

  it('project_create 映射 default_branch 与 read_only', async () => {
    const { runtime, recorded } = makeRuntime([
      () => jsonResponse({ ok: true, data: { project_id: 'proj-ro', execution_mode: 'read_only' } }),
    ]);
    const result = await callTool(runtime, 'project_create', {
      name: 'docs',
      repo_path: 'http://git/docs.git',
      default_branch: 'release',
      read_only: true,
    });
    expect(result.isError).toBe(false);
    expect(recorded.find((r) => r.path === '/v2/projects')!.body).toEqual({
      name: 'docs',
      repo_path: 'http://git/docs.git',
      default_branch: 'release',
      execution_mode: 'read_only',
    });
  });

  it('project_create 拒绝缺 name 与未知参数', async () => {
    const { runtime } = makeRuntime([() => jsonResponse({ ok: true, data: {} })]);
    const missing = await callTool(runtime, 'project_create', { repo_path: 'http://git/x.git' });
    expect(missing.rpcErrorMessage).toContain('name');

    const unknown = await callTool(runtime, 'project_create', { name: 'x', repo_path: 'r', oops: 1 });
    expect(unknown.rpcErrorMessage).toContain('oops');
  });

  it('project_list 发送 GET /v2/projects 并透传摘要', async () => {
    const { runtime, recorded } = makeRuntime([
      () => jsonResponse({ ok: true, data: { items: [{ project_id: 'proj-1', name: 'offic', repo_path: 'http://git/offic.git', default_branch: 'main' }], next_cursor: null } }),
    ]);
    const result = await callTool(runtime, 'project_list', {});
    expect(result.payload).toMatchObject({
      ok: true,
      data: { items: [expect.objectContaining({ project_id: 'proj-1' })] },
    });
    const list = recorded.find((r) => r.path === '/v2/projects')!;
    expect(list.method).toBe('GET');
    expect(list.body).toBeUndefined();
  });

  it('中央拒绝时保留业务 code，不透传自由文本', async () => {
    const { runtime } = makeRuntime([
      () => jsonResponse({ ok: false, data: null, error: { code: 'PROJECT_EXISTS', message: '内部细节 /srv/secret' } }, 409),
    ]);
    const result = await callTool(runtime, 'project_create', { name: 'dup', repo_path: 'http://git/dup.git' });
    expect(result.payload.ok).toBe(false);
    expect(result.payload.error?.code).toBe('PROJECT_EXISTS');
    expect(JSON.stringify(result.payload)).not.toContain('/srv/secret');
  });

  it('tools/list 注册两个新工具', async () => {
    const { runtime } = makeRuntime([() => jsonResponse({ ok: true, data: {} })]);
    const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, runtime);
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('project_create');
    expect(names).toContain('project_list');
  });
});
