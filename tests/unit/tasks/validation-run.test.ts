import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ValidationProfile } from "../../../src/tasks/validation-profile-store.js";
import {
  createValidationRun,
  parseValidationRun,
  proposalFingerprint,
  transitionValidationRun,
  ValidationRunError,
} from "../../../src/tasks/validation-run.js";
import type {
  ValidationRun,
  ValidationRunAdmission,
  ValidationRunEvent,
} from "../../../src/tasks/validation-run.js";

const AT = "2026-09-12T01:00:00.000Z";
const LATER = "2026-09-12T01:00:02.000Z";
const PROFILE: ValidationProfile = {
  preparation: [{ name: "same", argv: ["npm", "ci"] }],
  validation: [{ name: "same", argv: ["npm", "test"], timeoutSeconds: 90 }],
  defaultStepTimeoutSeconds: 600,
  totalTimeoutSeconds: 1200,
};
const INPUT: ValidationRunAdmission = {
  idempotency_key: "request-1",
  patch_task_id: "patch-1",
  workspace_id: "workspace-1",
  workspace_root: "/example/workspace",
  base_head: "a".repeat(40),
  patch: "diff --git a/a b/a\n+hello 世界\n",
  profile: PROFILE,
};
const METADATA = {
  validation_run_id: "b2acb995-2b6f-40dc-958a-7b128dfeb9d1",
  admission_sequence: 1,
  admitted_at: AT,
};
function admitted(input: ValidationRunAdmission = INPUT): ValidationRun {
  return createValidationRun(input, METADATA);
}
function change(run: ValidationRun, event: unknown): ValidationRun {
  return transitionValidationRun(run, event as ValidationRunEvent);
}
function code(action: () => unknown, expected: string): void {
  assert.throws(action, (error: unknown) => error instanceof ValidationRunError && error.code === expected);
}
function persisted(run: ValidationRun): Record<string, any> {
  return JSON.parse(JSON.stringify(run)) as Record<string, any>;
}

test("admission freezes the complete resolved profile without retaining the patch", () => {
  const mutable = structuredClone(PROFILE);
  const run = admitted({ ...INPUT, profile: mutable });
  assert.equal(run.schema_version, 1);
  assert.equal(run.operation_sequence, 0);
  assert.equal(run.admission_sequence, 1);
  assert.equal(run.state, "running");
  assert.equal(run.status, null);
  assert.equal(run.phase, "admitted");
  assert.equal(run.admitted_at, AT);
  assert.equal(run.started_at, null);
  assert.equal(run.updated_at, AT);
  assert.equal(run.ended_at, null);
  assert.equal(run.owner_instance_id, null);
  assert.equal(run.owned_worktree, null);
  assert.equal(Object.hasOwn(run, "patch"), false);
  assert.deepEqual(run.profile_snapshot, {
    preparation: [{ name: "same", argv: ["npm", "ci"], timeout_seconds: 600 }],
    validation: [{ name: "same", argv: ["npm", "test"], timeout_seconds: 90 }],
    default_step_timeout_seconds: 600,
    total_timeout_seconds: 1200,
  });
  (mutable.preparation[0]!.argv as unknown as string[])[0] = "changed";
  assert.equal(run.profile_snapshot!.preparation[0]!.argv[0], "npm");
  assert.ok(Object.isFrozen(run));
  assert.ok(Object.isFrozen(run.profile_snapshot!.preparation[0]!.argv));
  assert.ok(Object.isFrozen(run.cleanup));
  assert.equal(run.patch_sha256, createHash("sha256").update(INPUT.patch, "utf8").digest("hex"));
});

