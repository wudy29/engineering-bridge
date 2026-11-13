import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
const source = process.env.BRIDGE_CANDIDATE_ROOT ?? process.cwd();
const { withLockedCommitIndex } = await import(pathToFileURL(join(source, "dist/src/tasks/controlled-commit-index.js")));
const until = async check => { const end = performance.now() + 8000; while (!await check()) { assert.ok(performance.now() < end, "fixture phase deadline"); await delay(10); } };
async function repo(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "bridge-git-transaction-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Transaction Fixture"); git("config", "user.email", "fixture@example.invalid");
  await fs.mkdir(join(root, "empty-hooks"));
  git("config", "commit.gpgSign", "false"); git("config", "core.hooksPath", join(root, "empty-hooks"));
  git("commit", "--allow-empty", "-qm", "base"); git("read-tree", "HEAD");
  return { root, git, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), index: join(root, ".git/index") };
}
test("native Git supports prepare/abort and holds HEAD plus resolved branch locks", async t => {
  const f = await repo(t), branch = f.git("symbolic-ref", "HEAD");
  const child = spawn("git", ["update-ref", "--stdin"], { cwd: f.root, stdio: "pipe" });
  let out = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.resume();
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdin.write(`start\nupdate HEAD ${f.head} ${f.head}\nprepare\n`);
  try {
    await until(() => out.includes("prepare: ok\n"));
    assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), true);
    assert.equal(existsSync(join(f.root, ".git", branch + ".lock")), true);
    assert.throws(() => f.git("update-ref", "HEAD", f.head, f.head));
  } finally { child.stdin.end("abort\n"); await closed; }
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), false);
  t.diagnostic(f.git("--version"));
  if (process.platform === "win32") assert.match(f.git("--version"), /\.windows\./u, "actual Git for Windows required");
});
test("unsupported transaction protocol fails closed without old git commit fallback", async t => {
  const f = await repo(t), before = await fs.readFile(f.index), commands = [];
  const rejectingStart = (exe, args, options) => {
    commands.push([...args]);
    return args.includes("update-ref")
      ? spawn(process.execPath, ["-e", "process.stderr.write('fatal: unknown command: start\\n');process.exit(128)"], options)
      : spawn(exe, args, options);
  };
  await assert.rejects(withLockedCommitIndex(f.root, rejectingStart, {}, index => index.publish(f.tree, f.head, "no fallback", async () => {})), { code: "WORKSPACE_PRECONDITION_FAILED" });
  assert.equal(f.git("rev-parse", "HEAD"), f.head); assert.deepEqual(await fs.readFile(f.index), before);
  assert.equal(commands.some(args => args.includes("commit")), false);
  assert.equal(existsSync(f.index + ".lock"), false);
});
test("retained or foreign index.lock survives repeated operations without ownership proof", async t => {
  const f = await repo(t); await fs.writeFile(f.index + ".lock", "foreign owner\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(withLockedCommitIndex(f.root, spawn, {}, async () => assert.fail("lock acquired unexpectedly")), { code: "WORKSPACE_PRECONDITION_FAILED" });
    assert.equal(await fs.readFile(f.index + ".lock", "utf8"), "foreign owner\n");
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
  }
});
test("uncertain timed-out real publisher retains index.lock and reports failure", async t => {
  const f = await repo(t), original = await fs.readFile(f.index);
  let publisher, closed;
  const start = (exe, args, options) => {
    if (!args.includes("update-ref")) return spawn(exe, args, options);
    publisher = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "git-publisher-proxy.mjs"), "held-commit", f.root, ...args], options);
    closed = new Promise(resolve => publisher.once("close", resolve));
    return publisher;
  };
  // Fault injection: signal delivery cannot be confirmed. The existing source
  // must fail closed and retain its recovery lock; no production limit changes.
  const pending = withLockedCommitIndex(f.root, start, { timing: { executionTimeoutMs: 1000, killGraceMs: 20 }, signaler: () => {} },
    index => index.publish(f.tree, f.head, "uncertain publisher", async () => {}));
  const rejected = assert.rejects(pending, { code: "WORKSPACE_PRECONDITION_FAILED" });
  await until(() => existsSync(join(f.root, "ready")));
  try {
    await rejected;
    // runBoundedGit deliberately unrefs an unconfirmed publisher. The fixture,
    // not the application, now owns waiting for its explicitly released fault.
    publisher.ref();
    assert.equal(publisher.exitCode, null); assert.equal(publisher.signalCode, null);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
    assert.deepEqual(await fs.readFile(f.index), original);
    const lock = await fs.readFile(f.index + ".lock");
    await fs.writeFile(join(f.root, "release"), "release owned fixture\n"); await closed;
    assert.notEqual(f.git("rev-parse", "HEAD"), f.head);
    assert.equal(f.git("rev-parse", "HEAD^{tree}"), f.tree);
    assert.deepEqual(await fs.readFile(f.index + ".lock"), lock);
    await assert.rejects(withLockedCommitIndex(f.root, spawn, {}, async () => {}), { code: "WORKSPACE_PRECONDITION_FAILED" });
  } finally {
    publisher?.ref();
    await fs.writeFile(join(f.root, "release"), "release\n"); if (closed) await closed;
    if (process.env.BRIDGE_INTEGRATION_EVIDENCE) {
      await fs.mkdir(process.env.BRIDGE_INTEGRATION_EVIDENCE, { recursive: true });
      await fs.copyFile(join(f.root, "events.jsonl"), join(process.env.BRIDGE_INTEGRATION_EVIDENCE, "uncertain-publisher-events.jsonl"));
    }
  }
});
