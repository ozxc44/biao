/**
 * Biao CLI
 * 对应 docs/biao/05-biao-service-spec.md 的 CLI 子命令
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/main.js';
import { runPlanIntake, runPlanRevise, runTaskAdd, runTaskEdit } from './planning.js';

const BIAO_URL = process.env.BIAO_URL ?? 'http://localhost:7331';
const BIAO_API_TOKEN = process.env.BIAO_API_TOKEN;

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BIAO_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(BIAO_API_TOKEN ? { Authorization: `Bearer ${BIAO_API_TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : { ok: res.ok, data: null };
  } catch {
    return {
      ok: false,
      data: null,
      error: { code: `HTTP_${res.status}`, message: raw || '服务返回了无法解析的响应' },
    };
  }
}

function isApiSuccess(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
  if (!isApiSuccess(value)) process.exitCode = 1;
}

/** 解析 --since 参数为毫秒时间戳
 *  支持：5m / 30m（分钟）、1h / 2h（小时）、1d（天）、2026-08-11（日期）、纯数字（毫秒 ts）
 */
function parseSince(s: string): number | null {
  // 纯数字 → 直接当毫秒时间戳
  if (/^\d+$/.test(s)) return Number(s);
  // 相对时间：Nm / Nh / Nd
  const rel = s.match(/^(\d+)([mhd])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * factor;
  }
  // 日期：YYYY-MM-DD → 当天 00:00:00 的毫秒时间戳（本地时区）
  const date = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    return d.getTime();
  }
  return null;
}

/**
 * `task list` 的一行只给出当前最关键的闭环状态。原始 status 仍单独保留，
 * 这样失败/拒绝的审计事实不会被“修复中”掩盖，也不会把 Worker 的正常自动
 * 修复过程误报成需要人立即处理的告警。
 */
type TaskListDisplayItem = {
  task_id: string;
  title: string;
  type: string;
  phase: string;
  status: string;
  assignee?: string;
  priority: number;
  pm_review_status?: string;
  failure_reason?: string;
  block_reason?: string;
  fix_for?: string;
  resolution_status?: 'required' | 'repairing' | 'resolved' | 'needs_pm_decision' | string;
  resolution_task_id?: string;
  resolved_by_task?: string;
};

type TaskLifecycleTone = 'repairing' | 'review' | 'decision' | 'legacy_failure' | 'quiet';

function taskLifecycle(item: TaskListDisplayItem): { label: string; tone: TaskLifecycleTone } {
  const repairId = item.resolution_task_id;
  switch (item.resolution_status) {
    case 'repairing':
      return { label: `修复中${repairId ? ` → ${repairId}` : ''}`, tone: 'repairing' };
    case 'required':
      return { label: `修复待验收${repairId ? ` → ${repairId}` : ''}`, tone: 'review' };
    case 'resolved':
      return { label: `闭环已验收${item.resolved_by_task ? ` ← ${item.resolved_by_task}` : ''}`, tone: 'quiet' };
    case 'needs_pm_decision':
      return { label: '需 PM 决策', tone: 'decision' };
    default:
      break;
  }

  if (item.fix_for) {
    if (item.status === 'done' && !item.pm_review_status) {
      return { label: `修复待验收 ← ${item.fix_for}`, tone: 'review' };
    }
    if (item.pm_review_status === 'accepted') {
      return { label: `修复已验收 ← ${item.fix_for}`, tone: 'quiet' };
    }
    if (item.pm_review_status === 'rejected') {
      return { label: `修复被拒 ← ${item.fix_for}`, tone: 'repairing' };
    }
    if (item.status === 'running') {
      return { label: `修复执行中 ← ${item.fix_for}`, tone: 'repairing' };
    }
    if (item.status === 'pending') {
      return { label: `修复待执行 ← ${item.fix_for}`, tone: 'repairing' };
    }
  }

  if (item.status === 'done') {
    if (item.pm_review_status === 'accepted') return { label: '已验收', tone: 'quiet' };
    if (item.pm_review_status === 'rejected') return { label: '已拒绝，修复中', tone: 'repairing' };
    return { label: '待 PM 验收', tone: 'review' };
  }
  if (item.status === 'blocked') {
    if (item.block_reason === 'waiting_file_release') return { label: '等待文件释放', tone: 'quiet' };
    if (item.block_reason === 'waiting_dependency') return { label: '等待依赖', tone: 'quiet' };
    return { label: item.block_reason ? `阻塞：${item.block_reason}` : '阻塞', tone: 'decision' };
  }
  if (item.status === 'failed') {
    return { label: item.failure_reason ? '失败，等待修复闭环' : '遗留失败，待核实', tone: 'legacy_failure' };
  }
  if (item.status === 'superseded') {
    return { label: '历史交付已退出验收', tone: 'quiet' };
  }
  return { label: '—', tone: 'quiet' };
}

function printTaskLifecycleSummary(tasks: TaskListDisplayItem[]): void {
  const lifecycles = tasks.map(taskLifecycle);
  const repairing = lifecycles.filter((state) => state.tone === 'repairing').length;
  const review = lifecycles.filter((state) => state.tone === 'review').length;
  const decision = lifecycles.filter((state) => state.tone === 'decision').length;
  const legacyFailure = lifecycles.filter((state) => state.tone === 'legacy_failure').length;

  const summary = [
    repairing > 0 ? `自动修复 ${repairing}` : '',
    review > 0 ? `待 PM 验收 ${review}` : '',
    decision > 0 ? `需 PM 决策 ${decision}` : '',
    legacyFailure > 0 ? `遗留失败 ${legacyFailure}` : '',
  ].filter(Boolean);
  if (summary.length === 0) return;

  console.log(`\n闭环摘要（当前筛选）：${summary.join('；')}`);
  if (decision > 0 || legacyFailure > 0) {
    console.log('下一步：运行 biao pm start --once 查看最小门铃；不要手动 reset 原任务。');
  } else if (review > 0) {
    console.log('下一步：对完成任务执行 biao review <task_id>；平台不会自动验收。');
  }
}

function printPmHelp(): void {
  console.log(`用法：biao pm <start|intake|unacked|ack|watch> [选项]

PM 只接收最小门铃，详情由 PM 主动从平台读取；平台不会自动验收、答复或 ack。
  biao pm start --once [--consumer <pm>]       PM 会话开场：检查状态、intake 和共享 Supervisor
  biao pm intake [--consumer <pm>]             一次读取待处理门铃
  biao pm unacked [--consumer <pm>] [--plan <id>] 读取未确认事件（脚本使用）
  biao pm ack --event-id <id> [--consumer <pm>] [--plan <id>] 仅在事项实际处理完成后确认事件
  biao pm watch [--interval 60]                 低频最小提醒；不会自动 ack

Worker 提问闭环（不要让 Worker 转而询问当前人类）：
  1. biao question list --consumer <pm> --status open --plan <id>
  2. biao question get <question_id> --consumer <pm> --plan <id>
  3. biao question answer <question_id> --consumer <pm> --plan <id> --answer "明确答复"
  4. 答复完成后，再对对应 question_asked 事件执行 biao pm ack

retry 耗尽决策闭环（不要 force reset 修复链）：
  1. biao task resolution <task_id>                         只读根因、lineage 与可用动作
  2. biao task resolution <task_id> --action continue       只额外放行一代
     或 biao task resolution <task_id> --action cancel      终止并保留审计
  3. 决策成功后，再对对应 resolution_required 事件执行 biao pm ack

answer 会把任务重新置为 pending；Worker 必须用新的 claim token 重新领取，平台会同时交回 PM 答复和 checkpoint。`);
}

function printQuestionHelp(): void {
  console.log(`用法：biao question <ask|list|get|answer> [选项]

Worker → PM 的平台内通讯闭环：
  Worker：biao question ask --task <task_id> --claim-token <token> --agent-id <current-worker-id> --body "问题" [--checkpoint "已完成进度"]
  PM：    biao question list --consumer <pm> --status open --plan <id>
         biao question get <question_id> --consumer <pm> --plan <id>
         biao question answer <question_id> --consumer <pm> --plan <id> --answer "明确答复"

集成式 Codex/Kimi/custom Worker 遇到必须由 PM 决策的问题时，在最终消息中只输出一行：
  BIAO_QUESTION: {"body":"需要 PM 决策的问题","checkpoint":"已完成内容与恢复点"}

平台会持久化 Question、释放当前 claim/ownership，并向归属 PM 发出 question_asked 门铃。
PM 回答后任务重新进入 pending；Worker 用新的 claim token 领取，并从平台获得答复和 checkpoint。
旧 claim token 在 ask 成功后失效；等待答复期间不要 report、resume，也不要询问当前人类。`);
}

function printQuestionLeafHelp(command: string): void {
  const usage: Record<string, string> = {
    ask: 'biao question ask --task <task_id> --claim-token <token> --agent-id <current-worker-id> --body "问题" [--checkpoint "进度"]',
    list: 'biao question list --consumer <pm> --status open [--plan <id>]',
    get: 'biao question get <question_id> --consumer <pm> [--plan <id>]',
    answer: 'biao question answer <question_id> --consumer <pm> [--plan <id>] --answer "明确答复"',
  };
  console.log(`用法：${usage[command] ?? 'biao question --help'}`);
  if (command === 'ask') console.log('必须显式传入当前 claim 的 Worker agent id；不得使用 pm-agent（.biao/pm 的默认身份）。');
}

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

const TOP_LEVEL_COMMANDS = new Set([
  'serve',
  'health',
  'pm',
  'status',
  'version',
  '--version',
  '-V',
  'plan',
  'question',
  'task',
  'review',
  'db',
  'ownership',
  'events',
  'conflicts',
  'watchdog',
]);

const COMMAND_GROUPS: Record<string, readonly string[]> = {
  pm: ['start', 'intake', 'unacked', 'ack', 'watch'],
  plan: ['init', 'create', 'submit', 'list', 'status', 'revise', 'intake', 'supersede'],
  task: ['get', 'add', 'edit', 'cancel', 'block', 'resume', 'reset', 'list', 'supersede', 'resolution'],
  question: ['ask', 'list', 'get', 'answer'],
  db: ['status', 'restore'],
  ownership: ['check', 'list'],
};

type StrictOptionSpec = {
  values: readonly string[];
  booleans?: readonly string[];
  positionals: number;
};

const PM_OPTION_SPECS: Record<string, StrictOptionSpec> = {
  start: { values: ['consumer', 'interval', 'plans'], booleans: ['once'], positionals: 0 },
  intake: { values: ['consumer', 'plan', 'project'], booleans: ['json'], positionals: 0 },
  unacked: { values: ['consumer', 'type', 'limit', 'plan'], booleans: ['json'], positionals: 0 },
  ack: { values: ['consumer', 'event-id', 'plan'], positionals: 0 },
  watch: { values: ['consumer', 'interval'], booleans: ['once'], positionals: 0 },
};

