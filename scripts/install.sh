#!/usr/bin/env bash
# Biao CLI 安装脚本（由 biao serve 的 GET /install 返回）
# BIAO_PKG 的值由服务端按 POSIX shell 数据规则注入（biao 包的实际绝对路径）
set -e
BIN_DIR="${BIAO_BIN_DIR:-${HOME}/.local/bin}"
BIAO_PKG=__BIAO_PKG_POSIX__

mkdir -p "$BIN_DIR"

echo "[biao] Installing CLI to $BIN_DIR"

# 创建 symlink（bootstrap / biao / biao-worker / 各 agent worker）
ln -sf "$BIAO_PKG/bin/biao-bootstrap.js" "$BIN_DIR/biao-bootstrap"
ln -sf "$BIAO_PKG/bin/biao-adapter-kit.js" "$BIN_DIR/biao-adapter-kit"
ln -sf "$BIAO_PKG/bin/biao-worker-agent.js" "$BIN_DIR/biao-worker-agent"
ln -sf "$BIAO_PKG/bin/biao-supervisor-config.js" "$BIN_DIR/biao-supervisor-config"
ln -sf "$BIAO_PKG/bin/biao.js" "$BIN_DIR/biao"
ln -sf "$BIAO_PKG/bin/biao-worker.js" "$BIN_DIR/biao-worker"
ln -sf "$BIAO_PKG/bin/cli-worker.js" "$BIN_DIR/cli-worker"
ln -sf "$BIAO_PKG/bin/codex-worker.js" "$BIN_DIR/codex-worker"
ln -sf "$BIAO_PKG/bin/kimi-worker.js" "$BIN_DIR/kimi-worker"

chmod +x "$BIAO_PKG/bin/"*.js

# 验证
if command -v biao > /dev/null 2>&1; then
  echo "[biao] OK: installed at $(which biao)"
  echo "[biao] Try: biao health"
else
  echo "[biao] Installed, but $BIN_DIR is not in PATH. Add it with:"
  echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc"
  echo "  source ~/.zshrc"
fi
