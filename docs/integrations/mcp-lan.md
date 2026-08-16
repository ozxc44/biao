# LAN 本机 MCP 适配层

本适配层运行在每台开发机上，默认且仅使用 MCP `stdio`。它通过 `BIAO_URL` 调用中央 Biao 的既有 HTTP API；不直连 Redis/SQLite，不复制任务状态，也不在 LAN 上新增监听端口。

## 安全边界

- `BIAO_API_TOKEN` 只能由启动进程的环境或受控本机运行时提供。工具参数没有 Token、registration epoch 或 claim token 字段。
- Bearer 只进入 HTTP `Authorization` header，不进入 URL、日志、MCP result、task 或 receipt。claim token 和 registration epoch 仅保存在当前 MCP 进程内；进程重启后旧 lease 写操作会 fail closed，必须重新 claim。
- 每个工具第一次访问中央服务前检查 `GET /health` 的 `version=v1`。401、403、超时、非 JSON、无效 API 信封和版本不匹配均返回工具级错误，不回退到本地状态。
- MCP 输出省略中央机的绝对 `project_path`、Artifact 路径、verify 命令、Artifact 正文及 execution receipt。大文件和结果正文仍走 Artifact Store；Git push/fetch 仍走 Git。
- 本 MVP 不开放 PM Review 的 accept/reject 写工具。`task_report(done)` 只产生待验收交付，仍须独立 Agent/PM Review。

中央 Streamable HTTP MCP 不在本阶段启用。它必须等 P6 Human/RBAC 后作为独立能力显式配置，不能借用 Worker 身份字段充当授权。

## 启动

安装包后，Harness 使用 `biao-mcp`；在仓库开发态可运行 `npm run mcp:stdio`。stdio 的 `stdout` 只包含 JSON-RPC，诊断仅写入不含配置值的 `stderr`。

典型 MCP 客户端配置：

```json
{
  "mcpServers": {
    "biao": {
      "command": "biao-mcp",
      "env": {
        "BIAO_URL": "http://biao-control-plane:7331",
        "BIAO_API_TOKEN": "由本机秘密运行时注入，不写入仓库配置"
      }
    }
  }
}
```

推荐由系统 keychain、受控 launcher 或权限为 `0600` 的本机配置加载环境变量。不要把 Token 放在 `args`、MCP tool arguments 或带查询参数的 URL 中。可用 `BIAO_MCP_TIMEOUT_MS` 设置 10–60000 ms 的请求超时，默认 10000 ms。

## 工具契约

| 工具 | 中央 HTTP API | 说明 |
| --- | --- | --- |
| `health` | `GET /health` | 可达性与 v1 协议门禁 |
| `plan_list` | `GET /plans` | 计划摘要 |
| `plan_status` | `GET /plan/:plan_id` | 计划与任务状态 |
| `task_list` | `GET /tasks` | 任务分页列表 |
| `task_get` | `GET /task/:task_id` | 小型任务元数据 |
| `ownership_check` | `GET /ownership` | 使用服务端 ownership/CAS 事实 |
| `pm_review_list` | `GET /reviews/pending` | 待验收列表 |
| `pm_review_read` | `GET /task/:task_id/review` | 小型证据摘要和 Artifact 引用状态 |
| `task_claim` | `POST /register` + `POST /claim` | registration/claim token 留在进程内 |
| `task_heartbeat` | `POST /heartbeat` | 复用当前 registration epoch |
| `task_report` | `POST /report` | 复用当前 lease；不等于 PM accepted |
| `task_block` | `POST /task/:task_id/block` | 由服务端校验 ownership/依赖等待 |
| `question_ask` | `POST /question` | 成功后旧 claim 失效，等待 fresh claim |

所有业务请求仍由中央 HTTP API 执行既有 schema、错误码、lease、CAS、ownership 与独立验收规则。适配器不会本地宣布 claim 成功、补写 ownership 或把 `done` 提升为 `accepted`。

## 并发与恢复

不同开发机各自启动独立 stdio 进程，但都指向同一个 `BIAO_URL`。并发读取返回同一中央事实；并发 `task_claim` 都发送到中央 `/claim`，只有服务端 CAS 的赢家会在本进程保存 lease。失败客户端不会获得 claim token，也不能调用 report/block/Question 写接口。

MCP 进程退出不会迁移 lease。Harness 需要按任务 `timeout_seconds / 3` 调用 `task_heartbeat`，并在租约失效或进程重启后重新 claim。Artifact、Git 与 Worker 执行现场的恢复不属于 MCP 传输职责。
