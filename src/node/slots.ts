/**
 * biao-node 执行槽与占位 executor（Phase 3 · §10.1）
 *
 * §10.1：一个节点一个守护进程，内部多个 slot 共享心跳/租约/升级通道。
 * 本阶段 executor 是占位实现——收到 task attempt 只记录（session 账本 +
 * 工作记录文件），不真正执行；真实执行（Git workspace prepare/commit/
 * push）在 Phase 4 落地，届时 executor 接口不变，仅替换实现。
 *
 * claim 通道（Phase 3 占位）：
 * - 服务端 /v2/tasks/claim 尚为 NOT_IMPLEMENTED stub（缺口清单 #7）；
 * - 因此骨架用“inbox 目录投递 + 原子 rename 认领”模拟同一语义：
 *   rename(2) 是原子的 CAS——即使两个进程同时扫到同一个投递文件，
 *   也只有一个 rename 成功，天然保证“无第二个 claim 赢家”；
 * - Phase 4 切换为真实 claim 后，本目录退化为测试/演练通道。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptStopReason, WatchdogAttempt } from './lease-watchdog.js';

/** inbox 投递文件（即一次 task attempt 的交接单）。 */
export interface AttemptIntake {
  attempt_id: string;
  task_id: string;
  /** attempt_generation：lease 丢失/fencing 判据。 */
  attempt_generation: number;
  /** 相对租约时长（毫秒）——与 lease_expires_at 二选一，优先 duration。 */
  lease_duration_ms?: number;
  /** 服务端 epoch 毫秒的绝对到期时间。 */
  lease_expires_at?: number;
  /** 任务正文占位（Phase 3 不解释、不执行、不外传）。 */
  payload?: Record<string, unknown>;
}

/** 槽位容量表：容量声明 + 占用查询（心跳 slots_in_use 的数据源）。 */
export class SlotTable {
  private readonly busy = new Set<string>();

  constructor(public readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) {
      throw new Error(`slots 数量非法：${capacity}（需要 1~256 整数）`);
    }
  }

  freeCount(): number {
    return this.capacity - this.busy.size;
  }

  inUse(): number {
    return this.busy.size;
  }

  /** 占用一个槽（attempt 去重：同一 attempt 只能占一个槽）。 */
  occupy(attemptId: string): boolean {
    if (this.busy.has(attemptId) || this.busy.size >= this.capacity) return false;
    this.busy.add(attemptId);
    return true;
  }

  release(attemptId: string): void {
    this.busy.delete(attemptId);
  }
}

function assertId(value: string, field: string): void {
  if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`attempt 交接单 ${field} 非法`);
  }
}

