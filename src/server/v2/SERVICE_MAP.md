# SERVICE_MAP —— service.ts 函数 ↔ 七个领域服务归属台账

> Phase 0a-2（车道 C）交付物。依据主方案 `docs/distributed-multi-node-development-plan.md`
> §21 Phase 0a-2、§27 文档与代码文件映射（Review/repair 属 Delivery，Question 属
> Attempt，Incident 归 IncidentService）。
>
> 用途：`src/server/service.ts`（约 1.43 万行）是 V1 全量逻辑的单体 facade。本台账把
> 它导出的 **58 个函数** 按七个领域服务归类，作为 Phase 1+ 分批搬迁到
> `src/server/services/{projects,nodes,attempts,deliveries,merge,incidents,reconcile}.ts`
> 的依据；搬迁完成后旧 service.ts 只保留 re-export 兼容层（先例：`maintenance.ts`）。
>
> 目标接口契约见 `src/server/v2/domain-interfaces.ts`（只定义接口，不搬实现）。
> 分类覆盖由脚本校验：58/58 全覆盖、无重复、无遗漏（2026-08-16 核对）。

## 统计

| 服务 | V1 对照函数数 | 说明 |
| --- | ---: | --- |
| ProjectService | 15 | Project/Binding/Plan 导入与 plan 级退出 |
| NodeService | 5 | Agent（≈V2 Node）生命周期 + 执行回执 |
| AttemptService | 17 | claim/lease/report/Question/block/ownership/任务读写 |
| DeliveryService | 7 | Review/resolution/repair/reverify 及其副作用回放 |
| MergeService | 0 | V2 新增（V1 无合并队列实现） |
| IncidentService | 0 | V2 新增（V1 的 watchdog problems 是只读前身，归 Reconcile） |
| ReconcileService | 15（+9 个 maintenance.ts re-export） | 对账/巡检/恢复/事件与 intake 投影读面 |
| 合计 | 58 | service.ts 直接导出的 async function 全量 |

另有基础设施项不计入七服务：`STALE_AGENT_THRESHOLD_MS` 常量（Attempt/Reconcile 共用
口径）、导出的请求/响应 interface（随所属函数一起搬迁）。

## ProjectService（Project / Binding / Plan 导入）

V1 以 `project_scope`（绝对路径）作项目身份；V2 改为 `project_id` 注册表 + 显式
legacy binding（D-002/D-026）。Plan 导入从"服务端读本地 plan_dir"改为上传
Plan Snapshot（D-014）。

| V1 函数 | V2 接口方法（domain-interfaces.ts） | 备注 |
| --- | --- | --- |
| `planCreate` | `ProjectService.importPlan` | V2 走 snapshot 上传 |
| `planTaskUpsert` | `ProjectService.importPlan` | 结构化单任务 upsert（写 MD 后走 planSubmit 权威路径）；V2 走 snapshot 上传 |
| `previewPlanSubmission` | `ProjectService.validateProject` | 路径校验部分 |
| `planSubmit` | `ProjectService.importPlan` | durable-first + outbox |
| `getPlan` | `ProjectService.getProject`（plan 读面并入项目读面） | |
| `getPlans` | `ProjectService.listProjects` | |
| `previewPlanSupersede` | `ProjectService.previewPlanSupersede` | preview token CAS 保留 |
| `supersedePlan` | `ProjectService.supersedePlan` | |
| `createProjectAgentBinding` | `ProjectService.createBinding` | 入参改 project_id |
| `getProjectAgentBinding` | `ProjectService.getBinding` | |
| `listProjectAgentBindings` | `ProjectService.listBindings` | |
| `deleteProjectAgentBinding` | `ProjectService.deleteBinding` | |
| `connectProjectAgent` | `ProjectService.connectAgent` | 校验 NodeProjectBinding（D-031） |
| `getProjectAgentRoster` | `ProjectService.getRoster` | |
| `reserveProjectAgentTask` | `ProjectService.reserveTask` | durable-first |

## NodeService（Node 生命周期 + 执行回执）

V1 的 agent（agent_id + registration_id）演进为 V2 Node（node_id +
credential_generation），quarantine 等同安全撤权并立即 fencing（D-037）。

| V1 函数 | V2 接口方法 | 备注 |
| --- | --- | --- |
| `agentRegister` | `NodeService.enroll` + `NodeService.register` | V2 拆成两步；不再共用全局 Worker token |
| `agentHeartbeat` | `NodeService.heartbeat` | 心跳承载 §10.3 全量内容 |
| `agentOffline` | `NodeService.offline` | 幂等语义保留 |
| `appendExecutionReceipt` | `NodeService.appendExecutionReceipt` | 回执绑定 node_session_generation |
| `listExecutionReceipts` | `NodeService.listExecutionReceipts` | |

## AttemptService（claim / lease / Question / 任务生命周期 / Ownership）

