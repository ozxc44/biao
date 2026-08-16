# Phase 8 灰度发布 Runbook（V2 分布式面灰度与回退）

> 适用范围：`docs/distributed-multi-node-development-plan.md` §21 Phase 8。
> 本文是灰度就绪件：低风险准入清单、立即停止条件、§23.2 八条回退步骤的
> 命令映射、五旗开关顺序、双物理机接入剧本、V1 回退窗口保留策略。
>
> 对应测试：`tests/distributed/p8-loopback-e2e.test.ts`（单机闭环）、
> `p8-two-nodes.test.ts`（双逻辑节点）、`p8-fault-matrix.test.ts`（故障矩阵）、
> `p8-rollback-window.test.ts`（回退窗口逐条断言）。

## 0. 五面 Feature Flag（§23.1）

| 顺序 | 旗（env 变量） | 管辖面 | 前置旗（必须先开） | 关闭时行为 |
|---|---|---|---|---|
| 1 | `BIAO_DISTRIBUTED_MODE` | 整个 `/v2` 面（总开关） | —— | `/v2/*` 一律 404 `V2_DISABLED`（纯 V1）；唯一例外 `GET /v2/feature-flags` 仍可读（owner） |
| 2 | `BIAO_V2_ARTIFACTS` | `/v2/artifacts*`（§9 三段上传/读面） | DISTRIBUTED_MODE | 404 `V2_FLAG_DISABLED` |
| 3 | `BIAO_V2_NODE_RUNTIME` | `/v2/nodes*`、`/v2/tasks/claim`、`/v2/attempts/:id/lease|report`（§10 数据面） | ARTIFACTS | 404 `V2_FLAG_DISABLED` |
| 4 | `BIAO_V2_GIT_DELIVERY` | `/v2/attempts/:id/workspace*`、`/v2/deliveries*`、`/v2/workspace-recovery`、`/v2/branch-cleanups`、`/v2/evidence-acceptances`（§6/§4.5） | NODE_RUNTIME | 404 `V2_FLAG_DISABLED` |
| 5 | `BIAO_V2_MERGE_QUEUE` | `/v2/merge-jobs*`、`/v2/projects/:id/merge-jobs*`、`/v2/projects/:id/write-capability`（§12） | GIT_DELIVERY | 404 `V2_FLAG_DISABLED` |

- 管理/观测面（`/v2/projects`、`/v2/human-sessions`、`/v2/incidents`、
  `/v2/recovery-*`、`/v2/outbox`、`/v2/metrics`、`/v2/backup`）只受总开关管辖，
  回退窗口内仍可读（运维与审计依赖）。
- 值域：`1/true/yes/on` 开，`0/false/no/off` 与缺省关；其它值视为配置错误，
  **服务拒绝启动**（不静默当关）。
- **乱序启动 fail-fast**：开某面旗而前置旗未开 → `createHttpServer` 装配期抛
  `V2FeatureFlagOrderError`，错误消息逐面列出缺的 env 变量名，服务不 boot。
  例：只设 `BIAO_V2_MERGE_QUEUE=1` → 报缺
  `BIAO_DISTRIBUTED_MODE, BIAO_V2_ARTIFACTS, BIAO_V2_NODE_RUNTIME, BIAO_V2_GIT_DELIVERY`。
- 开旗顺序 = 表中顺序；**关旗按反序逐面收口**（先 MERGE_QUEUE，最后
  DISTRIBUTED_MODE），任何时刻保持"前缀合法"（开着的旗一定是表的前缀）。

### 旗态观测

```bash
curl -s -H "Authorization: Bearer $BIAO_API_TOKEN" http://<控制面>:7331/v2/feature-flags | jq
# 返回五旗行：flag / env_var / enabled / prerequisites[] / prerequisites_satisfied
# + distributed_mode + order_valid（装配期已 fail-fast，运行期恒 true）
```

## 1. 低风险准入六条件（可勾选模板）

首次把一个真实项目接入 V2 前，逐条勾选（§21 Phase 8 "低风险"定义）：

- [ ] **1. 只修改测试/文档或隔离 fixture 路径**：目标任务的 `ownership_files`
      只覆盖 `tests/**`、`docs/**` 或专用 fixture 目录；不触碰 `src/**`、
      配置、构建脚本。（核对：plan 的 task `ownership:` 字段）
