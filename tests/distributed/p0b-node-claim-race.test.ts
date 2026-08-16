/**
 * Phase 0b 测试：两个 Node 对同一 task 的领取竞争
 *
 * 验收演示：两个 Node 对同一 task 的领取竞争只有一个赢家。
 */

import { execSync } from 'node:child_process';

import { describe, it, expect, afterEach } from 'vitest';
import {
  createSimulatedRedis,
  createNode,
  createSimulatedTask,
  nodeRegister,
  nodeClaimTask,
  nodeRenewLease,
  nodeReport,
  declareOwnership,
  releaseOwnership,
  nodePushDelivery,
  cleanupNodeFixtures,
} from './fixtures/node-simulator.js';
import { createBareRemote, cleanupGitFixtures, cloneBare } from './fixtures/git-fixture.js';

afterEach(() => {
  cleanupNodeFixtures();
  cleanupGitFixtures();
});

describe('Node 领取竞争', () => {
  it('两个 Node 同时 claim 同一 task 只有一个赢家', () => {
    const redis = createSimulatedRedis();
    const node1 = createNode({ nodeId: 'node-alpha-001' });
    const node2 = createNode({ nodeId: 'node-beta-002' });

    nodeRegister(redis, node1);
    nodeRegister(redis, node2);
    createSimulatedTask(redis, 'task-1', 'plan-1', '测试任务');

    // 模拟同时 claim：第一个成功，第二个失败
    const result1 = nodeClaimTask(redis, node1.nodeId, 'task-1');
    const result2 = nodeClaimTask(redis, node2.nodeId, 'task-1');

    expect(result1.success).toBe(true);
    expect(result1.claimToken).toBeDefined();
    expect(result2.success).toBe(false);

    // 验证 task 状态
    const task = redis.tasks.get('task-1')!;
    expect(task.status).toBe('running');
    expect(task.claimedBy).toBe(node1.nodeId);
  });

  it('claim 后可以续租', () => {
    const redis = createSimulatedRedis();
    const node = createNode({ nodeId: 'node-renew-001' });
    nodeRegister(redis, node);
    createSimulatedTask(redis, 'task-r', 'plan-1', '续租测试');

    const claim = nodeClaimTask(redis, node.nodeId, 'task-r');
    expect(claim.success).toBe(true);

    const renew = nodeRenewLease(redis, node.nodeId, 'task-r');
    expect(renew.success).toBe(true);
    expect(renew.newExpireAt).toBeGreaterThan(Date.now());
  });

  it('非 owner 续租失败', () => {
    const redis = createSimulatedRedis();
    const node1 = createNode({ nodeId: 'node-owner-001' });
    const node2 = createNode({ nodeId: 'node-other-002' });
    nodeRegister(redis, node1);
    nodeRegister(redis, node2);
    createSimulatedTask(redis, 'task-x', 'plan-1', '续租冲突');

    nodeClaimTask(redis, node1.nodeId, 'task-x');
    const renew = nodeRenewLease(redis, node2.nodeId, 'task-x');
    expect(renew.success).toBe(false);
  });

  it('claim 后可以 report done', () => {
    const redis = createSimulatedRedis();
    const node = createNode({ nodeId: 'node-report-001' });
    nodeRegister(redis, node);
    createSimulatedTask(redis, 'task-d', 'plan-1', '报告测试');

    nodeClaimTask(redis, node.nodeId, 'task-d');
    const report = nodeReport(redis, node.nodeId, 'task-d', 'done');
    expect(report.success).toBe(true);

    const task = redis.tasks.get('task-d')!;
    expect(task.status).toBe('done');
  });

  it('非 owner report 失败', () => {
    const redis = createSimulatedRedis();
    const node1 = createNode({ nodeId: 'node-r1-001' });
    const node2 = createNode({ nodeId: 'node-r2-002' });
    nodeRegister(redis, node1);
    nodeRegister(redis, node2);
    createSimulatedTask(redis, 'task-y', 'plan-1', '报告冲突');

    nodeClaimTask(redis, node1.nodeId, 'task-y');
    const report = nodeReport(redis, node2.nodeId, 'task-y', 'done');
    expect(report.success).toBe(false);
  });
});

describe('文件所有权竞争', () => {
  it('同一文件不能被两个不同 task 同时声明', () => {
    const redis = createSimulatedRedis();
    const node1 = createNode({ nodeId: 'node-own1-001' });
    const node2 = createNode({ nodeId: 'node-own2-002' });
    nodeRegister(redis, node1);
    nodeRegister(redis, node2);
    createSimulatedTask(redis, 'task-a', 'plan-1', '任务A');
    createSimulatedTask(redis, 'task-b', 'plan-1', '任务B');

    // node1 claim task-a, node2 claim task-b
    nodeClaimTask(redis, node1.nodeId, 'task-a');
    nodeClaimTask(redis, node2.nodeId, 'task-b');

    // node1 声明 shared.ts
    const r1 = declareOwnership(redis, node1.nodeId, 'task-a', ['shared.ts']);
    expect(r1.success).toBe(true);
    expect(r1.conflicts).toHaveLength(0);

    // node2 尝试声明同一文件 → 冲突
    const r2 = declareOwnership(redis, node2.nodeId, 'task-b', ['shared.ts']);
    expect(r2.success).toBe(false);
    expect(r2.conflicts).toContain('shared.ts');
  });

  it('释放所有权后可以被其他 task 声明', () => {
    const redis = createSimulatedRedis();
    const node1 = createNode({ nodeId: 'node-rel1-001' });
    const node2 = createNode({ nodeId: 'node-rel2-002' });
    nodeRegister(redis, node1);
    nodeRegister(redis, node2);
    createSimulatedTask(redis, 'task-c', 'plan-1', '任务C');
    createSimulatedTask(redis, 'task-d', 'plan-1', '任务D');

    nodeClaimTask(redis, node1.nodeId, 'task-c');
    nodeClaimTask(redis, node2.nodeId, 'task-d');

    declareOwnership(redis, node1.nodeId, 'task-c', ['lib.ts']);
    releaseOwnership(redis, node1.nodeId, ['lib.ts']);

    // 现在 node2 可以声明
    const r = declareOwnership(redis, node2.nodeId, 'task-d', ['lib.ts']);
    expect(r.success).toBe(true);
  });
});

describe('Node push 交付', () => {
  it('节点可以 push 到 bare remote', () => {
    const bare = createBareRemote();
    const node = createNode({ nodeId: 'node-push-001' });

    // 先 clone bare 到 node 目录
    const clonePath = cloneBare(bare);
    // 复制到 node.clonePath
    execSync(`cp -r "${clonePath}/." "${node.clonePath}/"`, { stdio: 'pipe' });

    const result = nodePushDelivery(node, bare, 'output.txt', 'task output');
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
  });
});
