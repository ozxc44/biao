#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function assertDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} 不存在或不是目录：${path}`);
  }
}

function isInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function wrapper(body) {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
set -a
. "$SCRIPT_DIR/config.env"
set +a
${body}
`;
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
  ['package-lock.json', 'file'],
  ['tsconfig.json', 'file'],
  ['src', 'directory'],
  ['web/package.json', 'file'],
  ['web/package-lock.json', 'file'],
];

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
  const workspace = resolve(options.workspace);
  const project = resolve(options.project ?? workspace);
  const setupDir = join(repoRoot, '.biao');
  const configPath = join(setupDir, 'config.env');

  if (options.pmAgent && options.pmAgentCommand) {
    throw new Error('pmAgent 与 pmAgentCommand 不能同时配置');
  }
  if (options.pmAgent && options.pmAgent !== 'codex') {
    throw new Error(`pmAgent 目前只支持 codex：${options.pmAgent}`);
  }
  const pmAgentCommand = options.pmAgent === 'codex'
    ? join(setupDir, 'codex-pm-agent')
    : (options.pmAgentCommand ?? '');

  assertDirectory(repoRoot, 'repoRoot');
  assertDirectory(workspace, 'workspace');
  if (!isInside(workspace, project)) {
    throw new Error(`project 必须位于 workspace 内：${project}`);
  }
  assertDirectory(project, 'project');

  const runtimeLayout = detectBootstrapRuntimeLayout(repoRoot);
  if (runtimeLayout === 'incomplete') {
    throw new Error('安装内容不完整：既不是可构建的 Git 源码，也不是完整的预构建运行时；请重新 clone 或重新安装发布包');
  }

  const configExists = existsSync(configPath);
  const upgrading = configExists && !options.force && options.upgrade === true;
  if (configExists && !options.force && !upgrading) {
    assertCompleteRuntime(repoRoot, '检查已有配置');
    return { created: false, setupDir, configPath, runtimeLayout };
  }

  const runCommand = options.commandRunner ?? runNpm;
  if (runtimeLayout === 'source' && !options.skipInstall) {
    runCommand(repoRoot, ['install', '--workspaces=false'], '根目录依赖安装');
    runCommand(join(repoRoot, 'web'), ['install', '--workspaces=false'], 'Web 依赖安装');
  }
  if (runtimeLayout === 'source' && !options.skipBuild) runCommand(repoRoot, ['run', 'build', '--workspaces=false'], '项目构建');
  assertCompleteRuntime(repoRoot, runtimeLayout === 'source' ? '源码准备' : '预构建包校验');

  const port = Number(options.port ?? 7331);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`端口无效：${options.port}`);
  const host = options.host ?? '127.0.0.1';
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const token = options.token ?? randomBytes(24).toString('hex');
  const dataDir = join(setupDir, 'data');
  mkdirSync(dataDir, { recursive: true });

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
    `BIAO_PM_AGENT_CMD=${shellQuote(pmAgentCommand)}`,
    '',
  ].join('\n');

  mkdirSync(setupDir, { recursive: true });
  if (!upgrading) {
    writeFileSync(configPath, config, { mode: 0o600 });
    chmodSync(configPath, 0o600);
  } else if (options.pmAgent || options.pmAgentCommand) {
    const previous = readFileSync(configPath, 'utf8');
    const line = `BIAO_PM_AGENT_CMD=${shellQuote(pmAgentCommand)}`;
    const next = /^BIAO_PM_AGENT_CMD=.*$/m.test(previous)
      ? previous.replace(/^BIAO_PM_AGENT_CMD=.*$/m, line)
      : `${previous.replace(/\n?$/, '\n')}${line}\n`;
    writeFileSync(configPath, next, { mode: 0o600 });
    chmodSync(configPath, 0o600);
  }

  writeExecutable(
    join(setupDir, 'doctor'),
    wrapper(`redis_probe_url=$BIAO_REDIS_URL
unset BIAO_API_TOKEN BIAO_BOOTSTRAP_TOKEN BIAO_REDIS_URL
failed=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)'; then
  echo "[ok] Node.js 20.19+ / 22.12+: $(node --version)"
  echo "[ok] npm: $(command -v npm)"
