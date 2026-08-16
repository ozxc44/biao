/**
 * Phase 0a-2 门禁测试：V2 基础设施最小 schema。
 *
 * 1. 生成式字段对照：解析 §20.1 表格的最小字段清单，逐表断言 pragma table_info 覆盖。
 * 2. 约束测试：running transition 唯一、未 resolved isolation 唯一、
 *    idempotency 三键唯一、outbox (aggregate_type, aggregate_id, aggregate_revision) 定位。
 * 3. 迁移纪律：003 在备份副本上演练成功 + 旧库前向升级零数据丢失。
 * 4. outbox/idempotency 服务函数测试。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations, getCurrentVersion, checksumFor } from '../../src/db/migrate.js';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import {
  appendOutboxEvent,
  markOutboxStatus,
  listRetryableOutbox,
  recordIdempotency,
  findIdempotency,
} from '../../src/server/v2/outbox.js';
import type {
  AuditEventRow,
  OutboxEventRow,
  IdempotencyRecordRow,
  RestorePointRow,
  BackupRunRow,
  ProjectModeTransitionRow,
  OrphanRecoveryCandidateRow,
  RecoveryIsolationRow,
  BranchCleanupRow,
  ExternalMergeIntentRow,
} from '../../src/types/v2-infra.js';

const temporaryDirectories: string[] = [];
const legacySchema = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

function temporaryDatabase(name = 'biao.sqlite'): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'biao-p0a2-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, name) };
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function integrity(db: Database.Database): string {
  const rows = db.pragma('integrity_check') as Array<Record<string, string>>;
  return rows.map((r) => Object.values(r).join(':')).join('\n');
}

function migrationRecords(db: Database.Database): Array<{ version: string; checksum: string }> {
  return db.prepare(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  ).all() as Array<{ version: string; checksum: string }>;
}

// ──────────────── §20.1 最小字段解析 ────────────────

/**
 * 从 docs/distributed-multi-node-development-plan.md §20.1 表格解析最小字段清单。
 * 解析策略：读取 `| 表名 | 最小字段 |` 表格行，按逗号分割字段。
 * 文档中的表格格式为：`| \`table_name\` | field1, field2, ... |`
 */
function parseMinimalFieldsFromDocs(): Record<string, string[]> {
  const docsPath = new URL('../../docs/distributed-multi-node-development-plan.md', import.meta.url);
  const content = readFileSync(docsPath, 'utf8');
  const lines = content.split('\n');

  // 找到 §20.1 新表下面的表格
  let inTable = false;
  const result: Record<string, string[]> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测表格头
    if (trimmed.startsWith('| 表') && trimmed.includes('最小字段')) {
      inTable = true;
      continue;
    }

    // 跳过分隔行
    if (inTable && /^\|[\s-]+\|/.test(trimmed)) continue;

    // 解析数据行
    if (inTable && trimmed.startsWith('|')) {
      const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        // 提取表名（去掉反引号）
        const tableName = cells[0].replace(/`/g, '').trim();
        // 提取字段（去掉整体反引号后逗号分割）
        const fieldStr = cells[1].replace(/`/g, '').trim();
        const fields = fieldStr.split(',').map((f) => f.trim()).filter(Boolean);
        if (tableName && fields.length > 0) {
          result[tableName] = fields;
        }
      }
    } else if (inTable && !trimmed.startsWith('|') && trimmed !== '') {
      // 表格结束
      break;
    }
  }

  return result;
}

