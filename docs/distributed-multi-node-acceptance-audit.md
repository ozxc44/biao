# 终审：§22 验收矩阵逐项证据审计（v2 终版）

> 日期：2026-08-16（v1 初审）／2026-08-16（v2 终版）
>
> 审计对象：`docs/distributed-multi-node-development-plan.md` §22 验收矩阵（22.1 功能 / 22.2 一致性 / 22.3 安全 / 22.4 故障恢复 / 22.5 跨平台），共 **99 项**。
>
> 方法：只读核查，判定**只认测试与代码，不认文档承诺**。证据路径优先 `tests/distributed/`（p0a1…p9 全部套件）、`tests/` 既有 V1 套件、`src/server/v2/**`、`src/node/**`、`src/db/migrations/**`。判定从严：找不到可指认的测试/代码即「未覆盖」。
>
> 判定口径：
> - **已覆盖**＝有测试用例（含真实 HTTP/子进程/真实 git）或可指认的实现代码直接支撑；
> - **部分覆盖**＝存在子机制（实现或测试），但矩阵要点的关键部分缺失；
> - **未覆盖**＝无可指认的测试或实现，仅设计文档/注释/路由 stub。

## v2 终版说明

- **日期**：2026-08-16。
- **范围**：v1 初审后，增强车道 **A**（凭据/ACL/Git 面：bvm2 Merge Bot 凭据、ref ACL、plan import、EvidenceAcceptance、V1 plan/question 隔离与路由分类、remote-unreachable 分类、人工 merge 回写、未登记 SHA 检测）、**B**（调度执行：merge 自动出队、daemon 真执行器、claim 前置校验、心跳 stale 自动 offline/quarantine、claim snapshot durable 接线+Redis 重建、unlockDownstream 真拓扑、双轨收口、SHA 检测异步化）、**C**（transition/recovery：24h deadline+step 推进器、写 lineage 全收口、离线 Node 不阻塞、recovery decision 信封、takeover 三崩溃点、batch 逐项、三步分权、canary）、**D**（V1 flaky 根治、Redis 重建测试、删除隔离矩阵、三方对账）、**E**（告警调度接线、SLO 升级+recurrence、stale proposed 告警、真内容冲突闭环、幂等合并断言、ownership_snapshots store 读写/重建）、**微车道**（ref ACL 接入 push/deleteRemoteRef、hasRefAcl 真实化）以及 **PM 修复**（`http-plugins.ts` 放行 bvm2_ 前缀、recovery decision 路由装配含 404 语义、三方对账路由挂载）与 **fixture 修复**，全部落地并验收。
- **全量回归**：132 文件 / 1646 用例全绿；车道 D flaky 根治后 10 连跑全绿。
- **本文档更新原则**：判定与证据路径全部替换为落地后的实存证据（已逐文件 grep/读核实用例存在性，杜绝文件头宣称与正文不符的虚报）；停留「部分覆盖」项如实保留并注明残留缺口。

## 汇总统计

| 分节 | 项数 | 已覆盖 | 部分覆盖 | 未覆盖 |
| --- | --- | --- | --- | --- |
| 22.1 功能 | 10 | 9 | 1 | 0 |
| 22.2 一致性 | 16 | 12 | 4 | 0 |
| 22.3 安全 | 23 | 17 | 5 | 1 |
| 22.4 故障恢复 | 40 | 29 | 10 | 1 |
| 22.5 跨平台 | 10 | 0 | 5 | 5 |
| **合计** | **99** | **67** | **25** | **7** |

完全覆盖率 67/99（67.7%）；已覆盖＋部分覆盖合计 92/99（92.9%）。
（v1 初审为 36/32/31；本版变化：已覆盖 +31、部分覆盖 −7、未覆盖 −24。）

---

## 22.1 功能（10 项）

| ID | 矩阵原文（摘要） | 判定 | 证据路径 | 缺口归属 |
| --- | --- | --- | --- | --- |
| 22.1-01 | 不同绝对路径的两节点共同处理同一 Project | **已覆盖** | `tests/distributed/p1-identity-data.test.ts`「两台模拟 Node 不同本地路径 → 同一 project_id（方案 Phase 1 验收场景）」；`tests/distributed/p8-two-nodes.test.ts` ①②（两节点真实子进程 enroll/register） | — |
| 22.1-02 | 不重叠任务并行执行 | **已覆盖** | `p8-two-nodes.test.ts` ③④「并发 claim：两个 task 各被一个节点认领」「各自走完整链到 delivery accepted（不同文件互不覆盖）」；`tests/distributed/p4-git-workspace.test.ts`「两个 attempt 各自 clone→各自分支→push→两个 delivery 并存」 | — |
| 22.1-03 | 重叠 Ownership 不并行写 | **已覆盖** | `tests/distributed/p0b-node-claim-race.test.ts`「同一文件不能被两个不同 task 同时声明」；`p4-git-workspace.test.ts`「attempt 在 ownership 外文件提交 → finalize 拒绝、failed:ownership_violation」 | — |
| 22.1-04 | 每个 Attempt 有独立工作区和分支 | **已覆盖** | `p4-git-workspace.test.ts`「两个 attempt 各自 clone→各自分支→push→两个 delivery 并存」；`p8-loopback-e2e.test.ts` ⑦ workspace prepare（bva2 ownership scope） | — |
| 22.1-05 | Worker 不共享本地结果目录也可 Review | **已覆盖** | `tests/distributed/p2-artifact.test.ts`「服务端无 Worker 文件挂载仍可完整 Review」；`tests/distributed/p23-integration-gate.test.ts`「PM Review V2 读回完整视图」 | — |
| 22.1-06 | 独立 acceptance 绑定 commit | **已覆盖** | `p4-git-workspace.test.ts`「pending_review → reviewing → accepted\|rejected；reject 落 cleanup；非法流转被拒」；`p8-loopback-e2e.test.ts` ⑫ PM accept；DB 唯一约束 `deliveries(attempt_id, head_sha)`（`src/db/schema.sql`） | — |
| 22.1-07 | PM accept 后 Merge Queue 合并 | **已覆盖** | `p8-loopback-e2e.test.ts` ⑫⑬「PM accept → delivery accepted」「merge queue 入队 + dispatch → merged」；`tests/distributed/p5-merge-queue.test.ts`「无冲突自动合并」；车道 B 增强：`p9-scheduling.test.ts`「入队后无人调用 dispatch → 默认分支自动前进」「连续两 delivery 串行自动合并」「dispatch 单飞去重」（`merge/queue.ts` tryAutoDispatch） | — |
| 22.1-08 | merged 后下游解锁 | **已覆盖** | `src/server/v2/merge/queue.ts:498-530` unlockDownstream 真拓扑（task depends_on 解析、全依赖 accepted/merged 才解锁、跨 plan 依赖同样处理）；`tests/distributed/p9-scheduling.test.ts`「unlockDownstream 查询 task depends_on 拓扑」 | — |
| 22.1-09 | 冲突生成明确修复路径 | **已覆盖** | `tests/distributed/p9-merge-conflict.test.ts`「两 delivery 改同一行 → 第二个 conflict + conflict_files 落库 + 默认分支不动 + 修复可 merged」（真实 git 驱动 `queue.ts` conflict 分支）、「conflict job 不触发降级且后续排队不受污染」 | — |
| 22.1-10 | repair/reverify 审计不被 Git 流程覆盖 | **部分覆盖** | `tests/acceptance-reverify.test.ts`（V1 验收修复链：reject→repair→reverify-only 独立重验，审计与 Git 流程分离，14 用例）；V2 侧 `src/server/v2/delivery-service.ts:300` 仍仅注释「rejected → Question/repair 通道」 | 后续增强：V2 Delivery repair/reverify 未实装 |

---

## 22.2 一致性（16 项）

