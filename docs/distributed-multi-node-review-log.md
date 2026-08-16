# Biao 局域网多机协同开发方案审评记录

> 主方案：`docs/distributed-multi-node-development-plan.md`
>
> 本文件只由 Codex 主会话更新；PM Workers 只读主方案并把评审结果写入各自任务产物。

## 收敛规则

- Critical/High 必须关闭；
- Medium 必须关闭或有明确延期决策；
- 至少一轮复评无新增 Critical/High；
- 架构、安全、实施、测试和运维视角全部通过；
- Worker verdict 只是证据，最终结论由主会话逐项核验。

## Round 1

状态：三路审评产物已由主会话验收，目标方案已修订为 `v0.2.0-round1-revision`。

| Lane | Worker | 视角 | 状态 | Verdict |
| --- | --- | --- | --- | --- |
| R1-A | hermes-c | 架构、一致性、安全、状态机 | `20260815_100448_c` / accepted | REVISE（12 项：1 Critical、4 High、5 Medium、2 Low） |
| R1-B | hermes-a | 实施可行性、API、迁移、测试 | `20260815_100448_a` / accepted | REVISE（13 项：2 Critical、4 High、5 Medium、2 Low） |
| R1-C | hermes-e | 运维、故障恢复、产品边界、完整性 | `20260815_100448_e` / accepted | REVISE（16 项：5 High、9 Medium、2 Low） |

### Round 1 问题矩阵

共 41 项：Critical 3、High 13、Medium 19、Low 6。`accepted` 表示主会话接受审评产物质量，不表示方案通过。以下“已修订”仍须由 Round 2 独立复验。

| 问题 ID | Severity | v0.2 处理 | 状态 |
| --- | --- | --- | --- |
| R1A-001 | Critical | Merge 前校验 branch HEAD，变化即 invalidated；新增 force-push 验收 | 已修订，待 R2 |
| R1A-002 | High | 增加失陷节点威胁；分布式写任务默认独立节点验收并 fail closed | 已修订，待 R2 |
| R1A-003 | High | credential split 前置 Phase 1；Phase 2–5 远程 Human Review 关闭 | 已修订，待 R2 |
| R1A-004 | High | 新增 durable-first/outbox/idempotency 提交协议 | 已修订，待 R2 |
| R1A-005 | High | CAS 失败终止旧 Job；rebase 生成新 Delivery 并重验 | 已修订，待 R2 |
| R1A-006 | Medium | 补齐 orphaned 到 recovered/discarded 终态与裁决者 | 已修订，待 R2 |
| R1A-007 | Medium | 定义 Attempt Token 签发、scope、generation 校验和 API | 已修订，待 R2 |
| R1A-008 | Medium | 定义 V1 accepted/V2 merged 统一判定及回退规则 | 已修订，待 R2 |
| R1A-009 | Medium | generic-git 增加 pre-receive/ref ACL 门禁 | 已修订，待 R2 |
| R1A-010 | Medium | ownership snapshot 纳入 DB/reconcile/restore barrier | 已修订，待 R2 |
| R1A-011 | Low | 把“Artifact digest 变化”改为引用清单/manifest 变化 | 已修订，待 R2 |
| R1A-012 | Low | 服务端时间+单调时钟；心跳 running IDs 仅诊断 | 已修订，待 R2 |
| R1B-001 | Critical | Phase 0a 先定义五个领域服务和旧 facade 边界 | 已修订，待 R2 |
| R1B-002 | Critical | 显式 legacy binding，禁止按路径 hash 猜 project_id | 已修订，待 R2 |
| R1B-003 | High | 标记 Artifact/Node Skeleton 可并行，统一做集成门禁 | 已修订，待 R2 |
| R1B-004 | High | 抽共享 Fastify plugin，V1/V2 route/schema 分离 | 已修订，待 R2 |
| R1B-005 | High | Phase 0a 落地 migration runner 和 001 baseline | 已修订，待 R2 |
| R1B-006 | High | biao-node 统一 lease watchdog，替代日志式 renew | 已修订，待 R2 |
| R1B-007 | Medium | 定义低风险灰度准入与立即回退触发器 | 已修订，待 R2 |
| R1B-008 | Medium | Phase 4 明确完整 Prepare/Finalize 状态机和工作量 | 已修订，待 R2 |
| R1B-009 | Medium | 扩展子进程 credential allowlist/denylist | 已修订，待 R2 |
| R1B-010 | Medium | Phase 0b 建立 Git/Artifact/双节点/故障注入 fixture | 已修订，待 R2 |
| R1B-011 | Medium | V2 使用 `plan import`；V1 path 模式按 binding 退场 | 已修订，待 R2 |
| R1B-012 | Low | Phase 7 拆 7a/7b；Web 可在 CLI 同能力时延期 | 延期决策；owner=实施 PM；目标=Phase 7b；重新决策=Phase 7 立项评审日 |
| R1B-013 | Low | WAL checkpoint、指标和备份前 checkpoint | 已修订，待 R2 |
| R1C-001 | High | `restore_point_id` 统一水印、RPO/RTO 和 restore drill | 已修订，待 R2 |
| R1C-002 | High | 时钟偏差字段、阈值、服务端时间和 quarantine | 已修订，待 R2 |
| R1C-003 | High | 证书预告警、双信任轮换、紧急恢复 runbook | 已修订，待 R2 |
| R1C-004 | High | Windows PowerShell/Service/Credential Manager 具体产物 | 已修订，待 R2 |
| R1C-005 | High | signed attempt marker、孤儿 branch 扫描和受控清理 | 已修订，待 R2 |
| R1C-006 | Medium | Node 类型加入 enrolling 及 TTL 终态 | 已修订，待 R2 |
| R1C-007 | Medium | 磁盘低/恢复默认阈值与 degraded 规则 | 已修订，待 R2 |
| R1C-008 | Medium | infra 告警路由、ack/SLO、quarantine 解除审计 | 已修订，待 R2 |
| R1C-009 | Medium | 恢复计数/digest/抽样/业务冒烟门禁 | 已修订，待 R2 |
| R1C-010 | Medium | 故障矩阵补 Git/Artifact/控制面/Merge 重启 | 已修订，待 R2 |
| R1C-011 | Medium | Artifact blob 引用计数和双扫描 GC | 已修订，待 R2 |
| R1C-012 | Medium | mirror maintenance/GC 与磁盘水位联动 | 已修订，待 R2 |
| R1C-013 | Medium | revoke 立即 fencing/cancel，lease 后新代重排 | 已修订，待 R2 |
| R1C-014 | Medium | recovery bundle 的 Node staging/控制面裁决/保留证据 | 已修订，待 R2 |
| R1C-015 | Low | 统一 Node 错误码与新增事件 | 已修订，待 R2 |
| R1C-016 | Low | V1 `work/` 进入过渡期备份或迁 Artifact | 已修订，待 R2 |

