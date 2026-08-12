import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadBootstrap() {
  return import('../scripts/bootstrap.mjs');
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'biao-bootstrap-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(
    join(root, 'bin', 'biao.js'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({args: process.argv.slice(2), url: process.env.BIAO_URL, agent: process.env.BIAO_AGENT_ID}))\n',
  );
  seedPrebuiltPackage(root);
  return root;
}

function seedSourceCheckout(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  writeFileSync(join(root, 'web', 'package.json'), '{}\n');
  writeFileSync(join(root, 'web', 'package-lock.json'), '{}\n');
}

function seedPrebuiltPackage(root: string): void {
  for (const relativePath of [
    'package.json',
    'dist/index.js',
    'dist/server/main.js',
    'dist/cli/index.js',
    'dist/worker/supervisor.js',
    'dist/worker/codex.js',
    'dist/worker/kimi.js',
    'dist/worker/cli.js',
    'web/dist/index.html',
    'web/dist/manifest.json',
    'web/dist/assets/app.js',
    'web/dist/assets/app.css',
    'bin/biao-worker.js',
    'bin/cli-worker.js',
    'bin/codex-worker.js',
    'bin/kimi-worker.js',
    'bin/worker-help.js',
    'dist/db/schema.sql',
    'scripts/install.sh',
    'scripts/pm-agent.mjs',
    'scripts/codex-pm-agent.mjs',
    'scripts/supervisor.mjs',
    'scripts/redis-probe.mjs',
  ]) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    const contents = relativePath.endsWith('.html')
      ? '<!doctype html>\n'
      : relativePath.endsWith('manifest.json')
        ? '{}\n'
        : relativePath === 'package.json'
          ? '{"type":"module"}\n'
          : '// packaged runtime\n';
    writeFileSync(path, contents);
  }
  writeFileSync(
    join(root, 'web', 'dist', 'index.html'),
    '<!doctype html><script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">\n',
  );
  writeFileSync(
    join(root, 'web', 'dist', 'manifest.json'),
    JSON.stringify({
      'index.html': {
        file: 'assets/app.js',
        css: ['assets/app.css'],
        assets: ['assets/logo.svg'],
        isEntry: true,
      },
    }),
  );
  const logoPath = join(root, 'web', 'dist', 'assets', 'logo.svg');
  writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeControlledPath(root: string, osName: 'Darwin' | 'Linux'): string {
  const fakeBin = join(root, `fake-bin-${osName.toLowerCase()}`);
  mkdirSync(fakeBin);
  symlinkSync('/usr/bin/dirname', join(fakeBin, 'dirname'));
  symlinkSync(process.execPath, join(fakeBin, 'node'));
  writeExecutable(join(fakeBin, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${osName}'\n`);
  return fakeBin;
}

describe('clone 后自举配置', () => {
  it('npm 发布清单包含 bootstrap 依赖的 PM 唤醒器', () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files?: string[] };
    expect(packageJson.files).toContain('scripts/pm-agent.mjs');
    expect(packageJson.files).toContain('scripts/codex-pm-agent.mjs');
  });

  it('正确解析 shell 入口转交的确认与跳过选项', async () => {
    const { parseArgs } = await loadBootstrap();
    expect(parseArgs(['-y', '--no-install', '--no-build', '--redis-url', 'redis://localhost:6380'])).toEqual({
      yes: true,
      skipInstall: true,
      skipBuild: true,
      redis_url: 'redis://localhost:6380',
    });
  });

  it('入口路径经过符号链接或系统路径规范化后仍识别为直接执行', async () => {
    const { isBootstrapMain } = await loadBootstrap();
    const root = makeRoot();
    const entry = join(root, 'bootstrap-entry.mjs');
    const alias = join(root, 'bootstrap-alias.mjs');
    writeFileSync(entry, '// entry\n');
    symlinkSync(entry, alias);

    expect(isBootstrapMain(alias, pathToFileURL(entry).href)).toBe(true);
    expect(isBootstrapMain(join(root, 'missing.mjs'), pathToFileURL(entry).href)).toBe(false);
  });

  it('拒绝把 Token 放进 argv，并引导使用安全入口', async () => {
    const { parseArgs } = await loadBootstrap();

    expect(() => parseArgs(['--token', 'must-not-enter-argv']))
      .toThrow(/--token-file|BIAO_BOOTSTRAP_TOKEN/);
    expect(() => parseArgs(['--token=must-not-enter-argv']))
      .toThrow(/--token-file|BIAO_BOOTSTRAP_TOKEN/);
  });

  it('从 owner-only Token 文件或专用环境变量读取已有 Token', async () => {
    const { resolveBootstrapToken } = await loadBootstrap();
    const root = makeRoot();
    const tokenPath = join(root, 'bootstrap-token');
    writeFileSync(tokenPath, 'file-secret\n', { mode: 0o600 });
    chmodSync(tokenPath, 0o600);

    expect(resolveBootstrapToken({ token_file: tokenPath }, {})).toBe('file-secret');
    expect(resolveBootstrapToken({}, { BIAO_BOOTSTRAP_TOKEN: 'env-secret' })).toBe('env-secret');
    expect(() => resolveBootstrapToken(
      { token_file: tokenPath },
      { BIAO_BOOTSTRAP_TOKEN: 'ambiguous-secret' },
    )).toThrow(/不能同时/);
  });

  it('npm 安装和构建子进程不继承 bootstrap 或运行时 API Token', async () => {
    const { sanitizedBootstrapChildEnvironment } = await loadBootstrap();

    expect(sanitizedBootstrapChildEnvironment({
      PATH: '/safe/bin',
      BIAO_BOOTSTRAP_TOKEN: 'bootstrap-secret',
      BIAO_API_TOKEN: 'runtime-secret',
      KEEP_ME: 'visible',
    })).toEqual({
      PATH: '/safe/bin',
      KEEP_ME: 'visible',
    });
  });

  it('拒绝权限过宽、空内容或多行的 Token 文件', async () => {
    const { resolveBootstrapToken } = await loadBootstrap();
    const root = makeRoot();

    const publicPath = join(root, 'public-token');
    writeFileSync(publicPath, 'public-secret\n', { mode: 0o644 });
    chmodSync(publicPath, 0o644);
    expect(() => resolveBootstrapToken({ token_file: publicPath }, {})).toThrow(/权限.*600|owner-only/);

    const emptyPath = join(root, 'empty-token');
    writeFileSync(emptyPath, '\n', { mode: 0o600 });
    chmodSync(emptyPath, 0o600);
    expect(() => resolveBootstrapToken({ token_file: emptyPath }, {})).toThrow(/不能为空/);

    const multilinePath = join(root, 'multiline-token');
    writeFileSync(multilinePath, 'line-one\nline-two\n', { mode: 0o600 });
    chmodSync(multilinePath, 0o600);
    expect(() => resolveBootstrapToken({ token_file: multilinePath }, {})).toThrow(/单行/);
  });

  it('生成安全配置、启动器、Worker 接入器和 PM 操作手册', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace root');
    const project = join(workspace, 'demo-project');
    mkdirSync(project, { recursive: true });

    const result = bootstrap({
      repoRoot: root,
      workspace,
      project,
      token: 'test-token',
      redisUrl: 'redis://127.0.0.1:6379',
      port: 7331,
      skipInstall: true,
      skipBuild: true,
    });

    expect(result.created).toBe(true);
    const config = readFileSync(join(root, '.biao', 'config.env'), 'utf8');
    expect(config).toContain("BIAO_WORKSPACE_ROOTS='");
    expect(config).toContain("BIAO_API_TOKEN='test-token'");
    expect(config).toContain(`BIAO_PREFERRED_PROJECT='${project}'`);
    expect(statSync(join(root, '.biao', 'config.env')).mode & 0o777).toBe(0o600);

    for (const name of ['doctor', 'start', 'copy-token', 'token-status', 'pm', 'pm-intake', 'pm-start', 'pm-agent', 'codex-pm-agent', 'supervisor', 'worker-codex', 'worker-kimi', 'worker-custom']) {
      expect(statSync(join(root, '.biao', name)).mode & 0o111).not.toBe(0);
    }
    const doctor = readFileSync(join(root, '.biao', 'doctor'), 'utf8');
    expect(doctor).toContain('Node.js 20.19+');
    expect(doctor).toContain('scripts/redis-probe.mjs');
    expect(doctor).toContain('unset BIAO_API_TOKEN');
    expect(doctor).not.toContain('redis-cli -u');
    expect(readFileSync(join(root, '.biao', 'supervisor'), 'utf8')).toContain('scripts/supervisor.mjs');
    expect(readFileSync(join(root, '.biao', 'pm-start'), 'utf8')).toContain('pm start');
    expect(readFileSync(join(root, '.biao', 'pm-agent'), 'utf8')).toContain('scripts/pm-agent.mjs');
    expect(readFileSync(join(root, '.biao', 'codex-pm-agent'), 'utf8')).toContain('scripts/codex-pm-agent.mjs');
    expect(readFileSync(join(root, '.biao', 'worker-codex'), 'utf8')).toContain('BIAO_EXIT_ON_IDLE');
    expect(readFileSync(join(root, '.biao', 'worker-custom'), 'utf8')).toContain('bin/biao-worker.js');
    expect(readFileSync(join(root, '.biao', 'worker-custom'), 'utf8')).toContain('"--help"');

    const guide = readFileSync(join(root, '.biao', 'PM_AGENT.md'), 'utf8');
    expect(guide).toContain('.biao/pm-intake');
    expect(guide).toContain('.biao/pm-start --once');
    expect(guide).toContain('.biao/pm-agent --once');
    expect(guide).toContain('BIAO_PM_AGENT_CMD');
    expect(guide).toContain('不自动 review、answer 或 ack');
    expect(guide).toContain('不自动安装 cron 或 launchd');
    expect(guide).toContain('done 不等于 accepted');
    expect(guide).toContain('独立验收');
    expect(guide).toContain('.biao/pm plan create');
    expect(guide).toContain('--verify-cmd');
    expect(guide).toContain('.biao/supervisor');
    expect(guide).toContain('.biao/pm question list');
    expect(guide).toContain('.biao/pm task resolution <task_id>');
    expect(guide).toContain('--action continue');
    expect(guide).toContain('--action cancel');
    expect(guide).toContain('只有 continue/cancel 成功后才 ack');
    expect(guide).toContain('.biao/pm task get <task_id>');
    expect(guide).toContain('.biao/pm task resume <task_id>');
    expect(guide).toContain('.biao/pm watchdog --auto-fix');
    expect(guide).toContain('waiting_dependency / waiting_file_release');
    expect(guide).toContain('条件已经消失');
    expect(guide).toContain('真正无法自治');
    expect(guide).toContain('BIAO_QUESTION:');
    expect(guide).toContain('question_asked_event_id');
    expect(guide).toContain('新的 claim token');
    expect(guide).toContain('绕过平台问人');
    expect(guide).toContain('不会自动 ack');
    expect(guide).toContain('.biao/pm pm intake');
    expect(guide).toContain('.biao/pm pm ack');
    expect(guide).toContain('.biao/copy-token');
    expect(guide).toContain('sessionStorage');
    expect(guide).not.toMatch(/\.biao\/pm (?:intake|ack)\b/);

    const output = execFileSync(join(root, '.biao', 'pm'), ['status'], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({
      args: ['status'],
      url: 'http://127.0.0.1:7331',
      agent: 'pm-agent',
    });

    const pmIntakeOutput = execFileSync(join(root, '.biao', 'pm'), ['pm', 'intake', '--consumer', 'pm-test'], { encoding: 'utf8' });
    expect(JSON.parse(pmIntakeOutput)).toEqual({
      args: ['pm', 'intake', '--consumer', 'pm-test'],
      url: 'http://127.0.0.1:7331',
      agent: 'pm-agent',
    });

    const pmAckOutput = execFileSync(join(root, '.biao', 'pm'), ['pm', 'ack', '--consumer', 'pm-test', '--event-id', 'event-1'], { encoding: 'utf8' });
    expect(JSON.parse(pmAckOutput)).toEqual({
      args: ['pm', 'ack', '--consumer', 'pm-test', '--event-id', 'event-1'],
      url: 'http://127.0.0.1:7331',
      agent: 'pm-agent',
    });

    const pmStartOutput = execFileSync(join(root, '.biao', 'pm-start'), ['--help'], { encoding: 'utf8' });
    expect(JSON.parse(pmStartOutput)).toEqual({
      args: ['pm', 'start', '--help'],
      url: 'http://127.0.0.1:7331',
      agent: 'pm-agent',
    });
  });

  it('copy-token 在 macOS 优先经 stdin 交给 pbcopy，终端和 argv 都不泄露 Token', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const commandInjectionSentinel = join(root, 'must-not-be-created');
    const token = `copy me ' "$HOME" $(touch ${commandInjectionSentinel}) \`uname\` ; #`;
    bootstrap({ repoRoot: root, workspace, project: workspace, token, skipInstall: true, skipBuild: true });

    const fakeBin = makeControlledPath(root, 'Darwin');
    const clipboardPath = join(root, 'clipboard.txt');
    const argvPath = join(root, 'clipboard-argv.txt');
    const tokenEnvPath = join(root, 'clipboard-token-env.txt');
    writeExecutable(join(fakeBin, 'pbcopy'), `#!/bin/sh\nprintf '%s\\n' "$#" > "$BIAO_TEST_ARGV"\nprintf '%s' "\${BIAO_API_TOKEN-unset}" > "$BIAO_TEST_TOKEN_ENV"\n/bin/cat > "$BIAO_TEST_CLIPBOARD"\n`);

    const run = spawnSync('/bin/sh', [join(root, '.biao', 'copy-token')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: fakeBin,
        BIAO_API_TOKEN: 'parent-export-must-be-cleared',
        BIAO_TEST_ARGV: argvPath,
        BIAO_TEST_CLIPBOARD: clipboardPath,
        BIAO_TEST_TOKEN_ENV: tokenEnvPath,
      },
    });

    expect(run.status).toBe(0);
    expect(readFileSync(clipboardPath, 'utf8')).toBe(token);
    expect(readFileSync(argvPath, 'utf8')).toBe('0\n');
    expect(readFileSync(tokenEnvPath, 'utf8')).toBe('unset');
    expect(existsSync(commandInjectionSentinel)).toBe(false);
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
    expect(run.stdout).toContain('已复制');
  });

  it.each([
    ['wl-copy', ''],
    ['xclip', '-selection clipboard'],
    ['xsel', '--clipboard --input'],
  ])('copy-token 在 Linux 支持 %s 且只把 Token 写入 stdin', async (tool, expectedArgs) => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const token = `linux-${tool}-secret`;
    bootstrap({ repoRoot: root, workspace, project: workspace, token, skipInstall: true, skipBuild: true });

    const fakeBin = makeControlledPath(root, 'Linux');
    const clipboardPath = join(root, `${tool}-clipboard.txt`);
    const argvPath = join(root, `${tool}-argv.txt`);
    writeExecutable(join(fakeBin, tool), `#!/bin/sh\nprintf '%s' "$*" > "$BIAO_TEST_ARGV"\n/bin/cat > "$BIAO_TEST_CLIPBOARD"\n`);

    const run = spawnSync('/bin/sh', [join(root, '.biao', 'copy-token')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin, BIAO_TEST_ARGV: argvPath, BIAO_TEST_CLIPBOARD: clipboardPath },
    });

    expect(run.status).toBe(0);
    expect(readFileSync(clipboardPath, 'utf8')).toBe(token);
    expect(readFileSync(argvPath, 'utf8')).toBe(expectedArgs);
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
  });

  it('copy-token 无可用剪贴板工具时给安全指引并非零退出，不打印 Token', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const token = 'no-clipboard-secret';
    bootstrap({ repoRoot: root, workspace, project: workspace, token, skipInstall: true, skipBuild: true });
    const fakeBin = makeControlledPath(root, 'Linux');

    const run = spawnSync('/bin/sh', [join(root, '.biao', 'copy-token')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });

    expect(run.status).toBe(2);
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
    expect(run.stderr).toContain('wl-copy、xclip 或 xsel');
    expect(run.stderr).toContain('不要打印到终端');
  });

  it('token-status 只显示已配置和哈希指纹末尾，不泄露原 Token', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const token = 'fingerprint-only-secret';
    bootstrap({ repoRoot: root, workspace, project: workspace, token, skipInstall: true, skipBuild: true });
    const fakeBin = makeControlledPath(root, 'Linux');

    const run = spawnSync('/bin/sh', [join(root, '.biao', 'token-status')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });

    const fingerprintSuffix = createHash('sha256').update(token).digest('hex').slice(-12);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('已配置');
    expect(run.stdout).toContain(fingerprintSuffix);
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
  });

  it('bootstrap 完成提示给出启动、复制和右上角粘贴的安全网页登录顺序', async () => {
    const { formatCompletion } = await loadBootstrap();
    const output = formatCompletion({ created: true, upgraded: false });

    expect(output).toContain('.biao/start');
    expect(output).toContain('.biao/copy-token');
    expect(output).toContain('右上角');
    expect(output).toContain('sessionStorage');
    expect(output).not.toContain('BIAO_API_TOKEN=');
  });

  it('README 与 Worker 接入文档提供不经 URL 或终端输出的网页登录步骤', () => {
    const root = join(import.meta.dirname, '..');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const workerGuide = readFileSync(join(root, 'docs', 'worker-integration.md'), 'utf8');
    for (const document of [readme, workerGuide]) {
      expect(document).toContain('.biao/copy-token');
      expect(document).toContain('右上角');
      expect(document).toContain('sessionStorage');
      expect(document).toMatch(/不(?:会|要).*URL/);
    }
    expect(readme).not.toMatch(/--token(?:=|\s+)/);
    expect(readme).toContain('--token-file');
  });

  it('默认不覆盖已有配置，force 时才重新生成', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'first-token',
      skipInstall: true,
      skipBuild: true,
    });
    const preserved = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'second-token',
      skipInstall: true,
      skipBuild: true,
    });
    expect(preserved.created).toBe(false);
    expect(readFileSync(join(root, '.biao', 'config.env'), 'utf8')).toContain('first-token');

    const replaced = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'second-token',
      skipInstall: true,
      skipBuild: true,
      force: true,
    });
    expect(replaced.created).toBe(true);
    expect(readFileSync(join(root, '.biao', 'config.env'), 'utf8')).toContain('second-token');
  });

  it('已有配置可原地升级缺失的启动器和 PM 手册，且不改 Token/路径', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'preserve-token',
      skipInstall: true,
      skipBuild: true,
    });
    const configPath = join(root, '.biao', 'config.env');
    const before = readFileSync(configPath, 'utf8');
    rmSync(join(root, '.biao', 'codex-pm-agent'));
    rmSync(join(root, '.biao', 'copy-token'));
    rmSync(join(root, '.biao', 'token-status'));
    writeFileSync(join(root, '.biao', 'PM_AGENT.md'), 'stale guide\n');

    const result = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      upgrade: true,
      skipInstall: true,
      skipBuild: true,
    });

    expect(result.created).toBe(false);
    expect(result.upgraded).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(statSync(join(root, '.biao', 'codex-pm-agent')).mode & 0o111).not.toBe(0);
    expect(statSync(join(root, '.biao', 'copy-token')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, '.biao', 'token-status')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(root, '.biao', 'PM_AGENT.md'), 'utf8')).toContain('Worker 与 PM 通讯闭环');

    const configured = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      pmAgent: 'codex',
      upgrade: true,
      skipInstall: true,
      skipBuild: true,
    });
    expect(configured.upgraded).toBe(true);
    const after = readFileSync(configPath, 'utf8');
    expect(after.replace(/^BIAO_PM_AGENT_CMD=.*$/m, 'BIAO_PM_AGENT_CMD=<normalized>'))
      .toBe(before.replace(/^BIAO_PM_AGENT_CMD=.*$/m, 'BIAO_PM_AGENT_CMD=<normalized>'));
    const sourced = execFileSync('sh', ['-c', `. ${JSON.stringify(configPath)}; printf %s "$BIAO_PM_AGENT_CMD"`], { encoding: 'utf8' });
    expect(sourced).toBe(join(root, '.biao', 'codex-pm-agent'));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('可在一次 bootstrap 中配置共享 Supervisor 按需唤醒 PM Agent', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const command = `node '/tmp/pm agent.mjs' --mode unattended`;

    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      pmAgentCommand: command,
      skipInstall: true,
      skipBuild: true,
    });

    const configPath = join(root, '.biao', 'config.env');
    const sourced = execFileSync('sh', ['-c', `. ${JSON.stringify(configPath)}; printf %s "$BIAO_PM_AGENT_CMD"`], { encoding: 'utf8' });
    expect(sourced).toBe(command);
    const guide = readFileSync(join(root, '.biao', 'PM_AGENT.md'), 'utf8');
    expect(guide).toContain('同一个共享 Supervisor');
    expect(guide).toContain('不需要第二个 cron 或 launchd 轮询器');
    expect(guide).toContain('--require-drained');
  });

  it('用 --pm-agent codex 直接配置内置按需 PM 适配器，不要求手写命令', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace with spaces');
    mkdirSync(workspace);

    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      pmAgent: 'codex',
      skipInstall: true,
      skipBuild: true,
    });

    const configPath = join(root, '.biao', 'config.env');
    const sourced = execFileSync('sh', ['-c', `. ${JSON.stringify(configPath)}; printf %s "$BIAO_PM_AGENT_CMD"`], { encoding: 'utf8' });
    expect(sourced).toBe(join(root, '.biao', 'codex-pm-agent'));
    const guide = readFileSync(join(root, '.biao', 'PM_AGENT.md'), 'utf8');
    expect(guide).toContain('--pm-agent codex');
    expect(guide).toContain('.biao/codex-pm-agent');

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      pmAgent: 'codex',
      pmAgentCommand: 'custom-pm',
      force: true,
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/pmAgent.*pmAgentCommand|不能同时/);
  });

  it('全新 clone 同时安装根目录和 web 依赖后再构建', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedSourceCheckout(root);
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    rmSync(join(root, 'web', 'dist'), { recursive: true, force: true });
    const calls: Array<{ cwd: string; args: string[]; label: string }> = [];

    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      commandRunner: (cwd: string, args: string[], label: string) => {
        calls.push({ cwd, args, label });
        if (label === '项目构建') seedPrebuiltPackage(root);
      },
    });

    expect(calls).toEqual([
      { cwd: root, args: ['install', '--workspaces=false'], label: '根目录依赖安装' },
      { cwd: join(root, 'web'), args: ['install', '--workspaces=false'], label: 'Web 依赖安装' },
      { cwd: root, args: ['run', 'build', '--workspaces=false'], label: '项目构建' },
    ]);
  });

  it('全新 clone 跳过构建或构建未生成完整入口时 fail closed', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedSourceCheckout(root);
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    rmSync(join(root, 'web', 'dist'), { recursive: true, force: true });

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/运行时不完整|完成构建/);
    expect(existsSync(join(root, '.biao'))).toBe(false);

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      skipInstall: true,
      commandRunner: () => undefined,
    })).toThrow(/运行时不完整|完成构建/);
    expect(existsSync(join(root, '.biao'))).toBe(false);
  });

  it('npm tarball 的完整预构建运行时无需源码、Web manifest 或开发构建即可配置', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedPrebuiltPackage(root);
    const calls: Array<{ cwd: string; args: string[]; label: string }> = [];

    const result = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      commandRunner: (cwd: string, args: string[], label: string) => calls.push({ cwd, args, label }),
    });

    expect(result.runtimeLayout).toBe('prebuilt');
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, '.biao', 'start'), 'utf8')).toContain('dist/server/main.js');
  });

  it('非源码布局的预构建入口缺失时 fail closed，且不生成半成品配置', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedPrebuiltPackage(root);
    rmSync(join(root, 'web', 'dist', 'index.html'));

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
    })).toThrow(/安装内容不完整|预构建运行时/);
    expect(existsSync(join(root, '.biao'))).toBe(false);
  });

  it('预构建布局会校验 Worker/SQLite/安装入口以及 index.html 引用的网页资源', async () => {
    const { bootstrap } = await loadBootstrap();
    const workspaceName = 'workspace';

    for (const missingPath of [
      'bin/worker-help.js',
      'dist/db/schema.sql',
      'scripts/install.sh',
      'web/dist/assets/app.js',
      'web/dist/assets/logo.svg',
      'web/dist/manifest.json',
      'package.json',
    ]) {
      const root = makeRoot();
      const workspace = join(root, workspaceName);
      mkdirSync(workspace);
      rmSync(join(root, missingPath));

      expect(() => bootstrap({
        repoRoot: root,
        workspace,
        project: workspace,
        token: 'test-token',
      }), missingPath).toThrow(/安装内容不完整|运行时不完整/);
      expect(existsSync(join(root, '.biao'))).toBe(false);
    }
  });

  it('拒绝不存在的 workspace 和不在 workspace 内的 project', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'missing');

    expect(() => bootstrap({ repoRoot: root, workspace, project: workspace, skipInstall: true, skipBuild: true }))
      .toThrow(/workspace 不存在/);

    mkdirSync(workspace);
    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: join(root, 'outside'),
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/project 必须位于 workspace 内/);
  });
});
