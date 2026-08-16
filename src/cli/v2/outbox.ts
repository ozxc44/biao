/**
 * V2 CLI Outbox 子命令（Phase 7a）
 *
 * biao v2 outbox dead-letter list|show|requeue|compensate
 * 沿用现有 CLI 严格选项校验风格。
 *
 * 对应 §14.5（outbox 语义）、§21 Phase 7 原文。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteStore } from '../../db/sqlite-store.js';
import { markOutboxStatus } from '../../server/v2/outbox.js';
import { randomUUID } from 'node:crypto';

export type OutboxCommand = 'list' | 'show' | 'requeue' | 'compensate';

export interface ParsedOutboxCommand {
  command: OutboxCommand;
  dbPath: string;
  eventId: string;
  reason: string;
  json: boolean;
  limit: number;
  /** 22.4-20：compensate 审计行的 actor（cli 操作者标识，默认 cli-operator）。 */
  actor: string;
}

type OutboxIo = Pick<Console, 'log' | 'error'>;

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
}

export function parseOutboxCommand(args: string[]): ParsedOutboxCommand {
  // 解析子命令：dead-letter list|show|requeue|compensate
  // 支持两种形式：
  //   biao v2 outbox dead-letter list
  //   biao v2 outbox dead-letter show --event-id xxx
  const deadLetterIdx = args.indexOf('dead-letter');
  let subArgs = args;
  if (deadLetterIdx >= 0) {
    subArgs = args.slice(deadLetterIdx + 1);
  }

  const first = subArgs[0];
  const command = (first && !first.startsWith('-') ? first : 'list') as OutboxCommand;
  const commands: OutboxCommand[] = ['list', 'show', 'requeue', 'compensate'];
  if (!commands.includes(command)) throw new Error(`unknown outbox command: ${command}`);

  return {
    command,
    dbPath: option(args, '--db') || process.env.BIAO_SQLITE_PATH || 'data/biao.sqlite',
    eventId: option(subArgs, '--event-id') || option(args, '--event-id'),
    reason: option(subArgs, '--reason') || option(args, '--reason') || '',
    actor: option(subArgs, '--actor') || option(args, '--actor') || 'cli-operator',
    json: args.includes('--json'),
    limit: parseInt(option(args, '--limit') || '50', 10),
  };
}

