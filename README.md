# Biao

> 管理多个开发 Agent，并用真实证据证明任务已经完成。

Biao 是一个本地优先的多 Agent 研发控制台。它不负责替代 Codex、Kimi 或其他编码 Agent，而是位于它们之上，统一管理计划、任务领取、文件所有权、租约、验证证据和 PM 验收。

```text
Codex / Kimi / 其他 CLI Agent / 自定义 Worker
                       ↓
              Biao 调度与验收层
                       ↓
              真实项目、测试与证据
```

## 为什么使用 Biao

多个 Agent 同时开发时，最大的风险通常不是“没有产出”，而是无法判断：

- 谁正在处理哪个任务；
- 两个 Agent 是否正在修改相同文件；
- Worker 上报完成后，测试是否真的通过；
- 执行者是否在验收自己的工作；
- 服务或 Worker 中断后，任务和证据能否恢复；
- 看板上的“完成”是否等于产品真正可交付。

Biao 将完成链路固化为：

```text
计划提交 → Worker 领取 → Lease/Ownership → 执行 → Verify → 独立验收 → PM Review → 项目完成
```

只有 PM Review 为 `accepted` 的任务才计入项目完成进度。Worker 心跳、退出码为 0、生成了文件或上报 `done`，都不能单独代表验收完成。

## 产品亮点

- **多 Agent 并发治理**：DAG 依赖、优先级、指定执行者、文件 glob 所有权与冲突记录。
- **结果可信**：任务声明的 Verify 必须逐项执行和上报；失败结果不能进入成功状态。
- **执行与验收分离**：验收任务禁止由原任务执行者完成，最终还需要 PM Review。
- **失败可闭环**：Worker 失败、独立验收失败或 PM 拒绝会保留原始审计，并生成受限的 repair 链；repair 的证据仍须经 PM 验收后才算真正修复。
- **异构 Agent 中立**：内置 Codex、Kimi、通用 CLI Worker，也可通过 HTTP API 接入其他 Agent。
- **长任务可靠运行**：心跳、Lease 自动续期、过期回收、阻塞/恢复、重置和撤销。
- **本地优先**：Node.js + Redis + SQLite 即可运行，适合本机、局域网和私有部署。
- **状态可审计**：Redis 负责实时调度，SQLite 保存任务、结果和验收元数据用于恢复。
- **统一控制台**：清楚区分待领取、执行中、待验收、已验收、拒绝、失败、阻塞和撤销。

与通用 Agent 框架相比，Biao 的重点不是 Agent 如何对话，而是多个执行者如何安全地修改真实项目；与单个 Coding Agent 相比，Biao 的重点不是替它写代码，而是调度、约束和验收不同 Agent 的工作。

## 系统要求

- Node.js 20.19+ 或 22.12+
- Redis
- Codex Worker 需要系统中已安装并登录 `codex`
- Kimi Worker 需要系统中已安装并登录 `kimi`

`bootstrap.sh` 会先检测 Node.js、npm、Redis 命令和 Redis 连通性。默认只检测，不修改系统；缺少依赖时会以退出码 `2` 停止。只有显式加 `--yes`，它才会调用 macOS Homebrew 或 Linux 的 apt、dnf、yum 安装缺失依赖；其中 Linux 可能要求管理员权限。本机 Redis 不可用时才会尝试启动本机服务，远程 Redis 只做连通性检查，绝不尝试远程安装或启动。若包管理器不可用、安装后的 Node.js 低于 20.19/22.12，或 Redis 仍无法连接，脚本会停止并说明原因。

## Clone 后开箱即用

Agent 或开发者从 Git 获取仓库后，只需要执行一次 bootstrap：

```bash
git clone https://github.com/ozxc44/biao.git
cd biao

./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex
```

bootstrap 会自动完成：

1. 检测并按授权安装 Node.js 20.19+/22.12+ 与 Redis；
2. 安装项目依赖并构建服务端和网页控制台；
3. 自动生成 API Token；
4. 创建权限为 `600` 的 `.biao/config.env`；
5. 配置工作区白名单、默认项目、Redis、SQLite 和服务地址；
6. 生成服务、安全复制 Token、交互式 PM、显式 opt-in 的 PM Agent 唤醒器、Supervisor、Codex、Kimi 和自定义 Worker 启动器；使用 `--pm-agent codex` 时直接接入内置 Codex PM 适配器；
7. 生成供 Agent 阅读的 `.biao/PM_AGENT.md`。

生成的 `.biao/` 已被 Git 忽略，不会把本机路径或 Token 提交到仓库。

随后启动服务：

```bash
.biao/doctor
.biao/start
```

保持服务终端运行，另开一个终端完成网页鉴权：

```bash
.biao/copy-token
```

浏览器打开启动日志中的地址，把剪贴板内容粘贴到网页右上角 **API Token** 并保存。网页只在当前标签页的 `sessionStorage` 中保存凭据；关闭标签页后需要重新粘贴。`copy-token` 只通过 stdin 调用系统剪贴板，不会把 Token 写进命令参数、URL、版本库或默认终端输出。只想确认本机是否已经配置凭据时运行 `.biao/token-status`，它只显示 SHA-256 指纹末尾，不显示 Token。

控制台首次打开和新标签页默认使用中文；右上角可以切换到 English。语言选择只保留在当前标签页会话中：刷新会延续当前选择，另开标签页仍从中文开始，不写入长期 `localStorage`。Token 配置状态与操作提示会随语言立即切换。

macOS 使用系统 `pbcopy`。Linux 需要 `wl-copy`、`xclip` 或 `xsel` 中任意一个；没有安全剪贴板工具时命令会给出安装指引并以非零状态退出，不会回退为把 Token 打印到终端。

`doctor` 会检查 Node、npm、Redis 连通性、工作区，以及 Codex/Kimi 是否可用。Codex 和 Kimi 是可选项；至少配置一种实际执行器即可。`doctor` 成功只证明本机运行条件可用，不代表项目已验收；启动后可用 `.biao/pm-start --once` 完成一次只读的 health/status/intake 检查，它不会自动确认事件或验收任务。

推荐另开终端启动一个 Supervisor；它统一 PM 门铃和多个 Worker slot。空闲 slot 没有各自的 timer 或 claim 轮询，只在每个共享低频轮次中至多发送一次 presence heartbeat，避免看板把可用 Agent 误判为 stale：

```bash
BIAO_WORKER_SLOTS='[
  {"kind":"codex","agentId":"codex-a","project":"/path/to/workspace/my-project","types":["code","docs"]},
  {"kind":"kimi","agentId":"kimi-a","project":"/path/to/workspace/my-project","types":["review","acceptance"]},
  {"kind":"custom","agentId":"custom-a","project":"/path/to/workspace/my-project","command":"/absolute/path/to/executor","types":["research"]}
]' .biao/supervisor
```

