# Phase 2：Artifact Store（与 Phase 3 并行，文件所有权互斥）

## 前置状态

Phase 1 已全部验收：004 六表 + Store 方法（`src/db/sqlite-store.ts`）、凭据 `src/server/v2/credentials.ts`（bvn2/bva2）、V1 隔离门 `src/server/v2/v1-isolation.ts`、15 条 V2 路由已实现（`src/server/v2/routes/`，registry 驱动）、`src/server/v2/project-service.ts`/`node-service.ts`。全量基线 **110 文件 / 1226 用例全绿**。0b fixture：`tests/distributed/fixtures/artifact-store-fixture.ts`（内容寻址/上限/穿越拒绝/manifest 校验——服务端实现可参考其语义但不得 import fixture）。

先读：方案 §9（Artifact Store：9.1 存储层次 / 9.2 上传协议 initiate-upload-complete / 9.3 安全限制 / 9.4 保留策略与 R1C-011 引用计数双扫描 GC）、§4.6（Artifact 领域模型）、§15.4（API 草案）、§21 Phase 2 验收原文。

## 目标

1. **内容寻址存储服务** `src/server/v2/artifact-service.ts` + `src/server/artifact-store.ts`（存储引擎，SQLite `artifacts`/`artifact_blobs` 元数据表入 migration `005_artifacts`——本车道所有权含 src/db/migrations/005 与 sqlite-store 追加方法、`src/types/v2-artifact.ts`）：
   - 分片上传三段协议：`initiate`（返回 upload_id、声明 sha256/size/scope）→ `upload`（分片，乱序可收，服务端累计摘要）→ `complete`（终摘要校验、落 blob 文件、写元数据、幂等：同 sha256 重传直接返回已存在）；
   - `read`（按 sha256 流式读，按 project/task 授权——§9.3 跨任务引用拒绝）；
   - 存储根 `BIAO_ARTIFACT_ROOT`（默认 `<dataDir>/artifacts`），sha256 扇形目录布局。
2. **V2 路由**（registry 声明→实现）：`POST /v2/artifacts/initiate | /v2/artifacts/:id/upload | /v2/artifacts/:id/complete | GET /v2/artifacts/:sha256`（owner 或 node credential + attempt scope）。
3. **Report V2 Artifact refs**：`src/server/v2/report-v2.ts` 最小版——Attempt 上报时引用 artifact sha256 清单（校验存在性+归属），生成 delivery 记录雏形（`deliveries` 表入 005 迁移，§4.5 最小字段）。
4. **PM Review V2 只读**：`GET /v2/tasks/:id/delivery`（读 delivery + artifact manifest 摘要，不回传 blob 正文——服务端无 Worker 文件挂载仍可完整 Review 的验收基础）。
5. **GC 与备份说明**：`docs/runbooks/artifact-store.md`（中文）：引用计数双扫描 GC 策略（标记→清除两轮、只删零引用且过保留期）、备份口径（blobs 目录 rsync + SQLite 元数据快照一致性）、恢复演练步骤。
6. **失败优先测试** `tests/distributed/p2-artifact.test.ts`（真实 HTTP + 真实磁盘临时目录）：完整上传→读回字节一致；**篡改拒绝**（分片摘要不符 complete 失败且无残留 blob）；**超限拒绝**（§9.3 上限）；**跨任务引用拒绝**（task-B 的 attempt 引用 task-A 的 artifact → 403/404）；幂等重传；服务端工作目录被清空后 Review 仍完整（验收原文场景：Review 只依赖 artifact store + 元数据，不依赖 Worker 本地文件）。

## 约束

- 全程中文；**所有权**：`src/server/v2/artifact-service.ts`、`src/server/artifact-store.ts`、`src/db/migrations/005_artifacts.ts`、`src/db/migrate.ts`（注册）、`src/db/sqlite-store.ts`（追加）、`src/types/v2-artifact.ts`、`src/server/v2/routes/`（artifact 组）、`src/server/v2/report-v2.ts`、`docs/runbooks/artifact-store.md`、`tests/distributed/p2-*.test.ts`、受影响版本期望测试。**不得改**：`src/node/**`（Phase 3 并行车道）、`src/server/service.ts`、`src/server/http.ts`（装配行除外）、`src/server/http-plugins.ts`、`src/mcp/**`、`web/`、既有 fixture。
- 不新增 `*_TEST_REDIS_URL`（复用 6380）；不启动生产栈。
- 门禁：构建 + 全量不劣化 110/1226 基线（已知 SIGTERM flaky 单独复跑）。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿。
2. §21 Phase 2 验收原文逐项：服务端无 Worker 文件挂载仍可完整 Review；篡改/超限/跨任务引用被拒。
3. 交付说明：上传协议状态机、存储布局、GC/备份要点、005 迁移演练结果、A/C 接口缺口（如有）。
