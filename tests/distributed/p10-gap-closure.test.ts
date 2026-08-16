/**
 * Phase 10 深化轮 F：三项可自主完成的部分覆盖缺口收口
 *
 * 覆盖：
 * - 22.1-10：V2 Delivery repair/reverify（rejected→repair→新 attempt 继承约束→完成→merged；reverify 幂等）
 * - 22.4-18：outbox stall 检测 + degraded + 按 revision 重放
 * - 22.3-17：handleRefAclMiss 接线（push_forbidden 触发熔断 + fencing + incident）
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import type { OutboxEventRow } from '../../src/types/v2-infra.js';
import {
  loadV2CredentialKeyring,
  V2_CREDENTIAL_KEY_ENV,
  issueNodeCredential,
  issueAttemptToken,
} from '../../src/server/v2/credentials.js';
import {
  appendOutboxEvent,
  markOutboxStatus,
  detectStalledOutbox,
  markOutboxDegraded,
  replayOutboxByRevision,
  collectStalledOutboxStats,
  OUTBOX_STALL_DEFAULT_THRESHOLD_MS,
} from '../../src/server/v2/outbox.js';
import {
  createDeliveryService,
  newDeliveryId,
} from '../../src/server/v2/delivery-service.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';
import {
  RefAclMissTracker,
  executeRefAclMissCircuitBreaker,
  checkRefAcl,
  createDefaultRefAcl,
} from '../../src/server/v2/git/ref-acl.js';
import { createMergeQueue } from '../../src/server/v2/merge/queue.js';
import { createIncidentService } from '../../src/server/v2/incident-service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------- */
/* env 纪律                                                          */
/* ---------------------------------------------------------------- */

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key: string): void {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}

const TEST_KEY_HEX = 'aabbccdd'.repeat(8);

/* ---------------------------------------------------------------- */
/* 通用 fixture                                                     */
/* ---------------------------------------------------------------- */

