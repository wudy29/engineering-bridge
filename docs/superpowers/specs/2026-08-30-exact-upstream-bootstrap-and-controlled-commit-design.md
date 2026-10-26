# Exact-Upstream Bootstrap and Controlled COMMIT Design

Date: 2026-08-30

## Design status

Approved architecture for Engineering Bridge at baseline
`ec5f2f9c2fc4b5b3778c17f2c48497182bf80771`
(`fix: close final validation deadline edges`).

This specification adds two separate controlled write capabilities:

1. exact-upstream bootstrap for an already-created managed empty/unborn workspace;
2. controlled COMMIT for an already-APPLYed controlled-patch proposal.

They share existing workspace and bounded-Git primitives, but they are not one workflow
and they never grant one another's authority. PUSH is explicitly out of scope.

## 1. Gate model

Engineering Bridge keeps one explicit gate per authority boundary:

- `CREATE` creates and registers an empty Git repository.
- `AUTHORIZE` grants persistent controlled-write permission to a managed workspace.
- `BOOTSTRAP` authorizes one exact-upstream import into that already-created empty workspace.
- `APPLY` writes one reviewed controlled-patch proposal to the worktree.
- `COMMIT` creates one Git commit containing only that already-applied proposal.
- `PUSH` remains a separate future capability and is not designed here.

No gate implies, chains into, or automatically performs another gate.

## 2. Existing primitives to reuse

The implementation must stay inside the current architecture and reuse:

- `RegisteredWorkspaceRegistry` for canonical workspace resolution and `resolveWritable()`;
- `ManagedWorkspaceCatalog` for the existing managed-workspace identity and durable registration;
- `WorkspaceOnboardingService` as the owner of managed-project onboarding operations;
- `runBoundedGit()` for every Git subprocess, preserving `shell:false`, bounded output,
  execution deadlines, TERM-to-KILL cleanup, and fixed argv;
- the controlled-patch service's existing exact-base, clean-workspace, proposal-state,
  changed-path, reverse-apply, and per-workspace serialization patterns where applicable.

Narrow helper extraction is allowed when it removes duplicated verification logic.
Do not introduce a generic `GitService`, `RemoteManager`, `BootstrapManager`, new background
service, second tunnel, or alternate workspace registry.

## 3. `bootstrap_project`

### 3.1 Public surface

The new MCP tool is:

```text
bootstrap_project({
  workspace_id,
  upstream_url,
  commit_sha,
  branch?,
  confirmation: "BOOTSTRAP"
})
```

`create_project` remains unchanged: it only creates/registers an empty Git repository and
leaves it unborn. Bootstrap is a sibling onboarding operation, not an extension of CREATE.

### 3.2 Preconditions

Before any network or mutating Git operation, bootstrap must prove:

- confirmation is exactly `BOOTSTRAP`;
- `workspace_id` resolves to an existing managed workspace;
- the workspace still has controlled-write authorization;
- the canonical workspace root remains inside its approved boundary;
- the repository is unborn;
- the target directory is truly empty except for the repository metadata required by the
  existing empty Git repository;
- there are no unrelated user files to overwrite or preserve by guessing.

Existing born, non-empty, dirty, manually registered, or otherwise ineligible workspaces
must fail closed. Bootstrap v1 does not support re-bootstrap or migration.

### 3.3 Input contract

`upstream_url`:

- must be explicit `https://`;
- must not contain userinfo/embedded credentials;
- must not contain whitespace or control characters;
- must not be accepted as free-form shell or Git argv text;
- does not create a public remote-management capability.

`commit_sha`:

- must be a full exact Git object id;
- accepts exactly 40 hexadecimal characters for SHA-1 repositories or exactly
  64 hexadecimal characters for SHA-256 repositories;
- rejects abbreviated and intermediate-length object ids;
- never accepts `main`, `latest`, tags, symbolic refs, or any floating ref.

Optional `branch`:

