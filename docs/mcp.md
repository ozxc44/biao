# biao-mcp（MCP 接口）

`biao-mcp` 把 Biao 的核心操作暴露为 MCP（Model Context Protocol）工具，供 AI Agent 结构化调用。它本身**不直连** service 层或 Redis，而是作为每台开发机上的**本地 stdio 适配器**：由本机 MCP 客户端（Claude Code、Codex 等）作为子进程启动，只在本机 stdin/stdout 上收发 JSON-RPC 消息，真正的读写通过 HTTP 访问中央 Biao 服务。它与 CLI、Worker 共用同一套服务端真相（`src/server/service.ts`），没有第二套规则。

## 定位与 CLI 分工

| 场景 | 用哪个 |
|---|---|
| AI Agent 的结构化操作（任务领取/心跳/上报/阻塞、PM 待办、状态查询） | MCP 优先 |
| 人工运维、脚本兼容（`.biao/*` wrappers）、灾备恢复（`db restore`、`watchdog`） | CLI |
| PM Agent 的操作契约（`question list → get → answer → pm ack`） | CLI（PM harness 文本协议绑在 CLI 上） |

新能力默认只加 MCP tool，不再为 AI 使用场景增加 CLI 命令；CLI 只在人工运维确有需要时扩展。

## 部署形态

### 形态一：中央机运行 Biao 服务

中央机（或局域网内任一常驻机）运行 Biao 服务（`src/server/http.ts`），持有 `BIAO_API_TOKEN`。`biao-mcp` 适配器通过 `BiaoHttpClient`（`src/mcp/client.ts`）访问它的 HTTP API（`/register`、`/claim`、`/report`、`/reviews/pending`、`/question` 等）。

### 形态二：每台开发机本地 stdio 适配器

每台开发机各自运行一个 `biao-mcp` stdio 进程，由本地 MCP 客户端启动。它只在启动时读取本机环境变量，之后全部读写走 HTTP 到中央 Biao 服务；**不监听端口、不暴露网络接口**——`src/mcp/stdio.ts` 只逐行处理 stdin 上的 JSON-RPC 并把响应写回 stdout，`scripts/mcp-server.mjs` 与 `src/mcp/stdio.ts` 中都不含 `listen` 调用。

**中央 Streamable HTTP MCP 被有意推迟**：`src/mcp/http-route.ts` 的 `createMcpHttpRoutes` 当前是空插件，故意不注册任何路由；`src/server/http.ts` 只把它作为装配点挂载。等 P6 Human/RBAC 落地后，再以独立变更显式启用。权威规格测试 `tests/mcp-lan-adapter.test.ts` 断言对中央 MCP 路径发起的 HTTP 请求返回 404。

## 客户端配置

在支持 MCP 的客户端（Claude Code、Codex 等）的 MCP 配置中声明一个 stdio server：

```json
{
  "mcpServers": {
    "biao": {
      "command": "/path/to/biao/scripts/mcp-server.mjs",
      "env": {
        "BIAO_URL": "http://<biao主机>:7331",
        "BIAO_API_TOKEN": "<中央 Biao 服务的 Bearer token>",
        "BIAO_MCP_TIMEOUT_MS": "10000"
      }
    }
  }
}
```

- `command` 指向仓库入口 `scripts/mcp-server.mjs`（或等价的 `bin/biao-mcp.js`）；已通过 npm 安装 biao 包时，也可直接用 `biao-mcp` 命令——`package.json` 的 `bin.biao-mcp` 指向 `scripts/mcp-server.mjs`。
- **环境变量三件套**：`BIAO_URL`（中央服务地址）、`BIAO_API_TOKEN`（Bearer 凭据）、`BIAO_MCP_TIMEOUT_MS`（可选，毫秒，默认 10000）。`src/mcp/runtime.ts` 的 `createLanMcpRuntime` 要求前两个必须提供，否则以 `REMOTE_CONFIG_INVALID` 拒绝启动；`BIAO_MCP_TIMEOUT_MS` 必须是 10..60000 的整数。
- stdio 传输的 `stdout` 只输出 JSON-RPC 消息（每行一条），日志全部走 `stderr`（`src/mcp/stdio.ts`）。