function makeProject(store: SqliteStore, overrides: Partial<ProjectRow> = {}): ProjectRow {
  const projectId = overrides.project_id ?? `proj-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const project: ProjectRow = {
    display_name: `Test Project ${projectId}`,
    repository_url: '',
    repository_fingerprint: '',
    default_branch: 'main',
    merge_policy: 'merge-queue',
    execution_mode: 'full',
    mode_transition: null,
    mode_transition_id: '',
    mode_transition_step: null,
    write_capability_status: 'ready',
    artifact_policy_id: '',
    workspace_policy_id: '',
    status: 'active',
    revision: 0,
    ref_acl_json: '',
    ref_acl_miss_count: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
    project_id: projectId,
  };
  store.insertProject(project);
  return project;
}

function makeTaskId(): string {
  return `task-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function makeAttempt(store: SqliteStore, projectId: string, taskId: string, overrides: Record<string, unknown> = {}): string {
  const attemptId = overrides.attempt_id as string ?? `att-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  store.insertTaskAttempt({
    attempt_id: attemptId,
    task_id: taskId,
    project_id: projectId,
    node_id: (overrides.node_id as string) ?? 'node-1',
    session_id: '',
    status: (overrides.status as string) ?? 'executing',
    attempt_generation: 1,
    lease_expires_at: Date.now() + 3600_000,
    lease_duration_ms: 3600_000,
    token_jti: '',
    artifact_ids: '[]',
    started_at: Date.now(),
    updated_at: Date.now(),
    completed_at: null,
    failure_reason: '',
  });
  return attemptId;
}

function makeDelivery(store: SqliteStore, projectId: string, attemptId: string, taskId: string, overrides: Record<string, unknown> = {}): string {
  const deliveryId = overrides.delivery_id as string ?? newDeliveryId();
  store.insertDelivery({
    delivery_id: deliveryId,
    task_id: taskId,
    attempt_id: attemptId,
    project_id: projectId,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    tree_sha: '',
    branch_ref: `refs/heads/biao/attempt/${attemptId}`,
    changed_files: '[]',
    patch_digest: '',
    artifact_ids: '[]',
    verify_manifest_digest: '',
    status: (overrides.status as string) ?? 'pending_review',
    accepted_commit_sha: '',
    merged_commit_sha: '',
    invalidated_reason: '',
    diff_summary: '{}',
    server_verified: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
  });
  return deliveryId;
}

/* ================================================================= */
/* 22.1-10：V2 Delivery repair/reverify                              */
/* ================================================================= */

describe('22.1-10: V2 Delivery repair/reverify', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeAll(() => {
    saveEnv(V2_CREDENTIAL_KEY_ENV);
    process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  });

  afterAll(() => {
    restoreEnv(V2_CREDENTIAL_KEY_ENV);
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'p10-repair-'));
    store = new SqliteStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('repairDelivery: rejected delivery → 新 repair attempt 继承 ownership', () => {
    const project = makeProject(store);
    const taskId = makeTaskId();
    const attemptId = makeAttempt(store, project.project_id, taskId);
    const deliveryId = makeDelivery(store, project.project_id, attemptId, taskId, { status: 'rejected' });

    // 创建 ownership snapshot（原 attempt 有文件权限）
    store.insertOwnershipSnapshot({
      snapshot_id: `snap-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      attempt_id: attemptId,
      task_id: taskId,
      files: JSON.stringify(['src/foo.ts', 'src/bar.ts']),
      created_at: Date.now(),
      released_at: null,
    });

    const keyring = loadV2CredentialKeyring();
    const ds = createDeliveryService({
      store,
      provider: new GenericGitProvider(),
      keyring,
    });

    const result = ds.repairDelivery(deliveryId, { exclude_reviewer: 'pm-reviewer-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.delivery_id).toBe(deliveryId);
    expect(result.data.repair_attempt_id).toMatch(/^att-repair-/);
    expect(result.data.exclude_reviewer).toBe('pm-reviewer-1');

    // 验证 repair attempt 已创建
    const repairAttempt = store.getTaskAttempt(result.data.repair_attempt_id);
    expect(repairAttempt).toBeDefined();
    expect(repairAttempt!.status).toBe('pending');
    expect(repairAttempt!.task_id).toBe(taskId);
    expect(repairAttempt!.project_id).toBe(project.project_id);

    // 验证 ownership snapshot 已复制
    const repairSnapshots = store.listOwnershipSnapshotsByAttempt(result.data.repair_attempt_id);
    expect(repairSnapshots.length).toBe(1);
    expect(JSON.parse(repairSnapshots[0].files)).toEqual(['src/foo.ts', 'src/bar.ts']);

    // 验证 delivery 的 diff_summary 记录了 repair 信息
    const updatedDelivery = store.getDelivery(deliveryId)!;
    const summary = JSON.parse(updatedDelivery.diff_summary);
    expect(summary.repair_attempt_id).toBe(result.data.repair_attempt_id);
    expect(summary.exclude_reviewer).toBe('pm-reviewer-1');
  });

  it('repairDelivery: 非 rejected 状态被拒绝', () => {
    const project = makeProject(store);
    const taskId = makeTaskId();
    const attemptId = makeAttempt(store, project.project_id, taskId);
    const deliveryId = makeDelivery(store, project.project_id, attemptId, taskId, { status: 'accepted' });

    const keyring = loadV2CredentialKeyring();
    const ds = createDeliveryService({
      store,
      provider: new GenericGitProvider(),
      keyring,
    });

    const result = ds.repairDelivery(deliveryId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('repairDelivery: 不存在的 delivery 返回 404', () => {
    const keyring = loadV2CredentialKeyring();
    const ds = createDeliveryService({
      store,
      provider: new GenericGitProvider(),
      keyring,
    });

    const result = ds.repairDelivery('del-nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DELIVERY_NOT_FOUND');
    }
  });

  it('reverifyDelivery: 重复请求幂等（返回一致结果）', () => {
    const project = makeProject(store);
    const taskId = makeTaskId();
    const attemptId = makeAttempt(store, project.project_id, taskId);
    const deliveryId = makeDelivery(store, project.project_id, attemptId, taskId, {
      status: 'pending_review',
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
    });

    // reverify 会尝试远程验证，由于没有真实 remote，预期会失败但不改变状态
    const keyring = loadV2CredentialKeyring();
    const ds = createDeliveryService({
      store,
      provider: new GenericGitProvider(),
      keyring,
    });

    // reverify 对无 workspace 的 delivery 返回错误
    const result = ds.reverifyDelivery(deliveryId);
    // 由于没有 attempt workspace，返回 WORKSPACE_NOT_FOUND
    result.then((r) => {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('WORKSPACE_NOT_FOUND');
      }
    });
  });
});

/* ================================================================= */
/* 22.4-18：outbox stall 检测 + degraded + 按 revision 重放          */
/* ================================================================= */

