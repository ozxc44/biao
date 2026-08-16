# Phase 4：Git Workspace 与 Delivery（git-fixture 之上，独立 Prepare/Finalize 状态机）

## 前置状态

Phase 1-3 + 2/3 集成门禁全部验收（review log 有记录）。可用积木：
- 0b `tests/distributed/fixtures/git-fixture.ts`（bare remote、push/clone/CAS 断言）——服务端实现可参考语义，**不得 import fixture**
- bvn2/bva2 凭据与 V2 路由（claim/renew/report 已接通，006 task_attempts）
- Phase 2 Artifact Store（deliveries 表已在 005）
- 全量基线 **114 文件 / 1283 用例**（唯一已知 flaky：supervisor-pm-agent-cli SIGINT/SIGTERM 孙进程竞态，单独复跑恒绿）

先读：方案 §6（Git 工作空间：6.1 真相源 / 6.2 本地仓库 / 6.3 分支命名 / 6.4 Workspace Prepare / 6.5 Workspace Finalize / 6.6 worktree vs clone / 6.7 非文本文件）、§4.5（Delivery 状态机）、§7.3（Git Diff 二次门禁）、§21 Phase 4 原文与"工作量按独立 Prepare/Finalize 状态机估算"的警示（至少覆盖 remote fingerprint、base reachability、attempt marker、磁盘水位、signed branch marker、Artifact 中断、孤儿分支——**不能把本地 snapshot/report 视为已完成**）。

## 目标

1. **Git Provider Interface** `src/server/v2/git/provider.ts`：能力接口（clone/fetch/push/lsRemote/readRef/writeRef/diffStat/mergeBase）+ `generic-git` 适配器（`src/server/v2/git/generic-git.ts`，shell 出 `git`，跨平台 `-c core.autocrlf=false` 等 §19.2 约束）；无 GitHub API 依赖（§6.1 真相源=Git 本身）。
2. **Workspace Prepare 状态机**（`src/server/v2/git/workspace.ts`，服务端控制、Node 执行分离——本阶段在**服务端测试进程内**模拟 Node 侧执行，Phase 3 daemon 的真接线在收尾项）：`prepare(attemptId)` 状态机 `pending→cloning→checking_base→creating_branch→ready`（+`failed:*` 终态），每步幂等可重入；检查项：remote fingerprint 匹配 project 注册值、base 分支可达（mergeBase 校验）、attempt marker 写入（signed marker：内容=attempt_id+task_id+generation+bva2 摘要，R1C-005）、磁盘水位（§R1C-007 阈值默认 85% 拒绝新 prepare）、clone-per-attempt 目录布局（`<node_cache>/<project>/<attempt-id>`，§6.6）。
3. **Workspace Finalize**：`commit_and_push(attemptId)`——branch 命名（§6.3 `biao/attempt/<attempt-id>`）、只允许 attempt ownership 内文件进入 commit（`git diff --name-only base..HEAD` 与 ownership_snapshots write_globs 比对，越界文件→拒绝+状态 `failed:ownership_violation`）、push 到 bare remote（CAS：remote ref 预期不存在，存在即 `invalidated`，R1A-001）、生成 delivery（head_sha+branch_ref+attempt 绑定，接 Phase 2 deliveries 表）。
4. **服务端 diff 验证**（§7.3 二次门禁）：delivery 提交时服务端对 bare remote 做独立 `git diff --name-only` 复核（不信任 Node 上报），与 ownership 比对；结果写入 delivery 记录。
5. **Delivery 状态机**（§4.5）：`pending_review→reviewing→accepted|rejected|invalidated`（invalidated：remote mismatch/force-push 检测——mergeBase 不可达或 ref 被外部改写）；PM Review V2 视图补充 diff 摘要（文件清单±统计，不含正文）。
6. **孤儿分支与中断恢复**：prepare/finalize 中断（进程杀死）后重入——`pending_recovery` 扫描（复用 orphan_recovery_candidates 表）+ 过期 attempt 分支清理任务（branch_cleanups 表落记录，eligible_at 保留期后由清理函数删 remote ref）。
7. **失败优先测试** `tests/distributed/p4-git-workspace.test.ts`（真实 git 子进程 + git-fixture 同款 bare remote 语义，自建临时 bare）：
   - **两节点并行改不同文件互不覆盖**（§21 验收原文：两 attempt 各自 clone→各自分支→push→两个 delivery 并存，bare remote 两分支共存）；
   - **Ownership 外文件被拒**（attempt 在 ownership 外文件提交→finalize 拒绝、delivery 不生成）；
   - **force-push/remote mismatch 被拒**（外部改写 ref→CAS 失败→invalidated）；
   - Prepare 各失败分支：fingerprint 不匹配、base 不可达、磁盘水位超限（可注入）、marker 写失败；中断重入（cloning 中途 kill→重入收敛）；
   - Artifact 中断场景：finalize 成功但 artifact 上传中断→delivery `pending_recovery`→补传后收敛。
8. runbook `docs/runbooks/git-workspace.md`（中文）：状态机图、分支/marker 规范、清理保留期、水位阈值。

## 约束

- 全程中文；**所有权**：`src/server/v2/git/**`、`src/server/v2/routes/`（workspace/delivery 组）、`src/server/v2/delivery-service.ts`（如单列）、`src/db/**`（如需 007 迁移扩展 deliveries/orphan/branch_cleanups 字段）、`src/types/**`（v2 追加）、`tests/distributed/p4-*.test.ts`、受影响版本期望测试（**版本期望用链条连续性断言风格，勿硬编码终态号**）、runbook。**不得改**：`src/node/**`（daemon 接线属收尾项，本阶段服务端进程内模拟）、`src/server/service.ts`、`src/server/http-plugins.ts`、`src/mcp/**`、`web/`、既有 fixture。
- git 子进程超时与输出上限（防恶意大输出）；不新增 npm 依赖；不新增 `*_TEST_REDIS_URL`；不启动生产栈。
- 门禁：构建 + 全量不劣化 114/1283 基线。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿；全量复跑不劣化（known flaky 单独复跑）。
2. §21 Phase 4 验收原文三项 + Prepare/Finalize 状态机七检查项逐项有测试路径（交付说明列表对照）。
3. 交付说明：状态机图（文字）、git 调用清单与安全约束（输出上限/超时/路径规则）、daemon 接线收尾项清单。
