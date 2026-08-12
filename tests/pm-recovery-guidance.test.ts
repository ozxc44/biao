import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

describe('PM blocked/stale/legacy failed 自治引导契约', () => {
  it.each(['README.md', 'docs/autonomous-closure.md'])('%s 给出分状态、可执行且 fail-closed 的恢复路径', (relativePath) => {
    const content = readFileSync(join(repoRoot, relativePath), 'utf8');

    expect(content).toContain('.biao/pm task get <task_id>');
    expect(content).toContain('.biao/pm task resume <task_id>');
    expect(content).toContain('.biao/pm watchdog --auto-fix');
    expect(content).toContain('waiting_dependency / waiting_file_release');
    expect(content).toContain('条件已经消失');
    expect(content).toContain('真正无法自治');
    expect(content).toContain('禁止 reset');
  });
});
