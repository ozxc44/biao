# 后续增强·车道 C（状态机/恢复决策）：22.3-20 修正 + transition/recovery 全收口

## 背景

Phase 0a-1→8 已验收（review log）；§22 审计（docs/distributed-multi-node-acceptance-audit.md）列出后续增强清单。本车道处理其中"模式切换与恢复决策"簇，**首要项为已确认的设计/实现不一致 22.3-20**。全量基线 **122 文件 / 1479 用例**（1 个已知 V1 flaky 单独复跑恒绿）。并行车道：A（凭据/ACL/Git 面）、E（运维告警/测试补强）——文件所有权互斥，见约束。

先读：审计文档逐项行（22.3-18/20/21/23、22.4-04/06/26/27/29/31/34）；方案 §4.1（mode transition 方向-step 表）、§12.1.1/12.1.2（full↔read-only 收口与恢复）、§4.4.1（recovery decision/takeover）、§14.6（恢复门禁）、R5A/R5C/R6C/R7C 评审项（review log Round 记录）。

## 目标（逐项对应审计编号）

1. **22.3-20 + 22.4-04（首要）**：`src/server/v2/project-service.ts` 修正 deadline 30 分钟→**24 小时**（矩阵要求，写明常量与出处）；实现 **step 推进器**：`pause → validate-capability → reconcile → refresh-bindings → revalidate-plans → completed`（§4.1 合法 step 序），每步：先落库（project_mode_transitions.step/status/last_error）再执行、执行成功推进 step、失败置 failed 可重试（幂等重入）；**重启续跑**：服务启动/路由触发时发现 running transition 且未过期→从 durable step 继续；超 24h deadline→置 expired + RecoveryIsolation 记录（衔接 §22.4-05 既有语义）。API：`POST /v2/projects/:id/mode-transitions/:tid/advance`（owner，单步驱动）与自动推进选项。
2. **22.3-18**：full→read-only 切换前**写 lineage 全收口**：枚举该 project 的 proposed/accepted/merging delivery、running merge jobs、pending recovery candidates、依赖被阻塞的只读 task——逐项 pause/drain/cancel/invalidated（按 §12.1.1 列表），全部收口后才原子切换 execution_mode；未收口完成→transition 停在对应 step 并报告清单。
3. **22.3-21**：恢复 full 时**离线 Node 不阻塞**：切换条件不含"全部 Node 在线"；离线 Node 旧 credential 无效，其重新上线需 policy/binding 重新同步后才取得新 push credential（§12.1.2）。
4. **22.4-26/27（recovery decision）**：`src/server/v2/recovery-decision.ts`：takeover/discard 决策签名（复用控制面 signing key，决策含 candidate revision+decided_by+expires_at=15min TTL）；校验：签名、TTL 未过、**TTL 单调偏移防护**（决策时间不得早于 candidate revision 时间-容差）；消费一次性（防重放）。
5. **22.4-29**：takeover 三崩溃点续跑（决策落库后崩溃/任务回 pending 后崩溃/新 attempt 创建后崩溃）——每点重启后重入收敛，不产生双 attempt（attempt CAS）。
6. **22.4-31**：batch takeover/isolate 响应**逐项 revision 与 error**（数组结果，单项失败不影响其余，响应含每项 candidate revision/最终状态/错误码）。
7. **22.4-06**：RecoveryIsolation **三步分权**：isolator（创建）/reviewer（复核，≠isolator）/resolve（reconcile 服务）；同一 actor 不能自建自审（强制校验），review/resolve 字段与事件入审计。
8. **22.4-34**：canary **fail-closed**：transition 的 revalidate-plans 步内建 canary 子步（首个迁移 plan 验证失败→transition failed 并保持 read-only，不继续批量）。
9. 测试 `tests/distributed/p9-recovery.test.ts`（失败优先）：每审计编号至少一个直接驱动用例；22.3-20 必须含"deadline=24h 常量断言"+"step 序列重启续跑（kill 模拟）"+"超期隔离"三用例；batch 逐项结果、三崩溃点、三步分权各成用例。

## 约束

- 全程中文；**所有权**：`src/server/v2/project-service.ts`、`src/server/v2/recovery-decision.ts`（新）、`src/server/v2/routes/**`（transition/recovery/batch 组）、`src/db/**`（如需 011 补列）、`src/types/**`、`tests/distributed/p9-recovery.test.ts`、版本期望（链条连续性+三位补零风格）、runbook 更新（`docs/runbooks/operations-phase7a.md` 增补或新文件）。**不得改**：`src/server/v2/git/**`、`src/server/v2/merge/**`、`src/server/v2/credentials.ts`、`src/server/v2/metrics.ts`、`src/server/v2/incident-service.ts`、`src/server/service.ts`、`src/node/**`、`src/mcp/**`、`web/`、既有 fixture。
- 四条验证原始输出随交付（构建/本套件/distributed/全量）；测试 env save/restore 纪律。
- 门禁：构建 + 全量不劣化 122/1479 基线。

## 验收标准

1. 上述 8 项逐条有测试路径；22.3-20 的 24h 常量与重启续跑实证。
2. 交付说明：step 推进器状态机图、24h 依据（矩阵原文）、收口清单模板、三车道接口冲突清单（如有）。
