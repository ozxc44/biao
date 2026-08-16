/**
 * biao-node 控制面 HTTP 客户端（Phase 3）
 *
 * 只调用 server 侧 V2 接口（src/server/v2/routes/registry.ts 的契约），
 * 不 import server 内部实现。职责：
 * - 统一 Authorization 头与“过渡鉴权协商”：目标形态是 bvn2_ Node credential
 *   直接鉴权；当前 server 的横切鉴权只认 owner bearer（缺口清单 #6），因此
 *   收到 401 时自动降级重试一次 owner 引导 token，并把生效模式记录在
 *   auth_mode 中（状态文件/日志可见，不静默）；
 * - 解析 ApiResponse 信封 { ok, data, error }，同时捕获响应 Date 头作为
 *   服务端时间观测（§10.4：服务端时间是 lease 真相）；
 * - 把网络异常/HTTP 状态/错误码归类为稳定的失败类型，供 daemon 状态机
 *   fail-closed 分支使用（fenced / unauthorized / network / not_implemented…）。
 *
 * fetchImpl 可注入：p3 测试用 tests/distributed/fixtures/fault-injector 的
 * wrapFetchWithFaults 包装后注入，实现网络分区与响应篡改注入。
 */

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** 稳定失败分类：daemon 状态机只认这些类别。 */
export type TransportFailureKind =
  | 'NETWORK'
  | 'UNAUTHORIZED'
  | 'FENCED'
  | 'NOT_IMPLEMENTED'
  | 'SERVER'
  | 'CLIENT'
  | 'UNKNOWN';

export interface ApiCallResult<T> {
  /** HTTP 层是否 2xx 且信封 ok=true。 */
  ok: boolean;
  status: number;
  data: T | null;
  error: { code: string; message: string } | null;
  /** 响应 Date 头解析出的服务端时间（毫秒 epoch）；缺失为 null。 */
  serverDateMs: number | null;
  /** 请求发出/响应到达的节点墙钟（§10.4 服务端时间观测的 midpoint 校正）。 */
  timing: { sent_at_wall: number; received_at_wall: number } | null;
  /** 非 ok 时的稳定分类；ok 时为 null。 */
  failure: TransportFailureKind | null;
  /** 本轮生效的鉴权模式（401 回退后为 owner_fallback）。 */
  authMode: AuthMode;
}

export type AuthMode = 'node_credential' | 'owner_fallback' | 'none';

export interface NodeApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchImpl;
  /** bvn2_ Node credential（enroll 后的长期凭据）。 */
  nodeCredential?: string;
  /** 过渡期 owner 引导 token（推荐经 env 注入，不落盘）。 */
  ownerToken?: string;
  userAgent?: string;
  onRequest?: (info: { method: string; path: string; body?: unknown }) => void;
  /** 环境变量注入（默认 process.env）；测试可注入自定义 env。 */
  env?: NodeJS.ProcessEnv;
  /** 墙钟注入点（daemon 传 NodeClock.now()，故障注入才能作用于 skew 观测）。 */
  now?: () => number;
}

/** 服务端信封（与 src/types ApiResponse 对齐；此处只声明用到的字段）。 */
interface ApiEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string } | null;
}

const FENCED_CODES = new Set([
  'GENERATION_MISMATCH',
  'SESSION_FENCED',
  'CREDENTIAL_FENCED',
  'FENCED',
  'LEASE_LOST',
  'CONFLICT',
]);

function classifyFailure(status: number, code: string | undefined): TransportFailureKind {
  if (status === 409) return 'FENCED';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (code && FENCED_CODES.has(code)) return 'FENCED';
  if (code === 'NOT_IMPLEMENTED') return 'NOT_IMPLEMENTED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'UNKNOWN';
}

