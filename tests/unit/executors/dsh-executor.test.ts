import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import { DshExecutor } from "../../../src/executors/dsh-executor.js";
import type { DshProcessStarter } from "../../../src/executors/dsh-executor.js";
import { isId } from "../../../src/core/ids.js";

const TASK_ID_VALUE = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(TASK_ID_VALUE)) throw new Error("Test task ID must be a UUID v4.");
const TASK_ID = TASK_ID_VALUE;
const TRUSTED_CWD = "/trusted/workspace";
const MAX_OUTPUT_BYTES = 1_048_576;
const TRUNCATION_MARKER = "[output truncated]";
const TRUNCATION_SEPARATOR = `\n${TRUNCATION_MARKER}\n`;
const HEAD_OUTPUT_BYTES = 768 * 1024;
const TAIL_OUTPUT_BYTES = MAX_OUTPUT_BYTES - HEAD_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_SEPARATOR);
const SHORT_TIMING = { executionTimeoutMs: 30, interruptGraceMs: 10, killGraceMs: 10 };

interface Invocation {
  executable: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  stdin: PassThrough;
  signals: string[];
  killResult: boolean;
  write(chunk: string | Buffer): void;
  error(): void;
  exit(code: number | null): void;
  close(code: number | null): void;
}

interface FakeBehavior {
  stdout?: string | Buffer;
  stderr?: string;
  exitCode?: number;
  processError?: boolean;
  hold?: boolean;
  pid?: number;
}

function fakeStarter(behavior: FakeBehavior, invocations: Invocation[]): DshProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const invocation: Invocation = {
      executable,
      args: [...args],
      options,
      stdin,
      signals: [],
      killResult: true,
      write(chunk) {
        stdout.write(chunk);
      },
      error() {
        child.emit("error", new Error("late child error"));
      },
      exit(code) {
        child.emit("exit", code, null);
      },
      close(code) {
        stdout.end();
        stderr.end();
        child.emit("close", code, null);
      }
    };
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: behavior.pid,
      killed: false,
      kill(signal?: string) {
        this.killed = true;
        invocation.signals.push(signal ?? "SIGTERM");
        return invocation.killResult;
      }
    });
    invocations.push(invocation);
    queueMicrotask(() => {
      if (behavior.processError) {
        child.emit("error", new Error("secret process error"));
        return;
      }
      if (behavior.hold) return;
      if (behavior.stdout !== undefined) stdout.end(behavior.stdout);
      else stdout.end("final answer\n");
      stderr.end(behavior.stderr ?? "");
      child.emit("close", behavior.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

function timedExecutor(
  starter: DshProcessStarter,
  platform: NodeJS.Platform = process.platform,
  timing = SHORT_TIMING
): DshExecutor {
  return new DshExecutor(TRUSTED_CWD, starter, {}, platform, timing);
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("promise did not settle")), milliseconds);
    })
  ]);
}

test("uses the official headless interface with a fixed workspace and returns final text", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    DSH_PERMISSION_MODE: "danger-full-access",
    DEEPSEEK_API_KEY: "secret-api-key",
    DSH_TOOLS_MODE: "full",
    HTTP_PROXY: "secret-proxy",
    HTTPS_PROXY: "secret-https-proxy",
    NO_PROXY: "secret-noproxy",
    AWS_SECRET_ACCESS_KEY: "secret-aws"
  };
  const executor = new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    hostEnvironment
  );
  const instruction = "  exact prompt\nwith $() and `quotes`  ";

  const result = await executor.execute({
    taskId: TASK_ID,
    instruction,
    sandbox: "read-only"
  });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "dsh");
  assert.deepEqual(invocation.args, ["--profile", "headless", instruction]);
  assert.equal(invocation.options.cwd, TRUSTED_CWD);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(invocation.options.env, {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    TMPDIR: "/tmp/test",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    USER: "tester",
    LOGNAME: "tester-log",
    DEEPSEEK_API_KEY: "secret-api-key",
    DSH_TOOLS_MODE: "full",
    DSH_PERMISSION_MODE: "read-only"
  });
  assert.equal(invocation.stdin.writableEnded, true);
});

