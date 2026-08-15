#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const protocol = 'biao.worker-executor/v1';
if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({ ok: true, protocol, role: 'worker' }));
  process.exit(0);
}

const [taskId, goalFile, workDir] = process.argv.slice(2);
if (!taskId || !goalFile || !workDir || process.argv.slice(2).length !== 3) {
  console.error('[unknown-worker] expected taskId, goalFile, workDir');
  process.exit(2);
}

const goal = readFileSync(goalFile, 'utf8');
writeFileSync(resolve('adapter-output.txt'), `${JSON.stringify({
  protocol,
  taskId,
  workDir,
  goalSha256: createHash('sha256').update(goal).digest('hex'),
})}\n`, 'utf8');
console.log(`[unknown-worker] delivered ${taskId}`);

