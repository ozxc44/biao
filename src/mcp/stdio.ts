import { createInterface } from 'node:readline';
import { createLanMcpRuntime } from './runtime.js';
import { handleMcpPayload, McpJsonRpcCodes } from './session.js';
import { maybeEnsureSupervisor } from '../worker/ensure-supervisor.js';

/** 会话存续期间的留守监视器看护周期。pm-watch 挂掉且无写事件时，门铃会
 * 无人消费；每个打开的 MCP 会话按此周期幂等 ensure 一次（opt-in + 节流在
 * maybeEnsureSupervisor 内部）。unref 保证 stdio 关闭后进程照常退出。 */
const WATCHDOG_ENSURE_INTERVAL_MS = 5 * 60_000;

export async function startMcpStdio(
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const runtime = createLanMcpRuntime(env);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const watchdog = setInterval(() => maybeEnsureSupervisor(), WATCHDOG_ENSURE_INTERVAL_MS);
  watchdog.unref();
  errorOutput.write('[biao-mcp] stdio ready\n');

  for await (const line of lines) {
    if (!line.trim()) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: McpJsonRpcCodes.PARSE_ERROR, message: 'JSON 解析失败' },
      })}\n`);
      continue;
    }
    try {
      const response = await handleMcpPayload(payload, runtime);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    } catch {
      output.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: McpJsonRpcCodes.INTERNAL_ERROR, message: 'MCP 适配器内部失败' },
      })}\n`);
    }
  }
}
