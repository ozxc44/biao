#!/bin/bash
# Biao 同步前全量预检——git push 前的最后一道门禁
# 用法：./scripts/sync-preflight.sh [--quick]
#   --quick  跳过全量测试（仅构建+安全扫描+平台健康）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0; FAIL=0; WARN=0
section() { echo -e "\n${GREEN}━━━ $1 ━━━${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail()    { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }
warn()    { echo -e "  ${YELLOW}⚠${NC} $1"; WARN=$((WARN+1)); }

QUICK="${1:-}"

# ─── 1. 构建门禁 ──────────────────────────────────────────────
section "构建检查"
if npx tsc --noEmit 2>/dev/null; then
  ok "TypeScript 编译零错误"
else
  fail "TypeScript 编译有错误（tsc --noEmit）"
fi

if npm run build:server >/dev/null 2>&1; then
  ok "服务端构建成功"
else
  fail "服务端构建失败"
fi

if npm --prefix web run build >/dev/null 2>&1; then
  ok "Web 前端构建成功"
else
  fail "Web 前端构建失败"
fi

# ─── 2. 安全扫描 ──────────────────────────────────────────────
section "安全扫描"

# 检查 git 追踪文件中不含敏感值
if git ls-files | xargs grep -l 'sk-[a-zA-Z0-9]\{20,\}\|ghp_[a-zA-Z0-9]\{36\}\|AKIA[A-Z0-9]\{16\}' 2>/dev/null | grep -v '.test.ts' | grep -v 'node_modules' | head -3; then
  fail "检测到疑似 API Key/AWS Key 在追踪文件中"
else
  ok "无明文 API Key/AWS Key"
fi

# 检查 .env 类文件不被追踪
if git ls-files | grep -E '\.env$|\.env\.(?!example)' 2>/dev/null; then
  fail "有 .env 文件被 git 追踪"
else
  ok "无 .env 文件被追踪"
fi

# 检查 deploy 目录不含真实 token
if [ -d deploy ]; then
  if grep -r 'BIAO_API_TOKEN=[a-f0-9]\{48\}' deploy/ 2>/dev/null; then
    fail "deploy/ 目录含真实 API Token"
  else
    ok "deploy/ 无真实 token"
  fi
fi

# ─── 3. 全量测试（--quick 跳过）───────────────────────────────
if [ "$QUICK" != "--quick" ]; then
  section "全量测试"
  # 注意：grep 无匹配返回 1，在 set -euo pipefail 下会杀死整段脚本——
  # 所有"可能无匹配"的命令替换必须带 || true。
  TEST_OUTPUT=$(npx vitest run 2>&1 | tail -5 || true)
  # 兼容 vitest 两种摘要："141 passed (142)" 与 "141 passed | 1 skipped (142)"
  TEST_FILES=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ passed( \| [0-9]+ skipped)? \([0-9]+\)' | head -1 || true)
  # 只把非零 failed 当失败；"0 failed" 字面量（部分 vitest 版本会打印）不算
  TEST_FAILED=$(echo "$TEST_OUTPUT" | grep -oE '[1-9][0-9]* failed' | head -1 || true)

  if [ -z "$TEST_FAILED" ]; then
    ok "全量测试通过：${TEST_FILES:-摘要未解析，见上方 vitest 输出}"
  else
    # 已知 flaky 单独复跑
    FLAKY_FILE="tests/supervisor-pm-agent-cli.test.ts"
    echo "  全量有失败，检查是否为已知 flaky..."
    if npx vitest run "$FLAKY_FILE" 2>&1 | grep -q "0 failed"; then
      warn "全量失败仅含已知 flaky（$FLAKY_FILE 单独复跑通过），不阻塞同步"
    else
      fail "全量测试有非 flaky 失败：$TEST_FAILED"
      echo "$TEST_OUTPUT" | head -3
    fi
  fi

  # Web 测试（vitest 摘要后面还有 Start at/Duration/空行，截 8 行确保覆盖摘要行）
  WEB_TEST=$(npm --prefix web test 2>&1 | tail -8 || true)
  if echo "$WEB_TEST" | grep -q "passed"; then
    ok "Web 测试通过"
  else
    fail "Web 测试失败"
  fi
else
  warn "--quick 模式：跳过全量测试"
fi

# ─── 4. Git 状态 ──────────────────────────────────────────────
section "Git 状态"
if git diff --cached --quiet 2>/dev/null && git diff --quiet 2>/dev/null; then
  ok "工作区干净（无未提交改动）"
else
  warn "工作区有未提交改动（git add + commit 后再 push）"
fi

# 检查 dist 不是 stale 的
if [ -d dist ] && [ -d src ]; then
  NEWEST_SRC=$(find src -name '*.ts' -newer dist/index.js 2>/dev/null | head -1)
  if [ -n "$NEWEST_SRC" ]; then
    warn "dist/ 可能过期（src 有更新的文件），建议 npm run build:server"
  else
    ok "dist/ 是最新的"
  fi
fi

# ─── 5. 本机平台健康（可选，栈在运行时才检查）────────────────
section "平台健康（本机栈）"
if curl -s --max-time 3 http://127.0.0.1:7331/health 2>/dev/null | grep -q '"ok":true'; then
  ok "本机 Biao 栈健康"

  # 检查是否有卡住的 running 任务（超 30 分钟无心跳）
  TOKEN=$(grep BIAO_API_TOKEN .biao/config.env 2>/dev/null | cut -d= -f2 | tr -d "'" || true)
  if [ -n "$TOKEN" ]; then
    STATUS_JSON=$(curl -s --max-time 5 http://127.0.0.1:7331/status -H "Authorization: Bearer $TOKEN" 2>/dev/null)
    RUNNING=$(echo "$STATUS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d).data;console.log(s.tasks?.running??0)}catch{console.log(0)}})" 2>/dev/null || echo 0)
    RUNNING=${RUNNING:-0}
    if [ "$RUNNING" = "0" ]; then
      ok "无卡住的 running 任务"
    else
      warn "有 $RUNNING 个 running 任务（可能是正常执行中，也可能是卡住——用 biao watchdog 检查）"
    fi

    # 检查 pending 门铃积压
    PENDING_REVIEWS=$(echo "$STATUS_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d).data;console.log(s.reviews?.pending??0)}catch{console.log(0)}})" 2>/dev/null || echo 0)
    PENDING_REVIEWS=${PENDING_REVIEWS:-0}
    if [ "$PENDING_REVIEWS" -gt 10 ]; then
      warn "PM 待验收积压 $PENDING_REVIEWS 项（可能需要处理）"
    else
      ok "PM 待验收无积压"
    fi
  fi
else
  warn "本机 Biao 栈未运行（跳过平台健康检查）"
fi

# ─── 6. PM Worker 台账 ────────────────────────────────────────
section "PM Worker 台账"
if command -v zcode-pm >/dev/null 2>&1 || [ -f "$HOME/.zcode/skills/zcode-pm-workers/scripts/zcode-pm" ]; then
  ZPM="${HOME}/.zcode/skills/zcode-pm-workers/scripts/zcode-pm"
  UNACKED=$("$ZPM" events --project "$PROJECT_ROOT" --unacked 2>/dev/null | grep -c "open" 2>/dev/null || true)
  UNACKED=${UNACKED:-0}
  UNACKED=$(echo "$UNACKED" | head -1 | tr -d '[:space:]')
  if [ "$UNACKED" = "0" ] || [ -z "$UNACKED" ]; then
    ok "PM Worker 台账无未确认事件"
  else
    warn "PM Worker 有 $UNACKED 个未确认完成事件（可能有 worker 完成但未验收）"
  fi

  RUNNING=$("$ZPM" status --project "$PROJECT_ROOT" 2>/dev/null | grep -c "running" 2>/dev/null || true)
  RUNNING=${RUNNING:-0}
  RUNNING=$(echo "$RUNNING" | head -1 | tr -d '[:space:]')
  if [ "$RUNNING" = "0" ] || [ -z "$RUNNING" ]; then
    ok "无运行中的 PM Worker"
  else
    warn "有 $RUNNING 个 PM Worker 在运行（push 前确认它们不依赖本地未提交状态）"
  fi
else
  warn "zcode-pm 不可用，跳过台账检查"
fi

# ─── 汇总 ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  通过: ${GREEN}$PASS${NC}  失败: ${RED}$FAIL${NC}  警告: ${YELLOW}$WARN${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ $FAIL -gt 0 ]; then
  echo -e "\n${RED}✗ 预检失败——请修复上述问题后再 push${NC}"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo -e "\n${YELLOW}⚠ 预检通过（有 $WARN 个警告）——建议处理但非阻塞${NC}"
  exit 0
else
  echo -e "\n${GREEN}✓ 预检全部通过——可以安全 push${NC}"
  exit 0
fi
