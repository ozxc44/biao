import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHumanSession,
  deleteHumanSession,
  getHumanSessionStatus,
} from '../src/api';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('remote human session API（方案 E）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the human-session endpoints with same-origin cookies only (no bearer token in the browser)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: false, available: true, expired: false }))
      .mockResolvedValueOnce(response({
        authenticated: true, available: true, subject: 'alice', role: 'reviewer',
        project_id: 'proj-1', session_id: 'bhs-1', expires_at: 1893456000000,
        token: 'bvh2_example',
      }))
      .mockResolvedValueOnce(response({ authenticated: true, available: true, subject: 'alice', role: 'reviewer' }))
      .mockResolvedValueOnce(response({ authenticated: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHumanSessionStatus()).resolves.toMatchObject({ authenticated: false, available: true });
    await expect(createHumanSession('bhe2_abc')).resolves.toMatchObject({
      authenticated: true, subject: 'alice', role: 'reviewer',
    });
    await expect(getHumanSessionStatus()).resolves.toMatchObject({ subject: 'alice' });
    await expect(deleteHumanSession()).resolves.toMatchObject({ authenticated: false });

    expect(fetchMock.mock.calls).toEqual([
      ['/auth/human-session', { credentials: 'same-origin' }],
      ['/auth/human-session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrollment_code: 'bhe2_abc' }),
      }],
      ['/auth/human-session', { credentials: 'same-origin' }],
      ['/auth/human-session', { method: 'DELETE', credentials: 'same-origin' }],
    ]);
    // 任何请求都不携带 Authorization：Owner API token 不进入浏览器
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    }
  });

  it('surfaces stable error codes so the login page can localize them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: false, data: null, error: { code: 'ENROLLMENT_ALREADY_USED', message: '登录码已被使用，不可重放' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createHumanSession('bhe2_replay')).rejects.toThrow('ENROLLMENT_ALREADY_USED');
  });
});