这是生产推荐入口：一个本机 Supervisor 同时管理 PM 门铃和所有 slot。`custom` 是通用 CLI 执行器，需给出 `command`（或设置 `BIAO_EXEC_CMD`）；`cli` 仍是兼容别名。

若只需手动跑一个兼容 Worker，也可使用 `.biao/worker-codex`、`.biao/worker-kimi` 或 `.biao/worker-custom`；bootstrap 生成的这些启动器默认在队列为空后退出，不会留下每 5 秒轮询的空闲进程。

如果当前 Agent 要直接承担 PM 角色，让它先阅读 `.biao/PM_AGENT.md`，然后执行统一入口：

```bash
.biao/pm-start --once
```

该入口会依次检查服务健康、总体状态和最小 PM 门铃，并一次性运行本机共享 Supervisor。它会把以下两类需要行动的状态明确列出：

- `done + review pending` 的历史待验收，即使旧数据没有留下 `review_requested` 门铃；PM 应使用 `.biao/pm review list` 后逐项读取证据并决定接受或拒绝；
- 有待执行任务但没有在线 Worker；先运行 `.biao/doctor`，再启动至少一个 Worker 或配置带 slot 的 Supervisor。

入口只读状态和门铃，**绝不自动 ack、绝不自动验收**。需要持续低频监视时去掉 `--once`，例如 `.biao/pm-start --consumer pm --interval 60`；任务全部验收后 Supervisor 会自行停止。

`.biao/pm-intake` 仅保留给旧自动化或故障诊断；新 PM 会话始终从 `.biao/pm-start --once` 开始。之后 Agent 可使用统一 PM 命令：

```bash
.biao/pm plan list
.biao/pm task list --plan <plan_id>
.biao/pm review <task_id>
.biao/pm review <task_id> --accept --comment "验收依据"
```

### 共享 Supervisor 按需唤醒 PM Agent（可选）

`.biao/pm-start --once` 是**交互式 PM**入口：当前 PM 主动读取状态和门铃，再自行执行验收、答复或 ack。配置 `BIAO_PM_AGENT_CMD` 后，常驻 `.biao/supervisor` 会在同一个共享轮询进程里按需调用一次 PM Agent 适配器，不需要第二个 cron 或 launchd 轮询器。

最直接的 Codex PM 接入在 bootstrap 时完成；没有门铃时不会启动 Codex：

```bash
./bootstrap.sh --yes --workspace /path/to/workspace --pm-agent codex
.biao/supervisor
```

内置 `.biao/codex-pm-agent` 会把最小门铃转换为严格的一次性 PM 契约，启动 ephemeral Codex，让它自行读取平台详情，处理 review、Question、failed、blocked、stale 和 resolution，再由外层 `--require-drained` 验证事项确实清空。Biao Token、Redis URL、任务正文和 Question 正文不会透传给 Codex 子进程。

其他 Agent 也可由部署者明确提供本机启动命令：

```bash
# 仅示例本机命令；不要把 Token 写在命令行、Shell 历史或版本库。
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/supervisor
```

它只通过 stdin 传递服务地址、PM consumer、可选 Plan 范围、事项类型和数量；不传任务正文、结果、Question 内容、ownership 明细或 `BIAO_API_TOKEN`。被唤醒的 Agent 必须自行从 Biao 读取详情，并在实际处置后自行 ack；唤醒器本身**从不**自动 review、answer 或 ack。命令退出后，适配器使用 `--require-drained` 再读一次最小 intake；若待办仍存在，Supervisor 撤销本机去重并在下一个低频共享轮次重试。

`.biao/pm-agent --once` 仍保留给不运行常驻 Supervisor 的兼容部署；此时可由部署者自行低频触发。Biao 不会自动安装 cron 或 launchd。生产推荐只有一个 Supervisor 进程，同时承载 PM 门铃、按需 PM Agent 唤醒和全部 Worker slot。

仓库根目录的 `AGENTS.md` 是 Agent 的固定入口：它会告诉新 Agent 在缺少配置时执行 bootstrap，并在 PM 模式下强制先读取 `.biao/PM_AGENT.md`。因此不需要依赖当前机器已有的全局 Agent 配置。

因此同一个 Agent 克隆仓库后可以选择三种身份：

- **Worker 模式**：推荐通过 `.biao/supervisor` 注册多个 slot；单 Worker 兼容入口仍可运行 `.biao/worker-codex`、`.biao/worker-kimi` 或 `.biao/worker-custom`；
- **交互式 PM 模式**：阅读 `.biao/PM_AGENT.md`，运行 `.biao/pm-start --once`，负责规划、状态核对、验收、拒绝和异常处理；
- **按需 PM Agent 模式**：bootstrap 使用 `--pm-agent codex`，或显式设置 `BIAO_PM_AGENT_CMD` 后运行 `.biao/supervisor`；同一共享进程按需唤醒 Agent，由 Agent 自行读取平台并按同一 PM 契约处置。

常用 bootstrap 选项：

```bash
# 内置 Codex PM：开箱配置，无需手写 agent command
./bootstrap.sh --yes --workspace /path --pm-agent codex

# 一次配置共享 Supervisor 的按需 PM Agent（命令不要包含 Biao Token）
./bootstrap.sh --yes --workspace /path --pm-agent-command 'your-pm-agent-command'

# 使用指定 Redis 和端口；Token 仍默认安全随机生成
./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --redis-url redis://127.0.0.1:6379 \
  --port 7331

# 必须复用已有 Token 时，只传 owner-only 文件路径，不把 Token 放进 argv
chmod 600 /secure/path/biao-token
./bootstrap.sh --yes --workspace /path --token-file /secure/path/biao-token

# 已安装依赖时跳过安装；重新生成配置需要显式 --force
./bootstrap.sh --yes --workspace /path --no-install --force

# 升级已有 clone 的启动器和 PM 手册，不改现有 Token、Redis 或路径配置
./bootstrap.sh --workspace /path --no-install --no-build --upgrade
```

已有 `.biao/config.env` 时 bootstrap 默认拒绝覆盖，防止 Token 和运行配置被意外替换。
默认应让 bootstrap 生成随机 Token。需要由秘密管理器提供已有 Token 时，可使用 `--token-file`，或让秘密管理器注入专用的 `BIAO_BOOTSTRAP_TOKEN` 环境变量；不要使用内联环境变量赋值，也不要把 Token 放进命令参数、Shell 历史或版本库。Token 文件必须是普通、非符号链接、owner-only 文件（例如权限 `600`）。

如果只想检测、不允许安装或启动服务，去掉 `--yes`：

```bash
./bootstrap.sh --workspace /path/to/workspace
```

缺少依赖或本机 Redis 未运行时，它会以退出码 `2` 停止，并提示用 `--yes` 重新执行。远程 `--redis-url` 只做连通性检查，不会尝试启动远程服务。Windows 原生环境需手动准备依赖；WSL 按 Linux 路径处理。

## 快速开始

