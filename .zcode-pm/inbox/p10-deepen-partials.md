# 深化轮 F：三项可自主完成的部分覆盖缺口收口

## 背景

审计终版 67 已覆盖/25 部分/7 未覆盖。NAS 119 部署已验收。本车道处理验证器点名的三项可自主完成缺口。全量基线 **132 文件/1646 用例**。

先读：`docs/distributed-multi-node-acceptance-audit.md` 中这三项的缺口描述与证据现状。

## 目标

### 1. 22.1-10：V2 Delivery rejected 后 repair/reverify 实装

缺口：`src/server/v2/delivery-service.ts:300` 仅注释、V1 有 14 用例基线可参照。

- 实现 `repairDelivery`（rejected→生成 repair task attempt，继承 ownership+verify，排除原验收者）与 `reverifyDelivery`（只重验证据，不改来源实现——对齐 V1 `--reverify-only` 语义）；
- 路由：`POST /v2/deliveries/:id/repair` / `POST /v2/deliveries/:id/reverify`（owner 或 project_admin）；
- 测试：rejected→repair→新 attempt 继承约束（ownership/verify/排除原验收者）→ 完成链路→merged；reverify 幂等（重复请求回放同一 reverify delivery）。

### 2. 22.4-18：outbox stall 检测 + degraded + 按 revision 重放

缺口：`src/server/v2/outbox.ts` 无 stall 检测/degraded 状态/按 aggregate_revision 重放；`alert-scheduler` 存在但 outbox 组件没有这些能力。

- `src/server/v2/outbox.ts` 增加：`detectStalledOutbox(store, threshold)`——next_attempt_at 超阈值仍在 pending → 返回 stalled 清单；`markOutboxDegraded(store, eventId, reason)`；`replayOutboxByRevision(store, aggregateType, aggregateId, fromRevision)`——按 revision 顺序幂等重放（不跳号、不重复）；
- alert 规则已在 metrics.ts（车道 E）——把 stall 检测结果接入告警规则输入（不改 metrics.ts，只提供数据源接口或直接在 alert-scheduler 中调用——alert-scheduler 是车道 E 文件，不改，改为在 outbox.ts 导出 `collectStalledOutboxStats(store)` 供未来接线）；
- 测试：制造 stall（clock 注入超阈值）→ 检测命中；degraded 标记+查询；revision 重放——跳过已成功的 revision、失败的重试到成功、幂等（重放两次不产生重复副作用）。

### 3. 22.3-17：handleRefAclMiss 接线调用方 + 测试

缺口：`src/server/v2/merge/queue.ts:426-468` handleRefAclMiss 实现完整（fencing 全部 executing attempt + lost + incident），但无调用方、无测试。

- **接线**：在 generic-git push 被拒 `push-forbidden` 时触发——`src/server/v2/git/workspace.ts` 的 finalize push catch 已有 `failed:push_forbidden` 终态分支（微车道交付），在此分支加调用 `handleRefAclMiss(projectId, reason)`（需把 handleRefAclMiss 从 queue.ts 导出，或挪到 `src/server/v2/git/ref-acl.ts` 更合适——挪时注意 queue.ts 已有 import 的回归）；
- **测试**（真实 git + bare remote）：连续 3 次 push-forbidden → fencing 该 project 全部 executing attempt（状态→fenced）+ write_capability_status→lost + incident 开单；第 2 次不重复 fencing（幂等）。

## 约束

- 全程中文；**所有权**：`src/server/v2/delivery-service.ts`（repair/reverify 新增）、`src/server/v2/outbox.ts`（stall/degraded/replay 新增）、`src/server/v2/git/workspace.ts`（接线一行）、`src/server/v2/git/ref-acl.ts`（handleRefAclMiss 迁入或导出辅助）、`src/server/v2/merge/queue.ts`（仅导出/迁移所需的最小改动）、`src/server/v2/routes/v2-routes.ts`（新路由 2 条）、`src/db/sqlite-store.ts`（只增方法）、`src/types/**`（v2 追加）、`tests/distributed/p10-*.test.ts`。**不得改**：`src/server/v2/project-service.ts`、`src/server/v2/recovery-decision.ts`、`src/server/v2/metrics.ts`、`src/server/v2/incident-service.ts`、`src/server/v2/alert-scheduler.ts`（只调用/导出数据源）、`src/server/service.ts`、`src/node/**`、`src/mcp/**`、`web/`、既有 fixture。
- 四条验证原始输出随交付；测试 env save/restore 纪律。
- 门禁：构建 + 全量不劣化 132/1646 基线。

## 验收标准

1. 三项逐条测试路径（22.1-10 至少 4 用例、22.4-18 至少 4 用例、22.3-17 至少 3 用例）。
2. 交付说明：三项改动点清单、handleRefAclMiss 迁移理由、stall 阈值默认值与 env 可调名、四条验证原始输出。
