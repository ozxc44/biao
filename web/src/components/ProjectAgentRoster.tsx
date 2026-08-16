export type ProjectAgentAvailabilityStatus =
  | 'online_registered'
  | 'bound_wakeable'
  | 'background_only'
  | 'manual_required';

export type ProjectAgentWakeMode =
  | 'visible_session'
  | 'background_executor'
  | 'external_worker';

export interface ProjectAgentRosterItemDto {
  binding_id?: string;
  agent_id: string;
  label: string;
  harness_kind: string;
  availability_status: ProjectAgentAvailabilityStatus;
  wake_mode?: ProjectAgentWakeMode;
  capabilities?: readonly string[];
  project_scope?: string;
  registered_projects?: readonly string[];
  policy?: string;
  online_registered?: boolean;
  latest_receipt_status?: 'requested' | 'succeeded' | 'failed' | 'missing';
}

export interface ProjectAgentRosterProps {
  joined_agents: readonly ProjectAgentRosterItemDto[];
  available_agents: readonly ProjectAgentRosterItemDto[];
  busy: boolean;
  onAdd: (agent: ProjectAgentRosterItemDto) => void | Promise<unknown>;
  onRemove: (bindingId: string, agent: ProjectAgentRosterItemDto) => void | Promise<unknown>;
}

export interface RosterStatusPresentation {
  label: string;
  tone: 'blue' | 'green' | 'amber' | 'red';
}

const STATUS_PRESENTATION: Record<ProjectAgentAvailabilityStatus, RosterStatusPresentation> = {
  online_registered: { label: '在线注册', tone: 'blue' },
  bound_wakeable: { label: '已绑定可唤醒', tone: 'green' },
  background_only: { label: '仅后台执行', tone: 'amber' },
  manual_required: { label: '不可唤醒/人工处理', tone: 'red' },
};

const WAKE_MODE_LABELS: Record<ProjectAgentWakeMode, string> = {
  visible_session: '可见会话',
  background_executor: '后台执行器',
  external_worker: 'Harness 心跳',
};

const RECEIPT_LABELS = {
  missing: '暂无唤醒回执',
  requested: '已触发，等待回执',
  succeeded: '最近唤醒成功',
  failed: '最近唤醒失败',
} as const;

export function getRosterStatusPresentation(status: string): RosterStatusPresentation {
  return STATUS_PRESENTATION[status as ProjectAgentAvailabilityStatus]
    ?? STATUS_PRESENTATION.manual_required;
}

export function ProjectAgentRoster({
  joined_agents,
  available_agents,
  busy,
  onAdd,
  onRemove,
}: ProjectAgentRosterProps) {
  const rows = [
    ...joined_agents.map((agent) => ({ agent, kind: 'joined' as const })),
    ...available_agents.map((agent) => ({ agent, kind: 'available' as const })),
  ];

  return (
    <section className="project-agent-roster" aria-label="项目 Agent">
      <div className="project-agent-roster-heading">
        <div>
          <strong>已加入项目</strong>
          <span>{joined_agents.length}</span>
        </div>
        <div>
          <strong>可添加的在线 Agent</strong>
          <span>{available_agents.length}</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="project-agent-roster-empty">
          <p>暂无可用 Agent</p>
          <small>Agent 上线后可直接添加到项目；加入后默认自动接单。</small>
        </div>
      ) : (
        <ul className="project-agent-roster-list">
          {rows.map(({ agent, kind }) => (
            <RosterItem
              key={`${kind}-${agent.binding_id ?? agent.agent_id}`}
              agent={agent}
              kind={kind}
              busy={busy}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RosterItem({
  agent,
  kind,
  busy,
  onAdd,
  onRemove,
}: {
  agent: ProjectAgentRosterItemDto;
  kind: 'joined' | 'available';
  busy: boolean;
  onAdd: ProjectAgentRosterProps['onAdd'];
  onRemove: ProjectAgentRosterProps['onRemove'];
}) {
  const status = getRosterStatusPresentation(agent.availability_status);
  const projects = agent.registered_projects?.length
    ? agent.registered_projects.join('、')
    : '未限定项目';
  const receiptStatus = agent.latest_receipt_status ?? 'missing';

  return (
    <li className={`project-agent-roster-item project-agent-roster-item-${kind}`}>
      <div className="project-agent-identity">
        <span className={`project-agent-kind project-agent-kind-${kind}`}>
          {kind === 'joined' ? '已加入' : '可添加'}
        </span>
        <strong>{agent.label}</strong>
        <small>{agent.agent_id}</small>
      </div>

      <div className="project-agent-state-stack">
        <span className={`project-agent-status project-agent-status-${status.tone}`}>{status.label}</span>
        {kind === 'joined' && agent.policy === 'automatic' && (
          <span className="project-agent-status project-agent-status-green">自动接单</span>
        )}
        {kind === 'joined' && (
          <span className={`binding-receipt-state receipt-state-${receiptStatus}`}>
            {RECEIPT_LABELS[receiptStatus]}
          </span>
        )}
      </div>

      <dl>
        <div>
          <dt>Harness</dt>
          <dd>{agent.harness_kind}</dd>
        </div>
        <div>
          <dt>在线状态</dt>
          <dd>{kind === 'available' || agent.online_registered ? '在线' : '离线'}</dd>
        </div>
        {agent.wake_mode && (
          <div>
            <dt>唤醒方式</dt>
            <dd>{WAKE_MODE_LABELS[agent.wake_mode]}</dd>
          </div>
        )}
        <div>
          <dt>能力</dt>
          <dd>{agent.capabilities?.length ? agent.capabilities.join('、') : '未声明'}</dd>
        </div>
        <div className="project-agent-projects">
          <dt>{kind === 'joined' ? '当前项目' : '当前注册项目'}</dt>
          <dd>{kind === 'joined' ? (agent.project_scope ?? '当前项目') : projects}</dd>
        </div>
      </dl>

      {kind === 'joined' ? (
        <button
          type="button"
          className="btn danger small"
          disabled={busy || !agent.binding_id}
          onClick={() => agent.binding_id && void onRemove(agent.binding_id, agent)}
        >移除</button>
      ) : (
        <button
          type="button"
          className="btn primary small"
          disabled={busy}
          onClick={() => void onAdd(agent)}
        >添加</button>
      )}
    </li>
  );
}
