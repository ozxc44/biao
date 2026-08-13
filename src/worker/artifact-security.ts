import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 与平台 HTTP/计划层的 task id 合同一致。 */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function denied(message: string): Error {
  return new Error(`WORKER_ARTIFACT_PATH_DENIED: ${message}`);
}

export function isWorkerArtifactPathDenied(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('WORKER_ARTIFACT_PATH_DENIED:');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isContained(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function ensurePlainDirectory(path: string): void {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw denied(`${path} 必须是普通目录，不能是符号链接`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw mkdirError;
    }
    const created = lstatSync(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw denied(`${path} 在创建期间被替换为非普通目录`);
    }
  }
}

interface DirectoryIdentity {
  path: string;
  device: number;
  inode: number;
}

/**
 * 一次任务领取所绑定的本地产物能力。调用方只拿到工作目录；内部保留从可信
 * project 根到 task 目录的 inode 链，后续每次读、写、删都会重新验证。
 */
export interface WorkerArtifactContext {
  readonly workDir: string;
  readonly taskId?: string;
  readonly requestedProject?: string;
  readonly directoryChain: readonly DirectoryIdentity[];
  readonly mode: 'task' | 'standalone-claim-recovery';
}

const artifactContexts = new Map<string, WorkerArtifactContext>();

function directoryIdentity(workDir: string): DirectoryIdentity {
  const absolute = resolve(workDir);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw denied(`${absolute} 必须是普通任务目录`);
  }
  const canonical = realpathSync(absolute);
  return { path: canonical, device: entry.dev, inode: entry.ino };
}

function assertSameDirectory(identity: DirectoryIdentity): void {
  try {
    const current = directoryIdentity(identity.path);
    if (
      current.path !== identity.path ||
      current.device !== identity.device ||
      current.inode !== identity.inode
    ) {
      throw denied(`${identity.path} 在产物操作期间被替换`);
    }
  } catch (error) {
    if (isWorkerArtifactPathDenied(error)) throw error;
    throw denied(`${identity.path} 在产物操作期间不可验证`);
  }
}

function registerContext(context: WorkerArtifactContext, ...aliases: string[]): WorkerArtifactContext {
  artifactContexts.set(resolve(context.workDir), context);
  for (const alias of aliases) artifactContexts.set(resolve(alias), context);
  return context;
}

function assertContext(context: WorkerArtifactContext): WorkerArtifactContext {
  for (const identity of context.directoryChain) assertSameDirectory(identity);
  return context;
}

function contextFor(workDir: string | WorkerArtifactContext): WorkerArtifactContext {
  if (typeof workDir !== 'string') return assertContext(workDir);
  const context = artifactContexts.get(resolve(workDir));
  if (!context) {
    throw denied(`${resolve(workDir)} 尚未绑定可信 project/task 上下文`);
  }
  return assertContext(context);
}

function assertContextAllowsArtifact(context: WorkerArtifactContext, fileName: string): void {
  if (context.mode === 'standalone-claim-recovery' && fileName !== '.claim.json') {
    throw denied(`standalone crash-recovery 上下文无权操作 ${fileName}`);
  }
}

