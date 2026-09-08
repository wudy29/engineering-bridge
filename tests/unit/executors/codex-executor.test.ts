import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { isId } from "../../../src/core/ids.js";
import { CodexExecutor } from "../../../src/executors/codex-executor.js";
import type { ProcessStarter } from "../../../src/executors/codex-executor.js";
import type { ExecutorEvidence } from "../../../src/executors/executor.js";
import { VERSION } from "../../../src/version.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";
const SHORT_TIMING = {
  executionTimeoutMs: 30,
  interruptGraceMs: 10,
  killGraceMs: 10,
  protocolInactivityTimeoutMs: 25,
  rpcCallTimeoutMs: 25
};

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: string;
  signals: string[];
  send(message: unknown): void;
  writeStdout(text: string): void;
  error(): void;
  exit(code: number | null): void;
  close(code: number | null): void;
}

interface FakeBehavior {
  appServerOutput?: string;
  turnError?: { message: string; codexErrorInfo?: string; additionalDetails?: string };
  modelList?: readonly { id: string; model: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: readonly { reasoningEffort: string; description: string }[] }[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
  autoComplete?: boolean;
  hold?: boolean;
  ignoredMethods?: readonly string[];
  pid?: number;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): ProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = {
      executable, args: [...args], options, stdin: "", signals: [],
      send(message) { stdout.write(`${JSON.stringify(message)}\n`); },
      writeStdout(text) { stdout.write(text); },
      error() { child.emit("error", new Error("late child error")); },
      exit(code) { child.emit("exit", code, null); },
      close(code) {
        stdout.end();
        stderr.end();
        setImmediate(() => child.emit("close", code, null));
      }
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        invocation.stdin += chunk.toString();
        if (behavior.appServerOutput !== undefined) {
          const message = JSON.parse(chunk.toString()) as { id?: number; method: string };
          if (message.id !== undefined) {
            if (behavior.ignoredMethods?.includes(message.method)) {
              callback();
              return;
            }
            let result: unknown = {};
            if (message.method === "model/list") {
              result = { data: behavior.modelList ?? [] };
            }
            if (message.method === "thread/start") result = { thread: { id: "thread-1" } };
            if (message.method === "turn/start") result = { turn: { id: "turn-1" } };
            queueMicrotask(() => {
              stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
              if (message.method === "turn/start" && behavior.autoComplete !== false) {
                stdout.write(`${JSON.stringify({
                  method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } }
                })}\n`);
                stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: behavior.appServerOutput } } })}\n`);
                const status = behavior.turnError ? "failed" : "completed";
                stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status, error: behavior.turnError } } })}\n`);
              }
            });
          }
        }
        callback();
      }
    });
    invocations.push(invocation);
    Object.assign(child, {
      stdin, stdout, stderr, killed: false, pid: behavior.pid,
      kill(signal?: string) {
        this.killed = true;
        invocation.signals.push(signal ?? "SIGTERM");
        return true;
      }
    });

    queueMicrotask(() => {
      if (behavior.appServerOutput !== undefined) return;
      if (behavior.hold === true) return;
      if (behavior.processError === true) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      stdout.end(behavior.stdout ?? "");
      stderr.end(behavior.stderr ?? "");
      setImmediate(() => child.emit("close", behavior.exitCode ?? 0, null));
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

function timedExecutor(starter: ProcessStarter, platform: NodeJS.Platform = process.platform,
  timing = SHORT_TIMING): CodexExecutor {
  return new CodexExecutor(TRUSTED_CWD, starter, {}, platform, timing);
}

function executorWithRoutingPolicy(
  starter: ProcessStarter,
  routingPolicy: "inherit" | "explicit",
  hostEnvironment: NodeJS.ProcessEnv = {}
): CodexExecutor {
  return new CodexExecutor(TRUSTED_CWD, starter, hostEnvironment, process.platform, SHORT_TIMING, routingPolicy);
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("promise did not settle")), milliseconds);
    })
  ]);
}

function withoutDiagnostics<T extends object>(value: T): Omit<T, "diagnostics"> {
  const semantic = { ...value };
  Reflect.deleteProperty(semantic, "diagnostics");
  return semantic;
}

