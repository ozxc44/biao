# Biao 局域网多机协同开发改进方案

> 文档版本：v0.8.0-round7-revision
>
> 状态：已通过 Round 8 三路终局复核，方案收敛；等待用户进一步实施指令
>
> 日期：2026-08-15
>
> 适用代码基线：`129ab73` 及其兼容后续
>
> 文档目标：把当前本地优先的多 Agent 协作平台演进为可在局域网多台电脑上共同开发同一项目、独立验收并安全合并的分布式研发控制面。

## 0. 文档规则

### 0.1 本文是什么

本文是架构、协议、数据、实施、迁移、验收与运维的完整修改方案，不是代码实现授权。用户确认进入实施阶段之前，只允许继续评审和修订本文档，不启动真实功能开发。

### 0.2 完成定义

方案审评收敛必须同时满足：

1. 不存在未关闭的 Critical 或 High 问题；
2. Medium 问题已修订或明确记录延期理由、风险所有人和重新决策门槛；
3. 至少一轮复评没有新增 Critical/High；
4. 架构、安全、实施、测试和运维视角均给出 `APPROVE`，或只剩不阻塞实施的 Low 建议；
5. 主会话逐项核对审评意见与实际文档，不以 Worker 的 verdict 代替最终验收。

### 0.3 兼容原则

- 保留现有单机 Local-First 模式；
- 分布式能力通过 `/v2` 协议和显式配置启用；
- 不用一次大爆炸重写取代已经稳定的 Lease、Ownership、Question、repair、reverify 和 PM Review；
- 每个阶段都必须允许回退到上一个可运行版本；
- 所有跨机器身份使用逻辑 ID，不把本机绝对路径作为网络协议身份。

## 1. 执行摘要

### 1.1 核心结论

多机版 Biao 不应建立“所有电脑共同写一个 NAS 工作目录”的模型，而应建立：

```text
中央 Biao 控制面
  + Git 代码真相源
  + 中央制品存储
  + 每台电脑一个 biao-node
  + 每个 Task Attempt 一个隔离工作区和分支
  + 独立验收绑定不可变 commit
  + 单写者 Merge Queue
```

### 1.2 为什么不能只增加共享目录和监视脚本

当前系统仍有以下隐含同机假设：

- Plan、Task 和 Worker 用绝对 `project_path` 标识项目；
- Plan Submit 要求服务端读取本机 `plan_dir`；
- Worker 把结果写入项目的 `work/<task_id>/`；
- Report 和 PM Review 由服务端再次打开这些本地路径；
- Ownership 以全局 glob 记录，缺少 `project_id` 命名空间；
- Agent 只有 `agent_id`，没有机器、资源、协议版本和仓库状态；
- 本机 Supervisor 只能证明进程存在，不能证明远端项目副本、分支、制品和合并状态正确。

因此，多机化的真正改造对象是项目身份、工作副本、交付证据、节点生命周期和合并真相，而不只是增加两段脚本。

### 1.3 推荐 MVP

第一阶段产品边界：

- 一个中央 Biao 控制面；
- 一个中央 Redis；
- SQLite 继续由中央服务单写，并位于中央机器本地磁盘；
- 一个 Git Remote；
- 一个由 Biao 服务写入的内容寻址制品目录；
- 2–5 台局域网节点；
- 每任务独立 branch/worktree；
- 一个串行 Merge Queue；
- 节点独立凭据；
- 保留单机 V1 兼容模式。

第一阶段不做控制面 HA、Kubernetes 弹性扩缩、多租户计费或全 Git Provider PR API 覆盖。

## 2. 当前架构与证据

### 2.1 当前主链路

```text
Plan Markdown 解析/校验
→ Redis Stream 与 pending/running 状态
→ Agent register/claim
→ Lease + 文件 Ownership
→ Worker 在 project_path 执行
→ Verify
→ result.md/result.json
→ report
→ SQLite 双写与 Redis 恢复
→ 独立 acceptance
→ PM Review
→ repair/reverify 闭环
```

### 2.2 应保留的成熟能力

| 能力 | 处理策略 | 原因 |
| --- | --- | --- |
| Claim Token 与 Lease | preserve | 已形成 stale claim fencing 基础 |
| Agent registration generation | extend | 可扩展为 node/slot/attempt 三层 fencing |
| 文件 Ownership | extend | 语义正确，但必须项目化和 commit 化 |
| Verify 逐项上报 | preserve | 是可信交付核心 |
| 独立 acceptance | extend | 增加 node/harness/commit 独立性 |
| PM Review | preserve | 仍是人类或 PM Agent 最终业务决策边界 |
| Question | preserve | 继续承担产品决策和最小扩权请求 |
| repair/reverify | preserve | 继续承担失败闭环，不改写原审计 |
| Redis + SQLite 恢复 | extend | 增加 Git、Artifact 与 Delivery 对账 |
| 共享 Supervisor | replace/extend | 分布式模式升级为正式 biao-node |

### 2.3 必须替换的同机耦合

| 当前字段/路径 | V2 替代 | 兼容策略 |
| --- | --- | --- |
| `project_path` | `project_id` + Node 本地 binding | V1 继续接受绝对路径 |
| `preferred_project` | `preferred_project_ids` | V1 转换层映射 |
| `plan_dir` 服务端路径 | Plan Snapshot 上传 | 本机 CLI 可自动读取后上传 |
| `result_path` | `artifact_id` + digest | V1 local-only 路径仍保留 |
| `changed_files` 自报 | 服务端 Git diff 事实 | 自报只作诊断 |
| 全局 `file_ownership` | `project_id + repo path` | Redis V2 namespace |
| 全局 Worker Token | Node Credential + Attempt Token | 单机模式保持旧 Token |
| 本机 Supervisor lock | Node Instance Lease + 本机锁 | 两层同时存在 |

V2 Project 一经启用，所有 V1 `POST/PATCH/DELETE` mutation（包括 plan create/submit/supersede、claim、report、renew、question create/answer、review、repair/reverify、resolution、Ownership 与 task block/resume/reset/cancel/supersede）都必须以项目模式门禁拒绝其任务；实现必须从 V1 route registry 生成门禁覆盖测试，不能靠手抄清单；旧 Worker Token 只能处理仍为 V1 local-only 的 Plan。禁止任何 V1/V2 混合链路。

生成测试对非项目业务路由使用显式分类，而不是漏测：`register/heartbeat/agent-offline` 属 legacy agent lifecycle，只接受 V1 agent credential，且永远不能取得或修改 V2 Attempt；`intake/ack` 属 PM event transport，只确认事件投递，不改变 V2 Task/Delivery/Review 业务状态；`db/restore/reconcile` 属 maintenance 路由，只接受维护身份与 maintenance barrier，并调用版本感知的恢复服务，不接受 Worker Token；health/status/read-only 查询不属于 mutation。每条 registry route 必须标记 `project-mutation / legacy-lifecycle / pm-transport / maintenance / read-only` 之一，测试对每类生成确定期望，未分类路由构建失败。

### 2.4 V1 路径身份到 V2 项目身份的确定性映射

升级不对绝对路径直接做 hash，因为同一仓库在不同 OS、不同目录下必须映射为同一 Project。迁移顺序固定为：

1. 管理员或本机 Owner 用 `repository_url + remote fingerprint + default branch` 创建 `ProjectRecordV2`，生成随机 `project_id`；
2. 控制面扫描 V1 `plans/tasks.project_path`，读取其 Git remote/fingerprint；无法读取、无 Git 或 fingerprint 冲突的条目进入 `migration_blocked`，不得自动猜测；
3. 生成显式的 `legacy_project_bindings(legacy_project_path, project_id, repository_fingerprint, verified_at)`；
4. V1 请求只可通过这张绑定表转换到 V2，Node 的本地路径只写入 `NodeProjectBindingV2`；
5. 非 Git V1 项目继续保持 local-only，直到人工初始化 Remote 并确认 fingerprint；
6. 迁移报告列出 mapped/blocked/conflict，操作者确认后才允许对该 Project 开启 V2 claim。

迁移脚本必须可重复运行；同一路径和 fingerprint 重放返回原绑定，不创建第二个 Project。仓库 URL 改变必须走显式 rebind 并保留审计。

## 3. 目标架构

### 3.1 逻辑组件图

```text
┌───────────────────────────────────────────────────────────────────┐
│                           Human / PM                              │
│                    Browser · CLI · PM Agent                       │
└──────────────────────────────┬────────────────────────────────────┘
                               │ HTTPS + Human Identity
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Biao Control Plane                           │
│ Project Registry · Plan/Task · Scheduler · Review · Merge Queue   │
│ Node Registry · Artifact API · Audit · Reconcile                  │
└───────────────┬───────────────────┬───────────────────┬───────────┘
                │                   │                   │
                ▼                   ▼                   ▼
        Redis Runtime       Durable Database      Artifact Store
        queue/lease/own      SQLite → Postgres     content-addressed
                │
                │ HTTPS outbound pull/stream
       ┌────────┴───────────┬──────────────────────┐
       ▼                    ▼                      ▼
┌─────────────┐      ┌─────────────┐        ┌─────────────┐
│ biao-node A │      │ biao-node B │        │ biao-node C │
│ repo cache  │      │ repo cache  │        │ repo cache  │
│ worktrees   │      │ worktrees   │        │ worktrees   │
│ agent slots │      │ agent slots │        │ agent slots │
└──────┬──────┘      └──────┬──────┘        └──────┬──────┘
       └────────────────────┴───────────────────────┘
                            │ Git SSH/HTTPS
                            ▼
                     Central Git Remote
                            ▲
                            │ only merge-bot writes default branch
                            └──────── Merge Queue
```

### 3.2 部署拓扑

#### 控制面机器

运行：

- Biao Fastify 服务；
- Redis；
- SQLite（MVP）或 PostgreSQL（后续）；
- Artifact Store 本地目录或对象存储适配器；
- Git Mirror/Provider Adapter；
- Merge Queue；
- HTTPS 反向代理。

#### Worker 节点

每台电脑只运行一个 `biao-node`，它管理：

- 节点注册和心跳；
- Agent slots；
- 本地 Git 缓存；
- Task Attempt 工作区；
- Agent 进程树；
- Lease；
- Verify；
- commit/push；
- Artifact 上传；
- 日志、资源和健康状态。

Worker 节点不直接连接 Redis、SQLite 或控制面主密钥。

### 3.3 网络方向

- Node 主动通过 HTTPS 连接控制面；
- Node 主动通过 SSH/HTTPS 连接 Git；
- 控制面不依赖 SSH 进入 Node；
- Redis 只对控制面开放；
- Artifact Store 只通过 Biao API 或短期上传 URL 暴露；
- 远程浏览器必须使用独立 Human Identity，不能签发 loopback Local Owner Cookie。

## 4. 领域模型

### 4.1 Project

```ts
export interface ProjectRecordV2 {
  project_id: string;
  display_name: string;
  repository_provider: 'generic-git' | 'github' | 'gitlab' | 'forgejo';
  repository_url: string;
  repository_fingerprint: string;
  default_branch: string;
  merge_policy: 'merge-queue' | 'provider-pr';
  execution_mode: 'full' | 'read-only-acceptance';
  mode_transition?: 'draining-to-read-only' | 'validating-to-full';
  mode_transition_id?: string;
  mode_transition_step?:
    | 'pause'
    | 'fence-attempts'
    | 'invalidate-lineage'
    | 'block-dependents'
    | 'validate-capability'
    | 'reconcile'
    | 'refresh-bindings'
    | 'revalidate-plans'
    | 'commit-mode';
  write_capability_status: 'ready' | 'suspect' | 'lost' | 'disabled';
  artifact_policy_id: string;
  workspace_policy_id: string;
  status: 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}
```

`degraded` 只是一组运行态健康投影和原因，不加入 `ProjectRecordV2.status`；Project 的 durable `status` 仍只有 `active/paused/archived`。模式切换的每一步及其 idempotency key 记录在 `project_mode_transitions`，Project 上只保存当前指针。

`write_capability_status` 的权威转换为：`ready --单次探测失败→ suspect --连续确认丢失→ lost --完成降级→ disabled`；恢复时只能 `disabled --开始验证→ suspect --验证与对账通过→ ready`。`lost` 先触发即时熔断，不能由 Owner 直接改回 ready；任何验证失败都保持 paused，并通过 Incident 暴露原因。

```ts
export interface ProjectModeTransitionV2 {
  transition_id: string;
  project_id: string;
  from_mode: 'full' | 'read-only-acceptance';
  to_mode: 'full' | 'read-only-acceptance';
  step: NonNullable<ProjectRecordV2['mode_transition_step']>;
  status: 'running' | 'failed' | 'completed';
  idempotency_key: string;
  started_at: string;
  deadline_at: string;
  last_error?: string;
  completed_at?: string;
}
```

服务端按方向校验 step 合法集合：`full→read-only = pause/fence-attempts/invalidate-lineage/block-dependents/reconcile/commit-mode`；`read-only→full = pause/validate-capability/reconcile/refresh-bindings/revalidate-plans/commit-mode`。DB `CHECK` 或 repository validator 与 API schema 使用同一常量；方向不匹配的 step 拒绝写入，生成式状态机测试覆盖全部合法/非法组合。

不允许把带明文密码的 Git URL 写进数据库、Redis、Plan 或 Worker 日志。凭据只存在于控制面 Secret Provider 或节点本地 Git Credential Manager/SSH Agent。

### 4.2 Node

```ts
export interface NodeRecordV2 {
  node_id: string;
  display_name: string;
  os: 'darwin' | 'linux' | 'windows';
  arch: 'arm64' | 'x64' | string;
  node_version: string;
  protocol_version: string;
  status: 'enrolling' | 'online' | 'degraded' | 'draining' | 'offline' | 'quarantined';
  capabilities: string[];
  labels: string[];
  capacity: {
    max_concurrent_tasks: number;
    memory_mb?: number;
    disk_free_mb?: number;
  };
  last_seen_at: string;
  credential_generation: number;
  clock_skew_ms?: number;
  server_cert_not_after?: string;
  trust_anchor_generation: number;
  signing_key_generation: number;
  accepted_control_plane_signing_key_generations: number[];
}
```

### 4.3 NodeProjectBinding

```ts
export interface NodeProjectBindingV2 {
  node_id: string;
  project_id: string;
  local_cache_root: string;
  checkout_mode: 'worktree' | 'clone-per-attempt';
  repository_fingerprint: string;
  last_fetch_sha?: string;
  health: 'ready' | 'syncing' | 'dirty' | 'diverged' | 'unavailable';
  last_checked_at: string;
  authorization_status: 'pending' | 'authorized' | 'revoked';
  authorized_by?: string;
  authorized_at?: string;
  authorization_revision: number;
  applied_policy_revision: number;
  write_credential_status: 'none' | 'eligible' | 'suspended';
}
```

`local_cache_root` 只保存在 Node 本地配置和控制面的受限诊断视图中，不能参与任务身份、Ownership 或跨节点比较。

Node 本地 TOML 只能“请求”绑定，不能自行授权。Human Owner/具备 Project Node Admin 权限的身份必须在控制面确认 `node_id + project_id + repository_fingerprint + allowed secret scopes`；调度过滤要求 binding=`authorized/ready`。revoke 后即使 Node 仍有 Git 凭据也不能 claim、Artifact read 或 Delivery。

### 4.4 TaskAttempt

