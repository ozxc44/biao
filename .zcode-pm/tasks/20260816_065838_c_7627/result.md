Phase 8 车道交付完成。以下为交付说明（全程中文）。

# Phase 8（本机可执行段）交付说明

## 一、变更文件

| 文件 | 变更 |
|---|---|
| `src/server/v2/feature-flags.ts`（新增） | §23.1 五旗：依赖序解析/校验（乱序与脏值装配期 fail-fast 并指明缺哪面旗）、`ALL_V2_FEATURE_FLAGS_ON_ENV`、路径→旗映射 `requiredV2FeatureFlagForPath`、状态视图 |
| `src/server/v2/routes/v2-routes.ts` | 装配期解析五旗 + onRequest 门禁（全关→`404 V2_DISABLED`、分旗关→`404 V2_FLAG_DISABLED`）；`GET /v2/feature-flags`；claim 落 ownership snapshot（task.ownership_files→写边界）；takeover 裁决传导 `applyControlPlaneTakeover`（executing+lease 过期→attempt `pending_recovery`+task 放回 pending）；claim 用 `updateTaskFields` 写 `active_attempt_id`；`POST /v2/projects/:id/merge-jobs/dispatch` |
| `src/server/v2/routes/registry.ts` | 2 条新路由（feature-flags 状态 / merge dispatch） |
| `src/server/v2/domain-interfaces.ts` | `MergeService.dispatchMergeJob`、`ReconcileService.getFeatureFlags` 签名（registry handler 引用约束所需；SERVICE_MAP 门禁只对 service.ts 导出，无版本期望变更） |
| `src/server/http.ts`（仅装配行） | options 增加 `artifactRoot` 并转发 v2RoutesPlugin（Artifact 根可按部署隔离） |
| `tests/distributed/p8-{loopback-e2e,two-nodes,fault-matrix,rollback-window}.test.ts`（新增 4 套件 46 用例） | 见下文各节 |
| `tests/distributed/{p1-e2e-identity,p3-node-daemon,p4-git-workspace,p6-rbac,p23-env-hermetic,p23-integration-gate}.test.ts` | beforeAll/afterAll 五旗 opt-in（save/restore 纪律，机械改动） |
| `docs/runbooks/phase8-rollout.md`（新增） | 六条件清单、八条回退命令映射、五旗开关顺序表、双物理机剧本、V1 回退窗口策略、缺口清单 |

未触碰：`src/node/**`（以子进程消费）、`src/server/v2/git|merge|human-identity|rbac/**`、`src/server/service.ts`、`src/mcp/**`、`web/`、既有 fixture。

## 二、五旗矩阵

| 场景 | 行为 | 实证 |
|---|---|---|
| 五旗全开 | 全链可用；`GET /v2/feature-flags` 五行 enabled=true、prerequisites_satisfied=true | loopback ① |
| 默认全关 | `/v2/*` 一律 `404 V2_DISABLED`（纯 V1）；`GET /v2/feature-flags` 仍 200（owner） | rollback ③ |
| 仅 DISTRIBUTED_MODE 开（合法子集） | 数据面 `404 V2_FLAG_DISABLED`（消息含缺的 env 名）；`/v2/projects` 管理面 200 | rollback ④ |
| 乱序（如只开 MERGE_QUEUE） | **装配期抛 `V2FeatureFlagOrderError`，服务不 boot**，消息逐面列出缺的旗 | loopback 矩阵（纯函数） |
| 脏值（`BIAO_V2_ARTIFACTS=maybe`） | 抛 `V2FeatureFlagValueError`，不静默当关 | loopback 矩阵 |

## 三、双节点时序（同 OS、两个真实 biao-node 子进程）

```
A(enroll→register→session₁)  B(enroll→register→session₂)   [不同缓存根/不同 session]
   │ claim task-a (slots=1)     │ claim task-b (slots=1)      ← 一节点一 attempt，无重复赢家
   ▼                            ▼
prepare→写 a/**→artifact→finalize→delivery₁/₂ (pending_review)→report done
   │                            │
PM accept₁ ──► merge-jobs(HEAD₁) ──dispatch──► merged ──► HEAD₂
PM accept₂ ──► merge-jobs(HEAD₂=新 HEAD) ──dispatch──► merged ──► HEAD₃
                                    （merge-base --is-ancestor HEAD₂ HEAD₃：串行无分叉双写）
B: CLI drain → attempts 收口 → offline → exit 0（服务端 status=offline）
A: SIGTERM 重启 → register 新 generation（旧 session fenced）
新 task-c ──► 只由 A 领（attempt.node_id=A）
```

