import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * Minimal SMTP client used only to *verify* a firm's outbound-mail settings
 * ("send test email") before they are handed to authentik. authentik sends the
 * real password-reset mail asynchronously and never reports SMTP failures back
 * to the API caller, so the broker has to speak SMTP itself to give the admin a
 * synchronous yes/no. Supports implicit TLS (465), STARTTLS (587) and AUTH
 * PLAIN / LOGIN. Dependency-free on purpose.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** STARTTLS after EHLO (typical for port 587). */
  useTls: boolean;
  /** Implicit TLS from the first byte (typical for port 465). */
  useSsl: boolean;
  /** Envelope + header sender: "addr@example" or "Name <addr@example>". */
  from: string;
  timeoutMs?: number;
}

export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class Session {
  private sock!: Socket | TLSSocket;
  private pending = "";
  private lines: string[] = [];
  private replies: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private dead: Error | null = null;
  private handlers: { data: (b: Buffer) => void; error: (e: Error) => void; close: () => void; timeout: () => void } | null = null;
  caps = new Set<string>();
  authMechs = new Set<string>();

  constructor(
    sock: Socket | TLSSocket,
    private timeoutMs: number,
  ) {
    this.attach(sock);
  }

  private attach(sock: Socket | TLSSocket): void {
    this.sock = sock;
    this.handlers = {
      data: (b: Buffer) => this.onData(b.toString("utf8")),
      error: (e: Error) => this.fail(e),
      close: () => this.fail(new SmtpError("connection closed by server")),
      timeout: () => this.fail(new SmtpError(`no response from ${this.describe()} within ${this.timeoutMs / 1000}s`)),
    };
    sock.on("data", this.handlers.data);
    sock.on("error", this.handlers.error);
    sock.on("close", this.handlers.close);
    sock.setTimeout(this.timeoutMs, this.handlers.timeout);
  }

  private detach(): void {
    if (!this.handlers) return;
    this.sock.off("data", this.handlers.data);
    this.sock.off("error", this.handlers.error);
    this.sock.off("close", this.handlers.close);
    this.sock.setTimeout(0);
    this.handlers = null;
  }

  private describe(): string {
    return "the mail server";
  }

  private onData(chunk: string): void {
    this.pending += chunk;
    let i: number;
    while ((i = this.pending.indexOf("\r\n")) >= 0) {
      const line = this.pending.slice(0, i);
      this.pending = this.pending.slice(i + 2);
      this.lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {
        const reply: Reply = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.resolve(reply);
        } else this.replies.push(reply);
      }
    }
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(e);
    }
  }

  readReply(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  write(data: string): void {
    if (this.dead) throw this.dead;
    this.sock.write(data);
  }

  async command(line: string): Promise<Reply> {
    this.write(line + "\r\n");
    return this.readReply();
  }

  async ehlo(): Promise<void> {
    const r = await this.command(`EHLO ${hostname() || "vibe-auth"}`);
    expectCode(r, "EHLO", 250);
    this.caps.clear();
    this.authMechs.clear();
    for (const raw of r.lines.slice(1)) {
      const line = raw.replace(/^AUTH=/i, "AUTH ");
      const [cap, ...rest] = line.trim().split(/\s+/);
      if (!cap) continue;
      this.caps.add(cap.toUpperCase());
      if (cap.toUpperCase() === "AUTH") for (const m of rest) this.authMechs.add(m.toUpperCase());
    }
  }

  /** STARTTLS: hand the raw socket to TLS and re-attach. Must be called with an empty read buffer. */
  async upgrade(servername: string): Promise<void> {
    const raw = this.sock as Socket;
    this.detach();
    const tls = tlsConnect({ socket: raw, servername });
    await new Promise<void>((resolve, reject) => {
      tls.once("secureConnect", () => resolve());
      tls.once("error", reject);
    });
    tls.removeAllListeners("error");
    this.attach(tls);
  }

  async quit(): Promise<void> {
    try {
      if (!this.dead) await this.command("QUIT");
    } catch {
      // the server may close first; that is fine
    } finally {
      this.close();
    }
  }

  close(): void {
    this.detach();
    this.dead ??= new SmtpError("session closed");
    this.sock.destroy();
  }
}

