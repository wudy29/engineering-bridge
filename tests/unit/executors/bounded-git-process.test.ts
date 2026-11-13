import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  runBoundedGit,
  type GitProcessSignaler,
  type GitProcessTimers,
  type GitStarter
} from "../../../src/executors/bounded-git-process.js";

class ManualTimers implements GitProcessTimers {
  readonly pending = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  private nextId = 1;

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(timer: unknown): void {
    this.pending.delete(timer as number);
  }

  fireNext(): number {
    const first = this.pending.entries().next();
    assert.equal(first.done, false);
    const [id, timer] = first.value!;
    this.pending.delete(id);
    timer.callback();
    return timer.delayMs;
  }
}

function fakeChild(pid = 1234): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid,
    kill: () => true,
    ref: () => {},
    unref: () => {}
  }) as unknown as ChildProcessWithoutNullStreams;
}

test("F02 empty Git input sends EOF without a zero-byte write racing a closed reader", async () => {
  const child = fakeChild(); let writes = 0, ended = false;
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      writes++;
      callback(Object.assign(new Error("reader already closed"), { code: "EPIPE" }));
    },
    final(callback) {
      ended = true; callback();
      queueMicrotask(() => { child.stdout.emit("data", "tree\n"); child.emit("close", 0, null); });
    }
  });
  Object.assign(child, { stdin });
  const result = await runBoundedGit(() => child, "/workspace", ["rev-parse", "HEAD^{tree}"], "",
    () => new Error("bounded"));
  assert.deepEqual(result, { code: 0, stdout: "tree\n" });
  assert.equal(ended, true); assert.equal(writes, 0);
});

test("F02 nonempty Git input still rejects EPIPE without treating missing bytes as EOF", async () => {
  const child = fakeChild(); let written: Buffer | undefined;
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    written = chunk; callback(Object.assign(new Error("reader closed"), { code: "EPIPE" }));
  } });
  Object.assign(child, { stdin });
  await assert.rejects(runBoundedGit(() => child, "/workspace", ["apply"], "approved patch\n",
    () => new Error("bounded")), /bounded/u);
  assert.equal(written?.toString(), "approved patch\n");
});

test("shutdown cancellation before spawn starts no Git process or timer", async () => {
  const controller = new AbortController(); controller.abort();
  const timers = new ManualTimers(); let starts = 0;
  await assert.rejects(runBoundedGit(() => { starts++; throw new Error("unexpected spawn"); }, "/workspace", ["status"],
    undefined, () => new Error("bounded"), { timers, ...{ signal: controller.signal } }));
  assert.equal(starts, 0); assert.equal(timers.pending.size, 0);
});

test("shutdown cancellation aborts prepared Git and never sends a late commit", async () => {
  const controller = new AbortController(), timers = new ManualTimers(), child = fakeChild();
  let input = ""; child.stdin.on("data", chunk => { input += String(chunk); });
  let release!: () => void; const verification = new Promise<void>(done => { release = done; });
  const signals: Array<[string, boolean | undefined]> = [];
  const result = runBoundedGit(() => child, "/workspace", ["update-ref", "--stdin"], "start\nprepare\n",
    () => new Error("bounded"), { timers, ...{ signal: controller.signal },
      timing: { executionTimeoutMs: 100, killGraceMs: 10 },
      signaler: (_child, _platform, signal, direct) => { signals.push([signal, direct]); },
      afterPrepare: () => verification });
  const rejected = assert.rejects(result, /bounded/u);
  child.stdout.emit("data", "start: ok\nprepare: ok\n");
  child.emit("exit", 0, null); controller.abort();
  release(); await new Promise<void>(done => setImmediate(done));
  const signalsAtAbort = [...signals];
  const delay = timers.fireNext();
  while (timers.pending.size) timers.fireNext();
  child.emit("close", 0, null); await rejected;
  assert.doesNotMatch(input, /commit/u);
  assert.deepEqual(signalsAtAbort, [["SIGTERM", false]]);
  assert.equal(delay, 10); assert.equal(timers.pending.size, 0);
});

