import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import nodeTest from "node:test";
import { mcpValidationFixture, until } from "../helpers/mcp-validation-fixture.js";
import type { ValidationRun } from "../../src/tasks/validation-run.js";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
const START = "start_controlled_patch_validation", GET = "get_controlled_patch_validation";
const errorCode = (reply: { isError: boolean; body: Record<string, unknown> }) => {
  assert.equal(reply.isError, true); return (reply.body.error as { code: string }).code;
};
function runId(body: Record<string, unknown>): string {
  assert.equal(typeof body.validation_run_id, "string"); return body.validation_run_id as string;
}
function gone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}

test("real catalog exposes exactly 15 tools and strict async inputs without changing sync schema", async t => {
  const f = await mcpValidationFixture(t);
  assert.equal(f.connected.client.getServerVersion()?.version, "1.5.0");
  const tools = new Map((await f.connected.client.listTools()).tools.map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), ["apply_controlled_patch", "authorize_workspace_write", "bind_project", "commit_controlled_patch", "configure_validation_profile", "control_task", "create_project", "generate_controlled_patch", GET, "refine_controlled_patch", "run_task", START, "submit_controlled_patch", "task_result", "validate_controlled_patch"].sort());
  for (const [name, properties] of [[START, ["idempotency_key", "patch_task_id"]], [GET, ["validation_run_id"]], ["validate_controlled_patch", ["patch_task_id"]]] as const) {
    const schema = tools.get(name)!.inputSchema;
    assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...properties].sort());
    assert.deepEqual([...(schema.required ?? [])].sort(), [...properties].sort());
    assert.equal(schema.additionalProperties, false);
  }
});

test("a second Bridge cannot acquire the async owner, while legacy tools remain available", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.script());
  const second = await f.session();
  assert.equal((await second.client.listTools()).tools.length, 15);
  assert.equal(errorCode(await second.call(START, { patch_task_id: f.patchTaskId, idempotency_key: "contender" })), "VALIDATION_OWNER_UNAVAILABLE");
  assert.equal(errorCode(await second.call(GET, { validation_run_id: randomUUID() })), "VALIDATION_OWNER_UNAVAILABLE");
  assert.equal((await second.ok("validate_controlled_patch", { patch_task_id: f.patchTaskId }, 8000)).status, "PASS");
  await second.close();
  const id = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "owner" }));
  await f.waitForTerminal(id);
  assert.equal((await f.connected.ok(GET, { validation_run_id: id })).status, "PASS");
  await f.untouched();
});

test("unsafe async storage under a future BIND project root fails closed without breaking legacy catalog", async t => {
  const f = await mcpValidationFixture(t);
  const config = join(f.root, "unsafe-workspaces.json");
  await fs.writeFile(config, JSON.stringify([{ kind: "project_root", root: f.root }]));
  const unsafe = await f.session(config);
  assert.equal((await unsafe.client.listTools()).tools.length, 15);
  assert.equal(errorCode(await unsafe.call(START, { patch_task_id: f.patchTaskId, idempotency_key: "unsafe" })), "VALIDATION_STORE_BOUNDARY");
  assert.equal(errorCode(await unsafe.call(GET, { validation_run_id: randomUUID() })), "VALIDATION_STORE_BOUNDARY");
  await assert.rejects(fs.stat(config + ".validation-runs"), { code: "ENOENT" });
  await f.untouched();
});

test("a project-root symlink alias cannot make the private validation temp root bindable", async t => {
  const f = await mcpValidationFixture(t);
  const config = join(f.root, "alias-workspaces.json"), tempRoot = config + ".validation-worktrees";
  await fs.mkdir(tempRoot, { mode: 0o700 });
  const alias = join(f.root, "approved-alias"); await fs.symlink(tempRoot, alias);
  await fs.writeFile(config, JSON.stringify([{ kind: "project_root", root: alias }]));
  const unsafe = await f.session(config);
  assert.equal(errorCode(await unsafe.call(START, { patch_task_id: f.patchTaskId, idempotency_key: "alias" })), "VALIDATION_STORE_BOUNDARY");
  assert.deepEqual(await fs.readdir(tempRoot), []);
});