test("uses the fixed safe invocation and returns agent text", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/bin",
    HOME: "/home/test",
    CODEX_HOME: "/codex/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    OPENAI_API_KEY: "secret-api-key",
    HTTP_PROXY: "secret-proxy",
    SSH_AUTH_SOCK: "secret-ssh",
    EMPTY_ALLOWED: ""
  };
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "final answer"
  }, invocations), hostEnvironment);
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  const result = await executor.execute({ taskId: TASK_ID, instruction });
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "final answer");
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/codex/test", TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8", LC_ALL: "C", USER: "tester", LOGNAME: "tester-log"
  });
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages[0], { id: 1, method: "initialize", params: { clientInfo: { name: "engineering-bridge", version: VERSION } } });
  assert.deepEqual(messages[1], { method: "initialized", params: {} });
  assert.deepEqual(messages[2], { id: 2, method: "thread/start", params: { cwd: TRUSTED_CWD, approvalPolicy: "never", sandbox: "read-only" } });
  assert.deepEqual(messages[3], { id: 3, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: instruction }], cwd: TRUSTED_CWD, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
  assert.equal(invocation.args.includes(instruction), false);
});

test("preserves the default Codex JSON-RPC flow when model selection is omitted", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ appServerOutput: "done" }, invocations));

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "completed");
  const messages = invocations[0]!.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.some((message: { method?: string }) => message.method === "model/list"), false);
  const turnStart = messages.find((message: { method?: string }) => message.method === "turn/start");
  assert.ok(turnStart);
  assert.equal("model" in turnStart.params, false);
  assert.equal("effort" in turnStart.params, false);
});

test("explicit routing rejects a missing model before starting Codex", async () => {
  const invocations: Invocation[] = [];
  const executor = executorWithRoutingPolicy(
    fakeStarter({ appServerOutput: "should not run" }, invocations),
    "explicit"
  );

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    reasoning_effort: "high"
  });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: {
      code: "CODEX_ROUTING_REQUIRED",
      message: "Explicit model and reasoning_effort are required for Codex execution."
    }
  });
  assert.equal(invocations.length, 0);
});

test("explicit routing rejects a missing reasoning effort before starting Codex", async () => {
  const invocations: Invocation[] = [];
  const executor = executorWithRoutingPolicy(
    fakeStarter({ appServerOutput: "should not run" }, invocations),
    "explicit"
  );

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "gpt-5-codex"
  });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROUTING_REQUIRED");
  assert.equal(invocations.length, 0);
});

test("explicit routing rejects both missing routing fields before starting Codex", async () => {
  const invocations: Invocation[] = [];
  const executor = executorWithRoutingPolicy(
    fakeStarter({ appServerOutput: "should not run" }, invocations),
    "explicit"
  );

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROUTING_REQUIRED");
  assert.equal(invocations.length, 0);
});

test("explicit routing rejects blank routing fields before starting Codex", async () => {
  const invocations: Invocation[] = [];
  const executor = executorWithRoutingPolicy(
    fakeStarter({ appServerOutput: "should not run" }, invocations),
    "explicit"
  );

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "   ",
    reasoning_effort: "high"
  });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.error.code, "CODEX_ROUTING_REQUIRED");
  assert.equal(invocations.length, 0);
});

test("explicit routing validates and propagates both routing fields", async () => {
  const invocations: Invocation[] = [];
  const executor = executorWithRoutingPolicy(
    fakeStarter({
      appServerOutput: "done",
      modelList: [{
        id: "catalog-id",
        model: "gpt-5-codex",
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }]
      }]
    }, invocations),
    "explicit",
    { ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY: "explicit" }
  );

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  });

  assert.equal(result.kind, "completed");
  assert.equal(invocations.length, 1);
  const invocation = invocations[0]!;
  assert.equal(invocation.options.env?.ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY, undefined);
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.some((message: { method?: string }) => message.method === "model/list"), true);
  const turnStart = messages.find((message: { method?: string }) => message.method === "turn/start");
  assert.deepEqual({ model: turnStart.params.model, effort: turnStart.params.effort }, {
    model: "gpt-5-codex",
    effort: "high"
  });
});

