#!/usr/bin/env node
/**
 * Biao 本机 Supervisor 生产入口。
 *
 * 一个进程、一个本机锁、一个被动 transport 轮次和一个共享 Worker 调度器：
 * - PM 只收到最小门铃；绝不自动 ack/review/answer；PM 自己取详情并显式处置。
 * - idle Worker slot 没有独立 timer/claim poll；每个共享轮次至多一次 presence heartbeat。
 * - running slot 由 Worker 自己维护任务 heartbeat/lease；同一状态变化只触发一轮共享 claim。
 * - 所有受管 plan 闭环后自动退出；下次启动重新发现 reset/reject/new task。
 * - 平台只是事件/状态中枢，不会被此脚本反向变成常驻服务端。
 *
 * 需要 Worker slot 时传 JSON：
 * BIAO_WORKER_SLOTS='[{"kind":"codex","agentId":"codex-a","project":"/repo"}]'
 * 或 --worker-slots <json-file>。没有 slot 时脚本只是 PM 门铃。
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BiaoSupervisorRuntime,
  releaseLocalLock,
  tryAcquireLocalLock,
} from '../dist/worker/supervisor.js';
import { createCodexWorkerConfig } from '../dist/worker/codex.js';
import { createKimiWorkerConfig } from '../dist/worker/kimi.js';
import { createCliWorkerConfig } from '../dist/worker/cli.js';

const DEFAULT_URL = process.env.BIAO_URL ?? 'http://127.0.0.1:7331';
const DEFAULT_CONSUMER = process.env.BIAO_PM_CONSUMER ?? 'pm';
const DEFAULT_LOCK_DIR = process.env.BIAO_LOCK_DIR ?? (await import('node:os')).tmpdir();

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}
function usage() {
  console.log(`Biao Supervisor（被动 PM 门铃 + 可选共享 Worker 调度）

用法：
  node scripts/supervisor.mjs [--once] [--biao-url URL] [--consumer PM] [--plans p1,p2] [--interval seconds]
                              [--pm-agent-command 'agent command']
  node scripts/supervisor.mjs --worker-slots slots.json

说明：一个本机锁和一个低频主循环管理全部 slot；空闲 slot 每个共享轮次至多发送一次
presence heartbeat，不创建独立 timer 或 claim poll；running slot 由 Worker 维护任务心跳。
配置 --pm-agent-command 或 BIAO_PM_AGENT_CMD 后，PM 门铃会在同一个共享 Supervisor
内按需启动一次 PM Agent，不需要第二个 cron/launchd 轮询器。命令退出后若事项仍在，
下轮会重试。不会自动 ack、review 或 answer；处理完成后由 PM 明确执行：
  biao pm ack --consumer <PM> --event-id <ID>

所有受管 plan 闭环后进程自动退出。

Worker slot JSON：
  [{"kind":"codex","agentId":"codex-a","project":"/absolute/project","types":["code","review"]}]
支持 kind=codex|kimi|custom（兼容 cli）。custom/cli slot 需传 command 或配置 BIAO_EXEC_CMD。`);
}
if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

const biaoUrl = flag('biao-url') ?? DEFAULT_URL;
const consumer = flag('consumer') ?? DEFAULT_CONSUMER;
const once = args.includes('--once');
const intervalSeconds = Number(flag('interval') ?? process.env.BIAO_SUPERVISOR_INTERVAL ?? '60');
const planIds = (flag('plans') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const slotsPath = flag('worker-slots');
const pmAgentCommand = flag('pm-agent-command') ?? process.env.BIAO_PM_AGENT_CMD ?? '';
let pmWakeFailed = false;
let receivedSignal;
let activePmAgent;
let forceKillTimer;

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

function signalPmAgentTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      console.error(`[supervisor] 无法用 ${signal} 停止 PM Agent：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stopActivePmAgent(signal = 'SIGTERM') {
  const child = activePmAgent;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalPmAgentTree(child, signal);
  if (signal === 'SIGKILL') return;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    if (activePmAgent === child && child.exitCode === null && child.signalCode === null) {
      signalPmAgentTree(child, 'SIGKILL');
    }
  }, 1_000);
  forceKillTimer.unref();
}

function clearActivePmAgent(child) {
  if (activePmAgent !== child) return;
  activePmAgent = undefined;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  forceKillTimer = undefined;
}

/**
 * 在当前共享 Supervisor 的门铃回调中运行一次无状态 PM Agent 适配器。
 * 适配器自己只读 intake，并以 --require-drained 证明事项真的被处理；返回 false 时
 * Supervisor 撤销本机去重预留，下个低频共享轮次再试。
 */
