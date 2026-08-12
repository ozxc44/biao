import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREBUILT_RUNTIME_INPUTS } from '../scripts/bootstrap.mjs';

interface PackEntry {
  files?: Array<{ path?: string }>;
}

describe('npm package contents', () => {
  function getPackagedPaths(packageRoot: string): Set<string> {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    const packed = JSON.parse(output) as PackEntry[];
    return new Set((packed[0]?.files ?? []).map((file) => file.path));
  }

  it('includes every docs markdown file linked from README', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
    const linkedDocs = [...readme.matchAll(/\]\((docs\/[^)#?]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1]);

    expect(linkedDocs.length).toBeGreaterThan(0);
    const packagedPaths = getPackagedPaths(packageRoot);

    expect([...new Set(linkedDocs)].filter((path) => !packagedPaths.has(path))).toEqual([]);
  });

  it('package files declaration covers the complete prebuilt runtime used by bootstrap', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files?: string[] };
    const declared = packageJson.files ?? [];
    const isCovered = (path: string) => declared.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));

    expect(PREBUILT_RUNTIME_INPUTS.filter((path) => !isCovered(path))).toEqual([]);
    expect(declared).toContain('scripts/verify-package.mjs');
  });
});