## 工具清单

`src/mcp/tools.ts` 注册 23 个工具：

| 工具 | 对应 HTTP 语义 | 脱敏说明 |
|---|---|---|
| `health` | `GET /health`，校验 `data.version === 'v1'` | 无可疑字段 |
| `plan_list` | `GET /plans` | 剥离 `project_path` 等服务端本地路径 |
| `plan_status` | `GET /plan/{plan_id}` | 同上 |
| `project_create` | `POST /v2/projects`（name/repo_path/default_branch/read_only） | 注册 V2 项目；需要 Owner API Token 作用域，凭据不足时中央直接拒绝 |
| `project_list` | `GET /v2/projects` | 返回 project_id、Git 远端、默认分支、执行模式摘要 |
| `task_list` | `GET /tasks?plan_id&status&limit&offset` | 同上 |
| `task_get` | `GET /task/{task_id}` | 返回 goal 正文；不返回 verify 命令、Artifact 字节或服务端路径 |
| `ownership_check` | `GET /ownership?path&agent_id` | 只读中央 ownership 判定，不在本机重算或声明 ownership |
| `pm_review_list` | `GET /reviews/pending?plan_id` | 只列待验收交付摘要 |
| `pm_review_read` | `GET /task/{task_id}/review` | 只给验收状态与证据摘要；`changed_files` 过滤绝对路径，产出 `verify_summary` / `result_ref` |
| `task_claim` | 自动 `POST /register` 后 `POST /claim` | claim 回执（`claim_token`）只保存在进程内运行时；输出含 `goal_md` 正文，剥离 `claim_token`/`project_path`/`verify`（命令不外泄，报告时可用 `execute_verify` 由中央代执行） |
| `task_heartbeat` | `POST /heartbeat`（持 lease 时再 `POST /lease/renew`） | 只用本会话 registration epoch 与内部 lease |
| `task_report` | `POST /report` | 上报 done/failed/partial；可内联携带 `result_md`/`result_json`（中央受控落盘，远程 Worker 无需服务器文件系统）并传 `execute_verify` 让中央在工作区代执行声明的 verify；done 仍需独立 PM Review |
| `task_block` | `POST /task/{task_id}/block` | 成功后释放本地 lease 句柄 |
| `question_ask` | `POST /question` | 成功后旧 lease 失效 |
| `plan_create` | `POST /plan/create` | `skeleton=false` 只建空计划，配合 `task_upsert` 逐个建任务 |
| `task_upsert` | `POST /plan/{plan_id}/tasks` | 结构化直建/更新单个任务（pending 覆盖、运行态/终态平台保护）；远程 Agent 无需服务器 shell |
| `pm_review_decide` | `POST /task/{task_id}/review` | PM 验收决策（accept/reject）；需要 Owner 作用域，Worker token 被 `REMOTE_FORBIDDEN` 拒绝 |
| `question_list` | `GET /questions` | PM 列出待处理 Question 最小路由信息（默认 consumer=pm） |
| `question_get` | `GET /question/{question_id}` | PM 读取 Question 正文、checkpoint 与扩权申请 |
| `question_answer` | `POST /question/{question_id}/answer` 后自动 `POST /intake/ack` | 答复完成即 ack 对应门铃；任务回 pending，Worker 以新 claim 恢复 |
| `pm_next` | `GET /intake` | PM 一站式最小待办门铃汇总；空数据表示无事可做 |
| `agent_offline` | `POST /agent/offline` | Worker 正常退出收口（幂等，只用本会话 registration） |

**身份记忆**：`task_claim` 首次携带 `agent_id` 后，本 MCP 会话会记住身份；`task_heartbeat` / `task_report` / `task_block` / `question_ask` / `ownership_check` / `agent_offline` 的后续调用可省略 `agent_id`。

