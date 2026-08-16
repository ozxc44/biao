# P12：核心功能补全（真实harness + 状态同步 + attempt API + daemon集成）

## 背景
跨机联调已跑通但 Worker 执行的是模拟代码。P12 让跨机链路从"演示级"升级为"生产级"。基线 135/1709 全绿。

## 目标

### 1. 真实 Harness 执行器
- `.25` 上的 Worker 收到任务后不再写模拟文件，而是真正执行代码修改
- `src/node/real-executor.ts` 的 execute 阶段：读取 task 的 goal_md → 在 workspace 中执行 → 修改代码文件
- 执行方式：调用 `biao-exec` 命令（可配置：`codex exec` / `kimi -p` / `claude -p` / 自定义 shell 命令）
- Workspace prepare → git clone 最新代码 → 在分支上修改 → finalize（commit + push）→ report

### 2. Redis/SQLite 状态同步
- `reportV2WithArtifacts`（V2 report）完成后，同步更新 Redis 中的任务状态
- 在 `src/server/v2/routes/v2-routes.ts` 的 report 路由中，成功后调 V1 的 task hash 更新

### 3. Attempt 清理 API
- `POST /v2/attempts/:attempt_id/cancel`（bva2 或 owner）→ attempt 状态改 cancelled → task 回 pending
- 路由注册 + 测试

### 4. Worker daemon 集成轮询
- 把 `worker-loop.mjs` 的任务发现逻辑集成到 `src/node/daemon.ts` 的 claim tick 中
- daemon 在 running 状态下每 tick 自动调 V2 claim（带 bvn2）→ 领到 → 调 RealExecutor → report

## 约束
- 所有权：`src/node/**`、`src/server/v2/routes/v2-routes.ts`（report 同步）、新测试文件
- 四条验证原始输出

## 验收
- 全量不劣化 + 跨机真实执行实测（.25 上修改代码→push→NAS 收到变更）
