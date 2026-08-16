/**
 * V2 Artifact Service（Phase 2）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §15.4。
 * - initiate / upload / complete / read 四段接口
 * - Report V2 with artifact refs
 * - PM Review V2（只读 delivery + artifact manifest）
 */

import type { SqliteStore } from '../../db/sqlite-store.js';
import type { ArtifactStoreEngine } from '../artifact-store.js';
import type {
  ArtifactInitiateRequest,
  ArtifactInitiateResponse,
  ArtifactCompleteResponse,
  ArtifactMetaResponse,
  DeliveryRow,
} from '../../types/v2-artifact.js';
import type { ApiResponse } from '../../types/index.js';
import { randomBytes } from 'node:crypto';

export interface ArtifactServiceOptions {
  store: SqliteStore;
  artifactEngine: ArtifactStoreEngine;
}

/**
 * 创建 Artifact Service。
 * 对齐 domain-interfaces.ts 的 DeliveryService 中 Artifact 面。
 */
export function createArtifactService(options: ArtifactServiceOptions) {
  const { store, artifactEngine } = options;

  return {
    /**
     * §9.2 initiate：声明 artifact 并创建上传会话。
     */
    initiateArtifact(
      attemptId: string,
      input: { kind: string; size_bytes: number; sha256: string },
      meta: { actor: { actor_id: string; actor_kind: string }; idempotency_key: string; correlation_id: string },
    ): ApiResponse<ArtifactInitiateResponse> {
      // 需要从 attempt 推导 task_id 和 project_id
      // Phase 2 最小：尝试从 attempt 找到关联的 task/project
      const taskRow = store.getTaskByAttemptId?.(attemptId);
      const taskId = taskRow?.task_id ?? attemptId;
      const projectId = taskRow?.project_id ?? '';

      try {
        const result = artifactEngine.initiate({
          attempt_id: attemptId,
          task_id: taskId,
          project_id: projectId,
          kind: input.kind,
          size_bytes: input.size_bytes,
          sha256: input.sha256,
        });
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, data: null, error: { code: 'ARTIFACT_INITIATE_FAILED', message: (err as Error).message } };
      }
    },

    /**
     * §9.2 upload：接收分片内容。
     */
    async uploadArtifactContent(
      artifactId: string,
      chunk: Buffer,
      chunkIndex: number,
    ): Promise<ApiResponse<{ received_bytes: number }>> {
      // 通过 artifactId 找到 upload session
      const artifact = store.getArtifact(artifactId);
      if (!artifact) {
        return { ok: false, data: null, error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact ${artifactId} 不存在` } };
      }

      // 查找关联的 upload session
      const sessions = store.getUploadSessionsByArtifact?.(artifactId) ?? [];
      const session = sessions.find((s) => s.status === 'pending');
      if (!session) {
        return { ok: false, data: null, error: { code: 'UPLOAD_SESSION_NOT_FOUND', message: '无活跃上传会话' } };
      }

      try {
        const result = await artifactEngine.uploadChunk(session.upload_id, chunk, chunkIndex);
        return { ok: true, data: result };
      } catch (err) {
        return { ok: false, data: null, error: { code: 'UPLOAD_FAILED', message: (err as Error).message } };
      }
    },

    /**
     * §9.2 complete：终校验并落盘。
     */
    async completeArtifact(
      artifactId: string,
    ): Promise<ApiResponse<ArtifactCompleteResponse>> {
      const artifact = store.getArtifact(artifactId);
      if (!artifact) {
        return { ok: false, data: null, error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact ${artifactId} 不存在` } };
      }

      const sessions = store.getUploadSessionsByArtifact?.(artifactId) ?? [];
      const session = sessions.find((s) => s.status === 'pending' || s.status === 'completed');
      if (!session) {
        return { ok: false, data: null, error: { code: 'UPLOAD_SESSION_NOT_FOUND', message: '无上传会话' } };
      }

      try {
        const result = await artifactEngine.complete(session.upload_id);
        return {
          ok: true,
          data: {
            artifact_id: result.artifact_id,
            sha256: result.sha256,
            size_bytes: result.size_bytes,
            status: 'complete',
          },
        };
      } catch (err) {
        return { ok: false, data: null, error: { code: 'COMPLETE_FAILED', message: (err as Error).message } };
      }
    },

    /**
     * §15.4 GET：读取 artifact 元数据。
     */
    getArtifact(
      artifactId: string,
      readerProjectId: string,
    ): ApiResponse<ArtifactMetaResponse | null> {
      const artifact = store.getArtifact(artifactId);
      if (!artifact) {
        return { ok: true, data: null };
      }

      // §9.3 跨项目引用拒绝
      if (artifact.project_id !== readerProjectId) {
        return { ok: false, data: null, error: { code: 'CROSS_PROJECT_DENIED', message: '跨项目引用拒绝' } };
      }

      return {
        ok: true,
        data: {
          artifact_id: artifact.artifact_id,
          project_id: artifact.project_id,
          task_id: artifact.task_id,
          attempt_id: artifact.attempt_id,
          kind: artifact.kind,
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          status: artifact.status,
          created_at: artifact.created_at,
        },
      };
    },
  };
}

