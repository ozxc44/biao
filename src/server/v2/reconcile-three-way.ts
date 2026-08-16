/**
 * 三方对账（22.2-03 最小实现）
 *
 * SQLite（deliveries/artifacts 元数据）× artifact blob 目录 × git refs
 * （经 provider 只读）三方计数 + digest 比对，输出偏差清单。
 *
 * 语义：对账只报告“不一致”，不自动修复。未解释偏差不视为错误——交 incident
 * 或人工判定。全部一致时 discrepancies 为空。
 *
 * 局限（如实声明）：
 * - git 面只比较 attempt 分支/marker ref 的存在性与 digest，不做 marker
 *   内容验签（验签归 workspace 服务）；
 * - artifact blob 内容 sha256 复核默认开启；超大 blob 可关闭（verifyBlobContent）。
 * - 孤儿 blob（无 SQLite artifact_blobs 行）记 warning，不自动删除。
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SqliteStore } from '../../db/sqlite-store.js';
import type { GitProvider, GitRemoteRef } from './git/provider.js';

export interface ThreeWayReconcileOptions {
  store: SqliteStore;
  /** ArtifactStoreEngine 的根目录（含 sha256/ 子目录）。 */
  artifactRoot: string;
  /** 只读 git provider（lsRemote）。 */
  gitProvider: GitProvider;
  /** 对账项目清单；缺省扫描全部项目。 */
  projectIds?: readonly string[];
  /** 是否逐个读取 blob 内容复核 sha256（捕获“文件名未变但内容被篡改”）。 */
  verifyBlobContent?: boolean;
  now?: () => number;
}

/** 单条偏差。severity: error=同一真相源内硬不一致；warning=孤儿/残留等需人工确认。 */
export interface ThreeWayDiscrepancy {
  kind: string;
  severity: 'error' | 'warning';
  projectId: string;
  subjectType: 'delivery' | 'artifact' | 'blob' | 'git_ref';
  subjectId: string;
  expected?: string;
  actual?: string;
  detail: string;
}

/** 三方各自的计数 + 稳定 digest（作为“某一侧现状”的可复现摘要）。 */
export interface ThreeWaySideSummary {
  source: 'sqlite' | 'artifact_blobs' | 'git_refs';
  count: number;
  digest: string;
}

export interface ThreeWayReconcileReport {
  ran_at: number;
  project_ids: string[];
  summary: {
    sqlite: ThreeWaySideSummary;
    artifact_blobs: ThreeWaySideSummary;
    git_refs: ThreeWaySideSummary;
  };
  discrepancies: ThreeWayDiscrepancy[];
}

function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 收集某 project 在 SQLite 侧的全部 delivery + artifact 元数据行。 */
interface SqliteArtifactMeta {
  artifact_id: string;
  project_id: string;
  sha256: string;
  size_bytes: number;
  status: string;
}

function collectSqliteProjectState(
  store: SqliteStore,
  projectId: string,
): { deliveries: Array<{ delivery_id: string; branch_ref: string; head_sha: string; status: string; artifact_ids: string }>; artifacts: SqliteArtifactMeta[] } {
  const deliveries = store.listDeliveriesByProject(projectId).map((d) => ({
    delivery_id: d.delivery_id,
    branch_ref: d.branch_ref,
    head_sha: d.head_sha,
    status: d.status,
    artifact_ids: d.artifact_ids,
  }));

  // 项目下 artifacts 没有按 project 的直达列表，走 task_attempt 再按 attempt 收集，
  // 并合并 delivery.artifact_ids（artifact-only 完成也引用在 delivery 上）。
  const seen = new Set<string>();
  const artifacts: SqliteArtifactMeta[] = [];
  const attempts = store.listTaskAttemptsByProject(projectId);
  for (const attempt of attempts) {
    for (const row of store.listArtifactsByAttempt(attempt.attempt_id)) {
      if (seen.has(row.artifact_id)) continue;
      seen.add(row.artifact_id);
      artifacts.push({
        artifact_id: row.artifact_id,
        project_id: row.project_id || projectId,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        status: row.status,
      });
    }
  }
  for (const delivery of deliveries) {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(delivery.artifact_ids ?? '[]');
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string');
    } catch {
      // artifact_ids 非 JSON 时按缺省处理；偏差由 digest 层面的不稳定性体现。
    }
    for (const artifactId of ids) {
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      const row = store.getArtifact(artifactId);
      if (!row) continue;
      artifacts.push({
        artifact_id: row.artifact_id,
        project_id: row.project_id || projectId,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        status: row.status,
      });
    }
  }

  return { deliveries, artifacts };
}

/** 遍历 artifact blob 目录，返回 blob 文件名（sha256）→ 大小；畸形文件忽略。 */
function collectBlobDirectory(artifactRoot: string): Map<string, number> {
  const blobs = new Map<string, number>();
  const root = join(artifactRoot, 'sha256');
  if (!existsSync(root)) return blobs;
  for (const prefix of readdirSync(root)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const dir = join(root, prefix);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isFile()) blobs.set(name, stat.size);
      } catch {
        // 读取失败（权限/竞态删除）不算 blob；偏差由 SQLite↔目录计数体现。
      }
    }
  }
  return blobs;
}

