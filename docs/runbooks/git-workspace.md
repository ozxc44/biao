# Git Workspace 与 Delivery 运维手册

> Phase 4 交付 · 对应 docs/distributed-multi-node-development-plan.md §6（Git 工作空间）、§4.5（Delivery）、§7.3（Git Diff 二次门禁）、§4.4.2（BranchCleanup）

## 1. 概述

Git Workspace 是 V2 的代码交付通道：源代码真相源是 Git Remote（§6.1），Biao 数据库只保存
执行、证据、决策与合并审计。每个 task attempt 在独立的工作区内完成
"prepare（准备）→ Agent 执行 → finalize（commit_and_push）→ Delivery（评审交付）"。

- 控制面：状态机编排、ownership 门禁、服务端独立 diff 复核、Delivery 状态机、BranchCleanup；
- Node 侧：clone/commit/push 的实际执行。**Phase 4 在服务端测试进程内模拟 Node 侧执行**
  （`createWorkspaceService` 直接驱动 Git Provider），daemon 真接线见 §8 收尾项。

## 2. 状态机

### 2.1 Workspace Prepare（§6.4）

```
pending ──→ cloning ──→ checking_base ──→ creating_branch ──→ ready
  │            │              │                  │
  │            │（瞬时失败：网络/超时/被杀，可重入重试）
  │            ▼              ▼                  ▼
  └──→ failed:disk_watermark   failed:remote_fingerprint_mismatch
       failed:base_unreachable
       failed:marker_write_failed
       failed:attempt_invalid          （全部为终态，重入不再推进）
```

七项检查（§21 Phase 4 警示清单）与落点：

| # | 检查项 | 状态/步骤 | 失败终态 |
| --- | --- | --- | --- |
| 1 | 磁盘水位（R1C-007，默认 ≥85% 拒绝**新** prepare；中断重入不重复受罚） | pending | `failed:disk_watermark` |
| 2 | clone-per-attempt 目录（`<node_cache>/<project_id>/<attempt_id>`，§6.2/§6.6） | cloning | 瞬时失败可重入；半成品目录整体丢弃重克隆 |
| 3 | remote fingerprint 匹配 project 注册值 | checking_base | `failed:remote_fingerprint_mismatch` |
| 4 | base 分支可达（`git merge-base` 校验服务端声明的 base_sha） | checking_base | `failed:base_unreachable` |
| 5 | attempt 分支创建（§6.3 `refs/heads/biao/attempt/<attempt-id>`） | creating_branch | 瞬时失败可重入 |
| 6 | signed attempt marker 写入（owner-only 0600，R1C-005） | creating_branch | `failed:marker_write_failed` |
| 7 | ready（Agent 才允许启动） | ready | — |

fingerprint 语义：`v1:<anchor_sha>:<sha256(url\nbranch\nanchor)>`。anchor 是项目注册（或首次
prepare 补登记）时默认分支的 head commit；prepare 校验 anchor 仍是默认分支历史的祖先——
换仓、默认分支 force 改写判 mismatch；fast-forward 不受影响。仓库 URL 变更必须走显式 rebind。

### 2.2 Workspace Finalize（§6.5）

```
idle ──→ committing ──→ pushing ──→ delivering ──→ delivered
              │            │             │
              │            │             └──(artifact 未 complete)──→ pending_recovery
              ▼            ▼                          │ 补传后收敛
   failed:ownership_violation   failed:cas_conflict    ▼
   failed:ownership_snapshot_missing（fail-closed）  delivered
   failed:server_verify_failed
   failed:push_failed / marker_invalid（终态）
```

关键顺序（不可调换）：

1. `git add -A` + commit（marker 经 `.git/info/exclude` 排除，且 commit 前 fail-closed 校验
   排除文件未被暂存）；
2. `git diff --name-only base..HEAD` 与 ownership_snapshots 的 write_globs 比对，越界 →
   `failed:ownership_violation`，**不 push、不生成 delivery**；
3. CAS：`git ls-remote` 确认 `refs/heads/biao/attempt/<id>` 预期不存在；已存在 → 生成
   `invalidated`（reason=remote-ref-exists）delivery 留审计 + `failed:cas_conflict`；
4. `git push --atomic` 同推 task branch 与 `refs/biao/attempt-markers/<attempt-id>`
   （signed marker 带 head_sha，R1A-001/R1C-005）；
5. 服务端从 bare remote 独立复核（见 §4），通过才落 delivery；
6. artifact 引用全部 complete → `pending_review`；否则 `pending_recovery`。

### 2.3 Delivery（§4.5，Phase 4 语义）

```
pending_recovery ──(artifact 补齐)──→ pending_review ──→ reviewing ──→ accepted
                                             │                    └──→ rejected（落 BranchCleanup）
                                             └──(远端不一致/复核失败)──→ invalidated（落 BranchCleanup）
```

- `invalidated` 触发：branch head 被外部改写（branch-head-changed）、base 不可达
  （merge-base-unreachable）、marker 验签失败（marker-invalid）、CAS 冲突（remote-ref-exists）；
