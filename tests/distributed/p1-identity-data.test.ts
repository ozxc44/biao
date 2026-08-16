/**
 * Phase 1：领域身份数据层测试。
 *
 * 迁移演练 001→004 备份副本；约束测试（node+project 唯一、legacy binding 显式、generation 单调）；
 * 两台模拟 Node 不同本地路径 → 经显式 legacy_project_bindings 识别为同一 project_id；
 * 旧 generation session 写入被拒（store 层断言）。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentVersion, runMigrations } from '../../src/db/migrate.js';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type {
  ProjectRow,
  NodeRow,
  NodeSessionRow,
  NodeProjectBindingRow,
  AgentSlotRow,
  LegacyProjectBindingRow,
} from '../../src/types/v2-identity.js';
import { createNode, nodeRegister, createSimulatedRedis } from './fixtures/node-simulator.js';

const temporaryDirectories: string[] = [];

function temporaryDatabase(name = 'biao.sqlite'): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'biao-p1-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, name) };
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function triggerNames(db: Database.Database): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name);
}

function integrity(db: Database.Database): string {
  const rows = db.pragma('integrity_check') as Array<Record<string, string>>;
  return rows.map((row) => Object.values(row).join(':')).join('\n');
}

function migrationRecords(db: Database.Database): Array<{ version: string; checksum: string }> {
  return db.prepare(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  ).all() as Array<{ version: string; checksum: string }>;
}

const NOW = Date.now();

function makeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    project_id: 'proj-001',
    display_name: '测试项目',
    repository_url: 'github.com/org/repo',
    repository_fingerprint: 'abc123',
    default_branch: 'main',
    merge_policy: 'merge-queue',
    execution_mode: 'full',
    mode_transition: null,
    mode_transition_id: '',
    mode_transition_step: null,
    write_capability_status: 'ready',
    artifact_policy_id: '',
    workspace_policy_id: '',
    status: 'active',
    revision: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function makeNode(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    node_id: 'node-001',
    display_name: 'MacBook Pro',
    os: 'darwin',
    arch: 'arm64',
    node_version: '1.0.0',
    protocol_version: 'v2',
    status: 'enrolling',
    capabilities: '[]',
    labels: '[]',
    max_concurrent_tasks: 4,
    memory_mb: 16384,
    disk_free_mb: 50000,
    last_seen_at: NOW,
    credential_generation: 0,
    clock_skew_ms: null,
    server_cert_not_after: '',
    trust_anchor_generation: 0,
    signing_key_generation: 0,
    accepted_control_plane_signing_key_generations: '[]',
    terminal_state_at: null,
    terminal_state_reason: '',
    ttl_expires_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ──────────────── 迁移演练 001→004 ────────────────

describe('迁移 001→004 备份副本演练', () => {
  it('在备份副本上成功应用全部迁移并通过 integrity check', async () => {
    const { directory, path: sourcePath } = temporaryDatabase('source.sqlite');
    const outputPath = join(directory, 'source.migrated.sqlite');

    // 创建带 V1 数据的源库
    const source = new Database(sourcePath);
    source.exec(readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8'));
    source.prepare(
      'INSERT INTO plans (plan_id, title, status, project_path) VALUES (?, ?, ?, ?)',
    ).run('p1-plan', 'Phase 1 计划', 'submitted', '/srv/project-a');
    source.prepare(
      'INSERT INTO tasks (task_id, plan_id, title, status) VALUES (?, ?, ?, ?)',
    ).run('p1-task', 'p1-plan', 'Phase 1 任务', 'pending');
    source.close();

    const sourceBytesBefore = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

    const { migrateDatabaseCopy } = await import('../../src/db/migrate-copy.js');
    const report = await migrateDatabaseCopy({ sourcePath, outputPath });

    expect(report.integrityBefore).toBe('ok');
    expect(report.integrityAfter).toBe('ok');
    expect(report.appliedVersions).toContain('004');

    // 源库不可变
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceBytesBefore);

    // 迁移后副本包含新表
    const migrated = new Database(outputPath, { readonly: true });
    try {
      expect(tableExists(migrated, 'projects')).toBe(true);
      expect(tableExists(migrated, 'nodes')).toBe(true);
      expect(tableExists(migrated, 'node_sessions')).toBe(true);
      expect(tableExists(migrated, 'node_project_bindings')).toBe(true);
      expect(tableExists(migrated, 'agent_slots')).toBe(true);
      expect(tableExists(migrated, 'legacy_project_bindings')).toBe(true);
      expect(integrity(migrated)).toBe('ok');
      // 链条连续性：副本演练后到达迁移链末端（不硬编码终态号）
      const head = (() => {
        const probe = new Database(':memory:');
        try {
          return runMigrations(probe).at(-1);
        } finally {
          probe.close();
        }
      })();
      expect(getCurrentVersion(migrated)).toBe(head);
    } finally {
      migrated.close();
    }
  });
});

// ──────────────── 表结构验证 ────────────────

describe('004 表结构与扩展列', () => {
  it('包含六张领域表和 §20.1 最小字段', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const db = (store as unknown as { db: Database.Database }).db;

      // projects 最小字段
      const projCols = tableColumns(db, 'projects');
      for (const col of [
        'project_id', 'display_name', 'repository_url', 'repository_fingerprint',
        'default_branch', 'execution_mode', 'mode_transition', 'mode_transition_id',
        'mode_transition_step', 'write_capability_status', 'status', 'revision',
        'created_at', 'updated_at',
      ]) {
        expect(projCols).toContain(col);
      }

      // nodes 最小字段（含 enrolling 终态 TTL）
      const nodeCols = tableColumns(db, 'nodes');
      for (const col of [
        'node_id', 'display_name', 'os', 'arch', 'status', 'capabilities',
        'credential_generation', 'terminal_state_at', 'terminal_state_reason', 'ttl_expires_at',
      ]) {
        expect(nodeCols).toContain(col);
      }

      // node_sessions
      const sessCols = tableColumns(db, 'node_sessions');
      for (const col of ['session_id', 'node_id', 'node_session_generation', 'credential_generation', 'fenced_at']) {
        expect(sessCols).toContain(col);
      }

      // node_project_bindings
      const bindCols = tableColumns(db, 'node_project_bindings');
      for (const col of [
        'binding_id', 'node_id', 'project_id', 'authorization_status',
        'authorization_revision', 'applied_policy_revision', 'write_credential_status', 'health',
      ]) {
        expect(bindCols).toContain(col);
      }

      // agent_slots
      const slotCols = tableColumns(db, 'agent_slots');
      for (const col of ['slot_id', 'node_id', 'session_id', 'capability_digest', 'active_attempt_id']) {
        expect(slotCols).toContain(col);
      }

      // legacy_project_bindings
      const legCols = tableColumns(db, 'legacy_project_bindings');
      for (const col of ['legacy_project_path', 'project_id', 'repository_fingerprint']) {
        expect(legCols).toContain(col);
      }

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });

  it('plans/tasks/agent_registrations 扩展列存在（§20.2）', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const db = (store as unknown as { db: Database.Database }).db;

      const planCols = tableColumns(db, 'plans');
      expect(planCols).toContain('project_id');
      expect(planCols).toContain('revision');
      expect(planCols).toContain('source_digest');
      expect(planCols).toContain('schema_version');

      const taskCols = tableColumns(db, 'tasks');
      expect(taskCols).toContain('project_id');
      expect(taskCols).toContain('active_attempt_id');
      expect(taskCols).toContain('accepted_delivery_id');
      expect(taskCols).toContain('completion_kind');

      const agentCols = tableColumns(db, 'agent_registrations');
      expect(agentCols).toContain('node_id');
      expect(agentCols).toContain('slot_id');
      expect(agentCols).toContain('protocol_version');

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });

  it('触发器存在：revision 单调 + generation 单调', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      const db = (store as unknown as { db: Database.Database }).db;
      const triggers = triggerNames(db);
      expect(triggers).toContain('trg_npb_auth_revision_monotonic');
      expect(triggers).toContain('trg_node_session_gen_monotonic');
      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

// ──────────────── 约束测试 ────────────────

describe('约束：node+project 唯一', () => {
  it('同一 node_id + project_id 不能插入两条 binding', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertProject(makeProject());
      store.insertNode(makeNode());

      store.insertNodeProjectBinding({
        binding_id: 'bind-1',
        node_id: 'node-001',
        project_id: 'proj-001',
        local_cache_root: '/tmp/cache-a',
        checkout_mode: 'worktree',
        repository_fingerprint: 'abc123',
        last_fetch_sha: '',
        health: 'ready',
        last_checked_at: NOW,
        authorization_status: 'pending',
        authorized_by: '',
        authorized_at: null,
        authorization_revision: 0,
        applied_policy_revision: 0,
        write_credential_status: 'none',
        created_at: NOW,
        updated_at: NOW,
      });

      expect(() => {
        store.insertNodeProjectBinding({
          binding_id: 'bind-2',
          node_id: 'node-001',
          project_id: 'proj-001',
          local_cache_root: '/tmp/cache-b',
          checkout_mode: 'worktree',
          repository_fingerprint: 'abc123',
          last_fetch_sha: '',
          health: 'ready',
          last_checked_at: NOW,
          authorization_status: 'pending',
          authorized_by: '',
          authorized_at: null,
          authorization_revision: 0,
          applied_policy_revision: 0,
          write_credential_status: 'none',
          created_at: NOW,
          updated_at: NOW,
        });
      }).toThrow(/UNIQUE constraint/);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

describe('约束：authorization_revision 单调递增', () => {
  it('触发器拒绝 authorization_revision 回退', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertProject(makeProject());
      store.insertNode(makeNode());
      store.insertNodeProjectBinding({
        binding_id: 'bind-1',
        node_id: 'node-001',
        project_id: 'proj-001',
        local_cache_root: '/tmp/cache',
        checkout_mode: 'worktree',
        repository_fingerprint: 'abc123',
        last_fetch_sha: '',
        health: 'ready',
        last_checked_at: NOW,
        authorization_status: 'authorized',
        authorized_by: 'admin',
        authorized_at: NOW,
        authorization_revision: 5,
        applied_policy_revision: 1,
        write_credential_status: 'eligible',
        created_at: NOW,
        updated_at: NOW,
      });

      // 允许递增
      store.updateNodeProjectBinding('bind-1', { authorization_revision: 6 });

      // 拒绝回退
      expect(() => {
        store.updateNodeProjectBinding('bind-1', { authorization_revision: 3 });
      }).toThrow(/authorization_revision must be monotonically non-decreasing/);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

describe('约束：node_session generation 单调递增', () => {
  it('拒绝同一节点的旧 generation session 写入', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertNode(makeNode());

      store.insertNodeSession({
        session_id: 'sess-1',
        node_id: 'node-001',
        node_session_generation: 1,
        credential_generation: 0,
        status: 'active',
        started_at: NOW,
        last_seen_at: NOW,
        fenced_at: null,
      });

      // generation 2 可以插入
      store.insertNodeSession({
        session_id: 'sess-2',
        node_id: 'node-001',
        node_session_generation: 2,
        credential_generation: 1,
        status: 'active',
        started_at: NOW,
        last_seen_at: NOW,
        fenced_at: null,
      });

      // generation 1 再次插入应被拒
      expect(() => {
        store.insertNodeSession({
          session_id: 'sess-3',
          node_id: 'node-001',
          node_session_generation: 1,
          credential_generation: 0,
          status: 'active',
          started_at: NOW,
          last_seen_at: NOW,
          fenced_at: null,
        });
      }).toThrow(/node_session_generation must be monotonically increasing/);

      // generation 2 再次插入也应被拒（等于已存在）
      expect(() => {
        store.insertNodeSession({
          session_id: 'sess-4',
          node_id: 'node-001',
          node_session_generation: 2,
          credential_generation: 1,
          status: 'active',
          started_at: NOW,
          last_seen_at: NOW,
          fenced_at: null,
        });
      }).toThrow(/node_session_generation must be monotonically increasing/);

      // getCurrentNodeSession 返回最高代次
      const current = store.getCurrentNodeSession('node-001');
      expect(current?.session_id).toBe('sess-2');
      expect(current?.node_session_generation).toBe(2);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

describe('约束：legacy_project_bindings 显式映射', () => {
  it('(legacy_project_path, repository_fingerprint) 复合主键唯一', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertProject(makeProject());

      store.insertLegacyProjectBinding({
        legacy_project_path: '/srv/project-a',
        project_id: 'proj-001',
        repository_fingerprint: 'fp-abc',
        repository_url: 'github.com/org/repo',
        default_branch: 'main',
        verified_at: NOW,
      });

      // 同路径同 fingerprint → 冲突
      expect(() => {
        store.insertLegacyProjectBinding({
          legacy_project_path: '/srv/project-a',
          project_id: 'proj-001',
          repository_fingerprint: 'fp-abc',
          repository_url: 'github.com/org/repo',
          default_branch: 'main',
          verified_at: NOW,
        });
      }).toThrow(/UNIQUE constraint|PRIMARY KEY constraint/);

      // 同路径不同 fingerprint → 允许
      store.insertLegacyProjectBinding({
        legacy_project_path: '/srv/project-a',
        project_id: 'proj-001',
        repository_fingerprint: 'fp-xyz',
        repository_url: 'github.com/org/repo-v2',
        default_branch: 'main',
        verified_at: NOW,
      });

      const bindings = store.listLegacyProjectBindings('proj-001');
      expect(bindings.length).toBe(2);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

// ──────────────── 两节点同 Project 验收场景 ────────────────

describe('两台模拟 Node 不同本地路径 → 同一 project_id（方案 Phase 1 验收场景）', () => {
  it('node-A 和 node-B 各自 clone 不同路径，经显式 legacy_project_bindings 识别为同一 project_id', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    const redis = createSimulatedRedis();
    try {
      // 创建项目
      store.insertProject(makeProject({
        project_id: 'proj-shared',
        display_name: '共享仓库',
        repository_url: 'github.com/team/shared-repo',
        repository_fingerprint: 'fingerprint-shared-repo',
      }));

      // 创建两个模拟节点（不同本地路径）
      const nodeA = createNode({ nodeId: 'node-mac-01' });
      const nodeB = createNode({ nodeId: 'node-linux-01' });
      nodeRegister(redis, nodeA);
      nodeRegister(redis, nodeB);

      // 注册节点到 SQLite
      store.insertNode(makeNode({
        node_id: 'node-mac-01',
        display_name: 'Mac 开发机',
        os: 'darwin',
        status: 'online',
      }));
      store.insertNode(makeNode({
        node_id: 'node-linux-01',
        display_name: 'Linux CI',
        os: 'linux',
        status: 'online',
      }));

      // 两个节点各自有不同的本地路径，但通过显式 legacy_project_bindings 指向同一 project_id
      // 路径 A: /Users/dev/shared-repo
      // 路径 B: /home/ci/workspace/shared-repo
      store.insertLegacyProjectBinding({
        legacy_project_path: '/Users/dev/shared-repo',
        project_id: 'proj-shared',
        repository_fingerprint: 'fingerprint-shared-repo',
        repository_url: 'github.com/team/shared-repo',
        default_branch: 'main',
        verified_at: NOW,
      });
      store.insertLegacyProjectBinding({
        legacy_project_path: '/home/ci/workspace/shared-repo',
        project_id: 'proj-shared',
        repository_fingerprint: 'fingerprint-shared-repo',
        repository_url: 'github.com/team/shared-repo',
        default_branch: 'main',
        verified_at: NOW,
      });

      // 验证两个不同路径都解析到同一 project_id
      const bindingA = store.getLegacyBindingByPath('/Users/dev/shared-repo');
      const bindingB = store.getLegacyBindingByPath('/home/ci/workspace/shared-repo');
      expect(bindingA?.project_id).toBe('proj-shared');
      expect(bindingB?.project_id).toBe('proj-shared');
      expect(bindingA?.project_id).toBe(bindingB?.project_id);

      // 两个节点都绑定到同一 project
      store.insertNodeProjectBinding({
        binding_id: 'npb-mac',
        node_id: 'node-mac-01',
        project_id: 'proj-shared',
        local_cache_root: '/Users/dev/shared-repo',
        checkout_mode: 'worktree',
        repository_fingerprint: 'fingerprint-shared-repo',
        last_fetch_sha: '',
        health: 'ready',
        last_checked_at: NOW,
        authorization_status: 'authorized',
        authorized_by: 'admin',
        authorized_at: NOW,
        authorization_revision: 1,
        applied_policy_revision: 1,
        write_credential_status: 'eligible',
        created_at: NOW,
        updated_at: NOW,
      });
      store.insertNodeProjectBinding({
        binding_id: 'npb-linux',
        node_id: 'node-linux-01',
        project_id: 'proj-shared',
        local_cache_root: '/home/ci/workspace/shared-repo',
        checkout_mode: 'worktree',
        repository_fingerprint: 'fingerprint-shared-repo',
        last_fetch_sha: '',
        health: 'ready',
        last_checked_at: NOW,
        authorization_status: 'authorized',
        authorized_by: 'admin',
        authorized_at: NOW,
        authorization_revision: 1,
        applied_policy_revision: 1,
        write_credential_status: 'eligible',
        created_at: NOW,
        updated_at: NOW,
      });

      // 查询 project 下的所有 binding
      const projectBindings = store.listNodeProjectBindings(undefined, 'proj-shared');
      expect(projectBindings.length).toBe(2);
      expect(projectBindings.map((b) => b.node_id).sort()).toEqual(['node-linux-01', 'node-mac-01']);

      // 查询 project 下的所有 legacy binding
      const legacyBindings = store.listLegacyProjectBindings('proj-shared');
      expect(legacyBindings.length).toBe(2);
      expect(legacyBindings.map((b) => b.legacy_project_path).sort()).toEqual([
        '/Users/dev/shared-repo',
        '/home/ci/workspace/shared-repo',
      ]);

      // 两个不同路径的 fingerprint 相同（都是同一仓库）
      expect(legacyBindings[0].repository_fingerprint).toBe(legacyBindings[1].repository_fingerprint);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

// ──────────────── CRUD 基本功能 ────────────────

describe('六表 CRUD 基本功能', () => {
  it('projects CRUD + 按状态查询', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertProject(makeProject());
      store.insertProject(makeProject({ project_id: 'proj-002', status: 'paused' }));

      expect(store.getProject('proj-001')?.display_name).toBe('测试项目');
      expect(store.listProjects().length).toBe(2);
      expect(store.listProjects('active').length).toBe(1);
      expect(store.listProjects('paused').length).toBe(1);

      store.updateProject('proj-001', { display_name: '更新名称', revision: 1 });
      expect(store.getProject('proj-001')?.display_name).toBe('更新名称');
      expect(store.getProject('proj-001')?.revision).toBe(1);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });

  it('nodes CRUD + 按状态查询', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertNode(makeNode());
      store.insertNode(makeNode({ node_id: 'node-002', status: 'online' }));

      expect(store.getNode('node-001')?.status).toBe('enrolling');
      expect(store.listNodes().length).toBe(2);
      expect(store.listNodes('enrolling').length).toBe(1);
      expect(store.listNodes('online').length).toBe(1);

      store.updateNode('node-001', { status: 'online', last_seen_at: NOW + 1000 });
      expect(store.getNode('node-001')?.status).toBe('online');

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });

  it('node_sessions CRUD + generation fencing 查询', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertNode(makeNode());

      store.insertNodeSession({
        session_id: 'sess-1',
        node_id: 'node-001',
        node_session_generation: 1,
        credential_generation: 0,
        status: 'active',
        started_at: NOW,
        last_seen_at: NOW,
        fenced_at: null,
      });
      store.insertNodeSession({
        session_id: 'sess-2',
        node_id: 'node-001',
        node_session_generation: 2,
        credential_generation: 1,
        status: 'active',
        started_at: NOW + 1000,
        last_seen_at: NOW + 1000,
        fenced_at: null,
      });

      expect(store.listNodeSessions('node-001').length).toBe(2);
      expect(store.getCurrentNodeSession('node-001')?.session_id).toBe('sess-2');

      // fence 旧 session
      store.updateNodeSession('sess-1', { status: 'fenced', fenced_at: NOW + 2000 });
      expect(store.getNodeSession('sess-1')?.status).toBe('fenced');
      expect(store.getNodeSession('sess-1')?.fenced_at).toBe(NOW + 2000);

      expect(store.listNodeSessions('node-001', 'fenced').length).toBe(1);
      expect(store.listNodeSessions('node-001', 'active').length).toBe(1);

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });

  it('agent_slots CRUD + 按 node/status 查询', () => {
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      store.insertNode(makeNode());

      store.insertAgentSlot({
        slot_id: 'slot-1',
        node_id: 'node-001',
        session_id: 'sess-1',
        capability_digest: 'cap-sha256',
        status: 'idle',
        active_attempt_id: '',
        updated_at: NOW,
      });
      store.insertAgentSlot({
        slot_id: 'slot-2',
        node_id: 'node-001',
        session_id: 'sess-1',
        capability_digest: 'cap-sha256',
        status: 'executing',
        active_attempt_id: 'attempt-001',
        updated_at: NOW,
      });

      expect(store.listAgentSlots('node-001').length).toBe(2);
      expect(store.listAgentSlots('node-001', 'idle').length).toBe(1);
      expect(store.listAgentSlots('node-001', 'executing').length).toBe(1);

      store.updateAgentSlot('slot-1', { status: 'claiming' });
      expect(store.getAgentSlot('slot-1')?.status).toBe('claiming');

      store.close();
    } catch (e) {
      store.close();
      throw e;
    }
  });
});

// ──────────────── 迁移链版本期望更新 ────────────────

describe('迁移链版本期望', () => {
  it('当前最高版本为迁移链末端（链条连续性，不硬编码终态号）', () => {
    const head = (() => {
      const probe = new Database(':memory:');
      try {
        return runMigrations(probe).at(-1);
      } finally {
        probe.close();
      }
    })();
    const { path } = temporaryDatabase();
    const store = new SqliteStore(path);
    try {
      expect(store.getSchemaVersion()).toBe(head);
    } finally {
      store.close();
    }
  });
});
