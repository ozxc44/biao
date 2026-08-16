/**
 * P12 §10：前端 SSE 实时更新 hook（useEventStream）。
 *
 * 验证：
 * 1. mount 即订阅 /events/stream（subscribeToEvents），unmount 清理；
 * 2. 收到事件 → revision 递增（视图 useEffect 依赖它自动刷新）；
 * 3. filter 过滤的事件不触发刷新；onEvent 回调只对通过过滤的事件触发；
 * 4. enabled=false 时不订阅；
 * 5. ignorePollEvents 忽略后台 fallback 轮询（type='poll'）。
 */

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  subscribeToEvents: vi.fn<(...args: unknown[]) => () => void>(() => vi.fn()),
}));

vi.mock('../src/api', () => ({
  subscribeToEvents: (...args: unknown[]) => mocks.subscribeToEvents(...args),
}));

import { ignorePollEvents, useEventStream } from '../src/hooks/useEventStream';

function Probe({
  enabled,
  filter,
  onEvent,
}: {
  enabled?: boolean;
  filter?: (event: { type: string }) => boolean;
  onEvent?: (event: { type: string }) => void;
}) {
  const revision = useEventStream({ enabled, filter, onEvent });
  // 不使用 JSX（web vitest 未配 react 插件）；用 createElement 输出可断言的 span。
  return React.createElement('span', { 'data-rev': revision }, String(revision));
}

function revisionOf(renderer: ReactTestRenderer): number {
  const json = renderer.toJSON() as { props: { 'data-rev': string } };
  return Number(json.props['data-rev']);
}

/** 让 hook 触发事件的回调。 */
function capturedCallback(): (event: { type: string }) => void {
  const calls = mocks.subscribeToEvents.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const cb = calls[calls.length - 1][0] as (event: { type: string }) => void;
  expect(typeof cb).toBe('function');
  return cb;
}

describe('useEventStream', () => {
  beforeEach(() => {
    mocks.subscribeToEvents.mockClear();
    mocks.subscribeToEvents.mockImplementation(() => vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mount 订阅、unmount 清理', () => {
    const unsubscribe = vi.fn();
    mocks.subscribeToEvents.mockImplementation(() => unsubscribe);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    expect(mocks.subscribeToEvents).toHaveBeenCalledTimes(1);
    act(() => {
      renderer.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('收到事件 → revision 递增（数据刷新信号）', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    expect(revisionOf(renderer)).toBe(0);

    const emit = capturedCallback();
    act(() => {
      emit({ type: 'task_completed' });
    });
    expect(revisionOf(renderer)).toBe(1);

    act(() => {
      emit({ type: 'review_requested' });
    });
    expect(revisionOf(renderer)).toBe(2);
  });

  it('filter 拒绝的事件不递增 revision；onEvent 只对通过过滤的事件触发', () => {
    const onEvent = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe, {
        filter: (event) => event.type === 'task_completed',
        onEvent,
      }));
    });

    const emit = capturedCallback();
    act(() => {
      emit({ type: 'poll' });
    });
    expect(revisionOf(renderer)).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();

    act(() => {
      emit({ type: 'task_completed' });
    });
    expect(revisionOf(renderer)).toBe(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'task_completed' });
  });

  it('enabled=false 不订阅', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(React.createElement(Probe, { enabled: false }));
    });
    expect(mocks.subscribeToEvents).not.toHaveBeenCalled();
  });

  it('ignorePollEvents 过滤后台 fallback 轮询，保留真实业务事件', () => {
    expect(ignorePollEvents({ type: 'poll' })).toBe(false);
    expect(ignorePollEvents({ type: 'task_completed' })).toBe(true);
    expect(ignorePollEvents({ type: 'conflict_detected' })).toBe(true);
  });
});
