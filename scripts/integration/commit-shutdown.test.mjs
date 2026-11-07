import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gone } from "./fixture-cleanup.mjs";
const source = process.env.BRIDGE_CANDIDATE_ROOT ?? process.cwd();
const scripts = dirname(fileURLToPath(import.meta.url));
const evidence = process.env.BRIDGE_INTEGRATION_EVIDENCE ?? await fs.mkdtemp(join(tmpdir(), "bridge-integration-evidence-"));
await fs.mkdir(evidence, { recursive: true });
const { Client } = await import(pathToFileURL(join(source, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")));
const { StdioServerTransport } = await import(pathToFileURL(join(source, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js")));
const until = async (check, ms = 8000) => {
  const deadline = performance.now() + ms;
  while (!await check()) { if (performance.now() >= deadline) throw new Error("fixture phase did not settle"); await delay(10); }
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const patch = "diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n";
const queuedPatch = "diff --git a/queued.txt b/queued.txt\n--- a/queued.txt\n+++ b/queued.txt\n@@ -1 +1 @@\n-unchanged\n+queued\n";
const posixOnly = process.platform === "win32" ? "native POSIX signal acceptance; Windows requires its own gate" : false;

async function fixture(t, mode, signal, mixed = false) {
  const createdRoot = await fs.mkdtemp(join(tmpdir(), "bridge-commit-signal-"));
  const root = await fs.realpath(createdRoot), repo = join(root, "repo");
  const label = mode + "-" + signal + (mixed ? "-mixed" : "");
  const trace = (event, data = {}) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ event, pid: process.pid, ms: String(process.hrtime.bigint() / 1000000n), ...data }) + "\n");
  trace("fixture_paths", { mkdtemp: createdRoot, realpath: await fs.realpath(createdRoot), root, cwd: process.cwd() });
  const events = () => {
    const text = existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8") : "";
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(x => JSON.parse(x));
  };
  await fs.mkdir(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Integration Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "core.autocrlf", "false"); git("config", "core.hooksPath", join(root, "empty-hooks")); git("config", "commit.gpgSign", "false");
  await fs.mkdir(join(root, "empty-hooks"));
  await fs.writeFile(join(repo, "note.txt"), "before\n"); await fs.writeFile(join(repo, "queued.txt"), "unchanged\n");
  git("add", "note.txt", "queued.txt"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"), originalIndex = await fs.readFile(join(repo, ".git/index"));
  const expectedIndex = join(root, "approved-index"); await fs.writeFile(expectedIndex, originalIndex);
  const expectedEnv = { ...process.env, GIT_INDEX_FILE: expectedIndex };
  execFileSync("git", ["apply", "--cached", "--recount", "--unidiff-zero"], { cwd: repo, env: expectedEnv, input: patch });
  const approvedTree = execFileSync("git", ["write-tree"], { cwd: repo, env: expectedEnv, encoding: "utf8" }).trim();
  const entries = [{ id: "w", root: repo, allow_write: true }];
  if (mixed) for (const id of ["sync", "async"]) {
    const path = join(root, id); await fs.cp(repo, path, { recursive: true }); entries.push({ id, root: path });
  }
  const config = join(root, "workspaces.json"); await fs.writeFile(config, JSON.stringify(entries));
  const sessions = [], auxiliary = [], runs = [];
  const runSnapshots = () => Promise.all(runs.map(async id => {
    try { return JSON.parse(await fs.readFile(join(config + ".validation-runs", id + ".json"), "utf8")); }
    catch (error) { return { validation_run_id: id, observationError: error.code ?? error.message }; }
  }));
  const connect = async (injected = false) => {
    const child = spawn(process.execPath, [join(source, "dist/src/mcp-stdio.js"), config], {
      cwd: source, stdio: "pipe", env: { ...process.env, NODE_OPTIONS: injected ? "--import=" + pathToFileURL(join(scripts, "commit-signal-hook.mjs")).href : "",
        PATH: mixed ? root + ":" + process.env.PATH : process.env.PATH,
        BRIDGE_CANDIDATE_ROOT: source, BRIDGE_INTEGRATION_CASE: root, BRIDGE_INTEGRATION_MODE: mode,
        BRIDGE_INTEGRATION_PROXY: join(scripts, "git-publisher-proxy.mjs") },
    });
    trace("bridge_spawn", { childPid: child.pid });
    const client = new Client({ name: "commit-shutdown-fixture", version: "1" });
    child.stderr.on("data", data => appendFileSync(join(root, "stderr.log"), data));
    child.stdin.on("error", () => {});
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const transport = new StdioServerTransport(child.stdout, child.stdin);
    child.once("close", () => transport.onclose?.());
    sessions.push({ child, client, closed }); await client.connect(transport); trace("bridge_ready");
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      const item = result.content.find(item => item.type === "text"); let body;
      try { body = JSON.parse(item?.text ?? "{}"); } catch { body = { raw: item?.text ?? "" }; }
      return { isError: result.isError === true, body };
    };
    return { child, client, closed, call };
  };
  t.after(async () => {
    try { trace("fixture_before_teardown", { runs: await runSnapshots() }); }
    finally {
      await fs.writeFile(join(root, "release"), "release owned fixture\n");
      await fs.writeFile(join(root, "release-children"), "release owned fixture\n");
      try {
        for (const s of sessions) {
          await s.client.close().catch(() => {});
          if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGTERM");
          try { await until(() => s.child.exitCode !== null || s.child.signalCode !== null, 10_000); }
          catch (error) { s.child.kill("SIGKILL"); throw error; }
          await s.closed;
        }
        for (const event of events().filter(e => ["native_git_spawn", "owned_descendant"].includes(e.event))) await until(() => gone(event.childPid));
        for (const child of auxiliary) await until(() => gone(child.pid));
      } finally {
        for (const name of ["events.jsonl", "stderr.log", "index-install-input", "index-installed", "index-at-bridge-exit"]) if (existsSync(join(root, name))) await fs.copyFile(join(root, name), join(evidence, label + "-" + name));
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
  const session = await connect(true);
  const submit = async (workspace_id, diff) => {
    const result = await session.call("submit_controlled_patch", { workspace_id, base_head: base, diff });
    assert.equal(result.isError, false, JSON.stringify(result)); return result.body.task_id;
  };
  const id = await submit("w", patch), queuedId = await submit("w", queuedPatch);
  assert.equal((await session.call("apply_controlled_patch", { patch_task_id: id, confirmation: "APPLY" })).isError, false);
  if (mixed) {
    const marker = join(root, "auxiliary.jsonl");
    const blocking = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()})+'\\n');setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root,"release-children"))}))process.exit(0)},10);`;
    await fs.writeFile(join(root, "dsh"), `#!${process.execPath}\n${blocking}`, { mode: 0o700 });
    assert.equal((await session.call("run_task", { workspace_id: "async", instruction: "fixture only", executor: "dsh" })).isError, false);
    for (const name of ["sync", "async"]) {
      const validationId = await submit(name, patch);
      const result = await session.call("configure_validation_profile", { workspace_id: name, confirmation: "CONFIGURE", profile: {
        preparation: [], validation: [{ name: "block", argv: [process.execPath, "-e", blocking] }], default_step_timeout_seconds: 30, total_timeout_seconds: 40,
      } }); assert.equal(result.isError, false, JSON.stringify(result));
      if (name === "sync") void session.call("validate_controlled_patch", { patch_task_id: validationId }).then(value => trace("legacy_result", { value }), error => trace("legacy_rpc_closed", { message: error.message }));
      else {
        const start = await session.call("start_controlled_patch_validation", { patch_task_id: validationId, idempotency_key: "mixed" });
        assert.equal(start.isError, false, JSON.stringify(start)); runs.push(start.body.validation_run_id);
      }
    }
    trace("mixed_readiness_wait", { workspace_roots: entries });
    await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim().split("\n").length === 3);
    auxiliary.push(...readFileSync(marker, "utf8").trim().split("\n").map(x => JSON.parse(x)));
    for (const child of auxiliary) assert.equal(gone(child.pid), false, "each required task must be alive before COMMIT shutdown");
    const snapshots = await runSnapshots();
    trace("mixed_ready", { children: auxiliary, runs: snapshots });
    for (const run of snapshots) {
      assert.equal(run.state, "running"); assert.equal(run.phase, "validation");
    }
  }
  return { root, repo, git, base, originalIndex, approvedTree, expectedEnv, session, connect, id, queuedId, trace, events, label, auxiliary, runs, config };
}

