import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bootstrap Supervisor launcher', () => {
  it.skipIf(!existsSync(join(process.cwd(), 'web', 'dist', 'index.html')))('reloads owner slot configuration before each Supervisor child starts', async () => {
    const { bootstrap } = await import('./bootstrap.mjs');
    const root = mkdtempSync(join(tmpdir(), 'biao-bootstrap-supervisor-reload-'));
    tempRoots.push(root);
    const workspace = join(root, 'workspace');
    const project = join(workspace, 'project');
    const runtimeDir = join(root, 'runtime');
    mkdirSync(project, { recursive: true });

    bootstrap({
      repoRoot: join(import.meta.dirname, '..'),
      workspace,
      project,
      runtimeDir,
      token: 'test-token',
      redisUrl: 'redis://127.0.0.1:6379',
      port: 7331,
      skipInstall: true,
      skipBuild: true,
    });

    const start = readFileSync(join(runtimeDir, 'start'), 'utf8');
    expect(start).toContain('echo "[biao] 日志目录：${log_dir}（server.log / supervisor.log）"');
    expect(start).toMatch(/\(\n\s+set -a\n\s+\. "\$SCRIPT_DIR\/config\.env"\n\s+set \+a\n\s+exec node "\$BIAO_PACKAGE_ROOT\/scripts\/supervisor\.mjs"\n\s+\) >> "\$log_dir\/supervisor\.log" 2>&1 &/);
  });
});