test("proposal fingerprints bind exact UTF-8 patch bytes, root, workspace and base", () => {
  const original = proposalFingerprint(INPUT);
  for (const changed of [
    { patch: INPUT.patch.replaceAll("\n", "\r\n") },
    { patch: `${INPUT.patch} ` },
    { workspace_id: "other" },
    { workspace_root: "/other/workspace" },
    { base_head: "b".repeat(40) },
    { base_head: null },
  ]) assert.notEqual(proposalFingerprint({ ...INPUT, ...changed }), original);
  assert.equal(proposalFingerprint({
    patch: INPUT.patch, base_head: INPUT.base_head,
    workspace_root: INPUT.workspace_root, workspace_id: INPUT.workspace_id,
  }), original);
});

test("canonical profile hash ignores object construction order and binds all resolved content", () => {
  const original = admitted();
  const reordered = admitted({ ...INPUT, profile: {
    totalTimeoutSeconds: 1200, defaultStepTimeoutSeconds: 600,
    validation: [{ timeoutSeconds: 90, argv: ["npm", "test"], name: "same" }],
    preparation: [{ timeoutSeconds: 600, argv: ["npm", "ci"], name: "same" }],
  } });
  assert.equal(reordered.profile_sha256, original.profile_sha256);
  for (const profile of [
    { ...PROFILE, preparation: [] },
    { ...PROFILE, validation: [{ name: "same", argv: ["npm", "other"] as const, timeoutSeconds: 90 }] },
    { ...PROFILE, totalTimeoutSeconds: 1201 },
    { ...PROFILE, defaultStepTimeoutSeconds: 601 },
  ]) assert.notEqual(admitted({ ...INPUT, profile }).profile_sha256, original.profile_sha256);
});

test("empty and absent profiles and unborn base are distinct valid admissions", () => {
  const empty = admitted({ ...INPUT, profile: { ...PROFILE, preparation: [], validation: [] } });
  assert.equal(empty.profile_snapshot!.validation.length, 0);
  const absent = admitted({ ...INPUT, profile: null, base_head: null });
  assert.equal(absent.profile_snapshot, null);
  assert.equal(absent.profile_sha256, null);
  assert.equal(absent.base_head, null);
  assert.deepEqual(parseValidationRun(persisted(absent)), absent);
});

test("admission rejects malformed IDs, nonabsolute roots and unsupported profile data", () => {
  for (const changed of [
    { idempotency_key: "../key" }, { idempotency_key: "k".repeat(129) },
    { workspace_root: "relative" }, { patch_task_id: "" },
    { profile: { ...PROFILE, defaultStepTimeoutSeconds: 0 } },
    { profile: { ...PROFILE, validation: [{ name: "empty", argv: [] }] } },
    { profile: { ...PROFILE, extra: true } },
  ]) code(() => admitted({ ...INPUT, ...changed } as ValidationRunAdmission), "VALIDATION_RUN_INVALID_INPUT");
  for (const changed of [
    { validation_run_id: "../record" }, { admission_sequence: -1 },
    { admitted_at: "not-time" },
  ]) code(() => createValidationRun(INPUT, { ...METADATA, ...changed }), "VALIDATION_RUN_INVALID_INPUT");
});

test("record parsing clones, freezes and verifies persisted fingerprints", () => {
  const original = admitted();
  const raw = persisted(original);
  const reloaded = parseValidationRun(raw);
  raw.profile_snapshot.preparation[0].argv[0] = "altered";
  assert.deepEqual(reloaded, original);
  assert.ok(Object.isFrozen(reloaded.profile_snapshot!.validation));
  for (const mutate of [
    (value: Record<string, any>) => { value.patch_sha256 = "0".repeat(64); },
    (value: Record<string, any>) => { value.workspace_root = "/elsewhere"; },
    (value: Record<string, any>) => { value.profile_snapshot.validation[0].argv[1] = "other"; },
    (value: Record<string, any>) => { value.profile_sha256 = "0".repeat(64); },
    (value: Record<string, any>) => { value.extra = true; },
    (value: Record<string, any>) => { value.cleanup.extra = true; },
  ]) {
    const value = persisted(original);
    mutate(value);
    code(() => parseValidationRun(value), "VALIDATION_RUN_CORRUPT");
  }
});

