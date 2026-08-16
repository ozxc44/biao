/**
 * Phase 9 失败优先测试：真·内容冲突闭环（审计不确定-4 / §22.1-09）
 *
 * 补 p5 缺口：p5-merge-queue「冲突场景」实为外部推进 CAS 失败，未驱动 merge queue 的
 * conflict 分支（queue.ts:288-300）。本测试用真实 git 驱动：
 *   两个 delivery 改同一行 → 第二个 job conflict + conflict_files 落库 +
 *   delivery 保持 accepted + 默认分支不动 + 修复路径可走（新 delivery 重交付后 merged）。
 *
 * 只加测试，不改 merge/**。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import { parseCredentialKey, issueAttemptToken } from '../../src/server/v2/credentials.js';
import { GenericGitProvider } from '../../src/server/v2/git/generic-git.js';
import { createWorkspaceService } from '../../src/server/v2/git/workspace.js';
import { createDeliveryService } from '../../src/server/v2/delivery-service.js';
import { createMergeQueue } from '../../src/server/v2/merge/queue.js';

const execFileAsync = promisify(execFile);
const TEST_KEY = 'ccddeeff'.repeat(8);

const tempDirs: string[] = [];

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function createBareRemote(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'p9c-bare-'));
  tempDirs.push(dir);
  const bare = join(dir, 'repo.git');
  await git(['init', '--bare', '-b', 'main', bare]);
  const seedRoot = mkdtempSync(join(tmpdir(), 'p9c-seed-'));
  tempDirs.push(seedRoot);
  const seed = join(seedRoot, 'repo');
  await git(['clone', bare, seed]);
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, 'src', 'shared.ts'), 'const v = "seed";\n');
  await git(['add', '.'], seed);
  await git(['-c', 'user.name=p9c', '-c', 'user.email=p9c@test', 'commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'HEAD:refs/heads/main'], seed);
  return bare;
}

function writeIn(root: string, relPath: string, content: string): void {
  const target = join(root, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

async function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'p9c-world-'));
  tempDirs.push(root);
  const bare = await createBareRemote();
  const store = new SqliteStore(':memory:');
  const now = Date.now();
  const project: ProjectRow = {
    project_id: `proj-${randomBytes(4).toString('hex')}`,
    display_name: 'p9c 项目',
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
    diskUsagePercent: () => 20,
  });
  const delivery = createDeliveryService({
    store,
    provider,
    keyring,
    verifyDirRoot: join(root, 'verify'),
  });
  const mergeQueue = createMergeQueue({
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
    return { attemptId, taskId, finalized: finalized.data };
  }

  async function acceptDelivery(deliveryId: string) {
    delivery.startReview(deliveryId);
    const result = delivery.reviewDelivery(deliveryId, { verdict: 'accept', reviewed_by: 'pm-test' });
    if (!result.ok) throw new Error(`accept 失败: ${result.error?.message}`);
    return result.data;
  }

  async function getDefaultBranchHead(): Promise<string> {
    const refs = await provider.lsRemote(bare, 'refs/heads/main');
    return refs[0]?.sha ?? '';
  }

  return { root, bare, store, project, provider, workspace, delivery, mergeQueue, deliverAttempt, acceptDelivery, getDefaultBranchHead };
}

afterAll(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('Phase 9: 真·内容冲突闭环（§22.1-09 / 审计不确定-4）', () => {
  it('两 delivery 改同一行 → 第二个 conflict + conflict_files 落库 + 默认分支不动 + 修复可 merged', async () => {
    const w = await makeWorld();

    // 两个 delivery 都基于 seed HEAD，改同一行不同值
    const dA = await w.deliverAttempt(['**'], [{ path: 'src/shared.ts', content: 'const v = "a";\n' }]);
    const dB = await w.deliverAttempt(['**'], [{ path: 'src/shared.ts', content: 'const v = "b";\n' }]);
    await w.acceptDelivery(dA.finalized.delivery_id);
    await w.acceptDelivery(dB.finalized.delivery_id);

    // 第一个合并成功
    const head0 = await w.getDefaultBranchHead();
    const enqA = w.mergeQueue.enqueueWithTarget(dA.finalized.delivery_id, head0);
    expect(enqA.ok).toBe(true);
    const dispatchedA = await w.mergeQueue.dispatch(w.project.project_id);
    expect(dispatchedA.ok).toBe(true);
    expect(dispatchedA.data?.status).toBe('merged');
    const head1 = await w.getDefaultBranchHead();
    expect(head1).not.toBe(head0);

    // 第二个入队（target = 当前 HEAD，CAS 通过）→ 真内容冲突
    const enqB = w.mergeQueue.enqueueWithTarget(dB.finalized.delivery_id, head1);
    expect(enqB.ok).toBe(true);
    const dispatchedB = await w.mergeQueue.dispatch(w.project.project_id);
    expect(dispatchedB.ok).toBe(true);
    const jobB = dispatchedB.data!;
    expect(jobB.status).toBe('conflict');
    // conflict_files 落库（审计载体）
    const conflictFiles = JSON.parse(jobB.conflict_files) as string[];
    expect(conflictFiles).toContain('src/shared.ts');
    expect(jobB.error_message).toContain('merge 冲突');

    // delivery B 保持 accepted（可重新交付，不误伤）
    const delB = w.store.getDelivery(dB.finalized.delivery_id)!;
    expect(delB.status).toBe('accepted');

    // 默认分支不动（仍为 A 合并后的 HEAD）
    const headAfterConflict = await w.getDefaultBranchHead();
    expect(headAfterConflict).toBe(head1);

    // 修复路径：基于当前 HEAD 重交付（内容已收敛），accept 后 merged
    const dC = await w.deliverAttempt(['**'], [{ path: 'src/shared.ts', content: 'const v = "resolved";\n' }]);
    await w.acceptDelivery(dC.finalized.delivery_id);
    const head2 = await w.getDefaultBranchHead();
    const enqC = w.mergeQueue.enqueueWithTarget(dC.finalized.delivery_id, head2);
    expect(enqC.ok).toBe(true);
    const dispatchedC = await w.mergeQueue.dispatch(w.project.project_id);
    expect(dispatchedC.ok).toBe(true);
    expect(dispatchedC.data?.status).toBe('merged');

    const delC = w.store.getDelivery(dC.finalized.delivery_id)!;
    expect(delC.status).toBe('merged');
    const headFinal = await w.getDefaultBranchHead();
    expect(headFinal).not.toBe(head2);
  }, 60_000);

  it('conflict job 不触发降级且后续排队不受污染', async () => {
    const w = await makeWorld();

    const dA = await w.deliverAttempt(['**'], [{ path: 'src/only.ts', content: 'const x = 1;\n' }]);
    await w.acceptDelivery(dA.finalized.delivery_id);
    const head0 = await w.getDefaultBranchHead();
    w.mergeQueue.enqueueWithTarget(dA.finalized.delivery_id, head0);
    const r1 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r1.data?.status).toBe('merged');

    // 后续正常 delivery 仍可 merged（conflict 不影响项目写能力）
    const d2 = await w.deliverAttempt(['**'], [{ path: 'src/next.ts', content: 'const y = 2;\n' }]);
    await w.acceptDelivery(d2.finalized.delivery_id);
    const head1 = await w.getDefaultBranchHead();
    w.mergeQueue.enqueueWithTarget(d2.finalized.delivery_id, head1);
    const r2 = await w.mergeQueue.dispatch(w.project.project_id);
    expect(r2.ok).toBe(true);
    expect(r2.data?.status).toBe('merged');

    const proj = w.store.getProject(w.project.project_id);
    expect(proj?.write_capability_status).toBe('ready');
  }, 60_000);
});
