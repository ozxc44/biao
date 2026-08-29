/**
 * Bors-lite accept 复验闸门回归：
 * - reverify=true 时，accept 前中央在当前工作区重跑声明 verify；工作区漂移
 *   （report 后 marker 被删）导致失败则拒绝验收，任务停留在 done 待处置；
 * - 复验通过则结果并入验收审计（accept_verify_results）并出现在证据卡；
 * - 不带 reverify 的 accept 行为不变；无声明 verify 的任务 reverify 空转直过。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  getReviewInfo,
  pmReview,
  report,
  setSqliteStore,
} from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/5';
const PROJECT_PATH = '/tmp/biao-pm-accept-reverify';
const VERIFY_CMD = 'test -f marker.txt';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  rmSync(PROJECT_PATH, { recursive: true, force: true });
  mkdirSync(PROJECT_PATH, { recursive: true });
});

beforeEach(async () => {
  setSqliteStore(null);
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  await redis.flushdb();
  await writePlanToRedis(redis, {
    plan_id: 'pm-accept-reverify-plan',
    title: 'PM accept reverify',
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-accept-reverify',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => {
  setSqliteStore(null);
  redis.disconnect();
  rmSync(PROJECT_PATH, { recursive: true, force: true });
});

async function seedTask(taskId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    timeout_seconds: 60,
    verify: [{ cmd: VERIFY_CMD, expect_exit: 0 }],
    ...overrides,
  } as never, `# ${taskId}\n`, 'pm-accept-reverify-plan', PROJECT_PATH, 5);
}

async function deliver(taskId: string, agentId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await seedTask(taskId, overrides);
  await agentRegister(redis, agentId, 'mock', ['code']);
  const claimed = await claim(redis, {
    agent_id: agentId,
    blocking: false,
    timeout_ms: 1,
    preferred_types: ['code'],
  });
  expect(claimed.data?.task_id).toBe(taskId);
  const resultDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  writeFileSync(resultPath, `# ${taskId}\n\ndelivered\n`);
  const declared = (overrides.verify === undefined
    ? [{ cmd: VERIFY_CMD }]
    : overrides.verify) as Array<{ cmd: string }>;
  const reported = await report(redis, {
    task_id: taskId,
    agent_id: agentId,
    claim_token: claimed.data!.claim_token,
    status: 'done',
    result_path: resultPath,
    ...(declared.length > 0
      ? { verify_results: declared.map((entry) => ({ cmd: entry.cmd, exit_code: 0, passed: true })) }
      : {}),
  });
  expect(reported.ok).toBe(true);
}

describe('Bors-lite accept 复验闸门', () => {
  it('工作区漂移后 reverify=true 拒绝验收，任务停留在待处置', async () => {
    writeFileSync(join(PROJECT_PATH, 'marker.txt'), 'ok');
    await deliver('reverify-drift', 'worker-drift');
    rmSync(join(PROJECT_PATH, 'marker.txt'));

    const denied = await pmReview(redis, 'reverify-drift', { verdict: 'accept', reviewed_by: 'pm', reverify: true });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('ACCEPT_REVERIFY_FAILED');
    expect(denied.error?.message).toContain(VERIFY_CMD);

    const hash = await redis.hgetall(keys.hash.task('reverify-drift'));
    expect(hash.pm_review_status ?? '').toBe('');
  });

  it('复验通过则 accepted，结果并入审计与证据卡', async () => {
    writeFileSync(join(PROJECT_PATH, 'marker.txt'), 'ok');
    await deliver('reverify-pass', 'worker-pass');

    const accepted = await pmReview(redis, 'reverify-pass', { verdict: 'accept', reviewed_by: 'pm', reverify: true });
    expect(accepted.ok).toBe(true);

    const hash = await redis.hgetall(keys.hash.task('reverify-pass'));
    expect(hash.pm_review_status).toBe('accepted');
    const audit = JSON.parse(hash.accept_verify_results ?? '[]') as Array<{ cmd: string; passed: boolean }>;
    expect(audit).toEqual([{ cmd: VERIFY_CMD, exit_code: 0, passed: true, output: expect.any(String) }]);

    const review = await getReviewInfo(redis, 'reverify-pass');
    const evidence = (review.data as { evidence?: { accept_reverify?: Array<{ cmd: string; passed: boolean }> } }).evidence;
    expect(evidence?.accept_reverify).toEqual([{ cmd: VERIFY_CMD, exit_code: 0, passed: true }]);
  });

  it('不带 reverify 的 accept 行为不变（漂移也不拦截）', async () => {
    writeFileSync(join(PROJECT_PATH, 'marker.txt'), 'ok');
    await deliver('reverify-legacy', 'worker-legacy');
    rmSync(join(PROJECT_PATH, 'marker.txt'));

    const accepted = await pmReview(redis, 'reverify-legacy', { verdict: 'accept', reviewed_by: 'pm' });
    expect(accepted.ok).toBe(true);
    const hash = await redis.hgetall(keys.hash.task('reverify-legacy'));
    expect(hash.accept_verify_results).toBeUndefined();
  });

  it('无声明 verify 的任务 reverify=true 空转直过', async () => {
    await deliver('reverify-noverify', 'worker-noverify', { verify: [] });
    const accepted = await pmReview(redis, 'reverify-noverify', { verdict: 'accept', reviewed_by: 'pm', reverify: true });
    expect(accepted.ok).toBe(true);
    const hash = await redis.hgetall(keys.hash.task('reverify-noverify'));
    expect(hash.accept_verify_results).toBeUndefined();
  });
});
