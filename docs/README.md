# Biao 操作文档

README 说明产品、安装和最短路径；以下文档固定各角色的可执行边界：

- [5 分钟快速上手](quickstart.md)：从 bootstrap 到第一次 PM 验收的最短路径。
- [Worker 接入契约](worker-integration.md)：内置、CLI 与 HTTP Worker 的领取、ownership、Question、验证和上报协议。
- [一站式加入](agent-join.md)：新 Agent 一条命令注册、自动绑定并领取 Worker Token。
- [MCP 接口](mcp.md)：biao-mcp LAN stdio 适配器的工具清单、客户端配置与安全模型。
- [陌生 Agent 接入包](agent-adapter-kit.md)：机器可读契约、单文件 scaffold、离线探针和 Supervisor 注册方式。
- [无人盯盘的闭环](autonomous-closure.md)：交互式 PM、外部 PM Agent 唤醒器、共享 Supervisor、失败/拒绝/验收失败的 repair 链与暂停条件。
- [真实 Harness 端到端验收剧本](e2e-real-harness-runbook.md)：发布前用真实 codex 走完 计划→执行→Verify→PM 验收 闭环的隔离剧本与通过标准。
- [预构建安装与升级](prebuilt-install.md)：受信任 npm tarball 布局、runtime-dir 与升级流程。
- [Supervisor 定时唤起](supervisor-scheduling.md)：不运行常驻 Supervisor 时的 cron / launchd 示例。

所有示例都假定已完成 bootstrap，并优先使用 bootstrap 生成的 `.biao/` 启动器。源码 clone 使用仓库根目录的 `./bootstrap.sh`；受信任 npm tarball 安装后，在消费项目目录运行 `./node_modules/.bin/biao-bootstrap`，生成的启动器和可变数据默认位于消费项目的 `./.biao/`，代码与静态资源仍从安装包绝对路径读取。也可用 `--runtime-dir` 指定 node_modules 外的固定目录。两种布局都不要求系统全局安装 `biao` 命令。

状态阅读必须区分当前待处理与历史审计：`attention` 驱动当下动作，`history` 与兼容的原始计数用于追溯；Agent 正常退出会显式离线，SQLite restore 排除项仍保留审计而不会被悄悄删除。

PM 的新会话入口是 `.biao/pm-start --once`；若由外部 Agent 被动处理最小 PM 门铃，使用显式 opt-in 的 `.biao/pm-agent --once`，并先阅读生成的 `.biao/PM_AGENT.md`。后者不自动安装定时器、不传递 Token，也不自动 review、answer 或 ack。
