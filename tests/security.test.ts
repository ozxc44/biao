import { delimiter, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorkspaceRoots, resolveAndValidateWorkspacePath } from '../src/server/security.js';
import { assertSafeServerConfig, isServerEntrypoint, resolveServerConfig } from '../src/server/main.js';

describe('workspace path security', () => {
  it('parses, resolves and deduplicates workspace roots', () => {
    const raw = [` ./workspace-a `, './workspace-b', './workspace-a'].join(delimiter);

    expect(parseWorkspaceRoots(raw)).toEqual([
      resolve('./workspace-a'),
      resolve('./workspace-b'),
    ]);
  });

  it('allows a path nested under an allowed workspace root', () => {
    const root = resolve('/tmp/biao-workspace');

    expect(resolveAndValidateWorkspacePath(`${root}/plans/demo`, [root])).toBe(
      resolve(root, 'plans/demo'),
    );
  });

  it('rejects traversal outside an allowed workspace root', () => {
    const root = resolve('/tmp/biao-workspace');

    expect(() => resolveAndValidateWorkspacePath(`${root}/../outside`, [root])).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }),
    );
  });

  it('rejects an empty or NUL-containing path', () => {
    expect(() => resolveAndValidateWorkspacePath('  ', [])).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }),
    );
    expect(() => resolveAndValidateWorkspacePath('/tmp/work\0space', [])).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }),
    );
  });

  it('keeps local compatibility when no workspace roots are configured', () => {
    expect(resolveAndValidateWorkspacePath('./plans/demo', [])).toBe(resolve('./plans/demo'));
  });
});

describe('server configuration contract', () => {
  it('server 入口经符号链接或系统路径规范化后仍识别为直接执行', () => {
    const root = mkdtempSync(join(tmpdir(), 'biao-server-entry-'));
    try {
      const entry = join(root, 'main.js');
      const alias = join(root, 'main-alias.js');
      writeFileSync(entry, '// main\n');
      symlinkSync(entry, alias);
      expect(isServerEntrypoint(alias, pathToFileURL(entry).href)).toBe(true);
      expect(isServerEntrypoint(join(root, 'missing.js'), pathToFileURL(entry).href)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives token, workspace roots and sqlite path from environment', () => {
    const config = resolveServerConfig(
      {},
      {
        BIAO_API_TOKEN: 'secret-token',
        BIAO_WORKSPACE_ROOTS: ['/srv/team-a', '/srv/team-b'].join(delimiter),
        BIAO_DATA_DIR: '/var/lib/biao',
      },
      [],
    );

    expect(config.apiToken).toBe('secret-token');
    expect(config.workspaceRoots).toEqual(['/srv/team-a', '/srv/team-b']);
    expect(config.sqlitePath).toBe('/var/lib/biao/biao.sqlite');
  });

  it('prefers BIAO_SQLITE_PATH over BIAO_DATA_DIR', () => {
    const config = resolveServerConfig(
      {},
      { BIAO_SQLITE_PATH: '/tmp/custom.sqlite', BIAO_DATA_DIR: '/var/lib/biao' },
      [],
    );

    expect(config.sqlitePath).toBe('/tmp/custom.sqlite');
  });

  it('rejects non-loopback exposure without both token and workspace roots', () => {
    const withoutToken = resolveServerConfig({ host: '0.0.0.0', workspaceRoots: ['/srv/work'] }, {}, []);
    const withoutRoots = resolveServerConfig({ host: '192.168.1.20', apiToken: 'secret' }, {}, []);

    expect(() => assertSafeServerConfig(withoutToken)).toThrow(/BIAO_API_TOKEN/);
    expect(() => assertSafeServerConfig(withoutRoots)).toThrow(/BIAO_WORKSPACE_ROOTS/);
  });

  it('allows loopback compatibility and secured non-loopback exposure', () => {
    const loopback = resolveServerConfig({ host: '127.0.0.1' }, {}, []);
    const secured = resolveServerConfig(
      { host: '0.0.0.0', apiToken: 'secret', workspaceRoots: ['/srv/work'] },
      {},
      [],
    );

    expect(() => assertSafeServerConfig(loopback)).not.toThrow();
    expect(() => assertSafeServerConfig(secured)).not.toThrow();
  });
});
