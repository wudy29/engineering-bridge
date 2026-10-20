import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";

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
    ...task().metadata, producer_id: "producer-a", observed_at: time,
  }]);
});

test("task report time comes only from a valid envelope timestamp, without excluding legacy records", async t => {
  const f = await fixture(t);
  await f.write(task("reported", "producer-a", { observed_at: "PRIVATE_METADATA" }));
  await f.write({ ...task("legacy"), observed_at: undefined });
  await f.write({ ...task("invalid"), observed_at: "PRIVATE_RAW_VALUE" });
  const view = await readSnapshots(f.config, now);
  assert.equal(view.tasks.length, 3);
  assert.equal(Reflect.get(view.tasks.find(value => value.task_id === "reported")!, "observed_at"), time);
  for (const id of ["legacy", "invalid"]) {
    assert.equal(Reflect.get(view.tasks.find(value => value.task_id === id)!, "observed_at"), undefined);
  }
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
});

test("old and named snapshots coexist, invalid optional labels fall back, and reader never deletes", async t => {
  const f = await fixture(t);
  await f.write(task("old", "producer-a", { state: "completed", ended_at: time }));
  await f.write(task("named", "producer-a", {
    workspace_id: "bridge", workspace_display_name: "Engineering Bridge", dashboard_title: "Dashboard V0 Slice 3",
    root: "/private/workspace", instruction: "PRIVATE_INSTRUCTION", output: "PRIVATE_OUTPUT",
    evidence: "PRIVATE_EVIDENCE", diagnostics: "PRIVATE_DIAGNOSTICS", error_summary: "PRIVATE_ERROR",
  }));
  await f.write(task("invalid-labels", "producer-a", {
    workspace_display_name: "multiline\nname", dashboard_title: "x".repeat(101),
  }));
  const before = (await fs.readdir(f.directory)).sort();
  const view = await readSnapshots(f.config, now + 86_400_000);
  assert.equal(view.tasks.length, 3);
  const named = view.tasks.find(value => value.task_id === "named")!;
  assert.equal(named.workspace_id, "bridge");
  assert.equal(named.workspace_display_name, "Engineering Bridge");
  assert.equal(named.dashboard_title, "Dashboard V0 Slice 3");
  for (const id of ["old", "invalid-labels"]) {
    const value = view.tasks.find(item => item.task_id === id)!;
    assert.equal(value.workspace_display_name, undefined);
    assert.equal(value.dashboard_title, undefined);
  }
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE_|private\/workspace/);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), before, "reading never deletes old terminal snapshots");
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
  for (const label of ["Engineering Bridge", "Bridge 在线", "心跳延迟", "状态未知", "技术详情",
    "等待执行", "执行中", "等待调用方验收", "已完成", "失败", "暂无当前任务", "暂时无法读取 Bridge 状态", "旧进程历史观测"]) {
    assert.ok(html.body.includes(label), label);
  }
  assert.match(html.body, /lang="zh-CN"/);
  assert.match(html.body, /textContent/);
  assert.doesNotMatch(html.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html.body, /finally \{ setTimeout\(poll, 2000\); \}/);
  assert.match(html.body, /poll\(\);/);
  const script = html.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  // Keep the initial fetch pending: these checks exercise the shipped formatters without a DOM library.
  const ui = runInNewContext(script + "\n;({ relativeAge, relativeTime, durationText, modelText, stateLabels, partitionTasks, activityText });", {
    document: { getElementById: () => ({ addEventListener() {} }) }, fetch: () => new Promise(() => {}),
  });
  await t.test("relative times are readable and do not invent missing or future activity", () => {
    for (const [age, label] of [[0, "刚刚"], [8000, "8 秒前"], [120000, "2 分钟前"],
      [3600000, "1 小时前"], [86400000, "1 天前"], [null, "暂无记录"], [-1, "暂无记录"]]) {
      assert.equal(ui.relativeAge(age), label);
    }
    assert.equal(ui.relativeTime(time, now + 8000), "8 秒前");
    assert.equal(ui.relativeTime(undefined, now), "暂无记录");
    assert.equal(ui.relativeTime("invalid", now), "暂无记录");
  });
  await t.test("review and disconnected tasks never keep presenting an execution timer", () => {
    const value = { ...task().metadata, started_at: time };
    assert.equal(ui.durationText({ ...value, state: "running" }, now + 24000), "已运行 24 秒");
    for (const elapsed of [192000, 147 * 3600000]) {
      assert.equal(ui.durationText({ ...value, state: "waiting_for_supervisor_review" }, now + elapsed), "结果已返回，待调用方验收");
    }
    for (const state of ["queued", "running", "waiting_for_supervisor_review"]) {
      assert.equal(ui.durationText({ ...value, state }, now + 147 * 3600000, false), "历史观测，当前状态不可确认");
    }
    for (const state of ["completed", "failed"]) {
      assert.equal(ui.durationText({ ...value, state, ended_at: new Date(now + 484000).toISOString() }, now + 900000), "耗时 8 分 04 秒");
      assert.equal(ui.durationText({ ...value, state, ended_at: null }, now), "耗时未记录");
    }
    assert.equal(ui.durationText(task().metadata, now + 8000), "已等待 8 秒");
    assert.equal(ui.durationText({ ...value, state: "running", started_at: null }, now), "等待开始");
    assert.equal(ui.stateLabels.get("waiting_for_supervisor_review"), "等待调用方验收");
    assert.equal(ui.stateLabels.get("completed"), "已完成");
  });
  await t.test("fresh review tasks are separate from current tasks, all disconnected observations remain inspectable", () => {
    const records = ["fresh", "stale", "unknown", "missing"].map(id => ({ producer_id: id, task_id: id, state: "waiting_for_supervisor_review" }));
    const view = { producers: ["fresh", "stale", "unknown"].map(freshness => ({ producer_id: freshness, freshness })), tasks: records };
    const parts = ui.partitionTasks(view);
    assert.equal(JSON.stringify(parts.review.map((value: { task_id: string }) => value.task_id)), '["fresh"]');
    assert.equal(JSON.stringify(parts.past.map((value: { task_id: string }) => value.task_id)), '["stale","unknown","missing"]');
    assert.equal(parts.current.length + parts.review.length + parts.ended.length + parts.past.length, records.length);
    assert.equal(parts.current.length, 0);
    assert.equal(parts.ended.length, 0);
    assert.ok(records.every(value => value.state === "waiting_for_supervisor_review"));
    assert.equal(ui.partitionTasks({ ...view, producers: [] }).past.length, records.length);
    assert.equal(ui.partitionTasks({ ...view, producers: view.producers.map(value => ({ ...value, freshness: "fresh" })) }).review.length, 3);
    assert.match(html.body, /<details id="past-records"[^>]*>/);
    assert.doesNotMatch(html.body, /<details id="past-records"[^>]*\bopen\b/);
  });
  await t.test("missing activity uses the report time with an honest label", () => {
    assert.equal(ui.activityText({ last_reported_activity_at: time, observed_at: new Date(now + 7000).toISOString() }, now + 8000), "最近活动：8 秒前");
    assert.equal(ui.activityText({ observed_at: time }, now + 8000), "最后上报：8 秒前");
    assert.equal(ui.activityText({}, now), "最后上报：暂无记录");
  });
  await t.test("model and effort names use friendly labels with literal unknown fallbacks", () => {
    for (const [effort, label] of [["low", "低"], ["medium", "中等"], ["high", "高"], ["max", "最高"]]) {
      assert.equal(ui.modelText({ requested_model: "gpt-6-astra", requested_reasoning_effort: effort }), "Astra · " + label + "思考");
    }
    assert.equal(ui.modelText({ requested_model: "future-model", requested_reasoning_effort: "future-effort" }), "future-model · future-effort思考");
    assert.equal(ui.modelText({ requested_model: "__proto__", requested_reasoning_effort: "constructor" }), "__proto__ · constructor思考");
    assert.equal(ui.modelText(task().metadata), "未指定模型 · 未指定思考强度");
  });
  const api = await get("/api/snapshots");
  assert.equal(api.status, 200);
  assert.match(api.headers["content-type"] ?? "", /application\/json/);
  assert.equal(JSON.parse(api.body).tasks[0].task_id, "task-a");
  for (const [path, method, host, status] of [
    ["/", "GET", "evil.example", 403],
    ["/", "GET", "127.0.0.1.evil.example", 403],
    ["/", "POST", "localhost", 405],
    ["/api/snapshots", "PUT", "localhost", 405],
    ["/api/snapshots", "PATCH", "localhost", 405],
    ["/api/snapshots", "OPTIONS", "localhost", 405],
    ["/", "GET", "127.0.0.1:1", 403],
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
