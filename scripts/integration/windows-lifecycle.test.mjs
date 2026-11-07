import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gone, releaseFixtureDescendant } from "./fixture-cleanup.mjs";
const source = process.env.BRIDGE_CANDIDATE_ROOT ?? process.cwd();
const { ValidationProcessRunner } = await import(pathToFileURL(join(source, "dist/src/tasks/validation-process-runner.js")));
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
  test(`native Windows records ${stdio} non-detached descendant lifetime through legacy validation`, {
    skip: process.platform !== "win32" ? "requires native Windows" : false,
  }, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), "bridge-win-parent-exit-"));
    const marker = join(root, "child.json"), release = join(root, "release"), stopped = join(root, "stopped");
    const observed = { platform: process.platform, node: process.version, stdio, events: [] };
    let descendantPid, confirmedGone = false;
    const probe = () => {
      descendantPid ??= JSON.parse(readFileSync(marker, "utf8")).pid;
      confirmedGone ||= gone(descendantPid);
      return confirmedGone ? "gone" : "alive";
    };
    const save = async stage => {
      const directory = process.env.BRIDGE_INTEGRATION_EVIDENCE ?? tmpdir();
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(join(directory, basename(root) + "-" + stage + ".json"), JSON.stringify({
        ...observed, stage, descendantPid, confirmedGone, stopped: existsSync(stopped),
      }, null, 2) + "\n");
    };
    const childCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(stopped)},'done');process.exit(0);}},10);`;
    const parentCode = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:${JSON.stringify(stdio)}}).unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(t);process.exit(0);}},10);`;
    t.after(async () => {
      const errors = [];
      try { await save("before-teardown"); } catch (error) { errors.push(error); }
      try {
        // Never signal an orphan or re-probe a PID already confirmed absent.
        if (!confirmedGone) { probe(); if (!confirmedGone) await releaseFixtureDescendant(descendantPid, release); }
        confirmedGone = true;
        await fs.rm(root, { recursive: true, force: true });
        observed.cleanup = "exited";
      } catch (error) { observed.cleanup = { error: error.message, code: error.code }; errors.push(error); }
      try { await save("after-teardown"); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Windows fixture evidence or cleanup failed");
    });
    const runner = new ValidationProcessRunner((...args) => {
      const child = spawn(...args); // Preserve the real Windows runner's argv/options.
      child.once("exit", (code, signal) => {
        try { observed.parentExit = { code, signal, descendant: probe() }; }
        catch (error) { observed.parentExit = { code, signal, observationError: error.message }; }
        observed.events.push({ event: "parent-exit", ms: performance.now(), ...observed.parentExit });
      });
      return child;
    });
    const result = await runner.run({ argv: [process.execPath, "-e", parentCode], cwd: root, timeoutMs: 5000 });
    observed.result = result; observed.descendantAtResult = probe();
    observed.events.push({ event: "runner-result", ms: performance.now(), descendant: observed.descendantAtResult });
    observed.survivingDescendantSafety = observed.parentExit?.descendant === "alive" && observed.descendantAtResult === "alive"
      ? "EXERCISED" : "NOT_EXERCISED";
    await save("before-assertion"); t.diagnostic(JSON.stringify(observed));
    assert.ok(observed.parentExit && !observed.parentExit.observationError, "independent parent-exit observation is required");
    assert.equal(result.kind === "exit" && result.exitCode === 0 && observed.descendantAtResult === "alive", false,
      "a surviving owned descendant forbids a successful/quiescent validation result");
    if (result.kind === "termination_error") await assert.rejects(runner.waitForCompletion());
  });
}
