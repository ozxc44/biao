# Phase 3：biao-node Skeleton（与 Phase 2 并行，文件所有权互斥）

## 前置状态

Phase 1 已验收：Node 凭据（bvn2）/ Attempt token（bva2）`src/server/v2/credentials.ts`；V2 节点路由已实现（enroll/register/heartbeat/drain/offline/revoke/authorize——`src/server/v2/routes/` + `node-service.ts`）；generation fencing 生效。全量基线 **110 文件 / 1226 用例全绿**。0b fixture：`tests/distributed/fixtures/node-simulator.ts`、`fault-injector.ts`。

先读：方案 §10（Node Runtime：10.1 一节点一守护 / 10.2 安装启动 / 10.3 心跳内容 / 10.4 Lease 丢失 / 10.5 Drain 与升级）、§10 的 launchd/systemd/Windows service 要求、§19（跨平台边界：路径/工具环境）、§21 Phase 3 验收原文、R1C-004（Windows 具体产物）。

## 目标

1. **Node daemon 骨架** `src/node/daemon.ts`（新目录）：
   - 生命周期：载入 Node 配置（`biao-node.config.json`：biao_url、credential 文件路径、slots、本地缓存根）→ register（新 session generation）→ 心跳循环（§10.3 字段：capacity/running attempt ids/时钟偏差）→ SIGTERM 优雅 drain；
   - **统一 lease watchdog**（R1B-006）：attempt lease 到期前主动续租，检测 lease 丢失（generation 变化/409）即停当前工作并上报，不靠日志式续租；
   - slots：配置声明的执行槽（本阶段为占位 executor：收到 task attempt 只记录不真执行——真执行在 Phase 4 Git workspace）；
   - 掉线恢复：进程重启后 register 新 generation，旧 session 被 fencing（Phase 1 已保证，daemon 侧断言并处理 409）。
2. **CLI 入口** `src/node/cli.ts`（enroll 向导：拿 enrollment_ticket→调 enroll→把 Node credential 写 0600 文件→生成初始 config；run/status/drain 子命令）+ `bin/biao-node.js` + package.json bin。
3. **服务模板**（`templates/node/`）：`biao-node.launchd.plist`（macOS）、`biao-node.service`（systemd）、`biao-node-service.ps1` + `install-windows.ps1`（Windows Service + Credential Manager 存取 credential + Event Log 日志源注册——R1C-004 最小产物）。模板含中文注释与占位符替换说明。
4. **协议兼容矩阵测试**：daemon 与 server 版本握手字段（protocol_version），不匹配时 fail-closed 拒绝注册并给出明确错误。
5. **失败优先测试** `tests/distributed/p3-node-daemon.test.ts`（真实 HTTP 隔离端口 server + 真实子进程 daemon）：
   - §21 Phase 3 验收原文：**节点重启/掉线/drain 不产生重复 claim**（重启后旧 session fencing、无第二个 claim 赢家）；旧 session 被 fencing；
   - lease watchdog：手工使 lease 过期 → daemon 停止工作上报；时钟偏差注入（fault-injector）→ 心跳携带 skew 被服务端记录；
   - 模板静态校验：launchd/systemd/PS1 占位符与 install 脚本一致性（解析模板断言必需键存在）。
6. `docs/runbooks/biao-node.md`（中文）：安装、enroll、凭据文件权限、三平台服务化步骤、drain/升级流程。

## 约束

- 全程中文；**所有权**：`src/node/**`、`bin/biao-node.js`、`templates/node/**`、`package.json`（bin 行）、`docs/runbooks/biao-node.md`、`tests/distributed/p3-*.test.ts`。**不得改**：`src/db/**`、`src/types/**`、`src/server/**`（只 import v2 接口；发现缺口列清单不回改）、`src/mcp/**`、`web/`、既有 fixture、`scripts/`。
- Windows 相关只交付模板/脚本产物与静态校验，不在 macOS 上要求真实运行 Windows Service。
- 不新增 npm 依赖；不新增 `*_TEST_REDIS_URL`（复用 6380）；不启动生产栈。
- 门禁：构建 + 全量不劣化 110/1226 基线。

## 验收标准

1. 构建 + `npx vitest run tests/distributed/` 全绿（与 Phase 2 车道合流后全量复跑）。
2. §21 Phase 3 验收原文逐项：重启/掉线/drain 零重复 claim；旧 session fencing。
3. 交付说明：daemon 状态机图（文字）、lease watchdog 参数、三平台模板清单、协议版本矩阵、对 server 侧接口缺口清单。