- [ ] **2. 无生产 Secret / 无发布 / 无数据库迁移**：任务不读取不改写任何
      凭据；不触发发布流程；不新增 migration（schema version 与接入前一致）。
- [ ] **3. Ownership 唯一**：同一时刻该文件的 ownership 只属于一个 attempt
      （`GET /v2/tasks/:task_id/delivery` + ownership snapshot 无并行声明；
      服务端 finalize 门禁对越界文件 fail-closed）。
- [ ] **4. V1/V2 回归全绿**：本仓库全量测试通过且计数不劣化；
      目标机器上 `biao-node status` 健康（心跳 last_ok=true、时钟偏差 <30s）。
- [ ] **5. 独立节点验收**：由一个非控制面节点执行并交付（Delivery 的
      attempt.node_id ≠ 控制面模拟），Artifact 三段上传 complete、
      `server_verified=1`。
- [ ] **6. 人工检查 branch diff**：PM 逐文件 review `GET /v2/deliveries/:id`
      的 diff_summary（± 行数与文件清单），确认与任务目标一致后才 accept。

**首次任务只允许手工 Merge Queue**（不启用自动合并；入队后人工 dispatch）。

## 2. 立即停止条件与八条回退步骤（§23.2 映射）

任一 remote fingerprint、diff、verify、Artifact、CAS 或恢复门禁失败 →
**立即停止新 V2 claim、drain 节点、保留 branch/Artifact/Audit 并按下面步骤回退**。

| # | §23.2 条目 | 操作（命令） | 验证 |
|---|---|---|---|
| 1 | 停止新 V2 claim | 关 `BIAO_V2_NODE_RUNTIME`（env 改 0 后重启控制面；反序收口的第 3 步） | `POST /v2/tasks/claim` → 404 `V2_FLAG_DISABLED`（p8-rollback-window ③④ 断言） |
| 2 | drain Nodes | 关旗**前**执行：`POST /v2/nodes/:id/drain`（或节点机 `biao-node drain --config <cfg>`）等待 attempts 收口 → offline | `GET /v2/nodes` 该节点 `status=offline`；节点 exit 0 |
| 3 | 保留已完成 Delivery/Artifact/Audit | 什么都不删：SQLite/Artifact 目录/Git 远端原样保留；关旗不触发任何清理 | 行级比对关旗前后一致；artifact blob 可读（p8-rollback-window ⑦） |
| 4 | 未合并 branch 保留 | 不执行 `POST /v2/branch-cleanups/run`；accepted（非终态）delivery 本就不在清理队列 | `git ls-remote` 分支仍在；BranchCleanup 记录只增不执行（p8-rollback-window ⑧） |
| 5 | V1 可继续处理未迁移 Plan | 关旗即回纯 V1；V1 plan submit→claim→report→review 照常 | `GET /plans` 正常；V1 worker claim 正常（p8-rollback-window ⑤） |
| 6 | 不把 V2 task 强制降级回 `project_path` | 无需操作（无降级代码路径）；确认 `BIAO_V2_PROJECTS` 仍列 V2 项目 → worker token 对其 claim 403 | 隔离门拒绝（p8-rollback-window ⑥） |
| 7 | 恢复后以 Project Binding 重新接管 | 重新按序开五旗重启；节点 re-enroll/register 后按既有 binding 接管 | `node_project_bindings.authorization_status=authorized`；claim 恢复（p8-rollback-window ⑩） |
| 8 | merged 口径不降级 / accepted-not-merged 不给 V1 | 无需操作：V2 project 的依赖完成口径仍是 `merged`；accepted delivery 保留在 V2 队列等待恢复 | 关旗期间 delivery 状态不变；恢复后走 merge queue → merged（p8-rollback-window ⑩） |

**回退记录（必做）**：回退时留存以下清单（§23.2 最后一条）——