| ID | 矩阵原文（摘要） | 判定 | 证据路径 | 缺口归属 |
| --- | --- | --- | --- | --- |
| 22.2-01 | claim、renew、report、Delivery 都有 generation fencing | **已覆盖** | `tests/distributed/p1-credentials.test.ts`「generation 不匹配拒绝：Node credential 与 Attempt token 都做 fencing」；`p1-e2e-identity.test.ts` 场景 2「验证旧 generation session 已被 fence」；`p3-node-daemon.test.ts`「SIGKILL 掉线 → 重启注册新 generation：旧 session fenced」；`p23-integration-gate.test.ts` ⑤ claim→bva2（attempt_generation 内嵌） | — |
| 22.2-02 | Git push/API response 丢失可幂等恢复 | **已覆盖** | `p4-git-workspace.test.ts`「cloning 中途 kill（残留半成品目录）→ 重入清掉半成品并收敛 ready」「committing 中途 kill → finalize 重入收敛 delivered」；`p8-fault-matrix.test.ts` 故障 D「artifact 上传中断 → pending_recovery → 补传收敛」 | — |
| 22.2-03 | Artifact/DB/Git 三方可对账 | **已覆盖** | `src/server/v2/reconcile-three-way.ts`（reconcileThreeWay：SQLite × artifact blob 目录 × git refs 三侧计数与 digest 比对）+ `src/server/v2/routes/v2-routes.ts:1313` `POST /v2/reconcile/three-way` 挂载；`tests/distributed/p9-consistency.test.ts`「22.2-03 三方对账：SQLite × artifact blob 目录 × git refs」——「三方一致：reconcile 报告无偏差」「单侧缺失：删除 blob 文件 → 命中 artifact_blob_missing」「单侧篡改：改写 blob 内容 → 命中 artifact_blob_tampered」「单侧多余：远端残留多余 attempt 分支 → 命中 git_ref_without_delivery」「gap 如实声明：git 面只做 ref 存在性与 digest 比对，不做 marker 内容验签」 | — |
| 22.2-04 | accepted branch 改写会失效 | **已覆盖** | `p4-git-workspace.test.ts`「delivery 后外部改写分支 → 服务端复核 invalidated(branch-head-changed) + 落 BranchCleanup」 | — |
| 22.2-05 | force-push 后 branch HEAD 与 Delivery 不同，Merge 拒绝并撤销 accept | **已覆盖** | `p4-git-workspace.test.ts`「CAS：finalize 前远端已存在同名 attempt 分支 → failed:cas_conflict + invalidated delivery」；`p5-merge-queue.test.ts`「CAS：外部推进→job invalidated→新 delivery+新 HEAD 重新排队成功」 | — |
| 22.2-06 | Merge CAS 防覆盖目标分支前移；rebase 生成新 Delivery 重新 Verify/Review | **已覆盖** | `p5-merge-queue.test.ts`「CAS：外部推进→job invalidated→新 delivery+新 HEAD 重新排队成功」（新 delivery 经 `deliverAttempt` 重新 finalize 验证 + `acceptDelivery` 重新验收）；`p4` 服务端 diff 二次门禁 | — |
| 22.2-07 | Redis 恢复不会开放半投影 | **已覆盖** | `p0a2-plugin-parity.test.ts`「restore 进行中：普通读 409 RESTORE_IN_PROGRESS，写 409 permit 拒绝」「restore 失败屏障：读 503 RESTORE_FAILED」「preSerialization 二次门控」；V2 Redis 清空实证：`tests/distributed/p9-redis-rebuild.test.ts`「22.4-07 Redis FLUSHDB 后 V2 调度态从 SQLite 重建」——「FLUSHDB 后 SQLite 侧调度态原样：attempt/lease/task/snapshot/session 均不消失或复活」「已 executing 的 task 在 FLUSHDB 后再次 claim → 409 ATTEMPT_ACTIVE（不开放旧 generation）」「旧 generation 的 bva2 token renew → 409 GENERATION_MISMATCH（lease 不复活）」 | — |
| 22.2-08 | stale Node 不会覆盖新 Attempt | **已覆盖** | `p1-e2e-identity.test.ts` 场景 2；`p3-node-daemon.test.ts`「SIGKILL 掉线 → 重启注册新 generation：旧 session fenced、attempt 不被二次 claim」 | — |
| 22.2-09 | ownership snapshot 在 Redis 清空后可安全重建 | **已覆盖** | claim 路由接线 durable 快照（`v2-routes.ts` claim 写 `ownership_snapshots`，finalize/ownership 校验读 durable 表）；`src/db/sqlite-store.ts:1847-1907`（insert/get/update/listOwnershipSnapshots(ByAttempt) + `rebuildOwnershipSnapshotIndex`）；`tests/distributed/p9-ops.test.ts`「从 durable 表重建运行态索引：重启后 attempt_id→files 可复原」「listOwnershipSnapshots 支持 attemptId/activeOnly 过滤」；`tests/distributed/p9-scheduling.test.ts`「claim 成功写 durable snapshot」「finalize/ownership 校验读 durable snapshot」「Redis 清空场景：可从 durable（SQLite）安全重建」「snapshot release 后不参与重建」 | — |
| 22.2-10 | durable-first outbox 在每个崩溃点可幂等重放 | **部分覆盖** | `p0b-v1-v2-baseline.test.ts`「outbox append → retry → dead letter 完整生命周期」；`p0a2-infra-schema.test.ts` outbox/idempotency 服务函数；`p8-fault-matrix.test.ts` 故障 C「控制面崩溃重启：job 持久、dispatch 收敛 merged」 | 仅验证重启后 merge job 收敛，未覆盖 outbox 自身每个崩溃点（车道 C 的三崩溃点属 takeover 面，非 outbox 面） |
| 22.2-11 | V1 Worker Token 无法 claim/report/renew 已迁移 V2 Project | **已覆盖** | `p1-credentials.test.ts`「V2 项目：worker token 的 claim/report/renew/ownership declare/release 全部 403，owner 可运维」；`v1-isolation.ts` 隔离门 | — |
| 22.2-12 | 从 V1 route registry 生成的测试证明全部 mutation 对 V2 Project 被拒绝 | **部分覆盖** | `p1-credentials.test.ts` 隔离门覆盖五个数据面 POST（claim/report/renew/ownership declare/release）；车道 A 已落地运行时隔离实现扩面：`v1-isolation.ts:60-65` `V1_PLAN_QUESTION_GUARDED_PATHS`（plan/create、submit、supersede、question/create、answer）+ `:170-205` 运行时拒绝逻辑 | 仍无「从 V1 全 mutation registry 生成、对 V2 Project 逐条拒绝」的生成式测试（plan/question 隔离有实现、无运行时测试） |
| 22.2-13 | V1 plan create/submit/supersede 与 question create/answer 由同一 registry 测试覆盖 | **部分覆盖** | `v1-isolation.ts:60-65` plan/question 五条 mutation 路由已进隔离门（实现：body project / plan_id 反查 / question_id 关联 → V2 项目拒绝）；`tests/distributed/p9-access.test.ts`「22.2-13/14: V1 路由分类门禁」（plan/create、question/answer 分类断言） | 分类断言≠隔离测试：无「V2 项目上执行 V1 plan/question mutation 被拒」的运行时用例 |
| 22.2-14 | V1 registry 中 legacy lifecycle、PM transport、maintenance、read-only 路由显式分类，未分类 mutation 构建失败 | **部分覆盖** | `src/server/v2/v1-route-classification.ts`（`V1_ROUTE_CLASSIFICATIONS`：16 条 mutation 四类显式分类 + 7 条只读路由；`getUnclassifiedMutationRoutes`）；`p9-access.test.ts`「所有 V1 mutation 路由已分类」「plan/create 属于 pm_transport」「question/answer 属于 pm_transport」「claim 属于 legacy_lifecycle」「未分类路由返回 null」「构建期门禁：未分类 mutation 路由被检出」 | 检出函数未接入构建/CI（无 scripts 引用），演示用例使用测试内造路由清单而非真实 V1 server 路由对账，「构建失败」不成立 |
| 22.2-15 | orphan recovery 创建新 Delivery 后仍须独立 acceptance | **已覆盖** | `p8-fault-matrix.test.ts` 故障 A「takeover 裁决 → attempt pending_recovery → 节点 B 重 claim 完成」（B 独立 claim generation+1 → `driveToAccepted` 独立验收 → merged） | — |
| 22.2-16 | signed marker 缺失/验签失败不会自动恢复或清理 branch | **已覆盖** | `p4-git-workspace.test.ts`「marker 被篡改/替换 → 服务端复核 invalidated(marker-invalid)」；`p3-node-daemon.test.ts` 重启后 recovery 桩保留、attempt 不重跑、不删除 | — |

