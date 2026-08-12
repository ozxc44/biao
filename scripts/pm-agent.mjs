#!/usr/bin/env node
/**
 * 可选的 PM Agent 唤醒器。
 *
 * 这不是服务端推送，也不是 PM 自动化器：每次只主动读取一次 `/intake`，确认有
 * PM 事项才启动一次由用户显式配置的本地命令。它绝不会请求 review / question
 * answer / intake ack，也不会把任务详情、结果、正文或 token 交给子进程。
 *
 * 默认就是一次性模式，适合 cron / launchd。若多个触发器同时运行，同一台机器、
 * 同一 Biao 地址和 PM consumer 只会有一个实例取得本地锁；其余实例安静退出。
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const EXIT_CONFIG = 3;
const EXIT_UNHANDLED = 4;
const DEFAULT_BIAO_URL = 'http://127.0.0.1:7331';
const DEFAULT_CONSUMER = 'pm';
const PM_ACTIONABLE_KINDS = new Set([
  'review_requested',
  'acceptance_ready',
  'question_asked',
  'resolution_required',
  // 兼容未来服务把 resolution 状态直接投影为 kind 的版本。
  'needs_pm_decision',
  'failed',
  'blocked',
  // 服务端只会把仍持有 running task 的 stale agent 投影到 intake；普通 idle/stale
  // 注册已在服务端过滤，不能由唤醒器重新制造 PM 噪声。
  'stale_agent',
]);

function usage() {
  console.log(`Biao PM Agent 唤醒器（一次性、被动平台适配）

用法：
  node scripts/pm-agent.mjs [--once] [--require-drained] [--biao-url URL] [--consumer PM]
                            [--plans p1,p2] [--command 'agent command']

配置：
  BIAO_PM_AGENT_CMD='agent command'   # 有 PM 事项时唯一允许启动的命令
  BIAO_URL=http://127.0.0.1:7331
  BIAO_PM_CONSUMER=pm
  BIAO_API_TOKEN=...                  # 仅用于本脚本读取 intake，不会传给子进程
  BIAO_PM_AGENT_LOCK_DIR=/tmp/...     # 可选本机锁目录

行为：
  - 无事项：成功且静默，不启动任何 Agent。
  - 有事项：只向命令 stdin 传最小汇总 JSON；Agent 必须自行回平台读取详情，
    完成实际处理后才能自行 ack。
  - --require-drained：命令退出后再次读取 intake；仍有事项则返回退出码 4，供共享
    Supervisor 下轮重试。该检查不自动 review、answer 或 ack。
  - 本脚本从不自动 review、answer 或 ack。`);
}

function fail(message) {
  const error = new Error(message);
  error.exitCode = EXIT_CONFIG;
  throw error;
}

function readOptions(argv) {
  const values = new Map();
  const planValues = [];
  const valueFlags = new Set(['--biao-url', '--consumer', '--plans', '--plan', '--command', '--lock-dir']);

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once' || arg === '--require-drained') continue;
    if (!valueFlags.has(arg)) fail(`未知参数：${arg}（使用 --help 查看用法）`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${arg} 需要一个值`);
    index++;
    if (arg === '--plans' || arg === '--plan') {
      planValues.push(value);
    } else if (values.has(arg)) {
      fail(`${arg} 只能指定一次`);
    } else {
      values.set(arg, value);
    }
  }

  const rawUrl = values.get('--biao-url') ?? process.env.BIAO_URL ?? DEFAULT_BIAO_URL;
  const biaoUrl = normalizeBiaoUrl(rawUrl);
  const consumer = (values.get('--consumer') ?? process.env.BIAO_PM_CONSUMER ?? DEFAULT_CONSUMER).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(consumer)) fail('consumer 名称非法（仅允许字母、数字、点、下划线和连字符）');

  const planIds = [...new Set(planValues
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
  const command = (values.get('--command') ?? process.env.BIAO_PM_AGENT_CMD ?? '').trim();
  const lockDir = (values.get('--lock-dir') ?? process.env.BIAO_PM_AGENT_LOCK_DIR ?? tmpdir()).trim();
  if (!lockDir) fail('锁目录不能为空');

  return {
    biaoUrl,
    consumer,
    planIds,
    command,
    lockDir,
    requireDrained: argv.includes('--require-drained'),
  };
}

function normalizeBiaoUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('Biao URL 无法解析');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('Biao URL 只允许 http 或 https');
  // URL 中的凭据、查询和 hash 很容易把敏感信息带入子进程的最小唤醒 JSON，直接拒绝。
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail('Biao URL 不得包含凭据、查询参数或 hash');
  return parsed.toString().replace(/\/$/, '');
}

function lockPath(biaoUrl, consumer, lockDir) {
  const key = createHash('sha256')
    .update(`${canonicalEndpoint(biaoUrl)}\u0000${consumer}`)
    .digest('hex')
    .slice(0, 24);
  return join(lockDir, `biao-pm-agent-${key}.lock`);
}

function canonicalEndpoint(biaoUrl) {
  const parsed = new URL(biaoUrl);
  let host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || host === '::1') host = '127.0.0.1';
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return `${parsed.protocol}//${host}:${port}`;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 `wx` 实现本机原子锁；释放时校验 owner，避免旧进程误删后来者的锁。
 * 死 pid 的锁会由下一次触发安全接管；写入中的/损坏的锁一律保守地当作正在运行。
 */
