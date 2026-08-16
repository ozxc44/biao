/**
 * Phase 4 失败优先测试：Git Workspace 与 Delivery
 *
 * 真实 git 子进程 + 自建临时 bare remote（与 tests/distributed/fixtures/
 * git-fixture.ts 同款语义，但不 import fixture——服务端语义必须独立成立）。
 *
 * 覆盖（§21 Phase 4 验收原文 + Prepare/Finalize 七检查项）：
 * 1. 两节点并行改不同文件互不覆盖（两 attempt → 两分支 → 两 delivery 并存）；
 * 2. Ownership 外文件被拒（finalize 拒绝、delivery 不生成）；
 * 3. force-push / remote mismatch：CAS 冲突 → invalidated；交付后远端改写 → invalidated；
 * 4. Prepare 失败分支：fingerprint 不匹配（换仓 / 默认分支 force 改写）、
 *    base 不可达、磁盘水位（注入）、marker 写失败（注入）；
 * 5. 中断重入：cloning 中途 kill → 重入收敛；committing kill → 重入收敛；
 *    过期 attempt → orphan_recovery_candidates 扫描幂等；
 * 6. Artifact 中断：finalize 成功但 artifact 未 complete → delivery pending_recovery
 *    → 补传后收敛 pending_review；
 * 7. 服务端 §7.3 二次门禁：Node 门禁被绕过时服务端独立 diff 复核拒绝；
 * 8. marker 篡改 → invalidated；
 * 9. BranchCleanup：到期删除前复核 HEAD、幂等 missing、head 变化拒绝；
 * 10. HTTP 接线冒烟（真实 createHttpServer + /v2 workspace 路由）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import { parseCredentialKey, issueAttemptToken, V2_CREDENTIAL_KEY_ENV } from '../../src/server/v2/credentials.js';
import {
  ALL_V2_FEATURE_FLAGS_ON_ENV,
  V2_FEATURE_FLAG_ENV_KEYS,
} from '../../src/server/v2/feature-flags.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';
import { createWorkspaceService } from '../../src/server/v2/git/workspace.js';
import { signAttemptMarker } from '../../src/server/v2/git/marker.js';
import { createDeliveryService } from '../../src/server/v2/delivery-service.js';
import type { AttemptWorkspaceRow } from '../../src/types/v2-git.js';
import { createHttpServer } from '../../src/server/http.js';

const execFileAsync = promisify(execFile);
const TEST_KEY = 'ccddeeff'.repeat(8); // 32 字节 hex

const tempDirs: string[] = [];
const tempWorlds: Array<{ store: SqliteStore }> = [];

/** 测试内 git（与 fixture 同款语义；独立实现，不 import fixture）。 */
async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** 创建带一个初始 commit 的 bare remote，返回 bare 路径。 */
async function createBareRemote(branch = 'main'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p4-bare-'));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', branch, bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p4-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p4 fixture ${randomBytes(8).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p4', '-c', 'user.email=p4@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], seed);
  return bare;
}

/** 独立 seed 克隆（模拟外部人类/别的机器改远端）。 */
async function cloneRemote(bare: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'p4-ext-'));
  tempDirs.push(root);
  const repo = join(root, 'repo');
  await git(['clone', bare, repo]);
  return repo;
}

