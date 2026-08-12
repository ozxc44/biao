#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function sanitizedEnvironment() {
  const env = { ...process.env };
  delete env.BIAO_REDIS_URL;
  delete env.BIAO_REDIS_PROBE_URL;
  delete env.BIAO_API_TOKEN;
  delete env.BIAO_BOOTSTRAP_TOKEN;
  delete env.REDISCLI_AUTH;
  return env;
}

function parseRedisUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Redis URL 无效');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('Redis URL 只支持 redis:// 或 rediss://');
  }
  if (url.search || url.hash) throw new Error('Redis URL 不支持 query 或 fragment');
  if (url.pathname && !/^\/\d+$/.test(url.pathname)) throw new Error('Redis URL 的 database 必须是非负整数');
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (username && !password) throw new Error('Redis ACL username 必须同时提供 password');
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port || '6379',
    database: url.pathname ? url.pathname.slice(1) : '0',
    username,
    password,
    tls: url.protocol === 'rediss:',
  };
}

export function runRedisProbe(raw = process.env.BIAO_REDIS_PROBE_URL) {
  if (!raw) throw new Error('缺少 Redis URL');
  const config = parseRedisUrl(raw);
  const args = ['-h', config.host, '-p', config.port, '-n', config.database];
  if (config.tls) args.push('--tls', '--sni', config.host);
  if (config.username) args.push('--user', config.username);
  args.push('ping');
  const env = sanitizedEnvironment();
  if (config.password) env.REDISCLI_AUTH = config.password;
  const result = spawnSync('redis-cli', args, { env, encoding: 'utf8' });
  return !result.error && result.status === 0 && result.stdout.trim() === 'PONG';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(runRedisProbe() ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