/** 读取 blob 内容并复核 sha256 是否与文件名一致（捕获内容篡改）。 */
function verifyBlobContent(artifactRoot: string, sha256: string): { ok: boolean; actual: string } {
  const path = join(artifactRoot, 'sha256', sha256.slice(0, 2), sha256);
  try {
    const content = readFileSync(path);
    const actual = sha256hex(content);
    return { ok: actual === sha256, actual };
  } catch {
    return { ok: false, actual: '<unreadable>' };
  }
}

/** 提取 git refs 中的 attempt 分支/marker 身份：ref 尾段 = attempt_id。 */
function refAttemptId(ref: string): string | null {
  const match = /(?:refs\/heads\/biao\/attempt\/|refs\/biao\/attempt-markers\/)(.+)$/.exec(ref);
  return match?.[1] ?? null;
}

/** 对 refs 集合计算稳定 digest（ref → sha 排序后逐项哈希）。 */
function refsDigest(refs: GitRemoteRef[]): string {
  const hash = createHash('sha256');
  for (const { ref, sha } of [...refs].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))) {
    hash.update(`${ref}\u0000${sha}\n`);
  }
  return hash.digest('hex');
}

/**
 * 执行三方对账。返回报告：三方各侧 count + digest，加上逐条偏差。
 * 偏差仅描述不一致，不自动修复。
 */
