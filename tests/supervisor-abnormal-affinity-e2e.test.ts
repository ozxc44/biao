import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server/main.js';
import { getPlan, getTask, planSubmit, pmIntake, setSqliteStore } from '../src/server/service.js';
import { BiaoSupervisorRuntime } from '../src/worker/supervisor.js';
import type { ClaimedTask } from '../src/types/index.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
const pmAdapter = join(import.meta.dirname, 'fixtures', 'pm-pool', 'accept-review.mjs');
const supervisorScript = join(repoRoot, 'scripts', 'supervisor.mjs');

let rootDir: string;
let projectDir: string;
let redisUrl: string;
let redis: Redis;
let server: Awaited<ReturnType<typeof startServer>>;
let baseUrl: string;

function databaseUrl(): string {
  const parsed = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/3');
  parsed.pathname = '/3';
  return parsed.toString();
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  if (!ready(value)) throw new Error('condition did not become true before timeout');
  return value;
}

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'biao-abnormal-affinity-e2e-'));
  projectDir = join(rootDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  redisUrl = databaseUrl();
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.flushdb();
  server = await startServer({
    port: 0,
    redisUrl,
    sqlitePath: join(rootDir, 'biao.sqlite'),
    workspaceRoots: [rootDir],
  });
  const address = server.app.server.address() as AddressInfo | null;
  if (!address) throw new Error('isolated Biao server did not listen');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 20_000);

afterAll(async () => {
  await server?.close();
  await redis?.flushdb();
  redis?.disconnect();
  setSqliteStore(null);
  rmSync(rootDir, { recursive: true, force: true });
});

describe('abnormal queue + model affinity + shared Supervisor PM pool', () => {
  it('Kimi failure is repaired by Kimi and the matching PM queue wakes its exact session', async () => {
    const planId = `abnormal-e2e-${Date.now()}`;
    const sourceTaskId = `${planId}-source`;
    const planDir = join(rootDir, 'plan-definition');
    const tasksDir = join(planDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(planDir, 'index.md'), `---
plan_id: ${planId}
title: abnormal affinity E2E
project_path: ${projectDir}
pm_consumer: pm-kimi-e2e
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: implementation
---

# abnormal affinity E2E
`);
    writeFileSync(join(tasksDir, 'source.md'), `---
task_id: ${sourceTaskId}
title: source task that fails once
type: code
phase: impl
assignee: kimi
priority: 5
timeout_seconds: 30
max_retries: 2
model_override: kimi-code/k3-affinity
verify: []
---

# fail once, then repair
`);
    expect((await planSubmit(redis, planDir)).ok).toBe(true);

    const executions: Array<{ agent: string; taskId: string; model?: string }> = [];
    const executeFor = (agent: string) => async (task: ClaimedTask) => {
      executions.push({ agent, taskId: task.task_id, model: task.model_override });
      const source = task.task_id === sourceTaskId;
      return {
        run: {
          exitCode: source ? 7 : 0,
          stdout: source ? 'simulated source failure' : 'repair completed',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        },
        changedFiles: [],
        backend: 'isolated-e2e',
        model: task.model_override ?? 'slot-default',
      };
    };
    const abort = new AbortController();
    const runtime = new BiaoSupervisorRuntime({
      biaoUrl: baseUrl,
      consumer: 'pm-kimi-e2e',
      planIds: [planId],
      pollIntervalMs: 10_000,
      signal: abort.signal,
      workers: [
        {
          agentId: 'codex-before-kimi', agentType: 'codex', preferredProject: projectDir,
          capabilities: ['code'], preferredTypes: ['code'], execute: executeFor('codex'),
        },
        {
          agentId: 'kimi-affinity-e2e', agentType: 'kimi', preferredProject: projectDir,
          capabilities: ['code'], preferredTypes: ['code'], execute: executeFor('kimi'),
        },
      ],
    });
    const running = runtime.run();

    const source = await eventually(
      () => getTask(redis, sourceTaskId).then((result) => result.data!),
      (task) => Boolean(task?.resolution_task_id),
    );
    const repairTaskId = source.resolution_task_id!;
    const repair = await eventually(
      () => getTask(redis, repairTaskId).then((result) => result.data!),
      (task) => task?.status === 'done',
    );
    abort.abort();
    await running;

    expect(executions).toEqual([
      { agent: 'kimi', taskId: sourceTaskId, model: 'kimi-code/k3-affinity' },
      { agent: 'kimi', taskId: repairTaskId, model: 'kimi-code/k3-affinity' },
    ]);
    expect(repair).toMatchObject({
      status: 'done', assignee: 'kimi', claimed_by: 'kimi-affinity-e2e',
      model_override: 'kimi-code/k3-affinity', fix_for: sourceTaskId,
    });
    const intake = await pmIntake(redis, { consumer: 'pm-kimi-e2e', plan_id: planId });
    expect(intake.data?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review_requested', task_id: repairTaskId }),
    ]));
    expect(intake.data?.items.some((item) => item.task_id === sourceTaskId && item.kind === 'failed')).toBe(false);

    const capture = join(rootDir, 'pm-capture.json');
    const command = [process.execPath, pmAdapter, capture]
      .map((value) => `'${value.replaceAll("'", `'"'"'`)}'`)
      .join(' ');
    const { stderr } = await execFileAsync(process.execPath, [
      supervisorScript, '--once', '--biao-url', baseUrl, '--plans', planId,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        BIAO_API_TOKEN: '',
        BIAO_LOCK_DIR: join(rootDir, 'supervisor-locks'),
        BIAO_PM_AGENT_LOCK_DIR: join(rootDir, 'pm-locks'),
        BIAO_PM_AGENT_CMD: '',
        BIAO_PM_AGENT_ROUTES: '',
        BIAO_WORKER_SLOTS: '',
        BIAO_PM_SLOTS: JSON.stringify([
          {
            id: 'pm-kimi-slot', consumer: 'pm-kimi-e2e', plans: [planId],
            command, target: 'pm-kimi-session-e2e',
          },
          {
            id: 'pm-unused-slot', consumer: 'pm-unused-e2e', plans: [planId],
            command, target: 'must-not-wake',
          },
        ]),
      },
    });
    expect(stderr).toBe('');
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toMatchObject({
      target: 'pm-kimi-session-e2e',
      wake: { consumer: 'pm-kimi-e2e', planIds: [planId] },
      taskId: repairTaskId,
    });

    const resolvedSource = (await getTask(redis, sourceTaskId)).data!;
    expect(resolvedSource).toMatchObject({ resolution_status: 'resolved', resolved_by_task: repairTaskId });
    expect((await getPlan(redis, planId)).data).toMatchObject({ status: 'completed' });
    expect((await pmIntake(redis, { consumer: 'pm-kimi-e2e', plan_id: planId })).data?.items).toEqual([]);
  }, 20_000);
});
