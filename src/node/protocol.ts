/**
 * biao-node 协议版本协商（Phase 3 · §10.5 Drain 与升级）
 *
 * §10.5 要求：Node 升级必须声明支持的 protocol min/max；控制面拒绝不兼容
 * 节点领取新任务；不允许节点自行静默升级到未经验证的版本。
 *
 * 本模块是 daemon 侧的 fail-closed 协商门：
 * - daemon 只认 [NODE_PROTOCOL_VERSION_MIN, NODE_PROTOCOL_VERSION_MAX] 闭区间；
 * - 服务端协议版本来源（按优先级）：
 *   1. GET /version 响应 data.protocol_version（服务端公告，当前 server 尚未
 *      提供——见交付说明的 server 侧接口缺口清单）；
 *   2. 配置 server_protocol_version（运维显式固定，过渡期手段）；
 *   3. 两者皆无 → 拒绝注册（PROTOCOL_UNDECLARED），绝不默认放行；
 * - 不匹配（BELOW_MIN / ABOVE_MAX）时在 register 之前退出并给出明确错误。
 *
 * 心跳按 registry 契约携带单个 protocol_version（协商结果），服务端据此
 * 拒绝不兼容节点（服务端强制属于缺口清单，daemon 侧已按 409 语义处理）。
 */

/** daemon 支持的协议版本闭区间。Phase 3 对应 V2 路由面（registry §15）。 */
export const NODE_PROTOCOL_VERSION_MIN = 2;
export const NODE_PROTOCOL_VERSION_MAX = 2;

/** 协商失败的稳定错误码（CLI 退出码 4 的细分原因，写入日志/状态文件）。 */
export type ProtocolIncompatibilityReason = 'BELOW_MIN' | 'ABOVE_MAX' | 'UNDECLARED';

export type ProtocolNegotiation =
  | {
      compatible: true;
      /** 协商出的心跳 protocol_version。 */
      negotiated: number;
      /** 版本来源：advertised=服务端公告；pinned=配置固定。 */
      source: 'advertised' | 'pinned';
    }
  | {
      compatible: false;
      reason: ProtocolIncompatibilityReason;
      /** 面向操作者的中文错误（不含敏感信息，可直接进日志）。 */
      message: string;
    };

export interface ProtocolNegotiationInput {
  daemonMin?: number;
  daemonMax?: number;
  /** 服务端公告的协议版本；null/undefined 表示未公告。 */
  serverProtocol: number | null | undefined;
  /** 配置固定的服务端协议版本；未公告时必须提供，否则 fail-closed。 */
  pinnedProtocol?: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 纯函数协商：给定 daemon 支持区间与服务端版本，判定兼容性。
 * 矩阵（p3 测试逐格覆盖）：
 *   server=2, daemon=[2,2]      → 兼容，negotiated=2
 *   server=1, daemon=[2,2]      → BELOW_MIN，拒绝注册
 *   server=3, daemon=[2,2]      → ABOVE_MAX，拒绝注册
 *   server=null, pinned=2       → 兼容（pinned），并在状态中标记过渡期
 *   server=null, 无 pinned      → UNDECLARED，拒绝注册（fail-closed）
 *   server 公告与 pinned 冲突   → 以公告为准并按公告判定（不静默放宽）
 */
export function negotiateProtocolVersion(input: ProtocolNegotiationInput): ProtocolNegotiation {
  const daemonMin = input.daemonMin ?? NODE_PROTOCOL_VERSION_MIN;
  const daemonMax = input.daemonMax ?? NODE_PROTOCOL_VERSION_MAX;
  if (!isPositiveInt(daemonMin) || !isPositiveInt(daemonMax) || daemonMin > daemonMax) {
    throw new Error(`biao-node 协议版本区间非法：[${daemonMin}, ${daemonMax}]`);
  }

  const advertised = isPositiveInt(input.serverProtocol) ? input.serverProtocol : null;
  // 公告优先：pinned 只是“服务端尚未公告”时的过渡手段，不能覆盖公告值。
  const effective = advertised ?? (isPositiveInt(input.pinnedProtocol) ? input.pinnedProtocol : null);

  if (effective === null) {
    return {
      compatible: false,
      reason: 'UNDECLARED',
      message:
        `服务端 ${'GET /version'} 未声明 protocol_version，且配置未固定 server_protocol_version；` +
        `为避免与未知协议面的控制面通信，biao-node 拒绝注册（fail-closed）。` +
        `请在 biao-node.config.json 显式写入 server_protocol_version，或升级服务端使其公告协议版本。`,
    };
  }
  if (effective < daemonMin) {
    return {
      compatible: false,
      reason: 'BELOW_MIN',
      message:
        `服务端协议版本 ${effective} 低于本节点支持的最小版本 ${daemonMin}（支持区间 [${daemonMin}, ${daemonMax}]）；` +
        `按 §10.5 控制面/节点不得跨不兼容版本领取任务，biao-node 拒绝注册。请升级服务端。`,
    };
  }
  if (effective > daemonMax) {
    return {
      compatible: false,
      reason: 'ABOVE_MAX',
      message:
        `服务端协议版本 ${effective} 高于本节点支持的最大版本 ${daemonMax}（支持区间 [${daemonMin}, ${daemonMax}]）；` +
        `按 §10.5 节点不得自行升级到未经验证的版本，biao-node 拒绝注册。请先升级 biao-node。`,
    };
  }
  return { compatible: true, negotiated: effective, source: advertised !== null ? 'advertised' : 'pinned' };
}

/** 从 GET /version 响应体提取 protocol_version（当前 server 未提供则返回 null）。 */
export function extractAdvertisedProtocol(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as { protocol_version?: unknown }).protocol_version;
  return isPositiveInt(value) ? value : null;
}
