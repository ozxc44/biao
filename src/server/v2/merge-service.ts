/**
 * V2 Merge Service（Phase 5）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §12（Merge Queue）、
 * §15.5（Merge API）、§4.7（MergeJob + ExternalMergeIntent 模型）。
 *
 * 职责边界：
 * - 队列入队/dispatch/cancel（串行队列 + CAS）；
 * - 外部合并意图登记（只登记+审计，不执行外部 API）；
 * - 降级/恢复路由。
 */

import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { ExternalMergeIntentRow } from '../../types/v2-infra.js';
import type { MergeJobRow } from '../../types/v2-merge.js';
import type { GitProvider } from './git/provider.js';
import { createMergeQueue, type MergeQueueApiResponse } from './merge/queue.js';

export type MergeServiceApiResponse<T> = MergeQueueApiResponse<T>;

export interface MergeServiceOptions {
  store: SqliteStore;
  provider: GitProvider;
  workspaceRoot?: string;
  now?: () => number;
}

export function createMergeService(options: MergeServiceOptions) {
  const { store, provider } = options;
  const now = options.now ?? (() => Date.now());
  const queue = createMergeQueue({ store, provider, workspaceRoot: options.workspaceRoot, now });

  // ──────────────── §15.5 Merge API ────────────────

  /**
   * POST /v2/merge-jobs：入合并队列。
   * 调用方需预先获取默认分支 HEAD 传入 expected_target_sha。
   */
  function createMergeJob(input: {
    project_id: string;
    delivery_id: string;
    expected_target_sha: string;
    strategy?: MergeJobRow['strategy'];
  }): MergeServiceApiResponse<MergeJobRow> {
    return queue.enqueueWithTarget(
      input.delivery_id,
      input.expected_target_sha,
      input.strategy ?? 'merge-ff',
    );
  }

  /**
   * GET /v2/merge-jobs/:merge_job_id：查询合并任务。
   */
  function getMergeJob(mergeJobId: string): MergeServiceApiResponse<MergeJobRow> {
    return queue.getMergeJob(mergeJobId);
  }

  /**
   * POST /v2/merge-jobs/:merge_job_id/cancel：取消合并任务。
   */
  function cancelMergeJob(
    mergeJobId: string,
    input: { reason: string },
  ): MergeServiceApiResponse<MergeJobRow> {
    return queue.cancelMergeJob(mergeJobId, input.reason);
  }

  /**
   * GET /v2/projects/:id/merge-jobs：队列视图。
   */
  function listMergeJobs(
    projectId: string,
    status?: string,
  ): MergeServiceApiResponse<MergeJobRow[]> {
    return queue.listMergeJobs(projectId, status);
  }

  /**
   * POST /v2/projects/:id/merge-jobs/dispatch：触发 dispatch（取队头执行）。
   */
  async function dispatchMergeJob(
    projectId: string,
  ): Promise<MergeServiceApiResponse<MergeJobRow | null>> {
    return queue.dispatch(projectId);
  }

  /**
   * POST /v2/merge-jobs/:id/retry：integration_failed 重试 = 新 job。
   */
  function retryMergeJob(
    mergeJobId: string,
  ): MergeServiceApiResponse<MergeJobRow> {
    const job = store.getMergeJob(mergeJobId);
    if (!job) {
      return { ok: false, data: null, error: { code: 'MERGE_JOB_NOT_FOUND', message: `merge job ${mergeJobId} 不存在` } };
    }
    if (job.status !== 'integration_failed' && job.status !== 'conflict') {
      return { ok: false, data: null, error: { code: 'INVALID_STATUS', message: `merge job ${mergeJobId} 状态 ${job.status}，只有 integration_failed/conflict 可重试` } };
    }
    // 创建新 job（新 expected_target_sha = 当前默认分支 HEAD）
    // 由于需要异步获取 HEAD，此处返回需要调用方传入新 target
    return { ok: false, data: null, error: { code: 'RETRY_REQUIRES_NEW_TARGET', message: '重试需要新的 expected_target_sha，请调用 createMergeJob' } };
  }

  // ──────────────── §15.5 External Merge Intent ────────────────

  /**
   * POST /v2/merge-jobs/external-intents：登记外部合并意图。
   * 本阶段只登记+审计，不执行外部 API。
   */
  function createExternalIntent(input: {
    project_id: string;
    delivery_id: string;
    expected_target_sha: string;
    provider_actor: string;
    approved_by: string;
    reason: string;
  }): MergeServiceApiResponse<ExternalMergeIntentRow> {
    const ts = now();
    const intent: ExternalMergeIntentRow = {
      intent_id: `emi-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      project_id: input.project_id,
      delivery_id: input.delivery_id,
      expected_target_sha: input.expected_target_sha,
      provider_actor: input.provider_actor,
      approved_by: input.approved_by,
      reason: input.reason,
      status: 'declared',
      final_sha: '',
      created_at: ts,
      resolved_at: null,
    };
    store.insertExternalMergeIntent(intent);
    return { ok: true, data: intent };
  }

  /**
   * POST /v2/merge-jobs/external-intents/:intent_id/reconcile：外部意图对账。
   */
  function reconcileExternalIntent(
    intentId: string,
  ): MergeServiceApiResponse<ExternalMergeIntentRow> {
    const intent = store.getExternalMergeIntent(intentId);
    if (!intent) {
      return { ok: false, data: null, error: { code: 'INTENT_NOT_FOUND', message: `intent ${intentId} 不存在` } };
    }
    // 本阶段只做状态推进，不执行实际外部 API
    const ts = now();
    store.updateExternalMergeIntent(intentId, {
      status: 'verified',
      resolved_at: ts,
    });
    return { ok: true, data: store.getExternalMergeIntent(intentId)! };
  }

  // ──────────────── §12.1.2 恢复 ────────────────

  /**
   * POST /v2/projects/:id/write-capability/restore：恢复写能力。
   */
  function restoreWriteCapability(
    projectId: string,
  ): MergeServiceApiResponse<{ restored: boolean }> {
    return queue.restoreWriteCapability(projectId);
  }

  return {
    createMergeJob,
    getMergeJob,
    cancelMergeJob,
    listMergeJobs,
    dispatchMergeJob,
    retryMergeJob,
    createExternalIntent,
    reconcileExternalIntent,
    restoreWriteCapability,
  };
}
