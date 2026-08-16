import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';

export type MappingStatus = 'mapped' | 'blocked' | 'conflict' | 'rebind-needed';

export type MappingBlockCode =
  | 'not-git'
  | 'git-unreadable'
  | 'missing-remote'
  | 'unsupported-remote'
  | 'default-branch-unresolved'
  | 'project-not-found'
  | 'fingerprint-conflict'
  | 'remote-changed';

export type GitInspection =
  | {
    kind: 'git';
    repositoryUrl: string;
    repositoryFingerprint: string;
    defaultBranch: string;
  }
  | {
    kind: 'blocked';
    code: Extract<MappingBlockCode,
      'not-git' | 'git-unreadable' | 'missing-remote' | 'unsupported-remote' | 'default-branch-unresolved'>;
    reason: string;
  };

export interface MappingEntry {
  legacyProjectPath: string;
  status: MappingStatus;
  repositoryUrl: string | null;
  repositoryFingerprint: string | null;
  defaultBranch: string | null;
  projectId: string | null;
  proposedProjectId: string | null;
  reason: string;
  blockCode: MappingBlockCode | null;
  localOnly: boolean;
  replay: boolean;
  /** Repository identity inputs only. The local path is deliberately excluded. */
  identityMaterial: string;
}

export interface ProjectMappingScan {
  entries: MappingEntry[];
  summary: Record<MappingStatus, number>;
}

export interface ProjectMappingApplyResult extends ProjectMappingScan {
  applied: number;
  skipped: number;
}

export interface ScanProjectMappingsOptions {
  inspectRepository?: (projectPath: string) => GitInspection;
}

export interface ApplyProjectMappingsOptions {
  confirmedBy: string;
  reason?: string;
  inspectRepository?: (projectPath: string) => GitInspection;
  now?: () => string;
}

export interface RebindProjectMappingOptions {
  legacyProjectPath: string;
  targetProjectId: string;
  expectedPreviousFingerprint: string;
  expectedNewFingerprint: string;
  actorId: string;
  reason: string;
  inspectRepository?: (projectPath: string) => GitInspection;
  now?: () => string;
}

export interface RollbackProjectRebindOptions {
  auditId: string;
  actorId: string;
  reason: string;
  inspectRepository?: (projectPath: string) => GitInspection;
  now?: () => string;
}

export interface BindingMutationResult {
  auditId: string;
  legacyProjectPath: string;
  projectId: string;
  repositoryFingerprint: string;
}

type ProjectRow = {
  project_id: string;
  repository_url: string;
  repository_fingerprint: string;
  default_branch: string;
};

type BindingRow = {
  legacy_project_path: string;
  project_id: string;
  repository_url: string;
  repository_fingerprint: string;
  default_branch: string;
  verified_at: string;
};

type AuditRow = {
  audit_id: string;
  legacy_project_path: string;
  action: string;
  old_project_id: string | null;
  new_project_id: string;
  old_repository_url: string | null;
  new_repository_url: string;
  old_repository_fingerprint: string | null;
  new_repository_fingerprint: string;
  old_default_branch: string | null;
  new_default_branch: string;
};

const EMPTY_SUMMARY = (): Record<MappingStatus, number> => ({
  mapped: 0,
  blocked: 0,
  conflict: 0,
  'rebind-needed': 0,
});

function trimRepositorySuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

/**
 * Produces a transport-independent remote identity (`host/path`). Credentials,
 * schemes, query strings, fragments, `.git`, and trailing slashes are excluded.
 */
export function normalizeRepositoryUrl(repositoryUrl: string): string {
  const value = repositoryUrl.trim();
  if (!value) throw new Error('repository URL is empty');
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error('repository URL must be a network Git remote');
  }

  const scp = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
  if (scp && !value.includes('://')) {
    const path = trimRepositorySuffix(scp[2]);
    if (!path) throw new Error('repository URL has no path');
    return `${scp[1].toLowerCase()}/${path.replace(/^\/+/, '')}`;
  }

  // Already-normalized identities are persisted in legacy bindings and are safe to replay.
  const identity = value.match(/^([^/]+)\/(.+)$/);
  if (identity && (identity[1].includes('.') || identity[1].startsWith('localhost'))) {
    const path = trimRepositorySuffix(identity[2]);
    if (!path) throw new Error('repository URL has no path');
    return `${identity[1].toLowerCase()}/${path}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('repository URL must be a network Git remote');
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('repository URL must use http, https, ssh, or git');
  }
  const path = trimRepositorySuffix(parsed.pathname).replace(/^\/+/, '');
  if (!path) throw new Error('repository URL has no path');
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.hostname.toLowerCase()}${port}/${path}`;
}