test("E2E A/B: durable start and independent query finish before validation; caller EOF preserves retained PASS across restart", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.blocking());
  const startedAt = performance.now();
  const receipt = await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "first" });
  const startMs = performance.now() - startedAt, id = runId(receipt);
  assert.ok(startMs < 2500); assert.equal(receipt.state, "running"); assert.equal(receipt.phase, "admitted");
  assert.equal(receipt.patch_task_id, f.patchTaskId); assert.equal(receipt.base_head, f.baseHead);
  assert.equal((await f.readRun(id)).validation_run_id, id, "successful admission already has a durable record");
  const queryAt = performance.now();
  const initial = await f.connected.ok(GET, { validation_run_id: id });
  const queryMs = performance.now() - queryAt;
  assert.equal(initial.state, "running"); assert.ok(queryMs < 2500);
  await until(async () => (await f.readRun(id)).current_step?.name === "check");
  await until(async () => fs.stat(f.ready).then(() => true, () => false));
  const active = await f.readRun(id); const recordPath = join(f.directory, id + ".json");
  const before = await fs.readFile(recordPath, "utf8");
  for (let i = 0; i < 3; i++) assert.equal((await f.connected.ok(GET, { validation_run_id: id })).state, "running");
  assert.equal(await fs.readFile(recordPath, "utf8"), before, "query does not checkpoint or otherwise mutate state");
  await f.connected.disconnect();
  assert.equal(f.connected.exited(), false); assert.equal((await f.readRun(id)).state, "running");
  await fs.writeFile(f.release, "complete");
  await until(async () => (await f.readRun(id)).state === "terminal");
  await until(async () => f.connected.exited()); await f.connected.finished;
  const reopened = await f.session();
  const terminal = await reopened.ok(GET, { validation_run_id: id }) as unknown as ValidationRun;
  assert.equal(terminal.status, "PASS"); assert.deepEqual(terminal.steps.map(x => [x.name, x.status]), [["prepare", "PASS"], ["check", "PASS"]]);
  assert.equal(terminal.cleanup.state, "success"); assert.equal(terminal.cleanup.recovery_required, false);
  assert.equal(terminal.proposal_fingerprint, active.proposal_fingerprint); assert.equal(terminal.profile_sha256, active.profile_sha256);
  assert.equal(await fs.readFile(f.counter, "utf8"), "run\n"); await f.untouched();
  const ready = JSON.parse(await fs.readFile(f.ready, "utf8")); assert.equal(gone(ready.pid), true);
  const retained = await fs.readFile(recordPath, "utf8");
  assert.deepEqual(await reopened.ok(GET, { validation_run_id: id }), terminal);
  assert.equal(await fs.readFile(recordPath, "utf8"), retained);
  t.diagnostic(`E2E A/B start_ms=${startMs.toFixed(1)} running_query_ms=${queryMs.toFixed(1)} execution_count=1 retained=PASS caller_EOF_and_restart=PASS`);
});

for (const [exit, status] of [["process.stdout.write('validated')", "PASS"], ["process.exitCode=7", "FAIL"], ["process.kill(process.pid,'SIGTERM')", "INCOMPLETE"]] as const) {
  test("query retains " + status + " and does not re-execute or mutate terminal evidence", async t => {
    const f = await mcpValidationFixture(t); await f.configure(f.script(exit));
    const id = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "result" }));
    await f.waitForTerminal(id);
    const before = await fs.readFile(join(f.directory, id + ".json"), "utf8");
    const result = await f.connected.ok(GET, { validation_run_id: id }) as unknown as ValidationRun;
    assert.equal(result.status, status); assert.equal(result.steps[1]?.status, status);
    assert.equal(await fs.readFile(f.counter, "utf8"), "run\n");
    assert.equal(await fs.readFile(join(f.directory, id + ".json"), "utf8"), before); await f.untouched();
  });
}

test("missing profile is retained INCOMPLETE; invalid inputs cannot admit runs or inject commands", async t => {
  const f = await mcpValidationFixture(t);
  const id = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "missing" }));
  await f.waitForTerminal(id);
  const result = await f.connected.ok(GET, { validation_run_id: id });
  assert.equal(result.status, "INCOMPLETE"); assert.equal(result.reason, "validation_profile_missing");
  const entries = (await fs.readdir(f.directory)).sort();
  for (const extra of [{ argv: [process.execPath] }, { shell: true }, { timeout: 1 }, { profile: {} }, { workspace_root: f.workspace }, { temp_path: f.root }, { process_options: {} }]) {
    assert.equal((await f.connected.call(START, { patch_task_id: f.patchTaskId, idempotency_key: "inject", ...extra })).isError, true);
  }
  for (const args of [{}, { patch_task_id: f.patchTaskId }, { patch_task_id: "", idempotency_key: "key" }, { patch_task_id: f.patchTaskId, idempotency_key: "../key" }]) {
    assert.equal((await f.connected.call(START, args)).isError, true);
  }
  assert.equal(errorCode(await f.connected.call(START, { patch_task_id: randomUUID(), idempotency_key: "unknown" })), "INVALID_STATE_TRANSITION");
  assert.equal(errorCode(await f.connected.call(GET, { validation_run_id: randomUUID() })), "VALIDATION_RUN_UNKNOWN");
  for (const args of [{ validation_run_id: "../bad" }, { validation_run_id: id, cleanup: true }, { validation_run_id: id, retry: true }]) assert.equal((await f.connected.call(GET, args)).isError, true);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), entries); await f.untouched();
});

