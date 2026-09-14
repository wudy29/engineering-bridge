# MCP tool reference

This is the tool surface of Engineering Bridge 1.5.0. The local STDIO MCP server exposes fifteen tools. The two async validation tools are additive; the original thirteen contracts remain supported.

## Codex routing policy

The optional `ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY` environment variable belongs to Bridge and accepts exactly `inherit` or `explicit`. When unset, the default is `inherit`, preserving the v1.4.x public compatibility behavior: Codex may use its existing configuration when `model` and/or `reasoning_effort` are omitted. Set it to `explicit` when the deployment must fail closed unless every Codex invocation supplies both non-blank fields.

With `explicit`, the hard gate runs inside `CodexExecutor.execute()` before executable resolution or process start. Missing or blank `model` or `reasoning_effort` returns `CODEX_ROUTING_REQUIRED` with `Explicit model and reasoning_effort are required for Codex execution.`; it does not start Codex. Provided values still pass the existing Codex `model/list` and reasoning-effort validation and are sent through `turn/start`. This policy does not constrain DSH; DSH's existing rejection of Codex-only selection fields remains `UNSUPPORTED_ACTION`.

Any other policy value, including an empty string or a case variant, fails Bridge startup rather than falling back to `inherit`.

## `run_task`

Inputs: `workspace_id`, `instruction`, optional `executor` (`"codex" | "dsh"`, default `codex`), and optional Codex-only `model` and `reasoning_effort`.

Starts a supervised task with the selected executor and returns `task_id`. `run_task` is always read-only: Codex uses approval `never`, a read-only sandbox policy, and disabled network access; DSH is pinned read-only per process. Codex validates requested model/reasoning support through `model/list`; DSH rejects either option. An unknown workspace becomes a failed task; it does not grant access to a new path. The executor selection is fixed for the task lifetime and reported honestly in `task_result`.

## `task_result`

Input: `task_id`.

Returns the task state, readiness, fixed `executor`, and current bounded `evidence`. Queued and running tasks have `ready: false`. A successful turn has state `waiting_for_supervisor_review`, `ready: true`, and `review_output`. After acceptance, state is `completed` and the reviewed text is returned as `output`. Failures return a safe `{code,message}` error. An unknown task ID returns `UNKNOWN_TASK`.

Conditional fields:

- `thread_id`: present only for Codex tasks once a real native app-server thread exists. DSH headless has no machine-resumable session seam, so DSH tasks never carry a fabricated `thread_id`.
- `partial_output`: present only when a genuine interrupt produced real partial output (for example, DSH cached partial stdout or the last completed Codex agent message). The task state is still `failed`; `partial_output` is never completed `output` and never appears in `error`.

`evidence` contains bounded command-execution and file-change items. When the existing bounds truncate or evict evidence, explicit markers are returned: strings cut by the size bound end with `[truncated]`, an oversized changes list gains a `[truncated: N additional changes omitted]` entry, and evidence evicted by the total count limit is reported through a synthetic `evidence-drop` item. These markers mean the diagnostic information is incomplete.

## `control_task`

Inputs: `task_id`, `action`, and optional `instruction`.

The actions are state-specific:

- `continue`: while `waiting_for_supervisor_review`, requires a non-empty instruction, queues another read-only turn, and preserves app-server thread continuity with `thread/resume` for Codex. For DSH, `continue` starts a new headless execution; there is no native resume.
- `steer`: while `running`, requires a non-empty instruction and steers the active turn (Codex only).
- `interrupt`: while `running`, interrupts the active turn. When interruption completes, the task ends as `failed`; genuine partial output may be exposed as `partial_output`.
- `accept`: while `waiting_for_supervisor_review`, marks the reviewed output `completed` without starting another turn.

Running generated/refined proposal tasks also accept `interrupt`, and Codex proposal tasks accept `steer`; completed proposal tasks do not accept any action. Invalid actions for the current state return `INVALID_STATE_TRANSITION`. Executor runs have a 15-minute hard deadline; active Codex turns also have a two-minute protocol-inactivity watchdog, reset only by an app-server notification whose `threadId` and `turnId` exactly match the active turn. Other threads, other turns, global notifications, and RPC responses do not reset it. Short Codex RPC calls have a separate 30-second bound. There is no automatic acceptance or persistent task supervision state.

