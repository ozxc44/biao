import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { checksumFor, getCurrentVersion, runMigrations } from '../../src/db/migrate.js';
import * as baseline from '../../src/db/migrations/001_baseline.js';
import { SqliteStore } from '../../src/db/sqlite-store.js';

const temporaryDirectories: string[] = [];
const legacySchema = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');
const baselineMigration = {
  version: baseline.version,
  checksumMaterial: baseline.checksumMaterial,
  up: baseline.up,
};

function temporaryDatabase(name = 'biao.sqlite'): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'biao-p0a1-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, name) };
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function schemaSnapshot(db: Database.Database) {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
  return {
    tables: Object.fromEntries(tables.map((table) => [table, tableColumns(db, table)])),
    indexes: (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name),
    triggers: (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name),
    foreignKeys: Object.fromEntries(tables.map((table) => [
      table,
      db.pragma(`foreign_key_list(${table})`),
    ])),
  };
}

function migrationRecords(db: Database.Database): Array<{ version: string; checksum: string }> {
  return db.prepare(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  ).all() as Array<{ version: string; checksum: string }>;
}

function currentMigrationFixture() {
  const db = new Database(':memory:');
  try {
    const versions = runMigrations(db);
    const records = migrationRecords(db);
    return {
      versions,
      records,
      head: versions.at(-1) ?? '0',
      schema: schemaSnapshot(db),
    };
  } finally {
    db.close();
  }
}

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = ['agent_registrations', 'plans', 'questions', 'tasks'];
  return Object.fromEntries(tables.map((table) => [
    table,
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]));
}

