/**
 * V2 凭据原语（Phase 1 · 车道 C，R1A-003/R1A-007）
 *
 * §13.1 身份分层中两类机器凭据的最小实现，纯函数、无 DB 依赖：
 * - Node credential：节点长期凭据，HMAC-SHA256 签名、防篡改、generation 内嵌；
 *   撤销/隔离靠 credential_generation fencing（§4.2：revoke/quarantine 提升
 *   generation 后，旧 generation 的一切写请求直接拒绝）。
 * - Attempt token：claim 成功后控制面签发的短期凭据，scope 固定为
 *   claim/report/ownership/question 四类能力，有效期短于 lease 最大期限（§13.5）。
 *
 * 密钥与轮换：
 * - 密钥来源 env `BIAO_V2_CREDENTIAL_KEY`（32+ 字节 hex），与 V1 BIAO_API_TOKEN
 *   完全独立——泄漏任一侧都不能伪造另一侧凭据。
 * - 轮换窗口：值为 `<hex>`（key_version=1）或逗号分隔的 `<version>:<hex>` 清单；
 *   最高 version 为签发 key，其余仅用于验签。撤掉旧 version 即拒绝其签发的
 *   全部 token（reason=UNKNOWN_KEY_VERSION）。
 * - 启动期 fail-fast：assertV2CredentialKeyConfigured() 在未配置/格式非法时抛出
 *   并附生成指引；签发侧遇到空密钥环同样抛出。verify 侧 fail-closed：密钥缺失
 *   或非法时一律拒绝（NO_KEY_CONFIGURED），不抛出。
 *
 * 泄漏语义：token 字符串 = `<前缀>_<base64url(claims JSON)>.<base64url(HMAC)>`，
 * 只含 claims 与签名，不含密钥材料；校验失败只返回稳定 reason 枚举，
 * 任何错误信息都不回显 token 内容。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** V2 凭据签名密钥的环境变量名（与 V1 BIAO_API_TOKEN 完全独立）。 */
export const V2_CREDENTIAL_KEY_ENV = 'BIAO_V2_CREDENTIAL_KEY';

/** HMAC-SHA256 密钥的最小长度（字节）。 */
export const V2_CREDENTIAL_KEY_MIN_BYTES = 32;

/**
 * Attempt token 的能力枚举（§13.1 Task Attempt / §13.5 token scope）：
 * - claim：维持 claim 生命周期（lease renew）；
 * - report：收口链路（report、Artifact 上传、Delivery 创建与读取）；
 * - ownership：执行期 ownership 投影（V2 路由 Phase 2+ 挂接时启用）；
 * - question：Worker→PM 受控提问。
 */
export const ATTEMPT_TOKEN_SCOPES = ['claim', 'report', 'ownership', 'question'] as const;
export type AttemptTokenScope = (typeof ATTEMPT_TOKEN_SCOPES)[number];

export function isAttemptTokenScope(value: unknown): value is AttemptTokenScope {
  return typeof value === 'string' && (ATTEMPT_TOKEN_SCOPES as readonly string[]).includes(value);
}

/**
 * Merge Bot token 能力枚举（22.3-04）：
 * - merge：合并队列操作（enqueue/dispatch/retry/cancel）。
 * Merge Bot 无 Agent/Plan 权限（rbac 矩阵断言：bvm2 对 claim/report/plan 路由 403）。
 */
export const MERGE_BOT_TOKEN_SCOPES = ['merge'] as const;
export type MergeBotTokenScope = (typeof MERGE_BOT_TOKEN_SCOPES)[number];

