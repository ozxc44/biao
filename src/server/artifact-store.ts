/**
 * 内容寻址 Artifact 存储引擎（Phase 2）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §9.1/§9.2/§9.3。
 * - 存储根：BIAO_ARTIFACT_ROOT（默认 <dataDir>/artifacts）
 * - sha256 扇形目录布局：<root>/sha256/<prefix>/<digest>
 * - 三段式上传：initiate → upload（分片） → complete（校验落盘）
 * - 拒绝符号链接、路径穿越、超限
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import type { SqliteStore } from '../db/sqlite-store.js';
import type {
  ArtifactRow,
  ArtifactUploadSessionRow,
} from '../types/v2-artifact.js';
import {
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_LOG_MAX_BYTES,
  ARTIFACT_TOTAL_MAX_BYTES,
} from '../types/v2-artifact.js';
import { randomBytes } from 'node:crypto';

/** §9.3 按 kind 决定大小上限 */
function maxSizeForKind(kind: string): number {
  switch (kind) {
    case 'result-md':
    case 'result-json':
    case 'patch':
      return ARTIFACT_RESULT_MAX_BYTES;
    case 'agent-log':
    case 'verify-log':
      return ARTIFACT_LOG_MAX_BYTES;
    case 'recovery-bundle':
      return ARTIFACT_TOTAL_MAX_BYTES;
    default:
      return ARTIFACT_RESULT_MAX_BYTES;
  }
}

export interface ArtifactStoreOptions {
  root: string;
  store: SqliteStore;
  now?: () => number;
  tempUploadTtlHours?: number;
}

export class ArtifactStoreEngine {
  private readonly root: string;
  private readonly store: SqliteStore;
  private readonly now: () => number;
  private readonly tempUploadTtlMs: number;

  constructor(options: ArtifactStoreOptions) {
    this.root = resolve(options.root);
    mkdirSync(join(this.root, 'sha256'), { recursive: true });
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.tempUploadTtlMs = (options.tempUploadTtlHours ?? 24) * 60 * 60 * 1000;
  }

  /** §9.3 路径穿越校验 */
  private assertNoTraversal(inputPath: string): void {
    const resolved = resolve(this.root, inputPath);
    const rel = relative(this.root, resolved);
    if (rel.startsWith('..') || rel === '..') {
      throw new Error(`路径穿越拒绝：${inputPath}`);
    }
  }

