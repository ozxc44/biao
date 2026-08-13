#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AUTO_YES=0
CHECK_ONLY=0
REDIS_URL=${BIAO_REDIS_URL:-redis://127.0.0.1:6379}
PREVIOUS_ARG=
BOOTSTRAP_TOKEN_PRESENT=0
BOOTSTRAP_TOKEN_VALUE=
if [ "${BIAO_BOOTSTRAP_TOKEN+x}" = x ]; then
  BOOTSTRAP_TOKEN_PRESENT=1
  BOOTSTRAP_TOKEN_VALUE=$BIAO_BOOTSTRAP_TOKEN
fi
# 系统检测、包管理器、Redis 与 npm 子进程都不应继承控制面凭据。
unset BIAO_BOOTSTRAP_TOKEN BIAO_API_TOKEN

show_help() {
  cat <<'EOF'
Biao 开箱配置

用法：
  ./bootstrap.sh --yes --workspace <允许根目录> [--project <默认项目>]

选项：
  --workspace <path>   Biao 允许访问的工作区；默认当前 Biao 仓库
  --project <path>     Worker 默认领取的项目；默认等于 workspace
  --runtime-dir <path> 可变配置与数据目录；安装包默认当前目录/.biao
  --redis-url <url>    默认 redis://127.0.0.1:6379
  --host <host>        默认 127.0.0.1
  --port <port>        默认 7331
  --token-file <path>  从权限为 owner-only（例如 600）的文件读取已有 Token
  --pm-agent-command <command>
                       PM 待办出现时由共享 Supervisor 按需启动的本机 Agent 命令
  --pm-agent codex     使用仓库内置 Codex PM 适配器；不能与 --pm-agent-command 同用
  --yes, -y            允许 shell 入口安装缺失系统依赖并启动本机 Redis
  --check              仅检查 Node、npm、Redis 工具与连通性；绝不安装、构建或写配置
  --no-install         跳过 npm 依赖安装
  --no-build           跳过 npm run build
  --force              覆盖已有 .biao 配置
  --upgrade            保留已有 config.env，只更新仓库生成的启动器与 PM 手册

也可由秘密管理器注入 BIAO_BOOTSTRAP_TOKEN。不要把 Token 写进 argv 或 Shell 历史。
EOF
}

# 帮助必须在任何系统依赖探测前可用；同时跳过已知 option 的参数值，避免把路径值误判为帮助。
HELP_VALUE_PENDING=0
for ARG in "$@"; do
  if [ "$HELP_VALUE_PENDING" -eq 1 ]; then
    HELP_VALUE_PENDING=0
    continue
  fi
  case "$ARG" in
    --workspace|--project|--runtime-dir|--redis-url|--host|--port|--token-file|--pm-agent-command|--pm-agent)
      HELP_VALUE_PENDING=1
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
  esac
done

exec_bootstrap_node() {
  if [ "$BOOTSTRAP_TOKEN_PRESENT" -eq 1 ]; then
    BIAO_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN_VALUE exec node "$ROOT_DIR/scripts/bootstrap.mjs" "$@"
  fi
  exec node "$ROOT_DIR/scripts/bootstrap.mjs" "$@"
}

for ARG in "$@"; do
  if [ "$PREVIOUS_ARG" = "--redis-url" ]; then
    REDIS_URL=$ARG
    PREVIOUS_ARG=
    continue
  fi
  case "$ARG" in
    --yes|-y) AUTO_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --redis-url) PREVIOUS_ARG=--redis-url ;;
    --redis-url=*) REDIS_URL=${ARG#--redis-url=} ;;
  esac
done

case "$REDIS_URL" in
  redis://127.0.0.1|redis://localhost|redis://127.0.0.1:*|redis://localhost:*|redis://127.0.0.1/*|redis://localhost/*)
    REDIS_IS_LOCAL=1
    ;;
  *) REDIS_IS_LOCAL=0 ;;
esac

node_is_ready() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  NODE_VERSION=$(node -p "process.versions.node" 2>/dev/null || echo 0.0.0)
  OLD_IFS=$IFS
  IFS=.
  set -- $NODE_VERSION
  IFS=$OLD_IFS
  NODE_MAJOR=${1:-0}
  NODE_MINOR=${2:-0}
  [ "$NODE_MAJOR" -gt 22 ] ||
    { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 12 ]; } ||
    { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 19 ]; }
}

redis_tools_are_ready() {
  command -v redis-cli >/dev/null 2>&1 || return 1
  [ "$REDIS_IS_LOCAL" -eq 0 ] || command -v redis-server >/dev/null 2>&1
}

redis_is_reachable() {
  command -v redis-cli >/dev/null 2>&1 || return 1
  command -v node >/dev/null 2>&1 || return 1
  BIAO_REDIS_PROBE_URL=$REDIS_URL \
    node "$ROOT_DIR/scripts/redis-probe.mjs" >/dev/null 2>&1
}

NODE_WAS_MISSING=0
REDIS_WAS_MISSING=0
REDIS_WAS_DOWN=0

if node_is_ready; then
  echo "[ok] Node.js 20.19+ / 22.12+"
else
  NODE_WAS_MISSING=1
  echo "[missing] Node.js 20.19+ / 22.12+（同时需要 npm）"
fi

