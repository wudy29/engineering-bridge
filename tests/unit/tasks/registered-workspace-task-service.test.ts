import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { workspaceFixture } from "../../helpers/workspace-fixture.js";

import { CoreError } from "../../../src/core/errors.js";
import type { SerializedError } from "../../../src/core/errors.js";
import type { Id } from "../../../src/core/ids.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { CodexExecutor } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import type { ObservationWrite } from "../../../src/observability/observation-publisher.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = workspaceFixture("registered", "root");

function registry(): RegisteredWorkspaceRegistry {
  return new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function withoutDiagnostics<T extends object>(value: T): Omit<T, "diagnostics"> {
  const semantic = { ...value };
  Reflect.deleteProperty(semantic, "diagnostics");
  return semantic;
}


// Runs the real DshExecutor against a scripted child process, so interrupt
// tests observe the actual partial-stdout caching path.
function dshHarness(): {
  service: RegisteredWorkspaceTaskService;
  write: (chunk: string) => void;
  close: (code: number | null) => void;
} {
  let emitWrite: ((chunk: string) => void) | undefined;
  let emitClose: ((code: number | null) => void) | undefined;
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => {
    assert.equal(executor, "dsh");
    assert.equal(workspaceRoot, ROOT);
    return new DshExecutor(ROOT, () => {
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill(signal?: string) {
          this.killed = true;
          return true;
        }
      });
      emitWrite = (chunk) => { stdout.write(chunk); };
      emitClose = (code) => {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      };
      return child as unknown as ChildProcessWithoutNullStreams;
    });
  });
  return {
    service,
    write: (chunk) => emitWrite?.(chunk),
    close: (code) => emitClose?.(code)
  };
}

async function waitForTerminal(service: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (service.status(taskId)?.state === "queued" || service.status(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForInteractiveReady(service: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function explicitCodexService(starterCalls: { value: number }): RegisteredWorkspaceTaskService {
  const starter: ProcessStarter = () => {
    starterCalls.value += 1;
    throw new Error("Codex starter must not run");
  };
  return new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => {
    assert.equal(executor, "codex");
    return new CodexExecutor(workspaceRoot, starter, {}, process.platform, undefined, "explicit");
  });
}

test("returns immediately and exposes queued/running without a result", async () => {
  const pending = deferred<ExecutorResult>();
  const calls: ExecutorRequest[] = [];
  const executor: Executor = { execute: (request) => { calls.push(request); return pending.promise; } };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  assert.equal(service.result(taskId), undefined);
  await Promise.resolve();
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);
  assert.equal(calls[0]?.taskId, taskId);
  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
});

test("taskView polls a legacy runTask through completed output", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  assert.deepEqual(service.taskView(taskId), { taskId, state: "queued", executor: "codex", ready: false });
  await Promise.resolve();
  assert.deepEqual(service.taskView(taskId), { taskId, state: "running", executor: "codex", ready: false });

  pending.resolve({ kind: "completed", output: "proposal diff" });
  await waitForTerminal(service, taskId);

  assert.deepEqual(withoutDiagnostics(service.taskView(taskId)!), {
    taskId,
    state: "completed",
    executor: "codex",
    ready: true,
    output: "proposal diff"
  });
});

test("records completed output and preserves the instruction", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "exact output\n\n" }; }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const instruction = "  exact instruction\nwith bytes $()  ";
  const { taskId } = service.runTask({ workspace_id: "known", instruction });

  await waitForTerminal(service, taskId);

  assert.deepEqual(calls.map(({ onDiagnostics: _onDiagnostics, ...request }) => request), [{ taskId, instruction }]);
  assert.deepEqual(service.status(taskId), { taskId, state: "completed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "completed", output: "exact output\n\n" });
});

test("runTask applies explicit Codex routing at the executor boundary", async () => {
  const starterCalls = { value: 0 };
  const service = explicitCodexService(starterCalls);
  const { taskId } = service.runTask({
    workspace_id: "known",
    instruction: "inspect",
    reasoning_effort: "high"
  });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "CODEX_ROUTING_REQUIRED",
      message: "Explicit model and reasoning_effort are required for Codex execution."
    }
  });
  assert.equal(starterCalls.value, 0);
});

test("startTask applies explicit Codex routing at the executor boundary", async () => {
  const starterCalls = { value: 0 };
  const service = explicitCodexService(starterCalls);
  const { taskId } = service.startTask({
    workspace_id: "known",
    instruction: "inspect",
    model: "gpt-5-codex"
  });

  await waitForInteractiveReady(service, taskId);

  const view = service.taskView(taskId);
  assert.equal(view?.state, "failed");
  assert.deepEqual(view?.error, {
    code: "CODEX_ROUTING_REQUIRED",
    message: "Explicit model and reasoning_effort are required for Codex execution."
  });
  assert.equal(starterCalls.value, 0);
});

test("applies a completed-output transform exactly once before storing the result", async () => {
  let transforms = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "raw" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect" },
    (output) => { transforms += 1; return `${output}-transformed`; }
  );

  await waitForTerminal(service, taskId);

  assert.equal(transforms, 1);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "raw-transformed"
  });
  assert.equal(transforms, 1);
});

test("awaits a terminal handler exactly once before exposing completed output", async () => {
  const release = deferred<void>();
  const handlerStarted = deferred<void>();
  let handlerCalls = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect" },
    undefined,
    async (result) => {
      handlerCalls += 1;
      assert.equal(result.state, "completed");
      handlerStarted.resolve(undefined);
      await release.promise;
    }
  );

  await handlerStarted.promise;

  assert.equal(handlerCalls, 1);
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);

  release.resolve(undefined);
  await waitForTerminal(service, taskId);

  assert.equal(handlerCalls, 1);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "done"
  });
});

