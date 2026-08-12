/**
 * worker crash recovery 测试（对应 biao-ph-redis-durability 验收）
 * 模拟测试 Redis DB 被清空（FLUSHDB）后：
 *   - worker 执行前检测到 lease 失效（isLeaseStale）
 *   - 旧 claim_token report 被拒（CLAIM_TOKEN_INVALID）
 *   - 本地 .claim.json 凭证持久化 / 清理
 *
 * ⚠ 不要用生产 Redis 跑本测试：默认连 6380 测试实例。
 *   先启动：redis-server --port 6380 --daemonize yes
 *   再跑：REDIS_URL=redis://localhost:6380/1 npx vitest run tests/crash-recovery.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { chmodSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/main.js';
import { BiaoClient, isLeaseStale, writeClaimFile, clearClaimFile } from '../src/worker/base.js';
import { planSubmit } from '../src/server/service.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PORT = 7391;
const FIXTURES = join(import.meta.dirname, 'fixtures');

let server: Awaited<ReturnType<typeof startServer>>;
let redis: Redis;
const client = new BiaoClient(`http://localhost:${PORT}`, 'crash-test-worker');

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb(); // 只清理独立测试 DB
  server = await startServer({ port: PORT, redisUrl: REDIS_URL });
  await planSubmit(redis, join(FIXTURES, 'test-plan'));
}, 20000);

afterAll(async () => {
  await server.close();
  redis.disconnect();
});

describe('worker crash recovery（模拟 Redis 清空）', () => {
  it('覆盖旧 .claim.json 时会移除原 token 并显式收紧权限到 0600', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'biao-legacy-claim-'));
    const claimPath = join(workDir, '.claim.json');
    const legacyToken = 'legacy-raw-claim-token';
    writeFileSync(claimPath, JSON.stringify({ task_id: 'legacy-task', claim_token: legacyToken }));
    chmodSync(claimPath, 0o644);

    writeClaimFile(workDir, {
      task_id: 'legacy-task',
      title: 'legacy-task',
      type: 'code',
      phase: 'impl',
      priority: 5,
      project_path: '/tmp',
      plan_id: 'legacy-plan',
      ownership_files: [],
      goal_md: '',
      timeout_seconds: 60,
      claim_token: 'fresh-claim-token',
      verify: [],
    }, 'legacy-worker');

    const sanitized = readFileSync(claimPath, 'utf8');
    expect(sanitized).not.toContain(legacyToken);
    expect(sanitized).not.toContain('fresh-claim-token');
    expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('claim 后 lease 有效；FLUSHDB 后检测到失效；旧 token report 被拒且产出保留', async () => {
    await client.register('cli', ['code']);
    const claimRes = await client.claim({ blocking: false, timeout_ms: 100 });
    expect(claimRes.ok).toBe(true);
    const task = claimRes.data!;
    expect(task.claim_token).toBeTruthy();

    // 1. claim 后 lease 有效
    expect(await isLeaseStale(client, task.task_id, 'crash-test-worker')).toBe(false);

    // 2. claim 凭证本地持久化（crash recovery 的核对依据）
    const workDir = mkdtempSync(join(tmpdir(), 'biao-crash-'));
    writeClaimFile(workDir, task, 'crash-test-worker');
    const claimFile = JSON.parse(readFileSync(join(workDir, '.claim.json'), 'utf8'));
    expect(claimFile.task_id).toBe(task.task_id);
    expect(claimFile).not.toHaveProperty('claim_token');
    expect(claimFile.claim_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(statSync(join(workDir, '.claim.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(workDir, '.claim.json'), 'utf8')).not.toContain(task.claim_token);

    // 3. 模拟事故：Redis 被清空 + PM 重新提交 plan（task 恢复为 pending，但 lease 没了）
    await redis.flushdb();
    await planSubmit(redis, join(FIXTURES, 'test-plan'));

    // 4. worker 执行前检测到 lease 失效 → 打印引导，不默默空跑
    expect(await isLeaseStale(client, task.task_id, 'crash-test-worker')).toBe(true);

    // 5. 旧 token report 被拒（CLAIM_TOKEN_INVALID），work 目录产出保留
    const r = await client.report(task.task_id, task.claim_token, 'done');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CLAIM_TOKEN_INVALID');
    expect(existsSync(join(workDir, '.claim.json'))).toBe(true);

    // 6. report 成功后凭证会被清理（此处手动验证 clearClaimFile 语义）
    clearClaimFile(workDir);
    expect(existsSync(join(workDir, '.claim.json'))).toBe(false);
    rmSync(workDir, { recursive: true, force: true });
  });
});