```ts
export interface TaskAttemptV2 {
  attempt_id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  slot_id: string;
  attempt_generation: number;
  base_ref: string;
  base_sha: string;
  branch_ref: string;
  claim_token_hash: string;
  status:
    | 'preparing'
    | 'running'
    | 'uploading'
    | 'delivered'
    | 'failed'
    | 'lease_lost'
    | 'cancelled'
    | 'orphaned'
    | 'orphan_recovered'
    | 'orphan_discarded';
  started_at: string;
  finished_at?: string;
}
```

Task 保留现有业务状态；Attempt 表示一次实际执行。重试必须创建新 `attempt_id`，不能覆盖旧 attempt。

本文所有 generation 必须带限定语：`attempt_generation`、`node_credential_generation`、`node_session_generation`、`trust_anchor_generation`；API/表字段不得仅以无上下文的 `generation` 跨实体复用。

### 4.4.1 OrphanRecoveryCandidate

`recovery_candidate` 不是 Attempt 或 Delivery status，而是独立 reconcile 记录：

```ts
export interface OrphanRecoveryCandidateV2 {
  candidate_id: string;
  attempt_id: string;
  project_id: string;
  marker_ref?: string;
  branch_ref?: string;
  head_sha?: string;
  bundle_manifest_digest?: string;
  recovery_path: 'node-driven' | 'control-plane-takeover';
  status: 'pending' | 'decided' | 'executing' | 'resolved' | 'isolated';
  decision: 'pending' | 'upload-and-reverify' | 'retain-evidence-only' | 'discard-after-audit';
  takeover_reason?: 'node-offline-timeout' | 'node-revoked' | 'operator-request';
  takeover_at?: string;
  node_ack_status?: 'not-required' | 'pending' | 'acked';
  revision: number;
  decided_by?: string;
  decided_at?: string;
  resolved_at?: string;
  resolution_evidence_digest?: string;
}

export interface RecoveryReconcileRequestV2 {
  attempt_id: string;
  attempt_generation: number;
  manifest_digest: string;
  local_evidence_kinds: string[];
}

export interface RecoveryDecisionEnvelopeV2 {
  schema_version: 2;
  candidate_id: string;
  attempt_id: string;
  attempt_generation: number;
  decision: 'upload-and-reverify' | 'retain-evidence-only' | 'discard-after-audit';
  bundle_manifest_digest: string;
  issued_at: string;
  expires_at: string;
  key_id: string;
  signature: string;
}
```

控制面返回的 recovery decision 使用独立 Control Plane Signing Key，Node 在 enrollment/register 时接收受认证的公钥集合与 generation。canonical payload 固定为 `schema_version, candidate_id, attempt_id, attempt_generation, decision, bundle_manifest_digest, issued_at, expires_at, key_id`；Node 必须校验签名、digest、有效期和本地 attempt 身份后才能执行，`discard-after-audit` 的成功 ack 以 candidate_id 幂等。decision 默认 TTL 为 15 分钟；过期后 Node 只可按 `candidate_id + bundle_manifest_digest` 幂等重新获取，不得沿用旧裁决或自行推断。

有效期以控制面签发的 `issued_at/expires_at` 和最近一次认证 heartbeat 返回的 `server_now` 建立的单调偏移为准；Node 本地墙钟只用于诊断。若偏移过旧、clock skew 超阈值或无法确定 decision 仍在窗口内，Node 必须拒绝并重新 heartbeat/refetch，不使用宽松本地时间延长 TTL。

### 4.4.2 RecoveryIsolation 与 BranchCleanup

```ts
export interface RecoveryIsolationRecordV2 {
  isolation_id: string;
  project_id: string;
  transition_id?: string;
  object_type: 'remote-ref' | 'recovery-candidate' | 'artifact-manifest' | 'ownership-snapshot';
  object_id: string;
  evidence_digest: string;
  reason: string;
  status: 'isolated' | 'under-review' | 'resolved';
  isolated_by: string;
  isolated_at: string;
  retention_until: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_evidence_digest?: string;
  resolved_by?: string;
  resolved_at?: string;
  resolution_evidence?: Record<string, unknown>;
}

export interface BranchCleanupRecordV2 {
  cleanup_id: string;
  project_id: string;
  delivery_id: string;
  branch_ref: string;
  expected_head_sha: string;
  reason: 'rejected' | 'superseded' | 'conflict' | 'integration_failed' | 'invalidated' | 'mode_transition';
  status: 'pending' | 'deferred' | 'deleted' | 'failed';
  eligible_at: string;
  retention_until: string;
  last_error?: string;
  completed_at?: string;
}
```

Isolation 是可审计的 fail-closed 处置，不是“忽略异常”：被隔离对象从正常 reconcile/调度集合排除，但仍计入 Incident、保留期和恢复报告。状态只能 `isolated → under-review → resolved`：原 isolator 提交 resolution evidence 后进入 under-review；具备 Recovery Reviewer 权限且 `reviewed_by != isolated_by` 的独立身份复核通过才写 reviewed 字段；ReconcileService 最后验证 evidence digest 与对象状态后 resolve。任一步与 Audit/outbox 同事务，API 强制 actor 分离。BranchCleanup 由 ReconcileService 单写并以 `delivery_id + branch_ref + expected_head_sha` 幂等，删除前再次校验 HEAD、无 active repair/Question/Candidate/Incident 引用且已过保留期；retry 时 branch 已不存在且 Remote 确认 ref missing，幂等视为 `deleted`，不会反复失败。

### 4.5 Delivery

```ts
export interface DeliveryV2 {
  delivery_id: string;
  task_id: string;
  attempt_id: string;
  project_id: string;
  base_sha: string;
  head_sha: string;
  tree_sha: string;
  branch_ref: string;
  changed_files: string[];
  patch_digest: string;
  artifact_ids: string[];
  verify_manifest_digest: string;
  status:
    | 'proposed'
    | 'accepted'
    | 'rejected'
    | 'merging'
    | 'merged'
    | 'conflict'
    | 'integration_failed'
    | 'superseded'
    | 'invalidated';
  accepted_commit_sha?: string;
  merged_commit_sha?: string;
  invalidated_reason?: 'branch-head-changed' | 'verify-manifest-changed' | 'artifact-manifest-changed' | 'remote-ref-acl-lost';
}
```

### 4.6 Artifact

```ts
export interface ArtifactRecordV2 {
  artifact_id: string;
  project_id: string;
  task_id: string;
  attempt_id: string;
  kind: 'result-md' | 'result-json' | 'verify-log' | 'agent-log' | 'patch' | 'recovery-bundle';
  sha256: string;
  size_bytes: number;
  media_type: string;
  storage_key: string;
  created_at: string;
  retention_until?: string;
}
```

### 4.7 MergeJob

```ts
export interface MergeJobV2 {
  merge_job_id: string;
  delivery_id: string;
  project_id: string;
  expected_target_sha: string;
  source_sha: string;
  strategy: 'rebase-ff' | 'cherry-pick' | 'provider-pr';
  status: 'queued' | 'running' | 'merged' | 'conflict' | 'integration_failed' | 'cancelled';
  final_sha?: string;
  cancel_reason?: 'target-advanced' | 'remote-ref-acl-lost' | 'operator-cancelled';
  integration_artifact_ids: string[];
}

export interface ExternalMergeIntentV2 {
  intent_id: string;
  project_id: string;
  delivery_id: string;
  expected_target_sha: string;
  provider_actor: string;
  approved_by: string;
  reason: string;
  status: 'declared' | 'reconciling' | 'verified' | 'failed';
  final_sha?: string;
  created_at: string;
  resolved_at?: string;
}
```

### 4.8 ReadOnlyAcceptance 与 Incident

```ts
export interface EvidenceAcceptanceRecordV2 {
  acceptance_id: string;
  task_id: string;
  attempt_id: string;
  project_id: string;
  artifact_manifest_digest: string;
  pm_review_id: string;
  status: 'evidence_accepted' | 'evidence_rejected' | 'superseded';
  decided_at: string;
}

export interface IncidentRecordV2 {
  incident_id: string;
  project_id?: string;
  node_id?: string;
  kind: 'node' | 'outbox' | 'git' | 'artifact' | 'restore' | 'security';
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'acked' | 'resolved';
  detector_evidence: Record<string, unknown>;
  resolution_evidence?: Record<string, unknown>;
  owner_id?: string;
  resolution_due_at: string;
  recurrence_of?: string;
  opened_at: string;
  acked_at?: string;
  resolved_at?: string;
}

export interface OutboxEventRecordV2 {
  event_id: string;
  project_id?: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_revision: number;
  payload_digest: string;
  status: 'pending' | 'dispatching' | 'delivered' | 'dead-letter';
  attempt_count: number;
  next_attempt_at?: string;
  last_error?: string;
  dead_lettered_at?: string;
  compensates_event_id?: string;
}
```

`evidence_accepted` 属 `EvidenceAcceptanceRecordV2.status`，不是 Attempt 或 Delivery status；Task projection 以当前未 supersede 的记录显示 Artifact-only 完成，依赖判定必须读取该 durable record。full 与 read-only Project 都可创建该记录，但只有 `ownership.write=[]`、服务端 Git diff 为空且策略明确为 Artifact-only 的任务可用。

Incident 的 ack SLO 与 resolution SLO 分离：Critical/High 分别在 5/30 分钟内 ack，并分别在 4/24 小时内 resolve；Medium/Low 默认分别在 7/30 天内 resolve。超时前必须由 Owner 关闭，或记录延期理由、风险和下一检查点并生成新的 `resolution_due_at` 审计事件。`resolved` 记录不可重开；同一 detector 再次触发时创建新 Incident，并用 `recurrence_of` 关联最近一次已关闭记录，保证每次发生、响应和证据都不可变。

## 5. 状态机与不变量

### 5.1 Task 与 Attempt 分离

```text
Task:
pending → running → done → PM accepted
                 ↘ failed → repair/reverify

Attempt:
preparing → running → uploading → delivered
    │          │           │
    ├→ failed  ├→ lease_lost
    └→ cancelled           └→ orphaned → orphan_recovered
                                      └→ orphan_discarded
```

不变量：

- 同一 Task 同一 `attempt_generation` 最多一个合法 active Attempt；
- 新 `attempt_generation` 创建后，旧 Attempt 永久不能 renew/report/deliver；
- Node 恢复连接不能复活旧 claim；
- Attempt `delivered` 不等于 Task `done`，只有 Delivery 校验成功后才能进入 `done`；
- Worker success、commit 存在、push 成功、Artifact 上传成功都只是部分证据。
- `orphaned` 的裁决者是控制面 reconcile：`attempt_generation` 仍有效且 branch/Artifact 完整时可转 `orphan_recovered` 并创建新 Delivery；否则转 `orphan_discarded`，原 recovery bundle 仍按保留策略留证。

### 5.2 Delivery 与 Merge 分离

```text
proposed → accepted → merging → merged
    │          │         ├→ conflict
    └→ rejected          └→ integration_failed
```

不变量：

- PM Review 绑定固定 `head_sha + verify_manifest_digest`；
- Delivery 的 branch HEAD、Artifact 引用清单或 `verify_manifest_digest` 变化后，已有 accept 自动失效；内容寻址 Artifact 本身不可变；
- 只有 Merge Bot 能写默认分支；
- 合并必须以 `expected_target_sha` 做 CAS；
- 合并后新的最终 SHA 必须有 Integration Verify；
- 项目完成统计必须要求 `delivery.status=merged`，不能只看 `pm_review_status=accepted`。

### 5.3 Node 状态机

```text
enrolling → online ↔ degraded → draining → offline
                └──────────────→ quarantined
quarantined → credential rotated + health verified → enrolling → online
```

- `draining` 不领取新任务，已有任务正常完成或显式移交；
- `degraded` 只领取仍满足安全条件的任务；
- `quarantined` 禁止领取、上传 Delivery 和获取新凭据；
- 心跳失联但持有 running Attempt 时产生可行动告警；
- 节点正常退出必须记录原因，不能只等待 stale 推断。
- `enrolling` 超过 enrollment TTL 未完成 register 时转 `offline` 并撤销一次性 token；
- `quarantined` 只能由具备 Node 管理权限的人在根因证据、健康检查和 credential rotation 完成后解除。
- 解除流程固定为：Owner ack incident → revoke 旧凭据 → 签发一次性 re-enrollment token → Node 重新 register → 校验 binding/fingerprint/clock/cert/tools → online；不得从 quarantined 直接改 online。
- 进入 `quarantined` 的同一 durable transaction 必须提升 node credential/session generation、撤销 push/signing credential、停止签发 Attempt Token，并对全部非终态 Attempt（`preparing/running/uploading`）发 `cancel_requested`；Node watchdog 终止进程树，确认终止或 lease 到期后才允许新 generation 重领。quarantine 不是“只禁止新任务”。

## 6. Git 工作空间设计

### 6.1 代码真相源

Git Remote 是源代码真相源；Biao 数据库保存执行、证据、决策和合并审计，不复制整个源码历史作为第二真相源。

### 6.2 本地仓库结构

```text
<node-data>/projects/<project_id>/
├── mirror.git/                 # fetch cache，不供 Agent 直接修改
└── attempts/
    └── <attempt_id>/           # 独立 worktree 或 clone
```

### 6.3 分支命名

```text
refs/heads/biao/<project-slug>/<task-slug>/<attempt-id>
```

必须规范化长度、字符和大小写；数据库保存完整 ref，不能靠重新拼接猜测。

### 6.4 Workspace Prepare

顺序：

1. 校验 NodeProjectBinding；
2. `git fetch --prune`；
3. 校验 remote fingerprint；
4. 检查服务端声明的 `base_sha` 可达；
5. 创建独立 branch/worktree；
6. 写 owner-only `.biao-attempt.json`；
7. 检查仓库可移植性和磁盘余量；
8. 才允许启动 Agent。

### 6.5 Workspace Finalize

顺序：

1. 终止 Agent 进程树；
2. 确认 Lease 仍有效；
3. 读取 Git status；
4. 拒绝 Ownership 外变更、敏感文件和 plan 文件违规；
5. 生成 commit；
6. 使用 `git push --atomic` 同时推送 task branch 与 `refs/biao/attempt-markers/<attempt_id>`；marker 指向只含 `schema_version, project_id, task_id, attempt_id, attempt_generation, node_id, signing_key_generation, branch_ref, head_sha, created_at` 的 canonical JSON blob，并用 Node signing key 签名；控制面按 `node_id + signing_key_generation` 选择登记的 Node public key 验证；
7. 服务端从 Git Remote 独立计算 diff；
8. 上传 Artifact；
9. 创建 Delivery；
10. Delivery 成功后再 report。

### 6.6 Worktree 与独立 Clone

