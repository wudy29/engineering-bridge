import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import type { SerializedError } from "../../../src/core/errors.js";
import type { Id } from "../../../src/core/ids.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";
import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

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
