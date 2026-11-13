import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoreError } from "../../../src/core/errors.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";

function fixture(t: test.TestContext) {
  const approved = realpathSync.native(mkdtempSync(join(tmpdir(), "bridge-subproject-")));
  t.after(() => rmSync(approved, { recursive: true, force: true }));
  const repo = join(approved, process.platform === "win32" ? "硅基秘书 space" : "硅基秘书 space ");
  const sub = join(repo, "material-secretary");
  mkdirSync(sub, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(join(approved, "catalog.json"));
  const service = new WorkspaceOnboardingService(registry, catalog, [approved]);
  return { approved, repo, sub, registry, catalog, service };
}
const boundary = (e: unknown) => e instanceof CoreError && e.code === "WORKSPACE_BOUNDARY_VIOLATION";

test("subproject bind discovers Git top-level, retains requested path and reuses root ID concurrently and after restart", async t => {
  const f = fixture(t);
  const alias = join(f.approved, "alias");
  symlinkSync(f.sub, alias, process.platform === "win32" ? "junction" : "dir");
  const results = await Promise.all([f.repo, f.sub, alias].map(project_path => f.service.bind({ project_path })));
  for (const r of results) assert.equal(r.workspace_id, results[0]!.workspace_id);
  assert.equal(results[1]!.root, f.repo);
  assert.equal((results[2] as unknown as Record<string, unknown>).requested_path, alias);
  assert.equal((results[2] as unknown as Record<string, unknown>).working_subpath, "material-secretary");
  assert.equal((results[0] as unknown as Record<string, unknown>).working_subpath, ".");
  assert.equal(f.catalog.entries().length, 1);
  const loaded = new ManagedWorkspaceCatalog(join(f.approved, "catalog.json"));
  await loaded.load();
  const registry = new RegisteredWorkspaceRegistry([]);
  for (const e of loaded.entries()) registry.registerManaged(e.id, e.root, e.allowWrite);
  const rebound = await new WorkspaceOnboardingService(registry, loaded, [f.approved]).bind({ project_path: f.sub });
  assert.equal(rebound.workspace_id, results[0]!.workspace_id);
  assert.throws(() => registry.resolveWritable(rebound.workspace_id));
});

test("Git root above approved child fails closed, including already registered root", async t => {
  const f = fixture(t);
  f.registry.registerManaged("old-root", f.repo, true);
  const service = new WorkspaceOnboardingService(f.registry, f.catalog, [f.sub]);
  await assert.rejects(service.bind({ project_path: f.sub }), boundary);
  assert.deepEqual(f.catalog.entries(), []);
});

test("requested path escape and symlink escape cannot bind or create a catalog entry", async t => {
  const f = fixture(t);
  const outside = join(f.approved, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.repo, "escape"), process.platform === "win32" ? "junction" : "dir");
  const service = new WorkspaceOnboardingService(f.registry, f.catalog, [f.repo]);
  for (const project_path of [join(f.repo, "..", "outside"), join(f.repo, "escape")]) {
    await assert.rejects(service.bind({ project_path }), boundary);
  }
  assert.deepEqual(f.catalog.entries(), []);
});

test("root manual ID and permission are reused; legacy child ID retains its original boundary", async t => {
  const f = fixture(t);
  const registry = new RegisteredWorkspaceRegistry([
    { id: "old-child", root: f.sub, allow_write: true },
    { id: "root", root: f.repo, allow_write: false }
  ]);
  const r = await new WorkspaceOnboardingService(registry, f.catalog, [f.approved]).bind({ project_path: f.sub });
  assert.equal(r.workspace_id, "root");
  assert.equal(r.allow_write, false);
  assert.equal(registry.resolveWritable("old-child"), f.sub);
  assert.deepEqual(f.catalog.entries(), []);
});

test("non-Git directory still binds and returns root working_subpath", async t => {
  const f = fixture(t);
  const plain = join(f.approved, "plain"); mkdirSync(plain);
  const r = await f.service.bind({ project_path: plain });
  assert.equal(r.root, plain);
  assert.equal((r as unknown as Record<string, unknown>).working_subpath, ".");
});

test("broken Git metadata is not silently registered as a non-Git workspace", async t => {
  const f = fixture(t);
  const broken = join(f.approved, "broken"); mkdirSync(broken);
  writeFileSync(join(broken, ".git"), "gitdir: missing\n");
  await assert.rejects(f.service.bind({ project_path: broken }), (e: unknown) =>
    e instanceof CoreError && e.code === "WORKSPACE_PRECONDITION_FAILED");
  assert.deepEqual(f.catalog.entries(), []);
});

