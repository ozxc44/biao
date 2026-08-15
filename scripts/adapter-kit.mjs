#!/usr/bin/env node

import { accessSync, chmodSync, constants, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

function fail(message) {
  console.error(`[biao-adapter-kit] ${message}`);
  process.exitCode = 2;
}

function usage() {
  return `Biao 陌生 Agent 接入包（离线、无控制面凭据）

用法：
  biao-adapter-kit contract --role <pm|worker> [--json]
  biao-adapter-kit scaffold --role <pm|worker> --output <绝对路径> [--json]
  biao-adapter-kit check --role <pm|worker> --adapter <绝对路径> [--json]

步骤：先读取 contract，再生成或自行实现适配器，最后用 check 离线验证。
本工具不连接平台、不读取 Biao Token，也不会启动真实 Agent 会话。`;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`);
  return value;
}

function pmContract() {
  const protocol = 'biao.pm-adapter/v1';
  return {
    protocol,
    role: 'pm',
    input: {
      transport: 'stdin-json-line',
      fields: ['biaoUrl', 'consumer', 'planIds', 'kinds', 'count'],
    },
    target: { env: 'BIAO_PM_TARGET', required: false },
    runtime: { env: 'BIAO_RUNTIME_DIR', launchers: ['pm-start', 'pm'] },
    probe: {
      env: 'BIAO_ADAPTER_PROBE',
      value: '1',
      response: { ok: true, protocol, role: 'pm' },
    },
    supervisor: {
      poolConfig: 'BIAO_PM_SLOTS',
      queueSelector: 'plan.pm_consumer == slot.consumer',
      routeOverride: 'BIAO_PM_AGENT_ROUTES',
    },
    exit: { success: 0, retry: 'nonzero' },
  };
}

function workerContract() {
  const protocol = 'biao.worker-executor/v1';
  return {
    protocol,
    role: 'worker',
    input: {
      transport: 'argv',
      fields: ['taskId', 'goalFile', 'workDir'],
      cwd: 'projectPath',
    },
    question: { stdoutPrefix: 'BIAO_QUESTION: ' },
    probe: {
      env: 'BIAO_ADAPTER_PROBE',
      value: '1',
      response: { ok: true, protocol, role: 'worker' },
    },
    supervisor: { config: 'BIAO_WORKER_SLOTS', kind: 'custom' },
    exit: { success: 0, failed: 'nonzero' },
  };
}

function pmTemplate() {
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const protocol = 'biao.pm-adapter/v1';
const raw = readFileSync(0, 'utf8').trim();
let wake;
try {
  wake = JSON.parse(raw);
} catch {
  console.error('[pm-adapter] stdin 必须是 Biao 五字段门铃 JSON');
  process.exit(2);
}

if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({ ok: true, protocol, role: 'pm' }));
  process.exit(0);
}

const fields = ['biaoUrl', 'consumer', 'planIds', 'kinds', 'count'];
if (!wake || typeof wake !== 'object' || Array.isArray(wake) ||
    Object.keys(wake).sort().join(',') !== [...fields].sort().join(',')) {
  console.error('[pm-adapter] 门铃只能包含 biaoUrl/consumer/planIds/kinds/count');
  process.exit(2);
}

const target = process.env.BIAO_PM_TARGET || '';
const runtimeDir = process.env.BIAO_RUNTIME_DIR || '';

// 在这里接入你的 Agent harness：恢复 target 对应会话，把 wake 的范围以及
// runtimeDir 下的 pm/pm-start launcher 告诉它。真正处理、验收和 ack 完成后才返回 0；
// 网络失败、会话无法恢复或事项未清空时必须返回非零，让 Supervisor 下轮重试。
console.error('[pm-adapter] 请实现 harness 唤醒逻辑', { target, runtimeDir });
process.exit(3);
`;
}

function workerTemplate() {
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const protocol = 'biao.worker-executor/v1';
if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({ ok: true, protocol, role: 'worker' }));
  process.exit(0);
}

const [taskId, goalFile, workDir] = process.argv.slice(2);
if (!taskId || !goalFile || !workDir || process.argv.slice(2).length !== 3) {
  console.error('[worker-executor] 需要 taskId、goalFile、workDir 三个参数');
  process.exit(2);
}
const goal = readFileSync(goalFile, 'utf8');

