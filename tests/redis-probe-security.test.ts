import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeCli() {
  const root = mkdtempSync(join(tmpdir(), 'biao-redis-probe-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const argv = join(root, 'argv.txt');
  const env = join(root, 'env.txt');
  const script = join(bin, 'redis-cli');
  writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROBE_ARGV"\nprintf "%s|%s|%s|%s|%s" "${REDISCLI_AUTH-unset}" "${BIAO_REDIS_URL-unset}" "${BIAO_REDIS_PROBE_URL-unset}" "${BIAO_API_TOKEN-unset}" "${BIAO_BOOTSTRAP_TOKEN-unset}" > "$PROBE_ENV"\nprintf "PONG\\n"\n', { mode: 0o755 });
  chmodSync(script, 0o755);
  return { root, bin, argv, env };
}

describe('Redis bootstrap probe security', () => {
  it('keeps password out of argv/output and strips unrelated credentials', () => {
    const fake = fakeCli();
    const url = 'rediss://acl%20user:p%40ss@redis.example:6380/7';
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'redis-probe.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake.bin}${delimiter}${process.env.PATH ?? ''}`,
        PROBE_ARGV: fake.argv,
        PROBE_ENV: fake.env,
        BIAO_REDIS_PROBE_URL: url,
        BIAO_REDIS_URL: 'must-not-cross',
        BIAO_API_TOKEN: 'must-not-cross',
        BIAO_BOOTSTRAP_TOKEN: 'must-not-cross',
      },
    });
    expect(run.status).toBe(0);
    const argv = readFileSync(fake.argv, 'utf8');
    const childEnv = readFileSync(fake.env, 'utf8');
    expect(argv).toContain('redis.example');
    expect(argv).toContain('acl user');
    expect(argv).toContain('--tls');
    expect(argv).not.toContain('p@ss');
    expect(argv).not.toContain(url);
    expect(childEnv).toBe('p@ss|unset|unset|unset|unset');
    expect(`${run.stdout}${run.stderr}`).not.toContain('p@ss');
  });

  it('supports redis:///db and rejects query without leaking it', () => {
    const fake = fakeCli();
    const script = join(import.meta.dirname, '..', 'scripts', 'redis-probe.mjs');
    const safe = spawnSync(process.execPath, [script], {
      env: { ...process.env, PATH: `${fake.bin}${delimiter}${process.env.PATH ?? ''}`, PROBE_ARGV: fake.argv, PROBE_ENV: fake.env, BIAO_REDIS_PROBE_URL: 'redis:///2' },
      encoding: 'utf8',
    });
    expect(safe.status).toBe(0);
    expect(readFileSync(fake.argv, 'utf8')).toContain('127.0.0.1');
    expect(readFileSync(fake.argv, 'utf8')).toContain('2');

    const secretUrl = 'redis://private:secret@example.test/0?query-secret=yes';
    const rejected = spawnSync(process.execPath, [script], { env: { ...process.env, BIAO_REDIS_PROBE_URL: secretUrl }, encoding: 'utf8' });
    expect(rejected.status).toBe(1);
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain(secretUrl);
    expect(`${rejected.stdout}${rejected.stderr}`).not.toContain('secret');
  });

  it('通过符号链接或系统别名路径直接执行时不会假成功跳过探测', () => {
    const fake = fakeCli();
    const script = join(import.meta.dirname, '..', 'scripts', 'redis-probe.mjs');
    const alias = join(fake.root, 'redis-probe-alias.mjs');
    symlinkSync(script, alias);

    const run = spawnSync(process.execPath, [alias], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake.bin}${delimiter}${process.env.PATH ?? ''}`,
        PROBE_ARGV: fake.argv,
        PROBE_ENV: fake.env,
        BIAO_REDIS_PROBE_URL: 'redis://127.0.0.1:6380/4',
      },
    });

    expect(run.status).toBe(0);
    expect(readFileSync(fake.argv, 'utf8')).toContain('6380');
  });
});
