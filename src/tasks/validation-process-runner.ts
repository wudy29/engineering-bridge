import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";

import { milliseconds, nowMilliseconds, scheduleDeadline, monotonicTimer, type DeadlineTimer } from "./validation-deadline.js";

import { signalExecution } from "../executors/executor.js";

const MAX_OUTPUT_TAIL_BYTES = 65_536;

export type ValidationProcessOutcome =
  | {
      readonly kind: "exit";
      readonly exitCode: number;
      readonly durationMs: number;
      readonly outputTail: string;
    }
  | {
      readonly kind: "timeout" | "spawn_error" | "signal" | "termination_error" | "aborted";
      readonly durationMs: number;
      readonly outputTail: string;
    };

export interface ValidationProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number | bigint;
  readonly input?: string;
}

export interface ValidationProcessControl {
  readonly signal: AbortSignal;
}
export type SupervisedValidationProcessOutcome = ValidationProcessOutcome & {
  readonly disposition: "not_started" | "quiescent" | "unknown";
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
};

export type ValidationProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export type ValidationTimer = DeadlineTimer;

const startProcess: ValidationProcessStarter = (executable, args, options) =>
  spawn(executable, args, options);

function appendTail(current: Buffer, chunk: Buffer | string): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

  if (incoming.length >= MAX_OUTPUT_TAIL_BYTES) {
    return Buffer.from(incoming.subarray(incoming.length - MAX_OUTPUT_TAIL_BYTES));
  }

  const retainedBytes = Math.min(
    current.length,
    MAX_OUTPUT_TAIL_BYTES - incoming.length
  );
  return Buffer.concat([
    current.subarray(current.length - retainedBytes),
    incoming
  ]);
}

function decodeTail(tail: Buffer): string {
  let start = 0;
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) {
    start++;
  }

  let end = tail.length;
  let lead = end - 1;
  while (lead >= start && (tail[lead]! & 0xc0) === 0x80) {
    lead--;
  }

  if (lead >= start) {
    const leadByte = tail[lead]!;
    const continuationBytes = end - lead - 1;
    const expectedContinuationBytes =
      leadByte >= 0xf0 && leadByte <= 0xf4 ? 3 :
      leadByte >= 0xe0 && leadByte <= 0xef ? 2 :
      leadByte >= 0xc2 && leadByte <= 0xdf ? 1 :
      0;

    if (
      expectedContinuationBytes > 0 &&
      continuationBytes < expectedContinuationBytes
    ) {
      end = lead;
    }
  }

  return tail.subarray(start, end).toString("utf8");
}

type Completion =
  | { readonly kind: "exit"; readonly exitCode: number }
  | { readonly kind: "timeout" | "spawn_error" | "signal" | "termination_error" | "aborted" };

export class ValidationProcessRunner {
  private readonly interruptions = new Map<() => void, Promise<void>>();
  private terminationUnconfirmed = false;

  constructor(
    private readonly start: ValidationProcessStarter = startProcess,
    private readonly timer: ValidationTimer = monotonicTimer,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly signaler: typeof signalExecution = signalExecution
  ) {}

