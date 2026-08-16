#!/usr/bin/env node

/**
 * V1 work/ 清点报告脚本（Phase 7a）
 *
 * 清点 .biao 生产 V1 work 目录中仍在审计期的 result/verify 文件清单与 Artifact 上传计划。
 * 实际迁移执行不阻塞本阶段，验收门禁（抽样可读+无未解释缺口）挂到清点报告完成度。
 *
 * 用法：
 *   node scripts/v1-work-inventory.mjs --work-dir .biao/work [--db data/biao.sqlite]
 *
 * 对应 §21 Phase 7 末段要求。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

function parseArgs(args) {
  const result = { workDir: '.biao/work', dbPath: 'data/biao.sqlite' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--work-dir' && args[i + 1]) result.workDir = args[++i];
    if (args[i] === '--db' && args[i + 1]) result.dbPath = args[++i];
  }
  return result;
}

function scanWorkDir(workDir) {
  if (!existsSync(workDir)) {
    return { total: 0, entries: [], error: `目录不存在: ${workDir}` };
  }

  const entries = [];
  const errors = [];

  function walk(dir, prefix = '') {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else if (entry.isFile()) {
          try {
            const stat = statSync(fullPath);
            const ext = extname(entry.name);
            const isResult = entry.name.includes('result') || ext === '.json';
            const isVerify = entry.name.includes('verify');

            entries.push({
              path: relPath,
              fullPath,
              size: stat.size,
              modified: stat.mtime.toISOString(),
              type: isResult ? 'result' : isVerify ? 'verify' : 'other',
              readable: true,
            });
          } catch (err) {
            errors.push({ path: relPath, error: err.message });
            entries.push({
              path: relPath,
              fullPath,
              size: 0,
              modified: '',
              type: 'error',
              readable: false,
            });
          }
        }
      }
    } catch (err) {
      errors.push({ path: prefix || '.', error: err.message });
    }
  }

  walk(workDir);

  return {
    total: entries.length,
    results: entries.filter((e) => e.type === 'result').length,
    verifies: entries.filter((e) => e.type === 'verify').length,
    others: entries.filter((e) => e.type === 'other').length,
    errors: errors.length,
    entries,
    errorList: errors,
  };
}

function generateReport(scan, workDir) {
  const lines = [];
  lines.push('# V1 work/ 清点报告');
  lines.push('');
  lines.push(`扫描目录: ${workDir}`);
  lines.push(`扫描时间: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 总文件数: ${scan.total}`);
  lines.push(`- result 文件: ${scan.results}`);
  lines.push(`- verify 文件: ${scan.verifies}`);
  lines.push(`- 其他文件: ${scan.others}`);
  lines.push(`- 读取错误: ${scan.errors}`);
  lines.push('');

  if (scan.errors > 0) {
    lines.push('## 读取错误');
    lines.push('');
    for (const err of scan.errorList) {
      lines.push(`- \`${err.path}\`: ${err.error}`);
    }
    lines.push('');
  }

  // Artifact 上传计划
  lines.push('## Artifact 上传计划');
  lines.push('');
  const resultFiles = scan.entries.filter((e) => e.type === 'result' && e.readable);
  if (resultFiles.length === 0) {
    lines.push('无可上传的 result 文件。');
  } else {
    lines.push('| 文件路径 | 大小 | 修改时间 | 状态 |');
    lines.push('|----------|------|----------|------|');
    for (const file of resultFiles.slice(0, 50)) {
      lines.push(`| \`${file.path}\` | ${file.size} | ${file.modified} | 待上传 |`);
    }
    if (resultFiles.length > 50) {
      lines.push(`| ... | | | 共 ${resultFiles.length} 个 |`);
    }
  }
  lines.push('');

  // 抽样可读性检查
  lines.push('## 抽样可读性检查');
  lines.push('');
  const sampleSize = Math.min(10, Math.ceil(resultFiles.length * 0.1));
  const sample = resultFiles.slice(0, sampleSize);
  let allReadable = true;
  for (const file of sample) {
    try {
      readFileSync(file.fullPath, 'utf8');
      lines.push(`- ✅ \`${file.path}\` — 可读`);
    } catch (err) {
      lines.push(`- ❌ \`${file.path}\` — 不可读: ${err.message}`);
      allReadable = false;
    }
  }
  lines.push('');
  lines.push(`抽样结果: ${allReadable ? '全部可读' : '存在不可读文件'}`);
  lines.push('');

  // 缺口分析
  lines.push('## 缺口分析');
  lines.push('');
  const resultBasenames = new Set(resultFiles.map((f) => f.path.replace(/result/g, '').replace(/\.[^.]+$/, '')));
  const verifyFiles = scan.entries.filter((e) => e.type === 'verify' && e.readable);
  const verifyBasenames = new Set(verifyFiles.map((f) => f.path.replace(/verify/g, '').replace(/\.[^.]+$/, '')));

  const missingVerify = resultFiles.filter((f) => {
    const base = f.path.replace(/result/g, '').replace(/\.[^.]+$/, '');
    return !verifyBasenames.has(base);
  });

  if (missingVerify.length === 0) {
    lines.push('所有 result 文件均有对应的 verify 文件。');
  } else {
    lines.push(`以下 ${missingVerify.length} 个 result 文件缺少 verify 文件：`);
    lines.push('');
    for (const file of missingVerify.slice(0, 20)) {
      lines.push(`- \`${file.path}\``);
    }
    if (missingVerify.length > 20) {
      lines.push(`- ... 共 ${missingVerify.length} 个`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

const args = parseArgs(process.argv.slice(2));
const scan = scanWorkDir(args.workDir);
const report = generateReport(scan, args.workDir);

console.log(report);

// 输出 JSON 摘要供自动化消费
const summary = {
  total: scan.total,
  results: scan.results,
  verifies: scan.verifies,
  others: scan.others,
  errors: scan.errors,
  sampling_ok: scan.entries.filter((e) => e.type === 'result').slice(0, 10).every((e) => e.readable),
};
console.log('\n--- JSON Summary ---');
console.log(JSON.stringify(summary, null, 2));