test("validates the requested model and effort before starting the normal Codex flow", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "done",
    modelList: [{
      id: "catalog-id",
      model: "gpt-5-codex",
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
        { reasoningEffort: "high", description: "High" }
      ]
    }]
  }, invocations));

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  } as Parameters<typeof executor.execute>[0] & { model: string; reasoning_effort: string });

  assert.equal(result.kind, "completed");
  const messages = invocations[0]!.stdin.trim().split("\n").map((line) => JSON.parse(line));
  const modelListIndex = messages.findIndex((message: { method?: string }) => message.method === "model/list");
  const threadStartIndex = messages.findIndex((message: { method?: string }) => message.method === "thread/start");
  const turnStartIndex = messages.findIndex((message: { method?: string }) => message.method === "turn/start");
  assert.equal(modelListIndex >= 0, true);
  assert.equal(modelListIndex < threadStartIndex, true);
  assert.equal(threadStartIndex < turnStartIndex, true);
  const turnStart = messages[turnStartIndex]!;
  assert.deepEqual(
    { model: turnStart.params.model, effort: turnStart.params.effort },
    { model: "gpt-5-codex", effort: "high" }
  );
});

test("rejects an unknown requested model before thread/start and turn/start", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "done",
    modelList: [{
      id: "catalog-id",
      model: "gpt-5-codex",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }]
    }]
  }, invocations));

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "unknown-model"
  } as Parameters<typeof executor.execute>[0] & { model: string });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: { code: "UNSUPPORTED_ACTION", message: "The requested action is not supported." }
  });
  assert.equal(invocations[0]!.stdin.includes('"method":"thread/start"'), false);
  assert.equal(invocations[0]!.stdin.includes('"method":"turn/start"'), false);
});

test("rejects an unsupported reasoning effort before thread/start and turn/start", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "done",
    modelList: [{
      id: "catalog-id",
      model: "gpt-5-codex",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }]
    }]
  }, invocations));

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    model: "gpt-5-codex",
    reasoning_effort: "high"
  } as Parameters<typeof executor.execute>[0] & { model: string; reasoning_effort: string });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: { code: "UNSUPPORTED_ACTION", message: "The requested action is not supported." }
  });
  assert.equal(invocations[0]!.stdin.includes('"method":"thread/start"'), false);
  assert.equal(invocations[0]!.stdin.includes('"method":"turn/start"'), false);
});

test("uses the default model for effort-only selection and sends only the effort override", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "done",
    modelList: [{
      id: "catalog-id",
      model: "default-model",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }]
    }]
  }, invocations));

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction: "inspect",
    reasoning_effort: "medium"
  } as Parameters<typeof executor.execute>[0] & { reasoning_effort: string });

  assert.equal(result.kind, "completed");
  const messages = invocations[0]!.stdin.trim().split("\n").map((line) => JSON.parse(line));
  const turnStart = messages.find((message: { method?: string }) => message.method === "turn/start");
  assert.equal("model" in turnStart.params, false);
  assert.equal(turnStart.params.effort, "medium");
  assert.equal("reasoning_effort" in turnStart.params, false);
});

