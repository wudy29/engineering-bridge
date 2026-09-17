import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createValidationRun, transitionValidationRun, type ValidationRun } from "../../../src/tasks/validation-run.js";

const AT = "2030-01-01T00:00:00.000Z";
const ID = "00000000-0000-4000-8000-000000000001";
const MARKER = ".engineering-bridge-validation-run";
type Owned = NonNullable<ValidationRun["owned_worktree"]>;
type Git = (cwd: string, args: readonly string[], input?: string) => Promise<string>;
type Manager = {
  plan(run: ValidationRun): Owned;
  createParent(run: ValidationRun): Promise<Owned>;
  register(run: ValidationRun, git: Git): Promise<Owned>;
  cleanup(run: ValidationRun, git: Git, signal: AbortSignal, quiescent: boolean): Promise<void>;
};
async function constructor() {
  const modulePath = "../../../src/tasks/validation-run-worktree" + ".js";
  const module = await import(modulePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  });
  assert.equal(typeof module.ValidationRunWorktree, "function", "worktree ownership manager must be exported");
  return module.ValidationRunWorktree as new (root: string) => Manager;
}
const git: Git = (cwd, args, input) => new Promise((resolve, reject) => {
  const child = execFile("git", [...args], { cwd, timeout: 10_000, maxBuffer: 1_048_576 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin?.end(input);
});
async function overwriteExistingFile(path: string, content: string): Promise<void> {
  const file = await fs.open(path, "r+");
  try {
    await file.truncate(0);
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
function receipt(run: ValidationRun, owned: Owned): ValidationRun {
  return transitionValidationRun(run, { type: "worktree_receipt", at: AT, owned_worktree: owned });
}
async function fixture(t: TestContext, registered = false) {
  const Worktree = await constructor();
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-worktree-test-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "project");
  await fs.mkdir(workspace);
  await git(workspace, ["init", "--quiet"]);
  await git(workspace, ["config", "--local", "core.autocrlf", "false"]);
  await git(workspace, ["config", "user.name", "Fixture"]);
  await git(workspace, ["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(join(workspace, "file.txt"), "before\n");
  await git(workspace, ["add", "file.txt"]);
  await git(workspace, ["commit", "--quiet", "-m", "fixture"]);
  const baseHead = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  let run = createValidationRun({
    idempotency_key: "worktree", patch_task_id: "patch", workspace_id: "workspace", workspace_root: workspace,
    base_head: baseHead, patch: "patch", profile: { preparation: [], validation: [], defaultStepTimeoutSeconds: 10, totalTimeoutSeconds: 20 },
  }, { validation_run_id: ID, admission_sequence: 1, admitted_at: AT });
  run = transitionValidationRun(run, { type: "start", at: AT, owner_instance_id: "owner" });
  const root = join(directory, "private");
  const manager = new Worktree(root);
  run = transitionValidationRun(run, { type: "worktree_owned", at: AT, owned_worktree: manager.plan(run) });
  const plannedRun = run;
  run = receipt(run, await manager.createParent(run));
  if (registered) run = receipt(run, await manager.register(run, git));
  return { manager, run, plannedRun, directory, workspace, root, Worktree };
}

test("durable plan precedes exclusive private parent creation, and creation cannot reclaim a crash residual", async (t) => {
  const { manager, run, plannedRun, root } = await fixture(t);
  assert.equal(plannedRun.owned_worktree!.parent_identity, null);
  assert.deepEqual(manager.plan(plannedRun), plannedRun.owned_worktree);
  assert.ok(run.owned_worktree!.parent_identity);
  assert.equal(await fs.readFile(join(run.owned_worktree!.parent_path, MARKER), "utf8"), ID + "\n");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(run.owned_worktree!.parent_path)).mode & 0o777, 0o700);
  }
  await assert.rejects(manager.createParent(plannedRun));
  assert.ok(await fs.stat(run.owned_worktree!.parent_path));
});

test("real detached worktree receives candidate only there and exact verified cleanup removes registration and parent", async (t) => {
  const { manager, run, workspace } = await fixture(t, true);
  const owned = run.owned_worktree!;
  assert.ok(owned.common_git_dir);
  assert.equal((await git(owned.worktree_path, ["rev-parse", "HEAD"])).trim(), run.base_head);
  await git(owned.worktree_path, ["apply", "-"], "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+candidate\n");
  assert.equal(await fs.readFile(join(owned.worktree_path, "file.txt"), "utf8"), "candidate\n");
  assert.equal(await fs.readFile(join(workspace, "file.txt"), "utf8"), "before\n");
  const operations: readonly string[][] = [];
  const recording: Git = async (cwd, args, input) => {
    (operations as string[][]).push([...args]);
    return git(cwd, args, input);
  };
  await manager.cleanup(run, recording, new AbortController().signal, true);
  await assert.rejects(fs.lstat(owned.parent_path), { code: "ENOENT" });
  assert.ok(!(await git(workspace, ["worktree", "list", "--porcelain", "-z"])).includes(owned.worktree_path));
  assert.deepEqual(operations.filter((args) => args[0] === "worktree" && args[1] === "remove"), [["worktree", "remove", "--force", "--", owned.worktree_path]]);
});

test("normal cleanup refuses unconfirmed live process state before calling Git", async t => {
  const { manager, run } = await fixture(t, true);
  let calls = 0;
  const checking: Git = (cwd, args, input) => { calls++; return git(cwd, args, input); };
  await assert.rejects(manager.cleanup(run, checking, new AbortController().signal, false), { code: "VALIDATION_WORKTREE_UNVERIFIED" });
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(join(run.owned_worktree!.parent_path, MARKER), "utf8"), ID + "\n");
});

test("cleanup syncs the containing directory after removing the owned parent", async t => {
  if (process.platform === "win32") return t.skip("POSIX directory durability");
  const f = await fixture(t, true);
  const open = fs.open.bind(fs); let syncedAfterRemoval = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.root) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        try { await fs.lstat(f.run.owned_worktree!.parent_path); } catch (e) { syncedAfterRemoval = (e as NodeJS.ErrnoException).code === "ENOENT"; }
        return sync();
      };
    }
    return handle;
  });
  await f.manager.cleanup(f.run, git, new AbortController().signal, true);
  assert.equal(syncedAfterRemoval, true, "successful durable cleanup cannot precede parent directory sync");
});
test("receipt verification uses a bounded read even if the marker grows after stat", async t => {
  const f = await fixture(t, true);
  const path = join(f.run.owned_worktree!.parent_path, MARKER);
  const stat = fs.lstat.bind(fs), read = fs.readFile.bind(fs);
  let readsWithoutBound = 0;
  let markerStats = 0;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === path) readsWithoutBound++;
    return read(...args);
  });
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const before = await stat(...args);
    if (String(args[0]) === path && ++markerStats === 2) await fs.writeFile(path, "x".repeat(1_000_000));
    return before;
  });
  await assert.rejects(f.manager.cleanup(f.run, git, new AbortController().signal, true));
  assert.equal(readsWithoutBound, 0);
  assert.equal((await fs.stat(f.run.owned_worktree!.parent_path)).isDirectory(), true);
});

