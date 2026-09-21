import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import { CoreError } from "../../src/core/errors.js";
import { observationsDirectory, readSnapshots, startDashboardServer } from "../../src/dashboard.js";

const time = "2026-09-21T00:00:00.000Z";
const now = Date.parse(time);
const filename = (kind: string, id: string): string =>
  createHash("sha256").update(JSON.stringify([kind, id])).digest("hex") + ".json";
const producer = (id = "producer-a", observed_at: unknown = time) => ({
  schema_version: 1, kind: "producer", record_id: id, producer_id: id,
  observed_at, metadata: { pid: 123, bridge_version: "1.5.0", started_at: time },
});
const task = (id = "task-a", producerId = "producer-a", metadata: Record<string, unknown> = {}) => ({
  schema_version: 1, kind: "task", record_id: id, producer_id: producerId, observed_at: time,
  metadata: {
    task_id: id, state: "queued", executor: "codex", requested_model: null,
    requested_reasoning_effort: null, created_at: time, started_at: null, ended_at: null,
    ...metadata,
  },
});

async function fixture(t: TestContext, create = true) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "bridge-dashboard-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = join(root, "workspaces.json");
  const directory = config + ".observations";
  if (create) await fs.mkdir(directory, { mode: 0o700 });
  const write = async (record: { kind: string; record_id: string; [key: string]: unknown }): Promise<void> => {
    await fs.writeFile(join(directory, filename(record.kind, record.record_id)), JSON.stringify(record));
  };
  return { root, config, directory, write };
}

async function symlink(t: TestContext, target: string, path: string, type: "file" | "dir") {
  try { await fs.symlink(target, path, type); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Symlinks are not supported or permitted on this host");
      return false;
    }
    throw error;
  }
}

test("directory derivation resolves the parent and preserves the config basename", async t => {
  const f = await fixture(t, false);
  assert.equal(await observationsDirectory(relative(process.cwd(), f.config)), f.directory);
  const alias = join(f.root, "alias");
  if (!await symlink(t, f.root, alias, "dir")) return;
  assert.equal(await observationsDirectory(join(alias, "workspaces.json")), f.directory);
});

test("valid records expose only the producer and task view fields", async t => {
  const f = await fixture(t);
  await f.write(producer());
  await f.write(task("task-a", "producer-a", { secret: "do not expose" }));
  const view = await readSnapshots(f.config, now);
  assert.equal(view.availability, "available");
  assert.deepEqual(view.producers, [{
    producer_id: "producer-a", observed_at: time, age_ms: 0, freshness: "fresh",
    pid: 123, bridge_version: "1.5.0", started_at: time,
  }]);
  assert.deepEqual(view.tasks, [{
    ...task().metadata, producer_id: "producer-a",
  }]);
});

test("malformed, invalid schema, mismatched hash and task identity are independently skipped", async t => {
  const f = await fixture(t);
  await f.write(task("good"));
  await fs.writeFile(join(f.directory, filename("task", "broken")), "{");
  await fs.writeFile(join(f.directory, filename("task", "wrong-hash")), JSON.stringify(task("other")));
  await f.write({ ...task("schema"), schema_version: 2 });
  await f.write({ ...task("kind"), kind: "history" });
  await f.write(task("identity", "producer-a", { task_id: "different" }));
  await fs.writeFile(join(f.directory, "unhashed.json"), JSON.stringify(task("unhashed")));
  await fs.mkdir(join(f.directory, filename("task", "directory")));
  assert.deepEqual((await readSnapshots(f.config, now)).tasks.map(value => value.task_id), ["good"]);
});

test("missing directory is unavailable, freshness unknown, and never created", async t => {
  const f = await fixture(t, false);
  assert.deepEqual(await readSnapshots(f.config, now), {
    availability: "unavailable", freshness: "unknown", producers: [], tasks: [],
  });
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("unreadable directory is unavailable without repair", async t => {
  const f = await fixture(t);
  await f.write(task());
  t.mock.method(fs, "readdir", async () => { throw new Error("unreadable"); });
  assert.equal((await readSnapshots(f.config, now)).availability, "unavailable");
  assert.equal((await fs.stat(f.directory)).isDirectory(), true);
});

test("unsafe directory permissions are rejected without repair", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await fs.chmod(f.directory, 0o777);
  assert.equal((await readSnapshots(f.config, now)).availability, "unavailable");
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o777);
});

test("symlink directory is unavailable and symlink entries are skipped", async t => {
  const f = await fixture(t, false);
  const target = join(f.root, "target");
  await fs.mkdir(target, { mode: 0o700 });
  if (!await symlink(t, target, f.directory, "dir")) return;
  assert.equal((await readSnapshots(f.config, now)).availability, "unavailable");
  await fs.unlink(f.directory);
  await fs.mkdir(f.directory, { mode: 0o700 });
  const outside = join(f.root, "outside.json");
  await fs.writeFile(outside, JSON.stringify(task("linked")));
  if (!await symlink(t, outside, join(f.directory, filename("task", "linked")), "file")) return;
  await f.write(task("regular"));
  assert.deepEqual((await readSnapshots(f.config, now)).tasks.map(value => value.task_id), ["regular"]);
});

test("16KiB is accepted and larger files are skipped", async t => {
  const f = await fixture(t);
  for (const [id, size] of [["limit", 16384], ["oversized", 16385]] as const) {
    const encoded = JSON.stringify(task(id));
    await fs.writeFile(join(f.directory, filename("task", id)), encoded + " ".repeat(size - Buffer.byteLength(encoded)));
  }
  assert.deepEqual((await readSnapshots(f.config, now)).tasks.map(value => value.task_id), ["limit"]);
});