### 1. 安装和构建

```bash
npm install
npm run build
```

### 2. 启动 Redis

使用已有 Redis，或者在本机启动一个 Redis 实例。生产环境应开启 Redis 持久化。

### 3. 启动 Biao

假设所有允许操作的项目和计划都放在 `/path/to/workspace`：

```bash
BIAO_WORKSPACE_ROOTS="/path/to/workspace" \
BIAO_SQLITE_PATH="/path/to/biao-data/biao.sqlite" \
npm start
```

默认监听 `http://127.0.0.1:7331`。浏览器打开该地址可进入 PM 控制台。

检查服务：

```bash
node bin/biao.js health
node bin/biao.js status
node bin/biao.js db status
```

### 4. 创建计划

```bash
node bin/biao.js plan init my-feature \
  --project /path/to/workspace/my-project \
  --dir /path/to/workspace/plans
```

生成结构：

```text
/path/to/workspace/plans/my-feature/
├── index.md
└── tasks/
    ├── my-feature-01-impl.md
    └── my-feature-02-qa.md
```

编辑计划和任务后提交：

```bash
node bin/biao.js plan submit /path/to/workspace/plans/my-feature
node bin/biao.js plan status my-feature
```

### 5. 启动 Worker

使用 Codex：

```bash
BIAO_URL="http://127.0.0.1:7331" \
BIAO_AGENT_ID="codex-a" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/codex-worker.js
```

使用 Kimi：

```bash
BIAO_URL="http://127.0.0.1:7331" \
BIAO_AGENT_ID="kimi-a" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
BIAO_KIMI_MODEL="kimi-code/k3" \
node bin/kimi-worker.js
```

Worker 默认常驻：队列为空时继续等待，可用 `Ctrl-C` 优雅停止。

### 6. 查看和验收

```bash
node bin/biao.js status
node bin/biao.js review list
node bin/biao.js review my-feature-01-impl
```

验收通过：

```bash
node bin/biao.js review my-feature-01-impl \
  --accept \
  --comment "实现和验证证据均通过"
```

拒绝并生成修复任务：

```bash
node bin/biao.js review my-feature-01-impl \
  --reject \
  --reason "边界条件测试失败" \
  --fix-instructions "补充空输入测试并修复返回值"
```

如果拒绝原因**只在验收报告或证据**，并且所有 `acceptance_for` 来源已经 PM accepted/resolved、无需修改来源实现，必须显式选择只重验：

```bash
node bin/biao.js review my-feature-acceptance \
  --reject \
  --reason "验收报告缺少完整命令输出，来源实现无需修改" \
  --fix-instructions "重新执行原 Verify 并提交完整 result/verify_results" \
  --reverify-only
```

平台保留原 reject 审计，直接创建 fresh `<acceptance>-reverify-N`；它分别原样继承原 acceptance 的 `depends_on` 与 `acceptance_for`（两者不能相互替代），并继承 ownership 和 Verify、排除原验收者，仍须新的 Worker report 和 PM accept 才闭环。所有原 `depends_on` 和 `acceptance_for` 来源均须已 accepted/resolved，否则 fail closed。重复相同请求只回放同一复验任务；之后改成默认 source repair 会被拒绝。`--reverify-only` 只能用于 acceptance reject，不能和 `--repair-ownership` 同时使用。未显式指定时继续按默认行为修复来源。

如果验收证据表明修复必须涉及原任务 ownership 之外、但相邻且可明确列举的文件或模块，PM 可以**只为新 repair**授予最小扩展范围。原任务的 ownership、结果和拒绝审计不会被改写；平台会把新增范围写入 repair 的审计与目标中。参数使用单个 JSON，便于脚本安全传递：

```bash
node bin/biao.js review my-feature-01-impl \
  --reject \
  --reason "MCP 绑定校验还需要修复相邻路由" \
  --fix-instructions "修复绑定校验并执行 API 回归" \
  --repair-ownership '{"files":["apps/api/src/mcp/mailbox-v2.ts"],"modules":["mailbox-v2"]}'
```

`--repair-ownership` 只能与 `--reject` 使用，必须至少含一个非空 `files` 或 `modules` 项；每类及合计都有 64 项、每项 512 字符的上限，不能含控制字符或逗号。重复项会被归一化，最终 repair 的范围是“来源 ownership ∪ PM 明示新增项”，不是替换来源范围。

也可以直接在浏览器控制台中查看结果、Verify 证据、验收、拒绝或重置任务。

## 如何编写计划

### `index.md`

```yaml
---
plan_id: my-feature
title: 用户登录优化
status: draft
project_path: /path/to/workspace/my-project
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: 实现
  - id: qa
    name: 验收
    depends_on: [impl]
global_constraints:
  - 不修改 .env 和凭据文件
---

# 用户登录优化

完成登录接口、前端交互和独立验收。
```

### 普通任务

```yaml
---
task_id: my-feature-01-api
title: 实现登录接口
type: code
phase: impl
assignee: auto
ownership:
  files:
    - src/server/auth/**
priority: 8
timeout_seconds: 1800
max_retries: 2
verify:
  - cmd: npm test -- auth
    expect_exit: 0
    scope: .
    timeout: 300
---

# 实现登录接口

## Objective

实现登录接口并保持现有调用兼容。

## Required Work

1. 完成接口实现。
2. 补充成功和失败路径测试。

## Acceptance Criteria

- [ ] Verify 命令通过。
- [ ] 未修改 ownership 范围外的文件。
```

### 独立验收任务

```yaml
---
task_id: my-feature-02-qa
title: 独立验收登录链路
type: acceptance
phase: qa
depends_on:
  - my-feature-01-api
assignee: auto
priority: 9
acceptance_for:
  - my-feature-01-api
verify:
  - cmd: npm test -- auth
    expect_exit: 0
---

# 独立验收登录链路

逐项检查接口、失败路径和回归测试，并在结果中写出明确的通过或不通过结论。
```

`acceptance` 任务必须由未执行被验收任务的 Agent 领取，并提供至少一项通过的 Verify 结果和明确的验收结论。

通过 CLI 创建时使用可重复的 `--verify-cmd` 直接生成结构化 Verify；验收任务未提供验证命令会在写文件前 fail-closed：

```bash
.biao/pm task add --plan my-feature --task-id my-feature-02-qa \
  --title "独立验收登录链路" --type acceptance --phase qa \
  --depends-on my-feature-01-api --acceptance-for my-feature-01-api \
  --verify-cmd "npm test -- auth" --verify-cmd "npm run typecheck"
```

只替换已有任务的 Verify 可执行 `.biao/pm task edit <task_id> --verify-cmd "<command>"`。每项默认 `expect_exit: 0`；需要不同的 `expect_exit` / `scope` / `timeout` 时，用 `task edit --from-file` 提供完整 task MD。完整说明见 [规划 CLI](docs/planning-cli.md)。

## Agent 如何接入

