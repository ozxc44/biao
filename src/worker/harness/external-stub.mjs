#!/usr/bin/env node
/**
 * biao.worker-wake/v1 外部 harness 适配器参考实现（通用，无 fixture 依赖）。
 *
 * 它刻意不包含任何 Biao 客户端、Token 或 claim 逻辑：真实 harness 把标有
 * “替换点”的分支换成自己的唤醒调用即可。协议规则：
 *   - stdin 读一行无凭据唤醒载荷（binding/reservation 一律 snake_case）；
 *   - stdout 只回一行 JSON 回执；协议不匹配或断言失败时以退出码 2 拒绝；
 *   - 带 reservation 的唤醒必须在回执中原样回带 task_id 与 reservation_id。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROTOCOL = 'biao.worker-wake/v1';

if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({
    ok: true, protocol: PROTOCOL, role: 'project-agent', wake_mode: 'external_worker',
  }));
  process.exit(0);
}

const wake = JSON.parse(readFileSync(0, 'utf8'));
const serialized = JSON.stringify(wake);
// 断言：载荷必须是本协议、binding 身份齐全、selector 是非空计划集合；
// 且不携带任何凭据 marker 或任务细节，环境里除 BIAO_RUNTIME_DIR 外没有别的 BIAO_*。
const bindingOk = typeof wake?.binding === 'object' && wake.binding !== null
  && typeof wake.binding.binding_id === 'string' && typeof wake.binding.agent_id === 'string'
  && typeof wake.binding.harness_kind === 'string' && typeof wake.binding.adapter_id === 'string'
  && ['visible_session', 'external_worker'].includes(wake.binding.wake_mode);
const selectorOk = typeof wake?.selector?.project === 'string' && wake.selector.project.startsWith('/')
  && typeof wake.selector?.capability === 'string'
  && Array.isArray(wake?.selector?.planIds) && wake.selector.planIds.length > 0
  && wake.selector.planIds.every((planId) => typeof planId === 'string' && planId.length > 0);
const reservationOk = wake?.reservation === undefined
  || (typeof wake.reservation?.reservation_id === 'string'
    && typeof wake.reservation?.task_id === 'string'
    && Number.isFinite(wake.reservation?.expires_at));
if (wake?.protocol !== PROTOCOL
    || !bindingOk || !selectorOk || !reservationOk
    || /claimToken|claim_token|command|target|authorization|bearer|secret/i.test(serialized)
    || Object.keys(process.env).some((key) => key.startsWith('BIAO_') && key !== 'BIAO_RUNTIME_DIR')) {
  process.exit(2);
}

// 替换点：在这里唤醒真实外部 harness；它随后用本机授权 runtime 自行 register/claim。
console.log(JSON.stringify({
  protocol: PROTOCOL,
  ok: true,
  adapter_id: wake.binding.adapter_id,
  registration_id: `external-${randomUUID()}`,
  harness_kind: wake.binding.harness_kind,
  wake_mode: wake.binding.wake_mode,
  session_ref: 'external-stub-session',
  // 带 reservation 的唤醒必须原样回带，否则 Supervisor 的终校验会拒绝。
  ...(wake.reservation ? {
    task_id: wake.reservation.task_id,
    reservation_id: wake.reservation.reservation_id,
  } : {}),
}));