/** 写工作区相对路径（自动建父目录）。 */
function writeIn(root: string, relPath: string, content: string): void {
  const target = join(root, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

async function remoteRefSha(bare: string, ref: string): Promise<string | null> {
  try {
    const out = await git(['ls-remote', bare, ref]);
    if (!out) return null;
    return out.split('\t')[0] || null;
  } catch {
    return null;
  }
}

interface WorldOptions {
  disk?: number;
  retentionMs?: number;
  hooks?: Parameters<typeof createWorkspaceService>[0]['hooks'];
}

/** 一次测试世界：独立 bare + 独立 store + 双服务。 */
async function makeWorld(options: WorldOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p4-world-'));
  tempDirs.push(root);
  const bare = await createBareRemote();
  const store = new SqliteStore(':memory:');
  tempWorlds.push({ store });
  const now = Date.now();
  const project: ProjectRow = {
    project_id: `proj-${randomBytes(4).toString('hex')}`,
    display_name: 'p4 项目',
    repository_url: bare,
    repository_fingerprint: '',
    default_branch: 'main',
    merge_policy: 'merge-queue',
    execution_mode: 'full',
    mode_transition: null,
    mode_transition_id: '',
    mode_transition_step: null,
    write_capability_status: 'ready',
    artifact_policy_id: '',
    workspace_policy_id: '',
    status: 'active',
    revision: 1,
    created_at: now,
    updated_at: now,
  };
  store.insertProject(project);

  const keyring = [parseCredentialKey(TEST_KEY, 1)];
  const provider = new GenericGitProvider();
  const workspace = createWorkspaceService({
    store,
    provider,
    keyring,
    nodeCacheRoot: join(root, 'node-cache'),
    verifyDirRoot: join(root, 'verify'),
    diskUsagePercent: () => options.disk ?? 20,
    hooks: options.hooks,
  });
  const delivery = createDeliveryService({
    store,
    provider,
    keyring,
    verifyDirRoot: join(root, 'verify'),
    ...(options.retentionMs !== undefined ? { cleanupRetentionMs: options.retentionMs } : {}),
  });

  let attemptSeq = 0;
  /** 插入 attempt + ownership snapshot（write_globs）。 */
  function insertAttempt(globs: string[], attemptId = `att-${++attemptSeq}-${randomBytes(3).toString('hex')}`) {
    const taskId = `task-${attemptId}`;
    const ts = Date.now();
    store.insertTaskAttempt({
      attempt_id: attemptId,
      task_id: taskId,
      project_id: project.project_id,
      node_id: 'node-sim-1',
      session_id: '',
      attempt_generation: 1,
      status: 'executing',
      lease_expires_at: ts + 10 * 60_000,
      lease_duration_ms: 600_000,
      token_jti: '',
      artifact_ids: '[]',
      started_at: ts,
      updated_at: ts,
      completed_at: null,
      failure_reason: '',
    });
    store.insertOwnershipSnapshot({
      snapshot_id: `snap-${attemptId}`,
      attempt_id: attemptId,
      task_id: taskId,
      files: JSON.stringify(globs),
      created_at: ts,
      released_at: null,
    });
    return { attemptId, taskId };
  }

  function attemptToken(attemptId: string, taskId: string): string {
    return issueAttemptToken(attemptId, taskId, 1, 'ownership', { keys: keyring });
  }

  /** 完整正向链路：prepare → 写文件 → finalize。 */
  async function deliverAttempt(globs: string[], files: Array<{ path: string; content: string }>) {
    const { attemptId, taskId } = insertAttempt(globs);
    const prepared = await workspace.prepare(attemptId, { attempt_token: attemptToken(attemptId, taskId) });
    if (!prepared.ok) throw new Error(`prepare 失败: ${prepared.error?.message}`);
    for (const file of files) {
      writeIn(prepared.data.workspace_dir, file.path, file.content);
    }
    const finalized = await workspace.commitAndPush(attemptId);
    if (!finalized.ok) throw new Error(`finalize 失败: ${finalized.error?.message}`);
    return { attemptId, taskId, prepared: prepared.data, finalized: finalized.data };
  }

  return { root, bare, store, project, provider, workspace, delivery, insertAttempt, attemptToken, deliverAttempt };
}

afterEach(() => {
  while (tempWorlds.length) tempWorlds.pop()?.store.close();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Phase 4: §21 验收——两节点并行不同文件互不覆盖', () => {
  it('两个 attempt 各自 clone→各自分支→push→两个 delivery 并存，bare remote 两分支共存', async () => {
    const world = await makeWorld();
    const a = await world.deliverAttempt(['a/**'], [{ path: 'a/from-node-a.md', content: 'A 的改动\n' }]);
    const b = await world.deliverAttempt(['b/**'], [{ path: 'b/from-node-b.md', content: 'B 的改动\n' }]);

    // bare remote：两条 attempt 分支共存，marker ref 也各自存在
    const refA = await remoteRefSha(world.bare, `refs/heads/biao/attempt/${a.attemptId}`);
    const refB = await remoteRefSha(world.bare, `refs/heads/biao/attempt/${b.attemptId}`);
    expect(refA).toBe(a.finalized.head_sha);
    expect(refB).toBe(b.finalized.head_sha);
    expect(refA).not.toBe(refB);
    expect(await remoteRefSha(world.bare, `refs/biao/attempt-markers/${a.attemptId}`)).toBeTruthy();
    expect(await remoteRefSha(world.bare, `refs/biao/attempt-markers/${b.attemptId}`)).toBeTruthy();
    // 默认分支不被触碰（真相源不被 attempt 改写）
    const mainSha = await remoteRefSha(world.bare, 'refs/heads/main');
    expect(mainSha).toBe(a.prepared.base_sha);

    // 两个 delivery 并存且互不覆盖
    const deliveryA = world.store.getDelivery(a.finalized.delivery_id);
    const deliveryB = world.store.getDelivery(b.finalized.delivery_id);
    expect(deliveryA?.status).toBe('pending_review');
    expect(deliveryB?.status).toBe('pending_review');
    expect(JSON.parse(deliveryA!.changed_files)).toEqual(['a/from-node-a.md']);
    expect(JSON.parse(deliveryB!.changed_files)).toEqual(['b/from-node-b.md']);
    expect(deliveryA!.server_verified).toBe(1);
    expect(deliveryB!.server_verified).toBe(1);

    // 工作区隔离：clone-per-attempt 目录布局 <cache>/<project>/<attempt>
    const wsA = world.store.getAttemptWorkspace(a.attemptId) as AttemptWorkspaceRow;
    const wsB = world.store.getAttemptWorkspace(b.attemptId) as AttemptWorkspaceRow;
    expect(wsA.workspace_dir).not.toBe(wsB.workspace_dir);
    expect(wsA.workspace_dir).toContain(join(world.project.project_id, a.attemptId));
    expect(readFileSync(join(wsA.workspace_dir, '.biao-attempt.json'), 'utf8')).toContain('"attempt_id"');
    // owner-only marker 文件权限（§6.5）
    expect(statSync(join(wsA.workspace_dir, '.biao-attempt.json')).mode & 0o777).toBe(0o600);

    // PM Review V2 视图：diff 摘要有文件清单与 ± 统计、无正文
    const view = world.delivery.getReviewView(a.finalized.delivery_id);
    expect(view.ok && view.data?.diff_summary.files).toEqual([
      { path: 'a/from-node-a.md', additions: 1, deletions: 0, binary: false },
    ]);
    expect(view.ok && view.data?.diff_summary.server_verified).toBe(true);
  }, 30_000);

  it('prepare 幂等：ready 后重复 prepare 返回同一工作区', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['a/**']);
    const first = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    const second = await world.workspace.prepare(attemptId);
    expect(first.ok && first.data.prepare_state).toBe('ready');
    expect(second.ok && second.data.workspace_dir).toBe(first.ok ? first.data.workspace_dir : '');
  }, 20_000);
});