test("exposes finalization start/end timing around the terminal handler without bodies", async () => {
  const handlerStarted = deferred<void>();
  const releaseHandler = deferred<void>();
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "secret output" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "secret instruction" },
    undefined,
    async () => {
      handlerStarted.resolve();
      await releaseHandler.promise;
    }
  );

  await handlerStarted.promise;
  const beforeFinalization = service.taskView(taskId) as Record<string, unknown> | undefined;
  assert.equal(beforeFinalization?.state, "running");
  releaseHandler.resolve();
  await waitForTerminal(service, taskId);

  const view = service.taskView(taskId) as (Record<string, unknown> & {
    diagnostics?: Record<string, unknown>
  }) | undefined;
  const diagnostics = view?.diagnostics;
  assert.equal(typeof diagnostics?.finalization_started_at, "string");
  assert.equal(typeof diagnostics?.finalization_ended_at, "string");
  assert.equal("instruction" in (diagnostics ?? {}), false);
  assert.equal("output" in (diagnostics ?? {}), false);
  assert.equal("protocol" in (diagnostics ?? {}), false);
});

test("records INTERNAL_ERROR exactly once when a terminal handler throws", async () => {
  const release = deferred<void>();
  const handlerStarted = deferred<void>();
  let handlerCalls = 0;
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask(
    { workspace_id: "known", instruction: "inspect" },
    undefined,
    async (result) => {
      handlerCalls += 1;
      assert.deepEqual(result, { id: taskId, state: "completed", output: "done" });
      handlerStarted.resolve(undefined);
      await release.promise;
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
  );

  await handlerStarted.promise;

  assert.equal(handlerCalls, 1);
  assert.deepEqual(service.status(taskId), { taskId, state: "running" });
  assert.equal(service.result(taskId), undefined);

  release.resolve(undefined);
  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(withoutDiagnostics(service.taskView(taskId)!), {
    taskId,
    state: "failed",
    executor: "codex",
    ready: true,
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    }
  });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handlerCalls, 1);
});

test("records executor failures", async () => {
  const error: SerializedError = {
    code: "CODEX_EXECUTION_FAILED",
    message: "Codex execution failed."
  };
  const executor: Executor = { execute: async () => ({ kind: "failed", error }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), { id: taskId, state: "failed", error });
});

test("records an interrupted legacy task as TASK_INTERRUPTED, not an executor failure", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    },
    partial_output: "partial"
  });
});

test("records an interrupted DSH legacy task as TASK_INTERRUPTED, not DSH_EXECUTION_FAILED", async () => {
  let executorName: "codex" | "dsh" | undefined;
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    executorName = name;
    return executor;
  });
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  await waitForTerminal(service, taskId);

  assert.equal(executorName, "dsh");
  assert.deepEqual(service.status(taskId), { taskId, state: "failed" });
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    },
    partial_output: "partial"
  });
});

test("an interrupted legacy task without any partial output omits the field", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });

  await waitForTerminal(service, taskId);

  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("records an interrupted interactive task as TASK_INTERRUPTED without review output", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "codex",
    ready: true,
    evidence: [],
    partial_output: "partial",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

for (const path of ["legacy", "interactive"] as const) {
  test(`${path} task JSON retains safe pre-interrupt evidence and isolates the next task`, async () => {
    const started = deferred<void>();
    const observations: ObservationWrite[] = [];
    let executions = 0;
    const service = new RegisteredWorkspaceTaskService(registry(), (_name, workspaceRoot) => {
      const run = ++executions;
      const starter: ProcessStarter = () => {
        const child = new EventEmitter();
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
        const terminal = (status: string) => send({
          method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status } }
        });
        stdin.on("data", chunk => {
          const rpc = JSON.parse(chunk.toString()) as { id?: number; method: string };
          if (rpc.id === undefined) return;
          queueMicrotask(() => {
            send({ id: rpc.id, result: rpc.method === "thread/start" ? { thread: { id: "thread-1" } }
              : rpc.method === "turn/start" ? { turn: { id: "turn-1" } } : {} });
            if (rpc.method === "turn/interrupt") terminal("interrupted");
            if (rpc.method !== "turn/start") return;
            if (run !== 1) { terminal("completed"); return; }
            send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
            send({ method: "error", params: {
              threadId: "thread-1", turnId: "turn-1", willRetry: true,
              error: { message: "SYNTHETIC_PRIVATE_CANARY", data: "/private/SYNTHETIC_PRIVATE_CANARY" }
            } });
            send({ method: "item/completed", params: {
              threadId: "thread-1", turnId: "turn-1", item: { id: "partial", type: "agentMessage", text: "partial" }
            } });
            started.resolve();
          });
        });
        Object.assign(child, { stdin, stdout, stderr, kill: () => true });
        return child as unknown as ChildProcessWithoutNullStreams;
      };
      return new CodexExecutor(workspaceRoot, starter, { PATH: "", HOME: "" }, "linux");
    }, { publishObservation: observation => { observations.push(observation); } });
    const input = { workspace_id: "known", instruction: "inspect" };
    const { taskId } = path === "legacy" ? service.runTask(input) : service.startTask(input);
    await started.promise;
    const live = service.taskView(taskId)?.diagnostics;
    assert.ok(live && live.executor_started_at !== undefined);
    assert.equal(live.last_error_notification?.scope, "active_turn");
    await service.controlTask(taskId, "interrupt");
    if (path === "legacy") await waitForTerminal(service, taskId);
    else await waitForInteractiveReady(service, taskId);
    const view = service.taskView(taskId)!;
    const json = JSON.stringify(view);
    const decoded = JSON.parse(json) as typeof view;
    assert.equal(decoded.state, "failed");
    assert.equal(decoded.error?.code, "TASK_INTERRUPTED");
    assert.equal(decoded.partial_output, "partial");
    assert.equal(decoded.output, undefined);
    assert.equal(decoded.review_output, undefined);
    const retained = decoded.diagnostics;
    assert.ok(retained && retained.executor_started_at !== undefined);
    assert.equal(retained.last_valid_method, "turn/completed");
    assert.equal(retained.last_error_notification?.will_retry, true);
    assert.deepEqual(retained.interrupt_context?.last_error_notification, retained.last_error_notification);
    assert.equal(typeof retained.interrupt_context?.requested_at, "string");
    assert.doesNotMatch(json, /SYNTHETIC_PRIVATE_CANARY/);
    assert.doesNotMatch(JSON.stringify(observations), /last_error_notification|interrupt_context|SYNTHETIC_PRIVATE_CANARY/);
    const next = path === "legacy" ? service.runTask(input) : service.startTask(input);
    if (path === "legacy") await waitForTerminal(service, next.taskId);
    else await waitForInteractiveReady(service, next.taskId);
    const nextDiagnostics = service.taskView(next.taskId)?.diagnostics;
    assert.ok(nextDiagnostics && nextDiagnostics.executor_started_at !== undefined);
    assert.equal(nextDiagnostics.last_error_notification, undefined);
    assert.equal(nextDiagnostics.interrupt_context, undefined);
    assert.deepEqual(service.taskView(taskId)?.diagnostics, decoded.diagnostics);
  });
}

