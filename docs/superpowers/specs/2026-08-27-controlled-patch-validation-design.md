# Engineering Bridge Controlled Patch Validation Design

## Design Status

Sections 1–11 record the original synchronous validation contract, which remains supported unchanged. References there to “v1” scope (including no retained results or background execution) describe that original path. Section 12 defines the additive v1.5.0 async extension; it supersedes those scope limits only for the new start/query path. Neither path changes executor task, controlled-proposal or APPLY behavior.

## 1. Scope and Invariants

Two MCP actions are added:

- `configure_validation_profile` stores the trusted local validation profile for one registered workspace after exact `CONFIGURE` confirmation.
- `validate_controlled_patch` validates one retained proposal identified only by `patch_task_id`.

Validation happens only when `validate_controlled_patch` is called. The existence or configuration of this capability must not make `run_task`, `task_result`, proposal generation/refinement/submission, or any other controlled-patch path perform validation work, scan files, create Git worktrees, start subprocesses, or wait for validation.

The registered workspace remains untouched by the candidate patch and by validation build artifacts. Validation does not change proposal or task lifecycle state and does not authorize or invoke APPLY.

## 2. Profile Configuration and API

Validation configuration is trusted local Bridge/workspace configuration, not repository-controlled configuration. Bridge must not discover or load executable validation commands from files in the repository.

Before configuration, the assistant inspects the project and presents the exact proposed commands and timeout values to the user. The user approves that complete profile once with exact `CONFIGURE`; subsequent validation calls use the stored profile without accepting command input. `AUTHORIZE` is not reused: controlled-write authorization and approval of executable validation configuration are separate trust decisions.

The configuration shape is deliberately small:

```json
{
  "workspace_id": "registered-workspace",
  "confirmation": "CONFIGURE",
  "profile": {
    "preparation": [
      {"name": "install", "argv": ["program", "literal-argument"]}
    ],
    "validation": [
      {"name": "test", "argv": ["program", "literal-argument"]}
    ],
    "default_step_timeout_seconds": 600,
    "total_timeout_seconds": 1200
  }
}
```

A step may have a fixed `timeout_seconds`; otherwise the configured default applies. Omitted timeout settings resolve to the initial policy of 600 seconds per step and 1200 seconds total. The resolved values are part of the stored profile and cannot be changed by a validation call.

Each workspace has exactly one current, complete profile in v1. Configuring a replacement requires presentation and exact `CONFIGURE` approval of the replacement as a whole; there is no per-step mutation, merge, inheritance, or repository override. Profile storage is keyed by registered workspace identity and lives with trusted Bridge-managed configuration outside the project tree.

Commands are non-empty argv arrays, never shell strings. Empty argv, invalid values, or a confirmation other than exact `CONFIGURE` are rejected without storing a partial profile or executing anything.

The validation request accepts no other input:

```json
{"patch_task_id": "retained-proposal-task-id"}
```

In particular, callers cannot provide commands, arbitrary argv, environment scripts, shell text, or timeout values at validation time.

For `engineering-bridge-public`, an example profile could be:

```json
{
  "preparation": [
    {"name": "install", "argv": ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]}
  ],
  "validation": [
    {"name": "build", "argv": ["npm", "run", "build"]},
    {"name": "test", "argv": ["npm", "test"]},
    {"name": "diff-check", "argv": ["git", "diff", "--check"]}
  ],
  "default_step_timeout_seconds": 600,
  "total_timeout_seconds": 1200
}
```

These npm and test commands are examples only. Profiles are per-workspace trusted local configuration; the implementation must not hardcode this project, npm, or any test command.

## 3. Components and Ownership

The minimum component boundaries are:

