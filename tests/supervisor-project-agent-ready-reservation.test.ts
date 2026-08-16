import { describe, expect, it, vi } from 'vitest';
import {
  ProjectAgentWakeDispatcher,
  type ProjectAgentWakeCandidate,
} from '../src/worker/supervisor.js';
import type { ProjectAgentBinding } from '../src/types/index.js';

const project = '/workspace/project-ready';

function binding(bindingId: string, wakeMode: 'visible_session' | 'external_worker'): ProjectAgentBinding {
  return {
    binding_id: bindingId,
    project_scope: project,
    agent_id: `${bindingId}-agent`,
    label: bindingId,
    harness_kind: 'custom',
    capabilities: ['code'],
    wake_mode: wakeMode,
    policy: 'automatic',
    created_at: 1,
    updated_at: 1,
  };
}

function reservedCandidate(taskId: string, bindingId: string): ProjectAgentWakeCandidate {
  return {
    task_id: taskId,
    plan_id: 'plan-ready',
    project_path: project,
    capability: 'code',
    binding_id: bindingId,
    reservation_id: `reservation_${taskId}_0000000000000000`,
    reservation_expires_at: 1_900_000_000_000,
  };
}

describe('Project Agent ready reservation wake', () => {
  it('carries only the exact short-lived reservation and requires it back in the adapter receipt', async () => {
    const selected = binding('binding-visible', 'visible_session');
    const candidate = reservedCandidate('task-ready', selected.binding_id);
    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const wake = vi.fn(async (request: any) => ({
      protocol: 'biao.worker-wake/v1',
      ok: true,
      adapter_id: 'visible-v2',
      registration_id: 'registration_visible_00000001',
      harness_kind: 'custom',
      wake_mode: 'visible_session',
      task_id: request.reservation.task_id,
      reservation_id: request.reservation.reservation_id,
    }));
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [{
        bindingId: selected.binding_id,
        agentId: selected.agent_id,
        harnessKind: selected.harness_kind,
        wakeMode: selected.wake_mode,
        adapterId: 'visible-v2',
        wake,
      }],
      appendReceipt,
      attemptId: () => 'must-not-replace-reservation',
    });

    const result = await dispatcher.dispatch([candidate], [selected], []);

    expect(result).toMatchObject({ selected: 1, succeeded: 1, failed: 0 });
    const request = wake.mock.calls[0]![0];
    expect(request).toMatchObject({
      reservation: {
        reservation_id: candidate.reservation_id,
        task_id: candidate.task_id,
        expires_at: candidate.reservation_expires_at,
      },
    });
    expect(JSON.stringify(request)).not.toMatch(/bearer|claim_token|authorization/i);
    expect(appendReceipt).toHaveBeenCalledWith(project, expect.objectContaining({
      attempt_id: candidate.reservation_id,
      task_id: candidate.task_id,
      status: 'succeeded',
    }));
  });

  it('fails a mismatched adapter receipt and continues an unrelated external lane', async () => {
    const firstBinding = binding('binding-visible', 'visible_session');
    const secondBinding = binding('binding-external', 'external_worker');
    const first = reservedCandidate('task-first', firstBinding.binding_id);
    const second = reservedCandidate('task-second', secondBinding.binding_id);
    const appendReceipt = vi.fn(async () => ({ ok: true }));
    const dispatcher = new ProjectAgentWakeDispatcher({
      slots: [
        {
          bindingId: firstBinding.binding_id,
          agentId: firstBinding.agent_id,
          harnessKind: firstBinding.harness_kind,
          wakeMode: firstBinding.wake_mode,
          adapterId: 'visible-v2',
          wake: async () => ({
            protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'visible-v2',
            registration_id: 'registration_visible_00000002', harness_kind: 'custom',
            wake_mode: 'visible_session', task_id: second.task_id,
            reservation_id: first.reservation_id,
          }),
        },
        {
          bindingId: secondBinding.binding_id,
          agentId: secondBinding.agent_id,
          harnessKind: secondBinding.harness_kind,
          wakeMode: secondBinding.wake_mode,
          adapterId: 'external-v2',
          wake: async () => ({
            protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'external-v2',
            registration_id: 'registration_external_0000001', harness_kind: 'custom',
            wake_mode: 'external_worker', task_id: second.task_id,
            reservation_id: second.reservation_id,
          }),
        },
      ],
      appendReceipt,
    });

    const result = await dispatcher.dispatch([first, second], [firstBinding, secondBinding], []);

    expect(result).toMatchObject({ selected: 2, succeeded: 1, failed: 1 });
    expect(appendReceipt.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ task_id: first.task_id, status: 'failed' }),
      expect.objectContaining({ task_id: second.task_id, status: 'succeeded' }),
    ]);
  });
});
