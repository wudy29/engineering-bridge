import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { withLockedCommitIndex } from "../../../src/tasks/controlled-commit-index.js";
import type { GitProcessTimers, GitStarter } from "../../../src/executors/bounded-git-process.js";

class ManualTimers implements GitProcessTimers {
  readonly pending = new Map<object, () => void>();
  setTimeout(callback: () => void): object { const id = {}; this.pending.set(id, callback); return id; }
  clearTimeout(id: unknown): void { this.pending.delete(id as object); }
  fire(): void {
    const entry = this.pending.entries().next();
    assert.equal(entry.done, false);
    const [id, callback] = entry.value!;
    this.pending.delete(id); callback();
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "engineering-bridge-index-owner-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Index Test");
  git(root, "config", "user.email", "index@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  git(root, "read-tree", "HEAD");
  return root;
}

for (const outcome of ["timeout during verification", "close during verification", "unknown publisher after commit"]) {
  test(`F02 index owner handles ${outcome} without late publication or incorrect lock cleanup`, async (t) => {
    const root = repository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const base = git(root, "rev-parse", "HEAD").trim();
    const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    const indexPath = join(root, ".git", "index");
    const original = readFileSync(indexPath);
    const timers = new ManualTimers();
    const stdin = new PassThrough();
    let input = "";
    stdin.on("data", (chunk) => { input += String(chunk); });
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234,
      unref: () => {}, ref: () => {}, kill: () => true
    }) as unknown as ChildProcessWithoutNullStreams;
    let started!: () => void;
    const publisherStarted = new Promise<void>((resolve) => { started = resolve; });
    let entered!: () => void;
    const verificationEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const verified = new Promise<void>((resolve) => { release = resolve; });
    const starter: GitStarter = (executable, args, options) => {
      if (args.includes("update-ref")) { started(); return child; }
      return spawn(executable, args, options);
    };
    const result = withLockedCommitIndex(root, starter, {
      timers, signaler: () => {}, timing: { executionTimeoutMs: 100, killGraceMs: 10 }
    }, (index) => index.publish(tree, base, "approved tree", async () => { entered(); await verified; }));
    const rejected = assert.rejects(result, { code: "WORKSPACE_PRECONDITION_FAILED" });
    await publisherStarted;
    child.stdout.emit("data", "start: ok\nprepare: ok\n");
    await verificationEntered;
    if (outcome === "unknown publisher after commit") {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.match(input, /commit\n$/u);
      timers.fire(); timers.fire();
    } else if (outcome === "timeout during verification") {
      timers.fire();
      child.emit("close", 0, null);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      timers.fire();
    } else {
      child.emit("close", 0, null);
      await rejected;
      release();
    }
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(git(root, "rev-parse", "HEAD").trim(), base);
    assert.deepEqual(readFileSync(indexPath), original);
    assert.equal(existsSync(`${indexPath}.lock`), outcome === "unknown publisher after commit");
    if (outcome !== "unknown publisher after commit") assert.doesNotMatch(input, /commit\n/u);
    assert.deepEqual(readdirSync(join(root, ".git")).filter((name) => name.startsWith("index.bridge-")), []);
    assert.equal(timers.pending.size, 0);
  });
}
