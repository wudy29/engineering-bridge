import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";

import { CoreError } from "../core/errors.js";
import { serializeError } from "../core/errors.js";
import {
  runBoundedGit,
  type GitProcessOptions,
  type GitProcessResult,
  type GitStarter
} from "../executors/bounded-git-process.js";
import { isId } from "../core/ids.js";
import type { Id } from "../core/ids.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import {
  RegisteredWorkspaceTaskService,
  type ControlledPatchTaskRestore,
  type ExecutorName
} from "./registered-workspace-task-service.js";

export type { GitStarter };

export type ProposalBase =
  | { readonly kind: "commit"; readonly head: string }
  | { readonly kind: "unborn" };

export interface ControlledPatchValidationProposal {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly baseHead: string | null;
  readonly patch: string;
}

type Proposal = {
  workspaceId: string;
  workspaceRoot: string;
  base: ProposalBase;
  state: "proposed" | "applying" | "applied" | "recovery_conflict";
  parentTaskId: Id | undefined;
  // Undefined only for caller-submitted proposals (persisted as
  // source: "submitted"); executor-produced proposals always carry a real
  // codex/dsh identity.
  executor: ExecutorName | undefined;
  output: string | undefined;
};

type RetainedProposal = Proposal & { taskId: Id; output: string };
type RetainedState = { proposals: RetainedProposal[]; appliedTaskIds: Id[] };

const CONTROLLED_PATCH_STATE_VERSION = 1;
const MAX_APPLIED_PROPOSAL_HISTORY = 100;

const PATCH_INSTRUCTION = (changeRequest: string, base: ProposalBase): string => {
  const scope = base.kind === "unborn"
    ? "The workspace is a newly created Git repository with no commits yet (unborn repository state). There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are preparing a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Change request:
${changeRequest}`;
};

const REFINEMENT_INSTRUCTION = (base: ProposalBase, sourceDiff: string, changeRequest: string): string => {
  const baseClause = base.kind === "commit"
    ? `Output a COMPLETE final unified diff relative to the SAME original base_head ${base.head}, not an incremental patch against the source proposal.`
    : "The workspace is a newly created Git repository with no commits yet (unborn repository state); the refined proposal must still only add ordinary text files using new file mode 100644, and must remain relative to the same unborn base.";
  const scope = base.kind === "unborn"
    ? "There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are refining a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Treat the source proposal below as the reviewed baseline. Fix only the requested issues and preserve all unrelated proposal semantics. ${baseClause} Do not redo the original task.

Complete source proposal diff:
${sourceDiff}

Refinement request:
${changeRequest}`;
};

