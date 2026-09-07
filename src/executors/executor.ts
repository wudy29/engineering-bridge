import { execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Id } from "../core/ids.js";
import type { SerializedError } from "../core/errors.js";

export type SandboxMode = "read-only" | "workspace-write";

export interface EvidenceChange { readonly path: string; readonly diff: string }
export interface ExecutorEvidence {
  readonly id: string;
  readonly type: "commandExecution" | "fileChange";
  readonly status: string;
  readonly command?: string;
  readonly changes?: readonly EvidenceChange[];
}

export interface ExecutorRequest {
  readonly taskId: Id;
  readonly instruction: string;
  readonly sandbox?: SandboxMode;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly threadId?: string | undefined;
  readonly onEvidence?: (evidence: readonly ExecutorEvidence[]) => void;
  readonly onDiagnostics?: (diagnostics: ExecutorProgressDiagnostics) => void;
}

export interface ExecutorDiagnostics {
  readonly executor_started_at: string;
  readonly executor_ended_at: string;
  readonly protocol_phase?: string;
  readonly last_valid_method?: string;
  readonly last_activity_at?: string;
  readonly rpc_method?: string;
  readonly rpc_timeout?: boolean;
  readonly process_exit_code?: number | null;
  readonly failure_category?: string;
  readonly protocol_error_kind?: string;
  readonly upstream_error_code?: number;
  readonly upstream_error_message?: string;
}

export type ExecutorProgressDiagnostics = Omit<ExecutorDiagnostics, "executor_ended_at">;

export type ExecutorResult =
  | { readonly kind: "completed" | "interrupted"; readonly output: string; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[]; readonly diagnostics?: ExecutorDiagnostics }
  | { readonly kind: "failed"; readonly error: SerializedError; readonly threadId?: string | undefined; readonly evidence?: readonly ExecutorEvidence[]; readonly diagnostics?: ExecutorDiagnostics };

export interface Executor {
  execute(request: ExecutorRequest): Promise<ExecutorResult>;
  steer?(instruction: string): Promise<void>;
  interrupt?(): Promise<void>;
}

export interface ExecutorTiming {
  readonly executionTimeoutMs: number;
  readonly interruptGraceMs: number;
  readonly killGraceMs: number;
  readonly protocolInactivityTimeoutMs?: number;
}

export const DEFAULT_EXECUTOR_TIMING: ExecutorTiming = {
  executionTimeoutMs: 15 * 60_000,
  interruptGraceMs: 5_000,
  killGraceMs: 2_000,
  protocolInactivityTimeoutMs: 2 * 60_000
};

export function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals
): boolean {
  if (platform === "win32" || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export type WindowsTaskkill = (
  file: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly stdio: "ignore";
    readonly timeout: 1000;
    readonly windowsHide: true;
  }
) => void;

const defaultWindowsTaskkill: WindowsTaskkill = (file, args, options) => {
  execFileSync(file, args, options);
};

export function signalExecution(
  child: ChildProcessWithoutNullStreams,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
  directChildAlive = true,
  windowsTaskkill: WindowsTaskkill = defaultWindowsTaskkill
): boolean {
  if (signalProcessGroup(child, platform, signal)) return true;
  if (!directChildAlive) return false;
  if (platform === "win32") {
    const pid = child.pid;
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
      try {
        windowsTaskkill("taskkill", ["/PID", String(pid), "/T", "/F"], {
          shell: false,
          stdio: "ignore",
          timeout: 1000,
          windowsHide: true
        });
        return true;
      } catch {
        // Fall through to the existing direct-child signal path.
      }
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
