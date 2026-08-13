/**
 * Worker → PM 通讯的真实 HTTP 验收。
 *
 * 这个文件刻意不用 service 层直调：起临时 Biao 服务、临时 SQLite 和 Redis DB 14，
 * 从 API 边界验证 Worker 提问、PM 最小门铃、授权答复、fresh claim 和显式 ack。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/server/main.js';
import { setSqliteStore } from '../src/server/service.js';

const execFileAsync = promisify(execFile);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/14';

type Envelope<T = unknown> = {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string };
};

let redis: Redis;
let server: Awaited<ReturnType<typeof startServer>>;
let rootDir: string;
let projectDir: string;
let baseUrl: string;

async function http<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: (await response.json()) as Envelope<T> };
}

function post<T = unknown>(path: string, payload: unknown) {
  return http<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

function writeAutoResumePlan(planId: string) {
  const planDir = join(rootDir, `${planId}-definition`);
  const autoProjectDir = join(rootDir, `${planId}-project`);
  const tasksDir = join(planDir, 'tasks');
  mkdirSync(autoProjectDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(planDir, 'index.md'), `---
plan_id: ${planId}
title: Auto resume E2E
status: draft
project_path: ${autoProjectDir}
pm_consumer: pm-auto-resume
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
---

# Auto resume E2E
`);

  const ids = {
    reportOwner: `${planId}-owner-report`,
    reportWaiter: `${planId}-wait-report`,
    releaseOwner: `${planId}-owner-release`,
    releaseWaiter: `${planId}-wait-release`,
    dependencyOwner: `${planId}-dependency-owner`,
    dependencyWaiter: `${planId}-dependency-waiter`,
    questionWaiter: `${planId}-question-waiter`,
    scopeDependencyOwner: `${planId}-scope-dependency-owner`,
    scopeDependencyWaiter: `${planId}-scope-dependency-waiter`,
  };
  const agents = {
    reportOwner: `${planId}-agent-owner-report`,
    reportWaiter: `${planId}-agent-wait-report`,
    releaseOwner: `${planId}-agent-owner-release`,
    releaseWaiter: `${planId}-agent-wait-release`,
    dependencyOwner: `${planId}-agent-dependency-owner`,
    dependencyWaiter: `${planId}-agent-dependency-waiter`,
    questionWaiter: `${planId}-agent-question-waiter`,
    scopeDependencyOwner: `${planId}-agent-scope-dependency-owner`,
    scopeDependencyWaiter: `${planId}-agent-scope-dependency-waiter`,
  };

  const writeTask = (
    fileName: string,
    taskId: string,
    assignee: string,
    opts: { ownership?: string; dependsOn?: string; priority?: number } = {},
  ) => {
    writeFileSync(join(tasksDir, fileName), `---
task_id: ${taskId}
title: ${taskId}
type: code
phase: impl
${opts.dependsOn ? `depends_on:\n  - ${opts.dependsOn}\n` : ''}assignee: ${assignee}
${opts.ownership ? `ownership:\n  files:\n    - ${opts.ownership}\n` : ''}priority: ${opts.priority ?? 5}
verify: []
---

# ${taskId}
`);
  };

  // Owner tasks intentionally have no initial ownership. The test claims the waiting task
  // first, then uses the real explicit ownership API to model a competing writer preempting it.
  writeTask('01-owner-report.md', ids.reportOwner, agents.reportOwner, { priority: 9 });
  writeTask('02-wait-report.md', ids.reportWaiter, agents.reportWaiter, { ownership: 'src/auto-resume/report/**' });
  writeTask('03-owner-release.md', ids.releaseOwner, agents.releaseOwner, { priority: 9 });
  writeTask('04-wait-release.md', ids.releaseWaiter, agents.releaseWaiter, { ownership: 'src/auto-resume/release/**' });
  writeTask('05-dependency-owner.md', ids.dependencyOwner, agents.dependencyOwner);
  writeTask('06-dependency-waiter.md', ids.dependencyWaiter, agents.dependencyWaiter, { dependsOn: ids.dependencyOwner });
  writeTask('07-question-waiter.md', ids.questionWaiter, agents.questionWaiter);
  writeTask('08-scope-dependency-owner.md', ids.scopeDependencyOwner, agents.scopeDependencyOwner);
  writeTask('09-scope-dependency-waiter.md', ids.scopeDependencyWaiter, agents.scopeDependencyWaiter, { dependsOn: ids.scopeDependencyOwner });
  return { planDir, projectDir: autoProjectDir, ids, agents };
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'biao-communication-e2e-'));
  projectDir = join(rootDir, 'project');
  mkdirSync(projectDir, { recursive: true });

  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  server = await startServer({
    port: 0,
    redisUrl: REDIS_URL,
    sqlitePath: join(rootDir, 'biao.sqlite'),
    workspaceRoots: [rootDir],
  });
  const address = server.app.server.address() as AddressInfo | null;
  if (!address) throw new Error('临时 Biao 服务未拿到监听地址');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 20_000);

afterAll(async () => {
  await server?.close();
  await redis?.flushdb();
  redis?.disconnect();
  setSqliteStore(null);
  rmSync(rootDir, { recursive: true, force: true });
});

describe('Worker → PM Question + 被动门铃闭环', () => {
  it('只由持有 lease 的 Worker 提问；PM 收最小门铃后授权答复，任务以新 token 重领', async () => {
    const planId = `question-e2e-${Date.now()}`;
    const pmConsumer = 'pm-alpha';

    const created = await post<{ plan_id: string; task_count: number }>('/plan/create', {
      plan_id: planId,
      title: 'Question E2E',
      project_path: projectDir,
      pm_consumer: pmConsumer,
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, data: { plan_id: planId, task_count: 2 } });

    const registrationA = await post<{ registration_id: string }>('/register', {
      agent_id: 'question-worker-a', agent_type: 'cli', capabilities: ['code'], projects: [projectDir],
    });
    expect(registrationA.body.ok).toBe(true);

    const claimed = await post<Record<string, unknown>>('/claim', {
      agent_id: 'question-worker-a', registration_id: registrationA.body.data!.registration_id,
      claim_request_id: 'claim_question_worker_a_001',
      blocking: false, preferred_project: projectDir,
    });
    expect(claimed.body.ok).toBe(true);
    const task = claimed.body.data! as {
      task_id: string;
      claim_token: string;
      plan_id: string;
    };
    expect(task.plan_id).toBe(planId);

    // `/task/:id/block` 也属于会释放 lease/ownership 的破坏性状态转换：不能仅凭
    // 可猜的 agent_id 操作。伪造身份或 token 必须在原子校验边界被拒绝，且不改变
    // running task / ownership。
    const forgedAgentBlock = await post(`/task/${task.task_id}/block`, {
      agent_id: 'question-worker-forged',
      claim_token: task.claim_token,
      reason: 'waiting_file_release',
    });
    expect(forgedAgentBlock.body).toMatchObject({ ok: false, error: { code: 'CLAIM_OWNER_MISMATCH' } });
    expect((await http<{ status: string }>(`/task/${task.task_id}`)).body.data).toMatchObject({ status: 'running' });
    expect((await http<{ total: number }>('/ownership/active')).body.data).toMatchObject({ total: 1 });

    const forgedTokenBlock = await post(`/task/${task.task_id}/block`, {
      agent_id: 'question-worker-a',
      claim_token: 'forged-block-token',
      reason: 'waiting_file_release',
    });
    expect(forgedTokenBlock.body).toMatchObject({ ok: false, error: { code: 'CLAIM_TOKEN_INVALID' } });
    expect((await http<{ status: string }>(`/task/${task.task_id}`)).body.data).toMatchObject({ status: 'running' });
    expect((await http<{ total: number }>('/ownership/active')).body.data).toMatchObject({ total: 1 });

    // 伪造 token 不能把别人的 running task 变成 blocked，也不能释放 ownership。
    const forged = await post('/question', {
      task_id: task.task_id,
      agent_id: 'question-worker-a',
      claim_token: 'forged-token',
      body: '不应被接受',
    });
    expect(forged.body).toMatchObject({ ok: false, error: { code: 'CLAIM_TOKEN_INVALID' } });
    expect((await http<{ status: string }>(`/task/${task.task_id}`)).body.data).toMatchObject({ status: 'running' });
    expect((await http<{ total: number }>('/ownership/active')).body.data).toMatchObject({ total: 1 });

    const questionBody = '请确认验收边界；不要把这段正文放进门铃。';
    const checkpoint = '已完成第一步，等待 PM 决策。';
    const askPayload = {
      task_id: task.task_id,
      agent_id: 'question-worker-a',
      claim_token: task.claim_token,
      body: questionBody,
      checkpoint,
    };
    // 同一 Worker 在网络超时后并行重试，也只能生成一个 Question 和一条门铃。
    const [asked, concurrentReplay] = await Promise.all([
      post<{ question_id: string; task_id: string; status: string }>('/question', askPayload),
      post<{ question_id: string; task_id: string; status: string }>('/question', askPayload),
    ]);
    expect(asked.body).toMatchObject({ ok: true, data: { task_id: task.task_id, status: 'open' } });
    const questionId = asked.body.data!.question_id;
    expect(concurrentReplay.body).toMatchObject({ ok: true, data: { question_id: questionId } });

    // 网络重试同一问句必须幂等，不能因已转 blocked 就报 TASK_NOT_RUNNING。
    const replay = await post<{ question_id: string }>('/question', {
      task_id: task.task_id,
      agent_id: 'question-worker-a',
      claim_token: task.claim_token,
      body: questionBody,
      checkpoint,
    });
    expect(replay.body).toMatchObject({ ok: true, data: { question_id: questionId } });

    const blocked = await http<{ status: string }>(`/task/${task.task_id}`);
    expect(blocked.body.data).toMatchObject({ status: 'blocked' });
    // Question 必须释放旧 lease 对应的 ownership，Worker 才能转去找下一项。
    expect((await http<{ total: number }>('/ownership/active')).body.data).toMatchObject({ total: 0 });

    // Question 形成的 waiting_pm_reply 只能由 PM answer 解锁；任意人调用通用 resume
    // 都不得绕过回复、把任务提前回到 pending。
    const bypassResume = await post(`/task/${task.task_id}/resume`, { agent_id: 'question-worker-a' });
    expect(bypassResume.body).toMatchObject({ ok: false, error: { code: 'QUESTION_ANSWER_REQUIRED' } });
    expect((await http<{ status: string }>(`/task/${task.task_id}`)).body.data).toMatchObject({ status: 'blocked' });

    const intake = await http<{
      items: Array<Record<string, unknown>>;
      counts: Record<string, number>;
    }>(`/intake?consumer=${pmConsumer}&plan_id=${planId}`);
    const bell = intake.body.data!.items.find((item) => item.kind === 'question_asked');
    expect(bell).toMatchObject({ kind: 'question_asked', plan_id: planId, task_id: task.task_id, question_id: questionId });
    // 门铃只带定位字段；正文与 checkpoint 必须让 PM 二次读取。
    expect(bell).not.toHaveProperty('body');
    expect(bell).not.toHaveProperty('checkpoint');
    expect(JSON.stringify(bell)).not.toContain(questionBody);

    const foreignIntake = await http<{ items: Array<Record<string, unknown>> }>(`/intake?consumer=pm-beta&plan_id=${planId}`);
    expect(foreignIntake.body.data!.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: task.task_id }),
    ]));

    // 只有路由给本 plan 的 PM 才能看到详情、ack 或答复。未完成答复前只验证
    // foreign ack 被拒；归属 PM 必须在 answer 实际完成后才 ack。
    const foreignRead = await http(`/question/${questionId}?consumer=pm-beta`);
    expect(foreignRead.body).toMatchObject({ ok: false, error: { code: 'CONSUMER_NOT_AUTHORIZED' } });
    const detail = await http<{ body: string; checkpoint: string; pm_consumer: string }>(`/question/${questionId}?consumer=${pmConsumer}`);
    expect(detail.body).toMatchObject({ ok: true, data: { body: questionBody, checkpoint, pm_consumer: pmConsumer } });

    const foreignAck = await post('/intake/ack', { consumer: 'pm-beta', event_id: bell!.event_id });
    expect(foreignAck.body).toMatchObject({ ok: false, error: { code: 'CONSUMER_NOT_AUTHORIZED' } });

    const unauthorizedAnswer = await post(`/question/${questionId}/answer`, { consumer: 'pm-beta', answer: '无权回答' });
    expect(unauthorizedAnswer.body).toMatchObject({ ok: false, error: { code: 'CONSUMER_NOT_AUTHORIZED' } });
    expect((await http<{ status: string }>(`/task/${task.task_id}`)).body.data).toMatchObject({ status: 'blocked' });

    // 两个并发 PM 回复不能都覆盖状态；一个成功，一个得到冲突。
    const answerA = '按方案 A 继续。';
    const answerB = '按方案 B 停止。';
    const answers = await Promise.all([
      post<{ status: string }>(`/question/${questionId}/answer`, { consumer: pmConsumer, answer: answerA }),
      post<{ status: string }>(`/question/${questionId}/answer`, { consumer: pmConsumer, answer: answerB }),
    ]);
    const successful = answers.filter((answer) => answer.body.ok);
    const rejected = answers.filter((answer) => !answer.body.ok);
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].body.error?.code).toBe('ANSWER_CONFLICT');
    const winningAnswer = successful[0] === answers[0] ? answerA : answerB;
    expect(successful[0].body.data).toMatchObject({ status: 'answered', new_claim_token: '' });

    // 相同请求重放是幂等；不同答案已经在并发分支中被拒。
    const idempotentAnswer = await post(`/question/${questionId}/answer`, { consumer: pmConsumer, answer: winningAnswer });
    expect(idempotentAnswer.body.ok).toBe(true);

    // answer 已持久化、任务已重新入队后才 ack 门铃；提醒确认不能早于业务处置。
    const ack = await post('/intake/ack', { consumer: pmConsumer, event_id: bell!.event_id });
    expect(ack.body.ok).toBe(true);
    const unackedAfterAck = await http<Array<{ event_id: string }>>(`/intake/unacked?consumer=${pmConsumer}&type=question_asked`);
    expect(unackedAfterAck.body.data).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: bell!.event_id }),
    ]));

    const registrationB = await post<{ registration_id: string }>('/register', {
      agent_id: 'question-worker-b', agent_type: 'cli', capabilities: ['code'], projects: [projectDir],
    });
    expect(registrationB.body.ok).toBe(true);
    const reclaimed = await post<Record<string, unknown>>('/claim', {
      agent_id: 'question-worker-b', registration_id: registrationB.body.data!.registration_id,
      claim_request_id: 'claim_question_worker_b_001',
      blocking: false, preferred_project: projectDir,
    });
    expect(reclaimed.body.ok).toBe(true);
    const freshTask = reclaimed.body.data! as {
      task_id: string;
      claim_token: string;
      question_id?: string;
      question_answer?: string;
    };
    expect(freshTask).toMatchObject({ task_id: task.task_id, question_id: questionId, question_answer: winningAnswer });
    expect(freshTask.claim_token).not.toBe(task.claim_token);

    const staleReport = await post('/report', {
      task_id: task.task_id,
      agent_id: 'question-worker-a',
      claim_token: task.claim_token,
      status: 'done',
    });
    expect(staleReport.body).toMatchObject({ ok: false, error: { code: 'CLAIM_TOKEN_INVALID' } });

    // 产出一个 review_requested，验证监视脚本只是门铃，绝不会在打印后自行 ack。
    const completed = await post('/report', {
      task_id: freshTask.task_id,
      agent_id: 'question-worker-b',
      claim_token: freshTask.claim_token,
      status: 'done',
    });
    expect(completed.body.ok).toBe(true);
    const beforeWatch = await http<Array<{ event_id: string; type: string }>>(`/intake/unacked?consumer=${pmConsumer}&type=review_requested`);
    expect(beforeWatch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'review_requested' }),
    ]));

    const supervisor = await execFileAsync(process.execPath, [
      'scripts/supervisor.mjs', '--biao-url', baseUrl, '--consumer', pmConsumer, '--once',
    ], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, BIAO_LOCK_DIR: join(rootDir, 'locks') },
      encoding: 'utf8',
    });
    expect(supervisor.stdout).toContain('PM 门铃');
    expect(supervisor.stdout).toMatch(/count=\d+/);
    // Supervisor 是低噪声门铃：任务详情由 PM 回平台读取，不能把批量 task ID 刷到终端。
    expect(supervisor.stdout).not.toContain(freshTask.task_id);
    const afterWatch = await http<Array<{ event_id: string; type: string }>>(`/intake/unacked?consumer=${pmConsumer}&type=review_requested`);
    expect(afterWatch.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'review_requested' }),
    ]));
  }, 30_000);
});

describe('文件/依赖等待的事件驱动恢复', () => {
  it('释放或依赖完成后只恢复对应 blocked task；Question 不会被误恢复，并发释放只写一条门铃', async () => {
    const planId = `auto-resume-e2e-${Date.now()}`;
    const { planDir, projectDir: autoProjectDir, ids, agents } = writeAutoResumePlan(planId);
    const submitted = await post<{ plan_id: string; task_count: number }>('/plan/submit', { plan_dir: planDir });
    expect(submitted.body).toMatchObject({ ok: true, data: { plan_id: planId, task_count: 9 } });

    type Claimed = { task_id: string; claim_token: string };
    const registrationIds = new Map<string, string>();
    const registerAndClaim = async (agentId: string, expectedTaskId: string): Promise<Claimed> => {
      const registered = await post<{ registration_id: string }>('/register', {
        agent_id: agentId,
        agent_type: 'cli',
        capabilities: ['code'],
        projects: [autoProjectDir],
      });
      expect(registered.body.ok).toBe(true);
      registrationIds.set(agentId, registered.body.data!.registration_id);
      const claimed = await post<Claimed>('/claim', {
        agent_id: agentId,
        registration_id: registered.body.data!.registration_id,
        claim_request_id: `claim_${agentId}_initial_001`,
        blocking: false,
        preferred_project: autoProjectDir,
      });
      expect(claimed.body).toMatchObject({ ok: true, data: { task_id: expectedTaskId } });
      return claimed.body.data!;
    };
    const taskStatus = async (taskId: string) => {
      const task = await http<{ status: string }>(`/task/${taskId}`);
      expect(task.body.ok).toBe(true);
      return task.body.data!.status;
    };
    const eventsFor = async (taskId: string, type: string) => {
      const page = await http<{ events: Array<{ task_id: string; type: string }> }>('/events?after=0-0&limit=500');
      expect(page.body.ok).toBe(true);
      return page.body.data!.events.filter((event) => event.task_id === taskId && event.type === type);
    };

    // 留下一条真实 PM Question；下面发生的 file/dependency 释放绝不能把它恢复为 pending。
    const questionClaim = await registerAndClaim(agents.questionWaiter, ids.questionWaiter);
    const question = await post<{ question_id: string }>('/question', {
      task_id: ids.questionWaiter,
      agent_id: agents.questionWaiter,
      claim_token: questionClaim.claim_token,
      body: '必须等待 PM 回答，不能随文件或依赖门铃恢复。',
      checkpoint: 'auto-resume-guard',
    });
    expect(question.body.ok).toBe(true);
    expect(await taskStatus(ids.questionWaiter)).toBe('blocked');

    // 这条 dependency 已经满足。block 写入前必须原子重验并直接回 pending；不能留下
    // 一个再也等不到未来 dependency 事件的永久 waiting_dependency。
    const scopeDependencyOwner = await registerAndClaim(agents.scopeDependencyOwner, ids.scopeDependencyOwner);
    expect((await post('/report', {
      task_id: ids.scopeDependencyOwner,
      agent_id: agents.scopeDependencyOwner,
      claim_token: scopeDependencyOwner.claim_token,
      status: 'done',
    })).body.ok).toBe(true);
    // 普通代码依赖必须通过 PM 验收；这里只验收 scope owner，确保接下来的
    // waiting_dependency 断言覆盖的是“状态改变”而不是旧版 done 即放行的行为。
    expect((await post(`/task/${ids.scopeDependencyOwner}/review`, {
      verdict: 'accept', reviewed_by: 'pm-auto-resume',
    })).body.ok).toBe(true);
    const scopeDependencyWaiter = await registerAndClaim(agents.scopeDependencyWaiter, ids.scopeDependencyWaiter);
    expect((await post(`/task/${ids.scopeDependencyWaiter}/block`, {
      agent_id: agents.scopeDependencyWaiter,
      claim_token: scopeDependencyWaiter.claim_token,
      reason: 'waiting_dependency',
    })).body).toMatchObject({ ok: true, data: { blocked: false } });
    expect(await taskStatus(ids.scopeDependencyWaiter)).toBe('pending');
    expect(await eventsFor(ids.scopeDependencyWaiter, 'dependency_ready')).toHaveLength(1);

    // 1) owner report 完成会释放文件占用，waiting_file_release 回 pending，并写 task_ready。
    const reportWaiter = await registerAndClaim(agents.reportWaiter, ids.reportWaiter);
    const reportOwner = await registerAndClaim(agents.reportOwner, ids.reportOwner);
    const reportGlob = 'src/auto-resume/report/**';
    expect((await post('/ownership/declare', {
      agent_id: agents.reportOwner,
      task_id: ids.reportOwner,
      claim_token: reportOwner.claim_token,
      files: [reportGlob],
      force: true,
    })).body.ok).toBe(true);
    expect((await post(`/task/${ids.reportWaiter}/block`, {
      agent_id: agents.reportWaiter,
      claim_token: reportWaiter.claim_token,
      reason: 'waiting_file_release',
    })).body.ok).toBe(true);
    expect(await taskStatus(ids.reportWaiter)).toBe('blocked');
    expect((await post('/report', {
      task_id: ids.reportOwner,
      agent_id: agents.reportOwner,
      claim_token: reportOwner.claim_token,
      status: 'done',
    })).body.ok).toBe(true);
    expect(await taskStatus(ids.reportWaiter)).toBe('pending');
    expect(await eventsFor(ids.reportWaiter, 'task_ready')).toHaveLength(1);

    // 2) 显式 ownership/release 也会唤醒；相同 release 并发抵达时仍只能有一个 task_ready。
    const releaseWaiter = await registerAndClaim(agents.releaseWaiter, ids.releaseWaiter);
    const releaseOwner = await registerAndClaim(agents.releaseOwner, ids.releaseOwner);
    const releaseGlob = 'src/auto-resume/release/**';
    expect((await post('/ownership/declare', {
      agent_id: agents.releaseOwner,
      task_id: ids.releaseOwner,
      claim_token: releaseOwner.claim_token,
      files: [releaseGlob],
      force: true,
    })).body.ok).toBe(true);
    expect((await post(`/task/${ids.releaseWaiter}/block`, {
      agent_id: agents.releaseWaiter,
      claim_token: releaseWaiter.claim_token,
      reason: 'waiting_file_release',
    })).body.ok).toBe(true);
    const explicitRelease = {
      agent_id: agents.releaseOwner,
      task_id: ids.releaseOwner,
      claim_token: releaseOwner.claim_token,
      files: [releaseGlob],
    };

    // ownership 的破坏性释放必须同时校验 running holder + claim_token。伪造 agent
    // 或 token 不能删锁、更不能唤醒仍在等待文件的 task。
    const forgedReleaseAgent = await post('/ownership/release', {
      ...explicitRelease,
      agent_id: `${planId}-attacker`,
    });
    expect(forgedReleaseAgent.body).toMatchObject({ ok: false, error: { code: 'CLAIM_OWNER_MISMATCH' } });
    const forgedReleaseToken = await post('/ownership/release', {
      ...explicitRelease,
      claim_token: 'forged-ownership-release-token',
    });
    expect(forgedReleaseToken.body).toMatchObject({ ok: false, error: { code: 'CLAIM_TOKEN_INVALID' } });
    expect(await taskStatus(ids.releaseWaiter)).toBe('blocked');
    expect(await eventsFor(ids.releaseWaiter, 'task_ready')).toHaveLength(0);
    const stillOwned = await http<{ occupied: boolean; owner?: { agent_id: string; task_id: string } }>(
      `/ownership?path=${encodeURIComponent(releaseGlob)}&agent_id=${encodeURIComponent(`${planId}-attacker`)}`,
    );
    expect(stillOwned.body).toMatchObject({
      ok: true,
      data: { occupied: true, owner: { agent_id: agents.releaseOwner, task_id: ids.releaseOwner } },
    });
    const releases = await Promise.all([
      post('/ownership/release', explicitRelease),
      post('/ownership/release', explicitRelease),
    ]);
    expect(releases.every((release) => release.body.ok)).toBe(true);
    expect(await taskStatus(ids.releaseWaiter)).toBe('pending');
    expect(await eventsFor(ids.releaseWaiter, 'task_ready')).toHaveLength(1);
    expect(await taskStatus(ids.scopeDependencyWaiter)).toBe('pending');
    expect(await eventsFor(ids.scopeDependencyWaiter, 'task_ready')).toHaveLength(0);
    expect(await eventsFor(ids.scopeDependencyWaiter, 'dependency_ready')).toHaveLength(1);

    // 3) 先让带依赖的 task 合法领取一次；把依赖 reset 回 pending 后搁置，再由真实 done
    // 事件恢复。这样整个状态转换都走 HTTP，不靠直接篡改 Redis。
    const dependencyOwnerFirst = await registerAndClaim(agents.dependencyOwner, ids.dependencyOwner);
    expect((await post('/report', {
      task_id: ids.dependencyOwner,
      agent_id: agents.dependencyOwner,
      claim_token: dependencyOwnerFirst.claim_token,
      status: 'done',
    })).body.ok).toBe(true);
    expect((await post(`/task/${ids.dependencyOwner}/review`, {
      verdict: 'accept', reviewed_by: 'pm-auto-resume',
    })).body.ok).toBe(true);
    const dependencyWaiter = await registerAndClaim(agents.dependencyWaiter, ids.dependencyWaiter);
    expect((await post(`/task/${ids.dependencyOwner}/reset`, {
      force: true,
      reset_by: 'auto-resume-e2e',
    })).body.ok).toBe(true);
    expect((await post(`/task/${ids.dependencyWaiter}/block`, {
      agent_id: agents.dependencyWaiter,
      claim_token: dependencyWaiter.claim_token,
      reason: 'waiting_dependency',
    })).body.ok).toBe(true);
    expect(await taskStatus(ids.dependencyWaiter)).toBe('blocked');
    const dependencyOwnerSecond = await post<Claimed>('/claim', {
      agent_id: agents.dependencyOwner,
      registration_id: registrationIds.get(agents.dependencyOwner),
      claim_request_id: 'claim_dependency_owner_second_001',
      blocking: false,
      preferred_project: autoProjectDir,
    });
    expect(dependencyOwnerSecond.body).toMatchObject({ ok: true, data: { task_id: ids.dependencyOwner } });
    expect((await post('/report', {
      task_id: ids.dependencyOwner,
      agent_id: agents.dependencyOwner,
      claim_token: dependencyOwnerSecond.body.data!.claim_token,
      status: 'done',
    })).body.ok).toBe(true);
    expect((await post(`/task/${ids.dependencyOwner}/review`, {
      verdict: 'accept', reviewed_by: 'pm-auto-resume',
    })).body.ok).toBe(true);
    expect(await taskStatus(ids.dependencyWaiter)).toBe('pending');
    expect(await eventsFor(ids.dependencyWaiter, 'dependency_ready')).toHaveLength(1);

    // Question 必须只由其 PM answer 解锁，不能被所有这些通用恢复器误唤醒。
    expect(await taskStatus(ids.questionWaiter)).toBe('blocked');
    expect(await eventsFor(ids.questionWaiter, 'task_ready')).toHaveLength(0);
    expect(await eventsFor(ids.questionWaiter, 'dependency_ready')).toHaveLength(0);
  }, 30_000);
});
