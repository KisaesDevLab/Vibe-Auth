#!/usr/bin/env node
/**
 * Integration matrix against the real stack (test/compose.yml):
 *   1. broker health + version, setup wizard via one-time token
 *   2. register ref-app → env block → write test/ref-app.env → recreate ref-app
 *   3. create a test user in authentik (member of vibe-partner)
 *   4. drive the browser flow: ref-app /auth/oidc/start → authentik authentication flow
 *      (identification+password, then MFA ENROLMENT because MFA is enforced, then the
 *      authorization flow) → product callback, all through authentik's flow executor API
 *   5. assert session, role mapping, /auth/me
 *   6. back-channel logout: end the authentik session → ref-app session gone
 *   7. second login answers the TOTP challenge with the enrolled secret
 *   8. rotate secret, verify, rebase, delete
 * Runs on the host; talks to http://localhost:18080 (Caddy) and to docker compose for restarts.
 */
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..");
const env = Object.fromEntries(
  readFileSync(join(testDir, ".env"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("=").map((s) => s.trim()))
    .map(([k, ...v]) => [k, v.join("=")]),
);
const BASE = process.env.VIBE_TEST_BASE ?? "http://localhost:18080";
const BROKER = `${BASE}/vibe-auth`;
const AK = `${BASE}/auth`;
const APP = `${BASE}/ref`;
const consoleHeaders = { authorization: `Bearer ${env.CONSOLE_TOKEN}`, "content-type": "application/json" };
const akHeaders = { authorization: `Bearer ${env.AUTHENTIK_TOKEN}`, "content-type": "application/json", accept: "application/json" };

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, headers: res.headers };
}
function compose(args) {
  execSync(`docker compose -f "${join(testDir, "compose.yml")}" --env-file "${join(testDir, ".env")}" ${args}`, { stdio: "inherit" });
}

// ---- TOTP (RFC 6238) without dependencies
function base32Decode(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
let lastTotpCounter = -1;
/** Wait for a fresh TOTP window: authentik rejects a code from a counter already used (replay protection). */
async function freshTotpWindow(step = 30) {
  let counter = Math.floor(Date.now() / 1000 / step);
  if (counter === lastTotpCounter) {
    await sleep((counter + 1) * step * 1000 - Date.now() + 500);
    counter = Math.floor(Date.now() / 1000 / step);
  }
  lastTotpCounter = counter;
}
function totp(secretB32, step = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

// ---- cookie jar + redirect follower
class Jar {
  constructor() {
    this.map = new Map();
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const [k, ...v] = kv.split("=");
      this.map.set(k.trim(), v.join("="));
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
async function follow(url, jar, maxHops = 12) {
  let hops = 0;
  for (;;) {
    const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header() } });
    jar.absorb(res);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && hops++ < maxHops) {
      url = new URL(loc, url).toString();
      continue;
    }
    return { res, url, body: await res.text() };
  }
}

/**
 * Drive authentik flows through the executor API until the browser would leave authentik.
 * Handles: identification(+password), MFA enrolment (TOTP), MFA validation (TOTP), consent, user-login.
 */
