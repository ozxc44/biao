/**
 * 22.3-06：sanitizedChildEnv 直接单测（失败优先）。
 *
 * src/worker/base.ts 的 sanitizedChildEnv 是 Agent / verify 子进程的环境
 * 边界，注释宣称"不能继承 Biao 控制面/持久化凭据"——本文件把它按字面
 * 验收：剥离全部 BIAO_* 与凭据类变量、保留白名单必需变量、不修改原对象。
 *
 * env 纪律：测试内写入 process.env 的键在 afterEach 统一 save/restore，
 * 不污染 singleFork 串行的其它测试。
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sanitizedChildEnv } from '../src/worker/base.js';
import { V2_CREDENTIAL_KEY_ENV } from '../src/server/v2/credentials.js';

const savedEnv: Record<string, string | undefined> = {};

/** env 纪律：记录原始值后写入（undefined 表示原本不存在）。 */
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  // 双保险：afterEach 已恢复；这里只确认清理表为空语义（不重复恢复）。
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

describe('22.3-06: sanitizedChildEnv 子进程环境剥离', () => {
  it('剥离全部 BIAO_* 前缀变量（含旧清单外的任意 BIAO_ 变量）', () => {
    setEnv('BIAO_API_TOKEN', 'tok-secret');
    setEnv('BIAO_REDIS_URL', 'redis://:pass@127.0.0.1:6379');
    setEnv('BIAO_SQLITE_PATH', 'data/biao.sqlite');
    setEnv(V2_CREDENTIAL_KEY_ENV, 'aabbccdd'.repeat(8)); // BIAO_V2_CREDENTIAL_KEY
    setEnv('BIAO_URL', 'http://127.0.0.1:7331');
    setEnv('BIAO_EXEC_CMD', 'echo leaked');
    setEnv('BIAO_SOMETHING_NEW', 'future-var');

    const childEnv = sanitizedChildEnv();
    for (const key of [
      'BIAO_API_TOKEN',
      'BIAO_REDIS_URL',
      'BIAO_SQLITE_PATH',
      V2_CREDENTIAL_KEY_ENV,
      'BIAO_URL',
      'BIAO_EXEC_CMD',
      'BIAO_SOMETHING_NEW',
    ]) {
      expect(childEnv[key], `${key} 必须被剥离`).toBeUndefined();
    }
  });

  it('剥离非 BIAO_ 前缀的凭据类服务变量（REDIS_URL/REDIS_PASSWORD/REDISCLI_AUTH）', () => {
    setEnv('REDIS_URL', 'redis://:pass@127.0.0.1:6380');
    setEnv('REDIS_PASSWORD', 'pass-123');
    setEnv('REDISCLI_AUTH', 'pass-123');

    const childEnv = sanitizedChildEnv();
    expect(childEnv.REDIS_URL).toBeUndefined();
    expect(childEnv.REDIS_PASSWORD).toBeUndefined();
    expect(childEnv.REDISCLI_AUTH).toBeUndefined();
  });

  it('保留白名单必需变量（PATH/HOME 等）与 Agent 自身运行所需变量', () => {
    setEnv('SANITIZED_CHILD_ENV_TEST_NEUTRAL', 'keep-me');
    setEnv('ANTHROPIC_API_KEY', 'agent-own-key');

    const childEnv = sanitizedChildEnv();
    // 必需变量：与当前进程一致（PATH/HOME/LANG 属于子进程运行刚需）
    expect(childEnv.PATH).toBe(process.env.PATH);
    expect(childEnv.HOME).toBe(process.env.HOME);
    expect(childEnv.LANG).toBe(process.env.LANG);
    // 中性变量与 Agent 供应商 key 不在剥离面
    expect(childEnv.SANITIZED_CHILD_ENV_TEST_NEUTRAL).toBe('keep-me');
    expect(childEnv.ANTHROPIC_API_KEY).toBe('agent-own-key');
  });

  it('overrides 正常合并；overrides 里的 BIAO_* 同样被剥离（fail-closed）', () => {
    const childEnv = sanitizedChildEnv({
      CUSTOM_FLAG: '1',
      BIAO_API_TOKEN: 'override-tok',
      REDIS_URL: 'redis://override',
    });
    expect(childEnv.CUSTOM_FLAG).toBe('1');
    // 显式 override 不能绕过剥离：调用方误传凭据也不下发子进程
    expect(childEnv.BIAO_API_TOKEN).toBeUndefined();
    expect(childEnv.REDIS_URL).toBeUndefined();
  });

  it('不修改原对象：process.env 与传入 overrides 均保持原样', () => {
    setEnv('BIAO_API_TOKEN', 'must-stay-in-parent');
    setEnv('NEUTRAL_ORIGIN', 'origin-value');
    const overrides: Record<string, string> = {
      BIAO_API_TOKEN: 'override-must-stay',
      KEEP_ME: 'stay',
    };
    const overridesSnapshot = { ...overrides };

    const childEnv = sanitizedChildEnv(overrides);

    // process.env 未被修改（敏感值仍留在父进程，中性值原样）
    expect(process.env.BIAO_API_TOKEN).toBe('must-stay-in-parent');
    expect(process.env.NEUTRAL_ORIGIN).toBe('origin-value');
    // overrides 对象未被修改（键未被删除/改写）
    expect(overrides).toEqual(overridesSnapshot);
    // 返回的是全新对象：对返回值的写不回写 process.env
    expect(childEnv).not.toBe(process.env);
    childEnv.BIAO_API_TOKEN = 'post-mutation';
    expect(process.env.BIAO_API_TOKEN).toBe('must-stay-in-parent');
  });
});
