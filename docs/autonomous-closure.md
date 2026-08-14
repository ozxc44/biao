# 无人盯盘的闭环

Biao 的目标不是让 PM 常驻看板，而是把每次状态变化变成可恢复的、低噪音的下一步：Worker 继续执行、PM 只在需要独立判断时读取平台详情，全部计划闭环后监视自动停止。

## 谁处理什么

| 状态 / 事件 | 下一步责任人 | 是否成为 PM 门铃 |
| --- | --- | --- |
| `done`，等待验收 | 独立验收者与 PM | 是，`review_requested` |
| 独立验收任务可领取 | 独立验收者 | 是，`acceptance_ready`，PM 只需按需查看 |
| Worker 缺少产品决策 | 对应 Plan 的 PM | 是，`question_asked`；正文按需二次读取 |
| `waiting_file_release` | Worker / 共享 Supervisor | 否；文件释放后重新领取 |
| `waiting_dependency` | Worker / 共享 Supervisor | 否；前置闭环后重新领取 |
| Worker failed、Verify failed、PM reject | 平台生成的 repair Worker | 否；平台写入 `repair_scheduled` 审计并排队，PM 等 repair 交付后的验收门铃 |
| repair 达到 `max_retries` | PM | 是；根任务为 `needs_pm_decision` |
| stale Worker / stale lease | Worker/Supervisor 显式离线；异常中断再由 watchdog 安全恢复或 PM | 仅失联且仍持有 running task 时提醒；空闲与终态历史注册静默 |
| 升级前遗留的 `done + pending review` 伪完成 | PM 显式 `supersede` | 否；撤下活跃验收门铃，保留原结果和审计 |

门铃不带结果正文、Question 正文、Verify 输出或 ownership 明细。PM 收到最小 `plan/task/type/count` 后，再用 `.biao/pm task get`、`.biao/pm review`、`.biao/pm question get` 获取详情。

`/status` 同时保留两种视图：`tasks` / `reviews` 是向后兼容的不可变审计总数；`attention` 是当前待处理 failed/rejected、`needs_pm_decision` 和 stale-running Agent；`history` 是已经 repair-resolved 的失败/拒绝与不再占用资源的历史 Agent。网页红色指标只消费 `attention`，但历史卡片和 SQLite 审计不会被删除。

## 正常交付和依赖门槛

```text
实现 Worker report done
          │
          ├── 产生 review_requested
          ├── 独立 acceptance 可在此时领取（避免验收自身死锁）
          └── 普通下游仍不可领取

PM Review accepted 或 repair resolved
          │
          └── 普通下游任务解除依赖，重新成为可领取任务
```

因此：`done`、`task_completed` 事件、Worker 退出码 0、或某个 result 文件都不是“完成”。普通依赖只接受 PM `accepted`，或者保留原始失败审计但已经由 repair `resolved` 的前置任务。

## repair 闭环

### 触发条件

以下任一条件都会创建 repair，而不是把任务无限留在 failed/rejected：

1. Worker report `failed` 或 Verify 失败；
2. 独立 acceptance report 失败；
3. PM Review `--reject --reason ... --fix-instructions ...`。

repair 是同一项目中的可领取任务，默认继承源任务的 ownership、Verify、项目路径和可审计故障上下文。它没有“依赖失败的源任务”这种反向依赖。

若 PM 在 reject 后确认必须修复一个原 ownership 外的相邻文件/模块，可显式使用受控扩权：

```bash
.biao/pm review <task_id> --reject --reason '验收原因' --fix-instructions '可执行修复要求' \
  --repair-ownership '{"files":["src/adjacent.ts"],"modules":["adjacent-module"]}'
```

这不是修改或替换原 ownership：平台只将去重后的新增项与来源范围取并集，写入**新 repair**的 `repair_ownership_extension` 审计字段和 goal；来源任务保留原 ownership、结果与拒绝审计。参数仅接受 `files` / `modules` 字符串数组，至少一项非空，单项最长 512 字符、总数最多 64；含空项、控制字符、逗号、未知字段或没有实际新增范围的请求都会被拒绝。

### 只重新验收（不修来源）

当 PM 已确认所有 `acceptance_for` 来源均为 accepted/resolved，问题仅在验收报告或证据时，可显式跳过来源 repair：

```bash
.biao/pm review <acceptance_task_id> --reject \
  --reason '来源实现无问题，仅验收证据不足' \
  --fix-instructions '重新运行原 Verify 并提交完整证据' \
  --reverify-only
```

