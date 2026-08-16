/**
 * Phase 9 失败优先测试（车道 C）：模式切换状态机与恢复决策
 *
 * 对应审计 docs/distributed-multi-node-acceptance-audit.md：
 * - 22.3-20 + 22.4-04：24h deadline 常量、step 推进器（先落库再执行、失败可
 *   重试、幂等重入）、kill 模拟重启续跑、超 24h → expired + RecoveryIsolation；
 * - 22.3-18：full→read-only 写 lineage 全收口（Delivery/MergeJob/Candidate/
 *   写任务/下游只读任务），未收口 → 停留 step 并报告清单，收口完成才原子切换；
 * - 22.3-21：恢复 full 离线 Node 不阻塞，binding suspended，回归 resync 后
 *   才恢复 eligible；
 * - 22.4-26/27：recovery decision 签名/15min TTL/单调偏移防护/一次性消费；
 * - 22.4-29：takeover 三崩溃点（决策落库后/attempt fencing 后/新 attempt
 *   创建后）重入收敛，不产生双 attempt；
 * - 22.4-31：batch 逐项 revision 与 error；
 * - 22.4-06：RecoveryIsolation 三步分权（isolator/reviewer≠isolator/resolve）；
 * - 22.4-34：revalidate-plans canary fail-closed。
 *
 * 服务级用例直接驱动 store + 模块函数；HTTP 组复用 p6 真实服务装配
 * （env save/restore 纪律）。
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow, NodeRow, NodeProjectBindingRow } from '../../src/types/v2-identity.js';
import type { DeliveryRow } from '../../src/types/v2-artifact.js';
import type { MergeJobRow } from '../../src/types/v2-merge.js';
import {
  MODE_TRANSITION_DEADLINE_MS,
} from '../../src/types/v2-infra.js';
import {
  BLOCKED_REASON_DEPENDENCY,
  BLOCKED_REASON_WRITE,
  DRAIN_CHECKLIST_TEMPLATE,
  DRAINING_STEP_SEQUENCE,
  VALIDATING_STEP_SEQUENCE,
  advanceModeTransition,
  createProjectService,
  resyncNodeProjectBinding,
  retryModeTransition,
  resumeInterruptedModeTransitions,
  runModeTransitionAuto,
} from '../../src/server/v2/project-service.js';
import {
  RECONCILE_SERVICE_ACTOR,
  RECOVERY_DECISION_SKEW_TOLERANCE_MS,
  RECOVERY_DECISION_TTL_MS,
  consumeRecoveryDecision,
  createRecoveryIsolationRecord,
  resolveRecoveryIsolationRecord,
  reviewRecoveryIsolationRecord,
  runBatchRecoveryActions,
  runControlPlaneDiscard,
  runControlPlaneTakeover,
  signRecoveryDecision,
  verifyRecoveryDecisionEnvelope,
} from '../../src/server/v2/recovery-decision.js';
import { createHttpServer } from '../../src/server/http.js';
import { V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';

const tempDirs: string[] = [];
const openedStores: SqliteStore[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `p9r-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeStore(): SqliteStore {
  const store = new SqliteStore(':memory:');
  openedStores.push(store);
  return store;
}

function makeProject(store: SqliteStore, overrides: Partial<ProjectRow> = {}): ProjectRow {
  const now = Date.now();
  const row: ProjectRow = {
    project_id: `proj-${randomBytes(4).toString('hex')}`,
    display_name: 'p9r 项目',
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
    revision: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  store.insertProject(row);
  return row;
}

function makeNode(store: SqliteStore, nodeId: string, status: NodeRow['status']): NodeRow {
  const now = Date.now();
  const row: NodeRow = {
    node_id: nodeId,
    display_name: nodeId,
    os: 'darwin',
    arch: 'arm64',
    node_version: '0.0.0',
    protocol_version: '1',
    status,
    capabilities: '[]',
    labels: '[]',
    max_concurrent_tasks: 2,
    memory_mb: null,
    disk_free_mb: null,
    last_seen_at: now,
    credential_generation: 1,
    clock_skew_ms: 0,
    server_cert_not_after: '',
    trust_anchor_generation: 1,
    signing_key_generation: 1,
    accepted_control_plane_signing_key_generations: '[]',
    terminal_state_at: null,
    terminal_state_reason: '',
    ttl_expires_at: null,
    created_at: now,
    updated_at: now,
  };
  store.insertNode(row);
  return row;
}

function makeBinding(
  store: SqliteStore,
  nodeId: string,
  projectId: string,
  overrides: Partial<NodeProjectBindingRow> = {},
): NodeProjectBindingRow {
  const now = Date.now();
  const row: NodeProjectBindingRow = {
    binding_id: `bind-${randomBytes(4).toString('hex')}`,
    node_id: nodeId,
    project_id: projectId,
    local_cache_root: `/tmp/biao-${nodeId}`,
    checkout_mode: 'clone-per-attempt',
    repository_fingerprint: '',
    last_fetch_sha: '',
    health: 'ready',
    last_checked_at: now,
    authorization_status: 'authorized',
    authorized_by: 'owner',
    authorized_at: now,
    authorization_revision: 1,
    applied_policy_revision: 1,
    write_credential_status: 'eligible',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  store.insertNodeProjectBinding(row);
  return row;
}

function makeDelivery(store: SqliteStore, projectId: string, status: DeliveryRow['status']): DeliveryRow {
  const now = Date.now();
  const row: DeliveryRow = {
    delivery_id: `del-${randomBytes(4).toString('hex')}`,
    task_id: `task-${randomBytes(3).toString('hex')}`,
    attempt_id: `att-${randomBytes(3).toString('hex')}`,
    project_id: projectId,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    tree_sha: 'c'.repeat(40),
    branch_ref: `refs/heads/biao/attempt/${randomBytes(3).toString('hex')}`,
    changed_files: '[]',
    patch_digest: '',
    artifact_ids: '[]',
    verify_manifest_digest: '',
    status,
    accepted_commit_sha: '',
    merged_commit_sha: '',
    invalidated_reason: '',
    created_at: now,
    updated_at: now,
  };
  store.insertDelivery(row);
  return row;
}

function makeMergeJob(store: SqliteStore, projectId: string, deliveryId: string, status: MergeJobRow['status']): MergeJobRow {
  const now = Date.now();
  const row: MergeJobRow = {
    merge_job_id: `mj-${randomBytes(4).toString('hex')}`,
    delivery_id: deliveryId,
    project_id: projectId,
    expected_target_sha: 'd'.repeat(40),
    source_sha: 'e'.repeat(40),
    strategy: 'merge-ff',
    status,
    final_sha: '',
    cancel_reason: '',
    conflict_files: '[]',
    error_message: '',
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  store.insertMergeJob(row);
  return row;
}

function makePlan(
  store: SqliteStore,
  planId: string,
  taskCount: number,
  createdAt: string,
  projectId?: string,
): void {
  store.upsertPlan({
    plan_id: planId,
    title: planId,
    status: 'submitted',
    project_path: '/tmp/p9r',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '[]',
    task_count: taskCount,
    created_at: createdAt,
    submitted_at: createdAt,
    ...(projectId ? { project_id: projectId } : {}),
  });
}

function seedTask(
  store: SqliteStore,
  taskId: string,
  projectId: string,
  overrides: {
    status?: string;
    acceptance_for?: string;
    depends_on?: string[];
    plan_id?: string;
    active_attempt_id?: string;
  } = {},
): void {
  store.upsertTask({
    task_id: taskId,
    plan_id: overrides.plan_id ?? 'plan-p9r',
    title: taskId,
    type: 'implementation',
    phase: '1',
    status: overrides.status ?? 'pending',
    priority: 5,
    assignee: 'auto',
    ownership_files: '[]',
    ownership_modules: '',
    depends_on: JSON.stringify(overrides.depends_on ?? []),
    timeout_seconds: 3600,
    max_retries: 2,
    model_override: '',
    acceptance_for: overrides.acceptance_for ?? '',
    verify: '[]',
    claimed_by: '',
    claimed_at: '',
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
    active_attempt_id: overrides.active_attempt_id ?? '',
  });
  // upsertTask 的 SQL 不含 V2 扩展列（004），project 关联与 attempt 指针按
  // updateTaskFields 回填（与控制面 takeover/释放路径同口径）
  store.updateTaskFields(taskId, {
    project_id: projectId,
    active_attempt_id: overrides.active_attempt_id ?? '',
  });
}

function makeAttempt(
  store: SqliteStore,
  attemptId: string,
  taskId: string,
  projectId: string,
  overrides: { status?: string; lease_expires_at?: number; generation?: number } = {},
): void {
  const now = Date.now();
  store.insertTaskAttempt({
    attempt_id: attemptId,
    task_id: taskId,
    project_id: projectId,
    node_id: 'node-p9r',
    session_id: 'sess-p9r',
    attempt_generation: overrides.generation ?? 1,
    status: overrides.status ?? 'executing',
    lease_expires_at: overrides.lease_expires_at ?? now - 1000,
    lease_duration_ms: 60000,
    token_jti: `jti-${attemptId}`,
    artifact_ids: '[]',
    started_at: now - 60000,
    updated_at: now - 60000,
    completed_at: null,
    failure_reason: '',
  });
}

function makeCandidate(
  store: SqliteStore,
  candidateId: string,
  attemptId: string,
  projectId: string,
): void {
  store.insertOrphanRecoveryCandidate({
    candidate_id: candidateId,
    attempt_id: attemptId,
    project_id: projectId,
    marker_ref: 'refs/biao/attempt-markers/x',
    branch_ref: 'refs/heads/biao/attempt/x',
    head_sha: 'f'.repeat(40),
    bundle_manifest_digest: 'digest-1',
    recovery_path: 'node-driven',
    status: 'pending',
    decision: 'pending',
    takeover_reason: '',
    takeover_at: null,
    node_ack_status: 'not-required',
    revision: 0,
    decided_by: '',
    decided_at: null,
    resolved_at: null,
    resolution_evidence_digest: '',
  });
}

const META = {
  idempotency_key: 'ik-p9r',
  correlation_id: 'corr-p9r',
  actor: { actor_kind: 'human_owner', actor_id: 'owner' } as const,
};

const KEYRING = [{ key_version: 7, material: Buffer.alloc(32, 9) }];

async function applyTransition(store: SqliteStore, projectId: string, toMode: 'full' | 'read_only') {
  const service = createProjectService(store);
  return service.applyModeTransition(projectId, { to_mode: toMode, reason: 'p9r' }, META);
}

/** 推进到终态，返回逐次 advance 的 (action, executed_step) 序列。 */
function driveToSettled(store: SqliteStore, projectId: string, transitionId: string) {
  const trace: Array<{ action: string; executed_step: string | null }> = [];
  for (let i = 0; i < 10; i += 1) {
    const r = advanceModeTransition(store, projectId, transitionId);
    expect(r.ok).toBe(true);
    const d = r.data!;
    trace.push({ action: d.action, executed_step: d.executed_step });
    if (['completed', 'failed', 'expired', 'waiting'].includes(d.action)) return { final: d, trace };
  }
  throw new Error('advance 未在步数上限内收敛');
}

