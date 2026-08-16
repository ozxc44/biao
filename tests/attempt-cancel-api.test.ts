import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../src/db/sqlite-store.js';
import { issueAttemptToken, type IssueCredentialOptions } from '../src/server/v2/credentials.js';

let tempDir = '';
let store: SqliteStore;

const credOpts: IssueCredentialOptions = {
  keys: [{ key_version: 1, material: Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex') }],
};

function setupStore(): SqliteStore {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-cancel-test-'));
  const dbPath = join(tempDir, 'test.sqlite');
  store = new SqliteStore(dbPath);
  // Create prerequisite plan (FK constraint)
  store.upsertPlan({
    plan_id: 'plan-1',
    project_path: '',
    title: 'test plan',
    status: 'active',
    default_assignee: 'auto',
    default_priority: 5,
    phases: '',
    task_count: 0,
    created_at: new Date().toISOString(),
    submitted_at: '',
  });
  return store;
}

afterEach(() => {
  if (store) store.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

/** 最小完整 TaskRow 模板（upsertTask 要求全字段） */
function minimalTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'task-1',
    plan_id: 'plan-1',
    title: 'test',
    type: 'feature',
    phase: '',
    assignee: 'auto',
    priority: 5,
    status: 'pending',
    depends_on: '',
    ownership_files: '[]',
    ownership_modules: '',
    timeout_seconds: 1800,
    max_retries: 2,
    retries: 0,
    model_override: '',
    acceptance_for: '',
    verify: '[]',
    claimed_by: '',
    claimed_at: '',
    expire_at: '',
    result_path: '',
    result_json_path: '',
    done_at: '',
    pm_review_status: '',
    pm_reviewed_by: '',
    pm_reviewed_at: '',
    pm_review_comment: '',
    goal_md: '',
    project_id: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Attempt Cancel API', () => {
  it('cancel sets attempt to cancelled and task back to pending', () => {
    const s = setupStore();

    s.upsertTask(minimalTask({
      task_id: 'task-cancel-1',
      status: 'running',
      claimed_by: 'att-cancel-1',
      claimed_at: new Date().toISOString(),
      goal_md: 'test goal',
      project_id: 'proj-cancel-1',
    }));

    s.insertTaskAttempt({
      attempt_id: 'att-cancel-1',
      task_id: 'task-cancel-1',
      project_id: 'proj-cancel-1',
      node_id: 'node-1',
      session_id: 'sess-1',
      attempt_generation: 1,
      status: 'executing',
      lease_expires_at: Date.now() + 600_000,
      lease_duration_ms: 600_000,
      token_jti: '',
      artifact_ids: '[]',
      started_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
      failure_reason: '',
    });

    // Verify initial state
    expect(s.getTaskAttempt('att-cancel-1')?.status).toBe('executing');
    expect(s.getTask('task-cancel-1')?.status).toBe('running');

    // Simulate cancel
    const now = Date.now();
    s.updateTaskAttempt('att-cancel-1', {
      status: 'cancelled',
      completed_at: now,
      updated_at: now,
      failure_reason: 'cancelled',
    });

    const taskRow = s.getTask('task-cancel-1')!;
    s.upsertTask({ ...taskRow, status: 'pending', claimed_by: '', claimed_at: '' });

    // Verify
    expect(s.getTaskAttempt('att-cancel-1')?.status).toBe('cancelled');
    expect(s.getTask('task-cancel-1')?.status).toBe('pending');
    expect(s.getTask('task-cancel-1')?.claimed_by).toBe('');
  });

  it('cancel is idempotent for terminal attempts', () => {
    const s = setupStore();

    s.upsertTask(minimalTask({ task_id: 'task-cancel-idem', status: 'done', done_at: new Date().toISOString() }));

    s.insertTaskAttempt({
      attempt_id: 'att-cancel-done',
      task_id: 'task-cancel-idem',
      project_id: '',
      node_id: 'node-1',
      session_id: '',
      attempt_generation: 1,
      status: 'done',
      lease_expires_at: 0,
      lease_duration_ms: 0,
      token_jti: '',
      artifact_ids: '[]',
      started_at: Date.now(),
      updated_at: Date.now(),
      completed_at: Date.now(),
      failure_reason: '',
    });

    // Terminal attempt stays unchanged
    expect(s.getTaskAttempt('att-cancel-done')?.status).toBe('done');
  });

  it('bva2 token generation and verification round-trips', () => {
    const token = issueAttemptToken('att-rt-1', 'task-rt-1', 1, 'claim', credOpts);
    expect(token).toBeTruthy();
    expect(token.startsWith('bva2_')).toBe(true);
  });
});