- §7.3：ownership 越界由服务端复核发现 → **rejected**（强制，PM 不能用普通 accept 绕过，
  进入 Question/repair 通道）；
- 005 的 `proposed` 等历史状态保留兼容（Phase 2 report 雏形）。

## 3. 分支与 marker 规范

| 对象 | 规范 |
| --- | --- |
| task branch | `refs/heads/biao/attempt/<attempt-id>`；attempt-id 仅 `[A-Za-z0-9._-]`，完整 ref 落库（§6.3，不靠重拼接猜测） |
| marker ref | `refs/biao/attempt-markers/<attempt-id>`（blob，指向 canonical JSON 信封） |
| marker 文件 | 工作区根 `.biao-attempt.json`，owner-only 0600，`.git/info/exclude` 排除，绝不进入 task branch |
| marker 内容 | `schema_version, attempt_id, task_id, attempt_generation, node_id, signing_key_generation, branch_ref, base_sha, head_sha, bva2_digest, created_at` 的键排序 canonical JSON + HMAC-SHA256 签名 |
| bva2 摘要 | prepare 时校验 bva2 Attempt token（scope=ownership）后取 sha256 摘要；token 原文不落库 |
| 签名密钥 | Phase 4 以控制面 credential keyring 的对称密钥为进程内替身（signing_key_generation=key_version）；真 Node 非对称密钥见 §8 |

服务端验签（delivery-service）：按 marker 声明的 signing_key_generation 选登记密钥，
canonical JSON 重算签名（timing-safe 比对）+ 身份字段（attempt/task/generation/branch/head/
digest）逐一核对；缺失、验签失败、generation 无对应密钥都按 marker-invalid 处置。

## 4. 服务端 diff 二次门禁（§7.3）

Delivery 创建与复核（`POST /v2/deliveries/:id/verify`）时，服务端**不信任 Node 上报的
changed_files**，而是：独立 `git clone --no-checkout` bare remote → ref CAS（head 一致）→
base 可达 → marker 验签 → `git diff --name-only/--numstat base..head` 与 ownership
write_globs 比对。结果（文件清单 + ± 统计，不含正文）写入 deliveries.diff_summary，
`server_verified=1`。任何一步失败：远端不一致 → invalidated；ownership 越界 → rejected。

## 5. 中断恢复与孤儿处理（§6.6）

- 状态机每步**先落库再执行**；进程任意时刻被杀死，重入都从持久状态收敛（cloning 半成品
  目录整体丢弃重克隆；delivering 重入按 `(attempt_id, head_sha)` 唯一约束幂等复用 delivery）；
- 瞬时失败（网络/超时/输出超限）留在当前状态可重试；确定性校验失败才落 `failed:*` 终态；
- `POST /v2/workspace-recovery/scan`：prepare/finalize 停留在执行中**且 attempt lease 已过期**
  的工作区 → 幂等落 `orphan_recovery_candidates`（每 attempt 至多一条 pending，§20.3），
  recovery_path=control-plane-takeover；恢复裁决流程属后续 Phase。

## 6. BranchCleanup（§4.4.2/§6.6）

- 触发：delivery 进入 `rejected/superseded/conflict/integration_failed/invalidated` 终态时
  幂等落 `branch_cleanups` 记录（唯一键 delivery_id+branch_ref+expected_head_sha）；
- 保留期：`eligible_at = 触发时间 + 保留期`（默认 **30 天**，`BRANCH_CLEANUP_RETENTION_MS`）；
- 到期执行（`POST /v2/branch-cleanups/run`）：再次校验远端 HEAD——
  - HEAD == expected_head_sha → 删除远端 ref → `deleted`；
  - ref 已不存在 → 幂等视为 `deleted`（不报错、不重试）；
  - HEAD 已变化 → `failed` + last_error 留人工裁决，**绝不盲删**；
- 普通节点/Worker 永不直接删远端分支；marker 至少保留到 branch 删除且 Delivery/Candidate
  终态后再 30 天，GC 顺序为先清 DB 证据链确认、再删 marker。

## 7. 磁盘水位（R1C-007）

| 参数 | 默认 | 行为 |
| --- | --- | --- |
| `diskWatermarkPercent` | 85 | 工作区缓存盘使用率 ≥ 阈值时**拒绝新 prepare**（`failed:disk_watermark`） |
| 注入点 | `diskUsagePercent()` | 缺省对 node_cache 根做 statfs 实测；测试与 daemon 可注入 |

## 8. daemon 接线收尾项清单（Phase 3 biao-node → Phase 4 服务端）

1. **marker 签名密钥**：换成 Node enrollment 时本地生成的非对称密钥（私钥进 OS
   Keychain/Credential Manager，公钥+signing_key_generation 入 Node Registry）；控制面按
   node_id+generation 选公钥验签；quarantine/revoke 连同轮换；