test("records an interrupted DSH interactive task as TASK_INTERRUPTED, not DSH_EXECUTION_FAILED", async () => {
  let executorName: "codex" | "dsh" | undefined;
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "partial" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    executorName = name;
    return executor;
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(executorName, "dsh");
  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    partial_output: "partial",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("an interrupted interactive task without any partial output omits the field", async () => {
  const executor: Executor = { execute: async () => ({ kind: "interrupted", output: "" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });
  await waitForInteractiveReady(service, taskId);

  const view = service.taskView(taskId);
  assert.ok(view);
  assert.equal(view.state, "failed");
  assert.equal("partial_output" in view, false);
  assert.deepEqual(view.error, {
    code: "TASK_INTERRUPTED",
    message: "The task was interrupted."
  });
});

test("failed and interrupted interactive results retain the latest executor diagnostics", async () => {
  const results: ExecutorResult[] = [
    {
      kind: "failed",
      error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." },
      diagnostics: {
        executor_started_at: "2026-08-27T01:02:03.004Z",
        executor_ended_at: "2026-08-27T01:02:04.005Z"
      }
    },
    {
      kind: "interrupted",
      output: "partial",
      diagnostics: {
        executor_started_at: "2026-08-27T01:02:03.004Z",
        executor_ended_at: "2026-08-27T01:02:04.005Z"
      }
    }
  ];

  for (const result of results) {
    let firstRun = true;
    const executor: Executor = {
      execute: async () => {
        if (!firstRun) return result;
        firstRun = false;
        return {
          kind: "completed",
          output: "review",
          diagnostics: {
            executor_started_at: "2026-08-27T01:02:01.002Z",
            executor_ended_at: "2026-08-27T01:02:02.003Z"
          }
        };
      }
    };
    const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
    const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

    await waitForInteractiveReady(service, taskId);
    await service.controlTask(taskId, "continue", "retry");
    await waitForInteractiveReady(service, taskId);

    const view = service.taskView(taskId);
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.diagnostics, result.diagnostics, result.kind);
  }
});

test("run_task interrupt reaches TASK_INTERRUPTED after bounded DSH TERM and KILL without close", async () => {
  const signals: string[] = [];
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => {
    assert.equal(executor, "dsh");
    assert.equal(workspaceRoot, ROOT);
    return new DshExecutor(ROOT, () => {
      const child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        killed: false,
        kill(signal?: string) {
          this.killed = true;
          signals.push(signal ?? "SIGTERM");
          return true;
        }
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }, {}, process.platform, {
      executionTimeoutMs: 100,
      interruptGraceMs: 10,
      killGraceMs: 10
    });
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const view = await service.controlTask(taskId, "interrupt");
  assert.equal(view.state, "running");
  assert.deepEqual(signals, ["SIGTERM"]);

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  assert.deepEqual(service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("DSH interrupt keeps the cached partial stdout as partial_output on the failed view", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  harness.write("partial answer");
  await harness.service.controlTask(taskId, "interrupt");
  harness.close(7);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(harness.service.taskView(taskId), {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    partial_output: "partial answer",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("DSH interrupt before any stdout omits partial_output", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await harness.service.controlTask(taskId, "interrupt");
  harness.close(0);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = harness.service.taskView(taskId);
  assert.ok(view);
  assert.equal("partial_output" in view, false);
  assert.deepEqual(view, {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("a DSH failure without interrupt exposes neither partial output nor stdout", async () => {
  const harness = dshHarness();
  const { taskId } = harness.service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (harness.service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  harness.write("secret partial");
  harness.close(7);

  while (harness.service.taskView(taskId)?.state === "queued" || harness.service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = harness.service.taskView(taskId);
  assert.ok(view);
  assert.deepEqual(view, {
    taskId,
    state: "failed",
    executor: "dsh",
    ready: true,
    evidence: [],
    error: {
      code: "DSH_EXECUTION_FAILED",
      message: "DSH execution failed."
    }
  });
  assert.equal(JSON.stringify(view).includes("secret partial"), false);
});

test("taskView exposes the native Codex thread id once one exists and keeps it after accept", async () => {
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output: "done", threadId: "thread-1" })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const view = service.taskView(taskId);
  assert.equal(view?.executor, "codex");
  assert.equal(view?.threadId, "thread-1");

  await service.controlTask(taskId, "accept");
  assert.equal(service.taskView(taskId)?.executor, "codex");
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("interactive taskView preserves executor diagnostics through supervisor accept", async () => {
  const executor: Executor = {
    execute: async () => ({
      kind: "completed",
      output: "done",
      diagnostics: {
        executor_started_at: "2026-08-27T01:02:03.004Z",
        executor_ended_at: "2026-08-27T01:02:04.005Z"
      }
    })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  await waitForInteractiveReady(service, taskId);

  const reviewView = service.taskView(taskId);
  assert.equal(reviewView?.state, "waiting_for_supervisor_review");
  assert.deepEqual(reviewView?.diagnostics, {
    executor_started_at: "2026-08-27T01:02:03.004Z",
    executor_ended_at: "2026-08-27T01:02:04.005Z"
  });

  await service.controlTask(taskId, "accept");

  const completedView = service.taskView(taskId);
  assert.equal(completedView?.state, "completed");
  assert.deepEqual(completedView?.diagnostics, {
    executor_started_at: "2026-08-27T01:02:03.004Z",
    executor_ended_at: "2026-08-27T01:02:04.005Z"
  });
});

test("continue preserves the same native Codex thread id and passes it to the resumed turn", async () => {
  const requests: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => {
      requests.push(request);
      return { kind: "completed", output: `out:${request.instruction}`, threadId: "thread-1" };
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "first" });
  await waitForInteractiveReady(service, taskId);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");

  await service.controlTask(taskId, "continue", "second");
  await waitForInteractiveReady(service, taskId);

  assert.deepEqual(requests.map(({ threadId }) => threadId), [undefined, "thread-1"]);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("DSH taskView reports executor dsh without fabricating a thread id, across continue", async () => {
  const executor: Executor = { execute: async () => ({ kind: "completed", output: "done" }) };
  const service = new RegisteredWorkspaceTaskService(registry(), (name) => {
    assert.equal(name, "dsh");
    return executor;
  });
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "first", executor: "dsh" });
  await waitForInteractiveReady(service, taskId);

  assert.equal(service.taskView(taskId)?.executor, "dsh");
  assert.equal(service.taskView(taskId)?.threadId, undefined);

  await service.controlTask(taskId, "continue", "second");
  await waitForInteractiveReady(service, taskId);

  assert.equal(service.taskView(taskId)?.executor, "dsh");
  assert.equal(service.taskView(taskId)?.threadId, undefined);
});

test("thread id is omitted while the native thread does not exist yet", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(taskId)?.executor, "codex");
  assert.equal(service.taskView(taskId)?.threadId, undefined);

  pending.resolve({ kind: "completed", output: "done", threadId: "thread-1" });
  await waitForInteractiveReady(service, taskId);
  assert.equal(service.taskView(taskId)?.threadId, "thread-1");
});

test("legacy controlled-patch taskView reports the fixed codex executor without a thread id", async () => {
  // The legacy runTask record stores the executor but never retains a thread
  // id, so the view must report only fields the record can prove.
  const executor: Executor = {
    execute: async () => ({ kind: "completed", output: "diff", threadId: "thread-9" })
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });
  await waitForTerminal(service, taskId);

  const view = service.taskView(taskId);
  assert.equal(view?.executor, "codex");
  assert.equal(view?.threadId, undefined);
});

test("interactive execution remains read-only when workspace writes are allowed", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => { calls.push(request); return { kind: "completed", output: "done" }; }
  };
  const writableRegistry = new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT, allow_write: true }
  ]);
  const service = new RegisteredWorkspaceTaskService(writableRegistry, () => executor);
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect" });

  while (service.taskView(taskId)?.state === "queued" || service.taskView(taskId)?.state === "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sandbox, "read-only");
});

test("normalizes and fixes the executor selection for each interactive task", async () => {
  const calls: Array<{
    executor: "codex" | "dsh";
    workspaceRoot: string;
    instruction: string;
  }> = [];
  const service = new RegisteredWorkspaceTaskService(registry(), (executor, workspaceRoot) => ({
    execute: async (request) => {
      calls.push({ executor, workspaceRoot, instruction: request.instruction });
      return { kind: "completed", output: `${executor}:${request.instruction}` };
    }
  }));

  const omitted = service.startTask({ workspace_id: "known", instruction: "default" });
  await waitForInteractiveReady(service, omitted.taskId);
  assert.equal(service.taskView(omitted.taskId)?.review_output, "codex:default");

  const explicitCodex = service.startTask({
    workspace_id: "known",
    instruction: "explicit",
    executor: "codex"
  });
  await waitForInteractiveReady(service, explicitCodex.taskId);
  assert.equal(service.taskView(explicitCodex.taskId)?.review_output, "codex:explicit");

  const dsh = service.startTask({
    workspace_id: "known",
    instruction: "first",
    executor: "dsh"
  });
  await waitForInteractiveReady(service, dsh.taskId);
  assert.equal(service.taskView(dsh.taskId)?.review_output, "dsh:first");

  await service.controlTask(dsh.taskId, "continue", "second");
  await waitForInteractiveReady(service, dsh.taskId);
  assert.equal(service.taskView(dsh.taskId)?.review_output, "dsh:second");

  await service.controlTask(dsh.taskId, "accept");
  assert.equal(service.taskView(dsh.taskId)?.output, "dsh:second");
  assert.deepEqual(calls, [
    { executor: "codex", workspaceRoot: ROOT, instruction: "default" },
    { executor: "codex", workspaceRoot: ROOT, instruction: "explicit" },
    { executor: "dsh", workspaceRoot: ROOT, instruction: "first" },
    { executor: "dsh", workspaceRoot: ROOT, instruction: "second" }
  ]);
});

test("forwards Codex model selection through legacy and interactive task paths", async () => {
  const calls: ExecutorRequest[] = [];
  const executor: Executor = {
    execute: async (request) => {
      calls.push(request);
      return { kind: "completed", output: "done" };
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const legacy = service.runTask({
    workspace_id: "known",
    instruction: "legacy",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  } as Parameters<RegisteredWorkspaceTaskService["runTask"]>[0] & {
    model: string;
    reasoning_effort: string;
  });
  await waitForTerminal(service, legacy.taskId);

  const interactive = service.startTask({
    workspace_id: "known",
    instruction: "interactive",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  } as Parameters<RegisteredWorkspaceTaskService["startTask"]>[0] & {
    model: string;
    reasoning_effort: string;
  });
  await waitForInteractiveReady(service, interactive.taskId);

  assert.deepEqual(calls.map((request) => {
    const selected = request as ExecutorRequest & { model?: string; reasoning_effort?: string };
    return {
      taskId: selected.taskId,
      instruction: selected.instruction,
      model: selected.model,
      reasoning_effort: selected.reasoning_effort
    };
  }), [
    { taskId: legacy.taskId, instruction: "legacy", model: "gpt-5-codex", reasoning_effort: "high" },
    { taskId: interactive.taskId, instruction: "interactive", model: "gpt-5-codex", reasoning_effort: "high" }
  ]);
});

test("rejects Codex-only selection fields for DSH tasks", () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({
    execute: async () => ({ kind: "completed", output: "unexpected" })
  }));

  assert.throws(() => service.runTask({
    workspace_id: "known",
    instruction: "inspect",
    executor: "dsh",
    model: "gpt-5-codex"
  } as Parameters<RegisteredWorkspaceTaskService["runTask"]>[0] & { model: string }), (error) =>
    error instanceof CoreError && error.code === "UNSUPPORTED_ACTION"
  );
  assert.throws(() => service.startTask({
    workspace_id: "known",
    instruction: "inspect",
    executor: "dsh",
    reasoning_effort: "high"
  } as Parameters<RegisteredWorkspaceTaskService["startTask"]>[0] & { reasoning_effort: string }), (error) =>
    error instanceof CoreError && error.code === "UNSUPPORTED_ACTION"
  );
});

test("records an unknown workspace asynchronously without creating an executor", async () => {
  let factories = 0;
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error("must not run");
  });
  const { taskId } = service.runTask({ workspace_id: "unknown", instruction: "inspect" });

  assert.deepEqual(service.status(taskId), { taskId, state: "queued" });
  await waitForTerminal(service, taskId);

  assert.equal(factories, 0);
  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "UNKNOWN_WORKSPACE",
      message: "The requested workspace is not registered."
    }
  });
});

test("returns undefined for invalid and unknown task ids", () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("must not run");
  });

  for (const taskId of [undefined, null, "invalid", "00000000-0000-4000-8000-000000000000"]) {
    assert.equal(service.status(taskId), undefined);
    assert.equal(service.result(taskId), undefined);
  }
});

