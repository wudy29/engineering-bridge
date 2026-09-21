import { randomUUID } from "node:crypto";

import { createObservationPublisher, type ObservationPublisher } from "./observation-publisher.js";
import { ObservationStore } from "./observation-store.js";

export function startProducerHeartbeat(
  publisher: ObservationPublisher,
  producerId: string,
  bridgeVersion: string,
): ObservationPublisher {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const publish: ObservationPublisher["publish"] = observation => {
    if (stopped) return;
    try { publisher.publish(observation); }
    catch { /* Observation admission is best effort, including heartbeat samples. */ }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try { if (timer) clearInterval(timer); } catch { /* Best effort. */ }
    try { publisher.stop(); } catch { /* Never change shutdown semantics. */ }
  };
  try {
    const metadata = {
      pid: process.pid, bridge_version: bridgeVersion, started_at: new Date().toISOString(),
    };
    const sample = (): void => publish({ kind: "producer", record_id: producerId, metadata });
    sample();
    timer = setInterval(sample, 5000);
    timer.unref();
  } catch { stop(); }
  return { publish, stop };
}

/** Called only after MCP connect. Construction performs no filesystem I/O. */
export function startObservationProducer(
  configPath: string,
  protectedRoots: readonly string[],
  bridgeVersion: string,
): ObservationPublisher {
  let publisher: ObservationPublisher | undefined;
  try {
    const producerId = randomUUID();
    const store = new ObservationStore(configPath, protectedRoots);
    publisher = createObservationPublisher(producerId, encoded => store.write(encoded));
    return startProducerHeartbeat(publisher, producerId, bridgeVersion);
  } catch {
    try { publisher?.stop(); } catch { /* Optional startup only. */ }
    return { publish(): void {}, stop(): void {} };
  }
}
