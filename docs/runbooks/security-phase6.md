# Phase 6 Security 自查清单：Human Identity 与 RBAC

对应方案 §13（身份、安全与威胁模型）与 §21 Phase 6。本手册是 Phase 6 交付的
security audit 自查记录与运维 runbook：

- 实现：`src/server/v2/human-identity.ts`（bvh2/membership/轮换/紧急撤销）、
  `src/server/v2/rbac.ts`（鉴权中间件）、`src/server/v2/routes/registry.ts`
  （作用域细化派生）、`src/db/migrations/009_human_identity_rbac.ts`。
- 测试：`tests/distributed/p6-rbac.test.ts`（真实 HTTP，98 用例）。

## 1. §13.2 威胁模型逐项对照表

| §13.2 威胁 | Phase 6 状态 | 证据 / 分界 |
| --- | --- | --- |
| 恶意 Verify 命令 | **本阶段部分覆盖** | Plan import 路由声明 `planner`（≥project_admin）作用域；项目命令策略细化属 Phase 7（策略面）与沙箱（后续） |
| 节点凭据泄露 | **已覆盖** | 每节点独立 bvn2 + `credential/rotate`（gen 前滚即 fencing，409）；短期 bva2；`revoke-all-sessions` 全量失效（p6 §4/§5） |
| 失陷节点伪造 Verify/Artifact/Delivery | **本阶段凭据面覆盖，独立验收属 Phase 4/8** | attempt token 只能操作单 attempt（资源绑定 401/403）；独立节点验收链路沿 Phase 4 服务端复核 |
| 旧节点重放 report | **已覆盖（凭据层）** | attempt_generation fencing + 轮换后旧 bvn2 立即 409（R1C-013 同语义） |
| Artifact 篡改 | Phase 2 已覆盖 | 服务端复算 SHA-256 + digest 不可变；Phase 6 追加跨项目读拒绝 |
| 分支 force-push | Phase 4/5 已覆盖 | Delivery 绑定 head_sha + CAS；与 RBAC 正交 |
| 主分支被 Worker 写入 | **已覆盖（凭据层）** | review/merge 路由派生策略禁 node/attempt（p6 硬规则 1）；Merge Bot 单写沿 Phase 5 |
| 日志泄密 | 沿用既有纪律 | token 校验失败只返回稳定 reason 枚举，不回显 token 内容（bvh2 同 bvn2 口径） |
| 跨项目读取 | **已覆盖** | 非 owner 会话只作用绑定 project；attempt 只读自己 attempt 的 Artifact/Delivery；membership 缺失 → 403 CROSS_PROJECT_DENIED（p6 硬规则 3） |
| Login CSRF / 远程 Cookie | **已覆盖（最小版）** | 远程人类身份走 Bearer bvh2（无 Cookie 面）；V1 local-owner 会话仍仅 loopback，V1 Web 行为零变化 |
| Redis 暴露 | 沿用既有部署约束 | Redis 不对节点网络开放（部署面，Phase 8 拓扑收口） |

**移交 Phase 8 的分界**：§13.3 TLS/服务发现/证书双信任轮换（R1C-003）不在
本阶段——bvh2/bvn2/bva2 的机密性与完整性依赖传输层 TLS；Phase 6 之前请在
可信局域网或 loopback 部署启用 V2 人类身份面。

## 2. 密钥与 token 生命周期表

| 凭据 | 前缀 | 签发 | 有效期 | 失效方式 | 存储 |
| --- | --- | --- | --- | --- | --- |
| Node credential | `bvn2_` | enroll / `credential/rotate` | 默认 24h（TTL 长期，撤销靠 generation） | rotate/revoke/quarantine → generation 前滚立即 fencing（409）；revoke-all → key_version 水位（401 UNKNOWN_KEY_VERSION） | 节点本地 0600 凭据文件；服务端只存 generation |
| Attempt token | `bva2_` | claim 成功 | 默认 15min（< lease 上限） | 自然过期 / attempt_generation 前滚 / revoke-all | 不落库明文（jti/digest 登记） |
| Human session | `bvh2_` | Owner 经 `POST /v2/human-sessions` | 默认 12h（≤24h 可调） | 会话吊销（立即 401）/ membership 撤销（派生会话立即失效）/ 自然过期 / revoke-all | `human_sessions` 表（jti/key_version/状态） |
| V2 签名密钥环 | — | env `BIAO_V2_CREDENTIAL_KEY`（`<v>:<hex>,…` 轮换窗口） | — | revoke-all 前滚：DB 落库新版本 + `min_key_version` 水位（重启仍生效） | env（运维）+ `v2_credential_keys`（紧急轮换落库，随 SQLite 文件权限保护） |

