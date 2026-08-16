# Supervisor 聚合 tick 端点：局域网多机监视的往返优化（兼容优先）

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`（TypeScript ESM + Fastify + Redis + SQLite）。

现状（PM 用 fetch 打点实测）：本机 Supervisor 每 60s 一轮共享并发请求：`GET /plans` + `GET /intake`（每个 PM consumer 一次）+ `GET /events`（游标增量）+ `POST /reconcile` + 绑定道快照（`GET /project/agent-bindings`、`GET /execution-receipts`，仅绑定项目）+ 各 slot `POST /heartbeat`。当前实测 62 请求/分钟。本机无压力；**局域网多机部署（每台开发机一个 Supervisor 指向中央 Server）时，多请求往返的延迟与连接开销成为瓶颈**，且多 PM consumer 时 intake 逐个拉取浪费。

产品决策已定：新增聚合端点把一轮快照合成一次往返，且**必须兼容版本偏差**（局域网里 Supervisor 与 Server 版本可能不一致）。

## 目标

1. **服务端聚合端点** `GET /supervisor/tick`（src/server/http.ts + service 层函数）：
   - 查询参数：`consumers=a,b`（PM consumer 列表）、`events_after=<stream-id>`（游标增量）、`binding_aware=1`（返回绑定项目的 bindings+receipts）、`plan_ids=`（可选过滤）。
   - 响应一次返回：plans 快照、每个 consumer 的 intake、events 页（含 next_cursor）、reconcile 结果、绑定道快照。**语义与逐端点调用完全一致**——尤其 `/reconcile` 是有状态操作，聚合版必须逐字段复用现有 `reconcileRuntimeState` 的实现与幂等性，不得另写一份逻辑。
   - 鉴权：Owner Bearer token；不需要开放 Worker token 作用域。
   - 心跳不并入 tick（各 slot 心跳保持独立节流语义），在文档注释里写明原因。
2. **Supervisor transport 适配**（src/worker/supervisor.ts 的 BiaoSupervisorTransport）：启动后首轮探测 tick；**404/405 或字段缺失时静默回落到现有逐端点路径**（版本偏差安全），成功则后续轮次用 tick。`BIAO_SUPERVISOR_TRANSPORT=legacy` 强制回落（调试用）。多 consumer intake 由 tick 天然合并。
3. **测试**：`tests/supervisor-tick.test.ts` —— (a) service 层：tick 响应与逐端点调用结果逐字段一致（含 reconcile 副作用一致）；(b) transport：mock 404 → 回落且行为与旧路径一致；(c) tick 成功路径减少请求计数（用 fetch 计数断言）。现有套件（supervisor-runtime、supervisor-project-agent-binding、restore-maintenance-gate 等）不得回归。
4. **文档**：docs/runbooks/ 下新增简短中文说明（局域网多机部署的 tick 与版本兼容矩阵：新版 Supervisor+旧 Server → 自动回落；旧 Supervisor+新 Server → 不调用 tick，无影响）。

## 约束

- 全程中文注释与文档。
- **不得修改**：`src/mcp/**`、`scripts/agent-join.mjs`、`scripts/worker-agent.mjs`、`docs/mcp.md`、`docs/agent-join.md`、`web/`。
- 不启动/重启 `.biao/start` 生产栈；测试用 redis://127.0.0.1:6380（已运行），优先复用现有测试文件，若新增 `*_TEST_REDIS_URL` 变量须同步 `tests/release-readiness.test.ts` 与 `.github/workflows/ci.yml`（DB 2-15 已满，尽量不新增套件）。
- 恢复屏障语义不变：tick 里的 reconcile 部分沿用现有 permit 门控。

## 验收标准

1. `npm run build:server` 通过。
2. `npx vitest run tests/supervisor-tick.test.ts tests/supervisor-runtime.test.ts tests/supervisor-project-agent-binding.test.ts` 全绿。
3. 手工演示（用隔离端口起 Server，不开生产栈）：同一轮快照，tick 路径请求数 = 1，回落路径行为不变。
4. 交付说明列出：tick 响应字段表、回落触发条件清单、兼容矩阵。
