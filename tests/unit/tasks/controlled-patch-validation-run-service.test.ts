import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { validationFixture, until, PATCH } from "../../helpers/validation-run-fixture.js";
import { ValidationProcessRunner, type ValidationProcessControl, type ValidationProcessRequest } from "../../../src/tasks/validation-process-runner.js";
import { ValidationRunStore } from "../../../src/tasks/validation-run-store.js";

const moduleUrl = new URL("../../../src/tasks/controlled-patch-validation-run-service.js", import.meta.url);
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
async function Service() {
  const module = await import(moduleUrl.href).catch(() => undefined);
  assert.equal(typeof module?.ControlledPatchValidationRunService?.open, "function", "service-owned validation coordinator exists");
  return module.ControlledPatchValidationRunService;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t: any, extra: any = {}, executorFactory?: Parameters<typeof validationFixture>[1]) {
  const Type = await Service();
  const f = await validationFixture(t, executorFactory);
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles,
    directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], ...extra };
  const service = await Type.open(options);
  f.cleanup.push(() => service.shutdown());
  return { ...f, service, options };
}
async function terminal(service: any, id: string) {
  await until(async () => (await service.get(id))?.state === "terminal");
  return service.get(id);
}
test("start returns durable admission before a blocked preflight and never waits for execution", { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred();
  const real = new ValidationProcessRunner();
  let sawDurableStart = false;
  let f: Awaited<ReturnType<typeof setup>>;
  const runner = { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (!sawDurableStart) {
      const files = (await fs.readdir(f.directory)).filter(x => x.endsWith(".json"));
      assert.equal(files.length, 1);
      const record = JSON.parse(await fs.readFile(join(f.directory, files[0]!), "utf8"));
      assert.equal(record.state, "running"); assert.equal(record.phase, "preflight"); assert.ok(record.started_at);
      sawDurableStart = true; entered.resolve(); await release.promise;
    }
    return real.runSupervised(request, control);
  } };
  f = await setup(t, { runner });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "one" });
  assert.equal(run.state, "running");
  assert.equal((await new ValidationRunStore(f.directory).get(run.validation_run_id))?.validation_run_id, run.validation_run_id);
  await entered.promise;
  assert.equal((await f.service.get(run.validation_run_id)).state, "running");
  release.resolve();
  const result = await terminal(f.service, run.validation_run_id);
  assert.equal(result.status, "PASS"); assert.equal(result.cleanup.state, "success");
  assert.equal(f.git("status", "--porcelain"), "");
});
test("snapshot and captured proposal survive CONFIGURE replacement, later APPLY and disappearance of the task view", async t => {
  const entered = deferred(), release = deferred();
  const real = new ValidationProcessRunner();
  const runner = { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (request.argv[0] !== "git") { entered.resolve(); await release.promise; }
    return real.runSupervised(request, control);
  } };
  const f = await setup(t, { runner });
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "original", argv: [process.execPath, "-e", "if(require('node:fs').readFileSync('note.txt','utf8')!=='after\\n')process.exit(8);process.stdout.write('original')"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 30 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "snapshot" });
  await entered.promise;
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "replacement", argv: [process.execPath, "-e", "process.exit(99)"] }], defaultStepTimeoutSeconds: 2, totalTimeoutSeconds: 10 });
  await f.patches.apply({ patch_task_id: f.patchTaskId, confirmation: "APPLY" });
  t.mock.method(f.tasks, "result", () => undefined);
  assert.equal((await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "snapshot" })).validation_run_id, run.validation_run_id);
  release.resolve();
  const result = await terminal(f.service, run.validation_run_id);
  assert.equal(result.status, "PASS"); assert.equal(result.steps[0].name, "original");
  assert.equal(result.steps[0].output_tail, "original");
  assert.equal(result.profile_sha256, run.profile_sha256); assert.equal(result.proposal_fingerprint, run.proposal_fingerprint);
});
test("duplicate admission race executes exactly once, distinct key is busy, explicit revalidation is new", async t => {
  const entered = deferred(), release = deferred();
  const real = new ValidationProcessRunner(); let commands = 0;
  const runner = { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (request.argv[0] !== "git") { commands++; entered.resolve(); await release.promise; }
    return real.runSupervised(request, control);
  } };
  const f = await setup(t, { runner });
  const attempts = await Promise.all(Array.from({ length: 8 }, () => f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "retry" })));
  assert.equal(new Set(attempts.map(x => x.validation_run_id)).size, 1);
  const id = attempts[0].validation_run_id;
  await entered.promise;
  await assert.rejects(f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "other" }), { code: "VALIDATION_ALREADY_RUNNING" });
  await assert.rejects(f.service.start({ patch_task_id: "different", idempotency_key: "retry" }), { code: "VALIDATION_IDEMPOTENCY_CONFLICT" });
  release.resolve(); await terminal(f.service, id);
  assert.equal(commands, 1);
  const next = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "explicit" });
  assert.notEqual(next.validation_run_id, id);
  await terminal(f.service, next.validation_run_id); assert.equal(commands, 2);
});
test("two unrelated proposals execute concurrently in distinct owned worktrees", async t => {
  const both = deferred(), release = deferred();
  const real = new ValidationProcessRunner(); const roots: string[] = [];
  const runner = { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (request.argv[0] !== "git") { roots.push(request.cwd); if (roots.length === 2) both.resolve(); await release.promise; }
    return real.runSupervised(request, control);
  } };
  const f = await setup(t, { runner });
  const other = await f.patches.submit({ workspace_id: "workspace", base_head: f.baseHead, diff: PATCH });
  const [one, two] = await Promise.all([f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "one" }), f.service.start({ patch_task_id: other.taskId, idempotency_key: "two" })]);
  await both.promise; assert.equal(new Set(roots).size, 2);
  assert.ok(roots.some(root => root.includes(one.validation_run_id)));
  assert.ok(roots.some(root => root.includes(two.validation_run_id)));
  release.resolve();
  assert.equal((await terminal(f.service, one.validation_run_id)).status, "PASS");
  assert.equal((await terminal(f.service, two.validation_run_id)).status, "PASS");
});
for (const phase of ["preparation", "validation"] as const) {
  test("nonzero " + phase + " remains FAIL with retained ordered evidence and successful cleanup", async t => {
    const f = await setup(t);
    await f.profiles.configure("workspace", { preparation: phase === "preparation" ? [{ name: "prepare", argv: [process.execPath, "-e", "process.exit(7)"] }] : [], validation: [{ name: "validate", argv: [process.execPath, "-e", "process.exit(3)"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 20 });
    const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "fail" });
    const result = await terminal(f.service, run.validation_run_id);
    assert.equal(result.status, "FAIL"); assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].phase, phase); assert.equal(result.steps[0].exit_code, phase === "preparation" ? 7 : 3);
    assert.equal(result.cleanup.state, "success");
  });
}
test("admission persistence failure launches nothing and does not forget the uncertain key", async t => {
  const f = await setup(t);
  let commands = 0;
  t.mock.method(f.options.runner ?? ValidationProcessRunner.prototype, "runSupervised", async () => { commands++; throw new Error("must not execute"); });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).startsWith(f.directory + "/")) throw new Error("admission fsync/rename failure");
    return rename(...args);
  });
  await assert.rejects(f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "failed-admission" }), { code: "VALIDATION_STORE_UNAVAILABLE" });
  assert.equal(commands, 0);
  await assert.rejects(f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "failed-admission" }));
});
test("missing profile and preflight failure retain INCOMPLETE without running configured commands", async t => {
  const f = await setup(t);
  const missing = t.mock.method(f.profiles, "get", async () => undefined);
  const one = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "missing" });
  const result = await terminal(f.service, one.validation_run_id);
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "validation_profile_missing");
  missing.mock.restore();
  await fs.writeFile(join(f.workspace, "note.txt"), "dirty\n");
  const two = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "dirty" });
  const failed = await terminal(f.service, two.validation_run_id);
  assert.equal(failed.status, "INCOMPLETE"); assert.equal(failed.reason, "preflight_failed"); assert.equal(failed.steps.length, 0);
});
test("startup reconciles admitted but unstarted run without executing, and pure query does not repeat recovery", async t => {
  const f = await setup(t);
  await f.service.shutdown();
  const store = new ValidationRunStore(f.directory);
  const run = await store.admit({ patch_task_id: f.patchTaskId, idempotency_key: "interrupted-admission", workspace_id: "workspace", workspace_root: f.workspace, base_head: f.baseHead, patch: PATCH, profile: (await f.profiles.get("workspace"))! });
  let calls = 0;
  const Type = await Service();
  const restarted = await Type.open({ ...f.options, runner: { async runSupervised() { calls++; throw new Error("no restart execution"); } } });
  f.cleanup.push(() => restarted.shutdown());
  const result = await restarted.get(run.validation_run_id);
  assert.equal(result.state, "terminal"); assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "supervisor_lost");
  assert.equal(result.duration_basis, "last_checkpoint_lower_bound");
  const filename = join(f.directory, run.validation_run_id + ".json");
  const before = await fs.readFile(filename, "utf8");
  await restarted.get(run.validation_run_id); await restarted.get(run.validation_run_id);
  assert.equal(await fs.readFile(filename, "utf8"), before); assert.equal(calls, 0);
});
test("CONFIGURE replacement during durable admission preserves the captured profile; explicit new admission uses the replacement", async t => {
  const f = await setup(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const rename = fs.rename.bind(fs); let intercepted = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!intercepted && String(args[1]).startsWith(f.directory + "/")) { intercepted = true; entered.resolve(); await release.promise; }
    return rename(...args);
  });
  const starting = f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "captured-before-write" });
  await entered.promise;
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "new-profile", argv: [process.execPath, "-e", "process.stdout.write('replacement')"] }], defaultStepTimeoutSeconds: 2, totalTimeoutSeconds: 20 });
  release.resolve(); const first = await starting;
  const result = await terminal(f.service, first.validation_run_id);
  assert.equal(result.steps[0].name, "check"); assert.equal(result.status, "PASS");
  const second = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "explicit-new-profile" });
  assert.notEqual(second.profile_sha256, first.profile_sha256);
  const next = await terminal(f.service, second.validation_run_id);
  assert.equal(next.steps[0].name, "new-profile"); assert.equal(next.steps[0].output_tail, "replacement");
});
test("actual proposal refinement produces another identity without reinterpreting an admitted candidate", async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const real = new ValidationProcessRunner();
  const f = await setup(t, { runner: { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (request.argv[0] !== "git") { entered.resolve(); await release.promise; }
    return real.runSupervised(request, control);
  } } }, () => ({ async execute() { return { kind: "completed", output: PATCH.replace("+after", "+refined") }; } }));
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "captured", argv: [process.execPath, "-e", "process.stdout.write(require('node:fs').readFileSync('note.txt','utf8'))"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 30 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "before-refine" });
  await entered.promise;
  const refined = await f.patches.refine({ patch_task_id: f.patchTaskId, change_request: "deterministic fixture refinement" });
  await until(async () => f.tasks.status(refined.taskId)?.state === "completed");
  assert.notEqual(refined.taskId, f.patchTaskId);
  assert.equal(f.patches.validationProposal(refined.taskId).patch.includes("+refined"), true);
  release.resolve(); const result = await terminal(f.service, run.validation_run_id);
  assert.equal(result.status, "PASS"); assert.equal(result.steps[0].output_tail, "after\n");
  assert.equal(result.proposal_fingerprint, run.proposal_fingerprint); assert.equal(result.patch_task_id, f.patchTaskId);
});
test("capacity is a bounded rejection, unknown query is read-only, and caller cannot inject argv", async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const real = new ValidationProcessRunner();
  const f = await setup(t, { maxActiveRuns: 1, runner: { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    if (request.argv[0] !== "git") { entered.resolve(); await release.promise; }
    return real.runSupervised(request, control);
  } } });
  await assert.rejects(f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "injection", argv: ["injected"] }), { code: "VALIDATION_RUN_INVALID_INPUT" });
  assert.equal(await f.service.get("00000000-0000-4000-8000-000000000099"), undefined);
  assert.deepEqual(await fs.readdir(f.directory), []);
  const first = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "capacity-first" });
  await entered.promise;
  await assert.rejects(Service().then(Type => Type.open(f.options)), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  const other = await f.patches.submit({ workspace_id: "workspace", base_head: f.baseHead, diff: PATCH });
  await assert.rejects(f.service.start({ patch_task_id: other.taskId, idempotency_key: "capacity-other" }), { code: "VALIDATION_CAPACITY_BUSY" });
  assert.equal((await fs.readdir(f.directory)).filter(x => x.endsWith(".json")).length, 1);
  release.resolve(); await terminal(f.service, first.validation_run_id);
});