for (const scenario of ["marker", "marker_inode", "parent_inode", "parent_symlink", "worktree_symlink", "git_pointer", "admin_backref", "common_git", "workspace_inode", "missing_worktree", "extra_parent", "receipt_gap", "aborted"] as const) {
  test(`cleanup preserves scene on ${scenario} and never issues worktree remove`, async (t) => {
    const f = await fixture(t, true);
    let run = f.run;
    const owned = run.owned_worktree!;
    const pointer = join(owned.worktree_path, ".git");
    const admin = (await fs.readFile(pointer, "utf8")).trim().slice("gitdir: ".length);
    const signal = new AbortController();
    if (scenario === "marker") await fs.writeFile(join(owned.parent_path, MARKER), "wrong\n");
    if (scenario === "marker_inode") {
      await fs.rename(join(owned.parent_path, MARKER), join(f.directory, "old-marker"));
      await fs.writeFile(join(owned.parent_path, MARKER), ID + "\n", { mode: 0o600 });
    }
    if (scenario === "parent_inode" || scenario === "parent_symlink") {
      const moved = join(f.directory, "old-parent");
      await fs.rename(owned.parent_path, moved);
      if (scenario === "parent_symlink") await fs.symlink(moved, owned.parent_path, "dir");
      else { await fs.mkdir(owned.parent_path, { mode: 0o700 }); await fs.writeFile(join(owned.parent_path, MARKER), ID + "\n"); }
    }
    if (scenario === "worktree_symlink") {
      const moved = join(f.directory, "old-worktree");
      await fs.rename(owned.worktree_path, moved);
      await fs.symlink(moved, owned.worktree_path, "dir");
    }
    if (scenario === "git_pointer") await overwriteExistingFile(pointer, "gitdir: " + join(f.directory, "wrong") + "\n");
    if (scenario === "admin_backref") await fs.writeFile(join(admin, "gitdir"), join(f.workspace, ".git") + "\n");
    if (scenario === "common_git") await fs.writeFile(join(admin, "commondir"), f.directory + "\n");
    if (scenario === "workspace_inode") {
      await fs.rename(f.workspace, join(f.directory, "old-project"));
      await fs.mkdir(f.workspace);
    }
    if (scenario === "missing_worktree") await fs.rename(owned.worktree_path, join(f.directory, "moved-worktree"));
    if (scenario === "extra_parent") await fs.writeFile(join(owned.parent_path, "unowned"), "keep");
    if (scenario === "receipt_gap") run = { ...run, owned_worktree: { ...owned, parent_identity: null } };
    if (scenario === "aborted") signal.abort();
    let removes = 0;
    const checking: Git = (cwd, args, input) => {
      if (args[0] === "worktree" && args[1] === "remove") removes += 1;
      return git(cwd, args, input);
    };
    await assert.rejects(f.manager.cleanup(run, checking, signal.signal, true));
    assert.equal(removes, 0);
    assert.ok(await fs.lstat(owned.parent_path));
  });
}

