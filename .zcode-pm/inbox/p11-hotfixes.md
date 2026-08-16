# P11：跨机联调热修复（4 项高优先级 + 4 项中优先级）

## 背景

今天跨机联调实际踩到的坑 + 审计部分覆盖可升级项。全量基线 **134 文件/1676 用例全绿**。

## 目标（按优先级）

### 🔴 高优先级（跨机正常使用的障碍）

**1. V2/V1 任务队列桥接**
- 问题：V2 claim 按 `project_id` 查 `tasks.project_id` 列，V1 plan/create 的任务没有填此列 → Worker 领不到
- 修复：`src/server/v2/routes/v2-routes.ts` 的 claim 路由——当 `project_id` 查不到任务时，回退查 V1 pending 队列（按 `preferred_plan_ids` 或全部 pending），找到后自动关联 project_id（写入 `tasks.project_id`）
- 测试：V1 创建任务 → V2 claim（无 project_id）→ 能领到 → tasks.project_id 被回填

**2. V1 读面接受 bvn2**
- 问题：`/tasks?status=pending` 只接受 owner token → Worker 被迫用 owner token
- 修复：`src/server/http-plugins.ts` 的 onRequest——`Bearer bvn2_` 前缀对 V1 **只读面**（GET /tasks、GET /task/:id、GET /plans、GET /plan/:id、GET /status、GET /health）放行（不写 mutation）
- 测试：bvn2 token GET /tasks 200、GET /task/:id 200；POST /plan/submit 仍 401

**3. bva2 scope 双接受（已修代码，确认在源码里）**
- 已在本地修复（report 同时接受 claim 和 report scope），确认代码在且测试覆盖

**4. NAS compose 配置持久化**
- 问题：每次代码更新重新 build，compose 文件被覆盖，WORKSPACE_ROOTS 丢失
- 修复：`deploy/nas/Dockerfile` 的 ENV 段加 `BIAO_WORKSPACE_ROOTS=/data/workspaces`（写死在镜像里，不依赖 compose env）

### 🟡 中优先级（审计升级）

**5. V1 plan/question mutation 对 V2 隔离测试**
- 现有：`v1-isolation.ts` 有 V1_PLAN_QUESTION_GUARDED_PATHS 实现
- 缺：生成式测试（对每个 V1 mutation 路由×V2 项目断言 403）
- 新增：`tests/distributed/p11-v1-isolation.test.ts`

**6. handleRefAclMiss 生产接线**
- 现有：`src/server/v2/git/ref-acl.ts` 有 `executeRefAclMissCircuitBreaker`（完整实现）
- 缺：workspace.ts push_forbidden 分支调用它
- 修复：在 `workspace.ts` 的 push catch 中加一行调用

**7. marker 轮换测试**
- 测试：签发 marker（key v1）→ 轮换到 key v2 → v1 签的 marker 仍可验签（audit 期内）→ v0 签的拒绝

**8. outbox stall degraded + revision 重放**
- 现有：detectStalledOutbox + markOutboxDegraded + replayOutboxByRevision（深化轮 F 交付）
- 缺：测试驱动 stall → degraded → 按 revision 重放 → 恢复

## 约束

- 全程中文；**所有权**：`src/server/v2/routes/v2-routes.ts`（claim 桥接）、`src/server/http-plugins.ts`（bvn2 读面）、`src/server/v2/git/workspace.ts`（熔断接线）、`deploy/nas/Dockerfile`（ENV）、`src/server/v2/git/marker.ts`（如需辅助导出）、`tests/distributed/p11-*.test.ts`
- **不得改**：`src/server/service.ts`、`src/server/http.ts`（只 import）、`src/server/v2/project-service.ts`、`src/node/**`、`src/mcp/**`、`web/`
- 四条验证原始输出随交付

## 验收标准

1. 构建 + `npx vitest run tests/distributed/p11-*.test.ts` 全绿
2. 全量不劣化 134/1676 基线
3. 跨机桥接实测：V1 创建任务 → V2 claim（无 project_id）→ 领到 → report → 状态变更