function canonicalAncestorChain(directory: string): DirectoryIdentity[] {
  const chain: DirectoryIdentity[] = [];
  let current = directoryIdentity(directory).path;
  while (true) {
    chain.unshift(directoryIdentity(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

function validateArtifactName(fileName: string): void {
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    basename(fileName) !== fileName ||
    !ARTIFACT_NAME_PATTERN.test(fileName)
  ) {
    throw denied(`非法产物文件名：${fileName}`);
  }
}

function assertSafeExistingTarget(target: string): void {
  try {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw denied(`${target} 必须是单链接普通文件`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * 创建并返回规范化的 `<project>/work/<taskId>`。
 * `work` 和任务目录都必须是普通目录；任何链接、穿越或非法 task id 都直接拒绝。
 */
export function secureTaskArtifactContext(projectPath: string, taskId: string): WorkerArtifactContext {
  if (!TASK_ID_PATTERN.test(taskId)) throw denied(`非法 task_id：${taskId}`);

  const requestedProject = resolve(projectPath);
  const requestedTaskDir = join(requestedProject, 'work', taskId);
  const bound = artifactContexts.get(resolve(requestedTaskDir));
  if (bound) {
    if (
      bound.mode !== 'task' ||
      bound.taskId !== taskId ||
      bound.requestedProject !== requestedProject
    ) {
      throw denied(`${requestedTaskDir} 已绑定到其它产物上下文`);
    }
    return assertContext(bound);
  }
  const canonicalProject = realpathSync(requestedProject);
  const projectIdentity = directoryIdentity(canonicalProject);

  const workRoot = join(canonicalProject, 'work');
  ensurePlainDirectory(workRoot);
  const taskDir = join(workRoot, taskId);
  ensurePlainDirectory(taskDir);

  const canonicalTaskDir = realpathSync(taskDir);
  if (canonicalTaskDir !== taskDir || !isContained(canonicalProject, canonicalTaskDir)) {
    throw denied(`${taskDir} 逃逸项目根或包含符号链接`);
  }
  const context: WorkerArtifactContext = {
    workDir: canonicalTaskDir,
    taskId,
    requestedProject,
    directoryChain: [projectIdentity, directoryIdentity(workRoot), directoryIdentity(canonicalTaskDir)],
    mode: 'task',
  };
  return registerContext(context, taskDir, requestedTaskDir);
}

export function secureTaskWorkDir(projectPath: string, taskId: string): string {
  return secureTaskArtifactContext(projectPath, taskId).workDir;
}

/** 把传入目录绑定到 task 的规范 project/work/task 身份。 */
export function assertSecureTaskArtifactContext(
  workDir: string,
  taskId: string,
  projectPath?: string,
): WorkerArtifactContext {
  const inferredProject = projectPath || dirname(dirname(resolve(workDir)));
  const expectedContext = secureTaskArtifactContext(inferredProject, taskId);
  const expected = expectedContext.workDir;
  let actual: string;
  try {
    actual = realpathSync(workDir);
  } catch {
    throw denied(`${workDir} 不是可用任务目录`);
  }
  if (actual !== expected) throw denied(`${workDir} 与任务 ${taskId} 的规范工作目录不一致`);
  return registerContext(expectedContext, workDir);
}

export function assertSecureTaskWorkDir(
  workDir: string,
  taskId: string,
  projectPath?: string,
): string {
  return assertSecureTaskArtifactContext(workDir, taskId, projectPath).workDir;
}

/**
 * 仅供旧 crash-recovery 夹具在独立临时目录写 claim。它不再是通用布尔逃生口，
 * 并绑定从文件系统根到该目录的完整 inode 链，祖先替换同样会 fail closed。
 */
export function secureStandaloneClaimRecoveryContext(workDir: string): WorkerArtifactContext {
  const bound = artifactContexts.get(resolve(workDir));
  if (bound) {
    if (bound.mode !== 'standalone-claim-recovery') {
      throw denied(`${resolve(workDir)} 已绑定到正式 task 上下文`);
    }
    return assertContext(bound);
  }
  const canonicalWorkDir = directoryIdentity(workDir).path;
  const context: WorkerArtifactContext = {
    workDir: canonicalWorkDir,
    directoryChain: canonicalAncestorChain(canonicalWorkDir),
    mode: 'standalone-claim-recovery',
  };
  return registerContext(context, workDir);
}

export function registeredWorkerArtifactContext(
  workDir: string,
  taskId?: string,
  projectPath?: string,
): WorkerArtifactContext {
  const context = contextFor(workDir);
  if (taskId !== undefined && (context.mode !== 'task' || context.taskId !== taskId)) {
    throw denied(`${resolve(workDir)} 未绑定任务 ${taskId}`);
  }
  if (
    projectPath !== undefined &&
    context.requestedProject !== undefined &&
    context.requestedProject !== resolve(projectPath)
  ) {
    throw denied(`${resolve(workDir)} 未绑定项目 ${resolve(projectPath)}`);
  }
  return context;
}

/**
 * 任务闭环后释放进程内的目录身份绑定，避免常驻 Worker/Supervisor 随任务数增长。
 * 只有 task/project 都与当前绑定完全一致时才删除；不匹配时保持原绑定并返回 false。
 */
export function releaseWorkerArtifactContext(
  workDir: string,
  taskId?: string,
  projectPath?: string,
): boolean {
  const context = artifactContexts.get(resolve(workDir));
  if (!context) return false;
  if (taskId !== undefined && (context.mode !== 'task' || context.taskId !== taskId)) return false;
  if (
    projectPath !== undefined &&
    context.requestedProject !== undefined &&
    context.requestedProject !== resolve(projectPath)
  ) {
    return false;
  }
  for (const [alias, registered] of artifactContexts) {
    if (registered === context) artifactContexts.delete(alias);
  }
  return true;
}

/**
 * 在已验证任务目录中使用 O_NOFOLLOW|O_EXCL 创建同目录临时文件，再原子 rename。
 * rename 前后都核对目录 inode；已有目标若是链接、目录或硬链接会 fail closed。
 */
export function atomicWriteWorkerArtifact(
  workDir: string | WorkerArtifactContext,
  fileName: string,
  contents: string,
): string {
  validateArtifactName(fileName);
  const context = contextFor(workDir);
  assertContextAllowsArtifact(context, fileName);
  const identity = context.directoryChain.at(-1)!;
  const target = join(identity.path, fileName);
  assertSafeExistingTarget(target);

  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  let temporaryIdentity: { device: number; inode: number } | undefined;
  try {
    fd = openSync(temporary, flags, 0o600);
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1) {
      throw denied(`${temporary} 不是独占普通临时文件`);
    }
    temporaryIdentity = { device: entry.dev, inode: entry.ino };
    closeSync(fd);
    fd = undefined;

    assertContext(context);
    assertSafeExistingTarget(target);
    renameSync(temporary, target);

    assertContext(context);
    const committed = lstatSync(target);
    if (
      committed.isSymbolicLink() ||
      !committed.isFile() ||
      committed.nlink !== 1 ||
      committed.dev !== temporaryIdentity.device ||
      committed.ino !== temporaryIdentity.inode
    ) {
      throw denied(`${target} 原子提交后身份不一致`);
    }
    return target;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已关闭则忽略 */ }
    }
    // 目录身份仍一致时才清理临时文件，避免路径被替换后误删外部文件。
    try {
      assertContext(context);
      const leftover = lstatSync(temporary);
      if (
        !leftover.isSymbolicLink() &&
        leftover.isFile() &&
        temporaryIdentity &&
        leftover.dev === temporaryIdentity.device &&
        leftover.ino === temporaryIdentity.inode
      ) {
        unlinkSync(temporary);
      }
    } catch {
      // rename 成功后临时路径不存在；路径身份异常时宁可保留不可达临时 inode。
    }
  }
}

/** 用 O_NOFOLLOW 读取已提交的普通产物，供 result.json 安全更新。 */
export function readWorkerArtifact(workDir: string | WorkerArtifactContext, fileName: string): string {
  validateArtifactName(fileName);
  const context = contextFor(workDir);
  assertContextAllowsArtifact(context, fileName);
  const identity = context.directoryChain.at(-1)!;
  const target = join(identity.path, fileName);
  assertSafeExistingTarget(target);
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink !== 1) throw denied(`${target} 不是安全普通文件`);
    const value = readFileSync(fd, 'utf8');
    assertContext(context);
    return value;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 只删除已验证目录中的单链接普通文件；链接或目录一律保留并拒绝。 */
export function unlinkWorkerArtifact(workDir: string | WorkerArtifactContext, fileName: string): void {
  validateArtifactName(fileName);
  const context = contextFor(workDir);
  assertContextAllowsArtifact(context, fileName);
  const identity = context.directoryChain.at(-1)!;
  const target = join(identity.path, fileName);
  try {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
      throw denied(`${target} 不是可安全删除的普通文件`);
    }
    assertContext(context);
    unlinkSync(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