注意（MVP 取舍，已登记）：revoke-all 生成的新签发密钥材料落
`v2_credential_keys` 表以获得重启安全性。迁移 Secret Provider/HSM 时该表应
改为只存 key_id/公钥类引用（对齐 §13.4 的 Control Plane Signing Key 纪律），
届时 `CredentialKeyringAuthority.loadPersistedKeys` 换数据源即可。

## 3. RBAC 矩阵（角色 × 路由组）

角色 rank：`owner(4) ≥ project_admin(3) ≥ reviewer(2) ≥ auditor(1)`。
registry 每条路由的运行时策略由 `deriveCredentialPolicy` 从 `credentialScopes`
派生：`owner | human(role≥x) | node | attempt`（owner bearer 是 V2 全路由
运维超集，V1 行为保持）。

| 路由组 | owner | project_admin | reviewer | auditor | node | attempt |
| --- | --- | --- | --- | --- | --- | --- |
| GET projects / plans/:id / nodes / deliveries/:id / project merge-jobs | ✓ | ✓ | ✓ | ✓（只读面） | ✗ | ✗（delivery 除外） |
| GET artifacts/:id | ✓ | ✓ | ✓ | ✗ | ✗（§15.4 无 node 作用域） | ✓（仅自己 attempt） |
| POST /v2/projects、mode-transitions、policy | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| POST /v2/plans/import | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Node 管理（enroll/drain/revoke/authorize/authorization 删除） | ✓ | ✗ | ✗ | ✗ | ✗（enroll 只认 body ticket） | ✗ |
| Review / merge（review、review/start、merge-jobs、cancel/retry、evidence review） | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 凭据生命周期（human-sessions、memberships、credential/rotate、revoke-all-sessions） | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 数据面（register/heartbeat/offline/claim/renew/report/workspace/artifact 上传） | ✓ | ✗ | ✗ | ✗ | ✓（heartbeat 等） | ✓（renew/report 等） |

硬规则（§21 Phase 6 验收原文，p6 测试逐项断言）：
1. **Worker 不能 Review/merge**：node/attempt 凭据对全部评审/合并路由 403。
2. **Reviewer 不能管理 Node**：enroll/authorize/revoke/drain 派生策略
   owner-only；bvn2 也不是 enroll 的凭据（ticket 在 body）。
3. **跨项目 Artifact 不可读**：会话绑定项目 ≠ 资源项目 → 403
   CROSS_PROJECT_DENIED；membership 撤销即时传导。

## 4. 轮换 runbook

### 4.1 Node credential 例行轮换（单节点，疑似泄露或周期性）

```bash
# 1) Owner 触发轮换（立即返回新 token；旧 token 从此 409）
curl -XPOST $SERVER/v2/nodes/$NODE_ID/credential/rotate \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"例行轮换 2026-08"}'
# → { node_credential: "bvn2_…", credential_generation: N+1, node_session_generation: M+1 }

# 2) 把新 token 原子写入节点凭据文件（biao-node 0600 存储，先写临时文件再 rename）

# 3) 验证：新 token 心跳 200；旧 token 心跳 409 CREDENTIAL_FENCED
```

要点：generation 前滚先于新 session 落库，旧 token 从前滚一刻起被 fencing
（R1C-013）；`node_session_generation` 单调递增（p6 §5 断言）。轮换是原子
替换——若节点没有及时换上新 token，会持续 409，需重新执行第 2 步。

### 4.2 单会话 / 单 membership 撤销