async function runSignal(t, mode, signal, mixed = false) {
  const f = await fixture(t, mode, signal, mixed);
  let response;
  const pending = f.session.call("commit_controlled_patch", { patch_task_id: f.id, message: "approved fixture", confirmation: "COMMIT" })
    .catch(error => ({ rpcError: error.message })).then(value => { response = value; f.trace("rpc_result", { value }); return value; });
  await until(() => {
    if (existsSync(join(f.root, "ready"))) return true;
    if (response) throw new Error("COMMIT returned before the fault window: " + JSON.stringify(response));
    return false;
  });
  const queued = [];
  if (mode === "held-commit" && !mixed) {
    queued.push(f.session.call("apply_controlled_patch", { patch_task_id: f.queuedId, confirmation: "APPLY" }).catch(error => ({ rpcError: error.message })));
    queued.push(f.session.call("commit_controlled_patch", { patch_task_id: f.id, message: "queued commit", confirmation: "COMMIT" }).catch(error => ({ rpcError: error.message })));
    await until(() => f.events().filter(e => e.event === "write_enqueued").length === 4);
  }
  f.trace("signal_sent", { signal }); f.session.child.kill(signal);
  await until(() => existsSync(join(f.root, "shutdown-started")));
  assert.equal(f.events().find(e => e.event === "shutdown_started").closing, true);
  if (mode === "held-commit" && !mixed) {
    for (const [name, args] of [
      ["apply_controlled_patch", { patch_task_id: f.queuedId, confirmation: "APPLY" }],
      ["commit_controlled_patch", { patch_task_id: f.id, message: "late commit", confirmation: "COMMIT" }],
    ]) assert.equal((await f.session.call(name, args)).isError, true, "write admission must already be closed");
    f.session.child.kill(signal); // Join the same shutdown; no second default exit.
  }
  const unknown = ["publisher-unknown", "private-index-unknown"].includes(mode);
  if (unknown) {
    await until(() => existsSync(join(f.root, "shutdown-failed")));
    assert.equal(f.session.child.exitCode, null, "unconfirmed publisher must prevent normal active exit");
    assert.equal(f.git("rev-parse", "HEAD"), f.base);
    assert.equal(existsSync(join(f.repo, ".git/index.lock")), true);
    const native = f.events().filter(e => e.event === "native_git_spawn").at(-1);
    assert.equal(gone(native.childPid), false, "uncertainty is backed by a real surviving Git process");
  }
  if (mode !== "publisher-timeout") {
    f.trace("fault_released"); await fs.writeFile(join(f.root, "release"), "finite release after shutdown starts\n");
  }
  await until(() => f.session.child.exitCode !== null || f.session.child.signalCode !== null, 10_000);
  const exit = await f.session.closed; await pending; const queuedResults = await Promise.all(queued);
  for (const value of queuedResults) assert.ok(value.isError || value.rpcError, "queued writes must reject");
  const after = f.git("rev-parse", "HEAD"), indexAfter = await fs.readFile(join(f.repo, ".git/index"));
  const publishes = !["before-publish", "publisher-timeout", "private-index-unknown"].includes(mode);
  const success = ["held-commit", "before-index-install"].includes(mode);
  assert.equal(after === f.base, !publishes);
  if (publishes) assert.equal(f.git("rev-parse", "HEAD^{tree}"), f.approvedTree);
  assert.equal(await fs.readFile(join(f.repo, "note.txt"), "utf8"), "after\n");
  assert.equal(await fs.readFile(join(f.repo, "queued.txt"), "utf8"), "unchanged\n");
  const events = f.events(), mainExit = events.find(e => e.event === "bridge_exit"); assert.ok(mainExit);
  assert.ok(mainExit.groups.every(group => group.gone), "every owned publisher group must already be gone at Bridge exit");
  for (const publisher of events.filter(e => e.event === "publisher_spawn")) {
    const closed = events.find(e => e.event === "publisher_close" && e.childPid === publisher.childPid);
    assert.ok(closed && BigInt(closed.ms) <= BigInt(mainExit.ms), "publisher close must precede Bridge exit");
  }
  const native = events.filter(e => e.event === "native_git_spawn");
  for (const e of native) {
    assert.equal(gone(e.childPid), true, "real Git must have exited");
    assert.equal(gone(e.pid), true, "publisher must have exited");
    assert.equal(gone(-e.pid), true, "owned publisher process group must be quiescent");
    const closed = events.find(x => x.event === "native_git_close" && x.pid === e.pid);
    if (mode === "publisher-timeout") {
      // TERM also kills the proxy, so it cannot emit its child's close event.
      // The Bridge's kernel group probe at its own exit covers that real Git.
      assert.ok(mainExit.groups.some(group => group.pid === e.pid && group.gone));
    } else assert.ok(closed && BigInt(closed.ms) <= BigInt(mainExit.ms), "native Git closes before Bridge exits");
  }
  for (const e of events.filter(e => e.event === "owned_descendant")) assert.equal(gone(e.childPid), true, "ignore-stdio descendant must be gone");
  for (const item of f.auxiliary) assert.equal(gone(item.pid), true, "ordinary and validation processes must be gone");
  for (const id of f.runs) {
    const report = JSON.parse(await fs.readFile(join(f.config + ".validation-runs", id + ".json"), "utf8"));
    assert.equal(report.status, "INCOMPLETE"); assert.equal(report.cleanup.state, "success");
  }
  if (success) {
    const install = events.find(e => e.event === "index_install_enter");
    assert.equal(events.find(e => e.event === "index_installed").sha256, install.sha256,
      "the exact approved index bytes are installed atomically");
    // Git's existing postchecks refresh stat-cache fields. Compare complete
    // entries (modes, OIDs, stages, paths) and flags, not mutable stat bytes.
    for (const args of [["ls-files", "--stage", "-z"], ["ls-files", "-v", "-z"]]) {
      assert.deepEqual(execFileSync("git", args, { cwd: f.repo }),
        execFileSync("git", args, { cwd: f.repo, env: f.expectedEnv }));
    }
    assert.equal(f.git("diff", "--cached", "--name-only"), "");
    assert.ok(events.find(e => e.event === "writes_drained"));
  } else assert.deepEqual(indexAfter, f.originalIndex);
  const retained = !success && mode !== "before-publish";
  assert.equal(existsSync(join(f.repo, ".git/index.lock")), retained);
  assert.equal(exit.code, retained ? 1 : signal === "SIGTERM" ? 143 : 130);
  if (retained) {
    assert.match(readFileSync(join(f.root, "stderr.log"), "utf8"), /Controlled write shutdown could not be confirmed/u);
    assert.notEqual(response?.body?.committed, true);
    const lock = await fs.readFile(join(f.repo, ".git/index.lock"));
    const reopened = await f.connect();
    const repeated = await reopened.call("commit_controlled_patch", { patch_task_id: f.id, message: "repeat", confirmation: "COMMIT" });
    assert.equal(repeated.isError, true); assert.deepEqual(await fs.readFile(join(f.repo, ".git/index.lock")), lock);
    assert.equal(f.git("rev-parse", "HEAD"), after);
    await fs.writeFile(join(evidence, f.label + "-index.lock"), lock);
    if (unknown) assert.ok((await fs.readdir(join(f.repo, ".git"))).some(name => name.startsWith("index.bridge-")), "unknown private execution retains its private index too");
  }
  await fs.writeFile(join(evidence, f.label + "-result.json"), JSON.stringify({ mode, signal, mixed, base: f.base,
    headAtBridgeExit: after, approvedTree: f.approvedTree, exit, response, queuedResults, indexBefore: hash(f.originalIndex),
    indexAfter: hash(indexAfter), retainedLock: retained, nativeProcesses: native, auxiliary: f.auxiliary,
    worktreePreserved: true, queuedFilePreserved: true, publisherGroupGoneBeforeExit: true }, null, 2) + "\n");
}
for (const signal of ["SIGTERM", "SIGINT"]) for (const mode of ["before-publish", "held-commit", "before-index-install", "index-install-error"]) {
  test(`COMMIT shutdown ${signal} during ${mode}`, { skip: posixOnly }, t => runSignal(t, mode, signal));
}
for (const mode of ["publisher-timeout", "publisher-unknown", "private-index-unknown", "closed-parent-descendant"]) {
  test(`COMMIT shutdown ${mode} retains honest ownership and recovery`, { skip: posixOnly }, t => runSignal(t, mode, "SIGTERM"));
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`COMMIT shutdown ${signal} drains alongside ordinary, sync and async tasks`, { skip: posixOnly }, t => runSignal(t, "held-commit", signal, true));
}
test("F02 real Git nonzero exit after publication reconciles only the approved tree", async t => {
  const f = await fixture(t, "exit-error-after-publish", "none");
  const result = await f.session.call("commit_controlled_patch", { patch_task_id: f.id, message: "approved fixture", confirmation: "COMMIT" });
  assert.equal(result.isError, false); assert.equal(result.body.committed, true);
  assert.equal(f.events().find(e => e.event === "publisher_close").code, 7);
  assert.equal(f.git("rev-parse", "HEAD"), result.body.commit_sha);
  assert.equal(f.git("rev-parse", "HEAD^{tree}"), f.approvedTree);
  assert.equal(f.git("status", "--porcelain"), ""); assert.equal(existsSync(join(f.repo, ".git/index.lock")), false);
});
