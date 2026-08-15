import { describe, expect, it } from 'vitest';
import {
  acceptedProgress,
  BOARD_GROUP_KEYS,
  buildRootTaskBoard,
  summarizeRootTaskBoard,
  getRootCardReviewTarget,
  getRootAttemptTimeline,
  getAcceptedClosureKind,
  getAttemptAuditFacts,
  projectionIssueToCard,
  countOnlineAgents,
  getPlanAttention,
  getPlanSummaryProgress,
  getVisibleRootTaskCards,
  getPlanResolutionSummary,
  getGlobalStatusSummary,
  getStatusHintMessage,
  groupTasksForBoard,
  partitionAgents,
  validatePlanId,
} from '../src/view-model';
import type { AgentInfo, PlanData, PlanSummary, TaskSummary } from '../src/api';

function task(taskId: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    ownership_files: [],
    depends_on: [],
    ...overrides,
  };
}

function agent(agentId: string, status: string): AgentInfo {
  return {
    agent_id: agentId,
    agent_type: 'cli',
    status,
    current_task: '',
    last_heartbeat: 0,
  };
}

function taskBuckets(overrides: Partial<PlanData['tasks']> = {}): PlanData['tasks'] {
  return {
    pending: [],
    running: [],
    done: [],
    failed: [],
    ...overrides,
  };
}

describe('countOnlineAgents', () => {
  it('counts idle, busy, and legacy online agents but excludes stale and offline agents', () => {
    const agents = [
      agent('idle', 'idle'),
      agent('busy', 'busy'),
      agent('online', 'online'),
      agent('stale', 'stale'),
      agent('offline', 'offline'),
    ];

    expect(countOnlineAgents(agents)).toBe(3);
  });
});

describe('getPlanSummaryProgress', () => {
  it('uses root lifecycle counts and never inflates progress with repair attempts', () => {
    const plan: PlanSummary = {
      plan_id: 'root-count-plan', title: 'root-count-plan', status: 'failed', project_path: '/tmp',
      task_count: 21, runtime_task_count: 130,
      root_tasks: {
        total: 21, pending: 1, running: 2, blocked: 1, review_pending: 3,
        accepted: 12, failed: 0, needs_pm_decision: 1, cancelled: 1,
        declared_total: 21, consistent: true,
      },
    };
    expect(getPlanSummaryProgress(plan, 0)).toEqual({
      accepted: 12,
      total: 20,
      percent: 60,
      reviewPending: 3,
      pending: 1,
      repairing: 3,
      resolved: 0,
      needsPmDecision: 1,
      action: 'decision',
    });
  });
});

describe('getVisibleRootTaskCards', () => {
  it('shows only the latest five cards by default and all cards when expanded', () => {
    const cards = Array.from({ length: 7 }, (_, index) => {
      const root = task(`root-${index + 1}`, {
        status: 'done',
        pm_review_status: 'accepted',
        created_at: (index + 1) * 100,
      });
      return { root, actionTask: root, repairs: [], group: 'accepted' as const };
    });

    expect(getVisibleRootTaskCards(cards, false).map((card) => card.root.task_id))
      .toEqual(['root-7', 'root-6', 'root-5', 'root-4', 'root-3']);
    expect(getVisibleRootTaskCards(cards, true)).toHaveLength(7);
  });

  it('uses the current repair timestamp when ordering a root card', () => {
    const olderRoot = task('older-root', { created_at: 100 });
    const recentRepair = task('recent-repair', { created_at: 900, fix_for: olderRoot.task_id });
    const newerRoot = task('newer-root', { created_at: 500 });
    const cards = [
      { root: olderRoot, actionTask: recentRepair, repairs: [recentRepair], group: 'running' as const },
      { root: newerRoot, actionTask: newerRoot, repairs: [], group: 'running' as const },
    ];

    expect(getVisibleRootTaskCards(cards, false).map((card) => card.root.task_id))
      .toEqual(['older-root', 'newer-root']);
  });
});

