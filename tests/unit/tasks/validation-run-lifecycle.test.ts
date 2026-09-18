import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validationFixture, until, PATCH } from "../../helpers/validation-run-fixture.js";
import { ControlledPatchValidationRunService as Service } from "../../../src/tasks/controlled-patch-validation-run-service.js";
import { ValidationRunStore } from "../../../src/tasks/validation-run-store.js";
import { ValidationProcessRunner, type ValidationProcessControl, type ValidationProcessRequest } from "../../../src/tasks/validation-process-runner.js";
import { ValidationRunWorktree } from "../../../src/tasks/validation-run-worktree.js";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function absent(pid: number) { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } }
async function setup(t: any, runner?: Pick<ValidationProcessRunner, "runSupervised">) {
  const f = await validationFixture(t);
  const options = { registry: f.registry, controlledPatches: f.patches, profiles: f.profiles,
    directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], ...(runner ? { runner } : {}) };
  const service = await Service.open(options);
  f.cleanup.push(() => service.shutdown());
  return { ...f, service, options };
}
async function terminal(service: Service, id: string, timeout = 8000) {
  await until(async () => (await service.get(id))?.state === "terminal", timeout);
  return (await service.get(id))!;
}
nodeTest("service refuses unsupported supervision platform before acquiring or creating storage", async t => {
  const f = await validationFixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await assert.rejects(Service.open({ registry: f.registry, controlledPatches: f.patches, profiles: f.profiles, directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace] }), { code: "VALIDATION_PLATFORM_UNSUPPORTED" });
    await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("late normal cleanup preserves terminal query and an unrelated run without another checkpoint", { timeout: 20000 }, async t => {
  const entered = deferred(), release = deferred(), otherEntered = deferred(), otherRelease = deferred();
  t.after(() => { release.resolve(); otherRelease.resolve(); });
  let targetId: string, otherId: string, cleanupSignal: AbortSignal | undefined, otherSignal: AbortSignal | undefined;
  let blocked = false;
  const clean = ValidationRunWorktree.prototype.cleanup;
  t.mock.method(ValidationRunWorktree.prototype, "cleanup", function(this: ValidationRunWorktree, ...args: Parameters<typeof clean>) {
    if (args[0].validation_run_id === targetId) cleanupSignal = args[2];
    return clean.apply(this, args);
  });
  const real = new ValidationProcessRunner();
  const f = await setup(t, { async runSupervised(request, control) {
    if (request.argv[0] !== "git" && request.cwd.includes(otherId)) {
      otherSignal = control.signal; otherEntered.resolve(); await otherRelease.promise;
    }
    const result = await real.runSupervised(request, control);
    if (control.signal === cleanupSignal && !blocked) { blocked = true; entered.resolve(); await release.promise; }
    return result;
  } });
  const target = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "late-cleanup" });
  targetId = target.validation_run_id;
  const active = (f.service as any).active.get(targetId);
  await entered.promise;
  const other = await f.patches.submit({ workspace_id: "workspace", base_head: f.baseHead, diff: PATCH });
  otherId = (await f.service.start({ patch_task_id: other.taskId, idempotency_key: "unrelated" })).validation_run_id;
  await otherEntered.promise;
  const result = await terminal(f.service, targetId, 6500);
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.cleanup.recovery_required, true);
  await assert.rejects(Service.open(f.options), { code: "VALIDATION_OWNER_UNAVAILABLE" });
  const file = join(f.directory, targetId + ".json"), before = await fs.readFile(file, "utf8");
  release.resolve(); await active.done;
  assert.deepEqual(await f.service.get(targetId), result);
  assert.equal(await fs.readFile(file, "utf8"), before, "late operation cannot mutate the retained terminal record");
  assert.equal(otherSignal?.aborted, false);
  assert.equal((await f.service.get(otherId))?.state, "running");
  otherRelease.resolve(); assert.equal((await terminal(f.service, otherId)).status, "PASS");
});