- 普通仓库默认 `git worktree`；
- 含 submodule、特殊 sparse checkout 或不兼容 Git 版本的项目使用 `clone-per-attempt`；
- 不允许跨机器共享同一个 `.git/worktrees` 管理目录；
- 不把 linked worktree 放到间歇断开的网络盘；
- cleanup 只删除已确认无未推送变更且 Delivery 已持久化的工作区。
- Node 定期对 `mirror.git` 执行 `git maintenance run --auto`；磁盘进入低水位时先停止新 claim，再执行受限 GC，GC 后仍低于恢复阈值则保持 degraded；
- 控制面定期扫描 `refs/heads/biao/**` 与 Delivery/Attempt marker，孤儿 branch 先标记、保留审计期，再由控制面签发清理指令；节点或普通 Worker 不得自行删除远端孤儿 branch。
- Remote 不支持 atomic multi-ref push 时，Node 先推 marker staging ref、再推 branch、最后把 marker 转 ready；任一步中断都进入 `orphan_branch_detected`，不能假装 Finalize 成功。控制面以 branch 名中的 attempt_id 发现候选，再用 marker/DB 证明归属；缺失或验签失败的 marker 必须人工裁决。
- Node signing key 在 enrollment 时由 Node 本地生成，私钥进入 OS Keychain/Credential Manager，公钥和 `signing_key_generation` 写 Node Registry；revoke/quarantine 时连同其他凭据轮换。marker 固定记录 key generation；旧公钥只读归档到所有相关 marker/Delivery 审计期结束，不能因轮换而让旧 marker 无法验签。
- marker 至少保留到对应 branch 删除且 Delivery/OrphanRecoveryCandidate 进入终态后的 30 天；存在未关闭 Incident/Question/repair 时禁止 GC。GC 顺序为先确认 DB 证据和 branch 已清理，再删 marker，绝不能先删归属证明。
- ReconcileService 对正常运行中进入 `rejected/superseded/conflict/integration_failed/invalidated` 的任何非 merged 终态 Delivery 立即幂等创建 `BranchCleanupRecordV2`，不是只在模式切换时创建。`invalidated` 统一映射 `reason=invalidated` 并把具体 `invalidated_reason` 写入 Audit；模式切换 step3 对其新失效的 Delivery 映射 `reason=mode_transition`。默认 branch 保留 30 天；存在 active repair/Question/Candidate/Incident 时自动延期。到期后控制面再次校验固定 HEAD 与引用关系，再由专用清理身份删除；失败开 Incident，普通 Node/Worker 永不直接删远端 branch。

### 6.7 非文本/不可合并文件

项目可声明：

```yaml
workspace_policy:
  exclusive_patterns:
    - "**/*.docx"
    - "**/*.pptx"
    - "**/*.xlsx"
    - "**/*.psd"
```

这些路径禁止并行写；可选使用 Git LFS，但 LFS 不解决语义合并。冲突只能转人工或专用验收任务。

## 7. Ownership V2

### 7.1 Key 结构

```text
biao:v2:project:<project_id>:ownership
biao:v2:project:<project_id>:owner-by-attempt:<attempt_id>
```

Value 至少包含：

```json
{
  "project_id": "offic",
  "path_glob": "apps/api/src/**",
  "task_id": "mail-api",
  "attempt_id": "attempt-03",
  "node_id": "node-mac-01",
  "priority": 8,
  "base_sha": "...",
  "expires_at": 0,
  "mode": "exclusive-write"
}
```

### 7.2 不再盲目抢占运行中任务

当前高优先级 preempt 只替换 Ownership 记录，不能撤销另一台电脑已经产生的代码。V2 规则：

- 活跃 Attempt 默认不可直接 preempt；
- 需要抢占时先产生 `preemption_requested`；
- 控制面对旧 Attempt 执行 generation fencing；
- Node 收到 cancel，终止 Agent、保存 recovery bundle；
- 旧 Attempt 确认失效或 Lease 超时后，新 Attempt 才能获得 Ownership；
- 旧分支可以保留审计，但不得进入 Merge Queue。

### 7.3 Git Diff 二次门禁

Ownership 只是调度前门禁；Delivery 创建时必须对服务端计算出的 diff 再检查一次。任何未授权变更都强制拒绝 Delivery，并进入 Question/repair，不允许 PM 用普通 accept 绕过。

## 8. Plan V2

### 8.1 Plan Snapshot

远程 CLI 不再发送 `plan_dir`，而是读取、解析并上传：

```ts
export interface PlanSnapshotV2 {
  schema_version: 2;
  project_id: string;
  plan: PlanFrontmatterV2;
  tasks: Array<{
    frontmatter: TaskFrontmatterV2;
    body: string;
  }>;
  source_digest: string;
}
```

服务端重新执行 schema、DAG、acceptance_for、Ownership 和 Verify 校验，不能信任 CLI 的本地校验结果。

CLI 新增显式 `plan import` 作为 V2 入口：CLI 在调用方机器读取目录、构造 Snapshot、显示 digest 后上传。旧 `plan submit --plan-dir` 只对 V1 local-only 项目保留；Project 完成显式 binding 并启用 V2 后，服务端拒绝路径模式。迁移期通过 capability/version negotiation 返回可用入口，不让新 CLI 静默把远端路径交给服务端。

### 8.2 Task Requirements

```yaml
requirements:
  os: [darwin, linux]
  arch: [arm64, x64]
  tools:
    node: ">=22.12"
  labels: [internal-network]
  min_memory_mb: 8192

acceptance_policy:
  independence: node+harness
```

requirements 缺省时保持现有类型/Agent 匹配语义。

分布式写任务的 `acceptance_policy` 缺省值必须 fail closed 为 `node` 独立；涉及 Secret、默认分支、构建发布或项目自定义高风险路径时缺省为 `node+harness`。只有显式标记为 `local_trusted` 的 V1/local-only 项目可保留旧的 Agent 独立性语义，界面必须显示风险。调度器找不到满足独立性的节点时保持 pending，不能静默降级。

### 8.3 Plan 与 Git 的真相边界

- Submitted Plan Snapshot 是调度真相；
- Git 中 `plans/` 可作为可读源或导出，但不能由 Worker 修改；
- Plan 修订生成新 `revision` 和 digest；
- running/done/failed 的历史任务不被新 Plan Snapshot 覆盖；
- pending 任务可按现有规则更新，但必须记录旧/新 digest。

## 9. Artifact Store

### 9.1 存储层次

MVP：

```text
<biao-data>/artifacts/sha256/<prefix>/<digest>
```

后续适配：S3/MinIO/对象存储。Node 永远只看到 API/上传 URL，不看到中央真实文件路径。

### 9.2 上传协议

1. `POST /v2/artifacts/initiate`；
2. 服务端校验 task/attempt/claim；
3. 小文件直接流式上传，大文件分块；
4. `POST /v2/artifacts/:id/complete`；
5. 服务端复算 digest 和 size；
6. CAS 发布 ArtifactRecord；
7. Report/Delivery 只能引用 completed Artifact。

### 9.3 安全限制

- `result.md/result.json` 保持 2 MiB 量级上限；
- Agent log、Verify log 使用更高但有界上限；
- 拒绝符号链接、设备文件、目录和路径穿越；
- 日志经过凭据模式脱敏；
- HTML 默认以文本或沙箱方式展示；
- 下载必须检查项目权限；
- Artifact digest、task、attempt 一旦发布不可修改。

### 9.4 保留策略

- accepted/merged 交付长期保存；
- failed/rejected 保留审计期；
- orphan recovery bundle 有明确短期保留；
- GC 先标记、后延迟删除；
- 数据库记录和 Artifact blob 必须可对账，不能只按目录年龄清理。
- 去重 blob 使用 `artifact_blobs(sha256, size_bytes, ref_count, gc_marked_at)` 与项目级 `artifacts` 引用分离；只有 `ref_count=0`、超过延迟窗口且二次扫描仍无引用时才可删除；若首版未实现该引用模型，则关闭跨项目 blob 去重。
- initiate 后未 complete 的临时上传默认 TTL 24 小时；后台 GC 只删除超过 TTL、无活跃 Attempt 且无 idempotency replay 的临时键，并记录删除计数、字节和原因。大文件活跃分块上传通过续期 token 延长 TTL，但上限 72 小时。

Recovery bundle 的本地 staging owner 是 `biao-node`，最终裁决 owner 是控制面 reconcile。Node 恢复后先上传 manifest；控制面只返回 `upload-and-reverify`、`retain-evidence-only` 或 `discard-after-audit`。默认本地保留 7 天、中央审计保留 30 天；存在未关闭 Question/repair/安全事件时禁止 GC。删除必须记录 manifest digest、裁决 actor 和时间。

本地路径固定为 `<node-data>/recovery/<project_id>/<attempt_id>/manifest.json + bundle`。`biao-node` 每次启动必须在 register 后、claim 前扫描残留，逐项调用 recovery reconcile API 并提交 manifest digest；未得到控制面 signed decision/ack 前不得删除。裁决规则：当前 attempt_generation 仍合法且无 successor 时 `upload-and-reverify`；已有 successor/新 generation 但 bundle 含未入库 diff、Verify 或进程终止证据时 `retain-evidence-only`；manifest 为空、无未入库证据且审计期满足时才 `discard-after-audit`。上传失败采用幂等重试并开 Incident。

## 10. Node Runtime

### 10.1 一个节点一个守护进程

`biao-node` 替代“每个 Worker 一个长期轮询脚本”。每个节点内部可以有多个 slots，但共享：

- 一条事件/长轮询连接；
- 一次节点心跳；
- 一个项目缓存管理器；
- 一个资源调度器；
- 一个日志与升级通道。

### 10.2 安装与启动

- macOS：launchd；
- Linux：systemd；
- Windows：Windows Service；
- 安装命令只接受一次性 Enrollment Token 文件或交互式输入；
- Token 不进入 argv、Shell 历史或日志；
- 安装后换取节点长期凭据，Enrollment Token 立即失效。

具体产物：

- macOS：签名后的 `biao-node`、LaunchDaemon plist、Keychain 凭据适配器、`install/uninstall/status/drain` 命令；
- Linux：systemd unit、`EnvironmentFile` 权限门禁、Secret Service/owner-only credential file 适配器；
- Windows：PowerShell 安装器、Windows Service 定义、Credential Manager 适配器、事件日志源、`Install/Uninstall/Start/Stop/Drain` 命令；不得要求 Bash；
- 三个平台都必须支持幂等安装、升级前 drain、失败回滚、卸载前远端 revoke、残留工作区清单输出。

`.biao/supervisor` 在 V1 继续存在；启用 distributed mode 后，节点级 `biao-node` 是唯一 claim/heartbeat 守护进程，旧 Supervisor 只能作为它管理的本地 Agent slot adapter，不能再独立 claim。

### 10.3 心跳内容

心跳不发送任务正文或密钥，包含：

- node/session generation；
- status；
- protocol/build version；
- Agent slot online/busy 状态；
- running attempt IDs；
- CPU、内存、磁盘的限量摘要；
- 项目 binding health；
- Git fetch 时间和 head 摘要；
- 最近错误代码。
- 节点观测到的服务端时间、节点当前时间和计算出的 `clock_skew_ms`；
- 当前信任锚 generation、服务端证书到期时间和最近一次 TLS 校验结果。

心跳中的 running attempt IDs 只作诊断；合法性始终由服务端 lease/generation 决定。最小错误码集合包括 `CLOCK_SKEW`、`CERT_EXPIRING`、`GIT_UNAVAILABLE`、`ARTIFACT_UNAVAILABLE`、`DISK_LOW`、`WORKSPACE_PREPARE_FAILED`、`LEASE_AT_RISK` 和 `PROCESS_KILL_FAILED`。

### 10.4 Lease 丢失

当前 Worker 对 renew 异常主要记录日志。分布式 V2 必须增加本地安全截止时间：

- 首次 renew 失败进入 `lease_at_risk`；
- 在服务端租约到期前预留停止窗口；
- 超过窗口仍无法确认时，对 Agent 进程树发 TERM/KILL；
- 保存本地 recovery bundle；
- 不再 commit/push/report 为合法 Delivery；
- 网络恢复后查询 attempt generation，再决定上传 orphan bundle 或清理。

`lease_at_risk` 是 Node watchdog 的本地观察态和审计事件，不是 `TaskAttemptV2.status` 的 durable 枚举；服务端 Attempt 在有效 lease、`lease_lost` 或其他终态之间转换，避免同一状态由两台时钟竞争写入。

Lease watchdog 由 `biao-node` 统一拥有并替代 `runWorkerLoop` 仅打印日志的续租行为；slot adapter 接收 at-risk/cancel 信号并必须反馈进程树终止结果。服务端时间是 lease 真相，Node 使用每次响应返回的 `server_now` 和单调时钟计算本地截止时间，不直接比较两台机器的墙钟。默认允许时钟偏差 30 秒、超过 60 秒进入 degraded、超过 120 秒 quarantined；阈值可配置但不得由 Node 自行放宽。

revoke Node 时立即提升 credential generation、停止签发 Attempt Token，并对其 running attempts 发出 `cancel_requested`；在进程终止确认或 lease 到期后以新 generation 重新排队。不能只等待长期凭据自然过期。

### 10.5 Drain 与升级

- `drain` 后不再 claim；
- 等待 running attempts 收口；
- 超时必须显式选择 cancel 或继续等待；
- Node 升级必须声明支持的 protocol min/max；
- 控制面拒绝不兼容节点领取新任务；
- 不允许节点自行静默升级到未经验证的版本。

## 11. Scheduler V2

### 11.1 过滤顺序

```text
project_id
→ NodeProjectBinding authorization_status=authorized
→ task type / assignee
→ protocol compatibility
→ Node status
→ OS / arch / tool / labels
→ project binding health
→ available capacity
→ acceptance independence
→ Ownership
→ priority / age
```

### 11.2 容量

- `max_concurrent_tasks` 是 Node 硬上限；
- slot 仍保持一次只执行一个任务；
- 可选任务资源预留，防止多 Agent 同机耗尽内存；
- 磁盘低水位时禁止创建新 worktree；
- 默认低水位 10 GiB 或数据盘 10%（取较大者），恢复水位 15 GiB 或 15%；进入低水位即 degraded，达到恢复水位且 repo/Artifact 健康检查通过才恢复 online；
- Control Plane 不根据一次瞬时 CPU 采样做频繁迁移。

### 11.3 Acceptance 独立性

支持：

- `agent`：不同 agent_id；
- `harness`：不同执行器或模型；
- `node`：不同 node_id；
- `node+harness`：节点与执行器都不同。

若没有满足独立性要求的节点，任务保持 pending 并显示精确阻塞原因，不能自动降级为自验收。

## 12. Merge Queue

### 12.1 权限边界

- Worker Node 只可推送 `refs/heads/biao/**`；
- Merge Bot 是唯一默认分支写入者；
- Human 可通过受保护 Provider 流程紧急操作，但必须回写 Biao Audit；
- Node Credential 不包含默认分支写权限。

`generic-git` MVP 必须在受控 Remote 安装 `pre-receive` hook（或等价的 git-shell/gitolite ref ACL）：Node 身份只允许原子创建/更新自身 attempt 对应的 `refs/heads/biao/**` 和配对的 `refs/biao/attempt-markers/<attempt_id>`，禁止 tag、默认分支、其他 Node ref 和删除操作；Merge Bot 身份只允许按 Merge Job CAS 更新受保护目标 ref。没有可验证 ref ACL 的 Remote 不能启用自动 Merge Queue。

ref hook 之外还必须有第二层账号隔离：Worker SSH/HTTP 身份由 forced-command/gitolite/provider scope 限制到 Biao namespace，绝不共享 Merge Bot key。检测到默认分支出现没有对应 MergeJob/external intent 的新 SHA 时立即 maintenance barrier、撤销全部 Worker Git credential、保留非法前后 refs 与 actor evidence、开 Critical Incident；Owner 通过 Provider 保护流程创建审计化 revert（默认禁止 force-push 回滚），完成 Integration Verify 与三方 reconcile 后才解除。该 runbook 在首个 full Project 前演练。

若 Remote 无法提供可验证的 ref ACL，该 Project 只能进入 `read-only-acceptance`：Node 不获得任何 push credential，Biao 不接受 Delivery branch，也不允许通过 Biao 自动或手工合并。Node 侧校验永远不能替代 Remote 权限，因为失陷 Node 可以绕过本地代码。

