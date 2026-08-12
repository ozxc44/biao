# 规划 CLI：PM 与 Agent 的安全修改路径

这组命令把“修改本地 Markdown”和“提交到 Biao”连成可检查、可脚本化的路径。默认保持被动：预览和 diff 不修改平台；只有显式 `--submit`、`task add` 或 `task edit` 才会调用现有的 `POST /plan/submit`。

## 修改规划：先预览，再提交

```bash
biao plan revise <plan_id> --preview
biao plan revise <plan_id> --diff
biao plan revise <plan_id> --submit
```

- `--preview` 是默认模式，输出平台状态和将要发生的动作数量。
- `--diff` 逐字段显示 Redis task 投影与本地 `tasks/*.md` 的差异，不写平台。
- `--submit` 先生成同一份预览，再提交本地 plan 目录。
- `--preview`、`--diff`、`--submit` 互斥；未知参数或缺值以非零状态退出。

人类输出同时给出四条明确下一步：重新 submit、加新任务、强制 reset running（危险）和查看 diff。reset 使用已有的 `biao task reset <task_id> --force`，会打断正在工作的 Worker，只应在 PM 明确确认后执行。撤销 pending 任务使用独立的 `biao task cancel <task_id>`。

平台没有保存 `index.md` 的旧版原文，因此 CLI 只能比较 task frontmatter 投影和 task 正文。磁盘缺失的 task 不会因 submit 自动删除，PM 必须显式执行：

```bash
biao task cancel <task_id>
```

当前服务端的 plan submit 只更新 `pending`：`running`、`blocked`、`done`、`failed`、`cancelled` 都会保留。preview 会分别标记跳过动作，尤其会确认 cancelled task 不会因磁盘仍有 MD 而复活。

## 新增 task

Agent 和无 TTY 环境必须显式提供 task ID 与标题：

```bash
biao task add \
  --plan <plan_id> \
  --task-id <task-id> \
  --title "任务标题" \
  --type code \
  --phase impl \
  --priority 5 \
  --depends-on task-a,task-b \
  --ownership src/a.ts,src/b.ts \
  --verify-cmd "npm test -- task-a" \
  --body "# 目标" \
  --json
```

独立验收任务必须同时声明验收对象和至少一条验证命令：

```bash
biao task add \
  --plan <plan_id> \
  --task-id <acceptance-task-id> \
  --title "独立验收" \
  --type acceptance \
  --phase qa \
  --depends-on <implementation-task-id> \
  --acceptance-for <implementation-task-id> \
  --verify-cmd "npm test -- feature" \
  --verify-cmd "npm run typecheck" \
  --json
```

`--verify-cmd` 可重复，CLI 按出现顺序生成 `verify` 数组，每项默认 `expect_exit: 0`。`acceptance` 缺少该参数时会在写文件和 submit 之前以 `ACCEPTANCE_VERIFY_REQUIRED` 失败，不会生成无法闭环的任务。

CLI 在写文件前检查：

- task ID 命名和本地/平台重复；
- type、priority、timeout；
- phase 是否存在于 `index.md`；
- `depends_on` 与 `acceptance_for` 是否引用本 plan 已有任务；
- 完整 plan 的 phase、DAG 和 acceptance 约束；
- 完整 plan 是否包含服务端会保留并跳过的非 pending 历史。

通过后生成可解析的 YAML frontmatter，并自动 submit。若 submit 失败，新 task MD 会作为明确标记的本地草稿保留，JSON 错误中返回 `task_path` 与 `draft_retained: true`，不会假装任务已进入平台。

## 编辑 task

有终端时可以显式配置编辑器：

```bash
biao task edit <task_id> --editor /path/to/editor
```

Agent 或无 TTY 环境推荐准备完整 task MD，再执行：

```bash
biao task edit <task_id> --from-file /absolute/path/to/task.md --json
```

只需替换验证命令时，可以不启动编辑器：

```bash
biao task edit <task_id> \
  --verify-cmd "npm test -- feature" \
  --verify-cmd "npm run typecheck" \
  --json
```

这会替换该任务的整个 `verify` 数组，每项默认 `expect_exit: 0`。如果各项需要不同的 `expect_exit`、`scope` 或 `timeout`，使用 `--from-file` 提供完整的结构化 task MD。`--from-file`、`--editor` 与 `--verify-cmd` 三种编辑来源互斥。

替换文件里的 `task_id` 必须与目标一致。CLI 会在提交前校验 plan，并拒绝空或损坏 `verify` 的 acceptance；编辑器失败、校验失败、网络失败或服务端 submit 失败时恢复原文件。没有显式编辑来源、`EDITOR` 或 `VISUAL` 且当前无 TTY 时，命令返回 `INTERACTIVE_EDITOR_REQUIRED`，不会偷偷启动 `vi`。

`running`、`done`、`failed`、`cancelled` 状态需要显式 `--force`；这只代表操作者确认编辑风险，不会绕过服务端的状态保护。JSON 会返回 `platform_update_expected: false`，明确表示文件虽然已保存并提交，但平台运行时 task 不会被覆盖。

## 存档新需求

```bash
biao plan intake --plan <plan_id> --text "需求原文" --json
```

需求写入 `plans/<plan_id>/intake/`。同一天相同 slug 会自动增加 `-2`、`-3`，不会覆盖历史。无 TTY 时缺少 `--text` 会返回 `INTERACTIVE_INPUT_REQUIRED`，不会声称已经进入不存在的交互流程。

## `--json` 机器合同

`plan revise`、`plan intake`、`task add`、`task edit` 的 `--json` 模式只向 stdout 输出一个 JSON 对象，不混入进度提示：

```json
{
  "ok": true,
  "data": {
    "operation": "task_add"
  }
}
```

预期错误也保持一个对象并以非零状态退出：

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "INVALID_PRIORITY",
    "message": "priority 必须是 0-9 的整数：10"
  }
}
```

Agent 应同时判断进程退出状态和 `ok`，不要只匹配人类可读文本。每个命令的完整参数可通过 `--help` 查看，帮助命令不连接服务。