describe('global status semantics', () => {
  it('uses attention counts for current red metrics and keeps resolved audit totals separate', () => {
    const status = {
      tasks: { pending: 0, running: 0, done: 4, failed: 3 },
      reviews: { pending: 0, accepted: 2, rejected: 2 },
      attention: { failed: 0, rejected: 0, needs_pm_decision: 0, stale_running_agents: 0 },
      history: { resolved_failed: 3, resolved_rejected: 2, stale_agents: 5 },
      ownership_conflicts: 0,
      plans: [],
      agents: [],
    };

    expect(getGlobalStatusSummary(status)).toEqual({
      attention: { failed: 0, rejected: 0, needsPmDecision: 0, staleRunningAgents: 0 },
      history: { resolvedFailed: 3, resolvedRejected: 2, staleAgents: 5 },
    });
  });

  it('partitions online and stale-running agents from idle or terminal stale history', () => {
    const agents = [
      agent('online', 'idle'),
      { ...agent('stale-running', 'stale'), current_task: 't-running', current_task_status: 'running' },
      { ...agent('stale-terminal', 'stale'), current_task: 't-done', current_task_status: 'done' },
      agent('stale-idle', 'stale'),
    ];

    const groups = partitionAgents(agents);
    expect(groups.current.map((item) => item.agent_id)).toEqual(['online', 'stale-running']);
    expect(groups.history.map((item) => item.agent_id)).toEqual(['stale-terminal', 'stale-idle']);
  });
});

describe('getStatusHintMessage', () => {
  it('uses the semantic hint code instead of leaking a server-side Chinese message into English UI', () => {
    const hint = {
      code: 'NO_ONLINE_WORKERS',
      message: '暂无在线 Worker。请先完成 bootstrap，再启动至少一个执行者。',
    };
    expect(getStatusHintMessage(hint, 'zh-CN')).toContain('暂无在线 Worker');
    expect(getStatusHintMessage(hint, 'en-US')).toBe('No Worker is online. Complete bootstrap, then start at least one worker.');
  });

  it('preserves an unknown legacy hint message as a compatibility fallback', () => {
    expect(getStatusHintMessage({ message: 'Legacy service hint' }, 'en-US')).toBe('Legacy service hint');
  });
});

describe('acceptedProgress', () => {
  it('uses only PM-accepted tasks as completed progress', () => {
    const tasks = taskBuckets({
      done: [
        task('raw-done', { status: 'done' }),
        task('accepted', { status: 'done', pm_review_status: 'accepted' }),
        task('rejected', { status: 'done', pm_review_status: 'rejected' }),
      ],
    });

    expect(acceptedProgress(tasks, 4)).toEqual({ accepted: 1, total: 4, percent: 25 });
  });

  it('accepts the backend review_status compatibility field', () => {
    const tasks = taskBuckets({
      done: [task('accepted-from-api', {
        status: 'done',
        review_status: 'accepted',
      } as Partial<TaskSummary>)],
    });

    expect(acceptedProgress(tasks, 1)).toEqual({ accepted: 1, total: 1, percent: 100 });
  });

  it('excludes cancelled tasks from the effective total while keeping failed and blocked work', () => {
    const tasks = taskBuckets({
      done: [task('accepted', { pm_review_status: 'accepted' })],
      failed: [task('failed', { status: 'failed' })],
      blocked: [task('blocked', { status: 'blocked' })],
      cancelled: [task('cancelled', { status: 'cancelled' })],
    });

    expect(acceptedProgress(tasks, 4)).toEqual({ accepted: 1, total: 3, percent: 33 });
  });

  it('excludes superseded declared tasks so a completed plan is not shown as 93% accepted', () => {
    const tasks = taskBuckets({
      done: [task('accepted', { status: 'done', pm_review_status: 'accepted' })],
      superseded: [task('withdrawn', { status: 'superseded' })],
    });

    expect(acceptedProgress(tasks, 2)).toEqual({ accepted: 1, total: 1, percent: 100 });
    expect(getPlanAttention(tasks, 2, 0)).toMatchObject({
      accepted: 1,
      reviewPending: 0,
      pending: 0,
      action: 'complete',
    });
  });

  it('excludes roots cancelled through the resolution lifecycle from the effective total', () => {
    const tasks = taskBuckets({
      done: [
        task('accepted', { status: 'done', pm_review_status: 'accepted' }),
        task('rejected-cancelled', {
          status: 'done', pm_review_status: 'rejected', resolution_status: 'cancelled',
        }),
      ],
      failed: [task('failed-cancelled', { status: 'failed', resolution_status: 'cancelled' })],
      cancelled: [task('direct-cancelled', { status: 'cancelled' })],
    });

    expect(buildRootTaskBoard(tasks).cancelled).toHaveLength(3);
    expect(acceptedProgress(tasks, 4)).toEqual({ accepted: 1, total: 1, percent: 100 });
    expect(getPlanAttention(tasks, 4, 0).action).toBe('complete');
  });
});