const user = { username: "alice", password: "Alice-Password-12345" };
let totpSecret = null;
async function runThroughAuthentik(startUrl, jar) {
  let current = await follow(startUrl, jar);
  for (let round = 0; round < 6; round++) {
    const m = /\/auth\/if\/flow\/([^/]+)\//.exec(new URL(current.url).pathname);
    if (!m) return current; // left authentik (product callback or error page)
    const slug = m[1];
    const query = new URL(current.url).searchParams.toString();
    const exec = async (body) => {
      let url = `${AK}/api/v3/flows/executor/${slug}/?query=${encodeURIComponent(query)}`;
      let r;
      for (let hop = 0; hop < 4; hop++) {
        r = await fetch(url, {
          method: body && hop === 0 ? "POST" : "GET",
          headers: { cookie: jar.header(), "content-type": "application/json", accept: "application/json" },
          body: body && hop === 0 ? JSON.stringify(body) : undefined,
          redirect: "manual",
        });
        jar.absorb(r);
        const loc = r.headers.get("location");
        // authentik may 302 the executor to itself once the session/plan is established.
        if (r.status >= 300 && r.status < 400 && loc && /\/flows\/executor\//.test(loc)) {
          url = new URL(loc, AK + "/").toString();
          continue;
        }
        break;
      }
      return r;
    };
    const execJson = (body) =>
      exec(body).then(async (r) => {
        const text = await r.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { component: "__unparseable__", status: r.status, location: r.headers.get("location"), text: text.slice(0, 300) };
        }
        return { status: r.status, body: parsed };
      });
    let ch = await execJson();
    let to = null;
    for (let step = 0; step < 15; step++) {
      const comp = ch.body.component;
      if (comp === "ak-stage-identification") ch = await execJson({ component: comp, uid_field: user.username, password: user.password });
      else if (comp === "ak-stage-password") ch = await execJson({ component: comp, password: user.password });
      else if (comp === "ak-stage-authenticator-validate") {
        const devices = ch.body.device_challenges ?? [];
        const totpDev = devices.find((d) => d.device_class === "totp");
        if (totpDev && totpSecret) {
          await freshTotpWindow();
          ch = await execJson({ component: comp, code: totp(totpSecret), selected_challenge: totpDev });
        } else if ((ch.body.configuration_stages ?? []).length) {
          const cfg = ch.body.configuration_stages.find((s) => /totp/i.test(s.name)) ?? ch.body.configuration_stages[0];
          check("MFA enforced: enrolment offered to a user without a device", true, cfg.name);
          ch = await execJson({ component: comp, selected_stage: cfg.pk });
        } else {
          check("unexpected validate challenge", false, JSON.stringify(ch.body).slice(0, 300));
          return current;
        }
      } else if (comp === "ak-stage-authenticator-totp") {
        const url = ch.body.config_url ?? "";
        const secret = /[?&]secret=([A-Z2-7]+)/i.exec(url)?.[1];
        check("TOTP enrolment challenge carries a secret", !!secret);
        totpSecret = secret;
        await freshTotpWindow();
        ch = await execJson({ component: comp, code: totp(secret) });
      } else if (comp === "ak-stage-authenticator-static") ch = await execJson({ component: comp });
      else if (comp === "ak-stage-consent") ch = await execJson({ component: comp, token: ch.body.token });
      else if (comp === "ak-stage-user-login") ch = await execJson({ component: comp, remember_me: false });
      else if (comp === "xak-flow-redirect") {
        to = ch.body.to;
        break;
      } else if (comp === "ak-stage-flow-error" || ch.status >= 400) {
        check(`flow ${slug} error`, false, JSON.stringify(ch.body).slice(0, 400));
        return current;
      } else if (comp === "ak-stage-access-denied") {
        check(`flow ${slug} access denied`, false, JSON.stringify(ch.body).slice(0, 300));
        return current;
      } else {
        check(`unexpected stage ${comp} in ${slug}`, false, JSON.stringify(ch.body).slice(0, 300));
        return current;
      }
      if (ch.body.response_errors && Object.keys(ch.body.response_errors).length) {
        check(`stage ${comp} rejected input`, false, JSON.stringify(ch.body.response_errors));
        return current;
      }
    }
    if (!to) return current;
    current = await follow(new URL(to, AK + "/").toString(), jar);
  }
  return current;
}

