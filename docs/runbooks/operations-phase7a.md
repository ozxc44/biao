# Phase 7a 运维手册

本文档覆盖 Phase 7a（API/CLI 可观测与运维）全部处置流程。

## 1. Incident 生命周期

### 1.1 触发

Incident 由以下事件自动创建：
- merge integration_failed
- 项目降级 read_only
- revoke-all-sessions
- 节点 quarantine
- 告警规则触发（见 §6）

### 1.2 查看

```bash
# API
curl http://localhost:3000/v2/incidents
curl http://localhost:3000/v2/incidents?status=open
curl http://localhost:3000/v2/incidents?project_id=proj-xxx
```

### 1.3 Acknowledge

```bash
curl -X POST http://localhost:3000/v2/incidents/{incident_id}/ack \
  -H 'Content-Type: application/json' \
  -d '{"acked_by": "operator-name", "note": "已确认，正在处理"}'
```

状态转移：`open` → `acked`

### 1.4 Resolve

```bash
curl -X POST http://localhost:3000/v2/incidents/{incident_id}/resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolved_by": "operator-name", "evidence": "root cause: xxx, fix: yyy"}'
```

状态转移：`acked`（或 `open`）→ `resolved`。**必须附带 evidence**。

### 1.5 SLA

| 级别 | ack 截止 |
|------|----------|
| critical | 1 小时 |
| warning | 4 小时 |
| info | 24 小时 |

---

## 2. Recovery Candidate 处置

### 2.1 查看

```bash
curl http://localhost:3000/v2/recovery-candidates
curl http://localhost:3000/v2/recovery-candidates?status=pending
```

### 2.2 Takeover（裁决+Node 确认）

```bash
curl -X POST http://localhost:3000/v2/recovery-candidates/{candidate_id}/takeover \
  -H 'Content-Type: application/json' \
  -d '{"reason": "node offline timeout", "decided_by": "operator"}'
```

### 2.3 Discard（证据摘要留档）

```bash
curl -X POST http://localhost:3000/v2/recovery-candidates/{candidate_id}/discard \
  -H 'Content-Type: application/json' \
  -d '{"reason": "stale orphan, no valid data", "decided_by": "operator"}'
```

### 2.4 批量操作

```bash
curl -X POST http://localhost:3000/v2/recovery-candidates/batch-actions \
  -H 'Content-Type: application/json' \
  -d '{"candidate_ids": ["orc-xxx", "orc-yyy"], "action": "takeover", "reason": "batch cleanup", "decided_by": "operator"}'
```

---

## 3. Isolation 处置

### 3.1 查看

```bash
curl http://localhost:3000/v2/recovery-isolations
curl http://localhost:3000/v2/recovery-isolations?status=isolated
```

### 3.2 Resolve（review 证据必填）

```bash
curl -X POST http://localhost:3000/v2/recovery-isolations/{isolation_id}/resolve \
  -H 'Content-Type: application/json' \
  -d '{"resolved_by": "reviewer", "resolution": "verified safe, evidence: xxx"}'
```

---

## 4. Branch Cleanup

### 4.1 查看

```bash
curl http://localhost:3000/v2/branch-cleanups
curl http://localhost:3000/v2/branch-cleanups?status=pending
```

### 4.2 Retry（到期复核 HEAD）

```bash
curl -X POST http://localhost:3000/v2/branch-cleanups/{cleanup_id}/retry
```

### 4.3 执行到期清理

```bash
curl -X POST http://localhost:3000/v2/branch-cleanups/run
```

---

## 5. Dead-letter 治理

### 5.1 CLI 子命令

```bash
# 列出死信
biao v2 outbox dead-letter list --db data/biao.sqlite
biao v2 outbox dead-letter list --json

# 查看详情
biao v2 outbox dead-letter show --event-id evt-xxx --db data/biao.sqlite

# 重新入队
biao v2 outbox dead-letter requeue --event-id evt-xxx --reason "手动重试" --db data/biao.sqlite

# 生成补偿事件
biao v2 outbox dead-letter compensate --event-id evt-xxx --reason "数据缺陷" --db data/biao.sqlite
```

