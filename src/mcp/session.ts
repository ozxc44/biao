import type { LanMcpRuntime } from './runtime.js';
import { callMcpTool, listMcpTools, McpToolInputError } from './tools.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SERVER_NAME = 'biao-lan-mcp';
export const MCP_SERVER_VERSION = '0.1.0';

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

export type McpSessionContext = LanMcpRuntime;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(id: string | number | null, payload: unknown, ok: boolean): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: !ok,
    },
  };
}

function toolDescriptors() {
  return listMcpTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function requestId(message: JsonRpcRequest): string | number | null {
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
}

export async function handleMcpMessage(
  message: JsonRpcRequest,
  runtime: McpSessionContext,
): Promise<JsonRpcResponse | null> {
  const id = requestId(message);
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
    return error(id, JSONRPC_INVALID_REQUEST, '不是合法的 JSON-RPC 2.0 请求');
  }
  if (message.id === undefined && message.method.startsWith('notifications/')) return null;

  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDescriptors() } };
    case 'tools/call': {
      const params = message.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return error(id, JSONRPC_INVALID_PARAMS, 'tools/call 需要对象 params');
      }
      const { name, arguments: toolArguments = {} } = params as { name?: unknown; arguments?: unknown };
      if (typeof name !== 'string' || !toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
        return error(id, JSONRPC_INVALID_PARAMS, 'tools/call 需要 name 与对象 arguments');
      }
      try {
        const result = await callMcpTool(name, toolArguments as Record<string, unknown>, runtime);
        return toolResult(id, result.payload, result.ok);
      } catch (toolError) {
        if (toolError instanceof McpToolInputError) {
          return error(id, JSONRPC_INVALID_PARAMS, toolError.message);
        }
        return toolResult(
          id,
          { ok: false, data: null, error: { code: 'MCP_ADAPTER_FAILED', message: 'MCP 适配器内部失败' } },
          false,
        );
      }
    }
    default:
      return error(id, JSONRPC_METHOD_NOT_FOUND, `未知方法：${message.method}`);
  }
}

export async function handleMcpPayload(
  payload: unknown,
  runtime: McpSessionContext,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return error(null, JSONRPC_INVALID_REQUEST, '空 batch 不合法');
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        responses.push(error(null, JSONRPC_INVALID_REQUEST, 'batch item 必须是对象'));
        continue;
      }
      const response = await handleMcpMessage(item as JsonRpcRequest, runtime);
      if (response) responses.push(response);
    }
    return responses.length ? responses : null;
  }
  if (!payload || typeof payload !== 'object') return error(null, JSONRPC_INVALID_REQUEST, '请求必须是对象或 batch');
  return handleMcpMessage(payload as JsonRpcRequest, runtime);
}

export const McpJsonRpcCodes = {
  PARSE_ERROR: JSONRPC_PARSE_ERROR,
  INVALID_REQUEST: JSONRPC_INVALID_REQUEST,
  METHOD_NOT_FOUND: JSONRPC_METHOD_NOT_FOUND,
  INVALID_PARAMS: JSONRPC_INVALID_PARAMS,
  INTERNAL_ERROR: JSONRPC_INTERNAL_ERROR,
} as const;
