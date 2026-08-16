# 修复轮：Phase 5 Merge Queue 交付树不达声称状态（构建失败 + 4 测试挂）

## PM 复验证据（当前工作树，2026-08-16）

1. `npm run build:server` **失败**：`src/server/v2/merge/queue.ts(284,19): error TS2683: 'this' implicitly has type 'any'`（缺类型注解）。
2. `npx vitest run tests/distributed/p5-merge-queue.test.ts` **4/10 失败**，全部同一签名：
   - 无冲突自动合并：两 delivery 串行 merge → `expected 'conflict' to be 'merged'`（queue.ts 的 merge 冲突判定把干净合并误判为 conflict）
   - CAS 重排队成功场景 → 同签名
   - 串行性第二个基于新 HEAD → 同签名
   - 降级/恢复场景 → 同签名
3. 全量：116 文件/1313 用例，5 失败（上述 4 + 已知 supervisor flaky）。

结论：交付树未在你声称的状态（结果文件末尾也有内容损坏迹象）。本轮要求以**当前工作树实际状态**修复，不得重做已正确的部分。

## 修复目标

1. 修 `queue.ts:284` 的 TS2683（显式类型注解）。
2. 修 merge 冲突误判：定位 `provider.merge()` / queue 冲突判定链——干净 no-ff merge 必须判 `merged`；只有真实冲突（exit code + porcelain 冲突标记）才 `conflict`。修复后四个失败用例转绿。
3. 全部原有目标保持：§12 对照表所列行为不得回退。

## 约束

- 所有权同 Phase 5 任务书；全程中文。
- **验证方式（必须逐条执行并贴原始输出摘要）**：`npm run build:server` ✅ → `npx vitest run tests/distributed/p5-merge-queue.test.ts` 10/10 ✅ → `npx vitest run tests/distributed/` 全绿 → 全量 `npx vitest run` 不劣化（仅已知 supervisor flaky，单独复跑证明）。
- 交付说明必须解释：为何上一轮结果文件声称全绿而实际树是坏的（在哪一步发生了什么）。

## 验收标准

1. 上述四条验证全过（贴输出）。
2. 根因说明（冲突误判的具体代码缺陷 + 上轮状态偏差原因）。