test("incompatible schema is distinct from malformed persisted records", () => {
  code(() => parseValidationRun({ ...persisted(admitted()), schema_version: 2 }), "VALIDATION_RUN_INCOMPATIBLE");
  for (const value of [null, {}, [], { schema_version: "1" }, { ...persisted(admitted()), operation_sequence: -1 }]) {
    code(() => parseValidationRun(value), "VALIDATION_RUN_CORRUPT");
  }
});

function started(input: ValidationRunAdmission = INPUT): ValidationRun {
  return change(admitted(input), { type: "start", at: AT, owner_instance_id: "owner-1" });
}
function completed(run: ValidationRun, phase: "preparation" | "validation", index: number, exit_code = 0): ValidationRun {
  return change(change(run, { type: "step_started", at: AT, phase, index }), {
    type: "step_completed", at: LATER,
    outcome: { kind: "exit", exit_code, duration_ms: 20, output_tail: "retained evidence" },
  });
}
function goodCleanup(run: ValidationRun): ValidationRun {
  return change(run, { type: "cleanup", at: LATER, cleanup: { state: "success", reason: null, recovery_required: false } });
}
function passed(): ValidationRun {
  return change(goodCleanup(completed(completed(started(), "preparation", 0), "validation", 0)), {
    type: "finish", at: LATER, total_duration_ms: 2000,
  });
}
function worktree(run: ValidationRun): NonNullable<ValidationRun["owned_worktree"]> {
  const parent_path = `/private/validation/engineering-bridge-validation-${run.validation_run_id}`;
  return { expected_temp_root: "/private/validation", parent_path, worktree_path: `${parent_path}/worktree`,
    parent_identity: { dev: "1", ino: "20" }, common_git_dir: "/example/workspace/.git", run_marker: run.validation_run_id };
}

test("ordered preparation and validation with duplicate names earn PASS and immutable evidence", () => {
  const run = passed();
  assert.equal(run.state, "terminal");
  assert.equal(run.status, "PASS");
  assert.equal(run.phase, "complete");
  assert.equal(run.current_step, null);
  assert.equal(run.steps.length, 2);
  assert.deepEqual(run.steps.map(({ phase, index, name, status, exit_code }) => ({ phase, index, name, status, exit_code })), [
    { phase: "preparation", index: 0, name: "same", status: "PASS", exit_code: 0 },
    { phase: "validation", index: 0, name: "same", status: "PASS", exit_code: 0 },
  ]);
  assert.equal(run.total_duration_ms, 2000);
  assert.equal(run.duration_basis, "measured");
  assert.equal(run.started_at, AT);
  assert.equal(run.ended_at, LATER);
  assert.equal(run.operation_sequence, 7);
  assert.ok(Object.isFrozen(run.steps[0]));
  assert.deepEqual(parseValidationRun(persisted(run)), run);
});

test("a configured nonzero step produces FAIL only after cleanup disposition", () => {
  const failed = completed(started(), "preparation", 0, 2);
  const run = change(goodCleanup(failed), { type: "finish", at: LATER, total_duration_ms: 2000 });
  assert.equal(run.status, "FAIL");
  assert.equal(run.steps[0]!.exit_code, 2);
  assert.equal(run.steps[0]!.status, "FAIL");
  assert.equal(run.steps.length, 1);
  assert.equal(run.reason, null);
  assert.deepEqual(parseValidationRun(persisted(run)), run);
});

test("cleanup failure produces INCOMPLETE without erasing a known failed step", () => {
  let run = completed(started(), "preparation", 0, 2);
  run = change(run, { type: "cleanup", at: LATER, cleanup: { state: "failed", reason: "cleanup_timeout", recovery_required: true } });
  run = change(run, { type: "finish", at: LATER, total_duration_ms: 2000 });
  assert.equal(run.status, "INCOMPLETE");
  assert.equal(run.reason, "cleanup_timeout");
  assert.equal(run.steps[0]!.status, "FAIL");
  assert.equal(run.steps[0]!.exit_code, 2);
  assert.equal(run.cleanup.recovery_required, true);
});

