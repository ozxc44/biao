# 后续增强·车道 E（运维告警/测试补强）：告警接线、SLO、冲突闭环与幂等合并断言

## 背景

Phase 0a-1→8 已验收；§22 审计后续增强的"运维告警"簇与**审计不确定性说明中点名的测试缺口**归本车道。全量基线 **122 文件 / 1479 用例**。并行车道：C（状态机/恢复决策）、A（凭据/ACL/Git 面）——文件所有权互斥。

先读：审计"判定不确定性说明"第 2/4 条与未覆盖表（22.4-18/36/37）；方案 §17.2/17.3（事件与指标）、§4.8（Incident SLO）、`src/server/v2/metrics.ts`（runAlertEvaluation 现状）、`src/server/v2/merge/queue.ts` conflict 分支。

## 目标

1. **22.4-18 告警调度接线**：`runAlertEvaluation` 从"存在但未接线"变为**定期驱动**：在 metrics 端点求值之外，提供 `src/server/v2/alert-scheduler.ts`（setInterval 可注入 now/fn，unref，BIAO_V2_ALERT_INTERVAL_MS 默认 60s，测试注入短间隔）——outbox 死信/pending 超阈值、merge 队列积压等既有规则自动开 incident（复用 incident-service，不改其文件；接口不足列缺口）；重复告警去重（同 fingerprint 未 resolve 不重开）。
2. **22.4-36 resolution SLO/recurrence**：incident 增加 resolution_sla_minutes（按 severity）与 recurrence 计数（同 fingerprint 在 resolve 后 N 天内重开计复发，字段留档）；超 SLO 未 resolve 的 incident 由告警调度升级 severity 一次。
3. **22.4-37 stale proposed Delivery 告警**：proposed/pending_review 超过阈值（默认 48h，env 可调）→ alert 规则开 incident（含 delivery_id/age）。
4. **审计不确定-4：真·内容冲突闭环测试**（只加测试不改 queue）：驱动 merge queue 的 `conflict` 分支——两个 delivery 改**同一行**→ 第二个 job `conflict` + conflict_files 审计落库 + delivery 保持 accepted + 默认分支不动 + 修复路径可走（新 delivery 重交付后 merged）。补齐后 22.1-09 判定可升级。
5. **审计不确定-2：幂等合并断言**（只加测试）：单用例合并断言「重复 claim（同 claim_request_id）返回原 attempt 实体」+「重复 deliver/enqueue（同 delivery 键）返回稳定结果不双写」。
6. **22.2-09 ownership snapshot 载体**（最小接线或明确载体）：若 claim 侧 snapshot 仍为内存 Map，则按审计结论把"Redis 清空后可安全重建"的**载体**落 SQLite（ownership_snapshots 表已在 003/004）：claim 时写入（接线点在 A 车道 claim 路由文件之外——**若与 A 车道 claim 改动冲突则以 A 为准，本车道只交付 store 侧读写函数+重建函数+测试**，接线缺口列清单）；交付重建函数：从 durable 表重建运行态映射。
7. 测试 `tests/distributed/p9-ops.test.ts`（逐项失败优先；告警用例注入短间隔与假时钟）。

## 约束

- 全程中文；**所有权**：`src/server/v2/alert-scheduler.ts`（新）、`src/server/v2/metrics.ts`（规则扩展）、`src/db/sqlite-store.ts`（**仅 ownership snapshot 读写/重建方法追加**——与 A/C 追加共存时只增不改既有）、`tests/distributed/p9-ops.test.ts`、`tests/distributed/p9-merge-conflict.test.ts`（如单列）、`tests/distributed/p9-idempotency.test.ts`（如单列）、runbook 告警节增补。**不得改**：`src/server/v2/incident-service.ts`（只调用）、`src/server/v2/merge/**`、`src/server/v2/git/**`、`src/server/v2/project-service.ts`、`src/server/v2/routes/**`（如需新端点列缺口不上路由）、`src/server/service.ts`、`src/node/**`、`src/mcp/**`、`web/`、既有 fixture。
- 四条验证原始输出随交付；测试 env save/restore 纪律（新增 env 同样纪律）。
- 门禁：构建 + 全量不劣化 122/1479 基线。

## 验收标准

1. 6 项逐条测试路径；告警去重/升级/SLO 各一用例。
2. 交付说明：告警规则总表（规则/阈值/动作）、调度器参数、claim 接线缺口清单（移交车道 A 后续）、四条验证原始输出。
