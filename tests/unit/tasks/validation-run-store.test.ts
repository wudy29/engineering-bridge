import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";

import { ValidationRunStore } from "../../../src/tasks/validation-run-store.js";
import type { ValidationRunAdmission } from "../../../src/tasks/validation-run.js";

const PATCH_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_PATCH_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000003";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000099";
const AT = "2030-01-01T00:00:00.000Z";

async function fixture(t: TestContext) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "bridge-validation-run-store-")));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = join(parent, "project");
  await fs.mkdir(workspace);
  const directory = join(parent, "runs");
  const input: ValidationRunAdmission = {
    idempotency_key: "admission-one",
    patch_task_id: PATCH_ID,
    workspace_id: "workspace-a",
    workspace_root: workspace,
    base_head: "1".repeat(40),
    patch: "exact patch bytes\n",
    profile: {
      preparation: [], validation: [],
      defaultStepTimeoutSeconds: 600, totalTimeoutSeconds: 1200
    }
  };
  return { parent, workspace, directory, input };
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("admission is durable and recreating the store preserves the run and exact identities", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  const persisted = JSON.parse(await fs.readFile(join(directory, `${admitted.validation_run_id}.json`), "utf8"));
  assert.deepEqual(persisted, admitted);
  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.patch_task_id, PATCH_ID);
  assert.equal(persisted.state, "running");
  assert.equal(persisted.phase, "admitted");
  assert.equal(persisted.started_at, null);
  assert.equal(persisted.operation_sequence, 0);
  const recreated = new ValidationRunStore(directory);
  assert.deepEqual(await recreated.get(admitted.validation_run_id), admitted);
  assert.deepEqual(await recreated.admit(input), admitted);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith(".json")).length, 1);
});

test("a pure unknown query does not create a store or alter a retained record", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  assert.equal(await store.get(UNKNOWN_ID), undefined);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  const admitted = await store.admit(input);
  const before = await fs.readFile(join(directory, `${admitted.validation_run_id}.json`), "utf8");
  assert.deepEqual(await store.latest(PATCH_ID), admitted);
  assert.deepEqual(await store.get(admitted.validation_run_id), admitted);
  assert.equal(await fs.readFile(join(directory, `${admitted.validation_run_id}.json`), "utf8"), before);
});

test("concurrent retries share one durable admission and preserve the first profile snapshot", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  const changed = { ...input, profile: { ...input.profile!, totalTimeoutSeconds: 2100 } };
  const retried = await Promise.all(Array.from({ length: 12 }, () => store.admit(changed)));
  assert.ok(retried.every((run) => run.validation_run_id === admitted.validation_run_id));
  assert.ok(retried.every((run) => run.profile_sha256 === admitted.profile_sha256));
  assert.equal(retried[0]!.profile_snapshot!.total_timeout_seconds, 1200);
  assert.deepEqual(await new ValidationRunStore(directory).admit(changed), admitted);
});

test("same key with changed patch, base, or workspace identity is an explicit conflict", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  await store.admit(input);
  for (const changed of [
    { ...input, patch: "different patch\n" },
    { ...input, base_head: "2".repeat(40) },
    { ...input, workspace_id: "workspace-b" },
    { ...input, patch_task_id: OTHER_PATCH_ID }
  ]) {
    await rejectsCode(() => store.admit(changed), "VALIDATION_IDEMPOTENCY_CONFLICT");
  }
});

test("a second key cannot run the same patch concurrently but unrelated runs are independent", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const [one, two] = await Promise.all([
    store.admit(input),
    store.admit({ ...input, idempotency_key: "unrelated", patch_task_id: OTHER_PATCH_ID })
  ]);
  assert.notEqual(one.validation_run_id, two.validation_run_id);
  assert.equal(one.admission_sequence, 1);
  assert.equal(two.admission_sequence, 2);
  await rejectsCode(() => store.admit({ ...input, idempotency_key: "second-key" }), "VALIDATION_ALREADY_RUNNING");
  assert.equal((await new ValidationRunStore(directory).get(two.validation_run_id))?.patch_task_id, OTHER_PATCH_ID);
});

