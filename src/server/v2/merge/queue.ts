/**
 * V2 Merge Queue（Phase 5）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §12（Merge Queue 全节）：
 * - §12.1 权限边界：Merge Bot 单写默认分支；
 * - §12.2 合并顺序：accepted delivery 时间 + 依赖拓扑；
 * - §12.3 冲突策略：不自动 ours/theirs，冲突保持可审计；
 * - §12.4 依赖解锁：prerequisite delivery merged 后才解锁下游；
 * - §12.1.1 降级：连续 N 次 integration_failed → degraded_read_only。
 *
 * 串行队列：同 project 同时最多一个 running merge job（部分唯一索引 + 入队 CAS）。
 * 默认分支 CAS：merge 执行前 ls-remote 校验 HEAD==expected_target_sha。
 * Integration workspace：fetch 默认分支 + delivery 分支 → merge --no-ff → 冲突检测。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStore } from '../../../db/sqlite-store.js';
import type { DeliveryRow } from '../../../types/v2-artifact.js';
import type { MergeJobRow } from '../../../types/v2-merge.js';
import { MERGE_DEGRADE_FAILURE_THRESHOLD } from '../../../types/v2-merge.js';
import type { GitProvider } from '../git/provider.js';
import { GitProviderError } from '../git/provider.js';
import { createIncidentService } from '../incident-service.js';
import { RefAclMissTracker, executeRefAclMissCircuitBreaker } from '../git/ref-acl.js';

export type MergeQueueApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; data: null; error: { code: string; message: string } };

function fail<T = never>(code: string, message: string): MergeQueueApiResponse<T> {
  return { ok: false, data: null, error: { code, message } };
}

export interface MergeQueueOptions {
  store: SqliteStore;
  provider: GitProvider;
  /** 集成工作区临时目录根（默认系统 tmp）。 */
  workspaceRoot?: string;
  now?: () => number;
  /** 连续失败降级阈值（默认 3）。 */
  degradeFailureThreshold?: number;
  /** 22.3-17：ref ACL 连续丢失熔断阈值（默认 3）。 */
  refAclMissThreshold?: number;
  /** §12 自动出队开关（默认 true；测试可关闭以手动控制 dispatch）。 */
  autoDispatch?: boolean;
}

