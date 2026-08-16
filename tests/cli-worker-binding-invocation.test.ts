import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBindingCliInvocation } from '../src/worker/cli.js';

describe('CLI invocation follows ProjectAgentBinding wake mode', () => {
  it('keeps task argv only for the background executor path', () => {
    expect(resolveBindingCliInvocation({
      wakeMode: 'background_executor', command: '/opt/worker',
      taskId: 'task-1', goalFile: '/work/goal.md', workDir: '/work/task-1',
    })).toEqual({ command: '/opt/worker', args: ['task-1', '/work/goal.md', '/work/task-1'] });
  });

  it.each(['visible_session', 'external_worker'] as const)('passes no task or credential argv in %s mode', (wakeMode) => {
    expect(resolveBindingCliInvocation({
      wakeMode, command: '/opt/harness', taskId: 'secret-task', goalFile: '/secret/goal.md', workDir: '/secret/work',
    })).toEqual({ command: '/opt/harness', args: [] });
  });

  it('persists only local adapter metadata for an external binding slot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-config-'));
    const config = join(dir, 'config.env');
    writeFileSync(config, "BIAO_API_TOKEN='must-not-print'\n", { mode: 0o600 });
    try {
      const cli = join(import.meta.dirname, '..', 'scripts', 'supervisor-config.mjs');
      const added = spawnSync(process.execPath, [
        cli, '--config', config, 'worker', 'add',
        '--id', 'external-agent', '--kind', 'custom', '--project', '/workspace/project-a',
        '--types', 'code', '--command', '/opt/harness-adapter',
        '--binding-id', 'binding-external', '--harness-kind', 'custom',
        '--wake-mode', 'external_worker', '--adapter-id', 'external-adapter-v1',
      ], { encoding: 'utf8' });
      expect(added.status).toBe(0);
      expect(`${added.stdout}${added.stderr}`).not.toContain('must-not-print');
      const content = readFileSync(config, 'utf8');
      expect(content).toContain('binding-external');
      expect(content).toContain('external_worker');
      expect(content).not.toContain('target');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
