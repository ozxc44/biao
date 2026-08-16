开始执行 Phase 1 任务。先读取方案文档和现有代码结构。
Now let me read the design document sections and the fixtures.
Let me read the key design document sections.
Now I have a thorough understanding of the design. Let me implement all the deliverables. I'll start with the migration, types, and then work through the rest.
I need to fix the ordering - the index was placed before the table. Let me fix that.
Good, no `project_id` column conflict. Now let me create the types file and update the other files in parallel.
Now let me update `migrate.ts` to register the new migration, and update `redis/keys.ts` with V2 namespace.
Now let me add the SqliteStore methods for the 6 new tables. First, I need to add the imports.
Now let me verify the build compiles.
Build passes. Now let me write the test file `p1-identity-data.test.ts`.
Now let me write the comprehensive test file.
Now I need to update the `p0a1-migrations.test.ts` to account for the new migration 004. The hardcoded schema snapshot will break because there are new tables and columns.
Let me check if the existing test will pass with the new migration. The tests use `currentMigrationFixture()` which dynamically computes the expected schema.
Existing migration tests pass. Now let me run the new P1 test.
The issue is `INSERT OR REPLACE` in the store method. It should use plain `INSERT` for the constraint test. Let me fix the store method.
All 14 P1 tests pass. Now let me run the full distributed test suite to verify no regressions.
There are hardcoded version expectations in `p0a2-infra-schema.test.ts`. Let me fix them.
Let me check for other hardcoded version expectations across all distributed tests.
The remaining `'003'` references use `toContain` which will still pass. Let me run the full suite again.
All 126 distributed tests pass (11 files). Let me verify the build still works.
Build passes. Let me verify the full test suite count hasn't regressed.
One more hardcoded `'003'` version expectation outside the distributed tests. Let me find and fix it.
全部 131 测试通过（12 文件），构建通过。下面是交付总结。

---

## 交付总结

### 变更文件清单

| 文件 | 变更类型 |
|---|---|
| `src/db/migrations/004_domain_identity.ts` | **新增** — 六张领域表 + plans/tasks/agent_registrations 扩展列 + 触发器 |
| `src/db/migrate.ts` | **修改** — 注册 004 迁移 |
| `src/types/v2-identity.ts` | **新增** — 六表 Row 类型 + 状态枚举 |
| `src/db/sqlite-store.ts` | **修改** — 新增六表 CRUD + 按 key/状态查询 + plans/tasks 按 project_id 查询 + generation fencing 查询 |
| `src/redis/keys.ts` | **修改** — 新增 `v2Keys`（`biao:v2:` namespace，与 V1 不混用） |
| `tests/distributed/p1-identity-data.test.ts` | **新增** — 14 个测试用例 |
| `tests/distributed/p0a2-infra-schema.test.ts` | **修改** — 版本期望 003→004 |
| `tests/project-agent-binding-core.test.ts` | **修改** — 版本期望 003→004 |

### 六表字段 ↔ §20.1 对照

| 表 | §20.1 最小字段 | 实现状态 |
|---|---|---|
| `projects` | project_id, display_name, repository_url, repository_fingerprint, default_branch, execution_mode, mode_transition, mode_transition_id, mode_transition_step, write_capability_status, status, revision, created_at, updated_at | 全部实现 + merge_policy/artifact_policy_id/workspace_policy_id |
| `nodes` | node_id, display_name, os, arch, node_version, protocol_version, status, capabilities, labels, capacity, last_seen_at, credential_generation, clock_skew_ms, server_cert_not_after, trust_anchor_generation, signing_key_generation | 全部实现 + terminal_state_at/reason/ttl_expires_at（§4.2 终态 TTL） |
| `node_sessions` | session_id, node_id, node_session_generation, credential_generation, status, started_at, last_seen_at, fenced_at | 全部实现 |
| `node_project_bindings` | node_id, project_id, repository_fingerprint, authorization_status, authorization_revision, applied_policy_revision, write_credential_status, health, last_checked_at | 全部实现 + local_cache_root/checkout_mode 等 |
| `agent_slots` | slot_id, node_id, session_id, capability_digest, status, active_attempt_id, updated_at | 全部实现 |
| `legacy_project_bindings` | legacy_project_path + repository_fingerprint 唯一 | 全部实现（复合主键） |

### 约束实现方式清单

| 约束 | 实现方式 |
|---|---|
| `node_project_bindings(node_id, project_id)` 唯一 | **CREATE UNIQUE INDEX** `idx_node_project_bindings_unique` |
| `authorization_revision` 单调递增 | **触发器** `trg_npb_auth_revision_monotonic`（BEFORE UPDATE，拒绝回退） |
| `node_session_generation` 单调递增 | **触发器** `trg_node_session_gen_monotonic`（BEFORE INSERT，同节点新 generation 必须大于已存在最大值） |
| `legacy_project_bindings(legacy_project_path, repository_fingerprint)` 唯一 | **复合 PRIMARY KEY** |

### 两节点同 Project 验收场景测试路径

`tests/distributed/p1-identity-data.test.ts` → `两台模拟 Node 不同本地路径 → 同一 project_id（方案 Phase 1 验收场景）` → `node-A 和 node-B 各自 clone 不同路径，经显式 legacy_project_bindings 识别为同一 project_id`

### 验证结果

- `npm run build:server` — 通过
- `npx vitest run tests/distributed/` — 126/126 全绿（含新 p1 套件 14 用例）
- `npx vitest run tests/project-agent-binding-core.test.ts` — 5/5 全绿
- 迁移演练 001→004 备份副本 — integrity ok

### 残余风险

- `ALTER TABLE` 扩展列在已有数据的库上执行时依赖 SQLite 的 `DEFAULT` 值填充，对 TEXT/INTEGER 列均安全；但如果未来有 NOT NULL 无 DEFAULT 的列需要回填，需单独迁移步骤。
- 触发器仅覆盖 `authorization_revision` 和 `node_session_generation`；`projects.revision` 的单调性由应用层保证（`updateProject` 中手动递增），未加触发器。