- The MCP registration layer validates the two request schemas and exact confirmation.
- A small local profile store owns the single resolved profile per workspace. It does not inspect repositories or run commands.
- The controlled-patch domain remains the source of retained proposal, workspace, and base-HEAD data. Validation reuses its existing controlled-patch preflight rather than duplicating workspace, base HEAD, or patch-validity rules.
- A validation coordinator owns the temporary worktree, sequential command execution, time budgets, bounded evidence, cleanup, and report assembly.
- A narrow process runner executes argv directly with a fixed working directory and no shell, and retains only bounded output tails.

These responsibilities may be added to existing modules where they fit; v1 does not require a new framework, service hierarchy, or lifecycle subsystem.

## 4. Validation Data Flow

`validate_controlled_patch` performs this single synchronous flow:

```text
patch_task_id
  -> resolve retained proposal and registered workspace
  -> require that workspace's configured profile
  -> reuse controlled-patch preflight for workspace/base HEAD/patch validity
  -> create a temporary detached Git worktree at proposal base_head
  -> apply the candidate patch only in that temporary worktree
  -> run fixed preparation commands there, in profile order
  -> run fixed validation steps there, in profile order
  -> stop on the first definite validation failure or any timeout
  -> collect bounded per-step evidence
  -> always attempt temporary-worktree cleanup
  -> return one structured report
```

In v1, `validate_controlled_patch` does not support retained proposals whose `base_head` is absent or null. It must return `INCOMPLETE` with reason `unsupported_unborn_base` before creating any temporary worktree or executing any configured command.

All configured commands execute with the temporary worktree as their working directory. Program and arguments are passed through a `spawn`/`execFile`-style API with shell execution disabled. Shell metacharacters inside an argument remain literal arguments.

No preparation or validation command runs until proposal resolution, profile lookup, and the existing preflight succeed. Failure to create the worktree or apply the already-preflighted patch is an incomplete validation, not permission to fall back to the registered workspace.

## 5. Timeouts, Failure, and Cleanup

Commands run sequentially. A command receives no more than its fixed per-step timeout or the remaining total validation budget, whichever is smaller. Defaults are 600 seconds per step and 1200 seconds total. These execution limits do not prove any Chat/cloud request window; the synchronous RPC still depends on its caller connection surviving the full run. The async extension removes that dependency from admission and result retrieval.

A per-step or total timeout terminates the active child, stops all later steps, and produces `INCOMPLETE`. After the main budget expires, cleanup is still attempted immediately under a small fixed Bridge-owned cleanup bound so the whole call remains bounded. There are no retries.

The first configured preparation or validation command that definitively exits nonzero produces `FAIL` and prevents later steps from starting. Spawn errors, signals without a definitive command exit, proposal/preflight errors, worktree/apply errors, and cleanup errors produce `INCOMPLETE`.

Cleanup is attempted in a `finally`-equivalent path after success, failure, timeout, or setup error whenever temporary state may exist. `PASS` requires successful preconditions, preparation, every validation step, and required cleanup. `FAIL` requires a definitive nonzero configured command exit and successful required cleanup. If cleanup or other infrastructure disposition is incomplete, the overall result is `INCOMPLETE`, while the report still preserves any earlier definite step result.

## 6. Structured Result

Overall status has exactly these meanings:

- `PASS`: every configured command and all required preconditions and cleanup succeeded.
- `FAIL`: a configured preparation or validation command definitively exited nonzero and no infrastructure or cleanup failure made the run incomplete.
- `INCOMPLETE`: validation could not complete because of configuration, infrastructure, preflight, apply, spawn, timeout, signal, or cleanup reasons.

Each attempted preparation or validation command reports, at minimum:

```json
{
  "name": "stable-step-name",
  "argv": ["program", "literal-argument"],
  "status": "PASS",
  "exit_code": 0,
  "duration_ms": 1234,
  "output_tail": "bounded trailing output"
}
```

`exit_code` is included only when available. A stable step identity may replace repeated argv in the returned record if the configured profile makes that identity unambiguous. Later steps that were never started are not reported as executed.

