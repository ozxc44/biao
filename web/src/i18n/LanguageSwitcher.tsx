import { useI18n } from './I18nContext';
import { LOCALE_LABELS, type Locale } from './translations';

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const next: Locale = locale === 'zh-CN' ? 'en-US' : 'zh-CN';

  return (
    <button
      type="button"
      className="btn secondary"
      onClick={() => setLocale(next)}
      aria-label={t('languageSwitcher.switchTo', { locale: LOCALE_LABELS[next] })}
      title={t('languageSwitcher.current', { locale: LOCALE_LABELS[locale] })}
    >
      {LOCALE_LABELS[locale]}
    </button>
  );
}