function integrity(db: Database.Database): string {
  const rows = db.pragma('integrity_check') as Array<Record<string, string>>;
  return rows.map((row) => Object.values(row).join(':')).join('\n');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('001_baseline', () => {
  it('keeps the fixed V1 baseline while later migrations append through the current head', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      expect(runMigrations(db, {
        migrations: [baselineMigration],
        now: () => 'v1-applied',
      })).toEqual(['001']);
      expect(getCurrentVersion(db)).toBe('001');
      expect(tableColumns(db, 'schema_migrations')).toEqual(['version', 'applied_at', 'checksum']);
      expect(migrationRecords(db)).toEqual([{
        version: '001',
        checksum: checksumFor(baselineMigration),
      }]);
      expect(schemaSnapshot(db)).toEqual({
        tables: {
          agent_registrations: [
            'agent_id', 'registration_id', 'generation', 'registration_source', 'agent_type',
            'capabilities', 'endpoint', 'projects', 'registered_at',
          ],
          plans: [
            'plan_id', 'title', 'status', 'project_path', 'default_assignee', 'default_priority',
            'phases', 'task_count', 'created_at', 'submitted_at', 'pm_consumer',
          ],
          questions: [
            'question_id', 'task_id', 'plan_id', 'agent_id', 'pm_consumer', 'asked_event_id',
            'body', 'checkpoint', 'status', 'created_at', 'answered_at', 'answered_by', 'answer',
            'requested_ownership', 'ownership_decision', 'ownership_before', 'ownership_after',
          ],
          schema_migrations: ['version', 'applied_at', 'checksum'],
          tasks: [
            'task_id', 'plan_id', 'title', 'type', 'phase', 'status', 'priority', 'assignee',
            'ownership_files', 'ownership_modules', 'depends_on', 'timeout_seconds', 'max_retries',
            'model_override', 'acceptance_for', 'verify', 'claimed_by', 'claimed_at', 'expire_at',
            'result_path', 'result_json_path', 'done_at', 'retries', 'pm_review_status',
            'pm_reviewed_by', 'pm_reviewed_at', 'pm_review_comment', 'pm_accept_effects_applied',
            'pm_reject_reason', 'pm_fix_instructions', 'pm_rejection_resolution_mode',
            'repair_ownership_extension', 'pm_repair_ownership_required', 'pm_repair_ownership_intent',
            'failure_reason', 'fix_for', 'repair_root_task_id', 'trigger_review_task_id',
            'resolution_status', 'resolution_action', 'resolution_task_id', 'resolution_task_ids',
            'acceptance_repair_task_ids', 'resolved_by_task', 'resolution_generation',
            'resolution_attempts', 'resolution_decision_reason', 'blocked_at', 'block_reason',
            'blocked_question_id', 'blocked_lease_remaining', 'last_question_id',
            'last_question_answer', 'cancelled_at', 'cancel_reason', 'superseded_at', 'superseded_by',
            'superseded_reason', 'supersede_preview_token', 'supersede_batch_size', 'verify_results',
            'goal_md', 'created_at', 'updated_at',
          ],
        },
        indexes: [
          'idx_agent_registrations_current', 'idx_questions_status', 'idx_questions_task',
          'idx_tasks_plan', 'idx_tasks_status',
        ],
        triggers: [],
        foreignKeys: {
          agent_registrations: [],
          plans: [],
          questions: [expect.objectContaining({ from: 'task_id', table: 'tasks', to: 'task_id' })],
          schema_migrations: [],
          tasks: [expect.objectContaining({ from: 'plan_id', table: 'plans', to: 'plan_id' })],
        },
      });

      const appendedVersions = runMigrations(db);
      const currentRecords = migrationRecords(db);
      const currentVersions = currentRecords.map(({ version }) => version);
      expect(currentVersions.slice(0, 2)).toEqual(['001', '002']);
      expect(appendedVersions).toEqual(currentVersions.slice(1));
      expect(currentVersions).toEqual([...currentVersions].sort());
      expect(new Set(currentVersions).size).toBe(currentVersions.length);
      expect(currentRecords[0]).toEqual({
        version: '001',
        checksum: checksumFor(baselineMigration),
      });
      expect(currentRecords.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);
      expect(getCurrentVersion(db)).toBe(currentVersions.at(-1));
      expect(runMigrations(db)).toEqual([]);
      expect(migrationRecords(db)).toEqual(currentRecords);
      expect(integrity(db)).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('upgrades a legacy SQLite fixture without changing V1 data or integrity', () => {
    const current = currentMigrationFixture();
    const { path } = temporaryDatabase();
    const legacy = new Database(path);
    legacy.exec(legacySchema);
    legacy.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('legacy-plan', '旧计划', 'submitted', '/srv/legacy');
    legacy.prepare(
      'INSERT INTO tasks (task_id, plan_id, title, status) VALUES (?, ?, ?, ?)',
    ).run('legacy-task', 'legacy-plan', '旧任务', 'pending');
    legacy.prepare(
      'INSERT INTO questions (question_id, task_id, plan_id, agent_id, body) VALUES (?, ?, ?, ?, ?)',
    ).run('legacy-question', 'legacy-task', 'legacy-plan', 'legacy-worker', '旧问题');
    legacy.prepare(
      `INSERT INTO agent_registrations
       (agent_id, registration_id, generation, registration_source)
       VALUES (?, ?, ?, ?)`,
    ).run('legacy-worker', 'registration-1', 1, 'client');
    const countsBefore = rowCounts(legacy);
    const integrityBefore = integrity(legacy);
    legacy.close();

    const upgraded = new Database(path);
    try {
      expect(runMigrations(upgraded)).toEqual(current.versions);
      expect(migrationRecords(upgraded)).toEqual(current.records);
      expect(getCurrentVersion(upgraded)).toBe(current.head);
      expect(schemaSnapshot(upgraded)).toEqual(current.schema);
      expect(rowCounts(upgraded)).toEqual(countsBefore);
      expect(integrity(upgraded)).toBe(integrityBefore);
      expect(tableColumns(upgraded, 'plans')).toContain('pm_consumer');
      expect(upgraded.prepare('SELECT title FROM plans WHERE plan_id = ?').get('legacy-plan'))
        .toEqual({ title: '旧计划' });
    } finally {
      upgraded.close();
    }
  });

  it('produces the same schema for a legacy upgrade and a fresh initialization', () => {
    const freshPath = temporaryDatabase('fresh.sqlite').path;
    const legacyPath = temporaryDatabase('legacy.sqlite').path;
    const fresh = new Database(freshPath);
    const legacy = new Database(legacyPath);
    try {
      legacy.exec(legacySchema);
      const freshVersions = runMigrations(fresh);
      const legacyVersions = runMigrations(legacy);
      expect(legacyVersions).toEqual(freshVersions);
      expect(migrationRecords(legacy)).toEqual(migrationRecords(fresh));
      expect(getCurrentVersion(legacy)).toBe(getCurrentVersion(fresh));
      expect(schemaSnapshot(legacy)).toEqual(schemaSnapshot(fresh));
    } finally {
      fresh.close();
      legacy.close();
    }
  });

  it('is idempotent when the runner and SqliteStore startup repeat', () => {
    const current = currentMigrationFixture();
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      expect(runMigrations(db)).toEqual(current.versions);
      expect(runMigrations(db)).toEqual([]);
      expect(runMigrations(db)).toEqual([]);
      expect(migrationRecords(db)).toEqual(current.records);
    } finally {
      db.close();
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = new SqliteStore(path);
      expect(store.getSchemaVersion()).toBe(current.head);
      store.close();
    }
  });
});

describe('forward-only migration runner safety', () => {
  it('rejects a checksum conflict before changing the database', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      runMigrations(db);
      const before = createHash('sha256').update(db.serialize()).digest('hex');
      db.prepare("UPDATE schema_migrations SET checksum = 'changed-on-disk' WHERE version = '001'").run();
      const afterTamper = createHash('sha256').update(db.serialize()).digest('hex');
      expect(afterTamper).not.toBe(before);

      expect(() => runMigrations(db)).toThrow(/checksum.*001|001.*checksum/i);
      expect(db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get('001'))
        .toEqual({ checksum: 'changed-on-disk' });
      expect(integrity(db)).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rolls back an interrupted migration and can recover on the next run', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    const interrupted = {
      version: '900',
      checksumMaterial: '900_interrupted_v1',
      up(database: Database.Database) {
        database.exec('CREATE TABLE interrupted_payload (id INTEGER PRIMARY KEY); INSERT INTO interrupted_payload VALUES (1)');
        throw new Error('simulated interruption');
      },
    };
    try {
      expect(() => runMigrations(db, { migrations: [interrupted] })).toThrow('simulated interruption');
      expect(tableExists(db, 'interrupted_payload')).toBe(false);
      expect(tableExists(db, 'schema_migrations')).toBe(false);

      const recovered = {
        ...interrupted,
        up(database: Database.Database) {
          database.exec('CREATE TABLE interrupted_payload (id INTEGER PRIMARY KEY)');
        },
      };
      expect(runMigrations(db, { migrations: [recovered] })).toEqual(['900']);
      expect(getCurrentVersion(db)).toBe('900');
      expect(tableExists(db, 'interrupted_payload')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('backup-copy rehearsal', () => {
  it('migrates a consistent backup copy and reports counts and integrity', async () => {
    const current = currentMigrationFixture();
    const { directory, path: sourcePath } = temporaryDatabase('legacy-source.sqlite');
    const outputPath = join(directory, 'legacy-source.v1-migrated.sqlite');
    const source = new Database(sourcePath);
    source.exec(legacySchema);
    source.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('copy-plan', '副本演练', 'submitted', '/srv/copy');
    source.close();
    const sourceBytesBefore = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

    const { migrateDatabaseCopy } = await import('../../src/db/migrate-copy.js');
    const report = await migrateDatabaseCopy({ sourcePath, outputPath });

    expect(report).toMatchObject({
      appliedVersions: current.versions,
      integrityBefore: 'ok',
      integrityAfter: 'ok',
      countsBefore: { plans: 1, tasks: 0, questions: 0, agent_registrations: 0 },
      countsAfter: { plans: 1, tasks: 0, questions: 0, agent_registrations: 0 },
    });
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceBytesBefore);

    const original = new Database(sourcePath, { readonly: true });
    const migrated = new Database(outputPath, { readonly: true });
    try {
      expect(tableExists(original, 'schema_migrations')).toBe(false);
      expect(migrationRecords(migrated)).toEqual(current.records);
      expect(getCurrentVersion(migrated)).toBe(current.head);
      expect(schemaSnapshot(migrated)).toEqual(current.schema);
      expect(integrity(migrated)).toBe('ok');
    } finally {
      original.close();
      migrated.close();
    }
  });

  it('removes a failed rehearsal copy without changing the source database', async () => {
    const { directory, path: sourcePath } = temporaryDatabase('failed-source.sqlite');
    const outputPath = join(directory, 'failed-output.sqlite');
    const source = new Database(sourcePath);
    source.exec(legacySchema);
    source.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('safe-plan', '原库不可污染', 'submitted', '/srv/safe');
    source.close();
    const sourceBytesBefore = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

    const { migrateDatabaseCopy } = await import('../../src/db/migrate-copy.js');
    await expect(migrateDatabaseCopy({
      sourcePath,
      outputPath,
      migrationOptions: {
        migrations: [{
          version: '900',
          checksumMaterial: 'failed-copy-v1',
          up(database) {
            database.exec('CREATE TABLE rehearsal_pollution (id INTEGER)');
            throw new Error('copy rehearsal failed');
          },
        }],
      },
    })).rejects.toThrow('copy rehearsal failed');

    expect(() => readFileSync(outputPath)).toThrow();
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceBytesBefore);
    const original = new Database(sourcePath, { readonly: true });
    try {
      expect(tableExists(original, 'schema_migrations')).toBe(false);
      expect(tableExists(original, 'rehearsal_pollution')).toBe(false);
      expect(original.prepare('SELECT title FROM plans WHERE plan_id = ?').get('safe-plan'))
        .toEqual({ title: '原库不可污染' });
    } finally {
      original.close();
    }
  });
});