const QUESTION_OPTION_SPECS: Record<string, StrictOptionSpec> = {
  ask: {
    values: ['task', 'claim-token', 'body', 'checkpoint', 'agent-id'],
    booleans: ['json'],
    positionals: 0,
  },
  list: { values: ['consumer', 'status', 'plan'], booleans: ['json'], positionals: 0 },
  get: { values: ['consumer', 'plan'], booleans: ['json'], positionals: 1 },
  answer: { values: ['consumer', 'plan', 'answer'], booleans: ['json'], positionals: 1 },
};

const SUPERSEDE_OPTION_SPECS: Record<'task' | 'plan', StrictOptionSpec> = {
  task: { values: ['reason', 'by'], booleans: ['yes', 'json'], positionals: 1 },
  plan: { values: ['reason', 'by', 'preview-token'], booleans: ['yes', 'preview', 'json'], positionals: 1 },
};

const TASK_RESOLUTION_OPTION_SPEC: StrictOptionSpec = {
  values: ['action', 'decided-by'],
  booleans: ['json'],
  positionals: 1,
};

const DB_OPTION_SPECS: Record<'status' | 'restore', StrictOptionSpec> = {
  status: { values: [], positionals: 0 },
  restore: { values: [], booleans: ['yes'], positionals: 0 },
};

const DB_RESTORE_SAFETY_NOTICE =
  '仅用于 Biao Redis namespace 空的灾难恢复；先停止 Supervisor/Worker，并检查 biao db status。';

const LEAF_COMMAND_USAGE: Record<string, string> = {
  serve: 'biao serve [--port 7331] [--redis-url redis://localhost:6379]',
  health: 'biao health',
  status: 'biao status',
  version: 'biao version [--json]',
  '--version': 'biao version [--json]',
  '-V': 'biao version [--json]',
  review: 'biao review <task_id> [--accept | --reject] [--reverify-only] [选项]',
  events: 'biao events [--since 5m|1h|2026-08-11] [--limit 50] [--json]',
  conflicts: 'biao conflicts [--limit 20] [--json]',
  watchdog: 'biao watchdog [--auto-fix] [--interval <seconds>] [--json]',
};

const COMMANDS_WITH_DETAILED_HELP = new Set([
  'pm:start',
  'plan:intake',
  'plan:revise',
  'task:add',
  'task:edit',
  'task:reset',
  'task:resolution',
  'task:supersede',
  'plan:supersede',
  'db:restore',
]);

function isHelpToken(value: string | undefined): boolean {
  return value !== undefined && HELP_TOKENS.has(value);
}

/**
 * Agent-facing commands must reject typos before any HTTP request. String option values are
 * consumed verbatim, including values beginning with '-' (for example negative numbers or a
 * Question body beginning with '--'), so strict routing does not reinterpret user content.
 */
function validateStrictOptions(
  command: string,
  args: string[],
  spec: StrictOptionSpec,
): { helpRequested: boolean } | undefined {
  const valueOptions = new Set(spec.values);
  const booleanOptions = new Set(spec.booleans ?? []);
  const seen = new Set<string>();
  let positionals = 0;
  let helpRequested = false;

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (isHelpToken(token)) {
      helpRequested = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals++;
      if (positionals > spec.positionals) {
        console.error(`多余参数：${token}（${command}）`);
        process.exitCode = 1;
        return undefined;
      }
      continue;
    }

    const name = token.slice(2);
    if (!valueOptions.has(name) && !booleanOptions.has(name)) {
      console.error(`未知参数：${token}`);
      process.exitCode = 1;
      return undefined;
    }
    if (seen.has(name)) {
      console.error(`重复参数：${token}`);
      process.exitCode = 1;
      return undefined;
    }
    seen.add(name);

    if (valueOptions.has(name)) {
      if (index + 1 >= args.length) {
        console.error(`参数缺少值：${token}`);
        process.exitCode = 1;
        return undefined;
      }
      index++;
    }
  }
  return { helpRequested };
}

function printCommandGroupHelp(group: string): void {
  if (group === 'pm') {
    printPmHelp();
    return;
  }
  if (group === 'question') {
    printQuestionHelp();
    return;
  }
  const commands = COMMAND_GROUPS[group];
  console.log(`用法：biao ${group} <${commands.join('|')}> [选项]\n\n运行 biao --help 查看完整命令与示例。`);
}

function printLeafCommandHelp(cmd: string): void {
  console.log(`用法：${LEAF_COMMAND_USAGE[cmd]}\n\n运行 biao --help 查看完整命令与示例。`);
}

function printDbRestoreHelp(): void {
  console.log(`用法：biao db restore --yes

${DB_RESTORE_SAFETY_NOTICE}

安全门槛：
  - 必须显式传入 --yes；不存在绕过检查的 force 模式。
  - 非空目标、活跃 running、lease 或 ownership 都会被服务端拒绝。
  - 操作前先停止所有 Supervisor/Worker，并用 biao db status 核对 SQLite 备份。

恢复语义：
  - SQLite 中历史 running 不会恢复旧执行现场，而会成为 fresh pending，等待重新领取。
  - 旧 lease、ownership 和 claim token 不会复用；旧 claim token 失效。
  - 恢复完成后先重新核对 Biao 状态，再启动共享 Supervisor/Worker。`);
}

function printTaskResolutionHelp(): void {
  console.log(`用法：biao task resolution <task_id> [--action inspect|continue|cancel] [--decided-by <pm>] [--json]

处理自动 repair/reverify 达到 max_retries 后的 needs_pm_decision：
  inspect    只读根因、最新 repair、完整 lineage 与可用动作；默认动作。
  continue   明确额外放行一代 repair/reverify；失败后不会无限续跑。
  cancel     终止该修复闭环并保留全部失败/拒绝审计；计划显示 cancelled，不伪装 completed。

--decided-by 仅用于 continue/cancel；默认使用 BIAO_AGENT_ID（未配置时为 pm）。
inspect 不写决策，也不接受 --decided-by。`);
}

/**
 * 在执行任何 API 调用前拒绝未知命令。过去的 fallthrough 会打印总帮助并以 0
 * 退出，使 `biao questions` / `biao reply` 这类旧命令在只检查退出码的脚本中假绿。
 */
function rejectUnknownCommand(cmd: string | undefined, sub: string | undefined): boolean {
  if (!cmd || isHelpToken(cmd)) return false;
  if (!TOP_LEVEL_COMMANDS.has(cmd)) {
    console.error(`未知命令：${cmd}`);
    console.error('运行 biao --help 查看可用命令。');
    process.exitCode = 1;
    return true;
  }

  const commands = COMMAND_GROUPS[cmd];
  if (commands && sub && !isHelpToken(sub) && !commands.includes(sub)) {
    console.error(`未知子命令：biao ${cmd} ${sub}`);
    console.error(`运行 biao ${cmd} --help 查看可用子命令。`);
    process.exitCode = 1;
    return true;
  }
  return false;
}

