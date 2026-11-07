import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gone, releaseFixtureDescendant } from "./fixture-cleanup.mjs";

test("fixture cleanup accepts actual prior exit without requesting a future stopped marker", async t => {
  const root = await fs.mkdtemp(join(tmpdir(), "bridge-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  assert.equal(gone(child.pid), true);
  await releaseFixtureDescendant(child.pid, join(root, "release"));
  assert.equal(existsSync(join(root, "release")), false);
  assert.equal(existsSync(join(root, "stopped")), false);
});

for (const mode of ["cooperative", "no-marker", "marker-only", "write-error"]) {
  test(`fixture cleanup ${mode} requires actual exit and preserves failures`, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), "bridge-cleanup-"));
    const release = join(root, "release"), stopped = join(root, "stopped");
    const code = `const fs=require('node:fs');${mode === "marker-only" ? `fs.writeFileSync(${JSON.stringify(stopped)},'not exited');` : ""}process.send('ready');setInterval(()=>{if(${JSON.stringify(mode)}!=='marker-only'&&fs.existsSync(${JSON.stringify(release)})){${mode === "cooperative" ? `fs.writeFileSync(${JSON.stringify(stopped)},'done');` : ""}process.exit(0)}},10);`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed; await fs.rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
    if (mode === "marker-only") {
      await assert.rejects(releaseFixtureDescendant(child.pid, release), /owned descendant exit/u);
      assert.equal(gone(child.pid), false, "a stopped marker must not hide a surviving child");
    } else if (mode === "write-error") {
      await assert.rejects(releaseFixtureDescendant(child.pid, join(root, "missing", "release")), { code: "ENOENT" });
      assert.equal(gone(child.pid), false);
    } else {
      await releaseFixtureDescendant(child.pid, release); await closed;
      assert.equal(gone(child.pid), true);
      assert.equal(existsSync(stopped), mode === "cooperative");
    }
  });
}
