import type { Locale } from './i18n/translations';
import { createTranslator } from './i18n/translations';
import type { AgentInfo, PlanData, StatusData, TaskSummary } from './api';
import {
  getResolutionPresentation,
  summarizeResolutions,
  type ResolutionSummary,
} from './resolution';

export const BOARD_GROUP_KEYS = [
  'pending',
  'running',
  'review_pending',
  'accepted',
  'rejected',
  'failed',
  'blocked',
  'cancelled',
  'superseded',
] as const;

export type BoardGroupKey = (typeof BOARD_GROUP_KEYS)[number];
export type TaskBuckets = PlanData['tasks'];
export type BoardGroups = Record<BoardGroupKey, TaskSummary[]>;
export type PlanAttentionAction = 'decision' | 'review' | 'start_worker' | 'wait_for_worker' | 'complete' | 'none';

export interface PlanAttention {
  accepted: number;
  reviewPending: number;
  pending: number;
  repairing: number;
  resolved: number;
  needsPmDecision: number;
  action: PlanAttentionAction;
}

const ONLINE_AGENT_STATUSES = new Set(['idle', 'busy', 'online']);

export function countOnlineAgents(agents: AgentInfo[]): number {
  return agents.filter((agent) => ONLINE_AGENT_STATUSES.has(agent.status.toLowerCase())).length;
}

/** 将服务端机器语义码翻译到当前 UI 语言；未知旧 hint 保留原文以兼容旧服务。 */
export function getStatusHintMessage(
  hint: StatusData['hint'],
  locale: Locale,
): string | null {
  if (!hint) return null;
  const t = createTranslator(locale);
  if (hint.code === 'NO_ONLINE_WORKERS') return t('projectList.hintNoOnlineWorkers');
  return hint.message ?? null;
}

export function groupTasksForBoard(tasks: TaskBuckets): BoardGroups {
  const groups: BoardGroups = {
    pending: [],
    running: [],
    review_pending: [],
    accepted: [],
    rejected: [],
    failed: [],
    blocked: [],
    cancelled: [],
    superseded: [],
  };
  const seen = new Set<string>();

  const sources: Array<[string, TaskSummary[]]> = [
    ['pending', tasks.pending ?? []],
    ['running', tasks.running ?? []],
    ['done', tasks.done ?? []],
    ['failed', tasks.failed ?? []],
    ['blocked', tasks.blocked ?? []],
    ['cancelled', tasks.cancelled ?? []],
    ['superseded', tasks.superseded ?? []],
  ];

  for (const [sourceStatus, sourceTasks] of sources) {
    for (const task of sourceTasks) {
      if (seen.has(task.task_id)) continue;
      seen.add(task.task_id);

      const status = (task.status || sourceStatus).toLowerCase();
      if (status === 'done') {
        const reviewStatus = task.pm_review_status ?? task.review_status;
        if (reviewStatus === 'accepted') groups.accepted.push(task);
        else if (reviewStatus === 'rejected') groups.rejected.push(task);
        else groups.review_pending.push(task);
      } else if (status in groups) {
        groups[status as BoardGroupKey].push(task);
      } else {
        groups.failed.push(task);
      }
    }
  }

  return groups;
}

export function acceptedProgress(
  tasks: TaskBuckets,
  total: number,
): { accepted: number; total: number; percent: number } {
  const groups = groupTasksForBoard(tasks);
  const declaredTasks = declaredTasksForProgress(groups);
  const accepted = countEffectiveAccepted(groups, declaredTasks);
  const cancelled = groups.cancelled.filter((task) => !task.fix_for).length;
  const superseded = (tasks.superseded ?? []).filter((task) => !task.fix_for).length;
  const effectiveTotal = Math.max(0, total - cancelled - superseded);
  return {
    accepted,
    total: effectiveTotal,
    percent: effectiveTotal > 0 ? Math.round((accepted / effectiveTotal) * 100) : 0,
  };
}

/** 只统计新闭环字段，不把失败/拒绝任务从其原始审计列移走。 */
export function getPlanResolutionSummary(tasks: TaskBuckets): ResolutionSummary {
  return summarizeResolutions(declaredTasksForProgress(groupTasksForBoard(tasks)));
}

