# P12 车道 C：产品完善 + 安全加固 + 运维自动化

## 目标

### 9. Webhook/通知集成
- `POST /v2/webhooks`（owner）：注册 webhook URL（PM 事件推送到外部系统）
- 事件：task_done、review_requested、conflict_detected、incident_opened
- 签名验证（HMAC）+ 重试 + 3 次后标记 failed
- 支持 Slack-compatible webhook（JSON payload 格式）

### 10. 前端 SSE 实时更新
- `web/src/hooks/useEventStream.ts`：订阅 `/events/stream` → 收到事件 → 刷新对应数据
- 任务状态变更、新 PM 门铃、冲突 → 无需手动刷新

### 11. API 速率限制
- `@fastify/rate-limit`：全局 100 req/s + 登录端点 10 req/min（防暴力破解）
- enrollment code 消费：IP 级 5 次/分钟冷却

### 12. 备份自动调度
- NAS `install.sh` 加 cron 条目：每小时调 `POST /v2/backup/run`
- 备份结果写入 `backup_runs` 表 + 失败时开 incident
- `GET /v2/backup/status`：查看最近备份状态

### 13. 监控外接
- `GET /v2/metrics/prometheus`：Prometheus 文本格式（已有 metrics.ts，加 format 导出）
- NAS `install.sh` 可选安装 `prometheus/node_exporter` 指向 Biao metrics

### 14. Cookie Secure + 安全加固
- `BIAO_HTTPS=1` 时 Cookie 加 `Secure` flag
- API 响应加安全头（`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`）
- CORS 白名单（仅允许配置的前端 origin）

## 约束
- 所有权：`src/server/v2/webhook-service.ts`（新）、`src/server/http-plugins.ts`（rate limit + 安全头）、`web/src/hooks/`（新）、`web/src/App.tsx`（SSE 消费）、`deploy/nas/install.sh`（cron + 可选监控）、`src/server/v2/metrics.ts`（prometheus format）
- 新测试：`tests/distributed/p12-webhook.test.ts`、`web/tests/event-stream.test.ts`
- 不改 `src/node/**`、`src/server/service.ts`
