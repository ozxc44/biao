import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/db/sqlite-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite local audit privacy', () => {
  it('启动时把现有数据库及 WAL/SHM 限制为仅当前用户可读写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-sqlite-mode-'));
    dirs.push(dir);
    const dbPath = join(dir, 'biao.sqlite');
    writeFileSync(dbPath, '');
    chmodSync(dbPath, 0o644);

    const store = new SqliteStore(dbPath);
    try {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(existsSync(sidecar)).toBe(true);
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
    }
  });
});
