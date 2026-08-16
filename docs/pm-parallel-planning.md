# PM 并行拆解规则

Biao 的 PM 默认把可独立交付的工作拆成并行 lane，同时用精确 ownership 保证写入安全。派工前，每条 lane 都必须列出 lane ID、硬依赖、读写模式、精确 ownership、交付物、验证命令和独立验收者。

## 首波门禁

首波目标是 3–4 条互不重叠的实现 lane。同一文件、模块或共享入口同时只能有一个写入者；共享范围上的只读分析和测试可以并行。如果计划有 48 个任务却只有 1 个首波 runnable 实现 lane，而 PM 又不能指出真实硬依赖或不可拆分的写 ownership，就必须重新拆解，**不得提交该 DAG**。不能为了满足数量而让多个 Worker 争写同一范围。

## 真实依赖

只有数据、接口、迁移或验收事实的真实消费者才写 `depends_on`：下游在缺少上游产物时确实无法正确开始，才构成硬依赖。同 phase、同里程碑、同优先级或任务编号相邻都不是依赖理由。

acceptance 应放在一组相关实现产物的 fan-in 汇合点，对可复现的集成事实做独立验收。不为每个微任务建立全局阶段栅栏，也不让一个汇合点阻塞无关 lane。只读分析与测试应在 ownership 安全的前提下尽早并行。

## 每轮队列平衡

PM 每轮先处理 review、Question 和 stale，再补足可运行队列：

- Worker 数大于 runnable 数时，检查并调整 DAG，移除伪依赖、拆开可分离的 ownership 或补充真正独立的 lane。
- runnable 数大于 Worker 数时，补充 Worker 槽位，并优先启动 ownership 互不重叠的 lane。
- 任一 lane 完成后立即填充新解锁的 runnable 工作，不等待无关 lane 形成阶段栅栏。

## 不变的闭环铁律

- `done` 只是 Worker 交付状态，不等于 `accepted`；只有 PM Review accepted 才算完成。
- acceptance 必须由未参与被验收实现的独立 Agent 执行，并提交新鲜、可复跑的证据。
- Worker 缺少产品决策时必须发 Biao Question；PM 记录答案后，Worker 只能通过 fresh claim 恢复。
- Review 拒绝后的实现修复必须沿 repair / resolution 链推进，不用 reset 绕过审计。
- 只有 review、Question 或 repair/resolution 的实际处置已经成功并记录证据，PM 才能 ack 对应事件；门铃、退出码 0 或测试数量都不能替代处置与验收。