/**
 * 将执行状态转成 PM 能安全执行的下一步。这里不触发任何写操作：
 * done 只是“已交付”，只有 accepted 才算完成；待验收始终压过启动新 Worker。
 */
export function getPlanAttention(
  tasks: TaskBuckets,
  total: number,
  onlineAgents: number,
): PlanAttention {
  const groups = groupTasksForBoard(tasks);
  const declaredTasks = declaredTasksForProgress(groups);
  const resolution = summarizeResolutions(declaredTasks);
  const accepted = countEffectiveAccepted(groups, declaredTasks);
  // 原任务的旧 done 交付在 repair/reverify 后不是可验收对象；真正待验收的是 repair。
  // 这样 PM 不会被引导到服务端会拒绝的旧 task review 入口。
  const reviewPending = groups.review_pending.filter((task) => !getResolutionPresentation(task)).length;
  const pending = groups.pending.length;
  const cancelled = groups.cancelled.filter((task) => !task.fix_for).length;
  const superseded = (tasks.superseded ?? []).filter((task) => !task.fix_for).length;
  const effectiveTotal = Math.max(0, total - cancelled - superseded);

  if (resolution.needsPmDecision > 0) {
    return {
      accepted,
      reviewPending,
      pending,
      repairing: resolution.repairing + resolution.required,
      resolved: resolution.resolved,
      needsPmDecision: resolution.needsPmDecision,
      action: 'decision',
    };
  }
  if (reviewPending > 0) {
    return {
      accepted,
      reviewPending,
      pending,
      repairing: resolution.repairing + resolution.required,
      resolved: resolution.resolved,
      needsPmDecision: resolution.needsPmDecision,
      action: 'review',
    };
  }
  if (pending > 0) {
    return {
      accepted,
      reviewPending,
      pending,
      repairing: resolution.repairing + resolution.required,
      resolved: resolution.resolved,
      needsPmDecision: resolution.needsPmDecision,
      action: onlineAgents > 0 ? 'wait_for_worker' : 'start_worker',
    };
  }
  if (effectiveTotal > 0 && accepted === effectiveTotal) {
    return {
      accepted,
      reviewPending,
      pending,
      repairing: resolution.repairing + resolution.required,
      resolved: resolution.resolved,
      needsPmDecision: resolution.needsPmDecision,
      action: 'complete',
    };
  }
  return {
    accepted,
    reviewPending,
    pending,
    repairing: resolution.repairing + resolution.required,
    resolved: resolution.resolved,
    needsPmDecision: resolution.needsPmDecision,
    action: 'none',
  };
}

function allGroupedTasks(groups: BoardGroups): TaskSummary[] {
  return BOARD_GROUP_KEYS.flatMap((group) => groups[group]);
}

/**
 * 自动 repair 是实现原任务闭环的内部工作，不应让静态 plan.task_count 的进度超过 100%。
 * 它仍留在看板和 PM Review 中，只有进度/完成口径按 source task 计算。
 */
function declaredTasksForProgress(groups: BoardGroups): TaskSummary[] {
  return allGroupedTasks(groups).filter((task) => !task.fix_for);
}

function countEffectiveAccepted(groups: BoardGroups, declaredTasks: TaskSummary[]): number {
  const directlyAccepted = new Set(
    groups.accepted
      .filter((task) => !task.fix_for && !getResolutionPresentation(task))
      .map((task) => task.task_id),
  );
  const resolvedSources = declaredTasks.filter(
    (task) => !directlyAccepted.has(task.task_id) && getResolutionPresentation(task)?.status === 'resolved',
  );
  return directlyAccepted.size + resolvedSources.length;
}

export function validatePlanId(planId: string, locale: Locale): string | null {
  const t = createTranslator(locale);
  const value = planId.trim();
  if (!value) return t('validation.planIdEmpty');
  if (value.length > 64) return t('validation.planIdTooLong');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return t('validation.planIdInvalid');
  }
  return null;
}
