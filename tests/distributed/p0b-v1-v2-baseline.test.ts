/**
 * Phase 0b 测试：V1/V2 兼容基线快照
 *
 * 在 fixture 上跑一遍 V1 主链路（plan submit→claim→report→review）
 * + V2 infra 表读写（outbox append→retry→dead letter；idempotency 命中/未命中），
 * 固化基线快照，后续 Phase 必须在此 fixture 上给失败优先测试。
 *
 * V1 部分使用真实 Redis（6380 DB 15，与其他 p0a2 测试共享，flush 隔离）。
 * V2 部分使用纯 SQLite。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  planSubmit,
  claim,
  report,
  agentRegister,
  pmReview,
  getStatus,
  getTask,
} from '../../src/server/service.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import {
  appendOutboxEvent,
  markOutboxStatus,
  listRetryableOutbox,
  recordIdempotency,
  findIdempotency,
} from '../../src/server/v2/outbox.js';
import {
  createBareRemote,
  cloneBare,
  commitAndPush,
  defaultBranchSha,
  assertCasUpdated,
  cleanupGitFixtures,
} from './fixtures/git-fixture.js';
import {
  createArtifactStore,
  uploadArtifact,
  downloadArtifact,
  rejectPathTraversal,
  validateManifest,
  sha256hex,
  RESULT_MAX_BYTES,
  cleanupArtifactFixtures,
} from './fixtures/artifact-store-fixture.js';

const REDIS_URL = 'redis://127.0.0.1:6380/15';
let redis: Redis;

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PROJECT_PATH = '/tmp/biao-test';

const tempDirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'biao-p0b-'));
  tempDirs.push(dir);
  return join(dir, 'test.sqlite');
}

function writeTaskArtifacts(taskId: string, markdown: string) {
  const resultDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, 'result.md');
  const resultJsonPath = join(resultDir, 'result.json');
  writeFileSync(resultPath, markdown);
  writeFileSync(resultJsonPath, JSON.stringify({ task_id: taskId, status: 'done' }));
  return { resultPath, resultJsonPath };
}

// ──────────────── V1 主链路基线 ────────────────

describe('V1 主链路基线快照', () => {
  beforeEach(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    // flush 测试 Redis DB
    const keys = await redis.keys('biao:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterEach(async () => {
    const keys = await redis.keys('biao:*');
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
    rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  });

  it('plan submit → claim → report → review 完整链路', async () => {
    // 1. plan submit
    const submitResult = await planSubmit(redis, join(FIXTURES, 'test-plan'));
    expect(submitResult.ok).toBe(true);
    expect(submitResult.data?.task_count).toBeGreaterThan(0);
    const planId = submitResult.data!.plan_id;

    // 2. agent register
    const regResult = await agentRegister(redis, 'p0b-worker-1', 'mock', ['code']);
    expect(regResult.ok).toBe(true);

    // 3. claim 第一个无依赖任务
    const claimResult = await claim(redis, { agent_id: 'p0b-worker-1', blocking: false });
    expect(claimResult.ok).toBe(true);
    expect(claimResult.data).not.toBeNull();
    const taskId = claimResult.data!.task_id;
    const claimToken = claimResult.data!.claim_token;
    expect(claimToken).toMatch(/^tok_/);

    // 4. 验证 running 状态
    const taskAfterClaim = await getTask(redis, taskId);
    expect(taskAfterClaim.data?.status).toBe('running');
    expect(taskAfterClaim.data?.claimed_by).toBe('p0b-worker-1');

    // 5. report done
    const artifacts = writeTaskArtifacts(taskId, '# P0B 基线执行结果\n\n- 状态：PASS\n');
    const reportResult = await report(redis, {
      task_id: taskId,
      agent_id: 'p0b-worker-1',
      claim_token: claimToken,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });
    expect(reportResult.ok).toBe(true);
    expect(reportResult.data?.status).toBe('done');

    // 6. PM review accept
    const reviewResult = await pmReview(redis, taskId, {
      verdict: 'accept',
      reviewed_by: 'p0b-pm',
      comment: 'P0B 基线验收通过',
    });
    expect(reviewResult.ok).toBe(true);

    // 7. 验证最终状态
    const taskFinal = await getTask(redis, taskId);
    expect(taskFinal.data?.status).toBe('done');
    expect(taskFinal.data?.pm_review_status).toBe('accepted');
  });

  it('claim 错误 token report 被拒（失败路径）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'p0b-worker-2', 'mock', ['code']);
    const claimResult = await claim(redis, { agent_id: 'p0b-worker-2', blocking: false });
    expect(claimResult.ok).toBe(true);

    const reportResult = await report(redis, {
      task_id: claimResult.data!.task_id,
      agent_id: 'p0b-worker-2',
      claim_token: 'wrong_token',
      status: 'done',
    });
    expect(reportResult.ok).toBe(false);
    expect(reportResult.error?.code).toBe('CLAIM_TOKEN_INVALID');
  });

  it('pmReview reject 生成修复指令（失败路径）', async () => {
    await planSubmit(redis, join(FIXTURES, 'test-plan'));
    await agentRegister(redis, 'p0b-worker-3', 'mock', ['code']);
    const claimResult = await claim(redis, { agent_id: 'p0b-worker-3', blocking: false });
    expect(claimResult.ok).toBe(true);

    const artifacts = writeTaskArtifacts(claimResult.data!.task_id, '# 有缺陷的结果\n');
    await report(redis, {
      task_id: claimResult.data!.task_id,
      agent_id: 'p0b-worker-3',
      claim_token: claimResult.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
      verify_results: [{ cmd: 'echo hello', exit_code: 0, passed: true }],
    });

    const reviewResult = await pmReview(redis, claimResult.data!.task_id, {
      verdict: 'reject',
      reviewed_by: 'p0b-pm',
      reject_reason: '测试覆盖不足',
      fix_instructions: '增加边界条件测试',
    });
    expect(reviewResult.ok).toBe(true);
  });
});

// ──────────────── V2 infra 表读写基线 ────────────────

describe('V2 infra 表读写基线快照', () => {
  let store: SqliteStore;

  beforeEach(() => {
    const dbPath = tempDb();
    store = new SqliteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('outbox append → retry → dead letter 完整生命周期', () => {
    // 1. append
    const evt = appendOutboxEvent(store, {
      event_id: 'p0b-evt-001',
      project_id: 'proj-p0b',
      aggregate_type: 'delivery',
      aggregate_id: 'del-001',
      aggregate_revision: 1,
      payload: { status: 'completed', sha: 'abc123' },
    });
    expect(evt.status).toBe('pending');
    expect(evt.attempt_count).toBe(0);
    expect(evt.payload_digest).toMatch(/^[a-f0-9]{64}$/);

    // 2. 第一次重试失败 → 重新 pending
    markOutboxStatus(store, 'p0b-evt-001', 'pending', {
      last_error: '连接超时',
      next_attempt_at: Date.now() - 1000, // 已到期
    });
    const afterRetry = store.getOutboxEvent('p0b-evt-001')!;
    expect(afterRetry.status).toBe('pending');
    expect(afterRetry.attempt_count).toBe(1);
    expect(afterRetry.last_error).toBe('连接超时');

    // 3. listRetryableOutbox 应返回已到期的 pending
    const retryable = listRetryableOutbox(store);
    expect(retryable.map((r) => r.event_id)).toContain('p0b-evt-001');

    // 4. 第二次重试仍失败
    markOutboxStatus(store, 'p0b-evt-001', 'pending', {
      last_error: '连接超时（第二次）',
      next_attempt_at: Date.now() - 1000,
    });

    // 5. 最终 dead letter
    markOutboxStatus(store, 'p0b-evt-001', 'dead_letter', {
      last_error: '永久失败：服务不可达',
    });
    const deadLettered = store.getOutboxEvent('p0b-evt-001')!;
    expect(deadLettered.status).toBe('dead_letter');
    expect(deadLettered.attempt_count).toBe(3);
    expect(deadLettered.dead_lettered_at).toBeGreaterThan(0);
    expect(deadLettered.last_error).toBe('永久失败：服务不可达');

    // 6. delivered 的不应出现在 retryable 列表
    appendOutboxEvent(store, {
      event_id: 'p0b-evt-002',
      aggregate_type: 'task',
      aggregate_id: 'task-002',
      aggregate_revision: 1,
      payload: {},
    });
    markOutboxStatus(store, 'p0b-evt-002', 'delivered');
    const retryable2 = listRetryableOutbox(store);
    expect(retryable2.map((r) => r.event_id)).not.toContain('p0b-evt-002');
  });

  it('idempotency 命中/未命中基线', () => {
    // 1. 未命中
    const miss = findIdempotency(store, 'worker-1', '/v2/deliveries', 'key-001', { head_sha: 'abc' });
    expect(miss.found).toBe(false);

    // 2. 记录
    recordIdempotency(store, {
      actor_id: 'worker-1',
      route: '/v2/deliveries',
      idempotency_key: 'key-001',
      request_body: { head_sha: 'abc' },
      response_entity_type: 'delivery',
      response_entity_id: 'del-001',
      response_revision: 1,
    });

    // 3. 相同 body 命中（digest_match=true）
    const hit = findIdempotency(store, 'worker-1', '/v2/deliveries', 'key-001', { head_sha: 'abc' });
    expect(hit.found).toBe(true);
    expect(hit.digest_match).toBe(true);
    expect(hit.record!.response_entity_id).toBe('del-001');

    // 4. 不同 body 命中但 digest 不匹配（冲突）
    const conflict = findIdempotency(store, 'worker-1', '/v2/deliveries', 'key-001', { head_sha: 'DIFFERENT' });
    expect(conflict.found).toBe(true);
    expect(conflict.digest_match).toBe(false);

    // 5. 不同 actor 同 key 不冲突
    recordIdempotency(store, {
      actor_id: 'worker-2',
      route: '/v2/deliveries',
      idempotency_key: 'key-001',
      request_body: { head_sha: 'xyz' },
      response_entity_type: 'delivery',
      response_entity_id: 'del-002',
      response_revision: 1,
    });
    const other = findIdempotency(store, 'worker-2', '/v2/deliveries', 'key-001', { head_sha: 'xyz' });
    expect(other.found).toBe(true);
    expect(other.digest_match).toBe(true);
    expect(other.record!.response_entity_id).toBe('del-002');
  });

  it('outbox compensating event 基线', () => {
    // 原始事件
    appendOutboxEvent(store, {
      event_id: 'p0b-orig-001',
      aggregate_type: 'delivery',
      aggregate_id: 'del-orig',
      aggregate_revision: 1,
      payload: { status: 'completed' },
    });
    markOutboxStatus(store, 'p0b-orig-001', 'dead_letter', { last_error: '永久失败' });

    // 补偿事件
    const compensating = appendOutboxEvent(store, {
      event_id: 'p0b-comp-001',
      aggregate_type: 'delivery',
      aggregate_id: 'del-orig',
      aggregate_revision: 2,
      payload: { status: 'rolled_back' },
      compensates_event_id: 'p0b-orig-001',
    });
    expect(compensating.compensates_event_id).toBe('p0b-orig-001');
    expect(compensating.aggregate_revision).toBe(2);
  });
});

// ──────────────── Git + Artifact 基线集成 ────────────────

describe('Git + Artifact 基线集成', () => {
  afterEach(() => {
    cleanupGitFixtures();
    cleanupArtifactFixtures();
  });

  it('bare remote push + artifact upload 联合基线', () => {
    // 1. 创建 bare remote
    const bare = createBareRemote();
    const beforeSha = defaultBranchSha(bare);

    // 2. clone 并 push
    const clone = cloneBare(bare);
    const pushedSha = commitAndPush(clone, 'output.txt', 'task output content', 'P0B 交付');

    // 3. CAS 断言
    const afterSha = defaultBranchSha(bare);
    assertCasUpdated(bare, beforeSha, afterSha);
    expect(afterSha).toBe(pushedSha);

    // 4. artifact upload
    const store = createArtifactStore();
    const resultContent = Buffer.from('# P0B 执行结果\n\n状态：PASS');
    const uploaded = uploadArtifact(store, resultContent, 'result.md');
    expect(uploaded.sha256).toMatch(/^[a-f0-9]{64}$/);

    // 5. download 验证
    const downloaded = downloadArtifact(store, uploaded.sha256);
    expect(downloaded).toEqual(resultContent);

    // 6. manifest 校验
    const valid = validateManifest(store, {
      artifacts: [{ sha256: uploaded.sha256, sizeBytes: uploaded.sizeBytes, kind: 'result.md' }],
      totalBytes: uploaded.sizeBytes,
    });
    expect(valid).toBe(true);
  });

  it('路径穿越拒绝 + 超大文件拒绝 基线', () => {
    const store = createArtifactStore();

    // 路径穿越
    expect(() => rejectPathTraversal(store, '../../../etc/passwd')).toThrow(/路径穿越拒绝/);
    expect(() => rejectPathTraversal(store, 'subdir/../../secret')).toThrow(/路径穿越拒绝/);

    // 超大文件
    const oversized = Buffer.alloc(RESULT_MAX_BYTES + 1);
    expect(() => uploadArtifact(store, oversized, 'result.md')).toThrow(/超限/);
  });
});
