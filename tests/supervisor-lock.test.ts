/**
 * 本机 Supervisor 锁自证测试（assertLocalLockStillMine）
 * 覆盖：
 *  - 锁文件丢失（tmpdir 清理场景）→ 原子重建后仍归自己
 *  - 内容仍是自己 → true
 *  - 被另一个存活实例接管 → false（调用方必须退出）
 *  - 持有者已死 → 重建归自己
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireLocalLock, assertLocalLockStillMine } from '../src/worker/supervisor.js';

const URL_A = 'http://127.0.0.1:7331';

describe('supervisor 本机锁自证', () => {
  it('锁文件丢失时原子重建并保持持有', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-lock-vanish-'));
    try {
      const handle = tryAcquireLocalLock(URL_A, dir);
      expect(handle.acquired).toBe(true);
      // 模拟 tmpdir 清理：删除锁文件后自证应重建
      rmSync(handle.path);
      expect(assertLocalLockStillMine(handle)).toBe(true);
      expect(readFileSync(handle.path, 'utf8').trim()).toBe(handle.owner);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('内容仍是自己时返回 true（无动作）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-lock-mine-'));
    try {
      const handle = tryAcquireLocalLock(URL_A, dir);
      expect(handle.acquired).toBe(true);
      expect(assertLocalLockStillMine(handle)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('被另一个存活实例接管时返回 false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-lock-takeover-'));
    try {
      const handle = tryAcquireLocalLock(URL_A, dir);
      expect(handle.acquired).toBe(true);
      // 模拟接管者：写入一个存活的其它 pid（当前进程 pid 一定存活但不是自己）
      // 用 process.ppid（测试期间必活、可发信号且非自身）模拟接管者。
      writeFileSync(handle.path, `${process.ppid}:other-host:${URL_A}:1:x\n`);
      expect(assertLocalLockStillMine(handle)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('持有者已死时重建归自己', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-lock-dead-'));
    try {
      const handle = tryAcquireLocalLock(URL_A, dir);
      expect(handle.acquired).toBe(true);
      // 模拟死 pid 占据（如崩溃残留）：写入一个几乎不可能存活的巨大 pid
      writeFileSync(handle.path, '999999999:dead-host:x:1:x\n');
      expect(assertLocalLockStillMine(handle)).toBe(true);
      expect(readFileSync(handle.path, 'utf8').trim()).toBe(handle.owner);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
