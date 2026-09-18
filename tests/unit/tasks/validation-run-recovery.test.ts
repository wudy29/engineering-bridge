import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validationFixture, PATCH } from "../../helpers/validation-run-fixture.js";
import { ControlledPatchValidationRunService as Service } from "../../../src/tasks/controlled-patch-validation-run-service.js";
import { ValidationRunStore } from "../../../src/tasks/validation-run-store.js";
import { ValidationRunWorktree } from "../../../src/tasks/validation-run-worktree.js";
import type { ValidationRunEvent } from "../../../src/tasks/validation-run.js";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
const cases = ["admitted", "parent_plan", "empty_parent", "before_apply", "preparation", "validation", "before_cleanup", "during_cleanup", "terminal"] as const;

test("minimal restart preserves even an empty owned parent without accessing it or clearing its fence", async t => {
  const f = await validationFixture(t);
  const store = new ValidationRunStore(f.directory);
  let run = await store.admit({ patch_task_id: f.patchTaskId, idempotency_key: "preserve-empty", workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: (await f.profiles.get("workspace"))! });
  const update = async (event: any) => { run = await store.update(run.validation_run_id, run.operation_sequence, { ...event, at: new Date().toISOString() }); };
  await update({ type: "start", owner_instance_id: "lost" });
  const manager = new ValidationRunWorktree(f.tempRoot);
  await update({ type: "worktree_owned", owned_worktree: manager.plan(run) });
  await update({ type: "worktree_receipt", owned_worktree: await manager.createParent(run) });
  const owned = run.owned_worktree!;
  const marker = join(owned.parent_path, ".engineering-bridge-validation-run");
  const before = await fs.readFile(marker, "utf8");
  let oldPathAccesses = 0;
  const lstat = fs.lstat.bind(fs);
  const probe = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.tempRoot || String(args[0]).startsWith(f.tempRoot + "/")) {
      oldPathAccesses++; throw Error("restart must not inspect old validation paths");
    }
    return lstat(...args);
  });
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], runner: { async runSupervised(): Promise<never> { throw Error("restart must not spawn"); } } };
  const service = await Service.open(options); f.cleanup.push(() => service.shutdown());
  const result = (await service.get(run.validation_run_id))!;
  assert.equal(oldPathAccesses, 0);
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "supervisor_lost");
  assert.deepEqual(result.owned_worktree, owned); assert.deepEqual(result.cleanup, run.cleanup);
  probe.mock.restore(); assert.equal(await fs.readFile(marker, "utf8"), before);
  await service.shutdown();
  // Explicit fixture action is not a retained recovery authorization.
  await fs.rm(owned.parent_path, { recursive: true });
  const restarted = await Service.open(options); f.cleanup.push(() => restarted.shutdown());
  assert.equal((await restarted.get(run.validation_run_id))?.cleanup.recovery_required, true);
  await assert.rejects(restarted.start({ patch_task_id: f.patchTaskId, idempotency_key: "new-after-manual-removal" }), { code: "VALIDATION_RECOVERY_REQUIRED" });
  assert.equal((await restarted.start({ patch_task_id: f.patchTaskId, idempotency_key: "preserve-empty" })).validation_run_id, run.validation_run_id);
});

