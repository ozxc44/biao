/**
 * biao-node session 账本与孤儿扫描（Phase 3）
 *
 * 每次 daemon 启动（register）生成一个本地 boot_id（uuid）。所有 attempt
 * 工作记录只落在 sessions/<boot_id>/ 下。这带来重启安全的两个性质：
 *
 * 1. 零重复 claim 的本地一半：claim（Phase 3 为 inbox 原子 rename，Phase 4
 *    为 /v2/tasks/claim）总是把 attempt 归属到当前 session 目录，旧 session
 *    的记录天然不会被新进程“捡起来继续跑”；
 * 2. 孤儿可审计：重启后扫描其它 boot 目录中未收口的 attempt，只登记为
 *    pending recovery（R3C-003 的 Phase 3 桩：记录与上报，不自行接管），
 *    等待服务端裁决（attempt generation 查询属 Phase 4 接口）。
 *
 * 服务端的另一半由 Phase 1 保证：register 递增 node_session_generation 并
 * fencing 旧 session——旧 session 无法再赢回任何 claim。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** 账本事件（JSONL，每行一个；本地审计，不上传任务正文/机密）。 */
export interface LedgerEvent {
  at_wall: number;
  type:
    | 'session_start'
    | 'adopted'
    | 'renew_ok'
    | 'renew_failed'
    | 'lease_at_risk'
    | 'stopped'
    | 'lease_lost'
    | 'report_attempted'
    | 'report_pending'
    | 'orphaned'
    | 'drain_started'
    | 'drain_completed'
    | 'fenced';
  attempt_id?: string;
  detail?: Record<string, unknown>;
}

export interface OrphanedAttempt {
  attempt_id: string;
  task_id: string;
  generation: number;
  boot_id: string;
  claimed_file: string;
  terminal: boolean;
}

export function sessionDir(sessionsRoot: string, bootId: string): string {
  return join(sessionsRoot, bootId);
}

export function appendLedgerEvent(sessionsRoot: string, bootId: string, event: LedgerEvent): void {
  const dir = sessionDir(sessionsRoot, bootId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

/** 读取指定 boot 的全部账本事件（文件不存在返回空数组）。 */
export function readLedgerEvents(sessionsRoot: string, bootId: string): LedgerEvent[] {
  const file = join(sessionDir(sessionsRoot, bootId), 'ledger.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is LedgerEvent => event !== null);
}

const TERMINAL_ATTEMPT_EVENTS = new Set(['stopped', 'lease_lost']);

/**
 * 扫描“非当前 boot”目录中已被 claim 但未收口的 attempt：
 * 判定依据是该 boot 账本里的 adopted 与 stopped/lease_lost 事件配对。
 * 只输出清单，不执行任何接管动作（裁决权在服务端，Phase 4）。
 */
export function scanOrphanedAttempts(sessionsRoot: string, currentBootId: string): OrphanedAttempt[] {
  if (!existsSync(sessionsRoot)) return [];
  const orphans: OrphanedAttempt[] = [];
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentBootId || entry.name.startsWith('.')) continue;
    const bootId = entry.name;
    const events = readLedgerEvents(sessionsRoot, bootId);
    const adopted = new Map<string, { task_id?: string; generation?: number }>();
    const terminal = new Set<string>();
    for (const event of events) {
      if (!event.attempt_id) continue;
      if (event.type === 'adopted') adopted.set(event.attempt_id, event.detail ?? {});
      if (TERMINAL_ATTEMPT_EVENTS.has(event.type)) terminal.add(event.attempt_id);
    }
    for (const [attemptId, detail] of adopted) {
      if (terminal.has(attemptId)) continue;
      const claimedFile = join(sessionDir(sessionsRoot, bootId), 'claimed', `${attemptId}.json`);
      orphans.push({
        attempt_id: attemptId,
        task_id: typeof detail.task_id === 'string' ? detail.task_id : '',
        generation: typeof detail.generation === 'number' ? detail.generation : 0,
        boot_id: bootId,
        claimed_file: existsSync(claimedFile) ? claimedFile : '',
        terminal: false,
      });
    }
  }
  return orphans;
}
