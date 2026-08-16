import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LOCAL_OWNER_COOKIE = 'biao_local_owner';
export const LOCAL_OWNER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const SESSION_VERSION = 'v1';

function signature(payload: string, apiToken: string): string {
  return createHmac('sha256', apiToken).update(payload).digest('base64url');
}

function equalConstantTime(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function issueLocalOwnerSession(apiToken: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1_000) + LOCAL_OWNER_SESSION_TTL_SECONDS;
  const nonce = randomBytes(24).toString('base64url');
  const payload = `${SESSION_VERSION}.${expiresAt}.${nonce}`;
  return `${payload}.${signature(payload, apiToken)}`;
}

export function isValidLocalOwnerSession(cookieValue: string | undefined, apiToken: string, now = Date.now()): boolean {
  if (!cookieValue) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 4) return false;
  const [version, rawExpiresAt, nonce, receivedSignature] = parts;
  if (version !== SESSION_VERSION || !/^\d{10,12}$/.test(rawExpiresAt) || !/^[A-Za-z0-9_-]{24,}$/.test(nonce)) return false;
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1_000)) return false;
  const payload = `${version}.${rawExpiresAt}.${nonce}`;
  return equalConstantTime(receivedSignature, signature(payload, apiToken));
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    if (key === name) return segment.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * P12 §14：BIAO_HTTPS=1 时 Cookie 加 `Secure` flag（HTTPS 反向代理终止部署）。
 * 未配置/非 HTTPS 部署返回空串，不改变现有行为。
 */
export function cookieSecureFlag(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BIAO_HTTPS;
  if (raw === undefined) return '';
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()) ? '; Secure' : '';
}

export function localOwnerSetCookie(value: string): string {
  return `${LOCAL_OWNER_COOKIE}=${value}; Path=/; Max-Age=${LOCAL_OWNER_SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${cookieSecureFlag()}`;
}

export function localOwnerClearCookie(): string {
  return `${LOCAL_OWNER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${cookieSecureFlag()}`;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' ||
    normalized === '[::1]' || normalized === '0:0:0:0:0:0:0:1';
}