/** A remote fingerprint never incorporates the default branch or any local path. */
export function computeRemoteFingerprint(repositoryUrl: string): string {
  return createHash('sha256').update(normalizeRepositoryUrl(repositoryUrl), 'utf8').digest('hex');
}

function git(projectPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Reads Git identity without fetching or guessing a default branch. */
export function inspectGitRepository(projectPath: string): GitInspection {
  if (!existsSync(projectPath)) {
    return { kind: 'blocked', code: 'git-unreadable', reason: 'project path does not exist or is unreadable' };
  }

  try {
    if (git(projectPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      return { kind: 'blocked', code: 'not-git', reason: 'path is not a Git work tree' };
    }
  } catch {
    return { kind: 'blocked', code: 'not-git', reason: 'path is not a readable Git work tree' };
  }

  let remote: string;
  try {
    remote = git(projectPath, ['remote', 'get-url', 'origin']);
  } catch {
    return { kind: 'blocked', code: 'missing-remote', reason: 'Git origin remote is missing or unreadable' };
  }

  let repositoryUrl: string;
  try {
    repositoryUrl = normalizeRepositoryUrl(remote);
  } catch (error) {
    return {
      kind: 'blocked',
      code: 'unsupported-remote',
      reason: error instanceof Error ? error.message : 'unsupported Git remote',
    };
  }

  let defaultBranch = '';
  try {
    const symbolic = git(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    defaultBranch = symbolic.replace(/^origin\//, '');
  } catch {
    try {
      // An explicit offline override is allowed; the current branch is not a safe default-branch guess.
      defaultBranch = git(projectPath, ['config', '--get', 'biao.defaultBranch']);
    } catch {
      return {
        kind: 'blocked',
        code: 'default-branch-unresolved',
        reason: 'origin/HEAD is unavailable and biao.defaultBranch is not configured',
      };
    }
  }
  if (!defaultBranch) {
    return { kind: 'blocked', code: 'default-branch-unresolved', reason: 'default branch is empty' };
  }

  return {
    kind: 'git',
    repositoryUrl,
    repositoryFingerprint: createHash('sha256').update(repositoryUrl, 'utf8').digest('hex'),
    defaultBranch,
  };
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((item) => item.name === column);
}

function legacyProjectPaths(db: Database.Database): string[] {
  const paths = new Set<string>();
  for (const table of ['plans', 'tasks']) {
    if (!tableHasColumn(db, table, 'project_path')) continue;
    const rows = db.prepare(
      `SELECT DISTINCT project_path FROM ${table} WHERE project_path IS NOT NULL AND project_path != ''`,
    ).all() as Array<{ project_path: string }>;
    for (const row of rows) paths.add(row.project_path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right, 'en'));
}

function projects(db: Database.Database): ProjectRow[] {
  if (!tableExists(db, 'projects')) return [];
  const required = ['project_id', 'repository_url', 'repository_fingerprint', 'default_branch'];
  if (!required.every((column) => tableHasColumn(db, 'projects', column))) return [];
  return db.prepare(
    'SELECT project_id, repository_url, repository_fingerprint, default_branch FROM projects ORDER BY project_id',
  ).all() as ProjectRow[];
}

function bindings(db: Database.Database, projectRows: ProjectRow[] = []): BindingRow[] {
  if (!tableExists(db, 'legacy_project_bindings')) return [];
  const repositoryUrl = tableHasColumn(db, 'legacy_project_bindings', 'repository_url')
    ? 'repository_url'
    : "'' AS repository_url";
  const defaultBranch = tableHasColumn(db, 'legacy_project_bindings', 'default_branch')
    ? 'default_branch'
    : "'' AS default_branch";
  const rows = db.prepare(`
    SELECT legacy_project_path, project_id, ${repositoryUrl},
           repository_fingerprint, ${defaultBranch}, verified_at
    FROM legacy_project_bindings
    ORDER BY legacy_project_path
  `).all() as BindingRow[];
  const projectById = new Map(projectRows.map((project) => [project.project_id, project]));
  return rows.map((binding) => {
    const project = projectById.get(binding.project_id);
    return {
      ...binding,
      repository_url: binding.repository_url || project?.repository_url || '',
      default_branch: binding.default_branch || project?.default_branch || '',
    };
  });
}

type ProjectResolution =
  | { kind: 'mapped'; projectId: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'conflict'; reason: string };

function resolveProject(
  inspection: Extract<GitInspection, { kind: 'git' }>,
  projectRows: ProjectRow[],
  bindingRows: BindingRow[],
): ProjectResolution {
  const relevantProjects: Array<ProjectRow & { normalizedUrl: string; computedFingerprint: string }> = [];
  for (const project of projectRows) {
    let normalizedUrl: string;
    let computedFingerprint: string;
    try {
      normalizedUrl = normalizeRepositoryUrl(project.repository_url);
      computedFingerprint = computeRemoteFingerprint(project.repository_url);
    } catch {
      if (project.repository_fingerprint === inspection.repositoryFingerprint) {
        return { kind: 'conflict', reason: `Project ${project.project_id} has an invalid repository URL` };
      }
      continue;
    }
    if (normalizedUrl === inspection.repositoryUrl
      || project.repository_fingerprint === inspection.repositoryFingerprint) {
      relevantProjects.push({ ...project, normalizedUrl, computedFingerprint });
    }
  }

  if (relevantProjects.some((project) => project.computedFingerprint !== project.repository_fingerprint)) {
    return { kind: 'conflict', reason: 'Project registry repository fingerprint conflicts with its URL' };
  }

  const exactProjects = relevantProjects.filter((project) =>
    project.normalizedUrl === inspection.repositoryUrl
    && project.repository_fingerprint === inspection.repositoryFingerprint
    && project.default_branch === inspection.defaultBranch);
  const exactProjectIds = [...new Set(exactProjects.map((project) => project.project_id))];
  if (exactProjectIds.length > 1) {
    return { kind: 'conflict', reason: 'repository identity resolves to multiple V2 Projects' };
  }
  if (relevantProjects.length > 0 && exactProjectIds.length === 0) {
    return { kind: 'conflict', reason: 'repository URL, fingerprint, and default branch disagree' };
  }
  if (exactProjectIds.length === 1) return { kind: 'mapped', projectId: exactProjectIds[0] };

  // Existing explicit bindings may identify the Project when the registry is managed by a later V2 schema lane.
  const matchingBindings = bindingRows.filter((binding) => {
    try {
      return normalizeRepositoryUrl(binding.repository_url) === inspection.repositoryUrl
        && binding.repository_fingerprint === inspection.repositoryFingerprint
        && binding.default_branch === inspection.defaultBranch;
    } catch {
      return false;
    }
  });
  const bindingProjectIds = [...new Set(matchingBindings.map((binding) => binding.project_id))];
  if (bindingProjectIds.length > 1) {
    return { kind: 'conflict', reason: 'legacy bindings assign one fingerprint to multiple Projects' };
  }
  if (bindingProjectIds.length === 1) return { kind: 'mapped', projectId: bindingProjectIds[0] };
  return { kind: 'blocked', reason: 'no explicit V2 Project matches repository URL, fingerprint, and default branch' };
}

function identityMaterial(inspection: Extract<GitInspection, { kind: 'git' }>): string {
  return `${inspection.repositoryUrl}\n${inspection.repositoryFingerprint}\n${inspection.defaultBranch}`;
}

function blockedEntry(path: string, inspection: Extract<GitInspection, { kind: 'blocked' }>): MappingEntry {
  return {
    legacyProjectPath: path,
    status: 'blocked',
    repositoryUrl: null,
    repositoryFingerprint: null,
    defaultBranch: null,
    projectId: null,
    proposedProjectId: null,
    reason: inspection.reason,
    blockCode: inspection.code,
    localOnly: true,
    replay: false,
    identityMaterial: '',
  };
}

export function scanProjectMappings(
  db: Database.Database,
  options: ScanProjectMappingsOptions = {},
): ProjectMappingScan {
  const inspectRepository = options.inspectRepository ?? inspectGitRepository;
  const projectRows = projects(db);
  const bindingRows = bindings(db, projectRows);
  const bindingByPath = new Map(bindingRows.map((binding) => [binding.legacy_project_path, binding]));
  const entries: MappingEntry[] = [];

  for (const path of legacyProjectPaths(db)) {
    const inspection = inspectRepository(path);
    if (inspection.kind === 'blocked') {
      entries.push(blockedEntry(path, inspection));
      continue;
    }

    const material = identityMaterial(inspection);
    const existing = bindingByPath.get(path);
    const resolution = resolveProject(inspection, projectRows, bindingRows);
    if (existing) {
      let sameUrl = false;
      try {
        sameUrl = normalizeRepositoryUrl(existing.repository_url) === inspection.repositoryUrl;
      } catch {
        sameUrl = false;
      }
      const unchanged = sameUrl
        && existing.repository_fingerprint === inspection.repositoryFingerprint
        && existing.default_branch === inspection.defaultBranch;
      if (unchanged) {
        if (resolution.kind === 'conflict'
          || (resolution.kind === 'mapped' && resolution.projectId !== existing.project_id)) {
          entries.push({
            legacyProjectPath: path,
            status: 'conflict',
            repositoryUrl: inspection.repositoryUrl,
            repositoryFingerprint: inspection.repositoryFingerprint,
            defaultBranch: inspection.defaultBranch,
            projectId: null,
            proposedProjectId: null,
            reason: resolution.kind === 'conflict'
              ? resolution.reason
              : 'existing binding conflicts with the resolved V2 Project',
            blockCode: 'fingerprint-conflict',
            localOnly: true,
            replay: false,
            identityMaterial: material,
          });
        } else {
          entries.push({
            legacyProjectPath: path,
            status: 'mapped',
            repositoryUrl: inspection.repositoryUrl,
            repositoryFingerprint: inspection.repositoryFingerprint,
            defaultBranch: inspection.defaultBranch,
            projectId: existing.project_id,
            proposedProjectId: null,
            reason: 'replayed existing explicit binding',
            blockCode: null,
            localOnly: false,
            replay: true,
            identityMaterial: material,
          });
        }
        continue;
      }

      if (resolution.kind === 'conflict') {
        entries.push({
          legacyProjectPath: path,
          status: 'conflict',
          repositoryUrl: inspection.repositoryUrl,
          repositoryFingerprint: inspection.repositoryFingerprint,
          defaultBranch: inspection.defaultBranch,
          projectId: existing.project_id,
          proposedProjectId: null,
          reason: resolution.reason,
          blockCode: 'fingerprint-conflict',
          localOnly: true,
          replay: false,
          identityMaterial: material,
        });
      } else {
        entries.push({
          legacyProjectPath: path,
          status: 'rebind-needed',
          repositoryUrl: inspection.repositoryUrl,
          repositoryFingerprint: inspection.repositoryFingerprint,
          defaultBranch: inspection.defaultBranch,
          projectId: existing.project_id,
          proposedProjectId: resolution.kind === 'mapped' ? resolution.projectId : null,
          reason: 'Git remote identity changed; explicit rebind is required',
          blockCode: 'remote-changed',
          localOnly: true,
          replay: false,
          identityMaterial: material,
        });
      }
      continue;
    }

    if (resolution.kind === 'mapped') {
      entries.push({
        legacyProjectPath: path,
        status: 'mapped',
        repositoryUrl: inspection.repositoryUrl,
        repositoryFingerprint: inspection.repositoryFingerprint,
        defaultBranch: inspection.defaultBranch,
        projectId: resolution.projectId,
        proposedProjectId: null,
        reason: 'matched one explicit V2 Project',
        blockCode: null,
        localOnly: false,
        replay: false,
        identityMaterial: material,
      });
    } else {
      entries.push({
        legacyProjectPath: path,
        status: resolution.kind,
        repositoryUrl: inspection.repositoryUrl,
        repositoryFingerprint: inspection.repositoryFingerprint,
        defaultBranch: inspection.defaultBranch,
        projectId: null,
        proposedProjectId: null,
        reason: resolution.reason,
        blockCode: resolution.kind === 'conflict' ? 'fingerprint-conflict' : 'project-not-found',
        localOnly: true,
        replay: false,
        identityMaterial: material,
      });
    }
  }

  const summary = EMPTY_SUMMARY();
  for (const entry of entries) summary[entry.status] += 1;
  return { entries, summary };
}

function ensureBindingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_project_bindings (
      legacy_project_path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repository_url TEXT NOT NULL,
      repository_fingerprint TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_project_binding_identity
      ON legacy_project_bindings (legacy_project_path, repository_fingerprint);
    CREATE TABLE IF NOT EXISTS legacy_project_binding_audit (
      audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id TEXT NOT NULL UNIQUE,
      legacy_project_path TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('bind', 'rebind', 'rollback')),
      old_project_id TEXT,
      new_project_id TEXT NOT NULL,
      old_repository_url TEXT,
      new_repository_url TEXT NOT NULL,
      old_repository_fingerprint TEXT,
      new_repository_fingerprint TEXT NOT NULL,
      old_default_branch TEXT,
      new_default_branch TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      reverses_audit_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  if (!tableHasColumn(db, 'legacy_project_bindings', 'repository_url')) {
    db.exec("ALTER TABLE legacy_project_bindings ADD COLUMN repository_url TEXT NOT NULL DEFAULT ''");
  }
  if (!tableHasColumn(db, 'legacy_project_bindings', 'default_branch')) {
    db.exec("ALTER TABLE legacy_project_bindings ADD COLUMN default_branch TEXT NOT NULL DEFAULT ''");
  }
}

function insertAudit(
  db: Database.Database,
  values: {
    auditId: string;
    path: string;
    action: 'bind' | 'rebind' | 'rollback';
    oldBinding: BindingRow | null;
    newProjectId: string;
    newRepositoryUrl: string;
    newFingerprint: string;
    newDefaultBranch: string;
    actorId: string;
    reason: string;
    reversesAuditId?: string;
    createdAt: string;
  },
): void {
  db.prepare(`
    INSERT INTO legacy_project_binding_audit (
      audit_id, legacy_project_path, action,
      old_project_id, new_project_id,
      old_repository_url, new_repository_url,
      old_repository_fingerprint, new_repository_fingerprint,
      old_default_branch, new_default_branch,
      actor_id, reason, reverses_audit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.auditId,
    values.path,
    values.action,
    values.oldBinding?.project_id ?? null,
    values.newProjectId,
    values.oldBinding?.repository_url ?? null,
    values.newRepositoryUrl,
    values.oldBinding?.repository_fingerprint ?? null,
    values.newFingerprint,
    values.oldBinding?.default_branch ?? null,
    values.newDefaultBranch,
    values.actorId,
    values.reason,
    values.reversesAuditId ?? null,
    values.createdAt,
  );
}

export function applyProjectMappings(
  db: Database.Database,
  scan: ProjectMappingScan,
  options?: ApplyProjectMappingsOptions,
): ProjectMappingApplyResult {
  if (!options?.confirmedBy?.trim()) {
    throw new Error('apply requires explicit confirmation with confirmedBy');
  }
  const current = scanProjectMappings(db, { inspectRepository: options.inspectRepository });
  const currentByPath = new Map(current.entries.map((entry) => [entry.legacyProjectPath, entry]));
  for (const previewEntry of scan.entries) {
    if (previewEntry.status !== 'mapped' || previewEntry.replay) continue;
    const currentEntry = currentByPath.get(previewEntry.legacyProjectPath);
    if (!currentEntry
      || currentEntry.status !== 'mapped'
      || currentEntry.projectId !== previewEntry.projectId
      || currentEntry.identityMaterial !== previewEntry.identityMaterial) {
      throw new Error(`mapping changed after preview for ${previewEntry.legacyProjectPath}`);
    }
  }
  ensureBindingSchema(db);
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  let applied = 0;

  db.transaction(() => {
    const find = db.prepare('SELECT * FROM legacy_project_bindings WHERE legacy_project_path = ?');
    const insert = db.prepare(`
      INSERT INTO legacy_project_bindings (
        legacy_project_path, project_id, repository_url,
        repository_fingerprint, default_branch, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const entry of scan.entries) {
      if (entry.status !== 'mapped' || entry.replay) continue;
      if (!entry.projectId || !entry.repositoryUrl || !entry.repositoryFingerprint || !entry.defaultBranch) {
        throw new Error(`mapped entry for ${entry.legacyProjectPath} is incomplete`);
      }
      const existing = find.get(entry.legacyProjectPath) as BindingRow | undefined;
      if (existing) {
        if (existing.project_id === entry.projectId
          && existing.repository_fingerprint === entry.repositoryFingerprint
          && existing.default_branch === entry.defaultBranch) continue;
        throw new Error(`binding changed after preview for ${entry.legacyProjectPath}`);
      }
      insert.run(
        entry.legacyProjectPath,
        entry.projectId,
        entry.repositoryUrl,
        entry.repositoryFingerprint,
        entry.defaultBranch,
        createdAt,
      );
      insertAudit(db, {
        auditId: randomUUID(),
        path: entry.legacyProjectPath,
        action: 'bind',
        oldBinding: null,
        newProjectId: entry.projectId,
        newRepositoryUrl: entry.repositoryUrl,
        newFingerprint: entry.repositoryFingerprint,
        newDefaultBranch: entry.defaultBranch,
        actorId: options.confirmedBy,
        reason: options.reason ?? 'confirmed mapping preview',
        createdAt,
      });
      applied += 1;
    }
  })();

  return { ...scan, applied, skipped: scan.entries.length - applied };
}

function requireGitInspection(
  projectPath: string,
  inspectRepository: ((projectPath: string) => GitInspection) | undefined,
): Extract<GitInspection, { kind: 'git' }> {
  const inspection = (inspectRepository ?? inspectGitRepository)(projectPath);
  if (inspection.kind !== 'git') throw new Error(`Git identity is blocked: ${inspection.reason}`);
  return inspection;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`);
}

export function rebindProjectMapping(
  db: Database.Database,
  options: RebindProjectMappingOptions,
): BindingMutationResult {
  requireText(options.actorId, 'actorId');
  requireText(options.reason, 'reason');
  ensureBindingSchema(db);
  const previous = db.prepare(
    'SELECT * FROM legacy_project_bindings WHERE legacy_project_path = ?',
  ).get(options.legacyProjectPath) as BindingRow | undefined;
  if (!previous) throw new Error('existing binding not found');
  if (previous.repository_fingerprint !== options.expectedPreviousFingerprint) {
    throw new Error('previous fingerprint changed after confirmation');
  }

  const inspection = requireGitInspection(options.legacyProjectPath, options.inspectRepository);
  if (inspection.repositoryFingerprint !== options.expectedNewFingerprint) {
    throw new Error('new fingerprint does not match current Git identity');
  }
  const resolution = resolveProject(inspection, projects(db), bindings(db));
  if (resolution.kind !== 'mapped' || resolution.projectId !== options.targetProjectId) {
    throw new Error(resolution.kind === 'conflict'
      ? `target Project conflict: ${resolution.reason}`
      : 'target Project does not exactly match current Git identity');
  }

  const auditId = randomUUID();
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE legacy_project_bindings
      SET project_id = ?, repository_url = ?, repository_fingerprint = ?,
          default_branch = ?, verified_at = ?
      WHERE legacy_project_path = ? AND repository_fingerprint = ?
    `).run(
      options.targetProjectId,
      inspection.repositoryUrl,
      inspection.repositoryFingerprint,
      inspection.defaultBranch,
      createdAt,
      options.legacyProjectPath,
      options.expectedPreviousFingerprint,
    );
    if (updated.changes !== 1) throw new Error('binding changed concurrently during rebind');
    insertAudit(db, {
      auditId,
      path: options.legacyProjectPath,
      action: 'rebind',
      oldBinding: previous,
      newProjectId: options.targetProjectId,
      newRepositoryUrl: inspection.repositoryUrl,
      newFingerprint: inspection.repositoryFingerprint,
      newDefaultBranch: inspection.defaultBranch,
      actorId: options.actorId,
      reason: options.reason,
      createdAt,
    });
  })();
  return {
    auditId,
    legacyProjectPath: options.legacyProjectPath,
    projectId: options.targetProjectId,
    repositoryFingerprint: inspection.repositoryFingerprint,
  };
}

