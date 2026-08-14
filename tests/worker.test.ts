/**
 * 测试 5：worker base 层（verify 真实执行 + result 写入）
 * 对应 P1/P4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BiaoClient,
  runVerifyCommands,
  writeResult,
  runAgentCli,
  resolveOwnershipConflict,
  runWorkerLoop,
  extractQuestionMarker,
} from '../src/worker/base.js';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaimedTask, VerifyCommand } from '../src/types/index.js';

let tmpDir: string;

function transientFetchError(message = 'fetch failed'): TypeError {
  const error = new TypeError(message);
  Object.assign(error, { cause: { code: 'ECONNRESET' } });
  return error;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'biao-worker-test-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runVerifyCommands', () => {
  it('成功的命令返回 passed=true', () => {
    const verify: VerifyCommand[] = [{ cmd: 'echo hello', expect_exit: 0 }];
    const results = runVerifyCommands(verify, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].exit_code).toBe(0);
    expect(results[0].output).toContain('hello');
  });

  it('失败的命令返回 passed=false', () => {
    const verify: VerifyCommand[] = [{ cmd: 'exit 1', expect_exit: 0 }];
    const results = runVerifyCommands(verify, tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].exit_code).toBe(1);
  });

  it('expect_exit 匹配非 0 退出码', () => {
    const verify: VerifyCommand[] = [{ cmd: 'exit 42', expect_exit: 42 }];
    const results = runVerifyCommands(verify, tmpDir);
    expect(results[0].passed).toBe(true);
    expect(results[0].exit_code).toBe(42);
  });

  it('scope 参数指定工作目录', () => {
    const { mkdirSync } = require('node:fs');
    const subDir = join(tmpDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(tmpDir, 'marker.txt'), 'root');
    writeFileSync(join(subDir, 'marker.txt'), 'sub');
    // scope='sub' 应在子目录执行
    const verifySub: VerifyCommand[] = [{ cmd: 'cat marker.txt', expect_exit: 0, scope: 'sub' }];
    const resultsSub = runVerifyCommands(verifySub, tmpDir);
    expect(resultsSub[0].output).toContain('sub');
    // scope='.' 应在根目录执行
    const verifyRoot: VerifyCommand[] = [{ cmd: 'cat marker.txt', expect_exit: 0, scope: '.' }];
    const resultsRoot = runVerifyCommands(verifyRoot, tmpDir);
    expect(resultsRoot[0].output).toContain('root');
  });

  it('拒绝逃逸项目根目录的 scope', () => {
    const results = runVerifyCommands([{ cmd: 'pwd', scope: '..' }], tmpDir);
    expect(results[0].passed).toBe(false);
    expect(results[0].output).toContain('VERIFY_SCOPE_DENIED');
  });

  it('不把 Biao 控制面凭证传给 verify 命令', () => {
    const previous = process.env.BIAO_API_TOKEN;
    process.env.BIAO_API_TOKEN = 'verify-must-not-leak';
    try {
      const results = runVerifyCommands([
        { cmd: `${JSON.stringify(process.execPath)} -e 'process.exit(process.env.BIAO_API_TOKEN ? 7 : 0)'` },
      ], tmpDir);
      expect(results).toMatchObject([{ exit_code: 0, passed: true }]);
    } finally {
      if (previous === undefined) delete process.env.BIAO_API_TOKEN;
      else process.env.BIAO_API_TOKEN = previous;
    }
  });
});

describe('writeResult', () => {
  it('写入 result.md 和 result.json', () => {
    const task: ClaimedTask = {
      task_id: 'test-task',
      title: '测试任务',
      type: 'code',
      phase: 'impl',
      priority: 5,
      ownership_files: [],
      goal_md: '',
      timeout_seconds: 60,
      claim_token: 'tok_x',
      verify: [],
    };
    const agentRun = {
      exitCode: 0,
      stdout: 'output here',
      stderr: '',
      durationMs: 1500,
      timedOut: false,
    };
    const verifyResults = [{ cmd: 'echo hi', exit_code: 0, passed: true, output: 'hi' }];

    const { resultMdPath, resultJsonPath } = writeResult(
      join(tmpDir, 'work', 'test-task'),
      task,
      agentRun,
      verifyResults,
      'cli-1',
      'cli',
      'human',
      ['apps/server/foo.ts'],
    );

    const md = readFileSync(resultMdPath, 'utf8');
    expect(md).toContain('测试任务');
    expect(md).toContain('cli-1');
    expect(md).toContain('apps/server/foo.ts');
    expect(md).toContain('PASS');

    const json = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
    expect(json.status).toBe('success');
    expect(json.worker).toBe('cli-1');
    expect(json.returncode).toBe(0);
    expect(json.changed_files).toContain('apps/server/foo.ts');
  });

  it('失败时 status=failed', () => {
    const task: ClaimedTask = {
      task_id: 't2',
      title: '失败任务',
      type: 'code',
      phase: 'impl',
      priority: 5,
      ownership_files: [],
      goal_md: '',
      timeout_seconds: 60,
      claim_token: 'tok',
      verify: [],
    };
    const agentRun = {
      exitCode: 1,
      stdout: '',
      stderr: 'error',
      durationMs: 500,
      timedOut: false,
    };
    const { resultJsonPath } = writeResult(
      join(tmpDir, 'work', 't2'), task, agentRun, [], 'cli-1', 'cli', 'm', [],
    );
    const json = JSON.parse(readFileSync(resultJsonPath, 'utf8'));
    expect(json.status).toBe('failed');
    expect(json.returncode).toBe(1);
  });

  it('命令成功但 verify 失败时 result.json 仍为 failed', () => {
    const task = {
      task_id: 'verify-failed',
      title: '验证失败',
      type: 'code',
      phase: 'impl',
      priority: 5,
      ownership_files: [],
      goal_md: '',
      timeout_seconds: 60,
      claim_token: 'tok',
      verify: [{ cmd: 'false' }],
      project_path: tmpDir,
      plan_id: 'p1',
    } as ClaimedTask;
    const { resultJsonPath } = writeResult(
      join(tmpDir, 'work', 'verify-failed'),
      task,
      { exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false },
      [{ cmd: 'false', exit_code: 1, passed: false, output: '' }],
      'cli-1',
      'cli',
      'm',
      [],
    );
    expect(JSON.parse(readFileSync(resultJsonPath, 'utf8')).status).toBe('failed');
  });
});

describe('BiaoClient', () => {
  it('注册重试复用同一高熵 epoch，后续心跳与离线都携带它', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) throw transientFetchError();
      if (bodies.length === 2) {
        return new Response(JSON.stringify({
          ok: true,
          data: { agent_id: 'epoch-client', registration_id: body.registration_id },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'epoch-client');
    await expect(client.register('cli', ['code'])).resolves.toMatchObject({ ok: true });
    await client.claim({ blocking: false });
    await client.heartbeat('task-1');
    await client.offline('worker_exit');

    const registrationIds = bodies.map((body) => body.registration_id);
    expect(registrationIds).toHaveLength(5);
    expect(registrationIds.every((id) => id === registrationIds[0])).toBe(true);
    expect(registrationIds[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/);
    expect(bodies[0]).toMatchObject({ agent_id: 'epoch-client', agent_type: 'cli' });
    expect(bodies[2]).toMatchObject({ agent_id: 'epoch-client', blocking: false });
    expect(bodies[3]).toMatchObject({ agent_id: 'epoch-client', current_task: 'task-1' });
    expect(bodies[4]).toMatchObject({ agent_id: 'epoch-client', reason: 'worker_exit' });
  });

  it('uses an explicit offline endpoint instead of overloading heartbeat', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-offline');
    await client.offline('worker_exit');

    expect(fetchMock.mock.calls[0][0]).toBe('http://biao.test/agent/offline');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      agent_id: 'worker-offline',
      registration_id: expect.stringMatching(/^reg_[a-f0-9]{32}$/),
      reason: 'worker_exit',
    });
  });

  it('遇到一次 ECONNRESET 后重试并返回服务响应', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(transientFetchError())
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { recovered: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-retry');
    await expect(client.heartbeat()).resolves.toEqual({ ok: true, data: { recovered: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('重试耗尽后仍向调用方暴露通讯失败，不伪造成功响应', async () => {
    const fetchMock = vi.fn(async () => { throw transientFetchError('socket closed'); });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-retry');
    await expect(client.heartbeat()).rejects.toThrow('socket closed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('HTTP 503 后重试，并使用恢复后的响应', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { recovered: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-retry');
    await expect(client.heartbeat()).resolves.toEqual({ ok: true, data: { recovered: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('配置 token 后为 API 请求发送 Bearer 认证', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-1', 'secret-token');
    await client.heartbeat();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-token');
  });

  it('Question 通过受控平台接口携带当前 task/token，不把控制面 token 交给 agent 子进程', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { question_id: 'q-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-1', 'secret-token');
    await client.createQuestion('task-1', 'claim-1', '需要 PM 决定', '已完成第一步');

    expect(fetchMock.mock.calls[0][0]).toBe('http://biao.test/question');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-token');
    expect(JSON.parse(String(init.body))).toEqual({
      task_id: 'task-1', agent_id: 'worker-1', claim_token: 'claim-1',
      body: '需要 PM 决定', checkpoint: '已完成第一步',
    });
  });

  it('Question 扩权申请通过 Worker 数据面发送结构化 requested_ownership', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { question_id: 'q-scope' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-1', 'worker-token');
    await client.createQuestion(
      'task-1', 'claim-1', '需要增加测试文件', '实现已完成',
      { files: ['tests/new.test.ts'], modules: ['api-tests'] },
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      requested_ownership: { files: ['tests/new.test.ts'], modules: ['api-tests'] },
    });
  });

  it('共享 Supervisor 的冲突搁置通过受控接口释放当前 claim', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { blocked: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BiaoClient('http://biao.test', 'worker-1', 'secret-token');
    await client.blockTask('task-1', 'claim-1', 'waiting_file_release');

    expect(fetchMock.mock.calls[0][0]).toBe('http://biao.test/task/task-1/block');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret-token');
    expect(JSON.parse(String(init.body))).toEqual({
      agent_id: 'worker-1', claim_token: 'claim-1', reason: 'waiting_file_release',
    });
  });
});

describe('Worker Question marker', () => {
  it('只接受明确的单行 JSON 标记，普通自然语言不会误发给 PM', () => {
    expect(extractQuestionMarker('我可能需要问 PM，但先继续')).toBeUndefined();
    expect(extractQuestionMarker('log\nBIAO_QUESTION: {"body":"选 A 还是 B？","checkpoint":"已完成 parse"}\n')).toEqual({
      body: '选 A 还是 B？', checkpoint: '已完成 parse',
    });
    expect(() => extractQuestionMarker('BIAO_QUESTION: ask PM')).toThrow('必须是单行 JSON');
  });

  it('解析结构化 requested_ownership，供 PM 显式批准后 fresh claim', () => {
    expect(extractQuestionMarker(
      'BIAO_QUESTION: {"body":"需要扩权","requested_ownership":{"files":["tests/new.test.ts"],"modules":["api-tests"]}}',
    )).toEqual({
      body: '需要扩权',
      requestedOwnership: { files: ['tests/new.test.ts'], modules: ['api-tests'] },
    });
  });

  it('只从最后一条 Codex final agent_message 中识别嵌入的合法 Question 标记', () => {
    const earlierAgentMessage = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'BIAO_QUESTION: {"body":"旧问题，不能再提交","checkpoint":"旧检查点"}',
      },
    });
    const finalAgentMessage = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '执行暂停。\nBIAO_QUESTION: {"body":"需要确认发版窗口","checkpoint":"集成测试已通过"}',
      },
    });
    const toolLog = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        text: 'BIAO_QUESTION: {"body":"工具日志不能成为 PM 指令"}',
      },
    });

    expect(extractQuestionMarker(`${earlierAgentMessage}\n${toolLog}\n${finalAgentMessage}`)).toEqual({
      body: '需要确认发版窗口', checkpoint: '集成测试已通过',
    });
    expect(extractQuestionMarker(toolLog)).toBeUndefined();

    const finalAgentMessageWithoutText = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: null },
    });
    expect(extractQuestionMarker(`${earlierAgentMessage}\n${finalAgentMessageWithoutText}`)).toBeUndefined();
  });

  it('Codex final agent_message 内的格式错误标记会 fail closed', () => {
    const malformedAgentMessage = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'BIAO_QUESTION: 请 PM 决定' },
    });

    expect(() => extractQuestionMarker(malformedAgentMessage)).toThrow('必须是单行 JSON');
  });
});

describe('runWorkerLoop 常驻生命周期', () => {
  function fakeTask(): ClaimedTask {
    return {
      task_id: 'worker-loop-1',
      title: 'worker loop',
      type: 'code',
      phase: 'impl',
      priority: 5,
      ownership_files: [],
      goal_md: '',
      timeout_seconds: 60,
      claim_token: 'tok-loop',
      verify: [],
      project_path: tmpDir,
      plan_id: 'loop-plan',
    };
  }

  it('maxTasks=0 时空队列不会退出，会轮询到显式停止', async () => {
    const controller = new AbortController();
    let claimCount = 0;
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => {
        claimCount++;
        if (claimCount >= 2) controller.abort();
        return { ok: true, data: null };
      }),
    } as unknown as BiaoClient;

    await runWorkerLoop({
      agentId: 'daemon-1',
      agentType: 'cli',
      maxTasks: 0,
      idlePollMs: 1,
      signal: controller.signal,
      client,
      execute: async () => { throw new Error('不应执行'); },
    });

    expect(claimCount).toBeGreaterThanOrEqual(2);
    expect(client.heartbeat).toHaveBeenCalled();
  });

  it('standalone Worker normal exit explicitly goes offline', async () => {
    const offline = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: null })),
      offline,
    } as unknown as BiaoClient;

    await runWorkerLoop({
      agentId: 'standalone-offline', agentType: 'cli', maxTasks: 1, client,
      execute: async () => { throw new Error('should not execute'); },
    });

    expect(offline).toHaveBeenCalledOnce();
    expect(offline).toHaveBeenCalledWith('worker_exit');
  });

  it('abort 执行不写 result、不 report 业务终态，等 execute close 后才 offline 且不清空 current task', async () => {
    const task = fakeTask();
    const controller = new AbortController();
    let executing = false;
    let closeExecution!: () => void;
    const executionClosed = new Promise<void>((resolve) => { closeExecution = resolve; });
    const order: string[] = [];
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const heartbeat = vi.fn(async (currentTask?: string) => {
      order.push(`heartbeat:${currentTask ?? ''}`);
      return { ok: true, data: {} };
    });
    const offline = vi.fn(async () => {
      order.push('offline');
      return { ok: true, data: {} };
    });
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat,
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'abort-worker' } })),
      renewLease: vi.fn(async () => ({ ok: true, data: {} })),
      report,
      offline,
    } as unknown as BiaoClient;
    const running = runWorkerLoop({
      agentId: 'abort-worker', agentType: 'cli', maxTasks: 1, signal: controller.signal, client,
      execute: async (_task, _project, signal) => {
        executing = true;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
        await executionClosed;
        order.push('execute-close');
        return {
          run: { exitCode: 130, stdout: '', stderr: '', durationMs: 10, timedOut: false, aborted: true },
          changedFiles: [], backend: 'test', model: 'test',
        };
      },
    });

    while (!executing) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(offline).not.toHaveBeenCalled();
    closeExecution();
    await running;

    expect(report).not.toHaveBeenCalled();
    expect(existsSync(join(tmpDir, 'work', task.task_id, 'result.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'work', task.task_id, 'result.json'))).toBe(false);
    expect(offline).toHaveBeenCalledOnce();
    expect(offline).toHaveBeenCalledWith('worker_signal');
    expect(order.indexOf('offline')).toBeGreaterThan(order.indexOf('execute-close'));
    const lastTaskHeartbeat = order.lastIndexOf(`heartbeat:${task.task_id}`);
    expect(lastTaskHeartbeat).toBeGreaterThanOrEqual(0);
    expect(order.slice(lastTaskHeartbeat + 1)).not.toContain('heartbeat:');
  });

  it('abort 后 execute 抛错也不得误报 failed，保留 running 等 lease 回收', async () => {
    const task = fakeTask();
    const controller = new AbortController();
    let executing = false;
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const heartbeat = vi.fn(async () => ({ ok: true, data: {} }));
    const offline = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat,
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'abort-throw-worker' } })),
      renewLease: vi.fn(async () => ({ ok: true, data: {} })),
      report,
      offline,
    } as unknown as BiaoClient;

    const running = runWorkerLoop({
      agentId: 'abort-throw-worker', agentType: 'cli', maxTasks: 1, signal: controller.signal, client,
      execute: async (_task, _project, signal) => {
        executing = true;
        await new Promise<void>((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
        throw new Error('child closed with abort error');
      },
    });

    while (!executing) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await running;

    expect(report).not.toHaveBeenCalled();
    expect(existsSync(join(tmpDir, 'work', task.task_id, 'result.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'work', task.task_id, 'result.json'))).toBe(false);
    expect(offline).toHaveBeenCalledOnce();
    expect(offline).toHaveBeenCalledWith('worker_signal');
    expect(heartbeat).toHaveBeenLastCalledWith(task.task_id);
  });

  it('执行任务前后更新 heartbeat 的 current_task', async () => {
    const task = fakeTask();
    let claimed = false;
    const heartbeat = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat,
      claim: vi.fn(async () => {
        if (claimed) return { ok: true, data: null };
        claimed = true;
        return { ok: true, data: task };
      }),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'daemon-2' } })),
      report: vi.fn(async () => ({ ok: true, data: {} })),
    } as unknown as BiaoClient;

    await runWorkerLoop({
      agentId: 'daemon-2',
      agentType: 'cli',
      maxTasks: 1,
      client,
      execute: async () => ({
        run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
        changedFiles: [],
        backend: 'test',
        model: 'test',
      }),
    });

    expect(heartbeat).toHaveBeenCalledWith('worker-loop-1');
    expect(heartbeat).toHaveBeenLastCalledWith(undefined);
  });

  it('PM 在 Worker 执行期间并发修改 plan MD 时，不将外部变更误归因给当前 Agent', async () => {
    const task = fakeTask();
    const planDir = join(tmpDir, 'plans', 'loop-plan');
    const planPath = join(planDir, 'index.md');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(planPath, '# 初始计划\n');

    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'concurrent-worker' } })),
      report,
    } as unknown as BiaoClient;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'concurrent-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => {
        // 模拟另一个 PM/Worker 在当前 Agent 运行期间修改计划文件；
        // 当前 Agent 的机器可读报告明确表示没有改动文件。
        await new Promise<void>((resolveMutation) => {
          setTimeout(() => {
            writeFileSync(planPath, '# PM 并发更新\n');
            resolveMutation();
          }, 0);
        });
        return {
          run: { exitCode: 0, stdout: 'no file changes', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: [], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(tmpDir, 'work', task.task_id, 'result.json'), 'utf8'));
    expect(result.plan_md_violations).toBeUndefined();
    expect(output.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('违反 MD 职责分离');
    expect(report).toHaveBeenCalledWith(
      task.task_id, task.claim_token, 'done', expect.any(String), expect.any(String), [],
    );
    output.mockRestore();
  });

  it('Agent 报告的 changed_files 包含实际变更的 plan MD 时仍记录职责分离违规', async () => {
    const task = fakeTask();
    const planDir = join(tmpDir, 'plans', 'loop-plan');
    const planPath = join(planDir, 'index.md');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(planPath, '# 初始计划\n');

    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'violating-worker' } })),
      report: vi.fn(async () => ({ ok: true, data: {} })),
    } as unknown as BiaoClient;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'violating-worker',
      agentType: 'test',
      maxTasks: 1,
      client,
      execute: async () => {
        writeFileSync(planPath, '# Agent 非法修改\n');
        return {
          run: { exitCode: 0, stdout: 'changed plan', stderr: '', durationMs: 1, timedOut: false },
          changedFiles: ['plans/loop-plan/index.md'], backend: 'test', model: 'test',
        };
      },
    });

    const result = JSON.parse(readFileSync(join(tmpDir, 'work', task.task_id, 'result.json'), 'utf8'));
    expect(result.plan_md_violations).toEqual([{ path: 'loop-plan/index.md', changeType: 'modified' }]);
    expect(output.mock.calls.map(([line]) => String(line)).join('\n')).toContain('违反 MD 职责分离');
    output.mockRestore();
  });

  it('report 通讯瞬断但平台已记录 done 时，不补报 failed 或生成重复修复', async () => {
    const task = fakeTask();
    const report = vi.fn(async () => { throw transientFetchError(); });
    const getTask = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { status: 'running', claimed_by: 'report-network-worker' } })
      .mockResolvedValueOnce({ ok: true, data: { status: 'done', claimed_by: 'report-network-worker' } });
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask,
      report,
    } as unknown as BiaoClient;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'report-network-worker',
      agentType: 'cli',
      maxTasks: 1,
      client,
      execute: async () => ({
        run: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
        changedFiles: [], backend: 'test', model: 'test',
      }),
    });

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      'worker-loop-1', 'tok-loop', 'done', expect.any(String), expect.any(String), [],
    );
    expect(report.mock.calls.some((args) => args[2] === 'failed')).toBe(false);
    expect(getTask).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('普通 failed 自动创建 repair 后明确提示下一步，不要求 Worker 重置原任务或问人', async () => {
    const task = fakeTask();
    const report = vi.fn(async () => ({
      ok: true,
      data: {
        task_id: task.task_id,
        status: 'failed',
        resolution: {
          state: 'repairing', action: 'repair', source_task_id: task.task_id,
          repair_task_id: 'worker-loop-1-repair-1',
        },
      },
    }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'failed-worker' } })),
      report,
    } as unknown as BiaoClient;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'failed-worker',
      agentType: 'cli',
      maxTasks: 1,
      client,
      execute: async () => ({
        run: { exitCode: 1, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false },
        changedFiles: [], backend: 'test', model: 'test',
      }),
    });

    expect(report).toHaveBeenCalledWith(
      'worker-loop-1', 'tok-loop', 'failed', expect.any(String), expect.any(String), [],
    );
    const lines = output.mock.calls.map(([line]) => String(line)).join('\n');
    expect(lines).toContain('自动修复：worker-loop-1 → worker-loop-1-repair-1');
    expect(lines).toContain('不重置原任务，继续领取下一项');
    expect(lines).toContain('独立 PM 验收');
  });

  it('agent 执行异常后的 failed report 也交接自动修复，而不是静默结束', async () => {
    const task = fakeTask();
    const report = vi.fn(async () => ({
      ok: true,
      data: {
        task_id: task.task_id,
        status: 'failed',
        resolution: {
          state: 'repairing', action: 'repair', source_task_id: task.task_id,
          repair_task_id: 'worker-loop-1-repair-1',
        },
      },
    }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'exception-worker' } })),
      report,
    } as unknown as BiaoClient;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'exception-worker',
      agentType: 'cli',
      maxTasks: 1,
      client,
      execute: async () => { throw new Error('agent crashed'); },
    });

    expect(report).toHaveBeenCalledWith('worker-loop-1', 'tok-loop', 'failed', undefined, undefined, []);
    const lines = output.mock.calls.map(([line]) => String(line)).join('\n');
    expect(lines).toContain('自动修复：worker-loop-1 → worker-loop-1-repair-1');
    expect(lines).toContain('不重置原任务，继续领取下一项');
    expect(errors).toHaveBeenCalled();
  });

  it('agent 输出 Question 标记时提交到平台并释放当前循环，不回退为向人类提问或 report', async () => {
    const task = fakeTask();
    const createQuestion = vi.fn(async () => ({ ok: true, data: { question_id: 'q-worker-1' } }));
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const client = {
      register: vi.fn(async () => ({ ok: true, data: {} })),
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      claim: vi.fn(async () => ({ ok: true, data: task })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'running', claimed_by: 'question-worker' } })),
      createQuestion,
      report,
    } as unknown as BiaoClient;

    await runWorkerLoop({
      agentId: 'question-worker',
      agentType: 'cli',
      maxTasks: 1,
      client,
      execute: async () => ({
        run: {
          exitCode: 0,
          stdout: 'BIAO_QUESTION: {"body":"需要确认发版范围","checkpoint":"测试已通过，等待发版"}',
          stderr: '', durationMs: 1, timedOut: false,
        },
        changedFiles: [], backend: 'test', model: 'test',
      }),
    });

    expect(createQuestion).toHaveBeenCalledWith(
      'worker-loop-1', 'tok-loop', '需要确认发版范围', '测试已通过，等待发版',
    );
    expect(report).not.toHaveBeenCalled();
  });

  it('lease 已失效时只引导 Supervisor 回收和 fresh claim，不再让 Worker 带外联系 PM', async () => {
    const task = fakeTask();
    const client = {
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      getTask: vi.fn(async () => ({ ok: true, data: { status: 'blocked', claimed_by: '' } })),
      report: vi.fn(async () => ({ ok: true, data: {} })),
    } as unknown as BiaoClient;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runWorkerLoop({
      agentId: 'stale-worker', agentType: 'cli', maxTasks: 1,
      preclaimedTask: task, skipRegistration: true, heartbeatWhenIdle: false, client,
      execute: async () => { throw new Error('不应继续执行'); },
    });

    const lines = errors.mock.calls.map(([line]) => String(line)).join('\n');
    expect(lines).not.toContain('联系 PM');
    expect(lines).toContain('Supervisor');
    expect(lines).toContain('fresh claim');
    errors.mockRestore();
  });

  it('共享 Supervisor 的 preclaimed 任务遇到 ownership 占用会立即 block，不做 slot 内长轮询或向人类提问', async () => {
    const task = { ...fakeTask(), ownership_files: ['src/locked/**'] };
    const blockTask = vi.fn(async () => ({ ok: true, data: { blocked: true } }));
    const report = vi.fn(async () => ({ ok: true, data: {} }));
    const execute = vi.fn(async () => {
      throw new Error('ownership wait 时不应执行 agent');
    });
    const client = {
      heartbeat: vi.fn(async () => ({ ok: true, data: {} })),
      checkOwnership: vi.fn(async () => ({
        ok: true,
        data: { occupied: true, action: 'wait', owner: { agent_id: 'other-worker', priority: 7 } },
      })),
      blockTask,
      report,
    } as unknown as BiaoClient;

    const started = Date.now();
    await runWorkerLoop({
      agentId: 'shared-slot-a',
      agentType: 'cli',
      maxTasks: 1,
      preclaimedTask: task,
      skipRegistration: true,
      heartbeatWhenIdle: false,
      ownershipConflictMode: 'block',
      client,
      execute,
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(client.checkOwnership).toHaveBeenCalledTimes(1);
    expect(blockTask).toHaveBeenCalledWith('worker-loop-1', 'tok-loop', 'waiting_file_release');
    expect(execute).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});

describe('runAgentCli', () => {
  it('POSIX 使用独立进程组，Windows 使用 taskkill /T 回收子孙进程', async () => {
    const workerBase = await import('../src/worker/base.js') as Record<string, unknown>;
    const plan = workerBase.agentTreeTerminationPlan as
      | ((platform: NodeJS.Platform, pid: number, signal: NodeJS.Signals) => unknown)
      | undefined;

    expect(typeof plan).toBe('function');
    expect(plan?.('darwin', 4321, 'SIGTERM')).toEqual({
      kind: 'process_group', pid: -4321, signal: 'SIGTERM',
    });
    expect(plan?.('win32', 4321, 'SIGTERM')).toEqual({
      kind: 'taskkill', command: 'taskkill.exe', args: ['/PID', '4321', '/T'],
    });
    expect(plan?.('win32', 4321, 'SIGKILL')).toEqual({
      kind: 'taskkill', command: 'taskkill.exe', args: ['/PID', '4321', '/T', '/F'],
    });
  });

  it('执行成功命令', async () => {
    const r = await runAgentCli('echo', ['hello'], tmpDir, 10);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello');
    expect(r.timedOut).toBe(false);
  });

  it('执行失败命令', async () => {
    const r = await runAgentCli('false', [], tmpDir, 10);
    expect(r.exitCode).not.toBe(0);
  });

  it('超时', async () => {
    const r = await runAgentCli('sleep', ['10'], tmpDir, 1);
    expect(r.timedOut).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('超时会强制回收忽略 SIGTERM 的 Agent 及其孙进程', async () => {
    const parentScript = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const grandchild = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.stdout.write('GRANDCHILD_PID:' + grandchild.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const r = await runAgentCli(process.execPath, ['-e', parentScript], tmpDir, 1);
    const grandchildPid = Number(r.stdout.match(/GRANDCHILD_PID:(\d+)/)?.[1]);

    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10_000);

  it.skipIf(process.platform === 'win32')('abort 先 SIGTERM 再强制回收 Agent 进程树，close 后不能 late-write', async () => {
    const readyPath = join(tmpDir, 'abort-ready');
    const termPath = join(tmpDir, 'abort-term');
    const latePath = join(tmpDir, 'abort-late');
    const grandchildLatePath = join(tmpDir, 'abort-grandchild-late');
    const pidPath = join(tmpDir, 'abort-pids.json');
    const grandchildScript = `
      const { writeFileSync } = require('node:fs');
      const late = ${JSON.stringify(grandchildLatePath)};
      process.on('SIGTERM', () => setTimeout(() => writeFileSync(late, 'late'), 1500));
      setTimeout(() => { writeFileSync(late, 'natural-late'); process.exit(0); }, 2500);
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
      process.on('SIGTERM', () => {
        writeFileSync(${JSON.stringify(termPath)}, 'term');
        setTimeout(() => writeFileSync(${JSON.stringify(latePath)}, 'late'), 1500);
      });
      writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
      writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      setTimeout(() => { writeFileSync(${JSON.stringify(latePath)}, 'natural-late'); process.exit(0); }, 2500);
      setInterval(() => {}, 1000);
    `;
    const controller = new AbortController();
    const running = runAgentCli(
      process.execPath,
      ['-e', parentScript],
      tmpDir,
      20,
      undefined,
      undefined,
      controller.signal,
    );
    const deadline = Date.now() + 2_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(readyPath)).toBe(true);
    controller.abort();

    const result = await running;
    const pids = JSON.parse(readFileSync(pidPath, 'utf8')) as { parent: number; grandchild: number };
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(result).toMatchObject({ exitCode: 130, timedOut: false, aborted: true });
    expect(existsSync(termPath)).toBe(true);
    expect(existsSync(latePath)).toBe(false);
    expect(existsSync(grandchildLatePath)).toBe(false);
    expect(() => process.kill(pids.parent, 0)).toThrow();
    expect(() => process.kill(pids.grandchild, 0)).toThrow();
  }, 8_000);

  it('不存在的命令', async () => {
    const r = await runAgentCli('nonexistent-command-xyz', [], tmpDir, 5);
    expect(r.exitCode).toBe(127);
  });

  it('不把 Biao 控制面凭证传给被执行的 agent 命令', async () => {
    const r = await runAgentCli(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.BIAO_API_TOKEN ?? "missing")'],
      tmpDir,
      5,
      { BIAO_API_TOKEN: 'must-not-leak' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('missing');
  });

  it('可通过 stdin 传递长任务正文，避免暴露在进程参数中', async () => {
    const prompt = '# 私有任务正文\n' + 'x'.repeat(32_000);
    const r = await runAgentCli(
      process.execPath,
      ['-e', 'process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s))'],
      tmpDir,
      5,
      undefined,
      prompt,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(prompt);
  });
});

/**
 * 冲突决策引导（对应 biao-ph-ownership-conflict-guide 验收）
 * 模拟 ownership 冲突：验证 worker 打印引导 + 轮询等待 + 超时安全 block
 * 纯本地 mock client，不连 Redis
 */
