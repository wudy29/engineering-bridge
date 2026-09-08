export const ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_STATE_TRANSITION",
  "UNKNOWN_WORKSPACE",
  "WORKSPACE_BOUNDARY_VIOLATION",
  "WORKSPACE_PRECONDITION_FAILED",
  "APPLY_RECOVERY_CONFLICT",
  "CODEX_UNAVAILABLE",
  "CODEX_PROTOCOL_ERROR",
  "CODEX_EXECUTION_FAILED",
  "CODEX_ROUTING_REQUIRED",
  "EXECUTOR_STALLED",
  "DSH_UNAVAILABLE",
  "DSH_PROTOCOL_ERROR",
  "DSH_EXECUTION_FAILED",
  "TASK_INTERRUPTED",
  "UNSUPPORTED_ACTION"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SerializedError {
  code: ErrorCode;
  message: string;
}

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INTERNAL_ERROR: "The request could not be completed.",
  INVALID_STATE_TRANSITION: "The requested state transition is not allowed.",
  UNKNOWN_WORKSPACE: "The requested workspace is not registered.",
  WORKSPACE_BOUNDARY_VIOLATION: "The workspace boundary could not be verified.",
  WORKSPACE_PRECONDITION_FAILED: "The workspace preconditions were not met.",
  APPLY_RECOVERY_CONFLICT: "The applied patch state could not be recovered safely.",
  CODEX_UNAVAILABLE: "Codex is unavailable.",
  CODEX_PROTOCOL_ERROR: "Codex returned an invalid response.",
  CODEX_EXECUTION_FAILED: "Codex execution failed.",
  CODEX_ROUTING_REQUIRED: "Explicit model and reasoning_effort are required for Codex execution.",
  EXECUTOR_STALLED: "The executor stopped producing protocol activity.",
  DSH_UNAVAILABLE: "DSH is unavailable.",
  DSH_PROTOCOL_ERROR: "DSH returned an invalid response.",
  DSH_EXECUTION_FAILED: "DSH execution failed.",
  TASK_INTERRUPTED: "The task was interrupted.",
  UNSUPPORTED_ACTION: "The requested action is not supported."
};

function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CoreError";
  }
}

export function serializeError(error: unknown): SerializedError {
  const code = error instanceof CoreError && isErrorCode(error.code)
    ? error.code
    : "INTERNAL_ERROR";
  return {
    code,
    message: ERROR_MESSAGES[code]
  };
}