**PM 写操作的作用域**：`pm_review_decide` / `question_answer` / `plan_create` / `task_upsert` 走 Owner API Token 作用域；仅持 Worker token 的会话会被中央 `REMOTE_FORBIDDEN` 拒绝。验收独立性与 done≠accepted 的闭环不变。

## 安全模型

- **Owner token 只在本机 env**：`BIAO_API_TOKEN` 只由 MCP 客户端注入 stdio 子进程的环境变量，`createLanMcpRuntime` 读入后只放进 `Authorization: Bearer` 请求头（`src/mcp/client.ts`）；不拼进 URL、不提供 getter，也不出现在协议输出里。
- **协议输出脱敏**：读响应经 `projectEnvelope` 的 `smallMetadata` 投影，剥掉 `claim_token`、`project_path`、`verify`、`cmd`、`output` 等敏感键（`src/mcp/tools.ts`）；`goal_md` 是 PM 写给 Worker 的任务正文，在 `task_claim` / `task_get` 显式返回。`BiaoHttpClient` 还会把错误 details 中出现的 token 串替换为 `[REDACTED]`（`src/mcp/client.ts`）。
- **错误信息白名单透传**：不含路径/凭据/长十六进制形态的短业务消息按原样透传，含敏感形态的一律回退为固定文案（`sanitizeRemoteMessage`）。
- **fail-closed**：适配器对远程错误一律 fail closed，不做本地回退（`src/mcp/client.ts`）。

| 错误码 | 触发条件 |
|---|---|
| `REMOTE_UNAUTHORIZED` | 中央 API 返回 401 |
| `REMOTE_FORBIDDEN` | 中央 API 返回 403 |
| `REMOTE_TIMEOUT` | 请求超时或响应体消费超时 |
| `REMOTE_PROTOCOL_MISMATCH` | 非 JSON 响应、信封与 HTTP 状态不一致、health 版本不兼容、registration epoch 不一致 |
| `REMOTE_UNAVAILABLE` | 中央 API 不可达 |
| `REMOTE_RESPONSE_TOO_LARGE` | 响应超过控制面上限（默认 1 MiB） |
| `REMOTE_CONFIG_INVALID` | `BIAO_URL`/`BIAO_API_TOKEN` 缺失、`BIAO_MCP_TIMEOUT_MS` 非法、`BIAO_URL` 不是合法 HTTP(S) URL |

## 权威规格测试

`tests/mcp-lan-adapter.test.ts` 是 LAN stdio 适配器的权威规格：

- 两个隔离客户端读取同一中央事实，由中央 CAS 决定唯一 claim 赢家；
- 协议输出零凭据/路径/verify 命令/启动命令泄漏；
- 401、403、超时与 HTTP/API 协议错配全部 fail closed；
- stdio 进程输出不含 token、baseUrl、仓库路径、进程路径；对中央 MCP 路径的请求返回 404。

## 实现文件索引

- `scripts/mcp-server.mjs` / `bin/biao-mcp.js` — stdio 入口，加载 `dist/mcp/stdio.js`
- `src/mcp/stdio.ts` — stdio 传输：逐行 JSON-RPC、stdout 只出协议、日志走 stderr
- `src/mcp/session.ts` — JSON-RPC 分发（`MCP_SERVER_NAME = 'biao-lan-mcp'`、initialize/tools/list/tools/call/ping）
- `src/mcp/runtime.ts` — `createLanMcpRuntime`：读 `BIAO_URL`/`BIAO_API_TOKEN`/`BIAO_MCP_TIMEOUT_MS`，维护会话内 agent 注册态与 claim lease
- `src/mcp/tools.ts` — 15 个工具注册表 + 输出脱敏投影
- `src/mcp/client.ts` — `BiaoHttpClient`：HTTP 请求、超时/大小上限、fail-closed 错误分类、secret scrub
- `src/mcp/http-route.ts` — 中央 Streamable HTTP MCP 空插件（推迟到 RBAC 之后）
- `src/server/http.ts` — MCP 装配点（挂载空插件）
- `tests/mcp-lan-adapter.test.ts` — 权威规格测试
