import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";

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
      readonly kind: "timeout" | "spawn_error" | "signal" | "termination_error";
      readonly durationMs: number;
      readonly outputTail: string;
    };

export interface ValidationProcessRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly input?: string;
}

export type ValidationProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface ValidationTimer {
  now(): number;
  set(callback: () => void, delayMs: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

const startProcess: ValidationProcessStarter = (executable, args, options) =>
  spawn(executable, args, options);

const systemTimer: ValidationTimer = {
  now: () => Date.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle)
};

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
  | { readonly kind: "timeout" | "spawn_error" | "signal" | "termination_error" };

export class ValidationProcessRunner {
  constructor(
    private readonly start: ValidationProcessStarter = startProcess,
    private readonly timer: ValidationTimer = systemTimer,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly signaler: typeof signalExecution = signalExecution
  ) {}

  run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    const startedAt = this.timer.now();

    return new Promise((resolve) => {
      let completed = false;
      let outputTail = Buffer.alloc(0);
      let terminationOutcome: "timeout" | "spawn_error" | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let terminationGraceHandle: NodeJS.Timeout | undefined;

      const complete = (completion: Completion): void => {
        if (completed) {
          return;
        }
        completed = true;

        if (timeoutHandle !== undefined) {
          this.timer.clear(timeoutHandle);
          timeoutHandle = undefined;
        }

        if (terminationGraceHandle !== undefined) {
          this.timer.clear(terminationGraceHandle);
          terminationGraceHandle = undefined;
        }

        const durationMs = this.timer.now() - startedAt;
        const normalizedTail = decodeTail(outputTail);

        if (completion.kind === "exit") {
          resolve({
            kind: "exit",
            exitCode: completion.exitCode,
            durationMs,
            outputTail: normalizedTail
          });
          return;
        }

        resolve({
          kind: completion.kind,
          durationMs,
          outputTail: normalizedTail
        });
      };

      const [executable, ...args] = request.argv;
      let child: ChildProcessWithoutNullStreams;

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
          this.signaler(child, this.platform, signal);
        } catch {
          // The grace periods bound termination even when signaling throws.
        }
      };

      const beginTermination = (
        outcome: "timeout" | "spawn_error"
      ): void => {
        if (completed || terminationOutcome !== undefined) {
          return;
        }
        terminationOutcome = outcome;

        if (timeoutHandle !== undefined) {
          this.timer.clear(timeoutHandle);
          timeoutHandle = undefined;
        }

        terminationGraceHandle = this.timer.set(() => {
          terminationGraceHandle = undefined;
          terminationGraceHandle = this.timer.set(() => {
            terminationGraceHandle = undefined;
            complete({ kind: "termination_error" });
          }, 1_000);
          signalChild("SIGKILL");
        }, 1_000);
        signalChild("SIGTERM");
      };

      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", () => {
        if (terminationOutcome === undefined) {
          complete({ kind: "spawn_error" });
        }
      });
      child.on("close", (exitCode) => {
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

      timeoutHandle = this.timer.set(() => {
        timeoutHandle = undefined;
        beginTermination("timeout");
      }, request.timeoutMs);

      try {
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
