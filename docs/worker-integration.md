# Worker 接入契约

本契约适用于 Codex、Kimi、通用 CLI 以及直接调用 HTTP API 的自定义 Worker。目标是让执行器只负责领取、在受限范围内完成任务、提交证据；它不能自行验收，也不能把 PM 决策退回给当前人类会话。

若接入的是不了解 Biao 的新 harness，可先使用无凭据的
[`agent-kit contract → scaffold → check`](agent-adapter-kit.md) 生成并离线验证单文件适配器，
再把它登记为 Supervisor 的 custom Worker slot 或 Plan PM 路由。

已有 Biao 凭据的新 Agent 想最快加入：一条命令完成注册、自动绑定与 Worker Token 落盘，详见 [agent-join 一站式加入](agent-join.md)：

```bash
biao-agent-join --agent-id <id> --agent-type <type> --capabilities code --project-scope /abs/project
```

## MCP 优先

Harness 已配置 biao MCP（ZCode、Codex 等支持 MCP 的客户端）时，Agent 应优先使用 MCP 工具（`task_claim` / `task_get` / `task_heartbeat` / `task_report` / `task_block` 等），它们与本契约的 HTTP API 是同一套服务端真相，配置见 [MCP 接口](mcp.md)。下文的裸 HTTP 生命周期适用于无 MCP 能力的自定义 Worker 与运维排障。

**加入即默认**：Agent 领取任务成功后即自动加入该项目（automatic 绑定），Web 控制台 roster 默认显示"已加入"；复制/克隆方式接入的 Worker 不需要再到前端点"添加"。前端的"添加"仅用于把其它在线 Agent 手工加入当前项目。

**远程 Worker 交付**：没有中央工作区文件系统访问的 Agent，`task_report` 可直接内联 `result_md` / `result_json` 正文（由中央受控落盘到 `work/<task_id>/`），并传 `execute_verify` 让中央在任务工作区代执行声明的 verify；claim / task_get 返回 `goal_md` 正文，verify 命令本身不外泄。

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

人类 PM 在 loopback 本机直接打开网页，首次点击“进入控制台”即可获得 HttpOnly 本机 Owner 会话；浏览器不会接收或保存 API Token。`BIAO_API_TOKEN` 仅供 Worker、PM CLI 和受控 API 客户端使用，生成的启动器会从 `.biao/config.env` 读取它。`.biao/token-status` 仅显示是否已配置和 SHA-256 指纹末尾；`.biao/copy-token` 仅供受控 CLI 调试，不用于网页登录。

## PM Agent 不是 Worker

bootstrap 使用 `--pm-agent codex` 时，唯一共享 Supervisor 会在有 PM 事项时调用内置 `.biao/codex-pm-agent`，按需启动一次 ephemeral Codex PM；没有事项时不启动。它不领取任务、不持有 Worker lease / ownership，也不代替 Worker 执行。其他外部 PM Agent 可显式配置命令：

```bash
# 不在命令行传 Token；只有有 PM 事项时才会启动一次该命令。
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/pm-agent --once
```

若不同 Plan 由不同 PM 会话负责，使用 `BIAO_PM_AGENT_ROUTES` 做本机路由。每项包含
`command`（适配器绝对路径或受控命令）和可选 `target`（会作为 `BIAO_PM_TARGET`
传入）；精确 Plan 优先，`*` 为默认。命令与 target 不进入 Redis、任务正文或门铃 JSON。
Codex 内置适配器把 target 解释为 thread ID；ZCode、Kimi 和其他 harness 的适配器
必须读取同一份最小 stdin 门铃，自行回平台取详情，并用退出码表示是否真实处理完毕。

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
.biao/supervisor-config worker add --id codex-impl-1 --kind codex \
  --project /path/to/workspace/my-project --types code,docs
.biao/supervisor-config worker add --id kimi-qa-1 --kind kimi \
  --project /path/to/workspace/my-project --types review,acceptance
.biao/start

跨机 slot（中央规范路径 ≠ 本机路径时）：`--project` 填中央规范 project_path（用于
注册与 claim 匹配），`--workspace` 填本机真实 checkout。任务 project_path 在本机
不存在时，执行、verify 与产物目录都落在 workspace 下；上报的 result_path 仍按
中央规范路径记账。示例：

```bash
.biao/supervisor-config worker add --id kimi-remote-1 --kind kimi \
  --project /data/workspaces/my-project --workspace /Users/me/src/my-project --types code,docs
```

