import type { Locale } from './i18n/translations';
import { createTranslator } from './i18n/translations';
import type {
  AgentInfo,
  ExecutionReceiptData,
  PlanData,
  PlanSummary,
  StatusData,
  TaskSummary,
} from './api';
import {
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
export interface RootTaskCard {
  root: TaskSummary;
  repairs: TaskSummary[];
  actionTask: TaskSummary;
  group: BoardGroupKey;
  auditOrigin?: 'rejected' | 'failed' | 'blocked';
  dataIssue?: string;
}
export interface RootProjectionIssue {
  task: TaskSummary;
  reason: string;
  group: BoardGroupKey;
}
export type RootAttemptRole = 'root' | 'repair' | 'reverify';
export interface RootAttemptTimelineItem {
  task: TaskSummary;
  role: RootAttemptRole;
  isCurrent: boolean;
  isResolvedBy: boolean;
  receipts?: ExecutionReceiptData[];
}
export type AcceptedClosureKind = 'original' | 'repair' | 'reverify';
export type AttemptAuditKind = 'failure' | 'rejected' | 'blocked' | 'cancelled' | 'superseded';
export interface AttemptAuditFact {
  kind: AttemptAuditKind;
  value: string;
}
export type RootTaskBoard = Record<BoardGroupKey, RootTaskCard[]> & {
  projectionIssues: RootProjectionIssue[];
};
export interface RootTaskBoardSummary {
  counts: Record<BoardGroupKey, number>;
  visibleTotal: number;
  declaredTotal: number;
  matchesDeclared: boolean;
  active: number;
  audit: number;
}
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

export interface GlobalStatusSummary {
  attention: {
    failed: number;
    rejected: number;
    needsPmDecision: number;
    staleRunningAgents: number;
  };
  history: {
    resolvedFailed: number;
    resolvedRejected: number;
    staleAgents: number;
  };
}

const ONLINE_AGENT_STATUSES = new Set(['idle', 'busy', 'online']);

export function countOnlineAgents(agents: AgentInfo[]): number {
  return agents.filter((agent) => ONLINE_AGENT_STATUSES.has(agent.status.toLowerCase())).length;
}

/** 首页直接消费服务端根任务投影，避免把 repair attempt 当成新增产品任务。 */
export function getPlanSummaryProgress(plan: PlanSummary, onlineAgents: number): PlanAttention & {
  total: number;
  percent: number;
} | null {
  const roots = plan.root_tasks;
  if (!roots) return null;
  const total = Math.max(0, roots.total - roots.cancelled);
  const accepted = roots.accepted;
  const pending = roots.pending;
  const repairing = roots.running + roots.blocked;
  let action: PlanAttentionAction = 'none';
  if (roots.needs_pm_decision > 0) action = 'decision';
  else if (roots.review_pending > 0) action = 'review';
  else if (pending + repairing > 0) action = onlineAgents > 0 ? 'wait_for_worker' : 'start_worker';
  else if (total > 0 && accepted === total) action = 'complete';
  return {
    accepted,
    total,
    percent: total > 0 ? Math.round((accepted / total) * 100) : 0,
    reviewPending: roots.review_pending,
    pending,
    repairing,
    resolved: 0,
    needsPmDecision: roots.needs_pm_decision,
    action,
  };
}

/**
 * 新服务把不可变审计总数与当前待处理异常分开；旧服务则安全退回 raw 计数。
 * 首页只能消费这里的 attention，避免已闭环历史继续显示为红色故障。
 */
export function getGlobalStatusSummary(
  status: Pick<StatusData, 'tasks' | 'reviews' | 'attention' | 'history'>,
): GlobalStatusSummary {
  return {
    attention: {
      failed: status.attention?.failed ?? status.tasks.failed,
      rejected: status.attention?.rejected ?? status.reviews?.rejected ?? 0,
      needsPmDecision: status.attention?.needs_pm_decision ?? 0,
      staleRunningAgents: status.attention?.stale_running_agents ?? 0,
    },
    history: {
      resolvedFailed: status.history?.resolved_failed ?? 0,
      resolvedRejected: status.history?.resolved_rejected ?? 0,
      staleAgents: status.history?.stale_agents ?? 0,
    },
  };
}

/** 在线 Agent 与失联但仍持有 running task 的 Agent 留在当前列表，其余仅作历史审计。 */
export function partitionAgents(agents: AgentInfo[]): { current: AgentInfo[]; history: AgentInfo[] } {
  const current: AgentInfo[] = [];
  const history: AgentInfo[] = [];
  for (const agent of agents) {
    const online = ONLINE_AGENT_STATUSES.has(agent.status.toLowerCase());
    const staleRunning = agent.current_task_status?.toLowerCase() === 'running';
    (online || staleRunning ? current : history).push(agent);
  }
  return { current, history };
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

/**
 * 面向人的看板以 plan 声明的根任务为单位。repair/reverify 是同一任务的不可变
 * 执行尝试，只进入 lineage，不再被渲染成新的产品任务卡；真正的验收动作仍指向
 * 当前 attempt，避免误 review 已被拒绝的旧 root。
 */
export function buildRootTaskBoard(tasks: TaskBuckets): RootTaskBoard {
  const semanticGroups = groupTasksForBoard(tasks);
  const normalized = BOARD_GROUP_KEYS.flatMap((group) =>
    semanticGroups[group].map((item) => ({ item, group })),
  );
  const byId = new Map(normalized.map(({ item }) => [item.task_id, item]));
  const sourceGroup = new Map(normalized.map(({ item, group }) => [item.task_id, group]));
  const roots = normalized.filter(({ item }) => isDeclaredRoot(item)).map(({ item }) => item);
  const childrenByRoot = new Map<string, TaskSummary[]>();
  const orphans: TaskSummary[] = [];

  const findRootId = (task: TaskSummary): string | null => {
    if (isDeclaredRoot(task)) return task.task_id;
    if (task.repair_root_task_id && byId.has(task.repair_root_task_id)) return task.repair_root_task_id;
    let cursor: TaskSummary | undefined = task;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32 && cursor?.fix_for; depth++) {
      if (visited.has(cursor.task_id)) return null;
      visited.add(cursor.task_id);
      cursor = byId.get(cursor.fix_for);
    }
    return cursor && !cursor.fix_for ? cursor.task_id : null;
  };

  for (const { item } of normalized) {
    if (isDeclaredRoot(item)) continue;
    const rootId = findRootId(item);
    if (!rootId || !byId.has(rootId)) {
      orphans.push(item);
      continue;
    }
    const children = childrenByRoot.get(rootId) ?? [];
    children.push(item);
    childrenByRoot.set(rootId, children);
    if (!item.fix_for && item.repair_root_task_id) {
      orphans.push(item);
    }
  }

  const empty = (): RootTaskBoard => ({
    pending: [], running: [], review_pending: [], accepted: [], rejected: [], failed: [],
    blocked: [], cancelled: [], superseded: [],
    projectionIssues: [],
  });
  const board = empty();

  const stableLineage = (root: TaskSummary, children: TaskSummary[]): TaskSummary[] => {
    const orderedIds = normalizeTaskIdList(root.resolution_task_ids);
    const indexed = new Map(children.map((child) => [child.task_id, child]));
    const ordered = orderedIds.flatMap((id) => indexed.has(id) ? [indexed.get(id)!] : []);
    const seen = new Set(ordered.map((child) => child.task_id));
    const remaining = children
      .filter((child) => !seen.has(child.task_id))
      .sort((a, b) => taskTimestamp(a) - taskTimestamp(b) || a.task_id.localeCompare(b.task_id));
    return [...ordered, ...remaining];
  };

  for (const root of roots) {
    const repairs = stableLineage(root, childrenByRoot.get(root.task_id) ?? []);
    const explicitActionTask = root.resolution_task_id
      ? repairs.find((task) => task.task_id === root.resolution_task_id)
      : undefined;
    const missingExplicitAction = Boolean(root.resolution_task_id && !explicitActionTask);
    const actionTask = missingExplicitAction ? root : explicitActionTask ?? repairs.at(-1) ?? root;
    const rootGroup = sourceGroup.get(root.task_id) ?? 'failed';
    const auditOrigin = rootGroup === 'rejected' || rootGroup === 'failed' || rootGroup === 'blocked'
      ? rootGroup
      : undefined;
    const resolution = root.resolution_status;
    let group: BoardGroupKey = rootGroup;
    let dataIssue: string | undefined;

    if (missingExplicitAction) {
      group = auditOrigin === 'rejected' ? 'rejected' : 'failed';
      dataIssue = 'explicit current repair is missing from this root lineage';
    } else if (resolution === 'resolved') {
      const resolvedBy = root.resolved_by_task
        ? repairs.find((task) => task.task_id === root.resolved_by_task)
        : undefined;
      const resolvedByReview = resolvedBy?.pm_review_status ?? resolvedBy?.review_status;
      if ((resolvedBy?.status ?? '').toLowerCase() === 'done' && resolvedByReview === 'accepted') {
        group = 'accepted';
      } else {
        group = auditOrigin === 'rejected' ? 'rejected' : 'failed';
        dataIssue = 'resolved root has no done and accepted repair in its own lineage';
      }
    } else if (resolution === 'cancelled') {
      group = 'cancelled';
      if (['pending', 'running', 'blocked'].includes((actionTask.status ?? '').toLowerCase())) {
        dataIssue = 'cancelled root still has an active repair';
      }
    } else if (resolution === 'needs_pm_decision' && ['pending', 'running', 'blocked'].includes((actionTask.status ?? '').toLowerCase())) {
      const actionStatus = (actionTask.status ?? '').toLowerCase();
      group = actionStatus === 'blocked' ? 'blocked' : 'running';
    } else if (resolution === 'needs_pm_decision' && (actionTask.status ?? '').toLowerCase() === 'done' && !(actionTask.pm_review_status ?? actionTask.review_status)) {
      group = 'review_pending';
    } else if (resolution === 'needs_pm_decision') {
      group = auditOrigin === 'rejected' ? 'rejected' : 'failed';
    } else if (resolution === 'required' || resolution === 'repairing') {
      const actionStatus = (actionTask.status ?? '').toLowerCase();
      const actionReview = actionTask.pm_review_status ?? actionTask.review_status;
      if (actionStatus === 'pending' || actionStatus === 'running') group = 'running';
      else if (actionStatus === 'blocked') group = 'blocked';
      else if (actionStatus === 'done' && !actionReview) group = 'review_pending';
      else if (actionStatus === 'done' && actionReview === 'rejected') group = 'rejected';
      else if (actionStatus === 'done' && actionReview === 'accepted') {
        group = 'failed';
        dataIssue = 'accepted repair has not closed its root';
      } else group = 'failed';
    }

    board[group].push({ root, repairs, actionTask, group, auditOrigin, dataIssue });
    if (dataIssue) board.projectionIssues.push({ task: root, reason: dataIssue, group });
  }

  for (const orphan of orphans) {
    board.projectionIssues.push({
      task: orphan,
      reason: 'repair lineage has no declared root',
      group: sourceGroup.get(orphan.task_id) ?? 'failed',
    });
  }
  return board;
}

/** 根卡下的完整不可变执行谱系；只改变展示，不改变根任务计数。 */
export function getRootAttemptTimeline(
  card: RootTaskCard,
  receipts?: readonly ExecutionReceiptData[],
): RootAttemptTimelineItem[] {
  return [card.root, ...card.repairs].map((task, index) => ({
    task,
    role: index === 0 ? 'root' : task.type === 'acceptance' ? 'reverify' : 'repair',
    isCurrent: task.task_id === card.actionTask.task_id,
    isResolvedBy: task.task_id === card.root.resolved_by_task,
    ...(receipts ? {
      receipts: receipts
        .filter((receipt) => receipt.task_id === task.task_id)
        .sort((a, b) => a.started_at - b.started_at || a.attempt_id.localeCompare(b.attempt_id)),
    } : {}),
  }));
}

/** 已验收根任务的用户可见闭环来源。 */
export function getAcceptedClosureKind(card: RootTaskCard): AcceptedClosureKind | null {
  if (card.group !== 'accepted') return null;
  if (card.root.resolution_status === 'resolved' && card.root.resolved_by_task) {
    return card.root.resolution_action === 'reverify' ? 'reverify' : 'repair';
  }
  return 'original';
}

/** 只返回真实存在的不可变审计字段，不根据状态猜测原因。 */
export function getAttemptAuditFacts(task: TaskSummary): AttemptAuditFact[] {
  return [
    task.failure_reason ? { kind: 'failure' as const, value: task.failure_reason } : null,
    task.pm_reject_reason ? { kind: 'rejected' as const, value: task.pm_reject_reason } : null,
    task.blocked_reason ? { kind: 'blocked' as const, value: task.blocked_reason } : null,
    task.cancel_reason ? { kind: 'cancelled' as const, value: task.cancel_reason } : null,
    task.superseded_reason ? { kind: 'superseded' as const, value: task.superseded_reason } : null,
  ].filter((fact): fact is AttemptAuditFact => fact !== null);
}

/** 让孤儿/损坏谱系可进入只读详情，同时仍不进入根任务看板计数。 */
export function projectionIssueToCard(issue: RootProjectionIssue): RootTaskCard {
  return {
    root: issue.task,
    repairs: [],
    actionTask: issue.task,
    group: issue.group,
    dataIssue: issue.reason,
  };
}

export function summarizeRootTaskBoard(
  board: RootTaskBoard,
  declaredTotal: number,
): RootTaskBoardSummary {
  const counts = Object.fromEntries(
    BOARD_GROUP_KEYS.map((group) => [group, board[group].length]),
  ) as Record<BoardGroupKey, number>;
  const visibleTotal = BOARD_GROUP_KEYS.reduce((sum, group) => sum + counts[group], 0);
  return {
    counts,
    visibleTotal,
    declaredTotal,
    matchesDeclared: visibleTotal === declaredTotal,
    active: counts.running + counts.review_pending,
    audit: counts.rejected + counts.failed,
  };
}

/** 同一状态内按最近一次状态变化倒序展示，时间相同时用任务 ID 保证顺序稳定。 */
export function sortRootTaskCardsNewest(cards: readonly RootTaskCard[]): RootTaskCard[] {
  return [...cards].sort((a, b) => {
    const timeDifference = rootCardTimestamp(b) - rootCardTimestamp(a);
    return timeDifference || b.root.task_id.localeCompare(a.root.task_id);
  });
}

export function getVisibleRootTaskCards(
  cards: readonly RootTaskCard[],
  expanded: boolean,
  limit = 5,
): RootTaskCard[] {
  const ordered = sortRootTaskCardsNewest(cards);
  return expanded ? ordered : ordered.slice(0, Math.max(0, limit));
}

/**
 * Root 卡只决定展示位置；PM Review 必须落到当前实际交付的 attempt。
 * 数据谱系异常时返回 null，避免静默验收另一个 repair 或旧 root。
 */
export function getRootCardReviewTarget(card: RootTaskCard): TaskSummary | null {
  if (card.group !== 'review_pending' || card.dataIssue) return null;
  const status = (card.actionTask.status ?? '').toLowerCase();
  const reviewStatus = card.actionTask.pm_review_status ?? card.actionTask.review_status;
  return status === 'done' && !reviewStatus ? card.actionTask : null;
}

function normalizeTaskIdList(value: TaskSummary['resolution_task_ids']): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function taskTimestamp(task: TaskSummary): number {
  return Math.max(
    task.updated_at ?? 0,
    task.pm_reviewed_at ?? 0,
    task.done_at ?? 0,
    task.claimed_at ?? 0,
    task.created_at ?? 0,
  );
}

function rootCardTimestamp(card: RootTaskCard): number {
  return Math.max(taskTimestamp(card.root), taskTimestamp(card.actionTask));
}

export function acceptedProgress(
  tasks: TaskBuckets,
  total: number,
): { accepted: number; total: number; percent: number } {
  const rootBoard = buildRootTaskBoard(tasks);
  const accepted = rootBoard.accepted.length;
  const cancelled = rootBoard.cancelled.length;
  const superseded = rootBoard.superseded.length;
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
  const rootBoard = buildRootTaskBoard(tasks);
  const declaredTasks = declaredTasksForProgress(groups);
  const resolution = summarizeResolutions(declaredTasks);
  const accepted = rootBoard.accepted.length;
  // 原任务的旧 done 交付在 repair/reverify 后不是可验收对象；真正待验收的是 repair。
  // 这样 PM 不会被引导到服务端会拒绝的旧 task review 入口。
  const reviewPending = rootBoard.review_pending.length;
  const pending = BOARD_GROUP_KEYS.flatMap((group) => rootBoard[group])
    .filter((card) => (card.actionTask.status ?? '').toLowerCase() === 'pending').length;
  const cancelled = rootBoard.cancelled.length;
  const superseded = rootBoard.superseded.length;
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
  return allGroupedTasks(groups).filter(isDeclaredRoot);
}

function isDeclaredRoot(task: TaskSummary): boolean {
  return !task.fix_for && (!task.repair_root_task_id || task.repair_root_task_id === task.task_id);
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
