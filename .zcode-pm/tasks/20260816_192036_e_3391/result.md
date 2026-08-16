All work is complete. Here's my final summary:

## P12 车道 C 完成总结

### 交付内容（§9–§14）

**§9 Webhook/通知集成** — `src/server/v2/webhook-service.ts`（新）
- `POST/GET/DELETE /v2/webhooks`（owner-only，secret 列表脱敏）、`POST /v2/webhooks/:id/reactivate`、`POST /v2/webhooks/dispatch`
- 四种事件：`task_done`/`review_requested`（← Redis events stream）、`conflict_detected`（← ownership conflicts list）、`incident_opened`（← incidents 表）
- HMAC-SHA256 签名（`X-Biao-Signature: sha256=<hex>`）、Slack-compatible JSON payload、指数退避重试、连续 3 次失败 → webhook 标记 `failed`
- Dispatcher 周期轮询三事件源，游标持久化 `webhook_dispatcher_state`，`webhook_deliveries` 幂等去重
- 016 迁移：`webhook_registrations` / `webhook_deliveries` / `webhook_dispatcher_state` + sqlite-store 方法

**§10 前端 SSE** — `web/src/hooks/useEventStream.ts`（新）+ `web/src/App.tsx` 消费
- App 级订阅 `/events/stream`，事件到达递增 `refreshRevision` 传入 `ProjectListView`/`PlanDetailView`；两视图移除直接 `subscribeToEvents`（防双订阅重复刷新）；`ignorePollEvents` 过滤 fallback 轮询

**§11 速率限制** — `src/server/http-plugins.ts` + `src/server/http.ts`
- `@fastify/rate-limit`（Redis store）：全局 100 req/s、`/auth/human-login` 10 req/min、enrollment code 消费 5 req/min/IP（env 可调：`BIAO_RATE_LIMIT_*`）；test runtime 默认关、生产默认开
- error handler 透传 429 → `RATE_LIMIT_EXCEEDED`（修复了限流错误被折叠成 500 的问题）

**§12 备份调度** — `src/server/v2/backup.ts` + `deploy/nas/install.sh`
- `POST /v2/backup/run`（逐组件快照，失败写 `failed` run + 开 incident `backup_failed`）、`GET /v2/backup/status`；install.sh 每小时 cron（wrapper 从 .env 读 token，避免 token 进 crontab 命令行）

**§13 监控外接** — `GET /v2/metrics/prometheus`（复用 generateMetrics，`text/plain; version=0.0.4`）；install.sh `--with-monitoring` 启动 prometheus + node_exporter，scrape 指向 Biao metrics

**§14 安全加固**
- `BIAO_HTTPS=1` → 全部 Cookie 加 `Secure` flag
- 全响应 `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY`
- CORS 白名单 `BIAO_CORS_ORIGINS`（未配置不改变现状；越权 Origin → 403 `CORS_ORIGIN_DENIED`）

### 改动文件
- **新增**：`src/db/migrations/016_webhooks.ts`、`src/server/v2/webhook-service.ts`、`web/src/hooks/useEventStream.ts`、`docs/runbooks/p12-product-safety.md`、`tests/distributed/p12-webhook.test.ts`、`web/tests/event-stream.test.ts`
- **修改**：`src/server/http.ts`、`src/server/http-plugins.ts`、`src/server/human-session.ts`、`src/server/v2/backup.ts`、`src/server/v2/routes/v2-routes.ts`、`src/db/sqlite-store.ts`、`src/db/migrate.ts`、`src/types/v2-infra.ts`、`deploy/nas/install.sh`、`web/src/App.tsx`、`web/src/components/{ProjectListView,PlanDetailView}.tsx`、`package.json`+lock（`@fastify/rate-limit`）、`web/package.json`+lock（`react-test-renderer`）

### 验证
- `tests/distributed/p12-webhook.test.ts`：**15/15 通过**（签名/验签、Slack payload、事件映射、HTTP 路由、投递幂等 + 3 次失败标记 failed、dispatcher 周期、限流 429）
- `web/tests/event-stream.test.ts`：**5/5 通过**；web 全量 **13 文件/94 用例全绿**（基线 12/89 +5）
- 回归：p10-human-web-auth（16）、p0a2-plugin-parity（8）、p0a2-route-registry（9）、p0a1-migrations（8）、p8-loopback-e2e（20）、p6-rbac（98）、p8-two-nodes（7）、p7a/p9 ops+recovery（68）全部通过
- tsc：**我的改动 0 错**（仅剩并行车道既有错误）
- 全量 distributed 40 文件：35 通过，5 失败均为并行车道既有破坏（见下）

### 残留风险 / 并行车道既有破坏
- **lane A 未完成**（与本任务无关）：`src/server/service.ts` 引用未导出的 `./v2/attempt-service` 函数、registry 新增 `AttemptService.cancelAttempt` 未入 p1 `EXPECTED_BINDINGS` → tsc 报错、`p0a2-service-map`/`p1-credentials` 红，`npm test` 的 pretest 构建被阻塞
- **lane B 未完成**（与本任务无关）：`src/node/daemon.ts`+`real-executor.ts` 修改 → `p3-node-daemon`（2 用例）、`p9-scheduling`（1 用例）红
- 全局速率限制按 `request.ip`（未配 trustProxy 时是 socket 地址，多实例需代理层收敛）
- `conflict_detected` 水位基于 ts，同毫秒多冲突可能只触发一次（`webhook_deliveries` 幂等兜底）
- `POST /v2/backup/run` 在 `dbPath=':memory:'` 装配下 digest 为空（部署装配用真实 sqlitePath）