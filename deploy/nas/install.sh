#!/usr/bin/env bash
# Biao V2 NAS 119 一键部署（幂等）
# 用法：./install.sh [--build-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_ROOT="/data_n004/biao"
ENV_FILE="$SCRIPT_DIR/.env"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[biao]${NC} $*"; }
warn()  { echo -e "${YELLOW}[biao]${NC} $*"; }
error() { echo -e "${RED}[biao]${NC} $*" >&2; }

# ─── 检查依赖 ──────────────────────────────────────────────────────
check_deps() {
    local missing=()
    command -v docker >/dev/null 2>&1 || missing+=("docker")
    docker compose version >/dev/null 2>&1 || missing+=("docker-compose-plugin")

    if [ ${#missing[@]} -gt 0 ]; then
        error "缺少依赖：${missing[*]}"
        exit 1
    fi

    # 检查当前用户是否在 docker 组或有 sudo 权限
    if ! docker info >/dev/null 2>&1; then
        if command -v sudo >/dev/null 2>&1; then
            warn "当前用户无 docker 权限，将使用 sudo"
            DOCKER_CMD="sudo docker"
        else
            error "无 docker 权限且无 sudo，请将用户加入 docker 组"
            exit 1
        fi
    else
        DOCKER_CMD="docker"
    fi
}

# ─── 创建数据目录 ──────────────────────────────────────────────────
setup_data_dirs() {
    info "创建数据目录..."
    local dirs=(
        "$DATA_ROOT/docker/redis-data"
        "$DATA_ROOT/docker/biao-data"
    )
    for dir in "${dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir"
            info "  创建：$dir"
        fi
    done
}

# ─── 生成 .env ──────────────────────────────────────────────────────
generate_env() {
    if [ -f "$ENV_FILE" ]; then
        info ".env 已存在，跳过生成"
        return
    fi

    info "生成 .env（含随机 token）..."
    local api_token
    local credential_key
    api_token="$(openssl rand -hex 48)"
    credential_key="$(openssl rand -hex 48)"

    cat > "$ENV_FILE" <<EOF
# Biao V2 NAS 部署配置
# 生成时间：$(date -Iseconds)

# API 认证 token（Worker 连接时使用）
BIAO_API_TOKEN=$api_token

# V2 凭据加密密钥
BIAO_V2_CREDENTIAL_KEY=$credential_key

# V2 feature flags（默认全关，按 §23.1 顺序开启）
BIAO_DISTRIBUTED_MODE=0
BIAO_V2_ARTIFACTS=0
BIAO_V2_NODE_RUNTIME=0
BIAO_V2_GIT_DELIVERY=0
BIAO_V2_MERGE_QUEUE=0
EOF

    chmod 600 "$ENV_FILE"
    info ".env 已生成并设置权限 600"
    warn "请妥善保管 .env 中的 token，不会再次显示"
}

# ─── 构建并启动 ──────────────────────────────────────────────────────
deploy() {
    info "构建 Docker 镜像（linux/amd64）..."
    cd "$SCRIPT_DIR"
    $DOCKER_CMD compose build

    info "启动服务..."
    $DOCKER_CMD compose up -d

    info "等待健康检查..."
    local max_wait=60
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if curl -sf http://127.0.0.1:7331/health >/dev/null 2>&1; then
            info "服务健康！"
            break
        fi
        sleep 2
        waited=$((waited + 2))
        echo -n "."
    done
    echo

    if [ $waited -ge $max_wait ]; then
        error "健康检查超时（${max_wait}s），请检查日志："
        error "  $DOCKER_CMD compose logs biao-server"
        exit 1
    fi
}

# ─── 打印部署信息 ──────────────────────────────────────────────────────
print_info() {
    echo
    info "========================================="
    info "  Biao V2 NAS 部署完成"
    info "========================================="
    echo
    info "服务地址：http://$(hostname -I | awk '{print $1}'):7331"
    info "健康检查：curl http://127.0.0.1:7331/health"
    info "版本信息：curl http://127.0.0.1:7331/version"
    echo
    info "获取 API Token："
    info "  grep BIAO_API_TOKEN $ENV_FILE | cut -d= -f2"
    echo
    info "Mac 连接方式："
    info "  BIAO_URL=http://192.168.31.119:7331"
    echo
    info "日志查看："
    info "  cd $SCRIPT_DIR && docker compose logs -f"
    echo
    info "停止服务："
    info "  cd $SCRIPT_DIR && docker compose down"
    echo
}

# ─── 主流程 ──────────────────────────────────────────────────────
main() {
    info "Biao V2 NAS 119 部署脚本"
    info "========================="
    echo

    check_deps
    setup_data_dirs
    generate_env

    if [ "${1:-}" = "--build-only" ]; then
        info "仅构建模式，不启动服务"
        cd "$SCRIPT_DIR"
        $DOCKER_CMD compose build
        info "构建完成"
        exit 0
    fi

    deploy
    print_info
}

main "$@"
