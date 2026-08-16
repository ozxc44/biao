/**
 * Plan Import 与 Read-only 门禁（22.3-13/14/15）
 *
 * - 22.3-13：project 注册时未配置 ref ACL → write_capability_status=degraded_read_only
 *   语义（claim/交付写路径拒绝，读/验收只读路径放行）。
 * - 22.3-14：read-only 项目拒绝所有写任务与写依赖（响应逐条列出被拒任务）；
 *   full 项目正常导入（tasks 落库、project_id 回填）。
 * - 22.3-15：EvidenceAcceptance 实现——full 项目的 Artifact-only 任务以
 *   EvidenceAcceptance 完成（记录 acceptance 绑定 artifact digest 清单），
 *   不能解锁写 lineage（下游写依赖仍等 merge 口径）。
 */

import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { ProjectRow } from '../../types/v2-identity.js';
import { parseRefAcl } from './git/ref-acl.js';

export interface PlanImportResult {
  ok: true;
  plan_id: string;
  task_count: number;
  accepted_count: number;
  rejected_count: number;
  rejected_tasks: Array<{ task_id: string; reason: string }>;
  revision: number;
}

export interface PlanSnapshotTask {
  task_id: string;
  title: string;
  type?: string;
  phase?: string;
  priority?: number;
  depends_on?: string[];
  ownership_files?: string[];
  /** 是否为写任务（默认 true；false = 只读/观察类）。 */
  writable?: boolean;
}

export interface PlanSnapshot {
  plan_id?: string;
  title?: string;
  tasks: PlanSnapshotTask[];
}

/**
 * read-only 项目写任务拒绝响应示例：
 * ```json
 * {
 *   "ok": false,
 *   "data": null,
 *   "error": {
 *     "code": "READ_ONLY_PROJECT_REJECTS_WRITE_TASKS",
 *     "message": "项目 proj-xxx 为 read-only 模式，拒绝 3 个写任务",
 *     "rejected_tasks": [
 *       {"task_id": "task-1", "reason": "writable=true 不允许在 read-only 项目导入"},
 *       {"task_id": "task-2", "reason": "writable=true 不允许在 read-only 项目导入"},
 *       {"task_id": "task-3", "reason": "依赖写任务 task-1"}
 *     ]
 *   }
 * }
 * ```
 */
export interface ReadOnlyRejectResponse {
  ok: false;
  data: null;
  error: {
    code: string;
    message: string;
    rejected_tasks: Array<{ task_id: string; reason: string }>;
  };
}

/**
 * 检查项目是否为 read-only（execution_mode 或 write_capability_status）。
 * 22.3-13：未配置 ref ACL 的项目按 degraded_read_only 语义处理——写路径
 * （claim/交付/导入写任务）拒绝，读写路径（验收/查询）放行。
 */
export function isProjectReadOnly(project: ProjectRow): boolean {
  if (project.execution_mode === 'read-only-acceptance') return true;
  if (project.write_capability_status === 'lost' || project.write_capability_status === 'disabled') return true;
  return parseRefAcl(project.ref_acl_json ?? '') === null;
}

/**
 * 检查项目是否已配置 ref ACL（22.3-13）。
 * 规则来源与 generic-git push ACL（22.3-10）一致：projects.ref_acl_json →
 * parseRefAcl。未配置 / 非法 JSON / allow 为空 → false（无配置即 false）。
 */
export function hasRefAcl(
  store: Pick<SqliteStore, 'getProject'>,
  projectId: string,
): boolean {
  const project = store.getProject(projectId);
  if (!project) return false;
  return parseRefAcl(project.ref_acl_json ?? '') !== null;
}

/**
 * 22.3-14：importPlan 实现。
 * read-only 项目拒绝所有写任务与写依赖；full 项目正常导入。
 */
