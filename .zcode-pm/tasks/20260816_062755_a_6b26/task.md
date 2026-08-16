# Phase 7a：API/CLI 可观测与运维（7b Web 延期决策维持，触发条件自查）

## 前置状态

Phase 1-6 全部验收（全量基线 **117 文件 / 1411 用例全绿**）。已有：003（outbox/incidents 表骨架）、009（RBAC）、outbox 服务（append/mark/retry/dead-letter 枚举）、orphan/recovery/isolation/branch_cleanup 表、delivery/merge 全链路、bvh2 审计事件。

**R1B-012 延期决策执行**：7b（完整 Web 页面）维持延期（owner=Distributed Implementation PM，目标=Biao Distributed v2 Phase 7b，重决策=Phase 7 立项评审日或 2026-10-01 取早者）。**本车道必须交付 7a 全部处置能力，并在交付说明里逐项自查"CLI/API 覆盖清单"——任何一项覆盖不了即触发 7b 升阻塞，需如实报告**。

先读：方案 §17（17.1 控制台页面=数据面参照 / 17.2 事件 / 17.3 指标）、§4.8（ReadOnlyAcceptance 与 Incident）、§18（故障与恢复矩阵）、§14.6（一致恢复点与恢复门禁）、§23.3（备份）、§21 Phase 7 原文（上面引述）、R1C-009（恢复门禁）、R1B-013（WAL checkpoint）。

## 目标

1. **Incident 持久化** `src/server/v2/incident-service.ts`（表已在 003 骨架，补齐最小字段/状态机 open→acked→resolved+SLA 字段）+ API（list/show/ack/resolve，owner 或 reviewer 角色）+ 事件源接线：merge integration_failed、降级 read_only、revoke-all、quarantine 触发点写入 incident（含 correlation_id）。
2. **Recovery 运维 API/CLI**：
   - Recovery Candidate：list / 批量 takeover（裁决+Node 确认）/ discard（证据摘要留档）；
   - Isolation：list / resolve（review 证据必填）；
   - BranchCleanup：list / retry（到期复核 HEAD）；
   - Project mode transition：进度查询 / 恢复（失败 transition 的幂等续跑或回退，按 §4.1 step 合法性）。
3. **Dead-letter 治理**：outbox dead-letter list/show/requeue/compensate 的 API + CLI 子命令（`src/cli/v2/` 下新文件，如 `outbox.ts`：`biao v2 outbox dead-letter list|show|requeue|compensate`——沿用现有 CLI 严格选项校验风格）。
4. **BackupCoordinator 与隔离 restore drill**：备份协调器（组件清单=SQLite+artifact 目录+git refs 摘要，产出 restore_point + backup_runs 行，manifest digest 校验）+ `restore drill` 命令（隔离副本上验证：integrity + digest 一致 + 恢复冒烟=打开副本读 plans/deliveries 计数比对；**不触碰生产库**）+ WAL checkpoint（R1B-013：备份前 checkpoint）。
5. **告警与指标** `src/server/v2/metrics.ts`：`GET /v2/metrics`（Prometheus 文本格式，无外部依赖）：队列深度（merge_jobs by status）、outbox pending/dead-letter、incidents open by severity、nodes by status、delivery by status、GC/水位标量；告警规则表（runbook：哪些指标阈值→incident 自动开单）。
6. **runbook** `docs/runbooks/operations-phase7a.md`（中文）：全部处置流程（ack/resolve、takeover/isolate/resolve、cleanup retry、dead-letter、restore drill、mode transition 恢复）、指标口径、告警阈值表、升级/回滚入口。
7. **失败优先测试** `tests/distributed/p7a-ops.test.ts`（真实 HTTP + 隔离 SQLite/artifact/git fixture）：
   - incident 生命周期（触发→ack→resolve，SLA 字段、审计）；
   - dead-letter：制造死信（attempt_count 耗尽）→list/show→requeue 成功投递→compensate 生成补偿事件；
   - recovery takeover/discard 幂等与证据留档；isolation resolve 必须带证据；cleanup retry 到期语义；
   - mode transition 失败→恢复幂等；
   - backup→drill：restore_point 三个 digest 齐全、副本恢复冒烟计数一致、生产库字节不变；
   - metrics：格式合法+关键序列存在+数值与 fixture 状态一致；
   - **三者一致性验收**（§21 原文"页面、API、CLI 对同一状态一致"在 7b 延期下的等价门禁）：同一 fixture 状态下 API JSON 与 CLI 输出的关键字段逐项一致（CLI --json 输出解析比对）。
8. **V1 work/ 迁移清点**（§21 末段要求）：只交付清点报告脚本+runbook 章节（清点 `.biao` 生产 V1 work 目录中仍在审计期的 result/verify 文件清单与 Artifact 上传计划）；实际迁移执行不阻塞本阶段，验收门禁（抽样可读+无未解释缺口）挂到清点报告完成度。

## 约束

- 全程中文；**所有权**：`src/server/v2/incident-service.ts`、`src/server/v2/metrics.ts`、`src/server/v2/backup.ts`、`src/server/v2/routes/**`（ops 组）、`src/cli/v2/**`（outbox 等新文件）、`src/db/**`（如需 010 补列）、`src/types/**`、`tests/distributed/p7a-*.test.ts`、版本期望（链条连续性风格）、runbook。**不得改**：`src/server/v2/git/**`、`src/server/v2/merge/**`、`src/server/service.ts`、`src/server/http-plugins.ts`、`src/node/**`、`web/`、既有 fixture。
- 指标零依赖（手写 Prometheus 文本）；不新增 env/`*_TEST_REDIS_URL`；不启动生产栈、不触碰生产 SQLite/artifact。
- 门禁：构建 + 全量不劣化 117/1411 基线。**流程要求**：四条验证原始输出随交付（Phase 5 教训）。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿；全量不劣化。
2. §21 Phase 7 的 CLI/API 处置能力清单逐项勾选 + 7b 触发条件自查结论（如实）。
3. 交付说明：指标清单、告警阈值表、drill 步骤、V1 work/ 清点报告产出方式、四条验证原始输出。