describe('Phase 4: Ownership 外文件被拒', () => {
  it('attempt 在 ownership 外文件提交 → finalize 拒绝、状态 failed:ownership_violation、delivery 不生成', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['c/**']);
    const prepared = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    expect(prepared.ok).toBe(true);
    writeIn(prepared.data.workspace_dir, 'outside/evil.txt', '越界改动\n');
    writeIn(prepared.data.workspace_dir, 'c/ok.txt', '授权改动\n');

    const finalized = await world.workspace.commitAndPush(attemptId);
    expect(finalized.ok).toBe(false);
    expect(finalized.error?.code).toBe('FINALIZE_FAILED_OWNERSHIP_VIOLATION');
    expect(finalized.error?.message).toContain('outside/evil.txt');

    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('failed:ownership_violation');
    // 不 push、不生成 delivery
    expect(await remoteRefSha(world.bare, `refs/heads/biao/attempt/${attemptId}`)).toBeNull();
    expect(world.store.listDeliveriesByTask(ws.task_id)).toHaveLength(0);
    // 终态：重入 finalize 仍拒绝
    const again = await world.workspace.commitAndPush(attemptId);
    expect(again.ok).toBe(false);
  }, 20_000);

  it('无 ownership snapshot 的 attempt finalize 按 fail-closed 拒绝', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['a/**']);
    const prepared = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    expect(prepared.ok).toBe(true);
    // 测试直接删快照模拟"claim 未接 ownership"（006 快照缺失路径）
    (world.store as unknown as { db: { exec: (sql: string) => void } }).db.exec("DELETE FROM ownership_snapshots");
    const finalized = await world.workspace.commitAndPush(attemptId);
    expect(finalized.ok).toBe(false);
    expect(finalized.error?.code).toBe('FINALIZE_FAILED_OWNERSHIP_SNAPSHOT_MISSING');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('failed:ownership_snapshot_missing');
  }, 20_000);
});

describe('Phase 4: force-push / remote mismatch 被拒', () => {
  it('CAS：finalize 前远端已存在同名 attempt 分支 → failed:cas_conflict + invalidated delivery', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['d/**']);
    const prepared = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    expect(prepared.ok).toBe(true);
    writeIn(prepared.data.workspace_dir, 'd/file.txt', '内容\n');

    // 外部（另一台机器/人）抢先占了 refs/heads/biao/attempt/<id>
    const ext = await cloneRemote(world.bare);
    writeIn(ext, 'hijack.txt', '外部抢占\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'hijack'], ext);
    await git(['push', 'origin', `HEAD:refs/heads/biao/attempt/${attemptId}`], ext);

    const finalized = await world.workspace.commitAndPush(attemptId);
    expect(finalized.ok).toBe(false);
    expect(finalized.error?.code).toBe('FINALIZE_FAILED_CAS_CONFLICT');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('failed:cas_conflict');
    // invalidated delivery 留审计（reason=remote-ref-exists，R1A-001）
    const deliveries = world.store.listDeliveriesByTask(ws.task_id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('invalidated');
    expect(deliveries[0].invalidated_reason).toBe('remote-ref-exists');
  }, 30_000);

  it('delivery 后外部改写分支 → 服务端复核 invalidated(branch-head-changed) + 落 BranchCleanup', async () => {
    const world = await makeWorld({ retentionMs: 60_000 });
    const delivered = await world.deliverAttempt(['e/**'], [{ path: 'e/ok.md', content: 'ok\n' }]);

    // 外部 force 改写 attempt 分支（等价 force-push 另一个 head）
    const ext = await cloneRemote(world.bare);
    await git(['checkout', '-b', 'evil', 'origin/main'], ext);
    writeIn(ext, 'e/rewritten.md', '被改写\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'rewrite'], ext);
    await git(['push', '--force', 'origin', `HEAD:refs/heads/biao/attempt/${delivered.attemptId}`], ext);

    const result = await world.delivery.verifyDeliveryRemote(delivered.finalized.delivery_id);
    expect(result.ok).toBe(true);
    const delivery = world.store.getDelivery(delivered.finalized.delivery_id)!;
    expect(delivery.status).toBe('invalidated');
    expect(delivery.invalidated_reason).toBe('branch-head-changed');

    // 非 merged 终态 → BranchCleanup 记录（§6.6：rejected/invalidated 立即登记）
    const cleanups = world.store.listBranchCleanups(world.project.project_id);
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0].branch_ref).toBe(`refs/heads/biao/attempt/${delivered.attemptId}`);
    expect(cleanups[0].reason).toBe('invalidated');
    expect(cleanups[0].status).toBe('pending');
  }, 30_000);

  it('marker 被篡改/替换 → 服务端复核 invalidated(marker-invalid)', async () => {
    const world = await makeWorld();
    const delivered = await world.deliverAttempt(['f/**'], [{ path: 'f/ok.md', content: 'ok\n' }]);

    // 用垃圾 blob 覆盖 marker ref（等价验签失败）
    const ext = await cloneRemote(world.bare);
    writeFileSync(join(ext, 'fake-marker.json'), 'not a signed marker');
    const fakeSha = await git(['hash-object', '-w', 'fake-marker.json'], ext);
    await git(['push', '--force', 'origin', `${fakeSha}:refs/biao/attempt-markers/${delivered.attemptId}`], ext);

    const result = await world.delivery.verifyDeliveryRemote(delivered.finalized.delivery_id);
    expect(result.ok).toBe(true);
    const delivery = world.store.getDelivery(delivered.finalized.delivery_id)!;
    expect(delivery.status).toBe('invalidated');
    expect(delivery.invalidated_reason).toBe('marker-invalid');
  }, 30_000);
});

