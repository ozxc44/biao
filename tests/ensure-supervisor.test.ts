/**
 * maybeEnsureSupervisor 自愈入口测试
 * 覆盖：
 *  - 未开启 BIAO_SUPERVISOR_AUTO_ENSURE 时不拉起任何进程
 *  - pm-watch 目标缺失时安全跳过
 *  - 开启后以 --ensure 拉起指定 BIAO_PM_WATCH_CMD
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeEnsureSupervisor, resetEnsureThrottleForTests } from '../src/worker/ensure-supervisor.js';

const ENABLE_KEY = 'BIAO_SUPERVISOR_AUTO_ENSURE';
const COMMAND_KEY = 'BIAO_PM_WATCH_CMD';

beforeEach(() => {
  resetEnsureThrottleForTests();
});

afterEach(() => {
  process.env[ENABLE_KEY] = '0';
  delete process.env[COMMAND_KEY];
});

function writeFakeWatcher(directory: string): string {
  const path = join(directory, 'pm-watch');
  writeFileSync(path, `#!/usr/bin/env sh\necho "$@" >> '${directory}/ensure.log'\n`, { mode: 0o755 });
  return path;
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe('maybeEnsureSupervisor', () => {
  it('默认关闭：未设置开关时不拉起任何进程', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-off-'));
    try {
      process.env[COMMAND_KEY] = writeFakeWatcher(directory);
      maybeEnsureSupervisor();
      expect(await waitFor(() => existsSync(join(directory, 'ensure.log')))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('目标脚本缺失时安全跳过，不抛错', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-missing-'));
    try {
      process.env[ENABLE_KEY] = '1';
      process.env[COMMAND_KEY] = join(directory, 'not-exist');
      expect(() => maybeEnsureSupervisor()).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('开启后以 --ensure 后台拉起 pm-watch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-on-'));
    try {
      process.env[ENABLE_KEY] = '1';
      process.env[COMMAND_KEY] = writeFakeWatcher(directory);
      maybeEnsureSupervisor();
      const marker = join(directory, 'ensure.log');
      expect(await waitFor(() => existsSync(marker))).toBe(true);
      expect(readFileSync(marker, 'utf8').trim()).toBe('--ensure');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('机器级兜底：env 未带开关时读取 wrapper 同目录 config.env 的 opt-in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-file-'));
    try {
      writeFileSync(join(directory, 'config.env'), "BIAO_SUPERVISOR_AUTO_ENSURE='1'\n");
      process.env[COMMAND_KEY] = writeFakeWatcher(directory);
      delete process.env[ENABLE_KEY];
      maybeEnsureSupervisor();
      const marker = join(directory, 'ensure.log');
      expect(await waitFor(() => existsSync(marker))).toBe(true);
    } finally {
      process.env[ENABLE_KEY] = '0';
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('显式 env 关闭优先于 config.env 的 opt-in', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-env-wins-'));
    try {
      writeFileSync(join(directory, 'config.env'), "BIAO_SUPERVISOR_AUTO_ENSURE='1'\n");
      process.env[ENABLE_KEY] = '0';
      process.env[COMMAND_KEY] = writeFakeWatcher(directory);
      maybeEnsureSupervisor();
      expect(await waitFor(() => existsSync(join(directory, 'ensure.log')))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('config.env 未声明 opt-in 时保持默认关闭', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'biao-ensure-file-off-'));
    try {
      writeFileSync(join(directory, 'config.env'), "BIAO_URL='http://central:7331'\n");
      process.env[COMMAND_KEY] = writeFakeWatcher(directory);
      delete process.env[ENABLE_KEY];
      maybeEnsureSupervisor();
      expect(await waitFor(() => existsSync(join(directory, 'ensure.log')))).toBe(false);
    } finally {
      process.env[ENABLE_KEY] = '0';
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