该操作把 `resolution_mode=reverify` 写入原 reject 的不可变审计，并立即创建 `<acceptance-root>-reverify-N`。fresh task 分别原样继承原 acceptance 的 `depends_on` 与 `acceptance_for`（不可把二者互换），并继承 ownership、Verify，同时排除原验收者和历史链执行者；它仍要由 Worker report，并由 PM accept 后才关闭根验收。所有原依赖和来源均须已 accepted/resolved。相同参数的网络重试幂等复用同一 task，改用另一种处置模式不能改写旧 reject。进程若在写审计后退出，启动补偿按持久化模式补建 fresh reverify，不会误生来源 repair。

`--reverify-only` 只适用于 acceptance reject，所有来源未 accepted/resolved 时 fail closed，且不能与 `--repair-ownership` 共用。单来源 acceptance 未指定该参数时使用来源 repair；多来源 acceptance 不得默认 fan-out，PM 必须改用独立复验，或分别处理具体来源。

独立 acceptance 失败时，repair 归属被验收的原实现，而不是归属失败的 acceptance 自身。这一点避免了：

```text
失败 acceptance → repair 依赖 acceptance → 永远不可领取
```

### 成功和上限

repair 的 Worker 仍须 report，且 repair 本身仍要经过 PM Review。若计划另行声明 repair 的独立 acceptance，该 acceptance 也必须由不同 Agent 执行。PM 接受 repair 后，平台沿 `fix_for` 链把源任务标记为 `resolution_status=resolved`，但不改写源任务的原始 `failed` 或 `rejected` 审计。计划状态据此重新计算；所有有效任务均已 accepted/resolved（或取消）时，计划才完成。

repair report `done` 而尚未 Review 时，源任务会显示 `resolution_status=required`、`resolution_action=reverify`。这不是让 PM 回头 accept 原任务；PM 应读取并 Review 当前 repair task。

每条 repair 根链最多自动尝试源任务的 `max_retries` 次（至少一次）。达到上限后根任务进入：

```text
resolution_status=needs_pm_decision
resolution_action=inspect
```

这才是 PM 必须判断的边界。PM 不应通过无依据的 `task reset --force` 打断仍在 `repairing` 的链。CLI 提供一个只读动作和两个显式决策动作：

```bash
# 默认 inspect：读取根因、最新 repair、完整 lineage、尝试次数与可用动作，不写状态
.biao/pm task resolution <task_id>

# 证据支持再尝试时，只额外放行一代 repair/reverify
.biao/pm task resolution <task_id> --action continue

# 明确放弃当前修复链；保留全部失败、拒绝与 repair 审计
.biao/pm task resolution <task_id> --action cancel
```

retry-limit 链被 cancel 后保持静默终态；如果操作者后来确认需要继续，可再次显式运行
`--action continue` 重开一代。该操作不会 reset 或覆盖既有拒绝、失败、cancel 审计。

`continue` 和 `cancel` 默认把当前 `BIAO_AGENT_ID` 记录为决策者，也可显式传 `--decided-by <pm>`。只有 continue/cancel 成功后才 ack 对应 `resolution_required` 事件；只执行 inspect 不代表事项已经处置，`--require-drained` 会继续保留门铃。

历史多来源验收若已以 repair 方式拒绝，会进入 `repair_sources_required:<acceptance>`，不再对所有来源自动扩散。PM 核对最新拒绝证据后显式点名一个来源：

```bash
.biao/pm task resolution <acceptance_task_id> --action continue --repair-source-task <source_task_id>
```

## PM 的低频操作

每个 PM 会话从统一入口开始：

```bash
.biao/pm-start --once
```

它会检查 health、status、最小 intake 以及一轮共享 Supervisor，并允许幂等恢复 lease/等待态；若显式配置 Worker slot，也会在声明范围内调度。它不会自动 ack、不会自动 answer Question、不会自动 accept/reject。随后按具体事项执行：

```bash
# 最小门铃与持续事实
.biao/pm pm intake --consumer pm --json

# Question：先列出，再按 ID 读正文和答复
.biao/pm question list --consumer pm --status open --plan <plan_id>
.biao/pm question get <question_id> --consumer pm --plan <plan_id>
.biao/pm question answer <question_id> --consumer pm --plan <plan_id> --answer '明确决定'

# 验收：先读取 evidence，再作出判断
.biao/pm review <task_id>
.biao/pm review <task_id> --accept --comment '验收依据'
.biao/pm review <task_id> --reject --reason '失败原因' --fix-instructions '可执行修复要求'
.biao/pm review <task_id> --reject --reason '失败原因' --fix-instructions '可执行修复要求' --repair-ownership '{"files":["src/adjacent.ts"]}'

# retry 耗尽：inspect 只读；continue/cancel 才完成这次 PM 决策
.biao/pm task resolution <task_id>
.biao/pm task resolution <task_id> --action continue
.biao/pm task resolution <task_id> --action cancel

# 只有已实际处置门铃后才 ack；ack 不等于验收
.biao/pm pm ack --consumer pm --plan <plan_id> --event-id <asked_event_id>
```

