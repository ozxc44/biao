# Lane A 交付说明

## 变更文件清单

### 新文件（4 个）
1. **`src/server/v2/git/ref-acl.ts`** — generic-git ref ACL 规则引擎（22.3-10/17）
   - `RefAclRule` / `ProjectRefAcl` 接口
   - `checkRefAcl()` — allow/deny 规则匹配，deny 优先
   - `createDefaultRefAcl()` — 默认规则集（biao attempt 分支允许，默认分支/tag/他人 branch 禁止）
   - `RefAclMissTracker` — 连续丢失计数器（阈值 N=3）

2. **`src/server/v2/plan-import.ts`** — importPlan + EvidenceAcceptance（22.3-13/14/15）
   - `isProjectReadOnly()` — read-only 判定（execution_mode / write_capability_status）
   - `importPlanForProject()` — read-only 项目拒绝写任务并逐条列出；full 项目正常导入
   - `createEvidenceAcceptanceForTask()` — Artifact-only 任务证据验收

3. **`src/server/v2/v1-route-classification.ts`** — V1 路由显式分类（22.2-13/14）
   - 四类：legacy_lifecycle / pm_transport / maintenance / read_only
   - `classifyV1Route()` / `getUnclassifiedMutationRoutes()` — 构建期门禁

4. **`src/db/migrations/012_evidence_acceptances.ts`** — 数据库迁移
   - `evidence_acceptances` 表
   - `projects.ref_acl_json` / `projects.ref_acl_miss_count` 扩展列

5. **`tests/distributed/p9-access.test.ts`** — 38 个测试用例

### 修改文件（8 个）
1. **`src/server/v2/credentials.ts`** — 新增 bvm2 Merge Bot 凭据
   - `MERGE_BOT_TOKEN_SCOPES` / `MergeBotTokenScope`
   - `MergeBotTokenClaims` / `MergeBotTokenExpectation`
   - `issueMergeBotToken()` / `verifyMergeBotToken()`
   - `MERGE_BOT_TOKEN_DEFAULT_TTL_SECONDS = 3600`

2. **`src/server/v2/rbac.ts`** — bvm2 凭据分类 + merge_bot 作用域判定
   - `V2RequestCredential` 新增 `merge_bot` kind
   - bvm2_ token 验证 + project 绑定检查
   - merge_bot 跨项目拒绝

3. **`src/server/v2/routes/registry.ts`** — merge_bot 策略 + merge 路由扩展
   - `V2RouteCredentialPolicy` 新增 `merge_bot: boolean`
   - merge 相关路由（create/dispatch/retry/get/list）credentialScopes 加入 `merge_bot`

4. **`src/server/v2/git/provider.ts`** — `remote-unreachable` 错误类别
5. **`src/server/v2/git/generic-git.ts`** — remote_unreachable 检测模式
6. **`src/server/v2/merge/queue.ts`** — remote_unreachable incident + ref ACL 熔断 + external merge 回写
7. **`src/server/v2/v1-isolation.ts`** — V1 plan/question mutation 隔离路由
8. **`src/db/migrate.ts`** — 注册 migration 012
9. **`src/db/sqlite-store.ts`** — evidence_acceptances CRUD + listTaskAttemptsByProject
10. **`src/server/v2/routes/v2-routes.ts`** — importPlan / evidence-acceptances 路由实现

## 逐项验收路径

| # | 审计编号 | 验收路径 |
|---|---------|---------|
| 1 | 22.3-04 | p9-access.test.ts: `bvm2 Merge Bot 凭据` 组（签发/验证/project 绑定/key_version 轮换） |
| 2 | 22.3-10 | p9-access.test.ts: `generic-git ref ACL` 组 + `ref ACL 拒绝矩阵` 组 |
| 3 | 22.3-13 | p9-access.test.ts: `read-only 门禁` 组 |
| 4 | 22.3-14 | p9-access.test.ts: `importPlan read-only 拒绝` 组 |
| 5 | 22.3-15 | plan-import.ts: `createEvidenceAcceptanceForTask()` |
| 6 | 22.3-17 | p9-access.test.ts: `ref ACL 连续丢失熔断` 组 |
| 7 | 22.2-13/14 | p9-access.test.ts: `V1 路由分类门禁` 组 + v1-isolation.ts 扩展 |
| 8 | 22.4-09 | p9-access.test.ts: `Git Remote 不可用` 组 + provider.ts `remote-unreachable` |
| 9 | 22.4-24 | merge/queue.ts: `writebackExternalMerge()` |
| 10 | 22.4-38 | merge/queue.ts: `detectUndocumentedShas()` |
| 11 | 测试 | p9-access.test.ts: 38 用例全通过 |

## ACL 规则语法

ref ACL 使用 glob 风格匹配：
- `*` — 匹配单段（不含 `/`）
- `**` — 匹配多段（含 `/`）
- `?` — 匹配单字符
- deny 优先于 allow
- 未匹配任何 allow 规则 → 默认拒绝

默认规则集：
```
allow: refs/heads/biao/attempt/*, refs/biao/attempt-markers/**
deny:  refs/heads/<default_branch>, refs/tags/**, refs/heads/main, refs/heads/master
```

## read-only 门禁触发面清单

| 条件 | write_capability_status | 门禁效果 |
|------|------------------------|---------|
| execution_mode = read-only-acceptance | any | claim/交付写路径拒绝，读/验收只读放行 |
| 无 ref ACL（连续 N 次确认丢失） | → lost | fencing running write attempt + 撤销 credential |
| integration_failed 连续 ≥3 | → lost | merge 阻止 |
| write_capability_status = disabled | disabled | 全写路径拒绝 |

## importPlan 语义（read-only 拒绝响应示例）

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "READ_ONLY_PROJECT_REJECTS_WRITE_TASKS",
    "message": "项目 proj-xxx 为 read-only 模式，拒绝 2 个写任务",
    "rejected_tasks": [
      {"task_id": "task-1", "reason": "writable=true 不允许在 read-only 项目导入"},
      {"task_id": "task-3", "reason": "依赖写任务 task-1"}
    ]
  }
}
```

## 接口缺口说明

| 接口 | 当前状态 | 缺口 |
|------|---------|------|
| IncidentService.createIncident | ✅ 已实现 | merge/queue.ts 直接调用 |
| unlockDownstream | ⚠️ 占位 | 仅查找 queued jobs，未查 task depends_on 拓扑 |
| detectUndocumentedShas | ⚠️ 占位 | 需异步 ls-remote，当前返回空集 |

## 验证原始输出

- TypeScript 编译：`npx tsc --noEmit` — 无错误
- p9-access 测试：38/38 通过
- 全量测试：126 文件 / 1533 用例全部通过（基线 122/1479 → 126/1533，+4 文件 +54 用例）
