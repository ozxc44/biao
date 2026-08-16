# Phase 1：Project/Node Identity（派发前置：Phase 0b 验收通过）

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 v0.8.0。已完成：0a-1（迁移底座）、0a-2（003 infra schema + 七领域接口 + route registry + 共享 plugin）、0b（分布式测试 fixture：bare Git Remote / Artifact Store / 双逻辑 Node / 故障注入）。本阶段执行方案 §21 Phase 1，先读：§4.1（Project）、§4.2（Node）、§4.3（NodeProjectBinding）、§13.1（身份分层/凭据分裂）、§15.1/15.2（API）、§2.4（V1→V2 映射）、§20.2/20.3（扩展列与约束）、`src/migration/project-mapping.ts`（既有映射实现，禁止按路径 hash 猜 project_id——R1B-002）。

## 目标（占位框架，0b 验收后按 fixture 实际接口修订再派发）

1. **migration 004_domain_identity**：`projects`（§20.1 最小字段+约束）、`nodes`、`node_sessions`、`node_project_bindings`、`agent_slots`、`legacy_project_bindings`；`plans/tasks` 扩展列（§20.2，可空过渡）。
2. **Project Registry 与显式授权**：Project CRUD、Node Enrollment/Register/Heartbeat（generation fencing：旧 generation 不能覆盖新 session）、Node→Project 显式授权流（authorization_revision 单调）。
3. **V2 project-scoped Ownership**：ownership_snapshots 写入（claim 时快照、report 校验 revision）。
4. **凭据分裂最小基础**：Node credential 与 Attempt token 的签发/校验函数（§13.1 层级），V1 Worker Token 对启用 V2 的 Project 的 claim/report/renew/ownership 全部拒绝（失败优先测试先写）。
5. **V2 路由落地**（registry 中 Phase 1 相关条目）：`/v2/projects`、`/v2/nodes`、`/v2/node-sessions` 等，走 v2 路由模块 + 共享 plugin。
6. **验收（方案原文）**：两台模拟节点（0b fixture）使用不同本地路径被识别为同一 Project；旧 agent generation 不能覆盖新节点 session；全部测试构建在 0b fixture 上且失败优先。

## 约束（占位）

- 全程中文；分车道派发时按文件所有权切分（迁移/类型 vs 路由/服务）。
- 门禁：全量不劣化基线；0b fixture 测试全覆盖新增行为；不碰 `src/mcp/**`、`web/`、生产栈。
