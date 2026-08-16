import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ExecutionReceipt,
  getSafeVisibleUrl,
  type ExecutionReceiptProps,
} from '../src/components/ExecutionReceipt';

function render(props: ExecutionReceiptProps): string {
  return renderToStaticMarkup(createElement(ExecutionReceipt, props));
}

const baseReceipt: ExecutionReceiptProps['receipt'] = {
  attempt_id: 'attempt-42',
  harness_kind: 'codex',
  adapter_id: 'codex-visible-v1',
  wake_mode: 'visible_session',
  status: 'succeeded',
};

describe('ExecutionReceipt', () => {
  it('renders the stable receipt fields and visible-session mode', () => {
    const markup = render({ receipt: baseReceipt });

    expect(markup).toContain('attempt-42');
    expect(markup).toContain('codex');
    expect(markup).toContain('codex-visible-v1');
    expect(markup).toContain('可见会话');
    expect(markup).toContain('已唤醒自带 harness');
  });

  it('never claims a requested wake has succeeded', () => {
    const markup = render({
      receipt: {
        ...baseReceipt,
        status: 'requested',
        session_ref: 'session-should-not-be-shown',
        visible_url: 'https://sessions.example.test/session-safe',
      },
    });

    expect(markup).toContain('已发 wake 请求');
    expect(markup).not.toContain('已唤醒');
    expect(markup).not.toContain('session-should-not-be-shown');
    expect(markup).not.toContain('sessions.example.test');
  });

  it('shows failure without exposing an untrusted error payload', () => {
    const receipt = {
      ...baseReceipt,
      status: 'failed' as const,
      error: 'Bearer credential-from-adapter',
      command: 'private-command',
      target: 'private-target',
    };
    const markup = render({ receipt });

    expect(markup).toContain('唤醒失败');
    expect(markup).not.toMatch(/credential-from-adapter|private-command|private-target/);
  });

  it('labels a successful background receipt as background execution, not a visible harness wake', () => {
    const markup = render({
      receipt: {
        ...baseReceipt,
        wake_mode: 'background_executor',
        status: 'succeeded',
      },
    });

    expect(markup).toContain('后台执行器');
    expect(markup).toContain('后台执行已启动');
    expect(markup).not.toContain('已唤醒自带 harness');
  });

  it('renders a validated session reference and a safe credential-free link only after success', () => {
    const markup = render({
      receipt: {
        ...baseReceipt,
        session_ref: 'session-public-7',
        visible_url: 'https://sessions.example.test/session-public-7',
      },
    });

    expect(markup).toContain('session-public-7');
    expect(markup).toContain('href="https://sessions.example.test/session-public-7"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it('rejects unsafe, credential-bearing, and query-bearing session links', () => {
    expect(getSafeVisibleUrl('javascript:alert(1)')).toBeNull();
    expect(getSafeVisibleUrl('https://user:secret@example.test/session')).toBeNull();
    expect(getSafeVisibleUrl('https://example.test/session?token=secret')).toBeNull();
    expect(getSafeVisibleUrl('https://example.test/session#bearer-secret')).toBeNull();
    expect(getSafeVisibleUrl('https://example.test/session/BIAO_API_TOKEN/secret')).toBeNull();
    expect(getSafeVisibleUrl('//example.test/session')).toBeNull();
    expect(getSafeVisibleUrl('/sessions/session-public-7')).toBe('/sessions/session-public-7');
  });

  it('does not render a credential-shaped value as a session reference', () => {
    const markup = render({
      receipt: {
        ...baseReceipt,
        session_ref: 'Bearer secret-session-credential',
      },
    });

    expect(markup).not.toContain('secret-session-credential');
    expect(markup).not.toContain('Bearer');
  });

  it('fails closed for an unknown runtime receipt status', () => {
    const receipt = { ...baseReceipt, status: 'adapter_maybe_started' } as unknown as ExecutionReceiptProps['receipt'];
    const markup = render({ receipt });

    expect(markup).toContain('已发 wake 请求');
    expect(markup).not.toContain('已唤醒');
  });
});
