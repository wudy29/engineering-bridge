import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isId } from "../../../src/core/ids.js";
import { CodexExecutor, type ProcessStarter } from "../../../src/executors/codex-executor.js";
import type { ExecutorRequest, ExecutorResult } from "../../../src/executors/executor.js";

const taskId = "550e8400-e29b-41d4-a716-446655440000";
if (!isId(taskId)) throw new Error("Invalid fixture ID");
const request: ExecutorRequest = { taskId, instruction: "private fixture prompt" };
const timing = { executionTimeoutMs: 500, interruptGraceMs: 5, killGraceMs: 5,
  protocolInactivityTimeoutMs: 100, rpcCallTimeoutMs: 30 };
type Rpc = { id?: number; method: string; params?: Record<string, unknown> };
function server(onRequest?: (message: Rpc, peer: Peer) => boolean | void) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Rpc[] = [];
  const signals: string[] = [];
  const peer = {
    send(value: unknown) { stdout.write(`${JSON.stringify(value)}\n`); },
    raw(value: string | Buffer) { stdout.write(value); },
    exit(code: number | null, close = true) {
      child.emit("exit", code, null);
      if (close) {
        stdout.end(); stderr.end();
        // ChildProcess close follows the readable streams' end events.
        setImmediate(() => child.emit("close", code, null));
      }
    },
    terminal(status = "completed") {
      peer.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status } } });
    },
    child, stdout, stderr, sent, signals
  };
  const stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()) as Rpc;
    sent.push(message);
    queueMicrotask(() => {
      if (onRequest?.(message, peer) || message.id === undefined) return;
      const result = message.method === "thread/start" || message.method === "thread/resume"
        ? { thread: { id: "thread-1" } }
        : message.method === "turn/start" ? { turn: { id: "turn-1" } }
        : message.method === "model/list" ? { data: [{ model: "test-model", isDefault: true }], nextCursor: null } : {};
      peer.send({ id: message.id, result });
    });
    done();
  } });
  Object.assign(child, { stdin, stdout, stderr, kill(signal: string) { signals.push(signal); child.emit("signal", signal); return true; } });
  const starter: ProcessStarter = () => child as unknown as ChildProcessWithoutNullStreams;
  const executor = new CodexExecutor("/trusted/workspace", starter, {}, process.platform, timing);
  return { ...peer, executor };
}
type Peer = Pick<ReturnType<typeof server>, "send" | "raw" | "exit" | "terminal" | "child" | "stdout" | "stderr" | "sent" | "signals">;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function diagnostics(result: ExecutorResult): Record<string, unknown> {
  return result.diagnostics as unknown as Record<string, unknown>;
}
function failed(result: ExecutorResult, category: string, code = "CODEX_EXECUTION_FAILED") {
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.error.code, code);
  assert.equal(diagnostics(result).failure_category, category);
  assert.equal(typeof diagnostics(result).last_activity_at, "string");
}

for (const method of ["initialize", "model/list", "thread/start", "thread/resume", "turn/start"]) {
  const input = { ...request, ...(method === "model/list" ? { model: "test-model" } : {}),
    ...(method === "thread/resume" ? { threadId: "previous-thread" } : {}) };
  test(`RPC rejection at ${method} retains safe phase and code without payload`, async () => {
    const peer = server((rpc, io) => {
      if (rpc.method !== method) return;
      io.send({ id: rpc.id, error: { code: -32602, message: "Invalid params", data: { secret: "private payload" } } });
      return true;
    });
    const result = await peer.executor.execute(input);
    failed(result, "rpc_error");
    assert.equal(diagnostics(result).protocol_phase, method);
    assert.equal(diagnostics(result).rpc_method, method);
    assert.equal(diagnostics(result).rpc_timeout, false);
    assert.equal(diagnostics(result).upstream_error_code, -32602);
    assert.equal(diagnostics(result).upstream_error_message, "Invalid params");
    assert.doesNotMatch(JSON.stringify(result), /private payload|private fixture prompt/);
  });
  test(`RPC timeout at ${method} is distinct from malformed protocol`, async () => {
    const peer = server((rpc) => rpc.method === method);
    const result = await peer.executor.execute(input);
    failed(result, "rpc_timeout");
    assert.equal(diagnostics(result).protocol_phase, method);
    assert.equal(diagnostics(result).rpc_method, method);
    assert.equal(diagnostics(result).rpc_timeout, true);
  });
}

test("upstream error messages cannot expose arbitrary secrets even when short", async () => {
  const peer = server((rpc, io) => {
    io.send({ id: rpc.id, error: { code: -32000, message: "private fixture prompt token=short-secret /private/file", data: "raw payload" } });
    return true;
  });
  const result = await peer.executor.execute(request);
  failed(result, "rpc_error");
  assert.equal(diagnostics(result).upstream_error_message, "[redacted upstream message]");
  assert.doesNotMatch(JSON.stringify(result), /short-secret|private fixture|private\/file|raw payload/);
});