test("steer requires turn/started readiness and controls reset between turns", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});

  const firstExecution = executor.execute({ taskId: TASK_ID, instruction: "first" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), false);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "other-turn", status: "inProgress" } } });
  await assert.rejects(executor.steer("wrong turn"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), false);

  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  await executor.steer("continue");
  await executor.interrupt();
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/steer"'), true);
  assert.equal(invocations[0]?.stdin.includes('"method":"turn/interrupt"'), true);

  invocations[0]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await firstExecution;
  await assert.rejects(executor.interrupt(), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  const secondExecution = executor.execute({ taskId: TASK_ID, threadId: "thread-1", instruction: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(executor.steer("too soon again"), (error) => error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
  assert.equal(invocations[1]?.stdin.includes('"method":"turn/steer"'), false);
  invocations[1]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  await secondExecution;
});

test("interrupt terminates Codex while initialize is still pending", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ hold: true }, invocations));
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();

  assert.deepEqual(withoutDiagnostics(await settlesWithin(pending)), { kind: "interrupted", output: "", evidence: [] });
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("interrupt forces termination when turn interrupt RPC never responds", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "",
    autoComplete: false,
    ignoredMethods: ["turn/interrupt"]
  }, invocations));
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await executor.interrupt();

  assert.deepEqual(withoutDiagnostics(await settlesWithin(pending)), {
    kind: "interrupted",
    output: "",
    threadId: "thread-1",
    evidence: []
  });
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("cooperative Codex interrupt completion still terminates the one-shot app-server", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "",
    autoComplete: false
  }, invocations), "win32");
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await executor.interrupt();
  invocations[0]?.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } }
  });

  assert.equal((await settlesWithin(pending)).kind, "interrupted");
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("hard deadline terminates Codex when initialize never responds", async () => {
  const invocations: Invocation[] = [];
  const pending = timedExecutor(
    fakeStarter({ hold: true }, invocations),
    process.platform,
    { ...SHORT_TIMING, rpcCallTimeoutMs: 1_000 }
  )
    .execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(withoutDiagnostics(await settlesWithin(pending)), {
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("initialize RPC times out before the whole execution deadline", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({
    appServerOutput: "",
    ignoredMethods: ["initialize"]
  }, invocations), process.platform, { ...SHORT_TIMING, executionTimeoutMs: 1_000 });
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  try {
    assert.deepEqual(withoutDiagnostics(await settlesWithin(pending, 200)), {
      kind: "failed",
      error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
    });
  } finally {
    if (invocations[0]?.signals.length === 0) {
      await executor.interrupt();
      await pending;
    }
  }
});

test("stalls after command items complete without turn/completed", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false }, invocations),
    {},
    process.platform,
    { executionTimeoutMs: 1_000, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: 25 }
  );
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  invocations[0]?.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "true" } } });

  const result = await settlesWithin(pending, 200);
  assert.equal(result.kind, "failed");
  assert.equal(result.error.code, "EXECUTOR_STALLED");
});

test("matching active-turn reasoning notifications reset the inactivity watchdog", async () => {
  const inactivityTimeoutMs = 400;
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false }, invocations),
    {},
    process.platform,
    { executionTimeoutMs: 2_000, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: inactivityTimeoutMs }
  );
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await new Promise<void>((resolve) => setTimeout(resolve, inactivityTimeoutMs / 2));
  invocations[0]?.send({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "still reasoning" }
  });
  // This crosses the original deadline by 100ms but stays 100ms inside the
  // reset deadline, so only matching active-turn activity can keep it alive.
  await new Promise<void>((resolve) => setTimeout(resolve, inactivityTimeoutMs * 3 / 4));
  await executor.interrupt();
  assert.equal((await pending).kind, "interrupted");
});

test("other-thread, other-turn, global, and RPC traffic do not reset the inactivity watchdog", async () => {
  const inactivityTimeoutMs = 400;
  const trafficByCase = [
    ["other thread", { method: "item/reasoning/summaryTextDelta", params: { threadId: "other", turnId: "turn-1", delta: "noise" } }],
    ["other turn", { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "other", delta: "noise" } }],
    ["global notification", { method: "item/started", params: { item: { id: "cmd-1", type: "commandExecution" } } }],
    ["RPC response", { id: 999, result: {} }]
  ] as const;

  for (const [name, traffic] of trafficByCase) {
    const invocations: Invocation[] = [];
    const executor = new CodexExecutor(
      TRUSTED_CWD,
      fakeStarter({ appServerOutput: "", autoComplete: false }, invocations),
      {},
      process.platform,
      { executionTimeoutMs: 2_000, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: inactivityTimeoutMs }
    );
    const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

    await new Promise<void>((resolve) => setImmediate(resolve));
    invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    await new Promise<void>((resolve) => setTimeout(resolve, inactivityTimeoutMs / 2));
    invocations[0]?.send(traffic);

    try {
      const result = await settlesWithin(pending, inactivityTimeoutMs * 3 / 4);
      assert.equal(result.kind, "failed", name);
      assert.equal(result.error.code, "EXECUTOR_STALLED", name);
    } finally {
      if (invocations[0]?.signals.length === 0) {
        await executor.interrupt();
        await pending;
      }
    }
  }
});

