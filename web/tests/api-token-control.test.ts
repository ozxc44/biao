import { describe, expect, it } from 'vitest';
import {
  getApiTokenMessage,
  type ApiTokenMessageKey,
} from '../src/components/ApiTokenControl';
import { createTranslator } from '../src/i18n/translations';

describe('ApiTokenControl message localization', () => {
  const zh = createTranslator('zh-CN');
  const en = createTranslator('en-US');

  it.each<[ApiTokenMessageKey, string, string]>([
    [
      'apiTokenControl.messageEmpty',
      '请输入 Token，或使用“清除”移除现有凭证。',
      'Please enter a token, or use "Clear" to remove the existing credential.',
    ],
    [
      'apiTokenControl.messageSaved',
      '已仅保存到当前浏览器会话。',
      'Saved only to the current browser session.',
    ],
    [
      'apiTokenControl.messageCleared',
      '会话 Token 已清除。',
      'Session token cleared.',
    ],
  ])('renders the current locale for an existing %s state', (messageKey, chinese, english) => {
    expect(getApiTokenMessage(messageKey, zh)).toBe(chinese);
    expect(getApiTokenMessage(messageKey, en)).toBe(english);
  });

  it('renders no message before an action has set a message state', () => {
    expect(getApiTokenMessage(null, zh)).toBeNull();
    expect(getApiTokenMessage(null, en)).toBeNull();
  });
});
