import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliWorkerConfig, resolveCliInvocation } from '../src/worker/cli.js';
import type { ClaimedTask } from '../src/types/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Custom Worker 命令解析', () => {
  it('绝对可执行文件路径包含空格时保持为一个完整命令', () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao custom adapter '));
    tempDirs.push(dir);
    const adapter = join(dir, 'unknown agent.mjs');
    writeFileSync(adapter, '#!/usr/bin/env node\n', { mode: 0o755 });
    chmodSync(adapter, 0o755);

    expect(resolveCliInvocation(adapter)).toEqual({ command: adapter, args: [] });
  });

  it('通过 Custom Worker 真实执行带空格路径适配器并传入三个任务参数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'biao custom e2e '));
    tempDirs.push(dir);
    const project = join(dir, 'project with space');
    mkdirSync(project);
    const adapter = join(dir, 'unknown agent.mjs');
    writeFileSync(adapter, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [taskId, goalFile, workDir] = process.argv.slice(2);
writeFileSync(join(workDir, 'received.json'), JSON.stringify({ taskId, goalFile, workDir }));
`, { mode: 0o755 });
    chmodSync(adapter, 0o755);
    const task = {
      task_id: 'adapter-task',
      title: 'adapter task',
      type: 'code',
      phase: 'impl',
      priority: 5,
      ownership_files: [],
      goal_md: '# Execute adapter\n',
      timeout_seconds: 30,
      claim_token: 'claim-token',
      verify: [],
      project_path: project,
      plan_id: 'adapter-plan',
    } satisfies ClaimedTask;
    const config = createCliWorkerConfig({ execCmd: adapter, maxTasks: 1 });

    const result = await config.execute(task, project);

    expect(result.run.exitCode).toBe(0);
    const workDir = join(realpathSync(project), 'work', task.task_id);
    expect(JSON.parse(readFileSync(join(workDir, 'received.json'), 'utf8'))).toEqual({
      taskId: task.task_id,
      goalFile: join(workDir, 'goal.md'),
      workDir,
    });
  });
});
