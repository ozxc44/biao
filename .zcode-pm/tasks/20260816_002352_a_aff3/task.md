# Phase 0b：分布式测试基础设施（0a-2 已验收，基线 102 文件/1105 用例全绿）

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 `docs/distributed-multi-node-development-plan.md` v0.8.0。Phase 0a-2 已完成并验收：migration `003_v2_infra_minimal`（十张基础设施表）、`src/server/v2/outbox.ts`（append/mark/listRetryable + idempotency）、`src/types/v2-infra.ts`、七领域接口 `src/server/v2/domain-interfaces.ts`、route registry `src/server/v2/routes/registry.ts`、共享 plugin `src/server/http-plugins.ts`。全量基线 **102 文件 / 1105 用例全绿**。现在执行 **Phase 0b**，对应评审项 R1B-010。

## 目标（先读主方案 §21 Phase 0b、§6 Git 工作空间、§9 Artifact Store）

1. **本地 bare Git Remote fixture**：测试内创建 bare 仓库（`git init --bare`），提供 push/clone/ls-remote 辅助与"默认分支 CAS"断言工具；跨平台（macOS 本机 git）。
2. **Artifact Store fixture**：临时内容寻址目录（sha256 命名）+ 上传/下载/manifest 校验辅助（对齐 §9.2/9.3：大小上限、路径穿越拒绝）。
3. **两个逻辑 Node 模拟器**：同一测试进程内两个隔离 Node 身份（不同本地 clone 路径），共享一个测试 Redis namespace 与 bare remote；提供"节点注册/心跳/领取/推送交付"的最小骨架函数（后续 Phase 3 biao-node 的测试替身）。
4. **故障注入器**：可控"网络分区"（拦截 fetch 的 fault-routes fetchImpl）、进程中断（kill 子进程句柄）、时钟偏差（注入 offset 的 now()）。
5. **V1/V2 兼容基线快照测试**：在 fixture 上跑一遍 V1 主链路（plan submit→claim→report→review）+ V2 infra 表读写（outbox append→retry→dead letter；idempotency 命中/未命中），固化基线快照，后续 Phase 必须在此 fixture 上给失败优先测试。
6. 全部落在 `tests/distributed/fixtures/`（fixture 库）与 `tests/distributed/p0b-*.test.ts`（基线测试），纯 SQLite + 测试 Redis（127.0.0.1:6380），不启动生产栈。

## 约束与验收

- 全程中文；不碰 `src/mcp/**`、`web/`、生产栈；不改 `src/server/service.ts`、`src/server/http.ts`（fixture 只消费现有接口）。
- 测试 Redis 用 redis://127.0.0.1:6380 已运行实例；**新增套件的 `*_TEST_REDIS_URL` 变量禁止引入**（DB 2-15 已满且 release-readiness 会拦截）——如需专用 DB，在现有 6380 实例内复用未占用 DB 并在 fixture 内 flush。
- 门禁：`npx vitest run` 全量不得劣化于 102 文件/1105 用例基线（已知 supervisor-pm-agent-cli 的 SIGTERM 用例偶发时序 flaky，允许其单独复跑）。
- 验收演示（写入交付说明）：bare remote 上完成一次真实 push + CAS 断言；artifact fixture 拒绝一次路径穿越与一次超大文件；两个 Node 对同一 task 的领取竞争只有一个赢家；故障注入器各触发一次并断言失败路径。
