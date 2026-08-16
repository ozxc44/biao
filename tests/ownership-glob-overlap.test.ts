import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { activateOwnership, globsOverlap } from '../src/redis/ownership.js';

const REDIS_URL = process.env.OWNERSHIP_GLOB_REDIS_URL ?? 'redis://127.0.0.1:6380/15';
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
});

describe('ownership glob intersection', () => {
  it('does not infer conflicts from a shared top-level directory', () => {
    expect(globsOverlap('tests/a.test.ts', 'tests/b.test.ts')).toBe(false);
    expect(globsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
    expect(globsOverlap('tests/a.test.ts', 'tests/nested/a.test.ts')).toBe(false);
    expect(globsOverlap('tests/c.test.ts', 'tests/d.test.ts')).toBe(false);
  });

  it('still detects real wildcard intersections symmetrically', () => {
    expect(globsOverlap('tests/**', 'tests/a.test.ts')).toBe(true);
    expect(globsOverlap('tests/a*.ts', 'tests/a.test.ts')).toBe(true);
    expect(globsOverlap('tests/a.test.ts', 'tests/a*.ts')).toBe(true);
    expect(globsOverlap('src/**/index.ts', 'src/app/index.ts')).toBe(true);
    expect(globsOverlap('tests/a*.ts', 'tests/b*.ts')).toBe(false);
  });

  it('lets four workers activate distinct exact files while a real glob still has one winner', async () => {
    const exactFiles = [
      'tests/a.test.ts',
      'tests/b.test.ts',
      'tests/c.test.ts',
      'tests/d.test.ts',
    ];
    const activated = await Promise.all(exactFiles.map((file, index) => activateOwnership(
      redis,
      `worker-${index}`,
      `task-${index}`,
      5,
      [file],
      60,
      '',
      false,
    )));
    expect(activated).toEqual([true, true, true, true]);

    const globClaim = await activateOwnership(
      redis, 'glob-worker', 'glob-task', 5, ['tests/**'], 60, '', false,
    );
    expect(globClaim).toBe(false);
  });
});