test("only exposes supported states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = { execute: () => pending.promise };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });
  const states = new Set<string>();

  states.add(service.status(taskId)!.state);

  await Promise.resolve();
  states.add(service.status(taskId)!.state);

  pending.resolve({ kind: "completed", output: "done" });
  await waitForTerminal(service, taskId);
  states.add(service.status(taskId)!.state);

  for (const state of states) assert.ok(["queued", "running", "completed", "failed"].includes(state));
});

test("retains only the newest 100 terminal records without evicting live task states", async () => {
  const pending = deferred<ExecutorResult>();
  const executor: Executor = {
    execute: async (request) => request.instruction === "hold"
      ? pending.promise
      : { kind: "completed", output: "done" }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);

  const queuedTaskId = "00000000-0000-4000-8000-000000000001";
  (service as unknown as { tasks: Map<string, { state: "queued" }> }).tasks.set(queuedTaskId, { state: "queued" });

  const { taskId: runningTaskId } = service.startTask({ workspace_id: "known", instruction: "hold" });
  while (service.taskView(runningTaskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(runningTaskId)?.state, "running");

  const { taskId: reviewTaskId } = service.startTask({ workspace_id: "known", instruction: "review" });
  while (["queued", "running"].includes(service.taskView(reviewTaskId)?.state ?? "")) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const legacyTaskIds = Array.from({ length: 101 }, () =>
    service.runTask({ workspace_id: "known", instruction: "legacy" }).taskId
  );
  await Promise.all(legacyTaskIds.map((taskId) => waitForTerminal(service, taskId)));
  assert.equal(service.status(legacyTaskIds[0]!), undefined);
  for (const taskId of legacyTaskIds.slice(1)) assert.equal(service.status(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");

  const interactiveTaskIds: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    const { taskId } = service.startTask({ workspace_id: "known", instruction: "interactive" });
    while (["queued", "running"].includes(service.taskView(taskId)?.state ?? "")) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await service.controlTask(taskId, "accept");
    interactiveTaskIds.push(taskId);
  }

  assert.equal(service.taskView(interactiveTaskIds[0]!), undefined);
  for (const taskId of interactiveTaskIds.slice(1)) assert.equal(service.taskView(taskId)?.state, "completed");
  assert.equal(service.status(queuedTaskId)?.state, "queued");
  assert.equal(service.taskView(runningTaskId)?.state, "running");
  assert.equal(service.taskView(reviewTaskId)?.state, "waiting_for_supervisor_review");
});

test("restoreControlledPatchTask honors an explicit dsh executor and defaults legacy restores to codex", async () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("restored tasks must not execute");
  });
  const dshId = "00000000-0000-4000-8000-000000000001" as Id;
  const codexId = "00000000-0000-4000-8000-000000000002" as Id;
  service.restoreControlledPatchTask(dshId, "dsh output", true, "dsh");
  service.restoreControlledPatchTask(codexId, "codex output", false);

  assert.deepEqual(service.taskView(dshId), {
    taskId: dshId,
    state: "completed",
    executor: "dsh",
    ready: true,
    output: "dsh output"
  });
  assert.deepEqual(service.taskView(codexId), {
    taskId: codexId,
    state: "completed",
    executor: "codex",
    ready: true,
    output: "codex output"
  });
});

