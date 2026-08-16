# worker-wake/v1 回执协议一致性：打通真实 harness 唤醒链路最后一公里

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`（Biao：本地多 Agent PM 平台，TypeScript ESM + Redis + SQLite）。

`biao.worker-wake/v1` 协议链路：任务出现 → Supervisor 按 binding 身份（agent_id+harness_kind+wake_mode，已支持无 binding_id 动态匹配）选中项目连接 → spawn `scripts/worker-agent.mjs --once --require-receipt` → worker-agent 把无凭据唤醒载荷写入 harness 适配器 stdin → 适配器返回单行 JSON 回执 → worker-agent `normalizeAdapterReceipt` 校验/重建 → supervisor `normalizeProjectAgentAdapterReceipt` 终校验（含 reservation 回带规则）→ `POST /execution-receipts` 落 SQLite 作为重启栅栏。

**2026-08-15 真实进程级 E2E 发现协议有自相矛盾**（PM 已在生产栈实测复现，现象：适配器被真实 spawn、但回执全部被判 failed，`attempt_id=reservation_*`，错误"Adapter 未返回唯一且安全的成功回执"）：

1. `scripts/worker-agent.mjs` 的 `buildWakePayload`（约 :218）发给适配器的 binding 字段是 **camelCase**（`bindingId/agentId/harnessKind/wakeMode/adapterId`），而 `src/worker/harness/external-stub.mjs`、`scripts/adapter-kit.mjs` 生成的脚手架模板、以及文档示例都按 **snake_case**（`binding.harness_kind`）读取——按现有脚手架实现的适配器必然读到 undefined。
2. worker-agent 的 `normalizeAdapterReceipt`（约 :271）重建回执时**丢弃了 `task_id` / `reservation_id`**；而 supervisor 的 `normalizeProjectAgentAdapterReceipt`（`src/worker/supervisor.ts` 约 :581-617）规定"带 reservation 的候选必须原样回带 task_id/reservation_id"（约 :596-598）。两层规则矛盾 → 经 worker-agent 真实路径的、带 reservation 的唤醒**永远无法产生 succeeded 回执**。
3. `src/worker/harness/external-stub.mjs` 硬编码 `selector.project === '/workspace/project-a'` 和 `planIds.includes('plan-a')`，只能当契约测试 fixture，不能当参考实现。

PM 在 `/tmp/biao-wake-verify-Odga/real-harness-wake.mjs` 写过一个手工最小适配器验证过链路前半段（dispatch→spawn 真实），可作为参考但不要直接拷贝进仓库。

## 目标

1. **统一载荷字段命名**：确定一种（推荐适配器侧读 snake_case，与 HTTP API、类型定义 `ProjectAgentBinding` 一致），在 `buildWakePayload` 输出里同时提供或明确转换，并同步修正 `external-stub.mjs`、`adapter-kit.mjs` 的脚手架模板与契约 JSON（`projectAgentContract`）。破坏性变更需兼容：适配器模板与 stub 同仓库同步改即可。
2. **打通 reservation 回执链**：让带 reservation 的唤醒能产生 succeeded 回执——要么 worker-agent 的 normalize 透传（并校验）`task_id`/`reservation_id`，要么 supervisor 的回带校验放宽为"若适配器提供则必须原样、未提供时对 external_worker 不强制"。选哪条给出理由，落在代码注释里。目标是：真实外部适配器（无 Biao 凭据、stdin 载荷进/单行回执出）按新契约实现即可成功落 succeeded 回执。
3. **把 external-stub 改成通用参考实现**：不再硬编码 fixture 项目/plan；保留 `BIAO_ADAPTER_PROBE=1` 探测；对不匹配的 protocol 退出码 2；断言载荷无凭据（保留现有凭据 marker 黑名单与环境变量白名单检查）。
4. **真实链路端到端测试**：新增或扩展 `tests/worker-agent-binding-wake.test.ts`——真实 spawn `worker-agent.mjs` + 修正后的 external-stub（stdin 喂任意项目名的合法载荷），断言：(a) 回执通过双层校验；(b) 带 reservation 的候选产出含 task_id/reservation_id 的 succeeded 回执；(c) 载荷不含任何凭据。再在 `tests/supervisor-project-agent-binding.test.ts` 补一个 dispatcher 级用例：reserved 候选经 worker-agent 形状的回执（无 task_id 字段）能按你选定的规则得到 succeeded 或明确拒绝的错误码——与你第 2 点的实现一致。
5. **文档**：`docs/worker-integration.md` 的"一次性心跳脚本"一节按最终契约重写（字段命名表、回执字段表、reservation 回带规则、最小适配器完整示例代码）。该文件由你独占修改。

## 约束

- 全程中文注释与中文文档。
- **不得修改**：`src/mcp/**`（另一并行流所有）、`src/server/**`、`scripts/agent-join.mjs`（另一条任务线正在创建）、`docs/mcp.md`、`docs/agent-join.md`。
- 不启动/重启 `.biao/start` 栈，不改 `.biao/config.env`，不跑生产 7331 端口的服务。
- 测试需要 Redis 时使用 `redis://127.0.0.1:6380`（本机测试实例已在运行），新建套件的 `*_TEST_REDIS_URL` 变量若加入，同步更新 `tests/release-readiness.test.ts` 期望集合与 `.github/workflows/ci.yml`（当前 DB 2-15 已满，优先复用现有测试文件而不新建 Redis 套件）。
- 安全规则不放松：凭据 marker 黑名单、环境变量白名单、`SAFE_RECEIPT_ID` 正则、脱敏 failed 回执语义全部保留。

## 验收标准

1. `npm run build:server` 通过。
2. `npx vitest run tests/worker-agent-binding-wake.test.ts tests/worker-agent.test.ts tests/supervisor-project-agent-binding.test.ts tests/adapter-kit-project-agent.test.ts` 全绿。
3. 用修正后的 external-stub 手工走一遍（不依赖服务）：
   `echo '<合法载荷>' | node src/worker/harness/external-stub.mjs` 输出单行回执且含 reservation 回带字段。
4. 交付说明里明确回答：字段命名最终是哪种、reservation 回带规则选了哪条、为什么。
