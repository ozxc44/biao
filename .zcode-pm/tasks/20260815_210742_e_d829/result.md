## 交付总结

### 变更文件

| 文件 | 变更 |
|---|---|
| `docs/mcp.md` | 整篇重写，按真实 LAN stdio 架构组织（定位与 CLI 分工表、两种部署形态、客户端 JSON 配置、13 工具清单表、安全模型、中央 HTTP MCP 推迟原因、实现文件索引） |
| `README.md` | 重写 "## MCP 接口（AI Agent 优先入口）" 段落（去掉 `/mcp` 端点与 MCP token 说法，改为 LAN stdio 适配器 + `BIAO_URL`/`BIAO_API_TOKEN`，指向 docs/mcp.md）；修正文档索引表中 MCP 一行的描述 |
| `README.en.md` | **未改动**——检查后确认无 MCP 接口段落，仅有代码示例中无关的 "MCP route" 字样 |

### 验证

- **权威测试通过**：`MCP_LAN_TEST_REDIS_URL="redis://127.0.0.1:6380/15" npx vitest run tests/mcp-lan-adapter.test.ts` → 5/5 通过（含 CAS 唯一 claim 赢家、零凭据泄漏、fail-closed、stdio 进程输出干净、中央 MCP 路径 404）。
- **验收标准逐项核对**：
  1. `docs/mcp.md` 全文无 "POST /mcp"、"MCP token"、"BIAO_MCP_TOKEN"（grep 通过）；`README.md` 同步无。
  2. 工具清单 13 个与 `src/mcp/tools.ts` 的 `name:` 列表逐一相等（脚本比对通过）。
  3. 环境变量名与代码一致：`BIAO_URL` / `BIAO_API_TOKEN` / `BIAO_MCP_TIMEOUT_MS`（与 `src/mcp/runtime.ts` 一致）。
  4. 交付说明附"断言↔出处"核对表（见下）。

### 断言 ↔ 出处核对表（交付物）

| 文档断言 | 源码出处 |
|---|---|
| serverInfo 名称 = `biao-lan-mcp` | `src/mcp/session.ts` 的 `MCP_SERVER_NAME` |
| 入口 `scripts/mcp-server.mjs` → `dist/mcp/stdio.js` | `scripts/mcp-server.mjs`（import `../dist/mcp/stdio.js`） |
| `bin/biao-mcp` 等价入口；npm 命令 `biao-mcp` | `bin/biao-mcp.js`；`package.json` 的 `bin.biao-mcp` |
| `createLanMcpRuntime` 要求 `BIAO_URL` + `BIAO_API_TOKEN` | `src/mcp/runtime.ts` |
| `BIAO_MCP_TIMEOUT_MS` 可选、默认 10000、须为 10..60000 整数 | `src/mcp/runtime.ts`（`configuredTimeout`） |
| stdio 不监听端口、stdout 只出 JSON-RPC、日志走 stderr | `src/mcp/stdio.ts`（`startMcpStdio` 无 `listen`）；`tests/mcp-lan-adapter.test.ts` 断言 |
| 中央 Streamable HTTP MCP 为空插件、不注册路由 | `src/mcp/http-route.ts`；`src/server/http.ts` 装配点注释 |
| 中央 MCP 路径返回 404 | `tests/mcp-lan-adapter.test.ts` |
| 13 个工具名称与 HTTP 语义 | `src/mcp/tools.ts` 各 handler 的 `runtime.client.request(path)` |
| 验收只读（无 review accept/reject/write） | `src/mcp/tools.ts` 工具注册表 + `tests/mcp-lan-adapter.test.ts` 断言 |
| claim 回执只在进程内保管、协议输出剥离 claim_token/project_path/verify | `src/mcp/runtime.ts`（`rememberClaim`/`claimToken`）+ `src/mcp/tools.ts`（`smallMetadata`/`task_claim`） |
| 输出脱敏键集合（cmd/output/goal_md 等） | `src/mcp/tools.ts` 的 `omittedMetadataKeys` |
| `pm_review_read` 过滤绝对路径、产出 `verify_summary`/`result_ref` | `src/mcp/tools.ts` 的 `pm_review_read` handler |
| fail-closed 7 种错误码 | `src/mcp/client.ts`（`BiaoRemoteError` + `rawRequest`） |
| 错误 details 中 token 替换为 `[REDACTED]` | `src/mcp/client.ts` 的 `scrubSecret` |
| health 校验 `data.version === 'v1'` | `src/mcp/client.ts` 的 `verifyProtocol` |

### 残余风险

- `docs/mcp.md` 在 git 中为未跟踪文件（`??`），是并行实现线新落盘的产物；重写后仍需编排层将其纳入提交。
- `README.md` 工作区还含其他任务线留下的未提交改动（"被动事件中枢""被动式 PM 轮询"等段落），本次未触碰，但提交时会一并带上，评审需知悉。
- `bin/biao-mcp.js` 与 `scripts/mcp-server.mjs` 都依赖 `dist/mcp/stdio.js`，使用前需先 `npm run build`（文档配置示例默认走仓库内源码入口，与现有 Worker/CLI 用法一致）。
- 文档中"对应 HTTP 语义"一列依据 `tools.ts` handler 的请求路径整理，已由通过的 `tests/mcp-lan-adapter.test.ts` 佐证，但属间接映射，后续若改路径需同步更新文档。