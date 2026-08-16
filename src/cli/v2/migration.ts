import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  applyProjectMappings,
  formatProjectMappingReport,
  rebindProjectMapping,
  rollbackProjectRebind,
  scanProjectMappings,
  type ProjectMappingScan,
} from '../../migration/project-mapping.js';

export type MigrationCommand = 'scan' | 'preview' | 'apply' | 'report' | 'rebind' | 'rollback';

export interface ParsedMigrationCommand {
  command: MigrationCommand;
  dbPath: string;
  confirmed: boolean;
  actorId: string;
  reason: string;
  legacyProjectPath: string;
  targetProjectId: string;
  expectedPreviousFingerprint: string;
  expectedNewFingerprint: string;
  auditId: string;
}

type MigrationIo = Pick<Console, 'log' | 'error'>;

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? '' : '';
}

export function parseMigrationCommand(args: string[]): ParsedMigrationCommand {
  const first = args[0];
  const command = (first && !first.startsWith('-') ? first : 'preview') as MigrationCommand;
  const commands: MigrationCommand[] = ['scan', 'preview', 'apply', 'report', 'rebind', 'rollback'];
  if (!commands.includes(command)) throw new Error(`unknown migration command: ${command}`);
  return {
    command,
    dbPath: option(args, '--db') || process.env.BIAO_SQLITE_PATH || 'data/biao.sqlite',
    confirmed: args.includes('--confirm'),
    actorId: option(args, '--actor'),
    reason: option(args, '--reason'),
    legacyProjectPath: option(args, '--path'),
    targetProjectId: option(args, '--project-id'),
    expectedPreviousFingerprint: option(args, '--expected-old-fingerprint'),
    expectedNewFingerprint: option(args, '--expected-new-fingerprint'),
    auditId: option(args, '--audit-id'),
  };
}

function printSummary(result: ProjectMappingScan, io: MigrationIo): void {
  io.log(`scanned: ${result.entries.length}`);
  io.log(`mapped: ${result.summary.mapped}`);
  io.log(`blocked: ${result.summary.blocked}`);
  io.log(`conflict: ${result.summary.conflict}`);
  io.log(`rebind-needed: ${result.summary['rebind-needed']}`);
}

function requireApplyConfirmation(parsed: ParsedMigrationCommand): void {
  if (!parsed.confirmed || !parsed.actorId) {
    throw new Error('apply requires --confirm and --actor <identity>; preview is the default');
  }
}

function requireOption(value: string, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

export function runMigrationCli(args: string[], io: MigrationIo = console): number {
  let parsed: ParsedMigrationCommand;
  try {
    parsed = parseMigrationCommand(args);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!existsSync(parsed.dbPath)) {
    io.error(`database does not exist: ${parsed.dbPath}`);
    return 2;
  }

  const readOnly = ['scan', 'preview', 'report'].includes(parsed.command);
  const db = new Database(parsed.dbPath, { readonly: readOnly });
  try {
    if (parsed.command === 'rebind') {
      requireApplyConfirmation(parsed);
      const result = rebindProjectMapping(db, {
        legacyProjectPath: requireOption(parsed.legacyProjectPath, '--path'),
        targetProjectId: requireOption(parsed.targetProjectId, '--project-id'),
        expectedPreviousFingerprint: requireOption(
          parsed.expectedPreviousFingerprint,
          '--expected-old-fingerprint',
        ),
        expectedNewFingerprint: requireOption(parsed.expectedNewFingerprint, '--expected-new-fingerprint'),
        actorId: parsed.actorId,
        reason: requireOption(parsed.reason, '--reason'),
      });
      io.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (parsed.command === 'rollback') {
      requireApplyConfirmation(parsed);
      const result = rollbackProjectRebind(db, {
        auditId: requireOption(parsed.auditId, '--audit-id'),
        actorId: parsed.actorId,
        reason: requireOption(parsed.reason, '--reason'),
      });
      io.log(JSON.stringify(result, null, 2));
      return 0;
    }

    const scan = scanProjectMappings(db);
    if (parsed.command === 'scan') {
      io.log(JSON.stringify(scan, null, 2));
    } else if (parsed.command === 'report') {
      io.log(formatProjectMappingReport(scan));
    } else if (parsed.command === 'apply') {
      requireApplyConfirmation(parsed);
      const result = applyProjectMappings(db, scan, {
        confirmedBy: parsed.actorId,
        reason: parsed.reason || undefined,
      });
      io.log(`applied: ${result.applied}; skipped: ${result.skipped}`);
      printSummary(result, io);
    } else {
      printSummary(scan, io);
    }
    return scan.summary.conflict > 0 ? 1 : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = runMigrationCli(process.argv.slice(2));
}