## `bind_project`

Inputs: `project_path`, `confirmation` (must equal `BIND` exactly).

Registers an existing directory inside a configured `project_root` as a read-only managed workspace. The path must already exist, resolve inside an approved root (canonical real-path containment), and not already be registered. Returns the `workspace_id`; registration persists to `<config>.managed-workspaces.json`. A managed workspace does not gain controlled-write permission from binding.

## `create_project`

Inputs: `parent`, `name`, `confirmation` (must equal `CREATE` exactly).

Creates and git-initializes a new single-segment directory inside a configured `project_root` and registers it as a read-only managed workspace. Only `mkdir` and `git init` are performed; the repository is left unborn (no commit) and no files are added. Returns the `workspace_id`; registration persists to `<config>.managed-workspaces.json`.

## `authorize_workspace_write`

Inputs: `workspace_id`, `confirmation` (must equal `AUTHORIZE` exactly).

Grants persistent controlled-write permission to one managed workspace only; manual workspaces remain authoritative through `workspaces.json`. The authorization is persisted first, then applied at runtime. This permission gates only `apply_controlled_patch`; it is not direct-write access and does not change `run_task` (which stays read-only).

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`, optional `executor` (`"codex" | "dsh"`, default `codex`), and optional Codex-only `model` and `reasoning_effort`.

Read-only proposal flow available in any registered workspace; no write authorization is required to generate. It verifies that the configured root resolves to the Git top-level and that tracked state and the index are clean (with an existing HEAD, or unborn-repository support for added-file proposals), records and returns `base_head`, and starts a separate read-only proposal task that does not modify files. The proposal and its applied history persist to `<config>.controlled-patches.json`.

## `refine_controlled_patch`

Inputs: `patch_task_id`, `change_request`, optional `executor` (`"codex" | "dsh"`, default `codex`), and optional Codex-only `model` and `reasoning_effort`.

Read-only refinement of a completed controlled-patch proposal: returns a new complete proposal against the same `base_head`, preserving the source proposal. The executor is selected per call and defaults to `codex`; it is not inherited from the parent proposal. Requires the source task to be `completed` and the workspace base to be unchanged. No write authorization is required; it never modifies files.

## `submit_controlled_patch`

Inputs: `workspace_id`, `base_head`, `diff`.

Registers a caller-provided complete unified Git diff as a retained, already-completed read-only proposal. `base_head` must exactly equal the current commit HEAD, and the shared controlled-patch preflight verifies the workspace and diff before registration. No executor or model runs, so `task_result` reports `source: "submitted"` without an executor identity. Submission requires no write authorization; application still requires human review, write permission, exact `APPLY`, and all normal rechecks.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`.

The controlled file-application checkpoint. Confirmation must equal `APPLY` exactly, the proposal must be known, completed, and not already applied, and the workspace must hold controlled-write permission (managed `AUTHORIZE` or a manual `allow_write: true` entry). The tool rechecks the canonical Git root, clean tracked state and index, and exact base HEAD (including unborn-base validation) before validating and applying the patch once. It can modify existing tracked regular text files or add an absent ordinary text file from an exact 100644 text diff. A new target must be absent from base HEAD, the current index, and the worktree. It never tests, stages, commits, or pushes.

## `commit_controlled_patch`

Inputs: `patch_task_id`, `message`, `confirmation` (must equal `COMMIT` exactly).

Creates one Git commit containing only an already-`APPLY`ed controlled patch. The patch task must identify a retained controlled proposal that has already been applied; `message` must be non-empty and the confirmation is exact and case-sensitive. The index must start clean, unrelated tracked or staged changes are rejected, and retained patch content is staged exactly. Pre-existing unignored untracked files outside the patch targets are allowed only when Bridge can safely fingerprint them under the workspace lock and match their complete path set and contents at later discrete verification checkpoints; new, removed, modified, replaced, or unsupported special paths fail closed. Existing tracked gitlink worktrees are scan boundaries, so Bridge does not recurse into them with superproject ignore rules. This checking is not continuous monitoring or a filesystem transaction. If Git creates the commit but final recovery-anchor verification fails, the call returns `WORKSPACE_PRECONDITION_FAILED` with HEAD already advanced; Bridge does not reset or rewrite history, and retrying the same proposal fails its original-base-HEAD check without another commit. Patch-added untracked targets remain controlled patch paths, while ignored paths retain their existing semantics and stay outside this snapshot. The commit step is separate from `APPLY`, does not imply any later gate, and never pushes.

