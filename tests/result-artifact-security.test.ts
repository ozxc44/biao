import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentRegister,
  claim,
  getReviewInfo,
  pmReview,
  report,
} from '../src/server/service.js';
import { writePlanToRedis, writeTaskToRedis } from '../src/redis/ownership.js';
import { keys } from '../src/redis/keys.js';
import {
  readValidatedTaskArtifact,
  resolveAndValidateTaskArtifactPath,
} from '../src/server/security.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const PROJECT_PATH = mkdtempSync(join(tmpdir(), 'biao-artifact-security-'));
let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

beforeEach(async () => {
  await redis.flushdb();
  rmSync(join(PROJECT_PATH, 'work'), { recursive: true, force: true });
  await writePlanToRedis(redis, {
    plan_id: 'artifact-plan',
    title: 'artifact-plan',
    project_path: PROJECT_PATH,
    pm_consumer: 'pm-artifact',
    default_assignee: 'auto',
    default_priority: 5,
  }, 0);
});

afterAll(() => {
  redis.disconnect();
  rmSync(PROJECT_PATH, { recursive: true, force: true });
});

async function seedAndClaim(taskId: string) {
  await writeTaskToRedis(redis, {
    task_id: taskId,
    title: taskId,
    type: 'code',
    phase: 'impl',
    assignee: 'auto',
    priority: 5,
    timeout_seconds: 60,
    verify: [],
  } as never, `# ${taskId}`, 'artifact-plan', PROJECT_PATH, 5);
  await agentRegister(redis, `worker-${taskId}`, 'mock', ['code']);
  return claim(redis, {
    agent_id: `worker-${taskId}`,
    blocking: false,
    timeout_ms: 1,
    preferred_project: PROJECT_PATH,
  });
}

function writeArtifacts(taskId: string): { resultPath: string; resultJsonPath: string } {
  const workDir = join(PROJECT_PATH, 'work', taskId);
  mkdirSync(workDir, { recursive: true });
  const resultPath = join(workDir, 'result.md');
  const resultJsonPath = join(workDir, 'result.json');
  writeFileSync(resultPath, '# Result\n\nPASS\n');
  writeFileSync(resultJsonPath, JSON.stringify({ status: 'done', changed_files: [] }));
  return { resultPath, resultJsonPath };
}

describe('task result artifact boundary', () => {
  it('只接受当前 task 的固定普通文件并可安全读取', () => {
    const { resultPath, resultJsonPath } = writeArtifacts('task-a');
    expect(resolveAndValidateTaskArtifactPath(
      resultPath,
      PROJECT_PATH,
      'task-a',
      'result.md',
    )).toBe(resultPath);
    expect(readValidatedTaskArtifact(
      resultJsonPath,
      PROJECT_PATH,
      'task-a',
      'result.json',
    )).toContain('changed_files');
  });

  it('跨 task result 被拒且不消耗 lease 或 running 状态', async () => {
    const claimed = await seedAndClaim('task-b');
    const foreign = writeArtifacts('task-a');
    const outcome = await report(redis, {
      task_id: 'task-b',
      agent_id: 'worker-task-b',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: foreign.resultPath,
      result_json_path: foreign.resultJsonPath,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'RESULT_PATH_OUTSIDE_WORKSPACE' },
    });
    expect(await redis.get(keys.string.lease('task-b'))).toBe(claimed.data!.claim_token);
    expect(await redis.hget(keys.hash.task('task-b'), 'status')).toBe('running');
  });

  it('最终文件为符号链接时拒绝 report', async () => {
    const claimed = await seedAndClaim('task-link');
    const secret = join(PROJECT_PATH, 'outside-result.md');
    writeFileSync(secret, 'PRIVATE DATA');
    const workDir = join(PROJECT_PATH, 'work', 'task-link');
    mkdirSync(workDir, { recursive: true });
    const resultPath = join(workDir, 'result.md');
    symlinkSync(secret, resultPath);

    const outcome = await report(redis, {
      task_id: 'task-link',
      agent_id: 'worker-task-link',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: resultPath,
    });
    expect(outcome.ok).toBe(false);
    expect(await redis.hget(keys.hash.task('task-link'), 'status')).toBe('running');
  });

  it('report 后替换为符号链接时，查看与 accept 都失败关闭且不泄露内容', async () => {
    const claimed = await seedAndClaim('task-swap');
    const artifacts = writeArtifacts('task-swap');
    expect((await report(redis, {
      task_id: 'task-swap',
      agent_id: 'worker-task-swap',
      claim_token: claimed.data!.claim_token,
      status: 'done',
      result_path: artifacts.resultPath,
      result_json_path: artifacts.resultJsonPath,
    })).ok).toBe(true);

    const secret = join(PROJECT_PATH, 'post-report-secret.md');
    writeFileSync(secret, 'DO NOT EXPOSE');
    unlinkSync(artifacts.resultPath);
    symlinkSync(secret, artifacts.resultPath);

    expect(await getReviewInfo(redis, 'task-swap')).toMatchObject({
      ok: false,
      error: { code: 'RESULT_ARTIFACT_INVALID' },
    });
    expect(await pmReview(redis, 'task-swap', {
      verdict: 'accept',
      reviewed_by: 'pm-artifact',
    })).toMatchObject({
      ok: false,
      error: { code: 'RESULT_ARTIFACT_INVALID' },
    });
    expect(await redis.hget(keys.hash.task('task-swap'), 'pm_review_status')).toBeNull();
  });

  it('恶意 task_id 不能把预期结果根移出 work 单层目录', () => {
    const { resultPath } = writeArtifacts('safe-task');
    for (const taskId of ['../safe-task', 'nested/safe-task', '..', '.']) {
      expect(() => resolveAndValidateTaskArtifactPath(
        resultPath,
        PROJECT_PATH,
        taskId,
        'result.md',
      )).toThrowError(expect.objectContaining({ code: 'WORKSPACE_PATH_DENIED' }));
    }
  });
});
