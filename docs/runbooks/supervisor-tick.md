# Supervisor 聚合 tick 端点

## 概述

`GET /supervisor/tick` 是 Supervisor 轮询的聚合端点，将一轮快照所需的多个请求合成一次往返，减少局域网多机部署时的延迟与连接开销。

## 端点规格

### 请求参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `consumers` | 逗号分隔字符串 | PM consumer 列表；省略时使用默认 `pm` |
| `events_after` | stream ID | 事件流排他游标增量；省略时不返回 events |
| `binding_aware` | `1` 或 `true` | 返回绑定项目的 bindings + receipts |
| `plan_ids` | 逗号分隔字符串 | 可选 plan 过滤列表 |

### 响应字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `plans` | `BiaoPlanSummary[]` | 与 `GET /plans` 一致 |
| `intakes` | `Array<{consumer, cursor, counts, items}>` | 每个 consumer 的 intake 结果，与 `GET /intake` 一致 |
| `events` | `{events[], next_cursor}` | 与 `GET /events?after=` 一致 |
| `reconciliation` | `RuntimeReconciliationResult` | 与 `POST /reconcile` 一致（含 permit 门控） |
| `bindings` | `Array<{project_scope, bindings[]}>` | 仅 `binding_aware=1` 时返回 |
| `receipts` | `Array<{project_scope, receipts[]}>` | 仅 `binding_aware=1` 时返回 |

### 语义保证

- **reconcile 幂等性**：tick 里的 reconcile 沿用现有 `reconcileRuntimeState` 实现与 permit 门控，语义与单独调用 `POST /reconcile` 完全一致。
- **心跳不并入**：各 slot 心跳保持独立节流语义（每个 agent 独立 30-60s 间隔），不适合聚合。

## 版本兼容矩阵

| Supervisor 版本 | Server 版本 | 行为 |
|-----------------|------------|------|
| 新版（支持 tick） | 新版（支持 tick） | 使用 tick 聚合路径，请求计数 = 1 |
| 新版（支持 tick） | 旧版（不支持 tick） | 首轮 tick 返回 404 → 自动回落到逐端点，后续轮次不再尝试 tick |
| 旧版（不支持 tick） | 新版（支持 tick） | 旧 Supervisor 不调用 tick，无影响；逐端点路径继续正常工作 |
| 旧版（不支持 tick） | 旧版（不支持 tick） | 均不涉及 tick，无影响 |

## 调试

### 强制回落到逐端点

设置环境变量 `BIAO_SUPERVISOR_TRANSPORT=legacy` 可强制 Supervisor 跳过 tick 探测，直接使用逐端点路径。适用于：

- 怀疑 tick 端点行为异常时的对比调试
- 需要精确控制每个端点调用的场景

### 回落触发条件

以下任一条件触发回落：

1. tick 端点返回 HTTP 404 或 405
2. tick 响应 JSON 解析失败
3. tick 响应缺少核心字段（`plans`、`intakes`、`events`、`reconciliation`）
4. tick 请求网络错误
5. `BIAO_SUPERVISOR_TRANSPORT=legacy` 环境变量

回落后的表现：

- 当前轮次立即切换到逐端点路径，行为与旧版 Supervisor 完全一致
- 后续轮次不再尝试 tick（状态记忆，避免每轮浪费一次 404 请求）
- 进程重启后重新探测

## 局域网多机部署建议

1. 所有开发机的 Supervisor 升级到支持 tick 的版本后，中央 Server 也升级即可获得聚合收益
2. 滚动升级期间，新旧版本混搭完全兼容（见上表）
3. `BIAO_SUPERVISOR_TRANSPORT=legacy` 仅用于调试，生产不要设置
