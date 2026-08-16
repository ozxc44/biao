/**
 * V2 路由插件（Phase 1→2+3 集成；Phase 6 挂 RBAC 守卫）
 *
 * 注册 V2 API 路由，走 registry 声明 + 共享 plugin。
 * 鉴权分层：
 * - 管理面（enroll/authorize/revoke/drain/身份与凭据生命周期）：owner bearer
 *   + bvh2 人类会话（rbac.ts preHandler 按 registry 派生策略逐路由判定）
 * - 节点数据面（register/heartbeat/offline/node scope）：bvn2 Node credential
 * - attempt 数据面（claim/renew/report）：bva2 Attempt token 或 bvn2 Node credential
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { SqliteStore } from '../../../db/sqlite-store.js';
import { crossCuttingApiPlugin, hasLocalOwnerSession } from '../../http-plugins.js';
import { createProjectService } from '../project-service.js';
import {
  advanceModeTransition,
  resyncNodeProjectBinding,
  retryModeTransition,
  resumeInterruptedModeTransitions,
  runModeTransitionAuto,
} from '../project-service.js';
import {
  createRecoveryIsolationRecord,
  reviewRecoveryIsolationRecord,
  resolveRecoveryIsolationRecord,
  runBatchRecoveryActions,
  runControlPlaneDiscard,
  runControlPlaneTakeover,
} from '../recovery-decision.js';
import { reconcileThreeWay } from '../reconcile-three-way.js';
import { createNodeService } from '../node-service.js';
import { createArtifactService, reportV2WithArtifacts, getDeliveryReviewView } from '../artifact-service.js';
import { createDeliveryService } from '../delivery-service.js';
import { createMergeService } from '../merge-service.js';
import { GenericGitProvider } from '../git/generic-git.js';
import { createWorkspaceService } from '../git/workspace.js';
import { loadV2CredentialKeyring, type V2CredentialKey } from '../credentials.js';
import { ArtifactStoreEngine } from '../../artifact-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  verifyNodeCredential,
  verifyAttemptToken,
  issueNodeCredential,
  issueAttemptToken,
  CredentialKeyringAuthority,
  type IssueCredentialOptions,
  type AttemptTokenScope,
} from '../credentials.js';
import { createHumanIdentityService, createCredentialLifecycleService } from '../human-identity.js';
import { createV2RbacGuard } from '../rbac.js';
import type { V2ActorContext } from '../domain-interfaces.js';
import { createIncidentService } from '../incident-service.js';
import { createBackupCoordinator } from '../backup.js';
import { createMetricsService } from '../metrics.js';
import {
  describeV2FeatureFlags,
  requiredV2FeatureFlagForPath,
  resolveAndValidateV2FeatureFlags,
  V2_FEATURE_FLAG_ENV_NAMES,
  type V2FeatureFlags,
} from '../feature-flags.js';

/** 已在本次进程启动执行过 resume 的 store（apiRoutes 双注册去重）。 */
const resumedStoresPerProcess = new WeakSet<SqliteStore>();

export interface V2RoutesOptions {
  store: SqliteStore;
  credentialOptions?: IssueCredentialOptions;
  artifactRoot?: string;
  /** §6.2 clone-per-attempt 缓存根（默认 <tmp>/biao-workspaces）。 */
  workspaceCacheRoot?: string;
  /** Phase 6：owner bearer（RBAC 凭据分类用；与共享 plugin 同源）。 */
  apiToken?: string;
  /** Phase 6：服务绑定 host（本机 local-owner 会话仅 loopback 可用）。 */
  host?: string;
  /**
   * Phase 8 五旗（§23.1）。缺省从 env 解析并做依赖序校验——乱序在装配期
   * 抛错（fail-fast，指明缺哪面旗）；显式注入仅测试用。
   */
  featureFlags?: V2FeatureFlags;
}

/** 从 Authorization 头提取 bearer token。 */
function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  if (typeof auth !== 'string') return null;
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

/** bvn2 Node credential 验证结果。 */
interface NodeAuthResult {
  ok: boolean;
  nodeId?: string;
  generation?: number;
  error?: { code: string; message: string };
}

/** 验证 bvn2 Node credential（尝试 node credential，不回退 owner）。 */
function verifyNodeBearer(
  token: string,
  store: SqliteStore,
  credOpts: IssueCredentialOptions,
): NodeAuthResult {
  // 猜测 node_id：token payload 里有 node_id，但 verify 需要先知道 node_id
  // 策略：遍历所有 node 做 verify（节点数有限），或用 store 查找
  const nodes = store.listNodes();
  for (const node of nodes) {
    const result = verifyNodeCredential(token, node.node_id, {
      ...credOpts,
      expectedGeneration: node.credential_generation,
    });
    if (result.ok) {
      return { ok: true, nodeId: node.node_id, generation: result.claims.generation };
    }
  }
  // 也尝试不带 generation 校验（credential 可能来自旧 generation 但仍有效）
  const secondPassReasons = new Set<string>();
  for (const node of nodes) {
    const result = verifyNodeCredential(token, node.node_id, credOpts);
    if (result.ok) {
      // generation 不匹配：fenced
      if (result.claims.generation !== node.credential_generation) {
        return { ok: false, error: { code: 'CREDENTIAL_FENCED', message: `节点 ${node.node_id} 凭据 generation 已过期` } };
      }
      return { ok: true, nodeId: node.node_id, generation: result.claims.generation };
    }
    if (!result.ok && result.reason !== 'SUBJECT_MISMATCH') secondPassReasons.add(result.reason);
  }
  // revoke-all 前滚 key_version 后旧 token 的稳定原因（审计/测试断言用）
  if (secondPassReasons.has('UNKNOWN_KEY_VERSION')) {
    return { ok: false, error: { code: 'UNKNOWN_KEY_VERSION', message: 'bvn2 Node credential 的 key_version 已被撤销（revoke-all）' } };
  }
  if (secondPassReasons.has('EXPIRED')) {
    return { ok: false, error: { code: 'EXPIRED', message: 'bvn2 Node credential 已过期' } };
  }
  return { ok: false, error: { code: 'UNAUTHORIZED', message: 'bvn2 Node credential 无效' } };
}

/**
 * V2 路由插件：注册所有 /v2/* 路由。
 * 装配方式：await app.register(v2RoutesPlugin, { store, credentialOptions })
 */
