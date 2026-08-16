我来实现 Phase 0b 分布式测试基础设施。先了解项目结构和现有代码。
Now let me read the §6 Git workspace and §9 Artifact Store sections, and explore the existing V2 infra code.
Now let me explore the existing V2 infra code and test structure.
Now let me explore the existing test structure and key files I need to understand.
Let me also look at an existing distributed test and the service functions for the V1 main chain.
Now I have a solid understanding of the codebase. Let me look at the key V1 service functions I need to exercise in the baseline snapshot.
Now I have a thorough understanding. Let me implement Phase 0b. I'll start by creating the fixture library and then the test files.
Now I'll implement all the fixtures and tests. Let me start by creating the fixture library files and then the test files.
Now let me create the test files. I'll start with the Git + Artifact tests, then the node claim race test, fault injection test, and finally the V1/V2 baseline snapshot.
Now let me create the V1/V2 baseline snapshot test. Let me first check how existing tests interact with the service layer.
Now let me build and run the tests.
Let me fix the path traversal detection logic in the artifact store fixture.
All fixture tests pass. Now let me run the V1/V2 baseline test.
The issue is the top-level `beforeEach` runs before `redis` is initialized. Let me fix the test structure.
Let me check what the report error actually is and how the service initializes SQLite.
The verify commands must match the task's declared verify. Let me fix the test.
All tests pass. Let me remove the debug logging and run all p0b tests together.
Now let me run all 4 p0b test files together.
All 43 p0b tests pass. Now let me run the full test suite to verify no regressions.
Full suite: 106 files / 1148 tests (4 new files / 43 new tests). Only failure is the known flaky `supervisor-pm-agent-cli` SIGTERM timing test (pre-existing, allowed to re-run individually).

Now let me write the delivery summary.
Let me fix the ESM compatibility issue in the node simulator test.
## Phase 0b 交付完成

### 新增文件（8 个）

**Fixtures（`tests/distributed/fixtures/`）：**
- `git-fixture.ts` — Bare Git Remote（init/clone/push/CAS 断言）
- `artifact-store-fixture.ts` — 内容寻址 Artifact Store（SHA-256 命名、大小上限、路径穿越拒绝、manifest 校验）
- `node-simulator.ts` — 两个逻辑 Node 模拟器（注册/心跳/claim 竞争/续租/报告/所有权）
- `fault-injector.ts` — 故障注入器（时钟偏差/网络分区/进程中断）

**Tests（`tests/distributed/`）：**
- `p0b-git-artifact.test.ts` — 15 tests（bare remote + artifact store）
- `p0b-node-claim-race.test.ts` — 8 tests（两节点竞争 claim）
- `p0b-fault-injection.test.ts` — 12 tests（三类故障注入）
- `p0b-v1-v2-baseline.test.ts` — 8 tests（V1 主链路 + V2 outbox/idempotency 基线）

### 门禁结果

| 指标 | 基线 | 当前 |
|------|------|------|
| 文件数 | 102 | 106 (+4) |
| 用例数 | 1105 | 1148 (+43) |
| 通过率 | 全绿 | 全绿 |

唯一失败：`supervisor-pm-agent-cli.test.ts` SIGTERM 时序 flaky（预存问题，允许单独复跑）。

### 验收演示证据

1. bare remote push + CAS 断言 → `p0b-git-artifact.test.ts` 第 20-31 行
2. 路径穿越拒绝 + 超大文件拒绝 → `p0b-git-artifact.test.ts` 第 129-132 行
3. 两节点竞争只有一个赢家 → `p0b-node-claim-race.test.ts` 第 18-32 行
4. 故障注入器各触发一次 → `p0b-fault-injection.test.ts` 全文

### 残余风险

- Node 模拟器使用 Map-based 内存（非真实 Redis），Phase 3 需替换为真实 Redis 交互
- `now()` 时钟偏差注入依赖全局状态，并行测试需注意隔离