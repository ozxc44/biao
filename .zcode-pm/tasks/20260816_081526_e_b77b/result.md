## 终审完成：§22 验收矩阵逐项证据审计

### 产出文件
`docs/distributed-multi-node-acceptance-audit.md`（新建，中文，只读审计，未改任何 src/tests/docs）

### 审计方法
- 对 §22 全部 **99 项**（22.1×10 / 22.2×16 / 22.3×23 / 22.4×40 / 22.5×10）逐项判定为 **已覆盖 / 部分覆盖 / 未覆盖**，每项引用具体测试文件+用例名或实现文件+行号。
- 证据来源：全部 27 个 `tests/distributed/` 套件用例名逐一提取，叠加 3 路并行只读 Explore 子代理深挖安全/故障/跨平台 3 类证据，并对 mode transition、EvidenceAcceptance、RecoveryIsolation、dead-letter、BranchCleanup、v1 隔离门等实现文件做了人工复核。未运行任何破坏性命令，未改代码。

### 覆盖率统计
| 分节 | 已覆盖 | 部分 | 未覆盖 |
|---|---|---|---|
| 22.1 功能 | 7 | 3 | 0 |
| 22.2 一致性 | 9 | 5 | 2 |
| 22.3 安全 | 7 | 6 | 10 |
| 22.4 故障恢复 | 13 | 13 | 14 |
| 22.5 跨平台 | 0 | 5 | 5 |
| **合计** | **36** | **32** | **31** |

完全覆盖率 36.4%，已覆盖＋部分 68.7%。

### 未覆盖 31 项按三类归属（详见文档）
- **Phase 8 人工段（5 项）**：22.5-05/07/08/09/10 —— 大小写冲突、executable bit、symlink、submodule、Office 独占，需异 OS/真实项目实机
- **方案范围外（2 项）**：22.3-11、22.4-15 —— TLS 证书双信任轮换（runbook 明示不在本阶段）
- **后续增强（24 项）**：V1 plan/question mutation 隔离（22.2-13/14）、merge_bot 凭据、generic-git ref ACL、read-only 门禁（Plan import / EvidenceAcceptance / 无 ref ACL 降级）、full↔read-only 完整收口、Recovery Signing Key 生命周期、mode transition 多步续跑、recovery decision 签名/TTL、takeover 崩溃点、batch 逐项结果、canary、resolution SLO/recurrence、stale-proposed 告警、默认分支越权检测等

### 关键判定不确定性（文档末 7 条）
1. 22.2-07/22.4-07 「Redis 恢复」：现有证据是 DB-restore barrier + V1 FLUSHDB，V2 无 Redis 清空→DB 重建专门测试，可从严降为未覆盖
2. 22.4-40 重复 claim/deliver 证据分散、无合并断言，可从严视为部分覆盖
3. 22.3-20 矩阵要求 24h deadline，代码实现为 **30 分钟**且只实现 `pause` 一步（设计/实现不一致）
4. 22.1-09 名为「冲突场景」的 p5 用例实为外部推进 CAS 失败，非内容冲突

### 残余风险
- 部分「部分覆盖」判定保留了「路由/实现 stub 存在」这一实现证据（如 EvidenceAcceptance、batch-actions），若按纯测试口径可再下修为未覆盖
- 21 项未覆盖已在前序审评 review-log 登记为 Low 实施门禁，多数属调度/接线类 Phase 2+/9 缺口，不阻塞架构收敛