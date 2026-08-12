/**
 * 测试启动防护（bpi-03）：如果测试连的是生产 Redis（DB 0），拒绝运行
 * 防止 beforeEach 清数据误伤生产
 */
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.REDIS_URL ??= 'redis://localhost:6380/1';
const REDIS_URL = process.env.REDIS_URL;

// 检查：默认必须是 DB 1+，DB 0 是生产，禁止
const dbMatch = REDIS_URL.match(/\/(\d+)$/);
const db = dbMatch ? Number(dbMatch[1]) : 0; // 无 DB 后缀 = DB 0
if (db === 0 && !process.env.FORCE_TEST_ON_DB0) {
  console.error('\n❌ 测试拒绝运行：REDIS_URL 指向 DB 0（生产）。测试必须用 DB 1+。');
  console.error(`   当前 REDIS_URL: ${REDIS_URL}`);
  console.error('   如确需在 DB 0 测试，设 FORCE_TEST_ON_DB0=1（不推荐）。\n');
  process.exit(1);
}

// 每个 Vitest 文件使用独立临时 SQLite，不允许回落到 packages/biao/data/biao.sqlite。
const runtimeDir = mkdtempSync(join(tmpdir(), 'biao-vitest-'));
process.env.BIAO_SQLITE_PATH = join(runtimeDir, 'biao.sqlite');

// 测试 fixture 和动态 plan 只位于 package 目录或 /tmp。
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.BIAO_WORKSPACE_ROOTS ??= ['/tmp', tmpdir(), packageRoot].join(delimiter);

afterAll(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});
