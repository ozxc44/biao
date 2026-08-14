# 真实 Harness 端到端验收剧本（发布前）

自动化测试（`npm test`）的执行器全部是 mock/内联 stub；它们证明的是**平台协议与状态机**
正确。发布前还需要用**真实 harness** 走一遍完整交付闭环，证明接入层（spawn、prompt、
stdout 解析、Verify、report、PM 验收）在真实模型下可用。

> 实测记录（2026-08-15）：本剧本已用真实 `kimi` CLI（0.29.2，kimi-code/k3）完整执行
> 通过——领取 → 真实改写仓库 → 逐项 Verify → report done → PM accept → plan
> completed → Supervisor 干净退出，全部通过标准满足。剧本不绑定 codex：`kind: codex`
> 换成 `kind: kimi`（或任意 `custom` 执行器）同样适用。GUI-only 的 harness（无无头
> CLI/API 入口）无法作为 Worker 自动执行，参见 [陌生 Agent 接入包](agent-adapter-kit.md)
> 的边界说明。

本剧本验证接入链路，不评审模型能力。全程使用隔离的端口 / Redis DB / SQLite / 工作区，
不触碰生产运行库。

## 前置条件

1. `codex --version` 可用且已登录（`.biao/doctor` 通过）；
2. Redis 本机可达；Node 在支持范围；
3. 一个空的临时工作区目录。

## 步骤

### 1. 隔离环境启动服务

```bash
export E2E_ROOT=$(mktemp -d /tmp/biao-e2e.XXXXXX)
mkdir -p "$E2E_ROOT/ws/proj" && cd "$E2E_ROOT/ws/proj" && git init -q .
cd <biao 仓库根目录>
BIAO_PORT=7391 BIAO_HOST=127.0.0.1 \
BIAO_REDIS_URL=redis://127.0.0.1:6379/14 \
BIAO_SQLITE_PATH="$E2E_ROOT/biao.sqlite" \
BIAO_WORKSPACE_ROOTS="$E2E_ROOT/ws" \
node dist/server/main.js > "$E2E_ROOT/server.log" 2>&1 &
echo $! > "$E2E_ROOT/server.pid"
```

### 2. 提交一个带真实 Verify 的最小计划

```bash
BIAO_URL=http://127.0.0.1:7391 node bin/biao.js plan init e2e-real \
  --project "$E2E_ROOT/ws/proj" --dir "$E2E_ROOT/ws/plans"
```

编辑 `tasks/e2e-real-01-impl.md`：目标写"在项目根创建 hello.txt，内容为 ok"，
verify 使用 `cmd: cat hello.txt`（`expect_exit: 0`）。删除 `*-02-qa.md` 并从
`index.md` 表中移除该行，然后：

```bash
BIAO_URL=http://127.0.0.1:7391 node bin/biao.js plan submit "$E2E_ROOT/ws/plans/e2e-real"
```

### 3. 用真实 codex slot 执行

```bash
BIAO_WORKER_SLOTS='[{"kind":"codex","agentId":"e2e-codex","project":"'"$E2E_ROOT"'/ws/proj","types":["code"]}]' \
node scripts/supervisor.mjs --biao-url http://127.0.0.1:7391 --consumer e2e-pm --interval 10 \
  > "$E2E_ROOT/sup.log" 2>&1 &
echo $! > "$E2E_ROOT/sup.pid"
```

观察 `$E2E_ROOT/sup.log`：应出现 `领取任务：e2e-real-01-impl` → 真实 `codex exec`
子进程 → `✓ done`。Verify 由平台强制执行并逐项回传。

### 4. PM 验收

```bash
BIAO_URL=http://127.0.0.1:7391 node bin/biao.js review list
BIAO_URL=http://127.0.0.1:7391 node bin/biao.js review e2e-real-01-impl   # 读证据
BIAO_URL=http://127.0.0.1:7391 node bin/biao.js review e2e-real-01-impl \
  --accept --comment "真实 harness e2e 通过"
```

### 5. 通过标准（checklist）

- [ ] `hello.txt` 真实生成且内容为 `ok`（执行器真改了仓库）；
- [ ] `review` 证据包含逐项 Verify 输出；
- [ ] accept 后 `plan status e2e-real` 为 completed；
- [ ] Supervisor 打印"所有受管项目已完成并验收，已停止监视"并退出；
- [ ] `$E2E_ROOT/ws/proj/work/e2e-real-01-impl/` 下有 result.md / result.json；
- [ ] `db status` 无异常；`events` 中 review_requested → ack 链路完整。

### 6. 清理

```bash
kill $(cat "$E2E_ROOT/sup.pid") $(cat "$E2E_ROOT/server.pid") 2>/dev/null
redis-cli -u redis://127.0.0.1:6379/14 flushdb
rm -rf "$E2E_ROOT"
```

## 失败排查

- **codex 未登录/超时**：`.biao/doctor`；检查 sup.log 中子进程 stderr；
- **任务 failed 且生成 repair**：这是平台预期行为；读 `task get` 与 repair 的
  failure_reason 判断是 prompt 问题还是接入问题；
- **Verify 失败**：确认 verify cmd 在项目目录下可执行、退出码符合 expect_exit。