- is a local branch only;
- may contain normal Git branch separators such as `/`;
- must be validated fail-closed with Git-native ref validation such as fixed-argv
  `git check-ref-format --branch`;
- must not be interpreted as arbitrary command text.

Bootstrap v1 does not support submodules, credentials, tags, floating branches,
private-repository authentication, host allowlists, or arbitrary Git options.
A host allowlist may be designed later only if real evidence requires it.

### 3.4 Atomicity: prepare -> verify -> swap

Bootstrap must not fetch directly into the registered real workspace.

The approved transaction is:

```text
real managed target
  -> prove writable + unborn + empty
  -> prepare temporary repository under the same approved parent/filesystem
  -> populate staging from explicit HTTPS URL and exact SHA
  -> checkout exact SHA
  -> optionally create local branch at exact SHA
  -> verify staging completely
  -> swap verified repository into the still-empty registered root
  -> verify final root again
```

The staging Git sequence must use only fixed argv through `runBoundedGit()`.
The exact internal sequence may use `git init` plus exact-SHA fetch, or an equivalent
bounded Git sequence, but it must not expose `fetch`, `checkout`, `remote`, or arbitrary
Git as public tools.

The prepared repository must be verified before swap:

- canonical top-level is the expected staging root;
- `HEAD` byte-equals `commit_sha`;
- if a local branch was requested, that branch ref resolves exactly to `commit_sha` and
  the current checked-out branch is exactly the requested branch;
- worktree and index are clean;
- the requested commit is present and checked out;
- no unnecessary persistent remote remains configured in the final repository.

Only after every check passes may the prepared repository replace the original empty target.
The workspace keeps the same `workspace_id` and canonical root; bootstrap does not create
a second workspace identity or re-register a different root.

### 3.5 Failure semantics

Before swap, every failure leaves the real registered target unchanged.

Failures include invalid input, authorization loss, network failure, missing requested SHA,
Git failure, verification mismatch, dirty staging state, or invalid branch state.

Temporary preparation artifacts must be cleaned best-effort with bounded cleanup.

Swap must be fail-closed. If replacement cannot complete, Bridge must retain or restore the
original empty target where possible and must not report bootstrap success unless final
verification at the registered root passes.

Bootstrap success returns the existing workspace identity plus the exact resulting commit
and optional branch. When `branch` is supplied, the final registered workspace is checked
out on that branch and `HEAD` still byte-equals `commit_sha`. It never commits, pushes,
pulls, updates, or manages remotes.

## 4. `commit_controlled_patch`

### 4.1 Public surface

The controlled COMMIT tool is:

```text
commit_controlled_patch({
  patch_task_id,
  message,
  confirmation: "COMMIT"
})
```

This is a general Engineering Bridge capability, not an Ombre-Brain-specific tool.

It operates only on a retained controlled-patch proposal that has already completed exact
`APPLY`. It never belongs to bootstrap: bootstrap must end with `HEAD` exactly equal to the
requested upstream SHA, while COMMIT necessarily advances repository history.

### 4.2 Preconditions

Before staging anything, COMMIT must prove:

- confirmation is exactly `COMMIT`;
- the retained proposal exists;
- proposal state is exactly `applied`;
- workspace controlled-write authorization is still valid;
- canonical workspace identity/root still match the proposal;
- current `HEAD` still equals the proposal's original base HEAD;
- index is initially clean;
- current tracked worktree changes and patch-added untracked targets correspond exactly to
  the retained proposal's `changed_paths`;
- no unrelated tracked or staged path exists;
- any pre-existing unignored untracked path outside `changed_paths` has been enumerated at
  file level under the workspace lock and safely fingerprinted; regular files require stable
  type/stat metadata plus a streamed content digest, symlinks require stable link text, and
  unsupported special files fail closed;
- ignored paths remain outside this recovery-anchor snapshot;
- tracked gitlink worktrees are scan boundaries: the special-path scanner does not recurse into
  them or apply superproject ignore rules to their contents;