export function isMergeBotTokenScope(value: unknown): value is MergeBotTokenScope {
  return typeof value === 'string' && (MERGE_BOT_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Node credential 默认有效期：长期凭据，撤销靠 generation fencing 而非自然过期。 */
export const NODE_CREDENTIAL_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** Attempt token 默认有效期：短期，部署时必须保持短于 lease 最大期限（§13.5）。 */
export const ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS = 15 * 60;
/** Merge Bot token 默认有效期：中等时长，项目绑定。 */
export const MERGE_BOT_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60;

/* ------------------------------------------------------------------ */
/* 密钥环                                                             */
/* ------------------------------------------------------------------ */

/** 单把签名密钥：material 只存在于进程内，不进入 token/日志/错误信息。 */
export interface V2CredentialKey {
  key_version: number;
  material: Buffer;
}

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** 解析单条 hex 密钥（≥ V2_CREDENTIAL_KEY_MIN_BYTES 字节）。错误信息不含密钥内容。 */
export function parseCredentialKey(hex: string, keyVersion: number): V2CredentialKey {
  const trimmed = hex.trim();
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error(`V2 凭据密钥 key_version 必须是正整数，实际为 ${keyVersion}`);
  }
  if (!trimmed || !HEX_PATTERN.test(trimmed)) {
    throw new Error(`V2 凭据密钥第 ${keyVersion} 版格式非法：需要 hex 字符串`);
  }
  const material = Buffer.from(trimmed, 'hex');
  if (material.length < V2_CREDENTIAL_KEY_MIN_BYTES) {
    throw new Error(
      `V2 凭据密钥第 ${keyVersion} 版长度不足：需要 ≥${V2_CREDENTIAL_KEY_MIN_BYTES} 字节（${V2_CREDENTIAL_KEY_MIN_BYTES * 2} 个 hex 字符），实际 ${material.length} 字节`,
    );
  }
  return { key_version: keyVersion, material };
}

/**
 * 解析 BIAO_V2_CREDENTIAL_KEY：
 * - `<hex>`：单 key，key_version=1；
 * - `<version>:<hex>[,<version>:<hex>...]`：轮换窗口，最高 version 为签发 key。
 * key_version 重复视为配置错误（无法确定验签语义）。
 */
export function parseCredentialKeyring(raw: string): V2CredentialKey[] {
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('V2 凭据密钥环为空');
  const keys: V2CredentialKey[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const [versionPart, hexPart] = separator === -1 ? ['1', entry] : [entry.slice(0, separator), entry.slice(separator + 1)];
    const version = Number(versionPart);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`V2 凭据密钥环存在非法 key_version：${versionPart || '(空)'}`);
    }
    if (keys.some((key) => key.key_version === version)) {
      throw new Error(`V2 凭据密钥环存在重复 key_version：${version}`);
    }
    keys.push(parseCredentialKey(hexPart, version));
  }
  keys.sort((a, b) => a.key_version - b.key_version);
  return keys;
}

/** 读取 env 密钥环；未配置返回 []（是否 fail-fast 由调用方决定）。 */
export function loadV2CredentialKeyring(env: NodeJS.ProcessEnv = process.env): V2CredentialKey[] {
  const raw = env[V2_CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) return [];
  return parseCredentialKeyring(raw);
}

/** fail-closed 版 load：配置非法时按“无可用密钥”处理，只用于 verify 路径。 */
function safeLoadV2CredentialKeyring(env?: NodeJS.ProcessEnv): V2CredentialKey[] {
  try {
    return loadV2CredentialKeyring(env);
  } catch {
    return [];
  }
}

/** 生成指引（启动期 fail-fast 信息的一部分；不含任何密钥值）。 */
function credentialKeyHint(): string {
  return (
    `未配置或非法：${V2_CREDENTIAL_KEY_ENV} 需要 ≥${V2_CREDENTIAL_KEY_MIN_BYTES} 字节 hex。` +
    `生成方式：openssl rand -hex ${V2_CREDENTIAL_KEY_MIN_BYTES}（或 ` +
    `node -e "console.log(require('node:crypto').randomBytes(${V2_CREDENTIAL_KEY_MIN_BYTES}).toString('hex'))"）。` +
    `轮换窗口写法："<version>:<hex>,<version>:<hex>"，最高 version 为签发 key。` +
    `该密钥与 V1 BIAO_API_TOKEN 完全独立，不得复用。`
  );
}

/**
 * 启动期 fail-fast：V2 控制面开始签发凭据前必须调用（V2 路由装配点接入；
 * 纯 V1 部署不配置该 env 也不受影响——本模块的隔离门不消费该密钥）。
 */