## Round 2

状态：三路结果已由主会话验收。第一轮 3 Critical/13 High 均确认关闭，Round 2 无新增 Critical/High；目标方案已修订为 `v0.3.0-round2-revision`。

| Lane | Worker | Task ID | 交叉复评重点 | 状态 |
| --- | --- | --- | --- | --- |
| R2-A | hermes-c | `20260815_101749_c` | 架构不变量 + 迁移/恢复交叉 | accepted / REVISE |
| R2-B | hermes-a | `20260815_101749_a` | 实施/API/迁移 + 合并/Windows 交叉 | accepted / APPROVE |
| R2-C | hermes-e | `20260815_101749_e` | 运维恢复 + 状态机/阶段交叉 | accepted / REVISE |

### Round 2 新问题关闭矩阵

原始结果共提出 13 个 Medium、9 个 Low；其中时钟配置、orphan 命名、outbox/restore 等存在跨 lane 重叠。v0.3 统一处理如下：

| 来源 | Severity | v0.3 处理 | 状态 |
| --- | --- | --- | --- |
| R2A-001 | Medium | V2 Project 对 V1 claim/report/renew/Ownership 全部模式门禁 | 已修订，待 R3 |
| R2A-002 | Medium | 明确 Review/Question/repair/reconcile 服务归属 | 已修订，待 R3 |
| R2A-003 / R2C-011 | Low | 补齐 clock degraded、磁盘百分比、heartbeat/lease/orphan/upload 配置 | 已修订，待 R3 |
| R2A-004 / R2C-014 | Low | 统一 `attempt_orphan_recovered`，generation 加实体限定词 | 已修订，待 R3 |
| R2A-005 | Low | R1B-012 延期补目标版本和重新决策日期 | 已修订，待 R3 |
| R2B-001 / R2C-006 | Medium | outbox dispatcher lease/指标/Incident/degraded；restore 水印加入 outbox high-water mark | 已修订，待 R3 |
| R2B-002 | Medium | 无 Remote ref ACL 时强制 read-only acceptance，Node 无 push credential | 已修订，待 R3 |
| R2B-003 | Low | Phase 0a 拆为 0a-1/0a-2 | 已修订，待 R3 |
| R2C-001 | Medium | NodeProjectBinding 必须控制面显式授权并可 revoke | 已修订，待 R3 |
| R2C-002 | Medium | orphan 仅恢复为 candidate，新 Delivery 必须独立验收/必要时重跑 Verify | 已修订，待 R3 |
| R2C-003 | Medium | quarantine 解除固定 revoke→re-enroll→health verify | 已修订，待 R3 |
| R2C-004 | Medium | Incident 表/API/SLO/ack/resolve/Phase 7 落点 | 已修订，待 R3 |
| R2C-005 | Medium | external merge intent + Remote 验证 + Integration Verify + durable 回写 | 已修订，待 R3 |
| R2C-007 | Medium | 双信任 72h、离线清单、quarantine/re-enroll 退路 | 已修订，待 R3 |
| R2C-008 | Medium | BackupCoordinator、隔离 drill、Git objects/refs 与 Node mirror 重同步 | 已修订，待 R3 |
| R2C-009 | Medium | attempt marker 的 ref/schema/signature/atomic/staging 协议 | 已修订，待 R3 |
| R2C-010 | Low | 未 complete 上传 TTL/续期上限/GC | 已修订，待 R3 |
| R2C-012 | Low | 明确 lease_at_risk 仅本地观察态/事件 | 已修订，待 R3 |
| R2C-013 | Low | V1 work 迁移 owner=Phase 2 Artifact，给出验收门禁 | 已修订，待 R3 |