/** 本次迁移覆盖的十张基础设施表 */
const V2_INFRA_TABLES = [
  'audit_events', 'outbox_events', 'idempotency_records',
  'restore_points', 'backup_runs', 'project_mode_transitions',
  'orphan_recovery_candidates', 'recovery_isolations',
  'branch_cleanups', 'external_merge_intents',
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ──────────────── 1. 生成式字段对照门禁 ────────────────

describe('§20.1 生成式字段对照门禁', () => {
  it('解析文档 §20.1 表格得到全部基础设施表的最小字段清单', () => {
    const fields = parseMinimalFieldsFromDocs();
    // 确保解析到了我们关心的十张表
    for (const table of V2_INFRA_TABLES) {
      expect(fields[table], `§20.1 表格应包含 ${table} 的最小字段定义`).toBeDefined();
      expect(fields[table].length, `${table} 应至少有 3 个最小字段`).toBeGreaterThanOrEqual(3);
    }
  });

  it('migration 003 后每张表的列覆盖 §20.1 全部最小字段（可以多不许少）', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      runMigrations(db);
      const docFields = parseMinimalFieldsFromDocs();

      for (const table of V2_INFRA_TABLES) {
        expect(tableExists(db, table), `表 ${table} 应存在`).toBe(true);
        const actualColumns = tableColumns(db, table);
        const expectedFields = docFields[table];
        expect(expectedFields, `§20.1 应定义 ${table} 的最小字段`).toBeDefined();

        for (const field of expectedFields) {
          expect(actualColumns, `表 ${table} 应包含字段 ${field}`).toContain(field);
        }
      }
    } finally {
      db.close();
    }
  });

  it('每张表的列数不少于 §20.1 最小字段数（字段可以多不许少）', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      runMigrations(db);
      const docFields = parseMinimalFieldsFromDocs();

      for (const table of V2_INFRA_TABLES) {
        const actualColumns = tableColumns(db, table);
        const expectedFields = docFields[table];
        expect(actualColumns.length).toBeGreaterThanOrEqual(expectedFields.length);
      }
    } finally {
      db.close();
    }
  });
});

// ──────────────── 2. 约束测试 ────────────────

