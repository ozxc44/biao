车道 E 交付完成。以下为最终交付说明。

---

## 车道 E 交付总结（告警接线、SLO、冲突闭环与幂等合并断言）

### 一、改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/server/v2/alert-scheduler.ts` | 新增（车道所有权） | 告警调度器：`setInterval` 定期驱动 `runAlertEvaluation` + `escalateOverdueIncidents`，可注入 now/fn，`unref()`，`BIAO_V2_ALERT_INTERVAL_MS` 默认 60s |
| `src/server/v2/metrics.ts` | 修改（车道所有权） | 新增 `stale_proposed_delivery` 规则；recurrence 复发计数；告警 incident 写 `resolution_sla_minutes`；新增 `escalateOverdueIncidents()`（超 SLO 升级一次） |
| `src/db/sqlite-store.ts` | 修改（仅追加） | 追加 `listOwnershipSnapshots()` 与 `rebuildOwnershipSnapshotIndex()`（§22.2-09 重建函数），未改既有方法 |
| `src/db/migrations/011_incident_sla_recurrence.ts` | 新增 | incidents 追加 `resolution_sla_minutes` / `recurrence` / `escalated` 三列（可空过渡） |
| `src/db/migrate.ts` | 修改 | 注册迁移 011（与并行车道追加的 012 共存，只增不改） |
| `src/types/v2-infra.ts` | 修改 | `IncidentRow` 加可选字段 |
| `tests/distributed/p9-ops.test.ts` | 新增 | 13 用例：告警接线/去重/复发/SLO 升级/审计/stale delivery/env 纪律/snapshot 重建 |
| `tests/distributed/p9-merge-conflict.test.ts` | 新增 | 2 用例：真·内容冲突闭环 |
| `tests/distributed/p9-idempotency.test.ts` | 新增 | 1 用例：幂等合并断言 |
| `docs/runbooks/operations-phase7a.md` | 修改 | 告警规则总表 + 调度器参数 + 去重/复发/stale 明细节 |

未触碰任何禁止文件：`incident-service.ts`（只调用，实际走 store 直写——接口不足已列缺口）、`merge/**`、`git/**`、`routes/**`、`service.ts`、`node/**`、`mcp/**`、`web/`、既有 fixture。

### 二、告警规则总表（规则/阈值/动作）

| 规则 | 阈值 | 级别 | 动作 |
|---|---|---|---|
| `outbox_dead_letter_high` | `biao_outbox_dead_letter_total ≥ 10` | warning | 开 incident `alert:outbox_dead_letter_high` |
| `incidents_critical_open` | `biao_incidents_open{severity="critical"} ≥ 1` | critical | 开 incident |
| `merge_queue_depth` | `biao_merge_jobs{status="queued"} ≥ 20` | warning | 开 incident |
| `nodes_offline` | `biao_nodes{status="offline"} ≥ 3` | warning | 开 incident |
| `stale_proposed_delivery`（query-based） | 存在 ≥1 个超过阈值（默认 48h，`BIAO_V2_STALE_DELIVERY_HOURS` 可调）的 proposed/pending_review Delivery | warning | 开 incident，`detail` 含 `delivery=<id> age_min=<n>` |

去重：同 kind（fingerprint）未 resolve（open+acked）不重开；resolve 后 7 天窗口内重开 `recurrence` 递增；`resolution_sla_minutes` 按 severity 写入（critical=240/warning=1440/info=4320 分钟）；超 SLO 未 resolve 由调度器升级 severity 一次（`escalated=1` 保证只升一次）。

### 三、调度器参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `intervalMs`（注入）/ `BIAO_V2_ALERT_INTERVAL_MS` | 60s | 轮询间隔 |
| `BIAO_V2_STALE_DELIVERY_HOURS` | 48 | stale Delivery 阈值小时 |
| `now` / `runAlertCycle` / `onCycle` / `onError` | — | 假时钟/周期/回调注入（测试） |

### 四、claim 接线缺口清单（移交车道 A）

1. **`ownership-v2.ts` 内存 Map 未与 SQLite durable 表接通**：claim 路由已写 `ownership_snapshots`（v2-routes.ts:570），但运行态读取（`ownership-v2.ts` 的 `writeOwnershipSnapshot/verify`）仍走模块级内存 Map，未落 SQLite。本车道交付 `rebuildOwnershipSnapshotIndex()`（attempt_id→files）与 `listOwnershipSnapshots()` 作为重建载体，车道 A 需在 claim 侧将运行时映射替换/冷启动时从 SQLite 重建。
2. **`incident-service.createIncident` 不暴露 SLO/recurrence/escalated 字段**：告警路径因此直写 store（insert+update 两步）。如需全量 incident 统一 SLO，需扩展 incident-service 接口。

### 五、四条验证原始输出

**验证 1 — p9 三件套**：`3 files passed / 16 tests passed`
```
✓ tests/distributed/p9-merge-conflict.test.ts (2 tests)
✓ tests/distributed/p9-ops.test.ts (13 tests)
✓ tests/distributed/p9-idempotency.test.ts (1 test)
```

**验证 2 — 关联既有测试**（迁移/incident/metrics/merge 回归）：`4 files passed / 52 tests passed`
```
✓ p7a-ops (22)  ✓ p0a1-migrations (8)  ✓ p0a2-infra-schema (22)  ✓ p5-merge-queue (10)
```

**验证 3 — 全量 vitest**：`126 files / 1533 tests`，`1 failed`——失败为 `tests/supervisor-pm-agent-cli.test.ts` 的 SIGTERM 用例，属记忆中已记录的**预先存在 flaky**（lane 无关、HEAD 亦败）；本车道新增 16 用例全过，基线不劣化（122→126 文件，1479→1533 用例含并行车道增量）。

**验证 4 — 类型构建**：`tsc --noEmit` 全量仅 1 个错误，位于并行车道 A 的未完成文件 `src/server/v2/plan-import.ts`（TS2345，非本车道）；排除该文件后本车道代码 `tsc` **0 错误**。

### 六、残余风险

1. **构建门禁被车道 A 阻塞**：`plan-import.ts` 的 TS2345 使 `npm run build:server` 当前不过；本车道代码自身类型干净，需车道 A 收敛后全量构建恢复。
2. **告警 incident 新列走 insert+update 两步**（为遵守 sqlite-store「只增不改」约束），非单事务；告警路径非热点，可接受。
3. **`escalateOverdueIncidents` 扫描上限 1000 条**未 resolve incident，超量时可能漏扫（后续可按 kind 索引优化）。
4. **p9-idempotency 复用 Redis DB 13**（与既有 claim-replay 测试同库），依赖串行套件 + flush 纪律；若车道 A 并发跑全量共享 Redis 仍存在理论竞争（沿用项目既定约束）。
5. **审计文档升级**：22.1-09/22.2-09 判定可升级（真冲突闭环 + durable 重建载体已交付），`docs/distributed-multi-node-acceptance-audit.md` 的正文更新未做（不在本车道所有权），建议由 PM 统一收口。