test("shutdown after a durable current-step checkpoint prevents the configured command from spawning", async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const update = ValidationRunStore.prototype.update;
  let intercepted = false, configured = 0;
  t.mock.method(ValidationRunStore.prototype, "update", async function(this: ValidationRunStore, ...args: Parameters<typeof update>) {
    const run = await update.apply(this, args);
    if (args[2].type === "step_started" && !intercepted) { intercepted = true; entered.resolve(); await release.promise; }
    return run;
  });
  const real = new ValidationProcessRunner();
  const f = await setup(t, { runSupervised(request, control) {
    if (request.argv[0] !== "git") configured++;
    return real.runSupervised(request, control);
  } });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "stop-before-command" });
  await entered.promise;
  const shutdown = f.service.shutdown("bridge_sigterm"); release.resolve(); await shutdown;
  const result = await f.service.get(run.validation_run_id);
  assert.equal(configured, 0); assert.equal(result?.status, "INCOMPLETE"); assert.equal(result?.reason, "bridge_sigterm");
  assert.equal(result?.cleanup.state, "success");
});

for (const stop of ["bridge_shutdown", "bridge_sigterm", "step_timeout", "total_timeout"] as const) {
  test(stop + " ends a real TERM-resistant descendant tree and retains INCOMPLETE", { timeout: 12000 }, async t => {
    if (process.platform === "win32") return t.skip("POSIX process group evidence");
    const f = await setup(t);
    const marker = join(f.parent, "pids.json");
    let pids: number[] = [];
    f.cleanup.push(async () => { for (const pid of pids) if (!absent(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const childCode = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid]));setInterval(()=>{},1000)";
    const code = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(childCode) + "," + JSON.stringify(marker) + "],{stdio:'ignore'});setInterval(()=>{},1000)";
    await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "tree", argv: [process.execPath, "-e", code] }],
      defaultStepTimeoutSeconds: stop === "step_timeout" ? 1 : 20, totalTimeoutSeconds: stop === "total_timeout" ? 3 : 30 });
    const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: stop });
    await until(async () => { try { pids = JSON.parse(await fs.readFile(marker, "utf8")); return pids.length === 2; } catch { return false; } });
    if (stop === "bridge_shutdown" || stop === "bridge_sigterm") await f.service.shutdown(stop);
    const result = await terminal(f.service, run.validation_run_id);
    assert.equal(result.status, "INCOMPLETE"); assert.equal(result.steps[0]?.status, "INCOMPLETE");
    assert.equal(result.cleanup.state, "success");
    assert.ok(pids.every(absent), "no owned leader or descendant survives termination");
    assert.equal(result.reason, stop === "step_timeout" ? "timeout" : stop);
    assert.equal(f.git("status", "--porcelain"), "");
  });
}

test("shutdown stops a live child while an unrelated durable admission remains blocked", async t => {
  const f = await setup(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const marker = join(f.parent, "shutdown-child"); let pid: number | undefined;
  f.cleanup.push(async () => { if (pid && !absent(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } });
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "wait", argv: [process.execPath, "-e", "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",String(process.pid));setInterval(()=>{},1000)"] }], defaultStepTimeoutSeconds: 20, totalTimeoutSeconds: 30 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "live" });
  await until(async () => { try { pid = Number(await fs.readFile(marker, "utf8")); return true; } catch { return false; } });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).startsWith(f.directory + "/")) {
      const record = JSON.parse(await fs.readFile(args[0], "utf8"));
      if (record.idempotency_key === "blocked-admission" && record.phase === "admitted") { entered.resolve(); await release.promise; }
    }
    return rename(...args);
  });
  const other = await f.patches.submit({ workspace_id: "workspace", base_head: f.baseHead, diff: PATCH });
  const admitting = f.service.start({ patch_task_id: other.taskId, idempotency_key: "blocked-admission" });
  await entered.promise;
  const shutdown = f.service.shutdown("bridge_sigterm");
  await until(async () => pid !== undefined && absent(pid));
  release.resolve(); const stoppedAdmission = await admitting; await shutdown;
  assert.equal((await f.service.get(run.validation_run_id))?.reason, "bridge_sigterm");
  const notStarted = await f.service.get(stoppedAdmission.validation_run_id);
  assert.equal(notStarted?.status, "INCOMPLETE"); assert.equal(notStarted?.steps.length, 0);
});

