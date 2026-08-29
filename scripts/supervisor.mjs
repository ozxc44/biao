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

import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPmActionableItem } from './pm-actionable.mjs';
import { ensureAgentProtocolBlock } from './agent-protocol.mjs';
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

function deriveWorkerApiToken(ownerToken) {
  return ownerToken
    ? createHmac('sha256', ownerToken).update('biao-worker-api-token-v1').digest('hex')
    : undefined;
}

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}
/** 留守等待：可被 SIGINT/SIGTERM 立即打断，不拖慢正常停止路径。 */
function sleepInterruptible(ms, signal) {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolveWait();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function usage() {
  console.log(`Biao Supervisor（被动 PM 门铃 + 可选共享 Worker 调度）

用法：
  node scripts/supervisor.mjs [--once] [--biao-url URL] [--consumer PM] [--plans p1,p2] [--interval seconds]
                              [--pm-agent-command 'agent command'] [--max-concurrent-tasks N]
  node scripts/supervisor.mjs [--pm-slots pm-slots.json] [--worker-slots worker-slots.json]

说明：一个本机锁和一个低频主循环管理全部 slot；空闲 slot 每个共享轮次至多发送一次
presence heartbeat，不创建独立 timer 或 claim poll；running slot 由 Worker 维护任务心跳。
配置 --pm-agent-command 或 BIAO_PM_AGENT_CMD 后，PM 门铃会在同一个共享 Supervisor
内按需启动一次 PM Agent，不需要第二个 cron/launchd 轮询器。命令退出后若事项仍在，
下轮会重试。不会自动 ack、review 或 answer；处理完成后由 PM 明确执行：
  biao pm ack --consumer <PM> --event-id <ID>

多个 Plan 由不同 PM 负责时，使用本机 BIAO_PM_AGENT_ROUTES JSON：
  {"plan-a":{"command":"/abs/codex-pm-agent","target":"thread-id"},
   "plan-b":{"command":"/abs/kimi-pm-adapter","target":"session-id"}}
精确 Plan 路由优先于全局 BIAO_PM_AGENT_CMD；`*` 可作本机默认路由。target 只以
BIAO_PM_TARGET 传给适配器，不进入门铃正文或 Biao 服务端状态。

多个 PM 像 Worker 一样加入同一个 Supervisor 时，使用 BIAO_PM_SLOTS JSON 或
--pm-slots 文件；每个 id/consumer 必须唯一，可按 plans/kinds 限定自己的待办队列：
  [{"id":"review-pm","consumer":"pm-review","plans":["plan-a"],
    "kinds":["review_requested"],"command":"/abs/pm-adapter","target":"session-id"}]
slot 未写 command/target 时继承对应 Plan route，再回退到全局 PM Agent 配置。

所有受管 plan 闭环后进程自动退出。加 --stay-resident（或在 config.env 设
BIAO_SUPERVISOR_STAY_RESIDENT=1）后转为低频留守：闭环不退出，新计划/reset/reject
在下一轮自动重新进入调度，不留发现空窗。

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
// 并发闸：限制同时执行的真实任务数（slot 多于机器并发能力时使用）；不传则不限制。
const maxConcurrentTasksRaw = flag('max-concurrent-tasks') ?? process.env.BIAO_MAX_CONCURRENT_TASKS;
const maxConcurrentTasks = maxConcurrentTasksRaw === undefined || `${maxConcurrentTasksRaw}`.trim() === ''
  ? undefined
  : Number(maxConcurrentTasksRaw);
if (maxConcurrentTasks !== undefined && (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) {
  console.error('[supervisor] --max-concurrent-tasks / BIAO_MAX_CONCURRENT_TASKS 必须是正整数。');
  process.exit(2);
}
// 留守模式：全部受管计划闭环后不退出进程，按共享间隔低频复查新计划，
// 消除“闭环退出 → 等待外部重启才发现新计划”的空窗。--once 模式下无意义。
const stayResident = !once && (args.includes('--stay-resident')
  || /^(1|true|yes)$/i.test(process.env.BIAO_SUPERVISOR_STAY_RESIDENT ?? ''));
const slotsPath = flag('worker-slots');
const pmSlotsPath = flag('pm-slots');
const defaultPmAgentCommand = flag('pm-agent-command') ?? process.env.BIAO_PM_AGENT_CMD ?? '';
let pmWakeFailed = false;
let receivedSignal;
const activePmAgents = new Map();
// SIGTERM 后给 PM Agent 留出的自行回收窗口：pm-agent 收到信号后要自行杀掉
// adapter 进程组（含 Codex/Kimi 等后代）。窗口过短时，加载中的机器来不及执行
// pm-agent 的信号处理器，SIGKILL 会把整棵 adapter 树打成永久孤儿。
const PM_FORCE_KILL_GRACE_MS = 10_000;
// `--once` 需要等待本轮已发出的门铃给出真实退出码，但不能在第一个 slot 上
// 阻塞 runtime 的其余 consumer；否则不同 PM 永远无法并行启动。
const oncePmWakeCompletions = [];
const forceKillTimers = new Map();
const pmDoorbellAttempts = new Map();
const pmRetryCooldownMs = Math.max(
  60_000,
  // 同一逻辑事项没有任何状态变化时，重复唤醒同一个大模型不会产生新证据。
  // 新 task/question/kind 会改变 fingerprint 并立即唤醒；完全相同的未闭环事项
  // 默认一小时才做兜底提醒，避免五分钟一次消耗 PM token。
  Number(process.env.BIAO_PM_RETRY_COOLDOWN_MS ?? '3600000') || 3_600_000,
);
const pmNoProgressRetryMs = Math.max(
  100,
  // --require-drained 的退出码 4 不是普通启动失败，而是“仍有真实待办”。
  // 这类情况需要主动重试；默认一分钟起步并递增退避，既不会只触发一次，
  // 也不会在同一无进展事项上每个轮次都消耗 PM token。
  Number(process.env.BIAO_PM_NO_PROGRESS_RETRY_MS ?? '60000') || 60_000,
);
const pmNoProgressRetryMaxMs = Math.max(
  pmNoProgressRetryMs,
  Number(process.env.BIAO_PM_NO_PROGRESS_RETRY_MAX_MS ?? '3600000') || 3_600_000,
);

function parsePmAgentRoutes(raw) {
  if (!raw?.trim()) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`BIAO_PM_AGENT_ROUTES 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('BIAO_PM_AGENT_ROUTES 必须是以 Plan ID 为键的 JSON 对象');
  }
  const routes = new Map();
  for (const [planId, route] of Object.entries(parsed)) {
    if (planId !== '*' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(planId)) {
      throw new Error(`PM 路由 Plan ID 非法：${planId}`);
    }
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`PM 路由 ${planId} 必须是对象`);
    }
    const unknownKeys = Object.keys(route).filter((key) => !['command', 'target'].includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`PM 路由 ${planId} 含未知字段：${unknownKeys.join(', ')}`);
    }
    const command = typeof route.command === 'string' ? route.command.trim() : '';
    const target = route.target === undefined
      ? undefined
      : typeof route.target === 'string' ? route.target.trim() : '';
    if (!command || command.length > 8_192 || /[\u0000\r\n]/.test(command)) {
      throw new Error(`PM 路由 ${planId} 的 command 必须是单行非空命令（最长 8192）`);
    }
    if (target !== undefined && (!target || target.length > 512 || /[\u0000-\u001f\u007f]/.test(target))) {
      throw new Error(`PM 路由 ${planId} 的 target 必须是非空安全标识（最长 512）`);
    }
    routes.set(planId, { command, target });
  }
  return routes;
}

