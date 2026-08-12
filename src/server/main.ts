/**
 * Biao server 入口
 * 对应 docs/biao/05-biao-service-spec.md 的 `biao serve`
 */

import Redis from 'ioredis';
import { createHttpServer } from './http.js';
import { parseWorkspaceRoots } from './security.js';
import { setSqliteStore, dbRestore, reconcileResolutionBacklog, isBiaoNamespaceEmpty } from './service.js';
import { SqliteStore } from '../db/sqlite-store.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { BiaoConfig } from '../types/index.js';

function parseArgs(argv: string[] = process.argv.slice(2)): Partial<BiaoConfig> & { planDir?: string } {
  const args = argv;
  const config: Partial<BiaoConfig> & { planDir?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') config.port = Number(args[i + 1] ?? 7331);
    if (args[i] === '--host' || args[i] === '-H') config.host = args[i + 1];
    if (args[i] === '--redis-url') config.redisUrl = args[i + 1];
  }
  return config;
}

const here = dirname(fileURLToPath(import.meta.url));
const biaoPkgDir = join(here, '..', '..');

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveServerConfig(
  overrides: Partial<BiaoConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): BiaoConfig {
  const args = parseArgs(argv);
  const apiToken = nonEmpty(overrides.apiToken) ?? nonEmpty(env.BIAO_API_TOKEN);
  const dataDir = nonEmpty(env.BIAO_DATA_DIR);
  const sqlitePath = resolve(
    overrides.sqlitePath ??
      nonEmpty(env.BIAO_SQLITE_PATH) ??
      (dataDir ? join(dataDir, 'biao.sqlite') : join(biaoPkgDir, 'data', 'biao.sqlite')),
  );

  return {
    port: Number(args.port ?? overrides.port ?? env.BIAO_PORT ?? 7331),
    host: args.host ?? overrides.host ?? env.BIAO_HOST ?? '127.0.0.1',
    redisUrl: args.redisUrl ?? overrides.redisUrl ?? env.BIAO_REDIS_URL ?? 'redis://localhost:6379',
    authEnabled: overrides.authEnabled ?? Boolean(apiToken),
    apiToken,
    workspaceRoots: (overrides.workspaceRoots ?? parseWorkspaceRoots(env.BIAO_WORKSPACE_ROOTS)).map((root) => resolve(root)),
    sqlitePath,
    streamMaxlen: overrides.streamMaxlen ?? 10_000,
    conflictRetention: overrides.conflictRetention ?? 1_000,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]' || normalized === '0:0:0:0:0:0:0:1';
}

export function assertSafeServerConfig(config: BiaoConfig): void {
  if (isLoopbackHost(config.host)) return;
  if (!config.apiToken) {
    throw new Error('非 loopback 监听必须配置 BIAO_API_TOKEN');
  }
  if (config.workspaceRoots.length === 0) {
    throw new Error('非 loopback 监听必须配置 BIAO_WORKSPACE_ROOTS');
  }
}

export async function startServer(overrides: Partial<BiaoConfig> = {}): Promise<{ app: Awaited<ReturnType<typeof createHttpServer>>; redis: Redis; close: () => Promise<void> }> {
  const config = resolveServerConfig(overrides);
  assertSafeServerConfig(config);

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  // 持久化检查：appendonly=off 时 FLUSHALL/重启会丢全部 task/plan/lease（2026-08-12 真实事故）
  // 只警告不强制改——PM 可能有意关闭（如纯测试环境）
  try {
    const cfg = await redis.config('GET', 'appendonly');
    const appendonly = Array.isArray(cfg) ? cfg[1] : undefined;
    if (appendonly !== 'yes') {
      console.warn(
        '[biao] ⚠ Redis appendonly=off，重启或 FLUSHALL 会丢失所有 task/plan/lease 数据。' +
          '建议执行：redis-cli CONFIG SET appendonly yes（恢复与部署见 README.md#安全与部署）',
      );
    }
  } catch {
    // CONFIG 命令被禁用（某些托管 Redis）→ 跳过检查
  }

  // SQLite 持久化：初始化 store + 注入 service 层 + Redis 空时自动恢复
  const store = new SqliteStore(config.sqlitePath);
  setSqliteStore(store);
  console.log(`[biao] SQLite 持久化已启用：${config.sqlitePath}（${store.getTaskCount()} 个 task 已存档）`);

  // 自动恢复：Redis 空但 SQLite 有数据 → 从 SQLite 重建 Redis
  try {
    const namespaceEmpty = await isBiaoNamespaceEmpty(redis);
    const sqliteCount = store.getTaskCount();
    if (namespaceEmpty && sqliteCount > 0) {
      console.log(`[biao] ⚠ Redis 为空但 SQLite 有 ${sqliteCount} 条数据，自动恢复...`);
      const r = await dbRestore(redis, store);
      console.log(`[biao] ✓ 恢复完成：${r.restored} 个 task`, JSON.stringify(r.byStatus));
    }
  } catch (e) {
    // 恢复失败或结果不确定时绝不能继续开放 claim/report。否则部分投影会成为 live，
    // 下次启动还会因 namespace 非空失去安全重试入口。
    setSqliteStore(null);
    store.close();
    redis.disconnect();
    throw e;
  }

  // 不论 Redis 是否刚恢复，都只在启动时做一次幂等补偿：旧版本留下的
  // failed/rejected 任务从此有 repair/PM 决策路径，不需要人手动 reset 才能继续。
  try {
    const reconciled = await reconcileResolutionBacklog(redis);
    if (reconciled.repaired_task_ids.length || reconciled.needs_pm_decision_task_ids.length) {
      console.log(
        `[biao] 自动补偿历史闭环：repair=${reconciled.repaired_task_ids.length}，` +
          `待 PM 决策=${reconciled.needs_pm_decision_task_ids.length}`,
      );
    }
  } catch (e) {
    console.warn('[biao] 历史闭环自动补偿失败：', (e as Error).message);
  }

  const app = await createHttpServer(redis, config);
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    await app.close().catch(() => undefined);
    setSqliteStore(null);
    store.close();
    redis.disconnect();
    throw error;
  }
  console.log(`[biao] server listening on http://${config.host}:${config.port}`);

  return {
    app,
    redis,
    close: async () => {
      await app.close();
      setSqliteStore(null);
      store.close();
      redis.disconnect();
    },
  };
}

// 直接运行（node dist/server/main.js）
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((e) => {
    console.error('[biao] 启动失败：', e);
    process.exit(1);
  });
}
