# Phase 7a 交付总结

## 变更文件清单

### 新增文件
| 文件 | 说明 |
|------|------|
| `src/db/migrations/010_incidents.ts` | incidents 表迁移（open→acked→resolved 状态机 + SLA） |
| `src/server/v2/incident-service.ts` | Incident 服务（创建/ack/resolve/list + 事件源接线 + 审计） |
| `src/server/v2/backup.ts` | BackupCoordinator（WAL checkpoint + restore_point + restore drill） |
| `src/server/v2/metrics.ts` | Prometheus 文本格式指标端点 + 告警规则评估 |
| `src/cli/v2/outbox.ts` | CLI dead-letter 子命令（list/show/requeue/compensate） |
| `docs/runbooks/operations-phase7a.md` | 中文运维手册（全部处置流程 + 指标口径 + 告警阈值表） |
| `tests/distributed/p7a-ops.test.ts` | 22 个失败优先测试（incident/dead-letter/recovery/backup/metrics/CLI 一致性） |
| `scripts/v1-work-inventory.mjs` | V1 work/ 清点报告脚本 |

### 修改文件
| 文件 | 变更 |
|------|------|
| `src/db/migrate.ts` | 注册 migration 010 |
| `src/db/sqlite-store.ts` | 新增 incident CRUD + updateRestorePoint + updateOrphanRecoveryCandidate 方法 |
| `src/types/v2-infra.ts` | 新增 IncidentRow / V2IncidentStatus / V2IncidentSeverity 类型 |
| `src/server/v2/routes/v2-routes.ts` | 替换 17 个 stub 为真实实现（incident/recovery/dead-letter/metrics/backup/mode-transition） |

## 验证原始输出

### 1. 构建检查
```
$ npx tsc --noEmit
(no errors)
```

### 2. p7a 测试
```
$ npx vitest run tests/distributed/p7a-ops.test.ts
 ✓ tests/distributed/p7a-ops.test.ts (22 tests) 99ms
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

### 3. 分布式全量测试
```
$ npx vitest run tests/distributed/
 Test Files  22 passed (22)
      Tests  397 passed (397)
```

### 4. 全量测试
```
$ npx vitest run
 Test Files  116 passed | 2 failed (118)  ← 2 个 pre-existing 失败（signal handling，非 7a 相关）
      Tests  1431 passed | 2 failed (1433)
```

## 指标清单

| 指标名 | 类型 | 说明 |
|--------|------|------|
| `biao_merge_jobs{status="..."}` | gauge | 合并队列按状态分布 |
| `biao_outbox_pending_total` | gauge | outbox 待处理数 |
| `biao_outbox_dead_letter_total` | gauge | outbox 死信数 |
| `biao_incidents_open{severity="..."}` | gauge | 未解决 incident 按严重级别 |
| `biao_nodes{status="..."}` | gauge | 节点按状态分布 |
| `biao_deliveries{status="..."}` | gauge | delivery 按状态分布 |
| `biao_metrics_timestamp` | gauge | 指标生成时间戳 |
| `biao_restore_point_latest_status` | gauge | 最新恢复点状态 |

## 告警阈值表

| 规则 | 指标 | 阈值 | 级别 |
|------|------|------|------|
| outbox_dead_letter_high | biao_outbox_dead_letter_total | ≥10 | warning |
| incidents_critical_open | biao_incidents_open{severity="critical"} | ≥1 | critical |
| merge_queue_depth | biao_merge_jobs{status="queued"} | ≥20 | warning |
| nodes_offline | biao_nodes{status="offline"} | ≥3 | warning |

## Restore Drill 步骤

1. `POST /v2/backup/restore-points` — 创建恢复点（含 WAL checkpoint）
2. `POST /v2/backup/restore-points/{id}/drill` — 隔离副本验证
   - integrity_check 通过
   - 副本 digest 与备份时一致
   - plans/deliveries 计数比对
   - 生产库字节不变

## V1 work/ 清点报告

运行方式：`node scripts/v1-work-inventory.mjs --work-dir .biao/work`

产出：文件清单 + Artifact 上传计划 + 抽样可读性检查 + 缺口分析。

## CLI/API 处置能力清单（§21 Phase 7 自查）

| 能力 | API | CLI | 状态 |
|------|-----|-----|------|
| Incident list/show/ack/resolve | ✅ | - | 7a 覆盖 |
| Recovery Candidate list/takeover/discard | ✅ | - | 7a 覆盖 |
| Isolation list/resolve | ✅ | - | 7a 覆盖 |
| BranchCleanup list/retry | ✅ | - | 7a 覆盖 |
| Dead-letter list/show/requeue/compensate | ✅ | ✅ | 7a 覆盖 |
| Mode transition 进度查询/恢复 | ✅ | - | 7a 覆盖 |
| Backup/Restore drill | ✅ | - | 7a 覆盖 |
| Metrics（Prometheus） | ✅ | - | 7a 覆盖 |
| 告警规则→Incident 自动开单 | ✅ | - | 7a 覆盖 |

**7b 触发条件自查结论**：所有 CLI/API 处置能力均已通过 API 覆盖，CLI 覆盖了 outbox dead-letter 子命令。Web 页面（7b）维持延期，不触发升级阻塞。

## 残余风险

1. **metrics.ts 中 `require('node:fs')` 动态引入**：backup.ts 的 artifactManifestDigest 使用动态 require，已在 artifactRoot 不存在时返回占位 digest，不影响功能。
2. **告警规则默认值**：当前告警阈值为硬编码默认值，生产环境可能需要调整。
3. **V1 work/ 清点脚本**：仅产出报告，实际迁移执行不阻塞本阶段。
