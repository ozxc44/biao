import { describe, expect, it } from 'vitest';
import { RealExecutor } from '../src/node/real-executor.js';
import { SlotTable } from '../src/node/slots.js';
import type { AttemptIntake } from '../src/node/slots.js';

describe('RealExecutor P12 integration', () => {
  it('recordAdopted stores record and triggers async execution chain', async () => {
    const fetchCalls: Array<{ url: string; method: string }> = [];
    const mockFetch = async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
      // Return 200 for all calls
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
    };

    const executor = new RealExecutor({
      biaoApiUrl: 'http://test:7331',
      fetchImpl: mockFetch as unknown as typeof fetch,
      execCommand: 'echo "test-exec-${task_id}"',
      getAttemptToken: () => 'test-token',
    });

    const intake: AttemptIntake = {
      attempt_id: 'att-int-1',
      task_id: 'task-int-1',
      attempt_generation: 1,
      lease_duration_ms: 600_000,
    };

    await executor.recordAdopted(intake, Date.now() + 600_000, 'boot-test');

    // Record should exist immediately
    const record = executor.getRecord('att-int-1');
    expect(record).toBeDefined();
    expect(record?.attempt_id).toBe('att-int-1');
    expect(record?.executor).toBe('real-phase8');

    // Wait for async chain to complete
    await new Promise((r) => setTimeout(r, 500));

    // Check that fetch was called for prepare, finalize, and report
    const prepareCalls = fetchCalls.filter((c) => c.url.includes('/workspace/prepare'));
    const reportCalls = fetchCalls.filter((c) => c.url.includes('/report'));
    expect(prepareCalls.length).toBeGreaterThanOrEqual(1);
    expect(reportCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('executor captures command exit code and output', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });

    const executor = new RealExecutor({
      biaoApiUrl: 'http://test:7331',
      fetchImpl: mockFetch as unknown as typeof fetch,
      execCommand: 'echo "hello from ${task_id}" && echo "err" >&2',
      getAttemptToken: () => 'test-token',
    });

    const intake: AttemptIntake = {
      attempt_id: 'att-exec-1',
      task_id: 'task-exec-1',
      attempt_generation: 1,
      lease_duration_ms: 600_000,
    };

    await executor.recordAdopted(intake, Date.now() + 600_000, 'boot-exec');
    await new Promise((r) => setTimeout(r, 500));

    const record = executor.getRecord('att-exec-1');
    expect(record?.exec_exit_code).toBe(0);
    expect(record?.exec_stdout).toContain('hello from task-exec-1');
    expect(record?.exec_stderr).toContain('err');
    expect(record?.goal_md_file).toBeDefined();
  });

  it('executor reports failed for non-zero exit code', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });

    const executor = new RealExecutor({
      biaoApiUrl: 'http://test:7331',
      fetchImpl: mockFetch as unknown as typeof fetch,
      execCommand: 'exit 42',
      getAttemptToken: () => 'test-token',
    });

    const intake: AttemptIntake = {
      attempt_id: 'att-fail-1',
      task_id: 'task-fail-1',
      attempt_generation: 1,
      lease_duration_ms: 600_000,
    };

    await executor.recordAdopted(intake, Date.now() + 600_000, 'boot-fail');
    await new Promise((r) => setTimeout(r, 500));

    const record = executor.getRecord('att-fail-1');
    expect(record?.exec_exit_code).toBe(42);
    expect(record?.execute_state).toBe('failed');
    expect(record?.error).toContain('exited with code 42');
  });

  it('slot table capacity management', () => {
    const slots = new SlotTable(2);
    expect(slots.freeCount()).toBe(2);
    expect(slots.inUse()).toBe(0);

    expect(slots.occupy('att-1')).toBe(true);
    expect(slots.freeCount()).toBe(1);

    expect(slots.occupy('att-2')).toBe(true);
    expect(slots.freeCount()).toBe(0);

    // At capacity
    expect(slots.occupy('att-3')).toBe(false);

    // Duplicate
    expect(slots.occupy('att-1')).toBe(false);

    slots.release('att-1');
    expect(slots.freeCount()).toBe(1);
  });
});