---

## 22.3 安全（23 项）

| ID | 矩阵原文（摘要） | 判定 | 证据路径 | 缺口归属 |
| --- | --- | --- | --- | --- |
| 22.3-01 | Node 凭据相互独立且可撤销 | **已覆盖** | `p1-credentials.test.ts`「Node credential 往返」+「密钥轮换：撤掉旧 version 后旧 credential 拒绝」；`p6-rbac.test.ts`「Node credential 轮换：老 generation 原子替换」「revoke-all-sessions：key_version 前滚」 | — |
| 22.3-02 | Attempt Token 只能操作单任务 | **已覆盖** | `p1-credentials.test.ts`「attempt/task 归属不符拒绝：单一 token 只能操作单任务」；`src/server/v2/credentials.ts:508-523` verifyAttemptToken（SUBJECT_MISMATCH） | — |
| 22.3-03 | Worker 无 PM/Merge 权限 | **已覆盖** | `p6-rbac.test.ts` 硬规则 1「bvn2 与 bva2 对 review / review-start / merge / cancel 全部 403」；registry 派生策略门禁 | — |
| 22.3-04 | Merge Bot 无 Agent/Plan 权限 | **已覆盖** | `src/server/v2/credentials.ts:589-660`（issueMergeBotToken/verifyMergeBotToken：bvm2_ 前缀 HMAC，SUBJECT_MISMATCH / SCOPE_MISMATCH / UNKNOWN_KEY_VERSION）；`p9-access.test.ts`「22.3-04: bvm2 Merge Bot 凭据」4 用例 + 「rbac 负面矩阵 bvm2×claim/plan 403」5 用例（registry deriveCredentialPolicy：claim/report/plans-import 均禁 merge_bot，merge-jobs/dispatch 放行）；PM 修复后真实 HTTP 面：`src/server/http-plugins.ts:170` 放行 bvm2_ 前缀 + `p9-consistency.test.ts`「merge_bot 凭据通过共享 plugin 放行后，对删除类路由被 RBAC 拒绝（缺口已由 PM 修复）」 | — |
| 22.3-05 | Artifact digest、路径、大小、项目权限全部校验 | **已覆盖** | `p2-artifact.test.ts`「篡改拒绝：分片摘要不符 complete 失败且无残留 blob」「超限拒绝」「跨任务引用拒绝」「跨项目引用拒绝」「幂等重传」；`p0b-git-artifact.test.ts`「拒绝路径穿越」「拒绝超大文件」 | — |
| 22.3-06 | Agent 子进程无 Biao/Redis/SQLite 凭据 | **已覆盖** | `tests/sanitized-child-env.test.ts`「22.3-06: sanitizedChildEnv 子进程环境剥离」——「剥离全部 BIAO_\* 前缀变量（含旧清单外的任意 BIAO_ 变量）」「剥离非 BIAO_ 前缀的凭据类服务变量（REDIS_URL/REDIS_PASSWORD/REDISCLI_AUTH）」「保留白名单必需变量」「overrides 正常合并；overrides 里的 BIAO_\* 同样被剥离（fail-closed）」「不修改原对象」；`src/worker/base.ts` sanitizedChildEnv + 既有 `tests/system-bootstrap.test.ts`、`tests/worker-progress.test.ts:138-139` | — |
| 22.3-07 | 远程浏览器不使用 Local Owner Cookie | **已覆盖** | `tests/http-auth.test.ts`「does not mint a local Owner browser session for a non-loopback binding」→ 403 LOCAL_SESSION_UNAVAILABLE；「rejects a cross-site request that tries to change a local Owner session」；`src/server/http-plugins.ts:66-80` localOwnerSessionAvailable = apiToken && isLoopbackHost | — |
| 22.3-08 | 日志不泄露 Secret | **已覆盖** | `p1-credentials.test.ts` 泄漏语义「token 字符串不含密钥材料；校验结果不回显 token」「fail-fast/签发错误信息不含密钥值」；`src/server/v2/credentials.ts:21-23`；`src/server/service.ts:239-241` hasCredentialMarker 脱敏 | — |
| 22.3-09 | 恶意/失陷实现节点不能自验收进入主线 | **已覆盖** | `p4-git-workspace.test.ts`「Node 门禁被绕过（外部直推越界文件到 attempt 分支）→ 服务端独立复核拒绝 delivery」；`src/server/v2/delivery-service.ts:96-209` verifyDeliveryAgainstRemote（独立 clone→CAS→marker→diff/ownership） | — |
| 22.3-10 | generic-git ref ACL 阻止 Node 推默认分支/tag/他人 branch | **已覆盖** | `src/server/v2/git/ref-acl.ts`（checkRefAcl：deny > allow > 默认拒绝；createDefaultRefAcl；parseRefAcl 读 `projects.ref_acl_json`）；**push 路径已接线**：`src/server/v2/git/generic-git.ts:19,43,95-106`（pushAcl 配置，push/deleteRemoteRef 前对每个 refspec 逐条 checkRefAcl，拒绝即 kind=push-forbidden 且远端零触达）；`src/server/v2/git/workspace.ts:548-550`（push_forbidden 落终态不可重试误分类）；`p9-access.test.ts`「22.3-10 接线：generic-git push 前置 ref ACL（真实 bare remote）」7 用例（「push 默认分支 → kind=push-forbidden 且带 ACL 规则原因，远端零触达」「push tag → push-forbidden」「push 他人 branch → push-forbidden」「push 自身 attempt 分支 → 放行（真实 push 成功）」「push marker ref → 放行（原子推送）」「删除默认分支远端 ref 同样被 ACL 拒绝；删除 attempt 分支放行」「函数式 pushAcl 同样生效」）+ 「refspecDestinationRef 解析 push refspec 目标」4 用例 + 规则矩阵 12 用例 | — |
| 22.3-11 | 证书双信任轮换不造成集群整体离线 | **未覆盖** | 无 TLS 证书实现/测试；`docs/runbooks/security-phase6.md:27-28` 明确 TLS/证书双信任轮换（R1C-003）不在本阶段 | 方案范围外（Phase 8 分界） |
| 22.3-12 | 未授权或已 revoke 的 NodeProjectBinding 无法 claim/read/deliver | **部分覆盖** | 读侧：`p6-rbac.test.ts:493-511` + `src/server/v2/rbac.ts:289-301` NODE_PROJECT_UNBOUND；revoke 状态：`p1-e2e-identity.test.ts` 场景 3；**claim 侧已补**：`src/server/v2/routes/v2-routes.ts:565-597` claim 调度前置校验（NODE_NOT_ACTIVE / BINDING_UNAUTHORIZED / PROJECT_READ_ONLY）+ `p9-scheduling.test.ts`「NODE_NOT_ACTIVE」「BINDING_UNAUTHORIZED：未授权 binding 时拒绝 claim」「PROJECT_READ_ONLY」3 用例 | deliver 路径仍只验 bva2 token 归属、不查 binding authorization_status（已有 attempt 的 deliver 未挡） |
| 22.3-13 | 无 Remote ref ACL 的 Project 只能 read-only acceptance | **已覆盖** | `src/server/v2/plan-import.ts`：isProjectReadOnly（execution_mode / write_capability_status / **parseRefAcl(ref_acl_json)===null 即 read-only**）+ hasRefAcl 真实化（未配置/非法 JSON/allow 空 ⇒ false，fail-closed）；门禁消费：claim 409 PROJECT_READ_ONLY（`v2-routes.ts:588-596`）+ plan import 拒写；`p9-access.test.ts`「22.3-13: read-only 门禁」——「full + ready + 已配置 ref ACL 不是 read-only」「**full + ready 但未配置 ref ACL → read-only（degraded_read_only 语义）**」「配置 ref ACL 后不再 read-only」「非法 ref_acl_json 同样按未配置处理（fail-closed）」+「22.3-13: hasRefAcl 读取项目 ref ACL 配置实存性」5 用例 + 「22.3-14」内「full 项目未配置 ref ACL → 按读路径拒绝写任务」 | 残留登记：`project-service.ts` validateProject 探测口仍返回常量 `{repo_reachable:true, ref_acl_available:true}`（报告面，非门禁；不影响判定主干） |
| 22.3-14 | read-only acceptance 的 Plan import 拒绝所有写任务和写依赖，不产生永久 pending | **已覆盖** | `src/server/v2/plan-import.ts` importPlanForProject（read-only 拒写任务+写依赖、逐条 rejected_tasks、拒绝即不落库故无永久 pending；full 导入 tasks 落库+project_id 回填）；`src/server/v2/routes/v2-routes.ts:861` `POST /v2/plans/import` 实装；`p9-access.test.ts`「22.3-14: importPlan read-only 拒绝」「full 项目正常导入」「full 项目未配置 ref ACL → 按读路径拒绝写任务」；delivery 面配套：`p9-scheduling.test.ts`「proposed delivery 过期清理 + 审计」 | — |
| 22.3-15 | full Project 的 Artifact-only 任务以 EvidenceAcceptance 完成且不能解锁写 lineage | **已覆盖** | 迁移 `src/db/migrations/012_evidence_acceptances.ts` + `src/db/sqlite-store.ts:1206-1252` + `src/server/v2/plan-import.ts` createEvidenceAcceptanceForTask + `src/server/v2/routes/v2-routes.ts:1087-1113`（POST /v2/evidence-acceptances 与 /:id/review 实装）；`p9-access.test.ts`「22.3-15: EvidenceAcceptance（真实 store）」——「创建：acceptance_id 前缀 ea-、落库字段完整」「查询：listEvidenceAcceptances 按 project/attempt 命中」「**只读语义：不能解锁写 lineage——task 状态不被改为可写流转（status 保持 pending、不回填 done_at/accepted_evidence_id/completion_kind）**」「越权创建拒绝：伪造 attempt/伪造 level 均失败且不落库」 | — |
| 22.3-16 | full→read-only 先暂停/drain/cancel/invalidated，所有写 lineage 收口后才原子切换 | **已覆盖** | `src/server/v2/project-service.ts`（DRAINING_STEP_SEQUENCE 合法 step 序 + drain step 执行器逐项 pause/fence/cancel/invalidate/block + 收口完成才 `execution_mode='read-only-acceptance'` 原子切换 + DRAIN_CHECKLIST_TEMPLATE）；`tests/distributed/p9-recovery.test.ts`「22.3-18 写 lineage 全收口」——「收口清单模板覆盖 §12.1.1 六类对象」「逐项 pause/fence/cancel/invalidate/block；未收口停在 reconcile 并报告清单」「收口后重复推进不重复 invalidate/不重复 BranchCleanup（幂等）」 | — |
| 22.3-17 | ref ACL 连续确认丢失后不等待 Owner 就 fencing running write Attempt、撤销 push/merge credential | **部分覆盖** | `src/server/v2/git/ref-acl.ts` RefAclMissTracker + `p9-access.test.ts`「22.3-17: ref ACL 连续丢失熔断」4 用例（阈值/重置/独立计数）；`src/server/v2/merge/queue.ts:426-468` handleRefAclMiss 实现完整（fencing 全部 executing attempt→fenced + `write_capability_status='lost'` + incident 开单） | handleRefAclMiss 无测试驱动、无生产调用方（未接线）；「撤销 push/merge credential」以 write_capability 状态位表达，bvm2/bvn2 凭据未实际吊销 |
| 22.3-18 | full→read-only 覆盖 proposed/accepted/merging Delivery、所有 MergeJob、pending Candidate 与 blocked Task | **已覆盖** | `p9-recovery.test.ts`「22.3-18 写 lineage 全收口」（含「三类 Delivery 原子 invalidated + BranchCleanup 幂等落档」断言）+ project-service DRAIN_CHECKLIST_TEMPLATE 六类对象 | — |
| 22.3-19 | read-only→full 全量 reconcile 后只开放新 Attempt，旧 invalidated Delivery/Review 与 blocked Task 不自动复活 | **部分覆盖** | 恢复方向 step 序与重同步已实证：`p9-recovery.test.ts`「22.3-21」内「离线 Node binding suspended 不阻塞切换；回归 resync 后才恢复 eligible」+「22.3-20」内 read-only→full VALIDATING step 序逐步推进 + HTTP「POST mode-transitions（auto）→ 完整切换」；既有 `p8-rollback-window.test.ts` ⑩ 关旗/开旗不复活已 invalidated | 「旧 invalidated Delivery/Review 与 blocked Task 不自动复活」无直接断言 |
| 22.3-20 | read-only→full 的 validate-capability/reconcile/refresh-bindings/revalidate-plans step 可持久化、逐步重启续跑并受 24 小时 deadline 约束 | **已覆盖** | `src/types/v2-infra.ts:50` MODE_TRANSITION_DEADLINE_MS = 24h（修正实现曾误用的 30 分钟）+ `src/server/v2/project-service.ts`（step 序、先落库再执行、resumeInterruptedModeTransitions 启动扫描）；`p9-recovery.test.ts`「22.3-20 deadline 与 step 序列（首要项）」——「deadline 常量 = 24 小时（§12.1.1 矩阵原文），不再是 30 分钟」「read-only→full step 序列为 §4.1 合法序，逐步推进先落库再执行」「重启续跑（kill 模拟：同库重开）从 durable step 继续，副作用不重复」「超 24h deadline → expired + RecoveryIsolation 留证 + 不可重试（22.4-05 衔接）」「步骤失败置 failed 可重试：从 durable step 幂等重入」「同 project 已有 running transition 时拒绝再创建」 | — |
| 22.3-21 | 恢复 full 时离线 Node 不阻塞切换且无有效旧 credential，回归需重新同步 policy/binding | **已覆盖** | `src/server/v2/project-service.ts` resyncNodeProjectBinding + `src/server/v2/routes/v2-routes.ts:422` `POST /v2/projects/:project_id/nodes/:node_id/binding-resync`；`p9-recovery.test.ts`「22.3-21 离线 Node 不阻塞恢复」——「离线 Node binding suspended 不阻塞切换；回归 resync 后才恢复 eligible」「隔离的 candidate 不阻塞恢复 reconcile（从正常 reconcile 排除，22.4-05）」 | — |
| 22.3-22 | Node signing key 轮换后旧 marker 在审计期内仍可验签 | **部分覆盖** | `src/server/v2/git/marker.ts:101-107`（keyring 支持多 key_version，按 generation 验签）；`src/server/v2/delivery-service.ts:154-157` 按 `signing_key_generation` 选验签 key | 无 marker 轮换后旧 marker 验签的测试；marker 仍为 HMAC 替身（非真 Node 非对称密钥） |
| 22.3-23 | Control Plane Recovery Signing Key 双信任轮换、紧急 revoke、历史公钥归档不接收失效 decision | **部分覆盖** | `src/server/v2/recovery-decision.ts`：决策信封签名/验签体系（canonical payload + key_id + signature，复用控制面 keyring，pickSigningKey 取最高 key_version）；`p9-recovery.test.ts`「22.4-26/27 决策信封校验」（含「keyring 未配置 → fail-closed 不签发」「未知 key 全部拒绝」） | 双信任轮换、紧急 revoke、历史公钥归档生命周期无实现/测试 |

