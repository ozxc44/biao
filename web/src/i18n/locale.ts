import { DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, type Locale } from './translations';

export function isValidLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value as Locale);
}

export function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const raw = window.sessionStorage.getItem(LOCALE_STORAGE_KEY);
    return isValidLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // sessionStorage 不可用时静默降级，避免扩大语言偏好的持久化边界。
  }
}

export function syncDocumentLang(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
}
