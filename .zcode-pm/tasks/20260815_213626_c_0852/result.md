修复完成。交付说明如下：

## 根因

**带 background worker 槽时，coordinator 注册失败会沿 `afterRunOnce` 上抛，把同一回调里排在后面的 harness 唤醒分发整个吞掉。**

具体链路（`src/worker/supervisor.ts`）：

1. `BiaoSupervisorRuntime` 构造的 `afterRunOnce` 回调是**顺序执行**的：`refreshIdlePresence()` → `updateProjectAgentBindings()` → `bindingDispatcher.dispatch()` → `scheduleIfRequested()`。
2. 本机存在与 supervisor 槽**同名**的独立 agent（`bin/codex-worker.js`，mimo）时，服务端会拒绝 supervisor 的注册并返回 `AGENT_REGISTRATION_CHANGED`。`SharedWorkerCoordinator.refreshIdlePresence()`（supervisor.ts:1224）内部先 `await this.ensureRegistered()`，后者对 `ok:false` 直接 `throw`（supervisor.ts:1353）。
3. 该异常从 `afterRunOnce` 抛出后进入 `Supervisor.run()` 的 catch（supervisor.ts:446-451）：`SupervisorTransportError` 之外的一切异常**直接 rethrow 终止 run 循环**（`isRecoverableError` 只认 transport 错误），由 `scripts/supervisor.mjs:732` 捕获后**常驻进程静默退出**——无 “唤醒失败” 日志、无 execution-receipt，与 PM 观察到的“重启后零分发”完全吻合。

**为什么无 worker 槽时正常**：`this.workers` 为 `undefined`，`await this.workers?.refreshIdlePresence()` 是 no-op，`dispatch` 照常执行。**为什么是回归**：`ensureRegistered` 抛错路径早于 project-agent wake lane 引入；wake lane 加入后没有把 coordinator 数据面异常与 harness 唤醒 lane 隔离。另外 `ensureRegistered` 中途失败时已成功 slot 的 `registered=true` 残留、且 `started` 未置位，但异常每轮都在第一个失败 slot 处重新抛出——行为正确但确认了“每轮重试、每轮失败”。

## 修复（`src/worker/supervisor.ts`，两处隔离 + 一处文档化）

1. **`afterRunOnce`（supervisor.ts:1540-1548、1580-1586）**：`refreshIdlePresence()` 与 `scheduleIfRequested()` 各自 try/catch，失败只经 `onError` 上报（“共享 Worker presence/调度失败（不影响 Project Agent 唤醒分发）"），**不再阻断其后的 `bindingDispatcher.dispatch` 与下一轮调度**。冲突只影响该 background 槽数据面，harness 唤醒 lane 照常。
2. **`refreshIdlePresence`（supervisor.ts:1224-1251）**：注册失败时，已成功注册的其余 slot 仍照常心跳（不被第一个失败 slot 拦断），然后原样抛出交给上层隔离层。
3. **`ensureRegistered`（supervisor.ts:1379-1398）**：确认并注释了“中途失败不置 `started`，下一共享轮次以新 registration epoch 重试”的既有语义。

**产品语义零变更**：恢复屏障（restart fence 按 task+binding+attempt 去重）、回执终校验（reservation 回带、credential 清洗）、fail-closed（缺回执绝不回退 background executor）全部保留——仅改变异常传播边界。

## 回归测试

`tests/supervisor-runtime.test.ts` 新增用例 **“同名 agent 注册冲突（AGENT_REGISTRATION_CHANGED）只影响 background 槽数据面，不抑制 harness 唤醒分发”**（tests/supervisor-runtime.test.ts:584）：同一 runtime 同时配置 background worker 槽（注册恒被拒）+ visible_session harness 槽，注入式本地 HTTP 服务返回 `AGENT_REGISTRATION_CHANGED`，断言：harness wake 被调用、succeeded 回执已 POST、presence 失败被上报、注册每轮重试。已验证**去掉修复后该用例必失败**（red→green 确认）。测试基建顺带给 fake server 加了 `/register` 可编程响应与 project-agent 三个端点。

## 验证

- `npm run build:server` ✅
- `npx vitest run tests/supervisor-runtime.test.ts tests/supervisor-project-agent-binding.test.ts tests/worker-agent-binding-wake.test.ts` → **48/48 全绿**（含新用例）
- 附加：`pm-supervisor` / `supervisor-config` / `supervisor-project-agent-ready-reservation` 共 6 文件 70 用例全绿

## 残余风险

- 冲突期间该 background 槽的数据面（claim/执行）确实不可用——这是设计内的（该槽身份被外部进程占用），supervisor 每轮重试注册并低噪声报错；根治需消除本机同名 agent 双注册。
- 未重启 `.biao/start` 生产栈（按约束留给 PM 验证）；PM 重启后应看到 harness lane 每周期照常 reservation→wake→receipt。
- 修改文件：`src/worker/supervisor.ts`、`tests/supervisor-runtime.test.ts`；`scripts/supervisor.mjs` 与 `src/server/**` 未动。