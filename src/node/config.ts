/**
 * biao-node 配置载入与校验（Phase 3 · §16 配置模型的最小节点侧子集）
 *
 * 配置文件 biao-node.config.json 只承载非机密声明（地址、槽位、路径、
 * 周期参数）；机密只允许经环境变量/凭据文件进入：
 * - Node credential → 独立 0600 凭据文件（credentials-store.ts）；
 * - 过渡期 owner 引导 token → env BIAO_NODE_OWNER_TOKEN；
 * 配置里出现任何机密字段直接拒绝启动（fail-closed，防止模板复制时把
 * token 带进世界可读文件）。
 *
 * 校验原则：
 * - 未知字段拒绝（拼写错误不得静默失效）；
 * - 路径拒绝控制字符与 `..` 段（§19.1 的本地路径版），相对路径按配置
 *   文件所在目录解析；
 * - 数值参数只接受有界整数，且 lease 停止窗口必须小于续租提前量
 *   （§10.4：到期前必须预留停止窗口）；
 * - 时钟偏差阈值只能收紧（NodeClock 构造时复核）。
 *
 * 环境变量：
 * - BIAO_NODE_OWNER_TOKEN：过渡期 owner 引导 token（不落盘、不进 argv）；
 * - BIAO_NODE_INJECTED_CLOCK_OFFSET_MS：故障注入钩子（仅测试，模拟节点
 *   时钟偏快/偏慢；生产不得设置）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** 配置文件里唯一允许的注记字段（JSON 无注释，enroll 生成的初始配置用它说明来源）。 */
const ALLOWED_META_KEYS = new Set(['_comment']);

/** 名字含机密字样、但实际只是路径/计数等非机密声明的字段。 */
const SECRET_KEY_ALLOWLIST = new Set(['credential_file']);

/** 配置里禁止出现的机密字段名（按子串匹配，覆盖常见写法）。 */
const FORBIDDEN_SECRET_PATTERNS = [/token/i, /credential/i, /secret/i, /password/i, /key/i];

export interface BiaoNodeConfigFile {
  /** 控制面地址，如 http://control-plane:7331（Phase 3 无 TLS，见 §13.3 缺口）。 */
  biao_url: string;
  /** 节点 ID（registry 契约：16~128 字符）。 */
  node_id: string;
  /** Node credential 文件路径（默认 <配置目录>/node-credential.json）。 */
  credential_file?: string;
  /** 声明的执行槽数量（1~256）。 */
  slots?: number;
  /** 本地缓存根（Git workspace/Artifact 缓存，Phase 4 使用）。 */
  cache_root?: string;
  /** 运行状态目录（默认 <配置目录>/state）。 */
  state_root?: string;
  labels?: string[];
  /** 声明接入的 project；实际授权以 NodeProjectBinding 为准。 */
  requested_project_ids?: string[];
  /**
   * 过渡期固定的服务端协议版本：GET /version 未公告 protocol_version 时
   * 必须提供，否则 daemon 拒绝注册（protocol.ts fail-closed）。
   */
  server_protocol_version?: number;
  heartbeat_interval_ms?: number;
  claim_interval_ms?: number;
  watchdog_tick_ms?: number;
  /** lease 到期前多久开始主动续租。 */
  lease_renew_margin_ms?: number;
  /** lease 到期前预留的停止窗口（必须 < lease_renew_margin_ms）。 */
  lease_stop_window_ms?: number;
  /** drain 等待 running attempts 收口的超时。 */
  drain_timeout_ms?: number;
  /** drain 超时后的显式选择（§10.5）：cancel 停止并上报，或继续等待。 */
  drain_timeout_action?: 'cancel' | 'wait';
  /** 时钟偏差阈值（只能比 §10.4 默认 30s/60s/120s 更严格）。 */
  clock_tolerance_ms?: number;
  clock_degraded_ms?: number;
  clock_quarantine_ms?: number;
}

/** 规范化后的运行时配置：路径全部解析为绝对路径，周期参数全部有默认值。 */
export interface BiaoNodeRuntimeConfig extends Required<Omit<BiaoNodeConfigFile, '_comment' | 'server_protocol_version' | 'clock_tolerance_ms' | 'clock_degraded_ms' | 'clock_quarantine_ms' | 'labels' | 'requested_project_ids' | 'drain_timeout_action'>> {
  config_path: string;
  credential_file: string;
  cache_root: string;
  state_root: string;
  labels: string[];
  requested_project_ids: string[];
  server_protocol_version?: number;
  drain_timeout_action: 'cancel' | 'wait';
  clock_tolerance_ms?: number;
  clock_degraded_ms?: number;
  clock_quarantine_ms?: number;
  /* 派生目录（daemon 布局，runbook 有图） */
  state_inbox_dir: string;
  state_control_dir: string;
  state_sessions_dir: string;
  state_recovery_dir: string;
  status_file: string;
}

