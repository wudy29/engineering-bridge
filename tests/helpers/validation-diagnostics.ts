// Test-only preload. Keep observations in memory; flush outside the run store,
// after a terminal GET or at process exit. Never change a product outcome.
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { nowMilliseconds } from "../../src/tasks/validation-deadline.js";

const filename = process.env.BRIDGE_TEST_TRACE;
if (!filename) throw new Error("diagnostic preload requires a private trace path");
const events: Record<string, unknown>[] = [];
const note = (event: string, data: Record<string, unknown> = {}) => {
  events.push({ event, ms: Number(process.hrtime.bigint()) / 1e6, ...data });
};
const errorInfo = (error: unknown) => error instanceof Error
  ? { message: error.message, code: (error as NodeJS.ErrnoException).code } : String(error);
const flush = () => writeFileSync(filename, JSON.stringify({ pid: process.pid, events }, (_, value) =>
  typeof value === "bigint" ? value.toString() : value));
const spawn = childProcess.spawn;
childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args);
  note("spawn", { pid: child.pid, executable: args[0], argv: args[1] });
  child.on("spawn", () => note("spawn-ready", { pid: child.pid }));
  child.on("error", error => note("child-error", { pid: child.pid, error: errorInfo(error) }));
  child.on("exit", (code, signal) => note("exit", { pid: child.pid, code, signal }));
  child.on("close", (code, signal) => note("close", { pid: child.pid, code, signal }));
  child.stdin?.on("error", error => note("stdin-error", { pid: child.pid, error: errorInfo(error) }));
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
const kill = process.kill, gone = new Set<number>();
process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
  try {
    const result = kill(pid, signal);
    if (signal !== 0) note("signal", { pid, signal });
    return result;
  } catch (error) {
    if (signal !== 0 || !gone.has(pid)) note("signal-error", { pid, signal, error: errorInfo(error) });
    if ((error as NodeJS.ErrnoException).code === "ESRCH") gone.add(pid);
    throw error;
  }
}) as typeof kill;

// These are the same module instances loaded by the real STDIO entry point.
const { ValidationRunOwner } = await import("../../src/tasks/validation-run-owner.js");
const acquire = ValidationRunOwner.acquire;
ValidationRunOwner.acquire = async function (...args) {
  note("owner-acquire");
  try {
    const owner = await acquire.apply(this, args); note("owner-acquired", { instance: owner.instanceId });
    const release = owner.release.bind(owner);
    owner.release = async () => { note("owner-release"); await release(); note("owner-released"); };
    return owner;
  } catch (error) { note("owner-refused", { error: errorInfo(error) }); throw error; }
};
const { ValidationProcessRunner } = await import("../../src/tasks/validation-process-runner.js");
const run = ValidationProcessRunner.prototype.runSupervised;
ValidationProcessRunner.prototype.runSupervised = async function (request, control) {
  const started = nowMilliseconds();
  note("operation-start", { argv: request.argv, inputBytes: request.input === undefined ? null : Buffer.byteLength(request.input),
    timeoutMs: request.timeoutMs, timerNowMs: started, observedDeadlineMs: started + BigInt(request.timeoutMs) });
  const abort = () => note("operation-abort"); control.signal.addEventListener("abort", abort, { once: true });
  try { const result = await run.call(this, request, control); note("operation-result", { ...result }); return result; }
  catch (error) { note("operation-error", { error: errorInfo(error) }); throw error; }
  finally { control.signal.removeEventListener("abort", abort); }
};
const { ControlledPatchValidationRunService } = await import("../../src/tasks/controlled-patch-validation-run-service.js");
// TS-private methods are wrapped only in this diagnostic child, never shipped.
const prototype = ControlledPatchValidationRunService.prototype as unknown as Record<string, (...args: any[]) => Promise<any>>;
for (const name of ["checkpoint", "operation", "cleanup", "shutdown"]) {
  const original = prototype[name]!;
  prototype[name] = async function (...args) {
    const active = args[0], ms = nowMilliseconds();
    const totalDeadline = active?.deadlineMs;
    const effectiveDeadline = name === "operation" ? args[5] ?? totalDeadline : undefined;
    note("service-" + name + "-start", { phase: active?.run?.phase, sequence: active?.run?.operation_sequence,
      checkpointEvent: name === "checkpoint" ? args[1] : undefined,
      kind: name === "operation" ? args[1] : undefined, stopReason: active?.stopReason,
      shutdownReason: name === "shutdown" ? args[0] : undefined,
      timerNowMs: ms,
      totalRemainingMs: typeof totalDeadline === "bigint" ? totalDeadline - ms : undefined,
      effectiveRemainingMs: typeof effectiveDeadline === "bigint" ? effectiveDeadline - ms : undefined });
    try { const result = await original.apply(this, args); note("service-" + name + "-end"); return result; }
    catch (error) { note("service-" + name + "-error", { error: errorInfo(error) }); throw error; }
  };
}
const get = ControlledPatchValidationRunService.prototype.get;
ControlledPatchValidationRunService.prototype.get = async function (id) {
  try {
    const result = await get.call(this, id);
    if (result?.state === "terminal") { note("terminal-get", { id, status: result.status, reason: result.reason }); flush(); }
    return result;
  } catch (error) { note("get-error", { error: errorInfo(error) }); flush(); throw error; }
};
const { ValidationRunWorktree } = await import("../../src/tasks/validation-run-worktree.js");
const cleanup = ValidationRunWorktree.prototype.cleanup;
ValidationRunWorktree.prototype.cleanup = async function (...args) {
  try { return await cleanup.apply(this, args); }
  catch (error) { note("worktree-cleanup-error", { error: errorInfo(error) }); throw error; }
};
process.on("exit", code => { note("bridge-exit", { code }); flush(); });