export class ControlledPatchService {
  private readonly proposals = new Map<Id, Proposal>();
  private readonly applyQueues = new Map<string, Promise<void>>();
  private appliedProposalTaskIds: Id[] = [];
  private persistenceQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly tasks: RegisteredWorkspaceTaskService,
    private readonly startProcess: GitStarter = spawn,
    private readonly stateFilePath?: string,
    private readonly gitProcessOptions: GitProcessOptions = {}
  ) {}

  async load(): Promise<void> {
    if (this.stateFilePath === undefined) return;
    if (this.proposals.size !== 0) throw new CoreError("INTERNAL_ERROR");
    let source: string;
    try {
      source = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CoreError("INTERNAL_ERROR");
    }

    let retainedState: RetainedState;
    try {
      // Global failures (unreadable JSON, bad envelope/version, invalid
      // applied_task_ids, identity ambiguity, applied-history contradictions)
      // still fail the whole load; only per-record problems are quarantined
      // inside parseRetainedState.
      retainedState = parseRetainedState(JSON.parse(source), this.registry);
    } catch {
      throw new CoreError("INTERNAL_ERROR");
    }

    const appliedProposalTaskIds = new Set(retainedState.appliedTaskIds);
    const restoredProposals: Array<readonly [Id, Proposal]> = [];
    const restoredTasks: ControlledPatchTaskRestore[] = [];
    let reconciledApplyingProposal = false;
    for (const { taskId, output, ...proposal } of retainedState.proposals) {
      let restoredState = proposal.state;
      if (proposal.state === "applying") {
        reconciledApplyingProposal = true;
        if (await this.applyCheck(proposal.workspaceRoot, output, false)) {
          restoredState = "proposed";
          appliedProposalTaskIds.delete(taskId);
        } else if (await this.applyCheck(proposal.workspaceRoot, output, true)) {
          restoredState = "applied";
          appliedProposalTaskIds.add(taskId);
        } else {
          restoredState = "recovery_conflict";
          appliedProposalTaskIds.delete(taskId);
        }
      }
      restoredProposals.push([taskId, { ...proposal, state: restoredState, output }]);
      const provenance = proposal.executor === undefined
        ? { executor: undefined, source: "submitted" as const }
        : { executor: proposal.executor };
      restoredTasks.push(restoredState === "recovery_conflict"
        ? {
          result: {
            id: taskId,
            state: "failed",
            error: serializeError(new CoreError("APPLY_RECOVERY_CONFLICT"))
          },
          pinned: false,
          ...provenance
        }
        : {
          result: { id: taskId, state: "completed", output },
          pinned: restoredState !== "applied",
          ...provenance
        });
    }
    this.tasks.restoreControlledPatchTasks(restoredTasks);
    for (const [taskId, proposal] of restoredProposals) this.proposals.set(taskId, proposal);
    this.appliedProposalTaskIds = [...appliedProposalTaskIds];
    if (reconciledApplyingProposal) {
      await this.persist();
    }
  }

  async generate(request: { workspace_id: string; change_request: string; executor?: ExecutorName; model?: string; reasoning_effort?: string }): Promise<{ taskId: Id; baseHead: string | null }> {
    // Generating a proposal is read-only analysis: any registered workspace
    // may propose; only APPLY requires controlled-write authorization.
    const workspaceRoot = this.registry.resolve(request.workspace_id);
    const base = await this.verifyWorkspace(workspaceRoot);
    return this.startProposal(request.workspace_id, workspaceRoot, base,
      PATCH_INSTRUCTION(request.change_request, base),
      undefined,
      request.executor,
      request.model,
      request.reasoning_effort);
  }

  async refine(request: { patch_task_id: string; change_request: string; executor?: ExecutorName; model?: string; reasoning_effort?: string }): Promise<{ taskId: Id; baseHead: string | null }> {
    const proposal = this.proposals.get(request.patch_task_id as Id);
    const sourceResult = this.tasks.result(request.patch_task_id);
    if (proposal === undefined || sourceResult === undefined || sourceResult.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    const currentBase = await this.verifyWorkspace(proposal.workspaceRoot);
    if (!sameBase(currentBase, proposal.base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return this.startProposal(proposal.workspaceId, proposal.workspaceRoot, proposal.base,
      REFINEMENT_INSTRUCTION(proposal.base, sourceResult.output, request.change_request),
      request.patch_task_id as Id,
      request.executor,
      request.model,
      request.reasoning_effort);
  }

  async submit(request: { workspace_id: string; base_head: string; diff: string }): Promise<{ taskId: Id; baseHead: string | null }> {
    // Submitting a caller-provided diff is read-only intake: like generation,
    // it requires no write authorization and writes nothing. The diff must be
    // a complete unified diff against exactly the current commit HEAD and must
    // pass the same full controlled-patch preflight that APPLY runs.
    const workspaceRoot = this.registry.resolve(request.workspace_id);
    const base = await this.verifyWorkspace(workspaceRoot);
    if (base.kind !== "commit" || base.head !== request.base_head) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const output = normalizeTrailingLf(request.diff);
    await this.preflightPatch(workspaceRoot, base, output);

    const { taskId } = this.tasks.submitControlledPatchTask(output, true);
    this.proposals.set(taskId, {
      workspaceId: request.workspace_id,
      workspaceRoot,
      base,
      state: "proposed",
      parentTaskId: undefined,
      executor: undefined,
      output
    });
    try {
      await this.persist();
    } catch (error) {
      this.proposals.delete(taskId);
      this.tasks.unpinTask(taskId);
      throw error;
    }
    return { taskId, baseHead: base.head };
  }

  validationProposal(patchTaskId: string): ControlledPatchValidationProposal {
    const proposal = this.proposals.get(patchTaskId as Id);
    const result = this.tasks.result(patchTaskId);
    if (proposal === undefined || result === undefined || result.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    return {
      workspaceId: proposal.workspaceId,
      workspaceRoot: proposal.workspaceRoot,
      baseHead: proposal.base.kind === "commit" ? proposal.base.head : null,
      patch: result.output
    };
  }

  async preflightValidationProposal(patchTaskId: string): Promise<ControlledPatchValidationProposal> {
    const validationProposal = this.validationProposal(patchTaskId);
    const proposal = this.proposals.get(patchTaskId as Id)!;
    await this.preflightPatch(proposal.workspaceRoot, proposal.base, validationProposal.patch);
    return validationProposal;
  }

  async apply(request: { patch_task_id: string; confirmation: string }): Promise<{
    patch_task_id: Id;
    applied: true;
    changed_paths: string[];
  }> {
    if (request.confirmation !== "APPLY") throw new CoreError("INVALID_STATE_TRANSITION");
    const proposal = this.proposals.get(request.patch_task_id as Id);
    if (proposal === undefined || proposal.state !== "proposed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    return this.withApplyLock(proposal.workspaceRoot, async () => {
      if (proposal.state !== "proposed") throw new CoreError("INVALID_STATE_TRANSITION");
      if (this.registry.resolveWritable(proposal.workspaceId) !== proposal.workspaceRoot) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      const result = this.tasks.result(request.patch_task_id);
      if (result === undefined || result.state !== "completed") {
        throw new CoreError("INVALID_STATE_TRANSITION");
      }

      proposal.state = "applying";
      try {
        await this.persist();
        const targets = await this.preflightPatch(proposal.workspaceRoot, proposal.base, result.output);
        await this.git(proposal.workspaceRoot, ["apply", "--recount", "--unidiff-zero"], result.output);
        proposal.state = "applied";
        this.appliedProposalTaskIds.push(request.patch_task_id as Id);
        this.trimAppliedProposals();
        try {
          await this.persist();
        } catch {
          await this.persist();
          this.tasks.unpinTask(request.patch_task_id as Id);
          return {
            patch_task_id: request.patch_task_id as Id,
            applied: true,
            changed_paths: targets.map(({ path }) => path),
            state: "applied",
            metadata_recovered: true
          };
        }
        this.tasks.unpinTask(request.patch_task_id as Id);
        return { patch_task_id: request.patch_task_id as Id, applied: true, changed_paths: targets.map(({ path }) => path) };
      } catch (error) {
        if (proposal.state === "applying") {
          proposal.state = "proposed";
          await this.persist();
        }
        throw error;
      }
    });
  }

  async commit(request: {
    patch_task_id: string;
    message: string;
    confirmation: string;
  }): Promise<{
    patch_task_id: Id;
    committed: true;
    commit_sha: string;
  }> {
    if (request.confirmation !== "COMMIT") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    const taskId = request.patch_task_id as Id;
    const proposal = this.proposals.get(taskId);
    const patch = proposal?.output;
    if (proposal === undefined || proposal.state !== "applied" || patch === undefined) {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    const message = normalizeCommitMessage(request.message);

    return this.withApplyLock(proposal.workspaceRoot, async () => {
      if (proposal.state !== "applied") {
        throw new CoreError("INVALID_STATE_TRANSITION");
      }
      if (this.registry.resolveWritable(proposal.workspaceId) !== proposal.workspaceRoot) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      return this.commitAppliedProposal(taskId, proposal, patch, message);
    });
  }

  private async withApplyLock<T>(workspaceRoot: string, action: () => Promise<T>): Promise<T> {
    try {
      workspaceRoot = await realpath(workspaceRoot);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const previous = this.applyQueues.get(workspaceRoot) ?? Promise.resolve();
    const current = previous.then(action, action);
    const settled = current.then(() => undefined, () => undefined);
    this.applyQueues.set(workspaceRoot, settled);
    return current.finally(() => {
      if (this.applyQueues.get(workspaceRoot) === settled) this.applyQueues.delete(workspaceRoot);
    });
  }

  private async commitAppliedProposal(
    taskId: Id,
    proposal: Proposal,
    patch: string,
    message: string
  ): Promise<{
    patch_task_id: Id;
    committed: true;
    commit_sha: string;
  }> {
    await this.verifyWorkspaceRoot(proposal.workspaceRoot);
    const base = proposal.base;
    const currentBase = await this.detectBase(proposal.workspaceRoot);
    if (!sameBase(currentBase, base)) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const unbornHeadRef = base.kind === "unborn"
      ? await this.verifyUnbornWithoutRefs(proposal.workspaceRoot)
      : undefined;

    const stagedBefore = splitNul(await this.git(proposal.workspaceRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z"
    ]));
    if (stagedBefore.length !== 0) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    const targets = parsePatch(patch).map(({ path }) => path).sort();
    const trackedDirty = splitNul(await this.git(proposal.workspaceRoot, [
      "diff",
      "--name-only",
      "-z",
      "--"
    ]));
    const untrackedDirty = splitNul(await this.git(proposal.workspaceRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--"
    ]));
    const targetSet = new Set(targets);
    const controlledUntracked = untrackedDirty.filter((path) => targetSet.has(path));
    const unrelatedUntracked = untrackedDirty.filter((path) => !targetSet.has(path)).sort();
    const controlledDirty = [...new Set([...trackedDirty, ...controlledUntracked])].sort();
    if (!sameStrings(controlledDirty, targets)) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const unrelatedUntrackedSnapshot = await fingerprintUntrackedPaths(
      proposal.workspaceRoot,
      unrelatedUntracked
    );
    const untrackedBefore = [...untrackedDirty].sort();
    await this.assertNoUnignoredSpecialPaths(proposal.workspaceRoot);
    if (!sameStrings(
      await this.listUntrackedPaths(proposal.workspaceRoot),
      untrackedBefore
    )) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (!(await this.applyCheck(proposal.workspaceRoot, patch, true))) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    await this.git(proposal.workspaceRoot, ["var", "GIT_AUTHOR_IDENT"]);
    await this.git(proposal.workspaceRoot, ["var", "GIT_COMMITTER_IDENT"]);
    await this.verifyUntrackedSnapshot(
      proposal.workspaceRoot,
      untrackedBefore,
      unrelatedUntrackedSnapshot
    );

    try {
      await this.git(proposal.workspaceRoot, [
        "apply",
        "--cached",
        "--recount",
        "--unidiff-zero"
      ], patch);
      const stagedAfter = splitNul(await this.git(proposal.workspaceRoot, [
        "diff",
        "--cached",
        "--name-only",
        "-z"
      ])).sort();
      if (!sameStrings(stagedAfter, targets)) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      const unstagedAfter = splitNul(await this.git(proposal.workspaceRoot, [
        "diff",
        "--name-only",
        "-z",
        "--"
      ]));
      if (unstagedAfter.length !== 0) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      if (base.kind === "unborn" &&
          await this.verifyUnbornWithoutRefs(proposal.workspaceRoot) !== unbornHeadRef) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
    } catch (error) {
      if (base.kind === "commit") {
        await this.unstageCommittedPathsIfHeadRemainsBase(
          proposal.workspaceRoot,
          base.head,
          targets
        );
      } else {
        await this.unstageInitialCommitPathsIfHeadRemainsUnborn(
          proposal.workspaceRoot,
          targets
        );
      }
      throw error;
    }

    let commitError: unknown;
    try {
      await this.git(proposal.workspaceRoot, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--no-verify",
        "-m",
        message
      ]);
    } catch (error) {
      commitError = error;
    }

    let commitSha: string;
    if (base.kind === "commit") {
      commitSha = (await this.git(proposal.workspaceRoot, [
        "rev-parse",
        "HEAD"
      ])).trim();
      if (commitSha === base.head) {
        await this.unstageCommittedPaths(proposal.workspaceRoot, targets);
        if (commitError !== undefined) throw commitError;
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
    } else {
      const head = await this.gitResult(proposal.workspaceRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD"
      ]);
      if (head.code !== 0) {
        await this.unstageInitialCommitPathsIfHeadRemainsUnborn(
          proposal.workspaceRoot,
          targets
        );
        if (commitError !== undefined) throw commitError;
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
      commitSha = head.stdout.trim();
    }

    const ancestry = (await this.git(proposal.workspaceRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD"
    ])).trim().split(/\s+/u);
    const validAncestry = base.kind === "commit"
      ? ancestry.length === 2 && ancestry[0] === commitSha && ancestry[1] === base.head
      : ancestry.length === 1 && ancestry[0] === commitSha;
    if (!/^[0-9a-f]{40,64}$/u.test(commitSha) || !validAncestry) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    const committedPaths = splitNul(await this.git(proposal.workspaceRoot, [
      "diff-tree",
      ...(base.kind === "unborn" ? ["--root"] : []),
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "HEAD"
    ])).sort();
    const committedSubject = (await this.git(proposal.workspaceRoot, [
      "log",
      "-1",
      "--format=%s"
    ])).trim();
    if (!sameStrings(committedPaths, targets) || committedSubject !== message) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    const stagedFinal = splitNul(await this.git(proposal.workspaceRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z"
    ]));
    const trackedFinal = splitNul(await this.git(proposal.workspaceRoot, [
      "diff",
      "--name-only",
      "-z",
      "--"
    ]));
    const finalHead = (await this.git(proposal.workspaceRoot, ["rev-parse", "HEAD"])).trim();
    if (stagedFinal.length !== 0 || trackedFinal.length !== 0 ||
        finalHead !== commitSha) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (base.kind === "unborn") {
      const refs = splitLines(await this.git(proposal.workspaceRoot, [
        "for-each-ref",
        "--format=%(refname)"
      ])).sort();
      const committedRef = (await this.git(proposal.workspaceRoot, [
        "rev-parse",
        "--verify",
        unbornHeadRef!
      ])).trim();
      if (!sameStrings(refs, [unbornHeadRef!]) || committedRef !== commitSha) {
        throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      }
    }
    await this.verifyUntrackedSnapshot(
      proposal.workspaceRoot,
      unrelatedUntracked,
      unrelatedUntrackedSnapshot
    );

    return { patch_task_id: taskId, committed: true, commit_sha: commitSha };
  }

  private async listUntrackedPaths(workspaceRoot: string): Promise<string[]> {
    return splitNul(await this.git(workspaceRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--"
    ])).sort();
  }

  private async verifyUntrackedSnapshot(
    workspaceRoot: string,
    expectedPaths: readonly string[],
    expectedFingerprints: readonly UntrackedPathFingerprint[]
  ): Promise<void> {
    await this.assertNoUnignoredSpecialPaths(workspaceRoot);
    const paths = await this.listUntrackedPaths(workspaceRoot);
    if (!sameStrings(paths, expectedPaths)) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const fingerprints = await fingerprintUntrackedPaths(
      workspaceRoot,
      expectedFingerprints.map(({ path }) => path)
    );
    if (!sameUntrackedFingerprints(fingerprints, expectedFingerprints) ||
        !sameStrings(await this.listUntrackedPaths(workspaceRoot), expectedPaths)) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    await this.assertNoUnignoredSpecialPaths(workspaceRoot);
  }

  private async assertNoUnignoredSpecialPaths(workspaceRoot: string): Promise<void> {
    const gitDirectory = resolve(
      workspaceRoot,
      (await this.git(workspaceRoot, ["rev-parse", "--git-dir"])).trim()
    );
    const trackedGitlinks = new Set(
      splitNul(await this.git(workspaceRoot, ["ls-files", "--stage", "-z", "--"]))
        .flatMap((entry) => {
          const separator = entry.indexOf("\t");
          return separator !== -1 && entry.startsWith("160000 ")
            ? [entry.slice(separator + 1)]
            : [];
        })
    );
    await this.scanDirectoryForSpecialPaths(workspaceRoot, "", gitDirectory, trackedGitlinks);
  }

  private async scanDirectoryForSpecialPaths(
    workspaceRoot: string,
    directory: string,
    gitDirectory: string,
    trackedGitlinks: ReadonlySet<string>
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(resolve(workspaceRoot, directory), { withFileTypes: true });
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const directories: string[] = [];
    const specialPaths: string[] = [];
    for (const entry of entries) {
      const path = directory.length === 0 ? entry.name : posix.join(directory, entry.name);
      if (resolve(workspaceRoot, path) === gitDirectory) continue;
      if (trackedGitlinks.has(path)) continue;
      if (entry.isDirectory()) directories.push(path);
      else if (!entry.isFile() && !entry.isSymbolicLink()) specialPaths.push(path);
    }
    const ignored = await this.ignoredPathSet(workspaceRoot, [...directories, ...specialPaths]);
    if (specialPaths.some((path) => !ignored.has(path))) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    for (const path of directories) {
      if (!ignored.has(path)) {
        await this.scanDirectoryForSpecialPaths(workspaceRoot, path, gitDirectory, trackedGitlinks);
      }
    }
  }

  private async ignoredPathSet(workspaceRoot: string, paths: readonly string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const result = await this.gitResult(
      workspaceRoot,
      ["check-ignore", "-z", "--stdin"],
      `${paths.join("\0")}\0`
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return new Set(splitNul(result.stdout));
  }

  private async unstageCommittedPathsIfHeadRemainsBase(
    workspaceRoot: string,
    baseHead: string,
    paths: readonly string[]
  ): Promise<void> {
    const head = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
    if (head.code === 0 && head.stdout.trim() === baseHead) {
      await this.unstageCommittedPaths(workspaceRoot, paths);
    }
  }

  private async unstageCommittedPaths(workspaceRoot: string, paths: readonly string[]): Promise<void> {
    await this.git(workspaceRoot, ["reset", "-q", "HEAD", "--", ...paths]);
  }

  private async unstageInitialCommitPathsIfHeadRemainsUnborn(
    workspaceRoot: string,
    paths: readonly string[]
  ): Promise<void> {
    const currentBase = await this.detectBase(workspaceRoot);
    if (currentBase.kind === "unborn") {
      await this.git(workspaceRoot, [
        "rm",
        "--cached",
        "-q",
        "--ignore-unmatch",
        "--",
        ...paths
      ]);
    }
  }

  private async verifyUnbornWithoutRefs(workspaceRoot: string): Promise<string> {
    if ((await this.detectBase(workspaceRoot)).kind !== "unborn") {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const headRef = (await this.git(workspaceRoot, ["symbolic-ref", "--quiet", "HEAD"])).trim();
    const refs = splitLines(await this.git(workspaceRoot, [
      "for-each-ref",
      "--format=%(refname)"
    ]));
    if (!/^refs\/heads\/[^\s]+$/u.test(headRef) || refs.length !== 0) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    return headRef;
  }

  private async applyCheck(workspaceRoot: string, patch: string, reverse: boolean): Promise<boolean> {
    try {
      await this.git(workspaceRoot, [
        "apply",
        "--check",
        "--recount",
        "--unidiff-zero",
        ...(reverse ? ["--reverse"] : [])
      ], patch);
      return true;
    } catch {
      return false;
    }
  }

  // The shared read-only controlled-patch preflight used by submit (before a
  // proposal is registered) and by APPLY (immediately before the write): the
  // workspace must still match the proposal base, the patch must be
  // structurally safe, every target must be verifiable against base HEAD /
  // index / worktree, and `git apply --check` must accept the patch.
  private async preflightPatch(workspaceRoot: string, base: ProposalBase, patch: string): Promise<PatchTarget[]> {
    const currentBase = await this.verifyWorkspace(workspaceRoot);
    // Unborn proposals require the repository to still be unborn: if the user
    // created the first commit meanwhile, this proposal must be rejected.
    if (!sameBase(currentBase, base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const targets = parsePatch(patch);
    for (const target of targets) {
      if (base.kind === "unborn") {
        // No tracked files exist in an unborn repository, so only pure
        // additions are verifiable; modified targets cannot be checked.
        if (target.kind !== "added") failPatch();
      } else {
        const entry = await this.git(workspaceRoot, ["ls-tree", base.head, "--", target.path]);
        if (target.kind === "modified") {
          if (!/^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(entry)) failPatch();
          continue;
        }
        if (entry.length !== 0) failPatch();
      }
      const indexEntry = await this.git(workspaceRoot, ["ls-files", "--stage", "--", target.path]);
      if (indexEntry.length !== 0 || await pathExists(resolve(workspaceRoot, target.path))) failPatch();
    }
    await this.git(workspaceRoot, ["apply", "--check", "--recount", "--unidiff-zero"], patch);
    return targets;
  }

  private startProposal(
    workspaceId: string,
    workspaceRoot: string,
    base: ProposalBase,
    instruction: string,
    parentTaskId?: Id,
    executor: ExecutorName = "codex",
    model?: string,
    reasoning_effort?: string
  ): { taskId: Id; baseHead: string | null } {
    const { taskId } = this.tasks.runTask({
      workspace_id: workspaceId,
      instruction,
      executor,
      ...(model === undefined ? {} : { model }),
      ...(reasoning_effort === undefined ? {} : { reasoning_effort })
    }, normalizeTrailingLf, async (result) => {
      const proposal = this.proposals.get(result.id);
      if (result.state === "failed") {
        this.proposals.delete(result.id);
        this.tasks.unpinTask(result.id);
        return;
      }
      if (proposal === undefined) throw new CoreError("INTERNAL_ERROR");
      proposal.output = result.output;
      try {
        await this.persist();
      } catch (error) {
        this.proposals.delete(result.id);
        this.tasks.unpinTask(result.id);
        throw error;
      }
    });
    this.proposals.set(taskId, {
      workspaceId,
      workspaceRoot,
      base,
      state: "proposed",
      parentTaskId,
      executor,
      output: undefined
    });
    this.tasks.pinTask(taskId);
    return { taskId, baseHead: base.kind === "commit" ? base.head : null };
  }

  private trimAppliedProposals(): void {
    const appliedTaskIds = this.appliedProposalTaskIds.filter(
      (taskId) => this.proposals.get(taskId)?.state === "applied"
    );
    const evictedTaskIds = appliedTaskIds.slice(
      0,
      Math.max(0, appliedTaskIds.length - MAX_APPLIED_PROPOSAL_HISTORY)
    );
    for (const taskId of evictedTaskIds) this.proposals.delete(taskId);
    this.appliedProposalTaskIds = appliedTaskIds.slice(-MAX_APPLIED_PROPOSAL_HISTORY);
  }

  private persist(): Promise<void> {
    if (this.stateFilePath === undefined) return Promise.resolve();
    const proposals: unknown[] = [];
    for (const [taskId, proposal] of this.proposals) {
      if (proposal.output === undefined) continue;
      proposals.push({
        task_id: taskId,
        workspace_id: proposal.workspaceId,
        workspace_root: proposal.workspaceRoot,
        base_head: proposal.base.kind === "commit" ? proposal.base.head : null,
        ...(proposal.base.kind === "unborn" ? { unborn: true } : {}),
        state: proposal.state,
        ...(proposal.parentTaskId === undefined ? {} : { parent_task_id: proposal.parentTaskId }),
        ...(proposal.executor === undefined ? { source: "submitted" } : { executor: proposal.executor }),
        output: proposal.output
      });
    }
    const contents = `${JSON.stringify({
      version: CONTROLLED_PATCH_STATE_VERSION,
      applied_task_ids: this.appliedProposalTaskIds,
      proposals
    }, null, 2)}\n`;
    const write = this.persistenceQueue.then(() => this.replaceStateFile(contents));
    this.persistenceQueue = write.catch((): void => {});
    return write;
  }

  private async replaceStateFile(contents: string): Promise<void> {
    const stateFilePath = this.stateFilePath!;
    const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, stateFilePath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  private async verifyWorkspace(workspaceRoot: string): Promise<ProposalBase> {
    await this.verifyWorkspaceRoot(workspaceRoot);
    const status = await this.git(workspaceRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.length !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return this.detectBase(workspaceRoot);
  }

  private async verifyWorkspaceRoot(workspaceRoot: string): Promise<void> {
    const topLevel = (await this.git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
    let canonicalTopLevel: string;
    let canonicalWorkspaceRoot: string;
    try {
      [canonicalTopLevel, canonicalWorkspaceRoot] = await Promise.all([
        realpath(resolve(topLevel)),
        realpath(resolve(workspaceRoot))
      ]);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (canonicalTopLevel !== canonicalWorkspaceRoot) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }

  // Distinguishes the three possible HEAD states without ever inferring "unborn"
  // from a bare nonzero exit or a catch-all failure. A repository is genuinely
  // unborn only when all of the following hold (stable, machine-decidable Git
  // primitives):
  //   1. `git rev-parse --verify --quiet HEAD` exits non-zero: HEAD does not
  //      resolve to a commit.
  //   2. `git symbolic-ref --quiet HEAD` exits zero and names a refs/heads/<branch>
  //      ref: HEAD is a symbolic branch ref, not detached, malformed, or absent.
  //   3. `git rev-parse --verify --quiet refs/heads/<branch>` exits non-zero:
  //      that branch has no commit yet (unborn branch state).
  // Any other combination — spawn/IO failures, detached or non-branch HEAD, or a
  // branch that resolves while HEAD does not — fails closed as
  // WORKSPACE_PRECONDITION_FAILED instead of being guessed as unborn.
  private async detectBase(workspaceRoot: string): Promise<ProposalBase> {
    const head = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code === 0) {
      const value = head.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      return { kind: "commit", head: value };
    }
    const symbolicRef = await this.gitResult(workspaceRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolicRef.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branch = symbolicRef.stdout.trim();
    if (!/^refs\/heads\/[^\s]+$/u.test(branch)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branchHead = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", branch]);
    if (branchHead.code === 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return { kind: "unborn" };
  }

  private async git(cwd: string, args: readonly string[], input?: string): Promise<string> {
    const result = await runBoundedGit(
      this.startProcess,
      cwd,
      args,
      input,
      () => new CoreError("WORKSPACE_PRECONDITION_FAILED"),
      this.gitProcessOptions
    );
    if (result.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return result.stdout;
  }

  // Exit-code-observing sibling of git(), used only for HEAD detection: it
  // resolves with the exit code and stdout instead of rejecting on nonzero, so
  // detectBase can prove the unborn state instead of assuming it. All other
  // calls keep using git(), which rejects on any nonzero exit.
  private gitResult(cwd: string, args: readonly string[], input?: string): Promise<GitProcessResult> {
    return runBoundedGit(
      this.startProcess,
      cwd,
      args,
      input,
      () => new CoreError("WORKSPACE_PRECONDITION_FAILED"),
      this.gitProcessOptions
    );
  }
}

// Strictly parses the retained controlled-patch state. Global invariants always
// fail closed with INTERNAL_ERROR; a single proposal record that cannot be
// safely restored is quarantined instead, so one bad record cannot brick the
// whole server. Quarantine never weakens the replay/duplicate-APPLY judgment:
// a quarantined record is dropped from the in-memory map (it can never be
// refined or APPLYed again), its task is never restored, and any
// applied_task_ids entry that referenced it is dropped with it, keeping the
// applied history exactly equal to the surviving applied proposals.
function parseRetainedState(value: unknown, registry: RegisteredWorkspaceRegistry): RetainedState {
  // 1. Strict envelope: an unreadable or unsupported top-level state fails the
  //    whole load, never a per-record quarantine.
  if (!isObject(value) || value.version !== CONTROLLED_PATCH_STATE_VERSION ||
      !Array.isArray(value.applied_task_ids) || !Array.isArray(value.proposals)) {
    throw new CoreError("INTERNAL_ERROR");
  }

  // 2. Strict applied_task_ids list: the list itself is a global invariant
  //    (well-formed ids, no duplicates, bounded history).
  if (!value.applied_task_ids.every(isId)) throw new CoreError("INTERNAL_ERROR");
  const appliedTaskIds = value.applied_task_ids as Id[];
  if (appliedTaskIds.length > MAX_APPLIED_PROPOSAL_HISTORY ||
      new Set(appliedTaskIds).size !== appliedTaskIds.length) {
    throw new CoreError("INTERNAL_ERROR");
  }

  // 3. Record-level parse with per-record quarantine.
  const proposals: RetainedProposal[] = [];
  const quarantinedTaskIds = new Set<Id>();
  const taskIdOccurrences = new Map<Id, number>();
  for (const item of value.proposals) {
    // A duplicated task id makes proposal identity ambiguous even when one of
    // the duplicates is otherwise broken (one copy could say "applied" while
    // the other says "proposed"), so it always fails closed.
    if (isObject(item) && isId(item.task_id)) {
      const occurrences = (taskIdOccurrences.get(item.task_id) ?? 0) + 1;
      taskIdOccurrences.set(item.task_id, occurrences);
      if (occurrences > 1) throw new CoreError("INTERNAL_ERROR");
    }
    const proposal = parseRetainedProposal(item);
    if (proposal === undefined) {
      if (isObject(item) && isId(item.task_id)) quarantinedTaskIds.add(item.task_id);
      continue;
    }
    // A proposal whose workspace is no longer registered (or whose root no
    // longer matches the registry) can be neither safely restored nor APPLYed:
    // quarantine it instead of failing the whole load.
    if (!registryMatches(registry, proposal.workspaceId, proposal.workspaceRoot)) {
      quarantinedTaskIds.add(proposal.taskId);
      continue;
    }
    proposals.push(proposal);
  }

  // 4. parent/refine relationship invariants over surviving proposals. The
  //    parent link is audit lineage only: a dangling parent (quarantined or
  //    never persisted) is allowed, but a surviving parent whose workspace or
  //    base contradicts the child fails closed.
  const byTaskId = new Map<Id, RetainedProposal>();
  for (const proposal of proposals) byTaskId.set(proposal.taskId, proposal);
  for (const proposal of proposals) {
    if (proposal.parentTaskId === undefined) continue;
    if (proposal.parentTaskId === proposal.taskId) throw new CoreError("INTERNAL_ERROR");
    const parent = byTaskId.get(proposal.parentTaskId);
    if (parent !== undefined && (parent.workspaceId !== proposal.workspaceId ||
        parent.workspaceRoot !== proposal.workspaceRoot ||
        !sameBase(proposal.base, parent.base))) {
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  // 5. Applied-history cross-invariant over survivors: applied_task_ids must
  //    equal exactly the surviving applied proposals. A quarantined record
  //    takes its own applied_task_ids entry with it, so dropping a bad applied
  //    record never leaves a dangling applied id behind; an applied id with no
  //    proposal record at all still fails closed.
  const survivingAppliedTaskIds = appliedTaskIds.filter((taskId) => !quarantinedTaskIds.has(taskId));
  const survivingAppliedTaskIdSet = new Set(survivingAppliedTaskIds);
  const appliedProposals = proposals.filter(({ state }) => state === "applied");
  if (appliedProposals.length !== survivingAppliedTaskIds.length ||
      appliedProposals.some(({ taskId }) => !survivingAppliedTaskIdSet.has(taskId))) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return { proposals, appliedTaskIds: survivingAppliedTaskIds };
}

// Parses a single retained proposal record. Returns undefined for a record that
// cannot be safely restored because its own fields are malformed; the caller
// quarantines such records. Any failure here is strictly record-local: no
// global invariant (identity, applied history, replay safety) is affected by
// dropping the record.
function parseRetainedProposal(item: unknown): RetainedProposal | undefined {
  if (!isObject(item) || !isId(item.task_id) ||
      typeof item.workspace_id !== "string" || item.workspace_id.length === 0 ||
      typeof item.workspace_root !== "string" ||
      (item.unborn !== undefined && typeof item.unborn !== "boolean") ||
      !["proposed", "applying", "applied", "recovery_conflict"].includes(item.state as string) ||
      (item.parent_task_id !== undefined && !isId(item.parent_task_id)) ||
      typeof item.output !== "string") {
    return undefined;
  }
  let base: ProposalBase;
  try {
    base = parseProposalBase(item);
  } catch {
    return undefined;
  }
  // A caller-submitted proposal carries source: "submitted" and no executor
  // identity: a submitted record that claims an executor is contradictory and
  // is quarantined. Any other source value is invalid retained state.
  if (item.source === "submitted") {
    if (item.executor !== undefined) return undefined;
    return {
      taskId: item.task_id,
      workspaceId: item.workspace_id,
      workspaceRoot: item.workspace_root,
      base,
      state: item.state as Proposal["state"],
      parentTaskId: item.parent_task_id as Id | undefined,
      executor: undefined,
      output: item.output
    };
  }
  if (item.source !== undefined) return undefined;
  // The retained executor is honest state: records written before executor
  // selection default to codex, and anything else is quarantined rather than
  // silently downgraded (a "gemini" record must never claim codex semantics).
  const rawExecutor = item.executor;
  const executor: ExecutorName | undefined = rawExecutor === undefined
    ? "codex"
    : rawExecutor === "codex" || rawExecutor === "dsh"
      ? rawExecutor
      : undefined;
  if (executor === undefined) return undefined;
  return {
    taskId: item.task_id,
    workspaceId: item.workspace_id,
    workspaceRoot: item.workspace_root,
    base,
    state: item.state as Proposal["state"],
    parentTaskId: item.parent_task_id as Id | undefined,
    executor,
    output: item.output
  };
}

function registryMatches(
  registry: RegisteredWorkspaceRegistry,
  workspaceId: string,
  workspaceRoot: string
): boolean {
  try {
    return registry.resolve(workspaceId) === workspaceRoot;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTrailingLf(output: string): string {
  return `${output.replace(/\n*$/u, "")}\n`;
}

function normalizeCommitMessage(value: string): string {
  const message = value.trim();
  if (message.length === 0 || message.includes("\n") || message.includes("\r") ||
      [...message].length > 200) {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  return message;
}

function splitNul(value: string): string[] {
  if (value.length === 0) return [];
  const parts = value.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.some((part) => part.length === 0)) failPatch();
  return parts;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  return value.trimEnd().split("\n");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

type UntrackedPathFingerprint = {
  path: string;
  kind: "file" | "symlink";
  metadata: string;
  content: string;
};

async function fingerprintUntrackedPaths(
  workspaceRoot: string,
  paths: readonly string[]
): Promise<UntrackedPathFingerprint[]> {
  const fingerprints: UntrackedPathFingerprint[] = [];
  for (const path of paths) {
    fingerprints.push(await fingerprintUntrackedPath(workspaceRoot, path));
  }
  return fingerprints;
}

async function fingerprintUntrackedPath(
  workspaceRoot: string,
  path: string
): Promise<UntrackedPathFingerprint> {
  try {
    const absolutePath = resolveUntrackedPath(workspaceRoot, path);
    const before = await lstat(absolutePath, { bigint: true });
    const metadata = stableFileMetadata(before);
    if (before.isSymbolicLink()) {
      const linkText = await readlink(absolutePath, { encoding: "buffer" });
      const after = await lstat(absolutePath, { bigint: true });
      if (stableFileMetadata(after) !== metadata) failPatch();
      return { path, kind: "symlink", metadata, content: linkText.toString("base64") };
    }
    if (!before.isFile() || typeof constants.O_NOFOLLOW !== "number") failPatch();

    const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || stableFileMetadata(opened) !== metadata) failPatch();
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const openedAfter = await handle.stat({ bigint: true });
      const pathAfter = await lstat(absolutePath, { bigint: true });
      if (stableFileMetadata(openedAfter) !== metadata ||
          stableFileMetadata(pathAfter) !== metadata) failPatch();
      return { path, kind: "file", metadata, content: hash.digest("hex") };
    } finally {
      await handle.close().catch((): void => {});
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
}

function resolveUntrackedPath(workspaceRoot: string, path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.split("/").includes("..") ||
      posix.normalize(path) !== path) failPatch();
  return resolve(workspaceRoot, path);
}

function stableFileMetadata(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs
  ].join(":");
}

function sameUntrackedFingerprints(
  left: readonly UntrackedPathFingerprint[],
  right: readonly UntrackedPathFingerprint[]
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const expected = right[index];
    return expected !== undefined && value.path === expected.path &&
      value.kind === expected.kind && value.metadata === expected.metadata &&
      value.content === expected.content;
  });
}

type PatchTarget = { path: string; kind: "modified" | "added" };

function parsePatch(patch: string): PatchTarget[] {
  if (!patch.startsWith("diff --git ") || patch.includes("GIT binary patch") ||
      patch.includes("Binary files ") || /^(old mode|new mode|deleted file mode|similarity index|rename (from|to)|copy (from|to)) /mu.test(patch)) {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  const lines = patch.split("\n");
  const targets: PatchTarget[] = [];
  let index = 0;
  while (index < lines.length && lines[index] !== "") {
    const header = lines[index];
    if (header === undefined || !header.startsWith("diff --git ")) failPatch();
    const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(header);
    if (match === null || match[1] !== match[2] || !safePath(match[1]!)) failPatch();
    const path = match[1]!;
    index += 1;
    const start = index;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index += 1;
    const section = lines.slice(start, index).join("\n");
    const newFileModes = section.match(/^new file mode .*$/gmu) ?? [];
    const oldHeaders = section.match(/^--- .*$/gmu) ?? [];
    const newHeaders = section.match(/^\+\+\+ .*$/gmu) ?? [];
    const addition = newFileModes.length > 0;
    if (addition) {
      if (newFileModes.length !== 1 || newFileModes[0] !== "new file mode 100644" ||
          !section.startsWith("new file mode 100644\n") ||
          oldHeaders.length !== 1 || oldHeaders[0] !== "--- /dev/null" ||
          newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
          !section.includes(`--- /dev/null\n+++ b/${path}\n`)) failPatch();
    } else if (oldHeaders.length !== 1 || oldHeaders[0] !== `--- a/${path}` ||
               newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
               !section.includes(`--- a/${path}\n+++ b/${path}\n`)) {
      failPatch();
    }
    if (!/^@@ /mu.test(section)) failPatch();
    targets.push({ path, kind: addition ? "added" : "modified" });
  }
  if (targets.length === 0 || new Set(targets.map(({ path }) => path)).size !== targets.length) failPatch();
  return targets;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    failPatch();
  }
}

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").includes("..") && posix.normalize(path) === path && path !== "/dev/null";
}

function failPatch(): never {
  throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
}

// Strictly parses the persisted base-state fields. A proposal base is either a
// real commit (base_head = <hex>, unborn absent/false) or the unborn repository
// state (base_head = null, unborn = true); every other combination is invalid
// retained state and is rejected like the existing invalid-record handling.
function parseProposalBase(item: Record<string, unknown>): ProposalBase {
  if (item.unborn === true) {
    if (item.base_head !== null) throw new CoreError("INTERNAL_ERROR");
    return { kind: "unborn" };
  }
  if (typeof item.base_head !== "string" || !/^[0-9a-f]{40,64}$/u.test(item.base_head)) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return { kind: "commit", head: item.base_head };
}

function sameBase(current: ProposalBase, expected: ProposalBase): boolean {
  if (current.kind === "unborn") return expected.kind === "unborn";
  return expected.kind === "commit" && current.head === expected.head;
}
