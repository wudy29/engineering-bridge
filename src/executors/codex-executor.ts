import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { CoreError, serializeError } from "../core/errors.js";
import type { CodexRoutingPolicy } from "../core/codex-routing-policy.js";
import { VERSION } from "../version.js";
import { resolveCommand } from "./command-resolution.js";
import {
  DEFAULT_EXECUTOR_TIMING,
  signalExecution,
  signalProcessGroup,
  type Executor,
  type ExecutorEvidence,
  type ExecutorProgressDiagnostics,
  type ExecutorRequest,
  type ExecutorResult,
  type ExecutorTiming
} from "./executor.js";

export type ProcessStarter = (executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
const ENVIRONMENT_ALLOWLIST = ["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME"] as const;
const MAX_EVIDENCE = 50;
const MAX_TEXT = 16_384;
const MAX_EVIDENCE_BYTES = 65_536;
const MAX_JSONL_LINE_BYTES = 65_536;
const DEFAULT_RPC_CALL_TIMEOUT_MS = 30_000;
// Official npm target of the Codex CLI, derived from a codex.cmd shim's
// location so a Windows npm install can be launched through Node directly
// (never through a shell).
const CODEX_NODE_TARGET = ["@openai", "codex", "bin", "codex.js"] as const;
// Machine- and human-readable marker appended to any bounded evidence string
// that was cut by MAX_TEXT, and the basis of the synthetic change/evidence
// entries that make list and count truncation visible.
const TRUNCATION_MARKER = "[truncated]";

function failure(code: "CODEX_UNAVAILABLE" | "CODEX_PROTOCOL_ERROR" | "CODEX_EXECUTION_FAILED" | "CODEX_ROUTING_REQUIRED" | "EXECUTOR_STALLED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}
function failedTurn(turn: Record<string, unknown>): ExecutorResult {
  const error = object(turn.error) ? turn.error : undefined;
  if (error?.codexErrorInfo === "serverOverloaded") {
    return {
      kind: "failed",
      error: {
        code: "CODEX_EXECUTION_FAILED",
        message: "Codex execution failed: the selected model is at capacity."
      }
    };
  }
  return failure("CODEX_EXECUTION_FAILED");
}
function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (host[key]) result[key] = host[key];
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}
// This is a diagnostics allowlist, not a protocol allowlist. Unknown methods
// remain legal; their arbitrary names must not become a private-data channel.
const SAFE_DIAGNOSTIC_METHODS = new Set([
  "thread/started", "thread/status/changed", "thread/tokenUsage/updated",
  "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated",
  "item/started", "item/completed", "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta", "item/mcpToolCall/progress",
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/tool/requestUserInput", "mcpServer/elicitation/request", "item/permissions/requestApproval",
  "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "currentTime/read",
  "applyPatchApproval", "execCommandApproval", "serverRequest/resolved", "error", "warning"
]);
function safeMethod(method: string): string {
  return SAFE_DIAGNOSTIC_METHODS.has(method) ? method : "[unknown method]";
}
// Upstream messages are untrusted and can contain prompts, paths or credentials.
// Only exact, known non-sensitive messages may cross the diagnostics boundary.
function safeRpcMessage(message: string): string {
  return ["Invalid request", "Invalid params", "Method not found", "Internal error",
    "Not initialized", "Already initialized", "Server overloaded; retry later."].includes(message)
    ? message : "[redacted upstream message]";
}
class RpcFailure extends Error {
  constructor(readonly diagnostics: Partial<ExecutorProgressDiagnostics>) {
    super("Codex RPC failed.");
  }
}
function bounded(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_TEXT) return value;
  // The marker must fit inside the MAX_TEXT budget: its length plus the
  // newline separator is deducted from the retained content, so the final
  // string never exceeds MAX_TEXT.
  const retained = MAX_TEXT - TRUNCATION_MARKER.length - 1;
  return `${value.slice(0, retained)}\n${TRUNCATION_MARKER}`;
}
function hasRoutingValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class CodexExecutor implements Executor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private startedTurnId: string | undefined;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    method: string;
    reject: (error: RpcFailure) => void;
    timer: NodeJS.Timeout;
  }>();
  private beginInterrupt: (() => void) | undefined;
  private reportDiagnostics: ((changes: Partial<ExecutorProgressDiagnostics>) => void) | undefined;

  constructor(private readonly workspaceRoot: string, private readonly startProcess: ProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timing: ExecutorTiming & { readonly rpcCallTimeoutMs?: number } = DEFAULT_EXECUTOR_TIMING,
    private readonly routingPolicy: CodexRoutingPolicy = "inherit") {}

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const executorStartedAt = new Date().toISOString();
    let diagnostics: ExecutorProgressDiagnostics = {
      executor_started_at: executorStartedAt, protocol_phase: "process/start",
      last_activity_at: executorStartedAt, rpc_timeout: false
    };
    const report = (changes: Partial<ExecutorProgressDiagnostics>): void => {
      diagnostics = { ...diagnostics, ...changes };
      request.onDiagnostics?.({ ...diagnostics });
    };
    this.reportDiagnostics = report;
    report({});
    const withDiagnostics = (result: ExecutorResult): ExecutorResult => ({
      ...result,
      diagnostics: { ...diagnostics, executor_ended_at: new Date().toISOString() }
    });
    this.threadId = undefined;
    this.turnId = undefined;
    this.startedTurnId = undefined;
    if (this.routingPolicy === "explicit" &&
      (!hasRoutingValue(request.model) || !hasRoutingValue(request.reasoning_effort))) {
      this.reportDiagnostics = undefined;
      return withDiagnostics(failure("CODEX_ROUTING_REQUIRED"));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      const options: SpawnOptionsWithoutStdio = {
        cwd: this.workspaceRoot, shell: false, stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform !== "win32", env: environment(this.hostEnvironment)
      };
      // Windows: a directly spawnable codex.exe is preferred; an npm-installed
      // codex.cmd shim is resolved to the official bin/codex.js Node target and
      // launched through Node directly. Nothing here goes through a shell, and
      // the user instruction travels over stdin, never through the command
      // line. Everywhere else (and as the Windows fallback) the original bare
      // "codex" spawn is unchanged.
      const resolved = resolveCommand(this.hostEnvironment, "codex", {
        nodeTarget: CODEX_NODE_TARGET, platform: this.platform
      });
      if (resolved.kind === "direct") {
        child = this.startProcess(resolved.executable, ["app-server", "--stdio"], options);
      } else if (resolved.kind === "node-launcher") {
        child = this.startProcess(process.execPath, [resolved.scriptPath, "app-server", "--stdio"], options);
      } else {
        child = this.startProcess("codex", ["app-server", "--stdio"], options);
      }
      this.child = child;
    } catch {
      report({ failure_category: "process_error" });
      this.reportDiagnostics = undefined;
      return withDiagnostics(failure("CODEX_UNAVAILABLE"));
    }

    const evidence = new Map<string, ExecutorEvidence>();
    let evidenceDropped = 0;
    let output = "";
    let buffer = "";
    let earlyTurnNotifications: string[] = [];
    let earlyTurnBytes = 0;
    let terminal: ((result: ExecutorResult) => void) | undefined;
    let terminalPromise: Promise<ExecutorResult>;
    terminalPromise = new Promise((resolve) => { terminal = resolve; });
    let settled = false;
    let directExited = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let inactivityTimer: NodeJS.Timeout | undefined;
    let interruptTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitImmediate: NodeJS.Immediate | undefined;
    let terminationResult: ExecutorResult | undefined;
    let killSignalled = false;
    const rejectPending = (): void => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new RpcFailure({ failure_category: "process_exit", rpc_method: waiter.method }));
      }
      this.pending.clear();
    };
    const finish = (result: ExecutorResult): void => {
      if (settled) return;
      const finalResult = terminationResult?.kind === "interrupted"
        ? { ...terminationResult, output, evidence: visibleEvidence() }
        : terminationResult ?? result;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      if (interruptTimer !== undefined) clearTimeout(interruptTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (exitImmediate !== undefined) clearImmediate(exitImmediate);
      rejectPending();
      if (this.child === child) {
        this.child = undefined;
        this.turnId = undefined;
        this.startedTurnId = undefined;
        this.beginInterrupt = undefined;
        this.reportDiagnostics = undefined;
      }
      // Every protocol terminal event ends this one-shot app-server, including
      // a cooperative interrupt completion. Settling the Bridge task must not
      // leave a detached process tree alive.
      if (!killSignalled) {
        if (directExited) {
          signalProcessGroup(child, this.platform, "SIGTERM");
          signalProcessGroup(child, this.platform, "SIGKILL");
        } else {
          signalExecution(child, this.platform, "SIGTERM");
          signalExecution(child, this.platform, "SIGKILL");
        }
        killSignalled = true;
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      terminal?.(withDiagnostics(finalResult));
    };
    const stop = (result: ExecutorResult): void => {
      if (settled) return;
      terminationResult = result;
      signalExecution(child, this.platform, "SIGKILL");
      killSignalled = true;
      finish(result);
    };
    const unavailable = (): void => {
      if (settled || terminationResult !== undefined) return;
      report({ failure_category: "process_error" });
      stop(failure("CODEX_UNAVAILABLE"));
    };
    const protocolError = (kind = "invalid_message"): void => {
      if (settled || terminationResult !== undefined) return;
      report({ failure_category: "protocol_error", protocol_error_kind: kind });
      finish(failure("CODEX_PROTOCOL_ERROR"));
    };
    // The evidence view a supervisor receives. Real evidence and the synthetic
    // evidence-drop marker together never exceed MAX_EVIDENCE: the marker only
    // appears once real entries were evicted, and the eviction loop above
    // reserves its slot within the same budget. Rebuilt from a single counter,
    // it can never grow evidence unboundedly.
    const visibleEvidence = (): readonly ExecutorEvidence[] => {
      const items = [...evidence.values()];
      return evidenceDropped === 0
        ? items
        : [...items, {
          id: "evidence-drop",
          type: "commandExecution",
          status: "completed",
          command: `${evidenceDropped} evidence item(s) dropped: evidence limit exceeded`
        }];
    };
    const enforceEvidenceBudget = (): void => {
      while (evidence.size > 0 &&
        Buffer.byteLength(JSON.stringify(visibleEvidence()), "utf8") > MAX_EVIDENCE_BYTES) {
        evidence.delete(evidence.keys().next().value as string);
        evidenceDropped += 1;
      }
    };
    const currentTerminationResult = (): ExecutorResult =>
      terminationResult?.kind === "interrupted"
        ? {
          kind: "interrupted",
          output,
          ...(this.threadId === undefined ? {} : { threadId: this.threadId }),
          evidence: visibleEvidence()
        }
        : terminationResult ?? failure("CODEX_EXECUTION_FAILED");
    const forceKill = (): void => {
      signalExecution(child, this.platform, "SIGKILL", !directExited);
      killSignalled = true;
      finish(currentTerminationResult());
    };
    const sendTerm = (): void => {
      if (settled) return;
      signalExecution(child, this.platform, "SIGTERM");
      killTimer = setTimeout(forceKill, this.timing.killGraceMs);
    };
    const beginTermination = (result: ExecutorResult, cooperativeMs: number): void => {
      if (settled || terminationResult !== undefined) return;
      terminationResult = result;
      if (inactivityTimer !== undefined) {
        clearTimeout(inactivityTimer);
        inactivityTimer = undefined;
      }
      if (cooperativeMs === 0) sendTerm();
      else interruptTimer = setTimeout(sendTerm, cooperativeMs);
    };
    const startInactivityWatchdog = (): void => {
      if (settled || terminationResult !== undefined) return;
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => {
          report({ failure_category: "inactivity_timeout" });
          beginTermination(failure("EXECUTOR_STALLED"), 0);
        },
        this.timing.protocolInactivityTimeoutMs ?? DEFAULT_EXECUTOR_TIMING.protocolInactivityTimeoutMs ?? 2 * 60_000
      );
    };
    const resetInactivityWatchdog = (): void => {
      if (inactivityTimer !== undefined) startInactivityWatchdog();
    };
    const activeTurnActivity = (params: Record<string, unknown>): boolean => {
      return this.threadId !== undefined &&
        this.startedTurnId !== undefined &&
        params.threadId === this.threadId &&
        params.turnId === this.startedTurnId;
    };
    this.beginInterrupt = () => {
      if (settled || terminationResult !== undefined) return;
      const result: ExecutorResult = { kind: "interrupted", output, evidence: visibleEvidence() };
      if (this.threadId !== undefined) Object.assign(result, { threadId: this.threadId });
      if (this.threadId && this.startedTurnId) {
        // The protocol request is best-effort. Its response is not the terminal
        // signal, and its Promise must never hold control_task open.
        void this.call("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.startedTurnId
        }).catch((): void => {});
        beginTermination(result, this.timing.interruptGraceMs);
      } else {
        // initialize/thread-start/turn-start have no cooperative turn seam.
        beginTermination(result, 0);
      }
    };
    deadlineTimer = setTimeout(
      () => {
        if (settled || terminationResult !== undefined) return;
        report({ failure_category: "execution_deadline" });
        beginTermination(failure("CODEX_EXECUTION_FAILED"), 0);
      },
      this.timing.executionTimeoutMs
    );
    child.on("error", unavailable);
    child.stdin.on("error", unavailable);
    child.stdout.on("error", unavailable);
    child.stderr.on("error", unavailable);
    child.stderr.resume();
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const handleLine = (rawLine: string): void => {
      if (settled) return;
      if (Buffer.byteLength(rawLine, "utf8") > MAX_JSONL_LINE_BYTES) { protocolError("jsonl_line_too_large"); return; }
      const line = rawLine.trim();
      if (!line) return;
      let message: unknown;
      try { message = JSON.parse(line); } catch { protocolError("invalid_json"); return; }
      if (!object(message)) { protocolError(); return; }
      if ("id" in message) {
        if (!requestId(message.id)) { protocolError(); return; }
        if ("method" in message) {
          if (typeof message.method !== "string" || "result" in message || "error" in message) {
            protocolError(); return;
          }
          if (terminationResult === undefined) report({
            last_activity_at: new Date().toISOString(), last_valid_method: safeMethod(message.method),
            rpc_method: safeMethod(message.method), rpc_timeout: false, failure_category: "unsupported_server_request"
          });
          // Never approve, invoke tools, refresh credentials or elicit input.
          finish(failure("CODEX_EXECUTION_FAILED"));
          return;
        }
        if (("result" in message) === ("error" in message)) { protocolError(); return; }
        if ("error" in message && (!object(message.error) ||
          typeof message.error.code !== "number" || !Number.isInteger(message.error.code) ||
          typeof message.error.message !== "string")) { protocolError(); return; }
        const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        report({ last_activity_at: new Date().toISOString(),
          ...(waiter ? { last_valid_method: waiter.method } : {}) });
        if (waiter) {
          // Bind identities before dispatching the next line in the same chunk.
          // Promise continuations run later than coalesced notifications.
          if ("result" in message && ["thread/start", "thread/resume", "turn/start"].includes(waiter.method)) {
            const result = object(message.result) ? message.result : undefined;
            const value = waiter.method === "turn/start" ? result?.turn : result?.thread;
            if (!object(value) || typeof value.id !== "string" || !value.id) {
              protocolError("response_shape"); return;
            }
            if (waiter.method === "turn/start") {
              this.turnId = value.id;
              report({ protocol_phase: "turn/active" });
              startInactivityWatchdog();
            } else this.threadId = value.id;
          }
          this.pending.delete(message.id as number);
          clearTimeout(waiter.timer);
          if (object(message.error)) {
            const error = new RpcFailure({ failure_category: "rpc_error",
              rpc_method: waiter.method, rpc_timeout: false,
              upstream_error_code: message.error.code as number,
              upstream_error_message: safeRpcMessage(message.error.message as string) });
            waiter.reject(error);
            if (waiter.method !== "turn/steer" && waiter.method !== "turn/interrupt" && terminationResult === undefined) {
              report(error.diagnostics);
              finish(failure("CODEX_EXECUTION_FAILED"));
            }
          } else {
            waiter.resolve(message.result);
            if (waiter.method === "turn/start") {
              const early = earlyTurnNotifications;
              earlyTurnNotifications = [];
              earlyTurnBytes = 0;
              for (const notification of early) {
                if (settled) break;
                handleLine(notification);
              }
            }
          }
        }
        return;
      }
      if (typeof message.method !== "string" || "result" in message || "error" in message) { protocolError(); return; }
      report({ last_activity_at: new Date().toISOString(), last_valid_method: safeMethod(message.method) });
      // The notification envelope permits any JSON params, including omission.
      // Validate only the methods whose fields the executor actually consumes.
      const known = ["turn/started", "turn/completed", "item/started", "item/completed"].includes(message.method);
      if (!object(message.params)) {
        if (known) protocolError();
        return;
      }
      // Core events can precede the turn/start response. Defer only the
      // consumed methods, within a fixed byte budget, until its ID is known.
      if (known && this.turnId === undefined && message.params.threadId === this.threadId &&
        [...this.pending.values()].some((waiter) => waiter.method === "turn/start")) {
        earlyTurnBytes += Buffer.byteLength(rawLine, "utf8");
        if (earlyTurnBytes > MAX_JSONL_LINE_BYTES) { protocolError("pre_response_events_limit"); return; }
        earlyTurnNotifications.push(rawLine);
        return;
      }
      if (activeTurnActivity(message.params)) resetInactivityWatchdog();
      if (message.method === "turn/started" || message.method === "turn/completed") {
        if (typeof message.params.threadId !== "string" || !object(message.params.turn) ||
          typeof message.params.turn.id !== "string" || !message.params.turn.id) { protocolError(); return; }
      }
      if (message.method === "turn/started") {
        const turn = message.params.turn as Record<string, unknown>;
        if (message.params.threadId === this.threadId &&
          typeof turn.id === "string" &&
          turn.id === this.turnId) {
          this.startedTurnId = turn.id;
          startInactivityWatchdog();
        }
      }
      const item = object(message.params.item) ? message.params.item : undefined;
      if (message.method === "item/started" || message.method === "item/completed") {
        if (!item) { protocolError(); return; }
        if (this.turnId === undefined || message.params.threadId !== this.threadId ||
          message.params.turnId !== this.turnId) return;
        if (item.type === "agentMessage") {
          if (message.method === "item/completed" && typeof item.text !== "string") { protocolError(); return; }
          if (typeof item.text === "string") output = item.text;
        }
        const id = typeof item.id === "string" ? item.id : undefined;
        if (id && (item.type === "commandExecution" || item.type === "fileChange")) {
          const status = typeof item.status === "string" ? item.status : message.method === "item/started" ? "inProgress" : "completed";
          let entry: ExecutorEvidence;
          if (item.type === "commandExecution") entry = { id, type: item.type, status, command: bounded(item.command) };
          else {
            const rawChanges = Array.isArray(item.changes) ? item.changes : [];
            // The 50-entry bound includes the synthetic truncation marker: a
            // truncated list keeps 49 real entries and spends the 50th slot
            // on the marker, so the final list never exceeds the bound.
            const kept = rawChanges.length > 50 ? 49 : 50;
            const changes = rawChanges.slice(0, kept).filter(object).map((c) => ({ path: bounded(c.path), diff: bounded(c.diff) }));
            if (rawChanges.length > 50) {
              // omitted counts exactly the real changes that were never
              // returned to the supervisor.
              changes.push({ path: `[truncated: ${rawChanges.length - kept} additional changes omitted]`, diff: "" });
            }
            entry = { id, type: item.type, status, changes };
          }
          evidence.set(id, entry);
          // The MAX_EVIDENCE budget includes the evidence-drop marker: once
          // any drop has happened the marker reserves one slot within the
          // same budget, so the final visible list never exceeds
          // MAX_EVIDENCE entries.
          while (evidence.size + (evidenceDropped > 0 ? 1 : 0) > MAX_EVIDENCE) {
            evidence.delete(evidence.keys().next().value as string);
            evidenceDropped += 1;
          }
          enforceEvidenceBudget();
          request.onEvidence?.(visibleEvidence());
        }
      }
      if (message.method === "turn/completed") {
        const turn = message.params.turn as Record<string, unknown>;
        if (message.params.threadId !== this.threadId ||
          typeof turn.id !== "string" ||
          turn.id !== (this.startedTurnId ?? this.turnId)) return;
        const status = turn.status;
        const common = { threadId: this.threadId, evidence: visibleEvidence() };
        if (status === "failed") {
          if (terminationResult === undefined) report({ failure_category: "turn_failed" });
          finish({ ...failedTurn(turn), ...common });
        }
        else if (status === "interrupted") finish({ kind: "interrupted", output, ...common });
        else if (status === "completed") finish({ kind: "completed", output, ...common });
        else protocolError();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      try { buffer += stdoutDecoder.decode(chunk, { stream: true }); }
      catch { protocolError("invalid_utf8"); return; }
      let newline: number;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
      if (!settled && Buffer.byteLength(buffer, "utf8") > MAX_JSONL_LINE_BYTES) protocolError("jsonl_line_too_large");
    });
    const flushFinalLine = (): void => {
      if (settled) return;
      try { buffer += stdoutDecoder.decode(); }
      catch { protocolError("invalid_utf8"); return; }
      const line = buffer;
      buffer = "";
      if (line) handleLine(line);
    };
    child.stdout.on("end", flushFinalLine);
    const finishFromExit = (code: number | null): void => {
      if (settled) return;
      report({ process_exit_code: code });
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      directExited = true;
      if (terminationResult === undefined) report({ failure_category: "process_exit" });
      // The app-server can no longer answer. Reject RPC callers immediately;
      // descendant cleanup may continue for the bounded kill grace below.
      rejectPending();
      const result = terminationResult ?? failure("CODEX_EXECUTION_FAILED");
      terminationResult = result;
      if (signalProcessGroup(child, this.platform, "SIGTERM")) {
        if (killTimer === undefined) killTimer = setTimeout(forceKill, this.timing.killGraceMs);
        return;
      }
      finish(currentTerminationResult());
    };
    child.on("exit", (code) => {
      // `close` can be withheld indefinitely by descendants that inherited an
      // app-server pipe. Drain already-delivered events once, then settle from
      // the direct child's exit and reject every outstanding RPC.
      directExited = true;
      exitImmediate = setImmediate(() => {
        exitImmediate = undefined;
        finishFromExit(code);
      });
    });
    child.on("close", finishFromExit);

    try {
      await this.call("initialize", { clientInfo: { name: "engineering-bridge", version: VERSION } });
      if (settled) return terminalPromise;
      this.notify("initialized", {});
      if (request.model !== undefined || request.reasoning_effort !== undefined) {
        const modelResult = await this.call("model/list", {});
        if (!object(modelResult) || !Array.isArray(modelResult.data)) throw new Error();
        const models = modelResult.data.filter((entry): entry is Record<string, unknown> =>
          object(entry) && typeof entry.model === "string"
        );
        const selected = request.model !== undefined
          ? models.find((entry) => entry.model === request.model)
          : models.find((entry) => entry.isDefault === true);
        if (!selected) throw new CoreError("UNSUPPORTED_ACTION");
        if (request.reasoning_effort !== undefined) {
          const efforts = Array.isArray(selected.supportedReasoningEfforts)
            ? selected.supportedReasoningEfforts
            : [];
          if (!efforts.some((effort) => object(effort) && effort.reasoningEffort === request.reasoning_effort)) {
            throw new CoreError("UNSUPPORTED_ACTION");
          }
        }
      }
      const sandbox = request.sandbox ?? "read-only";
      const threadParams: Record<string, unknown> = { cwd: this.workspaceRoot, approvalPolicy: "never", sandbox };
      if (request.threadId) threadParams.threadId = request.threadId;
      await this.call(request.threadId ? "thread/resume" : "thread/start", threadParams);
      if (settled) return terminalPromise;
      const sandboxPolicy = sandbox === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [this.workspaceRoot], networkAccess: false }
        : { type: "readOnly", networkAccess: false };
      const turnParams: Record<string, unknown> = {
        threadId: this.threadId, input: [{ type: "text", text: request.instruction }],
        cwd: this.workspaceRoot, approvalPolicy: "never", sandboxPolicy
      };
      if (request.model !== undefined) turnParams.model = request.model;
      if (request.reasoning_effort !== undefined) turnParams.effort = request.reasoning_effort;
      await this.call("turn/start", turnParams);
      if (!settled) report({ protocol_phase: "turn/active" });
    } catch (error) {
      if (!settled && terminationResult === undefined) {
        if (error instanceof RpcFailure) {
          report(error.diagnostics);
          finish(failure("CODEX_EXECUTION_FAILED"));
        } else if (error instanceof CoreError && error.code === "UNSUPPORTED_ACTION") {
          report({ failure_category: "unsupported_selection" });
          finish({ kind: "failed", error: serializeError(error) });
        } else protocolError();
      }
    }
    return terminalPromise;
  }

  async steer(instruction: string): Promise<void> {
    if (!this.threadId || !this.startedTurnId) throw new CoreError("INVALID_STATE_TRANSITION");
    await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.startedTurnId, input: [{ type: "text", text: instruction }] });
  }
  async interrupt(): Promise<void> {
    if (!this.child || !this.beginInterrupt) throw new CoreError("INVALID_STATE_TRANSITION");
    this.beginInterrupt();
  }
  private call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.reportDiagnostics?.({ protocol_phase: method, rpc_method: method, rpc_timeout: false });
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.stdin.destroyed) {
        reject(new RpcFailure({ failure_category: "process_error", rpc_method: method }));
        return;
      }
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        waiter.reject(new RpcFailure({ failure_category: "rpc_timeout", rpc_method: method, rpc_timeout: true }));
      }, this.timing.rpcCallTimeoutMs ?? DEFAULT_RPC_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RpcFailure({ failure_category: "process_error", rpc_method: method }));
      }
    });
  }
  private notify(method: string, params: unknown): void { this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
}
