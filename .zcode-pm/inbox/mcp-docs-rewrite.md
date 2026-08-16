# 文档重写：docs/mcp.md 与 README MCP 段落对齐实际 LAN stdio 架构

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。

`biao-mcp` 的最终架构（已由另一条并行实现线落盘，你只写文档、不改代码）：

- **P0 局域网方案 = 每台开发机本地 stdio 适配器**：`scripts/mcp-server.mjs`（入口，`serverInfo.name = 'biao-lan-mcp'`）→ `dist/mcp/stdio.js`（`src/mcp/stdio.ts`）→ `createLanMcpRuntime`（`src/mcp/runtime.ts`，要求环境变量 `BIAO_URL` + `BIAO_API_TOKEN`，可选 `BIAO_MCP_TIMEOUT_MS`）→ `BiaoHttpClient`（`src/mcp/client.ts`）经 HTTP 访问中央 Biao 服务。
- **中央 Streamable HTTP MCP 被有意推迟**：`src/mcp/http-route.ts` 的 `createMcpHttpRoutes` 当前是空插件（注释写明"必须等 P6 Human/RBAC 后以独立变更显式启用"），不注册任何路由。
- 工具面（`src/mcp/tools.ts`）：health、plan_list、plan_status、task_list、task_get、ownership_check、pm_review_list、pm_review_read、task_claim、task_heartbeat、task_report、task_block、question_ask。**验收只读**（只有 pm_review_read/pm_review_list，无 review accept/reject/write）；claim 回执在运行时内部保管 claim_token，协议输出剥离 claim_token/project_path/verify 等敏感字段。
- fail-closed 错误分类（`src/mcp/client.ts`）：REMOTE_UNAUTHORIZED / REMOTE_FORBIDDEN / REMOTE_TIMEOUT / REMOTE_PROTOCOL_MISMATCH / REMOTE_UNAVAILABLE / REMOTE_RESPONSE_TOO_LARGE / REMOTE_CONFIG_INVALID。
- 权威规格测试：`tests/mcp-lan-adapter.test.ts`（两个隔离客户端共享中央 CAS 唯一 claim 赢家；协议输出零凭据泄漏；401/403/超时/协议错配全部 fail closed；stdio 进程输出不含 token/路径/启动命令）。
- CLI 分工结论（README 已有段落）：AI Agent 的结构化操作优先 MCP；CLI 保留人工运维、脚本兼容（`.biao/*`）、灾备恢复；PM Agent 操作契约仍走 CLI 文本协议。

**问题**：现有 `docs/mcp.md` 是按一个已被否决的旧设计写的（中央 `POST /mcp` + 独立 MCP token + stdio 直连 service 层的 13 个工具清单），与实际代码完全不符，会误导接入方。README.md 的"## MCP 接口（AI Agent 优先入口）"一节也提到 `/mcp` HTTP 端点和 MCP token 派生，同样需要修正。

## 目标

1. **重写 `docs/mcp.md`**（中文）：按上面的真实架构组织——定位与 CLI 分工表、两种部署形态（中央机跑 Biao 服务；每台开发机 stdio 适配器）、客户端 JSON 配置示例（command/scripts/mcp-server.mjs 或 bin/biao-mcp、env 三件套）、13 个工具的清单表（名称/对应 HTTP 语义/脱敏说明）、安全模型（owner token 只在本机 env、协议输出脱敏、验收写入口不开放、fail-closed 错误表）、中央 HTTP MCP 为何推迟到 RBAC 之后、实现文件索引。凡是你写进文档的行为断言，必须能在对应源码文件中找到出处（文档里用行内代码引用文件名即可，不用行号）。
2. **修正 README.md 的 MCP 段落**：去掉 `/mcp` 端点与 MCP token 的说法，改为 LAN stdio 适配器 + 指向 docs/mcp.md；保持与"CLI 与 MCP 的分工"表述一致。
3. **检查 README.en.md**：若有 MCP 相关段落同样修正；没有则不动。
4. 事实核对清单：把文档中每个关键断言 ↔ 源码文件对应关系列成附表（例如"serverInfo 名称=biao-lan-mcp ↔ src/mcp/session.ts 的 MCP_SERVER_NAME"），作为交付物的一部分放进交付说明，不用写进文档正文。

## 约束

- 全程中文文档。
- **只允许修改**：`docs/mcp.md`、`README.md` 的 MCP 相关段落、`README.en.md` 的 MCP 相关段落（若有）。**不得修改任何代码、测试、其他文档**（`docs/worker-integration.md`、`docs/agent-join.md` 归其他任务线所有），不得改 `.github/`、`.biao/`。
- 不引入新文件。
- 文档中的配置示例必须与 `tests/mcp-lan-adapter.test.ts` 及 `src/mcp/runtime.ts` 的实际环境变量名完全一致。

## 验收标准

1. `docs/mcp.md` 全文不再出现"POST /mcp"、"MCP token"、"BIAO_MCP_TOKEN"字样。
2. 工具清单与 `src/mcp/tools.ts` 的 `name:` 列表逐一对得上（13 个）。
3. 环境变量名与代码一致（BIAO_URL / BIAO_API_TOKEN / BIAO_MCP_TIMEOUT_MS）。
4. 交付说明附"断言↔出处"核对表。