`read-only-acceptance` 是 Project 持久 `execution_mode`，不是临时 UI 标签。该模式只允许 `research/docs/acceptance` 且 `ownership.write=[]`、服务端 Git diff 为空的 Artifact-only 任务；Plan import 必须拒绝 code/write 任务、需要 branch/Delivery 的 Verify、以及依赖代码变更结果的下游 DAG。Artifact-only 任务以 `evidence_accepted` 为完成口径，可作为其他只读证据任务的 prerequisite，但不能解锁任何写任务。Scheduler 对不兼容任务返回稳定阻塞码 `REMOTE_REF_ACL_REQUIRED_FOR_WRITE`，Projects 页面显示模式原因。安装可验证 ref ACL 并重新 validate 后，Owner 才能切回 `full`。

### 12.1.1 full → read-only 的安全降级

一次 Remote 探测失败只把 `write_capability_status` 置 `suspect`，把 Project 置 `paused/degraded` 并阻止新 write claim，不立即改 execution_mode。连续验证确认 ref ACL 丢失时，安全熔断不等待 Owner 决定：同一 durable transaction 立即把 `write_capability_status=lost`，停止 finalize/push/review/merge，提升全部非终态写 Attempt（`preparing/running/uploading`）generation、撤销其 push/merge credential 并发 `cancel_requested`；Node watchdog 终止进程树并保存 recovery bundle。Owner 随后只能选择“修复 ACL 并恢复 full”或“继续降级 read-only”，不能选择让旧写 Attempt 继续运行。

选择降级后创建 durable `ProjectModeTransition`，以 `mode_transition_id + step` 为幂等键逐步推进：

1. `pause`：设置 `status=paused`、`mode_transition=draining-to-read-only`，停止全部 claim、Delivery review 和 Merge Queue 入队；
2. `fence-attempts`：确认全部非终态写 Attempt（`preparing/running/uploading`）已 generation fencing 且进程终止；掉电/失联节点必须等 lease 到期或 session fencing，recovery bundle 和未完成上传进入 Candidate 扫描；
3. `invalidate-lineage`：取消 queued/running MergeJob 为 `cancelled/remote-ref-acl-lost`；把 `proposed/accepted/merging` Delivery 原子转 `invalidated(remote-ref-acl-lost)`，保留 Review 审计并创建 `reason=mode_transition` 的 BranchCleanup；`rejected/superseded/conflict/integration_failed/invalidated` 保持终态且确保已有幂等 BranchCleanup，绝不作为有效 lineage；
4. `block-dependents`：queued/blocked write Task 从 scheduler pending 集合移除并写 `blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY`；任何依赖这些写 lineage 的下游只读 Task 也写 `blocked_reason=PROJECT_MODE_CHANGED_READ_ONLY_DEPENDENCY` 并移出 pending，由 Owner cancel、重写 Plan，或待恢复 full 后 replan，禁止静默 pending；
5. `reconcile`：等待全部 write Attempt/MergeJob 终态，且所有 `decision=pending` 的 OrphanRecoveryCandidate 已裁决或显式隔离；ReconcileService 证明 Remote refs、Artifact、Audit、ownership/outbox 无未解释差异；
6. `commit-mode`：原子写 `execution_mode=read-only-acceptance`、`write_capability_status=disabled`、`status=active` 并清除 mode_transition 指针，随后才可领取兼容的 Artifact-only Task。

每步完成都与 outbox event 同事务写入；控制面重启从最后提交 step 恢复，同一 step 重放不得重复 cancel、invalidate 或创建 Candidate。控制台和 Incident 显示 transition id、当前 step、开始时间、最后错误和待裁决对象。任一步失败保持 `paused + mode_transition`，不得部分切换，也不得领取任务。

双向 mode transition 的总 deadline 默认均为 24 小时。降级 `reconcile` 超期后，Owner 只能通过 API/CLI 把无默认分支安全歧义的残留 ref/Candidate 写入 `RecoveryIsolationRecordV2` 和关联 Incident 后继续；该 durable transaction 同时写 evidence digest、retention、Audit/outbox，被隔离对象不再进入正常 reconcile。若仍无法证明默认分支、有效 Delivery 或运行写进程已收口，则必须保持 paused，不能以超时跳过。Isolation 关闭必须由独立 Reviewer 核对 resolution evidence；所有对象仍按原保留期处置。

### 12.1.2 read-only → full 的安全恢复

恢复是与降级对称的 durable transition，不是一句配置切换：

1. `pause`：Owner 安装 ref ACL，Project 保持 `paused`，创建 `mode_transition=validating-to-full`，将 `write_capability_status` 从 disabled 置 suspect；
2. `validate-capability`：验证 repository fingerprint、Node ref scope、Merge Bot CAS 权限和实际拒绝样例；只在全部成功后写 `write_capability_status=ready`；
3. `reconcile`：ReconcileService 对 Git/Artifact/DB/ownership/outbox、Isolation 记录及全部 recovery Candidate 做全量对账；任何未解释差异保持 paused；
4. `refresh-bindings`：提升 project credential/policy revision，旧 push credential 全部撤销；只等待当前 `online/degraded/draining` 的授权 Node 回报新 revision。离线 Node 的 Binding 持久写 `write_credential_status=suspended`，不阻塞恢复，也不持有有效 push credential；其回归必须重新 register/heartbeat，校验 binding/fingerprint/health 并把 `applied_policy_revision` 更新为当前 revision 后才转 eligible、签发新的短期 push credential，旧 generation 永久拒绝；
5. `revalidate-plans`：重新校验仍有效的 Plan。降级期间被 block/cancel 的写 Task 永不自动恢复，Owner 必须 replan 并创建新的 Attempt；旧 invalidated Delivery/Review 不复用；
6. `commit-mode`：在一个 durable transaction 中写 `execution_mode=full`、`status=active`、清除 mode_transition，发布 outbox 后才开放新 write claim。

恢复过程同样持久记录上述枚举 step、幂等重放和重启续跑；24 小时 deadline 超时仍保持 `paused + validating-to-full` 并开 Incident，不能隔离掉 capability/默认分支安全差异后强行恢复 full。

### 12.2 合并顺序

1. 读取 accepted Delivery；
2. 获取目标分支最新 SHA；
3. 从 Remote 读取 `branch_ref` 当前 HEAD，必须与 `delivery.head_sha` 相等；不等则原子写入 `delivery.invalidated(branch-head-changed)`、撤销 accept 并停止；
4. 在入队时记录 `expected_target_sha`，执行时用 Git Remote 再次 CAS 校验；
5. 创建隔离 integration workspace；
6. 应用固定 `delivery.head_sha`，不能根据可变 branch ref 猜 source；
7. 遇冲突则停止并记录文件；
8. 运行 integration verify；
9. 生成 final SHA；
10. 以 `expected_target_sha → final_sha` 原子推送；
11. 持久化 merged 证据；
12. 唤醒下游依赖和最终验收。

目标分支前移导致 CAS 失败时，旧 Merge Job 终止为 `cancelled/target-advanced`，不得原地改写 Delivery。若策略允许 rebase，由控制面从最新 target 创建新的 integration/rebase Attempt，得到新 `head_sha` 和新 Delivery；旧 accept 自动失效，新 Delivery 必须重新执行 Verify 和独立 Review。幂等键为 `project_id + delivery_id + expected_target_sha`，同一输入重放只能得到同一终态。

紧急人工 merge 只能由 Owner 在 maintenance mode 创建 `external_merge_intent`，记录 Delivery、预期 target、Provider actor 和批准原因。完成后控制面从 Remote 读取 final SHA，验证该提交确实包含固定 `delivery.head_sha`，运行 Integration Verify，再由 durable transaction 把 Delivery 标为 merged、写 Audit/outbox 并解锁下游；验证失败保持 accepted/integration_failed。禁止手工改库或只写一条 Audit 就视为 merged。

### 12.3 冲突策略

- 不自动使用 `ours/theirs`；
- 不 force-push 默认分支；
- 生成 `merge_conflict` 修复任务；
- 修复任务从最新目标 SHA 创建；
- 原 Delivery 保留 `conflict` 审计；
- 修复后生成新 Delivery，并重新走独立验收或最小重验策略。

### 12.4 依赖何时解锁

MVP 默认只有 prerequisite Delivery `merged` 后才解锁普通下游任务。未来可以增加“基于多分支组合工作区”的高级模式，但不进入首版，因为它会显著放大 DAG、重验和冲突语义。

统一判定函数为 `dependencySatisfied(projectMode, taskLineage)`：V2 Project 的普通、repair 和 reverify lineage 一律要求其当前有效 Delivery `merged`；V1 local-only Plan 继续以 `pm_review_status=accepted`。回退只停止新 V2 claim，不改变已经迁移 Project 的判定函数；`accepted-not-merged` 必须继续留在 Merge Queue 或明确取消，绝不能交给 V1 解锁。

补充分支：任何 Project 的 Artifact-only lineage 都以 durable `EvidenceAcceptanceRecordV2.status=evidence_accepted` 解锁其他 Artifact-only lineage；full Project 的写 lineage 仍只以有效 Delivery `merged` 解锁。`execution_mode=read-only-acceptance` 时任何写 lineage 在 Plan import 阶段即拒绝；该模式的 evidence record 不能解锁写任务。

## 13. 身份、安全与威胁模型

### 13.1 身份分层

| 身份 | 权限 |
| --- | --- |
| Human Owner | 项目、成员、策略和最终管理 |
| Planner | Plan 创建/修订，不自动拥有 Review 权限 |
| Reviewer/PM | Question、Review、resolution、merge approval |
| Recovery Reviewer | 独立复核 Isolation resolution，不能关闭自己创建的 Isolation |
| Node | 注册、心跳、可用性和受限项目接入 |
| Task Attempt | 单任务 claim/renew/upload/deliver |
| Merge Bot | 受策略约束的默认分支写入 |

### 13.2 主要威胁

| 威胁 | 防护 |
| --- | --- |
| 恶意 Verify 命令 | Plan Author RBAC、项目命令策略、可选沙箱 |
| 节点凭据泄露 | 每节点独立、可撤销、generation、短期 Attempt Token |
| 失陷节点伪造 Verify/Artifact/Delivery | 分布式写任务默认独立节点验收；Reviewer 从 Remote/Artifact 重算关键证据；高风险任务使用 node+harness；缺少独立节点时 fail closed |
| 旧节点重放 report | Attempt generation + claim fencing |
| Artifact 篡改 | 服务端复算 SHA-256，记录不可变 digest |
| 分支 force-push | Delivery 绑定 head SHA，变化后 accept 失效 |
| 主分支被 Worker 写入 | Git 权限隔离，Merge Bot 单写 |
| 日志泄密 | 子进程环境净化、日志脱敏、大小限制 |
| 跨项目读取 | project membership + Artifact/Task API 授权 |
| Login CSRF/远程 Cookie | 远程 Human Identity，Local Owner 仅 loopback |
| Redis 暴露 | Redis 不对节点网络开放 |

### 13.3 TLS 与服务发现

- 局域网仍使用 HTTPS；
- 推荐固定 DNS 名称或明确 URL，不依赖不稳定的自动发现；
- 首版使用反向代理终止 TLS；
- Node 首次加入需要操作者确认服务器指纹；
- 后续可增加 mTLS，但首版至少具备独立 Node Token 与 TLS。

证书与信任锚运维：控制面在 30/14/7 天前告警证书到期；节点心跳回报所见证书和 trust-anchor generation。换证采用双信任窗口：先发布新 CA/指纹并由 Owner 审批，节点同时信任 old+new，验证全节点已接收后切换服务证书，最后撤旧。紧急换证进入 maintenance，禁止新 claim，使用一次性恢复 enrollment 重新确认。证书轮换必须有演练和回滚记录。

“全节点已接收”的判定只统计 `online/degraded/draining` 且在轮换开始后回报新 generation 的节点；离线节点进入明确清单。等待 72 小时仍未接收时，Owner 可将其 quarantine/revoke 后撤旧，节点回归必须走 re-enrollment，不能无限阻塞换证，也不能直接接受旧信任锚。

### 13.4 Control Plane Recovery Signing Key 生命周期

Recovery decision 的签名密钥独立于 TLS、Node marker key 和普通 API token。私钥只进入 Control Plane Secret Provider/HSM 适配器；数据库只保存 `key_id`、generation、公钥、状态、启停时间和审计引用。生命周期固定为：

1. `generated`：生成新的非导出私钥与随机 `key_id`，尚不签发 decision；
2. `published`：通过认证后的 register/heartbeat config envelope 下发新公钥和 generation，Node 进入 old+new 双信任并在心跳回报已接受 generation；
3. `active`：所有 `online/degraded/draining` 节点已回报，或等待 72 小时后未回报节点已 quarantine/revoke，控制面才用新 key 签发；
4. `retiring`：旧 key 停止签发，但旧公钥至少保留到该 key 所有 decision envelope 过期，且关联 Candidate、Incident 与审计达到保留期；
5. `archived/revoked`：正常轮换归档公钥供历史验签；确认泄露时立即 revoke generation，使所有未过期 decision 失效并以新 key 重签，Node 必须拒绝 revoked generation。

节点不得仅按最大 generation 盲目信任 key；每次信任集合更新都校验控制面认证、单调 policy revision 和撤销列表。若 active key 不可用或节点未接受相应 generation，recovery Candidate 保持 pending，绝不返回无签名裁决。轮换、紧急撤销、离线节点回归和控制面恢复都必须有 Audit/Incident；BackupCoordinator 备份密钥 metadata，不把可导出私钥混入普通数据库备份。

控制面每分钟执行签名 canary；失败立即产生 `recovery-signing-unavailable` Incident，指标至少包含 `recovery_signing_available` 和 `oldest_pending_recovery_candidate_age`。恢复后必须用 canary、一个测试 envelope 验签和 pending Candidate 重签结果关闭 Incident，不能只以 Secret Provider 重新连通为证据。

### 13.5 Secret 使用

- Git、模型、云服务 Secret 保留在 Node Secret Provider；
- Plan 只声明 secret scope 名称，不含值；
- 只有满足 scope 的 Node 可领取；
- 子进程只获得任务允许的最小环境；
- Biao 控制面 Token、Redis URL、SQLite Path 永远不传给 Agent 子进程。

Attempt Token 由控制面在 claim 成功后签发，scope 固定为 `attempt_id + task_id + project_id + attempt_generation + allowed mutations`，短于 lease 最大期限，数据库只存 hash/jti。renew、question、Artifact 和 Delivery API 都同时校验 attempt_id、attempt_generation、node_session_generation 和 token scope；新 attempt_generation 产生后旧 token 立即失效。Node Credential、Git SSH key、模型 key 和 OS credential handle 必须加入 `sanitizedChildEnv` denylist/allowlist 门禁，Agent 只拿到任务显式授权的短期 secret material。

## 14. Durable State 与一致性

### 14.1 MVP 保留 SQLite 的条件

SQLite 可以继续使用，前提是：

- 仅中央 Biao 服务单写；
- 文件位于中央机器本地磁盘；
- 不放在 SMB/NFS 上供多个进程共享；
- 使用 WAL 和在线备份；
- 启动时确认 `journal_mode=WAL`，按写入量/时间执行受监控的 `wal_checkpoint(PASSIVE)`，备份前执行受控 checkpoint；WAL 大小和 checkpoint latency 纳入指标，不能无限增长；
- 恢复时同时对账 Redis、Git refs 和 Artifact manifests。