test("cleanup abort observed after pending Git verification prevents remove", async (t) => {
  const { manager, run } = await fixture(t, true);
  const controller = new AbortController();
  const calls: string[][] = [];
  const checking: Git = async (cwd, args, input) => {
    calls.push([...args]);
    const result = await git(cwd, args, input);
    controller.abort();
    return result;
  };
  await assert.rejects(manager.cleanup(run, checking, controller.signal, true));
  assert.ok(!calls.some((args) => args[1] === "remove"));
  assert.ok(await fs.stat(run.owned_worktree!.worktree_path));
});

test("cleanup abort after Git remove preserves owned parent for service disposition", async (t) => {
  const { manager, run } = await fixture(t, true);
  const controller = new AbortController();
  const checking: Git = async (cwd, args, input) => {
    const result = await git(cwd, args, input);
    if (args[1] === "remove") controller.abort();
    return result;
  };
  await assert.rejects(manager.cleanup(run, checking, controller.signal, true));
  assert.equal(await fs.readFile(join(run.owned_worktree!.parent_path, MARKER), "utf8"), ID + "\n");
});

test("root rejects traversal, noncanonical alias, symlink and project-contained location", async (t) => {
  const f = await fixture(t);
  assert.throws(() => new f.Worktree(join(f.directory, "other") + "/../private"));
  const alias = join(f.directory, "alias");
  await fs.symlink(f.root, alias, "dir");
  for (const location of [alias, join(f.workspace, "unsafe")]) {
    const manager = new f.Worktree(location);
    const run = { ...f.plannedRun, owned_worktree: manager.plan(f.plannedRun) };
    await assert.rejects(manager.createParent(run));
  }
});

