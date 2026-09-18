import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type { ValidationProfile } from "./validation-profile-store.js";

export const VALIDATION_RUN_TAIL_BYTES = 65_536;

export type ValidationRunAdmission = {
  idempotency_key: string;
  patch_task_id: string;
  workspace_id: string;
  workspace_root: string;
  base_head: string | null;
  patch: string;
  profile: ValidationProfile | null;
};

export class ValidationRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ValidationRunError";
  }
}

const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = natural.min(1);
const identifier = z.string().min(1).max(256);
const opaqueKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const absolutePath = z.string().min(1).max(4096).refine((value) => !value.includes("\0") && isAbsolute(value));
const timestamp = z.string().datetime().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const reason = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const baseHead = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable();
const argv = z.array(z.string()).min(1);
const stepName = z.string().min(1);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
const sourceStepSchema = z.custom<Record<string, unknown>>((value) =>
  isPlainObject(value) && (!Object.hasOwn(value, "timeoutSeconds") || value.timeoutSeconds !== undefined),
).pipe(z.object({ name: stepName, argv, timeoutSeconds: positive.optional() }).strict());
const sourceProfileSchema = z.custom<Record<string, unknown>>(isPlainObject).pipe(z.object({
  preparation: z.array(sourceStepSchema),
  validation: z.array(sourceStepSchema),
  defaultStepTimeoutSeconds: positive,
  totalTimeoutSeconds: positive,
}).strict());
const snapshotStepSchema = z.object({ name: stepName, argv, timeout_seconds: positive }).strict();
const profileSchema = z.object({
  preparation: z.array(snapshotStepSchema),
  validation: z.array(snapshotStepSchema),
  default_step_timeout_seconds: positive,
  total_timeout_seconds: positive,
}).strict();
const proposalSchema = z.object({
  workspace_id: identifier,
  workspace_root: absolutePath,
  base_head: baseHead,
  patch: z.string(),
}).strict();
const admissionSchema = proposalSchema.extend({
  idempotency_key: opaqueKey,
  patch_task_id: identifier,
  profile: sourceProfileSchema.nullable(),
}).strict();
const metadataSchema = z.object({
  validation_run_id: z.string().uuid(),
  admission_sequence: positive,
  admitted_at: timestamp,
}).strict();
const stepPhaseSchema = z.enum(["preparation", "validation"]);
const tailSchema = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= VALIDATION_RUN_TAIL_BYTES && Buffer.from(value, "utf8").toString("utf8") === value);
const currentStepSchema = z.object({
  phase: stepPhaseSchema,
  index: natural,
  name: stepName,
  started_at: timestamp,
  duration_ms: natural,
  output_tail: tailSchema,
}).strict();
const resultSchema = z.object({
  phase: stepPhaseSchema,
  index: natural,
  name: stepName,
  status: z.enum(["PASS", "FAIL", "INCOMPLETE"]),
  exit_code: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable(),
  duration_ms: natural,
  output_tail: tailSchema,
  reason: reason.nullable(),
}).strict();
const cleanupSchema = z.object({
  state: z.enum(["not_needed", "pending", "success", "failed"]),
  reason: reason.nullable(),
  recovery_required: z.boolean(),
}).strict();
const filesystemIdentity = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict();
const ownedWorktreeSchema = z.object({
  expected_temp_root: absolutePath,
  parent_path: absolutePath,
  worktree_path: absolutePath,
  parent_identity: filesystemIdentity.nullable(),
  common_git_dir: absolutePath.nullable(),
  run_marker: z.string().uuid(),
  // Optional in Slice 1 records; absence never establishes filesystem ownership.
  temp_root_identity: filesystemIdentity.nullable().optional(),
  marker_identity: filesystemIdentity.nullable().optional(),
  workspace_identity: filesystemIdentity.nullable().optional(),
  common_git_dir_identity: filesystemIdentity.nullable().optional(),
  worktree_identity: filesystemIdentity.nullable().optional(),
  git_pointer_identity: filesystemIdentity.nullable().optional(),
  admin_path: absolutePath.nullable().optional(),
  admin_identity: filesystemIdentity.nullable().optional(),
  admin_gitdir_identity: filesystemIdentity.nullable().optional(),
}).strict();
const runSchema = z.object({
  schema_version: z.literal(1),
  validation_run_id: z.string().uuid(),
  idempotency_key: opaqueKey,
  admission_sequence: positive,
  operation_sequence: natural,
  patch_task_id: identifier,
  workspace_id: identifier,
  workspace_root: absolutePath,
  base_head: baseHead,
  patch_sha256: sha256,
  proposal_fingerprint: sha256,
  profile_snapshot: profileSchema.nullable(),
  profile_sha256: sha256.nullable(),
  admitted_at: timestamp,
  started_at: timestamp.nullable(),
  updated_at: timestamp,
  ended_at: timestamp.nullable(),
  state: z.enum(["running", "terminal"]),
  status: z.enum(["PASS", "FAIL", "INCOMPLETE"]).nullable(),
  phase: z.enum(["admitted", "preflight", "worktree", "candidate_apply", "preparation", "validation", "cleanup", "complete"]),
  current_step: currentStepSchema.nullable(),
  steps: z.array(resultSchema),
  cleanup: cleanupSchema,
  total_duration_ms: natural,
  duration_basis: z.enum(["measured", "last_checkpoint_lower_bound"]),
  reason: reason.nullable(),
  owner_instance_id: identifier.nullable(),
  owned_worktree: ownedWorktreeSchema.nullable(),
  recovered_at: timestamp.nullable(),
}).strict();

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
type MutableRun = z.infer<typeof runSchema>;
export type ValidationRun = Immutable<MutableRun>;
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), at: timestamp, owner_instance_id: identifier }).strict(),
  z.object({ type: z.literal("phase"), at: timestamp, phase: z.enum(["preflight", "worktree", "candidate_apply"]) }).strict(),
  z.object({ type: z.literal("worktree_owned"), at: timestamp, owned_worktree: ownedWorktreeSchema }).strict(),
  z.object({ type: z.literal("worktree_receipt"), at: timestamp, owned_worktree: ownedWorktreeSchema }).strict(),
  z.object({ type: z.literal("step_started"), at: timestamp, phase: stepPhaseSchema, index: natural }).strict(),
  z.object({ type: z.literal("progress"), at: timestamp, total_duration_ms: natural, step_duration_ms: natural.optional(), output_tail: z.string().optional() }).strict(),
  z.object({ type: z.literal("step_completed"), at: timestamp, outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("exit"), exit_code: resultSchema.shape.exit_code.unwrap(), duration_ms: natural, output_tail: z.string() }).strict(),
    z.object({ kind: z.literal("incomplete"), reason, duration_ms: natural, output_tail: z.string() }).strict(),
  ]) }).strict(),
  z.object({ type: z.literal("cleanup"), at: timestamp, cleanup: cleanupSchema }).strict(),
  z.object({ type: z.literal("finish"), at: timestamp, total_duration_ms: natural, reason: reason.optional() }).strict(),
  z.object({ type: z.literal("owner_lost"), at: timestamp, owner_instance_id: identifier.nullable(), owner_loss_confirmed: z.literal(true) }).strict(),
]);
export type ValidationRunEvent = Immutable<z.infer<typeof eventSchema>>;

