/**
 * V2 ProjectService + mode transition step 推进器
 *
 * 组合车道 A 的 SqliteStore，实现 domain-interfaces.ts 的 ProjectService 子集。
 *
 * 后续增强·车道 C（22.3-18/20/21、22.4-04/34）：
 * - 24h deadline：MODE_TRANSITION_DEADLINE_MS（§12.1.1 矩阵原文「双向 mode
 *   transition 的总 deadline 默认均为 24 小时」；修正实现曾误用的 30 分钟）；
 * - step 推进器：按 §4.1 方向-step 表逐步 durable 推进（先落库再执行），
 *   失败置 failed 可重试，幂等重入，控制面重启从 durable step 续跑；
 * - full→read-only 写 lineage 全收口（22.3-18，§12.1.1 列表）；
 * - read-only→full 离线 Node 不阻塞 + binding 挂起/回归重同步（22.3-21，§12.1.2）；
 * - revalidate-plans 内建 canary 子步 fail-closed（22.4-34）；
 * - 超 24h deadline → expired + RecoveryIsolation 留证（衔接 22.4-05）。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { ProjectRow } from '../../types/v2-identity.js';
import type {
  IncidentRow,
  ProjectModeTransitionRow,
  RecoveryIsolationRow,
  V2ExecutionMode,
  V2ModeTransitionStep,
  V2TransitionStatus,
} from '../../types/v2-infra.js';
import {
  DRAINING_STEPS,
  MODE_TRANSITION_DEADLINE_MS,
  VALIDATING_STEPS,
} from '../../types/v2-infra.js';
import type {
  ProjectService,
  V2Project,
  V2ProjectCreateInput,
  V2ProjectModeTransition,
  V2RequestMeta,
  V2ActorContext,
  V2PageRequest,
  V2Page,
  V2CorrelationId,
} from './domain-interfaces.js';
import type { ApiResponse } from '../../types/index.js';

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiResponse<never> {
  return { ok: false, data: null, error: { code, message } };
}

function toV2ExecutionMode(mode: string): V2ExecutionMode {
  return mode === 'read_only' ? 'read-only-acceptance' : 'full';
}

function fromV2ExecutionMode(mode: V2ExecutionMode): 'full' | 'read_only' {
  return mode === 'read-only-acceptance' ? 'read_only' : 'full';
}

function rowToProject(row: ProjectRow): V2Project {
  return {
    project_id: row.project_id,
    name: row.display_name,
    repo_path: row.repository_url,
    default_branch: row.default_branch,
    execution_mode: fromV2ExecutionMode(row.execution_mode),
    status: row.status === 'paused' ? 'read_only' : row.status === 'archived' ? 'archived' : 'active',
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

/* ================================================================== */
/* mode transition step 推进器（§4.1 方向-step 表 / §12.1.1/§12.1.2）   */
/* ================================================================== */

/** full → read-only 合法 step 序（§4.1；与 v2-infra DRAINING_STEPS 同源）。 */
export const DRAINING_STEP_SEQUENCE: readonly V2ModeTransitionStep[] = DRAINING_STEPS;

/** read-only → full 合法 step 序（§4.1；与 v2-infra VALIDATING_STEPS 同源）。 */
export const VALIDATING_STEP_SEQUENCE: readonly V2ModeTransitionStep[] = VALIDATING_STEPS;

/** 方向 → step 序。 */
export function stepSequenceForTransition(row: Pick<ProjectModeTransitionRow, 'to_mode'>):
  readonly V2ModeTransitionStep[] {
  return row.to_mode === 'read-only-acceptance' ? DRAINING_STEP_SEQUENCE : VALIDATING_STEP_SEQUENCE;
}

/** §12.1.1 step 3：非终态写 lineage 的 Delivery 状态集合（proposed 的
 * Phase 4 细分 pending_review/reviewing/pending_recovery 一并计入）。 */
const ACTIVE_DELIVERY_STATUSES = [
  'proposed', 'pending_review', 'reviewing', 'pending_recovery', 'accepted', 'merging',
] as const;

/** §12.1.1 step 2/5：仍需 generation fencing 的写 Attempt 状态。 */
const ACTIVE_ATTEMPT_STATUSES = ['pending', 'claiming', 'executing'] as const;

/** §12.1.1 step 3：仍需 cancel 的 MergeJob 状态。 */
const ACTIVE_MERGE_JOB_STATUSES = ['queued', 'running'] as const;

/** §12.1.2 step 4：恢复 full 时视为「在线类」的 Node 状态（离线不阻塞）。 */
const ONLINE_CLASS_NODE_STATUSES = ['online', 'degraded', 'draining'] as const;

/** 降级收口后被移出 scheduler pending 集合的任务终处理状态。 */
const TASK_BLOCKED_STATUS = 'blocked';

/** V1 任务终态（不再参与收口）。 */
const TERMINAL_TASK_STATUSES = ['done', 'cancelled', 'superseded', 'failed', 'blocked'] as const;

/** 降级 block-dependents 写入的 blocked_reason（§12.1.1 step 4）。 */
export const BLOCKED_REASON_WRITE = 'PROJECT_MODE_CHANGED_READ_ONLY';
export const BLOCKED_REASON_DEPENDENCY = 'PROJECT_MODE_CHANGED_READ_ONLY_DEPENDENCY';

