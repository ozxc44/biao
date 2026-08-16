All four verification requirements are met. Here is the delivery summary.

---

## 车道 D 交付摘要（hermes-e / deepseek-v4-flash）

### 变更文件

| 文件 | 变更 | 说明 |
|---|---|---|
| `scripts/supervisor.mjs` | 修改 | **flaky 根治**：`stopAndDrainActivePmAgents()` 信号路径不重复补发 SIGTERM；`signalPmAgentTree()` 增加沿 pid 树补杀（`descendantPids()` + `pgrep -P` 递归） |
| `scripts/pm-agent.mjs` | 修改 | 内核锁 stdin/ack pipe 泄漏事件循环，业务结束后残留；`main()` 后 `.finally(() => process.exit(process.exitCode))` 主动退出 |
| `src/server/v2/reconcile-three-way.ts` | **新增** | 22.2-03 三方对账服务（SQLite deliveries/artifacts × artifact blob 目录 × git refs 计数+digest 比对，输出偏差清单） |
| `tests/distributed/p9-redis-rebuild.test.ts` | **新增** | 22.4-07 Redis FLUSHDB 后 V2 调度态从 SQLite 重建（5 用例） |
| `tests/distributed/p9-consistency.test.ts` | **新增** | 22.4-33 删除身份隔离矩阵 + 22.2-03 对账测试（10 用例） |
| `docs/runbooks/p9-consistency-lane-d.md` | **新增** | runbook 增补（根因、修复、缺口、对账用法） |

### flaky 根因与修复点（SIGINT/SIGTERM 孙进程竞态）

**根因**：supervisor 停止路径在同一 tick 发**两轮 SIGTERM** 到 pm-agent 进程组（`stop()` 一轮 + `finally`→`stopAndDrainActivePmAgents()` 一轮）。pm-agent 的 `process.once('SIGTERM')` 第一轮被消费后 Node 恢复 SIG_DFL；第二轮 SIGTERM 在 handler 完成转发（杀掉 detached adapter 组）之前把 pm-agent **直接杀死**，adapter 的孙进程失孤 → `grandchildStopped` 20s 探针超时。复现调试确认：trace 显示 `signalPmAgentTree` 两次调用、第二次命中 SIG_DFL。

**修复**：
1. 非信号路径（正常闭环退出）才在 drain 阶段补发 SIGTERM（`if (!receivedSignal)` 守卫）——消除第二枪。
2. 组信号只覆盖 pm-agent 自己的进程组；沿 pid 树（PPID 递归）把 detached adapter 及其孙进程逐点补杀，不再依赖 pm-agent 信号处理器代为转发。

### 验证（四条原始输出）

**① flaky 文件 10 连跑全绿**（`tests/supervisor-pm-agent-cli.test.ts`，每次 12/12）：
```
RUN 1-10:  Test Files 1 passed | Tests 12 passed (×10)
```

**② 全量 2 次稳定**（不因它失败）：
```
RUN 1: Test Files 132 passed (132) | Tests 1646 passed (1646)
RUN 2: Test Files 132 passed (132) | Tests 1646 passed (1646)
```

**③ 三项一致性测试**：
- `p9-redis-rebuild.test.ts` 5/5：FLUSHDB 后 SQLite 侧调度态原样；再次 claim → 409 `ATTEMPT_ACTIVE`（不重开旧 generation）；非当前 generation bva2 renew → 409 `GENERATION_MISMATCH`（lease 不复活）；audit/outbox 计数不变（不重放）。
- `p9-consistency.test.ts` 删除隔离矩阵：owner/project_admin/reviewer/auditor/node/attempt × 11 条删除类路由，44 个拒绝格逐断言 403 `RBAC_ROLE_DENIED`/`RBAC_SCOPE_DENIED`；revoke-all 拒绝路径单独逐断言（破坏性端点不进矩阵）。
- 对账注入测试：三方一致→无偏差；删 blob→`artifact_blob_missing`；篡改内容→`artifact_blob_tampered`；远端多余分支→`git_ref_without_delivery`（warning）。

**④ 对账报告字段示例**（`p9-consistency.test.ts` 断言）：
```ts
{ ran_at, project_ids, summary: { sqlite: {source,count,digest}, artifact_blobs: {...}, git_refs: {...} },
  discrepancies: [{ kind: 'artifact_blob_missing', severity: 'error', projectId, subjectType: 'artifact',
                    subjectId: 'art-…', expected: '<sha256>', actual: '<missing>', detail }] }
```

### 残余风险 / 缺口（如实清单）

1. **merge_bot（bvm2_）在共享 plugin 层 401**：`http-plugins.ts` onRequest 放行前缀缺 `bvm2_`，registry/rbac 已支持但请求进不了 /v2 路由——删除隔离对 merge_bot 无法经 HTTP 验证（已断言 401 并标注）。
2. **`POST /v2/recovery-candidates/:candidate_id/decision` 未装配路由**：registry 有（scope=recovery_reviewer）但 v2-routes.ts 未注册 handler，删除隔离只能经 registry 断言。
3. **对账路由未挂载**：车道并行约束下未动 `v2-routes.ts`/`registry.ts`（车道 C 文件），只交付 service+测试；路由缺口见 runbook。
4. **revoke-all 不进矩阵**：owner 执行会真实前滚密钥环（全局副作用），拒绝路径单独断言；owner 放行由 p6-rbac 覆盖。
5. supervisor 停止因 undici keep-alive socket 仍有 ~10s 既有延迟（非本次引入，不影响正确性）。