test("maps spawn failures to unavailable", async () => {
  const throwing: DshProcessStarter = () => {
    throw new Error("secret spawn details");
  };
  const thrown = await new DshExecutor(TRUSTED_CWD, throwing, {})
    .execute({ taskId: TASK_ID, instruction: "inspect" });
  const emitted = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ processError: true }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  for (const result of [thrown, emitted]) {
    assert.deepEqual(result, {
      kind: "failed",
      error: { code: "DSH_UNAVAILABLE", message: "DSH is unavailable." }
    });
  }
});

test("accepts valid output without a trailing newline", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "final answer" }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
});

test("maps a zero exit with truly empty stdout to a completed empty output", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "" }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "" });
});

test("maps a nonzero exit with empty stdout to an execution failure", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "", exitCode: 3 }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_EXECUTION_FAILED", message: "DSH execution failed." }
  });
});

test("direct child exit settles even when inherited stdout and stderr never close", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write("arrived output\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  invocation.exit(0);

  assert.deepEqual(await settlesWithin(pending), { kind: "completed", output: "arrived output" });
});

test("POSIX direct exit terminates a descendant that keeps inherited stdio open", {
  skip: process.platform === "win32"
}, async () => {
  let descendantPid: number | undefined;
  let directStderr = "";
  let directError = "";
  const starter: DshProcessStarter = (_executable, _args, options) => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "process.stdin.resume();",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "process.stdout.write(String(descendant.pid) + '\\n');",
      "setTimeout(() => process.exit(0), 10);"
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], { ...options, cwd: process.cwd() });
    child.on("error", (error) => { directError = error.message; });
    child.stdin.on("error", (error) => { directError = `stdin: ${error.message}`; });
    child.stderr.on("data", (chunk: Buffer) => { directStderr += chunk.toString("utf8"); });
    child.stdout.once("data", (chunk: Buffer) => {
      descendantPid = Number.parseInt(chunk.toString("utf8"), 10);
    });
    return child;
  };
  const executor = timedExecutor(starter, process.platform, {
    executionTimeoutMs: 1_000,
    interruptGraceMs: 20,
    killGraceMs: 50
  });

  try {
    const result = await settlesWithin(
      executor.execute({ taskId: TASK_ID, instruction: "inspect" }),
      500
    );
    if (result.kind !== "completed") {
      throw new Error(JSON.stringify({ result, directStderr, directError }));
    }
    assert.ok(descendantPid);
    assert.throws(() => process.kill(descendantPid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("direct child exit never falls back to signalling its stale PID", async () => {
  const invocations: Invocation[] = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== -424242) throw new Error(`unexpected pid ${pid}`);
    if (signal === "SIGTERM") return true;
    const error = new Error("process group exited") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  }) as typeof process.kill;
  try {
    const executor = timedExecutor(fakeStarter({ hold: true, pid: 424242 }, invocations), "darwin");
    const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    invocations[0]?.exit(0);

    assert.equal((await settlesWithin(pending)).kind, "completed");
    assert.deepEqual(invocations[0]?.signals, []);
  } finally {
    process.kill = originalKill;
  }
});

test("hard deadline terminates a silent DSH child and settles without close", async () => {
  const invocations: Invocation[] = [];
  const pending = timedExecutor(fakeStarter({ hold: true }, invocations))
    .execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(await settlesWithin(pending), {
    kind: "failed",
    error: { code: "DSH_EXECUTION_FAILED", message: "DSH execution failed." }
  });
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("normal DSH completion clears the deadline and ignores late exit close and error", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ stdout: "final answer\n" }, invocations));
  let resolutions = 0;
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" })
    .then((result) => { resolutions += 1; return result; });

  assert.deepEqual(await pending, { kind: "completed", output: "final answer" });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  invocations[0]?.exit(7);
  invocations[0]?.close(7);
  invocations[0]?.error();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(resolutions, 1);
  assert.deepEqual(invocations[0]?.signals, []);
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("maps invalid UTF-8 completed output to a protocol error", async () => {
  const stdout = Buffer.concat([
    Buffer.from("secret output "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("\n")
  ]);
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_PROTOCOL_ERROR", message: "DSH returned an invalid response." }
  });
  assert.equal(JSON.stringify(result).includes("secret output"), false);
});

test("maps nonzero exit to an execution failure without exposing output or stderr", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({
      stdout: "secret partial\n",
      stderr: "secret stderr /private/path",
      exitCode: 7
    }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_EXECUTION_FAILED", message: "DSH execution failed." }
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret partial"), false);
  assert.equal(serialized.includes("secret stderr"), false);
  assert.equal(serialized.includes("/private/path"), false);
});

