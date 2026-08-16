/**
 * Generic-git ref ACL（22.3-10）
 *
 * per-project 规则：允许 ref 模式（biao attempt 分支、marker refs）；
 * 禁止默认分支/tag/他人 branch 前缀。
 * provider.push 前置 ACL 校验（拒绝即 push_forbidden 错误码 + 审计）。
 *
 * 22.3-17：handleRefAclMiss 核心逻辑（fencing + write_capability=lost + incident）
 * 从 queue.ts 提取到此处，queue.ts 和 workspace.ts 均可调用。
 */

/** 单条 ACL 规则：pattern 是 glob 风格的 ref 匹配。 */
export interface RefAclRule {
  /** 允许的 ref 模式（glob: * 匹配单段, ** 匹配多段）。 */
  pattern: string;
  /** 规则描述（审计/日志用）。 */
  description: string;
}

/** 项目级 ref ACL 配置。 */
export interface ProjectRefAcl {
  /** 允许 push 的 ref 规则列表（任一匹配即放行）。 */
  allow: RefAclRule[];
  /** 显式禁止的 ref 规则列表（优先于 allow）。 */
  deny: RefAclRule[];
}

/** push 审计记录。 */
export interface RefAclAuditEntry {
  project_id: string;
  ref: string;
  decision: 'allow' | 'push_forbidden';
  rule?: string;
  reason?: string;
  timestamp: number;
}

