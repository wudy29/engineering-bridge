import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import nodeTest from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpValidationFixture, until } from "../helpers/mcp-validation-fixture.js";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) for (const executor of ["dsh", "codex"] as const) {
  test(`F05 ${signal} drains ${executor} and async validation including owned descendants`, async t => {
    const f = await mcpValidationFixture(t);
    await f.connected.close();
    const marker = join(f.root, "executor-ready");
    const launcher = join(f.root, executor);
    const descendantCode = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)";
    const common = `process.on('SIGTERM',()=>{});const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','ignore','ignore','ipc']});const ready=new Promise(r=>c.once('message',()=>{c.disconnect();r()}));`;
    const dsh = `ready.then(()=>{console.log('real partial output');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,c.pid]));});setInterval(()=>{},1000);`;
    const codex = `const send=x=>process.stdout.write(JSON.stringify(x)+String.fromCharCode(10));require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);if(q.id===undefined||q.method==='turn/interrupt')return;const result=q.method==='thread/start'?{thread:{id:'owned-thread'}}:q.method==='turn/start'?{turn:{id:'owned-turn'}}:{};send({id:q.id,result});if(q.method==='turn/start'){send({method:'turn/started',params:{threadId:'owned-thread',turn:{id:'owned-turn'}}});await ready;fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,c.pid]));}});setInterval(()=>{},1000);`;
    await fs.writeFile(launcher, `#!${process.execPath}\n${common}${executor === "dsh" ? dsh : codex}`, { mode: 0o700 });
    const session = await f.session(f.config, { PATH: f.root + ":" + (process.env.PATH ?? "/usr/bin:/bin") });
    const task = await session.ok("run_task", { workspace_id: "workspace", instruction: "fixture only", executor });
    await until(async () => {
      const state = await session.ok("task_result", { task_id: task.task_id });
      assert.notEqual(state.state, "failed", JSON.stringify(state));
      return fs.stat(marker).then(() => true, () => false);
    });
    const owned = JSON.parse(await fs.readFile(marker, "utf8")) as number[];
    const confirmedGone = new Set<number>();
    const absent = (pid: number) => {
      if (confirmedGone.has(pid)) return true;
      if (gone(pid)) { confirmedGone.add(pid); return true; }
      return false;
    };
    f.cleanup.push(async () => {
      for (const pid of owned) if (!absent(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); confirmedGone.add(pid); }
        await until(async () => absent(pid));
      }
    });
    await session.ok("configure_validation_profile", { workspace_id: "workspace", profile: f.profile(f.blocking()), confirmation: "CONFIGURE" });
    const started = await session.ok("start_controlled_patch_validation", { patch_task_id: f.patchTaskId, idempotency_key: "shutdown" });
    const runId = started.validation_run_id as string;
    await until(async () => fs.stat(f.ready).then(() => true, () => false));
    owned.push((JSON.parse(await fs.readFile(f.ready, "utf8")) as { pid: number }).pid);
    if (signal === "SIGINT") await session.ok("control_task", { task_id: task.task_id, action: "interrupt" });
    const began = performance.now();
    session.child.kill(signal);
    if (signal === "SIGTERM") {
      await until(async () => (await f.readRun(runId)).reason === "bridge_sigterm");
      // A repeated OS signal must join cleanup, not invoke the default signal exit.
      if (!session.exited()) session.child.kill(signal);
    }
    await until(async () => session.exited(), 10_000);
    await session.finished;
    assert.ok(performance.now() - began < 10_000);
    for (const pid of owned) assert.equal(absent(pid), true, "Bridge exit must include its owned executor, descendant and validation child");
    const retained = await f.readRun(runId);
    assert.equal(retained.status, "INCOMPLETE");
    assert.equal(retained.reason, signal === "SIGTERM" ? "bridge_sigterm" : "bridge_shutdown");
    assert.equal(retained.cleanup.state, "success");
    assert.equal(session.child.exitCode, signal === "SIGTERM" ? 143 : 130);
    await f.untouched();
    t.diagnostic(`owned_processes=${owned.length} all_gone=true elapsed_ms=${(performance.now()-began).toFixed(1)}`);
  });
}

test("F05 caller cancellation and EOF leave normal execution and independent async validation running", async t => {
  const f = await mcpValidationFixture(t); await f.connected.close();
  const marker = join(f.root, "normal-ready");
  const launcher = join(f.root, "dsh");
  await fs.writeFile(launcher, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(f.release)})){clearInterval(timer);console.log('completed normally')}},10);`, { mode: 0o700 });
  const session = await f.session(f.config, { PATH: f.root + ":" + (process.env.PATH ?? "/usr/bin:/bin") });
  await session.ok("run_task", { workspace_id: "workspace", instruction: "fixture only", executor: "dsh" });
  await until(async () => fs.stat(marker).then(() => true, () => false));
  const pid = Number(await fs.readFile(marker, "utf8"));
  let knownGone = false;
  f.cleanup.push(async () => {
    if (!knownGone) {
      if (gone(pid)) { knownGone = true; return; }
      process.kill(pid, "SIGKILL");
      await until(async () => gone(pid)); knownGone = true;
    }
  });
  await session.ok("configure_validation_profile", { workspace_id: "workspace", profile: f.profile(f.blocking()), confirmation: "CONFIGURE" });
  const cancel = new AbortController();
  const request = session.client.request({ method: "tools/call", params: { name: "start_controlled_patch_validation", arguments: { patch_task_id: f.patchTaskId, idempotency_key: "cancelled-caller" } } }, CallToolResultSchema, { signal: cancel.signal });
  const rejected = assert.rejects(request);
  cancel.abort(); await rejected;
  await until(async () => fs.stat(f.ready).then(() => true, () => false));
  assert.equal(gone(pid), false);
  const files = (await fs.readdir(f.directory)).filter(x => x.endsWith(".json"));
  assert.equal(files.length, 1);
  const runId = files[0]!.slice(0, -5);
  assert.equal((await f.readRun(runId)).state, "running");
  await session.disconnect();
  assert.equal(session.exited(), false); assert.equal(gone(pid), false);
  assert.equal((await f.readRun(runId)).state, "running");
  await fs.writeFile(f.release, "complete");
  await until(async () => session.exited()); await session.finished;
  knownGone = gone(pid); assert.equal(knownGone, true);
  const report = await f.readRun(runId);
  assert.equal(report.status, "PASS"); assert.equal(report.cleanup.state, "success");
  await f.untouched();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`F05 ${signal} also drains legacy synchronous validation before removing its worktree`, async t => {
    const f = await mcpValidationFixture(t); await f.configure(f.blocking());
    const pending = f.connected.call("validate_controlled_patch", { patch_task_id: f.patchTaskId }, 10_000).catch(() => undefined);
    await until(async () => fs.stat(f.ready).then(() => true, () => false));
    const child = JSON.parse(await fs.readFile(f.ready, "utf8")) as { pid: number; cwd: string };
    let knownGone = false;
    f.cleanup.push(async () => {
      if (!knownGone) {
        if (gone(child.pid)) { knownGone = true; return; }
        process.kill(child.pid, "SIGKILL"); await until(async () => gone(child.pid)); knownGone = true;
      }
    });
    f.connected.child.kill(signal);
    await until(async () => f.connected.exited(), 10_000); await f.connected.finished;
    knownGone = gone(child.pid);
    assert.equal(knownGone, true, "legacy validation must be stopped with Bridge");
    assert.equal(await fs.stat(child.cwd).then(() => true, () => false), false, "quiescent worktree cleanup must finish before Bridge exits");
    await pending; await f.untouched();
  });
}
