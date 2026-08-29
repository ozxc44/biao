# Biao 竞品调研：多智能体编排 / CLI 编码 Agent 编排开源生态（2025–2026）

> 调研日期：2026-08-29。Star 数与活跃度来自当日 GitHub API（`api.github.com/repos/...`），为快照值。
> Biao 画像：LAN-first 中央服务器（Fastify + SQLite + Redis，跑在家庭 NAS）+ HTTP API/MCP；瘦客户端（supervisor 派发 worker harness、pm-watch 门铃轮询唤醒临时 PM、MCP stdio 适配器）；生命周期 claim → execute → report(done) → PM evidence review → accept/reject；ownership/modules CAS、plans、questions、doorbell。

> **落地状态（2026-08-29，随本文件同轮迭代）**：建议 #1（SSE 事件唤醒）已实现为 `BIAO_SUPERVISOR_EVENT_WAKE=1`（PR #16）；PM 验收证据链（建议 #4 的前置）已修复 execute_verify 结果持久化（PR #15）。其余建议见文末排序清单。

---

## 一、执行摘要

1. **"编排多个 CLI 编码 agent"在 2025–2026 已经从博客技巧长成一个独立赛道**，有了专门的 awesome 清单（[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)）和数十个项目。赛道内部分化成几层：单机并行运行器（Vibe Kanban、claude-squad、cmux）、单机监督者（AWS CAO、gastown）、**跨会话协调协议（swarm-protocol、GNAP）**、**云端任务板（agent-kanban、OpenAI Symphony）**。Biao 的定位（中央服务器 + 跨机 worker + PM 验收门）在这个赛道里相当独特，最接近的竞品是 swarm-protocol（协议层）和 agent-kanban / Symphony（验收闭环层）。
2. **通用多智能体框架（LangGraph、CrewAI、AG2/AutoGen、MetaGPT）解决的是"进程内 agent 图/角色协作"，不是"跨机器调度 CLI harness"**，对 Biao 的直接竞争很小，但它们的服务器化形态（LangGraph Agent Server 的 durable task queue + queue workers + background runs）是 Biao 中央服务器形态的最成熟参照。
3. **低资源客户端的业界共识模式是：出站长轮询/长连接（Temporal、Buildkite、GitHub self-hosted runner）+ 空闲指数退避 + 按需拉起进程（scale-to-zero）+ 一次性推送扇出（SSE/ntfy）**。没有任何成熟系统依赖"服务器反向入站连接"唤醒客户端；全部是 client-initiated outbound。
4. **验收闭环（review/accept gate）正在成为标配**：OpenAI Symphony 的 "proof-of-work"（CI 状态 + PR review + 复杂度分析 + 演示视频 → accept 才 land PR）、gastown 的 Refinery（Bors 式合并队列 + 验证门）、HumanLayer 的 "review the PLAN, not just the code"。Biao 的 PM Review 门在方向上踩对了，且是少数把"独立验收 agent"制度化的项目。
5. **教训性信号**：AutoGen 进入维护模式（2025-10，合并进 [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)）、MetaGPT 70k star 但 2026-01 后基本停更——star 数 ≠ 健康度；轻核心 + 薄客户端的架构选择（Biao 现路线）被验证是正确的长期赌注。

---

## 二、赛道地图

| 层 | 代表项目 | 与 Biao 的关系 |
|---|---|---|
| 通用多智能体框架（库/服务器） | LangGraph、CrewAI、AG2、Microsoft Agent Framework、MetaGPT、OpenAI Agents SDK、Letta | 参照系：durable 执行、任务队列、内存/状态管理 |
| 编码 agent 平台（自带 agent loop + 沙箱） | OpenHands、goose | 参照系：事件流架构、沙箱 runtime、scheduler |
| 单机并行运行器（kanban/TUI/终端） | Vibe Kanban、claude-squad、cmux、container-use | 下层：并行与隔离技术（worktree/容器），无跨机调度 |
| 单机监督者（supervisor 派发 CLI） | AWS CAO、ruflo(claude-flow)、Task Master | 同为"supervisor + CLI harness"形态，但单机 |
| 跨会话/跨人协调协议 | **swarm-protocol**、**GNAP** | 与 Biao 的 claim/heartbeat/ownership 协议直接同构 |
| 云/服务器任务板 + 验收闭环 | **agent-kanban**、**OpenAI Symphony**、gastown、HumanLayer | 与 Biao 的"任务板 + PM 验收"直接同构 |
| 基础设施调度范式（非 agent 专属） | Temporal、Buildkite agent、GitHub Actions self-hosted runner、ntfy | 低资源 worker 唤醒的成熟参照 |

