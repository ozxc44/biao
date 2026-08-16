/**
 * V2 Delivery Service（Phase 4）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §4.5（Delivery 状态机）、
 * §7.3（Git Diff 二次门禁：服务端独立复核，不信任 Node 上报）、§6.6/§4.4.2
 * （孤儿 branch 的受控清理——落 BranchCleanup 记录、到期复核 HEAD 后删除）。
 *
 * 职责边界：
 * - workspace.ts（finalize）调用本文件的 verifyDeliveryAgainstRemote 做
 *   "Delivery 创建时"二次门禁；
 * - 本服务承担创建后的生命周期：pending_review → reviewing →
 *   accepted|rejected|invalidated（+ pending_recovery 的 Artifact 中断恢复）；
 * - BranchCleanup 由 Delivery 终态触发落记录（幂等），到期执行删除前
 *   再次校验远端 HEAD，不匹配则失败留审计，绝不盲删。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { DeliveryRow } from '../../types/v2-artifact.js';
import type {
  DeliveryDiffSummary,
  DeliveryInvalidatedReason,
} from '../../types/v2-git.js';
import { BRANCH_CLEANUP_RETENTION_MS } from '../../types/v2-git.js';
import type { V2CredentialKey } from './credentials.js';
import type { GitProvider } from './git/provider.js';
import { GitProviderError } from './git/provider.js';
import { findOwnershipViolations } from './git/ownership-gate.js';
import { verifyAttemptMarker } from './git/marker.js';

/** §4.5 非 merged 终态（进入 BranchCleanup 的 Delivery 集合）。 */
const NON_MERGED_TERMINAL_STATUSES = new Set([
  'rejected',
  'superseded',
  'conflict',
  'integration_failed',
  'invalidated',
]);

export type DeliveryServiceApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; data: null; error: { code: string; message: string } };

function fail<T = never>(code: string, message: string): DeliveryServiceApiResponse<T> {
  return { ok: false, data: null, error: { code, message } };
}

/** 空 diff 摘要（复核中断 / 分支缺失时的占位）。 */
function emptySummary(): DeliveryDiffSummary {
  return { files: [], ownership_violations: [], server_verified: false, verified_at: 0 };
}

// ──────────────── §7.3 服务端独立 diff 复核（standalone，供 finalize 复用） ────────────────

export interface RemoteVerifyInput {
  store: SqliteStore;
  provider: GitProvider;
  /** 项目 Git 真相源（§6.1：remote 是源代码真相源）。 */
  remoteUrl: string;
  defaultBranch: string;
  /** 待复核 delivery 事实（来自 bare remote，而非 Node 上报）。 */
  attemptId: string;
  taskId: string;
  attemptGeneration: number;
  nodeId: string;
  baseSha: string;
  headSha: string;
  branchRef: string;
  markerRef: string;
  bva2Digest: string;
  /** marker 验签密钥环（按 signing_key_generation 选择）。 */
  keyring: readonly V2CredentialKey[];
  /** 服务端复核克隆的临时目录根。 */
  verifyDirRoot: string;
  now: () => number;
}

export type RemoteVerifyFailure =
  | { kind: 'branch-head-changed'; message: string }
  | { kind: 'merge-base-unreachable'; message: string }
  | { kind: 'marker-invalid'; message: string }
  | { kind: 'ownership-violation'; violations: string[]; message: string };

export type RemoteVerifyResult =
  | { ok: true; summary: DeliveryDiffSummary }
  | { ok: false; reason: RemoteVerifyFailure; summary: DeliveryDiffSummary };

/**
 * 服务端从 bare remote 独立复核：克隆 → ref CAS → base 可达 → signed marker
 * 验签 → 独立 diff 与 ownership 比对。任何一步失败都不产生"可 accept"的
 * delivery（§7.3：不允许 PM 用普通 accept 绕过）。
 */
