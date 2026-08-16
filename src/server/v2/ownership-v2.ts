/**
 * V2 Ownership Snapshot 数据面（Phase 1）
 *
 * §7.1 Ownership V2 key 结构：project_id 命名空间 + revision/expires_at。
 * 本阶段交付 snapshot 写入/校验函数，claim 侧暂不接线（Phase 4）。
 */

import { createHash } from 'node:crypto';

export interface OwnershipSnapshot {
  snapshot_id: string;
  project_id: string;
  /** 持有者 attempt_id */
  holder_id: string;
  /** 文件 glob 模式列表 */
  write_globs: string[];
  /** 快照 revision（单调递增） */
  revision: number;
  /** 过期时间（毫秒时间戳） */
  expires_at: number;
  created_at: number;
}

export interface OwnershipSnapshotInput {
  project_id: string;
  holder_id: string;
  write_globs: string[];
  ttl_ms?: number;
}

/** 内存快照存储（Phase 1 最小实现；Phase 4 接入 Redis/SQLite） */
const snapshots = new Map<string, OwnershipSnapshot>();
let globalRevision = 0;

/**
 * 生成稳定的 snapshot_id：(project_id, holder_id, revision) 的确定性哈希。
 * §14.5 确定性键语义。
 */
function computeSnapshotId(projectId: string, holderId: string, revision: number): string {
  return createHash('sha256')
    .update(`${projectId}:${holderId}:${revision}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 写入 ownership snapshot。
 * §7.1：revision 单调递增，过期后自动失效。
 */
export function writeOwnershipSnapshot(input: OwnershipSnapshotInput): OwnershipSnapshot {
  const now = Date.now();
  globalRevision++;
  const snapshot: OwnershipSnapshot = {
    snapshot_id: computeSnapshotId(input.project_id, input.holder_id, globalRevision),
    project_id: input.project_id,
    holder_id: input.holder_id,
    write_globs: [...input.write_globs],
    revision: globalRevision,
    expires_at: now + (input.ttl_ms ?? 10 * 60 * 1000),
    created_at: now,
  };
  snapshots.set(snapshot.snapshot_id, snapshot);
  return snapshot;
}

/**
 * 校验 ownership snapshot：读快照比对 write_globs。
 * 返回 null 表示快照不存在或已过期。
 */
export function verifyOwnershipSnapshot(
  snapshotId: string,
  requiredGlobs: string[],
): { valid: boolean; snapshot: OwnershipSnapshot | null; reason?: string } {
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot) return { valid: false, snapshot: null, reason: 'SNAPSHOT_NOT_FOUND' };

  const now = Date.now();
  if (now >= snapshot.expires_at) {
    snapshots.delete(snapshotId);
    return { valid: false, snapshot: null, reason: 'SNAPSHOT_EXPIRED' };
  }

  // 检查 requiredGlobs 是否都在 write_globs 范围内
  for (const glob of requiredGlobs) {
    if (!snapshot.write_globs.includes(glob) && !snapshot.write_globs.includes('*')) {
      return { valid: false, snapshot, reason: 'GLOB_NOT_COVERED' };
    }
  }

  return { valid: true, snapshot };
}

/**
 * 获取项目当前最新的 ownership snapshot。
 */
export function getLatestOwnershipSnapshot(projectId: string): OwnershipSnapshot | null {
  let latest: OwnershipSnapshot | null = null;
  for (const snapshot of snapshots.values()) {
    if (snapshot.project_id !== projectId) continue;
    if (Date.now() >= snapshot.expires_at) continue;
    if (!latest || snapshot.revision > latest.revision) {
      latest = snapshot;
    }
  }
  return latest;
}

/**
 * 清除过期快照（惰性清理）。
 */
export function cleanupExpiredSnapshots(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, snapshot] of snapshots) {
    if (now >= snapshot.expires_at) {
      snapshots.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}

/** 重置内部状态（测试用） */
export function resetOwnershipSnapshots(): void {
  snapshots.clear();
  globalRevision = 0;
}
