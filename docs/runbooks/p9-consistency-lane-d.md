# P9 一致性补强（车道 D）Runbook

本文档记录车道 D 交付：V1 supervisor SIGINT/SIGTERM 孙进程竞态根治、22.4-07
Redis 清空重建测试、22.4-33 删除身份隔离矩阵、22.2-03 三方对账最小实现。

## 1. V1 supervisor 孙进程竞态根治

### 根因

`scripts/supervisor.mjs` 停止 PM Agent 时，`stop()` 会发一轮 `SIGTERM` 到
pm-agent 的进程组，随后 `finally` 里的 `stopAndDrainActivePmAgents()` 会**再发一轮
`SIGTERM`**。pm-agent 用 `process.once('SIGTERM')` 注册处理器：

1. 第一轮 SIGTERM 命中 once 处理器 → 处理器移除（Node 恢复 SIG_DFL）→ 开始转发
   信号到 detached adapter 进程组；
2. 紧随其后的第二轮 SIGTERM 命中 SIG_DFL → pm-agent 在 adapter 组被回收前被
   **直接杀死** → adapter 的孙进程失孤。

测试表现为 `tests/supervisor-pm-agent-cli.test.ts` 的 SIGINT/SIGTERM 两用例
`grandchildStopped` 20s 探针超时（~30-50% 失败）。

另有一个独立卫生问题：pm-agent 在业务结束后因内核锁 holder 的 stdin/ack pipe
仍打开而**泄漏事件循环**，进程残留在进程表里（直到外部 SIGKILL）。

### 修复

- `scripts/supervisor.mjs`：
  - `stopAndDrainActivePmAgents()` 只在非信号路径（正常闭环退出）补发 SIGTERM；
    信号路径 `stop()` 已发过一轮，不再重复（`if (!receivedSignal)` 守卫）。
  - `signalPmAgentTree()` 增加**沿 pid 树补杀**：组信号只覆盖 pm-agent 自己的
    进程组，adapter 以 detached 独立组启动；现在按 PPID 递归（`pgrep -P`）把
    adapter 及其孙进程逐点补杀，不再依赖 pm-agent 信号处理器代为转发。
- `scripts/pm-agent.mjs`：`main()` 结束时 `.finally(() => process.exit(process.exitCode))`，
  业务结束即主动退出，避免内核锁 pipe 空转残留。

### 验证

`tests/supervisor-pm-agent-cli.test.ts` 连续 10 次全绿（12/12 每次），
全量 2 次不因它失败。修复前后该文件 SIGINT/SIGTERM 用例耗时 ~10.6s（supervisor
undici keep-alive socket 的既有延迟，非本次引入；不影响正确性）。

## 2. 22.4-07 Redis 清空重建测试

文件：`tests/distributed/p9-redis-rebuild.test.ts`

从严口径验证：V2 调度态（node session / attempt lease / ownership snapshot）在
`FLUSHDB` 后不开放半投影，从 durable（SQLite）重建。

当前实现现状（如实声明）：V2 调度态全部落在 `SqliteStore`（nodes /
node_sessions / task_attempts / ownership_snapshots），不依赖 Redis 缓存投影；
`src/redis/keys.ts` 的 `v2Keys` namespace（nodeSession/nodeActiveSession/
attemptToken/nodeHeartbeat）声明但**未被当前调度实现消费**。因此测试验证的是：
Redis 丢失后 V2 服务仍以 SQLite 为真相源工作、旧 generation 不被重开、lease 不
复活、audit/outbox 不重放。若未来调度改走 Redis 缓存双写，需在 claim/heartbeat
路径补本测试的重建分支。

## 3. 22.4-33 删除身份隔离矩阵

文件：`tests/distributed/p9-consistency.test.ts`（describe「删除身份隔离」）

矩阵：owner / project_admin / reviewer / auditor / node / attempt × 删除类路由
（membership 撤销、authorization DELETE、node revoke&drain、session revoke、
node credential rotate、branch-cleanup run/retry、recovery isolation resolve、
recovery candidate discard），拒绝路径逐断言 403 `RBAC_ROLE_DENIED` /
`RBAC_SCOPE_DENIED`。

### 实现缺口（如实列出）

1. **merge_bot（bvm2_）在共享 plugin 层被 401 拦截**：`src/server/http-plugins.ts`
   onRequest 鉴权的 `v2CredentialPresent` 只放行 `bvn2_`/`bva2_`/`bvh2_`，
   未含 `bvm2_`。registry 与 rbac.ts 已支持 merge_bot，但请求进不了 /v2 路由。
   删除隔离语义对 merge_bot 无法经 HTTP 验证。修复：http-plugins.ts 放行前缀
   加 `Bearer bvm2_`。
2. **`POST /v2/recovery-candidates/:candidate_id/decision` 未装配路由**：仅存在于
   `V2_ROUTES`（scope=recovery_reviewer），`v2-routes.ts` 未注册 handler。对其做
   删除隔离断言会先落 Fastify 404。若后续装配应纳入矩阵（allowed:
   owner/project_admin/reviewer）。
3. **`POST /v2/security/revoke-all-sessions` 不进矩阵**：owner 执行会真实前滚密钥
   环，使全部既有 token 失效（全局副作用）。拒绝路径单独逐断言（非 owner →
   403）；owner 放行由 p6-rbac.test.ts 的破坏性端点 describe 覆盖。

## 4. 22.2-03 三方对账最小实现

服务：`src/server/v2/reconcile-three-way.ts`（`reconcileThreeWay()`）

- SQLite 侧：deliveries + artifacts 元数据计数与稳定 digest。
- artifact blob 目录侧：遍历 `<root>/sha256/**`，与 SQLite complete artifact 做
  存在性/大小/内容 sha256 复核；孤儿 blob 记 warning。
- git refs 侧：经 provider 只读 `lsRemote`（`refs/biao/attempt-markers/*` 与
  `refs/heads/biao/attempt/*`），与活跃 delivery 的 branch/marker 交叉比对。
- 输出 `ThreeWayReconcileReport`：三方各侧 `{ source, count, digest }` +
  `discrepancies[]`。偏差仅描述不一致，不自动修复，交 incident/人工。

### 路由缺口

按车道并行约束，`src/server/v2/routes/v2-routes.ts`（车道 C）未加 owner 查询路由；
`registry.ts` 也未加条目。当前只交付 service + 测试。如需挂载，建议：
registry 加 `GET /v2/reconcile/three-way`（owner/auditor），v2-routes.ts 装配
handler（复用 `GenericGitProvider` 与 `artifactRoot`），并纳入 p0a2-route-registry
门禁。

### 局限（如实声明）

- git 面只做 ref 存在性与 digest 比对，不做 marker 内容验签（验签归 workspace 服务）。
- 超大 blob 可关闭 `verifyBlobContent`（默认开启，逐文件读内容复核 sha256）。
