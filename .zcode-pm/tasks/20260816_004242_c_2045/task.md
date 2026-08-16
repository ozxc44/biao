# Phase 1（车道 C）：凭据分裂基础 + V1 隔离门（与车道 A 并行，零依赖）

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`。主方案 v0.8.0。0a-2 已交付七领域接口（`src/server/v2/domain-interfaces.ts`）与 route registry（`src/server/v2/routes/registry.ts`）；0b fixture 就绪（`tests/distributed/fixtures/`）；全量基线 106 文件/1148 用例全绿。**车道 A 正在并行交付 migration 004/类型/Store（src/db、src/types 归其所有）**——本车道不得 import 其未落地类型，接口先行。

先读：方案 §13.1（身份分层：Owner/Node credential/Attempt token/Human）、§13.5（Secret 使用）、§4.2（Node 会话 generation fencing）、R1A-003/R1A-007（credential split 前置、Attempt Token 签发/scope/generation 校验）、`src/server/http.ts` 的 `deriveWorkerApiToken`（V1 派生先例）。

## 目标

1. **凭据原语** `src/server/v2/credentials.ts`（纯函数，无 DB 依赖）：
   - Node credential：`issueNodeCredential(nodeId, generation)` / `verifyNodeCredential(token, nodeId)`——HMAC 签名、防篡改、generation 内嵌；
   - Attempt token：`issueAttemptToken(attemptId, taskId, generation, scope)` / `verifyAttemptToken(token, {attemptId, taskId, generation, scope})`——scope 枚举（claim/report/ownership/question 按 §13.1），generation fencing 字段；
   - 密钥来源：`BIAO_V2_CREDENTIAL_KEY`（env，32+ 字节 hex；未配置时启动期 fail-fast 且给出生成指引）；与 V1 BIAO_API_TOKEN 完全独立；
   - 泄漏语义：token 字符串不含密钥材料；错误信息不回显 token。
2. **V1 隔离门** `src/server/v2/v1-isolation.ts` + http-plugins 集成：对"启用 V2 的 Project"（判据函数 `isV2EnabledProject(projectId)`：**车道 A 的表未落地前用可注入谓词**，默认实现读 env `BIAO_V2_PROJECTS` 逗号清单，接口与车道 A 的 store 落地后一行切换）——V1 Worker Token 的 claim/report/renew/ownership declare/release 全部 403 `V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT`。挂到共享 plugin 的 onRequest 之后（作为 v1 数据面守卫），V1 owner token 不受影响（owner 可运维）。
3. **失败优先测试** `tests/distributed/p1-credentials.test.ts`（用 fault-injector 的时钟偏移测 token 时效；不需要车道 A 的表）：
   - 签发/校验往返、篡改拒绝、scope 越权拒绝、generation 不匹配拒绝；
   - 密钥未配置 fail-fast；密钥轮换后旧 Node credential 拒绝（带 key_version）；
   - V1 隔离门：对 V2 项目，worker token claim/report 403；V1 项目行为不变（用 0b fixture 或真实 server 起 0 端口）。
4. **registry 更新**：Phase 1 相关 V2 路由条目的凭据作用域字段与 `src/server/v2/credentials.ts` 的 verify 函数对齐（registry 门禁测试自动校验）。

## 约束

- 全程中文；**只改/新增**：`src/server/v2/credentials.ts`、`src/server/v2/v1-isolation.ts`、`src/server/http-plugins.ts`（挂隔离门）、`src/server/v2/routes/registry.ts`（作用域字段）、`tests/distributed/p1-credentials.test.ts`。**不得改**：`src/db/**`、`src/types/**`、`src/redis/**`、`src/server/service.ts`、`src/server/http.ts`、`src/mcp/**`、既有 fixture。
- 不新增 npm 依赖（node:crypto 足够）；不新增 `*_TEST_REDIS_URL`。
- 门禁：构建通过 + 全量不劣化 106/1148 基线。

## 验收标准

1. `npm run build:server` + `npx vitest run tests/distributed/` 全绿。
2. 交付说明：token 结构（字段/编码，不含密钥材料）、key 轮换方案、V1 隔离门触发矩阵（哪些路由×哪些凭据×V1/V2 项目）。
