我开始执行 Phase 0a-2 任务。先读取主方案文档和现有代码结构。
Let me read the key sections of the plan and existing code.
Now let me read §20.1 and surrounding sections from the plan document.
Now let me read the state machine sections and existing store/tests.
Let me read §4.1 for the mode transition states and §4.2-4.3 for node/binding status values.
Now let me check existing types and package.json.
Now I have full context. Let me implement all the required files. I'll create the task structure and work through each deliverable.
First, let me create the V2 infra types file.
Now the migration file.
Now register migration 003 in the runner.
Now add the V2 infra methods to `sqlite-store.ts`. First I need to import the types.
Now add the V2 infra store methods before `close()`.
Now create the outbox service file.
Now create the comprehensive test file.
Now let me update the p0a1 test to account for 003 in the chain. The test currently checks `currentVersions.slice(0, 2)` and has a `rowCounts` function that only tracks V1 tables. Let me check if adjustments are needed.
The p0a1 test should work as-is since `currentMigrationFixture()` dynamically picks up all migrations. Let me verify by running the build and tests.
Build passed. Now run the distributed tests.
6 failures to fix. Let me address them all.
Now I need to fix several issues. Let me add update methods to sqlite-store.ts and fix the tests.
Now add updateOutboxEvent method.
Now fix `markOutboxStatus` in outbox.ts to use UPDATE.
Now fix the test file for all 4 issues.
Fix the running transition test to use update method.
Fix the isolation test.
Fix the old DB upgrade test.
Now rebuild and re-run.
Pre-existing issue in domain-interfaces.ts (not my file). Let me check it.
Pre-existing build failure (multiple missing type exports). The working tree has uncommitted changes that removed types. Let me check what's needed.
The pre-existing build failure is about `TaskListItem` not being exported from `types/index.ts`. The other types are already in the working tree. I need to add `TaskListItem` since `domain-interfaces.ts` uses it.
I need to add `TaskListItem` to `types/index.ts` to fix the pre-existing build issue. Let me find where to add it.
Build passed. Now run the tests.
All 51 tests pass. Now let me do the manual migration drill.
Migration drill successful. All 10 new tables created, V1 data preserved, integrity ok.

Let me clean up.
---

## 交付总结

### 验收状态

| 标准 | 结果 |
|---|---|
| `npm run build:server` | 通过 |
| `npx vitest run tests/distributed/ tests/sqlite-upsert-fk.test.ts` | **51/51 全绿**（含 22 个新 p0a2 测试） |
| `node scripts/migrate-sqlite.mjs` 演练 | 成功，appliedVersions=['001','002','003']，integrity ok |

### 变更文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/db/migrations/003_v2_infra_minimal.ts` | 新增 | 十张表 DDL + CHECK 约束 + 部分唯一索引 |
| `src/db/migrate.ts` | 修改 | 注册 003 迁移 |
| `src/db/sqlite-store.ts` | 修改 | 追加 10 组 insert/get/list/update 方法 |
| `src/types/v2-infra.ts` | 新增 | 行类型 + 状态枚举 + 合法 step 常量 |
| `src/server/v2/outbox.ts` | 新增 | appendOutboxEvent / markOutboxStatus / listRetryableOutbox / recordIdempotency / findIdempotency |
| `tests/distributed/p0a2-infra-schema.test.ts` | 新增 | 22 个测试：生成式字段对照、约束、迁移纪律、outbox/idempotency |
| `tests/distributed/p0a1-migrations.test.ts` | 未改 | 自动兼容 003（dynamic fixture） |
| `src/types/index.ts` | 修改 | 补 `TaskListItem` 导出（修复 pre-existing build error） |

### 十表字段 ↔ 方案小节对照

| 表 | §20.1 最小字段 | CHECK/唯一约束 |
|---|---|---|
| `audit_events` | audit_id, project_id, actor_id, action, subject_type, subject_id, correlation_id, evidence_digest, created_at | — |
| `outbox_events` | event_id, project_id, aggregate_type, aggregate_id, aggregate_revision, payload_digest, status, attempt_count, next_attempt_at, last_error, dead_lettered_at, compensates_event_id | status CHECK; (aggregate_type, aggregate_id, aggregate_revision) UNIQUE; partial index on pending |
| `idempotency_records` | actor_id, route, idempotency_key, request_digest, response_entity_type, response_entity_id, response_revision, expires_at | PK (actor_id, route, idempotency_key) |
| `restore_points` | restore_point_id, db_revision, git_refs_digest, artifact_manifest_digest, audit_high_water, outbox_high_water, status, created_at | status CHECK |
| `backup_runs` | backup_run_id, restore_point_id, component, manifest_digest, status, started_at, completed_at, error | status CHECK; FK → restore_points |
| `project_mode_transitions` | transition_id, project_id, from_mode, to_mode, step, status, idempotency_key, deadline_at, last_error, started_at, completed_at | from_mode/to_mode/step/status CHECK; **partial UNIQUE (project_id) WHERE status='running'** |
| `orphan_recovery_candidates` | candidate_id, attempt_id, project_id, marker_ref, branch_ref, head_sha, bundle_manifest_digest, recovery_path, status, decision, takeover_reason, takeover_at, node_ack_status, revision, decided_by, decided_at, resolved_at, resolution_evidence_digest | recovery_path/status/decision/node_ack_status CHECK; **partial UNIQUE (attempt_id) WHERE status='pending'** |
| `recovery_isolations` | isolation_id, project_id, transition_id, object_type, object_id, evidence_digest, reason, status, isolated_by, isolated_at, retention_until, reviewed_by, reviewed_at, review_evidence_digest, resolved_by, resolved_at, resolution_evidence | object_type/status CHECK; **partial UNIQUE (object_type, object_id) WHERE status!='resolved'** |
| `branch_cleanups` | cleanup_id, project_id, delivery_id, branch_ref, expected_head_sha, reason, status, eligible_at, retention_until, last_error, completed_at | reason/status CHECK; (delivery_id, branch_ref, expected_head_sha) UNIQUE |
| `external_merge_intents` | intent_id, project_id, delivery_id, expected_target_sha, provider_actor, approved_by, reason, status, final_sha, created_at, resolved_at | status CHECK |

### 过渡决策

**project_id 允许 NULL**：Phase 1 才有 `projects` 表，本迁移所有 `project_id` 列暂为 `TEXT NULL`，不建外键约束。迁移文件头部注释已记录此决策。

### 残余风险

- `src/server/v2/domain-interfaces.ts` 仍有多个未实现的类型引用（`ApiResponse`, `ClaimedTask` 等来自 V1 service.ts），属于 Phase 1+ 搬迁范围。
- §20.2 plans/tasks 扩展列（project_id, active_attempt_id 等）仅以注释占位，未实际加列。