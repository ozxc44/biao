# 后续增强·车道 A（凭据/ACL/Git 面）：merge_bot、ref ACL、read-only 门禁、导入与人工合并

## 背景

Phase 0a-1→8 已验收；§22 审计后续增强清单的"访问控制与 Git 面"簇归本车道。全量基线 **122 文件 / 1479 用例**。并行车道：C（状态机/恢复决策）、E（运维告警/测试补强）——文件所有权互斥。

先读：审计逐项（22.3-04/10/13/14/15/17/23 部分、22.2-13/14、22.4-09/24/38）；方案 §13.1（Merge Bot 凭据层）、R1A-009/R2B-002（generic-git ref ACL 设计——**设计已定，实施它**）、§12.1 权限边界、§15.4（EvidenceAcceptance/artifact 读面）、§21 Phase 6 相关、`src/server/v2/routes/registry.ts`（V1 route registry 分类机制）。

## 目标（逐项对应审计编号）

1. **22.3-04 merge_bot 凭据**：`src/server/v2/credentials.ts` 扩展 `bvm2_` 前缀 Merge Bot credential（HMAC 同体系、scope=merge、project 绑定、key_version 轮换）；merge 相关路由（enqueue/dispatch/retry）接受 owner 或 bvm2；**Merge Bot 无 Agent/Plan 权限**（rbac 矩阵断言：bvm2 对 claim/report/plan 路由 403）。
2. **22.3-10 generic-git ref ACL**：`src/server/v2/git/ref-acl.ts`：per-project 规则（允许 ref 模式：`refs/heads/biao/attempt/*`、marker refs；**禁止**默认分支/tag/他人 branch 前缀）；provider.push 前置 ACL 校验（拒绝即 push_forbidden 错误码+审计）；Node 侧 push 一律过 ACL（服务端 push 亦同规则）。
3. **22.3-13 无 ref ACL ⇒ read-only**：project 注册时未配置 ref ACL → `write_capability_status=degraded_read_only` 语义（claim/交付写路径拒绝，读/验收只读路径放行），并在 project 创建响应与状态端点明示。
4. **22.3-14 read-only Plan import 拒绝写任务**：实现 `importPlan`（替换 NOT_IMPLEMENTED）：read-only 项目拒绝**所有写任务与写依赖**（响应逐条列出被拒任务，不产生永久 pending）；full 项目正常导入（tasks 落库、project_id 回填——顺带解决 Phase 8 残留"tasks.project_id 未接线"）。
5. **22.3-15 EvidenceAcceptance**：实现（替换 stub）：full 项目的 Artifact-only 任务以 EvidenceAcceptance 完成（记录 acceptance 绑定 artifact digest 清单），**不能解锁写 lineage**（下游写依赖仍等 merge 口径）；只读项目 read-only acceptance 路径已有则衔接。
6. **22.3-17 ref ACL 连续丢失熔断**：ref ACL 确认连续 N 次（默认 3）丢失→不等待 Owner：fencing 该 project 全部 running write attempt + 撤销 push/merge credential + incident 开单（调 incident-service 接口，不改其文件——如接口不足在交付说明列缺口）。
7. **22.2-13/14 V1 plan/question mutation 隔离**：V1 的 plan create/submit/supersede 与 question create/answer 对已启用 V2 的 project **全部拒绝**（复用 v1-isolation 机制扩展路由面）；**V1 route registry 显式分类**：legacy lifecycle/PM transport/maintenance/read-only 四类，未分类的 mutation 路由**构建期失败**（生成式门禁测试）。
8. **22.4-09 Git Remote 不可用**：provider 层故障分类（remote_unreachable）+ merge/finalize 路径语义：job → integration_failed(reason=remote_unreachable) 可重试、incident 开单、默认分支不动；测试注入不可达 remote URL。
9. **22.4-24 人工 merge 回写**：external_merge_intent → `resolved(final_sha)` 时回写 delivery（merged_by_external + final_sha）+ Integration Verify（服务端对 remote 默认分支做独立 diff 复核 §7.3）+ 下游解锁调用（C 车道 unlockDownstream 的现有接口——只调用不改其文件，接口不足列缺口）。
10. **22.4-38 默认分支未登记 SHA 检测**：周期/按需检测默认分支出现**未登记 SHA**（不在任何 merged job/external intent 的 final_sha 集合）→ incident 开单（外部改写告警）。
11. 测试 `tests/distributed/p9-access.test.ts`（失败优先，逐项至少一用例；含 rbac 负面矩阵 bvm2×claim/plan 403）。

## 约束

- 全程中文；**所有权**：`src/server/v2/credentials.ts`、`src/server/v2/rbac.ts`（矩阵扩展）、`src/server/v2/git/**`（ref-acl 新文件+provider/generic-git 接线）、`src/server/v2/merge/**`（人工回写/remote 故障分类）、`src/server/v2/v1-isolation.ts`、`src/server/v2/routes/**`（import/evidence/ACL 组）、`src/server/v2/plan-import.ts`（新，如单列）、`src/db/**`（如需 012）、`src/types/**`、`tests/distributed/p9-access.test.ts`、版本期望、runbook 增补。**不得改**：`src/server/v2/project-service.ts`、`src/server/v2/recovery-decision.ts`、`src/server/v2/metrics.ts`、`src/server/v2/incident-service.ts`、`src/server/v2/backup.ts`、`src/server/service.ts`、`src/node/**`、`src/mcp/**`、`web/`、既有 fixture。
- 四条验证原始输出随交付；测试 env save/restore 纪律。
- 门禁：构建 + 全量不劣化 122/1479 基线。

## 验收标准

1. 10 项逐条测试路径；ref ACL 拒绝矩阵（Node push 默认分支/tag/他人 branch 各一拒）+ bvm2 负面矩阵实证。
2. 交付说明：ACL 规则语法、read-only 门禁触发面清单、importPlan 语义（read-only 拒绝响应示例）、对 incident/unlock 接口的调用缺口（如有）、四条验证原始输出。
