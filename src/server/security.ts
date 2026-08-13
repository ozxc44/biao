import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface WorkspacePathDeniedError extends Error {
  code: 'WORKSPACE_PATH_DENIED';
}

function workspacePathDenied(message: string): WorkspacePathDeniedError {
  const error = new Error(message) as WorkspacePathDeniedError;
  error.code = 'WORKSPACE_PATH_DENIED';
  return error;
}

/**
 * Canonicalize the deepest existing ancestor, then append any not-yet-created tail.
 * `lstat` deliberately treats a broken symlink as an existing entry so `realpath`
 * fails closed instead of accepting a path whose target could appear later.
 */
function canonicalPotentialPath(input: string): string {
  let cursor = resolve(input);
  const missing: string[] = [];

  for (;;) {
    try {
      lstatSync(cursor);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw workspacePathDenied(`工作区路径无法检查：${cursor}`);
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw workspacePathDenied(`工作区路径没有可解析的祖先：${input}`);
      }
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }

  try {
    return resolve(realpathSync(cursor), ...missing);
  } catch {
    throw workspacePathDenied(`工作区路径包含无法解析的符号链接：${cursor}`);
  }
}

/** Parse the platform-delimited workspace allowlist into canonical absolute paths. */
export function parseWorkspaceRoots(raw?: string): string[] {
  if (!raw?.trim()) return [];

  const roots = raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.includes('\0')) {
        throw workspacePathDenied('工作区根目录不能包含 NUL 字符');
      }
      return resolve(entry);
    });

  return [...new Set(roots)];
}

/** Resolve a caller-supplied path and ensure it remains inside an allowed workspace root. */
export function resolveAndValidateWorkspacePath(input: string, roots: string[]): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw workspacePathDenied('工作区路径不能为空');
  }
  if (input.includes('\0')) {
    throw workspacePathDenied('工作区路径不能包含 NUL 字符');
  }

  const candidate = resolve(input.trim());
  if (roots.length === 0) return candidate;

  const canonicalCandidate = canonicalPotentialPath(candidate);

  const allowed = roots.some((rootInput) => {
    const root = canonicalPotentialPath(rootInput);
    const child = relative(root, canonicalCandidate);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  });

  if (!allowed) {
    throw workspacePathDenied(`路径不在允许的工作区内：${candidate}`);
  }
  return candidate;
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * 校验 Worker 结果产物只能来自当前任务自己的固定工作目录。
 *
 * 工作区 allowlist 只回答“这个项目能否被 Biao 使用”，不能充当任务间隔离边界；否则
 * task B 可把 task A 的 PASS 结果当成自己的产出。这里同时拒绝 work/task/file 任一层
 * 符号链接，并核对真实路径，避免 PM 查看结果时跟随链接读取项目外文件。
 */
export function resolveAndValidateTaskArtifactPath(
  input: string,
  projectPath: string,
  taskId: string,
  expectedName: 'result.md' | 'result.json',
): string {
  if (
    typeof taskId !== 'string' ||
    !taskId.trim() ||
    taskId === '.' ||
    taskId === '..' ||
    taskId.includes('\0') ||
    taskId.includes('/') ||
    taskId.includes('\\')
  ) {
    throw workspacePathDenied('task_id 无效，无法确定结果目录');
  }
  const project = resolveAndValidateWorkspacePath(projectPath, []);
  const workRoot = join(project, 'work');
  const taskRoot = resolve(workRoot, taskId);
  if (!isInside(workRoot, taskRoot)) {
    throw workspacePathDenied('task_id 越出项目 work 目录');
  }
  const candidate = resolveAndValidateWorkspacePath(input, []);
  const expected = join(taskRoot, expectedName);
  if (candidate !== expected) {
    throw workspacePathDenied(`结果文件必须是当前任务的 work/${taskId}/${expectedName}`);
  }
  if (!existsSync(candidate)) {
    throw workspacePathDenied(`结果文件不存在：work/${taskId}/${expectedName}`);
  }

  // 只检查项目内部由 Worker 可控的三个层级；项目根本身可能是管理员配置的合法挂载点。
  for (const path of [workRoot, taskRoot, candidate]) {
    if (!existsSync(path)) throw workspacePathDenied(`结果路径缺失：${path}`);
    if (lstatSync(path).isSymbolicLink()) {
      throw workspacePathDenied(`结果路径不能包含符号链接：${path}`);
    }
  }
  if (!statSync(candidate).isFile()) {
    throw workspacePathDenied(`结果产物不是普通文件：work/${taskId}/${expectedName}`);
  }

  const realProject = realpathSync(project);
  const realTaskRoot = join(realProject, 'work', taskId);
  const realCandidate = realpathSync(candidate);
  if (!isInside(realProject, realTaskRoot) || realCandidate !== join(realTaskRoot, expectedName)) {
    throw workspacePathDenied('结果文件真实路径越出当前任务目录');
  }
  // 避免被伪造的巨大结果拖垮 PM intake/review；正常 result 文件远小于此上限。
  if (statSync(candidate).size > 2 * 1024 * 1024) {
    throw workspacePathDenied(`结果文件过大：work/${taskId}/${expectedName}`);
  }
  return candidate;
}

/** 校验后以 O_NOFOLLOW 打开结果文件；调用点无需在校验后再次裸 readFileSync。 */
export function readValidatedTaskArtifact(
  input: string,
  projectPath: string,
  taskId: string,
  expectedName: 'result.md' | 'result.json',
): string {
  const candidate = resolveAndValidateTaskArtifactPath(input, projectPath, taskId, expectedName);
  let fd: number | undefined;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 2 * 1024 * 1024) {
      throw workspacePathDenied(`结果产物不是受控普通文件：work/${taskId}/${expectedName}`);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as WorkspacePathDeniedError).code === 'WORKSPACE_PATH_DENIED') throw error;
    throw workspacePathDenied(`结果文件读取失败：work/${taskId}/${expectedName}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