test("does not impose a sandbox policy before starting DSH", async () => {
  const invocations: Invocation[] = [];
  const result = await new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {})
    .execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "workspace-write" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
});

test("forwards only the sanctioned DSH variables and pins read-only, never host overrides or other secrets", async () => {
  const invocations: Invocation[] = [];
  const hostEnvironment = {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_HOME: "/dsh/test",
    DSH_PERMISSION_MODE: "workspace-write",
    DEEPSEEK_API_KEY: "secret-api-key",
    DSH_TOOLS_MODE: "full",
    HTTP_PROXY: "secret-proxy",
    HTTPS_PROXY: "secret-https-proxy",
    NO_PROXY: "secret-noproxy",
    AWS_SECRET_ACCESS_KEY: "secret-aws"
  };
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), hostEnvironment);

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "final answer" });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.options.env?.DSH_PERMISSION_MODE, "read-only");
  assert.equal(invocation.options.env?.DEEPSEEK_API_KEY, "secret-api-key");
  assert.equal(invocation.options.env?.DSH_TOOLS_MODE, "full");
  assert.equal(invocation.options.env?.HTTP_PROXY, undefined);
  assert.equal(invocation.options.env?.HTTPS_PROXY, undefined);
  assert.equal(invocation.options.env?.NO_PROXY, undefined);
  assert.equal(invocation.options.env?.AWS_SECRET_ACCESS_KEY, undefined);
  // The invocation itself is unchanged: same official headless interface.
  assert.deepEqual(invocation.args, ["--profile", "headless", "inspect"]);
});

test("a host requesting danger-full-access cannot override the read-only run_task", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {
    PATH: "/test/bin",
    HOME: "/home/test",
    DSH_PERMISSION_MODE: "danger-full-access"
  });

  await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.options.env?.DSH_PERMISSION_MODE, "read-only");
});

test("Codex routing policy does not constrain DSH", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: "dsh result\n" }, invocations),
    { ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY: "explicit" }
  );

  const result = await executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "dsh result" });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0]?.options.env?.ENGINEERING_BRIDGE_CODEX_ROUTING_POLICY, undefined);
});

test("treats exactly 1 MiB of output as within the cap", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout: Buffer.alloc(MAX_OUTPUT_BYTES, 0x61) }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, { kind: "completed", output: "a".repeat(MAX_OUTPUT_BYTES) });
  assert.equal(result.output.includes(TRUNCATION_MARKER), false);
});

test("retains head and true tail within the 1 MiB budget while omitting the middle", async () => {
  const headSentinel = "HEAD-SENTINEL";
  const middleSentinel = "MIDDLE-SENTINEL";
  const tailSentinel = "TAIL-SENTINEL";
  const stdout = Buffer.concat([
    Buffer.from(headSentinel),
    Buffer.alloc(HEAD_OUTPUT_BYTES - Buffer.byteLength(headSentinel), 0x68),
    Buffer.from(middleSentinel),
    Buffer.alloc(64, 0x6d),
    Buffer.alloc(TAIL_OUTPUT_BYTES - Buffer.byteLength(tailSentinel), 0x74),
    Buffer.from(tailSentinel)
  ]);
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.output.startsWith(headSentinel), true);
  assert.equal(result.output.includes(middleSentinel), false);
  assert.equal(result.output.endsWith(tailSentinel), true);
  assert.equal(result.output.split(TRUNCATION_MARKER).length - 1, 1);
  assert.equal(Buffer.byteLength(result.output), MAX_OUTPUT_BYTES);
});

test("keeps draining and waits for the natural close after the output cap is exceeded", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  let settled = false;
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" })
    .then((result) => { settled = true; return result; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write("a".repeat(MAX_OUTPUT_BYTES));
  invocation.write("obsolete-tail".repeat(32_000));
  invocation.write("z".repeat(TAIL_OUTPUT_BYTES - 10));
  invocation.write("FINAL-TAIL");
  await new Promise<void>((resolve) => setImmediate(resolve));

  // The child is still running: nothing is settled early and it is never killed.
  assert.equal(settled, false);
  assert.deepEqual(invocation.signals, []);

  invocation.close(0);
  const result = await pending;

  assert.equal(settled, true);
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.output.includes("obsolete-tail"), false);
  assert.equal(result.output.endsWith("FINAL-TAIL"), true);
  assert.equal(result.output.split(TRUNCATION_MARKER).length - 1, 1);
  assert.equal(Buffer.byteLength(result.output) <= MAX_OUTPUT_BYTES, true);
  assert.deepEqual(invocation.signals, []);
});