describe('Phase 4: Prepare 失败分支', () => {
  it('remote fingerprint 不匹配：项目被改绑到另一仓库 → failed:remote_fingerprint_mismatch', async () => {
    const world = await makeWorld();
    // 先用 remote1 完成一次 prepare，让项目登记 fingerprint
    await world.deliverAttempt(['a/**'], [{ path: 'a/x.md', content: 'x\n' }]);
    const registered = world.store.getProject(world.project.project_id)!.repository_fingerprint;
    expect(registered).toMatch(/^v1:[0-9a-f]{40}:[0-9a-f]{64}$/);

    // 换绑到历史完全无关的 remote2（同一 project 记录被外部改动）
    const bare2 = await createBareRemote();
    world.store.updateProject(world.project.project_id, { repository_url: bare2 });

    const { attemptId } = world.insertAttempt(['a/**']);
    const result = await world.workspace.prepare(attemptId);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_FAILED_REMOTE_FINGERPRINT_MISMATCH');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.prepare_state).toBe('failed:remote_fingerprint_mismatch');
    // 终态：重入不再推进
    const again = await world.workspace.prepare(attemptId);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe('PREPARE_TERMINAL');
  }, 30_000);

  it('remote fingerprint 不匹配：默认分支被 force 改写（锚点历史断裂）', async () => {
    const world = await makeWorld();
    await world.deliverAttempt(['a/**'], [{ path: 'a/x.md', content: 'x\n' }]);

    // 外部 amend main 并 force push：注册锚点不再是 main 的祖先
    const ext = await cloneRemote(world.bare);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '--amend', '-m', 'rewritten main'], ext);
    await git(['push', '--force', 'origin', 'HEAD:refs/heads/main'], ext);

    const { attemptId } = world.insertAttempt(['a/**']);
    const result = await world.workspace.prepare(attemptId);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_FAILED_REMOTE_FINGERPRINT_MISMATCH');
    expect(result.error?.message).toContain('历史断裂');
  }, 30_000);

  it('base 不可达：base_sha 来自无关历史 → failed:base_unreachable', async () => {
    const world = await makeWorld();
    const bare2 = await createBareRemote();
    const ext2 = await cloneRemote(bare2);
    const unrelatedSha = await git(['rev-parse', 'HEAD'], ext2);

    const { attemptId } = world.insertAttempt(['a/**']);
    const result = await world.workspace.prepare(attemptId, { base_sha: unrelatedSha });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_FAILED_BASE_UNREACHABLE');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.prepare_state).toBe('failed:base_unreachable');
  }, 30_000);

  it('磁盘水位超限（注入）→ failed:disk_watermark；阈值边界 84/85', async () => {
    const world = await makeWorld({ disk: 90 });
    const { attemptId } = world.insertAttempt(['a/**']);
    const result = await world.workspace.prepare(attemptId);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_FAILED_DISK_WATERMARK');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.prepare_state).toBe('failed:disk_watermark');
    expect(ws.prepare_error).toContain('90%');

    // 边界：<85 放行；==85 拒绝（R1C-007 默认阈值）
    const worldLow = await makeWorld({ disk: 84 });
    const lowAttempt = worldLow.insertAttempt(['a/**']);
    const lowResult = await worldLow.workspace.prepare(lowAttempt.attemptId);
    expect(lowResult.ok && lowResult.data.prepare_state).toBe('ready');

    const worldEdge = await makeWorld({ disk: 85 });
    const edgeAttempt = worldEdge.insertAttempt(['a/**']);
    const edgeResult = await worldEdge.workspace.prepare(edgeAttempt.attemptId);
    expect(edgeResult.ok).toBe(false);
    expect(edgeResult.error?.code).toBe('PREPARE_FAILED_DISK_WATERMARK');
  }, 30_000);

  it('marker 写失败（注入）→ failed:marker_write_failed', async () => {
    const world = await makeWorld({
      hooks: {
        beforeMarkerWrite: () => {
          throw new Error('模拟 marker 写盘失败（磁盘满）');
        },
      },
    });
    const { attemptId } = world.insertAttempt(['a/**']);
    const result = await world.workspace.prepare(attemptId);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('PREPARE_FAILED_MARKER_WRITE_FAILED');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.prepare_state).toBe('failed:marker_write_failed');
    // 未创建分支：工作目录没有 marker、ref 不存在
    expect(existsSync(join(ws.workspace_dir, '.biao-attempt.json'))).toBe(false);
  }, 20_000);
});

