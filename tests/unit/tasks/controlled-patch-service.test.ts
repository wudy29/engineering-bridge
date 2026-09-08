import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { CodexExecutor } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import type { GitStarter } from "../../../src/tasks/controlled-patch-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function currentHead(root: string): string | null {
  try {
    return git(root, "rev-parse", "--verify", "--quiet", "HEAD").trim();
  } catch {
    return null;
  }
}

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-patch-")));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "note.txt"), "before\n");
  git(root, "add", "note.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function unbornRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-root-commit-")));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  return root;
}

function fixture(
  root: string,
  execute: Executor["execute"],
  startProcess?: GitStarter,
  stateFilePath?: string
): {
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
} {
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute }));
  const controlled = stateFilePath === undefined
    ? startProcess === undefined
      ? new ControlledPatchService(registry, tasks)
      : new ControlledPatchService(registry, tasks, startProcess)
    : new ControlledPatchService(registry, tasks, startProcess ?? spawn, stateFilePath);
  return { controlled, tasks };
}

function retainedStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "engineering-bridge-state-")), "controlled-patches.json");
}

async function terminal(tasks: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (["queued", "running"].includes(tasks.status(taskId)?.state ?? "")) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

async function waitForOptionalFile(path: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return true;
    } catch {
      await new Promise<void>((done) => setTimeout(done, 5));
    }
  }
  return false;
}

function gatedGitStarter(
  enteredBase: string,
  releaseBase: string,
  calls: { apply: number }
): GitStarter {
  return (executable, args, options) => {
    if (
      executable === "git" &&
      args.length === 3 &&
      args[0] === "apply" &&
      args[1] === "--recount" &&
      args[2] === "--unidiff-zero"
    ) {
      calls.apply += 1;
      const enteredPath = `${enteredBase}.${calls.apply}`;
      const releasePath = `${releaseBase}.${calls.apply}`;
      writeFileSync(enteredPath, "entered\n");
      return spawn(process.execPath, [
        "-e",
        "const fs=require('node:fs');const cp=require('node:child_process');const [git,argsJson,release]=process.argv.slice(1);const deadline=Date.now()+2000;const wait=()=>{if(fs.existsSync(release)){const result=cp.spawnSync(git,JSON.parse(argsJson),{cwd:process.cwd(),stdio:'inherit',shell:false});process.exit(result.status===null||result.status===undefined?1:result.status);}if(Date.now()>=deadline)process.exit(1);setTimeout(wait,5)};wait();",
        executable,
        JSON.stringify(args),
        releasePath
      ], options);
    }
    return spawn(executable, args, options);
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

const additionPatch = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+added
`;

const twoFileAdditionPatch = [
  additionPatch.replaceAll("added.txt", "first.txt"),
  additionPatch.replaceAll("added.txt", "second.txt")
].join("");

async function appliedFixture(
  root: string,
  patch: string = validPatch,
  startProcess?: GitStarter
): Promise<{
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
  taskId: string;
}> {
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: patch }),
    startProcess
  );
  const generated = await current.controlled.generate({
    workspace_id: "workspace",
    change_request: "apply then commit"
  });
  await terminal(current.tasks, generated.taskId);
  await current.controlled.apply({
    patch_task_id: generated.taskId,
    confirmation: "APPLY"
  });
  return { ...current, taskId: generated.taskId };
}

async function appliedUnbornFixture(
  root: string,
  patch: string = additionPatch,
  startProcess?: GitStarter
): Promise<{
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
  taskId: string;
}> {
  return appliedFixture(root, patch, startProcess);
}

function mutateBeforeCommit(mutate: () => void): GitStarter {
  let mutated = false;
  return (executable, args, options) => {
    if (!mutated && executable === "git" && args.includes("commit")) {
      mutated = true;
      mutate();
    }
    return spawn(executable, args, options);
  };
}

const markdownFencePatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,7 +1,7 @@",
  " # Example",
  " ",
  " ```sh",
  " echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const staleHunkCountPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -4,7 +4,7 @@ echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const zeroContextPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -7 +7 @@",
  "-before",
  "+after",
  ""
].join("\n");

test("restores a completed generated proposal for task_result after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, generated.taskId);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();

  assert.deepEqual(restarted.tasks.taskView(generated.taskId), {
    taskId: generated.taskId,
    state: "completed",
    executor: "codex",
    ready: true,
    output: validPatch
  });
});

test("forwards optional Codex selection fields for generate and refine", async () => {
  const root = repository();
  const requests: ExecutorRequest[] = [];
  const first = fixture(root, async (request) => {
    requests.push(request);
    return { kind: "completed", output: validPatch };
  });

  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  } as Parameters<ControlledPatchService["generate"]>[0] & {
    model: string;
    reasoning_effort: string;
  });
  await terminal(first.tasks, generated.taskId);

  const refined = await first.controlled.refine({
    patch_task_id: generated.taskId,
    change_request: "improve wording",
    model: "gpt-5-codex",
    reasoning_effort: "low"
  } as Parameters<ControlledPatchService["refine"]>[0] & {
    model: string;
    reasoning_effort: string;
  });
  await terminal(first.tasks, refined.taskId);

  assert.deepEqual(requests.map((request) => {
    const selected = request as ExecutorRequest & { model?: string; reasoning_effort?: string };
    return {
      model: selected.model,
      reasoning_effort: selected.reasoning_effort
    };
  }), [
    { model: "gpt-5-codex", reasoning_effort: "high" },
    { model: "gpt-5-codex", reasoning_effort: "low" }
  ]);
});

test("refines a restored proposal with its parent relationship and original base HEAD retained", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, source.taskId);

  const refinedPatch = validPatch.replace("+after", "+refined after");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: refinedPatch }),
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const refined = await restarted.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording"
  });
  await terminal(restarted.tasks, refined.taskId);

  assert.equal(refined.baseHead, source.baseHead);
  assert.deepEqual(restarted.tasks.result(source.taskId), {
    id: source.taskId,
    state: "completed",
    output: validPatch
  });
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; base_head: string; parent_task_id?: string }>;
  };
  const retainedSource = state.proposals.find(({ task_id }) => task_id === source.taskId);
  const retainedRefinement = state.proposals.find(({ task_id }) => task_id === refined.taskId);
  assert.equal(retainedSource?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.parent_task_id, source.taskId);
});

test("applies a refined proposal after restart without rerunning generation", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  let executions = 0;
  const refinedPatch = validPatch.replace("+after", "+refined after");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: executions++ === 0 ? validPatch : refinedPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, source.taskId);
  const refined = await first.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording"
  });
  await terminal(first.tasks, refined.taskId);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const applied = await restarted.controlled.apply({
    patch_task_id: refined.taskId,
    confirmation: "APPLY"
  });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined after\n");
});

test("fails safely on malformed retained state", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  writeFileSync(stateFilePath, "{not json}\n");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );

  await expectCode(() => restarted.controlled.load(), "INTERNAL_ERROR");
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(stateFilePath, "utf8"), "{not json}\n");
});

test("reports a retention write failure instead of exposing an unretained completed proposal", async () => {
  const root = repository();
  const stateFilePath = join(retainedStateFile(), "missing", "controlled-patches.json");
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await current.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(current.tasks, generated.taskId);

  assert.deepEqual(current.tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "failed",
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    }
  });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
});

test("recovers an interrupted applying proposal as retryable after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, generated.taskId);

  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  const retainedProposal = state.proposals.find(({ task_id }) => task_id === generated.taskId);
  assert.ok(retainedProposal);
  retainedProposal.state = "applying";
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const proposals = (restarted.controlled as unknown as {
    proposals: Map<string, { state: string }>;
  }).proposals;
  assert.equal(proposals.get(generated.taskId)?.state, "proposed");

  const applied = await restarted.controlled.apply({
    patch_task_id: generated.taskId,
    confirmation: "APPLY"
  });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("generation records base metadata, binds the task, and keeps Codex instruction read-only", async () => {
  const root = repository();
  let instruction = "";
  const gitCalls: Array<{ executable: string; args: readonly string[]; shell: unknown }> = [];
  const starter: GitStarter = (executable, args, options) => {
    gitCalls.push({ executable, args, shell: options.shell });
    return spawn(executable, args, options);
  };
  const { controlled, tasks } = fixture(root, async (request) => {
    instruction = request.instruction;
    return { kind: "completed", output: validPatch };
  }, starter);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await Promise.resolve();
  assert.match(instruction, /Return only a unified textual Git diff/);
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.ok(gitCalls.every((call) => call.executable === "git" && call.shell === false));
  assert.deepEqual(gitCalls.slice(-2).map((call) => call.args), [
    ["apply", "--check", "--recount", "--unidiff-zero"],
    ["apply", "--recount", "--unidiff-zero"]
  ]);
  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );
});

test("generate_controlled_patch reaches the explicit Codex gate before starting", async () => {
  const root = repository();
  const starterCalls = { value: 0 };
  const starter: ProcessStarter = () => {
    starterCalls.value += 1;
    throw new Error("Codex starter must not run");
  };
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, (_executor, workspaceRoot) =>
    new CodexExecutor(workspaceRoot, starter, {}, process.platform, undefined, "explicit")
  );
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "failed",
    error: {
      code: "CODEX_ROUTING_REQUIRED",
      message: "Explicit model and reasoning_effort are required for Codex execution."
    }
  });
  assert.equal(starterCalls.value, 0);
});

test("refine_controlled_patch requires fresh explicit Codex routing", async () => {
  const root = repository();
  const starterCalls = { value: 0 };
  const starter: ProcessStarter = () => {
    starterCalls.value += 1;
    throw new Error("Codex starter must not run");
  };
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  let factoryCalls = 0;
  const tasks = new RegisteredWorkspaceTaskService(registry, (_executor, workspaceRoot) => {
    factoryCalls += 1;
    if (factoryCalls === 1) {
      return { execute: async () => ({ kind: "completed", output: validPatch }) };
    }
    return new CodexExecutor(workspaceRoot, starter, {}, process.platform, undefined, "explicit");
  });
  const controlled = new ControlledPatchService(registry, tasks);

  const source = await controlled.generate({
    workspace_id: "workspace",
    change_request: "original",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  });
  await terminal(tasks, source.taskId);

  const refined = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine without routing"
  });
  await terminal(tasks, refined.taskId);

  assert.deepEqual(tasks.result(refined.taskId), {
    id: refined.taskId,
    state: "failed",
    error: {
      code: "CODEX_ROUTING_REQUIRED",
      message: "Explicit model and reasoning_effort are required for Codex execution."
    }
  });
  assert.equal(starterCalls.value, 0);
});

