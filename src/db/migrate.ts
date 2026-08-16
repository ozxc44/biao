import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as baseline from './migrations/001_baseline.js';
import * as projectAgentBindings from './migrations/002_project_agent_bindings.js';
import * as humanAccounts from './migrations/015_human_accounts.js';
import * as v2InfraMinimal from './migrations/003_v2_infra_minimal.js';
import * as domainIdentity from './migrations/004_domain_identity.js';
import * as artifacts from './migrations/005_artifacts.js';
import * as taskAttempts from './migrations/006_task_attempts.js';
import * as gitWorkspace from './migrations/007_git_workspace.js';
import * as mergeQueue from './migrations/008_merge_queue.js';
import * as humanIdentityRbac from './migrations/009_human_identity_rbac.js';
import * as incidents from './migrations/010_incidents.js';
import * as incidentSlaRecurrence from './migrations/011_incident_sla_recurrence.js';
import * as evidenceAcceptances from './migrations/012_evidence_acceptances.js';
import * as recoveryDecisions from './migrations/013_recovery_decisions.js';
import * as humanEnrollments from './migrations/014_human_enrollments.js';

export interface Migration {
  version: string;
  checksumMaterial: string;
  up: (db: Database.Database) => void;
}

export interface RunMigrationsOptions {
  /** 仅供隔离测试和迁移工具注入；服务启动使用内置只读注册表。 */
  migrations?: readonly Migration[];
  now?: () => string;
}

export interface MigrationRecord {
  version: string;
  applied_at: string;
  checksum: string;
}

export class MigrationChecksumError extends Error {
  readonly version: string;

  constructor(version: string, expected: string, actual: string) {
    super(`migration checksum conflict for ${version}: expected ${expected}, found ${actual}`);
    this.name = 'MigrationChecksumError';
    this.version = version;
  }
}

const DEFAULT_MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: baseline.version,
    checksumMaterial: baseline.checksumMaterial,
    up: baseline.up,
  },
  {
    version: projectAgentBindings.version,
    checksumMaterial: projectAgentBindings.checksumMaterial,
    up: projectAgentBindings.up,
  },
  {
    version: v2InfraMinimal.version,
    checksumMaterial: v2InfraMinimal.checksumMaterial,
    up: v2InfraMinimal.up,
  },
  {
    version: domainIdentity.version,
    checksumMaterial: domainIdentity.checksumMaterial,
    up: domainIdentity.up,
  },
  {
    version: artifacts.version,
    checksumMaterial: artifacts.checksumMaterial,
    up: artifacts.up,
  },
  {
    version: taskAttempts.version,
    checksumMaterial: taskAttempts.checksumMaterial,
    up: taskAttempts.up,
  },
  {
    version: gitWorkspace.version,
    checksumMaterial: gitWorkspace.checksumMaterial,
    up: gitWorkspace.up,
  },
  {
    version: mergeQueue.version,
    checksumMaterial: mergeQueue.checksumMaterial,
    up: mergeQueue.up,
  },
  {
    version: humanIdentityRbac.version,
    checksumMaterial: humanIdentityRbac.checksumMaterial,
    up: humanIdentityRbac.up,
  },
  {
    version: incidents.version,
    checksumMaterial: incidents.checksumMaterial,
    up: incidents.up,
  },
  {
    version: incidentSlaRecurrence.version,
    checksumMaterial: incidentSlaRecurrence.checksumMaterial,
    up: incidentSlaRecurrence.up,
  },
  {
    version: evidenceAcceptances.version,
    checksumMaterial: evidenceAcceptances.checksumMaterial,
    up: evidenceAcceptances.up,
  },
  {
    version: recoveryDecisions.version,
    checksumMaterial: recoveryDecisions.checksumMaterial,
    up: recoveryDecisions.up,
  },
  {
    version: humanEnrollments.version,
    checksumMaterial: humanEnrollments.checksumMaterial,
    up: humanEnrollments.up,
  },
  {
    version: humanAccounts.version,
    checksumMaterial: humanAccounts.checksumMaterial,
    up: humanAccounts.up,
  },
]);

/**
 * 在同一 SQLite 事务内校验历史并应用全部待执行迁移。
 * 任一迁移抛错时，DDL、数据写入和 schema_migrations 记录一起回滚。
 */
export function runMigrations(
  db: Database.Database,
  options: RunMigrationsOptions = {},
): string[] {
  const migrations = [...(options.migrations ?? DEFAULT_MIGRATIONS)];
  validateRegistry(migrations);
  const now = options.now ?? (() => new Date().toISOString());

  const migrate = db.transaction(() => {
    ensureMigrationsTable(db);
    const records = db.prepare(
      'SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version',
    ).all() as MigrationRecord[];
    const applied = new Map(records.map((record) => [record.version, record]));

    // 先校验全部已知历史，再做任何待执行 DDL，避免冲突库发生部分前向写入。
    for (const migration of migrations) {
      const record = applied.get(migration.version);
      if (!record) continue;
      const expected = checksumFor(migration);
      if (record.checksum !== expected) {
        throw new MigrationChecksumError(migration.version, expected, record.checksum);
      }
    }

    const appliedThisRun: string[] = [];
    const insert = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(db);
      insert.run(migration.version, now(), checksumFor(migration));
      appliedThisRun.push(migration.version);
    }
    return appliedThisRun;
  });

  return migrate();
}

/** 返回数据库记录的最高版本；未知的新版本也保留，以支持兼容旧二进制只读/回退。 */
export function getCurrentVersion(db: Database.Database): string {
  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!hasTable) return '0';
  const row = db.prepare(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  ).get() as { version: string } | undefined;
  return row?.version ?? '0';
}

export function checksumFor(migration: Pick<Migration, 'version' | 'checksumMaterial'>): string {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.checksumMaterial}`, 'utf8')
    .digest('hex');
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
}

function validateRegistry(migrations: readonly Migration[]): void {
  let previous = '';
  for (const migration of migrations) {
    if (!/^\d{3,}$/.test(migration.version)) {
      throw new Error(`invalid migration version: ${migration.version}`);
    }
    if (migration.version <= previous) {
      throw new Error(`migration registry must be strictly ordered: ${previous}, ${migration.version}`);
    }
    if (!migration.checksumMaterial) {
      throw new Error(`migration ${migration.version} has empty checksum material`);
    }
    previous = migration.version;
  }
}