Biao 提供四种接入方式。

以下示例均使用仓库内的 `node bin/...` 或 bootstrap 生成的 `.biao/...` 入口；clone 后不需要也不假定系统已经全局安装了 `biao` 命令。完整的领取、ownership、Question 和上报契约见 [Worker 接入契约](docs/worker-integration.md)。

### 方式一：使用内置 Codex Worker

```bash
BIAO_URL="http://127.0.0.1:7331" \
BIAO_API_TOKEN="your-token" \
BIAO_AGENT_ID="codex-backend-1" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/codex-worker.js
```

Codex Worker 会自动完成：注册、心跳、领取、所有权检查、Lease 续期、执行 `codex exec`、运行 Verify、生成 `.progress.json` 与 `result.md/result.json`，再上报结果。

### 方式二：使用内置 Kimi Worker

```bash
BIAO_URL="http://127.0.0.1:7331" \
BIAO_API_TOKEN="your-token" \
BIAO_AGENT_ID="kimi-frontend-1" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
BIAO_KIMI_BIN="kimi" \
BIAO_KIMI_MODEL="kimi-code/k3" \
node bin/kimi-worker.js
```

### 方式三：接入任意命令行 Agent

通用 Worker 会调用 `BIAO_EXEC_CMD`，并在命令后追加三个参数：

```text
<task_id> <goal_md_path> <work_dir>
```

示例执行器：

```bash
#!/usr/bin/env bash
set -euo pipefail

task_id="$1"
goal_md="$2"
work_dir="$3"

# 将这里替换为你的 Agent 命令。
my-agent --project "$PWD" --prompt-file "$goal_md"
```

启动：

```bash
chmod +x /path/to/my-biao-agent

BIAO_URL="http://127.0.0.1:7331" \
BIAO_API_TOKEN="your-token" \
BIAO_AGENT_ID="custom-agent-1" \
BIAO_EXEC_CMD="/path/to/my-biao-agent" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/biao-worker.js
```

通用 Worker 负责调度协议和 Verify；自定义执行器只需要在项目目录中完成任务，并用退出码表示 Agent 命令本身是否成功。

注意：当前 `BIAO_EXEC_CMD` 使用简单空格切分，执行文件路径及固定参数中不要包含空格。

### 方式四：通过 HTTP API 实现自定义 Worker

适合远程 Worker、其他语言运行时或已有 Agent 平台。

所有响应使用统一格式：

```json
{
  "ok": true,
  "data": {}
}
```

失败响应会额外包含 `error.code` 和 `error.message`。

启用认证后，每个请求都需要：

```http
Authorization: Bearer <BIAO_API_TOKEN>
Content-Type: application/json
```

标准 Worker 生命周期如下。

#### 1. 注册

```bash
curl -X POST http://127.0.0.1:7331/register \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "remote-agent-1",
    "agent_type": "custom",
    "capabilities": ["code", "review", "acceptance"]
  }'
```

#### 2. 发送心跳

空闲时 `current_task` 传空字符串，执行时传任务 ID：

```bash
curl -X POST http://127.0.0.1:7331/heartbeat \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"remote-agent-1","current_task":""}'
```

#### 3. 领取任务

```bash
curl -X POST http://127.0.0.1:7331/claim \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "remote-agent-1",
    "blocking": false,
    "preferred_types": ["code"],
    "preferred_project": "/path/to/workspace/my-project"
  }'
```

领取成功后应保存以下字段：

- `task_id`：任务标识；
- `goal_md`：完整任务说明；
- `project_path`：项目工作目录；
- `ownership_files`：允许修改的文件范围；
- `verify`：必须执行并逐项上报的验证命令；
- `claim_token`：本次租约凭证，不能复用或泄露；
- `timeout_seconds`：Lease 与任务超时时间。

`claim` 会在 Lease 期内自动取得任务声明的 `ownership_files`。自定义 Worker 在写文件前仍应针对每个实际写入路径调用 `GET /ownership?path=...&agent_id=...`：只有 `action=proceed` 才可写入；`wait` 时应搁置并释放当前 claim，不能直接写或向人类会话追问。若因优先级需要显式抢占，才调用 `/ownership/declare` 并传 `force: true`；不要把它当作普通领取后的必做步骤。

#### 4. 长任务续租

建议每 `timeout_seconds / 3` 秒续租一次：

```bash
curl -X POST http://127.0.0.1:7331/lease/renew \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task_id": "my-feature-01-api",
    "claim_token": "<claim_token>"
  }'
```

#### 5. 执行与验证

- 在 `project_path` 中执行任务；
- 只能修改 `ownership_files` 声明的范围；
- 不应直接修改 `plans/` 下的计划文件；
- 逐项运行 `verify`，保留命令、退出码、是否通过和必要输出；
- 将结果写入项目内的受控路径，例如 `work/<task_id>/result.md` 和 `result.json`。

#### 6. 上报

```bash
curl -X POST http://127.0.0.1:7331/report \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task_id": "my-feature-01-api",
    "agent_id": "remote-agent-1",
    "claim_token": "<claim_token>",
    "status": "done",
    "result_path": "/path/to/workspace/my-project/work/my-feature-01-api/result.md",
    "result_json_path": "/path/to/workspace/my-project/work/my-feature-01-api/result.json",
    "verify_results": [
      {
        "cmd": "npm test -- auth",
        "exit_code": 0,
        "passed": true,
        "output": "tests passed"
      }
    ]
  }'
```

声明了 Verify 的任务必须完整、按顺序上报对应结果。任一验证失败时，应上报 `failed`；即使错误上报为 `done`，服务端也会拒绝。

`result.md` / `result.json` 是推荐的可审计产物；内置 Worker 会写入 `work/<task_id>/`。自定义 Worker 一旦上报这两个路径，它们必须指向当前任务目录内对应的普通文件：`work/<task_id>/result.md` 与 `work/<task_id>/result.json`，不能跨任务、使用软链接或在上报后替换。`report` 的关键事实同时包括当前 `claim_token`、任务状态、逐项 `verify_results` 与可复核产物；文件存在本身不能替代成功证明。

内置 Worker 的 `.progress.json` 只由外层调度器维护，执行 Agent 不得创建或覆盖。调度器以同目录临时文件原子替换并将权限固定为 `0600`，记录 `claimed → running → verifying → reporting → finished/failed` 阶段；只有 `result.*` 已写入且 report 已得到明确结果后才写终态。该文件不保存 claim token、API 凭据、Agent 原始输出或异常正文。它用于观察当前 Worker 尝试，不代表 PM 已验收，也不能替代 report。自定义 Worker 可采用同样的进度文件，但仍须以平台 report 和独立 PM Review 为准。

