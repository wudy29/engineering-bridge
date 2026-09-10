import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError, serializeError } from "../core/errors.js";
import { resolveCommand } from "./command-resolution.js";
import {
  DEFAULT_EXECUTOR_TIMING,
  signalExecution,
  signalProcessGroup,
  type Executor,
  type ExecutorRequest,
  type ExecutorResult,
  type ExecutorTiming
} from "./executor.js";

export type DshProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

const ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "DSH_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  // Sanctioned DSH passthroughs only. DEEPSEEK_API_KEY feeds DSH's native
  // credential layer and DSH_TOOLS_MODE is a profile-composition input; both
  // are consumed by the DSH main process and scrubbed from its model-callable
  // subprocesses. Proxies (which may embed credentials and are visible to
  // model subprocesses) and any other secret-like variables stay out.
  "DEEPSEEK_API_KEY",
  "DSH_TOOLS_MODE"
] as const;
const MAX_OUTPUT_BYTES = 1_048_576;
const TRUNCATION_MARKER = "[output truncated]";
const TRUNCATION_SEPARATOR = `\n${TRUNCATION_MARKER}\n`;
const HEAD_OUTPUT_BYTES = 768 * 1024;
const TAIL_OUTPUT_BYTES = MAX_OUTPUT_BYTES - HEAD_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_SEPARATOR);
// npm target of the official DSH package, derived from a dsh.cmd shim's
// location so a Windows npm install can be launched through Node directly
// (never through a shell carrying the user-controlled instruction).
const DSH_NODE_TARGET = ["@deepseek-ai", "dsh", "lib", "bin.js"] as const;

interface ActiveExecution {
  interrupted: boolean;
  beginInterrupt(): void;
}

function failure(code: "DSH_UNAVAILABLE" | "DSH_PROTOCOL_ERROR" | "DSH_EXECUTION_FAILED"): ExecutorResult {
  return { kind: "failed", error: serializeError(new CoreError(code)) };
}

// Strictly decodes a truncated stdout prefix. The truncation boundary may cut a
// multi-byte UTF-8 code point, so up to 3 incomplete trailing bytes are dropped
// to find the longest strictly valid prefix. Genuinely invalid UTF-8 before the
// boundary still fails every attempt and yields undefined.
function decodeTruncatedPrefix(chunks: readonly Buffer[]): string | undefined {
  const bytes = Buffer.concat(chunks);
  for (let drop = 0; drop <= 3; drop += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - drop));
    } catch {
      // Try the next shorter prefix.
    }
  }
  return undefined;
}

function decodeTruncatedTail(bytes: Buffer): string | undefined {
  for (let drop = 0; drop <= 3; drop += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(drop));
    } catch {
      // Try the next later start to skip an incomplete leading code point.
    }
  }
  return undefined;
}

function retainTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= TAIL_OUTPUT_BYTES) {
    return Buffer.from(chunk.subarray(chunk.length - TAIL_OUTPUT_BYTES));
  }
  const keepFromCurrent = Math.min(current.length, TAIL_OUTPUT_BYTES - chunk.length);
  return Buffer.concat([current.subarray(current.length - keepFromCurrent), chunk], keepFromCurrent + chunk.length);
}

function environment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) if (host[key]) result[key] = host[key];
  // Bridge owns the read-only boundary for its run_task calls. The host value
  // is never forwarded (the allowlist drops it) and this constant override pins
  // DSH's per-invocation sandbox policy (`sandboxPolicy.mode` reads
  // `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`) to read-only for
  // this child process only. Global DSH config and the headless profile are
  // untouched.
  result.DSH_PERMISSION_MODE = "read-only";
  return result;
}

function executableOnPath(host: Readonly<NodeJS.ProcessEnv>): string | undefined {
  for (const entry of host.PATH?.split(delimiter) ?? []) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, "dsh");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next fixed PATH entry.
    }
  }
  return undefined;
}