test("explicit revalidation gets a distinct run and the new profile without overwriting history", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const one = await store.admit(input);
  const ended = await store.update(one.validation_run_id, 0, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
  });
  assert.equal(ended.status, "INCOMPLETE");
  const two = await store.admit({ ...input, idempotency_key: "explicit-revalidation", profile: {
    ...input.profile!, totalTimeoutSeconds: 2100
  } });
  assert.notEqual(two.validation_run_id, one.validation_run_id);
  assert.notEqual(two.profile_sha256, one.profile_sha256);
  assert.equal((await store.get(one.validation_run_id))?.status, "INCOMPLETE");
  assert.equal((await store.latest(PATCH_ID))?.validation_run_id, two.validation_run_id);
});

test("stale updates and terminal regression are rejected after durable recreation", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const one = await store.admit(input);
  const running = await store.update(one.validation_run_id, 0, { type: "start", at: AT, owner_instance_id: OWNER_ID });
  assert.equal(running.operation_sequence, 1);
  await rejectsCode(() => store.update(one.validation_run_id, 0, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "timeout"
  }), "VALIDATION_STALE_UPDATE");
  const terminal = await store.update(one.validation_run_id, 1, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "timeout"
  });
  const recreated = new ValidationRunStore(directory);
  assert.deepEqual(await recreated.get(one.validation_run_id), terminal);
  await rejectsCode(() => recreated.update(one.validation_run_id, terminal.operation_sequence, {
    type: "start", at: AT, owner_instance_id: OWNER_ID
  }), "VALIDATION_RUN_INVALID_TRANSITION");
});

test("reload leaves running records unchanged; explicit model recovery retains identity and fences revalidation", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  await store.update(admitted.validation_run_id, 0, { type: "start", at: AT, owner_instance_id: OWNER_ID });
  const recreated = new ValidationRunStore(directory);
  assert.equal((await recreated.get(admitted.validation_run_id))?.state, "running");
  const recovered = await recreated.update(admitted.validation_run_id, 1, {
    type: "owner_lost", at: AT, owner_instance_id: OWNER_ID, owner_loss_confirmed: true
  });
  assert.equal(recovered.status, "INCOMPLETE");
  assert.equal(recovered.reason, "supervisor_lost");
  assert.equal(recovered.cleanup.recovery_required, true);
  assert.equal((await recreated.admit(input)).validation_run_id, admitted.validation_run_id);
  await rejectsCode(() => recreated.admit({ ...input, idempotency_key: "cannot-bypass-orphan" }), "VALIDATION_RECOVERY_REQUIRED");
});

test("rename failure preserves old bytes but fences the uncertain result", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  const filename = join(directory, `${admitted.validation_run_id}.json`);
  const before = await fs.readFile(filename, "utf8");
  const replacement = mock.method(fs, "rename", async () => { throw Object.assign(new Error("fault"), { code: "EIO" }); });
  try {
    await rejectsCode(() => store.update(admitted.validation_run_id, 0, {
      type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
    }), "VALIDATION_STORE_UNAVAILABLE");
  } finally { replacement.mock.restore(); }
  assert.equal(await fs.readFile(filename, "utf8"), before);
  await rejectsCode(() => store.get(admitted.validation_run_id), "VALIDATION_STORE_UNAVAILABLE");
  assert.deepEqual(await new ValidationRunStore(directory).get(admitted.validation_run_id), admitted);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
});

test("query sees committed state while a replacement is pending, not the uncommitted transition", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename.bind(fs);
  const replacement = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    entered.resolve(); await release.promise; return rename(...args);
  });
  try {
    const update = store.update(admitted.validation_run_id, 0, { type: "start", at: AT, owner_instance_id: OWNER_ID });
    await entered.promise;
    assert.deepEqual(await store.get(admitted.validation_run_id), admitted);
    release.resolve();
    const committed = await update;
    assert.equal((await store.get(admitted.validation_run_id))?.operation_sequence, committed.operation_sequence);
  } finally { release.resolve(); replacement.mock.restore(); }
});

