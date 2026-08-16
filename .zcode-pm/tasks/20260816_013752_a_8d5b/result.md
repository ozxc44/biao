开始执行 Phase 2 Artifact Store。先读取设计方案和现有代码结构。
Let me read the Phase 2 acceptance criteria and the existing test fixture.
Now I have a thorough understanding of the codebase. Let me create the implementation plan and start building. I'll create tasks to track the work.
Now I have full context. Let me start implementing. First, the types.
Now creating the artifact store engine.
I need to add helper methods to the store that the artifact service depends on.
Now updating the V2 routes to wire up artifact endpoints.
Now let me verify the build and run tests.
TypeScript compiles clean. Now let me run the Phase 2 tests.
The test is failing because tasks reference plans via foreign key. Let me fix the test helper.
All 10 Phase 2 tests pass. Now let me verify the full test suite is not regressed.
The 4 failures are existing tests that hardcode version `004` — they need to expect `005` now. Let me update them.
All 200 tests pass. Let me also verify the TypeScript build is clean.
## Phase 2 Artifact Store — 完成总结

### 变更文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/types/v2-artifact.ts` | 新增 | Artifact/Delivery 领域类型、DTO、大小常量 |
| `src/db/migrations/005_artifacts.ts` | 新增 | `artifacts`、`artifact_blobs`、`artifact_upload_sessions`、`deliveries` 四张表 |
| `src/db/migrate.ts` | 修改 | 注册 005 迁移 |
| `src/db/sqlite-store.ts` | 修改 | 追加 20+ 方法（artifact/blob/upload_session/delivery CRUD + `getTask`/`getTaskByAttemptId`）；TaskRow 扩展 V2 列 |
| `src/server/artifact-store.ts` | 新增 | 内容寻址存储引擎：initiate/upload/complete/read + GC 两轮策略 |
| `src/server/v2/artifact-service.ts` | 新增 | Artifact Service + reportV2WithArtifacts + getDeliveryReviewView |
| `src/server/v2/report-v2.ts` | 新增 | Report V2 最小版：attempt 上报引用 artifact sha256 清单 |
| `src/server/v2/routes/v2-routes.ts` | 修改 | Artifact 路由替换 stub：initiate/content/complete/get + delivery/review + task delivery |
| `docs/runbooks/artifact-store.md` | 新增 | 中文运维手册：上传协议状态机、存储布局、GC/备份/恢复 |
| `tests/distributed/p2-artifact.test.ts` | 新增 | 10 条失败优先测试 |
| `tests/distributed/p0a2-infra-schema.test.ts` | 修改 | 版本期望 004→005 |
| `tests/distributed/p1-identity-data.test.ts` | 修改 | 版本期望 004→005 |

### 验证结果

- **TypeScript 编译**: 零错误
- **全量测试**: 15 文件 / 200 用例全绿
- **Phase 2 测试**: 10/10 通过
  - 完整上传→读回字节一致
  - 篡改拒绝（SHA 不符 → rejected，无残留 blob）
  - 超限拒绝（result-md 2MiB / agent-log 50MiB）
  - 跨任务引用拒绝
  - 跨项目引用拒绝
  - 幂等重传（同 sha256 返回已存在）
  - 多分片乱序上传
  - 服务端无 Worker 文件挂载仍可完整 Review

### 残余风险

1. **`artifact_service.ts` 的 `getTaskByAttemptId` 依赖 tasks 表 `active_attempt_id`/`claimed_by`**——Phase 3 (biao-node) 建立正式 attempt 后需验证该查询路径
2. **GC 两轮策略只实现标记→清除骨架**，生产启用前需接入 cron 调度和过保留期判断
3. **分片上传目前只支持单次 upload**——大文件多 chunk 的 HTTP 分片路由需 Phase 3 Node 端集成时完善