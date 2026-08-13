import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginLocalOwnerSession,
  endLocalOwnerSession,
  fetchStatus,
  fetchHumanSession,
} from '../src/api';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('local Owner browser session API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the local-session endpoints without placing an Agent bearer token in browser storage or request headers', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: false, mode: 'local_owner', local_session_available: true }))
      .mockResolvedValueOnce(response({ authenticated: true, mode: 'local_owner', local_session_available: true }))
      .mockResolvedValueOnce(response({ authenticated: false, mode: 'local_owner', local_session_available: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchHumanSession()).resolves.toMatchObject({ authenticated: false });
    await expect(beginLocalOwnerSession()).resolves.toMatchObject({ authenticated: true });
    await expect(endLocalOwnerSession()).resolves.toMatchObject({ authenticated: false });

    expect(fetchMock.mock.calls).toEqual([
      ['/auth/session', { credentials: 'same-origin' }],
      ['/auth/local-session', { method: 'POST', credentials: 'same-origin' }],
      ['/auth/local-session', { method: 'DELETE', credentials: 'same-origin' }],
    ]);
  });

  it('never forwards a legacy browser Token when the console loads protected data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: vi.fn(() => 'legacy-agent-secret'),
        removeItem: vi.fn(),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchStatus();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/status');
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    expect(init?.credentials).toBe('same-origin');
  });
});
