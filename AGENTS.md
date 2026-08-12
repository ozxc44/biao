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
- Before acting as a Worker, read `docs/worker-integration.md`. If a product decision is missing, never ask the current human: emit exactly one `BIAO_QUESTION: {"body":"...","checkpoint":"..."}` line so Biao can release the old claim/ownership. The PM must then use `question list -> question get -> question answer`, and run `pm ack` only after the answer is actually recorded; the Worker resumes only through a fresh claim.
- To act as PM, read `.biao/PM_AGENT.md` completely and begin every PM session with `.biao/pm-start --once`. It only checks status and rings the PM bell; it never auto-acks or auto-accepts. `.biao/pm-intake` is retained only for legacy diagnostic scripts, not as the new-session entry point.
- If the operator chose `--pm-agent codex`, the shared `.biao/supervisor` uses the built-in `.biao/codex-pm-agent` adapter to wake an ephemeral PM only when a minimal bell exists. For another PM Agent, explicitly configure `BIAO_PM_AGENT_CMD`; `.biao/pm-agent --once` remains the low-resource compatibility entry. Neither path passes a Biao token or task details, installs cron/launchd, or treats wake-up as review/answer/ack.

PM acceptance rule: `done` is only delivery state. A task counts as complete only after evidence review and PM Review `accepted`. An acceptance task must be performed by an Agent independent from the implementation Agent.
