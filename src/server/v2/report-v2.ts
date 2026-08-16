/**
 * Report V2（Phase 2 最小版）
 *
 * Attempt 上报时引用 artifact sha256 清单，校验存在性+归属。
 * 生成 delivery 记录雏形（deliveries 表入 005 迁移，§4.5 最小字段）。
 *
 * 对应 docs/distributed-multi-node-development-plan.md §15.3 report 路由。
 */

import type { SqliteStore } from '../../db/sqlite-store.js';
import type { DeliveryRow } from '../../types/v2-artifact.js';
import type { ApiResponse } from '../../types/index.js';
import { randomBytes } from 'node:crypto';

export interface ReportV2Input {
  status: 'done' | 'failed' | 'partial';
  artifact_refs?: Array<{ artifact_id: string; sha256: string }>;
}

export interface ReportV2Result {
  attempt_id: string;
  status: string;
  delivery_id?: string;
}

/**
 * Report V2：Attempt 收口时引用 artifact sha256 清单。
 * §9.2 第 7 条：Report/Delivery 只能引用 completed Artifact。
 */
export function reportV2(
  store: SqliteStore,
  attemptId: string,
  input: ReportV2Input,
): ApiResponse<ReportV2Result> {
  // 校验所有引用的 artifact 存在且 complete
  if (input.artifact_refs) {
    for (const ref of input.artifact_refs) {
      const artifact = store.getArtifact(ref.artifact_id);
      if (!artifact) {
        return {
          ok: false,
          data: null,
          error: { code: 'ARTIFACT_NOT_FOUND', message: `Artifact ${ref.artifact_id} 不存在` },
        };
      }
      if (artifact.status !== 'complete') {
        return {
          ok: false,
          data: null,
          error: { code: 'ARTIFACT_NOT_COMPLETE', message: `Artifact ${ref.artifact_id} 未完成` },
        };
      }
      if (artifact.sha256 !== ref.sha256) {
        return {
          ok: false,
          data: null,
          error: { code: 'ARTIFACT_SHA_MISMATCH', message: `Artifact ${ref.artifact_id} SHA 不符` },
        };
      }
      // §9.3 归属校验：attempt 必须一致
      if (artifact.attempt_id !== attemptId) {
        return {
          ok: false,
          data: null,
          error: { code: 'ARTIFACT_OWNERSHIP_DENIED', message: `Artifact ${ref.artifact_id} 不属于 attempt ${attemptId}` },
        };
      }
    }
  }

  // 生成 delivery 记录雏形
  const deliveryId = `del-${randomBytes(8).toString('hex')}`;
  const now = Date.now();

  // 获取 attempt 关联的 task/project
  const taskRow = store.getTaskByAttemptId(attemptId);
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
