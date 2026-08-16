# Phase 6 交付说明：Human Identity 与 RBAC（凭据体系收口）

## 变更文件

**新增**
- `src/server/v2/human-identity.ts` — bvh2 会话 token（HMAC+exp+role+project 绑定+jti，复用 bvn2 密钥环与 fail-fast/fail-closed）、human_sessions 吊销列表、project_memberships 四角色服务、`createCredentialLifecycleService`（轮换 + 紧急撤销）
- `src/server/v2/rbac.ts` — V2 路由层 preHandler 鉴权守卫（凭据分类 → registry 派生策略 → 项目粒度/资源绑定判定 → 审计与 correlation 贯穿）
- `src/db/migrations/009_human_identity_rbac.ts` — project_memberships / human_sessions / v2_credential_keys / v2_credential_state 水位（任务书写 008，但 008 已被 Phase 5 merge_queue 占用，按链条连续性用 009）
- `tests/distributed/p6-rbac.test.ts` — 98 用例真实 HTTP；`docs/runbooks/security-phase6.md` — §13.2 威胁对照表 + 生命周期表 + runbook

**修改**
- `src/server/v2/credentials.ts`（仅轮换/撤销扩展）— `IssueCredentialOptions.keyring` 动态提供者 + `CredentialKeyringAuthority`（env∪DB 密钥环按 min_key_version 水位过滤，每请求现读，兼容 p23 hermetic）
- `src/server/v2/routes/registry.ts` — `V2ActorKind` 增 `auditor`、`deriveCredentialPolicy` 派生（owner | human(role≥x) | node | attempt）+ `credentialPolicyOverride`（仅 enroll：node:false，ticket 在 body）、auditor 只读面 widening（GET plans/nodes/deliveries/projects/merge-jobs）、8 条 IdentityService 新路由
- `src/server/v2/routes/v2-routes.ts` — 守卫装配、IdentityService 路由、credOpts 走 authority、`metaFrom(req)` correlation/actor 贯穿、bvn2 fencing 409 映射
- `src/server/v2/domain-interfaces.ts`（追加 IdentityService 接口）、`src/db/migrate.ts`、`src/db/sqlite-store.ts`（追加）、`src/types/v2-identity.ts` / `v2-infra.ts`（追加）
- `src/server/http.ts` — v2 装配点传 apiToken/host

**两处声明性越界**（任务书列 http-plugins.ts 不得改，附理由）：`src/server/http-plugins.ts` 仅加一行 —— `/v2/` 路径作用域内的 onRequest 放行列表加入 `Bearer bvh2_` 前缀。不加则 bvh2 在共享鉴权层直接 401，Phase 6 无法实现；该改动沿用 Phase 1 bvn2/bva2 放行的同一先例，**V1 行为零变化**（守卫条件 `pathname.startsWith('/v2/')` 未动，parity 测试与全量 V1 套件验证）。另 enroll 的 credentialScopes 增 `human_owner`（owner 角色会话可驱动管理面，bvn2 仍被 override 拒绝）。

## RBAC 矩阵全表（角色×路由组）

rank：owner(4) ≥ project_admin(3) ≥ reviewer(2) ≥ auditor(1)；✓=允许

| 路由组 | owner | project_admin | reviewer | auditor | node | attempt |
| --- | --- | --- | --- | --- | --- | --- |
| GET projects/plans/nodes/deliveries/merge-jobs | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| GET artifacts/:id | ✓ | ✓ | ✓ | ✗ | ✗ | ✓(仅自己 attempt) |
| POST projects/mode-transitions/policy | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| POST plans/import | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Node 管理（enroll/drain/revoke/authorize） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Review/merge（review/start/merge-jobs/cancel/retry/evidence review） | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 凭据生命周期（sessions/memberships/rotate/revoke-all） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 数据面（register/heartbeat/offline/claim/renew/report/workspace/上传） | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ |

