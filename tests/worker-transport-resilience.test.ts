import { describe, expect, it, vi } from 'vitest';
import { runWorkerLoop } from '../src/worker/base.js';

describe('resident Worker transport resilience', () => {
  it('keeps the resident loop alive when claim transport retries are exhausted', async () => {
    const controller = new AbortController();
    let claimCalls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = {
      claim: vi.fn(async () => {
        claimCalls += 1;
        if (claimCalls < 3) throw new Error('fetch failed: ECONNREFUSED');
        controller.abort();
        return { ok: true, data: null };
      }),
      heartbeat: vi.fn(async () => ({ ok: true })),
    } as never;

    await expect(runWorkerLoop({
      agentId: 'resident-worker',
      agentType: 'custom',
      maxTasks: 0,
      exitOnIdle: false,
      idlePollMs: 10,
      skipRegistration: true,
      heartbeatWhenIdle: false,
      signal: controller.signal,
      client,
      execute: async () => { throw new Error('execute must not run'); },
    })).resolves.toBeUndefined();

    expect(claimCalls).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('领取连接异常'));
    warn.mockRestore();
  });
});