/** §4.4.2：隔离/清理记录默认保留 30 天。 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 22.3-18 收口清单模板：full→read-only 切换前必须逐项收口的对象类别。
 * 每项含：枚举来源、收口动作、收口判据（reconcile step 的等待条件）。
 */
export const DRAIN_CHECKLIST_TEMPLATE: readonly {
  kind: string;
  source: string;
  action: string;
  closed_when: string;
}[] = Object.freeze([
  {
    kind: 'write-attempt',
    source: 'task_attempts（status ∈ pending/claiming/executing）',
    action: 'fence → pending_recovery（generation fencing + 进程终止）',
    closed_when: '无 ACTIVE 写 Attempt（pending_recovery 视为已 fence）',
  },
  {
    kind: 'delivery',
    source: 'deliveries（status ∈ proposed/pending_review/reviewing/pending_recovery/accepted/merging）',
    action: 'invalidate → invalidated(remote-ref-acl-lost) + BranchCleanup(reason=mode_transition)',
    closed_when: '无非终态写 lineage Delivery',
  },
  {
    kind: 'merge-job',
    source: 'merge_jobs（status ∈ queued/running）',
    action: 'cancel → cancelled(remote-ref-acl-lost)',
    closed_when: '无 queued/running MergeJob',
  },
  {
    kind: 'recovery-candidate',
    source: 'orphan_recovery_candidates（status=pending，decision=pending）',
    action: 'decide 或 isolate（durable 留证）',
    closed_when: '全部 pending Candidate 已裁决或隔离（isolated 不阻塞）',
  },
  {
    kind: 'write-task',
    source: 'tasks（非终态写任务）',
    action: 'blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY，移出 pending',
    closed_when: '无静默 pending 的写任务',
  },
  {
    kind: 'blocked-dependent-task',
    source: 'tasks（依赖被阻塞写 lineage 的只读/验收任务）',
    action: 'blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY_DEPENDENCY，移出 pending',
    closed_when: '无静默 pending 的下游只读任务',
  },
]);

/** 收口清单条目（reconcile step 等待时逐项报告）。 */
export interface DrainChecklistItem {
  kind: 'write-attempt' | 'delivery' | 'merge-job' | 'recovery-candidate' | 'write-task' | 'blocked-dependent-task';
  id: string;
  status: string;
  action: string;
}

/**
 * 枚举 project 仍未收口的对象（22.3-18）：reconcile step 的等待判据与
 * 「未收口完成 → transition 停在对应 step 并报告清单」的数据源。
 * 已隔离对象（RecoveryIsolation 未 resolved）按 §12.1.1 不进入正常 reconcile，
 * 因此 isolated Candidate 不算未收口。
 */
