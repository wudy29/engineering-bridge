import assert from "node:assert/strict";
import { sep } from "node:path";
import test from "node:test";

import { workspaceFixture } from "../../helpers/workspace-fixture.js";

import { CoreError } from "../../../src/core/errors.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = workspaceFixture("registered", "root");

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("returns the fixed root for a registered id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  assert.equal(registry.resolve("known"), ROOT);
});

test("write access defaults to denied and must be explicitly enabled", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "default", root: ROOT },
    { id: "enabled", root: workspaceFixture("write", "root"), allow_write: true }
  ]);

  expectCode(() => registry.resolveWritable("default"), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(registry.resolveWritable("enabled"), workspaceFixture("write", "root"));
  assert.equal(registry.resolve("default"), ROOT);
});

test("rejects an unknown id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  expectCode(() => registry.resolve("unknown"), "UNKNOWN_WORKSPACE");
});

test("rejects duplicate ids", () => {
  expectCode(() => new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT },
    { id: "known", root: workspaceFixture("other", "root") }
  ]), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("rejects relative, non-normalized, or empty configuration fields", () => {
  const invalidEntries = [
    [{ id: "known", root: "relative/root" }],
    [{ id: "known", root: "/registered/../root" }],
    [{ id: "", root: ROOT }],
    [{ id: "known", root: "" }]
  ];

  for (const entries of invalidEntries) {
    expectCode(() => new RegisteredWorkspaceRegistry(entries), "WORKSPACE_BOUNDARY_VIOLATION");
  }
  expectCode(
    () => new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT, allow_write: "yes" }] as never),
    "WORKSPACE_BOUNDARY_VIOLATION"
  );
});

test("registers managed workspaces read-only and resolves them", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);

  assert.equal(registry.resolve("managed-1"), ROOT);
  assert.deepEqual(registry.resolveExecution("managed-1"), { root: ROOT, allowWrite: false });
  expectCode(() => registry.resolveWritable("managed-1"), "WORKSPACE_PRECONDITION_FAILED");
  expectCode(() => registry.resolve("unknown-managed"), "UNKNOWN_WORKSPACE");
});

test("F2: manual and managed registrations reject invalid roots before canonicalization", () => {
  const invalidRoots = ["", "relative/root", `${ROOT}${sep}..${sep}other`];
  if (process.platform === "win32") invalidRoots.push("\\root", "\\workspace\\child", "C:relative");
  for (const root of invalidRoots) {
    let canonicalized = false;
    const canonicalize = (value: string): string => { canonicalized = true; return value; };
    expectCode(() => new RegisteredWorkspaceRegistry([{ id: "manual", root }], canonicalize),
      "WORKSPACE_BOUNDARY_VIOLATION");
    const registry = new RegisteredWorkspaceRegistry([], canonicalize);
    expectCode(() => registry.registerManaged("managed", root, true), "WORKSPACE_BOUNDARY_VIOLATION");
    expectCode(() => registry.resolve("managed"), "UNKNOWN_WORKSPACE");
    assert.equal(canonicalized, false);
  }
});

test("registerManaged is idempotent for the same id and root", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);
  registry.registerManaged("managed-1", ROOT);
  assert.equal(registry.resolve("managed-1"), ROOT);
});

test("registerManaged rejects conflicting ids and occupied canonical roots", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "manual", root: ROOT }]);
  expectCode(() => registry.registerManaged("managed-1", ROOT), "WORKSPACE_BOUNDARY_VIOLATION");

  registry.registerManaged("managed-1", workspaceFixture("managed", "root"));
  expectCode(() => registry.registerManaged("managed-1", workspaceFixture("other", "root")), "WORKSPACE_BOUNDARY_VIOLATION");
  expectCode(() => registry.registerManaged("managed-2", workspaceFixture("managed", "root")), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("F4: managed registration rejects a manual root whose canonical identity becomes available", () => {
  const manualRoot = workspaceFixture("manual", "late-root");
  const canonicalRoot = workspaceFixture("canonical", "late-root");
  let canonicalAvailable = false;
  const canonicalize = (root: string): string =>
    root === manualRoot && canonicalAvailable ? canonicalRoot : root;
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: manualRoot }
  ], canonicalize);

  canonicalAvailable = true;

  expectCode(
    () => registry.registerManaged("managed", canonicalRoot),
    "WORKSPACE_BOUNDARY_VIOLATION"
  );
});