### 14.2 为什么不在第一阶段立即迁 PostgreSQL

- 当前复杂度集中在状态机正确性，而非写吞吐；
- 先迁库会同时改变 durable truth、迁移和恢复边界；
- 多机 Worker 不要求多机数据库写入；
- Project/Node/Attempt/Delivery 模型稳定后再迁移，风险更可控。

### 14.3 何时迁 PostgreSQL

任一条件满足时启动迁移设计：

- 多控制面实例或 HA；
- 多组织、多用户并发写；
- SQLite 写锁成为实测瓶颈；
- 需要数据库级 RLS；
- 恢复时间或数据量超过已定义 SLO。

### 14.4 三方对账

启动和定期 reconcile 检查：

```text
Database Delivery
↔ Git branch/head
↔ Artifact manifest/blob
```

典型异常：

- Git push 成功但 Delivery API 响应丢失：以 branch + attempt marker 重放；
- Delivery 已写但 Artifact 缺失：Delivery 不得进入 proposed；
- PM accepted 后 branch 变化：失效 accept，产生审计；
- merged SHA 已在 Git 但 DB 未记录：Merge Job 以 expected/source/final SHA 幂等恢复；
- DB 有 merged 但 Git 不可达：服务进入 degraded，项目完成状态 fail closed。

孤儿 branch/Artifact 只能恢复为 `recovery_candidate`：控制面验证 marker、Remote head 和 Artifact digest 后创建新的恢复 Delivery，但原 Node 的 Verify 结果仅作证据，不能直接恢复 accepted。该 Delivery 必须执行策略要求的独立 acceptance；高风险项目在另一授权 Node 上重跑 Verify。只有无代码变化的 result-only 任务可由策略明确允许复用 manifest。

映射规则：Candidate 决策为 `upload-and-reverify` 且新 Delivery 建立后，原 Attempt 转 `orphan_recovered`；`retain-evidence-only` 或 `discard-after-audit` 收口后转 `orphan_discarded`。Candidate 自身只用 pending/decision，不引入第三套 Attempt/Delivery 状态。

Recovery 路径有且只有一个 durable owner：

- `node-driven`：Node 已 register 且持有本地 bundle 时提交 manifest，控制面返回 signed decision；Node 执行上传/保留/删除并 ack，Candidate 才 resolved。
- `control-plane-takeover`：Node 已 offline/revoked，Attempt lease 与 session 已 fencing，且超过 15 分钟 recovery grace，或 Owner 显式接管；ReconcileService 以 CAS 把 `recovery_path` 从 node-driven 改为 control-plane-takeover，写 takeover reason/Audit 后，独立验证 signed marker、Remote HEAD、Artifact digest。控制面可创建新的恢复 Delivery 并强制独立 reverify，或仅留证/审计删除；此路径 `node_ack_status=not-required`，旧 Node 后来回归只收到已 resolved 的签名收口结果，不能重复执行。

Candidate durable 状态机为 `pending → decided → executing → resolved`，任一步也可由 Owner 送入 `isolated`；每次 transition 提升 `revision` 并与 Audit/outbox 同事务。`resolved` 必须写 `resolved_at + resolution_evidence_digest`，之后任何 Node/control-plane 重放只返回原结果。两条路径争抢同一 Candidate 时以 candidate revision CAS 决胜，失败方重新读取；任何决策与 Attempt 状态映射只提交一次。

Control-plane takeover 在 CAS 成功、创建恢复 Delivery、更新 Attempt 三个崩溃点均由 ReconcileService 扫描 `control-plane-takeover + decided/executing` 状态续跑；恢复 Delivery 使用 `(candidate_id, bundle_manifest_digest, decision)` 确定性键，已存在则复用，绝不创建第二条。Phase 7a 必须提供按 Project/Node/outage 批量列出与批量 `takeover/isolate/retain-evidence-only` 的 API/CLI；批接口采用逐项部分成功而非全批回滚，响应为每项 `candidate_id/status/revision/error`，重试只重放失败项。每个 Candidate 仍单独记录 actor、reason、digest 和结果，批操作不能跳过独立证据校验。

对账范围同时包括 `task_attempts/ownership_snapshots/node_sessions/merge_jobs`，不能只看 Delivery。Redis 清空恢复时先从 DB 的 active Attempt 与 ownership snapshot 重建租约/Ownership，在 `restore_barrier` 下等待旧 lease 最大期限或确认所有旧 Node generation 已 fencing；期间 exclusive-pattern 任务禁止派发。

### 14.5 V2 durable-first 提交协议

所有新实体都遵循同一协议：

1. 客户端 mutation 带稳定 idempotency key；
2. SQLite 事务先写业务实体、outbox event、revision 和 reconcile key；
3. 事务提交后才把 Redis 作为运行态投影发布；
4. Redis 发布失败不回滚 durable truth，由 outbox/reconcile 重放；
5. Redis 成功而响应丢失时，同一 idempotency key 返回原实体；
6. Artifact blob 先上传到临时键，complete 时复算 digest，再在同一 durable transaction 中发布 ArtifactRecord/引用，之后原子 rename/CAS；
7. MergeJob 以 `delivery_id + expected_target_sha` 唯一，Git 原子推送后若 DB 写回失败，reconcile 用 expected/source/final SHA 恢复同一 Job，不生成第二条合并。

Outbox dispatcher 必须有 owner lease、per-row attempt/backoff、dead-letter 状态、`oldest_pending_age`/`dispatch_failure_total` 指标和 PM incident 告警。超过 5 分钟未投影时控制面进入 degraded 并暂停依赖相应投影的 claim；修复后按 durable revision 重放，不能人工跳过事件。

进入 dead-letter 的事件永不自动跳过或改成 delivered：Incident owner 修复根因后可按原幂等键 requeue；若 payload 本身有缺陷，必须写新的 compensating event 和审计关联，由 ReconcileService 验证 durable state/投影一致后关闭 Incident。任何未处置 dead-letter 都保持受影响 Project degraded。

处置面必须先显示业务实体当前 revision、payload digest、attempt/error 历史和关联 Incident。`requeue` 只允许原 event、原 aggregate revision、原幂等键重新进入 pending；若 durable state 已前移或 payload 错误，只允许创建带 `compensates_event_id` 的新 compensating event。两个 mutation 都要求 Incident owner 权限、原因、idempotency key 和 Audit；不存在 `skip/mark-delivered` 接口。

确定性键：`attempt_id = task_id + attempt_generation` 的不可猜随机 ID 映射；`delivery_id` 在首次 complete 时生成并由 `(attempt_id, head_sha)` 唯一约束重放；Artifact complete 用 `(attempt_id, sha256, size_bytes, kind)`；MergeJob 用上述 CAS 组合。任何半投影都保持 fail closed。

### 14.6 一致恢复点与恢复门禁

每次备份先在 DB 创建 `restore_point_id` 和冻结的清单水印：SQLite revision、Git refs 清单 digest、Artifact manifest digest、审计序号和 outbox high-water mark。随后分别备份组件并把完成状态回写到该 restore point；只有五项均完成的水印可用于正常恢复。MVP SLO：RPO 不超过 24 小时、RTO 不超过 4 小时，正式上线前按数据规模重新确认。

恢复必须：进入维护屏障 → 还原同一 restore point → `integrity_check` → Git refs/Artifact 三方全量 reconcile → 数量与 digest 报告为零未解释偏差 → 抽样下载证据 → 运行一个只读 acceptance 和一个不合并的 branch/push 冒烟。生产恢复的 push 只能由 BackupCoordinator 临时 credential 写入真实 Remote 的受保护 `refs/biao/recovery-smoke/<restore_point_id>`，验证 fetch 后立即受审计删除，绝不触碰默认分支或 task ref。不可调和偏差保持 degraded，由 Owner 显式裁决，不能以工具退出 0 单独证明完成。

Redis 恢复统一采用“DB snapshot 全量重建到 restore revision，再从 outbox high-water mark 后重放”的路径；不得同时让全量扫描和未界定水位的 outbox 各自写投影。`BackupCoordinator` 是控制面单写组件，负责 restore point 编排、组件清单和 drill 报告。演练必须使用隔离的临时 Redis、SQLite、Artifact root 和 bare Git Remote；真实 Remote 只做只读一致性校验，冒烟 branch 只能推到隔离 Remote。Git 恢复明确包含对象库和 refs，恢复后所有 Node mirror 强制重新 fetch/fingerprint 校验。

## 15. API V2 草案

### 15.1 Project

```text
POST   /v2/projects
GET    /v2/projects
GET    /v2/projects/:project_id
POST   /v2/projects/:project_id/validate
PATCH  /v2/projects/:project_id/policy
POST   /v2/projects/:project_id/mode-transitions
GET    /v2/projects/:project_id/mode-transitions/:transition_id
```

### 15.2 Node

```text
POST   /v2/nodes/enroll
POST   /v2/nodes/register
POST   /v2/nodes/:node_id/heartbeat
POST   /v2/nodes/:node_id/drain
POST   /v2/nodes/:node_id/offline
POST   /v2/nodes/:node_id/revoke
POST   /v2/projects/:project_id/nodes/:node_id/authorize
DELETE /v2/projects/:project_id/nodes/:node_id/authorization
GET    /v2/nodes
```

### 15.3 Plan/Task

```text
POST   /v2/plans/import
GET    /v2/plans/:plan_id
POST   /v2/tasks/claim
POST   /v2/attempts/:attempt_id/lease/renew
POST   /v2/attempts/:attempt_id/question
POST   /v2/attempts/:attempt_id/report
```

### 15.4 Artifact

```text
POST   /v2/artifacts/initiate
PUT    /v2/artifacts/:artifact_id/content
POST   /v2/artifacts/:artifact_id/complete
GET    /v2/artifacts/:artifact_id
```

### 15.5 Delivery/Review/Merge

```text
POST   /v2/deliveries
GET    /v2/deliveries/:delivery_id
POST   /v2/deliveries/:delivery_id/review
POST   /v2/evidence-acceptances
POST   /v2/evidence-acceptances/:acceptance_id/review
POST   /v2/merge-jobs
GET    /v2/merge-jobs/:merge_job_id
POST   /v2/merge-jobs/:merge_job_id/cancel
POST   /v2/merge-jobs/external-intents
POST   /v2/merge-jobs/external-intents/:intent_id/reconcile
GET    /v2/incidents
POST   /v2/incidents/:incident_id/ack
POST   /v2/incidents/:incident_id/resolve
POST   /v2/recovery-candidates/reconcile
POST   /v2/recovery-candidates/:candidate_id/decision
POST   /v2/recovery-candidates/:candidate_id/takeover
POST   /v2/recovery-candidates/batch-actions
GET    /v2/recovery-isolations
POST   /v2/recovery-isolations
POST   /v2/recovery-isolations/:isolation_id/review
POST   /v2/recovery-isolations/:isolation_id/resolve
GET    /v2/branch-cleanups
POST   /v2/branch-cleanups/:cleanup_id/retry
GET    /v2/outbox/dead-letters
GET    /v2/outbox/dead-letters/:event_id
POST   /v2/outbox/dead-letters/:event_id/requeue
POST   /v2/outbox/dead-letters/:event_id/compensate
```

Recovery Isolation 的 create/review/resolve 三步分别校验 Incident Owner、Recovery Reviewer 和 ReconcileService 身份；review 强制 reviewer 与 isolator 不同。BranchCleanup retry 只允许 Incident Owner 或受限 Reconcile Operator 请求，实际 Git 删除仍由 ReconcileService 专用身份执行，调用者不能携带任意 branch ref。

### 15.6 API 通用要求

- 所有 mutation 支持 idempotency key；
- 所有实体返回 generation/revision；
- 所有敏感 mutation 做 actor/project 权限检查；
- 错误码稳定，不让客户端依赖中文 message；
- V1 和 V2 路由明确隔离；
- 请求和事件带 correlation ID；
- 分页使用稳定 cursor，不按本机时间猜顺序。
- V2 route 放在 `src/server/routes/v2/*`；认证、maintenance barrier、mutation permit、correlation/idempotency 由共享 Fastify plugin/decorator 提供，V1/V2 只复用基础设施，不混用 payload schema；`http.ts` 仅负责装配。

## 16. 配置模型

### 16.1 控制面配置

```text
BIAO_DISTRIBUTED_MODE=1
BIAO_PUBLIC_URL=https://biao.example.lan
BIAO_ARTIFACT_ROOT=/var/lib/biao/artifacts
BIAO_GIT_PROVIDER=generic-git
BIAO_NODE_ENROLLMENT_TTL_SECONDS=600
BIAO_PROTOCOL_MIN_VERSION=2
BIAO_PROTOCOL_MAX_VERSION=2
BIAO_NODE_CLOCK_SKEW_WARN_SECONDS=30
BIAO_NODE_CLOCK_SKEW_DEGRADED_SECONDS=60
BIAO_NODE_CLOCK_SKEW_QUARANTINE_SECONDS=120
BIAO_NODE_DISK_LOW_GIB=10
BIAO_NODE_DISK_RECOVER_GIB=15
BIAO_NODE_DISK_LOW_PERCENT=10
BIAO_NODE_DISK_RECOVER_PERCENT=15
BIAO_NODE_HEARTBEAT_STALE_SECONDS=90
BIAO_LEASE_STOP_MARGIN_SECONDS=15
BIAO_ORPHAN_BRANCH_RETENTION_DAYS=30
BIAO_TEMP_UPLOAD_TTL_HOURS=24
BIAO_CERT_EXPIRY_WARN_DAYS=30,14,7
BIAO_RECOVERY_DECISION_TTL_SECONDS=900
BIAO_RECOVERY_CONTROL_PLANE_TAKEOVER_SECONDS=900
BIAO_CONTROL_PLANE_SIGNING_KEY_ROTATION_GRACE_HOURS=72
BIAO_PROJECT_MODE_TRANSITION_DEADLINE_HOURS=24
BIAO_TERMINAL_BRANCH_RETENTION_DAYS=30
BIAO_DELIVERY_REVIEW_STALE_SECONDS=14400
```

Secret 不写入普通配置示例。

### 16.2 Node 配置

```toml
node_id = "node-mac-01"
server_url = "https://biao.example.lan"
data_root = "/Volumes/BiaoNode"
max_concurrent_tasks = 2

[[projects]]
project_id = "offic"
local_cache_root = "/Volumes/BiaoNode/projects/offic"
checkout_mode = "worktree"
```

节点凭据单独存放在 owner-only 文件或操作系统 Keychain，不与 TOML 混放。

## 17. 可观测性

### 17.1 控制台新增页面

#### Nodes

- online/degraded/draining/offline/quarantined；
- protocol/build version；
- OS/arch；
- capacity/used slots；
- running attempts；
- disk low、Git unavailable、tool unavailable；
- last heartbeat 和 offline reason。
- clock skew、证书到期、trust-anchor generation、quarantine 根因、解除所需检查；
- infra 告警必须进入控制台全局横幅和持久 Incident 通道，支持 owner、ack、resolution SLO 和解除审计，不能只显示在节点详情页；Critical 5 分钟内 ack/4 小时内 resolve，High 30 分钟内 ack/24 小时内 resolve，超时进入 PM intake 提醒或要求 Owner 记录延期风险。