describe('getPlanAttention', () => {
  it('prioritizes PM acceptance and exposes delivered work separately from accepted progress', () => {
    const tasks = taskBuckets({
      done: [
        task('delivered', { status: 'done' }),
        task('accepted', { status: 'done', pm_review_status: 'accepted' }),
      ],
      pending: [task('queued', { status: 'pending' })],
    });

    expect(getPlanAttention(tasks, 3, 0)).toEqual({
      accepted: 1,
      reviewPending: 1,
      pending: 1,
      repairing: 0,
      resolved: 0,
      needsPmDecision: 0,
      action: 'review',
    });
  });

  it('asks for a Worker only when claimable work exists and no Worker is online', () => {
    const tasks = taskBuckets({ pending: [task('queued', { status: 'pending' })] });

    expect(getPlanAttention(tasks, 1, 0)).toMatchObject({
      accepted: 0,
      reviewPending: 0,
      pending: 1,
      action: 'start_worker',
    });
    expect(getPlanAttention(tasks, 1, 1).action).toBe('wait_for_worker');
  });

  it('marks a plan complete only after every non-cancelled task is accepted', () => {
    const tasks = taskBuckets({
      done: [task('accepted', { status: 'done', pm_review_status: 'accepted' })],
      cancelled: [task('cancelled', { status: 'cancelled' })],
    });

    expect(getPlanAttention(tasks, 2, 0)).toMatchObject({
      accepted: 1,
      reviewPending: 0,
      pending: 0,
      action: 'complete',
    });
  });

  it('prioritizes a repair loop that explicitly needs PM judgment over routine review or worker notices', () => {
    const tasks = taskBuckets({
      done: [task('delivered', { status: 'done' })],
      failed: [task('source', {
        status: 'failed',
        resolution_status: 'needs_pm_decision',
        resolution_action: 'inspect',
      })],
    });

    expect(getPlanAttention(tasks, 2, 1)).toMatchObject({
      reviewPending: 1,
      needsPmDecision: 1,
      action: 'decision',
    });
  });

  it('does not send PM back to an old delivered source while its repair is awaiting re-verification', () => {
    const tasks = taskBuckets({
      done: [task('old-source', {
        status: 'done',
        pm_review_status: 'accepted',
        resolution_status: 'required',
        resolution_action: 'reverify',
      })],
      pending: [task('old-source-repair-1', { status: 'pending', fix_for: 'old-source' })],
    });

    expect(acceptedProgress(tasks, 1)).toEqual({ accepted: 0, total: 1, percent: 0 });
    expect(getPlanAttention(tasks, 1, 1)).toMatchObject({
      accepted: 0,
      reviewPending: 0,
      pending: 1,
      repairing: 1,
      action: 'wait_for_worker',
    });
  });
});

