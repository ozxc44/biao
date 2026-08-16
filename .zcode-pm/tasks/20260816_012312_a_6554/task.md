# Phase 1（车道 B，收口）：Project/Node 服务装配 + V2 路由落地 + 端到端验收

## 前置状态（两条并行车道已验收）

- 车道 A（已落地）：migration `004_domain_identity`（六表 + 触发器约束）、`src/types/v2-identity.ts`、SqliteStore 六表方法（generation fencing 查询）、`src/redis/keys.ts` 的 `v2Keys`、`tests/distributed/p1-identity-data.test.ts`（14 用例，含两节点同 Project 场景的 store 层验证）。
- 车道 C（已落地）：`src/server/v2/credentials.ts`（Node credential + Attempt token，scope/generation fencing/key_version 轮换）、`src/server/v2/v1-isolation.ts`（V1 Worker Token 对 V2 项目 403 门）、registry 作用域对齐。
- 既有骨架：`src/server/v2/domain-interfaces.ts`（七服务接口）、`src/server/v2/routes/registry.ts`（53 条声明）、`src/server/http-plugins.ts`（共享 plugin）、`tests/distributed/fixtures/`。
- 全量基线：见交付时最新（此前 106 文件/1148 用例 + 车道 A 新增）。

先读：方案 §4.1/4.2/4.3（状态机）、§15.1/15.2（API 草案）、§10.3（心跳内容）、§7.1（Ownership V2 key 结构）、§11.1（调度过滤顺序——本阶段只做 identity 部分）。

## 目标

1. **ProjectService / NodeService 最小实现**（`src/server/v2/project-service.ts`、`src/server/v2/node-service.ts`，实现 domain-interfaces 对应方法，组合 A 的 store + C 的 credentials）：
   - Project：create/get/list + execution_mode 切换走 `project_mode_transitions`（一步式 API：创建 running transition 记录 + 更新 projects.mode_transition 字段；方向-step 合法性按 §4.1）；
   - Node：enroll（enrolling → active，签发 Node credential 返回一次）、register（新 session generation 递增，fencing 旧 session）、heartbeat（更新 last_seen/capacity/clock_skew，§10.3 字段）、drain/fence；
   - Node→Project 授权：bind/authorize（authorization_revision 递增）+ unauthorize（写 credential_status 撤销语义，R1C-013 的最小版：撤销即后续 fencing）。
2. **V2 ownership snapshot 数据面**：claim 侧暂不接线（Phase 4），本阶段交付 `ownership_snapshots` 的写入/校验函数（`src/server/v2/ownership-v2.ts`：snapshot 写入带 revision/expires_at、校验读快照比对 write_globs）+ 单测。
3. **V2 路由落地**：`src/server/v2/routes/`（project/node/session/authorization 各一组），走 registry 声明 + 共享 plugin；`src/server/http.ts` 只加一行装配（`app.register(v2Routes)`）。鉴权：Node credential（verify），owner 可管理；V1 worker token 由车道 C 隔离门拒绝。
4. **端到端验收测试** `tests/distributed/p1-e2e-identity.test.ts`（真实 HTTP：隔离端口起 server + 独立 SQLite + 6380 测试 DB）：
   - 两台模拟 Node（不同本地路径）经 enroll→authorize→heartbeat，被识别为同一 Project（方案 Phase 1 验收原文的 HTTP 层验证）；
   - 旧 generation session 的 register/heartbeat 被 fencing（409 + 新代次不变）；
   - 撤销授权后的 Node 后续操作被拒；
   - V1 worker token 对该 V2 项目 claim 403（车道 C 门禁的 HTTP 实证）；
   - Attempt token 签发→校验→scope 越权拒绝（HTTP 无关，纯函数补测可并入）。
5. registry 门禁自动覆盖新路由（schema/作用域/前缀/与 V1 零冲突）。

## 约束

- 全程中文；**只改/新增**：`src/server/v2/**`（新文件 + registry 更新）、`src/server/http.ts`（仅装配行）、`tests/distributed/p1-*.test.ts`。**不得改**：`src/db/**`、`src/types/**`、`src/redis/**`、`src/server/service.ts`、`src/server/http-plugins.ts`（只 import）、既有 fixture、`src/mcp/**`、`web/`。
- 若发现 A/C 车道接口缺口：在自己文件内写薄适配层并在交付说明中列缺口，不回改他人文件。
- 不启动生产栈；不新增 `*_TEST_REDIS_URL`（复用 6380 既有 DB，测试内 flush）。
- 门禁：构建 + 全量不劣化最新基线。

## 验收标准

1. `npm run build:server` + `npx vitest run tests/distributed/` 全绿。
2. 端到端用例四场景全过（两节点同 Project HTTP 层 / generation fencing / 撤销拒绝 / V1 隔离 403）。
3. 交付说明：路由清单（method/path/凭据作用域）、A/C 接口缺口清单、Phase 1 对照方案 §21 验收标准的逐项结论。
