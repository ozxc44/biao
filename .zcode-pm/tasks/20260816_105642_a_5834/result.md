我来执行这个 NAS 119 Docker 化部署任务。先探索项目结构，然后创建所有部署文件。
Let me check the feature flags and existing docs structure.
Now I have a clear picture. Let me create all the deployment files in parallel.
Now let me verify the Docker setup and run local tests.
Docker 不可用，让我验证配置文件语法和项目结构。
All files created successfully. Let me write the delivery summary to the task ledger.
## 任务完成

NAS 119 Docker 化部署文件已全部创建。

### 交付物清单

| 文件 | 说明 |
|------|------|
| `deploy/nas/Dockerfile` | 多阶段构建（builder → prod-deps → runtime） |
| `deploy/nas/docker-compose.yml` | 双服务：biao-redis + biao-server |
| `deploy/nas/docker-compose.test.yml` | 测试配置覆盖 |
| `deploy/nas/.env.example` | 环境变量模板 |
| `deploy/nas/install.sh` | 一键部署脚本（幂等） |
| `deploy/nas/README.md` | 中文部署指南 |
| `tests/distributed/nas-deploy.test.ts` | E2E 测试 |
| `docs/runbooks/nas-deploy.md` | 运维手册 |
| `package.json` | 添加 `docker:nas` 脚本 |

### 关键设计

- **Redis AOF 默认开启**（避免数据丢失）
- **数据卷 bind mount** 到 `/data_n004` 大盘
- **V2 Feature Flags 默认全关**，按 §23.1 顺序灰度
- **非 root 用户**运行容器
- **健康检查** 30s 间隔，3 次重试

### 残留风险

1. **Docker 环境未验证** - Mac 未安装 Docker，无法本地构建测试
2. **真机部署未执行** - 需 PM 带凭据执行部署命令
3. **V2 Feature Flags 未测试** - 需真机灰度验证

### PM 后续步骤

1. 按 `deploy/nas/README.md` 上传仓库并执行 `install.sh`
2. 验证 `curl http://192.168.31.119:7331/health`
3. 获取 API Token 后配置 Mac 端连接
4. 按 §23.1 顺序逐面开启 V2 Feature Flags

详细交付报告：`.zcode-pm/tasks/20260816_105642_a_5834/delivery.md`