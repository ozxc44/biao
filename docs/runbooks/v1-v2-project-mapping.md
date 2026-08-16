# V1 路径到 V2 Project 映射操作手册

本工具把 V1 `plans.project_path` / `tasks.project_path` 映射到已经由 Owner 创建的 V2
Project。映射身份只使用以下三项：

- 归一化的 `repository_url`（协议和凭据不参与身份）；
- remote fingerprint，即 `SHA-256(host/path)`；
- 明确的 default branch。

绝对路径只作为 `legacy_project_bindings` 的查找键，不参与 fingerprint 或 `project_id`
生成。工具不会创建 V2 Project，也不会开启 V2 claim。非 Git、Git 不可读、缺少
origin、无法确定 default branch、Project 缺失或 fingerprint 冲突都会 fail closed。

## 前置条件

1. 备份 SQLite 数据库。
2. Owner 先在 V2 Project registry 创建 Project；`project_id` 应为随机 ID，不能从路径或
   fingerprint 截断生成。
3. Project 的 `repository_url`、`repository_fingerprint` 和 `default_branch` 必须与仓库一致。
4. clone 应有 `refs/remotes/origin/HEAD`。离线且该引用缺失时，可在人工核对后设置显式值：

   ```bash
   git -C /exact/repository/path config biao.defaultBranch main
   ```

   工具不会把当前 checkout 分支猜成远端默认分支。

构建后可以直接运行迁移入口：

```bash
node dist/cli/v2/migration.js [command] --db /exact/path/biao.sqlite
```

不传 command 时等同于 `preview`。该入口也可由上层 `biao v2 migration` 路由调用。

## 四步流程

### 1. Scan

```bash
node dist/cli/v2/migration.js scan --db /exact/path/biao.sqlite > /tmp/project-map.json
```

`scan` 只读数据库和 Git，输出 JSON，不创建表、不写 binding。结果状态为：

| 状态 | 含义 | 是否可 apply |
| --- | --- | --- |
| `mapped` | 唯一匹配到一个 Project，或重放原 binding | 是 |
| `blocked` | Git/remote/default branch 不可验证，或尚无 Project | 否 |
| `conflict` | fingerprint/URL/branch 不一致或匹配多个 Project | 否 |
| `rebind-needed` | 现有路径的 remote identity 已变化 | 否，必须显式 rebind |

`blocked`、`conflict` 和 `rebind-needed` 均带 `localOnly: true`。它们不会写入 binding，
也不会改变 Project 的 claim 状态。

### 2. Preview 与人工确认

```bash
node dist/cli/v2/migration.js preview --db /exact/path/biao.sqlite
```

逐项核对：

- 所有预期仓库均为 `mapped`；
- 三种 OS 上同一仓库的路径获得同一个随机 `projectId`；
- `repositoryUrl`、完整 `repositoryFingerprint` 和 `defaultBranch` 与 Project registry 一致；
- `conflict` 为零；
- 非 Git 项目保持 `blocked` / local-only。

在留存 scan JSON 和数据库备份之前不要执行 apply。

### 3. Apply

`apply` 必须同时带人工确认和操作者身份：

```bash
node dist/cli/v2/migration.js apply \
  --db /exact/path/biao.sqlite \
  --confirm \
  --actor owner@example.com \
  --reason "reviewed scan 2026-08-15"
```

apply 只插入非 replay 的 `mapped` 条目。每条写入同时追加一条
`legacy_project_binding_audit.action = 'bind'` 记录。重复运行不会覆盖或重复记录。
任何预览后出现的既有 binding 变化都会使事务失败。

apply 完成不等于允许 V2 claim。开启 claim 必须由后续独立的 Project 模式门禁流程完成，
且只能针对已确认无 blocked/conflict 的 Project。

### 4. Report

```bash
node dist/cli/v2/migration.js report --db /exact/path/biao.sqlite \
  > /tmp/v1-v2-project-mapping.md
```

报告列出四种状态、原因、local-only 标志、Project ID、remote fingerprint 和 default branch。
报告包含本地绝对路径，按运维审计资料的访问级别保存，不要公开上传。

## 处理 blocked 与 conflict

- `not-git`：继续 V1 local-only；不要自动创建 Project。
- `git-unreadable`：修复路径/权限后重新 scan。
- `missing-remote`：人工核对后配置 origin，再重新 scan。
- `default-branch-unresolved`：恢复 `origin/HEAD`，或设置上文的显式
  `biao.defaultBranch`。
- `project-not-found`：由 Owner 创建 V2 Project，并登记准确的三元身份；迁移工具本身不创建。
- `fingerprint-conflict`：停止 apply/claim，核对重复 Project、错误 URL、错误 branch 或被篡改
  fingerprint。不得通过改路径、路径 hash 或选择“第一个匹配”绕过冲突。

## Remote 改变后的显式 rebind

先运行 scan，确认条目为 `rebind-needed`，并记录旧 fingerprint、新 fingerprint 与
`proposedProjectId`。目标 Project 必须已由 Owner 创建并准确匹配新身份。

```bash
node dist/cli/v2/migration.js rebind \
  --db /exact/path/biao.sqlite \
  --path /exact/repository/path \
  --project-id project-new-random-id \
  --expected-old-fingerprint OLD_SHA256 \
  --expected-new-fingerprint NEW_SHA256 \
  --confirm \
  --actor owner@example.com \
  --reason "repository transferred to new remote"
```

rebind 会在同一事务中：

1. 重新读取当前 Git identity；
2. 校验旧 fingerprint 未被并发修改；
3. 校验新 fingerprint 与目标 Project 唯一、完全匹配；
4. 更新 active binding；
5. 追加包含 old/new Project、URL、fingerprint、branch、actor 和 reason 的审计记录。

任一条件不成立都不会更新 binding。

## 回滚 rebind

回滚前先从审计表取得要撤销的 `rebind` audit ID：

```sql
SELECT audit_sequence, audit_id, legacy_project_path,
       old_project_id, new_project_id,
       old_repository_fingerprint, new_repository_fingerprint,
       actor_id, reason, created_at
FROM legacy_project_binding_audit
ORDER BY audit_sequence DESC;
```

先把仓库 origin/default branch 恢复到该审计记录中的旧 identity，再执行：

```bash
node dist/cli/v2/migration.js rollback \
  --db /exact/path/biao.sqlite \
  --audit-id REBIND_AUDIT_UUID \
  --confirm \
  --actor owner@example.com \
  --reason "rollback repository transfer"
```

rollback 只接受 `rebind` 审计记录，并要求当前 binding 仍等于该记录的 new identity、当前 Git
已经等于 old identity。成功后追加 `action = 'rollback'` 记录，`reverses_audit_id` 指向原
rebind；历史记录不会删除或改写。最后重新执行 scan、preview 和 report，再由独立流程决定
是否恢复 V2 claim。

## API 接口

需要嵌入控制面时可直接调用：

- `scanProjectMappings(db, options)`：只读 scan/preview 数据；
- `formatProjectMappingReport(scan)`：生成 report；
- `applyProjectMappings(db, scan, { confirmedBy, reason })`：确认后 apply；
- `rebindProjectMapping(db, options)`：带 old/new fingerprint CAS 的显式 rebind；
- `rollbackProjectRebind(db, options)`：基于审计 ID 回滚 rebind。

测试或多节点采集器可注入 `inspectRepository(path)`；生产默认实现调用本地 Git。无论使用哪种
采集器，`identityMaterial` 都只含 repository URL、remote fingerprint 和 default branch，
不含本地路径。
