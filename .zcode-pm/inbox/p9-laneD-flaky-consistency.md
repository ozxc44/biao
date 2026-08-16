# 后续增强·车道 D（V1 flaky 根治 + 一致性测试补强）

## 背景

车道 A/E 已验收（全量基线 **126 文件 / 1533 用例**）；车道 C（transition/recovery）与车道 B（调度执行）**并行运行中——其文件不得触碰**。本车道处理两个长期拖累全量门禁的独立事项。

## 目标

1. **V1 supervisor SIGINT/SIGTERM 孙进程竞态 flaky 根治**（全会话登记的已知 flaky）：
   - 现象：`tests/supervisor-pm-agent-cli.test.ts` 的 SIGINT/SIGTERM 两用例 ~30-50% 失败，`grandchildStopped` 20s 探针超时；单独复跑多数通过但不稳定；
   - 机制线索（PM 已定位）：`scripts/supervisor.mjs` 的 `signalPmAgentTree` 用 `process.kill(-child.pid)` 杀进程组，依赖 PM agent 子进程 spawn 时 `detached:true` 成为组长；grandchild 若被 agent 以**自己的新进程组**（detached）或**竞态窗口内 respawn** 拉起，则组信号到不了它；测试的 blocking-agent fixture 行为需一并检查；
   - 要求：找出确切竞态窗口，修复 supervisor 停止路径（如组杀失败后按已知 pid 树补杀、或 agent fixture 保证不脱离进程组）；**不放宽测试断言**（必须真的规范退出不残留）；验证：该文件**连续 10 次全绿**（贴运行摘要）+ 全量 2 次不因它失败。
2. **22.4-07 V2 侧 Redis 清空重建测试**（审计不确定-1 的从严口径）：V2 调度态（node session/presence/lease）在 Redis FLUSHDB 后从 durable（SQLite）重建的专门测试：清空→重建→断言无半投影（claim 不开放旧 generation、lease 不复活）、audit/outbox 不重复；若某载体当前无 durable 支撑，如实标注为缺口而不是硬造断言。
3. **22.4-33 删除身份隔离验证**（审计部分覆盖点名）：针对"删除操作身份隔离"（谁不能删什么）在 V2 面的路由矩阵测试（按 rbac 现有角色×删除类路由：membership 撤销/authorization 删除/cleanup 删除等，拒绝路径逐断言）；如实现有缺口如实列出。
4. **22.2-03 三方对账最小实现**：`src/server/v2/reconcile-three-way.ts`——对账函数：SQLite（deliveries/artifacts 元数据）× artifact blob 目录 × git refs（经 provider 只读）三方计数+digest 比对，输出偏差清单（未解释偏差≠错误，交 incident/人工）；CLI/API 只挂一个 owner 查询路由（如路由文件冲突则只交付 service+测试，路由缺口列清单）；测试：注入单侧缺失/篡改→对账报告逐项命中。

## 约束

- 全程中文；**所有权**：`scripts/supervisor.mjs`（flaky 修复）、`tests/supervisor-pm-agent-cli.test.ts`（仅当修复需要同步 fixture 行为时最小改动，断言不放宽）、`src/server/v2/reconcile-three-way.ts`（新）、`tests/distributed/p9-consistency.test.ts`、`tests/distributed/p9-redis-rebuild.test.ts`（或并入前者）、runbook 增补。**不得改**：车道 B/C 文件（见其任务书）、`src/server/v2/git/**`（provider 只 import）、`src/server/service.ts`、`src/mcp/**`、`web/`、既有 fixture。
- **注意**：车道 B 可能同时改 V2 claim/heartbeat 与 src/node/**——本车道的 Redis 重建测试如依赖其产出，先按当前接口写、接口变化风险在交付说明标注。
- 四条验证原始输出随交付（含 flaky 文件 10 连跑摘要）；门禁：构建 + 全量不劣化 126/1533 基线。

## 验收标准

1. flaky 文件 10 连跑全绿 + 全量 2 次稳定；根因与修复点说明。
2. 三项一致性测试逐条路径；对账报告字段示例；缺口如实清单。
