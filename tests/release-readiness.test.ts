import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

    const expectedVariables = new Set([
      'ACCEPTANCE_REVERIFY_TEST_REDIS_URL',
      'AGENT_EPOCH_TEST_REDIS_URL',
      'BLOCKING_CLAIM_TEST_REDIS_URL',
      'LEASE_LIFECYCLE_TEST_REDIS_URL',
      'LEGACY_REVIEW_TEST_REDIS_URL',
      'MCP_LAN_TEST_REDIS_URL',
      'OWNERSHIP_TEST_REDIS_URL',
      'REPAIR_OWNERSHIP_TEST_REDIS_URL',
      'RESTORE_DOORBELL_TEST_REDIS_URL',
      'RESTORE_MAINTENANCE_TEST_REDIS_URL',
      'RUNTIME_RECONCILE_TEST_REDIS_URL',
      'STATUS_PROJECTION_TEST_REDIS_URL',
      'SUPERSEDE_TEST_REDIS_URL',
    ]);
    expect(variableNames).toEqual(expectedVariables);

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
    expect(config).toMatch(/pool:\s*['"]forks['"]/);
    expect(config).toMatch(/singleFork:\s*true/);
  });

  it('keeps the native SQLite driver inside the declared Node 20 compatibility line', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      engines?: { node?: string };
    };
    expect(packageJson.engines?.node).toBe('^20.19.0 || >=22.12.0 <27');
    expect(packageJson.dependencies?.['better-sqlite3']).toBe('^12.6.2');
  });

  it('builds the server before tests that launch packaged CLI entrypoints', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.pretest).toBe('npm run build:server');

    const workflow = YAML.parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const portableSteps = workflow.jobs?.node22?.steps ?? [];
    const buildIndex = portableSteps.findIndex((step) => step.run === 'npm run build:server');
    const testIndex = portableSteps.findIndex((step) => step.name === 'Test server without Redis integration suites');
    expect(buildIndex).toBeGreaterThan(-1);
    expect(testIndex).toBeGreaterThan(buildIndex);
  });

  it('keeps full Redis tests on the primary Node job and runs portable server/package gates on Node 22', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
      jobs?: Record<string, {
        services?: Record<string, unknown>;
        steps?: Array<{ uses?: string; with?: Record<string, string>; run?: string }>;
      }>;
    };
    const primary = workflow.jobs?.test;
    const portable = workflow.jobs?.node22;

    expect(primary?.services?.redis).toBeTruthy();
    expect(portable).toBeTruthy();
    expect(portable?.services).toBeUndefined();

    const setupNode = portable?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['node-version']).toBe('22.12.0');
    const commands = portable?.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('npm run test:web');
    expect(commands).toContain('tests/worker.test.ts');
    expect(commands).toContain('tests/worker-signal-propagation.test.ts');
    expect(commands).toContain('tests/supervisor-runtime.test.ts');
    expect(commands).toContain('npm run build');
    expect(commands).toContain('npm run verify:package');
    expect(commands).not.toMatch(/\bnpm test\b/);
  });

  it('documents both supported layouts and the operational audit boundaries', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    expect(readme).toContain('### 源码 clone');
    expect(readme).toContain('### 已安装 npm tarball');
    expect(readme).toContain('./node_modules/.bin/biao-bootstrap');
    expect(readme).toContain('当前待处理');
    expect(readme).toContain('历史审计');
    expect(readme).toContain('显式离线');
    expect(readme).toContain('排除但保留审计');
  });

  it('licenses public source under Apache-2.0 while keeping npm publishing disabled', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      private?: boolean;
      license?: string;
    };
    const workflowSources = readdirSync(join(root, '.github', 'workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => readFileSync(join(root, '.github', 'workflows', name), 'utf8'));

    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe('Apache-2.0');
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Apache License');
    for (const document of ['NOTICE', 'CONTRIBUTING.md', 'SECURITY.md']) {
      expect(existsSync(join(root, document))).toBe(true);
    }
    expect(workflowSources.join('\n')).not.toMatch(/\bnpm publish\b/);
  });
});
