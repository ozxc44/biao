#!/usr/bin/env node
/**
 * Biao 新 Agent 一站式加入脚本。
 *
 * 一条命令完成：校验连通性 → 注册 Agent（含自动绑定）→ 派生 Worker Token → 写入本机 .env。
 * 纯 Node 标准库，零新依赖。
 */

import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const WORKER_TOKEN_CONTEXT = 'biao-worker-api-token-v1';
const DEFAULT_BIAO_URL = 'http://127.0.0.1:7331';

export function usage() {
  return `Biao 新 Agent 一站式加入

用法：
  biao-agent-join --agent-id <id> --agent-type <type> [选项]

必填：
  --agent-id <id>          Agent 唯一标识符（如 codex-1、kimi-prod）
  --agent-type <type>      Agent 适配器类型（如 codex、kimi、glm）

可选：
  --project-scope <path>   要加入的项目绝对路径（可多次指定）
  --capabilities <list>    能力标签，逗号分隔（如 code,review）
  --wake-mode <mode>       唤醒模式：external_worker | visible_session | background_executor
                           默认 external_worker
  --policy <policy>        绑定策略：automatic | on_demand | manual
                           默认 automatic
  --biao-url <url>         Biao 服务地址，默认 ${DEFAULT_BIAO_URL}
  --runtime-dir <dir>      运行时目录，默认 \$BIAO_RUNTIME_DIR 或 .biao
  --dry-run                只打印将执行的动作，不实际写入

环境变量：
  BIAO_URL                 等价 --biao-url
  BIAO_API_TOKEN           等价 Owner API Token（必填，用于注册和派生 Worker Token）
  BIAO_RUNTIME_DIR         等价 --runtime-dir

安全说明：
  Worker Token 由 Owner Token 单向 HMAC 派生，不存储第二套密钥。
  轮换 Owner Token 后 Worker Token 同步失效。`;
}

