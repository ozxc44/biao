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
import { buildWorkerConnectionGuide } from '../guides';
import { getGroupLabel, getResolutionActionLabel, getResolutionLabel, getStatusLabel } from '../i18n/status';
import { formatCountdown } from '../i18n/time';
import type { TFunction } from '../i18n/translations';
import { getResolutionPresentation } from '../resolution';
import {
  buildRootTaskBoard,
  getAcceptedClosureKind,
  getAttemptAuditFacts,
  getRootAttemptTimeline,
  getVisibleRootTaskCards,
  getRootCardReviewTarget,
  projectionIssueToCard,
  summarizeRootTaskBoard,
  type BoardGroupKey,
  type RootTaskCard,
} from '../view-model';
import CopyButton from './CopyButton';

interface SelectedTask {
  card: RootTaskCard;
  group: BoardGroupKey;
}

const BOARD_COLUMNS: ReadonlyArray<{ key: string; groups: readonly BoardGroupKey[] }> = [
  { key: 'pending', groups: ['pending'] },
  { key: 'active', groups: ['running', 'review_pending'] },
  { key: 'audit', groups: ['rejected', 'failed'] },
  { key: 'accepted', groups: ['accepted'] },
  { key: 'blocked', groups: ['blocked'] },
  { key: 'cancelled', groups: ['cancelled'] },
  { key: 'superseded', groups: ['superseded'] },
];

const COLLAPSED_GROUP_LIMIT = 5;

