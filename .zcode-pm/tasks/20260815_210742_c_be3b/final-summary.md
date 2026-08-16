# worker-wake/v1 回执协议一致性：真实 harness 唤醒链路打通

## 交付说明（验收标准第 4 条的两个决策）

### 字段命名最终是哪种

**snake_case**。`buildWakePayload` 输出的 `binding` 块改为 `binding_id/agent_id/harness_kind/wake_mode/adapter_id`，与 HTTP API、`ProjectAgentBinding` 类型定义、supervisor 侧 `ProjectAgentWakeSlot.wake` 请求形状完全一致。顶层 `biaoUrl/slotId` 与 `selector.kind/model/planIds/project/capability` 保持原样（脚本间内部约定，无冲突）。不提供 camelCase 兼容分支——适配器模板与 stub 同仓库同步改，属受控破坏性变更；全仓 grep 已确认无 camelCase 载荷读取方残留。

### reservation 回带规则选了哪条、为什么

**选 worker-agent 透传（并校验）task_id/reservation_id，supervisor 终校验不放宽**。理由（已落在 `scripts/worker-agent.mjs` 的 `normalizeAdapterReceipt` 注释里）：

1. reservation 是重启栅栏的 `attempt_id` 来源，两层独立校验能尽早拒绝串扰回执（适配器带回别的任务的 task_id），坏回执不会进入 supervisor 进程；
2. 适配器契约保持唯一（"提供了 reservation 就必须原样回带"），外部实现者不需要理解"哪些模式下可省略"的例外分支；
3. 安全规则不放松：回带值来自经 `validateSelector` 校验的 argv，不可能携带凭据或控制字符。

配套改动：worker-agent 新增 `--reservation-id/--task-id/--reservation-expires-at` 三参（必须同给或同缺，expires_at 校验正整数毫秒），payload 新增 `reservation` 块（snake_case），`scripts/supervisor.mjs` 的 `wakeProjectAgentAdapter` 在候选带 reservation 时透传三参。

## 变更文件

- `scripts/worker-agent.mjs` — binding snake_case；reservation argv 解析与 payload 块；`normalizeAdapterReceipt` 校验并透传 task_id/reservation_id；usage 文案更新
- `scripts/supervisor.mjs` — `wakeProjectAgentAdapter` 透传 reservation 三参
- `src/worker/harness/external-stub.mjs` — 重写为通用参考实现：去掉硬编码项目/plan，改为结构化校验（binding 五字段齐全、selector 非空 planIds、reservation 形状、凭据 marker 黑名单、BIAO_* 环境变量白名单）；协议不匹配退出码 2；保留 `BIAO_ADAPTER_PROBE=1`；带 reservation 时回带
- `scripts/adapter-kit.mjs` — `projectAgentContract` 补 `naming`/`reservation?`/`echoReservation` 字段；scaffold 模板改为 snake_case 并加 reservation 回带示例注释
- `tests/worker-agent-binding-wake.test.ts` — 重写：真实 spawn worker-agent + external-stub，覆盖 (a) 双层校验通过、(b) 带 reservation 产出含 task_id/reservation_id 的回执、(c) 载荷无凭据且 snake_case；另加错误 reservation 回带/缺回带/半截 argv/`buildWakePayload` 单元断言
- `tests/supervisor-project-agent-binding.test.ts` — 新增 dispatcher 级用例：worker-agent 形状的 reserved 回执（带回带）succeeded；缺回带字段明确拒绝为 failed 落库
- `docs/worker-integration.md` — "Harness 自带的一次性唤醒脚本"一节重写：字段命名表、回执字段表、reservation 回带规则、最小适配器完整示例

## 验证

- `npm run build:server` ✅
- `npx vitest run tests/worker-agent-binding-wake.test.ts tests/worker-agent.test.ts tests/supervisor-project-agent-binding.test.ts tests/adapter-kit-project-agent.test.ts` — 25/25 ✅
- 邻近回归：`supervisor-project-agent-ready-reservation` / `adapter-kit` / `supervisor-config` / `cli-worker-binding-invocation` / `release-readiness` / `pm-cli` / `codex-pm-adapter` / `bootstrap` 全绿（120+ 用例）
- 手工走 stub：任意项目名 + reservation 载荷 → 单行回执含 `task_id:"t9"` 与 `reservation_id` ✅；错误协议退出码 2 ✅；`BIAO_ADAPTER_PROBE=1` 探测 ✅

## 残余风险

- 已部署的外部适配器若按旧 camelCase 实现（读 `binding.wakeMode` 等）会在升级后读到 undefined——但按目标描述，现有脚手架实现的适配器本来就必然读到 undefined（协议自相矛盾），即旧链路从未真正成功过，实际无回退面。
- `docs/worker-integration.md` 独占修改；未触碰 `src/mcp/**`、`src/server/**`、`scripts/agent-join.mjs`、`docs/mcp.md`、`docs/agent-join.md`；未启动生产栈、未改 `.biao/config.env`、未新增 Redis 套件。