describe('Phase 4: 中断重入（进程杀死后收敛）', () => {
  it('cloning 中途 kill（残留半成品目录）→ 重入清掉半成品并收敛 ready', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['a/**']);
    const wsDir = join(world.root, 'node-cache', world.project.project_id, attemptId);
    // 注入"clone 中途被杀"：留下残缺 .git 后抛出（未捕获 = 进程死亡语义）
    const killedService = createWorkspaceService({
      store: world.store,
      provider: world.provider,
      keyring: [parseCredentialKey(TEST_KEY, 1)],
      nodeCacheRoot: join(world.root, 'node-cache'),
      verifyDirRoot: join(world.root, 'verify'),
      diskUsagePercent: () => 20,
      hooks: {
        beforeClone: () => {
          mkdirSync(join(wsDir, '.git'), { recursive: true });
          writeFileSync(join(wsDir, '.git', 'HEAD'), 'garbage');
          throw new Error('kill -9 during clone');
        },
      },
    });
    // hook 抛出未被捕获（= 进程死亡语义），状态已停留 cloning
    await expect(killedService.prepare(attemptId)).rejects.toThrow('kill -9 during clone');
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.prepare_state).toBe('cloning'); // 状态停留在 cloning
    expect(existsSync(join(wsDir, '.git', 'HEAD'))).toBe(true); // 半成品还在

    // 重入（进程重启后，无 hook）：收敛 ready
    const resumed = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    expect(resumed.ok && resumed.data.prepare_state).toBe('ready');
    expect(readFileSync(join(wsDir, '.git', 'HEAD'), 'utf8')).not.toBe('garbage');
    // 收敛后 finalize 可正常走完
    writeIn(wsDir, 'a/after-recovery.md', '恢复后的改动\n');
    const finalized = await world.workspace.commitAndPush(attemptId);
    expect(finalized.ok).toBe(true);
    expect(finalized.data.status).toBe('pending_review');
  }, 30_000);

  it('committing 中途 kill → finalize 重入收敛 delivered', async () => {
    const attemptBox = { id: '' };
    const world = await makeWorld({
      hooks: {
        beforeCommit: (attemptId) => {
          if (attemptId === attemptBox.id) throw new Error('kill -9 during commit');
        },
      },
    });
    const { attemptId, taskId } = world.insertAttempt(['a/**']);
    attemptBox.id = attemptId;
    const prepared = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    expect(prepared.ok).toBe(true);
    writeIn(prepared.data.workspace_dir, 'a/file.md', '改动\n');

    await expect(world.workspace.commitAndPush(attemptId)).rejects.toThrow('kill -9 during commit');
    let ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('committing');

    // 重入（重启后 hook 不再触发）
    attemptBox.id = '';
    const resumed = await world.workspace.commitAndPush(attemptId);
    expect(resumed.ok).toBe(true);
    expect(resumed.data.finalize_state).toBe('delivered');
    expect(resumed.data.status).toBe('pending_review');
    ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('delivered');
  }, 30_000);

  it('过期 attempt 的中断工作区 → orphan_recovery_candidates 扫描（幂等）', async () => {
    const attemptBox = { id: '' };
    const world = await makeWorld({
      hooks: {
        beforeClone: (attemptId) => {
          if (attemptId === attemptBox.id) throw new Error('kill');
        },
      },
    });
    const { attemptId } = world.insertAttempt(['a/**']);
    attemptBox.id = attemptId;
    await expect(world.workspace.prepare(attemptId)).rejects.toBeTruthy();
    expect((world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow).prepare_state).toBe('cloning');

    // lease 未过期：扫描不产生候选
    expect(world.workspace.scanInterruptedWorkspaces().candidates).toBe(0);

    // lease 过期：产生 pending 候选；重复扫描幂等
    world.store.updateTaskAttempt(attemptId, { lease_expires_at: Date.now() - 1 });
    const first = world.workspace.scanInterruptedWorkspaces();
    expect(first.candidates).toBe(1);
    const second = world.workspace.scanInterruptedWorkspaces();
    expect(second.candidates).toBe(0);
    const candidates = world.store.listOrphanRecoveryCandidates(world.project.project_id, 'pending');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].attempt_id).toBe(attemptId);
    expect(candidates[0].branch_ref).toBe(`refs/heads/biao/attempt/${attemptId}`);
    expect(candidates[0].recovery_path).toBe('control-plane-takeover');
  }, 20_000);
});

