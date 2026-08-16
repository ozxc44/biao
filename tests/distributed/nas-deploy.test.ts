/**
 * NAS 部署 E2E 测试
 * 
 * 使用独立的 compose profile 隔离端口和卷，避免与生产环境冲突。
 * CI 环境可通过 NAS_DEPLOY_E2E 环境变量跳过。
 * 
 * 运行方式：
 *   NAS_DEPLOY_E2E=1 npx vitest run tests/distributed/nas-deploy.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DEPLOY_DIR = join(import.meta.dirname, '..', '..', 'deploy', 'nas');
const TEST_PORT = 17331;  // 避让生产端口 7331
const TEST_REDIS_PORT = 16380;  // 避让生产端口 6380

// 跳过条件：无 docker 或未设置 NAS_DEPLOY_E2E
const skipIf = !process.env.NAS_DEPLOY_E2E;

describe.skipIf(skipIf)('NAS 部署 E2E', () => {
  let composeProject: string;

  beforeAll(async () => {
    composeProject = `biao-test-${Date.now()}`;
    
    // 使用 test profile 启动服务
    execSync(
      `docker compose -p ${composeProject} -f docker-compose.yml -f docker-compose.test.yml up -d --build`,
      {
        cwd: DEPLOY_DIR,
        env: {
          ...process.env,
          BIAO_API_TOKEN: 'test-token-for-e2e',
          BIAO_V2_CREDENTIAL_KEY: 'test-credential-key-for-e2e',
          TEST_PORT: String(TEST_PORT),
          TEST_REDIS_PORT: String(TEST_REDIS_PORT),
        },
        timeout: 300_000,  // 5 分钟构建超时
      }
    );

    // 等待健康检查
    let retries = 30;
    while (retries > 0) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
        if (res.ok) break;
      } catch {
        // 忽略连接错误
      }
      await new Promise(r => setTimeout(r, 2000));
      retries--;
    }
  }, 360_000);

  afterAll(() => {
    // 清理测试容器和卷
    try {
      execSync(
        `docker compose -p ${composeProject} down -v`,
        { cwd: DEPLOY_DIR, timeout: 60_000 }
      );
    } catch {
      // 忽略清理错误
    }
  });

  it('health 端点返回 200', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.redis).toBe('connected');
  });

  it('V1 version 端点返回正确版本', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/version`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.version).toBe('0.1.0');
  });

  it('V2 /version 返回 protocol_version', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/version`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.protocol_version).toBe(2);
  });

  it('V2 feature flags 默认全关', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/v2/feature-flags`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    
    const flags = body.data.flags;
    expect(flags).toHaveLength(5);
    
    // 所有 flag 应该是关闭的
    for (const flag of flags) {
      expect(flag.enabled).toBe(false);
    }
  });

  it('Redis AOF 已启用', async () => {
    const output = execSync(
      `docker exec ${composeProject}-biao-redis-1 redis-cli CONFIG GET appendonly`,
      { encoding: 'utf-8' }
    );
    expect(output).toContain('yes');
  });

  it('SQLite 数据库已创建', async () => {
    const output = execSync(
      `docker exec ${composeProject}-biao-server-1 ls -la /data/biao.sqlite`,
      { encoding: 'utf-8' }
    );
    expect(output).toContain('biao.sqlite');
  });

  it('提交 plan 后重启数据持久化', async () => {
    // 提交一个测试 plan
    const planRes = await fetch(`http://127.0.0.1:${TEST_PORT}/plan/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token-for-e2e',
      },
      body: JSON.stringify({
        plan_id: 'test-persistence',
        title: '持久化测试',
        project_path: '/tmp/test-project',
      }),
    });
    expect(planRes.status).toBe(200);
    const planBody = await planRes.json();
    expect(planBody.ok).toBe(true);

    // 重启 biao-server 容器
    execSync(
      `docker compose -p ${composeProject} restart biao-server`,
      { cwd: DEPLOY_DIR, timeout: 30_000 }
    );

    // 等待重启完成
    let retries = 15;
    while (retries > 0) {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
        if (res.ok) break;
      } catch {
        // 忽略连接错误
      }
      await new Promise(r => setTimeout(r, 2000));
      retries--;
    }

    // 验证 plan 仍然存在
    const getRes = await fetch(`http://127.0.0.1:${TEST_PORT}/plan/test-persistence`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.data.plan_id).toBe('test-persistence');
  });
});