test("step timeout preserves partial evidence with no invented exit code", () => {
  let run = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  run = change(run, { type: "step_completed", at: LATER, outcome: {
    kind: "incomplete", reason: "step_timeout", duration_ms: 1000, output_tail: "last test line",
  } });
  run = change(goodCleanup(run), { type: "finish", at: LATER, total_duration_ms: 2000 });
  assert.equal(run.status, "INCOMPLETE");
  assert.equal(run.reason, "step_timeout");
  assert.equal(run.steps[0]!.exit_code, null);
  assert.equal(run.steps[0]!.output_tail, "last test line");
});

test("an explicit interruption reason cannot turn successful evidence into PASS", () => {
  const run = change(goodCleanup(completed(completed(started(), "preparation", 0), "validation", 0)), {
    type: "finish", at: LATER, total_duration_ms: 2000, reason: "total_timeout",
  });
  assert.equal(run.status, "INCOMPLETE");
  assert.equal(run.reason, "total_timeout");
  assert.deepEqual(run.steps.map((step) => step.status), ["PASS", "PASS"]);
});

test("absent profile and unborn base terminate explicitly as INCOMPLETE", () => {
  for (const [input, expected] of [
    [{ ...INPUT, profile: null }, "missing_profile"],
    [{ ...INPUT, base_head: null }, "unborn_base"],
  ] as const) {
    const run = change(admitted(input), { type: "finish", at: LATER, total_duration_ms: 0 });
    assert.equal(run.status, "INCOMPLETE");
    assert.equal(run.reason, expected);
    assert.equal(run.started_at, null);
  }
});

test("empty profiles need explicit start before completion can earn PASS", () => {
  const input = { ...INPUT, profile: { ...PROFILE, preparation: [], validation: [] } };
  code(() => change(admitted(input), { type: "finish", at: LATER, total_duration_ms: 0 }), "VALIDATION_RUN_INVALID_TRANSITION");
  const run = change(started(input), { type: "finish", at: LATER, total_duration_ms: 0 });
  assert.equal(run.status, "PASS");
  assert.deepEqual(run.steps, []);
});

test("checkpoint keeps the encoded UTF-8 suffix within 65536 bytes and never splits a character", () => {
  const original = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  const huge = `${"🙂".repeat(20_000)}END`;
  const run = change(original, { type: "progress", at: LATER, total_duration_ms: 1000, step_duration_ms: 900, output_tail: huge });
  assert.equal(run.current_step!.output_tail, `${"🙂".repeat(16_383)}END`);
  assert.ok(Buffer.byteLength(run.current_step!.output_tail, "utf8") <= 65_536);
  assert.equal(run.current_step!.output_tail.includes("�"), false);
  assert.equal(run.current_step!.duration_ms, 900);
  assert.equal(run.total_duration_ms, 1000);
  assert.equal(original.current_step!.output_tail, "");
  const finished = change(run, { type: "step_completed", at: LATER, outcome: {
    kind: "exit", exit_code: 0, duration_ms: 1000, output_tail: `${"界".repeat(30_000)}Z`,
  } });
  assert.equal(finished.steps[0]!.output_tail, `${"界".repeat(21_845)}Z`);
  assert.ok(Buffer.byteLength(finished.steps[0]!.output_tail, "utf8") <= 65_536);
  assert.deepEqual(parseValidationRun(persisted(finished)), finished);
});

