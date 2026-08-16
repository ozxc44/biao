# 后续增强·车道 B（调度与执行收口）：自动出队、真执行器、调度前置校验、snapshot 接线、依赖拓扑

## 背景

车道 A/E 已验收（全量基线 **126 文件 / 1533 用例全绿**）；车道 C（project-service/recovery-decision/transition 路由）**并行运行中——其文件不得触碰**。本车道处理 Phase 8 残留与审计部分覆盖缺口中"调度与执行接线"簇。

先读：`docs/distributed-multi-node-acceptance-audit.md`（22.1-08、22.2-09 缺口列）、Phase 8 交付的残留清单（review log Phase 8 行）、车道 A 交付的接口缺口（unlockDownstream 仅查 queued jobs、detectUndocumentedShas 返回空集——**这两个函数在 merge/queue.ts，本车道所有权内，直接补**）。

## 目标

1. **merge 自动出队**（§12 队列语义收口）：merge queue 由"显式 dispatch 路由"增加**自动出队驱动**——入队/merge 完成后自动 dispatch 队头（异步触发、单飞去重、失败不阻塞后续轮询）；保留显式路由兼容。测试：入队后无人调用 dispatch → 默认分支自动前进；连续两 delivery 串行自动合并。
2. **daemon 真执行器**（Phase 8 残留）：`src/node/` 的占位 executor 替换为真实执行：收到 task attempt → 调 workspace prepare 路由 → 在 attempt 工作区执行（可配置命令模板，默认占位 shell 写文件+exit 0——重点是把 prepare/commit/push/artifact/report 全链从 daemon 侧真实走通）→ finalize → report。测试：子进程 daemon 端到端完成一次真实交付（真实 HTTP + 真实 git）。
3. **claim 调度前置校验**（Phase 8 残留）：V2 claim 路由前置——node 状态必须 active、NodeProjectBinding 必须 authorized、project write_capability 必须 full；任一不满足→结构化错误码（NODE_NOT_ACTIVE/BINDING_UNAUTHORIZED/PROJECT_READ_ONLY）。
4. **heartbeat stale 自动 offline/quarantine**（Phase 8 残留，对应 22.4 相关）：心跳超阈值（默认 3 个周期）→ node 自动 offline（stale_timeout 原因）+ 该 node 的 running attempt 进 pending_recovery；可选 quarantine 标记（连续多次 stale）；由心跳路径或告警调度触发（告警调度器是车道 E 文件——**只消费其导出接口，不改其文件**）。
5. **22.2-09 claim snapshot 接线**：车道 E 已交付 ownership_snapshots 的 store 读写/重建函数——把它接进 V2 claim 路径（claim 成功写 durable snapshot；finalize/ownership 校验读 durable）；**Redis 清空场景**（审计不确定-1 的 V2 侧）：测试断言调度态可从 durable（SQLite）安全重建、无半投影。
6. **unlockDownstream 真拓扑**（车道 A 缺口）：依赖解锁改为查询 task depends_on 拓扑（accepted delivery 对应 task 的下游 task 解锁，跨 plan 依赖同样处理）；**proposed/finalize 双轨收口**（Phase 8 残留）：report 的 proposed delivery 与 finalize delivery 统一以 finalize 为准，proposed 过期清理 + 审计；**detectUndocumentedShas 异步化**：真实 ls-remote 比对已登记 final_sha 集合。
7. 测试 `tests/distributed/p9-scheduling.test.ts`（失败优先，逐项至少一用例）。

## 约束

- 全程中文；**所有权**：`src/server/v2/merge/queue.ts`、`src/node/**`、V2 claim/heartbeat 路由文件（`src/server/v2/routes/**` 的 attempt/heartbeat 组）、`src/server/v2/report-v2.ts`（双轨收口）、`src/server/v2/delivery-service.ts`（如解锁衔接需要，最小改动）、`src/db/sqlite-store.ts`（只增）、`tests/distributed/p9-scheduling.test.ts`、runbook 增补。**不得改**：`src/server/v2/project-service.ts`、`src/server/v2/recovery-decision.ts`、transition/recovery/batch 路由组（车道 C）、`src/server/v2/metrics.ts`/`incident-service.ts`/`alert-scheduler.ts`（只调用）、`src/server/v2/git/**`（只 import；缺口列清单）、`src/server/service.ts`、`src/mcp/**`、`web/`、既有 fixture。
- 四条验证原始输出随交付；env save/restore 纪律；门禁：构建 + 全量不劣化 126/1533 基线。

## 验收标准

1. 7 项逐条测试路径；daemon 真交付端到端与自动出队为必过项。
2. 交付说明：自动出队触发矩阵、执行器配置面、调度前置错误码表、双轨收口语义、接口缺口清单、四条验证原始输出。
