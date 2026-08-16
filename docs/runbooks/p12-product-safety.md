# P12 车道 C：产品完善 + 安全加固 + 运维自动化

> 对应 `docs/distributed-multi-node-development-plan.md` §9（Webhook）、§21 Phase 12 产品面。
> 车道 C 所有权：`src/server/v2/webhook-service.ts`、`src/server/http-plugins.ts`、
> `src/server/v2/metrics.ts`、`deploy/nas/install.sh`、`web/src/hooks/`、`web/src/App.tsx`。

## 1. Webhook / 通知集成（§9）

### 端点

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/v2/webhooks` | owner | 注册 webhook URL + 订阅事件清单；secret 自动生成仅返回一次 |
| GET | `/v2/webhooks` | owner | 列表（secret 脱敏） |
| GET | `/v2/webhooks/:id` | owner | 详情（secret 脱敏） |
| DELETE | `/v2/webhooks/:id` | owner | 删除注册 |
| POST | `/v2/webhooks/:id/reactivate` | owner | failed → active（清空失败计数） |
| POST | `/v2/webhooks/dispatch` | owner | 手动推进一轮 pending 退避重试 |

请求体：

```json
{
  "url": "https://hooks.slack.com/services/T/B/TOKEN",
  "events": ["task_done", "review_requested", "conflict_detected", "incident_opened"],
  "secret": "optional-hmac-secret"
}
```

`events` 缺省为全部四种。事件类型：
- `task_done` ← Redis events stream `type=task_completed`
- `review_requested` ← Redis events stream `type=review_requested`
- `conflict_detected` ← ownership conflicts 列表新增
- `incident_opened` ← incidents 表新增（created_at 水位）

### 投递

- Payload 为 Slack-compatible JSON（`text` + `attachments[].fields`）。
- 签名：`X-Biao-Signature: sha256=<hex>`，HMAC-SHA256 基于注册时返回的 secret。
- 接收方验签：`X-Biao-Event` 头 + `X-Biao-Signature`；验签函数 `verifyWebhookSignature`。
- 重试：指数退避（1min / 5min / 15min），连续 3 次失败 → webhook 标记 `failed`
  （不再自动投递，`POST /v2/webhooks/:id/reactivate` 恢复）。
- 投递记录持久化 `webhook_deliveries`；dispatcher 游标持久化
  `webhook_dispatcher_state`（重启续扫，不重不漏）。

### dispatcher

`createWebhookDispatcher` 由 `createHttpServer` 在配置 SQLite store 时自动启动
（`BIAO_V2_WEBHOOK_INTERVAL_MS` 调间隔，默认 30s）。事件源三路轮询：
Redis events stream / ownership conflicts list / incidents 表。

## 2. 前端 SSE 实时更新（§10）

- `web/src/hooks/useEventStream.ts`：订阅 `/events/stream`（api.ts 的
  `subscribeToEvents`），收到事件递增 revision，返回给视图作为 reload 依赖。
- `web/src/App.tsx` 认证完成后消费事件流，`refreshRevision` 传入
  `ProjectListView` / `PlanDetailView`；任务状态变更、新 PM 门铃、冲突无需手动刷新。
- 过滤：`ignorePollEvents` 忽略后台 fallback 轮询（`type='poll'`）。

## 3. API 速率限制（§11）

`@fastify/rate-limit`（Redis store，分布式计数）：

| 面 | 默认 | env |
|----|------|-----|
| 全局 | 100 req/s | `BIAO_RATE_LIMIT_GLOBAL_MAX` |
| `POST /auth/human-login`（防暴力破解） | 10 req/min | `BIAO_RATE_LIMIT_LOGIN_MAX` |
| `POST /auth/human-session`（enrollment code 消费） | 5 req/min/IP | `BIAO_RATE_LIMIT_ENROLLMENT_MAX` |

开关：`BIAO_RATE_LIMIT_ENABLED=1` 显式开启；未设置时 test runtime（`NODE_ENV=test`/
`VITEST`）默认关，生产默认开。超限响应 `429` + `code: RATE_LIMIT_EXCEEDED`。

## 4. 备份自动调度（§12）

- `POST /v2/backup/run`：写 `restore_points` + `backup_runs`（组件逐个快照，
  任一失败该 run 标 failed、restore_point 标 failed，并开 incident `backup_failed`）。
- `GET /v2/backup/status`：最近 N 个 restore_point + backup_runs 汇总。
- NAS `deploy/nas/install.sh` 安装每小时 cron（`POST /v2/backup/run`），wrapper
  从 `.env` 读 token，失败写入 `$DATA_ROOT/backup-cron.log`。

## 5. 监控外接（§13）

- `GET /v2/metrics/prometheus`：Prometheus 文本格式（`text/plain; version=0.0.4`）。
- NAS `install.sh --with-monitoring`：启动 `prom/prometheus` + `prom/node-exporter`，
  Prometheus scrape 指向 `biao-server:7331/v2/metrics/prometheus`（job=biao）。

## 6. Cookie Secure + 安全加固（§14）

- `BIAO_HTTPS=1` → 全部 Cookie（`biao_local_owner` / `biao_human_session`）追加
  `Secure` flag（反向代理 TLS 终止部署）。
- 全响应安全头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`。
- CORS 白名单：`BIAO_CORS_ORIGINS`（逗号分隔 origin）；请求带 Origin 且不在
  白名单 → 403 `CORS_ORIGIN_DENIED`；白名单内 → 加 `Access-Control-Allow-*`。
  未配置时不加 CORS 头（同源部署行为不变）。

## 测试

- `tests/distributed/p12-webhook.test.ts`：签名/验签、Slack payload、事件映射、
  HTTP 路由、投递幂等 + 3 次失败标记 failed、dispatcher 周期、速率限制 429。
- `web/tests/event-stream.test.ts`：`useEventStream` 订阅/清理/revision/filter。

## 已知边界

- 全局速率限制按 `request.ip`（未 trust proxy 时是 socket 地址）；多实例部署需
  在反向代理层配置 `trustProxy` 或统一出口 IP。
- Webhook dispatcher 的 `conflict_detected` 依赖 ownership conflicts 列表的水位；
  水位基于 `ts`，同一毫秒内多个冲突可能只触发一次（`webhook_deliveries` 幂等兜底）。
- `POST /v2/backup/run` 在 `dbPath=':memory:'` 的装配下 digest 为空串（部署装配
  用真实 sqlitePath 时才有实际 digest）。
