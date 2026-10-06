#!/usr/bin/env node
/**
 * Integration matrix against the real stack (test/compose.yml):
 *   1. broker health + version, setup wizard via one-time token
 *   2. register ref-app → env block → write test/ref-app.env → recreate ref-app
 *   3. create a test user in authentik (member of vibe-partner)
 *   4. drive the browser flow: ref-app /auth/oidc/start → authentik authentication flow
 *      (identification+password, then MFA ENROLMENT because MFA is enforced, then the
 *      confirmation of the new device, then the authorization flow) → product callback,
 *      all through authentik's flow executor API. The ref-app runs with
 *      VIBE_OIDC_REQUIRE_MFA_AMR=true, so this first login only lands if the ID token's
 *      amr carries "mfa" — the enrolment sign-in used to carry ["pwd"] alone.
 *   5. assert session, role mapping, /auth/me
 *   6. back-channel logout: end the authentik session → ref-app session gone
 *   7. second login answers the TOTP challenge with the enrolled secret
 *   7b. MFA enforcement off: a user without a device signs in without a code (no lockout)
 *   7c. per-product access: restrict ref-app, a user who is not ticked is stopped at authentik's
 *       authorize endpoint, a ticked user still signs in, verify flags hand-deleted bindings, reopen
 *   7d. opt-in code methods: an admin signs in to the console, turns on email and SMS codes;
 *       one user enrols and signs in by text message, another by email (codes read from
 *       test/catcher); turning the methods off stops their devices being accepted
 *   7e. invitations: the welcome stage uses the mounted Vibe template; adding a user emails a
 *       welcome (not a reset) whose link is the admin's copy; resend works until they sign in
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
const CATCHER = process.env.VIBE_TEST_CATCHER ?? "http://localhost:18025";
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

// ---- codes delivered to test/catcher (SMS gateway stand-in + SMTP sink)
const caught = async (kind) => (await json(`${CATCHER}/${kind === "sms" ? "sms" : "mail"}`)).body ?? [];
/** Quoted-printable / base64 bodies are decoded just enough to find the code. */
function mailText(data) {
  const qp = data.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...data.matchAll(/\r?\n\r?\n([A-Za-z0-9+/=\r\n]{40,})/g)].map((m) => Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8")).join("\n");
  return `${qp}\n${b64}`.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}
/** The newest code sent to this person after the first `seen` messages; waits for delivery. */
async function deliveredCode(who, kind, seen) {
  for (let i = 0; i < 30; i++) {
    const all = await caught(kind);
    const mine = all.slice(seen).filter((m) => (kind === "sms" ? m.body?.To === who.phone : (m.to ?? []).includes(who.email)));
    const last = mine.at(-1);
    const code = last ? (kind === "sms" ? /\b(\d{6,8})\b/.exec(`${last.body?.Body ?? ""}`)?.[1] : /(?:^|\s)(\d{6,8})(?:\s|$)/.exec(mailText(last.data))?.[1]) : null;
    if (code) return code;
    await sleep(1000);
  }
  check(`${kind} code delivered to ${kind === "sms" ? who.phone : who.email}`, false, JSON.stringify((await caught(kind)).slice(seen)).slice(0, 300));
  return "000000";
}

/**
 * Drive authentik flows through the executor API until the browser would leave authentik.
 * Handles: identification(+password), MFA enrolment (TOTP), MFA validation (TOTP), consent, user-login.
 */