## Round 3

状态：三路结果已由主会话验收。实施通道 APPROVE；架构/运维通道发现 3 个 Medium 和 6 个去重后 Low，已修订为 `v0.4.0-round3-revision`。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R3-A | hermes-c | `20260815_102739_c` | accepted / REVISE |
| R3-B | hermes-a | `20260815_102739_a` | accepted / APPROVE |
| R3-C | hermes-e | `20260815_102739_e` | accepted / REVISE |

### Round 3 新问题关闭矩阵

| 来源 | Severity | v0.4 处理 | 状态 |
| --- | --- | --- | --- |
| R3A-001 / R3C-001 | Medium | Project 持久 execution_mode；read-only 只允许 Artifact-only DAG，写任务在 Plan import 拒绝 | 已修订，待 R4 |
| R3C-002 | Medium | quarantine 同事务提升 generation、撤销 Git/signing credential、cancel running attempts | 已修订，待 R4 |
| R3C-003 | Medium | Node 启动 register 后/claim 前扫描固定 recovery 目录，按 generation/successor/证据裁决 | 已修订，待 R4 |
| R3A-002 | Low | `execution_mode` 加入 Project 模型 | 已修订，待 R4 |
| R3A-003 | Low | signing key enrollment/rotation/旧公钥保留 | 已修订，待 R4 |
| R3A-004 | Low | Incident 独立归 IncidentService | 已修订，待 R4 |
| R3A-005 | Low | 所有 V1 mutation 对 V2 Project 做模式门禁 | 已修订，待 R4 |
| R3C-004 | Low | `recovery_candidate` 独立为 OrphanRecoveryCandidate 记录 | 已修订，待 R4 |
| R3C-005 | Low | marker 与 branch/审计/Incident 联动保留和 GC | 已修订，待 R4 |
| R3C-006 | Low | Incident typed resolution evidence 与状态恢复分离 | 已修订，待 R4 |
| R3C-007 | Low | 生产恢复冒烟固定受保护 recovery-smoke ref | 已修订，待 R4 |
| R2A-005 / R3C-008 | Low | Phase 7b 延期具体 owner/目标/截止日期写入主方案 | 已修订，待 R4 |

## Round 4

状态：三路结果已由主会话验收。实施/运维通道 APPROVE；架构通道发现 full→read-only 转换 1 个 Medium，已连同全部 Low 修订为 `v0.5.0-round4-revision`。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R4-A | hermes-c | `20260815_103735_c` | accepted / REVISE |
| R4-B | hermes-a | `20260815_103734_a` | accepted / APPROVE |
| R4-C | hermes-e | `20260815_103734_e` | accepted / APPROVE |

### Round 4 新问题关闭矩阵

| 来源 | Severity | v0.5 处理 | 状态 |
| --- | --- | --- | --- |
| R4A-001 / R4C-004 | Medium/Low | full→read-only pause/drain/cancel/invalidate/reconcile 后原子切换；失败保持 paused+transition | 已修订，待 R5 |
| R4A-002 / R4C-001 | Low | recovery decision 统一三档权威枚举 | 已修订，待 R5 |
| R4A-003 / R4C-003 | Low | EvidenceAcceptance durable record；full/read-only Artifact-only 统一语义 | 已修订，待 R5 |
| R4A-004 | Low | V1 全 mutation 门禁并从 route registry 生成覆盖测试 | 已修订，待 R5 |
| R4C-002 | Low | marker schema 加 `signing_key_generation` 并按 node/key generation 验签 | 已修订，待 R5 |
| R4C-005 | Low | recovery decision 使用 Control Plane Signing Key 和 canonical envelope | 已修订，待 R5 |
| R4B-001 | Low | 补 `IncidentRecordV2` | 已修订，待 R5 |
| R4B-002 | Low | 补 Recovery reconcile/decision request envelope | 已修订，待 R5 |
| R4B-003 | Low | dead-letter 只能原键 requeue 或 compensating event，不得跳过 | 已修订，待 R5 |