if redis_tools_are_ready; then
  if [ "$REDIS_IS_LOCAL" -eq 1 ]; then
    echo "[ok] Redis 命令行与服务端"
  else
    echo "[ok] Redis 客户端探测工具（远程地址无需本机服务端）"
  fi
else
  REDIS_WAS_MISSING=1
  echo "[missing] Redis"
fi

if redis_is_reachable; then
  echo "[ok] Redis 可连接"
else
  REDIS_WAS_DOWN=1
  echo "[unavailable] Redis 暂不可连接"
fi

if [ "$NODE_WAS_MISSING" -eq 0 ] && [ "$REDIS_WAS_MISSING" -eq 0 ] && [ "$REDIS_WAS_DOWN" -eq 0 ]; then
  if [ "$CHECK_ONLY" -eq 1 ] || [ "${BIAO_BOOTSTRAP_SYSTEM_ONLY:-0}" = "1" ]; then
    echo "[ok] 只读检查通过；未安装、构建或写入 .biao"
    exit 0
  fi
  exec_bootstrap_node "$@"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "只读检查未通过；未安装、启动服务、构建或写入 .biao。" >&2
  exit 2
fi

if [ "$AUTO_YES" -ne 1 ]; then
  echo "需要安装依赖或启动本机 Redis；确认后请重新运行并加 --yes。" >&2
  echo "示例：./bootstrap.sh --yes --workspace /path/to/workspace --project my-project" >&2
  exit 2
fi

OS_NAME=$(uname -s)

run_as_admin() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "安装需要管理员权限，但当前环境没有 sudo。请先由管理员安装依赖。" >&2
    exit 1
  fi
}

install_with_brew() {
  PACKAGE=$1
  if ! command -v brew >/dev/null 2>&1; then
    echo "未找到 Homebrew，无法自动安装 $PACKAGE。请先安装 Homebrew，或手动安装后重试。" >&2
    exit 1
  fi
  brew install "$PACKAGE"
}

install_linux_node() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_admin apt-get update
    run_as_admin apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    run_as_admin dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    run_as_admin yum install -y nodejs npm
  elif command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "未找到受支持的包管理器（apt、dnf、yum 或 Homebrew），请手动安装 Node.js 20.19+ / 22.12+。" >&2
    exit 1
  fi
}

install_linux_redis() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_admin apt-get update
    run_as_admin apt-get install -y redis-server redis-tools
  elif command -v dnf >/dev/null 2>&1; then
    run_as_admin dnf install -y redis
  elif command -v yum >/dev/null 2>&1; then
    run_as_admin yum install -y redis
  elif command -v brew >/dev/null 2>&1; then
    brew install redis
  else
    echo "未找到受支持的包管理器（apt、dnf、yum 或 Homebrew），请手动安装 Redis。" >&2
    exit 1
  fi
}

if [ "$NODE_WAS_MISSING" -eq 1 ]; then
  case "$OS_NAME" in
    Darwin) install_with_brew node ;;
    Linux) install_linux_node ;;
    *)
      echo "当前系统 $OS_NAME 不支持自动安装 Node.js；请手动安装 Node.js 20.19+ / 22.12+。" >&2
      exit 1
      ;;
  esac
  hash -r 2>/dev/null || true
  if ! node_is_ready; then
    echo "安装后仍未检测到 Node.js 20.19+ / 22.12+ 和 npm。系统包版本可能过旧，请升级后重试。" >&2
    exit 1
  fi
  echo "[installed] Node.js 20.19+ / 22.12+"
fi

if [ "$REDIS_WAS_MISSING" -eq 1 ] && [ "$REDIS_IS_LOCAL" -eq 0 ]; then
  echo "远程 Redis 只需要 redis-cli 作为安全探测客户端；为避免安装不需要的本机 redis-server，请先单独安装 redis-cli 后重试。" >&2
  exit 1
fi

if [ "$REDIS_WAS_MISSING" -eq 1 ]; then
  case "$OS_NAME" in
    Darwin) install_with_brew redis ;;
    Linux) install_linux_redis ;;
    *)
      echo "当前系统 $OS_NAME 不支持自动安装 Redis；请手动安装后重试。" >&2
      exit 1
      ;;
  esac
  hash -r 2>/dev/null || true
  if ! redis_tools_are_ready; then
    echo "安装后仍未检测到 redis-cli 和 redis-server，请检查包管理器输出。" >&2
    exit 1
  fi
  echo "[installed] Redis"
fi

if ! redis_is_reachable && [ "$REDIS_IS_LOCAL" -eq 1 ]; then
  echo "[start] 正在启动本机 Redis"
  if [ "$OS_NAME" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services start redis
  elif command -v systemctl >/dev/null 2>&1; then
    run_as_admin systemctl enable --now redis-server 2>/dev/null ||
      run_as_admin systemctl enable --now redis
  else
    redis-server --daemonize yes
  fi

  ATTEMPT=0
  while [ "$ATTEMPT" -lt 10 ] && ! redis_is_reachable; do
    sleep 1
    ATTEMPT=$((ATTEMPT + 1))
  done
fi

if ! redis_is_reachable; then
  echo "Redis 仍无法连接。若使用远程 Redis，请检查 --redis-url、认证和网络。" >&2
  exit 1
fi
echo "[ok] Redis 可连接"

if [ "${BIAO_BOOTSTRAP_SYSTEM_ONLY:-0}" = "1" ]; then
  exit 0
fi

exec_bootstrap_node "$@"
