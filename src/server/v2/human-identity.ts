/**
 * V2 Human Identity 最小版（Phase 6 · §13.1 身份分层 / §13.2 威胁模型）
 *
 * Owner 签发的人类会话凭据（bvh2）与项目粒度 RBAC 授权：
 * - bvh2 token：HMAC-SHA256 签名，claims = subject + role + project 绑定 + exp +
 *   jti，复用 bvn2/bva2 的密钥环体系（BIAO_V2_CREDENTIAL_KEY，含 key_version
 *   轮换窗口）与 fail-fast/fail-closed 纪律：签发侧密钥环为空抛出、verify 侧
 *   密钥缺失一律拒绝（NO_KEY_CONFIGURED），错误只回显稳定 reason 枚举。
 * - 会话吊销列表（human_sessions 表）：revoke 即失效，R1C-013 同语义——
 *   吊销/过期/水位（revoke-all）任一命中立即拒绝，不等待自然过期。
 * - project_memberships：项目粒度角色（owner/project_admin/reviewer/auditor）；
 *   会话校验时同步复核 membership 仍活跃（撤销 membership = 撤销其派生会话）。
 *
 * 本文件不接触 HTTP：token 原语纯函数；服务层组合 SqliteStore +
 * CredentialKeyringAuthority（依赖注入），由 routes/v2-routes.ts 接线。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { ApiResponse } from '../../types/index.js';
import type { HumanEnrollmentRow, HumanSessionRow, ProjectMembershipRow, V2HumanRole } from '../../types/v2-identity.js';
import type { V2CredentialKey } from './credentials.js';
import { generateCredentialKeyHex, issueNodeCredential } from './credentials.js';

/** §21 Phase 6 Human 角色枚举（rank 单调：owner > project_admin > reviewer > auditor）。 */
export const V2_HUMAN_ROLES: readonly V2HumanRole[] = ['owner', 'project_admin', 'reviewer', 'auditor'];

/** 角色 rank（RBAC 判据：rank(credential.role) ≥ rank(route.minRole)）。 */
export const HUMAN_ROLE_RANK: Record<V2HumanRole, number> = {
  owner: 4,
  project_admin: 3,
  reviewer: 2,
  auditor: 1,
};

export function isHumanRole(value: unknown): value is V2HumanRole {
  return typeof value === 'string' && (V2_HUMAN_ROLES as readonly string[]).includes(value);
}

/** 人类会话默认有效期（12h；短期于任何长期授权，吊销列表兜底）。 */
export const HUMAN_SESSION_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

/**
 * 方案 E：Web 控制台远程会话（biao_human_session Cookie）有效期（30 天）。
 * 与 V2 管理面签发的 bvh2（≤24h）同源同验签，仅 TTL 边界不同：浏览器会话
 * 需要跨天存活，吊销即时性由 human_sessions 每请求复核保证（R1C-013）。
 */
export const HUMAN_WEB_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** enrollment_code 前缀（bhe2_ + 32 字节随机 hex；只落库 sha256）。 */
export const HUMAN_ENROLLMENT_CODE_PREFIX = 'bhe2_';

/** enrollment 时效（小时）：默认 24h，上限 7 天。 */
export const HUMAN_ENROLLMENT_DEFAULT_TTL_HOURS = 24;
export const HUMAN_ENROLLMENT_MAX_TTL_HOURS = 168;

const HUMAN_TOKEN_PREFIX = 'bvh2';
const JTI_PATTERN = /^[0-9a-f]{16,64}$/;
const ID_MAX_LENGTH = 128;

