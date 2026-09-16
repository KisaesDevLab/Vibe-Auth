import type { AuditEvent, AuditEventType, AuditSink } from "./adapters/types.js";

/** Console/JSON-lines sink; the default when a product supplies none. */
export const consoleAuditSink: AuditSink = {
  emit(event) {
    process.stdout.write(JSON.stringify({ level: "info", ...event }) + "\n");
  },
};

/** Fan-out to several sinks (e.g. product audit table + Sentinel webhook). */
export function combineAuditSinks(...sinks: AuditSink[]): AuditSink {
  return {
    async emit(event) {
      await Promise.allSettled(sinks.map((s) => Promise.resolve(s.emit(event))));
    },
  };
}

export function makeAudit(sink: AuditSink) {
  return async (type: AuditEventType, payload: Record<string, unknown> = {}): Promise<void> => {
    const event: AuditEvent = { type, at: new Date().toISOString(), ...payload };
    try {
      await sink.emit(event);
    } catch {
      // Audit failures must never break authentication.
    }
  };
}

export type Audit = ReturnType<typeof makeAudit>;
