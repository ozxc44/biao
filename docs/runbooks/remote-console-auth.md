# Web 控制台远程人类登录（方案 E：bvh2 Cookie 会话 + enrollment）

## 概述

NAS / 远程部署后，浏览器无法使用 loopback-only 的本机 Owner 会话（`/auth/local-session` 只在服务绑定 loopback 时可用）。方案 E 用 Phase 6 已有的 bvh2 人类身份体系为 Web 控制台补齐远程登录：

- **Owner 预登记**：Owner 用 API 创建一次性 enrollment code（`bhe2_` 前缀）交给使用者；
- **使用者登录**：远程浏览器打开控制台，输入 code → `POST /auth/human-session` → 服务端签发 bvh2 并写入 HttpOnly Cookie（`biao_human_session`）；
- **会话生命周期**：30 天 TTL；每请求复核 `human_sessions`（吊销即时生效，R1C-013）；登出即吊销；
- **与 loopback 并存**：本机部署继续走本机 Owner 会话，两条通道并列放行、互不替换。

Owner API token（`BIAO_API_TOKEN`）依然不进入浏览器（原则不变）。

## 前置条件

| 条件 | 说明 |
|------|------|
| SQLite 持久化 | enrollment/会话/吊销列表都落在 SQLite（`human_enrollments`、`human_sessions`，014/009 迁移） |
| `BIAO_V2_CREDENTIAL_KEY` | bvh2 签发/验签密钥环（≥32 字节 hex）。未配置时登录码消费返回 `ISSUE_FAILED`（fail-closed，不放行无签名会话） |
| 服务绑定非 loopback | 远程场景（如 `0.0.0.0`）。绑定 loopback 时本机会话仍可用，远程登录也可同时开启 |

生成密钥：`openssl rand -hex 32`。该密钥与 `BIAO_API_TOKEN` 完全独立，不得复用。

## 登录时序（文字图）

```
Owner（SSH/本机）                 Biao 服务                       远程浏览器
   |                                |                                |
   |-- POST /v2/human-enrollments ->|                                |
   |   {subject, role, project_id,  |  生成 bhe2_<64 hex>            |
   |    expires_in_hours=24}        |  落库 sha256(code)（明文不存）  |
   |<-- 200 {enrollment_code} ------|                                |
   |   （code 仅此一次返回）          |                                |
   |                                |                                |
   |            [Owner 通过IM把 code 交给使用者] ----> 使用者打开控制台 |
   |                                |<-- GET /auth/session ----------|
   |                                |--> {authenticated:false,       |
   |                                |     local_session_available:false}（远程）
   |                                |<-- GET /auth/human-session ----|
   |                                |--> {authenticated:false, available:true}
   |                                |                                |
   |                                |<-- POST /auth/human-session ---|
   |                                |    {enrollment_code}           |
   |                                |  hash 查找 → 未用/未过期 →      |
   |                                |  原子置 used_at → 签发 bvh2 →   |
   |                                |  human_sessions 落 active 行    |
   |                                |--> Set-Cookie: biao_human_session=bvh2_…;
   |                                |    HttpOnly; SameSite=Strict; Max-Age=2592000
   |                                |                                |
   |                                |<-- GET /status (Cookie) -------|
   |                                |  onRequest: resolveCredential  |
   |                                |  （验签+未吊销+membership 活跃）  |
   |                                |--> 200（按角色作用域放行）        |
   |                                |                                |
   |                                |<-- DELETE /auth/human-session --|
   |                                |  revokeSession → human_sessions|
   |                                |  落 revoked 行 + 清 Cookie      |
   |                                |--> 旧 Cookie 立即 401           |
```

## 端点

| 端点 | 鉴权 | 说明 |
|------|------|------|
| `POST /v2/human-enrollments` | owner-only | 创建一次性 enrollment。body：`{subject, role, project_id?, expires_in_hours?}`；`enrollment_code` 仅创建响应返回一次，后续不可查 |
| `POST /auth/human-session` | 公开（同源校验） | `{enrollment_code}` 换 bvh2 Cookie；失败码：401 `ENROLLMENT_NOT_FOUND` / 403 `ENROLLMENT_EXPIRED` / 409 `ENROLLMENT_ALREADY_USED` |
| `GET /auth/human-session` | 公开 | 当前远程会话状态（subject/role/expires_at/expired；不回传 token） |
| `DELETE /auth/human-session` | 公开（同源校验） | 登出：清 Cookie + 吊销 human_sessions 行 |