test("bulk controlled-patch restore validates the complete batch before installing any task", () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("restored tasks must not execute");
  });
  const existingId = "00000000-0000-4000-8000-000000000001" as Id;
  const freshId = "00000000-0000-4000-8000-000000000002" as Id;
  service.restoreControlledPatchTask(existingId, "existing output", true, "codex");

  assert.throws(
    () => service.restoreControlledPatchTasks([
      {
        result: { id: freshId, state: "completed", output: "fresh output" },
        pinned: true,
        executor: "dsh"
      },
      {
        result: {
          id: existingId,
          state: "failed",
          error: { code: "APPLY_RECOVERY_CONFLICT", message: "conflict" }
        },
        pinned: false,
        executor: "codex"
      }
    ]),
    (error: unknown) => error instanceof CoreError && error.code === "INTERNAL_ERROR"
  );

  assert.equal(service.taskView(freshId), undefined);
  assert.equal(service.result(freshId), undefined);
  assert.deepEqual(service.taskView(existingId), {
    taskId: existingId,
    state: "completed",
    executor: "codex",
    ready: true,
    output: "existing output"
  });
});

test("control_task interrupt reaches a running legacy task's executor seam and finalizes as TASK_INTERRUPTED", async () => {
  let release!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { release = done; });
  let interrupts = 0;
  const executor: Executor = {
    execute: () => pending,
    interrupt: async () => { interrupts += 1; release({ kind: "interrupted", output: "partial diff" }); }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "generate" });

  while (service.status(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(service.status(taskId)?.state, "running");

  const view = await service.controlTask(taskId, "interrupt");
  assert.equal(view.state, "running");
  assert.equal(interrupts, 1);
  await waitForTerminal(service, taskId);

  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "failed",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    },
    partial_output: "partial diff"
  });
  assert.deepEqual(withoutDiagnostics(service.taskView(taskId)!), {
    taskId,
    state: "failed",
    executor: "codex",
    ready: true,
    partial_output: "partial diff",
    error: {
      code: "TASK_INTERRUPTED",
      message: "The task was interrupted."
    }
  });
});

