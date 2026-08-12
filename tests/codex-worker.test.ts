import { describe, expect, it } from 'vitest';
import * as codexWorker from '../src/worker/codex.js';
import type { ClaimedTask } from '../src/types/index.js';

describe('Codex Worker prompt', () => {
  it('保留调度器审计产物的专属写入权并要求 Agent 输出交付摘要', () => {
    const task = {
      task_id: 'codex-artifact-boundary',
      title: '审计产物边界',
      type: 'code',
      phase: 'impl',
      priority: 1,
      ownership_files: ['src/worker/codex.ts'],
      goal_md: '修复 Worker 产物职责冲突。',
      timeout_seconds: 60,
      claim_token: 'claim-token',
      verify: [{ cmd: 'npm test -- codex-worker', expect_exit: 0 }],
    } satisfies ClaimedTask;
    const buildPrompt = (codexWorker as unknown as {
      buildCodexPrompt?: (claimedTask: ClaimedTask) => string;
    }).buildCodexPrompt;

    expect(buildPrompt).toBeTypeOf('function');
    const prompt = buildPrompt!(task);

    expect(prompt).toContain('不得创建或修改');
    expect(prompt).toContain('work/codex-artifact-boundary/result.md');
    expect(prompt).toContain('work/codex-artifact-boundary/result.json');
    expect(prompt).toContain('work/codex-artifact-boundary/.claim.json');
    expect(prompt).toContain('work/codex-artifact-boundary/.progress.json');
    expect(prompt).toMatch(/最终输出[\s\S]*改动[\s\S]*验证摘要/);
    expect(prompt).toContain('BIAO_CHANGED_FILES: ["相对路径/文件一", "相对路径/文件二"]');
    expect(prompt).toContain('BIAO_QUESTION:');
    expect(prompt).toContain('src/worker/codex.ts');
  });

  it('从 Codex JSON 的最终 Agent 报告中提取机器可读的改动文件', () => {
    const parseChangedFiles = (codexWorker as unknown as {
      parseChangedFiles?: (stdout: string) => string[];
    }).parseChangedFiles;

    expect(parseChangedFiles).toBeTypeOf('function');
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: [
            '已完成实现和验证。',
            'BIAO_CHANGED_FILES: ["src/worker/codex.ts", "tests/codex-worker.test.ts"]',
          ].join('\n'),
        },
      }),
    ].join('\n');

    expect(parseChangedFiles!(stdout)).toEqual([
      'src/worker/codex.ts',
      'tests/codex-worker.test.ts',
    ]);
  });

  it('把 Supervisor slot 的真实 agentId 写入执行提示，而不是硬编码 codex', () => {
    const task = {
      task_id: 'codex-slot-identity',
      title: '真实 Worker 身份',
      type: 'code',
      phase: 'impl',
      priority: 1,
      ownership_files: ['src/example.ts'],
      goal_md: '按平台 ownership 执行。',
      timeout_seconds: 60,
      claim_token: 'claim-token',
      verify: [],
    } satisfies ClaimedTask;

    const prompt = codexWorker.buildCodexPrompt(task, 'codex-slot-prod-7');

    expect(prompt).toContain('你的 agent_id：codex-slot-prod-7');
    expect(prompt).not.toContain('你的 agent_id：codex\n');
  });

  it('通过 stdin 传递任务书，不把正文放进 ps 可见的 argv', () => {
    const task = {
      task_id: 'codex-stdin',
      title: '进程参数隐私',
      type: 'code',
      phase: 'impl',
      priority: 1,
      ownership_files: ['src/example.ts'],
      goal_md: '不得出现在 argv 的任务正文。',
      timeout_seconds: 60,
      claim_token: 'claim-token',
      verify: [],
    } satisfies ClaimedTask;

    const invocation = codexWorker.buildCodexInvocation(task, 'codex-prod');
    expect(invocation.args).toContain('--ephemeral');
    expect(invocation.args).toContain('--ignore-user-config');
    expect(invocation.args).toContain('--ignore-rules');
    expect(invocation.args).toContain('workspace-write');
    expect(invocation.args).toContain('sandbox_workspace_write.network_access=true');
    expect(invocation.args).toContain('model_reasoning_effort="high"');
    expect(invocation.args.at(-2)).toBe('--json');
    expect(invocation.args.at(-1)).toBe('-');
    expect(invocation.args.join(' ')).not.toContain(task.goal_md);
    expect(invocation.stdin).toContain(task.goal_md);
    expect(invocation.stdin).toContain('你的 agent_id：codex-prod');
  });
});
