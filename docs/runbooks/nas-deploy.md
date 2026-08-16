# NAS 119 Biao V2 运维手册

## 快速命令

```bash
# 进入部署目录
cd /data_n004/biao/src/deploy/nas

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 重新构建并启动
docker compose up -d --build
```

## 升级流程

### 标准升级

```bash
# 1. 备份（可选但推荐）
BACKUP_DIR="/data_n004/biao/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp /data_n004/biao/docker/biao-data/biao.sqlite "$BACKUP_DIR/"
cp -r /data_n004/biao/docker/biao-data/artifacts "$BACKUP_DIR/"
cp .env "$BACKUP_DIR/"

# 2. 拉取最新代码
cd /data_n004/biao/src
git pull

# 3. 重新构建
cd deploy/nas
docker compose build

# 4. 滚动更新（零停机）
docker compose up -d

# 5. 验证
curl http://127.0.0.1:7331/health
curl http://127.0.0.1:7331/version
```

### 回退

```bash
# 1. 停止当前版本
docker compose down

# 2. 切换到旧版本
cd /data_n004/biao/src
git checkout <old-commit-hash>

# 3. 重新构建并启动
cd deploy/nas
docker compose up -d --build

# 4. 验证
curl http://127.0.0.1:7331/health
```

## 备份三件套

### 手动备份

```bash
#!/bin/bash
# backup-biao.sh

BACKUP_DIR="/data_n004/biao/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "备份 SQLite..."
cp /data_n004/biao/docker/biao-data/biao.sqlite "$BACKUP_DIR/"

echo "备份 Artifacts..."
cp -r /data_n004/biao/docker/biao-data/artifacts "$BACKUP_DIR/"

echo "备份配置..."
cp /data_n004/biao/src/deploy/nas/.env "$BACKUP_DIR/"

echo "备份完成：$BACKUP_DIR"
ls -lh "$BACKUP_DIR"
```

### 自动备份（cron）

```bash
# 编辑 crontab
crontab -e

# 添加（每天凌晨 3 点备份）
0 3 * * * /data_n004/biao/src/scripts/backup-biao.sh >> /data_n004/biao/logs/backup.log 2>&1
```

### 恢复

```bash
# 1. 停止服务
cd /data_n004/biao/src/deploy/nas
docker compose down

# 2. 恢复文件
BACKUP_DIR="/data_n004/biao/backups/20260816_120000"  # 替换为实际备份目录
cp "$BACKUP_DIR/biao.sqlite" /data_n004/biao/docker/biao-data/
cp -r "$BACKUP_DIR/artifacts" /data_n004/biao/docker/biao-data/
cp "$BACKUP_DIR/.env" /data_n004/biao/src/deploy/nas/

# 3. 重启服务
docker compose up -d

# 4. 验证
curl http://127.0.0.1:7331/health
curl http://127.0.0.1:7331/db/status
```

## V2 Feature Flags 灰度

### 开启顺序（§23.1）

```
DISTRIBUTED_MODE → ARTIFACTS → NODE_RUNTIME → GIT_DELIVERY → MERGE_QUEUE
```

### 开启某面旗

```bash
# 1. 编辑 .env
vi /data_n004/biao/src/deploy/nas/.env

# 2. 修改目标旗（示例：开启 ARTIFACTS）
# BIAO_DISTRIBUTED_MODE=1  # 前置旗必须已开
# BIAO_V2_ARTIFACTS=1      # 目标旗

# 3. 重启服务
docker compose restart biao-server

# 4. 验证
curl http://127.0.0.1:7331/v2/feature-flags
```

### 关闭某面旗

```bash
# 1. 编辑 .env，将目标旗设为 0
# BIAO_V2_MERGE_QUEUE=0

# 2. 重启服务
docker compose restart biao-server

# 3. 验证
curl http://127.0.0.1:7331/v2/feature-flags
```

### 全部开启

```bash
# 编辑 .env
BIAO_DISTRIBUTED_MODE=1
BIAO_V2_ARTIFACTS=1
BIAO_V2_NODE_RUNTIME=1
BIAO_V2_GIT_DELIVERY=1
BIAO_V2_MERGE_QUEUE=1

# 重启
docker compose restart biao-server

# 验证
curl http://127.0.0.1:7331/v2/feature-flags
```