---

## 三、对比表

### 3.1 与 Biao 同赛道（CLI 编码 agent 编排 / 协调 / 验收）

| 项目 | Stars | 架构形态 | 跨机/LAN 分布 | 空闲 worker 模型 | 任务生命周期/验收 | 多 harness | License | 活跃度(pushed) |
|---|---|---|---|---|---|---|---|---|
| [OpenAI Symphony](https://github.com/openai/symphony) | 26.9k | spec-first（SPEC.md，任意语言实现）+ Elixir 参考实现 | 监听 Linear 看板，本地 spawn agent；无内建多机 | 无常驻 worker，按任务 spawn | **run → proof-of-work（CI/PR review/复杂度/演示视频）→ accept → land PR** | Codex 等（spec 不限定） | Apache-2.0 | 2026-08-19 |
| [AWS CLI Agent Orchestrator (CAO)](https://github.com/awslabs/cli-agent-orchestrator) | 1.1k | 本地 `cao-server` + tmux 会话，supervisor 工具派发 specialist CLI | 单机（本机 tmux） | supervisor 常驻，worker 按任务起 | supervisor 协调，无独立验收 agent | **12+ CLI**（Claude Code、Codex、Kiro、**Kimi CLI**、Copilot、OpenCode、Cursor、Grok…） | Apache-2.0 | 2026-08-28（活跃） |
| [agent-kanban](https://github.com/saltbo/agent-kanban) | 458 | Cloudflare 部署：Hono API + D1(SQLite) + SSE Web UI；机器上跑 daemon | **daemon ↔ 云 API 多机** | daemon 轮询 API；agent 状态 idle→working→offline | Todo → In Progress → **In Review** → Done；leader 审 PR，merge 后自动 complete | Claude Code、Codex、Gemini、Copilot、Hermes | FSL-1.1-ALv2（非 OSI） | 2026-08-27（活跃） |
| [swarm-protocol](https://github.com/phuryn/swarm-protocol) | 53 | **纯 MCP headless 协调层**（19 个 MCP 工具，无 UI/API） | 无服务器；跨会话、跨人共享库 | agent 会话即来即走 | intent: draft→open→claimed→done；claim 带 **heartbeat(10–15min) + 陈旧回收**；complete 自动解锁依赖 | 任何会说 MCP 的 agent（Claude Code 等） | MIT | 2026-03-15（alpha） |
| [GNAP](https://github.com/farol-team/gnap) | 83 | **git 即传输层**：`.gnap/` 四个 JSON 实体（agents/tasks/runs/messages） | 天然分布式（共享 git repo），离线可用 | **心跳循环：git pull → 读任务 → 干活 → push → sleep** | task/run 两级；git log 即审计日志 | 任何会 `git push` 的 agent（OpenClaw、Codex、Claude Code…） | MIT (RFC draft) | 2026-03-17（草案阶段） |
| [gastown](https://github.com/gastownhall/gastown) | 17.8k | Go CLI 工作区管理器：Mayor(总协调) + rigs + polecats(临时 worker，身份持久) | 单机为主 | polecats 会话即用即弃；Witness/Deacon/Dogs **三层看门狗** | beads(issues) + convoys；**Refinery：Bors 式合并队列 + 验证门**；`gt escalate` 分级升级 | Claude Code、Copilot、Codex、Gemini | MIT | 2026-08-19 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 27.9k | Rust 桌面 kanban，git worktree 隔离并行跑 agent | [Remote Access](https://www.vibekanban.com/blog/remote-access)：从另一台设备远程控制本机 agent（非多机调度） | 桌面常驻（本地 App） | kanban 卡片流，无独立验收 agent | Claude Code、Codex、Gemini、Copilot 等 15+ | Apache-2.0 | 2026-04-24 |
| [claude-squad](https://github.com/smtg-ai/claude-squad) | 8.4k | Go TUI：tmux 会话 + git worktree 管理多个 agent | 单机 | TUI 常驻，agent 在 tmux pane | 手动切换/合并，无验收流 | Claude Code、Codex、OpenCode、Aider、Amp | **AGPL-3.0** | 2026-08-20 |
| [ruflo (ex claude-flow)](https://github.com/ruvnet/ruflo) | 69.7k | Claude Code/Codex 外围 meta-harness：MCP server + Queen/worker 层级 swarm + hive-mind 共识 | 单机为主 | swarm 会话内 | SPARC 方法论，会话内 | Claude Code、Codex | MIT | 2026-08-29（活跃） |
| [Task Master](https://github.com/eyaltoledano/claude-task-master) | 28.0k | MCP 任务管理（PRD→tasks.json），嵌入 IDE agent 使用 | 无（文件级） | 无常驻进程 | 任务 CRUD，无执行/验收闭环 | 任何 MCP 客户端（Cursor、Claude Code…） | MIT 变体（NOASSERTION） | 2026-04-28 |
| [container-use (Dagger)](https://github.com/dagger/container-use) | 4.0k | MCP server + CLI：每 agent 一个 Dagger 轻量容器 + worktree/分支 | 单机（容器级隔离） | env 按需创建/快照/销毁 | 产出落在专用分支，人 approve/merge/drop | 任何 MCP agent（Claude Code、Cursor…） | Apache-2.0 | 2026-08-17 |
| [HumanLayer](https://github.com/humanlayer/humanlayer) | 11.4k | "多人协作编码 agent 控制平面"：CodeLayer driver/reviewer + 远程 daemon | workstation + 后台 agent cloud | 后台 daemon | **人审批门贯穿**：approve PLAN 而非只 review code；CRISPY 阶段流；异步 standup 审批 | Claude Code、Codex 等 CLI | NOASSERTION | 2026-06-19 |

### 3.2 通用框架与平台（参照系）

| 项目 | Stars | 架构形态 | 分布/调度 | 验收/HITL | License | 活跃度 |
|---|---|---|---|---|---|---|
| [OpenHands](https://github.com/OpenHands/OpenHands) | 85.5k | 服务器 + **事件流架构**（Agent→LLM→Action→Observation 循环），Docker 沙箱 runtime，WebSocket 推送事件 | 本地/云沙箱（docker/remote） | 人机对话式，无独立验收 agent | MIT | 2026-08-28（活跃） |
| [LangGraph](https://github.com/langchain-ai/langgraph) (+[Agent Server](https://docs.langchain.com/langsmith/agent-server)) | 40.7k | OSS 是库；**Platform/Agent Server 是服务器**：run 先落库 → durable task queue → 无状态 queue workers 拉取执行 → checkpoint | queue workers 水平扩展；background runs 客户端用 **long-poll 或 webhook** 取结果 ([分析](https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short)) | interrupt + human-in-loop 节点 | MIT | 2026-08-28（活跃） |
| [CrewAI](https://github.com/crewAIInc/crewAI) | 57.8k | Python 库：role-based crew，进程内 | 无内建分布 | 流程内人工输入 | MIT | 2026-08-28（活跃） |
| [AutoGen](https://github.com/microsoft/autogen) | 60.7k | **2025-10 起维护模式**，并入 Microsoft Agent Framework（2026-04 GA）（[公告](https://github.com/microsoft/autogen/discussions/7066)、[迁移指南](https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/)） | AutoGen Studio 有 server 形态 | 对话式 | 仓库标 CC-BY-4.0* | 2026-04-15（停滞） |
| [AG2](https://github.com/ag2ai/ag2) | 4.9k | AutoGen 社区延续，"AgentOS"，支持分布式 agent worker | 有分布式实验 | 对话式 | Apache-2.0 | 2026-08-28（活跃） |
| [MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 70.1k | 库：SOP 式软件公司角色流水线 | 无 | 无 | MIT | 2026-01-21（基本停更） |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | 29.1k | 轻量库（swarm 继任者），handoff/guardrail/session | 无（自家云） | 无 | MIT | 2026-08-28（活跃） |
| [Letta](https://github.com/letta-ai/letta) | 24.5k | 有状态 agent 平台（服务器 + API），MemGPT 内存分页；**sleep-time compute：空闲期后台 agent 重写记忆**（[博客](https://www.letta.com/blog/sleep-time-compute/)、[论文](https://arxiv.org/html/2504.13171v1)） | 服务器多租户 | 无 | Apache-2.0 | 2026-08-23（活跃） |
| [goose (Block)](https://github.com/aaif-goose/goose) | 53.6k | Rust CLI/桌面 agent，70+ MCP 扩展；scheduler（legacy+**Temporal**）**每次 run 新起一个 Agent**（[讨论](https://github.com/aaif-goose/goose/discussions/4389)）；社区有 Goosetown flock 多 agent 模式 | 单机为主；计划优化小模型本地跑（[roadmap](https://github.com/aaif-goose/goose/discussions/6973)） | 无 | Apache-2.0 | 2026-08-29（活跃） |

\* AutoGen 仓库主 license 文件当前标注 CC-BY-4.0（GitHub API 返回值）；历史代码包多为 MIT，引用前请自行核对。

---

## 四、重点竞品速览（与 Biao 逐点对照）

### 4.1 OpenAI Symphony —— "管理 work 而不是监督 agent"（方向最接近 Biao 的愿景）
- **形态**：先写 [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)（让任何 agent/语言自行实现），官方给 Elixir 参考实现；配套概念是 [harness engineering](https://openai.com/index/harness-engineering/)。
- **闭环**：监听 Linear 看板 → spawn agent 做 run → 产出 **proof-of-work：CI 状态、PR review 反馈、复杂度分析、walkthrough 视频** → 人 accept → 安全 land PR。工程师"不需要盯着 Codex"。
- **对 Biao**：这就是 Biao 的 claim → report → PM review → accept，但 Symphony 把"证据"产品化得非常具体（四类结构化证据）。Biao 的 `verify_results` + `result_md` 可以向这个标准靠拢。([README](https://github.com/openai/symphony))

### 4.2 swarm-protocol —— 与 Biao 协议层最同构（claim/heartbeat/冲突/解锁）
- **形态**：无 REST、无 UI 的 headless MCP server，19 个工具；核心循环 `get_team_status → claim_work(声明文件) → check_conflicts → heartbeat(每 10–15min) → complete_claim`，complete 后依赖方 intent 从 blocked → open，被下一个 agent 自动拾取。
- **关键设计**：**把 COORDINATION.md 塞进 CLAUDE.md**，agent 无需人工配置就会协调——"CLAUDE.md 集成模式与服务器本身同等重要"。
- **定位声明**：明确区分单会话（Claude Code Agent Teams）、单 PR（Code Review）、单机（VS Code multi-agent）与**跨会话/跨人**（自己）四层。
- **对 Biao**：Biao 的 lease/heartbeat/ownership CAS 与之几乎一一对应；可直接借鉴其 (a) claim 时声明文件清单、(b) 陈旧心跳自动回收、(c) 完成即解锁依赖并自动唤醒下游、(d) AGENTS.md 注入式协议文档。([README](https://github.com/phuryn/swarm-protocol))

### 4.3 GNAP —— 零服务器协议（低资源与离线的极限形态）
- **形态**：`.gnap/` 里 `agents.json + tasks/*.json + runs/*.json + messages/*.json` 四个实体，git push/pull 即通信；心跳循环 `pull → 读 → 干活 → push → sleep`；**git history 就是审计日志**；离线可干活、事后同步。
- **对 Biao**：证明"任务板可以薄到只是一个 git 仓库"。Biao 可考虑 artifact/result 走 git（或提供 git mirror 通道）作为 HTTP API 的降级/离线备份；NAS 宕机时 worker 仍可离线执行。([README](https://github.com/farol-team/gnap))

### 4.4 agent-kanban —— 云端任务板 + 本机 daemon 的混合（与 Biao 拓扑同构）
- **形态**：Cloudflare（Hono API + D1 SQLite）+ SSE 实时看板；每台机器一个 **daemon，轮询 API 拉活，在本地 worktree spawn worker agent**；leader agent 审 PR 并 merge，daemon 检测 merge 后自动 complete 任务；**每个 agent 有 Ed25519 密码学身份**，跨任务/commit/PR 可追溯。
- **对 Biao**：拓扑 = Biao 的"中央 API + 各机 supervisor"。可借鉴：agent 密码学身份、merge 事件回流自动完成任务、任务状态里显式的 In Review 列。注意其 FSL-1.1 许可（非 OSI，竞品引用代码需谨慎）。([README](https://github.com/saltbo/agent-kanban))

### 4.5 AWS CAO —— supervisor 派发 CLI 的工程化样板
- **形态**：`cao-server`（本地）+ 每个 provider CLI 跑在隔离 tmux 会话；supervisor 通过工具并行/串行派发 specialist；**12+ CLI 支持，包括 Kimi CLI**（与 Biao 的 harness 清单高度重合）。
- **对 Biao**：其 provider 适配文档按 CLI 逐个写安装/鉴权/行为差异（docs/claude-code.md、docs/kimi-cli.md…）——Biao 的 worker harness 适配层值得复刻这套"每 harness 一页文档"的组织方式。([README](https://github.com/awslabs/cli-agent-orchestrator)、[AWS 博客](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/))

### 4.6 gastown —— worker 健康、看门狗与合并队列
- **形态**：Mayor（总协调）→ rigs（项目容器）→ polecats（**临时会话 + 持久身份**的 worker）；工作状态存 git-backed Beads ledger，崩溃重启不丢上下文；**Witness（每 rig 生命周期看护）+ Deacon（后台巡检）+ Dogs（维护 worker）三层看门狗**；**Refinery：Bors 式合并队列**，批量 MR、跑验证门、二分定位失败；`gt escalate` 按 CRITICAL/P0… 分级升级阻塞。
- **对 Biao**：Biao 的 lease 超时回收可升级为分层看门狗（每 worker 心跳 → supervisor 级巡检 → PM 级升级）；accept 后进入集中 merge queue 再落地，避免多个 accepted 任务互相踩。([README](https://github.com/gastownhall/gastown))

### 4.7 HumanLayer —— 人审门的最佳实践
- **核心观点**："You must review and approve the PLAN, not just the code"（[ACE/CRISPY 方法论](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md)）；driver/reviewer 双 agent 分工；人以**异步 standup**（早上批量审夜间 agent 的产出/计划）参与，而非实时盯；把工作切成 **reviewer 友好的小 PR** 让审批便宜化（[播客](https://boundaryml.com/podcast/2025-11-25-no-vibes-allowed-using-codelayer-to-build-codelayer)、[12 Factor Agents](https://www.humanlayer.dev/blog)）。
- **对 Biao**：PM Review 的颗粒度设计——先审 plan/验收标准，再审交付；`question_ask` 的 checkpoint 机制已经是对的方向，可以再加"批量审阅模式"（一次 PM 会话处理整批 done 任务，减少 PM 唤醒次数）。

### 4.8 其余值得知道的项目（一句话）
- **Vibe Kanban**（27.9k, Apache-2.0）：桌面 kanban + worktree 并行的标杆；[Remote Access](https://www.vibekanban.com/blog/remote-access) 是"从别的设备遥控本机 agent"，不是多机调度。
- **claude-squad**（8.4k, **AGPL-3.0**）：tmux+worktree TUI 的标杆；AGPL 对 Biao 这类集成方有传染风险，只可借鉴思路。
- **cmux**（[craigsc](https://github.com/craigsc/cmux) 601★ MIT / [manaflow](https://github.com/manaflow-ai/cmux) 26.6k★）：一个名字两个项目——"tmux for Claude Code" 与 Ghostty 系 macOS 终端。
- **container-use**（Dagger，4.0k）：每 agent 一个容器 + worktree + 专用分支，`env` 可 list/snapshot，产出即分支，人只做 approve/merge/drop（[InfoQ](https://www.infoq.com/news/2025/08/container-use/)、[博客](https://dagger.io/blog/agent-container-use)）。
- **AgentsRoom [Remote Fleet](https://agentsroom.dev/features/remote-fleet)**：每台机器跑自己的 agent、实时协作——LAN 分布式 agent 的另一种取向（P2P 感知 vs Biao 的中心化）。
- **GitHub Copilot `/fleet`**（[官方博客](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)）与 [VS Code 多 agent](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)：harness 厂商正在原生内建并行派发——Biao 的差异化要放在"跨 harness + 跨机器 + 验收门"。

---

## 五、低资源客户端技术专题（调研任务 3）

### 5.1 传输机制对比（谁在用什么）

| 机制 | 空闲成本 | 实时性 | 断网/防火墙友好 | 使用者 |
|---|---|---|---|---|
| 短轮询 | 差（每 N 秒建连，header 开销 + 唤醒） | 受间隔限制 | 最好（纯出站） | agent-kanban daemon（默认 API poll） |
| **长轮询（long-poll, 挂 30–60s）** | 好（少量常挂连接，无任务时零请求风暴） | 高（有任务立即返回） | 最好（纯出站） | **Temporal worker**（[matching-service 长轮询](https://github.com/temporalio/temporal/blob/main/docs/architecture/matching-service.md)）、LangGraph background runs（[poll 或 webhook](https://agentnativedev.medium.com/langgraph-vs-cloudflare-agents-queues-scheduling-and-durable-execution-3e2d625bcdbc)）、Buildkite agent（[出站轮询取活](https://buildkite.com/docs/agent)）、GitHub self-hosted runner（[出站轮询](https://buildkite.com/docs/pipelines/migration/from-githubactions)） |
| **SSE（单向长连接推送）** | 好（单条长连 + 自动重连） | 高 | 好（基于 HTTP 出站） | agent-kanban（看板实时更新）、ntfy 订阅端（`/topic/sse`） |
| WebSocket | 好（但需 keepalive ping，双向才值） | 高 | 中（部分代理不友好） | OpenHands agent server（[事件流](https://docs.openhands.dev/openhands/usage/architecture/runtime)） |
| Webhook / 第三方推送 | 最优（客户端零轮询） | 最高 | 差（需入站可达） | LangGraph background runs 可选 webhook 回调 |
| git 心跳（pull→push→sleep） | 极低（粗粒度间隔） | 低（分钟级） | 最好 | GNAP |
| ntfy 主题订阅（SSE/JSON 流 + 移动端 APNs/FCM） | 极低（移动端走系统级推送，进程可被杀） | 高 | 好 | 自托管 [ntfy](https://ntfy.sh/)（[自托管指南](https://xtom.com/blog/self-host-ntfy-mobile-push-notifications/)） |

**通用结论**（[RXDB 对比](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)、[Ably](https://ably.com/blog/websockets-vs-long-polling)、[AlgoMaster](https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks)）：单向通知场景 SSE 优于长轮询（一条连接推多消息、内建重连）；长轮询胜在兼容性；双向才用 WebSocket。**没有任何主流系统用"服务器反向连入客户端"唤醒**——全部是客户端出站发起，这正是穿透家庭 NAT/防火墙的唯一稳妥路径。

### 5.2 进程与调度模式
- **按需 spawn（scale-to-zero）**：goose scheduler 每次触发新起一个 Agent 进程，结束即退（[讨论 #4389](https://github.com/aaif-goose/goose/discussions/4389)）；gastown polecats"持久身份、临时会话"；CAO 按任务开 tmux 会话。空闲时客户端机器上**没有任何 agent 进程**。
- **队列积压驱动扩缩容**：Temporal 的 [temporal-auto-scaled-workers](https://github.com/temporalio/temporal-auto-scaled-workers) 用一个常驻 workflow 监控 task queue 积压指标来决定拉起/回收 worker——"按积压唤醒机器"的模式。
- **空闲指数退避 + 心跳**：swarm-protocol 心跳 10–15 分钟 + 陈旧 claim 回收；GNAP sleep 循环。心跳同时承担"活着"证明与"死了回收"两个职责。
- **环境池**：container-use 的 env 按需创建/快照/复用（[文档](https://container-use.com/introduction)），消除任务冷启动。
- **sleep-time compute**（Letta）：反方向思路——空闲资源不浪费，后台 agent 整理记忆/预研上下文（[博客](https://www.letta.com/blog/sleep-time-compute/)）。对 Biao 的启示是"PM 唤醒前的预处理可以在服务器侧廉价完成"。
- **单事件循环/单二进制常驻**：ntfy（单 Go binary）、claude-squad（Go TUI）证明"常驻进程可以做到 MB 级内存、无任务零 CPU"；Biao pm-watch 的设计目标（低资源门铃）与此一致。

---

## 六、对 Biao 的建议（按影响排序，共 15 条）

1. **【高】pm-watch 从短轮询升级为 SSE 订阅 + 指数退避轮询兜底。** 门铃是单向通知，SSE 是该场景公认最优（一条长连接、自动重连、零轮询风暴；agent-kanban/ntfy 同款模式，[RXDB](https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html)）。Fastify 原生支持 SSE 回复；连接断开时退回退避轮询（1s→2s→…→上限 60s，加 jitter）。效果：把 pm-watch 从"每 N 秒醒来一次"变为"有铃才醒"，空闲 CPU≈0。
2. **【高】把 `task_claim` 的 `blocking/timeout_ms` 长轮询做成默认路径并文档化。** Biao 已有 CAS claim 与 `timeout_ms`（0–60000）参数——这就是 Temporal matching service / Buildkite 的长轮询模式（[Temporal](https://github.com/temporalio/temporal/blob/main/docs/architecture/matching-service.md)、[Buildkite](https://buildkite.com/docs/agent/self-hosted/configure/job-dispatch)）。建议：supervisor 空闲时挂满 60s 长轮询，超时后指数退避几轮再回到长轮询；Redis 侧用 BLPOP/键空间通知实现零轮询服务端。
3. **【高】空闲 supervisor 支持 scale-to-zero：无任务时只留 pm-watch 级小进程（或 systemd timer / launchd cron 形态）。** 参照 goose"每次 run 新起 Agent"、gastown"持久身份+临时会话"、CAO"按任务开 tmux"。Biao 的 supervisor 应该把"派发器"与"harness 进程"严格分离——派发器空闲功耗对标 pm-watch，harness 进程生命周期 = 任务生命周期。
4. **【高】标准化"证据包"（proof-of-work），把 PM Review 从读自由文本变成读结构化卡片。** Symphony 的四件套（CI 状态、PR review 摘要、复杂度分析、演示材料）是最佳模板（[README](https://github.com/openai/symphony)）。Biao 已有 `verify_results`/`result_md`/`result_json`：建议定义标准 evidence schema（verify 输出 + diff 统计 + 变更文件列表 + 风险自评 + 回放命令），PM `pm_review_read` 直接渲染卡片。
5. **【高】"完成即解锁 + 自动唤醒下游"：depends_on 满足时主动振铃等待者。** swarm-protocol 的 `complete_claim → intent blocked→open → 下一个 agent 自动拾取`（[README](https://github.com/phuryn/swarm-protocol)）。Biao 在 `task_report(done)`/`pm_review_decide(accept)` 后应立即向 SSE 流推送"新可领任务"事件，让挂在长轮询上的 worker 即时返回——依赖链不再靠 worker 碰运气重试。
6. **【高】lease TTL + 心跳陈旧回收 + 分级看门狗。** swarm-protocol 的 stale claim 回收与 gastown 的 Witness/Deacon/Dogs 三层看护（[README](https://github.com/gastownhall/gastown)）证明这是多 worker 稳定性的关键。Biao 建议：心跳间隔 10–15 分钟、超 2–3 个周期无心跳即由服务器 CAS 回收 lease 并振铃重派；supervisor 崩溃检测 → 升级为 question/门铃，而非静默卡死。
7. **【中高】accept 之后加 Bors 式合并/落地队列。** gastown Refinery：批量合入 + 验证门 + 失败隔离/二分（[README](https://github.com/gastownhall/gastown)）。Biao 多任务并行 accept 后串行 rebase + 跑 verify 再落地，防止"各自都过、合起来挂"。
8. **【中高】AGENTS.md 注入式协议（零配置 harness 接入）。** swarm-protocol 的核心洞察："把 COORDINATION.md 放进 CLAUDE.md，agent 无需人工配置就会协调"。Biao 可在 worker clone 仓库时自动注入一段 AGENTS.md/CLAUDE.md：声明 claim/report/question/BIAO_QUESTION 协议与禁忌——新 harness（含 Kimi/Qwen 等）零适配成本。
9. **【中高】PM 批量 standup 审阅模式。** HumanLayer 的异步 standup（人早上批量审批 agent 夜间产出，[播客](https://boundaryml.com/podcast/2025-11-25-no-vibes-allowed-using-codelayer-to-build-codelayer)）+ "review the PLAN, not just the code"。Biao 建议：(a) `pm_next` 已聚合待办——再提供"一次 PM 会话处理整批"的流程文档；(b) 大任务先审 plan（在 task_upsert 后、执行前插一个可选 plan-review 门），拦住方向性浪费。
10. **【中】agent 密码学身份。** agent-kanban 给每个 agent 发 Ed25519 身份，跨任务/commit/PR 追溯（[README](https://github.com/saltbo/agent-kanban)）。Biao 的 agent_id 目前是字符串——加一对签名密钥，`task_report` 与 commit 元数据带签名，PM 验收时可验证"交付确实由声明的 agent 产生"，防伪装。
11. **【中】服务器侧"PM 唤醒前预处理"（穷人的 sleep-time compute）。** Letta 用空闲期后台 agent 整理记忆（[博客](https://www.letta.com/blog/sleep-time-compute/)）。Biao 版本：PM 被门铃唤醒前，服务器（或一个后台小 agent）预生成每份交付的 review 摘要（diff 统计、verify 结果、与 goal 的 diff 对照），PM 上下文注入即用，缩短 PM 会话时长与 token 成本。
12. **【中】artifact/result 提供 git 通道（离线降级）。** GNAP 证明任务板可以薄到 git（pull→干活→push→sleep，git log 即审计，[README](https://github.com/farol-team/gnap)）。Biao 的中央事实源仍是 SQLite，但可让 result artifact 镜像到一个 git 分支：NAS 宕机时 worker 离线工作、恢复后同步；审计天然可 `git log`。
13. **【中】协议 spec-first：一页 SPEC.md。** Symphony 先写 spec、参考实现可替换（[SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)）。Biao 的 HTTP+MCP 生命周期值得抽象成一页协议 spec（claim/lease/heartbeat/report/question/bell 语义），社区可为任意语言实现客户端——supervisor/pm-watch 从"官方组件"变成"参考实现"。
14. **【中】环境预热池（可选，需内存预算）。** container-use 的 env 池/快照模式（[文档](https://container-use.com/introduction)）。Biao 的 supervisor 可在任务间隙预 build worktree/依赖缓存（尤其 npm install 类），claim 命中即秒起——用空闲磁盘换冷启动时间。注意 NAS 机器内存预算，做成可关的配置。
15. **【低但战略】明确与 harness 原生多 agent 的分层定位。** Copilot `/fleet`、VS Code multi-agent、Claude Code Agent Teams 都在把"单机并行"内建进 harness（[GitHub 博客](https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/)、[VS Code](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)）。Biao 文档应明确：单会话/单机并行交给 harness 原生能力；**跨 harness、跨机器、带人审验收门**的编排才是 Biao 的领地（swarm-protocol 的四层定位声明是很好的写法模板）。

**反向确认（不要做的事）**：不要引入重型运行时依赖（AutoGen 维护模式教训：框架越重，迁移成本越高，[公告](https://github.com/microsoft/autogen/discussions/7066)）；不要做服务器反向连入客户端的"唤醒"（全行业都是出站连接，家庭 NAT 不可靠）；不要追求常驻 agent 数量指标（ruflo 的"100+ agents/127 mesh"是营销叙事，Biao 的"空闲零成本"才是工程优势）；引用 claude-squad（AGPL）与 agent-kanban（FSL）代码前先过许可审查。

---

## 七、主要参考链接

**赛道清单与综述**
- awesome-agent-orchestrators: https://github.com/andyrewlee/awesome-agent-orchestrators
- Firecrawl 开源 agent 框架对比: https://www.firecrawl.dev/blog/best-open-source-agent-frameworks
- LangChain 2026 框架指南: https://www.langchain.com/resources/ai-agent-frameworks

**同赛道项目**
- Symphony: https://github.com/openai/symphony （SPEC: https://github.com/openai/symphony/blob/main/SPEC.md ）
- AWS CAO: https://github.com/awslabs/cli-agent-orchestrator （博客: https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/ ）
- swarm-protocol: https://github.com/phuryn/swarm-protocol
- GNAP: https://github.com/farol-team/gnap
- agent-kanban: https://github.com/saltbo/agent-kanban
- gastown: https://github.com/gastownhall/gastown
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban （Remote Access: https://www.vibekanban.com/blog/remote-access ）
- claude-squad: https://github.com/smtg-ai/claude-squad
- ruflo (ex claude-flow): https://github.com/ruvnet/ruflo
- Task Master: https://github.com/eyaltoledano/claude-task-master
- container-use: https://github.com/dagger/container-use （InfoQ: https://www.infoq.com/news/2025/08/container-use/ ）
- HumanLayer: https://github.com/humanlayer/humanlayer （ACE/CRISPY: https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md ；12 Factor Agents: https://www.humanlayer.dev/blog ）
- cmux: https://github.com/craigsc/cmux 、 https://github.com/manaflow-ai/cmux
- AgentsRoom Remote Fleet: https://agentsroom.dev/features/remote-fleet

**通用框架**
- LangGraph: https://github.com/langchain-ai/langgraph ；Agent Server: https://docs.langchain.com/langsmith/agent-server ；任务队列分析: https://www.diagrid.io/blog/checkpoints-are-not-durable-execution-why-langgraph-crewai-google-adk-and-others-fall-short
- OpenHands: https://github.com/OpenHands/OpenHands ；runtime 架构: https://docs.openhands.dev/openhands/usage/architecture/runtime
- CrewAI: https://github.com/crewAIInc/crewAI
- AutoGen 维护模式: https://github.com/microsoft/autogen/discussions/7066 ；迁移: https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/
- AG2: https://github.com/ag2ai/ag2
- MetaGPT: https://github.com/FoundationAgents/MetaGPT
- OpenAI Agents SDK: https://github.com/openai/openai-agents-python
- Letta sleep-time compute: https://www.letta.com/blog/sleep-time-compute/ （论文: https://arxiv.org/html/2504.13171v1 ）
- goose: https://github.com/aaif-goose/goose （scheduler 讨论: https://github.com/aaif-goose/goose/discussions/4389 ；roadmap: https://github.com/aaif-goose/goose/discussions/6973 ）

**传输/调度机制**
- Temporal matching service（长轮询）: https://github.com/temporalio/temporal/blob/main/docs/architecture/matching-service.md ；auto-scaled workers: https://github.com/temporalio/temporal-auto-scaled-workers
- Buildkite agent: https://buildkite.com/docs/agent ；job dispatch: https://buildkite.com/docs/agent/self-hosted/configure/job-dispatch
- 实时技术对比: https://rxdb.info/articles/websockets-sse-polling-webrtc-webtransport.html ；https://ably.com/blog/websockets-vs-long-polling ；https://blog.algomaster.io/p/polling-vs-long-polling-vs-sse-vs-websockets-webhooks
- ntfy: https://ntfy.sh/ （自托管: https://xtom.com/blog/self-host-ntfy-mobile-push-notifications/ ）

**harness 原生多 agent（背景）**
- Copilot /fleet: https://github.blog/ai-and-ml/github-copilot/run-multiple-agents-at-once-with-fleet-in-copilot-cli/
- VS Code multi-agent: https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development

（Star/license/pushed 数据：2026-08-29 GitHub API 快照。）
