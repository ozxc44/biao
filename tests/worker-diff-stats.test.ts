/**
 * collectDiffStats 回归：证据卡的 diff 统计来自 git diff --numstat HEAD，
 * 非 git 目录安全返回 undefined，绝不阻塞交付。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectDiffStats } from '../src/worker/base.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}

describe('collectDiffStats', () => {
  it('统计 HEAD 与工作区之间的行变更（含二进制文件计入 files 不计入行数）', () => {
    const repo = mkdtempSync(join(tmpdir(), 'biao-diff-stats-'));
    tempDirs.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'bin.dat'), 'OLD-BINARY');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');

    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    writeFileSync(join(repo, 'bin.dat'), 'NEW-BINARY\x00');
    writeFileSync(join(repo, 'new.txt'), 'brand new\n');
    // 未 add 的新文件不在 diff HEAD 范围内，不计入；暂存的计入。
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'staged.txt'), 'staged\n');
    git(repo, 'add', 'sub/staged.txt');

    const stats = collectDiffStats(repo);
    // a.txt 2→5 行（+3）、bin.dat 二进制、sub/staged.txt +1（未 add 的 new.txt 不算）。
    expect(stats).toEqual({ files: 3, insertions: 4, deletions: 0 });
  });

  it('工作区干净时返回 undefined；非 git 目录同样返回 undefined', () => {
    const repo = mkdtempSync(join(tmpdir(), 'biao-diff-stats-clean-'));
    tempDirs.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'stable\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    expect(collectDiffStats(repo)).toBeUndefined();

    const plain = mkdtempSync(join(tmpdir(), 'biao-diff-stats-plain-'));
    tempDirs.push(plain);
    writeFileSync(join(plain, 'a.txt'), 'x\n');
    expect(collectDiffStats(plain)).toBeUndefined();
  });
});
