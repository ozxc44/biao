/**
 * V2 RBAC 鉴权中间件（Phase 6 · §13.1/§13.2/§15.6/§21 Phase 6 验收矩阵）
 *
 * 挂在 V2 路由层（routes/v2-routes.ts 插件作用域的 preHandler）：
 * 1. 凭据分类：owner bearer / 本机 local-owner 会话 / bvh2 人类会话 /
 *    bvn2 Node credential / bva2 Attempt token（V1 worker token 在共享
 *    plugin 的 onRequest 已被拒出 /v2/ 写面）。
 * 2. 作用域判定：每条 registry 路由的运行时策略由 deriveCredentialPolicy
 *    从 credentialScopes 派生（owner | human(role≥x) | node | attempt），
 *    未登记路由按 owner-only fail-closed。
 * 3. 项目粒度：非 owner 会话只作用其绑定 project（§13.2 跨项目读取：
 *    membership 之外的 Artifact/Task/Delivery 一律 403）；attempt 凭据
 *    只读自己 attempt 的 Artifact/Delivery；node 凭据读项目资源需
 *    active NodeProjectBinding。
 * 4. 审计：全部拒绝（rbac.denied）与 owner/human 类的放行 mutation
 *    （v2.mutation）写入 audit_events，correlation_id 贯穿（§15.6）。
 *
 * 本文件不做 HTTP 注册：由 v2-routes.ts 以 addHook 装配（同一封装作用域，
 * 与共享 plugin 的钩子顺序 = onRequest 鉴权 → preValidation 隔离门 →
 * preHandler permit → 本守卫 → handler）。
 */

import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { V2CredentialKey } from './credentials.js';
import { verifyNodeCredential, verifyAttemptToken, verifyMergeBotToken } from './credentials.js';
import type { HumanIdentityService } from './human-identity.js';
import { HUMAN_ROLE_RANK } from './human-identity.js';
import type { V2HumanRole } from '../../types/v2-identity.js';
import {
  V2_ROUTES,
  deriveCredentialPolicy,
  type V2RouteCredentialPolicy,
  type V2RouteRegistryEntry,
} from './routes/registry.js';

/** 已分类的请求凭据（stamped 到 req.v2rbac，供 handler 取 actor/correlation）。 */
export type V2RequestCredential =
  | { kind: 'owner'; actorId: string }
  | { kind: 'human'; actorId: string; subject: string; role: V2HumanRole; projectId: string; sessionId: string }
  | { kind: 'node'; actorId: string }
  | { kind: 'attempt'; actorId: string }
  | { kind: 'merge_bot'; actorId: string; projectId: string };

export interface V2RbacRequestState {
  credential: V2RequestCredential;
  correlationId: string;
  /** 匹配到的 registry 条目 id（未登记路由为 null）。 */
  routeId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    v2rbac?: V2RbacRequestState;
  }
}

export interface V2RbacOptions {
  store: SqliteStore;
  /** V1 owner bearer（与共享 plugin 同源）；未配置（auth_disabled）时全部请求视为 owner。 */
  apiToken?: string;
  /** 服务绑定 host（本机 local-owner 会话仅 loopback 可用）。 */
  host: string;
  /** 动态密钥环（CredentialKeyringAuthority.resolve）。 */
  keyring: () => V2CredentialKey[];
  humanIdentity: HumanIdentityService;
  /** 本机 local-owner 会话校验（http-plugins 导出；注入以便单测）。 */
  hasLocalOwnerSession?: (cookieHeader: string | undefined) => boolean;
}

/* ------------------------------------------------------------------ */
/* registry 路由匹配（method + :param 形状）                           */
/* ------------------------------------------------------------------ */

interface RoutePattern {
  entry: V2RouteRegistryEntry;
  segments: string[];
}

const ROUTE_PATTERNS: ReadonlyMap<string, readonly RoutePattern[]> = (() => {
  const index = new Map<string, RoutePattern[]>();
  for (const entry of V2_ROUTES) {
    const pattern: RoutePattern = { entry, segments: entry.path.slice(1).split('/') };
    const list = index.get(entry.method) ?? [];
    list.push(pattern);
    index.set(entry.method, list);
  }
  return index;
})();

