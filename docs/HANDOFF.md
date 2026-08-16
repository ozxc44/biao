# Biao 项目快速接手指南

> 更新时间：2026-08-16 | 状态：全量 139 文件/1744 用例全绿，main CI 绿灯，三机 LAN 运行中

## 项目是什么

Biao 是本地优先、局域网多机的多 Agent 研发控制台：
- **单机 V1**：调度、Ownership、Question、PM 验收、灾难恢复
- **分布式 V2**：中央服务区（NAS）+ 多 Worker 节点 + Git 工作空间 + 合并队列
- **MCP 接口**：`biao-mcp`（13 个 AI 工具）
- **Web 控制台**：远程用户名密码登录

## 核心文档导航

| 文档 | 内容 |
|---|---|
| [分布式多节点方案](distributed-multi-node-development-plan.md) | 架构设计全文（v0.8.0，7 轮评审） |
| [验收审计](distributed-multi-node-acceptance-audit.md) | §22 矩阵 99 项逐项判定与证据 |
| [评审日志](distributed-multi-node-review-log.md) | 每阶段实施记录（含所有修复轮） |
| [NAS 部署指南](../deploy/nas/README.md) | Docker 一键部署 |
| [Worker 接入](worker-integration.md) | 领取、ownership、上报契约 |
| [MCP 接口](mcp.md) | 工具清单与安全模型 |
| [快速上手](quickstart.md) | 5 分钟第一次 PM 验收 |

## 当前部署拓扑

```
Mac .82 (PM + 本机 V1 栈)     NAS .119 (中央服务区)     .25 WSL2 (Worker)
  z/z 远程登录控制台    ←→     Biao Server + Redis       bvn2 → V2 claim → bva2
  bin/biao.js CLI             + Gitea :23000             → SSE 推送唤醒
  scripts/supervisor.mjs      + Artifact Store            → RealExecutor 全链
                               + SQLite (16 迁移)
                               + Merge Queue
```

## 关键凭据

| 用途 | 位置 |
|---|---|
| NAS Owner API Token | `/data_n004/biao/src/deploy/nas/.env`（NAS 上） |
| NAS z/z 登录账户 | SQLite `human_accounts` 表 |
| .25 Worker bvn2 | `~/biao-node/node-credential.json`（.25 上） |
| V2 密钥环 | NAS `.env` 中 `BIAO_V2_CREDENTIAL_KEY` |
| enrollment ticket | NAS `.env` 中 `BIAO_V2_ENROLLMENT_TICKET` |

## 代码结构

```
src/server/service.ts       V1 核心服务（10912 行，待继续拆分）
src/server/v2/              V2 分布式层
  attempt-service.ts        Attempt 域（claim/report/Question，已拆出）
  delivery-service.ts       Delivery 域（diff 验证/repair/reverify）
  merge/queue.ts            合并队列（串行+CAS+conflict）
  git/workspace.ts          Git 工作空间（clone-per-attempt）
  git/ref-acl.ts            ref ACL（默认分支/tag/他人 branch 拒绝）
  human-identity.ts         bvh2 凭据 + enrollment + 用户名密码
  credentials.ts            bvn2/bva2/bvm2 token 签发验签
  rbac.ts                   四角色矩阵
  webhook-service.ts        Webhook 通知（HMAC+Slack）
  routes/registry.ts        V2 路由声明式注册表
  routes/v2-routes.ts       V2 路由实现
src/node/                   biao-node Worker 守护进程
  daemon.ts                 状态机 + SSE 订阅 + 自动 claim
  real-executor.ts          真实执行器（execCommand 模板）
src/cli/                    CLI 入口
src/plan/                   Plan 解析
scripts/sync-preflight.sh  push 前六段预检
deploy/nas/                 NAS Docker 部署
web/                        Web 控制台（React）
tests/distributed/          分布式 E2E 测试（40 文件）
```

## 开发工作流

```bash
npm run build:server        # 编译
npx vitest run             # 全量测试（需 Redis 6380）
npm --prefix web test       # Web 测试
./scripts/sync-preflight.sh --quick   # push 前快速预检
./scripts/sync-preflight.sh           # 全量预检
```

## NAS 运维

```bash
# SSH（密码从 Mac Keychain 取）
nas_secret=$(security find-generic-password -s mac-nas -a 18950509383 -w)
SSHPASS="$nas_secret" sshpass -e ssh -p 10000 18950509383@192.168.31.119

# 更新部署
cd /data_n004/biao/src/deploy/nas
docker compose build --no-cache biao-server
docker compose down && docker compose up -d

# 查看日志
docker logs biao-server --tail 20
```

## 已完成（不需要重做）

- Phase 0a-1→8 全部实施验收
- 24 项审计后续增强（五车道+微车道+fixture 修复）
- P11 热修复（V2/V1 桥接、bvn2 读面、scope、compose 持久化）
- P12 全面完善（真实 harness、SSE 推送、webhook、安全）
- 登录系统（用户名密码 + enrollment code + bvh2 Cookie）
- 同步预检体系（六段门禁 + git hook）
- 三机跨机联调（claim → report → 状态验证）
- 唤醒派活测试（Worker 自动发现→领取→执行→上报）

## 剩余工作（优先级排）

### 🔴 高优先级

1. **真实 harness 执行**：在 .25 上配置 `BIAO_EXEC_CMD` 指向真实 `codex exec` 或 `kimi -p`，让 Worker 真正修改代码并走完 workspace → delivery → merge 链
2. **.25 daemon 替换轮询脚本**：停掉 `worker-wake.mjs`，改用 `biao-node run`（内置 SSE + RealExecutor 全链）
3. **service.ts 继续拆分**：剩余 6 个域（Delivery/Merge/Incident/Reconcile/Project/Node），台账见 `src/server/v2/SERVICE_MAP.md`

### 🟡 中优先级

4. TLS（NAS 前加 Caddy/Nginx 反向代理）
5. 审计 25 项"部分覆盖"升级（见验收审计文档）
6. Windows 原生 / macOS ARM64 Worker 实机验证

### 🟢 低优先级

7. Worker 自动扩缩容（队列深度触发）
8. 多租户 / 企业 SSO
9. 成本/token 跟踪
10. 任务依赖可视化图

## 已知问题

| 问题 | 影响 | 临时方案 |
|---|---|---|
| Redis/SQLite 偶尔状态不同步 | Worker 可能领到已完成任务 | `biao watchdog --auto-fix` |
| NAS compose 每次重建需补 WORKSPACE_ROOTS | 忘了补则服务起不来 | 已写入 Dockerfile ENV（P11-4） |
| enrollment ticket 服务端不主动失效 | 用过的 ticket 可能重用（低风险） | 定期轮换 `BIAO_V2_ENROLLMENT_TICKET` |

## 联调机器信息

| 机器 | IP | 系统 | SSH | 用途 |
|---|---|---|---|---|
| Mac | .82 | macOS | 本机 | PM + 开发 |
| NAS | .119 | Linux | `ssh -p 10000 18950509383@192.168.31.119` | 中央服务区 |
| Worker | .25 | WSL2 | `ssh z@192.168.31.25` | Worker 节点 |

密码获取方式见 `~/.zcode/skills/lan-cloud-topology/api.md`。
