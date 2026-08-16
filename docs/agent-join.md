# Agent 一站式加入指南

新 Agent 加入 Biao 项目只需一条命令：注册、自动绑定、派生 Worker Token、写入本地配置。

> 本指南面向单机 V1（`--project-scope` 是服务器本地路径）。分布式 V2（中央服务区 + Git 远端 + Worker 节点）的项目注册与节点授权见 [V2 项目接入](v2-project-onboarding.md)——V2 用 `biao project create --repo <git-url>`，不要把代码副本手工放进服务器工作区。

## 快速开始

```bash
# 设置环境变量
export BIAO_URL="http://127.0.0.1:7331"      # Biao 服务地址
export BIAO_API_TOKEN="your-owner-token"      # Owner API Token

# 一条命令加入
npx biao-agent-join \
  --agent-id my-codex-1 \
  --agent-type codex \
  --project-scope /path/to/your/project \
  --capabilities code,review
```

执行成功后：
1. Agent 已注册到平台
2. 项目绑定已自动创建（policy=automatic, wake_mode=external_worker）
3. Worker Token 已写入 `.biao/agents/my-codex-1.env`

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--agent-id` | 是 | Agent 唯一标识符，如 `codex-1`、`kimi-prod` |
| `--agent-type` | 是 | 适配器类型，如 `codex`、`kimi`、`glm` |
| `--project-scope` | 否 | 要加入的项目绝对路径，可多次指定 |
| `--capabilities` | 否 | 能力标签，逗号分隔，如 `code,review` |
| `--wake-mode` | 否 | 唤醒模式，默认 `external_worker` |
| `--policy` | 否 | 绑定策略，默认 `automatic` |
| `--biao-url` | 否 | Biao 服务地址，默认 `http://127.0.0.1:7331` |
| `--runtime-dir` | 否 | 运行时目录，默认 `.biao` |
| `--dry-run` | 否 | 只打印计划动作，不实际执行 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `BIAO_URL` | 等价 `--biao-url` |
| `BIAO_API_TOKEN` | Owner API Token（必填） |
| `BIAO_RUNTIME_DIR` | 等价 `--runtime-dir` |

## 安全边界

### Worker Token 与 Owner Token 的派生关系

Worker Token 由 Owner Token 通过 **HMAC-SHA256 单向派生**生成：

```
WorkerToken = HMAC-SHA256(OwnerToken, "biao-worker-api-token-v1")
```

- Worker Token **不存储**在服务端，每次由 Owner Token 在线派生
- Worker Token 只能执行 Worker 数据面操作（register、heartbeat、claim、report）
- Worker Token **不能**执行 PM 控制面操作（planSubmit、pmReview 等）

### Token 轮换

- 轮换 Owner Token 后，所有已派生的 Worker Token **同步失效**
- 需要重新执行 `biao-agent-join` 生成新的 Worker Token

### 文件权限

生成的 `.env` 文件权限为 `0600`（仅 owner 可读写），防止其他用户读取 Token。

## 加入后的下一步

1. **配置 Supervisor 唤醒 slot**：
   ```bash
   biao-supervisor-config worker add \
     --slot my-codex-slot-1 \
     --kind codex \
     --command /path/to/adapter.mjs
   ```

2. **编写唤醒适配器脚本**（如使用 agent-kit）：
   ```bash
   biao-adapter-kit scaffold \
     --role project-agent \
     --mode external_worker \
     --output /path/to/adapter.mjs
   ```

3. **启动 Supervisor**：
   ```bash
   .biao/supervisor
   ```

4. 平台会通过 `agent_id` 自动匹配唤醒你的 Agent

## 常见问题

**Q: 注册成功但绑定失败怎么办？**
A: 注册和绑定是解耦的。注册成功后，绑定失败不会影响注册本身。响应中的 `project_binding_results` 会逐项报告绑定状态。绑定即加入项目，没有独立的手工绑定 API；Agent 保持在线后，可在 Web 控制台一键加入项目（`POST /project/agent-connections`），或重新执行 join。

**Q: 重复执行 join 会怎样？**
A: 注册是幂等的（相同 registration_id 会返回已有注册）。已存在的绑定会被跳过，不会报错。

**Q: 如何查看当前绑定？**
A: 通过 API 或 Web 控制台查看：
```bash
curl "$BIAO_URL/project/agent-bindings?project_scope=/path/to/project"
```
