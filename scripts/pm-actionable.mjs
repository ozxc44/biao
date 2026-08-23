/** PM 门铃「真正需要唤醒 PM Agent」的事项判定（supervisor 与 pm-agent 共享）。
 *
 * supervisor 在启动 PM Agent 前先过滤；pm-agent 唤醒后用同一份判定决定是否执行
 * PM 命令。两处必须一致：任一侧单独收紧都会退化成“唤醒后无事可做”的空转循环
 * （--require-drained 退出码 4 → 退避重试 → 再唤醒），白白消耗模型 token 与本机 CPU。
 * acceptance_ready 是给验收 Worker/Supervisor 的可执行信号（Worker 侧由事件流
 * 唤醒 claim），不是 PM 必须手工处理的待办。 */
export const PM_ACTIONABLE_KINDS = new Set([
  'review_requested',
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

export function isPmActionableItem(item) {
  if (!item || typeof item !== 'object') return false;
  const kind = typeof item.kind === 'string' ? item.kind : '';
  if (!PM_ACTIONABLE_KINDS.has(kind)) return false;
  // 历史 repair 已排队的 resolution_required 没有 PM 可执行动作；只有真正要求
  // PM 决策的 resolution 才值得唤醒。
  return !(kind === 'resolution_required' && item.resolution_action === 'repair');
}