curl 演示（浏览器走同源；命令行需手动带头）：

```sh
# Owner 创建 enrollment（先把使用者加为项目 membership）
curl -X POST http://nas:7331/v2/project-memberships \
  -H "Authorization: Bearer $BIAO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"project_id":"proj-x","subject":"alice","role":"reviewer"}'

curl -X POST http://nas:7331/v2/human-enrollments \
  -H "Authorization: Bearer $BIAO_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"subject":"alice","role":"reviewer","project_id":"proj-x","expires_in_hours":24}'
# → {"ok":true,"data":{"enrollment_code":"bhe2_…", …}}   ← 仅此一次

# 使用者登录（Origin/Sec-Fetch-Site 模拟同源浏览器）
curl -i -X POST http://nas:7331/auth/human-session \
  -H 'Content-Type: application/json' \
  -H "Origin: http://nas:7331" -H 'Sec-Fetch-Site: same-origin' \
  -d '{"enrollment_code":"bhe2_…"}'
# → Set-Cookie: biao_human_session=bvh2_…; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict
```

## enrollment 安全参数

| 参数 | 值 | 说明 |
|------|-----|------|
| code 形态 | `bhe2_` + 32 字节随机 hex（256 bit 熵） | 单调不可预测；前缀区分凭据族 |
| 存储 | 只存 sha256(code)（`human_enrollments.code_hash` 唯一索引） | 明文不落库；泄露库文件拿不到可用 code |
| 返回 | 仅创建响应一次 | 后续任何端点不可查 |
| 一次性 | `UPDATE … WHERE used_at IS NULL` 原子置位 | 并发消费只有一个成功；其余 409 |
| 时效 | 默认 24h，上限 7 天（`expires_in_hours` 1~168） | 过期 403 `ENROLLMENT_EXPIRED` |
| 烧码顺序 | 先烧码再签发会话 | 签发失败（如 membership 已撤销）code 也作废，杜绝反复试探 |
| 来源审计 | `used_by_ip` 记录消费来源 IP | 事件审计：`human.enrollment.created/consumed` |

## 会话（bvh2 Cookie）安全参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Cookie | `biao_human_session`，HttpOnly + SameSite=Strict + Path=/ | JS 不可读；跨站不携带 |
| TTL | 30 天（与 Cookie Max-Age 对齐） | 与 V2 管理面签发的 bvh2（≤24h）同源同验签，仅 TTL 边界不同 |
| 吊销 | 每请求复核 `human_sessions`（revoke 即 401）+ membership 活跃 | R1C-013 语义；`revoke-all-sessions` 同样收口 |
| 密钥 | `BIAO_V2_CREDENTIAL_KEY` 密钥环（含 key_version 轮换/水位） | 未配置 fail-closed |
| login CSRF | `Origin` 必须匹配 Host（http/https 均可，兼容 TLS 终止代理）+ `Sec-Fetch-Site: same-origin` | 第三方页面无法静默登录 |
| 响应体 token | POST 响应同时回传 bvh2（备用通道） | 前端默认不存储；主通道是 Cookie |

## 角色矩阵

四角色 rank：owner(4) > project_admin(3) > reviewer(2) > auditor(1)。

### V1 面（onRequest 层角色作用域，`humanSessionV1RequestAllowed`）

| V1 端点族 | auditor | reviewer / project_admin | owner |
|-----------|---------|--------------------------|-------|
| 读面（`/status`、`/plans`、`/tasks`、`/intake`、`/questions`、`/events`…） | ✅ | ✅ | ✅ |
| PM 数据面 mutation（`/plan/submit`、`/plan/create`、plan/task supersede、task cancel/reset/resume/review/resolution、question answer、intake ack、project agent 绑定/预约、execution receipts） | ❌ 403 `HUMAN_SCOPE_DENIED` | ✅ | ✅ |
| 运维写入口（`/db/restore`、`/reconcile`、`/watchdog?auto_fix=…`） | ❌ | ❌ | ✅ |
| Worker 数据面（`/claim`、`/report`、`/register`…） | ❌ | ❌ | ✅ |

