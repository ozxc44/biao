import { describe, expect, it } from 'vitest';
import {
  acceptedProgress,
  countOnlineAgents,
  getPlanAttention,
  getPlanResolutionSummary,
  getStatusHintMessage,
  groupTasksForBoard,
  validatePlanId,
} from '../src/view-model';
import type { AgentInfo, PlanData, TaskSummary } from '../src/api';

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
