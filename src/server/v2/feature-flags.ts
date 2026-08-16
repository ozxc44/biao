/**
 * V2 Feature Flags（Phase 8 · §23.1 五旗依赖序 + §21 Phase 8 灰度）
 *
 * 五面旗与依赖顺序（主方案 §23.1：功能必须按依赖顺序启用，不能让 Merge
 * Queue 在 Artifact/Delivery 不完整时提前开放）：
 *
 *   BIAO_DISTRIBUTED_MODE          ← 总开关：不开则整个 /v2 面关闭（纯 V1）
 *   BIAO_V2_ARTIFACTS               ← Artifact Store（§9）
 *   BIAO_V2_NODE_RUNTIME            ← biao-node 运行时数据面（§10）
 *   BIAO_V2_GIT_DELIVERY            ← Git Workspace/Delivery（§6/§4.5）
 *   BIAO_V2_MERGE_QUEUE             ← Merge Queue（§12）
 *
 * 依赖链：DISTRIBUTED_MODE → ARTIFACTS → NODE_RUNTIME → GIT_DELIVERY →
 * MERGE_QUEUE。开某面旗必须先开它之前的全部旗；乱序启动在装配期 fail-fast
 * （抛错并指明缺哪面旗，服务不 boot——比半开状态静默运行安全）。
 *
 * 默认全关 = 纯 V1 行为：/v2/* 除 GET /v2/feature-flags 状态端点外全部
 * 404 V2_DISABLED（回退窗口语义，§23.2）。
 *
 * 值解析（严格）：1/true/yes/on 开；0/false/no/off 与缺省关；其它值视为
 * 配置错误直接抛错（拼错不得静默当关）。
 */

/** 五面旗的稳定名（API/文档/测试引用；env 变量名见 V2_FEATURE_FLAG_ENV_NAMES）。 */
export type V2FeatureFlagName =
  | 'DISTRIBUTED_MODE'
  | 'ARTIFACTS'
  | 'NODE_RUNTIME'
  | 'GIT_DELIVERY'
  | 'MERGE_QUEUE';

/** §23.1 依赖序（数组顺序即启用顺序；index 0 是根）。 */
export const V2_FEATURE_FLAG_ORDER: readonly V2FeatureFlagName[] = [
  'DISTRIBUTED_MODE',
  'ARTIFACTS',
  'NODE_RUNTIME',
  'GIT_DELIVERY',
  'MERGE_QUEUE',
];

/** 旗 → 环境变量名（§23.1 原名）。 */
export const V2_FEATURE_FLAG_ENV_NAMES: Readonly<Record<V2FeatureFlagName, string>> = {
  DISTRIBUTED_MODE: 'BIAO_DISTRIBUTED_MODE',
  ARTIFACTS: 'BIAO_V2_ARTIFACTS',
  NODE_RUNTIME: 'BIAO_V2_NODE_RUNTIME',
  GIT_DELIVERY: 'BIAO_V2_GIT_DELIVERY',
  MERGE_QUEUE: 'BIAO_V2_MERGE_QUEUE',
};

/** 五面旗 env 全开的字面量（测试/本地演练 opt-in 用，配套 save/restore 纪律）。 */
export const ALL_V2_FEATURE_FLAGS_ON_ENV: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    V2_FEATURE_FLAG_ORDER.map((flag) => [V2_FEATURE_FLAG_ENV_NAMES[flag], '1']),
  ),
);

/** 五面旗 env 变量名清单（env 快照/恢复用）。 */
export const V2_FEATURE_FLAG_ENV_KEYS: readonly string[] = V2_FEATURE_FLAG_ORDER.map(
  (flag) => V2_FEATURE_FLAG_ENV_NAMES[flag],
);

/** 解析结果：五面旗布尔值。 */
export type V2FeatureFlags = Readonly<Record<V2FeatureFlagName, boolean>>;

/** 全关字面量（纯 V1）。 */
export const V2_FEATURE_FLAGS_ALL_OFF: V2FeatureFlags = Object.freeze({
  DISTRIBUTED_MODE: false,
  ARTIFACTS: false,
  NODE_RUNTIME: false,
  GIT_DELIVERY: false,
  MERGE_QUEUE: false,
});

/** 旗值非法（拼错/脏值）：装配期抛出，不静默当关。 */
export class V2FeatureFlagValueError extends Error {
  constructor(public readonly flag: V2FeatureFlagName, public readonly envVar: string, public readonly rawValue: string) {
    super(`feature flag ${envVar}（${flag}）的值 "${rawValue}" 无法识别：允许 1/true/yes/on 开、0/false/no/off 关`);
    this.name = 'V2FeatureFlagValueError';
  }
}