---

## 22.4 故障恢复（40 项）

| ID | 矩阵原文（摘要） | 判定 | 证据路径 | 缺口归属 |
| --- | --- | --- | --- | --- |
| 22.4-01 | Node 断网 | **已覆盖** | `p8-fault-matrix.test.ts` 故障 B「注入分区 → claim 停止（无新 attempt）、心跳超时、节点状态不自动降级」「分区恢复 → 心跳自愈 → drain/offline → re-register（新 session，旧 fenced）」 | — |
| 22.4-02 | Node 掉电 | **已覆盖** | `p8-fault-matrix.test.ts` 故障 A「A 执行到 finalize 中途被 SIGKILL（durable 状态停在 committing）」→ takeover → 节点 B 完成 merged | — |
| 22.4-03 | Control Plane 重启 | **已覆盖** | `p8-fault-matrix.test.ts` 故障 C「控制面崩溃重启（同库同 bare）：job 持久、dispatch 收敛 merged、主分支恰好 +1 commit」 | — |
| 22.4-04 | Control Plane 在 mode transition 每个 step 重启都从 durable step 幂等续跑 | **已覆盖** | `p9-recovery.test.ts`「重启续跑（kill 模拟：同库重开）从 durable step 继续，副作用不重复」「步骤失败置 failed 可重试：从 durable step 幂等重入（22.4-04）」+ HTTP 组「服务重启（同库新实例）从 durable step 续跑（启动扫描）」；`project-service.ts` resumeInterruptedModeTransitions | — |
| 22.4-05 | mode transition 超期隔离通过 durable RecoveryIsolation API/CLI 留证，重启后仍从正常 reconcile 排除且关闭需独立复核 | **已覆盖** | `p9-recovery.test.ts`「超 24h deadline → expired + RecoveryIsolation 留证 + 不可重试（22.4-05 衔接）」「隔离的 candidate 不阻塞恢复 reconcile（从正常 reconcile 排除，22.4-05）」；关闭独立复核＝22.4-06 三步分权全链；durable 行 + 唯一未 resolved 语义（「同一对象重复创建幂等」）；API 面：GET `/v2/recovery-isolations` + resolve 路由（`v2-routes.ts`） | 残留登记：CLI 入口未提供（`src/cli/v2/` 仅 migration/outbox）；API 面与排除语义已全验证 |
| 22.4-06 | RecoveryIsolation 强制 isolator、Reviewer、ReconcileService 三步分权，同一 actor 不能自建自审 | **已覆盖** | `src/server/v2/recovery-decision.ts`（createRecoveryIsolationRecord / reviewRecoveryIsolationRecord / resolveRecoveryIsolationRecord，RECONCILE_SERVICE_ACTOR）；`p9-recovery.test.ts`「22.4-06 RecoveryIsolation 三步分权」——「isolator 创建 → reviewer（≠isolator）复核 → reconcile 服务 resolve；全链审计」「同一对象重复创建幂等（§20.3 唯一未 resolved 语义）」 | — |
| 22.4-07 | Redis 清空 | **已覆盖** | `tests/distributed/p9-redis-rebuild.test.ts`「22.4-07 Redis FLUSHDB 后 V2 调度态从 SQLite 重建」——「世界搭建：claim 出 executing attempt（lease/ownership snapshot 落 SQLite）」「FLUSHDB 后 SQLite 侧调度态原样」「再次 claim → 409 ATTEMPT_ACTIVE」「旧 generation bva2 renew → 409 GENERATION_MISMATCH」「gap 如实声明：清空重建验证以 SQLite 为真相源」+ `p9-scheduling.test.ts` 目标 5（Redis 清空场景从 durable SQLite 安全重建）；V1 面 `tests/crash-recovery.test.ts` FLUSHDB 保留 | — |
| 22.4-08 | SQLite 备份恢复 | **部分覆盖** | `p7a-ops.test.ts`「drill：生产库字节不变」（restore 到隔离副本）；`tests/cli-db-restore.test.ts` restore CLI 灾难恢复门槛（5 用例）；`p0a1-migrations.test.ts` 备份副本演练 | 真实生产库全量恢复（含 Git/Artifact 对账）未演练 |
| 22.4-09 | Git Remote 暂时不可用 | **部分覆盖** | 错误分类已实现：`src/server/v2/git/provider.ts:37` 'remote-unreachable' kind + `src/server/v2/git/generic-git.ts:98`（unreachable 判定→remote-unreachable 分类）；`p9-access.test.ts`「22.4-09: Git Remote 不可用」（kind 合法性断言） | remote 不可用 → degraded/暂停/退避探测/恢复 reconcile 的行为链无实现/测试 |
| 22.4-10 | Artifact Store 暂时不可用 | **部分覆盖** | `p8-fault-matrix.test.ts` 故障 D「artifact 上传中断 → delivery pending_recovery → 补传收敛」 | 整个 Artifact Store 不可用（暂停 complete/Delivery、本地保留 bundle）未测 |
| 22.4-11 | Merge 过程中服务重启 | **已覆盖** | `p8-fault-matrix.test.ts` 故障 C（merge 期间控制面重启 → 幂等收敛，主分支恰好 +1 commit） | — |
| 22.4-12 | 磁盘满 | **已覆盖** | `p4-git-workspace.test.ts`「磁盘水位超限（注入）→ failed:disk_watermark；阈值边界 84/85」 | — |
| 22.4-13 | Agent 进程失控 | **已覆盖** | `src/worker/base.ts:710-714` SIGTERM→SIGKILL 进程树升级（detached 组 leader / Windows taskkill /T /F）；`tests/pm-agent.test.ts`（crashed SIGKILL）、`tests/supervisor-runtime.test.ts` | — |
| 22.4-14 | 节点时钟快/慢超过阈值 | **已覆盖** | `p3-node-daemon.test.ts`「NodeClock 纯逻辑：skew 计算 + 30/60/120 阈值档位 + 只紧不松」「子进程注入 +15s 时钟偏差」；`p0b-fault-injection.test.ts` 时钟偏差注入 | — |
| 22.4-15 | TLS 证书轮换与到期 | **未覆盖** | 无实现/测试；Phase 8 分界（见 22.3-11） | 方案范围外（Phase 8 分界） |
| 22.4-16 | branch 已 push 但 Delivery 未创建 | **已覆盖** | `p8-fault-matrix.test.ts` 故障 A「lease 过期 → workspace-recovery 扫描 → orphan candidate（node-offline-timeout）」→ takeover → 补 Delivery | — |
| 22.4-17 | 同一 restore point 的 SQLite/Git/Artifact/Audit 全量恢复与冒烟 | **部分覆盖** | `p7a-ops.test.ts`「restore_point 三个 digest 齐全」+「drill：生产库字节不变」（仅 SQLite 组件冒烟）；三方对账（`p9-consistency.test.ts` / `reconcile-three-way.ts`）提供偏差检测但不属恢复演练 | `src/server/v2/backup.ts:111-115` gitRefsDigest 仍为占位；Git/Artifact 组件恢复冒烟未实现 |
| 22.4-18 | outbox 卡死会开 Incident、degraded 并可按 revision 重放 | **部分覆盖** | 开 Incident 已接线调度：`src/server/v2/alert-scheduler.ts`（createAlertScheduler：setInterval 周期驱动 runAlertEvaluation + escalateOverdueIncidents，unref、重复 start 幂等、inCycle 防重入）+ `p9-ops.test.ts`「runOnce 驱动告警求值：outbox 死信超阈值自动开 incident」「去重：同 fingerprint 未 resolve 不重开」「ack 未 resolve 也不重开」「start() 定时驱动：短间隔注入触发周期并自动开单」「interval env 可调」 | 生产进程未挂载调度器（src/ 全局无 createAlertScheduler 调用方）；无 stall 检测自动 degraded、无按 revision 重放（`src/server/v2/outbox.ts` 无相关实现） |
| 22.4-19 | dead-letter 只能 requeue 或 compensating event 收口，不能跳过 | **已覆盖** | `src/cli/v2/outbox.ts` 命令集仅 list/show/requeue/compensate；`registry.ts`「无 skip/mark-delivered 接口」；`p7a-ops.test.ts`「Dead-letter 处置」（requeue/compensate）；`p0b-v1-v2-baseline.test.ts`「outbox compensating event 基线」 | — |
| 22.4-20 | dead-letter API/CLI 展示 revision/digest/error，requeue 原键且 compensate 有审计关联 | **已覆盖** | `src/cli/v2/outbox.ts` cmdShow 打印 aggregate_revision/payload_digest/last_error；requeue 原键（event_id）；**compensate 已写审计**（`cli/v2/outbox.ts:217-230`：insertAuditEvent，actor=cli 操作者、correlation=dead-letter event_id）；`p7a-ops.test.ts`「22.4-20：CLI compensate 写审计行（actor=cli 操作者、correlation=dead-letter event_id）」 | 残留登记：API 层 compensate（`v2-routes.ts:1397`）仍不落审计行（CLI 通道已实证） |
| 22.4-21 | 隔离 restore drill 不写真实 Remote | **已覆盖** | `src/server/v2/backup.ts:181-252` restoreDrill：复制 SQLite 到隔离 drill 目录 readonly 打开、integrity_check、digest 比对、冒烟、rmSync；`p7a-ops.test.ts`「drill：生产库字节不变」（production_unchanged=true） | — |
| 22.4-22 | quarantine 解除必须 re-enroll | **已覆盖** | `src/server/v2/node-service.ts:364-437` checkStaleNodes（心跳 stale 自动 offline + running attempt 进 pending_recovery；连续多次 stale → quarantine + session fencing）+ `:96-105` re-enroll 递增 credential_generation；`tests/distributed/p9-scheduling.test.ts`「目标 4: heartbeat stale 自动 offline/quarantine」——「心跳超阈值 → node 自动 offline + running attempt 进 pending_recovery」「连续多次 stale → quarantine + session fencing」「正常心跳的 node 不受影响」（补上 v1 审计记录的 Phase 9 自动 quarantine 缺口） | — |
| 22.4-23 | 进入 quarantine 立即 fencing/cancel running Attempt 并撤销 Git/signing credential | **部分覆盖** | `node-service.ts` revoke 递增 credential_generation + session fencing；checkStaleNodes quarantine 路径将 running attempt 置 pending_recovery + task 指针释放 | 不 cancel running Attempt（置 pending_recovery 而非终态）、不撤销 Git/signing credential（无凭据吊销动作） |
| 22.4-24 | 人工 merge 回写 fixed Delivery、Integration Verify 和下游解锁 | **已覆盖** | `src/server/v2/merge/queue.ts:634-669` writebackExternalMerge（delivery → merged + merged_commit_sha=final_sha + server_verified=0 待复核标记 + diff_summary 审计记录 + unlockDownstream 调用）；`p9-access.test.ts`「22.4-24: writebackExternalMerge 人工 merge 回写（真实 store）」——「回写后 delivery merged + final_sha，且标记待复核」「审计可见：delivery.diff_summary 记录 merged_by=external + final_sha + writeback_at」「下游解锁调用发生：unlockDownstream 触发 queued 扫描」「跨项目回写 → PROJECT_MISMATCH；不存在 → DELIVERY_NOT_FOUND（拒绝路径无副作用）」 | — |
| 22.4-25 | Node 重启在 claim 前扫描 recovery bundle，未获 signed decision 不删除 | **部分覆盖** | `src/node/daemon.ts:418-439` run() 先 scanOrphans 再进 claim 循环；recovery bundle 桩写入 pending_recovery 且从不删除；车道 B 落地真执行器：`src/node/real-executor.ts` + `p9-scheduling.test.ts`「RealExecutor 全链执行：prepare → execute → finalize → report」「RealExecutor prepare 失败时停止后续链」「RealExecutor recordStopped 写 recovery bundle」（消除 claim NOT_IMPLEMENTED stub 缺口）；`p3-node-daemon.test.ts`「SIGKILL 掉线 → 重启注册新 generation」 | daemon 侧不消费 signed decision（grep `src/node/daemon.ts` 无 recovery-decision 引用）：「未获 signed decision 不删除」的裁决消费未接线 |
| 22.4-26 | recovery decision 缺字段、签名错误、key generation 被 revoke 或超过 15 分钟时拒绝并幂等重新获取 | **已覆盖** | `src/server/v2/recovery-decision.ts`（signRecoveryDecision 信封：schema_version/candidate_id/candidate_revision/decided_by/issued_at/expires_at=15min/key_id/signature；verifyRecoveryDecisionEnvelope 校验链）+ `src/server/v2/routes/v2-routes.ts:1269` decision 路由已装配（PM 修复，含 404 语义）；`p9-recovery.test.ts`「22.4-26/27 决策信封校验」——「TTL 常量 = 15 分钟；签发信封含 candidate revision + decided_by + expires_at」「keyring 未配置 → fail-closed 不签发」「缺字段 / 签名错误 / TTL 过期 / 未来签发 / 未知 key 全部拒绝」「一次性消费：同一信封二次提交 → DECISION_ALREADY_CONSUMED」；HTTP 面验证：`p9-consistency.test.ts`「decision 路由已装配（PM 修复），cleanup/keep/isolate 语义可用」 | — |
| 22.4-27 | recovery decision 以 heartbeat server time 单调偏移验 TTL | **已覆盖** | `recovery-decision.ts` RECOVERY_DECISION_SKEW_TOLERANCE_MS（决策 issued_at 早于 candidate revision 写入时间−容差即拒绝）；`p9-recovery.test.ts`「REVISION_STALE：决策 revision 落后 candidate 当前 revision」「DECISION_NOT_MONOTONIC：决策时间早于 candidate revision 时间-容差（22.4-27）」 | — |
| 22.4-28 | 永久失联 Node 的 Candidate 在 lease/session fencing 后由控制面 CAS takeover，Node 驱动路径不会双重裁决 | **已覆盖** | `recovery-decision.ts` runControlPlaneTakeover：candidate CAS（pending→decided，revision+1，信封留档）、lease 未过期 fail-closed（"watchdog/session fencing 前不得 takeover"）、attempt CAS（executing+lease 过期才 fencing）、task 指针 CAS；`p9-recovery.test.ts`「lease 未过期时 takeover fail-closed（前置条件）」「REVISION_STALE」；Node 驱动路径走信封一次性消费（DECISION_ALREADY_CONSUMED）无双裁决 | — |
| 22.4-29 | control-plane takeover 在 CAS 后、创建恢复 Delivery 后、更新 Attempt 后分别崩溃都按 Candidate revision/status 与确定性 Delivery 键续跑 | **已覆盖** | `p9-recovery.test.ts`「22.4-29 takeover 三崩溃点续跑」——「崩溃点 1（决策落库后）：重入收敛，CAS 不重复递增 revision」「崩溃点 2（任务回 pending 前一步）：从 release-task 续跑」「崩溃点 3（新 attempt 创建后）：重入 no-op，不 fence 新 attempt、不产生双 attempt」 | — |
| 22.4-30 | 同一 outage 的批量 takeover/isolate 仍为每个 Candidate 保留独立证据、actor 和结果 | **部分覆盖** | `v2-routes.ts` batch-actions 逐 candidate 返回 results[]；`p9-recovery.test.ts`「takeover 批次：成功项带 revision/最终状态，失败项带错误码，互不影响」 | evidence/actor 仍共享 body.reason/decided_by（`recovery-decision.ts` runBatchRecoveryActions 单一 input），非逐 Candidate 独立 |
| 22.4-31 | 批量 takeover/isolate 逐项部分成功，响应返回每项 revision/error，重试不重复成功项 | **已覆盖** | `p9-recovery.test.ts`「takeover 批次：成功项带 revision/最终状态，失败项带错误码，互不影响」「discard 批次：重试不重复成功项（幂等返回当前 revision/终态）」+ HTTP 组「HTTP batch-actions 逐项结果（22.4-31 API 面）」 | — |
| 22.4-32 | rejected/superseded/conflict/integration_failed/invalidated Delivery 全部自动创建 BranchCleanup | **已覆盖** | `src/server/v2/delivery-service.ts:264-288` enqueueBranchCleanup 接受全部终态（rejected/superseded/conflict/integration_failed/invalidated/mode_transition）；`p4-git-workspace.test.ts`「reject 落 cleanup」「invalidated + 落 BranchCleanup」；`merge/queue.ts` merged branch 也清理；`p9-recovery.test.ts` 22.3-18 组「三类 Delivery 原子 invalidated + BranchCleanup 幂等落档」 | — |
| 22.4-33 | BranchCleanup retry 遇 Remote ref 不存在时幂等记 deleted；删除只由专用身份执行 | **已覆盖** | 幂等：`delivery-service.ts:522-527` runDueBranchCleanups（missing → 'deleted'）；`p4-git-workspace.test.ts`「BranchCleanup 到期删除前复核 HEAD；幂等 missing；head 已变化则拒绝」；**身份隔离矩阵**：`tests/distributed/p9-consistency.test.ts`「22.4-33 删除身份隔离：rbac 角色 × 删除类路由拒绝路径」——「矩阵：owner/project_admin/reviewer/auditor/node/attempt × 删除类路由」「revoke-all-sessions 拒绝路径：非 owner 角色逐断言 403」「merge_bot 凭据通过共享 plugin 放行后，对删除类路由被 RBAC 拒绝」；删除面收窄：`generic-git.ts:12` 破坏性命令面收窄到 deleteRemoteRef（branch cleanup 专用，且受 push ACL 约束，`p9-access` deleteRemoteRef 用例） | — |
| 22.4-34 | Recovery signing canary 失败开 Incident，Candidate fail closed，恢复后重签复验 | **已覆盖** | `p9-recovery.test.ts`「22.4-34 canary fail-closed」——「首个迁移 plan 验证失败 → transition failed 并保持 read-only，不继续批量」「canary 通过但后续 plan 失败 → 同样 fail-closed（批量守门）」 | — |
| 22.4-35 | Incident resolve 有 typed evidence，且不绕过 Node 状态机 | **部分覆盖** | `incident-service.ts:140-173` resolve 必须非空 evidence（EVIDENCE_REQUIRED）；`p7a-ops.test.ts`「resolve 必须附带 evidence」 | evidence 仍为自由字符串非 typed enum；无 Node 状态机联动验证 |
| 22.4-36 | Incident 超 resolution SLO 提醒；同 detector 再触发创建 recurrence 记录 | **已覆盖** | 迁移 `src/db/migrations/011_incident_sla_recurrence.ts`（resolution_sla_minutes / recurrence / escalated 三列）；`src/server/v2/metrics.ts`（DEFAULT_RESOLUTION_SLA_MINUTES、escalateOverdueIncidents、computeRecurrence、告警 incident 落 resolution_sla）；`p9-ops.test.ts`「复发：resolve 后窗口内重开计 recurrence」「超 resolution SLO 未 resolve 升级 severity 一次」「升级写审计事件」 | — |
| 22.4-37 | proposed Delivery 超过 4 小时未 Review 产生可指派告警 | **已覆盖** | `src/server/v2/metrics.ts`（stale_proposed_delivery 规则 + collectStaleDeliveries，env BIAO_V2_STALE_DELIVERY_HOURS 可调）+ `p9-ops.test.ts`「pending_review 超过阈值开 incident 且含 delivery_id/age」「proposed 状态同样纳入 stale 检查」「阈值 env 可调」；配套「proposed delivery 过期清理 + 审计」（`p9-scheduling.test.ts`） | 阈值口径：矩阵写 4 小时，实现默认 48h（env 可调至 4）；从严口径可记部分 |
| 22.4-38 | 默认分支出现无 MergeJob/external intent 的 SHA 时触发 maintenance、credential revoke、审计化 revert、Integration Verify 与三方 reconcile 演练 | **部分覆盖** | 检测已实现并异步化测试：`merge/queue.ts:676-707` detectUndocumentedShas（merged jobs final_sha ∪ verified external intents final_sha ↔ 真实 ls-remote 默认分支比对）+ `p9-scheduling.test.ts`「detectUndocumentedShas 异步化：真实 ls-remote 比对」「detectUndocumentedShas 已登记 SHA 不报为 undocumented」 | 检测到未登记 SHA 后的 maintenance/credential revoke/审计化 revert/Integration Verify/三方 reconcile 演练整条响应链无实现；检测函数未挂路由 |
| 22.4-39 | 旧 Node credential/session generation 被拒绝 claim、heartbeat、Artifact upload 和 Delivery | **已覆盖** | `v2-routes.ts:84-122` verifyNodeBearer expectedGeneration（CREDENTIAL_FENCED）；`p6-rbac.test.ts`「轮换后旧 token heartbeat 409 CREDENTIAL_FENCED」「revoke-all 后旧 bvn2/bva2/bvh2 全部失效」；`p1-credentials.test.ts` generation mismatch；`p3-node-daemon.test.ts` 旧 session fenced 不重 claim；`p9-redis-rebuild.test.ts` FLUSHDB 后旧 generation renew 409 | — |
| 22.4-40 | 重复 claim/report/deliver 只返回原实体或稳定冲突，不产生第二个 Attempt/Delivery | **已覆盖** | `p0b-node-claim-race.test.ts`「两个 Node 同时 claim 同一 task 只有一个赢家」「非 owner report 失败」；`p3-node-daemon.test.ts` 零重复 claim；`p5-merge-queue.test.ts`「幂等入队」；**单用例合并断言已补**：`tests/distributed/p9-idempotency.test.ts`「重复 claim 返回原 attempt 实体 + 重复 enqueue 不双写」（同 claim_request_id 返回原实体 claim_token 不变；同 delivery 键 enqueue 稳定返回原 job、queued 不双写）；`p2-artifact.test.ts`「幂等重传」 | — |

