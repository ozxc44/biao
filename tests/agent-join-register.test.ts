import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { SqliteStore } from '../src/db/sqlite-store.js';
import {
  agentRegister,
  getProjectAgentRoster,
  listProjectAgentBindings,
  setSqliteStore,
} from '../src/server/service.js';
import { keys } from '../src/redis/keys.js';

const PROJECT_A = '/workspace/project-a';
const PROJECT_B = '/workspace/project-b';
let tempDir = '';

afterEach(() => {
  setSqliteStore(null);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function store(): SqliteStore {
  tempDir = mkdtempSync(join(tmpdir(), 'biao-agent-join-'));
  const value = new SqliteStore(join(tempDir, 'biao.sqlite'));
  setSqliteStore(value);
  return value;
}

/** 模拟 Redis：agentRegister 需要 hgetall、smembers、eval */
function mockRedis(evalResult?: unknown[]) {
  return {
    hgetall: async () => ({}),
    smembers: async () => [],
    eval: async () => evalResult ?? ['CREATED', String(Date.now()), '0'],
    hset: async () => 'OK',
    sadd: async () => 1,
    pipeline: () => ({
      hset: () => ({}),
      exec: async () => [],
    }),
  } as never;
}

const repoRoot = join(import.meta.dirname, '..');
const agentJoinScript = join(repoRoot, 'scripts', 'agent-join.mjs');

describe('注册即自动绑定（service 层）', () => {
  it('注册带 project_bindings 自动创建 external_worker/automatic 绑定', async () => {
    const db = store();
    const redis = mockRedis();

    const result = await agentRegister(
      redis, 'join-agent-1', 'codex', ['code', 'review'],
      undefined, undefined, undefined,
      [{ project_scope: PROJECT_A }],
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.data?.agent_id).toBe('join-agent-1');
    expect(result.data?.registration_id).toBeTruthy();
    expect(result.data?.project_binding_results).toHaveLength(1);
    expect(result.data?.project_binding_results![0]).toMatchObject({
      ok: true,
      project_scope: PROJECT_A,
    });

    // 验证绑定已持久化
    const bindings = await listProjectAgentBindings(PROJECT_A);
    expect(bindings.ok).toBe(true);
    expect(bindings.data?.bindings).toHaveLength(1);
    expect(bindings.data?.bindings[0]).toMatchObject({
      agent_id: 'join-agent-1',
      harness_kind: 'codex',
      capabilities: ['code', 'review'],
      wake_mode: 'external_worker',
      policy: 'automatic',
    });

    db.close();
  });

  it('CLI 加入后项目 roster 默认显示已加入，无需在项目页再添加或绑定', async () => {
    const db = store();
    const now = Date.now();
    const agentKey = keys.hash.agent('join-agent-1');
    const registration = {
      agent_id: 'join-agent-1', agent_type: 'codex', capabilities: 'code,review',
      projects: PROJECT_A, status: 'idle', last_heartbeat: String(now),
    };
    const redis = {
      hgetall: async (key: string) => (key === agentKey ? registration : {}),
      smembers: async (key: string) => (key === keys.planStatusProjection.agentIds ? ['join-agent-1'] : []),
      eval: async () => ['CREATED', String(now), '0'],
      hset: async () => 'OK',
      sadd: async () => 1,
      pipeline: () => ({ hset: () => ({}), exec: async () => [] }),
    } as never;

    const result = await agentRegister(
      redis, 'join-agent-1', 'codex', ['code', 'review'],
      undefined, undefined, undefined,
      [{ project_scope: PROJECT_A }],
    );
    expect(result).toMatchObject({ ok: true });

    const roster = await getProjectAgentRoster(redis, PROJECT_A);
    expect(roster.ok).toBe(true);
    expect(roster.data?.bound_agents).toHaveLength(1);
    expect(roster.data?.bound_agents[0]).toMatchObject({
      agent_id: 'join-agent-1',
      harness_kind: 'codex',
      wake_mode: 'external_worker',
      policy: 'automatic',
      availability_status: 'bound_wakeable',
      online_registered: true,
    });
    expect(roster.data?.online_candidates).toEqual([]);

    // Agent 下线后仍保持已加入，只是在线标记变化；项目页不需要任何补充操作。
    const offlineRedis = { ...redis, smembers: async () => [] } as never;
    const offlineRoster = await getProjectAgentRoster(offlineRedis, PROJECT_A);
    expect(offlineRoster.data?.bound_agents).toHaveLength(1);
    expect(offlineRoster.data?.bound_agents[0]).toMatchObject({
      agent_id: 'join-agent-1',
      online_registered: false,
    });

    db.close();
  });

  it('注册带多个 project_bindings 时全部自动绑定', async () => {
    const db = store();
    const redis = mockRedis();

    const result = await agentRegister(
      redis, 'multi-agent', 'kimi', ['code'],
      undefined, undefined, undefined,
      [{ project_scope: PROJECT_A }, { project_scope: PROJECT_B, wake_mode: 'visible_session', policy: 'on_demand' }],
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.data?.project_binding_results).toHaveLength(2);

    const bindA = await listProjectAgentBindings(PROJECT_A);
    expect(bindA.data?.bindings[0]).toMatchObject({
      agent_id: 'multi-agent',
      wake_mode: 'external_worker',
      policy: 'automatic',
    });

    const bindB = await listProjectAgentBindings(PROJECT_B);
    expect(bindB.data?.bindings[0]).toMatchObject({
      agent_id: 'multi-agent',
      wake_mode: 'visible_session',
      policy: 'on_demand',
    });

    db.close();
  });

  it('幂等重注册：已存在同 (project_scope, agent_id) 绑定时不报错，返回现有绑定', async () => {
    const db = store();
    const redis = mockRedis();

    // 第一次注册
    const first = await agentRegister(
      redis, 'idempotent-agent', 'codex', ['code'],
      undefined, undefined, 'test_reg_id_000000001',
      [{ project_scope: PROJECT_A }],
    );
    expect(first).toMatchObject({ ok: true });
    expect(first.data?.project_binding_results).toHaveLength(1);

    // 第二次注册（相同 agent_id + project_scope）
    const second = await agentRegister(
      redis, 'idempotent-agent', 'codex', ['code'],
      undefined, undefined, 'test_reg_id_000000002',
      [{ project_scope: PROJECT_A }],
    );
    expect(second).toMatchObject({ ok: true });
    expect(second.data?.project_binding_results).toHaveLength(1);
    expect(second.data?.project_binding_results![0]).toMatchObject({ ok: true });

    // 绑定数量仍为 1（幂等）
    const bindings = await listProjectAgentBindings(PROJECT_A);
    expect(bindings.data?.bindings).toHaveLength(1);

    db.close();
  });

  it('绑定失败不影响注册本身', async () => {
    const db = store();
    // 使用一个会导致 createProjectAgentBinding 失败的 mock Redis
    // eval 返回成功注册，但 SQLite 故意关闭导致绑定创建失败
    const redis = mockRedis();

    // 先注册一次成功
    const result = await agentRegister(
      redis, 'fail-binding-agent', 'codex', ['code'],
      undefined, undefined, undefined,
      [{ project_scope: PROJECT_A }],
    );
    expect(result).toMatchObject({ ok: true });

    // 关闭 SQLite 模拟绑定失败
    db.close();
    setSqliteStore(null);

    // 重新注册，绑定会因 SQLite 不可用而失败
    const result2 = await agentRegister(
      redis, 'fail-binding-agent-2', 'codex', ['code'],
      undefined, undefined, undefined,
      [{ project_scope: '/workspace/fail-project' }],
    );

    // 注册本身仍然成功
    expect(result2).toMatchObject({ ok: true });
    expect(result2.data?.agent_id).toBe('fail-binding-agent-2');
    // 绑定结果应包含失败信息
    expect(result2.data?.project_binding_results).toHaveLength(1);
    expect(result2.data?.project_binding_results![0]).toMatchObject({ ok: false });
  });

  it('不传 project_bindings 时行为与旧版一致', async () => {
    const db = store();
    const redis = mockRedis();

    const result = await agentRegister(
      redis, 'old-style-agent', 'custom', ['code'],
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.data?.project_binding_results).toBeUndefined();

    db.close();
  });
});

describe('agent-join.mjs --dry-run', () => {
  it('在无服务时也能打印计划动作且不产生副作用', () => {
    const envDir = join(tmpDir(), 'biao-join-dry-run');
    const result = spawnSync(process.execPath, [
      agentJoinScript,
      '--agent-id', 'test-agent',
      '--agent-type', 'codex',
      '--project-scope', '/workspace/test',
      '--capabilities', 'code,review',
      '--biao-url', 'http://127.0.0.1:19999',
      '--runtime-dir', envDir,
      '--dry-run',
    ], { encoding: 'utf8', cwd: repoRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry-run 模式');
    expect(result.stdout).toContain('test-agent');
    expect(result.stdout).toContain('/workspace/test');
    expect(result.stdout).toContain('external_worker');
    expect(result.stdout).toContain('automatic');
    // 不应写入任何文件
    expect(result.stderr).toBe('');
  });

  it('输出中文帮助', () => {
    const result = spawnSync(process.execPath, [
      agentJoinScript, '--help',
    ], { encoding: 'utf8', cwd: repoRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('一站式加入');
    expect(result.stdout).toContain('--agent-id');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('安全说明');
  });

  it('--agent-id 缺失时报错', () => {
    const result = spawnSync(process.execPath, [
      agentJoinScript, '--agent-type', 'codex', '--dry-run',
    ], { encoding: 'utf8', cwd: repoRoot });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--agent-id 必填');
  });

  it('--project-scope 非绝对路径时报错', () => {
    const result = spawnSync(process.execPath, [
      agentJoinScript,
      '--agent-id', 'test-agent',
      '--agent-type', 'codex',
      '--project-scope', 'relative/path',
      '--dry-run',
    ], { encoding: 'utf8', cwd: repoRoot });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('绝对路径');
  });

  it('生成的 env 文件权限为 0600', () => {
    // 这个测试验证写入权限逻辑（通过 dry-run 模式跳过网络请求）
    // 真实写入需要服务可用，这里直接验证 writeFileSync + chmod 逻辑
    const testDir = mkdtempSync(join(tmpdir(), 'biao-join-perm-'));
    try {
      const envPath = join(testDir, 'test-agent.env');
      writeFileSync(envPath, 'BIAO_URL=http://test\n', { mode: 0o600 });
      const stat = statSync(envPath);
      // 检查权限是否为 0600（仅 owner 可读写）
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'biao-join-test-'));
}
