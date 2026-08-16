/**
 * V2 Git Workspace：Prepare / Finalize 双状态机（Phase 4）
 *
 * 对应 docs/distributed-multi-node-development-plan.md §6.2（clone-per-attempt
 * 目录布局）、§6.3（分支命名，完整 ref 落库）、§6.4（Prepare 顺序）、§6.5
 * （Finalize 顺序）、§6.6（清理与孤儿约束）。
 *
 * 服务端控制、Node 执行分离：本阶段在服务端测试进程内模拟 Node 侧执行
 * （真实 daemon 接线见 docs/runbooks/git-workspace.md 收尾项清单），每步先把
 * 状态持久化到 attempt_workspaces 再执行命令，进程任意时刻被杀死后重入都从
 * 持久状态收敛；瞬时失败（网络、超时、输出超限）留在当前状态可重试，确定性
 * 校验失败才落 failed:* 终态。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteStore } from '../../../db/sqlite-store.js';
import type { AttemptMarkerPayload, AttemptWorkspaceRow } from '../../../types/v2-git.js';
import {
  ATTEMPT_BRANCH_PREFIX,
  ATTEMPT_MARKER_FILENAME,
  ATTEMPT_MARKER_REF_PREFIX,
  ATTEMPT_MARKER_SCHEMA_VERSION,
  DISK_WATERMARK_REJECT_PERCENT,
} from '../../../types/v2-git.js';
import { verifyAttemptToken, type V2CredentialKey } from '../credentials.js';
import { newDeliveryId, verifyDeliveryAgainstRemote } from '../delivery-service.js';
import { attemptTokenDigest, markerCanonicalJson, signAttemptMarker } from './marker.js';
import { findOwnershipViolations } from './ownership-gate.js';
import { GitProviderError, type GitProvider } from './provider.js';
import { executeRefAclMissCircuitBreaker, RefAclMissTracker } from './ref-acl.js';

export interface WorkspacePrepareResult {
  attempt_id: string;
  prepare_state: string;
  workspace_dir: string;
  branch_ref: string;
  marker_ref: string;
  base_sha: string;
}

export interface WorkspaceFinalizeResult {
  attempt_id: string;
  finalize_state: string;
  delivery_id: string;
  head_sha: string;
  branch_ref: string;
  changed_files: string[];
  server_verified: boolean;
  status: string;
}

export interface WorkspaceHooks {
  /** 模拟 clone 前进程被杀（抛出 = 未捕获中断，状态停留在 cloning）。 */
  beforeClone?: (attemptId: string) => void;
  /** 模拟 marker 写入失败（确定性失败分支）。 */
  beforeMarkerWrite?: (attemptId: string) => void;
  /** 模拟 commit 前进程被杀。 */
  beforeCommit?: (attemptId: string) => void;
  /** 模拟 push 前进程被杀。 */
  beforePush?: (attemptId: string) => void;
}

export interface WorkspaceServiceOptions {
  store: SqliteStore;
  provider: GitProvider;
  /** marker 签发密钥环（进程内 Node signing key 替身，daemon 接线收尾项）。 */
  keyring: readonly V2CredentialKey[];
  /** §6.2 <node-data>/projects 根；工作区 = <root>/<project_id>/<attempt_id>。 */
  nodeCacheRoot: string;
  now?: () => number;
  /** R1C-007 水位注入点；缺省对 nodeCacheRoot 做 statfs 实测。 */
  diskUsagePercent?: () => number;
  /** 拒绝新 prepare 的水位阈值（默认 85）。 */
  diskWatermarkPercent?: number;
  /** 服务端复核克隆的临时目录根。 */
  verifyDirRoot?: string;
  hooks?: WorkspaceHooks;
  /** 22.3-17：ref ACL miss 跟踪器（push_forbidden 时触发熔断）。 */
  refAclMissTracker?: RefAclMissTracker;
  /** 22.3-17：incident 创建回调（避免循环依赖 incident-service）。 */
  createIncident?: (input: {
    project_id: string;
    kind: string;
    severity: 'critical';
    title: string;
    detail: string;
    related_entity_type: string;
    related_entity_id: string;
  }) => void;
}

type WsResponse<T> =
  | { ok: true; data: T }
  | { ok: false; data: null; error: { code: string; message: string } };

function fail<T = never>(code: string, message: string): WsResponse<T> {
  return { ok: false, data: null, error: { code, message } };
}

