# Runbook：模式切换状态机与恢复决策（后续增强·车道 C）

对应审计项 22.3-18/20/21、22.4-04/06/26/27/29/31/34（docs/distributed-multi-node-acceptance-audit.md §22）。
实现位置：`src/server/v2/project-service.ts`（step 推进器）、`src/server/v2/recovery-decision.ts`（签名决策/接管/隔离）、迁移 `013_recovery_decisions.ts`。

---

## 1. mode transition step 推进器（22.3-20 / 22.4-04）

### 1.1 状态机

```
deadline = 创建时刻 + MODE_TRANSITION_DEADLINE_MS（24 小时，§12.1.1 矩阵原文）

full → read-only（draining，§4.1/§12.1.1）：
  pause ──> fence-attempts ──> invalidate-lineage ──> block-dependents ──> reconcile ──> commit-mode ──> completed
    │            │                    │                     │                  │
    │            │                    │                     │                  └─ pending Candidate 未裁决：
    │            │                    │                     │                     waiting（停留本 step，报告清单）
    │            │                    │                     └─ 写任务/下游只读任务 blocked
    │            │                    └─ Delivery invalidated + BranchCleanup(reason=mode_transition)（幂等）
    │            └─ 写 Attempt → pending_recovery（generation fencing）
    └─ project paused + draining 指针

read-only → full（validating，§12.1.2）：
  pause ──> validate-capability ──> reconcile ──> refresh-bindings ──> revalidate-plans ──> commit-mode ──> completed
    │            │                    │              │                     │
    │            │                    │              │                     └─ canary 子步（22.4-34）：首个迁移 plan
    │            │                    │              │                        验证失败 → failed（保持 read-only）
    │            │                    │              └─ 离线 Node binding suspended，不阻塞（22.3-21）
    │            │                    └─ pending Candidate 未裁决 → waiting（isolated 不阻塞）
    │            └─ fingerprint/默认分支校验失败 → failed（开 Incident，可重试）
    └─ paused + validating 指针，disabled→suspect

任一 step：
  · 先落库（project_mode_transitions.step/status/last_error + project.mode_transition_step）再执行；
  · 执行成功推进 step；commit-mode 成功即 completed（原子切 execution_mode + 清指针）；
  · 硬失败置 failed（可 retry，从 durable step 幂等重入）；
  · 超 24h deadline → failed + expired_at + RecoveryIsolation(object_type='mode-transition')，
    project 保持 paused，retry 拒绝（TRANSITION_EXPIRED），关闭走三步分权。
```

### 1.2 运维驱动

```bash
# 创建（创建即执行 pause；auto=true 自动推进到终态）
curl -X POST http://localhost:3000/v2/projects/$PID/mode-transitions \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"to_mode":"read_only","reason":"ref ACL 丢失","auto":true}'

# 单步驱动（owner；未收口时返回 waiting + pending 清单）
curl -X POST http://localhost:3000/v2/projects/$PID/mode-transitions/$TID/advance \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' -d '{}'

# 单步循环自动推进
curl -X POST .../mode-transitions/$TID/advance -d '{"auto":true}'

# 进度查询（steps 投影：done/pending/failed；status 含 expired）
curl http://localhost:3000/v2/projects/$PID/mode-transitions/$TID -H "Authorization: Bearer $OWNER"

# 步骤失败重试（从 durable step 续跑；expired 不可重试）
curl -X POST .../mode-transitions/$TID/retry -d '{}' 
```

控制面重启：服务启动扫描 running transition，未过期者从 durable step 续跑一步（后续由 advance 接力），超期者自动置 expired + 隔离留证。apiRoutes 双注册已按 store 去重，单次启动只续跑一轮。

---

## 2. full→read-only 写 lineage 收口清单（22.3-18）

模板（`DRAIN_CHECKLIST_TEMPLATE`，§12.1.1 六类）：

| 类别 | 枚举来源 | 收口动作 | 收口判据（reconcile 等待条件） |
|------|----------|----------|-------------------------------|
| write-attempt | task_attempts（pending/claiming/executing） | fence → pending_recovery | 无 ACTIVE 写 Attempt |
| delivery | proposed/pending_review/reviewing/pending_recovery/accepted/merging | invalidated(remote-ref-acl-lost) + BranchCleanup(mode_transition) | 无非终态写 lineage Delivery |
| merge-job | queued/running | cancelled(remote-ref-acl-lost) | 无 queued/running MergeJob |
| recovery-candidate | status=pending | 裁决（takeover/discard）或隔离 | 全部裁决或隔离（isolated 不阻塞） |
| write-task | 非终态写任务 | blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY，移出 pending | 无静默 pending 写任务 |
| blocked-dependent-task | 依赖写 lineage 的只读/验收任务 | blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY_DEPENDENCY | 无静默 pending 下游只读任务 |

未收口完成：transition 停在对应 step（waiting），advance 响应 `pending[]` 逐项报告；execution_mode 不切换（原子性）。收口完成后 commit-mode 一次性切换 `execution_mode=read-only-acceptance + write_capability_status=disabled + status=active`。

