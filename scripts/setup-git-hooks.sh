#!/bin/bash
# 安装 Biao git hooks——pre-push 自动跑同步预检
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
HOOK_FILE="$HOOKS_DIR/pre-push"

echo "[biao] 安装 pre-push hook..."

mkdir -p "$HOOKS_DIR"

cat > "$HOOK_FILE" << 'HOOK'
#!/bin/bash
# Biao pre-push gate——全量预检（构建+安全+测试+平台健康）
# 紧急跳过：git push --no-verify
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../scripts" && pwd)"
echo "[biao] pre-push: 运行同步预检..."
bash "$SCRIPT_DIR/sync-preflight.sh" --quick
echo "[biao] pre-push: 预检通过 ✓"
HOOK

chmod +x "$HOOK_FILE"
echo "[biao] ✓ pre-push hook 已安装到 $HOOK_FILE"
echo ""
echo "  正常 push：自动跑 --quick 预检（构建+安全扫描+git 状态）"
echo "  全量预检：手动执行 ./scripts/sync-preflight.sh（含全量测试）"
echo "  紧急跳过：git push --no-verify"
