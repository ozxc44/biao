/**
 * 规划 MD 解析器
 * 对应 docs/biao/02-planning-md-standard.md
 * 解析 plans/<plan-id>/index.md + tasks/*.md
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PlanFrontmatter, TaskFrontmatter } from '../types/index.js';

/** 解析 MD frontmatter（--- 之间的 YAML）和正文 */
export function parseMarkdown(raw: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  try {
    const frontmatter = parse(match[1]) as Record<string, unknown>;
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: null, body: raw };
  }
}

/** 解析 index.md */
export function parsePlanIndex(indexMd: string): PlanFrontmatter {
  const { frontmatter } = parseMarkdown(indexMd);
  if (!frontmatter) {
    throw new Error('index.md 缺少 frontmatter');
  }
  if (!frontmatter.plan_id || !frontmatter.project_path) {
    throw new Error('index.md frontmatter 缺少 plan_id 或 project_path');
  }
  return frontmatter as unknown as PlanFrontmatter;
}

/** 解析 task.md */
export function parseTaskFile(taskMd: string, fileName: string): { fm: TaskFrontmatter; body: string } {
  const { frontmatter, body } = parseMarkdown(taskMd);
  if (!frontmatter) {
    throw new Error(`${fileName} 缺少 frontmatter`);
  }
  if (!frontmatter.task_id || !frontmatter.title || !frontmatter.type || !frontmatter.phase) {
    throw new Error(`${fileName} frontmatter 缺少必填字段 (task_id/title/type/phase)`);
  }
  return { fm: frontmatter as unknown as TaskFrontmatter, body };
}

/** 解析整个 plan 目录 */
export interface ParsedPlan {
  plan: PlanFrontmatter;
  tasks: Array<{ fm: TaskFrontmatter; body: string }>;
}

export function parsePlanDir(planDir: string): ParsedPlan {
  const indexPath = join(planDir, 'index.md');
  if (!existsSync(indexPath)) {
    throw new Error(`找不到 ${indexPath}`);
  }
  const plan = parsePlanIndex(readFileSync(indexPath, 'utf8'));

  const tasksDir = join(planDir, 'tasks');
  const tasks: Array<{ fm: TaskFrontmatter; body: string }> = [];
  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir).filter((f) => f.endsWith('.md')).sort()) {
      const raw = readFileSync(join(tasksDir, file), 'utf8');
      tasks.push(parseTaskFile(raw, file));
    }
  }

  return { plan, tasks };
}

/**
 * DAG 循环检测（Kahn 拓扑排序）
 * 对应 docs/biao/03-task-dependency-and-phase.md
 */
export function detectCycle(tasks: TaskFrontmatter[]): string[] | null {
  const ids = new Set(tasks.map((t) => t.task_id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    inDegree.set(t.task_id, 0);
    adj.set(t.task_id, []);
  }
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`任务 ${t.task_id} 依赖不存在的任务 ${dep}`);
      }
      adj.get(dep)!.push(t.task_id);
      inDegree.set(t.task_id, (inDegree.get(t.task_id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let sortedCount = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    sortedCount++;
    for (const next of adj.get(node) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (sortedCount !== tasks.length) {
    // 有环，返回参与环的节点
    return [...inDegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
  }
  return null;
}

/**
 * acceptance_for 引用校验
 */
export function validateAcceptanceFor(tasks: TaskFrontmatter[]): void {
  const ids = new Set(tasks.map((t) => t.task_id));
  for (const t of tasks) {
    if (t.type !== 'acceptance') continue;
    if (
      !Array.isArray(t.acceptance_for) ||
      t.acceptance_for.length === 0 ||
      t.acceptance_for.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)
    ) {
      throw new Error(`验收任务 ${t.task_id} 必须声明非空 acceptance_for`);
    }
    for (const ref of t.acceptance_for) {
      if (!ids.has(ref)) {
        throw new Error(`验收任务 ${t.task_id} 的 acceptance_for 引用了不存在的任务 ${ref}`);
      }
    }
  }
}

/**
 * acceptance 的 Worker report 必须和计划里声明的 Verify 逐项匹配。
 * 因此规划入口必须在任务入队前拒绝空或损坏的验证结构，
 * 不能等 Worker 完成后才暴露 ACCEPTANCE_VERIFY_REQUIRED。
 */
export function validateAcceptanceVerify(tasks: TaskFrontmatter[]): void {
  for (const task of tasks) {
    if (task.type !== 'acceptance') continue;
    if (!Array.isArray(task.verify) || task.verify.length === 0) {
      throw new Error(`验收任务 ${task.task_id} 必须声明至少一项 verify`);
    }
    for (const [index, command] of task.verify.entries()) {
      if (!command || typeof command !== 'object' || typeof command.cmd !== 'string' || command.cmd.trim().length === 0) {
        throw new Error(`验收任务 ${task.task_id} 的 verify[${index}] 必须包含非空 cmd`);
      }
      if (command.expect_exit !== undefined && !Number.isSafeInteger(command.expect_exit)) {
        throw new Error(`验收任务 ${task.task_id} 的 verify[${index}].expect_exit 必须是整数`);
      }
      if (command.scope !== undefined && (typeof command.scope !== 'string' || command.scope.trim().length === 0)) {
        throw new Error(`验收任务 ${task.task_id} 的 verify[${index}].scope 必须是非空路径`);
      }
      if (command.timeout !== undefined && (!Number.isSafeInteger(command.timeout) || command.timeout <= 0)) {
        throw new Error(`验收任务 ${task.task_id} 的 verify[${index}].timeout 必须是正整数`);
      }
    }
  }
}

/**
 * phase 校验（task.phase 必须在 plan.phases 里定义）
 */
export function validatePhases(plan: PlanFrontmatter, tasks: TaskFrontmatter[]): void {
  if (!plan.phases) return;
  const phaseIds = new Set(plan.phases.map((p) => p.id));
  for (const t of tasks) {
    if (!phaseIds.has(t.phase)) {
      throw new Error(`任务 ${t.task_id} 的 phase "${t.phase}" 未在 index.md 定义`);
    }
  }
}