/** prepare 只接受非终态 attempt（§5.1 attempt 生命周期）。 */
const PREPARABLE_ATTEMPT_STATUSES = new Set(['pending', 'claiming', 'executing', 'pending_recovery']);

// ──────────────── §6.4 remote fingerprint（注册锚点 + 历史连续性） ────────────────

/**
 * fingerprint = v1:<anchor_sha>:<sha256(url \n branch \n anchor)>。
 * anchor 是注册（或首次 prepare 补登记）时默认分支的 head commit；prepare 校验
 * anchor 仍是当前默认分支历史的祖先——远端被换成别的仓库、或默认分支被 force
 * 改写都判 mismatch（§6.4 步骤 3）；fast-forward 不受影响。
 */
export function computeRemoteFingerprint(remoteUrl: string, defaultBranch: string, anchorSha: string): string {
  const digest = createHash('sha256')
    .update(`${remoteUrl}\n${defaultBranch}\n${anchorSha}`, 'utf8')
    .digest('hex');
  return `v1:${anchorSha}:${digest}`;
}

export function parseRemoteFingerprint(value: string): { anchorSha: string; digest: string } | null {
  const match = /^v1:([0-9a-f]{40}):([0-9a-f]{64})$/.exec(value.trim());
  if (!match) return null;
  return { anchorSha: match[1], digest: match[2] };
}

/** §6.3 分支规范：attempt_id 只允许 [A-Za-z0-9._-]，完整 ref 落库。 */
export function attemptBranchRef(attemptId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attemptId)) {
    throw new Error(`attempt_id 不满足分支命名规范：${attemptId}`);
  }
  return `refs/heads/${ATTEMPT_BRANCH_PREFIX}${attemptId}`;
}

export function attemptMarkerRef(attemptId: string): string {
  return `${ATTEMPT_MARKER_REF_PREFIX}${attemptId}`;
}

