import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWakePayload,
  normalizeAdapterReceipt,
} from '../scripts/worker-agent.mjs';
import {
  normalizeProjectAgentAdapterReceipt,
  type ProjectAgentAdapterReceipt,
  type ProjectAgentWakeCandidate,
} from '../src/worker/supervisor.js';
import type { ProjectAgentBinding } from '../src/types/index.js';

const repoRoot = join(import.meta.dirname, '..');
const workerAgent = join(repoRoot, 'scripts', 'worker-agent.mjs');
const dirs: string[] = [];

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function adapter(source: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-'));
  dirs.push(dir);
  const path = join(dir, 'external-harness.mjs');
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { dir, path };
}

const PROJECT = '/workspace/any-project';

function baseArgs(path: string, dir: string): string[] {
  return [
    workerAgent, '--once', '--require-receipt', '--slot', 'external-slot-1',
    '--kind', 'custom', '--plans', 'plan-a', '--command', path,
    '--binding-id', 'binding-external', '--agent-id', 'external-agent',
    '--harness-kind', 'custom', '--wake-mode', 'external_worker',
    '--adapter-id', 'external-stub-v1', '--project', PROJECT,
    '--capability', 'code', '--lock-dir', join(dir, 'locks'),
  ];
}

function run(path: string, dir: string, extra: string[] = []) {
  return spawnSync(process.execPath, [...baseArgs(path, dir), ...extra], {
    cwd: repoRoot, encoding: 'utf8', env: {
      ...process.env,
      BIAO_API_TOKEN: 'owner-secret', BIAO_CLAIM_TOKEN: 'claim-secret',
      BIAO_WORKER_AGENT_CMD: 'must-not-leak-command', BIAO_PM_TARGET: 'must-not-leak-target',
    },
  });
}

const binding: ProjectAgentBinding = {
  binding_id: 'binding-external', project_scope: PROJECT, agent_id: 'external-agent',
  label: 'External Agent', harness_kind: 'custom', capabilities: ['code'],
  wake_mode: 'external_worker', policy: 'automatic', created_at: 1, updated_at: 1,
};

const slot = {
  agentId: 'external-agent', harnessKind: 'custom',
  wakeMode: 'external_worker' as const, adapterId: 'external-stub-v1',
  wake: async () => undefined,
};

/** 逐层复刻真实链路的两层校验：worker-agent 重建 → supervisor 终校验。 */
function throughBothLayers(raw: unknown, candidate?: ProjectAgentWakeCandidate) {
  const workerOptions = {
    projectAgent: {
      bindingId: 'binding-external', agentId: 'external-agent', harnessKind: 'custom',
      wakeMode: 'external_worker', adapterId: 'external-stub-v1', project: PROJECT,
      capability: 'code',
      ...(candidate?.reservation_id ? {
        reservation: {
          reservationId: candidate.reservation_id,
          taskId: candidate.task_id,
          expiresAt: candidate.reservation_expires_at ?? 0,
        },
      } : {}),
    },
  };
  const first = normalizeAdapterReceipt(raw, workerOptions);
  return { first, second: first === undefined ? undefined : normalizeProjectAgentAdapterReceipt(first, binding, slot, candidate) };
}