test("interrupt retains bounded head, marker, and true tail after stdout truncation", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ hold: true }, invocations));
  const headSentinel = "INTERRUPTED-HEAD-SENTINEL";
  const tailSentinel = "INTERRUPTED-TAIL-SENTINEL";
  const stdout = Buffer.concat([
    Buffer.from(headSentinel),
    Buffer.alloc(MAX_OUTPUT_BYTES - Buffer.byteLength(headSentinel), 0x68),
    Buffer.from(tailSentinel)
  ]);
  assert.equal(stdout.byteLength > MAX_OUTPUT_BYTES, true);
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write(stdout);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();
  invocation.close(7);

  const result = await pending;
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") return;
  assert.equal(result.output.startsWith(headSentinel), true);
  assert.equal(result.output.split(TRUNCATION_MARKER).length - 1, 1);
  assert.equal(result.output.endsWith(tailSentinel), true);
  assert.equal(Buffer.byteLength(result.output), MAX_OUTPUT_BYTES);
  assert.doesNotThrow(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output)));
});

test("repairs UTF-8 boundaries at both the retained head end and tail start", async () => {
  const character = Buffer.from("中");
  const stdout = Buffer.concat([
    Buffer.alloc(HEAD_OUTPUT_BYTES - 1, 0x68),
    character,
    Buffer.alloc(64, 0x6d),
    character,
    Buffer.alloc(TAIL_OUTPUT_BYTES - 1, 0x74)
  ]);
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({ stdout }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.doesNotThrow(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.output)));
  assert.equal(result.output.includes(TRUNCATION_SEPARATOR), true);
  assert.equal(Buffer.byteLength(result.output) <= MAX_OUTPUT_BYTES, true);
});

test("genuinely invalid UTF-8 before the truncation boundary is still a protocol error", async () => {
  const result = await new DshExecutor(
    TRUSTED_CWD,
    fakeStarter({
      stdout: Buffer.concat([
        Buffer.from("a".repeat(HEAD_OUTPUT_BYTES - 10)),
        Buffer.from([0xff, 0xfe]),
        Buffer.from("b".repeat(MAX_OUTPUT_BYTES))
      ])
    }, []),
    {}
  ).execute({ taskId: TASK_ID, instruction: "inspect" });

  assert.deepEqual(result, {
    kind: "failed",
    error: { code: "DSH_PROTOCOL_ERROR", message: "DSH returned an invalid response." }
  });
});

test("sends SIGTERM to the running child and reports the cached partial output on close", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.write("partial answer");
  await executor.interrupt();
  assert.deepEqual(invocation.signals, ["SIGTERM"]);

  invocation.close(7);
  const result = await pending;

  assert.deepEqual(result, { kind: "interrupted", output: "partial answer" });
  await assert.rejects(executor.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("interrupt escalates to SIGKILL and settles when DSH never closes", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ hold: true }, invocations));
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  invocations[0]?.write("partial answer");
  await executor.interrupt();

  assert.deepEqual(await settlesWithin(pending), { kind: "interrupted", output: "partial answer" });
  assert.deepEqual(invocations[0]?.signals, ["SIGTERM", "SIGKILL"]);
});

test("interrupt with a zero exit code still reports interrupted", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();
  invocations[0]?.close(0);

  assert.deepEqual(await pending, { kind: "interrupted", output: "" });
});

test("interrupt result survives direct exit while the POSIX process group remains alive", async () => {
  const invocations: Invocation[] = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== -424242) throw new Error(`unexpected pid ${pid}`);
    if (signal === "SIGTERM" || signal === "SIGKILL") return true;
    throw new Error(`unexpected signal ${String(signal)}`);
  }) as typeof process.kill;
  try {
    const executor = timedExecutor(
      fakeStarter({ hold: true, pid: 424242 }, invocations),
      "darwin"
    );
    const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const invocation = invocations[0];
    assert.ok(invocation);
    invocation.write("partial answer");
    await executor.interrupt();
    invocation.exit(0);

    assert.deepEqual(await settlesWithin(pending), {
      kind: "interrupted",
      output: "partial answer"
    });
  } finally {
    process.kill = originalKill;
  }
});