```bash
curl -s -H "Authorization: Bearer $BIAO_API_TOKEN" http://<控制面>:7331/v2/feature-flags > rollback-flags.json
sqlite3 <db> "SELECT * FROM schema_migrations;"                 # schema version
sqlite3 <db> "SELECT node_id, protocol_version FROM nodes;"     # Node protocol
sqlite3 <db> "SELECT restore_point_id, status FROM restore_points ORDER BY created_at DESC LIMIT 1;"
sqlite3 <db> "SELECT attempt_id, status FROM task_attempts WHERE status NOT IN ('done','failed','cancelled');"
sqlite3 <db> "SELECT delivery_id, status FROM deliveries WHERE status NOT IN ('merged','rejected','invalidated');"
sqlite3 <db> "SELECT merge_job_id, status FROM merge_jobs WHERE status NOT IN ('merged','cancelled');"
```

### 关旗顺序（反序收口，每次一旗并验证）

```bash
# ① MERGE_QUEUE → ② GIT_DELIVERY → ③ NODE_RUNTIME（= 停止新 claim）→ ④ ARTIFACTS → ⑤ DISTRIBUTED_MODE
BIAO_V2_MERGE_QUEUE=0    # 重启后：/v2/merge-jobs* 404；已 merged 的不动
BIAO_V2_GIT_DELIVERY=0   # 重启后：workspace/delivery/branch-cleanups 404
BIAO_V2_NODE_RUNTIME=0   # 重启后：claim/register/heartbeat 404（新 claim 停止）
BIAO_V2_ARTIFACTS=0
BIAO_DISTRIBUTED_MODE=0  # 纯 V1；GET /v2/feature-flags 仍可读
```

> 快速全关（紧急）也可一次全关——所有 `/v2` 同时 404；按序收口的价值是
> 每一步可验证、问题可定位到面。

## 3. 双物理机接入剧本（Phase 8 步骤 3 / 5-8，待人工）

状态表（PM 汇总口径）：

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 单机 V2 loopback | `tests/distributed/p8-loopback-e2e.test.ts` 全绿 | **已就绪**（自动化） |
| 2 两节点同 OS（两逻辑节点） | `tests/distributed/p8-two-nodes.test.ts` 全绿（两个真实 biao-node 子进程） | **已就绪**（自动化） |
| 3 两节点不同 OS | 需第二台物理机（异 OS） | **待人工**（剧本见 3.1） |
| 4 故障注入 | `tests/distributed/p8-fault-matrix.test.ts` 全绿（§18 抽样四类） | **已就绪**（自动化） |
| 5 真实项目只读 acceptance | 需真实仓库 + 人工确认 | **待人工**（剧本见 3.2） |
| 6 低风险真实任务 branch/push | 满足 §1 六条件 | **待人工**（剧本见 3.3） |
| 7 人工确认 Merge Queue | 首次任务必须人工 | **待人工**（剧本见 3.4） |
| 8 小范围自动 Merge Queue | 步骤 7 通过后放宽 | **待人工**（剧本见 3.5） |
| 9 V1 回退窗口 | `tests/distributed/p8-rollback-window.test.ts` 全绿 | **已就绪**（自动化） |

### 3.1 步骤 3：异 OS 节点接入

1. **目标机安装**（Node.js ≥ 20 + git）：
   ```bash
   git clone <biao 仓库> && cd biao && npm ci && npm run build
   node bin/biao-node.js --help
   ```
2. **控制面准备**：生成一次性 enrollment ticket（`BIAO_V2_ENROLLMENT_TICKET`），
   确认五旗按序已开、`GET /v2/feature-flags` 全绿。
3. **enroll**（凭据不进 argv/Shell 历史，走 ticket 文件）：
   ```bash
   node bin/biao-node.js enroll --url http://<控制面>:7331 \
     --node-id node-<os>-<machine> --ticket-file /run/secrets/biao-ticket \
     --config /etc/biao-node/biao-node.config.json \
     --cache-root /Volumes/BiaoNode/cache
   ```
4. **凭据搬运纪律**：enrollment ticket 是一次性凭据，用后即焚；bvn2 落盘
   `node-credential.json`（0600，仅节点服务账户可读）；不进 git、不进备份明文。
5. **启动与验证**：`node bin/biao-node.js run --config ...`；
   `curl GET /v2/nodes` 看到 `online`；`status.json` 的 `auth_mode=node_credential`、
   `clock.state=ok`。服务化模板见 `templates/node/`（launchd/systemd/Windows）。
