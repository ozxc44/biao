#!/usr/bin/env bash
# 多 agent demo 通用执行脚本
# 参数：$1=task_id, $2=goal_md_file, $3=work_dir
set -e
TASK_ID="$1"
GOAL_FILE="$2"
WORK_DIR="$3"
PROJECT="/tmp/biao-multi-agent-demo"
mkdir -p "$PROJECT/src"

echo "[demo-exec] task=$TASK_ID"

case "$TASK_ID" in
  demo-01-a)
    echo "module A done by agent" > "$PROJECT/src/module-a.txt"
    echo "[demo-exec] wrote module-a.txt"
    ;;
  demo-02-b)
    echo "module B done by agent" > "$PROJECT/src/module-b.txt"
    echo "[demo-exec] wrote module-b.txt"
    ;;
  demo-03-c)
    echo "module C done by agent" > "$PROJECT/src/module-c.txt"
    echo "[demo-exec] wrote module-c.txt"
    ;;
  demo-04-merge)
    {
      cat "$PROJECT/src/module-a.txt"
      cat "$PROJECT/src/module-b.txt"
      cat "$PROJECT/src/module-c.txt"
    } > "$PROJECT/src/summary.txt"
    echo "[demo-exec] wrote summary.txt"
    ;;
  *)
    echo "[demo-exec] 未知 task_id: $TASK_ID"
    exit 1
    ;;
esac
echo "[demo-exec] done"
