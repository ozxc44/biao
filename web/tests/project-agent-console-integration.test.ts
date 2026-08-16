import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectProjectAgent,
  deleteProjectAgentBinding,
  fetchProjectAgentRoster,
  type ExecutionReceiptData,
  type ProjectAgentRosterData,
} from '../src/api';
import { getRootAttemptTimeline, type RootTaskCard } from '../src/view-model';
import {
  AttemptExecutionReceipts,
  ProjectAgentConsolePanel,
} from '../src/components/PlanDetailView';
import { I18nProvider } from '../src/i18n/I18nContext';

const projectScope = '/srv/workspaces/authorized-project';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('project Agent console integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads the roster and receipts only through an explicit project scope', async () => {
    const roster: ProjectAgentRosterData = {
      project_scope: projectScope,
      bound_agents: [],
      online_candidates: [],
      receipts: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse(roster));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProjectAgentRoster(projectScope)).resolves.toEqual(roster);

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), 'https://biao.test');
    expect(parsed.pathname).toBe('/project/agent-roster');
    expect(parsed.searchParams.get('project_scope')).toBe(projectScope);
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });

  it('connects an online agent with only project and agent identity, then removes it by binding id', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => jsonResponse(
      init?.method === 'DELETE'
        ? { binding_id: 'binding-1', deleted: true }
        : {
            binding_id: 'binding-1', project_scope: projectScope, agent_id: 'codex-visible',
            label: 'Codex visible', harness_kind: 'codex', capabilities: ['code'],
            wake_mode: 'external_worker', policy: 'automatic', created_at: 1, updated_at: 1,
          },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await connectProjectAgent(projectScope, 'codex-visible');
    await deleteProjectAgentBinding(projectScope, 'binding-1');

    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toBe('/project/agent-connections');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      project_scope: projectScope,
      agent_id: 'codex-visible',
    });

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1];
    const parsedDelete = new URL(String(deleteUrl), 'https://biao.test');
    expect(parsedDelete.pathname).toBe('/project/agent-bindings/binding-1');
    expect(parsedDelete.searchParams.get('project_scope')).toBe(projectScope);
    expect(deleteInit?.method).toBe('DELETE');
  });

  it('attaches receipts to existing root and repair attempts without creating product tasks', () => {
    const root = {
      task_id: 'root-task', title: 'Root', type: 'code', phase: 'impl', assignee: 'auto',
      priority: 5, ownership_files: [], depends_on: [], status: 'done',
      resolution_task_id: 'repair-task', resolution_task_ids: ['repair-task'],
    };
    const repair = {
      ...root,
      task_id: 'repair-task', title: 'Repair', fix_for: 'root-task', status: 'running',
      resolution_task_id: undefined, resolution_task_ids: undefined,
    };
    const card: RootTaskCard = {
      root,
      repairs: [repair],
      actionTask: repair,
      group: 'running',
    };
    const receipts: ExecutionReceiptData[] = [{
      attempt_id: 'wake-repair-1', task_id: 'repair-task', project_scope: projectScope,
      binding_id: 'binding-1', agent_id: 'codex-visible', harness_kind: 'codex',
      wake_mode: 'visible_session', adapter_id: 'codex-visible-v1', status: 'succeeded',
      started_at: 42, session_ref: 'session-safe-1', visible_url: '/sessions/session-safe-1',
    }];

    const timeline = getRootAttemptTimeline(card, receipts);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ role: 'root', receipts: [] });
    expect(timeline[1]).toMatchObject({
      role: 'repair', isCurrent: true,
      receipts: [{ attempt_id: 'wake-repair-1', harness_kind: 'codex', status: 'succeeded' }],
    });
    expect(timeline.map((item) => item.task.task_id)).toEqual(['root-task', 'repair-task']);
  });

  it('renders an explicit project binding empty state without implying a background worker start', () => {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(ProjectAgentConsolePanel, {
        projectScope,
        roster: { project_scope: projectScope, bound_agents: [], online_candidates: [], receipts: [] },
        busy: false,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }),
    ));

    expect(markup).toContain('此项目尚未加入 Agent');
    expect(markup).toContain('在线 Agent 可直接添加，加入后默认自动接单');
    expect(markup).toContain(projectScope);
    expect(markup).not.toContain('已唤醒自带 harness');
  });

  it('renders scoped binding controls and receipts from the project roster', () => {
    const receipt: ExecutionReceiptData = {
      attempt_id: 'wake-root-1', task_id: 'root-task', project_scope: projectScope,
      binding_id: 'binding-1', agent_id: 'codex-visible', harness_kind: 'codex',
      wake_mode: 'visible_session', adapter_id: 'codex-visible-v1', status: 'succeeded',
      started_at: 42, session_ref: 'session-safe-1', visible_url: '/sessions/session-safe-1',
    };
    const markup = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(ProjectAgentConsolePanel, {
        projectScope,
        roster: {
          project_scope: projectScope,
          bound_agents: [{
            binding_id: 'binding-1', project_scope: projectScope, agent_id: 'codex-visible',
            label: 'Codex visible', harness_kind: 'codex', capabilities: ['code'],
            wake_mode: 'external_worker', policy: 'automatic', created_at: 1, updated_at: 1,
            availability_status: 'bound_wakeable', online_registered: true,
          }],
          online_candidates: [{
            agent_id: 'kimi-candidate', label: 'Kimi candidate', harness_kind: 'kimi',
            capabilities: ['review'], project_scope: projectScope,
            availability_status: 'online_registered',
            registered_projects: ['/srv/workspaces/other-project'],
          }],
          receipts: [receipt],
        },
        busy: false,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }),
    ));

    expect(markup).toContain('Codex visible');
    expect(markup).toContain('Kimi candidate');
    expect(markup).toContain('自动接单');
    expect(markup).toContain('移除');
    expect(markup).toContain('添加');
    expect(markup).not.toContain('策略');
    expect(markup).not.toContain('唤醒模式');
    expect(markup).toContain('已唤醒自带 harness');
    expect(markup).toContain('/sessions/session-safe-1');
  });

  it('fails closed when an attempt has no execution receipt', () => {
    const empty = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(AttemptExecutionReceipts, { receipts: [] }),
    ));
    expect(empty).toContain('没有 ExecutionReceipt');
    expect(empty).toContain('不能确认已唤醒自带 harness');
    expect(empty).not.toContain('已唤醒自带 harness</span>');
  });

  it('does not render roster data returned for a different project scope', () => {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(ProjectAgentConsolePanel, {
        projectScope,
        roster: {
          project_scope: '/srv/workspaces/different-project',
          bound_agents: [],
          online_candidates: [{
            agent_id: 'cross-scope-agent', label: 'Must not render', harness_kind: 'custom',
            capabilities: ['code'], project_scope: '/srv/workspaces/different-project',
            availability_status: 'online_registered',
          }],
          receipts: [],
        },
        busy: false,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }),
    ));

    expect(markup).toContain('项目作用域不匹配');
    expect(markup).not.toContain('Must not render');
    expect(markup).not.toContain('cross-scope-agent');
  });
});
