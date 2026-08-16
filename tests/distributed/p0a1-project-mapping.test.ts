import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProjectMappings,
  computeRemoteFingerprint,
  formatProjectMappingReport,
  inspectGitRepository,
  normalizeRepositoryUrl,
  rebindProjectMapping,
  rollbackProjectRebind,
  scanProjectMappings,
  type GitInspection,
} from '../../src/migration/project-mapping.js';
import { parseMigrationCommand } from '../../src/cli/v2/migration.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'biao-project-map-'));
  temporaryDirectories.push(directory);
  return directory;
}

function initializeRepository(root: string, remote?: string): string {
  const repository = join(root, 'repo');
  mkdirSync(repository, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Biao Test'], { cwd: repository });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: repository, stdio: 'ignore' });
  if (remote) {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
      cwd: repository,
    });
  }
  return repository;
}

function seedLegacyPath(db: Database.Database, id: string, projectPath: string, source: 'plans' | 'tasks' = 'plans'): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${source} (
      ${source === 'plans' ? 'plan_id' : 'task_id'} TEXT PRIMARY KEY,
      project_path TEXT
    )
  `);
  db.prepare(`INSERT INTO ${source} VALUES (?, ?)`).run(id, projectPath);
}

function seedProject(
  db: Database.Database,
  projectId: string,
  repositoryUrl: string,
  defaultBranch = 'main',
  fingerprint = computeRemoteFingerprint(repositoryUrl),
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      repository_url TEXT NOT NULL,
      repository_fingerprint TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      v2_claim_enabled INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, 0)')
    .run(projectId, repositoryUrl, fingerprint, defaultBranch);
}

function gitInspection(repositoryUrl: string, defaultBranch = 'main'): GitInspection {
  return {
    kind: 'git',
    repositoryUrl: normalizeRepositoryUrl(repositoryUrl),
    repositoryFingerprint: computeRemoteFingerprint(repositoryUrl),
    defaultBranch,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('repository identity', () => {
  it('normalizes HTTPS and SSH transports to the same repository identity', () => {
    expect(normalizeRepositoryUrl('HTTPS://GitHub.COM/Owner/Repo.git/'))
      .toBe('github.com/Owner/Repo');
    expect(normalizeRepositoryUrl('git@github.com:Owner/Repo.git'))
      .toBe('github.com/Owner/Repo');
    expect(computeRemoteFingerprint('https://github.com/Owner/Repo.git'))
      .toBe(computeRemoteFingerprint('ssh://git@github.com/Owner/Repo'));
  });

  it('fingerprints the remote identity without incorporating a local path or default branch', () => {
    const fingerprint = computeRemoteFingerprint('https://example.com/team/repo.git');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(computeRemoteFingerprint('git@example.com:team/repo.git'));
  });
});

describe('inspectGitRepository', () => {
  it('reads the origin identity and explicit remote default branch', () => {
    const repository = initializeRepository(
      temporaryDirectory(),
      'https://github.com/example/project.git',
    );

    expect(inspectGitRepository(repository)).toEqual(gitInspection('https://github.com/example/project.git'));
  });

  it('fails closed with distinct non-Git and missing-remote results', () => {
    expect(inspectGitRepository(temporaryDirectory())).toMatchObject({ kind: 'blocked', code: 'not-git' });
    const repository = initializeRepository(temporaryDirectory());
    expect(inspectGitRepository(repository)).toMatchObject({ kind: 'blocked', code: 'missing-remote' });
  });
});

describe('scanProjectMappings', () => {
  it('returns an empty deterministic preview for an empty V1 database', () => {
    const db = new Database(':memory:');
    try {
      expect(scanProjectMappings(db)).toEqual({
        entries: [],
        summary: { mapped: 0, blocked: 0, conflict: 0, 'rebind-needed': 0 },
      });
    } finally {
      db.close();
    }
  });

  it('keeps non-Git paths local-only and blocked without creating a V2 Project', () => {
    const db = new Database(':memory:');
    const path = temporaryDirectory();
    try {
      seedLegacyPath(db, 'plan-local', path);
      const result = scanProjectMappings(db);
      expect(result.entries[0]).toMatchObject({
        legacyProjectPath: path,
        status: 'blocked',
        blockCode: 'not-git',
        localOnly: true,
        projectId: null,
      });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('blocks a Git repository until an explicit matching V2 Project exists', () => {
    const db = new Database(':memory:');
    const path = '/srv/repositories/project';
    try {
      seedLegacyPath(db, 'plan-1', path);
      const result = scanProjectMappings(db, {
        inspectRepository: () => gitInspection('https://example.com/team/project.git'),
      });
      expect(result.entries[0]).toMatchObject({
        status: 'blocked',
        blockCode: 'project-not-found',
        localOnly: true,
        projectId: null,
      });
    } finally {
      db.close();
    }
  });

  it('maps macOS, Linux, and Windows absolute paths to the same explicit Project', () => {
    const db = new Database(':memory:');
    const paths = ['/Users/alice/src/repo', '/home/alice/src/repo', 'C:\\Users\\alice\\src\\repo'];
    const repositoryUrl = 'https://github.com/example/cross-platform.git';
    try {
      paths.forEach((path, index) => seedLegacyPath(db, `plan-${index}`, path));
      seedProject(db, 'project-random-01JABC', repositoryUrl);

      const result = scanProjectMappings(db, { inspectRepository: () => gitInspection(repositoryUrl) });

      expect(result.entries.map((entry) => entry.status)).toEqual(['mapped', 'mapped', 'mapped']);
      expect(new Set(result.entries.map((entry) => entry.projectId))).toEqual(new Set(['project-random-01JABC']));
      expect(result.entries.every((entry) => !entry.identityMaterial.includes(entry.legacyProjectPath))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('scans task project_path values in addition to plan project_path values', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/task-only.git';
    try {
      seedLegacyPath(db, 'task-1', '/work/task-only', 'tasks');
      seedProject(db, 'project-task-only', repositoryUrl);
      const result = scanProjectMappings(db, { inspectRepository: () => gitInspection(repositoryUrl) });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ status: 'mapped', projectId: 'project-task-only' });
    } finally {
      db.close();
    }
  });

  it('reports conflict when a repository identity resolves to multiple Projects', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/duplicate.git';
    try {
      seedLegacyPath(db, 'plan-1', '/work/duplicate');
      seedProject(db, 'project-a', repositoryUrl);
      seedProject(db, 'project-b', repositoryUrl);

      const result = scanProjectMappings(db, { inspectRepository: () => gitInspection(repositoryUrl) });
      expect(result.entries[0]).toMatchObject({ status: 'conflict', projectId: null });
      expect(result.summary.conflict).toBe(1);
    } finally {
      db.close();
    }
  });

  it('reports conflict when the Project registry stores an invalid remote fingerprint', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/tampered.git';
    try {
      seedLegacyPath(db, 'plan-1', '/work/tampered');
      seedProject(db, 'project-tampered', repositoryUrl, 'main', '0'.repeat(64));
      const result = scanProjectMappings(db, { inspectRepository: () => gitInspection(repositoryUrl) });
      expect(result.entries[0]).toMatchObject({ status: 'conflict', blockCode: 'fingerprint-conflict' });
    } finally {
      db.close();
    }
  });
});

describe('apply, replay, rebind, and rollback', () => {
  it('rejects a stale preview when Git identity changes before apply', () => {
    const db = new Database(':memory:');
    const oldUrl = 'https://example.com/team/stale-old.git';
    const newUrl = 'https://example.com/team/stale-new.git';
    let currentUrl = oldUrl;
    const inspectRepository = () => gitInspection(currentUrl);
    try {
      seedLegacyPath(db, 'plan-1', '/work/stale');
      seedProject(db, 'project-old', oldUrl);
      seedProject(db, 'project-new', newUrl);
      const preview = scanProjectMappings(db, { inspectRepository });
      currentUrl = newUrl;

      expect(() => applyProjectMappings(db, preview, {
        confirmedBy: 'owner',
        inspectRepository,
      })).toThrow(/changed after preview/i);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'legacy_project_bindings'").get())
        .toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('requires explicit confirmation and never enables V2 claim', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/apply.git';
    try {
      seedLegacyPath(db, 'plan-1', '/work/apply');
      seedProject(db, 'project-apply', repositoryUrl);
      const scan = scanProjectMappings(db, { inspectRepository: () => gitInspection(repositoryUrl) });

      expect(() => applyProjectMappings(db, scan)).toThrow(/confirm/i);
      const applied = applyProjectMappings(db, scan, {
        confirmedBy: 'owner@example.com',
        inspectRepository: () => gitInspection(repositoryUrl),
      });

      expect(applied.applied).toBe(1);
      expect(db.prepare('SELECT project_id, repository_fingerprint FROM legacy_project_bindings').all())
        .toEqual([{ project_id: 'project-apply', repository_fingerprint: computeRemoteFingerprint(repositoryUrl) }]);
      expect(db.prepare('SELECT action, actor_id FROM legacy_project_binding_audit').all())
        .toEqual([{ action: 'bind', actor_id: 'owner@example.com' }]);
      expect(db.prepare('SELECT v2_claim_enabled FROM projects WHERE project_id = ?').get('project-apply'))
        .toEqual({ v2_claim_enabled: 0 });
    } finally {
      db.close();
    }
  });

  it('replays the original binding without replacing its project id or duplicating audit', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/replay.git';
    const inspectRepository = () => gitInspection(repositoryUrl);
    try {
      seedLegacyPath(db, 'plan-1', '/work/replay');
      seedProject(db, 'project-random-replay', repositoryUrl);
      const first = scanProjectMappings(db, { inspectRepository });
      applyProjectMappings(db, first, { confirmedBy: 'owner', inspectRepository });

      const replay = scanProjectMappings(db, { inspectRepository });
      expect(replay.entries[0]).toMatchObject({
        status: 'mapped',
        projectId: 'project-random-replay',
        replay: true,
      });
      expect(applyProjectMappings(db, replay, { confirmedBy: 'owner', inspectRepository }).applied).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM legacy_project_binding_audit').get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('replays a minimum-schema legacy binding created by the V2 schema migration', () => {
    const db = new Database(':memory:');
    const repositoryUrl = 'https://example.com/team/minimum-binding.git';
    const inspectRepository = () => gitInspection(repositoryUrl);
    try {
      seedLegacyPath(db, 'plan-1', '/work/minimum-binding');
      seedProject(db, 'project-minimum-binding', repositoryUrl);
      db.exec(`
        CREATE TABLE legacy_project_bindings (
          legacy_project_path TEXT NOT NULL,
          project_id TEXT NOT NULL,
          repository_fingerprint TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          UNIQUE (legacy_project_path, repository_fingerprint)
        )
      `);
      db.prepare('INSERT INTO legacy_project_bindings VALUES (?, ?, ?, ?)').run(
        '/work/minimum-binding',
        'project-minimum-binding',
        computeRemoteFingerprint(repositoryUrl),
        '2026-08-15T00:00:00.000Z',
      );

      expect(scanProjectMappings(db, { inspectRepository }).entries[0]).toMatchObject({
        status: 'mapped',
        projectId: 'project-minimum-binding',
        replay: true,
      });
    } finally {
      db.close();
    }
  });

  it('requires explicit rebind after a remote change and preserves an audit trail', () => {
    const db = new Database(':memory:');
    const oldUrl = 'https://example.com/team/old.git';
    const newUrl = 'https://example.com/team/new.git';
    let currentUrl = oldUrl;
    const inspectRepository = () => gitInspection(currentUrl);
    try {
      seedLegacyPath(db, 'plan-1', '/work/rebind');
      seedProject(db, 'project-old', oldUrl);
      seedProject(db, 'project-new', newUrl);
      applyProjectMappings(db, scanProjectMappings(db, { inspectRepository }), {
        confirmedBy: 'owner',
        inspectRepository,
      });

      currentUrl = newUrl;
      const changed = scanProjectMappings(db, { inspectRepository });
      expect(changed.entries[0]).toMatchObject({
        status: 'rebind-needed',
        projectId: 'project-old',
        proposedProjectId: 'project-new',
      });
      expect(applyProjectMappings(db, changed, { confirmedBy: 'owner', inspectRepository }).applied).toBe(0);
      expect(db.prepare('SELECT project_id FROM legacy_project_bindings').get())
        .toEqual({ project_id: 'project-old' });

      const rebound = rebindProjectMapping(db, {
        legacyProjectPath: '/work/rebind',
        targetProjectId: 'project-new',
        expectedPreviousFingerprint: computeRemoteFingerprint(oldUrl),
        expectedNewFingerprint: computeRemoteFingerprint(newUrl),
        actorId: 'owner@example.com',
        reason: 'repository transferred',
        inspectRepository,
      });
      expect(rebound.projectId).toBe('project-new');
      expect(db.prepare('SELECT action, old_project_id, new_project_id, reason FROM legacy_project_binding_audit ORDER BY created_at').all())
        .toEqual([
          { action: 'bind', old_project_id: null, new_project_id: 'project-old', reason: 'confirmed mapping preview' },
          { action: 'rebind', old_project_id: 'project-old', new_project_id: 'project-new', reason: 'repository transferred' },
        ]);
    } finally {
      db.close();
    }
  });

  it('rolls back only when Git matches the prior audited identity and records the rollback', () => {
    const db = new Database(':memory:');
    const oldUrl = 'https://example.com/team/rollback-old.git';
    const newUrl = 'https://example.com/team/rollback-new.git';
    let currentUrl = oldUrl;
    const inspectRepository = () => gitInspection(currentUrl);
    try {
      seedLegacyPath(db, 'plan-1', '/work/rollback');
      seedProject(db, 'project-old', oldUrl);
      seedProject(db, 'project-new', newUrl);
      applyProjectMappings(db, scanProjectMappings(db, { inspectRepository }), {
        confirmedBy: 'owner',
        inspectRepository,
      });
      currentUrl = newUrl;
      const rebind = rebindProjectMapping(db, {
        legacyProjectPath: '/work/rollback',
        targetProjectId: 'project-new',
        expectedPreviousFingerprint: computeRemoteFingerprint(oldUrl),
        expectedNewFingerprint: computeRemoteFingerprint(newUrl),
        actorId: 'owner',
        reason: 'move',
        inspectRepository,
      });

      expect(() => rollbackProjectRebind(db, {
        auditId: rebind.auditId,
        actorId: 'owner',
        reason: 'undo move',
        inspectRepository,
      })).toThrow(/Git identity/i);

      currentUrl = oldUrl;
      const rolledBack = rollbackProjectRebind(db, {
        auditId: rebind.auditId,
        actorId: 'owner',
        reason: 'undo move',
        inspectRepository,
      });
      expect(rolledBack.projectId).toBe('project-old');
      expect(db.prepare('SELECT action, reverses_audit_id FROM legacy_project_binding_audit ORDER BY audit_sequence DESC LIMIT 1').get())
        .toEqual({ action: 'rollback', reverses_audit_id: rebind.auditId });
    } finally {
      db.close();
    }
  });
});

describe('preview and report interfaces', () => {
  it('defaults the CLI to preview and requires confirmation for apply', () => {
    expect(parseMigrationCommand([])).toMatchObject({ command: 'preview' });
    expect(parseMigrationCommand(['apply', '--db', '/tmp/biao.sqlite'])).toMatchObject({
      command: 'apply',
      confirmed: false,
    });
    expect(parseMigrationCommand(['apply', '--confirm', '--actor', 'owner'])).toMatchObject({
      command: 'apply',
      confirmed: true,
      actorId: 'owner',
    });
  });

  it('reports mapped, blocked, conflict, and rebind-needed explicitly', () => {
    const report = formatProjectMappingReport({
      entries: [
        { legacyProjectPath: '/a', status: 'mapped', repositoryUrl: 'example.com/a', repositoryFingerprint: 'a', defaultBranch: 'main', projectId: 'p1', proposedProjectId: null, reason: 'ok', blockCode: null, localOnly: false, replay: false, identityMaterial: 'example.com/a\na\nmain' },
        { legacyProjectPath: '/b', status: 'blocked', repositoryUrl: null, repositoryFingerprint: null, defaultBranch: null, projectId: null, proposedProjectId: null, reason: 'not git', blockCode: 'not-git', localOnly: true, replay: false, identityMaterial: '' },
        { legacyProjectPath: '/c', status: 'conflict', repositoryUrl: 'example.com/c', repositoryFingerprint: 'c', defaultBranch: 'main', projectId: null, proposedProjectId: null, reason: 'conflict', blockCode: 'fingerprint-conflict', localOnly: true, replay: false, identityMaterial: 'example.com/c\nc\nmain' },
        { legacyProjectPath: '/d', status: 'rebind-needed', repositoryUrl: 'example.com/d', repositoryFingerprint: 'd', defaultBranch: 'main', projectId: 'old', proposedProjectId: 'new', reason: 'changed', blockCode: 'remote-changed', localOnly: true, replay: false, identityMaterial: 'example.com/d\nd\nmain' },
      ],
      summary: { mapped: 1, blocked: 1, conflict: 1, 'rebind-needed': 1 },
    });
    expect(report).toContain('| mapped | 1 |');
    expect(report).toContain('| blocked | 1 |');
    expect(report).toContain('| conflict | 1 |');
    expect(report).toContain('| rebind-needed | 1 |');
  });
});
