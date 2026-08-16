/**
 * Artifact Store fixture — Phase 0b
 *
 * 临时内容寻址目录（sha256 命名）+ 上传/下载/manifest 校验辅助。
 * 对齐 §9.2/9.3：大小上限、路径穿越拒绝。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const tempDirs: string[] = [];

/** §9.3 结果文件上限 2 MiB；Agent log/Verify log 更高但有界 */
export const RESULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB
export const TOTAL_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

export interface ArtifactStore {
  /** 内容寻址存储根目录 */
  root: string;
}

export interface UploadResult {
  sha256: string;
  sizeBytes: number;
  storedPath: string;
}

export interface ArtifactManifest {
  artifacts: Array<{
    sha256: string;
    sizeBytes: number;
    kind: string;
  }>;
  totalBytes: number;
}

/**
 * 创建临时 Artifact Store。
 */
export function createArtifactStore(): ArtifactStore {
  const dir = mkdtempSync(join(tmpdir(), 'biao-artifact-'));
  tempDirs.push(dir);
  const root = join(dir, 'artifacts', 'sha256');
  mkdirSync(root, { recursive: true });
  return { root };
}

/**
 * 计算 SHA-256。
 */
export function sha256hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 上传内容到 Artifact Store。
 * §9.3：拒绝符号链接、设备文件、目录和路径穿越。
 * §9.2：小文件直接流式上传。
 */
export function uploadArtifact(
  store: ArtifactStore,
  content: Buffer,
  kind: string,
  options: { maxBytes?: number } = {},
): UploadResult {
  const maxBytes = options.maxBytes ?? RESULT_MAX_BYTES;
  if (content.length > maxBytes) {
    throw new Error(`Artifact 超限：${content.length} > ${maxBytes} bytes`);
  }

  const sha = sha256hex(content);
  const prefix = sha.slice(0, 2);
  const dir = join(store.root, prefix);
  mkdirSync(dir, { recursive: true });
  const storedPath = join(dir, sha);
  writeFileSync(storedPath, content);

  return { sha256: sha, sizeBytes: content.length, storedPath };
}

/**
 * 下载 Artifact 内容。
 */
export function downloadArtifact(store: ArtifactStore, sha256: string): Buffer {
  const prefix = sha256.slice(0, 2);
  const path = join(store.root, prefix, sha256);
  if (!existsSync(path)) {
    throw new Error(`Artifact 不存在：${sha256}`);
  }
  return readFileSync(path);
}

/**
 * §9.3 路径穿越拒绝：校验路径不能跳出 store.root。
 */
export function rejectPathTraversal(store: ArtifactStore, inputPath: string): void {
  const resolved = resolve(store.root, inputPath);
  const rel = relative(store.root, resolved);
  // 跳出 store.root 的路径（以 .. 开头）一律拒绝
  if (rel.startsWith('..')) {
    throw new Error(`路径穿越拒绝：${inputPath} 解析到 ${resolved}，超出 store root ${store.root}`);
  }
}

/**
 * 校验 manifest：所有 artifact 都存在于 store 中，且 SHA 匹配。
 */
export function validateManifest(store: ArtifactStore, manifest: ArtifactManifest): boolean {
  for (const art of manifest.artifacts) {
    const prefix = art.sha256.slice(0, 2);
    const path = join(store.root, prefix, art.sha256);
    if (!existsSync(path)) return false;
    const actual = statSync(path).size;
    if (actual !== art.sizeBytes) return false;
    // 重算 SHA 确认
    const content = readFileSync(path);
    if (sha256hex(content) !== art.sha256) return false;
  }
  return true;
}

/**
 * 清理所有临时 Artifact Store 目录。
 */
export function cleanupArtifactFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