afterAll(() => {
  for (const store of openedStores) {
    try { store.close(); } catch { /* 已关闭 */ }
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ================================================================ */
/* 22.3-20 + 22.4-04：24h deadline + step 推进器 + 重启续跑 + 超期    */
/* ================================================================ */

describe('22.3-20 deadline 与 step 序列（首要项）', () => {
  it('deadline 常量 = 24 小时（§12.1.1 矩阵原文），不再是 30 分钟', async () => {
    expect(MODE_TRANSITION_DEADLINE_MS).toBe(24 * 60 * 60 * 1000);
    expect(MODE_TRANSITION_DEADLINE_MS).not.toBe(30 * 60 * 1000);

    const store = makeStore();
    const project = makeProject(store);
    const t = await applyTransition(store, project.project_id, 'read_only');
    expect(t.ok).toBe(true);
    const row = store.getProjectModeTransition(t.data!.transition_id)!;
    // 落库的 deadline 严格等于 started_at + 24h（出处常量，非内联魔数）
    expect(row.deadline_at - row.started_at).toBe(MODE_TRANSITION_DEADLINE_MS);
  });

  it('read-only→full step 序列为 §4.1 合法序，逐步推进先落库再执行', async () => {
    const store = makeStore();
    const project = makeProject(store, { execution_mode: 'read-only-acceptance', write_capability_status: 'disabled', repository_fingerprint: 'fp-ok' });
    const t = await applyTransition(store, project.project_id, 'full');
    const transitionId = t.data!.transition_id;
    // 创建即执行 pause：durable step 已推进到第二步
    expect(store.getProjectModeTransition(transitionId)!.step).toBe(VALIDATING_STEP_SEQUENCE[1]);
    expect(store.getProject(project.project_id)!.status).toBe('paused');
    expect(store.getProject(project.project_id)!.mode_transition_step).toBe(VALIDATING_STEP_SEQUENCE[1]);

    const { final, trace } = driveToSettled(store, project.project_id, transitionId);
    // 执行序 = 序列去掉首步（apply 时已执行）到 commit-mode
    const executed = trace.map((x) => x.executed_step).filter(Boolean);
    expect(executed).toEqual(['validate-capability', 'reconcile', 'refresh-bindings', 'revalidate-plans', 'commit-mode']);
    expect(final.action).toBe('completed');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('full');
    // V2ProjectModeTransition 投影：全部 step done、终态 completed
    expect(final.transition.steps.map((s) => s.status)).toEqual(Array.from({ length: 6 }, () => 'done'));
    expect(final.transition.status).toBe('completed');
  });

  it('重启续跑（kill 模拟：同库重开）从 durable step 继续，副作用不重复', async () => {
    // 文件库：store.close() = 进程 kill；重开同一路径 = 控制面重启
    const dir = tempDir('restart');
    const dbPath = join(dir, 'biao.sqlite');
    const storeA = new SqliteStore(dbPath);

    const project = makeProject(storeA);
    const serviceA = createProjectService(storeA);
    const t = await serviceA.applyModeTransition(project.project_id, { to_mode: 'read_only', reason: 'kill 模拟' }, META);
    const transitionId = t.data!.transition_id;
    // 推进两步后 kill（fence-attempts + invalidate-lineage 已 durable）
    advanceModeTransition(storeA, project.project_id, transitionId);
    advanceModeTransition(storeA, project.project_id, transitionId);
    const stepAtKill = storeA.getProjectModeTransition(transitionId)!.step;
    expect(stepAtKill).toBe('block-dependents');
    const deliveriesAtKill = storeA.listDeliveriesByProject(project.project_id).length;
    storeA.close();

    // 重启：新实例 + 启动扫描续跑
    const storeB = new SqliteStore(dbPath);
    openedStores.push(storeB);
    expect(storeB.getProjectModeTransition(transitionId)!.step).toBe('block-dependents');
    const resumed = resumeInterruptedModeTransitions(storeB);
    expect(resumed.expired).toEqual([]);
    expect(resumed.resumed.map((r) => r.transition_id)).toEqual([transitionId]);

    const { final, trace } = driveToSettled(storeB, project.project_id, transitionId);
    expect(trace.map((x) => x.executed_step)).toEqual(['reconcile', 'commit-mode']);
    expect(final.action).toBe('completed');
    expect(storeB.getProject(project.project_id)!.execution_mode).toBe('read-only-acceptance');
    expect(storeB.getProject(project.project_id)!.revision).toBe(2); // commit-mode 恰好 +1，无重复副作用

    // 完成后重入推进：no-op，不重复推进/重复副作用
    const noop = advanceModeTransition(storeB, project.project_id, transitionId);
    expect(noop.data!.action).toBe('no-op');
    expect(storeB.getProject(project.project_id)!.revision).toBe(2);
    expect(deliveriesAtKill).toBe(0);
  });

  it('超 24h deadline → expired + RecoveryIsolation 留证 + 不可重试（22.4-05 衔接）', async () => {
    const store = makeStore();
    const project = makeProject(store);
    const t = await applyTransition(store, project.project_id, 'read_only');
    const transitionId = t.data!.transition_id;
    // 模拟时间越界：deadline 直接落回过去
    store.updateProjectModeTransition(transitionId, { deadline_at: Date.now() - 1 });

    const r = advanceModeTransition(store, project.project_id, transitionId);
    expect(r.data!.action).toBe('expired');
    expect(r.data!.error!.code).toBe('DEADLINE_EXCEEDED');

    const row = store.getProjectModeTransition(transitionId)!;
    expect(row.status).toBe('failed');
    expect(row.expired_at).not.toBeNull();
    expect(row.last_error).toContain('DEADLINE_EXCEEDED');

    // 隔离留证：durable RecoveryIsolation（object_type=mode-transition）
    const isolations = store.listRecoveryIsolations(project.project_id)
      .filter((i) => i.object_type === 'mode-transition' && i.object_id === transitionId);
    expect(isolations).toHaveLength(1);
    expect(isolations[0]!.status).toBe('isolated');
    expect(isolations[0]!.transition_id).toBe(transitionId);

    // 项目保持 paused，未半切换
    const p = store.getProject(project.project_id)!;
    expect(p.execution_mode).toBe('full');
    expect(p.status).toBe('paused');
    expect(p.mode_transition_id).toBe(transitionId);

    // 超期 transition 不可 retry（须先三步分权关闭隔离）
    const retry = retryModeTransition(store, transitionId);
    expect(retry.ok).toBe(false);
    expect(retry.error!.code).toBe('TRANSITION_EXPIRED');

    // API 投影 status=expired
    const service = createProjectService(store);
    const view = await service.getModeTransition(project.project_id, transitionId, META);
    expect(view.data!.status).toBe('expired');
  });

  it('步骤失败置 failed 可重试：从 durable step 幂等重入（22.4-04）', async () => {
    const store = makeStore();
    // 未安装 ref ACL（fingerprint 空）→ validate-capability 必然失败
    const project = makeProject(store, { execution_mode: 'read-only-acceptance', write_capability_status: 'disabled' });
    const t = await applyTransition(store, project.project_id, 'full');
    const transitionId = t.data!.transition_id;

    const { final } = driveToSettled(store, project.project_id, transitionId);
    expect(final.action).toBe('failed');
    expect(final.error!.code).toBe('CAPABILITY_VALIDATION_FAILED');
    expect(store.getProjectModeTransition(transitionId)!.status).toBe('failed');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('read-only-acceptance');

    // Owner 修复 ACL 后 retry：从 validate-capability（而非 pause）续跑
    store.updateProject(project.project_id, { repository_fingerprint: 'fp-fixed' });
    const retry = retryModeTransition(store, transitionId);
    expect(retry.ok).toBe(true);
    const { final: after, trace } = driveToSettled(store, project.project_id, transitionId);
    expect(trace[0]!.executed_step).toBe('validate-capability');
    expect(after.action).toBe('completed');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('full');
  });

  it('同 project 已有 running transition 时拒绝再创建（§20.3 单 flight）', async () => {
    const store = makeStore();
    const project = makeProject(store);
    const first = await applyTransition(store, project.project_id, 'read_only');
    expect(first.ok).toBe(true);
    const second = await applyTransition(store, project.project_id, 'read_only');
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe('TRANSITION_IN_PROGRESS');
  });
});

/* ================================================================ */
/* 22.3-18：full→read-only 写 lineage 全收口                          */
/* ================================================================ */

describe('22.3-18 写 lineage 全收口', () => {
  function seedDrainingWorld(store: SqliteStore) {
    const project = makeProject(store);
    makePlan(store, 'plan-p9r', 4, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    // 写 lineage：proposed / accepted / merging Delivery + queued MergeJob
    const proposed = makeDelivery(store, project.project_id, 'proposed');
    const accepted = makeDelivery(store, project.project_id, 'accepted');
    const merging = makeDelivery(store, project.project_id, 'merging');
    const job = makeMergeJob(store, project.project_id, merging.delivery_id, 'queued');
    // 运行中写 attempt + 任务（写任务 + 验收任务 + 下游只读依赖任务）
    seedTask(store, 'task-write', project.project_id, { status: 'in_progress', active_attempt_id: 'att-live' });
    makeAttempt(store, 'att-live', 'task-write', project.project_id);
    seedTask(store, 'task-accept', project.project_id, { status: 'pending', acceptance_for: 'task-write' });
    seedTask(store, 'task-downstream', project.project_id, { status: 'pending', depends_on: ['task-write'] });
    // pending recovery candidate（reconcile step 的等待点）
    makeCandidate(store, 'cand-drain', 'att-live', project.project_id);
    return { project, proposed, accepted, merging, job };
  }

  it('收口清单模板覆盖 §12.1.1 六类对象', () => {
    const kinds = DRAIN_CHECKLIST_TEMPLATE.map((item) => item.kind);
    expect(kinds).toEqual([
      'write-attempt', 'delivery', 'merge-job', 'recovery-candidate', 'write-task', 'blocked-dependent-task',
    ]);
  });

  it('逐项 pause/fence/cancel/invalidate/block；未收口停在 reconcile 并报告清单', async () => {
    const store = makeStore();
    const world = seedDrainingWorld(store);
    const projectId = world.project.project_id;
    const t = await applyTransition(store, projectId, 'read_only');
    const transitionId = t.data!.transition_id;

    // fence-attempts：运行中写 attempt → pending_recovery
    let r = advanceModeTransition(store, projectId, transitionId);
    expect(r.data!.executed_step).toBe('fence-attempts');
    expect(store.getTaskAttempt('att-live')!.status).toBe('pending_recovery');
    expect(store.getTaskAttempt('att-live')!.failure_reason).toBe('mode-transition-fencing');

    // invalidate-lineage：三类 Delivery 原子 invalidated + BranchCleanup 幂等落档
    r = advanceModeTransition(store, projectId, transitionId);
    expect(r.data!.executed_step).toBe('invalidate-lineage');
    for (const d of [world.proposed, world.accepted, world.merging]) {
      const row = store.getDelivery(d.delivery_id)!;
      expect(row.status).toBe('invalidated');
      expect(row.invalidated_reason).toBe('remote-ref-acl-lost');
    }
    const cleanups = store.listBranchCleanups(projectId);
    expect(cleanups).toHaveLength(3);
    expect(cleanups.every((c) => c.reason === 'mode_transition')).toBe(true);
    expect(store.getMergeJob(world.job.merge_job_id)!.status).toBe('cancelled');
    expect(store.getMergeJob(world.job.merge_job_id)!.cancel_reason).toBe('remote-ref-acl-lost');

    // block-dependents：写任务/验收任务/下游只读任务写 blocked_reason 并移出 pending
    r = advanceModeTransition(store, projectId, transitionId);
    expect(r.data!.executed_step).toBe('block-dependents');
    const write = store.getTask('task-write')!;
    const accept = store.getTask('task-accept')!;
    const downstream = store.getTask('task-downstream')!;
    expect(write.status).toBe('blocked');
    expect(write.blocked_reason).toBe(BLOCKED_REASON_WRITE);
    expect(accept.blocked_reason).toBe(BLOCKED_REASON_DEPENDENCY);
    expect(downstream.blocked_reason).toBe(BLOCKED_REASON_DEPENDENCY);
    expect([write, accept, downstream].every((x) => x.mode_transition_id === transitionId)).toBe(true);

    // reconcile：pending candidate 未裁决 → waiting + 未收口清单，且未切模式
    r = advanceModeTransition(store, projectId, transitionId);
    expect(r.data!.action).toBe('waiting');
    expect(r.data!.executed_step).toBe('reconcile');
    expect(r.data!.pending.map((p) => `${p.kind}:${p.id}`)).toEqual(['recovery-candidate:cand-drain']);
    expect(store.getProject(projectId)!.execution_mode).toBe('full'); // 未收口不切换
    expect(store.getProjectModeTransition(transitionId)!.status).toBe('running');
    expect(store.getProjectModeTransition(transitionId)!.last_error).toContain('WAITING@reconcile');

    // 裁决 candidate 后收口完成 → 原子切换 read-only
    const discard = runControlPlaneDiscard(store, 'cand-drain', { reason: 'audit-only', decided_by: 'op' }, KEYRING);
    expect(discard.ok).toBe(true);
    const { final } = driveToSettled(store, projectId, transitionId);
    expect(final.action).toBe('completed');
    const p = store.getProject(projectId)!;
    expect(p.execution_mode).toBe('read-only-acceptance');
    expect(p.write_capability_status).toBe('disabled');
    expect(p.status).toBe('active');
    expect(p.mode_transition_id).toBe('');
    expect(p.mode_transition).toBeNull();
  });

  it('收口后重复推进不重复 invalidate/不重复 BranchCleanup（幂等）', async () => {
    const store = makeStore();
    const world = seedDrainingWorld(store);
    runControlPlaneDiscard(store, 'cand-drain', { reason: 'audit-only', decided_by: 'op' }, KEYRING);
    const projectId = world.project.project_id;
    const t = await applyTransition(store, projectId, 'read_only');
    const transitionId = t.data!.transition_id;
    const { final } = driveToSettled(store, projectId, transitionId);
    expect(final.action).toBe('completed');
    expect(store.listBranchCleanups(projectId)).toHaveLength(3);
    expect(store.getProject(projectId)!.revision).toBe(2);

    // 完成后再次 advance：no-op，Delivery/BranchCleanup 计数不变
    advanceModeTransition(store, projectId, transitionId);
    expect(store.listBranchCleanups(projectId)).toHaveLength(3);
    expect(store.getProject(projectId)!.revision).toBe(2);
  });
});

/* ================================================================ */
/* 22.3-21：恢复 full 离线 Node 不阻塞 + binding 重同步               */
/* ================================================================ */

describe('22.3-21 离线 Node 不阻塞恢复', () => {
  it('离线 Node binding suspended 不阻塞切换；回归 resync 后才恢复 eligible', async () => {
    const store = makeStore();
    const project = makeProject(store, {
      execution_mode: 'read-only-acceptance',
      write_capability_status: 'disabled',
      repository_fingerprint: 'fp-ok',
    });
    makeNode(store, 'node-online', 'online');
    makeNode(store, 'node-gone', 'offline');
    const bindingOnline = makeBinding(store, 'node-online', project.project_id);
    const bindingGone = makeBinding(store, 'node-gone', project.project_id);
    // 一条有效 plan（revalidate-plans 可通过）
    makePlan(store, 'plan-r', 1, '2026-01-01T00:00:00.000Z');
    seedTask(store, 'task-r', project.project_id, { plan_id: 'plan-r' });

    const t = await applyTransition(store, project.project_id, 'full');
    const { final } = driveToSettled(store, project.project_id, t.data!.transition_id);
    // 切换条件不含「全部 Node 在线」：离线 Node 存在仍完成
    expect(final.action).toBe('completed');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('full');

    const online = store.getNodeProjectBinding('node-online', project.project_id)!;
    const gone = store.getNodeProjectBinding('node-gone', project.project_id)!;
    const revisionAfter = store.getProject(project.project_id)!.revision;
    // 在线类 Node：新 policy revision 已同步 + eligible
    expect(online.write_credential_status).toBe('eligible');
    expect(online.applied_policy_revision).toBe(revisionAfter - 1); // refresh +1、commit +1，同步发生在 refresh 时
    // 离线 Node：binding 挂起，policy revision 停在旧值（无有效 push credential）
    expect(gone.write_credential_status).toBe('suspended');
    expect(gone.applied_policy_revision).toBe(bindingGone.applied_policy_revision);

    // 未重新上线不得 resync（旧 credential 失效状态保持）
    const early = resyncNodeProjectBinding(store, 'node-gone', project.project_id);
    expect(early.ok).toBe(false);
    expect(early.error!.code).toBe('NODE_NOT_ONLINE');

    // 回归上线 → resync 对齐当前 revision 才恢复 eligible
    store.updateNode('node-gone', { status: 'online' });
    const resync = resyncNodeProjectBinding(store, 'node-gone', project.project_id);
    expect(resync.ok).toBe(true);
    expect(resync.data!.write_credential_status).toBe('eligible');
    expect(resync.data!.applied_policy_revision).toBe(revisionAfter);
    expect(store.getNodeProjectBinding('node-gone', project.project_id)!.write_credential_status).toBe('eligible');
  });

  it('隔离的 candidate 不阻塞恢复 reconcile（从正常 reconcile 排除，22.4-05）', async () => {
    const store = makeStore();
    const project = makeProject(store, {
      execution_mode: 'read-only-acceptance',
      write_capability_status: 'disabled',
      repository_fingerprint: 'fp-ok',
    });
    makePlan(store, 'plan-p9r', 1, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    seedTask(store, 'task-x', project.project_id);
    makeAttempt(store, 'att-x', 'task-x', project.project_id);
    makeCandidate(store, 'cand-iso', 'att-x', project.project_id);
    // 直接把 candidate 置为 isolated（durable 隔离留证后）
    store.updateOrphanRecoveryCandidate('cand-iso', { status: 'isolated' });

    const t = await applyTransition(store, project.project_id, 'full');
    const { final, trace } = driveToSettled(store, project.project_id, t.data!.transition_id);
    const reconcile = trace.find((x) => x.executed_step === 'reconcile');
    expect(reconcile).toBeDefined();
    expect(final.action).toBe('completed');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('full');
  });
});

/* ================================================================ */
/* 22.4-26/27：recovery decision 签名 / TTL / 单调偏移 / 一次性消费   */
/* ================================================================ */

describe('22.4-26/27 决策信封校验', () => {
  it('TTL 常量 = 15 分钟；签发信封含 candidate revision + decided_by + expires_at', () => {
    expect(RECOVERY_DECISION_TTL_MS).toBe(15 * 60 * 1000);
    const signed = signRecoveryDecision({
      candidate_id: 'cand-s', candidate_revision: 3, attempt_id: 'att-s',
      decision: 'upload-and-reverify', decided_by: 'op-1',
    }, KEYRING);
    expect(signed.ok).toBe(true);
    const env = signed.data!;
    expect(env.schema_version).toBe(2);
    expect(env.candidate_revision).toBe(3);
    expect(env.decided_by).toBe('op-1');
    expect(env.expires_at - env.issued_at).toBe(RECOVERY_DECISION_TTL_MS);
    expect(env.key_id).toBe('v7');
    expect(env.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keyring 未配置 → fail-closed 不签发（§18：绝不返回无签名裁决）', () => {
    const signed = signRecoveryDecision({
      candidate_id: 'c', candidate_revision: 1, attempt_id: 'a',
      decision: 'discard-after-audit', decided_by: 'op',
    }, []);
    expect(signed.ok).toBe(false);
    expect(signed.error!.code).toBe('NOT_CONFIGURED');
  });

  it('缺字段 / 签名错误 / TTL 过期 / 未来签发 / 未知 key 全部拒绝', () => {
    const now = Date.now();
    const base = {
      candidate_id: 'cand-v', candidate_revision: 1, attempt_id: 'att-v',
      decision: 'upload-and-reverify' as const, decided_by: 'op-1',
    };
    const candidate = {
      candidate_id: 'cand-v', revision: 1, attempt_id: 'att-v',
      decided_at: now, decision_consumed_at: null,
    };
    const env = signRecoveryDecision({ ...base, issued_at: now }, KEYRING).data!;
    const ctx = { now_ms: now + 1000, keyring: KEYRING, candidate };

    expect(verifyRecoveryDecisionEnvelope(env, ctx)).toEqual({ ok: true });
    // 缺字段
    expect(verifyRecoveryDecisionEnvelope({ ...env, decided_by: '' }, ctx).code ?? '').not.toBe('');
    const missing = { ...env } as Partial<typeof env>;
    delete missing.candidate_revision;
    expect(verifyRecoveryDecisionEnvelope(missing as never, ctx)).toMatchObject({ code: 'MISSING_FIELDS' });
    // 签名错误（对字段篡改后未重签）
    const tampered = signRecoveryDecision({ ...base, decided_by: 'mallory', issued_at: now }, KEYRING).data!;
    expect(verifyRecoveryDecisionEnvelope({ ...env, decided_by: 'mallory' }, ctx))
      .toMatchObject({ code: 'SIGNATURE_INVALID' });
    expect(tampered.signature).not.toBe(env.signature);
    // 未知 key（revoke 后的 generation）
    expect(verifyRecoveryDecisionEnvelope(env, { ...ctx, keyring: [{ key_version: 9, material: Buffer.alloc(32, 1) }] }))
      .toMatchObject({ code: 'SIGNATURE_INVALID' });
    // TTL 过期（签发于 20 分钟前 → expires_at 已过）
    const stale = signRecoveryDecision({ ...base, issued_at: now - 20 * 60 * 1000 }, KEYRING).data!;
    expect(verifyRecoveryDecisionEnvelope(stale, ctx)).toMatchObject({ code: 'DECISION_EXPIRED' });
    // 未来签发（issued_at 超前单调坐标超过容差）
    const future = signRecoveryDecision({ ...base, issued_at: now + RECOVERY_DECISION_SKEW_TOLERANCE_MS + 60_000 }, KEYRING).data!;
    expect(verifyRecoveryDecisionEnvelope(future, ctx)).toMatchObject({ code: 'DECISION_ISSUED_IN_FUTURE' });
  });

  it('REVISION_STALE：决策 revision 落后 candidate 当前 revision', () => {
    const now = Date.now();
    const env = signRecoveryDecision({
      candidate_id: 'cand-r', candidate_revision: 1, attempt_id: 'att-r',
      decision: 'discard-after-audit', decided_by: 'op', issued_at: now,
    }, KEYRING).data!;
    const bumped = { candidate_id: 'cand-r', revision: 2, attempt_id: 'att-r', decided_at: now, decision_consumed_at: null };
    expect(verifyRecoveryDecisionEnvelope(env, { now_ms: now + 1000, keyring: KEYRING, candidate: bumped }))
      .toMatchObject({ code: 'REVISION_STALE' });
  });

  it('DECISION_NOT_MONOTONIC：决策时间早于 candidate revision 时间-容差（22.4-27）', () => {
    const now = Date.now();
    // 决策签发于 revision 写入 10 分钟前（超过 5 分钟容差）
    const env = signRecoveryDecision({
      candidate_id: 'cand-m', candidate_revision: 4, attempt_id: 'att-m',
      decision: 'upload-and-reverify', decided_by: 'op', issued_at: now - 10 * 60 * 1000,
    }, KEYRING).data!;
    const candidate = {
      candidate_id: 'cand-m', revision: 4, attempt_id: 'att-m',
      decided_at: now, decision_consumed_at: null,
    };
    expect(verifyRecoveryDecisionEnvelope(env, { now_ms: now + 1000, keyring: KEYRING, candidate }))
      .toMatchObject({ code: 'DECISION_NOT_MONOTONIC' });
    // 容差内的偏移不拒绝（时钟微小抖动）
    const within = signRecoveryDecision({
      candidate_id: 'cand-m', candidate_revision: 4, attempt_id: 'att-m',
      decision: 'upload-and-reverify', decided_by: 'op', issued_at: now - 60_000,
    }, KEYRING).data!;
    expect(verifyRecoveryDecisionEnvelope(within, { now_ms: now + 1000, keyring: KEYRING, candidate }))
      .toEqual({ ok: true });
  });

  it('一次性消费：同一信封二次提交 → DECISION_ALREADY_CONSUMED', () => {
    const store = makeStore();
    makeCandidate(store, 'cand-c', 'att-c', 'proj-c');
    const signed = signRecoveryDecision({
      candidate_id: 'cand-c', candidate_revision: 1, attempt_id: 'att-c',
      decision: 'upload-and-reverify', decided_by: 'node-1',
    }, KEYRING);
    const env = signed.data!;
    // candidate 落到与信封一致的 revision/decided_at（模拟 Node 持信封回报）
    store.updateOrphanRecoveryCandidate('cand-c', {
      status: 'decided', decision: 'upload-and-reverify', revision: env.candidate_revision,
      decided_by: 'op', decided_at: env.issued_at,
    });
    const first = consumeRecoveryDecision(store, env, { now_ms: env.issued_at + 1000, keyring: KEYRING });
    expect(first.ok).toBe(true);
    const second = consumeRecoveryDecision(store, env, { now_ms: env.issued_at + 2000, keyring: KEYRING });
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe('DECISION_ALREADY_CONSUMED');
    // 消费入审计
    const audits = store.listAuditEvents(undefined, 200)
      .filter((a) => a.action === 'recovery_decision.consumed' && a.subject_id === 'cand-c');
    expect(audits).toHaveLength(1);
  });
});

/* ================================================================ */
/* 22.4-29：takeover 三崩溃点续跑                                     */
/* ================================================================ */

describe('22.4-29 takeover 三崩溃点续跑', () => {
  function seedTakeoverWorld(store: SqliteStore) {
    makePlan(store, 'plan-p9r', 1, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    seedTask(store, 'task-t', 'proj-t', { status: 'in_progress', active_attempt_id: 'att-t' });
    makeAttempt(store, 'att-t', 'task-t', 'proj-t');
    makeCandidate(store, 'cand-t', 'att-t', 'proj-t');
  }

  it('崩溃点 1（决策落库后）：重入收敛，CAS 不重复递增 revision', () => {
    const store = makeStore();
    seedTakeoverWorld(store);
    const halted = runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op', halt_after: 'decide' }, KEYRING);
    expect(halted.ok).toBe(true);
    expect(halted.data!.halted_after).toBe('decide');
    expect(halted.data!.candidate.status).toBe('decided');
    expect(store.getTaskAttempt('att-t')!.status).toBe('executing'); // 尚未 fencing

    const rerun = runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op' }, KEYRING);
    expect(rerun.ok).toBe(true);
    expect(rerun.data!.steps_executed).toEqual(['fence-attempt', 'release-task']); // decide 不重复
    expect(rerun.data!.candidate.revision).toBe(1); // 单次 CAS
    expect(store.getTaskAttempt('att-t')!.status).toBe('pending_recovery');
    expect(store.getTask('task-t')!.status).toBe('pending');
    expect(store.getTask('task-t')!.active_attempt_id).toBe('');
    expect(store.listTaskAttemptsByTask('task-t')).toHaveLength(1); // 不产生双 attempt
  });

  it('崩溃点 2（任务回 pending 前一步）：从 release-task 续跑', () => {
    const store = makeStore();
    seedTakeoverWorld(store);
    runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op', halt_after: 'decide' }, KEYRING);
    const halted = runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op', halt_after: 'fence-attempt' }, KEYRING);
    expect(halted.ok).toBe(true);
    expect(halted.data!.halted_after).toBe('fence-attempt');
    expect(store.getTask('task-t')!.status).toBe('in_progress'); // 任务尚未回 pending

    const rerun = runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op' }, KEYRING);
    expect(rerun.data!.steps_executed).toEqual(['release-task']);
    expect(store.getTask('task-t')!.status).toBe('pending');
    expect(store.listTaskAttemptsByTask('task-t')).toHaveLength(1);
  });

  it('崩溃点 3（新 attempt 创建后）：重入 no-op，不 fence 新 attempt、不产生双 attempt', () => {
    const store = makeStore();
    seedTakeoverWorld(store);
    runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op' }, KEYRING);
    // 接管节点已重 claim（新 attempt、active 指针前滚）
    makeAttempt(store, 'att-t2', 'task-t', 'proj-t', { generation: 2, lease_expires_at: Date.now() + 60_000 });
    store.updateTaskFields('task-t', { status: 'in_progress', active_attempt_id: 'att-t2', claimed_by: 'node-b' });

    const rerun = runControlPlaneTakeover(store, 'cand-t', { reason: 'node-offline', decided_by: 'op' }, KEYRING);
    expect(rerun.ok).toBe(true);
    expect(rerun.data!.steps_executed).toEqual([]); // 全部已完成：no-op
    expect(store.getTaskAttempt('att-t2')!.status).toBe('executing'); // 新 attempt 未被触碰
    expect(store.getTask('task-t')!.active_attempt_id).toBe('att-t2');
    expect(store.listTaskAttemptsByTask('task-t')).toHaveLength(2); // 无第三个 attempt
  });

  it('lease 未过期时 takeover fail-closed（前置条件）', () => {
    const store = makeStore();
    makePlan(store, 'plan-p9r', 1, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    seedTask(store, 'task-t', 'proj-t', { status: 'in_progress', active_attempt_id: 'att-live2' });
    makeAttempt(store, 'att-live2', 'task-t', 'proj-t', { lease_expires_at: Date.now() + 300_000 });
    makeCandidate(store, 'cand-live', 'att-live2', 'proj-t');
    const r = runControlPlaneTakeover(store, 'cand-live', { reason: 'operator-request', decided_by: 'op' }, KEYRING);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('TAKEOVER_PRECONDITION_FAILED');
  });
});

/* ================================================================ */
/* 22.4-31：batch 逐项 revision 与 error                              */
/* ================================================================ */

describe('22.4-31 batch 逐项结果', () => {
  it('takeover 批次：成功项带 revision/最终状态，失败项带错误码，互不影响', () => {
    const store = makeStore();
    // ok-1：可接管；ok-2：可接管；missing：不存在；done：已 resolved（不可 takeover）
    makePlan(store, 'plan-p9r', 2, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    for (const [task, attempt, cand] of [['tb1', 'ab1', 'cb1'], ['tb2', 'ab2', 'cb2'], ['tb3', 'ab3', 'cb3']] as const) {
      seedTask(store, task, 'proj-b', { status: 'in_progress', active_attempt_id: attempt });
      makeAttempt(store, attempt, task, 'proj-b');
      makeCandidate(store, cand, attempt, 'proj-b');
    }
    store.updateOrphanRecoveryCandidate('cb3', { status: 'resolved', decision: 'discard-after-audit', revision: 1 });

    const batch = runBatchRecoveryActions(store, {
      candidate_ids: ['cb1', 'cb2', 'missing-1', 'cb3'],
      action: 'takeover',
      reason: 'batch',
      decided_by: 'op-batch',
    }, KEYRING);
    expect(batch.ok).toBe(true);
    const results = batch.data!.results;
    expect(results).toHaveLength(4);
    const byId = Object.fromEntries(results.map((r) => [r.candidate_id, r]));
    expect(byId.cb1).toMatchObject({ ok: true, candidate_revision: 1, final_status: 'decided', error_code: null });
    expect(byId.cb2).toMatchObject({ ok: true, candidate_revision: 1, final_status: 'decided', error_code: null });
    expect(byId['missing-1']).toMatchObject({ ok: false, candidate_revision: null, final_status: null, error_code: 'NOT_FOUND' });
    expect(byId.cb3).toMatchObject({ ok: false, error_code: 'INVALID_STATUS' });
    // 成功项副作用完整（cb1/cb2 attempt 已 fencing），失败项不影响其余
    expect(store.getTaskAttempt('ab1')!.status).toBe('pending_recovery');
    expect(store.getTaskAttempt('ab2')!.status).toBe('pending_recovery');
  });

  it('discard 批次：重试不重复成功项（幂等返回当前 revision/终态）', () => {
    const store = makeStore();
    makePlan(store, 'plan-p9r', 1, '2026-01-01T00:00:00.000Z'); // seedTask 默认 plan FK
    seedTask(store, 'td1', 'proj-d', { status: 'in_progress', active_attempt_id: 'ad1' });
    makeAttempt(store, 'ad1', 'td1', 'proj-d');
    makeCandidate(store, 'cd1', 'ad1', 'proj-d');

    const first = runBatchRecoveryActions(store, { candidate_ids: ['cd1'], action: 'discard', reason: 'r', decided_by: 'op' }, KEYRING);
    expect(first.data!.results[0]).toMatchObject({ ok: true, candidate_revision: 1, final_status: 'resolved' });
    const second = runBatchRecoveryActions(store, { candidate_ids: ['cd1'], action: 'discard', reason: 'r', decided_by: 'op' }, KEYRING);
    expect(second.data!.results[0]).toMatchObject({ ok: true, candidate_revision: 1, final_status: 'resolved' });
    expect(store.getOrphanRecoveryCandidate('cd1')!.revision).toBe(1); // 不重复递增
  });
});

/* ================================================================ */
/* 22.4-06：RecoveryIsolation 三步分权                                */
/* ================================================================ */

describe('22.4-06 RecoveryIsolation 三步分权', () => {
  it('isolator 创建 → reviewer（≠isolator）复核 → reconcile 服务 resolve；全链审计', () => {
    const store = makeStore();
    const created = createRecoveryIsolationRecord(store, {
      project_id: 'proj-i',
      object_type: 'remote-ref',
      object_id: 'refs/heads/orphan',
      evidence: '残留 ref 与默认分支安全歧义',
      reason: 'mode transition 超期残留',
      isolated_by: 'isolator-a',
    });
    expect(created.ok).toBe(true);
    const isolationId = created.data!.isolation_id;
    expect(created.data!.status).toBe('isolated');

    // 同一 actor 自建自审 → 强制拒绝
    const self = reviewRecoveryIsolationRecord(store, isolationId, { reviewed_by: 'isolator-a', verdict: 'confirm' });
    expect(self.ok).toBe(false);
    expect(self.error!.code).toBe('SELF_REVIEW_FORBIDDEN');

    // 未复核不可 resolve（三步分权：resolve 前置 = 独立 reviewer confirm）
    const early = resolveRecoveryIsolationRecord(store, isolationId, { resolved_by: RECONCILE_SERVICE_ACTOR, resolution: 'x' });
    expect(early.ok).toBe(false);
    expect(early.error!.code).toBe('INVALID_STATUS');

    // dispute：保持 isolated，不写 reviewed 字段
    const dispute = reviewRecoveryIsolationRecord(store, isolationId, { reviewed_by: 'reviewer-b', verdict: 'dispute' });
    expect(dispute.ok).toBe(true);
    expect(dispute.data!.status).toBe('isolated');
    expect(dispute.data!.reviewed_by).toBe('');

    // 独立 reviewer confirm → under-review + reviewed 字段
    const review = reviewRecoveryIsolationRecord(store, isolationId, { reviewed_by: 'reviewer-b', verdict: 'confirm', evidence: 'ev-1' });
    expect(review.ok).toBe(true);
    expect(review.data!.status).toBe('under-review');
    expect(review.data!.reviewed_by).toBe('reviewer-b');
    expect(review.data!.reviewed_at).not.toBeNull();

    // 非 reconcile 服务身份不得 resolve
    const wrongActor = resolveRecoveryIsolationRecord(store, isolationId, { resolved_by: 'isolator-a', resolution: 'x' });
    expect(wrongActor.ok).toBe(false);
    expect(wrongActor.error!.code).toBe('RESOLVER_NOT_ALLOWED');
    // evidence 必填
    const noEvidence = resolveRecoveryIsolationRecord(store, isolationId, { resolved_by: RECONCILE_SERVICE_ACTOR, resolution: '  ' });
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.error!.code).toBe('EVIDENCE_REQUIRED');

    // reconcile 服务 resolve 收口
    const resolved = resolveRecoveryIsolationRecord(store, isolationId, {
      resolved_by: RECONCILE_SERVICE_ACTOR,
      resolution: '残留 ref 已核对删除，evidence digest 一致',
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.data!.status).toBe('resolved');
    expect(resolved.data!.resolved_by).toBe(RECONCILE_SERVICE_ACTOR);

    // create/review/resolve 全链入审计
    const actions = store.listAuditEvents('proj-i', 100)
      .filter((a) => a.subject_id === isolationId)
      .map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([
      'recovery_isolation.create',
      'recovery_isolation.review.confirm',
      'recovery_isolation.resolve',
    ]));
  });

  it('同一对象重复创建幂等（§20.3 唯一未 resolved 语义）', () => {
    const store = makeStore();
    const input = {
      project_id: 'proj-i2' as string | null,
      object_type: 'remote-ref' as const,
      object_id: 'refs/heads/dup',
      evidence: 'e',
      reason: 'r',
      isolated_by: 'isolator-a',
    };
    const first = createRecoveryIsolationRecord(store, input);
    const second = createRecoveryIsolationRecord(store, input);
    expect(second.ok).toBe(true);
    expect(second.data!.isolation_id).toBe(first.data!.isolation_id);
  });
});

/* ================================================================ */
/* 22.4-34：revalidate-plans canary fail-closed                       */
/* ================================================================ */

describe('22.4-34 canary fail-closed', () => {
  it('首个迁移 plan 验证失败 → transition failed 并保持 read-only，不继续批量', async () => {
    const store = makeStore();
    const project = makeProject(store, {
      execution_mode: 'read-only-acceptance',
      write_capability_status: 'disabled',
      repository_fingerprint: 'fp-ok',
    });
    // canary plan 坏（task_count=0 且无 task）；后续 plan 有效——批量不应被触碰
    makePlan(store, 'plan-bad', 0, '2026-01-01T00:00:00.000Z', project.project_id);
    makePlan(store, 'plan-good', 1, '2026-01-02T00:00:00.000Z', project.project_id);
    seedTask(store, 'task-good', project.project_id, { plan_id: 'plan-good' });

    const t = await applyTransition(store, project.project_id, 'full');
    const { final } = driveToSettled(store, project.project_id, t.data!.transition_id);
    expect(final.action).toBe('failed');
    expect(final.error!.code).toBe('REVALIDATE_CANARY_FAILED');
    expect(final.transition.steps.find((s) => s.step === 'revalidate-plans')!.status).toBe('failed');
    // fail-closed：保持 read-only，未进入 commit-mode
    const p = store.getProject(project.project_id)!;
    expect(p.execution_mode).toBe('read-only-acceptance');
    expect(p.status).toBe('paused');
    expect(store.getProjectModeTransition(t.data!.transition_id)!.step).toBe('revalidate-plans');
    // canary 失败开 Incident（§12.1.2 任何验证失败暴露原因）
    const incidents = store.listIncidents(project.project_id, 'open')
      .filter((i) => i.kind === 'mode_transition.revalidate_canary_failed');
    expect(incidents).toHaveLength(1);
  });

  it('canary 通过但后续 plan 失败 → 同样 fail-closed（批量守门）', async () => {
    const store = makeStore();
    const project = makeProject(store, {
      execution_mode: 'read-only-acceptance',
      write_capability_status: 'disabled',
      repository_fingerprint: 'fp-ok',
    });
    makePlan(store, 'plan-ok', 1, '2026-01-01T00:00:00.000Z', project.project_id);
    makePlan(store, 'plan-late-bad', 0, '2026-01-02T00:00:00.000Z', project.project_id);
    seedTask(store, 'task-ok', project.project_id, { plan_id: 'plan-ok' });

    const t = await applyTransition(store, project.project_id, 'full');
    const { final } = driveToSettled(store, project.project_id, t.data!.transition_id);
    expect(final.action).toBe('failed');
    expect(final.error!.code).toBe('REVALIDATE_PLAN_FAILED');
    expect(store.getProject(project.project_id)!.execution_mode).toBe('read-only-acceptance');
  });
});

/* ================================================================ */
/* HTTP：advance 单步驱动 / auto 自动推进 / 服务重启续跑               */
/* ================================================================ */

const REDIS_URL = process.env.P9R_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/15';
const OWNER_TOKEN = 'p9r-owner-token';
const TEST_KEY_HEX = '3141'.repeat(16); // 64 hex = 32 bytes

let httpRedis: Redis;
let httpStore: SqliteStore;
let httpApp: FastifyInstance;
let httpServerUrl = '';
let httpDbPathValue = '';

function httpDbPath(): string {
  return httpDbPathValue;
}
const savedEnv: Record<string, string | undefined> = {};

async function httpApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method, headers: { Authorization: `Bearer ${OWNER_TOKEN}` } };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${httpServerUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function startHttpApp(): Promise<void> {
  httpApp = await createHttpServer(httpRedis, {
    apiToken: OWNER_TOKEN,
    host: '127.0.0.1',
    port: 0,
    workspaceRoots: [],
  }, { sqliteStore: httpStore });
  await httpApp.listen({ port: 0, host: '127.0.0.1' });
  const addr = httpApp.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  httpServerUrl = `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  savedEnv[V2_CREDENTIAL_KEY_ENV] = process.env[V2_CREDENTIAL_KEY_ENV];
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  Object.assign(process.env, ALL_V2_FEATURE_FLAGS_ON_ENV);

  httpRedis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  await httpRedis.connect();
  await httpRedis.flushdb();
  const dir = tempDir('http');
  httpDbPathValue = join(dir, 'biao.sqlite');
  httpStore = new SqliteStore(httpDbPathValue);
  openedStores.push(httpStore);
  await startHttpApp();
}, 30_000);

afterAll(async () => {
  if (httpApp) await httpApp.close().catch(() => undefined);
  if (httpStore) { try { httpStore.close(); } catch { /* ignore */ } }
  if (httpRedis) {
    await httpRedis.flushdb().catch(() => undefined);
    httpRedis.disconnect();
  }
  if (savedEnv[V2_CREDENTIAL_KEY_ENV] !== undefined) {
    process.env[V2_CREDENTIAL_KEY_ENV] = savedEnv[V2_CREDENTIAL_KEY_ENV];
  } else {
    delete process.env[V2_CREDENTIAL_KEY_ENV];
  }
  for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!;
    else delete process.env[key];
  }
});

describe('HTTP：mode transition 推进 API', () => {
  it('POST mode-transitions（auto）→ 完整切换；advance 单步驱动与 no-op 幂等', async () => {
    const created = await httpApi('POST', '/v2/projects', {
      name: 'p9r-http-a', repo_path: '/tmp/p9r-a', default_branch: 'main', execution_mode: 'full',
    });
    expect(created.status).toBe(200);
    const projectId = created.body.data.project_id;

    const drain = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions`, {
      to_mode: 'read_only', reason: 'http auto', auto: true,
    });
    expect(drain.status).toBe(200);
    expect(drain.body.ok).toBe(true);
    expect(drain.body.data.action).toBe('completed');
    expect(drain.body.data.transition.status).toBe('completed');
    expect(drain.body.data.transition.steps.map((s: any) => s.status)).toEqual(
      Array.from({ length: DRAINING_STEP_SEQUENCE.length }, () => 'done'),
    );

    const advance = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions/${drain.body.data.transition.transition_id}/advance`, {});
    expect(advance.body.data.action).toBe('no-op');
  });

  it('advance 单步推进（auto=false）逐步驱动到 completed', async () => {
    const created = await httpApi('POST', '/v2/projects', {
      name: 'p9r-http-b', repo_path: '/tmp/p9r-b', default_branch: 'main', execution_mode: 'read_only',
    });
    const projectId = created.body.data.project_id;
    httpStore.updateProject(projectId, { repository_fingerprint: 'fp-http' });

    const restore = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions`, {
      to_mode: 'full', reason: 'http step-by-step',
    });
    expect(restore.body.ok).toBe(true);
    expect(restore.body.data.status).toBe('running');
    const transitionId = restore.body.data.transition_id;

    const executed: string[] = [];
    for (let i = 0; i < VALIDATING_STEP_SEQUENCE.length + 1; i += 1) {
      const step = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions/${transitionId}/advance`, {});
      expect(step.body.ok).toBe(true);
      if (step.body.data.executed_step) executed.push(step.body.data.executed_step);
      if (step.body.data.action !== 'advanced') {
        expect(step.body.data.action).toBe('completed');
        break;
      }
    }
    expect(executed).toEqual(['validate-capability', 'reconcile', 'refresh-bindings', 'revalidate-plans', 'commit-mode']);
    expect(httpStore.getProject(projectId)!.execution_mode).toBe('full');
  });

  it('服务重启（同库新实例）从 durable step 续跑（启动扫描）', async () => {
    const created = await httpApi('POST', '/v2/projects', {
      name: 'p9r-http-c', repo_path: '/tmp/p9r-c', default_branch: 'main', execution_mode: 'full',
    });
    const projectId = created.body.data.project_id;
    const drain = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions`, {
      to_mode: 'read_only', reason: 'restart resume',
    });
    const transitionId = drain.body.data.transition_id;
    // 推进一步（pause 已在创建时执行，advance 执行 fence-attempts）后 kill 服务
    const step = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions/${transitionId}/advance`, {});
    expect(step.body.data.executed_step).toBe('fence-attempts');
    const stepAtKill = httpStore.getProjectModeTransition(transitionId)!.step;
    expect(stepAtKill).toBe('invalidate-lineage');

    // kill + 重启：同库文件重开 store（真实进程重启语义）+ 新 HTTP 实例；
    // 启动扫描推进 durable step 一步
    await httpApp.close();
    const dir = tempDir('http-restart');
    const dbPath = join(dir, 'biao.sqlite');
    httpStore.close();
    copyFileSync(httpDbPath(), dbPath);
    httpStore = new SqliteStore(dbPath);
    openedStores.push(httpStore);
    await startHttpApp();
    const afterBoot = httpStore.getProjectModeTransition(transitionId)!.step;
    expect(afterBoot).toBe('block-dependents'); // 启动续跑执行了 invalidate-lineage

    // 新实例上继续单步推进到完成
    for (let i = 0; i < 6; i += 1) {
      const r = await httpApi('POST', `/v2/projects/${projectId}/mode-transitions/${transitionId}/advance`, {});
      if (r.body.data.action === 'completed') break;
    }
    expect(httpStore.getProjectModeTransition(transitionId)!.status).toBe('completed');
    expect(httpStore.getProject(projectId)!.execution_mode).toBe('read-only-acceptance');
  });

  it('HTTP batch-actions 逐项结果（22.4-31 API 面）', async () => {
    const created = await httpApi('POST', '/v2/projects', {
      name: 'p9r-http-d', repo_path: '/tmp/p9r-d', default_branch: 'main', execution_mode: 'full',
    });
    const projectId = created.body.data.project_id;
    httpStore.upsertPlan({
      plan_id: 'plan-http', title: 'p', status: 'submitted', project_path: '/tmp/p9r-d',
      default_assignee: 'auto', default_priority: 5, phases: '[]', task_count: 1,
      created_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
    });
    seedTask(httpStore, 'task-http-1', projectId, { plan_id: 'plan-http', status: 'in_progress', active_attempt_id: 'att-http-1' });
    makeAttempt(httpStore, 'att-http-1', 'task-http-1', projectId);
    makeCandidate(httpStore, 'cand-http-1', 'att-http-1', projectId);

    const batch = await httpApi('POST', '/v2/recovery-candidates/batch-actions', {
      candidate_ids: ['cand-http-1', 'cand-http-missing'],
      action: 'discard',
      reason: 'http batch',
      decided_by: 'op-http',
    });
    expect(batch.status).toBe(200);
    expect(batch.body.ok).toBe(true);
    const results = batch.body.data.results;
    expect(results).toHaveLength(2);
    if (!results[0].ok) throw new Error(`HTTP batch discard 失败: ${JSON.stringify(results[0])}`);
    expect(results[0]).toMatchObject({ candidate_id: 'cand-http-1', ok: true, candidate_revision: 1, final_status: 'resolved' });
    expect(results[1]).toMatchObject({ candidate_id: 'cand-http-missing', ok: false, error_code: 'NOT_FOUND' });
  });
});
