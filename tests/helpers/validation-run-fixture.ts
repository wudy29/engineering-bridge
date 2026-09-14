import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isolateGitLineEndings } from "./git-fixture.js";
import { RegisteredWorkspaceRegistry } from "../../src/workspaces/registered-workspace-registry.js";
import { RegisteredWorkspaceTaskService, type ExecutorFactory } from "../../src/tasks/registered-workspace-task-service.js";
import { ControlledPatchService } from "../../src/tasks/controlled-patch-service.js";
import { ValidationProfileStore } from "../../src/tasks/validation-profile-store.js";

export const PATCH = "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n";
export async function until(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const end = performance.now() + timeout;
  while (!await check()) { if (performance.now() >= end) throw new Error("bounded condition timed out"); await delay(10); }
}
export async function validationFixture(t: TestContext, executorFactory?: ExecutorFactory) {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-async-fixture-")));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => { try { for (const close of cleanup.reverse()) await close(); } finally { await fs.rm(parent, { recursive: true, force: true }); } });
  const workspace = join(parent, "project"); await fs.mkdir(workspace);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); isolateGitLineEndings(workspace);
  git("config", "user.name", "Validation Fixture"); git("config", "user.email", "validation@example.test");
  await fs.writeFile(join(workspace, "note.txt"), "before\n");
  git("add", "note.txt"); git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture base");
  const baseHead = git("rev-parse", "HEAD").trim();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: workspace, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, executorFactory ?? (() => { throw new Error("No LLM executor allowed in validation"); }));
  const patches = new ControlledPatchService(registry, tasks, undefined, join(parent, "proposals.json"));
  const submitted = await patches.submit({ workspace_id: "workspace", base_head: baseHead, diff: PATCH });
  const profiles = new ValidationProfileStore(join(parent, "profiles.json"));
  await profiles.configure("workspace", { preparation: [], validation: [{ name: "check", argv: [process.execPath, "-e", "process.stdout.write('checked')"] }], defaultStepTimeoutSeconds: 5, totalTimeoutSeconds: 30 });
  return { parent, workspace, registry, tasks, patches, profiles, patchTaskId: submitted.taskId, baseHead, git, cleanup,
    directory: join(parent, "runs"), tempRoot: join(parent, "validation-temp") };
}
