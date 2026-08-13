import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREBUILT_RUNTIME_INPUTS } from '../scripts/bootstrap.mjs';
import { renderInstallScript } from '../src/server/http.js';

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

  it('packages both language READMEs and every linked docs markdown file', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const readmePaths = ['README.md', 'README.en.md'];
    const readmes = readmePaths.map((path) => readFileSync(join(packageRoot, path), 'utf8'));
    const linkedDocs = readmes.flatMap((readme) => (
      [...readme.matchAll(/\]\((docs\/[^)#?]+\.md)(?:#[^)]+)?\)/g)].map((match) => match[1])
    ));

    expect(linkedDocs.length).toBeGreaterThan(0);
    const packagedPaths = getPackagedPaths(packageRoot);

    expect(readmePaths.filter((path) => !packagedPaths.has(path))).toEqual([]);
    expect([...new Set(linkedDocs)].filter((path) => !packagedPaths.has(path))).toEqual([]);
  });

  it('package files declaration covers the complete prebuilt runtime used by bootstrap', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files?: string[] };
    const declared = packageJson.files ?? [];
    const isCovered = (path: string) => path === 'package.json'
      || declared.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, '')}/`));

    expect(PREBUILT_RUNTIME_INPUTS.filter((path) => !isCovered(path))).toEqual([]);
    expect(declared).toContain('scripts/verify-package.mjs');
  });

  it('exposes a packaged biao-bootstrap command with standalone help', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    const packagedPaths = getPackagedPaths(packageRoot);

    expect(packageJson.bin?.['biao-bootstrap']).toBe('bin/biao-bootstrap.js');
    expect(packagedPaths).toContain('bin/biao-bootstrap.js');

    const help = execFileSync(process.execPath, [join(packageRoot, 'bin', 'biao-bootstrap.js'), '--help'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(help).toContain('biao-bootstrap --yes --workspace');
    expect(help).toContain('./bootstrap.sh --yes --workspace');
  });

  it('the served local CLI installer exposes the same bootstrap command', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const installer = readFileSync(join(packageRoot, 'scripts', 'install.sh'), 'utf8');

    expect(installer).toContain('bin/biao-bootstrap.js" "$BIN_DIR/biao-bootstrap"');
  });

  it('renders the served installer package path as inert POSIX shell data', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const template = readFileSync(join(packageRoot, 'scripts', 'install.sh'), 'utf8');
    const packagePath = `/tmp/package ' " $HOME $(printf injected) \`printf injected\``;
    const rendered = renderInstallScript(template, packagePath);
    const assignment = rendered.split('\n').find((line) => line.startsWith('BIAO_PKG='));
    expect(assignment).toBeDefined();
    const run = spawnSync('/bin/sh', ['-c', `${assignment}\nprintf "<%s>\\n" "$BIAO_PKG"\n`], {
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`<${packagePath}>\n`);
    expect(run.stderr).toBe('');
    expect(() => renderInstallScript(template, '/tmp/package\nnext-command')).toThrow(/控制字符|换行/);
    expect(() => renderInstallScript('echo missing-placeholder\n', '/tmp/package')).toThrow(/placeholder|模板/);
  });

  it('verifies packaged Codex PM wiring without requiring the real Agent CLI on CI', () => {
    const packageRoot = join(import.meta.dirname, '..');
    const smoke = readFileSync(join(packageRoot, '.github', 'scripts', 'package-smoke.sh'), 'utf8');

    // The smoke deliberately exercises the first-run PM integration. A local inert executable
    // satisfies doctor on a clean runner; the test never invokes an external Agent or network API.
    expect(smoke).toMatch(/--pm-agent(?:=|\s+)codex\b/);
    expect(smoke).toContain('fake_agent_bin="$consumer_dir/fake-agent-bin"');
    expect(smoke).toContain('PATH="$fake_agent_bin:$PATH" "$runtime_root/doctor"');
    // Config points at the generated stable runtime wrapper, not a replaceable package path.
    expect(smoke).toContain('runtime_real_root=$(cd "$runtime_root" && pwd -P)');
    expect(smoke).toContain("BIAO_PM_AGENT_CMD='$runtime_real_root/codex-pm-agent'");
    expect(smoke).toContain('BIAO_EXEC_CMD=/bin/true');
    expect(smoke).toContain('runtime_root="$consumer_dir/.biao"');
    expect(smoke).toContain('cd "$consumer_dir"');
    expect(smoke).not.toContain('$installed_root/.biao/');
    expect(smoke).not.toMatch(/npm install[^\n]*--ignore-scripts/);
  });
});