test("refines a complete multi-file proposal without changing its source and applies the complete replacement", async () => {
  const root = repository();
  const sourcePatch = `${validPatch}${additionPatch}`;
  const refinedPatch = sourcePatch
    .replace("+after\n", "+refined\n")
    .replace("+added\n", "+refined added\n");
  const instructions: string[] = [];
  const { controlled, tasks } = fixture(root, async (request) => {
    instructions.push(request.instruction);
    return { kind: "completed", output: instructions.length === 1 ? sourcePatch : refinedPatch };
  });

  const source = await controlled.generate({ workspace_id: "workspace", change_request: "implement original multi-file change" });
  await terminal(tasks, source.taskId);
  const sourceResult = tasks.result(source.taskId);
  const refined = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "fix note wording"
  });
  await terminal(tasks, refined.taskId);

  assert.notEqual(refined.taskId, source.taskId);
  assert.equal(refined.baseHead, source.baseHead);
  const refinementInstruction = instructions[1]!;
  assert.ok(refinementInstruction.includes(sourcePatch));
  assert.match(refinementInstruction, /Treat the source proposal below as the reviewed baseline/);
  assert.match(refinementInstruction, /Fix only the requested issues and preserve all unrelated proposal semantics/);
  assert.match(refinementInstruction, /COMPLETE final unified diff relative to the SAME original base_head/);
  assert.match(refinementInstruction, /not an incremental patch against the source proposal/);
  assert.doesNotMatch(refinementInstruction, /implement original multi-file change/);
  assert.deepEqual(tasks.result(source.taskId), sourceResult);

  const applied = await controlled.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "refined added\n");
});

test("rejects missing, non-completed, and HEAD-drifted refinement sources without starting Codex", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  let executions = 0;
  const { controlled, tasks } = fixture(root, () => {
    executions += 1;
    return pending;
  });
  const source = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await Promise.resolve();

  await expectCode(() => controlled.refine({
    patch_task_id: "missing",
    change_request: "refine"
  }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine"
  }), "INVALID_STATE_TRANSITION");
  assert.equal(executions, 1);

  finish({ kind: "completed", output: validPatch });
  await terminal(tasks, source.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine"
  }), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(executions, 1);
});

