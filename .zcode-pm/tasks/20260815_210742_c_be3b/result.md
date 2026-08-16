任务完成。两个关键决策：

**1. 字段命名：snake_case。** `buildWakePayload` 的 `binding` 块改为 `binding_id/agent_id/harness_kind/wake_mode/adapter_id`，与 HTTP API、`ProjectAgentBinding` 类型一致。同步修正了 external-stub、adapter-kit 脚手架模板与契约 JSON；全仓无 camelCase 载荷读取方残留。

**2. reservation 回带：worker-agent 透传并校验，supervisor 终校验不放宽。** 理由：reservation 是重启栅栏 attempt_id 的来源，两层独立校验尽早拒绝串扰回执；适配器契约保持唯一无例外分支；安全规则不放松（回带值来自经 `validateSelector` 的 argv）。配套新增 `--reservation-id/--task-id/--reservation-expires-at` 三参（同给或同缺）与 payload `reservation` 块，supervisor.mjs 透传。

**变更文件**：`scripts/worker-agent.mjs`、`scripts/supervisor.mjs`、`src/worker/harness/external-stub.mjs`（通用参考实现：结构化校验、退出码 2、探测保留、reservation 回带）、`scripts/adapter-kit.mjs`、`tests/worker-agent-binding-wake.test.ts`（真实 spawn 端到端，8 用例）、`tests/supervisor-project-agent-binding.test.ts`（dispatcher 级 reserved 用例）、`docs/worker-integration.md`（字段表+回执表+回带规则+最小适配器示例）。

**验证**：`npm run build:server` 通过；验收指定的 4 个测试文件 25/25 全绿；邻近回归（ready-reservation、adapter-kit、supervisor-config、cli-invocation、release-readiness、pm-cli、codex-pm-adapter、bootstrap）全绿；手工 `echo 载荷 | node external-stub.mjs` 输出单行回执且含 reservation 回带字段。

**残余风险**：旧 camelCase 适配器升级后会失效，但旧链路本就因协议矛盾从未成功过，实际无回退面。未触碰禁改路径，未启动生产栈，未新增 Redis 套件。交付说明已写入 `.zcode-pm/tasks/20260815_210742_c_be3b/final-summary.md`。