---

## 22.5 跨平台（10 项）

| ID | 矩阵原文（摘要） | 判定 | 证据路径 | 缺口归属 |
| --- | --- | --- | --- | --- |
| 22.5-01 | macOS arm64 | **部分覆盖** | `templates/node/biao-node.launchd.plist` + `src/node/templates.ts:33`（占位符全登记）；`p3-node-daemon.test.ts:902`「launchd/systemd 关键语义齐备」 | 运行时 OS/arch 检测缺失（register 时 os/arch 硬编码空串，`node-service.ts:113-114`）；异 OS 实跑属 Phase 8 人工段 |
| 22.5-02 | Linux x64 | **部分覆盖** | `templates/node/biao-node.service` + `p3-node-daemon.test.ts:902-912`（KillSignal/TimeoutStopSec/Restart/EnvironmentFile 断言） | 同 22.5-01：无 x64 检测、无实机 |
| 22.5-03 | Windows x64 | **部分覆盖** | `templates/node/install-windows.ps1` + `biao-node-service.ps1` + `p3-node-daemon.test.ts:916`「Windows 产物（R1C-004 最小集）：Credential Manager、事件日志源、drain 控制文件、幂等安装与回滚」 | 无 x64 检测；实跑验证未完成（`docs/runbooks/biao-node.md:185`） |
| 22.5-04 | Windows PowerShell 安装、Credential Manager、Service 启停/升级/卸载 | **部分覆盖** | install-windows.ps1 Install/Uninstall/Start/Stop/Drain/Status + PasswordVault + sc.exe create + 回滚 + 卸载清理 + drain-on-stop；**Upgrade 已补**：`tests/distributed/p9-template-upgrade.test.ts`「22.5-04: install-windows.ps1 Upgrade 命令」——「Upgrade 键存在：ValidateSet 已登记且 switch 有对应分支」「升级包参数：-UpgradeSource 已声明且缺省/不存在时 fail-fast」「步骤顺序：stop 先于 start」「步骤顺序：凭据备份先于二进制替换」「备份/恢复 helper 已定义：凭据经 DPAPI 加密落盘，不留明文」「模板占位符纪律」 | Windows 实跑验证仍未完成（Phase 8 人工段）；Upgrade 为静态断言非实跑 |
| 22.5-05 | 大小写冲突 | **未覆盖** | 无 case-collision 检查（`generic-git.ts`/`workspace.ts`）；`cas_conflict` 是 CAS 远端 ref 冲突非大小写冲突 | Phase 8 人工段（异 OS 验收，`runbooks/phase8-rollout.md:141-143`） |
| 22.5-06 | CRLF/LF | **部分覆盖** | `generic-git.ts` `core.autocrlf=false`（服务端 clone 强制，`runbooks/git-workspace.md:176`） | 无 `.gitattributes`（§19.2 仅建议）、无 CRLF/LF 测试 |
| 22.5-07 | executable bit | **未覆盖** | 无 core.fileMode/.gitattributes mode 处理；仅 marker 文件 chmod 0o600（`workspace.ts:406`，非工作树文件） | Phase 8 人工段（异 OS 实机） |
| 22.5-08 | symlink | **未覆盖** | git 层无 symlink 处理/测试；无关 security 测试均 skipIf(win32) | Phase 8 人工段（异 OS 实机） |
| 22.5-09 | submodule fallback | **未覆盖** | 仅设计决策 D-018（`plan:1931`）；无 submodule/gitlink/recurse-submodules 代码或测试 | Phase 8 人工段（真实项目） |
| 22.5-10 | 非文本 Office 文件独占 | **未覆盖** | §6.7 `exclusive_patterns` 仅设计文档；binary 检测存在（`generic-git.ts` diffStat binary）但无消费端独占策略 | Phase 8 人工段（真实项目） |