export function rollbackProjectRebind(
  db: Database.Database,
  options: RollbackProjectRebindOptions,
): BindingMutationResult {
  requireText(options.actorId, 'actorId');
  requireText(options.reason, 'reason');
  ensureBindingSchema(db);
  const audit = db.prepare(
    "SELECT * FROM legacy_project_binding_audit WHERE audit_id = ? AND action = 'rebind'",
  ).get(options.auditId) as AuditRow | undefined;
  if (!audit || !audit.old_project_id || !audit.old_repository_url
    || !audit.old_repository_fingerprint || !audit.old_default_branch) {
    throw new Error('rebind audit record is not rollback-capable');
  }
  const oldProjectId = audit.old_project_id;
  const current = db.prepare(
    'SELECT * FROM legacy_project_bindings WHERE legacy_project_path = ?',
  ).get(audit.legacy_project_path) as BindingRow | undefined;
  if (!current
    || current.project_id !== audit.new_project_id
    || current.repository_fingerprint !== audit.new_repository_fingerprint) {
    throw new Error('current binding no longer matches the rebind audit record');
  }

  const inspection = requireGitInspection(audit.legacy_project_path, options.inspectRepository);
  if (inspection.repositoryFingerprint !== audit.old_repository_fingerprint
    || inspection.repositoryUrl !== normalizeRepositoryUrl(audit.old_repository_url)
    || inspection.defaultBranch !== audit.old_default_branch) {
    throw new Error('Git identity must match the prior audited identity before rollback');
  }
  const oldProject = projects(db).find((project) => project.project_id === oldProjectId);
  if (oldProject) {
    const validOldProject = normalizeRepositoryUrl(oldProject.repository_url) === inspection.repositoryUrl
      && oldProject.repository_fingerprint === inspection.repositoryFingerprint
      && oldProject.default_branch === inspection.defaultBranch;
    if (!validOldProject) throw new Error('prior Project no longer matches the audited Git identity');
  }

  const rollbackAuditId = randomUUID();
  const createdAt = (options.now ?? (() => new Date().toISOString()))();
  db.transaction(() => {
    const updated = db.prepare(`
      UPDATE legacy_project_bindings
      SET project_id = ?, repository_url = ?, repository_fingerprint = ?,
          default_branch = ?, verified_at = ?
      WHERE legacy_project_path = ? AND project_id = ? AND repository_fingerprint = ?
    `).run(
      oldProjectId,
      inspection.repositoryUrl,
      inspection.repositoryFingerprint,
      inspection.defaultBranch,
      createdAt,
      audit.legacy_project_path,
      audit.new_project_id,
      audit.new_repository_fingerprint,
    );
    if (updated.changes !== 1) throw new Error('binding changed concurrently during rollback');
    insertAudit(db, {
      auditId: rollbackAuditId,
      path: audit.legacy_project_path,
      action: 'rollback',
      oldBinding: current,
      newProjectId: oldProjectId,
      newRepositoryUrl: inspection.repositoryUrl,
      newFingerprint: inspection.repositoryFingerprint,
      newDefaultBranch: inspection.defaultBranch,
      actorId: options.actorId,
      reason: options.reason,
      reversesAuditId: options.auditId,
      createdAt,
    });
  })();
  return {
    auditId: rollbackAuditId,
    legacyProjectPath: audit.legacy_project_path,
    projectId: oldProjectId,
    repositoryFingerprint: inspection.repositoryFingerprint,
  };
}