- no unrelated path can enter the commit, and no snapshotted unrelated untracked path may be
  observed as added, removed, modified, or replaced at a later verification checkpoint;
- the applied proposal content is still present, using the retained proposal output and
  reverse-apply or an equivalent fail-closed verification.

Any ambiguity or unrelated dirt makes COMMIT fail closed.

### 4.3 Commit message

`message` is required and must be:

- trimmed;
- non-empty;
- single-line;
- bounded in length;
- passed as data, never shell syntax.

The controlled commit must not modify Git configuration to manufacture identity.
Missing author/committer identity fails closed.

The invocation must disable or otherwise avoid repository hooks, automatic signing,
credential prompts, editors, or other interactive/ambient execution that would turn
COMMIT into a generic code-execution surface.

### 4.4 Staging and commit

COMMIT runs under the same per-workspace serialization boundary used for APPLY, or a
narrowly shared successor that provides the same exclusion guarantee.

The allowed sequence is:

```text
revalidate applied proposal and workspace
  -> prove index clean
  -> separate tracked targets, patch-added untracked targets, and unrelated untracked paths
  -> snapshot pre-existing unrelated untracked paths under the workspace lock
  -> prove controlled dirty path set == proposal changed_paths
  -> stage the exact retained patch into the index
  -> re-read index
  -> require staged path set == exact allowlist
  -> require tracked worktree content == staged retained patch content
  -> reverify unrelated untracked path set and fingerprints
  -> fixed non-interactive git commit
  -> read and verify new HEAD, commit metadata, clean index/tracked targets, and the unchanged
     unrelated untracked snapshot
  -> return commit SHA
```

No path outside the retained proposal allowlist may be staged.

COMMIT creates exactly one new commit and never pushes.

`APPLY` remains unchanged: APPLY alone must never stage or commit.

### 4.5 Failure semantics

Wrong gate, wrong proposal state, lost authorization, changed base HEAD, unrelated tracked or
staged dirt, unsafe untracked state, any change to the unrelated-untracked snapshot, invalid
message, missing Git identity, failed staging, failed commit, hook/signing/interactive
requirements, or post-commit verification mismatch must fail closed.

Here, fail closed describes the returned verification result, not an atomic Git-history or
filesystem rollback. If `git commit` succeeds but a final recovery-anchor verification fails,
COMMIT returns `WORKSPACE_PRECONDITION_FAILED` while `HEAD` remains advanced to the new child
commit. Bridge does not reset, rewrite, or otherwise roll back that commit. A retry of the same
retained proposal then fails the original-base-HEAD precondition without creating another commit.

If staging succeeds but commit fails, Bridge must leave the repository in an observable,
bounded state and must not silently widen the staged set. Cleanup may reset only the staging
operation Bridge just performed and must not discard worktree content or unrelated user data.

This design does not add a `committed` proposal lifecycle state, new proposal persistence
subsystem, amend/rebase/tag/history rewriting, or generic Git executor. If later evidence
shows durable commit metadata is required, that is a separate design decision.

## 5. Threat model and authority boundaries

The new surfaces must preserve these invariants:

- no arbitrary shell;
- no caller-provided Git argv passthrough;
- no public `fetch`, `pull`, `checkout`, `remote`, `add`, or `commit` primitive;
- no floating upstream selection;
- no overwriting a non-empty workspace;
- no network action before input/boundary/authorization validation;
- no hidden push;
- no commit before APPLY;
- no commit of unrelated dirty/staged/untracked files;
- no automatic Git config mutation;
- no hooks/signing/editor side execution in controlled COMMIT;
- bounded Git process lifetime and output on every subprocess;
- exact post-operation verification before success is visible.

## 6. TDD contract

Implementation follows RED -> GREEN -> regression verification.

### 6.1 Bootstrap RED coverage

At minimum:

