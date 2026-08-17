import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ProjectAgentRoster,
  getRosterStatusPresentation,
  type ProjectAgentRosterProps,
} from '../src/components/ProjectAgentRoster';

function render(props: ProjectAgentRosterProps): string {
  return renderToStaticMarkup(createElement(ProjectAgentRoster, props));
}

describe('ProjectAgentRoster', () => {
  it('maps every availability state to a distinct, stable label', () => {
    expect(getRosterStatusPresentation('online_registered').label).toBe('在线注册');
    expect(getRosterStatusPresentation('bound_wakeable').label).toBe('已绑定可唤醒');
    expect(getRosterStatusPresentation('background_only').label).toBe('仅后台执行');
    expect(getRosterStatusPresentation('manual_required').label).toBe('不可唤醒/人工处理');
  });

  it('renders joined and available agents in one action-oriented view', () => {
    const markup = render({
      joined_agents: [
        {
          binding_id: 'binding-codex',
          agent_id: 'bound-codex',
          label: 'Codex Desktop',
          harness_kind: 'codex',
          availability_status: 'bound_wakeable',
          wake_mode: 'visible_session',
          policy: 'automatic',
          online_registered: true,
        },
        {
          binding_id: 'binding-cli',
          agent_id: 'background-cli',
          label: 'Build CLI',
          harness_kind: 'custom',
          availability_status: 'background_only',
          wake_mode: 'background_executor',
          policy: 'automatic',
          online_registered: false,
        },
      ],
      available_agents: [
        {
          agent_id: 'online-kimi',
          label: 'Kimi candidate',
          harness_kind: 'kimi',
          availability_status: 'online_registered',
          registered_projects: ['/workspace/another-project'],
        },
      ],
      busy: false,
      onAdd: () => undefined,
      onRemove: () => undefined,
    });

    expect(markup).toContain('已加入项目');
    expect(markup).toContain('可添加的在线 Agent');
    expect(markup.indexOf('Codex Desktop')).toBeLessThan(markup.indexOf('Kimi candidate'));
    expect(markup).toContain('自动接单');
    expect(markup).toContain('仅后台执行');
    expect(markup).toContain('在线注册');
    expect(markup).toContain('移除');
    expect(markup).toContain('添加');
    expect(markup).toContain('/workspace/another-project');
    expect(markup).not.toContain('<select');
  });

  it('shows one compact empty state when no agent is joined or available', () => {
    const markup = render({
      joined_agents: [], available_agents: [], busy: false,
      onAdd: () => undefined, onRemove: () => undefined,
    });

    expect(markup).toContain('暂无可用 Agent');
    expect(markup).toContain('Worker 领取任务成功即自动加入项目');
  });

  it('ignores transport and credential-shaped extra properties', () => {
    const unsafeAgent = {
      agent_id: 'safe-id',
      label: 'Visible label',
      harness_kind: 'custom',
      availability_status: 'manual_required' as const,
      endpoint: 'https://internal.invalid/wake',
      command: 'run-secret-command',
      target: 'private-session-target',
      cookie: 'Cookie=secret',
      bearer_token: 'Bearer secret-token',
      BIAO_API_TOKEN: 'biao-secret',
    };

    const markup = render({
      joined_agents: [{ ...unsafeAgent, binding_id: 'safe-binding', policy: 'automatic' }],
      available_agents: [], busy: false,
      onAdd: () => undefined, onRemove: () => undefined,
    });

    expect(markup).toContain('Visible label');
    expect(markup).not.toMatch(/internal\.invalid|run-secret|private-session|Cookie=|Bearer|biao-secret/);
  });
});