test("failed terminal persistence cannot release an unresolved cleanup operation to another supervisor", { timeout: 13000 }, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const f = await setup(t);
  t.mock.method(ValidationRunWorktree.prototype, "cleanup", async () => { entered.resolve(); await release.promise; throw Error("late cleanup still owned"); });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).startsWith(f.directory + "/")) {
      const record = JSON.parse(await fs.readFile(args[0], "utf8"));
      if (record.state === "terminal") throw Error("terminal persist failed while cleanup unresolved");
    }
    return rename(...args);
  });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "fatal-cleanup" });
  await entered.promise;
  await until(async () => { try { await f.service.get(run.validation_run_id); return false; } catch { return true; } }, 6500);
  const shutdown = f.service.shutdown(); let released = false; void shutdown.then(() => { released = true; });
  await delay(50); assert.equal(released, false, "fatal checkpoint still retains cleanup ownership");
  release.resolve(); await shutdown;
});

test("total timeout stops a preflight operation without starting configured commands", async t => {
  const real = new ValidationProcessRunner(); let configured = 0;
  const f = await setup(t, { async runSupervised(request, control) {
    if (request.argv[0] !== "git") configured++;
    return real.runSupervised({ ...request, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, control);
  } });
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "unused", argv: [process.execPath, "-e", "process.exit(0)"] }], defaultStepTimeoutSeconds: 10, totalTimeoutSeconds: 1 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "preflight-timeout" });
  const result = await terminal(f.service, run.validation_run_id);
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "total_timeout"); assert.equal(configured, 0);
  assert.equal(result.cleanup.recovery_required, false);
});

test("only bounded configured output is retained; unconfirmed processes prevent worktree cleanup", async t => {
  const real = new ValidationProcessRunner();
  const f = await setup(t, { async runSupervised(request, control) {
    const result = await real.runSupervised(request, control);
    return request.argv[0] === "git" ? result : { ...result, disposition: "unknown" as const };
  } });
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "large", argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(500000)+'END')"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 20 });
  const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "unknown" });
  const result = await terminal(f.service, run.validation_run_id);
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.cleanup.reason, "process_unconfirmed");
  assert.ok(Buffer.byteLength(result.steps[0]!.output_tail) <= 65536); assert.ok(result.steps[0]!.output_tail.endsWith("END"));
  assert.equal((await fs.stat(result.owned_worktree!.worktree_path)).isDirectory(), true);
  const bytes = await fs.readFile(join(f.directory, run.validation_run_id + ".json"));
  assert.ok(bytes.length < 90000);
});