test("steer on a running DSH legacy task is unsupported; Codex keeps its steer seam", async () => {
  const steers: string[] = [];
  const releases: Array<(result: ExecutorResult) => void> = [];
  const executorNames: string[] = [];
  const reg = registry();
  const service = new RegisteredWorkspaceTaskService(reg, (executorName) => {
    executorNames.push(executorName);
    const execute = () => new Promise<ExecutorResult>((done) => { releases.push(done); });
    return executorName === "dsh"
      ? { execute }
      : { execute, steer: async (instruction) => { steers.push(instruction); } };
  });

  const dsh = service.runTask({ workspace_id: "known", instruction: "generate", executor: "dsh" });
  while (service.status(dsh.taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await assert.rejects(
    () => service.controlTask(dsh.taskId, "steer", "keep going"),
    (error: unknown) => error instanceof CoreError && error.code === "UNSUPPORTED_ACTION"
  );
  releases[0]?.({ kind: "completed", output: "dsh done" });
  await waitForTerminal(service, dsh.taskId);

  const codex = service.runTask({ workspace_id: "known", instruction: "generate" });
  while (service.status(codex.taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const view = await service.controlTask(codex.taskId, "steer", "keep going");
  assert.equal(view.state, "running");
  assert.deepEqual(steers, ["keep going"]);
  releases[1]?.({ kind: "completed", output: "codex done" });
  await waitForTerminal(service, codex.taskId);

  assert.deepEqual(executorNames, ["dsh", "codex"]);
});

test("steer on a running DSH interactive task is unsupported, not an invalid state transition", async () => {
  let release!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { release = done; });
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({ execute: () => pending }));
  const { taskId } = service.startTask({ workspace_id: "known", instruction: "inspect", executor: "dsh" });

  while (service.taskView(taskId)?.state === "queued") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await assert.rejects(
    () => service.controlTask(taskId, "steer", "keep going"),
    (error: unknown) => error instanceof CoreError && error.code === "UNSUPPORTED_ACTION"
  );
  release({ kind: "completed", output: "done" });
  await waitForInteractiveReady(service, taskId);
});

test("restoreControlledPatchTask with submitted provenance reports no executor identity", async () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("restored tasks must not execute");
  });
  const submittedId = "00000000-0000-4000-8000-000000000003" as Id;
  service.restoreControlledPatchTask(submittedId, "submitted diff", true, undefined, "submitted");

  assert.deepEqual(service.taskView(submittedId), {
    taskId: submittedId,
    state: "completed",
    source: "submitted",
    ready: true,
    output: "submitted diff"
  });
  assert.equal(service.taskView(submittedId)?.executor, undefined);
  assert.equal("executor" in (service.taskView(submittedId) ?? {}), false);
  const serialized = JSON.stringify(service.taskView(submittedId));
  assert.equal(serialized.includes('"source":"submitted"'), true);
  assert.equal(serialized.includes("executor"), false);
});

test("submitControlledPatchTask registers a retained completed task with submitted provenance", async () => {
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    throw new Error("submitted tasks must not execute");
  });
  const { taskId } = service.submitControlledPatchTask("caller diff", true);

  assert.deepEqual(service.result(taskId), {
    id: taskId,
    state: "completed",
    output: "caller diff"
  });
  const view = service.taskView(taskId);
  assert.equal(view?.source, "submitted");
  assert.equal(view?.executor, undefined);
  assert.equal("executor" in (view ?? {}), false);
  assert.equal(view?.state, "completed");
});


for (const path of ["legacy", "interactive"] as const) {
  test(`${path} task views expose live executor phase diagnostics while running`, async () => {
    const pending = deferred<ExecutorResult>();
    let runningRequest: ExecutorRequest | undefined;
    const executor: Executor = {
      execute: (request) => { runningRequest = request; return pending.promise; }
    };
    const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
    const request = { workspace_id: "known", instruction: "inspect" };
    const { taskId } = path === "legacy" ? service.runTask(request) : service.startTask(request);
    await Promise.resolve();
    const progress = {
      executor_started_at: "2026-09-07T01:02:03.004Z",
      protocol_phase: "initialize",
      rpc_method: "initialize",
      last_activity_at: "2026-09-07T01:02:03.004Z"
    };
    runningRequest?.onDiagnostics?.(progress);
    try {
      const view = service.taskView(taskId);
      assert.equal(view?.state, "running");
      assert.equal(view?.ready, false);
      assert.deepEqual(view?.diagnostics, progress);
      assert.equal("executor_ended_at" in (view?.diagnostics ?? {}), false);
      assert.equal(service.result(taskId), undefined);
    } finally {
      pending.resolve({ kind: "completed", output: "done" });
      if (path === "legacy") await waitForTerminal(service, taskId);
      else await waitForInteractiveReady(service, taskId);
    }
  });
}

