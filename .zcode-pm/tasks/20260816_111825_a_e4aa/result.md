开始执行深化轮 F 任务。先读审计文档了解缺口详情，同时扫描相关源文件。
先读审计文档和关键源文件。
Let me read more supporting files to understand the full picture.
Now let me read the routes file and existing test patterns.
No p10 tests exist yet. Let me look at the sqlite-store for the methods I'll need, and check the existing test patterns.
Let me read the sqlite-store sections I'll need, and see how existing tests set up the environment.
I have a complete understanding of the codebase. Now I'll implement the three features in parallel. Let me start with the core implementations.
Now I'll implement the three features. Let me start with the outbox.ts changes.

**22.4-18: outbox stall detection + degraded + replay by revision**
Now I'll implement all three features. Starting with the outbox.ts changes for stall detection, degraded marking, and replay by revision.
Now let me add `repairDelivery` and `reverifyDelivery` to delivery-service.ts.
Now let me implement the handleRefAclMiss logic. I'll add a store-level function in ref-acl.ts and wire it in workspace.ts.
Now update queue.ts to use the extracted function from ref-acl.ts.
Now wire the push_forbidden → handleRefAclMiss in workspace.ts.
Now let me add the routes for repair and reverify. Let me find the right place in v2-routes.ts.
Let me check that all store methods I'm using exist and the types match.
I need to fix the `repairDelivery` method to include all required TaskAttemptRow fields.
Good, the types are correct. Now let me create the test file `p10-gap-closure.test.ts`.
Let me build the project to check for compilation errors.
TypeScript compilation passes. Let me run the new test file.
Two issues: missing `afterEach` import and duplicate key in fixture. Let me fix both.
Need to check how tests initialize the SqliteStore. Let me look at how other test files do it.
The store auto-migrates in the constructor. Let me remove the `runMigrations()` calls.
Good progress - 6 tests pass. Need to fix: `display_name` field in ProjectRow and outbox unique constraint. Let me check the ProjectRow type.
Need to fix `makeProject` to include all required ProjectRow fields and fix outbox unique constraint.
Now fix the outbox unique constraint in the collectStalledOutboxStats test.
The `handleRefAclMiss` only needs attempts, not tasks. Let me simplify the test to remove the task dependency.
All 14 tests pass. Now let me run the full test suite to verify no regressions.
All 133 test files pass (1 skipped = pre-existing), 1660 tests pass. This exceeds the baseline of 132 files/1646 tests. Let me verify TypeScript compilation one more time.
All checks pass. Let me mark the tasks as completed.
## 交付总结

### 三项改动点清单

#### 1. 22.1-10：V2 Delivery repair/reverify 实装
- **`src/server/v2/delivery-service.ts`**：新增 `repairDelivery()` 和 `reverifyDelivery()` 方法
  - `repairDelivery`：rejected delivery → 创建新 repair attempt（继承 ownership snapshot + verify 设置，排除原验收者）
  - `reverifyDelivery`：对任意 delivery 重新执行服务端独立复核，更新 diff_summary（幂等）
- **`src/server/v2/routes/v2-routes.ts`**：新增 `POST /v2/deliveries/:id/repair` 和 `POST /v2/deliveries/:id/reverify` 路由

#### 2. 22.4-18：outbox stall 检测 + degraded + 按 revision 重放
- **`src/server/v2/outbox.ts`**：新增 4 个函数
  - `detectStalledOutbox(store, threshold, now)`：pending 事件 next_attempt_at 超阈值 → 返回 stalled 清单
  - `markOutboxDegraded(store, eventId, reason)`：标记 `[degraded]` 前缀到 last_error
  - `replayOutboxByRevision(store, aggregateType, aggregateId, fromRevision)`：按 revision 顺序幂等重放（跳过 delivered、重放 dead_letter→pending、重置 pending）
  - `collectStalledOutboxStats(store, threshold, now)`：按 aggregate_type 分组统计（供 alert-scheduler 数据源接口）
- **`OUTBOX_STALL_DEFAULT_THRESHOLD_MS`**：默认 5 分钟，可通过 env `BIAO_V2_OUTBOX_STALL_THRESHOLD_MS` 调整

