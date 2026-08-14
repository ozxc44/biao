import { describe, expect, it } from 'vitest';
import { buildPmConnectionGuide, buildWorkerConnectionGuide } from '../src/guides';

describe('connection guides', () => {
  it('builds a PM guide that can create plans and start a PM session without embedding credentials', () => {
    const guide = buildPmConnectionGuide('zh-CN', 'http://127.0.0.1:7331');
    expect(guide).toContain('Biao PM 接入');
    expect(guide).toContain('.biao/pm plan create');
    expect(guide).toContain('.biao/pm-start --once');
    expect(guide).not.toMatch(/BIAO_API_TOKEN\s*=|Authorization:\s*Bearer\s+\S+/);
  });

  it('builds a plan-scoped Worker guide with project affinity and lifecycle rules', () => {
    const guide = buildWorkerConnectionGuide('zh-CN', 'http://127.0.0.1:7331', {
      planId: 'plan-1', projectPath: "/srv/workspaces/team's app",
    });
    expect(guide).toContain('Plan ID：plan-1');
    expect(guide).toContain("--project '/srv/workspaces/team'\"'\"'s app'");
    expect(guide).toContain("--plans 'plan-1'");
    expect(guide).toContain("BIAO_PREFERRED_PROJECT='/srv/workspaces/team'\"'\"'s app'");
    expect(guide).toContain('共享 Supervisor');
    expect(guide).toContain('Plan 级隔离');
    expect(guide).toContain('ownership');
    expect(guide).toContain('report');
    expect(guide).not.toMatch(/BIAO_API_TOKEN\s*=|Authorization:\s*Bearer\s+\S+/);
  });
});
