# Contributing

Engineering Bridge is a stable local supervised bridge (V1; current version v1.5.0). Narrowly scoped fixes, documentation improvements, and tests are welcome when they preserve the current 15-tool MCP surface — `run_task`, `task_result`, `control_task`, `bind_project`, `create_project`, `authorize_workspace_write`, `generate_controlled_patch`, `refine_controlled_patch`, `submit_controlled_patch`, `apply_controlled_patch`, `commit_controlled_patch`, `configure_validation_profile`, `validate_controlled_patch`, `start_controlled_patch_validation`, and `get_controlled_patch_validation` — and its supervision boundaries. Keep the tool surface minimal: a new tool must justify a real user capability need and a clear security boundary; the tool count is not fixed forever, but every addition must stay within the local supervised-bridge model and prefer the smallest sufficient change (YAGNI). Ordinary/supervisor execution (Codex and DSH) and proposal generation must remain read-only, with dangerous writes explicit and behind reviewed confirmation. Interactive turns use state-checked continue/steer/interrupt/accept, while completed patch proposals are polled through `task_result`, reviewed outside task state, and passed directly to `apply_controlled_patch` with exact `APPLY`; they must never enter supervisor review or be accepted through `control_task`. Controlled application must remain disabled by default, limited to existing tracked regular text files and absent 100644 ordinary text-file additions (including unborn repositories), and must never automatically run tests, stage, commit, or push. Optional validation uses the trusted configured profile: `validate_controlled_patch` waits for a report, while `start_controlled_patch_validation` returns a retained run ID for independent queries through `get_controlled_patch_validation`; `PASS` never authorizes `APPLY`. Active task/thread/evidence/review supervision state remains process-local, while the managed workspace catalog, controlled-patch retained state, validation profiles, and async validation results persist across restarts; `workspace_id` stays required, managed onboarding is confined to configured `project_root` approved roots through exact `BIND`/`CREATE`, and controlled-write authorization for managed workspaces goes through exact `AUTHORIZE`. Preserve backward compatibility for existing call shapes and defaults.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

## Debugging slow or stalled tasks

Bridge invokes Codex via `codex app-server --stdio`. When debugging a slow or stalled task, inspect more than Bridge controlled-patch state and tunnel logs: also inspect `~/.codex/sessions/YYYY/MM/DD/*.jsonl`, which contains structured timestamps, types, and events, and optionally `~/.codex/logs_2.sqlite` if it actually contains rows. Running `generate_controlled_patch` and `refine_controlled_patch` tasks do not expose executor evidence like ordinary `run_task`, so `running` with no evidence must not be interpreted as a handshake or startup stall.

Correlate the Bridge `task_id` with the Codex thread/session ID when available. Compare session-start, tool-result, final-message, and session-end timestamps before attributing latency to RPC, turn execution, terminal handling, persistence, or outer orchestration. If phase timing is insufficient, report that the evidence is insufficient rather than guessing. Future observability should persist bounded Bridge `task_id` ↔ Codex thread/session mappings and phase timestamps without sensitive body logging or unbounded growth.

Run the standard checks before submitting a change:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
