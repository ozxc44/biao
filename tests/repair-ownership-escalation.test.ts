/**
 * PM 拒绝时的受控 repair ownership 扩展。
 *
 * 这组集成测试直接走 Redis + service 状态机，确保扩权只作用于新 repair，
 * 不会反写被拒绝任务的 ownership 审计。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { agentRegister, claim, pmReview, report } from '../src/server/service.js';
import { createHttpServer } from '../src/server/http.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';
import type { BiaoConfig } from '../src/types/index.js';

const REDIS_URL = process.env.REPAIR_OWNERSHIP_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380/13';
const PROJECT_PATH = '/tmp/biao-repair-ownership-escalation';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  await writePlanToRedis(redis, {
    plan_id: 'repair-ownership-plan',
    title: 'Repair ownership escalation',
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-repair-ownership',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => redis.disconnect());

async function doneSource(taskId: string, ownership = {
  files: ['apps/api/src/mail/source.ts'],
  modules: ['mail-core'],
}): Promise<void> {
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    timeout_seconds: 60,
    ownership,
    verify: [],
  }, `# ${taskId}\n`, 'repair-ownership-plan', PROJECT_PATH, 5);
  await agentRegister(redis, `${taskId}-worker`, 'mock', ['code']);
  const claimed = await claim(redis, { agent_id: `${taskId}-worker`, blocking: false, timeout_ms: 1 });
  expect(claimed.data?.task_id).toBe(taskId);
  const completed = await report(redis, {
    task_id: taskId,
    agent_id: `${taskId}-worker`,
    claim_token: claimed.data!.claim_token,
    status: 'done',
  });
  expect(completed.ok).toBe(true);
}

function httpConfig(): BiaoConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    redisUrl: REDIS_URL,
    authEnabled: false,
    workspaceRoots: [PROJECT_PATH],
    sqlitePath: '/tmp/biao-repair-ownership-escalation.sqlite',
    streamMaxlen: 10_000,
    conflictRetention: 1_000,
  };
}

describe('PM repair ownership escalation', () => {
  it('默认 reject 仍原样继承来源 ownership', async () => {
    await doneSource('default-inheritance');

    const reviewed = await pmReview(redis, 'default-inheritance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要修复',
    });

    expect(reviewed).toMatchObject({ ok: true, data: { fix_task_id: 'default-inheritance-repair-1' } });
    const repair = await redis.hgetall(keys.hash.task('default-inheritance-repair-1'));
    expect(repair.ownership_files).toBe('apps/api/src/mail/source.ts');
    expect(repair.ownership_modules).toBe('mail-core');
    expect(repair.repair_ownership_extension ?? '').toBe('');
  });

  it('将来源 ownership 与 PM 显式扩权去重并集，并把扩权写入 repair 审计和目标', async () => {
    await doneSource('expanded-inheritance');
    const sourceBefore = await redis.hgetall(keys.hash.task('expanded-inheritance'));

    const reviewed = await pmReview(redis, 'expanded-inheritance', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '验收发现相邻绑定层也需要修复',
      repair_ownership: {
        files: [
          'apps/api/src/mail/source.ts',
          'apps/api/src/mcp/mailbox-v2.ts',
          ' apps/api/src/mcp/mailbox-v2.ts ',
        ],
        modules: ['mail-core', 'mailbox-v2', ' mailbox-v2 '],
      },
    });

    expect(reviewed).toMatchObject({ ok: true, data: { fix_task_id: 'expanded-inheritance-repair-1' } });
    const repair = await redis.hgetall(keys.hash.task('expanded-inheritance-repair-1'));
    expect(repair.ownership_files).toBe('apps/api/src/mail/source.ts,apps/api/src/mcp/mailbox-v2.ts');
    expect(repair.ownership_modules).toBe('mail-core,mailbox-v2');
    expect(JSON.parse(repair.repair_ownership_extension)).toEqual({
      files: ['apps/api/src/mcp/mailbox-v2.ts'],
      modules: ['mailbox-v2'],
    });
    expect(repair.goal_md).toContain('PM 授权的所有权扩展');
    expect(repair.goal_md).toContain('apps/api/src/mcp/mailbox-v2.ts');
    expect(repair.goal_md).toContain('原任务 ownership 未修改');

    const sourceAfter = await redis.hgetall(keys.hash.task('expanded-inheritance'));
    expect({
      ownership_files: sourceAfter.ownership_files,
      ownership_modules: sourceAfter.ownership_modules,
      goal_md: sourceAfter.goal_md,
      project_path: sourceAfter.project_path,
      created_at: sourceAfter.created_at,
    }).toEqual({
      ownership_files: sourceBefore.ownership_files,
      ownership_modules: sourceBefore.ownership_modules,
      goal_md: sourceBefore.goal_md,
      project_path: sourceBefore.project_path,
      created_at: sourceBefore.created_at,
    });
  });

  it('HTTP review 接口将显式扩权写入可读取的 repair 审计', async () => {
    await doneSource('http-escalation');
    const app = await createHttpServer(redis, httpConfig());
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/task/http-escalation/review',
        payload: {
          verdict: 'reject',
          reviewed_by: 'pm-http',
          reject_reason: '相邻 MCP 边界需要修复',
          repair_ownership: { files: ['apps/api/src/mcp/mailbox-v2.ts'] },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        data: { fix_task_id: 'http-escalation-repair-1', review_status: 'rejected' },
      });

      const review = await app.inject({ method: 'GET', url: '/task/http-escalation-repair-1/review' });
      expect(review.statusCode).toBe(200);
      expect(review.json()).toMatchObject({
        ok: true,
        data: {
          repair_ownership_extension: { files: ['apps/api/src/mcp/mailbox-v2.ts'], modules: [] },
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    { files: ['   '] },
    { files: ['apps/api/src/a.ts,apps/api/src/b.ts'] },
  ])('非法 repair ownership 在写入 reject 审计前被拒绝：%o', async (repair_ownership) => {
    await doneSource('invalid-escalation');
    const sourceBefore = await redis.hgetall(keys.hash.task('invalid-escalation'));

    const reviewed = await pmReview(redis, 'invalid-escalation', {
      verdict: 'reject',
      reviewed_by: 'pm',
      reject_reason: '需要修复',
      repair_ownership,
    });

    expect(reviewed.ok).toBe(false);
    expect(reviewed.error?.code).toBe('INVALID_REPAIR_OWNERSHIP');
    expect(await redis.hgetall(keys.hash.task('invalid-escalation'))).toEqual(sourceBefore);
    expect(await redis.exists(keys.hash.task('invalid-escalation-repair-1'))).toBe(0);
  });
});