for (const params of [undefined, null, "hello", 7, true, [], { future: true }]) {
  test(`unknown notification accepts JSON params ${JSON.stringify(params)}`, async () => {
    const peer = server();
    const pending = peer.executor.execute(request);
    await tick();
    peer.send({ method: "future/notification", ...(params === undefined ? {} : { params }) });
    peer.terminal();
    assert.equal((await pending).kind, "completed");
  });
}

for (const id of [12, "server-request-1"]) {
  for (const method of ["item/commandExecution/requestApproval", "item/tool/requestUserInput", "future/request"]) {
    test(`server request ${method} with ${typeof id} id fails safely without approval`, async () => {
      const peer = server();
      const pending = peer.executor.execute(request);
      await tick();
      peer.send({ id, method, params: { threadId: "thread-1", turnId: "turn-1", secret: "request secret" } });
      const result = await pending;
      failed(result, "unsupported_server_request");
      assert.equal(diagnostics(result).rpc_method, method === "future/request" ? "[unknown method]" : method);
      assert.equal(diagnostics(result).protocol_phase, "turn/active");
      assert.doesNotMatch(JSON.stringify(result), /request secret/);
      assert.equal(peer.sent.some((message) => !message.method), false);
      assert.ok(peer.signals.includes("SIGKILL"));
    });
  }
}

test("a legal unmatched string response id is ignored without matching numeric request ids", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method === "initialize") io.send({ id: String(rpc.id), result: {} });
  });
  const pending = peer.executor.execute(request);
  await tick();
  peer.terminal();
  assert.equal((await pending).kind, "completed");
});

for (const code of [0, 7, null]) {
  for (const phase of ["initialize", "thread/start", "turn/active"]) {
    test(`premature exit ${code} at ${phase} is diagnosed even if close is withheld`, async () => {
      const peer = server((rpc, io) => {
        if (rpc.method === phase) { io.exit(code, false); return true; }
      });
      const pending = peer.executor.execute(request);
      if (phase === "turn/active") { await tick(); peer.exit(code, false); }
      const result = await pending;
      failed(result, "process_exit");
      assert.equal(diagnostics(result).process_exit_code, code);
      assert.equal(diagnostics(result).protocol_phase, phase);
    });
  }
}

test("final unterminated turn/completed is dispatched at stdout EOF", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.raw(JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }));
  peer.exit(0);
  assert.equal((await pending).kind, "completed");
});

test("partial UTF-8 chunks and coalesced CRLF messages preserve agent output", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  const bytes = Buffer.from(JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "你好 🌏" } } }) + "\r\n");
  for (const byte of bytes) peer.raw(Buffer.from([byte]));
  peer.terminal();
  const result = await pending;
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "你好 🌏");
});

for (const raw of ["broken-json\n", "[]\n", "null\n", "7\n", '{"method":', "x".repeat(65_537),
  "oversized-malformed-json".repeat(4_000) + "\n",
  '{"id":1,"result":{},"error":{"code":-1,"message":"bad"}}\n',
  '{"id":1.5,"result":{}}\n', '{"id":null,"result":{}}\n',
  '{"id":1,"error":{"code":"bad","message":"bad"}}\n']) {
  test(`malformed framing or envelope remains fail closed: ${raw.slice(0, 40)}`, async () => {
    const peer = server((rpc) => rpc.method === "initialize");
    const pending = peer.executor.execute(request);
    peer.raw(raw);
    peer.exit(0);
    failed(await pending, "protocol_error", "CODEX_PROTOCOL_ERROR");
  });
}

for (const method of ["turn/started", "turn/completed", "item/started", "item/completed"]) {
  test(`known notification ${method} requires method-specific object params`, async () => {
    const peer = server();
    const pending = peer.executor.execute(request);
    await tick();
    peer.send({ method, params: null });
    failed(await pending, "protocol_error", "CODEX_PROTOCOL_ERROR");
  });
}

test("items from unrelated threads or turns cannot contaminate output or evidence", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.send({ method: "item/completed", params: { threadId: "thread-other", turnId: "turn-1", item: { id: "foreign", type: "agentMessage", text: "foreign text" } } });
  peer.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "old-turn", item: { id: "foreign", type: "commandExecution", command: "foreign command" } } });
  peer.terminal();
  const result = await pending;
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") { assert.equal(result.output, ""); assert.deepEqual(result.evidence, []); }
});