describe('resolveOwnershipConflict 冲突引导', () => {
  const task = {
    task_id: 't-conflict-1',
    title: '冲突测试',
    priority: 5,
    claim_token: 'tok_test',
  } as unknown as import('../src/types/index.js').ClaimedTask;

  function mockClient(ownershipSeq: Array<{ occupied: boolean; action: string }>) {
    const calls = { declare: [] as unknown[][], report: [] as unknown[][], block: [] as unknown[][] };
    let i = 0;
    const client = {
      checkOwnership: vi.fn(async () => {
        const cur = ownershipSeq[Math.min(i++, ownershipSeq.length - 1)];
        return {
          ok: true,
          data: cur.occupied
            ? { occupied: true, action: cur.action, owner: { agent_id: 'other-worker', priority: 7 } }
            : { occupied: false, action: 'proceed' },
        };
      }),
      declareOwnership: vi.fn(async (...a: unknown[]) => { calls.declare.push(a); return { ok: true }; }),
      report: vi.fn(async (...a: unknown[]) => { calls.report.push(a); return { ok: true }; }),
      blockTask: vi.fn(async (...a: unknown[]) => { calls.block.push(a); return { ok: true }; }),
    } as unknown as BiaoClient;
    return { client, calls };
  }

  it('action=proceed → 直接通过', async () => {
    const { client } = mockClient([{ occupied: false, action: 'proceed' }]);
    expect(await resolveOwnershipConflict(client, 'src/a.ts', task, 'w1', 10, 50)).toBe(true);
  });

  it('action=preempt → 自动抢占（force declare）', async () => {
    const { client, calls } = mockClient([{ occupied: true, action: 'preempt' }]);
    expect(await resolveOwnershipConflict(client, 'src/a.ts', task, 'w1', 10, 50)).toBe(true);
    expect(calls.declare).toHaveLength(1);
    expect(calls.declare[0][3]).toBe(true); // force=true
  });

  it('action=wait → 遗留单 Worker 轮询到释放后通过', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { client } = mockClient([
      { occupied: true, action: 'wait' },
      { occupied: true, action: 'wait' },
      { occupied: false, action: 'proceed' },
    ]);
    expect(await resolveOwnershipConflict(client, 'src/a.ts', task, 'w1', 10, 500)).toBe(true);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('兼容等待');
    expect(out).toContain('不打扰 PM 或人类');
    expect(out).not.toContain('请通过平台 Question');
    logSpy.mockRestore();
  });

  it('action=wait 超时 → waiting_file_release 并释放 claim，不伪造失败或打扰 PM', async () => {
    const { client, calls } = mockClient([{ occupied: true, action: 'wait' }]);
    expect(await resolveOwnershipConflict(client, 'src/a.ts', task, 'w1', 10, 50)).toBe(false);
    expect(calls.block).toEqual([['t-conflict-1', 'tok_test', 'waiting_file_release']]);
    expect(calls.report).toHaveLength(0);
  });
});
