import { performance } from "node:perf_hooks";

import type { ControlledPatchService, ControlledPatchValidationProposal, ValidationGit } from "./controlled-patch-service.js";
import type { ValidationProfileStore } from "./validation-profile-store.js";
import { ValidationProcessRunner, type SupervisedValidationProcessOutcome, type ValidationProcessRequest } from "./validation-process-runner.js";
import { ValidationRunStore } from "./validation-run-store.js";
import { ValidationRunError, type ValidationRun, type ValidationRunEvent } from "./validation-run.js";
import { ValidationRunOwner } from "./validation-run-owner.js";
import { ValidationRunWorktree, type ValidationWorktreeGit } from "./validation-run-worktree.js";
import type { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { isPathWithin, isWorkspaceRoot } from "../workspaces/workspace-paths.js";

type Options = {
  registry: RegisteredWorkspaceRegistry;
  controlledPatches: ControlledPatchService;
  profiles: ValidationProfileStore;
  directory: string;
  tempRoot: string;
  protectedRoots: readonly string[];
  runner?: Pick<ValidationProcessRunner, "runSupervised">;
  maxActiveRuns?: number;
};
type Active = {
  run: ValidationRun;
  proposal: ControlledPatchValidationProposal;
  stop: AbortController;
  cleanupStop?: AbortController;
  stopReason?: string;
  startedMs: number;
  deadlineMs: number;
  changes: Promise<unknown>;
  done: Promise<void>;
  quiescent: boolean;
};
const CLEANUP_MS = 5000;
const SHUTDOWN_MS = 8000;
function at(): string { return new Date().toISOString(); }
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function duration(active: Active): number {
  return Math.max(active.run.total_duration_ms, Math.floor(performance.now() - active.startedMs));
}

/** Internal service lifecycle only. MCP requests never own its abort controllers or promises. */
export class ControlledPatchValidationRunService {
  private readonly store: ValidationRunStore;
  private readonly runner: Pick<ValidationProcessRunner, "runSupervised">;
  private readonly active = new Map<string, Active>();
  private admission: Promise<unknown> = Promise.resolve();
  private fatal: unknown;
  private startupError: unknown;
  private closing = false;
  private closingReason = "bridge_shutdown";
  private shutdownPromise: Promise<void> | undefined;
  private readonly limit: number;

  private constructor(private readonly options: Options, private readonly owner: ValidationRunOwner,
    private readonly worktree: ValidationRunWorktree) {
    this.store = new ValidationRunStore(options.directory, {
      protectedRoots: options.protectedRoots,
      onPersistenceFailure: error => {
        // Recovery without live executions keeps its existing startup-error path.
        if (this.active.size) this.fail(error);
      },
    });
    this.runner = options.runner ?? new ValidationProcessRunner();
    this.limit = options.maxActiveRuns ?? 4;
  }

  static async open(options: Options): Promise<ControlledPatchValidationRunService> {
    // The retained supervisor currently proves POSIX process-group termination.
    // Do not launch on a platform where that proof is unavailable.
    if (process.platform === "win32") throw failure("VALIDATION_PLATFORM_UNSUPPORTED");
    if (!isWorkspaceRoot(options.directory) || !isWorkspaceRoot(options.tempRoot) ||
        isPathWithin(options.directory, options.tempRoot) || isPathWithin(options.tempRoot, options.directory) ||
        !Number.isSafeInteger(options.maxActiveRuns ?? 4) || (options.maxActiveRuns ?? 4) < 1 ||
        options.protectedRoots.some(root => !isWorkspaceRoot(root) ||
          isPathWithin(root, options.directory) || isPathWithin(root, options.tempRoot))) {
      throw failure("VALIDATION_STORE_BOUNDARY");
    }
    const worktree = new ValidationRunWorktree(options.tempRoot);
    const owner = await ValidationRunOwner.acquire(options.directory);
    const service = new ControlledPatchValidationRunService(options, owner, worktree);
    try { await service.recover(); }
    catch (error) {
      // Bad sibling records block admission/recovery without hiding intact terminal
      // evidence. A running record is never served as live after recovery failed.
      service.startupError = error;
    }
    return service;
  }

  async get(id: string): Promise<ValidationRun | undefined> {
    if (this.fatal) throw this.fatal;
    const run = await this.store.get(id);
    if (this.startupError && run?.state === "running") throw this.startupError;
    return run;
  }
  async latest(patchId: string): Promise<ValidationRun | undefined> {
    if (this.fatal) throw this.fatal;
    const run = await this.store.latest(patchId);
    if (this.startupError && run?.state === "running") throw this.startupError;
    return run;
  }

  start(request: { patch_task_id: string; idempotency_key: string }): Promise<ValidationRun> {
    if (typeof request !== "object" || request === null ||
        Object.keys(request).sort().join(",") !== "idempotency_key,patch_task_id" ||
        typeof request.patch_task_id !== "string" || typeof request.idempotency_key !== "string") {
      return Promise.reject(new ValidationRunError("VALIDATION_RUN_INVALID_INPUT"));
    }
    const input = { ...request };
    const admitted = this.admission.then(async () => {
      if (this.fatal) throw this.fatal;
      if (this.startupError) throw this.startupError;
      if (this.closing) throw failure("VALIDATION_SERVICE_STOPPING");
      const replay = await this.store.replay(input.idempotency_key, input.patch_task_id);
      if (replay) return replay;
      if (this.active.size >= this.limit) throw failure("VALIDATION_CAPACITY_BUSY");
      const proposal = Object.freeze({ ...this.options.controlledPatches.validationProposal(input.patch_task_id) });
      const profile = await this.options.profiles.get(proposal.workspaceId);
      const run = await this.store.admit({
        ...input, workspace_id: proposal.workspaceId, workspace_root: proposal.workspaceRoot,
        base_head: proposal.baseHead, patch: proposal.patch, profile: profile ?? null,
      });
      const startedMs = performance.now();
      const active: Active = {
        run, proposal, stop: new AbortController(), startedMs,
        deadlineMs: startedMs + (run.profile_snapshot?.total_timeout_seconds ?? 0) * 1000,
        changes: Promise.resolve(), done: Promise.resolve(), quiescent: true,
      };
      if (this.closing) { active.stopReason = this.closingReason; active.stop.abort(); }
      this.active.set(run.validation_run_id, active);
      active.done = new Promise<void>(resolve => {
        setImmediate(() => {
          void this.execute(active).catch(error => this.fail(error)).finally(() => {
            this.active.delete(run.validation_run_id); resolve();
          });
        });
      });
      return run;
    }).catch((error: unknown) => {
      if (!this.startupError && (error as { code?: string })?.code === "VALIDATION_STORE_UNAVAILABLE") this.fail(error);
      throw error;
    });
    this.admission = admitted.catch(() => undefined);
    return admitted;
  }

  shutdown(reason: "bridge_shutdown" | "bridge_sigterm" = "bridge_shutdown"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.closingReason = reason;
    // Synchronous stop never waits for a durable checkpoint or pending fsync.
    for (const active of this.active.values()) { active.stopReason = reason; active.stop.abort(); }
    const release = (async () => {
      await this.admission;
      await Promise.all([...this.active.values()].map(active => active.done));
      await this.owner.release();
    })();
    // Keep release/active promises owned even if the caller's bounded wait ends.
    void release.catch(error => this.fail(error));
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.fail(failure("VALIDATION_SHUTDOWN_INCOMPLETE"));
        reject(this.fatal);
      }, SHUTDOWN_MS);
    });
    this.shutdownPromise = Promise.race([release, deadline]).finally(() => clearTimeout(timer));
    return this.shutdownPromise;
  }

  private fail(error: unknown): void {
    this.fatal ??= error;
    this.closing = true;
    for (const active of this.active.values()) { active.stop.abort(); active.cleanupStop?.abort(); }
  }

  private checkpoint(active: Active, event: Omit<ValidationRunEvent, "at"> | ValidationRunEvent): Promise<void> {
    const change = active.changes.then(async () => {
      if (this.fatal) throw this.fatal;
      active.run = await this.store.update(active.run.validation_run_id, active.run.operation_sequence,
        { ...event, at: at() } as ValidationRunEvent);
    }).catch(error => { this.fail(error); throw error; });
    active.changes = change.catch(() => undefined);
    return change;
  }
  private stopped(active: Active, signal: AbortSignal): void {
    if (this.fatal) throw this.fatal;
    if (signal.aborted) throw failure(active.stopReason ?? "validation_stopped");
  }

  private async operation(active: Active, kind: "preflight" | "worktree_add" | "candidate_apply" | "profile" | "cleanup",
    request: Omit<ValidationProcessRequest, "timeoutMs">, timeout: number,
    signal = active.stop.signal, deadlineMs = active.deadlineMs): Promise<SupervisedValidationProcessOutcome> {
    this.stopped(active, signal);
    const remaining = Math.floor(deadlineMs - performance.now());
    if (remaining <= 0) throw failure(kind === "cleanup" ? "cleanup_timeout" : "total_timeout");
    // Only this service's live runner can establish quiescence. Restart never
    // infers it from retained process identities or attempts filesystem cleanup.
    active.quiescent = false;
    const outcome = await this.runner.runSupervised({
      ...request, timeoutMs: Math.min(timeout, Math.max(1, Math.floor(deadlineMs - performance.now()))),
    }, { signal });
    active.quiescent = outcome.disposition !== "unknown";
    return outcome;
  }

  private git(active: Active, kind: "preflight" | "worktree_add" | "candidate_apply" | "cleanup",
    signal = active.stop.signal, deadlineMs = active.deadlineMs): ValidationGit {
    return async (cwd, args, input) => {
      const outcome = await this.operation(active, kind, {
        argv: ["git", ...args], cwd, ...(input === undefined ? {} : { input }),
      }, 60_000, signal, deadlineMs);
      if (outcome.kind !== "exit" || outcome.disposition !== "quiescent" || outcome.stdoutTruncated) {
        throw failure(active.stopReason ?? (outcome.stdoutTruncated ? "preflight_output_limit" : outcome.kind));
      }
      return { code: outcome.exitCode, stdout: outcome.stdout };
    };
  }
  private checkedGit(active: Active, kind: "worktree_add" | "candidate_apply" | "cleanup",
    signal = active.stop.signal, deadlineMs = active.deadlineMs): ValidationWorktreeGit {
    const execute = this.git(active, kind, signal, deadlineMs);
    return async (cwd, args, input) => {
      const result = await execute(cwd, args, input);
      if (result.code !== 0) throw failure(kind === "cleanup" ? "cleanup_failed" : kind + "_failed");
      return result.stdout;
    };
  }

  private async execute(active: Active): Promise<void> {
    let reason: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (active.stop.signal.aborted) reason = active.stopReason ?? "bridge_shutdown";
      else if (active.run.profile_snapshot === null) reason = "validation_profile_missing";
      else if (active.run.base_head === null) reason = "unsupported_unborn_base";
      if (reason) {
        await this.checkpoint(active, { type: "finish", total_duration_ms: duration(active), reason } as ValidationRunEvent);
        return;
      }
      timer = setTimeout(() => { active.stopReason = "total_timeout"; active.stop.abort(); }, Math.max(0, active.deadlineMs - performance.now()));
      await this.checkpoint(active, { type: "start", owner_instance_id: this.owner.instanceId } as ValidationRunEvent);
      reason = "preflight_failed";
      this.stopped(active, active.stop.signal);
      await this.options.controlledPatches.preflightCapturedValidationProposal(active.proposal, this.git(active, "preflight"));
      reason = "temporary_state_failed";
      await this.checkpoint(active, { type: "worktree_owned", owned_worktree: this.worktree.plan(active.run) } as ValidationRunEvent);
      this.stopped(active, active.stop.signal);
      const parent = await this.worktree.createParent(active.run);
      await this.checkpoint(active, { type: "worktree_receipt", owned_worktree: parent } as ValidationRunEvent);
      reason = "worktree_creation_failed";
      const registered = await this.worktree.register(active.run, this.checkedGit(active, "worktree_add"));
      await this.checkpoint(active, { type: "worktree_receipt", owned_worktree: registered } as ValidationRunEvent);
      reason = "candidate_apply_failed";
      await this.checkpoint(active, { type: "phase", phase: "candidate_apply" } as ValidationRunEvent);
      await this.checkedGit(active, "candidate_apply")(registered.worktree_path,
        ["apply", "--recount", "--unidiff-zero"], active.proposal.patch);
      reason = undefined;
      const profile = active.run.profile_snapshot!;
      outer: for (const phase of ["preparation", "validation"] as const) {
        for (const [index, step] of profile[phase].entries()) {
          this.stopped(active, active.stop.signal);
          await this.checkpoint(active, { type: "step_started", phase, index } as ValidationRunEvent);
          const result = await this.operation(active, "profile", {
            argv: step.argv as readonly [string, ...string[]], cwd: registered.worktree_path,
          }, step.timeout_seconds * 1000);
          const incomplete = result.kind !== "exit" || result.disposition !== "quiescent";
          const outcome = incomplete ? {
            kind: "incomplete", reason: active.stopReason ?? (result.disposition === "unknown" ? "process_unconfirmed" : result.kind),
            duration_ms: result.durationMs, output_tail: result.outputTail,
          } : { kind: "exit", exit_code: result.exitCode, duration_ms: result.durationMs, output_tail: result.outputTail };
          await this.checkpoint(active, { type: "step_completed", outcome } as ValidationRunEvent);
          if (incomplete || (result.kind === "exit" && result.exitCode !== 0)) break outer;
        }
      }
    } catch (error) {
      if (this.fatal) return;
      reason = active.stopReason ?? reason ?? "infrastructure_failed";
      if (active.run.current_step) {
        await this.checkpoint(active, { type: "step_completed", outcome: {
          kind: "incomplete", reason, duration_ms: active.run.current_step.duration_ms,
          output_tail: active.run.current_step.output_tail,
        } } as ValidationRunEvent);
      }
    } finally { if (timer) clearTimeout(timer); }
    if (this.fatal) return;
    const cleanup = await this.cleanup(active);
    try {
      if (!this.fatal) await this.checkpoint(active, { type: "finish", total_duration_ms: duration(active),
        ...(active.stopReason ?? reason ? { reason: active.stopReason ?? reason } : {}),
      } as ValidationRunEvent);
    } finally {
      if (cleanup) {
        // Even terminal persistence failure must not release an in-flight deletion.
        const succeeded = await cleanup.pending;
        if (succeeded && !this.fatal) await this.checkpoint(active, {
          type: "cleanup", cleanup: { state: "success", reason: null, recovery_required: false },
        } as ValidationRunEvent);
      }
    }
  }

  private async cleanup(active: Active): Promise<{ pending: Promise<boolean> } | undefined> {
    if (!active.run.owned_worktree) {
      if (!active.quiescent) await this.checkpoint(active, {
        type: "cleanup", cleanup: { state: "failed", reason: "process_unconfirmed", recovery_required: true },
      } as ValidationRunEvent);
      return;
    }
    if (!active.quiescent) {
      await this.checkpoint(active, { type: "cleanup", cleanup: { state: "failed", reason: "process_unconfirmed", recovery_required: true } } as ValidationRunEvent);
      return;
    }
    await this.checkpoint(active, { type: "cleanup", cleanup: { state: "pending", reason: null, recovery_required: true } } as ValidationRunEvent);
    const signal = new AbortController();
    active.cleanupStop = signal;
    const deadlineMs = performance.now() + CLEANUP_MS;
    let timer: NodeJS.Timeout;
    let expired = false;
    const pending = this.worktree.cleanup(active.run, this.checkedGit(active, "cleanup", signal.signal, deadlineMs), signal.signal, active.quiescent)
      .then(() => true, () => false);
    const deadline = new Promise<false>(resolve => { timer = setTimeout(() => { expired = true; signal.abort(); resolve(false); }, CLEANUP_MS); });
    const success = await Promise.race([pending, deadline]);
    clearTimeout(timer!);
    if (!this.fatal) {
      try {
        await this.checkpoint(active, { type: "cleanup", cleanup: {
          state: success ? "success" : "failed", reason: success ? null : expired ? "cleanup_timeout" : "cleanup_failed", recovery_required: !success,
        } } as ValidationRunEvent);
      } catch (error) { await pending; throw error; }
    }
    return expired ? { pending } : undefined;
  }

  private async recover(): Promise<void> {
    for (const run of await this.store.retainedRuns()) {
      if (run.state === "running") await this.store.update(run.validation_run_id, run.operation_sequence, {
        type: "owner_lost", at: at(), owner_instance_id: run.owner_instance_id, owner_loss_confirmed: true,
      });
    }
  }
}
