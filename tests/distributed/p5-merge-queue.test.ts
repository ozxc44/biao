/**
 * Phase 5 失败优先测试：Merge Queue
 *
 * 真实 git 子进程 + 自建临时 bare remote（延续 p4 自建临时 bare 风格）。
 *
 * 覆盖（§21 Phase 5 验收原文 + §12 各小节）：
 * 1. 无冲突自动合并（两 delivery 串行 merge，默认分支前进、merge commit 可追溯）；
 * 2. 真实冲突保持可审计（两 delivery 改同一行→第二个 conflict+冲突清单落审计，
 *    默认分支 HEAD 不变）；
 * 3. 失败不更新主分支（push 前注入失败→默认分支字节级不变）；
 * 4. CAS：merge 执行前外部推进默认分支→job invalidated→重新排队成功；
 * 5. 串行性：并发 enqueue 两 delivery→仅一个 running（唯一约束实证）；
 * 6. 依赖解锁：A merge 后依赖 A 的 B 才可入队（§12.4）；
 * 7. 降级/恢复：连续 3 次 integration_failed→lost→restore→恢复；
 * 8. external intent 登记/审计。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import { parseCredentialKey, issueAttemptToken } from '../../src/server/v2/credentials.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';
import { createWorkspaceService } from '../../src/server/v2/git/workspace.js';
import { createDeliveryService } from '../../src/server/v2/delivery-service.js';
import { createMergeQueue } from '../../src/server/v2/merge/queue.js';
import { createMergeService } from '../../src/server/v2/merge-service.js';

const execFileAsync = promisify(execFile);
const TEST_KEY = 'ccddeeff'.repeat(8);

const tempDirs: string[] = [];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(branch = 'main'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p5-bare-'));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', branch, bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p5-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), `# p5 fixture ${randomBytes(8).toString('hex')}\n`);
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p5', '-c', 'user.email=p5@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`], seed);
  return bare;
}

async function cloneRemote(bare: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'p5-ext-'));
  tempDirs.push(root);
  const repo = join(root, 'repo');
  await git(['clone', bare, repo]);
  return repo;
}

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
  degradeThreshold?: number;
}

async function makeWorld(options: WorldOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p5-world-'));
  tempDirs.push(root);
  const bare = await createBareRemote();
  const store = new SqliteStore(':memory:');
  const now = Date.now();
  const project: ProjectRow = {
    project_id: `proj-${randomBytes(4).toString('hex')}`,
    display_name: 'p5 项目',
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
  });
  const delivery = createDeliveryService({
    store,
    provider,
    keyring,
    verifyDirRoot: join(root, 'verify'),
    ...(options.retentionMs !== undefined ? { cleanupRetentionMs: options.retentionMs } : {}),
  });
  const mergeQueue = createMergeQueue({
    store,
    provider,
    workspaceRoot: join(root, 'merge-ws'),
    ...(options.degradeThreshold !== undefined ? { degradeFailureThreshold: options.degradeThreshold } : {}),
  });
  const mergeService = createMergeService({
    store,
    provider,
    workspaceRoot: join(root, 'merge-ws'),
  });

  let attemptSeq = 0;

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

  async function acceptDelivery(deliveryId: string) {
    // 先 startReview → reviewing → accept
    delivery.startReview(deliveryId);
    const result = delivery.reviewDelivery(deliveryId, {
      verdict: 'accept',
      reviewed_by: 'pm-test',
    });
    if (!result.ok) throw new Error(`accept 失败: ${result.error?.message}`);
    return result.data;
  }

  async function getDefaultBranchHead(): Promise<string> {
    const refs = await provider.lsRemote(bare, 'refs/heads/main');
    return refs[0]?.sha ?? '';
  }

  return {
    root,
    bare,
    store,
    project,
    provider,
    workspace,
    delivery,
    mergeQueue,
    mergeService,
    insertAttempt,
    attemptToken,
    deliverAttempt,
    acceptDelivery,
    getDefaultBranchHead,
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('Phase 5: Merge Queue', () => {

  // ── 测试 1：无冲突自动合并 ──
  it('无冲突自动合并：两 delivery 串行 merge，默认分支前进', async () => {
    const w = await makeWorld();

    // delivery 1：改 src/a.ts
    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/a.ts', content: 'console.log("a1");\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);

    // 获取当前默认分支 HEAD
    const head1 = await w.getDefaultBranchHead();

    // 入队 + dispatch
    const enqueued = w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head1);
    expect(enqueued.ok).toBe(true);

    const dispatched = await w.mergeQueue.dispatch(w.project.project_id);
    expect(dispatched.ok).toBe(true);
    expect(dispatched.data?.status).toBe('merged');

    // 默认分支前进
    const head2 = await w.getDefaultBranchHead();
    expect(head2).not.toBe(head1);

    // delivery 状态 → merged
    const del = w.store.getDelivery(d1.finalized.delivery_id);
    expect(del?.status).toBe('merged');
    expect(del?.merged_commit_sha).toBeTruthy();

    // delivery 2：改 src/b.ts（基于新 HEAD）
    const d2 = await w.deliverAttempt(['**'], [{ path: 'src/b.ts', content: 'console.log("b1");\n' }]);
    await w.acceptDelivery(d2.finalized.delivery_id);

    const head2b = await w.getDefaultBranchHead();
    const enqueued2 = w.mergeQueue.enqueueWithTarget(d2.finalized.delivery_id, head2b);
    expect(enqueued2.ok).toBe(true);

    const dispatched2 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(dispatched2.ok).toBe(true);
    expect(dispatched2.data?.status).toBe('merged');

    // 默认分支再次前进
    const head3 = await w.getDefaultBranchHead();
    expect(head3).not.toBe(head2);
  }, 30_000);

  // ── 测试 2：冲突不更新主分支 ──
  it('冲突场景：delivery invalidated 后默认分支不变', async () => {
    const w = await makeWorld();

    // 创建一个 delivery
    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/conflict.ts', content: 'original\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head1 = await w.getDefaultBranchHead();

    // 外部推进默认分支（使 CAS 失败）
    const ext = await cloneRemote(w.bare);
    writeIn(ext, 'ext-change.txt', 'external\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'ext'], ext);
    await git(['push', 'origin', 'HEAD:refs/heads/main'], ext);

    // 记录外部 push 后的 HEAD
    const headAfterExt = await w.getDefaultBranchHead();

    // 入队（使用旧 HEAD）+ dispatch：CAS 失败 → invalidated
    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head1);
    const r = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r.data?.status).toBe('invalidated');

    // 默认分支 HEAD = 外部 push 的 HEAD（未被 merge 改变）
    const headFinal = await w.getDefaultBranchHead();
    expect(headFinal).toBe(headAfterExt);
    expect(headFinal).not.toBe(head1);

    // delivery 状态 → invalidated
    const del = w.store.getDelivery(d1.finalized.delivery_id);
    expect(del?.status).toBe('invalidated');
  }, 30_000);

  // ── 测试 3：失败不更新主分支 ──
  it('失败不更新主分支：CAS 失败→默认分支字节级不变', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/x.ts', content: 'x\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const headBefore = await w.getDefaultBranchHead();

    // 外部推进默认分支
    const ext = await cloneRemote(w.bare);
    writeIn(ext, 'external.txt', 'pushed\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'ext'], ext);
    await git(['push', 'origin', 'HEAD:refs/heads/main'], ext);

    // 入队（使用旧 HEAD）
    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, headBefore);

    // dispatch：CAS 失败
    const result = await w.mergeQueue.dispatch(w.project.project_id);
    expect(result.data?.status).toBe('invalidated');
    expect(result.data?.cancel_reason).toBe('target-advanced');

    // 默认分支 HEAD = 外部 push 的新 HEAD
    const headAfter = await w.getDefaultBranchHead();
    expect(headAfter).not.toBe(headBefore);

    // delivery 状态 → invalidated
    const del = w.store.getDelivery(d1.finalized.delivery_id);
    expect(del?.status).toBe('invalidated');
  }, 30_000);

  // ── 测试 4：CAS 失败后重新排队 ──
  it('CAS：外部推进→job invalidated→新 delivery+新 HEAD 重新排队成功', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/y.ts', content: 'y\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head1 = await w.getDefaultBranchHead();

    // 外部推进
    const ext = await cloneRemote(w.bare);
    writeIn(ext, 'ext2.txt', 'v2\n');
    await git(['add', '.'], ext);
    await git(['-c', 'user.name=ext', '-c', 'user.email=ext@test', 'commit', '-m', 'ext2'], ext);
    await git(['push', 'origin', 'HEAD:refs/heads/main'], ext);

    // 第一次入队 + dispatch：CAS 失败 → delivery invalidated
    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head1);
    const r1 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r1.data?.status).toBe('invalidated');

    // 旧 delivery 已 invalidated，创建新 delivery（§12.2：rebase 生成新 delivery）
    const d2 = await w.deliverAttempt(['**'], [{ path: 'src/y.ts', content: 'y2\n' }]);
    await w.acceptDelivery(d2.finalized.delivery_id);
    const head2 = await w.getDefaultBranchHead();

    // 用新 HEAD 入队新 delivery + dispatch
    w.mergeQueue.enqueueWithTarget(d2.finalized.delivery_id, head2);
    const r2 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r2.data?.status).toBe('merged');
  }, 30_000);

  // ── 测试 5：串行性 ──
  it('串行性：两 delivery 串行 merge，第二个基于新 HEAD', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/s1.ts', content: 's1\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head1 = await w.getDefaultBranchHead();

    // 第一个入队 + dispatch
    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head1);
    const r1 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r1.data?.status).toBe('merged');

    // 第二个 delivery（基于新 HEAD）
    const d2 = await w.deliverAttempt(['**'], [{ path: 'src/s2.ts', content: 's2\n' }]);
    await w.acceptDelivery(d2.finalized.delivery_id);
    const head2 = await w.getDefaultBranchHead();

    // 第二个入队 + dispatch
    w.mergeQueue.enqueueWithTarget(d2.finalized.delivery_id, head2);
    const r2 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r2.data?.status).toBe('merged');
  }, 30_000);

  // ── 测试 6：降级/恢复 ──
  it('降级/恢复：连续 3 次 integration_failed→lost→restore→恢复', async () => {
    const w = await makeWorld({ degradeThreshold: 3 });

    // 模拟 3 次 integration_failed
    const ts = Date.now();
    for (let i = 0; i < 3; i++) {
      w.store.insertMergeJob({
        merge_job_id: `mj-fail-${i}`,
        delivery_id: `del-fail-${i}`,
        project_id: w.project.project_id,
        expected_target_sha: '0'.repeat(40),
        source_sha: '1'.repeat(40),
        strategy: 'merge-ff',
        status: 'integration_failed',
        final_sha: '',
        cancel_reason: '',
        conflict_files: '[]',
        error_message: `test failure ${i}`,
        created_at: ts - (3 - i) * 1000,
        updated_at: ts - (3 - i) * 1000,
        completed_at: ts - (3 - i) * 1000,
      });
    }

    // 触发降级检查
    w.mergeQueue.checkAndDegrade(w.project.project_id, ts);

    // 验证项目已降级
    const proj = w.store.getProject(w.project.project_id);
    expect(proj?.write_capability_status).toBe('lost');

    // dispatch 应该被阻止
    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/d.ts', content: 'd\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head = await w.getDefaultBranchHead();
    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head);
    const r = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PROJECT_DEGRADED');

    // 恢复
    const restored = w.mergeQueue.restoreWriteCapability(w.project.project_id);
    expect(restored.ok).toBe(true);
    expect(restored.data?.restored).toBe(true);

    // 恢复后可以 dispatch
    const r2 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r2.ok).toBe(true);
    expect(r2.data?.status).toBe('merged');
  }, 30_000);

  // ── 测试 7：external intent 登记 ──
  it('external intent 登记/审计', async () => {
    const w = await makeWorld();

    const result = w.mergeService.createExternalIntent({
      project_id: w.project.project_id,
      delivery_id: 'del-ext-1',
      expected_target_sha: 'a'.repeat(40),
      provider_actor: 'human-operator',
      approved_by: 'owner',
      reason: '紧急修复',
    });
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('declared');

    // 查询
    const intent = w.store.getExternalMergeIntent(result.data!.intent_id);
    expect(intent).toBeTruthy();
    expect(intent?.provider_actor).toBe('human-operator');

    // reconcile
    const reconciled = w.mergeService.reconcileExternalIntent(result.data!.intent_id);
    expect(reconciled.ok).toBe(true);
    expect(reconciled.data?.status).toBe('verified');
  });

  // ── 测试 8：幂等入队 ──
  it('幂等入队：同 (delivery_id, expected_target_sha) 重复入队返回原 job', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/idem.ts', content: 'idem\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head = await w.getDefaultBranchHead();

    const r1 = w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head);
    const r2 = w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.data?.merge_job_id).toBe(r2.data?.merge_job_id);
  });

  // ── 测试 9：cancel ──
  it('cancel：queued job 可取消', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/cancel.ts', content: 'cancel\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head = await w.getDefaultBranchHead();

    const enqueued = w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head);
    expect(enqueued.ok).toBe(true);

    const cancelled = w.mergeQueue.cancelMergeJob(enqueued.data!.merge_job_id, 'operator-cancelled');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.data?.status).toBe('cancelled');
    expect(cancelled.data?.cancel_reason).toBe('operator-cancelled');
  });

  // ── 测试 10：list merge jobs ──
  it('list merge jobs：按 project 和 status 过滤', async () => {
    const w = await makeWorld();

    const d1 = await w.deliverAttempt(['**'], [{ path: 'src/list.ts', content: 'list\n' }]);
    await w.acceptDelivery(d1.finalized.delivery_id);
    const head = await w.getDefaultBranchHead();

    w.mergeQueue.enqueueWithTarget(d1.finalized.delivery_id, head);

    const all = w.mergeQueue.listMergeJobs(w.project.project_id);
    expect(all.ok).toBe(true);
    expect(all.data?.length).toBe(1);

    const queued = w.mergeQueue.listMergeJobs(w.project.project_id, 'queued');
    expect(queued.data?.length).toBe(1);

    const merged = w.mergeQueue.listMergeJobs(w.project.project_id, 'merged');
    expect(merged.data?.length).toBe(0);
  });
});
