## Phase 3 交付总结（biao-node Skeleton · 车道 C）

### 变更文件（全部在车道所有权内）

| 文件 | 内容 |
| --- | --- |
| `src/node/daemon.ts` | 守护进程状态机：boot→registering→running→draining→drained / fenced；控制文件 drain、孤儿扫描、心跳（§10.3）、offline 收口 |
| `src/node/cli.ts` | enroll 向导（票据只收文件/stdin/交互式，拒绝 argv）+ run/status/drain 子命令；退出码 0/2/3/4/124 |
| `src/node/protocol.ts` | 协议协商 fail-closed 门（min/max 区间、BELOW_MIN/ABOVE_MAX/UNDECLARED） |
| `src/node/clock.ts` | NodeClock：单调时钟排期、Date 头观测服务端时间、30/60/120 阈值只紧不松（§10.4） |
| `src/node/transport.ts` | V2 HTTP 客户端：信封解析、失败分类（FENCED/UNAUTHORIZED/NOT_IMPLEMENTED…）、401→owner 过渡回退、可注入 fetch |
| `src/node/lease-watchdog.ts` | R1B-006 统一租约看门狗：主动续租→at_risk→停止窗口停工；409 立即 lease_lost |
| `src/node/slots.ts` / `ledger.ts` | 槽位表 + 占位 executor + inbox 原子 rename 认领（唯一赢家）；session 账本与孤儿扫描 |
| `src/node/config.ts` / `credentials-store.ts` / `templates.ts` | 配置校验（禁机密字段、§19.1 路径规则）；0600 凭据原子读写；占位符登记/渲染 |
| `bin/biao-node.js` + `package.json`（仅 1 行 bin） | 入口 |
| `templates/node/`×4 | launchd plist / systemd unit / biao-node-service.ps1 / install-windows.ps1（R1C-004：Credential Manager、Event Log 源、幂等安装+回滚） |
| `tests/distributed/p3-node-daemon.test.ts` | 24 用例失败优先测试 |
| `docs/runbooks/biao-node.md` | 中文运维手册 |

### 验证

- `npx tsc` 构建通过；`npx vitest run tests/distributed/` **16 文件 224 用例全绿**（p3 新增 24 用例）。
- 全量 `npx vitest run`：**112 文件 / 1260 用例，1259 绿、1 失败**——唯一失败是 `tests/supervisor-pm-agent-cli.test.ts` 的 SIGINT 时序用例（`grandchildStopped` 断言），与记忆中登记的已知 flaky 同签名；该测试依赖图中无任何 biao-node/src/node 引用（已验证），且 `scripts/supervisor.mjs` 在本任务开始前已是其他车道未提交修改。基线 110/1226 → 112/1260（含并行车道增量），无本车道导致的劣化。

### 验收对照（§21 Phase 3 原文）

- **重启/掉线/drain 零重复 claim、旧 session fencing**：SIGKILL 掉线→重启后 store 断言 gen1 `fenced`、gen2 `active`；旧 attempt 只登记 `pending_recovery` 不被新 session 接管；全部账本中 `adopted` 事件恰一次（inbox 原子 rename 保证无第二个赢家）；drain 后新投递不被认领。
- **lease watchdog**：真实 server stub 下续租不可确认→`lease_at_risk`→停止窗口停工→recovery bundle→`report_pending`；409/generation 立即 `lease_lost`（单元矩阵+in-process）。
- **时钟偏差**：子进程注入 +15s→服务端 `clock_skew_ms ≈ -15000` 落库；阈值档位/只紧不松单测。
- **协议矩阵**：未声明/1/3 → exit 4 fail-closed 拒绝注册且 register 从未发生；2/固定 2 → 正常。
- **模板静态校验**：占位符 ⊆ 登记表、install ⊇ 宿主脚本键、渲染无残留/漏传抛错。

### 交付说明要点

- **状态机图 / watchdog 参数（renew_margin 30s、stop_window 15s、tick 500ms、时钟 30/60/120s）/ 协议矩阵**：`docs/runbooks/biao-node.md` §1/§6 与 `src/node/*.ts` 头注释。
- **server 侧接口缺口清单（8 项，未回改）**：runbook §8——/version 无 protocol_version 公告；register 无 protocol/session generation 字段；心跳不校验 session/credential generation（409 强制未启用）；心跳 schema 未承认 running_attempt_ids/node_status；响应无 server_now（用 Date 头替代）；V2 鉴权仍 owner bearer、bvn2 未被接受且 enrollment ticket 未校验（daemon 以 `auth_mode=owner_fallback` 过渡）；claim/renew/report 为 stub（inbox 占位 claim）；drain 仅 human_owner（daemon 本地 drain+node scope offline）。

### 残留风险

1. 心跳扩展字段（running_attempt_ids 等）依赖“运行时未启用 schema 校验”——服务端一旦启用 `additionalProperties:false` 会 400，需与字段扩契约同步（缺口 #4）。
2. package.json `files` 未包含 `templates/`（所有权限 bin 行，未越权），打包分发的服务化模板需后续补一行。
3. Windows 产物仅静态校验（按约束不在 macOS 实跑 Service）；PowerShell 直宿主 SCM 需 NSSM/WinSW 包装（模板已注明）。
4. 已知 flaky `supervisor-pm-agent-cli.test.ts` 属其他车道未提交工作，建议在其车道收口。