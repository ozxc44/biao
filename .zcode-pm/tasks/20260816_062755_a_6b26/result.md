我来执行 Phase 7a 任务。首先需要了解项目结构和现有代码。
Let me look at more of the existing code to understand the patterns.
Now I have a thorough understanding of the codebase. This is a large Phase 7a task with 8 major deliverables. Let me create tasks and start implementing systematically.
Let me start with the migration and types. I'll implement the core pieces in parallel using subagents for the larger files.
Now I'll create the migration for the incidents table and start implementing the core services. Let me create the migration file first.
Now let me add incident store methods and types. I'll add the type first.
Now let me create the backup coordinator and metrics service in parallel.
Now let me wire up the routes. I need to update v2-routes.ts to replace the stubs with real implementations.
Now let me create the runbook.
Now let me create the comprehensive test file.
Now let me create the V1 work/ migration inventory script.
Now let me run the build to check for compilation errors.
Build passes. Now let me run the tests.
One test fails because artifactManifestDigest returns empty when no artifactRoot is provided. Let me fix the backup coordinator to always produce a digest.
All 22 tests pass. Now let me run the full distributed test suite to verify no regressions.
All 22 test files pass (397 tests). Let me also verify the full test suite.
The 2 failing tests appear to be pre-existing (process signal handling tests, not related to my changes). Let me verify by checking what tests are failing.
These are pre-existing failures unrelated to Phase 7a. All 22 distributed test files (397 tests) pass with zero regressions.
All tasks complete. Let me write the final summary to the task ledger.
Phase 7a 交付完成。以下是总结：

## 交付物

**8 个新文件 + 4 个修改文件**

| 新增文件 | 说明 |
|----------|------|
| `src/db/migrations/010_incidents.ts` | incidents 表（open→acked→resolved + SLA） |
| `src/server/v2/incident-service.ts` | Incident 服务 + 事件源接线 + 审计 |
| `src/server/v2/backup.ts` | BackupCoordinator + WAL checkpoint + restore drill |
| `src/server/v2/metrics.ts` | Prometheus 指标 + 告警规则→自动开单 |
| `src/cli/v2/outbox.ts` | CLI dead-letter 子命令 |
| `docs/runbooks/operations-phase7a.md` | 中文运维手册 |
| `tests/distributed/p7a-ops.test.ts` | 22 个失败优先测试 |
| `scripts/v1-work-inventory.mjs` | V1 work/ 清点脚本 |

## 验证结果

- **构建**: `tsc --noEmit` 零错误
- **p7a 测试**: 22/22 全绿
- **分布式全量**: 22 文件 / 397 用例全绿
- **全量**: 116/118 通过（2 个 pre-existing 失败，非 7a 相关）

## 7b 触发条件自查

所有 CLI/API 处置能力均已覆盖。17 个原 stub 路由替换为真实实现。Web 页面（7b）维持延期，**不触发升级阻塞**。