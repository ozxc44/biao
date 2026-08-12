/**
 * lease renew 测试（对应 biao-ph-lease-renew 验收）
 * 1. renew 成功：TTL 延长 + expire_at / running zset score 更新
 * 2. token 不匹配 → CLAIM_TOKEN_INVALID
 * 3. worker 长任务自动续租：task timeout=3s、执行 5s，无续租会过期，有续租则 report done
 *
 * 用 DB 1 测试隔离（bpi-03），不碰生产 DB 0。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/main.js';
import { BiaoClient, runWorkerLoop } from '../src/worker/base.js';
import { planSubmit, renewLease, getTask } from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

// DB 1 测试隔离（bpi-03）；用独立端口 7392 起 test server，不抢 7331
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
const PORT = 7392;

let server: Awaited<ReturnType<typeof startServer>>;
let redis: Redis;
let planDir: string;
const client = new BiaoClient(`http://localhost:${PORT}`, 'renew-test-worker');

/** 造一个 timeout 很短的 plan（worker 自动续租场景用） */
function makeShortTimeoutPlan(dir: string, timeoutSeconds: number) {
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, 'index.md'),
    `---
plan_id: renew-test-plan
title: 续租测试
project_path: ${dir}
phases:
  - id: impl
    name: 实现
---

# 续租测试
`,
  );
  writeFileSync(
    join(dir, 'tasks', 'T01.md'),
    `---
task_id: renew-test-01
title: 长任务（执行时间超过 lease）
type: code
phase: impl
assignee: auto
priority: 5
timeout_seconds: ${timeoutSeconds}
verify: []
---

# 长任务

执行时间故意超过 lease，验证自动续租。
`,
  );
}

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  server = await startServer({ port: PORT, redisUrl: REDIS_URL });
  planDir = mkdtempSync(join(tmpdir(), 'biao-renew-plan-'));
}, 20000);

afterAll(async () => {
  await server.close();
  redis.disconnect();
  rmSync(planDir, { recursive: true, force: true });
});

describe('POST /lease/renew', () => {
  it('renew 成功：expire_at 更新；token 不匹配被拒', async () => {
    await redis.flushdb();
    makeShortTimeoutPlan(planDir, 60);
    await planSubmit(redis, planDir);
    await client.register('cli', ['code']);

    const claimed = await client.claim({ blocking: false, timeout_ms: 100 });
    const task = claimed.data!;

    // token 不匹配 → CLAIM_TOKEN_INVALID
    const bad = await renewLease(redis, { task_id: task.task_id, claim_token: 'wrong-token' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe('CLAIM_TOKEN_INVALID');

    // renew 成功 → expire_at 更新、running zset score 更新
    const before = (await getTask(redis, task.task_id)).data as { expire_at?: number };
    const r = await renewLease(redis, { task_id: task.task_id, claim_token: task.claim_token, extend_seconds: 120 });
    expect(r.ok).toBe(true);
    expect(r.data!.new_expire_at).toBeGreaterThan(Date.now() + 100_000);

    const hash = await redis.hgetall(keys.hash.task(task.task_id));
    expect(Number(hash.expire_at)).toBe(r.data!.new_expire_at);
    expect(Number(hash.expire_at)).toBeGreaterThan(Number(before.expire_at ?? 0));
    const score = await redis.zscore(keys.zset.status.running, task.task_id);
    expect(Number(score)).toBe(r.data!.new_expire_at);
  });
});

describe('worker 长任务自动续租', () => {
  it('task timeout=3s、执行 5s：自动续租让 report 成功（不续租会 CLAIM_TOKEN_INVALID）', async () => {
    await redis.flushdb();
    makeShortTimeoutPlan(planDir, 3); // lease 3s
    await planSubmit(redis, planDir);

    // execute 睡 5s——没有自动续租的话 lease 第 3s 就过期，report 必失败
    await runWorkerLoop({
      agentId: 'renew-test-worker',
      agentType: 'cli',
      biaoUrl: `http://localhost:${PORT}`,
      maxTasks: 1,
      preferredProject: planDir,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return {
          run: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5000, timedOut: false },
          changedFiles: [],
          backend: 'mock',
          model: 'mock',
        };
      },
    });

    // 自动续租（每 timeout/3=1s 一次）保住了 lease → task 应 report done
    const t = await getTask(redis, 'renew-test-01');
    expect(t.data?.status).toBe('done');
  }, 30000);
});
