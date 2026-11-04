import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
const source = process.env.BRIDGE_CANDIDATE_ROOT ?? process.cwd();
const { ValidationProcessRunner } = await import(pathToFileURL(join(source, "dist/src/tasks/validation-process-runner.js")));
const gone = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } };
test("native Windows legacy interruption drains an actual child tree via taskkill", { skip: process.platform !== "win32" ? "requires native Windows" : false }, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "bridge-win-tree-")), marker = join(root, "owned.json");
  let owned;
  const runner = new ValidationProcessRunner((...args) => { owned = spawn(...args); return owned; });
  t.after(async () => {
    if (owned?.pid && !gone(owned.pid)) execFileSync("taskkill", ["/PID", String(owned.pid), "/T", "/F"]);
    await fs.rm(root, { recursive: true, force: true });
  });
  const code = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{c.disconnect();fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,c.pid]));});setInterval(()=>{},1000);`;
  const pending = runner.run({ argv: [process.execPath, "-e", code], cwd: root, timeoutMs: 5000 });
  const end = performance.now() + 8000;
  while (!existsSync(marker)) { assert.ok(performance.now() < end, "native Windows fixture readiness"); await delay(10); }
  const pids = JSON.parse(await fs.readFile(marker, "utf8"));
  runner.interrupt(); runner.interrupt();
  assert.equal((await pending).kind, "aborted"); await runner.waitForCompletion();
  for (const pid of pids) assert.equal(gone(pid), true, "taskkill must terminate the actual owned descendant too");
  t.diagnostic(`native platform=${process.platform} node=${process.version} owned children=${pids.length}`);
});

for (const stdio of ["inherit", "ignore"]) {
  test(`native Windows cannot report PASS while a ${stdio} descendant survives parent exit`, {
    skip: process.platform !== "win32" ? "requires native Windows" : false,
  }, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), "bridge-win-parent-exit-"));
    const marker = join(root, "child.json"), release = join(root, "release"), stopped = join(root, "stopped");
    const childCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(stopped)},'done');process.exit(0);}},10);`;
    const parentCode = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:${JSON.stringify(stdio)}}).unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(t);process.exit(0);}},10);`;
    t.after(async () => {
      // Let this owned fixture terminate itself; never signal a now-orphaned PID.
      await fs.writeFile(release, "release owned fixture\n");
      const end = performance.now() + 8000;
      while (!existsSync(stopped)) { assert.ok(performance.now() < end, "owned descendant cleanup"); await delay(10); }
      const { pid } = JSON.parse(await fs.readFile(marker, "utf8"));
      while (!gone(pid)) { assert.ok(performance.now() < end, "owned descendant exit"); await delay(10); }
      await fs.rm(root, { recursive: true, force: true });
    });
    const runner = new ValidationProcessRunner();
    const result = await runner.run({ argv: [process.execPath, "-e", parentCode], cwd: root, timeoutMs: 5000 });
    const { pid } = JSON.parse(await fs.readFile(marker, "utf8"));
    t.diagnostic(JSON.stringify({ platform: process.platform, stdio, result, descendantAlive: !gone(pid) }));
    assert.equal(result.kind === "exit" && result.exitCode === 0 && !gone(pid), false,
      "a surviving owned descendant forbids a successful/quiescent validation result");
    if (result.kind === "termination_error") await assert.rejects(runner.waitForCompletion());
  });
}
