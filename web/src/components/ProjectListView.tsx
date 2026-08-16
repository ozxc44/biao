import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  createPlan,
  fetchPlan,
  fetchStatus,
  type AgentInfo,
  type PlanSummary,
  type StatusData,
} from '../api';
import { useI18n } from '../i18n/I18nContext';
import { buildPmConnectionGuide, buildWorkerConnectionGuide } from '../guides';
import { getStatusLabel } from '../i18n/status';
import { formatHeartbeat, formatTimestamp } from '../i18n/time';
import type { Locale } from '../i18n/translations';
import {
  acceptedProgress,
  countOnlineAgents,
  getGlobalStatusSummary,
  getPlanAttention,
  getPlanSummaryProgress,
  getStatusHintMessage,
  partitionAgents,
  validatePlanId,
  type PlanAttentionAction,
} from '../view-model';
import CopyButton from './CopyButton';

interface PlanProgress {
  accepted: number;
  total: number;
  percent: number;
  reviewPending: number;
  pending: number;
  repairing: number;
  resolved: number;
  needsPmDecision: number;
  action: PlanAttentionAction;
}

const EMPTY_REVIEWS = { pending: 0, accepted: 0, rejected: 0 };

export function ProjectListView({
  onSelectPlan,
  authRevision,
  refreshRevision,
}: {
  onSelectPlan: (planId: string) => void;
  authRevision: number;
  /** P12 §10：SSE 事件到达递增的 revision，变化即触发重载。 */
  refreshRevision: number;
}) {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [progress, setProgress] = useState<Record<string, PlanProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const loadGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const generation = ++loadGeneration.current;
      try {
        const nextStatus = await fetchStatus();
        const nextProgress: Record<string, PlanProgress> = {};
        const onlineAgents = countOnlineAgents(nextStatus.agents ?? []);
        await Promise.all(
          (nextStatus.plans ?? []).map(async (planSummary) => {
            const projected = getPlanSummaryProgress(planSummary, onlineAgents);
            if (projected) {
              nextProgress[planSummary.plan_id] = projected;
              return;
            }
            try {
              const plan = await fetchPlan(planSummary.plan_id);
              const accepted = acceptedProgress(
                plan.tasks,
                planSummary.task_count || plan.task_count,
              );
              const attention = getPlanAttention(
                plan.tasks,
                planSummary.task_count || plan.task_count,
                onlineAgents,
              );
              nextProgress[planSummary.plan_id] = {
                ...accepted,
                reviewPending: attention.reviewPending,
                pending: attention.pending,
                repairing: attention.repairing,
                resolved: attention.resolved,
                needsPmDecision: attention.needsPmDecision,
                action: attention.action,
              };
            } catch {
              nextProgress[planSummary.plan_id] = {
                accepted: 0,
                total: planSummary.task_count,
                percent: 0,
                reviewPending: 0,
                pending: 0,
                repairing: 0,
                resolved: 0,
                needsPmDecision: 0,
                action: 'none',
              };
            }
          }),
        );
        if (!cancelled && generation === loadGeneration.current) {
          setStatus(nextStatus);
          setProgress(nextProgress);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled && generation === loadGeneration.current) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };

    void load();
    // P12 §10：SSE 事件由 App 级 useEventStream 订阅并递增 refreshRevision，
    // 这里不再直接 subscribeToEvents（避免双订阅重复刷新）。
    return () => {
      cancelled = true;
    };
  }, [reloadTick, authRevision, refreshRevision]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (error && !status) return <ErrorNotice message={error} onRetry={() => setReloadTick((v) => v + 1)} />;
  if (!status) return <div className="notice">{t('common.loadingConsole')}</div>;

  // 首页展示的是声明根任务口径；旧服务没有 root_reviews 时再兼容 raw attempt 口径。
  const reviews = status.root_reviews ?? status.reviews ?? { ...EMPTY_REVIEWS, pending: status.tasks.done };
  const onlineAgents = countOnlineAgents(status.agents ?? []);
  const summary = getGlobalStatusSummary(status);
  const agentGroups = status.agent_groups ?? partitionAgents(status.agents ?? []);
  const currentAgents = agentGroups.current;
  const historicalAgents = agentGroups.history;
  const resolvedAuditCount = summary.history.resolvedFailed + summary.history.resolvedRejected;
  const hintMessage = getStatusHintMessage(status.hint, locale);

  return (
    <main>
      {error && <div className="banner error" role="alert">{t('common.refreshFailed')}{error}</div>}
      <NextStep
        plans={status.plans}
        progress={progress}
        onSelectPlan={onSelectPlan}
      />
      {hintMessage && <div className="banner warning">{hintMessage}</div>}

      <section className="metric-grid" aria-label={t('projectList.metricsAriaLabel')}>
        <Metric label={t('projectList.metricPending')} value={status.root_tasks?.pending ?? status.tasks.pending} tone="neutral" />
        <Metric label={t('projectList.metricRunning')} value={status.root_tasks?.running ?? status.tasks.running} tone="blue" />
        <Metric label={t('projectList.metricReviewPending')} value={reviews.pending} tone="amber" />
        <Metric label={t('projectList.metricAccepted')} value={reviews.accepted} tone="green" />
        <Metric label={t('projectList.metricRejected')} value={summary.attention.rejected} tone="red" />
        <Metric label={t('projectList.metricFailed')} value={summary.attention.failed} tone="red" />
        <Metric label={t('projectList.metricNeedsPmDecision')} value={summary.attention.needsPmDecision} tone="red" />
        <Metric label={t('projectList.metricResolvedHistory')} value={resolvedAuditCount} tone="green" />
        <Metric label={t('projectList.metricOnlineAgents')} value={onlineAgents} tone="violet" />
        <Metric label={t('projectList.metricConflicts')} value={status.ownership_conflicts} tone="amber" />
      </section>

      <section className="section-card agents-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('projectList.agentsEyebrow')}</p>
            <h2>{t('projectList.agentsHeading')}</h2>
            <p className="global-resource-hint">{t('projectList.agentsGlobalScopeHint')}</p>
          </div>
          <span className="section-summary">
            {t('projectList.agentsSummary', { online: onlineAgents, total: currentAgents.length })}
          </span>
        </div>
        {currentAgents.length === 0 ? (
          <div className="empty-state">{t('projectList.agentsCurrentEmpty')}</div>
        ) : (
          <div className="agent-list">
            {currentAgents.map((agent) => (
              <AgentRow key={agent.agent_id} agent={agent} now={now} locale={locale} />
            ))}
          </div>
        )}
        {historicalAgents.length > 0 && (
          <details className="agent-history">
            <summary>{t('projectList.agentsHistorySummary', { count: historicalAgents.length })}</summary>
            <div className="agent-list">
              {historicalAgents.map((agent) => (
                <AgentRow key={agent.agent_id} agent={agent} now={now} locale={locale} />
              ))}
            </div>
          </details>
        )}
      </section>

      <div className="project-heading">
        <div>
          <p className="eyebrow">{t('projectList.projectsEyebrow')}</p>
          <h2>{t('projectList.projectsHeading')}</h2>
          <p>{t('projectList.projectsHint')}</p>
        </div>
        <div className="project-heading-actions">
          <CopyButton
            text={buildPmConnectionGuide(locale, serviceOrigin())}
            label={t('projectList.copyPmGuideButton')}
          />
          <CreatePlanForm locale={locale} onCreated={() => setReloadTick((value) => value + 1)} />
        </div>
      </div>

      <section className="plan-list" aria-label={t('projectList.projectsHeading')}>
        {status.plans.length === 0 && <div className="empty-state section-card">{t('projectList.noProjects')}</div>}
        {status.plans.map((plan) => (
          <PlanCard
            key={plan.plan_id}
            plan={plan}
            progress={progress[plan.plan_id] ?? {
              accepted: 0,
              total: plan.task_count,
              percent: 0,
              reviewPending: 0,
              pending: 0,
              repairing: 0,
              resolved: 0,
              needsPmDecision: 0,
              action: 'none',
            }}
            onOpen={() => onSelectPlan(plan.plan_id)}
          />
        ))}
      </section>
    </main>
  );
}

