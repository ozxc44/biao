import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '../src/i18n/translations';
import {
  createTranslator,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  translations,
} from '../src/i18n/translations';
import { readStoredLocale, syncDocumentLang, writeStoredLocale } from '../src/i18n/locale';
import { getGroupLabel, getStatusLabel, getStatusLabelByLocale } from '../src/i18n/status';
import {
  formatCountdownByLocale,
  formatHeartbeatByLocale,
  formatTimestamp,
} from '../src/i18n/time';

describe('translations', () => {
  it('has the same keys in both locales', () => {
    const zhKeys = Object.keys(translations['zh-CN']);
    const enKeys = Object.keys(translations['en-US']);
    expect(enKeys.sort()).toEqual(zhKeys.sort());
  });

  it('interpolates parameters', () => {
    const t = createTranslator('zh-CN');
    expect(t('planDetail.planTaskCount', { count: 5 })).toBe('5 个任务');
    expect(t('planDetail.planTaskCount', { count: 5 })).toBe('5 个任务');
  });

  it('returns different text for zh-CN and en-US', () => {
    const zh = createTranslator('zh-CN');
    const en = createTranslator('en-US');
    expect(zh('app.title')).not.toBe(en('app.title'));
    expect(en('app.title')).toBe('Biao PM Console');
  });
});

describe('locale storage', () => {
  let localStore: Record<string, string>;
  let sessionStore: Record<string, string>;
  const localStorageMock = {
    getItem: vi.fn((key: string) => localStore[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      localStore[key] = value;
    }),
  };
  const sessionStorageMock = {
    getItem: vi.fn((key: string) => sessionStore[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStore[key] = value;
    }),
  };

  beforeEach(() => {
    localStore = {};
    sessionStore = {};
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    sessionStorageMock.getItem.mockClear();
    sessionStorageMock.setItem.mockClear();
    vi.stubGlobal('window', {
      localStorage: localStorageMock,
      sessionStorage: sessionStorageMock,
    });
    vi.stubGlobal('navigator', { language: 'en-US' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to zh-CN when the tab has no explicit choice even if the browser and legacy storage prefer English', () => {
    localStore[LOCALE_STORAGE_KEY] = 'en-US';
    expect(readStoredLocale()).toBe(DEFAULT_LOCALE);
  });

  it('falls back to zh-CN for invalid stored values', () => {
    sessionStore[LOCALE_STORAGE_KEY] = 'fr-FR';
    expect(readStoredLocale()).toBe('zh-CN');
    sessionStore[LOCALE_STORAGE_KEY] = '';
    expect(readStoredLocale()).toBe('zh-CN');
  });

  it('restores en-US when previously saved', () => {
    writeStoredLocale('en-US');
    expect(readStoredLocale()).toBe('en-US');
    expect(sessionStorageMock.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, 'en-US');
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });
});

describe('syncDocumentLang', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets html lang to the locale', () => {
    const root = { lang: '' };
    vi.stubGlobal('document', { documentElement: root });
    syncDocumentLang('en-US');
    expect(root.lang).toBe('en-US');
    syncDocumentLang('zh-CN');
    expect(root.lang).toBe('zh-CN');
  });
});

describe('status labels', () => {
  const zh = createTranslator('zh-CN');
  const en = createTranslator('en-US');

  it('translates known agent and task statuses', () => {
    expect(getStatusLabel('idle', zh)).toBe('空闲');
    expect(getStatusLabel('idle', en)).toBe('Idle');
    expect(getStatusLabel('accepted', zh)).toBe('已验收');
    expect(getStatusLabel('accepted', en)).toBe('Accepted');
    expect(getStatusLabel('completed', zh)).toBe('已完成');
    expect(getStatusLabel('completed', en)).toBe('Completed');
    expect(getStatusLabel('superseded', zh)).toBe('已撤下');
  });

  it('returns the raw status for unknown values', () => {
    expect(getStatusLabel('custom_status', zh)).toBe('custom_status');
  });

  it('returns unknown label for empty status', () => {
    expect(getStatusLabel('', zh)).toBe('未知');
    expect(getStatusLabel('', en)).toBe('Unknown');
  });

  it('translates board group keys', () => {
    expect(getGroupLabel('review_pending', zh)).toBe('待验收');
    expect(getGroupLabel('review_pending', en)).toBe('Review pending');
    expect(getGroupLabel('rejected', zh)).toBe('已拒绝（审计）');
    expect(getGroupLabel('rejected', en)).toBe('Rejected (audit)');
    expect(getGroupLabel('failed', zh)).toBe('执行失败（审计）');
    expect(getGroupLabel('failed', en)).toBe('Failed (audit)');
  });

  it('translates by locale helper', () => {
    expect(getStatusLabelByLocale('running', 'zh-CN')).toBe('执行中');
    expect(getStatusLabelByLocale('running', 'en-US')).toBe('Running');
  });
});

describe('relative time', () => {
  const now = 1_000_000_000_000;

  it('formats heartbeat in both languages', () => {
    expect(formatHeartbeatByLocale(0, now, 'zh-CN')).toBe('从未心跳');
    expect(formatHeartbeatByLocale(0, now, 'en-US')).toBe('Never heartbeat');
    expect(formatHeartbeatByLocale(now - 30_000, now, 'zh-CN')).toBe('30 秒前');
    expect(formatHeartbeatByLocale(now - 30_000, now, 'en-US')).toBe('30 seconds ago');
    expect(formatHeartbeatByLocale(now - 120_000, now, 'zh-CN')).toBe('2 分钟前');
    expect(formatHeartbeatByLocale(now - 120_000, now, 'en-US')).toBe('2 minutes ago');
  });

  it('formats countdown in both languages', () => {
    expect(formatCountdownByLocale(-1, 'zh-CN')).toBe('已过期');
    expect(formatCountdownByLocale(-1, 'en-US')).toBe('Expired');
    expect(formatCountdownByLocale(45_000, 'zh-CN')).toBe('45秒');
    expect(formatCountdownByLocale(45_000, 'en-US')).toBe('45s');
    expect(formatCountdownByLocale(90_000, 'zh-CN')).toBe('1分 30秒');
    expect(formatCountdownByLocale(90_000, 'en-US')).toBe('1m 30s');
    expect(formatCountdownByLocale(3_661_000, 'zh-CN')).toBe('1小时 1分 1秒');
    expect(formatCountdownByLocale(3_661_000, 'en-US')).toBe('1h 1m 1s');
  });

  it('formats absolute timestamp according to locale', () => {
    expect(formatTimestamp(0, 'zh-CN')).toBe('暂无心跳');
    expect(formatTimestamp(0, 'en-US')).toBe('No heartbeat');
    const zh = formatTimestamp(now, 'zh-CN');
    const en = formatTimestamp(now, 'en-US');
    expect(zh).not.toBe(en);
    expect(zh).toContain('2001');
    expect(en).toContain('2001');
  });
});
