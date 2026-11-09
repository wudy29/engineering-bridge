import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { mcpValidationFixture } from "../helpers/mcp-validation-fixture.js";

test("native MCP synchronous validation refuses Windows execution and preserves POSIX validation", async t => {
  const f = await mcpValidationFixture(t);
  const marker = join(f.root, "profile-ran");
  await f.configure(f.script(`fs.writeFileSync(${JSON.stringify(marker)},'ran');`));
  const profileBefore = await fs.readFile(f.config + ".validation-profiles.json", "utf8");
  const worktreesBefore = f.git("worktree", "list", "--porcelain");
  const result = await f.connected.ok("validate_controlled_patch", { patch_task_id: f.patchTaskId }, 10000);
  assert.equal(result.patch_task_id, f.patchTaskId);
  assert.equal(result.workspace_id, "workspace");
  assert.equal(result.base_head, f.baseHead);
  assert.equal(result.cleanup, "success");
  if (process.platform === "win32") {
    assert.equal(result.status, "INCOMPLETE");
    assert.equal(result.reason, "unsupported_platform");
    assert.deepEqual(result.steps, []);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(f.counter), false);
  } else {
    assert.equal(result.status, "PASS");
    assert.equal(result.reason, undefined);
    assert.equal(await fs.readFile(marker, "utf8"), "ran");
    assert.deepEqual((result.steps as Array<{ status: string }>).map(step => step.status), ["PASS", "PASS"]);
  }
  assert.equal(await fs.readFile(f.config + ".validation-profiles.json", "utf8"), profileBefore);
  assert.equal(f.git("worktree", "list", "--porcelain"), worktreesBefore);
  await f.untouched();
});
