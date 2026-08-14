# 陌生 Agent 接入包

Biao 可以把一个完全不了解平台内部实现的 Agent 接进 Worker 或 PM/Supervisor 链路。
接入方式是“机器可读契约 + 单文件模板 + 离线探针”，类似脚本式握手：Agent 自己实现
如何启动其 harness，Biao 继续负责队列、ownership、租约、验收门铃和失败重试。

接入工具不连接 Biao 服务、不读取 `.biao/config.env`，也不向模板传递控制面凭据。
因此可以把 `biao-adapter-kit` CLI 单独交给陌生 Agent，让它在离线环境完成适配器；
最后由部署者把通过探针的绝对路径写进本机 Supervisor 配置。

## 三步接入

安装后的 runtime 使用 `.biao/agent-kit`；单独安装 CLI 时使用 `biao-adapter-kit`。

```bash
# 1. Agent 先读取稳定、机器可读的角色契约
.biao/agent-kit contract --role worker --json
.biao/agent-kit contract --role pm --json

# 2. 生成一个单文件模板，再只实现其中的 harness 启动部分
.biao/agent-kit scaffold --role worker --output /absolute/path/my-worker.mjs
.biao/agent-kit scaffold --role pm --output /absolute/path/my-pm.mjs

# 3. 不连接平台、不启动真实会话，先验证握手协议
.biao/agent-kit check --role worker --adapter /absolute/path/my-worker.mjs
.biao/agent-kit check --role pm --adapter /absolute/path/my-pm.mjs
```

模板初始只通过离线握手并明确退出，不会伪装成可用执行器。Agent 必须实现实际 harness
调用；`check` 通过只证明输入、探针和协议版本兼容，不代表真实任务或 PM 验收已经跑通。

## Worker 接入 Supervisor

Worker 执行器协议 `biao.worker-executor/v1` 只接收三个参数：`taskId`、`goalFile`、
`workDir`，进程工作目录是任务的 `projectPath`。外层 Biao Worker 负责 register、claim、
ownership、lease、verify 和 report，陌生 Agent 不需要、也不应取得 Biao Token。

缺少 PM 决策时，执行器最终 stdout 只输出一行：

```text
BIAO_QUESTION: {"body":"需要 PM 决定的问题","checkpoint":"已完成内容与恢复点"}
```

探针和真实小任务都验证后，部署者在本机 `.biao/config.env` 的
`BIAO_WORKER_SLOTS` 中登记它：

```bash
BIAO_WORKER_SLOTS='[
  {
    "kind":"custom",
    "agentId":"new-agent-1",
    "project":"/absolute/project",
    "command":"/absolute/path/my-worker.mjs",
    "types":["code","docs"]
  }
]'
```

之后只运行 `.biao/start`。同一个 Supervisor 会启动 slot；Worker 每完成一项任务后，
Supervisor 在同一轮继续调度并检查 PM 门铃，异常退出则由启动器重新拉起。

## PM 接入 Supervisor

PM 适配器协议 `biao.pm-adapter/v1` 从 stdin 接收一行五字段 JSON：`biaoUrl`、
`consumer`、`planIds`、`kinds`、`count`。可选目标会话只通过本机环境变量
`BIAO_PM_TARGET` 传入。适配器应恢复对应会话，并让 PM 使用 `BIAO_RUNTIME_DIR`
下的 `pm-start` / `pm` launcher 自行读取详情。

适配器只有在验收、Question 答复或异常裁决真正完成并确认后才能退出 0；会话恢复失败、
网络失败或门铃未清空必须退出非零，让 Supervisor 保留事件并重试。

探针和真实门铃都验证后，优先把 PM 加入本机 Supervisor pool。`consumer` 必须与它负责的 Plan 在 `index.md` 中声明的 `pm_consumer` 一致：

```bash
.biao/supervisor-config pm add --id pm-new-agent --consumer pm-new-agent \
  --command /absolute/path/my-pm.mjs --target agent-session-id
.biao/supervisor-config pm list
```

如需逐 Plan 覆盖同一 consumer 的目标会话，也可以直接配置本机 Plan 路由：

```bash
BIAO_PM_AGENT_ROUTES='{
  "plan-a":{"command":"/absolute/path/my-pm.mjs","target":"agent-session-id"},
  "*":{"command":"/absolute/path/default-pm.mjs"}
}'
```

命令和会话目标只保存在本机配置中，不写进 Plan、Redis 或门铃正文。没有稳定“按会话 ID
恢复”命令/API 的 GUI Agent，不能可靠自动唤醒；应先为该 harness 增加 CLI/API 恢复入口，
再实现这个单文件适配器。

多个 PM slot 由同一个 Supervisor 管理：共享读取计划/事件/恢复状态，各自读取对应
consumer 的 PM 队列；不同 slot 可并行唤醒，同一 slot 不会并发重复启动。PM 返回非零或
队列未清空时，事项保持待处理并在下一轮重试。新增或修改 slot 后，在没有运行中任务的
安全边界重启 Supervisor 以加载配置。

## 交付给陌生 Agent 的最小要求

只需给它以下内容：

1. `biao-adapter-kit` 命令或安装包；
2. 它要承担的角色：`worker` 或 `pm`；
3. 它自己的 harness/session 恢复方式；
4. 一个不包含 Token 的绝对输出路径。

不要把 `.biao/config.env`、API Token、Redis URL、任务数据库或现有 PM 会话凭据交给它。
陌生 Agent 返回适配器后，部署者先执行 `check`，再用隔离测试 Plan 跑一次真实
claim/report 或门铃/重试闭环，最后才加入生产 Supervisor。