Incident resolve 必须提交 typed resolution evidence，且对应检测器已连续两个观察窗口恢复：Node 类要求健康检查通过但不能跳过 re-enrollment；outbox 类要求 pending age 回到阈值内且重放计数对账；Git/Artifact/restore 类要求 reconcile 无未解释偏差。resolve 只关闭 Incident，不直接把 quarantined Node 改为 online，状态恢复仍走 §5.3；同一 detector 再触发创建带 `recurrence_of` 的新记录，不修改或重开旧 Incident。

#### Deliveries

- task/attempt/node；
- base/head/tree SHA；
- changed files；
- Artifact 与 Verify；
- PM Review；
- Merge Job 与 final SHA；
- proposed 超过 4 小时未 Review 显示 stale，并开可指派 Incident，不能让下游无告警静默 pending；
- BranchCleanup 的 eligible/retention/status 与失败原因。

#### Projects

- Git connectivity；
- default branch/head；
- Node bindings；
- Artifact policy；
- merge policy；
- current conflicts 与 degraded reasons。

### 17.2 事件

新增：

```text
node_enrolled
node_online
node_degraded
node_draining
node_offline
node_quarantined
attempt_preparing
attempt_lease_at_risk
attempt_lease_lost
artifact_completed
delivery_proposed
delivery_invalidated
merge_queued
merge_conflict
merge_integration_failed
merge_completed
workspace_dirty
repository_diverged
workspace_prepare_failed
artifact_upload_failed
node_cert_expiring
node_clock_skewed
attempt_orphan_recovered
attempt_orphan_discarded
orphan_branch_detected
restore_reconcile_failed
incident_opened
incident_acked
incident_resolved
outbox_dispatch_stalled
recovery_signing_unavailable
recovery_control_plane_takeover
recovery_object_isolated
recovery_object_reviewed
recovery_object_resolved
branch_cleanup_due
branch_cleanup_failed
delivery_review_stale
```

### 17.3 指标

- queue wait；
- claim latency；
- workspace prepare duration；
- task duration；
- Lease renew failure；
- Artifact upload duration/failure；
- merge conflict rate；
- integration failure rate；
- node availability；
- orphan attempt count；
- recovery/reconcile duration；
- recovery signing availability 与 oldest pending Candidate age；
- stale proposed Delivery count/age；
- pending/failed BranchCleanup count/age。

## 18. 故障与恢复矩阵

| 场景 | 必须行为 | 禁止行为 |
| --- | --- | --- |
| Node 运行中断网 | 进入 at-risk，截止前停 Agent，保留 recovery bundle | 离线继续数小时并晚到 report |
| Node 掉电 | Lease 到期后新 generation 重领 | 旧节点回来覆盖新 Delivery |
| Node 时钟偏差 | 服务端时间判 lease；warn/degraded/quarantine 分级 | 信任节点墙钟延长合法写入窗口 |
| Git push 成功、API 超时 | 按 attempt/branch 幂等发现并续交付 | 创建第二个不关联 Delivery |
| branch 已 push、Delivery 未创建且 Node 永久离线 | 扫描 signed attempt marker，标记孤儿、审计期后受控清理 | 永久保留或无归属直接删 ref |
| Node 永久失联但 branch/Artifact 可验证 | lease/session fencing 后由控制面 CAS takeover，创建恢复 Delivery 并独立重验或留证 | 永久等待 Node ack 或与 Node 双重裁决 |
| Artifact 上传中断 | 断点或重传，未 complete 不可引用 | 把部分文件当成功结果 |
| Git Remote 暂时不可用 | Project degraded、暂停 prepare/merge、退避探测，恢复后 fetch+reconcile | 热循环重试或以本地 mirror 当远端真相 |
| Artifact Store 暂时不可用 | 暂停 complete/Delivery，保留本地 bundle，恢复后按 digest 重传 | 缺 Artifact 仍 proposed |
| Outbox dispatcher 卡死 | 指标超阈值开 Incident、degraded、暂停相关 claim，修复后按 revision 重放 | durable truth 前移后继续按旧 Redis 调度 |
| Redis 清空 | 从 DB 重建调度，再对账 Git/Artifact | 只恢复 task hash 就开放 claim |
| SQLite 损坏 | 进入维护屏障，从备份恢复并对账 | 带半投影继续服务 |
| Control Plane 重启 | durable outbox 重放 Redis 投影，旧 request 以 idempotency key 重放 | 重启即开放 claim 或重复创建 Delivery |
| 默认分支前移 | Merge CAS 失败并重新排队 | force push 覆盖他人提交 |
| Merge 推送后服务重启 | 以 expected/source/final SHA reconcile 原 MergeJob | 生成第二条合并或重复解锁下游 |
| Git 冲突 | conflict 状态和修复任务 | 自动 ours/theirs |
| accepted branch 被改写 | 失效 accept，重新验收 | 沿用旧签名继续合并 |
| 非 merged 终态 Delivery 超过保留期 | ReconcileService 按 BranchCleanup 复核引用与 HEAD 后删除 | Worker 自删或长期无界保留 |
| Node 磁盘满 | degraded/drain，拒绝新 worktree | 领取后才失败并污染队列 |
| 大小写冲突文件 | prepare 或 delivery fail closed | 在不同 OS 上静默丢文件 |
| Agent 进程忽略 TERM | 进程组 KILL，保持 attempt 审计 | 释放 slot 后残留写文件 |
| TLS 证书轮换/到期 | 双信任窗口、预告警、maintenance 紧急恢复 | 无预警一次性断开全部节点 |
| ref ACL 连续确认丢失 | 不等 Owner 即熔断写 Attempt/credential，再走 durable mode transition | 等人工决定期间继续 push/merge |
| mode transition 中控制面重启 | 从已提交 transition step 幂等续跑，保留 paused | 清空进度或重复 invalidate/裁决 |
| Recovery decision key 泄露 | revoke generation、失效未过期 decision、发布新 key 并重签 | 仅换私钥但继续接受旧裁决 |
| Recovery signing provider 不可用 | canary 失败开 Incident、Candidate 保持 pending、恢复后重签复验 | 静默堆积或返回无签名 decision |

## 19. 跨平台边界

### 19.1 路径

- 网络协议中的 repo path 统一 POSIX `/`；
- 禁止绝对路径、`..`、NUL 和控制字符；
- 校验 Windows 保留名、路径长度和大小写冲突；
- Ownership glob 在服务端用统一实现，不由各节点自定义解释。

### 19.2 Git 属性

项目应显式维护 `.gitattributes`：

- line endings；
- binary；
- executable bit；
- LFS；
- merge driver。

Node prepare 检测 `core.autocrlf` 等可能改变工作树真相的配置，并按项目策略拒绝或使用 worktree-specific config。

### 19.3 工具环境

Verify 记录：

- OS/arch；
- Node/npm 等关键版本；
- lockfile digest；
- task base/head SHA；
- Node image/runtime fingerprint。

验收不能用另一环境的旧成功结果替代当前 Delivery 的验证。

## 20. 数据库修改草案

### 20.1 新表

```text
projects
nodes
node_sessions
node_project_bindings
agent_slots
task_attempts
ownership_snapshots
deliveries
artifacts
artifact_blobs
merge_jobs
audit_events
outbox_events
idempotency_records
restore_points
backup_runs
incidents
external_merge_intents
orphan_recovery_candidates
recovery_isolations
branch_cleanups
evidence_acceptances
project_mode_transitions
legacy_project_bindings
project_memberships      # Human Identity 阶段启用
```

实现前必须把以下基础设施表固定为最小 durable schema；字段可以扩展，但不得少于这些身份、状态和恢复键：

| 表 | 最小字段 |
| --- | --- |
| `projects` | `project_id, display_name, repository_url, repository_fingerprint, default_branch, execution_mode, mode_transition, mode_transition_id, mode_transition_step, write_capability_status, status, revision, created_at, updated_at` |
| `node_project_bindings` | `node_id, project_id, repository_fingerprint, authorization_status, authorization_revision, applied_policy_revision, write_credential_status, health, last_checked_at` |
| `node_sessions` | `session_id, node_id, node_session_generation, credential_generation, status, started_at, last_seen_at, fenced_at` |
| `agent_slots` | `slot_id, node_id, session_id, capability_digest, status, active_attempt_id, updated_at` |
| `ownership_snapshots` | `snapshot_id, project_id, task_id, attempt_id, attempt_generation, read_globs, write_globs, revision, expires_at` |
| `audit_events` | `audit_id, project_id, actor_id, action, subject_type, subject_id, correlation_id, evidence_digest, created_at` |
| `outbox_events` | `event_id, project_id, aggregate_type, aggregate_id, aggregate_revision, payload_digest, status, attempt_count, next_attempt_at, last_error, dead_lettered_at, compensates_event_id` |
| `idempotency_records` | `actor_id, route, idempotency_key, request_digest, response_entity_type, response_entity_id, response_revision, expires_at` |
| `restore_points` | `restore_point_id, db_revision, git_refs_digest, artifact_manifest_digest, audit_high_water, outbox_high_water, status, created_at` |
| `backup_runs` | `backup_run_id, restore_point_id, component, manifest_digest, status, started_at, completed_at, error` |
| `project_mode_transitions` | `transition_id, project_id, from_mode, to_mode, step, status, idempotency_key, deadline_at, last_error, started_at, completed_at` |
| `orphan_recovery_candidates` | `candidate_id, attempt_id, project_id, marker_ref, branch_ref, head_sha, bundle_manifest_digest, recovery_path, status, decision, takeover_reason, takeover_at, node_ack_status, revision, decided_by, decided_at, resolved_at, resolution_evidence_digest` |
| `recovery_isolations` | `isolation_id, project_id, transition_id, object_type, object_id, evidence_digest, reason, status, isolated_by, isolated_at, retention_until, reviewed_by, reviewed_at, review_evidence_digest, resolved_by, resolved_at, resolution_evidence` |
| `branch_cleanups` | `cleanup_id, project_id, delivery_id, branch_ref, expected_head_sha, reason, status, eligible_at, retention_until, last_error, completed_at` |
| `external_merge_intents` | `intent_id, project_id, delivery_id, expected_target_sha, provider_actor, approved_by, reason, status, final_sha, created_at, resolved_at` |

### 20.2 现有表扩展

```text
plans: project_id, revision, source_digest, schema_version
tasks: project_id, active_attempt_id, accepted_delivery_id, accepted_evidence_id, completion_kind, blocked_reason, blocked_since, mode_transition_id
agent_registrations: 保留现有 generation/registration_source，新增 node_id, slot_id, protocol_version
```

### 20.3 关键唯一约束

- `projects(project_id)`；
- `nodes(node_id)`；
- `task_attempts(task_id, attempt_generation)`；
- `deliveries(attempt_id, head_sha)`；
- `artifacts(sha256, size_bytes)` 可去重，但授权仍按 project/task 记录；
- `legacy_project_bindings(legacy_project_path, repository_fingerprint)`；
- `idempotency_records(actor_id, route, idempotency_key)`；
- `merge_jobs(delivery_id, expected_target_sha)`；
- `node_project_bindings(node_id, project_id)` 且 authorization revision 单调递增；
- `incidents(incident_id)`、`external_merge_intents(intent_id)`；
- `orphan_recovery_candidates(candidate_id)` 且每个 attempt 同时最多一个 pending candidate；
- `evidence_acceptances(acceptance_id)`，且每个 task 同时最多一个未 supersede 的 accepted record；
- `project_mode_transitions(transition_id)`，且每个 project 同时最多一个 running transition；
- `project_mode_transitions` 的 `from_mode/to_mode/step` 必须满足 §4.1 方向-step 合法组合；
- `recovery_isolations(isolation_id)`，且同一 `object_type + object_id` 同时最多一个未 resolved 记录；
- `branch_cleanups(delivery_id, branch_ref, expected_head_sha)`；
- `outbox_events(event_id)`，`(aggregate_type, aggregate_id, aggregate_revision)` 可幂等定位；
- 同一 project 同时最多一个 running Merge Job；
- 默认分支 CAS 由 Git 真相再次保护。

### 20.4 迁移纪律

- 每次 migration 有版本号、前向和恢复说明；
- 旧库备份和 integrity check 是升级前门禁；
- migration 不在事务外分散写多个表；
- Redis V1/V2 namespace 不混用；
- 回滚不能删除已产生的 Delivery、Artifact 和 Audit。
- Phase 0 先引入 `schema_migrations(version, applied_at, checksum)` 和 migration runner；当前 `CREATE TABLE IF NOT EXISTS` 归档为 `001_baseline`，后续每个前向 migration 必须在备份副本上演练；SQLite 不承诺自动降级，回滚通过兼容旧二进制 + 保留新表完成。

## 21. 实施路线

### Phase 0a-1：迁移底座与 V1 基线

交付：versioned migration runner、`001_baseline`、备份副本 migration 演练、V1 测试基线、project identity 映射规则和阻塞报告。

### Phase 0a-2：模块边界与 V2 骨架

交付：

- V2 类型和状态机文档；
- 固定 §20.1 基础设施最小 schema、ProjectModeTransition/RecoveryIsolation/BranchCleanup/OutboxEvent/RecoveryDecision envelope 与生成式 route registry 门禁测试；
- `service.ts` 领域拆分接口：`ProjectService`（Project/Binding）、`NodeService`（Node）、`AttemptService`（claim/lease/Question）、`DeliveryService`（Artifact/Delivery/Review/repair/reverify）、`MergeService`（Merge/external intent）、`IncidentService`（Incident/SLO）、`ReconcileService`（outbox/restore/orphan/ownership）；
- V1/V2 共享 Fastify middleware plugin，`http.ts` 只装配；
- API schema；

门禁：0a-1 先通过；0a-2 完成后旧 `service.ts` 不再新增 V2 逻辑，现有 V1 测试和 package verify 不回退。

### Phase 0b：分布式测试基础设施

交付：本地 bare Git Remote、Artifact Store fixture、两个逻辑 Node、可控网络分区/进程中断/时钟偏差注入器，以及 V1/V2 兼容基线快照。所有后续 Phase 必须在此 fixture 上给出失败优先测试，不能只依赖 mock HTTP 200。

### Phase 1：Project/Node Identity

修改：

- `src/types/index.ts`；
- `src/db/schema.sql`；
- `src/db/sqlite-store.ts`；
- `src/redis/keys.ts`；
- `src/server/http.ts`；
- `src/server/service.ts`。

交付：Project Registry、Node Enrollment/Register/Heartbeat、Node→Project 显式授权、V2 project scoped Ownership，以及 Node/Attempt/Merge Bot credential split 的最小基础。Phase 1 起远程 Node 不得共用全局 Owner/Worker token；V1 Worker Token 对启用 V2 的 Project 的 claim/report/renew/Ownership 全部拒绝；Human Review 在 Phase 6 前仅允许控制面 loopback Local Owner，远程 Human 功能保持关闭。

验收：两台模拟节点使用不同本地路径，被识别为同一 Project；旧 agent generation 不能覆盖新节点 session。

### Phase 2：Artifact Store

交付：

- 内容寻址存储；
- initiate/upload/complete/read；
- Report V2 Artifact refs；
- PM Review V2；
- GC 和备份说明。

验收：服务端无 Worker 文件挂载，仍可完整 Review；篡改、超限、跨任务引用被拒绝。

Phase 2 与 Phase 3 在 Phase 1/0b 通过后可由互不重叠文件 owner 并行开发；端到端 Node→Artifact→Delivery 门禁在二者集成后统一验收，不把单 lane 绿色当闭环。

### Phase 3：biao-node Skeleton

交付：

