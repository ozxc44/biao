#!/usr/bin/env node

import { resolve } from 'node:path';
import { migrateDatabaseCopy } from '../dist/db/migrate-copy.js';

function usage() {
  console.error('用法: node scripts/migrate-sqlite.mjs --source <旧库> --output <迁移副本>');
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument !== '--source' && argument !== '--output') {
      throw new Error(`未知参数: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少路径`);
    result[argument.slice(2)] = resolve(value);
    index += 1;
  }
  if (!result.source || !result.output) throw new Error('--source 和 --output 均为必填');
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    const report = await migrateDatabaseCopy({
      sourcePath: options.source,
      outputPath: options.output,
    });
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