function parsed<S extends z.ZodTypeAny>(schema: S, value: unknown, code: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationRunError(code);
  return result.data;
}
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function composition(value: Pick<MutableRun, "workspace_id" | "workspace_root" | "base_head" | "patch_sha256">): string {
  return hash(JSON.stringify({
    schema_version: 1,
    workspace_id: value.workspace_id,
    workspace_root: value.workspace_root,
    base_head: value.base_head,
    patch_sha256: value.patch_sha256,
  }));
}
function profileHash(profile: z.infer<typeof profileSchema> | null): string | null {
  return profile === null ? null : hash(JSON.stringify({ schema_version: 1, profile }));
}
export function proposalFingerprint(input: Pick<ValidationRunAdmission, "workspace_id" | "workspace_root" | "base_head" | "patch">): string {
  const value = parsed(proposalSchema, { workspace_id: input.workspace_id, workspace_root: input.workspace_root, base_head: input.base_head, patch: input.patch }, "VALIDATION_RUN_INVALID_INPUT");
  return composition({ ...value, patch_sha256: hash(value.patch) });
}
export function createValidationRun(input: ValidationRunAdmission, metadata: {
  validation_run_id: string; admission_sequence: number; admitted_at: string;
}): ValidationRun {
  const value = parsed(admissionSchema, input, "VALIDATION_RUN_INVALID_INPUT");
  const identity = parsed(metadataSchema, metadata, "VALIDATION_RUN_INVALID_INPUT");
  const source = value.profile;
  const snapshot = source === null ? null : {
    preparation: source.preparation.map((step) => ({ name: step.name, argv: step.argv, timeout_seconds: step.timeoutSeconds ?? source.defaultStepTimeoutSeconds })),
    validation: source.validation.map((step) => ({ name: step.name, argv: step.argv, timeout_seconds: step.timeoutSeconds ?? source.defaultStepTimeoutSeconds })),
    default_step_timeout_seconds: source.defaultStepTimeoutSeconds,
    total_timeout_seconds: source.totalTimeoutSeconds,
  };
  const patch_sha256 = hash(value.patch);
  return parseValidationRun({
    schema_version: 1,
    ...identity,
    idempotency_key: value.idempotency_key,
    operation_sequence: 0,
    patch_task_id: value.patch_task_id,
    workspace_id: value.workspace_id,
    workspace_root: value.workspace_root,
    base_head: value.base_head,
    patch_sha256,
    proposal_fingerprint: composition({ ...value, patch_sha256 }),
    profile_snapshot: snapshot,
    profile_sha256: profileHash(snapshot),
    started_at: null,
    updated_at: identity.admitted_at,
    ended_at: null,
    state: "running",
    status: null,
    phase: "admitted",
    current_step: null,
    steps: [],
    cleanup: { state: "not_needed", reason: null, recovery_required: false },
    total_duration_ms: 0,
    duration_basis: "measured",
    reason: null,
    owner_instance_id: null,
    owned_worktree: null,
    recovered_at: null,
  });
}
export function parseValidationRun(value: unknown): ValidationRun {
  if (typeof value === "object" && value !== null && "schema_version" in value &&
      Number.isSafeInteger(value.schema_version) && (value.schema_version as number) > 1) {
    throw new ValidationRunError("VALIDATION_RUN_INCOMPATIBLE");
  }
  const run = parsed(runSchema, value, "VALIDATION_RUN_CORRUPT");
  if (run.proposal_fingerprint !== composition(run) || run.profile_sha256 !== profileHash(run.profile_snapshot)) {
    throw new ValidationRunError("VALIDATION_RUN_CORRUPT");
  }
  assertRecord(run);
  return freeze(run);
}

