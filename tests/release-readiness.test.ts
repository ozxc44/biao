import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const root = join(import.meta.dirname, '..');

describe('release configuration', () => {
  it('CI routes every dedicated Redis test suite to a unique non-production DB', () => {
    const testRoot = join(root, 'tests');
    const variableNames = new Set<string>();
    for (const name of readdirSync(testRoot).filter((entry) => entry.endsWith('.test.ts'))) {
      const source = readFileSync(join(testRoot, name), 'utf8');
      for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+_TEST_REDIS_URL)\b/g)) {
        variableNames.add(match[1]);
      }
    }

    expect([...variableNames].sort()).toHaveLength(8);

    const workflow = YAML.parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs?: { test?: { env?: Record<string, string> } };
    };
    const env = workflow.jobs?.test?.env ?? {};
    const dedicatedUrls = [...variableNames].sort().map((name) => {
      expect(env[name], `${name} must be explicit in CI`).toBeTruthy();
      return new URL(env[name]);
    });

    for (const url of dedicatedUrls) {
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.port).toBe('6379');
      const database = Number(url.pathname.slice(1));
      expect(Number.isInteger(database)).toBe(true);
      expect(database).toBeGreaterThanOrEqual(2);
      expect(database).toBeLessThanOrEqual(15);
    }
    expect(new Set(dedicatedUrls.map((url) => url.pathname)).size).toBe(dedicatedUrls.length);
  });

  it('the repository test runner remains single-fork while Redis suites use FLUSHDB', () => {
    const config = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/fileParallelism:\s*false/);
    expect(config).toMatch(/singleFork:\s*true/);
  });
});
