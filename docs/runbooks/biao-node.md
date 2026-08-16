# biao-node 运维手册（Phase 3 骨架）

> 适用：分布式多节点改造 Phase 3 交付的节点守护进程 `biao-node`。
> 方案依据：`docs/distributed-multi-node-development-plan.md` §10（Node Runtime）、
> §10.4（Lease 丢失）、§10.5（Drain 与升级）、§19（跨平台边界）、§21 Phase 3。
>
> Phase 3 是骨架：executor 为占位实现（收到 task attempt 只记录不真执行），
> 真实 Git workspace 执行在 Phase 4 落地；本文档标注了当前过渡语义。

## 1. 组件与状态机

一台节点一个 `biao-node` 守护进程（§10.1），内部若干执行槽共享一条
心跳、一个 lease watchdog、一个升级通道。进程状态机：

```text
boot ──载入配置/凭据（失败 → exit 2）
     ──协议协商（GET /version + 配置固定；不兼容/未声明 → exit 4，fail-closed）
registering ──POST /v2/nodes/register（409/fencing → fenced；401 → 过渡回退 owner）
     ──孤儿扫描（旧 session 的未收口 attempt 只登记 pending recovery，不接管）
running ──循环 tick：控制目录 poll → claim（inbox 占位 + server stub 探测）
     │     → lease watchdog → 上报队列 → 心跳（§10.3 字段 + Date 头对时）
     │     ──心跳 409/GENERATION_MISMATCH → fenced
     │     ──SIGTERM/控制文件/SIGINT → draining
draining ──不再 claim；等待 running attempts 收口；超时按配置显式 cancel 或等待
     │     （第二次 SIGTERM = 立即 cancel）→ 空 → offline → drained → exit 0
fenced  ──watchdog 全量停止（fenced）→ 留痕 → exit 3（人工检查后重启或重新 enroll）
```

退出码：`0` 正常收口；`2` 用法/配置/凭据错误；`3` session 被 fencing；
`4` 协议不兼容（fail-closed 拒绝注册）；`124` drain CLI 等待超时（仍在排空）。

## 2. 安装与 enroll（§10.2）

前置：控制面已部署（`BIAO_V2_CREDENTIAL_KEY` 已配置），Node.js ≥ 20.19。

```bash
# 1) 生成一次性 enrollment ticket 文件（当前服务端未校验票据内容——见 §8 缺口）
echo "ticket-$(openssl rand -hex 16)" > /tmp/enroll-ticket.txt

# 2) enroll 向导：票据只接受 文件/标准输入/交互式输入，不进 argv
export BIAO_NODE_OWNER_TOKEN='<owner token>'   # 过渡期引导，见 §8 缺口 6
node bin/biao-node.js enroll \
  --url http://control-plane:7331 \
  --node-id node-mac-prod-0001 \
  --ticket-file /tmp/enroll-ticket.txt \
  --config /etc/biao/biao-node.config.json \
  --slots 4 --cache-root /srv/biao-node/cache \
  --project proj-0001
rm /tmp/enroll-ticket.txt   # 一次性票据用后即焚

# 3) 前台验证一轮
node bin/biao-node.js run --config /etc/biao/biao-node.config.json

# 4) 状态查询 / 排空
node bin/biao-node.js status --config /etc/biao/biao-node.config.json
node bin/biao-node.js drain  --config /etc/biao/biao-node.config.json --wait-ms 60000
```

`node_id` 要求 16~128 字符、字符集 `[A-Za-z0-9._-]`（registry 契约）；
不传 `--node-id` 时按 `node-<主机名>-<随机后缀>` 生成。

## 3. 凭据与配置文件权限

| 文件 | 权限 | 说明 |
| --- | --- | --- |
| `node-credential.json` | `0600`（owner 读写） | bvn2_ Node credential + credential_generation；daemon 启动时校验，group/other 存在任何位即拒绝启动（fail-closed），错误信息附 `chmod 600` 修复指引 |
| `biao-node.config.json` | `0640`（推荐） | 非机密声明；**禁止**携带 token/credential/secret/password 类字段，出现即拒绝加载 |
| 状态目录 `state/` | `0700` | status.json、session 账本、recovery bundle、控制目录 |
| 过渡期 owner token | env `BIAO_NODE_OWNER_TOKEN` | 不落盘、不进 argv；macOS 生产形态为 Keychain、Windows 为 Credential Manager（模板） |

