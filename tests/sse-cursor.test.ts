import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { resolveEventStreamCursor } from '../src/server/http.js';

describe('SSE event cursor', () => {
  it('freezes a new connection at the current last id so later events are not skipped', async () => {
    const xrevrange = vi.fn(async () => [['1786719493296-0', ['type', 'resolution_decided']]]);
    const redis = { xrevrange } as unknown as Redis;

    await expect(resolveEventStreamCursor(redis, '$')).resolves.toBe('1786719493296-0');
    expect(xrevrange).toHaveBeenCalledWith(expect.any(String), '+', '-', 'COUNT', 1);
  });

  it('starts at zero when the stream is empty and preserves an explicit resume cursor', async () => {
    const xrevrange = vi.fn(async () => []);
    const redis = { xrevrange } as unknown as Redis;

    await expect(resolveEventStreamCursor(redis, '$')).resolves.toBe('0-0');
    await expect(resolveEventStreamCursor(redis, '1786719493296-0')).resolves.toBe('1786719493296-0');
    expect(xrevrange).toHaveBeenCalledTimes(1);
  });
});