export function assertV2CredentialKeyConfigured(env: NodeJS.ProcessEnv = process.env): V2CredentialKey[] {
  const raw = env[V2_CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) throw new Error(`BIAO V2 凭据密钥${credentialKeyHint()}`);
  try {
    return parseCredentialKeyring(raw);
  } catch (error) {
    throw new Error(`BIAO V2 凭据密钥配置非法：${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* token 编码                                                         */
/* ------------------------------------------------------------------ */

const NODE_TOKEN_PREFIX = 'bvn2';
const ATTEMPT_TOKEN_PREFIX = 'bva2';
const MERGE_BOT_TOKEN_PREFIX = 'bvm2';

const JTI_PATTERN = /^[0-9a-f]{16,64}$/;
const ID_MAX_LENGTH = 128;

function assertTokenId(value: string, field: string): void {
  if (!value || value.length > ID_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`V2 凭据 ${field} 必须是 1~${ID_MAX_LENGTH} 字符且不含控制字符`);
  }
}

function assertGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(`V2 凭据 generation 必须是正整数，实际为 ${generation}`);
  }
}

function hmacPayload(key: V2CredentialKey, payload: string): Buffer {
  return createHmac('sha256', key.material).update(payload, 'utf8').digest();
}

function encodeSignedToken(prefix: string, claims: Record<string, unknown>, key: V2CredentialKey): string {
  // 固定插入顺序序列化，verify 侧按同一顺序重编码做规范化比对。
  // 签名对象是 base64url 化的 payload 段（与 JWT 的段签名口径一致）。
  const payloadSegment = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = hmacPayload(key, payloadSegment);
  return `${prefix}_${payloadSegment}.${signature.toString('base64url')}`;
}

interface DecodedToken {
  payloadSegment: string;
  signature: Buffer;
}

/** 拆 `<prefix>_<payload>.<sig>`；结构不符返回 null（不抛出、不回显内容）。 */
function decodeSignedToken(token: string, prefix: string): DecodedToken | null {
  if (typeof token !== 'string' || token.length <= prefix.length + 2) return null;
  if (token.codePointAt(prefix.length) !== 0x5f /* '_' */) return null;
  const body = token.slice(prefix.length + 1);
  const dot = body.indexOf('.');
  if (dot <= 0 || body.indexOf('.', dot + 1) !== -1) return null;
  try {
    return {
      payloadSegment: body.slice(0, dot),
      signature: Buffer.from(body.slice(dot + 1), 'base64url'),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* claims 与校验结果                                                   */
/* ------------------------------------------------------------------ */

/** Node credential 的已签名声明（token 内嵌字段，不含密钥材料）。 */
export interface NodeCredentialClaims {
  node_id: string;
  /** 签发时的 credential_generation；fencing 判据（§4.2）。 */
  generation: number;
  key_version: number;
  issued_at: number;
  expires_at: number;
  /** 未来入库只存 hash/jti（§13.5），撤销清单按 jti 收录。 */
  jti: string;
}

/** Attempt token 的已签名声明（token 内嵌字段，不含密钥材料）。 */
export interface AttemptTokenClaims {
  attempt_id: string;
  task_id: string;
  /** attempt_generation fencing 字段（§13.5：新 generation 产生后旧 token 立即失效）。 */
  generation: number;
  scope: AttemptTokenScope;
  key_version: number;
  issued_at: number;
  expires_at: number;
  jti: string;
}

/** Merge Bot token 的已签名声明（22.3-04：bvm2_ 前缀，HMAC 同体系）。 */
export interface MergeBotTokenClaims {
  /** Merge Bot 标识（如 project 级 bot ID）。 */
  bot_id: string;
  /** 绑定的 project_id（scope=merge，project 绑定）。 */
  project_id: string;
  scope: MergeBotTokenScope;
  key_version: number;
  issued_at: number;
  expires_at: number;
  jti: string;
}

/** 稳定失败原因枚举：不回显 token 内容，日志/审计可直接记录。 */
export type CredentialVerifyReason =
  | 'MALFORMED_TOKEN'
  | 'UNKNOWN_KEY_VERSION'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NO_KEY_CONFIGURED'
  | 'SUBJECT_MISMATCH'
  | 'GENERATION_MISMATCH'
  | 'SCOPE_MISMATCH';

export type CredentialVerifyResult<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: CredentialVerifyReason };

export interface IssueCredentialOptions {
  /** 覆盖密钥环（默认读 env BIAO_V2_CREDENTIAL_KEY；签发用最高 key_version）。 */
  keys?: V2CredentialKey[];
  /**
   * Phase 6（轮换/撤销扩展）：动态密钥环提供者，优先级高于 keys/env。
   * revoke-all-sessions 前滚 key_version 后，签发/验签都必须经由该提供者
   * 读到 env 密钥环 ∪ DB 轮换密钥并按 min_key_version 水位过滤；
   * 提供者每次调用现读（p23 env hermetic 门禁：env 变更即时生效）。
   */
  keyring?: () => V2CredentialKey[];
  /** 注入时钟（默认 Date.now()；测试用 fault-injector 的偏差时钟）。 */
  now?: number;
  ttlSeconds?: number;
}

export interface VerifyCredentialOptions extends IssueCredentialOptions {
  /** 期望的当前 generation（store 侧 credential_generation/attempt_generation）。 */
  expectedGeneration?: number;
}

function resolveIssueOptions(
  options: IssueCredentialOptions,
  defaultTtlSeconds: number,
): { key: V2CredentialKey; now: number; ttlSeconds: number } {
  const keys = options.keyring ? options.keyring() : (options.keys ?? loadV2CredentialKeyring());
  if (keys.length === 0) throw new Error(`BIAO V2 凭据密钥${credentialKeyHint()}`);
  const ttlSeconds = options.ttlSeconds ?? defaultTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`V2 凭据 ttlSeconds 必须是正整数，实际为 ${ttlSeconds}`);
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('V2 凭据签发时间非法');
  return { key: keys[keys.length - 1], now, ttlSeconds };
}

function resolveVerifyKeys(options: VerifyCredentialOptions): V2CredentialKey[] {
  if (options.keyring) return options.keyring();
  return options.keys ?? safeLoadV2CredentialKeyring();
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 声明字段：名字 + 校验器，数组顺序即签发时的序列化顺序（规范化比对依据）。 */
interface ClaimField {
  name: string;
  isValid: (value: unknown) => boolean;
}

const positiveIntField = (name: string): ClaimField => ({ name, isValid: isPositiveInt });
const idField = (name: string): ClaimField => ({
  name,
  isValid: (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH,
});

/** token 内的原始字段名（短名）；导出的 *Claims 是对外的规范命名。 */
interface NodeTokenPayload {
  kv: number;
  node_id: string;
  generation: number;
  iat: number;
  exp: number;
  jti: string;
}

interface AttemptTokenPayload {
  kv: number;
  attempt_id: string;
  task_id: string;
  generation: number;
  scope: AttemptTokenScope;
  iat: number;
  exp: number;
  jti: string;
}

interface MergeBotTokenPayload {
  kv: number;
  bot_id: string;
  project_id: string;
  scope: MergeBotTokenScope;
  iat: number;
  exp: number;
  jti: string;
}

/** 签发/校验共用的字段顺序，必须与 encodeSignedToken 收到的 claims 插入顺序一致。 */
const NODE_CLAIM_FIELDS: ClaimField[] = [
  positiveIntField('kv'),
  idField('node_id'),
  positiveIntField('generation'),
  positiveIntField('iat'),
  positiveIntField('exp'),
  { name: 'jti', isValid: (value: unknown): boolean => typeof value === 'string' && JTI_PATTERN.test(value) },
];

const ATTEMPT_CLAIM_FIELDS: ClaimField[] = [
  positiveIntField('kv'),
  idField('attempt_id'),
  idField('task_id'),
  positiveIntField('generation'),
  { name: 'scope', isValid: isAttemptTokenScope },
  positiveIntField('iat'),
  positiveIntField('exp'),
  { name: 'jti', isValid: (value: unknown): boolean => typeof value === 'string' && JTI_PATTERN.test(value) },
];

const MERGE_BOT_CLAIM_FIELDS: ClaimField[] = [
  positiveIntField('kv'),
  idField('bot_id'),
  idField('project_id'),
  { name: 'scope', isValid: isMergeBotTokenScope },
  positiveIntField('iat'),
  positiveIntField('exp'),
  { name: 'jti', isValid: (value: unknown): boolean => typeof value === 'string' && JTI_PATTERN.test(value) },
];

/** 公共字段严格校验 + 规范化重编码（拒绝多余/缺失字段、乱序、非规范 base64url）。 */
function parseCanonicalClaims(
  decoded: DecodedToken,
  versionTag: string,
  fields: ClaimField[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(decoded.payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== versionTag) return null;
  if (Object.keys(record).length !== fields.length + 1) return null;
  for (const field of fields) {
    if (!field.isValid(record[field.name])) return null;
  }
  // 按签发时的固定字段顺序重编码，与收到的 payload 段逐字节比对，封死同形异码绕过。
  const canonicalFields: Record<string, unknown> = { v: versionTag };
  for (const field of fields) canonicalFields[field.name] = record[field.name];
  if (JSON.stringify(canonicalFields) !== Buffer.from(decoded.payloadSegment, 'base64url').toString('utf8')) {
    return null;
  }
  return canonicalFields;
}

/**
 * 结构/密钥版本/签名/时效的公共校验；语义字段（subject/generation/scope）由调用方比对。
 * TClaims 的字段形状由 fields 的校验器在运行时保证（通过校验后才 cast）。
 */
function verifyCore<TClaims>(
  token: string,
  prefix: string,
  fields: ClaimField[],
  options: VerifyCredentialOptions,
): { error: CredentialVerifyReason } | { value: { claims: TClaims } } {
  const keys = resolveVerifyKeys(options);
  if (keys.length === 0) return { error: 'NO_KEY_CONFIGURED' };
  const decoded = decodeSignedToken(token, prefix);
  if (!decoded) return { error: 'MALFORMED_TOKEN' };
  const claims = parseCanonicalClaims(decoded, prefix, fields);
  if (!claims) return { error: 'MALFORMED_TOKEN' };
  if ((claims.exp as number) <= (claims.iat as number)) return { error: 'MALFORMED_TOKEN' };
  const key = keys.find((candidate) => candidate.key_version === claims.kv);
  if (!key) return { error: 'UNKNOWN_KEY_VERSION' };
  const expectedSignature = hmacPayload(key, decoded.payloadSegment);
  if (decoded.signature.length !== expectedSignature.length) return { error: 'BAD_SIGNATURE' };
  if (!timingSafeEqual(decoded.signature, expectedSignature)) return { error: 'BAD_SIGNATURE' };
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now >= (claims.exp as number)) return { error: 'EXPIRED' };
  return { value: { claims: claims as unknown as TClaims } };
}

/* ------------------------------------------------------------------ */
/* Node credential                                                    */
/* ------------------------------------------------------------------ */

/** 签发 Node credential：HMAC 签名 + generation 内嵌；node_id/gen 越界直接抛出。 */
export function issueNodeCredential(
  nodeId: string,
  generation: number,
  options: IssueCredentialOptions = {},
): string {
  assertTokenId(nodeId, 'node_id');
  assertGeneration(generation);
  const { key, now, ttlSeconds } = resolveIssueOptions(options, NODE_CREDENTIAL_DEFAULT_TTL_SECONDS);
  return encodeSignedToken(
    NODE_TOKEN_PREFIX,
    {
      v: NODE_TOKEN_PREFIX,
      kv: key.key_version,
      node_id: nodeId,
      generation,
      iat: now,
      exp: now + ttlSeconds * 1000,
      jti: randomBytes(8).toString('hex'),
    },
    key,
  );
}

/**
 * 校验 Node credential：结构 → key_version → 签名 → 时效 → node_id → generation。
 * expectedGeneration 是 store 侧当前 credential_generation（§4.2 fencing）：
 * revoke/quarantine 提升后，旧 generation 在此被拒绝。
 */
export function verifyNodeCredential(
  token: string,
  nodeId: string,
  options: VerifyCredentialOptions = {},
): CredentialVerifyResult<NodeCredentialClaims> {
  const core = verifyCore<NodeTokenPayload>(token, NODE_TOKEN_PREFIX, NODE_CLAIM_FIELDS, options);
  if ('error' in core) return { ok: false, reason: core.error };
  const { claims } = core.value;
  if (claims.node_id !== nodeId) return { ok: false, reason: 'SUBJECT_MISMATCH' };
  if (options.expectedGeneration !== undefined && claims.generation !== options.expectedGeneration) {
    return { ok: false, reason: 'GENERATION_MISMATCH' };
  }
  return {
    ok: true,
    claims: {
      node_id: claims.node_id,
      generation: claims.generation,
      key_version: claims.kv,
      issued_at: claims.iat,
      expires_at: claims.exp,
      jti: claims.jti,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Attempt token                                                      */
/* ------------------------------------------------------------------ */

export interface AttemptTokenExpectation {
  attemptId: string;
  taskId: string;
  /** 当前 attempt_generation：新 generation 产生后旧 token 必须立即失效（§13.5）。 */
  generation: number;
  scope: AttemptTokenScope;
}

/** 签发 Attempt token：scope/generation fencing 字段内嵌；越界入参直接抛出。 */
export function issueAttemptToken(
  attemptId: string,
  taskId: string,
  generation: number,
  scope: AttemptTokenScope,
  options: IssueCredentialOptions = {},
): string {
  assertTokenId(attemptId, 'attempt_id');
  assertTokenId(taskId, 'task_id');
  assertGeneration(generation);
  if (!isAttemptTokenScope(scope)) throw new Error(`V2 Attempt token scope 非法：${String(scope)}`);
  const { key, now, ttlSeconds } = resolveIssueOptions(options, ATTEMPT_TOKEN_DEFAULT_TTL_SECONDS);
  return encodeSignedToken(
    ATTEMPT_TOKEN_PREFIX,
    {
      v: ATTEMPT_TOKEN_PREFIX,
      kv: key.key_version,
      attempt_id: attemptId,
      task_id: taskId,
      generation,
      scope,
      iat: now,
      exp: now + ttlSeconds * 1000,
      jti: randomBytes(8).toString('hex'),
    },
    key,
  );
}

/**
 * 校验 Attempt token：结构 → key_version → 签名 → 时效 → attempt/task →
 * generation → scope。单一 token 只绑定单一 attempt/task（§16 验收：
 * Attempt Token 只能操作单任务）。
 */
export function verifyAttemptToken(
  token: string,
  expected: AttemptTokenExpectation,
  options: VerifyCredentialOptions = {},
): CredentialVerifyResult<AttemptTokenClaims> {
  const core = verifyCore<AttemptTokenPayload>(token, ATTEMPT_TOKEN_PREFIX, ATTEMPT_CLAIM_FIELDS, options);
  if ('error' in core) return { ok: false, reason: core.error };
  const { claims } = core.value;
  if (claims.attempt_id !== expected.attemptId || claims.task_id !== expected.taskId) {
    return { ok: false, reason: 'SUBJECT_MISMATCH' };
  }
  if (claims.generation !== expected.generation) {
    return { ok: false, reason: 'GENERATION_MISMATCH' };
  }
  if (claims.scope !== expected.scope) {
    return { ok: false, reason: 'SCOPE_MISMATCH' };
  }
  return {
    ok: true,
    claims: {
      attempt_id: claims.attempt_id,
      task_id: claims.task_id,
      generation: claims.generation,
      scope: claims.scope,
      key_version: claims.kv,
      issued_at: claims.iat,
      expires_at: claims.exp,
      jti: claims.jti,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Merge Bot token（22.3-04：bvm2_ 前缀，HMAC 同体系）                */
/* ------------------------------------------------------------------ */

export interface MergeBotTokenExpectation {
  botId: string;
  projectId: string;
  scope: MergeBotTokenScope;
}

/** 签发 Merge Bot token：scope=merge，project 绑定，key_version 轮换。 */
export function issueMergeBotToken(
  botId: string,
  projectId: string,
  scope: MergeBotTokenScope,
  options: IssueCredentialOptions = {},
): string {
  assertTokenId(botId, 'bot_id');
  assertTokenId(projectId, 'project_id');
  if (!isMergeBotTokenScope(scope)) throw new Error(`V2 Merge Bot token scope 非法：${String(scope)}`);
  const { key, now, ttlSeconds } = resolveIssueOptions(options, MERGE_BOT_TOKEN_DEFAULT_TTL_SECONDS);
  return encodeSignedToken(
    MERGE_BOT_TOKEN_PREFIX,
    {
      v: MERGE_BOT_TOKEN_PREFIX,
      kv: key.key_version,
      bot_id: botId,
      project_id: projectId,
      scope,
      iat: now,
      exp: now + ttlSeconds * 1000,
      jti: randomBytes(8).toString('hex'),
    },
    key,
  );
}

/**
 * 校验 Merge Bot token：结构 → key_version → 签名 → 时效 → bot_id/project_id → scope。
 * Merge Bot 无 Agent/Plan 权限（rbac 矩阵断言：bvm2 对 claim/report/plan 路由 403）。
 */
export function verifyMergeBotToken(
  token: string,
  expected: MergeBotTokenExpectation,
  options: VerifyCredentialOptions = {},
): CredentialVerifyResult<MergeBotTokenClaims> {
  const core = verifyCore<MergeBotTokenPayload>(token, MERGE_BOT_TOKEN_PREFIX, MERGE_BOT_CLAIM_FIELDS, options);
  if ('error' in core) return { ok: false, reason: core.error };
  const { claims } = core.value;
  if (claims.bot_id !== expected.botId || claims.project_id !== expected.projectId) {
    return { ok: false, reason: 'SUBJECT_MISMATCH' };
  }
  if (claims.scope !== expected.scope) {
    return { ok: false, reason: 'SCOPE_MISMATCH' };
  }
  return {
    ok: true,
    claims: {
      bot_id: claims.bot_id,
      project_id: claims.project_id,
      scope: claims.scope,
      key_version: claims.kv,
      issued_at: claims.iat,
      expires_at: claims.exp,
      jti: claims.jti,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phase 6：轮换 / 紧急撤销（运行时密钥环权威）                        */
/* ------------------------------------------------------------------ */

/** 生成一把新的 HMAC 密钥材料（hex；长度满足 V2_CREDENTIAL_KEY_MIN_BYTES）。 */
export function generateCredentialKeyHex(): string {
  return randomBytes(V2_CREDENTIAL_KEY_MIN_BYTES).toString('hex');
}

/** DB 落库的轮换密钥记录（由 store 层持久化，本模块不接触 DB）。 */
export interface PersistedCredentialKeyRecord {
  key_version: number;
  material_hex: string;
}

/**
 * 运行时密钥环权威（Phase 6 轮换/撤销收口）。
 *
 * resolve() = env 密钥环 ∪ DB 轮换密钥，再按 min_key_version 水位过滤：
 * - revoke-all-sessions 前滚水位后，旧版本 token 全部以 UNKNOWN_KEY_VERSION
 *   拒绝（复用 Phase 1 轮换语义），新签发继续走最高版本；
 * - 每次调用现读 env/DB（p23 env hermetic 门禁：不缓存、每请求生效）；
 * - env 侧解析失败按空集处理（verify fail-closed；签发侧由 resolveIssueOptions
 *   抛出 fail-fast 错误）。
 *
 * 纯依赖注入（loaders），本类不 import DB——持久化由装配点接线。
 */
export interface RuntimeKeyringLoaders {
  /** 默认 safeLoadV2CredentialKeyring 语义：env 缺失/非法 → []。 */
  loadEnvKeys?: () => V2CredentialKey[];
  /** DB 轮换密钥（默认无）。 */
  loadPersistedKeys?: () => PersistedCredentialKeyRecord[];
  /** 验签水位（默认 0 = 不启用）。 */
  loadMinKeyVersion?: () => number;
}

export class CredentialKeyringAuthority {
  private readonly loadEnvKeys: () => V2CredentialKey[];
  private readonly loadPersistedKeys: () => PersistedCredentialKeyRecord[];
  private readonly loadMinKeyVersion: () => number;

  constructor(loaders: RuntimeKeyringLoaders = {}) {
    this.loadEnvKeys = loaders.loadEnvKeys ?? ((): V2CredentialKey[] => safeLoadV2CredentialKeyring());
    this.loadPersistedKeys = loaders.loadPersistedKeys ?? ((): PersistedCredentialKeyRecord[] => []);
    this.loadMinKeyVersion = loaders.loadMinKeyVersion ?? ((): number => 0);
  }

  /** 当前生效密钥环（版本升序）；水位之下全部剔除。 */
  resolve(): V2CredentialKey[] {
    const minVersion = Math.max(0, this.loadMinKeyVersion());
    const byVersion = new Map<number, V2CredentialKey>();
    for (const key of this.loadEnvKeys()) byVersion.set(key.key_version, key);
    for (const record of this.loadPersistedKeys()) {
      // 同版本冲突时 DB 轮换密钥优先（revoke-all 语义：落库版本即权威签发版本）。
      try {
        byVersion.set(record.key_version, parseCredentialKey(record.material_hex, record.key_version));
      } catch {
        // 非法记录跳过（fail-closed：不因此放行旧版本）
      }
    }
    return [...byVersion.values()]
      .filter((key) => key.key_version >= minVersion)
      .sort((a, b) => a.key_version - b.key_version);
  }

  /** IssueCredentialOptions 形态的动态密钥环（签发/验签共用）。 */
  options(): { keyring: () => V2CredentialKey[] } {
    return { keyring: (): V2CredentialKey[] => this.resolve() };
  }

  /** 下一个签发版本 = env ∪ DB 最高版本 + 1（revoke-all 前滚目标）。 */
  nextKeyVersion(): number {
    const versions = this.loadEnvKeys().map((key) => key.key_version)
      .concat(this.loadPersistedKeys().map((record) => record.key_version));
    return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
  }
}
