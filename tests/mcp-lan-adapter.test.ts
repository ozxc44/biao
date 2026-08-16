import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, deriveWorkerApiToken } from '../src/server/http.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { setSqliteStore } from '../src/server/service.js';
import { createLanMcpRuntime } from '../src/mcp/runtime.js';
import { handleMcpMessage } from '../src/mcp/session.js';

const REDIS_URL = process.env.MCP_LAN_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/15';
const OWNER_TOKEN = 'mcp-lan-owner-token-that-must-never-appear';
const VERIFY_COMMAND = 'node ./private/verify-task.mjs';

let redis: Redis;
let rootDir: string;
let baseUrl: string;
let server: Awaited<ReturnType<typeof createHttpServer>>;
let store: SqliteStore;
let previousWorkspaceRoots: string | undefined;

function rpcTool(runtime: ReturnType<typeof createLanMcpRuntime>, name: string, args: Record<string, unknown> = {}) {
  return handleMcpMessage({
    jsonrpc: '2.0',
    id: `${name}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  }, runtime);
}

async function toolPayload(
  runtime: ReturnType<typeof createLanMcpRuntime>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpcTool(runtime, name, args);
  const result = response?.result as { content?: Array<{ type: string; text: string }>; isError?: boolean } | undefined;
  return {
    isError: Boolean(result?.isError),
    payload: JSON.parse(result?.content?.[0]?.text ?? 'null') as {
      ok: boolean;
      data: any;
      error?: { code: string; message: string };
    },
    serialized: JSON.stringify(response),
  };
}

async function submitFixturePlan(): Promise<void> {
  const planDir = join(rootDir, 'plans', 'mcp-lan-plan');
  mkdirSync(join(planDir, 'tasks'), { recursive: true });
  writeFileSync(join(planDir, 'index.md'), [
    '---',
    'plan_id: mcp-lan-plan',
    'title: LAN MCP shared plan',
    `project_path: ${rootDir}`,
    'phases:',
    '  - id: impl',
    '    name: Implementation',
    '---',
    '',
  ].join('\n'));
  writeFileSync(join(planDir, 'tasks', 'shared-task.md'), [
    '---',
    'task_id: mcp-lan-shared-task',
    'title: Shared CAS task',
    'type: code',
    'phase: impl',
    'assignee: auto',
    'ownership:',
    '  files: [src/shared.ts]',
    'verify:',
    `  - cmd: ${VERIFY_COMMAND}`,
    '---',
    '',
    '# Goal',
    '',
    'Implement the shared task through the normal Worker lease.',
  ].join('\n'));

  const response = await fetch(`${baseUrl}/plan/submit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ plan_dir: planDir }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { ok: boolean; data: unknown };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  expect(body).toMatchObject({ data: { plan_id: 'mcp-lan-plan', created: 1 } });
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'biao-mcp-lan-'));
  previousWorkspaceRoots = process.env.BIAO_WORKSPACE_ROOTS;
  process.env.BIAO_WORKSPACE_ROOTS = rootDir;
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  store = new SqliteStore(join(rootDir, 'biao.sqlite'), { restoreWorkspaceRoots: [rootDir] });
  setSqliteStore(store);
  server = await createHttpServer(redis, {
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    sqlitePath: join(rootDir, 'biao.sqlite'),
    workspaceRoots: [rootDir],
    apiToken: OWNER_TOKEN,
    workerApiToken: deriveWorkerApiToken(OWNER_TOKEN),
    authEnabled: true,
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  }, { webDist: null });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address() as AddressInfo | null;
  if (!address) throw new Error('Biao test server did not listen');
  baseUrl = `http://127.0.0.1:${address.port}`;
  await submitFixturePlan();
}, 20_000);