function acquireLock(biaoUrl, consumer, lockDir) {
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const path = lockPath(biaoUrl, consumer, lockDir);
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID(), startedAt: Date.now() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, owner, 'utf8');
      } finally {
        closeSync(fd);
      }
      return { acquired: true, path, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let raw;
      try {
        raw = readFileSync(path, 'utf8').trim();
      } catch {
        continue;
      }
      let holder;
      try {
        holder = JSON.parse(raw);
      } catch {
        return { acquired: false, path };
      }
      if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0 || processIsAlive(holder.pid)) {
        return { acquired: false, path };
      }
      try {
        // 只删除刚才确认的死锁内容；并发接管者写入的新内容不会被删除。
        if (readFileSync(path, 'utf8').trim() === raw) unlinkSync(path);
      } catch {
        // 下一次 wx 会再次判断；绝不覆盖未知锁。
      }
    }
  }
  return { acquired: false, path };
}

function releaseLock(lock) {
  if (!lock.acquired) return;
  try {
    if (readFileSync(lock.path, 'utf8').trim() === lock.owner) unlinkSync(lock.path);
  } catch {
    // 已清理或被安全接管均无需报错。
  }
}

async function readIntake({ biaoUrl, consumer }) {
  const headers = { Accept: 'application/json' };
  const apiToken = process.env.BIAO_API_TOKEN;
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  let response;
  try {
    response = await fetch(`${biaoUrl}/intake?consumer=${encodeURIComponent(consumer)}`, { headers });
  } catch {
    throw new Error('读取 Biao PM intake 失败：无法连接服务');
  }
  if (!response.ok) throw new Error(`读取 Biao PM intake 失败：HTTP_${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('读取 Biao PM intake 失败：响应不是 JSON');
  }
  if (payload?.ok === false || !payload || typeof payload !== 'object') {
    throw new Error('读取 Biao PM intake 失败：服务未返回可用数据');
  }
  const data = payload.data ?? payload;
  return Array.isArray(data?.items) ? data.items : [];
}

/** 只保留 kind / plan_id 两个最小定位字段；任何正文、结果和 token 都在这里丢弃。 */
function summarizeActionable(items, planIds) {
  const selectedPlans = planIds.length > 0 ? new Set(planIds) : undefined;
  const kinds = new Map();
  let count = 0;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    // 历史 repair 排队不应唤醒 PM；只有真正要求 PM 决策的 resolution 才会出现在 intake。
    if (!PM_ACTIONABLE_KINDS.has(kind) || (kind === 'resolution_required' && item.resolution_action === 'repair')) continue;
    const planId = typeof item.plan_id === 'string' ? item.plan_id : '';
    // 服务端仍可接收 plan_id 过滤；这里故意不传，确保多 plan 情形只有一次低成本读取，
    // 并在客户端做精确且可预测的范围过滤。
    if (selectedPlans && !selectedPlans.has(planId)) continue;
    count++;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  return {
    count,
    kinds: Object.fromEntries([...kinds.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function childEnvironment() {
  // 默认不继承父进程的凭据。PM Agent 应使用自己的本地凭据/配置，在收到门铃后自行
  // 回平台读取详情；这也保证 BIAO_API_TOKEN 不会跨进程泄露。
  const safeKeys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  ];
  const env = {};
  for (const key of safeKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.BIAO_PM_AGENT_WAKE = '1';
  env.BIAO_PM_AGENT_FETCH_DETAILS = 'required';
  env.BIAO_PM_AGENT_ACK = 'only_after_actual_handling';
  env.BIAO_PM_AGENT_AUTOMATION = 'forbidden';
  env.BIAO_PM_AGENT_INSTRUCTIONS = 'Read details from Biao yourself; process only the scoped PM items; only ack after actual handling; never auto-review, auto-answer, or auto-ack because of this wake.';
  return env;
}

async function invokeAgent(command, payload) {
  await new Promise((resolve, reject) => {
    // command 是本机用户显式提供的启动命令；shell 只用于支持带参数的命令字符串，
    // 绝不把来自 Biao 的字段拼入命令行。
    const child = spawn(command, [], {
      shell: true,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: childEnvironment(),
    });
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once('error', (error) => settle(reject, error));
    child.once('close', (code, signal) => {
      if (code === 0) settle(resolve);
      else settle(reject, new Error(signal
        ? `PM Agent 命令被信号 ${signal} 终止`
        : `PM Agent 命令退出码为 ${code ?? 'unknown'}`));
    });
    child.stdin.once('error', (error) => settle(reject, error));
    // 唯一跨进程数据：允许的五个字段；绝不含 task/event/result/body/token。
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const options = readOptions(argv);
  const lock = acquireLock(options.biaoUrl, options.consumer, options.lockDir);
  if (!lock.acquired) return 0;

  try {
    const items = await readIntake(options);
    const summary = summarizeActionable(items, options.planIds);
    if (summary.count === 0) return 0;
    if (!options.command) {
      console.error('发现 PM 待处理事项，但未配置 PM Agent 命令；请设置 BIAO_PM_AGENT_CMD 或传入 --command。');
      return EXIT_CONFIG;
    }

    const wakePayload = {
      biaoUrl: options.biaoUrl,
      consumer: options.consumer,
      planIds: options.planIds,
      kinds: summary.kinds,
      count: summary.count,
    };
    await invokeAgent(options.command, wakePayload);
    if (options.requireDrained) {
      const remaining = summarizeActionable(await readIntake(options), options.planIds);
      if (remaining.count > 0) {
        console.error(`[pm-agent] PM Agent 已退出，但仍未处理 ${remaining.count} 个待办；共享 Supervisor 将在下轮重试。`);
        return EXIT_UNHANDLED;
      }
    }
    console.log(`[pm-agent] 已唤醒 PM Agent：kinds=${Object.keys(summary.kinds).join(',')} count=${summary.count}（详情须由 Agent 回平台读取）`);
    return 0;
  } finally {
    releaseLock(lock);
  }
}

main()
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((error) => {
    console.error(`[pm-agent] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
