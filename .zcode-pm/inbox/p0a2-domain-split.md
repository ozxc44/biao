# Phase 0a-2（车道 C）：service 领域拆分接口 + 共享 Fastify 插件

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 `docs/distributed-multi-node-development-plan.md`（v0.8.0-round7-revision）。Phase 0a-1 已完成并通过门禁（migration runner、001/002、备份演练、project mapping，测试全绿）。现在执行 **Phase 0a-2** 的领域拆分部分，对应评审项 R1B-001（先定义五个领域服务和旧 facade 边界）与 R1B-004（抽共享 Fastify plugin，V1/V2 route/schema 分离）。

先读：主方案 §21 Phase 0a-2、§15.6（API 通用要求）、§14.5（durable-first 提交协议）、§24 关键设计决策。

## 现状

- `src/server/service.ts` ~1.42 万行导出函数集合（V1 全部逻辑）；已有 `src/server/maintenance.ts`（维护屏障，从 service.ts 抽出的先例：service.ts 重导出保持兼容）。
- `src/server/http.ts` 内联全部路由 + 钩子（onRequest 鉴权、preHandler permit、preSerialization barrier）。

## 目标

1. **领域服务接口层** `src/server/v2/domain-interfaces.ts`（或按服务拆多文件）：定义方案要求的七个服务接口——`ProjectService`（Project/Binding）、`NodeService`（Node）、`AttemptService`（claim/lease/Question）、`DeliveryService`（Artifact/Delivery/Review/repair/reverify）、`MergeService`（Merge/external intent）、`IncidentService`（Incident/SLO）、`ReconcileService`（outbox/restore/orphan/ownership）。每个接口：方法签名以现有 service.ts 函数签名与 ApiResponse 信封为基础，标注 V2 语义差异（如 AttemptService 带 attempt_generation fencing）；只定义接口与类型，不搬实现。
2. **V1 facade 边界**：service.ts 顶部加中文注释块声明"0a-2 起不再新增 V2 逻辑；新逻辑进入对应领域模块"，并把现有函数按七个服务归类写入 `src/server/v2/SERVICE_MAP.md`（中文，函数清单↔服务归属，作为后续搬迁的台账）。
3. **共享 Fastify plugin**：把 http.ts 的三个横切钩子（onRequest 鉴权、preHandler permit/restore gate、preSerialization barrier）抽成 `src/server/http-plugins.ts` 导出的 Fastify plugin（参数化 config），`http.ts` 只装配。V1 行为零变化。
4. **V2 route registry 骨架**：`src/server/v2/routes/registry.ts`——声明式 V2 路由注册表（method/path/schema/handler 引用/所需凭据作用域），加一个**生成式门禁测试** `tests/distributed/p0a2-route-registry.test.ts`：每个 registry 条目必须有 schema、必须声明凭据作用域（owner/worker/mcp 禁入 V2 写面按方案 §13.1）、路径不得与 V1 冲突（前缀 `/v2/`）。
5. 测试：现有 V1 全量套件零回归（这是硬门禁）；新增 registry 门禁测试 + 一个 plugin 抽取等价性测试（鉴权 401/403/permit/barrier 行为与旧内联一致，可参照 tests/restore-maintenance-gate.test.ts 的断言）。

## 约束

- 全程中文注释与文档。
- **文件所有权**：只改 `src/server/service.ts`（注释+台账）、`src/server/http.ts`（装配化）、新增 `src/server/http-plugins.ts`、`src/server/v2/**`、`tests/distributed/p0a2-*.test.ts`。**不得改**：`src/db/**`、`src/types/index.ts`、`src/migration/**`、`src/mcp/**`、`web/`、`scripts/`（另一车道所有）。
- 不启动生产栈；测试用 redis://127.0.0.1:6380（已运行）。
- V1 行为零变化：全量 `npx vitest run` 必须与当前基线一致（当前基线：98 文件/1063 用例，1 个已知 SIGTERM 时序 flaky）。

## 验收标准

1. `npm run build:server` 通过；`npx vitest run` 全量不劣于基线（仅允许既有 flaky）。
2. `tests/distributed/p0a2-route-registry.test.ts` 与 plugin 等价性测试绿。
3. 交付说明列出：七个接口文件清单、SERVICE_MAP 统计（各服务函数数）、http.ts 行数变化（应显著缩减）。
