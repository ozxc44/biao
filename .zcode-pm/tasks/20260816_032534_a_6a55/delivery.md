# 交付说明

## 根因确认

**两者兼有**：模块级 env 缓存 + 测试 env 未恢复。

具体机制（singleFork 串行执行，所有测试文件共享同一进程）：

1. **`p23-integration-gate.test.ts` 模块级设置 `BIAO_V2_ENROLLMENT_TICKET` 且 afterAll 不清理**：当 p23 先于 p1-e2e 执行时，`process.env['BIAO_V2_ENROLLMENT_TICKET']` 残留为 `'test-enrollment-ticket-p23'`。p1-e2e 的 enroll 请求携带 `'ticket-a'`，`validateEnrollmentTicket`（node-service.ts:73）读到残留值 → timing-safe 比较失败 → `INVALID_TICKET` → 级联 13 个用例失败。

2. **`p3-node-daemon.test.ts` 模块级设置 `V2_CREDENTIAL_KEY_ENV` 且 afterAll 不清理**：密钥值残留影响后续文件的默认密钥路径。

3. **`p1-credentials.test.ts` beforeEach 删除 `V2_CREDENTIAL_KEY_ENV` 且不恢复**：导致后续文件在无密钥环境下运行。

**服务端无缓存问题**：`node-service.ts` 的 `validateEnrollmentTicket` 每次调用都读 `process.env`；`credentials.ts` 的 `loadV2CredentialKeyring` 同样每次读 env。服务端行为正确，纯属测试侧 env 纪律问题。

## 修改点清单

| 文件 | 变更 |
|------|------|
| `tests/distributed/p1-e2e-identity.test.ts` | 模块级 `process.env[V2_CREDENTIAL_KEY_ENV]=...` 移入 beforeAll + save/restore；afterAll 恢复 env（含 `BIAO_V2_ENROLLMENT_TICKET` 清理） |
| `tests/distributed/p23-integration-gate.test.ts` | 模块级两行 env set 移入 beforeAll + save/restore；afterAll 恢复 env |
| `tests/distributed/p3-node-daemon.test.ts` | 模块级两行 env set 移入 beforeAll + save/restore（含 `BIAO_V2_ENROLLMENT_TICKET` 清理）；afterAll 恢复三个 env key |
| `tests/distributed/p1-credentials.test.ts` | beforeAll 增加快照（含 `BIAO_V2_ENROLLMENT_TICKET`）；afterAll 增加三键恢复 |
| `tests/distributed/p23-env-hermetic.test.ts` | **新增**：env 防回退门禁测试 |

## hermetic 测试原理

`p23-env-hermetic.test.ts` 在**同一 server 实例**上连续变更 `process.env` 并验证 enroll 行为一致性：

- **enroll ticket 序列**：无 ticket（向后兼容）→ 设置 ticket-A（A 通过/B 拒绝）→ 删除 ticket（恢复兼容）→ 设置 ticket-B（A 拒绝/B 通过）
- **credential key 序列**：KEY-A 签发 → 切换 KEY-B（旧 token 应被拒）→ 切回 KEY-A（恢复正常）

每次 env 变更后立即发起 HTTP 请求，断言结果与当前 env 一致。若服务端存在 import-time 缓存，切换后的行为不会改变 → 测试失败。

## 验证证据

### 6 连绿（tests/distributed/）

```
Run 1: Test Files  18 passed (18) | Tests  247 passed (247) | 12.80s
Run 2: Test Files  18 passed (18) | Tests  247 passed (247) | 12.87s
Run 3: Test Files  18 passed (18) | Tests  247 passed (247) | 12.72s
Run 4: Test Files  18 passed (18) | Tests  247 passed (247) | 12.81s
Run 5: Test Files  18 passed (18) | Tests  247 passed (247) | 12.74s
Run 6: Test Files  18 passed (18) | Tests  247 passed (247) | 12.81s
```

### 全量复跑

```
Test Files  2 failed | 112 passed (114)
Tests  2 failed | 1281 passed (1283)
```

2 个失败文件均为 `tests/` 目录下的**预存失败**（`project-agent-binding-core.test.ts`、`supervisor-pm-agent-cli.test.ts`），与 distributed 测试无关。distributed 目录 18 文件全绿。

## 残余风险

- 无。服务端 env 读取已是每请求级别，测试 env 纪律已统一为 save/restore 模式，hermetic 测试持续防回归。
