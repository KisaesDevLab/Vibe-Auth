import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditSink } from "@kisaes/vibe-auth";
import type { Authentik } from "./authentik.js";
import type { BrokerConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./log.js";

/**
 * Audit export (Phase 5): every broker event goes to Postgres (for the admin
 * UI), to a JSON-lines file, and optionally to Sentinel over HTTPS.
 * Authentik's own login/logout events are polled and forwarded in the §5 shape.
 */
export class BrokerAudit implements AuditSink {
  private queue: AuditEvent[] = [];
  private flushing = false;
  constructor(
    private cfg: BrokerConfig,
    private db: Db,
    private log: Logger,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  emit(event: AuditEvent): void {
    this.queue.push(event);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        const { type, at, ...payload } = e;
        try {
          await this.db.query("INSERT INTO vibe_broker_audit (at, type, payload) VALUES ($1, $2, $3::jsonb)", [at, type, JSON.stringify(payload)]);
        } catch (err) {
          this.log.error("audit db write failed", { error: (err as Error).message });
        }
        try {
          await mkdir(dirname(this.cfg.VIBE_AUTH_AUDIT_FILE), { recursive: true });
          await appendFile(this.cfg.VIBE_AUTH_AUDIT_FILE, JSON.stringify(e) + "\n");
        } catch (err) {
          this.log.warn("audit file write failed", { error: (err as Error).message });
        }
        if (this.cfg.VIBE_AUTH_SENTINEL_URL) await this.sendToSentinel(e);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendToSentinel(e: AuditEvent): Promise<void> {
    try {
      const res = await this.fetchImpl(this.cfg.VIBE_AUTH_SENTINEL_URL!, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.cfg.VIBE_AUTH_SENTINEL_TOKEN ? { "x-sentinel-token": this.cfg.VIBE_AUTH_SENTINEL_TOKEN, authorization: `Bearer ${this.cfg.VIBE_AUTH_SENTINEL_TOKEN}` } : {}) },
        body: JSON.stringify({ source: "vibe-auth", sentRuleId: ruleFor(e.type), severity: severityFor(e.type), timestamp: e.at, fields: e, raw: e }),
      });
      if (!res.ok) this.log.warn("sentinel webhook rejected", { status: res.status, type: e.type });
    } catch (err) {
      this.log.warn("sentinel webhook failed", { error: (err as Error).message });
    }
  }

  async recent(limit = 200, type?: string): Promise<AuditEvent[]> {
    const rows = type
      ? await this.db.query("SELECT at, type, payload FROM vibe_broker_audit WHERE type LIKE $2 ORDER BY at DESC LIMIT $1", [limit, type + "%"])
      : await this.db.query("SELECT at, type, payload FROM vibe_broker_audit ORDER BY at DESC LIMIT $1", [limit]);
    return rows.map((r) => ({ type: String(r.type) as AuditEvent["type"], at: new Date(r.at as string).toISOString(), ...(r.payload as Record<string, unknown>) }));
  }
}

function ruleFor(type: string): string {
  if (type.includes("breakglass")) return "SENT-V-AUTH-001";
  if (type.includes("login.failure")) return "SENT-V-AUTH-002";
  if (type.includes("mfa.enforcement")) return "SENT-V-AUTH-003";
  if (type.includes("mode.changed") || type.includes("registration")) return "SENT-V-AUTH-004";
  return "SENT-V-AUTH-000";
}
function severityFor(type: string): string {
  if (type.includes("breakglass") || type.includes("mfa.enforcement")) return "high";
  if (type.includes("failure") || type.includes("unreachable")) return "medium";
  return "info";
}

/** Poll authentik events and forward login/logout as vibe.auth.* (IdP perspective). */
export function startEventForwarder(cfg: BrokerConfig, ak: Authentik, db: Db, audit: BrokerAudit, log: Logger): () => void {
  if (!cfg.VIBE_AUTH_EVENT_POLL_SECONDS) return () => undefined;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      const since = (await db.getState<{ lastCreated: string }>("event_cursor"))?.lastCreated ?? new Date(Date.now() - 5 * 60_000).toISOString();
      const page = await ak.events({ ordering: "created", created__gt: since, page_size: 100 });
      let last = since;
      for (const ev of page.results) {
        const user = ev.user as { username?: string; email?: string; pk?: number };
        const base = { at: ev.created, ip: ev.client_ip, issuer: cfg.authentikPublicBase, sub: user?.pk, username: user?.username, email: user?.email, idp_event: ev.action };
        if (ev.action === "login") audit.emit({ type: "vibe.auth.login.success", ...base, method: "idp", amr: (ev.context as { auth_method?: string } | undefined)?.auth_method ? [String((ev.context as { auth_method?: string }).auth_method)] : [] });
        else if (ev.action === "login_failed") audit.emit({ type: "vibe.auth.login.failure", ...base, method: "idp", reason: "idp_login_failed" });
        else if (ev.action === "logout") audit.emit({ type: "vibe.auth.logout", ...base, method: "idp", initiated_by: "user" });
        if (ev.created > last) last = ev.created;
      }
      if (last !== since) await db.setState("event_cursor", { lastCreated: last });
    } catch (err) {
      log.debug("event poll failed", { error: (err as Error).message });
    } finally {
      if (!stopped) timer = setTimeout(tick, cfg.VIBE_AUTH_EVENT_POLL_SECONDS * 1000);
    }
  };
  timer = setTimeout(tick, 5000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
