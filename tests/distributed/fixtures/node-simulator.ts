/**
 * 逻辑 Node 模拟器 — Phase 0b
 *
 * 同一测试进程内两个隔离 Node 身份（不同本地 clone 路径），
 * 共享一个测试 Redis namespace 与 bare remote；
 * 提供"节点注册/心跳/领取/推送交付"的最小骨架函数。
 * 后续 Phase 3 biao-node 的测试替身。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { BareRemote } from './git-fixture.js';
import { cloneBare, gitExec, commitAndPush } from './git-fixture.js';
import type { ArtifactStore, UploadResult } from './artifact-store-fixture.js';
import { uploadArtifact, sha256hex } from './artifact-store-fixture.js';

const tempDirs: string[] = [];

export interface NodeIdentity {
  nodeId: string;
  credentialGeneration: number;
  /** 节点本地 clone 路径 */
  clonePath: string;
  /** 节点数据目录 */
  dataDir: string;
  /** 当前 claim 的 task_id（如有） */
  activeTaskId: string | null;
  /** 当前 claim token */
  claimToken: string | null;
}

export interface SimulatedTask {
  taskId: string;
  planId: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked';
  claimedBy: string | null;
  claimToken: string | null;
  leaseExpireAt: number;
  ownershipFiles: string[];
}

export interface SimulatedRedis {
  /** task hash: taskId → SimulatedTask */
  tasks: Map<string, SimulatedTask>;
  /** lease: taskId → { token, expireAt } */
  leases: Map<string, { token: string; expireAt: number }>;
  /** ownership: file → { agentId, taskId } */
  ownership: Map<string, { agentId: string; taskId: string }>;
  /** node registry: nodeId → NodeIdentity */
  nodes: Map<string, NodeIdentity>;
}

/**
 * 创建模拟 Redis namespace。
 */
export function createSimulatedRedis(): SimulatedRedis {
  return {
    tasks: new Map(),
    leases: new Map(),
    ownership: new Map(),
    nodes: new Map(),
  };
}

/**
 * 创建一个逻辑 Node 身份。
 */
export function createNode(identity: { nodeId?: string; credentialGeneration?: number } = {}): NodeIdentity {
  const dataDir = mkdtempSync(join(tmpdir(), 'biao-node-'));
  tempDirs.push(dataDir);
  const clonePath = join(dataDir, 'clone');
  mkdirSync(clonePath, { recursive: true });

  return {
    nodeId: identity.nodeId ?? `node-${randomUUID().slice(0, 8)}`,
    credentialGeneration: identity.credentialGeneration ?? 1,
    clonePath,
    dataDir,
    activeTaskId: null,
    claimToken: null,
  };
}

/**
 * 节点注册（骨架）：将节点写入模拟 Redis。
 */
export function nodeRegister(redis: SimulatedRedis, node: NodeIdentity): void {
  redis.nodes.set(node.nodeId, { ...node });
}

/**
 * 节点心跳（骨架）：更新最后心跳时间。
 * 返回节点当前状态。
 */
export function nodeHeartbeat(
  redis: SimulatedRedis,
  nodeId: string,
): { status: 'online' | 'unknown'; clockSkewMs: number } {
  const node = redis.nodes.get(nodeId);
  if (!node) return { status: 'unknown', clockSkewMs: 0 };
  return { status: 'online', clockSkewMs: 0 };
}

/**
 * 领取任务（骨架）：模拟 claim 语义。
 * 两个节点同时 claim 同一 task 只有一个赢家。
 * 返回 { success, claimToken } 或 { success: false }。
 */