- Node daemon；
- slots；
- Node heartbeat；
- drain/offline；
- launchd/systemd/Windows service 模板；
- PowerShell Windows installer、Credential Manager 和 Event Log 适配；
- protocol compatibility。

验收：节点重启、掉线、drain 不产生重复 claim；旧 session 被 fencing。

### Phase 4：Git Workspace 与 Delivery

交付：

- Git Provider Interface；
- generic-git adapter；
- worktree/clone-per-attempt；
- branch/commit/push；
- 服务端 diff 验证；
- Delivery 状态机。

验收：两节点并行不同文件不覆盖；Ownership 外文件、force-push、remote mismatch 被拒绝。

Phase 4 工作量按独立 Prepare/Finalize 状态机估算，至少覆盖 remote fingerprint、base reachability、attempt marker、磁盘水位、signed branch marker、Artifact 中断和孤儿分支；不能把当前本地 snapshot/report 直接视为大部分已完成。

### Phase 5：Merge Queue

交付：

- 单项目串行队列；
- default branch CAS；
- integration workspace；
- conflict/integration_failed；
- merged 后下游解锁。

验收：无冲突自动合并；真实冲突保持可审计；失败不更新主分支。

### Phase 6：Human Identity 与 RBAC

交付：

- 远程登录；
- project membership；
- 把 Phase 1 的最小 Node/Attempt/Merge Bot credential split 扩展为轮换、审计、细粒度项目授权和紧急撤销；
- 完整远程 Human Identity、project membership 和细粒度 RBAC；
- Web/CLI 权限；
- Security audit。

验收：Worker 不能 Review/merge；Reviewer 不能管理 Node；跨项目 Artifact 不可读。

### Phase 7：Web 可观测与运维

交付：Nodes、Projects、Deliveries、Merge Jobs 页面；持久 Incident 表/API/SLO；Project mode transition 进度与恢复；Recovery Candidate 批量 takeover/isolate、Isolation resolve、BranchCleanup list/retry；dead-letter list/show/requeue/compensate 的 API/CLI；BackupCoordinator 与隔离 restore drill；告警与指标；备份/恢复/升级 runbook。

验收：页面、API、CLI 三者对同一节点/交付/合并状态一致。

Phase 7 可拆为 7a（API/CLI、指标、告警和 runbook，生产启用前必需）与 7b（完整 Web 页面，允许在 CLI 能覆盖同等处置能力时作为非阻塞 Low 延后）；延期必须有 owner、目标版本和重新决策日期。

当前延期决策：owner=`Distributed Implementation PM`；目标版本=`Biao Distributed v2 Phase 7b`；重新决策时间=`Phase 7 立项评审日或 2026-10-01，取更早者`。若 CLI/API 不能覆盖 Incident ack/resolve、quarantine/re-enroll、mode transition、Recovery takeover/isolate/resolve、BranchCleanup retry、dead-letter requeue/compensate 或 restore drill，则 7b 自动升为阻塞项。

V1 `work/<task_id>/` 迁移由 Phase 2 的 Artifact owner 负责：先清点并上传仍在审计期的 result/verify 文件，再核对旧 Review 可读性；未迁移完成前 23.3 必须备份该目录。验收门禁是 V1 历史 Review 抽样可读且清单无未解释缺口。

### Phase 8：真实多机 E2E 与灰度

顺序：

1. 单机 V2 loopback；
2. 两节点、同 OS；
3. 两节点、不同 OS；
4. 故障注入；
5. 一个真实项目只读 acceptance；
6. 一个低风险真实任务 branch/push；
7. 人工确认 Merge Queue；
8. 小范围自动 Merge Queue；
9. 保留 V1 回退窗口；
10. 完成迁移和清理。

“低风险”必须同时满足：只修改测试/文档或隔离 fixture 路径、无生产 Secret/发布/数据库迁移、Ownership 唯一、V1/V2 回归全绿、独立节点验收、人工检查 branch diff；首次任务只允许手工 Merge Queue。任一 remote fingerprint、diff、verify、Artifact、CAS 或恢复门禁失败立即停止新 V2 claim、drain 节点、保留 branch/Artifact/Audit 并按 23.2 回退。

## 22. 验收矩阵

### 22.1 功能

- [ ] 不同绝对路径的两节点共同处理同一 Project；
- [ ] 不重叠任务并行执行；
- [ ] 重叠 Ownership 不并行写；
- [ ] 每个 Attempt 有独立工作区和分支；
- [ ] Worker 不共享本地结果目录也可 Review；
- [ ] 独立 acceptance 绑定 commit；
- [ ] PM accept 后 Merge Queue 合并；
- [ ] merged 后下游解锁；
- [ ] 冲突生成明确修复路径；
- [ ] repair/reverify 审计不被 Git 流程覆盖。

### 22.2 一致性

- [ ] claim、renew、report、Delivery 都有 generation fencing；
- [ ] Git push/API response 丢失可幂等恢复；
- [ ] Artifact/DB/Git 三方可对账；
- [ ] accepted branch 改写会失效；
- [ ] force-push 后 branch HEAD 与 Delivery 不同，Merge 必须拒绝并撤销 accept；
- [ ] Merge CAS 防止覆盖目标分支前移，rebase 后生成新 Delivery 并重新 Verify/Review；
- [ ] Redis 恢复不会开放半投影；
- [ ] stale Node 不会覆盖新 Attempt。
- [ ] ownership snapshot 在 Redis 清空后可安全重建；
- [ ] durable-first outbox 在每个崩溃点可幂等重放；
- [ ] V1 Worker Token 无法 claim/report/renew 已迁移 V2 Project；
- [ ] 从 V1 route registry 生成的测试证明全部 mutation 对 V2 Project 被拒绝；
- [ ] V1 plan create/submit/supersede 与 question create/answer 也由同一 registry 测试覆盖；
- [ ] V1 registry 中 legacy lifecycle、PM transport、maintenance 与 read-only 路由有显式分类，未分类 mutation 构建失败；
- [ ] orphan recovery 创建新 Delivery 后仍须独立 acceptance；
- [ ] signed marker 缺失/验签失败不会自动恢复或清理 branch；

### 22.3 安全

- [ ] Node 凭据相互独立且可撤销；
- [ ] Attempt Token 只能操作单任务；
- [ ] Worker 无 PM/Merge 权限；
- [ ] Merge Bot 无 Agent/Plan 权限；
- [ ] Artifact digest、路径、大小、项目权限全部校验；
- [ ] Agent 子进程无 Biao/Redis/SQLite 凭据；
- [ ] 远程浏览器不使用 Local Owner Cookie；
- [ ] 日志不泄露 Secret。
- [ ] 恶意/失陷实现节点不能自验收进入主线；
- [ ] generic-git ref ACL 阻止 Node 推默认分支/tag/他人 branch；
- [ ] 证书双信任轮换不造成集群整体离线。
- [ ] 未授权或已 revoke 的 NodeProjectBinding 无法 claim/read/deliver；
- [ ] 无 Remote ref ACL 的 Project 只能 read-only acceptance；
- [ ] read-only acceptance 的 Plan import 拒绝所有写任务和写依赖，不产生永久 pending；
- [ ] full Project 的 Artifact-only 任务以 EvidenceAcceptance 完成且不能解锁写 lineage；
- [ ] full→read-only 先暂停/drain/cancel/invalidated，所有写 lineage 收口后才原子切换；
- [ ] ref ACL 连续确认丢失后不等待 Owner 就 fencing running write Attempt、撤销 push/merge credential；
- [ ] full→read-only 覆盖 proposed/accepted/merging Delivery、所有 MergeJob、pending Candidate 与依赖被阻塞写 lineage 的只读 Task；
- [ ] read-only→full 全量 reconcile 后只开放新 Attempt，旧 invalidated Delivery/Review 与 blocked Task 不自动复活；
- [ ] read-only→full 的 `validate-capability/reconcile/refresh-bindings/revalidate-plans` step 可持久化、逐步重启续跑并受 24 小时 deadline 约束；
- [ ] 恢复 full 时离线 Node 不阻塞切换且无有效旧 credential，回归需重新同步 policy/binding 后才取得新 push credential；
- [ ] Node signing key 轮换后旧 marker 在审计期内仍可验签；
- [ ] Control Plane Recovery Signing Key 双信任轮换、紧急 revoke 和历史公钥归档不会接受失效 decision；

### 22.4 故障恢复

- [ ] Node 断网；
- [ ] Node 掉电；
- [ ] Control Plane 重启；
- [ ] Control Plane 在 mode transition 每个 step 重启都从 durable step 幂等续跑；
- [ ] mode transition 超期隔离通过 durable RecoveryIsolation API/CLI 留证，重启后仍从正常 reconcile 排除且关闭需独立复核；
- [ ] RecoveryIsolation 强制 isolator、Reviewer、ReconcileService 三步分权，同一 actor 不能自建自审，review/resolve 字段和事件可审计；
- [ ] Redis 清空；
- [ ] SQLite 备份恢复；
- [ ] Git Remote 暂时不可用；
- [ ] Artifact Store 暂时不可用；
- [ ] Merge 过程中服务重启；
- [ ] 磁盘满；
- [ ] Agent 进程失控。
- [ ] 节点时钟快/慢超过阈值；
- [ ] TLS 证书轮换与到期；
- [ ] branch 已 push 但 Delivery 未创建；
- [ ] 同一 restore point 的 SQLite/Git/Artifact/Audit 全量恢复与冒烟；
- [ ] outbox 卡死会开 Incident、degraded 并可按 revision 重放；
- [ ] dead-letter 只能 requeue 或 compensating event 收口，不能跳过；
- [ ] dead-letter API/CLI 展示 revision/digest/error，requeue 原键且 compensate 有审计关联；
- [ ] 隔离 restore drill 不写真实 Remote；
- [ ] quarantine 解除必须 re-enroll；
- [ ] 进入 quarantine 会立即 fencing/cancel running Attempt 并撤销 Git/signing credential；
- [ ] 人工 merge 回写 fixed Delivery、Integration Verify 和下游解锁；
- [ ] Node 重启在 claim 前扫描 recovery bundle，未获 signed decision 不删除；
- [ ] recovery decision 缺字段、签名错误、key generation 被 revoke 或超过 15 分钟时拒绝并幂等重新获取；
- [ ] recovery decision 以 heartbeat server time 单调偏移验 TTL，偏移过旧或时钟不确定时拒绝并 refetch；
- [ ] 永久失联 Node 的 Candidate 在 lease/session fencing 后由控制面 CAS takeover，和 Node 驱动路径不会双重裁决；
- [ ] control-plane takeover 在 CAS 后、创建恢复 Delivery 后、更新 Attempt 后分别崩溃都按 Candidate revision/status 与确定性 Delivery 键续跑；
- [ ] 同一 outage 的批量 takeover/isolate 仍为每个 Candidate 保留独立证据、actor 和结果；
- [ ] 批量 takeover/isolate 逐项部分成功，响应返回每项 revision/error，重试不重复成功项；
- [ ] rejected/superseded/conflict/integration_failed/invalidated Delivery 全部自动创建 BranchCleanup，保留期/引用/HEAD 门禁满足后才由控制面删除；
- [ ] BranchCleanup retry 遇到 Remote ref 已不存在时幂等记 deleted；调用者不能指定任意 branch，删除只由专用身份执行；
- [ ] Recovery signing canary 失败开 Incident，Candidate fail closed，恢复后重签复验；
- [ ] Incident resolve 有 typed evidence，且不绕过 Node 状态机；
- [ ] Incident 超 resolution SLO 提醒；同 detector 再触发创建 recurrence 记录而不重开旧记录；
- [ ] proposed Delivery 超过 4 小时未 Review 产生可指派告警；
- [ ] 默认分支出现无 MergeJob/external intent 的 SHA 时触发 maintenance、credential revoke、审计化 revert、Integration Verify 与三方 reconcile 演练；
- [ ] 旧 Node credential/session generation 被拒绝 claim、heartbeat、Artifact upload 和 Delivery；
- [ ] 重复 claim/report/deliver 只返回原实体或稳定冲突，不产生第二个 Attempt/Delivery；

### 22.5 跨平台

- [ ] macOS arm64；
- [ ] Linux x64；
- [ ] Windows x64；
- [ ] Windows PowerShell 安装、Credential Manager、Service 启停/升级/卸载；
- [ ] 大小写冲突；
- [ ] CRLF/LF；
- [ ] executable bit；
- [ ] symlink；
- [ ] submodule fallback；
- [ ] 非文本 Office 文件独占。

## 23. 发布与回滚

### 23.1 Feature Flags

```text
BIAO_DISTRIBUTED_MODE
BIAO_V2_ARTIFACTS
BIAO_V2_NODE_RUNTIME
BIAO_V2_GIT_DELIVERY
BIAO_V2_MERGE_QUEUE
```

功能必须按依赖顺序启用，不能让 Merge Queue 在 Artifact/Delivery 不完整时提前开放。

### 23.2 回滚

- 停止新 V2 claim；
- drain Nodes；
- 保留已完成 Delivery/Artifact/Audit；
- 未合并 branch 保留；
- V1 服务可继续处理尚未迁移 Plan；
- 不把 V2 task 强制降级回 `project_path`；
- 恢复后以 Project Binding 重新接管。
- V2 Project 即使停止新 claim，也继续以 `merged` 作为依赖完成口径；accepted-not-merged 不得降级给 V1；
- 记录 feature flag、schema version、Node protocol、最后可恢复 restore point 和所有未终态 Attempt/Delivery/MergeJob 清单。

### 23.3 备份

- Git Remote 自有备份；
- SQLite 在线备份和 integrity check；
- Artifact 增量备份；
- 配置与密钥分开备份；
- Redis AOF 作为运行态加速，不作为唯一恢复来源；
- 定期执行真实 restore drill，而非只确认备份文件存在。
- 所有组件备份必须绑定 14.6 的同一 `restore_point_id`；V1 过渡期的 `work/<task_id>/` 结果目录也进入备份或先迁移为 Artifact；
- restore drill 必须保留 RPO/RTO、三方计数/digest、未解释偏差、抽样下载和恢复后冒烟证据。

## 24. 关键设计决策记录