`worker add/remove` 会同步维护 `BIAO_PM_WATCH_KEEP_WORKER_SLOTS`：配置了 slot 的
机器，pm-watch 留守链同时守 PM 门铃并主动领取/执行任务；移除到空则回落纯门铃模式。
```

`agentId` 在同一台机器上必须唯一；`project` 是传给 claim 的 `preferred_project`，只会领取完全匹配该项目路径的任务。每个 slot 的 `types` 只限制可领取任务类型，不会绕过依赖、独立验收或 ownership 规则。

Supervisor 只有一个本机锁和一个共享低频主循环。它本身就是 Worker slot 的生命周期所有者，不要求 Codex/Kimi 先常驻在线：出现 pending、repair 或 reverify 时由 Supervisor 领取，领到后才启动实际 Agent CLI。空闲 slot 不创建独立 timer，也不各自轮询 claim；每个共享轮次只为每个空闲 slot 至多发送一次 presence heartbeat，避免服务端误判 stale。slot 一旦运行任务，presence heartbeat 停止，改由 Worker 自己维护带当前任务的 heartbeat 与 lease；任务结束后同一 Supervisor 立即检测下一项。所有受管 Plan 闭环后，Supervisor 自动退出。

## Harness 自带的一次性唤醒脚本

已有自己会话、运行时或远程节点的 harness，不应常驻一个 Worker 每隔数秒调用 `/claim`。每种 harness 只需提供一个可执行的、一次性的“心跳/唤醒脚本”：Supervisor 发现匹配任务时才调用它，脚本唤醒自己的 harness，然后立即返回安全回执。

这里的“心跳”是被 Supervisor 触发的 one-shot hook，不是 harness 自建 cron、launchd 或定时轮询。Supervisor 是唯一等待者，同一个进程同时负责 Worker 任务和 PM 门铃。

```bash
# 1. 让 harness 生成自己的脚本骨架并完成实际唤醒逻辑。
.biao/agent-kit scaffold --role project-agent --mode external_worker \
  --output /absolute/path/glm53-wake

# 2. 无凭据验证协议和可执行性。
.biao/agent-kit check --role project-agent --mode external_worker \
  --adapter /absolute/path/glm53-wake

# 3. 登记 harness 级 slot。binding-id 可省略：复制进入的 Worker 在首次领取成功后
#    自动加入项目；Supervisor 按 agent-id + harness-kind + wake-mode 匹配动态项目连接。
.biao/supervisor-config worker add --id glm5.3 --kind custom \
  --project /absolute/path/project --types code,docs,review \
  --command /absolute/path/glm53-wake \
  --harness-kind glm --wake-mode external_worker --adapter-id glm53-wake-v1
```

Supervisor 通过 stdin 向脚本传入一行 `biao.worker-wake/v1` JSON 载荷，不传 Biao API Token、claim token 或 PM 目标。脚本唤醒成功后必须在 stdout 输出一行 JSON 回执。真实的 harness 随后使用它自己的本机授权去 register/claim。脚本返回非零、超时、输出多行或缺合法回执时，Supervisor 记录失败并留待后续重试，不把“已启动进程”当作已执行任务。

### 唤醒载荷字段

顶层字段（`biaoUrl`、`slotId` 保持 camelCase，属于脚本间内部约定）；`binding` 与 `reservation` 的字段一律 **snake_case**，与 HTTP API 和 `ProjectAgentBinding` 类型一致：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| 顶层 | `protocol` | 固定 `biao.worker-wake/v1` |
| 顶层 | `biaoUrl` | Biao 服务地址（无凭据） |
| 顶层 | `slotId` | 发起唤醒的 Supervisor slot |
| `binding` | `binding_id` / `agent_id` / `harness_kind` | 项目连接身份 |
| `binding` | `wake_mode` | `visible_session` 或 `external_worker` |
| `binding` | `adapter_id` | 回执中必须原样返回 |
| `selector` | `project` / `capability` / `kind` / `model` / `planIds` | 命中该唤醒的工作范围 |
| `reservation?` | `reservation_id` / `task_id` / `expires_at` | 仅带预留的唤醒出现；`expires_at` 是毫秒时间戳 |

载荷绝不包含 `taskId` 明文任务详情以外的凭据类字段：出现 `claim_token`、`command`、`target`、`authorization`、`bearer`、`secret` 等 marker 会立即被适配器与契约测试拒绝；传给适配器的环境变量也只保留 `PATH` 等白名单与 `BIAO_RUNTIME_DIR`。

### 回执字段

stdout 必须只有一行 JSON：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `protocol` / `ok` | 是 | `biao.worker-wake/v1` / `true` |
| `adapter_id` | 是 | 与载荷 `binding.adapter_id` 一致，`[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}` |
| `registration_id` | 是 | 适配器自选的安全 ID，同上正则 |
| `harness_kind` / `wake_mode` | 是 | 与 binding 一致 |
| `task_id` / `reservation_id` | 条件 | **载荷带 `reservation` 时必填**，且必须与载荷原样一致 |
| `session_ref` | 否 | 安全字符集，不含凭据 marker |
| `visible_url` | 否 | http(s) 绝对 URL 或站内绝对路径，禁止查询串、hash 与凭据 |

**reservation 回带规则**：唤醒载荷提供过 `reservation` 时，回执必须原样回带 `task_id` 与 `reservation_id`；缺失或不一致（包括带回别的任务的 ID）都会被判失败。该规则在 worker-agent 与 Supervisor 终校验两层独立执行——worker-agent 会先拒绝一次，坏回执不会进入 Supervisor 进程；reservation 是重启栅栏的 `attempt_id` 来源，两层校验共同防止串扰回执落库。

### 最小适配器示例

```js
#!/usr/bin/env node
// biao.worker-wake/v1 最小外部适配器：stdin 一行载荷进、stdout 一行回执出。
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const protocol = 'biao.worker-wake/v1';
if (process.env.BIAO_ADAPTER_PROBE === '1') {
  // 离线探测：adapter-kit check 用它验证协议与可执行性。
  console.log(JSON.stringify({ ok: true, protocol, role: 'project-agent', wake_mode: 'external_worker' }));
  process.exit(0);
}