for (const kind of ["completed", "failed", "interrupted"] as const) {
  test(`legacy ${kind} task retains executor diagnostics alongside finalization times`, async () => {
    const diagnostics = {
      executor_started_at: "2026-09-07T01:02:03.004Z",
      executor_ended_at: "2026-09-07T01:02:04.005Z",
      protocol_phase: "turn/start",
      rpc_method: "turn/start",
      rpc_timeout: kind === "failed",
      last_activity_at: "2026-09-07T01:02:03.500Z"
    };
    const result: ExecutorResult = kind === "failed"
      ? { kind, error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }, diagnostics }
      : { kind, output: "output", diagnostics };
    const executor: Executor = { execute: async () => result };
    const service = new RegisteredWorkspaceTaskService(registry(), () => executor);
    const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });
    await waitForTerminal(service, taskId);
    const view = service.taskView(taskId);
    const { finalization_started_at, finalization_ended_at, ...retained } = view?.diagnostics ?? {};
    assert.deepEqual(retained, diagnostics);
    assert.equal(typeof finalization_started_at, "string");
    assert.equal(typeof finalization_ended_at, "string");
    assert.equal(view?.state, kind === "completed" ? "completed" : "failed");
  });
}

test("interactive observations follow authoritative lifecycle, diagnostics, continuation and acceptance", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-21T00:00:00Z") });
  const seen: ObservationWrite[] = [];
  const turns = [deferred<ExecutorResult>(), deferred<ExecutorResult>()];
  const requests: ExecutorRequest[] = [];
  const executor: Executor = {
    execute(request) { requests.push(request); return turns[requests.length - 1]!.promise; },
    steer: async () => {},
    interrupt: async () => {}
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => executor, {
    publishObservation: observation => { seen.push(observation); }
  });
  const { taskId } = service.startTask({
    workspace_id: "known", instruction: "private instruction",
    model: "requested-model", reasoning_effort: "high"
  });
  const initial = {
    task_id: taskId, state: "queued", executor: "codex",
    workspace_id: "known", workspace_display_name: "root",
    requested_model: "requested-model", requested_reasoning_effort: "high",
    created_at: "2026-09-21T00:00:00.000Z", started_at: null, ended_at: null
  };
  assert.deepEqual(seen, [{ kind: "task", record_id: taskId, metadata: initial }]);

  t.mock.timers.tick(1000);
  await Promise.resolve();
  const running = { ...initial, state: "running", started_at: "2026-09-21T00:00:01.000Z" };
  assert.deepEqual(seen[1]!.metadata, running);
  const progress = {
    executor_started_at: "2026-09-21T00:00:01.000Z",
    last_activity_at: "2026-09-21T00:00:02.000Z",
    protocol_phase: "turn/start", upstream_error_message: "private upstream detail",
    last_error_notification: Object.freeze({
      observed_at: "2026-09-21T00:00:02.000Z", scope: "active_turn" as const, will_retry: true
    })
  };
  t.mock.timers.tick(1000);
  requests[0]!.onDiagnostics!(progress);
  assert.deepEqual(service.taskView(taskId)?.diagnostics, progress);
  assert.equal(service.taskView(taskId)?.state, "running");
  assert.deepEqual(seen[2]!.metadata, {
    ...running, last_reported_activity_at: progress.last_activity_at
  });
  assert.equal(service.result(taskId), undefined);
  await service.controlTask(taskId, "steer", "private steer");
  await service.controlTask(taskId, "interrupt");
  assert.equal(seen.length, 3, "control requests alone do not fabricate transitions");

  t.mock.timers.tick(1000);
  const diagnostics = {
    ...progress, executor_ended_at: "2026-09-21T00:00:03.000Z",
    last_activity_at: "2026-09-21T00:00:03.000Z"
  };
  turns[0]!.resolve({
    kind: "completed", output: "private review output", threadId: "native-thread",
    diagnostics, evidence: [{ id: "e", type: "commandExecution", status: "completed", command: "private command" }]
  });
  await waitForInteractiveReady(service, taskId);
  const review = {
    ...running, state: "waiting_for_supervisor_review", thread_id: "native-thread",
    last_reported_activity_at: diagnostics.last_activity_at
  };
  assert.deepEqual(seen[3]!.metadata, review);
  assert.equal(service.taskView(taskId)?.review_output, "private review output");
  assert.equal(service.taskView(taskId)?.output, undefined);

  t.mock.timers.tick(1000);
  const continuing = service.controlTask(taskId, "continue", "private continuation");
  assert.equal(service.taskView(taskId)?.diagnostics, undefined);
  assert.deepEqual(seen[4]!.metadata, {
    ...running, state: "queued", thread_id: "native-thread"
  });
  await continuing;
  assert.deepEqual(seen[5]!.metadata, { ...running, thread_id: "native-thread" });
  assert.equal(requests[1]!.threadId, "native-thread");

  t.mock.timers.tick(1000);
  turns[1]!.resolve({ kind: "completed", output: "final output" });
  await waitForInteractiveReady(service, taskId);
  assert.deepEqual(seen[6]!.metadata, {
    ...running, state: "waiting_for_supervisor_review", thread_id: "native-thread"
  });
  t.mock.timers.tick(1000);
  await service.controlTask(taskId, "accept");
  assert.deepEqual(seen[7]!.metadata, {
    ...running, state: "completed", thread_id: "native-thread",
    ended_at: "2026-09-21T00:00:06.000Z"
  });
  assert.equal(service.taskView(taskId)?.output, "final output");
  assert.equal(service.taskView(taskId)?.diagnostics, undefined);
  assert.deepEqual(seen.map(x => x.metadata.state), [
    "queued", "running", "running", "waiting_for_supervisor_review",
    "queued", "running", "waiting_for_supervisor_review", "completed"
  ]);
  for (const snapshot of seen) {
    assert.equal(snapshot.kind, "task");
    assert.equal(snapshot.record_id, taskId);
    assert.equal(snapshot.metadata.created_at, initial.created_at);
  }
  assert.deepEqual(seen[0]!.metadata, initial, "earlier snapshots are not mutated");
});