export const BIAO_NODE_OWNER_TOKEN_ENV = 'BIAO_NODE_OWNER_TOKEN';
export const BIAO_NODE_INJECTED_CLOCK_OFFSET_ENV = 'BIAO_NODE_INJECTED_CLOCK_OFFSET_MS';
/**
 * P12 车道 B：真执行器的执行命令模板 env（RealExecutor.execCommand）。
 * 支持 ${workspace} ${goal_md_file} ${task_id} 变量；示例：
 * BIAO_EXEC_CMD='claude -p "$(cat ${goal_md_file})"'。显式传入
 * realExecutorOptions.execCommand 时以选项为准。
 */
export const BIAO_EXEC_CMD_ENV = 'BIAO_EXEC_CMD';

/** 默认周期参数（毫秒）。测试用更小值直接写进配置文件，不新增 env。 */
export const DEFAULTS = {
  slots: 2,
  heartbeat_interval_ms: 5_000,
  claim_interval_ms: 5_000,
  watchdog_tick_ms: 500,
  lease_renew_margin_ms: 30_000,
  lease_stop_window_ms: 15_000,
  drain_timeout_ms: 60_000,
} as const;

function fail(field: string, message: string): never {
  throw new Error(`biao-node 配置字段 ${field} 非法：${message}`);
}

function assertIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(field, `需要 [${min}, ${max}] 内的整数，实际 ${String(value)}`);
  }
  return value as number;
}

/** §19.1 精神的本地路径校验：拒绝控制字符与 `..` 段；返回绝对路径。 */
function normalizePath(value: string, field: string, baseDir: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(field, '不能为空');
  if (/[\x00-\x1f\x7f]/.test(value)) fail(field, '含控制字符');
  const raw = value.trim();
  const segments = raw.split(/[\\/]/);
  if (segments.includes('..')) fail(field, '不得包含 .. 段');
  return isAbsolute(raw) ? resolve(raw) : resolve(join(baseDir, raw));
}

const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;

export function validateNodeId(nodeId: string): string {
  if (!NODE_ID_PATTERN.test(nodeId)) {
    fail('node_id', '需要 16~128 个字符，字符集 [A-Za-z0-9._-]（registry 契约 minLength 16）');
  }
  return nodeId;
}

function assertNoSecrets(key: string): void {
  if (ALLOWED_META_KEYS.has(key) || SECRET_KEY_ALLOWLIST.has(key)) return;
  if (FORBIDDEN_SECRET_PATTERNS.some((pattern) => pattern.test(key))) {
    throw new Error(
      `biao-node 配置禁止携带机密字段 ${key}：token 请用 env ${BIAO_NODE_OWNER_TOKEN_ENV}（过渡期）或 0600 凭据文件，` +
        `不要写进可能被共同读取的配置文件。`,
    );
  }
}