The overall report minimally includes `status`, `patch_task_id`, `workspace_id`, `base_head`, `total_duration_ms`, ordered step results, and cleanup status plus a reason when cleanup is not successful. It includes a concise reason for `INCOMPLETE`.

Output capture uses a fixed Bridge-owned in-memory tail bound per command. Earlier bytes are discarded as output arrives. v1 does not retain full output or add a persistent log service.

## 7. Security and Trust Boundary

Temporary Git-worktree isolation protects the registered workspace's files and cleanliness from the candidate patch and validation artifacts. It is not a host-level security sandbox. Configured programs retain the Bridge process's host permissions and can access resources outside the temporary worktree if the program itself does so.

Therefore executable profiles are allowed only for trusted workspaces and only after the user reviews the exact argv and confirms `CONFIGURE`. Direct argv execution with no shell prevents callers from injecting shell syntax through validation inputs, but it does not make an approved executable safe. Repository content cannot silently define or replace a profile.

Validation never applies the candidate patch to the registered workspace. No failure path may retry there, copy build artifacts there, or use it as a command working directory.

## 8. Performance and Non-Regression Constraints

The feature is cold unless explicitly invoked. Ordinary Bridge startup and existing task/proposal/result paths do not load project files for validation, run validation-profile discovery, create worktrees, start validators, or wait on validation state.

One validation call creates at most one temporary worktree and runs one sequential command at a time. v1 has no dynamic focused-test selection, conditional rules, retries, matrices, parallel runners, background workers, queues, event bus, executor pool, session manager, or persistent log service.

The total timeout is the external latency bound for validation work; bounded cleanup follows immediately. Evidence size is bounded independently of command output volume.

## 9. Lifecycle and Gate Separation

Validation is advisory evidence for Supervisor/Chat review. v1 does not add `validated`, `validation_failed`, or other proposal/task lifecycle states, and does not mutate, pin, release, replace, refine, or apply the retained proposal.

Validation is not automatically bound to APPLY. Supervisor/Chat reviews the report and separately decides whether to request APPLY. Existing `BIND`, `AUTHORIZE`, `APPLY`, `COMMIT`, and `PUSH` gates remain separate and unchanged; a validation result grants none of them.

## 10. Test Strategy

Implementation starts with failing behavior tests and proceeds TDD. Tests use deterministic fake processes and timers for runner behavior, plus temporary Git repositories for the isolation boundary. Required coverage is:

- exact `CONFIGURE` acceptance, rejection of `AUTHORIZE` and all other confirmations, atomic profile storage, and one fixed profile per workspace;
- argv validation and literal metacharacter arguments reaching a no-shell process API without interpretation;
- rejection of an unconfigured workspace before worktree creation or command execution;
- reuse of the existing controlled-patch preflight and preservation of its workspace, base-HEAD, and patch-validity failures;
- temporary-worktree isolation and cleanup on pass, validation failure, preparation failure, and timeout;
- proof that the candidate patch and generated artifacts never appear in the registered workspace;
- stop-on-first-failure and stop-on-timeout behavior;
- exact `PASS`, `FAIL`, and `INCOMPLETE` classification, including cleanup failure overriding an otherwise complete result;
- bounded `output_tail` under large stdout/stderr and absence of full-log persistence;
- per-step timeout and total-timeout enforcement without real-clock threshold tests;
- no mutation of proposal/task lifecycle, proposal content, retention, or APPLY authorization;
- non-regression proving ordinary `run_task`, `task_result`, and existing controlled-patch paths never invoke profile lookup that scans a project, worktree creation, the validation runner, or validation waits.

## 11. Explicit Non-Goals

v1 does not include dynamic command selection, focused-test inference, conditional rules, retries, matrices, parallelism, background execution, workers, queues, an event bus, executor pools, session management, persistent full logs, Docker or VM sandboxing, automatic remediation, validation-triggered APPLY, or new proposal/task states.

