import { milliseconds, monotonicTimer, secondsToMilliseconds } from "./validation-deadline.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "../core/errors.js";

import type {
  ControlledPatchService,
  ControlledPatchValidationProposal
} from "./controlled-patch-service.js";
import type {
  ValidationProfile,
  ValidationProfileStore,
  ValidationStep
} from "./validation-profile-store.js";
import type {
  ValidationProcessOutcome,
  ValidationProcessRequest,
  ValidationProcessRunner
} from "./validation-process-runner.js";
import type { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";

export type ValidationStatus = "PASS" | "FAIL" | "INCOMPLETE";

export interface ValidationStepResult {
  readonly name: string;
  readonly status: ValidationStatus;
  readonly exit_code?: number;
  readonly duration_ms: number;
  readonly output_tail: string;
}

export interface ControlledPatchValidationReport {
  readonly status: ValidationStatus;
  readonly patch_task_id: string;
  readonly workspace_id: string;
  readonly base_head: string | null;
  readonly total_duration_ms: number;
  readonly steps: readonly ValidationStepResult[];
  readonly cleanup: "success" | "failed";
  readonly reason?: string;
}

export interface CleanupDeadlineTimer {
  set(callback: () => void, delayMs: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

const DEFAULT_STEP_TIMEOUT_SECONDS = 600;
const DEFAULT_TOTAL_TIMEOUT_SECONDS = 1_200;
const CLEANUP_TIMEOUT_MS = 5_000;

const systemCleanupDeadlineTimer: CleanupDeadlineTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle)
};

async function createTempParent(): Promise<string> {
  return mkdtemp(join(tmpdir(), "engineering-bridge-validation-"));
}

function removeTempParent(temporaryParent: string): Promise<void> {
  return rm(temporaryParent, { recursive: true, force: true });
}

function succeeded(outcome: ValidationProcessOutcome): boolean {
  return outcome.kind === "exit" && outcome.exitCode === 0;
}

function stepResult(
  step: ValidationStep,
  outcome: ValidationProcessOutcome
): ValidationStepResult {
  if (outcome.kind === "exit") {
    return {
      name: step.name,
      status: outcome.exitCode === 0 ? "PASS" : "FAIL",
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      output_tail: outcome.outputTail
    };
  }

  return {
    name: step.name,
    status: "INCOMPLETE",
    duration_ms: outcome.durationMs,
    output_tail: outcome.outputTail
  };
}

export class ControlledPatchValidationService {
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly active = new Set<Promise<ControlledPatchValidationReport>>();

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly controlledPatches: ControlledPatchService,
    private readonly profiles: ValidationProfileStore,
    private readonly runner: ValidationProcessRunner,
    private readonly nowMs: () => number | bigint = () => monotonicTimer.now(),
    private readonly makeTempParent: () => Promise<string> = createTempParent,
    private readonly removeParent: (temporaryParent: string) => Promise<void> =
      removeTempParent,
    private readonly cleanupDeadlineTimer: CleanupDeadlineTimer =
      systemCleanupDeadlineTimer
  ) {}

  configure(
    workspaceId: string,
    profile: ValidationProfile
  ): Promise<ValidationProfile> {
    this.registry.resolve(workspaceId);
    return this.profiles.configure(workspaceId, profile);
  }

  validate(patchTaskId: string): Promise<ControlledPatchValidationReport> {
    if (this.closing) return Promise.reject(new CoreError("INVALID_STATE_TRANSITION"));
    const validation = this.validateActive(patchTaskId);
    this.active.add(validation);
    void validation.then(() => this.active.delete(validation), () => this.active.delete(validation));
    return validation;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    const drain = (async () => {
      this.runner.interrupt();
      const results = await Promise.allSettled([...this.active]);
      // A cleanup report can reach its deadline before its runner has finished
      // TERM/KILL. Keep that process owned until its bounded attempt settles.
      await this.runner.waitForCompletion();
      if (results.some(result => result.status === "rejected" || result.value.cleanup === "failed")) {
        throw new Error("Synchronous validation shutdown could not be confirmed.");
      }
    })();
    let timer: NodeJS.Timeout;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Synchronous validation shutdown could not be confirmed.")), 10_000);
    });
    this.shutdownPromise = Promise.race([drain, deadline]).finally(() => clearTimeout(timer));
    return this.shutdownPromise;
  }

  private async validateActive(
    patchTaskId: string
  ): Promise<ControlledPatchValidationReport> {
    const startedAt = milliseconds(this.nowMs());
    const proposal = this.controlledPatches.validationProposal(patchTaskId);
    const profile = await this.profiles.get(proposal.workspaceId);

    if (profile === undefined) {
      return this.report(
        startedAt,
        "INCOMPLETE",
        patchTaskId,
        proposal,
        [],
        "success",
        "validation_profile_missing"
      );
    }

    if (proposal.baseHead === null) {
      return this.report(
        startedAt,
        "INCOMPLETE",
        patchTaskId,
        proposal,
        [],
        "success",
        "unsupported_unborn_base"
      );
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = this.registry.resolve(proposal.workspaceId);
      if (workspaceRoot !== proposal.workspaceRoot) {
        throw new Error("registered workspace changed");
      }
      await this.controlledPatches.preflightValidationProposal(patchTaskId);
    } catch {
      return this.report(
        startedAt,
        "INCOMPLETE",
        patchTaskId,
        proposal,
        [],
        "success",
        "preflight_failed"
      );
    }

    let temporaryParent: string;
    try {
      temporaryParent = await this.makeTempParent();
    } catch {
      return this.report(
        startedAt,
        "INCOMPLETE",
        patchTaskId,
        proposal,
        [],
        "success",
        "temporary_state_failed"
      );
    }

    const worktreeRoot = join(temporaryParent, "worktree");
    const totalTimeoutMs =
      secondsToMilliseconds(profile.totalTimeoutSeconds ?? DEFAULT_TOTAL_TIMEOUT_SECONDS);
    const steps: ValidationStepResult[] = [];
    let status: ValidationStatus = "INCOMPLETE";
    let reason: string | undefined = "worktree_creation_failed";
    let cleanupSafe = true;
    const runWithinBudget = async (
      request: Omit<ValidationProcessRequest, "timeoutMs">,
      requestedTimeoutMs = totalTimeoutMs
    ): Promise<ValidationProcessOutcome | undefined> => {
      const outcome = await this.runWithinBudget(startedAt, totalTimeoutMs, request, requestedTimeoutMs);
      if (outcome?.kind === "termination_error") cleanupSafe = false;
      return outcome;
    };

    try {
      const worktreeOutcome = await runWithinBudget(
        {
          argv: [
            "git",
            "-C",
            workspaceRoot,
            "worktree",
            "add",
            "--detach",
            worktreeRoot,
            proposal.baseHead
          ],
          cwd: workspaceRoot
        }
      );

      if (worktreeOutcome === undefined) {
        reason = "total_timeout";
      } else if (succeeded(worktreeOutcome)) {
        const applyOutcome = await runWithinBudget(
          {
            argv: ["git", "apply", "--recount", "--unidiff-zero"],
            cwd: worktreeRoot,
            input: proposal.patch
          }
        );

        if (applyOutcome === undefined) {
          reason = "total_timeout";
        } else if (!succeeded(applyOutcome)) {
          reason = "candidate_apply_failed";
        } else {
          status = "PASS";
          reason = undefined;

          for (const step of [...profile.preparation, ...profile.validation]) {
            const timeoutMs =
              secondsToMilliseconds(step.timeoutSeconds ??
                profile.defaultStepTimeoutSeconds ??
                DEFAULT_STEP_TIMEOUT_SECONDS);
            const outcome = await runWithinBudget(
              {
                argv: step.argv,
                cwd: worktreeRoot
              },
              timeoutMs
            );

            if (outcome === undefined) {
              status = "INCOMPLETE";
              reason = "total_timeout";
              break;
            }

            const result = stepResult(step, outcome);
            steps.push(result);
            if (result.status !== "PASS") {
              status = result.status;
              reason =
                result.status === "INCOMPLETE" ? outcome.kind : undefined;
              break;
            }
          }
        }
      }
    } catch {
      cleanupSafe = false;
      status = "INCOMPLETE";
      reason = "infrastructure_failed";
    }

    const cleanup = cleanupSafe ? await this.cleanup(
      workspaceRoot,
      worktreeRoot,
      temporaryParent
    ) : "failed";
    if (cleanup === "failed") {
      status = "INCOMPLETE";
      reason = "cleanup_failed";
    }

    return this.report(
      startedAt,
      status,
      patchTaskId,
      proposal,
      steps,
      cleanup,
      reason
    );
  }

  private async runWithinBudget(
    startedAt: bigint,
    totalTimeoutMs: bigint,
    request: Omit<ValidationProcessRequest, "timeoutMs">,
    requestedTimeoutMs = totalTimeoutMs
  ): Promise<ValidationProcessOutcome | undefined> {
    if (this.closing) return { kind: "aborted", durationMs: 0, outputTail: "" };
    const remainingMs = totalTimeoutMs - (milliseconds(this.nowMs()) - startedAt);
    if (remainingMs <= 0n) {
      return undefined;
    }

    return this.runner.run({
      ...request,
      timeoutMs: requestedTimeoutMs < remainingMs ? requestedTimeoutMs : remainingMs
    });
  }

  private async cleanup(
    workspaceRoot: string,
    worktreeRoot: string,
    temporaryParent: string
  ): Promise<"success" | "failed"> {
    let deadlineHandle: NodeJS.Timeout | undefined;
    let deadlineExpired = false;
    const deadline = new Promise<"failed">((resolve) => {
      deadlineHandle = this.cleanupDeadlineTimer.set(() => {
        deadlineHandle = undefined;
        deadlineExpired = true;
        resolve("failed");
      }, CLEANUP_TIMEOUT_MS);
    });

    const cleanupSequence = (async (): Promise<"success" | "failed"> => {
      let failed = false;
      try {
        const outcome = await this.runner.run({
          argv: [
            "git",
            "-C",
            workspaceRoot,
            "worktree",
            "remove",
            "--force",
            worktreeRoot
          ],
          cwd: workspaceRoot,
          timeoutMs: CLEANUP_TIMEOUT_MS
        });
        if (outcome.kind === "termination_error") return "failed";
        failed = !succeeded(outcome);
      } catch {
        return "failed";
      }

      if (deadlineExpired) {
        return "failed";
      }

      try {
        await this.removeParent(temporaryParent);
      } catch {
        failed = true;
      }

      return failed ? "failed" : "success";
    })();

    const result = await Promise.race([cleanupSequence, deadline]);
    if (deadlineHandle !== undefined) {
      this.cleanupDeadlineTimer.clear(deadlineHandle);
      deadlineHandle = undefined;
    }

    return result;
  }

  private report(
    startedAt: bigint,
    status: ValidationStatus,
    patchTaskId: string,
    proposal: ControlledPatchValidationProposal,
    steps: readonly ValidationStepResult[],
    cleanup: "success" | "failed",
    reason?: string
  ): ControlledPatchValidationReport {
    return {
      status,
      patch_task_id: patchTaskId,
      workspace_id: proposal.workspaceId,
      base_head: proposal.baseHead,
      total_duration_ms: Number(milliseconds(this.nowMs()) - startedAt),
      steps,
      cleanup,
      ...(reason === undefined ? {} : { reason })
    };
  }
}