/** 载入 + 校验 + 规范化。任何错误直接抛出（CLI 捕获后以退出码 2 结束）。 */
export function loadNodeConfig(configPath: string): BiaoNodeRuntimeConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(`无法读取 biao-node 配置文件：${configPath}。请先运行 biao-node enroll 生成初始配置。`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`biao-node 配置文件不是合法 JSON：${configPath}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`biao-node 配置文件必须是 JSON 对象：${configPath}`);
  }
  const baseDir = dirname(resolve(configPath));
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) assertNoSecrets(key);

  const biaoUrl = record.biao_url;
  if (typeof biaoUrl !== 'string' || !biaoUrl.trim()) fail('biao_url', '不能为空');
  let url: URL;
  try {
    url = new URL(biaoUrl.trim());
  } catch {
    fail('biao_url', `无法解析为 URL：${biaoUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('biao_url', '协议必须是 http/https');
  if (url.username || url.password) fail('biao_url', '不得内嵌 userinfo');
  if (url.pathname !== '/' && url.pathname !== '') fail('biao_url', 'Phase 3 只接受根路径部署（无 path 前缀）');

  if (typeof record.node_id !== 'string') fail('node_id', '缺失');
  validateNodeId(record.node_id);

  const slots = record.slots === undefined ? DEFAULTS.slots : assertIntInRange(record.slots, 'slots', 1, 256);
  const heartbeatInterval = record.heartbeat_interval_ms === undefined
    ? DEFAULTS.heartbeat_interval_ms
    : assertIntInRange(record.heartbeat_interval_ms, 'heartbeat_interval_ms', 200, 600_000);
  const claimInterval = record.claim_interval_ms === undefined
    ? DEFAULTS.claim_interval_ms
    : assertIntInRange(record.claim_interval_ms, 'claim_interval_ms', 200, 600_000);
  const watchdogTick = record.watchdog_tick_ms === undefined
    ? DEFAULTS.watchdog_tick_ms
    : assertIntInRange(record.watchdog_tick_ms, 'watchdog_tick_ms', 50, 5_000);
  const renewMargin = record.lease_renew_margin_ms === undefined
    ? DEFAULTS.lease_renew_margin_ms
    : assertIntInRange(record.lease_renew_margin_ms, 'lease_renew_margin_ms', 100, 3_600_000);
  const stopWindow = record.lease_stop_window_ms === undefined
    ? DEFAULTS.lease_stop_window_ms
    : assertIntInRange(record.lease_stop_window_ms, 'lease_stop_window_ms', 50, 3_600_000);
  if (stopWindow >= renewMargin) {
    fail('lease_stop_window_ms', `必须小于 lease_renew_margin_ms（实际 ${stopWindow} ≥ ${renewMargin}）：到期前要预留停止窗口（§10.4）`);
  }
  const drainTimeout = record.drain_timeout_ms === undefined
    ? DEFAULTS.drain_timeout_ms
    : assertIntInRange(record.drain_timeout_ms, 'drain_timeout_ms', 0, 3_600_000);
  const drainAction = record.drain_timeout_action ?? 'cancel';
  if (drainAction !== 'cancel' && drainAction !== 'wait') {
    fail('drain_timeout_action', `只接受 cancel|wait，实际 ${String(record.drain_timeout_action)}`);
  }

  let serverProtocol: number | undefined;
  if (record.server_protocol_version !== undefined) {
    serverProtocol = assertIntInRange(record.server_protocol_version, 'server_protocol_version', 1, 99);
  }

  const clockFields = ['clock_tolerance_ms', 'clock_degraded_ms', 'clock_quarantine_ms'] as const;
  const clockValues: Record<string, number | undefined> = {};
  for (const field of clockFields) {
    if (record[field] !== undefined) clockValues[field] = assertIntInRange(record[field], field, 1, 3_600_000);
  }

  const labels = record.labels === undefined ? [] : record.labels;
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string' || !label)) fail('labels', '必须是非空字符串数组');
  const requested = record.requested_project_ids === undefined ? [] : record.requested_project_ids;
  if (!Array.isArray(requested) || requested.some((id) => typeof id !== 'string' || !id)) {
    fail('requested_project_ids', '必须是字符串数组');
  }

  const credentialFile = record.credential_file === undefined
    ? join(baseDir, 'node-credential.json')
    : normalizePath(record.credential_file as string, 'credential_file', baseDir);
  const cacheRoot = record.cache_root === undefined
    ? join(baseDir, 'cache')
    : normalizePath(record.cache_root as string, 'cache_root', baseDir);
  const stateRoot = record.state_root === undefined
    ? join(baseDir, 'state')
    : normalizePath(record.state_root as string, 'state_root', baseDir);

  return {
    config_path: resolve(configPath),
    biao_url: url.origin,
    node_id: record.node_id,
    credential_file: credentialFile,
    slots,
    cache_root: cacheRoot,
    state_root: stateRoot,
    labels: labels as string[],
    requested_project_ids: requested as string[],
    server_protocol_version: serverProtocol,
    heartbeat_interval_ms: heartbeatInterval,
    claim_interval_ms: claimInterval,
    watchdog_tick_ms: watchdogTick,
    lease_renew_margin_ms: renewMargin,
    lease_stop_window_ms: stopWindow,
    drain_timeout_ms: drainTimeout,
    drain_timeout_action: drainAction,
    ...clockValues,
    state_inbox_dir: join(stateRoot, 'attempts-inbox'),
    state_control_dir: join(stateRoot, 'control'),
    state_sessions_dir: join(stateRoot, 'sessions'),
    state_recovery_dir: join(stateRoot, 'recovery'),
    status_file: join(stateRoot, 'status.json'),
  };
}

/** 生成默认 node_id（主机名 + 随机后缀，保证 ≥16 字符且符合字符集）。 */
export function generateNodeId(prefix = 'node'): string {
  const safeHost = hostname().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const suffix = process.pid.toString(36) + Math.random().toString(36).slice(2, 8);
  return validateNodeId(`${prefix}-${safeHost || 'host'}-${suffix}`.slice(0, 128));
}

export interface WriteInitialConfigInput {
  configPath: string;
  biaoUrl: string;
  nodeId: string;
  slots?: number;
  cacheRoot?: string;
  stateRoot?: string;
  credentialFile?: string;
  requestedProjectIds?: string[];
  /** enroll 生成的初始配置默认固定协议版本 2（过渡期，见 runbook）。 */
  serverProtocolVersion?: number;
}

/** enroll 向导落盘初始配置（含 _comment 说明，其余字段与运行时校验一致）。 */
export function writeInitialConfig(input: WriteInitialConfigInput): void {
  const baseDir = dirname(resolve(input.configPath));
  const config: BiaoNodeConfigFile & { _comment: string } = {
    _comment: 'biao-node 配置（由 biao-node enroll 生成）。机密不写入本文件：Node credential 在 node-credential.json（0600），过渡期 owner token 用 env BIAO_NODE_OWNER_TOKEN。',
    biao_url: input.biaoUrl,
    node_id: validateNodeId(input.nodeId),
    credential_file: input.credentialFile ?? join(baseDir, 'node-credential.json'),
    slots: input.slots ?? DEFAULTS.slots,
    cache_root: input.cacheRoot ?? join(baseDir, 'cache'),
    state_root: input.stateRoot ?? join(baseDir, 'state'),
    requested_project_ids: input.requestedProjectIds ?? [],
    server_protocol_version: input.serverProtocolVersion ?? 2,
  };
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  writeFileSync(input.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
}