test("interrupt without an active child is an invalid state transition", async () => {
  const idle = new DshExecutor(TRUSTED_CWD, fakeStarter({}, []), {});
  await assert.rejects(idle.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");

  const invocations: Invocation[] = [];
  const completed = new DshExecutor(TRUSTED_CWD, fakeStarter({}, invocations), {});
  await completed.execute({ taskId: TASK_ID, instruction: "inspect" });
  await assert.rejects(completed.interrupt(), (error) =>
    error instanceof CoreError && error.code === "INVALID_STATE_TRANSITION");
});

test("repeated interrupt is idempotent and sends a single SIGTERM", async () => {
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD, fakeStarter({ hold: true }, invocations), {});
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await executor.interrupt();
  await executor.interrupt();
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.deepEqual(invocation.signals, ["SIGTERM"]);

  invocation.close(0);
  assert.deepEqual(await pending, { kind: "interrupted", output: "" });
});

test("a failed TERM request still settles as interrupted after the bounded KILL attempt", async () => {
  const invocations: Invocation[] = [];
  const executor = timedExecutor(fakeStarter({ hold: true }, invocations));
  const pending = executor.execute({ taskId: TASK_ID, instruction: "inspect" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const invocation = invocations[0];
  assert.ok(invocation);
  invocation.killResult = false;
  await executor.interrupt();

  assert.deepEqual(await settlesWithin(pending), { kind: "interrupted", output: "" });
  assert.deepEqual(invocation.signals, ["SIGTERM", "SIGKILL"]);
});

// ---------------------------------------------------------------------------
// Windows command resolution (platform seam = "win32").
// ---------------------------------------------------------------------------

function windowsDirectory(): string {
  return mkdtempSync(join(tmpdir(), "bridge-dsh-win-"));
}

test("win32: a real dsh.exe on PATH is spawned directly with the headless args", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "dsh.exe"), "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { PATH: dir }, "win32");
  // The instruction is user-controlled shell-like text: it must stay one argv
  // element and never reach a shell.
  const instruction = "inspect & echo pwned > marker.txt";

  await executor.execute({ taskId: TASK_ID, instruction, sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, join(dir, "dsh.exe"));
  assert.deepEqual(invocation.args, ["--profile", "headless", instruction]);
  assert.equal(invocation.options.shell, false);
});

test("win32: an npm dsh.cmd shim resolves to its Node target, keeping the instruction a plain argv element", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "dsh.cmd"), "");
  const binJs = join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { PATH: dir }, "win32");
  const instruction = "a&b|100%\"(x) 中文 测试";

  await executor.execute({ taskId: TASK_ID, instruction, sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "--profile", "headless", instruction]);
  assert.equal(invocation.options.shell, false);
});

test("win32: a local node_modules/.bin dsh.cmd shim also resolves to its Node target", async () => {
  const dir = windowsDirectory();
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "dsh.cmd"), "");
  const binJs = join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { PATH: binDir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "--profile", "headless", "inspect"]);
});

test("win32: a dsh.cmd shim without a derivable target fails closed through the bare fallback, never ComSpec", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "dsh.cmd"), "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { PATH: dir, COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  // The instruction must never go through a shell: the original bare "dsh"
  // spawn is kept, which maps to DSH_UNAVAILABLE on a real Windows machine.
  assert.notEqual(invocation.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.executable, "dsh");
  assert.deepEqual(invocation.args, ["--profile", "headless", "inspect"]);
});

test("win32: a PATH key spelled Path still resolves dsh", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "dsh.cmd"), "");
  const binJs = join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  writeFileSync(binJs, "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { Path: dir }, "win32");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, [binJs, "--profile", "headless", "inspect"]);
});

test("POSIX: a Windows-style dsh layout on PATH does not change the original resolution", async () => {
  const dir = windowsDirectory();
  writeFileSync(join(dir, "dsh.exe"), "");
  writeFileSync(join(dir, "dsh.cmd"), "");
  const invocations: Invocation[] = [];
  const executor = new DshExecutor(TRUSTED_CWD,
    fakeStarter({ stdout: "final answer\n" }, invocations),
    { PATH: dir }, "linux");

  await executor.execute({ taskId: TASK_ID, instruction: "inspect", sandbox: "read-only" });

  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.executable, "dsh");
  assert.deepEqual(invocation.args, ["--profile", "headless", "inspect"]);
});
