/**
 * Phase 2 测试：Artifact Store
 *
 * 失败优先测试（真实磁盘临时目录）：
 * 1. 完整上传→读回字节一致
 * 2. 篡改拒绝（分片摘要不符 complete 失败且无残留 blob）
 * 3. 超限拒绝（§9.3 上限）
 * 4. 跨任务引用拒绝（task-B 引用 task-A 的 artifact → 拒绝）
 * 5. 幂等重传（同 sha256 重传直接返回已存在）
 * 6. 服务端无 Worker 文件挂载仍可完整 Review
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate.js';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import { ArtifactStoreEngine } from '../../src/server/artifact-store.js';
import {
  createArtifactService,
  reportV2WithArtifacts,
  getDeliveryReviewView,
} from '../../src/server/v2/artifact-service.js';
import type { TaskRow } from '../../src/db/sqlite-store.js';

function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

describe('Phase 2: Artifact Store', () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: SqliteStore;
  let engine: ArtifactStoreEngine;
  let artifactService: ReturnType<typeof createArtifactService>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'biao-p2-'));
    db = new Database(':memory:');
    runMigrations(db);
    store = new SqliteStore(':memory:');
    engine = new ArtifactStoreEngine({
      root: join(tmpDir, 'artifacts'),
      store,
    });
    artifactService = createArtifactService({ store, artifactEngine: engine });
    createdPlans.clear();
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 辅助：创建 plan + task 记录 ──
  const createdPlans = new Set<string>();

  function ensurePlan(planId: string): void {
    if (createdPlans.has(planId)) return;
    store.upsertPlan({
      plan_id: planId,
      title: `Plan ${planId}`,
      status: 'submitted',
      project_path: '/tmp/test',
      default_assignee: 'auto',
      default_priority: 5,
      phases: '[]',
      task_count: 1,
      created_at: new Date().toISOString(),
      submitted_at: new Date().toISOString(),
    });
    createdPlans.add(planId);
  }

  function insertTask(taskId: string, projectId: string, attemptId?: string): TaskRow {
    const planId = 'plan-test';
    ensurePlan(planId);
    const row: TaskRow = {
      task_id: taskId,
      plan_id: planId,
      title: `Task ${taskId}`,
      type: 'implementation',
      phase: '1',
      status: 'running',
      priority: 5,
      assignee: 'auto',
      ownership_files: '[]',
      ownership_modules: '',
      depends_on: '[]',
      timeout_seconds: 3600,
      max_retries: 2,
      model_override: '',
      acceptance_for: '',
      verify: '[]',
      claimed_by: attemptId ?? '',
      claimed_at: new Date().toISOString(),
      expire_at: '',
      result_path: '',
      result_json_path: '',
      done_at: '',
      retries: 0,
      pm_review_status: '',
      pm_reviewed_by: '',
      pm_reviewed_at: '',
      pm_review_comment: '',
      pm_reject_reason: '',
      pm_fix_instructions: '',
      blocked_at: '',
      block_reason: '',
      blocked_question_id: '',
      blocked_lease_remaining: '',
      last_question_id: '',
      last_question_answer: '',
      cancelled_at: '',
      verify_results: '[]',
      goal_md: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      project_id: projectId,
      active_attempt_id: attemptId ?? '',
    };
    store.upsertTask(row);
    return row;
  }

  // ──────────────── 1. 完整上传→读回字节一致 ────────────────

  it('完整上传→读回字节一致', async () => {
    const content = Buffer.from('Hello, Artifact Store! This is a test payload.');
    const sha = sha256hex(content);
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    // initiate
    const initResult = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });
    expect(initResult.artifact_id).toBeTruthy();
    expect(initResult.upload_id).toBeTruthy();

    // upload single chunk
    const uploadResult = await engine.uploadChunk(initResult.upload_id, content, 0);
    expect(uploadResult.received_bytes).toBe(content.length);

    // complete
    const completeResult = await engine.complete(initResult.upload_id);
    expect(completeResult.sha256).toBe(sha);
    expect(completeResult.size_bytes).toBe(content.length);

    // read back
    const readResult = engine.readBySha256(sha, projectId, taskId);
    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const readContent = Buffer.concat(chunks);
    expect(readContent).toEqual(content);
  });

  // ──────────────── 2. 篡改拒绝 ────────────────

  it('篡改拒绝：分片摘要不符 complete 失败且无残留 blob', async () => {
    const content = Buffer.from('Original content for tamper test');
    const sha = sha256hex(content);
    const tampered = Buffer.from('Tampered content!!');
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    const initResult = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });

    // 上传篡改后的内容
    await engine.uploadChunk(initResult.upload_id, tampered, 0);

    // complete 应该失败
    await expect(engine.complete(initResult.upload_id)).rejects.toThrow(/SHA-256 不符/);

    // artifact 状态应为 rejected
    const artifact = store.getArtifact(initResult.artifact_id);
    expect(artifact?.status).toBe('rejected');

    // blob 文件不应存在
    const prefix = sha.slice(0, 2);
    const blobPath = join(tmpDir, 'artifacts', 'sha256', prefix, sha);
    expect(existsSync(blobPath)).toBe(false);
  });

  // ──────────────── 3. 超限拒绝 ────────────────

  it('超限拒绝：result-md 超过 2 MiB 上限', () => {
    const sha = sha256hex(Buffer.alloc(1));
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    // 声明超限大小
    expect(() => engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: 3 * 1024 * 1024, // 3 MiB > 2 MiB limit
      sha256: sha,
    })).toThrow(/超限/);
  });

  it('agent-log 允许更大但仍有上限', () => {
    const sha = sha256hex(Buffer.alloc(1));
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    // agent-log 允许 50 MiB
    expect(() => engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'agent-log',
      size_bytes: 51 * 1024 * 1024, // 51 MiB > 50 MiB limit
      sha256: sha,
    })).toThrow(/超限/);
  });

  // ──────────────── 4. 跨任务引用拒绝 ────────────────

  it('跨任务引用拒绝：task-B 引用 task-A 的 artifact', async () => {
    const content = Buffer.from('Cross-task test payload');
    const sha = sha256hex(content);
    const attemptA = randomId('attempt-a');
    const taskA = randomId('task-a');
    const projA = randomId('proj-a');
    const attemptB = randomId('attempt-b');
    const taskB = randomId('task-b');
    const projB = randomId('proj-b');

    insertTask(taskA, projA, attemptA);
    insertTask(taskB, projB, attemptB);

    // task-A 上传
    const initA = engine.initiate({
      attempt_id: attemptA,
      task_id: taskA,
      project_id: projA,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });
    await engine.uploadChunk(initA.upload_id, content, 0);
    await engine.complete(initA.upload_id);

    // task-B 尝试读取 task-A 的 artifact → 拒绝
    expect(() => engine.readBySha256(sha, projB, taskB)).toThrow(/跨.*引用拒绝/);
  });

  it('跨项目引用拒绝', async () => {
    const content = Buffer.from('Cross-project test');
    const sha = sha256hex(content);
    const attemptA = randomId('attempt');
    const taskA = randomId('task');
    const projA = randomId('proj-a');
    const projB = randomId('proj-b');

    insertTask(taskA, projA, attemptA);

    const initA = engine.initiate({
      attempt_id: attemptA,
      task_id: taskA,
      project_id: projA,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });
    await engine.uploadChunk(initA.upload_id, content, 0);
    await engine.complete(initA.upload_id);

    // 不同项目读取 → 拒绝
    expect(() => engine.readBySha256(sha, projB)).toThrow(/跨项目引用拒绝/);
  });

  // ──────────────── 5. 幂等重传 ────────────────

  it('幂等重传：同 sha256 重传直接返回已存在', async () => {
    const content = Buffer.from('Idempotent re-upload test');
    const sha = sha256hex(content);
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    // 第一次上传
    const init1 = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });
    await engine.uploadChunk(init1.upload_id, content, 0);
    await engine.complete(init1.upload_id);

    // 第二次 initiate 同 sha256 → 幂等返回
    const init2 = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    });
    expect(init2.artifact_id).toBe(init1.artifact_id);
  });

  // ──────────────── 6. Review 完整性 ────────────────

  it('服务端无 Worker 文件挂载仍可完整 Review', async () => {
    const content1 = Buffer.from('Result markdown content');
    const content2 = Buffer.from('{"status": "ok", "tests_passed": 42}');
    const sha1 = sha256hex(content1);
    const sha2 = sha256hex(content2);
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    // 上传两个 artifact
    const init1 = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: content1.length,
      sha256: sha1,
    });
    await engine.uploadChunk(init1.upload_id, content1, 0);
    await engine.complete(init1.upload_id);

    const init2 = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-json',
      size_bytes: content2.length,
      sha256: sha2,
    });
    await engine.uploadChunk(init2.upload_id, content2, 0);
    await engine.complete(init2.upload_id);

    // Report V2 with artifact refs
    const reportResult = reportV2WithArtifacts(store, attemptId, {
      status: 'done',
      artifact_refs: [
        { artifact_id: init1.artifact_id, sha256: sha1 },
        { artifact_id: init2.artifact_id, sha256: sha2 },
      ],
    });
    expect(reportResult.ok).toBe(true);
    expect(reportResult.data?.delivery_id).toBeTruthy();

    // PM Review：读 delivery + artifact manifest
    const reviewView = getDeliveryReviewView(store, reportResult.data!.delivery_id!);
    expect(reviewView.ok).toBe(true);
    expect(reviewView.data).toBeTruthy();
    expect(reviewView.data!.artifacts).toHaveLength(2);
    expect(reviewView.data!.artifacts[0].sha256).toBe(sha1);
    expect(reviewView.data!.artifacts[1].sha256).toBe(sha2);
    expect(reviewView.data!.artifacts[0].status).toBe('complete');
    expect(reviewView.data!.artifacts[1].status).toBe('complete');

    // 验证可以通过 sha256 读回完整内容（服务端本地即可）
    const read1 = engine.readBySha256(sha1, projectId, taskId);
    const chunks1: Buffer[] = [];
    for await (const chunk of read1.stream) {
      chunks1.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks1)).toEqual(content1);
  });

  // ──────────────── 7. Artifact Service 集成 ────────────────

  it('ArtifactService.initiate + complete 端到端', async () => {
    const content = Buffer.from('Service integration test');
    const sha = sha256hex(content);
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    const initResult = artifactService.initiateArtifact(attemptId, {
      kind: 'result-md',
      size_bytes: content.length,
      sha256: sha,
    }, {
      actor: { actor_id: 'test', actor_kind: 'task_attempt' },
      idempotency_key: randomId('ik'),
      correlation_id: randomId('corr'),
    });
    expect(initResult.ok).toBe(true);

    // upload
    const uploadResult = await artifactService.uploadArtifactContent(
      initResult.data!.artifact_id,
      content,
      0,
    );
    expect(uploadResult.ok).toBe(true);

    // complete
    const completeResult = await artifactService.completeArtifact(initResult.data!.artifact_id);
    expect(completeResult.ok).toBe(true);
    expect(completeResult.data?.status).toBe('complete');
  });

  // ──────────────── 8. 分片上传（多 chunk） ────────────────

  it('多分片乱序上传并合并校验', async () => {
    const chunk1 = Buffer.from('First chunk of data. ');
    const chunk2 = Buffer.from('Second chunk of data. ');
    const chunk3 = Buffer.from('Third chunk!');
    const fullContent = Buffer.concat([chunk1, chunk2, chunk3]);
    const sha = sha256hex(fullContent);
    const attemptId = randomId('attempt');
    const taskId = randomId('task');
    const projectId = randomId('proj');

    insertTask(taskId, projectId, attemptId);

    const initResult = engine.initiate({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: projectId,
      kind: 'result-md',
      size_bytes: fullContent.length,
      sha256: sha,
    });

    // 乱序上传：chunk 2, 0, 1
    await engine.uploadChunk(initResult.upload_id, chunk2, 1);
    await engine.uploadChunk(initResult.upload_id, chunk1, 0);
    await engine.uploadChunk(initResult.upload_id, chunk3, 2);

    // complete
    const completeResult = await engine.complete(initResult.upload_id);
    expect(completeResult.sha256).toBe(sha);

    // 读回验证
    const readResult = engine.readBySha256(sha, projectId, taskId);
    const chunks: Buffer[] = [];
    for await (const chunk of readResult.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(fullContent);
  });
});