else
  echo "[missing] Node.js 20.19+ / 22.12+ 和 npm" >&2
  failed=1
fi
if command -v redis-cli >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  if BIAO_REDIS_PROBE_URL=$redis_probe_url node "$SCRIPT_DIR/../scripts/redis-probe.mjs" >/dev/null 2>&1; then
    echo "[ok] Redis 可连接"
  else
    echo "[missing] Redis 不可连接；请检查 .biao/config.env 中的 BIAO_REDIS_URL" >&2
    failed=1
  fi
else
  echo "[missing] redis-cli（无法检查 Redis）" >&2
  failed=1
fi
for optional_name in codex kimi; do
  if command -v "$optional_name" >/dev/null 2>&1; then
    echo "[ok] 可选 Agent: $optional_name"
  else
    echo "[optional] 未安装 $optional_name"
  fi
done
if [ ! -d "$BIAO_WORKSPACE_ROOTS" ]; then
  echo "[missing] workspace 不存在：$BIAO_WORKSPACE_ROOTS" >&2
  failed=1
else
  echo "[ok] workspace: $BIAO_WORKSPACE_ROOTS"
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

echo "[biao] API Token 已复制到系统剪贴板；请粘贴到网页右上角 API Token。"`),
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
  writeExecutable(join(setupDir, 'start'), wrapper('exec node "$SCRIPT_DIR/../dist/server/main.js"'));
  writeExecutable(
    join(setupDir, 'pm'),
    wrapper('export BIAO_AGENT_ID="${BIAO_PM_AGENT_ID:-pm-agent}"\nexec node "$SCRIPT_DIR/../bin/biao.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-intake'),
    wrapper(`export BIAO_AGENT_ID="\${BIAO_PM_AGENT_ID:-pm-agent}"
node "$SCRIPT_DIR/../bin/biao.js" status
node "$SCRIPT_DIR/../bin/biao.js" pm intake --consumer "\${BIAO_PM_CONSUMER:-pm}" || {
  intake_code=$?
  [ "$intake_code" -eq 2 ] || exit "$intake_code"
}
exec node "$SCRIPT_DIR/../bin/biao.js" watchdog`),
  );
  writeExecutable(
    join(setupDir, 'pm-start'),
    wrapper('export BIAO_AGENT_ID="${BIAO_PM_AGENT_ID:-pm-agent}"\nexec node "$SCRIPT_DIR/../bin/biao.js" pm start "$@"'),
  );
  writeExecutable(
    join(setupDir, 'pm-agent'),
    wrapper('exec node "$SCRIPT_DIR/../scripts/pm-agent.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'codex-pm-agent'),
    wrapper('exec node "$SCRIPT_DIR/../scripts/codex-pm-agent.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'supervisor'),
    wrapper('exec node "$SCRIPT_DIR/../scripts/supervisor.mjs" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'worker-codex'),
    wrapper('export BIAO_AGENT_ID="${BIAO_AGENT_ID:-codex-1}"\nexport BIAO_EXIT_ON_IDLE="${BIAO_EXIT_ON_IDLE:-1}"\nexec node "$SCRIPT_DIR/../bin/codex-worker.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'worker-kimi'),
    wrapper('export BIAO_AGENT_ID="${BIAO_AGENT_ID:-kimi-1}"\nexport BIAO_EXIT_ON_IDLE="${BIAO_EXIT_ON_IDLE:-1}"\nexec node "$SCRIPT_DIR/../bin/kimi-worker.js" "$@"'),
  );
  writeExecutable(
    join(setupDir, 'worker-custom'),
    wrapper(`if [ "\${1:-}" = "--help" ] || [ "\${1:-}" = "-h" ]; then
  exec node "$SCRIPT_DIR/../bin/biao-worker.js" "$@"
fi
if [ -z "\${BIAO_EXEC_CMD:-}" ]; then
  echo "请先设置 BIAO_EXEC_CMD=/absolute/path/to/executor" >&2
  exit 2
fi
export BIAO_AGENT_ID="\${BIAO_AGENT_ID:-custom-1}"
export BIAO_EXIT_ON_IDLE="\${BIAO_EXIT_ON_IDLE:-1}"
exec node "$SCRIPT_DIR/../bin/biao-worker.js" "$@"`),
  );

  const guide = `# Biao PM Agent 操作契约