配置字段与默认值见 `src/node/config.ts` 头注释；周期类参数
（心跳/claim/watchdog/drain）均为毫秒整数并有上下界校验。

## 4. 三平台服务化

模板在 `templates/node/`，占位符登记于 `src/node/templates.ts`
（`NODE_TEMPLATE_PLACEHOLDERS`），渲染后不得残留任何占位符。

### 4.1 macOS（launchd）

1. 渲染 `biao-node.launchd.plist`（占位符：`NODE_BIN`、`BIAO_NODE_JS`、
   `BIAO_NODE_CONFIG`、`BIAO_NODE_STATE_DIR`、`BIAO_NODE_USER`）；
2. `plutil -lint com.biao.node.plist` 校验；
3. 安装到 `/Library/LaunchDaemons/`（root:wheel，644），`launchctl bootstrap system …`；
4. 停止/升级：先 `biao-node drain` 再 `launchctl bootout`。
   非零退出（fencing=3 等）自动重启并注册新 session generation；drain 后
   exit 0 不重启——这就是升级窗口。

### 4.2 Linux（systemd）

1. 渲染 `biao-node.service`（另含 `BIAO_NODE_CACHE_DIR`、`BIAO_NODE_USER/GROUP`、
   `BIAO_NODE_ENV_FILE`）；
2. `EnvironmentFile`（0600/0640）只放 `BIAO_NODE_OWNER_TOKEN`；
   Node credential 不放这里；
3. `systemctl enable --now biao-node`；
4. **`TimeoutStopSec=300` 必须大于配置的 `drain_timeout_ms`**，否则
   SIGTERM 的显式 cancel 动作没有执行机会就会被 SIGKILL 截断。

### 4.3 Windows（Windows Service，R1C-004 最小产物）

1. 先完成 `enroll`（生成配置与凭据文件）；
2. 管理员 PowerShell 运行渲染后的 `install-windows.ps1`：
   `Install`（幂等；注册 Event Log 源、owner token 存入 Credential
   Manager/PasswordVault、`sc.exe create` + 失败回滚）、`Start`、`Drain`、
   `Stop`（先投递 drain 控制文件再停服务）、`Status`、`Uninstall`
   （清理本地凭据并输出残留 session 工作区清单）；
3. 宿主脚本 `biao-node-service.ps1` 从 Credential Manager 读取 owner
   token 注入子进程环境，生命周期写 Windows 事件日志；服务停止请求 =
   投递 `state/control/drain.json` 控制文件（跨平台通道，不依赖信号）；
4. PowerShell 非原生 SCM 可执行体：生产用 NSSM/WinSW 类包装器注册同一
   宿主脚本即可，drain 语义不变。

## 5. drain 与升级流程（§10.5）

- drain 后 daemon 不再 claim（inbox 投递原样保留，服务端 claim 停止探测）；
- 等待 running attempts 收口；`drain_timeout_ms` 超时后按
  `drain_timeout_action` 显式选择：`cancel`（停止并上报）或 `wait`
  （继续等待，每个超时周期记一次审计事件）；
- 收口完成后 daemon 调 `POST /v2/nodes/:id/offline` 并以 0 退出；
- 升级：drain → 安装新版本 → 启动（新版本必须声明 protocol min/max，
  不兼容时 fail-closed 拒绝注册，不会静默接入）；
- 控制通道：`biao-node drain` 写 `state/control/drain.json`，daemon 主循
  环消费；SIGTERM/SIGINT 等价，第二次信号 = 立即 cancel。

## 6. lease watchdog（§10.4，R1B-006）

参数（配置键 → 默认值）：

| 参数 | 默认 | 语义 |
| --- | --- | --- |
| `lease_renew_margin_ms` | 30000 | 到期前多久开始主动续租 |
| `lease_stop_window_ms` | 15000 | 到期前预留的停止窗口（必须小于续租提前量） |
| `watchdog_tick_ms` | 500 | watchdog 巡检周期 |
| 时钟阈值 | 30s/60s/120s | 允许偏差/进入 degraded/quarantined；配置只能收紧不能放宽 |

行为：

- 首次续租失败 → attempt 进入 `lease_at_risk`（本地观察态 + 账本审计事件，
  不是服务端 `TaskAttemptV2.status`）；
- 到 `deadline - stop_window` 仍无法确认租约 → 停止本地工作（Phase 3 占位
  executor 记录停止；Phase 4 对 Agent 进程树 TERM/KILL），写 recovery
  bundle 桩（`state/recovery/<attempt_id>.json`，status=pending_recovery），
  后续产出不再作为合法 Delivery；
