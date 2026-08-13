import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dirname, '..');
let projectPath: string;
let server: Server | undefined;

beforeEach(() => {
  projectPath = mkdtempSync(join(tmpdir(), 'biao-mock-progress-'));
});

afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  server = undefined;
  rmSync(projectPath, { recursive: true, force: true });
});

function runMock(url: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), resolve(REPO_ROOT, 'src/worker/mock.ts')],
      {
        cwd: projectPath,
        env: {
          ...process.env,
          BIAO_URL: url,
          BIAO_AGENT_ID: 'mock-progress-worker',
          BIAO_MAX_TASKS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('Mock Worker progress artifact', () => {
  it('与正式 Worker 一样由调度器维护完整且脱敏的 .progress.json', async () => {
    const taskId = 'mock-progress-task';
    const workDir = join(projectPath, 'work', taskId);
    const artifact = join(workDir, '.progress.json');
    let claimed = false;
    let progressDuringReport: Record<string, any> | undefined;
    const registrationId = 'mock_registration_0123456789abcdef';
    const lifecycle: string[] = [];

    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk.toString(); });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/register') {
          lifecycle.push('register');
          response.end(JSON.stringify({ ok: true, data: { registration_id: registrationId } }));
          return;
        }
        if (request.url === '/heartbeat') {
          const heartbeat = JSON.parse(body) as Record<string, unknown>;
          expect(heartbeat).toMatchObject({
            agent_id: 'mock-progress-worker',
            registration_id: registrationId,
          });
          lifecycle.push('heartbeat');
          response.end(JSON.stringify({ ok: true, data: {} }));
          return;
        }
        if (request.url === '/agent/offline') {
          const offline = JSON.parse(body) as Record<string, unknown>;
          expect(offline).toMatchObject({
            agent_id: 'mock-progress-worker',
            registration_id: registrationId,
            reason: 'worker_exit',
          });
          lifecycle.push('offline');
          response.end(JSON.stringify({ ok: true, data: { offline: true } }));
          return;
        }
        if (request.url === '/claim') {
          const claim = JSON.parse(body) as Record<string, unknown>;
          expect(claim).toMatchObject({
            agent_id: 'mock-progress-worker',
            registration_id: registrationId,
            claim_request_id: expect.stringMatching(/^claim_[a-f0-9]{32}$/),
          });
          lifecycle.push('claim');
          if (claimed) {
            response.end(JSON.stringify({ ok: true, data: null }));
            return;
          }
          claimed = true;
          response.end(JSON.stringify({
            ok: true,
            data: {
              task_id: taskId,
              title: 'Mock 进度',
              type: 'code',
              phase: 'impl',
              priority: 5,
              ownership_files: [],
              goal_md: '',
              timeout_seconds: 60,
              claim_token: 'mock-secret-claim-token',
              verify: [],
              project_path: projectPath,
              plan_id: 'mock-progress-plan',
            },
          }));
          return;
        }
        if (request.url === '/report') {
          try {
            progressDuringReport = JSON.parse(readFileSync(artifact, 'utf8')) as Record<string, any>;
          } catch {
            progressDuringReport = undefined;
          }
          const report = JSON.parse(body) as Record<string, unknown>;
          expect(report.status).toBe('done');
          response.end(JSON.stringify({ ok: true, data: { task_id: taskId, status: 'done' } }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
      });
    });
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务未监听 TCP 端口');

    const run = await runMock(`http://127.0.0.1:${address.port}`);
    expect(run).toMatchObject({ code: 0, stderr: '' });
    expect(progressDuringReport).toMatchObject({
      stage: 'reporting',
      artifacts: { result_md: true, result_json: true },
      report: { status: 'done', delivery: 'pending' },
    });

    const raw = readFileSync(artifact, 'utf8');
    const progress = JSON.parse(raw) as Record<string, any>;
    expect(progress).toMatchObject({
      task_id: taskId,
      agent_id: 'mock-progress-worker',
      status: 'done',
      stage: 'finished',
      report: { status: 'done', delivery: 'reported' },
    });
    expect(progress.history.map((event: { stage: string }) => event.stage)).toEqual([
      'claimed',
      'running',
      'verifying',
      'reporting',
      'finished',
    ]);
    expect(raw).not.toContain('mock-secret-claim-token');
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(lifecycle).toEqual(['register', 'heartbeat', 'claim', 'offline']);
  });
});