> **第一批已迁移（P12 车道 B，2026-08-16）**：本节 17 个函数的实现已迁至
> `src/server/v2/attempt-service.ts`，service.ts 以
> `export { ... } from './v2/attempt-service.js'` 保留兼容 re-export（零破坏）。
> 迁移随行的私有助手（claim 预约/Question CAS/supersede 批提交/block-resume
> 重排队/task 列表投影等 ~47 项）一并迁出；service.ts 剩余函数仍引用的 12 项
> 由 facade 引回。跨域私有助手（repair lineage / review doorbell / intake 投影
> 读取等 37 函数 + 3 常量/接口）为供 attempt-service 引用临时加 export，见文末
> 「SharedSupportService（迁移期）」小节——后续批次随所属域迁出后回收。

V2 核心差异：Task 与 Attempt 分离（§5.1），claim 签发短期 Attempt Token，renew/
question/artifact/delivery 全部校验 attempt_generation + node_session_generation
（§13.5）；ownership 按 project 命名空间（D-011）且活跃 Attempt 不被盲目 preempt
（D-012）。

| V1 函数 | V2 接口方法 | 备注 |
| --- | --- | --- |
| `claim` | `AttemptService.claimTask` | 返回 attempt_generation + attempt_token |
| `report` | `AttemptService.reportAttempt` | Artifact 引用替代 result_path（D-005） |
| `renewLease` | `AttemptService.renewLease` | fencing；lease 风险截止前停 Agent（D-013） |
| `createQuestion` | `AttemptService.askQuestion` | |
| `listQuestions` | `AttemptService.listQuestions` | cursor 分页 |
| `getQuestion` | `AttemptService.getQuestion` | HTTP 面强制 consumer 归属保留 |
| `answerQuestion` | `AttemptService.answerQuestion` | 重领签发新 Attempt Token |
| `taskBlock` | `AttemptService.blockTask` | |
| `taskResume` | `AttemptService.resumeTask` | |
| `ownershipCheck` | `AttemptService.checkOwnership` | |
| `ownershipDeclare` | `AttemptService.declareOwnership` | project 命名空间 |
| `ownershipRelease` | `AttemptService.releaseOwnership` | |
| `getTask` | `AttemptService.getTask` | |
| `getTasks` | `AttemptService.listTasks` | |
| `getPendingReviewTasks` | `AttemptService.listTasks`（status 过滤） | 读面收敛 |
| `supersedeTask` | `AttemptService.supersedeTask` | |
| `cancelTask` | `AttemptService.cancelTask` | |

## DeliveryService（Artifact / Delivery / Review / repair / reverify）

V2 新增 Artifact 三段式上传与 Delivery 实体；V1 的 pmReview/resolution/reset 族是
Review/repair 前身，语义保留但落到 Delivery 状态机（D-006/D-008）。

| V1 函数 | V2 接口方法 | 备注 |
| --- | --- | --- |
| `pmReview` | `DeliveryService.reviewDelivery` | reject 生成 repair 语义保留 |
| `getReviewInfo` | `DeliveryService.getReviewEvidence` | 证据改从 Artifact/Remote 重算（D-027） |
| `getResolutionDecision` | `DeliveryService.getResolutionDecision` | |
| `resolutionDecision` | `DeliveryService.decideResolution` | inspect/continue/cancel 保留 |
| `taskReset` | `DeliveryService.resetTask` | repair 域原语 |
| `replayAcceptedRepairSideEffects` | `DeliveryService`（内部，无 HTTP 面） | repair 副作用回放 |
| `reconcileResolutionBacklog` | `DeliveryService`（内部，无 HTTP 面） | resolution 积压对账 |

## MergeService（Merge Queue / external intent）

V1 无对应实现，Phase 5 新增。硬边界：Merge Bot 单写默认分支（D-007）、
`delivery_id + expected_target_sha` 唯一（§14.5）、branch HEAD 与 target CAS
双校验（D-028）、merged 才解锁下游（D-023）。

## IncidentService（Incident / SLO）

V1 无对应实现。watchdog 的 problems 汇总是只读前身（归 ReconcileService），
Incident 作为持久领域实体（D-033）承担 ack/SLO/解除审计。

## ReconcileService（outbox / restore / orphan / ownership / 投影读面）

V2 新增 outbox dispatcher 与 dead-letter 处置（D-025/D-045）；restore 升级为
restore point 水印编排（D-029/§14.6）；V1 的事件/intake/conflicts/ownership
投影读面与巡检对账归入本服务。

| V1 函数 | V2 接口方法 | 备注 |
| --- | --- | --- |
| `reconcileRuntimeState` | `ReconcileService.reconcileRuntimeState` | durable revision 驱动重放 |
| `runWatchdog` | `ReconcileService.runWatchdog` | 巡检产出 Incident 而非一次性响应 |
| `dbRestore` | `ReconcileService.restoreFromPoint`（内部实现） | 自动恢复路径 |
| `dbRestoreManual` | `ReconcileService.restoreFromPoint` | 手动恢复入口 |
| `getDbStatus` | `ReconcileService.getRestoreGate`（诊断面） | |
| `getEvents` | `ReconcileService.listEvents` | cursor 语义保留 |
| `unackedEvents` | `ReconcileService.listUnackedEvents` | consumer 投影读 |
| `ackEvent` | `ReconcileService.ackEvent` | consumer 投影写 |
| `pmIntake` | `ReconcileService.getIntake` | PM 门铃汇总 |
| `getConflicts` | `ReconcileService.getConflicts` | ownership 冲突历史 |
| `getActiveOwnership` | `ReconcileService.getActiveOwnership` | |
| `getStatus` | `ReconcileService`（运维聚合读面） | 跨域聚合，保留为聚合读 |
| `supervisorTick` | `ReconcileService`（运维聚合读面） | plans+intake+events+reconcile 聚合 |
| `setSqliteStore` | （组合根基础设施，不进接口） | DI 注入 |
| `getSqliteStore` | （组合根基础设施，不进接口） | DI 读取 |