describe('Phase 4: Artifact 中断 → pending_recovery 收敛', () => {
  it('finalize 成功但 artifact 上传中断 → delivery pending_recovery → 补传后 pending_review', async () => {
    const world = await makeWorld();
    const { attemptId, taskId } = world.insertAttempt(['a/**']);
    const ts = Date.now();
    world.store.insertArtifact({
      artifact_id: 'art-pending',
      project_id: world.project.project_id,
      task_id: taskId,
      attempt_id: attemptId,
      kind: 'result-md',
      sha256: 'f'.repeat(64),
      size_bytes: 10,
      media_type: 'text/markdown',
      storage_key: '',
      status: 'uploading',
      created_at: ts,
      retention_until: null,
    });

    const prepared = await world.workspace.prepare(attemptId, { attempt_token: world.attemptToken(attemptId, taskId) });
    writeIn(prepared.data.workspace_dir, 'a/result.md', '结果\n');
    const finalized = await world.workspace.commitAndPush(attemptId, { artifact_refs: [{ artifact_id: 'art-pending' }] });
    expect(finalized.ok).toBe(true);
    // push 成功但 artifact 未 complete → pending_recovery
    expect(finalized.data.status).toBe('pending_recovery');
    let ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('pending_recovery');
    let delivery = world.store.getDelivery(finalized.data.delivery_id)!;
    expect(delivery.status).toBe('pending_recovery');

    // 未补传前收敛调用：保持 pending_recovery
    const early = world.delivery.recoverPendingArtifacts(delivery.delivery_id);
    expect(early.ok && early.data?.status).toBe('pending_recovery');

    // 补传（artifact complete）后收敛
    world.store.updateArtifactStatus('art-pending', 'complete');
    const recovered = world.delivery.recoverPendingArtifacts(delivery.delivery_id);
    expect(recovered.ok && recovered.data?.status).toBe('pending_review');
    delivery = world.store.getDelivery(delivery.delivery_id)!;
    expect(delivery.status).toBe('pending_review');
    ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;
    expect(ws.finalize_state).toBe('delivered');
  }, 30_000);
});

describe('Phase 4: §7.3 服务端 diff 二次门禁（不信任 Node 上报）', () => {
  it('Node 门禁被绕过（外部直推越界文件到 attempt 分支）→ 服务端独立复核拒绝 delivery', async () => {
    const world = await makeWorld();
    const keyring = [parseCredentialKey(TEST_KEY, 1)];
    const { attemptId, taskId } = world.insertAttempt(['g/**']);
    const token = world.attemptToken(attemptId, taskId);
    const prepared = await world.workspace.prepare(attemptId, { attempt_token: token });
    expect(prepared.ok).toBe(true);
    const ws = world.store.getAttemptWorkspace(attemptId) as AttemptWorkspaceRow;

    // 模拟"Node 谎报"：commit 里混入 ownership 外文件，但直接用 provider 推送，
    // 绕过 workspace.finalize 的 Node 侧门禁，再手工落一条 pending_review delivery。
    const dir = ws.workspace_dir;
    writeIn(dir, 'g/ok.ts', 'export const ok = 1;\n');
    writeIn(dir, 'outside/bad.ts', 'export const bad = 1;\n');
    await world.provider.commitAll(dir, 'bypassed node gate', { exclude: ['.biao-attempt.json'] });
    const head = (await world.provider.readRef(dir, 'HEAD'))!;
    const markerPayload = {
      attempt_id: attemptId,
      task_id: taskId,
      attempt_generation: 1,
      node_id: 'node-sim-1',
      signing_key_generation: 1,
      branch_ref: ws.branch_ref,
      base_sha: ws.base_sha,
      head_sha: head,
      bva2_digest: ws.bva2_digest,
      created_at: Date.now(),
    };
    const markerSha = await world.provider.hashObject(dir, JSON.stringify(signAttemptMarker(markerPayload, keyring[0])));
    await world.provider.push(dir, [`${ws.branch_ref}:${ws.branch_ref}`, `${markerSha}:${ws.marker_ref}`], { atomic: true });

    const ts = Date.now();
    const deliveryId = `del-${randomBytes(8).toString('hex')}`;
    world.store.insertDelivery({
      delivery_id: deliveryId,
      task_id: taskId,
      attempt_id: attemptId,
      project_id: world.project.project_id,
      base_sha: ws.base_sha,
      head_sha: head,
      tree_sha: '',
      branch_ref: ws.branch_ref,
      changed_files: JSON.stringify(['g/ok.ts']), // Node 上报只有授权文件（谎报）
      patch_digest: '',
      artifact_ids: '[]',
      verify_manifest_digest: '',
      status: 'pending_review',
      accepted_commit_sha: '',
      merged_commit_sha: '',
      invalidated_reason: '',
      created_at: ts,
      updated_at: ts,
    });

    // 服务端独立复核：以 bare remote 为准发现越界文件 → 强制 rejected
    const result = await world.delivery.verifyDeliveryRemote(deliveryId);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.verified).toBe(false);
    expect(result.ok && result.data?.reason).toContain('outside/bad.ts');
    const delivery = world.store.getDelivery(deliveryId)!;
    expect(delivery.status).toBe('rejected'); // §7.3：不允许 PM 用普通 accept 绕过
    const summary = JSON.parse(delivery.diff_summary!) as { ownership_violations: string[]; server_verified: boolean };
    expect(summary.ownership_violations).toEqual(['outside/bad.ts']);
    expect(summary.server_verified).toBe(true);
    // rejected 也落 BranchCleanup
    expect(world.store.listBranchCleanups(world.project.project_id)).toHaveLength(1);
  }, 30_000);
});