## Worker 运行参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIAO_URL` | `http://localhost:7331` | Biao 服务地址 |
| `BIAO_API_TOKEN` | 空 | API Bearer Token |
| `BIAO_AGENT_ID` | Worker 类型默认值 | Worker 唯一标识，不同进程不要复用 |
| `BIAO_PREFERRED_PROJECT` | 空 | 只领取指定项目的任务 |
| `BIAO_MAX_TASKS` | `0` | 最大处理任务数；`0` 表示常驻 |
| `BIAO_EXIT_ON_IDLE` | 原始 Worker 默认关闭；bootstrap 启动器默认 `1` | `1` 表示队列为空后退出 |
| `BIAO_IDLE_POLL_MS` | `5000` | 仅遗留常驻单 Worker 的空闲轮询间隔；生产共享 Supervisor 不使用它 |
| `BIAO_HEARTBEAT_MS` | `30000` | 运行中 Worker 的任务心跳间隔；共享 Supervisor 的空闲 presence 使用共享轮次，不使用独立 timer |
| `BIAO_EXEC_CMD` | 无 | 通用 CLI Worker 的执行命令 |
| `BIAO_MODEL` | `human` | 通用 Worker 写入结果的模型名称 |
| `BIAO_KIMI_BIN` | `kimi` | Kimi 可执行文件 |
| `BIAO_KIMI_MODEL` | `kimi-code/k3` | Kimi 模型 |

生产环境不要为每个 Agent 启动一个 `BIAO_MAX_TASKS=0` 的独立循环；那是兼容模式。使用 `.biao/supervisor` 后，空闲 slot 不会各自启动 timer 或 claim poll，只复用共享低频轮次发送至多一次 presence heartbeat；正在执行的任务则由 Worker 保留必要的 Lease/Heartbeat。

## Worker 与 PM 的平台通讯

Worker 缺少产品决策、范围确认或继续条件时，不能向当前人类会话提问，也不应把任务悄悄搁住。它必须通过 Biao 的持久化 Question 机制找所属 Plan 的 PM：平台只产生最小门铃，正文由 PM 按权限二次读取。

内置 Codex、Kimi 与通用 CLI Worker 都支持在执行输出中写一行受控标记：

```text
BIAO_QUESTION: {"body":"需要确认发布范围","checkpoint":"测试已通过，等待决定"}
```

运行层会验证该 JSON，随后原子创建 Question、释放旧 lease/ownership，并把任务安全置为等待状态；它不会把问题退回给人类。PM 回答后任务回到 `pending`，下一次 fresh claim 会携带回答和 checkpoint，任何 Worker 都必须使用新 claim token 才能继续。

也可以由自定义 Agent 直接调用 CLI：

```bash
# Worker：必须带当前 task 与 claim token
.biao/pm question ask --task <task_id> --claim-token <claim_token> \
  --agent-id <current_worker_agent_id> \
  --body "需要确认发布范围" --checkpoint "测试已通过"

# PM：先只看自己的最小列表，再按需读正文并答复
.biao/pm question list --consumer <pm> --status open --plan <plan_id>
.biao/pm question get <question_id> --consumer <pm> --plan <plan_id>
.biao/pm question answer <question_id> --consumer <pm> --plan <plan_id> --answer "只发布 A 模块"
# get/answer 会返回 asked_event_id；只有答复实际完成后，才复制精确命令确认门铃
.biao/pm pm ack --consumer <pm> --plan <plan_id> --event-id <asked_event_id>
```

手动 `question ask` 必须显式给出当前 claim 的 Worker `--agent-id`；不要继承 `.biao/pm` wrapper 的默认 `pm-agent` 身份。Question 的事件路由是单向的：`question_asked` 只提醒对应 PM；`question_answered` 只唤醒共享 Worker 调度器重新 claim，答案正文不会作为事件推送给其它 slot。`GET /questions` 也只返回 Question ID、任务、计划、状态和时间等门铃元数据；正文、checkpoint、答复和精确 `asked_event_id` 必须由对应 PM 用带 consumer/plan 的单项 get 二次读取。

文件占用和依赖未满足不是 PM Question：共享 Supervisor 会将任务安全置为 `waiting_file_release` 或 `waiting_dependency`，释放旧 lease/ownership，并在文件释放或依赖真正就绪时用新 claim 继续。它们不会反复进入 PM intake；只有产品决策、范围确认等不能由 Worker 自行决定的事项才走 Question。

## 失败、拒绝与验收失败如何自动闭环

Biao 不把 `failed`、`rejected` 或失败的独立验收留在一个需要人盯住的终端桶中。它保留源任务的失败/拒绝审计，再创建一条受限的 repair 路径；详细状态与 PM 操作边界见 [无人盯盘的闭环](docs/autonomous-closure.md)。

```text
Worker failed / Verify failed
          │
          ├── 同项目、同 ownership（可由 PM 最小扩展）、同 verify 的 repair task
          │        │
PM reject ┘        ├── Worker report done → PM Review accepted
                   │
独立 acceptance failed ──► 修复原实现任务，不依赖失败的 acceptance
                   │
                   └── repair accepted → 源任务 resolution=resolved → 放开下游/重新判定计划
```

- 普通 Worker 失败（包括 Verify 失败）会生成 repair；原失败记录不被擦掉。
- PM 拒绝 `done` 的任务时会记录拒绝原因与修复指令，再生成 repair；原任务保持 `rejected` 审计。
- 独立 `acceptance` 失败时，repair 指向被验收的原实现，而不是指向失败的 acceptance，因此不会形成“修复任务依赖失败验收”的死锁。
- PM 若确认来源实现无问题、仅验收证据/报告需要重做，可在拒绝 acceptance 时使用 `--reverify-only`，直接生成独立 fresh reverify；此显式模式会进入不可变拒绝审计，重试或重启不会退化为来源 repair。
- repair 默认继承源任务的项目、ownership 和 Verify。若 PM 在 reject 时以 `--repair-ownership` 明确列出相邻 files/modules，平台只对**新 repair**做去重并集扩权，并将该增量记录进 repair goal/审计；绝不反写来源任务。repair 仍受源任务 `max_retries` 限制。达到上限时才进入 `needs_pm_decision`，PM 读取详情后决定如何继续；不会无限盲目重跑。
- retry 耗尽后，PM 先运行 `.biao/pm task resolution <task_id>` 只读根因、最新 repair、lineage 与尝试次数。证据支持额外尝试一代时运行 `.biao/pm task resolution <task_id> --action continue`；明确终止当前修复链时运行 `.biao/pm task resolution <task_id> --action cancel`。不要用 `task reset --force` 打断修复链；只有 continue/cancel 成功后才 ack 对应 `resolution_required` 门铃。
- repair `done` 后经 PM `accepted`，源任务的 `resolution_status` 变为 `resolved`。源任务原有 `failed`/`rejected` 记录保留，但它的修复闭环可计入计划完成。若计划另有 repair 的独立 acceptance，仍必须由不同 Agent 执行。
- 普通下游任务要等前置任务 PM `accepted` 或 repair `resolved`；`acceptance` 为避免自我死锁，可在被验收任务 `done` 后领取，但仍须独立执行和 PM Review。