### 5.2 API

```bash
# 列出
curl http://localhost:3000/v2/outbox/dead-letters

# 查看
curl http://localhost:3000/v2/outbox/dead-letters/{event_id}

# 重新入队
curl -X POST http://localhost:3000/v2/outbox/dead-letters/{event_id}/requeue \
  -H 'Content-Type: application/json' \
  -d '{"reason": "manual requeue"}'

# 补偿
curl -X POST http://localhost:3000/v2/outbox/dead-letters/{event_id}/compensate \
  -H 'Content-Type: application/json' \
  -d '{"reason": "data defect"}'
```

---

## 6. 告警规则

| 规则名 | 指标 | 阈值 | 级别 | 说明 |
|--------|------|------|------|------|
| outbox_dead_letter_high | biao_outbox_dead_letter_total | ≥10 | warning | outbox 死信数超阈值 |
| incidents_critical_open | biao_incidents_open{severity="critical"} | ≥1 | critical | 存在未处理 critical incident |
| merge_queue_depth | biao_merge_jobs{status="queued"} | ≥20 | warning | 合并队列深度超阈值 |
| nodes_offline | biao_nodes{status="offline"} | ≥3 | warning | 离线节点数超阈值 |
| stale_proposed_delivery | biao_stale_proposed_delivery（query-based） | 存在 ≥1 个超过阈值 | warning | proposed/pending_review Delivery 超过阈值未 Review |

告警触发后自动创建 incident（kind=`alert:{规则名}`）。

### 6.1 告警调度器（§22.4-18）

`src/server/v2/alert-scheduler.ts` 用 `setInterval` 定期驱动 `runAlertEvaluation` +
`escalateOverdueIncidents`，`unref()` 不阻塞进程退出。

| 参数 | 默认 | 说明 |
|------|------|------|
| `BIAO_V2_ALERT_INTERVAL_MS` | `60000`（60s） | 告警轮询间隔（毫秒） |
| `BIAO_V2_STALE_DELIVERY_HOURS` | `48` | stale proposed Delivery 阈值（小时） |

### 6.2 去重 / 复发（§22.4-36）

- 同 fingerprint（kind）存在**未 resolve**（open 或 acked）的 incident 时不重开；
- resolve 后 7 天窗口内同一 fingerprint 重开计 `recurrence` 递增（字段留档）；
- 告警创建的 incident 写入 `resolution_sla_minutes`（按 severity：critical=240 / warning=1440 / info=4320）；
- 超 resolution SLO 未 resolve 的 incident 由调度器**升级 severity 一次**（`escalated=1`，critical 已最高不升）。

### 6.3 stale proposed Delivery 明细

stale 规则开单的 incident `detail` 携带 `delivery=<id> age_min=<n>` 列表，`related_entity_id`
指向首个 stale delivery。

---

## 7. 指标

### 7.1 获取指标

```bash
curl http://localhost:3000/v2/metrics
```

返回 Prometheus 文本格式，包含：
- `biao_merge_jobs{status="..."}` — 合并队列深度
- `biao_outbox_pending_total` — outbox 待处理数
- `biao_outbox_dead_letter_total` — outbox 死信数
- `biao_incidents_open{severity="..."}` — 未解决 incident 数
- `biao_nodes{status="..."}` — 节点状态分布
- `biao_deliveries{status="..."}` — delivery 状态分布
- `biao_metrics_timestamp` — 指标生成时间戳
- `biao_restore_point_latest_status` — 最新恢复点状态

---

## 8. Restore Drill

### 8.1 创建恢复点

```bash
curl -X POST http://localhost:3000/v2/backup/restore-points
```