test("duplicate starts replay first admission after CONFIGURE; a distinct key explicitly revalidates", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.blocking());
  const [one, two] = await Promise.all([1, 2].map(() => f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "same" })));
  const id = runId(one!); assert.equal(runId(two!), id);
  await until(async () => fs.stat(f.ready).then(() => true, () => false));
  const first = await f.readRun(id);
  await f.configure(f.script("process.stdout.write('replacement')"));
  assert.equal(runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "same" })), id);
  assert.equal((await f.readRun(id)).profile_sha256, first.profile_sha256);
  assert.equal(errorCode(await f.connected.call(START, { patch_task_id: randomUUID(), idempotency_key: "same" })), "VALIDATION_IDEMPOTENCY_CONFLICT");
  await fs.writeFile(f.release, "complete"); await f.waitForTerminal(id);
  const next = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "explicit-new" }));
  assert.notEqual(next, id); await f.waitForTerminal(next);
  assert.notEqual((await f.readRun(next)).profile_sha256, first.profile_sha256);
  assert.equal((await f.readRun(id)).profile_sha256, first.profile_sha256);
  assert.equal(await fs.readFile(f.counter, "utf8"), "run\nrun\n"); await f.untouched();
});

test("old synchronous validation preserves its report and creates no async run", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.script());
  const before = await fs.readdir(f.directory);
  const result = await f.connected.ok("validate_controlled_patch", { patch_task_id: f.patchTaskId }, 8000);
  assert.equal(result.status, "PASS"); assert.equal(result.patch_task_id, f.patchTaskId);
  assert.deepEqual(Object.keys(result).sort(), ["base_head", "cleanup", "patch_task_id", "status", "steps", "total_duration_ms", "workspace_id"]);
  assert.deepEqual(await fs.readdir(f.directory), before); await f.untouched();
});

for (const corrupt of ["invalid-json", "incompatible-version"] as const) test("query reports safe " + corrupt + " error after restart without execution", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.script());
  const id = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "corrupt" }));
  await f.waitForTerminal(id); await f.connected.close();
  const filename = join(f.directory, id + ".json"), record = await f.readRun(id);
  const contents = corrupt === "invalid-json" ? "{private-fixture-detail" : JSON.stringify({ ...record, schema_version: 999 });
  await fs.writeFile(filename, contents);
  const reopened = await f.session();
  const result = await reopened.call(GET, { validation_run_id: id });
  assert.equal(errorCode(result), corrupt === "invalid-json" ? "VALIDATION_RUN_CORRUPT" : "VALIDATION_RUN_INCOMPATIBLE");
  assert.equal(JSON.stringify(result.body).includes("private-fixture-detail"), false);
  assert.equal(await fs.readFile(filename, "utf8"), contents); assert.equal(await fs.readFile(f.counter, "utf8"), "run\n");
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) test("E2E C: actual Bridge " + signal + " and restart never resume, retry, attach or reclaim stale worktree", async t => {
  const f = await mcpValidationFixture(t); await f.configure(f.blocking(), 20);
  const id = runId(await f.connected.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "crash" }));
  await until(async () => fs.stat(f.ready).then(() => true, () => false));
  const child = JSON.parse(await fs.readFile(f.ready, "utf8")) as { pid: number };
  // Only the fixture signals its known live child group after a hard-killed Bridge.
  f.cleanup.push(async () => { if (!gone(child.pid)) { process.kill(-child.pid, "SIGKILL"); await until(async () => gone(child.pid)); } });
  const running = await f.readRun(id); assert.equal(running.state, "running");
  const marker = join(running.owned_worktree.parent_path, ".engineering-bridge-validation-run");
  const markerBytes = await fs.readFile(marker, "utf8");
  await f.connected.signal(signal);
  if (signal === "SIGTERM") await until(async () => gone(child.pid));
  else assert.equal(gone(child.pid), false, "hard kill does not pretend a live orphan was supervised");
  const reopened = await f.session();
  const recovered = await reopened.ok(GET, { validation_run_id: id }) as unknown as ValidationRun;
  assert.equal(recovered.status, "INCOMPLETE"); assert.equal(recovered.state, "terminal");
  if (signal === "SIGKILL") {
    assert.equal(recovered.reason, "supervisor_lost"); assert.equal(recovered.cleanup.recovery_required, true);
    assert.equal(await fs.readFile(marker, "utf8"), markerBytes);
    assert.equal(gone(child.pid), false, "restart must not signal or attach the old child");
    assert.equal(errorCode(await reopened.call(START, { patch_task_id: f.patchTaskId, idempotency_key: "new-after-crash" })), "VALIDATION_RECOVERY_REQUIRED");
    process.kill(-child.pid, "SIGKILL"); await until(async () => gone(child.pid));
  } else { assert.equal(recovered.reason, "bridge_sigterm"); assert.equal(recovered.cleanup.state, "success"); }
  assert.equal(runId(await reopened.ok(START, { patch_task_id: f.patchTaskId, idempotency_key: "crash" })), id);
  assert.equal(await fs.readFile(f.counter, "utf8"), "run\n"); await f.untouched();
  t.diagnostic(`E2E C ${signal} retained=INCOMPLETE execution_count=1 recovery_required=${recovered.cleanup.recovery_required} tracked_child_gone=${gone(child.pid)}`);
});