/**
 * Report V2：Attempt 上报时引用 artifact sha256 清单。
 * §9.2 第 7 条：Report/Delivery 只能引用 completed Artifact。
 */
export function reportV2WithArtifacts(
  store: SqliteStore,
  attemptId: string,
  input: {
    status: string;
    artifact_refs?: Array<{ artifact_id: string; sha256: string }>;
  },
): ApiResponse<{ attempt_id: string; status: string; delivery_id?: string }> {
  // 校验所有引用的 artifact 存在且 complete
  if (input.artifact_refs) {
    for (const ref of input.artifact_refs) {
      const artifact = store.getArtifact(ref.artifact_id);
      if (!artifact) {
        return { ok: false, data: null, error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact ${ref.artifact_id} 不存在` } };
      }
      if (artifact.status !== 'complete') {
        return { ok: false, data: null, error: { code: 'ARTIFACT_NOT_COMPLETE', message: `Artifact ${ref.artifact_id} 未完成` } };
      }
      if (artifact.sha256 !== ref.sha256) {
        return { ok: false, data: null, error: { code: 'ARTIFACT_SHA_MISMATCH', message: `Artifact ${ref.artifact_id} SHA 不符` } };
      }
    }
  }

  // 创建 delivery 记录雏形
  const deliveryId = `del-${randomBytes(8).toString('hex')}`;
  const now = Date.now();

  // 获取 attempt 关联的 task/project
  const taskRow = store.getTaskByAttemptId?.(attemptId);
  const taskId = taskRow?.task_id ?? attemptId;
  const projectId = taskRow?.project_id ?? '';

  const deliveryRow: DeliveryRow = {
    delivery_id: deliveryId,
    task_id: taskId,
    attempt_id: attemptId,
    project_id: projectId,
    base_sha: '',
    head_sha: '',
    tree_sha: '',
    branch_ref: '',
    changed_files: '[]',
    patch_digest: '',
    artifact_ids: JSON.stringify(input.artifact_refs?.map((r) => r.artifact_id) ?? []),
    verify_manifest_digest: '',
    status: 'proposed',
    accepted_commit_sha: '',
    merged_commit_sha: '',
    invalidated_reason: '',
    created_at: now,
    updated_at: now,
  };

  store.insertDelivery(deliveryRow);

  return {
    ok: true,
    data: {
      attempt_id: attemptId,
      status: input.status,
      delivery_id: deliveryId,
    },
  };
}

/**
 * PM Review V2 只读：读 delivery + artifact manifest 摘要。
 * §21 Phase 2 验收：服务端无 Worker 文件挂载仍可完整 Review。
 */
export function getDeliveryReviewView(
  store: SqliteStore,
  deliveryId: string,
): ApiResponse<{
  delivery: DeliveryRow;
  artifacts: Array<{
    artifact_id: string;
    sha256: string;
    size_bytes: number;
    kind: string;
    status: string;
  }>;
} | null> {
  const delivery = store.getDelivery(deliveryId);
  if (!delivery) {
    return { ok: true, data: null };
  }

  const artifactIds: string[] = JSON.parse(delivery.artifact_ids);
  const artifacts = artifactIds.map((id) => {
    const art = store.getArtifact(id);
    if (!art) return null;
    return {
      artifact_id: art.artifact_id,
      sha256: art.sha256,
      size_bytes: art.size_bytes,
      kind: art.kind,
      status: art.status,
    };
  }).filter((a): a is NonNullable<typeof a> => a !== null);

  return {
    ok: true,
    data: { delivery, artifacts },
  };
}
