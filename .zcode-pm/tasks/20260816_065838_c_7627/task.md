# Phase 8（本机可执行段）：单机 V2 loopback + 双逻辑节点 E2E + 故障注入 + 灰度就绪件

## 边界声明（PM 决定，如实）

Phase 8 全序列 10 步中：步骤 1（单机 loopback）、2（两节点同 OS——本机两个 biao-node 进程即"两逻辑节点"）、4（故障注入）、9 的**回退窗口文档**、灰度就绪件（feature flag 装配 + 低风险准入清单）**本车道交付**；步骤 3（不同 OS 节点）、5-8（真实项目只读验收/真实任务/人工确认 Merge Queue/小范围自动合并）**需要用户与其他物理机参与，不在本车道**——交付说明须给出这些步骤的操作剧本（runbook），并把"已就绪/待人工"状态表交 PM 汇报。

## 前置状态

Phase 1-7a 全部验收（全量基线 **118 文件 / 1433 用例全绿**）。可用：完整 V2 链路（enroll→register→claim(bva2)→artifact 三段→report→delivery→review→merge queue→merged→cleanup）、biao-node daemon（watchdog/drain/fencing）、故障注入器、BackupCoordinator/restore drill、指标/告警。

先读：方案 §21 Phase 8 原文（上面引述的 10 步与"低风险"六条件、立即停止条件）、§23.1（五个 feature flag 依赖顺序）、§23.2（回退八条）、§16.1（控制面配置）。

## 目标

1. **Feature flag 装配** `src/server/v2/feature-flags.ts`：五旗按依赖序（DISTRIBUTED_MODE 必须开才允许其余四旗；ARTIFACTS 先于 NODE_RUNTIME 先于 GIT_DELIVERY 先于 MERGE_QUEUE——乱序启动 fail-fast 并指明缺哪面旗）；默认全关=纯 V1 行为（回归门禁：全关时 V1 套件与 V2 路由 404/关闭行为断言）；`GET /v2/feature-flags` 状态端点（owner）。
2. **单机 V2 loopback E2E** `tests/distributed/p8-loopback-e2e.test.ts`：五旗全开，一个测试进程内走**完整业务闭环**：建 project→enroll node→register→heartbeat→claim→workspace prepare→写入文件（占位 executor 或直接 git 操作）→finalize push→artifact 上传→report→delivery→PM accept→merge queue→merged→默认分支验证→BranchCleanup 排程→指标断言（merge_jobs=merged、outbox 无死信）。**验收=一次断言整条链**（此前各 Phase 是分段验证）。
3. **双逻辑节点同 OS E2E** `tests/distributed/p8-two-nodes.test.ts`：两个真实 biao-node 子进程（不同缓存根/不同 session），并发 claim 两个 task（不同文件），各自走完整链到 delivery；一个 merge 成功后另一个基于新 HEAD 重排队再 merged（串行队列语义端到端）；节点 B drain 后新任务只由 A 领。
4. **故障注入 E2E** `tests/distributed/p8-fault-matrix.test.ts`（§18 矩阵抽样，全链路上注入）：
   - 节点掉线（SIGKILL node A mid-attempt）→watchdog/lease 回收→attempt pending_recovery→节点 B takeover→完成链路；
   - 网络分区（fetch 拦截）→claim 停止、心跳超时→quarantine 语义（按现有实现断言）→恢复后 re-register；
   - merge 期间控制面重启（kill 测试 server 进程重启同库）→merge job 幂等收敛不双写；
   - artifact 上传中断→pending_recovery→补传收敛。
5. **灰度就绪件**：
   - `docs/runbooks/phase8-rollout.md`（中文）：**低风险准入六条件清单**（可勾选模板）、**立即停止条件→八条回退步骤**（§23.2 逐条映射到命令）、五旗开关顺序表、双物理机接入剧本（步骤 3/5-8 的操作手册：目标机安装/enroll/凭据搬运/只读 acceptance 怎么做/人工 Merge Queue 检查单）、V1 回退窗口保留策略；
   - 回退演练测试 `tests/distributed/p8-rollback-window.test.ts`：五旗全开跑半条链→关旗→断言 V1 可继续处理未迁移 plan、V2 已完成数据（Delivery/Artifact/Audit）完整保留、未合并 branch 保留、无强制降级（§23.2 断言逐条）。
6. 全程指标埋点已在 7a，E2E 中抽样断言关键 series。

## 约束

- 全程中文；**所有权**：`src/server/v2/feature-flags.ts`、`src/server/v2/routes/**`（flag 状态端点+装配）、`src/server/http.ts`（仅装配行）、`tests/distributed/p8-*.test.ts`、runbook、受影响版本期望（链条连续性+三位补零风格）。**不得改**：`src/node/**`（E2E 以子进程消费现有 CLI）、`src/server/v2/git|merge|human-identity|rbac/**`（只消费；缺口列清单）、`src/server/service.ts`、`src/mcp/**`、`web/`、既有 fixture。
- 双节点 E2E 用真实子进程 `bin/biao-node.js`（0b/Phase 3 已有模式）；不启动生产栈、不触碰生产 SQLite/artifact/git；不新增依赖/env（flag 五个变量本身除外，测试 save/restore 纪律）。
- 门禁：构建 + 全量不劣化 118/1433 基线；**四条验证原始输出随交付**。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿（含 p8 四个 E2E 套件）；全量不劣化。
2. §21 Phase 8 步骤 1/2/4 端到端实证 + 步骤 9 回退窗口断言逐条；步骤 3/5-8 剧本完整、状态表"已就绪/待人工"如实。
3. 交付说明：五旗矩阵（开/关/乱序行为）、双节点时序图、故障矩阵×结果表、回退演练证据、四条验证原始输出。