test("accepts a normal absolute Git top-level path", async () => {
  const root = repository();
  const { controlled } = fixture(root, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("accepts a symlink alias that resolves to the same Git top-level", async () => {
  const root = repository();
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-alias-")));
  const alias = join(aliasParent, "workspace-alias");
  symlinkSync(root, alias, "dir");
  const { controlled } = fixture(alias, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("rejects a different directory, a Git subdirectory, and a missing workspace", async () => {
  const root = repository();
  const other = repository();
  const nested = join(root, "nested");
  mkdirSync(nested);

  for (const invalidRoot of [other, nested, join(root, "missing")]) {
    const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: invalidRoot, allow_write: true }]);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, (executable, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && invalidRoot === other) {
        return spawn(executable, args, { ...options, cwd: root });
      }
      return spawn(executable, args, options);
    });
    await expectCode(
      () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("stores and applies a controlled patch normalized to one trailing LF", async () => {
  const root = repository();
  const patchWithoutFinalLf = validPatch.slice(0, -1);
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: patchWithoutFinalLf
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch
  });
  await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("initial COMMIT creates a verified root commit from exactly the applied proposal targets", async () => {
  const root = unbornRepository();
  const anchorPath = "recovery-anchor.md";
  try {
    writeFileSync(join(root, anchorPath), "keep me\n");
    const { controlled, taskId } = await appliedUnbornFixture(root, twoFileAdditionPatch);

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "  feat: initial controlled commit  ",
      confirmation: "COMMIT"
    });

    assert.equal(result.patch_task_id, taskId);
    assert.equal(result.committed, true);
    assert.match(result.commit_sha, /^[0-9a-f]{40,64}$/u);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), result.commit_sha);
    assert.deepEqual(
      git(root, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/u),
      [result.commit_sha]
    );
    assert.equal(git(root, "log", "-1", "--format=%s").trim(), "feat: initial controlled commit");
    assert.deepEqual(
      git(root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD")
        .trim()
        .split("\n")
        .sort(),
      ["first.txt", "second.txt"]
    );
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(git(root, "diff", "--name-only"), "");
    assert.equal(readFileSync(join(root, anchorPath), "utf8"), "keep me\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), anchorPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT rejects a dirty index without disturbing its staged entry", async () => {
  const root = unbornRepository();
  try {
    const { controlled, taskId } = await appliedUnbornFixture(root);
    writeFileSync(join(root, "staged-by-user.txt"), "user staged\n");
    git(root, "add", "staged-by-user.txt");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "staged-by-user.txt");
    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(currentHead(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT rejects an applied unborn proposal after another process establishes HEAD", async () => {
  const root = unbornRepository();
  try {
    const { controlled, taskId } = await appliedUnbornFixture(root);
    git(root, "commit", "--allow-empty", "-qm", "concurrent initial commit");
    const concurrentHead = git(root, "rev-parse", "HEAD").trim();

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(git(root, "rev-parse", "HEAD").trim(), concurrentHead);
    assert.deepEqual(git(root, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/u), [concurrentHead]);
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), "added.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT rejects an inserted ref before staging any proposal target", async () => {
  const root = unbornRepository();
  let cachedStagingCalls = 0;
  const starter: GitStarter = (executable, args, options) => {
    if (executable === "git" && args[0] === "apply" && args.includes("--cached")) {
      cachedStagingCalls += 1;
    }
    return spawn(executable, args, options);
  };
  try {
    const { controlled, taskId } = await appliedUnbornFixture(root, additionPatch, starter);
    const emptyTree = execFileSync("git", ["mktree"], { cwd: root, encoding: "utf8", input: "" }).trim();
    const concurrentCommit = git(root, "commit-tree", emptyTree, "-m", "concurrent detached commit").trim();
    git(root, "update-ref", "refs/tags/concurrent", concurrentCommit);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(cachedStagingCalls, 0);
    assert.equal(currentHead(root), null);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), "added.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT rechecks for inserted refs immediately before creating the root commit", async () => {
  const root = unbornRepository();
  let insertedRef = false;
  try {
    const emptyTree = execFileSync("git", ["mktree"], { cwd: root, encoding: "utf8", input: "" }).trim();
    const concurrentCommit = git(root, "commit-tree", emptyTree, "-m", "concurrent detached commit").trim();
    const starter: GitStarter = (executable, args, options) => {
      if (executable === "git" && args[0] === "apply" && args.includes("--cached")) {
        insertedRef = true;
        return spawn(process.execPath, [
          "-e",
          "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const cp=require('node:child_process');const [git,argsJson,commit]=process.argv.slice(1);const applied=cp.spawnSync(git,JSON.parse(argsJson),{cwd:process.cwd(),input,encoding:'utf8',shell:false});if(applied.stdout)process.stdout.write(applied.stdout);if(applied.stderr)process.stderr.write(applied.stderr);if(applied.status!==0)process.exit(applied.status??1);const updated=cp.spawnSync(git,['update-ref','refs/tags/concurrent',commit],{cwd:process.cwd(),stdio:'inherit',shell:false});process.exit(updated.status??1);});",
          executable,
          JSON.stringify(args),
          concurrentCommit
        ], options);
      }
      return spawn(executable, args, options);
    };
    const { controlled, taskId } = await appliedUnbornFixture(root, additionPatch, starter);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(insertedRef, true);
    assert.equal(git(root, "show-ref", "--verify", "refs/tags/concurrent").trim().split(" ")[0], concurrentCommit);
    assert.equal(currentHead(root), null);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), "added.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT failure cleans up only Bridge-staged proposal targets", async () => {
  const root = unbornRepository();
  const anchorPath = "recovery-anchor.md";
  let commitCalls = 0;
  const starter: GitStarter = (executable, args, options) => {
    if (executable === "git" && args.includes("commit")) {
      commitCalls += 1;
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  try {
    writeFileSync(join(root, anchorPath), "keep me\n");
    const { controlled, taskId } = await appliedUnbornFixture(root, additionPatch, starter);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(commitCalls, 1);
    assert.equal(currentHead(root), null);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(readFileSync(join(root, anchorPath), "utf8"), "keep me\n");
    assert.deepEqual(
      git(root, "ls-files", "--others", "--exclude-standard").trim().split("\n").sort(),
      ["added.txt", anchorPath]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial COMMIT preserves a created root commit when exact-path post-verification fails", async () => {
  const root = unbornRepository();
  const anchorPath = "recovery-anchor.md";
  try {
    writeFileSync(join(root, anchorPath), "keep me\n");
    const { controlled, taskId } = await appliedUnbornFixture(
      root,
      additionPatch,
      mutateBeforeCommit(() => git(root, "add", anchorPath))
    );

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: initial controlled commit",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    const committedHead = currentHead(root);
    assert.ok(committedHead !== null);
    assert.match(committedHead, /^[0-9a-f]{40,64}$/u);
    assert.deepEqual(
      git(root, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/u),
      [committedHead]
    );
    assert.deepEqual(
      git(root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD")
        .trim()
        .split("\n")
        .sort(),
      ["added.txt", anchorPath]
    );
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(git(root, "diff", "--name-only"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit-based proposal cannot be downgraded into the root-commit branch", async () => {
  const root = repository();
  try {
    const { controlled, taskId } = await appliedFixture(root);
    const headRef = git(root, "symbolic-ref", "--quiet", "HEAD").trim();
    git(root, "update-ref", "-d", headRef);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: must remain commit based",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(currentHead(root), null);
    assert.equal(git(root, "log", "--all", "--oneline"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT requires exact confirmation and an applied proposal", async () => {
  const root = repository();
  try {
    const current = fixture(root, async () => ({ kind: "completed", output: validPatch }));
    const generated = await current.controlled.generate({
      workspace_id: "workspace",
      change_request: "change note"
    });
    await terminal(current.tasks, generated.taskId);

    await expectCode(
      () => current.controlled.commit({
        patch_task_id: generated.taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "INVALID_STATE_TRANSITION"
    );

    await current.controlled.apply({
      patch_task_id: generated.taskId,
      confirmation: "APPLY"
    });

    await expectCode(
      () => current.controlled.commit({
        patch_task_id: generated.taskId,
        message: "feat: commit patch",
        confirmation: "commit"
      }),
      "INVALID_STATE_TRANSITION"
    );

    await expectCode(
      () => current.controlled.commit({
        patch_task_id: "00000000-0000-0000-0000-000000000000",
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "INVALID_STATE_TRANSITION"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT trims one-line messages and rejects empty multiline and overlong messages", async () => {
  for (const message of ["", "   ", "line one\nline two", "x".repeat(201)]) {
    const root = repository();
    try {
      const { controlled, taskId } = await appliedFixture(root);
      await expectCode(
        () => controlled.commit({
          patch_task_id: taskId,
          message,
          confirmation: "COMMIT"
        }),
        "WORKSPACE_PRECONDITION_FAILED"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("COMMIT rejects a changed base HEAD", async () => {
  const root = repository();
  try {
    const { controlled, taskId } = await appliedFixture(root);
    writeFileSync(join(root, "other.txt"), "other\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-qm", "advance head");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT rejects a nonempty index before staging", async () => {
  const root = repository();
  try {
    const { controlled, taskId } = await appliedFixture(root);
    writeFileSync(join(root, "other.txt"), "other\n");
    git(root, "add", "other.txt");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "other.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT rejects unrelated tracked dirt", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, "other.txt"), "base\n");
    git(root, "add", "other.txt");
    git(root, "commit", "-qm", "add other");
    const { controlled, taskId } = await appliedFixture(root);
    writeFileSync(join(root, "other.txt"), "dirty\n");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT preserves a pre-existing unrelated untracked file", async () => {
  const root = repository();
  const anchorPath = "docs/operations/recovery-anchor.md";
  try {
    mkdirSync(join(root, "docs", "operations"), { recursive: true });
    writeFileSync(join(root, anchorPath), "recovery anchor\n");
    const { controlled, taskId } = await appliedFixture(root);

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: commit patch",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "note.txt"
    );
    assert.equal(readFileSync(join(root, anchorPath), "utf8"), "recovery anchor\n");
    assert.equal(
      git(root, "ls-files", "--others", "--exclude-standard").trim(),
      anchorPath
    );
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(git(root, "diff", "--name-only"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT separates an untracked patch target from unrelated untracked files", async () => {
  const root = repository();
  const anchorPath = "recovery-anchor.md";
  try {
    writeFileSync(join(root, anchorPath), "anchor\n");
    const { controlled, taskId } = await appliedFixture(root, additionPatch);

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: commit added file",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "added.txt"
    );
    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(readFileSync(join(root, anchorPath), "utf8"), "anchor\n");
    assert.equal(
      git(root, "ls-files", "--others", "--exclude-standard").trim(),
      anchorPath
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT preserves NUL-enumerated unrelated files and symlinks", async () => {
  const root = repository();
  const directory = join(root, "anchors");
  const fileName = "recovery\nanchor.md";
  try {
    mkdirSync(directory);
    writeFileSync(join(directory, fileName), "anchor\n");
    symlinkSync("missing-target", join(directory, "recovery-link"));
    const { controlled, taskId } = await appliedFixture(root);

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: commit patch",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(readFileSync(join(directory, fileName), "utf8"), "anchor\n");
    assert.equal(readlinkSync(join(directory, "recovery-link")), "missing-target");
    assert.deepEqual(
      git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
      [`anchors/${fileName}`, "anchors/recovery-link"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT leaves ignored untracked state outside the recovery-anchor snapshot", async () => {
  const root = repository();
  const ignoredPath = join(root, "ignored", "cache.txt");
  try {
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    git(root, "add", ".gitignore");
    git(root, "commit", "-qm", "ignore cache");
    mkdirSync(join(root, "ignored"));
    writeFileSync(ignoredPath, "before\n");
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => writeFileSync(ignoredPath, "after\n"))
    );

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: commit patch",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(readFileSync(ignoredPath, "utf8"), "after\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT reports post-commit verification failure without rolling back and retry is deterministic", async () => {
  const root = repository();
  const anchorPath = join(root, "recovery-anchor.md");
  try {
    writeFileSync(anchorPath, "before\n");
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => writeFileSync(anchorPath, "after\n"))
    );
    const beforeHead = git(root, "rev-parse", "HEAD").trim();

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    const committedHead = git(root, "rev-parse", "HEAD").trim();
    assert.notEqual(committedHead, beforeHead);
    assert.equal(git(root, "rev-parse", "HEAD^").trim(), beforeHead);
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "note.txt"
    );
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(git(root, "diff", "--name-only"), "");
    assert.equal(readFileSync(anchorPath, "utf8"), "after\n");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), "recovery-anchor.md");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(git(root, "rev-parse", "HEAD").trim(), committedHead);
    assert.equal(git(root, "rev-parse", "HEAD^").trim(), beforeHead);
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "note.txt"
    );
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(git(root, "diff", "--name-only"), "");
    assert.equal(git(root, "ls-files", "--others", "--exclude-standard").trim(), "recovery-anchor.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT fails closed when a pre-existing unrelated untracked file is deleted", async () => {
  const root = repository();
  const anchorPath = join(root, "recovery-anchor.md");
  try {
    writeFileSync(anchorPath, "anchor\n");
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => rmSync(anchorPath, { force: true }))
    );

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT fails closed when a new unrelated untracked file appears", async () => {
  const root = repository();
  const anchorPath = join(root, "recovery-anchor.md");
  const newPath = join(root, "new-untracked.txt");
  try {
    writeFileSync(anchorPath, "anchor\n");
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => writeFileSync(newPath, "new\n"))
    );

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(readFileSync(anchorPath, "utf8"), "anchor\n");
    assert.equal(readFileSync(newPath, "utf8"), "new\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT fails closed when a pre-existing unrelated untracked file is replaced", async () => {
  const root = repository();
  const anchorPath = join(root, "recovery-anchor.md");
  try {
    writeFileSync(anchorPath, "same content\n");
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => {
        rmSync(anchorPath, { force: true });
        writeFileSync(anchorPath, "same content\n");
      })
    );

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT fails closed when a pre-existing unrelated untracked symlink is replaced", async () => {
  const root = repository();
  const anchorPath = join(root, "recovery-anchor-link");
  try {
    symlinkSync("missing-before", anchorPath);
    const { controlled, taskId } = await appliedFixture(
      root,
      validPatch,
      mutateBeforeCommit(() => {
        rmSync(anchorPath, { force: true });
        symlinkSync("missing-after", anchorPath);
      })
    );

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT rejects an unrelated untracked special file", {
  skip: process.platform === "win32"
}, async () => {
  const root = repository();
  try {
    execFileSync("mkfifo", [join(root, "recovery-anchor.fifo")]);
    const { controlled, taskId } = await appliedFixture(root);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT treats a tracked gitlink worktree as a special-path scan boundary", {
  skip: process.platform === "win32"
}, async () => {
  const root = repository();
  const submoduleRoot = repository();
  const submodulePath = join(root, "vendor", "dependency");
  try {
    writeFileSync(join(submoduleRoot, ".gitignore"), "recovery-anchor.fifo\n");
    git(submoduleRoot, "add", ".gitignore");
    git(submoduleRoot, "commit", "-qm", "ignore local recovery anchor");
    git(
      root,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submoduleRoot,
      "vendor/dependency"
    );
    git(root, "commit", "-qm", "add tracked submodule");
    execFileSync("mkfifo", [join(submodulePath, "recovery-anchor.fifo")]);
    const { controlled, taskId } = await appliedFixture(root);

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: commit patch",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "note.txt"
    );
    assert.equal(git(root, "status", "--porcelain"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(submoduleRoot, { recursive: true, force: true });
  }
});

test("COMMIT rechecks write authorization after APPLY", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  try {
    const current = fixture(
      root,
      async () => ({ kind: "completed", output: validPatch }),
      undefined,
      stateFilePath
    );
    const generated = await current.controlled.generate({
      workspace_id: "workspace",
      change_request: "change note"
    });
    await terminal(current.tasks, generated.taskId);
    await current.controlled.apply({
      patch_task_id: generated.taskId,
      confirmation: "APPLY"
    });

    const readOnlyRegistry = new RegisteredWorkspaceRegistry([]);
    readOnlyRegistry.registerManaged("workspace", root);
    const readOnlyTasks = new RegisteredWorkspaceTaskService(
      readOnlyRegistry,
      () => ({
        execute: async () => ({ kind: "completed", output: validPatch })
      })
    );
    const reloaded = new ControlledPatchService(
      readOnlyRegistry,
      readOnlyTasks,
      undefined,
      stateFilePath
    );
    await reloaded.load();

    await expectCode(
      () => reloaded.commit({
        patch_task_id: generated.taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateFilePath, { force: true });
  }
});

test("COMMIT rejects an applied path whose retained patch content no longer matches", async () => {
  const root = repository();
  try {
    const { controlled, taskId } = await appliedFixture(root);
    writeFileSync(join(root, "note.txt"), "tampered\n");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "tampered\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT rejects extra changes on a retained patch target", async () => {
  const root = repository();
  try {
    const { controlled, taskId } = await appliedFixture(root);
    writeFileSync(join(root, "note.txt"), "after\nextra\n");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\nextra\n");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT creates one commit from exactly the applied proposal paths", async () => {
  const root = repository();
  const gitCalls: Array<{ executable: string; args: readonly string[]; shell: unknown }> = [];
  const starter: GitStarter = (executable, args, options) => {
    gitCalls.push({ executable, args, shell: options.shell });
    return spawn(executable, args, options);
  };

  try {
    const { controlled, taskId } = await appliedFixture(root, validPatch, starter);
    const beforeHead = git(root, "rev-parse", "HEAD").trim();

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "  feat: commit applied patch  ",
      confirmation: "COMMIT"
    });

    assert.equal(result.patch_task_id, taskId);
    assert.equal(result.committed, true);
    assert.match(result.commit_sha, /^[0-9a-f]{40,64}$/u);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), result.commit_sha);
    assert.equal(git(root, "rev-parse", "HEAD^").trim(), beforeHead);
    assert.equal(
      git(root, "log", "-1", "--format=%s").trim(),
      "feat: commit applied patch"
    );
    assert.equal(
      git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim(),
      "note.txt"
    );
    assert.equal(git(root, "status", "--porcelain"), "");

    const commitCalls = gitCalls.filter(({ args }) => args.includes("commit"));
    assert.deepEqual(commitCalls, [{
      executable: "git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--no-verify",
        "-m",
        "feat: commit applied patch"
      ],
      shell: false
    }]);
    assert.equal(gitCalls.some(({ args }) => args.includes("push")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT fails closed on missing Git identity without editing config", async () => {
  const root = repository();
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "var" && args[1] === "GIT_AUTHOR_IDENT") {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };

  try {
    const { controlled, taskId } = await appliedFixture(root, validPatch, starter);
    const beforeConfig = git(root, "config", "--local", "--list");

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(git(root, "config", "--local", "--list"), beforeConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT failure unstages only Bridge paths and preserves modified worktree content", async () => {
  const root = repository();
  const starter: GitStarter = (executable, args, options) => {
    if (args.includes("commit")) {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };

  try {
    const { controlled, taskId } = await appliedFixture(root, validPatch, starter);
    const beforeHead = git(root, "rev-parse", "HEAD").trim();

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit patch",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
    assert.equal(git(root, "status", "--porcelain"), " M note.txt\n");
    assert.equal(git(root, "rev-parse", "HEAD").trim(), beforeHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT failure leaves an added proposal file present and untracked after cleanup", async () => {
  const root = repository();
  const starter: GitStarter = (executable, args, options) => {
    if (args.includes("commit")) {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };

  try {
    const { controlled, taskId } = await appliedFixture(root, additionPatch, starter);

    await expectCode(
      () => controlled.commit({
        patch_task_id: taskId,
        message: "feat: commit added file",
        confirmation: "COMMIT"
      }),
      "WORKSPACE_PRECONDITION_FAILED"
    );

    assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    assert.match(git(root, "status", "--porcelain"), /^\?\? added\.txt\n?$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("COMMIT recovers success when the subprocess reports failure after HEAD advances exactly once", async () => {
  const root = repository();
  const gitCalls: Array<readonly string[]> = [];
  const starter: GitStarter = (executable, args, options) => {
    gitCalls.push(args);
    if (args.includes("commit")) {
      return spawn(process.execPath, [
        "-e",
        "const cp=require('node:child_process');const [git,argsJson]=process.argv.slice(1);const r=cp.spawnSync(git,JSON.parse(argsJson),{cwd:process.cwd(),stdio:'inherit',shell:false});process.exit(r.status===0?1:(r.status??1));",
        executable,
        JSON.stringify(args)
      ], options);
    }
    return spawn(executable, args, options);
  };

  try {
    const { controlled, taskId } = await appliedFixture(root, validPatch, starter);
    const beforeHead = git(root, "rev-parse", "HEAD").trim();

    const result = await controlled.commit({
      patch_task_id: taskId,
      message: "feat: reconcile committed result",
      confirmation: "COMMIT"
    });

    assert.equal(result.committed, true);
    assert.equal(git(root, "rev-parse", "HEAD").trim(), result.commit_sha);
    assert.equal(git(root, "rev-parse", "HEAD^").trim(), beforeHead);
    assert.equal(git(root, "status", "--porcelain"), "");

    const commitCallIndex = gitCalls.findIndex((args) => args.includes("commit"));
    assert.notEqual(commitCallIndex, -1);
    assert.deepEqual(gitCalls.slice(commitCallIndex + 1), [
      ["rev-parse", "HEAD"],
      ["rev-list", "--parents", "-n", "1", "HEAD"],
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
      ["log", "-1", "--format=%s"],
      ["diff", "--cached", "--name-only", "-z"],
      ["diff", "--name-only", "-z", "--"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--git-dir"],
      ["ls-files", "--stage", "-z", "--"],
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      ["rev-parse", "--git-dir"],
      ["ls-files", "--stage", "-z", "--"]
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applies a valid patch when Markdown context contains fenced code", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add Markdown fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: markdownFencePatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change Markdown" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("recounts stale hunk line counts in a valid generated patch", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add generated patch fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: staleHunkCountPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change generated patch" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("applies a valid generated patch with zero context", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\ntail\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add zero-context fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: zeroContextPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change one line" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\ntail\n");
});

test("adds an absent 100644 text file", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: additionPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("applies a mixed modification and 100644 text addition", async () => {
  const root = repository();
  const mixedPatch = `${validPatch}${additionPatch}`;
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: mixedPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change and add" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("rejects addition targets already present in base HEAD, the worktree, or the index", async () => {
  for (const state of ["tracked", "untracked", "index"] as const) {
    const root = repository();
    const path = state === "tracked" ? "note.txt" : "added.txt";
    const patch = additionPatch.replaceAll("added.txt", path);
    if (state === "untracked") writeFileSync(join(root, path), "collision\n");
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: patch }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, generated.taskId);
    if (state === "index") {
      writeFileSync(join(root, path), "indexed\n");
      git(root, "add", path);
    }
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("rejects unsafe or structurally invalid additions", async () => {
  const invalidPatches = [
    additionPatch.replace("new file mode 100644", "new file mode 100755"),
    additionPatch.replace("new file mode 100644", "new file mode 120000"),
    additionPatch.replace("new file mode 100644", "new file mode 160000"),
    additionPatch.replace("index 0000000..3e75765", "GIT binary patch\nliteral 0\nHcmV?d00001"),
    additionPatch.replace("new file mode 100644", "deleted file mode 100644").replace("--- /dev/null", "--- a/added.txt").replace("+++ b/added.txt", "+++ /dev/null"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\nrename from old.txt\nrename to added.txt"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\ncopy from old.txt\ncopy to added.txt"),
    `${additionPatch}${additionPatch}`,
    additionPatch.replace("diff --git a/added.txt b/added.txt", "diff --git added.txt added.txt"),
    additionPatch.replace("+++ b/added.txt", "+++ b/other.txt"),
    additionPatch.replaceAll("added.txt", "../added.txt")
  ];

  for (const output of invalidPatches) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, generated.taskId);
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("collapses extra trailing LFs in controlled patch results", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: `${validPatch}\n\n`
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch
  });
});

test("requires exact confirmation and a successfully completed generation task", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  const { controlled, tasks } = fixture(root, () => pending);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "apply" }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
  finish({ kind: "failed", error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." } });
  await terminal(tasks, generated.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
});

test("removes a proposal when its controlled patch generation task fails", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await terminal(tasks, generated.taskId);

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.equal(proposals.has(generated.taskId), false);
});

test("rejects dirty workspaces, changed HEAD, and malformed or out-of-scope patches", async () => {
  const dirtyRoot = repository();
  writeFileSync(join(dirtyRoot, "note.txt"), "dirty\n");
  const dirty = fixture(dirtyRoot, async () => ({ kind: "completed", output: validPatch })).controlled;
  await expectCode(() => dirty.generate({ workspace_id: "workspace", change_request: "change" }), "WORKSPACE_PRECONDITION_FAILED");

  for (const output of ["```diff\n" + validPatch + "```", validPatch.replaceAll("note.txt", "new.txt")]) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
    await terminal(tasks, generated.taskId);
    await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
  }

  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: validPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("bounds applied proposal history without evicting live proposed or applying proposals", async () => {
  const root = repository();
  let next = 0;
  const { controlled, tasks } = fixture(root, async () => {
    const path = `added-${next++}.txt`;
    return { kind: "completed", output: additionPatch.replaceAll("added.txt", path) };
  });
  const appliedTaskIds: string[] = [];

  for (let index = 0; index < 101; index += 1) {
    const proposal = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, proposal.taskId);
    await controlled.apply({ patch_task_id: proposal.taskId, confirmation: "APPLY" });
    appliedTaskIds.push(proposal.taskId);
    git(root, "add", ".");
    git(root, "commit", "-qm", `apply ${index}`);
  }

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.equal(proposals.has(appliedTaskIds[0]!), false);
  for (const taskId of appliedTaskIds.slice(1)) assert.equal(proposals.get(taskId)?.state, "applied");

  const live = await controlled.generate({ workspace_id: "workspace", change_request: "add live file" });
  const applying = await controlled.generate({ workspace_id: "workspace", change_request: "add applying file" });
  proposals.get(applying.taskId)!.state = "applying";
  assert.equal(proposals.size, 102);

  await terminal(tasks, live.taskId);
  assert.equal((await controlled.apply({ patch_task_id: live.taskId, confirmation: "APPLY" })).applied, true);
  assert.equal(proposals.get(applying.taskId)?.state, "applying");
});

test("generates and refines proposals for an unborn repository with an explicit unborn instruction", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const instructions: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => {
      instructions.push(request.instruction);
      return { kind: "completed", output: additionPatch };
    }
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  assert.equal(generated.baseHead, null);
  await terminal(tasks, generated.taskId);
  const generateInstruction = instructions[0] ?? "";
  assert.match(generateInstruction, /unborn repository state/u);
  assert.match(generateInstruction, /only add ordinary text files using new file mode 100644/u);
  // No fake HEAD: never "Base HEAD: null" or a fabricated SHA. (The embedded
  // source diff legitimately contains "/dev/null" headers.)
  assert.equal(generateInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(generateInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(generateInstruction), false);

  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" });
  assert.equal(refined.baseHead, null);
  await terminal(tasks, refined.taskId);
  const refinementInstruction = instructions[1] ?? "";
  assert.match(refinementInstruction, /unborn repository state/u);
  assert.match(refinementInstruction, /only add ordinary text files using new file mode 100644/u);
  assert.equal(refinementInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(refinementInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(refinementInstruction), false);
});

test("applies an unborn proposal while the repository stays unborn and does not stage files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
  // git apply without --index never stages the new file.
  assert.equal(git(root, "ls-files", "--stage").trim(), "");
});

test("rejects an unborn proposal once the repository gains its first commit", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "commit", "-qm", "first commit");

  // Both refine and APPLY must reject the stale unborn proposal.
  await expectCode(() => controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" }), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("rejects unborn modified targets and targets that already exist as untracked files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const modified = await controlled.generate({ workspace_id: "workspace", change_request: "modify" });
  await terminal(tasks, modified.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: modified.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  const conflictingTasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const conflicting = new ControlledPatchService(registry, conflictingTasks);
  const generated = await conflicting.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(conflictingTasks, generated.taskId);
  writeFileSync(join(root, "added.txt"), "user content\n");
  await expectCode(() => conflicting.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("retained-state loader accepts old and new commit bases and quarantines illegal base combinations", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const oldRecord = {
    version: 1,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000001",
      workspace_id: "workspace",
      workspace_root: root,
      base_head: head,
      state: "proposed",
      output: validPatch
    }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(oldRecord, null, 2)}\n`);
  const oldTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
  const oldLoaded = new ControlledPatchService(registry, oldTasks, undefined, stateFilePath);
  await oldLoaded.load();
  const oldProposals = (oldLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals;
  assert.equal(oldProposals.get("00000000-0000-4000-8000-000000000001")?.base.kind, "commit");

  const newCommitRecord = {
    ...oldRecord,
    proposals: [{ ...oldRecord.proposals[0]!, unborn: false }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(newCommitRecord, null, 2)}\n`);
  const newCommitTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
  const newCommitLoaded = new ControlledPatchService(registry, newCommitTasks, undefined, stateFilePath);
  await newCommitLoaded.load();
  assert.equal(
    (newCommitLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000001")?.base.kind,
    "commit"
  );

  const unbornRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-state-")));
  git(unbornRoot, "init", "-q");
  const unbornStateFilePath = retainedStateFile();
  writeFileSync(unbornStateFilePath, `${JSON.stringify({
    version: 1,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000002",
      workspace_id: "unborn-workspace",
      workspace_root: unbornRoot,
      base_head: null,
      unborn: true,
      state: "proposed",
      output: additionPatch
    }]
  }, null, 2)}\n`);
  const unbornRegistry = new RegisteredWorkspaceRegistry([{ id: "unborn-workspace", root: unbornRoot, allow_write: true }]);
  const unbornTasks = new RegisteredWorkspaceTaskService(unbornRegistry, () => ({ execute: async () => ({ kind: "completed", output: additionPatch }) }));
  const unbornLoaded = new ControlledPatchService(unbornRegistry, unbornTasks, undefined, unbornStateFilePath);
  await unbornLoaded.load();
  assert.equal(
    (unbornLoaded as unknown as { proposals: Map<string, { base: { kind: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000002")?.base.kind,
    "unborn"
  );

  // Restart recovery: the restored unborn proposal can still be refined and applied.
  const refined = await unbornLoaded.refine({ patch_task_id: "00000000-0000-4000-8000-000000000002", change_request: "adjust" });
  assert.equal(refined.baseHead, null);
  await terminal(unbornTasks, refined.taskId);
  const restoredApplied = await unbornLoaded.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.equal(restoredApplied.applied, true);
  assert.equal(readFileSync(join(unbornRoot, "added.txt"), "utf8"), "added\n");

  for (const [baseHead, unborn] of [[null, false], [head, true], [null, undefined]] as const) {
    // JSON.stringify drops the undefined key: [null, undefined] is exactly the
    // "base_head null with no unborn field" illegal combination. Each illegal
    // base makes only that proposal unrecoverable, so it is quarantined while
    // the rest of the state still loads.
    writeFileSync(stateFilePath, `${JSON.stringify({
      version: 1,
      applied_task_ids: [],
      proposals: [{
        task_id: "00000000-0000-4000-8000-000000000003",
        workspace_id: "workspace",
        workspace_root: root,
        base_head: baseHead,
        unborn,
        state: "proposed",
        output: validPatch
      }]
    }, null, 2)}\n`);
    const invalidTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
    const invalid = new ControlledPatchService(registry, invalidTasks, undefined, stateFilePath);
    await invalid.load();
    const proposals = (invalid as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.equal(proposals.has("00000000-0000-4000-8000-000000000003"), false);
  }
});

test("generation needs no write authorization; APPLY does, and AUTHORIZE afterwards enables the same proposal", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce(root);
  registry.registerManaged(id, root);
  const onboarding = new WorkspaceOnboardingService(registry, catalog, []);
  const stateFilePath = retainedStateFile();
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);

  // Any registered workspace can generate a read-only proposal.
  const generated = await controlled.generate({ workspace_id: id, change_request: "add file" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, generated.taskId);

  // Refinement is also read-only analysis: no write authorization needed.
  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" });
  assert.equal(refined.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, refined.taskId);

  // APPLY still requires controlled-write authorization.
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  // AUTHORIZE the managed workspace, then the SAME proposal applies.
  const authorized = await onboarding.authorizeWrite(id);
  assert.deepEqual(authorized, { workspace_id: id, allow_write: true });
  assert.equal(registry.resolveWritable(id), root);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");

  // Restart recovery: the authorized state round-trips through the catalog and registry.
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of catalog.entries()) reloadedRegistry.registerManaged(entry.id, entry.root, entry.allowWrite);
  assert.equal(reloadedRegistry.resolveWritable(id), root);
});

test("HEAD detection fails closed: a git helper spawn failure in a real unborn repo is not inferred as unborn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  // The repository is genuinely unborn, but the HEAD probe cannot even spawn:
  // that must fail closed, never be guessed as unborn.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      throw new Error("simulated git spawn failure");
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a nonzero rev-parse without unborn proof is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  // rev-parse HEAD exits non-zero exactly as in an unborn repo, but the branch
  // symbolic ref resolves to a real commit: an inconsistent reference state,
  // not an unborn branch.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a detached-style unresolvable HEAD is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  // HEAD cannot resolve and there is no symbolic branch ref behind it (as with
  // a missing or detached HEAD): without a branch ref, unborn is unproven.
  const starter: GitStarter = (executable, args, options) => {
    if (args.includes("--quiet")) {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a non-branch symbolic HEAD is not inferred as unborn", async () => {
  // A real repository whose HEAD symbolic ref points outside refs/heads/: git
  // reports no resolvable HEAD, but this is not an unborn branch state.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/tags/nonexistent\n");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

function retainedRecord(
  taskId: string,
  root: string,
  head: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    task_id: taskId,
    workspace_id: "workspace",
    workspace_root: root,
    base_head: head,
    state: "proposed",
    executor: "codex",
    output: validPatch,
    ...overrides
  };
}

function retainedTaskId(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function writeRetainedState(stateFilePath: string, state: unknown): void {
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

test("bulk hydration preserves mixed retained task semantics and terminal ordering", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();

  const oldestAppliedId = retainedTaskId(1);
  const oldestConflictId = retainedTaskId(2);
  const appliedTaskIds = [
    oldestAppliedId,
    ...Array.from({ length: 99 }, (_, index) => retainedTaskId(index + 3))
  ];
  const recentDshAppliedId = appliedTaskIds.at(-2)!;
  const recentSubmittedAppliedId = appliedTaskIds.at(-1)!;
  const proposedDshId = retainedTaskId(102);
  const proposedSubmittedId = retainedTaskId(103);
  const recentConflictId = retainedTaskId(104);

  const appliedRecords = appliedTaskIds.map((taskId) => retainedRecord(taskId, root, head, {
    state: "applied",
    output: `applied:${taskId}\n`
  }));
  appliedRecords[appliedRecords.length - 2] = retainedRecord(recentDshAppliedId, root, head, {
    state: "applied",
    executor: "dsh",
    output: "dsh applied output\n"
  });
  appliedRecords[appliedRecords.length - 1] = retainedRecord(recentSubmittedAppliedId, root, head, {
    state: "applied",
    executor: undefined,
    source: "submitted",
    output: "submitted applied output\n"
  });

  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: appliedTaskIds,
    proposals: [
      appliedRecords[0]!,
      retainedRecord(oldestConflictId, root, head, {
        state: "recovery_conflict",
        output: "old conflict output\n"
      }),
      ...appliedRecords.slice(1),
      retainedRecord(proposedDshId, root, head, {
        executor: "dsh",
        output: "dsh proposed output\n"
      }),
      retainedRecord(proposedSubmittedId, root, head, {
        executor: undefined,
        source: "submitted",
        output: "submitted proposed output\n"
      }),
      retainedRecord(recentConflictId, root, head, {
        state: "recovery_conflict",
        executor: "dsh",
        output: "recent conflict output\n"
      })
    ]
  });
  const originalState = readFileSync(stateFilePath, "utf8");
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => { throw new Error("restored tasks must not execute"); }
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);

  await controlled.load();

  // There are 102 unpinned terminal records. Existing ordering evicts the
  // oldest applied record and oldest conflict, leaving exactly the newest 100.
  assert.equal(tasks.taskView(oldestAppliedId), undefined);
  assert.equal(tasks.result(oldestAppliedId), undefined);
  assert.equal(tasks.taskView(oldestConflictId), undefined);
  for (const taskId of appliedTaskIds.slice(1)) assert.notEqual(tasks.taskView(taskId), undefined);

  // Proposed tasks are pinned before retention and remain reachable above cap.
  assert.deepEqual(tasks.taskView(proposedDshId), {
    taskId: proposedDshId,
    state: "completed",
    executor: "dsh",
    ready: true,
    output: "dsh proposed output\n"
  });
  assert.deepEqual(tasks.result(proposedDshId), {
    id: proposedDshId,
    state: "completed",
    output: "dsh proposed output\n"
  });
  assert.deepEqual(tasks.taskView(proposedSubmittedId), {
    taskId: proposedSubmittedId,
    state: "completed",
    source: "submitted",
    ready: true,
    output: "submitted proposed output\n"
  });
  assert.equal("executor" in (tasks.taskView(proposedSubmittedId) ?? {}), false);

  // Unpinned retained records preserve output and provenance when they survive.
  assert.equal(tasks.taskView(recentDshAppliedId)?.executor, "dsh");
  assert.equal(tasks.taskView(recentDshAppliedId)?.output, "dsh applied output\n");
  assert.equal(tasks.taskView(recentSubmittedAppliedId)?.source, "submitted");
  assert.equal("executor" in (tasks.taskView(recentSubmittedAppliedId) ?? {}), false);
  assert.deepEqual(tasks.result(recentSubmittedAppliedId), {
    id: recentSubmittedAppliedId,
    state: "completed",
    output: "submitted applied output\n"
  });

  assert.deepEqual(tasks.taskView(recentConflictId), {
    taskId: recentConflictId,
    state: "failed",
    executor: "dsh",
    ready: true,
    error: {
      code: "APPLY_RECOVERY_CONFLICT",
      message: "The applied patch state could not be recovered safely."
    }
  });
  assert.equal(tasks.result(recentConflictId)?.state, "failed");
  await expectCode(
    () => controlled.apply({ patch_task_id: recentConflictId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );

  // No applying record exists, so load must accept version 1 without migration
  // or a compatibility rewrite.
  assert.equal(readFileSync(stateFilePath, "utf8"), originalState);
});

test("quarantines a single malformed proposal field while restoring the valid proposal", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const goodId = "00000000-0000-4000-8000-000000000001";
  const badId = "00000000-0000-4000-8000-000000000002";
  const badVariants: Array<Record<string, unknown>> = [
    { state: "bogus" },
    { output: 42 },
    { base_head: "not-a-hex" },
    { unborn: "yes" },
    { workspace_id: "" },
    { workspace_root: 42 },
    { parent_task_id: "not-a-uuid" }
  ];

  for (const badFields of badVariants) {
    const stateFilePath = retainedStateFile();
    writeRetainedState(stateFilePath, {
      version: 1,
      applied_task_ids: [],
      proposals: [
        retainedRecord(goodId, root, head),
        retainedRecord(badId, root, head, badFields)
      ]
    });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await controlled.load();

    const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.deepEqual([...proposals.keys()], [goodId]);
    assert.equal(tasks.taskView(goodId)?.state, "completed");
    // The quarantined record is unreachable through every proposal surface.
    assert.equal(tasks.taskView(badId), undefined);
    assert.equal(tasks.result(badId), undefined);
    await expectCode(() => controlled.refine({
      patch_task_id: badId,
      change_request: "improve"
    }), "INVALID_STATE_TRANSITION");
    await expectCode(() => controlled.apply({
      patch_task_id: badId,
      confirmation: "APPLY"
    }), "INVALID_STATE_TRANSITION");
  }
});

test("quarantines a proposal with an invalid task id without touching the valid proposals", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [
      retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
      retainedRecord("not-a-uuid", root, head),
      retainedRecord("00000000-0000-4000-8000-000000000003", root, head)
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.deepEqual(
    [...proposals.keys()],
    ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000003"]
  );
  assert.equal(proposals.size, 2);
});

test("quarantines proposals whose workspace is unregistered or whose root moved, keeping the rest", async () => {
  const root = repository();
  const other = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const otherHead = git(other, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [
      retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
      // Unregistered workspace: registry.resolve throws UNKNOWN_WORKSPACE.
      retainedRecord("00000000-0000-4000-8000-000000000002", other, otherHead, { workspace_id: "ghost" }),
      // Registered id whose persisted root no longer matches the registry.
      retainedRecord("00000000-0000-4000-8000-000000000003", other, otherHead)
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.deepEqual([...proposals.keys()], ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(tasks.taskView("00000000-0000-4000-8000-000000000001")?.state, "completed");
  for (const skipped of ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]) {
    assert.equal(proposals.has(skipped), false);
    assert.equal(tasks.taskView(skipped), undefined);
    await expectCode(() => controlled.apply({ patch_task_id: skipped, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
  }
});

test("a single bad proposal record does not prevent Bridge startup", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const badStates: unknown[] = [
    { version: 1, applied_task_ids: [], proposals: [retainedRecord("00000000-0000-4000-8000-000000000001", root, head, { output: 42 })] },
    { version: 1, applied_task_ids: [], proposals: [null] }
  ];
  for (const state of badStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await controlled.load();

    const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.equal(proposals.size, 0);
    const appliedProposalTaskIds = (controlled as unknown as { appliedProposalTaskIds: string[] }).appliedProposalTaskIds;
    assert.deepEqual(appliedProposalTaskIds, []);
  }
});

test("drops the applied history entry of a quarantined applied proposal and keeps the rest not re-appliable", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const badAppliedId = "00000000-0000-4000-8000-000000000001";
  const goodAppliedId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [badAppliedId, goodAppliedId],
    proposals: [
      // Malformed output makes this applied record unrecoverable: it and its
      // applied_task_ids entry are quarantined together.
      retainedRecord(badAppliedId, root, head, { state: "applied", output: 42 }),
      retainedRecord(goodAppliedId, root, head, { state: "applied" })
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.deepEqual([...proposals.keys()], [goodAppliedId]);
  assert.equal(proposals.get(goodAppliedId)?.state, "applied");
  const appliedProposalTaskIds = (controlled as unknown as { appliedProposalTaskIds: string[] }).appliedProposalTaskIds;
  assert.deepEqual(appliedProposalTaskIds, [goodAppliedId]);
  // The surviving applied proposal must not become re-appliable.
  await expectCode(() => controlled.apply({
    patch_task_id: goodAppliedId,
    confirmation: "APPLY"
  }), "INVALID_STATE_TRANSITION");
});

test("retained state fails closed: unsupported version and invalid top-level structure", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const invalidStates: unknown[] = [
    { version: 2, applied_task_ids: [], proposals: [retainedRecord("00000000-0000-4000-8000-000000000001", root, head)] },
    { version: 1, proposals: [] },
    { version: 1, applied_task_ids: [], proposals: "nope" }
  ];
  for (const state of invalidStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: applied_task_ids itself is invalid", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const stateFilePath = retainedStateFile();
  const invalidAppliedLists: unknown[] = [
    "nope",
    [123],
    ["not-a-uuid"],
    [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001"
    ]
  ];
  for (const appliedTaskIds of invalidAppliedLists) {
    writeRetainedState(stateFilePath, { version: 1, applied_task_ids: appliedTaskIds, proposals: [] });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: duplicate proposal task ids are ambiguous even with a broken duplicate", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const duplicateStates: unknown[] = [
    // Two otherwise valid records with the same task id.
    {
      version: 1,
      applied_task_ids: [],
      proposals: [
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head)
      ]
    },
    // One broken duplicate could claim a different applied state than the
    // valid record, so the duplicate id always fails closed.
    {
      version: 1,
      applied_task_ids: [],
      proposals: [
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
        retainedRecord("00000000-0000-4000-8000-000000000001", root, head, { state: "applied", output: 42 })
      ]
    }
  ];
  for (const state of duplicateStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: applied_task_ids contradicts the surviving proposal states", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const contradictoryStates: unknown[] = [
    // Applied history claims a proposal the record says is only proposed.
    {
      version: 1,
      applied_task_ids: [firstId],
      proposals: [retainedRecord(firstId, root, head)]
    },
    // A proposal claims to be applied but is missing from applied history.
    {
      version: 1,
      applied_task_ids: [],
      proposals: [retainedRecord(firstId, root, head, { state: "applied" })]
    },
    // Applied history claims a proposal stuck in the interrupted applying state.
    {
      version: 1,
      applied_task_ids: [firstId, secondId],
      proposals: [
        retainedRecord(firstId, root, head, { state: "applied" }),
        retainedRecord(secondId, root, head, { state: "applying" })
      ]
    }
  ];
  for (const state of contradictoryStates) {
    writeRetainedState(stateFilePath, state);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("retained state fails closed: an applied id with no backing proposal record at all", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: ["00000000-0000-4000-8000-000000000001"],
    proposals: []
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await expectCode(() => controlled.load(), "INTERNAL_ERROR");
});

test("keeps a child proposal usable when its parent record is quarantined", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const parentId = "00000000-0000-4000-8000-000000000001";
  const childId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [
      // Bad parent record: quarantined on its own merits.
      retainedRecord(parentId, root, head, { state: "bogus" }),
      retainedRecord(childId, root, head, { parent_task_id: parentId })
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, { parentTaskId?: string }> }).proposals;
  assert.deepEqual([...proposals.keys()], [childId]);
  // The dangling parent link (audit lineage only) is retained and harmless.
  assert.equal(proposals.get(childId)?.parentTaskId, parentId);
  assert.equal(tasks.taskView(childId)?.state, "completed");
  const refined = await controlled.refine({ patch_task_id: childId, change_request: "improve" });
  await terminal(tasks, refined.taskId);
  const applied = await controlled.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("retained state fails closed: a surviving parent contradicts the child workspace or base", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([
    { id: "workspace", root, allow_write: true },
    { id: "other", root, allow_write: true }
  ]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const parentId = "00000000-0000-4000-8000-000000000001";
  const childId = "00000000-0000-4000-8000-000000000002";
  const stateFilePath = retainedStateFile();
  const inconsistentChildren: Array<Record<string, unknown>> = [
    // Child base differs from the surviving parent's base.
    { parent_task_id: parentId, base_head: "1111111111111111111111111111111111111111" },
    // Child workspace differs from the surviving parent's workspace.
    { parent_task_id: parentId, workspace_id: "other" }
  ];
  for (const childOverrides of inconsistentChildren) {
    writeRetainedState(stateFilePath, {
      version: 1,
      applied_task_ids: [],
      proposals: [
        retainedRecord(parentId, root, head),
        retainedRecord(childId, root, head, childOverrides)
      ]
    });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await expectCode(() => controlled.load(), "INTERNAL_ERROR");
  }
});

test("keeps a refine chain usable across restart when refining a restored child", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const refinedPatch = validPatch.replace("+after", "+refined after");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, source.taskId);
  const refined = await first.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording"
  });
  await terminal(first.tasks, refined.taskId);

  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: refinedPatch }),
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  // Refining the restored child, not the source: the chain stays usable.
  const refined2 = await restarted.controlled.refine({
    patch_task_id: refined.taskId,
    change_request: "polish"
  });
  await terminal(restarted.tasks, refined2.taskId);

  assert.equal(refined2.baseHead, source.baseHead);
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; parent_task_id?: string }>;
  };
  assert.equal(state.proposals.find(({ task_id }) => task_id === refined2.taskId)?.parent_task_id, refined.taskId);
  const applied = await restarted.controlled.apply({ patch_task_id: refined2.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined after\n");
});

test("generate routes an explicit dsh executor to the factory and reports dsh in taskView", async () => {
  const root = repository();
  const factoryCalls: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, (executor) => {
    factoryCalls.push(executor);
    return { execute: async () => ({ kind: "completed", output: validPatch }) };
  });
  const controlled = new ControlledPatchService(registry, tasks);
  const generated = await controlled.generate({
    workspace_id: "workspace",
    change_request: "change note",
    executor: "dsh"
  });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(factoryCalls, ["dsh"]);
  assert.equal(tasks.taskView(generated.taskId)?.executor, "dsh");
});

test("generate without executor keeps the codex default", async () => {
  const root = repository();
  const factoryCalls: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, (executor) => {
    factoryCalls.push(executor);
    return { execute: async () => ({ kind: "completed", output: validPatch }) };
  });
  const controlled = new ControlledPatchService(registry, tasks);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(factoryCalls, ["codex"]);
  assert.equal(tasks.taskView(generated.taskId)?.executor, "codex");
});

test("refine selects the executor per call and never inherits the parent proposal's executor", async () => {
  const root = repository();
  const factoryCalls: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, (executor) => {
    factoryCalls.push(executor);
    return { execute: async () => ({ kind: "completed", output: validPatch }) };
  });
  const controlled = new ControlledPatchService(registry, tasks);
  const source = await controlled.generate({
    workspace_id: "workspace",
    change_request: "change note",
    executor: "dsh"
  });
  await terminal(tasks, source.taskId);

  const refinedDsh = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "adjust",
    executor: "dsh"
  });
  await terminal(tasks, refinedDsh.taskId);
  const refinedDefault = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "polish"
  });
  await terminal(tasks, refinedDefault.taskId);

  assert.deepEqual(factoryCalls, ["dsh", "dsh", "codex"]);
  assert.equal(tasks.taskView(refinedDsh.taskId)?.executor, "dsh");
  assert.equal(tasks.taskView(refinedDefault.taskId)?.executor, "codex");
});

test("persists the proposal executor and restores a dsh proposal after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(root, async () => ({ kind: "completed", output: validPatch }), undefined, stateFilePath);
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note",
    executor: "dsh"
  });
  await terminal(first.tasks, generated.taskId);

  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; executor?: unknown }>;
  };
  assert.equal(state.proposals.find(({ task_id }) => task_id === generated.taskId)?.executor, "dsh");

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();

  assert.deepEqual(restarted.tasks.taskView(generated.taskId), {
    taskId: generated.taskId,
    state: "completed",
    executor: "dsh",
    ready: true,
    output: validPatch
  });
});

test("restores a legacy retained proposal without an executor field as codex", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000001",
      workspace_id: "workspace",
      workspace_root: root,
      base_head: head,
      state: "proposed",
      output: validPatch
    }]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  assert.equal(tasks.taskView("00000000-0000-4000-8000-000000000001")?.executor, "codex");
});

test("quarantines a retained proposal with an invalid executor instead of downgrading to codex", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [
      retainedRecord("00000000-0000-4000-8000-000000000001", root, head),
      retainedRecord("00000000-0000-4000-8000-000000000002", root, head, { executor: "gemini" })
    ]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.deepEqual([...proposals.keys()], ["00000000-0000-4000-8000-000000000001"]);
  assert.equal(tasks.taskView("00000000-0000-4000-8000-000000000002"), undefined);
  assert.equal(tasks.result("00000000-0000-4000-8000-000000000002"), undefined);
  await expectCode(() => controlled.apply({
    patch_task_id: "00000000-0000-4000-8000-000000000002",
    confirmation: "APPLY"
  }), "INVALID_STATE_TRANSITION");
});

test("applies a dsh-generated proposal without invoking any executor again", async () => {
  const root = repository();
  let executions = 0;
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => {
    executions += 1;
    return { execute: async () => ({ kind: "completed", output: validPatch }) };
  });
  const controlled = new ControlledPatchService(registry, tasks);
  const generated = await controlled.generate({
    workspace_id: "workspace",
    change_request: "change note",
    executor: "dsh"
  });
  await terminal(tasks, generated.taskId);
  assert.equal(executions, 1);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(executions, 1);
});

test("submit_controlled_patch registers a retained submitted proposal that APPLY applies without any executor", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  let executions = 0;
  const { controlled, tasks } = fixture(root, async () => {
    executions += 1;
    throw new Error("submitted tasks must not execute");
  }, undefined, stateFilePath);
  const head = git(root, "rev-parse", "HEAD").trim();
  const submitted = await controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch });

  assert.equal(submitted.baseHead, head);
  assert.equal(executions, 0);
  assert.deepEqual(tasks.taskView(submitted.taskId), {
    taskId: submitted.taskId,
    state: "completed",
    source: "submitted",
    ready: true,
    output: validPatch
  });
  assert.equal(tasks.taskView(submitted.taskId)?.executor, undefined);
  assert.deepEqual(tasks.result(submitted.taskId), {
    id: submitted.taskId,
    state: "completed",
    output: validPatch
  });
  // The retained record uses source: "submitted" and carries no executor field.
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; executor?: unknown; source?: unknown }>;
  };
  const retained = state.proposals.find(({ task_id }) => task_id === submitted.taskId);
  assert.ok(retained);
  assert.equal(retained.source, "submitted");
  assert.equal("executor" in retained, false);

  const applied = await controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(executions, 0);
});

test("submit rejects a base_head that is not exactly the current commit HEAD", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => {
    throw new Error("must not execute");
  });
  const head = git(root, "rev-parse", "HEAD").trim();
  await expectCode(() => controlled.submit({
    workspace_id: "workspace",
    base_head: "0".repeat(40),
    diff: validPatch
  }), "WORKSPACE_PRECONDITION_FAILED");

  // A previously correct base_head becomes stale once HEAD moves.
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.submit({
    workspace_id: "workspace",
    base_head: head,
    diff: validPatch
  }), "WORKSPACE_PRECONDITION_FAILED");

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.equal(proposals.size, 0);
});

test("submit rejects unsafe diffs and dirty workspaces with the shared preflight without registering anything", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => {
    throw new Error("must not execute");
  });
  const head = git(root, "rev-parse", "HEAD").trim();

  for (const diff of [
    "not a patch",
    `\`\`\`diff\n${validPatch}\`\`\``,
    validPatch.replaceAll("note.txt", "new.txt"),
    additionPatch.replace("new file mode 100644", "new file mode 100755")
  ]) {
    await expectCode(() => controlled.submit({ workspace_id: "workspace", base_head: head, diff }),
      "WORKSPACE_PRECONDITION_FAILED");
  }

  // A dirty worktree fails the same workspace preflight as generate and APPLY.
  writeFileSync(join(root, "note.txt"), "dirty\n");
  await expectCode(() => controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch }),
    "WORKSPACE_PRECONDITION_FAILED");

  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.equal(proposals.size, 0);
});

test("submit requires no write authorization; APPLY still re-verifies it", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: false }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => {
    throw new Error("submitted tasks must not execute");
  });
  const controlled = new ControlledPatchService(registry, tasks);
  const head = git(root, "rev-parse", "HEAD").trim();
  const submitted = await controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch });
  assert.equal(submitted.baseHead, head);

  // APPLY still requires controlled-write authorization for submitted proposals.
  await expectCode(() => controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED");
});

test("a submitted proposal survives restart and APPLY re-verifies HEAD, workspace, patch safety, and write authorization", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(root, async () => { throw new Error("must not execute"); }, undefined, stateFilePath);
  const head = git(root, "rev-parse", "HEAD").trim();
  const submitted = await first.controlled.submit({ workspace_id: "workspace", base_head: head, diff: validPatch });

  const restarted = fixture(root, async () => { throw new Error("restored tasks must not execute"); }, undefined, stateFilePath);
  await restarted.controlled.load();

  assert.deepEqual(restarted.tasks.taskView(submitted.taskId), {
    taskId: submitted.taskId,
    state: "completed",
    source: "submitted",
    ready: true,
    output: validPatch
  });
  assert.equal(restarted.tasks.taskView(submitted.taskId)?.executor, undefined);
  assert.deepEqual(restarted.tasks.result(submitted.taskId), {
    id: submitted.taskId,
    state: "completed",
    output: validPatch
  });

  // HEAD drift is re-verified at APPLY: a new commit invalidates the submitted base.
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => restarted.controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" }),
    "WORKSPACE_PRECONDITION_FAILED");

  // Reset to the submitted base on a clean worktree: APPLY applies the retained diff.
  git(root, "reset", "--hard", head);
  const applied = await restarted.controlled.apply({ patch_task_id: submitted.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("A consistent submitted record restores with submitted provenance and no executor identity", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const taskId = "00000000-0000-4000-8000-000000000001";
  const stateFilePath = retainedStateFile();
  // retainedRecord(...) defaults to executor: "codex"; the explicit
  // executor: undefined before source: "submitted" makes JSON serialization
  // truly omit the executor field.
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [{
      ...retainedRecord(taskId, root, head),
      executor: undefined,
      source: "submitted"
    }]
  });
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => { throw new Error("restored tasks must not execute"); }
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  assert.deepEqual(tasks.taskView(taskId), {
    taskId,
    state: "completed",
    source: "submitted",
    ready: true,
    output: validPatch
  });
  assert.equal(tasks.taskView(taskId)?.executor, undefined);
  // The restored submitted proposal stays usable through the existing APPLY flow.
  const applied = await controlled.apply({ patch_task_id: taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("quarantines submitted retained records that carry an executor identity or an unknown source", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const inconsistent: Array<Record<string, unknown>> = [
    // source "submitted" must never also claim an executor.
    { ...retainedRecord("00000000-0000-4000-8000-000000000001", root, head), source: "submitted" },
    // any other source value is invalid retained state.
    { ...retainedRecord("00000000-0000-4000-8000-000000000002", root, head), source: "generated" }
  ];
  for (const record of inconsistent) {
    writeRetainedState(stateFilePath, {
      version: 1,
      applied_task_ids: [],
      proposals: [record]
    });
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
    await controlled.load();
    const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
    assert.equal(proposals.size, 0);
    assert.equal(tasks.taskView(record.task_id as string), undefined);
  }
});

test("interrupts a running generate_controlled_patch through control_task and finalizes as TASK_INTERRUPTED", async () => {
  const root = repository();
  let release!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { release = done; });
  let interrupts = 0;
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: () => pending,
    interrupt: async () => { interrupts += 1; release({ kind: "interrupted", output: "partial diff" }); }
  }));
  const controlled = new ControlledPatchService(registry, tasks);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });

  while (tasks.status(generated.taskId)?.state === "queued") {
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.equal(tasks.status(generated.taskId)?.state, "running");

  const view = await tasks.controlTask(generated.taskId, "interrupt");
  assert.equal(view.state, "running");
  assert.equal(interrupts, 1);
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "failed",
    error: { code: "TASK_INTERRUPTED", message: "The task was interrupted." },
    partial_output: "partial diff"
  });
  // A failed generation removes its proposal, exactly like any other failure.
  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.equal(proposals.has(generated.taskId), false);
});

test("interrupts a running refine_controlled_patch through control_task and finalizes as TASK_INTERRUPTED", async () => {
  const root = repository();
  const releases: Array<(result: ExecutorResult) => void> = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: () => new Promise<ExecutorResult>((done) => { releases.push(done); }),
    interrupt: async () => { releases[releases.length - 1]?.({ kind: "interrupted", output: "" }); }
  }));
  const controlled = new ControlledPatchService(registry, tasks);
  const source = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  releases[0]?.({ kind: "completed", output: validPatch });
  await terminal(tasks, source.taskId);

  const refined = await controlled.refine({ patch_task_id: source.taskId, change_request: "improve wording" });
  while (tasks.status(refined.taskId)?.state === "queued") {
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.equal(tasks.status(refined.taskId)?.state, "running");
  await tasks.controlTask(refined.taskId, "interrupt");
  await terminal(tasks, refined.taskId);

  assert.deepEqual(tasks.result(refined.taskId), {
    id: refined.taskId,
    state: "failed",
    error: { code: "TASK_INTERRUPTED", message: "The task was interrupted." }
  });
  const proposals = (controlled as unknown as { proposals: Map<string, unknown> }).proposals;
  assert.equal(proposals.has(refined.taskId), false);
  // The completed source proposal survives the interrupted refinement.
  assert.equal(proposals.has(source.taskId), true);
});

test("steer on a running dsh generate task is unsupported; codex generate keeps the existing steer seam", async () => {
  const root = repository();
  const releases: Array<(result: ExecutorResult) => void> = [];
  const steers: string[] = [];
  const executorNames: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, (executor) => {
    executorNames.push(executor);
    const execute = () => new Promise<ExecutorResult>((done) => { releases.push(done); });
    return executor === "dsh"
      ? { execute }
      : { execute, steer: async (instruction) => { steers.push(instruction); } };
  });
  const controlled = new ControlledPatchService(registry, tasks);

  const dsh = await controlled.generate({ workspace_id: "workspace", change_request: "change", executor: "dsh" });
  while (tasks.status(dsh.taskId)?.state === "queued") {
    await new Promise<void>((done) => setImmediate(done));
  }
  await expectCode(() => tasks.controlTask(dsh.taskId, "steer", "keep going"), "UNSUPPORTED_ACTION");
  releases[0]?.({ kind: "completed", output: validPatch });
  await terminal(tasks, dsh.taskId);

  const codex = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  while (tasks.status(codex.taskId)?.state === "queued") {
    await new Promise<void>((done) => setImmediate(done));
  }
  await tasks.controlTask(codex.taskId, "steer", "keep going");
  assert.deepEqual(steers, ["keep going"]);
  releases[1]?.({ kind: "completed", output: validPatch });
  await terminal(tasks, codex.taskId);

  assert.deepEqual(executorNames, ["dsh", "codex"]);
});

test("serializes concurrent APPLY calls for different proposals in one workspace", async () => {
  const root = repository();
  writeFileSync(join(root, "second.txt"), "before\n");
  git(root, "add", "second.txt");
  git(root, "commit", "-qm", "fixture");
  const stateFilePath = retainedStateFile();
  const enteredBase = `${stateFilePath}.entered`;
  const releaseBase = `${stateFilePath}.release`;
  const calls = { apply: 0 };
  const secondPatch = `diff --git a/second.txt b/second.txt
index 9d1c2f3..3b18e51 100644
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-before
+after
`;
  let execution = 0;
  const { controlled, tasks } = fixture(
    root,
    async () => ({ kind: "completed", output: execution++ === 0 ? validPatch : secondPatch }),
    gatedGitStarter(enteredBase, releaseBase, calls),
    stateFilePath
  );
  const first = await controlled.generate({ workspace_id: "workspace", change_request: "first change" });
  await terminal(tasks, first.taskId);
  const second = await controlled.generate({ workspace_id: "workspace", change_request: "second change" });
  await terminal(tasks, second.taskId);

  const firstEntered = `${enteredBase}.1`;
  const firstRelease = `${releaseBase}.1`;
  const secondEntered = `${enteredBase}.2`;
  const secondRelease = `${releaseBase}.2`;
  const releaseGate = (path: string): void => {
    try {
      writeFileSync(path, "release\n", { flag: "wx" });
    } catch {
      // The gate may already have been released.
    }
  };

  try {
    const firstApply = controlled.apply({ patch_task_id: first.taskId, confirmation: "APPLY" });
    assert.equal(await waitForOptionalFile(firstEntered), true);
    const secondApply = controlled.apply({ patch_task_id: second.taskId, confirmation: "APPLY" });
    const secondEnteredBeforeRelease = await waitForOptionalFile(secondEntered);

    releaseGate(firstRelease);
    releaseGate(secondRelease);

    const results = await Promise.allSettled([firstApply, secondApply]);
    assert.equal(secondEnteredBeforeRelease, false);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(
      (results.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason.code,
      "WORKSPACE_PRECONDITION_FAILED"
    );
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
    assert.equal(readFileSync(join(root, "second.txt"), "utf8"), "before\n");
  } finally {
    releaseGate(firstRelease);
    releaseGate(secondRelease);
    rmSync(firstEntered, { force: true });
    rmSync(firstRelease, { force: true });
    rmSync(secondEntered, { force: true });
    rmSync(secondRelease, { force: true });
  }
});

test("keeps the task retained while final applied persistence is pending", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await current.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(current.tasks, generated.taskId);

  let signalFinalPersistStarted!: () => void;
  const finalPersistStarted = new Promise<void>((resolve) => { signalFinalPersistStarted = resolve; });
  let releaseFinalPersist!: () => void;
  const finalPersistRelease = new Promise<void>((resolve) => { releaseFinalPersist = resolve; });
  const persistence = current.controlled as unknown as {
    replaceStateFile(contents: string): Promise<void>;
  };
  const originalReplaceStateFile = persistence.replaceStateFile;
  persistence.replaceStateFile = async (contents) => {
    const pending = JSON.parse(contents) as {
      proposals: Array<{ task_id: string; state: string }>;
    };
    if (pending.proposals.find(({ task_id }) => task_id === generated.taskId)?.state === "applied") {
      signalFinalPersistStarted();
      await finalPersistRelease;
    }
    await originalReplaceStateFile.call(current.controlled, contents);
  };

  let applyPromise: ReturnType<ControlledPatchService["apply"]> | undefined;
  try {
    applyPromise = current.controlled.apply({
      patch_task_id: generated.taskId,
      confirmation: "APPLY"
    });
    await finalPersistStarted;

    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
    const durableWhilePending = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
      proposals: Array<{ task_id: string; state: string }>;
    };
    assert.equal(
      durableWhilePending.proposals.find(({ task_id }) => task_id === generated.taskId)?.state,
      "applying"
    );

    const terminalTaskIds = Array.from({ length: 100 }, () =>
      current.tasks.runTask({
        workspace_id: "workspace",
        instruction: "terminal history pressure"
      }).taskId
    );
    await Promise.all(terminalTaskIds.map((taskId) => terminal(current.tasks, taskId)));

    const { diagnostics, ...taskView } = current.tasks.taskView(generated.taskId) ?? {};
    assert.equal(typeof diagnostics?.finalization_started_at, "string");
    assert.equal(typeof diagnostics?.finalization_ended_at, "string");
    assert.deepEqual(taskView, {
      taskId: generated.taskId,
      state: "completed",
      executor: "codex",
      ready: true,
      output: validPatch
    });
    assert.deepEqual(current.tasks.result(generated.taskId), {
      id: generated.taskId,
      state: "completed",
      output: validPatch
    });

    releaseFinalPersist();
    assert.deepEqual(await applyPromise, {
      patch_task_id: generated.taskId,
      applied: true,
      changed_paths: ["note.txt"]
    });

    const durableAfterApply = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
      proposals: Array<{ task_id: string; state: string }>;
    };
    assert.equal(
      durableAfterApply.proposals.find(({ task_id }) => task_id === generated.taskId)?.state,
      "applied"
    );
  } finally {
    releaseFinalPersist();
    await applyPromise?.catch(() => undefined);
    persistence.replaceStateFile = originalReplaceStateFile;
  }
});

test("reports metadata recovery when final persistence fails after APPLY executes", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const fixedNow = 1_700_000_000_000;
  const collisionPath = `${stateFilePath}.${process.pid}.${fixedNow}.2.tmp`;
  let armed = false;
  const starter: GitStarter = (executable, args, options) => {
    if (
      armed &&
      executable === "git" &&
      args.length === 3 &&
      args[0] === "apply" &&
      args[1] === "--recount" &&
      args[2] === "--unidiff-zero"
    ) {
      writeFileSync(collisionPath, "collision", { flag: "wx" });
    }
    return spawn(executable, args, options);
  };
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    starter,
    stateFilePath
  );
  const generated = await current.controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(current.tasks, generated.taskId);

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  armed = true;
  try {
    const base = await current.controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
    const applied = base as typeof base & { state?: string; metadata_recovered?: boolean };
    assert.equal(applied.state, "applied");
    assert.equal(applied.metadata_recovered, true);
  } finally {
    Date.now = originalNow;
    armed = false;
    rmSync(collisionPath, { force: true });
  }

  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  const retained = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  assert.equal(retained.proposals.find(({ task_id }) => task_id === generated.taskId)?.state, "applied");
});

test("recovers applying as proposed when the forward apply check succeeds", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const head = git(root, "rev-parse", "HEAD").trim();
  const taskId = "00000000-0000-4000-8000-000000000001";
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [retainedRecord(taskId, root, head, { state: "applying" })]
  });
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const retained = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  assert.equal(retained.proposals.find(({ task_id }) => task_id === taskId)?.state, "proposed");
  assert.equal(tasks.taskView(taskId)?.state, "completed");
});

test("recovers applying as applied when the forward check fails and reverse check succeeds", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const head = git(root, "rev-parse", "HEAD").trim();
  const taskId = "00000000-0000-4000-8000-000000000001";
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [retainedRecord(taskId, root, head, { state: "applying" })]
  });
  writeFileSync(join(root, "note.txt"), "after\n");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const retained = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  assert.equal(retained.proposals.find(({ task_id }) => task_id === taskId)?.state, "applied");
  assert.equal(tasks.taskView(taskId)?.state, "completed");
  await expectCode(
    () => controlled.apply({ patch_task_id: taskId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );
});

test("recovers applying as recovery_conflict when both apply directions fail and rejects APPLY", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const head = git(root, "rev-parse", "HEAD").trim();
  const taskId = "00000000-0000-4000-8000-000000000001";
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [retainedRecord(taskId, root, head, { state: "applying" })]
  });
  writeFileSync(join(root, "note.txt"), "diverged\n");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);
  await controlled.load();

  const retained = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  assert.equal(retained.proposals.find(({ task_id }) => task_id === taskId)?.state, "recovery_conflict");
  const conflictView = tasks.taskView(taskId);
  assert.equal(conflictView?.state, "failed");
  assert.equal(conflictView?.error?.code, "APPLY_RECOVERY_CONFLICT");
  await expectCode(
    () => controlled.apply({ patch_task_id: taskId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );
});

test("validation adapters expose a retained commit proposal without mutating state or APPLY eligibility", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const head = git(root, "rev-parse", "HEAD").trim();
  const taskId = retainedTaskId(1);
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [retainedRecord(taskId, root, head)]
  });
  const current = fixture(
    root,
    async () => { throw new Error("retained tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await current.controlled.load();
  const expected = {
    workspaceId: "workspace",
    workspaceRoot: root,
    baseHead: head,
    patch: validPatch
  };
  const retainedBefore = readFileSync(stateFilePath, "utf8");
  const taskBefore = current.tasks.taskView(taskId);

  assert.deepEqual(current.controlled.validationProposal(taskId), expected);
  assert.deepEqual(await current.controlled.preflightValidationProposal(taskId), expected);
  assert.equal(readFileSync(stateFilePath, "utf8"), retainedBefore);
  assert.deepEqual(current.tasks.taskView(taskId), taskBefore);

  const applied = await current.controlled.apply({
    patch_task_id: taskId,
    confirmation: "APPLY"
  });
  assert.equal(applied.applied, true);
});

test("validationProposal exposes a retained unborn proposal with a null base HEAD", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const stateFilePath = retainedStateFile();
  const taskId = retainedTaskId(1);
  writeRetainedState(stateFilePath, {
    version: 1,
    applied_task_ids: [],
    proposals: [
      retainedRecord(taskId, root, "", {
        base_head: null,
        unborn: true,
        output: additionPatch
      })
    ]
  });
  const current = fixture(
    root,
    async () => { throw new Error("retained tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await current.controlled.load();

  assert.deepEqual(current.controlled.validationProposal(taskId), {
    workspaceId: "workspace",
    workspaceRoot: root,
    baseHead: null,
    patch: additionPatch
  });
});

test("validation adapters reject unknown and not-yet-retained proposals with the safe state error", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  const current = fixture(root, () => pending, undefined, retainedStateFile());
  const generated = await current.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await Promise.resolve();

  for (const taskId of [retainedTaskId(999), generated.taskId]) {
    assert.throws(
      () => current.controlled.validationProposal(taskId),
      (error: unknown) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION"
    );
    await expectCode(
      () => current.controlled.preflightValidationProposal(taskId),
      "INVALID_STATE_TRANSITION"
    );
  }

  finish({
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  await terminal(current.tasks, generated.taskId);
});

test("preflightValidationProposal rejects worktree and HEAD drift through controlled-patch preflight", async () => {
  for (const drift of ["worktree", "head"] as const) {
    const root = repository();
    const stateFilePath = retainedStateFile();
    const head = git(root, "rev-parse", "HEAD").trim();
    const taskId = retainedTaskId(1);
    writeRetainedState(stateFilePath, {
      version: 1,
      applied_task_ids: [],
      proposals: [retainedRecord(taskId, root, head)]
    });
    const current = fixture(
      root,
      async () => { throw new Error("retained tasks must not execute"); },
      undefined,
      stateFilePath
    );
    await current.controlled.load();

    if (drift === "worktree") {
      writeFileSync(join(root, "note.txt"), "dirty\n");
    } else {
      writeFileSync(join(root, "other.txt"), "commit\n");
      git(root, "add", "other.txt");
      git(root, "commit", "-qm", "move head");
    }

    assert.equal(current.controlled.validationProposal(taskId).baseHead, head);
    await expectCode(
      () => current.controlled.preflightValidationProposal(taskId),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});
