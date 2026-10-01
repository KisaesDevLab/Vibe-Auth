#!/usr/bin/env node
/**
 * Test sink for the MFA code methods (integration.mjs step 7d). No dependencies.
 *   SMTP :1025   accepts any message without authentication or TLS and keeps it
 *   HTTP :8025   POST /sms  — stands in for an SMS gateway; keeps the JSON body and the Authorization header
 *                GET  /sms, /mail — everything received so far, oldest first
 *                DELETE /        — forget everything
 */
import { createServer as http } from "node:http";
import { createServer as tcp } from "node:net";

const sms = [];
const mail = [];

http((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/sms") return send(200, sms);
  if (req.method === "GET" && req.url === "/mail") return send(200, mail);
  if (req.method === "DELETE") {
    sms.length = 0;
    mail.length = 0;
    return send(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/sms") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      sms.push({ at: new Date().toISOString(), authorization: req.headers.authorization ?? null, body });
      send(200, { ok: true });
    });
    return;
  }
  send(404, { error: "not_found" });
}).listen(8025);

tcp((sock) => {
  let buf = "";
  let data = null;
  let msg = { from: null, to: [] };
  sock.setEncoding("utf8");
  sock.write("220 catcher ESMTP\r\n");
  sock.on("error", () => {});
  sock.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      if (data !== null) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        mail.push({ at: new Date().toISOString(), ...msg, data: data + buf.slice(0, end) });
        buf = buf.slice(end + 5);
        data = null;
        msg = { from: null, to: [] };
        sock.write("250 OK\r\n");
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250 catcher\r\n");
      else if (cmd === "MAIL") (msg.from = line), sock.write("250 OK\r\n");
      else if (cmd === "RCPT") msg.to.push(/<([^>]+)>/.exec(line)?.[1] ?? line), sock.write("250 OK\r\n");
      else if (cmd === "DATA") (data = ""), sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      else if (cmd === "QUIT") sock.end("221 Bye\r\n");
      else sock.write("250 OK\r\n");
    }
  });
}).listen(1025);
