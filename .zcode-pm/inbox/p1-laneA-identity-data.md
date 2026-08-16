# Phase 1（车道 A）：Project/Node Identity 数据层（migration 004 + 类型 + Store + Redis keys）

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 v0.8.0。已完成 0a-1/0a-2/0b（fixture 在 `tests/distributed/fixtures/`：git-fixture / artifact-store-fixture / node-simulator / fault-injector；全量基线 **106 文件/1148 用例全绿**）。

先读：方案 §4.1（Project）、§4.2（Node 状态机含 enrolling）、§4.3（NodeProjectBinding）、§2.4 与 `src/migration/project-mapping.ts`（显式 legacy binding，**禁止按路径 hash 猜 project_id**——R1B-002）、§20.1 表格（projects/nodes/node_sessions/node_project_bindings/agent_slots/legacy_project_bindings 的最小字段）、§20.2（plans/tasks 扩展列）、§20.3（约束）、§15.1/15.2（API 形状参考）。

## 目标

1. **migration `004_domain_identity.ts`**：六张领域表——`projects`（含 execution_mode/mode_transition/write_capability_status/revision）、`nodes`（含 enrolling 状态与 TTL 终态字段，§4.2）、`node_sessions`（generation/credential_generation/fenced_at）、`node_project_bindings`（authorization_status/authorization_revision 单调/applied_policy_revision/write_credential_status/health）、`agent_slots`（capability_digest/active_attempt_id）、`legacy_project_bindings`（legacy_project_path + repository_fingerprint 唯一）。**plans/tasks 扩展列**（§20.2：project_id/active_attempt_id/accepted_delivery_id/completion_kind 等，全部可空过渡，不破坏 V1 读写）；`agent_registrations` 加 node_id/slot_id/protocol_version 可空列。约束按 §20.3（node+project 唯一、revision 单调由 CHECK/触发器或应用层保证——写明选择）。
2. **类型** `src/types/v2-identity.ts`：六表 Row 类型 + 状态枚举（Node 状态机全态含 enrolling/quarantined 等 §4.2 定义）+ execution_mode 枚举，中文注释标小节。
3. **SqliteStore 方法**：六表 CRUD + 按 key/状态查询 + plans/tasks 按 project_id 查询；node_session generation fencing 查询（当前代次）。
4. **Redis keys** `src/redis/keys.ts`：V2 namespace 前缀（`biao:v2:`，与 V1 不混用——§20.4），node session/attempt token/ownership_snapshot 的 key 布局，只加常量不接线。
5. **失败优先测试**（构建在 fixture 上）`tests/distributed/p1-identity-data.test.ts`：迁移链 001→004 在备份副本演练；约束测试（node+project 唯一、legacy binding 显式、generation 单调）；两台模拟 Node（node-simulator fixture）不同本地路径 → 经显式 legacy_project_bindings 识别为同一 project_id（**方案 Phase 1 验收原文场景**）；旧 generation session 写入被拒（store 层断言）。
6. 更新 `tests/distributed/p0a1-migrations.test.ts` 或相关套件的版本期望（保持既有语义，只推进版本号）。

## 约束

- 全程中文；**只改/新增**：`src/db/migrations/004_domain_identity.ts`、`src/db/migrate.ts`（注册）、`src/db/sqlite-store.ts`、`src/types/v2-identity.ts`、`src/redis/keys.ts`、`tests/distributed/p1-*.test.ts` 及受影响的版本期望测试。**不得改**：`src/server/**`、`src/migration/**`（只读参考）、`src/mcp/**`、`web/`、`scripts/`、既有 fixture 文件（可 import 不可改——若 fixture 缺能力，在测试文件内扩展辅助而不是改 fixture）。
- 不新增 `*_TEST_REDIS_URL`；纯 SQLite + 既有 6380。
- 门禁：`npm run build:server` + 全量不劣化（106/1148 基线，已知 SIGTERM flaky 单独复跑）。

## 验收标准

1. 构建通过；`npx vitest run tests/distributed/` 全绿（含新 p1 套件）。
2. 迁移演练 001→004 备份副本成功 + integrity ok。
3. 交付说明：六表字段↔§20.1 对照、约束实现方式（CHECK/部分索引/应用层）清单、两节点同 Project 的验收场景测试路径。
