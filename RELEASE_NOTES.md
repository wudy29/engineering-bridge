# Release notes

## v1.4.4

v1.4.4 is a correctness release for validation process lifecycle, Codex app-server JSONL frame compatibility, DSH interruption preservation, and workspace canonical identity handling.

### Fixed

- Contain asynchronous validation stdin write failures and use bounded process-tree termination with SIGTERM followed by SIGKILL grace periods on timeout or stdin failure.
- Accept legal newline-terminated Codex app-server JSONL frames above 64 KiB up to a Bridge-owned 8 MiB raw-frame hard cap, while keeping the 64 KiB pre-response notification budget unchanged.
- Preserve an already-established DSH interruption result if the direct child exits while its POSIX process group is still alive.
- Refresh manual workspace canonical identities before root lookup and managed registration so a root that becomes canonicalizable cannot be registered under a second identity.
- Update the overlong unterminated JSONL regression fixture to exercise the new 8 MiB hard cap.

### Compatibility

- The 8 MiB raw-frame limit is a Bridge compatibility bound, not a Codex protocol specification maximum. Existing routing and controlled-write semantics are unchanged.

### Safety

- Frames above the 8 MiB hard cap still fail closed; existing JSONL/UTF-8 validation and bounded diagnostic/evidence handling remain in place.

### Verification

- The merged correctness candidate and post-merge `main` both passed GitHub Actions on Ubuntu and Windows Server 2025.

## v1.4.3

v1.4.3 hardens Codex app-server handling and Windows path portability while preserving v1.4.x routing compatibility and controlled-write safety.

### Added

- Add `ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY=explicit` as a Bridge-owned Codex routing hard gate. Each Codex invocation must provide both `model` and `reasoning_effort` before executable resolution or process start; missing or blank values return `CODEX_ROUTING_REQUIRED`. The default remains `inherit` for v1.4.x compatibility, and DSH behavior is unchanged.
- Add Windows Server 2025 CI coverage alongside Ubuntu.

### Fixed

- Harden Codex app-server JSONL and UTF-8 handling, RPC message validation, unsupported server-request rejection, and bounded, sanitized diagnostics and error classification.
- Preserve and correlate Codex thread and turn identity from app-server protocol events, and carry bounded in-progress and terminal executor diagnostics through task results.
- Isolate Windows-specific host assumptions in tests with local Git line-ending policy and explicit platform and path fixtures.
- Harden Windows workspace-root validation, path containment, and filesystem identity handling, including drive-root and ordinary UNC semantics and native realpath alignment.
- Update MCP onboarding assertions to compare native realpaths where required.

### Compatibility

- Invalid routing policy values fail Bridge startup. Explicit routing values continue through the existing Codex `model/list` and reasoning validation and are propagated to `turn/start`.
- Windows Server 2025 CI broadens automated coverage but is not comprehensive Windows certification; broader Windows environments and client combinations remain unclaimed.

### Safety

- On Windows environments where Node does not expose `fs.constants.O_NOFOLLOW`, affected ordinary-untracked-file controlled `COMMIT` fingerprinting remains fail-closed; v1.4.3 does not substitute a weaker open path or weaken existing security guarantees.

## v1.4.2

v1.4.2 is a correctness release for controlled initial commits in fresh Git repositories with no existing commit.

### Fixed

- Support controlled `COMMIT` for an applied proposal in a fresh/unborn Git repository, creating a root commit from exactly the proposal targets.
- Preserve proposal-target-only staging and leave unrelated untracked recovery anchors unchanged, untracked, and unstaged.
- Before creating the root commit, recheck the unborn state and expected branch ref so concurrent HEAD or ref creation is rejected.
- After creating the root commit, verify that it has no parent, contains exactly the proposal paths, and leaves the index and tracked worktree clean.
- If post-commit verification fails, report the failure without resetting, amending, or otherwise rewriting the commit that was already created.

### Compatibility

- Controlled `COMMIT` for repositories with a normal existing `HEAD` keeps the v1.4.1 semantics and safety boundaries unchanged.

## v1.4.1

v1.4.1 is an emergency correctness release for Windows-authored workspace configuration, active Codex turn liveness, and controlled-commit recovery safety.