/** glob → RegExp（与 ownership-gate.ts 同构，ref 路径用）。 */
function refGlobToRegExp(pattern: string): RegExp {
  if (pattern === '*') return /.*/;
  let source = '';
  let i = 0;
  const leadingDoubleStar = pattern.startsWith('**/');
  if (leadingDoubleStar) {
    source += '(?:.*/)?';
    i = 3;
  }
  for (; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** 检查 ref 是否匹配任一规则。 */
function matchesAnyRule(ref: string, rules: RefAclRule[]): RefAclRule | null {
  for (const rule of rules) {
    if (refGlobToRegExp(rule.pattern).test(ref)) return rule;
  }
  return null;
}

/**
 * ref ACL 校验结果。
 */
export type RefAclDecision =
  | { allowed: true; rule: RefAclRule }
  | { allowed: false; reason: string; denyRule?: RefAclRule };

/**
 * 校验 push ref 是否被 ACL 允许。
 * 优先级：deny > allow > 默认拒绝。
 */
export function checkRefAcl(ref: string, acl: ProjectRefAcl): RefAclDecision {
  // 1. deny 规则优先
  const denyMatch = matchesAnyRule(ref, acl.deny);
  if (denyMatch) {
    return { allowed: false, reason: `ref ${ref} 匹配禁止规则：${denyMatch.description}`, denyRule: denyMatch };
  }
  // 2. allow 规则
  const allowMatch = matchesAnyRule(ref, acl.allow);
  if (allowMatch) {
    return { allowed: true, rule: allowMatch };
  }
  // 3. 默认拒绝
  return { allowed: false, reason: `ref ${ref} 未匹配任何允许规则（默认拒绝）` };
}

/**
 * 默认 ACL 规则集（generic-git 标准项目）：
 * - 允许：refs/heads/biao/attempt/*（task attempt 分支）
 * - 允许：refs/biao/attempt-markers/**（marker refs）
 * - 禁止：refs/heads/<default_branch>（默认分支）
 * - 禁止：refs/tags/**（tag）
 * - 禁止：其他非 biao/attempt 前缀的分支
 */
export function createDefaultRefAcl(defaultBranch: string): ProjectRefAcl {
  return {
    allow: [
      { pattern: `refs/heads/biao/attempt/*`, description: 'biao attempt 分支' },
      { pattern: `refs/biao/attempt-markers/**`, description: 'marker refs' },
    ],
    deny: [
      { pattern: `refs/heads/${defaultBranch}`, description: `默认分支 ${defaultBranch}` },
      { pattern: `refs/tags/**`, description: 'tag refs' },
      { pattern: `refs/heads/main`, description: 'main 分支' },
      { pattern: `refs/heads/master`, description: 'master 分支' },
    ],
  };
}

/**
 * 从 projects.ref_acl_json（Migration 012）解析 ProjectRefAcl。
 * 这是 ref ACL 规则的唯一持久来源：generic-git push 校验（22.3-10）与
 * hasRefAcl 实存判断（22.3-13）都从这里取规则，保证"同一规则来源"。
 * 空串 / 缺失 / 非法 JSON / 无有效 allow 规则 → 一律 null（无配置即无 ACL）。
 */
export function parseRefAcl(json: string | null | undefined): ProjectRefAcl | null {
  if (!json || typeof json !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { allow, deny } = parsed as { allow?: unknown; deny?: unknown };
  const isRule = (r: unknown): r is RefAclRule => (
    typeof r === 'object'
    && r !== null
    && typeof (r as RefAclRule).pattern === 'string'
    && (r as RefAclRule).pattern.length > 0
  );
  // allow 为空 = 未配置允许面：默认拒绝下等价于"没有 ACL"，按无配置处理。
  const allowRules = Array.isArray(allow) ? allow.filter(isRule) : [];
  if (allowRules.length === 0) return null;
  const denyRules = Array.isArray(deny) ? deny.filter(isRule) : [];
  return { allow: allowRules, deny: denyRules };
}

/**
 * ref ACL 连续丢失跟踪器（22.3-17）。
 * 连续 N 次确认 ref ACL 不存在 → 触发熔断。
 */
export class RefAclMissTracker {
  private consecutiveMisses = new Map<string, number>();
  private readonly threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /** 记录一次 ACL 丢失。返回是否达到熔断阈值。 */
  recordMiss(projectId: string): boolean {
    const current = (this.consecutiveMisses.get(projectId) ?? 0) + 1;
    this.consecutiveMisses.set(projectId, current);
    return current >= this.threshold;
  }

  /** 确认 ACL 存在，重置计数。 */
  recordHit(projectId: string): void {
    this.consecutiveMisses.delete(projectId);
  }

  /** 获取当前连续丢失次数。 */
  getMissCount(projectId: string): number {
    return this.consecutiveMisses.get(projectId) ?? 0;
  }

  /** 重置指定项目的计数。 */
  reset(projectId: string): void {
    this.consecutiveMisses.delete(projectId);
  }
}

// ──────────────── 22.3-17：ref ACL 连续丢失熔断核心逻辑 ────────────────

import type { SqliteStore } from '../../../db/sqlite-store.js';

/**
 * 22.3-17：ref ACL 确认连续丢失后执行熔断——fencing 全部 executing attempt +
 * write_capability_status=lost + incident 开单。
 *
 * 从 queue.ts handleRefAclMiss 提取为纯函数，供 queue.ts（带 RefAclMissTracker）
 * 和 workspace.ts（push_forbidden 直接触发）共用。
 *
 * @param options.createIncident - 可选的 incident 创建函数（避免循环依赖 incident-service）。
 */
export function executeRefAclMissCircuitBreaker(
  store: SqliteStore,
  projectId: string,
  ts: number,
  options: {
    missCount?: number;
    createIncident?: (input: {
      project_id: string;
      kind: string;
      severity: 'critical';
      title: string;
      detail: string;
      related_entity_type: string;
      related_entity_id: string;
    }) => void;
  } = {},
): void {
  // 1. fencing 全部 running write attempt
  const runningAttempts = store.listTaskAttemptsByProject(projectId, 'executing');
  for (const attempt of runningAttempts) {
    store.updateTaskAttempt(attempt.attempt_id, {
      status: 'fenced',
      failure_reason: 'ref_acl_miss_circuit_breaker',
      updated_at: ts,
      completed_at: ts,
    });
  }

  // 2. 撤销 push/merge credential（标记 write_capability_status=lost）
  store.updateProject(projectId, {
    write_capability_status: 'lost',
    updated_at: ts,
  });

  // 3. incident 开单
  const missCount = options.missCount ?? 0;
  options.createIncident?.({
    project_id: projectId,
    kind: 'ref_acl_miss_circuit_breaker',
    severity: 'critical',
    title: `ref ACL 连续丢失熔断：${projectId}`,
    detail: `项目 ${projectId} ref ACL 连续 ${missCount} 次确认丢失，已触发熔断：fencing 全部 running write attempt + 撤销 write capability`,
    related_entity_type: 'project',
    related_entity_id: projectId,
  });
}