test("findByRoot returns the manual registration with its real write access", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: ROOT, allow_write: true }
  ]);

  assert.deepEqual(registry.findByRoot(ROOT), {
    id: "manual",
    root: ROOT,
    allowWrite: true,
    source: "manual"
  });
  assert.equal(registry.findByRoot(workspaceFixture("unknown", "root")), undefined);
});

test("findByRoot resolves managed registrations and manual canonical duplicates first-win", () => {
  const canonicalize = (root: string): string => root === workspaceFixture("manual", "root") ? workspaceFixture("canonical", "root") : root;
  const registry = new RegisteredWorkspaceRegistry([
    { id: "first", root: workspaceFixture("manual", "root") },
    { id: "second", root: workspaceFixture("two", "root") }
  ], canonicalize);

  assert.deepEqual(registry.findByRoot(workspaceFixture("canonical", "root")), {
    id: "first",
    root: workspaceFixture("manual", "root"),
    allowWrite: false,
    source: "manual"
  });

  registry.registerManaged("managed-1", workspaceFixture("managed", "root"));
  assert.deepEqual(registry.findByRoot(workspaceFixture("managed", "root")), {
    id: "managed-1",
    root: workspaceFixture("managed", "root"),
    allowWrite: false,
    source: "managed"
  });
});

test("a managed registration cannot occupy a manual canonical root", () => {
  const canonicalize = (): string => workspaceFixture("canonical", "root");
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: workspaceFixture("manual", "root"), allow_write: true }
  ], canonicalize);

  expectCode(() => registry.registerManaged("managed-1", workspaceFixture("managed", "root")), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("manual roots that cannot be canonicalized fall back to the literal root without failing startup", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "known", root: workspaceFixture("definitely", "missing", "path") }
  ]);

  assert.deepEqual(registry.findByRoot(workspaceFixture("definitely", "missing", "path")), {
    id: "known",
    root: workspaceFixture("definitely", "missing", "path"),
    allowWrite: false,
    source: "manual"
  });
  assert.equal(registry.resolve("known"), workspaceFixture("definitely", "missing", "path"));
});

test("registerManaged restores a persisted allow_write flag", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-readonly", ROOT);
  registry.registerManaged("managed-authorized", workspaceFixture("write", "managed"), true);

  expectCode(() => registry.resolveWritable("managed-readonly"), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(registry.resolveWritable("managed-authorized"), workspaceFixture("write", "managed"));
});

test("authorizeWrite grants controlled-write to managed workspaces idempotently", () => {
  const registry = new RegisteredWorkspaceRegistry([]);
  registry.registerManaged("managed-1", ROOT);
  expectCode(() => registry.resolveWritable("managed-1"), "WORKSPACE_PRECONDITION_FAILED");

  registry.authorizeWrite("managed-1");
  assert.equal(registry.resolveWritable("managed-1"), ROOT);
  registry.authorizeWrite("managed-1");
  assert.equal(registry.resolveWritable("managed-1"), ROOT);
});

test("authorizeWrite rejects manual workspaces and unknown ids", () => {
  const registry = new RegisteredWorkspaceRegistry([
    { id: "manual", root: ROOT, allow_write: true }
  ]);

  expectCode(() => registry.authorizeWrite("manual"), "WORKSPACE_PRECONDITION_FAILED");
  expectCode(() => registry.authorizeWrite("missing"), "UNKNOWN_WORKSPACE");
  assert.equal(registry.resolveWritable("manual"), ROOT);
});

test("sourceOf distinguishes manual and managed registrations", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "manual", root: ROOT }]);
  registry.registerManaged("managed-1", workspaceFixture("managed", "root"));

  assert.equal(registry.sourceOf("manual"), "manual");
  assert.equal(registry.sourceOf("managed-1"), "managed");
  expectCode(() => registry.sourceOf("missing"), "UNKNOWN_WORKSPACE");
});