let pmAgentRoutes;
try {
  pmAgentRoutes = parsePmAgentRoutes(process.env.BIAO_PM_AGENT_ROUTES);
} catch (error) {
  console.error(`[supervisor] PM 路由配置无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

function parsePmSlots() {
  const raw = pmSlotsPath
    ? readFileSync(resolve(pmSlotsPath), 'utf8')
    : process.env.BIAO_PM_SLOTS;
  if (!raw?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PM slot JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('PM slot JSON 必须是数组');
  const ids = new Set();
  const consumers = new Set();
  return parsed.map((slot, index) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      throw new Error(`第 ${index + 1} 个 PM slot 必须是对象`);
    }
    const unknownKeys = Object.keys(slot).filter((key) => !['id', 'consumer', 'plans', 'kinds', 'command', 'target'].includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`第 ${index + 1} 个 PM slot 含未知字段：${unknownKeys.join(', ')}`);
    }
    const id = typeof slot.id === 'string' ? slot.id.trim() : '';
    const slotConsumer = typeof slot.consumer === 'string' ? slot.consumer.trim() : '';
    const safeName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    if (!safeName.test(id)) throw new Error(`第 ${index + 1} 个 PM slot 的 id 非法`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(slotConsumer)) {
      throw new Error(`第 ${index + 1} 个 PM slot 的 consumer 非法`);
    }
    if (ids.has(id)) throw new Error(`PM slot 的 id 重复：${id}`);
    if (consumers.has(slotConsumer)) throw new Error(`PM slot 的 consumer 重复：${slotConsumer}`);
    ids.add(id);
    consumers.add(slotConsumer);

    const parseScopes = (value, field, pattern) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`PM slot ${id} 的 ${field} 必须是非空字符串数组`);
      }
      const values = value.map((entry) => typeof entry === 'string' ? entry.trim() : '');
      if (values.some((entry) => !pattern.test(entry))) {
        throw new Error(`PM slot ${id} 的 ${field} 含非法值`);
      }
      return [...new Set(values)];
    };
    const plans = parseScopes(slot.plans, 'plans', safeName);
    const kinds = parseScopes(slot.kinds, 'kinds', /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/);
    const command = slot.command === undefined
      ? undefined
      : typeof slot.command === 'string' ? slot.command.trim() : '';
    const target = slot.target === undefined
      ? undefined
      : typeof slot.target === 'string' ? slot.target.trim() : '';
    if (command !== undefined && (!command || command.length > 8_192 || /[\u0000\r\n]/.test(command))) {
      throw new Error(`PM slot ${id} 的 command 必须是单行非空命令（最长 8192）`);
    }
    if (target !== undefined && (!target || target.length > 512 || /[\u0000-\u001f\u007f]/.test(target))) {
      throw new Error(`PM slot ${id} 的 target 必须是非空安全标识（最长 512）`);
    }
    return { id, consumer: slotConsumer, plans, kinds, command, target };
  });
}

let pmSlots;
try {
  pmSlots = parsePmSlots();
} catch (error) {
  console.error(`[supervisor] PM slot 配置无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

function resolvePmAgentRoute(planId, slot) {
  const routed = pmAgentRoutes.get(planId) ?? pmAgentRoutes.get('*');
  const command = slot?.command ?? routed?.command ?? defaultPmAgentCommand.trim();
  if (!command) return undefined;
  const target = slot?.target ?? routed?.target ?? (process.env.BIAO_PM_TARGET?.trim() || undefined);
  return { command, target };
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

/**
 * 收集 rootPid 的整棵后代树（按 PPID 递归）。pm-agent 会把 adapter 放在自己的
 * 独立进程组里启动，组信号到不了 adapter 及其孙进程；沿 pid 树补杀才能保证
 * 信号覆盖整棵树，不依赖 pm-agent 的信号处理器代为转发。
 */
function descendantPids(rootPid) {
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  const result = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    let children = [];
    try {
      const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
      children = out.split(/\s+/).filter(Boolean).map(Number)
        .filter((childPid) => Number.isInteger(childPid) && childPid > 0);
    } catch {
      // pgrep 无匹配时以 1 退出；其余错误不阻塞树遍历。
    }
    for (const childPid of children) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      result.push(childPid);
      queue.push(childPid);
    }
  }
  return result;
}

function signalPmAgentTree(slotId, child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
      // 组信号只覆盖 pm-agent 自己的进程组；adapter 以 detached 独立组启动，
      // 必须沿 pid 树逐点补杀，否则 adapter 的孙进程会成为孤儿。
      for (const pid of descendantPids(child.pid)) {
        try {
          process.kill(pid, signal);
        } catch {
          // 已退出或已被组信号回收。
        }
      }
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      console.error(`[supervisor] 无法用 ${signal} 停止 PM slot ${slotId}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function stopActivePmAgent(slotId, signal = 'SIGTERM') {
  const child = activePmAgents.get(slotId);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  signalPmAgentTree(slotId, child, signal);
  if (signal === 'SIGKILL') return;
  const previousTimer = forceKillTimers.get(slotId);
  if (previousTimer) clearTimeout(previousTimer);
  const timer = setTimeout(() => {
    if (activePmAgents.get(slotId) === child && child.exitCode === null && child.signalCode === null) {
      signalPmAgentTree(slotId, child, 'SIGKILL');
    }
  }, PM_FORCE_KILL_GRACE_MS);
  timer.unref();
  forceKillTimers.set(slotId, timer);
}

function stopActivePmAgents(signal = 'SIGTERM') {
  for (const slotId of activePmAgents.keys()) stopActivePmAgent(slotId, signal);
}

async function stopAndDrainActivePmAgents() {
  const waitForActivePmAgents = async (timeoutMs) => {
    const children = [...activePmAgents.values()]
      .filter((child) => child.exitCode === null && child.signalCode === null);
    if (children.length === 0) return;
    const waitForClose = (child) => new Promise((resolveClose) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveClose();
        return;
      }
      child.once('close', resolveClose);
    });
    await Promise.race([
      Promise.all(children.map(waitForClose)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
    ]);
  };

  // 信号路径里 stop() 已经发过一轮 SIGTERM（并为此设置了 force-kill 定时器）；
  // 这里若再补一轮，pm-agent 的 process.once(SIGTERM) 会在第一轮被消费后把
  // SIG_DFL 恢复，紧随其后的第二个 SIGTERM 会在 adapter 组被回收前把
  // pm-agent 直接杀死，导致孙进程失孤。非信号路径（正常闭环退出）才在这里兜底发 SIGTERM。
  if (!receivedSignal) stopActivePmAgents('SIGTERM');
  await waitForActivePmAgents(PM_FORCE_KILL_GRACE_MS + 500);
  if (activePmAgents.size === 0) return;
  stopActivePmAgents('SIGKILL');
  await waitForActivePmAgents(300);
}

function clearActivePmAgent(slotId, child) {
  if (activePmAgents.get(slotId) !== child) return;
  activePmAgents.delete(slotId);
  const timer = forceKillTimers.get(slotId);
  if (timer) clearTimeout(timer);
  forceKillTimers.delete(slotId);
}

/**
 * 在当前共享 Supervisor 的门铃回调中运行一次无状态 PM Agent 适配器。
 * 适配器自己只读 intake，并以 --require-drained 证明事项真的被处理；返回 false 时
 * Supervisor 撤销本机去重预留，下个低频共享轮次再试。
 */
async function wakePmAgent(slot, planId, fingerprint) {
  const route = resolvePmAgentRoute(planId, slot);
  if (!route) return undefined;
  if (receivedSignal) return false;
  const active = activePmAgents.get(slot.id);
  if (active && active.exitCode === null && active.signalCode === null) {
    // 已运行的 PM 已收到门铃。共享轮次必须继续进入 afterRunOnce 调度 Worker，
    // 不能等待 PM 会话结束；但也不能把异步启动误记为永久交付成功。常驻模式
    // 返回 false 只撤销本机 reminder 预留，active/cooldown 仍禁止重复启动模型。
    return once;
  }
  const attemptKey = `${slot.id}\u0000${planId}`;
  const previousAttempt = pmDoorbellAttempts.get(attemptKey);
  if (previousAttempt?.fingerprint === fingerprint && Date.now() < previousAttempt.retryAfter) {
    // 冷却期间保留逻辑事项可重试，但不再次启动模型。这样异步 child 非零退出后，
    // cooldown 到期即可重新投递，而不是因 reminder 已提交而永久只触发一次。
    return once;
  }
  const pmAgentScript = resolve(import.meta.dirname, 'pm-agent.mjs');
  const args = [
    pmAgentScript,
    '--once',
    '--require-drained',
    '--biao-url', biaoUrl,
    '--consumer', slot.consumer,
    '--plans', planId,
  ];
  const env = { ...process.env, BIAO_PM_AGENT_CMD: route.command };
  if (route.target) env.BIAO_PM_TARGET = route.target;
  else delete env.BIAO_PM_TARGET;
  const completion = new Promise((resolveWake) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env,
      // POSIX 下独立进程组让 signal 能覆盖 pm-agent -> shell -> Codex 整棵树，
      // 避免只杀父进程后留下孤儿 Agent。Windows 则回退到 child.kill。
      detached: process.platform !== 'win32',
    });
    activePmAgents.set(slot.id, child);
    pmDoorbellAttempts.set(attemptKey, {
      fingerprint,
      retryAfter: Date.now() + pmRetryCooldownMs,
      noProgressCount: previousAttempt?.fingerprint === fingerprint
        ? previousAttempt.noProgressCount ?? 0
        : 0,
    });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearActivePmAgent(slot.id, child);
      resolveWake(ok);
    };
    child.once('error', (error) => {
      console.error(`[supervisor] PM slot ${slot.id} 无法启动：${error instanceof Error ? error.message : String(error)}`);
      finish(false);
    });
    child.once('close', (code, signal) => {
      if (receivedSignal) {
        finish(false);
        return;
      }
      if (code === 0) {
        pmDoorbellAttempts.delete(attemptKey);
        finish(true);
      }
      else {
        const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? 'unknown'}`;
        if (code === 4 && !signal) {
          const currentAttempt = pmDoorbellAttempts.get(attemptKey);
          const noProgressCount = (currentAttempt?.noProgressCount ?? 0) + 1;
          // 首次无进展快速兜底；同一指纹反复无安全动作时迅速降噪到 5/15/60 分钟。
          // task/reason/generation 变化会改变 fingerprint，仍然立即唤醒。
          const retryMultipliers = [1, 5, 15, 60];
          const retryDelayMs = Math.min(
            pmNoProgressRetryMaxMs,
            pmNoProgressRetryMs * retryMultipliers[Math.min(noProgressCount - 1, retryMultipliers.length - 1)],
          );
          pmDoorbellAttempts.set(attemptKey, {
            fingerprint,
            retryAfter: Date.now() + retryDelayMs,
            noProgressCount,
          });
          console.error(`[supervisor] wake_no_progress slot=${slot.id} plan=${planId}（${reason}），${Math.ceil(retryDelayMs / 1000)} 秒后主动重试；新门铃可立即唤醒。`);
        } else {
          console.error(`[supervisor] PM slot ${slot.id} 未完成事项（${reason}），同一未变化门铃将在冷却后兜底提醒；新门铃可立即唤醒。`);
        }
        finish(false);
      }
    });
  });
  // `--once` 要在整轮 intake 都分发后再汇总真实退出码。此处若 await 第一个 slot，
  // runtime 就不会发现另一个 consumer 的门铃，多个 PM 反而被错误串行化。
  if (once) {
    oncePmWakeCompletions.push(completion);
    return true;
  }
  // 常驻 Supervisor 不等 PM 退出，以便 Worker 并行；返回 false 保留事项的本机
  // 可重试性，active 与 cooldown 会在后续共享轮次阻止重复消耗模型 token。
  return false;
}

