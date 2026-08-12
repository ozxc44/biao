import type { Locale, TFunction } from './translations';
import { createTranslator } from './translations';

export function formatHeartbeat(timestamp: number, now: number, t: TFunction): string {
  if (!timestamp) return t('time.neverHeartbeat');
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return t('time.secondsAgo', { seconds });
  if (seconds < 3600) return t('time.minutesAgo', { minutes: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('time.hoursAgo', { hours: Math.floor(seconds / 3600) });
  return t('time.daysAgo', { days: Math.floor(seconds / 86400) });
}

export function formatTimestamp(timestamp: number, locale: Locale): string {
  if (!timestamp) {
    const t = createTranslator(locale);
    return t('time.noHeartbeat');
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp);
}

export function formatCountdown(ms: number, t: TFunction): string {
  if (ms <= 0) return t('planDetail.expired');
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return t('time.countdownHours', { hours, minutes, seconds });
  if (minutes > 0) return t('time.countdownMinutes', { minutes, seconds });
  return t('time.countdownSeconds', { seconds });
}

export function formatCountdownByLocale(ms: number, locale: Locale): string {
  const t = createTranslator(locale);
  return formatCountdown(ms, t);
}

export function formatHeartbeatByLocale(timestamp: number, now: number, locale: Locale): string {
  const t = createTranslator(locale);
  return formatHeartbeat(timestamp, now, t);
}
