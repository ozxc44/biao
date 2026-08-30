#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ensureAgentProtocolBlock } from './agent-protocol.mjs';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function assertDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} 不存在或不是目录：${path}`);
  }
}

function canonicalDirectory(path, label) {
  let canonical;
  try {
    canonical = realpathSync(path);
    if (!lstatSync(canonical).isDirectory()) throw new Error('not-directory');
  } catch {
    throw new Error(`${label} 不存在或不是目录：${path}`);
  }
  return canonical;
}

function isInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertRegularGeneratedTarget(path) {
  const metadata = lstatIfExists(path);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Biao 生成目标必须是普通文件且不能是符号链接：${path}`);
  }
}

function readGeneratedFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Biao 生成目标必须是普通文件且不能是符号链接：${path}`);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`Biao 生成目标必须是普通文件且不能是符号链接：${path}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicWriteGeneratedFile(path, content, mode) {
  assertRegularGeneratedTarget(path);
  const parent = dirname(path);
  const prefix = `.${basename(path)}.tmp-${process.pid}-`;
  let temporaryPath;
  let fd;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      temporaryPath = join(parent, `${prefix}${randomBytes(8).toString('hex')}`);
      try {
        fd = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode,
        );
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        temporaryPath = undefined;
      }
    }
    if (fd === undefined || temporaryPath === undefined) {
      throw new Error(`无法为 Biao 生成目标创建安全临时文件：${path}`);
    }
    writeFileSync(fd, content, 'utf8');
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // 同目录 rename 不会跟随目标符号链接；即使校验后发生竞态，也只替换链接本身。
    renameSync(temporaryPath, path);
    temporaryPath = undefined;
    // 文件内容落盘后还需同步父目录项；否则断电可能丢失刚完成的 rename，留下旧配置。
    const parentFd = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

function writeExecutable(path, content) {
  atomicWriteGeneratedFile(path, content, 0o755);
}

function wrapper(body, packageRoot) {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIAO_PACKAGE_ROOT=${shellQuote(resolve(packageRoot))}
readonly BIAO_PACKAGE_ROOT
set -a
. "$SCRIPT_DIR/config.env"
set +a
BIAO_RUNTIME_DIR=$SCRIPT_DIR
export BIAO_RUNTIME_DIR
readonly BIAO_RUNTIME_DIR
${body}
`;
}

function credentialFreeWrapper(body, packageRoot) {
  return `#!/usr/bin/env sh
set -eu
BIAO_PACKAGE_ROOT=${shellQuote(resolve(packageRoot))}
readonly BIAO_PACKAGE_ROOT
${body}
`;
}

// runtime-dir 可能尚不存在。先 realpath 最深的已存在祖先，再拼回缺失段，
// 这样既支持首次安装，也不会让符号链接绕过 node_modules/packageRoot 边界。
function canonicalPotentialPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : cursor;
  return resolve(base, ...missing);
}

function hasNodeModulesSegment(path) {
  return resolve(path)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === 'node_modules');
}

function pathContainsNodeModules(path) {
  return hasNodeModulesSegment(path) || hasNodeModulesSegment(canonicalPotentialPath(path));
}

const BIAO_RUNTIME_MARKER = '.biao-runtime';
const BIAO_RUNTIME_MARKER_CONTENT = 'biao-runtime-v1\n';
const BIAO_RUNTIME_GITIGNORE = '*\n!.gitignore\n';
const BIAO_GENERATED_FILES = [
  BIAO_RUNTIME_MARKER,
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
  'supervisor-config',
  'worker-codex',
  'worker-kimi',
  'worker-custom',
];

function validateGeneratedTargets(setupDir) {
  for (const name of BIAO_GENERATED_FILES) {
    assertRegularGeneratedTarget(join(setupDir, name));
  }
}

function isPlainFile(path) {
  const metadata = lstatIfExists(path);
  if (!metadata) return false;
  return metadata.isFile() && !metadata.isSymbolicLink();
}

function hasValidRuntimeMarker(setupDir) {
  const markerPath = join(setupDir, BIAO_RUNTIME_MARKER);
  if (!lstatIfExists(markerPath)) return false;
  assertRegularGeneratedTarget(markerPath);
  if (readGeneratedFile(markerPath) !== BIAO_RUNTIME_MARKER_CONTENT) {
    throw new Error(`已有目录包含无效的 Biao runtime 标记：${markerPath}`);
  }
  return true;
}

function validateExistingRuntimeDirectory(setupDir, allowSourceDefault) {
  const metadata = lstatIfExists(setupDir);
  if (!metadata) return;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`--runtime-dir 必须是真实目录且不能是符号链接：${setupDir}`);
  }
  const entries = readdirSync(setupDir);
  if (entries.length === 0) return;

  const markedRuntime = hasValidRuntimeMarker(setupDir);
  const legacyRuntime = isPlainFile(join(setupDir, 'config.env'));
  if (!allowSourceDefault && !markedRuntime && !legacyRuntime) {
    throw new Error(`已有目录非空且不是专用 Biao runtime，拒绝写入：${setupDir}`);
  }
}

function prepareRuntimeDirectory(setupDir) {
  const existingMetadata = lstatIfExists(setupDir);
  const existed = existingMetadata !== undefined;
  if (existingMetadata && (existingMetadata.isSymbolicLink() || !existingMetadata.isDirectory())) {
    throw new Error(`--runtime-dir 必须是真实目录且不能是符号链接：${setupDir}`);
  }
  const wasEmpty = existed && readdirSync(setupDir).length === 0;
  if (!existed) mkdirSync(setupDir, { recursive: true });
  validateGeneratedTargets(setupDir);

  const markerPath = join(setupDir, BIAO_RUNTIME_MARKER);
  if (lstatIfExists(markerPath)) {
    hasValidRuntimeMarker(setupDir);
  } else {
    atomicWriteGeneratedFile(markerPath, BIAO_RUNTIME_MARKER_CONTENT, 0o600);
  }

  // 只在第一次初始化一个新目录（或调用方预建的空目录）时放入默认保护规则。
  // 已有 runtime 的 .gitignore 属于操作者配置，bootstrap 永不覆盖。
  const gitignorePath = join(setupDir, '.gitignore');
  if ((!existed || wasEmpty) && !lstatIfExists(gitignorePath)) {
    atomicWriteGeneratedFile(gitignorePath, BIAO_RUNTIME_GITIGNORE, 0o644);
  }
}