- 续租返回 409/generation 拒绝 → 立即停止并上报（`lease_lost`）；
- 服务端时间是租约真相：deadline 全部用本地单调时钟坐标，服务端 epoch 经
  `NodeClock` 的 server-offset 折算；当前心跳响应无 `server_now`（缺口 5），
  从 HTTP `Date` 头观测（秒级粒度）。

## 7. 故障处置

| 症状 | 判定 | 处置 |
| --- | --- | --- |
| `biao-node status` 显示 `phase=fenced`、退出码 3 | 旧 session/credential 被 fencing（新 session 已注册、节点被 revoke、或服务端裁决） | 检查控制面 `nodes` 列表与审计；若节点仍合法，重启 daemon（register 新 generation）；被 revoke 则重新 enroll |
| `phase=registering` 后 exit 4 | 协议不兼容/未声明 | 升级 biao-node 或服务端；过渡期在配置固定 `server_protocol_version` |
| 心跳连续失败但进程存活 | 网络分区 | daemon 自动重试并在恢复后自愈；分区期间不 claim 新任务、lease 按 watchdog 本地截止时间兜底 |
| `recent_errors` 出现 `LEASE_AT_RISK/REPORT_PENDING` | 续租/上报通道未确认 | 查看 `state/sessions/<boot>/ledger.jsonl` 与 `state/recovery/`；recovery 项等待服务端裁决（Phase 4 recovery-candidates） |
| 凭据文件权限错误导致拒绝启动 | group/other 有权限位 | `chmod 600 node-credential.json` 后重启 |
| 节点重启后旧 attempt | 已登记 orphan（pending_recovery），不会被新 session 接管 | 由控制面按 attempt generation 裁决（Phase 4） |

## 8. 与服务端的差距清单（Phase 2+3 集成后更新）

### 已关闭（Phase 2+3 集成门禁）

1. ✅ `GET /version` 公告 `protocol_version=2` → daemon 靠服务端公告协商
   （`src/server/http.ts` `/version` 路由）；
2. ✅ `POST /v2/nodes/register` 接受 `protocol_version` 字段，协议不匹配返回错误
   （`src/server/v2/node-service.ts` register 方法）；
3. ✅ 心跳 bvn2 鉴权 + session generation fencing → 409 SESSION_FENCED
   （`src/server/v2/routes/v2-routes.ts` heartbeat handler）；
4. ✅ bvn2 Node credential 成为 V2 节点路由正式鉴权（heartbeat/offline），
   enrollment ticket 校验（`BIAO_V2_ENROLLMENT_TICKET` env，timing-safe），
   `auth_mode=owner_fallback` 仅在 `BIAO_NODE_OWNER_TOKEN_FALLBACK=1` 时启用
   （`src/node/transport.ts`、`src/server/v2/node-service.ts`）；
5. ✅ Attempt 数据面三路由接通（替换 stub）：
   - `POST /v2/tasks/claim`：bvn2 鉴权 → 创建 task_attempts 行 → 签发 bva2；
   - `POST /v2/attempts/:id/lease/renew`：bva2 scope=claim + generation fencing；
   - `POST /v2/attempts/:id/report`：bva2 scope=report → reportV2WithArtifacts → delivery；
   - task_attempts/ownership_snapshots 表：migration `006_task_attempts`；

### 移交后续

6. 心跳 declared schema 未承认 `running_attempt_ids`/`node_status` 等
   §10.3 字段（运行时未启用 schema 校验，daemon 正常携带）；
7. 心跳响应无 `server_now` → 用 HTTP `Date` 头（秒级）观测服务端时间；
8. Windows 实跑验证未完成。

## 9. 相关测试

- `tests/distributed/p23-integration-gate.test.ts`（Phase 2+3 统一集成门禁）：
  端到端正向（enroll→register→heartbeat→claim→artifact→report→delivery→review）
  + 反向（篡改 bva2→401、跨任务 artifact→拒绝、enroll 错 ticket→拒绝、
  已完成任务→不可重复 claim）；
- `tests/distributed/p3-node-daemon.test.ts`（真实 HTTP server + 真实子进程
  daemon + fault-injector）：协议矩阵、enroll 权限、心跳字段与 skew 落库、
  重启 fencing 零重复 claim、drain 语义、lease watchdog 全链路、模板静态校验。
