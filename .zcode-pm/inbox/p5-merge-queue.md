# Phase 5：Merge Queue（单项目串行队列 + 默认分支 CAS）

## 前置状态

Phase 4 已验收：GitProvider/generic-git、Prepare/Finalize 状态机、signed marker、deliveries 007 表（含 pending_review 等状态）、服务端独立 diff 门禁、BranchCleanup。merge_jobs/external_merge_intents 表已在 003 落地（最小字段）。全量基线 **115 文件 / 1303 用例**（唯一已知 flaky：supervisor-pm-agent-cli，单独复跑恒绿）。

先读：方案 §12 全部（12.1 权限边界含 full→read-only 降级与恢复、12.2 合并顺序、12.3 冲突策略、12.4 依赖何时解锁）、§5.2（Delivery 与 Merge 分离）、§4.7（MergeJob 模型）、§15.5（API）、§21 Phase 5 原文、§20.3 相关约束（同 project 唯一 running Merge Job、merge_jobs(delivery_id, expected_target_sha) 唯一）。

## 目标

1. **串行队列** `src/server/v2/merge/queue.ts`：同 project 同时最多一个 running merge job（唯一约束 + 入队 CAS）；队列顺序按 §12.2（accepted delivery 的时间与依赖拓扑；依赖未解锁不入队头）；`enqueue(acceptedDelivery)` → `dispatch`（取队头创建 merge_jobs 行，expected_target_sha=当前默认分支 HEAD）。
2. **默认分支 CAS**：merge 执行前 ls-remote 校验 HEAD==expected_target_sha；不符→ job `invalidated`、delivery 回 `invalidated`、下游重新排队（R1A-005：CAS 失败终止旧 job，rebase 生成新 delivery 由 PM 流程决定，本阶段只失效+审计）。
3. **Integration workspace**（复用 Phase 4 Prepare 语义）：`merge/<job-id>` 一次性工作区——fetch 默认分支 + delivery 分支 → merge --no-ff（或 §12.2 指定策略）→ 冲突检测：
   - 无冲突 → 服务端独立 diff 复核（§7.3 复用于合并结果）→ push 默认分支（non-fast-forward 天然 CAS）→ job `merged` → **下游解锁**（依赖该 delivery 的下游 accepted delivery 依 §12.4 变为可入队）→ BranchCleanup 排程 delivery 分支清理；
   - 冲突 → job `integration_failed` + 冲突文件清单入审计（保持可审计，§21 验收原文），**默认分支不动**；delivery 保持 accepted 可重新交付（新 delivery 流程走 Phase 4）。
4. **full→read-only 降级与恢复**（§12.1.1/12.1.2 最小版）：merge 连续失败 N 次（默认 3）→ project `write_capability_status=degraded_read_only` + 新 claim 拒绝；人工恢复路由（owner）：确认根因后恢复 full（审计记录原因）。
5. **external_merge_intents 最小记录**：V2 API 允许登记外部合并意图（provider_actor/approved_by/reason），状态机 pending→resolved/superseded；本阶段只登记+审计，不执行外部 API。
6. **路由**：`POST /v2/projects/:id/merge-jobs`（owner，enqueue）、`GET /v2/projects/:id/merge-jobs`（队列视图）、`POST /v2/merge-jobs/:id/retry`（integration_failed 重试=新 job）、`POST /v2/projects/:id/write-capability/restore`；registry 声明齐全。
7. **失败优先测试** `tests/distributed/p5-merge-queue.test.ts`（真实 git + bare remote，延续 p4 自建临时 bare 风格）：
   - **无冲突自动合并**（两 delivery 串行 merge，默认分支前进、两次 merge commit 可追溯）；
   - **真实冲突保持可审计**（两 delivery 改同一行→第二个 integration_failed+冲突清单落审计，默认分支 HEAD 不变）；
   - **失败不更新主分支**（push 前注入失败→默认分支字节级不变）；
   - CAS：merge 执行前外部推进默认分支→job invalidated→重新排队成功；
   - 串行性：并发 enqueue 两 delivery→仅一个 running（唯一约束实证）；
   - 依赖解锁：A merge 后依赖 A 的 B 才可入队（§12.4）；
   - 降级/恢复：连续 3 次 integration_failed→degraded_read_only→新 claim 拒→restore→恢复；
   - external intent 登记/审计。
8. runbook `docs/runbooks/merge-queue.md`（中文）：队列语义、CAS 与 invalidated 生命周期、降级阈值与恢复流程、与 BranchCleanup 的衔接。

## 约束

- 全程中文；**所有权**：`src/server/v2/merge/**`、`src/server/v2/routes/**`（merge 组）、`src/server/v2/delivery-service.ts`（解锁/失效衔接，最小改动）、`src/db/**`（如需 008 扩展 merge_jobs 列/索引）、`src/types/**`（v2 追加）、`tests/distributed/p5-*.test.ts`、受影响版本期望（链条连续性断言风格）、runbook。**不得改**：`src/server/v2/git/workspace.ts`（只 import；缺能力在交付说明列缺口）、`src/node/**`、`src/server/service.ts`、`src/server/http-plugins.ts`、`src/mcp/**`、`web/`、既有 fixture。
- git 子进程安全约束沿用 Phase 4 provider；不新增依赖/env 变量；不启动生产栈。
- 门禁：构建 + 全量不劣化 115/1303 基线（known flaky 单独复跑）。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿；全量复跑不劣化。
2. §21 Phase 5 验收原文三项逐项测试路径 + §12 各小节对照表。
3. 交付说明：队列状态机图、CAS 失效→重排队生命周期、降级/恢复参数、对 workspace 层的接口缺口（如有）。