test("post-rename directory-sync failure is uncertain and cannot expose a newly committed outcome", async (t) => {
  if (process.platform === "win32") return t.skip("Windows has no directory fsync contract");
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  const open = fs.open.bind(fs);
  const replacement = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === directory) mock.method(handle, "sync", async () => { throw new Error("directory sync failed"); });
    return handle;
  });
  try {
    await rejectsCode(() => store.update(admitted.validation_run_id, 0, {
      type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
    }), "VALIDATION_STORE_UNAVAILABLE");
  } finally { replacement.mock.restore(); }
  await rejectsCode(() => store.get(admitted.validation_run_id), "VALIDATION_STORE_UNAVAILABLE");
  await rejectsCode(() => store.admit(input), "VALIDATION_STORE_UNAVAILABLE");
  const reloaded = await new ValidationRunStore(directory).get(admitted.validation_run_id);
  assert.equal(reloaded?.status, "INCOMPLETE");
  assert.equal(reloaded?.idempotency_key, input.idempotency_key);
});

test("corrupt or incompatible records are distinct from unknown and fence new admissions", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const broken = await store.admit(input);
  const healthy = await store.admit({ ...input, patch_task_id: OTHER_PATCH_ID, idempotency_key: "healthy" });
  const filename = join(directory, `${broken.validation_run_id}.json`);
  for (const [contents, code] of [
    ["{broken", "VALIDATION_RUN_CORRUPT"],
    [JSON.stringify({ ...broken, schema_version: 2 }), "VALIDATION_RUN_INCOMPATIBLE"],
    [JSON.stringify({ ...broken, validation_run_id: UNKNOWN_ID }), "VALIDATION_RUN_CORRUPT"],
    [JSON.stringify({ ...broken, profile_sha256: "0".repeat(64) }), "VALIDATION_RUN_CORRUPT"]
  ] as const) {
    await fs.writeFile(filename, contents);
    const recreated = new ValidationRunStore(directory);
    await rejectsCode(() => recreated.get(broken.validation_run_id), code);
    assert.deepEqual(await recreated.get(healthy.validation_run_id), healthy);
    assert.equal(await recreated.get(UNKNOWN_ID), undefined);
    await rejectsCode(() => recreated.admit({ ...input, idempotency_key: "never-replay-corrupt" }), "VALIDATION_STORE_UNAVAILABLE");
  }
});

test("oversize records and invalid UTF-8 cannot be loaded as valid history", async (t) => {
  const { directory, input } = await fixture(t);
  const admitted = await new ValidationRunStore(directory).admit(input);
  const filename = join(directory, `${admitted.validation_run_id}.json`);
  await fs.writeFile(filename, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  await rejectsCode(() => new ValidationRunStore(directory).get(admitted.validation_run_id), "VALIDATION_RUN_CORRUPT");
  await fs.writeFile(filename, Buffer.from([0xff, 0xfe]));
  await rejectsCode(() => new ValidationRunStore(directory).get(admitted.validation_run_id), "VALIDATION_RUN_CORRUPT");
});

test("store refuses a project-contained path or symlink rather than writing repository state", async (t) => {
  const { parent, workspace, input } = await fixture(t);
  await fs.mkdir(join(workspace, ".git"));
  const unsafe = join(workspace, "validation-runs");
  await rejectsCode(() => new ValidationRunStore(unsafe).admit(input), "VALIDATION_STORE_BOUNDARY");
  await assert.rejects(fs.stat(unsafe), { code: "ENOENT" });
  const alias = join(parent, "alias");
  await fs.symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  await rejectsCode(() => new ValidationRunStore(join(alias, "runs")).admit(input), "VALIDATION_STORE_BOUNDARY");
});

test("workspace containment is checked even for a registered directory without .git", async (t) => {
  const { workspace, input } = await fixture(t);
  await rejectsCode(() => new ValidationRunStore(join(workspace, "runs")).admit(input), "VALIDATION_STORE_BOUNDARY");
  await assert.rejects(fs.stat(join(workspace, "runs")), { code: "ENOENT" });
});

test("a retained symlink is rejected without reading or changing its target", async (t) => {
  const { parent, directory, input } = await fixture(t);
  const admitted = await new ValidationRunStore(directory).admit(input);
  const filename = join(directory, `${admitted.validation_run_id}.json`);
  const other = join(parent, "do-not-touch.json");
  await fs.writeFile(other, "private sentinel");
  await fs.unlink(filename);
  try { await fs.symlink(other, filename); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink privilege unavailable");
    throw error;
  }
  await rejectsCode(() => new ValidationRunStore(directory).get(admitted.validation_run_id), "VALIDATION_RUN_CORRUPT");
  assert.equal(await fs.readFile(other, "utf8"), "private sentinel");
});

test("capacity accounts for abandoned temporary files and never evicts idempotency history", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory, { maxStoreBytes: 9 * 1024 * 1024 });
  const one = await store.admit(input);
  await fs.writeFile(join(directory, ".abandoned.tmp"), Buffer.alloc(2 * 1024 * 1024));
  const recreated = new ValidationRunStore(directory, { maxStoreBytes: 9 * 1024 * 1024 });
  assert.deepEqual(await recreated.admit(input), one);
  await rejectsCode(() => recreated.admit({ ...input, patch_task_id: OTHER_PATCH_ID, idempotency_key: "would-exceed-budget" }), "VALIDATION_STORE_FULL");
  assert.deepEqual(await recreated.get(one.validation_run_id), one);
});