6. **异 OS 验收重点**（§19）：路径分隔/大小写（APFS vs ext4/NTFS）、
   `core.autocrlf=false`（服务端 clone 已强制）、行尾与文件锁语义；
   用两个 attempt 分别在两 OS 写同一目录下不同文件，验证互不覆盖
   （同 p8-two-nodes 的 ④ 断言，跨机执行）。

### 3.2 步骤 5：真实项目只读 acceptance

1. 选一个低风险仓库；控制面 `POST /v2/projects`（`repo_path` 指向真实
   remote；`execution_mode=read_only` 起步）。
2. 节点 enroll + `authorize` 绑定该项目（Project Binding）。
3. 节点侧只做 clone/fetch/读操作（不 prepare 写分支）；控制面观察
   `node_project_bindings.health`、心跳、时钟偏差。
4. 验收口径：`GET /v2/projects/:id`（write_capability_status=ready）、
   指标 `biao_nodes{status="online"}`、无 incident。

### 3.3 步骤 6：低风险真实任务（branch/push）

1. 过 §1 六条件清单（全部勾选）。
2. 任务 ownership 只含测试/文档路径；`POST /v2/tasks/claim`（bvn2）→
   workspace prepare → 改动 → artifact 三段 → finalize push。
3. 服务端独立复核通过（`server_verified=1`，diff_summary 与任务目标一致）。
4. 任一门禁失败 → 立即按 §2 回退。

### 3.4 步骤 7：人工确认 Merge Queue 检查单

- [ ] delivery 状态 `pending_review`，`GET /v2/deliveries/:id` 读 diff_summary
- [ ] 逐文件核对 ownership 内（无越界文件进入 commit）
- [ ] branch HEAD 与 marker ref 一致（`git ls-remote` 两条 ref）
- [ ] artifact manifest sha256 与 report 引用一致
- [ ] accept 后人工 dispatch：`POST /v2/merge-jobs`（expected_target_sha=
      当前默认分支 HEAD）→ `POST /v2/projects/:id/merge-jobs/dispatch`
- [ ] merged 后核对默认分支前进恰一次（first-parent +1 commit）

### 3.5 步骤 8：小范围自动 Merge Queue

- 前置：步骤 7 在 ≥3 个任务上人工通过且零回退。
- 放宽方式：PM accept 后自动入队 + 定时 dispatch（当前 dispatch 是显式
  路由，自动化属 Phase 9 scheduler 范围；小范围可先用 cron/CI 调用
  dispatch 路由）。
- 观察期：`biao_merge_jobs{status="integration_failed|conflict"}`、
  `biao_outbox_dead_letter_total`、incident 面板。

## 4. V1 回退窗口保留策略

- **窗口起点**：首个 V2 project 创建时刻；**窗口终点**：全部 project 迁移
  完成、V1 claim 面下线（步骤 10，需 PM 批准）。
- 窗口期内**必须保持**：V1 服务可用（未迁移 plan 可继续跑）；五旗可即时
  关闭（回退）；V2 已完成数据（Delivery/Artifact/Audit）与未合并 branch
  原样保留；`BIAO_V2_PROJECTS` 清单与 V2 project 一致（隔离门有效）。
- **回退演练**：`npx vitest run tests/distributed/p8-rollback-window.test.ts`
  （每次发布前跑一次；它覆盖 §23.2 全部条目的自动化断言）。
- **备份绑定**：回退窗口内每次开旗/关旗变更后创建 restore point
  （`POST /v2/backup/restore-points`），三方 digest 齐全才允许继续灰度。

## 5. 已知缺口（Phase 9 输入）

1. `tasks.project_id` 扩展列的写入路径未接线（plan import 未回填；
   claim-by-project 依赖该列——E2E 以导入器语义直写模拟）。
2. 心跳 stale 不自动 offline/quarantine（节点状态机自动降级属 scheduler）。
3. claim 不校验 node 状态/drain 标记与 NodeProjectBinding（调度前置校验）。
4. daemon 占位 executor 不执行 Git 链路（真实执行接线；E2E 由测试进程
   扮演 executor 驱动 HTTP 面）。
5. merge dispatch 为显式路由（无自动出队定时器）。
6. report 生成的 proposed delivery 与 finalize delivery 的关联收口
   （当前两条记录并存，PM 审以 finalize delivery 为准）。
