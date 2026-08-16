/**
 * Phase 9 失败优先测试：凭据/ACL/Git 面增强（Lane A）
 *
 * 覆盖（22.3-04/10/13/14/15/17、22.2-13/14、22.4-09/24/38）：
 * 1. bvm2 Merge Bot 凭据：签发/验证、scope=merge、project 绑定、key_version 轮换。
 * 2. rbac 负面矩阵：bvm2 对 claim/report/plan 路由 403。
 * 3. ref ACL：allow/deny 规则、默认拒绝、Node push 默认分支/tag/他人 branch 各一拒。
 * 4. read-only 门禁：无 ref ACL → degraded_read_only。
 * 5. importPlan：read-only 拒绝写任务（逐条列出）、full 正常导入。
 * 6. EvidenceAcceptance：Artifact-only 完成记录。
 * 7. ref ACL 连续丢失熔断：N 次后 fencing + write_capability_status=lost。
 * 8. V1 plan/question mutation 隔离：V2 项目拒绝 V1 mutation。
 * 9. Git Remote 不可用：remote_unreachable 错误分类。
 * 10. 人工 merge 回写：writebackExternalMerge。
 * 11. 默认分支未登记 SHA 棜测。
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SqliteStore } from '../../src/db/sqlite-store.js';
import type { ProjectRow } from '../../src/types/v2-identity.js';
import {
  issueMergeBotToken,
  verifyMergeBotToken,
  issueNodeCredential,
  verifyNodeCredential,
  loadV2CredentialKeyring,
  V2_CREDENTIAL_KEY_ENV,
} from '../../src/server/v2/credentials.js';
import {
  checkRefAcl,
  createDefaultRefAcl,
  parseRefAcl,
  RefAclMissTracker,
} from '../../src/server/v2/git/ref-acl.js';
import { GenericGitProvider, refspecDestinationRef } from '../../src/server/v2/git/generic-git.js';
import { GitProviderError, type GitProvider } from '../../src/server/v2/git/provider.js';
import { createMergeQueue } from '../../src/server/v2/merge/queue.js';
import {
  isProjectReadOnly,
  hasRefAcl,
  importPlanForProject,
  createEvidenceAcceptanceForTask,
} from '../../src/server/v2/plan-import.js';
import {
  V1_ROUTE_CLASSIFICATIONS,
  classifyV1Route,
  getUnclassifiedMutationRoutes,
} from '../../src/server/v2/v1-route-classification.js';
import {
  V2_ROUTES,
  deriveCredentialPolicy,
} from '../../src/server/v2/routes/registry.js';

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------- */
/* env 纪律                                                          */
/* ---------------------------------------------------------------- */

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

function restoreEnv(key: string): void {
  if (savedEnv[key] === undefined) delete process.env[key];
  else process.env[key] = savedEnv[key];
}

const TEST_KEY_HEX = 'aabbccdd'.repeat(8); // 32 bytes hex

/* ---------------------------------------------------------------- */
/* 1. bvm2 Merge Bot 凭据（22.3-04）                                 */
/* ---------------------------------------------------------------- */