export function createWorkspaceService(options: WorkspaceServiceOptions) {
  const { store, provider, keyring } = options;
  const now = options.now ?? (() => Date.now());
  const watermark = options.diskWatermarkPercent ?? DISK_WATERMARK_REJECT_PERCENT;
  const verifyDirRoot = options.verifyDirRoot ?? tmpdir();
  const hooks = options.hooks ?? {};
  const resolvedKey = keyring.reduce<V2CredentialKey | null>(
    (latest, key) => (!latest || key.key_version > latest.key_version ? key : latest),
    null,
  );
  if (!resolvedKey) throw new Error('workspace service 需要至少一把 V2 凭据密钥（marker 签发）');
  const signingKey: V2CredentialKey = resolvedKey;

  /** R1C-007：默认 statfs 实测；测试可注入。 */
  const diskUsedPercent: () => number = options.diskUsagePercent ?? (() => {
    mkdirSync(options.nodeCacheRoot, { recursive: true });
    const stat = statfsSync(options.nodeCacheRoot);
    if (!stat.blocks) return 0;
    return Math.round(((stat.blocks - stat.bavail) / stat.blocks) * 1000) / 10;
  });

  function transition(attemptId: string, fields: Partial<AttemptWorkspaceRow>): void {
    store.updateAttemptWorkspace(attemptId, { ...fields, updated_at: now() });
  }

  function terminalPrepare<T>(attemptId: string, code: string, message: string): WsResponse<T> {
    transition(attemptId, {
      prepare_state: `failed:${code}` as AttemptWorkspaceRow['prepare_state'],
      prepare_error: message,
    });
    return fail<T>(`PREPARE_FAILED_${code.toUpperCase()}`, message);
  }

  function terminalFinalize<T>(attemptId: string, code: string, message: string): WsResponse<T> {
    transition(attemptId, {
      finalize_state: `failed:${code}` as AttemptWorkspaceRow['finalize_state'],
      finalize_error: message,
    });
    return fail<T>(`FINALIZE_FAILED_${code.toUpperCase()}`, message);
  }

  /** 瞬时失败：状态不变，可重入重试。 */
  function transient<T>(code: string, err: unknown): WsResponse<T> {
    const message = err instanceof GitProviderError
      ? `${err.kind}: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    return fail<T>(code, message);
  }

  /** 工作目录是否是可用克隆（HEAD 可解析；被杀的半成品 clone 判不可用）。 */
  async function hasUsableClone(dir: string): Promise<boolean> {
    return (await provider.readRef(dir, 'HEAD')) !== null;
  }

  // ──────────────── §6.4 Workspace Prepare ────────────────

  /**
   * pending → cloning → checking_base → creating_branch → ready。
   * 每步先落状态再执行；重入从持久状态继续（幂等）。确定性失败 → failed:*（终态）。
   */
  async function prepare(
    attemptId: string,
    input: { attempt_token?: string; base_sha?: string } = {},
  ): Promise<WsResponse<WorkspacePrepareResult>> {
    const attempt = store.getTaskAttempt(attemptId);
    if (!attempt) return fail('ATTEMPT_NOT_FOUND', `attempt ${attemptId} 不存在`);
    if (!PREPARABLE_ATTEMPT_STATUSES.has(attempt.status)) {
      return fail('ATTEMPT_TERMINAL', `attempt ${attemptId} 状态 ${attempt.status}，不允许 prepare`);
    }
    const project = store.getProject(attempt.project_id);
    if (!project || !project.repository_url) {
      return fail('PROJECT_NOT_CONFIGURED', `项目 ${attempt.project_id} 未配置 repository_url`);
    }

    let ws = store.getAttemptWorkspace(attemptId);
    const fresh = !ws;
    if (!ws) {
      const ts = now();
      // 分支/marker/目录名都是 attempt_id 的确定函数（§6.3），创建时即落库，
      // 中断扫描在 cloning 阶段也能拿到归属 ref。
      ws = {
        attempt_id: attemptId,
        project_id: attempt.project_id,
        task_id: attempt.task_id,
        node_id: attempt.node_id,
        workspace_dir: join(options.nodeCacheRoot, attempt.project_id, attemptId),
        branch_ref: attemptBranchRef(attemptId),
        marker_ref: attemptMarkerRef(attemptId),
        remote_url: project.repository_url,
        remote_fingerprint: '',
        base_sha: '',
        prepare_state: 'pending',
        prepare_error: '',
        finalize_state: 'idle',
        finalize_error: '',
        head_sha: '',
        marker_sha: '',
        bva2_digest: '',
        delivery_id: '',
        created_at: ts,
        updated_at: ts,
      };
      store.insertAttemptWorkspace(ws);
    }
    if (ws.prepare_state.startsWith('failed:')) {
      return fail('PREPARE_TERMINAL', `工作区已终态 ${ws.prepare_state}：${ws.prepare_error}`);
    }
    if (ws.finalize_state === 'delivered' || ws.finalize_state === 'pending_recovery') {
      return fail('FINALIZED', `工作区 finalize=${ws.finalize_state}，不能重复 prepare`);
    }

    // bva2 摘要：token 在本进程内模拟 Node 上报路径，先验签再摘录（R1C-005）。
    let bva2Digest = ws.bva2_digest;
    if (input.attempt_token && !bva2Digest) {
      const verified = verifyAttemptToken(input.attempt_token, {
        attemptId,
        taskId: attempt.task_id,
        generation: attempt.attempt_generation,
        scope: 'ownership',
      }, { keys: [...keyring] });
      if (!verified.ok) {
        return fail('ATTEMPT_TOKEN_INVALID', `bva2 验证失败：${verified.reason}`);
      }
      bva2Digest = attemptTokenDigest(input.attempt_token);
      transition(attemptId, { bva2_digest: bva2Digest });
    }

    const dir = join(options.nodeCacheRoot, attempt.project_id, attemptId);
    const branchRef = attemptBranchRef(attemptId);
    const markerRef = attemptMarkerRef(attemptId);

    // 状态推进循环：每轮从持久状态重读，单次调用内完成多步但不依赖内存状态。
    for (let guard = 0; guard < 8; guard++) {
      const current = store.getAttemptWorkspace(attemptId);
      if (!current) return fail('WORKSPACE_LOST', '工作区记录消失');
      const state = current.prepare_state;

      if (state === 'ready') {
        return {
          ok: true,
          data: {
            attempt_id: attemptId,
            prepare_state: 'ready',
            workspace_dir: current.workspace_dir || dir,
            branch_ref: current.branch_ref || branchRef,
            marker_ref: current.marker_ref || markerRef,
            base_sha: current.base_sha,
          },
        };
      }

      if (state === 'pending') {
        // R1C-007：水位门禁只挡"新 prepare"（中断重入不重复受罚）。
        if (fresh) {
          const used = diskUsedPercent();
          if (used >= watermark) {
            return terminalPrepare(attemptId, 'disk_watermark', `磁盘使用率 ${used}% ≥ 阈值 ${watermark}%，拒绝新 prepare`);
          }
        }
        transition(attemptId, { prepare_state: 'cloning' });
        continue;
      }

      if (state === 'cloning') {
        hooks.beforeClone?.(attemptId);
        if (await hasUsableClone(dir)) {
          try {
            await provider.fetch(dir);
          } catch (err) {
            return transient('FETCH_FAILED', err);
          }
        } else {
          // 半成品目录（上次 clone 中途被杀）整体丢弃重来。
          rmSync(dir, { recursive: true, force: true });
          try {
            await provider.clone(project.repository_url, dir);
          } catch (err) {
            return transient('CLONE_FAILED', err);
          }
          if (!(await hasUsableClone(dir))) {
            return transient('CLONE_INCOMPLETE', 'clone 结束但工作目录不可用');
          }
        }
        transition(attemptId, { prepare_state: 'checking_base' });
        continue;
      }

      if (state === 'checking_base') {
        const defaultRef = `refs/heads/${project.default_branch}`;
        let remoteHead: string | null = null;
        try {
          remoteHead = (await provider.lsRemote(project.repository_url, defaultRef))[0]?.sha ?? null;
        } catch (err) {
          return transient('LS_REMOTE_FAILED', err);
        }
        if (!remoteHead) {
          return transient('DEFAULT_BRANCH_MISSING', `远端缺少 ${defaultRef}`);
        }

        // §6.4 步骤 3：remote fingerprint 校验（注册锚点仍可达）。
        let registered = project.repository_fingerprint;
        if (!registered) {
          // 首次接入补登记；仓库 URL 改变必须走显式 rebind（§2.4），不走这里。
          registered = computeRemoteFingerprint(project.repository_url, project.default_branch, remoteHead);
          store.updateProject(project.project_id, {
            repository_fingerprint: registered,
            updated_at: now(),
          });
        }
        const parsed = parseRemoteFingerprint(registered);
        if (!parsed) {
          return terminalPrepare(attemptId, 'remote_fingerprint_mismatch', `项目 fingerprint 格式非法：${registered.slice(0, 16)}…`);
        }
        const recomputed = parseRemoteFingerprint(
          computeRemoteFingerprint(project.repository_url, project.default_branch, parsed.anchorSha),
        );
        if (!recomputed || recomputed.digest !== parsed.digest) {
          return terminalPrepare(attemptId, 'remote_fingerprint_mismatch', 'fingerprint 摘要与注册值不符（URL/分支被改绑）');
        }
        let anchorReachable = false;
        try {
          anchorReachable = (await provider.mergeBase(dir, parsed.anchorSha, remoteHead)) === parsed.anchorSha;
        } catch {
          anchorReachable = false;
        }
        if (!anchorReachable) {
          return terminalPrepare(attemptId, 'remote_fingerprint_mismatch', `远端与注册锚点 ${parsed.anchorSha.slice(0, 12)} 历史断裂（换仓或 force 改写）`);
        }

        // §6.4 步骤 4：服务端声明的 base_sha 可达（mergeBase 校验）。
        const baseSha = input.base_sha || current.base_sha || remoteHead;
        let baseReachable = false;
        try {
          baseReachable = (await provider.mergeBase(dir, baseSha, remoteHead)) === baseSha;
        } catch {
          baseReachable = false;
        }
        if (!baseReachable) {
          return terminalPrepare(attemptId, 'base_unreachable', `base ${baseSha.slice(0, 12)} 在 ${defaultRef} 历史中不可达`);
        }

        transition(attemptId, {
          prepare_state: 'creating_branch',
          remote_fingerprint: registered,
          base_sha: baseSha,
        });
        continue;
      }

      if (state === 'creating_branch') {
        const baseSha = current.base_sha;
        if (!baseSha) {
          return transient('BASE_SHA_MISSING', '工作区缺少 base_sha（状态损坏，需人工检查）');
        }
        try {
          await provider.checkoutNewBranch(dir, branchRef, baseSha);
        } catch (err) {
          return transient('BRANCH_CREATE_FAILED', err);
        }

        // §6.4 步骤 6：owner-only signed marker（R1C-005）。
        // hook 与真实写盘同在 try 内：注入的写失败与真实写失败都收敛到
        // failed:marker_write_failed 终态。
        const payload: Omit<AttemptMarkerPayload, 'schema_version'> = {
          attempt_id: attemptId,
          task_id: attempt.task_id,
          attempt_generation: attempt.attempt_generation,
          node_id: attempt.node_id,
          signing_key_generation: signingKey.key_version,
          branch_ref: branchRef,
          base_sha: baseSha,
          head_sha: '',
          bva2_digest: bva2Digest,
          created_at: now(),
        };
        const signed = signAttemptMarker(payload, signingKey);
        try {
          hooks.beforeMarkerWrite?.(attemptId);
          const markerPath = join(dir, ATTEMPT_MARKER_FILENAME);
          writeFileSync(markerPath, `${JSON.stringify(signed)}\n`, { mode: 0o600 });
          chmodSync(markerPath, 0o600);
          // 本机私有文件不入库（§6.5：marker 只走 refs/biao/attempt-markers/*）。
          const excludePath = join(dir, '.git', 'info', 'exclude');
          const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
          if (!existing.split('\n').includes(ATTEMPT_MARKER_FILENAME)) {
            appendFileSync(excludePath, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${ATTEMPT_MARKER_FILENAME}\n`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          transition(attemptId, {
            prepare_state: 'failed:marker_write_failed' as AttemptWorkspaceRow['prepare_state'],
            prepare_error: message,
          });
          return fail('PREPARE_FAILED_MARKER_WRITE_FAILED', message);
        }
        transition(attemptId, { prepare_state: 'ready' });
        continue;
      }

      return fail('PREPARE_STATE_UNKNOWN', `未知 prepare 状态 ${state}`);
    }
    return fail('PREPARE_LOOP_GUARD', 'prepare 状态推进超过上限（疑似状态机死循环）');
  }

  // ──────────────── §6.5 Workspace Finalize：commit_and_push ────────────────

  async function commitAndPush(
    attemptId: string,
    input: { artifact_refs?: Array<{ artifact_id: string }>; author?: string } = {},
  ): Promise<WsResponse<WorkspaceFinalizeResult>> {
    const attempt = store.getTaskAttempt(attemptId);
    if (!attempt) return fail('ATTEMPT_NOT_FOUND', `attempt ${attemptId} 不存在`);
    const ws = store.getAttemptWorkspace(attemptId);
    if (!ws) return fail('WORKSPACE_NOT_FOUND', `attempt ${attemptId} 无工作区（先 prepare）`);
    if (ws.prepare_state !== 'ready') {
      return fail('PREPARE_NOT_READY', `prepare_state=${ws.prepare_state}，只有 ready 才能 finalize`);
    }
    if (ws.finalize_state.startsWith('failed:')) {
      return fail('FINALIZE_TERMINAL', `finalize 已终态 ${ws.finalize_state}：${ws.finalize_error}`);
    }
    if (ws.finalize_state === 'delivered' || ws.finalize_state === 'pending_recovery') {
      const existing = ws.delivery_id ? store.getDelivery(ws.delivery_id) : undefined;
      if (existing) return { ok: true, data: resultFrom(ws, existing.status, existing) };
      return fail('DELIVERY_LOST', `finalize=${ws.finalize_state} 但 delivery 记录缺失（人工检查）`);
    }

    const project = store.getProject(ws.project_id);
    if (!project) return fail('PROJECT_NOT_FOUND', `项目 ${ws.project_id} 不存在`);

    // §7.1 ownership snapshot：没有快照即无法界定越界 → fail-closed。
    const snapshots = store.listOwnershipSnapshotsByAttempt(attemptId);
    if (snapshots.length === 0) {
      return terminalFinalize(attemptId, 'ownership_snapshot_missing', 'attempt 无 ownership snapshot，拒绝 finalize（fail-closed）');
    }
    const activeSnapshot = [...snapshots].reverse().find((s) => s.released_at === null || s.released_at === undefined);
    const writeGlobs = JSON.parse((activeSnapshot ?? snapshots.at(-1))!.files) as string[];

    // ── committing：commit → ownership 门禁（§6.5 步骤 4/5） ──
    if (ws.finalize_state === 'idle' || ws.finalize_state === 'committing') {
      transition(attemptId, { finalize_state: 'committing' });
      hooks.beforeCommit?.(attemptId);
      let head: string;
      try {
        head = await provider.commitAll(ws.workspace_dir, `biao: attempt ${attemptId} (task ${ws.task_id})`, {
          exclude: [ATTEMPT_MARKER_FILENAME],
          author: input.author ?? `node-${ws.node_id || 'sim'}`,
        });
      } catch (err) {
        return transient('COMMIT_FAILED', err);
      }
      let changed: string[];
      try {
        changed = await provider.diffNameOnly(ws.workspace_dir, ws.base_sha, head);
      } catch (err) {
        return transient('DIFF_FAILED', err);
      }
      const violations = findOwnershipViolations(changed, writeGlobs);
      if (violations.length > 0) {
        // 越界文件：拒绝 + 终态，绝不 push、不生成 delivery（§7.3 前置门禁）。
        return terminalFinalize(attemptId, 'ownership_violation', `ownership 外文件进入 commit：${violations.join(', ')}`);
      }
      transition(attemptId, { finalize_state: 'pushing', head_sha: head });
    }

    // ── pushing：CAS push（remote ref 预期不存在）+ signed marker 原子推送 ──
    const beforePush = store.getAttemptWorkspace(attemptId);
    if (!beforePush || !beforePush.head_sha) {
      return fail('HEAD_MISSING', 'finalize 推进前缺少 head_sha（状态损坏）');
    }
    const head = beforePush.head_sha;
    if (beforePush.finalize_state === 'pushing') {
      hooks.beforePush?.(attemptId);
      let remoteBranch: { sha: string } | undefined;
      try {
        remoteBranch = (await provider.lsRemote(project.repository_url, beforePush.branch_ref))[0];
      } catch (err) {
        return transient('LS_REMOTE_FAILED', err);
      }
      if (remoteBranch && remoteBranch.sha !== head) {
        // R1A-001/CAS：remote ref 预期不存在，存在且不同 → delivery invalidated。
        const delivery = recordInvalidatedDelivery(beforePush, 'remote-ref-exists', `远端 ${beforePush.branch_ref} 已存在（head=${remoteBranch.sha.slice(0, 12)}）`);
        return terminalFinalize(attemptId, 'cas_conflict', `CAS 冲突：${delivery?.message ?? '远端 ref 已存在'}（delivery ${delivery?.delivery_id ?? '?'} invalidated）`);
      }

      // §6.5 步骤 6：branch + signed marker 原子推送（marker 带 head_sha）。
      const markerPayload: AttemptMarkerPayload = {
        schema_version: ATTEMPT_MARKER_SCHEMA_VERSION,
        attempt_id: attemptId,
        task_id: attempt.task_id,
        attempt_generation: attempt.attempt_generation,
        node_id: attempt.node_id,
        signing_key_generation: signingKey.key_version,
        branch_ref: beforePush.branch_ref,
        base_sha: beforePush.base_sha,
        head_sha: head,
        bva2_digest: beforePush.bva2_digest,
        created_at: now(),
      };
      const signed = signAttemptMarker(markerPayload, signingKey);
      let markerSha: string;
      try {
        markerSha = await provider.hashObject(beforePush.workspace_dir, JSON.stringify(signed));
      } catch (err) {
        return transient('MARKER_HASH_FAILED', err);
      }
      try {
        if (!remoteBranch) {
          await provider.push(
            beforePush.workspace_dir,
            [`${beforePush.branch_ref}:${beforePush.branch_ref}`, `${markerSha}:${beforePush.marker_ref}`],
            { atomic: true },
          );
        }
      } catch (err) {
        if (err instanceof GitProviderError && err.kind === 'push-rejected') {
          const nowRemote = (await provider.lsRemote(project.repository_url, beforePush.branch_ref).catch(() => []))[0];
          if (nowRemote && nowRemote.sha !== head) {
            const delivery = recordInvalidatedDelivery(beforePush, 'remote-ref-exists', 'push 被拒：远端 ref 已被并发改写');
            return terminalFinalize(attemptId, 'cas_conflict', `CAS 冲突：${delivery?.message ?? ''}（delivery ${delivery?.delivery_id ?? '?'} invalidated）`);
          }
        }
        // 22.3-10：ref ACL 拒绝是确定性失败（配置问题），重试不可能自愈——
        // 落终态 failed:push_forbidden，避免无限可重试的瞬时误分类。
        // 22.3-17：push_forbidden 时触发 ref ACL miss 熔断跟踪。
        if (err instanceof GitProviderError && err.kind === 'push-forbidden') {
          const tracker = options.refAclMissTracker;
          if (tracker) {
            const reached = tracker.recordMiss(ws.project_id);
            if (reached) {
              try {
                executeRefAclMissCircuitBreaker(store, ws.project_id, now(), {
                  missCount: tracker.getMissCount(ws.project_id),
                  createIncident: options.createIncident,
                });
              } catch { /* 不阻塞主流程 */ }
              tracker.reset(ws.project_id);
            }
          }
          return terminalFinalize(attemptId, 'push_forbidden', err.message);
        }
        return transient('PUSH_FAILED', err);
      }
      transition(attemptId, { finalize_state: 'delivering', marker_sha: markerSha });
    }

    // ── delivering：服务端独立复核（§7.3）→ delivery 落库 ──
    const beforeDeliver = store.getAttemptWorkspace(attemptId);
    if (!beforeDeliver) return fail('WORKSPACE_LOST', '工作区记录消失');
    if (beforeDeliver.finalize_state === 'delivering') {
      const verify = await verifyDeliveryAgainstRemote({
        store,
        provider,
        remoteUrl: project.repository_url,
        defaultBranch: project.default_branch,
        attemptId,
        taskId: attempt.task_id,
        attemptGeneration: attempt.attempt_generation,
        nodeId: attempt.node_id,
        baseSha: beforeDeliver.base_sha,
        headSha: head,
        branchRef: beforeDeliver.branch_ref,
        markerRef: beforeDeliver.marker_ref,
        bva2Digest: beforeDeliver.bva2_digest,
        keyring,
        verifyDirRoot,
        now,
      });
      if (!verify.ok && verify.reason.kind === 'ownership-violation') {
        return terminalFinalize(attemptId, 'ownership_violation', `服务端复核：${verify.reason.message}`);
      }
      if (!verify.ok) {
        return terminalFinalize(attemptId, 'server_verify_failed', `服务端复核失败：${verify.reason.message}`);
      }

      // §6.5 步骤 8/9：Artifact 引用核对 → 创建 Delivery。
      const artifactIds = (input.artifact_refs ?? []).map((r) => r.artifact_id);
      const artifactsComplete = artifactIds.every((id) => store.getArtifact(id)?.status === 'complete');
      const deliveryId = newDeliveryId();
      const ts = now();
      const filesJson = JSON.stringify(verify.summary.files);
      const delivery = {
        delivery_id: deliveryId,
        task_id: attempt.task_id,
        attempt_id: attemptId,
        project_id: ws.project_id,
        base_sha: beforeDeliver.base_sha,
        head_sha: head,
        tree_sha: '',
        branch_ref: beforeDeliver.branch_ref,
        changed_files: JSON.stringify(verify.summary.files.map((f) => f.path)),
        patch_digest: createHash('sha256').update(filesJson, 'utf8').digest('hex'),
        artifact_ids: JSON.stringify(artifactIds),
        verify_manifest_digest: createHash('sha256')
          .update(markerCanonicalJson({
            schema_version: ATTEMPT_MARKER_SCHEMA_VERSION,
            attempt_id: attemptId,
            task_id: attempt.task_id,
            attempt_generation: attempt.attempt_generation,
            node_id: attempt.node_id,
            signing_key_generation: signingKey.key_version,
            branch_ref: beforeDeliver.branch_ref,
            base_sha: beforeDeliver.base_sha,
            head_sha: head,
            bva2_digest: beforeDeliver.bva2_digest,
            created_at: ts,
          }), 'utf8')
          .digest('hex'),
        status: (artifactsComplete ? 'pending_review' : 'pending_recovery') as 'pending_review' | 'pending_recovery',
        accepted_commit_sha: '',
        merged_commit_sha: '',
        invalidated_reason: '',
        diff_summary: JSON.stringify(verify.summary),
        server_verified: 1,
        created_at: ts,
        updated_at: ts,
      };
      try {
        store.insertDelivery(delivery);
      } catch {
        // (attempt_id, head_sha) 唯一冲突 = delivering 中断后的重入：复用既有记录。
        const existing = store.getDeliveryByAttemptHead(attemptId, head);
        if (existing) {
          transition(attemptId, {
            finalize_state: existing.status === 'pending_recovery' ? 'pending_recovery' : 'delivered',
            delivery_id: existing.delivery_id,
          });
          return { ok: true, data: resultFrom(store.getAttemptWorkspace(attemptId)!, existing.status, existing) };
        }
        throw new Error('delivery 插入冲突但无法按 (attempt_id, head_sha) 找回');
      }
      transition(attemptId, {
        finalize_state: artifactsComplete ? 'delivered' : 'pending_recovery',
        delivery_id: deliveryId,
      });
      return {
        ok: true,
        data: {
          attempt_id: attemptId,
          finalize_state: artifactsComplete ? 'delivered' : 'pending_recovery',
          delivery_id: deliveryId,
          head_sha: head,
          branch_ref: beforeDeliver.branch_ref,
          changed_files: verify.summary.files.map((f) => f.path),
          server_verified: true,
          status: delivery.status,
        },
      };
    }

    const final = store.getAttemptWorkspace(attemptId);
    if (final && (final.finalize_state === 'pending_recovery' || final.finalize_state === 'delivered') && final.delivery_id) {
      const delivery = store.getDelivery(final.delivery_id);
      if (delivery) return { ok: true, data: resultFrom(final, delivery.status, delivery) };
    }
    return fail('FINALIZE_STATE_UNKNOWN', `finalize 状态 ${final?.finalize_state ?? '(缺失)'} 不可推进`);
  }

  /** CAS 冲突路径：仍生成 invalidated delivery 留审计（不进入 review 通道）。 */
  function recordInvalidatedDelivery(
    ws: AttemptWorkspaceRow,
    reason: string,
    message: string,
  ): { delivery_id: string; message: string } | null {
    const ts = now();
    const deliveryId = newDeliveryId();
    try {
      store.insertDelivery({
        delivery_id: deliveryId,
        task_id: ws.task_id,
        attempt_id: ws.attempt_id,
        project_id: ws.project_id,
        base_sha: ws.base_sha,
        head_sha: ws.head_sha,
        tree_sha: '',
        branch_ref: ws.branch_ref,
        changed_files: '[]',
        patch_digest: '',
        artifact_ids: '[]',
        verify_manifest_digest: '',
        status: 'invalidated',
        accepted_commit_sha: '',
        merged_commit_sha: '',
        invalidated_reason: reason,
        diff_summary: '[]',
        server_verified: 0,
        created_at: ts,
        updated_at: ts,
      });
      transition(ws.attempt_id, { delivery_id: deliveryId });
      return { delivery_id: deliveryId, message };
    } catch {
      return null;
    }
  }

  function resultFrom(ws: AttemptWorkspaceRow, status: string, delivery: { changed_files: string }): WorkspaceFinalizeResult {
    let changed: string[] = [];
    try {
      changed = JSON.parse(delivery.changed_files) as string[];
    } catch {
      changed = [];
    }
    return {
      attempt_id: ws.attempt_id,
      finalize_state: ws.finalize_state,
      delivery_id: ws.delivery_id,
      head_sha: ws.head_sha,
      branch_ref: ws.branch_ref,
      changed_files: changed,
      server_verified: true,
      status,
    };
  }

  // ──────────────── §6.6/§21 中断恢复与孤儿扫描 ────────────────

  /**
   * prepare/finalize 中断（进程杀死）后的 pending_recovery 扫描：
   * 执行中的 prepare/未收敛的 finalize，且 attempt lease 已过期 → 幂等落
   * orphan_recovery_candidates（每 attempt 至多一条 pending，§20.3）。
   */
  function scanInterruptedWorkspaces(): { scanned: number; candidates: number } {
    const ts = now();
    let candidates = 0;
    const rows = store.listInterruptedAttemptWorkspaces();
    for (const row of rows) {
      if (row.lease_expires_at > ts) continue;
      if (row.prepare_state === 'pending') continue; // 尚未开始执行，无需恢复
      const candidateId = `orc-${createHash('sha256').update(row.attempt_id).digest('hex').slice(0, 24)}`;
      if (store.getOrphanRecoveryCandidate(candidateId)) continue;
      try {
        store.insertOrphanRecoveryCandidate({
          candidate_id: candidateId,
          attempt_id: row.attempt_id,
          project_id: row.project_id,
          marker_ref: row.marker_ref,
          branch_ref: row.branch_ref,
          head_sha: row.head_sha,
          bundle_manifest_digest: '',
          recovery_path: 'control-plane-takeover',
          status: 'pending',
          decision: 'pending',
          takeover_reason: 'node-offline-timeout',
          takeover_at: null,
          node_ack_status: 'not-required',
          revision: 0,
          decided_by: '',
          decided_at: null,
          resolved_at: null,
          resolution_evidence_digest: '',
        });
        candidates++;
      } catch {
        // 唯一索引冲突 = 并发扫描已落记录，幂等跳过。
      }
    }
    return { scanned: rows.length, candidates };
  }

  return {
    prepare,
    commitAndPush,
    scanInterruptedWorkspaces,
  };
}