describe('约束测试', () => {
  it('每个 project 同时最多一个 running transition', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const now = Date.now();
      // 插入第一个 running transition
      store.insertProjectModeTransition({
        transition_id: 't-1',
        project_id: 'proj-a',
        from_mode: 'full',
        to_mode: 'read-only-acceptance',
        step: 'pause',
        status: 'running',
        idempotency_key: 'key-1',
        deadline_at: now + 86400000,
        last_error: '',
        started_at: now,
        completed_at: null,
      });

      // 同 project 第二个 running 应失败
      expect(() => store.insertProjectModeTransition({
        transition_id: 't-2',
        project_id: 'proj-a',
        from_mode: 'full',
        to_mode: 'read-only-acceptance',
        step: 'fence-attempts',
        status: 'running',
        idempotency_key: 'key-2',
        deadline_at: now + 86400000,
        last_error: '',
        started_at: now,
        completed_at: null,
      })).toThrow();

      // 完成第一个后可以插入新的 running
      store.updateProjectModeTransition('t-1', { status: 'completed', completed_at: now });
      store.insertProjectModeTransition({
        transition_id: 't-3',
        project_id: 'proj-a',
        from_mode: 'full',
        to_mode: 'read-only-acceptance',
        step: 'pause',
        status: 'running',
        idempotency_key: 'key-3',
        deadline_at: now + 86400000,
        last_error: '',
        started_at: now + 1,
        completed_at: null,
      });
      expect(store.getProjectModeTransition('t-3')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('同一 object_type + object_id 同时最多一个未 resolved isolation', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const now = Date.now();
      store.insertRecoveryIsolation({
        isolation_id: 'iso-1',
        project_id: 'proj-a',
        transition_id: '',
        object_type: 'remote-ref',
        object_id: 'ref-1',
        evidence_digest: 'digest-1',
        reason: 'test',
        status: 'isolated',
        isolated_by: 'operator',
        isolated_at: now,
        retention_until: now + 86400000,
        reviewed_by: '',
        reviewed_at: null,
        review_evidence_digest: '',
        resolved_by: '',
        resolved_at: null,
        resolution_evidence: '',
      });

      // 同 object_type+object_id 第二个非 resolved 应失败
      expect(() => store.insertRecoveryIsolation({
        isolation_id: 'iso-2',
        project_id: 'proj-a',
        transition_id: '',
        object_type: 'remote-ref',
        object_id: 'ref-1',
        evidence_digest: 'digest-2',
        reason: 'test-dup',
        status: 'under-review',
        isolated_by: 'operator',
        isolated_at: now,
        retention_until: now + 86400000,
        reviewed_by: '',
        reviewed_at: null,
        review_evidence_digest: '',
        resolved_by: '',
        resolved_at: null,
        resolution_evidence: '',
      })).toThrow();

      // resolve 后可以插入新的
      store.updateRecoveryIsolation('iso-1', {
        status: 'resolved',
        resolved_by: 'reviewer',
        resolved_at: now + 1000,
      });
      expect(store.getRecoveryIsolation('iso-1')!.status).toBe('resolved');

      // 现在可以为同一 object 创建新的 isolation
      store.insertRecoveryIsolation({
        isolation_id: 'iso-3',
        project_id: 'proj-a',
        transition_id: '',
        object_type: 'remote-ref',
        object_id: 'ref-1',
        evidence_digest: 'digest-3',
        reason: 're-isolated',
        status: 'isolated',
        isolated_by: 'operator',
        isolated_at: now + 2000,
        retention_until: now + 86400000 + 2000,
        reviewed_by: '',
        reviewed_at: null,
        review_evidence_digest: '',
        resolved_by: '',
        resolved_at: null,
        resolution_evidence: '',
      });
      expect(store.getRecoveryIsolation('iso-3')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('idempotency_records 三键唯一（actor_id, route, idempotency_key）', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertIdempotencyRecord({
        actor_id: 'worker-1',
        route: '/v2/projects',
        idempotency_key: 'key-abc',
        request_digest: 'digest-1',
        response_entity_type: 'project',
        response_entity_id: 'proj-1',
        response_revision: 1,
        expires_at: Date.now() + 86400000,
      });

      // 同三键覆盖写（INSERT OR REPLACE）
      store.insertIdempotencyRecord({
        actor_id: 'worker-1',
        route: '/v2/projects',
        idempotency_key: 'key-abc',
        request_digest: 'digest-2',
        response_entity_type: 'project',
        response_entity_id: 'proj-1',
        response_revision: 2,
        expires_at: Date.now() + 86400000,
      });

      const record = store.getIdempotencyRecord('worker-1', '/v2/projects', 'key-abc');
      expect(record).toBeDefined();
      expect(record!.response_revision).toBe(2);
      expect(record!.request_digest).toBe('digest-2');

      // 不同 actor 可以用相同 route+key
      store.insertIdempotencyRecord({
        actor_id: 'worker-2',
        route: '/v2/projects',
        idempotency_key: 'key-abc',
        request_digest: 'digest-3',
        response_entity_type: 'project',
        response_entity_id: 'proj-2',
        response_revision: 1,
        expires_at: Date.now() + 86400000,
      });
      expect(store.getIdempotencyRecord('worker-2', '/v2/projects', 'key-abc')).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('outbox_events (aggregate_type, aggregate_id, aggregate_revision) 唯一定位', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const now = Date.now();
      store.insertOutboxEvent({
        event_id: 'evt-1',
        project_id: 'proj-a',
        aggregate_type: 'delivery',
        aggregate_id: 'del-1',
        aggregate_revision: 1,
        payload_digest: 'digest-1',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: now,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      });

      // 同 aggregate 三元组应失败
      expect(() => store.insertOutboxEvent({
        event_id: 'evt-2',
        project_id: 'proj-a',
        aggregate_type: 'delivery',
        aggregate_id: 'del-1',
        aggregate_revision: 1,
        payload_digest: 'digest-2',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: now,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      })).toThrow();

      // 不同 revision 可以
      store.insertOutboxEvent({
        event_id: 'evt-3',
        project_id: 'proj-a',
        aggregate_type: 'delivery',
        aggregate_id: 'del-1',
        aggregate_revision: 2,
        payload_digest: 'digest-3',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: now,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      });
      expect(store.getOutboxEvent('evt-3')).toBeDefined();
    } finally {
      store.close();
    }
  });
});

// ──────────────── 3. 迁移纪律 ────────────────


/** 迁移链连续性基线：从空库动态推导完整版本链与终态号（不硬编码迁移号）。 */
function currentMigrationChain(): string[] {
  const probe = new Database(':memory:');
  try {
    return runMigrations(probe);
  } finally {
    probe.close();
  }
}

describe('迁移纪律', () => {
  it('003 在备份副本上演练成功（复用 migrate-copy 流程）', async () => {
    // 先建一个含 V1 数据的源库
    const { directory, path: sourcePath } = temporaryDatabase('drill-source.sqlite');
    const outputPath = join(directory, 'drill-output.sqlite');
    const source = new Database(sourcePath);
    source.exec(legacySchema);
    source.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('drill-plan', '演练计划', 'submitted', '/srv/drill');
    source.close();

    const sourceBytes = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

    const { migrateDatabaseCopy } = await import('../../src/db/migrate-copy.js');
    const report = await migrateDatabaseCopy({ sourcePath, outputPath });

    // 迁移应包含 003
    expect(report.appliedVersions).toContain('003');
    expect(report.integrityBefore).toBe('ok');
    expect(report.integrityAfter).toBe('ok');
    // V1 数据不丢失
    expect(report.countsBefore.plans).toBe(1);
    expect(report.countsAfter.plans).toBe(1);
    // 源库不可污染
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceBytes);

    // 验证迁移后副本包含全部十张表
    const migrated = new Database(outputPath, { readonly: true });
    try {
      for (const table of V2_INFRA_TABLES) {
        expect(tableExists(migrated, table), `迁移副本应包含表 ${table}`).toBe(true);
      }
      expect(migrationRecords(migrated).map((r) => r.version)).toContain('003');
      expect(integrity(migrated)).toBe('ok');
    } finally {
      migrated.close();
    }
  });

  it('旧库（001/002 状态）前向升级到 003 零数据丢失', () => {
    // 用 legacy schema 创建含数据的旧库（模拟仅有 001/002 的状态）
    const { path } = temporaryDatabase('old-db.sqlite');
    const legacy = new Database(path);
    legacy.exec(legacySchema);
    legacy.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('old-plan', '旧计划', 'submitted', '/srv/old');
    legacy.prepare(
      'INSERT INTO tasks (task_id, plan_id, title, status) VALUES (?, ?, ?, ?)',
    ).run('old-task', 'old-plan', '旧任务', 'pending');
    legacy.close();

    // 前向升级（001 → 002 → 003 → 004 → 005）
    const upgraded = new Database(path);
    try {
      const applied = runMigrations(upgraded);
      // 链条连续性：旧库前向升级 = 完整迁移链（新增迁移自动进入期望，不再过期）
      expect(applied).toEqual(currentMigrationChain());
      expect(applied).toContain('003');

      // V1 数据保留
      const plan = upgraded.prepare('SELECT title FROM plans WHERE plan_id = ?').get('old-plan') as { title: string };
      expect(plan.title).toBe('旧计划');
      const task = upgraded.prepare('SELECT title FROM tasks WHERE task_id = ?').get('old-task') as { title: string };
      expect(task.title).toBe('旧任务');

      // 十张新表存在
      for (const table of V2_INFRA_TABLES) {
        expect(tableExists(upgraded, table), `升级后应有表 ${table}`).toBe(true);
      }

      expect(integrity(upgraded)).toBe('ok');
    } finally {
      upgraded.close();
    }
  });

  it('完整迁移链版本号递增且无重复', () => {
    const { path } = temporaryDatabase();
    const db = new Database(path);
    try {
      const versions = runMigrations(db);
      expect(versions).toEqual(currentMigrationChain());
      expect(versions).toEqual([...versions].sort());
      expect(new Set(versions).size).toBe(versions.length);
      expect(getCurrentVersion(db)).toBe(currentMigrationChain().at(-1));

      // 幂等
      expect(runMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ──────────────── 4. outbox/idempotency 服务函数测试 ────────────────

describe('outbox 服务函数', () => {
  it('appendOutboxEvent 计算 payload_digest 并写入', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const row = appendOutboxEvent(store, {
        event_id: 'svc-evt-1',
        project_id: 'proj-x',
        aggregate_type: 'task',
        aggregate_id: 'task-1',
        aggregate_revision: 1,
        payload: { status: 'done' },
      });

      expect(row.status).toBe('pending');
      expect(row.payload_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(row.attempt_count).toBe(0);

      const fetched = store.getOutboxEvent('svc-evt-1');
      expect(fetched).toBeDefined();
      expect(fetched!.payload_digest).toBe(row.payload_digest);
    } finally {
      store.close();
    }
  });

  it('markOutboxStatus 更新状态和 attempt_count', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      appendOutboxEvent(store, {
        event_id: 'svc-evt-2',
        aggregate_type: 'task',
        aggregate_id: 'task-2',
        aggregate_revision: 1,
        payload: {},
      });

      markOutboxStatus(store, 'svc-evt-2', 'delivered');
      const updated = store.getOutboxEvent('svc-evt-2')!;
      expect(updated.status).toBe('delivered');
      expect(updated.attempt_count).toBe(1);
    } finally {
      store.close();
    }
  });

  it('markOutboxStatus dead_letter 记录 dead_lettered_at', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      appendOutboxEvent(store, {
        event_id: 'svc-evt-3',
        aggregate_type: 'task',
        aggregate_id: 'task-3',
        aggregate_revision: 1,
        payload: {},
      });

      markOutboxStatus(store, 'svc-evt-3', 'dead_letter', { last_error: 'permanent failure' });
      const updated = store.getOutboxEvent('svc-evt-3')!;
      expect(updated.status).toBe('dead_letter');
      expect(updated.dead_lettered_at).toBeGreaterThan(0);
      expect(updated.last_error).toBe('permanent failure');
    } finally {
      store.close();
    }
  });

  it('listRetryableOutbox 只返回 next_attempt_at 到期的 pending', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const past = Date.now() - 1000;
      const future = Date.now() + 60000;

      // 到期的
      store.insertOutboxEvent({
        event_id: 'retry-1',
        project_id: null,
        aggregate_type: 'task',
        aggregate_id: 't1',
        aggregate_revision: 1,
        payload_digest: '',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: past,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      });

      // 未到期的
      store.insertOutboxEvent({
        event_id: 'retry-2',
        project_id: null,
        aggregate_type: 'task',
        aggregate_id: 't2',
        aggregate_revision: 1,
        payload_digest: '',
        status: 'pending',
        attempt_count: 0,
        next_attempt_at: future,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      });

      // 已 delivered
      store.insertOutboxEvent({
        event_id: 'retry-3',
        project_id: null,
        aggregate_type: 'task',
        aggregate_id: 't3',
        aggregate_revision: 1,
        payload_digest: '',
        status: 'delivered',
        attempt_count: 1,
        next_attempt_at: past,
        last_error: '',
        dead_lettered_at: null,
        compensates_event_id: '',
      });

      const retryable = listRetryableOutbox(store);
      expect(retryable.map((r) => r.event_id)).toEqual(['retry-1']);
    } finally {
      store.close();
    }
  });
});

describe('idempotency 服务函数', () => {
  it('recordIdempotency 计算 request_digest 并写入', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const row = recordIdempotency(store, {
        actor_id: 'worker-1',
        route: '/v2/deliveries',
        idempotency_key: 'key-xyz',
        request_body: { head_sha: 'abc123' },
        response_entity_type: 'delivery',
        response_entity_id: 'del-1',
        response_revision: 1,
      });

      expect(row.request_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(row.expires_at).toBeGreaterThan(Date.now());
    } finally {
      store.close();
    }
  });

  it('findIdempotency 匹配相同 body 返回 digest_match=true', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      recordIdempotency(store, {
        actor_id: 'worker-1',
        route: '/v2/deliveries',
        idempotency_key: 'key-match',
        request_body: { head_sha: 'abc123' },
        response_entity_type: 'delivery',
        response_entity_id: 'del-1',
        response_revision: 1,
      });

      const result = findIdempotency(store, 'worker-1', '/v2/deliveries', 'key-match', { head_sha: 'abc123' });
      expect(result.found).toBe(true);
      expect(result.digest_match).toBe(true);
      expect(result.record!.response_entity_id).toBe('del-1');
    } finally {
      store.close();
    }
  });

  it('findIdempotency 不同 body 返回 digest_match=false', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      recordIdempotency(store, {
        actor_id: 'worker-1',
        route: '/v2/deliveries',
        idempotency_key: 'key-conflict',
        request_body: { head_sha: 'abc123' },
        response_entity_type: 'delivery',
        response_entity_id: 'del-1',
        response_revision: 1,
      });

      const result = findIdempotency(store, 'worker-1', '/v2/deliveries', 'key-conflict', { head_sha: 'DIFFERENT' });
      expect(result.found).toBe(true);
      expect(result.digest_match).toBe(false);
    } finally {
      store.close();
    }
  });

  it('findIdempotency 未命中返回 found=false', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const result = findIdempotency(store, 'nobody', '/v2/missing', 'no-key', {});
      expect(result.found).toBe(false);
    } finally {
      store.close();
    }
  });
});