const user = { username: "alice", password: "Alice-Password-12345", totpSecret: null };
const bob = { username: "bob", password: "Bob-Password-1234567", totpSecret: null };
/** MFA codes answered at an authenticator-validate stage during the last runThroughAuthentik. */
let validateSubmits = 0;
/** Each person carries their own TOTP secret (set when they enrol during a run). */
async function runThroughAuthentik(startUrl, jar, who = user) {
  validateSubmits = 0;
  if (who.mfa) who.seen = (await caught(who.mfa)).length;
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
      if (comp === "ak-stage-identification") ch = await execJson({ component: comp, uid_field: who.username, password: who.password });
      else if (comp === "ak-stage-password") ch = await execJson({ component: comp, password: who.password });
      else if (comp === "ak-stage-authenticator-validate") {
        const devices = ch.body.device_challenges ?? [];
        const totpDev = devices.find((d) => d.device_class === "totp");
        const codeDev = who.mfa ? devices.find((d) => d.device_class === who.mfa) : null;
        if (totpDev && who.totpSecret) {
          await freshTotpWindow();
          validateSubmits++;
          ch = await execJson({ component: comp, code: totp(who.totpSecret), selected_challenge: totpDev });
        } else if (codeDev) {
          // Picking the device is what makes authentik send the code; the answer is a second submit.
          const seen = (await caught(who.mfa)).length;
          await execJson({ component: comp, selected_challenge: codeDev });
          validateSubmits++;
          // Without selected_challenge: sending it again would issue a new code and void this one.
          ch = await execJson({ component: comp, code: await deliveredCode(who, who.mfa, seen) });
        } else if ((ch.body.configuration_stages ?? []).length) {
          const wanted = new RegExp(who.mfa ?? "totp", "i");
          who.offered = ch.body.configuration_stages.map((s) => s.name);
          const cfg = ch.body.configuration_stages.find((s) => wanted.test(s.name)) ?? ch.body.configuration_stages[0];
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
        who.totpSecret = secret;
        await freshTotpWindow();
        ch = await execJson({ component: comp, code: totp(secret) });
      } else if (comp === "ak-stage-authenticator-sms") {
        if (ch.body.phone_number_required) {
          who.seen = (await caught("sms")).length;
          ch = await execJson({ component: comp, phone_number: who.phone });
        } else ch = await execJson({ component: comp, code: await deliveredCode(who, "sms", who.seen ?? 0) });
      } else if (comp === "ak-stage-authenticator-email") {
        if (ch.body.email_required) ch = await execJson({ component: comp, email: who.email });
        else ch = await execJson({ component: comp, code: await deliveredCode(who, "email", who.seen ?? 0) });
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

  // Require MFA at the IdP, the way products that skip their own second factor on SSO
  // sessions do (Vibe 1099, 1040): the first-login check below then fails unless the
  // enrolment sign-in's ID token carries amr "mfa".
  writeFileSync(join(testDir, "ref-app.env"), `${reg.body.envFile}\nVIBE_AUTH_MODE=both\nVIBE_OIDC_REQUIRE_MFA_AMR=true\n`);
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
  user.totpSecret = null;

  // 4. first login: password + MFA enrolment + authorization → callback
  const jar = new Jar();
  const first = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jar);
  check("first login (MFA enrolment) satisfies an MFA-requiring product: amr carries mfa", !/Multi-factor authentication is required/.test(first.body ?? ""), `${first.res.status} ${first.url}`);
  check("first login lands on the product after the callback", new URL(first.url).pathname === "/ref/api/me" && first.res.status === 200, `${first.res.status} ${first.url}`);
  check("TOTP was enrolled during login (MFA enforced)", !!user.totpSecret);
  check("first login asks for one code after enrolment (the confirmation of the new device)", validateSubmits === 1, `codes answered: ${validateSubmits}`);
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
  check("second login asks for one code only (no confirmation prompt once a device was validated)", validateSubmits === 1, `codes answered: ${validateSubmits}`);
  const secret = await json(`${APP}/api/secret`, { headers: { cookie: jar2.header() } });
  check("session works after second login", secret.status === 200 && secret.body.secret === "42");
  const logout = await fetch(`${APP}/auth/oidc/logout`, { redirect: "manual", headers: { cookie: jar2.header() } });
  const loc = logout.headers.get("location") ?? "";
  check("RP-initiated logout redirects to authentik end-session with id_token_hint", logout.status === 302 && /end-session/.test(loc) && /id_token_hint=/.test(loc), loc.slice(0, 120));

  // 7b. MFA enforcement OFF (the broker's admin toggle sets not_configured_action=skip on the
  // validation stage): a user with no device signs in without being asked for a code, so the
  // post-enrolment confirmation stage can never lock anyone out. The ref-app still requires amr
  // mfa, so it refuses the login with its MFA page — that page proves authentik let the user through.
  const resetDevices = async (pk) => {
    for (const d of (await json(`${AK}/api/v3/authenticators/admin/all/?user=${pk}`, { headers: akHeaders })).body ?? []) {
      const kind = /totp/i.test(d.type) ? "totp" : /static/i.test(d.type) ? "static" : /sms/i.test(d.type) ? "sms" : /email/i.test(d.type) ? "email" : null;
      if (kind) await fetch(`${AK}/api/v3/authenticators/admin/${kind}/${d.pk}/`, { method: "DELETE", headers: akHeaders });
    }
  };
  let bobUser = (await json(`${AK}/api/v3/core/users/?username=bob`, { headers: akHeaders })).body.results?.find((u) => u.username === "bob");
  if (bobUser) await resetDevices(bobUser.pk);
  else bobUser = (await json(`${AK}/api/v3/core/users/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ username: "bob", name: "Bob Partner", email: "bob@kisaes.com", is_active: true, groups: [partner.pk], path: "users" }) })).body;
  await json(`${AK}/api/v3/core/users/${bobUser.pk}/set_password/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ password: bob.password }) });
  bob.totpSecret = null;
  const mfaStage = (await json(`${AK}/api/v3/stages/authenticator/validate/?name=vibe-mfa-validation`, { headers: akHeaders })).body.results?.[0];
  check("MFA validation stage found", !!mfaStage);
  await json(`${AK}/api/v3/stages/authenticator/validate/${mfaStage.pk}/`, { method: "PATCH", headers: akHeaders, body: JSON.stringify({ not_configured_action: "skip" }) });
  try {
    const b = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, new Jar(), bob);
    const enrolled = !!bob.totpSecret;
    check("enforcement off: a user without a device is neither enrolled nor asked for a code", !enrolled && validateSubmits === 0, `enrolled=${enrolled} codes=${validateSubmits}`);
    check("enforcement off: authentik completes the sign-in (the MFA-requiring product then refuses it)", new URL(b.url).pathname === "/ref/auth/oidc/callback" && /Multi-factor authentication is required/.test(b.body ?? ""), `${b.res.status} ${b.url}`);
  } finally {
    // authentik validates a PATCH on its own: "configure" is rejected unless configuration_stages is sent with it.
    const restored = await json(`${AK}/api/v3/stages/authenticator/validate/${mfaStage.pk}/`, { method: "PATCH", headers: akHeaders, body: JSON.stringify({ not_configured_action: "configure", configuration_stages: mfaStage.configuration_stages }) });
    check("MFA enforcement restored after the enforcement-off check", restored.status === 200 && restored.body.not_configured_action === "configure", JSON.stringify(restored.body).slice(0, 200));
  }

  // 7c. per-product access: a restricted product admits only its ticked users (and vibe-admin)
  await resetDevices(bobUser.pk);
  bob.totpSecret = null;
  const accessOf = async (pk) => (await json(`${AK}/api/v3/core/applications/ref-app/check_access/?for_user=${pk}`, { headers: akHeaders })).body?.passing;
  check("open product: authentik admits a user nobody ticked", (await accessOf(bobUser.pk)) === true);

  const restrict = await json(`${BROKER}/registrations/ref-app/access`, { method: "PUT", headers: consoleHeaders, body: JSON.stringify({ restricted: true, seed: "none" }) });
  check("PUT access restricted:true", restrict.status === 200 && restrict.body.restricted === true, JSON.stringify(restrict.body));
  const appGroup = (await json(`${AK}/api/v3/core/groups/?name=vibe-app-ref-app`, { headers: akHeaders })).body.results?.find((g) => g.name === "vibe-app-ref-app");
  check("broker created the product access group", !!appGroup);
  const refApp = (await json(`${AK}/api/v3/core/applications/ref-app/`, { headers: akHeaders })).body;
  const bound = (await json(`${AK}/api/v3/policies/bindings/?target=${refApp.pk}`, { headers: akHeaders })).body.results ?? [];
  check("application is bound to the access group and vibe-admin", bound.length === 2 && bound.every((b) => b.group && !b.policy && !b.user) && bound.some((b) => b.group === appGroup?.pk), JSON.stringify(bound.map((b) => b.group_obj?.name ?? b.group)));
  await json(`${AK}/api/v3/core/groups/${appGroup.pk}/add_user/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ pk: alice.pk }) });
  check("restricted: authentik denies bob", (await accessOf(bobUser.pk)) === false);
  check("restricted: authentik admits alice (ticked)", (await accessOf(alice.pk)) === true);

  const jarBob = new Jar();
  const denied = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jarBob, bob);
  const deniedPath = new URL(denied.url).pathname;
  check("bob is stopped at authentik's authorize endpoint, never reaching the product", /\/application\/o\/authorize\//.test(deniedPath) && !deniedPath.startsWith("/ref/"), `${denied.res.status} ${denied.url.slice(0, 120)}`);
  check("bob sees authentik's permission-denied page", /permission denied|request has been denied|access denied/i.test(denied.body), denied.body.replace(/\s+/g, " ").slice(0, 200));
  check("bob has no product session", (await json(`${APP}/api/me`, { headers: { cookie: jarBob.header() } })).status === 401);

  const jarAlice = new Jar();
  const allowed = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jarAlice, user);
  check("alice (ticked) still signs in to the restricted product", new URL(allowed.url).pathname === "/ref/api/me" && allowed.res.status === 200, `${allowed.res.status} ${allowed.url}`);
  const verRestricted = await json(`${BROKER}/registrations/verify`, { headers: consoleHeaders });
  check("verify is clean while restricted", verRestricted.body.find?.((r) => r.slug === "ref-app")?.ok === true, JSON.stringify(verRestricted.body).slice(0, 300));
  for (const b of bound) await fetch(`${AK}/api/v3/policies/bindings/${b.pk}/`, { method: "DELETE", headers: akHeaders });
  const verDrift = await json(`${BROKER}/registrations/verify`, { headers: consoleHeaders });
  check("verify flags bindings deleted by hand (fail-open drift)", (verDrift.body.find?.((r) => r.slug === "ref-app")?.problems ?? []).some((p) => /no binding for/.test(p)), JSON.stringify(verDrift.body).slice(0, 300));

  const open = await json(`${BROKER}/registrations/ref-app/access`, { method: "PUT", headers: consoleHeaders, body: JSON.stringify({ restricted: false }) });
  check("PUT access restricted:false", open.status === 200 && open.body.restricted === false);
  check("opened: authentik admits bob again", (await accessOf(bobUser.pk)) === true);
  const stillMember = (await json(`${AK}/api/v3/core/users/${alice.pk}/`, { headers: akHeaders })).body.groups_obj?.some((g) => g.name === "vibe-app-ref-app");
  check("opening keeps the ticked list for later", stillMember === true);
  const jarBob2 = new Jar();
  const bobIn = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jarBob2, bob);
  check("bob signs in once the product is open again", new URL(bobIn.url).pathname === "/ref/api/me" && bobIn.res.status === 200, `${bobIn.res.status} ${bobIn.url}`);

  // 7d. opt-in code methods (broker mfa.ts): email and SMS codes are off until an admin turns them on.
  const ensureUser = async (who, name) => {
    let u = (await json(`${AK}/api/v3/core/users/?username=${who.username}`, { headers: akHeaders })).body.results?.find((x) => x.username === who.username);
    if (u) await resetDevices(u.pk);
    else u = (await json(`${AK}/api/v3/core/users/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ username: who.username, name, email: who.email, is_active: true, groups: [partner.pk], path: "users" }) })).body;
    await json(`${AK}/api/v3/core/users/${u.pk}/set_password/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ password: who.password }) });
    return u;
  };
  const stageNow = async () => (await json(`${AK}/api/v3/stages/authenticator/validate/?name=vibe-mfa-validation`, { headers: akHeaders })).body.results?.[0];
  const kurt = { username: "kurt@kisaes.com", password: "Correct-Horse-Battery-1", totpSecret: null };
  const kurtPk = admin.body.results?.[0]?.pk;
  await resetDevices(kurtPk);
  await json(`${AK}/api/v3/core/users/${kurtPk}/set_password/`, { method: "POST", headers: akHeaders, body: JSON.stringify({ password: kurt.password }) });
  const adminJar = new Jar();
  const adminIn = await runThroughAuthentik(`${BROKER}/auth/oidc/start?return_to=/vibe-auth/admin`, adminJar, kurt);
  check("the firm admin signs in to the broker's admin console", new URL(adminIn.url).pathname.startsWith("/vibe-auth/admin") && adminIn.res.status === 200, `${adminIn.res.status} ${adminIn.url}`);
  const adminApi = (path, method = "GET", body) => json(`${BROKER}/api/admin${path}`, { method, headers: { cookie: adminJar.header(), "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
  await adminApi("/mfa/methods/sms", "DELETE");
  await adminApi("/mfa/methods/email", "PUT", { enabled: false });
  await adminApi("/email", "DELETE");
  await fetch(CATCHER, { method: "DELETE" });
  const off = await adminApi("/mfa/methods");
  check("code methods are off by default", off.status === 200 && off.body.email?.enabled === false && off.body.sms?.enabled === false, JSON.stringify(off.body));
  check("default: only app, passkey and recovery-code devices are accepted", JSON.stringify([...((await stageNow())?.device_classes ?? [])].sort()) === JSON.stringify(["static", "totp", "webauthn"]), JSON.stringify((await stageNow())?.device_classes));
  const noMail = await adminApi("/mfa/methods/email", "PUT", { enabled: true });
  check("email codes are refused while no mail server is configured", noMail.status === 400, `${noMail.status} ${JSON.stringify(noMail.body)}`);
  const mailSet = await adminApi("/email", "PUT", { host: "catcher", port: 1025, security: "none", from: "vibe-auth@kisaes.com" });
  check("admin sets a mail server", mailSet.status === 200, JSON.stringify(mailSet.body).slice(0, 200));
  const emailOn = await adminApi("/mfa/methods/email", "PUT", { enabled: true });
  check("admin turns on email codes", emailOn.status === 200 && emailOn.body.email?.enabled === true, `${emailOn.status} ${JSON.stringify(emailOn.body)}`);
  const smsOn = await adminApi("/mfa/methods/sms", "PUT", { provider: "generic", url: "http://catcher:8025/sms", token: "test-sms-key", from: "VibeTest" });
  check("admin turns on text message codes", smsOn.status === 200 && smsOn.body.sms?.enabled === true, `${smsOn.status} ${JSON.stringify(smsOn.body)}`);
  check("the provider key is never returned", !JSON.stringify(smsOn.body).includes("test-sms-key"));
  const stageOn = await stageNow();
  check("both code device classes are accepted and both enrolment stages offered", ["sms", "email"].every((c) => stageOn.device_classes.includes(c)) && stageOn.configuration_stages.length === 4, JSON.stringify({ classes: stageOn.device_classes, stages: stageOn.configuration_stages.length }));

  const carol = { username: "carol", password: "Carol-Password-12345", email: "carol@kisaes.com", phone: "+15550100001", mfa: "sms" };
  await ensureUser(carol, "Carol Sms");
  const jarCarol = new Jar();
  const carolIn = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, jarCarol, carol);
  check("enrolment offers the two code methods next to app and passkey", (carol.offered ?? []).some((n) => /sms/i.test(n)) && (carol.offered ?? []).some((n) => /email/i.test(n)), JSON.stringify(carol.offered));
  check("SMS: first sign-in (enrol a phone, then confirm it) lands on the MFA-requiring product", new URL(carolIn.url).pathname === "/ref/api/me" && carolIn.res.status === 200, `${carolIn.res.status} ${carolIn.url} ${(carolIn.body ?? "").slice(0, 120)}`);
  const sent = await caught("sms");
  check("SMS gateway received the code with the bearer key", sent.length >= 1 && sent.every((m) => m.authorization === "Bearer test-sms-key" && m.body?.To === carol.phone), JSON.stringify(sent.at(-1) ?? null).slice(0, 200));
  const carolAgain = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, new Jar(), carol);
  check("SMS: a later sign-in validates a texted code", new URL(carolAgain.url).pathname === "/ref/api/me" && carolAgain.res.status === 200 && validateSubmits === 1, `${carolAgain.res.status} ${carolAgain.url} codes=${validateSubmits}`);

  const dave = { username: "dave", password: "Dave-Password-123456", email: "dave@kisaes.com", mfa: "email" };
  await ensureUser(dave, "Dave Email");
  const daveIn = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, new Jar(), dave);
  check("email: first sign-in (enrol, then confirm) lands on the MFA-requiring product", new URL(daveIn.url).pathname === "/ref/api/me" && daveIn.res.status === 200, `${daveIn.res.status} ${daveIn.url} ${(daveIn.body ?? "").slice(0, 120)}`);
  const daveAgain = await runThroughAuthentik(`${APP}/auth/oidc/start?return_to=/ref/api/me`, new Jar(), dave);
  check("email: a later sign-in validates an emailed code", new URL(daveAgain.url).pathname === "/ref/api/me" && daveAgain.res.status === 200 && validateSubmits === 1, `${daveAgain.res.status} ${daveAgain.url} codes=${validateSubmits}`);

  // Users page "Email reset link" goes through authentik's recovery_email endpoint and the recovery stage.
  const davePk = (await json(`${AK}/api/v3/core/users/?username=dave`, { headers: akHeaders })).body.results[0].pk;
  const mailBefore = (await caught("mail")).length;
  const reset = await adminApi(`/users/${davePk}/recovery-email`, "POST");
  check("admin emails a password-reset link", reset.status === 200, `${reset.status} ${JSON.stringify(reset.body)}`);
  let resetMail;
  for (let i = 0; i < 30 && !resetMail; i++) {
    resetMail = (await caught("mail")).slice(mailBefore).find((m) => m.to.includes(dave.email) && /Subject: Reset your password/.test(m.data));
    if (!resetMail) await sleep(500);
  }
  check("the reset email is delivered through the admin-set mail server", !!resetMail);
  const resetLink = resetMail ? /https?:\/\/[^\s"'<>]+flow_token=[^\s"'<>&]+/.exec(resetMail.data)?.[0] : undefined;
  check("the emailed reset link points at the public authentik, not the container", !!resetLink && resetLink.startsWith(`${AK}/if/flow/vibe-recovery/`), resetLink);
  const copied = await adminApi(`/users/${davePk}/recovery-link`, "POST");
  check("the copyable recovery link points at the public authentik", copied.status === 200 && String(copied.body.link).startsWith(`${AK}/if/flow/vibe-recovery/`), copied.body.link);

  // 7e. invitations (broker invite.ts): a new person gets a welcome email, not a reset; it can be resent
  // until they sign in. Same recovery flow underneath, one token shared by the email and the admin's copy.
  const erinEmail = "erin@kisaes.com";
  const stale = (await json(`${AK}/api/v3/core/users/?username=${erinEmail}`, { headers: akHeaders })).body.results?.find((u) => u.username === erinEmail);
  if (stale) await fetch(`${AK}/api/v3/core/users/${stale.pk}/`, { method: "DELETE", headers: akHeaders });
  const welcomeMail = async (from, label) => {
    for (let i = 0; i < 30; i++) {
      const m = (await caught("mail")).slice(from).find((x) => x.to.includes(erinEmail) && /Subject: Set up your /.test(x.data));
      if (m) return m;
      await sleep(500);
    }
    check(label, false, JSON.stringify((await caught("mail")).slice(from).map((x) => x.to)).slice(0, 200));
    return null;
  };
  const welcomeStage = (await json(`${AK}/api/v3/stages/email/?name=vibe-welcome-email`, { headers: akHeaders })).body.results?.[0];
  check("the welcome stage exists and uses the mounted Vibe template", welcomeStage?.template === "vibe/welcome.html", JSON.stringify({ template: welcomeStage?.template, subject: welcomeStage?.subject }));
  const recoveryFlow = (await json(`${AK}/api/v3/flows/instances/vibe-recovery/`, { headers: akHeaders })).body;
  check("the recovery page is titled for both resets and invitations", recoveryFlow?.title === "Set your password", recoveryFlow?.title);
  const beforeInvite = (await caught("mail")).length;
  const created = await adminApi("/users", "POST", { email: erinEmail, name: "Erin Invite", groups: ["vibe-staff"] });
  check("admin adds a user: invitation emailed, link valid 3 days", created.status === 200 && created.body.emailed === true && created.body.validFor === "3 days" && String(created.body.recoveryLink).startsWith(`${AK}/if/flow/vibe-recovery/`), JSON.stringify(created.body).slice(0, 300));
  const invite = await welcomeMail(beforeInvite, "the invitation email is delivered");
  const inviteText = invite ? mailText(invite.data) : "";
  check("the invitation reads as a welcome, not a password reset", /Set up your Kisaes Test CPA sign-in/.test(invite?.data ?? "") && /Welcome/.test(inviteText) && /Set my password/.test(inviteText) && !/requested to change your password/.test(inviteText), inviteText.replace(/\s+/g, " ").slice(0, 300));
  const token = (s) => /flow_token=([A-Za-z0-9_-]+)/.exec(s ?? "")?.[1];
  check("the emailed link and the admin's copy are the same one-time token", !!token(invite?.data) && token(mailText(invite?.data ?? "")) === token(created.body.recoveryLink), `${token(mailText(invite?.data ?? ""))} vs ${token(created.body.recoveryLink)}`);
  const beforeResend = (await caught("mail")).length;
  const resent = await adminApi(`/users/${created.body.pk}/invite`, "POST");
  check("admin resends the invitation to someone who has not signed in", resent.status === 200 && resent.body.emailed === true && resent.body.to === erinEmail && resent.body.validFor === "3 days", `${resent.status} ${JSON.stringify(resent.body).slice(0, 200)}`);
  check("the resent invitation is delivered", !!(await welcomeMail(beforeResend, "the resent invitation is delivered")));
  // 7f. brand logo upload (authentik file storage). authentik only offers uploads when /data is a
  // mount point; with the old /media mount every upload was a 500 ("Response returned an error code").
  const logoName = `vibe-it-logo-${Date.now()}.svg`;
  const form = new FormData();
  form.append("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#98AC33"/></svg>'], { type: "image/svg+xml" }), logoName);
  form.append("usage", "media");
  const upload = await fetch(`${AK}/api/v3/admin/file/`, { method: "POST", headers: { authorization: akHeaders.authorization }, body: form });
  check("authentik accepts a brand logo upload (file storage is mounted at /data)", upload.ok, `${upload.status} ${(await upload.text()).slice(0, 200)}`);
  const brandNow = await json(`${AK}/api/v3/core/brands/?domain=authentik-default`, { headers: akHeaders });
  const brandPk = brandNow.body.results?.[0]?.brand_uuid;
  const setLogo = await json(`${AK}/api/v3/core/brands/${brandPk}/`, { method: "PATCH", headers: akHeaders, body: JSON.stringify({ branding_logo: logoName }) });
  check("the uploaded file can be set as the brand logo", setLogo.status === 200 && setLogo.body.branding_logo === logoName, `${setLogo.status} ${JSON.stringify(setLogo.body).slice(0, 200)}`);
  // What the sign-in page asks for (anonymous): the brand's logo as a signed /auth/files/... URL.
  const logoUrl = (await json(`${AK}/api/v3/core/brands/current/`, { headers: { accept: "application/json" } })).body.branding_logo;
  const served = logoUrl ? await fetch(new URL(logoUrl, `${AK}/`).toString()) : null;
  check("the logo is served to browsers through the public /auth/ path", !!served && served.ok && (await served.text()).includes("98AC33"), `${served?.status} ${logoUrl}`);
  await json(`${AK}/api/v3/core/brands/${brandPk}/`, { method: "PATCH", headers: akHeaders, body: JSON.stringify({ branding_logo: "/static/dist/assets/icons/icon_left_brand.svg" }) });

  const notInvitable = await adminApi(`/users/${davePk}/invite`, "POST");
  check("resend is refused for someone who has already signed in", notInvitable.status === 409 && /already signed in/.test(String(notInvitable.body.error)), `${notInvitable.status} ${JSON.stringify(notInvitable.body)}`);

  const smsOff = await adminApi("/mfa/methods/sms", "DELETE");
  const emailOff = await adminApi("/mfa/methods/email", "PUT", { enabled: false });
  check("admin turns both code methods off", smsOff.status === 200 && smsOff.body.sms?.enabled === false && emailOff.status === 200 && emailOff.body.email?.enabled === false);
  const stageOff = await stageNow();
  check("off again: code devices are no longer accepted, enforcement still on", !stageOff.device_classes.includes("sms") && !stageOff.device_classes.includes("email") && stageOff.configuration_stages.length === 2 && stageOff.not_configured_action === "configure", JSON.stringify({ classes: stageOff.device_classes, stages: stageOff.configuration_stages.length, action: stageOff.not_configured_action }));
  await adminApi("/email", "DELETE");

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