V1 面按角色收口，不区分项目（V1 API 无项目维度；项目粒度在 V2 面由 membership 收口）。

### V2 面（Cookie → Authorization 注入 → rbac.ts 既有矩阵）

Cookie 中的 bvh2 在 onRequest 层验证后被注入为 `Authorization: Bearer bvh2_…`（仅当请求未自带 Authorization 且路径为根路径 `/v2/*` 形态），后续与 bearer bvh2 完全同路径：registry 派生策略 → 角色 rank ≥ 路由最低角色 → 项目作用域（非 owner 只能访问自己绑定 project 的资源）→ `rbac.denied`/`v2.mutation` 审计。例：

| V2 路由 | auditor | reviewer+ |
|---------|---------|-----------|
| `GET /v2/projects`、`GET /v2/projects/:id`（读面） | ✅ | ✅ |
| `POST /v2/projects`（human 最低角色 owner） | ❌ 403 `RBAC_ROLE_DENIED` | ❌ |
| 交付审阅/恢复决策等写面 | 按 registry 各条目的 `credentialScopes` 派生 | 同左 |

注意：`/api/v2/…` 前缀形态的 V2 路径（RBAC 守卫按 `req.raw.url` 前缀判定，不覆盖该形态）在 Cookie 会话下 fail-closed 仅 owner 放行；标准根路径 `/v2/…` 不受影响。

### enrollment 创建

`POST /v2/human-enrollments` 仅 owner：Owner Bearer token / 本机 Owner 会话 / owner 角色的远程会话；其余 403 `OWNER_REQUIRED`。

## 与 loopback 会话的并存关系

| | 本机 Owner 会话 | 远程人类会话 |
|---|---|---|
| 端点 | `/auth/local-session` | `/auth/human-session` |
| 可用条件 | 服务绑定 loopback + apiToken | SQLite + `BIAO_V2_CREDENTIAL_KEY`（任意绑定） |
| 凭据 | HMAC(apiToken) 的 Cookie（30 天） | bvh2 Cookie（30 天） |
| 身份 | 本机 Owner（全权） | subject + role（按矩阵收口） |
| 吊销 | 轮换 apiToken 即全失效 | revokeSession / revoke-membership / revoke-all 即时生效 |

onRequest 判定优先级：Owner Bearer > Worker 派生 token > 本机 Owner 会话 > 远程人类 Cookie；两条 Cookie 通道**并列放行**，loopback 部署行为不变（回归门禁：`tests/http-auth.test.ts`、`tests/distributed/p8-loopback-e2e.test.ts`、`tests/distributed/p10-human-web-auth.test.ts` ⑩）。

## 故障排查

| 症状 | 原因与处置 |
|------|-----------|
| 登录页显示"远程登录不可用" | 服务未配置 SQLite 持久化或 `BIAO_V2_CREDENTIAL_KEY`；检查启动日志 |
| `ISSUE_FAILED` | 密钥环为空/非法；`openssl rand -hex 32` 生成并配置后重启 |
| 403 `HUMAN_SESSION_ORIGIN_DENIED` | Origin 与 Host 不匹配（反向代理改写 Host 时需保留原 Host；https Origin 已兼容） |
| 401 `ENROLLMENT_NOT_FOUND` | code 抄错或已过期删除 |
| 409 `ENROLLMENT_ALREADY_USED` | code 已被消费（含签发失败的烧码）；重新申领 |
| 登录后 403 `HUMAN_SCOPE_DENIED` | 角色不满足该 V1 端点族（见角色矩阵）；让 Owner 调整 membership 角色 |
| 会话突然全部 401 | Owner 执行过 `revoke-all-sessions`（key_version 前滚）；重新登录即用新版本 |

## 测试

`tests/distributed/p10-human-web-auth.test.ts`（16 用例）：enrollment 全生命周期、Cookie 端点往返与即时吊销、远程放行（V1 读面/PM 面 + V2 读面）、auditor 越权 403、V2 写面 RBAC 拒绝、enrollment owner-only、loopback 并行、membership 撤销与 revoke-all 收口、空密钥环 fail-closed；另有 `web/tests/human-session.test.ts`（前端 API 通道）。