test("late turn completion cannot overwrite a stall termination", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false }, invocations),
    {},
    process.platform,
    { executionTimeoutMs: 500, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: 30 }
  );
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  invocations[0]?.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  const result = await pending;
  assert.equal(result.kind, "failed");
  assert.equal(result.error.code, "EXECUTOR_STALLED");
});

test("normal completion and explicit interrupt preempt the inactivity watchdog", async () => {
  const completedInvocations: Invocation[] = [];
  const completed = await new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "done" }, completedInvocations),
    {},
    process.platform,
    { executionTimeoutMs: 500, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: 100 }
  ).execute({ taskId: TASK_ID, instruction: "inspect" });
  assert.equal(completed.kind, "completed");

  const interruptedInvocations: Invocation[] = [];
  const interruptedExecutor = new CodexExecutor(
    TRUSTED_CWD,
    fakeStarter({ appServerOutput: "", autoComplete: false }, interruptedInvocations),
    {},
    process.platform,
    { executionTimeoutMs: 500, interruptGraceMs: 10, killGraceMs: 10, protocolInactivityTimeoutMs: 100 }
  );
  const pending = interruptedExecutor.execute({ taskId: TASK_ID, instruction: "inspect" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  interruptedInvocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await interruptedExecutor.interrupt();
  assert.equal((await pending).kind, "interrupted");
});

test("direct child exit does not restart an existing TERM to KILL deadline", async () => {
  const invocations: Invocation[] = [];
  const originalKill = process.kill;
  const signals: Array<{ signal: NodeJS.Signals | number | undefined; at: number }> = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== -424243) throw new Error(`unexpected pid ${pid}`);
    signals.push({ signal, at: Date.now() });
    return true;
  }) as typeof process.kill;
  try {
    const timing = { executionTimeoutMs: 1_000, interruptGraceMs: 10, killGraceMs: 80 };
    const executor = new CodexExecutor(
      TRUSTED_CWD,
      fakeStarter({ appServerOutput: "", autoComplete: false, pid: 424243 }, invocations),
      {},
      "darwin",
      timing
    );
    const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    invocations[0]?.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    await executor.interrupt();
    setTimeout(() => invocations[0]?.exit(0), 50);

    await settlesWithin(pending, 120);
    const term = signals.find(({ signal }) => signal === "SIGTERM");
    const kill = signals.find(({ signal }) => signal === "SIGKILL");
    assert.ok(term);
    assert.ok(kill);
    assert.ok(kill.at - term.at < 120, `kill deadline refreshed: ${kill.at - term.at}ms`);
  } finally {
    process.kill = originalKill;
  }
});

test("normal Codex completion clears lifecycle work and ignores late process or RPC events", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ appServerOutput: "final answer" }, invocations));
  let resolutions = 0;
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" })
    .then((result) => { resolutions += 1; return result; });

  const result = await pending;
  const signals = [...(invocations[0]?.signals ?? [])];
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  invocations[0]?.send({ id: 999, result: {} });
  invocations[0]?.exit(7);
  invocations[0]?.close(7);
  invocations[0]?.error();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(result.kind, "completed");
  assert.equal(resolutions, 1);
  assert.deepEqual(invocations[0]?.signals, signals);
  assert.equal((executor as unknown as { pending: Map<number, unknown> }).pending.size, 0);
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("maps a thrown spawn and a process error to unavailable", async () => {
  const throwing: ProcessStarter = () => { throw new Error("secret spawn details"); };
  const thrown = await new CodexExecutor(TRUSTED_CWD, throwing, {}).execute({ taskId: TASK_ID, instruction: "x" });
  const emitted = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ processError: true }, []), {})
    .execute({ taskId: TASK_ID, instruction: "x" });

  for (const result of [thrown, emitted]) {
    assert.deepEqual(withoutDiagnostics(result), {
      kind: "failed",
      error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." }
    });
  }
});

