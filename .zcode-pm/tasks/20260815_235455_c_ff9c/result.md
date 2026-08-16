# Phase 0a-2（车道 C）交付总结

## 变更文件（全部在车道 C 所有权内）

| 文件 | 变更 |
| --- | --- |
| `src/server/v2/domain-interfaces.ts` | 新增 1013 行：七服务接口层（只定义接口与类型，不搬实现） |
| `src/server/v2/SERVICE_MAP.md` | 新增：58 函数台账（函数↔服务归属） |
| `src/server/v2/routes/registry.ts` | 新增 1082 行：53 条 V2 路由声明式注册表 |
| `src/server/http-plugins.ts` | 新增 225 行：共享横切 Fastify plugin |
| `src/server/http.ts` | 装配化：1688 → 1537 行（-151 / -8.9%） |
| `src/server/service.ts` | 仅顶部 facade 边界注释块（冻结声明） |
| `tests/distributed/p0a2-route-registry.test.ts` | 新增：registry 生成式门禁（9 用例） |
| `tests/distributed/p0a2-plugin-parity.test.ts` | 新增：plugin 等价性（8 用例） |
| `tests/distributed/p0a2-service-map.test.ts` | 新增：台账同步门禁（3 用例） |

未触碰 `src/db/**`、`src/types/**`、`src/migration/**`、`src/mcp/**`、`web/`、`scripts/`。会话期间出现的 `src/server/v2/outbox.ts` 是其他车道并行交付，与我的导出无冲突。

## 交付要点

1. **七服务接口**（`domain-interfaces.ts` 单文件）：`ProjectService`/`NodeService`/`AttemptService`/`DeliveryService`/`MergeService`/`IncidentService`/`ReconcileService` + 共享 V2 原语（幂等键/correlation ID/actor 上下文/cursor 分页）。每方法注明 V1 对照函数与 V2 语义差异（attempt_generation fencing、durable-first+outbox、project_id 身份、Merge Bot 单写等，对应 §13.1/§14.5/§24 决策）。
2. **SERVICE_MAP 统计**（脚本校验 58/58 全覆盖、无重复）：Project 14｜Node 5｜Attempt 17｜Delivery 7｜Merge 0｜Incident 0｜Reconcile 15（另 9 个 maintenance.ts re-export），并有测试防止台账腐烂。
3. **共享 plugin**：三个横切钩子（onRequest 鉴权 / preHandler permit+restore gate / preSerialization barrier + permit 释放）逐行搬出，参数化 config；在目标作用域内直接调用而非 `app.register`（避免 Fastify 封装上下文把钩子隔离出同级路由，文件头有说明）。
4. **Registry 门禁**：handler 引用 `Service.method` 由类型层编译期校验（开发中真实拦到 `updatePolicy` 缺失）；运行期门禁覆盖 schema 必填、§13.1 凭据作用域（V1 owner/worker/mcp 禁入）、`/v2/` 前缀、与真实 V1 路由表（`printRoutes`+`hasRoute`）零冲突、Fastify 实装无重复。

## 验证

- `npm run build:server` ✅
- 新增 3 个测试文件 20 用例全绿 ✅
- 全量 `npx vitest run`：**101 文件 / 1102 用例，1100 通过，2 失败** —— 与基线（98/1063，2 失败）持平不劣化。两个失败均非本车道：① `project-agent-binding-core.test.ts` 期望 schema `002`，但其他车道新增的 `003_v2_infra_minimal.ts` 迁移已把版本推到 `003`（`src/db/**` 不属于我）；② `supervisor-pm-agent-cli.test.ts` 的 SIGINT/SIGTERM 孙进程时序断言，即任务说明中的已知 flaky（基线同样失败）。

## 残余风险

- http.ts 缩减幅度受文件所有权约束（V1 request schema 无合法去处，只能留在原文件）；真正的路由/schema 分离随 Phase 1 `routes/v2/*` 落地。
- Registry 的 handler 目前是编译期校验的符号引用，无实现（0a-2 按方案只交接口层）；凭据作用域声明待 Phase 1 鉴权中间件实际消费。
- `project-agent-binding-core.test.ts` 的 schema 版本断言需要 owning lane 随 003 迁移更新，否则会持续红。