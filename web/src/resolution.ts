import type { TaskSummary } from './api';

export type ResolutionStatus = 'required' | 'repairing' | 'resolved' | 'needs_pm_decision';
export type ResolutionAction = 'repair' | 'reverify' | 'inspect';
export type ResolutionTone = 'amber' | 'blue' | 'green' | 'red';

export interface ResolutionPresentation {
  status: ResolutionStatus;
  action: ResolutionAction | null;
  tone: ResolutionTone;
}

export interface ResolutionSummary {
  required: number;
  repairing: number;
  resolved: number;
  needsPmDecision: number;
}

type ResolutionFields = Pick<
  TaskSummary,
  'resolution_status' | 'resolution_action' | 'pm_review_status' | 'review_status'
>;

const RESOLUTION_STATUSES = new Set<ResolutionStatus>([
  'required',
  'repairing',
  'resolved',
  'needs_pm_decision',
]);

const RESOLUTION_ACTIONS = new Set<ResolutionAction>(['repair', 'reverify', 'inspect']);

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 失败/拒绝的原始状态永远保留在任务本身；resolution 只描述后续闭环进度。
 * 对旧服务返回的未知值降级为 null，避免错误地把历史任务标为已修复。
 */
export function getResolutionPresentation(task: ResolutionFields): ResolutionPresentation | null {
  const rawStatus = normalize(task.resolution_status);
  if (!RESOLUTION_STATUSES.has(rawStatus as ResolutionStatus)) return null;

  const rawAction = normalize(task.resolution_action);
  const action = RESOLUTION_ACTIONS.has(rawAction as ResolutionAction)
    ? rawAction as ResolutionAction
    : null;

  const status = rawStatus as ResolutionStatus;
  const tone: ResolutionTone = status === 'resolved'
    ? 'green'
    : status === 'repairing'
      ? 'blue'
      : status === 'needs_pm_decision'
        ? 'red'
        : 'amber';

  return { status, action, tone };
}

/** 由独立修复任务验收闭环，与原任务的 failed/rejected 审计并存。 */
export function isEffectivelyAccepted(task: ResolutionFields): boolean {
  const resolution = getResolutionPresentation(task)?.status;
  // 一旦原任务进入 repair/reverify，旧的 accepted 审计不能再被当作完成。
  // 否则 UI 会把一个正在修复的任务错误计入进度，和服务端的依赖门禁相冲突。
  if (resolution) return resolution === 'resolved';
  const reviewStatus = normalize(task.pm_review_status || task.review_status);
  return reviewStatus === 'accepted';
}

export function summarizeResolutions(tasks: Iterable<ResolutionFields>): ResolutionSummary {
  const summary: ResolutionSummary = {
    required: 0,
    repairing: 0,
    resolved: 0,
    needsPmDecision: 0,
  };

  for (const task of tasks) {
    const status = getResolutionPresentation(task)?.status;
    if (status === 'required') summary.required += 1;
    if (status === 'repairing') summary.repairing += 1;
    if (status === 'resolved') summary.resolved += 1;
    if (status === 'needs_pm_decision') summary.needsPmDecision += 1;
  }
  return summary;
}

/** 兼容旧服务暂时以逗号串投影 resolution_task_ids 的情况。 */
export function normalizeResolutionTaskIds(value: TaskSummary['resolution_task_ids']): string[] {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim().length > 0);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}
