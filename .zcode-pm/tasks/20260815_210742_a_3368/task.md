# 新 Agent 一站式加入：注册即自动绑定 + 免前端确认

## 背景

仓库：`/Volumes/CodexMac/CodexData/Documents/Codex/2026-06-05/pm-worker-c-d-a-b/packages/biao`（Biao：本地多 Agent PM 平台，TypeScript ESM + Fastify + Redis + SQLite）。

现状：一个新 harness Agent 要加入项目，需要人工在 Web 控制台添加 project agent binding，再由操作者用 `.biao/supervisor-config worker add` 注册唤醒 slot——过程繁琐且浪费交互。产品决策已定：**带适配器身份的 Worker 注册信息进来时，平台自动创建项目绑定（默认自动接单），不再需要前端确认、添加、绑定**；并且新 Agent 的"注册 + 拿 token + 自动绑定"要能一条脚本命令完成，Agent 拿到内容即可提交和注册。

已有积木（先读再写）：
- `src/server/service.ts`：`agentRegister`（约 :2529，Redis 注册 + SQLite）、`connectProjectAgent`（约 :562，仅限在线 Agent，创建 external_worker+automatic 绑定）、`createProjectAgentBinding`（约 :292）。
- `src/server/http.ts`：`deriveWorkerApiToken`（owner token 单向派生 worker token）、`/register` 路由（约 :988）。
- `src/worker/supervisor.ts` 的 `selectProjectAgentBinding` 与 `probeLocalSupervisorLock`（唤醒匹配已支持无 binding_id 的身份匹配：agent_id+harness_kind+wake_mode，2026-08-15 刚修复并带回归测试 `tests/supervisor-project-agent-binding.test.ts`）。
- `.biao/agent-kit`（scripts/adapter-kit.mjs）已能生成 project-agent 适配器脚手架。
- `.biao/supervisor-config`（scripts/supervisor-config.mjs）能注册唤醒 slot。

## 目标

1. **注册即自动绑定**：扩展 `/register`（service 层 + HTTP schema）——请求带可选的 `project_bindings`（数组：`{project_scope, wake_mode?, policy?}`）或等价字段时，注册成功后自动 `createProjectAgentBinding`（harness_kind 用注册信息，wake_mode 默认 `external_worker`，policy 默认 `automatic`，capabilities 继承注册的 capabilities）。已存在同 (project_scope, agent_id) 绑定时幂等返回现有绑定，不报错。任何绑定创建失败都不能影响注册本身（注册成功、绑定失败单独体现在响应里）。
2. **一站式加入脚本** `scripts/agent-join.mjs`（bin/biao-agent-join.js 包装，package.json 注册 bin）：Agent 运行一条命令完成——(a) 校验 BIAO_URL/BIAO_API_TOKEN 可达（health）；(b) `POST /register`（含 agent_id、capabilities、project_bindings）；(c) 从 owner token 派生 worker token（复用 `deriveWorkerApiToken`，不发明第二套派生）并写入本机 runtime 目录（默认 `$BIAO_RUNTIME_DIR/agents/<agent_id>.env`，0600 权限，绝不打印 token 全文）；(d) 输出下一步最小指引（如何写唤醒脚本、如何被 Supervisor 匹配）。支持 `--dry-run` 只打印将执行的动作。纯 Node 标准库 + 零新依赖。
3. **回归测试**：`tests/agent-join-register.test.ts` —— 覆盖：注册自动建绑定（automatic/external_worker 默认值）、幂等重注册、绑定失败不影响注册、脚本 `--dry-run` 不产生副作用、生成的 env 文件权限 0600。参考 `tests/project-agent-auto-connect.test.ts` 的 service 层测试风格与 `tests/worker-agent.test.ts` 的真实 spawn 脚本测试风格。
4. **文档**：新增 `docs/agent-join.md`（中文，一条命令加入的完整流程 + 安全边界：worker token 与 owner token 的派生关系、轮换即失效）；`docs/worker-integration.md` **不要改**（另一条并行任务线拥有该文件）。

## 约束

- 全程中文注释与中文文档；机器状态值（accept 等）保留原文。
- **不得修改**：`src/mcp/**`（另一并行流所有）、`src/worker/supervisor.ts`、`scripts/worker-agent.mjs`、`scripts/supervisor.mjs`、`docs/mcp.md`、`docs/worker-integration.md`、`tests/supervisor-*.test.ts`、`tests/mcp-*`。
- 不启动/重启 `.biao/start` 栈，不改 `.biao/config.env`（PM 负责生产栈）。
- 不引入新 npm 依赖。
- 保持与现有代码风格一致（service 层函数式、ApiResponse 信封）。

## 验收标准

1. `npm run build:server` 通过（tsc 零错误）。
2. `npx vitest run tests/agent-join-register.test.ts tests/project-agent-auto-connect.test.ts` 全绿。
3. `node scripts/agent-join.mjs --help` 输出中文帮助；`--dry-run` 在无服务时也能打印计划动作。
4. 注册带 project_bindings 后，`GET /project/agent-bindings?project_scope=` 能看到 automatic 绑定且 wake_mode=external_worker。
5. 文件清单：service.ts 扩展、http.ts schema 扩展、scripts/agent-join.mjs、bin/biao-agent-join.js、package.json bin、tests/agent-join-register.test.ts、docs/agent-join.md。逐文件列出你改了什么。