---

## 未覆盖项清单（v2 终版）

### 一、属 Phase 8 人工段（异 OS / 真实项目 / 人工 Merge Queue，剧本已交付待用户执行）

| 项 | 判定 | 说明 |
| --- | --- | --- |
| 22.5-05 | 未覆盖 | 大小写冲突需 APFS/ext4/NTFS 异 OS 实机（`runbooks/phase8-rollout.md:141-143`） |
| 22.5-07 | 未覆盖 | executable bit 需异 OS 实机 |
| 22.5-08 | 未覆盖 | symlink 语义需异 OS 实机 |
| 22.5-09 | 未覆盖 | submodule fallback 需真实项目 |
| 22.5-10 | 未覆盖 | Office 二进制独占需真实项目 |

（22.5-01/02/03/04/06 为「部分覆盖」：运行时 OS/arch 检测与 Windows/macOS/Linux 实跑（含 Upgrade 实跑）只可在 Phase 8 人工段闭合；Upgrade 命令面已由 p9-template-upgrade 静态覆盖。）

### 二、属方案范围外（Phase 8 分界，本阶段明确不实施）

| 项 | 说明 |
| --- | --- |
| 22.3-11 | TLS 证书双信任轮换：`runbooks/security-phase6.md:27-28` 明确不在本阶段 |
| 22.4-15 | TLS 证书轮换与到期：同上 |

