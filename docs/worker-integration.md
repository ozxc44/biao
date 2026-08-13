# Worker 接入契约

本契约适用于 Codex、Kimi、通用 CLI 以及直接调用 HTTP API 的自定义 Worker。目标是让执行器只负责领取、在受限范围内完成任务、提交证据；它不能自行验收，也不能把 PM 决策退回给当前人类会话。

## 先决条件

在 clone 后先完成一次显式配置：

```bash
./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex
.biao/doctor
.biao/start
```

`--yes` 才授权 bootstrap 安装缺失的 Node.js / Redis 或启动本机 Redis；不带它的首跑只检查并在缺依赖时退出。`--workspace` 必须是精确的允许根目录，`--project` 必须位于该目录内。不要把用户目录或 `/` 作为工作区。

`.biao/config.env` 包含服务地址、工作区和 API Token，权限为 `600`。将它视为本机凭据：不提交、不打印、不传给执行子进程。

网页控制台启用鉴权时，保持 `.biao/start` 运行，另开终端执行 `.biao/copy-token`，再把剪贴板内容粘贴到网页右上角 **API Token**。网页只保存到当前标签页的 `sessionStorage`；命令不会把 Token 写进 argv、URL、版本库或默认终端输出。`.biao/token-status` 仅显示是否已配置和 SHA-256 指纹末尾。Linux 若没有 `wl-copy`、`xclip` 或 `xsel`，复制命令会安全失败并提示安装，不会回退为在终端显示凭据。

## PM Agent 不是 Worker

bootstrap 使用 `--pm-agent codex` 时，唯一共享 Supervisor 会在有 PM 事项时调用内置 `.biao/codex-pm-agent`，按需启动一次 ephemeral Codex PM；没有事项时不启动。它不领取任务、不持有 Worker lease / ownership，也不代替 Worker 执行。其他外部 PM Agent 可显式配置命令：

```bash
# 不在命令行传 Token；只有有 PM 事项时才会启动一次该命令。
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/pm-agent --once
```

被唤醒的 PM Agent 只能获得最小汇总，必须自行读取平台详情，并在实际处置后才 ack。它不自动 review、answer 或 ack，也不会自动安装 cron / launchd。Worker 遇到产品决策仍必须创建 Biao Question；不能把问题退回给当前人类，也不能假设 PM Agent 已经作答。文件占用、依赖等待和技术实现细节仍由 Worker / Supervisor 自行处理。

## 内置 Worker

单 Worker 兼容入口：

```bash
BIAO_AGENT_ID=codex-impl-1 \
BIAO_PREFERRED_PROJECT=/path/to/workspace/my-project \
.biao/worker-codex

BIAO_AGENT_ID=kimi-qa-1 \
BIAO_PREFERRED_PROJECT=/path/to/workspace/my-project \
.biao/worker-kimi
```

bootstrap 生成的单 Worker 入口默认在队列为空后退出，适合一次性执行。多 Agent 的常驻场景应使用共享 Supervisor，而不是为每个 Worker 留一个独立空轮询循环：

```bash
BIAO_WORKER_SLOTS='[
  {"kind":"codex","agentId":"codex-impl-1","project":"/path/to/workspace/my-project","types":["code","docs"]},
  {"kind":"kimi","agentId":"kimi-qa-1","project":"/path/to/workspace/my-project","types":["review","acceptance"]}
]' .biao/supervisor --consumer pm --interval 60
```

`agentId` 在同一台机器上必须唯一；`project` 是传给 claim 的 `preferred_project`，只会领取完全匹配该项目路径的任务。每个 slot 的 `types` 只限制可领取任务类型，不会绕过依赖、独立验收或 ownership 规则。

Supervisor 只有一个本机锁和一个共享低频主循环。空闲 slot 不创建独立 timer，也不各自轮询 claim；每个共享轮次只为每个空闲 slot 至多发送一次 presence heartbeat，避免服务端误判 stale。slot 一旦运行任务，presence heartbeat 停止，改由 Worker 自己维护带当前任务的 heartbeat 与 lease。所有受管 Plan 闭环后，Supervisor 自动退出。

## 必经的 Worker 生命周期

```text
register
  → claim(preferred_project)
  → 检查 ownership
  → 运行任务 + renew lease
  → 写结果 + 逐项 verify
  → report(done | failed, verify_results)
  → 正常退出时 agent/offline
```