describe('groupTasksForBoard', () => {
  it('separates raw done, accepted, rejected, blocked, cancelled, and superseded audit states', () => {
    const tasks = taskBuckets({
      done: [
        task('raw-done'),
        task('accepted', { pm_review_status: 'accepted' }),
        task('rejected', { pm_review_status: 'rejected' }),
      ],
      blocked: [task('blocked', { status: 'blocked' })],
      cancelled: [task('cancelled', { status: 'cancelled' })],
      superseded: [task('superseded', { status: 'superseded' })],
    });

    const groups = groupTasksForBoard(tasks);

    expect(groups.review_pending.map((item) => item.task_id)).toEqual(['raw-done']);
    expect(groups.accepted.map((item) => item.task_id)).toEqual(['accepted']);
    expect(groups.rejected.map((item) => item.task_id)).toEqual(['rejected']);
    expect(groups.blocked.map((item) => item.task_id)).toEqual(['blocked']);
    expect(groups.cancelled.map((item) => item.task_id)).toEqual(['cancelled']);
    expect(groups.superseded.map((item) => item.task_id)).toEqual(['superseded']);
  });

  it('uses a task status field when an older API places the task in a fallback bucket', () => {
    const tasks = taskBuckets({
      failed: [task('cancelled', { status: 'cancelled' }), task('blocked', { status: 'blocked' })],
    });

    const groups = groupTasksForBoard(tasks);

    expect(groups.failed).toHaveLength(0);
    expect(groups.blocked[0]?.task_id).toBe('blocked');
    expect(groups.cancelled[0]?.task_id).toBe('cancelled');
  });

  it('keeps a failed source task in its audit column while an independently accepted repair counts as completion', () => {
    const tasks = taskBuckets({
      failed: [task('source-failed', {
        status: 'failed',
        resolution_status: 'resolved',
        resolution_action: 'repair',
        resolved_by_task: 'source-failed-repair-1',
      })],
      done: [task('source-failed-repair-1', {
        status: 'done',
        pm_review_status: 'accepted',
        fix_for: 'source-failed',
      })],
    });

    const groups = groupTasksForBoard(tasks);
    expect(groups.failed.map((item) => item.task_id)).toEqual(['source-failed']);
    expect(acceptedProgress(tasks, 1)).toEqual({ accepted: 1, total: 1, percent: 100 });
    expect(getPlanResolutionSummary(tasks)).toMatchObject({ resolved: 1, repairing: 0, needsPmDecision: 0 });
    expect(getPlanAttention(tasks, 1, 0)).toMatchObject({ accepted: 1, resolved: 1, action: 'complete' });
  });
});