`pm intake` 的事件是可补读的；即使 `review_requested` 已 ack，仍处于 `done + review pending` 的任务会继续作为持续事实显示，直到 PM 接受或拒绝。反之，文件/依赖等待会由事件驱动恢复，不应通过 PM intake 反复催人。

### Blocked、stale 与 legacy failed 的最小恢复

PM Agent 不应把所有异常都归结为 `reset`。先按门铃里的 ID 读取当前状态：

```bash
.biao/pm task get <task_id>
```

- `waiting_dependency / waiting_file_release` 是平台与共享 Supervisor 的内部等待，正常不会成为 PM 门铃。条件满足时 `/reconcile` 会把任务安全放回 pending；不要手工 resume、reset 或 ack 催跑。
- `waiting_pm_reply` 只能通过对应 Question 的 `answer` 恢复，通用 `task resume` 会被拒绝。
- 未知 blocked 必须先核对任务证据和外部条件。只有确认条件已经消失时才执行 `.biao/pm task resume <task_id>`，随后重读 task/intake；否则保留 blocked 与未 ack 门铃。
- stale agent 或 running 已丢 lease 时执行 `.biao/pm watchdog --auto-fix`，然后重读 task/intake。它只安全回收失效 lease、标记 stale agent，并补偿没有 resolution 的遗留 failed；不自动验收。
- failed 先看 `resolution_status`：`repairing` 等 Worker，`required` Review 当前 repair，`needs_pm_decision` 使用 resolution 三动作。没有 resolution 的 legacy failed 可运行一次 `.biao/pm watchdog --auto-fix` 补建 repair。禁止 reset 原任务绕过 repair 审计。

只有对应恢复动作成功且 intake 当前事实消失后才 ack。真正无法自治时保留门铃，让共享 Supervisor 在低频下一轮重试；不得为了让 `--require-drained` 变绿而改写状态。

### 遗留伪完成的安全退出

只有升级前误写为 `done`、当前仍待验收、且没有 resolution 的历史任务可以 `supersede`。正常交付仍必须走独立验证和 PM Review，不能用它绕过验收：

```bash
# 单任务：没有活跃依赖者时才允许
.biao/pm task supersede <task_id> --reason '旧版本误写完成且无可验收证据' --yes --by <pm>

# 整个 Plan：必须先读候选/阻塞和快照 token，再显式应用同一快照
.biao/pm plan supersede <plan_id> --preview
.biao/pm plan supersede <plan_id> --reason '退出遗留伪完成' \
  --preview-token <preview_token> --yes --by <pm>
```

平台把退出决定写为终态 `superseded`，撤下当前验收索引和最小门铃，但保留 `done_at`、result、Verify、既有 PM 字段以及不可变事件流，并追加操作者、原因和时间。单任务存在依赖者会拒绝；Plan 预览会把不在同批候选中的活跃任务或外部依赖者列为 blocker。预览后任何任务状态或依赖变化都会使 token 失效，必须重新预览；操作不会自动 reset、删除结果、级联取消或部分应用。

## 外部 PM Agent 的一次性门铃（显式 opt-in）

交互式 PM 用 `.biao/pm-start --once` 开始一轮工作。若部署者另有外部 PM Agent，可用 bootstrap 生成的 `.biao/pm-agent --once` 把**已有的、需要 PM 判断的最小 intake**交给它：

```bash
# 仅放本机 PM Agent 的启动命令；不要把 Biao Token 写在命令行。
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/pm-agent --once --plans plan-a,plan-b
```

这个入口不是第二个 Supervisor，也不是自动验收器：

- 无可处理事项时静默成功，完全不创建子进程；有事项却未显式设置 `BIAO_PM_AGENT_CMD` 时以可辨识错误退出，避免假装已通知。
- 子进程只收到 `biaoUrl`、`consumer`、可选 `planIds`、事项类型计数和总数；不传 task/event ID、结果、Verify 输出、Question 正文、ownership 明细或 Token。
- 被唤醒的 Agent 必须用自己的受权连接回 Biao 读取详情，完成实际验收、答复或处置后才 ack。唤醒器**不**自动 review、answer 或 ack。
- 同一台机器、同一 Biao 地址和同一 consumer 有本机互斥锁；cron/launchd 重叠触发时只有一个实例读取 intake / 启动 Agent。
- `--once` 就是一轮低资源检查；Biao 不会默默安装 cron 或 launchd。需要每几分钟触发时由部署者自行配置，且应采用低频。

