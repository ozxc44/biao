# Biao

[![CI](https://github.com/ozxc44/biao/actions/workflows/ci.yml/badge.svg)](https://github.com/ozxc44/biao/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node.js-20.19%2B%20%7C%2022.12--26.x-green)

[English](README.en.md) | [简体中文](README.md)

> Note: the English README is a condensed translation and may lag behind the [Chinese original](README.md), which is the authoritative document.

> **Bring your own harness. Squad up. / 带上你的原配（harness），一起开团。**

Every coding Agent arrives with its own harness. Codex, Claude Code, ZCode, Kimi, and internal tools each have their own CLI, runtime, context, and way of working—but they do not know one another. Put several of them on the same repository and a human still has to babysit the queue, prevent overlapping edits, relay questions, rerun tests, and decide whether “done” is actually done.

Biao is not another Agent harness. It is the **collaboration layer above the harnesses you already use**. It replaces none of them. Biao gives them a shared plan, file ownership, leases, durable questions, verification evidence, independent acceptance, and a PM review gate.

```text
   Codex · Claude Code · ZCode · Kimi · any CLI or HTTP Agent
       └── keep every harness you already trust; Biao replaces none ──┘
                                  ↓
       ┌────────────────────────────────────────────────────┐
       │ Biao: Plan → Claim → Ownership → Lease → Verify    │
       │       → Independent Acceptance → PM Review         │
       └────────────────────────────────────────────────────┘
                                  ↓
          Real project changes · Reviewable evidence · Audit trail
```

## Why Biao exists

The hard part of multi-Agent development is rarely producing output. It is knowing:

- which Agent owns which task;
- whether two Agents are about to modify the same file;
- whether the declared tests really ran after a Worker reported completion;
- whether the implementer is approving its own work;
- whether tasks and evidence survive a Worker or service interruption;
- whether a green dashboard card means the product is genuinely deliverable.

Biao turns that uncertainty into one explicit lifecycle:

```text
Plan → Worker claim → Lease and ownership → Work → Verify
     → Independent acceptance → PM Review → Project complete
```

Only a task with an `accepted` PM Review counts as complete. A heartbeat, a zero process exit code, generated files, or a Worker `done` report is delivery—not acceptance.

## Product highlights

The problem Biao solves first: **how multiple Agents with different harnesses safely co-develop one real project.** Each harness is already the best executor for its own model; what is missing is the collaboration layer between them—who owns what, who accepts what, and who closes failures. Biao does not compete with any harness; it is that layer.

### Bring Your Own Harness (core)

Biao is vendor- and model-neutral. It includes Codex and Kimi Workers, a generic CLI Worker, and an HTTP lifecycle for any language or platform. Claude Code, ZCode, an internal executor, or a remote service can all join the same plan. Codex can implement, Claude Code can accept, Kimi can run regression work, and an internal Agent can research—the PM itself can be any harness. Biao schedules, constrains, and verifies them. It does not become them.

Single-harness multi-Agent setups can only orchestrate one vendor's Agents. Biao lets you pick the best model per task, then keeps implementer, acceptor, and PM in naturally different harnesses so they check one another.

### File ownership and concurrency safety

Tasks declare writable file globs. Claiming a task acquires that ownership, and a Worker checks every actual path again before writing. Conflicting Agents receive an explicit `wait` or conflict record instead of silently overwriting one another. This is the precondition for heterogeneous Agents to truly run in parallel.

### Verifiable completion

- Every declared Verify command runs in order and reports its command, exit code, pass/fail result, and useful output. One failure prevents a successful report.
- An `acceptance` task cannot be claimed by an Agent that implemented the work under review—in a heterogeneous squad this means a different harness does the falsifying.
- Only PM Review `accepted`, or an accepted repair with `resolution_status=resolved`, contributes to plan completion.

A single coding Agent can say it is finished. Biao adds the independent layer that can prove it wrong.

### Autonomous, auditable failure closure

Worker failures, Verify failures, and PM rejections do not fall into a bucket that somebody must watch manually. Biao preserves the original failure or rejection and schedules a bounded repair with inherited ownership and Verify requirements. A repair still needs a fresh delivery and PM Review. A failed independent acceptance repairs the original implementation instead of depending on the failed acceptance, avoiding a dependency deadlock. Retry exhaustion ends at `needs_pm_decision`; it never loops forever.

### Redis + SQLite recovery

Redis runs the live coordination path: leases, ownership, queues, and current projections. SQLite keeps task, result, and review metadata as a disaster-recovery projection and audit store. If the Biao Redis namespace is lost, eligible state can be reconstructed without pretending that old leases or claims remain valid.

### Passive hub and durable Questions

Biao does not run a permanent Reviewer, push task contents to external systems, or auto-accept work. State transitions write small, durable, replayable PM bell events. The PM polls those events and fetches detail only when needed.

When a Worker needs a product decision, it creates a durable Question instead of asking the human watching its terminal. Biao atomically releases the old lease and ownership, moves the task to a waiting state, and resumes it only through a fresh claim after the PM answers.

### Local-first and private by default

Biao runs with Node.js, Redis, and SQLite. Bootstrap detects dependencies, installs them only with explicit permission, creates owner-only configuration, and generates a random API token without placing it in command arguments or the repository.

**In one sentence:** a harness helps one Agent write code; Biao helps Agents with different harnesses safely finish one project together.

## Requirements

- Node.js 20.19+, or 22.12 through 26.x (the declared compatibility range of the native SQLite driver)
- Redis
- Built-in Workers: authenticated `codex` for Codex; authenticated `kimi` for Kimi
- Other Agents, including Claude Code, ZCode, and internal CLIs: connect through the generic CLI Worker or HTTP API

`bootstrap.sh` detects Node.js, npm, the Redis command, and Redis connectivity before changing anything. Without `--yes`, missing dependencies stop bootstrap with exit code `2`. With `--yes`, bootstrap may install them through Homebrew on macOS or apt, dnf, or yum on Linux. It only attempts to start a local Redis service; a remote `--redis-url` is connectivity-checked and is never installed or started remotely. If a Linux package source installs an unsupported Node version, or Redis remains unreachable, bootstrap fails closed and explains what to correct.

## First-run bootstrap

Biao supports a **source layout** from Git and a **prebuilt layout** installed from a trusted npm tarball. Do not mix them or unpack a tarball in place of `npm install`.

### Source clone

The source is open under [Apache-2.0](LICENSE); clone it directly. For mirrored distribution inside a private network, configure Git credentials with access to that mirror first.

```bash
git clone https://github.com/ozxc44/biao.git
cd biao

./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex
```

One run detects and installs authorized dependencies, builds server and console, generates an API token, writes mode-`600` `.biao/config.env`, configures workspace/project/Redis/SQLite, and generates service, token, PM, Supervisor, Codex, Kimi, and custom Worker launchers plus `.biao/PM_AGENT.md`.

### Installed npm tarball

```bash
mkdir -p /path/to/biao-runtime
cd /path/to/biao-runtime
npm init -y
npm install /absolute/path/to/vtp-biao-0.1.0.tgz

./node_modules/.bin/biao-bootstrap --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --pm-agent codex

./.biao/doctor
./.biao/start
```

`node_modules/@vtp/biao` contains replaceable read-only code and web assets. The consumer directory's `.biao/` contains configuration, token material, SQLite data, and launchers. Use `--runtime-dir /absolute/biao-state` for another state location; prebuilt bootstrap rejects state inside the package root or any `node_modules` directory.

Upgrade in the same consumer directory so state is preserved:

```bash
npm install /absolute/path/to/vtp-biao-new.tgz
./node_modules/.bin/biao-bootstrap \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --upgrade
```

Bootstrap fails closed if a required runtime entry, schema, or web asset is missing.

### Start and authenticate

```bash
.biao/doctor
.biao/start
```

Open the address printed by the server directly in a browser. On the first visit, choose **Enter console**. On a loopback (`127.0.0.1` / `localhost`) deployment, Biao creates a 30-day HttpOnly local Owner session for that browser; refreshes and new tabs reuse it, and the upper-right menu can sign out that browser. The browser never receives, stores, or displays `BIAO_API_TOKEN`; rotating that Token invalidates all local Owner sessions.

`BIAO_API_TOKEN` is a Bearer credential for CLI, Workers, and controlled API clients. Generated Worker/PM/Supervisor launchers read it from owner-only `.biao/config.env`; it does not belong in the browser. `.biao/token-status` shows only a fingerprint suffix. `.biao/copy-token` remains for controlled CLI diagnostics, not console sign-in.

The console defaults to Chinese in every new tab; switch to English in the upper-right. Language state survives refresh in that tab only.

`doctor` checks Node, npm, whether the native SQLite driver really loads under the current Node runtime, Redis, workspace roots, and optional Codex/Kimi executables. Codex becomes required when configured with `--pm-agent codex`. If install and launch used different Node versions, or npm blocked the `better-sqlite3` install script, doctor fails with a `npm rebuild better-sqlite3` repair command; when npm reports `allow-scripts`, approve `better-sqlite3` first. A successful doctor run proves runtime readiness, not project acceptance.

### PM and shared Supervisor

An interactive PM reads `.biao/PM_AGENT.md`, then starts with:

```bash
.biao/pm-start --once
```

This checks health, status, and minimal intake and runs one shared Supervisor pass. It discovers legacy `done + review pending` tasks and pending work without an online Worker. It never auto-acks or auto-accepts. For low-frequency monitoring:

```bash
.biao/pm-start --consumer pm --interval 60
```

Add Worker slots without hand-editing JSON; the production entry combines PM bells and Worker slots in one process:

```bash
.biao/supervisor-config worker add --id codex-a --kind codex \
  --project /path/to/workspace/my-project --types code,docs
.biao/supervisor-config worker add --id kimi-a --kind kimi \
  --project /path/to/workspace/my-project --types review,acceptance
.biao/start
```

No separate online Worker daemon is required. The Supervisor claims new pending/repair/reverify work for a matching slot and starts the Codex, Kimi, or unfamiliar-Agent harness only after a real claim. It immediately checks for the next item when one finishes. Idle slots share one low-frequency cycle instead of running separate claim timers. The owner-only config command never prints credentials; safely restart only the Supervisor to load a changed slot list. The Supervisor stops when all managed plans are terminal. Under the normal state machine, terminal plans have no actionable intake; a later reset, repair, or new task is discovered on the next start, or immediately when `BIAO_SUPERVISOR_STAY_RESIDENT=1` keeps the process resident.

An unfamiliar Agent does not need to reverse-engineer the API. Give it the credential-free
`.biao/agent-kit` launcher (or the packaged `biao-adapter-kit` command) and let it follow
`contract → scaffold → check` to build a single-file Worker or PM adapter. The local Supervisor
then owns the Worker slot or per-Plan PM route. See the
[unfamiliar Agent adapter kit](docs/agent-adapter-kit.md).

Single-Worker compatibility launchers remain available and exit on idle by default:

```bash
.biao/worker-codex
.biao/worker-kimi
.biao/worker-custom
```

With `--pm-agent codex`, the Supervisor wakes the built-in Codex PM adapter only for a minimal bell. Another PM Agent can be configured explicitly:

```bash
# Never place a Biao token in this command.
BIAO_PM_AGENT_CMD='your-pm-agent-command' .biao/supervisor
```

The command receives only service address, consumer, optional plan scope, item kinds, and counts over stdin. It fetches details itself and explicitly acks only after the real action succeeds. Biao never passes the token, task body, Question body, or ownership details to the subprocess, and never installs cron or launchd automatically.

The root `AGENTS.md` is the stable clone entry. It directs an unconfigured Agent to bootstrap and a PM Agent to read `.biao/PM_AGENT.md`. An Agent can then act as a Worker, an interactive PM, or an on-demand PM Agent without relying on machine-global configuration.

### Operating modes

- **Worker:** use one or more slots in `.biao/supervisor`; the single-Worker `.biao/worker-codex`, `.biao/worker-kimi`, and `.biao/worker-custom` launchers remain available for compatibility.
- **Interactive PM:** read `.biao/PM_AGENT.md`, run `.biao/pm-start --once`, inspect scoped detail, take the real review/Question/recovery action, then ack only the handled bell.
- **On-demand PM Agent:** bootstrap with `--pm-agent codex`, or explicitly configure `BIAO_PM_AGENT_CMD`; the shared Supervisor invokes it only when minimal intake exists.
- **Stuck PM recovery:** a PM adapter that does not exit is terminated as a process group after 10 minutes by default, its consumer lock is released, and the unacked bell is retried on a later Supervisor pass. Configure `BIAO_PM_AGENT_TIMEOUT_MS` between 100ms and one hour when needed.

Multiple PMs can be registered as slots. Each slot owns one unique consumer, and managed Plans must declare the same `pm_consumer`; this routes review, Question, and abnormal-decision work into that PM's queue:

```bash
.biao/supervisor-config pm add --id pm-codex-main --consumer pm \
  --command /absolute/runtime/.biao/codex-pm-agent \
  --target <your-codex-thread-id>
.biao/supervisor-config pm add --id pm-kimi --consumer pm-kimi \
  --command /absolute/path/kimi-pm-adapter --target kimi-session-id
.biao/supervisor-config pm list
```

One shared Supervisor reads plans/events/reconcile once per cycle and only the minimal queue for each configured consumer. Different PM slots may wake concurrently; one slot is never launched twice while still running. Nonzero adapter exits or undrained work remain queued for retry. Restart only the Supervisor at a safe boundary to load changed slots.

The shared Supervisor accepts `--once` for one bounded pass, `--interval 60` for low-frequency resident operation, and `--plans plan-a,plan-b` to restrict managed plans. Pass `--stay-resident` (or set `BIAO_SUPERVISOR_STAY_RESIDENT=1`) to keep the process alive after every managed plan closes: it re-checks at the same shared interval, and newly active plans revive worker slots under a fresh registration epoch, closing the gap between a drained exit and the next launcher restart. Its PM Agent adapter uses `--require-drained` after the subprocess exits: it fetches minimal intake again and treats the wake as incomplete when actionable items remain, clearing local deduplication so a later shared cycle can retry. It never turns process exit into review, answer, or ack.

### Useful bootstrap options

```bash
./bootstrap.sh --yes --workspace /path --pm-agent codex
./bootstrap.sh --yes --workspace /path --pm-agent-command 'your-pm-agent-command'

./bootstrap.sh --yes \
  --workspace /path/to/workspace \
  --project /path/to/workspace/my-project \
  --redis-url redis://127.0.0.1:6379 \
  --port 7331

chmod 600 /secure/path/biao-token
./bootstrap.sh --yes --workspace /path --token-file /secure/path/biao-token

# Skip npm install only; system Node/Redis checks and --yes authorization still apply.
./bootstrap.sh --yes --workspace /path --no-install --force
./bootstrap.sh --workspace /path --no-install --no-build --upgrade
./node_modules/.bin/biao-bootstrap --workspace /path --runtime-dir /absolute/biao-state
```

Bootstrap refuses to overwrite `.biao/config.env` by default. Prefer a generated token. If a secret manager supplies one, use `--token-file` or its injection of `BIAO_BOOTSTRAP_TOKEN`, not an inline shell assignment. Token files must be regular, non-symlink, owner-only files.

For a strict read-only check of Node, npm, Redis tools, and Redis connectivity, run:

```bash
./bootstrap.sh --check --redis-url redis://127.0.0.1:6379
```

Success exits `0`; missing dependencies or unavailable Redis exits `2`. It never installs dependencies, starts a service, runs npm, builds, or writes `.biao`—even if `--yes` is accidentally supplied. Without `--check`, omitting `--yes` only disables installation of missing system dependencies and local Redis startup; when dependencies are already ready, normal bootstrap still builds and writes configuration.

## Quick start from source

```bash
npm install
npm run build

BIAO_WORKSPACE_ROOTS="/path/to/workspace" \
BIAO_SQLITE_PATH="/path/to/biao-data/biao.sqlite" \
npm start
```

Biao listens on `http://127.0.0.1:7331` by default.

```bash
node bin/biao.js health
node bin/biao.js status
node bin/biao.js db status

node bin/biao.js plan init my-feature \
  --project /path/to/workspace/my-project \
  --dir /path/to/workspace/plans

node bin/biao.js plan submit /path/to/workspace/plans/my-feature
node bin/biao.js plan status my-feature
```

Start a Worker:

```bash
BIAO_URL="http://127.0.0.1:7331" \
BIAO_AGENT_ID="codex-a" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/codex-worker.js
```

Review delivery evidence:

```bash
node bin/biao.js review list
node bin/biao.js review my-feature-01-impl
node bin/biao.js review my-feature-01-impl --accept --comment "Evidence passed"
```

Reject and create a repair:

```bash
node bin/biao.js review my-feature-01-impl \
  --reject \
  --reason "Boundary-case test fails" \
  --fix-instructions "Add the empty-input case and correct the result"
```

If source code is already accepted/resolved and only acceptance evidence is defective, reject the acceptance with `--reverify-only`. This creates a fresh independent `<acceptance>-reverify-N`, preserves the original rejection, and requires a new report and PM acceptance. To grant the new repair the smallest explicit adjacent scope, use:

```bash
node bin/biao.js review my-feature-01-impl \
  --reject \
  --reason "The binding fix requires the adjacent MCP route" \
  --fix-instructions "Fix validation and run API regression" \
  --repair-ownership '{"files":["apps/api/src/mcp/mailbox-v2.ts"],"modules":["mailbox-v2"]}'
```

The source ownership and audit remain unchanged; only the repair receives the audited union.

## Writing plans

`index.md` declares the project and phases:

```yaml
---
plan_id: my-feature
title: Improve sign-in
status: draft
project_path: /path/to/workspace/my-project
default_assignee: auto
default_priority: 5
phases:
  - id: impl
    name: Implementation
  - id: qa
    name: Acceptance
    depends_on: [impl]
global_constraints:
  - Do not modify .env or credential files
---
```

A normal task declares ownership and Verify:

```yaml
---
task_id: my-feature-01-api
title: Implement sign-in endpoint
type: code
phase: impl
assignee: auto
ownership:
  files: [src/server/auth/**]
priority: 8
timeout_seconds: 1800
max_retries: 2
verify:
  - cmd: npm test -- auth
    expect_exit: 0
    scope: .
    timeout: 300
---
```

An independent acceptance names its sources:

```yaml
---
task_id: my-feature-02-qa
title: Independently accept sign-in
type: acceptance
phase: qa
depends_on: [my-feature-01-api]
acceptance_for: [my-feature-01-api]
assignee: auto
verify:
  - cmd: npm test -- auth
    expect_exit: 0
---
```

It must be claimed by an Agent that did not execute the source and must report at least one passing Verify plus an explicit conclusion. The CLI fails closed before writing an acceptance task without Verify:

```bash
.biao/pm task add --plan my-feature --task-id my-feature-02-qa \
  --title "Independent sign-in acceptance" --type acceptance --phase qa \
  --depends-on my-feature-01-api --acceptance-for my-feature-01-api \
  --verify-cmd "npm test -- auth" --verify-cmd "npm run typecheck"
```

See [Planning CLI](docs/planning-cli.md).

## Connecting Agents

Biao offers four Agent connection paths. See the full [Worker integration contract](docs/worker-integration.md). A clone uses repository-local `node bin/...` or generated `.biao/...` commands; it does not assume a global `biao` install.

For production, prefer `.biao/worker-codex`, `.biao/worker-kimi`, `.biao/worker-custom`, or one shared `.biao/supervisor`. The raw `node bin/...` examples below load service configuration and the token from owner-only `.biao/config.env`; they do not place the token in command arguments or shell history.

### Built-in Codex

```bash
set -a
. .biao/config.env
set +a

BIAO_AGENT_ID="codex-backend-1" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/codex-worker.js
```

It handles registration, heartbeat, claim, ownership, lease renewal, `codex exec`, Verify, progress and result artifacts, and reporting.

### Built-in Kimi

```bash
set -a
. .biao/config.env
set +a

BIAO_AGENT_ID="kimi-frontend-1" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
BIAO_KIMI_MODEL="kimi-code/k3" \
node bin/kimi-worker.js
```

### Any command-line Agent

The generic Worker appends three arguments to `BIAO_EXEC_CMD`:

```text
<task_id> <goal_md_path> <work_dir>
```

```bash
#!/usr/bin/env bash
set -euo pipefail
task_id="$1"
goal_md="$2"
work_dir="$3"

# Claude Code, ZCode, or any internal harness can go here.
my-agent --project "$PWD" --prompt-file "$goal_md"
```

```bash
chmod +x /path/to/my-biao-agent

set -a
. .biao/config.env
set +a

BIAO_AGENT_ID="custom-agent-1" \
BIAO_EXEC_CMD="/path/to/my-biao-agent" \
BIAO_PREFERRED_PROJECT="/path/to/workspace/my-project" \
node bin/biao-worker.js
```

The generic Worker owns scheduling and Verify; the command performs the task and returns its execution status. When `BIAO_EXEC_CMD` or a custom slot `command` names an existing absolute executable, Biao launches that full path as one command, including paths with spaces. Put complex fixed arguments in a single-file wrapper; compatibility command strings that are not existing absolute files still use simple space splitting.

### HTTP Worker lifecycle

Responses use `{"ok":true,"data":{}}`; failures add `error.code` and `error.message`. With authentication enabled, Workers, the CLI, and controlled API clients send Bearer authorization and JSON content type. The local loopback console instead uses its HttpOnly local Owner session and never receives the Bearer token.

#### 1. Register a process generation

Generate a high-entropy `registration_id` once per Worker process. Reuse it only to retry the same registration request.

Both `registration_id` and `claim_request_id` must be 16–128 characters: the first character is alphanumeric, and the rest may contain only letters, digits, `_`, and `-`. The examples use a `reg_` or `claim_` prefix plus 32 random hexadecimal characters.

```bash
curl -X POST http://127.0.0.1:7331/register \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id":"remote-agent-1",
    "agent_type":"custom",
    "capabilities":["code","review","acceptance"],
    "registration_id":"reg_0123456789abcdef0123456789abcdef"
  }'
```

Save `data.registration_id`. Heartbeat, claim, and offline must reuse it. A new process registration fences the old process so stale lifecycle requests cannot overwrite the current Agent session.

#### 2. Heartbeat

```bash
curl -X POST http://127.0.0.1:7331/heartbeat \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"remote-agent-1","registration_id":"<registration_id>","current_task":""}'
```

Use empty `current_task` while idle and the task ID while running.

#### 3. Claim with transport idempotency

Every logical claim call needs a new high-entropy `claim_request_id`. Reuse that ID only when retrying the same request after transport loss; use a new ID for a new attempt. Biao can then replay the same task and token if assignment succeeded but the response was lost.

```bash
curl -X POST http://127.0.0.1:7331/claim \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id":"remote-agent-1",
    "registration_id":"<registration_id>",
    "claim_request_id":"claim_0123456789abcdef0123456789abcdef",
    "blocking":false,
    "preferred_types":["code"],
    "preferred_project":"/path/to/workspace/my-project"
  }'
```

Save `task_id`, `goal_md`, `project_path`, `ownership_files`, `verify`, `claim_token`, and `timeout_seconds`. Claim acquires declared ownership during the lease. Before every write, call `GET /ownership?path=...&agent_id=...` and write only for `action=proceed`. On `wait`, block/release the claim; do not write or ask a human chat. `force: true` ownership declaration is explicit preemption, not a normal claim step.

#### 4. Renew

Renew around every `timeout_seconds / 3`:

```bash
curl -X POST http://127.0.0.1:7331/lease/renew \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task_id":"my-feature-01-api","claim_token":"<claim_token>"}'
```

#### 5. Execute, verify, and report

Work in `project_path`, modify only `ownership_files`, never edit submitted plan files, and run Verify in order. Keep controlled `work/<task_id>/result.md` and `result.json` artifacts.

```bash
curl -X POST http://127.0.0.1:7331/report \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "task_id":"my-feature-01-api",
    "agent_id":"remote-agent-1",
    "claim_token":"<claim_token>",
    "status":"done",
    "result_path":"/path/to/workspace/my-project/work/my-feature-01-api/result.md",
    "result_json_path":"/path/to/workspace/my-project/work/my-feature-01-api/result.json",
    "verify_results":[
      {"cmd":"npm test -- auth","exit_code":0,"passed":true,"output":"tests passed"}
    ]
  }'
```

Every Verify result must appear in declared order. Report `failed` when one fails; the server rejects false `done`. Result files must be regular, non-symlink files in this task's own directory. `.progress.json` is operational progress managed atomically by built-in Workers; it is not PM acceptance and stores no claim token or credential.

#### 6. Go offline

```bash
curl -X POST http://127.0.0.1:7331/agent/offline \
  -H "Authorization: Bearer $BIAO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"remote-agent-1","registration_id":"<registration_id>","reason":"worker_exit"}'
```

Offline is idempotent and preserves audit. Heartbeat timeout/watchdog is only the crash fallback. Built-in Workers and the Supervisor go offline automatically.

## Worker environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIAO_URL` | `http://localhost:7331` | Service URL |
| `BIAO_API_TOKEN` | empty | Bearer token |
| `BIAO_AGENT_ID` | Worker-specific | Unique process identity |
| `BIAO_PREFERRED_PROJECT` | empty | Restrict claims to one project |
| `BIAO_MAX_TASKS` | `0` | Maximum tasks; `0` keeps a raw Worker resident |
| `BIAO_EXIT_ON_IDLE` | raw Worker off; launcher `1` | Exit on empty queue |
| `BIAO_IDLE_POLL_MS` | `5000` | Legacy resident idle polling only |
| `BIAO_HEARTBEAT_MS` | `30000` | Active task heartbeat |
| `BIAO_EXEC_CMD` | none | Generic CLI executor |
| `BIAO_MODEL` | `human` | Generic result model name |
| `BIAO_KIMI_BIN` | `kimi` | Kimi executable |
| `BIAO_KIMI_MODEL` | `kimi-code/k3` | Kimi model |

## Worker-to-PM communication

A Worker needing a product decision, scope confirmation, or continuation condition must use a durable Question—not the current human chat and not a silently held task.

Built-in Workers recognize:

```text
BIAO_QUESTION: {"body":"Confirm the release scope","checkpoint":"Tests pass; waiting for a decision"}
```

The runtime validates it, atomically creates the Question, releases lease and ownership, and moves the task to waiting. After the PM answers, the answer and checkpoint arrive only through a fresh claim and token.

```bash
.biao/pm question ask --task <task_id> --claim-token <claim_token> \
  --agent-id <current_worker_agent_id> \
  --body "Confirm release scope" --checkpoint "Tests pass"

.biao/pm question list --consumer <pm> --status open --plan <plan_id>
.biao/pm question get <question_id> --consumer <pm> --plan <plan_id>
.biao/pm question answer <question_id> --consumer <pm> --plan <plan_id> --answer "Release module A only"
.biao/pm pm ack --consumer <pm> --plan <plan_id> --event-id <asked_event_id>
```

Question events carry routing metadata, not bodies or answers. File contention and dependencies instead use `waiting_file_release` and `waiting_dependency`; the shared scheduler retries them with a fresh claim. Only product decisions use `waiting_pm_reply`.

## Repair and acceptance closure

See [Autonomous closure](docs/autonomous-closure.md).

```text
Worker or Verify failed ─┐
PM rejected delivery ────┼─► bounded repair → delivery → PM Review
failed acceptance ───────┘       repairs the original implementation
                                      ↓
                             source resolution=resolved
```

- Original failed/rejected audit is never erased.
- Repairs inherit project, ownership, Verify, and retry bounds; a PM may explicitly grant minimal adjacent repair ownership.
- `--reverify-only` creates fresh independent acceptance when source code is already accepted/resolved and only evidence is defective. A multi-source acceptance is never fanned out into repairs automatically: use reverify-only, review the concrete source separately, or explicitly select a source for a migrated `repair_sources_required` decision with `--repair-source-task <task_id>`.
- Retry exhaustion becomes `needs_pm_decision`. Inspect `.biao/pm task resolution <task_id>`, then choose `--action continue` or `--action cancel`; do not bypass repair with reset. A cancelled retry-limit chain stays silent, but an operator may explicitly run `--action continue` again to reopen one generation without erasing rejection, failure, or cancellation audit history.
- `task reset`, including `--force`, cannot interrupt a running task while either its lease or `expire_at` is still valid (`TASK_RUNNING_ACTIVE`). The shared Supervisor/watchdog reclaims lost executions. Rejected and cancelled/resolved repair audit chains are immutable; continue the existing lineage explicitly or create a new task.
- An accepted repair resolves the source while preserving its history. Any declared independent repair acceptance is still required.
- Downstream tasks wait for accepted or resolved prerequisites.

## PM CLI and abnormal state handling

```bash
node bin/biao.js version
node bin/biao.js status
node bin/biao.js events --since 1h
node bin/biao.js conflicts
node bin/biao.js plan list
node bin/biao.js plan status my-feature
node bin/biao.js task list --plan my-feature
node bin/biao.js task get my-feature-01-api
node bin/biao.js watchdog --auto-fix
node bin/biao.js db status
```

Use `supersede` only to retire legacy `done + review pending` false-completions while preserving delivery and audit. Plan supersede requires a preview, its SHA-256 snapshot token, reason, and `--yes`; changed state fails closed.

For an abnormal intake item:

```bash
.biao/pm task get <task_id>
.biao/pm task resume <task_id>       # only after an unknown blocking condition is proven gone
.biao/pm watchdog --auto-fix
```

- Never manually resume `waiting_dependency` or `waiting_file_release`.
- Resolve `waiting_pm_reply` only by answering its Question.
- For failures, wait on `repairing`, review the repair at `required`, decide at `needs_pm_decision`, and run watchdog once for eligible legacy failures without resolution.
- Ack only after the action succeeds and current intake no longer contains the item.

### SQLite disaster recovery

`db restore` is only for an empty Biao Redis namespace after disaster—not normal restart and never a reason to flush healthy Redis. There is no force bypass. The current deployment boundary is one Biao service per Redis + SQLite pair; horizontal multi-service operation needs durable fencing that is not currently supported.

1. Stop all Supervisors and Workers.
2. Run `node bin/biao.js db status` and inspect totals, recoverable projection, and exclusions.
3. Confirm the target namespace has no running, lease, ownership, or other Biao state.
4. Run `node bin/biao.js db restore --yes`.
5. Recheck plans/tasks, then restart coordination.

Only projects inside `BIAO_WORKSPACE_ROOTS` are projected. Excluded paths remain in SQLite audit. Historical `running` becomes fresh `pending`; old leases, ownership, and claim tokens are invalid.

## Passive PM polling

Biao records durable minimal bells and lets the PM poll. It does not run a resident Reviewer or auto-accept.

- `review_requested`: delivery needs PM sign-off;
- `acceptance_ready`: an independent acceptance became eligible;
- `question_asked`: a PM Question bell;
- `question_answered`: a scheduler-only retry signal;
- `repair_scheduled`: audit, not interruption;
- `resolution_required`: repair retries exhausted.

Set `pm_consumer` in `index.md` to route a plan. Ack is durable, idempotent, and consumer-isolated. It means “bell handled,” never “task accepted.”

```bash
.biao/pm-start --consumer pm --once
.biao/pm pm intake --consumer pm --json
.biao/pm pm unacked --consumer pm --json
.biao/pm pm ack --consumer pm --event-id <id>
.biao/pm pm watch --consumer pm --interval 60
```

Minimal intake omits task bodies, logs, Verify, ownership, and Question text. The PM fetches detail through scoped task/review/Question commands. Biao never installs a schedule; operators may invoke Supervisor `--once` through their own cron/launchd.

## Service configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIAO_HOST` | `127.0.0.1` | Listen address |
| `BIAO_PORT` | `7331` | Port |
| `BIAO_LOG_DIR` | `.biao/logs` | Log directory for `.biao/start`-hosted processes (server.log / supervisor.log) |
| `BIAO_LOG_MAX_BYTES` | `5242880` | Rotate a log file to `.1` on the next `.biao/start` when it exceeds this size |
| `BIAO_SUPERVISOR_STAY_RESIDENT` | empty | `1` keeps the Supervisor alive after all plans close, re-checking for new plans |
| `BIAO_MAX_CONCURRENT_TASKS` | empty | Cap on concurrently executing tasks per Supervisor; empty = unlimited (one per slot) |
| `BIAO_REDIS_URL` | `redis://localhost:6379` | Redis URL |
| `BIAO_SQLITE_PATH` | package `data/biao.sqlite` | Audit/recovery database |
| `BIAO_WORKSPACE_ROOTS` | empty | Allowed roots, platform-path-delimiter separated |
| `BIAO_API_TOKEN` | empty | Bearer token; required off loopback |

With a token configured, API clients use Bearer authorization; the local loopback console may instead use its HttpOnly local Owner session. Biao refuses non-loopback listening unless both token and precise workspace roots are set; it never issues a local Owner session there, so an independent human identity provider is required before exposing the PM console.

## Security checklist

1. Configure a strong token and precise workspace roots.
2. Never allow `/`, an entire home directory, or broad sensitive roots.
3. Enable Redis persistence and restrict its network.
4. Persist and back up SQLite separately.
5. Supervise the service and resident Workers.
6. Trust plan submitters: Verify commands execute on Worker machines.
7. Never commit tokens, credentials, SQLite, or local claim state.
8. Give each process a unique Agent ID and preferred project.

## Status semantics

`/status` and the dashboard separate **current attention** from **historical audit**. Resolved historical failures do not keep current health red.

| State | Meaning |
| --- | --- |
| `pending` | Waiting for an eligible Worker |
| `running` | Claimed with a valid lease |
| `blocked` | Waiting for PM, file release, or dependency |
| `done + review pending` | Delivered and verified; PM Review required |
| `done + accepted` | Accepted and counted |
| `failed/rejected + repairing` | Source audit preserved; repair active |
| `failed/rejected + required` | Repair delivered; review the repair |
| `failed/rejected + resolved` | Accepted repair closed the source |
| `needs_pm_decision` | Retry bound exhausted |
| `cancelled` | Withdrawn terminal state |
| `superseded` | Legacy false-completion retired with audit intact |

Agent online state derives from heartbeat leases. Normal shutdown records offline reason and last task. A crashed active process stops renewal and remains visible until watchdog safely reclaims the expired lease. Resetting an ordinary completed task clears its old result, Verify, and PM Review; it needs fresh acceptance. Active running tasks, rejected/closed repair audit chains, cancelled tasks, and superseded tasks cannot be reset.

## Testing Biao

Use isolated Redis databases and temporary SQLite—not production:

```bash
REDIS_URL="redis://127.0.0.1:6379/1" \
ACCEPTANCE_REVERIFY_TEST_REDIS_URL="redis://127.0.0.1:6379/2" \
LEASE_LIFECYCLE_TEST_REDIS_URL="redis://127.0.0.1:6379/3" \
LEGACY_REVIEW_TEST_REDIS_URL="redis://127.0.0.1:6379/4" \
OWNERSHIP_TEST_REDIS_URL="redis://127.0.0.1:6379/5" \
REPAIR_OWNERSHIP_TEST_REDIS_URL="redis://127.0.0.1:6379/6" \
RESTORE_DOORBELL_TEST_REDIS_URL="redis://127.0.0.1:6379/7" \
RESTORE_MAINTENANCE_TEST_REDIS_URL="redis://127.0.0.1:6379/8" \
SUPERSEDE_TEST_REDIS_URL="redis://127.0.0.1:6379/9" \
RUNTIME_RECONCILE_TEST_REDIS_URL="redis://127.0.0.1:6379/10" \
STATUS_PROJECTION_TEST_REDIS_URL="redis://127.0.0.1:6379/11" \
AGENT_EPOCH_TEST_REDIS_URL="redis://127.0.0.1:6379/12" \
BLOCKING_CLAIM_TEST_REDIS_URL="redis://127.0.0.1:6379/15" \
npm test

npm --prefix web test -- --run
npm run build
npm run verify:package
```

Product acceptance covers plan submission, two independent Workers, lease/heartbeat, Verify/report evidence, independent acceptance, PM Review, browser/API agreement, and reset without stale acceptance. Test counts evolve; use current exits and full output, not a fixed count.

## Current boundaries

Biao is a local-first multi-Agent development control plane, not an enterprise SaaS. Its source code is available under [Apache-2.0](LICENSE), but it does not yet include:

- native GitHub/GitLab PR and CI integration;
- enterprise SSO, RBAC, or multi-tenancy;
- container-level Worker sandboxing;
- model token, cost, or trace analytics;
- cross-node deployment and elastic scaling.

### Source availability and packages

Source code, documentation, and included project files are licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for project notices, [CONTRIBUTING.md](CONTRIBUTING.md) for contribution terms, and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.

The root and web `package.json` files intentionally remain `private: true`: this prevents accidental npm publication while package naming, versioning, provenance, and release approval are established. CI verifies source and private package artifacts; it does not publish to npm or create GitHub Releases.
