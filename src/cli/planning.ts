import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  detectCycle,
  parseMarkdown,
  parsePlanDir,
  parseTaskFile,
  validateAcceptanceFor,
  validateAcceptanceVerify,
  validatePhases,
  type ParsedPlan,
} from '../plan/parser.js';
import type { TaskFrontmatter, TaskType, VerifyCommand } from '../types/index.js';

export type CliApi = (path: string, init?: RequestInit) => Promise<unknown>;

type ApiResult<T = unknown> = {
  ok: boolean;
  data: T | null;
  error?: { code?: string; message?: string; details?: unknown };
};

type OptionSpec = Record<string, 'boolean' | 'value' | 'repeatable-value'>;

type ParsedOptions = {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
  json: boolean;
};

type PlanTaskSummary = { task_id?: string; status?: string };
type PlanRead = {
  plan_id?: string;
  project_path?: string;
  tasks?: Record<string, PlanTaskSummary[]>;
};

class CliUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function parseOptions(args: string[], spec: OptionSpec): ParsedOptions {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  const json = args.includes('--json');

  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith('--')) {
      if (value.startsWith('-')) {
        throw new CliUsageError('UNKNOWN_OPTION', `未知参数：${value}`, { option: value });
      }
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const kind = spec[name];
    if (!kind) {
      throw new CliUsageError('UNKNOWN_OPTION', `未知参数：${value}`, { option: value });
    }
    if (kind === 'boolean') {
      if (flags[name] !== undefined) {
        throw new CliUsageError('DUPLICATE_OPTION', `参数重复：${value}`, { option: value });
      }
      flags[name] = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      throw new CliUsageError('MISSING_OPTION_VALUE', `参数 ${value} 缺少值`, { option: value });
    }
    if (kind === 'value' && flags[name] !== undefined) {
      throw new CliUsageError('DUPLICATE_OPTION', `参数重复：${value}`, { option: value });
    }
    if (kind === 'repeatable-value') {
      const previous = flags[name];
      flags[name] = Array.isArray(previous) ? [...previous, next] : [next];
    } else {
      flags[name] = next;
    }
    index++;
  }
  return { flags, positionals, json };
}