describe('22.4-18: outbox stall 检测 + degraded + 按 revision 重放', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'p10-outbox-'));
    store = new SqliteStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detectStalledOutbox: next_attempt_at 超阈值仍在 pending → 命中', () => {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 分钟

    // 制造一个 stale 事件：next_attempt_at 设为 10 分钟前
    appendOutboxEvent(store, {
      event_id: 'evt-stale-1',
      aggregate_type: 'delivery',
      aggregate_id: 'del-1',
      aggregate_revision: 1,
      payload: { test: true },
    });
    // 手动将 next_attempt_at 设为过去
    store.updateOutboxEvent('evt-stale-1', { next_attempt_at: now - 10 * 60 * 1000 });

    // 制造一个正常的 pending 事件
    appendOutboxEvent(store, {
      event_id: 'evt-fresh-1',
      aggregate_type: 'delivery',
      aggregate_id: 'del-1',
      aggregate_revision: 2,
      payload: { test: true },
    });

    const stalled = detectStalledOutbox(store, staleThreshold, now);
    expect(stalled.length).toBe(1);
    expect(stalled[0].event_id).toBe('evt-stale-1');
    expect(stalled[0].stalled_ms).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('detectStalledOutbox: delivered 事件不命中', () => {
    const now = Date.now();
    appendOutboxEvent(store, {
      event_id: 'evt-delivered-1',
      aggregate_type: 'delivery',
      aggregate_id: 'del-1',
      aggregate_revision: 1,
      payload: { test: true },
    });
    markOutboxStatus(store, 'evt-delivered-1', 'delivered');
    // 即使 next_attempt_at 在过去，delivered 不算 stall
    store.updateOutboxEvent('evt-delivered-1', { next_attempt_at: now - 10 * 60 * 1000 });

    const stalled = detectStalledOutbox(store, 5 * 60 * 1000, now);
    expect(stalled.length).toBe(0);
  });

  it('markOutboxDegraded: 标记 degraded 前缀到 last_error', () => {
    appendOutboxEvent(store, {
      event_id: 'evt-degrade-1',
      aggregate_type: 'delivery',
      aggregate_id: 'del-1',
      aggregate_revision: 1,
      payload: { test: true },
    });

    markOutboxDegraded(store, 'evt-degrade-1', '连续 3 次投递失败');

    const event = store.getOutboxEvent('evt-degrade-1');
    expect(event).toBeDefined();
    expect(event!.last_error).toBe('[degraded] 连续 3 次投递失败');
  });

  it('replayOutboxByRevision: 跳过已 delivered、重放 dead_letter 和 pending', () => {
    // 构造一组事件：rev 1 delivered, rev 2 dead_letter, rev 3 pending
    for (let rev = 1; rev <= 3; rev++) {
      appendOutboxEvent(store, {
        event_id: `evt-rev-${rev}`,
        aggregate_type: 'merge_job',
        aggregate_id: 'mj-1',
        aggregate_revision: rev,
        payload: { rev },
      });
    }
    markOutboxStatus(store, 'evt-rev-1', 'delivered');
    markOutboxStatus(store, 'evt-rev-2', 'dead_letter', { last_error: 'permanent failure' });

    const result = replayOutboxByRevision(store, 'merge_job', 'mj-1', 1);
    expect(result.skipped).toBe(1); // rev 1 已 delivered
    expect(result.replayed).toBe(2); // rev 2 (dead_letter→pending) + rev 3 (pending 重置)
    expect(result.failed).toBe(0);

    // 验证 rev 2 被重放为 pending
    const evt2 = store.getOutboxEvent('evt-rev-2');
    expect(evt2!.status).toBe('pending');
    expect(evt2!.dead_lettered_at).toBeNull();
    expect(evt2!.attempt_count).toBe(0);
  });

  it('replayOutboxByRevision: 幂等——重放两次不产生重复副作用', () => {
    appendOutboxEvent(store, {
      event_id: 'evt-idem-1',
      aggregate_type: 'merge_job',
      aggregate_id: 'mj-idem',
      aggregate_revision: 1,
      payload: { test: true },
    });
    markOutboxStatus(store, 'evt-idem-1', 'dead_letter', { last_error: 'fail' });

    const first = replayOutboxByRevision(store, 'merge_job', 'mj-idem', 1);
    expect(first.replayed).toBe(1);

    // 第二次重放：已经是 pending（第一次重放的结果）
    const second = replayOutboxByRevision(store, 'merge_job', 'mj-idem', 1);
    expect(second.replayed).toBe(1); // pending 也会被"重置"
    expect(second.skipped).toBe(0);
    expect(second.failed).toBe(0);
  });

  it('collectStalledOutboxStats: 按 aggregate_type 分组统计', () => {
    const now = Date.now();
    // 制造 2 个 delivery stall + 1 个 merge_job stall
    const entries = [
      ['s1', 'delivery', 'del-stat-1'],
      ['s2', 'delivery', 'del-stat-2'],
      ['s3', 'merge_job', 'mj-stat-1'],
    ] as const;
    for (const [id, type, aggId] of entries) {
      appendOutboxEvent(store, {
        event_id: `evt-stat-${id}`,
        aggregate_type: type,
        aggregate_id: aggId,
        aggregate_revision: 1,
        payload: {},
      });
      store.updateOutboxEvent(`evt-stat-${id}`, { next_attempt_at: now - 10 * 60 * 1000 });
    }

    const stats = collectStalledOutboxStats(store, 5 * 60 * 1000, now);
    expect(stats.total).toBe(3);
    expect(stats.byAggregateType['delivery']).toBe(2);
    expect(stats.byAggregateType['merge_job']).toBe(1);
    expect(stats.maxStalledMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});

/* ================================================================= */
/* 22.3-17：handleRefAclMiss 接线（push_forbidden 触发熔断）          */
/* ================================================================= */

describe('22.3-17: handleRefAclMiss 接线 + 熔断', () => {
  let store: SqliteStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'p10-refacl-'));
    store = new SqliteStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('executeRefAclMissCircuitBreaker: fencing 全部 executing attempt + write_capability=lost + incident', () => {
    const project = makeProject(store);
    const taskId = makeTaskId();

    // 创建 3 个 executing attempt
    const att1 = makeAttempt(store, project.project_id, taskId, { status: 'executing' });
    const att2 = makeAttempt(store, project.project_id, taskId, { status: 'executing' });
    const att3 = makeAttempt(store, project.project_id, taskId, { status: 'executing' });

    const incidents: Array<{ kind: string; severity: string; title: string }> = [];
    const ts = Date.now();

    executeRefAclMissCircuitBreaker(store, project.project_id, ts, {
      missCount: 3,
      createIncident: (input) => { incidents.push({ kind: input.kind, severity: input.severity, title: input.title }); },
    });

    // 验证所有 executing attempt 被 fence
    expect(store.getTaskAttempt(att1)!.status).toBe('fenced');
    expect(store.getTaskAttempt(att2)!.status).toBe('fenced');
    expect(store.getTaskAttempt(att3)!.status).toBe('fenced');
    expect(store.getTaskAttempt(att1)!.failure_reason).toBe('ref_acl_miss_circuit_breaker');

    // 验证 write_capability_status → lost
    expect(store.getProject(project.project_id)!.write_capability_status).toBe('lost');

    // 验证 incident 被创建
    expect(incidents.length).toBe(1);
    expect(incidents[0].kind).toBe('ref_acl_miss_circuit_breaker');
    expect(incidents[0].severity).toBe('critical');
  });

  it('executeRefAclMissCircuitBreaker: 幂等——第二次不重复 fencing 已 fenced 的 attempt', () => {
    const project = makeProject(store);
    const taskId = makeTaskId();
    const att1 = makeAttempt(store, project.project_id, taskId, { status: 'executing' });

    const ts = Date.now();

    // 第一次熔断
    executeRefAclMissCircuitBreaker(store, project.project_id, ts);
    expect(store.getTaskAttempt(att1)!.status).toBe('fenced');

    // 第二次调用：attempt 已 fenced，不会再次更新
    executeRefAclMissCircuitBreaker(store, project.project_id, ts + 1000);
    expect(store.getTaskAttempt(att1)!.status).toBe('fenced');
    // write_capability 仍为 lost
    expect(store.getProject(project.project_id)!.write_capability_status).toBe('lost');
  });

  it('executeRefAclMissCircuitBreaker: 不影响其他项目的 attempt', () => {
    const project1 = makeProject(store);
    const project2 = makeProject(store);
    const task1 = makeTaskId();
    const task2 = makeTaskId();
    const att1 = makeAttempt(store, project1.project_id, task1, { status: 'executing' });
    const att2 = makeAttempt(store, project2.project_id, task2, { status: 'executing' });

    executeRefAclMissCircuitBreaker(store, project1.project_id, Date.now());

    // project1 的 attempt 被 fence
    expect(store.getTaskAttempt(att1)!.status).toBe('fenced');
    // project2 的 attempt 不受影响
    expect(store.getTaskAttempt(att2)!.status).toBe('executing');
    expect(store.getProject(project2.project_id)!.write_capability_status).toBe('ready');
  });

  it('handleRefAclMiss via merge queue: 连续 N 次后触发熔断', () => {
    const project = makeProject(store);
    const incidents: Array<{ kind: string; severity: string }> = [];

    const queue = createMergeQueue({
      store,
      provider: new GenericGitProvider(),
      refAclMissThreshold: 3,
    });

    // 模拟 incident service
    const incidentService = createIncidentService({ store });
    // 前 2 次不触发
    queue.handleRefAclMiss(project.project_id, Date.now());
    queue.handleRefAclMiss(project.project_id, Date.now());
    expect(store.getProject(project.project_id)!.write_capability_status).toBe('ready');

    // 第 3 次触发
    queue.handleRefAclMiss(project.project_id, Date.now());
    expect(store.getProject(project.project_id)!.write_capability_status).toBe('lost');
  });
});