test("unrelated proposal persistence does not rewrite or corrupt validation records", async (t) => {
  const { parent, directory, input } = await fixture(t);
  const admitted = await new ValidationRunStore(directory).admit(input);
  const filename = join(directory, `${admitted.validation_run_id}.json`);
  const before = await fs.readFile(filename, "utf8");
  const proposalPath = join(parent, "workspaces.json.controlled-patches.json");
  await fs.writeFile(`${proposalPath}.tmp`, JSON.stringify({ version: 1, proposals: [], applied_task_ids: [] }));
  await fs.rename(`${proposalPath}.tmp`, proposalPath);
  await fs.writeFile(proposalPath, "corrupt unrelated proposal store");
  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.deepEqual(await new ValidationRunStore(directory).get(admitted.validation_run_id), admitted);
});

test("PASS and FAIL retain ordered bounded evidence across store recreation", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  for (const exit_code of [0, 7]) {
    let run = await store.admit({ ...input, idempotency_key: `exit-${exit_code}`, profile: {
      ...input.profile!, validation: [{ name: "check", argv: ["trusted-command", "argument"] }]
    } });
    const update = async (event: Parameters<ValidationRunStore["update"]>[2]) => {
      run = await store.update(run.validation_run_id, run.operation_sequence, event);
    };
    await update({ type: "start", at: AT, owner_instance_id: OWNER_ID });
    await update({ type: "step_started", at: AT, phase: "validation", index: 0 });
    await update({ type: "step_completed", at: AT, outcome: {
      kind: "exit", exit_code, duration_ms: 17, output_tail: "\u0001".repeat(100_000) + "終"
    } });
    await update({ type: "cleanup", at: AT, cleanup: { state: "success", reason: null, recovery_required: false } });
    await update({ type: "finish", at: AT, total_duration_ms: 20 });
    assert.equal(run.status, exit_code === 0 ? "PASS" : "FAIL");
    assert.ok(Buffer.byteLength(run.steps[0]!.output_tail) <= 65_536);
    assert.ok(run.steps[0]!.output_tail.endsWith("終"));
    assert.deepEqual(await new ValidationRunStore(directory).get(run.validation_run_id), run);
  }
});

test("failed first admission publishes no run and temporary open collision never deletes another file", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  let collision: string | undefined;
  const open = fs.open.bind(fs);
  const replacement = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
      collision = args[0];
      const handle = await open(...args);
      try { await handle.writeFile("belongs to another writer"); } finally { await handle.close(); }
      throw Object.assign(new Error("exclusive open collision"), { code: "EEXIST" });
    }
    return open(...args);
  });
  try { await rejectsCode(() => store.admit(input), "VALIDATION_STORE_UNAVAILABLE"); }
  finally { replacement.mock.restore(); }
  assert.ok(collision);
  assert.equal(await fs.readFile(collision, "utf8"), "belongs to another writer");
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".json")), false);
  assert.equal(await store.get(UNKNOWN_ID), undefined);
  await rejectsCode(() => store.admit(input), "VALIDATION_STORE_UNAVAILABLE");
});

