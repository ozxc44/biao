import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const kit = join(repoRoot, 'scripts', 'adapter-kit.mjs');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('adapter kit Project Agent modes', () => {
  it.each(['visible_session', 'background_executor', 'external_worker'])('publishes the %s contract', (mode) => {
    const result = spawnSync(process.execPath, [
      kit, 'contract', '--role', 'project-agent', '--mode', mode, '--json',
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const contract = JSON.parse(result.stdout).data;
    expect(contract).toMatchObject({ role: 'project-agent', wakeMode: mode });
    if (mode === 'background_executor') {
      expect(contract.lifecycle).toMatchObject({ supervisorClaims: true, harnessClaims: false });
    } else {
      expect(contract).toMatchObject({ protocol: 'biao.worker-wake/v1' });
      expect(contract.lifecycle).toMatchObject({ supervisorClaims: false, harnessClaims: true });
    }
  });

  it('checks a real external harness receipt probe without control-plane credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao-adapter-kit-project-agent-'));
    dirs.push(dir);
    const harness = join(dir, 'harness.mjs');
    writeFileSync(harness, `#!/usr/bin/env node
if (process.env.BIAO_ADAPTER_PROBE === '1') {
  console.log(JSON.stringify({ ok: true, protocol: 'biao.worker-wake/v1', role: 'project-agent', wake_mode: 'external_worker' }));
  process.exit(0);
}
process.exit(3);
`, { mode: 0o755 });
    chmodSync(harness, 0o755);

    const result = spawnSync(process.execPath, [
      kit, 'check', '--role', 'project-agent', '--mode', 'external_worker',
      '--adapter', harness, '--json',
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, BIAO_API_TOKEN: 'must-not-pass' } });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true, data: { role: 'project-agent', protocol: 'biao.worker-wake/v1', wakeMode: 'external_worker' },
    });
  });
});