test("shutdown cancellation after commit dispatch leaves publication and reconciliation running", async () => {
  const controller = new AbortController(), child = fakeChild(), timers = new ManualTimers();
  let input = ""; child.stdin.on("data", chunk => { input += String(chunk); });
  const signals: string[] = [];
  const result = runBoundedGit(() => child, "/workspace", ["update-ref", "--stdin"], "start\nprepare\n",
    () => new Error("bounded"), { timers, ...{ signal: controller.signal }, afterPrepare: async () => {},
      signaler: (_child, _platform, signal) => { signals.push(signal); } });
  child.stdout.emit("data", "start: ok\nprepare: ok\n");
  await new Promise<void>(done => setImmediate(done));
  assert.match(input, /commit\n$/u); controller.abort();
  child.emit("close", 0, null); assert.equal((await result).code, 0);
  assert.deepEqual(signals, []); assert.equal(timers.pending.size, 0);
});

test("F02 prepared ref transaction waits for verification before committing", async () => {
  const child = fakeChild();
  let input = "";
  child.stdin.on("data", (chunk) => { input += String(chunk); });
  let release!: () => void;
  const verified = new Promise<void>((resolve) => { release = resolve; });
  const result = runBoundedGit(() => child, "/workspace", ["update-ref", "--stdin"],
    "start\nupdate HEAD new old\nprepare\n", () => new Error("bounded"), {
      afterPrepare: () => verified
    });
  child.stdout.emit("data", "start: ok\npre");
  child.stdout.emit("data", "pare: ok\n");
  assert.equal(input, "start\nupdate HEAD new old\nprepare\n");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(input, "start\nupdate HEAD new old\nprepare\ncommit\n");
  child.emit("close", 0, null);
  assert.equal((await result).code, 0);
});