export function PlanDetailView({ planId, authRevision }: { planId: string; authRevision: number }) {
  const { locale, t } = useI18n();
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedTask | null>(null);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [expandedGroups, setExpandedGroups] = useState<Set<BoardGroupKey>>(() => new Set());

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
    setExpandedGroups(new Set());
  }, [planId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => (plan ? buildRootTaskBoard(plan.tasks) : null), [plan]);

  if (error && !plan) return <div className="notice error" role="alert">{t('common.loadFailed')}{error}</div>;
  if (!plan || !groups) return <div className="notice">{t('common.loadingPlan')}</div>;
  const declaredTaskCount = plan.declared_task_count ?? plan.task_count;
  const rootSummary = summarizeRootTaskBoard(groups, declaredTaskCount);
  const showsRuntimeAttempts = plan.runtime_task_count !== undefined
    && plan.runtime_task_count !== declaredTaskCount;

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
        <div className="plan-detail-actions">
          <CopyButton
            text={buildWorkerConnectionGuide(locale, serviceOrigin(), {
              planId: plan.plan_id,
              projectPath: plan.project_path,
            })}
            label={t('planDetail.copyWorkerGuideButton')}
          />
          <span className={`status-chip status-${plan.status}`}>{getStatusLabel(plan.status, t)}</span>
          <span className="section-summary">{t('planDetail.planTaskCount', { count: declaredTaskCount })}</span>
          {showsRuntimeAttempts && (
            <span className="section-summary">{t('planDetail.runtimeAttempts', {
              runtime: plan.runtime_task_count ?? declaredTaskCount,
              declared: declaredTaskCount,
            })}</span>
          )}
        </div>
      </section>

      {(!rootSummary.matchesDeclared || groups.projectionIssues.length > 0) && (
        <div className="banner error" role="alert">
          {!rootSummary.matchesDeclared && t('planDetail.rootCountMismatch', {
            visible: rootSummary.visibleTotal,
            declared: rootSummary.declaredTotal,
          })}
          {!rootSummary.matchesDeclared && groups.projectionIssues.length > 0 && ' · '}
          {groups.projectionIssues.length > 0 && `${t('planDetail.lineageDataIssue')}（${groups.projectionIssues.length}）`}
        </div>
      )}

      {groups.projectionIssues.length > 0 && (
        <details className="detail-section danger-panel">
          <summary>{t('planDetail.projectionIssuesHeading', { count: groups.projectionIssues.length })}</summary>
          <div className="verify-list">
            {groups.projectionIssues.map((issue, index) => (
              <button
                key={`${issue.task.task_id}-${index}`}
                type="button"
                className="btn secondary"
                onClick={() => setSelected({ card: projectionIssueToCard(issue), group: issue.group })}
                aria-label={t('planDetail.projectionIssueOpen', { taskId: issue.task.task_id })}
              >
                <code>{issue.task.task_id}</code> · {issue.reason}
              </button>
            ))}
          </div>
        </details>
      )}

      <section className="review-strip" aria-label={t('planDetail.reviewStripAriaLabel')}>
        <span><strong>{groups.pending.length}</strong> {getGroupLabel('pending', t)}</span>
        <span><strong>{rootSummary.active}</strong> {t('planDetail.columnActive')}</span>
        <span><strong>{rootSummary.audit}</strong> {t('planDetail.columnAudit')}</span>
        <span><strong>{groups.accepted.length}</strong> {getGroupLabel('accepted', t)}</span>
        <span><strong>{groups.blocked.length}</strong> {getGroupLabel('blocked', t)}</span>
        <span><strong>{groups.cancelled.length}</strong> {getGroupLabel('cancelled', t)}</span>
        <span><strong>{groups.superseded.length}</strong> {getGroupLabel('superseded', t)}</span>
      </section>

      <section className="board" aria-label={t('planDetail.boardAriaLabel')}>
        {BOARD_COLUMNS.map((column) => {
          const cards = column.groups.flatMap((group) => groups[group]);
          return <div key={column.key} className={`board-column column-${column.key}`}>
            <div className="column-header">
              <span>{column.key === 'active'
                ? t('planDetail.columnActive')
                : column.key === 'audit'
                  ? t('planDetail.columnAudit')
                  : getGroupLabel(column.groups[0], t)}</span>
              <span className="column-count">{cards.length}</span>
            </div>
            <div className="column-body">
              {cards.length === 0 && <div className="column-empty">{t('planDetail.columnEmpty')}</div>}
              {column.groups.map((group) => {
                if (groups[group].length === 0) return null;
                const expanded = expandedGroups.has(group);
                const groupCards = groups[group];
                const visibleCards = getVisibleRootTaskCards(groupCards, expanded, COLLAPSED_GROUP_LIMIT);
                return (
                  <section key={group} className={`column-subgroup column-${group}`} data-board-group={group}>
                    {column.groups.length > 1 && (
                      <div className="column-subgroup-title">
                        <span>{getGroupLabel(group, t)}</span><span>{groupCards.length}</span>
                      </div>
                    )}
                    {visibleCards.map((card) => (
                      <TaskCard
                        key={card.root.task_id}
                        card={card}
                        group={group}
                        now={now}
                        onOpen={() => setSelected({
                          card,
                          group,
                        })}
                      />
                    ))}
                    {groupCards.length > COLLAPSED_GROUP_LIMIT && (
                      <button
                        type="button"
                        className="column-expand-button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })}
                      >
                        {expanded
                          ? t('planDetail.collapseGroup', { count: COLLAPSED_GROUP_LIMIT })
                          : t('planDetail.expandGroup', { count: groupCards.length })}
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
          </div>;
        })}
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
  card,
  group,
  now,
  onOpen,
}: {
  card: RootTaskCard;
  group: BoardGroupKey;
  now: number;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const task = card.root;
  const activeTask = card.actionTask;
  const resolution = getResolutionPresentation(task);
  const closureKind = getAcceptedClosureKind(card);
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
        {closureKind && (
          <span className="tag">
            {closureKind === 'original'
              ? t('planDetail.closureOriginal')
              : closureKind === 'reverify'
                ? t('planDetail.closureReverify')
                : t('planDetail.closureRepair')}
          </span>
        )}
        {activeTask.task_id !== task.task_id && <span className="tag repair-tag">{activeTask.task_id}</span>}
        {activeTask.claimed_by && <span className="task-agent">{t('planDetail.taskAgentLabel', { agent: activeTask.claimed_by })}</span>}
        {group === 'running' && activeTask.expire_at !== undefined && (
          <span className="countdown">{t('planDetail.leaseRemaining', { time: formatCountdown(activeTask.expire_at - now, t) })}</span>
        )}
        {(activeTask.failure_reason || activeTask.blocked_reason || activeTask.pm_reject_reason || task.failure_reason || task.pm_reject_reason) && (
          <span className="task-reason">{activeTask.failure_reason || activeTask.blocked_reason || activeTask.pm_reject_reason || task.failure_reason || task.pm_reject_reason}</span>
        )}
        {card.dataIssue && <span className="task-reason">{t('planDetail.lineageDataIssue')}</span>}
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
  const { locale, t } = useI18n();
  const { card, group } = selected;
  const { actionTask, root, repairs } = card;
  const timeline = getRootAttemptTimeline(card);
  const [selectedAttemptId, setSelectedAttemptId] = useState(actionTask.task_id);
  const task = timeline.find((item) => item.task.task_id === selectedAttemptId)?.task ?? actionTask;
  const [review, setReview] = useState<TaskReviewInfo | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [comment, setComment] = useState('');
  const [rejectReason, setRejectReason] = useState(task.pm_reject_reason ?? '');
  const [fixInstructions, setFixInstructions] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    setSelectedAttemptId(actionTask.task_id);
  }, [root.task_id, actionTask.task_id]);

  useEffect(() => {
    setRejectReason(task.pm_reject_reason ?? '');
    setFixInstructions(task.pm_fix_instructions ?? '');
  }, [task.task_id, task.pm_fix_instructions, task.pm_reject_reason]);

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

  const reviewTarget = getRootCardReviewTarget(card);
  const resolution = getResolutionPresentation(root);
  const isSelectedCurrentAttempt = task.task_id === actionTask.task_id;
  const canReviewCurrentTask = reviewTarget?.task_id === task.task_id;
  const canReset = isSelectedCurrentAttempt && !['pending', 'cancelled'].includes(group) && !resolution;
  const canCancel = isSelectedCurrentAttempt && group === 'pending';
  const resultText = task.result_summary || review?.result_md || stringifyResult(task.result ?? review?.result_json);
  const verifyItems = normalizeVerify(review?.verify_results ?? task.verify_results ?? task.verify ?? []);
  const repairTaskIds = repairs.map((item) => item.task_id);
  const auditEntries = getAuditEntries(task, t);
  const showsResolutionContext = Boolean(
    resolution
    || root.resolution_task_id
    || root.resolved_by_task
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
            <p className="eyebrow">{root.task_id}{task.task_id !== root.task_id ? ` → ${task.task_id}` : ''}</p>
            <h2 id="task-detail-title">{root.title}</h2>
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

        <details className="detail-section" open>
          <summary>{t('planDetail.timelineHeading', { count: timeline.length })}</summary>
          <div className="verify-list">
            {timeline.map((item) => {
              const attemptReview = item.task.pm_review_status ?? item.task.review_status;
              const attemptStatus = attemptReview || item.task.status || 'pending';
              return (
                <button
                  key={item.task.task_id}
                  type="button"
                  className="btn secondary"
                  aria-pressed={item.task.task_id === task.task_id}
                  onClick={() => setSelectedAttemptId(item.task.task_id)}
                >
                  <code>{item.task.task_id}</code>
                  <span className="tag">{item.role === 'root'
                    ? t('planDetail.timelineRoot')
                    : item.role === 'reverify'
                      ? t('planDetail.timelineReverify')
                      : t('planDetail.timelineRepair')}</span>
                  <span className="tag">{getStatusLabel(attemptStatus, t)}</span>
                  {item.isCurrent && <span className="tag">{t('planDetail.timelineCurrent')}</span>}
                  {item.isResolvedBy && <span className="tag">{t('planDetail.timelineResolvedBy')}</span>}
                </button>
              );
            })}
          </div>
        </details>

        <div className="detail-grid">
          <Detail
            label={t('planDetail.detailStatus')}
            value={getStatusLabel(task.pm_review_status || task.review_status || task.status || group, t)}
          />
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
          {task.created_at !== undefined && <Detail label={t('planDetail.detailCreatedAt')} value={formatAuditTime(task.created_at, locale)} />}
          {task.done_at !== undefined && <Detail label={t('planDetail.detailDoneAt')} value={formatAuditTime(task.done_at, locale)} />}
          {task.cancelled_at !== undefined && <Detail label={t('planDetail.detailCancelledAt')} value={formatAuditTime(task.cancelled_at, locale)} />}
          {task.superseded_at !== undefined && <Detail label={t('planDetail.detailSupersededAt')} value={formatAuditTime(task.superseded_at, locale)} />}
          {task.superseded_by && <Detail label={t('planDetail.detailSupersededBy')} value={task.superseded_by} />}
          {task.pm_reviewed_by && <Detail label={t('planDetail.detailPmReviewer')} value={task.pm_reviewed_by} />}
          {task.pm_reviewed_at !== undefined && <Detail label={t('planDetail.detailPmReviewedAt')} value={formatAuditTime(task.pm_reviewed_at, locale)} />}
          {resolution && <Detail label={t('planDetail.resolutionStatus')} value={getResolutionLabel(resolution.status, resolution.action, t)} />}
        </div>

        {task.pm_review_comment && (
          <section className="detail-section">
            <h3>{t('planDetail.detailPmComment')}</h3>
            <p>{task.pm_review_comment}</p>
          </section>
        )}

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
              <ResolutionStatus task={root} />
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
              {root.resolution_task_id && (
                <>
                  <dt>{t('planDetail.resolutionCurrentTask')}</dt>
                  <dd><code>{root.resolution_task_id}</code></dd>
                </>
              )}
              {root.resolved_by_task && (
                <>
                  <dt>{t('planDetail.resolutionResolvedBy')}</dt>
                  <dd><code>{root.resolved_by_task}</code></dd>
                </>
              )}
              {root.pm_fix_instructions && (
                <>
                  <dt>{t('planDetail.fixInstructionsLabel')}</dt>
                  <dd>{root.pm_fix_instructions}</dd>
                </>
              )}
              {resolution && (root.resolution_attempts !== undefined || root.resolution_generation !== undefined) && (
                <>
                  <dt>{t('planDetail.resolutionAttempts')}</dt>
                  <dd>{t('planDetail.resolutionAttemptsValue', {
                    attempts: root.resolution_attempts ?? 0,
                    generation: root.resolution_generation ?? 0,
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
                  t('planDetail.confirmAccept', { taskId: reviewTarget!.task_id }),
                  () => reviewTask(reviewTarget!.task_id, { verdict: 'accept', comment: comment.trim(), reviewed_by: 'pm-web' }),
                  t('planDetail.successAccept', { taskId: reviewTarget!.task_id }),
                )}
              >{t('planDetail.acceptButton')}</button>
              <button
                type="button"
                className="btn danger"
                disabled={busy || !rejectReason.trim()}
                onClick={() => void mutate(
                  t('planDetail.confirmReject', { taskId: reviewTarget!.task_id }),
                  () => reviewTask(reviewTarget!.task_id, {
                    verdict: 'reject',
                    reject_reason: rejectReason.trim(),
                    fix_instructions: fixInstructions.trim(),
                    reviewed_by: 'pm-web',
                  }),
                  t('planDetail.successReject', { taskId: reviewTarget!.task_id }),
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
            <div className="form-stack">
              <label htmlFor="cancel-reason">{t('planDetail.cancelReasonLabel')}</label>
              <textarea
                id="cancel-reason"
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
                placeholder={t('planDetail.cancelReasonPlaceholder')}
              />
              <button
                type="button"
                className="btn danger"
                disabled={busy || !cancelReason.trim()}
                onClick={() => void mutate(
                  t('planDetail.confirmCancel', { taskId: task.task_id }),
                  () => cancelTask(task.task_id, cancelReason.trim()),
                  t('planDetail.successCancel', { taskId: task.task_id }),
                )}
              >{t('planDetail.cancelButton')}</button>
            </div>
          )}
          <button type="button" className="btn secondary" onClick={onClose}>{t('common.close')}</button>
        </section>
        {actionError && <div className="banner error" role="alert">{t('common.actionFailed')}{actionError}</div>}
      </aside>
    </div>
  );
}

function getAuditEntries(task: TaskSummary, t: TFunction) {
  return getAttemptAuditFacts(task).map((fact) => ({
    label: fact.kind === 'failure'
      ? t('planDetail.auditFailure')
      : fact.kind === 'rejected'
        ? t('planDetail.auditRejected')
        : fact.kind === 'blocked'
          ? t('planDetail.auditBlocked')
          : fact.kind === 'cancelled'
            ? t('planDetail.auditCancelled')
            : t('planDetail.auditSuperseded'),
    reason: fact.value,
  }));
}

function formatAuditTime(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale);
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

function serviceOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:7331' : window.location.origin;
}