test("phase and step transitions reject late, skipped, repeated or arbitrary replacements", () => {
  const start = started();
  const validation = completed(start, "preparation", 0);
  const current = change(start, { type: "step_started", at: AT, phase: "preparation", index: 0 });
  const failed = completed(start, "preparation", 0, 1);
  for (const [run, event] of [
    [admitted(), { type: "step_started", at: AT, phase: "preparation", index: 0 }],
    [start, { type: "start", at: AT, owner_instance_id: "owner-2" }],
    [start, { type: "step_started", at: AT, phase: "validation", index: 0 }],
    [start, { type: "step_started", at: AT, phase: "preparation", index: 1 }],
    [validation, { type: "step_started", at: AT, phase: "preparation", index: 0 }],
    [current, { type: "step_started", at: AT, phase: "preparation", index: 0 }],
    [failed, { type: "step_started", at: AT, phase: "validation", index: 0 }],
    [validation, { type: "phase", at: AT, phase: "preflight" }],
    [current, { type: "finish", at: LATER, total_duration_ms: 2000, reason: "bridge_shutdown" }],
    [start, { type: "finish", at: LATER, total_duration_ms: 2000 }],
    [start, { type: "set_record", at: AT, record: passed() }],
    [start, { type: "phase", at: AT, phase: "worktree", status: "PASS" }],
  ] as const) code(() => change(run, event), "VALIDATION_RUN_INVALID_TRANSITION");
});

test("progress and final duration cannot regress the last observed duration", () => {
  const current = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  const run = change(current, { type: "progress", at: LATER, total_duration_ms: 1000, step_duration_ms: 900 });
  for (const event of [
    { type: "progress", at: LATER, total_duration_ms: 999 },
    { type: "progress", at: LATER, total_duration_ms: 1000, step_duration_ms: 899 },
    { type: "step_completed", at: LATER, outcome: { kind: "exit", exit_code: 0, duration_ms: 899, output_tail: "" } },
  ]) code(() => change(run, event), "VALIDATION_RUN_INVALID_TRANSITION");
  const complete = change(run, { type: "step_completed", at: LATER, outcome: { kind: "exit", exit_code: 0, duration_ms: 1000, output_tail: "" } });
  code(() => change(complete, { type: "finish", at: LATER, total_duration_ms: 999, reason: "bridge_shutdown" }), "VALIDATION_RUN_INVALID_TRANSITION");
});

test("worktree metadata is bound to this run and implies pending required cleanup", () => {
  const start = started();
  const ownership = worktree(start);
  const run = change(start, { type: "worktree_owned", at: AT, owned_worktree: ownership });
  assert.deepEqual(run.owned_worktree, ownership);
  assert.ok(Object.isFrozen(run.owned_worktree!.parent_identity));
  assert.deepEqual(run.cleanup, { state: "pending", reason: null, recovery_required: true });
  const nullIdentity = change(start, { type: "worktree_owned", at: AT, owned_worktree: { ...ownership, parent_identity: null } });
  assert.equal(nullIdentity.owned_worktree!.parent_identity, null);
  for (const changed of [
    { worktree_path: "/elsewhere" }, { parent_path: "/private/validation/other" },
    { expected_temp_root: "/other" }, { run_marker: "47a2340e-e67b-4ddc-8b96-e19b01d631c2" },
  ]) code(() => change(start, { type: "worktree_owned", at: AT, owned_worktree: { ...ownership, ...changed } }), "VALIDATION_RUN_INVALID_TRANSITION");
  code(() => change(run, { type: "cleanup", at: LATER, cleanup: { state: "not_needed", reason: null, recovery_required: false } }), "VALIDATION_RUN_INVALID_TRANSITION");
});

test("pending cleanup forces INCOMPLETE even when all configured commands passed", () => {
  let run = change(started(), { type: "worktree_owned", at: AT, owned_worktree: worktree(started()) });
  run = completed(completed(run, "preparation", 0), "validation", 0);
  run = change(run, { type: "finish", at: LATER, total_duration_ms: 2000 });
  assert.equal(run.status, "INCOMPLETE");
  assert.equal(run.reason, "cleanup_pending");
  assert.equal(run.cleanup.recovery_required, true);
});