describe('Phase 4: Delivery 状态机与 BranchCleanup 到期执行', () => {
  it('pending_review → reviewing → accepted|rejected；reject 落 cleanup；非法流转被拒', async () => {
    const world = await makeWorld({ retentionMs: 60_000 });
    const delivered = await world.deliverAttempt(['a/**'], [{ path: 'a/x.md', content: 'x\n' }]);
    const deliveryId = delivered.finalized.delivery_id;

    // 非法：未进入 reviewing 直接 review
    const direct = world.delivery.reviewDelivery(deliveryId, { verdict: 'accept', reviewed_by: 'pm-1' });
    expect(direct.ok).toBe(false);
    // 非法：accepted 后再 startReview
    expect(world.delivery.startReview(deliveryId).ok).toBe(true);
    expect(world.delivery.startReview(deliveryId).ok).toBe(false); // reviewing 不能重复进入
    const accepted = world.delivery.reviewDelivery(deliveryId, { verdict: 'accept', reviewed_by: 'pm-1' });
    expect(accepted.ok && accepted.data?.status).toBe('accepted');
    expect(world.delivery.startReview(deliveryId).ok).toBe(false);

    // reject 路径：第二个 delivery
    const other = await world.deliverAttempt(['b/**'], [{ path: 'b/y.md', content: 'y\n' }]);
    world.delivery.startReview(other.finalized.delivery_id);
    const rejected = world.delivery.reviewDelivery(other.finalized.delivery_id, {
      verdict: 'reject',
      reviewed_by: 'pm-1',
      reject_reason: '不满足验收',
    });
    expect(rejected.ok && rejected.data?.status).toBe('rejected');
    expect(rejected.ok && rejected.data?.cleanup_id).toBeTruthy();
  }, 30_000);

  it('BranchCleanup 到期删除前复核 HEAD；幂等 missing；head 已变化则拒绝', async () => {
    const world = await makeWorld({ retentionMs: 2000 }); // 压缩保留期（默认 30 天）
    const stale = await world.deliverAttempt(['a/**'], [{ path: 'a/old.md', content: 'old\n' }]);
    world.delivery.startReview(stale.finalized.delivery_id);
    world.delivery.reviewDelivery(stale.finalized.delivery_id, { verdict: 'reject', reviewed_by: 'pm-1' });

    const moved = await world.deliverAttempt(['b/**'], [{ path: 'b/moved.md', content: 'moved\n' }]);
    world.delivery.startReview(moved.finalized.delivery_id);
    world.delivery.reviewDelivery(moved.finalized.delivery_id, { verdict: 'reject', reviewed_by: 'pm-1' });

    // 第三条：rejected 后分支被外部直接删掉 → 清理时幂等视为 deleted
    const gone = await world.deliverAttempt(['c/**'], [{ path: 'c/gone.md', content: 'gone\n' }]);
    world.delivery.startReview(gone.finalized.delivery_id);
    world.delivery.reviewDelivery(gone.finalized.delivery_id, { verdict: 'reject', reviewed_by: 'pm-1' });
    const extGone = await cloneRemote(world.bare);
    await git(['push', 'origin', `:refs/heads/biao/attempt/${gone.attemptId}`], extGone);

    // 未到期：不处理（紧接 reject 立即执行，远小于 2s 保留期）
    const notDue = await world.delivery.runDueBranchCleanups();
    expect(notDue.ok && notDue.data?.processed).toBe(0);

    await new Promise((r) => setTimeout(r, 2100));

    // 把 moved 的远端分支再推进一个 commit（head 变化 → 清理必须拒绝）
    const ext = await cloneRemote(world.bare);
    await git(['checkout', '-B', 'adv', `origin/biao/attempt/${moved.attemptId}`], ext);
    writeIn(ext, 'b/advanced.md', 'advanced\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'advance'], ext);
    await git(['push', 'origin', `HEAD:refs/heads/biao/attempt/${moved.attemptId}`], ext);

    const run = await world.delivery.runDueBranchCleanups();
    expect(run.ok && run.data?.deleted).toBe(1); // stale：HEAD 复核通过 → 删除
    expect(run.ok && run.data?.failed).toBe(1); // moved：HEAD 已变化 → 拒绝并留审计
    expect(run.ok && run.data?.already_missing).toBe(1); // gone：branch 已不存在 → 幂等 deleted
    // stale 分支被删；moved 分支保留待人工裁决
    expect(await remoteRefSha(world.bare, `refs/heads/biao/attempt/${stale.attemptId}`)).toBeNull();
    expect(await remoteRefSha(world.bare, `refs/heads/biao/attempt/${moved.attemptId}`)).toBeTruthy();

    const records = world.store.listBranchCleanups(world.project.project_id);
    const staleRecord = records.find((r) => r.branch_ref.endsWith(stale.attemptId))!;
    const movedRecord = records.find((r) => r.branch_ref.endsWith(moved.attemptId))!;
    const goneRecord = records.find((r) => r.branch_ref.endsWith(gone.attemptId))!;
    expect(staleRecord.status).toBe('deleted');
    expect(staleRecord.completed_at).not.toBeNull();
    expect(movedRecord.status).toBe('failed');
    expect(movedRecord.last_error).toContain('人工裁决');
    expect(goneRecord.status).toBe('deleted'); // missing ≠ 失败（§4.4.2 幂等语义）
    expect(goneRecord.completed_at).not.toBeNull();

    // 终态记录重跑：不再处理
    const rerun = await world.delivery.runDueBranchCleanups();
    expect(rerun.ok && rerun.data?.processed).toBe(0);
  }, 45_000);
});

describe('Phase 4: HTTP 接线冒烟（真实 createHttpServer）', () => {
  it('POST /v2 workspace prepare/finalize 全链路（owner bearer）', { timeout: 60_000 }, async () => {
    const redis = new Redis('redis://127.0.0.1:6380/15', { maxRetriesPerRequest: null });
    const savedKey = process.env[V2_CREDENTIAL_KEY_ENV];
    const savedFlagEnv: Record<string, string | undefined> = {};
    for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
      savedFlagEnv[key] = process.env[key];
      process.env[key] = ALL_V2_FEATURE_FLAGS_ON_ENV[key];
    }
    process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY;
    const root = mkdtempSync(join(tmpdir(), 'p4-http-'));
    tempDirs.push(root);
    const bare = await createBareRemote();
    let app: FastifyInstance | undefined;
    const worldStore = new SqliteStore(':memory:');
    tempWorlds.push({ store: worldStore });
    try {
      await redis.flushdb();
      const ts = Date.now();
      const projectId = `proj-http-${randomBytes(3).toString('hex')}`;
      worldStore.insertProject({
        project_id: projectId,
        display_name: 'http',
        repository_url: bare,
        repository_fingerprint: '',
        default_branch: 'main',
        merge_policy: 'merge-queue',
        execution_mode: 'full',
        mode_transition: null,
        mode_transition_id: '',
        mode_transition_step: null,
        write_capability_status: 'ready',
        artifact_policy_id: '',
        workspace_policy_id: '',
        status: 'active',
        revision: 1,
        created_at: ts,
        updated_at: ts,
      });
      const attemptId = `att-http-${randomBytes(3).toString('hex')}`;
      worldStore.insertTaskAttempt({
        attempt_id: attemptId,
        task_id: `task-${attemptId}`,
        project_id: projectId,
        node_id: 'node-http',
        session_id: '',
        attempt_generation: 1,
        status: 'executing',
        lease_expires_at: ts + 600_000,
        lease_duration_ms: 600_000,
        token_jti: '',
        artifact_ids: '[]',
        started_at: ts,
        updated_at: ts,
        completed_at: null,
        failure_reason: '',
      });
      worldStore.insertOwnershipSnapshot({
        snapshot_id: `snap-${attemptId}`,
        attempt_id: attemptId,
        task_id: `task-${attemptId}`,
        files: JSON.stringify(['a/**']),
        created_at: ts,
        released_at: null,
      });

      app = await createHttpServer(redis, {
        apiToken: 'p4-owner-token',
        host: '127.0.0.1',
        port: 0,
        workspaceRoots: ['/tmp'],
      }, { sqliteStore: worldStore, webDist: null });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;
      const auth = { Authorization: 'Bearer p4-owner-token', 'Content-Type': 'application/json' };

      const prepared = await fetch(`${base}/v2/attempts/${attemptId}/workspace/prepare`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      const preparedBody = (await prepared.json()) as { ok: boolean; data?: { prepare_state: string; workspace_dir: string } };
      expect(prepared.status).toBe(200);
      expect(preparedBody.ok && preparedBody.data?.prepare_state).toBe('ready');

      writeIn(preparedBody.data!.workspace_dir, 'a/http.md', 'via http\n');

      const finalized = await fetch(`${base}/v2/attempts/${attemptId}/workspace/finalize`, {
        method: 'POST',
        headers: auth,
        body: '{}',
      });
      const finalizedBody = (await finalized.json()) as { ok: boolean; data?: { status: string; delivery_id: string } };
      expect(finalized.status).toBe(200);
      expect(finalizedBody.ok && finalizedBody.data?.status).toBe('pending_review');

      const view = await fetch(`${base}/v2/deliveries/${finalizedBody.data!.delivery_id}`, { headers: auth });
      const viewBody = (await view.json()) as { ok: boolean; data?: { delivery?: { branch_ref: string } } };
      expect(viewBody.ok && viewBody.data?.delivery?.branch_ref).toBe(`refs/heads/biao/attempt/${attemptId}`);

      // 密钥未配置的面 fail-closed（换 env 再问一次 workspace 状态即可，不重建 server）
      const state = await fetch(`${base}/v2/attempts/${attemptId}/workspace`, { headers: auth });
      const stateBody = (await state.json()) as { ok: boolean; data?: { finalize_state: string } | null };
      expect(stateBody.ok && stateBody.data?.finalize_state).toBe('delivered');
    } finally {
      if (app) await app.close();
      await redis.quit().catch(() => undefined);
      if (savedKey !== undefined) process.env[V2_CREDENTIAL_KEY_ENV] = savedKey;
      else delete process.env[V2_CREDENTIAL_KEY_ENV];
      for (const key of V2_FEATURE_FLAG_ENV_KEYS) {
        if (savedFlagEnv[key] !== undefined) process.env[key] = savedFlagEnv[key]!;
        else delete process.env[key];
      }
    }
  });
});