它可以和共享 Supervisor 同时存在：Supervisor 负责 Worker slot 的领取、等待恢复和最小 PM 门铃；唤醒器只在有 PM 事项时调用一次外部 PM Agent，二者都不替 PM 作出决定。

## 一个客户端、一个共享 Supervisor

在同一台机器上用一个 Supervisor 同时承担 PM 门铃和多个 Worker slot：

```bash
BIAO_WORKER_SLOTS='[
  {"kind":"codex","agentId":"codex-impl","project":"/path/to/repo","types":["code","docs"]},
  {"kind":"kimi","agentId":"kimi-review","project":"/path/to/repo","types":["review","acceptance"]},
  {"kind":"custom","agentId":"custom-research","project":"/path/to/repo","command":"/absolute/path/to/executor","types":["research"]}
]' .biao/supervisor --consumer pm --interval 60
```

行为边界：

- 同一机器、同一个 Biao 地址只允许一个本机 Supervisor 锁；其他客户端机器不受影响。
- 一轮只共享读取计划、intake 和事件；完全相同的项目、能力和 Plan 范围只发一次空 claim。
- 空闲 slot 没有独立 timer 或 claim poll；每个共享轮次至多发送一次 presence heartbeat，避免服务端误判 stale。running slot 不重复发送 presence，由 Worker 自己维护任务 heartbeat/lease。
- 单 Worker 正常退出、Supervisor 收到停止信号或所有受管计划闭环时，生命周期所有者会调用 `POST /agent/offline`，记录离线原因/时间并保留最后任务、注册和心跳审计。任务已终结时清空当前任务投影；任务仍在执行时保留 `current_task`、停止续租，让失联运行态继续可见并在 lease 到期后由统一回收逻辑处理。异常崩溃来不及显式离线时才由心跳阈值与 watchdog 兜底。
- Question 回答、任务恢复、依赖/ownership 就绪、完成/验收或新 pending 工作，只唤醒一次共享 retry-claim；不会把 Question 正文广播给 slot。
- `--interval` 是低频上限，运行时最小为 10 秒；默认 60 秒。需要定时唤起可使用 `--once`，但 Biao 不会擅自安装 cron 或 launchd。

当所有受管计划都满足“任务已 accepted/resolved 或已取消”时，Supervisor 暂停对应项目；所有项目都闭环后进程干净退出。以后有 reset、reject 生成 repair 或新任务时，下一次 Supervisor 启动会重新发现它们。

## SQLite 灾难恢复不进入自动闭环

共享 Supervisor、Worker、watchdog 和 PM Agent 都不会自动执行 `db restore`。该命令只用于 Biao Redis namespace 已为空、SQLite 备份仍可读取的人工维护窗口；不得为了恢复而清空正常 Redis，也不能用 force 覆盖非空目标。

```bash
# 先停止所有 Supervisor / Worker，再核对 SQLite
.biao/pm db status

# 确认目标 namespace 为空后，必须显式确认
.biao/pm db restore --yes
```

非空目标或仍存在活跃 `running`、lease、ownership 时，服务端会拒绝恢复。`db status` 会同时显示 SQLite 审计总数、可恢复投影，以及“排除但保留审计”的数量和原因。恢复投影仅接纳显式工作区内的项目；缺少项目路径、越过边界的项目，以及未配置 roots 时位于操作系统临时目录的项目不会投影回 Redis，但行记录不从 SQLite 删除。合法临时目录项目必须显式加入 `BIAO_WORKSPACE_ROOTS`。可恢复集合中的历史 `running` 才转换为 fresh `pending`，不会续接旧进程；旧 lease、ownership 和 claim token 全部失效，Worker 必须重新领取。CLI 缺少 `--yes` 时不会发送请求，服务端拒绝时保持非零退出码与稳定错误信息。恢复后先核对状态，再重新启动共享 Supervisor/Worker。

## 验收清单

一次产品级走通至少验证以下事实，而不是只看页面状态或测试总数：

```text
计划提交
  → Worker 按 preferred_project 领取
  → ownership 在写入前检查
  → report 与逐项 verify_results
  → 独立 acceptance
  → PM Review accepted
  → 普通下游才解锁
  → 故意失败一次，repair 可领取
  → repair 接受后源任务 resolved、计划重新计算
  → 所有计划闭环，Supervisor 停止
```

对于 Question 路径，再确认：Worker 发 Question 后当前 lease/ownership 已释放；PM 回答后 Worker 使用 fresh claim 继续；文件/依赖等待没有错误地升级成 PM Question。
