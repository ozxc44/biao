测试已经全部通过。让我检查构建问题。
找到问题了。第284行使用了 `this.provider.run?.()`，但 `executeMerge` 是一个独立的异步函数而非类方法，`this` 没有定义。应该直接使用闭包中的 `provider`。
现在检查 `GitProvider` 是否有 `run` 方法。
`GitProvider` 没有 `run` 方法，所以这行代码实际上是死代码（optional chaining 返回 undefined）。让我重构这部分逻辑，用正确的方法替代。
这行代码是死代码（`provider.run` 不存在，optional chaining 使整个表达式成为 no-op）。直接移除它，因为 `writeRef` 已经正确设置了 HEAD。
现在运行构建和测试验证。
构建和P5测试全通过。继续运行分布式测试和全量测试。
分布式测试 277/277 全通过。运行全量测试。
全量测试 1311/1313 通过，仅 `supervisor-pm-agent-cli.test.ts` 的 2 个测试失败（已知 flaky）。验证这是已知问题。
确认 supervisor 测试是已知 flaky（信号处理时序问题）。现在检查上轮结果文件。
现在我完全理解了情况。让我写最终总结。

## 最终总结

### 修改文件

**`src/server/v2/merge/queue.ts`** (第278-286行)

移除了第284行的死代码 `await provider.run?.(integrationDir, ['checkout', job.expected_target_sha]) ?? {};`

### 根因分析

1. **TS2683 错误**：原代码使用 `this.provider.run?.()`，但 `executeMerge` 是闭包内的独立 async 函数，不是类方法，`this` 无类型注解。
2. **`provider.run` 不存在**：`GitProvider` 接口没有 `run` 方法。`?.` optional chaining 使整个表达式成为 no-op（返回 `undefined`，`?? {}` 变成空对象），所以运行时不会崩溃，但 TypeScript 编译严格检查会报错。
3. **合并逻辑本身正确**：`provider.merge()` 的冲突检测依赖 `GitProviderError`（exit code + porcelain 冲突标记），干净 no-ff merge 走正常路径返回 merge sha。测试中 4 个失败是因为 `npm run build:server` 失败导致测试二进制/环境不一致。

### 上轮状态偏差原因

上轮 worker（20260816_050127_a_ff7b）声称 "Phase 5 10/10 通过" 和 "tsc --noEmit 通过"，但实际工作树存在 TS2683 错误。最可能的原因：worker 先运行了测试（vitest 使用 esbuild 不做类型检查所以通过），然后在后续编辑中引入了 `this.provider.run?.()` 代码但没有再次运行 `npm run build:server` 验证。结果文件声称全绿但基于的是引入错误前的测试输出。

### 验证结果

| 验证步骤 | 结果 |
|----------|------|
| `npm run build:server` | ✅ 通过（无 TS 错误） |
| `npx vitest run tests/distributed/p5-merge-queue.test.ts` | ✅ 10/10 通过 |
| `npx vitest run tests/distributed/` | ✅ 277/277 通过 |
| `npx vitest run` 全量 | ✅ 1311/1313 通过（仅 supervisor flaky 2 个） |

### 残余风险

1. **supervisor flaky 测试**：`tests/supervisor-pm-agent-cli.test.ts` 的信号处理测试是已知时序问题，与本轮修改无关。
2. **依赖解锁最小化**：`unlockDownstream` 仍为占位实现。