### 8.2 执行 drill（隔离副本验证，不触碰生产库）

```bash
curl -X POST http://localhost:3000/v2/backup/restore-points/{restore_point_id}/drill
```

返回：
- `integrity_ok` — SQLite integrity_check 通过
- `digest_match` — 副本 digest 与备份时一致
- `smoke_counts` — 副本 plans/deliveries 计数
- `production_unchanged` — 生产库字节未变

### 8.3 查看备份运行记录

```bash
curl http://localhost:3000/v2/backup/restore-points/{restore_point_id}/runs
```

---

## 9. Mode Transition 恢复

### 9.1 查看转换记录

```bash
curl http://localhost:3000/v2/projects/{project_id}/mode-transitions
curl http://localhost:3000/v2/projects/{project_id}/mode-transitions?status=failed
```

### 9.2 重试失败的转换

```bash
curl -X POST http://localhost:3000/v2/projects/{project_id}/mode-transitions/{transition_id}/retry
```

幂等：只有 `failed` 状态可重试，重置为 `running`。

---

## 10. V1 work/ 清点

### 10.1 运行清点脚本

```bash
node scripts/v1-work-inventory.mjs --db data/biao.sqlite --work-dir .biao/work
```

产出：`.biao/work/` 目录中仍在审计期的 result/verify 文件清单与 Artifact 上传计划。

### 10.2 验收门禁

- 抽样可读：随机抽取 10% 的 result 文件，确认可正常读取
- 无未解释缺口：所有 result 文件必须有对应的 verify 文件或明确标记为无需验证

---

## 11. 升级/回滚入口

### 升级

1. 备份 SQLite：`cp data/biao.sqlite data/biao.sqlite.bak`
2. 运行迁移：`npx biao migrate`
3. 验证：`npx vitest run tests/distributed/`

### 回滚

1. 停止服务
2. 恢复备份：`cp data/biao.sqlite.bak data/biao.sqlite`
3. 重启服务

---

## 12. CLI/API 一致性

Phase 7b 延期下的等价门禁：同一 fixture 状态下 API JSON 与 CLI 输出的关键字段逐项一致。

验证方法：
```bash
# API 获取
curl -s http://localhost:3000/v2/outbox/dead-letters | jq '.data.items[0]' > /tmp/api.json

# CLI 获取
biao v2 outbox dead-letter list --json --db data/biao.sqlite | jq '.data.items[0]' > /tmp/cli.json

# 比对
diff /tmp/api.json /tmp/cli.json
```

---

## 13. CLI/API 处置能力清单（§21 Phase 7 自查）

| 能力 | API | CLI | 状态 |
|------|-----|-----|------|
| Incident list/show/ack/resolve | ✅ | - | 7a 覆盖 |
| Recovery Candidate list/takeover/discard | ✅ | - | 7a 覆盖（车道 C 增补：决策签名 + 三崩溃点续跑，见 runbooks/mode-transitions-and-recovery-decisions.md） |
| Isolation list/create/review/resolve | ✅ | - | 7a 覆盖（车道 C 增补：三步分权 create/review/resolve） |
| BranchCleanup list/retry | ✅ | - | 7a 覆盖 |
| Dead-letter list/show/requeue/compensate | ✅ | ✅ | 7a 覆盖 |
| Mode transition 进度查询/恢复 | ✅ | - | 7a 覆盖（车道 C 增补：24h deadline、advance 单步/auto 驱动、重启续跑、超期隔离） |
| Backup/Restore drill | ✅ | - | 7a 覆盖 |
| Metrics（Prometheus） | ✅ | - | 7a 覆盖 |
| 告警规则→Incident 自动开单 | ✅ | - | 7a 覆盖 |

**7b 触发条件自查结论**：所有 CLI/API 处置能力均已通过 API 覆盖，CLI 覆盖了 outbox dead-letter 子命令。Web 页面（7b）维持延期，不触发升级阻塞。