async function main() {
  const [cmd, sub] = process.argv.slice(2, 4);
  const rest = process.argv.slice(4);

  if (rejectUnknownCommand(cmd, sub)) return;
  if (cmd && COMMAND_GROUPS[cmd] && isHelpToken(sub)) {
    printCommandGroupHelp(cmd);
    return;
  }
  if (cmd && LEAF_COMMAND_USAGE[cmd] && isHelpToken(sub)) {
    printLeafCommandHelp(cmd);
    return;
  }
  if (
    cmd && sub && COMMAND_GROUPS[cmd]?.includes(sub) && rest.some(isHelpToken) &&
    cmd !== 'pm' && cmd !== 'question' &&
    !COMMANDS_WITH_DETAILED_HELP.has(`${cmd}:${sub}`)
  ) {
    printCommandGroupHelp(cmd);
    return;
  }

  if (cmd === 'serve') {
    await startServer();
    return; // 不退出
  }

  if (cmd === 'health') {
    const r = await api('/health');
    printJson(r);
    return;
  }

  if (cmd === 'pm') {
    // biao pm intake|unacked|ack|watch —— PM 主动轮询（平台保持被动）
    // intake: 一次性门铃，汇总待签核/acceptance_ready/失败阻塞/stale，按 consumer 路由
    const consumerFlag = (args: string[]): string => {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--consumer' && args[i + 1]) return args[i + 1];
      }
      return process.env.BIAO_PM_CONSUMER ?? 'pm';
    };
    const wantsJson = (args: string[]): boolean => args.includes('--json');
    const flagVal = (args: string[], name: string): string | undefined => {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === `--${name}` && args[i + 1]) return args[i + 1];
      }
      return undefined;
    };

    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
      printPmHelp();
      return;
    }

    const optionSpec = PM_OPTION_SPECS[sub];
    const parsedOptions = optionSpec
      ? validateStrictOptions(`biao pm ${sub}`, rest, optionSpec)
      : undefined;
    if (!parsedOptions) return;
    if (parsedOptions.helpRequested && sub !== 'start') {
      printPmHelp();
      return;
    }

    if (sub === 'start') {
      // PM 的单一可操作入口：先读最小状态，再交给本机 Supervisor 做一次或常驻共享等待。
      // 这里不调用 ack/review；门铃、验收与确认仍必须由 PM 显式完成。
      const args = rest;
      if (parsedOptions.helpRequested) {
        console.log(`用法：biao pm start [--consumer <pm>] [--once] [--interval <seconds>] [--plans <p1,p2>]

统一 PM 入口：先检查 health/status/intake，再启动本机共享 Supervisor。
  --once                 只运行一轮后退出，适合 cron、launchd 或 PM 会话开场。
  --interval <seconds>   常驻模式的低频共享检查间隔，默认 60。
  --plans <p1,p2>        只监视指定计划。

本命令只读门铃和状态，不自动 ack/验收；PM 必须完成处理后显式执行 biao pm ack。`);
        console.log(`
收到 question_asked 时：
  biao question list --consumer <pm> --status open --plan <id>
  biao question get <question_id> --consumer <pm> --plan <id>
  biao question answer <question_id> --consumer <pm> --plan <id> --answer "明确答复"
答复后再 ack 对应事件；Worker 将用新的 claim token 重新领取。`);
        return;
      }
      const consumer = consumerFlag(args);
      const once = args.includes('--once');
      const plans = flagVal(args, 'plans');
      const managedPlanIds = plans?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
      if (plans !== undefined) {
        if (managedPlanIds.length === 0 || managedPlanIds.some((planId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(planId))) {
          console.error('✗ --plans 必须是逗号分隔的合法 plan id');
          process.exitCode = 1;
          return;
        }
        if (new Set(managedPlanIds).size !== managedPlanIds.length) {
          console.error('✗ --plans 不能包含重复 plan id');
          process.exitCode = 1;
          return;
        }
      }
      type PmStartupStatus = {
        tasks?: { pending?: number; running?: number; blocked?: number; done?: number; failed?: number; cancelled?: number; superseded?: number };
        reviews?: { pending?: number; accepted?: number; rejected?: number };
        agents?: Array<{ agent_id?: string; status?: string }>;
        hint?: { code?: string; doctor?: string; start_worker?: string } | null;
      };
      type PmStartupIntake = {
        consumer?: string;
        cursor?: string;
        counts?: Record<string, number>;
        items?: Array<{ kind?: string; event_id?: string; task_id?: string; plan_id?: string; agent_id?: string }>;
      };

      let health: unknown;
      let status: { ok?: boolean; data?: PmStartupStatus; error?: { message?: string } };
      let intake: { ok?: boolean; data?: PmStartupIntake; error?: { message?: string } };
      try {
        if (managedPlanIds.length === 0) {
          [health, status, intake] = await Promise.all([
            api('/health'),
            api('/status') as Promise<{ ok?: boolean; data?: PmStartupStatus; error?: { message?: string } }>,
            api(`/intake?consumer=${encodeURIComponent(consumer)}`) as Promise<{ ok?: boolean; data?: PmStartupIntake; error?: { message?: string } }>,
          ]);
        } else {
          type PlanStatusResponse = {
            ok?: boolean;
            data?: {
              plan_id?: string;
              tasks?: Record<string, unknown[] | number | undefined>;
              reviews?: { pending?: number; accepted?: number; rejected?: number };
            } | null;
            error?: { message?: string };
          };
          const [healthResult, planResults, intakeResults] = await Promise.all([
            api('/health'),
            Promise.all(managedPlanIds.map((planId) => (
              api(`/plan/${encodeURIComponent(planId)}`) as Promise<PlanStatusResponse>
            ))),
            Promise.all(managedPlanIds.map((planId) => (
              api(`/intake?consumer=${encodeURIComponent(consumer)}&plan_id=${encodeURIComponent(planId)}`) as Promise<{ ok?: boolean; data?: PmStartupIntake; error?: { message?: string } }>
            ))),
          ]);
          health = healthResult;
          const missingPlanIndex = planResults.findIndex((result) => !result.ok || !result.data?.plan_id);
          if (missingPlanIndex >= 0) {
            status = { ok: false, error: { message: planResults[missingPlanIndex].error?.message ?? `受管 plan 不存在：${managedPlanIds[missingPlanIndex]}` } };
            intake = { ok: false, error: { message: '受管 plan 状态不可用，未合并 intake' } };
          } else {
            const countBucket = (value: unknown[] | number | undefined): number => (
              Array.isArray(value) ? value.length : Number(value ?? 0)
            );
            const taskTotals: Record<string, number> = {
              pending: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0, superseded: 0,
            };
            const reviewTotals = { pending: 0, accepted: 0, rejected: 0 };
            for (const result of planResults) {
              for (const key of Object.keys(taskTotals)) {
                taskTotals[key] += countBucket(result.data?.tasks?.[key]);
              }
              reviewTotals.pending += Number(result.data?.reviews?.pending ?? 0);
              reviewTotals.accepted += Number(result.data?.reviews?.accepted ?? 0);
              reviewTotals.rejected += Number(result.data?.reviews?.rejected ?? 0);
            }
            status = { ok: true, data: { tasks: taskTotals, reviews: reviewTotals } };
            const failedIntakeIndex = intakeResults.findIndex((result) => !result.ok || !result.data);
            if (failedIntakeIndex >= 0) {
              intake = { ok: false, error: { message: intakeResults[failedIntakeIndex].error?.message ?? `受管 plan intake 失败：${managedPlanIds[failedIntakeIndex]}` } };
            } else {
              const counts: Record<string, number> = {};
              const items: NonNullable<PmStartupIntake['items']> = [];
              for (const result of intakeResults) {
                for (const [kind, count] of Object.entries(result.data?.counts ?? {})) {
                  counts[kind] = (counts[kind] ?? 0) + Number(count);
                }
                items.push(...(result.data?.items ?? []));
              }
              intake = {
                ok: true,
                data: {
                  consumer,
                  cursor: intakeResults.at(-1)?.data?.cursor ?? '0-0',
                  counts,
                  items,
                },
              };
            }
          }
        }
      } catch (error) {
        console.error(`✗ PM 启动前检查失败：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      if (!isApiSuccess(health) || !status.ok || !status.data || !intake.ok || !intake.data) {
        console.error(`✗ PM 启动前检查失败：${status.error?.message ?? intake.error?.message ?? '服务未就绪'}`);
        process.exitCode = 1;
        return;
      }

      const statusData = status.data;
      const intakeData = intake.data;
      const reviewPending = Number(statusData.reviews?.pending ?? 0);
      const runnablePending = Number(statusData.tasks?.pending ?? 0);
      const onlineWorkers = managedPlanIds.length > 0
        ? null
        : (statusData.agents ?? []).filter((agent) => (
            agent.status === 'idle' || agent.status === 'busy' || agent.status === 'online'
          )).length;
      const doorbellItems = intakeData.items ?? [];
      const reviewDoorbells = Number(intakeData.counts?.review_requested ?? doorbellItems.filter((item) => item.kind === 'review_requested').length);
      const doorbellKinds = Object.entries(intakeData.counts ?? {})
        .filter(([, count]) => Number(count) > 0)
        .map(([kind, count]) => `${kind}=${count}`);

      console.log(`Biao PM 已连接：服务健康（consumer=${intakeData.consumer ?? consumer}）`);
      if (reviewPending > 0) {
        const historical = reviewDoorbells === 0 ? '；历史待验收（当前没有对应未确认门铃）' : `；门铃 ${reviewDoorbells} 项`;
        console.log(`待 PM 验收：${reviewPending} 项${historical}`);
        console.log('  下一步：biao review list，然后逐项 biao review <task_id>；不会自动验收或确认。');
      }
      if (runnablePending > 0) {
        console.log(onlineWorkers === null
          ? `待执行：${runnablePending} 项（受管 Plan 范围）`
          : `待执行：${runnablePending} 项；在线 Worker：${onlineWorkers}`);
      }
      if (onlineWorkers === 0 && (runnablePending > 0 || statusData.hint?.code === 'NO_ONLINE_WORKERS')) {
        console.log(`暂无在线 Worker。先执行 ${statusData.hint?.doctor ?? '.biao/doctor'}，再启动 ${statusData.hint?.start_worker ?? '.biao/worker-codex、.biao/worker-kimi 或 .biao/worker-custom'}。`);
      }
      if (doorbellKinds.length > 0) {
        console.log(`最小 PM 门铃：${doorbellKinds.join('，')}（仅提醒，未 ack）。`);
      } else {
        console.log('最小 PM 门铃：无新事项（未 ack 的历史验收仍需按上方入口处理）。');
      }
      if (Number(intakeData.counts?.question_asked ?? 0) > 0) {
        console.log('Worker 有待答问题：依次执行 biao question list、get、answer；实际答复后再 ack 对应 question_asked 事件。');
      }

      const supervisorArgs = [
        fileURLToPath(new URL('../../scripts/supervisor.mjs', import.meta.url)),
        '--biao-url', BIAO_URL,
        '--consumer', consumer,
      ];
      const interval = flagVal(args, 'interval');
      if (interval) supervisorArgs.push('--interval', interval);
      if (plans) supervisorArgs.push('--plans', plans);
      if (once) supervisorArgs.push('--once');
      console.log(once
        ? '一次性运行 PM Supervisor（只读门铃，绝不自动 ack/验收）...'
        : '启动 PM Supervisor 低频监视（只读门铃，绝不自动 ack/验收）...');
      const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        const child = spawn(process.execPath, supervisorArgs, { stdio: 'inherit', env: process.env });
        child.once('error', rejectExit);
        child.once('close', (code) => resolveExit(code ?? 1));
      }).catch((error) => {
        console.error(`✗ Supervisor 启动失败：${error instanceof Error ? error.message : String(error)}`);
        return 1;
      });
      if (exitCode !== 0 && exitCode !== 2) process.exitCode = exitCode;
      return;
    }

    if (sub === 'intake') {
      const args = rest;
      const params = new URLSearchParams();
      const consumer = consumerFlag(args);
      params.set('consumer', consumer);
      const plan = flagVal(args, 'plan');
      const project = flagVal(args, 'project');
      if (plan) params.set('plan_id', plan);
      if (project) params.set('project_path', project);
      const r = (await api(`/intake?${params.toString()}`)) as {
        ok: boolean;
        data?: { consumer: string; cursor: string; counts: Record<string, number>; items: Array<Record<string, unknown>> };
        error?: { code: string; message: string };
      };
      if (wantsJson(args)) {
        // --json：稳定最小字段
        if (r.ok && r.data) {
          console.log(JSON.stringify({
            ok: true,
            data: {
              consumer: r.data.consumer,
              cursor: r.data.cursor,
              counts: r.data.counts,
              items: r.data.items.map((i) => ({
                kind: i.kind,
                plan_id: i.plan_id,
                task_id: i.task_id,
                question_id: i.question_id,
                agent_id: i.agent_id,
                event_id: i.event_id,
                timestamp: i.timestamp,
              })),
            },
          }));
          // 退出码：有事项 → 0，无事项 → 2（脚本可判断）
          process.exitCode = r.data.items.length > 0 ? 0 : 2;
        } else {
          printJson(r); // 错误：退出码 1
        }
        return;
      }
      if (!r.ok || !r.data) {
        console.error(`✗ intake 查询失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      const { items, counts } = r.data;
      const total = items.length;
      if (total === 0) {
        console.log('（无待处理事项）');
        process.exitCode = 2; // 无事项退出码 2
        return;
      }
      console.log(`PM intake（consumer=${r.data.consumer}）共 ${total} 项：\n`);
      const grouped: Record<string, typeof items> = {};
      for (const it of items) (grouped[it.kind as string] ??= []).push(it);
      for (const [kind, list] of Object.entries(grouped)) {
        console.log(`[${kind}] (${counts[kind] ?? list.length})`);
        for (const it of list) {
          const id = (it.task_id ?? it.agent_id ?? it.event_id) as string;
          console.log(`  - ${id}${it.plan_id ? ` (plan=${it.plan_id})` : ''}`);
        }
        console.log('');
      }
      if (grouped.question_asked?.length) {
        console.log('发现 Worker 提问：按当前 plan 执行 question list → get → answer；复制 get/answer 返回的精确 asked_event_id 再 ack。\n');
      }
      console.log(`游标：${r.data.cursor}（任务详情用 biao task get / biao review / biao task list 获取）`);
      return;
    }

    if (sub === 'unacked') {
      const args = rest;
      const params = new URLSearchParams();
      params.set('consumer', consumerFlag(args));
      const type = flagVal(args, 'type');
      if (type) params.set('type', type);
      const limit = flagVal(args, 'limit');
      if (limit) params.set('limit', limit);
      const plan = flagVal(args, 'plan');
      if (plan) params.set('plan_id', plan);
      const r = (await api(`/intake/unacked?${params.toString()}`)) as {
        ok: boolean;
        data?: Array<Record<string, unknown>>;
        error?: { code: string; message: string };
      };
      if (wantsJson(args) || true) {
        // unacked 始终输出 JSON（脚本消费）
        if (r.ok) {
          console.log(JSON.stringify({ ok: true, data: r.data }));
        } else {
          printJson(r);
        }
      }
      return;
    }

    if (sub === 'ack') {
      const args = rest;
      const eventId = flagVal(args, 'event-id');
      const consumer = consumerFlag(args);
      const plan = flagVal(args, 'plan');
      if (!eventId) {
        console.error('用法：biao pm ack --consumer <pm> --event-id <id>');
        process.exit(1);
      }
      const r = (await api('/intake/ack', {
        method: 'POST',
        body: JSON.stringify({ consumer, event_id: eventId, ...(plan ? { plan_id: plan } : {}) }),
      })) as { ok: boolean; data?: { event_id: string; already_acked: boolean }; error?: { message: string } };
      if (r.ok) {
        console.log(`✓ 已确认事件 ${r.data?.event_id}${r.data?.already_acked ? '（已是确认状态，幂等）' : ''}`);
      } else {
        console.error(`✗ ack 失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      return;
    }

    if (sub === 'watch') {
      // biao pm watch [--consumer pm] [--interval 60] [--once]
      // 低频主动轮询模式：由 PM 侧按间隔调用 intake，处理后 ack。
      // 平台保持被动，本命令只在本机轮询，不由 Biao 服务启动。
      const args = rest;
      const consumer = consumerFlag(args);
      const once = args.includes('--once');
      const intervalSec = Number(flagVal(args, 'interval') ?? '60');
      const pollOnce = async (): Promise<number> => {
        const r = (await api(`/intake?consumer=${encodeURIComponent(consumer)}`)) as {
          ok: boolean;
          data?: { items: Array<Record<string, unknown>>; cursor: string };
          error?: { message: string };
        };
        if (!r.ok || !r.data) {
          console.error(`✗ watch 轮询失败：${r.error?.message ?? '未知错误'}（将退避重试）`);
          return -1;
        }
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        if (r.data.items.length === 0) return 0;
        console.log(`[${ts}] 发现 ${r.data.items.length} 项待处理（cursor=${r.data.cursor}）`);
        for (const it of r.data.items) {
          const id = (it.task_id ?? it.agent_id ?? it.event_id) as string;
          console.log(`  [${it.kind}] ${id}${it.plan_id ? ` (plan=${it.plan_id})` : ''}`);
        }
        // watch 仅作为最小门铃：打印不等于 PM 已处理。
        // 必须由 PM 在读取详情、完成验收/答复等处理后，显式执行
        // `biao pm ack --consumer <consumer> --event-id <event_id>`。
        // 这里绝不能自动 ack，否则一次提示失败就会永久吞掉待办事件。
        return r.data.items.length;
      };
      if (once) {
        const n = await pollOnce();
        process.exitCode = n > 0 ? 0 : n === 0 ? 2 : 1;
        return;
      }
      // 常驻低频轮询（Ctrl-C 退出）。默认 60s，禁止忙循环。
      const intervalMs = Math.max(10_000, intervalSec * 1000);
      console.log(`[biao] PM watch 模式：每 ${Math.round(intervalMs / 1000)}s 轮询一次（Ctrl-C 退出）`);
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      let backoff = intervalMs;
      try {
        while (!shutdown.signal.aborted) {
          const n = await pollOnce();
          // 退避：失败时指数增长（上限 5*interval），成功恢复
          if (n === -1) {
            backoff = Math.min(backoff * 2, intervalMs * 5);
          } else {
            backoff = intervalMs;
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, backoff);
            shutdown.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      return;
    }

    // pm 未知子命令
    console.error('用法：biao pm start [--consumer pm] [--once] [--interval 60] [--plans p1,p2] | intake|unacked|ack|watch [--consumer pm] [--json] [--plan <id>]');
    process.exit(1);
  }

  if (cmd === 'status') {
    const r = await api('/status');
    printJson(r);
    return;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-V') {
    const args = [sub, ...rest].filter((value): value is string => Boolean(value));
    const r = (await api('/version')) as { ok?: boolean; data?: { name?: string; version?: string } };
    if (args.includes('--json')) {
      printJson(r);
    } else if (isApiSuccess(r) && r.data?.version) {
      console.log(`${r.data.name ?? 'biao'} ${r.data.version}`);
    } else {
      printJson(r);
    }
    return;
  }

  if (cmd === 'plan' && sub === 'supersede') {
    const parsed = validateStrictOptions('biao plan supersede', rest, SUPERSEDE_OPTION_SPECS.plan);
    if (!parsed) return;
    if (parsed.helpRequested) {
      console.log(`用法：
  biao plan supersede <plan_id> --preview [--json]
  biao plan supersede <plan_id> --reason "历史退出原因" --preview-token <token> --yes [--by <pm>] [--json]

先预览候选、依赖阻塞和快照 token；应用时必须显式提供同一 token、原因与 --yes。
状态变化会拒绝应用并要求重新预览；不会静默级联取消或部分执行。`);
      return;
    }
    const planId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
    const flags: Record<string, string> = {};
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index];
      if (token === '--yes' || token === '--preview' || token === '--json') {
        flags[token.slice(2)] = 'true';
      } else if (token.startsWith('--')) {
        flags[token.slice(2)] = rest[++index];
      }
    }
    if (!planId) {
      console.error('用法：biao plan supersede <plan_id> --preview，或带 --reason/--preview-token/--yes 应用');
      process.exitCode = 1;
      return;
    }
    if (flags.preview) {
      if (flags.yes || flags.reason || flags['preview-token'] || flags.by) {
        console.error('✗ --preview 是只读操作，不能与 --yes、--reason、--by 或 --preview-token 同时使用');
        process.exitCode = 1;
        return;
      }
      const r = await api(`/plan/${encodeURIComponent(planId)}/supersede-preview`);
      if (flags.json) {
        printJson(r);
      } else if (isApiSuccess(r)) {
        const data = (r as { data: { candidate_task_ids: string[]; blockers: Array<{ task_id: string; code: string; detail: string }>; preview_token: string } }).data;
        console.log(`Plan ${planId} supersede 预览：候选 ${data.candidate_task_ids.length}，阻塞 ${data.blockers.length}`);
        for (const taskId of data.candidate_task_ids) console.log(`  - 候选：${taskId}`);
        for (const blocker of data.blockers) console.log(`  - 阻塞：${blocker.task_id} [${blocker.code}] ${blocker.detail}`);
        console.log(`preview_token: ${data.preview_token}`);
        console.log('应用时必须复制该 token，并同时提供 --reason 与 --yes。');
      } else {
        printJson(r);
      }
      return;
    }
    if (!flags.reason || !flags['preview-token'] || !flags.yes) {
      console.error('✗ Plan supersede 必须先 --preview，再显式提供 --reason、--preview-token 与 --yes');
      process.exitCode = 1;
      return;
    }
    const r = await api(`/plan/${encodeURIComponent(planId)}/supersede`, {
      method: 'POST',
      body: JSON.stringify({
        reason: flags.reason,
        superseded_by: flags.by ?? process.env.BIAO_AGENT_ID ?? 'pm',
        confirmed: true,
        preview_token: flags['preview-token'],
      }),
    });
    if (flags.json) {
      printJson(r);
    } else if (isApiSuccess(r)) {
      const data = (r as { data: { superseded_task_ids: string[]; status: string } }).data;
      console.log(`✓ Plan ${planId} 已将 ${data.superseded_task_ids.length} 个历史待验收任务置为 superseded（plan: ${data.status}）`);
    } else {
      printJson(r);
    }
    return;
  }

  if (cmd === 'plan' && sub === 'init') {
    // 本地生成 plan 骨架（不调 API）
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');

    const planId = rest[0];
    if (!planId) {
      console.error('用法：biao plan init <plan-id> [--project <path>] [--dir <plans/>]');
      console.error('  生成 index.md + tasks/ + 示例 task');
      process.exit(1);
    }

    // 解析 flags
    const flags: Record<string, string> = {};
    for (let i = 1; i < rest.length; i++) {
      if (rest[i].startsWith('--') && rest[i + 1]) {
        flags[rest[i].slice(2)] = rest[++i];
      }
    }
    const projectPath = flags.project ?? process.cwd();
    const baseDir = flags.dir ?? 'plans';
    const planDir = resolve(join(baseDir, planId));

    if (existsSync(planDir)) {
      console.error(`已存在：${planDir}（请先用其他 plan-id，或删除后重试）`);
      process.exit(1);
    }

    mkdirSync(join(planDir, 'tasks'), { recursive: true });

    // index.md
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(planDir, 'index.md'),
      `---
plan_id: ${planId}
title: ${planId}
status: draft
created_at: ${today}
project_path: ${projectPath}
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
    description: 实现阶段
  - id: qa
    name: 验收
    description: 验收阶段
    depends_on: [impl]
global_constraints:
  - 不修改 secrets / .env
---

# ${planId}

## 背景与目标

<描述这个 plan 要达成什么>

## 任务清单

| task_id | 标题 | phase | assignee | depends_on | ownership | priority |
|---------|------|-------|----------|-----------|-----------|----------|
| ${planId}-01-impl | 实现任务 | impl | auto | — | src/** | 5 |
| ${planId}-02-qa | 验收 | qa | auto | [01-impl] | — | 7 |
`,
    );

    // 示例 task
    writeFileSync(
      join(planDir, `tasks/${planId}-01-impl.md`),
      `---
task_id: ${planId}-01-impl
title: 实现任务
type: code
phase: impl
assignee: auto
ownership:
  files:
    - src/**
priority: 5
timeout_seconds: 1800
verify: []
---

# 实现任务

## Objective

<描述任务目标>

## Required Work

1. ...

## Acceptance Criteria

- [ ] 实现符合目标
`,
    );

    writeFileSync(
      join(planDir, `tasks/${planId}-02-qa.md`),
      `---
task_id: ${planId}-02-qa
title: 验收
type: acceptance
phase: qa
depends_on:
  - ${planId}-01-impl
assignee: auto
priority: 7
acceptance_for:
  - ${planId}-01-impl
verify: []
---

# 验收

## Objective

验收实现任务。
`,
    );

    console.log(`✓ 已创建 plan 骨架：${planDir}`);
    console.log(`  ${planDir}/index.md`);
    console.log(`  ${planDir}/tasks/${planId}-01-impl.md`);
    console.log(`  ${planDir}/tasks/${planId}-02-qa.md`);
    console.log(``);
    console.log(`下一步：编辑这些 MD，然后提交：`);
    console.log(`  biao plan submit ${planDir}`);
    return;
  }

  if (cmd === 'plan' && sub === 'create') {
    // 通过 API 创建（server 端生成骨架 + 提交）
    const planId = rest[0];
    if (!planId) {
      console.error('用法：biao plan create <plan-id> --project <path> [--title <标题>] [--no-submit]');
      process.exit(1);
    }
    const flags: Record<string, string> = {};
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--no-submit') {
        flags.submit = 'false';
      } else if (rest[i].startsWith('--') && rest[i + 1]) {
        flags[rest[i].slice(2)] = rest[++i];
      }
    }
    const body: Record<string, unknown> = {
      plan_id: planId,
      project_path: flags.project ?? process.cwd(),
    };
    if (flags.title) body.title = flags.title;
    if (flags.submit === 'false') body.submit = false;
    if (flags['pm-consumer']) body.pm_consumer = flags['pm-consumer'];
    else if (process.env.BIAO_PM_CONSUMER) body.pm_consumer = process.env.BIAO_PM_CONSUMER;

    const r = await api('/plan/create', { method: 'POST', body: JSON.stringify(body) });
    printJson(r);
    return;
  }

  if (cmd === 'plan' && sub === 'submit') {
    const planDir = rest[0];
    if (!planDir) {
      console.error('用法：biao plan submit <plan_dir>');
      process.exit(1);
    }
    const r = await api('/plan/submit', { method: 'POST', body: JSON.stringify({ plan_dir: planDir }) });
    printJson(r);
    return;
  }

  if (cmd === 'plan' && sub === 'list') {
    // biao plan list [--json]
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') {
        flags.json = 'true';
      } else if (rest[i].startsWith('--') && rest[i + 1]) {
        flags[rest[i].slice(2)] = rest[++i];
      }
    }
    const r = (await api('/plans')) as {
      ok: boolean;
      data: {
        plans: Array<{
          plan_id: string;
          title: string;
          status: string;
          project_path: string;
          task_count: number;
          tasks: {
            pending: number; running: number; blocked: number; done: number;
            failed: number; cancelled: number; superseded: number;
          };
        }>;
        total: number;
      };
    };
    if (flags.json) {
      printJson(r);
      return;
    }
    if (!r.ok || !r.data) {
      console.error('✗ plan 列表查询失败');
      process.exitCode = 1;
      return;
    }
    if (r.data.plans.length === 0) {
      console.log('暂无 plan，用 `biao plan create <id> --project <path>` 创建');
      return;
    }
    console.log('PLAN_ID                       TITLE                         STATUS     TASKS (P/R/B/D/F/C/S)   PROJECT');
    console.log('─'.repeat(136));
    for (const p of r.data.plans) {
      const t = p.tasks;
      const counts = `${t.pending}/${t.running}/${t.blocked ?? 0}/${t.done}/${t.failed}/${t.cancelled ?? 0}/${t.superseded ?? 0}`;
      console.log(
        `${p.plan_id.padEnd(30)}${p.title.padEnd(30)}${p.status.padEnd(11)}${counts.padEnd(22)}${p.project_path}`,
      );
    }
    return;
  }

  if (cmd === 'plan' && sub === 'status') {
    const planId = rest[0];
    if (!planId) {
      console.error('用法：biao plan status <plan_id>');
      process.exit(1);
    }
    const r = await api(`/plan/${planId}`);
    printJson(r);
    return;
  }

  if (cmd === 'plan' && sub === 'revise') {
    await runPlanRevise(rest, api);
    return;
  }

  if (cmd === 'plan' && sub === 'intake') {
    await runPlanIntake(rest, api);
    return;
  }

  if (cmd === 'question') {
    // Worker → PM 受控通讯。事件流只发最小门铃；正文只能由归属 PM 主动读取。
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
      printQuestionHelp();
      return;
    }
    const optionSpec = QUESTION_OPTION_SPECS[sub];
    const parsedOptions = optionSpec
      ? validateStrictOptions(`biao question ${sub}`, rest, optionSpec)
      : undefined;
    if (!parsedOptions) return;
    if (parsedOptions.helpRequested) {
      printQuestionLeafHelp(sub);
      return;
    }
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') {
        flags.json = 'true';
      } else if (rest[i].startsWith('--') && rest[i + 1]) {
        flags[rest[i].slice(2).replace(/-/g, '_')] = rest[++i];
      }
    }
    const consumer = flags.consumer ?? process.env.BIAO_PM_CONSUMER ?? 'pm';

    if (sub === 'ask') {
      const taskId = flags.task;
      const claimToken = flags.claim_token;
      const body = flags.body;
      if (!taskId || !claimToken || !body || !flags.agent_id) {
        console.error('用法：biao question ask --task <task_id> --claim-token <token> --agent-id <current-worker-id> --body "问题" [--checkpoint "进度"] [--json]');
        process.exit(1);
      }
      const r = await api('/question', {
        method: 'POST',
        body: JSON.stringify({
          task_id: taskId,
          agent_id: flags.agent_id,
          claim_token: claimToken,
          body,
          ...(flags.checkpoint ? { checkpoint: flags.checkpoint } : {}),
        }),
      });
      if (flags.json) {
        printJson(r);
      } else if (isApiSuccess(r)) {
        const data = (r as { data?: { question_id?: string; task_id?: string; pm_consumer?: string; asked_event_id?: string } }).data;
        console.log(`✓ 已通过平台向 PM 提问：${data?.question_id ?? ''}`);
        console.log(`  task 已进入等待 PM 答复；对应 PM consumer=${data?.pm_consumer ?? consumer}`);
        console.log('  当前 claim/ownership 已释放，旧 claim token 已失效；等待新的领取，不要继续 report 或询问人类。');
        if (data?.asked_event_id) console.log(`  question_asked event=${data.asked_event_id}`);
      } else {
        printJson(r);
      }
      return;
    }

    if (sub === 'list') {
      const params = new URLSearchParams({ consumer });
      if (flags.status) params.set('status', flags.status);
      if (flags.plan) params.set('plan_id', flags.plan);
      const r = await api(`/questions?${params.toString()}`);
      if (flags.json) {
        printJson(r);
        return;
      }
      if (!isApiSuccess(r)) {
        printJson(r);
        return;
      }
      const data = (r as { data?: Array<{ question_id: string; task_id: string; plan_id: string; status: string; created_at: number }> }).data ?? [];
      if (data.length === 0) {
        console.log('（无匹配 Question）');
        return;
      }
      console.log(`PM Question（consumer=${consumer}）共 ${data.length} 项：`);
      for (const q of data) {
        console.log(`  [${q.status}] ${q.question_id}  task=${q.task_id}  plan=${q.plan_id}`);
      }
      console.log('下一步：保留同一 --consumer/--plan 执行 question get，再执行 question answer；成功后复制精确 ack 命令。');
      return;
    }

    if (sub === 'get') {
      const questionId = rest[0];
      if (!questionId) {
        console.error('用法：biao question get <question_id> [--consumer <pm>] [--plan <id>] [--json]');
        process.exit(1);
      }
      const params = new URLSearchParams({ consumer });
      if (flags.plan) params.set('plan_id', flags.plan);
      const r = await api(`/question/${encodeURIComponent(questionId)}?${params.toString()}`);
      if (flags.json || !isApiSuccess(r)) {
        printJson(r);
      } else {
        console.log(JSON.stringify(r, null, 2));
        const data = (r as { data?: { plan_id?: string; pm_consumer?: string; asked_event_id?: string } }).data;
        if (data?.asked_event_id) {
          const planArg = data.plan_id ? ` --plan ${data.plan_id}` : '';
          console.log(`答复成功后执行：.biao/pm pm ack --consumer ${data.pm_consumer ?? consumer}${planArg} --event-id ${data.asked_event_id}`);
        }
      }
      return;
    }

    if (sub === 'answer') {
      const questionId = rest[0];
      const answer = flags.answer;
      if (!questionId || !answer) {
        console.error('用法：biao question answer <question_id> --answer "答复" [--consumer <pm>] [--plan <id>] [--json]');
        process.exit(1);
      }
      const r = await api(`/question/${encodeURIComponent(questionId)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ consumer, ...(flags.plan ? { plan_id: flags.plan } : {}), answer }),
      });
      if (flags.json) {
        printJson(r);
      } else if (isApiSuccess(r)) {
        console.log(`✓ 已回答 ${questionId}；任务将作为 pending 由 Worker 使用新 claim token 重新领取。`);
        const data = (r as { data?: { plan_id?: string; pm_consumer?: string; asked_event_id?: string } }).data;
        if (data?.asked_event_id) {
          const planArg = data.plan_id ? ` --plan ${data.plan_id}` : '';
          console.log(`  PM 下一步：.biao/pm pm ack --consumer ${data.pm_consumer ?? consumer}${planArg} --event-id ${data.asked_event_id}`);
        } else {
          console.log('  PM 下一步：确认答复已完成后，ack 对应的 question_asked 事件。');
        }
      } else {
        printJson(r);
      }
      return;
    }

    printQuestionHelp();
    process.exit(1);
  }

  if (cmd === 'task') {
    if (sub === 'resolution') {
      const parsed = validateStrictOptions('biao task resolution', rest, TASK_RESOLUTION_OPTION_SPEC);
      if (!parsed) return;
      if (parsed.helpRequested) {
        printTaskResolutionHelp();
        return;
      }

      const taskId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
      const flags: Record<string, string> = {};
      for (let index = taskId ? 1 : 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === '--json') flags.json = 'true';
        else if (token.startsWith('--')) flags[token.slice(2)] = rest[++index];
      }
      if (!taskId) {
        console.error('✗ task resolution 必须提供 <task_id>');
        process.exitCode = 1;
        return;
      }

      const action = flags.action ?? 'inspect';
      if (!['inspect', 'continue', 'cancel'].includes(action)) {
        console.error('✗ --action 只支持 inspect、continue 或 cancel');
        process.exitCode = 1;
        return;
      }
      if (action === 'inspect' && flags['decided-by'] !== undefined) {
        console.error('✗ inspect 是只读动作，不接受 --decided-by');
        process.exitCode = 1;
        return;
      }
      if (flags['decided-by'] !== undefined && !flags['decided-by'].trim()) {
        console.error('✗ --decided-by 不能为空');
        process.exitCode = 1;
        return;
      }

      type ResolutionCliResponse = {
        ok: boolean;
        data: {
          root_task_id: string;
          state: string;
          action: string;
          reason: string;
          latest_repair_id: string;
          resolution_lineage: string[];
          attempts: number;
          max_retries: number;
          available_actions: string[];
          created_task_ids?: string[];
        } | null;
        error?: { code?: string; message?: string };
      };
      const path = `/task/${encodeURIComponent(taskId)}/resolution`;
      const response = (action === 'inspect'
        ? await api(path)
        : await api(path, {
            method: 'POST',
            body: JSON.stringify({
              action,
              decided_by: flags['decided-by'] ?? process.env.BIAO_AGENT_ID ?? 'pm',
            }),
          })) as ResolutionCliResponse;

      if (flags.json) {
        printJson(response);
        return;
      }
      if (!response.ok || !response.data) {
        console.error(`✗ resolution ${action} 失败：${response.error?.message ?? '未知错误'}`);
        process.exitCode = 1;
        return;
      }

      const data = response.data;
      console.log(`Resolution: ${data.root_task_id} | state=${data.state} | action=${data.action}`);
      console.log(`原因：${data.reason || '未记录'}`);
      console.log(`最新 repair：${data.latest_repair_id || '无'}`);
      console.log(`lineage：${data.resolution_lineage.length > 0 ? data.resolution_lineage.join(' → ') : '无'}`);
      console.log(`尝试：${data.attempts}/${data.max_retries}`);
      console.log(`可用动作：${data.available_actions.join(', ') || 'inspect'}`);
      if (data.created_task_ids?.length) console.log(`新建任务：${data.created_task_ids.join(', ')}`);
      return;
    }
    if (sub === 'supersede') {
      const parsed = validateStrictOptions('biao task supersede', rest, SUPERSEDE_OPTION_SPECS.task);
      if (!parsed) return;
      if (parsed.helpRequested) {
        console.log(`用法：biao task supersede <task_id> --reason "历史退出原因" --yes [--by <pm>] [--json]

只允许 done + pending review 且没有 resolution 的历史任务。原 result、verify 和审计保留；
若仍有依赖者则拒绝，请改用经过 preview token 确认的 plan supersede。`);
        return;
      }
      const taskId = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
      const flags: Record<string, string> = {};
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === '--yes' || token === '--json') {
          flags[token.slice(2)] = 'true';
        } else if (token.startsWith('--')) {
          flags[token.slice(2)] = rest[++index];
        }
      }
      if (!taskId || !flags.reason || !flags.yes) {
        console.error('✗ task supersede 必须提供 <task_id>、--reason 与显式 --yes');
        process.exitCode = 1;
        return;
      }
      const r = await api(`/task/${encodeURIComponent(taskId)}/supersede`, {
        method: 'POST',
        body: JSON.stringify({
          reason: flags.reason,
          superseded_by: flags.by ?? process.env.BIAO_AGENT_ID ?? 'pm',
          confirmed: true,
        }),
      });
      if (flags.json) {
        printJson(r);
      } else if (isApiSuccess(r)) {
        console.log(`✓ ${taskId} 已置为 superseded；原交付与审计记录保持不变`);
      } else {
        printJson(r);
      }
      return;
    }
    if (sub === 'get') {
      const taskId = rest[0];
      const r = await api(`/task/${taskId}`);
      printJson(r);
      return;
    }
    if (sub === 'add') {
      await runTaskAdd(rest, api);
      return;
    }
    if (sub === 'edit') {
      await runTaskEdit(rest, api);
      return;
    }
    if (sub === 'cancel') {
      // biao task cancel <task_id> —— 撤销 pending 任务
      const taskId = rest[0];
      if (!taskId) {
        console.error('用法：biao task cancel <task_id>（只能撤销 pending 任务）');
        process.exit(1);
      }
      const r = (await api(`/task/${taskId}/cancel`, { method: 'POST', body: '{}' })) as {
        ok: boolean;
        data: { task_id: string; status: string } | null;
        error?: { code: string; message: string };
      };
      if (r.ok) {
        console.log(`✓ 已撤销任务 ${taskId}（status: cancelled）`);
      } else {
        console.error(`✗ 撤销失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      return;
    }
    if (sub === 'block') {
      // biao task block <task_id> --claim-token <token> --reason <reason> [--agent-id <id>]
      const taskId = rest[0];
      if (!taskId) {
        console.error('用法：biao task block <task_id> --claim-token <token> --reason waiting_file_release|waiting_dependency');
        process.exit(1);
      }
      const flags: Record<string, string> = {};
      for (let i = 1; i < rest.length; i++) {
        if (rest[i].startsWith('--') && rest[i + 1]) flags[rest[i].slice(2).replace(/-/g, '_')] = rest[++i];
      }
      if (!flags.claim_token || !flags.reason) {
        console.error('task block 必须提供当前 claim token 与等待原因：--claim-token <token> --reason waiting_file_release|waiting_dependency');
        process.exit(1);
      }
      const body = {
        agent_id: flags.agent_id ?? process.env.BIAO_AGENT_ID ?? 'cli',
        claim_token: flags.claim_token,
        reason: flags.reason,
      };
      const r = (await api(`/task/${taskId}/block`, { method: 'POST', body: JSON.stringify(body) })) as {
        ok: boolean;
        error?: { message: string };
      };
      if (r.ok) {
        console.log(`✓ 已搁置任务 ${taskId}（reason: ${body.reason}），worker 已释放去领别的`);
      } else {
        console.error(`✗ 搁置失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      return;
    }
    if (sub === 'resume') {
      // biao task resume <task_id> [--agent-id <id>]
      const taskId = rest[0];
      if (!taskId) {
        console.error('用法：biao task resume <task_id>');
        process.exit(1);
      }
      const flags: Record<string, string> = {};
      for (let i = 1; i < rest.length; i++) {
        if (rest[i].startsWith('--') && rest[i + 1]) flags[rest[i].slice(2).replace(/-/g, '_')] = rest[++i];
      }
      const body = { agent_id: flags.agent_id ?? process.env.BIAO_AGENT_ID ?? 'cli' };
      const r = (await api(`/task/${taskId}/resume`, { method: 'POST', body: JSON.stringify(body) })) as {
        ok: boolean;
        data?: { lease_remaining: number };
        error?: { message: string };
      };
      if (r.ok) {
        console.log(`✓ 已恢复任务 ${taskId}（lease 剩余 ${r.data?.lease_remaining}s）`);
      } else {
        console.error(`✗ 恢复失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      return;
    }
    if (sub === 'reset') {
      // biao task reset <task_id> [--force] [--json] —— 重置任务到 pending
      const taskId = rest[0];
      if (!taskId || taskId === '--help' || taskId === '-h') {
        console.log(`用法：biao task reset <task_id> [--force] [--json]
  把任意状态（running/done/failed）的 task 重置为 pending
  done/failed 的 reset 需要 --force（防误操作）
  cancelled/superseded 是终态，不能 reset；superseded 会永久保留原交付审计

选项：
  --force    强制重置 done/failed 状态的任务
  --json     输出 JSON 格式`);
        process.exit(0);
      }
      const flags: Record<string, string> = {};
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === '--force') {
          flags.force = 'true';
        } else if (rest[i] === '--json') {
          flags.json = 'true';
        }
      }
      const resetBy = process.env.BIAO_AGENT_ID ?? 'pm';
      const body: Record<string, unknown> = { reset_by: resetBy };
      if (flags.force) body.force = true;
      const r = (await api(`/task/${taskId}/reset`, { method: 'POST', body: JSON.stringify(body) })) as {
        ok: boolean;
        data: { task_id: string; from_status: string; to_status: string } | null;
        error?: { code: string; message: string };
      };
      if (flags.json) {
        printJson(r);
        return;
      }
      if (r.ok && r.data) {
        console.log(`✓ 已重置任务 ${taskId}（${r.data.from_status} → ${r.data.to_status}）`);
      } else {
        console.error(`✗ 重置失败：${r.error?.message ?? '未知错误'}`);
        if (r.error?.code === 'FORCE_REQUIRED') {
          console.error('  提示：对 done/failed 的任务 reset 需要加 --force');
        }
        process.exit(1);
      }
      return;
    }
    if (sub === 'list') {
      // biao task list [--plan <id>] [--status pending|running|done|failed] [--limit 100] [--json]
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--json') {
          flags.json = 'true';
        } else if (rest[i].startsWith('--') && rest[i + 1]) {
          flags[rest[i].slice(2)] = rest[++i];
        }
      }
      const params = new URLSearchParams();
      if (flags.plan) params.set('plan_id', flags.plan);
      if (flags.status) params.set('status', flags.status);
      if (flags.limit) params.set('limit', flags.limit);
      const r = (await api(`/tasks?${params.toString()}`)) as {
        ok: boolean;
        data: {
          tasks: TaskListDisplayItem[];
          total: number;
        };
      };
      if (flags.json) {
        printJson(r);
        return;
      }
      if (!r.ok || !r.data) {
        console.error('✗ task 列表查询失败');
        process.exitCode = 1;
        return;
      }
      if (r.data.tasks.length === 0) {
        console.log('（无匹配任务）');
        return;
      }
      console.log(`共 ${r.data.total} 个任务：\n`);
      console.log('TASK_ID                        STATUS     LIFECYCLE                     PHASE   PRI  TYPE         ASSIGNEE  TITLE');
      console.log('─'.repeat(142));
      for (const t of r.data.tasks) {
        const lifecycle = taskLifecycle(t).label;
        console.log(
          `${t.task_id.padEnd(30)} ${t.status.padEnd(10)} ${lifecycle.padEnd(29)} ${t.phase.padEnd(7)} ${String(t.priority).padEnd(4)} ${t.type.padEnd(12)} ${(t.assignee ?? '-').padEnd(9)} ${t.title}`,
        );
      }
      printTaskLifecycleSummary(r.data.tasks);
      return;
    }
  }

  if (cmd === 'review') {
    // biao review <task_id> [--accept --comment "..."] [--reject --reason "..." --fix-instructions "..." --reverify-only | --repair-ownership '{"files":[...],"modules":[...]}' ]
    // biao review list [--plan <id>]
    if (sub === 'list') {
      // 列出待验收：done 但 pm_review_status 为空
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--json') flags.json = 'true';
        else if (rest[i].startsWith('--') && rest[i + 1]) flags[rest[i].slice(2)] = rest[++i];
      }
      // 用 /tasks?status=done 拿所有 done，再逐个查 review 状态（轻量：直接调 status 看 reviews 计数）
      const r = (await api('/status')) as {
        ok: boolean;
        data: { reviews: { pending: number; accepted: number; rejected: number } };
      };
      if (flags.json) {
        printJson(r);
        return;
      }
      if (!r.ok || !r.data) {
        console.error('✗ 验收概况查询失败');
        process.exitCode = 1;
        return;
      }
      const rv = r.data.reviews;
      console.log(`验收概况：待验收 ${rv.pending} | 已通过 ${rv.accepted} | 已拒绝 ${rv.rejected}`);
      return;
    }

    const taskId = sub;  // cmd=review, sub=task_id (rest 是 task_id 之后的 flags)
    if (!taskId) {
      console.error('用法：');
      console.error('  biao review <task_id>                  查看 worker 产出');
      console.error('  biao review <task_id> --accept --comment "..."     验收通过');
      console.error('  biao review <task_id> --reject --reason "..." --fix-instructions "..." [--reverify-only | --repair-ownership \'{"files":[...],"modules":[...]}\']  拒绝后修来源（默认）或只生成独立复验');
      console.error('  biao review list                       验收概况');
      process.exit(1);
    }

    // 解析 flags（--accept/--reject 是布尔，其他带值）
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--accept' || rest[i] === '--reject' || rest[i] === '--reverify-only') {
        flags[rest[i].slice(2)] = 'true';
      } else if (rest[i].startsWith('--') && rest[i + 1] && !rest[i + 1].startsWith('--')) {
        flags[rest[i].slice(2)] = rest[++i];
      }
    }

    if (flags.accept || flags.reject) {
      // 验收操作
      const reviewer = process.env.BIAO_AGENT_ID ?? 'pm';
      const body: Record<string, unknown> = {
        verdict: flags.accept ? 'accept' : 'reject',
        reviewed_by: reviewer,
      };
      if (flags.comment) body.comment = flags.comment;
      if (flags.reason) body.reject_reason = flags.reason;
      if (flags['fix-instructions']) body.fix_instructions = flags['fix-instructions'];
      if (flags['reverify-only']) {
        if (!flags.reject) {
          console.error('✗ --reverify-only 只能与 --reject 一起使用');
          process.exitCode = 1;
          return;
        }
        if (flags['repair-ownership']) {
          console.error('✗ --reverify-only 表示来源无需修改，不能同时使用 --repair-ownership');
          process.exitCode = 1;
          return;
        }
        body.resolution_mode = 'reverify';
      }
      if (flags['repair-ownership']) {
        if (!flags.reject) {
          console.error('✗ --repair-ownership 只能与 --reject 一起使用');
          process.exitCode = 1;
          return;
        }
        try {
          const repairOwnership = JSON.parse(flags['repair-ownership']) as unknown;
          if (!repairOwnership || typeof repairOwnership !== 'object' || Array.isArray(repairOwnership)) {
            throw new Error('必须是 JSON 对象');
          }
          body.repair_ownership = repairOwnership;
        } catch (error) {
          console.error(`✗ --repair-ownership 必须是 JSON 对象：${error instanceof Error ? error.message : '格式错误'}`);
          process.exitCode = 1;
          return;
        }
      }
      const r = (await api(`/task/${taskId}/review`, {
        method: 'POST',
        body: JSON.stringify(body),
      })) as {
        ok: boolean;
        data: { task_id: string; review_status: string; resolution_mode?: string; fix_task_id?: string; fix_task_ids?: string[] } | null;
        error?: { message: string };
      };
      if (r.ok) {
        if (r.data?.review_status === 'accepted') {
          console.log(`✓ ${taskId} 验收通过`);
        } else {
          const fixTaskIds = r.data?.fix_task_ids?.length
            ? r.data.fix_task_ids
            : r.data?.fix_task_id
              ? [r.data.fix_task_id]
              : [];
          const taskKind = r.data?.resolution_mode === 'reverify' ? '独立复验任务' : '修复任务';
          console.log(`✗ ${taskId} 已拒绝，生成${taskKind}：${fixTaskIds.join(', ') || '无（需 PM 决策）'}`);
        }
      } else {
        console.error(`✗ 验收失败：${r.error?.message ?? '未知错误'}`);
        process.exit(1);
      }
      return;
    }

    // 查看产出（默认）
    const r = (await api(`/task/${taskId}/review`)) as {
      ok: boolean;
      data: {
        task_id: string;
        title: string;
        status: string;
        claimed_by: string;
        pm_review_status: string;
        result_md: string;
        changed_files: string[];
        verify_results: Array<{ cmd: string; passed: boolean }>;
        plan_md_violations: Array<{ path: string; changeType: string }>;
      } | null;
      error?: { message: string };
    };
    if (!r.ok || !r.data) {
      console.error(`✗ ${r.error?.message ?? '查询失败'}`);
      process.exit(1);
    }
    const d = r.data;
    console.log(`Task: ${d.task_id}（${d.title}）`);
    console.log(`Status: ${d.status}（reported by ${d.claimed_by}）`);
    console.log(`Review: ${d.pm_review_status || '未验收'}`);
    if (d.plan_md_violations.length > 0) {
      console.log(`\n⚠ 警告：worker 改动了 plan MD 文件（违反 MD 职责分离）`);
      for (const v of d.plan_md_violations) {
        console.log(`  - ${v.path} (${v.changeType})`);
      }
    }
    if (d.changed_files.length > 0) {
      console.log(`\n--- 改动文件 ---`);
      for (const f of d.changed_files) console.log(`  ${f}`);
    }
    if (d.verify_results.length > 0) {
      console.log(`\n--- 测试结果 ---`);
      for (const v of d.verify_results) console.log(`  ${v.cmd}: ${v.passed ? 'PASS' : 'FAIL'}`);
    }
    if (d.result_md) {
      console.log(`\n--- result.md（尾部）---`);
      const tail = d.result_md.slice(-800);
      console.log(tail);
    }
    return;
  }

  if (cmd === 'db') {
    // biao db status / biao db restore
    const optionSpec = sub === 'status' || sub === 'restore' ? DB_OPTION_SPECS[sub] : undefined;
    if (!optionSpec) {
      console.error('用法：biao db status | biao db restore --yes');
      process.exitCode = 1;
      return;
    }
    const parsedOptions = validateStrictOptions(`biao db ${sub}`, rest, optionSpec);
    if (!parsedOptions) return;
    if (sub === 'status') {
      if (parsedOptions.helpRequested) {
        printCommandGroupHelp('db');
        return;
      }
      const r = (await api('/db/status')) as {
        ok: boolean;
        data: {
          task_count: number;
          plan_count: number;
          by_status: Record<string, number>;
          maintenance?: {
            state: 'idle' | 'restoring' | 'failed';
            restore_lock: boolean;
            barrier_phase: string;
            barrier_error_code: string;
            barrier_message: string;
            writer_permit_count: number;
            expired_permit_count: number;
            recovery_hint: string;
          };
        } | null;
        error?: { message: string };
      };
      if (!r.ok || !r.data) {
        console.error(`✗ ${r.error?.message ?? '查询失败'}`);
        process.exit(1);
      }
      console.log(`SQLite 持久化状态：`);
      console.log(`  plans: ${r.data.plan_count}`);
      console.log(`  tasks: ${r.data.task_count}`);
      console.log(`  按状态:`, JSON.stringify(r.data.by_status));
      if (r.data.maintenance) {
        const m = r.data.maintenance;
        console.log(`  maintenance: ${m.state} (lock=${m.restore_lock ? 'yes' : 'no'}, permits=${m.writer_permit_count}, expired=${m.expired_permit_count})`);
        if (m.barrier_phase || m.barrier_error_code) {
          console.log(`  restore barrier: phase=${m.barrier_phase || '-'} code=${m.barrier_error_code || '-'}`);
        }
        if (m.barrier_message) console.log(`  restore error: ${m.barrier_message}`);
        if (m.recovery_hint) console.log(`  处置提示: ${m.recovery_hint}`);
      }
      return;
    }
    if (sub === 'restore') {
      if (parsedOptions.helpRequested) {
        printDbRestoreHelp();
        return;
      }
      if (!rest.includes('--yes')) {
        console.error(`✗ 未执行恢复：${DB_RESTORE_SAFETY_NOTICE}`);
        console.error('确认上述条件后，显式添加 --yes。');
        process.exitCode = 1;
        return;
      }
      const r = (await api('/db/restore', { method: 'POST', body: '{}' })) as {
        ok: boolean;
        data: { restored: number; by_status: Record<string, number> } | null;
        error?: { code?: string; message?: string };
      };
      if (!r.ok || !r.data) {
        const code = r.error?.code ?? (r.ok ? 'DB_RESTORE_INVALID_RESPONSE' : 'DB_RESTORE_FAILED');
        console.error(`✗ 恢复失败 [${code}]：${r.error?.message ?? '服务未返回恢复结果'}`);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ 恢复了 ${r.data.restored} 个 task`, JSON.stringify(r.data.by_status));
      return;
    }
    console.error('用法：biao db status | biao db restore --yes');
    process.exit(1);
  }

  if (cmd === 'ownership') {
    if (sub === 'check') {
      const path = rest[0];
      const agentId = process.env.BIAO_AGENT_ID ?? 'cli';
      const r = await api(`/ownership?path=${encodeURIComponent(path)}&agent_id=${agentId}`);
      printJson(r);
      return;
    }
    if (sub === 'list') {
      // biao ownership list [--json] —— 当前活跃的文件占用（PM 看"谁卡着谁"）
      const flags: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--json') {
          flags.json = 'true';
        } else if (rest[i].startsWith('--') && rest[i + 1]) {
          flags[rest[i].slice(2)] = rest[++i];
        }
      }
      const r = (await api('/ownership/active')) as {
        ok: boolean;
        data: {
          ownership: Array<{
            path: string;
            agent_id: string;
            task_id: string;
            priority: number;
            expires_at: number;
          }>;
          total: number;
        };
      };
      if (flags.json) {
        printJson(r);
        return;
      }
      if (!r.ok || !r.data) {
        // 后端路由未上线（如 GET /ownership/active 尚未部署）时如实报错，不伪装成"无占用"
        console.error('✗ 查询失败：', (r as { error?: { message?: string } }).error?.message ?? '未知错误');
        process.exit(1);
      }
      if (r.data.ownership.length === 0) {
        console.log('（当前无活跃文件占用）');
        return;
      }
      console.log(`当前活跃文件占用（${r.data.total} 条）：\n`);
      console.log('文件                                       AGENT            PRI   TASK                              过期时间');
      console.log('─'.repeat(130));
      for (const o of r.data.ownership) {
        const exp = new Date(o.expires_at).toISOString().replace('T', ' ').slice(0, 19);
        console.log(
          `${o.path.padEnd(43)}${o.agent_id.padEnd(17)}${String(o.priority).padEnd(6)}${o.task_id.padEnd(34)}${exp}`,
        );
      }
      return;
    }
  }

  if (cmd === 'events') {
    // biao events [--since 5m|1h|2026-08-11|<ts>] [--limit 50] [--json]
    // events/conflicts 无子命令，argv[3] 已被 sub 占用，需合并回来
    const args = [sub, ...rest].filter((a): a is string => Boolean(a));
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') {
        flags.json = 'true';
      } else if (args[i].startsWith('--') && args[i + 1]) {
        flags[args[i].slice(2)] = args[++i];
      }
    }
    const params = new URLSearchParams();
    if (flags.since) {
      const ts = parseSince(flags.since);
      if (ts) params.set('since', String(ts));
    }
    if (flags.limit) params.set('limit', flags.limit);
    const r = (await api(`/events?${params.toString()}`)) as {
      ok: boolean;
      data: Array<{ event_id: string; type: string; task_id: string; agent_id: string; result_status: string; timestamp: number }>;
    };
    if (flags.json) {
      printJson(r);
      return;
    }
    if (!r.ok || !r.data) {
      console.error('✗ 事件查询失败');
      process.exitCode = 1;
      return;
    }
    if (r.data.length === 0) {
      console.log('（暂无完成事件）');
      return;
    }
    console.log('最近完成事件：\n');
    console.log('时间                     类型             任务                          agent             结果');
    console.log('─'.repeat(115));
    for (const e of r.data) {
      const time = new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        `${time}   ${e.type.padEnd(14)}   ${e.task_id.padEnd(28)}   ${e.agent_id.padEnd(16)}   ${e.result_status}`,
      );
    }
    return;
  }

  if (cmd === 'conflicts') {
    // biao conflicts [--limit 20] [--json]
    // events/conflicts 无子命令，argv[3] 已被 sub 占用，需合并回来
    const args = [sub, ...rest].filter((a): a is string => Boolean(a));
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') {
        flags.json = 'true';
      } else if (args[i].startsWith('--') && args[i + 1]) {
        flags[args[i].slice(2)] = args[++i];
      }
    }
    const params = new URLSearchParams();
    if (flags.limit) params.set('limit', flags.limit);
    const r = (await api(`/conflicts?${params.toString()}`)) as {
      ok: boolean;
      data: Array<{ conflict_id: number; path: string; winner: { agent_id: string }; loser: { agent_id: string }; action: string; timestamp: number }>;
    };
    if (flags.json) {
      printJson(r);
      return;
    }
    if (!r.ok || !r.data) {
      console.error('✗ 冲突查询失败');
      process.exitCode = 1;
      return;
    }
    if (r.data.length === 0) {
      console.log('（暂无文件占用冲突）');
      return;
    }
    console.log('文件占用冲突历史：\n');
    console.log('时间                     文件                                       抢占方           被抢方           动作');
    console.log('─'.repeat(125));
    for (const c of r.data) {
      const time = new Date(c.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      console.log(
        `${time}   ${c.path.padEnd(40)}   ${c.winner.agent_id.padEnd(15)}   ${c.loser.agent_id.padEnd(15)}   ${c.action}`,
      );
    }
    return;
  }

  if (cmd === 'watchdog') {
    // biao watchdog [--dry-run] [--auto-fix] [--interval <s>] [--json]
    // watchdog 无子命令，argv[3] 已被 sub 占用，需合并回来
    const args = [sub, ...rest].filter((a): a is string => Boolean(a));
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json' || args[i] === '--auto-fix' || args[i] === '--dry-run') {
        flags[args[i].slice(2)] = true;
      } else if (args[i].startsWith('--') && args[i + 1]) {
        flags[args[i].slice(2)] = args[++i];
      }
    }
    type WatchdogResult = {
      ok: boolean;
      data: {
        problems: Array<{
          type: string;
          task_id?: string;
          agent_id?: string;
          detail: string;
          suggestion: string;
          auto_fixable: boolean;
          fixed?: boolean;
        }>;
        summary: { total_problems: number; auto_fixable: number; fixed: number; healthy: boolean };
      };
    };
    const runOnce = async () => {
      const qs = flags['auto-fix'] ? '?auto_fix=true' : '';
      const r = (await api(`/watchdog${qs}`)) as WatchdogResult;
      if (flags.json) {
        printJson(r);
        return;
      }
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.log(`🔍 Biao 巡检报告（${ts}）\n`);
      if (!r.ok || !r.data) {
        console.error('✗ 巡检失败');
        process.exitCode = 1;
        return;
      }
      const { problems, summary } = r.data;
      if (summary.healthy) {
        console.log('✅ 一切正常，无需处理');
        return;
      }
      const must = problems.filter((p) => !p.auto_fixable);
      const auto = problems.filter((p) => p.auto_fixable);
      if (must.length > 0) {
        console.log(`⚠ ${must.length} 个问题需要关注：`);
        must.forEach((p, i) => {
          console.log(`  [${i + 1}] ${p.type.toUpperCase()}: ${p.task_id ?? p.agent_id} — ${p.detail}`);
          console.log(`      建议: ${p.suggestion}`);
        });
      }
      if (auto.length > 0) {
        const handled = flags['auto-fix'] ? `（已自动处理 ${summary.fixed} 个）` : '（加 --auto-fix 自动处理）';
        console.log(`ℹ ${auto.length} 个可自动处理${handled}：`);
        auto.forEach((p, i) => {
          console.log(
            `  [${i + 1}] ${p.type.toUpperCase()}: ${p.task_id ?? p.agent_id} — ${p.detail}${p.fixed ? ' [已修复]' : ''}`,
          );
        });
      }
    };
    const intervalSec = flags.interval ? Number(flags.interval) : 0;
    if (intervalSec > 0) {
      // 定时巡检模式（阻塞，每 N 秒一次）
      console.log(`[biao] 定时巡检模式：每 ${intervalSec}s 一次（Ctrl-C 退出）`);
      await runOnce();
      setInterval(() => void runOnce(), intervalSec * 1000);
      return; // 不退出
    }
    await runOnce();
    return;
  }

  // 帮助
  console.log(`Biao CLI 用法：
  biao serve [--port 7331] [--redis-url redis://localhost:6379]
  biao version [--json]                                           查询当前服务版本
  biao health
  biao status
  biao events [--since 5m|1h|2026-08-11] [--limit 50] [--json]   任务完成事件流
  biao conflicts [--limit 20] [--json]                           文件占用冲突历史
  biao plan init <plan-id> [--project <path>] [--dir <plans/>]   本地生成 plan 骨架
  biao plan create <plan-id> --project <path> [--title <标题>]   通过 API 创建+提交
  biao plan submit <plan_dir>                                     提交 plan 到 Redis
  biao plan list [--json]                                         列出所有 plan + 任务计数
  biao plan status <plan_id>                                      查看 plan 状态
  biao plan revise <plan_id> [--preview|--diff|--submit] [--json]  预览磁盘/平台差异后安全提交
  biao plan intake --plan <id> --text "..." [--json]              存档人类需求（同名不覆盖）
  biao plan supersede <id> --preview                              预览历史待验收批量退出及快照 token
  biao plan supersede <id> --reason "..." --preview-token <token> --yes  按已预览快照批量退出
  biao task add --plan <id> --task-id <id> --title "..." [--verify-cmd <cmd>...] [--json] 生成可校验 MD + 自动 submit
  biao task edit <task_id> [--from-file <md>|--editor <path>|--verify-cmd <cmd>...] 编辑、校验、自动 submit；失败回滚
  biao task get <task_id>
  biao task list [--plan <id>] [--status pending|running|done|failed|cancelled|superseded] [--json]   批量看任务状态
  biao task cancel <task_id>                                      撤销 pending 任务
  biao task supersede <task_id> --reason "..." --yes              安全退出历史 done+待验收（保留结果/审计）
  biao task block <task_id> --claim-token <token> --reason waiting_file_release|waiting_dependency
  biao task resume <task_id> [--agent-id <id>]                    恢复搁置任务
  biao task reset <task_id> [--force] [--json]                    重置任务到 pending（done/failed 需 --force）
  biao task resolution <task_id> [--action inspect|continue|cancel] [--decided-by <pm>] [--json] 处理 repair/reverify 重试耗尽
  biao question ask --task <id> --claim-token <token> --agent-id <current-worker-id> --body "..."  Worker 通过平台向对应 PM 提问
  biao question list [--consumer pm] [--plan <id>] [--status open|answered|all]   PM 列出受管计划待答问题
  biao question get <question_id> [--consumer pm] [--plan <id>]                  PM 读取归属 Question 正文
  biao question answer <question_id> --answer "..." [--consumer pm] [--plan <id>] PM 回答后让 Worker 重新领取
  biao review <task_id>                                           查看 worker 产出（验收）
  biao review <task_id> --accept --comment "..."                  验收通过
  biao review <task_id> --reject --reason "..." --fix-instructions "..." [--reverify-only | --repair-ownership '{"files":[...],"modules":[...]}']  默认修来源；证据问题可只生成独立复验
  biao review list                                                验收概况
  biao db status                                                  SQLite 持久化状态
  biao db restore --yes                                           Redis namespace 为空时从 SQLite 灾难恢复
  biao ownership check <path>
  biao ownership list [--json]                                         当前活跃文件占用（谁卡着谁）
  biao watchdog [--auto-fix] [--interval <s>] [--json]                 PM 巡检（failed/stale/未验收）
  biao pm start [--consumer pm] [--once] [--interval 60] [--plans p1,p2]  PM 统一入口：检查、门铃与共享 Supervisor（不自动 ack/验收）
  biao pm intake [--consumer pm] [--plan <id>] [--json]               PM 主动轮询门铃（待签核/就绪/失败/阻塞/stale）
  biao pm unacked [--consumer pm] [--type review_requested] [--json]  按 consumer 查未确认事件
  biao pm ack --consumer pm --event-id <id>                           幂等确认事件（不影响其他 consumer）
  biao pm watch [--consumer pm] [--interval 60] [--once]              低频主动轮询模式（Ctrl-C 退出）

典型流程：
  biao plan init my-feature --project /path/to/repo
  # 编辑 plans/my-feature/*.md
  biao plan submit plans/my-feature
  # 启动 worker 消费

环境变量：
  BIAO_URL（默认 http://localhost:7331）
  BIAO_AGENT_ID（ownership check 用）
  BIAO_API_TOKEN（启用认证时使用的 Bearer Token）
`);
}

main().catch((e) => {
  console.error('[biao] 错误：', e);
  process.exit(1);
});