test("owner-lost requires explicit matching observation and preserves last checkpoint as a lower bound", () => {
  let run = completed(started(), "preparation", 0);
  run = change(run, { type: "step_started", at: AT, phase: "validation", index: 0 });
  run = change(run, { type: "progress", at: LATER, total_duration_ms: 1234, step_duration_ms: 1000, output_tail: "last durable line" });
  for (const event of [
    { type: "owner_lost", at: LATER, owner_instance_id: "owner-1" },
    { type: "owner_lost", at: LATER, owner_instance_id: "wrong", owner_loss_confirmed: true },
    { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: false },
  ]) code(() => change(run, event), "VALIDATION_RUN_INVALID_TRANSITION");
  const recovered = change(run, { type: "owner_lost", at: "2026-09-13T01:00:00.000Z", owner_instance_id: "owner-1", owner_loss_confirmed: true });
  assert.equal(recovered.status, "INCOMPLETE");
  assert.equal(recovered.reason, "supervisor_lost");
  assert.equal(recovered.total_duration_ms, 1234);
  assert.equal(recovered.duration_basis, "last_checkpoint_lower_bound");
  assert.equal(recovered.current_step!.output_tail, "last durable line");
  assert.equal(recovered.current_step!.duration_ms, 1000);
  assert.equal(recovered.steps[0]!.status, "PASS");
  assert.equal(recovered.cleanup.recovery_required, true);
  assert.equal(recovered.recovered_at, "2026-09-13T01:00:00.000Z");
  assert.equal(recovered.ended_at, recovered.recovered_at);
  assert.deepEqual(parseValidationRun(persisted(recovered)), recovered);
  assert.deepEqual(parseValidationRun(persisted(run)), run);
});

test("owner loss before start records uncertainty without inventing execution duration or resources", () => {
  const run = change(admitted(), { type: "owner_lost", at: LATER, owner_instance_id: null, owner_loss_confirmed: true });
  assert.equal(run.started_at, null);
  assert.equal(run.total_duration_ms, 0);
  assert.equal(run.current_step, null);
  assert.equal(run.owned_worktree, null);
  assert.equal(run.cleanup.recovery_required, false);
  assert.equal(run.status, "INCOMPLETE");
});

test("terminal cleanup updates cannot upgrade outcome, rewrite evidence or reopen execution", () => {
  const incomplete = change(started(), { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: true });
  const cleaned = goodCleanup(incomplete);
  assert.equal(cleaned.status, "INCOMPLETE");
  assert.equal(cleaned.reason, "supervisor_lost");
  assert.equal(cleaned.ended_at, incomplete.ended_at);
  assert.equal(cleaned.total_duration_ms, incomplete.total_duration_ms);
  assert.equal(cleaned.cleanup.recovery_required, false);
  assert.equal(cleaned.operation_sequence, incomplete.operation_sequence + 1);
  for (const event of [
    { type: "start", at: LATER, owner_instance_id: "owner-2" },
    { type: "progress", at: LATER, total_duration_ms: 1000 },
    { type: "finish", at: LATER, total_duration_ms: 0 },
    { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: true },
    { type: "cleanup", at: LATER, cleanup: { state: "pending", reason: null, recovery_required: true } },
  ]) code(() => change(cleaned, event), "VALIDATION_RUN_INVALID_TRANSITION");
  code(() => change(passed(), { type: "cleanup", at: LATER, cleanup: { state: "failed", reason: "cleanup_failure", recovery_required: true } }), "VALIDATION_RUN_INVALID_TRANSITION");
});

