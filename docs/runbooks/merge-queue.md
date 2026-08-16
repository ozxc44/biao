# Merge Queue 运维手册

## 概述

Merge Queue 是 Biao 分布式多节点协同的合并队列（Phase 5），对应方案 §12。

核心职责：
- 单项目串行队列：同 project 同时最多一个 running merge job
- 默认分支 CAS：merge 前校验 HEAD == expected_target_sha
- Integration workspace：fetch + merge --no-ff + 冲突检测
- 降级/恢复：连续失败 → write_capability_status=lost → 人工恢复

## 队列状态机

```
queued → running → merged
                 → conflict（delivery 保持 accepted，可重新交付）
                 → integration_failed（检查降级阈值）
                 → cancelled（人工取消）
                 → invalidated（CAS 失败：默认分支已前移）
```

### 状态说明

| 状态 | 含义 | 后续动作 |
|------|------|----------|
| `queued` | 等待 dispatch | 按 FIFO 顺序取队头执行 |
| `running` | 正在执行 merge | 完成后转 merged/conflict/integration_failed |
| `merged` | 合并成功 | delivery → merged，下游解锁，BranchCleanup 排程 |
| `conflict` | 文件冲突 | delivery 保持 accepted，冲突文件清单入审计 |
| `integration_failed` | 执行失败 | 检查降级阈值，可重试 |
| `cancelled` | 人工取消 | 不可恢复，需创建新 job |
| `invalidated` | CAS 失败 | delivery → invalidated，需用新 HEAD 重新入队 |

## CAS 失败 → 重排队生命周期

1. 入队时记录 `expected_target_sha`（当前默认分支 HEAD）
2. dispatch 时再次 `ls-remote` 校验 HEAD
3. 若 HEAD ≠ expected_target_sha：
   - job → `invalidated`（cancel_reason=target-advanced）
   - delivery → `invalidated`（invalidated_reason=branch-head-changed）
   - 需要创建新 delivery（rebase 后）并用新 HEAD 重新入队

## 降级阈值与恢复

### 降级条件

连续 `MERGE_DEGRADE_FAILURE_THRESHOLD`（默认 3）次 `integration_failed` 后：
- `write_capability_status` → `lost`
- 新 claim 和 merge 被阻止

### 恢复流程

1. 确认根因（查看 merge job 的 error_message）
2. 修复问题（冲突 resolution、远程 ACL 等）
3. 调用 `POST /v2/projects/:id/write-capability/restore`
4. `write_capability_status` → `ready`

### 相关 API

```
POST /v2/projects/:id/write-capability/restore
  → { restored: true }
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v2/merge-jobs` | 入队（需 expected_target_sha） |
| GET | `/v2/merge-jobs/:id` | 查询 merge job |
| POST | `/v2/merge-jobs/:id/cancel` | 取消 |
| POST | `/v2/merge-jobs/:id/retry` | 重试（integration_failed/conflict） |
| GET | `/v2/projects/:id/merge-jobs` | 队列视图 |
| POST | `/v2/merge-jobs/external-intents` | 登记外部合并意图 |
| POST | `/v2/merge-jobs/external-intents/:id/reconcile` | 外部意图对账 |
| POST | `/v2/projects/:id/write-capability/restore` | 恢复写能力 |

## 与 BranchCleanup 的衔接

- merged delivery 的 branch 会自动创建 BranchCleanup 记录
- 保留期 30 天后由 `runDueBranchCleanups()` 执行删除
- 删除前再次校验远端 HEAD，不匹配则失败留审计

## 数据库表

### merge_jobs

```sql
CREATE TABLE merge_jobs (
  merge_job_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  expected_target_sha TEXT NOT NULL,
  source_sha TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'merge-ff',
  status TEXT NOT NULL DEFAULT 'queued',
  final_sha TEXT,
  cancel_reason TEXT,
  conflict_files TEXT DEFAULT '[]',
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- 唯一约束
UNIQUE (delivery_id, expected_target_sha)  -- 幂等键
UNIQUE (project_id) WHERE status = 'running'  -- 同项目最多一个 running
```

## 故障排查

### merge job 卡在 queued

- 检查是否有 running job（同 project 串行）
- 检查项目 write_capability_status 是否为 lost/disabled

### merge job invalidated

- 默认分支已被外部推进
- 检查 expected_target_sha vs 当前 HEAD
- 需要创建新 delivery 并用新 HEAD 重新入队

### merge job integration_failed

- 查看 error_message 获取详细错误
- 常见原因：git 操作失败、push 被拒、delivery 记录缺失
- 连续失败 3 次会触发降级

### 项目降级为 lost

- 连续 3 次 integration_failed
- 需要人工确认根因后调用 restore API
- 恢复前检查 merge_jobs 表中的失败记录
