/**
 * Mock worker（M0 用）
 * 不调真实 agent CLI，直接 echo 产出 result.md
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkerProgressTracker } from './base.js';
import type { ClaimedTask } from '../types/index.js';
import { atomicWriteWorkerArtifact, secureTaskWorkDir } from './artifact-security.js';

const BIAO_URL = process.env.BIAO_URL ?? 'http://localhost:7331';
const AGENT_ID = process.env.BIAO_AGENT_ID ?? 'mock-1';
let registrationId = '';

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BIAO_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return res.json();
}

async function register(): Promise<void> {
  const registered = await api('/register', {
    method: 'POST',
    body: JSON.stringify({ agent_id: AGENT_ID, agent_type: 'mock', capabilities: ['code', 'review', 'research', 'docs'] }),
  });
  if (!registered?.ok || !registered.data?.registration_id) {
    throw new Error(`register failed: ${registered?.error?.code ?? 'MISSING_REGISTRATION_ID'}`);
  }
  registrationId = registered.data.registration_id;
  await api('/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ agent_id: AGENT_ID, registration_id: registrationId, current_task: '' }),
  });
  console.log(`[mock-worker] 注册为 ${AGENT_ID}`);
}

async function runOneTask(): Promise<boolean> {
  // claim
  const claimRes = await api('/claim', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: AGENT_ID,
      registration_id: registrationId,
      claim_request_id: `claim_${randomUUID().replaceAll('-', '')}`,
      blocking: false,
    }),
  });
  if (!claimRes.ok || !claimRes.data) {
    return false; // 无任务
  }

  const task = claimRes.data as ClaimedTask;
  console.log(`[mock-worker] 领取任务：${task.task_id} (${task.title})`);

  const projectPath = task.project_path || process.cwd();
  const workDir = secureTaskWorkDir(projectPath, task.task_id);
  const progress = createWorkerProgressTracker(workDir, task, AGENT_ID);

  try {

  // 执行前查占用（对所有 ownership_files）
  for (const glob of task.ownership_files ?? []) {
    const ownRes = await api(`/ownership?path=${encodeURIComponent(glob)}&agent_id=${AGENT_ID}`);
    if (ownRes.data?.action === 'wait') {
      console.log(`[mock-worker]   ⚠ ${glob} 被占用（${ownRes.data.owner?.agent_id}），但 mock 直接继续（不严格遵守）`);
    }
  }

  // 执行（mock：sleep 100ms 模拟工作）
  progress.advance('running');
  await new Promise((r) => setTimeout(r, 100));

  // 写产出物
  progress.advance('verifying');

  const resultMd = `# 任务结果：${task.title}

## 执行摘要
Mock worker 执行完毕。

## 改动文件
（mock 不真正改文件）

## 验证结果
${(task.verify ?? []).map((v: any) => `- ${v.cmd}: SKIPPED (mock)`).join('\n') || '- 无验证命令'}

## 残留风险
- 本结果由 mock worker 产出，仅用于端到端验证
`;
  const resultMdPath = atomicWriteWorkerArtifact(workDir, 'result.md', resultMd);

  const resultJson = {
    status: 'success',
    worker: AGENT_ID,
    backend: 'mock',
    model: 'mock',
    returncode: 0,
    verify_results: (task.verify ?? []).map((v: any) => ({ cmd: v.cmd, exit_code: 0, passed: true })),
    changed_files: [],
    duration_seconds: 0.1,
  };
  const resultJsonPath = atomicWriteWorkerArtifact(
    workDir,
    'result.json',
    JSON.stringify(resultJson, null, 2),
  );

  // report
  progress.advance('reporting', {
    artifactsWritten: true,
    reportStatus: 'done',
    reportDelivery: 'pending',
  });
  const reportRes = await api('/report', {
    method: 'POST',
    body: JSON.stringify({
      task_id: task.task_id,
      agent_id: AGENT_ID,
      claim_token: task.claim_token,
      status: 'done',
      result_path: resultMdPath,
      result_json_path: resultJsonPath,
      verify_results: resultJson.verify_results,
    }),
  });

  if (reportRes.ok) {
    progress.advance('finished', {
      artifactsWritten: true,
      reportStatus: 'done',
      reportDelivery: 'reported',
    });
    console.log(`[mock-worker]   ✓ 完成：${task.task_id}`);
  } else {
    progress.advance('failed', {
      artifactsWritten: true,
      reportStatus: 'done',
      reportDelivery: 'rejected',
      failureReason: 'report_rejected',
    });
    console.error(`[mock-worker]   ✗ report 失败：`, reportRes.error);
  }
  return true;
  } catch (error) {
    const artifactsWritten = existsSync(join(workDir, 'result.md')) && existsSync(join(workDir, 'result.json'));
    progress.advance('failed', {
      artifactsWritten,
      reportStatus: artifactsWritten ? 'done' : undefined,
      reportDelivery: artifactsWritten ? 'unknown' : undefined,
      failureReason: 'worker_exception',
    });
    throw error;
  }
}

async function main() {
  const maxTasks = Number(process.env.BIAO_MAX_TASKS ?? '0'); // 0 = 无限
  await register();

  let count = 0;
  try {
    // 循环消费，直到无任务或达到上限
    while (maxTasks === 0 || count < maxTasks) {
      const got = await runOneTask();
      if (got) {
        count++;
      } else {
        console.log(`[mock-worker] 无更多任务，退出（共完成 ${count} 个）`);
        break;
      }
    }
  } finally {
    await api('/agent/offline', {
      method: 'POST',
      body: JSON.stringify({ agent_id: AGENT_ID, registration_id: registrationId, reason: 'worker_exit' }),
    });
  }
  console.log(`[mock-worker] 总计完成 ${count} 个任务`);
}

main().catch((e) => {
  console.error('[mock-worker] 错误：', e);
  process.exit(1);
});