// ──────────────── 5. 基本 CRUD 覆盖 ────────────────

describe('V2 基础设施表基本 CRUD', () => {
  const now = Date.now();

  it('audit_events insert + list', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertAuditEvent({
        audit_id: 'aud-1',
        project_id: 'proj-a',
        actor_id: 'operator',
        action: 'create',
        subject_type: 'project',
        subject_id: 'proj-a',
        correlation_id: '',
        evidence_digest: '',
        created_at: now,
      });
      const events = store.listAuditEvents('proj-a');
      expect(events).toHaveLength(1);
      expect(events[0].audit_id).toBe('aud-1');
    } finally {
      store.close();
    }
  });

  it('restore_points insert + get + list', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertRestorePoint({
        restore_point_id: 'rp-1',
        db_revision: 42,
        git_refs_digest: 'abc',
        artifact_manifest_digest: 'def',
        audit_high_water: 10,
        outbox_high_water: 5,
        status: 'created',
        created_at: now,
      });
      expect(store.getRestorePoint('rp-1')).toBeDefined();
      expect(store.listRestorePoints()).toHaveLength(1);
      expect(store.listRestorePoints('completed')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('branch_cleanups insert + get + list', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertBranchCleanup({
        cleanup_id: 'bc-1',
        project_id: 'proj-a',
        delivery_id: 'del-1',
        branch_ref: 'refs/biao/task-1',
        expected_head_sha: 'sha123',
        reason: 'rejected',
        status: 'pending',
        eligible_at: now,
        retention_until: now + 86400000,
        last_error: '',
        completed_at: null,
      });
      expect(store.getBranchCleanup('bc-1')).toBeDefined();
      expect(store.listBranchCleanups('proj-a')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('external_merge_intents insert + get + list', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertExternalMergeIntent({
        intent_id: 'emi-1',
        project_id: 'proj-a',
        delivery_id: 'del-1',
        expected_target_sha: 'target-sha',
        provider_actor: 'owner',
        approved_by: 'admin',
        reason: '紧急修复',
        status: 'declared',
        final_sha: '',
        created_at: now,
        resolved_at: null,
      });
      expect(store.getExternalMergeIntent('emi-1')).toBeDefined();
      expect(store.listExternalMergeIntents('proj-a')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
