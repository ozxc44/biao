# NAS 119 部署：Biao V2 局域网中央服务区（Docker 化）

## 背景

Biao 分布式多节点方案 v0.8.0 已全部实施验收（全量 132 文件/1646 用例全绿）。用户指令：**局域网 119（NAS）部署，作为服务区**——即方案 §3.2 的"中央 Biao 控制面 + 中央 Redis + SQLite + 内容寻址制品目录 + Git Remote（Gitea 已在 119:22022/23000）"。

## NAS 119 现状（PM 已勘察验证）

- 系统：Linux Z4Pro-G6C5 x86_64，16GB RAM（可用 ~10G）
- **Docker 26.1.4**（需 sudo；密码=登录密码，从 Mac Keychain `mac-nas`/`18950509383` 取，经 stdin 管道 `sudo -S -p ''`，**禁止 -tt**）
- 已有容器：agent-memory-os（8910）、nas-gitea（22022 SSH / 23000 HTTP）——不冲突
- **端口 7331、6380 空闲**；系统 redis-server 5.0.7 未运行（不用它，用容器）
- 部署目录：`/data_n004/biao`（1.8T 卷，已建）；docker 网络有 `nas_default`
- 无 node 系统安装（用容器镜像 node:22-slim）
- 系统盘 9.5G 已用 65%——**一切数据放 /data_n004**

## 部署方案（仓库交付物：`deploy/nas/`）

### 目标 1：仓库内交付部署物（本车道主要工作，全部新文件）

1. **`Dockerfile`**（deploy/nas/Dockerfile）：多阶段——builder 阶段 node:22-slim 装 better-sqlite3 原生依赖（python3 make g++）+ npm ci + npm run build；runtime 阶段 node:22-slim 只带 dist/web-dist/bin/scripts/node_modules(生产依赖)，非 root 用户 `biao`，健康检查 `node dist/server/main.js --health-port`？不行——用 `wget -qO- http://127.0.0.1:7331/health || exit 1`（busybox wget 或 node 一行）。
2. **`docker-compose.yml`**（deploy/nas/）：两个服务——`biao-redis`（redis:7-alpine，`--appendonly yes`（README 事故教训），卷 `redis-data:/data`，不暴露宿主端口，仅内网）+ `biao-server`（build Dockerfile，env：BIAO_HOST=0.0.0.0、BIAO_PORT=7331、BIAO_REDIS_URL=redis://biao-redis:6379、BIAO_DATA_DIR=/data（卷 `biao-data:/data`，SQLite+artifacts）、BIAO_API_TOKEN 与 BIAO_V2_CREDENTIAL_KEY 从 `.env` 文件读（模板 `.env.example` + 生成命令注释）、五个 V2 feature flag 默认全关（灰度按 §23.1 顺序开）），ports `7331:7331`，depends_on redis，restart unless-stopped；卷全部挂 `/data_n004/biao/docker/<name>`（named volume 用 bind 路径，保证落大盘）。
3. **`deploy/nas/install.sh`**：在 NAS 上执行的一键安装（幂等）：检查 docker/compose 权限→生成 .env（若缺：openssl rand hex 48×2，chmod 600）→ docker compose up -d --build→等待 health→打印 LAN 地址与 token 获取方式（不打印 token）。
4. **`deploy/nas/README.md`**（中文）：架构位（服务区 vs 节点）、首次安装/升级/备份（§23.3：SQLite 在线备份+artifact 目录+config 分开）、feature flag 开启顺序、从 Mac 端连接（BIAO_URL=http://192.168.31.119:7331）、Gitea 22022 作 Git Remote 的对接说明（project repository_url 填 `ssh://git@192.168.31.119:22022/...`）。
5. **`package.json` 补 `"docker:nas"` 脚本**（若一行可容纳：`docker build` 委托 install.sh）。

### 目标 2：本机验证（不依赖真实 NAS 的部分）

- `docker build` 在本机 Mac 成功（Apple Silicon 注意：NAS 是 x86_64，build 用 `--platform linux/amd64`，install.sh 内置）
- compose config 校验合法
- 用本机 docker 起一次完整栈（随机端口避让）：health 200、V1 `biao version` 连通、V2 `/version` 返回 protocol_version、feature-flags 全关、Redis AOF on（`redis-cli CONFIG GET appendonly`）、SQLite 落在卷内、重启容器数据保持（submit 一个 plan→restart→plan 仍在）
- 测试 `tests/distributed/nas-deploy.test.ts`：起 compose（test profile 隔离端口/卷）跑上述断言（CI 可跳过：`describe.skipIf(!process.env.NAS_DEPLOY_E2E)`）

### 目标 3：真机部署（NAS 119）

- 通过 PM 给出的 SSH 方式（Keychain+sshpass+stdin sudo）rsync/scp 仓库 tar 到 `/data_n004/biao/src/`→跑 install.sh→**验收：从 Mac `curl http://192.168.31.119:7331/health` 200 + V2 /version + feature-flags 端点 + redis AOF on + 重启持久化复验 + Gitea 可达**
- 不动 NAS 上既有容器（agent-memory-os、nas-gitea）；不占 8910/22022/23000

## 约束

- 全程中文；**仓库内所有权**：`deploy/nas/**`（新目录全部）、`package.json`（仅 scripts 一行）、`tests/distributed/nas-deploy.test.ts`、`docs/runbooks/nas-deploy.md`（中文运维：升级=git pull+rebuild、备份三件套、回退）。**不得改**：任何 src/、web/、既有测试、`.biao/`。
- 密码纪律：仓库内**绝不出现** NAS 密码/token 明文；install.sh 从 .env 读；文档用占位符。
- 真机部署步骤由本车道产出脚本+PM 执行（worker 不直接 SSH 到 NAS——凭据不出 Mac）。
- 四条验证原始输出随交付（含本机 docker 栈 E2E 输出摘要）。

## 验收标准

1. 本机：docker build（amd64）成功；compose 测试栈全断言绿（nas-deploy.test.ts 或手动等效证据）。
2. 交付物齐全（Dockerfile/compose/install.sh/README/runbook/test）。
3. 真机部署清单（PM 将执行的命令序列）写入交付说明，标注哪些需要 PM 在 Mac 上带凭据执行。
