import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ValidationProcessRunner } from "../../../src/tasks/validation-process-runner.js";
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function supervised(runner = new ValidationProcessRunner()): any {
  assert.equal(typeof (runner as any).runSupervised, "function", "runner exposes service-owned cancellation and disposition");
  return runner;
}
async function until(check: () => Promise<boolean>, timeout = 4000) {
  const end = performance.now() + timeout;
  while (!await check()) { assert.ok(performance.now() < end, "bounded readiness"); await delay(10); }
}
function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
test("an already aborted supervised call never starts a child", async () => {
  let starts = 0;
  const runner = new ValidationProcessRunner(() => { starts++; throw Error("must not spawn"); });
  const stop = new AbortController(); stop.abort();
  const result = await runner.runSupervised({ argv: ["unused"], cwd: process.cwd(), timeoutMs: 1000 }, { signal: stop.signal });
  assert.equal(starts, 0); assert.equal(result.kind, "aborted"); assert.equal(result.disposition, "not_started");
});
test("supervised direct argv preserves literal shell syntax and reports bounded stdout separately", async () => {
  const runner = supervised();
  const arg = "; touch unwanted-file $(echo nope)";
  const result = await runner.runSupervised({ argv: [process.execPath, "-e", "process.stdout.write(process.argv[1]); process.stderr.write('err')", arg], cwd: process.cwd(), timeoutMs: 2000 }, { signal: new AbortController().signal });
  assert.equal(result.kind, "exit");
  assert.equal(result.stdout, arg);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.disposition, "quiescent");
});
test("stdout overflow cannot silently serve a truncated preflight answer", async () => {
  const runner = supervised();
  const result = await runner.runSupervised({ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(200000))"], cwd: process.cwd(), timeoutMs: 2000 }, { signal: new AbortController().signal });
  assert.equal(result.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 65536);
  assert.ok(Buffer.byteLength(result.outputTail) <= 65536);
});
test("invalid UTF-8 cannot expand machine stdout beyond its byte limit or pass as exact Git output", async () => {
  const result = await supervised().runSupervised({ argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(65536,255))"], cwd: process.cwd(), timeoutMs: 2000 }, { signal: new AbortController().signal });
  assert.ok(Buffer.byteLength(result.stdout) <= 65536);
  assert.equal(result.stdoutTruncated, true);
});
nodeTest("unsupported Windows supervision refuses before spawn instead of claiming quiescence", async () => {
  let calls = 0;
  const runner = new ValidationProcessRunner(() => { calls++; throw Error("must not start without process ownership support"); }, undefined, "win32");
  const result = await runner.runSupervised({ argv: ["unused"], cwd: process.cwd(), timeoutMs: 1000 }, { signal: new AbortController().signal });
  assert.equal(calls, 0); assert.equal(result.kind, "spawn_error"); assert.equal(result.disposition, "not_started");
});
for (const trigger of ["cancel", "timeout", "leader_exit"] as const) {
  test("supervised " + trigger + " terminates a child tree even after the leader closes its pipes", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX group evidence");
    const runner = supervised();
    const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-supervised-tree-")));
    const marker = join(parent, "ready");
    let leader: number | undefined;
    let descendant: number | undefined;
    t.after(async () => {
      for (const pid of [leader, descendant]) if (pid && !absent(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await fs.rm(parent, { recursive: true, force: true });
    });
    const childCode = "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.ppid,process.pid])); setInterval(()=>{},1000)";
    const leaderCode = "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e'," + JSON.stringify(childCode) + "," + JSON.stringify(marker) + "],{stdio:'ignore'}); c.unref();" +
      (trigger === "leader_exit" ? "setInterval(()=>{if(require('node:fs').existsSync(" + JSON.stringify(marker) + "))process.exit(0)},5);" : "setInterval(()=>{},1000);");
    const stop = new AbortController();
    const result = runner.runSupervised({ argv: [process.execPath, "-e", leaderCode], cwd: parent, timeoutMs: trigger === "timeout" ? 500 : 3000 }, {
      signal: stop.signal
    });
    await until(async () => { try { [leader, descendant] = JSON.parse(await fs.readFile(marker, "utf8")); return true; } catch { return false; } });
    if (trigger === "cancel") stop.abort();
    const outcome = await result;
    assert.equal(outcome.kind, trigger === "cancel" ? "aborted" : trigger === "timeout" ? "timeout" : "signal");
    assert.equal(outcome.disposition, "quiescent");
    assert.ok(leader && absent(leader), "leader has exited");
    assert.ok(descendant && absent(descendant), "descendant has exited");
    assert.ok(outcome.durationMs < 4000);
  });
}