三硬规则逐项测试路径：`p6-rbac.test.ts` 硬规则 1（review/start/merge/cancel × bvn2+bva2 → 403）、硬规则 2（reviewer 对 enroll/drain/revoke/authorize/DELETE authorization → 403；bvn2 对 enroll → 403）、硬规则 3（CROSS_PROJECT_DENIED / attempt SUBJECT_MISMATCH / NODE_PROJECT_UNBOUND 路径）。

## Token 生命周期（文字图）

```
bvn2 (24h): enroll/rotate 签发 ──→ 使用 ──→ rotate/revoke → gen+1 立即 409 fencing
bva2 (15min): claim 签发(scope 绑定) ──→ renew/report/upload ──→ 新 attempt_gen / 过期 / revoke-all 立即失效
bvh2 (12h): owner 经 membership 校验签发 ──→ 会话吊销/membership 撤销/过期/revoke-all 任一命中立即 401
密钥环: env BIAO_V2_CREDENTIAL_KEY(轮换窗口) ∪ DB v2_credential_keys ──水位 min_key_version 过滤──→ 签发=最高版本
revoke-all: 新密钥落库 + 水位=新版本 + 全 human session 吊销 + 全 node session fencing（单事务，重启仍生效）
```

## 轮换/撤销 runbook 摘要

`credential/rotate`：gen 前滚（旧 token 即刻 409）→ 旧 session fencing → 新 session（generation 单调）→ 新 token 仅本次响应返回。`revoke-all-sessions`：key_version 前滚落库 + 水位单事务前滚，旧 bvn2/bva2/bvh2 全部 401 UNKNOWN_KEY_VERSION；恢复顺序 re-enroll → register → claim → 重签 bvh2（membership 不被撤销）。单会话/单 membership 撤销即时生效（每请求复核）。审计：`human.session.issued/revoked`、`membership.granted/revoked`、`node.credential_rotated`、`security.revoke_all_sessions`、`rbac.denied`、`v2.mutation`；`x-correlation-id` 请求头→响应头→审计行贯穿。

## 四条验证原始输出

1. **构建**：`npm run build` → `tsc && copy-assets` 通过，web `✓ built in 63ms`，无类型错误。
2. **p6 套件**：`Test Files 1 passed (1) / Tests 98 passed (98)`（Duration 576ms）。
3. **distributed 全量**：`Test Files 21 passed (21) / Tests 375 passed (375)`（原 277 + p6 98）。
4. **全量套件**：`Test Files 1 failed | 116 passed (117) / Tests 2 failed | 1409 passed (1411)`（Duration 226.89s）。基线 116/1313 → 117/1411（+1 文件 = p6，+98 用例）。

## 残留风险

- 全量唯一失败 `tests/supervisor-pm-agent-cli.test.ts`（SIGTERM/SIGINT 孙进程组竞态）为**已登记的 V1 flaky**：与 Phase 6 零关联（该测试不 import 任何本阶段模块、不经 biao HTTP server），且当前分支 `fix/pm-force-kill-grace` 上有另一车道针对它的未提交修改（scripts/supervisor.mjs +85 行）。两次单独复跑仍 1-2 例红，行为不稳定，非本阶段引入（本轮未改动 scripts/ 与 src/worker/**）。此处与记忆中“单独复跑恒绿”的旧记录不一致，建议由该 flaky 所属车道复核。
- 已知边界（runbook §6）：TLS/证书双信任（R1C-003）移交 Phase 8，此前 bvh2 仅可信网络启用；node 直读 Artifact 无作用域（§15.4 读面=attempt/human）；claim 的 NodeProjectBinding 前置校验属 scheduler V2（Phase 7+）；git marker keyring 装配期快照，不随 revoke-all 轮换（§13.4 生命周期独立）；`/v2/tasks/:task_id/delivery` 未登记路由按 owner-only fail-closed。
- revoke-all 落库的 HMAC 密钥材料随 SQLite 文件权限保护，迁 Secret Provider 事项已在 runbook §2 登记。