test("mkdir-before-marker crash is never claimed or passed to Git", async (t) => {
  const f = await fixture(t);
  const owned = f.run.owned_worktree!;
  await fs.unlink(join(owned.parent_path, MARKER));
  await assert.rejects(f.manager.createParent(f.plannedRun));
  let calls = 0;
  await assert.rejects(f.manager.register(f.plannedRun, async () => { calls += 1; return ""; }));
  assert.equal(calls, 0);
  assert.ok(await fs.stat(owned.parent_path));
});

for (const scenario of ["temp_root_inode", "worktree_inode", "pointer_inode", "admin_inode", "backref_inode", "admin_missing", "wrong_common_receipt"] as const) {
  test(`cleanup rejects ${scenario} with all original target contents preserved`, async (t) => {
    const f = await fixture(t, true);
    let run = f.run;
    const owned = run.owned_worktree!;
    const admin = (await fs.readFile(join(owned.worktree_path, ".git"), "utf8")).trim().slice(8);
    const path = scenario === "temp_root_inode" ? f.root : scenario === "worktree_inode" ? owned.worktree_path :
      scenario === "pointer_inode" ? join(owned.worktree_path, ".git") : scenario === "backref_inode" ? join(admin, "gitdir") : admin;
    if (scenario === "wrong_common_receipt") run = { ...run, owned_worktree: { ...owned, common_git_dir: f.directory } };
    else {
      const previous = join(f.directory, "original");
      await fs.rename(path, previous);
      if (scenario !== "admin_missing") await fs.cp(previous, path, { recursive: true, preserveTimestamps: true });
    }
    let removes = 0;
    const checking: Git = (cwd, args, input) => {
      if (args[1] === "remove") removes += 1;
      return git(cwd, args, input);
    };
    await assert.rejects(f.manager.cleanup(run, checking, new AbortController().signal, true));
    assert.equal(removes, 0);
    assert.ok(await fs.stat(owned.parent_path));
  });
}

test("missing Git registration cannot authorize removing an otherwise matching worktree", async (t) => {
  const { manager, run } = await fixture(t, true);
  let removes = 0;
  const checking: Git = (cwd, args, input) => {
    if (args[1] === "list") return Promise.resolve("");
    if (args[1] === "remove") removes += 1;
    return git(cwd, args, input);
  };
  await assert.rejects(manager.cleanup(run, checking, new AbortController().signal, true));
  assert.equal(removes, 0);
  assert.ok(await fs.stat(run.owned_worktree!.worktree_path));
});

test("registration reappearing after remove prevents parent deletion", async (t) => {
  const { manager, run } = await fixture(t, true);
  const owned = run.owned_worktree!;
  let removed = false;
  const checking: Git = async (cwd, args, input) => {
    if (args[1] === "list" && removed) return `worktree ${owned.worktree_path}\0HEAD ${run.base_head}\0detached\0\0`;
    const result = await git(cwd, args, input);
    if (args[1] === "remove") removed = true;
    return result;
  };
  await assert.rejects(manager.cleanup(run, checking, new AbortController().signal, true));
  assert.equal(await fs.readFile(join(owned.parent_path, MARKER), "utf8"), ID + "\n");
});

test("admin path reappearing while Git confirms removal prevents deleting parent", async (t) => {
  const { manager, run } = await fixture(t, true);
  const owned = run.owned_worktree!;
  const admin = (await fs.readFile(join(owned.worktree_path, ".git"), "utf8")).trim().slice(8);
  let removed = false;
  const checking: Git = async (cwd, args, input) => {
    const result = await git(cwd, args, input);
    if (args[1] === "remove") removed = true;
    else if (args[1] === "list" && removed) await fs.mkdir(admin, { recursive: true });
    return result;
  };
  await assert.rejects(manager.cleanup(run, checking, new AbortController().signal, true));
  assert.equal(await fs.readFile(join(owned.parent_path, MARKER), "utf8"), ID + "\n");
});