## `configure_validation_profile`

Inputs: `workspace_id`, `profile`, `confirmation` (must equal `CONFIGURE` exactly).

Replaces the fixed validation profile for one registered workspace. A profile contains ordered `preparation` and `validation` steps; each step is a non-empty argv array and optional timeout, never a shell string. The profile is persisted in the local `<config>.validation-profiles.json` sidecar. Configuration does not validate a proposal and does not authorize `APPLY` or `COMMIT`.

## `validate_controlled_patch`

Input: `patch_task_id`.

Runs the retained proposal against the workspace validation profile in a temporary detached worktree after the normal controlled-patch preflight. Results are `PASS`, `FAIL`, or `INCOMPLETE`. Validation is optional and on-demand: it neither changes proposal state nor grants write permission, and the detached worktree protects the registered workspace from candidate build artifacts but is not a host-level sandbox. Unborn-base proposals return `INCOMPLETE` with `reason: "unsupported_unborn_base"`.

This original API is synchronous: the RPC waits for the complete report and does not create an async run. Its input and report shape are unchanged. Use it for short validations or existing callers; use the following pair when execution might outlast a caller's request window.

## `start_controlled_patch_validation`

Strict input object (all fields required; no additional properties):

```json
{
  "type": "object",
  "properties": {
    "patch_task_id": {"type": "string", "minLength": 1, "maxLength": 256},
    "idempotency_key": {"type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,128}$"}
  },
  "required": ["patch_task_id", "idempotency_key"],
  "additionalProperties": false
}
```

For example, call with `{"patch_task_id":"retained-proposal-task-id","idempotency_key":"review-1"}`. The service resolves the retained proposal and trusted configured profile, freezes their identities, and atomically persists admission **before** scheduling any execution. The short response contains:

```json
{
  "validation_run_id": "a-returned-UUID-v4",
  "patch_task_id": "retained-proposal-task-id",
  "workspace_id": "registered-workspace",
  "base_head": "the-proposal-base-HEAD",
  "state": "running",
  "status": null,
  "phase": "admitted",
  "admitted_at": "2026-09-14T00:00:00.000Z"
}
```

The UUID and HEAD above are placeholders. `base_head` can be null for an unborn proposal. A replay returns the retained run's current state/phase/status rather than promising `admitted`. Success proves durable admission, not PASS. Missing profile and unsupported unborn base are admitted and settle to retained `INCOMPLETE` without configured execution. Unknown or ineligible proposals return the existing safe proposal error (for example `INVALID_STATE_TRANSITION`) without admission.

Idempotency is scoped to this Bridge store. The same key and patch replay the **first** admission, before reading any newly configured profile or current proposal state. The same key with a different patch returns `VALIDATION_IDEMPOTENCY_CONFLICT`. A new key requests explicit revalidation and captures current identities; it never overwrites an earlier result. Another active run for that patch returns `VALIDATION_ALREADY_RUNNING`; unresolved recovery evidence returns `VALIDATION_RECOVERY_REQUIRED`. There is a four-active-run limit (`VALIDATION_CAPACITY_BUSY`); no queue or automatic retry exists. Preserve both the key and returned run id, including across network errors.

Only the Bridge-owned service holds execution promises, AbortControllers, children and process groups. Request cancellation or caller EOF does not cancel an admitted run while Bridge stays alive. A launcher that kills Bridge on disconnect invokes the shutdown/restart semantics below. Start accepts no argv, shell, timeout, profile, environment, workspace root, temporary path, or process options. It never invokes APPLY/COMMIT/push.

## `get_controlled_patch_validation`

Strict input object: `{"validation_run_id":"returned-UUID-v4"}`. The JSON schema is an object with the single required `validation_run_id` string property (`format: "uuid"`) and `additionalProperties: false`; the store further requires a UUID v4 run identity.