## PM 常用操作

```bash
# 版本、总体状态、事件和冲突
node bin/biao.js version
node bin/biao.js status
node bin/biao.js events --since 1h
node bin/biao.js conflicts

# 计划和任务
node bin/biao.js plan list
node bin/biao.js plan status my-feature
node bin/biao.js task list --plan my-feature
node bin/biao.js task get my-feature-01-api

# 异常处理
node bin/biao.js task block my-feature-01-api --claim-token <claim_token> --reason waiting_dependency
node bin/biao.js task resume my-feature-01-api
node bin/biao.js task reset my-feature-01-api --force
node bin/biao.js task cancel my-feature-03-obsolete
# 仅用于升级遗留的 done + pending review 伪完成；保留原结果与审计
node bin/biao.js task supersede my-feature-legacy --reason "旧版本误报完成" --yes --by pm-migration
# Plan 批量操作必须先预览，再复制同一状态快照的 token 显式确认
node bin/biao.js plan supersede my-feature --preview
node bin/biao.js plan supersede my-feature --reason "退出遗留伪完成" --preview-token <token> --yes --by pm-migration
node bin/biao.js watchdog
node bin/biao.js watchdog --auto-fix

# 持久化检查和人工恢复
node bin/biao.js db status
node bin/biao.js db restore --yes
```

### SQLite 灾难恢复（只在空 namespace 中执行）

`db restore` 不是普通重启步骤，也不是把 SQLite 强制覆盖到正在运行的 Redis。它只用于 Biao 的 Redis namespace 已因灾难丢失或被重建、而 SQLite 备份仍可读取的维护窗口。**不要为了运行 restore 对正常 Redis 执行 `FLUSHALL`，也不存在跳过安全检查的 force 模式。**

当前产品部署边界是：**同一组 Redis + SQLite 只能运行一个 Biao 服务实例**，Worker/PM 必须通过该 HTTP/CLI 入口读写，不得直写 Redis。服务内会等待已入场 writer 完成，即使 Redis 重启或 FLUSH 丢失了远程 permit 也不会与 restore 重叠。多服务实例需要额外的 durable fencing，当前未支持，不能依赖 Redis permit 自行横向扩容。

执行顺序：

1. 停止所有 Biao Supervisor 和 Worker，避免恢复时产生新的 claim、lease 或写入；
2. 运行 `node bin/biao.js db status`，核对 SQLite 中的 plan/task 数量和状态分布；
3. 确认目标 Biao Redis namespace 为空；非空目标以及活跃的 `running`、lease、ownership 都会被服务端拒绝；
4. 显式运行 `node bin/biao.js db restore --yes`；没有 `--yes` 时 CLI 在发请求前以非零状态退出；
5. 重新检查 plan/task 状态，再启动共享 Supervisor/Worker。

恢复不会复活旧执行现场。SQLite 中历史 `running` 会转换成 fresh `pending` 等待重新领取，旧 lease、ownership 和 claim token 均失效。CLI 会保留服务端稳定错误码和消息并以非零状态退出，运维脚本不得把拒绝误判为恢复成功。完整边界可用 `node bin/biao.js db restore --help` 查看。

`watchdog --auto-fix` 只处理安全的过期运行任务和失联 Agent；它不自动验收，也不重置 repair 中的源任务。自动 repair 已在运行的失败任务由 repair 链接管，不应再作为“请 PM 手工重做”的重复提醒；超过 `max_retries` 的 `needs_pm_decision` 才需要 PM 决策。

PM Agent 处理 blocked、stale 或升级前 legacy failed 时采用同一套最小恢复顺序：

```bash
# 先读当前真相
.biao/pm task get <task_id>

# 仅未知 blocked 且证据确认外部条件已经消失时使用
.biao/pm task resume <task_id>

# 安全回收失效 lease/stale agent，并为没有 resolution 的 legacy failed 补建 repair
.biao/pm watchdog --auto-fix
```

- `waiting_dependency / waiting_file_release` 是平台与共享 Supervisor 的内部等待，正常不会打扰 PM；不要手工 resume、reset 或 ack 催跑。
- `waiting_pm_reply` 必须通过 Question answer 恢复。未知 blocked 若条件仍存在就保留门铃，不能为清空 intake 强行 resume。
- failed 必须先看 resolution/repair：`repairing` 等 Worker，`required` Review 当前 repair，`needs_pm_decision` 使用 `task resolution`；没有 resolution 的 legacy failed 运行一次 watchdog auto-fix 后重读。禁止 reset 原任务绕过修复链。
- 只有恢复动作成功且 intake 当前事实消失后才 ack；真正无法自治时保留门铃，由共享 Supervisor 低频重试。

`supersede` 不是普通取消或重置。它只接受尚无 PM Review、尚未进入 resolution 的 `done` 遗留任务，把状态写为不可逆的 `superseded`，同时撤下活跃验收门铃，但不删除或改写原来的 `done_at`、result、Verify、PM 字段和事件流。单任务仍有非终态依赖者时会拒绝；Plan 批量操作会列出候选与阻塞项，并把依赖快照绑定到 SHA-256 `preview_token`。状态变化、未知参数、缺少原因或缺少 `--yes` 都会 fail closed，不会静默级联或部分执行。

CLI 面向 Agent 和自动化脚本提供可靠退出码：服务返回 `ok:false`、查询失败或自动提交失败时退出码非零；`--json` 保留完整 API 响应。运行 `node bin/biao.js --help` 查看与当前版本同步的完整命令清单。

## 被动式 PM 轮询、提醒与验收就绪通知

Biao 是一个被动的状态与事件中枢：状态变化时只记录一次持久、可补交、可确认的 PM 事件，由 PM/CLI 主动轮询并提醒。平台**不会**主动唤醒 PM、不常驻 Reviewer、不自动验收，也不要求人盯看板。

### PM 事件语义

- 任务成功 `report done` 后，若需要 PM 签核，产生一次 `review_requested` 事件。该事件只承担路由和门铃作用，保存 `consumer`、`task_id`、`plan_id`、游标、`timestamp` 等最小字段；详情由 PM 随后通过 `task`/`plan`/`review` 接口读取。
- 因依赖刚全部满足而可领取的 `type=acceptance` 任务，产生一次 `acceptance_ready`（同一状态转换不重复写）。
- Worker 创建 Question 时，产生只路由给该 Plan PM 的 `question_asked`；PM 回答后产生只供共享调度器重试领取的 `question_answered`。两者都不携带问题正文或答案正文。
- repair 创建时只写 `repair_scheduled` 审计并进入 Worker 队列，不打扰 PM；repair 交付后照常产生 `review_requested`。只有重试耗尽并进入 `resolution_status=needs_pm_decision` 时，才产生最小的 `resolution_required` 让 PM 作出下一步决策。
- 保留既有 `task_completed` 兼容事件，旧 CLI/SSE 消费者不中断。

