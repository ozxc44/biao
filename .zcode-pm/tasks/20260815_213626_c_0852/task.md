# 修复：带 background worker 槽时，Project Agent 唤醒分发被静默抑制

## 复现证据（PM 在生产栈实测，2026-08-15 21:40 前后）

1. **无 worker 槽的运行时正常**：用 `dist/worker/supervisor.js` 的 `BiaoSupervisorRuntime` 直接构造（`projectAgentWakeSlots` 一个 external_worker 槽 + `apiToken`，**不传 `workers`**），`runOnce()` 一次即完成完整链路：GET bindings → POST /project/agent-reservations → wake → POST /execution-receipts。fetch 打点日志齐全。
2. **真实 supervisor 静默**：`.biao/start` 托管的 `scripts/supervisor.mjs`（同一 dist、同一环境变量、10 个 background worker 槽 + 1 个 harness 槽）重启后连续多个 60s 周期**零分发**：无 `唤醒失败` 日志、无新 execution-receipt、reservation 端点手动调用正常、plan 投影 active、binding automatic。
3. **相关日志**：重启时反复出现 `[supervisor] 共享 Worker 离线登记失败（mimo）：AGENT_REGISTRATION_CHANGED`（本机另有一个独立 `bin/codex-worker.js` 进程会注册同名 agent，与 supervisor 槽位冲突——这是真实环境噪声，但 supervisor 必须对这种冲突鲁棒）。
4. 一个干扰项排除记录：`/project/agent-bindings`、`/project/agent-reservations` 用派生 worker token 访问会 `WORKER_SCOPE_DENIED`，但 supervisor 的 transport 用的是 owner token（`apiToken: process.env.BIAO_API_TOKEN`），不是本问题原因。

## 怀疑方向（从证据出发，最终以你的调试为准）

- `afterRunOnce` 中 `await this.workers?.refreshIdlePresence()`（以及 `updateProjectAgentBindings`/`scheduleIfRequested`）在 coordinator 与同名独立 agent 冲突（AGENT_REGISTRATION_CHANGED）时的异常/挂起路径，可能中断或跳过其后的 `bindingDispatcher.dispatch`。
- 或 `SharedWorkerCoordinator` 的 presence/离线登记流程把 `bindingCandidates` 相关状态清空/覆盖。
- 或 `run()` 主循环在 worker 执行中（51 个 pending 任务会被 background 槽领取执行）长时间占位，`afterRunOnce` 迟迟不跑——但此前版本同样有 worker 槽时每 60s 都能分发，属回归。

## 目标

1. 找到并修复根因：**带 background worker 槽 + 存在同名 agent 注册冲突的真实环境下，Project Agent 唤醒分发必须照常进行**（冲突只影响该 slot 的数据面，不抑制 harness 唤醒 lane）。
2. 回归测试：在 `tests/supervisor-runtime.test.ts` 或 `tests/supervisor-project-agent-binding.test.ts` 增加一个"workers 槽存在且 coordinator presence 报 AGENT_REGISTRATION_CHANGED 时，harness dispatch 仍执行"的用例（可用注入的 fetch/workers 模拟，不需真实 codex）。
3. 不改产品语义：恢复屏障、回执校验、fail-closed 全部保留；修复范围尽量小。

## 约束

- 允许修改：`src/worker/supervisor.ts`、`scripts/supervisor.mjs`、相关测试。**不得修改**：`src/server/**`、`src/mcp/**`、`scripts/agent-join.mjs`、`docs/mcp.md`、`docs/agent-join.md`、`docs/worker-integration.md`（除非一行以内的行为说明必须同步）。
- 不启动/重启 `.biao/start` 栈（PM 负责生产验证）；本地调试用隔离 Redis（127.0.0.1:6380，DB 选现有套件或 mock，不新增 `*_TEST_REDIS_URL` 变量）。
- 全程中文注释与说明。

## 验收标准

1. `npm run build:server` 通过。
2. `npx vitest run tests/supervisor-runtime.test.ts tests/supervisor-project-agent-binding.test.ts tests/worker-agent-binding-wake.test.ts` 全绿（含你新增的回归用例）。
3. 交付说明写清：根因是什么、为什么此前版本没触发、修复落在哪个函数。
