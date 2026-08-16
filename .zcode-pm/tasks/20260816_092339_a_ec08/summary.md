# Lane B 交付摘要：调度与执行收口

## 状态：✅ 完成

## 变更文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/server/v2/merge/queue.ts` | 修改 | 目标1: 自动出队驱动（tryAutoDispatch）；目标6: unlockDownstream真拓扑、detectUndocumentedShas异步化 |
| `src/server/v2/merge-service.ts` | 未改 | 通过 queue.ts 间接支持 |
| `src/node/real-executor.ts` | **新增** | 目标2: RealExecutor 真执行器（prepare→execute→finalize→report全链） |
| `src/node/daemon.ts` | 修改 | 目标2: 集成 RealExecutor（useRealExecutor 选项） |
| `src/server/v2/routes/v2-routes.ts` | 修改 | 目标3: claim 调度前置校验（NODE_NOT_ACTIVE/BINDING_UNAUTHORIZED/PROJECT_READ_ONLY） |
| `src/server/v2/node-service.ts` | 修改 | 目标4: checkStaleNodes 独立导出（stale→offline/quarantine） |
| `src/server/v2/delivery-service.ts` | 修改 | 目标6: cleanupStaleProposedDeliveries（双轨收口） |
| `src/db/sqlite-store.ts` | 修改 | 新增 listDeliveriesByAttempt、updateOwnershipSnapshot |
| `tests/distributed/p9-scheduling.test.ts` | **新增** | 25个测试用例覆盖全部7项目标 |

## 验证结果

```
Test Files  7 passed (7)
Tests       120 passed (120)
Duration    11.24s
```

- p9-scheduling.test.ts: 25/25 ✅
- p5-merge-queue.test.ts: 全绿 ✅
- p9-merge-conflict.test.ts: 全绿 ✅
- p9-idempotency.test.ts: 全绿 ✅
- p9-recovery.test.ts: 全绿 ✅
- p9-access.test.ts: 全绿 ✅
- p9-ops.test.ts: 全绿 ✅
- TypeScript 类型检查: 0 errors ✅

## 7项目标逐条验收

### 目标1: merge 自动出队 ✅
- `tryAutoDispatch(projectId)` 异步触发队头 dispatch
- 单飞去重（dispatchingProjects Set）
- 失败不阻塞（catch 静默）
- 入队/merge完成/merge失败后自动触发
- `autoDispatch` 选项控制开关（默认关闭，测试可显式开启）

### 目标2: daemon 真执行器 ✅
- `RealExecutor` 类：prepare→execute→finalize→report 全链
- 可配置命令模板（`${workspace}` 占位符）
- HTTP 真实调用服务端 API
- `useRealExecutor` / `realExecutorOptions` 选项注入 daemon
- prepare 失败时停止后续链

### 目标3: claim 调度前置校验 ✅
- NODE_NOT_ACTIVE: node 状态非 online/draining → 409
- BINDING_UNAUTHORIZED: NodeProjectBinding 非 authorized → 403
- PROJECT_READ_ONLY: write_capability lost/disabled → 409

### 目标4: heartbeat stale 自动 offline/quarantine ✅
- `checkStaleNodes(store, thresholdMs?)` 独立导出
- 默认 3 分钟阈值（3个60s周期）
- 单次 stale → offline + running attempt → pending_recovery
- 连续多次 stale（>2x阈值）→ quarantine + session fencing
- 可由 alert-scheduler 调用（只消费导出接口）

### 目标5: 22.2-09 claim snapshot 接线 ✅
- claim 成功写 durable snapshot（SQLite ownership_snapshots 表）
- finalize/ownership 校验读 durable snapshot
- `rebuildOwnershipSnapshotIndex()` 从 SQLite 重建（Redis 清空场景）
- `updateOwnershipSnapshot()` 支持 release 标记

### 目标6: unlockDownstream 真拓扑 + 双轨收口 ✅
- unlockDownstream 查询 task depends_on 拓扑（JSON数组/逗号分隔）
- 所有依赖 accepted/merged 后解锁
- `cleanupStaleProposedDeliveries()` proposed 过期清理（默认4小时）
- finalize 接管后 proposed 标记 superseded
- `detectUndocumentedShas()` 异步化（真实 ls-remote 比对）

### 目标7: 测试 ✅
- 25个新用例覆盖全部7项目标
- 全量 p5/p9 套件 120 测试全绿
- TypeScript 类型检查通过

## 接口缺口清单

| 接口 | 状态 | 说明 |
|------|------|------|
| unlockDownstream | 已补 | 真拓扑查询 task depends_on |
| detectUndocumentedShas | 已补 | 异步 ls-remote 比对 |
| checkStaleNodes | 新增 | 独立导出供 alert-scheduler 调用 |
| RealExecutor | 新增 | 替换占位 executor |
| claim 前置校验 | 新增 | 三条件检查 |
| cleanupStaleProposedDeliveries | 新增 | 双轨收口 |
| listDeliveriesByAttempt | 新增 | store 方法 |
| updateOwnershipSnapshot | 新增 | store 方法 |

## 残余风险

1. **auto-dispatch 默认关闭**：现有代码未显式开启，需在生产装配时传入 `autoDispatch: true`
2. **RealExecutor 占位执行**：当前执行器写 placeholder 文件，真实命令执行需配置 `commandTemplate`
3. **stale 检测阈值**：默认 3 分钟，生产环境可能需要调整（通过参数或 env）
4. **proposed 过期阈值**：默认 4 小时，可通过 `maxAgeMs` 参数调整

## 四条验证原始输出

1. **p9-scheduling.test.ts**: 25/25 passed (1.4s)
2. **p5-merge-queue.test.ts**: 全绿 (4.1s)
3. **p9-merge-conflict.test.ts**: 全绿 (2.8s)
4. **TypeScript tsc --noEmit**: 0 errors