/** 依赖序违规：指明缺哪面旗（§23.1 fail-fast）。 */
export class V2FeatureFlagOrderError extends Error {
  constructor(
    public readonly flag: V2FeatureFlagName,
    public readonly missing: V2FeatureFlagName[],
  ) {
    super(
      `feature flag 依赖序违规：${V2_FEATURE_FLAG_ENV_NAMES[flag]} 已开，但前置旗 ` +
      `${missing.map((f) => V2_FEATURE_FLAG_ENV_NAMES[f]).join(', ')} 未开。` +
      `启用顺序必须是 ${V2_FEATURE_FLAG_ORDER.map((f) => V2_FEATURE_FLAG_ENV_NAMES[f]).join(' → ')}`,
    );
    this.name = 'V2FeatureFlagOrderError';
  }
}

const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const OFF_VALUES = new Set(['0', 'false', 'no', 'off', '']);

/** 单旗解析：严格值域，非法抛 V2FeatureFlagValueError。 */
function parseFlag(flag: V2FeatureFlagName, env: NodeJS.ProcessEnv): boolean {
  const envVar = V2_FEATURE_FLAG_ENV_NAMES[flag];
  const raw = env[envVar];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (ON_VALUES.has(normalized)) return true;
  if (OFF_VALUES.has(normalized)) return false;
  throw new V2FeatureFlagValueError(flag, envVar, raw);
}

/** 五旗解析（只做值域校验，不做依赖序校验）。 */
export function resolveV2FeatureFlags(env: NodeJS.ProcessEnv = process.env): V2FeatureFlags {
  const flags = {} as Record<V2FeatureFlagName, boolean>;
  for (const flag of V2_FEATURE_FLAG_ORDER) {
    flags[flag] = parseFlag(flag, env);
  }
  return flags;
}

/**
 * 依赖序校验：开旗 i 必须先开 0..i-1。返回缺的前置旗清单（空数组=合法）。
 */
export function missingPrerequisiteFlags(flags: V2FeatureFlags): Partial<Record<V2FeatureFlagName, V2FeatureFlagName[]>> {
  const violations: Partial<Record<V2FeatureFlagName, V2FeatureFlagName[]>> = {};
  for (let i = 0; i < V2_FEATURE_FLAG_ORDER.length; i += 1) {
    const flag = V2_FEATURE_FLAG_ORDER[i];
    if (!flags[flag]) continue;
    const missing = V2_FEATURE_FLAG_ORDER.slice(0, i).filter((prior) => !flags[prior]);
    if (missing.length > 0) violations[flag] = missing;
  }
  return violations;
}

/** 依赖序校验（布尔视图）。 */
export function isV2FeatureFlagOrderValid(flags: V2FeatureFlags): boolean {
  return Object.keys(missingPrerequisiteFlags(flags)).length === 0;
}

/**
 * 解析 + 依赖序校验：乱序抛 V2FeatureFlagOrderError（消息指明缺哪面旗）。
 * 服务装配点调用——抛错即 boot 失败（fail-fast），不留半开状态。
 */
export function resolveAndValidateV2FeatureFlags(env: NodeJS.ProcessEnv = process.env): V2FeatureFlags {
  const flags = resolveV2FeatureFlags(env);
  for (const [flag, missing] of Object.entries(missingPrerequisiteFlags(flags))) {
    throw new V2FeatureFlagOrderError(flag as V2FeatureFlagName, missing as V2FeatureFlagName[]);
  }
  return flags;
}

/* ------------------------------------------------------------------ */
/* 状态端点视图（GET /v2/feature-flags）                                */
/* ------------------------------------------------------------------ */

/** 单旗状态行。 */
export interface V2FeatureFlagStatus {
  flag: V2FeatureFlagName;
  env_var: string;
  enabled: boolean;
  /** 依赖序中位于本旗之前、必须先开的旗。 */
  prerequisites: V2FeatureFlagName[];
  /** 前置旗是否全部满足（关旗时恒 true——只有开旗才校验前置）。 */
  prerequisites_satisfied: boolean;
}

/** 状态端点载荷：五旗行 + 汇总。 */
export interface V2FeatureFlagStatusView {
  flags: V2FeatureFlagStatus[];
  /** 依赖序是否合法（装配期已 fail-fast，此处恒 true；保留字段供运行时巡检）。 */
  order_valid: boolean;
  distributed_mode: boolean;
  generated_hint: string;
}

