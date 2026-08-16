# Biao V2 NAS 119 部署指南

## 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│  NAS 119 (192.168.31.119)                                   │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ agent-memory │    │  nas-gitea   │    │  biao-server │  │
│  │    :8910     │    │ :22022/:23000│    │    :7331     │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                            │                │
│                                     ┌──────────────┐        │
│                                     │  biao-redis  │        │
│                                     │   (内部)     │        │
│                                     └──────────────┘        │
│                                                             │
│  数据卷：/data_n004/biao/docker/                            │
│    ├── redis-data/     ← Redis AOF 持久化                   │
│    └── biao-data/      ← SQLite + artifacts                 │
└─────────────────────────────────────────────────────────────┘
```

## 首次安装

### 前置条件

- NAS 119 已安装 Docker 26.1.4+
- `/data_n004` 卷已挂载（1.8T）
- 端口 7331、6380 空闲

### 部署步骤

```bash
# 1. 上传仓库到 NAS
scp -r biao/ user@192.168.31.119:/data_n004/biao/src/

# 2. SSH 登录 NAS
ssh user@192.168.31.119

# 3. 执行部署
cd /data_n004/biao/src/deploy/nas
chmod +x install.sh
./install.sh

# 4. 验证
curl http://127.0.0.1:7331/health
curl http://127.0.0.1:7331/version
```

### 获取 API Token

```bash
grep BIAO_API_TOKEN /data_n004/biao/src/deploy/nas/.env | cut -d= -f2
```

## Mac 端连接

```bash
# 设置环境变量
export BIAO_URL=http://192.168.31.119:7331
export BIAO_API_TOKEN=<从 NAS 获取的 token>

# 测试连接
curl -H "Authorization: Bearer $BIAO_API_TOKEN" $BIAO_URL/health
```

## 升级

```bash
# 1. 拉取最新代码
cd /data_n004/biao/src
git pull

# 2. 重新构建并重启
cd deploy/nas
./install.sh

# 3. 验证
curl http://127.0.0.1:7331/version
```

## 备份

### 三件套备份

```bash
# 备份目录
BACKUP_DIR="/data_n004/biao/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 1. SQLite 数据库（在线备份）
cp /data_n004/biao/docker/biao-data/biao.sqlite "$BACKUP_DIR/"

# 2. Artifacts 目录
cp -r /data_n004/biao/docker/biao-data/artifacts "$BACKUP_DIR/"

# 3. 配置文件
cp /data_n004/biao/src/deploy/nas/.env "$BACKUP_DIR/"
```

### 自动备份（cron）

```bash
# 添加到 crontab
0 3 * * * /data_n004/biao/src/scripts/backup-biao.sh
```

## V2 Feature Flags 开启顺序

必须按依赖顺序开启（§23.1）：

```
BIAO_DISTRIBUTED_MODE → BIAO_V2_ARTIFACTS → BIAO_V2_NODE_RUNTIME → BIAO_V2_GIT_DELIVERY → BIAO_V2_MERGE_QUEUE
```

### 开启方式

编辑 `/data_n004/biao/src/deploy/nas/.env`：

```bash
# 第一步：开启分布式模式
BIAO_DISTRIBUTED_MODE=1

# 重启生效
cd /data_n004/biao/src/deploy/nas
docker compose restart biao-server

# 验证
curl http://127.0.0.1:7331/v2/feature-flags
```

### 关闭方式

按反序逐面收口：

```bash
# 先关 MERGE_QUEUE，再关 GIT_DELIVERY，依此类推
BIAO_V2_MERGE_QUEUE=0
# 重启
docker compose restart biao-server
# 验证关闭
curl http://127.0.0.1:7331/v2/feature-flags
```

## Gitea Git Remote 对接

Biao V2 的 Git Workspace 功能可以使用 NAS 上的 Gitea 作为远程仓库：

```bash
# 在 Biao 项目配置中设置 repository_url
# 格式：ssh://git@192.168.31.119:22022/<owner>/<repo>.git

# 示例：创建 Gitea 仓库后，在 Biao 中配置
curl -X POST http://192.168.31.119:7331/v2/projects \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "my-project",
    "repository_url": "ssh://git@192.168.31.119:22022/admin/my-project.git"
  }'
```

## 故障排查

### 查看日志

```bash
cd /data_n004/biao/src/deploy/nas
docker compose logs -f biao-server
docker compose logs -f biao-redis
```

### 检查 Redis AOF

```bash
docker exec biao-redis redis-cli CONFIG GET appendonly
# 应返回 "yes"
```

### 检查 SQLite 持久化

```bash
curl http://127.0.0.1:7331/db/status
```

### 重启服务

```bash
cd /data_n004/biao/src/deploy/nas
docker compose restart
```

### 完全重建

```bash
cd /data_n004/biao/src/deploy/nas
docker compose down
docker compose up -d --build
```

## 端口说明

| 服务 | 容器端口 | 宿主端口 | 说明 |
|------|----------|----------|------|
| biao-server | 7331 | 7331 | Biao API + Web |
| biao-redis | 6379 | - | 仅内部访问 |
| agent-memory-os | 8910 | 8910 | 已有，不冲突 |
| nas-gitea | 22022/23000 | 22022/23000 | 已有，不冲突 |

## 安全说明

- `.env` 文件权限 600，仅 owner 可读
- API Token 不会出现在日志或命令行参数中
- Redis 不暴露宿主端口，仅内部网络访问
- 非 root 用户运行容器
