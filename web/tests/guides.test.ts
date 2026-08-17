import { describe, expect, it } from 'vitest';
import { buildPmConnectionGuide, buildWorkerConnectionGuide } from '../src/guides';

describe('connection guides', () => {
  it('builds a PM guide that can create plans and start a PM session without embedding credentials', () => {
    const guide = buildPmConnectionGuide('zh-CN', 'http://127.0.0.1:7331');
    expect(guide).toContain('Biao PM 接入');
    expect(guide).toContain('.biao/pm plan create');
    expect(guide).toContain('.biao/pm-start --once');
    expect(guide).toContain('"command": "biao-mcp"');
    expect(guide).toContain('.biao/copy-token');
    expect(guide).not.toMatch(/BIAO_API_TOKEN\s*=\s*[^<]|Authorization:\s*Bearer\s+\S+/);
  });

  it('builds a plan-scoped Worker guide led by MCP with all fallback entries collapsed into one pointer', () => {
    const guide = buildWorkerConnectionGuide('zh-CN', 'http://127.0.0.1:7331', {
      planId: 'plan-1', projectPath: "/srv/workspaces/team's app",
    });
    expect(guide).toContain('Plan ID：plan-1');
    expect(guide).toContain('"command": "biao-mcp"');
    expect(guide).toContain('"BIAO_URL": "http://127.0.0.1:7331"');
    expect(guide).toContain('.biao/copy-token');
    expect(guide).toContain('task_claim');
    expect(guide).toContain("preferred_project=/srv/workspaces/team's app");
    expect(guide).toContain('其他接入方式');
    expect(guide).toContain('docs/worker-integration.md');
    expect(guide).toContain('biao-agent-join');
    expect(guide).toContain('领取成功即自动加入项目');
    expect(guide).toContain('ownership');
    expect(guide).toContain('report');
    // 备用入口只保留一行指引，不再展开多命令块。
    expect(guide).not.toContain('--binding-id');
    expect(guide).not.toContain('supervisor-config worker add');
    expect(guide).not.toContain('--wake-mode background_executor');
    expect(guide).not.toContain('.biao/supervisor --plans');
    expect(guide).not.toMatch(/BIAO_API_TOKEN\s*=\s*[^<]|Authorization:\s*Bearer\s+\S+/);
  });
});
