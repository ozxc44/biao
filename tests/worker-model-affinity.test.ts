import { describe, expect, it } from 'vitest';
import { buildCodexInvocation } from '../src/worker/codex.js';
import { resolveKimiTaskModel } from '../src/worker/kimi.js';
import { buildCliGoal, resolveCliTaskModel } from '../src/worker/cli.js';
import type { ClaimedTask } from '../src/types/index.js';

const task = {
  task_id: 'model-affinity-task',
  title: 'model affinity',
  type: 'code',
  phase: 'impl',
  priority: 5,
  goal_md: 'Use the requested model.',
  timeout_seconds: 60,
  claim_token: 'claim-token',
  verify: [],
  ownership_files: [],
  project_path: '/tmp/model-affinity-project',
  plan_id: 'model-affinity-plan',
  model_override: 'kimi-code/k3-affinity',
} satisfies ClaimedTask;

describe('Worker model affinity', () => {
  it('Codex invocation honors task.model_override as an argv value', () => {
    const codexTask = { ...task, model_override: 'gpt-5.6-codex' };
    const invocation = buildCodexInvocation(codexTask, 'codex-model-slot');
    const modelFlag = invocation.args.indexOf('-m');
    expect(modelFlag).toBeGreaterThanOrEqual(0);
    expect(invocation.args[modelFlag + 1]).toBe('gpt-5.6-codex');
    expect(invocation.args.join(' ')).not.toContain(task.goal_md);
  });

  it('Kimi and custom Worker use task.model_override before their slot default', () => {
    expect(resolveKimiTaskModel(task, 'kimi-code/k3')).toBe('kimi-code/k3-affinity');
    expect(resolveCliTaskModel(task, 'slot-default')).toBe('kimi-code/k3-affinity');
    expect(buildCliGoal(task)).toContain('指定模型：kimi-code/k3-affinity');
  });

  it('empty override falls back to the configured slot model', () => {
    const automatic = { ...task, model_override: '  ' };
    expect(resolveKimiTaskModel(automatic, 'kimi-code/k3')).toBe('kimi-code/k3');
    expect(resolveCliTaskModel(automatic, 'custom-slot')).toBe('custom-slot');
  });
});
