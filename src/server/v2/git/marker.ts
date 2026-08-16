/**
 * §6.5 signed attempt marker（R1C-005）
 *
 * marker 内容（任务 Phase 4 约定）= attempt_id + task_id + attempt_generation +
 * bva2 摘要，附 branch_ref / base_sha / head_sha / node_id / signing_key_generation /
 * created_at；canonical JSON（键排序、无空白）后 HMAC-SHA256 签名。
 *
 * 密钥来源说明：方案要求 marker 用 Node enrollment 时本地生成的非对称签名密钥
 * （§6.6），控制面按 node_id + signing_key_generation 选登记公钥验签。Phase 4
 * 在服务端测试进程内模拟 Node 侧执行，以控制面 credential keyring 的对称密钥
 * 作为 Node signing key 的替身（signing_key_generation = key_version）；
 * 换成真 Node 密钥属 daemon 接线收尾项，本模块的 payload/签名分离结构不变。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { V2CredentialKey } from '../credentials.js';
import {
  ATTEMPT_MARKER_SCHEMA_VERSION,
  type AttemptMarkerPayload,
  type SignedAttemptMarker,
} from '../../../types/v2-git.js';

/** canonical JSON：键排序 + 紧凑分隔（验签双方确定性一致）。 */
function canonicalJson(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = value[k];
    return acc;
  }, {}));
}

export function markerCanonicalJson(payload: AttemptMarkerPayload): string {
  return canonicalJson(payload as unknown as Record<string, unknown>);
}

/** bva2 Attempt token 摘要（marker 内容项；不落 token 原文）。 */
export function attemptTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 签发 signed marker。 */
export function signAttemptMarker(
  payload: Omit<AttemptMarkerPayload, 'schema_version'>,
  key: V2CredentialKey,
): SignedAttemptMarker {
  const full: AttemptMarkerPayload = {
    ...payload,
    schema_version: ATTEMPT_MARKER_SCHEMA_VERSION,
  };
  const canonical = markerCanonicalJson(full);
  return {
    payload: full,
    signature: createHmac('sha256', key.material).update(canonical, 'utf8').digest('hex'),
  };
}

export type MarkerVerifyFailure =
  | 'MALFORMED'
  | 'SCHEMA_VERSION'
  | 'SIGNATURE'
  | 'KEY_GENERATION';

export interface MarkerVerifyInput {
  /** marker ref 上读回的 blob 原文（应为 JSON 信封）。 */
  content: string;
  /** 预期绑定（与 task_attempts / attempt_workspaces 行核对）。 */
  expected: {
    attempt_id: string;
    task_id: string;
    attempt_generation: number;
    branch_ref: string;
    head_sha?: string;
    bva2_digest?: string;
  };
  /** 验签密钥（按 signing_key_generation 选择，key_version 不符 → KEY_GENERATION）。 */
  key: V2CredentialKey;
}

export type MarkerVerifyResult =
  | { ok: true; payload: AttemptMarkerPayload }
  | { ok: false; reason: MarkerVerifyFailure; message: string };

/** 验签 + 身份绑定核对（fail-closed：任何字段不符都拒绝）。 */
export function verifyAttemptMarker(input: MarkerVerifyInput): MarkerVerifyResult {
  let parsed: SignedAttemptMarker;
  try {
    parsed = JSON.parse(input.content) as SignedAttemptMarker;
  } catch {
    return { ok: false, reason: 'MALFORMED', message: 'marker 不是合法 JSON' };
  }
  if (!parsed?.payload || typeof parsed.signature !== 'string') {
    return { ok: false, reason: 'MALFORMED', message: 'marker 缺少 payload/signature' };
  }
  if (parsed.payload.schema_version !== ATTEMPT_MARKER_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'SCHEMA_VERSION',
      message: `marker schema_version ${String(parsed.payload.schema_version)} 不受支持`,
    };
  }
  if (parsed.payload.signing_key_generation !== input.key.key_version) {
    return {
      ok: false,
      reason: 'KEY_GENERATION',
      message: `marker signing_key_generation ${String(parsed.payload.signing_key_generation)} 与验签密钥 ${input.key.key_version} 不符`,
    };
  }
  const expectedSig = createHmac('sha256', input.key.material)
    .update(markerCanonicalJson(parsed.payload), 'utf8')
    .digest('hex');
  const a = Buffer.from(expectedSig, 'hex');
  const b = Buffer.from(parsed.signature, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'SIGNATURE', message: 'marker 签名不匹配' };
  }
  const { payload } = parsed;
  const { expected } = input;
  if (
    payload.attempt_id !== expected.attempt_id
    || payload.task_id !== expected.task_id
    || payload.attempt_generation !== expected.attempt_generation
    || payload.branch_ref !== expected.branch_ref
    || (expected.head_sha !== undefined && payload.head_sha !== expected.head_sha)
    || (expected.bva2_digest !== undefined && payload.bva2_digest !== expected.bva2_digest)
  ) {
    return { ok: false, reason: 'MALFORMED', message: 'marker 身份字段与 attempt 记录不符' };
  }
  return { ok: true, payload };
}
