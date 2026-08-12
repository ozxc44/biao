import { useState, type FormEvent } from 'react';
import { getApiToken, setApiToken } from '../api';
import { useI18n } from '../i18n/I18nContext';
import type { TFunction } from '../i18n/translations';

export type ApiTokenMessageKey =
  | 'apiTokenControl.messageEmpty'
  | 'apiTokenControl.messageSaved'
  | 'apiTokenControl.messageCleared';

export function getApiTokenMessage(messageKey: ApiTokenMessageKey | null, t: TFunction): string | null {
  return messageKey ? t(messageKey) : null;
}

export function ApiTokenControl({ onChanged }: { onChanged: () => void }) {
  const { t } = useI18n();
  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(() => Boolean(getApiToken()));
  const [messageKey, setMessageKey] = useState<ApiTokenMessageKey | null>(null);
  const message = getApiTokenMessage(messageKey, t);

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    const next = token.trim();
    if (!next) {
      setMessageKey('apiTokenControl.messageEmpty');
      return;
    }
    setApiToken(next);
    setToken('');
    setConfigured(true);
    setMessageKey('apiTokenControl.messageSaved');
    onChanged();
  };

  const handleClear = () => {
    setApiToken('');
    setToken('');
    setConfigured(false);
    setMessageKey('apiTokenControl.messageCleared');
    onChanged();
  };

  return (
    <details className="token-control">
      <summary>
        {t('apiTokenControl.title')}
        <span className={`token-state ${configured ? 'configured' : ''}`}>
          {configured ? t('apiTokenControl.configured') : t('apiTokenControl.unconfigured')}
        </span>
      </summary>
      <form onSubmit={handleSave}>
        <label htmlFor="api-token">{t('apiTokenControl.inputHint')}</label>
        <input
          id="api-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={configured ? t('apiTokenControl.placeholderConfigured') : t('apiTokenControl.placeholderEmpty')}
        />
        {message && <p className="field-message" aria-live="polite">{message}</p>}
        <div className="button-row">
          <button type="submit" className="btn primary small">{t('common.save')}</button>
          {configured && (
            <button type="button" className="btn secondary small" onClick={handleClear}>{t('common.clear')}</button>
          )}
        </div>
      </form>
    </details>
  );
}
