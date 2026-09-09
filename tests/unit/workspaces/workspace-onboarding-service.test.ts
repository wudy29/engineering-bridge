import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { isId } from "../../../src/core/ids.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";
import type { GitStarter } from "../../../src/workspaces/workspace-onboarding-service.js";

interface GitInvocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
}

function fakeGitStarter(invocations: GitInvocation[], exitCode = 0): GitStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    invocations.push({ executable, args: [...args], options });
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      }
    });
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      child.emit("close", exitCode, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

function expectCodeSync(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

function setup(): {
  approved: string;
  catalogPath: string;
  registry: RegisteredWorkspaceRegistry;
  catalog: ManagedWorkspaceCatalog;
  gitInvocations: GitInvocation[];
} {
  const approved = mkdtempSync(join(tmpdir(), "bridge-approved-"));
  const catalogPath = join(mkdtempSync(join(tmpdir(), "bridge-onboarding-")), "managed-workspaces.json");
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(catalogPath);
  return { approved, catalogPath, registry, catalog, gitInvocations: [] };
}

function service(
  registry: RegisteredWorkspaceRegistry,
  catalog: ManagedWorkspaceCatalog,
  approvedRoots: readonly string[],
  gitInvocations: GitInvocation[],
  gitExitCode = 0
): WorkspaceOnboardingService {
  return new WorkspaceOnboardingService(
    registry,
    catalog,
    approvedRoots,
    undefined,
    fakeGitStarter(gitInvocations, gitExitCode)
  );
}

function catalogStateFilePath(catalog: ManagedWorkspaceCatalog): string {
  return (catalog as unknown as { stateFilePath: string }).stateFilePath;
}

test("F1: bind accepts a child when the approved root is the native filesystem root", async () => {
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), "bridge-filesystem-root-")));
  try {
    const registry = new RegisteredWorkspaceRegistry([]);
    const catalog = new ManagedWorkspaceCatalog();
    const onboarding = new WorkspaceOnboardingService(registry, catalog, [parse(project).root]);

    const result = await onboarding.bind({ project_path: project });

    assert.equal(result.root, project);
    assert.equal(registry.resolve(result.workspace_id), project);
    assert.equal(result.allow_write, false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("F2: approved roots reject invalid lexical paths before canonicalization", () => {
  const approved = join(tmpdir(), "bridge-approved-root");
  const invalidRoots = ["", "relative/root", `${approved}${sep}..${sep}other`];
  if (process.platform === "win32") invalidRoots.push("\\root", "\\workspace\\child", "C:relative");
  for (const root of invalidRoots) {
    let canonicalized = false;
    expectCodeSync(() => new WorkspaceOnboardingService(
      new RegisteredWorkspaceRegistry([]),
      new ManagedWorkspaceCatalog(),
      [root],
      async () => { canonicalized = true; return approved; }
    ), "WORKSPACE_BOUNDARY_VIOLATION");
    assert.equal(canonicalized, false);
  }
});

test("bind registers an existing directory inside an approved root and persists it", async () => {
  const { approved, catalogPath, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const result = await onboarding.bind({ project_path: project });

  assert.equal(isId(result.workspace_id), true);
  assert.equal(result.root, realpathSync.native(project));
  assert.equal(result.allow_write, false);
  assert.equal(result.source, "managed");
  assert.equal(registry.resolve(result.workspace_id), realpathSync.native(project));
  assert.deepEqual(gitInvocations, []);

  // Cross-restart persistence: a fresh catalog + registry resolves the same id.
  const reloadedCatalog = new ManagedWorkspaceCatalog(catalogPath);
  await reloadedCatalog.load();
  assert.deepEqual(reloadedCatalog.entries(), [{ id: result.workspace_id, root: realpathSync.native(project), allowWrite: false }]);
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of reloadedCatalog.entries()) reloadedRegistry.registerManaged(entry.id, entry.root);
  assert.equal(reloadedRegistry.resolve(result.workspace_id), realpathSync.native(project));
});

test("bind reuses an existing manual workspace with its real allow_write and source", async () => {
  const { approved, catalog, gitInvocations } = setup();
  const project = join(approved, "manual-proj");
  mkdirSync(project);
  const manualRegistry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: realpathSync(project), allow_write: true }
  ]);
  const onboarding = service(manualRegistry, catalog, [approved], gitInvocations);

  const result = await onboarding.bind({ project_path: project });

  assert.deepEqual(result, {
    workspace_id: "manual",
    root: realpathSync(project),
    allow_write: true,
    source: "manual"
  });
  assert.deepEqual(catalog.entries(), []);
});

