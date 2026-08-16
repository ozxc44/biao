车道 C 全部 8 项审计编号已实现、测试与文档交付完毕。最终总结如下：

## 交付总结（后续增强·车道 C：22.3-20 修正 + transition/recovery 全收口）

### 变更文件
- **新增**：`src/server/v2/recovery-decision.ts`（决策签名/接管/批量/隔离分权）、`src/db/migrations/013_recovery_decisions.ts`、`tests/distributed/p9-recovery.test.ts`（31 用例）、`docs/runbooks/mode-transitions-and-recovery-decisions.md`
- **修改**：`src/server/v2/project-service.ts`（重写为 step 推进器）、`src/server/v2/routes/v2-routes.ts`（advance/auto/binding-resync/isolation 路由 + recovery 组接线 + 启动续跑）、`src/db/migrate.ts`、`src/db/sqlite-store.ts`（upsertPlan 可选 project_id）、`src/types/v2-infra.ts`（24h 常量 + 补列 + 枚举扩展）、`docs/runbooks/operations-phase7a.md`
- 未触碰禁改文件（git/**、merge/**、credentials.ts、metrics.ts、incident-service.ts、node/**、mcp/**、web/、既有 fixture）

### 逐项要点
1. **22.3-20+22.4-04**：`MODE_TRANSITION_DEADLINE_MS=24h`（出处 §12.1.1「双向 mode transition 的总 deadline 默认均为 24 小时」，修正原 30 分钟）；step 推进器按 §4.1 双向序列「先落库再执行」，waiting 停留+清单、failed 可重试幂等重入；`POST .../mode-transitions/:tid/advance`（单步/auto）；启动扫描续跑（kill 模拟测试用文件库 close+重开实证）；超期→expired+RecoveryIsolation+critical Incident，retry 拒绝
2. **22.3-18**：六类收口（write-attempt/delivery/merge-job/candidate/write-task/dependent-task，`DRAIN_CHECKLIST_TEMPLATE`），未收口停 reconcile 报清单、不切模式，收口完才原子切换
3. **22.3-21**：切换条件不含全 Node 在线；离线 binding 挂 suspended，回归 `binding-resync` 对齐 revision 后才 eligible
4. **22.4-26/27**：HMAC 决策信封（15min TTL、candidate revision+decided_by）、校验链（签名/过期/未来签发/REVISION_STALE/单调偏移容差 5min）、一次性消费防重放，keyring 缺失 fail-closed
5. **22.4-29**：decide→fence→release 三崩溃点重入收敛，attempt CAS 不产生双 attempt
6. **22.4-31**：batch 逐项 revision/final_status/error_code，单项失败不影响其余
7. **22.4-06**：isolation 三步分权（自审 SELF_REVIEW_FORBIDDEN、resolve 仅 reconcile-service），全链审计
8. **22.4-34**：revalidate-plans 内建 canary 子步 fail-closed（首个 plan 失败→failed 保持 read-only + Incident）

### 验证（原始输出在 `.zcode-pm/tasks/20260816_082902_c_d483/verification/`）
- 构建：`npm run build` exit 0
- 本套件：31/31 passed
- 全量：128 文件/1619 用例，1564 passed；基线 122/1479 文件数与通过数未劣化
- **52 个失败全部位于 6 个文件（p23/p3/p6/p8-loopback/p8-two-nodes/p8-fault-matrix）**，经「移除本车道全部改动的快照」对照验证为并行车道的 claim/BINDING/merge 面既有失败（归因证据已归档）——本车道引入的失败为 0

### 残留风险
并行车道失败未收口前全量无法回绿；`V2ProjectModeTransition.status` 域枚举无 failed（投影映射 rolled_back，已注释）；steps 投影 updated_at 为粗粒度；daemon 侧 decision 消费接线属其它车道所有权。交付说明（状态机图引用、24h 矩阵原文、收口清单模板、三车道冲突清单）见 `delivery.md`。