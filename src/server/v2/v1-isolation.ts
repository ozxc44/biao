/**
 * V1 隔离门（Phase 1 · 车道 C，R1A-003）
 *
 * 主方案 §13.1/§16：Project 启用 V2 后，其执行数据面必须改用
 * Node credential / Attempt Token（src/server/v2/credentials.ts），
 * V1 的全局 Worker 派生 token（http.ts deriveWorkerApiToken）对这类
 * Project 的 claim/report/renew/ownership declare/release 一律
 * 403 V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT。
 *
 * 判据 isV2EnabledProject(projectId) 可注入：车道 A 的 projects/
 * legacy_project_bindings 表落地前，默认实现读 env BIAO_V2_PROJECTS
 * 逗号清单（V1 侧项目标识 = project_path/project_scope）；store 落地后
 * 在装配点换成 store 谓词（legacy binding → projects 行存在且未 archived），
 * 门禁逻辑零改动。
 *
 * 请求 → 项目的解析只用 V1 已有真相，不引入新表：
 * - claim：body.preferred_project（显式声明），否则 preferred_plan_ids
 *   逐个读 plan hash 的 project_path；
 * - report/lease renew/ownership declare/release：body.task_id 经 V1
 *   getTask 投影取 project_path。
 * 解析失败（字段缺失、任务不存在、Redis 故障）时不拒绝——V1 错误语义由
 * 原 handler 给出，本门不制造新错误面；不带项目过滤的全局 claim 仍是
 * V1 语义（迁移期由运维停用全局 Worker token 收口，见交付说明）。
 *
 * 挂载点：共享横切 plugin（http-plugins.ts）onRequest 鉴权之后；
 * 仅约束 Worker 派生 token，V1 owner bearer / 本机 Owner 会话不受影响
 * （owner 可运维）。错误信息不含任何 token 内容。
 */

import { resolve } from 'node:path';
import type Redis from 'ioredis';
import { getTask } from '../service.js';
import { keys } from '../../redis/keys.js';

/** 隔离门拒绝码（响应 error.code；V1 错误信封风格）。 */
export const V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT = 'V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT';

/** V2 启用项目清单的环境变量名（默认谓词数据源）。 */
export const BIAO_V2_PROJECTS_ENV = 'BIAO_V2_PROJECTS';

/**
 * 判据谓词：projectId 为 V1 侧项目标识（project_path/project_scope）。
 * 车道 A store 落地后由装配点注入 store 谓词，签名不变。
 */
export type V2EnabledProjectPredicate = (projectId: string) => boolean;

/** 受守卫的 V1 Worker 数据面路由（已剥离 /api 前缀的相对路径）。 */
export const V1_WORKER_GUARDED_PATHS = [
  '/claim',
  '/report',
  '/lease/renew',
  '/ownership/declare',
  '/ownership/release',
] as const;

/**
 * 22.2-13/14：V1 plan/question mutation 隔离路由。
 * 对已启用 V2 的 project 全部拒绝。
 */
export const V1_PLAN_QUESTION_GUARDED_PATHS = [
  '/plan/create',
  '/plan/submit',
  '/plan/supersede',
  '/question/create',
  '/question/answer',
] as const;

/** 项目标识规范化：env 清单与请求侧候选取同一口径，封死尾斜杠/相对写法差异。 */
function normalizeProjectId(projectId: string): string {
  const trimmed = projectId.trim();
  return trimmed ? resolve(trimmed) : '';
}

/**
 * 默认谓词：BIAO_V2_PROJECTS 逗号清单精确匹配（规范化后比对）。
 * 未配置 = 没有 V2 项目 = 门禁 inert，V1 行为逐字节不变。
 */
export function envV2EnabledProjectPredicate(
  env: NodeJS.ProcessEnv = process.env,
): V2EnabledProjectPredicate {
  const enabled = new Set(
    (env[BIAO_V2_PROJECTS_ENV] ?? '').split(',').map(normalizeProjectId).filter(Boolean),
  );
  if (enabled.size === 0) return () => false;
  return (projectId: string): boolean => enabled.has(normalizeProjectId(projectId));
}

/**
 * 判据函数（Phase 1 任务书签名）：默认 env 谓词的直通实例，供脚本/诊断用；
 * 服务装配点（http-plugins）与车道 A store 落地后的切换点走
 * createV1IsolationGate 的可注入谓词，不经过本函数。
 */
export function isV2EnabledProject(projectId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return envV2EnabledProjectPredicate(env)(projectId);
}

/** 隔离门判定结果；rejected 时 projectId 为命中的 V2 项目（审计用，不含 token）。 */
export interface V1IsolationDecision {
  rejected: boolean;
  projectId?: string;
}

/** 隔离门：按 method/path/body 判定 V1 Worker 数据面请求是否命中 V2 项目。 */
export interface V1IsolationGate {
  guard(method: string, pathname: string, body: unknown): Promise<V1IsolationDecision>;
}