  /** 计算 sha256 hex */
  static sha256hex(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /** 获取 blob 文件路径 */
  private blobPath(sha256: string): string {
    const prefix = sha256.slice(0, 2);
    return join(this.root, 'sha256', prefix, sha256);
  }

  /**
   * §9.2 initiate：创建上传会话。
   * 校验 size 不超过 kind 上限，声明 sha256 格式正确。
   */
  initiate(params: {
    attempt_id: string;
    task_id: string;
    project_id: string;
    kind: string;
    size_bytes: number;
    sha256: string;
  }): { artifact_id: string; upload_id: string } {
    if (!/^[a-f0-9]{64}$/.test(params.sha256)) {
      throw new Error('sha256 格式非法：需要 64 位小写 hex');
    }
    const maxBytes = maxSizeForKind(params.kind);
    if (params.size_bytes > maxBytes) {
      throw new Error(`Artifact 超限：声明 ${params.size_bytes} > ${maxBytes} bytes（kind=${params.kind}）`);
    }

    // 幂等：同 sha256 + attempt 直接返回已存在
    const existing = this.store.getArtifactBySha256(params.sha256);
    if (existing && existing.attempt_id === params.attempt_id) {
      return { artifact_id: existing.artifact_id, upload_id: `up-${existing.artifact_id}` };
    }

    const artifactId = `art-${randomBytes(8).toString('hex')}`;
    const uploadId = `up-${randomBytes(8).toString('hex')}`;
    const now = this.now();

    const artifactRow: ArtifactRow = {
      artifact_id: artifactId,
      project_id: params.project_id,
      task_id: params.task_id,
      attempt_id: params.attempt_id,
      kind: params.kind,
      sha256: params.sha256,
      size_bytes: params.size_bytes,
      media_type: 'application/octet-stream',
      storage_key: `sha256/${params.sha256.slice(0, 2)}/${params.sha256}`,
      status: 'uploading',
      created_at: now,
      retention_until: null,
    };

    const sessionRow: ArtifactUploadSessionRow = {
      upload_id: uploadId,
      artifact_id: artifactId,
      attempt_id: params.attempt_id,
      task_id: params.task_id,
      project_id: params.project_id,
      kind: params.kind,
      sha256: params.sha256,
      size_bytes: params.size_bytes,
      received_bytes: 0,
      chunk_sha256s: '[]',
      status: 'pending',
      created_at: now,
      expires_at: now + this.tempUploadTtlMs,
    };

    this.store.insertArtifact(artifactRow);
    this.store.insertUploadSession(sessionRow);

    return { artifact_id: artifactId, upload_id: uploadId };
  }

  /**
   * §9.2 upload：接收分片。
   * 乱序可收，服务端累计摘要。
   */
  async uploadChunk(uploadId: string, chunk: Buffer, chunkIndex: number): Promise<{ received_bytes: number }> {
    const session = this.store.getUploadSession(uploadId);
    if (!session) throw new Error(`上传会话不存在：${uploadId}`);
    if (session.status !== 'pending') throw new Error(`上传会话已非 pending：${session.status}`);

    // 写入临时文件
    const tmpDir = join(this.root, 'tmp', uploadId);
    mkdirSync(tmpDir, { recursive: true });
    const chunkPath = join(tmpDir, `chunk-${chunkIndex.toString().padStart(6, '0')}`);
    const chunkHash = ArtifactStoreEngine.sha256hex(chunk);

    // §9.3 累计校验不超限
    const newReceived = session.received_bytes + chunk.length;
    if (newReceived > session.size_bytes) {
      throw new Error(`累计接收 ${newReceived} 超过声明大小 ${session.size_bytes}`);
    }

    writeFileSync(chunkPath, chunk);

    // 更新 chunk 摘要列表
    const chunks: string[] = JSON.parse(session.chunk_sha256s);
    chunks[chunkIndex] = chunkHash;
    this.store.updateUploadSessionProgress(uploadId, newReceived, JSON.stringify(chunks));

    return { received_bytes: newReceived };
  }

  /**
   * §9.2 complete：终摘要校验、落 blob 文件、写元数据。
   * 幂等：同 sha256 重传直接返回已存在。
   */
  async complete(uploadId: string): Promise<{ artifact_id: string; sha256: string; size_bytes: number }> {
    const session = this.store.getUploadSession(uploadId);
    if (!session) throw new Error(`上传会话不存在：${uploadId}`);
    if (session.status !== 'pending') {
      if (session.status === 'completed') {
        return {
          artifact_id: session.artifact_id,
          sha256: session.sha256,
          size_bytes: session.size_bytes,
        };
      }
      throw new Error(`上传会话已非 pending：${session.status}`);
    }

    // 合并分片、计算实际 sha256
    const tmpDir = join(this.root, 'tmp', uploadId);
    const chunks: string[] = JSON.parse(session.chunk_sha256s);
    const hash = createHash('sha256');
    const allChunks: Buffer[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = join(tmpDir, `chunk-${i.toString().padStart(6, '0')}`);
      if (!existsSync(chunkPath)) {
        throw new Error(`分片 ${i} 缺失`);
      }
      const data = readFileSync(chunkPath);
      // 校验每个分片摘要
      const actualHash = ArtifactStoreEngine.sha256hex(data);
      if (actualHash !== chunks[i]) {
        throw new Error(`分片 ${i} 摘要不符：期望 ${chunks[i]}，实际 ${actualHash}`);
      }
      hash.update(data);
      allChunks.push(data);
    }

    const actualSha256 = hash.digest('hex');
    const actualSize = allChunks.reduce((sum, buf) => sum + buf.length, 0);

    // 校验最终摘要
    if (actualSha256 !== session.sha256) {
      // 篡改拒绝：清理临时文件，不残留 blob
      rmSync(tmpDir, { recursive: true, force: true });
      this.store.updateArtifactStatus(session.artifact_id, 'rejected');
      throw new Error(`SHA-256 不符：声明 ${session.sha256}，实际 ${actualSha256}`);
    }
    if (actualSize !== session.size_bytes) {
      rmSync(tmpDir, { recursive: true, force: true });
      this.store.updateArtifactStatus(session.artifact_id, 'rejected');
      throw new Error(`大小不符：声明 ${session.size_bytes}，实际 ${actualSize}`);
    }

    // 落盘到内容寻址目录
    const blobPath = this.blobPath(actualSha256);
    if (!existsSync(blobPath)) {
      mkdirSync(dirname(blobPath), { recursive: true });
      const merged = Buffer.concat(allChunks);
      writeFileSync(blobPath, merged);
    }

    // 更新元数据
    this.store.updateArtifactStatus(session.artifact_id, 'complete');
    this.store.upsertArtifactBlob(actualSha256, actualSize);
    this.store.completeUploadSession(uploadId);

    // 清理临时文件
    rmSync(tmpDir, { recursive: true, force: true });

    return {
      artifact_id: session.artifact_id,
      sha256: actualSha256,
      size_bytes: actualSize,
    };
  }

  /**
   * §9.2 read：按 sha256 流式读取。
   * 校验 project/task 归属。
   */
  readBySha256(sha256: string, readerProjectId: string, readerTaskId?: string): {
    stream: NodeJS.ReadableStream;
    size: number;
    artifact: ArtifactRow;
  } {
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('sha256 格式非法');
    }

    const artifact = this.store.getArtifactBySha256(sha256);
    if (!artifact) throw new Error(`Artifact 不存在：${sha256}`);
    if (artifact.status !== 'complete') throw new Error(`Artifact 未完成：${artifact.status}`);

    // §9.3 跨任务引用拒绝
    if (artifact.project_id !== readerProjectId) {
      throw new Error(`跨项目引用拒绝：artifact 属于 ${artifact.project_id}，请求者 ${readerProjectId}`);
    }
    if (readerTaskId && artifact.task_id !== readerTaskId) {
      throw new Error(`跨任务引用拒绝：artifact 属于 task ${artifact.task_id}，请求者 ${readerTaskId}`);
    }

    const path = this.blobPath(sha256);
    if (!existsSync(path)) {
      throw new Error(`blob 文件缺失：${sha256}`);
    }

    const stat = statSync(path);
    const stream = createReadStream(path);

    return { stream, size: stat.size, artifact };
  }