test("repeated and concurrent binds of the same canonical root converge on one managed workspace", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "shared");
  mkdirSync(project);
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const first = await onboarding.bind({ project_path: project });
  const second = await onboarding.bind({ project_path: project });
  assert.equal(first.workspace_id, second.workspace_id);
  assert.equal(second.source, "managed");
  assert.equal(second.allow_write, false);

  const [third, fourth] = await Promise.all([
    onboarding.bind({ project_path: project }),
    onboarding.bind({ project_path: project })
  ]);
  assert.equal(third.workspace_id, first.workspace_id);
  assert.equal(fourth.workspace_id, first.workspace_id);
  assert.equal(catalog.entries().length, 1);
});

test("bind rejects paths outside approved roots, prefix siblings, and symlink escapes", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-outside-"));
  mkdirSync(join(outside, "target"));
  const sibling = `${approved}-sibling`;
  mkdirSync(join(sibling, "inner"), { recursive: true });
  symlinkSync(join(outside, "target"), join(approved, "link"));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.bind({ project_path: join(outside, "target") }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(() => onboarding.bind({ project_path: join(sibling, "inner") }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(() => onboarding.bind({ project_path: join(approved, "link") }), "WORKSPACE_BOUNDARY_VIOLATION");
  assert.deepEqual(catalog.entries(), []);
});

test("a failing approved root does not disable healthy roots; all-failed or non-matching roots fail closed", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const otherApproved = mkdtempSync(join(tmpdir(), "bridge-other-approved-"));
  const project = join(approved, "proj");
  mkdirSync(project);
  const missingRoot = join(approved, "missing-root");

  // A bad root plus a healthy root that contains the candidate succeeds.
  const mixed = service(registry, catalog, [missingRoot, approved], gitInvocations);
  const result = await mixed.bind({ project_path: project });
  assert.equal(result.source, "managed");
  assert.equal(result.root, realpathSync.native(project));

  // A healthy root that does not contain the candidate still fails closed.
  await expectCode(() => mixed.bind({ project_path: otherApproved }), "WORKSPACE_BOUNDARY_VIOLATION");

  // All approved roots failing to canonicalize fail closed.
  const allBad = service(
    registry,
    catalog,
    [join(approved, "nope-1"), join(approved, "nope-2")],
    gitInvocations
  );
  await expectCode(() => allBad.bind({ project_path: project }), "WORKSPACE_BOUNDARY_VIOLATION");

  // Only the successful bind left a record behind.
  assert.deepEqual(catalog.entries(), [{ id: result.workspace_id, root: realpathSync.native(project), allowWrite: false }]);
});

test("bind rejects nonexistent paths, non-directories, and missing approved roots", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const file = join(approved, "file.txt");
  writeFileSync(file, "x");
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.bind({ project_path: join(approved, "missing") }), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => onboarding.bind({ project_path: file }), "WORKSPACE_PRECONDITION_FAILED");

  const noRoots = service(registry, catalog, [], gitInvocations);
  await expectCode(() => noRoots.bind({ project_path: approved }), "WORKSPACE_BOUNDARY_VIOLATION");
  assert.deepEqual(catalog.entries(), []);
});

test("create makes the directory, runs git init only, registers, and reports unborn HEAD", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  const result = await onboarding.create({ parent: approved, name: "newproj" });

  assert.equal(isId(result.workspace_id), true);
  const expectedRoot = join(realpathSync.native(approved), "newproj");
  assert.equal(result.root, expectedRoot);
  assert.equal(result.allow_write, false);
  assert.deepEqual(result.git, { initialized: true, head: "unborn" });
  assert.equal(statSync(expectedRoot).isDirectory(), true);
  assert.equal(registry.resolve(result.workspace_id), expectedRoot);

  assert.equal(gitInvocations.length, 1);
  assert.equal(gitInvocations[0]?.executable, "git");
  assert.deepEqual(gitInvocations[0]?.args, ["init"]);
  assert.equal(gitInvocations[0]?.options.cwd, expectedRoot);

  assert.deepEqual(catalog.entries(), [{ id: result.workspace_id, root: expectedRoot, allowWrite: false }]);
});

