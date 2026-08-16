# Phase 0b 交付说明

## 完成状态：DONE

## 新增文件

### Fixtures（`tests/distributed/fixtures/`）

1. **`git-fixture.ts`** — Git Bare Remote fixture
   - `createBareRemote()`: 创建临时 bare 仓库
   - `cloneBare()`: 克隆 bare 仓库
   - `commitAndPush()`: 创建 commit 并 push，返回 SHA
   - `lsRemoteSha()` / `defaultBranchSha()`: 查询远端 SHA
   - `assertCasUpdated()`: CAS 断言（push 前后 SHA 变化）
   - `cleanupGitFixtures()`: 清理临时目录

2. **`artifact-store-fixture.ts`** — Artifact Store fixture
   - `createArtifactStore()`: 创建临时内容寻址目录（sha256 命名）
   - `uploadArtifact()`: 上传内容，校验大小上限（§9.3）
   - `downloadArtifact()`: 下载内容
   - `rejectPathTraversal()`: §9.3 路径穿越拒绝
   - `validateManifest()`: manifest 校验（SHA + size 一致性）
   - `sha256hex()`: SHA-256 计算
   - `RESULT_MAX_BYTES` / `LOG_MAX_BYTES` / `TOTAL_MAX_BYTES`: §9.3 大小上限常量

3. **`node-simulator.ts`** — 逻辑 Node 模拟器
   - `createSimulatedRedis()`: 模拟 Redis namespace（Map-based）
   - `createNode()`: 创建隔离 Node 身份
   - `nodeRegister()` / `nodeHeartbeat()`: 节点注册/心跳
   - `nodeClaimTask()`: 领取任务（CAS 竞争语义）
   - `nodeRenewLease()` / `nodeReport()`: 续租/报告
   - `nodePushDelivery()`: push 到 bare remote
   - `declareOwnership()` / `releaseOwnership()`: 文件所有权

4. **`fault-injector.ts`** — 故障注入器
   - `now()` / `injectClockSkew()` / `resetClockSkew()`: 时钟偏差注入
   - `addFaultRoute()` / `clearFaultRoutes()` / `wrapFetchWithFaults()`: 网络分区注入
   - `registerProcess()` / `simulateProcessInterruption()`: 进程中断注入
   - `resetAllFaults()`: 统一清理

### 测试文件（`tests/distributed/`）

5. **`p0b-git-artifact.test.ts`** — 15 tests
   - Git bare remote: 创建、push、CAS 断言、ls-remote
   - Artifact store: 上传/下载、幂等 CAS、超大文件拒绝、路径穿越拒绝、manifest 校验

6. **`p0b-node-claim-race.test.ts`** — 8 tests
   - 两节点竞争 claim 同一 task（只有一个赢家）
   - 续租/非 owner 续租失败
   - report done/非 owner report 失败
   - 文件所有权冲突/释放

7. **`p0b-fault-injection.test.ts`** — 12 tests
   - 时钟偏差：正偏差、负偏差、重置
   - 网络分区：匹配拦截、不匹配通过、shouldBlock 控制、正则匹配、清除恢复
   - 进程中断：kill、重复 kill 保护、cleanup

8. **`p0b-v1-v2-baseline.test.ts`** — 8 tests
   - V1 主链路：plan submit → claim → report done → PM review accept（完整链路）
   - V1 失败路径：错误 claim_token 被拒、PM reject 生成修复指令
   - V2 outbox：append → retry → dead letter 完整生命周期
   - V2 idempotency：未命中、命中（digest_match=true）、冲突（digest_match=false）、跨 actor 隔离
   - V2 compensating event
   - Git + Artifact 联合基线：bare remote push + artifact upload + CAS 断言
   - 路径穿越拒绝 + 超大文件拒绝基线

## 验收演示证据

1. **bare remote push + CAS 断言**: `p0b-git-artifact.test.ts` → "push 后默认分支 CAS 断言通过" + "第二次 push 后 SHA 变化"
2. **artifact fixture 拒绝路径穿越与超大文件**: `p0b-git-artifact.test.ts` → "拒绝路径穿越（§9.3）" + "拒绝超大文件（§9.3）"
3. **两个 Node 对同一 task 的领取竞争只有一个赢家**: `p0b-node-claim-race.test.ts` → "两个 Node 同时 claim 同一 task 只有一个赢家"
4. **故障注入器各触发一次并断言失败路径**: `p0b-fault-injection.test.ts` → 时钟偏差/网络分区/进程中断 各有覆盖

## 门禁结果

- **新增**: 4 文件 / 43 用例，全部通过
- **全量**: 106 文件 / 1148 用例（基线 102/1105 + 4/43）
- **已知 flaky**: `supervisor-pm-agent-cli.test.ts` SIGTERM 时序用例偶发失败（预存问题，允许单独复跑）
- **无回归**: 其余 105 文件全部通过

## 约束遵守

- ✅ 全程中文注释
- ✅ 不碰 `src/mcp/**`、`web/`、生产栈
- ✅ 不改 `src/server/service.ts`、`src/server/http.ts`
- ✅ 测试 Redis 使用 `redis://127.0.0.1:6380/15`（已有 DB，未引入新 `*_TEST_REDIS_URL` 变量）
- ✅ 纯 SQLite + 测试 Redis，不启动生产栈

## 残余风险

- Node 模拟器使用 Map-based 内存结构（非真实 Redis），后续 Phase 3 需要替换为真实 Redis 交互
- `node-simulator.ts` 中 `nodePushDelivery` 使用 `require('node:child_process')` 动态导入（ESM 兼容性小风险）
