import { useState } from 'react';
import { endLocalOwnerSession } from '../api';
import { useI18n } from '../i18n/I18nContext';

export function LocalOwnerAccessGate({
  available,
  error,
  onEntered,
}: {
  available: boolean;
  error: string | null;
  onEntered: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const enter = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await onEntered();
    } catch (entryError) {
      setActionError(entryError instanceof Error ? entryError.message : String(entryError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="local-owner-gate" aria-live="polite">
      <p className="eyebrow">{t('localOwnerSession.entryEyebrow')}</p>
      <h2>{available ? t('localOwnerSession.entryTitle') : t('localOwnerSession.entryUnavailableTitle')}</h2>
      <p>{available ? t('localOwnerSession.entryDescription') : t('localOwnerSession.entryUnavailableDescription')}</p>
      {available && (
        <button type="button" className="btn primary" disabled={busy} onClick={() => void enter()}>
          {busy ? t('localOwnerSession.entering') : t('localOwnerSession.entryAction')}
        </button>
      )}
      <small>{t('localOwnerSession.entryPrivacy')}</small>
      {(error || actionError) && <p className="inline-error">{t('localOwnerSession.entryError')}{actionError ?? error}</p>}
    </main>
  );
}

export function LocalOwnerSessionControl({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await endLocalOwnerSession();
      onSignedOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="local-owner-control">
      <summary>
        {t('localOwnerSession.title')}
        <span className="token-state configured">{t('localOwnerSession.connected')}</span>
      </summary>
      <div className="local-owner-control-panel">
        <p>{t('localOwnerSession.controlHint')}</p>
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => void signOut()}>
          {t('localOwnerSession.signOut')}
        </button>
      </div>
    </details>
  );
}