```bash
curl -XPOST $SERVER/v2/human-sessions/$SESSION_ID/revoke -H "…" -d '{"reason":"人员变动"}'
curl -XPOST $SERVER/v2/project-memberships/$MEMBERSHIP_ID/revoke -H "…" -d '{"reason":"离项"}'
```

会话吊销即时生效（下一个请求 401 HUMAN_SESSION_REVOKED）；membership 撤销
会即时杀掉由它派生的全部会话（resolveCredential 每请求复核）。

### 4.3 全局紧急撤销（revoke-all-sessions）

```bash
curl -XPOST $SERVER/v2/security/revoke-all-sessions \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"凭据体系疑似失陷，全量轮换"}'
# → { new_key_version: K+1, min_key_version: K+1, revoked_human_sessions: n, fenced_node_sessions: m }
```

效果（单事务落库，§20.4 迁移纪律）：
1. 生成新签发密钥并按 key_version 前滚（`v2_credential_keys` 落库）；
2. `min_key_version` 水位 = 新版本：**全部旧 bvn2/bva2/bvh2 立即 401
   （UNKNOWN_KEY_VERSION）**，控制面重启后仍生效（水位 durable）；
3. 全部活跃 human session 吊销 + 全部活跃 node session fencing。

恢复顺序（"新版本签发可继续"）：
1. 节点重新 enroll（owner 或 enrollment ticket）→ 新 bvn2（新 key_version）；
2. daemon register 建新 session → heartbeat 恢复；
3. Worker 重新 claim → 新 bva2；
4. 重新为人员签发 bvh2（membership 不被 revoke-all 撤销，无需重授）。

后续（可选但建议）：把 env `BIAO_V2_CREDENTIAL_KEY` 更新为
`"<K+1>:<新密钥hex>"` 并滚动重启——env 与 DB 双源合并取并集，水位不变，
行为不变；完成后再清理 DB 中过期版本记录。

## 5. 审计事件

全部 V2 敏感操作入 `audit_events`（actor/action/subject/correlation_id）：

| action | 触发 |
| --- | --- |
| `human.session.issued` / `human.session.revoked` | bvh2 签发 / 吊销 |
| `membership.granted` / `membership.revoked` | 授予 / 撤销 |
| `node.credential_rotated` | 单节点轮换 |
| `security.revoke_all_sessions` | 紧急撤销（subject_id=`key_version:N`） |
| `rbac.denied` | 每次鉴权拒绝（任意凭据类，含越权尝试） |
| `v2.mutation` | owner/human 类放行的 V2 mutation（机器数据面有自己的 durable 记录） |

correlation_id 贯穿：请求头 `x-correlation-id`（缺省自动生成）→ 响应头回显
→ 服务层 + 中间层审计行。p6 §6 断言同 correlation 至少覆盖
membership.granted / human.session.issued / v2.mutation 三类行。

## 6. 已知边界与移交项

1. **TLS/证书双信任轮换（R1C-003）**：Phase 8。此前 bvh2 只应在可信网络启用。
2. **enroll 的 ticket 常量时间校验**在 node-service（Phase 2+3 门禁已覆盖）；
   RBAC 层只约束"bvn2 不是 enroll 凭据"。
3. **Node 直读 Artifact**：§15.4 未给 node 作用域（读面=attempt/human）；
   授权节点内资源读经 attempt token。`NODE_PROJECT_UNBOUND` 分支保留为
   registry 未来放宽时的防御纵深。
4. **claim 的 NodeProjectBinding 前置校验**（§22.3"未授权不能 claim"）：
   调度侧授权门禁属 scheduler V2（Phase 7+），当前 claim 仍以任务归属为准；
   RBAC 已覆盖 read/deliver 的项目绑定拒绝路径。
5. **revoke-all 后的 workspace/marker keyring**：git marker 签名密钥环在
   插件装配期快照，不随 revoke-all 轮换（marker 生命周期独立于 API token，
   §13.4）；如需联动轮换须重启控制面。
6. **`/v2/tasks/:task_id/delivery`（未登记路由）**：按 owner-only fail-closed
   处理；该路由应后续并入 registry 或删除。