export async function verifyDeliveryAgainstRemote(input: RemoteVerifyInput): Promise<RemoteVerifyResult> {
  const { provider, store } = input;
  mkdirSync(input.verifyDirRoot, { recursive: true });
  const verifyDir = mkdtempSync(join(input.verifyDirRoot, 'biao-verify-'));
  try {
    // §6.1：以远端为真相源做独立克隆，不复用 Node 工作区。
    await provider.clone(input.remoteUrl, verifyDir, { noCheckout: true });

    // 1) ref CAS：远端 branch 必须仍指向 delivery 声明的 head（R1A-001）。
    const remoteRefs = await provider.lsRemote(input.remoteUrl, input.branchRef);
    const remoteBranch = remoteRefs.find((r) => r.ref === input.branchRef);
    if (!remoteBranch) {
      return {
        ok: false,
        reason: { kind: 'branch-head-changed', message: `远端 ${input.branchRef} 不存在（被外部改写或删除）` },
        summary: emptySummary(),
      };
    }
    if (remoteBranch.sha !== input.headSha) {
      return {
        ok: false,
        reason: {
          kind: 'branch-head-changed',
          message: `远端 ${input.branchRef} head=${remoteBranch.sha}，delivery 记录=${input.headSha}`,
        },
        summary: emptySummary(),
      };
    }

    // 2) base 可达：base 仍是默认分支历史的祖先（默认分支被 force 改写即失效）。
    const defaultHead = (await provider.lsRemote(input.remoteUrl, `refs/heads/${input.defaultBranch}`))[0]?.sha
      ?? null;
    const mergeBase = defaultHead ? await provider.mergeBase(verifyDir, input.baseSha, defaultHead) : null;
    if (!defaultHead || mergeBase !== input.baseSha) {
      return {
        ok: false,
        reason: {
          kind: 'merge-base-unreachable',
          message: `base ${input.baseSha.slice(0, 12)} 不再可达（默认分支 head=${defaultHead ?? '缺失'}）`,
        },
        summary: emptySummary(),
      };
    }

    // 3) signed marker 验签（R1C-005：缺失/验签失败不得当作已交付）。
    let markerContent: string;
    try {
      markerContent = (await provider.readBlob(input.remoteUrl, input.markerRef)).content;
    } catch (err) {
      return {
        ok: false,
        reason: {
          kind: 'marker-invalid',
          message: `marker ${input.markerRef} 读取失败：${err instanceof Error ? err.message : String(err)}`,
        },
        summary: emptySummary(),
      };
    }
    const parsed = safeParseEnvelope(markerContent);
    const markerKey = parsed
      ? input.keyring.find((k) => k.key_version === parsed.signing_key_generation)
      : undefined;
    const markerResult = markerKey
      ? verifyAttemptMarker({
        content: markerContent,
        expected: {
          attempt_id: input.attemptId,
          task_id: input.taskId,
          attempt_generation: input.attemptGeneration,
          branch_ref: input.branchRef,
          head_sha: input.headSha,
          bva2_digest: input.bva2Digest,
        },
        key: markerKey,
      })
      : null;
    if (!markerResult || !markerResult.ok) {
      return {
        ok: false,
        reason: {
          kind: 'marker-invalid',
          message: `marker 验签失败：${markerResult && !markerResult.ok ? markerResult.message : 'signing_key_generation 无对应密钥'}`,
        },
        summary: emptySummary(),
      };
    }

    // 4) 独立 diff（不信任 Node 上报的 changed_files）+ ownership 比对。
    const diffFiles = await provider.diffNameOnly(verifyDir, input.baseSha, input.headSha);
    const diffStat = await provider.diffStat(verifyDir, input.baseSha, input.headSha);
    const writeGlobs = latestWriteGlobs(store, input.attemptId);
    const violations = findOwnershipViolations(diffFiles, writeGlobs);
    const summary: DeliveryDiffSummary = {
      files: diffStat,
      ownership_violations: violations,
      server_verified: true,
      verified_at: input.now(),
    };
    if (violations.length > 0) {
      return {
        ok: false,
        reason: {
          kind: 'ownership-violation',
          violations,
          message: `ownership 外变更：${violations.join(', ')}`,
        },
        summary,
      };
    }
    return { ok: true, summary };
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

function safeParseEnvelope(content: string): { signing_key_generation: number } | null {
  try {
    const parsed = JSON.parse(content) as { payload?: { signing_key_generation?: unknown } };
    if (parsed?.payload && typeof parsed.payload.signing_key_generation === 'number') {
      return { signing_key_generation: parsed.payload.signing_key_generation };
    }
    return null;
  } catch {
    return null;
  }
}

/** attempt 最新未释放 ownership snapshot 的 write_globs（§7.1）。 */
export function latestWriteGlobs(store: SqliteStore, attemptId: string): string[] {
  const snapshots = store.listOwnershipSnapshotsByAttempt(attemptId);
  const active = [...snapshots].reverse().find((s) => s.released_at === null || s.released_at === undefined);
  const row = active ?? snapshots.at(-1);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.files) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ──────────────── §4.5 Delivery 状态机服务 ────────────────

export interface DeliveryServiceOptions {
  store: SqliteStore;
  provider: GitProvider;
  keyring: readonly V2CredentialKey[];
  /** 服务端复核克隆临时目录根（默认系统 tmp）。 */
  verifyDirRoot?: string;
  now?: () => number;
  /** BranchCleanup 保留期（默认 30 天）。 */
  cleanupRetentionMs?: number;
}

export function createDeliveryService(options: DeliveryServiceOptions) {
  const { store, provider, keyring } = options;
  const now = options.now ?? (() => Date.now());
  const verifyDirRoot = options.verifyDirRoot ?? tmpdir();
  const retentionMs = options.cleanupRetentionMs ?? BRANCH_CLEANUP_RETENTION_MS;

  /** 确定性 cleanup id：(delivery_id, branch_ref, expected_head_sha) 幂等键。 */
  function cleanupId(delivery: DeliveryRow): string {
    return `bc-${createHash('sha256')
      .update(`${delivery.delivery_id}|${delivery.branch_ref}|${delivery.head_sha}`)
      .digest('hex')
      .slice(0, 24)}`;
  }

  /** §4.4.2/§6.6：非 merged 终态 Delivery 幂等落 BranchCleanup 记录。 */
  function enqueueBranchCleanup(
    deliveryId: string,
    reason: 'rejected' | 'superseded' | 'conflict' | 'integration_failed' | 'invalidated' | 'mode_transition',
  ): { cleanup_id: string; already_existed: boolean } | null {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery || !delivery.branch_ref) return null;
    const id = cleanupId(delivery);
    if (store.getBranchCleanup(id)) return { cleanup_id: id, already_existed: true };
    const ts = now();
    store.insertBranchCleanup({
      cleanup_id: id,
      project_id: delivery.project_id,
      delivery_id: delivery.delivery_id,
      branch_ref: delivery.branch_ref,
      expected_head_sha: delivery.head_sha,
      reason,
      status: 'pending',
      eligible_at: ts + retentionMs,
      retention_until: ts + retentionMs + BRANCH_CLEANUP_RETENTION_MS,
      last_error: '',
      completed_at: null,
    });
    return { cleanup_id: id, already_existed: false };
  }

  function requireDelivery(deliveryId: string): DeliveryServiceApiResponse<DeliveryRow> {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery) return fail('DELIVERY_NOT_FOUND', `delivery ${deliveryId} 不存在`);
    return { ok: true, data: delivery };
  }

  return {
    /**
     * §7.3 二次门禁（独立复核入口，可对任意 delivery 重跑）：
     * - ref 改写 / base 不可达 / marker 验签失败 → invalidated；
     * - ownership 越界 → rejected（强制拒绝，进入 Question/repair 通道）。
     * 结果（含 diff 摘要）写回 delivery 行。
     */
    async verifyDeliveryRemote(deliveryId: string): Promise<DeliveryServiceApiResponse<{
      verified: boolean;
      reason?: string;
      summary: DeliveryDiffSummary;
    }>> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      const project = store.getProject(delivery.project_id);
      if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${delivery.project_id} 不存在`);
      const ws = store.getAttemptWorkspace(delivery.attempt_id);
      if (!ws) return fail('WORKSPACE_NOT_FOUND', `attempt ${delivery.attempt_id} 无工作区记录`);
      const result = await verifyDeliveryAgainstRemote({
        store,
        provider,
        remoteUrl: project.repository_url,
        defaultBranch: project.default_branch,
        attemptId: delivery.attempt_id,
        taskId: delivery.task_id,
        attemptGeneration: attemptGenerationOf(store, delivery.attempt_id),
        nodeId: ws.node_id,
        baseSha: delivery.base_sha,
        headSha: delivery.head_sha,
        branchRef: delivery.branch_ref,
        markerRef: ws.marker_ref,
        bva2Digest: ws.bva2_digest,
        keyring,
        verifyDirRoot,
        now,
      });
      const ts = now();
      const summaryJson = JSON.stringify(result.summary);
      if (result.ok) {
        store.updateDelivery(deliveryId, {
          diff_summary: summaryJson,
          server_verified: 1,
          updated_at: ts,
        });
        return { ok: true, data: { verified: true, summary: result.summary } };
      }
      const { reason } = result;
      const violations = 'violations' in reason ? reason.violations : [];
      const message = reason.message + (violations.length ? `；violations=${JSON.stringify(violations)}` : '');
      if (reason.kind === 'ownership-violation') {
        // §7.3：未授权变更强制拒绝 Delivery，PM 不能用普通 accept 绕过。
        store.updateDelivery(deliveryId, {
          status: 'rejected',
          diff_summary: summaryJson,
          server_verified: 1,
          invalidated_reason: '',
          updated_at: ts,
        });
        enqueueBranchCleanup(deliveryId, 'rejected');
        return { ok: true, data: { verified: false, reason: message, summary: result.summary } };
      }
      store.updateDelivery(deliveryId, {
        status: 'invalidated',
        invalidated_reason: reason.kind as DeliveryInvalidatedReason,
        diff_summary: summaryJson,
        server_verified: 0,
        updated_at: ts,
      });
      enqueueBranchCleanup(deliveryId, 'invalidated');
      return { ok: true, data: { verified: false, reason: message, summary: result.summary } };
    },

    /** pending_review → reviewing（Review 开始，锁定不可再被收敛改写）。 */
    startReview(deliveryId: string): DeliveryServiceApiResponse<{ delivery_id: string; status: string }> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      if (found.data.status !== 'pending_review') {
        return fail('INVALID_TRANSITION', `delivery ${deliveryId} 状态 ${found.data.status}，不能进入 reviewing`);
      }
      store.updateDeliveryStatus(deliveryId, 'reviewing', now());
      return { ok: true, data: { delivery_id: deliveryId, status: 'reviewing' } };
    },

    /** reviewing → accepted|rejected；reject 幂等落 BranchCleanup（§6.6）。 */
    reviewDelivery(
      deliveryId: string,
      input: {
        verdict: 'accept' | 'reject';
        reviewed_by: string;
        comment?: string;
        reject_reason?: string;
        fix_instructions?: string;
      },
    ): DeliveryServiceApiResponse<{ delivery_id: string; status: string; cleanup_id?: string }> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      if (delivery.status !== 'reviewing') {
        return fail('INVALID_TRANSITION', `delivery ${deliveryId} 状态 ${delivery.status}，必须先 reviewing`);
      }
      const status = input.verdict === 'accept' ? 'accepted' : 'rejected';
      store.updateDelivery(deliveryId, { status, updated_at: now() });
      let cleanupId: string | undefined;
      if (status === 'rejected') {
        cleanupId = enqueueBranchCleanup(deliveryId, 'rejected')?.cleanup_id;
      }
      return { ok: true, data: { delivery_id: deliveryId, status, cleanup_id: cleanupId } };
    },

    /** 远端不一致（force-push / ref 改写）→ invalidated + cleanup。 */
    forceInvalidate(
      deliveryId: string,
      reason: DeliveryInvalidatedReason,
      message: string,
    ): DeliveryServiceApiResponse<{ delivery_id: string; status: string }> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      if (delivery.status === 'accepted' || delivery.status === 'merged' || delivery.status === 'invalidated') {
        return fail('INVALID_TRANSITION', `delivery ${deliveryId} 状态 ${delivery.status} 不能 invalidate`);
      }
      const ts = now();
      store.updateDelivery(deliveryId, {
        status: 'invalidated',
        invalidated_reason: reason,
        updated_at: ts,
      });
      enqueueBranchCleanup(deliveryId, 'invalidated');
      return { ok: true, data: { delivery_id: deliveryId, status: 'invalidated' } };
    },

    /**
     * §21 Artifact 中断收敛：pending_recovery 的 delivery 在 artifact 补齐后
     * 转 pending_review（workspace.finalize_state 同步收敛为 delivered）。
     */
    recoverPendingArtifacts(deliveryId: string): DeliveryServiceApiResponse<{
      delivery_id: string;
      status: string;
      artifacts_complete: boolean;
    }> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      if (delivery.status !== 'pending_recovery') {
        return fail('INVALID_TRANSITION', `delivery ${deliveryId} 状态 ${delivery.status}，不是 pending_recovery`);
      }
      const artifactIds = JSON.parse(delivery.artifact_ids) as string[];
      const incomplete = artifactIds.filter((id) => store.getArtifact(id)?.status !== 'complete');
      if (incomplete.length > 0) {
        return {
          ok: true,
          data: { delivery_id: deliveryId, status: 'pending_recovery', artifacts_complete: false },
        };
      }
      const ts = now();
      store.updateDelivery(deliveryId, { status: 'pending_review', updated_at: ts });
      const ws = store.getAttemptWorkspace(delivery.attempt_id);
      if (ws && ws.finalize_state === 'pending_recovery') {
        store.updateAttemptWorkspace(ws.attempt_id, {
          finalize_state: 'delivered',
          finalize_error: '',
          updated_at: ts,
        });
      }
      return {
        ok: true,
        data: { delivery_id: deliveryId, status: 'pending_review', artifacts_complete: true },
      };
    },

    /** PM Review V2 视图：delivery + artifact manifest + diff 摘要（±统计，无正文）。 */
    getReviewView(deliveryId: string): DeliveryServiceApiResponse<{
      delivery: DeliveryRow;
      diff_summary: DeliveryDiffSummary;
      artifacts: Array<{ artifact_id: string; kind: string; sha256: string; status: string }>;
    } | null> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      let summary: DeliveryDiffSummary = emptySummary();
      try {
        const parsed = JSON.parse(delivery.diff_summary ?? '[]') as Partial<DeliveryDiffSummary>;
        if (parsed && Array.isArray(parsed.files)) {
          summary = {
            files: parsed.files,
            ownership_violations: parsed.ownership_violations ?? [],
            server_verified: parsed.server_verified ?? false,
            verified_at: parsed.verified_at ?? 0,
          };
        }
      } catch {
        // 摘要损坏按未复核处理（fail-closed）。
      }
      const artifactIds = JSON.parse(delivery.artifact_ids) as string[];
      const artifacts = artifactIds
        .map((id) => store.getArtifact(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
        .map((a) => ({ artifact_id: a.artifact_id, kind: a.kind, sha256: a.sha256, status: a.status }));
      return { ok: true, data: { delivery, diff_summary: summary, artifacts } };
    },

    /** 到期 BranchCleanup 执行：复核远端 HEAD 后删除；不匹配则失败留审计。 */
    async runDueBranchCleanups(): Promise<DeliveryServiceApiResponse<{
      processed: number;
      deleted: number;
      already_missing: number;
      failed: number;
    }>> {
      const ts = now();
      const due = store
        .listBranchCleanups(undefined, 'pending')
        .filter((c) => c.eligible_at <= ts);
      let deleted = 0;
      let alreadyMissing = 0;
      let failedCount = 0;
      for (const record of due) {
        const project = record.project_id ? store.getProject(record.project_id) : undefined;
        if (!project) {
          store.updateBranchCleanup(record.cleanup_id, { status: 'failed', last_error: 'project 不存在' });
          failedCount++;
          continue;
        }
        try {
          const remoteRefs = await provider.lsRemote(project.repository_url, record.branch_ref);
          const remote = remoteRefs.find((r) => r.ref === record.branch_ref);
          if (!remote) {
            // §4.4.2：branch 已不存在且 Remote 确认 missing → 幂等视为 deleted。
            store.updateBranchCleanup(record.cleanup_id, { status: 'deleted', completed_at: ts });
            alreadyMissing++;
            continue;
          }
          if (remote.sha !== record.expected_head_sha) {
            store.updateBranchCleanup(record.cleanup_id, {
              status: 'failed',
              last_error: `branch head 已变化（${remote.sha.slice(0, 12)}），保留人工裁决`,
            });
            failedCount++;
            continue;
          }
          await provider.deleteRemoteRef(project.repository_url, record.branch_ref);
          store.updateBranchCleanup(record.cleanup_id, { status: 'deleted', completed_at: ts });
          deleted++;
        } catch (err) {
          const message = err instanceof GitProviderError ? `${err.kind}: ${err.stderr.slice(0, 200)}` : String(err);
          store.updateBranchCleanup(record.cleanup_id, { status: 'failed', last_error: message });
          failedCount++;
        }
      }
      return {
        ok: true,
        data: { processed: due.length, deleted, already_missing: alreadyMissing, failed: failedCount },
      };
    },

    /** 非 merged 终态 delivery 的统一 cleanup 入队（恢复扫描/reconcile 复用）。 */
    enqueueCleanupForTerminalDeliveries(): number {
      let enqueued = 0;
      for (const status of NON_MERGED_TERMINAL_STATUSES) {
        for (const delivery of store.listDeliveriesByStatus(status)) {
          const result = enqueueBranchCleanup(delivery.delivery_id, 'invalidated');
          if (result && !result.already_existed) enqueued++;
        }
      }
      return enqueued;
    },

    /**
     * §proposed/finalize 双轨收口：
     * proposed delivery 超过阈值（默认 4 小时）未被 finalize 接管 → 过期清理 + 审计。
     * finalize delivery 为权威路径；proposed 过期后标记 superseded。
     */
    cleanupStaleProposedDeliveries(maxAgeMs?: number): { processed: number; superseded: number } {
      const threshold = maxAgeMs ?? 4 * 60 * 60 * 1000; // 默认 4 小时
      const ts = now();
      const staleProposed = store.listDeliveriesByStatus('proposed')
        .filter((d) => ts - d.created_at > threshold);

      let superseded = 0;
      for (const delivery of staleProposed) {
        // 检查同一 attempt 是否已有 finalize delivery（accepted/merged）
        const attemptDeliveries = store.listDeliveriesByAttempt(delivery.attempt_id);
        const hasFinalize = attemptDeliveries.some(
          (d) => d.delivery_id !== delivery.delivery_id &&
            (d.status === 'accepted' || d.status === 'merged' || d.status === 'pending_review'),
        );

        if (hasFinalize) {
          // finalize 已接管：proposed 标记 superseded
          store.updateDelivery(delivery.delivery_id, {
            status: 'superseded',
            invalidated_reason: 'finalize-taken-over',
            updated_at: ts,
          });
        } else {
          // 无 finalize：proposed 过期，标记 superseded + 审计
          store.updateDelivery(delivery.delivery_id, {
            status: 'superseded',
            invalidated_reason: 'proposed-expired',
            updated_at: ts,
          });
        }
        superseded++;
      }

      return { processed: staleProposed.length, superseded };
    },

    /**
     * 22.1-10：rejected delivery → repair。
     * 生成新 repair task attempt（继承 ownership+verify 设置），排除原验收者。
     * 对齐 V1 reject→repair→reverify 闭环。
     */
    repairDelivery(
      deliveryId: string,
      options: { exclude_reviewer?: string } = {},
    ): DeliveryServiceApiResponse<{
      delivery_id: string;
      repair_attempt_id: string;
      exclude_reviewer: string;
    }> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      if (delivery.status !== 'rejected') {
        return fail('INVALID_TRANSITION', `delivery ${deliveryId} 状态 ${delivery.status}，只有 rejected 可 repair`);
      }
      const project = store.getProject(delivery.project_id);
      if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${delivery.project_id} 不存在`);
      const originalAttempt = store.getTaskAttempt(delivery.attempt_id);
      if (!originalAttempt) return fail('ATTEMPT_NOT_FOUND', `原始 attempt ${delivery.attempt_id} 不存在`);

      // 排除原验收者：默认取原 delivery 的 reviewed_by（如有）。
      const excludeReviewer = options.exclude_reviewer ?? '';

      // 创建新 repair attempt（继承 ownership snapshot + verify 设置）
      const repairAttemptId = `att-repair-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ts = now();
      store.insertTaskAttempt({
        attempt_id: repairAttemptId,
        task_id: originalAttempt.task_id,
        project_id: originalAttempt.project_id,
        node_id: '', // repair attempt 待认领
        session_id: '',
        status: 'pending',
        attempt_generation: (originalAttempt.attempt_generation ?? 0) + 1,
        lease_expires_at: 0,
        lease_duration_ms: 0,
        token_jti: '',
        artifact_ids: '[]',
        started_at: ts,
        updated_at: ts,
        completed_at: null,
        failure_reason: '',
      });

      // 从原 attempt 复制 ownership snapshot（repair 继承相同文件权限）
      const origSnapshots = store.listOwnershipSnapshotsByAttempt(delivery.attempt_id);
      const activeOrig = [...origSnapshots].reverse().find((s) => s.released_at === null || s.released_at === undefined);
      const snapshotToCopy = activeOrig ?? origSnapshots.at(-1);
      if (snapshotToCopy) {
        store.insertOwnershipSnapshot({
          snapshot_id: `snap-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          attempt_id: repairAttemptId,
          task_id: snapshotToCopy.task_id,
          files: snapshotToCopy.files,
          created_at: ts,
          released_at: null,
        });
      }

      // 记录 repair 关联（通过 diff_summary 追加 repair 链路）
      store.updateDelivery(deliveryId, {
        diff_summary: JSON.stringify({
          repair_attempt_id: repairAttemptId,
          exclude_reviewer: excludeReviewer,
          repair_at: ts,
        }),
        updated_at: ts,
      });

      return {
        ok: true,
        data: {
          delivery_id: deliveryId,
          repair_attempt_id: repairAttemptId,
          exclude_reviewer: excludeReviewer,
        },
      };
    },

    /**
     * 22.1-10：reverify delivery——只重验证据，不改来源实现。
     * 对齐 V1 --reverify-only 语义：重新执行服务端独立复核，更新 diff_summary。
     * 幂等：重复请求回放同一 reverify 结果。
     */
    async reverifyDelivery(deliveryId: string): Promise<DeliveryServiceApiResponse<{
      delivery_id: string;
      verified: boolean;
      reason?: string;
      summary: DeliveryDiffSummary;
    }>> {
      const found = requireDelivery(deliveryId);
      if (!found.ok) return found;
      const delivery = found.data;
      // reverify 对任意已有 server_verified 记录的 delivery 有效
      const project = store.getProject(delivery.project_id);
      if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${delivery.project_id} 不存在`);
      const ws = store.getAttemptWorkspace(delivery.attempt_id);
      if (!ws) return fail('WORKSPACE_NOT_FOUND', `attempt ${delivery.attempt_id} 无工作区记录`);

      const result = await verifyDeliveryAgainstRemote({
        store,
        provider,
        remoteUrl: project.repository_url,
        defaultBranch: project.default_branch,
        attemptId: delivery.attempt_id,
        taskId: delivery.task_id,
        attemptGeneration: attemptGenerationOf(store, delivery.attempt_id),
        nodeId: ws.node_id,
        baseSha: delivery.base_sha,
        headSha: delivery.head_sha,
        branchRef: delivery.branch_ref,
        markerRef: ws.marker_ref,
        bva2Digest: ws.bva2_digest,
        keyring,
        verifyDirRoot,
        now,
      });

      const ts = now();
      const summaryJson = JSON.stringify(result.summary);
      if (result.ok) {
        store.updateDelivery(deliveryId, {
          diff_summary: summaryJson,
          server_verified: 1,
          updated_at: ts,
        });
        return { ok: true, data: { delivery_id: deliveryId, verified: true, summary: result.summary } };
      }
      // reverify 失败：记录但不改变 delivery 状态（只更新 diff_summary）
      store.updateDelivery(deliveryId, {
        diff_summary: summaryJson,
        server_verified: 1,
        updated_at: ts,
      });
      return {
        ok: true,
        data: {
          delivery_id: deliveryId,
          verified: false,
          reason: result.reason.message,
          summary: result.summary,
        },
      };
    },

    /** 暴露幂等入队（workspace CAS 冲突路径直接可用）。 */
    enqueueBranchCleanup,
  };
}

function attemptGenerationOf(store: SqliteStore, attemptId: string): number {
  return store.getTaskAttempt(attemptId)?.attempt_generation ?? 1;
}

/** 生成新 delivery_id（workspace finalize 与测试共用格式）。 */
export function newDeliveryId(): string {
  return `del-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