describe('binding-aware biao.worker-wake/v1', () => {
  it('runs an isolated external harness with a credential-free wake and returns its receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-real-'));
    dirs.push(dir);
    const path = join(repoRoot, 'src', 'worker', 'harness', 'external-stub.mjs');
    const result = run(path, dir);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt).toMatchObject({
      protocol: 'biao.worker-wake/v1', adapter_id: 'external-stub-v1',
      registration_id: expect.stringMatching(/^external-/), harness_kind: 'custom',
      wake_mode: 'external_worker', session_ref: 'external-stub-session',
    });
    // (a) 无 reservation 的回执通过双层校验
    const layers = throughBothLayers(receipt);
    expect(layers.first).toBeDefined();
    expect(layers.second).toMatchObject({ ok: true, adapter_id: 'external-stub-v1' });
    expect(result.stdout).not.toContain('owner-secret');
  });

  it('produces a succeeded receipt with echoed task_id/reservation_id for a reserved wake', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-reserved-'));
    dirs.push(dir);
    const path = join(repoRoot, 'src', 'worker', 'harness', 'external-stub.mjs');
    const result = run(path, dir, [
      '--reservation-id', 'reservation_task-r-1_0000000000000001',
      '--task-id', 'task-r-1',
      '--reservation-expires-at', '1900000000000',
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.trim());
    // (b) 带 reservation 的候选产出含 task_id/reservation_id 的 succeeded 回执
    expect(receipt).toMatchObject({
      protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'external-stub-v1',
      harness_kind: 'custom', wake_mode: 'external_worker',
      task_id: 'task-r-1', reservation_id: 'reservation_task-r-1_0000000000000001',
    });
    const candidate: ProjectAgentWakeCandidate = {
      task_id: 'task-r-1', plan_id: 'plan-a', project_path: PROJECT, capability: 'code',
      binding_id: 'binding-external',
      reservation_id: 'reservation_task-r-1_0000000000000001',
      reservation_expires_at: 1_900_000_000_000,
    };
    const layers = throughBothLayers(receipt, candidate);
    expect(layers.first).toMatchObject({ task_id: 'task-r-1', reservation_id: 'reservation_task-r-1_0000000000000001' });
    expect(layers.second).toMatchObject({ ok: true, task_id: 'task-r-1', reservation_id: 'reservation_task-r-1_0000000000000001' });
  });

  it('sends a snake_case binding payload without any credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-payload-'));
    dirs.push(dir);
    const capture = join(dir, 'payload.json');
    const { path } = adapter(`
import { readFileSync, writeFileSync } from 'node:fs';
const payload = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(capture)}, payload);
console.log(JSON.stringify({
  protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'external-stub-v1',
  registration_id: 'external-capture-1', harness_kind: 'custom', wake_mode: 'external_worker',
}));
`);
    const result = run(path, dir);
    expect(result.status).toBe(0);
    const payload = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(capture, 'utf8')));
    // (c) 载荷字段命名与凭据断言
    expect(payload).toMatchObject({
      protocol: 'biao.worker-wake/v1',
      binding: {
        binding_id: 'binding-external', agent_id: 'external-agent', harness_kind: 'custom',
        wake_mode: 'external_worker', adapter_id: 'external-stub-v1',
      },
      selector: { project: PROJECT, capability: 'code', planIds: ['plan-a'] },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/owner-secret|claim-secret|must-not-leak|claimToken|claim_token|authorization|bearer|token|password|secret/i);
    expect(Object.keys(payload.binding)).toEqual(['binding_id', 'agent_id', 'harness_kind', 'wake_mode', 'adapter_id']);
  });

  it('rejects a reserved receipt that echoes the wrong reservation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-mismatch-'));
    dirs.push(dir);
    const { path } = adapter(`
import { readFileSync } from 'node:fs';
const wake = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({
  protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'external-stub-v1',
  registration_id: 'external-mismatch-1', harness_kind: 'custom', wake_mode: 'external_worker',
  task_id: 'task-other', reservation_id: wake.reservation.reservation_id,
}));
`);
    const result = run(path, dir, [
      '--reservation-id', 'reservation_task-r-2_0000000000000002',
      '--task-id', 'task-r-2',
      '--reservation-expires-at', '1900000000000',
    ]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('回执');
  });

  it('rejects a reserved receipt that omits the echo entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-noecho-'));
    dirs.push(dir);
    const { path } = adapter(`
console.log(JSON.stringify({
  protocol: 'biao.worker-wake/v1', ok: true, adapter_id: 'external-stub-v1',
  registration_id: 'external-noecho-1', harness_kind: 'custom', wake_mode: 'external_worker',
}));
`);
    const result = run(path, dir, [
      '--reservation-id', 'reservation_task-r-3_0000000000000003',
      '--task-id', 'task-r-3',
      '--reservation-expires-at', '1900000000000',
    ]);
    expect(result.status).toBe(4);
  });

  it('rejects partial reservation argv as a config error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-binding-wake-partial-'));
    dirs.push(dir);
    const { path } = adapter('process.exit(0);');
    const result = run(path, dir, ['--reservation-id', 'reservation_x_1']);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('必须同时提供');
  });

  it('fails when an adapter exits zero without a receipt', () => {
    const { dir, path } = adapter(`process.stdin.resume();`);
    const result = run(path, dir);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('回执');
  });

  it('buildWakePayload emits snake_case binding and reservation blocks', () => {
    expect(buildWakePayload({
      biaoUrl: 'http://127.0.0.1:7331', slotId: 's1', kind: 'custom', model: '',
      planIds: ['plan-a'], command: '/bin/true', runtimeDir: '', lockDir: '/tmp',
      requireReceipt: true,
      projectAgent: {
        bindingId: 'b1', agentId: 'a1', harnessKind: 'glm', wakeMode: 'external_worker',
        adapterId: 'ad1', project: '/workspace/p', capability: 'code',
        reservation: { reservationId: 'reservation_t1_1', taskId: 't1', expiresAt: 1_900_000_000_000 },
      },
    })).toEqual({
      protocol: 'biao.worker-wake/v1',
      biaoUrl: 'http://127.0.0.1:7331',
      slotId: 's1',
      binding: {
        binding_id: 'b1', agent_id: 'a1', harness_kind: 'glm',
        wake_mode: 'external_worker', adapter_id: 'ad1',
      },
      selector: { kind: 'custom', model: '', planIds: ['plan-a'], project: '/workspace/p', capability: 'code' },
      reservation: { reservation_id: 'reservation_t1_1', task_id: 't1', expires_at: 1_900_000_000_000 },
    });
  });
});