export const v2RoutesPlugin: FastifyPluginAsync<V2RoutesOptions> = async (app, options) => {
  const { store, credentialOptions } = options;

  // ── Phase 8 五旗装配（§23.1）──────────────────────────────────
  // 乱序（如开 MERGE_QUEUE 但 GIT_DELIVERY 未开）在这里抛错：服务 boot 失败，
  // 错误消息指明缺哪面旗（resolveAndValidateV2FeatureFlags 的 fail-fast 语义）。
  const featureFlags = options.featureFlags ?? resolveAndValidateV2FeatureFlags(process.env);

  if (!featureFlags.DISTRIBUTED_MODE) {
    // 默认全关 = 纯 V1 行为：/v2 面整体停用（回退窗口，§23.2）。状态端点保留，
    // 否则关旗后无法观测当前旗态。
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'GET' && (req.url === '/v2/feature-flags' || req.url.startsWith('/v2/feature-flags?'))) {
        return;
      }
      return reply.status(404).send({
        ok: false,
        data: null,
        error: {
          code: 'V2_DISABLED',
          message: `V2 面未启用（${V2_FEATURE_FLAG_ENV_NAMES.DISTRIBUTED_MODE} 关闭）。` +
            '当前为纯 V1 行为；旗态见 GET /v2/feature-flags，启用顺序见 docs/runbooks/phase8-rollout.md',
        },
      });
    });
  } else {
    // 分旗门禁：路由组旗未开 → 404 V2_FLAG_DISABLED（关闭行为，非鉴权错误）。
    app.addHook('onRequest', async (req, reply) => {
      const flag = requiredV2FeatureFlagForPath(req.url.split('?')[0] ?? req.url);
      if (flag === null || featureFlags[flag]) return;
      return reply.status(404).send({
        ok: false,
        data: null,
        error: {
          code: 'V2_FLAG_DISABLED',
          message: `${V2_FEATURE_FLAG_ENV_NAMES[flag]} 未开启：${req.method} ${req.url.split('?')[0]} 已关闭`,
        },
      });
    });
  }

  // Phase 6：运行时密钥环权威 = env 密钥环 ∪ DB 轮换密钥，按 min_key_version
  // 水位过滤（revoke-all-sessions 前滚后旧 token 立即失效、新签发继续）。
  // 显式注入 credentialOptions（测试）时保持静态密钥环语义不变。
  const authority = new CredentialKeyringAuthority({
    loadEnvKeys: (): V2CredentialKey[] => {
      try {
        return loadV2CredentialKeyring();
      } catch {
        return [];
      }
    },
    loadPersistedKeys: () => store.listCredentialKeyRecords(),
    loadMinKeyVersion: () => store.getCredentialState().min_key_version,
  });
  const credOpts: IssueCredentialOptions = credentialOptions ?? authority.options();
  const projectService = createProjectService(store);
  const nodeService = createNodeService(store, { credentialOptions: credOpts });

  // Artifact Store（Phase 2）
  const artifactRoot = options.artifactRoot ?? join(tmpdir(), 'biao-artifacts');
  const artifactEngine = new ArtifactStoreEngine({ root: artifactRoot, store });
  const artifactService = createArtifactService({ store, artifactEngine });

  // Git Workspace + Delivery 状态机（Phase 4）。密钥环未配置时 fail-closed：
  // 路由返回 NOT_CONFIGURED，不降级为无签名 marker（malformed env 同样视为未配置，
  // 不让插件装配抛错影响既有路由）。
  const gitProvider = new GenericGitProvider();
  let markerKeyring: V2CredentialKey[] = [];
  if (credentialOptions?.keys) {
    markerKeyring = credentialOptions.keys;
  } else {
    try {
      markerKeyring = loadV2CredentialKeyring();
    } catch {
      markerKeyring = [];
    }
  }
  const workspaceCacheRoot = options.workspaceCacheRoot ?? join(tmpdir(), 'biao-workspaces');
  const workspaceService = markerKeyring.length > 0
    ? createWorkspaceService({ store, provider: gitProvider, keyring: markerKeyring, nodeCacheRoot: workspaceCacheRoot })
    : null;
  const deliveryService = markerKeyring.length > 0
    ? createDeliveryService({ store, provider: gitProvider, keyring: markerKeyring })
    : null;

  // Merge Queue（Phase 5）
  const mergeService = createMergeService({ store, provider: gitProvider });

  // Incident Service（Phase 7a）
  const incidentService = createIncidentService({ store });

  // Backup Coordinator（Phase 7a）
  const backupDir = join(tmpdir(), 'biao-backups');
  const backupCoordinator = createBackupCoordinator({ store, dbPath: ':memory:', artifactRoot, backupDir });

  // Metrics Service（Phase 7a）
  const metricsService = createMetricsService({ store });

  // Human Identity + 凭据生命周期（Phase 6）
  const humanIdentity = createHumanIdentityService(store, {
    keyring: (): V2CredentialKey[] => (credentialOptions?.keys ?? authority.resolve()),
  });
  const credentialLifecycle = createCredentialLifecycleService(store, {
    keyring: (): V2CredentialKey[] => (credentialOptions?.keys ?? authority.resolve()),
    persistEmergencyRevocation: (newKey, minKeyVersion, actor, reason) =>
      store.applyEmergencyRevocation(newKey, minKeyVersion, actor, reason),
    nextKeyVersion: () => (credentialOptions?.keys
      ? Math.max(...credentialOptions.keys.map((key) => key.key_version)) + 1
      : authority.nextKeyVersion()),
  });

  // Phase 6 RBAC 守卫：必须先于全部路由注册（Fastify hook 按注册顺序快照）。
  // 凭据分类 = owner bearer / local-owner 会话 / bvh2 / bvn2 / bva2；
  // 作用域判定按 registry 派生策略（owner | human(role≥x) | node | attempt）。
  const apiToken = options.apiToken;
  const host = options.host ?? '127.0.0.1';
  const rbacGuard = createV2RbacGuard({
    store,
    apiToken,
    host,
    keyring: (): V2CredentialKey[] => (credentialOptions?.keys ?? authority.resolve()),
    humanIdentity,
    hasLocalOwnerSession: (cookieHeader) =>
      apiToken ? hasLocalOwnerSession(cookieHeader, { apiToken, host }) : false,
  });
  app.addHook('preHandler', rbacGuard);

  /**
   * Recovery decision 签名密钥：复用控制面 signing key（车道 C 范围内不新增
   * 独立 Recovery Signing Key 面）。与 humanIdentity/credentialLifecycle 同源：
   * 显式注入（测试）用静态 keyring，否则 env ∪ DB 轮换密钥。keyring 为空时
   * 签发 fail-closed（NOT_CONFIGURED），绝不返回无签名裁决（§18 矩阵）。
   */
  const recoverySigningKeyring = (): V2CredentialKey[] =>
    credentialOptions?.keys ?? authority.resolve();

  // 22.4-04 重启续跑：服务启动时扫描 running transition——未过期者从 durable
  // step 继续执行一步（后续由 advance 路由/自动推进接力），超 24h 者置
  // expired 并落 RecoveryIsolation 留证。
  // http.ts 把 apiRoutes 注册两次（根路径 + /api 前缀），插件体随之执行两次；
  // 以 store 为键去重，保证一次进程启动只续跑一轮。
  const resumedStoresForBoot = resumedStoresPerProcess;
  if (!resumedStoresForBoot.has(store)) {
    resumedStoresForBoot.add(store);
    resumeInterruptedModeTransitions(store);
  }

  const workspaceNotConfigured = {
    ok: false as const,
    data: null,
    error: { code: 'NOT_CONFIGURED', message: 'BIAO_V2_CREDENTIAL_KEY 未配置，Git Workspace 面未启用' },
  };
  const deliveryNotConfigured = {
    ok: false as const,
    data: null,
    error: { code: 'NOT_CONFIGURED', message: 'BIAO_V2_CREDENTIAL_KEY 未配置，Delivery 状态机未启用' },
  };

  /** 从请求中提取 actor context（owner 模式，通过 crossCuttingApiPlugin 鉴权） */
  function extractOwnerActor(): V2ActorContext {
    return { actor_kind: 'human_owner', actor_id: 'owner' };
  }

  /**
   * Phase 6：RBAC 守卫 stamp 的请求状态 → 服务层 meta（actor/correlation 贯穿；
   * 人类会话请求以会话 subject 为 actor，owner 请求保持 'owner'）。
   */
  function requestActor(req: FastifyRequest): V2ActorContext {
    const rbac = req.v2rbac;
    if (!rbac) return extractOwnerActor();
    if (rbac.credential.kind === 'human') {
      return { actor_kind: 'reviewer_pm', actor_id: rbac.credential.subject };
    }
    if (rbac.credential.kind === 'node') {
      return { actor_kind: 'node', actor_id: rbac.credential.actorId };
    }
    if (rbac.credential.kind === 'attempt') {
      return { actor_kind: 'task_attempt', actor_id: rbac.credential.actorId };
    }
    return { actor_kind: 'human_owner', actor_id: rbac.credential.actorId };
  }

  function requestCorrelation(req: FastifyRequest): string {
    return req.v2rbac?.correlationId ?? `corr-${Date.now()}`;
  }

  function requestMeta(req: FastifyRequest) {
    return {
      idempotency_key: `ik-${randomUUID()}`,
      correlation_id: requestCorrelation(req),
      actor: requestActor(req),
    };
  }

  /** 尝试 bvn2 鉴权，失败返回 null（调用方决定是否回退 owner）。 */
  function tryNodeAuth(req: { headers: Record<string, string | string[] | undefined> }): NodeAuthResult | null {
    const token = extractBearerToken(req.headers);
    if (!token || token.startsWith('bva2_')) return null; // bva2 不是 node credential
    if (!token.startsWith('bvn2_')) return null; // 非 bvn2 前缀跳过
    return verifyNodeBearer(token, store, credOpts);
  }

  function metaFromOwner() {
    return {
      idempotency_key: `ik-${Date.now()}`,
      correlation_id: `corr-${Date.now()}`,
      actor: extractOwnerActor(),
    };
  }

  /* ---- Phase 8：五旗状态端点（owner/auditor；全关时仍可用，见门禁 hook） ---- */

  app.get('/v2/feature-flags', async () => {
    return { ok: true, data: describeV2FeatureFlags(featureFlags) };
  });

  /* ---- Project routes (owner auth via crossCuttingApiPlugin) ---- */

  app.post('/v2/projects', async (req) => {
    const body = req.body as {
      name: string;
      repo_path: string;
      default_branch: string;
      execution_mode: 'full' | 'read_only';
      legacy_project_scope?: string;
    };
    return projectService.createProject(body, metaFromOwner());
  });

  app.get('/v2/projects', async (req) => {
    const query = req.query as { cursor?: string; limit?: string };
    return projectService.listProjects(
      { cursor: query.cursor, limit: query.limit ? Number(query.limit) : undefined },
      { actor: extractOwnerActor(), correlation_id: `corr-${Date.now()}` },
    );
  });

  app.get('/v2/projects/:project_id', async (req) => {
    const { project_id } = req.params as { project_id: string };
    return projectService.getProject(project_id, {
      actor: extractOwnerActor(),
      correlation_id: `corr-${Date.now()}`,
    });
  });

  app.post('/v2/projects/:project_id/mode-transitions', async (req) => {
    const { project_id } = req.params as { project_id: string };
    const body = req.body as { to_mode: 'full' | 'read_only'; reason: string; auto?: boolean };
    const created = await projectService.applyModeTransition(project_id, body, metaFromOwner());
    // 自动推进选项（22.3-20）：创建即执行首步后，循环 advance 直到
    // completed/failed/expired/waiting（单步驱动见 advance 路由）。
    if (!created.ok || !created.data || !body?.auto) return created;
    return runModeTransitionAuto(store, project_id, created.data.transition_id);
  });

  app.get('/v2/projects/:project_id/mode-transitions/:transition_id', async (req) => {
    const { project_id, transition_id } = req.params as { project_id: string; transition_id: string };
    return projectService.getModeTransition(project_id, transition_id, {
      actor: extractOwnerActor(),
      correlation_id: `corr-${Date.now()}`,
    });
  });

  // 单步推进（owner；22.3-20/22.4-04）：从 durable step 续跑一步；body.auto
  // 则循环推进到终态。未收口（waiting）返回逐项清单。
  app.post('/v2/projects/:project_id/mode-transitions/:transition_id/advance', async (req) => {
    const { project_id, transition_id } = req.params as { project_id: string; transition_id: string };
    const body = req.body as { auto?: boolean } | null;
    return body?.auto
      ? runModeTransitionAuto(store, project_id, transition_id)
      : advanceModeTransition(store, project_id, transition_id);
  });

  // 22.3-21：离线 Node 回归后的 binding 重同步（重新上线 → policy/binding
  // 对齐当前 revision → 才恢复 eligible 取新 push credential）。
  app.post('/v2/projects/:project_id/nodes/:node_id/binding-resync', async (req) => {
    const { project_id, node_id } = req.params as { project_id: string; node_id: string };
    return resyncNodeProjectBinding(store, node_id, project_id);
  });

  /* ---- Node routes ---- */

  // enroll：owner bearer 鉴权（管理面）
  app.post('/v2/nodes/enroll', async (req) => {
    const body = req.body as { enrollment_ticket: string; node_id: string };
    return nodeService.enroll(body, metaFromOwner());
  });

  // register：bvn2 Node credential 鉴权（节点数据面）
  app.post('/v2/nodes/register', async (req) => {
    const body = req.body as {
      node_id: string;
      labels?: string[];
      slots: number;
      requested_project_ids: string[];
      protocol_version?: number;
    };
    // register：接受 bvn2 或 owner bearer（crossCuttingApiPlugin 已做基础鉴权）。
    // bvn2 签名校验在 heartbeat/offline 阶段执行；register 阶段节点可能用
    // owner_fallback，此处不硬性要求 bvn2。
    return nodeService.register(body, metaFromOwner());
  });

  // heartbeat：bvn2 Node credential 鉴权 + session generation fencing
  app.post('/v2/nodes/:node_id/heartbeat', async (req, reply) => {
    const { node_id } = req.params as { node_id: string };
    const body = req.body as {
      protocol_version: number;
      clock_skew_ms: number;
      disk_free_gib: number;
      disk_free_percent: number;
      slots_in_use: number;
      running_attempt_ids?: string[];
      node_status?: string;
    };

    // bvn2 鉴权（失败返回 HTTP 401 而非200+error body，以触发 transport 的 owner_fallback；
    // generation fencing（轮换/撤销后的旧 token）按 §4.2 语义返回 409）
    const auth = tryNodeAuth(req);
    if (auth) {
      if (!auth.ok) {
        return reply.status(auth.error?.code === 'CREDENTIAL_FENCED' ? 409 : 401)
          .send({ ok: false, data: null, error: auth.error });
      }
      // 校验 node_id 匹配
      if (auth.nodeId !== node_id) {
        return reply.status(403).send({ ok: false, data: null, error: { code: 'SUBJECT_MISMATCH', message: 'bvn2 凭据 node_id 与请求路径不匹配' } });
      }
    }

    // session generation fencing
    const node = store.getNode(node_id);
    if (node) {
      const currentSession = store.getCurrentNodeSession(node_id);
      if (currentSession && currentSession.status === 'fenced') {
        return reply.status(409).send({ ok: false, data: null, error: { code: 'SESSION_FENCED', message: `节点 ${node_id} session 已被 fencing` } });
      }
    }

    return nodeService.heartbeat(node_id, body, metaFromOwner());
  });

  // drain：owner bearer 鉴权（管理面）
  app.post('/v2/nodes/:node_id/drain', async (req) => {
    const { node_id } = req.params as { node_id: string };
    return nodeService.drain(node_id, metaFromOwner());
  });

  // offline：bvn2 Node credential 鉴权（节点数据面）
  app.post('/v2/nodes/:node_id/offline', async (req, reply) => {
    const { node_id } = req.params as { node_id: string };
    const body = req.body as { reason: string };

    const auth = tryNodeAuth(req);
    if (auth) {
      if (!auth.ok) {
        return reply.status(auth.error?.code === 'CREDENTIAL_FENCED' ? 409 : 401)
          .send({ ok: false, data: null, error: auth.error });
      }
      if (auth.nodeId !== node_id) {
        return reply.status(403).send({ ok: false, data: null, error: { code: 'SUBJECT_MISMATCH', message: 'bvn2 凭据 node_id 与请求路径不匹配' } });
      }
    }

    return nodeService.offline(node_id, body, metaFromOwner());
  });

  // revoke：owner bearer 鉴权（管理面）
  app.post('/v2/nodes/:node_id/revoke', async (req) => {
    const { node_id } = req.params as { node_id: string };
    const body = req.body as { reason: string };
    return nodeService.revoke(node_id, body, metaFromOwner());
  });

  app.post('/v2/projects/:project_id/nodes/:node_id/authorize', async (req) => {
    const { project_id, node_id } = req.params as { project_id: string; node_id: string };
    return nodeService.authorizeProject(node_id, project_id, metaFromOwner());
  });

  app.delete('/v2/projects/:project_id/nodes/:node_id/authorization', async (req) => {
    const { project_id, node_id } = req.params as { project_id: string; node_id: string };
    return nodeService.revokeProjectAuthorization(node_id, project_id, metaFromOwner());
  });

  app.get('/v2/nodes', async (req) => {
    const query = req.query as { cursor?: string; limit?: string };
    return nodeService.listNodes(
      { cursor: query.cursor, limit: query.limit ? Number(query.limit) : undefined },
      { actor: extractOwnerActor(), correlation_id: `corr-${Date.now()}` },
    );
  });

  /* ---- Attempt data routes（Phase 2+3 集成：替换 stub） ---- */

  // POST /v2/tasks/claim：node credential 鉴权 → 创建 task_attempt → 签发 bva2
  app.post('/v2/tasks/claim', async (req, reply) => {
    const body = req.body as {
      project_id: string;
      agent_id: string;
      claim_request_id: string;
      task_id?: string;
    };

    // bvn2 鉴权（节点数据面）
    const auth = tryNodeAuth(req);
    if (!auth || !auth.ok) {
      return reply.status(auth ? 401 : 401).send({
        ok: false,
        data: null,
        error: auth?.error ?? { code: 'UNAUTHORIZED', message: 'claim 需要 bvn2 Node credential' },
      });
    }

    const nodeId = auth.nodeId!;
    const node = store.getNode(nodeId);
    if (!node) {
      return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `节点 ${nodeId} 不存在` } });
    }

    // ── §claim 调度前置校验（Phase 8 残留） ──
    // 1. node 状态必须 active（online）
    const activeNodeStatuses = new Set(['online', 'active', 'draining']);
    if (!activeNodeStatuses.has(node.status)) {
      return reply.status(409).send({
        ok: false, data: null,
        error: { code: 'NODE_NOT_ACTIVE', message: `节点 ${nodeId} 状态 ${node.status}，必须 online/active 才能 claim` },
      });
    }

    // 2. NodeProjectBinding 必须 authorized
    const projectId = body.project_id || (store.getTasksByProjectId(body.project_id)[0]?.project_id ?? '');
    if (projectId) {
      const binding = store.getNodeProjectBinding(nodeId, projectId);
      if (!binding || binding.authorization_status !== 'authorized') {
        return reply.status(403).send({
          ok: false, data: null,
          error: { code: 'BINDING_UNAUTHORIZED', message: `节点 ${nodeId} 未授权访问项目 ${projectId}` },
        });
      }

      // 3. project write_capability 必须 full
      const project = store.getProject(projectId);
      if (project && (project.write_capability_status === 'lost' || project.write_capability_status === 'disabled')) {
        return reply.status(409).send({
          ok: false, data: null,
          error: { code: 'PROJECT_READ_ONLY', message: `项目 ${projectId} 写能力状态 ${project.write_capability_status}，无法 claim` },
        });
      }
    }

    // 查找可 claim 的任务：用 task_id 指定或从 project 的 pending 任务中取
    let taskRow: ReturnType<typeof store.getTask>;
    let v1Fallback = false;
    if (body.task_id) {
      taskRow = store.getTask(body.task_id);
    } else {
      // 从该节点绑定的项目中找 pending 任务
      const tasks = store.getTasksByProjectId(body.project_id);
      taskRow = tasks.find((t) => t.status === 'pending');
      // V2/V1 桥接：project_id 查不到时，回退查 V1 pending 队列
      // （V1 plan/create 的任务没有填 project_id 列）
      if (!taskRow && body.project_id) {
        const allTasks = store.getAllTasks();
        taskRow = allTasks.find((t) => t.status === 'pending' && !t.project_id);
        if (taskRow) {
          v1Fallback = true;
        }
      }
    }

    if (!taskRow) {
      return { ok: true, data: null };
    }

    // V1 桥接：自动关联 project_id（回填到 tasks.project_id）
    if (v1Fallback && body.project_id && !taskRow.project_id) {
      store.updateTaskFields(taskRow.task_id, { project_id: body.project_id });
      taskRow = { ...taskRow, project_id: body.project_id };
    }

    // 终态任务不可 claim
    const terminalStatuses = new Set(['done', 'cancelled', 'superseded']);
    if (terminalStatuses.has(taskRow.status)) {
      return { ok: true, data: null };
    }

    // 检查是否已有活跃 attempt
    const existingAttempts = store.listTaskAttemptsByTask(taskRow.task_id);
    const activeAttempt = existingAttempts.find((a) => ['pending', 'claiming', 'executing'].includes(a.status));
    if (activeAttempt) {
      return reply.status(409).send({
        ok: false,
        data: null,
        error: { code: 'ATTEMPT_ACTIVE', message: `任务 ${taskRow.task_id} 已有活跃 attempt ${activeAttempt.attempt_id}` },
      });
    }

    // 创建 task_attempt
    const attemptId = `att-${randomBytes(8).toString('hex')}`;
    const session = store.getCurrentNodeSession(nodeId);
    const attemptGen = (existingAttempts.reduce((max, a) => Math.max(max, a.attempt_generation), 0)) + 1;
    const leaseDurationMs = 600_000; // 10 分钟默认
    const now = Date.now();

    const attemptRow = {
      attempt_id: attemptId,
      task_id: taskRow.task_id,
      project_id: body.project_id || taskRow.project_id || '',
      node_id: nodeId,
      session_id: session?.session_id ?? '',
      attempt_generation: attemptGen,
      status: 'executing' as const,
      lease_expires_at: now + leaseDurationMs,
      lease_duration_ms: leaseDurationMs,
      token_jti: '',
      artifact_ids: '[]',
      started_at: now,
      updated_at: now,
      completed_at: null,
      failure_reason: '',
    };

    store.insertTaskAttempt(attemptRow);

    // Phase 8 收尾项（Phase 4 runbook §8）：claim 落 ownership snapshot——
    // task.ownership_files（plan 声明的文件清单）即本 attempt 的写边界，
    // workspace finalize 的 fail-closed 门禁（无快照拒绝）由此闭环。
    // 无声明（空清单）的 task 也落快照：空 globs = 不得改任何仓库文件
    // （只产出 Artifact 的任务形态），同样走 fail-closed。
    store.insertOwnershipSnapshot({
      snapshot_id: `snap-${attemptId}`,
      attempt_id: attemptId,
      task_id: taskRow.task_id,
      files: typeof taskRow.ownership_files === 'string' && taskRow.ownership_files.trim().startsWith('[')
        ? taskRow.ownership_files
        : '[]',
      created_at: now,
      released_at: null,
    });

    // 更新 task 的 active_attempt_id。注意 upsertTask 的固定列清单不含
    // §20.2 扩展列（project_id/active_attempt_id 等），task↔attempt 链接
    // 必须走 updateTaskFields，否则 claim 后行级投影丢失关联（E2E 实证）。
    store.updateTaskFields(taskRow.task_id, {
      status: 'running',
      active_attempt_id: attemptId,
      claimed_by: attemptId,
      claimed_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });

    // 签发 bva2 Attempt token（scope=claim）
    const attemptToken = issueAttemptToken(attemptId, taskRow.task_id, attemptGen, 'claim', credOpts);

    return {
      ok: true,
      data: {
        attempt_id: attemptId,
        task_id: taskRow.task_id,
        attempt_generation: attemptGen,
        attempt_token: attemptToken,
        project_id: attemptRow.project_id,
        lease_duration_ms: leaseDurationMs,
        lease_expires_at: attemptRow.lease_expires_at,
      },
    };
  });

  // POST /v2/attempts/:attempt_id/lease/renew：bva2 scope=claim + generation fencing
  app.post('/v2/attempts/:attempt_id/lease/renew', async (req, reply) => {
    const { attempt_id } = req.params as { attempt_id: string };
    const body = req.body as { extend_seconds?: number; attempt_token?: string };

    // 从 Authorization 头提取 bva2 token
    const token = extractBearerToken(req.headers);
    if (!token || !token.startsWith('bva2_')) {
      return reply.status(401).send({
        ok: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'lease renew 需要 bva2 Attempt token' },
      });
    }

    const attempt = store.getTaskAttempt(attempt_id);
    if (!attempt) {
      return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `attempt ${attempt_id} 不存在` } });
    }

    // 验证 bva2 token
    const verifyResult = verifyAttemptToken(token, {
      attemptId: attempt_id,
      taskId: attempt.task_id,
      generation: attempt.attempt_generation,
      scope: 'claim',
    }, credOpts);

    if (!verifyResult.ok) {
      const status = verifyResult.reason === 'GENERATION_MISMATCH' ? 409 : 401;
      return reply.status(status).send({
        ok: false,
        data: null,
        error: { code: verifyResult.reason, message: `bva2 验证失败: ${verifyResult.reason}` },
      });
    }

    // generation fencing
    if (attempt.status === 'fenced' || attempt.status === 'cancelled') {
      return reply.status(409).send({
        ok: false,
        data: null,
        error: { code: 'ATTEMPT_FENCED', message: `attempt ${attempt_id} 已终态(${attempt.status})` },
      });
    }

    // 续租
    const extendMs = (body.extend_seconds ?? 600) * 1000;
    const newExpiry = Date.now() + extendMs;
    store.updateTaskAttempt(attempt_id, {
      lease_expires_at: newExpiry,
      lease_duration_ms: extendMs,
      updated_at: Date.now(),
    });

    return {
      ok: true,
      data: {
        attempt_id,
        lease_expires_at: newExpiry,
      },
    };
  });

  // POST /v2/attempts/:attempt_id/report：bva2 scope=report → reportV2WithArtifacts
  app.post('/v2/attempts/:attempt_id/report', async (req, reply) => {
    const { attempt_id } = req.params as { attempt_id: string };
    const body = req.body as {
      status: string;
      artifact_refs?: Array<{ artifact_id: string; sha256: string }>;
    };

    // 从 Authorization 头提取 bva2 token
    const token = extractBearerToken(req.headers);
    if (!token || !token.startsWith('bva2_')) {
      return reply.status(401).send({
        ok: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'report 需要 bva2 Attempt token' },
      });
    }

    const attempt = store.getTaskAttempt(attempt_id);
    if (!attempt) {
      return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `attempt ${attempt_id} 不存在` } });
    }

    // 验证 bva2 token：claim scope（直接持有者）或 report scope（升级令牌）
    const claimScoped = verifyAttemptToken(token, {
      attemptId: attempt_id, taskId: attempt.task_id,
      generation: attempt.attempt_generation, scope: 'claim',
    }, credOpts);
    const verifyResult = claimScoped.ok ? claimScoped : verifyAttemptToken(token, {
      attemptId: attempt_id, taskId: attempt.task_id,
      generation: attempt.attempt_generation, scope: 'report',
    }, credOpts);

    if (!verifyResult.ok) {
      const status = verifyResult.reason === 'GENERATION_MISMATCH' ? 409 : 401;
      return reply.status(status).send({
        ok: false,
        data: null,
        error: { code: verifyResult.reason, message: `bva2 验证失败: ${verifyResult.reason}` },
      });
    }

    // 校验 artifact 引用：必须属于同一 attempt（跨任务引用拒绝）
    if (body.artifact_refs) {
      for (const ref of body.artifact_refs) {
        const artifact = store.getArtifact(ref.artifact_id);
        if (!artifact) {
          return reply.status(400).send({
            ok: false,
            data: null,
            error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact ${ref.artifact_id} 不存在` },
          });
        }
        if (artifact.attempt_id !== attempt_id) {
          return reply.status(403).send({
            ok: false,
            data: null,
            error: { code: 'CROSS_ATTEMPT_DENIED', message: `Artifact ${ref.artifact_id} 不属于 attempt ${attempt_id}` },
          });
        }
      }
    }

    // 调用 Phase 2 reportV2WithArtifacts 生成 delivery
    const result = reportV2WithArtifacts(store, attempt_id, {
      status: body.status,
      artifact_refs: body.artifact_refs,
    });

    if (result.ok) {
      // 更新 attempt 状态
      const attemptStatus = body.status === 'done' ? 'done' : 'failed';
      store.updateTaskAttempt(attempt_id, {
        status: attemptStatus,
        completed_at: Date.now(),
        updated_at: Date.now(),
        artifact_ids: JSON.stringify(body.artifact_refs?.map((r) => r.artifact_id) ?? []),
        failure_reason: body.status !== 'done' ? body.status : '',
      });

      // 同步更新 task 状态：done → done，failed → pending（允许重试）
      const taskRow = store.getTask(attempt.task_id);
      if (taskRow) {
        store.upsertTask({
          ...taskRow,
          status: attemptStatus === 'done' ? 'done' : 'pending',
          done_at: attemptStatus === 'done' ? new Date().toISOString() : '',
          updated_at: new Date().toISOString(),
        });
      }
    }

    return result;
  });

  /* ---- Stub routes for unimplemented Phase 2+ endpoints ---- */

  const notImplemented = async () => ({ ok: false, data: null, error: { code: 'NOT_IMPLEMENTED', message: 'Phase 2+ 范围' } });

  // 22.3-14：importPlan 实现（read-only 项目拒绝写任务）
  app.post('/v2/plans/import', async (req) => {
    const body = req.body as { project_id: string; snapshot: unknown };
    const { importPlanForProject } = await import('../plan-import.js');
    return importPlanForProject(store, body.project_id, body.snapshot as any);
  });
  app.get('/v2/plans/:plan_id', notImplemented);
  app.post('/v2/attempts/:attempt_id/question', notImplemented);

  // Artifact routes（Phase 2）
  app.post('/v2/artifacts/initiate', async (req) => {
    const body = req.body as { attempt_id: string; kind: string; size_bytes: number; sha256: string };
    return artifactService.initiateArtifact(body.attempt_id, body, metaFromOwner());
  });

  // application/octet-stream 的 PUT 上传：content type parser 已在 http.ts 全局注册。
  // Fastify 解析后 body 是 Buffer；如果解析失败回退到 req.raw。
  app.put('/v2/artifacts/:artifact_id/content', async (req) => {
    const { artifact_id } = req.params as { artifact_id: string };
    let body: Buffer;
    if (Buffer.isBuffer(req.body)) {
      body = req.body;
    } else if (req.body !== undefined && req.body !== null) {
      body = Buffer.from(String(req.body));
    } else {
      // 回退：从 raw stream 读取
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      body = Buffer.concat(chunks);
    }
    return artifactService.uploadArtifactContent(artifact_id, body, 0);
  });

  app.post('/v2/artifacts/:artifact_id/complete', async (req) => {
    const { artifact_id } = req.params as { artifact_id: string };
    return artifactService.completeArtifact(artifact_id);
  });

  app.get('/v2/artifacts/:artifact_id', async (req) => {
    const { artifact_id } = req.params as { artifact_id: string };
    return artifactService.getArtifact(artifact_id, '');
  });

  // Delivery routes（Phase 2 最小版）
  app.post('/v2/deliveries', async (req) => {
    const body = req.body as {
      attempt_id: string;
      branch: string;
      head_sha: string;
      artifact_refs: Array<{ artifact_id: string; sha256: string }>;
    };
    return reportV2WithArtifacts(store, body.attempt_id, {
      status: 'done',
      artifact_refs: body.artifact_refs,
    });
  });

  app.get('/v2/deliveries/:delivery_id', async (req) => {
    const { delivery_id } = req.params as { delivery_id: string };
    return getDeliveryReviewView(store, delivery_id);
  });

  app.get('/v2/tasks/:task_id/delivery', async (req) => {
    const { task_id } = req.params as { task_id: string };
    const deliveries = store.listDeliveriesByTask(task_id);
    if (deliveries.length === 0) {
      return { ok: true, data: null };
    }
    const latest = deliveries[deliveries.length - 1];
    return getDeliveryReviewView(store, latest.delivery_id);
  });

  /* ---- Git Workspace & Delivery 状态机（Phase 4） ---- */

  // POST /v2/attempts/:attempt_id/workspace/prepare：bva2 scope=ownership
  app.post('/v2/attempts/:attempt_id/workspace/prepare', async (req, reply) => {
    if (!workspaceService) return reply.status(503).send(workspaceNotConfigured);
    const { attempt_id } = req.params as { attempt_id: string };
    const body = req.body as { attempt_token?: string; base_sha?: string };

    // bva2（scope=ownership）或 owner bearer（进程内模拟 Node 执行路径）
    const token = extractBearerToken(req.headers);
    if (token?.startsWith('bva2_')) {
      const attempt = store.getTaskAttempt(attempt_id);
      if (!attempt) {
        return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `attempt ${attempt_id} 不存在` } });
      }
      const verified = verifyAttemptToken(token, {
        attemptId: attempt_id,
        taskId: attempt.task_id,
        generation: attempt.attempt_generation,
        scope: 'ownership',
      }, credOpts);
      if (!verified.ok) {
        const status = verified.reason === 'GENERATION_MISMATCH' ? 409 : 401;
        return reply.status(status).send({ ok: false, data: null, error: { code: verified.reason, message: `bva2 验证失败: ${verified.reason}` } });
      }
    }
    return workspaceService.prepare(attempt_id, body);
  });

  // POST /v2/attempts/:attempt_id/workspace/finalize：bva2 scope=report
  app.post('/v2/attempts/:attempt_id/workspace/finalize', async (req, reply) => {
    if (!workspaceService) return reply.status(503).send(workspaceNotConfigured);
    const { attempt_id } = req.params as { attempt_id: string };
    const body = req.body as { artifact_refs?: Array<{ artifact_id: string }>; author?: string };

    const token = extractBearerToken(req.headers);
    if (token?.startsWith('bva2_')) {
      const attempt = store.getTaskAttempt(attempt_id);
      if (!attempt) {
        return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `attempt ${attempt_id} 不存在` } });
      }
      const verified = verifyAttemptToken(token, {
        attemptId: attempt_id,
        taskId: attempt.task_id,
        generation: attempt.attempt_generation,
        scope: 'report',
      }, credOpts);
      if (!verified.ok) {
        const status = verified.reason === 'GENERATION_MISMATCH' ? 409 : 401;
        return reply.status(status).send({ ok: false, data: null, error: { code: verified.reason, message: `bva2 验证失败: ${verified.reason}` } });
      }
    }
    return workspaceService.commitAndPush(attempt_id, body);
  });

  // GET /v2/attempts/:attempt_id/workspace：状态机读面（owner）
  app.get('/v2/attempts/:attempt_id/workspace', async (req) => {
    const { attempt_id } = req.params as { attempt_id: string };
    const ws = store.getAttemptWorkspace(attempt_id);
    if (!ws) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        attempt_id: ws.attempt_id,
        prepare_state: ws.prepare_state,
        finalize_state: ws.finalize_state,
        branch_ref: ws.branch_ref,
        marker_ref: ws.marker_ref,
        base_sha: ws.base_sha,
        head_sha: ws.head_sha,
        delivery_id: ws.delivery_id,
        prepare_error: ws.prepare_error,
        finalize_error: ws.finalize_error,
      },
    };
  });

  // POST /v2/workspace-recovery/scan：中断工作区 → orphan candidate（owner）
  app.post('/v2/workspace-recovery/scan', async (req, reply) => {
    if (!workspaceService) return reply.status(503).send(workspaceNotConfigured);
    return workspaceService.scanInterruptedWorkspaces();
  });

  // POST /v2/deliveries/:delivery_id/verify：§7.3 服务端独立复核
  app.post('/v2/deliveries/:delivery_id/verify', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    return deliveryService.verifyDeliveryRemote(delivery_id);
  });

  // POST /v2/deliveries/:delivery_id/review/start：pending_review → reviewing
  app.post('/v2/deliveries/:delivery_id/review/start', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    return deliveryService.startReview(delivery_id);
  });

  // POST /v2/deliveries/:delivery_id/review：PM Review（pending_review 自动进入 reviewing）
  app.post('/v2/deliveries/:delivery_id/review', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    const body = req.body as {
      verdict: 'accept' | 'reject';
      reviewed_by: string;
      comment?: string;
      reject_reason?: string;
      fix_instructions?: string;
    };
    const delivery = store.getDelivery(delivery_id);
    if (!delivery) {
      return reply.status(404).send({ ok: false, data: null, error: { code: 'DELIVERY_NOT_FOUND', message: `delivery ${delivery_id} 不存在` } });
    }
    if (delivery.status === 'pending_review') {
      const started = deliveryService.startReview(delivery_id);
      if (!started.ok) return started;
    }
    return deliveryService.reviewDelivery(delivery_id, body);
  });

  // POST /v2/deliveries/:delivery_id/repair：22.1-10 rejected → repair attempt
  app.post('/v2/deliveries/:delivery_id/repair', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    const body = (req.body ?? {}) as { exclude_reviewer?: string };
    return deliveryService.repairDelivery(delivery_id, body);
  });

  // POST /v2/deliveries/:delivery_id/reverify：22.1-10 重验证据（不改来源实现）
  app.post('/v2/deliveries/:delivery_id/reverify', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    return deliveryService.reverifyDelivery(delivery_id);
  });

  // POST /v2/deliveries/:delivery_id/recover-artifacts：pending_recovery 收敛
  app.post('/v2/deliveries/:delivery_id/recover-artifacts', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    const { delivery_id } = req.params as { delivery_id: string };
    return deliveryService.recoverPendingArtifacts(delivery_id);
  });

  // GET /v2/branch-cleanups：清理记录列表（owner）
  app.get('/v2/branch-cleanups', async (req) => {
    const query = req.query as { project_id?: string; status?: string };
    return { ok: true, data: { items: store.listBranchCleanups(query.project_id, query.status) } };
  });

  // POST /v2/branch-cleanups/run：到期清理执行（删除前复核远端 HEAD）
  app.post('/v2/branch-cleanups/run', async (req, reply) => {
    if (!deliveryService) return reply.status(503).send(deliveryNotConfigured);
    return deliveryService.runDueBranchCleanups();
  });

  // POST /v2/branch-cleanups/:cleanup_id/retry：失败记录回到 pending
  app.post('/v2/branch-cleanups/:cleanup_id/retry', async (req, reply) => {
    const { cleanup_id } = req.params as { cleanup_id: string };
    const record = store.getBranchCleanup(cleanup_id);
    if (!record) {
      return reply.status(404).send({ ok: false, data: null, error: { code: 'NOT_FOUND', message: `cleanup ${cleanup_id} 不存在` } });
    }
    if (record.status === 'deleted') {
      return { ok: true, data: { cleanup_id, status: 'deleted', message: '已删除，幂等返回' } };
    }
    store.updateBranchCleanup(cleanup_id, { status: 'pending', last_error: '' });
    return { ok: true, data: { cleanup_id, status: 'pending' } };
  });

  // 22.3-15：EvidenceAcceptance 实现
  app.post('/v2/evidence-acceptances', async (req) => {
    const body = req.body as { attempt_id: string; commit_sha: string; level: 'node' | 'node_harness' | 'pm' };
    const { createEvidenceAcceptanceForTask } = await import('../plan-import.js');
    const result = createEvidenceAcceptanceForTask(store, body.attempt_id, body.commit_sha, body.level);
    if (!result.ok) {
      return { ok: false, data: null, error: { code: 'EVIDENCE_ACCEPTANCE_FAILED', message: result.error } };
    }
    const acceptance = store.getEvidenceAcceptance(result.acceptance_id);
    return { ok: true, data: acceptance };
  });

  app.post('/v2/evidence-acceptances/:acceptance_id/review', async (req) => {
    const { acceptance_id } = req.params as { acceptance_id: string };
    const body = req.body as { verdict: 'accept' | 'reject'; reviewed_by: string };
    const acceptance = store.getEvidenceAcceptance(acceptance_id);
    if (!acceptance) {
      return { ok: false, data: null, error: { code: 'NOT_FOUND', message: `evidence acceptance ${acceptance_id} 不存在` } };
    }
    const now = Date.now();
    store.updateEvidenceAcceptance(acceptance_id, {
      status: body.verdict === 'accept' ? 'accepted' : 'rejected',
      reviewed_by: body.reviewed_by,
      reviewed_at: now,
      updated_at: now,
    });
    return { ok: true, data: store.getEvidenceAcceptance(acceptance_id) };
  });

  // Merge routes（Phase 5：合并队列）
  app.post('/v2/merge-jobs', async (req) => {
    const body = req.body as {
      project_id: string;
      delivery_id: string;
      expected_target_sha: string;
      strategy?: 'merge-ff' | 'cherry-pick' | 'provider-pr';
    };
    return mergeService.createMergeJob(body);
  });

  app.get('/v2/merge-jobs/:merge_job_id', async (req) => {
    const { merge_job_id } = req.params as { merge_job_id: string };
    return mergeService.getMergeJob(merge_job_id);
  });

  app.post('/v2/merge-jobs/:merge_job_id/cancel', async (req) => {
    const { merge_job_id } = req.params as { merge_job_id: string };
    const body = req.body as { reason: string };
    return mergeService.cancelMergeJob(merge_job_id, body);
  });

  app.post('/v2/merge-jobs/external-intents', async (req) => {
    const body = req.body as {
      project_id: string;
      delivery_id: string;
      expected_target_sha: string;
      provider_actor: string;
      approved_by: string;
      reason: string;
    };
    return mergeService.createExternalIntent(body);
  });

  app.post('/v2/merge-jobs/external-intents/:intent_id/reconcile', async (req) => {
    const { intent_id } = req.params as { intent_id: string };
    return mergeService.reconcileExternalIntent(intent_id);
  });

  // GET /v2/projects/:id/merge-jobs：队列视图
  app.get('/v2/projects/:project_id/merge-jobs', async (req) => {
    const { project_id } = req.params as { project_id: string };
    const query = req.query as { status?: string };
    return mergeService.listMergeJobs(project_id, query.status);
  });

  // POST /v2/projects/:id/merge-jobs/dispatch：触发队头 merge（§12.2；Phase 8
  // 补 HTTP 接线——E2E/运维的队列驱动点，幂等：空队列返回 data=null）
  app.post('/v2/projects/:project_id/merge-jobs/dispatch', async (req) => {
    const { project_id } = req.params as { project_id: string };
    return mergeService.dispatchMergeJob(project_id);
  });

  // POST /v2/merge-jobs/:id/retry：integration_failed 重试=新 job
  app.post('/v2/merge-jobs/:merge_job_id/retry', async (req) => {
    const { merge_job_id } = req.params as { merge_job_id: string };
    return mergeService.retryMergeJob(merge_job_id);
  });

  // POST /v2/projects/:id/write-capability/restore：恢复写能力
  app.post('/v2/projects/:project_id/write-capability/restore', async (req) => {
    const { project_id } = req.params as { project_id: string };
    return mergeService.restoreWriteCapability(project_id);
  });

  // Incident routes（Phase 7a）
  app.get('/v2/incidents', async (req) => {
    const query = req.query as { project_id?: string; status?: string; limit?: string };
    return incidentService.listIncidents({
      project_id: query.project_id,
      status: query.status as 'open' | 'acked' | 'resolved' | undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
  });

  app.post('/v2/incidents/:incident_id/ack', async (req) => {
    const { incident_id } = req.params as { incident_id: string };
    const body = req.body as { acked_by: string; note?: string };
    return incidentService.ackIncident(incident_id, body);
  });

  app.post('/v2/incidents/:incident_id/resolve', async (req) => {
    const { incident_id } = req.params as { incident_id: string };
    const body = req.body as { resolved_by: string; evidence: string };
    return incidentService.resolveIncident(incident_id, body);
  });

  // Recovery routes（Phase 7a；车道 C 后续增强：签名决策 + 三崩溃点续跑 +
  // batch 逐项结果 + isolation 三步分权）
  /**
   * takeover 决策的 attempt 裁决接线（§4.4.1 control-plane-takeover）。
   * 前置条件全部满足才转移：attempt 仍 executing 且 lease 已过期（watchdog/
   * 扫描已判掉线）。转 pending_recovery 后该 attempt 不再阻塞重 claim
   * （claim 的活跃 attempt 判定不含 pending_recovery），同时把 task 放回
   * pending（§5.1 Task/Attempt 分离：attempt 终态化释放 task 给新 attempt），
   * 由接管节点重走链路。
   *
   * 车道 C：裁决走 recovery-decision 模块——决策信封签名留档（22.4-26），
   * decide/fence-attempt/release-task 三阶段可崩溃续跑、attempt CAS 不产生
   * 双 attempt（22.4-29）。
   */
  app.get('/v2/recovery-candidates', async (req) => {
    const query = req.query as { project_id?: string; status?: string };
    const candidates = store.listOrphanRecoveryCandidates(query.project_id, query.status);
    return { ok: true, data: { items: candidates } };
  });

  app.post('/v2/recovery-candidates/:candidate_id/takeover', async (req) => {
    const { candidate_id } = req.params as { candidate_id: string };
    const body = req.body as { reason: string; decided_by: string };
    const run = runControlPlaneTakeover(store, candidate_id, { reason: body.reason, decided_by: body.decided_by }, recoverySigningKeyring());
    if (!run.ok || !run.data) return run;
    // 响应保持 candidate 行为 data 主体（status/decision/revision 兼容既有
    // 断言），信封与执行阶段附加返回（22.4-26/29 观测面）。
    const { candidate, envelope, steps_executed, halted_after } = run.data;
    return {
      ok: true,
      data: {
        ...candidate,
        decision_envelope: envelope,
        takeover_steps: steps_executed,
        takeover_halted_after: halted_after,
      },
    };
  });

  app.post('/v2/recovery-candidates/:candidate_id/discard', async (req) => {
    const { candidate_id } = req.params as { candidate_id: string };
    const body = req.body as { reason: string; decided_by: string };
    const run = runControlPlaneDiscard(store, candidate_id, { reason: body.reason, decided_by: body.decided_by }, recoverySigningKeyring());
    if (!run.ok || !run.data) return run;
    return {
      ok: true,
      data: {
        ...run.data.candidate,
        decision_envelope: run.data.envelope,
      },
    };
  });

  // 批量裁决：逐项返回 revision/最终状态/错误码，单项失败不影响其余（22.4-31）
  app.post('/v2/recovery-candidates/batch-actions', async (req) => {
    const body = req.body as { candidate_ids: string[]; action: 'takeover' | 'discard'; reason: string; decided_by: string };
    return runBatchRecoveryActions(store, {
      candidate_ids: body.candidate_ids ?? [],
      action: body.action,
      reason: body.reason,
      decided_by: body.decided_by,
    }, recoverySigningKeyring());
  });

  // 单候选轻量裁决（registry 声明的 decision 路由）：cleanup→走 discard 签名链；
  // isolate→三步分权第 1 步创建隔离记录；keep→仅记录 decision 保持 pending 复核。
  app.post('/v2/recovery-candidates/:candidate_id/decision', async (req, reply) => {
    const { candidate_id } = req.params as { candidate_id: string };
    const body = req.body as { action: 'cleanup' | 'keep' | 'isolate'; reason: string; decided_by: string };
    const candidate = store.getOrphanRecoveryCandidate?.(candidate_id)
      ?? store.listOrphanRecoveryCandidates().find((row) => row.candidate_id === candidate_id);
    if (!candidate) {
      reply.status(404);
      return { ok: false, data: null, error: { code: 'CANDIDATE_NOT_FOUND', message: `candidate 不存在：${candidate_id}` } };
    }
    if (body.action === 'cleanup') {
      const run = runControlPlaneDiscard(store, candidate_id, { reason: body.reason, decided_by: body.decided_by }, recoverySigningKeyring());
      return run.ok && run.data
        ? { ok: true, data: { ...run.data.candidate, decision_envelope: run.data.envelope } }
        : run;
    }
    if (body.action === 'isolate') {
      const isolation = createRecoveryIsolationRecord(store, {
        project_id: candidate.project_id ?? null,
        object_type: 'recovery-candidate',
        object_id: candidate.candidate_id,
        reason: body.reason,
        isolated_by: body.decided_by,
        evidence: body.reason,
      });
      if (!isolation.ok || !isolation.data) return isolation;
      store.updateOrphanRecoveryCandidate(candidate_id, {
        status: 'isolated',
        decision: 'retain-evidence-only',
        decided_by: body.decided_by,
        decided_at: Date.now(),
      } as Partial<typeof candidate>);
      const isolated = store.listOrphanRecoveryCandidates().find((row) => row.candidate_id === candidate_id);
      return { ok: true, data: { ...isolated, isolation_id: isolation.data.isolation_id } };
    }
    // keep：保留现场待复核，只落 decision 与裁决者，不改终态。
    store.updateOrphanRecoveryCandidate(candidate_id, {
      decision: 'retain-evidence-only',
      decided_by: body.decided_by,
      decided_at: Date.now(),
    } as Partial<typeof candidate>);
    return { ok: true, data: store.listOrphanRecoveryCandidates().find((row) => row.candidate_id === candidate_id) };
  });

  // 三方对账（22.2-03）：SQLite × artifact blob × git refs；只读报告，不自动修复。
  app.post('/v2/reconcile/three-way', async (req) => {
    const body = (req.body ?? {}) as { project_ids?: string[] };
    const report = await reconcileThreeWay({
      store,
      artifactRoot,
      gitProvider,
      projectIds: body.project_ids,
    });
    return { ok: true, data: report };
  });

  app.get('/v2/recovery-isolations', async (req) => {
    const query = req.query as { project_id?: string; status?: string };
    return { ok: true, data: { items: store.listRecoveryIsolations(query.project_id, query.status) } };
  });

  // 三步分权第 1 步：isolator 创建（22.4-06；registry 已声明
  // ReconcileService.createRecoveryIsolation）
  app.post('/v2/recovery-isolations', async (req) => {
    const body = req.body as {
      project_id?: string | null;
      transition_id?: string;
      object_type: 'remote-ref' | 'recovery-candidate' | 'artifact-manifest' | 'ownership-snapshot' | 'mode-transition';
      object_id: string;
      evidence: string;
      reason: string;
      isolated_by: string;
    };
    return createRecoveryIsolationRecord(store, {
      project_id: body.project_id ?? null,
      transition_id: body.transition_id,
      object_type: body.object_type,
      object_id: body.object_id,
      evidence: body.evidence,
      reason: body.reason,
      isolated_by: body.isolated_by,
    });
  });

  // 三步分权第 2 步：reviewer 复核（≠isolator，强制校验）
  app.post('/v2/recovery-isolations/:isolation_id/review', async (req) => {
    const { isolation_id } = req.params as { isolation_id: string };
    const body = req.body as { reviewed_by: string; verdict: 'confirm' | 'dispute'; evidence?: string };
    return reviewRecoveryIsolationRecord(store, isolation_id, body);
  });

  // 三步分权第 3 步：reconcile 服务 resolve（前置=独立 reviewer confirm）
  app.post('/v2/recovery-isolations/:isolation_id/resolve', async (req) => {
    const { isolation_id } = req.params as { isolation_id: string };
    const body = req.body as { resolved_by: string; resolution: string };
    return resolveRecoveryIsolationRecord(store, isolation_id, body);
  });

  // Outbox dead-letter routes（Phase 7a）
  app.get('/v2/outbox/dead-letters', async (req) => {
    const query = req.query as { limit?: string };
    const deadLetters = store.listOutboxEvents('dead_letter', query.limit ? Number(query.limit) : 100);
    return { ok: true, data: { items: deadLetters, count: deadLetters.length } };
  });

  app.get('/v2/outbox/dead-letters/:event_id', async (req) => {
    const { event_id } = req.params as { event_id: string };
    const event = store.getOutboxEvent(event_id);
    if (!event) return { ok: false, data: null, error: { code: 'NOT_FOUND', message: `event ${event_id} 不存在` } };
    return { ok: true, data: event };
  });

  app.post('/v2/outbox/dead-letters/:event_id/requeue', async (req) => {
    const { event_id } = req.params as { event_id: string };
    const body = req.body as { reason: string };
    const event = store.getOutboxEvent(event_id);
    if (!event) return { ok: false, data: null, error: { code: 'NOT_FOUND', message: `event ${event_id} 不存在` } };
    if (event.status !== 'dead_letter') return { ok: false, data: null, error: { code: 'INVALID_STATUS', message: `event ${event_id} status is ${event.status}, not dead_letter` } };
    const ts = Date.now();
    store.updateOutboxEvent(event_id, {
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: ts,
      last_error: `requeued: ${body.reason || 'api requeue'}`,
      dead_lettered_at: null,
    });
    return { ok: true, data: { event_id, status: 'pending' } };
  });

  app.post('/v2/outbox/dead-letters/:event_id/compensate', async (req) => {
    const { event_id } = req.params as { event_id: string };
    const body = req.body as { reason: string };
    const event = store.getOutboxEvent(event_id);
    if (!event) return { ok: false, data: null, error: { code: 'NOT_FOUND', message: `event ${event_id} 不存在` } };
    if (event.status !== 'dead_letter') return { ok: false, data: null, error: { code: 'INVALID_STATUS', message: `event ${event_id} status is ${event.status}, not dead_letter` } };
    const ts = Date.now();
    const compensatingEventId = `evt-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    store.insertOutboxEvent({
      event_id: compensatingEventId,
      project_id: event.project_id,
      aggregate_type: event.aggregate_type,
      aggregate_id: event.aggregate_id,
      aggregate_revision: event.aggregate_revision + 1,
      payload_digest: event.payload_digest,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: ts,
      last_error: '',
      dead_lettered_at: null,
      compensates_event_id: event.event_id,
    });
    return { ok: true, data: { compensating_event_id: compensatingEventId, compensates: event_id } };
  });

  // Metrics endpoint（Phase 7a）
  app.get('/v2/metrics', async (_req, reply) => {
    const metrics = metricsService.generateMetrics();
    return reply.type('text/plain; version=0.0.4').send(metrics);
  });

  // Backup/Restore routes（Phase 7a）
  app.post('/v2/backup/restore-points', async () => {
    return backupCoordinator.createRestorePoint();
  });

  app.get('/v2/backup/restore-points', async (req) => {
    const query = req.query as { status?: string };
    return backupCoordinator.listRestorePoints(query.status);
  });

  app.post('/v2/backup/restore-points/:restore_point_id/drill', async (req) => {
    const { restore_point_id } = req.params as { restore_point_id: string };
    return backupCoordinator.restoreDrill(restore_point_id);
  });

  app.get('/v2/backup/restore-points/:restore_point_id/runs', async (req) => {
    const { restore_point_id } = req.params as { restore_point_id: string };
    return backupCoordinator.listBackupRuns(restore_point_id);
  });

  // Mode transition recovery routes（Phase 7a）
  app.get('/v2/projects/:project_id/mode-transitions', async (req) => {
    const { project_id } = req.params as { project_id: string };
    const query = req.query as { status?: string };
    const transitions = store.listProjectModeTransitions(project_id, query.status);
    return { ok: true, data: { items: transitions } };
  });

  app.post('/v2/projects/:project_id/mode-transitions/:transition_id/retry', async (req) => {
    const { project_id, transition_id } = req.params as { project_id: string; transition_id: string };
    // 车道 C：retry 收口到 project-service（步骤失败可重试；24h 超期不可
    // 重试，须先关闭关联 RecoveryIsolation——§12.1.1 超期语义）
    return retryModeTransition(store, transition_id);
  });

  // Project binding/stub routes
  app.post('/v2/projects/:project_id/validate', notImplemented);
  app.patch('/v2/projects/:project_id/policy', notImplemented);

  /* ---- Human Identity 与凭据生命周期（Phase 6；owner-only 管理面，RBAC 守卫前置） ---- */

  app.post('/v2/human-sessions', async (req) => {
    const body = req.body as { subject: string; role: string; project_id?: string; ttl_seconds?: number };
    return humanIdentity.issueSession(
      {
        subject: body.subject,
        role: body.role as never,
        project_id: body.project_id,
        ttl_seconds: body.ttl_seconds,
      },
      { actor_id: requestActor(req).actor_id, correlation_id: requestCorrelation(req) },
    );
  });

  app.post('/v2/human-sessions/:session_id/revoke', async (req) => {
    const { session_id } = req.params as { session_id: string };
    const body = req.body as { reason: string };
    return humanIdentity.revokeSession(session_id, body, {
      actor_id: requestActor(req).actor_id,
      correlation_id: requestCorrelation(req),
    });
  });

  app.get('/v2/human-sessions', async (req) => {
    const query = req.query as { subject?: string; project_id?: string; status?: string };
    return humanIdentity.listSessions(query);
  });

  app.post('/v2/project-memberships', async (req) => {
    const body = req.body as { project_id: string; subject: string; role: string };
    return humanIdentity.grantMembership(
      { project_id: body.project_id, subject: body.subject, role: body.role as never },
      { actor_id: requestActor(req).actor_id, correlation_id: requestCorrelation(req) },
    );
  });

  app.post('/v2/project-memberships/:membership_id/revoke', async (req) => {
    const { membership_id } = req.params as { membership_id: string };
    const body = req.body as { reason: string };
    return humanIdentity.revokeMembership(membership_id, body, {
      actor_id: requestActor(req).actor_id,
      correlation_id: requestCorrelation(req),
    });
  });

  app.get('/v2/project-memberships', async (req) => {
    const query = req.query as { project_id?: string; status?: string };
    return humanIdentity.listMemberships(query);
  });

  app.post('/v2/nodes/:node_id/credential/rotate', async (req) => {
    const { node_id } = req.params as { node_id: string };
    const body = req.body as { reason: string };
    return credentialLifecycle.rotateNodeCredential(node_id, body, {
      actor_id: requestActor(req).actor_id,
      correlation_id: requestCorrelation(req),
    });
  });

  app.post('/v2/security/revoke-all-sessions', async (req) => {
    const body = req.body as { reason: string };
    return credentialLifecycle.revokeAllSessions(body, {
      actor_id: requestActor(req).actor_id,
      correlation_id: requestCorrelation(req),
    });
  });
};