test("processing stops at terminal event even when trailing messages share its chunk", async () => {
  const peer = server();
  const evidence: unknown[] = [];
  const pending = peer.executor.execute({ ...request, onEvidence: (items) => evidence.push(items) });
  await tick();
  peer.raw([
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
    { method: "item/completed", params: { item: { id: "late", type: "commandExecution", command: "late" } } }
  ].map((message) => JSON.stringify(message) + "\n").join(""));
  assert.equal((await pending).kind, "completed");
  assert.deepEqual(evidence, []);
});

for (const params of [{}, { threadId: "thread-1", turn: {} }, { threadId: "thread-1", turn: { id: 7, status: "completed" } }]) {
  test(`active terminal notification rejects missing or invalid turn identity ${JSON.stringify(params)}`, async () => {
    const peer = server();
    const pending = peer.executor.execute(request);
    await tick();
    peer.send({ method: "turn/completed", params });
    failed(await pending, "protocol_error", "CODEX_PROTOCOL_ERROR");
  });
}

test("a turn/start response and unrelated events in one chunk cannot select another turn", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/start") return;
    io.raw([
      { id: rpc.id, result: { turn: { id: "turn-1" } } },
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "other-turn", status: "inProgress" } } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "other-turn", status: "completed" } } },
      { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "active", type: "agentMessage", text: "active output" } } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }
    ].map((value) => JSON.stringify(value) + "\n").join(""));
    return true;
  });
  const result = await peer.executor.execute(request);
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "active output");
});

test("a turn/start response with no started notification still has a bounded inactivity watchdog", async () => {
  const peer = server();
  const result = await peer.executor.execute(request);
  failed(result, "inactivity_timeout", "EXECUTOR_STALLED");
});

test("an oversized line is explicitly diagnosed without returning any of it", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.raw("private-line" + "x".repeat(8 * 1024 * 1024));
  failed(await pending, "protocol_error", "CODEX_PROTOCOL_ERROR");
  assert.equal(diagnostics(await pending).protocol_error_kind, "jsonl_line_too_large");
  assert.doesNotMatch(JSON.stringify(await pending), /private-line/);
});

test("newline-terminated command completion over 64 KiB retains evidence without aggregated output", async () => {
  const frame = { method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1",
    item: { id: "large-command", type: "commandExecution", status: "completed",
      command: "cat output.txt", aggregatedOutput: "" }
  } };
  assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") < 65_536);
  frame.params.item.aggregatedOutput = "start\n" + "F5_AGGREGATED_OUTPUT_SENTINEL\n".repeat(4_096);
  const line = JSON.stringify(frame);
  assert.ok(Buffer.byteLength(line, "utf8") > 65_536);

  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.send({ method: "item/commandExecution/outputDelta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "large-command", delta: "start\n"
  } });
  peer.raw(`${line}\n`);
  peer.terminal();
  const result = await pending;
  assert.equal(result.kind, "completed", JSON.stringify(diagnostics(result)));
  assert.equal(diagnostics(result).protocol_error_kind, undefined);
  if (result.kind === "completed") {
    assert.equal(result.output, "");
    assert.deepEqual(result.evidence, [
      { id: "large-command", type: "commandExecution", status: "completed", command: "cat output.txt" }
    ]);
  }
  assert.doesNotMatch(JSON.stringify(result), /aggregatedOutput|F5_AGGREGATED_OUTPUT_SENTINEL/);
});

test("uncorrelated item notifications cannot become output or evidence", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.send({ method: "item/completed", params: { item: { id: "unscoped", type: "agentMessage", text: "unscoped text" } } });
  peer.terminal();
  const result = await pending;
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "");
});

test("a legal RPC error immediately followed by process close keeps its upstream diagnosis", async () => {
  const peer = server((rpc, io) => {
    io.send({ id: rpc.id, error: { code: -32602, message: "Invalid params" } });
    io.exit(7);
    return true;
  });
  const result = await peer.executor.execute(request);
  failed(result, "rpc_error");
  assert.equal(diagnostics(result).upstream_error_code, -32602);
});

for (const method of ["thread/start", "thread/resume", "turn/start"]) {
  test(`${method} rejects a malformed response body while keeping RPC phase`, async () => {
    const peer = server((rpc, io) => {
      if (rpc.method !== method) return;
      io.send({ id: rpc.id, result: method === "turn/start" ? { turn: { id: null } } : { thread: [] } });
      return true;
    });
    const result = await peer.executor.execute({ ...request, ...(method === "thread/resume" ? { threadId: "previous" } : {}) });
    failed(result, "protocol_error", "CODEX_PROTOCOL_ERROR");
    assert.equal(diagnostics(result).protocol_phase, method);
    assert.equal(diagnostics(result).protocol_error_kind, "response_shape");
  });
}