| ID | 标签 | 决策 | Why not alternative |
| --- | --- | --- | --- |
| D-001 | preserve | 中央控制面单写 | 每节点独立控制面会产生多套任务和验收真相 |
| D-002 | replace | `project_id` 替代跨网绝对路径 | 统一挂载路径不适配不同 OS，也把 NAS 变成单点工作树 |
| D-003 | new | Git Remote 是源码真相 | 自研文件同步会重复版本控制并难以审计合并 |
| D-004 | new | 每 Attempt 隔离 workspace/branch | 同一 checkout 并发会发生 checkout、restore 和 dirty 竞态 |
| D-005 | replace | Artifact 引用替代远程本地路径 | 共享文件路径不具备可移植性、完整性和权限边界 |
| D-006 | extend | Task、Attempt、Delivery、Merge 分层 | 把全部状态塞进 task.status 会破坏现有 repair/review 语义 |
| D-007 | new | Merge Bot 单写默认分支 | Worker 直推主分支绕过独立验收和集成门禁 |
| D-008 | preserve | 现有 Task 业务状态机保留 | 全量重写高风险且无必要 |
| D-009 | replace | Supervisor 演进为 biao-node | 每 Worker 轮询和脚本无法表达节点资源、版本和仓库健康 |
| D-010 | new | Human/Node/Attempt/Merge 身份分离 | 单全局 Token 泄露半径过大且无法逐节点撤销 |
| D-011 | extend | Ownership 按 Project 命名空间 | 全局 `src/**` 会让不同项目误冲突 |
| D-012 | replace | 活跃 Attempt 不盲目 preempt | 替换 Redis ownership 不能撤回远端已发生的文件写入 |
| D-013 | new | Lease 风险截止前停止 Agent | 仅打印 renew 错误会产生长时间 stale work |
| D-014 | replace | 上传 Plan Snapshot | 服务端读取远程 PM 的本地 plan_dir 不成立 |
| D-015 | preserve | MVP 继续中央 SQLite 单写 | 多机 Worker 不要求立即迁库，先稳定领域模型 |
| D-016 | extend | `/v1` 与 `/v2` 并存迁移 | 大爆炸升级不可安全灰度和回退 |
| D-017 | new | Repo path 使用 POSIX 规范 | Windows/macOS/Linux 的路径语义不同 |
| D-018 | new | submodule 项目回退独立 clone | Git worktree 的 submodule 支持边界更复杂 |
| D-019 | new | 非文本文件 exclusive policy | Git/LFS 不能自动解决 Office 二进制语义合并 |
| D-020 | extend | Acceptance 绑定 commit 与独立级别 | 不绑定 commit 的测试无法证明当前交付 |
| D-021 | extend | 共享事件驱动 Node 调度 | 每 slot 高频轮询浪费资源并制造状态噪声 |
| D-022 | new | 三方 reconcile | DB、Git、Artifact 任一单独都不能证明完整交付 |
| D-023 | new | merged 才解锁普通下游 | accepted 但未集成的分支不能作为主线依赖真相 |
| D-024 | new | Protocol 版本协商与 drain 升级 | 分布式节点版本漂移会产生不可解释行为 |
| D-025 | new | V2 durable-first + outbox，Redis 只作投影 | Redis/SQLite 双写无协议会制造半投影和重复实体 |
| D-026 | new | 显式 legacy binding，不按路径 hash 生成 project_id | 同一仓库跨 OS 路径不同，路径 hash 会分裂项目身份 |
| D-027 | new | 分布式写任务默认独立节点验收 | 失陷执行节点自报 Verify 不能证明交付可信 |
| D-028 | new | Merge 前同时校验 branch HEAD 与 target CAS | 仅检查目标分支不能阻止已验收 task branch 被改写 |
| D-029 | new | 备份以 restore point 水印形成一致恢复集 | 分别存在的备份文件不能证明证据链同一时点 |
| D-030 | new | generic-git 必须有 ref 级 ACL | 纸面权限不能阻止 Worker 直推默认分支 |
| D-031 | new | NodeProjectBinding 必须由控制面显式授权 | Node 本地配置不能自行取得项目任务与制品权限 |
| D-032 | new | 孤儿恢复不继承原 Node 的 Verify 信任 | 恢复数据完整不等于执行证据可信 |
| D-033 | new | Incident 是持久领域实体 | 页面横幅或日志不能承担 ack/SLO/解除审计 |
| D-034 | new | BackupCoordinator 编排一致恢复集与隔离演练 | 分散脚本无法证明同一 restore point，也可能污染真实 Remote |
| D-035 | new | 无 ref ACL 时降级为 read-only acceptance | Node 侧校验不能防失陷 Node 越权 push |
| D-036 | new | read-only acceptance 只允许 Artifact-only DAG | 没有 push/merge 能力时派发写任务只会永久阻塞 |
| D-037 | new | quarantine 等同安全撤权并立即 fencing | 只禁止新 claim 会让可疑节点继续持有合法 Attempt |
| D-038 | new | Node 启动先 reconcile 本地 recovery bundles | 掉电路径不会执行正常 at-risk 清理，证据不能靠人工发现 |
| D-039 | new | marker signing key 独立版本化并保留旧公钥 | 凭据轮换不能破坏历史归属证据验签 |
| D-040 | new | full→read-only 必须 pause/drain/reconcile 后原子切换 | 直接改模式会遗留无法 push/merge 的写 lineage |
| D-041 | new | Artifact-only 完成使用 EvidenceAcceptance durable record | 把 evidence_accepted 塞进 Attempt/Delivery status 会混淆代码集成与证据验收 |
| D-042 | new | ref ACL 确认丢失立即熔断，模式选择随后进行 | 等待 Owner 决策会留下合法写 Attempt 和 push 窗口 |
| D-043 | new | Project mode transition 是可恢复、幂等的 durable 状态机 | 内存中的步骤序列无法承受控制面重启和部分失败 |
| D-044 | new | Recovery decision key 独立 generation、双信任轮换与紧急撤销 | 固定公钥没有泄露处置、离线节点回归和历史验签边界 |
| D-045 | new | dead-letter 只有受审计 requeue 或 compensating event | skip/mark-delivered 会永久掩盖 durable truth 与投影分歧 |
| D-046 | new | 双向 mode transition 使用一套显式 durable step 枚举与 deadline | 只有散文步骤无法在重启后恢复反向转换 |
| D-047 | new | 超期残留必须进入 RecoveryIsolation durable record | 临时清单不能证明隔离范围、证据和解除责任 |
| D-048 | new | 永久失联 Node 的 Candidate 可由控制面 CAS takeover | 永久等待 Node ack 会卡死恢复，双 owner 又会重复裁决 |
| D-049 | new | 非 merged 终态 branch 由 ReconcileService 按记录和保留期清理 | 只清孤儿 branch 会让有归属的失败分支无界增长 |
| D-050 | new | RecoveryIsolation 关闭必须结构化三步分权 | 单一 Owner 自隔离自关闭无法证明独立复核 |
| D-051 | new | Candidate 用 revision/status/resolution digest 承载 takeover CAS 与收口 | 只有路径字段无法在崩溃重启后判断是否已经执行 |
| D-052 | new | BranchCleanup 覆盖包括 invalidated 在内的所有非 merged 终态 | 有归属的失效分支同样不会被 orphan 扫描发现 |

## 25. 风险登记

| 风险 | 严重度 | 缓解 | 重新评估门槛 |
| --- | --- | --- | --- |
| `service.ts` 已过大，继续堆功能难维护 | High | 先抽领域服务和 V2 route，不把新逻辑继续集中 | Phase 1 开始前完成模块边界设计 |
| Redis/SQLite 双写窗口扩大 | High | 新实体优先 durable transaction，再发布 runtime projection | Delivery/Node 表落地前完成提交协议 |
| Git Provider 差异 | Medium | 首版 generic-git，Provider PR 后续适配 | 真实项目必须依赖 Provider 审批时 |
| Artifact 增长 | Medium | 限额、retention、GC、备份指标 | 数据量或备份窗口超过 SLO |
| Node 被恶意 Plan 命令利用 | High | RBAC、项目策略、最小 Secret、后续沙箱 | 开放给非完全可信 Planner 前必须关闭 |
| 多 OS 文件语义差异 | High | prepare portability gate、`.gitattributes`、真实跨 OS E2E | Windows 节点上线前必须关闭 |
| Merge Queue 成为瓶颈 | Medium | 按 project 串行、跨 project 并行、指标 | 实测等待超过 SLO |
| SQLite 成为瓶颈 | Low/MVP | 单写、本地盘、指标；满足门槛后迁 Postgres | 见 14.3 |
| worktree 残留耗尽磁盘 | Medium | retention、drain、GC、磁盘低水位 | 任一节点低水位告警频繁出现 |
| 旧 V1/V2 状态语义分裂 | High | 兼容层、迁移测试、Feature Flag、不可逆审计不降级 | 首个 V2 Plan 迁移前必须关闭 |
| 证书轮换造成全节点离线 | High | 到期告警、双信任窗口、maintenance 恢复演练 | 首台远程 Node 上线前必须关闭 |
| 恶意节点伪造交付证据 | High | 默认 node/node+harness 独立验收、Remote/Artifact 重算 | 非完全可信 Node 加入前必须关闭 |
| 孤儿 branch/bundle 长期泄漏 | Medium | signed marker、定期 reconcile、审计期和受控 GC | orphan 指标持续增长或磁盘低水位 |
| 恢复组件时间点不一致 | High | restore_point_id、水印清单、真实 drill 和 fail closed | 分布式模式生产启用前必须关闭 |
| V1 Token 绕过 V2 交付链 | High | 项目模式门禁、V1/V2 API 不混用 | 首个 Project 启用 V2 前必须关闭 |
| Node 自行声明项目绑定 | High | 控制面 allowlist/授权 revision/revoke | 第二个 Project 或非可信 Node 加入前必须关闭 |
| Outbox 投影长时间停滞 | High | dispatcher lease/指标/Incident/degraded/replay | durable-first 写路径启用前必须关闭 |
| read-only Project 写任务永久 pending | High | execution_mode、Plan import 拒绝、稳定阻塞码 | 任一无 ref ACL Project 注册前必须关闭 |
| quarantined Node 继续运行 | High | credential/session fencing、cancel_requested、撤销 Git/signing key | quarantine 功能启用前必须关闭 |
| 掉电 recovery bundle 未被发现 | Medium | Node 启动 claim 前扫描、signed decision 后清理 | Phase 3 Node restart 验收前必须关闭 |
| 模式切换部分完成或重启后卡住 | High | durable transition step、24h deadline、隔离清单与 fail closed | mode transition API 开放前必须关闭 |
| Recovery decision signing key 泄露或轮换漂移 | High | 双信任、generation ack、紧急 revoke/reissue、历史公钥归档 | 首个 recovery Candidate 自动裁决前必须关闭 |
| 永久失联 Node 的 Candidate 无人接管 | High | lease/session fencing 后控制面 CAS takeover，批量入口仍逐项留证 | 多节点故障演练前必须关闭 |
| 非 merged 终态 branch 无界增长 | Medium | BranchCleanup durable record、30 天保留期、引用/HEAD 复核 | 首个真实 V2 Project 灰度前必须关闭 |

## 26. 不在首版范围

- 多控制面 Active-Active；
- Kubernetes 自动扩缩；
- 云端按 Token/成本计费；
- 任意用户上传不可信容器镜像；
- 跨地域弱网同步；
- 多分支 DAG 组合工作区；
- 自动语义合并 Office 二进制文件；
- 全部 Git Provider 的 PR/Review API；
- 立即替换 Redis 或 SQLite。

## 27. 文档与代码文件映射

| 领域 | 现有入口 | 预期新增/拆分 |
| --- | --- | --- |
| Config/启动 | `src/server/main.ts`, `scripts/bootstrap.mjs` | distributed config, node installer |
| HTTP | `src/server/http.ts` | `src/server/routes/v2/*` |
| 核心服务 | `src/server/service.ts` | `src/server/services/{projects,nodes,attempts,deliveries,merge,incidents,reconcile}.ts`；Review/repair 属 Delivery，Question 属 Attempt，Incident 归 IncidentService；旧 service 仅 facade/兼容层 |
| Redis | `src/redis/keys.ts`, `ownership.ts` | V2 project namespace, node/attempt leases |
| Durable DB | `src/db/schema.sql`, `sqlite-store.ts` | `src/db/migrations/*`, migration runner, domain repositories, outbox/reconcile |
| Worker | `src/worker/base.ts`, `supervisor.ts` | `src/node/*`, workspace manager |
| Artifact | 当前本地 `work/` | `src/artifacts/*` |
| Git | 当前 HEAD/diff 辅助 | `src/git/*` |
| Merge | 无 | `src/merge/*` |
| Web | `web/src/*` | Nodes/Projects/Deliveries/Merge Jobs |
| 测试 | `tests/*` | multi-node, git, artifact, merge, partition E2E |

## 28. PM 多轮审评协议

### Round 1：独立发现

- Lane A：架构、一致性、安全、状态机；
- Lane B：实现可行性、API、迁移、测试；
- Lane C：长上下文完整性、运维、故障恢复、产品边界。

所有 lane 只读，不修改本文。输出必须包含：

- Strengths；
- Concerns：ID、严重度、引用章节、失败场景；
- Required Changes；
- Optional Suggestions；
- Verdict：APPROVE/REVISE/REJECT。

### Round 2：交叉复评

主会话合并并修订 Round 1 后，复评者必须：

- 检查每条 Critical/High 是否真实关闭；
- 检查修订是否产生新矛盾；
- 对其他 lane 的关注面做至少一项交叉核验；
- 只引用当前文档版本，不复述已删除草稿；
- 给出剩余问题和最终 verdict。

### Round 3+：条件触发与收敛循环

如果任一轮仍有 Critical/High/Medium，或不同复评者对核心决策结论冲突，则由主会话核验、修订并开展下一轮。只有连续一轮没有新增 Critical/High、全部 Medium 已关闭或带 Owner/门槛延期，并且三视角均 APPROVE 或只剩 Low，才记录收敛矩阵并结束审评。

## 29. 修订记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v0.1.0-review-draft | 2026-08-15 | 基于当前 Biao 代码编制首版多机协同改进方案，等待 PM Round 1 |
| v0.2.0-round1-revision | 2026-08-15 | 合并 R1-A/B/C：关闭合并防脑裂、身份迁移、授权前置、durable-first、恢复点、时钟/证书、Windows、孤儿分支等阻塞项，等待 Round 2 |
| v0.3.0-round2-revision | 2026-08-15 | 合并 R2-A/B/C 的 Medium/Low：V1/V2 模式门禁、NodeProject 授权、孤儿恢复再验、Incident/BackupCoordinator、外部 merge 回写、outbox/marker/离线证书闭环，等待 Round 3 |
| v0.4.0-round3-revision | 2026-08-15 | 关闭 R3 read-only 死锁、quarantine 运行窗口、重启 bundle 扫描及 marker/Incident/恢复冒烟/Phase 7b 延期细节，等待 Round 4 |
| v0.5.0-round4-revision | 2026-08-15 | 关闭 R4 full→read-only 转换、EvidenceAcceptance/Incident/recovery schema、decision/marker 词表与签名、V1 路由门禁测试、outbox dead-letter 处置，等待 Round 5 |
| v0.6.0-round5-revision | 2026-08-15 | 关闭 R5 ACL 丢失即时熔断、可恢复双向 mode transition、Delivery/Candidate/依赖收口、Recovery Signing Key 生命周期、decision TTL、dead-letter 操作面、Incident SLO/复发与基础设施最小 schema，等待 Round 6 |
| v0.7.0-round6-revision | 2026-08-15 | 关闭 R6 双向 transition 枚举/deadline、RecoveryIsolation、永久失联 Node takeover、终态 BranchCleanup、离线 Node 回归、V1 豁免分类、server-time decision、signing/stale review 告警与全部 Low，等待 Round 7 |
| v0.8.0-round7-revision | 2026-08-15 | 关闭 R7 invalidated BranchCleanup、Candidate revision/status/收口 schema、Isolation 三步独立复核，以及方向-step、retry 权限、takeover 重启、batch 部分成功、默认分支验收等全部 Low；Round 8 三路 APPROVE，方案收敛 |

## 30. 参考

- 当前项目：`README.md`、`docs/worker-integration.md`、`src/server/main.ts`、`src/server/http.ts`、`src/server/service.ts`、`src/worker/base.ts`、`src/worker/supervisor.ts`、`src/redis/keys.ts`、`src/redis/ownership.ts`、`src/db/schema.sql`、`src/db/sqlite-store.ts`；
- Git worktree 官方文档：<https://git-scm.com/docs/git-worktree>；
- GitHub Self-hosted Runners 官方参考：<https://docs.github.com/en/actions/reference/runners/self-hosted-runners>。