function matchRoute(method: string, path: string): { entry: V2RouteRegistryEntry; params: Record<string, string> } | null {
  const patterns = ROUTE_PATTERNS.get(method);
  if (!patterns) return null;
  const parts = path.replace(/\/+$/, '').slice(1).split('/');
  for (const pattern of patterns) {
    const { segments } = pattern;
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } else if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { entry: pattern.entry, params };
  }
  return null;
}

/** 未登记 /v2/ 路由的 fail-closed 默认策略：仅 owner。 */
export const UNREGISTERED_ROUTE_POLICY: V2RouteCredentialPolicy = {
  owner: true,
  node: false,
  attempt: false,
  merge_bot: false,
};

/* ------------------------------------------------------------------ */
/* 守卫实现                                                            */
/* ------------------------------------------------------------------ */

function bearerToken(headers: Record<string, unknown>): string | null {
  const auth = headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

function denied(reply: FastifyReply, status: 401 | 403 | 404 | 409, code: string, message: string): FastifyReply {
  return reply.status(status).send({ ok: false, data: null, error: { code, message } });
}

export function createV2RbacGuard(options: V2RbacOptions) {
  const { store, apiToken, keyring, humanIdentity } = options;
  const hasLocalOwnerSession = options.hasLocalOwnerSession
    ?? ((cookieHeader: string | undefined): boolean => {
      // 装配点注入实现（http-plugins.hasLocalOwnerSession）；此处仅保留类型完备的回退。
      return Boolean(apiToken) && options.host === '127.0.0.1' && Boolean(cookieHeader);
    });

  function audit(
    action: string,
    actorId: string,
    subjectType: string,
    subjectId: string,
    correlationId: string,
    projectId: string | null,
  ): void {
    store.insertAuditEvent({
      audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: projectId,
      actor_id: actorId,
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      correlation_id: correlationId,
      evidence_digest: '',
      created_at: Date.now(),
    });
  }

  /** 解析请求目标 project（路径/正文显式声明 → 资源反查；资源行 project_id 为空时回退 attempt 维度）。 */
  function resolveRequestProject(path: string, params: Record<string, string>, body: unknown): string | null {
    if (params.project_id) return params.project_id;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const projectId = (body as { project_id?: unknown }).project_id;
      if (typeof projectId === 'string' && projectId) return projectId;
    }
    if (params.artifact_id) {
      const artifact = store.getArtifact(params.artifact_id);
      if (!artifact) return null;
      const attempt = store.getTaskAttempt(artifact.attempt_id);
      return artifact.project_id || attempt?.project_id || null;
    }
    if (params.delivery_id) {
      const delivery = store.getDelivery(params.delivery_id);
      if (!delivery) return null;
      const attempt = store.getTaskAttempt(delivery.attempt_id);
      return delivery.project_id || attempt?.project_id || null;
    }
    if (params.attempt_id) {
      const attempt = store.getTaskAttempt(params.attempt_id);
      if (path.includes('/workspace')) return attempt?.project_id ?? null;
      return null;
    }
    return null;
  }

  /** bvn2 完整验签（遍历节点比对 node_id + generation fencing；与 v2-routes 同语义）。 */
  function verifyNodeBearer(token: string): { ok: true; nodeId: string } | { ok: false; reason: string } {
    const nodes = store.listNodes();
    for (const node of nodes) {
      const result = verifyNodeCredential(token, node.node_id, {
        keyring,
        expectedGeneration: node.credential_generation,
      });
      if (result.ok) return { ok: true, nodeId: node.node_id };
    }
    for (const node of nodes) {
      const result = verifyNodeCredential(token, node.node_id, { keyring });
      if (result.ok) {
        return {
          ok: false,
          reason: result.claims.generation !== node.credential_generation ? 'CREDENTIAL_FENCED' : 'UNAUTHORIZED',
        };
      }
    }
    return { ok: false, reason: 'UNAUTHORIZED' };
  }

  return async function v2RbacGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = req.raw.url?.split('?')[0] ?? req.url;
    if (!path.startsWith('/v2/')) return;

    const matched = matchRoute(req.method, path);
    const entry = matched?.entry ?? null;
    const params = matched?.params ?? {};
    const policy = entry ? deriveCredentialPolicy(entry) : UNREGISTERED_ROUTE_POLICY;

    const token = bearerToken(req.headers as Record<string, unknown>);
    const correlationHeader = req.headers['x-correlation-id'];
    const correlationId = (typeof correlationHeader === 'string' && correlationHeader.trim()) || `corr-${randomUUID()}`;
    reply.header('x-correlation-id', correlationId);

    const requestProject = resolveRequestProject(path, params, req.body);
    const routeLabel = entry?.id ?? `${req.method} ${path}`;

    /* ---- 凭据分类 ---- */
    let credential: V2RequestCredential;
    if (!apiToken) {
      credential = { kind: 'owner', actorId: 'owner' };
    } else if (token && token === apiToken) {
      credential = { kind: 'owner', actorId: 'owner' };
    } else if (hasLocalOwnerSession(req.headers.cookie)) {
      credential = { kind: 'owner', actorId: 'local-owner' };
    } else if (token?.startsWith('bvh2_')) {
      const resolved = humanIdentity.resolveCredential(token);
      if (!resolved.ok) {
        audit('rbac.denied', 'human:unknown', 'route', routeLabel, correlationId, requestProject);
        const status = resolved.reason === 'SESSION_REVOKED' || resolved.reason === 'SESSION_UNKNOWN' ? 401 : 401;
        return denied(reply, status, resolved.reason === 'NO_KEY_CONFIGURED' ? 'NO_KEY_CONFIGURED' : `HUMAN_${resolved.reason}`,
          `bvh2 会话凭据无效（${resolved.reason}）`);
      }
      credential = {
        kind: 'human',
        actorId: resolved.claims.subject,
        subject: resolved.claims.subject,
        role: resolved.claims.role,
        projectId: resolved.claims.project_id,
        sessionId: resolved.claims.session_id,
      };
    } else if (token?.startsWith('bvn2_')) {
      credential = { kind: 'node', actorId: `node:${token.slice(5, 13)}` };
    } else if (token?.startsWith('bva2_')) {
      credential = { kind: 'attempt', actorId: `attempt:${token.slice(5, 13)}` };
    } else if (token?.startsWith('bvm2_')) {
      // 22.3-04：Merge Bot 凭据分类（project 绑定，无 Agent/Plan 权限）
      // 验证 bvm2 token 并提取 project_id
      const projects = store.listProjects();
      let mergeBotVerified = false;
      let mergeBotProjectId = '';
      for (const project of projects) {
        const result = verifyMergeBotToken(token, {
          botId: `merge-bot-${project.project_id}`,
          projectId: project.project_id,
          scope: 'merge',
        }, { keyring });
        if (result.ok) {
          mergeBotVerified = true;
          mergeBotProjectId = project.project_id;
          break;
        }
      }
      if (!mergeBotVerified) {
        audit('rbac.denied', 'merge_bot:unknown', 'route', routeLabel, correlationId, requestProject);
        return denied(reply, 401, 'MERGE_BOT_UNAUTHORIZED', 'bvm2 Merge Bot 凭据无效');
      }
      credential = { kind: 'merge_bot', actorId: `merge_bot:${mergeBotProjectId}`, projectId: mergeBotProjectId };
    } else {
      audit('rbac.denied', 'anonymous', 'route', routeLabel, correlationId, requestProject);
      return denied(reply, 401, 'UNAUTHORIZED', '缺少有效的 V2 凭据');
    }

    req.v2rbac = { credential, correlationId, routeId: entry?.id ?? null };

    /* ---- 作用域判定（owner 全路由超集：V1 运维行为保持） ---- */
    if (credential.kind !== 'owner') {
      const allow =
        credential.kind === 'human' ? policy.human !== undefined :
        credential.kind === 'merge_bot' ? (entry?.credentialScopes as readonly string[] | undefined)?.includes('merge_bot') ?? false :
        policy[credential.kind];
      if (!allow) {
        audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
        return denied(reply, 403, 'RBAC_SCOPE_DENIED',
          `${credential.kind} 凭据不在 ${routeLabel} 的允许作用域内（owner | human(role≥${policy.human ?? '∅'}) | node=${policy.node} | attempt=${policy.attempt}）`);
      }
      if (credential.kind === 'human') {
        if (HUMAN_ROLE_RANK[credential.role] < HUMAN_ROLE_RANK[policy.human!]) {
          audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
          return denied(reply, 403, 'RBAC_ROLE_DENIED',
            `角色 ${credential.role} 低于 ${routeLabel} 要求的 ${policy.human}`);
        }
        // §13.2 跨项目读取：非 owner 会话只作用其绑定 project（membership 收口）
        if (credential.role !== 'owner' && requestProject && requestProject !== credential.projectId) {
          audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
          return denied(reply, 403, 'CROSS_PROJECT_DENIED',
            `会话绑定项目 ${credential.projectId || '(无)'} 无权访问项目 ${requestProject} 的资源`);
        }
      }
      if (credential.kind === 'merge_bot') {
        // 22.3-04：Merge Bot 只能操作绑定的 project
        if (requestProject && credential.projectId && requestProject !== credential.projectId) {
          audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
          return denied(reply, 403, 'MERGE_BOT_PROJECT_MISMATCH',
            `Merge Bot 绑定项目 ${credential.projectId} 无权操作项目 ${requestProject}`);
        }
      }
      if (credential.kind === 'node' || credential.kind === 'attempt') {
        // 项目资源读面：机器凭据必须绑定到资源所属项目/attempt（§22.3 方向收口）
        if (requestProject && (params.artifact_id || params.delivery_id) && req.method === 'GET') {
          if (credential.kind === 'node') {
            const verified = verifyNodeBearer(token!);
            if (!verified.ok) {
              audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
              return denied(reply, verified.reason === 'CREDENTIAL_FENCED' ? 409 : 401, verified.reason, `bvn2 验证失败（${verified.reason}）`);
            }
            const binding = store.getNodeProjectBinding(verified.nodeId, requestProject);
            if (!binding || binding.authorization_status !== 'authorized') {
              audit('rbac.denied', `node:${verified.nodeId}`, 'route', routeLabel, correlationId, requestProject);
              return denied(reply, 403, 'NODE_PROJECT_UNBOUND', `节点 ${verified.nodeId} 未获项目 ${requestProject} 授权`);
            }
            credential = { kind: 'node', actorId: `node:${verified.nodeId}` };
            req.v2rbac = { credential, correlationId, routeId: entry?.id ?? null };
          } else {
            const resourceAttemptId = params.artifact_id
              ? store.getArtifact(params.artifact_id)?.attempt_id
              : store.getDelivery(params.delivery_id)?.attempt_id;
            const attemptRow = resourceAttemptId ? store.getTaskAttempt(resourceAttemptId) : undefined;
            if (!resourceAttemptId || !attemptRow) {
              audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
              return denied(reply, 404, 'NOT_FOUND', '资源不存在');
            }
            const verified = verifyAttemptToken(token!, {
              attemptId: resourceAttemptId,
              taskId: attemptRow.task_id,
              generation: attemptRow.attempt_generation,
              scope: 'report',
            }, { keyring });
            if (!verified.ok) {
              audit('rbac.denied', credential.actorId, 'route', routeLabel, correlationId, requestProject);
              return denied(reply, verified.reason === 'GENERATION_MISMATCH' ? 409 : 401, verified.reason, `bva2 验证失败（${verified.reason}）`);
            }
            credential = { kind: 'attempt', actorId: `attempt:${resourceAttemptId}` };
            req.v2rbac = { credential, correlationId, routeId: entry?.id ?? null };
          }
        }
      }
    }

    /* ---- 审计：owner/human 类的放行 mutation（机器数据面有自己的 durable 记录） ---- */
    if (entry?.mutation && (credential.kind === 'owner' || credential.kind === 'human')) {
      audit('v2.mutation', credential.actorId, 'route', entry.id, correlationId, requestProject);
    }
  };
}
