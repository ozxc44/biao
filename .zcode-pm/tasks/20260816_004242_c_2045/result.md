## 交付总结（Phase 1 · 车道 C：凭据分裂基础 + V1 隔离门）

### 变更文件（严格限定在车道 C 允许清单内）

| 文件 | 内容 |
|---|---|
| `src/server/v2/credentials.ts`（新增） | V2 凭据原语：`issueNodeCredential`/`verifyNodeCredential`、`issueAttemptToken`/`verifyAttemptToken`、密钥环解析与轮换、fail-fast/fail-closed |
| `src/server/v2/v1-isolation.ts`（新增） | V1 隔离门：`isV2EnabledProject` 可注入谓词（默认 `BIAO_V2_PROJECTS`）、请求→项目解析、403 信封 |
| `src/server/http-plugins.ts` | 在共享 plugin 的 onRequest 鉴权之后挂 preValidation 隔离门（新增 `isV2EnabledProject?` 装配参数） |
| `src/server/v2/routes/registry.ts` | 新增 `V2RouteCredentialBinding` 类型；15 条 node/task_attempt 数据面条目声明 `credentialBinding`（verifier + attemptScope） |
| `tests/distributed/p1-credentials.test.ts`（新增） | 33 个失败优先用例 |

未触碰 `src/db/**`、`src/types/**`、`src/redis/**`、`src/server/service.ts`、`src/server/http.ts`、`src/mcp/**` 与既有 fixture；未新增 npm 依赖与 `*_TEST_REDIS_URL`（复用 6380 DB 15）。

### 验证

- `npm run build:server` ✅
- `npx vitest run tests/distributed/`：**12 文件 / 159 用例全绿**（基线 126 + 本次 33）✅
- 全量：108 文件 / 1195 用例，仅 `tests/supervisor-pm-agent-cli.test.ts` 的 SIGINT/SIGINT-grandchild 时序用例失败——**与本交付无关的既有 flaky**（已用 stash 移除本次五文件后复跑，该文件两次分别失败 3/2 个用例；单独重跑则通过；当前分支 `fix/pm-force-kill-grace` 正在修该区域）
- 额外单独复跑 plugin 消费方 `tests/http-auth.test.ts`、`tests/restore-maintenance-gate.test.ts`、`tests/pm-cli.test.ts`：99 用例全绿
- 变异验证：把默认谓词改为恒 false 后，隔离门相关 3 个用例转红，证明测试真实门住逻辑（已还原）

### 交付说明

**1. Token 结构（不含密钥材料）**

```
bvn2_<base64url(payload)>.<base64url(HMAC-SHA256)>   # Node credential，默认 TTL 24h
bva2_<base64url(payload)>.<base64url(HMAC-SHA256)>   # Attempt token，默认 TTL 15min（须短于 lease 上限）
```
- Node payload：`{v:"bvn2", kv, node_id, generation, iat, exp, jti}`；Attempt payload：`{v:"bva2", kv, attempt_id, task_id, generation, scope, iat, exp, jti}`
- scope 枚举：`claim | report | ownership | question`（§13.1）；签名对象为 base64url 段本身；verify 做 canonical 重编码比对（拒乱序/多余字段/非规范编码）+ `timingSafeEqual`；失败只返回稳定 reason 枚举（`MALFORMED_TOKEN/UNKNOWN_KEY_VERSION/BAD_SIGNATURE/EXPIRED/NO_KEY_CONFIGURED/SUBJECT_MISMATCH/GENERATION_MISMATCH/SCOPE_MISMATCH`），任何错误信息与结果对象都不含 token 片段（测试断言覆盖）

**2. 密钥轮换方案**：`BIAO_V2_CREDENTIAL_KEY` 取 `<hex>`（=v1）或 `<version>:<hex>,<version>:<hex>`（轮换窗口，最高 version 签发、其余仅验签）；token 内嵌 `kv`，撤掉旧 version 后旧 token 以 `UNKNOWN_KEY_VERSION` 拒绝；未配置时 `assertV2CredentialKeyConfigured()` 启动期抛出并附 `openssl rand -hex 32` 指引（V2 路由装配点接入；纯 V1 部署不受影响——隔离门不消费该密钥）；verify 侧密钥缺失/非法一律 fail-closed

**3. V1 隔离门触发矩阵**

| 路由 | Worker token × V2 项目 | Worker token × V1 项目 | Owner bearer / 本机会话 |
|---|---|---|---|
| POST /claim（preferred_project 或 preferred_plan_ids 解析命中） | **403** | 200 | 200 |
| POST /report、/lease/renew、/ownership/declare、/ownership/release（task_id→getTask→project_path） | **403** | 200 | 200 |
| 其余全部路由（含 /question、GET /task、/ownership 读） | 不经门（保持 V1） | 不变 | 不变 |

错误码 `V1_CREDENTIAL_REJECTED_FOR_V2_PROJECT`，V1 错误信封风格，message 不回显 token；挂载在 onRequest 鉴权后、permit 获取前（被拒请求不制造 mutation permit）；`/api` 前缀同生效。

### 残留风险

1. **无项目过滤的全局 claim 不经门**：不带 `preferred_project`/`preferred_plan_ids` 的 claim 无法在守卫层预知归属，Phase 1 保持 V1 语义；迁移期收口手段是停用全局 worker token（已在 `v1-isolation.ts` 头注释注明）
2. task/plan 解析失败（任务不存在、Redis 故障）时门开——V1 错误语义由原 handler 给出，不制造新错误面
3. `ownership` attemptScope 已入枚举但暂无对应 V2 路由（registry 对齐测试不强制使用），Phase 2+ ownership 投影路由落地时挂接
4. 车道 A store 落地后需在 `http-plugins.ts` 装配点把默认 env 谓词换成 store 谓词（接口已就绪，一行切换）；`assertV2CredentialKeyConfigured` 尚需 V2 路由装配点接线（本车道不改 `http.ts`）