/** token 内的原始字段名（短名）；导出的 *Claims 是对外规范命名。 */
interface HumanTokenPayload {
  v: string;
  kv: number;
  sub: string;
  role: V2HumanRole;
  pid: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

/** bvh2 的已签名声明（不含密钥材料）。 */
export interface HumanSessionClaims {
  subject: string;
  role: V2HumanRole;
  /** 空串 = 平台级（owner 角色）。 */
  project_id: string;
  session_id: string;
  key_version: number;
  issued_at: number;
  expires_at: number;
  jti: string;
}

export type HumanTokenVerifyReason =
  | 'MALFORMED_TOKEN'
  | 'UNKNOWN_KEY_VERSION'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NO_KEY_CONFIGURED'
  | 'SESSION_REVOKED'
  | 'SESSION_UNKNOWN';

export type HumanTokenVerifyResult =
  | { ok: true; claims: HumanSessionClaims }
  | { ok: false; reason: HumanTokenVerifyReason };

export interface HumanTokenOptions {
  /** 密钥环（默认读 env BIAO_V2_CREDENTIAL_KEY；签发用最高 key_version）。 */
  keys?: V2CredentialKey[];
  now?: number;
  ttlSeconds?: number;
}

/* ------------------------------------------------------------------ */
/* bvh2 token 编码/验签（与 bvn2 相同的规范化比对口径）                */
/* ------------------------------------------------------------------ */

function hmacPayload(key: V2CredentialKey, payloadSegment: string): Buffer {
  return createHmac('sha256', key.material).update(payloadSegment, 'utf8').digest();
}

function encodeHumanToken(payload: HumanTokenPayload, key: V2CredentialKey): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmacPayload(key, payloadSegment);
  return `${HUMAN_TOKEN_PREFIX}_${payloadSegment}.${signature.toString('base64url')}`;
}

interface DecodedToken {
  payloadSegment: string;
  signature: Buffer;
}

function decodeHumanToken(token: string): DecodedToken | null {
  if (typeof token !== 'string' || token.length <= HUMAN_TOKEN_PREFIX.length + 2) return null;
  if (token.codePointAt(HUMAN_TOKEN_PREFIX.length) !== 0x5f /* '_' */) return null;
  const body = token.slice(HUMAN_TOKEN_PREFIX.length + 1);
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

/** 严格字段校验 + 固定顺序重编码逐字节比对（封死同形异码绕过）。 */
function parseCanonicalHumanClaims(decoded: DecodedToken): HumanTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(decoded.payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const expectedKeys = ['v', 'kv', 'sub', 'role', 'pid', 'sid', 'iat', 'exp', 'jti'];
  if (record.v !== HUMAN_TOKEN_PREFIX) return null;
  if (Object.keys(record).length !== expectedKeys.length) return null;
  const isId = (value: unknown): boolean =>
    typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH;
  // pid 允许空串：owner 角色的平台级会话不绑定项目（服务层保证只有 owner 可为空）。
  const isIdOrEmpty = (value: unknown): boolean =>
    typeof value === 'string' && value.length <= ID_MAX_LENGTH;
  const isPosInt = (value: unknown): boolean =>
    typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (!isPosInt(record.kv)) return null;
  if (!isId(record.sub) || !isIdOrEmpty(record.pid) || !isId(record.sid)) return null;
  if (!isHumanRole(record.role)) return null;
  if (!isPosInt(record.iat) || !isPosInt(record.exp)) return null;
  if (typeof record.jti !== 'string' || !JTI_PATTERN.test(record.jti)) return null;
  if ((record.exp as number) <= (record.iat as number)) return null;
  const canonical: Record<string, unknown> = {};
  for (const key of expectedKeys) canonical[key] = record[key];
  if (JSON.stringify(canonical) !== Buffer.from(decoded.payloadSegment, 'base64url').toString('utf8')) {
    return null;
  }
  return record as unknown as HumanTokenPayload;
}

/** 签发 bvh2（纯函数；密钥环为空/入参非法直接抛出，错误信息不含 token 内容）。 */
export function issueHumanSessionToken(
  input: { subject: string; role: V2HumanRole; projectId: string; sessionId: string },
  options: HumanTokenOptions & { jti?: string } = {},
): string {
  const { subject, role, projectId, sessionId } = input;
  for (const [value, field, allowEmpty] of [
    [subject, 'subject', false],
    [projectId, 'project_id', true],
    [sessionId, 'session_id', false],
  ] as Array<[string, string, boolean]>) {
    const invalid = value.length > ID_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(value) || (!allowEmpty && value.length === 0);
    if (invalid) {
      throw new Error(`bvh2 会话 ${field} 必须${allowEmpty ? '是 0~' : '是 1~'}${ID_MAX_LENGTH} 字符且不含控制字符`);
    }
  }
  if (!isHumanRole(role)) throw new Error(`bvh2 会话 role 非法：${String(role)}`);
  const keys = options.keys ?? [];
  if (keys.length === 0) {
    throw new Error('bvh2 签发失败：V2 密钥环为空（BIAO_V2_CREDENTIAL_KEY 未配置或非法）');
  }
  const key = keys[keys.length - 1];
  const ttlSeconds = options.ttlSeconds ?? HUMAN_SESSION_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`bvh2 会话 ttlSeconds 必须是正整数，实际为 ${ttlSeconds}`);
  }
  const now = options.now ?? Date.now();
  return encodeHumanToken({
    v: HUMAN_TOKEN_PREFIX,
    kv: key.key_version,
    sub: subject,
    role,
    pid: projectId,
    sid: sessionId,
    iat: now,
    exp: now + ttlSeconds * 1000,
    jti: options.jti ?? randomBytes(8).toString('hex'),
  }, key);
}