describe('buildRootTaskBoard', () => {
  it('keeps every recorded failure, review, cancellation, and supersede fact on the selected attempt', () => {
    const attempt = task('audited-attempt', {
      failure_reason: 'worker failed',
      pm_reject_reason: 'PM rejected',
      blocked_reason: 'waiting for owner',
      cancel_reason: 'cancelled by closure',
      superseded_reason: 'replaced by canonical task',
    });

    expect(getAttemptAuditFacts(attempt)).toEqual([
      { kind: 'failure', value: 'worker failed' },
      { kind: 'rejected', value: 'PM rejected' },
      { kind: 'blocked', value: 'waiting for owner' },
      { kind: 'cancelled', value: 'cancelled by closure' },
      { kind: 'superseded', value: 'replaced by canonical task' },
    ]);
  });

  it('builds a selectable immutable timeline from the root and every repair or reverify attempt', () => {
    const root = task('root', {
      status: 'done', pm_review_status: 'rejected', resolution_status: 'resolved',
      resolution_action: 'reverify', resolution_task_id: 'root-reverify-2',
      resolution_task_ids: ['root-repair-1', 'root-reverify-2'],
      resolved_by_task: 'root-reverify-2',
    });
    const repair = task('root-repair-1', {
      status: 'done', pm_review_status: 'rejected', fix_for: 'root', repair_root_task_id: 'root',
    });
    const reverify = task('root-reverify-2', {
      status: 'done', type: 'acceptance', pm_review_status: 'accepted',
      fix_for: 'root-repair-1', repair_root_task_id: 'root',
    });
    const card = {
      root, repairs: [repair, reverify], actionTask: reverify, group: 'accepted' as const,
      auditOrigin: 'rejected' as const,
    };

    expect(getRootAttemptTimeline(card)).toEqual([
      { task: root, role: 'root', isCurrent: false, isResolvedBy: false },
      { task: repair, role: 'repair', isCurrent: false, isResolvedBy: false },
      { task: reverify, role: 'reverify', isCurrent: true, isResolvedBy: true },
    ]);
  });

  it('labels accepted roots by the actual closure path without treating attempts as new roots', () => {
    const original = task('original', { status: 'done', pm_review_status: 'accepted' });
    const repairedRoot = task('repaired', {
      status: 'failed', resolution_status: 'resolved', resolution_action: 'repair',
      resolution_task_id: 'repaired-repair-1', resolution_task_ids: ['repaired-repair-1'],
      resolved_by_task: 'repaired-repair-1',
    });
    const repair = task('repaired-repair-1', {
      status: 'done', pm_review_status: 'accepted', fix_for: 'repaired', repair_root_task_id: 'repaired',
    });
    const reverifiedRoot = task('reverified', {
      status: 'failed', resolution_status: 'resolved', resolution_action: 'reverify',
      resolution_task_id: 'reverified-reverify-1', resolution_task_ids: ['reverified-reverify-1'],
      resolved_by_task: 'reverified-reverify-1',
    });
    const reverify = task('reverified-reverify-1', {
      status: 'done', type: 'acceptance', pm_review_status: 'accepted',
      fix_for: 'reverified', repair_root_task_id: 'reverified',
    });

    expect(getAcceptedClosureKind({ root: original, repairs: [], actionTask: original, group: 'accepted' })).toBe('original');
    expect(getAcceptedClosureKind({ root: repairedRoot, repairs: [repair], actionTask: repair, group: 'accepted' })).toBe('repair');
    expect(getAcceptedClosureKind({ root: reverifiedRoot, repairs: [reverify], actionTask: reverify, group: 'accepted' })).toBe('reverify');
  });

  it('shows an active current attempt ahead of a stale needs-PM-decision marker', () => {
    const tasks = taskBuckets({
      failed: [task('root', {
        status: 'failed', resolution_status: 'needs_pm_decision',
        resolution_task_id: 'root-reverify-3', resolution_task_ids: ['root-reverify-3'],
      })],
      running: [task('root-reverify-3', {
        status: 'running', fix_for: 'root', repair_root_task_id: 'root',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(board.running.map((card) => card.root.task_id)).toEqual(['root']);
    expect(board.failed).toHaveLength(0);
  });

  it('renders one logical card per declared root and folds repair attempts into its lineage', () => {
    const tasks = taskBuckets({
      done: [
        task('root-a', {
          status: 'done',
          pm_review_status: 'rejected',
          resolution_status: 'resolved',
          resolution_task_id: 'root-a-repair-2',
          resolution_task_ids: ['root-a-repair-1', 'root-a-repair-2'],
          resolved_by_task: 'root-a-repair-2',
        }),
        task('root-a-repair-1', {
          status: 'done', fix_for: 'root-a', repair_root_task_id: 'root-a', pm_review_status: 'rejected',
        }),
        task('root-a-repair-2', {
          status: 'done', fix_for: 'root-a-repair-1', repair_root_task_id: 'root-a', pm_review_status: 'accepted',
        }),
        task('root-b', { status: 'done', pm_review_status: 'accepted' }),
      ],
    });

    const board = buildRootTaskBoard(tasks);
    expect(BOARD_GROUP_KEYS.flatMap((group) => board[group])).toHaveLength(2);
    expect(new Set(board.accepted.map((card) => card.root.task_id))).toEqual(new Set(['root-a', 'root-b']));
    const rootA = board.accepted.find((card) => card.root.task_id === 'root-a');
    expect(rootA?.repairs.map((item) => item.task_id)).toEqual(['root-a-repair-1', 'root-a-repair-2']);
    expect(rootA?.auditOrigin).toBe('rejected');
  });

  it('uses the active repair as the action target without counting it as a second task', () => {
    const tasks = taskBuckets({
      done: [task('root', {
        status: 'done',
        pm_review_status: 'rejected',
        resolution_status: 'required',
        resolution_task_id: 'root-repair-1',
        resolution_task_ids: ['root-repair-1'],
      }), task('root-repair-1', {
        status: 'done', fix_for: 'root', repair_root_task_id: 'root',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(board.review_pending).toHaveLength(1);
    expect(board.review_pending[0].root.task_id).toBe('root');
    expect(board.review_pending[0].actionTask.task_id).toBe('root-repair-1');
    expect(getRootCardReviewTarget(board.review_pending[0])?.task_id).toBe('root-repair-1');
  });

  it('fails closed when an explicit current repair pointer is missing instead of reviewing another attempt', () => {
    const tasks = taskBuckets({
      done: [task('root', {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'required',
        resolution_task_id: 'missing-repair', resolution_task_ids: ['root-repair-1'],
      }), task('root-repair-1', {
        status: 'done', fix_for: 'root', repair_root_task_id: 'root',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(board.review_pending).toHaveLength(0);
    const auditCard = [...board.rejected, ...board.failed][0];
    expect(auditCard).toBeTruthy();
    expect(auditCard.actionTask.task_id).toBe('root');
    expect(auditCard.dataIssue).toMatch(/current repair/i);
    expect(getRootCardReviewTarget(auditCard)).toBeNull();
  });

  it('fails closed when the explicit current repair belongs to another root', () => {
    const tasks = taskBuckets({
      done: [
        task('root-a', {
          status: 'done', pm_review_status: 'rejected', resolution_status: 'required',
          resolution_task_id: 'root-b-repair', resolution_task_ids: ['root-a-repair'],
        }),
        task('root-a-repair', {
          status: 'done', fix_for: 'root-a', repair_root_task_id: 'root-a',
        }),
        task('root-b', {
          status: 'done', pm_review_status: 'rejected', resolution_status: 'required',
          resolution_task_id: 'root-b-repair', resolution_task_ids: ['root-b-repair'],
        }),
        task('root-b-repair', {
          status: 'done', fix_for: 'root-b', repair_root_task_id: 'root-b',
        }),
      ],
    });

    const board = buildRootTaskBoard(tasks);
    const rootA = BOARD_GROUP_KEYS.flatMap((group) => board[group])
      .find((card) => card.root.task_id === 'root-a');
    expect(rootA?.dataIssue).toMatch(/current repair/i);
    expect(rootA && getRootCardReviewTarget(rootA)).toBeNull();
    expect(getRootCardReviewTarget(board.review_pending[0])?.task_id).toBe('root-b-repair');
  });

  it('does not accept a resolved root unless resolved_by is its own done and accepted repair', () => {
    const tasks = taskBuckets({
      done: [task('root', {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'resolved',
        resolution_task_id: 'root-repair-1', resolution_task_ids: ['root-repair-1'],
        resolved_by_task: 'root-repair-1',
      }), task('root-repair-1', {
        status: 'done', fix_for: 'root', repair_root_task_id: 'root', pm_review_status: 'rejected',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(board.accepted).toHaveLength(0);
    expect(board.rejected).toHaveLength(1);
    expect(board.rejected[0].dataIssue).toMatch(/resolved/i);
    expect(acceptedProgress(tasks, 1)).toEqual({ accepted: 0, total: 1, percent: 0 });
    expect(getPlanAttention(tasks, 1, 0).action).not.toBe('complete');
  });

  it('keeps orphan repair records out of the declared root card count and exposes a projection issue', () => {
    const tasks = taskBuckets({
      done: [task('root', { status: 'done', pm_review_status: 'accepted' })],
      failed: [task('orphan-repair', {
        status: 'failed', fix_for: 'missing-parent', repair_root_task_id: 'missing-root',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(BOARD_GROUP_KEYS.flatMap((group) => board[group])).toHaveLength(1);
    expect(board.projectionIssues.map((issue) => issue.task.task_id)).toEqual(['orphan-repair']);
    const orphanCard = projectionIssueToCard(board.projectionIssues[0]);
    expect(orphanCard.root.task_id).toBe('orphan-repair');
    expect(orphanCard.group).toBe('failed');
    expect(BOARD_GROUP_KEYS.flatMap((group) => board[group])).not.toContain(orphanCard);
  });

  it('folds a legacy attempt with repair_root_task_id but no fix_for into its root and reports the malformed lineage', () => {
    const tasks = taskBuckets({
      done: [
        task('root', { status: 'done', pm_review_status: 'accepted' }),
        task('legacy-attempt', {
          status: 'done', pm_review_status: 'rejected', repair_root_task_id: 'root',
        }),
      ],
    });

    const board = buildRootTaskBoard(tasks);
    expect(BOARD_GROUP_KEYS.flatMap((group) => board[group])).toHaveLength(1);
    expect(board.accepted[0].repairs.map((item) => item.task_id)).toContain('legacy-attempt');
    expect(board.projectionIssues.map((issue) => issue.task.task_id)).toContain('legacy-attempt');
  });

  it('includes root card data issues in the projection issue summary', () => {
    const tasks = taskBuckets({
      done: [task('root', {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'repairing',
        resolution_task_id: 'missing-repair', resolution_task_ids: ['missing-repair'],
      })],
    });

    const board = buildRootTaskBoard(tasks);
    const rootCard = BOARD_GROUP_KEYS.flatMap((group) => board[group])
      .find((card) => card.root.task_id === 'root');
    expect(rootCard?.dataIssue).toBeTruthy();
    expect(board.projectionIssues.map((issue) => issue.task.task_id)).toEqual(['root']);
  });

  it('summarizes mutually exclusive root cards against the declared task count', () => {
    const tasks = taskBuckets({
      pending: [task('pending', { status: 'pending' })],
      running: [task('running', { status: 'running' })],
      done: [
        task('review', { status: 'done' }),
        task('accepted', { status: 'done', pm_review_status: 'accepted' }),
        task('rejected', { status: 'done', pm_review_status: 'rejected' }),
      ],
      failed: [task('failed', { status: 'failed' })],
      blocked: [task('blocked', { status: 'blocked' })],
      cancelled: [task('cancelled', { status: 'cancelled' })],
      superseded: [task('superseded', { status: 'superseded' })],
    });

    const summary = summarizeRootTaskBoard(buildRootTaskBoard(tasks), 9);
    expect(summary.visibleTotal).toBe(9);
    expect(summary.matchesDeclared).toBe(true);
    expect(summary.active).toBe(2);
    expect(summary.audit).toBe(2);
    expect(summarizeRootTaskBoard(buildRootTaskBoard(tasks), 10).matchesDeclared).toBe(false);
  });

  it('keeps an accepted child with an unresolved root out of accepted', () => {
    const tasks = taskBuckets({
      done: [task('root', {
        status: 'done', pm_review_status: 'rejected', resolution_status: 'repairing',
        resolution_task_id: 'root-repair-1', resolution_task_ids: ['root-repair-1'],
      }), task('root-repair-1', {
        status: 'done', fix_for: 'root', repair_root_task_id: 'root', pm_review_status: 'accepted',
      })],
    });

    const board = buildRootTaskBoard(tasks);
    expect(board.accepted).toHaveLength(0);
    expect(board.failed).toHaveLength(1);
    expect(board.failed[0].dataIssue).toBeTruthy();
  });
});

describe('validatePlanId', () => {
  it('accepts safe ids and rejects whitespace, path separators, and oversized ids in Chinese', () => {
    expect(validatePlanId('20260812-product_alpha', 'zh-CN')).toBeNull();
    expect(validatePlanId('bad id', 'zh-CN')).toMatch(/字母/);
    expect(validatePlanId('../bad', 'zh-CN')).toMatch(/字母/);
    expect(validatePlanId('a'.repeat(65), 'zh-CN')).toMatch(/64/);
  });

  it('returns English messages when locale is en-US', () => {
    expect(validatePlanId('', 'en-US')).toMatch(/required/i);
    expect(validatePlanId('bad id', 'en-US')).toMatch(/allowed/i);
    expect(validatePlanId('a'.repeat(65), 'en-US')).toMatch(/64/i);
  });
});
