# P12 车道 B 完成总结

## 交付内容（4 项目标全部落地）

### 5. service.ts 领域拆分 — AttemptService 第一批迁移
- **`src/server/v2/attempt-service.ts`（新，3766 行）**：SERVICE_MAP 台账的 AttemptService 17 函数（claim / report / renewLease / Question×4 / taskBlock / taskResume / ownership×3 / getTask / getTasks / getPendingReviewTasks / supersedeTask / cancelTask）+ ~47 个专属私有助手（claim 预约 Lua、Question CAS、supersede 批提交、block/resume 重排队、task 列表投影等）逐段原文迁出。
- **`src/server/service.ts`：14357 → 10912 行（净减 3445）**，保留 `export {...} from './v2/attempt-service.js'` re-export 兼容层（http.ts/tests/scripts 导入面零变化），12 个迁出助手按需引回。
- 过渡期结构：37 个跨域私有助手（repair lineage / review doorbell 等，属后续 Delivery/Reconcile 批次）临时加 `export` 供 attempt-service 引用；`sqliteStore` 组合根状态以 `export let` 只读 live binding 共享（唯一写入口仍是 `setSqliteStore`）。service.ts ↔ attempt-service.ts 形成受控模块环（仅函数引用，无初始化期取值），后续批次迁完自然消解。
- 台账与门禁同步：SERVICE_MAP.md 记录迁移去向 + 新增 SharedSupportService 过渡小节；`p0a2-service-map.test.ts` 门禁学会把 re-export 计入导出面（否则 17 函数成“死条目”）。

### 6. V2/V1 桥接 claim 性能
- `v2-routes.ts` claim 回退路径：先 `getTasksByProjectId`（project_id 索引查），miss 后改用新_store 方法_ `getFirstPendingTaskWithoutProject()`（`WHERE status='pending' AND (project_id IS NULL OR '')  LIMIT 1`，走 idx_tasks_status，行序与旧全表扫描 `find` 等价）。替代 `getAllTasks()` 全表加载。

### 7. Worker SSE 推送
- **`GET /v2/events/stream`**（attempt-service.ts 尾部实现，http.ts 一行装配）：NODE_RUNTIME 旗门禁（关旗 404）、bvn2 验签（401 JSON 信封）、`XREAD keys.stream.tasks` 非阻塞轮询推 `event: task_ready`、15s 心跳注释行、`last_id` 断线续读、`reply.hijack()`（否则 app.close 挂死）。
- **daemon 侧**（daemon.ts + transport.ts）：`NodeApiClient.streamEvents`（增量 SSE 解析，跨 chunk 拼接）→ `task_ready` → `wakeClaim` 立即 claim（500ms debounce）→ 退避重连（3s→30s）；断线自动降级轮询（claimTick 间隔通道保留）；drain/fenced 停流；status.claim.sse 观测字段。

### 8. Worker daemon 自动领取
- claim tick 与 SSE 唤醒共用 `serverClaimOnce`（in-flight 防重入，带 bvn2，领到 → attempt token 缓存 → RealExecutor prepare→execute→finalize→report 全链）；**`BIAO_EXEC_CMD` env** → RealExecutor 执行命令模板（显式 `realExecutorOptions.execCommand` 优先）。

## 验证
- `tsc --noEmit` ✅、`npm run build`（server+web）✅
- 新测试 **`tests/distributed/p12-laneb-arch-perf.test.ts` 13/13** ✅（re-export 同引用、行数门禁、真实 Redis 全链、store/route 级 claim 性能与回填、SSE 旗门禁/鉴权/推送/续读、streamEvents 解析、daemon 唤醒 claim（claim_interval=60s 证明唤醒驱动）、BIAO_EXEC_CMD 优先级）
- 回归：claim/Question/lease/supersede/recovery 家族 **29+65+42+91 用例全绿**；distributed 定向 **76/76**；**全 tests/distributed 目录 694 通过 / 2 失败**（见残留）

## 残留风险
- **2 个 distributed 失败均为并行车道 WIP，非本车道**：`p1-credentials`（车道 A 新路由的 credentialBinding 矩阵未对齐）、`p9-scheduling` RealExecutor 期望 3 次 fetch 但车道 A 的 goal_md 拉取使之为 4。合并时需车道 A 收口。
- **p3-node-daemon 2 用例**（status CLI after SIGKILL / SIGKILL 重启认领）在 pristine HEAD 413f3b1 工作树同样失败（macOS pid 复用 + 时序），已用临时 worktree 验证为环境既有噪音。
- 一处声明外越界：`src/db/sqlite-store.ts` 加了 1 个只读方法（目标的 SQL 无它无法落地；P12 无车道占用该文件，改动与车道 E 的 webhook 段无重叠）。
- 全量（非 distributed）测试未跑：工作树含车道 A/E 未完成改动，全量结果会混淆；建议集成时统一跑。