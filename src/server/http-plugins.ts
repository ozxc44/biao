/**
 * 共享 Fastify 横切 plugin（Phase 0a-2 · 评审项 R1B-004）
 *
 * 从 http.ts 内联钩子抽出的三个横切关注点，V1/V2 路由面共用：
 * 1. onRequest 鉴权：Owner Bearer / Worker 派生 token / 本机 Owner Cookie 三选一，
 *    Worker 凭据被限制在执行数据面（fail-closed 白名单）；
 * 2. preHandler 维护屏障 + mutation permit：restore barrier 下读写 fail-closed，
 *    写入口（含 watchdog auto_fix 与 intake 等有投影写入的 GET）先取 Redis
 *    分布式 permit；
 * 3. preSerialization 二次门控：关闭“读先开始、restore 后进入”的窗口；
 *    配套 onError/onResponse 在请求 settle 后按 owner 精确释放 permit。
 *
 * 装配方式（http.ts 只装配，§15.6）：
 *   await crossCuttingApiPlugin(app, { redis, apiToken, workerApiToken });
 * 直接在目标封装上下文内调用（而非 app.register）：Fastify 的 register 会为普通
 * plugin 创建子封装上下文，钩子就只覆盖子作用域、覆盖不到同级路由；直接调用等价于
 * 原先在 apiRoutes 闭包内 addHook 的顺序与作用域。V2 路由插件（routes/v2/*）
 * 在自己的作用域内以相同方式装配，实现 V1/V2 复用同一基础设施。
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type Redis from 'ioredis';
import type { BiaoConfig } from '../types/index.js';
import {
  isLoopbackHost,
  isValidLocalOwnerSession,
  readCookie,
  LOCAL_OWNER_COOKIE,
} from './human-session.js';
import {
  acquireMutationPermit,
  beginLocalMutation,
  getRestoreMaintenanceGate,
  releaseMutationPermit,
} from './maintenance.js';
// Phase 1（车道 C）V1 隔离门：V2 启用项目的执行数据面拒绝 V1 Worker 全局凭据。
import {
  createV1IsolationGate,
  envV2EnabledProjectPredicate,
  v1CredentialRejectedError,
  type V2EnabledProjectPredicate,
} from './v2/v1-isolation.js';
// 方案 E：远程人类 Cookie 会话（bvh2）与角色作用域判定。
import { HUMAN_ROLE_RANK, HUMAN_WEB_SESSION_TTL_SECONDS, type HumanSessionClaims } from './v2/human-identity.js';
import type { V2HumanRole } from '../types/v2-identity.js';

/** plugin 参数化配置：鉴权 token 与 Redis 句柄（与 http.ts 的 ScopedBiaoConfig 对齐）。 */
export interface CrossCuttingApiPluginOptions {
  redis: Redis;
  /** Owner Bearer token；未配置（auth_disabled）时 onRequest 鉴权直接放行。 */
  apiToken?: string;
  /** 从 Owner token 派生的 Worker token（http.ts deriveWorkerApiToken）。 */
  workerApiToken?: string;
  /** 服务绑定 host：本机 Owner Cookie 会话只在 loopback 部署可用（与服务配置一致）。 */
  host: string;
  /**
   * V2 启用项目判据（Phase 1 隔离门）：默认读 env BIAO_V2_PROJECTS 逗号清单；
   * 车道 A 的 projects/legacy_project_bindings store 落地后在装配点注入
   * store 谓词，此处一行切换。
   */
  isV2EnabledProject?: V2EnabledProjectPredicate;
  /**
   * 方案 E：人类身份服务（enrollment/会话签发/resolveCredential）。注入后
   * Cookie `biao_human_session` 中的有效 bvh2 与本机 Owner 会话并列放行；
   * 未注入（无 SQLite store 的纯 V1 部署）时远程人类会话不可用。
   */
  humanIdentity?: { resolveCredential: (token: string) => { ok: true; claims: HumanSessionClaims } | { ok: false; reason: string } };
}

/** 方案 E：远程人类会话 Cookie（HttpOnly + SameSite=Strict，TTL 与 bvh2 一致 30 天）。 */
export const HUMAN_SESSION_COOKIE = 'biao_human_session';

