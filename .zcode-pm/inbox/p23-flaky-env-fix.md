# 修复轮：V2 测试跨文件 env/模块缓存污染（顺序敏感 flaky，~50% 复现）

## 复现证据（PM 实测）

- `npx vitest run tests/distributed/` 全量 17 文件：**约一半运行次序下 `tests/distributed/p1-e2e-identity.test.ts` 的 13 个用例失败**（enroll/authorize/heartbeat 级联），其余次序全绿（240/240）。失败日志样本：`/tmp/dist-run-2.log`。
- 单独跑 p1-e2e 恒绿；p1-e2e 之前的任意前缀组合恒绿；失败只出现在特定文件（p3-node-daemon / p23-integration-gate / p1-credentials 等操作 env 的文件）先于 p1-e2e 执行时。
- vitest 配置 singleFork：**所有测试文件共享同一进程与模块缓存**。
- 直接错误：`Node-A enroll → expect(res.status).toBe(200)` 失败（enroll 非 200，疑 503）。

## 根因假设（按证据，最终以你的调试为准）

集成门禁车道引入的 `BIAO_V2_ENROLLMENT_TICKET`（enroll 无 env 则 503 关闭）与 `BIAO_V2_CREDENTIAL_KEY`，在服务端/测试侧存在 **import 时模块级缓存** 或 **测试文件 afterAll 未恢复 env**：前序文件设置/删除 env 后，p1-e2e 的 beforeAll 再设置也与缓存值失配，enroll 被判无票/错票 → 503 级联。

## 修复目标

1. **服务端改为每请求读取 env**（不在模块加载时缓存票据/密钥值；密钥解析可缓存结构但每次校验 env 存在性）——这也是生产行为正确的做法（env 热更新/部署器改 env 不需重启进程语义要在文档写明）。
2. **测试 env 纪律**：所有操作 `BIAO_V2_*` env 的测试文件统一 save/restore（beforeAll 快照、afterAll 恢复，包括 delete 场景）；p1-e2e/p23/p1-credentials/p3-node-daemon 全部自查。
3. **回归门禁**：新增 `tests/distributed/p23-env-hermetic.test.ts`——单进程内按"污染序列"（设置→删除→再设置不同值）连续调用 enroll/ticket 校验函数，断言每次结果与当前 env 一致（防再次引入 import 缓存）。
4. **验证方式（必须执行并贴证据）**：连续 `npx vitest run tests/distributed/` **6 次**全部 240/240（vitest 文件顺序存在随机性，6 连绿才能关门）；全量 `npx vitest run` 1 次不劣化基线 112/1260。

## 约束

- 全程中文；所有权：`src/server/v2/**`（票据/密钥读取点）、`src/node/transport.ts`（若同样缓存）、相关测试文件、新增 hermetic 测试。不碰其他车道文件。
- 不改变生产语义：enroll 关闭（无 env）与常量时间比较等安全行为保持。

## 验收标准

1. 上述 6 连绿 + 全量复跑证据（贴命令输出摘要）。
2. 交付说明：根因确认（缓存点 or 纯 env 未恢复，或两者）、修改点清单、hermetic 测试原理。