function doorbellFingerprint(items) {
  return items
    // event_id 是投递尝试，不参与逻辑事项指纹；同一 task/question 的重发不能绕过冷却。
    .map((item) => [item.consumer, item.kind, item.question_id ?? item.task_id ?? item.agent_id ?? item.plan_id].filter(Boolean).join(':'))
    .sort()
    .join('|');
}

/**
 * 将同一个 Plan 的最小事项按 consumer/plan/kind 投递到可用 PM slot。
 * 每个 slot 在一轮内至多启动一次；不同 slot 可并行运行，任一未投递或未清空都让
 * Supervisor 在下个共享轮次重试。这里不读取详情，也不替 PM ack/review/answer。
 */
async function dispatchPmDoorbell(planId, items) {
  if (pmSlots.length === 0) {
    return wakePmAgent({ id: `legacy:${consumer}`, consumer }, planId, doorbellFingerprint(items));
  }
  const assigned = new Set();
  const launches = [];
  for (const slot of pmSlots) {
    if (slot.plans && !slot.plans.includes(planId)) continue;
    const matching = items.filter((item, index) => {
      if (item.consumer !== slot.consumer) return false;
      if (slot.kinds && !slot.kinds.includes(item.kind)) return false;
      assigned.add(index);
      return true;
    });
    if (matching.length === 0) continue;
    const route = resolvePmAgentRoute(planId, slot);
    if (!route) {
      console.error(`[supervisor] PM slot ${slot.id} 没有可用 command，保留门铃待重试。`);
      launches.push(Promise.resolve(false));
      continue;
    }
    // 每个 slot 只用自己实际收到的事项计算去重指纹；同 Plan 另一 consumer/kind
    // 的变化不能绕过本 slot 冷却并额外消耗模型 token。
    launches.push(wakePmAgent(slot, planId, doorbellFingerprint(matching)));
  }
  if (launches.length === 0 || assigned.size !== items.length) return false;
  const results = await Promise.all(launches);
  return results.every((result) => result === true);
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
    const agentType = slot.agentType === undefined
      ? slot.kind === 'custom' ? 'custom' : slot.kind === 'cli' ? 'cli' : slot.kind
      : typeof slot.agentType === 'string' ? slot.agentType.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentType)) {
      throw new Error(`第 ${index + 1} 个 Worker slot 的 agentType 非法`);
    }
    if (slot.project !== undefined && (typeof slot.project !== 'string' || !slot.project.startsWith('/'))) {
      throw new Error(`第 ${index + 1} 个 Worker slot 的 project 必须是绝对路径`);
    }
    const baseOptions = {
      agentId,
      agentType,
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
    stopActivePmAgents('SIGKILL');
    return;
  }
  receivedSignal = signal;
  console.error(`[supervisor] 收到 ${signal}，正在停止监视并终止运行中的 PM Agent。`);
  shutdown.abort();
  stopActivePmAgents('SIGTERM');
};
const onSigint = () => stop('SIGINT');
const onSigterm = () => stop('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

try {
  const slots = parseSlots();
  // 零配置 harness 接入：向每个 slot 的 project 目录幂等注入 Biao 协议块
  // （AGENTS.md/CLAUDE.md）。任何新 harness 在自己的 cwd 就能读到任务书规则；
  // BIAO_AGENT_PROTOCOL=0 停用。注入失败只记一行日志，不影响监视。
  if (process.env.BIAO_AGENT_PROTOCOL !== '0') {
    for (const project of [...new Set(slots.map((slot) => slot.preferredProject).filter(Boolean))]) {
      // project 目录可能尚未 clone（V2 动态项目）；不存在时静默跳过，目录就绪后的
      // 下次 supervisor 启动会补注入。
      if (!existsSync(project) || !statSync(project).isDirectory()) continue;
      try {
        const result = ensureAgentProtocolBlock(project);
        const injected = result.files.filter((entry) => entry.changed).map((entry) => entry.file);
        if (injected.length > 0) console.log(`[supervisor] 已注入 Biao 协作协议块：${project}（${injected.join(', ')}）`);
        for (const entry of result.files) {
          if (entry.error) console.error(`[supervisor] 协议块注入失败 ${project}/${entry.file}：${entry.error}`);
        }
      } catch (error) {
        console.error(`[supervisor] 协议块注入异常 ${project}（不影响监视）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const intervalMs = Math.max(10_000, Number.isFinite(intervalSeconds) ? intervalSeconds * 1000 : 60_000);
  // 留守模式的定时长睡眠可被 SSE 事件打断（每轮重新武装；shutdown 仍然立即生效）。
  const residentWake = { controller: new AbortController() };
  const runtime = new BiaoSupervisorRuntime({
    biaoUrl,
    consumer,
    pmConsumers: pmSlots.length > 0 ? pmSlots.map((slot) => slot.consumer) : undefined,
    planIds,
    apiToken: process.env.BIAO_API_TOKEN,
    workerApiToken: deriveWorkerApiToken(process.env.BIAO_API_TOKEN),
    maxConcurrentTasks,
    workers: slots,
    pollIntervalMs: intervalMs,
    signal: shutdown.signal,
    onPmDoorbell: async (planId, items) => {
      const kinds = [...new Set(items.map((item) => item.kind))].join(',');
      // 监视器只负责低噪声提醒；不展开 task/question/event ID，避免把一个历史批次
      // 刷成终端日志。PM 需要详情时再主动从平台读取。
      const actionable = items.filter(isPmActionableItem);
      if (actionable.length === 0) {
        // acceptance_ready 等是给 Worker/Supervisor 的信号，PM 没有可执行动作：
        // 不启动 PM Agent（否则 pm-agent 判定无事可做、--require-drained 必然退出码
        // 4，退避循环反复唤醒大模型却零进展）。返回 true 让本机去重生效，同一事项
        // 后续轮次不再重复响铃；新的 PM 可执行门铃仍会立即唤醒。
        console.log(`[biao] PM 门铃 plan=${planId} kinds=${kinds} count=${items.length}（无 PM 可执行事项，不唤醒 PM Agent）`);
        return true;
      }
      console.log(`[biao] PM 门铃 plan=${planId} kinds=${kinds} count=${items.length}（详情请到平台查看）`);
      const handled = await dispatchPmDoorbell(planId, actionable);
      if (handled === false) pmWakeFailed = true;
      return handled;
    },
    onError: (message) => console.error(`[supervisor] ${message}`),
    // SSE 事件唤醒（默认关，BIAO_SUPERVISOR_EVENT_WAKE=1 开启）：中央事件到达即
    // 提前进入下一共享轮次；轮询定时器保留兜底，断流只损失"提前"，不损失正确性。
    eventWake: process.env.BIAO_SUPERVISOR_EVENT_WAKE === '1',
    onExternalWake: () => residentWake.controller.abort(),
  });
  if (once) {
    const active = await runtime.runOnce();
    const pmWakeResults = await Promise.all(oncePmWakeCompletions);
    if (pmWakeResults.some((result) => result !== true)) pmWakeFailed = true;
    process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : pmWakeFailed ? 4 : active ? 0 : 2;
  } else {
    console.log(`[supervisor] 运行：consumer=${consumer}，pmSlots=${pmSlots.length || 1}，workerSlots=${slots.length}，间隔上限=${Math.round(intervalMs / 1000)}s（PM 事件不会自动 ack）`);
    let terminalDrained = false;
    let residentAnnounced = false;
    while (!shutdown.signal.aborted) {
      await runtime.run();
      if (shutdown.signal.aborted) break;
      terminalDrained = await requestedPlansAreTerminal();
      if (!terminalDrained) {
        residentAnnounced = false;
        // 最后一轮与复核之间出现 reset/reject/new task，重新进入同一被动运行时。
        continue;
      }
      if (!stayResident) break;
      // 留守模式：全部闭环不退出，按共享间隔低频复查。期间无 timer、无 claim
      // 轮询；新计划/reset/reject 会在下一轮自动重新进入同一被动调度。
      if (!residentAnnounced) {
        residentAnnounced = true;
        console.log(`[supervisor] 全部受管计划已闭环；留守待命（每 ${Math.round(intervalMs / 1000)}s 低频复查新计划，Ctrl-C 退出）。`);
      }
      residentWake.controller = new AbortController();
      await sleepInterruptible(intervalMs, AbortSignal.any([shutdown.signal, residentWake.controller.signal]));
    }
    if (receivedSignal) process.exitCode = signalExitCode(receivedSignal);
    else if (terminalDrained) console.log('[supervisor] 所有受管项目已完成并验收，已停止监视。');
  }
} catch (error) {
  console.error(`[supervisor] 启动/运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
} finally {
  await stopAndDrainActivePmAgents();
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  releaseLocalLock(handle);
}