test("direct child exit rejects initialize and clears every pending RPC even when stdio stays open", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal((executor as unknown as { pending: Map<number, unknown> }).pending.size, 1);
  invocation.exit(0);

  assert.deepEqual(withoutDiagnostics(await settlesWithin(pending)), {
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  assert.equal((executor as unknown as { pending: Map<number, unknown> }).pending.size, 0);
});

test("rejects malformed JSONL, missing messages, and malformed message structure", async () => {
  const outputs = [
    "not-json secret raw line",
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })
  ];
  for (const stdout of outputs) {
    const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({ stdout }, []), {})
      .execute({ taskId: TASK_ID, instruction: "x" });
    assert.deepEqual(withoutDiagnostics(result), {
      kind: "failed",
      error: { code: "CODEX_PROTOCOL_ERROR", message: "Codex returned an invalid response." }
    });
    assert.equal(JSON.stringify(result).includes("secret raw line"), false);
  }
});

test("nonzero exit discards partial output and stderr details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    stdout: JSON.stringify({ method: "future/notification", params: { text: "secret partial" } }),
    stderr: "secret stderr /private/path",
    exitCode: 7
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x" });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret partial"), false);
  assert.equal(serialized.includes("secret stderr"), false);
  assert.equal(serialized.includes("/private/path"), false);
});

test("reports an allowlisted failed-turn reason without exposing raw error details", async () => {
  const result = await new CodexExecutor(TRUSTED_CWD, fakeStarter({
    appServerOutput: "",
    turnError: {
      message: "secret upstream message /private/path",
      codexErrorInfo: "serverOverloaded",
      additionalDetails: "secret diagnostics"
    }
  }, []), {}).execute({ taskId: TASK_ID, instruction: "x" });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: {
      code: "CODEX_EXECUTION_FAILED",
      message: "Codex execution failed: the selected model is at capacity."
    },
    threadId: "thread-1",
    evidence: []
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret upstream message"), false);
  assert.equal(serialized.includes("/private/path"), false);
  assert.equal(serialized.includes("secret diagnostics"), false);
});

test("an interrupted turn keeps the last completed agent text as real partial output", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: "partial answer" } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });

  assert.deepEqual(withoutDiagnostics(await pending), {
    kind: "interrupted",
    output: "partial answer",
    threadId: "thread-1",
    evidence: []
  });
});

test("marks oversized evidence strings with a visible truncation marker inside the bound", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "c".repeat(20_000) } } });
  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "p".repeat(20_000), diff: "d".repeat(20_000) }] } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const evidence = result.evidence ?? [];
  assert.equal(evidence.length, 2);
  // The marker takes its own slot inside the 16_384 budget: 16_372 content
  // bytes plus "\n[truncated]" (marker length 11 plus the separator).
  const command = evidence.find(({ id }) => id === "cmd-1");
  assert.equal(command?.command, `${"c".repeat(16_372)}\n[truncated]`);
  assert.ok((command?.command?.length ?? 0) <= 16_384);
  const change = evidence.find(({ id }) => id === "change-1");
  assert.equal(change?.changes?.[0]?.path, `${"p".repeat(16_372)}\n[truncated]`);
  assert.equal(change?.changes?.[0]?.diff, `${"d".repeat(16_372)}\n[truncated]`);
  assert.ok((change?.changes?.[0]?.path.length ?? 0) <= 16_384);
  assert.ok((change?.changes?.[0]?.diff.length ?? 0) <= 16_384);
});

test("marks an oversized changes list with an in-bound truncation entry and an accurate omitted count", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  const changes = Array.from({ length: 55 }, (_, index) => ({ path: `file-${index}.txt`, diff: `diff ${index}` }));
  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "change-1", type: "fileChange", status: "completed", changes } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const change = result.evidence?.find(({ id }) => id === "change-1");
  // 49 real entries plus the marker fit the 50-entry bound; 55 - 49 = 6
  // real changes are omitted and the count says so.
  assert.equal(change?.changes?.length, 50);
  assert.deepEqual(change?.changes?.[0], { path: "file-0.txt", diff: "diff 0" });
  assert.deepEqual(change?.changes?.[48], { path: "file-48.txt", diff: "diff 48" });
  assert.deepEqual(change?.changes?.[49], { path: "[truncated: 6 additional changes omitted]", diff: "" });
});