### 1. 注册与领取

HTTP Worker 先注册，随后在每一次领取中显式传 `preferred_project`：

```bash
curl -X POST http://127.0.0.1:7331/register \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"remote-impl-1","agent_type":"custom","capabilities":["code","acceptance"]}'

# 保存 register 响应中的 data.registration_id；下面所有生命周期请求必须复用它。
# 推荐 Worker 在一次进程生命周期开始时自己生成 128 bit 随机 registration_id 并随 register 提交，
# 这样网络重试仍是同一代会话；不要在日志或不同 Worker 之间复用。

curl -X POST http://127.0.0.1:7331/claim \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id":"remote-impl-1",
    "registration_id":"<registration_id returned by register>",
    "claim_request_id":"<new random id for this claim call; reuse only for transport retry>",
    "blocking":false,
    "preferred_types":["code"],
    "preferred_project":"/path/to/workspace/my-project"
  }'
```

注册响应中的 `registration_id` 是该 Agent 进程的会话代次，不是任务凭据；`heartbeat`、`claim` 和 `agent/offline` 都必须携带它。每次业务 claim 还要新建一个高熵 `claim_request_id`；同一次 claim 的网络重试必须复用它，新的领取调用必须换新 ID。这样平台在“已领取、响应丢失”时会重放原任务与原 token，不会把 Worker 卡到 lease 过期。新进程用新的代次重新注册后，旧进程的心跳、领取和离线请求会被拒绝，不能覆盖同名新会话。领取成功响应中的 `task_id`、`claim_token`、`project_path`、`ownership_files`、`verify`、`timeout_seconds` 是本次 claim 的事实来源。不要复用旧 token；同一个 `agent_id` 同时只能持有一个 `running` 任务。

### 2. ownership：先检查，再写入

平台在 claim 成功时已经为任务声明的 `ownership_files` 取得 Lease 期内的独占记录。Worker 仍要在每个实际写入路径前检查：

```bash
curl -G http://127.0.0.1:7331/ownership \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  --data-urlencode 'path=src/server/auth.ts' \
  --data-urlencode 'agent_id=remote-impl-1'
```

响应的 `data.action` 含义如下：

| `action` | Worker 行为 |
| --- | --- |
| `proceed` | 仅在任务 `ownership_files` 范围内继续写入。自己的占用也会返回该值。 |
| `preempt` | 当前任务优先级更高。只有明确接受抢占时，调用 `POST /ownership/declare` 并带当前 `task_id`、`claim_token`、目标 files 与 `force:true`；否则按等待处理。 |
| `wait` | 不写文件；调用 `POST /task/:id/block`，`reason=waiting_file_release`，释放旧 lease/ownership，让共享 Supervisor 在文件释放后触发 fresh claim。 |

不要用 `ownership/declare` 绕过任务范围，也不要在 `wait` 时自己每隔几秒轮询或把文件冲突发给 PM。等待依赖同理：服务端不会把未满足依赖的任务交给 Worker；已经运行而需要释放等待时使用 `waiting_dependency`。这两类等待由事件驱动恢复，不进入 PM 的重复提醒。

### 3. 长任务续租

在 `timeout_seconds / 3` 左右续一次 Lease：

```bash
curl -X POST http://127.0.0.1:7331/lease/renew \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"my-feature-01-api","claim_token":"<current-claim-token>"}'
```

Lease 失效或 `CLAIM_TOKEN_INVALID` 后不得继续代表旧任务写入或 report；保留已有产物，重新 claim 获得新 token 后再继续。

### 4. 需要 PM 决策时发 Question

产品范围、发布策略、不可逆选择等不能自行决定的事项，必须通过 Biao Question 发给该 Plan 的 PM。内置 Worker 的执行子进程不会继承 Biao 的控制面凭据，因此最稳妥的方式是在 stdout 单独输出一行：

当前 Question API 与 CLI 的固定映射如下；`biao` 表示包提供的 CLI，bootstrap 环境中可通过生成的 `.biao/pm` wrapper 调用同一命令组。

| 角色 | HTTP API | CLI | 作用 |
| --- | --- | --- | --- |
| Worker | `POST /question` | `biao question ask` | 创建问题并带上当前任务、claim token 与可选 checkpoint。 |
| PM | `GET /questions` | `biao question list` | 列出待处理 Question 的最小路由信息。 |
| PM | `GET /question/:question_id` | `biao question get` | 读取问题正文与 checkpoint。 |
| PM | `POST /question/:question_id/answer` | `biao question answer` | 记录 PM 答案并允许任务重新入队。 |