export function resolveBootstrapSetupDir(options) {
  const repoRoot = resolve(options.repoRoot);
  const invocationCwd = resolve(options.invocationCwd ?? process.cwd());
  const setupDir = options.runtimeDir
    ? resolve(invocationCwd, options.runtimeDir)
    : options.runtimeLayout === 'source'
      ? join(repoRoot, '.biao')
      : join(invocationCwd, '.biao');

  const canonicalPackageRoot = canonicalPotentialPath(repoRoot);
  const canonicalSetupDir = canonicalPotentialPath(setupDir);
  const canonicalHome = canonicalPotentialPath(homedir());
  const sourceDefault =
    options.runtimeLayout === 'source' && resolve(setupDir) === resolve(repoRoot, '.biao');
  const safeSourceDefault =
    sourceDefault && canonicalSetupDir === join(canonicalPackageRoot, '.biao');

  if (dirname(canonicalSetupDir) === canonicalSetupDir) {
    throw new Error(`--runtime-dir 不能是文件系统根目录：${setupDir}`);
  }
  if (canonicalSetupDir === canonicalHome) {
    throw new Error(`--runtime-dir 不能是 HOME 目录：${setupDir}`);
  }
  if (pathContainsNodeModules(setupDir)) {
    throw new Error(`--runtime-dir 运行目录不能位于 node_modules 内：${setupDir}`);
  }
  if (isInside(canonicalPackageRoot, canonicalSetupDir) && !safeSourceDefault) {
    throw new Error(`--runtime-dir 运行目录不能位于安装包或源码仓库内：${setupDir}`);
  }
  // 后续所有校验、open/rename 和返回路径都固定到同一 canonical 目录，避免祖先
  // symlink 在校验后改指而把生成文件写到另一个位置。
  validateExistingRuntimeDirectory(canonicalSetupDir, safeSourceDefault);
  return canonicalSetupDir;
}

/**
 * 只在当前 shell 中读取本机凭据。与普通 CLI wrapper 不同，这里先 unset，
 * 避免调用剪贴板工具或 Node 指纹进程时把 API Token 作为环境变量继续传递。
 */