async function ready(service: RegisteredWorkspaceTaskService, id: string) {
  for (let i = 0; i < 100; i++) {
    const view = service.taskView(id)!;
    if (view.ready) return view;
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
  throw new Error("task not ready");
}

test("Codex and DSH receive subdirectory cwd with read-only sandbox; continue preserves it", async t => {
  const f = fixture(t);
  const registry = new RegisteredWorkspaceRegistry([{ id: "root", root: f.repo, allow_write: true }]);
  for (const executor of ["codex", "dsh"] as const) {
    const calls: string[] = [];
    const service = new RegisteredWorkspaceTaskService(registry, (name, cwd) => ({
      async execute(request) {
        assert.equal(name, executor); assert.equal(request.sandbox, "read-only");
        calls.push(cwd); return { kind: "completed", output: cwd };
      }
    }));
    const request = { workspace_id: "root", instruction: "inspect", executor, working_subpath: "material-secretary" };
    const { taskId } = service.startTask(request);
    assert.equal((await ready(service, taskId)).review_output, f.sub);
    await service.controlTask(taskId, "continue", "again");
    await ready(service, taskId);
    assert.deepEqual(calls, [f.sub, f.sub]);
    assert.equal(registry.resolveWritable("root"), f.repo);
  }
});

test("working_subpath rejects lexical escapes, absolute paths, missing files and symlink escapes before executor creation", async t => {
  const f = fixture(t);
  mkdirSync(join(f.approved, "outside"));
  symlinkSync(join(f.approved, "outside"), join(f.repo, "escape"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(f.repo, "file"), "x");
  const registry = new RegisteredWorkspaceRegistry([{ id: "root", root: f.repo }]);
  for (const working_subpath of ["", "..", "../outside", "material-secretary/../../outside", "/tmp", "C:\\escape", "C:escape", "\\\\host\\share", "a\\..\\escape", "escape", "file", "missing", "\0"]) {
    let invoked = false;
    const service = new RegisteredWorkspaceTaskService(registry, () => {
      invoked = true; return { async execute() { return { kind: "completed", output: "bad" }; } };
    });
    const request = { workspace_id: "root", instruction: "inspect", working_subpath };
    const { taskId } = service.startTask(request);
    const view = await ready(service, taskId);
    assert.equal(view.state, "failed", JSON.stringify(working_subpath));
    assert.equal(invoked, false);
  }
});

test("omitted subpath, dot and internal symlinks preserve existing task behavior", async t => {
  const f = fixture(t);
  symlinkSync(f.sub, join(f.repo, "alias"), process.platform === "win32" ? "junction" : "dir");
  const registry = new RegisteredWorkspaceRegistry([{ id: "legacy", root: f.repo }]);
  const service = new RegisteredWorkspaceTaskService(registry, (_, cwd) => ({ async execute() { return { kind: "completed", output: cwd }; } }));
  for (const [working_subpath, expected] of [[undefined, f.repo], [".", f.repo], ["alias", f.sub]] as const) {
    const request = { workspace_id: "legacy", instruction: "inspect", ...(working_subpath === undefined ? {} : { working_subpath }) };
    const { taskId } = service.startTask(request);
    assert.equal((await ready(service, taskId)).review_output, expected);
  }
});

test("legacy child-only registration is retained without transferring write permission to the new Git root", async t => {
  const f = fixture(t);
  const registry = new RegisteredWorkspaceRegistry([{ id: "child", root: f.sub, allow_write: true }]);
  const r = await new WorkspaceOnboardingService(registry, f.catalog, [f.approved]).bind({ project_path: f.sub });
  assert.notEqual(r.workspace_id, "child");
  assert.equal(r.root, f.repo); assert.equal(r.allow_write, false);
  assert.equal(registry.resolveWritable("child"), f.sub);
  assert.throws(() => registry.resolveWritable(r.workspace_id));
});

test("continuation rechecks a subdirectory symlink before creating another executor", async t => {
  const f = fixture(t);
  const alias = join(f.repo, "alias");
  const outside = join(f.approved, "outside"); mkdirSync(outside);
  symlinkSync(f.sub, alias, process.platform === "win32" ? "junction" : "dir");
  const registry = new RegisteredWorkspaceRegistry([{ id: "root", root: f.repo }]);
  let calls = 0;
  const service = new RegisteredWorkspaceTaskService(registry, (_, cwd) => ({ async execute() {
    calls++; return { kind: "completed", output: cwd };
  } }));
  const { taskId } = service.startTask({ workspace_id: "root", instruction: "inspect", working_subpath: "alias" });
  await ready(service, taskId);
  rmSync(alias); symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await service.controlTask(taskId, "continue", "again");
  const view = await ready(service, taskId);
  assert.equal(view.error?.code, "WORKSPACE_BOUNDARY_VIOLATION");
  assert.equal(calls, 1);
});


test("POSIX Git root preserves a literal trailing carriage return", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const repo = join(f.approved, "repo\r"); const sub = join(repo, "app");
  mkdirSync(sub, { recursive: true }); execFileSync("git", ["init", "--quiet", repo]);
  const r = await f.service.bind({ project_path: sub });
  assert.equal(r.root, repo); assert.equal(r.working_subpath, "app");
});