function NextStep({
  plans,
  progress,
  onSelectPlan,
}: {
  plans: PlanSummary[];
  progress: Record<string, PlanProgress>;
  onSelectPlan: (planId: string) => void;
}) {
  const { t } = useI18n();
  const rankedActions: PlanAttentionAction[] = ['decision', 'review', 'start_worker', 'wait_for_worker', 'complete'];
  const selected = rankedActions
    .map((action) => plans.find((plan) => progress[plan.plan_id]?.action === action))
    .find(Boolean);

  if (!selected) return null;
  const planProgress = progress[selected.plan_id];
  const isDecision = planProgress.action === 'decision';
  const isReview = planProgress.action === 'review';
  const isStartWorker = planProgress.action === 'start_worker';
  const isWaiting = planProgress.action === 'wait_for_worker';

  return (
    <section className={`next-step next-step-${planProgress.action}`} aria-label={t('projectList.nextStepAriaLabel')}>
      <div>
        <p className="eyebrow">{t('projectList.nextStepHeading')}</p>
        <h2>
          {isReview
            ? t('projectList.nextStepReviewTitle')
            : isDecision
              ? t('projectList.nextStepDecisionTitle')
              : isStartWorker
                ? t('projectList.nextStepWorkerTitle')
                : isWaiting
                  ? t('projectList.nextStepWaitTitle')
                  : t('projectList.nextStepCompleteTitle')}
        </h2>
        <p>
          {isReview
            ? t('projectList.nextStepReviewBody', { count: planProgress.reviewPending })
            : isDecision
              ? t('projectList.nextStepDecisionBody', { count: planProgress.needsPmDecision })
              : isStartWorker
                ? t('projectList.nextStepWorkerBody', { count: planProgress.pending })
                : isWaiting
                  ? t('projectList.nextStepWaitBody', { count: planProgress.pending })
                  : t('projectList.nextStepCompleteBody')}
        </p>
      </div>
      {(isDecision || isReview || isStartWorker) && (
        <button type="button" className="btn secondary" onClick={() => onSelectPlan(selected.plan_id)}>
          {isDecision
            ? t('projectList.nextStepDecisionAction')
            : isReview
              ? t('projectList.nextStepReviewAction')
              : t('projectList.nextStepWorkerAction')}
        </button>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metric tone-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AgentRow({ agent, now, locale }: { agent: AgentInfo; now: number; locale: Locale }) {
  const { t } = useI18n();
  const online = ['idle', 'busy', 'online'].includes(agent.status.toLowerCase());
  return (
    <article className="agent-row">
      <span className={`presence-dot ${online ? 'online' : ''}`} aria-hidden="true" />
      <div className="agent-identity">
        <strong>{agent.agent_id}</strong>
        <span>{agent.agent_type || 'unknown'}</span>
      </div>
      <span className={`status-chip status-${agent.status}`}>{getStatusLabel(agent.status, t)}</span>
      <div className="agent-task">
        <span>{t('projectList.currentTaskLabel')}</span>
        <strong>
          {agent.current_task
            ? `${agent.current_task}${agent.current_task_status ? ` · ${getStatusLabel(agent.current_task_status, t)}` : ''}`
            : t('projectList.currentTaskIdle')}
        </strong>
      </div>
      <time dateTime={toDateTime(agent.last_heartbeat)} title={formatTimestamp(agent.last_heartbeat, locale)}>
        {formatHeartbeat(agent.last_heartbeat, now, t)}
      </time>
    </article>
  );
}

function PlanCard({ plan, progress, onOpen }: { plan: PlanSummary; progress: PlanProgress; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <article className="plan-card">
      <button
        type="button"
        className="plan-card-open"
        onClick={onOpen}
        aria-label={t('projectList.planCardOpenAria', { title: plan.title || plan.plan_id })}
      >
        <div className="plan-card-top">
          <span className="plan-title">{plan.title || plan.plan_id}</span>
          <span className={`status-chip status-${plan.status}`}>{getStatusLabel(plan.status, t)}</span>
        </div>
        <span className="plan-id">{plan.plan_id}</span>
        <div className="progress" aria-label={t('projectList.progressAriaLabel', { percent: progress.percent })}>
          <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="plan-card-bottom">
          <span>{t('projectList.progressText', { accepted: progress.accepted, total: progress.total, percent: progress.percent })}</span>
          <span>{t('projectList.viewTasks')}</span>
        </div>
        <PlanAttentionSummary progress={progress} />
      </button>
      <div className="plan-card-actions">
        <CopyGuideButton plan={plan} />
      </div>
    </article>
  );
}

function PlanAttentionSummary({ progress }: { progress: PlanProgress }) {
  const { t } = useI18n();
  if (progress.needsPmDecision > 0) {
    return <span className="plan-attention decision">{t('projectList.planPmDecision', { count: progress.needsPmDecision })}</span>;
  }
  if (progress.reviewPending > 0) {
    return <span className="plan-attention review">{t('projectList.planReviewPending', { count: progress.reviewPending })}</span>;
  }
  if (progress.repairing > 0) {
    return <span className="plan-attention repairing">{t('projectList.planRepairing', { count: progress.repairing })}</span>;
  }
  if (progress.pending > 0) {
    return <span className="plan-attention pending">{t('projectList.planPending', { count: progress.pending })}</span>;
  }
  if (progress.action === 'complete') {
    return <span className="plan-attention accepted">{t('projectList.planAllAccepted')}</span>;
  }
  if (progress.resolved > 0) {
    return <span className="plan-attention resolved">{t('projectList.planResolved', { count: progress.resolved })}</span>;
  }
  return null;
}

function CreatePlanForm({ locale, onCreated }: { locale: Locale; onCreated: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState('');
  const [title, setTitle] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planIdError = planId ? validatePlanId(planId, locale) : null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const invalidId = validatePlanId(planId, locale);
    if (invalidId) {
      setError(invalidId);
      return;
    }
    if (!projectPath.trim().startsWith('/')) {
      setError(t('projectList.pathAbsoluteError'));
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createPlan({
        plan_id: planId.trim(),
        title: title.trim() || undefined,
        project_path: projectPath.trim(),
      });
      setPlanId('');
      setTitle('');
      setProjectPath('');
      setOpen(false);
      onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="create-plan">
      <button
        type="button"
        className="btn primary"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? t('projectList.createPlanClose') : t('projectList.createPlanOpen')}
      </button>
      {open && (
        <form className="create-plan-form" onSubmit={(event) => void handleSubmit(event)}>
          <div className="risk-note">
            <strong>{t('projectList.workspaceBoundaryTitle')}</strong>
            <span>{t('projectList.workspaceBoundaryDesc')}</span>
          </div>
          <label htmlFor="plan-id">{t('projectList.planIdLabel')}</label>
          <input
            id="plan-id"
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
            placeholder={t('projectList.planIdPlaceholder')}
            aria-invalid={Boolean(planIdError)}
            aria-describedby="plan-id-help"
            required
          />
          <small id="plan-id-help">{t('projectList.planIdHelp')}</small>
          {planIdError && <span className="inline-error">{planIdError}</span>}

          <label htmlFor="plan-title">{t('projectList.titleLabel')}</label>
          <input
            id="plan-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('projectList.titlePlaceholder')}
          />

          <label htmlFor="project-path">{t('projectList.projectPathLabel')}</label>
          <input
            id="project-path"
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder={t('projectList.projectPathPlaceholder')}
            required
          />
          <small>{t('projectList.projectPathHelp')}</small>

          {error && <div className="inline-error" role="alert">{error}</div>}
          <div className="button-row">
            <button type="submit" className="btn primary" disabled={submitting || Boolean(planIdError)}>
              {submitting ? t('common.creating') : t('common.create')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CopyGuideButton({ plan }: { plan: PlanSummary }) {
  const { locale, t } = useI18n();
  return <CopyButton
    text={buildWorkerConnectionGuide(locale, serviceOrigin(), {
      planId: plan.plan_id,
      projectPath: plan.project_path,
    })}
    label={t('projectList.copyGuideButton')}
  />;
}

function serviceOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost:7331' : window.location.origin;
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="notice error" role="alert">
      <p>{t('projectList.errorNotice', { message })}</p>
      <button type="button" className="btn secondary" onClick={onRetry}>{t('common.retry')}</button>
    </div>
  );
}

function toDateTime(timestamp: number): string | undefined {
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}
