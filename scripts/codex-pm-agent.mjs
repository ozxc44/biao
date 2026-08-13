#!/usr/bin/env node
/**
 * Biao 最小门铃 -> Codex PM 会话适配器。
 *
 * 由 scripts/pm-agent.mjs 按需启动；本脚本只把五字段门铃转换成明确的 PM 契约，
 * 再启动一次 ephemeral Codex。任务正文、结果、Question 正文和 Biao 凭据都不会从
 * 门铃透传，Codex 必须通过当前 runtime 的绝对 launcher 自行回平台读取并实际处置。
 */

import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_WAKE_BYTES = 16 * 1024;
const ALLOWED_KEYS = new Set(['biaoUrl', 'consumer', 'planIds', 'kinds', 'count']);
const ALLOWED_KINDS = new Set([
  'review_requested',
  'acceptance_ready',
  'question_asked',
  'resolution_required',
  'needs_pm_decision',
  'failed',
  'blocked',
  'stale_agent',
]);

function fail(message, code = 2) {
  console.error(`[codex-pm-agent] 门铃载荷无效：${message}`);
  return code;
}

function validateWake(raw) {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_WAKE_BYTES) {
    throw new Error(`必须是 1-${MAX_WAKE_BYTES} 字节 JSON`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('不是合法 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('必须是对象');
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_KEYS.has(key)) || keys.length !== ALLOWED_KEYS.size) {
    throw new Error('只允许 biaoUrl/consumer/planIds/kinds/count 五个字段');
  }

  let url;
  try {
    url = new URL(value.biaoUrl);
  } catch {
    throw new Error('biaoUrl 无法解析');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('biaoUrl 只允许无凭据、查询和 hash 的 http/https 地址');
  }
  const biaoUrl = url.toString().replace(/\/$/, '');

  if (typeof value.consumer !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.consumer)) {
    throw new Error('consumer 非法');
  }
  if (!Array.isArray(value.planIds)
    || value.planIds.length > 100
    || value.planIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200)) {
    throw new Error('planIds 非法');
  }
  const planIds = [...new Set(value.planIds.map((id) => id.trim()))];

  if (!value.kinds || typeof value.kinds !== 'object' || Array.isArray(value.kinds)) {
    throw new Error('kinds 必须是对象');
  }
  const kinds = {};
  for (const [kind, count] of Object.entries(value.kinds)) {
    if (!ALLOWED_KINDS.has(kind) || !Number.isSafeInteger(count) || count <= 0 || count > 10_000) {
      throw new Error('kinds 包含未知类型或非法计数');
    }
    kinds[kind] = count;
  }
  const total = Object.values(kinds).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(value.count) || value.count <= 0 || value.count > 10_000 || value.count !== total) {
    throw new Error('count 必须等于 kinds 计数之和');
  }
  return { biaoUrl, consumer: value.consumer, planIds, kinds, count: value.count };
}

function safeAgentEnvironment() {
  // Codex 自身的认证配置可以继承；Biao token/Redis/数据库信息不跨入 Agent 进程。
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function isInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function canonicalAbsoluteDirectory(rawValue, label) {
  const value = rawValue?.trim();
  if (!value || !isAbsolute(value)) {
    throw new Error(`${label} 必须是已存在的绝对目录：${value ?? ''}`);
  }
  try {
    const canonical = realpathSync(resolve(value));
    if (!lstatSync(canonical).isDirectory()) throw new Error('not-directory');
    return canonical;
  } catch {
    throw new Error(`${label} 必须是已存在的绝对目录：${value}`);
  }
}

function resolveCanonicalProject() {
  const configuredRoots = process.env.BIAO_WORKSPACE_ROOTS?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean) ?? [];
  if (configuredRoots.length === 0) {
    throw new Error('BIAO_WORKSPACE_ROOTS 必须至少包含一个绝对目录');
  }
  const roots = [...new Set(configuredRoots.map((root) => canonicalAbsoluteDirectory(root, 'workspace root')))];
  const project = canonicalAbsoluteDirectory(process.env.BIAO_PREFERRED_PROJECT, 'project');
  if (!roots.some((root) => isInside(root, project))) {
    throw new Error(`project 必须位于 workspace roots 内：${project}`);
  }
  return project;
}

