/**
 * V2 Ownership Snapshot 单测（Phase 1）
 *
 * 覆盖 snapshot 写入、校验、过期、glob 覆盖检查。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  writeOwnershipSnapshot,
  verifyOwnershipSnapshot,
  getLatestOwnershipSnapshot,
  cleanupExpiredSnapshots,
  resetOwnershipSnapshots,
} from '../../src/server/v2/ownership-v2.js';

beforeEach(() => {
  resetOwnershipSnapshots();
});

describe('writeOwnershipSnapshot', () => {
  it('写入快照并返回完整结构', () => {
    const snapshot = writeOwnershipSnapshot({
      project_id: 'proj-001',
      holder_id: 'attempt-001',
      write_globs: ['src/**/*.ts', 'tests/**/*.ts'],
    });
    expect(snapshot.snapshot_id).toBeTruthy();
    expect(snapshot.project_id).toBe('proj-001');
    expect(snapshot.holder_id).toBe('attempt-001');
    expect(snapshot.write_globs).toEqual(['src/**/*.ts', 'tests/**/*.ts']);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.expires_at).toBeGreaterThan(Date.now());
  });

  it('revision 单调递增', () => {
    const s1 = writeOwnershipSnapshot({ project_id: 'p', holder_id: 'h1', write_globs: ['*'] });
    const s2 = writeOwnershipSnapshot({ project_id: 'p', holder_id: 'h2', write_globs: ['*'] });
    expect(s2.revision).toBe(s1.revision + 1);
  });
});

describe('verifyOwnershipSnapshot', () => {
  it('有效快照 + 匹配 glob → valid', () => {
    const snapshot = writeOwnershipSnapshot({
      project_id: 'proj-001',
      holder_id: 'attempt-001',
      write_globs: ['src/**/*.ts', 'tests/**/*.ts'],
    });
    // 精确匹配 write_globs 中的模式
    const result = verifyOwnershipSnapshot(snapshot.snapshot_id, ['src/**/*.ts']);
    expect(result.valid).toBe(true);
    expect(result.snapshot).toBeTruthy();
  });

  it('不存在的快照 → SNAPSHOT_NOT_FOUND', () => {
    const result = verifyOwnershipSnapshot('nonexistent', ['*']);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SNAPSHOT_NOT_FOUND');
  });

  it('glob 未覆盖 → GLOB_NOT_COVERED', () => {
    const snapshot = writeOwnershipSnapshot({
      project_id: 'proj-001',
      holder_id: 'attempt-001',
      write_globs: ['src/**/*.ts'],
    });
    const result = verifyOwnershipSnapshot(snapshot.snapshot_id, ['docs/**/*.md']);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('GLOB_NOT_COVERED');
  });

  it('通配符 * 覆盖所有 glob', () => {
    const snapshot = writeOwnershipSnapshot({
      project_id: 'proj-001',
      holder_id: 'attempt-001',
      write_globs: ['*'],
    });
    const result = verifyOwnershipSnapshot(snapshot.snapshot_id, ['any/path.txt']);
    expect(result.valid).toBe(true);
  });

  it('过期快照 → SNAPSHOT_EXPIRED', () => {
    const snapshot = writeOwnershipSnapshot({
      project_id: 'proj-001',
      holder_id: 'attempt-001',
      write_globs: ['*'],
      ttl_ms: 0, // 立即过期
    });
    const result = verifyOwnershipSnapshot(snapshot.snapshot_id, ['*']);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SNAPSHOT_EXPIRED');
  });
});

describe('getLatestOwnershipSnapshot', () => {
  it('返回项目最新快照', () => {
    writeOwnershipSnapshot({ project_id: 'p1', holder_id: 'h1', write_globs: ['a'] });
    const latest = writeOwnershipSnapshot({ project_id: 'p1', holder_id: 'h2', write_globs: ['b'] });
    writeOwnershipSnapshot({ project_id: 'p2', holder_id: 'h3', write_globs: ['c'] });

    const result = getLatestOwnershipSnapshot('p1');
    expect(result?.snapshot_id).toBe(latest.snapshot_id);
  });

  it('无快照返回 null', () => {
    expect(getLatestOwnershipSnapshot('nonexistent')).toBeNull();
  });
});

describe('cleanupExpiredSnapshots', () => {
  it('清除过期快照', () => {
    writeOwnershipSnapshot({ project_id: 'p', holder_id: 'h1', write_globs: ['*'], ttl_ms: 0 });
    writeOwnershipSnapshot({ project_id: 'p', holder_id: 'h2', write_globs: ['*'], ttl_ms: 60_000 });
    const cleaned = cleanupExpiredSnapshots();
    expect(cleaned).toBe(1);
  });
});