test("persisted records reject fabricated completion, mismatched steps and invalid lifecycle combinations", () => {
  for (const mutate of [
    (value: Record<string, any>) => { value.steps.pop(); },
    (value: Record<string, any>) => { value.steps[0].exit_code = 1; },
    (value: Record<string, any>) => { value.steps[0].index = 1; },
    (value: Record<string, any>) => { value.steps[0].name = "invented"; },
    (value: Record<string, any>) => { value.steps[0].output_tail = "界".repeat(30_000); },
    (value: Record<string, any>) => { value.cleanup = { state: "pending", reason: null, recovery_required: true }; },
    (value: Record<string, any>) => { value.started_at = null; },
    (value: Record<string, any>) => { value.ended_at = null; },
    (value: Record<string, any>) => { value.state = "running"; },
    (value: Record<string, any>) => { value.status = "FAIL"; },
  ]) {
    const value = persisted(passed());
    mutate(value);
    code(() => parseValidationRun(value), "VALIDATION_RUN_CORRUPT");
  }
  const badCurrent = persisted(change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 }));
  badCurrent.current_step.index = 1;
  code(() => parseValidationRun(badCurrent), "VALIDATION_RUN_CORRUPT");
  const forgedAdmission = persisted(admitted());
  forgedAdmission.owner_instance_id = "invented";
  code(() => parseValidationRun(forgedAdmission), "VALIDATION_RUN_CORRUPT");
});

test("supervisor_lost cannot bypass the explicit owner-loss confirmation event", () => {
  code(() => change(started(), { type: "finish", at: LATER, total_duration_ms: 0, reason: "supervisor_lost" }), "VALIDATION_RUN_INVALID_TRANSITION");
  const forged = persisted(change(started(), { type: "finish", at: LATER, total_duration_ms: 0, reason: "bridge_shutdown" }));
  forged.reason = "supervisor_lost";
  code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
});

test("persisted phases must agree with actual step checkpoints and admission sequence", () => {
  for (const phase of ["preparation", "validation"]) {
    const forged = persisted(started());
    forged.phase = phase;
    code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
  }
  const beforeSteps = persisted(completed(started(), "preparation", 0));
  beforeSteps.phase = "candidate_apply";
  code(() => parseValidationRun(beforeSteps), "VALIDATION_RUN_CORRUPT");
  const forgedAdmission = persisted(admitted());
  forgedAdmission.operation_sequence = 1;
  code(() => parseValidationRun(forgedAdmission), "VALIDATION_RUN_CORRUPT");
});

test("serialized output tails cannot contain invalid Unicode scalar sequences", () => {
  const run = completed(started(), "preparation", 0);
  const corrupted = persisted(run);
  corrupted.steps[0].output_tail = "dangling\ud800";
  code(() => parseValidationRun(corrupted), "VALIDATION_RUN_CORRUPT");
  const current = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  const canonical = change(current, { type: "progress", at: AT, total_duration_ms: 0, output_tail: "dangling\ud800" });
  assert.equal(canonical.current_step!.output_tail, "dangling�");
});

test("running step checkpoints reject cleanup states that could bypass recovery fencing", () => {
  const current = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  for (const cleanup of [
    { state: "success", reason: null, recovery_required: false },
    { state: "failed", reason: "cleanup_failure", recovery_required: true },
  ]) {
    const forged = { ...persisted(current), cleanup };
    code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
    code(() => change(forged as ValidationRun, { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: true }), "VALIDATION_RUN_CORRUPT");
  }
  const recovered = change(current, { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: true });
  assert.equal(recovered.cleanup.recovery_required, true);
  const cleaned = goodCleanup(recovered);
  assert.equal(cleaned.cleanup.recovery_required, false);
  assert.equal(cleaned.status, "INCOMPLETE");
  assert.deepEqual(cleaned.current_step, current.current_step);
  assert.deepEqual(parseValidationRun(persisted(cleaned)), cleaned);
});

test("running cleanup success must have an actual cleanup checkpoint", () => {
  for (const original of [started(), completed(started(), "preparation", 0)]) {
    const forged = persisted(original);
    forged.cleanup = { state: "success", reason: null, recovery_required: false };
    code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
  }
  assert.deepEqual(parseValidationRun(persisted(goodCleanup(started()))), goodCleanup(started()));
});