for (const outcome of ["completed", "failed", "interrupted", "catch"] as const) {
  test(`interactive ${outcome} observations survive a throwing publisher and omit unavailable DSH fields`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-21T01:00:00Z") });
    const pending = deferred<ExecutorResult>();
    const seen: ObservationWrite[] = [];
    const service = new RegisteredWorkspaceTaskService(registry(), () => ({
      async execute() {
        const result = await pending.promise;
        if (outcome === "catch") throw new Error("private upstream exception");
        return result;
      }
    }), {
      publishObservation(observation) {
        seen.push(observation);
        throw new Error("observation unavailable");
      }
    });
    const { taskId } = service.startTask({
      workspace_id: "known", instruction: "private instruction", executor: "dsh"
    });
    t.mock.timers.tick(1000);
    await Promise.resolve();
    t.mock.timers.tick(1000);
    pending.resolve(outcome === "failed"
      ? { kind: "failed", error: { code: "DSH_EXECUTION_FAILED", message: "private upstream error" } }
      : { kind: outcome === "interrupted" ? "interrupted" : "completed", output: "private output" });
    await waitForInteractiveReady(service, taskId);
    const state = outcome === "completed" ? "waiting_for_supervisor_review" : "failed";
    assert.equal(service.taskView(taskId)?.state, state);
    const safeError = outcome === "completed" ? undefined
      : outcome === "failed" ? { code: "DSH_EXECUTION_FAILED", message: "DSH execution failed." }
      : outcome === "interrupted" ? { code: "TASK_INTERRUPTED", message: "The task was interrupted." }
      : { code: "INTERNAL_ERROR", message: "The request could not be completed." };
    const base = {
      task_id: taskId, executor: "dsh", requested_model: null, requested_reasoning_effort: null,
      workspace_id: "known", workspace_display_name: "root",
      created_at: "2026-09-21T01:00:00.000Z"
    };
    assert.deepEqual(seen.map(x => x.metadata), [
      { ...base, state: "queued", started_at: null, ended_at: null },
      { ...base, state: "running", started_at: "2026-09-21T01:00:01.000Z", ended_at: null },
      {
        ...base, state, started_at: "2026-09-21T01:00:01.000Z",
        ended_at: safeError ? "2026-09-21T01:00:02.000Z" : null,
        ...(safeError ? { error_code: safeError.code, error_summary: safeError.message } : {})
      }
    ]);
    if (outcome === "completed") {
      assert.equal(service.taskView(taskId)?.review_output, "private output");
      await service.controlTask(taskId, "accept");
      assert.equal(service.taskView(taskId)?.state, "completed");
      assert.equal(service.taskView(taskId)?.output, "private output");
      assert.equal(seen[3]!.metadata.ended_at, "2026-09-21T01:00:02.000Z");
    } else {
      assert.equal(service.taskView(taskId)?.error?.code, safeError!.code);
      assert.equal(service.taskView(taskId)?.partial_output, outcome === "interrupted" ? "private output" : undefined);
    }
    for (const snapshot of seen) {
      assert.equal(snapshot.kind, "task");
      assert.equal(snapshot.record_id, taskId);
    }
  });
}

test("legacy and submitted patch tasks do not publish interactive task observations", async () => {
  const seen: ObservationWrite[] = [];
  const service = new RegisteredWorkspaceTaskService(registry(), () => ({
    execute: async () => ({ kind: "completed", output: "legacy output" })
  }), { publishObservation: observation => { seen.push(observation); } });
  const { taskId } = service.runTask({ workspace_id: "known", instruction: "inspect" });
  await waitForTerminal(service, taskId);
  service.submitControlledPatchTask("private diff", true);
  assert.deepEqual(seen, []);
});

test("explicit Dashboard identity is published without workspace paths or execution payloads", async () => {
  const entries = [{ id: "known", root: ROOT, display_name: "Engineering Bridge" }];
  const seen: ObservationWrite[] = [];
  const service = new RegisteredWorkspaceTaskService(new RegisteredWorkspaceRegistry(entries), () => ({
    execute: async request => {
      assert.equal("dashboard_title" in request, false, "the executor contract is unchanged");
      request.onDiagnostics?.({ executor_started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), upstream_error_message: "PRIVATE_DIAGNOSTIC" });
      return { kind: "completed", output: "PRIVATE_OUTPUT", evidence: [{ id: "e", type: "commandExecution", status: "completed", command: "PRIVATE_EVIDENCE" }] };
    }
  }), { publishObservation: value => { seen.push(value); } });
  const request = { workspace_id: "known", instruction: "PRIVATE_INSTRUCTION", dashboard_title: "Dashboard V0 Slice 3" };
  const { taskId } = service.startTask(request);
  await waitForInteractiveReady(service, taskId);
  await service.controlTask(taskId, "continue", "PRIVATE_CONTINUATION");
  await waitForInteractiveReady(service, taskId);
  await service.controlTask(taskId, "accept");
  for (const value of seen) {
    assert.equal(value.metadata.workspace_id, "known");
    assert.equal(value.metadata.workspace_display_name, "Engineering Bridge");
    assert.equal(value.metadata.dashboard_title, "Dashboard V0 Slice 3");
  }
  assert.equal(JSON.stringify(seen).includes(ROOT), false);
  assert.doesNotMatch(JSON.stringify(seen), /PRIVATE_|instruction|output|evidence|diagnostics/);
});

test("invalid explicit Dashboard titles are rejected before execution or observation", () => {
  let executions = 0;
  const seen: ObservationWrite[] = [];
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    executions++;
    return { execute: async () => ({ kind: "completed", output: "unused" }) };
  }, { publishObservation: value => { seen.push(value); } });
  for (const dashboard_title of ["", " ", "a\nb", "a\rb", "a\tb", "a\u2028b", "x".repeat(101)]) {
    const request = { workspace_id: "known", instruction: "private instruction", dashboard_title };
    assert.throws(() => service.startTask(request));
    assert.throws(() => service.runTask(request));
  }
  assert.equal(executions, 0);
  assert.deepEqual(seen, []);
});