// 在这里把 goal 交给你的 Agent harness，并让它在当前项目中执行。外层 Biao Worker
// 已负责 register/claim/ownership/lease/verify/report；本执行器不应索取控制面凭据。
// 缺少产品决策时，最终 stdout 只输出一行：
// BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"当前恢复点"}
console.error('[worker-executor] 请实现 harness 执行逻辑', { taskId, workDir, goalBytes: Buffer.byteLength(goal) });
process.exit(3);
`;
}

function writeScaffold(role, output) {
  if (!isAbsolute(output)) throw new Error('--output 必须是绝对路径');
  const content = role === 'pm' ? pmTemplate() : workerTemplate();
  try {
    writeFileSync(output, content, { encoding: 'utf8', flag: 'wx', mode: 0o755 });
    chmodSync(output, 0o755);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`输出已存在，未覆盖：${output}`);
    throw error;
  }
}

function probeEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.BIAO_ADAPTER_PROBE = '1';
  return env;
}

function checkAdapter(role, requestedPath) {
  if (!isAbsolute(requestedPath)) throw new Error('--adapter 必须是绝对路径');
  const metadata = lstatSync(requestedPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('--adapter 必须是普通文件且不能是符号链接');
  }
  accessSync(requestedPath, constants.X_OK);
  const adapter = realpathSync(requestedPath);
  const expectedProtocol = role === 'pm' ? pmContract().protocol : workerContract().protocol;
  const wake = JSON.stringify({
    biaoUrl: 'http://127.0.0.1:7331',
    consumer: 'adapter-probe',
    planIds: ['adapter-probe-plan'],
    kinds: { review_requested: 1 },
    count: 1,
  });
  const run = spawnSync(
    adapter,
    role === 'pm' ? [] : ['adapter-probe-task', 'adapter-probe-goal', 'adapter-probe-work-dir'],
    {
      encoding: 'utf8',
      env: probeEnvironment(),
      input: role === 'pm' ? `${wake}\n` : undefined,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (run.error) throw new Error(`探针无法启动：${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`探针退出码 ${run.status ?? 'unknown'}：${run.stderr.trim() || '无错误输出'}`);
  }
  let response;
  try {
    response = JSON.parse(run.stdout.trim());
  } catch {
    throw new Error('探针必须只输出一行 JSON');
  }
  if (response?.ok !== true || response?.role !== role || response?.protocol !== expectedProtocol) {
    throw new Error(`探针协议不匹配，期望 ${expectedProtocol}`);
  }
  return { role, protocol: expectedProtocol, adapter: requestedPath };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (['--help', '-h', 'help'].includes(command ?? '')) {
    console.log(usage());
    return;
  }
  if (!['contract', 'scaffold', 'check'].includes(command ?? '')) {
    fail('用法：biao-adapter-kit <contract|scaffold|check> --role <pm|worker> [--json]');
    return;
  }
  const role = optionValue(args, '--role');
  if (!['pm', 'worker'].includes(role ?? '')) {
    fail('--role 必须为 pm 或 worker');
    return;
  }
  if (command === 'scaffold') {
    const output = optionValue(args, '--output');
    if (!output) {
      fail('scaffold 需要 --output <绝对路径>');
      return;
    }
    writeScaffold(role, output);
    const protocol = role === 'pm' ? pmContract().protocol : workerContract().protocol;
    const result = { ok: true, data: { protocol, role, output } };
    console.log(args.includes('--json') ? JSON.stringify(result) : `已生成 ${role === 'pm' ? 'PM' : 'Worker'} 适配器模板：${output}`);
    return;
  }
  if (command === 'check') {
    const adapter = optionValue(args, '--adapter');
    if (!adapter) {
      fail('check 需要 --adapter <绝对路径>');
      return;
    }
    const result = { ok: true, data: checkAdapter(role, adapter) };
    console.log(args.includes('--json') ? JSON.stringify(result) : `适配器探针通过：${result.data.protocol}`);
    return;
  }
  const result = { ok: true, data: role === 'pm' ? pmContract() : workerContract() };
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : JSON.stringify(result.data, null, 2));
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
