export interface BiaoApiEnvelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error?: { code: string; message: string; details?: unknown };
}

export interface BiaoHttpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class BiaoRemoteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BiaoRemoteError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiEnvelope(value: unknown): value is BiaoApiEnvelope {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || !Object.hasOwn(value, 'data')) return false;
  if (value.ok) return true;
  return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

function scrubSecret(value: unknown, apiToken: string): unknown {
  if (typeof value === 'string') {
    return value.includes(apiToken) ? value.replaceAll(apiToken, '[REDACTED]') : value;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubSecret(entry, apiToken));
  if (!isRecord(value)) return value;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    scrubbed[key] = /^(?:authorization|api_?token|bearer|credential)$/i.test(key)
      ? '[REDACTED]'
      : scrubSecret(entry, apiToken);
  }
  return scrubbed;
}

function parseBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', 'BIAO_URL 不是有效的 HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', 'BIAO_URL 仅支持 HTTP(S)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BiaoRemoteError('REMOTE_CONFIG_INVALID', 'BIAO_URL 不得包含凭据、查询参数或 fragment');
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * 只通过中央 Biao HTTP API 读写事实。Bearer 仅存在于闭包和 Authorization header，
 * 不拼入 URL，也不暴露 getter。
 */
export class BiaoHttpClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private protocolReady?: Promise<void>;

  constructor(
    baseUrl: string,
    private readonly apiToken: string,
    options: BiaoHttpClientOptions = {},
  ) {
    this.baseUrl = parseBaseUrl(baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  }

  private async rawRequest<T>(path: string, init: RequestInit = {}): Promise<BiaoApiEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new BiaoRemoteError('REMOTE_UNAUTHORIZED', '中央 Biao API 拒绝了本机凭据');
      }
      if (response.status === 403) {
        throw new BiaoRemoteError('REMOTE_FORBIDDEN', '中央 Biao API 拒绝了当前凭据作用域');
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        throw new BiaoRemoteError('REMOTE_PROTOCOL_MISMATCH', '中央 Biao API 未返回 JSON 协议信封');
      }
      // timeout 覆盖完整 body 消费，而不只覆盖收到 response headers 之前。
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > this.maxResponseBytes) {
        throw new BiaoRemoteError('REMOTE_RESPONSE_TOO_LARGE', '中央 Biao API 响应超过 MCP 控制面上限');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BiaoRemoteError('REMOTE_PROTOCOL_MISMATCH', '中央 Biao API 返回了无效 JSON');
      }
      if (!isApiEnvelope(parsed) || (!response.ok && parsed.ok)) {
        throw new BiaoRemoteError('REMOTE_PROTOCOL_MISMATCH', '中央 Biao API 信封与 HTTP 状态不匹配');
      }
      if (!parsed.ok && parsed.error) {
        parsed.error = scrubSecret(parsed.error, this.apiToken) as NonNullable<BiaoApiEnvelope['error']>;
      }
      return parsed as BiaoApiEnvelope<T>;
    } catch (error) {
      if (error instanceof BiaoRemoteError) throw error;
      const errorName = isRecord(error) && typeof error.name === 'string' ? error.name : '';
      if (controller.signal.aborted || errorName === 'AbortError') {
        throw new BiaoRemoteError('REMOTE_TIMEOUT', '中央 Biao API 请求超时，未执行本地回退');
      }
      throw new BiaoRemoteError('REMOTE_UNAVAILABLE', '中央 Biao API 不可达，未执行本地回退');
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyProtocol(): Promise<void> {
    const health = await this.rawRequest<{ version?: unknown }>('/health');
    if (!health.ok) {
      throw new BiaoRemoteError(
        health.error?.code ?? 'REMOTE_HEALTH_FAILED',
        health.error?.message ?? '中央 Biao API health 检查失败',
      );
    }
    if (!isRecord(health.data) || health.data.version !== 'v1') {
      throw new BiaoRemoteError('REMOTE_PROTOCOL_MISMATCH', '中央 Biao HTTP API 版本不兼容');
    }
  }

  async health(): Promise<BiaoApiEnvelope<{ protocol: 'v1'; reachable: true }>> {
    await this.ensureProtocol();
    return { ok: true, data: { protocol: 'v1', reachable: true } };
  }

  async ensureProtocol(): Promise<void> {
    this.protocolReady ??= this.verifyProtocol();
    return this.protocolReady;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<BiaoApiEnvelope<T>> {
    await this.ensureProtocol();
    return this.rawRequest<T>(path, init);
  }
}