export function runOutboxCli(args: string[], io: OutboxIo = console): number {
  let parsed: ParsedOutboxCommand;
  try {
    parsed = parseOutboxCommand(args);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (!existsSync(parsed.dbPath)) {
    io.error(`database does not exist: ${parsed.dbPath}`);
    return 2;
  }

  const store = new SqliteStore(parsed.dbPath);
  try {
    switch (parsed.command) {
      case 'list':
        return cmdList(store, parsed, io);
      case 'show':
        return cmdShow(store, parsed, io);
      case 'requeue':
        return cmdRequeue(store, parsed, io);
      case 'compensate':
        return cmdCompensate(store, parsed, io);
      default:
        io.error(`unknown command: ${parsed.command}`);
        return 2;
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store.close();
  }
}

function cmdList(store: SqliteStore, parsed: ParsedOutboxCommand, io: OutboxIo): number {
  const deadLetters = store.listOutboxEvents('dead_letter', parsed.limit);
  if (parsed.json) {
    io.log(JSON.stringify({ ok: true, data: { items: deadLetters, count: deadLetters.length } }, null, 2));
  } else {
    if (deadLetters.length === 0) {
      io.log('没有 dead-letter 事件');
      return 0;
    }
    io.log(`dead-letter 事件 (${deadLetters.length} 条):`);
    for (const ev of deadLetters) {
      io.log(`  ${ev.event_id}  ${ev.aggregate_type}/${ev.aggregate_id}  attempts=${ev.attempt_count}  dead_lettered_at=${ev.dead_lettered_at ? new Date(ev.dead_lettered_at).toISOString() : '-'}`);
    }
  }
  return 0;
}

function cmdShow(store: SqliteStore, parsed: ParsedOutboxCommand, io: OutboxIo): number {
  if (!parsed.eventId) {
    io.error('--event-id is required for show');
    return 2;
  }
  const event = store.getOutboxEvent(parsed.eventId);
  if (!event) {
    io.error(`event ${parsed.eventId} not found`);
    return 1;
  }
  if (parsed.json) {
    io.log(JSON.stringify({ ok: true, data: event }, null, 2));
  } else {
    io.log(`event_id:           ${event.event_id}`);
    io.log(`aggregate_type:     ${event.aggregate_type}`);
    io.log(`aggregate_id:       ${event.aggregate_id}`);
    io.log(`aggregate_revision: ${event.aggregate_revision}`);
    io.log(`status:             ${event.status}`);
    io.log(`attempt_count:      ${event.attempt_count}`);
    io.log(`last_error:         ${event.last_error || '(none)'}`);
    io.log(`dead_lettered_at:   ${event.dead_lettered_at ? new Date(event.dead_lettered_at).toISOString() : '-'}`);
    io.log(`payload_digest:     ${event.payload_digest.slice(0, 16)}...`);
    io.log(`compensates_event:  ${event.compensates_event_id || '(none)'}`);
  }
  return 0;
}

function cmdRequeue(store: SqliteStore, parsed: ParsedOutboxCommand, io: OutboxIo): number {
  if (!parsed.eventId) {
    io.error('--event-id is required for requeue');
    return 2;
  }
  const event = store.getOutboxEvent(parsed.eventId);
  if (!event) {
    io.error(`event ${parsed.eventId} not found`);
    return 1;
  }
  if (event.status !== 'dead_letter') {
    io.error(`event ${parsed.eventId} status is ${event.status}, not dead_letter`);
    return 1;
  }

  // requeue = 重置为 pending，清零 attempt_count，立即可重试
  markOutboxStatus(store, parsed.eventId, 'pending', {
    last_error: `requeued: ${parsed.reason || 'manual requeue'}`,
    next_attempt_at: Date.now(),
  });
  // 清零 attempt_count 以便重新投递
  store.updateOutboxEvent(parsed.eventId, {
    attempt_count: 0,
    dead_lettered_at: null,
  });

  if (parsed.json) {
    io.log(JSON.stringify({ ok: true, data: { event_id: parsed.eventId, status: 'pending' } }, null, 2));
  } else {
    io.log(`event ${parsed.eventId} requeued to pending`);
  }
  return 0;
}

function cmdCompensate(store: SqliteStore, parsed: ParsedOutboxCommand, io: OutboxIo): number {
  if (!parsed.eventId) {
    io.error('--event-id is required for compensate');
    return 2;
  }
  const event = store.getOutboxEvent(parsed.eventId);
  if (!event) {
    io.error(`event ${parsed.eventId} not found`);
    return 1;
  }
  if (event.status !== 'dead_letter') {
    io.error(`event ${parsed.eventId} status is ${event.status}, not dead_letter`);
    return 1;
  }

  // 创建补偿事件（compensates_event_id 指向原事件）
  const compensatingEventId = `evt-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const ts = Date.now();
  store.insertOutboxEvent({
    event_id: compensatingEventId,
    project_id: event.project_id,
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    aggregate_revision: event.aggregate_revision + 1,
    payload_digest: event.payload_digest,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: ts,
    last_error: '',
    dead_lettered_at: null,
    compensates_event_id: event.event_id,
  });

  // 22.4-20：compensate 是人工干预动作，必须留审计行（append-only）：
  // - actor = cli 操作者（--actor，默认 cli-operator）；
  // - correlation_id = 被补偿的 dead-letter event_id（回溯链路锚点）；
  // - evidence_digest 沿用原事件 payload digest（证据指纹不变）。
  store.insertAuditEvent({
    audit_id: `aud-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    project_id: event.project_id,
    actor_id: parsed.actor,
    action: 'outbox.compensate',
    subject_type: 'outbox_event',
    subject_id: compensatingEventId,
    correlation_id: event.event_id,
    evidence_digest: event.payload_digest,
    created_at: ts,
  });

  if (parsed.json) {
    io.log(JSON.stringify({ ok: true, data: { compensating_event_id: compensatingEventId, compensates: parsed.eventId, audit: { actor: parsed.actor, correlation_id: event.event_id } } }, null, 2));
  } else {
    io.log(`补偿事件 ${compensatingEventId} 已创建，补偿原事件 ${parsed.eventId}（审计 actor=${parsed.actor}）`);
  }
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = runOutboxCli(process.argv.slice(2));
}
