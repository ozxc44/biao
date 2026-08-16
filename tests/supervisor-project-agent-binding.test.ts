import { describe, expect, it, vi } from 'vitest';
import {
  BiaoSupervisorRuntime,
  ProjectAgentWakeDispatcher,
  buildBackgroundExecutionReceipt,
  selectProjectAgentBinding,
  type ProjectAgentWakeCandidate,
} from '../src/worker/supervisor.js';
import type { ProjectAgentBinding } from '../src/types/index.js';

const project = '/workspace/project-a';

function binding(patch: Partial<ProjectAgentBinding> = {}): ProjectAgentBinding {
  return {
    binding_id: 'binding-visible', project_scope: project, agent_id: 'visible-agent',
    label: 'Visible Agent', harness_kind: 'custom', capabilities: ['code'],
    wake_mode: 'visible_session', policy: 'on_demand', created_at: 1, updated_at: 1,
    ...patch,
  };
}

const candidate: ProjectAgentWakeCandidate = {
  task_id: 'task-code-1', plan_id: 'plan-a', project_path: project, capability: 'code',
};

describe('ProjectAgentBinding Supervisor selection', () => {
  it('selects by exact project and capability, prefers automatic, and never auto-selects manual', () => {
    const selected = selectProjectAgentBinding([
      binding({ binding_id: 'wrong-project', project_scope: '/workspace/project-b', policy: 'automatic' }),
      binding({ binding_id: 'manual-code', policy: 'manual' }),
      binding({ binding_id: 'on-demand-code', policy: 'on_demand' }),
      binding({ binding_id: 'automatic-review', capabilities: ['review'], policy: 'automatic' }),
      binding({ binding_id: 'automatic-code', policy: 'automatic' }),
    ], candidate);

    expect(selected?.binding_id).toBe('automatic-code');
    expect(selectProjectAgentBinding([binding({ policy: 'manual' })], candidate)).toBeUndefined();
  });

  it('writes succeeded only from a validated adapter receipt and recovers by skipping durable success', async () => {
    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const wake = vi.fn(async () => ({
      protocol: 'biao.worker-wake/v1', ok: true,
      adapter_id: 'custom-visible-v1', registration_id: 'registration_visible_1',
      harness_kind: 'custom', wake_mode: 'visible_session',
      session_ref: 'visible-session-1', visible_url: 'https://sessions.example.test/visible-session-1',
    }));
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [{
        bindingId: 'binding-visible', agentId: 'visible-agent', harnessKind: 'custom',
        wakeMode: 'visible_session', adapterId: 'custom-visible-v1', wake,
      }],
      appendReceipt,
      attemptId: () => 'wake-attempt-1',
      now: () => 1_800_000_000_000,
    });

    const first = await dispatcher.dispatch([candidate], [binding()], []);
    expect(first).toMatchObject({ selected: 1, succeeded: 1, failed: 0 });
    expect(wake).toHaveBeenCalledOnce();
    expect(appendReceipt).toHaveBeenCalledWith(project, expect.objectContaining({
      attempt_id: 'wake-attempt-1', task_id: 'task-code-1', binding_id: 'binding-visible',
      harness_kind: 'custom', wake_mode: 'visible_session', adapter_id: 'custom-visible-v1',
      status: 'succeeded', session_ref: 'visible-session-1',
    }));

    const durable = [{
      attempt_id: 'old-attempt', task_id: candidate.task_id, project_scope: project,
      binding_id: 'binding-visible', agent_id: 'visible-agent', harness_kind: 'custom',
      wake_mode: 'visible_session' as const, adapter_id: 'custom-visible-v1',
      status: 'succeeded' as const, started_at: 1,
    }];
    const restarted = new ProjectAgentWakeDispatcher({
      slots: [{
        bindingId: 'binding-visible', agentId: 'visible-agent', harnessKind: 'custom',
        wakeMode: 'visible_session', adapterId: 'custom-visible-v1', wake,
      }], appendReceipt, attemptId: () => 'must-not-run',
    });
    const second = await restarted.dispatch([candidate], [binding()], durable);
    expect(second).toMatchObject({ selected: 1, skipped: 1, succeeded: 0 });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('matches a harness-owned wake slot by agent identity without a preconfigured binding id', async () => {
    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const wake = vi.fn(async () => ({
      protocol: 'biao.worker-wake/v1', ok: true,
      adapter_id: 'glm-heartbeat-v1', registration_id: 'registration_glm_1',
      harness_kind: 'glm', wake_mode: 'external_worker',
    }));
    const automatic = binding({
      binding_id: 'binding-created-by-project',
      agent_id: 'remote-glm',
      harness_kind: 'glm',
      wake_mode: 'external_worker',
      policy: 'automatic',
    });
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [{
        agentId: 'remote-glm', harnessKind: 'glm', wakeMode: 'external_worker',
        adapterId: 'glm-heartbeat-v1', wake,
      }],
      appendReceipt,
      attemptId: () => 'wake-dynamic-binding',
    });

    await expect(dispatcher.dispatch([candidate], [automatic], [])).resolves.toMatchObject({
      selected: 1, succeeded: 1, failed: 0,
    });
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ binding_id: 'binding-created-by-project' }),
    }));
  });

  it('accepts a worker-agent-shaped reserved receipt that echoes task_id/reservation_id and rejects a missing echo', async () => {
    // 真实链路：supervisor.mjs spawn worker-agent → 适配器 → worker-agent 的
    // normalizeAdapterReceipt 重建 → 这里终校验。worker-agent 现在会透传（并先
    // 校验）reservation 回带，因此正常路径的回执带 task_id/reservation_id；
    // 若上游某层剥掉了回带字段，终校验必须明确拒绝（与所选规则一致：提供过
    // reservation 的候选必须原样回带，不因 wake_mode 放宽）。
    const reserved: ProjectAgentWakeCandidate = {
      ...candidate, binding_id: 'binding-visible',
      reservation_id: 'reservation_task-code-1_0000000000000001',
      reservation_expires_at: 1_900_000_000_000,
    };
    const echoReceipt = {
      protocol: 'biao.worker-wake/v1' as const, ok: true as const,
      adapter_id: 'custom-visible-v1', registration_id: 'registration_reserved_1',
      harness_kind: 'custom', wake_mode: 'visible_session' as const,
      task_id: reserved.task_id, reservation_id: reserved.reservation_id,
    };
    const noEchoReceipt = { ...echoReceipt, registration_id: 'registration_reserved_2' };
    delete noEchoReceipt.task_id;
    delete noEchoReceipt.reservation_id;

    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [{
        bindingId: 'binding-visible', agentId: 'visible-agent', harnessKind: 'custom',
        wakeMode: 'visible_session', adapterId: 'custom-visible-v1',
        wake: vi.fn()
          .mockResolvedValueOnce(echoReceipt)
          .mockResolvedValueOnce(noEchoReceipt),
      }],
      appendReceipt, attemptId: () => 'must-not-replace-reservation',
    });

    const accepted = await dispatcher.dispatch([reserved], [binding()], []);
    expect(accepted).toMatchObject({ selected: 1, succeeded: 1, failed: 0 });
    expect(appendReceipt).toHaveBeenLastCalledWith(project, expect.objectContaining({
      attempt_id: reserved.reservation_id, task_id: reserved.task_id,
      status: 'succeeded', adapter_id: 'custom-visible-v1',
    }));

    const rejected = await dispatcher.dispatch([{
      ...reserved, reservation_id: 'reservation_task-code-1_0000000000000002',
    }], [binding()], []);
    expect(rejected).toMatchObject({ selected: 1, succeeded: 0, failed: 1 });
    expect(appendReceipt).toHaveBeenLastCalledWith(project, expect.objectContaining({
      attempt_id: 'reservation_task-code-1_0000000000000002', status: 'failed', adapter_id: null,
    }));
  });

  it('fails closed on missing/unsafe adapter receipt and never invokes a background executor', async () => {    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const background = vi.fn();
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [{
        bindingId: 'binding-visible', agentId: 'visible-agent', harnessKind: 'custom',
        wakeMode: 'visible_session', adapterId: 'custom-visible-v1',
        wake: async () => ({
          protocol: 'biao.worker-wake/v1', ok: true,
          adapter_id: 'custom-visible-v1', registration_id: 'registration_visible_2',
          harness_kind: 'custom', wake_mode: 'visible_session',
          visible_url: 'https://sessions.example.test/view?token=secret',
        }),
      }],
      appendReceipt, fallbackExecute: background, attemptId: () => 'wake-attempt-failed',
    });

    const result = await dispatcher.dispatch([candidate], [binding()], []);
    expect(result).toMatchObject({ selected: 1, succeeded: 0, failed: 1 });
    expect(background).not.toHaveBeenCalled();
    expect(appendReceipt).toHaveBeenCalledWith(project, expect.objectContaining({
      attempt_id: 'wake-attempt-failed', adapter_id: null, status: 'failed',
    }));
    expect(JSON.stringify(appendReceipt.mock.calls)).not.toContain('secret');
  });

  it('builds a distinct real background CLI receipt after claim', () => {
    const backgroundBinding = binding({
      binding_id: 'binding-background', agent_id: 'cli-agent', harness_kind: 'cli',
      wake_mode: 'background_executor', policy: 'automatic',
    });
    expect(buildBackgroundExecutionReceipt(
      backgroundBinding, { task_id: 'task-background-1' }, 'registration_background_1',
      'builtin-cli-v1', { attemptId: () => 'background-attempt-1', now: () => 1_800_000_000_001 },
    )).toEqual({
      attempt_id: 'background-attempt-1', task_id: 'task-background-1',
      binding_id: 'binding-background', agent_id: 'cli-agent',
      registration_id: 'registration_background_1', harness_kind: 'cli',
      wake_mode: 'background_executor', adapter_id: 'builtin-cli-v1',
      status: 'succeeded', started_at: 1_800_000_000_001,
    });
  });

  it('uses the production snapshot path and a durable receipt as the restart fence', async () => {
    const storedReceipts: any[] = [];
    const calls: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      let data: any;
      if (url.pathname === '/plans') data = { plans: [{
        plan_id: 'plan-a', status: 'active', project_path: project, tasks: { pending: 1 }, reviews: {},
      }] };
      else if (url.pathname === '/intake') data = { items: [] };
      else if (url.pathname === '/events') data = [];
      else if (url.pathname === '/reconcile') data = {
        reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] },
      };
      else if (url.pathname === '/tasks') data = { tasks: [{
        task_id: candidate.task_id, plan_id: candidate.plan_id, project_path: project, type: 'code',
      }] };
      else if (url.pathname === '/project/agent-bindings') data = { bindings: [binding()] };
      else if (url.pathname === '/execution-receipts' && (init?.method ?? 'GET') === 'GET') {
        data = { receipts: storedReceipts };
      } else if (url.pathname === '/execution-receipts' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        storedReceipts.push({ ...body, project_scope: project });
        data = body;
      } else throw new Error(`unexpected ${url.pathname}`);
      return new Response(JSON.stringify({ ok: true, data }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const wake = vi.fn(async () => ({
      protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'custom-visible-v1',
      registration_id: 'registration_visible_runtime', harness_kind: 'custom',
      wake_mode: 'visible_session', session_ref: 'visible-runtime-session',
    }));
    const wakeSlot = {
      bindingId: 'binding-visible', agentId: 'visible-agent', harnessKind: 'custom',
      wakeMode: 'visible_session' as const, adapterId: 'custom-visible-v1', wake,
    };

    await new BiaoSupervisorRuntime({
      biaoUrl: 'http://127.0.0.1:7331', planIds: ['plan-a'], fetchImpl,
      projectAgentWakeSlots: [wakeSlot],
    }).runOnce();
    await new BiaoSupervisorRuntime({
      biaoUrl: 'http://127.0.0.1:7331', planIds: ['plan-a'], fetchImpl,
      projectAgentWakeSlots: [wakeSlot],
    }).runOnce();

    expect(wake).toHaveBeenCalledOnce();
    expect(storedReceipts).toHaveLength(1);
    expect(storedReceipts[0]).toMatchObject({
      task_id: candidate.task_id, binding_id: 'binding-visible', status: 'succeeded',
      wake_mode: 'visible_session', adapter_id: 'custom-visible-v1',
    });
    expect(calls).not.toContain('POST /register');
    expect(calls).not.toContain('POST /claim');
  });

  it('runtime gates dynamic project connections by slot identity without a preconfigured binding id', async () => {
    // 控制台“一键加入”创建的 binding 没有预填 binding_id；运行时的 reservation
    // 门控必须按 slot 身份（agent_id + harness_kind + wake_mode）识别它，否则
    // dispatcher 层的动态匹配永远收不到候选（真实链路在 2026-08-15 复现过）。
    const storedReceipts: any[] = [];
    const dynamicBinding = binding({
      binding_id: 'binding-created-by-project', agent_id: 'remote-glm',
      harness_kind: 'glm', wake_mode: 'external_worker', policy: 'automatic',
    });
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      let data: any;
      if (url.pathname === '/plans') data = { plans: [{
        plan_id: candidate.plan_id, status: 'active', project_path: project, tasks: { pending: 1 }, reviews: {},
      }] };
      else if (url.pathname === '/intake') data = { items: [] };
      else if (url.pathname === '/events') data = [];
      else if (url.pathname === '/reconcile') data = {
        reclaimed: [], failed: [], requeued: { waiting_file_release: [], waiting_dependency: [] },
      };
      else if (url.pathname === '/project/agent-bindings') data = { bindings: [dynamicBinding] };
      else if (url.pathname === '/execution-receipts' && (init?.method ?? 'GET') === 'GET') {
        data = { receipts: storedReceipts };
      } else if (url.pathname === '/execution-receipts' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        storedReceipts.push({ ...body, project_scope: project });
        data = body;
      } else if (url.pathname === '/project/agent-reservations' && init?.method === 'POST') {
        data = {
          reservation: {
            reservation_id: 'reservation-dynamic-1', ...candidate, capability: 'code',
            binding_id: 'binding-created-by-project', expires_at: 1_800_000_030_000,
          },
        };
      } else throw new Error(`unexpected ${url.pathname}`);
      return new Response(JSON.stringify({ ok: true, data }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const wake = vi.fn(async () => ({
      protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'glm-heartbeat-v1',
      registration_id: 'registration_glm_runtime', harness_kind: 'glm',
      wake_mode: 'external_worker',
      // 带 reservation 的候选要求回执原样回带 task_id/reservation_id
      task_id: candidate.task_id, reservation_id: 'reservation-dynamic-1',
    }));
    // slot 未预填 bindingId：这是被测场景
    const wakeSlot = {
      agentId: 'remote-glm', harnessKind: 'glm',
      wakeMode: 'external_worker' as const, adapterId: 'glm-heartbeat-v1', wake,
    };

    await new BiaoSupervisorRuntime({
      biaoUrl: 'http://127.0.0.1:7331', planIds: [candidate.plan_id], fetchImpl,
      projectAgentWakeSlots: [wakeSlot],
    }).runOnce();

    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ binding_id: 'binding-created-by-project' }),
    }));
    expect(storedReceipts).toHaveLength(1);
    expect(storedReceipts[0]).toMatchObject({
      task_id: candidate.task_id, binding_id: 'binding-created-by-project',
      wake_mode: 'external_worker', adapter_id: 'glm-heartbeat-v1',
    });
  });
});
