import { useEffect, useMemo, useState } from 'react';
import {
  cancelTask,
  fetchPlan,
  fetchTaskReview,
  resetTask,
  reviewTask,
  subscribeToEvents,
  type PlanData,
  type TaskReviewInfo,
  type TaskSummary,
  type VerifyResult,
} from '../api';
import { ResolutionStatus } from './ResolutionStatus';
import { useI18n } from '../i18n/I18nContext';
import { getGroupLabel, getResolutionActionLabel, getResolutionLabel, getStatusLabel } from '../i18n/status';
import { formatCountdown } from '../i18n/time';
import type { TFunction } from '../i18n/translations';
import { getResolutionPresentation, normalizeResolutionTaskIds } from '../resolution';
import { BOARD_GROUP_KEYS, groupTasksForBoard, type BoardGroupKey } from '../view-model';

interface SelectedTask {
  task: TaskSummary;
  group: BoardGroupKey;
}

export function PlanDetailView({ planId, authRevision }: { planId: string; authRevision: number }) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedTask | null>(null);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());

  const load = async () => {
    try {
      const next = await fetchPlan(planId);
      setPlan(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  useEffect(() => {
    let active = true;
    const guardedLoad = async () => {
      if (!active) return;
      await load();
    };
    void guardedLoad();
    const unsubscribe = subscribeToEvents(() => void guardedLoad());
    return () => {
      active = false;
      unsubscribe();
    };
    // load is intentionally recreated; planId/authRevision define the subscription lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, authRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => (plan ? groupTasksForBoard(plan.tasks) : null), [plan]);

  if (error && !plan) return <div className="notice error" role="alert">{t('common.loadFailed')}{error}</div>;
  if (!plan || !groups) return <div className="notice">{t('common.loadingPlan')}</div>;

  return (
    <main>
      {error && <div className="banner error" role="alert">{t('common.refreshFailed')}{error}</div>}
      {message && <div className="banner success" aria-live="polite">{message}</div>}
      <section className="plan-detail-header">
        <div>
          <p className="eyebrow">{plan.plan_id}</p>
          <h2>{plan.title || plan.plan_id}</h2>
          <p>{plan.project_path}</p>
        </div>
        <span className={`status-chip status-${plan.status}`}>{getStatusLabel(plan.status, t)}</span>
        <span className="section-summary">{t('planDetail.planTaskCount', { count: plan.task_count })}</span>
      </section>

      <section className="review-strip" aria-label={t('planDetail.reviewStripAriaLabel')}>
        <span><strong>{groups.review_pending.length}</strong> {getGroupLabel('review_pending', t)}</span>
        <span><strong>{groups.accepted.length}</strong> {getGroupLabel('accepted', t)}</span>
        <span><strong>{groups.rejected.length}</strong> {getGroupLabel('rejected', t)}</span>
        <span><strong>{groups.blocked.length}</strong> {getGroupLabel('blocked', t)}</span>
        <span><strong>{groups.cancelled.length}</strong> {getGroupLabel('cancelled', t)}</span>
      </section>

      <section className="board" aria-label={t('planDetail.boardAriaLabel')}>
        {BOARD_GROUP_KEYS.map((group) => (
          <div key={group} className={`board-column column-${group}`}>
            <div className="column-header">
              <span>{getGroupLabel(group, t)}</span>
              <span className="column-count">{groups[group].length}</span>
            </div>
            <div className="column-body">
              {groups[group].length === 0 && <div className="column-empty">{t('planDetail.columnEmpty')}</div>}
              {groups[group].map((task) => (
                <TaskCard
                  key={task.task_id}
                  task={task}
                  group={group}
                  now={now}
                  onOpen={() => setSelected({ task, group })}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      {selected && (
        <TaskDetails
          selected={selected}
          onClose={() => setSelected(null)}
          onChanged={async (nextMessage) => {
            setSelected(null);
            setMessage(nextMessage);
            await load();
          }}
        />
      )}
    </main>
  );
}

function TaskCard({
  task,
  group,
  now,
  onOpen,
}: {
  task: TaskSummary;
  group: BoardGroupKey;
  now: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const resolution = getResolutionPresentation(task);
  return (
    <article className={`task-card ${resolution?.status === 'resolved' ? 'task-card-resolved' : ''}`.trim()}>
      <button
        type="button"
        className="task-card-open"
        onClick={onOpen}
        aria-label={t('planDetail.taskCardOpenAria', { taskId: task.task_id })}
      >
        <div className="task-card-top">
          <span className="task-id">{task.task_id}</span>
          <span className="task-priority">P{task.priority}</span>
        </div>
        <strong className="task-title">{task.title}</strong>
        <div className="task-meta">
          <span className="tag">{task.type}</span>
          {task.phase && <span className="tag">{task.phase}</span>}
          <span className="tag assignee">→ {task.assignee || t('planDetail.assigneeUnassigned')}</span>
        </div>
        {task.claimed_by && <span className="task-agent">{t('planDetail.taskAgentLabel', { agent: task.claimed_by })}</span>}
        {group === 'running' && task.expire_at !== undefined && (
          <span className="countdown">{t('planDetail.leaseRemaining', { time: formatCountdown(task.expire_at - now, t) })}</span>
        )}
        {(task.failure_reason || task.blocked_reason || task.pm_reject_reason) && (
          <span className="task-reason">{task.failure_reason || task.blocked_reason || task.pm_reject_reason}</span>
        )}
        <ResolutionStatus task={task} />
        <span className="task-open-hint">{t('planDetail.viewDetailsHint')}</span>
      </button>
    </article>
  );
}

function TaskDetails({
  selected,
  onClose,
  onChanged,
}: {
  selected: SelectedTask;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const { task, group } = selected;
  const [review, setReview] = useState<TaskReviewInfo | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [comment, setComment] = useState('');
  const [rejectReason, setRejectReason] = useState(task.pm_reject_reason ?? '');
  const [fixInstructions, setFixInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setReviewError('');
    void fetchTaskReview(task.task_id)
      .then((data) => {
        if (!cancelled) setReview(data);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setReviewError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [task.task_id]);

  const mutate = async (confirmation: string, action: () => Promise<unknown>, success: string) => {
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setActionError('');
    try {
      await action();
      await onChanged(success);
    } catch (mutationError) {
      setActionError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    } finally {
      setBusy(false);
    }
  };

  const canReview = ['review_pending', 'rejected'].includes(group);
  const resolution = getResolutionPresentation(task);
  const canReviewCurrentTask = canReview && !resolution;
  const canReset = !['pending', 'cancelled'].includes(group) && !resolution;
  const canCancel = group === 'pending';
  const resultText = task.result_summary || review?.result_md || stringifyResult(task.result ?? review?.result_json);
  const verifyItems = normalizeVerify(review?.verify_results ?? task.verify_results ?? task.verify ?? []);
  const repairTaskIds = normalizeResolutionTaskIds(task.resolution_task_ids);
  const auditEntries = getAuditEntries(task, t);
  const showsResolutionContext = Boolean(
    resolution
    || task.fix_for
    || task.repair_root_task_id
    || task.resolution_task_id
    || task.resolved_by_task
    || repairTaskIds.length > 0,
  );

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <div className="drawer-header">
          <div>
            <p className="eyebrow">{task.task_id}</p>
            <h2 id="task-detail-title">{task.title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={t('planDetail.closeDrawerAria')}
          >
            ×
          </button>
        </div>

        <div className="detail-grid">
          <Detail label={t('planDetail.detailStatus')} value={getGroupLabel(group, t)} />
          <Detail
            label={t('planDetail.detailPmReview')}
            value={(task.pm_review_status || review?.pm_review_status)
              ? getStatusLabel(task.pm_review_status || review?.pm_review_status || '', t)
              : t('planDetail.pendingReview')}
          />
          <Detail
            label={t('planDetail.detailExecutingAgent')}
            value={task.claimed_by || review?.claimed_by || t('planDetail.assigneeUnassigned')}
          />
          <Detail
            label={t('planDetail.detailRetries')}
            value={`${task.retries ?? 0}${task.max_retries !== undefined ? ` / ${task.max_retries}` : ''}`}
          />
          <Detail label={t('planDetail.detailType')} value={task.type || '—'} />
          <Detail label={t('planDetail.detailAssignee')} value={task.assignee || t('planDetail.assigneeUnassigned')} />
          {resolution && <Detail label={t('planDetail.resolutionStatus')} value={getResolutionLabel(resolution.status, resolution.action, t)} />}
        </div>

        {auditEntries.length > 0 && (
          <section className="detail-section danger-panel">
            <h3>{t('planDetail.failureReasonHeading')}</h3>
            <div className="audit-list">
              {auditEntries.map((entry) => (
                <p key={entry.label}><strong>{entry.label}: </strong>{entry.reason}</p>
              ))}
            </div>
          </section>
        )}

        {showsResolutionContext && (
          <section className="detail-section resolution-panel">
            <div className="resolution-panel-heading">
              <h3>{t('planDetail.resolutionHeading')}</h3>
              <ResolutionStatus task={task} />
            </div>
            <dl className="resolution-details">
              {resolution && (
                <>
                  <dt>{t('planDetail.resolutionStatus')}</dt>
                  <dd>{getResolutionLabel(resolution.status, resolution.action, t)}</dd>
                  <dt>{t('planDetail.resolutionAction')}</dt>
                  <dd>{getResolutionActionLabel(resolution.action, t)}</dd>
                </>
              )}
              {task.resolution_task_id && (
                <>
                  <dt>{t('planDetail.resolutionCurrentTask')}</dt>
                  <dd><code>{task.resolution_task_id}</code></dd>
                </>
              )}
              {task.resolved_by_task && (
                <>
                  <dt>{t('planDetail.resolutionResolvedBy')}</dt>
                  <dd><code>{task.resolved_by_task}</code></dd>
                </>
              )}
              {task.fix_for && (
                <>
                  <dt>{t('planDetail.resolutionFixFor')}</dt>
                  <dd><code>{task.fix_for}</code></dd>
                </>
              )}
              {task.repair_root_task_id && task.repair_root_task_id !== task.task_id && (
                <>
                  <dt>{t('planDetail.resolutionRootTask')}</dt>
                  <dd><code>{task.repair_root_task_id}</code></dd>
                </>
              )}
              {task.pm_fix_instructions && (
                <>
                  <dt>{t('planDetail.fixInstructionsLabel')}</dt>
                  <dd>{task.pm_fix_instructions}</dd>
                </>
              )}
              {resolution && (task.resolution_attempts !== undefined || task.resolution_generation !== undefined) && (
                <>
                  <dt>{t('planDetail.resolutionAttempts')}</dt>
                  <dd>{t('planDetail.resolutionAttemptsValue', {
                    attempts: task.resolution_attempts ?? 0,
                    generation: task.resolution_generation ?? 0,
                  })}</dd>
                </>
              )}
            </dl>
            {repairTaskIds.length > 0 && (
              <div className="resolution-history">
                <span>{t('planDetail.resolutionHistory')}</span>
                <div className="file-list">{repairTaskIds.map((taskId) => <code key={taskId}>{taskId}</code>)}</div>
              </div>
            )}
          </section>
        )}

        <section className="detail-section">
          <h3>{t('planDetail.resultSummaryHeading')}</h3>
          {reviewError && <p className="inline-error">{t('planDetail.reviewLoadError')}{reviewError}</p>}
          {!review && !reviewError && <p className="muted">{t('planDetail.reviewLoading')}</p>}
          {resultText ? <pre>{resultText}</pre> : <p className="muted">{t('planDetail.noResultSummary')}</p>}
          {(review?.changed_files?.length ?? 0) > 0 && (
            <div className="file-list">
              {review?.changed_files.map((file) => <code key={file}>{file}</code>)}
            </div>
          )}
        </section>

        <section className="detail-section">
          <h3>{t('planDetail.verifyEvidenceHeading')}</h3>
          {verifyItems.length === 0 ? (
            <p className="muted">{t('planDetail.noVerifyResults')}</p>
          ) : (
            <div className="verify-list">
              {verifyItems.map((item, index) => (
                <article
                  key={`${item.cmd ?? 'verify'}-${index}`}
                  className={`verify-item ${item.passed === false ? 'failed' : item.passed === true ? 'passed' : ''}`}
                >
                  <code>{item.cmd || t('planDetail.verifyItemLabel', { index: index + 1 })}</code>
                  <strong>
                    {item.passed === true
                      ? t('planDetail.verifyPassed')
                      : item.passed === false
                        ? t('planDetail.verifyFailed')
                        : t('planDetail.verifyUnmarked')}
                  </strong>
                  {item.exit_code !== undefined && <span>{t('planDetail.exitCode', { code: item.exit_code })}</span>}
                </article>
              ))}
            </div>
          )}
        </section>

        {(task.depends_on.length > 0 || task.ownership_files.length > 0) && (
          <section className="detail-section">
            <h3>{t('planDetail.scopeDepsHeading')}</h3>
            {task.depends_on.length > 0 && <p>{t('planDetail.dependsOnPrefix')}{task.depends_on.join('、')}</p>}
            <div className="file-list">{task.ownership_files.map((file) => <code key={file}>{file}</code>)}</div>
          </section>
        )}

        {canReviewCurrentTask && (
          <section className="detail-section review-form">
            <h3>{t('planDetail.pmReviewHeading')}</h3>
            <label htmlFor="review-comment">{t('planDetail.reviewCommentLabel')}</label>
            <textarea
              id="review-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('planDetail.reviewCommentPlaceholder')}
            />
            <label htmlFor="reject-reason">{t('planDetail.rejectReasonLabel')}</label>
            <textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder={t('planDetail.rejectReasonPlaceholder')}
            />
            <label htmlFor="fix-instructions">{t('planDetail.fixInstructionsLabel')}</label>
            <textarea
              id="fix-instructions"
              value={fixInstructions}
              onChange={(event) => setFixInstructions(event.target.value)}
              placeholder={t('planDetail.fixInstructionsPlaceholder')}
            />
            <div className="button-row">
              <button
                type="button"
                className="btn success"
                disabled={busy}
                onClick={() => void mutate(
                  t('planDetail.confirmAccept', { taskId: task.task_id }),
                  () => reviewTask(task.task_id, { verdict: 'accept', comment: comment.trim(), reviewed_by: 'pm-web' }),
                  t('planDetail.successAccept', { taskId: task.task_id }),
                )}
              >{t('planDetail.acceptButton')}</button>
              <button
                type="button"
                className="btn danger"
                disabled={busy || !rejectReason.trim()}
                onClick={() => void mutate(
                  t('planDetail.confirmReject', { taskId: task.task_id }),
                  () => reviewTask(task.task_id, {
                    verdict: 'reject',
                    reject_reason: rejectReason.trim(),
                    fix_instructions: fixInstructions.trim(),
                    reviewed_by: 'pm-web',
                  }),
                  t('planDetail.successReject', { taskId: task.task_id }),
                )}
              >{t('planDetail.rejectButton')}</button>
            </div>
          </section>
        )}

        <section className="drawer-actions">
          {canReset && (
            <button
              type="button"
              className="btn warning"
              disabled={busy}
              onClick={() => void mutate(
                t('planDetail.confirmReset', { taskId: task.task_id }),
                () => resetTask(task.task_id, ['accepted', 'rejected', 'failed', 'review_pending'].includes(group)),
                t('planDetail.successReset', { taskId: task.task_id }),
              )}
            >{t('planDetail.resetButton')}</button>
          )}
          {canCancel && (
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void mutate(
                t('planDetail.confirmCancel', { taskId: task.task_id }),
                () => cancelTask(task.task_id),
                t('planDetail.successCancel', { taskId: task.task_id }),
              )}
            >{t('planDetail.cancelButton')}</button>
          )}
          <button type="button" className="btn secondary" onClick={onClose}>{t('common.close')}</button>
        </section>
        {actionError && <div className="banner error" role="alert">{t('common.actionFailed')}{actionError}</div>}
      </aside>
    </div>
  );
}

function getAuditEntries(task: TaskSummary, t: TFunction) {
  return [
    task.failure_reason ? { label: t('planDetail.auditFailure'), reason: task.failure_reason } : null,
    task.pm_reject_reason ? { label: t('planDetail.auditRejected'), reason: task.pm_reject_reason } : null,
    task.blocked_reason ? { label: t('planDetail.auditBlocked'), reason: task.blocked_reason } : null,
  ].filter((entry): entry is { label: string; reason: string } => entry !== null);
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function normalizeVerify(items: unknown[]): VerifyResult[] {
  return items.map((item) => {
    if (typeof item === 'object' && item !== null) return item as VerifyResult;
    return { cmd: String(item) };
  });
}

function stringifyResult(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
