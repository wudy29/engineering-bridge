# Release notes

## Engineering Bridge v1.6.1 — release candidate / 发布候选

This patch candidate preserves the 15-tool wire definitions and explicit write gates. It is not a tag, npm publication, merge or deployment. The initialization version is 1.6.1; tool names, descriptions, input schemas, defaults, annotations and execution fields remain equal to the complete v1.6.0 tool snapshot.

### 修复与安全边界

- **F01 / F02：受控 Git 写入。** 按字面身份验证路径，保留特殊文件名与原文件类型限制；从已批准内容构建提交 tree，使用 expected-old ref 事务发布并保护共享 index。最后并发窗口不能把外部写入提交为已批准补丁。不重写历史、不接纳任意新 HEAD、不自动删除未知锁。
- **F03–F05：进程与停机。** 收束 DSH exit/close 竞态及所属 POSIX 后代；POSIX 旧同步验证在监督进程未静止时不返回 PASS 或不安全清理。OS shutdown 同步关闭准入、有界排空普通任务与验证。COMMIT publisher、引用发布结果及共享 index 收尾纳入同一关闭过程，结果不确定时保留恢复阻断。EOF/普通请求取消不升级为全局停机。
- **F06：长超时。** 用 BigInt 与单调期限分段调度，单段不超过 Node 定时器上限；合法正整数域、默认值、取消和清理语义保留，不静默截断或立即误超时。
- **M01：验收门。** 保留完整 raw 15-tool 快照、既有 Git 安全/生命周期回归及真实安装检查。统一发行验收由 Ubuntu 锁定构建产出一个 tgz，再消费同一原字节；每个平台自产包不能代替这一门。

**Windows 功能限制是本版本的明确行为变更。** 对已知提案，旧同步 `validate_controlled_patch` 现在返回 `INCOMPLETE`、`reason: "unsupported_platform"`、`steps: []` 和 `cleanup: "success"`，不会读取 profile、执行 Git preflight、创建临时工作树或启动验证命令。cleanup 表示没有创建资源，并非已证明后代静止；此 reason 在 Windows 优先于 profile 缺失和 unborn 原因。未知/无效提案仍保持原错误。Windows async 继续返回 `VALIDATION_PLATFORM_UNSUPPORTED`。配置 profile、其他工具、POSIX 同步及异步合同不因该限制改变。旧调用者应明确处理非 PASS，不能继续依赖 Windows 验证执行。

### Fixes and compatibility

- F01/F02 verify literal Git path identity and commit exactly the approved tree through an expected-old ref transaction, preserving shared-index recovery and external modifications. There is no unsafe fallback, history rewrite or automatic unknown-lock removal.
- F03–F05 bound DSH exit/close handling and owned POSIX descendants, require quiescence for supported synchronous validation, and close admission/drain active work on OS shutdown. COMMIT publishing, ref disposition and index completion participate in shutdown. Ambiguous outcomes retain recovery barriers. Caller EOF or ordinary request cancellation is not global shutdown.
- F06 uses monotonic BigInt deadlines with bounded timer chunks, preserving the positive integer input domain, defaults, cancellation and cleanup. M01 retains full raw tool-schema and real single-package installation gates.
- **Windows synchronous validation execution is deliberately disabled.** A known proposal returns the original report shape with `INCOMPLETE` / `unsupported_platform`, empty steps and no-op successful cleanup before any profile access, validation Git command or temporary resource. This reason takes precedence over missing profiles/unborn bases on Windows. Unknown/invalid proposal errors remain unchanged. Async Windows validation remains unsupported. Profile configuration, other Windows tools and POSIX validation remain available under their existing contracts. Old callers must handle this non-PASS result; this release does not preserve the old Windows execution capability.

### Evidence and limits / 验收与限制