function stringFlag(options: ParsedOptions, name: string): string | undefined {
  const value = options.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function stringFlags(options: ParsedOptions, name: string): string[] {
  const value = options.flags[name];
  return Array.isArray(value) ? value : [];
}

function boolFlag(options: ParsedOptions, name: string): boolean {
  return options.flags[name] === true;
}

function errorResult(code: string, message: string, details?: unknown): ApiResult<never> {
  return {
    ok: false,
    data: null,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function outputFailure(json: boolean, code: string, message: string, details?: unknown): void {
  const result = errorResult(code, message, details);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function outputSuccess(json: boolean, data: Record<string, unknown>, human: () => void): void {
  if (json) console.log(JSON.stringify({ ok: true, data }, null, 2));
  else human();
}

function apiResult<T>(value: unknown): ApiResult<T> {
  if (!value || typeof value !== 'object') {
    return errorResult('INVALID_SERVICE_RESPONSE', '服务返回了无效响应');
  }
  return value as ApiResult<T>;
}

function apiMessage(result: ApiResult<unknown>): string {
  return result.error?.message ?? result.error?.code ?? '服务请求失败';
}

function safePlanDir(projectPath: string, planId: string): string {
  const plansRoot = resolve(projectPath, 'plans');
  const planDir = resolve(plansRoot, planId);
  const rel = relative(plansRoot, planDir);
  if (!rel || rel.startsWith('..') || resolve(plansRoot, rel) !== planDir) {
    throw new CliUsageError('INVALID_PLAN_ID', `plan_id 不能用于定位安全目录：${planId}`);
  }
  return planDir;
}

function validateParsedPlan(parsed: ParsedPlan, expectedPlanId: string): void {
  if (parsed.plan.plan_id !== expectedPlanId) {
    throw new CliUsageError(
      'PLAN_ID_MISMATCH',
      `index.md 的 plan_id=${parsed.plan.plan_id} 与请求的 ${expectedPlanId} 不一致`,
    );
  }
  const ids = parsed.tasks.map((task) => task.fm.task_id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new CliUsageError('DUPLICATE_TASK_ID', `本地 plan 中 task_id 重复：${duplicate}`);
  const cycle = detectCycle(parsed.tasks.map((task) => task.fm));
  if (cycle) throw new CliUsageError('PLAN_CYCLE_DETECTED', `DAG 有环：${cycle.join(', ')}`);
  validatePhases(parsed.plan, parsed.tasks.map((task) => task.fm));
  validateAcceptanceFor(parsed.tasks.map((task) => task.fm));
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return [...new Set(items)];
}

function defaultTimeout(type: TaskType): number {
  if (type === 'code' || type === 'acceptance') return 3600;
  if (type === 'review' || type === 'research') return 2400;
  return 1800;
}

function integerOption(
  value: string | undefined,
  fallback: number,
  code: string,
  label: string,
  predicate: (numberValue: number) => boolean,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new CliUsageError(code, `${label} 必须是整数：${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !predicate(parsed)) {
    throw new CliUsageError(code, `${label} 超出允许范围：${value}`);
  }
  return parsed;
}

function renderTaskMarkdown(fm: TaskFrontmatter, body: string): string {
  const frontmatter: Record<string, unknown> = {
    task_id: fm.task_id,
    title: fm.title,
    type: fm.type,
    phase: fm.phase,
    assignee: fm.assignee,
    priority: fm.priority,
    timeout_seconds: fm.timeout_seconds,
    max_retries: fm.max_retries,
    ...(fm.depends_on?.length ? { depends_on: fm.depends_on } : {}),
    ...(fm.ownership?.files?.length || fm.ownership?.modules?.length ? { ownership: fm.ownership } : {}),
    ...(fm.acceptance_for?.length ? { acceptance_for: fm.acceptance_for } : {}),
    verify: fm.verify ?? [],
  };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function parseVerifyCommands(options: ParsedOptions): VerifyCommand[] {
  return stringFlags(options, 'verify-cmd').map((raw, index) => {
    const cmd = raw.trim();
    if (!cmd) {
      throw new CliUsageError('INVALID_VERIFY_COMMAND', `--verify-cmd 第 ${index + 1} 项不能为空`);
    }
    return { cmd, expect_exit: 0 };
  });
}

function replaceTaskVerify(original: string, verify: VerifyCommand[], fileName: string): string {
  const { frontmatter, body } = parseMarkdown(original);
  if (!frontmatter) throw new CliUsageError('TASK_EDIT_INVALID', `${fileName} 缺少可解析的 frontmatter`);
  return `---\n${stringify({ ...frontmatter, verify }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

function assertNoExtraPositionals(options: ParsedOptions, expected: number, usage: string): void {
  if (options.positionals.length !== expected) {
    throw new CliUsageError('INVALID_ARGUMENTS', usage, { positionals: options.positionals });
  }
}

function planHelp(command: 'revise' | 'intake'): void {
  if (command === 'revise') {
    console.log(`用法：biao plan revise <plan_id> [--preview | --diff | --submit] [--json]

安全比较本地 plans/<plan_id>/tasks/*.md 与平台 task 投影：
  --preview   输出动作摘要（默认，不写平台）
  --diff      输出逐字段 Redis → 磁盘差异（不写平台）
  --submit    先完成同一份预览，再调用现有 POST /plan/submit
  --json      stdout 只输出一个稳定 JSON 对象，适合 Agent/脚本

限制：平台不保存 index.md 原文，因此只能比较 task 字段与正文；磁盘缺失的任务不会被 submit 删除，请显式 task cancel。
状态保护：submit 只更新 pending；running、blocked、done、failed、cancelled、superseded 都会保留。`);
    return;
  }
  console.log(`用法：biao plan intake --plan <plan_id> --text "需求原文" [--json]

把需求安全存到 plans/<plan_id>/intake/。同名文件自动增加序号，不覆盖历史。
无 TTY 或 Agent 调用必须显式提供 --text；本命令不会假装启动交互输入。`);
}

function taskHelp(command: 'add' | 'edit'): void {
  if (command === 'add') {
    console.log(`用法：biao task add --plan <id> --task-id <id> --title "标题" [选项]

选项：
  --type <code|review|research|docs|acceptance>  默认 code
  --phase <id>              默认 impl 或 index.md 的首个 phase
  --priority <0-9>          默认使用 plan default_priority
  --timeout <seconds>       正整数
  --depends-on <id1,id2>    必须引用本 plan 已存在任务
  --acceptance-for <id1,id2> acceptance 任务必填
  --verify-cmd <command>   可重复；每项生成 expect_exit: 0
  --ownership <path1,path2>
  --body "Markdown 正文"
  --assignee <agent|auto>
  --json                    stdout 只输出一个 JSON 对象

验收任务必须至少提供一个 --verify-cmd；需要不同 expect_exit/scope 时用 task edit --from-file 提供完整 MD。
本命令要求显式 task-id/title，不在无 TTY 环境伪装交互；生成 MD 后调用现有 plan submit。`);
    return;
  }
  console.log(`用法：biao task edit <task_id> [--from-file <md> | --editor <executable> | --verify-cmd <command>...] [--force] [--json]

  --from-file <md>   Agent/无 TTY 推荐：用完整 task MD 替换后自动 submit
  --editor <path>    显式启动编辑器；也可设置 EDITOR 或 VISUAL
  --verify-cmd <cmd>  可重复；直接替换 verify，每项 expect_exit: 0
  --force            允许编辑 running/done/failed/cancelled/superseded 任务（submit 仍遵守服务端状态规则）
  --json             stdout 只输出一个 JSON 对象

三种编辑来源互斥。每项需要不同 expect_exit/scope 时用 --from-file 提供完整 MD。
无 TTY 且没有编辑来源、EDITOR/VISUAL 时会明确失败，不会偷偷启动 vi。提交失败会恢复原文件。`);
}

export async function runPlanIntake(args: string[], api: CliApi): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    planHelp('intake');
    return;
  }
  try {
    const options = parseOptions(args, { plan: 'value', text: 'value', json: 'boolean' });
    assertNoExtraPositionals(options, 0, '用法：biao plan intake --plan <plan_id> --text "需求原文" [--json]');
    const planId = stringFlag(options, 'plan')?.trim();
    const text = stringFlag(options, 'text')?.trim();
    if (!planId) throw new CliUsageError('PLAN_ID_REQUIRED', '必须提供 --plan <plan_id>');
    if (!text) {
      throw new CliUsageError(
        'INTERACTIVE_INPUT_REQUIRED',
        '必须显式提供 --text；当前命令不会在无 TTY 环境假装交互输入',
      );
    }

    const planResult = apiResult<PlanRead>(
      await api(`/plan/${encodeURIComponent(planId)}`),
    );
    if (!planResult.ok || !planResult.data?.project_path) {
      throw new CliUsageError('PLAN_NOT_FOUND', `plan 不存在或不可读取：${planId}`, planResult.error);
    }
    const planDir = safePlanDir(planResult.data.project_path, planId);
    if (!existsSync(join(planDir, 'index.md'))) {
      throw new CliUsageError('PLAN_DIR_NOT_FOUND', `找不到本地 plan index：${join(planDir, 'index.md')}`);
    }

    const intakeDir = join(planDir, 'intake');
    mkdirSync(intakeDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const slug = text
      .slice(0, 20)
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'requirement';
    let intakePath = '';
    for (let suffix = 1; suffix <= 999; suffix++) {
      const fileName = `${date}-${slug}${suffix === 1 ? '' : `-${suffix}`}.md`;
      const candidate = join(intakeDir, fileName);
      try {
        writeFileSync(candidate, `# 人类需求（${date}）\n\n${text}\n`, { flag: 'wx' });
        intakePath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!intakePath) throw new CliUsageError('INTAKE_NAME_EXHAUSTED', '同名需求文件过多，无法生成安全文件名');

    outputSuccess(options.json, {
      operation: 'plan_intake',
      plan_id: planId,
      intake_path: intakePath,
      stored: true,
      next_command: `biao task add --plan ${planId} --task-id <id> --title "..."`,
    }, () => {
      console.log(`✓ 需求已存档：${intakePath}`);
      console.log(`  下一步：biao task add --plan ${planId} --task-id <id> --title "..."`);
    });
  } catch (error) {
    const failure = error instanceof CliUsageError
      ? error
      : new CliUsageError('PLAN_INTAKE_FAILED', error instanceof Error ? error.message : String(error));
    outputFailure(json, failure.code, failure.message, failure.details);
  }
}

export async function runTaskAdd(args: string[], api: CliApi): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    taskHelp('add');
    return;
  }
  try {
    const options = parseOptions(args, {
      plan: 'value',
      'task-id': 'value',
      title: 'value',
      type: 'value',
      phase: 'value',
      priority: 'value',
      ownership: 'value',
      'depends-on': 'value',
      'acceptance-for': 'value',
      'verify-cmd': 'repeatable-value',
      timeout: 'value',
      body: 'value',
      assignee: 'value',
      json: 'boolean',
    });
    assertNoExtraPositionals(options, 0, '用法：biao task add --plan <id> --task-id <id> --title "..." [--json]');
    const planId = stringFlag(options, 'plan')?.trim();
    const taskId = stringFlag(options, 'task-id')?.trim();
    const title = stringFlag(options, 'title')?.trim();
    if (!planId) throw new CliUsageError('PLAN_ID_REQUIRED', '必须提供 --plan <plan_id>');
    if (!taskId) throw new CliUsageError('TASK_ID_REQUIRED', '无 TTY/Agent 模式必须显式提供 --task-id');
    if (!title) throw new CliUsageError('TASK_TITLE_REQUIRED', '无 TTY/Agent 模式必须显式提供 --title');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) {
      throw new CliUsageError('INVALID_TASK_ID', `task_id 必须由小写字母、数字和单个连字符组成：${taskId}`);
    }

    const typeValue = stringFlag(options, 'type') ?? 'code';
    const allowedTypes: TaskType[] = ['code', 'review', 'research', 'docs', 'acceptance'];
    if (!allowedTypes.includes(typeValue as TaskType)) {
      throw new CliUsageError('INVALID_TASK_TYPE', `不支持的 task type：${typeValue}`);
    }
    const type = typeValue as TaskType;
    const priorityRaw = stringFlag(options, 'priority');
    if (priorityRaw !== undefined && (!/^\d+$/.test(priorityRaw) || Number(priorityRaw) < 0 || Number(priorityRaw) > 9)) {
      throw new CliUsageError('INVALID_PRIORITY', `priority 必须是 0-9 的整数：${priorityRaw}`);
    }

    const planResult = apiResult<PlanRead>(
      await api(`/plan/${encodeURIComponent(planId)}`),
    );
    if (!planResult.ok || !planResult.data?.project_path) {
      throw new CliUsageError('PLAN_NOT_FOUND', `plan 不存在或不可读取：${planId}`, planResult.error);
    }
    const planDir = safePlanDir(planResult.data.project_path, planId);
    const parsed = parsePlanDir(planDir);
    validateParsedPlan(parsed, planId);
    if (parsed.tasks.some((task) => task.fm.task_id === taskId)) {
      throw new CliUsageError('TASK_ID_EXISTS', `task_id 已存在于本地 plan：${taskId}`);
    }

    const existingResult = apiResult<{ task_id?: string }>(await api(`/task/${encodeURIComponent(taskId)}`));
    if (!existingResult.ok) {
      throw new CliUsageError('TASK_LOOKUP_FAILED', `无法确认 task_id 是否重复：${apiMessage(existingResult)}`);
    }
    if (existingResult.data?.task_id) {
      throw new CliUsageError('TASK_ID_EXISTS', `task_id 已存在于平台：${taskId}`);
    }

    const phaseIds = parsed.plan.phases?.map((phase) => phase.id) ?? [];
    const phase = stringFlag(options, 'phase') ?? (phaseIds.includes('impl') ? 'impl' : phaseIds[0] ?? 'impl');
    if (phaseIds.length > 0 && !phaseIds.includes(phase)) {
      throw new CliUsageError('INVALID_PHASE', `phase 未在 index.md 中定义：${phase}`, { allowed: phaseIds });
    }
    const taskIds = new Set(parsed.tasks.map((task) => task.fm.task_id));
    const dependsOn = parseCsv(stringFlag(options, 'depends-on'));
    const invalidDependency = dependsOn.find((dependency) => dependency === taskId || !taskIds.has(dependency));
    if (invalidDependency) {
      throw new CliUsageError('INVALID_DEPENDENCY', `depends_on 引用了不存在或自身任务：${invalidDependency}`);
    }
    const acceptanceFor = parseCsv(stringFlag(options, 'acceptance-for'));
    const invalidAcceptance = acceptanceFor.find((reference) => !taskIds.has(reference));
    if (invalidAcceptance) {
      throw new CliUsageError('INVALID_ACCEPTANCE_REFERENCE', `acceptance_for 引用了不存在的任务：${invalidAcceptance}`);
    }
    if (type === 'acceptance' && acceptanceFor.length === 0) {
      throw new CliUsageError('ACCEPTANCE_FOR_REQUIRED', 'acceptance 任务必须提供 --acceptance-for <task_id,...>');
    }
    const verify = parseVerifyCommands(options);
    if (type === 'acceptance' && verify.length === 0) {
      throw new CliUsageError(
        'ACCEPTANCE_VERIFY_REQUIRED',
        'acceptance 任务必须提供至少一个 --verify-cmd <command>',
      );
    }

    const priority = integerOption(
      priorityRaw,
      parsed.plan.default_priority ?? 5,
      'INVALID_PRIORITY',
      'priority',
      (value) => value >= 0 && value <= 9,
    );
    const timeout = integerOption(
      stringFlag(options, 'timeout'),
      defaultTimeout(type),
      'INVALID_TIMEOUT',
      'timeout',
      (value) => value > 0,
    );
    const ownershipFiles = parseCsv(stringFlag(options, 'ownership'));
    const assignee = stringFlag(options, 'assignee')?.trim() || parsed.plan.default_assignee || 'auto';
    const body = stringFlag(options, 'body') ?? `# ${title}\n\n## Objective\n\n${title}\n\n## Acceptance Criteria\n\n- [ ] ${title}`;
    const fm: TaskFrontmatter = {
      task_id: taskId,
      title,
      type,
      phase,
      assignee,
      priority,
      timeout_seconds: timeout,
      max_retries: 2,
      depends_on: dependsOn,
      ownership: ownershipFiles.length ? { files: ownershipFiles } : undefined,
      acceptance_for: acceptanceFor,
      verify,
    };
    validateAcceptanceVerify([fm]);
    const markdown = renderTaskMarkdown(fm, body);
    const candidate = parseTaskFile(markdown, `${taskId}.md`);
    const candidatePlan: ParsedPlan = { plan: parsed.plan, tasks: [...parsed.tasks, candidate] };
    validateParsedPlan(candidatePlan, planId);

    const taskPath = join(planDir, 'tasks', `${taskId}.md`);
    mkdirSync(dirname(taskPath), { recursive: true });
    try {
      writeFileSync(taskPath, markdown, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliUsageError('TASK_FILE_EXISTS', `不会覆盖已有文件：${taskPath}`);
      }
      throw error;
    }

    let submitResult: ApiResult<Record<string, unknown>>;
    try {
      submitResult = apiResult<Record<string, unknown>>(await api('/plan/submit', {
        method: 'POST',
        body: JSON.stringify({ plan_dir: planDir }),
      }));
    } catch (error) {
      throw new CliUsageError('TASK_ADD_SUBMIT_FAILED', `task MD 已保留为草稿，但 submit 请求失败：${error instanceof Error ? error.message : String(error)}`, {
        task_path: taskPath,
        draft_retained: true,
      });
    }
    if (!submitResult.ok) {
      throw new CliUsageError('TASK_ADD_SUBMIT_FAILED', `task MD 已保留为草稿，但 submit 失败：${apiMessage(submitResult)}`, {
        task_path: taskPath,
        draft_retained: true,
        service_error: submitResult.error,
      });
    }

    outputSuccess(options.json, {
      operation: 'task_add',
      plan_id: planId,
      task_id: taskId,
      task_path: taskPath,
      submitted: true,
      submit: submitResult.data ?? {},
    }, () => {
      console.log(`✓ 已生成并提交 ${taskPath}`);
    });
  } catch (error) {
    const failure = error instanceof CliUsageError
      ? error
      : new CliUsageError('TASK_ADD_FAILED', error instanceof Error ? error.message : String(error));
    outputFailure(json, failure.code, failure.message, failure.details);
  }
}

function restoreTaskFile(path: string, original: string): boolean {
  try {
    writeFileSync(path, original);
    return true;
  } catch {
    return false;
  }
}

export async function runTaskEdit(args: string[], api: CliApi): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    taskHelp('edit');
    return;
  }
  let taskPath = '';
  let original = '';
  let modified = false;
  try {
    const options = parseOptions(args, {
      'from-file': 'value',
      editor: 'value',
      'verify-cmd': 'repeatable-value',
      force: 'boolean',
      json: 'boolean',
    });
    assertNoExtraPositionals(options, 1, '用法：biao task edit <task_id> [--from-file <md> | --editor <path> | --verify-cmd <command>...] [--force] [--json]');
    const taskId = options.positionals[0];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(taskId)) {
      throw new CliUsageError('INVALID_TASK_ID', `无效 task_id：${taskId}`);
    }
    const fromFile = stringFlag(options, 'from-file');
    const explicitEditor = stringFlag(options, 'editor');
    const verify = parseVerifyCommands(options);
    if ([Boolean(fromFile), Boolean(explicitEditor), verify.length > 0].filter(Boolean).length > 1) {
      throw new CliUsageError('CONFLICTING_OPTIONS', '--from-file、--editor 与 --verify-cmd 三种编辑来源不能同时使用');
    }
    const configuredEditor = explicitEditor?.trim() || process.env.EDITOR?.trim() || process.env.VISUAL?.trim();
    if (!fromFile && verify.length === 0 && !configuredEditor) {
      if (!process.stdin.isTTY) {
        throw new CliUsageError(
          'INTERACTIVE_EDITOR_REQUIRED',
          '当前无 TTY；请使用 --from-file <md>、--editor <executable>，或设置 EDITOR/VISUAL',
        );
      }
      throw new CliUsageError('EDITOR_REQUIRED', '请设置 EDITOR/VISUAL 或使用 --editor');
    }

    const taskResult = apiResult<{
      task_id?: string;
      plan_id?: string;
      project_path?: string;
      status?: string;
    }>(await api(`/task/${encodeURIComponent(taskId)}`));
    if (!taskResult.ok || !taskResult.data?.plan_id || !taskResult.data.project_path) {
      throw new CliUsageError('TASK_NOT_FOUND', `task 不存在或不可读取：${taskId}`, taskResult.error);
    }
    const task = taskResult.data;
    const taskPlanId = task.plan_id as string;
    const taskProjectPath = task.project_path as string;
    if (['running', 'done', 'failed', 'cancelled', 'superseded'].includes(task.status ?? '') && !boolFlag(options, 'force')) {
      throw new CliUsageError(
        'FORCE_REQUIRED',
        `task 状态为 ${task.status}；本地编辑不保证生效。确认后使用 --force`,
        { status: task.status },
      );
    }
    const planDir = safePlanDir(taskProjectPath, taskPlanId);
    taskPath = join(planDir, 'tasks', `${taskId}.md`);
    if (!existsSync(taskPath)) throw new CliUsageError('TASK_FILE_NOT_FOUND', `找不到 task MD：${taskPath}`);
    original = readFileSync(taskPath, 'utf8');

    const planResult = apiResult<PlanRead>(await api(`/plan/${encodeURIComponent(taskPlanId)}`));
    if (!planResult.ok || !planResult.data?.tasks) {
      throw new CliUsageError('PLAN_LOOKUP_FAILED', `无法在编辑前检查 plan 状态：${taskPlanId}`, planResult.error);
    }
    const parsedBeforeEdit = parsePlanDir(planDir);
    validateParsedPlan(parsedBeforeEdit, taskPlanId);

    let source: 'file' | 'editor' | 'verify';
    if (verify.length > 0) {
      const replacement = replaceTaskVerify(original, verify, basename(taskPath));
      writeFileSync(taskPath, replacement);
      modified = replacement !== original;
      source = 'verify';
    } else if (fromFile) {
      const replacementPath = resolve(fromFile);
      if (!existsSync(replacementPath)) {
        throw new CliUsageError('EDIT_SOURCE_NOT_FOUND', `找不到 --from-file：${replacementPath}`);
      }
      const replacement = readFileSync(replacementPath, 'utf8');
      const parsedReplacement = parseTaskFile(replacement, basename(replacementPath));
      if (parsedReplacement.fm.task_id !== taskId) {
        throw new CliUsageError(
          'TASK_ID_MISMATCH',
          `替换文件 task_id=${parsedReplacement.fm.task_id} 与目标 ${taskId} 不一致`,
        );
      }
      writeFileSync(taskPath, replacement);
      modified = replacement !== original;
      source = 'file';
    } else {
      const editor = configuredEditor as string;
      if (!options.json) console.log(`编辑：${taskPath}`);
      // 编辑器可能先写文件再以非零状态退出；提前进入回滚保护。
      modified = true;
      const editorResult = spawnSync(editor, [taskPath], {
        stdio: options.json ? ['inherit', 'ignore', 'inherit'] : 'inherit',
      });
      if (editorResult.error) {
        throw new CliUsageError('EDITOR_START_FAILED', `无法启动编辑器 ${editor}：${editorResult.error.message}`);
      }
      if (editorResult.status !== 0) {
        throw new CliUsageError('EDITOR_FAILED', `编辑器退出码 ${editorResult.status ?? 'unknown'}`);
      }
      modified = readFileSync(taskPath, 'utf8') !== original;
      source = 'editor';
    }

    try {
      const parsed = parsePlanDir(planDir);
      validateParsedPlan(parsed, taskPlanId);
      const editedTask = parsed.tasks.find((candidate) => candidate.fm.task_id === taskId);
      if (!editedTask) throw new Error(`找不到编辑后的任务 ${taskId}`);
      validateAcceptanceVerify([editedTask.fm]);
    } catch (error) {
      const rolledBack = !modified || restoreTaskFile(taskPath, original);
      modified = false;
      throw new CliUsageError('TASK_EDIT_INVALID', `编辑后的 plan 校验失败：${error instanceof Error ? error.message : String(error)}`, {
        rolled_back: rolledBack,
      });
    }

    let submitResult: ApiResult<Record<string, unknown>>;
    try {
      submitResult = apiResult<Record<string, unknown>>(await api('/plan/submit', {
        method: 'POST',
        body: JSON.stringify({ plan_dir: planDir }),
      }));
    } catch (error) {
      const rolledBack = !modified || restoreTaskFile(taskPath, original);
      modified = false;
      throw new CliUsageError('TASK_EDIT_SUBMIT_FAILED', `submit 请求失败：${error instanceof Error ? error.message : String(error)}`, {
        rolled_back: rolledBack,
      });
    }
    if (!submitResult.ok) {
      const rolledBack = !modified || restoreTaskFile(taskPath, original);
      modified = false;
      if (!options.json) console.log('保存后自动 submit：fail');
      throw new CliUsageError('TASK_EDIT_SUBMIT_FAILED', `submit 失败：${apiMessage(submitResult)}`, {
        rolled_back: rolledBack,
        service_error: submitResult.error,
      });
    }

    const platformUpdateExpected = (task.status ?? 'pending') === 'pending';
    outputSuccess(options.json, {
      operation: 'task_edit',
      plan_id: taskPlanId,
      task_id: taskId,
      task_path: taskPath,
      status: task.status ?? 'unknown',
      source,
      changed: readFileSync(taskPath, 'utf8') !== original,
      submitted: true,
      platform_update_expected: platformUpdateExpected,
      submit: submitResult.data ?? {},
    }, () => {
      if (platformUpdateExpected) {
        console.log('保存后自动 submit：ok（pending task 已允许更新）');
      } else {
        console.log(`保存后自动 submit：ok（平台保留 ${task.status ?? '当前'} 状态，本地 MD 不覆盖运行时任务）`);
      }
    });
  } catch (error) {
    if (modified && taskPath && original) restoreTaskFile(taskPath, original);
    const failure = error instanceof CliUsageError
      ? error
      : new CliUsageError('TASK_EDIT_FAILED', error instanceof Error ? error.message : String(error));
    outputFailure(json, failure.code, failure.message, failure.details);
  }
}

type RemoteTask = {
  task_id?: string;
  title?: string;
  type?: string;
  phase?: string;
  status?: string;
  assignee?: string;
  priority?: number;
  ownership?: { files?: string[]; modules?: string[] };
  depends_on?: string[];
  timeout_seconds?: number;
  max_retries?: number;
  model_override?: string;
  acceptance_for?: string[];
  verify?: unknown[];
  goal_md?: string;
};

type ComparableTask = {
  title: string;
  type: string;
  phase: string;
  assignee: string;
  priority: number;
  ownership_files: string[];
  ownership_modules: string[];
  depends_on: string[];
  timeout_seconds: number;
  max_retries: number;
  model_override: string;
  acceptance_for: string[];
  verify: unknown[];
  goal_md: string;
};

type FieldChange = { field: keyof ComparableTask; before: unknown; after: unknown };
type RevisionAction = 'create' | 'update' | 'skip_running' | 'skip_blocked' | 'skip_terminal' | 'skip_cancelled' | 'skip_superseded' | 'missing_local' | 'unchanged';
type RevisionChange = {
  task_id: string;
  status: string;
  action: RevisionAction;
  changed_fields: FieldChange[];
};

function normalizedStrings(values: string[] | undefined): string[] {
  return [...(values ?? [])].map((value) => value.trim()).filter(Boolean).sort();
}

function normalizedText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trimEnd();
}

function comparableLocal(parsed: ParsedPlan, task: ParsedPlan['tasks'][number]): ComparableTask {
  const fm = task.fm;
  return {
    title: fm.title,
    type: fm.type,
    phase: fm.phase,
    assignee: fm.assignee ?? parsed.plan.default_assignee ?? 'auto',
    priority: fm.priority ?? parsed.plan.default_priority ?? 5,
    ownership_files: normalizedStrings(fm.ownership?.files),
    ownership_modules: normalizedStrings(fm.ownership?.modules),
    depends_on: normalizedStrings(fm.depends_on),
    timeout_seconds: fm.timeout_seconds ?? defaultTimeout(fm.type),
    max_retries: fm.max_retries ?? 2,
    model_override: fm.model_override ?? '',
    acceptance_for: normalizedStrings(fm.acceptance_for),
    verify: fm.verify ?? [],
    goal_md: normalizedText(task.body),
  };
}

function comparableRemote(task: RemoteTask): ComparableTask {
  return {
    title: task.title ?? '',
    type: task.type ?? 'code',
    phase: task.phase ?? 'impl',
    assignee: task.assignee ?? 'auto',
    priority: task.priority ?? 5,
    ownership_files: normalizedStrings(task.ownership?.files),
    ownership_modules: normalizedStrings(task.ownership?.modules),
    depends_on: normalizedStrings(task.depends_on),
    timeout_seconds: task.timeout_seconds ?? defaultTimeout((task.type ?? 'code') as TaskType),
    max_retries: task.max_retries ?? 2,
    model_override: task.model_override ?? '',
    acceptance_for: normalizedStrings(task.acceptance_for),
    verify: task.verify ?? [],
    goal_md: normalizedText(task.goal_md),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fieldChanges(before: ComparableTask, after: ComparableTask): FieldChange[] {
  const fields = Object.keys(after) as Array<keyof ComparableTask>;
  return fields
    .filter((field) => stableJson(before[field]) !== stableJson(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function revisionAction(status: string, changes: FieldChange[]): RevisionAction {
  if (status === 'running') return 'skip_running';
  if (status === 'blocked') return 'skip_blocked';
  if (['done', 'failed'].includes(status)) return 'skip_terminal';
  if (status === 'cancelled') return 'skip_cancelled';
  if (status === 'superseded') return 'skip_superseded';
  if (changes.length === 0) return 'unchanged';
  return 'update';
}

function formatDiffValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\n/g, '\\n') || '∅';
  return JSON.stringify(value);
}

function printRevisionHuman(data: {
  plan_id: string;
  plan_dir: string;
  mode: string;
  status: Record<string, number>;
  summary: Record<RevisionAction, number>;
  changes: RevisionChange[];
  submit?: Record<string, unknown>;
}): void {
  console.log(`plan ${data.plan_id}（${data.mode}）`);
  console.log(`  状态：pending ${data.status.pending ?? 0} / running ${data.status.running ?? 0} / blocked ${data.status.blocked ?? 0} / done ${data.status.done ?? 0} / failed ${data.status.failed ?? 0} / cancelled ${data.status.cancelled ?? 0} / superseded ${data.status.superseded ?? 0}`);
  console.log(`  动作：新增 ${data.summary.create} / 更新 pending ${data.summary.update} / 跳过 running ${data.summary.skip_running} / 跳过 blocked ${data.summary.skip_blocked} / 跳过 done/failed ${data.summary.skip_terminal} / 跳过 cancelled ${data.summary.skip_cancelled} / 跳过 superseded ${data.summary.skip_superseded} / 磁盘缺失 ${data.summary.missing_local} / 无变化 ${data.summary.unchanged}`);
  console.log(`  源目录：${data.plan_dir}`);

  if (data.mode === 'diff') {
    for (const change of data.changes.filter((item) => item.action !== 'unchanged')) {
      console.log(`\n[${change.action}] ${change.task_id}（平台状态 ${change.status}）`);
      if (change.action === 'create') {
        console.log('  + 磁盘新任务；submit 将创建 pending 任务');
      } else if (change.action === 'missing_local') {
        console.log('  磁盘不存在；submit 不会删除平台任务，请显式执行 task cancel');
      } else if (change.action === 'skip_blocked') {
        console.log('  平台会保留 blocked 状态与阻塞上下文；本地 MD 不覆盖');
      } else if (change.action === 'skip_cancelled') {
        console.log('  平台会保留 cancelled 历史；本地 MD 不会复活任务');
      } else if (change.action === 'skip_superseded') {
        console.log('  平台会保留 superseded 结果与退出审计；本地 MD 不会复活任务');
      } else {
        for (const field of change.changed_fields) {
          console.log(`  - Redis ${field.field}: ${formatDiffValue(field.before)}`);
          console.log(`  + 磁盘 ${field.field}: ${formatDiffValue(field.after)}`);
        }
      }
    }
  }

  if (data.mode === 'submit') {
    console.log(`\n✓ 已调用 plan submit：${JSON.stringify(data.submit ?? {})}`);
  } else {
    console.log(`\n可执行操作：
  [1] 重新 submit（只覆盖 pending，其余状态保留）：biao plan revise ${data.plan_id} --submit
  [2] 加新任务：biao task add --plan ${data.plan_id} --task-id <id> --title "..."
  [3] 强制 reset running（危险，会打断 Worker）：biao task reset <task_id> --force
  [4] 查看 diff：biao plan revise ${data.plan_id} --diff

撤销不该做的 pending 任务：biao task cancel <task_id>`);
  }
}

export async function runPlanRevise(args: string[], api: CliApi): Promise<void> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    planHelp('revise');
    return;
  }
  try {
    const options = parseOptions(args, {
      preview: 'boolean',
      diff: 'boolean',
      submit: 'boolean',
      json: 'boolean',
    });
    assertNoExtraPositionals(options, 1, '用法：biao plan revise <plan_id> [--preview | --diff | --submit] [--json]');
    const planId = options.positionals[0];
    const modes = ['preview', 'diff', 'submit'].filter((name) => boolFlag(options, name));
    if (modes.length > 1) {
      throw new CliUsageError('CONFLICTING_OPTIONS', '--preview、--diff、--submit 只能选择一个');
    }
    const mode = (modes[0] ?? 'preview') as 'preview' | 'diff' | 'submit';

    const planResult = apiResult<PlanRead>(await api(`/plan/${encodeURIComponent(planId)}`));
    if (!planResult.ok || !planResult.data?.project_path || !planResult.data.tasks) {
      throw new CliUsageError('PLAN_NOT_FOUND', `plan 不存在或不可读取：${planId}`, planResult.error);
    }
    const planDir = safePlanDir(planResult.data.project_path, planId);
    const parsed = parsePlanDir(planDir);
    validateParsedPlan(parsed, planId);

    const status: Record<string, number> = {};
    const remoteSummaries = new Map<string, { task_id: string; status: string }>();
    for (const name of ['pending', 'running', 'blocked', 'done', 'failed', 'cancelled', 'superseded']) {
      const bucket = planResult.data.tasks[name] ?? [];
      status[name] = bucket.length;
      for (const item of bucket) {
        if (item.task_id) remoteSummaries.set(item.task_id, { task_id: item.task_id, status: item.status ?? name });
      }
    }
    const remoteEntries = await Promise.all([...remoteSummaries.values()].map(async (summary) => {
      const detail = apiResult<RemoteTask>(await api(`/task/${encodeURIComponent(summary.task_id)}`));
      if (!detail.ok || !detail.data) {
        throw new CliUsageError('TASK_FETCH_FAILED', `无法读取平台 task：${summary.task_id}`, detail.error);
      }
      return [summary.task_id, { ...detail.data, status: detail.data.status ?? summary.status }] as const;
    }));
    const remotes = new Map(remoteEntries);
    const locals = new Map(parsed.tasks.map((task) => [task.fm.task_id, task]));
    const changes: RevisionChange[] = [];

    for (const task of parsed.tasks) {
      const taskId = task.fm.task_id;
      const remote = remotes.get(taskId);
      if (!remote) {
        changes.push({ task_id: taskId, status: 'not_submitted', action: 'create', changed_fields: [] });
        continue;
      }
      const changedFields = fieldChanges(comparableRemote(remote), comparableLocal(parsed, task));
      changes.push({
        task_id: taskId,
        status: remote.status ?? 'unknown',
        action: revisionAction(remote.status ?? 'unknown', changedFields),
        changed_fields: changedFields,
      });
    }
    for (const [taskId, remote] of remotes) {
      if (!locals.has(taskId)) {
        changes.push({ task_id: taskId, status: remote.status ?? 'unknown', action: 'missing_local', changed_fields: [] });
      }
    }
    changes.sort((left, right) => left.task_id.localeCompare(right.task_id));
    const summary = {
      create: 0,
      update: 0,
      skip_running: 0,
      skip_blocked: 0,
      skip_terminal: 0,
      skip_cancelled: 0,
      skip_superseded: 0,
      missing_local: 0,
      unchanged: 0,
    } satisfies Record<RevisionAction, number>;
    for (const change of changes) summary[change.action]++;

    const data: {
      operation: string;
      mode: string;
      plan_id: string;
      plan_dir: string;
      status: Record<string, number>;
      summary: Record<RevisionAction, number>;
      changes: RevisionChange[];
      submitted: boolean;
      submit?: Record<string, unknown>;
      limitations: string[];
    } = {
      operation: 'plan_revise',
      mode,
      plan_id: planId,
      plan_dir: planDir,
      status,
      summary,
      changes,
      submitted: false,
      limitations: [
        '平台不保存 index.md 原文；preview/diff 只能比较平台 task 投影与本地 task MD。',
        '磁盘缺失的任务不会被 plan submit 删除；请显式执行 task cancel。',
        'plan submit 只更新 pending；running、blocked、done、failed、cancelled、superseded 会保留当前状态和历史。',
      ],
    };

    if (mode === 'submit') {
      const submitResult = apiResult<Record<string, unknown>>(await api('/plan/submit', {
        method: 'POST',
        body: JSON.stringify({ plan_dir: planDir }),
      }));
      if (!submitResult.ok) {
        throw new CliUsageError('PLAN_REVISE_SUBMIT_FAILED', `preview 已完成，但 submit 失败：${apiMessage(submitResult)}`, {
          preview: data,
          service_error: submitResult.error,
        });
      }
      data.submitted = true;
      data.submit = submitResult.data ?? {};
    }

    outputSuccess(options.json, data, () => printRevisionHuman(data));
  } catch (error) {
    const failure = error instanceof CliUsageError
      ? error
      : new CliUsageError('PLAN_REVISE_FAILED', error instanceof Error ? error.message : String(error));
    outputFailure(json, failure.code, failure.message, failure.details);
  }
}
