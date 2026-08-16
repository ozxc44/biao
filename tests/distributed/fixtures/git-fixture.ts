/**
 * Git Bare Remote fixture — Phase 0b
 *
 * 测试内创建 bare 仓库（git init --bare），提供 push/clone/ls-remote 辅助
 * 与"默认分支 CAS"断言工具。跨平台（macOS 本机 git）。
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export interface BareRemote {
  /** bare 仓库路径 */
  path: string;
  /** 默认分支名（通常是 main 或 master） */
  defaultBranch: string;
}

/**
 * 创建一个 bare Git 仓库，返回 BareRemote。
 */
export function createBareRemote(defaultBranch = 'main'): BareRemote {
  const dir = mkdtempSync(join(tmpdir(), 'biao-bare-'));
  tempDirs.push(dir);
  const barePath = join(dir, 'repo.git');
  execSync(`git init --bare -b ${defaultBranch} "${barePath}"`, { stdio: 'pipe' });
  return { path: barePath, defaultBranch };
}

/**
 * 克隆 bare 仓库到临时目录，返回 clone 路径。
 */
export function cloneBare(bare: BareRemote): string {
  const cloneDir = mkdtempSync(join(tmpdir(), 'biao-clone-'));
  tempDirs.push(cloneDir);
  const clonePath = join(cloneDir, 'repo');
  execSync(`git clone "${bare.path}" "${clonePath}"`, { stdio: 'pipe' });
  return clonePath;
}

/**
 * 在 clone 目录内执行 git 命令。
 */
export function gitExec(clonePath: string, args: string): string {
  return execSync(`git ${args}`, { cwd: clonePath, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/**
 * 在 clone 目录内创建一个 commit 并 push 到 origin。
 * 返回 commit SHA。
 */
export function commitAndPush(
  clonePath: string,
  filename: string,
  content: string,
  message = 'test commit',
): string {
  const filePath = join(clonePath, filename);
  execSync(`echo "${content}" > "${filePath}"`, { cwd: clonePath, stdio: 'pipe' });
  execSync(`git add "${filename}"`, { cwd: clonePath, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, {
    cwd: clonePath,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test' },
  });
  execSync('git push origin HEAD', { cwd: clonePath, stdio: 'pipe' });
  return gitExec(clonePath, 'rev-parse HEAD');
}

/**
 * 获取 bare remote 上某个 ref 的 SHA（ls-remote）。
 * 返回 SHA 或 null（ref 不存在）。
 */
export function lsRemoteSha(barePath: string, ref: string): string | null {
  try {
    const output = execSync(`git ls-remote "${barePath}" "${ref}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (!output) return null;
    // 输出格式: <sha>\t<ref>
    const sha = output.split('\t')[0];
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * 获取 bare remote 的默认分支 HEAD SHA。
 */
export function defaultBranchSha(bare: BareRemote): string | null {
  return lsRemoteSha(bare.path, `refs/heads/${bare.defaultBranch}`);
}

/**
 * CAS 断言：push 前后默认分支 SHA 应该变化（或首次 push 后存在）。
 */
export function assertCasUpdated(bare: BareRemote, beforeSha: string | null, afterSha: string | null): void {
  if (beforeSha === null) {
    // 首次 push，afterSha 必须存在
    if (afterSha === null) {
      throw new Error('CAS 断言失败：首次 push 后默认分支 SHA 仍为空');
    }
    return;
  }
  // 非首次 push，SHA 必须变化
  if (afterSha === beforeSha) {
    throw new Error(`CAS 断言失败：push 后 SHA 未变化（${beforeSha}）`);
  }
}

/**
 * 清理所有临时目录。
 */
export function cleanupGitFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
