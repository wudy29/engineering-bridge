import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { validationFixture, until } from "../../helpers/validation-run-fixture.js";
import { ControlledPatchValidationRunService as Service } from "../../../src/tasks/controlled-patch-validation-run-service.js";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
function absent(pid: number) { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } }
for (const signal of ["SIGTERM", "SIGKILL"] as const) test("real service owner " + signal + " then recreation retains outcome without attach or rerun", { timeout: 15000 }, async t => {
  const f = await validationFixture(t);
  const marker = join(f.parent, "live-pids.json"), executions = join(f.parent, "executions");
  const descendant = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid]));setInterval(()=>{},1000)";
  const code = "require('node:fs').appendFileSync(" + JSON.stringify(executions) + ",'executed\\n');require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) + "," + JSON.stringify(marker) + "],{stdio:'ignore'});setInterval(()=>{},1000)";
  await f.profiles.configure("workspace", { preparation: [], validation: [{ name: "long-fixture", argv: [process.execPath, "-e", code] }], defaultStepTimeoutSeconds: 60, totalTimeoutSeconds: 90 });
  const child = fork(new URL("../../helpers/validation-run-child.js", import.meta.url), [f.parent, f.patchTaskId], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostics = ""; child.stderr?.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
  let pids: number[] = [];
  f.cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGKILL"); await done; }
    // This test owns these fixture processes directly; production recovery never does this.
    for (const pid of pids) if (!absent(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await until(async () => pids.every(absent));
  });
  const message = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error("fixture exited: " + diagnostics); })]);
  const id = (message[0] as { validation_run_id: string }).validation_run_id;
  await until(async () => { try { pids = JSON.parse(await fs.readFile(marker, "utf8")); return pids.length === 2; } catch { return false; } });
  const filename = join(f.directory, id + ".json");
  await until(async () => JSON.parse(await fs.readFile(filename, "utf8")).current_step?.phase === "validation");
  const prior = JSON.parse(await fs.readFile(filename, "utf8"));
  const exited = once(child, "exit"); child.kill(signal); await exited;
  if (signal === "SIGTERM") { assert.equal(child.exitCode, 0, diagnostics); assert.ok(pids.every(absent)); }
  else assert.ok(pids.some(pid => !absent(pid)), "hard death cannot be mistaken for child-tree quiescence");
  let spawned = 0;
  const service = await Service.open({ registry: f.registry, controlledPatches: f.patches, profiles: f.profiles,
    directory: f.directory, tempRoot: f.tempRoot, protectedRoots: [f.workspace], runner: { async runSupervised(): Promise<never> { spawned++; throw Error("no restart spawn"); } } });
  f.cleanup.push(() => service.shutdown());
  const result = (await service.get(id))!;
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, signal === "SIGTERM" ? "bridge_sigterm" : "supervisor_lost");
  assert.equal(spawned, 0); assert.equal(await fs.readFile(executions, "utf8"), "executed\n");
  assert.equal((await service.start({ patch_task_id: f.patchTaskId, idempotency_key: "child-start" })).validation_run_id, id);
  if (signal === "SIGKILL") {
    assert.equal(result.cleanup.recovery_required, true);
    assert.equal((await fs.stat(prior.owned_worktree.worktree_path)).isDirectory(), true);
    assert.ok(pids.some(pid => !absent(pid)), "recovery did not signal stored process identities");
    await assert.rejects(service.start({ patch_task_id: f.patchTaskId, idempotency_key: "reexecute" }), { code: "VALIDATION_RECOVERY_REQUIRED" });
  } else { assert.equal(result.cleanup.state, "success"); await assert.rejects(fs.stat(prior.owned_worktree.parent_path), { code: "ENOENT" }); }
  assert.equal(f.git("status", "--porcelain"), "");
});
