import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadBootstrap() {
  return import('../scripts/bootstrap.mjs');
}

function makeRoot(): string {
  const root = makePrebuiltRoot();
  seedSourceCheckout(root);
  return root;
}

function makePrebuiltRoot(): string {
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

function makeInstalledPrebuilt(version: string): { consumer: string; packageRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'biao-installed-upgrade-'));
  tempRoots.push(root);
  const consumer = join(root, "consumer project with ' quote");
  const packageRoot = join(consumer, 'node_modules', '@vtp', `biao-${version}`);
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'bin', 'biao.js'),
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2),url:process.env.BIAO_URL,agent:process.env.BIAO_AGENT_ID}))\n`,
  );
  seedPrebuiltPackage(packageRoot);
  return { consumer, packageRoot };
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
    'bin/biao-adapter-kit.js',
    'bin/biao-worker-agent.js',
    'bin/biao-supervisor-config.js',
    'bin/cli-worker.js',
    'bin/codex-worker.js',
    'bin/kimi-worker.js',
    'bin/worker-help.js',
    'dist/db/schema.sql',
    'scripts/install.sh',
    'scripts/pm-agent.mjs',
    'scripts/codex-pm-agent.mjs',
    'scripts/adapter-kit.mjs',
    'scripts/worker-agent.mjs',
    'scripts/supervisor-config.mjs',
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
  const sqliteModule = join(root, 'node_modules', 'better-sqlite3');
  mkdirSync(sqliteModule, { recursive: true });
  writeFileSync(join(sqliteModule, 'package.json'), '{"main":"index.cjs"}\n');
  writeFileSync(
    join(sqliteModule, 'index.cjs'),
    'module.exports = class Database { prepare() { return { get() { return { ok: 1 }; } }; } close() {} };\n',
  );
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
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
    expect(packageJson.files).toContain('scripts/adapter-kit.mjs');
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
    expect(config).toContain(`BIAO_PREFERRED_PROJECT='${realpathSync(project)}'`);
    expect(config).toContain("BIAO_PM_AGENT_ROUTES=''");
    expect(config).toContain("BIAO_PM_AGENT_TIMEOUT_MS='600000'");
    expect(config).toContain("BIAO_PM_SLOTS=''");
    expect(config).toContain("BIAO_WORKER_SLOTS=''");
    expect(statSync(join(root, '.biao', 'config.env')).mode & 0o777).toBe(0o600);

    for (const name of ['doctor', 'start', 'copy-token', 'token-status', 'pm', 'pm-intake', 'pm-start', 'pm-agent', 'pm-heartbeat', 'codex-pm-agent', 'supervisor', 'agent-kit', 'worker-agent', 'supervisor-config', 'worker-codex', 'worker-kimi', 'worker-custom']) {
      expect(statSync(join(root, '.biao', name)).mode & 0o111).not.toBe(0);
    }
    const doctor = readFileSync(join(root, '.biao', 'doctor'), 'utf8');
    expect(doctor).toContain('Node.js 20.19+');
    expect(doctor).toContain('better-sqlite3');
    expect(doctor).toContain('SQLite 原生驱动');
    expect(doctor).toContain('scripts/redis-probe.mjs');
    expect(doctor).toContain('unset BIAO_API_TOKEN');
    expect(doctor).not.toContain('redis-cli -u');
    expect(readFileSync(join(root, '.biao', 'supervisor'), 'utf8')).toContain('scripts/supervisor.mjs');
    expect(readFileSync(join(root, '.biao', 'pm-start'), 'utf8')).toContain('pm start');
    expect(readFileSync(join(root, '.biao', 'pm-agent'), 'utf8')).toContain('scripts/pm-agent.mjs');
    const heartbeat = readFileSync(join(root, '.biao', 'pm-heartbeat'), 'utf8');
    expect(heartbeat).toContain('"$SCRIPT_DIR/pm" pm heartbeat --once');
    expect(heartbeat).not.toContain(root);
    const agentKit = readFileSync(join(root, '.biao', 'agent-kit'), 'utf8');
    expect(agentKit).toContain('scripts/adapter-kit.mjs');
    expect(agentKit).not.toContain('config.env');
    const workerAgent = readFileSync(join(root, '.biao', 'worker-agent'), 'utf8');
    expect(workerAgent).toContain('scripts/worker-agent.mjs');
    expect(workerAgent).toContain('BIAO_RUNTIME_DIR');
    expect(workerAgent).not.toContain('config.env');
    const supervisorConfig = readFileSync(join(root, '.biao', 'supervisor-config'), 'utf8');
    expect(supervisorConfig).toContain('scripts/supervisor-config.mjs');
    expect(supervisorConfig).toContain('SCRIPT_DIR/config.env');
    expect(supervisorConfig).not.toContain('. "$SCRIPT_DIR/config.env"');
    const codexPmAgent = readFileSync(join(root, '.biao', 'codex-pm-agent'), 'utf8');
    expect(codexPmAgent).toContain('scripts/codex-pm-agent.mjs');
    expect(codexPmAgent).toContain('BIAO_RUNTIME_DIR=$SCRIPT_DIR');
    expect(codexPmAgent).toContain('export BIAO_RUNTIME_DIR');
    const workerLaunchers = ['worker-codex', 'worker-kimi', 'worker-custom']
      .map((name) => readFileSync(join(root, '.biao', name), 'utf8'));
    expect(workerLaunchers[0]).toContain('BIAO_EXIT_ON_IDLE');
    expect(workerLaunchers[2]).toContain('bin/biao-worker.js');
    expect(workerLaunchers[2]).toContain('"--help"');
    for (const launcher of workerLaunchers) {
      expect(launcher).toContain('biao-worker-api-token-v1');
      expect(launcher).toContain('export BIAO_API_TOKEN');
    }

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
    expect(guide).toContain('HttpOnly');
    expect(guide).toContain('进入控制台');
    expect(guide).not.toContain('粘贴到网页右上角');
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

  it('bootstrap 完成提示给出本机 Owner 会话登录顺序，不让浏览器接触 Token', async () => {
    const { formatCompletion } = await loadBootstrap();
    const output = formatCompletion({ created: true, upgraded: false });

    expect(output).toContain('.biao/start');
    expect(output).toContain('进入控制台');
    expect(output).toContain('HttpOnly');
    expect(output).toContain('.biao/token-status');
    expect(output).not.toContain('.biao/copy-token');
    expect(output).not.toContain('粘贴 Token');
    expect(output).not.toContain('BIAO_API_TOKEN=');

    const external = formatCompletion({ created: true, upgraded: false, setupDir: '/srv/biao state' });
    expect(external).toContain('/srv/biao state/start');
    expect(external).toContain('/srv/biao state/token-status');
  });

  it('README 与 Worker 接入文档说明本机 Owner 会话与 Agent Token 的边界', () => {
    const root = join(import.meta.dirname, '..');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const workerGuide = readFileSync(join(root, 'docs', 'worker-integration.md'), 'utf8');
    for (const document of [readme, workerGuide]) {
      expect(document).toContain('HttpOnly');
      expect(document).toContain('BIAO_API_TOKEN');
      expect(document).toMatch(/浏览器.*(?:不会|不接收|不需要)/);
      expect(document).not.toContain('粘贴到网页右上角');
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
    const normalizePmConfig = (value: string) => value
      .replace(/^BIAO_PM_AGENT=.*$/m, 'BIAO_PM_AGENT=<normalized>')
      .replace(/^BIAO_PM_AGENT_CMD=.*$/m, 'BIAO_PM_AGENT_CMD=<normalized>');
    expect(normalizePmConfig(after)).toBe(normalizePmConfig(before));
    const sourced = execFileSync(
      'sh',
      ['-c', `. ${JSON.stringify(configPath)}; printf '%s|%s' "$BIAO_PM_AGENT" "$BIAO_PM_AGENT_CMD"`],
      { encoding: 'utf8' },
    );
    expect(sourced).toBe(`codex|${join(realpathSync(join(root, '.biao')), 'codex-pm-agent')}`);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it.each([
    '.biao-runtime',
    '.gitignore',
    'config.env',
    'PM_AGENT.md',
    'doctor',
    'copy-token',
    'token-status',
    'start',
    'pm',
    'pm-intake',
    'pm-start',
    'pm-agent',
    'pm-heartbeat',
    'codex-pm-agent',
    'supervisor',
    'agent-kit',
    'worker-agent',
    'worker-codex',
    'worker-kimi',
    'worker-custom',
  ])('upgrade 拒绝生成目标 %s 的符号链接，且不改链接外文件', async (targetName) => {
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

    const target = join(root, '.biao', targetName);
    const victim = join(root, `victim-${targetName.replaceAll('/', '-')}`);
    writeFileSync(victim, 'victim-must-not-change\n');
    rmSync(target);
    symlinkSync(victim, target);

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      upgrade: true,
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/生成目标.*(?:符号链接|普通文件)|符号链接.*生成目标/);
    expect(readFileSync(victim, 'utf8')).toBe('victim-must-not-change\n');
  });

  it('upgrade 拒绝非普通文件生成目标，并在替换普通文件时使用原子 rename', async () => {
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

    const doctor = join(root, '.biao', 'doctor');
    rmSync(doctor);
    mkdirSync(doctor);
    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      upgrade: true,
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/生成目标.*普通文件/);

    rmSync(doctor, { recursive: true });
    const start = join(root, '.biao', 'start');
    const victim = join(root, 'hardlink-victim');
    writeFileSync(victim, 'hardlink-victim-must-not-change\n');
    rmSync(start);
    linkSync(victim, start);
    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      upgrade: true,
      skipInstall: true,
      skipBuild: true,
    });

    expect(readFileSync(victim, 'utf8')).toBe('hardlink-victim-must-not-change\n');
    expect(readFileSync(start, 'utf8')).toContain('dist/server/main.js');
    expect(statSync(start).ino).not.toBe(statSync(victim).ino);
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
    expect(sourced).toBe(join(realpathSync(join(root, '.biao')), 'codex-pm-agent'));
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

  it('显式选择 Codex PM Agent 后 doctor 将 codex 视为必需依赖', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
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

    const fakeBin = makeControlledPath(root, 'Darwin');
    writeExecutable(join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(fakeBin, 'redis-cli'), '#!/bin/sh\nprintf "PONG\\n"\n');
    const run = spawnSync('/bin/sh', [join(root, '.biao', 'doctor')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });

    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('[missing] 必需 PM Agent: codex');
  });

  it('未选择 PM Agent 时 doctor 仍将 codex 视为可选依赖', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      skipInstall: true,
      skipBuild: true,
    });

    const fakeBin = makeControlledPath(root, 'Linux');
    writeExecutable(join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(fakeBin, 'redis-cli'), '#!/bin/sh\nprintf "PONG\\n"\n');
    const run = spawnSync('/bin/sh', [join(root, '.biao', 'doctor')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[optional] 未安装 codex');
  });

  it('doctor 在 SQLite 原生驱动缺失或 ABI 不兼容时失败并给出修复入口', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'test-token',
      skipInstall: true,
      skipBuild: true,
    });
    rmSync(join(root, 'node_modules', 'better-sqlite3'), { recursive: true, force: true });

    const fakeBin = makeControlledPath(root, 'Darwin');
    writeExecutable(join(fakeBin, 'npm'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(fakeBin, 'redis-cli'), '#!/bin/sh\nprintf "PONG\\n"\n');
    const run = spawnSync('/bin/sh', [join(root, '.biao', 'doctor')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin },
    });

    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('[missing] SQLite 原生驱动');
    expect(`${run.stdout}${run.stderr}`).toContain('npm rebuild better-sqlite3');
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
      { cwd: root, args: ['ci', '--workspaces=false'], label: '根目录依赖安装' },
      { cwd: join(root, 'web'), args: ['ci', '--workspaces=false'], label: 'Web 依赖安装' },
      { cwd: root, args: ['run', 'build', '--workspaces=false'], label: '项目构建' },
    ]);
  });

  it('源码布局缺少 lockfile 时兼容回退 npm install', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedSourceCheckout(root);
    rmSync(join(root, 'package-lock.json'));
    rmSync(join(root, 'web', 'package-lock.json'));
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
    const { consumer, packageRoot } = makeInstalledPrebuilt('v1');
    const workspace = join(consumer, 'workspace');
    mkdirSync(workspace);
    const calls: Array<{ cwd: string; args: string[]; label: string }> = [];

    const result = bootstrap({
      repoRoot: packageRoot,
      invocationCwd: consumer,
      workspace,
      project: workspace,
      token: 'test-token',
      commandRunner: (cwd: string, args: string[], label: string) => calls.push({ cwd, args, label }),
    });

    expect(result.runtimeLayout).toBe('prebuilt');
    expect(calls).toEqual([]);
    expect(result.setupDir).toBe(realpathSync(join(consumer, '.biao')));
    expect(existsSync(join(packageRoot, '.biao'))).toBe(false);
    expect(readFileSync(join(consumer, '.biao', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
    const start = readFileSync(join(consumer, '.biao', 'start'), 'utf8');
    expect(start).toContain(`BIAO_PACKAGE_ROOT=${shellSingleQuoted(packageRoot)}`);
    expect(start).toContain('dist/server/main.js');
    expect(start).toContain('scripts/supervisor.mjs');
    expect(start).toContain('BIAO_SUPERVISOR_INTERVAL');
    expect(start).toContain('BIAO_SUPERVISOR_RESTART_DELAY');
    expect(start.indexOf('wait "$supervisor_pid"')).toBeLessThan(start.indexOf('kill "$server_pid"'));
    expect(start).toContain('. "$SCRIPT_DIR/config.env"');
  });

  it('prebuilt 允许显式外置 runtime-dir，但拒绝 packageRoot 或任意 node_modules 内的可变目录', async () => {
    const { bootstrap, resolveBootstrapSetupDir } = await loadBootstrap();
    const { consumer, packageRoot } = makeInstalledPrebuilt('boundary');
    const workspace = join(consumer, 'workspace');
    const runtimeDir = join(consumer, "runtime state with ' quote");
    mkdirSync(workspace);

    const result = bootstrap({
      repoRoot: packageRoot,
      invocationCwd: consumer,
      runtimeDir,
      workspace,
      project: workspace,
      token: 'external-token',
    });
    expect(result.setupDir).toBe(realpathSync(runtimeDir));
    expect(readFileSync(join(runtimeDir, '.biao-runtime'), 'utf8')).toBe('biao-runtime-v1\n');
    expect(readFileSync(join(runtimeDir, 'config.env'), 'utf8')).toContain('external-token');
    const externalGuide = readFileSync(join(runtimeDir, 'PM_AGENT.md'), 'utf8');
    expect(externalGuide).toContain(`${shellSingleQuoted(realpathSync(runtimeDir))}/pm-start`);
    expect(externalGuide).not.toContain('.biao/pm-start');

    const linkedExternalRuntime = join(consumer, 'linked-external-runtime');
    const nodeModulesRuntimeLink = join(consumer, 'node_modules', 'runtime-state-link');
    mkdirSync(linkedExternalRuntime);
    symlinkSync(linkedExternalRuntime, nodeModulesRuntimeLink);

    for (const forbiddenRuntime of [
      join(packageRoot, '.biao'),
      join(consumer, 'node_modules', 'biao-runtime'),
      nodeModulesRuntimeLink,
    ]) {
      expect(() => bootstrap({
        repoRoot: packageRoot,
        invocationCwd: consumer,
        runtimeDir: forbiddenRuntime,
        workspace,
        project: workspace,
        token: 'must-not-write',
        force: true,
      }), forbiddenRuntime).toThrow(/runtime-dir.*node_modules|运行目录.*安装包/);
      expect(existsSync(join(forbiddenRuntime, 'config.env'))).toBe(false);
    }

    for (const broadRuntime of [parse(packageRoot).root, homedir()]) {
      expect(() => resolveBootstrapSetupDir({
        repoRoot: packageRoot,
        runtimeLayout: 'prebuilt',
        invocationCwd: consumer,
        runtimeDir: broadRuntime,
      }), broadRuntime).toThrow(/runtime-dir.*根目录|runtime-dir.*HOME|运行目录.*HOME/);
    }

    const operatorDirectory = join(consumer, 'existing-operator-directory');
    mkdirSync(operatorDirectory);
    writeFileSync(join(operatorDirectory, '.gitignore'), 'operator-rule\n');
    writeFileSync(join(operatorDirectory, 'operator-state.txt'), 'must-survive\n');
    expect(() => bootstrap({
      repoRoot: packageRoot,
      invocationCwd: consumer,
      runtimeDir: operatorDirectory,
      workspace,
      project: workspace,
      token: 'must-not-write',
    })).toThrow(/非空.*Biao runtime|专用.*runtime|已有目录/);
    expect(readFileSync(join(operatorDirectory, '.gitignore'), 'utf8')).toBe('operator-rule\n');
    expect(readFileSync(join(operatorDirectory, 'operator-state.txt'), 'utf8')).toBe('must-survive\n');
    expect(existsSync(join(operatorDirectory, 'config.env'))).toBe(false);
  });

  it('外置 runtime 的祖先含符号链接时固定到 canonical 目录写入', async () => {
    const { bootstrap } = await loadBootstrap();
    const { consumer, packageRoot } = makeInstalledPrebuilt('canonical-runtime');
    const realParent = join(consumer, 'real-parent');
    const linkedParent = join(consumer, 'linked-parent');
    const workspace = join(consumer, 'workspace');
    mkdirSync(realParent);
    mkdirSync(workspace);
    symlinkSync(realParent, linkedParent);
    const configuredRuntime = join(linkedParent, 'runtime');
    mkdirSync(configuredRuntime);

    const result = bootstrap({
      repoRoot: packageRoot,
      invocationCwd: consumer,
      runtimeDir: configuredRuntime,
      workspace,
      project: workspace,
      token: 'canonical-token',
    });

    const canonicalRuntime = realpathSync(join(realParent, 'runtime'));
    expect(result.setupDir).toBe(canonicalRuntime);
    expect(realpathSync(result.setupDir)).toBe(realpathSync(canonicalRuntime));
    expect(readFileSync(join(canonicalRuntime, 'config.env'), 'utf8')).toContain('canonical-token');
    expect(readFileSync(join(canonicalRuntime, 'PM_AGENT.md'), 'utf8')).toContain(shellSingleQuoted(canonicalRuntime));
  });

  it('prebuilt v1 到 v2 升级保留外置 config、Token、data 和 SQLite，并让启动器改指向 v2', async () => {
    const { bootstrap } = await loadBootstrap();
    const { consumer, packageRoot: v1Root } = makeInstalledPrebuilt('v1');
    const v2Root = join(consumer, 'node_modules', '@vtp', "biao-v2 with ' quote");
    const workspace = join(consumer, 'workspace');
    mkdirSync(workspace);

    const first = bootstrap({
      repoRoot: v1Root,
      invocationCwd: consumer,
      workspace,
      project: workspace,
      token: "stable-token-'-$HOME",
    });
    const runtimeDir = join(consumer, '.biao');
    expect(first.setupDir).toBe(realpathSync(runtimeDir));
    const configPath = join(runtimeDir, 'config.env');
    const configBefore = readFileSync(configPath, 'utf8');
    writeFileSync(join(runtimeDir, '.gitignore'), 'operator-runtime-rule\n');
    rmSync(join(runtimeDir, '.biao-runtime'));
    const tokenSentinel = join(runtimeDir, 'token.sentinel');
    const dataSentinel = join(runtimeDir, 'data', 'operator-state.txt');
    const sqlitePath = join(runtimeDir, 'data', 'biao.sqlite');
    writeFileSync(tokenSentinel, 'token-sentinel-v1\n', { mode: 0o600 });
    writeFileSync(dataSentinel, 'durable-data-v1\n', { mode: 0o600 });
    writeFileSync(sqlitePath, 'sqlite-sentinel-v1\u0000payload', { mode: 0o600 });

    mkdirSync(join(v2Root, 'bin'), { recursive: true });
    writeFileSync(
      join(v2Root, 'bin', 'biao.js'),
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({version:"v2",args:process.argv.slice(2)}))\n',
    );
    seedPrebuiltPackage(v2Root);

    const upgraded = bootstrap({
      repoRoot: v2Root,
      invocationCwd: consumer,
      workspace,
      project: workspace,
      upgrade: true,
    });

    expect(upgraded.upgraded).toBe(true);
    expect(upgraded.setupDir).toBe(realpathSync(runtimeDir));
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
    expect(readFileSync(join(runtimeDir, '.biao-runtime'), 'utf8')).toBe('biao-runtime-v1\n');
    expect(readFileSync(join(runtimeDir, '.gitignore'), 'utf8')).toBe('operator-runtime-rule\n');
    expect(readFileSync(tokenSentinel, 'utf8')).toBe('token-sentinel-v1\n');
    expect(readFileSync(dataSentinel, 'utf8')).toBe('durable-data-v1\n');
    expect(readFileSync(sqlitePath)).toEqual(Buffer.from('sqlite-sentinel-v1\u0000payload'));

    const pmLauncher = readFileSync(join(runtimeDir, 'pm'), 'utf8');
    expect(pmLauncher).toContain(`BIAO_PACKAGE_ROOT=${shellSingleQuoted(v2Root)}`);
    expect(pmLauncher).not.toContain(shellSingleQuoted(v1Root));
    const execution = JSON.parse(execFileSync(join(runtimeDir, 'pm'), ['status'], { encoding: 'utf8' }));
    expect(execution).toMatchObject({ version: 'v2', args: ['status'] });
  });

  it('源码 clone 即使从其它 cwd 调用仍默认复用 repoRoot/.biao', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const invocationCwd = mkdtempSync(join(tmpdir(), 'biao-source-caller-'));
    tempRoots.push(invocationCwd);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);

    const result = bootstrap({
      repoRoot: root,
      invocationCwd,
      workspace,
      project: workspace,
      token: 'source-token',
      skipInstall: true,
      skipBuild: true,
    });

    expect(result.runtimeLayout).toBe('source');
    expect(result.setupDir).toBe(realpathSync(join(root, '.biao')));
    expect(existsSync(join(invocationCwd, '.biao'))).toBe(false);
  });

  it('源码默认 repo/.biao 可兼容既有内容且不覆盖已有 .gitignore', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    const setupDir = join(root, '.biao');
    mkdirSync(workspace);
    mkdirSync(setupDir);
    writeFileSync(join(setupDir, '.gitignore'), 'operator-source-rule\n');
    writeFileSync(join(setupDir, 'operator-note.txt'), 'keep-me\n');

    const result = bootstrap({
      repoRoot: root,
      workspace,
      project: workspace,
      token: 'source-token',
      skipInstall: true,
      skipBuild: true,
    });

    expect(result.setupDir).toBe(realpathSync(setupDir));
    expect(readFileSync(join(setupDir, '.gitignore'), 'utf8')).toBe('operator-source-rule\n');
    expect(readFileSync(join(setupDir, 'operator-note.txt'), 'utf8')).toBe('keep-me\n');
    expect(readFileSync(join(setupDir, '.biao-runtime'), 'utf8')).toBe('biao-runtime-v1\n');
  });

  it('非源码布局的预构建入口缺失时 fail closed，且不生成半成品配置', async () => {
    const { bootstrap } = await loadBootstrap();
    const { consumer, packageRoot } = makeInstalledPrebuilt('incomplete');
    const workspace = join(consumer, 'workspace');
    mkdirSync(workspace);
    rmSync(join(packageRoot, 'web', 'dist', 'index.html'));

    expect(() => bootstrap({
      repoRoot: packageRoot,
      invocationCwd: consumer,
      workspace,
      project: workspace,
      token: 'test-token',
    })).toThrow(/安装内容不完整|预构建运行时/);
    expect(existsSync(join(consumer, '.biao'))).toBe(false);
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
      const { consumer, packageRoot } = makeInstalledPrebuilt(`missing-${missingPath.replaceAll('/', '-')}`);
      const workspace = join(consumer, workspaceName);
      mkdirSync(workspace);
      rmSync(join(packageRoot, missingPath));

      expect(() => bootstrap({
        repoRoot: packageRoot,
        invocationCwd: consumer,
        workspace,
        project: workspace,
        token: 'test-token',
      }), missingPath).toThrow(/安装内容不完整|运行时不完整/);
      expect(existsSync(join(consumer, '.biao'))).toBe(false);
    }
  });

  it('拒绝不存在的 workspace 和不在 workspace 内的 project', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'missing');

    expect(() => bootstrap({ repoRoot: root, workspace, project: workspace, skipInstall: true, skipBuild: true }))
      .toThrow(/workspace 不存在/);

    mkdirSync(workspace);
    mkdirSync(join(root, 'outside'));
    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: join(root, 'outside'),
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/project 必须位于 workspace 内/);
  });

  it('把 workspace 和 project 固定为 canonical 路径写入配置', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const realWorkspace = join(root, 'real-workspace');
    const linkedWorkspace = join(root, 'linked-workspace');
    const realProject = join(realWorkspace, 'project');
    mkdirSync(realProject, { recursive: true });
    symlinkSync(realWorkspace, linkedWorkspace);

    bootstrap({
      repoRoot: root,
      workspace: linkedWorkspace,
      project: join(linkedWorkspace, 'project'),
      token: 'test-token',
      skipInstall: true,
      skipBuild: true,
    });

    const config = readFileSync(join(root, '.biao', 'config.env'), 'utf8');
    expect(config).toContain(`BIAO_WORKSPACE_ROOTS=${shellSingleQuoted(realpathSync(realWorkspace))}`);
    expect(config).toContain(`BIAO_PREFERRED_PROJECT=${shellSingleQuoted(realpathSync(realProject))}`);
    expect(config).not.toContain(linkedWorkspace);
  });

  it('拒绝通过 project 最终符号链接逃出 canonical workspace', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const linkedProject = join(workspace, 'linked-project');
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, linkedProject);

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: linkedProject,
      token: 'must-not-write',
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/project 必须位于 workspace 内/);
    expect(existsSync(join(root, '.biao', 'config.env'))).toBe(false);
  });

  it('拒绝通过 project 祖先符号链接逃出 canonical workspace', async () => {
    const { bootstrap } = await loadBootstrap();
    const root = makeRoot();
    const workspace = join(root, 'workspace');
    const outsideParent = join(root, 'outside-parent');
    const outsideProject = join(outsideParent, 'project');
    const linkedParent = join(workspace, 'linked-parent');
    mkdirSync(workspace);
    mkdirSync(outsideProject, { recursive: true });
    symlinkSync(outsideParent, linkedParent);

    expect(() => bootstrap({
      repoRoot: root,
      workspace,
      project: join(linkedParent, 'project'),
      token: 'must-not-write',
      skipInstall: true,
      skipBuild: true,
    })).toThrow(/project 必须位于 workspace 内/);
    expect(existsSync(join(root, '.biao', 'config.env'))).toBe(false);
  });
});
