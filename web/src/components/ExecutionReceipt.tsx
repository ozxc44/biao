export type ExecutionWakeMode =
  | 'visible_session'
  | 'background_executor'
  | 'external_worker';

export type ExecutionReceiptStatus = 'requested' | 'succeeded' | 'failed';

export interface ExecutionReceiptDto {
  attempt_id: string;
  harness_kind: string;
  adapter_id: string | null;
  wake_mode: ExecutionWakeMode;
  status: ExecutionReceiptStatus;
  session_ref?: string;
  visible_url?: string;
}

export interface ExecutionReceiptProps {
  receipt: ExecutionReceiptDto;
}

const WAKE_MODE_LABELS: Record<ExecutionWakeMode, string> = {
  visible_session: '可见会话',
  background_executor: '后台执行器',
  external_worker: '外部 Worker',
};

const CREDENTIAL_MARKERS = [
  'authorization',
  'bearer',
  'biao_api_token',
  'cookie',
  'access_token',
  'api_token',
  'password',
  'secret',
];

function containsCredentialMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  return CREDENTIAL_MARKERS.some((marker) => normalized.includes(marker));
}

export function getSafeVisibleUrl(value: string | undefined): string | null {
  if (!value || value !== value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  if (value.startsWith('//')) return null;
  if (containsCredentialMarker(value)) return null;

  try {
    if (value.startsWith('/')) {
      const relative = new URL(value, 'https://biao.invalid');
      if (relative.origin !== 'https://biao.invalid' || relative.search || relative.hash) return null;
      return relative.pathname;
    }

    const absolute = new URL(value);
    if (!['http:', 'https:'].includes(absolute.protocol)) return null;
    if (absolute.username || absolute.password || absolute.search || absolute.hash) return null;
    return absolute.toString();
  } catch {
    return null;
  }
}

function getSafeSessionRef(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.length > 256) return null;
  if (!/^[a-z0-9][a-z0-9._:/-]*$/iu.test(value)) return null;
  if (containsCredentialMarker(value)) return null;
  return value;
}

export function ExecutionReceipt({ receipt }: ExecutionReceiptProps) {
  const succeeded = receipt.status === 'succeeded';
  const failed = receipt.status === 'failed';
  const normalizedStatus: ExecutionReceiptStatus = failed
    ? 'failed'
    : succeeded
      ? 'succeeded'
      : 'requested';
  const statusLabel = failed
    ? '唤醒失败'
    : succeeded
      ? receipt.wake_mode === 'background_executor'
        ? '后台执行已启动'
        : '已唤醒自带 harness'
      : '已发 wake 请求';
  const safeVisibleUrl = succeeded ? getSafeVisibleUrl(receipt.visible_url) : null;
  const safeSessionRef = succeeded ? getSafeSessionRef(receipt.session_ref) : null;

  return (
    <article className="execution-receipt" aria-label={`执行回执 ${receipt.attempt_id}`}>
      <header>
        <h3>执行回执</h3>
        <span className={`execution-receipt-status execution-receipt-status-${normalizedStatus}`}>
          {statusLabel}
        </span>
      </header>
      <dl>
        <ReceiptField label="Attempt ID" value={receipt.attempt_id} />
        <ReceiptField label="Harness" value={receipt.harness_kind} />
        <ReceiptField label="Adapter ID" value={receipt.adapter_id ?? '未提供'} />
        <ReceiptField label="执行模式" value={WAKE_MODE_LABELS[receipt.wake_mode] ?? '不可用'} />
        <ReceiptField label="回执状态" value={statusLabel} />
        {safeSessionRef && (
          <ReceiptField label="会话引用" value={safeSessionRef} />
        )}
      </dl>
      {safeVisibleUrl && (
        <a href={safeVisibleUrl} target="_blank" rel="noreferrer noopener">
          打开会话
        </a>
      )}
    </article>
  );
}

function ReceiptField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
