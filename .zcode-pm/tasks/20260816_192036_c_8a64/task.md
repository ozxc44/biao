# P12 车道 B：架构优化（service拆分 + claim索引 + SSE推送 + 性能）

## 目标

### 5. service.ts 领域拆分（按 SERVICE_MAP 台账逐步迁出）
- 第一批：`AttemptService`（claim/lease/Question 相关 ~17 函数）从 service.ts 迁到 `src/server/v2/attempt-service.ts`
- service.ts 保留 re-export（零破坏迁移）
- 迁移后 service.ts 预计减 3000+ 行

### 6. V2/V1 桥接 claim 性能优化
- 当前回退查 `getAllTasks()` 全表扫描
- 改为：先按 `tasks.project_id` 索引查，miss 后查 `tasks WHERE status='pending' AND project_id IS NULL`（SQLite 已有 status 索引）
- 加 LIMIT 1 避免大结果集

### 7. Worker SSE 推送唤醒
- `GET /v2/events/stream` SSE 端点（复用 V1 SSE 逻辑，接受 bvn2）
- 推送 `task_ready` 事件给已授权的 Worker
- `src/node/daemon.ts` 订阅 SSE → 收到 task_ready → 立即 claim（替代轮询）
- 保留轮询作为 fallback（SSE 断线时自动降级）
- 网络：100 台 Worker 从 1200 req/min 降至 ~0 req/min（空闲时）

### 8. Worker daemon 自动领取集成
- daemon 的 claim tick 加真实 V2 claim 调用（带 bvn2）
- 领到 → 调 RealExecutor 全链（prepare → execute → finalize → report）
- 可配置执行命令模板（`BIAO_EXEC_CMD` env）

## 约束
- 所有权：`src/server/v2/attempt-service.ts`（新）、`src/server/v2/routes/v2-routes.ts`（claim 优化）、`src/server/http.ts`（SSE 路由一行）、`src/node/**`、`src/server/service.ts`（只减不增）
- 新测试：`tests/distributed/p12-*.test.ts`