/** 验签 bvh2 的密码学部分（结构 → key_version → 签名 → 时效）；会话状态由服务层复核。 */
export function verifyHumanSessionToken(token: string, options: HumanTokenOptions = {}): HumanTokenVerifyResult {
  const keys = options.keys ?? [];
  if (keys.length === 0) return { ok: false, reason: 'NO_KEY_CONFIGURED' };
  const decoded = decodeHumanToken(token);
  if (!decoded) return { ok: false, reason: 'MALFORMED_TOKEN' };
  const claims = parseCanonicalHumanClaims(decoded);
  if (!claims) return { ok: false, reason: 'MALFORMED_TOKEN' };
  const key = keys.find((candidate) => candidate.key_version === claims.kv);
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY_VERSION' };
  const expected = hmacPayload(key, decoded.payloadSegment);
  if (decoded.signature.length !== expected.length) return { ok: false, reason: 'BAD_SIGNATURE' };
  if (!timingSafeEqual(decoded.signature, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now >= claims.exp) return { ok: false, reason: 'EXPIRED' };
  return {
    ok: true,
    claims: {
      subject: claims.sub,
      role: claims.role,
      project_id: claims.pid,
      session_id: claims.sid,
      key_version: claims.kv,
      issued_at: claims.iat,
      expires_at: claims.exp,
      jti: claims.jti,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Human Identity 服务（store + keyring 组合）                         */
/* ------------------------------------------------------------------ */

export interface HumanIdentityOptions {
  /** 动态密钥环（revoke-all 前滚后仍能取到新签发密钥）。 */
  keyring: () => V2CredentialKey[];
  now?: () => number;
}

export interface IssueSessionInput {
  subject: string;
  role: V2HumanRole;
  /** role≠owner 必填：会话绑定的项目。 */
  project_id?: string;
  ttl_seconds?: number;
}

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ApiResponse<never> {
  return { ok: false, data: null, error: { code, message } };
}

export function createHumanIdentityService(store: SqliteStore, options: HumanIdentityOptions) {
  const now = options.now ?? ((): number => Date.now());

  function audit(
    action: string,
    actorId: string,
    subjectType: string,
    subjectId: string,
    correlationId: string,
    projectId: string | null,
  ): void {
    store.insertAuditEvent({
      audit_id: `aud-${randomBytes(10).toString('hex')}`,
      project_id: projectId,
      actor_id: actorId,
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      correlation_id: correlationId,
      evidence_digest: '',
      created_at: now(),
    });
  }

  /**
   * 入参校验共享内核：role/subject 合法性 + 项目存在性 + membership rank
   * （§13.2 跨项目读取授权）。issueSession 与 createEnrollment 同口径，
   * 保证“预登记的 enrollment 一定能换出会话”。
   */
  function validateSessionTarget(
    input: { subject: string; role: V2HumanRole; project_id?: string },
  ): { ok: false; error: { code: string; message: string } } | { ok: true; projectId: string } {
    if (!isHumanRole(input.role)) {
      return { ok: false, error: { code: 'INVALID_ROLE', message: `角色非法：${String(input.role)}` } };
    }
    if (!input.subject || input.subject.length > ID_MAX_LENGTH) {
      return { ok: false, error: { code: 'INVALID_SUBJECT', message: 'subject 必须是 1~128 字符' } };
    }
    const projectId = input.role === 'owner' ? '' : (input.project_id ?? '');
    if (input.role !== 'owner') {
      if (!projectId) return { ok: false, error: { code: 'PROJECT_REQUIRED', message: '非 owner 角色的会话必须绑定 project_id' } };
      if (!store.getProject(projectId)) return { ok: false, error: { code: 'NOT_FOUND', message: `项目 ${projectId} 不存在` } };
      const membershipRole = store.getActiveMembershipRole(projectId, input.subject);
      if (!membershipRole || HUMAN_ROLE_RANK[membershipRole] < HUMAN_ROLE_RANK[input.role]) {
        return {
          ok: false,
          error: {
            code: 'MEMBERSHIP_REQUIRED',
            message: `主体 ${input.subject} 在项目 ${projectId} 缺少 rank ≥ ${input.role} 的活跃 membership`,
          },
        };
      }
    }
    return { ok: true, projectId };
  }

  /**
   * 签发内核（issueSession 与 consumeEnrollment 共用）：校验 → 签发 bvh2 →
   * human_sessions 落库 → 审计。TTL 边界由调用方给定（管理面 ≤24h、Web 控制台 30 天）。
   */
  function issueSessionWithin(
    input: { subject: string; role: V2HumanRole; project_id?: string },
    ttlSeconds: number,
    maxTtlSeconds: number,
    meta: { actor_id: string; correlation_id: string },
  ): ApiResponse<{
    session_id: string;
    token: string;
    role: V2HumanRole;
    subject: string;
    project_id: string;
    expires_at: number;
  }> {
    const target = validateSessionTarget(input);
    if (!target.ok) return fail(target.error.code, target.error.message);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxTtlSeconds) {
      return fail('INVALID_TTL', `ttl_seconds 必须是 1~${maxTtlSeconds} 的整数`);
    }
    const ts = now();
    const sessionId = `bhs-${randomBytes(10).toString('hex')}`;
    const jti = randomBytes(8).toString('hex');
    const keys = options.keyring();
    let token: string;
    try {
      token = issueHumanSessionToken(
        { subject: input.subject, role: input.role, projectId: target.projectId, sessionId },
        { keys, now: ts, ttlSeconds, jti },
      );
    } catch (error) {
      return fail('ISSUE_FAILED', (error as Error).message);
    }
    const row: HumanSessionRow = {
      session_id: sessionId,
      subject: input.subject,
      role: input.role,
      project_id: target.projectId,
      token_jti: jti,
      key_version: keys[keys.length - 1]?.key_version ?? 0,
      status: 'active',
      issued_at: ts,
      expires_at: ts + ttlSeconds * 1000,
      revoked_at: null,
      revoked_by: '',
      revoke_reason: '',
    };
    store.insertHumanSession(row);
    audit('human.session.issued', meta.actor_id, 'human_session', sessionId, meta.correlation_id, target.projectId || null);
    return ok({
      session_id: sessionId,
      token,
      role: input.role,
      subject: input.subject,
      project_id: target.projectId,
      expires_at: row.expires_at,
    });
  }

  return {
    /**
     * 签发人类会话：role=owner 平台级（无需 membership）；其余角色要求该主体
     * 在目标项目存在 rank ≥ 会话角色的活跃 membership（§13.2 跨项目读取授权）。
     */
    issueSession(input: IssueSessionInput, meta: { actor_id: string; correlation_id: string }): ApiResponse<{
      session_id: string;
      token: string;
      role: V2HumanRole;
      subject: string;
      project_id: string;
      expires_at: number;
    }> {
      return issueSessionWithin(
        input,
        input.ttl_seconds ?? HUMAN_SESSION_DEFAULT_TTL_SECONDS,
        HUMAN_SESSION_DEFAULT_TTL_SECONDS * 2,
        meta,
      );
    },

    /* ---------------- 方案 E：远程控制台 enrollment（bhe2） ---------------- */

    /**
     * Owner 预登记一个人类身份并生成一次性 enrollment_code：
     * - 明文 code 仅本次响应返回一次（后续不可查、不落库）；
     * - 落库只存 sha256（code_hash 唯一索引），时效默认 24h（上限 7 天）；
     * - 与 issueSession 同口径预校验（项目存在 + membership rank ≥ role），
     *   保证登记成功的 code 之后一定 能换出会话（membership 仍活跃时）。
     */
    createEnrollment(
      input: { subject: string; role: V2HumanRole; project_id?: string; expires_in_hours?: number },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<{
      enrollment_id: string;
      enrollment_code: string;
      subject: string;
      role: V2HumanRole;
      project_id: string;
      expires_at: number;
    }> {
      const target = validateSessionTarget(input);
      if (!target.ok) return fail(target.error.code, target.error.message);
      const hours = input.expires_in_hours ?? HUMAN_ENROLLMENT_DEFAULT_TTL_HOURS;
      if (!Number.isInteger(hours) || hours < 1 || hours > HUMAN_ENROLLMENT_MAX_TTL_HOURS) {
        return fail('INVALID_TTL', `expires_in_hours 必须是 1~${HUMAN_ENROLLMENT_MAX_TTL_HOURS} 的整数`);
      }
      const ts = now();
      const code = `${HUMAN_ENROLLMENT_CODE_PREFIX}${randomBytes(32).toString('hex')}`;
      const row: HumanEnrollmentRow = {
        enrollment_id: `bhe-${randomBytes(10).toString('hex')}`,
        code_hash: createHash('sha256').update(code, 'utf8').digest('hex'),
        subject: input.subject,
        role: input.role,
        project_id: target.projectId,
        created_by: meta.actor_id,
        created_at: ts,
        expires_at: ts + hours * 60 * 60 * 1000,
        used_at: null,
        used_by_ip: '',
      };
      store.insertHumanEnrollment(row);
      audit('human.enrollment.created', meta.actor_id, 'human_enrollment', row.enrollment_id, meta.correlation_id, target.projectId || null);
      return ok({
        enrollment_id: row.enrollment_id,
        enrollment_code: code,
        subject: input.subject,
        role: input.role,
        project_id: target.projectId,
        expires_at: row.expires_at,
      });
    },

    /**
     * 消费 enrollment_code 换取 Web 控制台 bvh2 会话（30 天）：
     * - hash 查找 → 未用过且未过期 → 原子置 used_at（changes=0 即并发已消费，
     *   409 ENROLLMENT_ALREADY_USED，不可重放）；
     * - 一次性语义优先：先烧码再签发——即使会话签发失败（membership 已撤销/
     *   密钥环为空），该 code 也不可再次尝试，杜绝用失败反馈反复探测。
     */
    consumeEnrollment(
      code: string,
      meta: { used_by_ip: string; correlation_id: string },
    ): ApiResponse<{
      session_id: string;
      token: string;
      role: V2HumanRole;
      subject: string;
      project_id: string;
      expires_at: number;
    }> {
      if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
        return fail('ENROLLMENT_NOT_FOUND', '登录码无效');
      }
      const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
      const row = store.getHumanEnrollmentByCodeHash(codeHash);
      if (!row) return fail('ENROLLMENT_NOT_FOUND', '登录码无效');
      if (row.used_at !== null) return fail('ENROLLMENT_ALREADY_USED', '登录码已被使用，不可重放');
      const ts = now();
      if (ts >= row.expires_at) return fail('ENROLLMENT_EXPIRED', '登录码已过期');
      if (!store.markHumanEnrollmentUsed(row.enrollment_id, ts, meta.used_by_ip)) {
        return fail('ENROLLMENT_ALREADY_USED', '登录码已被使用，不可重放');
      }
      const issued = issueSessionWithin(
        { subject: row.subject, role: row.role, project_id: row.project_id || undefined },
        HUMAN_WEB_SESSION_TTL_SECONDS,
        HUMAN_WEB_SESSION_TTL_SECONDS,
        { actor_id: row.subject, correlation_id: meta.correlation_id },
      );
      if (issued.ok) {
        audit('human.enrollment.consumed', row.subject, 'human_enrollment', row.enrollment_id, meta.correlation_id, row.project_id || null);
      }
      return issued;
    },

    /** 吊销会话（幂等；revoke 即失效，R1C-013）。 */
    revokeSession(
      sessionId: string,
      input: { reason: string },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<{ session_id: string; status: string }> {
      const row = store.getHumanSession(sessionId);
      if (!row) return fail('NOT_FOUND', `会话 ${sessionId} 不存在`);
      if (row.status === 'revoked') {
        return ok({ session_id: sessionId, status: 'revoked' });
      }
      const ts = now();
      store.updateHumanSession(sessionId, {
        status: 'revoked',
        revoked_at: ts,
        revoked_by: meta.actor_id,
        revoke_reason: input.reason,
      });
      audit('human.session.revoked', meta.actor_id, 'human_session', sessionId, meta.correlation_id, row.project_id || null);
      return ok({ session_id: sessionId, status: 'revoked' });
    },

    listSessions(
      filter: { subject?: string; project_id?: string; status?: string } = {},
    ): ApiResponse<{ items: HumanSessionRow[] }> {
      return ok({
        items: store.listHumanSessions({
          subject: filter.subject,
          projectId: filter.project_id,
          status: filter.status,
        }),
      });
    },

    /** 授予 membership（幂等：同 (project, subject) 重复授予提升/改写角色）。 */
    grantMembership(
      input: { project_id: string; subject: string; role: V2HumanRole },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<ProjectMembershipRow> {
      if (!isHumanRole(input.role)) return fail('INVALID_ROLE', `角色非法：${String(input.role)}`);
      if (!store.getProject(input.project_id)) return fail('NOT_FOUND', `项目 ${input.project_id} 不存在`);
      if (!input.subject || input.subject.length > ID_MAX_LENGTH) {
        return fail('INVALID_SUBJECT', 'subject 必须是 1~128 字符');
      }
      const ts = now();
      const existing = store.getProjectMembership(input.project_id, input.subject);
      let row: ProjectMembershipRow;
      if (existing) {
        row = {
          ...existing,
          role: input.role,
          status: 'active',
          updated_at: ts,
          revoked_at: null,
          revoke_reason: '',
        };
        store.updateProjectMembership(existing.membership_id, row);
      } else {
        row = {
          membership_id: `pm-${randomBytes(10).toString('hex')}`,
          project_id: input.project_id,
          subject: input.subject,
          role: input.role,
          status: 'active',
          granted_by: meta.actor_id,
          created_at: ts,
          updated_at: ts,
          revoked_at: null,
          revoke_reason: '',
        };
        store.insertProjectMembership(row);
      }
      audit('membership.granted', meta.actor_id, 'project_membership', row.membership_id, meta.correlation_id, input.project_id);
      return ok(row);
    },

    /** 撤销 membership（其派生会话随 resolve 即时失效）。 */
    revokeMembership(
      membershipId: string,
      input: { reason: string },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<{ membership_id: string; status: string }> {
      const row = store.getProjectMembershipById(membershipId);
      if (!row) return fail('NOT_FOUND', `membership ${membershipId} 不存在`);
      if (row.status === 'revoked') {
        return ok({ membership_id: membershipId, status: 'revoked' });
      }
      const ts = now();
      store.updateProjectMembership(membershipId, {
        status: 'revoked',
        updated_at: ts,
        revoked_at: ts,
        revoke_reason: input.reason,
      });
      audit('membership.revoked', meta.actor_id, 'project_membership', membershipId, meta.correlation_id, row.project_id);
      return ok({ membership_id: membershipId, status: 'revoked' });
    },

    listMemberships(
      filter: { project_id?: string; status?: string } = {},
    ): ApiResponse<{ items: ProjectMembershipRow[] }> {
      return ok({ items: store.listProjectMemberships(filter.project_id, filter.status) });
    },

    /**
     * 解析 bvh2 凭据为可信身份（RBAC 中间件每请求调用）：
     * 密码学验签 → 会话登记存在且活跃 → membership 仍活跃（非 owner）。
     * 任何一步失败立即拒绝；不回显 token 内容。
     */
    resolveCredential(token: string): HumanTokenVerifyResult & {
      session?: HumanSessionRow;
    } {
      const verified = verifyHumanSessionToken(token, { keys: options.keyring() });
      if (!verified.ok) return verified;
      const session = store.getHumanSession(verified.claims.session_id);
      if (!session) return { ok: false, reason: 'SESSION_UNKNOWN' };
      if (session.status !== 'active') return { ok: false, reason: 'SESSION_REVOKED' };
      if (session.token_jti !== verified.claims.jti) return { ok: false, reason: 'SESSION_REVOKED' };
      const membershipRole = verified.claims.role === 'owner'
        ? null
        : store.getActiveMembershipRole(verified.claims.project_id, verified.claims.subject);
      if (verified.claims.role !== 'owner') {
        if (!membershipRole || HUMAN_ROLE_RANK[membershipRole] < HUMAN_ROLE_RANK[verified.claims.role]) {
          return { ok: false, reason: 'SESSION_REVOKED' };
        }
      }
      return { ok: true, claims: verified.claims, session };
    },
  };
}

export type HumanIdentityService = ReturnType<typeof createHumanIdentityService>;

/* ------------------------------------------------------------------ */
/* 凭据生命周期服务：Node credential 轮换 + 全局紧急撤销（§21 Phase 6） */
/* ------------------------------------------------------------------ */

export interface CredentialLifecycleOptions {
  /** 运行时密钥环权威（签发走 resolve() 最高版本）。 */
  keyring: () => V2CredentialKey[];
  /** revoke-all 前滚落库（store.applyEmergencyRevocation 语义注入）。 */
  persistEmergencyRevocation: (
    newKey: { key_version: number; material_hex: string; created_at: number; created_by: string; reason: string },
    minKeyVersion: number,
    actor: { actor_id: string },
    reason: string,
  ) => void;
  /** 下一签发版本（authority.nextKeyVersion 注入）。 */
  nextKeyVersion: () => number;
  now?: () => number;
}

export function createCredentialLifecycleService(store: SqliteStore, options: CredentialLifecycleOptions) {
  const now = options.now ?? ((): number => Date.now());

  function audit(
    action: string,
    actorId: string,
    subjectType: string,
    subjectId: string,
    correlationId: string,
  ): void {
    store.insertAuditEvent({
      audit_id: `aud-${randomBytes(10).toString('hex')}`,
      project_id: null,
      actor_id: actorId,
      action,
      subject_type: subjectType,
      subject_id: subjectId,
      correlation_id: correlationId,
      evidence_digest: '',
      created_at: now(),
    });
  }

  return {
    /**
     * Node credential 轮换（老 generation 原子替换）：
     * credential_generation+1（旧 token 立即 GENERATION_MISMATCH fencing，§4.2）
     * + fence 全部旧 node session + 签发新 session（node_session_generation 单调
     * 递增）+ 新 token 返回给调用方（仅本次响应可见，不落库明文）。
     */
    rotateNodeCredential(
      nodeId: string,
      input: { reason: string },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<{
      node_id: string;
      node_credential: string;
      credential_generation: number;
      node_session_generation: number;
      session_id: string;
    }> {
      const ts = now();
      const node = store.getNode(nodeId);
      if (!node) return fail('NOT_FOUND', `节点 ${nodeId} 不存在`);
      const newGeneration = node.credential_generation + 1;
      const currentSession = store.getCurrentNodeSession(nodeId);
      const newSessionGeneration = (currentSession?.node_session_generation ?? 0) + 1;
      const sessionId = `sess-${randomBytes(6).toString('hex')}`;

      // 顺序写 + 唯一键保证幂等语义；generation 前滚先于新 session 落库，
      // 旧 token 从前滚一刻起即被 GENERATION_MISMATCH fencing（§4.2）。
      for (const session of store.listNodeSessions(nodeId, 'active')) {
        store.updateNodeSession(session.session_id, { status: 'fenced', fenced_at: ts });
      }
      store.updateNode(nodeId, {
        credential_generation: newGeneration,
        updated_at: ts,
      });
      store.insertNodeSession({
        session_id: sessionId,
        node_id: nodeId,
        node_session_generation: newSessionGeneration,
        credential_generation: newGeneration,
        status: 'active',
        started_at: ts,
        last_seen_at: ts,
        fenced_at: null,
      });

      const keys = options.keyring();
      if (keys.length === 0) return fail('ISSUE_FAILED', 'bvn2 轮换失败：V2 密钥环为空');
      const credential = issueNodeCredential(nodeId, newGeneration, { keys, now: ts });

      audit('node.credential_rotated', meta.actor_id, 'node', nodeId, meta.correlation_id);
      return ok({
        node_id: nodeId,
        node_credential: credential,
        credential_generation: newGeneration,
        node_session_generation: newSessionGeneration,
        session_id: sessionId,
      });
    },

    /**
     * 全局紧急撤销（revoke-all-sessions）：
     * 1. 生成新密钥并按 key_version 前滚（版本 = env ∪ DB 最高 + 1）；
     * 2. durable 水位 min_key_version = 新版本 → 全部旧 bvn2/bva2/bvh2 立即
     *    UNKNOWN_KEY_VERSION（复用 Phase 1 轮换机制；重启后仍生效）；
     * 3. 全部活跃 human session 吊销 + 全部活跃 node session fencing（R1C-013）。
     * 新签发（re-enroll / claim / bvh2）继续走新版本。
     */
    revokeAllSessions(
      input: { reason: string },
      meta: { actor_id: string; correlation_id: string },
    ): ApiResponse<{
      new_key_version: number;
      min_key_version: number;
      revoked_human_sessions: number;
      fenced_node_sessions: number;
    }> {
      const ts = now();
      const newKeyVersion = Math.max(options.nextKeyVersion(), store.getCredentialState().min_key_version + 1);
      const materialHex = generateCredentialKeyHex();
      const before = {
        human: store.listHumanSessions({ status: 'active' }).length,
        node: store.listNodeSessions(undefined, 'active').length,
      };
      options.persistEmergencyRevocation(
        { key_version: newKeyVersion, material_hex: materialHex, created_at: ts, created_by: meta.actor_id, reason: input.reason },
        newKeyVersion,
        { actor_id: meta.actor_id },
        input.reason,
      );
      audit('security.revoke_all_sessions', meta.actor_id, 'credential_keyring', `key_version:${newKeyVersion}`, meta.correlation_id);
      return ok({
        new_key_version: newKeyVersion,
        min_key_version: newKeyVersion,
        revoked_human_sessions: before.human,
        fenced_node_sessions: before.node,
      });
    },
  };
}

export type CredentialLifecycleService = ReturnType<typeof createCredentialLifecycleService>;


/* ============ 用户名+密码账户（方案 E 增补） ============ */

import { scrypt as _scrypt } from 'node:crypto';
const scrypt = _scrypt;

const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 16384; // N=2^14，~50ms

export interface HumanAccountRow {
  username: string;
  password_hash: string;
  password_salt: string;
  role: string;
  project_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

function hashPassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }, (err, key) => err ? reject(err) : resolve(key));
  });
}

export async function createHumanAccount(
  store: { insertHumanAccount(row: HumanAccountRow): void; getHumanAccount(username: string): HumanAccountRow | undefined },
  input: { username: string; password: string; role: string; project_id?: string },
): Promise<ApiResponse<HumanAccountRow>> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(input.username)) {
    return { ok: false, data: null, error: { code: 'INVALID_USERNAME', message: '用户名 3~32 字符，仅字母/数字/点/下划线/连字符' } };
  }
  if (input.password.length < 8) {
    return { ok: false, data: null, error: { code: 'PASSWORD_TOO_SHORT', message: '密码至少 8 个字符' } };
  }
  if (store.getHumanAccount(input.username)) {
    return { ok: false, data: null, error: { code: 'ACCOUNT_EXISTS', message: '用户名已被使用' } };
  }
  const salt = randomBytes(16).toString('hex');
  const hash = (await hashPassword(input.password, salt)).toString('hex');
  const now = Date.now();
  const row: HumanAccountRow = {
    username: input.username, password_hash: hash, password_salt: salt,
    role: input.role, project_id: input.project_id ?? '', status: 'active',
    created_at: now, updated_at: now, last_login_at: null,
  };
  store.insertHumanAccount(row);
  const { password_hash, password_salt, ...public_ } = row;
  return { ok: true, data: row };
}

export async function verifyHumanAccount(
  store: { getHumanAccount(username: string): HumanAccountRow | undefined; updateHumanAccountLogin(username: string, at: number): void },
  username: string,
  password: string,
): Promise<ApiResponse<HumanAccountRow>> {
  const row = store.getHumanAccount(username);
  if (!row) return { ok: false, data: null, error: { code: 'ACCOUNT_NOT_FOUND', message: '用户名或密码错误' } };
  if (row.status !== 'active') return { ok: false, data: null, error: { code: 'ACCOUNT_DISABLED', message: '账户已被禁用' } };
  const hash = await hashPassword(password, row.password_salt);
  const expected = Buffer.from(row.password_hash, 'hex');
  if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) {
    return { ok: false, data: null, error: { code: 'ACCOUNT_NOT_FOUND', message: '用户名或密码错误' } };
  }
  store.updateHumanAccountLogin(username, Date.now());
  return { ok: true, data: row };
}
