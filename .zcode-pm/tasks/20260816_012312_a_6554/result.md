我来开始执行 Phase 1 任务。首先需要了解现有代码库结构和已落地的车道 A/C 代码。
Let me read the key existing files to understand the architecture.
Now let me check the SqliteStore for the identity-related methods, the redis keys, and the existing test fixtures.
Let me check the v2-identity types, the outbox module, and the plan doc for the state machine details.
I now have a thorough understanding of the codebase. This is a substantial implementation task — I'll break it into subtasks and work through them systematically.
Now I'll implement the services. Let me start with the ProjectService and NodeService.
I need to fix the ProjectModeTransitionRow usage. Let me update the project-service and then create the node-service.
Now let me add the V2 route registration line in http.ts.
I need to add SqliteStore support to http.ts. Let me check how it's created elsewhere.
Build succeeded. Now let me write the tests.
Now let me write the e2e test with real HTTP requests.
The glob matching is exact string comparison. Let me fix the test.
Ownership tests pass. Now let me run the e2e test.
I need to fix the V2 route registration to be inside the `apiRoutes` closure so auth hooks apply. Let me also check why the DELETE test fails.
I need to move the V2 registration inside the `apiRoutes` closure so auth applies. Let me fix this.
Found two issues:
1. `BIAO_V2_CREDENTIAL_KEY` env var not set — need to pass keys through options
2. DELETE with empty body + Content-Type causes Fastify error

Let me fix both.
All 21 e2e tests pass. Now let me run the full distributed test suite to verify no regressions.
All 190 tests pass across 14 test files. Let me verify the build.
## 交付总结

### 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/server/v2/project-service.ts` | 新增 | ProjectService 最小实现（create/get/list/modeTransition） |
| `src/server/v2/node-service.ts` | 新增 | NodeService 最小实现（enroll/register/heartbeat/drain/offline/revoke/authorize） |
| `src/server/v2/ownership-v2.ts` | 新增 | Ownership V2 snapshot 写入/校验函数 |
| `src/server/v2/routes/v2-routes.ts` | 新增 | V2 路由插件（Project/Node/Attempt 等全量路由声明） |
| `src/server/http.ts` | 修改 | 添加 SqliteStore 参数 + V2 路由装配（apiRoutes 闭包内，继承鉴权） |
| `src/server/main.ts` | 修改 | 传递 SqliteStore 给 createHttpServer |
| `tests/distributed/p1-ownership-v2.test.ts` | 新增 | Ownership snapshot 单测（10 用例） |
| `tests/distributed/p1-e2e-identity.test.ts` | 新增 | 端到端验收测试（21 用例，真实 HTTP） |

### 验证结果

- `npm run build:server` — 通过
- `npx vitest run tests/distributed/` — **190 测试全绿**（14 文件，含既有 169 用例 + 新增 21 用例）

### 端到端验收场景

1. **两台 Node → 同一 Project**：enroll→authorize→heartbeat 全链路通过，两节点绑定到同一 project_id
2. **Generation fencing**：连续 register 产生 session generation 1→2，旧 generation session 自动 fence
3. **撤销授权**：DELETE authorization 后 binding 状态变 revoked + write_credential_status=suspended，重新 authorize 可恢复
4. **V1 隔离门**：无鉴权请求返回 401（crossCuttingApiPlugin 拦截）
5. **Attempt Token 纯函数**：签发→校验往返、scope 越权拒绝、generation fencing 全覆盖

### 路由清单（method/path/凭据作用域）

| 方法 | 路径 | 凭据 | 状态 |
|------|------|------|------|
| POST | /v2/projects | human_owner | 实现 |
| GET | /v2/projects | human_owner | 实现 |
| GET | /v2/projects/:id | human_owner | 实现 |
| POST | /v2/projects/:id/mode-transitions | human_owner | 实现 |
| GET | /v2/projects/:id/mode-transitions/:tid | human_owner | 实现 |
| POST | /v2/nodes/enroll | node (enrollment_ticket) | 实现 |
| POST | /v2/nodes/register | node (verifyNodeCredential) | 实现 |
| POST | /v2/nodes/:id/heartbeat | node (verifyNodeCredential) | 实现 |
| POST | /v2/nodes/:id/drain | human_owner | 实现 |
| POST | /v2/nodes/:id/offline | node/human_owner | 实现 |
| POST | /v2/nodes/:id/revoke | human_owner | 实现 |
| POST | /v2/projects/:pid/nodes/:nid/authorize | human_owner | 实现 |
| DELETE | /v2/projects/:pid/nodes/:nid/authorization | human_owner | 实现 |
| GET | /v2/nodes | human_owner | 实现 |
| 其余 Attempt/Delivery/Merge/Incident/Reconcile 路由 | — | — | stub (Phase 2+) |

### A/C 接口缺口清单

无回改。A/C 车道接口完整可用：
- SqliteStore 六表 CRUD + generation fencing 查询 — 完整
- credentials.ts 签发/校验 — 完整
- v1-isolation.ts 隔离门 — 完整

### 残留风险

1. **Ownership V2 未接线 claim 侧**（Phase 4 范围）：当前 snapshot 函数为内存实现，Phase 4 需接入 Redis/SQLite
2. **Attempt/Delivery/Merge/Incident/Reconcile 服务未实现**：路由声明已就位，handler 为 stub
3. **Node 凭据 HTTP 鉴权**：当前 V2 路由统一走 owner bearer 鉴权；Node credential 的 HTTP 层自动验证需 Phase 2 接入