function credentialWrapper(body) {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
unset BIAO_API_TOKEN
. "$SCRIPT_DIR/config.env"
${body}
`;
}

export function sanitizedBootstrapChildEnvironment(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.BIAO_BOOTSTRAP_TOKEN;
  delete childEnv.BIAO_API_TOKEN;
  return childEnv;
}

function runNpm(cwd, args, label) {
  const result = spawnSync('npm', args, {
    cwd,
    stdio: 'inherit',
    env: sanitizedBootstrapChildEnvironment(process.env),
  });
  if (result.error) throw new Error(`${label}失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label}失败，退出码 ${result.status}`);
}

const SOURCE_BUILD_INPUTS = [
  ['package.json', 'file'],
  ['tsconfig.json', 'file'],
  ['src', 'directory'],
  ['web/package.json', 'file'],
];

function npmDependencyInstallArgs(cwd) {
  const hasLockfile = existsSync(join(cwd, 'package-lock.json')) || existsSync(join(cwd, 'npm-shrinkwrap.json'));
  return [hasLockfile ? 'ci' : 'install', '--workspaces=false'];
}

// npm 安装包不携带 TypeScript / Web 源码；bootstrap 只能在所有生产入口都在时
// 采用预构建模式，不能因某一个 dist 文件碰巧存在就生成无法启动的 .biao。
export const PREBUILT_RUNTIME_INPUTS = [
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
  'bin/biao.js',
  'bin/biao-adapter-kit.js',
  'bin/biao-worker-agent.js',
  'bin/biao-supervisor-config.js',
  'bin/biao-worker.js',
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
];

export function referencedWebRuntimeInputs(repoRoot) {
  const root = resolve(repoRoot);
  const webRoot = join(root, 'web', 'dist');
  const indexPath = join(webRoot, 'index.html');
  if (!existsSync(indexPath)) return [];

  const html = readFileSync(indexPath, 'utf8');
  const inputs = new Set();
  const addWebInput = (raw) => {
    if (!raw || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) return;
    const withoutQuery = raw.split(/[?#]/, 1)[0];
    if (!withoutQuery) return;
    const candidate = withoutQuery.startsWith('/')
      ? resolve(webRoot, `.${withoutQuery}`)
      : resolve(dirname(indexPath), withoutQuery);
    if (!isInside(webRoot, candidate)) {
      throw new Error(`网页入口引用越过 web/dist：${raw}`);
    }
    inputs.add(relative(root, candidate).split(sep).join('/'));
  };
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    addWebInput(match[1]);
  }

  const manifestPath = join(webRoot, 'manifest.json');
  if (existsSync(manifestPath)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error('web/dist/manifest.json 无法解析');
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('web/dist/manifest.json 格式无效');
    }
    for (const entry of Object.values(manifest)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry;
      if (typeof record.file === 'string') addWebInput(record.file);
      for (const field of ['css', 'assets']) {
        if (!Array.isArray(record[field])) continue;
        for (const path of record[field]) {
          if (typeof path === 'string') addWebInput(path);
        }
      }
    }
  }
  return [...inputs];
}

function pathHasKind(root, relativePath, kind) {
  const path = join(root, relativePath);
  if (!existsSync(path)) return false;
  const metadata = statSync(path);
  return kind === 'directory' ? metadata.isDirectory() : metadata.isFile();
}

export function detectBootstrapRuntimeLayout(repoRoot) {
  const root = resolve(repoRoot);
  if (SOURCE_BUILD_INPUTS.every(([path, kind]) => pathHasKind(root, path, kind))) return 'source';
  if (PREBUILT_RUNTIME_INPUTS.every((path) => pathHasKind(root, path, 'file'))) return 'prebuilt';
  return 'incomplete';
}

export function missingPrebuiltRuntimeInputs(repoRoot) {
  const root = resolve(repoRoot);
  const required = [...PREBUILT_RUNTIME_INPUTS, ...referencedWebRuntimeInputs(root)];
  return [...new Set(required)].filter((path) => !pathHasKind(root, path, 'file'));
}

function assertCompleteRuntime(repoRoot, context) {
  const missing = missingPrebuiltRuntimeInputs(repoRoot);
  if (missing.length > 0) {
    throw new Error(`${context}后运行时不完整，缺少：${missing.join('、')}。请完成构建或重新安装发布包`);
  }
}

function validateBootstrapToken(raw, source) {
  const token = source === 'Token 文件'
    ? raw.replace(/(?:\r\n|\n)$/, '')
    : raw;
  if (!token) throw new Error(`${source}不能为空`);
  if (/[\0\r\n]/.test(token)) throw new Error(`${source}必须只包含单行 Token`);
  if (/\s/.test(token)) throw new Error(`${source}不能包含空白字符`);
  return token;
}

/**
 * CLI 只从 owner-only 文件或专用环境变量读取已有 Token，避免把凭据放入 argv。
 * bootstrap(options.token) 仍作为进程内 API 供受控调用和测试使用。
 */
export function resolveBootstrapToken(args = {}, env = process.env) {
  const tokenFile = args.token_file;
  const environmentToken = env.BIAO_BOOTSTRAP_TOKEN;
  if (tokenFile && environmentToken !== undefined) {
    throw new Error('--token-file 与 BIAO_BOOTSTRAP_TOKEN 不能同时使用');
  }
  if (environmentToken !== undefined) {
    return validateBootstrapToken(environmentToken, 'BIAO_BOOTSTRAP_TOKEN');
  }
  if (!tokenFile) return undefined;

  const path = resolve(tokenFile);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new Error('Token 文件必须是普通文件');
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('Token 文件权限必须是 owner-only（例如 600）');
    }
    if (metadata.size > 4096) throw new Error('Token 文件过大');
    return validateBootstrapToken(readFileSync(fd, 'utf8'), 'Token 文件');
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Token 文件不能是符号链接');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function bootstrap(options) {
  const repoRoot = resolve(options.repoRoot);
  const requestedWorkspace = resolve(options.workspace);
  const requestedProject = resolve(options.project ?? requestedWorkspace);

  assertDirectory(repoRoot, 'repoRoot');
  // 固定祖先与最终符号链接解析后的真实目录。containment 和后续配置始终使用
  // 同一组 canonical 路径，避免词法上位于 workspace 内的 project 实际逃逸。
  const workspace = canonicalDirectory(requestedWorkspace, 'workspace');
  const project = canonicalDirectory(requestedProject, 'project');
  if (!isInside(workspace, project)) {
    throw new Error(`project 必须位于 workspace 内：${project}`);
  }
  const runtimeLayout = detectBootstrapRuntimeLayout(repoRoot);
  if (runtimeLayout === 'incomplete') {
    throw new Error('安装内容不完整：既不是可构建的 Git 源码，也不是完整的预构建运行时；请重新 clone 或重新安装发布包');
  }
  const setupDir = resolveBootstrapSetupDir({
    repoRoot,
    runtimeLayout,
    invocationCwd: options.invocationCwd,
    runtimeDir: options.runtimeDir,
  });
  const configPath = join(setupDir, 'config.env');
  // 在 npm install/build 或任何写入之前一次性检查全部受 bootstrap 管理的目标。
  // 这样 upgrade 不会因较晚遇到链接而留下半升级状态。
  validateGeneratedTargets(setupDir);

  if (options.pmAgent && options.pmAgentCommand) {
    throw new Error('pmAgent 与 pmAgentCommand 不能同时配置');
  }
  if (options.pmAgent && options.pmAgent !== 'codex') {
    throw new Error(`pmAgent 目前只支持 codex：${options.pmAgent}`);
  }
  const pmAgentCommand = options.pmAgent === 'codex'
    ? join(setupDir, 'codex-pm-agent')
    : (options.pmAgentCommand ?? '');

  const configExists = lstatIfExists(configPath) !== undefined;
  const upgrading = configExists && !options.force && options.upgrade === true;
  if (configExists && !options.force && !upgrading) {
    assertCompleteRuntime(repoRoot, '检查已有配置');
    prepareRuntimeDirectory(setupDir);
    // 已有安装也补一次协议块（幂等）：升级路径与全新安装拿到同样的零配置 harness 接入。
    injectAgentProtocolBlocks([workspace]);
    return { created: false, setupDir, configPath, runtimeLayout };
  }

  const runCommand = options.commandRunner ?? runNpm;
  if (runtimeLayout === 'source' && !options.skipInstall) {
    runCommand(repoRoot, npmDependencyInstallArgs(repoRoot), '根目录依赖安装');
    runCommand(join(repoRoot, 'web'), npmDependencyInstallArgs(join(repoRoot, 'web')), 'Web 依赖安装');
  }
  if (runtimeLayout === 'source' && !options.skipBuild) runCommand(repoRoot, ['run', 'build', '--workspaces=false'], '项目构建');
  assertCompleteRuntime(repoRoot, runtimeLayout === 'source' ? '源码准备' : '预构建包校验');

  const port = Number(options.port ?? 7331);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口无效：${options.port}`);
  const host = options.host ?? '127.0.0.1';
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const token = options.token ?? randomBytes(24).toString('hex');
  const dataDir = join(setupDir, 'data');
  const dataMetadata = lstatIfExists(dataDir);
  if (dataMetadata && (dataMetadata.isSymbolicLink() || !dataMetadata.isDirectory())) {
    throw new Error(`Biao data 目标必须是真实目录且不能是符号链接：${dataDir}`);
  }
  prepareRuntimeDirectory(setupDir);
  if (!dataMetadata) mkdirSync(dataDir, { mode: 0o700 });

  const config = [
    '# 由 Biao bootstrap 生成。包含访问凭据，不要提交到 Git。',
    `BIAO_HOST=${shellQuote(host)}`,
    `BIAO_PORT=${shellQuote(port)}`,
    `BIAO_URL=${shellQuote(`http://${urlHost}:${port}`)}`,
    `BIAO_REDIS_URL=${shellQuote(options.redisUrl ?? 'redis://127.0.0.1:6379')}`,
    `BIAO_DATA_DIR=${shellQuote(dataDir)}`,
    `BIAO_WORKSPACE_ROOTS=${shellQuote(workspace)}`,
    `BIAO_PREFERRED_PROJECT=${shellQuote(project)}`,
    `BIAO_API_TOKEN=${shellQuote(token)}`,
    `BIAO_PM_AGENT=${shellQuote(options.pmAgent ?? '')}`,
    `BIAO_PM_AGENT_CMD=${shellQuote(pmAgentCommand)}`,
    `BIAO_PM_AGENT_TIMEOUT_MS=${shellQuote('600000')}`,
    `BIAO_PM_AGENT_ROUTES=${shellQuote('')}`,
    `BIAO_PM_SLOTS=${shellQuote('')}`,
    `BIAO_WORKER_SLOTS=${shellQuote('')}`,
    '# 配置了 worker slot 后由 supervisor-config 自动置 1：pm-watch 留守时保留',
    '# slots，本机常驻链同时守 PM 门铃并主动领取/执行任务。',
    `BIAO_PM_WATCH_KEEP_WORKER_SLOTS=${shellQuote('0')}`,
    '# 完成事件自愈：设为 1 后，task 上报 / pm ack / question answer 成功时会',
    '# 自动确保 .biao/pm-watch 留守监视器在本机运行（低频轮询；slots 按 KEEP 开关保留）。',
    `BIAO_SUPERVISOR_AUTO_ENSURE=${shellQuote('0')}`,
    '',
  ].join('\n');

  if (!upgrading) {
    atomicWriteGeneratedFile(configPath, config, 0o600);
  } else if (options.pmAgent || options.pmAgentCommand) {
    const previous = readGeneratedFile(configPath);
    const replacements = [
      ['BIAO_PM_AGENT', options.pmAgent ?? ''],
      ['BIAO_PM_AGENT_CMD', pmAgentCommand],
    ];
    let next = previous;
    for (const [name, value] of replacements) {
      const line = `${name}=${shellQuote(value)}`;
      const pattern = new RegExp(`^${name}=.*$`, 'm');
      next = pattern.test(next)
        ? next.replace(pattern, line)
        : `${next.replace(/\n?$/, '\n')}${line}\n`;
    }
    atomicWriteGeneratedFile(configPath, next, 0o600);
  }

  const runtimeWrapper = (body) => wrapper(body, repoRoot);
  // The runtime config keeps the Owner token for PM/Supervisor compatibility.
  // Worker launchers immediately replace it with a one-way scoped bearer before
  // starting any Worker process; the Owner token never crosses the exec boundary.
  const workerRuntimeWrapper = (body) => runtimeWrapper(`if [ -n "\${BIAO_API_TOKEN:-}" ]; then
  BIAO_API_TOKEN=$(printf '%s' "$BIAO_API_TOKEN" | node -e 'const { createHmac } = require("node:crypto"); const chunks = []; process.stdin.on("data", chunk => chunks.push(chunk)); process.stdin.on("end", () => process.stdout.write(createHmac("sha256", Buffer.concat(chunks)).update("biao-worker-api-token-v1").digest("hex")));')
  export BIAO_API_TOKEN
fi
${body}`);

  writeExecutable(
    join(setupDir, 'doctor'),
    runtimeWrapper(`redis_probe_url=$BIAO_REDIS_URL
unset BIAO_API_TOKEN BIAO_BOOTSTRAP_TOKEN BIAO_REDIS_URL
failed=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(((a>=22&&a<=26)&&(a>22||b>=12))||(a===20&&b>=19)?0:1)'; then
  echo "[ok] Node.js 20.19+ / 22.12-26.x: $(node --version)"
  echo "[ok] npm: $(command -v npm)"
else
  echo "[missing] Node.js 20.19+ / 22.12-26.x 和 npm" >&2
  failed=1
fi
if command -v node >/dev/null 2>&1; then
  if node -e 'const {createRequire}=require("node:module"); const req=createRequire(process.argv[1]); const Database=req("better-sqlite3"); const db=new Database(":memory:"); db.prepare("SELECT 1 AS ok").get(); db.close();' "$BIAO_PACKAGE_ROOT/package.json" >/dev/null 2>&1; then
    echo "[ok] SQLite 原生驱动可加载"
  else
    echo "[missing] SQLite 原生驱动无法加载；请确保安装和运行使用同一 Node 版本，并在 Biao 安装目录执行 npm rebuild better-sqlite3。若 npm 提示 allow-scripts，先执行 npm approve-scripts better-sqlite3。" >&2
    failed=1
  fi
fi
if command -v redis-cli >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  if BIAO_REDIS_PROBE_URL=$redis_probe_url node "$BIAO_PACKAGE_ROOT/scripts/redis-probe.mjs" >/dev/null 2>&1; then
    echo "[ok] Redis 可连接"
  else
    echo "[missing] Redis 不可连接；请检查 .biao/config.env 中的 BIAO_REDIS_URL" >&2
    failed=1
  fi
else
  echo "[missing] redis-cli（无法检查 Redis）" >&2
  failed=1
fi
required_pm_agent=\${BIAO_PM_AGENT:-}
for optional_name in codex kimi; do
  if command -v "$optional_name" >/dev/null 2>&1; then
    if [ "$required_pm_agent" = "$optional_name" ]; then
      echo "[ok] 必需 PM Agent: $optional_name"
    else
      echo "[ok] 可选 Agent: $optional_name"
    fi
  elif [ "$required_pm_agent" = "$optional_name" ]; then
    echo "[missing] 必需 PM Agent: $optional_name" >&2
    failed=1
  else
    echo "[optional] 未安装 $optional_name"
  fi
done
if ! printf '%s' "$BIAO_WORKSPACE_ROOTS" | node -e '
const { readFileSync, realpathSync, statSync } = require("node:fs");
const { delimiter, resolve } = require("node:path");
const roots = readFileSync(0, "utf8").split(delimiter).map((root) => root.trim()).filter(Boolean);
let missing = roots.length === 0;
if (missing) console.error("[missing] workspace roots 未配置");
for (const root of roots) {
  const normalized = resolve(root);
  try {
    const canonical = realpathSync(normalized);
    if (!statSync(canonical).isDirectory()) throw new Error("not-directory");
    console.log("[ok] workspace: " + canonical);
  } catch {
    console.error("[missing] workspace 不存在：" + normalized);
    missing = true;
  }
}
process.exitCode = missing ? 1 : 0;
'; then
  failed=1
fi
exit "$failed"`),
  );
  writeExecutable(
    join(setupDir, 'copy-token'),
    credentialWrapper(`if [ -z "\${BIAO_API_TOKEN:-}" ]; then
  echo "[biao] API Token 未配置；请先检查本机 .biao/config.env。" >&2
  exit 2
fi

os_name=$(uname -s 2>/dev/null || printf '%s' unknown)
case "$os_name" in
  Darwin)
    if ! command -v pbcopy >/dev/null 2>&1; then
      echo "[biao] 未找到 macOS pbcopy。请确认系统剪贴板工具可用；不要打印 Token 到终端、URL 或 Shell 历史。" >&2
      exit 2
    fi
    printf '%s' "$BIAO_API_TOKEN" | pbcopy
    ;;
  Linux)
    if command -v wl-copy >/dev/null 2>&1; then
      printf '%s' "$BIAO_API_TOKEN" | wl-copy
    elif command -v xclip >/dev/null 2>&1; then
      printf '%s' "$BIAO_API_TOKEN" | xclip -selection clipboard
    elif command -v xsel >/dev/null 2>&1; then
      printf '%s' "$BIAO_API_TOKEN" | xsel --clipboard --input
    else
      echo "[biao] 未找到剪贴板工具。请安装 wl-copy、xclip 或 xsel 后重试；不要打印到终端、URL 或 Shell 历史。" >&2
      exit 2
    fi
    ;;
  *)
    echo "[biao] 当前系统没有受支持的安全剪贴板入口。请在本机安全编辑器中打开 .biao/config.env；不要打印到终端、URL 或 Shell 历史。" >&2
    exit 2
    ;;
esac

echo "[biao] API Token 已复制到系统剪贴板；仅用于受控 Agent/CLI 调试，不用于网页登录。"`),
  );
  writeExecutable(
    join(setupDir, 'token-status'),
    credentialWrapper(`if [ -z "\${BIAO_API_TOKEN:-}" ]; then
  echo "[biao] API Token 未配置。"
  exit 2
fi

fingerprint_suffix=$(printf '%s' "$BIAO_API_TOKEN" | node -e 'const { createHash } = require("node:crypto"); const chunks = []; process.stdin.on("data", chunk => chunks.push(chunk)); process.stdin.on("end", () => process.stdout.write(createHash("sha256").update(Buffer.concat(chunks)).digest("hex").slice(-12)));')
printf '[biao] API Token 已配置（SHA-256 指纹末尾：…%s）。\n' "$fingerprint_suffix"`),
  );
  writeExecutable(join(setupDir, 'start'), runtimeWrapper(`server_pid=''
supervisor_pid=''
shutdown_requested=0
shutdown() {
  shutdown_requested=1
  # 先让 Supervisor 回收 PM/Worker 子进程树，再停止 API 服务。两者同时 TERM 会让
  # pm-agent 失去清理窗口，旧 adapter 可能短暂成为孤儿并与重启后的 PM 重复处理。
  if [ -n "$supervisor_pid" ]; then
    kill "$supervisor_pid" 2>/dev/null || true
    wait "$supervisor_pid" 2>/dev/null || true
    supervisor_pid=''
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=''
  fi
  exit 0
}
trap shutdown INT TERM

# 本机运行日志：server.log 与 supervisor.log 默认在 .biao/logs 下；单个文件超过
# BIAO_LOG_MAX_BYTES（默认 5MB）时在启动时轮转一份 .1。路径可用 BIAO_LOG_DIR 覆盖。
log_dir="\${BIAO_LOG_DIR:-\$SCRIPT_DIR/logs}"
mkdir -p "$log_dir"
rotate_log() {
  if [ -f "$1" ] && [ "\$(wc -c < "$1")" -gt "\${BIAO_LOG_MAX_BYTES:-5242880}" ]; then
    mv -f "$1" "$1.1"
  fi
}
rotate_log "$log_dir/server.log"
rotate_log "$log_dir/supervisor.log"
echo "[biao] 日志目录：\${log_dir}（server.log / supervisor.log）"

# 服务与共享 Supervisor 由同一个启动器托管：不再出现“服务健康、但没有任何单元
# 负责发现门铃、恢复等待任务或启动已配置 Worker slot”的孤岛状态。Supervisor 在
# 全部计划暂时闭环时会自行退出；这里低频重启它，以便随后新增任务仍可被发现。
# config.env 设 BIAO_SUPERVISOR_STAY_RESIDENT=1 时 Supervisor 闭环不退出、留守复查，
# 下面的正常退出分支不再触发，本循环只承担异常退出的短退避重启。
# 如果 Supervisor 异常退出，则使用独立的短退避立即重启；Worker 完成后的下一项
# 调度仍由未退出的同一 Supervisor 直接处理，不能因为一次 Worker 退出而丢失监视。
while [ "$shutdown_requested" -eq 0 ]; do
  node "$BIAO_PACKAGE_ROOT/dist/server/main.js" >> "$log_dir/server.log" 2>&1 &
  server_pid=$!
  server_exit=0

  while kill -0 "$server_pid" 2>/dev/null; do
    # slot 配置由 supervisor-config 原子更新 config.env。每次拉起新的 Supervisor
    # 子进程都在隔离 shell 中重新读取它，避免父进程保留旧 Worker/PM slot。
    (
      set -a
      . "$SCRIPT_DIR/config.env"
      set +a
      exec node "$BIAO_PACKAGE_ROOT/scripts/supervisor.mjs"
    ) >> "$log_dir/supervisor.log" 2>&1 &
    supervisor_pid=$!

    while kill -0 "$server_pid" 2>/dev/null && kill -0 "$supervisor_pid" 2>/dev/null; do
      sleep "\${BIAO_SERVER_WATCH_INTERVAL:-1}"
    done

    if ! kill -0 "$server_pid" 2>/dev/null; then
      kill "$supervisor_pid" 2>/dev/null || true
      wait "$supervisor_pid" 2>/dev/null || true
      supervisor_pid=''
      break
    fi

    supervisor_exit=0
    wait "$supervisor_pid" || supervisor_exit=$?
    supervisor_pid=''
    if [ "$supervisor_exit" -eq 0 ]; then
      sleep "\${BIAO_SUPERVISOR_INTERVAL:-60}"
    else
      echo "[biao] Supervisor 异常退出（exit=\${supervisor_exit}）；\${BIAO_SUPERVISOR_RESTART_DELAY:-5}s 后自动重启。" >&2
      sleep "\${BIAO_SUPERVISOR_RESTART_DELAY:-5}"
    fi
  done

  wait "$server_pid" || server_exit=$?
  server_pid=''
  [ "$shutdown_requested" -eq 0 ] || break
  echo "[biao] Server 异常退出（exit=\${server_exit}）；\${BIAO_SERVER_RESTART_DELAY:-5}s 后自动重启，并重新建立唯一 Supervisor。" >&2
  sleep "\${BIAO_SERVER_RESTART_DELAY:-5}"
done

exit 0`));
  writeExecutable(
    join(setupDir, 'pm'),
    runtimeWrapper('export BIAO_AGENT_ID="${BIAO_PM_AGENT_ID:-pm-agent}"\nexec node "$BIAO_PACKAGE_ROOT/bin/biao.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-intake'),
    runtimeWrapper(`export BIAO_AGENT_ID="\${BIAO_PM_AGENT_ID:-pm-agent}"
node "$BIAO_PACKAGE_ROOT/bin/biao.js" status
node "$BIAO_PACKAGE_ROOT/bin/biao.js" pm intake --consumer "\${BIAO_PM_CONSUMER:-pm}" || {
  intake_code=$?
  [ "$intake_code" -eq 2 ] || exit "$intake_code"
}
exec node "$BIAO_PACKAGE_ROOT/bin/biao.js" watchdog`),
  );
  writeExecutable(
    join(setupDir, 'pm-start'),
    runtimeWrapper('export BIAO_AGENT_ID="${BIAO_PM_AGENT_ID:-pm-agent}"\nexec node "$BIAO_PACKAGE_ROOT/bin/biao.js" pm start "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-agent'),
    runtimeWrapper('exec node "$BIAO_PACKAGE_ROOT/scripts/pm-agent.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-heartbeat'),
    `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# 所有项目共用同一个轻量门控；本地文件缺失时 bootstrap 只需补回这层薄包装。
exec "$SCRIPT_DIR/pm" pm heartbeat --once "$@"
`,
  );
  writeExecutable(
    join(setupDir, 'codex-pm-agent'),
    runtimeWrapper('exec node "$BIAO_PACKAGE_ROOT/scripts/codex-pm-agent.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'supervisor'),
    runtimeWrapper('exec node "$BIAO_PACKAGE_ROOT/scripts/supervisor.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-watch'),
    runtimeWrapper(`# 中央 Biao PM 门铃留守监视器：无本地 server、无 worker slot，只按需唤醒 PM Agent。
# 与 start 的区别：不启动本地服务进程，不注册 worker slot；所有计划闭环后
# 留守低频复查。中央失联导致 supervisor 退出时，按 BIAO_PM_WATCH_RESTART_DELAY
# （默认 30s）退避后自动重新轮询。
# 默认纯 PM 门铃模式（无 worker slot）。机器配置了 BIAO_WORKER_SLOTS 且
# BIAO_PM_WATCH_KEEP_WORKER_SLOTS=1 时保留 slots：同一常驻既守 PM 门铃，
# 也按配置主动领取/执行任务，避免"打回的修复任务无人接"的空窗。
if [ "\${BIAO_PM_WATCH_KEEP_WORKER_SLOTS:-0}" != "1" ]; then
  BIAO_WORKER_SLOTS=''
  export BIAO_WORKER_SLOTS
fi

lock_dir="$SCRIPT_DIR/pm-watch.lock"
if [ "\${1:-}" = "--ensure" ]; then
  # 自愈入口：有活实例时立刻返回；否则拉起一个后台副本。判活竞态由下方
  # mkdir 原子锁兜底，因此重复调用 --ensure 是幂等的。
  if [ -f "$lock_dir/pid" ]; then
    lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then exit 0; fi
  fi
  ( nohup "$0" >/dev/null 2>&1 & )
  exit 0
fi
if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "[pm-watch] 已有实例运行（pid \${lock_pid}），本次启动退出。" >&2
    exit 0
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir" || exit 0
fi
echo $$ > "$lock_dir/pid"

log_dir="\${BIAO_LOG_DIR:-$SCRIPT_DIR/logs}"
mkdir -p "$log_dir"
log_file="$log_dir/pm-watch.log"
if [ -f "$log_file" ] && [ "$(wc -c < "$log_file")" -gt "\${BIAO_LOG_MAX_BYTES:-5242880}" ]; then
  mv -f "$log_file" "$log_file.1"
fi
echo "[pm-watch] $(date '+%F %T') 启动：BIAO_URL=\${BIAO_URL}（PM 门铃留守监视，无 worker slot）" >> "$log_file"

child_pid=''
# 操作员显式停止（INT/TERM）：连带回收 supervisor 子进程并清锁。
stop_by_signal() {
  rc=$?
  if [ -n "$child_pid" ]; then
    kill "$child_pid" 2>/dev/null || true
  fi
  rm -rf "$lock_dir" 2>/dev/null || true
  exit "$rc"
}
# 意外退出（EXIT，含 set -e 触发的异常路径）：只清包装器锁，绝不杀 supervisor。
# 孤儿 supervisor 持有自己的本机单实例锁继续处理门铃与 Worker 调度（下方
# "已由其他本机实例接管"路径即为此设计）；把包装器自身故障升级成整条监听链
# 死亡才是最坏结果。需要彻底停止时请向 supervisor 发信号或停止 pm-watch。
cleanup() {
  rc=$?
  rm -rf "$lock_dir" 2>/dev/null || true
  exit "$rc"
}
trap stop_by_signal INT TERM
trap cleanup EXIT

while :; do
  node "$BIAO_PACKAGE_ROOT/scripts/supervisor.mjs" --stay-resident >> "$log_file" 2>&1 &
  child_pid=$!
  if wait "$child_pid"; then
    status=0
  else
    status=$?
  fi
  child_pid=''
  # --stay-resident 正常不会自行退出；退出码 0 几乎总是"另一本机实例已持有
  # supervisor 锁"（例如本包装器被强杀后 supervisor 成为孤儿）。此时安静退出，
  # 把监视交给那个孤儿实例，避免 30s 一次的空转重启循环。
  if [ "$status" -eq 0 ]; then
    echo "[pm-watch] $(date '+%F %T') supervisor 已由其他本机实例接管，本包装器退出。" >> "$log_file"
    exit 0
  fi
  echo "[pm-watch] $(date '+%F %T') supervisor 异常退出（exit=\${status}），\${BIAO_PM_WATCH_RESTART_DELAY:-30}s 后重试" >> "$log_file"
  sleep "\${BIAO_PM_WATCH_RESTART_DELAY:-30}"
done
`),
  );
  writeExecutable(
    join(setupDir, 'agent-kit'),
    credentialFreeWrapper('exec node "$BIAO_PACKAGE_ROOT/scripts/adapter-kit.mjs" "$@"', repoRoot),
  );
  writeExecutable(
    join(setupDir, 'worker-agent'),
    credentialFreeWrapper(`SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIAO_RUNTIME_DIR=$SCRIPT_DIR
export BIAO_RUNTIME_DIR
exec node "$BIAO_PACKAGE_ROOT/scripts/worker-agent.mjs" "$@"`, repoRoot),
  );
  writeExecutable(
    join(setupDir, 'supervisor-config'),
    credentialFreeWrapper(`SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$BIAO_PACKAGE_ROOT/scripts/supervisor-config.mjs" --config "$SCRIPT_DIR/config.env" "$@"`, repoRoot),
  );
  writeExecutable(
    join(setupDir, 'worker-codex'),
    workerRuntimeWrapper('export BIAO_AGENT_ID="${BIAO_AGENT_ID:-codex-1}"\nexport BIAO_EXIT_ON_IDLE="${BIAO_EXIT_ON_IDLE:-1}"\nexec node "$BIAO_PACKAGE_ROOT/bin/codex-worker.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'worker-kimi'),
    workerRuntimeWrapper('export BIAO_AGENT_ID="${BIAO_AGENT_ID:-kimi-1}"\nexport BIAO_EXIT_ON_IDLE="${BIAO_EXIT_ON_IDLE:-1}"\nexec node "$BIAO_PACKAGE_ROOT/bin/kimi-worker.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'worker-custom'),
    workerRuntimeWrapper(`if [ "\${1:-}" = "--help" ] || [ "\${1:-}" = "-h" ]; then
  exec node "$BIAO_PACKAGE_ROOT/bin/biao-worker.js" "$@"
fi
if [ -z "\${BIAO_EXEC_CMD:-}" ]; then
  echo "请先设置 BIAO_EXEC_CMD=/absolute/path/to/executor" >&2
  exit 2
fi
export BIAO_AGENT_ID="\${BIAO_AGENT_ID:-custom-1}"
export BIAO_EXIT_ON_IDLE="\${BIAO_EXIT_ON_IDLE:-1}"
exec node "$BIAO_PACKAGE_ROOT/bin/biao-worker.js" "$@"`),
  );

  const guideTemplate = `# Biao PM Agent 操作契约

你是 Biao 的 PM/验收负责人，不是默认执行 Worker。

## 网页控制台鉴权

启动 \`.biao/start\` 后，直接在本机浏览器打开控制台并点击“进入控制台”。Biao 会创建一个 HttpOnly 的本机 Owner 会话；浏览器不会收到、保存或显示 Agent API Token。关闭会话或轮换 \`BIAO_API_TOKEN\` 会使该浏览器重新要求本机确认。\`.biao/token-status\` 仅供操作者核对 Agent/CLI 凭据是否已配置，它只显示 SHA-256 指纹末尾。

## 每次开始

1. 运行 \`.biao/pm-start --once\`，读取服务状态、最小门铃、历史待验收与执行者缺口，并完成一次共享 Supervisor 检查。
2. 用 \`.biao/pm plan list\` 和 \`.biao/pm task list --plan <id>\` 核对计划。
3. 检查 Worker 结果、Verify 证据和独立验收，再决定接受或拒绝。

兼容旧的只读体检入口仍为 \`.biao/pm-intake\`；新会话优先使用 \`.biao/pm-start --once\`。

## 默认并行拆解与动态补槽

- 派工前必须逐 lane 列出 lane ID、硬依赖、ownership、交付物、验证命令和验收者；ownership 要区分只读与写入并精确到文件、目录或模块。同一文件、模块或共享入口同时只能有一个写入者，只读 lane 才能共享检查范围。
- 首波目标 3–4 条互不重叠的实现 lane。若一个计划有 48 个任务却只有 1 个首波 runnable 实现 lane，且没有可证明的硬依赖或不可拆分的写 ownership，必须调整拆解，**不得提交该 DAG**；不能为了凑并发让多个 Worker 争写同一范围。
- 只有数据、接口、迁移或验收事实的真实消费者才写 \`depends_on\`。同 phase、同里程碑或同优先级都不是依赖理由；任务编号顺序也不能制造依赖。
- acceptance 放在相关实现产物的 fan-in 汇合点，不为每个微任务建立全局阶段栅栏，也不阻塞无关 lane。只读分析与测试应在 ownership 安全的前提下尽早并行。
- PM 每轮先处理 review、Question 和 stale，再补足可运行队列。Worker 数大于 runnable 数时，提示调整 DAG、移除伪依赖或拆开 ownership；runnable 数大于 Worker 数时，提示补槽位并优先启动互不重叠的 lane。
- 这些并行规则不改变下文铁律：done 仍不等于 accepted，Question、repair 与 ack 仍按原闭环处理。

## 可选：共享 Supervisor 按需唤醒 PM Agent

设置 \`BIAO_PM_AGENT_CMD\` 后，\`.biao/supervisor\` 会在同一个共享 Supervisor 轮询进程中按需唤醒 PM Agent，不需要第二个 cron 或 launchd 轮询器。它只在有最小 PM 待办时启动一次 Agent，并使用 \`--require-drained\` 复查事项是否真的被处理；若仍在平台，下个低频共享轮次会重试。

\`.biao/pm-heartbeat\` 是兼容调度器可调用的轻量一次性门控：先扫描最小 intake；没有已交付待 Review、Question、需决策或异常状态时静默退出，绝不启动 PM Agent，也不消耗模型 token。\`acceptance_ready\` 只表示独立验收任务可由 Worker 领取，不会提前启动 PM 模型。生产环境优先复用 \`.biao/start\` 托管的唯一共用 Supervisor，不为每个 PM 建独立定时心跳。

clone 后需要 Codex 直接担任按需 PM 时，推荐 bootstrap 使用 \`--pm-agent codex\`。它会把 \`BIAO_PM_AGENT_CMD\` 安全指向仓库内的 \`.biao/codex-pm-agent\` 适配器；没有门铃时不会启动 Codex，也不新增第二个轮询进程。

多个 PM 可用 \`.biao/supervisor-config pm add\` 加入同一个 Supervisor。每个 PM slot 的 \`consumer\` 必须与其 Plan 声明的 \`pm_consumer\` 一致；Supervisor 才会把验收、Question 和异常裁决送到对应 PM 队列。不同 PM slot 可并行唤醒，同一 slot 不重复启动；未处理事项保留重试，绝不自动 review、answer 或 ack。配置变更只在安全重启 Supervisor 后加载。

\`.biao/pm-agent --once\` 仍保留为兼容的一次性门铃，不是交互式 PM 工作流，也不替代 \`.biao/pm-start --once\`：

\`\`\`bash
# 这里仅放本机 Agent 启动命令；不要把 Biao Token 写进命令或版本库。
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/pm-agent --once
\`\`\`

子进程只收到事项数量、类型、Plan 范围和服务地址；它必须自行回 Biao 读取详情，并在实际处置后才 ack。唤醒器不自动 review、answer 或 ack，也不自动安装 cron 或 launchd。推荐由 Supervisor 直接复用这一适配器；只有不运行常驻 Supervisor 的兼容部署才需要自行低频触发 \`.biao/pm-agent --once\`。

## Worker 与 PM 通讯闭环

Worker 缺少产品决策时不能询问当前人类。内置 Codex、Kimi 和 custom Worker 应在最终消息中只输出一行：

\`\`\`text
BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成内容与恢复点"}
\`\`\`

运行层会持久化 Question、释放旧 claim/ownership，并发送 \`question_asked\` 最小门铃。PM 收到后依次执行：

\`\`\`bash
.biao/pm question list --consumer <pm_consumer> --status open --plan <plan_id>
.biao/pm question get <question_id> --consumer <pm_consumer> --plan <plan_id>
.biao/pm question answer <question_id> --consumer <pm_consumer> --plan <plan_id> --answer "明确答复"
.biao/pm pm ack --consumer <pm_consumer> --plan <plan_id> --event-id <asked_event_id>
\`\`\`

只在答复完成后 ack。精确事件字段为 asked_event_id（旧文档占位名 question_asked_event_id）；answer 会把任务重新置为 pending；Worker 必须 fresh claim，并使用新的 claim token 从平台取得 answer/checkpoint。等待期间不得 report、resume 或绕过平台问人。

## Blocked / stale / legacy failed 恢复顺序

先读取状态，再执行最小动作。常用恢复命令：

    .biao/pm task get <task_id>
    .biao/pm task resume <task_id>
    .biao/pm watchdog --auto-fix

- waiting_dependency / waiting_file_release 是平台与共享 Supervisor 的内部等待，正常不会打扰 PM；不要手工 resume、reset 或 ack 催跑。
- 未知 blocked 只有在证据确认外部条件已经消失时才执行 .biao/pm task resume <task_id>；否则保持 blocked 与未 ack 门铃。
- stale agent 或 running 已丢 lease 时执行 .biao/pm watchdog --auto-fix，再重读 task/intake。该动作只做安全恢复和遗留 resolution 补偿，不会自动验收。
- failed 先检查 resolution/repair：repairing 等 Worker，required Review 当前 repair，needs_pm_decision 使用 resolution 三动作；没有 resolution 的 legacy failed 运行一次 watchdog auto-fix 补建 repair。禁止 reset 原任务绕链。
- 只有状态恢复且 intake 当前事实消失后才 ack；真正无法自治时保留门铃，不伪装闭环。

## PM 铁律

- done 不等于 accepted；只有 PM Review accepted 才算完成。
- Worker 心跳、退出码、产出文件和测试数量不能单独代替验收。
- acceptance 必须由没有执行被验收任务的独立 Agent 完成。
- Verify 失败不得接受；拒绝时写清原因和可执行修复指令。
- Review 必须先读取“当前 task”的 \`result_path\`、\`result_json_path\` 及其明确引用的 evidence，再把触发它的旧 reject/evidence 作为缺陷来源对照。旧 attempt 的失败证据不能冒充当前交付结果；若当前新鲜证据已经推翻旧结论，评语必须引用当前证据的实际字段。
- \`changed_files=[]\` 不是自动拒绝条件。在共享工作树的连续 repair 中，前代未提交实现可能仍真实存在；当前 task 若通过新鲜、可复跑的真实流程证据证明该实现已满足要求，PM 应核对当前 diff、ownership 与证据后按事实验收，不得要求无意义地重复触碰代码。只有 result 自称有改动却漏报、越权改动、或当前证据仍不能证明目标时才因此拒绝。
- 重置任务后旧结果和旧验收失效，必须重新执行和验收。
- 不直接修改 Worker 正在持有 ownership 的文件。
- 不替 Worker 向人类追问：Worker 的阻塞决策必须经平台 Question；PM 读取并回答后，Worker 用新 claim 继续。
- retry 耗尽后先用 \`.biao/pm task resolution <task_id>\` 只读证据；只通过 \`--action continue\` 额外放行一代或通过 \`--action cancel\` 终止修复链。retry-limit 链 cancel 后不会自行复活；操作者可再次显式 continue 重开一代，旧审计不变。不要用 \`task reset --force\` 打断链，只有 continue/cancel 成功后才 ack 对应门铃。
- Supervisor 门铃不是已处理证明；只在完成验收、答复或处置后显式 ack 对应事件。

## 常用命令

\`\`\`bash
.biao/pm status
.biao/pm version
.biao/pm-start --once
.biao/pm plan create <plan_id> --project <project_path> --title "目标"
.biao/pm plan intake --plan <plan_id> --text "用户需求"
.biao/pm task add --plan <plan_id> --task-id <task_id> --title "任务"
.biao/pm task add --plan <plan_id> --task-id <qa_task_id> --title "独立验收" --type acceptance --phase qa --depends-on <source_task_id> --acceptance-for <source_task_id> --verify-cmd "<verification command>"
.biao/pm task edit <task_id> --verify-cmd "<verification command>"
.biao/pm plan status <plan_id>
.biao/pm task list --plan <plan_id>
.biao/pm question list --consumer <pm_consumer> --status open --plan <plan_id>
.biao/pm question get <question_id> --consumer <pm_consumer> --plan <plan_id>
.biao/pm question answer <question_id> --consumer <pm_consumer> --plan <plan_id> --answer "明确答复"
.biao/pm task get <task_id>
.biao/pm task resume <task_id>
.biao/pm task resolution <task_id>
.biao/pm task resolution <task_id> --action continue
.biao/pm task resolution <task_id> --action cancel
.biao/pm pm intake --consumer <pm_consumer>
.biao/pm pm ack --consumer <pm_consumer> --event-id <event_id>
.biao/pm review list
.biao/pm review <task_id>
.biao/pm review <task_id> --accept --comment "验收依据"
.biao/pm review <task_id> --reject --reason "原因" --fix-instructions "修复要求"
.biao/pm review <acceptance_task_id> --reject --reason "仅验收证据不足" --fix-instructions "重新运行 Verify 并提交证据" --reverify-only
.biao/pm watchdog --auto-fix
\`\`\`

## 启动执行者

\`\`\`bash
# 推荐：一个本机 Supervisor 统一 PM 门铃和多个 Worker slot；它不会自动 ack。
BIAO_WORKER_SLOTS='[
  {"kind":"codex","agentId":"codex-1","project":"/absolute/project","types":["code","docs"]},
  {"kind":"kimi","agentId":"kimi-1","project":"/absolute/project","types":["review","acceptance"]},
  {"kind":"custom","agentId":"custom-1","project":"/absolute/project","command":"/absolute/path/to/executor","types":["research"]}
]' .biao/supervisor

# 兼容单 Worker 一次性执行：空队列时退出，不作为多 Agent 生产轮询入口。
.biao/worker-codex
.biao/worker-kimi
BIAO_EXEC_CMD=/absolute/path/to/executor .biao/worker-custom
\`\`\`

当用户要求你“作为 PM 推进”时，先运行 \`.biao/pm-start --once\`，然后按上述验收口径持续推进。
Supervisor 只给最小门铃，永不自动 ack；每个事项必须在读取详情并实际处置后，才执行一次对应的 \`.biao/pm pm ack\`。
`;
  const guide = options.runtimeDir
    ? guideTemplate.replaceAll('.biao/', `${shellQuote(setupDir)}/`)
    : guideTemplate;
  atomicWriteGeneratedFile(join(setupDir, 'PM_AGENT.md'), guide, 0o644);

  injectAgentProtocolBlocks([workspace]);
  return {
    created: !upgrading,
    upgraded: upgrading,
    setupDir,
    configPath,
    tokenGenerated: !upgrading && options.token == null,
    runtimeLayout,
  };
}

/**
 * 向 workspace 根注入 AGENTS.md/CLAUDE.md 协议块（幂等；BIAO_AGENT_PROTOCOL=0 停用）。
 * 只打印一条汇总，失败不阻塞 bootstrap——协议注入是增强路径，不是安装闸门。
 */
function injectAgentProtocolBlocks(roots) {
  if (process.env.BIAO_AGENT_PROTOCOL === '0') return;
  try {
    for (const root of roots) {
      const result = ensureAgentProtocolBlock(root);
      const injected = result.files.filter((entry) => entry.changed).map((entry) => entry.file);
      if (injected.length > 0) console.log(`[bootstrap] 已注入 Biao 协作协议块：${root}（${injected.join(', ')}）`);
    }
  } catch {
    // 注入失败不影响安装正确性
  }
}

export function formatCompletion(result) {
  const setupDir = result.setupDir ?? '.biao';
  const command = (name) => shellQuote(join(setupDir, name));
  if (result.upgraded) {
    return `[biao] 已保留 ${join(setupDir, 'config.env')}，并升级启动器与 PM 手册。
  网页登录：在本机浏览器打开控制台，首次点击“进入控制台”（不粘贴 Token）`;
  }
  if (!result.created) {
    return `[biao] 已存在 ${join(setupDir, 'config.env')}；未覆盖。需要重建时使用 --force，更新启动器时使用 --upgrade。`;
  }
  return `[biao] 配置完成。
  环境检查：${command('doctor')}
  启动服务：${command('start')}
  网页登录：在本机浏览器打开控制台，首次点击“进入控制台”
              浏览器使用 HttpOnly 本机 Owner 会话，不接收 Agent Token
  Agent 凭据：${command('token-status')}（只显示 API Token 指纹末尾）
  PM 入口：  ${command('pm-start')} --once
  PM 唤醒器：配置 BIAO_PM_AGENT_CMD 后由 ${command('supervisor')} 按需启动
  PM 手册：  ${join(setupDir, 'PM_AGENT.md')}
  Agent 接入：${command('agent-kit')} contract --role worker --json
  Slot 配置：${command('supervisor-config')} worker list
  Codex：     ${command('worker-codex')}
  Kimi：      ${command('worker-kimi')}`;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--token' || value.startsWith('--token=')) {
      throw new Error('--token 会把凭据暴露到进程 argv；请使用 --token-file 或 BIAO_BOOTSTRAP_TOKEN');
    }
    if (value === '--force') args.force = true;
    else if (value === '--upgrade') args.upgrade = true;
    else if (value === '--no-install') args.skipInstall = true;
    else if (value === '--no-build') args.skipBuild = true;
    else if (value === '--yes' || value === '-y') args.yes = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value.startsWith('--')) {
      const next = argv[++i];
      if (!next || next.startsWith('--')) throw new Error(`${value} 缺少参数值`);
      args[value.slice(2).replaceAll('-', '_')] = next;
    } else {
      throw new Error(`未知参数：${value}`);
    }
  }
  return args;
}

