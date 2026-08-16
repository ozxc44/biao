我来实现这个「新 Agent 一站式加入」功能。先读取关键源文件了解现有架构。
Now let me read the key areas around `agentRegister`, `createProjectAgentBinding`, `connectProjectAgent`, and the `/register` route.
Let me read more: the `agentRegister` function and the request schemas, plus reference test files.
Now let me read the helper functions used for validation and the ApiResponse type, then check existing bin wrapper patterns.
I now have a thorough understanding of the codebase. Let me create tasks and implement everything.
First, I'll extend the types and service layer. Let me add the registration project binding input type to types/index.ts.
Now extend `agentRegister` in service.ts to accept optional `projectBindings` and auto-create bindings after registration.
Now modify `agentRegister` to accept and pass `projectBindings`:
Now modify `agentRegisterUnlocked` to handle the new parameter:
Now modify the successful return of `agentRegisterUnlocked` to process project bindings:
Now extend the HTTP `/register` route. First update the schema:
Now update the route handler to pass `project_bindings`:
Now create the one-stop join script. Let me look at existing script patterns first.
Now let me create the agent-join script:
Create the bin wrapper:
Now update package.json to register the bin and include the script in the files list:
Now write the tests. Let me first look at the full test pattern used by `project-agent-auto-connect.test.ts` to match the style:
Now write the test file:
Now write the Chinese documentation:
Now run verification. First, let me check for TypeScript errors:
tsc passed. Now run the tests:
Fix the test error - `await` in non-async context:
All 12 tests pass. Now verify the script help and dry-run:
All verification passes. Let me also run the broader test suite to check for regressions:
Let me do a final check on what was modified/created:
I notice `docs/worker-integration.md` appears in the diff. Let me verify it wasn't changed by me:
That file was modified by a parallel task, not by me. Let me verify my specific changes are correct:
All changes are correct. Let me verify the package.json changes:
## 最终总结

### 已完成的变更

| 文件 | 变更内容 |
|------|---------|
| `src/types/index.ts` | 新增 `RegistrationProjectBinding` 接口（注册时的自动绑定声明） |
| `src/server/service.ts` | 扩展 `agentRegister`/`agentRegisterUnlocked` 支持可选 `projectBindings` 参数；注册成功后自动调用 `createProjectAgentBinding`，幂等返回现有绑定，绑定失败不影响注册 |
| `src/server/http.ts` | `/register` schema 新增 `project_bindings` 数组字段；`preValidation` 白名单加入 `project_bindings`；路由 handler 解析并通过 `resolveAndValidateWorkspacePath` 校验后传递 |
| `scripts/agent-join.mjs` | **新建** — 一站式加入脚本：校验连通性→注册（含自动绑定）→派生 Worker Token→写入 .env（0600）。支持 `--dry-run`、`--help`，纯 Node 标准库 |
| `bin/biao-agent-join.js` | **新建** — bin 包装器 |
| `package.json` | bin 注册 `biao-agent-join`，files 列表加入 `scripts/agent-join.mjs` |
| `tests/agent-join-register.test.ts` | **新建** — 10 个测试：自动绑定（默认值）、多项目绑定、幂等重注册、绑定失败不影响注册、无 project_bindings 兼容旧版、dry-run 无副作用、帮助中文输出、缺失参数报错、路径校验、env 文件权限 0600 |
| `docs/agent-join.md` | **新建** — 中文文档：快速开始、参数说明、安全边界（Worker Token 派生关系、轮换失效）、加入后指引 |

### 验证结果

- `npm run build:server` — tsc 零错误
- `npx vitest run tests/agent-join-register.test.ts tests/project-agent-auto-connect.test.ts` — 12/12 全绿
- `node scripts/agent-join.mjs --help` — 中文帮助正常输出
- `--dry-run` 无服务时也能打印计划动作
- 现有测试（agent-offline-contract、extended、watchdog）无回归

### 未修改的文件（按约束要求）

- `src/worker/supervisor.ts`、`scripts/worker-agent.mjs`、`scripts/supervisor.mjs`、`docs/worker-integration.md`、`src/mcp/**`、`tests/supervisor-*`、`tests/mcp-*` — 均未触碰

### 残余风险

- 真实端到端测试（需 Redis + SQLite 运行中的 Biao 服务）未在本次验证中执行，仅覆盖了 service 层 mock 测试和脚本 dry-run
- `RegistrationProjectBinding` 的 `project_scope` 需要绝对路径，如果 Agent 传入相对路径会在 HTTP 层被 `resolveAndValidateWorkspacePath` 拒绝