每个 plan 可在 `index.md` 声明 `pm_consumer`（默认 `pm`），事件按此 consumer 路由，只提醒对应 PM：

```yaml
---
plan_id: my-feature
project_path: /path/to/repo
pm_consumer: pm-team-a     # 该 plan 的事件只路由给 pm-team-a
---
```

### 轻量 consumer ack

PM 事件支持按 consumer 查询未确认事件并对指定事件 ack：

- ack 幂等、持久，**不修改 Redis Stream 历史**；一个 consumer 的 ack 不影响另一个 consumer。
- 新 consumer 首次读取即可补到历史未 ack 事件（断线重连/重启不丢）。
- consumer 名称安全可校验（仅字母/数字/点/下划线/连字符）。

### PM 主动轮询（CLI）

PM 用 `intake → 处理 → ack` 主动轮询，平台保持被动。`ack` 只表示已经看见或处置了某个门铃，绝不等于接受任务、回答 Question 或关闭 repair：

```bash
# 推荐单一入口：health/status/intake + 一次共享 Supervisor；仅提醒，不 ack、不验收
.biao/pm-start --consumer pm --once

# 仅供旧自动化或故障诊断：读取一次原始门铃；新 PM 会话请使用 pm start
.biao/pm pm intake --consumer pm --json
# 有事项退出码 0，无事项退出码 2（脚本可判断），错误退出码 1

# 按 consumer 查未确认事件
.biao/pm pm unacked --consumer pm --json

# 处理完成后幂等确认
.biao/pm pm ack --consumer pm --event-id <id>

# 低频 watch 模式（Ctrl-C 退出，默认 60s 一次）
.biao/pm pm watch --consumer pm --interval 60
```

兼容的 `pm intake` 默认只输出事件类型、Plan ID、Task ID、游标和待处理数量，不展开结果、日志、verify 或 ownership 详情。`waiting_file_release` / `waiting_dependency` 不会作为 PM 待办反复输出；PM 用 `.biao/pm task get`、`.biao/pm review`、`.biao/pm task list` 等现有接口自行获取详情。

### 客户端 Supervisor（可选，不由平台启动）

当一台机器上同时跑 PM 和多个 Worker 时，可用 Supervisor 把"PM 等待"与"Worker 等待"归一到一个低频轮询进程：

- 同一台机器、同一个 Biao 服务地址默认只允许一个实例（本机锁文件，**不用 Redis 全局锁**，不会误伤其他客户端机器）。

- 每个轮次只共享读取一次 `/plans`、`/intake`、`/events`，并调用一次幂等 `POST /reconcile`；后者只回收过期 lease、恢复已满足条件的 `waiting_dependency` / `waiting_file_release`，绝不领取任务、回答 Question 或替 PM 决策。事件优先使用 `after` / `next_cursor`，旧服务自动兼容回退到毫秒 `since` + event-id 去重。
- PM 的本机门铃只显示 Plan、事项类型和数量，**不展开任务、问题或事件 ID**；Supervisor **绝不自动 ack**。配置 `BIAO_PM_AGENT_CMD` 后，同一个进程会按需启动一次 PM Agent，并在命令退出后复查待办；未处理就撤销本机去重、下轮重试。PM Agent 仍须自己读取详情、验收或回答后，再显式 ack 对应事件。
- 每个空闲 slot 不单独启动 timer 或 `/claim` 轮询；它只在每个共享轮次中至多发送一次 presence heartbeat，避免服务端把可用 Agent 误判为 stale。running slot 不重复发送这种 presence，由 Worker 自己维护带当前任务的 heartbeat/lease。
- 同一轮中，完全相同的项目 + task type + plan 过滤条件会合并空 claim；不同能力的 Agent 仍各有一次领取机会，避免互相饿死。
- Worker 正常流程是“完成 / Question / 失败 → 共享调度器立即请求下一项”。依赖未满足时服务端本就不返回任务；遇到需要释放的文件占用，shared slot 会带当前 claim token 安全 `block` 并释放旧 lease/ownership，而不是在 slot 内每 30 秒轮询。`waiting_pm_reply` 只能由持久化 Question 创建并只能由对应 PM 的 answer 解锁，通用 `task resume` 不能绕过它。
- `question_answered`、`task_resumed`、任务重置/完成/验收、依赖或 ownership 就绪事件，以及 `/plans` 中新增的 pending 工作，只唤醒**一次**共享 retry-claim；事件正文不会转发给 Worker。
- 所有有效任务都已 PM `accepted`、或原失败/拒绝已由 repair `resolved`（或全部取消）后，Supervisor 暂停该项目；全部受管项目闭环时干净退出。下次启动会重新发现 reset、reject 生成的修复任务或新任务。

推荐用 bootstrap 生成的入口运行，并把同机可用的 Agent 都注册为 slot：

```bash
BIAO_WORKER_SLOTS='[
  {"kind":"codex","agentId":"codex-impl","project":"/path/to/repo","types":["code","docs"]},
  {"kind":"kimi","agentId":"kimi-review","project":"/path/to/repo","types":["review","acceptance"]},
  {"kind":"custom","agentId":"custom-research","project":"/path/to/repo","command":"/absolute/path/to/executor","types":["research"]}
]' .biao/supervisor --consumer pm-team-a --interval 60
```

slot 字段如下：

| 字段 | 含义 |
| --- | --- |
| `kind` | `codex`、`kimi`、`custom`（`cli` 为兼容别名） |
| `agentId` | 该 slot 的稳定唯一 Agent 标识；同机不要重复 |
| `project` | 可选的绝对项目路径；不填时使用 bootstrap 的默认项目 |
| `types` | 可选领取范围，如 `code`、`review`、`research`、`docs`、`acceptance` |
| `capabilities` | 注册到平台的能力；未填时使用内置执行器支持的默认集合 |
| `command` | 仅 `custom`/`cli`：执行器路径及简单参数；也可通过 `BIAO_EXEC_CMD` 提供 |
| `kimiBin` / `kimiModel` | 仅 `kimi`：覆盖可执行文件或模型 |

```bash
# 一次性运行（交由 cron / launchd / Codex 心跳低频唤起）
.biao/supervisor --biao-url http://127.0.0.1:7331 --consumer pm --once

# 常驻低频轮询
.biao/supervisor --biao-url http://127.0.0.1:7331 --consumer pm --interval 60

# 同一个 Supervisor 同时承载 PM Agent 门铃，无需第二个轮询进程
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/supervisor --consumer pm --interval 60

# 只管理指定 plans（多个用逗号分隔）
.biao/supervisor --plans plan-a,plan-b
```

Biao **不会自动安装任何系统计划任务**。需要常驻或定时唤起时，可自行配置：

```bash
# cron 示例：每 5 分钟一次性共享检查
*/5 * * * * cd /path/to/biao && ./.biao/supervisor --consumer pm --once >> /tmp/biao-sup.log 2>&1
```

