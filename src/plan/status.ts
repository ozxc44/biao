/**
 * Plan 终态只由服务端派生投影判定：accepted/resolved 的任务链会折叠为
 * completed，显式放弃会折叠为 cancelled。客户端不应再推演一套任务状态机。
 */
export function isPlanTerminalStatus(status: unknown): boolean {
  return status === 'completed' || status === 'cancelled';
}