afterAll(async () => {
  await server?.close();
  setSqliteStore(null);
  store?.close();
  await redis?.flushdb();
  redis?.disconnect();
  if (previousWorkspaceRoots === undefined) delete process.env.BIAO_WORKSPACE_ROOTS;
  else process.env.BIAO_WORKSPACE_ROOTS = previousWorkspaceRoots;
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

describe('LAN stdio MCP adapter', () => {
  it('两个隔离客户端读取同一中央事实，并让中央 CAS 决定唯一 claim 赢家', async () => {
    const observedUrls: string[] = [];
    const rawClaimTokens: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      observedUrls.push(String(input));
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith('/claim')) {
        const body = await response.clone().json() as { data?: { claim_token?: string } };
        if (body.data?.claim_token) rawClaimTokens.push(body.data.claim_token);
      }
      return response;
    };
    const env = { BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN };
    const nodeA = createLanMcpRuntime(env, { fetch: recordingFetch });
    const nodeB = createLanMcpRuntime(env, { fetch: recordingFetch });

    const [[plansA, plansB], [statusA, statusB], [tasksA, tasksB]] = await Promise.all([
      Promise.all([toolPayload(nodeA, 'plan_list'), toolPayload(nodeB, 'plan_list')]),
      Promise.all([
        toolPayload(nodeA, 'plan_status', { plan_id: 'mcp-lan-plan' }),
        toolPayload(nodeB, 'plan_status', { plan_id: 'mcp-lan-plan' }),
      ]),
      Promise.all([
        toolPayload(nodeA, 'task_list', { plan_id: 'mcp-lan-plan' }),
        toolPayload(nodeB, 'task_list', { plan_id: 'mcp-lan-plan' }),
      ]),
    ]);
    expect(plansA.payload).toEqual(plansB.payload);
    expect(statusA.payload).toEqual(statusB.payload);
    expect(tasksA.payload).toEqual(tasksB.payload);
    expect(plansA.payload.data.plans[0]).not.toHaveProperty('project_path');

    const [claimA, claimB] = await Promise.all([
      toolPayload(nodeA, 'task_claim', {
        agent_id: 'mcp-node-a',
        preferred_plan_ids: ['mcp-lan-plan'],
        capabilities: ['code'],
      }),
      toolPayload(nodeB, 'task_claim', {
        agent_id: 'mcp-node-b',
        preferred_plan_ids: ['mcp-lan-plan'],
        capabilities: ['code'],
      }),
    ]);
    const winners = [claimA, claimB].filter((result) => result.payload.ok && result.payload.data);
    expect(winners).toHaveLength(1);
    expect(rawClaimTokens).toHaveLength(1);
    expect(winners[0].payload.data).toMatchObject({ task_id: 'mcp-lan-shared-task', plan_id: 'mcp-lan-plan' });
    expect(winners[0].payload.data).not.toHaveProperty('claim_token');
    expect(winners[0].payload.data).not.toHaveProperty('project_path');
    expect(winners[0].payload.data).not.toHaveProperty('verify');

    const winnerRuntime = claimA.payload.data ? nodeA : nodeB;
    const winnerAgent = claimA.payload.data ? 'mcp-node-a' : 'mcp-node-b';
    const ownership = await toolPayload(winnerRuntime, 'ownership_check', {
      path: 'src/shared.ts',
      agent_id: winnerAgent,
    });
    expect(ownership.payload).toMatchObject({ ok: true, data: { occupied: true, action: 'proceed' } });

    const report = await toolPayload(winnerRuntime, 'task_report', {
      task_id: 'mcp-lan-shared-task',
      agent_id: winnerAgent,
      status: 'failed',
    });
    expect(report.payload).toMatchObject({ ok: true, data: { task_id: 'mcp-lan-shared-task', status: 'failed' } });

    const allProtocolOutput = [plansA, plansB, statusA, statusB, tasksA, tasksB, claimA, claimB, ownership, report]
      .map((item) => item.serialized)
      .join('\n');
    expect(allProtocolOutput).not.toContain(OWNER_TOKEN);
    expect(allProtocolOutput).not.toContain(rawClaimTokens[0]);
    expect(allProtocolOutput).not.toContain(rootDir);
    expect(allProtocolOutput).not.toContain(VERIFY_COMMAND);
    expect(observedUrls.every((url) => !url.includes(OWNER_TOKEN))).toBe(true);
  });

  it('report done 只进入待验收，MCP 不开放验收写入口', async () => {
    const planDir = join(rootDir, 'plans', 'review-plan');
    mkdirSync(join(planDir, 'tasks'), { recursive: true });
    writeFileSync(join(planDir, 'index.md'), [
      '---',
      'plan_id: mcp-review-plan',
      'title: Review gate plan',
      `project_path: ${rootDir}`,
      'phases: [{id: impl, name: Implementation}]',
      '---',
      '',
    ].join('\n'));
    writeFileSync(join(planDir, 'tasks', 'review-task.md'), [
      '---',
      'task_id: mcp-review-task',
      'title: Requires independent acceptance',
      'type: code',
      'phase: impl',
      'assignee: auto',
      'ownership: {files: [src/review.ts]}',
      '---',
      '',
      'Deliver through the normal review gate.',
    ].join('\n'));
    const submit = await fetch(`${baseUrl}/plan/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ plan_dir: planDir }),
    });
    expect((await submit.json()) as unknown).toMatchObject({ ok: true });

    const writePaths: string[] = [];
    const runtime = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN }, {
      fetch: async (input, init) => {
        writePaths.push(new URL(String(input)).pathname);
        return fetch(input, init);
      },
    });
    const claim = await toolPayload(runtime, 'task_claim', {
      agent_id: 'mcp-review-worker',
      preferred_plan_ids: ['mcp-review-plan'],
    });
    expect(claim.payload.data.task_id).toBe('mcp-review-task');
    const heartbeat = await toolPayload(runtime, 'task_heartbeat', {
      agent_id: 'mcp-review-worker',
      current_task: 'mcp-review-task',
    });
    expect(heartbeat.payload).toMatchObject({ ok: true });
    expect(writePaths).toEqual(expect.arrayContaining(['/heartbeat', '/lease/renew']));
    const report = await toolPayload(runtime, 'task_report', {
      task_id: 'mcp-review-task',
      agent_id: 'mcp-review-worker',
      status: 'done',
    });
    expect(report.payload).toMatchObject({ ok: true });

    const pending = await toolPayload(runtime, 'pm_review_list', { plan_id: 'mcp-review-plan' });
    expect(pending.payload.data.tasks).toEqual([
      expect.objectContaining({ task_id: 'mcp-review-task', status: 'done' }),
    ]);
    expect(pending.payload.data.tasks[0]).not.toHaveProperty('pm_review_status');
    const review = await toolPayload(runtime, 'pm_review_read', { task_id: 'mcp-review-task' });
    expect(review.payload.data).toMatchObject({
      task_id: 'mcp-review-task',
      status: 'done',
      awaiting_independent_review: true,
    });
    expect(review.payload.data).not.toHaveProperty('result_md');
    expect(review.payload.data).not.toHaveProperty('result_json');

    const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, runtime);
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual([
      'health', 'plan_list', 'plan_status', 'task_list', 'task_get', 'ownership_check',
      'pm_review_list', 'pm_review_read', 'task_claim', 'task_heartbeat', 'task_report',
      'task_block', 'question_ask',
    ]);
    expect(names.some((name) => /review_(?:accept|reject|write)/.test(name))).toBe(false);
  });

  it('Question ask 与 task block 只使用会话内 lease，不接受凭据参数', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let claimIndex = 0;
    const runtime = createLanMcpRuntime({
      BIAO_URL: 'http://127.0.0.1:7331',
      BIAO_API_TOKEN: 'adapter-api-secret',
    }, {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        requestBodies.push({ path, ...body });
        let data: Record<string, unknown> = {};
        if (path === '/health') data = { version: 'v1' };
        else if (path === '/register') data = { registration_id: body.registration_id };
        else if (path === '/claim') {
          claimIndex += 1;
          data = {
            task_id: claimIndex === 1 ? 'question-task' : 'block-task',
            plan_id: 'write-tools-plan',
            claim_token: `lease-secret-${claimIndex}`,
          };
        } else if (path === '/question') data = { question_id: 'question-1', status: 'open' };
        else if (path === '/task/block-task/block') data = { task_id: 'block-task', blocked: true };
        return new Response(JSON.stringify({ ok: true, data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const firstClaim = await toolPayload(runtime, 'task_claim', { agent_id: 'write-tools-agent' });
    const question = await toolPayload(runtime, 'question_ask', {
      task_id: 'question-task',
      agent_id: 'write-tools-agent',
      body: 'Need a PM decision',
    });
    const secondClaim = await toolPayload(runtime, 'task_claim', { agent_id: 'write-tools-agent' });
    const blocked = await toolPayload(runtime, 'task_block', {
      task_id: 'block-task',
      agent_id: 'write-tools-agent',
      reason: 'waiting_dependency',
    });
    expect([firstClaim.payload, question.payload, secondClaim.payload, blocked.payload].every((item) => item.ok)).toBe(true);
    expect(requestBodies.find((item) => item.path === '/question')).toMatchObject({ claim_token: 'lease-secret-1' });
    expect(requestBodies.find((item) => item.path === '/task/block-task/block')).toMatchObject({ claim_token: 'lease-secret-2' });
    const protocolOutput = [firstClaim, question, secondClaim, blocked].map((item) => item.serialized).join('\n');
    expect(protocolOutput).not.toContain('adapter-api-secret');
    expect(protocolOutput).not.toContain('lease-secret-1');
    expect(protocolOutput).not.toContain('lease-secret-2');
  });

  it('401、403、超时与 HTTP/API 协议错配全部 fail closed', async () => {
    const unauthorized = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: 'wrong-secret' });
    const unauthorizedResult = await toolPayload(unauthorized, 'plan_list');
    expect(unauthorizedResult).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_UNAUTHORIZED' } } });
    expect(unauthorizedResult.serialized).not.toContain('wrong-secret');

    const workerScoped = createLanMcpRuntime({
      BIAO_URL: baseUrl,
      BIAO_API_TOKEN: deriveWorkerApiToken(OWNER_TOKEN),
    });
    const forbiddenResult = await toolPayload(workerScoped, 'plan_list');
    expect(forbiddenResult).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_FORBIDDEN' } } });

    const timeoutFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const timeoutRuntime = createLanMcpRuntime({
      BIAO_URL: 'http://127.0.0.1:7331',
      BIAO_API_TOKEN: 'timeout-secret',
      BIAO_MCP_TIMEOUT_MS: '20',
    }, { fetch: timeoutFetch });
    const timeoutResult = await toolPayload(timeoutRuntime, 'health');
    expect(timeoutResult).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_TIMEOUT' } } });
    expect(timeoutResult.serialized).not.toContain('timeout-secret');

    const bodyTimeoutRuntime = createLanMcpRuntime({
      BIAO_URL: 'http://127.0.0.1:7331',
      BIAO_API_TOKEN: 'body-timeout-secret',
      BIAO_MCP_TIMEOUT_MS: '20',
    }, {
      fetch: async (_input, init) => new Response(new ReadableStream({
        start(controller) {
          const fallback = setTimeout(() => controller.error(new Error('body stalled')), 100);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(fallback);
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    const bodyTimeout = await toolPayload(bodyTimeoutRuntime, 'health');
    expect(bodyTimeout).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_TIMEOUT' } } });
    expect(bodyTimeout.serialized).not.toContain('body-timeout-secret');

    const mismatchRuntime = createLanMcpRuntime({
      BIAO_URL: 'http://127.0.0.1:7331',
      BIAO_API_TOKEN: 'protocol-secret',
    }, {
      fetch: async () => new Response(JSON.stringify({ ok: true, data: { version: 'v999' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const mismatchResult = await toolPayload(mismatchRuntime, 'health');
    expect(mismatchResult).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_PROTOCOL_MISMATCH' } } });
    expect(mismatchResult.serialized).not.toContain('protocol-secret');

    let echoCall = 0;
    const echoRuntime = createLanMcpRuntime({
      BIAO_URL: 'http://127.0.0.1:7331',
      BIAO_API_TOKEN: 'echo-secret',
    }, {
      fetch: async () => {
        const health = echoCall++ === 0;
        return new Response(JSON.stringify(health
          ? { ok: true, data: { version: 'v1' } }
          : {
              ok: false,
              data: null,
              error: {
                code: 'REMOTE_VALIDATION_CODE',
                message: 'request rejected: echo-secret /Users/private/work node private-command.mjs',
                details: { authorization: 'echo-secret', local_path: '/Users/private/work' },
              },
            }), { status: health ? 200 : 400, headers: { 'content-type': 'application/json' } });
      },
    });
    const echoedError = await toolPayload(echoRuntime, 'plan_list');
    expect(echoedError).toMatchObject({ isError: true, payload: { error: { code: 'REMOTE_VALIDATION_CODE' } } });
    expect(echoedError.serialized).not.toContain('echo-secret');
    expect(echoedError.serialized).not.toContain('/Users/private/work');
    expect(echoedError.serialized).not.toContain('private-command.mjs');

    const tokenArgument = await rpcTool(
      createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN }),
      'health',
      { api_token: 'must-not-be-an-argument' },
    );
    expect(tokenArgument?.error?.code).toBe(-32602);
    expect(JSON.stringify(tokenArgument)).not.toContain('must-not-be-an-argument');
  });

  it('默认入口只有 stdio，进程输出不包含 Token、启动命令或本地路径', async () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const script = readFileSync(join(repoRoot, 'scripts', 'mcp-server.mjs'), 'utf8');
    const stdioSource = readFileSync(join(repoRoot, 'src', 'mcp', 'stdio.ts'), 'utf8');
    expect(`${script}\n${stdioSource}`).not.toMatch(/\.listen\s*\(/);

    const centralMcp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(centralMcp.status).toBe(404);

    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'mcp-server.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated-client', version: '1' } },
    })}\n`);
    const exitCode = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'biao-lan-mcp' }, capabilities: { tools: {} } },
    });
    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain(OWNER_TOKEN);
    expect(combined).not.toContain(baseUrl);
    expect(combined).not.toContain(repoRoot);
    expect(combined).not.toContain(process.execPath);
  });
});