for (const stage of cases) test("restart at " + stage + " never executes or attaches and preserves uncertain resources", async t => {
  const f = await validationFixture(t);
  await f.profiles.configure("workspace", { preparation: [{ name: "prepare", argv: ["unused-prepare"] }], validation: [{ name: "pytest", argv: ["unused-pytest"] }], defaultStepTimeoutSeconds: 900, totalTimeoutSeconds: 2100 });
  const store = new ValidationRunStore(f.directory);
  let run = await store.admit({ patch_task_id: f.patchTaskId, idempotency_key: stage, workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: (await f.profiles.get("workspace"))! });
  const update = async (event: any) => { run = await store.update(run.validation_run_id, run.operation_sequence, { ...event, at: new Date().toISOString() } as ValidationRunEvent); };
  const manager = new ValidationRunWorktree(f.tempRoot);
  const git = async (cwd: string, args: readonly string[]) => execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (stage !== "admitted") {
    await update({ type: "start", owner_instance_id: "previous-supervisor" });
    await update({ type: "worktree_owned", owned_worktree: manager.plan(run) });
    if (stage !== "parent_plan") {
      await update({ type: "worktree_receipt", owned_worktree: await manager.createParent(run) });
      if (stage !== "empty_parent") {
        await update({ type: "worktree_receipt", owned_worktree: await manager.register(run, git) });
        if (stage !== "before_apply") {
          await update({ type: "phase", phase: "candidate_apply" });
          await update({ type: "step_started", phase: "preparation", index: 0 });
          if (stage !== "preparation") {
            await update({ type: "step_completed", outcome: { kind: "exit", exit_code: 0, duration_ms: 2, output_tail: "prepared" } });
            await update({ type: "step_started", phase: "validation", index: 0 });
          }
          if (["before_cleanup", "during_cleanup", "terminal"].includes(stage)) {
            await update({ type: "step_completed", outcome: { kind: "exit", exit_code: 0, duration_ms: 3, output_tail: "validated" } });
            if (stage !== "before_cleanup") await update({ type: "cleanup", cleanup: { state: "pending", reason: null, recovery_required: true } });
            if (stage === "terminal") {
              await manager.cleanup(run, git, new AbortController().signal, true);
              await update({ type: "cleanup", cleanup: { state: "success", reason: null, recovery_required: false } });
              await update({ type: "finish", total_duration_ms: 5 });
            }
          }
        }
      }
    }
  }
  const before = run;
  const filename = join(f.directory, run.validation_run_id + ".json");
  const bytes = await fs.readFile(filename, "utf8");
  let executions = 0, pidProbes = 0;
  t.mock.method(process, "kill", () => { pidProbes++; throw Error("run PID must not be inspected or signaled"); });
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], runner: { async runSupervised(): Promise<never> { executions++; throw Error("no restart execution"); } } };
  const service = await Service.open(options); f.cleanup.push(() => service.shutdown());
  const result = (await service.get(run.validation_run_id))!;
  assert.equal(result.state, "terminal"); assert.equal(result.status, stage === "terminal" ? "PASS" : "INCOMPLETE");
  assert.equal(result.proposal_fingerprint, before.proposal_fingerprint); assert.equal(result.profile_sha256, before.profile_sha256);
  assert.deepEqual(result.steps, before.steps); assert.deepEqual(result.current_step, before.current_step);
  assert.equal(executions, 0); assert.equal(pidProbes, 0);
  if (stage === "terminal") assert.equal(await fs.readFile(filename, "utf8"), bytes);
  else assert.equal(result.reason, "supervisor_lost");
  if (!["admitted", "terminal"].includes(stage)) {
    assert.equal(result.cleanup.recovery_required, true);
    if (stage !== "parent_plan") assert.equal((await fs.stat(before.owned_worktree!.parent_path)).isDirectory(), true);
    await assert.rejects(service.start({ patch_task_id: f.patchTaskId, idempotency_key: "not-a-retry" }), { code: "VALIDATION_RECOVERY_REQUIRED" });
  }
  assert.equal((await service.start({ patch_task_id: f.patchTaskId, idempotency_key: stage })).validation_run_id, run.validation_run_id);
  const after = await fs.readFile(filename, "utf8");
  await service.get(run.validation_run_id); await service.latest(f.patchTaskId);
  assert.equal(await fs.readFile(filename, "utf8"), after);
  await service.shutdown();
  const again = await Service.open(options); f.cleanup.push(() => again.shutdown());
  assert.equal((await again.get(run.validation_run_id))?.status, result.status); assert.equal(executions, 0);
});