const wake = JSON.parse(readFileSync(0, 'utf8'));
if (wake?.protocol !== protocol || wake?.binding?.wake_mode !== 'external_worker') process.exit(2);

// TODO: 在这里唤醒真实 harness；它随后用本机授权 runtime 自行 register/claim。
// 成功才输出回执；失败时以非零退出让 Supervisor 下一轮重试。

console.log(JSON.stringify({
  protocol, ok: true,
  adapter_id: wake.binding.adapter_id,
  registration_id: `my-harness-${randomUUID()}`,
  harness_kind: wake.binding.harness_kind,
  wake_mode: wake.binding.wake_mode,
  // 带 reservation 的唤醒必须原样回带，否则两层校验都会拒绝。
  ...(wake.reservation ? {
    task_id: wake.reservation.task_id,
    reservation_id: wake.reservation.reservation_id,
  } : {}),
}));
```

仓库内 `src/worker/harness/external-stub.mjs` 是该协议的通用参考实现（含凭据断言与协议不匹配退出码 2），可直接对照实现。后台直接执行器仍使用 `background_executor`，它由 Supervisor 代为 claim，不使用上述 harness-owned 唤醒协议。

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

经 MCP 领取的会话有一层兜底：`task_claim` 成功后，`biao-mcp` stdio 进程会按 `BIAO_MCP_AUTO_HEARTBEAT_MS`（默认 60s，`0` 关闭）在后台自动 `heartbeat + lease/renew`，直到 `task_report` / `task_block` / `question_ask` 释放 lease（见 [MCP 接口](mcp.md)）。裸 HTTP Worker 没有这层兜底，仍必须自己在执行期维护心跳。

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
| Worker | `POST /question` | `biao question ask` | 创建问题并带上当前任务、claim token、可选 checkpoint 与结构化 `requested_ownership`。 |
| PM | `GET /questions` | `biao question list` | 列出待处理 Question 的最小路由信息。 |
| PM | `GET /question/:question_id` | `biao question get` | 读取问题正文与 checkpoint。 |
| PM | `POST /question/:question_id/answer` | `biao question answer` | 记录 PM 答案；有扩权申请时必须显式批准或拒绝，再允许任务重新入队。 |

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

任务执行中发现必须修改原 ownership 以外的路径时，Worker 必须先停止写入，并用结构化参数申请：

```bash
biao question ask --task <task_id> --claim-token <token> --agent-id <worker-id> \
  --body '需要新增合同测试' \
  --request-ownership '{"files":["apps/api/src/new-contract.test.ts"],"modules":["api-tests"]}'
```

PM 审查 Question 后必须二选一执行 `question answer ... --approve-ownership` 或 `--reject-ownership`。批准会把审计后的范围合入任务，拒绝则保持原范围；两种结果都释放旧 claim，Worker 只能通过 fresh claim 获得最终范围后继续。`ownership declare --force` 只允许在既有任务授权范围内处理占用优先级冲突，不能用于扩权，也不能把请求体中的文件声明当作 PM 授权。

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

## PM 门铃自愈（pm-watch）

多台机器共用同一个中央 Biao 时，PM 唤醒依赖某台机器上常驻的门铃监视器。`.biao/pm-watch` 是低资源留守入口：不启动本地 server、不注册 worker slot，只消费 PM 门铃并按需唤醒 PM Agent；所有计划闭环后留守低频复查，中央失联时按 `BIAO_PM_WATCH_RESTART_DELAY`（默认 30s）退避重试。

在 `.biao/config.env` 设置 `BIAO_SUPERVISOR_AUTO_ENSURE=1` 后，以下完成事件会在成功时自动确认本机的 `pm-watch` 仍在运行（幂等，重复触发只做一次判活）：

- MCP `task_report` / `pm_review_decide` / `question_answer` 成功返回；
- worker runtime 的 `/report` 上报成功（共享 Supervisor 管理的 slot worker 同样覆盖）；
- CLI `biao pm ack` 与 `biao question answer` 成功。

自愈入口是 `pm-watch --ensure`：有活实例时立即返回，否则拉起一个后台副本。单实例由 `.biao/pm-watch.lock` 原子目录锁保证；包装器被强杀后遗留的孤儿 supervisor 会因 supervisor 级锁让新包装器安静退出，不会形成重启空转。该行为默认关闭（bootstrap 生成 `0`），只在显式开启的机器上生效，符合"不偷偷安装常驻"的边界。注意它是事件驱动兜底：本机没有任何 worker/PM 活动时（例如远程机器上报后中央挂铃），不会触发自愈；对可用性要求更高的机器可再叠加系统级保活（macOS LaunchAgent KeepAlive / systemd）。