export async function reconcileThreeWay(
  options: ThreeWayReconcileOptions,
): Promise<ThreeWayReconcileReport> {
  const { store, artifactRoot, gitProvider } = options;
  const now = options.now ?? (() => Date.now());
  const verifyContent = options.verifyBlobContent ?? true;

  const projects = options.projectIds && options.projectIds.length > 0
    ? options.projectIds
      .map((id) => store.getProject(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
    : store.listProjects();
  const projectIds = projects.map((p) => p.project_id);

  const sqliteRows: Array<{ delivery_id: string; branch_ref: string; head_sha: string; status: string }> = [];
  const sqliteArtifacts: SqliteArtifactMeta[] = [];
  for (const project of projects) {
    const state = collectSqliteProjectState(store, project.project_id);
    sqliteRows.push(...state.deliveries);
    sqliteArtifacts.push(...state.artifacts);
  }

  const discrepancies: ThreeWayDiscrepancy[] = [];

  /* ---- SQLite 侧 digest ---- */
  const sqliteHash = createHash('sha256');
  for (const d of [...sqliteRows].sort((a, b) => (a.delivery_id < b.delivery_id ? -1 : 1))) {
    sqliteHash.update(`delivery\u0000${d.delivery_id}\u0000${d.branch_ref}\u0000${d.head_sha}\u0000${d.status}\n`);
  }
  for (const a of [...sqliteArtifacts].sort((x, y) => (x.artifact_id < y.artifact_id ? -1 : 1))) {
    sqliteHash.update(`artifact\u0000${a.artifact_id}\u0000${a.sha256}\u0000${a.size_bytes}\u0000${a.status}\n`);
  }
  const sqliteSummary: ThreeWaySideSummary = {
    source: 'sqlite',
    count: sqliteRows.length + sqliteArtifacts.length,
    digest: sqliteHash.digest('hex'),
  };

  /* ---- artifact blob 目录侧 ---- */
  const blobs = collectBlobDirectory(artifactRoot);
  const blobHash = createHash('sha256');
  for (const sha of [...blobs.keys()].sort()) {
    blobHash.update(`${sha}\u0000${blobs.get(sha)}\n`);
  }
  const blobSummary: ThreeWaySideSummary = {
    source: 'artifact_blobs',
    count: blobs.size,
    digest: blobHash.digest('hex'),
  };

  // SQLite complete artifact → blob 存在性/大小/内容复核
  const completeArtifacts = sqliteArtifacts.filter((a) => a.status === 'complete');
  for (const artifact of completeArtifacts) {
    const blobSize = blobs.get(artifact.sha256);
    if (blobSize === undefined) {
      discrepancies.push({
        kind: 'artifact_blob_missing',
        severity: 'error',
        projectId: artifact.project_id,
        subjectType: 'artifact',
        subjectId: artifact.artifact_id,
        expected: artifact.sha256,
        actual: '<missing>',
        detail: `SQLite 记录 artifact 已 complete（sha256=${artifact.sha256}），但 blob 目录无对应文件`,
      });
      continue;
    }
    if (blobSize !== artifact.size_bytes) {
      discrepancies.push({
        kind: 'artifact_size_mismatch',
        severity: 'error',
        projectId: artifact.project_id,
        subjectType: 'artifact',
        subjectId: artifact.artifact_id,
        expected: String(artifact.size_bytes),
        actual: String(blobSize),
        detail: `SQLite 声明大小 ${artifact.size_bytes} 与 blob 实际 ${blobSize} 不一致`,
      });
    }
    if (verifyContent) {
      const check = verifyBlobContent(artifactRoot, artifact.sha256);
      if (!check.ok) {
        discrepancies.push({
          kind: 'artifact_blob_tampered',
          severity: 'error',
          projectId: artifact.project_id,
          subjectType: 'artifact',
          subjectId: artifact.artifact_id,
          expected: artifact.sha256,
          actual: check.actual,
          detail: `blob 内容 sha256 与文件名/元数据不一致（内容可能被篡改）`,
        });
      }
    }
  }

  // 孤儿 blob：目录存在但 SQLite 无任何引用
  const referencedShas = new Set(completeArtifacts.map((a) => a.sha256));
  for (const sha of blobs.keys()) {
    if (referencedShas.has(sha)) continue;
    const hasBlobRow = store.getArtifactBlob(sha, blobs.get(sha)!);
    if (!hasBlobRow) {
      discrepancies.push({
        kind: 'orphan_blob',
        severity: 'warning',
        projectId: '',
        subjectType: 'blob',
        subjectId: sha,
        expected: '<referenced>',
        actual: '<unreferenced>',
        detail: `blob 文件存在但 SQLite 无任何 artifact 引用（可能为残留或待 GC）`,
      });
    }
  }

  /* ---- git refs 侧 ---- */
  const gitRefs: GitRemoteRef[] = [];
  for (const project of projects) {
    if (!project.repository_url) continue;
    try {
      const refs = await gitProvider.lsRemote(project.repository_url, 'refs/biao/attempt-markers/*');
      gitRefs.push(...refs.map((r) => ({ ref: r.ref, sha: r.sha })));
      const branchRefs = await gitProvider.lsRemote(project.repository_url, 'refs/heads/biao/attempt/*');
      gitRefs.push(...branchRefs.map((r) => ({ ref: r.ref, sha: r.sha })));
    } catch {
      discrepancies.push({
        kind: 'git_ls_remote_failed',
        severity: 'warning',
        projectId: project.project_id,
        subjectType: 'git_ref',
        subjectId: project.repository_url,
        expected: '<reachable>',
        actual: '<unreachable>',
        detail: `无法从远端 ${project.repository_url} 读取 refs`,
      });
    }
  }
  const gitSummary: ThreeWaySideSummary = {
    source: 'git_refs',
    count: gitRefs.length,
    digest: refsDigest(gitRefs),
  };

  // 按 attempt_id 交叉比对 git refs 与 deliveries
  const deliveryByAttempt = new Map<string, Array<{ delivery_id: string; branch_ref: string; status: string }>>();
  for (const d of sqliteRows) {
    const attemptId = refAttemptId(d.branch_ref);
    if (!attemptId) continue;
    const list = deliveryByAttempt.get(attemptId) ?? [];
    list.push({ delivery_id: d.delivery_id, branch_ref: d.branch_ref, status: d.status });
    deliveryByAttempt.set(attemptId, list);
  }

  const refAttempts = new Map<string, GitRemoteRef[]>();
  for (const r of gitRefs) {
    const attemptId = refAttemptId(r.ref);
    if (!attemptId) continue;
    const list = refAttempts.get(attemptId) ?? [];
    list.push(r);
    refAttempts.set(attemptId, list);
  }

  // 活跃 delivery（终态 delivered/merged/cleaned 的 branch 可被 BranchCleanup 删除）
  const ACTIVE_DELIVERY_STATUSES = new Set(['pending_review', 'reviewing', 'pending_recovery']);
  for (const [attemptId, refs] of refAttempts) {
    const deliveries = deliveryByAttempt.get(attemptId);
    if (!deliveries || deliveries.length === 0) {
      for (const r of refs) {
        discrepancies.push({
          kind: 'git_ref_without_delivery',
          severity: 'warning',
          projectId: '',
          subjectType: 'git_ref',
          subjectId: r.ref,
          expected: '<delivery>',
          actual: '<none>',
          detail: `远端存在 ref ${r.ref} 但 SQLite 无对应 delivery（可能为残留分支）`,
        });
      }
    }
  }
  for (const [attemptId, deliveries] of deliveryByAttempt) {
    const refs = refAttempts.get(attemptId) ?? [];
    const active = deliveries.some((d) => ACTIVE_DELIVERY_STATUSES.has(d.status));
    const hasBranch = refs.some((r) => r.ref.startsWith('refs/heads/biao/attempt/'));
    const hasMarker = refs.some((r) => r.ref.startsWith('refs/biao/attempt-markers/'));
    if (active && (!hasBranch || !hasMarker)) {
      discrepancies.push({
        kind: 'delivery_missing_git_ref',
        severity: 'error',
        projectId: '',
        subjectType: 'delivery',
        subjectId: deliveries[0].delivery_id,
        expected: 'refs/heads/biao/attempt/' + attemptId + ' + refs/biao/attempt-markers/' + attemptId,
        actual: `branch=${hasBranch} marker=${hasMarker}`,
        detail: `活跃 delivery（${deliveries[0].status}）缺少预期的 git ref`,
      });
    }
  }

  return {
    ran_at: now(),
    project_ids: projectIds,
    summary: {
      sqlite: sqliteSummary,
      artifact_blobs: blobSummary,
      git_refs: gitSummary,
    },
    discrepancies,
  };
}