## 监控

### 健康检查

```bash
# 基础健康
curl http://127.0.0.1:7331/health

# 版本信息
curl http://127.0.0.1:7331/version

# 数据库状态
curl http://127.0.0.1:7331/db/status

# V2 功能状态
curl http://127.0.0.1:7331/v2/feature-flags
```

### Redis 状态

```bash
# 进入 Redis 容器
docker exec -it biao-redis redis-cli

# 检查 AOF
CONFIG GET appendonly

# 检查内存使用
INFO memory

# 检查连接数
INFO clients
```

### SQLite 状态

```bash
# 检查数据库文件大小
ls -lh /data_n004/biao/docker/biao-data/biao.sqlite

# 通过 API 检查
curl http://127.0.0.1:7331/db/status
```

## 故障排查

### 服务无法启动

```bash
# 查看日志
docker compose logs biao-server

# 常见原因：
# 1. 端口被占用
lsof -i :7331

# 2. 数据目录权限问题
ls -la /data_n004/biao/docker/

# 3. .env 配置错误
cat /data_n004/biao/src/deploy/nas/.env
```

### Redis 连接失败

```bash
# 检查 Redis 容器状态
docker compose ps biao-redis

# 查看 Redis 日志
docker compose logs biao-redis

# 测试连接
docker exec biao-redis redis-cli ping
```

### 数据丢失

```bash
# 检查 Redis AOF 是否启用
docker exec biao-redis redis-cli CONFIG GET appendonly

# 如果 AOF 未启用，启用它
docker exec biao-redis redis-cli CONFIG SET appendonly yes

# 检查 SQLite 持久化
curl http://127.0.0.1:7331/db/status
```

### 性能问题

```bash
# 检查容器资源使用
docker stats

# 检查 Redis 内存
docker exec biao-redis redis-cli INFO memory

# 检查 SQLite 大小
ls -lh /data_n004/biao/docker/biao-data/biao.sqlite
```

## 安全最佳实践

### 定期轮换 Token

```bash
# 1. 生成新 token
NEW_TOKEN=$(openssl rand -hex 48)

# 2. 更新 .env
sed -i "s/BIAO_API_TOKEN=.*/BIAO_API_TOKEN=$NEW_TOKEN/" .env

# 3. 重启服务
docker compose restart biao-server

# 4. 更新所有客户端配置
```

### 检查文件权限

```bash
# .env 应该是 600
ls -la .env

# 数据目录应该是 755
ls -la /data_n004/biao/docker/
```

## 日志管理

### 查看实时日志

```bash
# 所有服务
docker compose logs -f

# 特定服务
docker compose logs -f biao-server
docker compose logs -f biao-redis

# 最近 100 行
docker compose logs --tail 100 biao-server
```

### 日志轮转

Docker 默认会轮转日志。检查配置：

```bash
docker inspect biao-server --format='{{.HostConfig.LogConfig}}'
```

## 网络配置

### 端口映射

| 服务 | 容器端口 | 宿主端口 | 用途 |
|------|----------|----------|------|
| biao-server | 7331 | 7331 | API + Web |
| biao-redis | 6379 | - | 内部 |
| agent-memory-os | 8910 | 8910 | 已有 |
| nas-gitea | 22022 | 22022 | SSH |
| nas-gitea | 23000 | 23000 | HTTP |

### 防火墙

```bash
# 如果需要外部访问，确保开放 7331
sudo ufw allow 7331/tcp
```

## 紧急恢复

### 完全重建

```bash
# 1. 停止所有服务
docker compose down

# 2. 删除容器和镜像（保留数据卷）
docker system prune -f

# 3. 重新构建
docker compose up -d --build

# 4. 验证
curl http://127.0.0.1:7331/health
```

### 数据恢复

```bash
# 1. 停止服务
docker compose down

# 2. 从备份恢复
BACKUP_DIR="/data_n004/biao/backups/<latest>"
cp "$BACKUP_DIR/biao.sqlite" /data_n004/biao/docker/biao-data/
cp -r "$BACKUP_DIR/artifacts" /data_n004/biao/docker/biao-data/

# 3. 重启
docker compose up -d

# 4. 验证
curl http://127.0.0.1:7331/db/status
```
