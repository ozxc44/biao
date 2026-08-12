import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToEvents, type BiaoEvent } from '../src/api';

interface VisibilityHarness {
  setVisibility(state: DocumentVisibilityState): void;
  dispatch(): void;
  listenerCount(): number;
}

function installBrowserGlobals(token: string): VisibilityHarness {
  let visibilityState: DocumentVisibilityState = 'visible';
  const listeners = new Set<EventListener>();

  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: vi.fn(() => token || null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'visibilitychange') listeners.delete(listener);
    }),
  });

  return {
    setVisibility(state) {
      visibilityState = state;
    },
    dispatch() {
      for (const listener of listeners) listener(new Event('visibilitychange'));
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('subscribeToEvents', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses an authenticated fetch SSE stream and parses events split across chunks', async () => {
    const visibility = installBrowserGlobals('top-secret');
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const eventSource = vi.fn();
    vi.stubGlobal('EventSource', eventSource);
    const onUpdate = vi.fn<(event: BiaoEvent) => void>();

    const unsubscribe = subscribeToEvents(onUpdate);
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/events/stream');
    expect(String(url)).not.toContain('top-secret');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer top-secret');
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
    expect(eventSource).not.toHaveBeenCalled();

    streamController?.enqueue(encoder.encode(': keep-alive\r\ndata: {"type":"task_'));
    streamController?.enqueue(encoder.encode('completed","task_id":"t1","agent_id":"a1","ts":42}\r\n\r\n'));
    await flushAsyncWork();

    expect(onUpdate).toHaveBeenCalledWith({
      type: 'task_completed',
      task_id: 't1',
      agent_id: 'a1',
      ts: 42,
    });

    const signal = init?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unsubscribe();
    expect(signal.aborted).toBe(true);
    expect(visibility.listenerCount()).toBe(0);
  });

  it('reconnects failed authenticated streams with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    installBrowserGlobals('top-secret');
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();

    const unsubscribe = subscribeToEvents(vi.fn(), onError);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aborts the authenticated stream while hidden and resumes once visible', async () => {
    vi.useFakeTimers();
    const visibility = installBrowserGlobals('top-secret');
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);

    const unsubscribe = subscribeToEvents(vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);

    visibility.setVisibility('hidden');
    visibility.dispatch();
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility.setVisibility('visible');
    visibility.dispatch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);

    unsubscribe();
    expect(signals[1].aborted).toBe(true);
    expect(visibility.listenerCount()).toBe(0);
  });

  it('keeps the unauthenticated path on EventSource and closes it on cleanup', () => {
    const visibility = installBrowserGlobals('');
    const instances: Array<{ close: ReturnType<typeof vi.fn>; onmessage: ((event: MessageEvent) => void) | null }> = [];
    class FakeEventSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        instances.push(this);
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const onUpdate = vi.fn<(event: BiaoEvent) => void>();

    const unsubscribe = subscribeToEvents(onUpdate);
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe('/events/stream');
    expect(fetchMock).not.toHaveBeenCalled();

    instances[0].onmessage?.(new MessageEvent('message', {
      data: '{"type":"task_claimed","task_id":"t2","agent_id":"a2","ts":7}',
    }));
    expect(onUpdate).toHaveBeenCalledWith({
      type: 'task_claimed',
      task_id: 't2',
      agent_id: 'a2',
      ts: 7,
    });

    unsubscribe();
    expect(instances[0].close).toHaveBeenCalledTimes(1);
    expect(visibility.listenerCount()).toBe(0);
  });
});
