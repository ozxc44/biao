# 方案 E：Web 控制台远程人类登录（bvh2 Cookie 会话 + enrollment 流程）

## 背景

NAS 119 远程部署后浏览器无法使用 loopback-only 的本机 Owner 会话。用户决策：**直接按方案 E 推进**——用 Phase 6 已有的 bvh2 人类身份体系为 Web 控制台提供完整的远程登录能力。全量基线 **132 文件/1646 用例**。

先读：`src/server/v2/human-identity.ts`（bvh2 签发/验签/吊销/membership）、`src/server/http-plugins.ts`（onRequest 鉴权 + localOwnerSessionAvailable 机制）、`web/src/api.ts`（前端 API 调用方式）、`web/src/App.tsx`（应用入口与 auth 状态）。

## 目标

### 1. 服务端：人类登录端点（Cookie 会话）

**`POST /auth/human-session`**（新路由，http.ts 或 http-plugins.ts）：
- 请求体：`{ enrollment_code: string }`（一次性登录码）；
- 校验 enrollment_code → 找到预登记的 human identity（subject + role + project_id）→ 签发 bvh2 token → **写入 HttpOnly Cookie**（`biao_human_session`，SameSite=Strict，30 天 TTL）→ 响应 `{ok, data: {authenticated: true, subject, role}}`；
- 同时把 bvh2 token 放进响应体（前端可选择存 sessionStorage 备用，但主通道是 Cookie）。

**`DELETE /auth/human-session`**：清除 Cookie + 吊销会话（写 human_sessions 吊销行）。

**`GET /auth/human-session`**：查询当前会话状态（subject/role/expired，不回传 token）。

**Enrollment code 生成**：`POST /v2/human-enrollments`（owner-only）：
- Owner 创建：`{ subject: "alice", role: "project_admin", project_id: "proj-x", expires_in_hours: 24 }`；
- 生成一次性 enrollment_code（`bhe2_` 前缀 + random 32 字节 hex，存 `human_enrollments` 新表——014 迁移）；
- **仅创建时返回一次**（后续不可查，用过即焚）；
- 使用后标记 `used_at`，不可重放。

**鉴权中间件扩展**：`http-plugins.ts` 的 onRequest：
- 新增 `humanSessionAuthenticated`：Cookie `biao_human_session` 含有效 bvh2 → 验签 + 检查 human_sessions 未吊销 + membership 活跃 → 放行；
- 作用域：**全部 V1 读面 + V1 PM 数据面**（intake/review/plan/task question 等）+ **V2 全部 human 角色可访问的路由**（经 RBAC 矩阵）；
- 与现有 `humanAuthenticated`（loopback local-owner）**并列放行**，不替换（loopback 部署仍用本地会话）。

### 2. 数据库：014 迁移

`human_enrollments` 表：`enrollment_id, code_hash (sha256 of enrollment_code), subject, role, project_id, created_by, created_at, expires_at, used_at, used_by_ip`。唯一：`enrollment_id`；约束：`used_at IS NULL OR used_at > 0`（一次性）。

### 3. 前端：登录页与会话管理

**`web/src/components/HumanLoginPage.tsx`**：
- 显示当前部署模式（loopback=本机会话按钮 / 远程=enrollment code 输入框）；
- 远程模式：输入 enrollment code → POST /auth/human-session → 成功后进入主界面；
- 错误显示（code 无效/过期/已用）。

**`web/src/api.ts`**：
- `createHumanSession(code)` / `getHumanSessionStatus()` / `deleteHumanSession()`；
- 认证检查：先查 local-session → 不行则查 human-session → 都不行显示登录页。

**`web/src/App.tsx`**：
- 启动时依次尝试 local session → human session → 未认证则显示 LoginPage；
- 顶栏显示当前身份（"本机 Owner" / "alice (project_admin)"）+ 登出按钮。

### 4. 安全边界

- enrollment_code 一次性、时效（默认 24h）、只存 hash 不存明文；
- Cookie HttpOnly + SameSite=Strict（已有模式）；
- 会话吊销即时生效（每请求复核 human_sessions 表，R1C-013 语义）；
- 不把 owner API token 交给浏览器（原则不变）；
- 已有 bvh2 密钥环（BIAO_V2_CREDENTIAL_KEY）签名；未配置时启动 fail-fast（已有语义）。

### 5. 测试 `tests/distributed/p10-human-web-auth.test.ts`

- enrollment 全生命周期：owner 创建 → code 仅返回一次 → 使用成功获取 bvh2 Cookie → 重复使用拒绝（409 ENROLLMENT_ALREADY_USED）→ 过期拒绝；
- Cookie 会话端点：POST/GET/DELETE 完整往返；DELETE 后 Cookie 无效 + human_sessions 吊销行落库；
- 远程访问：HTTP 层非 loopback 请求 + 有效 bvh2 Cookie → 放行 V1 读面（/status、/plans）+ V1 PM 面（/intake）+ V2 读面；
- 越权：auditor 角色的 bvh2 Cookie 对 V1 mutation（POST /plan/submit）403；
- 本机登录不受影响（loopback local session 依然可用，两条路并行）。

### 6. 文档

- `docs/runbooks/remote-console-auth.md`（中文）：NAS/远程部署的完整登录流程（Owner 创建 enrollment → 用户打开控制台 → 输入 code → 开始工作）、角色矩阵、与 loopback 会话的关系。

## 约束

- 全程中文；**所有权**：`src/server/http-plugins.ts`（鉴权扩展）、`src/server/http.ts`（3 条新路由）、`src/server/v2/human-identity.ts`（enrollment 函数）、`src/db/migrations/014_human_enrollments.ts`、`src/db/sqlite-store.ts`（enrollment CRUD）、`src/types/**`（追加）、`web/src/components/HumanLoginPage.tsx`（新）、`web/src/api.ts`、`web/src/App.tsx`、`web/src/i18n/translations.ts`（两种语言）、`tests/distributed/p10-human-web-auth.test.ts`、runbook。
- **不得改**：`src/server/v2/routes/**`（已有 human-sessions 路由不动）、`src/server/v2/rbac.ts`（不改矩阵，Cookie 鉴权在 onRequest 层完成）、`src/server/service.ts`、`src/node/**`、`src/mcp/**`。
- 四条验证原始输出随交付；测试 env save/restore 纪律。
- 门禁：构建（server+web）+ 全量不劣化 132/1646 基线。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿（含新 p10 套件）；`npm --prefix web test` 全绿；全量不劣化。
2. 远程浏览器完整流程实证：enrollment 创建 → code 输入 → Cookie 会话 → V1/V2 API 正常调用 → 登出即时失效。
3. 交付说明：登录时序图（文字）、enrollment 安全参数表、角色矩阵、与 loopback 会话的并存关系、四条验证原始输出。
