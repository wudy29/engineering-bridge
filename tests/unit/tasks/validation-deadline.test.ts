import assert from "node:assert/strict";
import test from "node:test";
import { scheduleDeadline, secondsToMilliseconds, type DeadlineTimer } from "../../../src/tasks/validation-deadline.js";

class Clock implements DeadlineTimer {
  current = 0n;
  next = 1;
  readonly pending = new Map<NodeJS.Timeout, { at: bigint; callback: () => void }>();
  readonly delays: number[] = [];
  now() { return this.current; }
  set(callback: () => void, delay: number) {
    assert.ok(Number.isInteger(delay) && delay >= 1 && delay <= 2147483647);
    this.delays.push(delay);
    const handle = this.next++ as unknown as NodeJS.Timeout;
    this.pending.set(handle, { at: this.current + BigInt(delay), callback });
    return handle;
  }
  clear(handle: NodeJS.Timeout) { this.pending.delete(handle); }
  fire() {
    const [handle, entry] = this.pending.entries().next().value!;
    this.pending.delete(handle); entry.callback();
  }
  advance(to: bigint) {
    this.current = to;
    while ([...this.pending.values()].some(entry => entry.at <= to)) this.fire();
  }
}

for (const interval of [600000n, 1200000n, 2147483646n, 2147483647n, 2147483648n,
  4294967295n, 9007199254740991000n]) {
  test(`F06 exact monotonic deadline ${interval}ms, with bounded timer and no residue`, () => {
    const clock = new Clock(); clock.current = 27n;
    let expired = 0;
    const deadline = clock.current + interval;
    const cancel = scheduleDeadline(clock, deadline, () => { expired++; });
    clock.advance(deadline - 1n);
    assert.equal(expired, 0); assert.equal(clock.pending.size, 1);
    clock.advance(deadline);
    assert.equal(expired, 1); assert.equal(clock.pending.size, 0);
    clock.advance(deadline + 2147483647n); cancel(); cancel();
    assert.equal(expired, 1); assert.equal(clock.pending.size, 0);
  });
}

test("F06 seconds conversion preserves the maximum accepted integer exactly", () => {
  assert.equal(secondsToMilliseconds(Number.MAX_SAFE_INTEGER), 9007199254740991000n);
});
test("F06 early ticks rearm; cancellation suppresses stale callbacks and is idempotent", () => {
  const clock = new Clock(); let expired = 0;
  const cancel = scheduleDeadline(clock, 2147483648n, () => { expired++; });
  clock.fire(); // A spurious early timer must not expire the absolute deadline.
  assert.equal(expired, 0); assert.equal(clock.pending.size, 1);
  clock.advance(2147483647n);
  assert.equal(clock.delays.at(-1), 1);
  const stale = [...clock.pending.values()][0]!.callback;
  cancel(); cancel(); clock.current = 2147483648n; stale(); stale();
  assert.equal(expired, 0); assert.equal(clock.pending.size, 0);
});
test("F06 expiry remains asynchronous and terminal when the callback throws", () => {
  const clock = new Clock(); let expired = 0;
  const cancel = scheduleDeadline(clock, 0n, () => { expired++; throw new Error("callback"); });
  assert.equal(expired, 0);
  const stale = [...clock.pending.values()][0]!.callback;
  assert.throws(() => clock.advance(1n), /callback/);
  stale(); cancel();
  assert.equal(expired, 1); assert.equal(clock.pending.size, 0);
});