It also does not add repository-controlled validation configuration, a profile language, profile inheritance, multiple named profiles per workspace, validation history, caching, artifact retention, or implementation-specific project presets.

## 12. v1.5.0 async extension

The existing `validate_controlled_patch(patch_task_id)` input, synchronous report and coordinator remain unchanged. Two tools expose the committed minimal async service: `start_controlled_patch_validation(patch_task_id, idempotency_key)` and `get_controlled_patch_validation(validation_run_id)`. The total catalog is fifteen. Both inputs are strict, with no command/path/profile/timeout/process injection; [tools.md](../../tools.md) specifies the exact public schemas and output fields.

Start first replays an existing key, or captures proposal/profile identities and durably admits a new record. Only then does the Bridge-owned service schedule execution; start returns a small receipt without waiting for validation. Same key/patch always means the first admission, including after CONFIGURE or proposal changes; same key/different patch conflicts, and a new key explicitly requests revalidation. One active run per patch, a four-run service capacity and a retained recovery fence constrain admission without a worker queue.

The record stores a UUID, patch/workspace/base identity, proposal and patch hashes, immutable resolved profile snapshot/hash, idempotency key, admission/update sequences, timestamps, state/phase/current step, ordered bounded step results, cleanup disposition and worktree ownership. `operation_sequence` is a durable update version, not a process journal. States are `running` and `terminal`, with terminal PASS/FAIL/INCOMPLETE retaining section 6 meanings. Current-step and completed-step checkpoints are observations rather than streamed stdout. No validation child PID or per-process intent/receipt/settled state is persisted.

The service opens once before MCP connect; query never performs lazy recovery. It reads retained state immediately, distinguishes unknown/corrupt/incompatible records safely, and never waits for validation, executes, cleans up or mutates state. Private Bridge-managed storage beside the canonical config path is outside all repositories, registered workspaces and approved onboarding roots; writes are atomic/fsynced and bounded. Each command tail is at most 64 KiB; records at most 4 MiB; store capacity is bounded without automatic eviction. Uncertain persistence fails closed and promptly aborts active execution, independently of best-effort error cleanup I/O. An unavailable async service does not break the original tools.

Execution belongs to the service, not the MCP handler, connection or request AbortSignal. Caller EOF/cancellation does not cancel it while Bridge remains alive. Normal shutdown uses the existing bounded abort/process-group termination and normal worktree cleanup; a wrapper that kills Bridge is a shutdown/crash event. Runtime cleanup revalidates run/path/marker/inode/repository/registration/detached-base/Git-pointer ownership and process quiescence before targeted deletion, never prune or prefix guessing.

Restart only converts leftover non-terminal records to INCOMPLETE through the approved owner-loss transition, retaining owned-worktree identity and recovery disposition. It does not resume, retry, attach, operate on old child PIDs, inspect old worktrees or automatically delete stale scenes. `recovery_required` blocks new admission for that patch; deleting a directory does not clear it. A hard-killed Bridge cannot guarantee termination of old children. Ambiguous ownership or a handoff guard remains fail closed for explicit controlled recovery. No cleanup tool or recovery scheduler is added. Completed results survive new sessions/restarts unchanged.

The first async implementation requires POSIX process-group supervision; Windows returns a safe unsupported error for the two new tools while retaining legacy behavior. Profile commands still execute with host-user permissions, not an OS sandbox. Validation never modifies the registered workspace with candidate files, mutates proposal lifecycle, or authorizes/invokes APPLY/COMMIT/push.

Verification combines existing domain/store/process/recovery tests with real disposable MCP stdio tests: short durable start, independent running queries, caller EOF followed by completion, terminal PASS/FAIL/INCOMPLETE, idempotent replay after profile replacement, corrupt/incompatible query errors, unchanged sync contract, exact fifteen-tool catalog, fresh-session retained query and SIGTERM/SIGKILL restart without duplicate execution or stale-site deletion. These local tests do not claim a cloud transport acceptance window.