test("directory identity replacement fences access and cannot overwrite the replacement directory", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const admitted = await store.admit(input);
  await fs.rename(directory, `${directory}-original`);
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, "sentinel"), "preserve replacement");
  await rejectsCode(() => store.get(admitted.validation_run_id), "VALIDATION_STORE_BOUNDARY");
  await rejectsCode(() => store.update(admitted.validation_run_id, 0, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
  }), "VALIDATION_STORE_BOUNDARY");
  assert.deepEqual(await fs.readdir(directory), ["sentinel"]);
  assert.deepEqual(await new ValidationRunStore(`${directory}-original`).get(admitted.validation_run_id), admitted);
});

test("duplicate durable keys or sequences fail closed instead of selecting an arbitrary run", async (t) => {
  const { directory, input } = await fixture(t);
  const one = await new ValidationRunStore(directory).admit(input);
  for (const changed of [
    { ...one, validation_run_id: UNKNOWN_ID, admission_sequence: 2 },
    { ...one, validation_run_id: UNKNOWN_ID, idempotency_key: "different-key" }
  ]) {
    await fs.writeFile(join(directory, `${UNKNOWN_ID}.json`), JSON.stringify(changed));
    const recreated = new ValidationRunStore(directory);
    await rejectsCode(() => recreated.get(one.validation_run_id), "VALIDATION_RUN_CORRUPT");
    await rejectsCode(() => recreated.get(UNKNOWN_ID), "VALIDATION_RUN_CORRUPT");
    await rejectsCode(() => recreated.admit(input), "VALIDATION_STORE_UNAVAILABLE");
  }
});

test("unattributable JSON record prevents latest from misrepresenting incomplete history", async (t) => {
  const { directory, input } = await fixture(t);
  const one = await new ValidationRunStore(directory).admit(input);
  await fs.writeFile(join(directory, "invalid-name.json"), JSON.stringify(one));
  const recreated = new ValidationRunStore(directory);
  assert.deepEqual(await recreated.get(one.validation_run_id), one);
  await rejectsCode(() => recreated.latest(PATCH_ID), "VALIDATION_STORE_UNAVAILABLE");
});

test("snapshot capacity is reserved before admission and oversized commands are never truncated", async (t) => {
  const { directory, input } = await fixture(t);
  const profile = { ...input.profile!, validation: [{ name: "large", argv: ["command", "x".repeat(4 * 1024 * 1024)] as [string, string] }] };
  await rejectsCode(() => new ValidationRunStore(directory).admit({ ...input, profile }), "VALIDATION_STORE_FULL");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("durable key replay needs neither the current proposal nor a surviving workspace", async (t) => {
  const { directory, workspace, input } = await fixture(t);
  const options = { protectedRoots: [workspace] };
  const one = await new ValidationRunStore(directory, options).admit(input);
  await fs.rmdir(workspace);
  const recreated = new ValidationRunStore(directory, options);
  assert.deepEqual(await recreated.get(one.validation_run_id), one);
  assert.deepEqual(await recreated.replay(input.idempotency_key, PATCH_ID), one);
  assert.deepEqual(await recreated.admit(input), one);
  assert.equal(await recreated.replay("unknown-key", PATCH_ID), undefined);
  await rejectsCode(() => recreated.replay(input.idempotency_key, OTHER_PATCH_ID), "VALIDATION_IDEMPOTENCY_CONFLICT");
});

test("record read I/O failure is unavailable, not corruption or unknown", async (t) => {
  const { directory, input } = await fixture(t);
  const one = await new ValidationRunStore(directory).admit(input);
  const filename = join(directory, `${one.validation_run_id}.json`);
  const open = fs.open.bind(fs);
  const replacement = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === filename) throw Object.assign(new Error("disk I/O fault"), { code: "EIO" });
    return open(...args);
  });
  try {
    const recreated = new ValidationRunStore(directory);
    await rejectsCode(() => recreated.get(one.validation_run_id), "VALIDATION_STORE_UNAVAILABLE");
    await rejectsCode(() => recreated.admit(input), "VALIDATION_STORE_UNAVAILABLE");
  } finally { replacement.mock.restore(); }
  assert.deepEqual(await new ValidationRunStore(directory).get(one.validation_run_id), one);
});

