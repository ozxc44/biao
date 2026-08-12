#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREBUILT_RUNTIME_INPUTS, referencedWebRuntimeInputs } from './bootstrap.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageRoot,
  encoding: 'utf8',
});

if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const packed = JSON.parse(result.stdout);
const packagedPaths = new Set((packed[0]?.files ?? []).map((file) => file.path));
const requiredPackageInputs = [
  ...new Set([
    ...PREBUILT_RUNTIME_INPUTS,
    ...referencedWebRuntimeInputs(packageRoot),
    'scripts/verify-package.mjs',
  ]),
];
const missing = requiredPackageInputs.filter((path) => !packagedPaths.has(path));
if (missing.length > 0) {
  console.error(`[biao] 安装包缺少 bootstrap 运行入口：${missing.join('、')}`);
  process.exit(1);
}

console.log(`[biao] 安装包运行时完整：${requiredPackageInputs.length} 个必需入口已包含。`);