export function collectDrainChecklist(store: SqliteStore, projectId: string): DrainChecklistItem[] {
  const items: DrainChecklistItem[] = [];

  for (const task of store.getTasksByProjectId(projectId)) {
    for (const attempt of store.listTaskAttemptsByTask(task.task_id)) {
      if ((ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) {
        items.push({ kind: 'write-attempt', id: attempt.attempt_id, status: attempt.status, action: 'fence' });
      }
    }
    if (!(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status) && !task.blocked_reason) {
      items.push({
        kind: task.acceptance_for || dependsOnBlocked(store, task, projectId) ? 'blocked-dependent-task' : 'write-task',
        id: task.task_id,
        status: task.status,
        action: 'block',
      });
    }
  }
  for (const delivery of store.listDeliveriesByProject(projectId)) {
    if ((ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(delivery.status)) {
      items.push({ kind: 'delivery', id: delivery.delivery_id, status: delivery.status, action: 'invalidate' });
    }
  }
  for (const job of store.listMergeJobsByProject(projectId)) {
    if ((ACTIVE_MERGE_JOB_STATUSES as readonly string[]).includes(job.status)) {
      items.push({ kind: 'merge-job', id: job.merge_job_id, status: job.status, action: 'cancel' });
    }
  }
  for (const candidate of store.listOrphanRecoveryCandidates(projectId, 'pending')) {
    items.push({ kind: 'recovery-candidate', id: candidate.candidate_id, status: candidate.status, action: 'decide-or-isolate' });
  }
  return items;
}

/** 只读任务的依赖是否命中该 project 的任一写任务（下游 lineage 判定）。 */
function dependsOnBlocked(store: SqliteStore, task: { depends_on: string }, projectId: string): boolean {
  let deps: string[] = [];
  try {
    deps = JSON.parse(task.depends_on || '[]') as string[];
  } catch {
    deps = [];
  }
  if (!Array.isArray(deps) || deps.length === 0) return false;
  const writeTaskIds = new Set(
    store.getTasksByProjectId(projectId)
      .filter((t) => !t.acceptance_for)
      .map((t) => t.task_id),
  );
  return deps.some((dep) => writeTaskIds.has(dep));
}

/* ── 步骤执行结果 ── */

interface StepExecuteResult {
  ok: boolean;
  /** waiting：step 未收口完成，transition 停留本 step（清单随报告返回）。 */
  pending?: DrainChecklistItem[];
  /** failed：step 硬失败，transition 置 failed（可重试）。 */
  code?: string;
  message?: string;
}

function stepOk(): StepExecuteResult {
  return { ok: true };
}

function stepWaiting(pending: DrainChecklistItem[]): StepExecuteResult {
  return { ok: false, pending };
}

function stepFailed(code: string, message: string): StepExecuteResult {
  return { ok: false, code, message };
}

/* ── 审计 / Incident / outbox 最小写入门禁 ── */

function auditEvent(
  store: SqliteStore,
  action: string,
  subjectType: string,
  subjectId: string,
  actor: string,
  projectId: string | null,
): void {
  store.insertAuditEvent({
    audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: projectId,
    actor_id: actor,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    correlation_id: `corr-${randomUUID().slice(0, 12)}`,
    evidence_digest: '',
    created_at: Date.now(),
  });
}

function openIncident(
  store: SqliteStore,
  projectId: string | null,
  kind: string,
  severity: IncidentRow['severity'],
  title: string,
  detail: string,
  relatedId: string,
): void {
  const now = Date.now();
  store.insertIncident({
    incident_id: `inc-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: projectId,
    kind,
    severity,
    status: 'open',
    title,
    detail,
    correlation_id: '',
    related_entity_type: 'project_mode_transition',
    related_entity_id: relatedId,
    opened_at: now,
    ack_due_at: null,
    acked_at: null,
    acked_by: '',
    ack_note: '',
    resolved_at: null,
    resolved_by: '',
    resolution_evidence: '',
    revision: 1,
    created_at: now,
    updated_at: now,
  });
}

function appendStepOutbox(store: SqliteStore, row: ProjectModeTransitionRow, step: string, seqIndex: number): void {
  store.insertOutboxEvent({
    event_id: `evt-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: row.project_id,
    aggregate_type: 'project_mode_transition',
    aggregate_id: row.transition_id,
    aggregate_revision: seqIndex + 1,
    payload_digest: createHash('sha256').update(`${row.transition_id}:${step}`, 'utf8').digest('hex'),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: Date.now(),
    last_error: '',
    dead_lettered_at: null,
    compensates_event_id: '',
  });
}

/* ── 降级方向（full → read-only）step 执行器（§12.1.1） ── */

function executeDrainingStep(
  store: SqliteStore,
  project: ProjectRow,
  row: ProjectModeTransitionRow,
  step: V2ModeTransitionStep,
): StepExecuteResult {
  const now = Date.now();
  switch (step) {
    case 'pause': {
      // step 1：paused + draining 指针，停止 claim/Delivery review/入队
      store.updateProject(project.project_id, {
        status: 'paused',
        mode_transition: 'draining-to-read-only',
        mode_transition_id: row.transition_id,
        mode_transition_step: 'pause',
        updated_at: now,
      });
      return stepOk();
    }
    case 'fence-attempts': {
      // step 2：非终态写 Attempt 全部 generation fencing（幂等：已是终态跳过）
      for (const task of store.getTasksByProjectId(project.project_id)) {
        for (const attempt of store.listTaskAttemptsByTask(task.task_id)) {
          if ((ACTIVE_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status)) {
            store.updateTaskAttempt(attempt.attempt_id, {
              status: 'pending_recovery',
              failure_reason: 'mode-transition-fencing',
              updated_at: now,
            });
          }
        }
      }
      const pending = collectDrainChecklist(store, project.project_id)
        .filter((item) => item.kind === 'write-attempt');
      return pending.length > 0 ? stepWaiting(pending) : stepOk();
    }
    case 'invalidate-lineage': {
      // step 3：Delivery 原子 invalidated(remote-ref-acl-lost) + 幂等 BranchCleanup；
      // queued/running MergeJob → cancelled(remote-ref-acl-lost)
      const existingCleanups = store.listBranchCleanups(project.project_id);
      for (const delivery of store.listDeliveriesByProject(project.project_id)) {
        if (!(ACTIVE_DELIVERY_STATUSES as readonly string[]).includes(delivery.status)) continue;
        store.updateDelivery(delivery.delivery_id, {
          status: 'invalidated',
          invalidated_reason: 'remote-ref-acl-lost',
          updated_at: now,
        });
        const dup = existingCleanups.some(
          (c) => c.delivery_id === delivery.delivery_id
            && c.branch_ref === delivery.branch_ref
            && c.expected_head_sha === delivery.head_sha,
        );
        if (!dup) {
          store.insertBranchCleanup({
            cleanup_id: `bc-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            project_id: project.project_id,
            delivery_id: delivery.delivery_id,
            branch_ref: delivery.branch_ref,
            expected_head_sha: delivery.head_sha,
            reason: 'mode_transition',
            status: 'pending',
            eligible_at: now,
            retention_until: now + RETENTION_MS,
            last_error: '',
            completed_at: null,
          });
        }
      }
      for (const job of store.listMergeJobsByProject(project.project_id)) {
        if (!(ACTIVE_MERGE_JOB_STATUSES as readonly string[]).includes(job.status)) continue;
        store.updateMergeJob(job.merge_job_id, {
          status: 'cancelled',
          cancel_reason: 'remote-ref-acl-lost',
          updated_at: now,
          completed_at: now,
        });
      }
      return stepOk();
    }
    case 'block-dependents': {
      // step 4：写任务与依赖写 lineage 的下游只读任务写 blocked_reason 并移出
      // pending（幂等：已有 blocked_reason/mode_transition_id 跳过）
      const tasks = store.getTasksByProjectId(project.project_id)
        .filter((t) => !(TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status))
        .filter((t) => !t.blocked_reason && !t.mode_transition_id);
      const writeTaskIds = new Set(tasks.filter((t) => !t.acceptance_for).map((t) => t.task_id));
      for (const task of tasks) {
        const isDependent = !!task.acceptance_for
          || (() => {
            try {
              const deps = JSON.parse(task.depends_on || '[]') as string[];
              return Array.isArray(deps) && deps.some((dep) => writeTaskIds.has(dep));
            } catch {
              return false;
            }
          })();
        store.updateTaskFields(task.task_id, {
          status: TASK_BLOCKED_STATUS,
          blocked_at: new Date(now).toISOString(),
          block_reason: isDependent ? BLOCKED_REASON_DEPENDENCY : BLOCKED_REASON_WRITE,
          blocked_reason: isDependent ? BLOCKED_REASON_DEPENDENCY : BLOCKED_REASON_WRITE,
          blocked_since: now,
          mode_transition_id: row.transition_id,
          updated_at: new Date(now).toISOString(),
        });
      }
      return stepOk();
    }
    case 'reconcile': {
      // step 5：等待全部写 Attempt/MergeJob 终态、pending Candidate 裁决或隔离；
      // 未收口完成 → 停留本 step 并报告清单
      const pending = collectDrainChecklist(store, project.project_id);
      return pending.length > 0 ? stepWaiting(pending) : stepOk();
    }
    case 'commit-mode': {
      // step 6：全部收口后原子切换（不清指针之外的状态残留）
      store.updateProject(project.project_id, {
        execution_mode: 'read-only-acceptance',
        write_capability_status: 'disabled',
        status: 'active',
        mode_transition: null,
        mode_transition_id: '',
        mode_transition_step: null,
        revision: project.revision + 1,
        updated_at: now,
      });
      return stepOk();
    }
    default:
      return stepFailed('INVALID_STEP', `draining 方向不包含 step ${step}`);
  }
}

/* ── 恢复方向（read-only → full）step 执行器（§12.1.2） ── */

/** §12.1.2 step 5 canary/批量共用的 Plan 校验（fail-closed 判据）。 */
export function validatePlanForFullMode(
  plan: { plan_id: string; task_count: number },
  projectTaskPlanIds: readonly string[],
): { ok: boolean; reason: string } {
  if (plan.task_count < 1) {
    return { ok: false, reason: `plan ${plan.plan_id} task_count=${plan.task_count}（无任务可迁移）` };
  }
  if (!projectTaskPlanIds.includes(plan.plan_id)) {
    return { ok: false, reason: `plan ${plan.plan_id} 无对应 task 记录（快照不完整）` };
  }
  return { ok: true, reason: '' };
}

/**
 * §12.1.2 step 5 的 plan 枚举：优先 plans.project_id（004 扩展列）；该列在
 * plan-import 旧路径未回填时，按项目 task 的 plan_id 关联兜底（plan 快照
 * 仍可被 revalidate，canary 不因关联列缺失而静默跳过）。
 */
function projectPlansForRevalidate(store: SqliteStore, projectId: string) {
  const tasks = store.getTasksByProjectId(projectId);
  const taskPlanIds = new Set(tasks.map((t) => t.plan_id));
  const byColumn = store.getPlansByProjectId(projectId);
  if (byColumn.length > 0) return { plans: byColumn, taskPlanIds: [...taskPlanIds] };
  const plans = store.getAllPlans()
    .filter((p) => taskPlanIds.has(p.plan_id))
    .filter((p) => !['superseded', 'archived', 'cancelled'].includes(p.status))
    .sort((a, b) => `${a.created_at}${a.plan_id}`.localeCompare(`${b.created_at}${b.plan_id}`));
  return { plans, taskPlanIds: [...taskPlanIds] };
}

function executeValidatingStep(
  store: SqliteStore,
  project: ProjectRow,
  row: ProjectModeTransitionRow,
  step: V2ModeTransitionStep,
): StepExecuteResult {
  const now = Date.now();
  switch (step) {
    case 'pause': {
      // step 1：paused + validating 指针；disabled → suspect（§4.1 权威转换）
      store.updateProject(project.project_id, {
        status: 'paused',
        mode_transition: 'validating-to-full',
        mode_transition_id: row.transition_id,
        mode_transition_step: 'pause',
        write_capability_status: project.write_capability_status === 'disabled' ? 'suspect' : project.write_capability_status,
        updated_at: now,
      });
      return stepOk();
    }
    case 'validate-capability': {
      // step 2：repository fingerprint / ref scope / 默认分支存在性；全部成功才 ready
      const problems: string[] = [];
      if (!project.repository_fingerprint) problems.push('repository_fingerprint 未安装（ref ACL 未验证）');
      if (!project.default_branch) problems.push('default_branch 缺失');
      if (problems.length > 0) {
        openIncident(
          store,
          project.project_id,
          'mode_transition.capability_validation_failed',
          'warning',
          '恢复 full 的 capability 验证失败',
          problems.join('; '),
          row.transition_id,
        );
        return stepFailed('CAPABILITY_VALIDATION_FAILED', problems.join('; '));
      }
      store.updateProject(project.project_id, { write_capability_status: 'ready', updated_at: now });
      return stepOk();
    }
    case 'reconcile': {
      // step 3：全量对账——pending Candidate 未裁决则等待（isolated 已被
      // RecoveryIsolation 排除在正常 reconcile 之外，不阻塞）
      const pending = collectDrainChecklist(store, project.project_id)
        .filter((item) => item.kind === 'recovery-candidate');
      return pending.length > 0 ? stepWaiting(pending) : stepOk();
    }
    case 'refresh-bindings': {
      // step 4：提升 policy revision；在线类 Node 同步新 revision 并恢复
      // eligible；离线 Node binding 持久 suspended（旧 credential 无效），
      // 不阻塞恢复，回归后须 resync 才能再取 push credential（22.3-21）
      const newRevision = project.revision + 1;
      store.updateProject(project.project_id, { revision: newRevision, updated_at: now });
      for (const binding of store.listNodeProjectBindings(undefined, project.project_id)) {
        const node = store.getNode(binding.node_id);
        const onlineClass = !!node
          && (ONLINE_CLASS_NODE_STATUSES as readonly string[]).includes(node.status);
        store.updateNodeProjectBinding(binding.binding_id, onlineClass
          ? { applied_policy_revision: newRevision, write_credential_status: 'eligible', updated_at: now }
          : { write_credential_status: 'suspended', updated_at: now });
      }
      return stepOk();
    }
    case 'revalidate-plans': {
      // step 5（含 22.4-34 canary 子步）：首个迁移 plan 验证失败 → transition
      // failed 并保持 read-only（fail-closed），不继续批量
      const { plans, taskPlanIds } = projectPlansForRevalidate(store, project.project_id);
      if (plans.length === 0) return stepOk();
      const canary = plans[0]!;
      const canaryResult = validatePlanForFullMode(canary, taskPlanIds);
      if (!canaryResult.ok) {
        openIncident(
          store,
          project.project_id,
          'mode_transition.revalidate_canary_failed',
          'critical',
          'revalidate-plans canary 失败（fail-closed）',
          `canary plan ${canary.plan_id}: ${canaryResult.reason}`,
          row.transition_id,
        );
        return stepFailed('REVALIDATE_CANARY_FAILED', `canary plan ${canary.plan_id} 验证失败：${canaryResult.reason}`);
      }
      for (const plan of plans.slice(1)) {
        const result = validatePlanForFullMode(plan, taskPlanIds);
        if (!result.ok) {
          openIncident(
            store,
            project.project_id,
            'mode_transition.revalidate_failed',
            'critical',
            'revalidate-plans 批量验证失败（fail-closed）',
            `plan ${plan.plan_id}: ${result.reason}`,
            row.transition_id,
          );
          return stepFailed('REVALIDATE_PLAN_FAILED', `plan ${plan.plan_id} 验证失败：${result.reason}`);
        }
      }
      return stepOk();
    }
    case 'commit-mode': {
      // step 6：原子恢复 full + 清指针，随后才开放新 write claim
      store.updateProject(project.project_id, {
        execution_mode: 'full',
        status: 'active',
        write_capability_status: 'ready',
        mode_transition: null,
        mode_transition_id: '',
        mode_transition_step: null,
        revision: project.revision + 1,
        updated_at: now,
      });
      return stepOk();
    }
    default:
      return stepFailed('INVALID_STEP', `validating 方向不包含 step ${step}`);
  }
}

/* ── API 投影 ── */

/** durable 行 → API 投影（steps 按方向序列重建：当前指针之前 done）。 */
function rowToTransition(row: ProjectModeTransitionRow): V2ProjectModeTransition {
  const seq = stepSequenceForTransition(row);
  const idx = seq.indexOf(row.step);
  const apiStatus: V2ProjectModeTransition['status'] = row.status === 'completed'
    ? 'completed'
    : row.expired_at
      ? 'expired'
      : row.status === 'failed'
        ? 'rolled_back' // failed：fail-closed 回到切换前形态（保持 paused，可重试）
        : 'running';
  return {
    transition_id: row.transition_id,
    project_id: row.project_id ?? '',
    from_mode: fromV2ExecutionMode(row.from_mode),
    to_mode: fromV2ExecutionMode(row.to_mode),
    steps: seq.map((step, i) => ({
      step,
      status: i < idx || row.status === 'completed' ? 'done' : i === idx ? (apiStatus === 'running' ? 'pending' : apiStatus === 'rolled_back' ? 'failed' : 'done') : 'pending',
      updated_at: row.started_at,
    })),
    deadline_at: row.deadline_at,
    status: apiStatus,
  };
}

/* ── 推进 ── */

/** advance 单步驱动结果。 */
export interface AdvanceModeTransitionResult {
  transition: V2ProjectModeTransition;
  action: 'advanced' | 'waiting' | 'completed' | 'failed' | 'expired' | 'no-op';
  executed_step: V2ModeTransitionStep | null;
  next_step: V2ModeTransitionStep | null;
  /** waiting：未收口清单（22.3-18 报告）。 */
  pending: DrainChecklistItem[];
  error: { code: string; message: string } | null;
}

/**
 * 单步推进 mode transition（22.3-20/22.4-04 核心）：
 * 1. deadline 检查：超 24h → expired + RecoveryIsolation 留证；
 * 2. 先落库（重申 project 的 step 指针）再执行当前 step；
 * 3. 成功推进 step（commit-mode 成功即 completed）；waiting 停留本 step；
 *    硬失败置 failed（可重试，幂等重入）。
 */
export function advanceModeTransition(
  store: SqliteStore,
  projectId: string,
  transitionId: string,
): ApiResponse<AdvanceModeTransitionResult> {
  const row = store.getProjectModeTransition(transitionId);
  if (!row || row.project_id !== projectId) {
    return fail('NOT_FOUND', `transition ${transitionId} 不存在`);
  }
  const finish = (
    action: AdvanceModeTransitionResult['action'],
    extras: Partial<AdvanceModeTransitionResult> = {},
  ): ApiResponse<AdvanceModeTransitionResult> => {
    const fresh = store.getProjectModeTransition(transitionId)!;
    return ok({
      transition: rowToTransition(fresh),
      action,
      executed_step: extras.executed_step ?? null,
      next_step: extras.next_step ?? null,
      pending: extras.pending ?? [],
      error: extras.error ?? null,
    });
  };

  if (row.status === 'completed') {
    return finish('no-op');
  }
  if (row.status === 'failed') {
    return fail('INVALID_STATUS', `transition ${transitionId} status=failed（${row.expired_at ? '已超期' : '步骤失败'}），须先 retry`);
  }

  // 24h deadline（§12.1.1：双向总 deadline 均为 24 小时）
  const now = Date.now();
  if (now > row.deadline_at && !row.expired_at) {
    expireTransition(store, row, now);
    const fresh = store.getProjectModeTransition(transitionId)!;
    return ok({
      transition: rowToTransition(fresh),
      action: 'expired',
      executed_step: row.step,
      next_step: null,
      pending: [],
      error: { code: 'DEADLINE_EXCEEDED', message: `transition ${transitionId} 超过 24 小时 deadline（§12.1.1），已置 expired 并落 RecoveryIsolation` },
    });
  }
  if (row.expired_at) {
    return fail('TRANSITION_EXPIRED', `transition ${transitionId} 已超期（expired_at=${row.expired_at}），关闭需 RecoveryIsolation 三步分权复核`);
  }

  const project = store.getProject(projectId);
  if (!project) return fail('NOT_FOUND', `project ${projectId} 不存在`);

  const seq = stepSequenceForTransition(row);
  const idx = seq.indexOf(row.step);
  if (idx < 0) {
    return fail('INVALID_STEP', `transition ${transitionId} 的 step ${row.step} 不在 ${row.to_mode} 方向合法序列内`);
  }

  // 先落库：重申 durable step 指针（重启后 project 指针可能滞后于 transition 行）
  store.updateProject(projectId, {
    mode_transition: row.to_mode === 'read-only-acceptance' ? 'draining-to-read-only' : 'validating-to-full',
    mode_transition_id: row.transition_id,
    mode_transition_step: row.step,
    updated_at: now,
  });

  const result = row.to_mode === 'read-only-acceptance'
    ? executeDrainingStep(store, project, row, row.step)
    : executeValidatingStep(store, { ...project, mode_transition_step: row.step }, row, row.step);

  if (result.ok) {
    appendStepOutbox(store, row, row.step, idx);
    auditEvent(store, `mode_transition.step.${row.step}`, 'project_mode_transition', row.transition_id, 'mode-transition-engine', projectId);
    if (row.step === 'commit-mode') {
      store.updateProjectModeTransition(transitionId, {
        status: 'completed' as V2TransitionStatus,
        step: 'commit-mode',
        completed_at: now,
        last_error: '',
      });
      return finish('completed', { executed_step: 'commit-mode', next_step: null });
    }
    const next = seq[idx + 1]!;
    store.updateProjectModeTransition(transitionId, { step: next });
    store.updateProject(projectId, { mode_transition_step: next, updated_at: now });
    return finish('advanced', { executed_step: row.step, next_step: next });
  }

  if (result.pending && result.pending.length > 0) {
    // 未收口完成：停留本 step 并报告清单（不清 last_error 历史，追加等待原因）
    store.updateProjectModeTransition(transitionId, {
      last_error: `WAITING@${row.step}: ${result.pending.map((p) => `${p.kind}:${p.id}`).join(', ')}`.slice(0, 2000),
    });
    return finish('waiting', { executed_step: row.step, next_step: row.step, pending: result.pending });
  }

  store.updateProjectModeTransition(transitionId, {
    status: 'failed' as V2TransitionStatus,
    last_error: `${result.code}: ${result.message}`.slice(0, 2000),
  });
  return finish('failed', {
    executed_step: row.step,
    next_step: null,
    error: { code: result.code ?? 'STEP_FAILED', message: result.message ?? '' },
  });
}

/** 超 24h deadline：置 expired（status=failed + expired_at）并落 RecoveryIsolation（22.4-05）。 */
function expireTransition(store: SqliteStore, row: ProjectModeTransitionRow, now: number): void {
  const lastError = 'DEADLINE_EXCEEDED: mode transition 超过 24 小时 deadline（§12.1.1），保持 paused，关闭需 RecoveryIsolation 独立复核';
  store.updateProjectModeTransition(row.transition_id, {
    status: 'failed' as V2TransitionStatus,
    expired_at: now,
    last_error: lastError,
  });
  const projectId = row.project_id;
  const unresolved = projectId
    ? store.listRecoveryIsolations(projectId).find(
      (i) => i.object_type === 'mode-transition' && i.object_id === row.transition_id && i.status !== 'resolved',
    )
    : undefined;
  if (!unresolved) {
    const isolation: RecoveryIsolationRow = {
      isolation_id: `iso-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: projectId,
      transition_id: row.transition_id,
      object_type: 'mode-transition',
      object_id: row.transition_id,
      evidence_digest: createHash('sha256').update(`${row.transition_id}:${row.deadline_at}`, 'utf8').digest('hex'),
      reason: 'mode-transition-deadline-exceeded',
      status: 'isolated',
      isolated_by: 'mode-transition-engine',
      isolated_at: now,
      retention_until: now + RETENTION_MS,
      reviewed_by: '',
      reviewed_at: null,
      review_evidence_digest: '',
      resolved_by: '',
      resolved_at: null,
      resolution_evidence: '',
    };
    store.insertRecoveryIsolation(isolation);
  }
  openIncident(
    store,
    projectId,
    'mode_transition.deadline_exceeded',
    'critical',
    'mode transition 超 24 小时 deadline',
    `${row.transition_id} 停在 step ${row.step}，已置 expired 并隔离留证`,
    row.transition_id,
  );
  auditEvent(store, 'mode_transition.expired', 'project_mode_transition', row.transition_id, 'mode-transition-engine', projectId);
}

/**
 * 重启续跑（22.4-04）：服务启动/路由触发时扫描 running transition——
 * 未过期者从 durable step 继续执行一步；已超期者置 expired + 隔离留证。
 */
export function resumeInterruptedModeTransitions(store: SqliteStore): {
  resumed: Array<{ transition_id: string; action: AdvanceModeTransitionResult['action']; next_step: V2ModeTransitionStep | null }>;
  expired: string[];
} {
  const resumed: Array<{ transition_id: string; action: AdvanceModeTransitionResult['action']; next_step: V2ModeTransitionStep | null }> = [];
  const expired: string[] = [];
  for (const row of store.listProjectModeTransitions(undefined, 'running')) {
    if (!row.project_id) continue;
    if (Date.now() > row.deadline_at && !row.expired_at) {
      expireTransition(store, row, Date.now());
      expired.push(row.transition_id);
      continue;
    }
    const result = advanceModeTransition(store, row.project_id, row.transition_id);
    if (result.ok && result.data) {
      resumed.push({ transition_id: row.transition_id, action: result.data.action, next_step: result.data.next_step });
    }
  }
  return { resumed, expired };
}

/**
 * 自动推进：循环 advance 直到 completed/failed/expired/waiting 或步数上限
 * （POST mode-transitions 的 auto 选项与运维驱动共用）。
 */
export function runModeTransitionAuto(
  store: SqliteStore,
  projectId: string,
  transitionId: string,
  maxSteps = 12,
): ApiResponse<AdvanceModeTransitionResult> {
  let last: ApiResponse<AdvanceModeTransitionResult> | null = null;
  for (let i = 0; i < maxSteps; i += 1) {
    last = advanceModeTransition(store, projectId, transitionId);
    if (!last.ok || !last.data) return last;
    if (['completed', 'failed', 'expired', 'waiting'].includes(last.data.action)) return last;
  }
  return last ?? fail('NOT_FOUND', `transition ${transitionId} 不存在`);
}

/**
 * failed transition 重试（既有语义保留）：expired（deadline 超期）不可重试，
 * 须先走 RecoveryIsolation 三步分权关闭。
 */
export function retryModeTransition(store: SqliteStore, transitionId: string): ApiResponse<{ status: string; step: string }> {
  const row = store.getProjectModeTransition(transitionId);
  if (!row) return fail('NOT_FOUND', `transition ${transitionId} 不存在`);
  if (row.status !== 'failed') {
    return fail('INVALID_STATUS', `transition ${transitionId} status is ${row.status}, not failed`);
  }
  if (row.expired_at) {
    return fail('TRANSITION_EXPIRED', `transition ${transitionId} 已超期（24h deadline），须先关闭关联 RecoveryIsolation`);
  }
  store.updateProjectModeTransition(transitionId, {
    status: 'running' as V2TransitionStatus,
    last_error: '',
    started_at: Date.now(),
    completed_at: null,
  });
  return ok({ status: 'running', step: row.step });
}

/**
 * 22.3-21：离线 Node 回归后的 binding 重同步——校验 node 已重新上线后，把
 * applied_policy_revision 对齐当前 policy revision 才恢复 eligible（此后才可
 * 签发新的短期 push credential；离线期间旧 credential 一直无效）。
 */
export function resyncNodeProjectBinding(
  store: SqliteStore,
  nodeId: string,
  projectId: string,
): ApiResponse<{ binding_id: string; write_credential_status: string; applied_policy_revision: number }> {
  const binding = store.getNodeProjectBinding(nodeId, projectId);
  if (!binding) return fail('NOT_FOUND', `node ${nodeId} 在 project ${projectId} 无 binding`);
  const node = store.getNode(nodeId);
  if (!node || !(ONLINE_CLASS_NODE_STATUSES as readonly string[]).includes(node.status)) {
    return fail('NODE_NOT_ONLINE', `node ${nodeId} 尚未重新上线（当前 ${node?.status ?? 'unknown'}），不得恢复 push credential`);
  }
  const project = store.getProject(projectId);
  if (!project) return fail('NOT_FOUND', `project ${projectId} 不存在`);
  const now = Date.now();
  store.updateNodeProjectBinding(binding.binding_id, {
    applied_policy_revision: project.revision,
    write_credential_status: 'eligible',
    health: binding.health === 'unavailable' ? 'syncing' : binding.health,
    updated_at: now,
  });
  auditEvent(store, 'mode_transition.binding_resync', 'node_project_binding', binding.binding_id, 'node-rejoin', projectId);
  return ok({
    binding_id: binding.binding_id,
    write_credential_status: 'eligible',
    applied_policy_revision: project.revision,
  });
}

/* ================================================================== */
/* ProjectService 装配                                                  */
/* ================================================================== */

export function createProjectService(store: SqliteStore): ProjectService {
  return {
    async createProject(input, meta) {
      const now = Date.now();
      const projectId = `proj-${randomUUID().slice(0, 12)}`;

      const row: ProjectRow = {
        project_id: projectId,
        display_name: input.name,
        repository_url: input.repo_path,
        repository_fingerprint: '',
        default_branch: input.default_branch,
        merge_policy: 'merge-queue',
        execution_mode: toV2ExecutionMode(input.execution_mode),
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
      };

      store.insertProject(row);
      return ok(rowToProject(row));
    },

    async getProject(projectId, meta) {
      const row = store.getProject(projectId);
      if (!row) return ok(null);
      return ok(rowToProject(row));
    },

    async listProjects(page, meta) {
      const all = store.listProjects();
      const limit = Math.min(page.limit ?? 50, 500);
      const cursor = page.cursor;
      let startIdx = 0;
      if (cursor) {
        const idx = all.findIndex((r) => r.project_id === cursor);
        if (idx >= 0) startIdx = idx + 1;
      }
      const slice = all.slice(startIdx, startIdx + limit);
      const nextCursor = slice.length === limit ? slice[slice.length - 1]!.project_id : null;
      return ok({ items: slice.map(rowToProject), next_cursor: nextCursor });
    },

    async validateProject(projectId, meta) {
      const row = store.getProject(projectId);
      if (!row) return fail('NOT_FOUND', '项目不存在');
      return ok({ repo_reachable: true, ref_acl_available: true });
    },

    async updatePolicy(projectId, input, meta) {
      const row = store.getProject(projectId);
      if (!row) return fail('NOT_FOUND', '项目不存在');
      const now = Date.now();
      store.updateProject(projectId, { updated_at: now });
      return ok(rowToProject({ ...row, updated_at: now }));
    },

    async applyModeTransition(projectId, input, meta) {
      const row = store.getProject(projectId);
      if (!row) return fail('NOT_FOUND', '项目不存在');

      const currentMode = fromV2ExecutionMode(row.execution_mode);
      if (currentMode === input.to_mode) {
        return fail('INVALID_TRANSITION', `项目已是 ${input.to_mode} 模式`);
      }
      // §20.3：每个 project 同时最多一个 running transition（预检避免
      // 唯一索引错误直接 500）
      const running = store.listProjectModeTransitions(projectId, 'running');
      if (running.length > 0) {
        return fail('TRANSITION_IN_PROGRESS', `project ${projectId} 已有 running transition ${running[0]!.transition_id}（step=${running[0]!.step}）`);
      }

      const transitionId = `tr-${randomUUID().slice(0, 12)}`;
      const now = Date.now();
      // 22.3-20：deadline = 24 小时（MODE_TRANSITION_DEADLINE_MS，§12.1.1 矩阵；
      // 修正实现曾误用的 30 分钟）
      const deadlineAt = now + MODE_TRANSITION_DEADLINE_MS;

      store.insertProjectModeTransition({
        transition_id: transitionId,
        project_id: projectId,
        from_mode: row.execution_mode,
        to_mode: toV2ExecutionMode(input.to_mode),
        step: 'pause',
        status: 'running',
        idempotency_key: meta.idempotency_key,
        deadline_at: deadlineAt,
        last_error: '',
        started_at: now,
        completed_at: null,
      });

      store.updateProject(projectId, {
        mode_transition: input.to_mode === 'read_only' ? 'draining-to-read-only' : 'validating-to-full',
        mode_transition_id: transitionId,
        mode_transition_step: 'pause',
        updated_at: now,
      });

      auditEvent(store, 'mode_transition.apply', 'project_mode_transition', transitionId, meta.actor.actor_id || 'owner', projectId);

      // 创建即执行首个 step（pause），此后由 advance 单步驱动/自动推进
      const advanced = advanceModeTransition(store, projectId, transitionId);
      const fresh = store.getProjectModeTransition(transitionId)!;
      return ok(rowToTransition(fresh));
    },

    async getModeTransition(projectId, transitionId, meta) {
      const row = store.getProjectModeTransition(transitionId);
      if (!row || row.project_id !== projectId) return ok(null);
      return ok(rowToTransition(row));
    },

    async importPlan(projectId, input, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async getPlan(planId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async previewPlanSupersede(planId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async supersedePlan(planId, input, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async createBinding(projectId, input, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async getBinding(projectId, bindingId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async listBindings(projectId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async deleteBinding(projectId, bindingId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async connectAgent(projectId, agentId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async getRoster(projectId, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },

    async reserveTask(projectId, input, meta) {
      return fail('NOT_IMPLEMENTED', 'Phase 2+ 范围');
    },
  };
}