  run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    return this.execute(request);
  }

  interrupt(): void {
    for (const interrupt of this.interruptions.keys()) interrupt();
  }

  async waitForCompletion(): Promise<void> {
    await Promise.all(this.interruptions.values());
    if (this.terminationUnconfirmed) throw new Error("Validation process shutdown could not be confirmed.");
  }

  runSupervised(request: ValidationProcessRequest, control: ValidationProcessControl): Promise<SupervisedValidationProcessOutcome> {
    if (this.platform === "win32") return Promise.resolve({
      kind: "spawn_error", disposition: "not_started", durationMs: 0,
      outputTail: "", stdout: "", stdoutTruncated: false,
    });
    return this.execute(request, control) as Promise<SupervisedValidationProcessOutcome>;
  }

  private execute(request: ValidationProcessRequest, control?: ValidationProcessControl): Promise<ValidationProcessOutcome> {
    const startedAt = nowMilliseconds(this.timer);

    return new Promise((resolve) => {
      let releaseFinished!: () => void;
      const finished = new Promise<void>(done => { releaseFinished = done; });
      let completed = false;
      let outputTail = Buffer.alloc(0);
      let terminationOutcome: "timeout" | "spawn_error" | "aborted" | "signal" | undefined;
      let cancelTimeout: (() => void) | undefined;
      let terminationGraceHandle: NodeJS.Timeout | undefined;
      let pollHandle: NodeJS.Timeout | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let childClosed = false;
      let childExited = false;
      let groupQuiescent = false;
      let stdout = Buffer.alloc(0);
      let stdoutTruncated = false;
      const groupGone = (): boolean => {
        if (groupQuiescent) return true;
        if (child?.pid === undefined || this.platform === "win32") return false;
        try { process.kill(-child.pid, 0); return false; }
        catch (error) { return groupQuiescent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      };

      const complete = (completion: Completion): void => {
        if (completed) {
          return;
        }
        completed = true;

        cancelTimeout?.();

        if (terminationGraceHandle !== undefined) {
          this.timer.clear(terminationGraceHandle);
          terminationGraceHandle = undefined;
        }
        if (pollHandle !== undefined) this.timer.clear(pollHandle);
        control?.signal.removeEventListener("abort", abort);
        this.interruptions.delete(abort);
        this.terminationUnconfirmed ||= completion.kind === "termination_error";
        releaseFinished();

        const durationMs = Number(nowMilliseconds(this.timer) - startedAt);
        const normalizedTail = decodeTail(outputTail);
        let machineOutput = "";
        if (control) {
          try { machineOutput = new TextDecoder("utf-8", { fatal: true }).decode(stdout); }
          catch { stdoutTruncated = true; }
        }
        const details = control === undefined ? {} : {
          disposition: child?.pid === undefined ? "not_started" as const : childClosed && groupGone() ? "quiescent" as const : "unknown" as const,
          stdout: machineOutput, stdoutTruncated,
        };
        if (child && (control && details.disposition === "unknown" ||
          this.platform !== "win32" && child.pid !== undefined && completion.kind === "termination_error")) {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        }
        const tail = control ? decodeTail(appendTail(Buffer.alloc(0), Buffer.from(normalizedTail))) : normalizedTail;

        if (completion.kind === "exit") {
          resolve({
            kind: "exit",
            exitCode: completion.exitCode,
            durationMs,
            outputTail: tail,
            ...details
          });
          return;
        }

        resolve({
          kind: completion.kind,
          durationMs,
          outputTail: tail,
          ...details
        });
      };

      const [executable, ...args] = request.argv;
      const abort = (): void => beginTermination("aborted");
      if (control?.signal.aborted) { complete({ kind: "aborted" }); return; }

      try {
        child = this.start(executable, args, {
          cwd: request.cwd,
          detached: this.platform !== "win32",
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        complete({ kind: "spawn_error" });
        return;
      }

      const capture = (chunk: Buffer | string): void => {
        if (!completed) {
          outputTail = appendTail(outputTail, chunk);
        }
      };

      const signalChild = (signal: NodeJS.Signals): void => {
        try {
          if (child && !groupQuiescent) this.signaler(child, this.platform, signal, !childExited);
        } catch {
          // The grace periods bound termination even when signaling throws.
        }
      };

      const beginTermination = (
        outcome: "timeout" | "spawn_error" | "aborted" | "signal"
      ): void => {
        if (completed || terminationOutcome !== undefined) {
          return;
        }
        terminationOutcome = outcome;

        cancelTimeout?.();

        terminationGraceHandle = this.timer.set(() => {
          terminationGraceHandle = undefined;
          terminationGraceHandle = this.timer.set(() => {
            terminationGraceHandle = undefined;
            complete({ kind: "termination_error" });
          }, 1_000);
          signalChild("SIGKILL");
        }, 1_000);
        signalChild("SIGTERM");
        if (this.platform !== "win32" && child?.pid !== undefined && !completed) {
          const poll = (): void => {
            pollHandle = undefined;
            if (completed) return;
            if (childClosed && groupGone()) { complete({ kind: terminationOutcome! }); return; }
            pollHandle = this.timer.set(poll, 20);
          };
          pollHandle = this.timer.set(poll, 20);
        }
      };

      this.interruptions.set(abort, finished);
      child.stdout.on("data", (chunk: Buffer | string) => {
        capture(chunk);
        if (control && !completed) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutTruncated ||= stdout.length + bytes.length > MAX_OUTPUT_TAIL_BYTES;
          stdout = Buffer.concat([stdout, bytes.subarray(0, MAX_OUTPUT_TAIL_BYTES - stdout.length)]);
        }
      });
      child.stderr.on("data", capture);
      child.on("error", () => {
        if (completed) return;
        if (this.platform !== "win32" && child?.pid !== undefined) { beginTermination("spawn_error"); return; }
        if (terminationOutcome === undefined) {
          complete({ kind: "spawn_error" });
        }
      });
      child.on("exit", () => {
        if (completed) return;
        childExited = true;
        if (this.platform !== "win32" && child?.pid !== undefined && !groupGone()) {
          beginTermination("signal");
        }
      });
      child.on("close", (exitCode) => {
        if (completed) return;
        childClosed = true;
        childExited = true;
        if (this.platform !== "win32" && child?.pid !== undefined && !groupGone()) {
          beginTermination(terminationOutcome ?? "signal");
          return;
        }
        if (terminationOutcome !== undefined) {
          complete({ kind: terminationOutcome });
          return;
        }

        complete(
          typeof exitCode === "number"
            ? { kind: "exit", exitCode }
            : { kind: "signal" }
        );
      });
      child.stdin.on("error", () => {
        beginTermination("spawn_error");
      });

      cancelTimeout = scheduleDeadline(this.timer, startedAt + milliseconds(request.timeoutMs), () => {
        beginTermination("timeout");
      });
      control?.signal.addEventListener("abort", abort, { once: true });
      if (control?.signal.aborted) abort();

      try {
        if (terminationOutcome !== undefined) return;
        if (request.input !== undefined) {
          child.stdin.write(request.input);
        }
        child.stdin.end();
      } catch {
        beginTermination("spawn_error");
      }
    });
  }
}