### 三、停留「部分覆盖」的残留缺口（25 项，要点级缺口未关闭）

| 项 | 残留缺口 |
| --- | --- |
| 22.1-10 | V2 Delivery repair/reverify 未实装（仅 V1 链有测试） |
| 22.2-10 | outbox 自身每个崩溃点幂等重放未覆盖（takeover 三崩溃点≠outbox 面） |
| 22.2-12 | 无「V1 全 mutation registry 生成、对 V2 Project 逐条拒绝」的生成式隔离测试 |
| 22.2-13 | plan/question 隔离有实现（V1_PLAN_QUESTION_GUARDED_PATHS）、无运行时隔离测试 |
| 22.2-14 | 分类检出函数未接入构建/CI，未对真实 V1 server 路由清单对账 |
| 22.3-12 | deliver 路径不查 binding authorization_status（claim/read 已补） |
| 22.3-17 | handleRefAclMiss 无测试且未接线；凭据撤销以 write_capability 状态位表达 |
| 22.3-19 | 「旧 invalidated Delivery/Review 与 blocked Task 不自动复活」无直接断言 |
| 22.3-22 | 无 marker 轮换后旧 marker 验签测试；marker 仍为 HMAC 替身 |
| 22.3-23 | Recovery Signing Key 双信任轮换/紧急 revoke/历史公钥归档无实现 |
| 22.4-08 | 真实生产库全量恢复（含 Git/Artifact 对账）未演练 |
| 22.4-09 | remote 不可用仅错误分类；degraded/退避探测/恢复 reconcile 行为链无 |
| 22.4-10 | Artifact Store 整体不可用（暂停 complete/Delivery、本地保留 bundle）未测 |
| 22.4-17 | gitRefsDigest 仍占位；Git/Artifact 组件恢复冒烟未实现 |
| 22.4-18 | 告警调度器未挂生产进程；无 stall degraded、无按 revision 重放 |
| 22.4-23 | quarantine 不 cancel running Attempt（置 pending_recovery）、不撤销 Git/signing credential |
| 22.4-25 | daemon 侧不消费 signed decision（扫描与真执行器已落地） |
| 22.4-30 | batch evidence/actor 共享 body.reason/decided_by，非逐 Candidate 独立 |
| 22.4-35 | Incident evidence 仍自由字符串，非 typed enum；无 Node 状态机联动 |
| 22.4-38 | 未登记 SHA 仅检测；maintenance/revoke/审计化 revert/演练响应链无 |
| 22.5-01 | os/arch 运行时检测缺失；实跑属 Phase 8 |
| 22.5-02 | 同 22.5-01 |
| 22.5-03 | Windows 实跑验证未完成 |
| 22.5-04 | Upgrade 为静态断言；Windows 实跑未完成 |
| 22.5-06 | 无 .gitattributes 强制、无 CRLF/LF 测试 |

