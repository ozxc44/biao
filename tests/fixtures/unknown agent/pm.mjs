#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const protocol = 'biao.pm-adapter/v1';
const wake = JSON.parse(readFileSync(0, 'utf8'));
if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({ ok: true, protocol, role: 'pm' }));
  process.exit(0);
}

const runtimeDir = process.env.BIAO_RUNTIME_DIR;
if (!runtimeDir || !Array.isArray(wake.planIds) || wake.planIds.length !== 1) {
  console.error('[unknown-pm] runtime or single-plan scope missing');
  process.exit(2);
}
const pm = join(runtimeDir, 'pm');
const planId = wake.planIds[0];

function run(args) {
  const result = spawnSync(pm, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[unknown-pm] command failed: ${args.join(' ')}\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const unacked = JSON.parse(run([
  'pm', 'unacked', '--consumer', wake.consumer, '--plan', planId,
  '--type', 'review_requested', '--json',
]));
const events = Array.isArray(unacked.data) ? unacked.data : [];
for (const event of events) {
  if (!event.task_id || !event.event_id) continue;
  run(['review', event.task_id, '--accept', '--comment', 'isolated unknown PM adapter acceptance']);
  run(['pm', 'ack', '--consumer', wake.consumer, '--plan', planId, '--event-id', event.event_id]);
}

writeFileSync(join(runtimeDir, 'pm-adapter-receipt.json'), `${JSON.stringify({
  protocol,
  target: process.env.BIAO_PM_TARGET || '',
  planId,
  accepted: events.map((event) => event.task_id).filter(Boolean),
})}\n`, 'utf8');
console.log(`[unknown-pm] accepted ${events.length} item(s) for ${planId}`);