function fail(message) {
  console.error(`[biao-agent-join] 错误：${message}`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const args = {
    agentId: '',
    agentType: '',
    projectScopes: [],
    capabilities: '',
    wakeMode: 'external_worker',
    policy: 'automatic',
    biaoUrl: '',
    runtimeDir: '',
    dryRun: false,
  };

  const valueFlags = new Set([
    '--agent-id', '--agent-type', '--project-scope', '--capabilities',
    '--wake-mode', '--policy', '--biao-url', '--runtime-dir',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (!valueFlags.has(arg)) {
      throw new Error(`未知参数：${arg}（使用 --help 查看用法）`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} 需要一个值`);
    }
    i++;
    switch (arg) {
      case '--agent-id': args.agentId = value; break;
      case '--agent-type': args.agentType = value; break;
      case '--project-scope': args.projectScopes.push(value); break;
      case '--capabilities': args.capabilities = value; break;
      case '--wake-mode': args.wakeMode = value; break;
      case '--policy': args.policy = value; break;
      case '--biao-url': args.biaoUrl = value; break;
      case '--runtime-dir': args.runtimeDir = value; break;
    }
  }

  args.biaoUrl = args.biaoUrl || process.env.BIAO_URL || DEFAULT_BIAO_URL;
  args.runtimeDir = args.runtimeDir || process.env.BIAO_RUNTIME_DIR || '.biao';

  if (!args.agentId) throw new Error('--agent-id 必填');
  if (!args.agentType) throw new Error('--agent-type 必填');

  const safeId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
  if (!safeId.test(args.agentId)) throw new Error('--agent-id 格式无效（需匹配 ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$）');
  if (!safeId.test(args.agentType)) throw new Error('--agent-type 格式无效');

  if (!['external_worker', 'visible_session', 'background_executor'].includes(args.wakeMode)) {
    throw new Error('--wake-mode 无效，可选：external_worker | visible_session | background_executor');
  }
  if (!['automatic', 'on_demand', 'manual'].includes(args.policy)) {
    throw new Error('--policy 无效，可选：automatic | on_demand | manual');
  }

  for (const scope of args.projectScopes) {
    if (!isAbsolute(scope)) throw new Error(`--project-scope 必须是绝对路径：${scope}`);
  }

  return args;
}

/** 派生 Worker Token（与 src/server/http.ts 的 deriveWorkerApiToken 一致） */
function deriveWorkerToken(ownerToken) {
  return createHmac('sha256', ownerToken).update(WORKER_TOKEN_CONTEXT).digest('hex');
}

async function fetchJson(url, options = {}) {
  const { method = 'GET', body, token } = options;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const apiToken = process.env.BIAO_API_TOKEN;

  // ---- dry-run 模式 ----
  if (args.dryRun) {
    console.log('[biao-agent-join] dry-run 模式，以下为将执行的动作：\n');
    console.log(`  1. 校验 ${args.biaoUrl}/health 连通性`);
    console.log(`  2. POST ${args.biaoUrl}/register`);
    console.log(`     agent_id:      ${args.agentId}`);
    console.log(`     agent_type:    ${args.agentType}`);
    if (args.capabilities) console.log(`     capabilities:  ${args.capabilities}`);
    if (args.projectScopes.length > 0) {
      console.log(`     project_bindings:`);
      for (const scope of args.projectScopes) {
        console.log(`       - project_scope: ${scope}`);
        console.log(`         wake_mode:     ${args.wakeMode}`);
        console.log(`         policy:        ${args.policy}`);
      }
    }
    const runtimeDir = args.runtimeDir.startsWith('/') ? args.runtimeDir : join(process.cwd(), args.runtimeDir);
    const envPath = join(runtimeDir, 'agents', `${args.agentId}.env`);
    console.log(`  3. 派生 Worker Token（HMAC-SHA256）`);
    console.log(`  4. 写入 ${envPath}（权限 0600）`);
    console.log(`  5. 输出下一步指引`);
    console.log('\n[dry-run] 完成。实际执行请去掉 --dry-run 并设置 BIAO_API_TOKEN。');
    return 0;
  }

  // ---- 校验 Token ----
  if (!apiToken) {
    fail('环境变量 BIAO_API_TOKEN 未设置。请设置 Owner API Token。');
    return 2;
  }

  // ---- 校验连通性 ----
  console.log(`[biao-agent-join] 校验 ${args.biaoUrl} 连通性...`);
  let health;
  try {
    health = await fetchJson(`${args.biaoUrl}/health`);
  } catch (error) {
    fail(`无法连接 Biao 服务：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (health.status !== 200 || !health.json?.ok) {
    fail(`Biao 服务不可用：${JSON.stringify(health.json)}`);
    return 2;
  }
  console.log('[biao-agent-join] 服务可达，Redis 已连接。');

  // ---- 注册 + 自动绑定 ----
  console.log(`[biao-agent-join] 注册 Agent ${args.agentId}...`);
  const registerBody = {
    agent_id: args.agentId,
    agent_type: args.agentType,
    ...(args.capabilities ? { capabilities: args.capabilities.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(args.projectScopes.length > 0 ? {
      project_bindings: args.projectScopes.map((scope) => ({
        project_scope: scope,
        wake_mode: args.wakeMode,
        policy: args.policy,
      })),
    } : {}),
  };

  let registerResult;
  try {
    registerResult = await fetchJson(`${args.biaoUrl}/register`, {
      method: 'POST',
      body: registerBody,
      token: apiToken,
    });
  } catch (error) {
    fail(`注册请求失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (!registerResult.json?.ok) {
    fail(`注册失败：${registerResult.json?.error?.message ?? JSON.stringify(registerResult.json)}`);
    return 2;
  }

  const regData = registerResult.json.data;
  console.log(`[biao-agent-join] 注册成功：registration_id=${regData.registration_id}`);

  // 打印绑定结果
  if (regData.project_binding_results) {
    for (const br of regData.project_binding_results) {
      if (br.ok) {
        console.log(`[biao-agent-join]   绑定 ${br.project_scope} → ${br.binding?.binding_id} (${br.binding?.wake_mode}/${br.binding?.policy})`);
      } else {
        console.warn(`[biao-agent-join]   绑定 ${br.project_scope} 失败：${br.error}`);
      }
    }
  }

  // ---- 派生 Worker Token ----
  const workerToken = deriveWorkerToken(apiToken);

  // ---- 写入 .env ----
  const runtimeDir = isAbsolute(args.runtimeDir) ? args.runtimeDir : join(process.cwd(), args.runtimeDir);
  const agentsDir = join(runtimeDir, 'agents');
  const envPath = join(agentsDir, `${args.agentId}.env`);

  mkdirSync(agentsDir, { recursive: true });

  const envContent = [
    `# Biao Agent 环境（由 biao-agent-join 自动生成）`,
    `# 生成时间：${new Date().toISOString()}`,
    `BIAO_URL=${args.biaoUrl}`,
    `BIAO_AGENT_ID=${args.agentId}`,
    `BIAO_AGENT_TYPE=${args.agentType}`,
    `BIAO_WORKER_TOKEN=${workerToken}`,
    `BIAO_REGISTRATION_ID=${regData.registration_id}`,
    '',
  ].join('\n');

  writeFileSync(envPath, envContent, { mode: 0o600 });
  console.log(`[biao-agent-join] 环境文件已写入：${envPath}（权限 0600）`);

  // ---- 输出指引 ----
  console.log('\n[biao-agent-join] 加入完成！下一步：');
  console.log(`  1. 在 Supervisor 配置中注册唤醒 slot（如尚未配置）：`);
  console.log(`     biao-supervisor-config worker add --slot <slot-id> --kind ${args.agentType} --command <适配器脚本路径>`);
  console.log(`  2. 编写唤醒适配器脚本（参考 biao-adapter-kit scaffold --role project-agent --mode ${args.wakeMode}）`);
  console.log(`  3. 启动 Supervisor：.biao/supervisor`);
  console.log(`  4. 平台会自动通过 agent_id=${args.agentId} 匹配唤醒你的 Agent`);
  console.log(`\n安全提醒：Worker Token 由 Owner Token 派生，轮换 Owner Token 后需重新 join。`);

  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
