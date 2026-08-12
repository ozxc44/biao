import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, '..');

describe('Worker CLI 帮助', () => {
  for (const [bin, label] of [
    ['codex-worker.js', 'Codex'],
    ['kimi-worker.js', 'Kimi'],
    ['biao-worker.js', 'Custom CLI'],
    ['cli-worker.js', 'Custom CLI'],
  ] as const) {
    it(`${label} 在不连接平台、不领取任务时说明 Question 闭环`, async () => {
      const { stdout } = await execFileAsync(process.execPath, [join(root, 'bin', bin), '--help'], {
        env: { ...process.env, BIAO_URL: 'http://127.0.0.1:1', BIAO_EXEC_CMD: '' },
        encoding: 'utf8',
      });
      expect(stdout).toContain(label);
      expect(stdout).toContain('ownership');
      expect(stdout).toContain('verify_results');
      expect(stdout).toContain('BIAO_QUESTION');
      expect(stdout).toContain('新的 claim token');
      expect(stdout).toContain('不询问当前人类');
    });
  }
});
