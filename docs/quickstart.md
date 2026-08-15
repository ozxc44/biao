# 5 分钟快速上手

目标：从零到"第一个计划被 Worker 执行并经你验收"。完整语义（ownership、Question、
repair 闭环、PM 事件）见 [README](../README.md) 与 [docs](README.md)。

## 0. 前置条件

- Node.js 20.19+ 或 22.12–26.x
- Redis（本机或可达实例）
- 一种执行器：`codex` CLI（已登录）、`kimi` CLI，或任意自定义命令

## 1. Bootstrap（一次）

```bash
cd biao
./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex
```

自动完成依赖检测/安装、构建、随机 Token、`600` 权限的 `.biao/config.env` 和全套启动器。

## 2. 体检与启动

```bash
.biao/doctor   # Node/Redis/执行器检查；失败会给出修复命令
.biao/start    # 托管服务端 + 共享 Supervisor（日志在 .biao/logs/）
```

浏览器打开启动日志中的地址，首次点击"进入控制台"获得本机 Owner 会话。

## 3. 声明一个 Worker slot

```bash
.biao/supervisor-config worker add --id codex-a --kind codex \
  --project /path/to/workspace/my-project --types code
# 安全重启 Supervisor 加载新配置：停止 .biao/start 后重新 .biao/start
```

## 4. 创建并提交计划

```bash
.biao/pm plan init my-first \
  --project /path/to/workspace/my-project \
  --dir /path/to/workspace/plans
# 编辑 tasks/*.md（至少保留一条实现任务），然后：
.biao/pm plan submit /path/to/workspace/plans/my-first
```

任务带 Verify 更能体现闭环（例如 `verify: [{cmd: npm test}]`）。

## 5. 执行与验收

Supervisor 会在一个轮询间隔内让匹配 slot 领取任务并执行。观察进度：

```bash
.biao/pm task list --plan my-first
.biao/pm review list
```

Worker 上报 `done` 后**由你验收**（`done` 不等于完成）：

```bash
.biao/pm review my-first-01-impl           # 读证据
.biao/pm review my-first-01-impl --accept --comment "证据核实通过"
```

## 6. 收尾

- 全部任务 PM `accepted` 后 Supervisor 自动停止（`--stay-resident` 可留守等新计划）；
- 控制台首页只统计 PM 验收后的完成度；
- 下一个计划回到第 4 步即可。

## 常见问题

- **任务一直 pending**：`.biao/doctor` 检查执行器；确认 slot 的 project 路径与计划一致。
- **想问 PM 而不是猜**：Worker 侧的 `BIAO_QUESTION` 机制见 [Worker 接入契约](worker-integration.md)。
- **失败/拒绝后的自动修复**：见 [无人盯盘的闭环](autonomous-closure.md)。
- **陌生 Agent 接入**：见 [陌生 Agent 接入包](agent-adapter-kit.md)。