export interface V1IsolationGateOptions {
  isV2EnabledProject: V2EnabledProjectPredicate;
  /** 默认 task/plan 解析器的 Redis 句柄（与自定义解析器二选一）。 */
  redis?: Redis;
  /** task_id → 项目标识（默认：V1 getTask 投影的 project_path）。 */
  resolveTaskProject?: (taskId: string) => Promise<string | null>;
  /** plan_id → 项目标识（默认：直读 plan hash）。 */
  resolvePlanProject?: (planId: string) => Promise<string | null>;
}

/** task_id → project_path（V1 getTask 投影；任何故障按解析失败返回 null）。 */
export function defaultResolveTaskProject(redis: Redis): (taskId: string) => Promise<string | null> {
  return async (taskId: string): Promise<string | null> => {
    const result = await getTask(redis, taskId).catch(() => null);
    return result?.data?.project_path ?? null;
  };
}

/** plan_id → project_path（直读 plan hash，避免 getPlan 的投影回填写）。 */
export function defaultResolvePlanProject(redis: Redis): (planId: string) => Promise<string | null> {
  return async (planId: string): Promise<string | null> => {
    const hash = await redis.hgetall(keys.hash.plan(planId)).catch(() => null);
    return hash?.project_path ?? null;
  };
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function bodyString(body: unknown, field: string): string | null {
  const value = bodyRecord(body)[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function bodyStringArray(body: unknown, field: string): string[] {
  const value = bodyRecord(body)[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

/**
 * 组装隔离门。解析器出错按“解析失败”处理（不拒绝、不抛出），
 * 让原 handler 的错误语义保持 V1 兼容。
 */
export function createV1IsolationGate(options: V1IsolationGateOptions): V1IsolationGate {
  const { isV2EnabledProject } = options;
  if (!options.resolveTaskProject && !options.redis) {
    throw new Error('V1 隔离门需要 redis 或自定义 resolveTaskProject');
  }
  if (!options.resolvePlanProject && !options.redis) {
    throw new Error('V1 隔离门需要 redis 或自定义 resolvePlanProject');
  }
  const resolveTaskProject = options.resolveTaskProject ?? defaultResolveTaskProject(options.redis!);
  const resolvePlanProject = options.resolvePlanProject ?? defaultResolvePlanProject(options.redis!);

  return {
    async guard(method, pathname, body): Promise<V1IsolationDecision> {
      if (method !== 'POST') return { rejected: false };
      // 共享 plugin 同时挂在根路径与 /api 前缀，先统一剥前缀再比对。
      const path = pathname.replace(/^\/api(?=\/)/, '');
      const isWorkerRoute = (V1_WORKER_GUARDED_PATHS as readonly string[]).includes(path);
      const isPlanQuestionRoute = (V1_PLAN_QUESTION_GUARDED_PATHS as readonly string[]).includes(path);
      if (!isWorkerRoute && !isPlanQuestionRoute) return { rejected: false };

      const rejectFor = (projectId: string | null): V1IsolationDecision =>
        projectId && isV2EnabledProject(projectId) ? { rejected: true, projectId } : { rejected: false };

      // 22.2-13/14：V1 plan/question mutation 对 V2 项目拒绝
      if (isPlanQuestionRoute) {
        // plan 路由：从 body 提取 project 信息
        const planProject = bodyString(body, 'project_id') ?? bodyString(body, 'project_path');
        if (planProject) return rejectFor(planProject);
        // question 路由：从 plan_id 反查 project
        const planId = bodyString(body, 'plan_id');
        if (planId) {
          const planProject2 = await resolvePlanProject(planId);
          if (planProject2) return rejectFor(planProject2);
        }
        // question/answer：从 question_id 关联 task → project
        const taskId = bodyString(body, 'task_id');
        if (taskId) {
          return rejectFor(await resolveTaskProject(taskId));
        }
        return { rejected: false };
      }

      if (path === '/claim') {
        const explicit = bodyString(body, 'preferred_project');
        if (explicit) return rejectFor(explicit);
        for (const planId of bodyStringArray(body, 'preferred_plan_ids')) {
          const planProject = await resolvePlanProject(planId);
          if (planProject) {
            const decision = rejectFor(planProject);
            if (decision.rejected) return decision;
          }
        }
        return { rejected: false };
      }

      // report / lease renew / ownership declare|release：按 task 归属项目判定。
      const taskId = bodyString(body, 'task_id');
      if (!taskId) return { rejected: false };
      return rejectFor(await resolveTaskProject(taskId));
    },
  };
}

/** 403 响应体（V1 错误信封风格；message 不含任何 token 内容）。 */
export function v1CredentialRejectedError(projectId: string): {
  ok: false;
  data: null;
  error: { code: string; message: string };
} {
  return {
    ok: false,
    data: null,
    error: {
      code: V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT,
      message: `项目 ${projectId} 已启用 V2 数据面，V1 Worker 全局凭据被拒绝；请改用 Node credential / Attempt Token`,
    },
  };
}
