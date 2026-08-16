import { execFile } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, '..');
const cli = join(repoRoot, 'scripts', 'supervisor-config.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeConfig(content?: string): { root: string; config: string; original: string } {
  const root = mkdtempSync(join(tmpdir(), 'biao supervisor config '));
  tempDirs.push(root);
  const runtime = join(root, 'runtime with spaces');
  mkdirSync(runtime);
  const config = join(runtime, 'config.env');
  const original = content ?? [
    '# owner config; preserve this comment byte-for-byte',
    "BIAO_URL='http://127.0.0.1:7331'",
    "BIAO_API_TOKEN='never-print-this-token'",
    "UNRELATED='value with spaces'",
    '',
  ].join('\n');
  writeFileSync(config, original, { mode: 0o600 });
  chmodSync(config, 0o600);
  return { root, config, original };
}

async function run(args: string[]) {
  return execFileAsync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('Supervisor owner-only slot config CLI', () => {
  it('adds, lists, and removes a Worker slot while preserving every unrelated config byte', async () => {
    const { config, original } = makeConfig();
    const project = '/Volumes/Workspace With Spaces/project one';
    const command = '/Applications/Unknown Agent/bin/worker adapter';

    const added = await run([
      '--config', config,
      'worker', 'add',
      '--id', 'kimi-review-1',
      '--kind', 'custom',
      '--project', project,
      '--types', 'review,acceptance',
      '--command', command,
      '--model', 'kimi-model-v1',
      '--agent-type', 'kimi-review',
    ]);

    expect(`${added.stdout}\n${added.stderr}`).not.toContain('never-print-this-token');
    const afterAdd = readFileSync(config, 'utf8');
    expect(afterAdd.startsWith(original)).toBe(true);
    expect(lstatSync(config).mode & 0o777).toBe(0o600);

    const listed = await run(['--config', config, 'worker', 'list']);
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        kind: 'custom',
        agentId: 'kimi-review-1',
        project,
        types: ['review', 'acceptance'],
        command,
        model: 'kimi-model-v1',
        agentType: 'kimi-review',
      },
    ]);
    expect(`${listed.stdout}\n${listed.stderr}`).not.toContain('never-print-this-token');

    const beforeDuplicate = readFileSync(config, 'utf8');
    await expect(run([
      '--config', config,
      'worker', 'add',
      '--id', 'kimi-review-1',
      '--kind', 'kimi',
      '--project', project,
      '--types', 'code',
    ])).rejects.toMatchObject({ code: 2 });
    expect(readFileSync(config, 'utf8')).toBe(beforeDuplicate);

    await run(['--config', config, 'worker', 'remove', '--id', 'kimi-review-1']);
    const empty = await run(['--config', config, 'worker', 'list']);
    expect(JSON.parse(empty.stdout)).toEqual([]);
    const afterRemove = readFileSync(config, 'utf8');
    expect(afterRemove).toContain("BIAO_API_TOKEN='never-print-this-token'");
    expect(afterRemove).toContain("UNRELATED='value with spaces'");
  });

  it('maps --model to the field consumed by each Worker kind and supports credential-safe dry-run', async () => {
    const { config } = makeConfig();
    const before = readFileSync(config, 'utf8');

    const preview = await run([
      '--config', config,
      '--dry-run',
      'worker', 'add',
      '--id', 'kimi-a',
      '--kind', 'kimi',
      '--project', '/Volumes/Workspace With Spaces/project one',
      '--types', 'code',
      '--model', 'kimi-model-v2',
    ]);

    expect(JSON.parse(preview.stdout)).toEqual([
      {
        kind: 'kimi',
        agentId: 'kimi-a',
        project: '/Volumes/Workspace With Spaces/project one',
        types: ['code'],
        kimiModel: 'kimi-model-v2',
      },
    ]);
    expect(`${preview.stdout}\n${preview.stderr}`).not.toContain('never-print-this-token');
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('rejects a custom Worker slot without an executable command before it can break Supervisor startup', async () => {
    const { config } = makeConfig();
    const before = readFileSync(config, 'utf8');
    await expect(run([
      '--config', config,
      'worker', 'add',
      '--id', 'broken-custom',
      '--kind', 'custom',
      '--project', '/Volumes/Workspace/project',
      '--types', 'code',
    ])).rejects.toMatchObject({ code: 2 });
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('configures a harness heartbeat command by agent id without a project binding id', async () => {
    const { config } = makeConfig();
    await run([
      '--config', config,
      'worker', 'add',
      '--id', 'glm5.3',
      '--kind', 'custom',
      '--project', '/Volumes/Workspace/project',
      '--types', 'code,review',
      '--command', '/opt/glm/heartbeat',
      '--harness-kind', 'glm',
      '--wake-mode', 'external_worker',
      '--adapter-id', 'glm-heartbeat-v1',
    ]);

    const listed = await run(['--config', config, 'worker', 'list']);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({
        agentId: 'glm5.3',
        command: '/opt/glm/heartbeat',
        harnessKind: 'glm',
        wakeMode: 'external_worker',
        adapterId: 'glm-heartbeat-v1',
      }),
    ]);
    expect(listed.stdout).not.toContain('bindingId');
  });

  it('adds, lists, and removes independent PM queue slots without exposing config credentials', async () => {
    const { config } = makeConfig();
    const command = '/Users/operator/Agent Adapters/kimi pm';

    const added = await run([
      '--config', config,
      'pm', 'add',
      '--id', 'pm-kimi-a',
      '--consumer', 'pm-kimi-consumer',
      '--command', command,
      '--target', 'kimi-session-123',
      '--plans', 'plan-a,plan-b',
      '--kinds', 'review_requested,resolution_required',
    ]);
    expect(`${added.stdout}\n${added.stderr}`).not.toContain('never-print-this-token');

    const listed = await run(['--config', config, 'pm', 'list']);
    expect(JSON.parse(listed.stdout)).toEqual([
      {
        id: 'pm-kimi-a',
        consumer: 'pm-kimi-consumer',
        command,
        target: 'kimi-session-123',
        plans: ['plan-a', 'plan-b'],
        kinds: ['review_requested', 'resolution_required'],
      },
    ]);
    expect(`${listed.stdout}\n${listed.stderr}`).not.toContain('never-print-this-token');

    const beforeDuplicate = readFileSync(config, 'utf8');
    await expect(run([
      '--config', config,
      'pm', 'add',
      '--id', 'pm-kimi-a',
      '--consumer', 'another-consumer',
      '--command', command,
    ])).rejects.toMatchObject({ code: 2 });
    expect(readFileSync(config, 'utf8')).toBe(beforeDuplicate);

    await run(['--config', config, 'pm', 'remove', '--id', 'pm-kimi-a']);
    const empty = await run(['--config', config, 'pm', 'list']);
    expect(JSON.parse(empty.stdout)).toEqual([]);
  });

  it('rejects duplicate PM consumers because they would race the same queue identity', async () => {
    const { config } = makeConfig([
      "BIAO_API_TOKEN='never-print-this-token'",
      `BIAO_PM_SLOTS='${JSON.stringify([{ id: 'pm-a', consumer: 'shared', command: '/a' }])}'`,
      '',
    ].join('\n'));
    const before = readFileSync(config, 'utf8');

    await expect(run([
      '--config', config,
      'pm', 'add',
      '--id', 'pm-b',
      '--consumer', 'shared',
      '--command', '/b',
    ])).rejects.toMatchObject({ code: 2 });
    expect(readFileSync(config, 'utf8')).toBe(before);
  });

  it('treats an explicitly empty generated slot variable as an empty queue', async () => {
    const { config } = makeConfig([
      "BIAO_API_TOKEN='never-print-this-token'",
      "BIAO_WORKER_SLOTS=''",
      "BIAO_PM_SLOTS=''",
      '',
    ].join('\n'));

    const workers = await run(['--config', config, 'worker', 'list']);
    const pms = await run(['--config', config, 'pm', 'list']);
    expect(JSON.parse(workers.stdout)).toEqual([]);
    expect(JSON.parse(pms.stdout)).toEqual([]);
  });

  it('refuses relative, symlink, non-owner-only, and filesystem-root project targets', async () => {
    const { root, config } = makeConfig();
    const symlink = join(root, 'linked-config.env');
    symlinkSync(config, symlink);

    await expect(run(['--config', 'config.env', 'worker', 'list'])).rejects.toMatchObject({ code: 2 });
    await expect(run(['--config', symlink, 'worker', 'list'])).rejects.toMatchObject({ code: 2 });

    chmodSync(config, 0o644);
    await expect(run(['--config', config, 'worker', 'list'])).rejects.toMatchObject({ code: 2 });
    chmodSync(config, 0o600);

    await expect(run([
      '--config', config,
      'worker', 'add',
      '--id', 'too-broad',
      '--kind', 'codex',
      '--project', '/',
      '--types', 'code',
    ])).rejects.toMatchObject({ code: 2 });

    expect(readFileSync(config, 'utf8')).toContain("BIAO_API_TOKEN='never-print-this-token'");
  });
});
