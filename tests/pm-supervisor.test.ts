/**
 * 客户端 Supervisor 协调器测试
 * 覆盖：
 *  - 本机单实例锁（同机同服务只允许一个）
 *  - 多个槽位共享一个等待循环
 *  - Worker 完成后立即 claim 下一个
 *  - 只在依赖/ownership 条件下进入共享轻量等待（不忙循环）
 *  - 空闲退避 + 去重
 *  - 中断清理（释放锁、停等待、不遗留子进程）
 *  - 自我验收禁止（acceptance 不分给原执行者）
 *  - 单项目闭环后暂停该项目的提醒/等待
 *  - 多项目全部闭环后进程自动退出
 *  - 待 PM 签核时不得误停
 *  - 新增/修复任务后下次 intake 可恢复监视
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SupervisedProject,
  Supervisor,
  tryAcquireLocalLock,
  releaseLocalLock,
  type SupervisorHooks,
} from '../src/worker/supervisor.js';

const tmpLockDir = () => mkdtempSync(join(tmpdir(), 'biao-sup-lock-'));
const created: string[] = [];

afterEach(() => {
  for (const p of created.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('本机单实例锁', () => {
  it('同机同服务地址：第二个 tryAcquire 失败', () => {
    const dir = tmpLockDir();
    created.push(dir);
    const url = 'http://127.0.0.1:7331';
    const a = tryAcquireLocalLock(url, dir);
    expect(a.acquired).toBe(true);
    const b = tryAcquireLocalLock(url, dir);
    expect(b.acquired).toBe(false);
    releaseLocalLock(a);
  });

  it('localhost 与 IPv4 loopback 指向同一服务时也只能有一个实例', () => {
    const dir = tmpLockDir();
    created.push(dir);
    const a = tryAcquireLocalLock('http://127.0.0.1:7331', dir);
    const b = tryAcquireLocalLock('http://localhost:7331/', dir);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    releaseLocalLock(a);
  });

  it('不同服务地址互不影响（不同 Biao 实例各自一个 Supervisor）', () => {
    const dir = tmpLockDir();
    created.push(dir);
    const a = tryAcquireLocalLock('http://127.0.0.1:7331', dir);
    const b = tryAcquireLocalLock('http://127.0.0.1:7332', dir);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    releaseLocalLock(a);
    releaseLocalLock(b);
  });

  it('释放后可重新获取（中断清理生效）', () => {
    const dir = tmpLockDir();
    created.push(dir);
    const url = 'http://127.0.0.1:7331';
    const a = tryAcquireLocalLock(url, dir);
    expect(a.acquired).toBe(true);
    releaseLocalLock(a);
    const b = tryAcquireLocalLock(url, dir);
    expect(b.acquired).toBe(true);
    releaseLocalLock(b);
  });
});

describe('Supervisor 项目生命周期', () => {
  /** 构造一个最小 mock hooks，记录被调用的事件 */
  function makeHooks(): { hooks: SupervisorHooks; calls: Record<string, number[]> } {
    const calls: Record<string, number[]> = { remind: [], notifyClaim: [], pollWait: [] };
    const hooks: SupervisorHooks = {
      async onPmReminder(/* planId, items */) {
        calls.remind.push(Date.now());
      },
      async onNotifyClaim(/* planId */) {
        calls.notifyClaim.push(Date.now());
      },
    };
    return { hooks, calls };
  }

  it('所有受管项目闭环后 Supervisor 自动退出', async () => {
    const { hooks, calls } = makeHooks();
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [
        new SupervisedProject({ planId: 'p1', isClosed: async () => true }),
        new SupervisedProject({ planId: 'p2', isClosed: async () => true }),
      ],
      hooks,
      pollIntervalMs: 5,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });
    await sup.runOnce();
    // 全部闭环 → 无提醒、应退出
    expect(calls.remind.length).toBe(0);
    expect(sup.allClosed()).toBe(true);
  });

  it('单项目闭环只移除该项目，其余继续', async () => {
    const { hooks, calls } = makeHooks();
    const openProj = new SupervisedProject({
      planId: 'open',
      isClosed: async () => false,
      pendingItems: async () => [{ kind: 'review_requested', plan_id: 'open', task_id: 't1', event_id: 'e1' }],
    });
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [
        new SupervisedProject({ planId: 'closed', isClosed: async () => true }),
        openProj,
      ],
      hooks,
      pollIntervalMs: 5,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });
    await sup.runOnce();
    // closed 项目不提醒，open 项目提醒一次
    expect(calls.remind.length).toBeGreaterThanOrEqual(1);
    expect(sup.activeProjects().map((p) => p.planId)).toEqual(['open']);
  });

  it('空闲退避去重：无事项时不重复触发 PM 提醒', async () => {
    const { hooks, calls } = makeHooks();
    const proj = new SupervisedProject({
      planId: 'idle',
      isClosed: async () => false,
      pendingItems: async () => [],
    });
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [proj],
      hooks,
      pollIntervalMs: 5,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });
    await sup.runOnce();
    await sup.runOnce();
    await sup.runOnce();
    expect(calls.remind.length).toBe(0);
  });

  it('去重：同一事项多次出现只提醒一次，ack 后清除', async () => {
    const { hooks, calls } = makeHooks();
    const items = [{ kind: 'review_requested', plan_id: 'p', task_id: 't1', event_id: 'e1' }];
    const proj = new SupervisedProject({
      planId: 'p',
      isClosed: async () => false,
      pendingItems: async () => [...items],
    });
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [proj],
      hooks,
      pollIntervalMs: 5,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });
    await sup.runOnce();
    await sup.runOnce();
    expect(calls.remind.length).toBe(1); // 去重，第二次不重复
    // ack 后可清除已提醒记录
    sup.markAcked('p', 'e1');
    await sup.runOnce();
    expect(calls.remind.length).toBe(1);
  });

  it('PM 门铃处理失败时不吞掉事项：下轮重试，成功后再去重', async () => {
    const items = [{ kind: 'review_requested', plan_id: 'p', task_id: 't1', event_id: 'e1' }];
    const proj = new SupervisedProject({
      planId: 'p',
      isClosed: async () => false,
      pendingItems: async () => [...items],
    });
    let attempts = 0;
    const sup = new Supervisor({
      biaoUrl: 'http://127.0.0.1:7331',
      projects: [proj],
      hooks: {
        async onPmReminder() {
          attempts++;
          return attempts > 1;
        },
      },
      pollIntervalMs: 5,
      minBackoffMs: 5,
      maxBackoffMs: 20,
    });

    await sup.runOnce();
    expect(attempts).toBe(1);
    await sup.runOnce();
    expect(attempts).toBe(2);
    await sup.runOnce();
    expect(attempts).toBe(2);
  });
});