test("reports evidence evicted by the count limit through an in-budget synthetic drop item", async () => {
  const invocations: Invocation[] = [];
  const emissions: Array<readonly ExecutorEvidence[]> = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({
    taskId: TASK_ID,
    instruction: "x",
    onEvidence: (items) => { emissions.push(items); }
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  for (let index = 1; index <= 55; index += 1) {
    invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: `cmd-${index}`, type: "commandExecution", status: "completed", command: `command ${index}` } } });
  }
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  const evidence = result.evidence ?? [];
  // The marker reserves one of the 50 slots: 49 real entries plus the marker.
  assert.equal(evidence.length, 50);
  assert.equal(evidence[0]?.id, "cmd-7");
  assert.equal(evidence[48]?.id, "cmd-55");
  const drop = evidence[49];
  assert.equal(drop?.id, "evidence-drop");
  assert.equal(drop?.type, "commandExecution");
  assert.match(drop?.command ?? "", /6 evidence item\(s\) dropped: evidence limit exceeded/u);

  // 55 real entries arrived; 49 are shown, so exactly 6 were dropped, and
  // every onEvidence emission respects the 50-item budget.
  assert.equal(emissions.length, 55);
  assert.equal(emissions[49]?.length, 50);
  assert.equal(emissions[49]?.[50], undefined);
  assert.equal(emissions[50]?.length, 50);
  assert.equal(emissions[50]?.[49]?.id, "evidence-drop");
  assert.equal(emissions[54]?.length, 50);
  assert.equal(emissions[54]?.[0]?.id, "cmd-7");
  assert.equal(emissions[54]?.[49]?.id, "evidence-drop");
});

test("bounds Codex diagnostic evidence by aggregate serialized UTF-8 bytes and retains a drop marker", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ appServerOutput: "", autoComplete: false }, invocations));
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  for (let index = 0; index < 50; index += 1) {
    invocation.send({
      method: "item/completed",
      params: {
        threadId: "thread-1", turnId: "turn-1",
        item: {
          id: `cmd-${index}`,
          type: "commandExecution",
          status: "completed",
          command: `${"命令".repeat(4_000)}-${index}`
        }
      }
    });
  }
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  const evidence = result.evidence ?? [];
  assert.ok(Buffer.byteLength(JSON.stringify(evidence), "utf8") <= 65_536);
  assert.equal(evidence.some(({ id }) => id === "evidence-drop"), true);
});

test("fails promptly with bounded diagnostics for an overlong unterminated Codex JSONL line", async () => {
  const invocations: Invocation[] = [];
  const secret = "secret-protocol-body";
  const executor = timedExecutor(fakeStarter({ hold: true }, invocations), process.platform, {
    ...SHORT_TIMING,
    executionTimeoutMs: 1_000,
    protocolInactivityTimeoutMs: 1_000,
    rpcCallTimeoutMs: 1_000
  });
  const pending = settlesWithin(executor.execute({ taskId: TASK_ID, instruction: "x" }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.writeStdout("x".repeat(40_000));
  invocation.writeStdout(`${"y".repeat(40_000)}${secret}`);

  const result = await pending;
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.error.code, "CODEX_PROTOCOL_ERROR");
  assert.ok(JSON.stringify(result).length <= 2_048);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("exposes bounded structured diagnostics without instruction or output payloads", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ appServerOutput: "done" }, invocations));

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });
  const diagnostics = (result as unknown as {
    diagnostics?: { executor_started_at?: unknown; executor_ended_at?: unknown; instruction?: unknown; output?: unknown; protocol?: unknown }
  }).diagnostics;
  assert.equal(typeof diagnostics?.executor_started_at, "string");
  assert.equal(typeof diagnostics?.executor_ended_at, "string");
  assert.equal("instruction" in (diagnostics ?? {}), false);
  assert.equal("output" in (diagnostics ?? {}), false);
  assert.equal("protocol" in (diagnostics ?? {}), false);
});