1. wrong/missing `BOOTSTRAP` fails before Git/network;
2. missing write authorization fails;
3. manually registered or otherwise non-managed workspace fails;
4. born, non-empty, or dirty target fails;
5. invalid HTTPS URL, userinfo, whitespace/control, or option-like input fails pre-network;
6. abbreviated, malformed, 41-63-character, or empty SHA fails pre-network;
7. invalid branch fails pre-network;
8. approved-root or symlink escape fails;
9. network/fetch failure cleans staging and leaves real target unchanged;
10. requested SHA unavailable fails closed;
11. prepared HEAD mismatch fails;
12. branch-ref mismatch fails;
13. dirty staging repository fails;
14. swap failure leaves/restores the original empty target and reports failure;
15. success proves final registered root, exact HEAD, requested branch is currently checked
    out, clean state, and no unintended persistent remote;
16. recorded Git invocations prove no pull, push, generic remote management, or shell surface.

### 6.2 COMMIT RED coverage

At minimum:

1. wrong/missing `COMMIT` fails;
2. non-applied/unknown proposal fails;
3. missing write authorization fails;
4. base HEAD changed fails;
5. pre-existing staged content fails;
6. unrelated tracked or staged dirt fails, while stable pre-existing unrelated untracked files
   are preserved and cannot enter the commit;
7. invalid message fails;
8. only proposal `changed_paths` are staged;
9. applied proposal content must still match retained proposal;
10. hooks/signing/interactive execution is disabled or rejected;
11. missing Git identity fails without modifying config;
12. commit failure has bounded cleanup and preserves worktree content;
13. success advances HEAD by exactly one commit and returns that SHA;
14. no push is invoked;
15. regression: APPLY by itself still never stages or commits.
16. modifying, deleting, replacing, or adding an unrelated untracked path during COMMIT fails
    closed, and patch-added untracked targets remain controlled proposal paths rather than
    recovery-anchor snapshot entries.
17. if the commit succeeds but final recovery-anchor verification fails, the call returns
    `WORKSPACE_PRECONDITION_FAILED` while HEAD remains the one new child commit containing exactly
    the proposal paths, the index and tracked worktree are clean, and retry creates no commit.
18. an existing tracked gitlink worktree is a special-path scan boundary; COMMIT does not recurse
    into it with superproject ignore rules.

## 7. Rejected alternatives

### Extend `create_project`

Rejected because CREATE currently means local directory creation plus `git init` and an
unborn result. Adding network import would conflate distinct authority and falsify the
existing result/confirmation contract.

### Fetch in place into the real empty workspace

Rejected because network or checkout failure could mutate the registered repository before
the exact SHA is verified. Prepare -> verify -> swap gives stronger failure isolation at the
cost of modest filesystem choreography.

### Two-phase bootstrap state machine

Rejected because URL, exact SHA, branch, workspace, and confirmation already fully determine
the operation. A pending-bootstrap state, TTL, or extra confirmation artifact adds lifecycle
state without a demonstrated need.

### Generic Git passthrough

Rejected because it would turn one narrow bootstrap blocker into a broad Git execution
surface and undermine the existing fixed-argv, explicit-gate security model.

## 8. Explicit non-goals

Out of scope:

- PUSH;
- pull/update/sync;
- public fetch/checkout/remote APIs;
- generic Git wrapper or arbitrary shell;
- remote-management UI/API;
- credentials or private-upstream authentication;
- floating tags/branches/latest selection;
- recursive submodule bootstrap or controlled-patch changes to gitlinks (an existing tracked
  gitlink worktree remains a COMMIT scan boundary);
- re-bootstrap or migration of existing workspaces;
- workspace lifecycle refactor;
- new task/proposal state machine;
- new persistence subsystem;
- background worker/service/scheduler/watchdog;
- additional tunnel or deployment topology;
- executing the Ombre-Brain bootstrap itself.

This specification changes Engineering Bridge only. It does not modify or operate on
a private downstream workspace.
