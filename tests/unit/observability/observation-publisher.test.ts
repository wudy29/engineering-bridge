import assert from "node:assert/strict";
import test from "node:test";

import {
  createObservationPublisher, MAX_ENVELOPE_BYTES, MAX_PENDING_KEYS,
  type ObservationEnvelope, type ObservationWrite,
} from "../../../src/observability/observation-publisher.js";

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const write = (id: string, value = 1, kind = "sample"): ObservationWrite => ({
  kind, record_id: id, metadata: { value },
});
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("admission is void and deferred; one write is in flight and newest values coalesce by both keys", async () => {
  const gate = deferred();
  const seen: ObservationEnvelope[] = [];
  let active = 0;
  let maximum = 0;
  const publisher = createObservationPublisher("p", async text => {
    active++;
    maximum = Math.max(maximum, active);
    seen.push(JSON.parse(text));
    if (seen.length === 1) await gate.promise;
    active--;
  });
  try {
    assert.equal(publisher.publish(write("first")), undefined);
    assert.equal(seen.length, 0, "publish does not enter the sink");
    await turn();
    publisher.publish(write("same", 1));
    publisher.publish(write("same", 2));
    publisher.publish(write("same", 3, "other"));
    await turn();
    assert.equal(seen.length, 1);
    gate.resolve();
    for (let i = 0; i < 5; i++) await turn();
    assert.deepEqual(seen.map(x => [x.kind, x.record_id, x.metadata.value]), [
      ["sample", "first", 1], ["sample", "same", 2], ["other", "same", 3],
    ]);
    assert.equal(maximum, 1);
  } finally { gate.resolve(); publisher.stop(); }
});

test("128 pending keys reserve a priority producer slot; replacements run before surviving ordinary entries", async () => {
  const gate = deferred();
  const seen: ObservationEnvelope[] = [];
  const publisher = createObservationPublisher("p", async text => {
    seen.push(JSON.parse(text));
    if (seen.length === 1) await gate.promise;
  });
  try {
    publisher.publish(write("in-flight"));
    await turn();
    for (let i = 0; i < 200; i++) publisher.publish(write(String(i)));
    publisher.publish(write("p", 1, "producer"));
    publisher.publish(write("p", 2, "producer"));
    publisher.publish(write("another-producer", 1, "producer"));
    await turn();
    assert.equal(seen.length, 1);
    publisher.publish(write("p", 3, "producer"));
    await turn();
    assert.equal(seen.length, 1, "producer replacements do not preempt the in-flight write");
    gate.resolve();
    await turn();
    await turn();
    assert.equal(seen[1]?.kind, "producer");
    assert.equal(seen[1]?.metadata.value, 3);
    for (let i = 0; i < MAX_PENDING_KEYS + 3; i++) await turn();
    assert.equal(seen.length, MAX_PENDING_KEYS + 1);
    assert.deepEqual(seen.slice(2).map(x => x.record_id),
      Array.from({ length: 127 }, (_, i) => String(i + 73)));
    assert.equal(seen.filter(x => x.kind === "producer").length, 1);
  } finally { gate.resolve(); publisher.stop(); }
});

test("encoded UTF-8 envelope bound includes metadata and serialization failures are contained", async () => {
  const seen: string[] = [];
  const now = () => "2026-09-20T00:00:00.000Z";
  const publisher = createObservationPublisher("p", async text => { seen.push(text); }, now);
  try {
    const empty: ObservationEnvelope = {
      schema_version: 1, producer_id: "p", sequence: 1, observed_at: now(),
      kind: "sample", record_id: "a", metadata: { value: "" },
    };
    const room = MAX_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(empty));
    publisher.publish({ kind: "sample", record_id: "a", metadata: { value: "x".repeat(room) } });
    publisher.publish({ kind: "sample", record_id: "b", metadata: { value: "é".repeat(room) } });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => publisher.publish({
      kind: "sample", record_id: "c", metadata: circular as ObservationWrite["metadata"],
    }));
    await turn();
    assert.equal(seen.length, 1);
    assert.equal(Buffer.byteLength(seen[0]!), MAX_ENVELOPE_BYTES);
  } finally { publisher.stop(); }
});

test("synchronous and asynchronous sink failures are dropped without retries", async () => {
  const seen: string[] = [];
  const publisher = createObservationPublisher("p", text => {
    const id = (JSON.parse(text) as ObservationEnvelope).record_id;
    seen.push(id);
    if (id === "sync") throw new Error("sync");
    if (id === "async") return Promise.reject(new Error("async"));
    return Promise.resolve();
  });
  try {
    publisher.publish(write("sync"));
    publisher.publish(write("async"));
    publisher.publish(write("ok"));
    for (let i = 0; i < 6; i++) await turn();
    assert.deepEqual(seen, ["sync", "async", "ok"]);
  } finally { publisher.stop(); }
});

test("stop cancels scheduled drain, drops pending, and never waits for in-flight persistence", async () => {
  let calls = 0;
  const gate = deferred();
  const publisher = createObservationPublisher("p", () => { calls++; return gate.promise; });
  publisher.publish(write("active"));
  await turn();
  publisher.publish(write("pending"));
  assert.equal(publisher.stop(), undefined);
  assert.doesNotThrow(() => publisher.stop());
  publisher.publish(write("late"));
  gate.reject(new Error("late failure"));
  await turn();
  await turn();
  assert.equal(calls, 1);
  const cancelled = createObservationPublisher("p", async () => { calls++; });
  cancelled.publish(write("cancelled"));
  cancelled.stop();
  await turn();
  assert.equal(calls, 1);
});