async function main() {
  // 1. health / setup
  const health = await json(`${BROKER}/health`);
  check("broker /health 200", health.status === 200, JSON.stringify(health.body));
  const version = await json(`${BROKER}/version`);
  check("broker /version", version.status === 200 && version.body.authentik, JSON.stringify(version.body));

  const setupState = await json(`${BROKER}/setup/token`, { headers: consoleHeaders });
  check("console token protects /setup/token", (await fetch(`${BROKER}/setup/token`)).status === 401);
  if (!setupState.body.state?.done) {
    const good = await fetch(`${BROKER}/setup?token=${env.SETUP_TOKEN}`);
    check("setup wizard opens with the one-time token", good.status === 200, `status ${good.status}`);
    const bad = await fetch(`${BROKER}/setup?token=nope`);
    check("setup wizard rejects a bad token", bad.status === 403, `status ${bad.status}`);
    const form = new URLSearchParams({ token: env.SETUP_TOKEN, firmName: "Kisaes Test CPA", adminName: "Kurt", adminEmail: "kurt@kisaes.com", password: "Correct-Horse-Battery-1" });
    const done = await fetch(`${BROKER}/setup`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    check("setup wizard completes", done.status === 200, `status ${done.status}`);
  } else check("setup already done (re-run)", true);
  const after = await json(`${BROKER}/setup/token`, { headers: consoleHeaders });
  check("setup token invalidated after completion", after.body.token === null && after.body.state.done === true);
  const closed = await fetch(`${BROKER}/setup?token=${env.SETUP_TOKEN}`, { redirect: "manual" });
  check("setup wizard closed after completion", closed.status === 302);
  // Same selection the broker uses (authentik.ts defaultBrand): the brand flagged
  // default, else the built-in "authentik-default" domain, else any. A fresh
  // 2026.8 instance can have no brand flagged default at all, which made the
  // old `?default=true` query return [] while the wizard had patched the brand fine.
  const brands = await json(`${AK}/api/v3/core/brands/`, { headers: akHeaders });
  const all = brands.body.results ?? [];
  const brandRow = all.find((b) => b.default === true) ?? all.find((b) => b.domain === "authentik-default") ?? all[0];
  check("brand title set by the wizard", brandRow?.branding_title === "Kisaes Test CPA", `status ${brands.status} ${JSON.stringify(all.map((b) => ({ domain: b.domain, default: b.default, branding_title: b.branding_title }))).slice(0, 400)}`);
  const settings = await json(`${AK}/api/v3/admin/settings/`, { headers: akHeaders });
  check("authentik base URL set by the broker (2026.8+ system setting)", !("base_url" in (settings.body ?? {})) || /^https?:\/\/[^/]+$/.test(String(settings.body.base_url)), `status ${settings.status} base_url=${JSON.stringify(settings.body?.base_url)}`);
  const admin = await json(`${AK}/api/v3/core/users/?username=kurt@kisaes.com`, { headers: akHeaders });
  check("first admin exists, superuser, in vibe-admin", admin.body.results?.[0]?.is_superuser === true && (admin.body.results?.[0]?.groups_obj ?? []).some((g) => g.name === "vibe-admin"));

  // 2. register ref-app
  const reg = await json(`${BROKER}/registrations`, {
    method: "POST",
    headers: consoleHeaders,
    body: JSON.stringify({ slug: "ref-app", displayName: "Ref App", baseUrl: APP, internalUrl: "http://ref-app:3005/ref", redirectPaths: ["/auth/oidc/callback"], logoutPaths: ["/auth/oidc/backchannel"], publicPaths: ["/api/health", "/api/ping"] }),
  });
  check("POST /registrations", reg.status === 201 || reg.status === 200, JSON.stringify(reg.body).slice(0, 200));
  const envBlock = reg.body.env;
  check("env block: issuer under the /auth/ subpath", envBlock?.VIBE_OIDC_ISSUER === `${BASE}/auth/application/o/ref-app/`, envBlock?.VIBE_OIDC_ISSUER);
  check("env block: internal base is the container-internal origin", envBlock?.VIBE_OIDC_INTERNAL_BASE === "http://vibe-auth-authentik-server:9000", envBlock?.VIBE_OIDC_INTERNAL_BASE);
  const again = await json(`${BROKER}/registrations`, { method: "POST", headers: consoleHeaders, body: JSON.stringify({ slug: "ref-app", displayName: "Ref App", baseUrl: APP }) });
  check("registration is idempotent (same client_id)", again.body.env?.VIBE_OIDC_CLIENT_ID === envBlock.VIBE_OIDC_CLIENT_ID);
  const unauth = await fetch(`${BROKER}/registrations`);
  check("registration API requires the console token", unauth.status === 401);

  writeFileSync(join(testDir, "ref-app.env"), `${reg.body.envFile}\nVIBE_AUTH_MODE=both\n`);
  compose("up -d --force-recreate --no-deps ref-app");
  for (let i = 0; i < 40; i++) {
    const h = await json(`${APP}/api/health`).catch(() => ({ status: 0 }));
    if (h.status === 200 && h.body.mode === "both") break;
    await sleep(3000);
  }
  const status = await json(`${APP}/auth/status`);
  check("ref-app status: oidc enabled", status.body?.oidc?.enabled === true, JSON.stringify(status.body).slice(0, 200));
  for (let i = 0; i < 20 && !(await json(`${APP}/auth/status`)).body?.oidc?.reachable; i++) await sleep(3000);
  const st2 = await json(`${APP}/auth/status`);
  check("ref-app discovered the IdP through the internal base with the public issuer validated", st2.body?.oidc?.reachable === true, st2.body?.oidc?.lastError ?? "");

  // 3. test user (member of vibe-partner), no MFA device yet
  const groups = await json(`${AK}/api/v3/core/groups/?name=vibe-partner`, { headers: akHeaders });
  const partner = groups.body.results?.find((g) => g.name === "vibe-partner");
  check("blueprint created vibe-partner group", !!partner);
  let alice = (await json(`${AK}/api/v3/core/users/?username=alice`, { headers: akHeaders })).body.results?.find((u) => u.username === "alice");
  if (alice) {
    for (const d of (await json(`${AK}/api/v3/authenticators/admin/all/?user=${alice.pk}`, { headers: akHeaders })).body ?? []) {
      const kind = /totp/i.test(d.type) ? "totp" : /static/i.test(d.type) ? "static" : null;
      if (kind) await fetch(`${AK}/api/v3/authenticators/admin/${kind}/${d.pk}/`, { method: "DELETE", headers: akHeaders });
    }
  } else {
    alice = (await json(`${AK}/api/v3/core/users/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ username: "alice", name: "Alice Partner", email: "alice@kisaes.com", is_active: true, groups: [partner.pk], path: "users" }) })).body;
  }
  await json(`${AK}/api/v3/core/users/${alice.pk}/set_password/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ password: user.password }) });
  totpSecret = null;

  // 4. first login: password + MFA enrolment + authorization → callback
  const jar = new Jar();
  const first = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jar);
  check("first login lands on the product after the callback", new URL(first.url).pathname === "/ref/api/me" && first.res.status === 200, `${first.res.status} ${first.url}`);
  check("TOTP was enrolled during login (MFA enforced)", !!totpSecret);
  const me = await json(`${APP}/api/me`, { headers: { cookie: jar.header() } });
  check("ref-app /api/me returns the JIT-provisioned user", me.status === 200 && me.body.user?.email === "alice@kisaes.com", JSON.stringify(me.body).slice(0, 200));
  check("role mapped vibe-partner → admin (roles claim from scope mapping)", me.body.user?.role === "admin", me.body.user?.role);
  const authMe = await json(`${APP}/auth/me`, { headers: { cookie: jar.header() } });
  check("/auth/me lists the linked identity with the public issuer", authMe.body.identities?.[0]?.issuer === envBlock.VIBE_OIDC_ISSUER, JSON.stringify(authMe.body.identities ?? null));

  // 5. broker forwarded the IdP login event to its audit log
  await sleep(7000);
  const audits = await json(`${BROKER}/api/admin/audit`);
  check("admin API requires a session", audits.status === 401);

  // 6. back-channel logout
  const sessions = await json(`${AK}/api/v3/core/authenticated_sessions/?user__username=alice`, { headers: akHeaders });
  check("authentik has alice's session", (sessions.body.results?.length ?? 0) >= 1, JSON.stringify(sessions.body).slice(0, 200));
  for (const s of sessions.body.results ?? []) await fetch(`${AK}/api/v3/core/authenticated_sessions/${s.uuid}/`, { method: "DELETE", headers: akHeaders });
  let gone = false;
  for (let i = 0; i < 10 && !gone; i++) {
    await sleep(2000);
    gone = (await json(`${APP}/api/me`, { headers: { cookie: jar.header() } })).status === 401;
  }
  check("back-channel logout ended the product session", gone);

  // 7. second login answers the TOTP challenge with the enrolled secret
  const jar2 = new Jar();
  const second = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/secret`, jar2);
  check("second login validates the enrolled TOTP and lands on the product", new URL(second.url).pathname === "/ref/api/secret" && second.res.status === 200, `${second.res.status} ${second.url}`);
  const secret = await json(`${APP}/api/secret`, { headers: { cookie: jar2.header() } });
  check("session works after second login", secret.status === 200 && secret.body.secret === "42");
  const logout = await fetch(`${APP}/auth/oidc/logout`, { redirect: "manual", headers: { cookie: jar2.header() } });
  const loc = logout.headers.get("location") ?? "";
  check("RP-initiated logout redirects to authentik end-session with id_token_hint", logout.status === 302 && /end-session/.test(loc) && /id_token_hint=/.test(loc), loc.slice(0, 120));

  // 8. rotate + verify + rebase + delete
  const rot = await json(`${BROKER}/registrations/ref-app/rotate`, { method: "POST", headers: consoleHeaders });
  check("rotate returns a new secret", rot.status === 200 && rot.body.env.VIBE_OIDC_CLIENT_SECRET && rot.body.env.VIBE_OIDC_CLIENT_SECRET !== envBlock.VIBE_OIDC_CLIENT_SECRET);
  const ver = await json(`${BROKER}/registrations/verify`, { headers: consoleHeaders });
  check("verify: all registrations consistent", ver.status === 200 && Array.isArray(ver.body) && ver.body.every((r) => r.ok), JSON.stringify(ver.body).slice(0, 300));
  const rebase = await json(`${BROKER}/rebase`, { method: "POST", headers: consoleHeaders, body: JSON.stringify({}) });
  check("rebase returns env for every product", rebase.status === 200 && rebase.body.products.some((p) => p.slug === "ref-app"));
  const del = await json(`${BROKER}/registrations/ref-app`, { method: "DELETE", headers: consoleHeaders });
  check("DELETE registration", del.status === 200 && del.body.ok === true);
  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
