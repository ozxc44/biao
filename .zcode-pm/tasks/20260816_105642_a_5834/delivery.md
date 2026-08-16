# NAS 119 部署任务完成报告

## 任务概述

Biao V2 局域网中央服务区 Docker 化部署（NAS 119）

## 交付物清单

### 目标 1：仓库内交付物 ✅

| 文件 | 状态 | 说明 |
|------|------|------|
| `deploy/nas/Dockerfile` | ✅ | 多阶段构建：builder → prod-deps → runtime |
| `deploy/nas/docker-compose.yml` | ✅ | 双服务：biao-redis + biao-server |
| `deploy/nas/.env.example` | ✅ | 环境变量模板 |
| `deploy/nas/install.sh` | ✅ | 一键部署脚本（幂等） |
| `deploy/nas/README.md` | ✅ | 中文部署指南 |
| `deploy/nas/docker-compose.test.yml` | ✅ | 测试配置覆盖 |
| `tests/distributed/nas-deploy.test.ts` | ✅ | E2E 测试 |
| `docs/runbooks/nas-deploy.md` | ✅ | 运维手册 |
| `package.json` | ✅ | 添加 `docker:nas` 脚本 |

### 目标 2：本机验证 ⚠️

- Docker 不可用（Mac 未安装 Docker Desktop）
- 配置文件语法已验证
- E2E 测试已编写（需 Docker 环境运行）

### 目标 3：真机部署清单

**PM 需在 Mac 上执行的命令序列：**

```bash
# 1. 打包仓库
cd /Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao
tar czf /tmp/biao-deploy.tar.gz deploy/nas/ package.json package-lock.json src/ web/ bin/ scripts/ tsconfig.json

# 2. 上传到 NAS
scp /tmp/biao-deploy.tar.gz user@192.168.31.119:/data_n004/biao/src/

# 3. SSH 登录并解压
ssh user@192.168.31.119
cd /data_n004/biao/src
tar xzf biao-deploy.tar.gz

# 4. 执行部署
cd deploy/nas
chmod +x install.sh
./install.sh

# 5. 验证
curl http://192.168.31.119:7331/health
curl http://192.168.31.119:7331/version
curl http://192.168.31.119:7331/v2/feature-flags

# 6. 获取 API Token
grep BIAO_API_TOKEN /data_n004/biao/src/deploy/nas/.env | cut -d= -f2
```

**Mac 端连接配置：**

```bash
export BIAO_URL=http://192.168.31.119:7331
export BIAO_API_TOKEN=<从 NAS 获取>
```

## 架构说明

```
Mac (开发机)                    NAS 119 (服务区)
    │                               │
    │  curl/worker                  │
    └──────────────────────────────→├─ biao-server:7331
                                    │      │
                                    │      ▼
                                    ├─ biao-redis (内部)
                                    │
                                    ├─ agent-memory-os:8910 (已有)
                                    ├─ nas-gitea:22022/:23000 (已有)
                                    │
                                    └─ /data_n004/biao/docker/
                                       ├─ redis-data/
                                       └─ biao-data/
```

## 关键设计决策

1. **Dockerfile 多阶段构建**
   - Stage 1 (builder): 安装编译依赖，构建 TypeScript
   - Stage 2 (prod-deps): 仅安装生产依赖
   - Stage 3 (runtime): 最小镜像，非 root 用户

2. **Redis AOF 默认开启**
   - 避免 2026-08-12 事故重演
   - 配置 `--appendonly yes`

3. **数据卷 bind mount**
   - 所有数据落 `/data_n004` 大盘
   - 避免系统盘空间不足

4. **V2 Feature Flags 默认全关**
   - 纯 V1 行为，灰度按 §23.1 顺序开启
   - 启用顺序：DISTRIBUTED_MODE → ARTIFACTS → NODE_RUNTIME → GIT_DELIVERY → MERGE_QUEUE

5. **健康检查**
   - 使用 Node.js fetch（兼容 busybox）
   - 30s 间隔，3 次重试

## 验收标准检查

| 标准 | 状态 | 说明 |
|------|------|------|
| 本机 docker build 成功 | ⚠️ | 需 Docker 环境 |
| compose 测试栈全断言绿 | ⚠️ | 需 Docker 环境运行 E2E |
| 交付物齐全 | ✅ | Dockerfile/compose/install.sh/README/runbook/test |
| 真机部署清单 | ✅ | 已写入交付说明 |
| 不动既有容器 | ✅ | 端口不冲突（7331/6380 vs 8910/22022/23000） |
| 密码纪律 | ✅ | .env 模板，无明文密码 |
| 不改 src/ 等 | ✅ | 仅新增 deploy/ + package.json 一行 |

## 残留风险

1. **Docker 环境未验证**
   - Mac 未安装 Docker Desktop，无法本地验证构建
   - 建议：在有 Docker 的环境运行 E2E 测试

2. **NAS 真机部署未执行**
   - 需 PM 带凭据执行部署命令
   - 建议：按清单逐步执行，验证每步输出

3. **V2 Feature Flags 未测试**
   - 默认全关，灰度开启需真机验证
   - 建议：先开 DISTRIBUTED_MODE，观察日志

4. **备份脚本未集成**
   - 文档中有备份说明，但未集成到 install.sh
   - 建议：后续添加 `scripts/backup-biao.sh`

## 后续步骤

1. **PM 执行真机部署**
   - 按清单上传仓库并执行 install.sh
   - 验证健康检查和版本端点

2. **Mac 端连接测试**
   - 配置 BIAO_URL 和 BIAO_API_TOKEN
   - 测试 Worker 连接

3. **灰度开启 V2**
   - 按 §23.1 顺序逐面开启
   - 每开一面旗观察日志 10 分钟

4. **集成备份 cron**
   - 创建 backup-biao.sh 脚本
   - 配置每日凌晨 3 点备份

## 文件变更清单

**新增文件：**
- `deploy/nas/Dockerfile`
- `deploy/nas/docker-compose.yml`
- `deploy/nas/docker-compose.test.yml`
- `deploy/nas/.env.example`
- `deploy/nas/install.sh`
- `deploy/nas/README.md`
- `tests/distributed/nas-deploy.test.ts`
- `docs/runbooks/nas-deploy.md`

**修改文件：**
- `package.json`（添加 `docker:nas` 脚本）

**未修改：**
- `src/`、`web/`、`.biao/`、既有测试、其他配置