test("F02 failed prepared verification aborts and waits for process closure", async () => {
  const child = fakeChild();
  let input = "";
  child.stdin.on("data", (chunk) => { input += String(chunk); });
  const result = runBoundedGit(() => child, "/workspace", ["update-ref", "--stdin"],
    "start\nprepare\n", () => new Error("bounded"), {
      afterPrepare: async () => { throw new Error("HEAD switched"); }
    });
  const rejected = assert.rejects(result, /bounded/u);
  child.stdout.emit("data", "start: ok\nprepare: ok\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(input, "start\nprepare\nabort\n");
  child.emit("close", 0, null);
  await rejected;
});

test("F02 timed out prepared verification cannot later publish a commit", async () => {
  const child = fakeChild();
  const timers = new ManualTimers();
  let input = "";
  child.stdin.on("data", (chunk) => { input += String(chunk); });
  let release!: () => void;
  const verified = new Promise<void>((resolve) => { release = resolve; });
  const result = runBoundedGit(() => child, "/workspace", ["update-ref", "--stdin"],
    "start\nprepare\n", () => new Error("bounded"), {
      afterPrepare: () => verified, timers, signaler: () => {},
      timing: { executionTimeoutMs: 100, killGraceMs: 10 }
    });
  const rejected = assert.rejects(result, /bounded/u);
  child.stdout.emit("data", "start: ok\nprepare: ok\n");
  assert.equal(timers.fireNext(), 100);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(input, "start\nprepare\n");
  assert.equal(timers.fireNext(), 10);
  await rejected;
});

test("bounded git resolves normal completion and clears its deadline", async () => {
  const timers = new ManualTimers();
  const child = fakeChild();
  const calls: Array<{ readonly signal: NodeJS.Signals; readonly allowDirectFallback: boolean | undefined }> = [];
  const signaler: GitProcessSignaler = (_child, _platform, signal, allowDirectFallback) => {
    calls.push({ signal, allowDirectFallback });
  };
  const starter: GitStarter = (executable, args, options) => {
    assert.equal(executable, "git");
    assert.deepEqual(args, ["status", "--porcelain"]);
    assert.equal(options.cwd, "/workspace");
    assert.equal(options.shell, false);
    assert.equal(options.detached, true);
    return child;
  };

  const result = runBoundedGit(
    starter,
    "/workspace",
    ["status", "--porcelain"],
    undefined,
    () => new Error("bounded"),
    {
      platform: "linux",
      timers,
      signaler,
      timing: { executionTimeoutMs: 100, killGraceMs: 10 }
    }
  );

  child.stdout.emit("data", "clean\n");
  child.emit("close", 0, null);

  assert.deepEqual(await result, { code: 0, stdout: "clean\n" });
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(calls, []);
});

test("bounded git keeps TERM to KILL grace alive after direct child exit", async () => {
  const timers = new ManualTimers();
  const child = fakeChild();
  const calls: Array<{ readonly signal: NodeJS.Signals; readonly allowDirectFallback: boolean | undefined }> = [];
  const signaler: GitProcessSignaler = (_child, _platform, signal, allowDirectFallback) => {
    calls.push({ signal, allowDirectFallback });
  };
  const starter: GitStarter = (_executable, _args, options) => {
    assert.equal(options.detached, true);
    return child;
  };

  const result = runBoundedGit(
    starter,
    "/workspace",
    ["apply", "--check"],
    undefined,
    () => new Error("bounded"),
    {
      platform: "linux",
      timers,
      signaler,
      timing: { executionTimeoutMs: 100, killGraceMs: 10 }
    }
  );

  let settled = false;
  void result.then(
    () => { settled = true; },
    () => { settled = true; }
  );

  assert.equal(timers.fireNext(), 100);
  assert.deepEqual(calls, [{ signal: "SIGTERM", allowDirectFallback: undefined }]);

  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await Promise.resolve();

  assert.equal(settled, false);
  assert.equal(timers.pending.size, 1);

  assert.equal(timers.fireNext(), 10);
  await assert.rejects(result, /bounded/);
  assert.deepEqual(calls, [
    { signal: "SIGTERM", allowDirectFallback: undefined },
    { signal: "SIGKILL", allowDirectFallback: false }
  ]);
  assert.equal(timers.pending.size, 0);
});

test("bounded git allows direct fallback at KILL when the child has not exited", async () => {
  const timers = new ManualTimers();
  const child = fakeChild();
  const calls: Array<{ readonly signal: NodeJS.Signals; readonly allowDirectFallback: boolean | undefined }> = [];
  const signaler: GitProcessSignaler = (_child, _platform, signal, allowDirectFallback) => {
    calls.push({ signal, allowDirectFallback });
  };

  const result = runBoundedGit(
    () => child,
    "/workspace",
    ["rev-parse", "HEAD"],
    undefined,
    () => new Error("bounded"),
    {
      platform: "linux",
      timers,
      signaler,
      timing: { executionTimeoutMs: 100, killGraceMs: 10 }
    }
  );

  assert.equal(timers.fireNext(), 100);
  assert.equal(timers.fireNext(), 10);
  await assert.rejects(result, /bounded/);

  assert.deepEqual(calls, [
    { signal: "SIGTERM", allowDirectFallback: undefined },
    { signal: "SIGKILL", allowDirectFallback: true }
  ]);
  assert.equal(timers.pending.size, 0);
});

test("bounded git rejects a synchronous spawn failure without leaving timers", async () => {
  const timers = new ManualTimers();
  await assert.rejects(
    runBoundedGit(
      () => { throw new Error("spawn failed"); },
      "/workspace",
      ["status"],
      undefined,
      () => new Error("bounded"),
      { platform: "linux", timers, timing: { executionTimeoutMs: 100, killGraceMs: 10 } }
    ),
    /bounded/
  );
  assert.equal(timers.pending.size, 0);
});
