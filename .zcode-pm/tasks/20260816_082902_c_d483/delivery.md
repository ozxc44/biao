# 交付说明：后续增强·车道 C（状态机/恢复决策）22.3-20 修正 + transition/recovery 全收口

日期：2026-08-16 · worker：hermes-c · 分支：fix/pm-force-kill-grace（工作树未提交，与并行车道 A/E 共享）

## 1. 变更文件

| 文件 | 变更 |
|------|------|
| `src/db/migrations/013_recovery_decisions.ts` | 新增：expired_at/decision_envelope/decision_consumed_at 补列 + recovery_isolations 重建（object_type 追加 'mode-transition'） |
| `src/db/migrate.ts` | 注册 013（链条连续，011/012 为并行车道既有） |
| `src/types/v2-infra.ts` | `MODE_TRANSITION_DEADLINE_MS=24h`（含出处注释）、行类型补列、`V2IsolationObjectType` 扩展 |
| `src/server/v2/project-service.ts` | 重写：step 推进器（先落库再执行/waiting/failed 可重试/重启续跑/超期隔离）、收口清单、离线 Node、canary |
| `src/server/v2/recovery-decision.ts` | 新增：决策签名/校验/消费、takeover 三崩溃点、batch、isolation 三步分权 |
| `src/server/v2/routes/v2-routes.ts` | advance/auto/binding-resync/isolation create+review 路由；takeover/discard/batch/isolation resolve 接线 recovery-decision；retry 拒绝 expired；启动 resume（WeakSet 去重） |
| `src/db/sqlite-store.ts` | PlanRow.project_id 可选 + upsertPlan 条件写入（plans.project_id 旧路径不回填的兜底入口） |
| `tests/distributed/p9-recovery.test.ts` | 新增：31 用例（失败优先） |
| `docs/runbooks/mode-transitions-and-recovery-decisions.md` | 新增 runbook（状态机图/收口清单/决策校验链/三步分权/超期处置） |
| `docs/runbooks/operations-phase7a.md` | 处置能力清单表增补车道 C 各项 |

## 2. 逐项对应（审计编号 → 实现 → 测试路径）

| 审计项 | 实现 | 测试（tests/distributed/p9-recovery.test.ts） |
|--------|------|----------------------------------------------|
| 22.3-20+22.4-04 | 24h 常量 + step 推进器 + 重启续跑 + 超期 expired | 「deadline 常量 = 24 小时…」「read-only→full step 序列…」「重启续跑（kill 模拟：同库重开）…」「超 24h deadline → expired + RecoveryIsolation…」「步骤失败置 failed 可重试…」「同 project 已有 running transition…」 |
| 22.3-18 | 六类写 lineage 收口 + waiting 清单 + 原子切换 | 「逐项 pause/fence/cancel/invalidate/block；未收口停在 reconcile 并报告清单」「收口后重复推进不重复 invalidate…（幂等）」「收口清单模板覆盖 §12.1.1 六类对象」 |
| 22.3-21 | 离线 Node 不阻塞 + binding suspended + resync | 「离线 Node binding suspended 不阻塞切换；回归 resync 后才恢复 eligible」「隔离的 candidate 不阻塞恢复 reconcile…」 |
| 22.4-26 | 签名/缺字段/未知 key/TTL 15min/fail-closed | 「TTL 常量 = 15 分钟…」「keyring 未配置 → fail-closed…」「缺字段 / 签名错误 / TTL 过期 / 未来签发 / 未知 key 全部拒绝」 |
| 22.4-27 | 单调偏移防护（决策时间 ≥ revision 时间−容差） | 「REVISION_STALE…」「DECISION_NOT_MONOTONIC…」 |
| 22.4-26 防重放 | decision_consumed_at 一次性 | 「一次性消费：同一信封二次提交 → DECISION_ALREADY_CONSUMED」 |
| 22.4-29 | decide/fence/release 三阶段幂等 + attempt CAS | 「崩溃点 1（决策落库后）…」「崩溃点 2（任务回 pending 前一步）…」「崩溃点 3（新 attempt 创建后）…」「lease 未过期时 takeover fail-closed…」 |
| 22.4-31 | batch 逐项 revision/final_status/error_code | 「takeover 批次…」「discard 批次：重试不重复成功项…」+ HTTP「HTTP batch-actions 逐项结果」 |
| 22.4-06 | 三步分权（isolator/reviewer≠isolator/reconcile-service） | 「isolator 创建 → reviewer（≠isolator）复核 → reconcile 服务 resolve；全链审计」「同一对象重复创建幂等」 |
| 22.4-34 | revalidate-plans canary 子步 fail-closed | 「首个迁移 plan 验证失败 → transition failed 并保持 read-only…」「canary 通过但后续 plan 失败 → 同样 fail-closed」 |
| API 面 | advance 单步/auto/重启续跑/binding-resync | HTTP 组 4 用例（真实 HTTP + 真实文件库重启） |