function installedRcLauncher(host: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const home = host.DSH_HOME
    ? resolve(host.DSH_HOME)
    : host.HOME
      ? join(resolve(host.HOME), ".dsh")
      : undefined;
  if (!home) return undefined;
  const launcher = join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  try {
    return statSync(launcher).isFile() ? launcher : undefined;
  } catch {
    return undefined;
  }
}

function invocation(host: Readonly<NodeJS.ProcessEnv>): { executable: string; args: string[] } {
  const args = ["--profile", "headless"];
  const executable = executableOnPath(host);
  if (executable) return { executable, args };
  const launcher = installedRcLauncher(host);
  return launcher
    ? { executable: process.execPath, args: [launcher, ...args] }
    : { executable: "dsh", args };
}

export class DshExecutor implements Executor {
  private active: ActiveExecution | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly startProcess: DshProcessStarter = spawn,
    private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly timing: ExecutorTiming = DEFAULT_EXECUTOR_TIMING
  ) {}

  private invocation(): { executable: string; args: string[] } {
    if (this.platform === "win32") {
      // Windows: prefer a directly spawnable dsh.exe; otherwise derive the npm
      // dsh.cmd shim's real Node target and launch it through Node directly, so
      // the user-controlled instruction travels as a plain argv element and is
      // never parsed by a shell. A shim without a derivable target fails closed
      // through the existing launcher/fallback chain (never through ComSpec).
      const resolved = resolveCommand(this.hostEnvironment, "dsh", {
        nodeTarget: DSH_NODE_TARGET, platform: this.platform
      });
      if (resolved.kind === "direct") return { executable: resolved.executable, args: ["--profile", "headless"] };
      if (resolved.kind === "node-launcher") return { executable: process.execPath, args: [resolved.scriptPath, "--profile", "headless"] };
      const launcher = installedRcLauncher(this.hostEnvironment);
      return launcher
        ? { executable: process.execPath, args: [launcher, "--profile", "headless"] }
        : { executable: "dsh", args: ["--profile", "headless"] };
    }
    // Non-Windows: the original resolution chain is unchanged.
    return invocation(this.hostEnvironment);
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const command = this.invocation();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.startProcess(command.executable, [...command.args, request.instruction], {
        cwd: this.workspaceRoot,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform !== "win32",
        env: environment(this.hostEnvironment)
      });
    } catch {
      return failure("DSH_UNAVAILABLE");
    }

    return new Promise<ExecutorResult>((resolveResult) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let tail = Buffer.alloc(0);
      let settled = false;
      let directExited = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let exitImmediate: NodeJS.Immediate | undefined;
      let terminationResult: ExecutorResult | undefined;
      let active!: ActiveExecution;
      const currentTerminationResult = (): ExecutorResult =>
        terminationResult?.kind === "interrupted"
          ? { kind: "interrupted", output: this.retainedOutput(chunks, bytes, truncated, tail) ?? "" }
          : terminationResult ?? failure("DSH_EXECUTION_FAILED");
      const finish = (result: ExecutorResult): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (exitImmediate !== undefined) clearImmediate(exitImmediate);
        if (this.active === active) this.active = undefined;
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        resolveResult(result);
      };
      const stop = (result: ExecutorResult): void => {
        if (settled) return;
        signalExecution(child, this.platform, "SIGKILL");
        finish(result);
      };
      const forceKill = (): void => {
        signalExecution(child, this.platform, "SIGKILL", !directExited);
        finish(currentTerminationResult());
      };
      const beginTermination = (result: ExecutorResult): void => {
        if (settled || terminationResult !== undefined) return;
        terminationResult = result;
        signalExecution(child, this.platform, "SIGTERM");
        killTimer = setTimeout(forceKill, this.timing.killGraceMs);
      };
      active = {
        interrupted: false,
        beginInterrupt: () => {
          if (active.interrupted) return;
          active.interrupted = true;
          beginTermination({ kind: "interrupted", output: this.retainedOutput(chunks, bytes, truncated, tail) ?? "" });
        }
      };
      this.active = active;
      deadlineTimer = setTimeout(() => beginTermination(failure("DSH_EXECUTION_FAILED")), this.timing.executionTimeoutMs);

      child.on("error", () => stop(failure("DSH_UNAVAILABLE")));
      child.stdin.on("error", () => stop(failure("DSH_UNAVAILABLE")));
      child.stdout.on("error", () => stop(failure("DSH_PROTOCOL_ERROR")));
      child.stderr.on("error", () => stop(failure("DSH_EXECUTION_FAILED")));
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) {
          // Keep consuming every chunk so the child can exit naturally, while
          // retaining only the fixed-size suffix needed for completed output.
          tail = retainTail(tail, chunk);
          return;
        }
        const remaining = MAX_OUTPUT_BYTES - bytes;
        if (chunk.length > remaining) {
          truncated = true;
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          bytes = MAX_OUTPUT_BYTES;
          tail = retainTail(Buffer.concat(chunks), chunk.subarray(remaining));
          return;
        }
        bytes += chunk.length;
        chunks.push(chunk);
      });
      const finishFromExit = (code: number | null): void => {
        if (settled) return;
        directExited = true;
        if (terminationResult !== undefined) {
          // If the direct child exited but its process group still exists, a
          // descendant is alive. Keep the existing TERM->KILL bound; otherwise
          // the requested termination is already complete.
          if (signalProcessGroup(child, this.platform, "SIGTERM")) {
            if (killTimer === undefined) killTimer = setTimeout(forceKill, this.timing.killGraceMs);
          } else {
            finish(currentTerminationResult());
          }
          return;
        }
        if (code !== 0) {
          finish(failure("DSH_EXECUTION_FAILED"));
          return;
        }
        finish(this.completedResult(chunks, bytes, truncated, tail));
      };
      child.on("exit", (code) => {
        // `close` waits for every inherited stdio handle. A descendant can keep
        // those pipes open after the direct DSH child has exited, so let data
        // already queued for this turn drain once and then settle from `exit`.
        directExited = true;
        exitImmediate = setImmediate(() => {
          exitImmediate = undefined;
          if (signalProcessGroup(child, this.platform, "SIGTERM")) {
            if (terminationResult === undefined) {
              terminationResult = code === 0
                ? this.completedResult(chunks, bytes, truncated, tail)
                : failure("DSH_EXECUTION_FAILED");
            }
            if (killTimer === undefined) killTimer = setTimeout(forceKill, this.timing.killGraceMs);
            return;
          }
          finishFromExit(code);
        });
      });
      child.on("close", finishFromExit);
      child.stdin.end();
    });
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (active === undefined) throw new CoreError("INVALID_STATE_TRANSITION");
    active.beginInterrupt();
  }

  private retainedOutput(
    chunks: readonly Buffer[],
    bytes: number,
    truncated: boolean,
    tail: Buffer
  ): string | undefined {
    if (bytes === 0) return "";
    if (truncated) {
      const prefix = decodeTruncatedPrefix([Buffer.concat(chunks).subarray(0, HEAD_OUTPUT_BYTES)]);
      const suffix = decodeTruncatedTail(tail);
      return prefix === undefined || suffix === undefined
        ? undefined
        : `${prefix}${TRUNCATION_SEPARATOR}${suffix}`;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      return undefined;
    }
  }

  private completedResult(chunks: readonly Buffer[], bytes: number, truncated: boolean, tail: Buffer): ExecutorResult {
    const output = this.retainedOutput(chunks, bytes, truncated, tail);
    if (output === undefined) return failure("DSH_PROTOCOL_ERROR");
    if (truncated) return { kind: "completed", output };
    return output.endsWith("\n")
      ? { kind: "completed", output: output.slice(0, -1) }
      : { kind: "completed", output };
  }
}