test("an unborn proposal cannot have current or completed configured-step evidence", () => {
  const current = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  for (const original of [current, completed(started(), "preparation", 0)]) {
    const forged = persisted(original);
    forged.base_head = null;
    forged.proposal_fingerprint = proposalFingerprint({ ...INPUT, base_head: null });
    code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
  }
});

test("zero-sequence admission cannot claim cleanup activity", () => {
  for (const cleanup of [
    { state: "success", reason: null, recovery_required: false },
    { state: "pending", reason: null, recovery_required: true },
    { state: "failed", reason: "cleanup_failure", recovery_required: true },
  ]) code(() => parseValidationRun({ ...persisted(admitted()), cleanup }), "VALIDATION_RUN_CORRUPT");
});

test("configured nonempty step names and argv are retained without a new name-length restriction", () => {
  const name = "configured name ".repeat(40);
  const profile: ValidationProfile = {
    preparation: [], validation: [{ name, argv: ["", "", "literal\u0000argument"] }],
    defaultStepTimeoutSeconds: Number.MAX_SAFE_INTEGER,
    totalTimeoutSeconds: Number.MAX_SAFE_INTEGER,
  };
  const run = completed(started({ ...INPUT, profile }), "validation", 0);
  assert.equal(run.steps[0]!.name, name);
  assert.deepEqual(run.profile_snapshot!.validation[0]!.argv, ["", "", "literal\u0000argument"]);
  assert.equal(run.profile_snapshot!.validation[0]!.timeout_seconds, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(parseValidationRun(persisted(run)), run);
});

test("source profiles reject nonplain objects and explicitly undefined timeout keys like configuration does", () => {
  const nullPrototypeProfile = Object.assign(Object.create(null) as object, PROFILE);
  const nullPrototypeStep = Object.assign(Object.create(null) as object, { name: "step", argv: ["npm"] });
  for (const profile of [
    nullPrototypeProfile,
    { ...PROFILE, preparation: [nullPrototypeStep] },
    { ...PROFILE, preparation: [{ name: "step", argv: ["npm"], timeoutSeconds: undefined }] },
    { ...PROFILE, preparation: [{ name: "step", argv: ["npm", 1] }] },
    { ...PROFILE, preparation: [{ name: "step", argv: ["npm"], timeoutSeconds: 0.5 }] },
    { ...PROFILE, totalTimeoutSeconds: Number.MAX_SAFE_INTEGER + 1 },
  ]) code(() => admitted({ ...INPUT, profile } as ValidationRunAdmission), "VALIDATION_RUN_INVALID_INPUT");
});

test("operation sequence includes mandatory ownership and explicit cleanup events", () => {
  const owned = change(started(), { type: "worktree_owned", at: AT, owned_worktree: worktree(started()) });
  const pendingCleanup = change(started(), { type: "cleanup", at: LATER, cleanup: { state: "pending", reason: null, recovery_required: true } });
  const failedCleanup = change(started(), { type: "cleanup", at: LATER, cleanup: { state: "failed", reason: "cleanup_failure", recovery_required: true } });
  for (const original of [owned, pendingCleanup, failedCleanup, goodCleanup(started())]) {
    const forged = persisted(original);
    forged.operation_sequence = 1;
    code(() => parseValidationRun(forged), "VALIDATION_RUN_CORRUPT");
    assert.deepEqual(parseValidationRun(persisted(original)), original);
  }
  const current = change(started(), { type: "step_started", at: AT, phase: "preparation", index: 0 });
  assert.equal(current.operation_sequence, 2);
  assert.deepEqual(parseValidationRun(persisted(current)), current);
  const recovered = change(started(), { type: "owner_lost", at: LATER, owner_instance_id: "owner-1", owner_loss_confirmed: true });
  assert.equal(recovered.operation_sequence, 2);
  assert.deepEqual(parseValidationRun(persisted(recovered)), recovered);
});