## 3. 24h 依据（矩阵原文）

`docs/distributed-multi-node-development-plan.md` §12.1.1 结尾：

> 双向 mode transition 的总 deadline 默认均为 24 小时。降级 `reconcile` 超期后，Owner 只能通过 API/CLI 把无默认分支安全歧义的残留 ref/Candidate 写入 `RecoveryIsolationRecordV2` 和关联 Incident 后继续……

§12.1.2 结尾（恢复方向同口径）：「24 小时 deadline 超时仍保持 `paused + validating-to-full` 并开 Incident，不能隔离掉 capability/默认分支安全差异后强行恢复 full。」

审计 22.3-20 行原文：「**deadline 为 30 分钟，与矩阵 24 小时不符**」。常量：`MODE_TRANSITION_DEADLINE_MS = 24 * 60 * 60 * 1000`（src/types/v2-infra.ts），测试断言 `deadline_at - started_at === MODE_TRANSITION_DEADLINE_MS`。

## 4. step 推进器状态机图 / 收口清单模板

见 `docs/runbooks/mode-transitions-and-recovery-decisions.md` §1.1（双向状态机 + 每步语义/失败路径）与 §2（DRAIN_CHECKLIST_TEMPLATE 六类收口清单表，代码常量 `DRAIN_CHECKLIST_TEMPLATE` 与 runbook 同源）。

## 5. 三车道接口冲突清单

1. **v2-routes.ts 共享**：本车道改写了 recovery 路由组（takeover/discard/batch/isolation resolve）与 mode-transition 组；车道 A 的 claim 前置校验（BINDING_UNAUTHORIZED 块）共存无冲突。takeover 响应保持 `data.status/decision/revision` 旧字段并附加 `decision_envelope/takeover_steps`——p8-fault-matrix 断言兼容。
2. **isolation resolve 语义收紧**：需先 review（under-review）且 `resolved_by='reconcile-service'`。若车道 E 的测试/CLI 直接以任意 actor resolve 会得到 INVALID_STATUS/RESOLVER_NOT_ALLOWED（当前无此类消费方）。
3. **applyModeTransition 行为变化**：创建即执行 pause（响应 steps 投影变化）+ 拒绝同 project 第二个 running transition（TRANSITION_IN_PROGRESS，替代原唯一索引 500）。
4. **迁移链**：013 排在车道 A 的 012 之后（连续 + 三位补零）；p0a1 版本期望为动态链条断言，无需改。
5. **recovery_isolations 表重建**（CHECK 扩展）：其它车道若有按旧 4 值枚举写的 SQL 字面量需要同步（TS 类型已扩展）。
6. **sqlite-store upsertPlan**：新增可选 project_id 写入（缺省不变）；upsertTask 仍不落 V2 扩展列——本车道代码一律走 updateTaskFields（与 claim 路径同口径）。
7. **claim/绑定面既有失败**：p23/p3/p6/p8-loopback/p8-two-nodes/p8-fault-matrix 的失败集中在 BINDING_UNAUTHORIZED/claim 超时/merge integration_failed——归档证据（verification/3-attribution.txt）：移除本车道全部改动的快照上同样失败，属并行车道进行中改动，非本车道引入。

## 6. 验证四条原始输出（verification/ 目录）

1. `1-build.txt`：`npm run build`（tsc + copy-assets + web vite build）exit 0。
2. `2-p9-recovery.txt`：本套件 31/31 passed。
3. `3-distributed.txt` + `3-attribution.txt`：distributed 套件；6 个失败文件（p23-integration-gate/p3-node-daemon/p6-rbac/p8-fault-matrix/p8-loopback-e2e/p8-two-nodes）在「移除本车道全部改动的快照」上同样失败（归因证据），失败集中在并行车道的 claim/BINDING/merge 面。
4. `4-full.txt`：全量 128 文件 / 1619 用例，1564 passed / 52 failed / 3 skipped——52 个失败全部位于上述 6 个并行车道文件；基线 122 文件/1479 用例的文件数与通过用例数均未劣化（1564 ≥ 1479），本车道拥有/触及的文件 0 失败。

## 7. 残留风险

- 并行车道 claim/merge 面失败未收口前，全量无法回绿（本车道验证：0 文件仅因本车道失败）。
- `V2ProjectModeTransition.status` 域枚举无 'failed'，投影映射 failed→'rolled_back'（fail-closed 回到切换前形态），已注释说明。
- steps 投影的 updated_at 用 started_at 粗粒度值（表无每步时间戳；推进顺序由 step 指针表达）。
- node-driven 路径的 decision 消费入口（consumeRecoveryDecision）已具备，src/node/** daemon 侧接线属其它车道所有权。
- runControlPlaneTakeover 的 `halt_after` 为测试注入参数（生产不传）；如需完全隔离可后续抽到测试钩子。