### Fixed

- Accept a workspace configuration whose first character is one UTF-8 BOM (`U+FEFF`) while preserving strict JSON parsing; a second BOM and all other malformed JSON remain rejected.
- Reset the Codex inactivity watchdog on any app-server notification only when both `threadId` and `turnId` exactly match the active turn. Other threads, other turns, global notifications, and RPC responses cannot keep the turn alive.
- Preserve stable unrelated untracked recovery anchors during controlled `COMMIT`, stage and commit only exact proposal targets, reject pre-existing staged or unrelated tracked dirt, and leave history advanced rather than rewriting it if post-commit recovery-anchor verification fails.

### Windows operation notes

- A foreground `tunnel-client run` belongs to its PowerShell process; closing that PowerShell window terminates the foreground tunnel.
- Installing Codex Desktop does not guarantee that the `codex` CLI exists on the `PATH` inherited by the process that starts Bridge.
- Workspace registration controls which roots MCP callers may select. It is separate from filesystem read isolation: Bridge's read-only executor settings restrict writes but do not create an OS-level read sandbox.

## v1.4.0

v1.4.0 closes the supervised controlled-write loop while keeping publication outside Bridge.

### Added

- Add optional controlled-patch validation through `configure_validation_profile` and `validate_controlled_patch`. Validation runs only when explicitly requested, uses a fixed per-workspace profile in a temporary detached worktree, and reports `PASS`, `FAIL`, or `INCOMPLETE`; it does not authorize or imply `APPLY`.
- Add `commit_controlled_patch` as a separate exact `COMMIT` gate for an already-`APPLY`ed controlled patch. It creates one Git commit containing only that applied patch and never pushes.

### Release boundary

- The local STDIO MCP surface is now 13 tools.
- `APPLY` remains the explicit filesystem-mutation gate; `COMMIT` is a separate Git-history gate. Neither gate implies push or Release creation.
- Fresh-chat catalog verification confirmed all 13 tools, and a disposable controlled-COMMIT E2E confirmed that `APPLY` leaves HEAD unchanged and `COMMIT` alone advances HEAD while leaving the worktree clean.

## v1.3.0

v1.3.0 has been published as a Git tag and GitHub Release. This does not indicate npm publication.

### Added

- Add `submit_controlled_patch` for registering a caller-provided complete unified Git diff against the exact current `base_head`. Submission runs the shared read-only preflight, records `source: "submitted"` without an executor identity, survives restart, and still requires human review, write authorization, and exact `APPLY`.
- Let `generate_controlled_patch` and `refine_controlled_patch` select Codex or DSH per call (default Codex), while keeping application deterministic and model-free. Refinement does not inherit the source proposal's executor.
- Add optional Codex-only `model` and `reasoning_effort` inputs to `run_task`, `generate_controlled_patch`, and `refine_controlled_patch`; requested values are checked against Codex `model/list`. DSH rejects these options.
- Allow running generated or refined proposal tasks to be interrupted through `control_task`; interrupted tasks finish with `TASK_INTERRUPTED`.

### Fixed

- Bound executor termination across normal completion, interruption, direct-child exit, inherited open pipes, hard deadlines, and live Windows process trees so tasks settle without leaving the one-shot executor process tree running.
- Preserve the beginning and true end of oversized DSH stdout, including interrupted output, within the existing 1 MiB bound.
- Harden controlled-patch application recovery, serialize concurrent applications per workspace, and persist final applied metadata before releasing the retained task.
- Bound controlled-patch and onboarding Git subprocesses, preserve supported public error classifications, and finalize tasks when terminal-result handlers fail.

### Reliability / Performance

- Bound short Codex JSON-RPC calls to 30 seconds independently of the 15-minute executor deadline; active Codex turns also fail after two minutes without matching protocol activity.
- Restore retained controlled-patch tasks in one validated batch, eliminating repeated global terminal-retention scans while preserving task order and provenance.

The v1.2.1 Windows validation boundary is unchanged; full multi-client / all-Windows certification is not claimed.

## v1.2.1

