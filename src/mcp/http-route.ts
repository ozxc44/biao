import type { FastifyPluginAsync } from 'fastify';
import type Redis from 'ioredis';

export interface McpHttpConfig {
  biaoUrl: string;
  lockDir: string;
}

/**
 * P0 LAN MVP 明确只提供每台开发机本地 stdio 适配器。
 * 中央 Streamable HTTP MCP 必须等 P6 Human/RBAC 后以独立变更显式启用；当前插件故意不注册路由。
 * 保留此兼容导出，避免中央 HTTP server 的既有装配点在过渡期编译失败。
 */
export function createMcpHttpRoutes(_redis: Redis, _config: McpHttpConfig): FastifyPluginAsync {
  return async () => undefined;
}