2. **workspace 执行下沉**：`createWorkspaceService` 的 clone/commit/push 逻辑移入 biao-node
   daemon（§10.1 一个节点一个守护进程），服务端只保留编排与复核；协议沿用
   `/v2/attempts/:id/workspace/{prepare,finalize}`（bva2 scope=ownership/report）；
3. **worktree 模式**：`checkout_mode=worktree` 的项目共享 `mirror.git` + `git worktree add`
   （§6.6）；当前实现为 clone-per-attempt（无共享 `.git/worktrees` 跨机约束）；
4. **mirror 维护**：Node 定期 `git maintenance run --auto`，低水位先停新 claim 再受限 GC，
   仍低于恢复阈值保持 degraded；
5. **ownership snapshot 接线**：claim 路径自动写 ownership_snapshots（当前 finalize 对无快照
   attempt 按 fail-closed 拒绝）；
6. **recovery decision**：orphan candidate 的 takeover/decision envelope（§4.4.1 签名裁决）。

## 9. git 调用清单与安全约束

| 能力（GitProvider） | git 命令 | 用途 |
| --- | --- | --- |
| clone | `git clone [--no-checkout] [--branch B] <url> <dir>` | 工作区/服务端复核克隆 |
| fetch | `git fetch --prune --no-tags origin` | 重入刷新 |
| push | `git push [--atomic] origin <refspec...>` | branch+marker 原子推送 |
| deleteRemoteRef | （一次性空仓库）`git push <url> :<ref>` | BranchCleanup 删除 |
| lsRemote | `git ls-remote <url> [ref]` | fingerprint/CAS/ref 复核 |
| readRef / writeRef | `git rev-parse --verify --quiet <ref>` / `git update-ref` | HEAD 与分支创建 |
| diffStat / diffNameOnly | `git diff --numstat / --name-only base..head` | ownership 门禁与 diff 摘要 |
| mergeBase | `git merge-base A B` | base 可达 / 锚点连续性 |
| checkoutNewBranch | `git checkout -b <name> <sha>`（幂等） | attempt 分支 |
| statusPorcelain | `git status --porcelain` | 工作树诊断 |
| commitAll | `git add -A` + 排除校验 + `git commit` | finalize |
| hashObject | `git hash-object -w --stdin` | marker blob |
| readBlob | （一次性 bare 仓库）`git fetch <url> <ref>` + `git cat-file -p` | 服务端 marker 验签 |

硬性约束（generic-git 适配器）：

- **execFile 参数数组直传，不经 shell**——refspec/路径/消息零拼接注入面；
- **超时**：单命令默认 30s（`SIGKILL`），可按部署调整；
- **输出上限**：stdout+stderr 合计默认 2 MiB，超限即杀（防恶意大输出）；
- **全局 `-c core.autocrlf=false -c core.quotepath=false -c gc.auto=0`**（§19.2：不让本机
  line-ending 配置改写工作树真相；非 ASCII 路径原样输出，diff 门禁不被转义绕过）；
- **GIT_TERMINAL_PROMPT=0**：凭据缺失立即失败而不是挂起等输入；
- **路径规则**：工作区仅允许 `<node_cache>/<project_id>/<attempt_id>` 内操作；ref 只接受
  `refs/heads/biao/attempt/*` 与 `refs/biao/attempt-markers/*` 两个命名空间（由服务端构造，
  用户输入不参与 refspec 拼接）；
- **凭据**：带明文密码的 Git URL 禁止入库/日志；凭据只存在于 Secret Provider 或节点本地
  Credential Manager/SSH Agent（§4.1）。

## 10. 相关路由（registry 条目）

```
POST /v2/attempts/:attempt_id/workspace/prepare     bva2(ownership)/node
POST /v2/attempts/:attempt_id/workspace/finalize    bva2(report)/node
GET  /v2/attempts/:attempt_id/workspace             human_owner/reviewer_pm
POST /v2/workspace-recovery/scan                    human_owner/recovery_reviewer
POST /v2/deliveries/:delivery_id/verify             human_owner/reviewer_pm
POST /v2/deliveries/:delivery_id/review/start       reviewer_pm
POST /v2/deliveries/:delivery_id/review             reviewer_pm（自动 pending_review→reviewing）
POST /v2/deliveries/:delivery_id/recover-artifacts  bva2(report)/node/human_owner
GET  /v2/branch-cleanups                            human_owner
POST /v2/branch-cleanups/run                        human_owner
POST /v2/branch-cleanups/:cleanup_id/retry          human_owner
```

## 11. 数据表（007 迁移）

- `attempt_workspaces`：双状态机 durable 状态（attempt_id 主键；prepare_state/finalize_state
  CHECK 约束 + `failed:%` 前缀终态）；
- `deliveries`（重建）：status 追加 `pending_review/reviewing/pending_recovery`，新增
  `diff_summary`（服务端复核摘要 JSON）与 `server_verified`；旧数据原样迁移；
- `branch_cleanups` / `orphan_recovery_candidates`：复用 003 最小 schema。

测试基线：`tests/distributed/p4-git-workspace.test.ts`（20 用例，真实 git 子进程 + 自建
bare remote，不 import fixture）。