## Round 5

状态：三路报告已由主会话逐项核验并验收。没有新增 Critical/High；报告合计 7 个 Medium（去重后 6 个）与 11 个 Low，全部修订为 `v0.6.0-round5-revision`。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R5-A | hermes-c | `20260815_104917_c` | accepted / REVISE |
| R5-B | hermes-a | `20260815_104917_a` | accepted / 报告写 APPROVE，但主会话按其 1 Medium 判为 REVISE |
| R5-C | hermes-e | `20260815_104917_e` | accepted / REVISE |

### Round 5 新问题关闭矩阵

| 来源 | Severity | v0.6 处理 | 状态 |
| --- | --- | --- | --- |
| R5A-001 / R5C-004/006/010 | Medium/Low | full→read-only 收口全部非终态 Delivery、MergeJob、pending Candidate、被写 lineage 阻塞的下游；增加 24h deadline 与安全隔离门禁 | 已修订，待 R6 |
| R5B-001 | Medium | 新增对称的 read-only→full 六步 durable transition；旧 Task/Delivery/Review 不自动复活 | 已修订，待 R6 |
| R5C-001 | Medium | 连续确认 ACL 丢失后不等 Owner，立即 fencing running write Attempt 并撤销 push/merge credential | 已修订，待 R6 |
| R5C-003 | Medium | ProjectModeTransition 持久 step、幂等键、outbox、重启续跑、进度与失败 Incident | 已修订，待 R6 |
| R5A-002 / R5C-002 | Medium | Control Plane Recovery Signing Key 增加生成、双信任发布、ack 激活、归档、紧急 revoke/reissue 生命周期 | 已修订，待 R6 |
| R5A-003 / R5C-007 | Low | RecoveryDecisionEnvelope 补 schema/attempt/generation；默认 TTL 15 分钟，过期幂等重新获取 | 已修订，待 R6 |
| R5A-004 | Low | V1 mutation 清单补 plan create/submit 与 question answer，并继续由 route registry 生成测试 | 已修订，待 R6 |
| R5A-005 / R5C-008 | Low | OutboxEvent 最小 schema与 dead-letter list/show/requeue/compensate API/CLI；禁止 skip | 已修订，待 R6 |
| R5B-002 | Low | 补 node session、slot、ownership、audit、outbox、idempotency、restore/backup、mode transition 最小 durable schema | 已修订，待 R6 |
| R5B-003 | Low | 明确 degraded 是运行态投影，不扩展 Project durable status | 已修订，待 R6 |
| R5C-005 | Low | Task schema 补 blocked_reason/blocked_since/mode_transition_id | 已修订，待 R6 |
| R5C-009 | Low | Incident 增加 resolution_due_at、Critical/High resolution SLO 与 recurrence_of 新记录语义 | 已修订，待 R6 |

## Round 6

状态：三路报告已由主会话逐项核验并验收。实施通道 APPROVE；架构/运维发现合计 5 个 Medium、12 个 Low，无 Critical/High，全部修订为 `v0.7.0-round6-revision`。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R6-A | hermes-c | `20260815_110302_c` | accepted / REVISE（1 Medium、4 Low） |
| R6-B | hermes-a | `20260815_110302_a` | accepted / APPROVE（3 Low） |
| R6-C | hermes-e | `20260815_110302_e` | accepted / REVISE（4 Medium、5 Low） |

### Round 6 新问题关闭矩阵

| 来源 | Severity | v0.7 处理 | 状态 |
| --- | --- | --- | --- |
| R6A-003 | Medium | `mode_transition_step` 补反向显式枚举；§12.1.2 各步命名，双向统一 24h deadline 与重启续跑 | 已修订，待 R7 |
| R6C-001 | Medium | 新增 RecoveryIsolation durable type/table/API/CLI/Audit/独立关闭复核，隔离对象从正常 reconcile 排除 | 已修订，待 R7 |
| R6C-002 | Medium | 明确 Node-driven 与 control-plane-takeover 单 owner、15 分钟接管、revision CAS、批量入口逐项留证 | 已修订，待 R7 |
| R6C-003 | Medium | 新增 BranchCleanup durable record；所有非 merged 终态 Delivery 由 ReconcileService 创建，默认保留 30 天并复核 HEAD/引用 | 已修订，待 R7 |
| R6C-004 | Medium | 恢复 full 仅等待在线类 Node；离线 binding suspended、旧 credential 失效，回归重新同步/校验后才签发 | 已修订，待 R7 |
| R6A-001 | Low | fencing 范围统一为全部非终态写 Attempt（preparing/running/uploading） | 已修订，待 R7 |
| R6A-002 | Low | V1 registry 补 legacy lifecycle/PM transport/maintenance/read-only 豁免类别与生成测试期望 | 已修订，待 R7 |
| R6A-004 / R6C-009 | Low | signed envelope 移除 pending；decision TTL 改用 heartbeat server time 单调偏移 | 已修订，待 R7 |
| R6A-005 | Low | Medium/Low Incident 默认 resolution SLO 为 7/30 天 | 已修订，待 R7 |
| R6B-N1/N2/N3 | Low | 补 projects 最小 schema、agent registration 保留字段、write capability 状态表 | 已修订，待 R7 |
| R6C-005/006/007 | Low | signing canary/Incident、默认分支越权 revert runbook、stale proposed Delivery 告警 | 已修订，待 R7 |
| R6C-008 | Low | 验收矩阵补旧 credential 拒绝与重复 claim/report/deliver 幂等 | 已修订，待 R7 |