export function nodeClaimTask(
  redis: SimulatedRedis,
  nodeId: string,
  taskId: string,
): { success: boolean; claimToken?: string } {
  const node = redis.nodes.get(nodeId);
  if (!node) return { success: false };

  const task = redis.tasks.get(taskId);
  if (!task) return { success: false };
  if (task.status !== 'pending') return { success: false };

  // 检查 lease（CAS 竞争）
  const existingLease = redis.leases.get(taskId);
  if (existingLease && existingLease.expireAt > Date.now()) {
    return { success: false };
  }

  // 签发 lease
  const claimToken = createHash('sha256')
    .update(`${nodeId}:${taskId}:${Date.now()}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 32);

  const leaseDuration = 600_000; // 10 分钟
  redis.leases.set(taskId, { token: claimToken, expireAt: Date.now() + leaseDuration });
  task.status = 'running';
  task.claimedBy = nodeId;
  task.claimToken = claimToken;
  task.leaseExpireAt = Date.now() + leaseDuration;

  node.activeTaskId = taskId;
  node.claimToken = claimToken;

  return { success: true, claimToken };
}

/**
 * 续租（骨架）。
 */
export function nodeRenewLease(
  redis: SimulatedRedis,
  nodeId: string,
  taskId: string,
): { success: boolean; newExpireAt?: number } {
  const task = redis.tasks.get(taskId);
  if (!task || task.claimedBy !== nodeId) return { success: false };

  const lease = redis.leases.get(taskId);
  if (!lease || lease.token !== task.claimToken) return { success: false };

  const newExpireAt = Date.now() + 600_000;
  lease.expireAt = newExpireAt;
  task.leaseExpireAt = newExpireAt;
  return { success: true, newExpireAt };
}

/**
 * 报告任务完成（骨架）。
 */
export function nodeReport(
  redis: SimulatedRedis,
  nodeId: string,
  taskId: string,
  status: 'done' | 'failed',
  artifactRef?: { sha256: string; kind: string },
): { success: boolean } {
  const task = redis.tasks.get(taskId);
  if (!task || task.claimedBy !== nodeId) return { success: false };

  task.status = status;
  return { success: true };
}

/**
 * 推送交付到 bare remote（骨架）。
 * 在节点 clone 中创建 commit 并 push。
 */
export function nodePushDelivery(
  node: NodeIdentity,
  bare: BareRemote,
  filename: string,
  content: string,
): { sha: string } {
  if (!existsSync(join(node.clonePath, '.git'))) {
    // 初始化 clone
    const clonePath = cloneBare(bare);
    // 将 clone 内容复制到 node.clonePath
    execSync(`cp -r "${clonePath}/." "${node.clonePath}/"`, { stdio: 'pipe' });
  }

  const sha = commitAndPush(node.clonePath, filename, content, `delivery by ${node.nodeId}`);
  return { sha };
}

/**
 * 声明文件所有权（骨架）。
 */
export function declareOwnership(
  redis: SimulatedRedis,
  nodeId: string,
  taskId: string,
  files: string[],
): { success: boolean; conflicts: string[] } {
  const conflicts: string[] = [];
  for (const file of files) {
    const existing = redis.ownership.get(file);
    if (existing && existing.agentId !== nodeId && existing.taskId !== taskId) {
      conflicts.push(file);
    }
  }
  if (conflicts.length > 0) return { success: false, conflicts };

  for (const file of files) {
    redis.ownership.set(file, { agentId: nodeId, taskId });
  }
  return { success: true, conflicts: [] };
}

/**
 * 释放文件所有权（骨架）。
 */
export function releaseOwnership(
  redis: SimulatedRedis,
  nodeId: string,
  files: string[],
): void {
  for (const file of files) {
    const existing = redis.ownership.get(file);
    if (existing && existing.agentId === nodeId) {
      redis.ownership.delete(file);
    }
  }
}

/**
 * 创建模拟任务。
 */
export function createSimulatedTask(
  redis: SimulatedRedis,
  taskId: string,
  planId: string,
  title: string,
): SimulatedTask {
  const task: SimulatedTask = {
    taskId,
    planId,
    title,
    status: 'pending',
    claimedBy: null,
    claimToken: null,
    leaseExpireAt: 0,
    ownershipFiles: [],
  };
  redis.tasks.set(taskId, task);
  return task;
}

/**
 * 清理所有临时 Node 目录。
 */
export function cleanupNodeFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