test("passes untruncated evidence through unchanged", async () => {
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", status: "completed", command: "ls -la" } } });
  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", diff: "+1 line" }] } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.deepEqual(result.evidence, [
    { id: "cmd-1", type: "commandExecution", status: "completed", command: "ls -la" },
    { id: "change-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", diff: "+1 line" }] }
  ]);
});

test("does not cap agent message text or the final output", async () => {
  const longText = "t".repeat(30_000);
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD, fakeStarter({ appServerOutput: "", autoComplete: false }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "x" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);

  invocation.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: longText } } });
  invocation.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });

  const result = await pending;
  assert.equal(result.kind, "completed");
  assert.equal(result.output, longText);
});

// ---------------------------------------------------------------------------
// Windows command resolution (platform seam = "win32").
// ---------------------------------------------------------------------------

function windowsDirectory(): string {
  return mkdtempSync(join(tmpdir(), "bridge-codex-win-"));
}

test("win32: a real codex.exe on PATH is spawned directly with the fixed args", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.exe"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "completed");
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, join(dir, "codex.exe"));
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
});

test("win32: an npm codex.cmd shim resolves to the official bin/codex.js and runs under Node", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "completed");
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
});

test("win32: a local node_modules/.bin codex.cmd shim also resolves to bin/codex.js under Node", async () => {
  const dir = windowsDirectory();
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: binDir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
});

test("win32: a codex.cmd shim without a derivable target fails closed through the bare fallback, never a shell", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  const invocation = invocations[0];
  assert.ok(invocation);
  // No cmd.exe, no ComSpec, no shell command text: the original bare "codex"
  // spawn is kept, which maps to CODEX_UNAVAILABLE on a real Windows machine.
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
  assert.equal(invocation.options.shell, false);
});

test("win32: a shell-like instruction never reaches the argv of the Node launcher", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.cmd"), "");
  const binJs = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");
  const instruction = "inspect & echo pwned > marker.txt | 100%! \"中文 测试\"";

  await executor.execute({ taskId: TASK_ID, instruction });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "app-server", "--stdio"]);
  assert.equal(invocation.args.some((arg) => arg.includes("&") || arg.includes("|") || arg.includes("%")), false);
  // The instruction travels only over JSON-RPC stdin, as one JSON text field.
  const messages = invocation.stdin.trim().split("\n").map((line) => JSON.parse(line));
  const turnStart = messages.find((message) => message.method === "turn/start") as
    { params?: { input?: Array<{ text?: string }> } } | undefined;
  assert.equal(turnStart?.params?.input?.[0]?.text, instruction);
});

test("win32: a real codex.exe is preferred over a codex.cmd shim even when the shim dir comes first", async () => {
  const shimDir = windowsDirectory();
  const exeDir = windowsDirectory();
  writeFileSync(join(shimDir, "codex.cmd"), "");
  const exe = join(exeDir, "codex.exe");
  writeFileSync(exe, "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: `${shimDir};${exeDir}` }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(invocations[0]?.executable, exe);
});

test("win32: no resolvable command keeps the original bare spawn (which maps to CODEX_UNAVAILABLE on Windows)", async () => {
  const dir = windowsDirectory();
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
});

test("POSIX: a Windows-style codex.exe layout on PATH does not change the bare spawn", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "codex.exe"), "");
  const invocations: Invocation[] = [];
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ appServerOutput: "final answer" }, invocations),
    { PATH: dir }); // default platform is the running (non-Windows) one

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "codex");
  assert.deepEqual(invocation.args, ["app-server", "--stdio"]);
});

test("win32: a spawned command that does not resolve still maps to CODEX_UNAVAILABLE", async () => {
  const dir = windowsDirectory();
  const executor = new CodexExecutor(TRUSTED_CWD,
    fakeStarter({ processError: true }, []),
    { PATH: dir }, "win32");

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(withoutDiagnostics(result), {
    kind: "failed",
    error: { code: "CODEX_UNAVAILABLE", message: "Codex is unavailable." }
  });
});