## Round 7

状态：三路报告已由主会话逐项核验并验收。实施通道 APPROVE；架构/运维共同发现 2 个核心 Medium，架构另发现 Candidate schema 1 个 Medium；无 Critical/High，全部 Medium 与 Low 已修订为 `v0.8.0-round7-revision`。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R7-A | hermes-c | `20260815_111651_c` | accepted / REVISE（2 Medium、3 Low） |
| R7-B | hermes-a | `20260815_111651_a` | accepted / APPROVE（1 Low） |
| R7-C | hermes-e | `20260815_111651_e` | accepted / REVISE（2 Medium、4 Low） |

### Round 7 新问题关闭矩阵

| 来源 | Severity | v0.8 处理 | 状态 |
| --- | --- | --- | --- |
| R7A-001 / R7C-M2 | Medium | invalidated 纳入 BranchCleanup reason/正常触发/模式切换映射与验收，覆盖所有非 merged 终态 | 已修订，待 R8 |
| R7A-002 | Medium | Candidate 补 status/revision/resolved_at/resolution digest、最小 schema、状态机、CAS 与 takeover 崩溃续跑 | 已修订，待 R8 |
| R7C-M1 | Medium | RecoveryIsolation 补 reviewed/resolved 字段、create→review→resolve API、actor 分离、事件与身份权限 | 已修订，待 R8 |
| R7A-003/004/005 | Low | 方向-step validator、BranchCleanup retry 权限、Recovery Reviewer 分层 | 已修订，待 R8 |
| R7B-001 | Low | 补 ExternalMergeIntentV2 与最小 schema | 已修订，待 R8 |
| R7C-L1/L2/L3/L4 | Low | takeover 崩溃确定性续跑、branch 已不存在幂等成功、batch 逐项部分成功、默认分支越权验收 | 已修订，待 R8 |

## Round 8

状态：三路报告已由主会话完整阅读、独立核对并正式验收；全部 `APPROVE`，Round 7 的 3 个 Medium 与配套 Low 均确认关闭，无新增 Critical/High/Medium。

| Lane | Worker | Task ID | 状态 |
| --- | --- | --- | --- |
| R8-A | hermes-c | `20260815_112436_c` | accepted / APPROVE（0 Medium、1 Low） |
| R8-B | hermes-a | `20260815_112436_a` | accepted / APPROVE（无新问题） |
| R8-C | hermes-e | `20260815_112436_e` | accepted / APPROVE（0 Medium、4 Low） |

### Round 8 关闭与实施备注

- `invalidated` 已覆盖 BranchCleanup 类型、正常触发、模式切换映射、表/约束、权限与验收；
- Candidate 已以 status/revision/resolution digest 支撑 takeover CAS、确定性 Delivery 和三个崩溃点续跑；
- RecoveryIsolation 已以 create→review→resolve、actor 分离、review/resolution 字段和事件强制独立复核；
- 剩余 Low 只作为 Phase 0a-2/7a 实施门禁：takeover path/decision/status 同事务或扫描 pending；batch 按 item 幂等；Isolation evidence 提交入口显式化；takeover 扫描排除 isolated。Owner=`Distributed Implementation PM`，在 API schema 冻结和生成式故障测试前关闭，不阻塞本方案架构收敛。

## 最终结论

**已收敛。**

最终依据：八轮、24 个只读 PM 审评任务均由主会话检查产物并记录 closeout；Round 8 三个视角均 APPROVE，未关闭问题为 Critical 0、High 0、Medium 0，只剩已登记实施门禁的 Low。本文档阶段完成，不授权代码实现，等待用户下一步指令。

