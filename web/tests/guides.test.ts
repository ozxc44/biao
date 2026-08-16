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

  it('builds a plan-scoped Worker guide whose single join command creates the binding (no frontend re-bind)', () => {
    const guide = buildWorkerConnectionGuide('zh-CN', 'http://127.0.0.1:7331', {
      planId: 'plan-1', projectPath: "/srv/workspaces/team's app",
    });
    expect(guide).toContain('Plan ID：plan-1');
    expect(guide).toContain('"command": "biao-mcp"');
    expect(guide).toContain('"BIAO_URL": "http://127.0.0.1:7331"');
    expect(guide).toContain('.biao/copy-token');
    expect(guide).toContain('task_claim');
    expect(guide).toContain('biao-agent-join');
    expect(guide).toContain("--project-scope '/srv/workspaces/team'\"'\"'s app'");
    expect(guide).toContain('--wake-mode background_executor');
    expect(guide).toContain('--binding-id <第1步输出的binding_id>');
    expect(guide).toContain("--plans 'plan-1'");
    expect(guide).toContain('共享 Supervisor');
    expect(guide).toContain('ownership');
    expect(guide).toContain('report');
    expect(guide).not.toMatch(/BIAO_API_TOKEN\s*=\s*[^<]|Authorization:\s*Bearer\s+\S+/);
  });
});