v1.2.1 is a Windows launch-compatibility patch for both executors. The DSH executor itself was added in v1.2.0; v1.2.1 does not add an executor, it fixes how npm-installed Codex and DSH CLIs are resolved and launched on Windows.

### Windows CLI compatibility

- Fix Windows command resolution for npm-installed Codex and DSH CLIs.
- Standard Windows npm installs expose:

  ```
  codex.cmd
  dsh.cmd
  ```

- Bridge now resolves those npm shims to their official Node entrypoints:

  ```
  @openai/codex/bin/codex.js
  @deepseek-ai/dsh/lib/bin.js
  ```

- The launch path uses `process.execPath` + the JS entrypoint.
- A real `codex.exe` / `dsh.exe` remains directly supported and preferred.

### Safety

- No `cmd.exe` / `ComSpec` runtime path.
- No `shell: true`.
- The Codex instruction still travels through JSON-RPC stdin.
- The DSH instruction remains a single argv argument.
- Unresolved shim targets fail closed through the existing shell-free fallback chain.

### Verification

Validated on a real GitHub Actions `windows-latest` runner with Node 22 and actual npm-installed `@openai/codex` and `@deepseek-ai/dsh` packages.

Windows smoke confirmed:

- real `codex.cmd` and `dsh.cmd` layouts
- resolver discovery
- both official Node launchers start successfully
- focused executor tests pass

Windows compatibility improved and this specific npm CLI path is now verified; full multi-client / all-Windows-environment certification is not claimed.

## v1.2.0

v1.2.0 keeps the Codex behavior of v1.1.0 (including its default selection) and adds a second executor, managed workspace onboarding, restart persistence for controlled patches, and more honest task reporting.

### Executors

- `run_task` accepts an optional `executor: "codex" | "dsh"`; omitting it still defaults to `codex`, so existing calls are unchanged.
- DSH runs through the official headless interface, pinned to read-only per process (`DSH_PERMISSION_MODE=read-only`); the bridge forwards only an explicit environment allowlist, including `DEEPSEEK_API_KEY` and `DSH_TOOLS_MODE`, and never forwards proxy variables.
- DSH returns a legitimate empty output for a successful run with no agent text, and an interrupted DSH task keeps its real partial stdout as `partial_output`.

### Workspace onboarding and write authorization

- New `project_root` configuration entries define approved root directories.
- `bind_project` registers an existing directory inside a `project_root` after exact `BIND` confirmation.
- `create_project` creates and git-initializes a new directory inside a `project_root` after exact `CREATE` confirmation (the repository is left unborn; no commit is made).
- Managed workspaces are registered read-only by default. `authorize_workspace_write` grants controlled-write permission to a managed workspace only, after exact `AUTHORIZE` confirmation.
- Manual workspaces from `workspaces.json` remain authoritative for their own `allow_write`; `AUTHORIZE` never modifies a manual entry.

### Controlled patches

- `generate_controlled_patch` and `refine_controlled_patch` are read-only proposals and work in any registered workspace; no write authorization is needed to generate or refine.
- Write authorization (managed `AUTHORIZE` or a manual `allow_write: true` entry) is required only at `apply_controlled_patch` with exact `APPLY`.
- Controlled-patch proposals and applied history now survive a bridge restart; invalid retained records are quarantined safely instead of blocking startup.
- Unborn repositories (for example, fresh `create_project` workspaces) are supported: proposals may add ordinary 100644 text files. The bridge still never stages, commits, or pushes.

### Honest task reporting

- `task_result` reports the fixed `executor` and, for Codex tasks, the real native app-server thread id. DSH has no machine-resumable headless session, so it never gets a fabricated thread id; a DSH `continue` starts a new execution.
- `partial_output` appears only when a genuine interrupt produced real partial output; the task still ends `failed`, and ordinary failures never re-expose stderr or partial stdout.
- Codex evidence truncation is now visible: oversized strings are marked `[truncated]`, oversized change lists report how many changes were omitted, and evidence evicted by the count limit is reported through a synthetic drop item. Bounds are unchanged; the markers only say the diagnostic information is incomplete.

### Not changed

- The Codex default path, controlled-`APPLY` validation, and safety checks from v1.1.0 are unchanged; the bridge still never automatically tests, stages, commits, pushes, or releases.

