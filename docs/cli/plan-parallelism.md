# 计划并行度与真实可运行任务诊断

`pending` 是任务的持久化状态，不等于 Worker 此刻可以领取。任务还可能在等待依赖、
等待文件 ownership，或等待 PM Review。PM 不应再用 pending 总数估算执行宽度。

## 查看报告

运行中的计划：

```bash
biao plan status <plan_id> --json
```

返回对象保留原计划状态，并增加稳定的 `data.parallelism`：

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 当前分析合同版本，现为 `1` |
| `counts.runnable_now` | 当前为 pending、依赖已满足且没有活跃 ownership 冲突的任务 |
| `counts.dependency_waiting` | 依赖尚未形成有效交付，或仍处于 `waiting_dependency` 的任务 |
| `counts.ownership_waiting` | 与活跃 ownership 冲突，或处于 `waiting_file_release` 的任务 |
| `counts.review_waiting` | Worker 已交付，但尚未形成可消费 Review/repair 结论的任务 |
| `counts.running` | 已由 Worker 执行的任务 |
| `counts.terminal` | 已验收、repair 已解决、已取消或已 supersede 的任务 |
| `first_wave_width` | 现在真实可领取的首波宽度，不是 pending 总数 |
| `projected_waves` | 按剩余依赖推演的拓扑波次 |
| `later_fan_out` | 首波之后最大的并行波次 |
| `critical_path` | 剩余 DAG 中最长的任务链 |
| `top_blockers` | 传递阻塞下游最多的任务，最多返回五项 |
| `recommended_worker_slots` | 按首波与后续峰值估算的有效 Worker 槽位数 |

分析直接读取当前任务状态、`pm_review_status`、`resolution_status` 和活跃 ownership，
不按 phase 名称猜测执行顺序。普通依赖只有 `done + accepted` 才满足；任务一旦进入
repair/reverify 闭环，只有 `resolution_status=resolved` 才满足。acceptance 任务仍沿用
平台避免验收死锁的规则，可以消费已 `done` 的来源任务。

## 提交前预览

```bash
biao plan submit plans/<plan_id> --preview
biao plan revise <plan_id> --preview
```

预览只分析，不提交也不修改 DAG。若计划至少有 8 个声明的根任务，而首波宽度小于 3，
CLI 会输出 `LOW_INITIAL_PARALLELISM` 告警。循环依赖和不存在的依赖仍是硬失败，不能用
告警或额外 Worker 绕过。

## PM 如何调整计划

先看 `top_blockers` 和 `critical_path`，再决定是否改依赖：

1. 检查高阻塞任务的每条 `depends_on` 是否真的是产物依赖。仅为了表达 phase 顺序而加的
   边，应在确认任务可独立验收后移除。
2. 若一个大任务同时阻塞多个分支，把它拆成可以独立交付、独立 Review 的小任务，让下游
   只依赖实际需要的那一项。
3. 如果瓶颈是 `review_waiting`，优先完成 Review 或 repair 闭环；增加执行 Worker 不会放行
   下游。
4. 如果瓶颈是 `ownership_waiting`，缩小互相覆盖的 ownership 范围，或等待当前 owner
   释放；增加 Worker 只会增加竞争。
5. 只有当 `runnable_now` 或后续 fan-out 持续大于在线空闲 Worker 数时，才按
   `recommended_worker_slots` 增加槽位。建议值是容量上限，不是必须常驻的数量。

修改依赖后再次运行 preview。CLI 只提供诊断和告警，不会擅自重写 DAG。