/** 生成状态视图（owner 只读）。 */
export function describeV2FeatureFlags(flags: V2FeatureFlags): V2FeatureFlagStatusView {
  const rows: V2FeatureFlagStatus[] = V2_FEATURE_FLAG_ORDER.map((flag, index) => {
    const prerequisites = V2_FEATURE_FLAG_ORDER.slice(0, index);
    return {
      flag,
      env_var: V2_FEATURE_FLAG_ENV_NAMES[flag],
      enabled: flags[flag],
      prerequisites,
      prerequisites_satisfied: flags[flag]
        ? prerequisites.every((prior) => flags[prior])
        : true,
    };
  });
  return {
    flags: rows,
    order_valid: isV2FeatureFlagOrderValid(flags),
    distributed_mode: flags.DISTRIBUTED_MODE,
    generated_hint: '五旗依赖序 BIAO_DISTRIBUTED_MODE → BIAO_V2_ARTIFACTS → BIAO_V2_NODE_RUNTIME → BIAO_V2_GIT_DELIVERY → BIAO_V2_MERGE_QUEUE；关闭按反序逐面收口（见 docs/runbooks/phase8-rollout.md）',
  };
}

/* ------------------------------------------------------------------ */
/* 路由分组门禁（路径 → 旗）                                            */
/* ------------------------------------------------------------------ */

/**
 * 路由分组规则：路径前缀 → 管辖旗。空匹配 = 只需 DISTRIBUTED_MODE。
 * 规则按声明顺序取第一个命中（具体前缀写在通配前面）。
 * GET /v2/feature-flags 永不受门禁（全关时仍可读状态——回退窗口可观测性）。
 */
const ROUTE_FLAG_RULES: ReadonlyArray<{ prefix: string; flag: V2FeatureFlagName }> = [
  // Artifact Store（§9 三段上传/读面）
  { prefix: '/v2/artifacts', flag: 'ARTIFACTS' },
  // Git Workspace / Delivery / BranchCleanup / Evidence（§6/§4.5/§4.4.2）
  { prefix: '/v2/attempts/', flag: 'GIT_DELIVERY' }, // 具体匹配见下方 workspace 特判
  { prefix: '/v2/deliveries', flag: 'GIT_DELIVERY' },
  { prefix: '/v2/workspace-recovery', flag: 'GIT_DELIVERY' },
  { prefix: '/v2/branch-cleanups', flag: 'GIT_DELIVERY' },
  { prefix: '/v2/evidence-acceptances', flag: 'GIT_DELIVERY' },
  // Merge Queue（§12）
  { prefix: '/v2/merge-jobs', flag: 'MERGE_QUEUE' },
  { prefix: '/write-capability', flag: 'MERGE_QUEUE' }, // /v2/projects/:id/write-capability/restore
  // Node Runtime 数据面（§10：register/heartbeat/claim/renew/report）
  { prefix: '/v2/nodes', flag: 'NODE_RUNTIME' },
  { prefix: '/v2/tasks', flag: 'NODE_RUNTIME' },
];

/** 判定路径归哪面旗管辖：返回 null = 仅需 DISTRIBUTED_MODE（管理/观测面）。 */
export function requiredV2FeatureFlagForPath(path: string): V2FeatureFlagName | null {
  if (path === '/v2/feature-flags' || path.startsWith('/v2/feature-flags')) return null;
  // workspace 子路径（/v2/attempts/:id/workspace*）归 GIT_DELIVERY；
  // 其余 /v2/attempts/*（lease/renew、report）归 NODE_RUNTIME。
  if (path.startsWith('/v2/attempts/')) {
    const rest = path.slice('/v2/attempts/'.length);
    const attemptId = rest.split('/')[0] ?? '';
    return rest.startsWith(`${attemptId}/workspace`) ? 'GIT_DELIVERY' : 'NODE_RUNTIME';
  }
  for (const rule of ROUTE_FLAG_RULES) {
    if (path.startsWith(rule.prefix)) return rule.flag;
  }
  // /v2/projects/:id/merge-jobs[/dispatch] 段级匹配（项目资源下的队列面）
  if (path.startsWith('/v2/projects/') && path.split('/').includes('merge-jobs')) return 'MERGE_QUEUE';
  return null;
}

/** 管理面路由（projects/identity/incidents/recovery 决策/outbox/metrics/backup）：null 组。 */
export const V2_FLAG_UNGATED_HINT =
  '/v2/projects、/v2/human-sessions、/v2/project-memberships、/v2/security、' +
  '/v2/incidents、/v2/recovery-candidates、/v2/recovery-isolations、/v2/outbox、' +
  '/v2/metrics、/v2/backup 只受 BIAO_DISTRIBUTED_MODE 管辖（管理/观测面，回退窗口仍可用）';