## SharedSupportService（迁移期：service.ts 内跨域私有助手加 export 供 attempt-service 引用）

AttemptService 第一批迁移的伴生变更：下列 service.ts 私有助手被
`src/server/v2/attempt-service.ts` 引用而临时加 `export`。它们不是 V1 facade 的
API 面（不在 58 函数台账内），计入本节仅为让同步门禁显式跟踪这批过渡导出；
后续批次（Delivery/Reconcile/NodeService 迁移）随所属域迁出后，此节清空。

| 函数 | 归属去向 | 备注 |
| --- | --- | --- |
| `configuredWorkspaceRoots` | ProjectService | env 工作区根解析 |
| `normalizePmConsumer` | ReconcileService | PM consumer 归一化 |
| `projectAgentReservationKey` | ProjectService | reservation key 拼接 |
| `publicBinding` | ProjectService | binding 行投影 |
| `persistTaskFromRedis` | ReconcileService | Redis→SQLite 耐久副本 |
| `withMutationPermit` | ReconcileService | 全局 mutation permit |
| `acquireMutationSection` | ReconcileService | claim/report 提交段 |
| `withAgentEpochCommit` | NodeService | agent epoch 提交互斥（共享 Map 状态在 service.ts） |
| `durableAgentEpochIsCurrent` | NodeService | epoch 持久水位校验 |
| `isDependencySatisfied` | AttemptService | 依赖满足判定 |
| `checkDependencies` | AttemptService | 依赖检查 |
| `summarizeVerifyFailures` | AttemptService | report 验收摘要 |
| `failureReasonForReport` | AttemptService | report 失败原因 |
| `normalizeRepairOwnership` | DeliveryService | repair ownership 归一 |
| `splitOwnership` | AttemptService | ownership 列表拆分 |
| `ownershipUnion` | AttemptService | ownership 并集 |
| `parseRepairOwnershipAudit` | DeliveryService | repair ownership 审计解析 |
| `markResolutionNeedsPmDecision` | DeliveryService | resolution 积压标记 |
| `ensureRepairTask` | DeliveryService | repair 任务派生 |
| `terminalizeSupersededPendingRepair` | DeliveryService | superseded repair 终态化 |
| `markRepairAwaitingReview` | DeliveryService | repair 待审标记 |
| `acceptanceSourceIds` | DeliveryService | 验收来源 ID |
| `acceptanceReviewerConflictTask` | AttemptService | 领取阶段自验收冲突 |
| `markAcceptanceFailureResolution` | DeliveryService | 验收失败 resolution |
| `resolvePmConsumer` | ReconcileService | plan→consumer 解析 |
| `finalizeReclaimedTasks` | ReconcileService | 回收任务收口 |
| `acquirePmReviewLock` | DeliveryService | PM 决策锁 |
| `runWithPmDecisionLockCleanup` | DeliveryService | 决策锁清理包装 |
| `pendingMember` | ReconcileService | intake pending 成员拼接 |
| `parseIndexedPendingEvent` | ReconcileService | pending 事件解析 |
| `isUnreviewedDoneTask` | ReconcileService | 未复核 done 判定 |
| `removeStalePendingReviews` | ReconcileService | 陈旧 pending review 清理 |
| `ensureLegacyReviewIndexes` | ReconcileService | 旧复核索引补建 |
| `readConsumerPending` | ReconcileService | consumer pending 读取 |
| `findEventForAck` | ReconcileService | ack 事件定位 |
| `scanKeys` | ReconcileService | SCAN 封装 |
| `getGitHeadSha` | AttemptService | git HEAD 读取（ownership base） |

另有非函数导出不进门禁统计：`AGENT_REGISTRATION_ID_PATTERN`/`PREFIX`（常量）、
`PmDecisionLock`（接口）、`sqliteStore`（组合根 `let`，attempt-service 以只读
live binding 引用，唯一写入口仍是 `setSqliteStore`）。

## maintenance.ts re-export（0a-1 已抽出的维护屏障，归 ReconcileService restore 面）

`acquireMutationPermit`、`acquireRestoreLock`、`activeLocalMutationCount`、
`beginLocalMutation`、`getRestoreMaintenanceGate`、`isBiaoNamespaceEmpty`、
`releaseMutationPermit`、`releaseRestoreLock`、`renewRestoreLock` —— 实现已在
`src/server/maintenance.ts`，service.ts 仅 re-export 保持兼容；HTTP 面由
`src/server/http-plugins.ts` 共享 plugin 消费（permit/restore gate/barrier）。
