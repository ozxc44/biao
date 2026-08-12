# Biao 操作文档

README 说明产品、安装和最短路径；以下文档固定各角色的可执行边界：

- [Worker 接入契约](worker-integration.md)：内置、CLI 与 HTTP Worker 的领取、ownership、Question、验证和上报协议。
- [无人盯盘的闭环](autonomous-closure.md)：交互式 PM、外部 PM Agent 唤醒器、共享 Supervisor、失败/拒绝/验收失败的 repair 链与暂停条件。

所有示例都假定已在仓库根目录完成 bootstrap，并优先使用 bootstrap 生成的 `.biao/` 启动器。它们不要求系统全局安装 `biao` 命令。

PM 的新会话入口是 `.biao/pm-start --once`；若由外部 Agent 被动处理最小 PM 门铃，使用显式 opt-in 的 `.biao/pm-agent --once`，并先阅读生成的 `.biao/PM_AGENT.md`。后者不自动安装定时器、不传递 Token，也不自动 review、answer 或 ack。