### 残留登记（判定已覆盖、但留有非关键缺口，供后续增强追踪）

- 22.3-13：`project-service.ts` validateProject 探测口仍返回常量 `{repo_reachable:true, ref_acl_available:true}`（报告面非门禁）。
- 22.4-05：RecoveryIsolation CLI 入口未提供（API 面完整）。
- 22.4-20：API 层 compensate 不落审计行（CLI 通道已实证）。
- 22.4-37：stale 阈值默认 48h 与矩阵 4h 不一致（env 可调）。
- 22.2-03：git 面对账只做 ref 存在性与 digest 比对，不做 marker 内容验签（p9-consistency「gap 如实声明」用例明示）。

---

## 判定不确定性说明（v2 终版）

1. **22.3-13（无 ref ACL ⇒ read-only）**：判「已覆盖」依据行为链实证——isProjectReadOnly 消费 `ref_acl_json`（未配置/非法 fail-closed ⇒ read-only）、claim 409 PROJECT_READ_ONLY、plan import 拒写（p9-access 8 用例）。`validateProject` 探测口仍返回常量，属 capability 报告面而非门禁，已入残留登记；若按「探测口也必须真验」从严口径，可回退「部分覆盖」。
2. **22.4-05（RecoveryIsolation API/CLI）**：判「已覆盖」取「API 或 CLI 其一」语义（API 留证 + 从正常 reconcile 排除断言 + 关闭独立复核全链测试）；若按「API 与 CLI 并列」从严口径，应回退「部分覆盖」（CLI 缺）。
3. **22.4-20（compensate 审计关联）**：判「已覆盖」依据 CLI 通道 insertAuditEvent + p7a 用例；API 层 compensate 仍不落审计行（残留登记）。若要求 API 层同等落审计，应回退「部分覆盖」。
4. **22.4-37（stale 阈值）**：判「已覆盖」但矩阵 4h 与默认 48h 存在口径差；env BIAO_V2_STALE_DELIVERY_HOURS 可调至 4。从严口径可记「部分覆盖」。
5. **22.3-10（ref ACL）**：v1 判定后曾被识别为「规则引擎有测试但 push 未接线」（部分覆盖风险）；微车道已将 pushAcl 接入 `generic-git.push/deleteRemoteRef` 并以真实 bare remote 7 用例实证（拒绝发生在 push 之前、远端零触达），本版升「已覆盖」。
6. **22.3-17（ref ACL 熔断）**：handleRefAclMiss 实现完整（fencing+lost+incident）但无测试驱动且无生产调用方，与 22.3-10 不同——熔断触发链未闭合，维持「部分覆盖」。
7. **22.4-24（人工 merge 回写）**：v1 曾记录 p9-access 文件头宣称与正文不符（无 writeback 用例）；车道 A 补测后已有真实 store 4 用例（含下游解锁触发与拒绝路径无副作用），本版升「已覆盖」。
8. **防虚报核查记录**：v1 审计后发现的「文件头宣称与正文不符」（p9-access 头部第 6/10 点）、「注释宣称与代码不符」（ref-acl.ts push 接线、hasRefAcl 占位、validateProject 硬编码）均已在本版证据更新时以正文 describe/实现 grep 逐条复核，宣称性证据一律不采用。