function requireCondition(condition: boolean, code = "VALIDATION_RUN_INVALID_TRANSITION"): asserts condition {
  if (!condition) throw new ValidationRunError(code);
}
function configuredSteps(run: ValidationRun) {
  return run.profile_snapshot === null ? [] : [
    ...run.profile_snapshot.preparation.map((step, index) => ({ ...step, phase: "preparation" as const, index })),
    ...run.profile_snapshot.validation.map((step, index) => ({ ...step, phase: "validation" as const, index })),
  ];
}
function cleanupComplete(run: ValidationRun): boolean {
  return !run.cleanup.recovery_required && (run.cleanup.state === "success" || run.cleanup.state === "not_needed");
}
function worktreeMatches(run: ValidationRun): boolean {
  const owned = run.owned_worktree;
  return owned === null || (
    owned.run_marker === run.validation_run_id &&
    owned.parent_path === join(owned.expected_temp_root, `engineering-bridge-validation-${run.validation_run_id}`) &&
    owned.worktree_path === join(owned.parent_path, "worktree")
  );
}
function assertRecord(run: MutableRun): void {
  const check = (condition: boolean) => requireCondition(condition, "VALIDATION_RUN_CORRUPT");
  const configured = configuredSteps(run);
  check(worktreeMatches(run));
  if (run.base_head === null) check(run.current_step === null && run.steps.length === 0);
  check(run.cleanup.recovery_required === (run.cleanup.state === "pending" || run.cleanup.state === "failed"));
  if (cleanupComplete(run)) check(run.cleanup.reason === null);
  if (run.cleanup.state === "failed") check(run.cleanup.reason !== null);
  if (run.cleanup.state === "not_needed") check(run.owned_worktree === null && run.steps.length === 0 && run.current_step === null);
  if (run.started_at === null) {
    check(run.owner_instance_id === null && run.current_step === null && run.steps.length === 0 && run.owned_worktree === null);
  } else check(run.owner_instance_id !== null);
  if (run.state === "running") {
    check(run.status === null && run.ended_at === null && run.reason === null && run.phase !== "complete" && run.recovered_at === null);
    check((run.phase === "admitted") === (run.started_at === null));
    if (run.phase === "admitted") check(run.operation_sequence === 0 && run.cleanup.state === "not_needed");
    if (run.current_step !== null) check(run.cleanup.state === "pending");
    if (run.cleanup.state === "success" || run.cleanup.state === "failed") check(run.phase === "cleanup");
    if (["admitted", "preflight", "worktree", "candidate_apply"].includes(run.phase)) {
      check(run.current_step === null && run.steps.length === 0);
    }
    if (run.phase === "preparation" || run.phase === "validation") {
      check((run.current_step ?? run.steps.at(-1))?.phase === run.phase);
    }
  } else {
    check(run.status !== null && run.ended_at !== null && run.phase === "complete");
    check((run.status === "INCOMPLETE") === (run.reason !== null));
  }
  if (run.reason === "supervisor_lost") check(run.duration_basis === "last_checkpoint_lower_bound");
  if (run.duration_basis === "last_checkpoint_lower_bound") {
    check(run.status === "INCOMPLETE" && run.reason === "supervisor_lost" && run.recovered_at === run.ended_at && run.recovered_at !== null);
  } else check(run.recovered_at === null);
  for (const [position, step] of run.steps.entries()) {
    const expected = configured[position];
    check(expected !== undefined && step.phase === expected.phase && step.index === expected.index && step.name === expected.name);
    check(position === 0 || run.steps[position - 1]!.status === "PASS");
    check(step.status === "INCOMPLETE"
      ? step.exit_code === null && step.reason !== null
      : step.reason === null && step.exit_code !== null && (step.status === "PASS" ? step.exit_code === 0 : step.exit_code !== 0));
  }
  if (run.current_step !== null) {
    const expected = configured[run.steps.length];
    const current = run.current_step;
    check(expected !== undefined && current.phase === expected.phase && current.index === expected.index && current.name === expected.name);
    check(run.steps.every((step) => step.status === "PASS"));
    check(run.state === "running" ? run.phase === current.phase : run.duration_basis === "last_checkpoint_lower_bound");
  }
  const stepDuration = run.steps.reduce((sum, step) => sum + step.duration_ms, 0) + (run.current_step?.duration_ms ?? 0);
  check(run.total_duration_ms >= stepDuration);
  const minimumOperations = (run.started_at === null ? 0 : 1) + run.steps.length * 2 +
    (run.current_step === null ? 0 : 1) + (run.state === "terminal" ? 1 : 0) +
    (run.owned_worktree === null ? 0 : 1) +
    (run.phase === "cleanup" || run.cleanup.state === "success" || run.cleanup.state === "failed" ? 1 : 0);
  check(run.operation_sequence >= minimumOperations);
  if (run.operation_sequence === 0) {
    check(run.state === "running" && run.phase === "admitted" && run.total_duration_ms === 0 && run.updated_at === run.admitted_at);
  }
  if (run.status === "PASS" || run.status === "FAIL") {
    check(run.started_at !== null && run.profile_snapshot !== null && run.base_head !== null && run.current_step === null && cleanupComplete(run));
    check(run.status === "PASS"
      ? run.steps.length === configured.length && run.steps.every((step) => step.status === "PASS")
      : run.steps.some((step) => step.status === "FAIL"));
  }
}
function boundedTail(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let start = Math.max(0, bytes.length - VALIDATION_RUN_TAIL_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
const phases = ["admitted", "preflight", "worktree", "candidate_apply", "preparation", "validation", "cleanup", "complete"];

export function transitionValidationRun(run: ValidationRun, event: ValidationRunEvent): ValidationRun {
  const next = runSchema.parse(parseValidationRun(run));
  const update = parsed(eventSchema, event, "VALIDATION_RUN_INVALID_TRANSITION");
  requireCondition(run.operation_sequence < Number.MAX_SAFE_INTEGER);
  requireCondition(run.state === "running" || update.type === "cleanup");
  switch (update.type) {
    case "start":
      requireCondition(run.started_at === null && run.phase === "admitted");
      next.started_at = update.at;
      next.owner_instance_id = update.owner_instance_id;
      next.phase = "preflight";
      break;
    case "phase":
      requireCondition(run.started_at !== null && run.current_step === null && phases.indexOf(update.phase) >= phases.indexOf(run.phase));
      next.phase = update.phase;
      break;
    case "worktree_owned":
      requireCondition(run.started_at !== null && run.owned_worktree === null && phases.indexOf(run.phase) <= phases.indexOf("worktree"));
      next.owned_worktree = update.owned_worktree;
      requireCondition(worktreeMatches(next));
      next.phase = "worktree";
      next.cleanup = { state: "pending", reason: null, recovery_required: true };
      break;
    case "worktree_receipt": {
      const previous = run.owned_worktree;
      requireCondition(previous !== null && run.phase === "worktree");
      for (const [key, value] of Object.entries(previous)) {
        if (value !== null && value !== undefined) requireCondition(JSON.stringify(value) === JSON.stringify(update.owned_worktree[key as keyof typeof previous]));
      }
      next.owned_worktree = update.owned_worktree;
      requireCondition(worktreeMatches(next));
      break;
    }
    case "step_started": {
      const expected = configuredSteps(run)[run.steps.length];
      requireCondition(run.started_at !== null && run.base_head !== null && run.current_step === null && expected !== undefined);
      requireCondition(run.steps.every((step) => step.status === "PASS") && expected.phase === update.phase && expected.index === update.index);
      requireCondition(phases.indexOf(run.phase) <= phases.indexOf(expected.phase));
      next.current_step = { phase: expected.phase, index: expected.index, name: expected.name, started_at: update.at, duration_ms: 0, output_tail: "" };
      next.phase = expected.phase;
      next.cleanup = { state: "pending", reason: null, recovery_required: true };
      break;
    }
    case "progress":
      requireCondition(run.started_at !== null && update.total_duration_ms >= run.total_duration_ms);
      requireCondition(run.current_step !== null || (update.step_duration_ms === undefined && update.output_tail === undefined));
      if (next.current_step !== null) {
        if (update.step_duration_ms !== undefined) {
          requireCondition(update.step_duration_ms >= next.current_step.duration_ms);
          next.current_step.duration_ms = update.step_duration_ms;
        }
        if (update.output_tail !== undefined) next.current_step.output_tail = boundedTail(update.output_tail);
      }
      next.total_duration_ms = update.total_duration_ms;
      break;
    case "step_completed": {
      const current = run.current_step;
      requireCondition(current !== null && update.outcome.duration_ms >= current.duration_ms);
      const outcome = update.outcome;
      next.steps.push({
        phase: current.phase, index: current.index, name: current.name,
        status: outcome.kind === "incomplete" ? "INCOMPLETE" : outcome.exit_code === 0 ? "PASS" : "FAIL",
        exit_code: outcome.kind === "exit" ? outcome.exit_code : null,
        duration_ms: outcome.duration_ms, output_tail: boundedTail(outcome.output_tail),
        reason: outcome.kind === "incomplete" ? outcome.reason : null,
      });
      next.current_step = null;
      next.total_duration_ms = Math.max(run.total_duration_ms, next.steps.reduce((sum, step) => sum + step.duration_ms, 0));
      break;
    }
    case "cleanup":
      requireCondition(run.state === "terminal" || (run.started_at !== null && run.current_step === null));
      requireCondition(run.cleanup.state !== "success" || update.cleanup.state === "success");
      requireCondition(run.state !== "terminal" || run.status === "INCOMPLETE" || update.cleanup.state === run.cleanup.state);
      requireCondition(update.cleanup.state !== "not_needed" || (run.owned_worktree === null && run.steps.length === 0 && run.current_step === null));
      next.cleanup = update.cleanup;
      if (run.state === "running") next.phase = "cleanup";
      break;
    case "finish": {
      requireCondition(update.reason !== "supervisor_lost");
      requireCondition(run.current_step === null && update.total_duration_ms >= run.total_duration_ms);
      const incompleteReason = update.reason ?? (run.profile_snapshot === null ? "missing_profile" : run.base_head === null ? "unborn_base" :
        run.steps.find((step) => step.status === "INCOMPLETE")?.reason ??
        (!cleanupComplete(run) ? run.cleanup.reason ?? `cleanup_${run.cleanup.state}` : null));
      if (incompleteReason === null) {
        requireCondition(run.started_at !== null);
        const failed = run.steps.some((step) => step.status === "FAIL");
        requireCondition(failed || run.steps.length === configuredSteps(run).length);
        next.status = failed ? "FAIL" : "PASS";
      } else next.status = "INCOMPLETE";
      next.reason = incompleteReason;
      next.total_duration_ms = update.total_duration_ms;
      next.state = "terminal";
      next.phase = "complete";
      next.ended_at = update.at;
      break;
    }
    case "owner_lost":
      requireCondition(update.owner_instance_id === run.owner_instance_id);
      next.state = "terminal";
      next.status = "INCOMPLETE";
      next.phase = "complete";
      next.reason = "supervisor_lost";
      next.ended_at = update.at;
      next.recovered_at = update.at;
      next.duration_basis = "last_checkpoint_lower_bound";
      if (run.started_at !== null && !cleanupComplete(run)) {
        next.cleanup.recovery_required = true;
      } else if (run.started_at !== null && run.cleanup.state === "not_needed") {
        next.cleanup = { state: "pending", reason: "supervisor_lost", recovery_required: true };
      }
      break;
  }
  next.updated_at = update.at;
  next.operation_sequence += 1;
  try {
    return parseValidationRun(next);
  } catch (error) {
    if (error instanceof ValidationRunError) throw new ValidationRunError("VALIDATION_RUN_INVALID_TRANSITION");
    throw error;
  }
}
