# Biao Agent Entry

If `.biao/config.env` does not exist after cloning this repository, read `README.md` and run:

```bash
./bootstrap.sh --yes --workspace <allowed-workspace> --project <default-project> --pm-agent codex
```

Do not guess broad filesystem roots. Ask the user when the allowed workspace or default project cannot be safely inferred.

After bootstrap:

- Run `.biao/doctor` to check Node, npm, Redis and optional Agent executables.
- Run `.biao/start` to start Biao.
- To act as an execution Worker, use `.biao/worker-codex`, `.biao/worker-kimi`, or `.biao/worker-custom`.
- Before acting as a Worker, read `docs/worker-integration.md`. If your harness already has the `biao` MCP server configured, prefer the MCP tools (`task_claim` / `task_get` / `task_report` etc., see `docs/mcp.md`) — they wrap the same HTTP lifecycle. A Worker that claims a task is auto-joined to that project; no frontend "add" is required. If a product decision is missing, never ask the current human: emit exactly one `BIAO_QUESTION: {"body":"...","checkpoint":"..."}` line so Biao can release the old claim/ownership. The PM must then use `question list -> question get -> question answer`, and run `pm ack` only after the answer is actually recorded; the Worker resumes only through a fresh claim.
- To act as PM, read `.biao/PM_AGENT.md` completely and begin every PM session with `.biao/pm-start --once`. It only checks status and rings the PM bell; it never auto-acks or auto-accepts. `.biao/pm-intake` is retained only for legacy diagnostic scripts, not as the new-session entry point.
- If the operator chose `--pm-agent codex`, the shared `.biao/supervisor` uses the built-in `.biao/codex-pm-agent` adapter to wake an ephemeral PM only when a minimal bell exists. For another PM Agent, explicitly configure `BIAO_PM_AGENT_CMD`; `.biao/pm-agent --once` remains the low-resource compatibility entry. Neither path passes a Biao token or task details, installs cron/launchd, or treats wake-up as review/answer/ack.
- `.biao/pm-watch` is the low-resource resident doorbell watcher for a central Biao (no local server, stay-resident). By default it runs the supervisor with no worker slots (pure PM doorbell); when the machine has configured `BIAO_WORKER_SLOTS` and `BIAO_PM_WATCH_KEEP_WORKER_SLOTS=1` (auto-set by `supervisor-config worker add/remove`), the same resident also claims and executes tasks, so rejected-repair tasks are picked up without a human nudge. Cross-machine slots use `project` (central canonical path, for register/claim matching) plus `workspace` (this machine's real checkout, used for execution when the task's `project_path` is absent locally). Set `BIAO_SUPERVISOR_AUTO_ENSURE=1` in `.biao/config.env` to self-heal: after a successful `task_claim`/`task_report` (MCP or worker runtime), `pm ack`, or `question answer`, the machine re-ensures `pm-watch` is running via `pm-watch --ensure` (idempotent, single-instance locked; MCP sessions also re-ensure every 5 minutes). Useful on every worker/PM machine that talks to a shared central Biao.

PM acceptance rule: `done` is only delivery state. A task counts as complete only after evidence review and PM Review `accepted`. An acceptance task must be performed by an Agent independent from the implementation Agent.
