import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runMigrations, type RunMigrationsOptions } from './migrate.js';

export interface MigrateDatabaseCopyOptions {
  sourcePath: string;
  outputPath: string;
  /** 故障注入/隔离测试使用；运维 CLI 始终使用内置迁移注册表。 */
  migrationOptions?: RunMigrationsOptions;
}

export interface MigrationCopyReport {
  sourcePath: string;
  outputPath: string;
  appliedVersions: string[];
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  integrityBefore: string;
  integrityAfter: string;
}

/**
 * 用 SQLite 在线 backup API 生成一致副本，只在副本上执行迁移。
 * 输出通过 integrity/count 门禁后才原子发布；任何失败都会删除临时副本。
 */
export async function migrateDatabaseCopy(
  options: MigrateDatabaseCopyOptions,
): Promise<MigrationCopyReport> {
  const sourcePath = resolve(options.sourcePath);
  const outputPath = resolve(options.outputPath);
  if (sourcePath === outputPath) throw new Error('migration rehearsal output must differ from source');
  if (existsSync(outputPath)) throw new Error(`migration rehearsal output already exists: ${outputPath}`);

  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const stagingPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let source: Database.Database | undefined;
  let copy: Database.Database | undefined;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const integrityBefore = integrityCheck(source);
    if (integrityBefore !== 'ok') {
      throw new Error(`source integrity_check failed: ${integrityBefore}`);
    }
    const countsBefore = applicationRowCounts(source);
    await source.backup(stagingPath);
    source.close();
    source = undefined;

    chmodSync(stagingPath, 0o600);
    copy = new Database(stagingPath);
    const appliedVersions = runMigrations(copy, options.migrationOptions);
    const integrityAfter = integrityCheck(copy);
    if (integrityAfter !== 'ok') {
      throw new Error(`migrated copy integrity_check failed: ${integrityAfter}`);
    }
    const countsAfter = applicationRowCounts(copy);
    for (const [table, count] of Object.entries(countsBefore)) {
      if (countsAfter[table] !== count) {
        throw new Error(
          `row count changed during baseline rehearsal: ${table} ${count} -> ${countsAfter[table] ?? 'missing'}`,
        );
      }
    }
    copy.close();
    copy = undefined;
    renameSync(stagingPath, outputPath);

    return {
      sourcePath,
      outputPath,
      appliedVersions,
      countsBefore,
      countsAfter,
      integrityBefore,
      integrityAfter,
    };
  } catch (error) {
    if (copy?.open) copy.close();
    if (source?.open) source.close();
    rmSync(stagingPath, { force: true });
    throw error;
  }
}

function integrityCheck(db: Database.Database): string {
  const rows = db.pragma('integrity_check') as Array<Record<string, string>>;
  return rows.map((row) => Object.values(row).join(':')).join('\n');
}

function applicationRowCounts(db: Database.Database): Record<string, number> {
  const tables = (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name <> 'schema_migrations'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
  return Object.fromEntries(tables.map((table) => {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get() as { count: number };
    return [table, row.count];
  }));
}
