/**
 * 方案 E：Web 控制台登录页（远程 enrollment code + loopback 本机会话双模式）。
 *
 * 部署模式决定可见入口：
 * - loopback（本机浏览器）：一键获得本机 Owner 会话（/auth/local-session）；
 * - 远程（NAS 等）：输入 Owner 预登记的一次性 enrollment code，换取
 *   biao_human_session HttpOnly Cookie（POST /auth/human-session）。
 * 两种模式可同时出现（本机部署也可能配置了远程登录）。
 * Owner API token 永远不进入浏览器（原则不变）。
 */
import { useState } from 'react';
import { createHumanSession, deleteHumanSession, humanLogin, type HumanWebSessionCreated } from '../api';
import { useI18n } from '../i18n/I18nContext';
import type { TFunction } from '../i18n/translations';

/** enrollment 消费失败的稳定错误码 → 本地化提示（其他错误原样展示）。 */
function loginErrorMessage(error: unknown, t: TFunction): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENROLLMENT_NOT_FOUND')) return t('humanLogin.errorInvalid');
  if (message.includes('ENROLLMENT_EXPIRED')) return t('humanLogin.errorExpired');
  if (message.includes('ENROLLMENT_ALREADY_USED')) return t('humanLogin.errorUsed');
  return message;
}

export function HumanLoginPage({
  localAvailable,
  remoteAvailable,
  error,
  sessionExpired,
  onEnteredLocal,
  onEnteredHuman,
}: {
  localAvailable: boolean;
  remoteAvailable: boolean;
  error: string | null;
  /** Cookie 曾存在但已过期/失效（提示重新申领登录码，而非首次登录）。 */
  sessionExpired: boolean;
  onEnteredLocal: () => Promise<void>;
  onEnteredHuman: (session: HumanWebSessionCreated) => void;
}) {
  const { t } = useI18n();
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordMode, setIsPasswordMode] = useState(true);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const enterLocal = async () => {
    setLocalBusy(true);
    setActionError(null);
    try {
      await onEnteredLocal();
    } catch (entryError) {
      setActionError(entryError instanceof Error ? entryError.message : String(entryError));
    } finally {
      setLocalBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setRemoteBusy(true);
    setActionError(null);
    try {
      if (isPasswordMode) {
        if (!username.trim() || !password) return;
        const session = await humanLogin(username.trim(), password);
        setPassword('');
        onEnteredHuman(session);
      } else {
        const code = enrollmentCode.trim();
        if (!code) return;
        const session = await createHumanSession(code);
        setEnrollmentCode('');
        onEnteredHuman(session);
      }
    } catch (loginError) {
      setActionError(loginErrorMessage(loginError, t));
    } finally {
      setRemoteBusy(false);
    }
  };

  if (!localAvailable && !remoteAvailable) {
    return (
      <main className="local-owner-gate" aria-live="polite">
        <p className="eyebrow">{t('humanLogin.eyebrow')}</p>
        <h2>{t('humanLogin.unavailableTitle')}</h2>
        <p>{t('humanLogin.unavailableDescription')}</p>
        <small>{t('localOwnerSession.entryPrivacy')}</small>
        {(error || actionError) && <p className="inline-error">{actionError ?? error}</p>}
      </main>
    );
  }

  return (
    <main className="local-owner-gate" aria-live="polite">
      <p className="eyebrow">{t('humanLogin.eyebrow')}</p>
      <h2>{t('humanLogin.title')}</h2>
      <p>{t('humanLogin.description')}</p>

      {localAvailable && (
        <section className="detail-section review-form">
          <h3>{t('humanLogin.localSectionTitle')}</h3>
          <p className="field-message">{t('humanLogin.localSectionDescription')}</p>
          
              {isPasswordMode && (
                <>
                  <label htmlFor="login-username">{t('humanLogin.username')}</label>
                  <input
                    id="login-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    disabled={remoteBusy}
                  />
                  <label htmlFor="login-password">{t('humanLogin.password')}</label>
                  <input
                    id="login-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={remoteBusy}
                  />
                </>
              )}
              {!isPasswordMode && (
                <label htmlFor="enrollment-code">{t('humanLogin.enrollmentCode')}</label>
              )}
              <div className="button-row">
            <button type="button" className="btn primary" disabled={localBusy} onClick={() => void enterLocal()}>
              {localBusy ? t('localOwnerSession.entering') : t('localOwnerSession.entryAction')}
            </button>
          </div>
        </section>
      )}

      {remoteAvailable && (
        <section className="detail-section review-form">
          <h3>{t('humanLogin.remoteSectionTitle')}</h3>
          <p className="field-message">{t('humanLogin.remoteSectionDescription')}</p>
          <form onSubmit={(event) => void submitCode(event)}>
            <label htmlFor="human-enrollment-code">{t('humanLogin.codeLabel')}</label>
            <input
              id="human-enrollment-code"
              name="enrollment_code"
              autoComplete="off"
              spellCheck={false}
              value={enrollmentCode}
              onChange={(event) => setEnrollmentCode(event.target.value)}
              placeholder={t('humanLogin.codePlaceholder')}
              disabled={remoteBusy}
            />
            <div className="button-row">
              <button
            type="button"
            className="btn secondary small"
            onClick={() => setIsPasswordMode(!isPasswordMode)}
          >
            {isPasswordMode ? (t('humanLogin.useCode') || '使用登录码') : (t('humanLogin.usePassword') || '使用账号密码')}
          </button>
          <button type="submit" className="btn primary" disabled={remoteBusy || !enrollmentCode.trim()}>
                {remoteBusy ? t('humanLogin.submitting') : t('humanLogin.submitAction')}
              </button>
            </div>
          </form>
        </section>
      )}

      {sessionExpired && <p className="inline-error">{t('humanLogin.sessionExpiredHint')}</p>}
      {(error || actionError) && <p className="inline-error">{t('localOwnerSession.entryError')}{actionError ?? error}</p>}
      <small>{t('humanLogin.privacy')}</small>
    </main>
  );
}

/** 顶栏远程会话控制：显示当前身份（subject + role）与登出（吊销即时生效）。 */
export function HumanSessionControl({
  subject,
  role,
  onSignedOut,
}: {
  subject: string;
  role: string;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await deleteHumanSession();
      onSignedOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="local-owner-control">
      <summary>
        {t('humanSession.title')}
        <span className="token-state configured">{t('humanSession.identity', { subject, role })}</span>
      </summary>
      <div className="local-owner-control-panel">
        <p>{t('humanSession.controlHint')}</p>
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => void signOut()}>
          {t('humanSession.signOut')}
        </button>
      </div>
    </details>
  );
}