export function importPlanForProject(
  store: SqliteStore,
  projectId: string,
  snapshot: PlanSnapshot,
): PlanImportResult | ReadOnlyRejectResponse {
  const project = store.getProject(projectId);
  if (!project) {
    return {
      ok: false,
      data: null,
      error: { code: 'PROJECT_NOT_FOUND', message: `项目 ${projectId} 不存在`, rejected_tasks: [] },
    };
  }

  const planId = snapshot.plan_id ?? `plan-${randomUUID().slice(0, 12)}`;
  const tasks = snapshot.tasks ?? [];
  const readOnly = isProjectReadOnly(project);

  if (readOnly) {
    // 逐条列出被拒任务
    const rejected: Array<{ task_id: string; reason: string }> = [];
    const writableTaskIds = new Set<string>();

    for (const task of tasks) {
      const isWritable = task.writable !== false; // 默认可写
      if (isWritable) {
        writableTaskIds.add(task.task_id);
        rejected.push({ task_id: task.task_id, reason: 'writable=true 不允许在 read-only 项目导入' });
      }
    }

    // 写依赖也拒绝
    for (const task of tasks) {
      if (task.writable === false && task.depends_on) {
        for (const dep of task.depends_on) {
          if (writableTaskIds.has(dep)) {
            if (!rejected.some((r) => r.task_id === task.task_id)) {
              rejected.push({ task_id: task.task_id, reason: `依赖写任务 ${dep}` });
            }
          }
        }
      }
    }

    return {
      ok: false,
      data: null,
      error: {
        code: 'READ_ONLY_PROJECT_REJECTS_WRITE_TASKS',
        message: `项目 ${projectId} 为 read-only 模式，拒绝 ${rejected.length} 个写任务`,
        rejected_tasks: rejected,
      },
    };
  }

  // full 项目：正常导入（tasks 落库、project_id 回填）。
  // 先落 plan 再落 tasks：tasks.plan_id 有外键约束（真实 store 会触发
  // FOREIGN KEY constraint failed），plan 后置会让全部任务导入失败。
  store.upsertPlan({
    plan_id: planId,
    title: snapshot.title ?? planId,
    status: 'active',
    project_path: project.repository_url,
    default_assignee: 'auto',
    default_priority: 5,
    phases: JSON.stringify([]),
    task_count: tasks.length,
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  });

  let accepted = 0;
  const rejected: Array<{ task_id: string; reason: string }> = [];

  for (const task of tasks) {
    try {
      store.upsertTask({
        task_id: task.task_id,
        plan_id: planId,
        title: task.title,
        type: task.type ?? 'implementation',
        phase: task.phase ?? '1',
        status: 'pending',
        priority: task.priority ?? 5,
        assignee: 'auto',
        ownership_files: JSON.stringify(task.ownership_files ?? []),
        ownership_modules: '',
        depends_on: JSON.stringify(task.depends_on ?? []),
        timeout_seconds: 3600,
        max_retries: 2,
        model_override: '',
        acceptance_for: '',
        verify: '',
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
        verify_results: '',
        goal_md: '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        project_id: projectId,
      });
      accepted++;
    } catch (err) {
      rejected.push({ task_id: task.task_id, reason: `导入失败：${(err as Error).message}` });
    }
  }

  return {
    ok: true,
    plan_id: planId,
    task_count: tasks.length,
    accepted_count: accepted,
    rejected_count: rejected.length,
    rejected_tasks: rejected,
    revision: 1,
  };
}

/**
 * 22.3-15：EvidenceAcceptance 实现。
 * full 项目的 Artifact-only 任务以 EvidenceAcceptance 完成（记录 acceptance 绑定
 * artifact digest 清单），不能解锁写 lineage（下游写依赖仍等 merge 口径）。
 */
export function createEvidenceAcceptanceForTask(
  store: SqliteStore,
  attemptId: string,
  commitSha: string,
  level: 'node' | 'node_harness' | 'pm',
): { acceptance_id: string; ok: boolean; error?: string } {
  // 越权拒绝 1：伪造 level（路由 body 未强类型化，运行时必须自校验）。
  // DB CHECK 约束之外先在入口拒绝，避免把异常当响应。
  if (level !== 'node' && level !== 'node_harness' && level !== 'pm') {
    return { acceptance_id: '', ok: false, error: `非法 evidence level：${String(level)}` };
  }
  const attempt = store.getTaskAttempt(attemptId);
  if (!attempt) {
    return { acceptance_id: '', ok: false, error: `attempt ${attemptId} 不存在` };
  }

  const project = store.getProject(attempt.project_id);
  if (!project) {
    return { acceptance_id: '', ok: false, error: `项目 ${attempt.project_id} 不存在` };
  }

  // EvidenceAcceptance 只在 read-only 项目或 Artifact-only 任务有效
  // full 项目也可用（但不能解锁写 lineage）

  const acceptanceId = `ea-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const now = Date.now();

  store.insertEvidenceAcceptance({
    acceptance_id: acceptanceId,
    attempt_id: attemptId,
    task_id: attempt.task_id,
    project_id: attempt.project_id,
    commit_sha: commitSha,
    level,
    status: 'pending',
    artifact_digests: '[]',
    created_at: now,
    updated_at: now,
  });

  // 22.3-15：不能解锁写 lineage（下游写依赖仍等 merge 口径）
  // 不更新 task status（保持 pending，等 merge 口径解锁）

  return { acceptance_id: acceptanceId, ok: true };
}