function expectCode(r: Reply, what: string, ...codes: number[]): void {
  if (!codes.includes(r.code)) throw new SmtpError(`${what} rejected: ${r.code} ${r.lines.join(" ").trim()}`, r.code);
}

function addressOf(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim();
}

async function open(s: SmtpSettings): Promise<Session> {
  const timeoutMs = s.timeoutMs ?? 15_000;
  if (!s.host) throw new SmtpError("SMTP host is required");
  const sock = s.useSsl ? tlsConnect({ host: s.host, port: s.port, servername: s.host }) : netConnect({ host: s.host, port: s.port });
  const sess = new Session(sock, timeoutMs);
  try {
    expectCode(await sess.readReply(), "connection", 220);
    await sess.ehlo();
    if (s.useTls && !s.useSsl) {
      if (!sess.caps.has("STARTTLS")) throw new SmtpError("the server does not offer STARTTLS on this port; choose SSL (usually port 465) or no encryption");
      expectCode(await sess.command("STARTTLS"), "STARTTLS", 220);
      await sess.upgrade(s.host);
      await sess.ehlo();
    }
    if (s.username) {
      const u = s.username;
      const p = s.password ?? "";
      const b64 = (x: string) => Buffer.from(x, "utf8").toString("base64");
      const mechs = sess.authMechs;
      if (mechs.has("PLAIN") || mechs.size === 0) expectCode(await sess.command(`AUTH PLAIN ${b64(`\0${u}\0${p}`)}`), "authentication", 235);
      else if (mechs.has("LOGIN")) {
        expectCode(await sess.command("AUTH LOGIN"), "authentication", 334);
        expectCode(await sess.command(b64(u)), "authentication", 334);
        expectCode(await sess.command(b64(p)), "authentication", 235);
      } else throw new SmtpError(`the server offers no supported AUTH mechanism (has: ${[...mechs].join(", ") || "none"}; need PLAIN or LOGIN)`);
    }
    return sess;
  } catch (e) {
    sess.close();
    throw e instanceof SmtpError ? e : new SmtpError(describeError(e, s));
  }
}

function describeError(e: unknown, s: SmtpSettings): string {
  const err = e as NodeJS.ErrnoException;
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `cannot resolve host ${s.host}`;
    case "ECONNREFUSED":
      return `connection refused by ${s.host}:${s.port}`;
    case "ETIMEDOUT":
      return `connection to ${s.host}:${s.port} timed out`;
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
      return `TLS certificate for ${s.host} is not trusted (${err.code})`;
    case "EPROTO":
      return `TLS handshake failed with ${s.host}:${s.port} (is this a plain-text port? try STARTTLS or no encryption)`;
    default:
      return err.message ?? String(e);
  }
}

/** Connect, negotiate TLS and authenticate, then QUIT. Throws SmtpError with a human-readable reason. */
export async function smtpProbe(s: SmtpSettings): Promise<void> {
  const sess = await open(s);
  await sess.quit();
}

export function buildMessage(from: string, m: SmtpMessage): string {
  const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?utf-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
  const domain = addressOf(from).split("@")[1] || "vibe-auth.local";
  const body = Buffer.from(m.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${header(from)}`,
    `To: ${header(m.to)}`,
    `Subject: ${header(m.subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** Send one plain-text message. Throws SmtpError with the server's reason on any rejection. */
export async function smtpSend(s: SmtpSettings, m: SmtpMessage): Promise<void> {
  const sess = await open(s);
  try {
    expectCode(await sess.command(`MAIL FROM:<${addressOf(s.from)}>`), "sender", 250);
    expectCode(await sess.command(`RCPT TO:<${addressOf(m.to)}>`), "recipient", 250, 251);
    expectCode(await sess.command("DATA"), "DATA", 354);
    sess.write(buildMessage(s.from, m).replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n");
    expectCode(await sess.readReply(), "message", 250);
  } catch (e) {
    throw e instanceof SmtpError ? e : new SmtpError(describeError(e, s));
  } finally {
    await sess.quit();
  }
}