```text
BIAO_QUESTION: {"body":"是否只发布 A 模块？","checkpoint":"测试已通过，尚未创建发布包"}
```

运行层会原子保存 Question、释放 claim/ownership，并使旧 claim token 失效。PM 从平台读取和回答后，任务重新进入 `pending`；后续 Worker 必须 fresh claim，取得新的 claim token，才能拿到 `question_answer` / checkpoint 并恢复执行。

直接 API Worker 可改用：

```bash
.biao/pm question ask \
  --task <task_id> \
  --claim-token <current-claim-token> \
  --agent-id remote-impl-1 \
  --body '是否只发布 A 模块？' \
  --checkpoint '测试已通过，尚未创建发布包'
```

`--agent-id` 必须是当前 claim 的真实 Worker 身份并显式传入；不得沿用 `.biao/pm` wrapper 默认的 `pm-agent`。成功响应会返回对应 `asked_event_id`，供 PM 在回答后精确 ack。

Question 不用于文件占用、依赖等待或技术实现细节；这些事项由 Worker/Supervisor 自行释放、继续领取或失败进入 repair。

### 5. 结果、Verify 与 report

在 `<project_path>/work/<task_id>/` 写入 `result.md` 和 `result.json`，并逐项执行 claim 返回的 `verify`。每项至少保留 `cmd`、`exit_code`、`passed`，以及必要的截断输出。最终上报：

内置 Worker 还会由外层调度器专属维护 `.progress.json`：以 `0600` 权限原子写入 `claimed → running → verifying → reporting → finished/failed`，且不会保存 claim token、API 凭据、Agent 原始输出或异常正文。执行 Agent 不得自行创建或覆盖该文件；`finished` 只表示本次 Worker report 已落地，不表示 PM Review accepted。自定义 Worker 可以采用同一约定，但 `.progress.json` 不能替代下面的 report。

```bash
curl -X POST http://127.0.0.1:7331/report \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "task_id":"my-feature-01-api",
    "agent_id":"remote-impl-1",
    "claim_token":"<current-claim-token>",
    "status":"done",
    "result_path":"/path/to/workspace/my-project/work/my-feature-01-api/result.md",
    "result_json_path":"/path/to/workspace/my-project/work/my-feature-01-api/result.json",
    "verify_results":[
      {"cmd":"npm test -- auth","exit_code":0,"passed":true,"output":"tests passed"}
    ]
  }'
```

`done` 的严格规则：

- `verify_results` 必须和计划中声明的 Verify 逐项、按顺序匹配；
- 任一 Verify 失败时必须 report `failed`，伪报 `done` 会被拒绝；
- `acceptance` 任务还必须有至少一项通过的 Verify、可读的 `result_path` 和明确的通过/不通过结论；
- acceptance 不能由执行被验收任务的同一 `agent_id` 完成。

`done` 只是交付状态，不是项目完成状态。依赖放行和 Plan 完成必须以 `pm_review_status=accepted` 为门槛；验收必须由不同于实现 Worker 的独立 Agent 执行并提交可重现证据。失败或被拒绝后的下一步由 repair 闭环处理，见 [无人盯盘的闭环](autonomous-closure.md)。

### 6. 正常退出时显式离线

内置 Worker 和共享 Supervisor 会在正常退出、停止信号或所有受管 Plan 终结时自动调用离线接口。自定义 HTTP Worker 若不再保持心跳，也应完成同样的生命周期收口：

```bash
curl -X POST http://127.0.0.1:7331/agent/offline \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"remote-impl-1","registration_id":"<registration_id returned by register>","reason":"worker_exit"}'
```

允许的 reason 为 `worker_exit`、`worker_signal`、`plans_terminal`、`supervisor_signal`、`supervisor_exit`。该调用幂等，会标记离线并把最后任务、离线原因和时间保留为历史审计；任务已终结时清除 `current_task`，任务仍为 `running` 时则保留该指针并停止续租，确保 `/status` 与 watchdog 能在 lease 到期前后持续看到并安全回收它。接口不会删除注册记录、任务、报告或 Review。进程异常崩溃来不及调用时，平台才以心跳超时和 watchdog 兜底。