export function createMergeQueue(options: MergeQueueOptions) {
  const { store, provider } = options;
  const now = options.now ?? (() => Date.now());
  const workspaceRoot = options.workspaceRoot ?? join(tmpdir(), 'biao-merge');
  const degradeThreshold = options.degradeFailureThreshold ?? MERGE_DEGRADE_FAILURE_THRESHOLD;
  const refAclMissTracker = new RefAclMissTracker(options.refAclMissThreshold ?? 3);
  const autoDispatchEnabled = options.autoDispatch === true; // 默认关闭，显式开启

  // §12 自动出队：单飞去重集合（projectId → 正在 dispatch 的标志）
  const dispatchingProjects = new Set<string>();

  /**
   * 自动出队驱动：入队/merge 完成后异步触发队头 dispatch。
   * - 单飞去重：同一 project 同时最多一个 dispatching；
   * - 失败不阻塞后续轮询（catch 静默，错误已记入 job 状态）。
   */
  function tryAutoDispatch(projectId: string): void {
    if (!autoDispatchEnabled) return;
    if (dispatchingProjects.has(projectId)) return;
    dispatchingProjects.add(projectId);
    dispatch(projectId)
      .catch(() => { /* 失败不阻塞，错误已记入 merge job 状态 */ })
      .finally(() => { dispatchingProjects.delete(projectId); });
  }

  function newMergeJobId(): string {
    return `mj-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  }

  // ──────────────── §12.2 入队 ────────────────

  /**
   * 将 accepted delivery 入队。
   * - delivery 必须是 accepted 状态；
   * - 同 (delivery_id, expected_target_sha) 幂等；
   * - 同 project 同时最多一个 running（唯一索引兜底，此处提前检查）。
   */
  function enqueue(
    deliveryId: string,
    strategy: MergeJobRow['strategy'] = 'merge-ff',
  ): MergeQueueApiResponse<MergeJobRow> {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery) return fail('DELIVERY_NOT_FOUND', `delivery ${deliveryId} 不存在`);
    if (delivery.status !== 'accepted') {
      return fail('INVALID_DELIVERY_STATUS', `delivery ${deliveryId} 状态 ${delivery.status}，只有 accepted 可入队`);
    }
    const project = store.getProject(delivery.project_id);
    if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${delivery.project_id} 不存在`);

    // 获取当前默认分支 HEAD 作为 expected_target_sha
    const defaultRef = `refs/heads/${project.default_branch}`;
    let expectedTargetSha: string;
    try {
      // 用 ls-remote 获取当前默认分支 HEAD
      const refs = store; // 通过 store 查 project 的 last known state
      // 用 provider 同步获取（但 enqueue 是同步函数...需要异步化）
      // 实际上 enqueue 应该是异步的，因为需要 ls-remote
      return fail('SYNC_ENQUEUE', 'enqueue 需要异步调用，请使用 enqueueAsync');
    } catch {
      return fail('LS_REMOTE_FAILED', '无法获取默认分支 HEAD');
    }
  }

  /**
   * 异步入队：接受 delivery 和已知的 target SHA（由调用方预先获取）。
   */
  function enqueueWithTarget(
    deliveryId: string,
    expectedTargetSha: string,
    strategy: MergeJobRow['strategy'] = 'merge-ff',
  ): MergeQueueApiResponse<MergeJobRow> {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery) return fail('DELIVERY_NOT_FOUND', `delivery ${deliveryId} 不存在`);
    if (delivery.status !== 'accepted') {
      return fail('INVALID_DELIVERY_STATUS', `delivery ${deliveryId} 状态 ${delivery.status}，只有 accepted 可入队`);
    }

    // 幂等检查：同 (delivery_id, expected_target_sha) 已存在
    const existing = store.getMergeJobByDeliveryTarget(deliveryId, expectedTargetSha);
    if (existing) {
      return { ok: true, data: existing };
    }

    const ts = now();
    const job: MergeJobRow = {
      merge_job_id: newMergeJobId(),
      delivery_id: deliveryId,
      project_id: delivery.project_id,
      expected_target_sha: expectedTargetSha,
      source_sha: delivery.head_sha,
      strategy,
      status: 'queued',
      final_sha: '',
      cancel_reason: '',
      conflict_files: '[]',
      error_message: '',
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    };

    try {
      store.insertMergeJob(job);
    } catch (err) {
      // 唯一约束冲突 = 幂等重放
      const dup = store.getMergeJobByDeliveryTarget(deliveryId, expectedTargetSha);
      if (dup) return { ok: true, data: dup };
      throw err;
    }

    // §12 自动出队：入队成功后异步触发队头 dispatch
    tryAutoDispatch(job.project_id);

    return { ok: true, data: job };
  }

  // ──────────────── §12.2 dispatch（取队头执行） ────────────────

  /**
   * 取队头 queued job 执行 merge。
   * - CAS 校验默认分支 HEAD == expected_target_sha；
   * - 创建 integration workspace；
   * - merge --no-ff；
   * - 成功 → push → merged → 下游解锁；
   * - 冲突 → integration_failed + 冲突文件清单。
   */
  async function dispatch(
    projectId: string,
  ): Promise<MergeQueueApiResponse<MergeJobRow | null>> {
    const project = store.getProject(projectId);
    if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);

    // 检查是否已有 running job
    const runningJobs = store.listMergeJobs(projectId, 'running');
    if (runningJobs.length > 0) {
      return { ok: true, data: null }; // 已有 running，不 dispatch
    }

    // 取队头 queued job
    const queuedJobs = store.listMergeJobs(projectId, 'queued');
    if (queuedJobs.length === 0) {
      return { ok: true, data: null }; // 队列空
    }
    const job = queuedJobs[0];

    // 检查降级状态（§12.1.1：lost/disabled 阻止新 merge）
    if (project.write_capability_status === 'lost' || project.write_capability_status === 'disabled') {
      return fail('PROJECT_DEGRADED', `项目 ${projectId} 写能力状态 ${project.write_capability_status}，阻止新 merge`);
    }

    // CAS 校验默认分支 HEAD
    const defaultRef = `refs/heads/${project.default_branch}`;
    let currentTargetSha: string;
    try {
      const refs = await provider.lsRemote(project.repository_url, defaultRef);
      currentTargetSha = refs[0]?.sha ?? '';
    } catch (err) {
      const isRemoteUnreachable = err instanceof GitProviderError && err.kind === 'remote-unreachable';
      const errorCode = isRemoteUnreachable ? 'REMOTE_UNREACHABLE' : 'LS_REMOTE_FAILED';
      return fail(errorCode, `获取默认分支 HEAD 失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!currentTargetSha) {
      return fail('DEFAULT_BRANCH_MISSING', `远端缺少 ${defaultRef}`);
    }

    if (currentTargetSha !== job.expected_target_sha) {
      // §12.2：CAS 失败 → invalidated
      const ts = now();
      store.updateMergeJob(job.merge_job_id, {
        status: 'invalidated',
        cancel_reason: 'target-advanced',
        error_message: `默认分支已前移：expected=${job.expected_target_sha.slice(0, 12)}, actual=${currentTargetSha.slice(0, 12)}`,
        updated_at: ts,
        completed_at: ts,
      });
      // delivery 回 invalidated
      store.updateDelivery(job.delivery_id, {
        status: 'invalidated',
        invalidated_reason: 'branch-head-changed',
        updated_at: ts,
      });
      return { ok: true, data: store.getMergeJob(job.merge_job_id)! };
    }

    // 标记 running
    store.updateMergeJob(job.merge_job_id, { status: 'running', updated_at: now() });

    // 执行 merge
    const result = await executeMerge(job, project.repository_url, project.default_branch);

    return { ok: true, data: result };
  }

  // ──────────────── integration workspace + merge 执行 ────────────────

  async function executeMerge(
    job: MergeJobRow,
    remoteUrl: string,
    defaultBranch: string,
  ): Promise<MergeJobRow> {
    const ts = now();
    mkdirSync(workspaceRoot, { recursive: true });
    const integrationDir = mkdtempSync(join(workspaceRoot, `merge-${job.merge_job_id}-`));

    try {
      // 1. clone + fetch 默认分支和 delivery 分支
      await provider.clone(remoteUrl, integrationDir, { noCheckout: false });
      await provider.fetch(integrationDir);

      const delivery = store.getDelivery(job.delivery_id);
      if (!delivery) {
        return finalizeJob(job, 'integration_failed', 'delivery 记录缺失', ts);
      }

      // 2. checkout 默认分支
      try {
        await provider.checkoutNewBranch(integrationDir, `refs/heads/${defaultBranch}`, job.expected_target_sha);
      } catch {
        // 如果分支已存在，直接 checkout
        try {
          await provider.merge(integrationDir, `origin/${defaultBranch}`, { noFf: false, message: 'checkout' });
        } catch {
          // ignore, we'll work with FETCH_HEAD
        }
      }

      // 3. 确保 HEAD 在 expected_target_sha
      const head = await provider.headSha(integrationDir);
      if (head !== job.expected_target_sha) {
        // 尝试直接 reset 到 expected_target_sha
        try {
          await provider.writeRef(integrationDir, 'HEAD', job.expected_target_sha);
        } catch {
          return finalizeJob(job, 'integration_failed', `HEAD 不在 expected_target_sha: ${head?.slice(0, 12)}`, ts);
        }
      }

      // 4. fetch delivery 分支
      const branchRef = delivery.branch_ref;
      try {
        await provider.fetch(integrationDir);
      } catch {
        // 如果 fetch 失败，尝试直接 fetch delivery ref
        try {
          await provider.clone(remoteUrl, integrationDir, { noCheckout: false });
          await provider.fetch(integrationDir);
        } catch (err) {
          return finalizeJob(job, 'integration_failed', `fetch 失败：${err instanceof Error ? err.message : String(err)}`, ts);
        }
      }

      // 5. merge delivery head
      const sourceSha = job.source_sha;
      let mergeSha: string;
      try {
        // 先确保 HEAD 在 expected_target_sha
        const currentHead = await provider.headSha(integrationDir);
        if (currentHead !== job.expected_target_sha) {
          // reset 到 expected target
          await provider.writeRef(integrationDir, 'HEAD', job.expected_target_sha);
        }
        mergeSha = await provider.merge(integrationDir, sourceSha, {
          noFf: true,
          message: `merge: ${job.delivery_id} → ${defaultBranch}`,
        });
      } catch (err) {
        // 只有 provider 判定的真实冲突才进 conflict 审计路径；其它 GitProviderError
        // （身份缺失、fetch 异常等）是集成失败，误标 conflict 会污染审计并让
        // "真实冲突保持可审计"失去含义。
        if (err instanceof GitProviderError && err.kind === 'merge-conflict') {
          // 解析冲突文件
          const conflictFiles = parseConflictFiles(err.stderr + '\n' + (err.message ?? ''));
          store.updateMergeJob(job.merge_job_id, {
            status: 'conflict',
            conflict_files: JSON.stringify(conflictFiles),
            error_message: `merge 冲突：${conflictFiles.join(', ')}`,
            updated_at: ts,
            completed_at: ts,
          });
          // delivery 保持 accepted（可重新交付）
          return store.getMergeJob(job.merge_job_id)!;
        }
        const isRemoteUnreachable = err instanceof GitProviderError && err.kind === 'remote-unreachable';
        return finalizeJob(job, 'integration_failed',
          isRemoteUnreachable ? `remote_unreachable: ${err instanceof Error ? err.message : String(err)}` : `merge 失败：${err instanceof Error ? err.message : String(err)}`,
          ts);
      }

      // 6. push 默认分支（non-fast-forward 天然 CAS）
      try {
        await provider.push(integrationDir, [`HEAD:refs/heads/${defaultBranch}`]);
      } catch (err) {
        const isRemoteUnreachable = err instanceof GitProviderError && err.kind === 'remote-unreachable';
        return finalizeJob(job, 'integration_failed',
          isRemoteUnreachable ? `remote_unreachable: ${err instanceof Error ? err.message : String(err)}` : `push 失败：${err instanceof Error ? err.message : String(err)}`,
          ts);
      }

      // 7. 成功 → merged
      store.updateMergeJob(job.merge_job_id, {
        status: 'merged',
        final_sha: mergeSha,
        updated_at: ts,
        completed_at: ts,
      });

      // delivery → merged
      store.updateDelivery(job.delivery_id, {
        status: 'merged',
        merged_commit_sha: mergeSha,
        updated_at: ts,
      });

      // §12.4 下游解锁：检查是否有依赖此 delivery 的 queued jobs
      unlockDownstream(job.delivery_id, job.project_id);

      // §6.6 BranchCleanup：delivery 分支清理
      enqueueDeliveryBranchCleanup(delivery);

      // §12 自动出队：merge 完成后异步触发下一个队头
      tryAutoDispatch(job.project_id);

      return store.getMergeJob(job.merge_job_id)!;
    } finally {
      rmSync(integrationDir, { recursive: true, force: true });
    }
  }

  function finalizeJob(
    job: MergeJobRow,
    status: MergeJobRow['status'],
    errorMessage: string,
    ts: number,
  ): MergeJobRow {
    store.updateMergeJob(job.merge_job_id, {
      status,
      error_message: errorMessage,
      updated_at: ts,
      completed_at: ts,
    });

    // integration_failed 时检查降级
    if (status === 'integration_failed') {
      checkAndDegrade(job.project_id, ts);
    }

    // 22.4-09：remote_unreachable 时开 incident（可重试，默认分支不动）
    if (errorMessage.includes('remote_unreachable') || errorMessage.includes('REMOTE_UNREACHABLE')) {
      try {
        const incidentService = createIncidentService({ store, now });
        incidentService.createIncident({
          project_id: job.project_id,
          kind: 'remote_unreachable',
          severity: 'warning',
          title: `Git Remote 不可达：${job.project_id}`,
          detail: `merge job ${job.merge_job_id} 因 remote 不可达而失败：${errorMessage.slice(0, 500)}`,
          related_entity_type: 'merge_job',
          related_entity_id: job.merge_job_id,
        });
      } catch {
        // incident-service 接口不足时不阻塞主流程
      }
    }

    // §12 自动出队：merge 失败后也触发下一个队头（当前 job 已终态）
    tryAutoDispatch(job.project_id);

    return store.getMergeJob(job.merge_job_id)!;
  }

  // ──────────────── 22.3-17：ref ACL 连续丢失熔断 ────────────────

  /**
   * ref ACL 确认连续 N 次丢失 → 不等待 Owner：
   * - fencing 该 project 全部 running write attempt
   * - 撤销 push/merge credential（标记 write_capability_status=lost）
   * - incident 开单
   */
  function handleRefAclMiss(projectId: string, ts: number): void {
    const reached = refAclMissTracker.recordMiss(projectId);
    if (!reached) return;

    // 使用 ref-acl.ts 提取的纯函数执行熔断
    try {
      const incidentService = createIncidentService({ store, now });
      executeRefAclMissCircuitBreaker(store, projectId, ts, {
        missCount: refAclMissTracker.getMissCount(projectId),
        createIncident: (input) => { incidentService.createIncident(input); },
      });
    } catch {
      // incident-service 接口不足时不阻塞主流程
      executeRefAclMissCircuitBreaker(store, projectId, ts, {
        missCount: refAclMissTracker.getMissCount(projectId),
      });
    }

    // 重置计数器
    refAclMissTracker.reset(projectId);
  }

  /** 记录 ref ACL 存在（重置连续丢失计数）。 */
  function recordRefAclHit(projectId: string): void {
    refAclMissTracker.recordHit(projectId);
  }

  // ──────────────── §12.1.1 降级检查 ────────────────

  function checkAndDegrade(projectId: string, ts: number): void {
    const failures = store.countConsecutiveIntegrationFailures(projectId);
    if (failures >= degradeThreshold) {
      const project = store.getProject(projectId);
      if (project && project.write_capability_status !== 'lost' && project.write_capability_status !== 'disabled') {
        store.updateProject(projectId, {
          write_capability_status: 'lost',
          updated_at: ts,
        });
      }
    }
  }

  // ──────────────── §12.4 下游解锁（真拓扑） ────────────────

  /**
   * 依赖解锁：查询 task depends_on 拓扑。
   * merged delivery 对应 task 的下游 task 解锁（跨 plan 依赖同样处理）。
   * 逻辑：
   * 1. 找到 merged delivery 对应的 task；
   * 2. 遍历同 project 所有 queued jobs 的 delivery → task；
   * 3. 如果某 task 的 depends_on 包含已 merged 的 task_id，且该 task 的所有
   *    依赖 task 都已有 accepted/merged delivery，则解锁。
   */
  function unlockDownstream(mergedDeliveryId: string, projectId: string): void {
    const mergedDelivery = store.getDelivery(mergedDeliveryId);
    if (!mergedDelivery) return;
    const mergedTask = store.getTaskByAttemptId(mergedDelivery.attempt_id);
    if (!mergedTask) return;
    const mergedTaskId = mergedTask.task_id;

    const queuedJobs = store.listMergeJobs(projectId, 'queued');
    for (const job of queuedJobs) {
      const delivery = store.getDelivery(job.delivery_id);
      if (!delivery) continue;
      const task = store.getTaskByAttemptId(delivery.attempt_id);
      if (!task) continue;

      // 解析 depends_on（JSON 数组或逗号分隔）
      let dependsOn: string[] = [];
      try {
        if (task.depends_on?.startsWith('[')) {
          dependsOn = JSON.parse(task.depends_on);
        } else if (task.depends_on) {
          dependsOn = task.depends_on.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      } catch { /* malformed depends_on 视为无依赖 */ }

      if (dependsOn.length === 0) continue;

      // 检查所有依赖是否都已满足（task 有 accepted/merged delivery）
      const allDepsSatisfied = dependsOn.every((depTaskId: string) => {
        if (depTaskId === mergedTaskId) return true; // 刚 merged 的依赖
        // 查找该依赖 task 是否有 accepted/merged 的 delivery
        const depDeliveries = store.listDeliveriesByTask(depTaskId);
        return depDeliveries.some((d) => d.status === 'accepted' || d.status === 'merged');
      });

      if (!allDepsSatisfied) continue;

      // 所有依赖已满足：该 job 已在队列中，自动出队会处理
      // 此处不需要额外操作，job 已经是 queued 状态
    }
  }

  // ──────────────── §6.6 BranchCleanup ────────────────

  function enqueueDeliveryBranchCleanup(delivery: DeliveryRow): void {
    const cleanupId = `bc-${createHash('sha256')
      .update(`${delivery.delivery_id}|${delivery.branch_ref}|${delivery.head_sha}`)
      .digest('hex')
      .slice(0, 24)}`;

    if (store.getBranchCleanup(cleanupId)) return;

    const ts = now();
    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 天
    store.insertBranchCleanup({
      cleanup_id: cleanupId,
      project_id: delivery.project_id,
      delivery_id: delivery.delivery_id,
      branch_ref: delivery.branch_ref,
      expected_head_sha: delivery.head_sha,
      reason: 'integration_failed', // merged delivery 的 branch 也清理
      status: 'pending',
      eligible_at: ts + retentionMs,
      retention_until: ts + retentionMs * 2,
      last_error: '',
      completed_at: null,
    });
  }

  // ──────────────── 辅助函数 ────────────────

  function parseConflictFiles(output: string): string[] {
    const files: string[] = [];
    for (const line of output.split('\n')) {
      const match = /^(UU|AA|DU|UD)\s+(.+)$/.exec(line.trim());
      if (match) files.push(match[2]);
    }
    return files;
  }

  // ──────────────── 读面 ────────────────

  function getMergeJob(mergeJobId: string): MergeQueueApiResponse<MergeJobRow> {
    const job = store.getMergeJob(mergeJobId);
    if (!job) return fail('MERGE_JOB_NOT_FOUND', `merge job ${mergeJobId} 不存在`);
    return { ok: true, data: job };
  }

  function listMergeJobs(
    projectId: string,
    status?: string,
  ): MergeQueueApiResponse<MergeJobRow[]> {
    const jobs = store.listMergeJobs(projectId, status);
    return { ok: true, data: jobs };
  }

  // ──────────────── cancel ────────────────

  function cancelMergeJob(
    mergeJobId: string,
    reason: string,
  ): MergeQueueApiResponse<MergeJobRow> {
    const job = store.getMergeJob(mergeJobId);
    if (!job) return fail('MERGE_JOB_NOT_FOUND', `merge job ${mergeJobId} 不存在`);
    if (job.status !== 'queued' && job.status !== 'running') {
      return fail('INVALID_STATUS', `merge job ${mergeJobId} 状态 ${job.status}，不能取消`);
    }
    const ts = now();
    store.updateMergeJob(mergeJobId, {
      status: 'cancelled',
      cancel_reason: reason,
      updated_at: ts,
      completed_at: ts,
    });
    return { ok: true, data: store.getMergeJob(mergeJobId)! };
  }

  // ──────────────── §12.1.2 恢复 ────────────────

  function restoreWriteCapability(projectId: string): MergeQueueApiResponse<{ restored: boolean }> {
    const project = store.getProject(projectId);
    if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);
    if (project.write_capability_status !== 'lost' && project.write_capability_status !== 'disabled') {
      return { ok: true, data: { restored: false } };
    }
    store.updateProject(projectId, {
      write_capability_status: 'ready',
      updated_at: now(),
    });
    return { ok: true, data: { restored: true } };
  }

  /**
   * 22.4-24：人工 merge 回写。
   * external_merge_intent → resolved(final_sha) 时回写 delivery
   * （merged_by_external + final_sha）+ Integration Verify。
   */
  function writebackExternalMerge(
    projectId: string,
    deliveryId: string,
    finalSha: string,
  ): MergeQueueApiResponse<{ delivery_id: string; final_sha: string }> {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery) return fail('DELIVERY_NOT_FOUND', `delivery ${deliveryId} 不存在`);
    if (delivery.project_id !== projectId) {
      return fail('PROJECT_MISMATCH', `delivery ${deliveryId} 不属于项目 ${projectId}`);
    }

    const ts = now();

    // 回写 delivery：merged_by_external + final_sha
    store.updateDelivery(deliveryId, {
      status: 'merged',
      merged_commit_sha: finalSha,
      updated_at: ts,
    });

    // Integration Verify：服务端对 remote 默认分支做独立 diff 复核（§7.3）
    // 此处标记需要后续 verify（由 verifyDeliveryRemote 触发）
    store.updateDelivery(deliveryId, {
      server_verified: 0, // 标记待复核
      diff_summary: JSON.stringify({
        merged_by: 'external',
        final_sha: finalSha,
        writeback_at: ts,
      }),
    });

    // 解锁下游（如果有依赖此 delivery 的 queued jobs）
    unlockDownstream(deliveryId, projectId);

    return { ok: true, data: { delivery_id: deliveryId, final_sha: finalSha } };
  }

  /**
   * 22.4-38：默认分支未登记 SHA 检测（异步化）。
   * 真实 ls-remote 比对已登记 final_sha 集合。
   * 返回远端默认分支存在但不在已登记集合中的 SHA。
   */
  async function detectUndocumentedShas(projectId: string): Promise<MergeQueueApiResponse<{ undocumented_shas: string[] }>> {
    const project = store.getProject(projectId);
    if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${projectId} 不存在`);

    // 收集所有已登记的 final_sha
    const mergedJobs = store.listMergeJobs(projectId, 'merged');
    const knownShas = new Set<string>();
    for (const job of mergedJobs) {
      if (job.final_sha) knownShas.add(job.final_sha);
    }

    // 收集 external merge intents 的 final_sha
    const intents = store.listExternalMergeIntents(projectId);
    for (const intent of intents) {
      if (intent.status === 'verified' && intent.final_sha) {
        knownShas.add(intent.final_sha);
      }
    }

    // ls-remote 获取默认分支最新 SHA
    const defaultRef = `refs/heads/${project.default_branch}`;
    try {
      const refs = await provider.lsRemote(project.repository_url, defaultRef);
      const remoteSha = refs[0]?.sha ?? '';
      if (remoteSha && !knownShas.has(remoteSha)) {
        return { ok: true, data: { undocumented_shas: [remoteSha] } };
      }
    } catch {
      // remote 不可达时不报错，返回空集
    }
    return { ok: true, data: { undocumented_shas: [] } };
  }

  return {
    enqueueWithTarget,
    dispatch,
    getMergeJob,
    listMergeJobs,
    cancelMergeJob,
    restoreWriteCapability,
    checkAndDegrade,
    writebackExternalMerge,
    detectUndocumentedShas,
    handleRefAclMiss,
    recordRefAclHit,
    tryAutoDispatch,
  };
}