test("turn/interrupt rejection remains best effort and cannot replace user interruption", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/interrupt") return;
    io.send({ id: rpc.id, error: { code: -32602, message: "Invalid params" } });
    return true;
  });
  const pending = peer.executor.execute(request);
  await tick();
  peer.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  await peer.executor.interrupt();
  assert.equal((await pending).kind, "interrupted");
  assert.ok(peer.signals.includes("SIGKILL"));
});

test("late failed turn during watchdog cleanup cannot overwrite the primary diagnosis", async () => {
  const peer = server();
  peer.child.on("signal", (signal) => {
    if (signal === "SIGTERM") queueMicrotask(() => peer.terminal("failed"));
  });
  const result = await peer.executor.execute(request);
  failed(result, "inactivity_timeout", "EXECUTOR_STALLED");
});

test("turn notifications preceding turn/start response are replayed only for its authoritative id", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/start") return;
    io.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    io.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "early output" } } });
    io.terminal();
    io.send({ id: rpc.id, result: { turn: { id: "turn-1" } } });
    return true;
  });
  const result = await peer.executor.execute(request);
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "early output");
});

test("a pre-response turn/started enables cooperative interruption after the response", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/start") return;
    io.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
  });
  const pending = peer.executor.execute(request);
  await tick();
  await peer.executor.interrupt();
  assert.equal((await pending).kind, "interrupted");
  assert.ok(peer.sent.some((rpc) => rpc.method === "turn/interrupt"));
});

for (const serverRequest of [false, true]) {
  test(`unknown method names cannot expose secrets in ${serverRequest ? "requests" : "notifications"}`, async () => {
    const peer = server();
    const pending = peer.executor.execute(request);
    await tick();
    peer.send({ ...(serverRequest ? { id: "server-1" } : {}), method: "sk-proj-SECRET_PRIVATE_VALUE" });
    if (!serverRequest) peer.exit(0);
    const result = await pending;
    assert.doesNotMatch(JSON.stringify(result), /SECRET_PRIVATE_VALUE/);
    assert.equal(diagnostics(result).last_valid_method, "[unknown method]");
  });
}

test("pre-response notification buffering has an aggregate byte limit", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/start") return;
    for (let i = 0; i < 8; i += 1) io.send({ method: "item/completed", params: {
      threadId: "thread-1", turnId: "turn-1", item: { id: `a-${i}`, type: "agentMessage", text: "x".repeat(10_000) }
    } });
    return true;
  });
  const result = await peer.executor.execute(request);
  failed(result, "protocol_error", "CODEX_PROTOCOL_ERROR");
  assert.equal(diagnostics(result).protocol_error_kind, "pre_response_events_limit");
});

test("early events for a different turn cannot select the response turn", async () => {
  const peer = server((rpc, io) => {
    if (rpc.method !== "turn/start") return;
    io.send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "other", status: "inProgress" } } });
    io.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "other", status: "completed" } } });
    io.send({ id: rpc.id, result: { turn: { id: "turn-1" } } });
    io.send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "a", type: "agentMessage", text: "correct" } } });
    io.terminal();
    return true;
  });
  const result = await peer.executor.execute(request);
  assert.equal(result.kind, "completed");
  if (result.kind === "completed") assert.equal(result.output, "correct");
});

test("invalid UTF-8 cannot silently replace bytes in an otherwise valid JSON string", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.raw(Buffer.concat([
    Buffer.from('{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"a","type":"agentMessage","text":"'),
    Buffer.from([0xff]), Buffer.from('"}}}\n')
  ]));
  peer.terminal();
  const result = await pending;
  failed(result, "protocol_error", "CODEX_PROTOCOL_ERROR");
  assert.equal(diagnostics(result).protocol_error_kind, "invalid_utf8");
});


test("incomplete UTF-8 prefix at direct child exit without stdout EOF remains process_exit", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.raw(Buffer.from([0xe4, 0xbd])); // Prefix of U+4F60 (e4 bd a0).
  peer.exit(7, false);
  const result = await pending;
  failed(result, "process_exit");
  assert.equal(diagnostics(result).process_exit_code, 7);
  assert.equal(diagnostics(result).protocol_error_kind, undefined);
  assert.equal(peer.stdout.readableEnded, false);
});

test("incomplete UTF-8 prefix at actual stdout EOF remains invalid_utf8", async () => {
  const peer = server();
  const pending = peer.executor.execute(request);
  await tick();
  peer.raw(Buffer.from([0xe4, 0xbd]));
  peer.stdout.end();
  const result = await pending;
  failed(result, "protocol_error", "CODEX_PROTOCOL_ERROR");
  assert.equal(diagnostics(result).protocol_error_kind, "invalid_utf8");
  assert.equal(peer.stdout.readableEnded, true);
});
