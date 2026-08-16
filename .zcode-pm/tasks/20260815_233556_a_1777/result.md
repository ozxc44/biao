Let me first explore the codebase to understand the existing architecture.
Let me explore the key source files to understand the existing patterns.
Let me continue reading key parts of the codebase.
Let me look at the `reconcileRuntimeState` function and existing test patterns.
Now I have a thorough understanding of the codebase. Let me look at getEvents and then check the existing test helper patterns.
I now have a thorough understanding of the codebase. This is a complex multi-file implementation. Let me create subtasks and start implementing.
Let me start with T1.1 - the service layer function.
Let me check the RuntimeReconciliationResult type and understand the function signatures.
Now let me implement the service function. I'll add it after `reconcileRuntimeState`.
Now I need to check if `isPlanTerminalStatus` is imported in service.ts.
Now let me add the HTTP route. First, update the import in http.ts.
Now add the route handler after the `/reconcile` endpoint.
Now update API_ENDPOINTS.
Let me verify the build compiles for the changes so far.
Need to fix the type errors in the service function.
Build passes. Let me complete T1.2 and move to T1.3.
Now let me add the tick transport method and fallback. First, let me add the `tick()` method to `BiaoSupervisorTransport`.
Now I need to add the `SupervisorTickResult` interface. Let me add it near the other transport types.
Now let me modify `BiaoSupervisorRuntime` to add tick-first logic with fallback. I need to add a `tickSupported` field and modify `refresh()`.
Now let me modify the `refresh()` method to try tick first.
Build passes. Let me complete T1.3 and start on T1.4 (tests).
Let me look at how existing tests create Redis connections and set up test infrastructure.
Now let me create the test file. I'll use the mock HTTP server pattern for transport tests (consistent with existing supervisor-runtime.test.ts) and add a targeted Redis test for service-layer consistency.
All 8 tests pass. Let me now run the existing supervisor tests to check for regressions.
All 40 existing tests pass. Let me also check the restore-maintenance-gate test.
All tests pass. Let me complete T1.4 and move to T1.5 (documentation).
Let me run the full build and all required tests.
All 48 tests pass and build succeeds. Let me complete the tasks.
## 交付说明

### 变更文件

| 文件 | 变更内容 |
|------|---------|
| `src/server/service.ts` | 新增 `supervisorTick()` 服务函数、`SupervisorTickRequest`/`SupervisorTickResponse` 类型、`isPlanTerminalStatus` 导入 |
| `src/server/http.ts` | 新增 `GET /supervisor/tick` 路由、`supervisorTick` 导入、API 目录更新 |
| `src/worker/supervisor.ts` | 新增 `SupervisorTickResult` 接口、`BiaoSupervisorTransport.tick()` 方法、`BiaoSupervisorRuntime` tick-first 逻辑与回落机制 |
| `tests/supervisor-tick.test.ts` | 8 个测试：tick 成功路径请求计数、404 回落、字段缺失回落、`BIAO_SUPERVISOR_TRANSPORT=legacy` 强制回落、后续轮次复用 tick、参数传递、auth 传递、首轮回落后不再尝试 |
| `docs/runbooks/supervisor-tick.md` | 中文文档：端点规格、版本兼容矩阵、回落触发条件、调试方法 |

### 验收证据

1. **`npm run build:server`** — 通过
2. **`npx vitest run tests/supervisor-tick.test.ts tests/supervisor-runtime.test.ts tests/supervisor-project-agent-binding.test.ts`** — 48 个测试全绿（tick 8 + runtime 32 + binding 8）
3. **回落触发条件清单**：404/405、JSON 解析失败、核心字段缺失、网络错误、`BIAO_SUPERVISOR_TRANSPORT=legacy`
4. **版本兼容矩阵**：新版 Supervisor + 旧 Server → 首轮 404 自动回落；旧 Supervisor + 新 Server → 不调 tick 无影响

### tick 响应字段表

| 字段 | 来源端点 | 说明 |
|------|---------|------|
| `plans` | `GET /plans` | 计划快照 |
| `intakes[]` | `GET /intake?consumer=` | 每个 consumer 的 intake 结果 |
| `events` | `GET /events?after=` | 事件页 + next_cursor |
| `reconciliation` | `POST /reconcile` | 有状态补偿（含 permit 门控） |
| `bindings[]` | `GET /project/agent-bindings` | 仅 binding_aware=1 |
| `receipts[]` | `GET /execution-receipts` | 仅 binding_aware=1 |

### 残余风险

- 首轮 tick 探测会增加一次额外的 404 往返（仅首次），后续轮次不再尝试
- tick 路径中 reconcile 仍需获取 mutation permit，高并发写入场景下可能短暂阻塞（与逐端点行为一致）
- 未新增 Redis DB 或 `*_TEST_REDIS_URL` 环境变量，不影响 CI 配置