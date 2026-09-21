export interface ObservationWrite {
  readonly kind: string;
  readonly record_id: string;
  // Internal, explicitly selected metadata only; never execution payloads.
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ObservationEnvelope extends ObservationWrite {
  readonly schema_version: 1;
  readonly producer_id: string;
  readonly sequence: number;
  readonly observed_at: string;
}

export interface ObservationPublisher {
  publish(observation: ObservationWrite): void;
  stop(): void;
}

export const MAX_PENDING_KEYS = 128;
export const MAX_ENVELOPE_BYTES = 16 * 1024;

/** Admission only. No caller awaits persistence, and no execution callback is used. */
export function createObservationPublisher(
  producerId: string,
  persist: (encoded: string) => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): ObservationPublisher {
  const pending = new Map<string, { producer: boolean; encoded: string }>();
  let sequence = 0;
  let stopped = false;
  let inFlight = false;
  let scheduled: NodeJS.Immediate | undefined;

  function schedule(): void {
    if (stopped || inFlight || scheduled || pending.size === 0) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      void drainOne();
    });
    scheduled.unref();
  }

  async function drainOne(): Promise<void> {
    if (stopped || inFlight) return;
    const next = [...pending.entries()].find(([, value]) => value.producer) ??
      pending.entries().next().value;
    if (!next) return;
    pending.delete(next[0]);
    inFlight = true;
    try { await persist(next[1].encoded); }
    catch { /* Observation loss cannot affect the Bridge. No retry. */ }
    finally {
      inFlight = false;
      try { schedule(); } catch { stop(); }
    }
  }

  function stop(): void {
    stopped = true;
    pending.clear();
    if (scheduled) {
      try { clearImmediate(scheduled); } catch { /* Best effort. */ }
      scheduled = undefined;
    }
    // An already-issued filesystem operation may finish; never flush or wait.
  }

  return {
    publish(observation): void {
      if (stopped) return;
      try {
        const { kind, record_id, metadata } = observation;
        if (!kind || !record_id) return;
        const producer = kind === "producer";
        if (producer && record_id !== producerId) return;
        const envelope: ObservationEnvelope = {
          schema_version: 1, producer_id: producerId,
          sequence: sequence + 1, observed_at: now(),
          kind, record_id, metadata,
        };
        const encoded = JSON.stringify(envelope);
        if (Buffer.byteLength(encoded, "utf8") > MAX_ENVELOPE_BYTES) return;
        const key = JSON.stringify([kind, record_id]);
        if (!pending.has(key) && !producer) {
          const entries = [...pending.entries()];
          if (entries.filter(([, value]) => !value.producer).length >= MAX_PENDING_KEYS - 1) {
            const oldest = entries.find(([, value]) => !value.producer);
            if (oldest) pending.delete(oldest[0]);
          }
        }
        sequence++;
        pending.delete(key);
        pending.set(key, { producer, encoded });
        schedule();
      } catch { /* Serialization/admission failures are observation loss only. */ }
    },
    stop,
  };
}