## v1.1.0

v1.1.0 adds `refine_controlled_patch` for refining an existing completed controlled-patch proposal into a new complete proposal against the same `base_head`, preserving the source proposal and still requiring explicit `APPLY` before workspace modification.

## v1.0.0

controlled APPLY now accepts valid Codex-generated patches with Markdown fence context, stale hunk counts, and zero-context hunks, while retaining existing workspace, target, and explicit APPLY safeguards.

## v1.0.0-rc.2

Failed Codex turns with `codexErrorInfo=serverOverloaded` are surfaced as a clear model-capacity failure instead of only the generic `CODEX_EXECUTION_FAILED` message. Raw upstream error details remain hidden.

## 1.0.0 stable

This stable V1 release exposes five STDIO MCP tools: `run_task`, `task_result`, `control_task`, `generate_controlled_patch`, and `apply_controlled_patch`. Ordinary `run_task` execution is always read-only. Successful interactive turns enter `waiting_for_supervisor_review`; `task_result` exposes state/readiness, bounded evidence, and `review_output` before acceptance, then final `output` or `error` after finalization. `control_task` is restricted to interactive `run_task` task IDs and state-checks `continue`, `steer`, `interrupt`, and `accept`. Continue preserves native Codex thread continuity; interrupt is available only while an interactive task is running and finalizes it as failed.

Controlled patch generation remains on the legacy proposal-task path. Poll its returned patch task ID through `task_result` until `state=completed`, when the unified diff is returned as `output`. Proposal tasks do not enter `waiting_for_supervisor_review`, do not expose `review_output`, and cannot be accepted through `control_task`. Human review occurs outside task state; an acceptable completed diff is passed directly to `apply_controlled_patch` with that `patch_task_id` and exact `APPLY`.

The Codex backend uses `codex app-server --stdio` without a shell, with approval `never` and network disabled. Ordinary/supervisor tasks and proposal generation stay read-only; exact reviewed `APPLY` is the filesystem write path. Bridge does not automatically test, stage, commit, or push. State is process-local with no restart recovery or automatic timeout; explicit interruption exists only for running interactive tasks. Alpha.4 project binding is not implemented, so `workspace_id` remains required.

This is the stable V1 / 1.0.0 release. It does not indicate npm publication.

## v0.2.0-alpha.3 release candidate

This release candidate reduces the public STDIO MCP interface to four tools: `run_task`, `task_result`, `generate_controlled_patch`, and `apply_controlled_patch`. `task_result` is now the single polling tool and reports active tasks with `ready: false`, completed output, or a fixed safe error. Serialized errors contain exactly `code` and `message` while preserving the existing error codes and non-leakage behavior.

Controlled patches may continue to modify existing tracked regular text files and may now add an ordinary text file when the diff uses exact `new file mode 100644` and matching `/dev/null` headers, contains a text hunk, and targets a safe path absent from base HEAD, the current index, and the worktree. Deletions and other unsafe patch forms remain rejected. Documentation has been reduced and aligned with this interface and behavior.

This is a release candidate description only. It does not assert that a v0.2.0-alpha.3 tag, GitHub Release, or npm publication exists.

## v0.2.0-alpha.2

Engineering Bridge v0.2.0-alpha.2 adds opt-in controlled writes while keeping every workspace read-only by default. A write-enabled clean Git workspace can generate a patch proposal without changing files; application requires human review and confirmation exactly equal to `APPLY`. Bridge rechecks repository state and patch targets before applying, and never automatically tests, stages, commits, or pushes.

This release also compares canonical real paths during controlled-write Git-root validation, so macOS aliases such as `/tmp` and `/private/tmp` no longer cause the same directory to be rejected. The English and Chinese READMEs explain client compatibility, component roles, a generic STDIO MCP configuration, a reproducible first read-only run, and the complete controlled-write flow. The architecture, security, threat-model, and tool-reference documents are aligned with the current implementation.

Current limits remain: no cancellation or timeout, no persistence across restart, no caller authentication or remote service, and no OS-level read containment for ordinary read-only tasks. Every proposal still requires human review.

This version has been published as a Git tag and GitHub Release.