#### 3. 22.3-17：handleRefAclMiss 接线
- **`src/server/v2/git/ref-acl.ts`**：新增 `executeRefAclMissCircuitBreaker()` 纯函数
  - fencing 全部 executing attempt → `fenced` + `failure_reason=ref_acl_miss_circuit_breaker`
  - `write_capability_status → lost`
  - 可选 incident 创建（避免循环依赖）
- **`src/server/v2/merge/queue.ts`**：`handleRefAclMiss` 改为调用 `executeRefAclMissCircuitBreaker`
- **`src/server/v2/git/workspace.ts`**：push_forbidden catch 分支接入 `RefAclMissTracker` + `executeRefAclMissCircuitBreaker`
  - 新增 `WorkspaceServiceOptions.refAclMissTracker` 和 `createIncident` 选项

### handleRefAclMiss 迁移理由

原 `handleRefAclMiss` 在 `queue.ts` 中内联，无生产调用方。核心逻辑（fencing + write_capability=lost + incident）提取到 `ref-acl.ts` 作为 `executeRefAclMissCircuitBreaker` 纯函数，因为：
1. `ref-acl.ts` 已是 ref ACL 领域模块（RefAclMissTracker 也在此），熔断逻辑归属一致
2. `workspace.ts`（push_forbidden）和 `queue.ts`（merge queue）均可独立调用，不产生循环依赖
3. incident 创建通过回调注入，避免 ref-acl.ts 依赖 incident-service

### stall 阈值默认值与 env 可调名

- 默认值：`OUTBOX_STALL_DEFAULT_THRESHOLD_MS = 5 * 60 * 1000`（5 分钟）
- env 可调名：`BIAO_V2_OUTBOX_STALL_THRESHOLD_MS`（文档约定，需消费者自行 `parseInt(process.env.BIAO_V2_OUTBOX_STALL_THRESHOLD_MS ?? String(OUTBOX_STALL_DEFAULT_THRESHOLD_MS))`）

### 验证原始输出

1. **TypeScript 编译**：`npx tsc --noEmit` — 0 错误
2. **新测试**：`npx vitest run tests/distributed/p10-gap-closure.test.ts` — **14/14 通过**
3. **全量回归**：`npx vitest run` — **133 文件 / 1660 用例全绿**（基线 132/1646，新增 1 文件 / 14 用例）
4. **测试分布**：22.1-10（4 用例）、22.4-18（6 用例）、22.3-17（4 用例）

### 变更文件清单

| 文件 | 改动 |
|------|------|
| `src/server/v2/delivery-service.ts` | +repairDelivery, +reverifyDelivery |
| `src/server/v2/outbox.ts` | +OUTBOX_STALL_DEFAULT_THRESHOLD_MS, +detectStalledOutbox, +markOutboxDegraded, +replayOutboxByRevision, +collectStalledOutboxStats |
| `src/server/v2/git/ref-acl.ts` | +executeRefAclMissCircuitBreaker |
| `src/server/v2/git/workspace.ts` | +RefAclMissTracker 引用, push_forbidden 接线 |
| `src/server/v2/merge/queue.ts` | handleRefAclMiss 改用 executeRefAclMissCircuitBreaker |
| `src/server/v2/routes/v2-routes.ts` | +POST /v2/deliveries/:id/repair, +POST /v2/deliveries/:id/reverify |
| `tests/distributed/p10-gap-closure.test.ts` | 新增测试文件（14 用例） |

### 残留风险

- `repairDelivery` 创建的 repair attempt 当前为 `pending` 状态，需要 Node claim 后走完整 prepare→finalize→delivery 链路（与正常 attempt 一致）
- `reverifyDelivery` 在无 workspace 的 delivery 上返回 WORKSPACE_NOT_FOUND（预期行为：reverify 需要原始 attempt 工作区存在）
- `BIAO_V2_OUTBOX_STALL_THRESHOLD_MS` env 需消费者自行读取（outbox.ts 导出常量，不直接读 env）