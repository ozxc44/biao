# NAS 119 x86_64 部署镜像（多阶段构建）
# 目标平台：linux/amd64（Mac build 需 --platform linux/amd64）

# ─── Stage 1: builder ───────────────────────────────────────────────
FROM node:22-slim AS builder

# better-sqlite3 原生编译依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
COPY scripts/copy-assets.mjs scripts/
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci && cd ..
COPY web/ web/

RUN npm run build

# ─── Stage 2: production dependencies only ──────────────────────────
FROM node:22-slim AS prod-deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm rebuild better-sqlite3

# ─── Stage 3: runtime ──────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# 非 root 用户
RUN groupadd -r biao && useradd -r -g biao -m biao

WORKDIR /app

# 生产依赖
COPY --from=prod-deps /app/node_modules ./node_modules

# 编译产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

# 包元数据（bin/scripts 引用）
COPY package.json ./
COPY bin/ bin/
COPY scripts/install.sh scripts/
COPY scripts/bootstrap.mjs scripts/
COPY scripts/redis-probe.mjs scripts/
COPY scripts/verify-package.mjs scripts/
COPY scripts/pm-agent.mjs scripts/
COPY scripts/codex-pm-agent.mjs scripts/
COPY scripts/adapter-kit.mjs scripts/
COPY scripts/worker-agent.mjs scripts/
COPY scripts/agent-join.mjs scripts/
COPY scripts/supervisor-config.mjs scripts/
COPY scripts/supervisor.mjs scripts/
COPY scripts/mcp-server.mjs scripts/

# 数据目录
RUN mkdir -p /data && chown biao:biao /data

# 健康检查（busybox wget 或 node）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:7331/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

ENV NODE_ENV=production
ENV BIAO_HOST=0.0.0.0
ENV BIAO_PORT=7331
# NAS compose 配置持久化：写死在镜像里，不依赖 compose env 覆盖
ENV BIAO_WORKSPACE_ROOTS=/data/workspaces

EXPOSE 7331

USER biao

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/main.js"]