---

## 3. 恢复 full 与离线 Node（22.3-21）

- 切换条件**不含**「全部 Node 在线」：refresh-bindings 只同步 online/degraded/draining 节点的 `applied_policy_revision` 并恢复 `eligible`；离线/quarantined 节点 binding 持久 `write_credential_status=suspended`（旧 push credential 无效），不阻塞恢复。
- 离线 Node 回归：先 register/heartbeat 上线，再调 binding 重同步，对齐当前 policy revision 后才恢复 eligible（才可签发新短期 push credential）：

```bash
curl -X POST http://localhost:3000/v2/projects/$PID/nodes/$NID/binding-resync \
  -H "Authorization: Bearer $OWNER" -d '{}'
# 未上线 → NODE_NOT_ONLINE（40x）；成功 → eligible + applied_policy_revision=当前 revision
```

---

## 4. Recovery decision 签名（22.4-26/27）

- takeover/discard 决策以控制面 signing key（复用 V2 credential keyring，env ∪ DB 轮换密钥）HMAC-SHA256 签名；keyring 不可用 → fail-closed `NOT_CONFIGURED`，绝不签发/接受无签名裁决。
- 信封 canonical 字段序：`schema_version, candidate_id, candidate_revision, attempt_id, decision, decided_by, issued_at, expires_at, key_id`；TTL = 15 分钟（`RECOVERY_DECISION_TTL_MS`）。
- 校验链（按序）：MISSING_FIELDS → SCHEMA_VERSION_UNSUPPORTED → SIGNATURE_INVALID（含未知/已 revoke key_id）→ DECISION_EXPIRED（now ≥ expires_at）→ DECISION_ISSUED_IN_FUTURE（issued_at 超前单调坐标超容差）→ REVISION_STALE（信封 revision ≠ candidate 当前 revision）→ DECISION_NOT_MONOTONIC（issued_at < candidate revision 时间 − 5 分钟容差）→ CANDIDATE_MISMATCH → DECISION_ALREADY_CONSUMED（一次性，防重放）。
- 决策信封留档在 `orphan_recovery_candidates.decision_envelope`，消费时间 `decision_consumed_at`；consume/consume 重放事件入审计。

## 5. 控制面 takeover 三崩溃点（22.4-29）

阶段：`decide`（CAS pending→decided，revision+1）→ `fence-attempt`（executing 且 lease 过期 → pending_recovery）→ `release-task`（task.active_attempt_id===旧 attempt 才回 pending）。任一点崩溃后重入按 durable 状态续跑，不重复 CAS、不产生双 attempt；新 attempt 已被其它节点 claim 后重入为 no-op（不触碰新 attempt/任务指针）。lease 未过期时 takeover 前置失败 `TAKEOVER_PRECONDITION_FAILED`。

## 6. batch 逐项结果（22.4-31）

`POST /v2/recovery-candidates/batch-actions` 响应逐项：

```json
{ "results": [
  { "candidate_id": "c1", "ok": true,  "candidate_revision": 1, "final_status": "decided", "error_code": null, "error_message": null },
  { "candidate_id": "c2", "ok": false, "candidate_revision": null, "final_status": null, "error_code": "NOT_FOUND", "error_message": "candidate c2 不存在" }
] }
```

单项失败不影响其余；重试时已成功项幂等返回当前 revision/终态，不重复递增。

## 7. RecoveryIsolation 三步分权（22.4-06）

```
isolated ──(reviewer 复核，reviewed_by ≠ isolated_by，强制)──> under-review ──(reconcile-service resolve，evidence 必填)──> resolved
   │                                                                            ↑
   └─ dispute：保持 isolated，不写 reviewed 字段                    resolve 前置 = 已 under-review
```

```bash
# 1) isolator 创建
curl -X POST http://localhost:3000/v2/recovery-isolations -d '{
  "project_id":"$PID","object_type":"remote-ref","object_id":"refs/heads/x",
  "evidence":"残留 ref 证据","reason":"...","isolated_by":"ops-a"}'
# 2) 独立 reviewer 复核（同人 → SELF_REVIEW_FORBIDDEN）
curl -X POST .../recovery-isolations/$IID/review -d '{"reviewed_by":"rev-b","verdict":"confirm","evidence":"..."}'
# 3) reconcile 服务 resolve（其它身份 → RESOLVER_NOT_ALLOWED）
curl -X POST .../recovery-isolations/$IID/resolve -d '{"resolved_by":"reconcile-service","resolution":"evidence digest 一致"}'
```

create/review/resolve 全链写 audit_events（`recovery_isolation.create / .review.confirm|.review.dispute / .resolve`）。同一对象重复 create 幂等返回未 resolved 的既有记录。

## 8. 超期处置（22.4-05 衔接）

24h deadline 超期由推进器自动处置：transition → failed + `expired_at` + RecoveryIsolation(object_type='mode-transition') + critical Incident；项目保持 paused。关闭隔离必须走第 7 节三步分权；关闭后如需继续切换，创建新 transition（旧 transition 不可 retry）。