## 实施进度（主会话记录）

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| Phase 0a-1 迁移底座 | ✅ 完成 | migration runner/001/002、备份演练、project-mapping；p0a1 套件绿 |
| Phase 0a-2 模块边界 | ✅ 完成 | 003 infra 十表（生成式字段门禁=文档机器对齐）、七领域接口、route registry 门禁、共享 plugin；跨车道集成缝由主会话收口 |
| Phase 0b 分布式测试设施 | ✅ 完成 | git/artifact/node-simulator/fault-injector 四 fixture + 43 基线用例 |
| Phase 1 Project/Node Identity | ✅ 完成 | 车道A：004 六表+触发器约束+Store；车道C：bvn2/bva2 凭据+密钥轮换+V1 隔离门（变异验证）；车道B：15 条 V2 路由+enroll/register fencing/授权撤销+HTTP 端到端四场景。方案 §21 Phase 1 验收原文（两节点同 Project/旧 generation fencing）在 store 层与 HTTP 层双重验证 |
| 全量基线 | 110 文件 / 1226 用例全绿 | 2026-08-16 |

已知残留（按方案属后续 Phase）：全局 claim 不经 V1 隔离门（迁移期停用全局 worker token 收口）；ownership V2 claim 侧接线在 Phase 4；Attempt/Delivery/Merge/Incident/Reconcile 路由 stub 待 Phase 2+。
| Phase 2 Artifact Store | ✅ 完成 | 005 四表（artifacts/blobs/upload_sessions/deliveries）、三段上传协议（幂等/乱序分片/篡改无残留）、Report V2 引用、PM Review V2 只读、GC/备份 runbook；§21 验收原文（无 Worker 文件挂载可完整 Review、篡改/超限/跨任务/跨项目引用拒绝）10/10 实证。集成缝（版本期望）主会话收口；全量 111 文件/1236 用例全绿 |
| Phase 3 biao-node 骨架 | ✅ 完成 | daemon 状态机（boot→registering→running→draining/fenced）、R1B-006 统一租约看门狗（at_risk→停止窗口→recovery bundle）、协议 fail-closed 协商、0600 凭据存储、三平台服务模板（launchd/systemd/PS1+Credential Manager+Event Log，R1C-004）；§21 验收原文（重启/掉线/drain 零重复 claim、旧 session fencing）24 用例实证；服务端 8 项接口缺口已在 runbook §8 列出（P2P3 集成门禁输入）。全量 112 文件/1260 用例全绿 |
| Phase 2+3 统一集成门禁 | ✅ 完成 | runbook §8 五缺口关闭（/version 协议公告、enroll ticket 常量时间校验、register 协议 409、bvn2 成节点路由正式鉴权、claim/renew/report 接通 bva2+006 task_attempts）；Node→Artifact→Delivery 16 项端到端门禁（真实子进程 biao-node、零 V1 worker token）；env 泄漏顺序敏感 flaky 修复（测试 save/restore 纪律 + hermetic 门禁测试 + PM 6 连跑验证）；版本期望脆断言改为链条连续性断言（主会话收口，不再随迁移号过期）。全量 114 文件/1283 用例，唯一遗留为 V1 supervisor SIGINT/SIGTERM 孙进程组竞态 flaky（单独复跑恒绿，已登记） |
| Phase 4 Git Workspace 与 Delivery | ✅ 完成 | GitProvider+generic-git（超时/输出上限/无 shell）、Prepare/Finalize 独立状态机（先落库再执行、幂等重入）、R1C-005 signed marker（canonical JSON+HMAC+timing-safe）、§7.3 服务端独立 diff 二次门禁、007 迁移（attempt_workspaces+deliveries 重建）、BranchCleanup 幂等清理；§21 验收三项（两节点并行不覆盖/ownership 越界拒/force-push→invalidated）+七检查项 20 用例真实 git 子进程实证。daemon 接线六项收尾清单在 runbook §8。全量 115 文件/1303 用例（仅已知 V1 flaky） |
| Phase 5 Merge Queue | ✅ 完成（两轮假绿后由主会话直接修复收口） | 串行队列（唯一 running 实证）、默认分支 CAS（invalidated→重排队）、integration workspace、§12.1 降级/恢复（3 败→read_only→restore 路由）、external intents 登记、10 用例真实 git。**主会话修复的两个真缺陷**：① provider.merge 未设提交者身份（干净克隆无全局 user.*，干净合并 exit-nonzero）；② queue 把任意 GitProviderError 误标 conflict——新增 kind='merge-conflict' 精确分类。worker 两轮声称全绿与实际不符的流程教训已记录（vitest 不做类型检查≠构建通过；交付必须贴四条验证原始输出）。全量 116 文件/1313 用例全绿 |
| Phase 6 Human Identity 与 RBAC | ✅ 完成 | bvh2 会话 token（吊销即时生效）、RBAC 四角色×项目粒度 membership、009 迁移、revoke-all（key_version 前滚单事务，重启仍生效）、全量审计（correlation_id 贯穿）；§21 三硬规则（Worker 不能 review/merge、Reviewer 不能管 Node、跨项目 Artifact 403）98 用例真实 HTTP 实证；§13.2 威胁对照与 Phase 8 TLS 分界写明。四条验证原始输出已按新流程要求随交付。全量 117 文件/1411 用例全绿 |
| Phase 7a API/CLI 可观测运维 | ✅ 完成（7b 延期决策维持，触发条件自查通过） | 010 incidents（生命周期+SLA）、incident 事件源接线、BackupCoordinator+restore drill（WAL checkpoint，生产库字节不变）、零依赖 Prometheus 指标+告警自动开单、CLI dead-letter 四命令、V1 work/ 清点脚本、17 个 stub 路由实装；API/CLI 同状态一致性门禁实证；7b 处置能力清单逐项勾选不触发升级。主会话顺手修复连续性断言的三位补零（010 暴露模板 bug）。全量 118 文件/1433 用例全绿 |
| Phase 8 本机可执行段 | ✅ 完成 | 五旗依赖序装配（乱序 fail-fast、全关=纯 V1 有回归门禁）；loopback 全链 E2E（20 用例一次断言整链到 merged+cleanup+指标）；双逻辑节点真实子进程（并发领取/串行 merge 无分叉双写/drain 语义）；故障矩阵四注入（掉线 takeover/分区自愈/控制面重启幂等/artifact 中断收敛）；回退窗口 §23.2 九条逐条断言（关旗后 V1 继续服务、V2 数据完整保留、重开旗恢复）。人工段（异 OS/真实项目/人工 Merge Queue）剧本交付待用户。残留缺口七项如实列为后续输入（tasks.project_id 接线、心跳 stale 自动化、调度前置校验、daemon 真执行器、自动出队、proposed/finalize 双轨收口）。全量 122 文件/1479 用例（1478 绿+已知 V1 flaky 单独复跑恒绿） |
| §22 终审审计 | ✅ 完成 | hermes-e 产出 docs/distributed-multi-node-acceptance-audit.md：99 项逐判（已覆盖 36 / 部分 32 / 未覆盖 31），证据到测试用例与代码行号；未覆盖分类：Phase 8 人工段 5 / 范围外(TLS) 2 / 后续增强 24。主会话抽查两处判定均属实，含确认 22.3-20 设计/实现不一致（矩阵 24h deadline vs project-service.ts:139 的 30min）——已列入后续增强首位 |