test("existing non-private store is rejected without changing its permissions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX directory permissions");
  const { directory, input } = await fixture(t);
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o755);
  await rejectsCode(() => new ValidationRunStore(directory).admit(input), "VALIDATION_STORE_BOUNDARY");
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("rename that commits before reporting error leaves no queryable false rollback", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const one = await store.admit(input);
  const rename = fs.rename.bind(fs);
  const replacement = mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); throw Object.assign(new Error("uncertain rename"), { code: "EIO" });
  });
  try { await rejectsCode(() => store.update(one.validation_run_id, 0, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
  }), "VALIDATION_STORE_UNAVAILABLE"); }
  finally { replacement.mock.restore(); }
  await rejectsCode(() => store.get(one.validation_run_id), "VALIDATION_STORE_UNAVAILABLE");
  assert.equal((await new ValidationRunStore(directory).get(one.validation_run_id))?.status, "INCOMPLETE");
});

test("file sync failure before rename leaves the committed state available", async (t) => {
  const { directory, input } = await fixture(t);
  const store = new ValidationRunStore(directory);
  const one = await store.admit(input);
  const open = fs.open.bind(fs);
  const replacement = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
      mock.method(handle, "sync", async () => { throw new Error("file sync failure"); });
    }
    return handle;
  });
  try { await rejectsCode(() => store.update(one.validation_run_id, 0, {
    type: "finish", at: AT, total_duration_ms: 0, reason: "preflight_failed"
  }), "VALIDATION_STORE_UNAVAILABLE"); }
  finally { replacement.mock.restore(); }
  assert.deepEqual(await store.get(one.validation_run_id), one);
  assert.deepEqual(await new ValidationRunStore(directory).get(one.validation_run_id), one);
});

test("over-budget temporary residue fences admission without hiding healthy retained results", async (t) => {
  const { directory, input } = await fixture(t);
  const options = { maxStoreBytes: 9 * 1024 * 1024 };
  const one = await new ValidationRunStore(directory, options).admit(input);
  const residue = await fs.open(join(directory, ".abandoned.tmp"), "wx", 0o600);
  try { await residue.truncate(10 * 1024 * 1024); } finally { await residue.close(); }
  const recreated = new ValidationRunStore(directory, options);
  assert.deepEqual(await recreated.get(one.validation_run_id), one);
  assert.equal(await recreated.get(UNKNOWN_ID), undefined);
  await rejectsCode(() => recreated.admit({ ...input, patch_task_id: OTHER_PATCH_ID, idempotency_key: "over-budget" }), "VALIDATION_STORE_FULL");
});

test("directory enumeration I/O failure has a classified unavailable result", async (t) => {
  const { directory, input } = await fixture(t);
  const one = await new ValidationRunStore(directory).admit(input);
  const replacement = mock.method(fs, "opendir", async () => {
    throw Object.assign(new Error("directory I/O fault"), { code: "EIO" });
  });
  try {
    await rejectsCode(() => new ValidationRunStore(directory).get(one.validation_run_id), "VALIDATION_STORE_UNAVAILABLE");
  } finally { replacement.mock.restore(); }
});

test("a fresh Node process reads the durable admission without changing its state", async (t) => {
  const { directory, input } = await fixture(t);
  const admitted = await new ValidationRunStore(directory).admit(input);
  const moduleUrl = new URL("../../../src/tasks/validation-run-store.js", import.meta.url).href;
  const text = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    const { ValidationRunStore } = await import(process.argv[1]);
    const run = await new ValidationRunStore(process.argv[2]).get(process.argv[3]);
    process.stdout.write(JSON.stringify(run));
  `, moduleUrl, directory, admitted.validation_run_id], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(text), admitted);
  assert.equal((await new ValidationRunStore(directory).get(admitted.validation_run_id))?.phase, "admitted");
});
