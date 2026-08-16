# Phase 2+3 统一集成门禁：关闭服务端缺口 + Node→Artifact→Delivery 端到端

## 前置状态（两 Phase 均已单独验收）

- Phase 2：Artifact Store（三段上传/幂等/防篡改、005 迁移、Report V2、Delivery review 只读）——`src/server/artifact-store.ts`、`src/server/v2/artifact-service.ts`、`src/server/v2/report-v2.ts`。
- Phase 3：biao-node（daemon/CLI/watchdog/协议协商/凭据存储/模板）——`src/node/**`，其交付说明 runbook §8 列出 **8 项服务端接口缺口**（必读）。
- 全量基线 **112 文件 / 1260 用例全绿**。
- 方案 §21 原文："端到端 Node→Artifact→Delivery 门禁在二者集成后统一验收，不把单 lane 绿色当闭环。"

## 目标

1. **关闭 runbook §8 缺口中集成必需的五项**（其余三项——心跳 running_attempt_ids schema 扩契约、package files 模板行、Windows 实跑——列入交付说明移交后续）：
   - ① `/version` 公告 `protocol_version`（读 `src/node/protocol.ts` 的区间常量，服务端声明自身版本）；
   - ② `POST /v2/nodes/enroll` 校验 enrollment ticket（`BIAO_V2_ENROLLMENT_TICKET` env，未配置则 enroll 关闭并 503 明示；ticket 常量时间比较）；
   - ③ `POST /v2/nodes/register` 接受 `protocol_version` 与显式 session generation；协议不匹配 409 fail-closed（复用 daemon 侧同一套区间语义）；
   - ④ **bvn2 Node credential 成为 V2 节点路由的正式鉴权**：`register/heartbeat/offline(node scope)` 验签（`src/server/v2/credentials.ts` 已有 verify），generation/session 不匹配 409；owner bearer 保留为管理面（enroll/authorize/revoke/drain）；
   - ⑤ **Attempt 数据面三路由接通**（替换 stub）：`POST /v2/attempts/claim`（node credential + 授权校验 → 创建 task_attempts 行 + 签发 bva2）、`POST /v2/attempts/:id/renew`（bva2 scope=claim + generation fencing + lease TTL）、`POST /v2/attempts/:id/report`（bva2 scope=report → 调 Phase 2 reportV2WithArtifacts，artifact 引用校验，生成 delivery）。task_attempts 表 §20.1 最小字段入 migration `006_task_attempts`（若 Phase 2 的 005 已含 deliveries 则只补 attempts/ownership_snapshots 实表）。
2. **端到端集成门禁测试** `tests/distributed/p23-integration-gate.test.ts`（真实 HTTP server + 真实子进程 `bin/biao-node.js`，全程零 V1 worker token）：
   - enroll（ticket）→ register（bvn2，协议握手）→ heartbeat → **claim attempt（bva2 返回）→ 占位 executor 产出小文件 → 三段上传 artifact → report 引用 → delivery 落库 → PM Review V2 读回完整视图**；
   - 反向门禁：篡改 bva2 → 401/403；跨任务 artifact 引用 → 拒绝；旧 generation heartbeat → 409 fenced；enroll 无/错 ticket → 503/403；
   - daemon 掉线（SIGKILL）重启后 attempt 走 pending_recovery 不被双认领（Phase 3 语义在真实 claim 路由下复验）。
3. daemon 侧若需跟随（如 transport 已支持 bvn2 但 server 401 回退逻辑调整）：**只改 `src/node/transport.ts`/`daemon.ts` 的鉴权头与错误分类**，不动状态机；`auth_mode=owner_fallback` 移除或仅显式 env 开启。
4. 更新 runbook §8 缺口清单状态（关闭/移交），review log 由主会话记录。

## 约束

- 全程中文；**所有权**：`src/server/v2/**`（含 routes）、`src/server/http.ts`（装配行）、`src/db/migrations/006_*.ts`、`src/db/migrate.ts`、`src/db/sqlite-store.ts`（追加）、`src/types/**`（v2 追加）、`src/node/transport.ts`、`src/node/daemon.ts`（仅鉴权/错误分类）、`tests/distributed/p23-*.test.ts`、受影响版本期望测试、runbook §8。**不得改**：`src/server/service.ts`、`src/server/http-plugins.ts`、`src/mcp/**`、`web/`、既有 fixture（可扩展辅助于测试文件内）。
- 不新增 npm 依赖与 `*_TEST_REDIS_URL`（复用 6380，测试内 flush）；不启动生产栈。
- 门禁：构建 + 全量不劣化 112/1260 基线（已知 SIGTERM/SIGINT flaky 单独复跑）。

## 验收标准

1. `npm run build:server` + `npx vitest run tests/distributed/` 全绿；全量复跑不劣化。
2. 端到端正反向场景全过（上文清单逐项）。
3. 交付说明：五缺口关闭对照（§8 编号→实现位置）、006 迁移演练、移交三项的去向、端到端时序图（文字）。