test("exact states, nullable fields, and optional fields are preserved", async t => {
  const f = await fixture(t);
  const states = ["queued", "running", "waiting_for_supervisor_review", "completed", "failed"];
  for (const state of states) {
    await f.write(task(state, "producer-a", {
      state, executor: "dsh", requested_model: "model", requested_reasoning_effort: "high",
      thread_id: "thread", started_at: time, ended_at: time, last_reported_activity_at: time,
    }));
  }
  await f.write(task("bad-state", "producer-a", { state: "done" }));
  await f.write(task("bad-executor", "producer-a", { executor: "other" }));
  const tasks = (await readSnapshots(f.config, now)).tasks;
  assert.deepEqual(tasks.map(value => value.state).sort(), [...states].sort());
  for (const value of tasks) {
    assert.equal(value.executor, "dsh");
    assert.equal(value.requested_model, "model");
    assert.equal(value.requested_reasoning_effort, "high");
    assert.equal(value.thread_id, "thread");
    assert.equal(value.started_at, time);
    assert.equal(value.ended_at, time);
    assert.equal(value.last_reported_activity_at, time);
  }
});

test("only an exact canonical safe error pair is exposed", async t => {
  const f = await fixture(t);
  const safe = new CoreError("CODEX_EXECUTION_FAILED");
  await f.write(task("safe", "producer-a", { state: "failed", error_code: safe.code, error_summary: safe.message }));
  await f.write(task("raw", "producer-a", { error_code: safe.code, error_summary: "<secret> raw diagnostic" }));
  await f.write(task("unknown", "producer-a", { error_code: "OTHER", error_summary: safe.message }));
  const tasks = (await readSnapshots(f.config, now)).tasks;
  assert.equal(tasks.find(value => value.task_id === "safe")?.error_summary, safe.message);
  assert.equal(tasks.find(value => value.task_id === "safe")?.error_code, safe.code);
  for (const id of ["raw", "unknown"]) {
    const value = tasks.find(value => value.task_id === id)!;
    assert.equal("error_code" in value, false);
    assert.equal("error_summary" in value, false);
  }
});

test("ordering uses activity, creation, then descending task ID; producer associations survive", async t => {
  const f = await fixture(t);
  const later = new Date(now + 1000).toISOString();
  const latest = new Date(now + 2000).toISOString();
  await f.write(producer("producer-a"));
  await f.write(producer("producer-b"));
  await f.write(task("active", "producer-a", { last_reported_activity_at: latest }));
  await f.write(task("a", "producer-a", { created_at: later }));
  await f.write(task("z", "producer-b", { created_at: later }));
  await f.write(task("old", "producer-b", { last_reported_activity_at: later }));
  const view = await readSnapshots(f.config, now);
  assert.deepEqual(view.tasks.map(value => [value.task_id, value.producer_id]), [
    ["active", "producer-a"], ["z", "producer-b"], ["a", "producer-a"], ["old", "producer-b"],
  ]);
  assert.deepEqual(view.producers.map(value => value.producer_id), ["producer-a", "producer-b"]);
});

test("freshness boundaries include missing, invalid, and future heartbeats", async t => {
  const f = await fixture(t);
  for (const [observed, freshness, age] of [
    [time, "fresh", 0], [new Date(now - 15000).toISOString(), "fresh", 15000],
    [new Date(now - 15001).toISOString(), "stale", 15001],
    [new Date(now + 1).toISOString(), "unknown", null],
    ["invalid", "unknown", null], [undefined, "unknown", null],
  ] as const) {
    await f.write({ ...producer(), observed_at: observed });
    const value = (await readSnapshots(f.config, now)).producers[0]!;
    assert.equal(value.freshness, freshness);
    assert.equal(value.age_ms, age);
  }
});

test("HTTP is loopback-only, read-only, uncached, and serves the embedded polling UI", async t => {
  const f = await fixture(t);
  await f.write(task());
  const server = await startDashboardServer(f.config, 0);
  t.after(() => new Promise<void>((resolveClose, reject) =>
    server.close(error => error ? reject(error) : resolveClose())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);
  const get = (path: string, method = "GET", host = "127.0.0.1:" + address.port) =>
    new Promise<{ status: number | undefined; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolveResponse, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers: { Host: host } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => resolveResponse({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
  const html = await get("/");
  assert.equal(html.status, 200);
  assert.match(html.headers["content-type"] ?? "", /text\/html/);
  for (const label of ["Engineering Bridge Dashboard", "Producer heartbeat", "Requested model",
    "Requested reasoning effort", "waiting_for_supervisor_review", "completed", "Fetch error", "Read error"]) {
    assert.ok(html.body.includes(label), label);
  }
  assert.match(html.body, /textContent/);
  assert.doesNotMatch(html.body, /innerHTML/);
  assert.match(html.body, /finally \{ setTimeout\(poll, 2000\); \}/);
  assert.match(html.body, /poll\(\);/);
  const api = await get("/api/snapshots");
  assert.equal(api.status, 200);
  assert.match(api.headers["content-type"] ?? "", /application\/json/);
  assert.equal(JSON.parse(api.body).tasks[0].task_id, "task-a");
  for (const [path, method, host, status] of [
    ["/", "GET", "evil.example", 403],
    ["/", "GET", "127.0.0.1.evil.example", 403],
    ["/", "POST", "localhost", 405],
    ["/api/snapshots", "DELETE", "localhost", 405],
    ["/", "HEAD", "localhost", 405],
    ["/missing", "GET", "localhost", 404],
    ["/../../package.json", "GET", "localhost", 404],
  ] as const) {
    const response = await get(path, method, host);
    assert.equal(response.status, status);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    if (status === 405) assert.equal(response.headers.allow, "GET");
  }
  for (const response of [html, api]) {
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
});