test("pending marker unlink stays awaited and abort prevents the later parent rmdir", async (t) => {
  const { manager, run } = await fixture(t, true);
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const observed = new Promise<void>((resolve) => { entered = resolve; });
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (path: Parameters<typeof fs.unlink>[0]) => {
    entered();
    await blocked;
    return unlink(path);
  });
  let settled = false;
  const pending = manager.cleanup(run, git, controller.signal, true).finally(() => { settled = true; });
  await observed;
  assert.equal(settled, false);
  controller.abort();
  release();
  await assert.rejects(pending);
  assert.deepEqual(await fs.readdir(run.owned_worktree!.parent_path), []);
});

test("Git absolute path separators normalize to canonical receipts without relaxing the planned root", async (t) => {
  const { manager, run } = await fixture(t);
  const repeated = (value: string) => value.replace(/[\\/]/g, (separator) => separator + separator);
  const checking: Git = async (cwd, args, input) => {
    const result = await git(cwd, args, input);
    if (args[0] === "rev-parse" && args[1] !== "HEAD") return repeated(result);
    if (args[1] === "list") return result.split("\0").map((line) => line.startsWith("worktree ") ? "worktree " + repeated(line.slice(9)) : line).join("\0");
    return result;
  };
  const registered = receipt(run, await manager.register(run, checking));
  assert.equal(registered.owned_worktree!.common_git_dir, join(run.workspace_root, ".git"));
  await manager.cleanup(registered, checking, new AbortController().signal, true);
  await assert.rejects(fs.lstat(run.owned_worktree!.parent_path), { code: "ENOENT" });
});

test("worktree receipt can fill the planned identity exactly once without rebinding paths", async t => {
  const f = await fixture(t);
  let run = f.plannedRun;
  const owned = {
    expected_temp_root: f.root, parent_path: f.plannedRun.owned_worktree!.parent_path,
    worktree_path: f.plannedRun.owned_worktree!.worktree_path,
    parent_identity: null, common_git_dir: null, run_marker: ID
  };
  run = transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...owned, parent_identity: { dev: "1", ino: "2" } } });
  assert.deepEqual(run.owned_worktree?.parent_identity, { dev: "1", ino: "2" });
  assert.throws(() => transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...owned, parent_identity: { dev: "1", ino: "3" } } }), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
});

test("new filesystem receipts fill missing or null ownership once and remain immutable", async t => {
  const f = await fixture(t);
  let run = f.plannedRun;
  const owned = {
    expected_temp_root: f.root, parent_path: f.plannedRun.owned_worktree!.parent_path,
    worktree_path: f.plannedRun.owned_worktree!.worktree_path,
    parent_identity: null, common_git_dir: null, run_marker: ID,
  };
  const fields = ["temp_root_identity", "marker_identity", "workspace_identity", "common_git_dir_identity", "worktree_identity", "git_pointer_identity", "admin_identity", "admin_gitdir_identity"];
  for (const field of fields) {
    run = transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, [field]: null } });
    run = transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, [field]: { dev: "1", ino: "2" } } });
    assert.throws(() => transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, [field]: { dev: "1", ino: "3" } } }), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
    assert.throws(() => transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, [field]: null } }), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
    const dropped = { ...run.owned_worktree } as Record<string, unknown>;
    delete dropped[field];
    assert.throws(() => transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: dropped as Owned }), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
  }
  run = transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, admin_path: "/repo/.git/worktrees/worktree" } });
  assert.throws(() => transitionValidationRun(run, { at: AT, type: "worktree_receipt", owned_worktree: { ...run.owned_worktree!, admin_path: "/other/.git/worktrees/worktree" } }), { code: "VALIDATION_RUN_INVALID_TRANSITION" });
  assert.equal(run.schema_version, 1);
});
