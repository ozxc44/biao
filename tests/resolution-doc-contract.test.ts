import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');

describe('retry 耗尽后的 PM 决策文档契约', () => {
  it.each(['README.md', 'docs/autonomous-closure.md'])('%s 给出可执行的 inspect/continue/cancel 闭环', (relativePath) => {
    const content = readFileSync(join(repoRoot, relativePath), 'utf8');

    expect(content).toContain('.biao/pm task resolution <task_id>');
    expect(content).toContain('.biao/pm task resolution <task_id> --action continue');
    expect(content).toContain('.biao/pm task resolution <task_id> --action cancel');
    expect(content).toContain('只有 continue/cancel 成功后才 ack');
    expect(content).toContain('task reset --force');
  });
});
