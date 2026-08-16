import { createInterface } from 'node:readline';
import { createLanMcpRuntime } from './runtime.js';
import { handleMcpPayload, McpJsonRpcCodes } from './session.js';

export async function startMcpStdio(
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  const runtime = createLanMcpRuntime(env);
  const lines = createInterface({ input, crlfDelay: Infinity });
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
