import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, deriveWorkerApiToken } from '../src/server/http.js';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { setSqliteStore } from '../src/server/service.js';
import { createLanMcpRuntime } from '../src/mcp/runtime.js';
import { handleMcpMessage } from '../src/mcp/session.js';

const REDIS_URL = process.env.MCP_AGENT_OPS_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/12';
const OWNER_TOKEN = 'mcp-agent-ops-owner-token-secret';

let redis: Redis;
let rootDir: string;
let baseUrl: string;
let server: Awaited<ReturnType<typeof createHttpServer>>;
let store: SqliteStore;
let previousWorkspaceRoots: string | undefined;

async function toolPayload(
  runtime: ReturnType<typeof createLanMcpRuntime>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: `${name}-${Math.random()}`,
    method: 'tools/call',
    params: { name, arguments: args },
  }, runtime);
  const result = response?.result as { content?: Array<{ type: string; text: string }> } | undefined;
  return {
    ok: true,
    payload: JSON.parse(result?.content?.[0]?.text ?? 'null') as {
      ok: boolean;
      data: any;
      error?: { code: string; message: string };
    },
    serialized: JSON.stringify(response),
  };
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'biao-mcp-agent-ops-'));
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

describe('Agent 一等操作面（纯 MCP 全流程）', () => {
  it('plan_create(skeleton=false) + task_upsert 结构化建任务', async () => {
    const pm = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });
    const created = await toolPayload(pm, 'plan_create', {
      plan_id: 'agent-ops-plan',
      project_path: rootDir,
      title: 'Agent ops plan',
      skeleton: false,
    });
    expect(created.payload).toMatchObject({ ok: true, data: { plan_id: 'agent-ops-plan', task_count: 0 } });

    const impl = await toolPayload(pm, 'task_upsert', {
      plan_id: 'agent-ops-plan',
      task_id: 'ops-impl-1',
      title: '实现任务',
      type: 'code',
      goal_md: '# 目标\n\n交付 result.md 与 result.json。',
      verify: [{ cmd: `test -f work/ops-impl-1/result.md`, expect_exit: 0 }],
    });
    expect(impl.payload).toMatchObject({ ok: true, data: { plan_id: 'agent-ops-plan', task_id: 'ops-impl-1', created: 1 } });

    const acc = await toolPayload(pm, 'task_upsert', {
      plan_id: 'agent-ops-plan',
      task_id: 'ops-acc-1',
      title: '独立验收',
      type: 'acceptance',
      depends_on: ['ops-impl-1'],
      acceptance_for: ['ops-impl-1'],
      goal_md: '# 验收\n\n复核实现产物。',
      verify: [{ cmd: `test -f work/ops-acc-1/result.md`, expect_exit: 0 }],
    });
    expect(acc.payload).toMatchObject({ ok: true, data: { task_id: 'ops-acc-1', created: 1 } });

    const list = await toolPayload(pm, 'task_list', { plan_id: 'agent-ops-plan', status: 'pending' });
    expect(list.payload.data.total).toBe(2);

    const upsertAgain = await toolPayload(pm, 'task_upsert', {
      plan_id: 'agent-ops-plan',
      task_id: 'ops-impl-1',
      title: '实现任务',
      type: 'code',
      goal_md: '# 目标（更新）\n\n交付 result.md 与 result.json。',
      verify: [{ cmd: `test -f work/ops-impl-1/result.md`, expect_exit: 0 }],
    });
    // planSubmit 是整目录幂等重提交：本次目标任务 created=0，两个 pending 任务都计为 updated。
    expect(upsertAgain.payload).toMatchObject({ ok: true, data: { task_id: 'ops-impl-1', created: 0, updated: 2 } });
  });

  it('claim 返回 goal 正文；后续调用可省略 agent_id', async () => {
    // 用独立探针计划，避免占用主流程任务的 lease。
    const pm = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });
    await toolPayload(pm, 'plan_create', {
      plan_id: 'agent-ops-probe',
      project_path: rootDir,
      title: 'probe',
      skeleton: false,
    });
    await toolPayload(pm, 'task_upsert', {
      plan_id: 'agent-ops-probe',
      task_id: 'probe-task',
      title: '探针任务',
      type: 'code',
      goal_md: '# 探针目标',
    });

    const worker = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });
    const claim = await toolPayload(worker, 'task_claim', {
      agent_id: 'ops-worker-1',
      agent_type: 'zcode',
      capabilities: ['code'],
      preferred_plan_ids: ['agent-ops-probe'],
      preferred_types: ['code'],
    });
    expect(claim.payload.data).toMatchObject({ task_id: 'probe-task', goal_available: true });
    expect(claim.payload.data.goal_md).toContain('# 探针目标');
    expect(claim.payload.data).not.toHaveProperty('verify');
    expect(claim.payload.data).not.toHaveProperty('claim_token');

    const got = await toolPayload(worker, 'task_get', { task_id: 'probe-task' });
    expect(got.payload.data.goal_md).toContain('# 探针目标');

    // 身份记忆：heartbeat 不带 agent_id 也指向同一注册。
    const heartbeat = await toolPayload(worker, 'task_heartbeat', { current_task: 'probe-task' });
    expect(heartbeat.payload).toMatchObject({ ok: true });
  });

  it('Question 往返 + 内联产物 + 中央代执行 verify + PM 决策全链路', async () => {
    const worker = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });
    const pm = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });

    const claim = await toolPayload(worker, 'task_claim', {
      agent_id: 'ops-worker-2',
      agent_type: 'zcode',
      capabilities: ['code'],
      preferred_plan_ids: ['agent-ops-plan'],
      preferred_types: ['code'],
    });
    expect(claim.payload.data.task_id).toBe('ops-impl-1');

    const asked = await toolPayload(worker, 'question_ask', {
      task_id: 'ops-impl-1',
      body: 'result.md 用中文还是英文？',
      checkpoint: '已领取，尚未写产物',
    });
    expect(asked.payload).toMatchObject({ ok: true, data: { status: 'open' } });
    const questionId = asked.payload.data.question_id;

    const next = await toolPayload(pm, 'pm_next', {});
    expect(next.payload).toMatchObject({ ok: true });

    const listed = await toolPayload(pm, 'question_list', { plan_id: 'agent-ops-plan' });
    expect(listed.payload.data.some((q: { question_id: string }) => q.question_id === questionId)).toBe(true);

    const read = await toolPayload(pm, 'question_get', { question_id: questionId });
    expect(read.payload.data).toMatchObject({ task_id: 'ops-impl-1', status: 'open' });

    const answered = await toolPayload(pm, 'question_answer', {
      question_id: questionId,
      answer: '用中文撰写摘要。',
    });
    expect(answered.payload).toMatchObject({ ok: true, data: { status: 'answered', acked: true } });

    const reclaimed = await toolPayload(worker, 'task_claim', {
      agent_id: 'ops-worker-2',
      preferred_plan_ids: ['agent-ops-plan'],
    });
    expect(reclaimed.payload.data).toMatchObject({ task_id: 'ops-impl-1', question_answer: '用中文撰写摘要。' });

    // 内联产物 + execute_verify：远程 Worker 全程无服务器文件系统访问。
    const reported = await toolPayload(worker, 'task_report', {
      task_id: 'ops-impl-1',
      status: 'done',
      result_md: '# 实现结果\n\n按 PM 答复以中文撰写。',
      result_json: '{"ok":true,"summary":"中文摘要"}',
      execute_verify: true,
    });
    expect(reported.payload).toMatchObject({ ok: true, data: { task_id: 'ops-impl-1', status: 'done' } });
    expect(reported.serialized).not.toContain(OWNER_TOKEN);

    const reviewRead = await toolPayload(pm, 'pm_review_read', { task_id: 'ops-impl-1' });
    expect(reviewRead.payload.data).toMatchObject({ status: 'done', awaiting_independent_review: true });
    // execute_verify 的中央执行结果必须持久化为 PM 可见的 verify 证据。
    expect(reviewRead.payload.data.verify_summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    // 证据卡片：verify 输出 / 回放命令 / 运行元数据 / 完整度。
    const card = reviewRead.payload.data.evidence_card;
    expect(card).toBeDefined();
    expect(card.verify).toHaveLength(1);
    expect(card.verify[0]).toMatchObject({ cmd: 'test -f work/ops-impl-1/result.md', exit_code: 0, passed: true });
    expect(card.replay).toEqual([{ cmd: 'test -f work/ops-impl-1/result.md', expect_exit: 0 }]);
    expect(card.run).toBeDefined();
    expect(card.completeness).toMatchObject({ result_md: true, result_json: true, verify_declared: 1, verify_reported: 1 });

    const decided = await toolPayload(pm, 'pm_review_decide', {
      task_id: 'ops-impl-1',
      verdict: 'accept',
      comment: '全流程 E2E 通过',
      reviewed_by: 'agent-ops-pm',
    });
    expect(decided.payload).toMatchObject({ ok: true, data: { task_id: 'ops-impl-1', review_status: 'accepted' } });
  });

  it('独立验收 Worker 内联交付并被接受；agent_offline 收口', async () => {
    const acceptor = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });
    const pm = createLanMcpRuntime({ BIAO_URL: baseUrl, BIAO_API_TOKEN: OWNER_TOKEN });

    const claim = await toolPayload(acceptor, 'task_claim', {
      agent_id: 'ops-acceptor-1',
      agent_type: 'zcode',
      capabilities: ['acceptance'],
      preferred_plan_ids: ['agent-ops-plan'],
      preferred_types: ['acceptance'],
    });
    expect(claim.payload.data).toMatchObject({ task_id: 'ops-acc-1' });

    const reported = await toolPayload(acceptor, 'task_report', {
      task_id: 'ops-acc-1',
      status: 'done',
      result_md: '# 验收结论\n\n复核通过。',
      result_json: '{"ok":true,"verdict":"pass","backend":"zcode","model":"glm","returncode":0,"duration_seconds":12.5,"changed_files":["src/a.ts","src/b.ts"],"diff_stats":{"files":2,"insertions":30,"deletions":4}}',
      execute_verify: true,
    });
    expect(reported.payload).toMatchObject({ ok: true });

    const accReviewRead = await toolPayload(pm, 'pm_review_read', { task_id: 'ops-acc-1' });
    expect(accReviewRead.payload.data.verify_summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    // worker 自报的 run 元数据与 diff 统计经 evidence 卡片原样透传给 PM。
    expect(accReviewRead.payload.data.evidence_card.run).toMatchObject({ backend: 'zcode', model: 'glm', returncode: 0 });
    expect(accReviewRead.payload.data.evidence_card.diff_stats).toMatchObject({ files: 2, insertions: 30, deletions: 4 });

    const decided = await toolPayload(pm, 'pm_review_decide', {
      task_id: 'ops-acc-1',
      verdict: 'accept',
      comment: '独立验收通过',
      reviewed_by: 'agent-ops-pm',
    });
    expect(decided.payload).toMatchObject({ ok: true, data: { review_status: 'accepted' } });

    const offline = await toolPayload(acceptor, 'agent_offline', { reason: 'worker_exit' });
    expect(offline.payload).toMatchObject({ ok: true });

    const plan = await toolPayload(pm, 'plan_status', { plan_id: 'agent-ops-plan' });
    expect(plan.payload.data.reviews).toMatchObject({ pending: 0, accepted: 2 });
  });

  it('PM 决策工具拒绝 Worker 作用域 token', async () => {
    const workerScoped = createLanMcpRuntime({
      BIAO_URL: baseUrl,
      BIAO_API_TOKEN: deriveWorkerApiToken(OWNER_TOKEN),
    });
    const rejected = await toolPayload(workerScoped, 'pm_review_decide', {
      task_id: 'ops-impl-1',
      verdict: 'accept',
      reviewed_by: 'should-fail',
    });
    expect(rejected.payload).toMatchObject({ ok: false, error: { code: 'REMOTE_FORBIDDEN' } });
  });
});