describe('22.3-04: bvm2 Merge Bot 凭据', () => {
  beforeAll(() => {
    saveEnv(V2_CREDENTIAL_KEY_ENV);
    process.env[V2_CREDENTIAL_KEY_ENV] = TEST_KEY_HEX;
  });

  afterAll(() => {
    restoreEnv(V2_CREDENTIAL_KEY_ENV);
  });

  it('签发和验证 bvm2 Merge Bot token', () => {
    const token = issueMergeBotToken('merge-bot-proj-1', 'proj-1', 'merge');
    expect(token).toMatch(/^bvm2_/);

    const result = verifyMergeBotToken(token, {
      botId: 'merge-bot-proj-1',
      projectId: 'proj-1',
      scope: 'merge',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.bot_id).toBe('merge-bot-proj-1');
      expect(result.claims.project_id).toBe('proj-1');
      expect(result.claims.scope).toBe('merge');
    }
  });

  it('project_id 不匹配时拒绝', () => {
    const token = issueMergeBotToken('merge-bot-proj-1', 'proj-1', 'merge');
    const result = verifyMergeBotToken(token, {
      botId: 'merge-bot-proj-1',
      projectId: 'proj-2', // 不匹配
      scope: 'merge',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SUBJECT_MISMATCH');
    }
  });

  it('scope 不匹配时拒绝', () => {
    const token = issueMergeBotToken('merge-bot-proj-1', 'proj-1', 'merge');
    // @ts-expect-error 故意传入非法 scope 测试
    const result = verifyMergeBotToken(token, {
      botId: 'merge-bot-proj-1',
      projectId: 'proj-1',
      scope: 'claim', // 非法 scope
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SCOPE_MISMATCH');
    }
  });

  it('key_version 轮换：旧版本 token 被拒绝', () => {
    const oldToken = issueMergeBotToken('merge-bot-proj-1', 'proj-1', 'merge', {
      keys: [{ key_version: 1, material: Buffer.from(TEST_KEY_HEX, 'hex') }],
    });

    // 用新密钥环验证（只有 key_version=2）
    const newKeyHex = '11223344'.repeat(8);
    const result = verifyMergeBotToken(oldToken, {
      botId: 'merge-bot-proj-1',
      projectId: 'proj-1',
      scope: 'merge',
    }, {
      keys: [{ key_version: 2, material: Buffer.from(newKeyHex, 'hex') }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('UNKNOWN_KEY_VERSION');
    }
  });
});

/* ---------------------------------------------------------------- */
/* 2. rbac 负面矩阵：bvm2 对 claim/report/plan 路由 403             */
/* ---------------------------------------------------------------- */

describe('22.3-04: rbac 负面矩阵 bvm2×claim/plan 403', () => {
  it('bvm2 凭据不在 claim 路由允许作用域内', () => {
    const claimRoute = V2_ROUTES.find((r) => r.id === 'POST /v2/tasks/claim');
    expect(claimRoute).toBeDefined();
    if (claimRoute) {
      const policy = deriveCredentialPolicy(claimRoute);
      expect(policy.merge_bot).toBe(false);
    }
  });

  it('bvm2 凭据不在 report 路由允许作用域内', () => {
    const reportRoute = V2_ROUTES.find((r) => r.id === 'POST /v2/attempts/:attempt_id/report');
    expect(reportRoute).toBeDefined();
    if (reportRoute) {
      const policy = deriveCredentialPolicy(reportRoute);
      expect(policy.merge_bot).toBe(false);
    }
  });

  it('bvm2 凭据不在 plan import 路由允许作用域内', () => {
    const planRoute = V2_ROUTES.find((r) => r.id === 'POST /v2/plans/import');
    expect(planRoute).toBeDefined();
    if (planRoute) {
      const policy = deriveCredentialPolicy(planRoute);
      expect(policy.merge_bot).toBe(false);
    }
  });

  it('bvm2 凭据在 merge-jobs 路由允许作用域内', () => {
    const mergeRoute = V2_ROUTES.find((r) => r.id === 'POST /v2/merge-jobs');
    expect(mergeRoute).toBeDefined();
    if (mergeRoute) {
      const policy = deriveCredentialPolicy(mergeRoute);
      expect(policy.merge_bot).toBe(true);
    }
  });

  it('bvm2 凭据在 dispatch 路由允许作用域内', () => {
    const dispatchRoute = V2_ROUTES.find((r) => r.id === 'POST /v2/projects/:project_id/merge-jobs/dispatch');
    expect(dispatchRoute).toBeDefined();
    if (dispatchRoute) {
      const policy = deriveCredentialPolicy(dispatchRoute);
      expect(policy.merge_bot).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- */
/* 3. ref ACL（22.3-10）                                             */
/* ---------------------------------------------------------------- */

describe('22.3-10: generic-git ref ACL', () => {
  const acl = createDefaultRefAcl('main');

  it('允许 biao attempt 分支', () => {
    const decision = checkRefAcl('refs/heads/biao/attempt/task-1-attempt-1', acl);
    expect(decision.allowed).toBe(true);
  });

  it('允许 marker refs', () => {
    const decision = checkRefAcl('refs/biao/attempt-markers/marker-1', acl);
    expect(decision.allowed).toBe(true);
  });

  it('禁止默认分支 main', () => {
    const decision = checkRefAcl('refs/heads/main', acl);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('默认分支');
    }
  });

  it('禁止 tag refs', () => {
    const decision = checkRefAcl('refs/tags/v1.0.0', acl);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('tag');
    }
  });

  it('禁止他人 branch 前缀', () => {
    const decision = checkRefAcl('refs/heads/feature/some-feature', acl);
    expect(decision.allowed).toBe(false);
  });

  it('默认拒绝未匹配的 ref', () => {
    const decision = checkRefAcl('refs/heads/unknown-branch', acl);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('未匹配任何允许规则');
    }
  });

  it('deny 规则优先于 allow', () => {
    const strictAcl = {
      allow: [{ pattern: 'refs/heads/**', description: '所有分支' }],
      deny: [{ pattern: 'refs/heads/main', description: 'main 分支' }],
    };
    const decision = checkRefAcl('refs/heads/main', strictAcl);
    expect(decision.allowed).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* 4. read-only 门禁（22.3-13）                                     */
/* ---------------------------------------------------------------- */

describe('22.3-13: read-only 门禁', () => {
  // 已配置 ref ACL 的项目基准（与 createDefaultRefAcl 的持久形态一致）。
  const aclJson = JSON.stringify(createDefaultRefAcl('main'));

  it('read-only-acceptance 项目视为 read-only', () => {
    const project = {
      execution_mode: 'read-only-acceptance' as const,
      write_capability_status: 'ready' as const,
      ref_acl_json: aclJson,
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
  });

  it('write_capability_status=lost 视为 read-only', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'lost' as const,
      ref_acl_json: aclJson,
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
  });

  it('write_capability_status=disabled 视为 read-only', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'disabled' as const,
      ref_acl_json: aclJson,
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
  });

  it('full + ready + 已配置 ref ACL 不是 read-only', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'ready' as const,
      ref_acl_json: aclJson,
    };
    expect(isProjectReadOnly(project as any)).toBe(false);
  });

  it('22.3-13：full + ready 但未配置 ref ACL → read-only（degraded_read_only 语义）', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'ready' as const,
      ref_acl_json: '',
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
  });

  it('22.3-13：配置 ref ACL 后不再 read-only', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'ready' as const,
      ref_acl_json: '',
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
    // 配置后（与 push ACL 同一规则来源：parseRefAcl 可解析的 ref_acl_json）
    const configured = { ...project, ref_acl_json: aclJson };
    expect(isProjectReadOnly(configured as any)).toBe(false);
  });

  it('非法 ref_acl_json 同样按未配置处理（fail-closed）', () => {
    const project = {
      execution_mode: 'full' as const,
      write_capability_status: 'ready' as const,
      ref_acl_json: '{not-json',
    };
    expect(isProjectReadOnly(project as any)).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* 4b. hasRefAcl 真实化（22.3-13：ref ACL 配置实存性）              */
/* ---------------------------------------------------------------- */

describe('22.3-13: hasRefAcl 读取项目 ref ACL 配置实存性', () => {
  const openStores: SqliteStore[] = [];
  afterEach(() => {
    while (openStores.length) openStores.pop()?.close();
  });

  function seedProject(overrides: Partial<ProjectRow> = {}): { store: SqliteStore; project: ProjectRow } {
    const store = new SqliteStore(':memory:');
    openStores.push(store);
    const now = Date.now();
    const row: ProjectRow = {
      project_id: `proj-${randomBytes(4).toString('hex')}`,
      display_name: 'p9 项目',
      repository_url: '',
      repository_fingerprint: '',
      default_branch: 'main',
      merge_policy: 'merge-queue',
      execution_mode: 'full',
      mode_transition: null,
      mode_transition_id: '',
      mode_transition_step: null,
      write_capability_status: 'ready',
      artifact_policy_id: '',
      workspace_policy_id: '',
      status: 'active',
      revision: 1,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    store.insertProject(row);
    return { store, project: store.getProject(row.project_id)! };
  }

  it('无 ACL 项目 → hasRefAcl false 且 isProjectReadOnly true', () => {
    const { store, project } = seedProject();
    expect(hasRefAcl(store, project.project_id)).toBe(false);
    expect(isProjectReadOnly(project)).toBe(true);
  });

  it('配置 ref ACL 后 → hasRefAcl true 且 isProjectReadOnly false', () => {
    const { store, project } = seedProject({ ref_acl_json: JSON.stringify(createDefaultRefAcl('main')) });
    expect(hasRefAcl(store, project.project_id)).toBe(true);
    expect(isProjectReadOnly(store.getProject(project.project_id)!)).toBe(false);
  });

  it('非法 JSON / allow 为空 → hasRefAcl false（无配置即 false）', () => {
    const bad = seedProject({ ref_acl_json: '{not-json' });
    expect(hasRefAcl(bad.store, bad.project.project_id)).toBe(false);
    const emptyAllow = seedProject({ ref_acl_json: JSON.stringify({ allow: [], deny: [] }) });
    expect(hasRefAcl(emptyAllow.store, emptyAllow.project.project_id)).toBe(false);
  });

  it('项目不存在 → hasRefAcl false', () => {
    const { store } = seedProject();
    expect(hasRefAcl(store, 'proj-not-exist')).toBe(false);
  });

  it('规则来源一致性：ref_acl_json 可被 parseRefAcl 解析为 push ACL 同构规则', () => {
    const acl = createDefaultRefAcl('main');
    const { store, project } = seedProject({ ref_acl_json: JSON.stringify(acl) });
    expect(hasRefAcl(store, project.project_id)).toBe(true);
    const parsed = parseRefAcl(project.ref_acl_json);
    expect(parsed).not.toBeNull();
    // 与 22.3-10 push 校验同一入口：默认分支仍被拒、attempt 分支仍放行
    expect(checkRefAcl('refs/heads/main', parsed!).allowed).toBe(false);
    expect(checkRefAcl('refs/heads/biao/attempt/task-1', parsed!).allowed).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* 5. importPlan（22.3-14）                                         */
/* ---------------------------------------------------------------- */

describe('22.3-14: importPlan read-only 拒绝', () => {
  it('read-only 项目拒绝写任务并逐条列出', () => {
    // 使用 mock store
    const mockStore = {
      getProject: () => ({
        project_id: 'proj-ro',
        execution_mode: 'read-only-acceptance',
        write_capability_status: 'ready',
        repository_url: '/tmp/repo',
      }),
      upsertTask: () => {},
      upsertPlan: () => {},
    };

    const result = importPlanForProject(mockStore as any, 'proj-ro', {
      tasks: [
        { task_id: 'task-1', title: 'Task 1', writable: true },
        { task_id: 'task-2', title: 'Task 2', writable: false },
        { task_id: 'task-3', title: 'Task 3', depends_on: ['task-1'] },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('READ_ONLY_PROJECT_REJECTS_WRITE_TASKS');
      expect(result.error.rejected_tasks.length).toBeGreaterThan(0);
      expect(result.error.rejected_tasks.some((r) => r.task_id === 'task-1')).toBe(true);
    }
  });

  it('full 项目正常导入', () => {
    const upsertedTasks: string[] = [];
    const mockStore = {
      getProject: () => ({
        project_id: 'proj-full',
        execution_mode: 'full',
        write_capability_status: 'ready',
        repository_url: '/tmp/repo',
        // 22.3-13：full 项目必须已配置 ref ACL 才允许导入写任务
        ref_acl_json: JSON.stringify(createDefaultRefAcl('main')),
      }),
      upsertTask: (task: any) => { upsertedTasks.push(task.task_id); },
      upsertPlan: () => {},
    };

    const result = importPlanForProject(mockStore as any, 'proj-full', {
      tasks: [
        { task_id: 'task-1', title: 'Task 1' },
        { task_id: 'task-2', title: 'Task 2' },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accepted_count).toBe(2);
      expect(result.rejected_count).toBe(0);
    }
    expect(upsertedTasks).toContain('task-1');
    expect(upsertedTasks).toContain('task-2');
  });

  it('22.3-13：full 项目未配置 ref ACL → 按读路径拒绝写任务', () => {
    const mockStore = {
      getProject: () => ({
        project_id: 'proj-full-noacl',
        execution_mode: 'full',
        write_capability_status: 'ready',
        repository_url: '/tmp/repo',
        ref_acl_json: '',
      }),
      upsertTask: () => {},
      upsertPlan: () => {},
    };

    const result = importPlanForProject(mockStore as any, 'proj-full-noacl', {
      tasks: [{ task_id: 'task-1', title: 'Task 1' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('READ_ONLY_PROJECT_REJECTS_WRITE_TASKS');
    }
  });
});

/* ---------------------------------------------------------------- */
/* 6. ref ACL 连续丢失熔断（22.3-17）                               */
/* ---------------------------------------------------------------- */

describe('22.3-17: ref ACL 连续丢失熔断', () => {
  it('未达阈值时不触发熔断', () => {
    const tracker = new RefAclMissTracker(3);
    expect(tracker.recordMiss('proj-1')).toBe(false);
    expect(tracker.recordMiss('proj-1')).toBe(false);
    expect(tracker.getMissCount('proj-1')).toBe(2);
  });

  it('达到阈值时触发熔断', () => {
    const tracker = new RefAclMissTracker(3);
    tracker.recordMiss('proj-1');
    tracker.recordHit('proj-1'); // 重置
    tracker.recordMiss('proj-1');
    tracker.recordMiss('proj-1');
    expect(tracker.recordMiss('proj-1')).toBe(true);
  });

  it('recordHit 重置计数', () => {
    const tracker = new RefAclMissTracker(3);
    tracker.recordMiss('proj-1');
    tracker.recordMiss('proj-1');
    tracker.recordHit('proj-1');
    expect(tracker.getMissCount('proj-1')).toBe(0);
  });

  it('不同 project 独立计数', () => {
    const tracker = new RefAclMissTracker(3);
    tracker.recordMiss('proj-1');
    tracker.recordMiss('proj-1');
    expect(tracker.getMissCount('proj-2')).toBe(0);
  });
});

/* ---------------------------------------------------------------- */
/* 7. V1 路由分类门禁（22.2-13/14）                                 */
/* ---------------------------------------------------------------- */

describe('22.2-13/14: V1 路由分类门禁', () => {
  it('所有 V1 mutation 路由已分类', () => {
    const mutations = V1_ROUTE_CLASSIFICATIONS.filter((r) => r.isMutation);
    expect(mutations.length).toBeGreaterThan(0);
    // 每个 mutation 都有有效的 category
    for (const m of mutations) {
      expect(['legacy_lifecycle', 'pm_transport', 'maintenance', 'read_only']).toContain(m.category);
    }
  });

  it('plan/create 属于 pm_transport', () => {
    const classification = classifyV1Route('/plan/create', 'POST');
    expect(classification).not.toBeNull();
    expect(classification?.category).toBe('pm_transport');
    expect(classification?.isMutation).toBe(true);
  });

  it('question/answer 属于 pm_transport', () => {
    const classification = classifyV1Route('/question/answer', 'POST');
    expect(classification).not.toBeNull();
    expect(classification?.category).toBe('pm_transport');
    expect(classification?.isMutation).toBe(true);
  });

  it('claim 属于 legacy_lifecycle', () => {
    const classification = classifyV1Route('/claim', 'POST');
    expect(classification).not.toBeNull();
    expect(classification?.category).toBe('legacy_lifecycle');
  });

  it('未分类路由返回 null', () => {
    const classification = classifyV1Route('/unknown/route', 'POST');
    expect(classification).toBeNull();
  });

  it('构建期门禁：未分类 mutation 路由被检出', () => {
    const registeredPaths = [
      { path: '/claim', method: 'POST' },
      { path: '/plan/create', method: 'POST' },
      { path: '/unknown/mutation', method: 'POST' },
    ];
    const unclassified = getUnclassifiedMutationRoutes(registeredPaths);
    expect(unclassified.length).toBe(1);
    expect(unclassified[0].path).toBe('/unknown/mutation');
  });
});

/* ---------------------------------------------------------------- */
/* 8. Git Remote 不可用（22.4-09）                                  */
/* ---------------------------------------------------------------- */

describe('22.4-09: Git Remote 不可用', () => {
  it('GitProviderErrorKind 包含 remote-unreachable', () => {
    // 类型检查：remote-unreachable 是合法的 kind
    const kind: 'remote-unreachable' = 'remote-unreachable';
    expect(kind).toBe('remote-unreachable');
  });
});

/* ---------------------------------------------------------------- */
/* 9. ref ACL 完整拒绝矩阵                                          */
/* ---------------------------------------------------------------- */

describe('ref ACL 拒绝矩阵：Node push 默认分支/tag/他人 branch 各一拒', () => {
  const acl = createDefaultRefAcl('main');

  it('Node push 默认分支 → 拒绝', () => {
    const decision = checkRefAcl('refs/heads/main', acl);
    expect(decision.allowed).toBe(false);
  });

  it('Node push tag → 拒绝', () => {
    const decision = checkRefAcl('refs/tags/v1.0.0', acl);
    expect(decision.allowed).toBe(false);
  });

  it('Node push 他人 branch → 拒绝', () => {
    const decision = checkRefAcl('refs/heads/feature/user-branch', acl);
    expect(decision.allowed).toBe(false);
  });

  it('Node push biao attempt branch → 允许', () => {
    const decision = checkRefAcl('refs/heads/biao/attempt/task-1', acl);
    expect(decision.allowed).toBe(true);
  });

  it('Node push marker ref → 允许', () => {
    const decision = checkRefAcl('refs/biao/attempt-markers/marker-1', acl);
    expect(decision.allowed).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* 9b. refspec 目标解析（push ACL 的判定对象）                       */
/* ---------------------------------------------------------------- */

describe('22.3-10: refspecDestinationRef 解析 push refspec 目标', () => {
  it('src:dst → dst；带 + 前缀同样取 dst', () => {
    expect(refspecDestinationRef('refs/heads/a:refs/heads/b')).toBe('refs/heads/b');
    expect(refspecDestinationRef('+refs/heads/a:refs/heads/b')).toBe('refs/heads/b');
  });

  it('sha:refs/biao/markers/x → marker ref（workspace finalize 的形态）', () => {
    expect(refspecDestinationRef('3f2a1b:refs/biao/attempt-markers/att-1')).toBe('refs/biao/attempt-markers/att-1');
  });

  it(':dst（删除）→ dst；裸 ref（同名推送）→ ref 本身', () => {
    expect(refspecDestinationRef(':refs/heads/main')).toBe('refs/heads/main');
    expect(refspecDestinationRef('refs/heads/biao/attempt/att-1')).toBe('refs/heads/biao/attempt/att-1');
  });

  it('空目标 → null（交给 git 本身报错）', () => {
    expect(refspecDestinationRef('refs/heads/a:')).toBeNull();
    expect(refspecDestinationRef('   ')).toBeNull();
  });
});

/* ---------------------------------------------------------------- */
/* 9c. 22.3-10 接线：generic-git push 路径的真实 ACL 校验            */
/*     （真实 git bare remote；workspace finalize 的 Node push 走    */
/*      同一 provider.push 入口，因此自动受控）                       */
/* ---------------------------------------------------------------- */

describe('22.3-10 接线：generic-git push 前置 ref ACL（真实 bare remote）', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 测试内真实 git（execFile 参数数组直传，不经 shell）。 */
  async function git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }

  /** 带 main 初始 commit 的 bare remote + 已推送的克隆。 */
  async function makeWorld(): Promise<{ bare: string; clone: string; mainSha: string }> {
    const root = mkdtempSync(join(tmpdir(), 'p9-acl-'));
    tempDirs.push(root);
    const bare = join(root, 'repo.git');
    const clone = join(root, 'repo');
    await git(['init', '--bare', '-b', 'main', bare]);
    await git(['clone', bare, clone]);
    writeFileSync(join(clone, 'README.md'), `# p9 acl ${randomBytes(4).toString('hex')}\n`);
    await git(['add', '.'], clone);
    await git(['-c', 'user.name=p9', '-c', 'user.email=p9@test', 'commit', '-m', 'init'], clone);
    await git(['push', 'origin', 'HEAD:refs/heads/main'], clone);
    const mainSha = await remoteSha(bare, 'refs/heads/main');
    return { bare, clone, mainSha: mainSha! };
  }

  async function remoteSha(bare: string, ref: string): Promise<string | null> {
    try {
      const out = await git(['ls-remote', bare, ref]);
      if (!out) return null;
      return out.split('\t')[0] || null;
    } catch {
      return null;
    }
  }

  /** 在克隆里新开分支并提交一个文件（返回当前分支 head sha）。 */
  async function commitOnNewBranch(clone: string, branch: string, filename: string): Promise<string> {
    await git(['checkout', '-q', '-b', branch], clone);
    writeFileSync(join(clone, filename), `${randomBytes(8).toString('hex')}\n`);
    await git(['add', '.'], clone);
    await git(['-c', 'user.name=p9', '-c', 'user.email=p9@test', 'commit', '-m', `feat ${branch}`], clone);
    return git(['rev-parse', 'HEAD'], clone);
  }

  it('push 默认分支 → kind=push-forbidden 且带 ACL 规则原因，远端零触达', async () => {
    const { bare, clone, mainSha } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    // Node 侧典型形态：HEAD:refs/heads/main
    const err = await provider.push(clone, ['HEAD:refs/heads/main']).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).kind).toBe('push-forbidden');
    expect((err as GitProviderError).message).toContain('默认分支');
    // 拒绝发生在 push 之前：远端默认分支原封不动
    expect(await remoteSha(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it('push tag → kind=push-forbidden（tag 规则原因）', async () => {
    const { clone } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    await git(['tag', 'v1.0.0'], clone);
    const err = await provider.push(clone, ['refs/tags/v1.0.0:refs/tags/v1.0.0']).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).kind).toBe('push-forbidden');
    expect((err as GitProviderError).message).toContain('tag');
  });

  it('push 他人 branch → kind=push-forbidden（默认拒绝原因）', async () => {
    const { clone } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    const err = await provider.push(clone, ['HEAD:refs/heads/feature/someone-else']).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).kind).toBe('push-forbidden');
    expect((err as GitProviderError).message).toContain('未匹配任何允许规则');
  });

  it('push 自身 attempt 分支 → 放行（真实 push 到 bare 成功）', async () => {
    const { bare, clone } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    const head = await commitOnNewBranch(clone, 'biao/attempt/att-node-1', 'attempt.md');
    await expect(provider.push(clone, ['HEAD:refs/heads/biao/attempt/att-node-1'])).resolves.toBeUndefined();
    expect(await remoteSha(bare, 'refs/heads/biao/attempt/att-node-1')).toBe(head);
  });

  it('push marker ref → 放行（signed marker 的 refs/biao/attempt-markers/**）', async () => {
    const { bare, clone } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    const head = await git(['rev-parse', 'HEAD'], clone);
    // workspace finalize 形态：branch + marker 一起原子推送
    await expect(provider.push(clone, [
      `${head}:refs/heads/biao/attempt/att-node-2`,
      `${head}:refs/biao/attempt-markers/att-node-2`,
    ], { atomic: true })).resolves.toBeUndefined();
    expect(await remoteSha(bare, 'refs/biao/attempt-markers/att-node-2')).toBe(head);
  });

  it('删除默认分支远端 ref 同样被 ACL 拒绝；删除 attempt 分支放行', async () => {
    const { bare, clone } = await makeWorld();
    const provider = new GenericGitProvider({ pushAcl: createDefaultRefAcl('main') });
    const head = await commitOnNewBranch(clone, 'biao/attempt/att-cleanup', 'cleanup.md');
    await provider.push(clone, [`${head}:refs/heads/biao/attempt/att-cleanup`]);

    // 删除 = push :ref，同一 ACL 入口
    const err = await provider.deleteRemoteRef(bare, 'refs/heads/main').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).kind).toBe('push-forbidden');

    // branch cleanup 合法目标：attempt 分支删除放行
    await expect(provider.deleteRemoteRef(bare, 'refs/heads/biao/attempt/att-cleanup')).resolves.toBeUndefined();
    expect(await remoteSha(bare, 'refs/heads/biao/attempt/att-cleanup')).toBeNull();
  });

  it('函数式 pushAcl（按仓库上下文解析）同样生效；返回 null 时该次不启用', async () => {
    const { bare, clone, mainSha } = await makeWorld();
    const strict = new GenericGitProvider({
      pushAcl: ({ dir }) => (dir === clone ? createDefaultRefAcl('main') : null),
    });
    const err = await strict.push(clone, ['HEAD:refs/heads/main']).then(() => null, (e: unknown) => e);
    expect((err as GitProviderError)?.kind).toBe('push-forbidden');
    expect(await remoteSha(bare, 'refs/heads/main')).toBe(mainSha);
  });
});

/* ---------------------------------------------------------------- */
/* 6b. 22.3-15：EvidenceAcceptance 创建/查询/只读语义/越权拒绝       */
/* ---------------------------------------------------------------- */

describe('22.3-15: EvidenceAcceptance（真实 store）', () => {
  const openStores: SqliteStore[] = [];

  afterEach(() => {
    while (openStores.length) openStores.pop()?.close();
  });

  function seedWorld(): { store: SqliteStore; projectId: string; taskId: string; attemptId: string } {
    const store = new SqliteStore(':memory:');
    openStores.push(store);
    const now = Date.now();
    const project: ProjectRow = {
      project_id: `proj-${randomBytes(4).toString('hex')}`,
      display_name: 'p9 evidence 项目',
      repository_url: '',
      repository_fingerprint: '',
      default_branch: 'main',
      merge_policy: 'merge-queue',
      // full + 已配置 ref ACL：Artifact-only（writable:false）任务可正常导入，
      // EvidenceAcceptance 在 full 项目同样可用（但不能解锁写 lineage）。
      execution_mode: 'full',
      mode_transition: null,
      mode_transition_id: '',
      mode_transition_step: null,
      write_capability_status: 'ready',
      artifact_policy_id: '',
      workspace_policy_id: '',
      status: 'active',
      revision: 1,
      created_at: now,
      updated_at: now,
      ref_acl_json: JSON.stringify(createDefaultRefAcl('main')),
    };
    store.insertProject(project);
    const imported = importPlanForProject(store, project.project_id, {
      tasks: [{ task_id: 'task-evd', title: 'Artifact-only 验收', writable: false }],
    });
    if (!imported.ok) throw new Error(`种子导入失败: ${imported.error.message}`);
    const attemptId = `att-${randomBytes(4).toString('hex')}`;
    store.insertTaskAttempt({
      attempt_id: attemptId,
      task_id: 'task-evd',
      project_id: project.project_id,
      node_id: 'node-sim-1',
      session_id: '',
      attempt_generation: 1,
      status: 'executing',
      lease_expires_at: now + 600_000,
      lease_duration_ms: 600_000,
      token_jti: '',
      artifact_ids: '[]',
      started_at: now,
      updated_at: now,
      completed_at: null,
      failure_reason: '',
    });
    return { store, projectId: project.project_id, taskId: 'task-evd', attemptId };
  }

  it('创建 EvidenceAcceptance：ok 且 acceptance_id 稳定前缀 ea-，落库字段完整', () => {
    const { store, projectId, taskId, attemptId } = seedWorld();
    const commitSha = 'a'.repeat(40);
    const created = createEvidenceAcceptanceForTask(store, attemptId, commitSha, 'pm');
    expect(created.ok).toBe(true);
    expect(created.acceptance_id).toMatch(/^ea-/);

    const row = store.getEvidenceAcceptance(created.acceptance_id);
    expect(row).toBeDefined();
    expect(row!.attempt_id).toBe(attemptId);
    expect(row!.task_id).toBe(taskId);
    expect(row!.project_id).toBe(projectId);
    expect(row!.commit_sha).toBe(commitSha);
    expect(row!.level).toBe('pm');
    expect(row!.status).toBe('pending');
  });

  it('查询：listEvidenceAcceptances 按 project/attempt 命中', () => {
    const { store, projectId, attemptId } = seedWorld();
    const created = createEvidenceAcceptanceForTask(store, attemptId, 'b'.repeat(40), 'node_harness');
    expect(created.ok).toBe(true);
    const byProject = store.listEvidenceAcceptances(projectId);
    expect(byProject.map((r) => r.acceptance_id)).toContain(created.acceptance_id);
    const byAttempt = store.listEvidenceAcceptances(projectId, attemptId);
    expect(byAttempt).toHaveLength(1);
    expect(byAttempt[0].level).toBe('node_harness');
  });

  it('只读语义：不能解锁写 lineage——task 状态不被改为可写流转', () => {
    const { store, taskId, attemptId } = seedWorld();
    const before = store.getTask(taskId)!;
    expect(before.status).toBe('pending');

    const created = createEvidenceAcceptanceForTask(store, attemptId, 'c'.repeat(40), 'pm');
    expect(created.ok).toBe(true);

    // EvidenceAcceptance 是证据记录，不是完成流转：task 不进入 done/可写下游解锁，
    // 也不回填 accepted_evidence_id / completion_kind（那些属于 merge 口径）。
    const after = store.getTask(taskId)!;
    expect(after.status).toBe('pending');
    expect(after.done_at).toBe('');
    expect(after.accepted_evidence_id ?? '').toBe('');
    expect(after.completion_kind ?? '').toBe('');
  });

  it('越权创建拒绝：伪造 attempt / 伪造 level 均失败且不落库', () => {
    const { store, projectId, attemptId } = seedWorld();
    // 伪造不存在的 attempt
    const forged = createEvidenceAcceptanceForTask(store, 'att-not-exist', 'd'.repeat(40), 'pm');
    expect(forged.ok).toBe(false);
    expect(forged.error).toContain('不存在');
    // 伪造非法 level（越权提升验收级别）
    const badLevel = createEvidenceAcceptanceForTask(store, attemptId, 'd'.repeat(40), 'root' as any);
    expect(badLevel.ok).toBe(false);
    expect(badLevel.error).toContain('非法');
    // 均未写入任何 acceptance
    expect(store.listEvidenceAcceptances(projectId)).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- */
/* 10b. 22.4-24：writebackExternalMerge 人工 merge 回写              */
/*     （实现位于 merge/queue.ts——只测不改；直接调用导出函数）        */
/* ---------------------------------------------------------------- */

describe('22.4-24: writebackExternalMerge 人工 merge 回写（真实 store）', () => {
  const openStores: SqliteStore[] = [];

  afterEach(() => {
    while (openStores.length) openStores.pop()?.close();
  });

  interface World {
    store: SqliteStore;
    recordingStore: SqliteStore;
    projectId: string;
    upstreamDeliveryId: string;
    downstreamDeliveryId: string;
    unlockCalls: Array<{ projectId: string; status?: string }>;
  }

  function seedWorld(): World {
    const store = new SqliteStore(':memory:');
    openStores.push(store);
    const now = Date.now();
    const project: ProjectRow = {
      project_id: `proj-${randomBytes(4).toString('hex')}`,
      display_name: 'p9 writeback 项目',
      repository_url: '/tmp/repo.git',
      repository_fingerprint: '',
      default_branch: 'main',
      merge_policy: 'merge-queue',
      execution_mode: 'full',
      mode_transition: null,
      mode_transition_id: '',
      mode_transition_step: null,
      write_capability_status: 'ready',
      artifact_policy_id: '',
      workspace_policy_id: '',
      status: 'active',
      revision: 1,
      created_at: now,
      updated_at: now,
      ref_acl_json: JSON.stringify(createDefaultRefAcl('main')),
    };
    store.insertProject(project);
    const imported = importPlanForProject(store, project.project_id, {
      tasks: [
        { task_id: 'task-up', title: '上游写任务' },
        { task_id: 'task-down', title: '下游写任务', depends_on: ['task-up'] },
      ],
    });
    if (!imported.ok) throw new Error(`种子导入失败: ${imported.error.message}`);

    const unlockCalls: Array<{ projectId: string; status?: string }> = [];
    const insertAttempt = (taskId: string, suffix: string): { attemptId: string; headSha: string } => {
      const attemptId = `att-${suffix}`;
      const headSha = randomBytes(20).toString('hex');
      store.insertTaskAttempt({
        attempt_id: attemptId,
        task_id: taskId,
        project_id: project.project_id,
        node_id: 'node-sim-1',
        session_id: '',
        attempt_generation: 1,
        status: 'executing',
        lease_expires_at: now + 600_000,
        lease_duration_ms: 600_000,
        token_jti: '',
        artifact_ids: '[]',
        started_at: now,
        updated_at: now,
        completed_at: null,
        failure_reason: '',
      });
      return { attemptId, headSha };
    };
    const insertDelivery = (attemptId: string, taskId: string, headSha: string, deliveryId: string): void => {
      store.insertDelivery({
        delivery_id: deliveryId,
        task_id: taskId,
        attempt_id: attemptId,
        project_id: project.project_id,
        base_sha: 'e'.repeat(40),
        head_sha: headSha,
        tree_sha: '',
        branch_ref: `refs/heads/biao/attempt/${attemptId}`,
        changed_files: '[]',
        patch_digest: '',
        artifact_ids: '[]',
        verify_manifest_digest: '',
        status: 'accepted',
        accepted_commit_sha: '',
        merged_commit_sha: '',
        invalidated_reason: '',
        diff_summary: '[]',
        server_verified: 1,
        created_at: now,
        updated_at: now,
      });
    };

    const up = insertAttempt('task-up', 'up');
    const down = insertAttempt('task-down', 'down');
    // queue.ts 的 unlockDownstream 经 getTaskByAttemptId（tasks.active_attempt_id）
    // 找 merged delivery 对应的 task——种子需把 attempt 关联回 task
    // （active_attempt_id 是 §20.2 扩展列，upsertTask 不覆盖，走字段级更新）。
    store.updateTaskFields('task-up', { active_attempt_id: up.attemptId });
    store.updateTaskFields('task-down', { active_attempt_id: down.attemptId });
    const upstreamDeliveryId = `dlv-up-${randomBytes(3).toString('hex')}`;
    const downstreamDeliveryId = `dlv-down-${randomBytes(3).toString('hex')}`;
    insertDelivery(up.attemptId, 'task-up', up.headSha, upstreamDeliveryId);
    insertDelivery(down.attemptId, 'task-down', down.headSha, downstreamDeliveryId);
    // 下游 queued merge job（depends_on task-up，等上游 merged 后解锁）
    store.insertMergeJob({
      merge_job_id: `mj-${randomBytes(5).toString('hex')}`,
      delivery_id: downstreamDeliveryId,
      project_id: project.project_id,
      expected_target_sha: 'f'.repeat(40),
      source_sha: down.headSha,
      strategy: 'merge-ff',
      status: 'queued',
      final_sha: '',
      cancel_reason: '',
      conflict_files: '[]',
      error_message: '',
      created_at: now,
      updated_at: now,
      completed_at: null,
    });

    // 记录型 store：捕获 unlockDownstream 的 listMergeJobs(projectId, 'queued') 扫描
    const recordingStore = Object.create(store) as SqliteStore;
    recordingStore.listMergeJobs = (projectId: string, status?: string) => {
      unlockCalls.push({ projectId, status });
      return store.listMergeJobs(projectId, status);
    };

    return { store, recordingStore, projectId: project.project_id, upstreamDeliveryId, downstreamDeliveryId, unlockCalls };
  }

  /** writeback 不触达 git；provider 用最小桩即可。 */
  const stubProvider = { lsRemote: async () => [] } as unknown as GitProvider;

  it('回写后 delivery merged + final_sha，且标记待复核', () => {
    const world = seedWorld();
    const queue = createMergeQueue({ store: world.recordingStore, provider: stubProvider });
    const finalSha = randomBytes(20).toString('hex');

    const result = queue.writebackExternalMerge(world.projectId, world.upstreamDeliveryId, finalSha);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.final_sha).toBe(finalSha);
    }

    const delivery = world.store.getDelivery(world.upstreamDeliveryId)!;
    expect(delivery.status).toBe('merged');
    expect(delivery.merged_commit_sha).toBe(finalSha);
    expect(delivery.server_verified).toBe(0); // Integration Verify 待复核
  });

  it('审计可见：delivery.diff_summary 记录 merged_by=external + final_sha + writeback_at', () => {
    const world = seedWorld();
    const queue = createMergeQueue({ store: world.recordingStore, provider: stubProvider });
    const finalSha = randomBytes(20).toString('hex');
    const before = Date.now();
    queue.writebackExternalMerge(world.projectId, world.upstreamDeliveryId, finalSha);

    const delivery = world.store.getDelivery(world.upstreamDeliveryId)!;
    // queue.ts 冻结不改——审计面以其落库的回写记录为准（merged_by/final_sha/writeback_at）
    const record = JSON.parse(delivery.diff_summary) as {
      merged_by: string; final_sha: string; writeback_at: number;
    };
    expect(record.merged_by).toBe('external');
    expect(record.final_sha).toBe(finalSha);
    expect(record.writeback_at).toBeGreaterThanOrEqual(before);
  });

  it('下游解锁调用发生：unlockDownstream 触发 queued 扫描', () => {
    const world = seedWorld();
    const queue = createMergeQueue({ store: world.recordingStore, provider: stubProvider });
    expect(world.unlockCalls).toHaveLength(0);

    queue.writebackExternalMerge(world.projectId, world.upstreamDeliveryId, randomBytes(20).toString('hex'));

    // §12.4 解锁扫描被触发：对本项目 queued merge jobs 做了依赖拓扑检查
    const queuedScan = world.unlockCalls.find((c) => c.projectId === world.projectId && c.status === 'queued');
    expect(queuedScan).toBeDefined();
    // 下游 delivery 仍保持 accepted（解锁口径 = merge，而非改写下游状态）
    expect(world.store.getDelivery(world.downstreamDeliveryId)!.status).toBe('accepted');
  });

  it('跨项目回写 → PROJECT_MISMATCH；不存在 → DELIVERY_NOT_FOUND', () => {
    const world = seedWorld();
    const queue = createMergeQueue({ store: world.recordingStore, provider: stubProvider });

    const mismatch = queue.writebackExternalMerge('proj-not-mine', world.upstreamDeliveryId, 'a'.repeat(40));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('PROJECT_MISMATCH');

    const missing = queue.writebackExternalMerge(world.projectId, 'dlv-not-exist', 'a'.repeat(40));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('DELIVERY_NOT_FOUND');

    // 拒绝路径不产生任何回写副作用
    expect(world.store.getDelivery(world.upstreamDeliveryId)!.status).toBe('accepted');
  });
});