function resolveRuntimeDirectory(repoRoot) {
  const configured = process.env.BIAO_RUNTIME_DIR?.trim();
  const lexicalCandidate = resolve(configured || join(repoRoot, '.biao'));
  if ((configured && !isAbsolute(configured)) || !existsSync(lexicalCandidate)) {
    throw new Error(`BIAO_RUNTIME_DIR 必须是已存在的绝对目录：${configured || lexicalCandidate}`);
  }
  const metadata = lstatSync(lexicalCandidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`BIAO_RUNTIME_DIR 必须是真实目录且不能是符号链接：${lexicalCandidate}`);
  }
  // 固定所有祖先链接解析后的真实路径。后续 cwd/-C/launcher prompt 和校验都使用
  // 同一 canonical 路径，避免祖先 symlink 在校验后改指造成 TOCTOU。
  const candidate = realpathSync(lexicalCandidate);
  for (const name of ['pm-start', 'pm']) {
    const launcher = join(candidate, name);
    let launcherMetadata;
    try {
      launcherMetadata = lstatSync(launcher);
      accessSync(launcher, constants.X_OK);
    } catch {
      throw new Error(`Biao runtime 缺少可执行 launcher：${launcher}`);
    }
    if (launcherMetadata.isSymbolicLink() || !launcherMetadata.isFile()) {
      throw new Error(`Biao runtime launcher 必须是普通可执行文件且不能是符号链接：${launcher}`);
    }
  }
  return candidate;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function buildPrompt(wake, runtimeDir) {
  const plans = wake.planIds.length > 0 ? wake.planIds.join(', ') : '未预先限定（必须从 intake 确认范围）';
  const kinds = Object.entries(wake.kinds).map(([kind, count]) => `${kind}=${count}`).join(', ');
  const consumerArg = shellQuote(wake.consumer);
  const pmStartLauncher = shellQuote(join(runtimeDir, 'pm-start'));
  const pmLauncher = shellQuote(join(runtimeDir, 'pm'));
  const pmStartCommand = `${pmStartLauncher} --once --consumer ${consumerArg}${wake.planIds.length > 0
    ? ` --plans ${shellQuote(wake.planIds.join(','))}`
    : ''}`;
  const intakeCommands = wake.planIds.length > 0
    ? wake.planIds.map((planId) => `${pmLauncher} pm intake --consumer ${consumerArg} --plan ${shellQuote(planId)}`)
    : [`${pmLauncher} pm intake --consumer ${consumerArg}`];
  const intakeCommandList = intakeCommands.map((command) => `\`${command}\``).join('、');
  const questionScopes = wake.planIds.length > 0 ? wake.planIds : [undefined];
  const questionCommands = questionScopes.map((planId) => {
    const planArg = planId ? ` --plan ${shellQuote(planId)}` : '';
    return [
      `${pmLauncher} question list --consumer ${consumerArg} --status open${planArg}`,
      `${pmLauncher} question get <question_id> --consumer ${consumerArg}${planArg}`,
      `${pmLauncher} question answer <question_id> --consumer ${consumerArg}${planArg} --answer <明确答复>`,
      `${pmLauncher} pm unacked --consumer ${consumerArg}${planArg} --type question_asked --json`,
      `${pmLauncher} pm ack --consumer ${consumerArg}${planArg} --event-id <asked_event_id>`,
    ].map((command) => `\`${command}\``).join(' → ');
  }).join('；');
  return `你是 Biao 的一次性 PM/验收 Agent。平台只给了最小门铃，不代表事项已处理。

服务：${wake.biaoUrl}
consumer：${wake.consumer}
Plan 范围：${plans}
门铃类型：${kinds}

执行工具边界（强制）：
- 这是本机 CLI 闭环，必须直接使用 shell/exec 运行上述 runtime 绝对 launcher；这些入口已配置好认证。
- 禁止使用 Computer Use、桌面 Terminal、ZCode UI 或任何浏览器来代替 CLI，也不得改用浏览器访问 Biao。
- 不要读取或调用任何 skill、memory、MCP、Connector 或插件；本提示已包含完整操作契约，外部工具失败不能改写任务范围。
- 若某条 CLI 命令失败，直接记录其 stderr/exit code 并让本次会话非零退出；不要绕行 UI，事件会保留供下轮重试。

必须完成一个真实闭环：
1. 在当前 Biao 仓库先运行 \`${pmStartCommand}\`，再逐条运行 ${intakeCommandList} 主动读取详情；所有启动和 intake 命令都必须保留这些 Plan 过滤参数，禁止读取或处理其它 Plan。
2. review/acceptance：读取 task、result、verify_results 和已有审查证据，执行足够的独立验证；通过才 accept，失败必须 reject 并写清可执行修复要求。done、退出码 0 或测试数量都不能替代 PM 验收。
3. question_asked：严格按每个受管 Plan 分别执行 ${questionCommands}。get/answer 成功返回的 asked_event_id 是唯一可 ack 的对应门铃；不得省略 Plan 过滤或跨 Plan 批量处理。根据任务书、代码和计划作出明确答复。Worker 必须经平台取得答复并 fresh claim；不要向当前人类提问，也不要让 Worker 绕过平台问人。
4. failed/blocked/stale/resolution：按状态执行，禁止 reset 绕过修复链或清门铃：
   - 有 task_id 时先运行 \`${pmLauncher} task get <task_id>\` 读取当前真相。\`waiting_dependency / waiting_file_release\` 是平台与共享 Supervisor 的内部等待，正常不会打扰 PM；不得手工 resume 或 ack 催跑。\`waiting_pm_reply\` 必须走上面的 Question answer。
   - 未知 blocked 只有在证据确认外部条件已经消失时才运行 \`${pmLauncher} task resume <task_id>\`，随后重读 task/intake；条件仍存在就保留门铃。
   - stale_agent 或 running 已丢 lease 时运行 \`${pmLauncher} watchdog --auto-fix\`，再重读 task/intake；该命令只做安全的 lease/agent 恢复和遗留 resolution 补偿，不会自动验收。
   - failed 先看 resolution/repair 状态：repairing 等 Worker，required Review 当前 repair，needs_pm_decision 先运行 \`${pmLauncher} task resolution <task_id>\`；证据支持时用 \`--action continue\`，明确终止时用 \`--action cancel\`。没有 resolution 的 legacy failed 运行一次 \`${pmLauncher} watchdog --auto-fix\` 补建 repair 后重读，不得 reset 原任务。
   - 对于 resolution，只有 continue/cancel 成功后才 ack；其它异常也必须等对应恢复动作成功、intake 当前事实消失后才 ack。真正无法自治时保留门铃并让本次会话非零退出；不要直接替 Worker 修改实现文件，也不要伪造成功结果。
5. 只有事项实际处置完成后，才对对应 event 执行 \`${pmLauncher} pm ack --consumer ${consumerArg} --event-id <id>\`。绝不批量盲 ack、自动通过或把门铃当完成证明。
6. 最后再次逐条运行 ${intakeCommandList}，确认本次门铃 Plan 范围内的可处理事项已清空；不得用无 Plan 过滤的 intake 代替。若因真实外部阻塞无法处置，保留未 ack 状态并在最终结果明确说明，不得假装闭环。

保持平台被动、输出简短。你是 PM，不是本轮 Worker。`;
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：由 scripts/pm-agent.mjs 通过 stdin 传入五字段最小门铃；本脚本按需启动一次 ephemeral Codex PM 会话。');
    return 0;
  }
  let wake;
  try {
    wake = validateWake(readFileSync(0, 'utf8').trim());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const repoRoot = resolve(import.meta.dirname, '..');
  let runtimeDir;
  try {
    runtimeDir = resolveRuntimeDirectory(repoRoot);
  } catch (error) {
    console.error(`[codex-pm-agent] runtime 配置无效：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
  let project;
  try {
    project = resolveCanonicalProject();
  } catch (error) {
    console.error(`[codex-pm-agent] workspace 配置无效：${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
  const codexBin = process.env.BIAO_CODEX_BIN?.trim() || 'codex';
  const sandbox = ['read-only', 'workspace-write'].includes(process.env.BIAO_CODEX_PM_SANDBOX ?? '')
    ? process.env.BIAO_CODEX_PM_SANDBOX
    : 'workspace-write';
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--color', 'never',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'model_reasoning_effort="high"',
    '-s', sandbox, '-C', runtimeDir,
    ...(project !== runtimeDir ? ['--add-dir', project] : []),
    '-',
  ];
  const result = spawnSync(codexBin, args, {
    cwd: runtimeDir,
    input: buildPrompt(wake, runtimeDir),
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
    env: safeAgentEnvironment(),
  });
  if (result.error) {
    console.error(`[codex-pm-agent] Codex PM Agent 无法启动：${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`[codex-pm-agent] Codex PM Agent 被信号 ${result.signal} 终止`);
    return 1;
  }
  const code = result.status ?? 1;
  if (code !== 0) console.error(`[codex-pm-agent] Codex PM Agent 未完成（退出码 ${code}），保留门铃供共享 Supervisor 下轮重试。`);
  return code;
}

process.exitCode = main();