你是 Biao 的 PM/验收负责人，不是默认执行 Worker。

## 网页控制台鉴权

启动 \`.biao/start\` 后，另开终端运行 \`.biao/copy-token\`，再把剪贴板内容粘贴到网页右上角 **API Token**。网页只把凭据保存在当前标签页的 \`sessionStorage\`；该命令不会把 Token 写入 argv、URL 或默认终端输出。只核对配置状态时可运行 \`.biao/token-status\`，它只显示 SHA-256 指纹末尾。

## 每次开始

1. 运行 \`.biao/pm-start --once\`，读取服务状态、最小门铃、历史待验收与执行者缺口，并完成一次共享 Supervisor 检查。
2. 用 \`.biao/pm plan list\` 和 \`.biao/pm task list --plan <id>\` 核对计划。
3. 检查 Worker 结果、Verify 证据和独立验收，再决定接受或拒绝。

兼容旧的只读体检入口仍为 \`.biao/pm-intake\`；新会话优先使用 \`.biao/pm-start --once\`。

## 可选：共享 Supervisor 按需唤醒 PM Agent

设置 \`BIAO_PM_AGENT_CMD\` 后，\`.biao/supervisor\` 会在同一个共享 Supervisor 轮询进程中按需唤醒 PM Agent，不需要第二个 cron 或 launchd 轮询器。它只在有最小 PM 待办时启动一次 Agent，并使用 \`--require-drained\` 复查事项是否真的被处理；若仍在平台，下个低频共享轮次会重试。

clone 后需要 Codex 直接担任按需 PM 时，推荐 bootstrap 使用 \`--pm-agent codex\`。它会把 \`BIAO_PM_AGENT_CMD\` 安全指向仓库内的 \`.biao/codex-pm-agent\` 适配器；没有门铃时不会启动 Codex，也不新增第二个轮询进程。

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
- 重置任务后旧结果和旧验收失效，必须重新执行和验收。
- 不直接修改 Worker 正在持有 ownership 的文件。
- 不替 Worker 向人类追问：Worker 的阻塞决策必须经平台 Question；PM 读取并回答后，Worker 用新 claim 继续。
- retry 耗尽后先用 \`.biao/pm task resolution <task_id>\` 只读证据；只通过 \`--action continue\` 额外放行一代或通过 \`--action cancel\` 终止修复链。不要用 \`task reset --force\` 打断链，只有 continue/cancel 成功后才 ack 对应门铃。
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
  writeFileSync(join(setupDir, 'PM_AGENT.md'), guide);

  return {
    created: !upgrading,
    upgraded: upgrading,
    setupDir,
    configPath,
    tokenGenerated: !upgrading && options.token == null,
    runtimeLayout,
  };
}

export function formatCompletion(result) {
  if (result.upgraded) {
    return `[biao] 已保留 .biao/config.env，并升级启动器与 PM 手册。
  网页鉴权：运行 .biao/copy-token，再粘贴到网页右上角 API Token（仅存当前标签页 sessionStorage）`;
  }
  if (!result.created) {
    return '[biao] 已存在 .biao/config.env；未覆盖。需要重建时使用 --force，更新启动器时使用 --upgrade。';
  }
  return `[biao] 配置完成。
  环境检查：.biao/doctor
  启动服务：.biao/start
  网页鉴权：另开终端运行 .biao/copy-token → 粘贴到网页右上角 API Token
              Token 仅存当前标签页 sessionStorage，命令不会打印凭据
  Token 状态：.biao/token-status（只显示 SHA-256 指纹末尾）
  PM 入口：  .biao/pm-start --once
  PM 唤醒器：配置 BIAO_PM_AGENT_CMD 后由 .biao/supervisor 按需启动
  PM 手册：  .biao/PM_AGENT.md
  Codex：     .biao/worker-codex
  Kimi：      .biao/worker-kimi`;
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

选项：
  --workspace <path>   Biao 允许访问的工作区；默认当前 Biao 仓库
  --project <path>     Worker 默认领取的项目；默认等于 workspace
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