async function wakePmAgent(planId) {
  if (!pmAgentCommand.trim()) return undefined;
  if (receivedSignal) return false;
  if (activePmAgent && activePmAgent.exitCode === null && activePmAgent.signalCode === null) {
    console.error('[supervisor] 上一次 PM Agent 尚未退出，本轮不重复启动。');
    return false;
  }
  const pmAgentScript = resolve(import.meta.dirname, 'pm-agent.mjs');
  const args = [
    pmAgentScript,
    '--once',
    '--require-drained',
    '--biao-url', biaoUrl,
    '--consumer', consumer,
    '--plans', planId,
  ];
  const env = { ...process.env, BIAO_PM_AGENT_CMD: pmAgentCommand };
  return new Promise((resolveWake) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env,
      // POSIX 下独立进程组让 signal 能覆盖 pm-agent -> shell -> Codex 整棵树，
      // 避免只杀父进程后留下孤儿 Agent。Windows 则回退到 child.kill。
      detached: process.platform !== 'win32',
    });
    activePmAgent = child;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearActivePmAgent(child);
      resolveWake(ok);
    };
    child.once('error', (error) => {
      console.error(`[supervisor] PM Agent 无法启动：${error instanceof Error ? error.message : String(error)}`);
      finish(false);
    });
    child.once('close', (code, signal) => {
      if (receivedSignal) {
        finish(false);
        return;
      }
      if (code === 0) finish(true);
      else {
        const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? 'unknown'}`;
        console.error(`[supervisor] PM Agent 未完成事项（${reason}），下个共享轮次重试。`);
        finish(false);
      }
    });
  });
}

async function requestedPlansAreTerminal() {
  if (planIds.length === 0) return true;
  const headers = { Accept: 'application/json' };
  if (process.env.BIAO_API_TOKEN) headers.Authorization = `Bearer ${process.env.BIAO_API_TOKEN}`;
  let response;
  try {
    response = await fetch(`${biaoUrl}/plans`, { headers });
  } catch {
    throw new Error('无法复核受管 plan 的最终状态：Biao 服务不可达');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('无法复核受管 plan 的最终状态：/plans 响应不是 JSON');
  }
  if (!response.ok || payload?.ok === false || !Array.isArray(payload?.data?.plans)) {
    throw new Error(`无法复核受管 plan 的最终状态：${payload?.error?.code ?? `HTTP_${response.status}`}`);
  }
  const snapshots = new Map(payload.data.plans.map((plan) => [plan.plan_id, plan]));
  const missing = planIds.filter((planId) => !snapshots.has(planId));
  if (missing.length > 0) {
    throw new Error(`显式指定的受管 plan 不存在或未返回：${missing.join(', ')}`);
  }
  return planIds.every((planId) => ['completed', 'cancelled'].includes(snapshots.get(planId)?.status));
}

function parseSlots() {
  const raw = slotsPath
    ? readFileSync(resolve(slotsPath), 'utf8')
    : process.env.BIAO_WORKER_SLOTS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Worker slot JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Worker slot JSON 必须是数组');
  const agentIds = new Set();
  return parsed.map((slot, index) => {
    const agentId = typeof slot?.agentId === 'string' ? slot.agentId.trim() : '';
    if (!slot || typeof slot !== 'object' || !['codex', 'kimi', 'custom', 'cli'].includes(slot.kind) || !agentId) {
      throw new Error(`第 ${index + 1} 个 Worker slot 必须有 kind=codex|kimi|custom（兼容 cli）和非空 agentId`);
    }
    if (agentIds.has(agentId)) {
      throw new Error(`Worker slot 的 agentId 重复：${agentId}（第 ${index + 1} 个 slot）`);
    }
    agentIds.add(agentId);
    if (slot.project !== undefined && (typeof slot.project !== 'string' || !slot.project.startsWith('/'))) {
      throw new Error(`第 ${index + 1} 个 Worker slot 的 project 必须是绝对路径`);
    }
    const baseOptions = {
      agentId,
      preferredProject: slot.project ?? process.env.BIAO_PREFERRED_PROJECT,
      capabilities: Array.isArray(slot.capabilities) ? slot.capabilities : undefined,
    };
    const config = slot.kind === 'codex'
      ? createCodexWorkerConfig(baseOptions)
      : slot.kind === 'kimi'
        ? createKimiWorkerConfig({ ...baseOptions, kimiBin: slot.kimiBin, kimiModel: slot.kimiModel })
        : createCliWorkerConfig({ ...baseOptions, execCmd: slot.command, model: slot.model });
    return {
      agentId: config.agentId,
      agentType: config.agentType,
      preferredProject: config.preferredProject,
      capabilities: config.capabilities,
      preferredTypes: Array.isArray(slot.types) ? slot.types : undefined,
      heartbeatMs: config.heartbeatMs,
      execute: config.execute,
    };
  });
}

const handle = tryAcquireLocalLock(biaoUrl, DEFAULT_LOCK_DIR);
if (!handle.acquired) {
  console.error(`[supervisor] 已有本机实例在运行：${handle.reason ?? handle.path}`);
  process.exit(0);
}

const shutdown = new AbortController();
const stop = (signal) => {
  if (receivedSignal) {
    stopActivePmAgent('SIGKILL');
    return;
  }
  receivedSignal = signal;
  console.error(`[supervisor] 收到 ${signal}，正在停止监视并终止运行中的 PM Agent。`);
  shutdown.abort();
  stopActivePmAgent('SIGTERM');
};
const onSigint = () => stop('SIGINT');
const onSigterm = () => stop('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

try {
  const slots = parseSlots();
  const intervalMs = Math.max(10_000, Number.isFinite(intervalSeconds) ? intervalSeconds * 1000 : 60_000);
  const runtime = new BiaoSupervisorRuntime({
    biaoUrl,
    consumer,
    planIds,
    apiToken: process.env.BIAO_API_TOKEN,
    workers: slots,
    pollIntervalMs: intervalMs,
    signal: shutdown.signal,
    onPmDoorbell: async (planId, items) => {
      const kinds = [...new Set(items.map((item) => item.kind))].join(',');
      // 监视器只负责低噪声提醒；不展开 task/question/event ID，避免把一个历史批次
      // 刷成终端日志。PM 需要详情时再主动从平台读取。
      console.log(`[biao] PM 门铃 plan=${planId} kinds=${kinds} count=${items.length}（详情请到平台查看）`);
      const handled = await wakePmAgent(planId);
      if (handled === false) pmWakeFailed = true;
      return handled;
    },
    onError: (message) => console.error(`[supervisor] ${message}`),
  });
  if (once) {
    const active = await runtime.runOnce();
    process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : pmWakeFailed ? 4 : active ? 0 : 2;
  } else {
    console.log(`[supervisor] 运行：consumer=${consumer}，slots=${slots.length}，间隔上限=${Math.round(intervalMs / 1000)}s（PM 事件不会自动 ack）`);
    let terminalDrained = false;
    while (!shutdown.signal.aborted) {
      await runtime.run();
      if (shutdown.signal.aborted) break;
      terminalDrained = await requestedPlansAreTerminal();
      if (terminalDrained) break;
      // 最后一轮与复核之间出现 reset/reject/new task，重新进入同一被动运行时。
    }
    if (receivedSignal) process.exitCode = signalExitCode(receivedSignal);
    else if (terminalDrained) console.log('[supervisor] 所有受管项目已完成并验收，已停止监视。');
  }
} catch (error) {
  console.error(`[supervisor] 启动/运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
} finally {
  stopActivePmAgent('SIGTERM');
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  releaseLocalLock(handle);
}