The predecessor `19e32a50f8e11e53a68a4956970432e7559deb98` passed [ordinary native CI 42362379348](https://github.com/wudy29/engineering-bridge/actions/runs/42362379348) on Ubuntu/Node22, macOS/Node24 and Windows/Node22. That evidence belongs to the predecessor. Acceptance of this candidate must identify its new tree, one v1.6.1 tarball SHA, installed bytes, native entry points including Windows `.cmd`, raw tool schema, Windows refusal and supported POSIX validation. A green job does not override documented platform skips. No real CLI account or production deployment acceptance is implied.

本轮沿用基线锁定的依赖图，仅调整根版本；实际 lock 包含 `@modelcontextprotocol/sdk` 1.32.2、`zod` 4.6.7。下方 v1.6.0 的 1.31.0 升级叙述是早期历史说明，不是当前 lock 的解析结果。The reviewed dependency graph is unchanged; only root versions change. Consumer installation tests use that lock graph, while ordinary unpinned npm consumers still resolve the declared ranges.

历史异步 INCOMPLETE、fake 额外 TERM、限时与 Mac 共享挂载 UNKNOWN 继续保留，没有以本轮绿灯追溯定因。Historical async INCOMPLETE, fake extra TERM, timing and Mac shared-mount UNKNOWN records remain unresolved. OS termination refusal, hard SIGKILL/power loss and existing COMMIT recovery boundaries remain; no automatic restart recovery, retry, APPLY, COMMIT, push or deployment is added.

## Engineering Bridge v1.6.0

Add a Chinese read-only dashboard and best-effort task observations, retain the reviewed Codex compatibility and pre-interrupt diagnostic fixes, and refresh the dependency lockfile. This version identifies a release candidate; it does not imply a commit, tag, GitHub Release, npm publication or deployment.

### Dashboard and observations

- Keep the Chinese HTML in TypeScript so a fresh build produces the accepted dashboard. Producer heartbeats and selected task metadata are stored separately from canonical execution state in `<config>.observations/`; failures of this optional sink do not change task execution.
- Show only fresh-producer `queued`/`running` tasks as current. Review, ended and stale/unknown-producer history have separate collapsed groups; historical observations do not claim a currently confirmable task or restore control after restart.
- Support explicitly public, validated task titles and workspace display names. Missing titles fall back to project, executor and short task ID; private instructions, output, evidence and diagnostics are not title sources.
- Add browser-local clear/restore display controls that survive polling/reload. They hide earlier review/ended cards, never change task status or delete disk records. No automatic disk-history eviction is included.
- Serve only read-only GET routes on loopback HTTP, with Host checks and no-store responses. This is neither remote MCP nor an authenticated service; do not forward or publicly expose the listener.

### Codex compatibility and diagnostics

- Preserve PATH-first command resolution; on POSIX, a missing executable may fall back to an executable regular `HOME/.local/bin/codex` only with an absolute HOME. Windows native/npm-shim and DSH launch paths remain unchanged and shell-free.
- Retain bounded error-notification timing/scope/retry summaries and freeze the first local interrupt's diagnostic snapshot. Later errors cannot rewrite it. Raw error text, details and IDs are excluded; task/interrupt semantics and timeout values are unchanged. These process-local task-result fields are not published to the dashboard.

### Dependency security and packaging

- Lock only the six reviewed dependency updates within existing ranges: `@modelcontextprotocol/sdk` 1.30.0 → 1.31.0; `fast-uri` 3.1.5 → 3.1.8; `hono` 4.12.34 → 4.13.7; `ip-address` 10.4.0 → 10.7.1; `proxy-addr` 2.0.7 → 2.0.8; `qs` 6.15.3 → 6.16.0. No overrides, major upgrades or dependency-range changes.
- Set package and lockfile root versions to 1.6.0; retain the existing package file rules.
- Remove the duplicate CI Build step: `npm test` already performs a fresh build. Preserve the Ubuntu/Windows Server 2025 matrix and test/build capability.

### Safety and verification boundary

- The 15-tool MCP surface, explicit write gates, executor deadlines, read-only defaults, observation privacy and retained validation behavior remain unchanged.
- Candidate verification records fresh install, full/production audits, typecheck, build, focused/full tests, local Chrome acceptance and package-scope inspection separately from publication. Audit counts are time-specific and should be checked again at the next release gate.
- Native CI passed on Ubuntu and Windows Server 2025 in both [push CI](https://github.com/wudy29/engineering-bridge/actions/runs/39513363458) and [PR CI](https://github.com/wudy29/engineering-bridge/actions/runs/40260052738). Both runs correspond to head SHA `77e21d6efebc59fb73164e4162f46964172864a0`. These results do not constitute comprehensive Windows platform certification or production deployment acceptance.

## Engineering Bridge v1.5.0

Add retained async controlled-patch validation without changing the original synchronous API. A potentially long validation no longer requires one MCP call to remain open until all steps finish.

### Added

- `start_controlled_patch_validation(patch_task_id, idempotency_key)` durably admits a run before execution and returns its identity promptly.
- `get_controlled_patch_validation(validation_run_id)` independently queries bounded retained progress and PASS/FAIL/INCOMPLETE results, with safe unknown/corrupt/incompatible errors. Catalog: 13 → 15 tools.
- Independent immutable proposal/profile identities, caller-key replay, a private atomic run store, single service ownership, supervised process-group termination and ownership-verified normal worktree cleanup.
- Startup converts interrupted non-terminal runs to INCOMPLETE; terminal results survive new MCP sessions and Bridge restart without execution. Stale worktree identity and recovery fences are preserved.

### Compatibility and safety

- `validate_controlled_patch` keeps its original input, synchronous report and service; old callers need no schema migration. Long validation should use start/query, saving the key and run id. Refresh the connector catalog after installing the updated build.
- Async v1 requires POSIX process-group supervision. Windows and unsafe/unavailable async storage/ownership return safe async errors while legacy tools remain available. Config/state must be outside repositories, registered workspaces and approved onboarding roots; there is no automatic config migration.
- Caller disconnect does not cancel a run while Bridge remains alive. A launcher that kills Bridge invokes shutdown/crash semantics. Restart does not resume/retry/attach, signal old children or visit/delete stale worktrees. Hard crashes can leave children or forensic state requiring later explicit controlled recovery; deleting paths does not clear `recovery_required`.
- No command injection surface, process journal, background queue, cleanup/history tool, automatic APPLY/COMMIT/push, or repository-controlled executable profile is added. Existing timeouts, bounded output, persistence fail-closed and controlled-write gates remain in place.

### Verification

- Disposable real MCP stdio tests cover short admission/query, caller EOF continuation, retained results across restart, SIGTERM/SIGKILL disposition, no duplicate execution, stale-site preservation, strict schemas and old synchronous compatibility, alongside domain/store/lifecycle regression.
- This release does not claim a production deployment, cloud/tunnel acceptance, tag, GitHub Release or npm publication.

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