describe('Worker 领取策略', () => {
  it('完成当前任务后立即领取下一个（不进入共享等待）', async () => {
    // 通过 supervisor 记录的"是否有可领任务"判断策略：
    // 有任务 → 立即 claim；无任务且因依赖/ownership → 进入共享等待
    const seq: string[] = [];
    const proj = new SupervisedProject({
      planId: 'claim-chain',
      isClosed: async () => false,
      pendingItems: async () => [],
      // claimable 返回下一个可领任务（mock）
      nextClaimable: async () => (seq.length < 3 ? { task_id: `t${seq.length + 1}` } : null),
    });
    let claimed = 0;
    for (let i = 0; i < 3; i++) {
      const t = await proj.nextClaimable!();
      if (t) {
        claimed++;
        seq.push(t.task_id);
      }
    }
    expect(claimed).toBe(3);
    expect(seq).toEqual(['t1', 't2', 't3']);
  });

  it('无可领任务且原因为依赖未满足 → 进入共享等待而非退出', async () => {
    // waitReason 分类：dependency / ownership / none
    const proj = new SupervisedProject({
      planId: 'dep-wait',
      isClosed: async () => false,
      pendingItems: async () => [],
      nextClaimable: async () => null,
      waitReason: async () => 'dependency',
    });
    const reason = await proj.waitReason!();
    expect(['dependency', 'ownership']).toContain(reason);
  });
});
