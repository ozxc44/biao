import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackEntry {
  files?: Array<{ path?: string }>;
}

describe('npm package contents', () => {
  it('includes every docs markdown file linked from README', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
    const linkedDocs = [...readme.matchAll(/\]\((docs\/[^)#?]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]);

    expect(linkedDocs.length).toBeGreaterThan(0);

    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    const packed = JSON.parse(output) as PackEntry[];
    const packagedPaths = new Set((packed[0]?.files ?? []).map((file) => file.path));

    expect([...new Set(linkedDocs)].filter((path) => !packagedPaths.has(path))).toEqual([]);
  });
});
