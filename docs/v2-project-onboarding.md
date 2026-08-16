# V2 分布式项目接入指南

> 适用场景：中央服务区（如 NAS Docker，五个 feature flag 全开）+ 多 Worker 节点 + Git 远端交付。
> 单机 V1 流程（bootstrap → plan init → worker 消费）见 [quickstart](quickstart.md) 与 [agent-join](agent-join.md)。

一个新项目（代码库）从零接入 V2 只需要五步，全部走一等入口，不需要手工在服务器放目录副本。

## 前置条件

- 中央 Biao 服务可达，且持有 Owner API Token（`BIAO_API_TOKEN`）
- 中央 Git 服务（如 Gitea）可达，代码已在远端（例如 `main` 分支）
- Worker 节点已注册（持有 bvn2 节点凭据，如 `~/biao-node/node-credential.json`）

## 接入序列

```bash
export BIAO_URL="http://<中央服务地址>"
export BIAO_API_TOKEN="<owner-token>"

# ① 注册 V2 项目：--repo 是 Worker clone 的 Git 远端
biao project create offic --repo http://<git>/<org>/offic.git --branch main

# ② 建 plan/任务（进入 V1 队列，V2 claim 桥接回填归属）
biao plan create offic-init --project <服务器 WORKSPACE_ROOTS 内路径> --title "初始化"

# ③ 查 Worker 节点
biao project nodes

# ④ 授权节点访问项目（claim 前必须）
biao project authorize <project_id> <node_id>

# ⑤ Worker 端配置执行命令后启动
#    BIAO_EXEC_CMD='codex exec ...' biao-node run   # 内置 SSE 唤醒 + RealExecutor
```

验证：`biao project list` 能看到项目；Worker claim 后 workspace 从 `--repo` 注册的远端 clone（mirror.git 共享缓存 + `attempts/<attempt_id>/` 隔离 worktree），产物经 delivery → merge queue 合回默认分支。

MCP 侧等价工具：`project_create`（name/repo_path/default_branch/read_only）与 `project_list`，供 Harness 内的 Agent 直接调用。

## 两个 "project" 概念不要混淆

| | V2 项目（`biao project create`） | V1 plan 归属（`biao plan create --project`） |
|---|---|---|
| 值 | Git 远端 URL（`http://<git>/<org>/offic.git`） | 服务端 WORKSPACE_ROOTS 内的本地路径 |
| 用途 | Worker 工作区 clone 源、node binding 授权对象、合并策略 | plan/任务的归属路径（ownership glob、PM 路由） |
| 存储 | SQLite `projects` 表（`repository_url`） | Redis plan 元数据（`project_path`） |

注意：

- **不要往服务器工作区手工放项目副本**。GIT_DELIVERY 开启后工作区按任务从注册远端 clone，手工副本既不生效也会造成"改了没反应"的错觉。
- `biao plan create` 不带 `--project` 时默认取 CLI 所在机器的 `process.cwd()`，对远程中央服务必然被 WORKSPACE_ROOTS 校验拒绝；从本地机器调用中央服务时必须显式传服务端路径。
- V2/V1 桥接（claim 回填 `tasks.project_id`）按"首个无归属 pending 任务"分配：**多个 V2 项目并行时，先建 plan 的任务可能被后注册项目的 Worker 捞走**。多项目并行阶段建议任务级指定归属或逐项目串行接入。

## 相关命令参考

```
biao project create <name> --repo <git-url> [--branch main] [--read-only] [--legacy-scope <path>]
biao project list [--json]
biao project nodes [--json]
biao project authorize <project_id> <node_id>
biao project deauthorize <project_id> <node_id>
```

- `--read-only`：注册只读验收项目（execution_mode=read_only，claim 写链路被拒）。
- `--legacy-scope`：与既有 V1 项目路径建立桥接关联。

## 相关文档

- [Worker 接入契约](worker-integration.md)：claim/ownership/report 语义
- [MCP 接口](mcp.md)：`project_create` / `project_list` 工具
- [NAS 部署](../deploy/nas/README.md)：中央服务区搭建
- [快速接手](HANDOFF.md)：整体拓扑与凭据位置