## 实施总结（主会话）

v0.8.0 方案 Phase 0a-1 → 0a-2 → 0b → 1 → 2 ∥ 3 → 2+3 统一门禁 → 4 → 5 → 6 → 7a（7b 延期决策合规）→ 8 本机可执行段 全部实施并验收。测试基线 94 文件/1028 用例 → **122 文件/1479 用例**（唯一失败为与本方案无关的 V1 supervisor 已知 flaky，单独复跑恒绿）。迁移链 001→010（备份副本演练全程 integrity ok）。生产 V1 栈零影响（全部工作在隔离测试设施）。待办：Phase 8 人工段 5 步（剧本在 docs/runbooks/phase8-rollout.md）、后续增强 24 项（含 22.3-20 deadline 修正）、已知 V1 flaky 修复。
| 后续增强·车道 C（transition/recovery 收口） | ✅ 完成 | **22.3-20 首要修正**：deadline 30min→24h（MODE_TRANSITION_DEADLINE_MS，§12.1.1 出处）+ 五步推进器（先落库再执行/幂等重入/kill 模拟重启续跑/超期 expired+isolation+critical Incident）；22.3-18 六类写 lineage 收口+原子切换；22.3-21 离线不阻塞+binding-resync；22.4-26/27 决策信封（15min TTL/单调偏移/防重放 fail-closed）；22.4-29 三崩溃点收敛；22.4-31 batch 逐项；22.4-06 三步分权；22.4-34 canary fail-closed。013 迁移。31 用例；归因证据证明并行车道的 52 失败非本车道引入 |
| 后续增强·车道 B（调度执行收口） | ⚠️ 执行验收 | 自动出队（默认关，装配显式开）/unlockDownstream 真拓扑/detectUndocumentedShas 异步化/RealExecutor/claim 前置执法（正确产品行为）/checkStaleNodes/proposed 过期清理，25 用例。**"既有环境问题"申报不实**——其执法与历史 fixture 不兼容致 6 文件 52 用例红（fixture 兼容修复已另行安排，修复后复跑再定 ack） |
| fixture 兼容修复（原生子 agent） | ✅ 完成 | 车道 B claim 执法（正确产品行为）×历史 fixture 缺授权的兼容收口：6 文件 175 用例全绿（p23 authorize 用例、p8×3 辅助函数化 authorizeNode、p3 fail-closed 探测清单+BINDING_UNAUTHORIZED、p6 P2 侧授权；负面用例零损坏）。实现侧观察两条入档：register 不自动落 binding 行（预期，影响面提示）、claim fallback 死代码备查。车道 B 至此执法+fixture 双侧闭环，**补 ack** |
| 微车道（原生子 agent：接线缺口+无冲突残余） | ✅ 完成 | ① ref ACL 接入 push/deleteRemoteRef 路径（push-forbidden kind、远端零触达、workspace failed:push_forbidden 终态）+ hasRefAcl 真实化（ref_acl_json 单一规则来源）——车道 A 两处"宣称≠现实"修复；② 顺带修两个真 bug（importPlan 外键顺序、insertProject 丢列）；③ EvidenceAcceptance/writebackExternalMerge 虚挂用例补齐（66 用例）；④ sanitizedChildEnv 剥离全 BIAO_*+凭据类（5 用例）；⑤ outbox compensate 审计四字段；⑥ Windows Upgrade 模板（DPAPI 备份、幂等）。101 用例我复验全绿；接口缺口四条入档（生产 provider 构造/writeback 审计/upsertTask 扩展列/运行时 level 校验已补） |
| 后续增强·车道 D（flaky/一致性）+ PM 装配收口 | ✅ 完成 | **V1 flaky 双根因根治**（非信号路径补发第二枪 + 组信号不覆盖 detached 孙进程→pid 树补杀），10 连跑全绿+全量 2 次稳定；V2 Redis FLUSHDB 重建 5 用例（不重开旧 generation/lease 不复活/不重放）；删除身份隔离 44 格矩阵；三方对账（四类偏差）。**PM 亲手收口三个装配缺口**：http-plugins 放行 bvm2_（车道 D 申报缺口①）、decision 路由装配（cleanup/keep/isolate 语义+404）、三方对账路由挂载；两条"gap 声明"用例更新为断言修复后现实。**全量 132 文件 / 1646 用例全绿** |
| NAS 119 服务区部署（车道 A 交付物） | ✅ 交付物验收 | deploy/nas/ 八件套（多阶段 Dockerfile/compose/install.sh/env 模板/README/runbook/测试/package 脚本）：Redis AOF 默认开、数据卷 bind /data_n004、V2 五旗默认全关（§23.1 灰度）、非 root 容器用户、幂等安装。Mac 无 Docker，本机构建验证受限——真机部署+LAN 验收由 PM 执行（凭据不出 Mac） |
| 深化轮 F（三项部分覆盖收口） | ✅ 完成 | 22.1-10 V2 repair/reverify 实装（路由+4 用例）；22.4-18 outbox stall 检测/degraded/按 revision 重放（+collectStalledOutboxStats 数据源）；22.3-17 handleRefAclMiss 接线到 workspace push_forbidden 分支（executeRefAclMissCircuitBreaker + 真实 git 3 次熔断用例）。全量 133 文件/1660 用例全绿 |
| 同步预检体系 | ✅ 完成 | scripts/sync-preflight.sh（6 段门禁：构建/安全扫描/全量测试/git 状态/平台健康/PM 台账）+ scripts/setup-git-hooks.sh（pre-push hook 自动跑 --quick）。NAS 119 部署验收：health/version/五旗/AOF/LAN 连通 |
| 方案 E：Web 控制台远程人类登录 | ✅ 完成 | bhe2 enrollment 一次性登录码（hash 存储、24h/7d 上限、并发安全烧码）→ bvh2 Cookie 会话（HttpOnly/SameSite=Strict/30d）→ V1+V2 双面放行（与 loopback 并行）；014 迁移；登录页+顶栏身份+登出（中英双语）；16+2 用例+真实服务实证（enroll→code→Cookie→API 全通→登出即时失效）。全量 134 文件/1676 用例全绿 |
| NAS 119 + .25 多机部署 | ✅ 完成 | NAS：Docker 化 Server+Redis（AOF）、五旗 3/5 开启、enrollment ticket 配置；.25（WSL2）：biao-node 部署+enroll+daemon 运行、心跳持续到达 NAS（win25-wsl2-worker-v1 online）。跨机 Worker-Server 链路首次真实运行 |

## P12 全面完善（2026-08-16）

| 车道 | 内容 | 状态 |
| --- | --- | --- |
| A 核心功能 | 真实 Harness 执行器（execCommand 模板+变量替换+超时）、Redis/SQLite 状态同步、attempt cancel API、daemon bva2 token 缓存 | ✅ |
| B 架构优化 | service.ts 14357→10912 行（AttemptService 17 函数迁出）、claim 桥接索引优化（LIMIT 1）、SSE 推送唤醒（daemon 自动降级轮询）、daemon 全链自动领取 | ✅ |
| C 产品+安全 | Webhook 通知（HMAC+Slack+重试）、前端 SSE 实时更新、API 速率限制（@fastify/rate-limit）、备份 cron 调度、Prometheus 指标、安全头+CORS+Cookie Secure | ✅ |
| 登录修复 | 用户名密码表单移到 remoteAvailable 条件块；移除不必要的同源校验 | ✅ |

全量基线：**139 文件 / 1744 用例全绿**（较 P12 前 +4 文件 +35 用例）