function usage() {
  return `Biao 开箱配置

用法：
  ./bootstrap.sh --yes --workspace <允许根目录> [--project <默认项目>]
  biao-bootstrap --yes --workspace <允许根目录> [--project <默认项目>]

选项：
  --workspace <path>   Biao 允许访问的工作区；默认当前 Biao 仓库
  --project <path>     Worker 默认领取的项目；默认等于 workspace
  --runtime-dir <path> 可变配置与数据目录；安装包默认当前目录/.biao
  --redis-url <url>    默认 redis://127.0.0.1:6379
  --host <host>        默认 127.0.0.1
  --port <port>        默认 7331
  --token-file <path>  从权限为 owner-only（例如 600）的文件读取已有 Token
  --pm-agent-command <command>
                       PM 待办出现时由共享 Supervisor 按需启动的本机 Agent 命令
  --pm-agent codex     使用仓库内置 Codex PM 适配器；不能与 --pm-agent-command 同用
  --yes, -y            允许 shell 入口安装缺失系统依赖并启动本机 Redis
  --no-install         跳过 npm install
  --no-build           跳过 npm run build
  --force              覆盖已有 .biao 配置
  --upgrade            保留已有 config.env，只更新仓库生成的启动器与 PM 手册

也可由秘密管理器注入 BIAO_BOOTSTRAP_TOKEN。不要把 Token 写进 argv 或 Shell 历史。
`;
}

const bootstrapModulePath = fileURLToPath(import.meta.url);

export function isBootstrapMain(argvPath, moduleUrl = import.meta.url) {
  if (!argvPath) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isBootstrapMain(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const repoRoot = resolve(dirname(bootstrapModulePath), '..');
    const workspace = resolve(args.workspace ?? repoRoot);
    const project = resolve(args.project ?? workspace);
    const token = resolveBootstrapToken(args, process.env);
    const result = bootstrap({
      repoRoot,
      invocationCwd: process.cwd(),
      runtimeDir: args.runtime_dir,
      workspace,
      project,
      redisUrl: args.redis_url,
      host: args.host,
      port: args.port == null ? undefined : Number(args.port),
      token,
      pmAgentCommand: args.pm_agent_command,
      pmAgent: args.pm_agent,
      force: args.force,
      upgrade: args.upgrade,
      skipInstall: args.skipInstall,
      skipBuild: args.skipBuild,
    });
    console.log(formatCompletion(result));
  } catch (error) {
    console.error(`[biao] bootstrap 失败：${error.message}`);
    process.exit(1);
  }
}