export function formatProjectMappingReport(result: ProjectMappingScan): string {
  const lines = [
    '# V1 → V2 Project mapping report',
    '',
    '| status | count |',
    '|---|---:|',
    `| mapped | ${result.summary.mapped} |`,
    `| blocked | ${result.summary.blocked} |`,
    `| conflict | ${result.summary.conflict} |`,
    `| rebind-needed | ${result.summary['rebind-needed']} |`,
    '',
  ];
  for (const entry of result.entries) {
    lines.push(`## ${entry.status}: ${entry.legacyProjectPath}`);
    lines.push(`- reason: ${entry.reason}`);
    lines.push(`- local-only: ${entry.localOnly ? 'yes' : 'no'}`);
    if (entry.projectId) lines.push(`- project-id: ${entry.projectId}`);
    if (entry.proposedProjectId) lines.push(`- proposed-project-id: ${entry.proposedProjectId}`);
    if (entry.repositoryUrl) lines.push(`- repository: ${entry.repositoryUrl}`);
    if (entry.repositoryFingerprint) lines.push(`- remote-fingerprint: ${entry.repositoryFingerprint}`);
    if (entry.defaultBranch) lines.push(`- default-branch: ${entry.defaultBranch}`);
    lines.push('');
  }
  return lines.join('\n');
}