  /** 获取 artifact 元数据（不含 blob 流） */
  getArtifactMeta(artifactId: string): ArtifactRow | undefined {
    return this.store.getArtifact(artifactId);
  }

  /** 按 sha256 获取完整 artifact 元数据 */
  getArtifactBySha256(sha256: string): ArtifactRow | undefined {
    return this.store.getArtifactBySha256(sha256);
  }

  /** 清理过期临时上传 */
  cleanupExpiredUploads(): number {
    return this.store.expireStaleUploadSessions(this.now());
  }

  /** GC：标记零引用 blob */
  gcMarkZeroRef(): number {
    const blobs = this.store.listZeroRefBlobs();
    let marked = 0;
    for (const blob of blobs) {
      const path = this.blobPath(blob.sha256);
      if (existsSync(path)) {
        // 标记但不立即删除（两轮 GC：标记→清除）
        writeFileSync(path + '.gc-mark', '');
        marked++;
      }
    }
    return marked;
  }

  /** GC：清除已标记且过保留期的零引用 blob */
  gcSweep(): number {
    const blobs = this.store.listZeroRefBlobs();
    let swept = 0;
    for (const blob of blobs) {
      const markPath = this.blobPath(blob.sha256) + '.gc-mark';
      if (existsSync(markPath)) {
        const blobPath = this.blobPath(blob.sha256);
        unlinkSync(blobPath);
        unlinkSync(markPath);
        this.store.deleteArtifactBlob(blob.sha256, blob.size_bytes);
        swept++;
      }
    }
    return swept;
  }
}