for (const corrupt of ["json", "schema"] as const) test("corrupted retained " + corrupt + " blocks recovery/admission without executing or replacing bytes", async t => {
  const f = await validationFixture(t);
  const store = new ValidationRunStore(f.directory);
  const run = await store.admit({ patch_task_id: f.patchTaskId, idempotency_key: "bad", workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: (await f.profiles.get("workspace"))! });
  const file = join(f.directory, run.validation_run_id + ".json");
  const value = corrupt === "json" ? "{broken" : JSON.stringify({ ...run, schema_version: 999 });
  await fs.writeFile(file, value);
  const service = await Service.open({ registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], runner: { async runSupervised(): Promise<never> { throw Error("must not execute"); } } });
  f.cleanup.push(() => service.shutdown());
  await assert.rejects(service.start({ patch_task_id: f.patchTaskId, idempotency_key: "blocked" }), { code: "VALIDATION_STORE_UNAVAILABLE" });
  await assert.rejects(service.get(run.validation_run_id), { code: corrupt === "json" ? "VALIDATION_RUN_CORRUPT" : "VALIDATION_RUN_INCOMPATIBLE" });
  await assert.rejects(new ValidationRunStore(f.directory).get(run.validation_run_id), { code: corrupt === "json" ? "VALIDATION_RUN_CORRUPT" : "VALIDATION_RUN_INCOMPATIBLE" });
  assert.equal(await fs.readFile(file, "utf8"), value);
});
test("invalid tempRoot construction cannot leak the store owner or block a corrected open", async t => {
  const f = await validationFixture(t);
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace] };
  await assert.rejects(Service.open({ ...options, tempRoot: f.tempRoot + "/" }));
  await assert.rejects(fs.stat(f.directory + ".owner.json"), { code: "ENOENT" });
  await assert.rejects(fs.stat(f.directory + ".owner-guard"), { code: "ENOENT" });
  const corrected = await Service.open(options); f.cleanup.push(() => corrected.shutdown());
});
test("corrupt sibling blocks admission but healthy terminal evidence remains queryable and dead running is not served as live", async t => {
  const f = await validationFixture(t);
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace] };
  const store = new ValidationRunStore(f.directory);
  const input = { patch_task_id: f.patchTaskId, idempotency_key: "healthy", workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: null };
  const healthy = await store.admit(input);
  await store.update(healthy.validation_run_id, healthy.operation_sequence, { type: "finish", at: new Date().toISOString(), total_duration_ms: 0, reason: "missing_profile" });
  const running = await store.admit({ ...input, patch_task_id: "other-running", idempotency_key: "running" });
  const bad = await store.admit({ ...input, patch_task_id: "corrupt", idempotency_key: "corrupt" });
  const healthyFile = join(f.directory, healthy.validation_run_id + ".json");
  const before = await fs.readFile(healthyFile, "utf8");
  await fs.writeFile(join(f.directory, bad.validation_run_id + ".json"), "{broken");
  const service = await Service.open(options); f.cleanup.push(() => service.shutdown());
  assert.equal((await service.get(healthy.validation_run_id))?.status, "INCOMPLETE");
  await assert.rejects(service.get(bad.validation_run_id), { code: "VALIDATION_RUN_CORRUPT" });
  await assert.rejects(service.get(running.validation_run_id), { code: "VALIDATION_STORE_UNAVAILABLE" });
  await assert.rejects(service.start({ patch_task_id: f.patchTaskId, idempotency_key: "another-start" }), { code: "VALIDATION_STORE_UNAVAILABLE" });
  assert.equal((await service.get(healthy.validation_run_id))?.status, "INCOMPLETE");
  assert.equal(await fs.readFile(healthyFile, "utf8"), before);
});
test("failed recovery persistence cannot make latest discovery advertise a dead running supervisor", async t => {
  const f = await validationFixture(t);
  const store = new ValidationRunStore(f.directory);
  const run = await store.admit({ patch_task_id: f.patchTaskId, idempotency_key: "failed-recovery", workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: null });
  const open = fs.open.bind(fs);
  const fault = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).startsWith(f.directory + "/") && args[1] === "wx") throw Error("cannot commit recovery");
    return open(...args);
  });
  const service = await Service.open({ registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace] });
  f.cleanup.push(() => service.shutdown());
  await assert.rejects(service.get(run.validation_run_id), { code: "VALIDATION_STORE_UNAVAILABLE" });
  await assert.rejects(service.latest(f.patchTaskId), { code: "VALIDATION_STORE_UNAVAILABLE" });
  fault.mock.restore();
});
