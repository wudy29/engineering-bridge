import { performance } from "node:perf_hooks";

export interface DeadlineTimer {
  now(): number | bigint;
  set(callback: () => void, delayMs: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

export const monotonicTimer: DeadlineTimer = {
  now: () => performance.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle),
};

export function milliseconds(value: number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(Math.floor(value));
}

export function nowMilliseconds(timer: DeadlineTimer = monotonicTimer): bigint {
  return milliseconds(timer.now());
}

export function secondsToMilliseconds(seconds: number): bigint {
  // Convert before multiplying: the full accepted safe-integer seconds domain
  // exceeds Number's exact millisecond range.
  return BigInt(seconds) * 1000n;
}

/** One owned timer, bounded Node delays, and a monotonic absolute deadline. */
export function scheduleDeadline(timer: DeadlineTimer, deadlineMs: bigint, expired: () => void): () => void {
  const maximumDelay = 2147483647n;
  let handle: NodeJS.Timeout | undefined;
  let finished = false;
  const schedule = (): void => {
    const remaining = deadlineMs - nowMilliseconds(timer);
    handle = timer.set(tick, Number(remaining > maximumDelay ? maximumDelay : remaining > 0n ? remaining : 1n));
  };
  const tick = (): void => {
    handle = undefined;
    if (finished) return;
    if (nowMilliseconds(timer) < deadlineMs) { schedule(); return; }
    finished = true;
    expired();
  };
  schedule();
  return () => {
    if (finished) return;
    finished = true;
    if (handle !== undefined) { timer.clear(handle); handle = undefined; }
  };
}
