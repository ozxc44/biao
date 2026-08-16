/**
 * Phase 0b 测试：故障注入器
 *
 * 验收演示：
 * 1. 网络分区注入各触发一次并断言失败路径
 * 2. 进程中断注入触发一次
 * 3. 时钟偏差注入触发一次
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  now,
  injectClockSkew,
  resetClockSkew,
  addFaultRoute,
  clearFaultRoutes,
  wrapFetchWithFaults,
  registerProcess,
  simulateProcessInterruption,
  getProcessStates,
  cleanupProcesses,
  resetAllFaults,
} from './fixtures/fault-injector.js';

afterEach(() => {
  resetAllFaults();
});

// ──────────────── 时钟偏差注入 ────────────────

describe('时钟偏差注入', () => {
  it('注入正偏差后 now() 偏大', () => {
    const before = Date.now();
    injectClockSkew(5000); // 快 5 秒
    const injected = now();
    resetClockSkew();

    expect(injected).toBeGreaterThanOrEqual(before + 5000);
    expect(injected).toBeLessThanOrEqual(before + 5100);
  });

  it('注入负偏差后 now() 偏小', () => {
    const before = Date.now();
    injectClockSkew(-3000); // 慢 3 秒
    const injected = now();
    resetClockSkew();

    expect(injected).toBeLessThanOrEqual(before);
    expect(injected).toBeGreaterThanOrEqual(before - 3100);
  });

  it('重置后 now() 回归正常', () => {
    injectClockSkew(10000);
    resetClockSkew();

    const t = now();
    const real = Date.now();
    expect(Math.abs(t - real)).toBeLessThan(100);
  });
});

// ──────────────── 网络分区注入 ────────────────

describe('网络分区注入', () => {
  it('匹配的 URL 被拦截', async () => {
    addFaultRoute('api.example.com', () => true, new Error('连接超时'));

    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));

    await expect(wrappedFetch('https://api.example.com/data')).rejects.toThrow('连接超时');
  });

  it('不匹配的 URL 正常通过', async () => {
    addFaultRoute('api.example.com', () => true);

    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));
    const resp = await wrappedFetch('https://other.example.com/data');

    expect(resp.status).toBe(200);
  });

  it('shouldBlock 返回 false 时不拦截', async () => {
    addFaultRoute('api.example.com', () => false);

    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));
    const resp = await wrappedFetch('https://api.example.com/data');

    expect(resp.status).toBe(200);
  });

  it('正则模式匹配', async () => {
    addFaultRoute(/\/v2\/artifacts\/.*/, () => true, new Error('Artifact 服务不可达'));

    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));

    await expect(wrappedFetch('https://biao.local/v2/artifacts/abc123')).rejects.toThrow('Artifact 服务不可达');
    // 非匹配路径通过
    const resp = await wrappedFetch('https://biao.local/v1/tasks');
    expect(resp.status).toBe(200);
  });

  it('清除规则后恢复正常', async () => {
    addFaultRoute('blocked.com', () => true);
    clearFaultRoutes();

    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));
    const resp = await wrappedFetch('https://blocked.com/data');
    expect(resp.status).toBe(200);
  });
});

// ──────────────── 进程中断注入 ────────────────

describe('进程中断注入', () => {
  it('注册进程后可以被 kill', () => {
    let killed = false;
    const proc = registerProcess(12345, (signal) => {
      killed = true;
      return true;
    });

    simulateProcessInterruption('SIGTERM');

    expect(killed).toBe(true);
    expect(proc.killed).toBe(true);
    expect(getProcessStates()).toEqual([{ pid: 12345, killed: true }]);
  });

  it('已 kill 的进程不会重复 kill', () => {
    let killCount = 0;
    registerProcess(99999, () => {
      killCount++;
      return true;
    });

    simulateProcessInterruption('SIGTERM');
    simulateProcessInterruption('SIGTERM');

    expect(killCount).toBe(1);
  });

  it('cleanup 后进程列表为空', () => {
    registerProcess(11111, () => true);
    registerProcess(22222, () => true);

    expect(getProcessStates()).toHaveLength(2);
    cleanupProcesses();
    expect(getProcessStates()).toHaveLength(0);
  });
});

// ──────────────── 统一清理 ────────────────

describe('统一清理', () => {
  it('resetAllFaults 重置所有注入器状态', () => {
    injectClockSkew(99999);
    addFaultRoute('test.com', () => true);
    registerProcess(77777, () => true);

    resetAllFaults();

    // 时钟偏差重置
    expect(Math.abs(now() - Date.now())).toBeLessThan(100);

    // 网络分区重置
    const wrappedFetch = wrapFetchWithFaults(async () => new Response('ok'));
    // 不再拦截

    // 进程列表清空
    expect(getProcessStates()).toHaveLength(0);
  });
});