/** 解析并校验一份 inbox 投递文件内容；非法即抛错（由调用方移入 .invalid）。 */
export function parseAttemptIntake(raw: string): AttemptIntake {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('attempt 交接单不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('attempt 交接单必须是对象');
  const record = parsed as Record<string, unknown>;
  const intake: AttemptIntake = {
    attempt_id: String(record.attempt_id ?? ''),
    task_id: String(record.task_id ?? ''),
    attempt_generation: Number(record.attempt_generation),
  };
  assertId(intake.attempt_id, 'attempt_id');
  assertId(intake.task_id, 'task_id');
  if (!Number.isInteger(intake.attempt_generation) || intake.attempt_generation < 1) {
    throw new Error('attempt 交接单 attempt_generation 必须是正整数');
  }
  if (record.lease_duration_ms !== undefined) {
    const duration = Number(record.lease_duration_ms);
    if (!Number.isFinite(duration) || duration < 100) throw new Error('attempt 交接单 lease_duration_ms 必须 ≥100ms');
    intake.lease_duration_ms = duration;
  }
  if (record.lease_expires_at !== undefined) {
    const expiry = Number(record.lease_expires_at);
    if (!Number.isFinite(expiry) || expiry <= 0) throw new Error('attempt 交接单 lease_expires_at 非法');
    intake.lease_expires_at = expiry;
  }
  if (intake.lease_duration_ms === undefined && intake.lease_expires_at === undefined) {
    throw new Error('attempt 交接单必须提供 lease_duration_ms 或 lease_expires_at 之一');
  }
  if (record.payload !== undefined && typeof record.payload !== 'object') throw new Error('attempt 交接单 payload 必须是对象');
  if (record.payload !== undefined) intake.payload = record.payload as Record<string, unknown>;
  return intake;
}

/**
 * 占位 executor：只记录，不执行（§ Phase 3 目标 1）。
 * 工作记录与 recovery bundle 都是本地文件，Phase 4 替换为真实执行时
 * 这里的“记录”变成 prepare/finalize 状态机的审计输入。
 */
export class PlaceholderExecutor {
  constructor(private readonly sessionsRoot: string, private readonly bootId: string) {}

  private attemptFile(attemptId: string): string {
    return join(this.sessionsRoot, this.bootId, 'attempts', `${attemptId}.json`);
  }

  /** 认领后记录工作快照。 */
  recordAdopted(intake: AttemptIntake, deadlineWallMs: number): void {
    const dir = join(this.sessionsRoot, this.bootId, 'attempts');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.attemptFile(intake.attempt_id), `${JSON.stringify({
      attempt_id: intake.attempt_id,
      task_id: intake.task_id,
      attempt_generation: intake.attempt_generation,
      adopted_at: Date.now(),
      lease_deadline_at: deadlineWallMs,
      executor: 'placeholder-phase3',
      payload_present: Boolean(intake.payload),
    }, null, 2)}\n`, { mode: 0o600 });
  }

  /** 停止后更新工作记录；lease 相关原因追加 recovery bundle 桩（§10.4）。 */
  recordStopped(attempt: WatchdogAttempt, reason: AttemptStopReason, recoveryRoot: string): void {
    const file = this.attemptFile(attempt.attempt_id);
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      record.stopped_at = Date.now();
      record.stop_reason = reason;
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    }
    if (reason === 'expiry_stop_window' || reason === 'lease_lost' || reason === 'fenced') {
      mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(recoveryRoot, `${attempt.attempt_id}.json`), `${JSON.stringify({
        attempt_id: attempt.attempt_id,
        task_id: attempt.task_id,
        attempt_generation: attempt.generation,
        boot_id: this.bootId,
        reason,
        saved_at: Date.now(),
        // Phase 4：本地 staging + 控制面裁决（R1C-014）；Phase 3 只保留线索。
        status: 'pending_recovery',
        note: 'recovery bundle 桩：网络恢复后由服务端按 attempt generation 裁决上传 orphan bundle 或清理',
      }, null, 2)}\n`, { mode: 0o600 });
    }
  }
}

/**
 * 扫描 inbox 并以原子 rename 认领（Phase 3 的 claim 占位通道）。
 * 返回成功认领的交接单；malformed 文件移入 .invalid/ 留痕。
 */
export function claimInboxAttempts(
  inboxDir: string,
  sessionsRoot: string,
  bootId: string,
  maxCount: number,
): { claimed: AttemptIntake[]; invalid: string[] } {
  const claimed: AttemptIntake[] = [];
  const invalid: string[] = [];
  if (!existsSync(inboxDir) || maxCount <= 0) return { claimed, invalid };
  const entries = readdirSync(inboxDir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  const claimedDir = join(sessionsRoot, bootId, 'claimed');
  mkdirSync(claimedDir, { recursive: true, mode: 0o700 });
  for (const name of entries) {
    if (claimed.length >= maxCount) break;
    const source = join(inboxDir, name);
    const target = join(claimedDir, name);
    try {
      // 原子认领：rename 失败（并发赢家已移走）即跳过——只有一个赢家。
      renameSync(source, target);
    } catch {
      continue;
    }
    try {
      claimed.push(parseAttemptIntake(readFileSync(target, 'utf8')));
    } catch (error) {
      // 认领成功但内容非法：移入 .invalid 留痕，不占槽。
      const invalidDir = join(inboxDir, '.invalid');
      mkdirSync(invalidDir, { recursive: true, mode: 0o700 });
      try {
        renameSync(target, join(invalidDir, name));
      } catch {
        /* 留痕失败不影响主流程 */
      }
      invalid.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { claimed, invalid };
}