export class NodeApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly nodeCredential?: string;
  private readonly ownerToken?: string;
  private readonly userAgent: string;
  private readonly onRequest?: NodeApiClientOptions['onRequest'];
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private authMode: AuthMode;

  constructor(options: NodeApiClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`biao_url 必须是 http(s) URL，实际为 ${options.baseUrl}`);
    }
    this.baseUrl = parsed.origin;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
    this.nodeCredential = options.nodeCredential;
    this.ownerToken = options.ownerToken;
    this.userAgent = options.userAgent ?? 'biao-node/0.1 (phase3-skeleton)';
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.authMode = this.nodeCredential ? 'node_credential' : this.ownerToken ? 'owner_fallback' : 'none';
    if (!this.nodeCredential && !this.ownerToken) {
      // 无凭据运行只在“服务端关闭鉴权”的部署成立；显式标记 none 便于排查。
      this.authMode = 'none';
    }
  }

  getAuthMode(): AuthMode {
    return this.authMode;
  }

  private bearerToken(): string | undefined {
    if (this.authMode === 'node_credential') return this.nodeCredential;
    if (this.authMode === 'owner_fallback') return this.ownerToken;
    return undefined;
  }

  private buildHeaders(): Record<string, string> {
    const token = this.bearerToken();
    return {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private static serverDate(res: Response): number | null {
    const raw = res.headers.get('date');
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  private static async parse<T>(res: Response): Promise<{ envelope: ApiEnvelope<T>; failure: TransportFailureKind | null; status: number }> {
    const text = await res.text().catch(() => '');
    let envelope: ApiEnvelope<T>;
    try {
      envelope = text ? (JSON.parse(text) as ApiEnvelope<T>) : {};
    } catch {
      envelope = { ok: false, error: { code: `HTTP_${res.status}`, message: text.slice(0, 200) || '服务返回了无法解析的响应' } };
    }
    const code = envelope.error?.code;
    const ok = res.ok && envelope.ok === true;
    return { envelope, failure: ok ? null : classifyFailure(res.status, code), status: res.status };
  }

  /**
   * 单次 API 调用：node credential 收到 401 时，
   * 仅当显式设置 BIAO_NODE_OWNER_TOKEN_FALLBACK=1 时才降级重试 owner token；
   * 否则直接返回 401（fail-closed）。Phase 2+3 集成后服务端已接受 bvn2，
   * 此回退路径仅用于过渡期排障。
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<ApiCallResult<T>> {
    this.onRequest?.({ method, path, body });
    const sentAtWall = this.now();
    let res: Response;
    try {
      res = await this.rawRequest(method, path, body);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : String(error) },
        serverDateMs: null,
        timing: { sent_at_wall: sentAtWall, received_at_wall: this.now() },
        failure: 'NETWORK',
        authMode: this.authMode,
      };
    }
    if (res.status === 401 && this.authMode === 'node_credential' && this.ownerToken) {
      // Phase 2+3 集成后默认不再自动回退；仅当显式开启时降级。
      // 环境变量 BIAO_NODE_OWNER_TOKEN_FALLBACK=1 启用过渡期回退。
      const envVal = this.env.BIAO_NODE_OWNER_TOKEN_FALLBACK ?? process.env.BIAO_NODE_OWNER_TOKEN_FALLBACK;
      const fallbackEnabled = envVal === '1';
      if (fallbackEnabled) {
        this.authMode = 'owner_fallback';
        try {
          res = await this.rawRequest(method, path, body);
        } catch {
          // 回退请求也失败：返回原 401 结果
          this.authMode = 'node_credential';
        }
      }
    }
    const receivedAtWall = this.now();
    const serverDateMs = NodeApiClient.serverDate(res);
    const { envelope, failure, status } = await NodeApiClient.parse<T>(res);
    return {
      ok: failure === null,
      status,
      data: (envelope.data ?? null) as T | null,
      error: envelope.error ? { code: envelope.error.code ?? `HTTP_${status}`, message: envelope.error.message ?? '' } : null,
      serverDateMs,
      timing: { sent_at_wall: sentAtWall, received_at_wall: receivedAtWall },
      failure,
      authMode: this.authMode,
    };
  }

  /* ---- 便捷方法：只覆盖 Phase 3 daemon 用到的 V2 端点 ---- */

  /** GET /version：协议协商的服务端公告来源。 */
  getVersion(): Promise<ApiCallResult<{ version?: string; name?: string; protocol_version?: number }>> {
    return this.call('GET', '/version');
  }

  enroll(input: { enrollment_ticket: string; node_id: string }): Promise<ApiCallResult<{ node_credential: string; credential_generation: number }>> {
    return this.call('POST', '/v2/nodes/enroll', input);
  }

  register(input: { node_id: string; labels?: string[]; slots: number; requested_project_ids: string[] }): Promise<ApiCallResult<Record<string, unknown>>> {
    return this.call('POST', '/v2/nodes/register', input);
  }

  heartbeat(nodeId: string, input: Record<string, unknown>): Promise<ApiCallResult<{ status?: string; config_revision?: number }>> {
    return this.call('POST', `/v2/nodes/${encodeURIComponent(nodeId)}/heartbeat`, input);
  }

  drain(nodeId: string): Promise<ApiCallResult<Record<string, unknown>>> {
    return this.call('POST', `/v2/nodes/${encodeURIComponent(nodeId)}/drain`, {});
  }

  offline(nodeId: string, reason: string): Promise<ApiCallResult<{ node_id?: string; offline?: boolean }>> {
    return this.call('POST', `/v2/nodes/${encodeURIComponent(nodeId)}/offline`, { reason });
  }

  /** POST /v2/tasks/claim：Phase 4 真实执行入口；当前为 server stub。 */
  claim(input: Record<string, unknown>): Promise<ApiCallResult<Record<string, unknown>>> {
    return this.call('POST', '/v2/tasks/claim', input);
  }

  /** POST /v2/attempts/:id/lease/renew：lease watchdog 的续租通道。 */
  renewLease(attemptId: string, input: Record<string, unknown>): Promise<ApiCallResult<{ lease_expires_at?: number }>> {
    return this.call('POST', `/v2/attempts/${encodeURIComponent(attemptId)}/lease/renew`, input);
  }

  /** POST /v2/attempts/:id/report：停止/收口后的上报通道。 */
  reportAttempt(attemptId: string, input: Record<string, unknown>): Promise<ApiCallResult<Record<string, unknown>>> {
    return this.call('POST', `/v2/attempts/${encodeURIComponent(attemptId)}/report`, input);
  }
}