test("create rejects invalid names, outside parents, missing parents, and existing targets", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const outside = mkdtempSync(join(tmpdir(), "bridge-outside-create-"));
  mkdirSync(join(approved, "exists"));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  for (const name of ["", "a/b", "a\\b", ".", ".."]) {
    await expectCode(() => onboarding.create({ parent: approved, name }), "WORKSPACE_PRECONDITION_FAILED");
  }
  await expectCode(() => onboarding.create({ parent: outside, name: "ok" }), "WORKSPACE_BOUNDARY_VIOLATION");
  await expectCode(
    () => onboarding.create({ parent: join(approved, "missing-parent"), name: "ok" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
  await expectCode(() => onboarding.create({ parent: approved, name: "exists" }), "WORKSPACE_PRECONDITION_FAILED");

  assert.deepEqual(catalog.entries(), []);
  assert.deepEqual(gitInvocations, []);
});

test("create with a failing git init removes the new empty directory and registers nothing", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const onboarding = service(registry, catalog, [approved], gitInvocations, 1);

  await expectCode(() => onboarding.create({ parent: approved, name: "failproj" }), "WORKSPACE_PRECONDITION_FAILED");

  assert.equal(gitInvocations.length, 1);
  assert.throws(() => statSync(join(approved, "failproj")), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(registry.findByRoot(join(realpathSync(approved), "failproj")), undefined);
  assert.deepEqual(catalog.entries(), []);
});

test("create with a catalog persist failure keeps the target, registers nothing, and bind can recover", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  await catalog.load();
  // Block the catalog path with a directory so the atomic rename fails.
  mkdirSync(catalogStateFilePath(catalog));
  const onboarding = service(registry, catalog, [approved], gitInvocations);

  await expectCode(
    () => onboarding.create({ parent: approved, name: "kept-proj" }),
    "INTERNAL_ERROR"
  );

  const target = join(realpathSync.native(approved), "kept-proj");
  assert.equal(statSync(target).isDirectory(), true);
  assert.equal(registry.findByRoot(target), undefined);
  assert.deepEqual(catalog.entries(), []);

  // Recover: the retained directory can be bound after the catalog is usable again.
  rmSync(catalogStateFilePath(catalog), { recursive: true, force: true });
  const recovered = await onboarding.bind({ project_path: target });
  assert.equal(isId(recovered.workspace_id), true);
  assert.equal(recovered.source, "managed");
  assert.equal(recovered.allow_write, false);
  assert.equal(registry.resolve(recovered.workspace_id), target);
});

test("authorizeWrite persists controlled-write and enables resolveWritable after restart", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "auth-proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });
  expectCodeSync(() => registry.resolveWritable(workspace_id), "WORKSPACE_PRECONDITION_FAILED");

  const authorized = await onboarding.authorizeWrite(workspace_id);
  assert.deepEqual(authorized, { workspace_id, allow_write: true });
  assert.equal(registry.resolveWritable(workspace_id), realpathSync.native(project));

  // Restart recovery: a fresh catalog + registry restores the authorization.
  const reloadedCatalog = new ManagedWorkspaceCatalog(catalogStateFilePath(catalog));
  await reloadedCatalog.load();
  assert.equal(reloadedCatalog.entries()[0]?.allowWrite, true);
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of reloadedCatalog.entries()) {
    reloadedRegistry.registerManaged(entry.id, entry.root, entry.allowWrite);
  }
  assert.equal(reloadedRegistry.resolveWritable(workspace_id), realpathSync.native(project));
});

test("authorizeWrite is idempotent and persists once", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "idem-proj");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });

  await onboarding.authorizeWrite(workspace_id);
  await onboarding.authorizeWrite(workspace_id);
  assert.deepEqual(catalog.entries(), [{ id: workspace_id, root: realpathSync.native(project), allowWrite: true }]);
});

test("authorizeWrite rejects manual workspaces without touching the catalog", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "manual-auth");
  mkdirSync(project);
  const manualRegistry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: realpathSync(project), allow_write: true }
  ]);
  const onboarding = service(manualRegistry, catalog, [approved], gitInvocations);

  await expectCode(() => onboarding.authorizeWrite("manual"), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => onboarding.authorizeWrite("missing"), "UNKNOWN_WORKSPACE");
  assert.deepEqual(catalog.entries(), []);
});

test("authorizeWrite with a persist failure leaves runtime and catalog unauthorized", async () => {
  const { approved, registry, catalog, gitInvocations } = setup();
  const project = join(approved, "fail-auth");
  mkdirSync(project);
  await catalog.load();
  const onboarding = service(registry, catalog, [approved], gitInvocations);
  const { workspace_id } = await onboarding.bind({ project_path: project });

  // Block the catalog path so the authorize persist fails.
  rmSync(catalogStateFilePath(catalog));
  mkdirSync(catalogStateFilePath(catalog));
  await expectCode(() => onboarding.authorizeWrite(workspace_id), "INTERNAL_ERROR");

  // No half state: runtime is not authorized and the catalog record stays read-only.
  expectCodeSync(() => registry.resolveWritable(workspace_id), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(catalog.entries()[0]?.allowWrite, false);
});