function isLocalOwnerSessionPath(pathname: string): boolean {
  // /auth/human-session（方案 E）与本机会话端点同为公开会话端点：不鉴权、不占 permit。
  return /^(?:\/api)?\/auth\/(?:session|local-session|human-session|human-login)$/.test(pathname);
}

export function humanSessionSetCookie(value: string): string {
  return `${HUMAN_SESSION_COOKIE}=${value}; Path=/; Max-Age=${HUMAN_WEB_SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict`;
}

export function humanSessionClearCookie(): string {
  return `${HUMAN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

/**
 * 解析 Cookie 中的远程人类会话：验签 + human_sessions 未吊销 + membership 活跃
 * （resolveCredential 全量复核，R1C-013 语义，每请求重查）。任何一步失败视为
 * 未携带会话（与未登录同响应 401，不区分失败原因以免探测）。
 */
export function resolveHumanSessionCredential(
  cookieHeader: string | undefined,
  humanIdentity: CrossCuttingApiPluginOptions['humanIdentity'],
): { token: string; claims: HumanSessionClaims } | null {
  if (!humanIdentity) return null;
  const token = readCookie(cookieHeader, HUMAN_SESSION_COOKIE);
  if (!token || !token.startsWith('bvh2_')) return null;
  const resolved = humanIdentity.resolveCredential(token);
  return resolved.ok ? { token, claims: resolved.claims } : null;
}

/** 本机 Owner Cookie 会话是否可用：需要 token 鉴权开启且服务绑定在 loopback。 */
export function localOwnerSessionAvailable(config: Pick<BiaoConfig, 'apiToken' | 'host'>): boolean {
  return Boolean(config.apiToken) && isLoopbackHost(config.host);
}

/** 校验请求 Cookie 是否携带有效的本机 Owner 会话。 */
export function hasLocalOwnerSession(
  cookieHeader: string | undefined,
  config: Pick<BiaoConfig, 'apiToken' | 'host'>,
): boolean {
  return Boolean(
    config.apiToken &&
    localOwnerSessionAvailable(config) &&
    isValidLocalOwnerSession(readCookie(cookieHeader, LOCAL_OWNER_COOKIE), config.apiToken),
  );
}

/**
 * Worker credentials are deliberately limited to the execution data plane.
 * Identity-looking fields such as reviewed_by/consumer are audit metadata, not
 * authorization, so they must never promote a Worker request into a PM request.
 */
export function workerRequestAllowed(method: string, pathname: string): boolean {
  const path = pathname.replace(/^\/api(?=\/)/, '');
  if (method === 'GET' || method === 'HEAD') {
    // Read access is also fail-closed: a future PM endpoint must not become Worker-readable
    // merely because it was not added to a denylist. These are the only reads used by BiaoClient.
    // Worker 需要当前 ownership roster 才能把共享工作树中的并发改动归给真正
    // 持有者；该只读数据面不包含 PM token、结果正文或控制面能力。
    return path === '/ownership' || path === '/ownership/active' || /^\/task\/[^/]+$/.test(path);
  }
  if (method !== 'POST') return false;
  return /^(?:\/register|\/heartbeat|\/agent\/offline|\/claim|\/report|\/question|\/lease\/renew|\/ownership\/(?:declare|release)|\/task\/[^/]+\/block)$/.test(path);
}

/**
 * V1 PM 数据面 mutation 白名单（方案 E）：远程人类 Cookie 会话中
 * reviewer/project_admin 可执行的写入口。与 workerRequestAllowed 同为
 * fail-closed 白名单——未来新增的 V1 写端点不会仅因为没进黑名单而自动开放。
 */
const HUMAN_V1_PM_MUTATION_PATH = /^(?:\/plan\/(?:submit|create)|\/plan\/[^/]+\/supersede|\/task\/[^/]+\/(?:cancel|supersede|reset|resume|review|resolution)|\/question\/[^/]+\/answer|\/intake\/ack|\/project\/agent-connections|\/project\/agent-bindings\/[^/]+|\/project\/agent-reservations|\/execution-receipts)$/;

/**
 * 方案 E：远程人类 Cookie 会话在 V1 面的角色作用域。
 * - 读面（GET/HEAD）：全部 human 角色放行（auditor 只读即在此）；
 *   例外：GET /watchdog?auto_fix=… 名义读、实为写入口（preHandler 按
 *   writer 取 permit），与 db/restore 同级仅 owner；
 * - mutation：auditor 一律拒绝；reviewer/project_admin 限 PM 数据面白名单；
 *   owner 是全路由超集（含 db/restore、reconcile 等运维写入口）；
 * - /v2 面不在此判定：根路径形态已注入 Authorization 交由 RBAC 矩阵逐路由
 *   判定；/api 前缀形态（RBAC 守卫不覆盖）fail-closed 仅 owner 放行。
 */
export function humanSessionV1RequestAllowed(
  method: string,
  pathname: string,
  role: V2HumanRole,
  query?: { get(name: string): string | null },
): boolean {
  const path = pathname.replace(/^\/api(?=\/)/, '');
  if (path === '/v2' || path.startsWith('/v2/')) return role === 'owner';
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/watchdog' && ['true', '1'].includes(query?.get('auto_fix') ?? '')) {
      return role === 'owner';
    }
    return true;
  }
  if (role === 'owner') return true;
  if (HUMAN_ROLE_RANK[role] < HUMAN_ROLE_RANK.reviewer) return false;
  return HUMAN_V1_PM_MUTATION_PATH.test(path);
}

/**
 * 共享横切 plugin：onRequest 鉴权 + preHandler permit/restore gate +
 * preSerialization barrier + permit 释放。行为与 Phase 0a-2 之前 http.ts 的
 * 内联实现逐行等价（等价性测试：tests/distributed/p0a2-plugin-parity.test.ts，
 * 全量 V1 套件作为回归门禁）。
 */
export const crossCuttingApiPlugin: FastifyPluginAsync<CrossCuttingApiPluginOptions> = async (
  app: FastifyInstance,
  options,
) => {
  const { redis, apiToken, workerApiToken, host } = options;
  const isolationGate = createV1IsolationGate({
    redis,
    isV2EnabledProject: options.isV2EnabledProject ?? envV2EnabledProjectPredicate(),
  });

  // onRequest 鉴权把“本请求用的是 Worker 派生 token”记到请求对象上，
  // 供其后的隔离门（preValidation）读取；owner bearer/本机会话不进此集合。
  const workerCredentialRequests = new WeakSet<object>();

  // permit owner 与本地写计数按请求生命周期绑定；连接 abort 也不会提前开门。
  const maintenancePermits = new WeakMap<object, {
    owner: string;
    leaveLocalMutation: () => void;
  }>();

  const releaseRequestPermit = async (req: object): Promise<void> => {
    const permit = maintenancePermits.get(req);
    if (!permit) return;
    maintenancePermits.delete(req);
    try {
      await releaseMutationPermit(redis, permit.owner);
    } finally {
      permit.leaveLocalMutation();
    }
  };

  const maintenanceDiagnosticPath = (pathname: string): boolean =>
    /^(?:\/api)?\/(?:health|version|db\/status|db\/restore)$/.test(pathname);

  const maintenanceStatus = (code: 'RESTORE_IN_PROGRESS' | 'RESTORE_FAILED'): number =>
    code === 'RESTORE_FAILED' ? 503 : 409;

  app.addHook('onRequest', async (req, reply) => {
    if (!apiToken) return;

    const requestUrl = new URL(req.raw.url ?? req.url, 'http://biao.local');
    const publicReadMethod = req.method === 'GET' || req.method === 'HEAD';
    const publicApiPath =
      publicReadMethod &&
      ['/health', '/version', '/api/health', '/api/version'].includes(requestUrl.pathname);
    const publicFrontendEntry =
      publicReadMethod &&
      requestUrl.pathname === '/' &&
      (req.headers.accept ?? '').includes('text/html') &&
      !(req.headers.accept ?? '').includes('application/json');
    if (publicApiPath || publicFrontendEntry || isLocalOwnerSessionPath(requestUrl.pathname)) return;

    const bearerAuthenticated = req.headers.authorization === `Bearer ${apiToken}`;
    const workerAuthenticated = Boolean(
      workerApiToken &&
      req.headers.authorization === `Bearer ${workerApiToken}`,
    );
    const humanAuthenticated = hasLocalOwnerSession(req.headers.cookie, { apiToken, host });
    // 方案 E：远程人类 Cookie 会话（bvh2）——验签 + human_sessions 未吊销 +
    // membership 活跃（resolveCredential 全量复核）。与本机 Owner 会话并列
    // 放行，不替换（loopback 部署继续用本地会话；NAS/远程用此通道）。
    const humanSession = resolveHumanSessionCredential(req.headers.cookie, options.humanIdentity);
    // /v2 根路径形态且未携带 Authorization 时，把 Cookie 会话注入为 Bearer：
    // 后续 rbac.ts 守卫按既有 bvh2 分类走完整 RBAC 矩阵（角色 rank、项目
    // 作用域、审计），本层不复制判定逻辑。显式 Authorization 头优先，不覆盖。
    if (humanSession && !req.headers.authorization && requestUrl.pathname.startsWith('/v2/')) {
      req.headers.authorization = `Bearer ${humanSession.token}`;
    }
    // V2 凭据（bvn2_ Node credential / bva2_ Attempt token / bvh2_ 人类会话 / bvm2_ Merge Bot，Phase 6+）
    // 由 V2 路由层（rbac.ts preHandler + handler）逐路由验签；
    // onRequest 只做放行（不验密码学），让后续守卫执行完整校验。
    // bvn2 Node credential 同时对 V1 只读面（GET /tasks、GET /task/:id、GET /plans、
    // GET /plan/:id、GET /status、GET /health）放行，使 Worker 可用 bvn2 token
    // 读取 V1 队列（不写 mutation）。
    const bvn2ForV1Read = Boolean(
      publicReadMethod &&
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer bvn2_') &&
      /^\/(?:tasks|task\/[^/]+|plans|plan\/[^/]+|status|health)$/.test(requestUrl.pathname.replace(/^\/api(?=\/)/, '')),
    );
    const v2CredentialPresent = Boolean(
      requestUrl.pathname.startsWith('/v2/') &&
      typeof req.headers.authorization === 'string' &&
      (req.headers.authorization.startsWith('Bearer bvn2_') || req.headers.authorization.startsWith('Bearer bva2_') || req.headers.authorization.startsWith('Bearer bvh2_') || req.headers.authorization.startsWith('Bearer bvm2_')),
    );
    if (!bearerAuthenticated && !workerAuthenticated && !humanAuthenticated && !v2CredentialPresent && !bvn2ForV1Read && !humanSession) {
      return reply.status(401).send({
        ok: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: '需要有效的 Bearer API token' },
      });
    }
    // 远程人类 Cookie 会话作为本次请求凭据时（无更高优先级凭据），按角色作用域
    // 判定 V1 面：auditor 只读、reviewer/project_admin 限 PM 数据面、owner 超集。
    if (humanSession && !bearerAuthenticated && !workerAuthenticated && !humanAuthenticated) {
      const scopePath = requestUrl.pathname.replace(/^\/api(?=\/)/, '');
      // 根路径 /v2/* 已注入 Authorization，RBAC 守卫会逐路由复核；/api 前缀
      // 形态（守卫按 req.raw.url 前缀判定、不覆盖该形态）在此 fail-closed。
      const v2PathHandledByRbac = requestUrl.pathname.startsWith('/v2/');
      if (!v2PathHandledByRbac &&
          !humanSessionV1RequestAllowed(req.method, scopePath, humanSession.claims.role, requestUrl.searchParams)) {
        return reply.status(403).send({
          ok: false,
          data: null,
          error: {
            code: 'HUMAN_SCOPE_DENIED',
            message: `远程人类会话角色 ${humanSession.claims.role} 无权执行 ${req.method} ${scopePath}`,
          },
        });
      }
    }
    if (workerAuthenticated && !workerRequestAllowed(req.method, requestUrl.pathname)) {
      return reply.status(403).send({
        ok: false,
        data: null,
        error: { code: 'WORKER_SCOPE_DENIED', message: 'Worker 凭据无权执行 PM/Owner 控制面操作' },
      });
    }
    if (workerAuthenticated) workerCredentialRequests.add(req);
  });

  // Phase 1（车道 C）V1 隔离门：位于 onRequest 鉴权之后（body 已解析的
  // preValidation 阶段）、preHandler mutation permit 之前——被拒请求不制造
  // permit。仅 Worker 派生 token 受约束；V1 owner bearer / 本机 Owner 会话
  // 不受影响（owner 可运维）。判据与项目解析见 src/server/v2/v1-isolation.ts。
  app.addHook('preValidation', async (req, reply) => {
    if (!workerApiToken || !workerCredentialRequests.has(req)) return;
    const requestUrl = new URL(req.raw.url ?? req.url, 'http://biao.local');
    const decision = await isolationGate.guard(req.method, requestUrl.pathname, req.body);
    if (decision.rejected && decision.projectId) {
      return reply.status(403).send(v1CredentialRejectedError(decision.projectId));
    }
  });

  // 所有 HTTP 状态写入口共用同一个 Redis 分布式 permit。db restore 自己取得独占锁；
  // watchdog 只有 auto_fix=true 时才是 writer。preHandler 位于鉴权/校验之后，避免为
  // 被拒请求制造无意义 permit；onResponse/onError 都按 owner 精确释放。
  app.addHook('preHandler', async (req, reply) => {
    const requestUrl = new URL(req.raw.url ?? req.url, 'http://biao.local');
    if (isLocalOwnerSessionPath(requestUrl.pathname)) return;
    const isRestore = /^(?:\/api)?\/db\/restore$/.test(requestUrl.pathname);
    const watchdogAutoFix = /^(?:\/api)?\/watchdog$/.test(requestUrl.pathname) &&
      ['true', '1'].includes(requestUrl.searchParams.get('auto_fix') ?? '');
    // intake/unacked 名义上是 GET，但会耐久更新 consumer cursor/pending 投影与门铃
    // 索引；恢复过程中放行会把旧 generation 再写回新快照，因此也属于 writer。
    const statefulProjectionRead = (req.method === 'GET' || req.method === 'HEAD') &&
      /^(?:\/api)?\/(?:intake(?:\/unacked)?|ownership)$/.test(requestUrl.pathname);
    if (isRestore) return;

    // 任意普通读在 failed/restoring barrier 下都不得暴露 Redis 半投影。
    // health/db status 是诊断口，health 自身会以 503 表达 not-ready。
    if ((req.method === 'GET' || req.method === 'HEAD') && !maintenanceDiagnosticPath(requestUrl.pathname)) {
      const gate = await getRestoreMaintenanceGate(redis);
      if (gate) {
        return reply.status(maintenanceStatus(gate.code)).send({ ok: false, data: null, error: gate });
      }
    }
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !watchdogAutoFix && !statefulProjectionRead) return;

    const leaveLocalMutation = beginLocalMutation();
    let permit: Awaited<ReturnType<typeof acquireMutationPermit>>;
    try {
      permit = await acquireMutationPermit(redis);
    } catch (error) {
      leaveLocalMutation();
      throw error;
    }
    if (!permit.ok) {
      leaveLocalMutation();
      return reply.status(maintenanceStatus(permit.error.code === 'RESTORE_FAILED' ? 'RESTORE_FAILED' : 'RESTORE_IN_PROGRESS'))
        .send({ ok: false, data: null, error: permit.error });
    }
    // restore 不会根据 score 越过 permit，因此不需要每请求定时续期。
    // owner 一直保留到 handler settle；连接 abort 也不会提前开门。
    maintenancePermits.set(req, { owner: permit.owner, leaveLocalMutation });
  });

  // 二次门控关闭“读先开始、restore 后进入”的窗口；同时使 permit
  // 仍在 settle 后才释放。
  app.addHook('preSerialization', async (req, reply, payload) => {
    const requestUrl = new URL(req.raw.url ?? req.url, 'http://biao.local');
    if (!maintenanceDiagnosticPath(requestUrl.pathname) && !isLocalOwnerSessionPath(requestUrl.pathname)) {
      const gate = await getRestoreMaintenanceGate(redis);
      if (gate) {
        reply.status(maintenanceStatus(gate.code));
        return { ok: false, data: null, error: gate };
      }
    }
    return payload;
  });

  // abort 后 Fastify handler/底层 promise 仍可能继续写，不能提前 release permit。
  // 真正释放只由 onResponse/onError（业务 settle 后）执行。

  app.addHook('onError', async (req) => {
    await releaseRequestPermit(req).catch(() => undefined);
  });
  app.addHook('onResponse', async (req) => {
    await releaseRequestPermit(req).catch(() => undefined);
  });
};
