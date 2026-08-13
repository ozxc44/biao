#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantsHelp = args.includes('--help') || args.includes('-h');
const useShellBootstrap = process.platform !== 'win32' && !wantsHelp;
const command = useShellBootstrap ? '/bin/sh' : process.execPath;
const entry = useShellBootstrap
  ? resolve(packageRoot, 'bootstrap.sh')
  : resolve(packageRoot, 'scripts', 'bootstrap.mjs');
const result = spawnSync(command, [entry, ...args], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[biao-bootstrap] 启动失败：${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`[biao-bootstrap] 被信号 ${result.signal} 中止`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