## 四、故障矩阵 × 结果

| 注入 | 结果 | 实证 |
|---|---|---|
| SIGKILL 节点 A（mid-finalize，durable 状态停 committing） | lease 过期→scan→orphan candidate（node-offline-timeout）→takeover 裁决→attempt `pending_recovery`+task 回 pending→B 重 claim（generation=2）→完成链路 merged | fault-matrix A |
| 网络分区（fault-injector fetch 拦截） | claim 停止（无新 attempt）、心跳超时（consecutive_failures≥2）、**按现有实现**：无自动 offline/quarantine（last_seen 冻结）；恢复后心跳自愈→drain→offline→re-register（新 session，旧 fenced） | fault-matrix B |
| merge 期间控制面重启（close+同库重启） | 队列 job 持久；重复入队幂等返回原 job；dispatch 收敛 merged；主分支 first-parent 恰 +1 commit（不双写） | fault-matrix C |
| artifact 上传中断（finalize 引用未 complete） | delivery `pending_recovery`；report/review 被拒；补传 complete→recover→`pending_review`→merged；分支入 BranchCleanup 排程 | fault-matrix D |

## 五、回退演练证据（§23.2 逐条，p8-rollback-window 10 用例）

半条链（一条 merged + 一条 accepted-not-merged + restore point）→ drain→关旗重启同库：①claim 404 停止 ②drain/offline 留痕 ③Delivery/Artifact/Audit 行级不变+blob 在盘 ④未合并 branch 在、无清理排程且清理面 404 ⑤V1 plan submit→claim→report→pmReview 全绿 ⑥隔离门 403（不降级给 V1 worker）⑦accepted-not-merged 不改写、V1 claim 拿不到 ⑧旗态可读+restore point/未终态清单可枚举 ⑨重开旗→Binding authorized→accepted 走完 merged→claim 恢复（指标 `biao_merge_jobs{status="merged"} 2`、死信 0）。

## 六、四条验证原始输出

1. **构建**：`npm run build`（`tsc && node scripts/copy-assets.mjs` + vite `✓ built in 37ms`）通过。
2. **`npx vitest run tests/distributed/`**：`Test Files 26 passed (26) / Tests 443 passed (443)`（含 p8 四套件）。
3. **全量 `npm test`**：`Test Files 1 failed | 121 passed (122) / Tests 1 failed | 1478 passed (1479)`——唯一失败是 `tests/supervisor-pm-agent-cli.test.ts` SIGINT 用例（子进程收尾时序）。**已用 `git stash` 对照证实该用例在 HEAD（无本车道改动）同样失败**，且该测试仅用 `node:http` 桩+CLI 子进程、与改动零 import 交集；基线 118/1433 → 122/1479（+4 文件/+46 用例），本车道无劣化。
4. **p8 四套件**：`Test Files 4 passed (4) / Tests 46 passed (46)`（loopback 20 / two-nodes 7 / fault-matrix 9 / rollback-window 10；双子进程套件复跑 3 轮全绿）。

## 七、已就绪 / 待人工状态表

| Phase 8 步骤 | 状态 |
|---|---|
| 1 单机 loopback / 2 两逻辑节点同 OS / 4 故障注入 / 9 回退窗口 | **已就绪**（自动化实证） |
| 3 异 OS 节点、5 真实项目只读 acceptance、6 低风险真实任务、7 人工 Merge Queue、8 小范围自动合并 | **待人工**（操作剧本在 `docs/runbooks/phase8-rollout.md` §3.1-3.5） |

## 八、残留风险与缺口（Phase 9 输入，runbook §5）

1. `tasks.project_id` 写入路径未接线（plan import 未回填；E2E 按导入器语义直写）；2. 心跳 stale 不自动 offline/quarantine；3. claim 不校验 node 状态/Binding（调度前置）；4. daemon executor 仍为占位（E2E 由测试进程扮演 executor 走 HTTP 面）；5. merge dispatch 为显式路由无自动出队；6. report 的 proposed delivery 与 finalize delivery 并存（PM 审以 finalize 为准）。
7. 风险声明：五旗默认全关是行为变更——V2 测试需显式 opt-in（已按 save/restore 纪律落地 6 处）；生产部署若漏设旗将表现为纯 V1（fail-safe 方向，且有 `GET /v2/feature-flags` 可诊断）。