test("minimal checkpoints retain current and completed steps without writes between preflight commands", async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const real = new ValidationProcessRunner();
  let firstPreflightVersion: number | undefined, runId: string | undefined;
  let f: Awaited<ReturnType<typeof setup>>;
  const observations: { phase: string; record: any }[] = [];
  f = await setup(t, { runner: { async runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl) {
    const record = JSON.parse(await fs.readFile(join(f.directory, runId + ".json"), "utf8"));
    observations.push({ phase: record.phase, record });
    if (record.phase === "preflight") {
      firstPreflightVersion ??= record.operation_sequence;
      assert.equal(record.operation_sequence, firstPreflightVersion, "read-only preflight commands do not each persist progress");
    }
    if (record.current_step?.phase === "validation" && request.argv[0] !== "git") {
      entered.resolve(); await release.promise;
    }
    return real.runSupervised(request, control);
  } } });
  await f.profiles.configure("workspace", { preparation: [{ name: "prepare", argv: [process.execPath, "-e", "process.stdout.write('prepared')"] }], validation: [{ name: "validate", argv: [process.execPath, "-e", "process.stdout.write('validated')"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 30 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "minimal-checkpoints" });
  runId = run.validation_run_id;
  assert.equal(Object.hasOwn(run, "execution"), false, "retained admission contains no child-process journal");
  await entered.promise;
  const running = await new ValidationRunStore(f.directory).get(runId!);
  assert.equal(running?.current_step?.name, "validate");
  assert.equal(running?.steps[0]?.status, "PASS"); assert.equal(running?.steps[0]?.output_tail, "prepared");
  release.resolve();
  const result = await terminal(f.service, runId!);
  assert.equal(result.status, "PASS"); assert.equal(result.steps[1].output_tail, "validated");
  assert.ok(observations.filter(x => x.phase === "preflight").length > 1);
  assert.ok(observations.every(x => !Object.hasOwn(x.record, "execution")));
  assert.equal(f.git("status", "--porcelain"), "");
});