Query returns the retained `ValidationRun` record, without a validation wait, spawn, cleanup, retry, resume, or state update:

| Fields | Meaning |
| --- | --- |
| `schema_version`, `validation_run_id`, `patch_task_id`, `workspace_id`, `workspace_root`, `base_head` | Versioned run and candidate identity |
| `idempotency_key`, `admission_sequence`, `operation_sequence` | Admission identity and durable update version; no process journal |
| `proposal_fingerprint`, `patch_sha256`, `profile_sha256`, `profile_snapshot` | Frozen identity and the resolved immutable profile, or null profile if missing |
| `state`, `phase`, `status` | `running` with null status, initially phase `admitted`; `terminal` with `PASS`, `FAIL`, or `INCOMPLETE` |
| `current_step`, `steps` | Current phase/index/name; ordered completed results with status, exit code, duration, bounded output tail and reason; never-started steps are absent |
| `admitted_at`, `started_at`, `updated_at`, `ended_at`, `recovered_at`, `total_duration_ms`, `duration_basis` | Retained timing; null where not yet applicable; recovery reports the last checkpoint as a duration lower bound |
| `cleanup`, `reason`, `owned_worktree`, `owner_instance_id` | Cleanup disposition/recovery fence, result reason and forensic ownership; no durable validation child PID |

Progress is a checkpoint observation, not live elapsed time or stdout streaming. `PASS` requires successful required cleanup. Infrastructure or cleanup failure yields `INCOMPLETE`, preserving earlier definite step results. A terminal result does not authorize or alter a proposal and cannot be used as APPLY confirmation.

Unknown valid UUIDs return `isError: true` with `{error:{code:"VALIDATION_RUN_UNKNOWN",message:...}}`. Corrupt/incompatible retained records return `VALIDATION_RUN_CORRUPT` / `VALIDATION_RUN_INCOMPATIBLE`, never fabricated success or raw file content. Storage/boundary/owner failures use `VALIDATION_STORE_UNAVAILABLE`, `VALIDATION_STORE_BOUNDARY`, or `VALIDATION_OWNER_UNAVAILABLE`; invalid schema is rejected at MCP input validation. Errors contain fixed safe messages. Query itself does not perform startup recovery; the service is opened before the MCP session is served.

## Async storage, restart and migration

Use a trusted, canonical configuration directory outside every repository, registered workspace and approved `project_root`. Existing configurations inside those boundaries remain usable for the legacy tools, but async admission/query fail closed. No automatic migration or fallback storage exists; moving a deployment's config and sidecars is an explicit operator action.

For configuration `<config>`, async uses private `<config>.validation-runs/`, sibling `<config>.validation-runs.owner.json` / `.owner-guard`, and `<config>.validation-worktrees/`. Records are atomic write/fsync/rename replacements with bounded 64 KiB per-step tails, a 4 MiB record cap and 256 MiB/4096-entry store limits. Capacity fails closed rather than evicting history. Snapshots retain configured argv; keep credentials out of profiles and output. Only one Bridge can own a store at a time; another instance returns safe async ownership errors while legacy tools remain available. Async v1 requires POSIX; Windows returns `VALIDATION_PLATFORM_UNSUPPORTED` without disabling the old tools.

Normal SIGTERM/SIGINT or service shutdown aborts supervised children/process groups within existing bounds and attempts bounded, ownership-verified cleanup. Caller EOF lets active work finish before natural process exit. A hard Bridge crash cannot guarantee child termination; startup never signals an old child, resumes, retries, attaches, visits an old worktree, or deletes a stale scene. Instead it durably converts leftover non-terminal records to `INCOMPLETE` (`supervisor_lost`) with the existing cleanup disposition and recovery fence. Uncertain persistence/ownership fails closed. The fence is not cleared by manually deleting paths; a later explicit controlled recovery is required and no cleanup tool is exposed in v1.5.0.

Completed records remain queryable after restart. Refresh the connector catalog after installing the new version (13 → 15). No existing tool is renamed or made asynchronous; no list/history, cleanup, subscription, or streaming tool is added.
