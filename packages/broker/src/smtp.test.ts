import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildMessage, smtpProbe, smtpSend, SmtpError } from "./smtp.js";

/** Tiny scripted SMTP server: enough of RFC 5321 to exercise the client (no TLS). */
function fakeSmtp(o: { auth?: { user: string; pass: string }; rejectRcpt?: boolean; advertise?: string[] } = {}) {
  const log: string[] = [];
  let data = "";
  const server = createServer((sock: Socket) => {
    let inData = false;
    let buf = "";
    const send = (s: string) => sock.write(s + "\r\n");
    send("220 fake.test ESMTP");
    sock.on("data", (b) => {
      buf += b.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            send("250 2.0.0 queued");
          } else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        log.push(line);
        const [cmd, ...rest] = line.split(" ");
        switch ((cmd ?? "").toUpperCase()) {
          case "EHLO":
            send("250-fake.test");
            for (const cap of o.advertise ?? (o.auth ? ["AUTH PLAIN LOGIN"] : [])) send(`250-${cap}`);
            send("250 8BITMIME");
            break;
          case "AUTH": {
            const [mech, blob] = rest;
            if (mech?.toUpperCase() !== "PLAIN") return send("504 mechanism not supported");
            const [, u, p] = Buffer.from(blob ?? "", "base64").toString("utf8").split("\0");
            send(o.auth && u === o.auth.user && p === o.auth.pass ? "235 ok" : "535 5.7.8 Authentication credentials invalid");
            break;
          }
          case "MAIL":
            send("250 ok");
            break;
          case "RCPT":
            send(o.rejectRcpt ? "550 5.1.1 no such user" : "250 ok");
            break;
          case "DATA":
            inData = true;
            send("354 go ahead");
            break;
          case "QUIT":
            send("221 bye");
            sock.end();
            break;
          default:
            send("500 unknown");
        }
      }
    });
  });
  return {
    server,
    log,
    data: () => data,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      }),
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe("smtp client", () => {
  it("authenticates with AUTH PLAIN and delivers a message", async () => {
    const f = fakeSmtp({ auth: { user: "mailer@firm.test", pass: "s3cret" } });
    servers.push(f.server);
    const port = await f.listen();
    await smtpSend({ host: "127.0.0.1", port, username: "mailer@firm.test", password: "s3cret", useTls: false, useSsl: false, from: "Vibe Auth <vibe-auth@firm.test>" }, { to: "kurt@firm.test", subject: "Reset your password ✓", text: "hello\n.leading dot\nbye" });
    expect(f.log.some((l) => l.startsWith("EHLO "))).toBe(true);
    expect(f.log).toContain("MAIL FROM:<vibe-auth@firm.test>");
    expect(f.log).toContain("RCPT TO:<kurt@firm.test>");
    expect(f.log.at(-1)).toBe("QUIT");
    const msg = f.data();
    expect(msg).toContain("From: Vibe Auth <vibe-auth@firm.test>");
    expect(msg).toContain("Subject: =?utf-8?B?");
    expect(msg).toContain("Content-Transfer-Encoding: base64");
    const body = msg.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("hello\n.leading dot\nbye");
  });

  it("reports bad credentials with the server's reason", async () => {
    const f = fakeSmtp({ auth: { user: "mailer@firm.test", pass: "right" } });
    servers.push(f.server);
    const port = await f.listen();
    const err = await smtpProbe({ host: "127.0.0.1", port, username: "mailer@firm.test", password: "wrong", useTls: false, useSsl: false, from: "a@b.test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).code).toBe(535);
    expect((err as Error).message).toMatch(/authentication rejected: 535/);
  });

  it("refuses STARTTLS when the server does not offer it instead of sending credentials in clear", async () => {
    const f = fakeSmtp({ auth: { user: "u", pass: "p" } });
    servers.push(f.server);
    const port = await f.listen();
    const err = await smtpProbe({ host: "127.0.0.1", port, username: "u", password: "p", useTls: true, useSsl: false, from: "a@b.test" }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/does not offer STARTTLS/);
    expect(f.log.some((l) => l.startsWith("AUTH"))).toBe(false);
  });

  it("surfaces a rejected recipient", async () => {
    const f = fakeSmtp({ rejectRcpt: true });
    servers.push(f.server);
    const port = await f.listen();
    const err = await smtpSend({ host: "127.0.0.1", port, useTls: false, useSsl: false, from: "a@b.test" }, { to: "nobody@b.test", subject: "x", text: "y" }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/recipient rejected: 550/);
  });

  it("explains a refused connection", async () => {
    const f = fakeSmtp();
    servers.push(f.server);
    const port = await f.listen();
    await new Promise((r) => f.server.close(r));
    servers.pop();
    const err = await smtpProbe({ host: "127.0.0.1", port, useTls: false, useSsl: false, from: "a@b.test", timeoutMs: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as Error).message).toMatch(/connection refused|closed/);
  });

  it("builds RFC 5322 headers", () => {
    const m = buildMessage("vibe-auth@firm.test", { to: "x@firm.test", subject: "plain", text: "t" });
    expect(m).toMatch(/^From: vibe-auth@firm\.test\r\nTo: x@firm\.test\r\nSubject: plain\r\nDate: .* \+0000\r\nMessage-ID: <[0-9a-f]{24}@firm\.test>\r\n/);
  });
});
