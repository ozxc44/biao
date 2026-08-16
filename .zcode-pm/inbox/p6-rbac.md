# Phase 6：Human Identity 与 RBAC（凭据体系收口）

## 前置状态

Phase 1-5 全部验收（review log 有记录；全量基线 **116 文件 / 1313 用例全绿**）。已有：bvn2/bva2（Phase 1，key_version 轮换支持）、V2 路由 owner/node 双作用域、V1 隔离门、project_memberships 表名已在 §20.1 列出（未建表）。

先读：方案 §13 全部（13.1 身份分层 / 13.2 威胁模型 / 13.3 TLS 与服务发现 / 13.4 Recovery Signing Key 生命周期 / 13.5 Secret 使用）、§15.6（API 通用要求）、§21 Phase 6 原文、R1A-002（失陷节点 fail-closed）、R1C-003（证书/双信任轮换）、R1C-013（revoke 立即 fencing）。

## 目标

1. **Human Identity 最小版** `src/server/v2/human-identity.ts` + migration `008`（`project_memberships` + `human_sessions` 最小字段）：Owner 签发的人类会话 token（`bvh2_` 前缀，HMAC+exp+scope+project 绑定，复用 bvn2 的 key 体系与 fail-fast）；会话吊销列表（revoke 即失效，R1C-013 同语义）。
2. **RBAC 矩阵**：角色枚举（owner/project_admin/reviewer/auditor），项目粒度 membership（project_memberships: project_id+subject+role+status）；**鉴权中间件**（挂 V2 路由层）：每条 registry 路由的凭据作用域细化为 `owner | human(role≥x) | node | attempt`；**验收矩阵三条硬规则落测试**：Worker（node/attempt 凭据）不能 Review/merge；Reviewer 不能管理 Node（enroll/authorize/revoke/drain）；跨项目 Artifact 不可读（membership 无该项目→403）。
3. **凭据轮换与紧急撤销收口**：Node credential 轮换端点（老 generation 新 token 原子替换，旧 token 立即 fencing）；全局紧急撤销（revoke-all-sessions：按 key_version 前滚密钥版本，全部旧 token 立即失效——复用 Phase 1 轮换机制）；审计事件全量入 audit_events（actor/action/correlation_id）。
4. **Web/CLI 权限最小接线**：V1 Web 控制台的 local-owner 会话保持（不破坏）；V2 只读面（plans/nodes/deliveries 状态）对 `auditor` 角色开放的路由声明；CLI 不新增命令（运维仍走 owner）。
5. **Security audit 自查清单** `docs/runbooks/security-phase6.md`（中文）：§13.2 威胁逐项对照表（本阶段已覆盖/移交 Phase 8 TLS 的分界）、密钥与 token 生命周期表、轮换/撤销 runbook。
6. **失败优先测试** `tests/distributed/p6-rbac.test.ts`（真实 HTTP）：
   - 验收原文三矩阵（Worker 不能 review/merge、Reviewer 不能管 Node、跨项目 Artifact 403）；
   - 角色越权矩阵全组合（每角色×关键路由组，允许/拒绝逐断言）；
   - 会话吊销即时生效；revoke-all 后 bvn2/bva2/bvh2 全部失效（新版本签发可继续）；
   - Node credential 轮换：旧 token 409、新 token 通过、session generation 单调；
   - 审计事件完整性（每次敏感操作一条 audit_events，correlation_id 贯穿）。

## 约束

- 全程中文；**所有权**：`src/server/v2/human-identity.ts`、`src/server/v2/rbac.ts`（或 authz 中间件文件）、`src/server/v2/routes/**`（作用域字段细化与接线）、`src/server/v2/credentials.ts`（仅轮换/撤销扩展）、`src/db/migrations/008_*.ts`、`src/db/migrate.ts`、`src/db/sqlite-store.ts`（追加）、`src/types/**`（v2 追加）、`tests/distributed/p6-*.test.ts`、版本期望（链条连续性风格）、runbook。**不得改**：`src/server/v2/git/**`、`src/server/v2/merge/**`（只消费）、`src/server/service.ts`、`src/server/http-plugins.ts`（V1 行为零变化）、`src/node/**`、`src/mcp/**`、`web/`、既有 fixture。
- TLS/服务发现按方案属 Phase 8，不在本阶段；`BIAO_V2_*` env 纪律：测试 save/restore（p23 教训），hermetic 测试已有防回退门禁。
- 门禁：构建 + 全量不劣化 116/1313 基线。
- **流程要求（Phase 5 教训）**：交付说明必须贴四条验证的原始输出摘要（构建/p6 套件/distributed 全量/全量套件），vitest 通过≠构建通过。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿；全量复跑不劣化。
2. §21 Phase 6 验收原文三矩阵逐项测试路径 + §13.2 威胁对照表。
3. 交付说明：RBAC 矩阵全表（角色×路由组）、token 生命周期图（文字）、轮换/撤销 runbook 摘要、四条验证原始输出。