```xml
<!-- launchd 示例：~/Library/LaunchAgents/com.biao.supervisor.plist，每 5 分钟一次 -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.biao.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/biao/scripts/supervisor.mjs</string>
    <string>--consumer</string><string>pm</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
```

### 平台保持被动的边界

- SSE 接口保持兼容（仍每 ~2 秒轮询 Redis 推送事件）。
- 本任务**不要求**平台通过 webhook、系统通知或私有 Desktop API 主动调用 PM。
- 平台只提供可被 PM 客户端主动轮询的状态、事件和 Question 协议：`/intake`、`/intake/unacked`、`/intake/ack`、`/events`、`/questions`、`/question/:id`、`/status`、`/watchdog`。

## 服务配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BIAO_HOST` | `127.0.0.1` | 服务监听地址 |
| `BIAO_PORT` | `7331` | 服务端口 |
| `BIAO_REDIS_URL` | `redis://localhost:6379` | Redis 地址 |
| `BIAO_SQLITE_PATH` | 包内 `data/biao.sqlite` | SQLite 审计与恢复库 |
| `BIAO_WORKSPACE_ROOTS` | 空 | 允许访问的工作区根目录；多个路径使用系统路径分隔符 |
| `BIAO_API_TOKEN` | 空 | API Bearer Token；非本机监听必须配置 |

CLI、Worker 和网页控制台在启用认证时使用同一个 Token。一旦配置 `BIAO_API_TOKEN`，除 `/health`、`/version` 和前端静态资源外，所有 API 读写请求都必须携带 `Authorization: Bearer <token>`；未配置 Token 时保持 loopback 本机兼容。网页入口仍可直接打开，右上角 **API Token** 控件会将 Token 只保存在当前标签页的 `sessionStorage`，不会写入 URL；保存后看板会重新执行带认证的读取。

## 安全与部署

用于局域网或长期运行时，至少应做到：

1. 同时配置 `BIAO_API_TOKEN` 和精确的 `BIAO_WORKSPACE_ROOTS`；
2. 不要将 `/`、整个用户目录或包含敏感数据的大目录设为工作区；
3. 为 Redis 开启 AOF 或其他持久化，并限制网络访问；
4. 将 `BIAO_SQLITE_PATH` 指向独立持久化目录并定期备份；
5. 使用进程守护工具管理 Biao 和常驻 Worker；
6. 只允许可信 PM 提交计划，因为计划中的 Verify 命令会在 Worker 所在机器执行；
7. 不要把 Token、`.env`、凭据、SQLite 数据库或 Worker 的本地 claim 文件提交到代码库；
8. 为不同 Worker 使用不同的 `BIAO_AGENT_ID`，并按项目设置 `BIAO_PREFERRED_PROJECT`。

非 loopback 地址监听时，如果没有同时配置 Token 和工作区白名单，Biao 会拒绝启动。

## 状态语义

| 状态 | 含义 |
| --- | --- |
| `pending` | 等待符合条件的 Worker 领取 |
| `running` | 已领取且 Lease 有效 |
| `blocked` | 等待 PM、文件释放或依赖，Worker 可以先处理其他任务 |
| `done + review pending` | Worker 和 Verify 已完成，等待 PM 验收 |
| `done + accepted` | PM 已验收，计入项目完成进度 |
| `done + rejected + repairing` | PM 已拒绝；原审计保留，repair 正在运行 |
| `failed + repairing` | Agent 命令或 Verify 失败；平台已排入 repair，不需要 PM 手工轮询重做 |
| `failed/rejected + required` | repair 已交付，正在等待 PM 对当前 repair task 作出 Review；不能反过来 accept 原失败任务 |
| `failed/rejected + resolved` | 原失败/拒绝审计保留，但 repair 已由 PM Review 接受闭环（若计划声明独立 acceptance 也须完成），可计入计划完成 |
| `resolution_status=needs_pm_decision` | repair 已达到 `max_retries`；这是需要 PM 通过平台读取详情并决定的终止边界 |
| `cancelled` | PM 撤销，不再调度 |
| `superseded` | PM 显式退出升级前的 `done + pending review` 伪完成；原交付与审计保留，不再验收或调度 |

Agent 的在线状态按心跳租约派生：心跳在 5 分钟阈值内的显示 `idle`/`busy`；超过阈值则派生为 `stale`（或已显式置 `offline`），**不会**因历史注册记录继续显示为 `idle/online`。原始登记信息（`registered_at`/`last_heartbeat`）始终保留可审计。心跳恢复后自动重新计入在线。

重置已完成任务会清除旧结果、Verify 证据和 PM Review，重新执行后必须重新验收。`cancelled` 与 `superseded` 都是不可 reset 的终态；遗留伪完成应使用上面的显式 preview/confirm 流程，而不是先清空证据再复活。

## 验证项目本身

测试必须使用独立 Redis 数据库和临时 SQLite，不能连接生产运行库：

```bash
REDIS_URL="redis://127.0.0.1:6379/1" \
ACCEPTANCE_REVERIFY_TEST_REDIS_URL="redis://127.0.0.1:6379/2" \
LEASE_LIFECYCLE_TEST_REDIS_URL="redis://127.0.0.1:6379/3" \
LEGACY_REVIEW_TEST_REDIS_URL="redis://127.0.0.1:6379/4" \
OWNERSHIP_TEST_REDIS_URL="redis://127.0.0.1:6379/5" \
REPAIR_OWNERSHIP_TEST_REDIS_URL="redis://127.0.0.1:6379/6" \
RESTORE_DOORBELL_TEST_REDIS_URL="redis://127.0.0.1:6379/7" \
RESTORE_MAINTENANCE_TEST_REDIS_URL="redis://127.0.0.1:6379/8" \
SUPERSEDE_TEST_REDIS_URL="redis://127.0.0.1:6379/9" \
npm test
npm --prefix web test -- --run
npm run build
npm pack --dry-run --ignore-scripts
```

一次产品级验收至少覆盖：

```text
计划提交
  → 两个独立 Worker 领取和执行
  → Lease/Heartbeat
  → Verify 与结果上报
  → 独立 acceptance
  → PM Review
  → 浏览器状态和 API 状态一致
  → 重置后旧验收不会残留
```

测试数量会随功能演进变化；发布前以上述命令的当次退出码和完整输出为准，而不是固定数量声明。

## 当前边界

Biao 当前定位是本地和私有环境的多 Agent 研发控制台，而不是完整企业 SaaS。目前尚未内置：

- GitHub/GitLab PR 与 CI 原生联动；
- 企业 SSO、RBAC 和多租户；
- 容器级 Worker 沙箱；
- 模型 Token、成本和 Trace 分析；
- 跨节点自动部署和弹性扩缩容。

这些能力可以后续接入，但不影响当前本地多 Agent 调度、验证和验收闭环。
