import assert from "node:assert/strict";
import test from "node:test";

import {
  createObservationPublisher, type ObservationEnvelope, type ObservationPublisher,
} from "../../../src/observability/observation-publisher.js";
import { ObservationStore } from "../../../src/observability/observation-store.js";
import {
  startObservationProducer, startProducerHeartbeat,
} from "../../../src/observability/producer-heartbeat.js";

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test("producer samples immediately and every 5000ms with stable identity, advancing sequence/time, and unref", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-20T00:00:00Z") });
  let tick!: () => void;
  let unrefs = 0;
  let clears = 0;
  const timer = { unref() { unrefs++; return this; } } as NodeJS.Timeout;
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
    assert.equal(delay, 5000);
    tick = callback;
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (handle: NodeJS.Timeout) => {
    assert.equal(handle, timer);
    clears++;
  });
  const seen: ObservationEnvelope[] = [];
  let admitted = 0;
  let stops = 0;
  const sink = createObservationPublisher("p", async text => { seen.push(JSON.parse(text)); });
  const publisher: ObservationPublisher = {
    publish(value) { admitted++; sink.publish(value); },
    stop() { stops++; sink.stop(); },
  };
  const heartbeat = startProducerHeartbeat(publisher, "p", "test-version");
  t.after(() => heartbeat.stop());
  assert.equal(admitted, 1, "initial admission is immediate");
  assert.equal(unrefs, 1);
  await turn();
  t.mock.timers.tick(5000);
  tick();
  await turn();
  t.mock.timers.tick(5000);
  tick();
  await turn();
  assert.deepEqual(seen.map(x => x.sequence), [1, 2, 3]);
  assert.deepEqual(seen.map(x => x.observed_at), [
    "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:05.000Z", "2026-09-20T00:00:10.000Z",
  ]);
  for (const record of seen) {
    assert.equal(record.producer_id, "p");
    assert.equal(record.record_id, "p");
    assert.equal(record.kind, "producer");
    assert.deepEqual(record.metadata, {
      pid: process.pid, bridge_version: "test-version", started_at: "2026-09-20T00:00:00.000Z",
    });
  }
  assert.equal(heartbeat.stop(), undefined);
  heartbeat.stop();
  tick();
  await turn();
  assert.equal(admitted, 3);
  assert.equal(stops, 1);
  assert.equal(clears, 1);
});

test("each Bridge producer gets its own UUID without waiting for storage", async t => {
  const seen: ObservationEnvelope[] = [];
  t.mock.method(ObservationStore.prototype, "write", async (text: string) => {
    seen.push(JSON.parse(text));
  });
  const first = startObservationProducer("unused", [], "test");
  const second = startObservationProducer("unused", [], "test");
  t.after(() => { first.stop(); second.stop(); });
  assert.equal(seen.length, 0);
  await turn();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0]!.producer_id, seen[1]!.producer_id);
  for (const record of seen) {
    assert.match(record.producer_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(record.record_id, record.producer_id);
    assert.equal(record.sequence, 1);
  }
});

test("publisher and timer startup failures cannot escape producer startup or stop", t => {
  let stops = 0;
  t.mock.method(globalThis, "setInterval", () => { throw new Error("timer unavailable"); });
  let producer!: { stop(): void };
  assert.doesNotThrow(() => {
    producer = startProducerHeartbeat({
      publish() { throw new Error("publisher unavailable"); },
      stop() { stops++; throw new Error("stop unavailable"); },
    }, "p", "test");
  });
  assert.doesNotThrow(() => { producer.stop(); producer.stop(); });
  assert.equal(stops, 1);
});
