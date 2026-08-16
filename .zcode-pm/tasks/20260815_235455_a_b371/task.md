# Phase 0a-2（车道 A）：V2 基础设施最小 schema（migration 003）+ 类型 + 门禁测试

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 `docs/distributed-multi-node-development-plan.md`（v0.8.0-round7-revision）。Phase 0a-1 已完成（`src/db/migrations/001_baseline.ts`、`002_project_agent_bindings.ts`、`src/db/migrate.ts` runner、备份副本演练 `src/db/migrate-copy.ts`、项目映射 `src/migration/project-mapping.ts`；对应测试 `tests/distributed/p0a1-*.test.ts` 全绿）。

现在执行 **Phase 0a-2 的 schema 部分**：把 §20.1"基础设施最小 durable schema"固化为 migration `003_v2_infra_minimal`，字段可扩展但不得少于方案表中的身份、状态和恢复键。

先读：主方案 §20.1（逐表最小字段表）、§20.3（唯一约束）、§20.4（迁移纪律）、§14.5/§14.6（outbox/idempotency/restore point 语义）、§4.4.1/§4.4.2（orphan recovery 与 recovery isolation/branch cleanup 状态机）。

## 范围（本次只做"基础设施最小"，不含领域大表）

migration `003_v2_infra_minimal.ts` 覆盖这些表（§20.1 表格里有最小字段定义的）：
`audit_events`、`outbox_events`、`idempotency_records`、`restore_points`、`backup_runs`、`project_mode_transitions`、`orphan_recovery_candidates`、`recovery_isolations`、`branch_cleanups`、`external_merge_intents`。

**不做**：projects/nodes/node_sessions/node_project_bindings/agent_slots/task_attempts/ownership_snapshots/deliveries/artifacts 等领域表（属 Phase 1+），但本迁移要给 §20.2 的 plans/tasks 扩展列留注释占位（不实际加列）。

## 目标

1. **migration 003**：上述十张表，字段=方案 §20.1 最小字段表逐列落库（INTEGER 时间戳毫秒、TEXT ID、状态字段用 CHECK 约束收窄枚举，枚举值从方案 §4/§5 状态机取；`project_id` 先允许 NULL 或 TEXT 占位，Phase 1 才有 projects 表——在迁移头注释写明这个过渡决策）；唯一约束按 §20.3（含"每 project 同时最多一个 running transition""同一 object_type+object_id 同时最多一个未 resolved isolation"——SQLite 用部分唯一索引表达）。
2. **SqliteStore 方法**：每表最少 insert/query-by-key/list-by-status（append-only 表如 audit/outbox 只 insert+list）；类型放 `src/types/v2-infra.ts`（新文件，Row 类型与状态枚举，中文注释标注对应方案小节）。
3. **门禁测试** `tests/distributed/p0a2-infra-schema.test.ts`：
   - 生成式字段对照：从方案文档 §20.1 表格**解析**最小字段清单（读 docs 文件按行解析，不许硬编码清单），逐表断言 migration 后 `pragma table_info` 覆盖全部最小字段（字段可以多不许少）——文档与实现的机器对齐门禁；
   - 约束测试：running transition 唯一、未 resolved isolation 唯一、idempotency 三键唯一、outbox (aggregate_type,aggregate_id,aggregate_revision) 定位；
   - 迁移纪律：003 在备份副本上演练成功（复用 migrate-copy 流程）+ 旧库（001/002 状态）前向升级零数据丢失。
4. **outbox/idempotency 最小服务函数**：`src/server/v2/outbox.ts`——appendOutboxEvent（含 payload_digest 计算）、markOutboxStatus、listRetryableOutbox（next_attempt_at 到期且未 dead_letter）；幂等：`recordIdempotency`/`findIdempotency`（request_digest 比对）。只做纯数据面，不接 HTTP。
5. 更新 `tests/distributed/p0a1-migrations.test.ts`：全量迁移链期望从 `['001','002']` 相应更新（该测试此前已同步过一次，注意保持其既有语义）。

## 约束

- 全程中文注释与文档。
- **文件所有权**：只改/新增 `src/db/migrations/003_v2_infra_minimal.ts`、`src/db/sqlite-store.ts`（追加方法）、`src/types/v2-infra.ts`、`src/server/v2/outbox.ts`、`tests/distributed/p0a2-*.test.ts`、`tests/distributed/p0a1-migrations.test.ts`。**不得改**：`src/server/service.ts`、`src/server/http.ts`、`src/server/http-plugins.ts`、`src/server/v2/domain-interfaces.ts`、`src/server/v2/routes/**`（另一车道所有）、`src/mcp/**`、`web/`、`scripts/`。
- 若新增 `*_TEST_REDIS_URL` 变量：本任务应纯 SQLite、不需要 Redis。
- 不启动生产栈。

## 验收标准

1. `npm run build:server` 通过。
2. `npx vitest run tests/distributed/ tests/sqlite-upsert-fk.test.ts` 全绿（含新生成式字段对照门禁）。
3. 手工演示：`node scripts/migrate-sqlite.mjs --source <旧库副本> --output <演练库>`（或既有等价入口）演练 003 成功并输出行数报告。
4. 交付说明：十表字段↔方案小节对照表、约束清单、过渡决策（project_id 占位）说明。