for (const cleanupBlock of ["unlink", "boundary_check", "file_close", "directory_close"] as const) {
  test("known completed-step persistence failure aborts the other tracked tree before blocked " + cleanupBlock, { timeout: 15000 }, async t => {
    const cleanupEntered = deferred(), cleanupRelease = deferred();
    t.after(() => cleanupRelease.resolve());
    const real = new ValidationProcessRunner();
    let profileSignal: AbortSignal | undefined, runId: string | undefined, failureKnown = false, held = false;
    const f = await setup(t, { runSupervised(request, control) {
      if (request.argv[0] !== "git" && profileSignal === undefined) profileSignal = control.signal;
      return real.runSupervised(request, control);
    } });
    const marker = join(f.parent, "receipt-tree.json");
    let pids: number[] = [];
    f.cleanup.push(async () => {
      for (const pid of pids) if (!absent(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await until(async () => pids.every(absent));
    });
    const descendant = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid]));setInterval(()=>{},1000)";
    const code = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "," + JSON.stringify(marker) + "],{stdio:'ignore'});setInterval(()=>{},1000)";
    await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "receipt-tree", argv: [process.execPath, "-e", code] }], defaultStepTimeoutSeconds: 30, totalTimeoutSeconds: 60 });
    const activeRun = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "live-during-write-failure" });
    await until(async () => { try { pids = JSON.parse(await fs.readFile(marker, "utf8")); return pids.length === 2; } catch { return false; } });
    const pauseCleanup = async () => { held = true; cleanupEntered.resolve(); await cleanupRelease.promise; };
    const open = fs.open.bind(fs), unlink = fs.unlink.bind(fs);
    const check = (ValidationRunStore.prototype as any).checkDirectory;
    const fault = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const temporary = String(args[0]).startsWith(f.directory + "/") && args[1] === "wx";
      const directory = String(args[0]) === f.directory && args[1] === "r";
      if ((!temporary && !directory) || failureKnown) return handle;
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => {
        if (directory && runId === undefined) return sync();
        const path = directory ? join(f.directory, runId + ".json") : args[0];
        const record = JSON.parse(await fs.readFile(path, "utf8"));
        if (record.idempotency_key !== "failure-trigger" || record.steps.length !== 1 ||
            (cleanupBlock === "directory_close") !== directory) return sync();
        await until(async () => { try { pids = JSON.parse(await fs.readFile(marker, "utf8")); return pids.length === 2; } catch { return false; } });
        failureKnown = true;
        throw Object.assign(new Error("known completed-step fsync failure"), { code: "EIO" });
      };
      handle.close = async () => {
        if (failureKnown && !held && ((cleanupBlock === "file_close" && temporary) || (cleanupBlock === "directory_close" && directory))) await pauseCleanup();
        return close();
      };
      return handle;
    });
    const unlinkFault = t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
      if (failureKnown && !held && cleanupBlock === "unlink" && String(args[0]).startsWith(f.directory + "/")) await pauseCleanup();
      return unlink(...args);
    });
    const boundaryFault = t.mock.method(ValidationRunStore.prototype as any, "checkDirectory", async function(this: any) {
      if (this.directory === f.directory && failureKnown && !held && cleanupBlock === "boundary_check") await pauseCleanup();
      return check.call(this);
    });
    await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "quick", argv: [process.execPath, "-e", "process.exit(0)"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 30 });
    const other = await f.patches.submit({ workspace_id: "workspace", base_head: f.baseHead, diff: PATCH });
    const run = await f.service.start({ patch_task_id: other.taskId, idempotency_key: "failure-trigger" });
    runId = run.validation_run_id;
    await cleanupEntered.promise;
    try {
      assert.equal(profileSignal?.aborted, true, "known write failure must abort before awaiting error cleanup");
      await assert.rejects(f.service.get(run.validation_run_id), { code: "VALIDATION_STORE_UNAVAILABLE" });
      await until(async () => pids.every(absent), 3500);
      assert.ok(pids.every(absent), "tracked leader and TERM-resistant descendant exit while cleanup is held");
      await assert.rejects(Service.open(f.options), { code: "VALIDATION_OWNER_UNAVAILABLE" });
    } finally { cleanupRelease.resolve(); }
    await f.service.shutdown();
    fault.mock.restore(); unlinkFault.mock.restore(); boundaryFault.mock.restore();
    await assert.rejects(f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "blocked" }), { code: "VALIDATION_STORE_UNAVAILABLE" });
    const stopped = await Service.open({ ...f.options, runner: { async runSupervised(): Promise<never> { throw Error("restart must not execute"); } } });
    f.cleanup.push(() => stopped.shutdown());
    const result = (await stopped.get(activeRun.validation_run_id))!;
    assert.equal((await stopped.get(run.validation_run_id))?.status, "INCOMPLETE");
    assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "supervisor_lost");
    assert.equal(result.cleanup.recovery_required, true);
    assert.ok(pids.every(absent));
  });
}

for (const event of [{ type: "progress", total_duration_ms: 1 }, { type: "phase", phase: "preflight" }]) {
  test("explicit illegal terminal " + event.type + " remains a state-machine failure", async t => {
    const f = await setup(t);
    const run = await f.service.start({ patch_task_id: f.patchTaskId, idempotency_key: "strict-transition" });
    const active = (f.service as any).active.get(run.validation_run_id);
    await active.done;
    assert.equal((await f.service.get(run.validation_run_id))?.status, "PASS");
    await assert.rejects((f.service as any).checkpoint(active, event), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
    await assert.rejects(f.service.get(run.validation_run_id), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
    assert.equal((await new ValidationRunStore(f.directory).get(run.validation_run_id))?.status, "PASS");
  });
}
