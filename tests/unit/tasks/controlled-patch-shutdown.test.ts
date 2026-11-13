import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import type { GitProcessOptions, GitProcessResult, GitProcessTimers, GitStarter } from "../../../src/executors/bounded-git-process.js";

// Exercise ownership/queue boundaries without real PID signals. Public COMMIT,
// actual Git processes and shared-index invariants have separate STDIO gates.
type Internals = {
  withApplyLock<T>(root: string, action: () => Promise<T>, cancellable?: boolean): Promise<T>;
  gitOptions(): GitProcessOptions;
  gitResult(root: string, args: readonly string[]): Promise<GitProcessResult>;
  startGit: GitStarter;
  gitProcesses: Map<ChildProcessWithoutNullStreams, { owner: unknown }>;
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function setup(starter?: GitStarter, options: GitProcessOptions = {}) {
  const registry = new RegisteredWorkspaceRegistry([]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => { throw new Error("unused executor"); });
  const service = new ControlledPatchService(registry, tasks, starter, undefined, options);
  return { service, inner: service as unknown as Internals };
}
function child(pid: number) {
  return Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { throw new Error("unexpected direct signal"); }, ref() {}, unref() {} }) as unknown as ChildProcessWithoutNullStreams;
}

test("controlled shutdown closes admission synchronously, rechecks queued writes and drains active APPLY", async () => {
  const { service, inner } = setup(); const started = deferred(), release = deferred(); let queuedRan = false;
  const active = inner.withApplyLock("same", async () => { started.resolve(); await release.promise; return "applied"; });
  await started.promise;
  const queued = inner.withApplyLock("same", async () => { queuedRan = true; });
  const queuedRejected = assert.rejects(queued, { code: "INVALID_STATE_TRANSITION" });
  const stopped = service.shutdown(); assert.equal(service.shutdown(), stopped);
  assert.throws(() => inner.withApplyLock("same", async () => {}), { code: "INVALID_STATE_TRANSITION" });
  let drained = false; void stopped.then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); assert.equal(await active, "applied"); await queuedRejected; await stopped;
  assert.equal(queuedRan, false);
});

test("concurrent read-only Git in the same workspace never inherits another request's write ownership", async () => {
  const children = [child(10001), child(10002)]; let count = 0;
  const { service, inner } = setup(() => children[count++]!);
  const started = deferred(), release = deferred();
  const write = inner.withApplyLock("same", async () => {
    inner.startGit("git", [], { cwd: "same" }); started.resolve(); await release.promise;
  });
  await started.promise;
  inner.startGit("git", [], { cwd: "same" });
  assert.notEqual(inner.gitProcesses.get(children[0]!)!.owner, undefined);
  assert.equal(inner.gitProcesses.get(children[1]!)!.owner, undefined);
  for (const item of children) item.emit("close", 0, null);
  release.resolve(); await write; await service.shutdown();
});

test("ended write context fences late preparation even while a new write owns the same workspace", async () => {
  const { service, inner } = setup(); const release = deferred(), nextStarted = deferred(), nextRelease = deferred();
  let late!: Promise<void>;
  await inner.withApplyLock("same", async () => {
    late = release.promise.then(() => { inner.gitOptions(); });
  }, true);
  const rejected = assert.rejects(late, { code: "WORKSPACE_PRECONDITION_FAILED" });
  const next = inner.withApplyLock("same", async () => { nextStarted.resolve(); await nextRelease.promise; inner.gitOptions(); });
  await nextStarted.promise; release.resolve(); await rejected; nextRelease.resolve(); await next;
  await service.shutdown();
});

test("close plus ESRCH releases ownership before an old runner KILL timer can signal a reused group", async t => {
  const item = child(10003), timers = new Map<number, () => void>(); let next = 0, groupExists = true;
  const clock: GitProcessTimers = {
    setTimeout(callback) { const id = ++next; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id as number); }
  };
  t.mock.method(process, "kill", (pid: number, signal: number) => {
    assert.equal(pid, -10003); assert.equal(signal, 0);
    if (!groupExists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const signals: string[] = [];
  const { service, inner } = setup(() => item, { timers: clock, platform: "linux", signaler: (_child, _platform, signal) => { signals.push(signal); } });
  const started = deferred();
  const write = inner.withApplyLock("same", async () => {
    const result = inner.gitResult("same", ["status"]); started.resolve(); return result;
  }, true);
  const rejected = assert.rejects(write, { code: "WORKSPACE_PRECONDITION_FAILED" });
  await started.promise; const stopped = service.shutdown();
  assert.deepEqual(signals, ["SIGTERM"]);
  groupExists = false; item.emit("exit", 0, null); item.emit("close", 0, null);
  assert.equal(inner.gitProcesses.size, 0);
  groupExists = true; // Simulate reuse after the irreversible ESRCH observation.
  assert.equal(timers.size, 1);
  for (const [id, callback] of timers) { timers.delete(id); callback(); }
  await rejected; await stopped;
  assert.deepEqual(signals, ["SIGTERM"]); assert.equal(timers.size, 0);
});
