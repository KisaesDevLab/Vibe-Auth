import { StrictMode, useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

/** Vibe Auth firm admin console (Phase 5). Served at {basePath}/admin; API at {basePath}/api/admin. */

const BASE = (() => {
  const m = /^(.*)\/admin(\/|$)/.exec(window.location.pathname);
  return m ? m[1]! : "/vibe-auth";
})();
const API = `${BASE}/api/admin`;

class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: unknown; login?: string },
  ) {
    super(typeof body.error === "string" ? body.error : JSON.stringify(body.error ?? `HTTP ${status}`));
  }
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; login?: string };
  if (res.status === 401 && body.login) {
    window.location.href = body.login;
    throw new ApiError(401, body);
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

type Overview = {
  brand: string;
  firm?: string;
  routing: { mode: string; host: string; publicBase: string; internalBase: string };
  authentik: { version?: string; reachable: boolean; adminUrl: string };
  counts: { users: number; registrations: number };
  setup: { done: boolean; completedAt?: string; adminEmail?: string };
  mfaRequired: boolean;
  mfaMethods: MfaMethods;
  broker: { version: string; signOutUrl: string };
  email: EmailStatus;
};
type MfaMethods = {
  email: { enabled: boolean; deliverable: boolean };
  sms: { enabled: boolean; provider?: "twilio" | "textlink" | "generic"; accountSid?: string; url?: string; from?: string };
  updatedAt?: string;
  updatedBy?: string;
};
type EmailStatus = {
  configured: boolean;
  source: "admin" | "env" | "none";
  host?: string;
  port?: number;
  username?: string;
  security?: "starttls" | "ssl" | "none";
  from?: string;
  updatedAt?: string;
  updatedBy?: string;
  recoveryUrl: string;
};
type User = { pk: number; username: string; name: string; email: string; active: boolean; superuser: boolean; lastLogin: string | null; groups: string[] };
type Reg = { slug: string; displayName: string; baseUrl: string; clientId: string; status: string; updatedAt: string; rotatedAt: string | null; publicPaths: string[] };
type Access = {
  apps: Array<{ slug: string; displayName: string; restricted: boolean; registered: boolean; members: number }>;
  users: Array<{ pk: number; apps: string[]; admin: boolean }>;
};
type Verify = { slug: string; ok: boolean; problems: string[]; issuer: string };
type Source = { slug: string; name: string; enabled: boolean; type?: string; callbackUrl: string };
type Audit = { type: string; at: string; [k: string]: unknown };

const GROUPS = ["vibe-admin", "vibe-partner", "vibe-manager", "vibe-staff", "vibe-it"];
const PAGES = [
  ["overview", "Overview"],
  ["users", "Users"],
  ["products", "Products"],
  ["sources", "Identity sources"],
  ["email", "Email"],
  ["mfa", "MFA methods"],
  ["audit", "Audit"],
] as const;
type Page = (typeof PAGES)[number][0];

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

function OverviewPage() {
  const { data: o, error, reload } = useLoad(() => api<Overview>("/overview"));
  const [busy, setBusy] = useState(false);
  if (error) return <p role="alert">{error}</p>;
  if (!o) return <p>Loading…</p>;
  const toggleMfa = async () => {
    if (o.mfaRequired && !window.confirm("Disable MFA enforcement for every sign-in? This is recorded in the audit log with your identity.")) return;
    setBusy(true);
    try {
      await api("/mfa", { method: "PUT", body: JSON.stringify({ required: !o.mfaRequired, ack: true }) });
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="grid2">
        <div className="card">
          <h2>{o.firm ?? o.brand}</h2>
          <p className="muted">Broker {o.broker.version} · authentik {o.authentik.version ?? "unreachable"} <span className={`pill ${o.authentik.reachable ? "ok" : "bad"}`}>{o.authentik.reachable ? "reachable" : "down"}</span></p>
          <p className="muted">Routing <code>{o.routing.mode}</code> · public <code>{o.routing.publicBase}</code> · internal <code>{o.routing.internalBase}</code></p>
          <p className="muted">{o.counts.users} users · {o.counts.registrations} registered products · setup {o.setup.done ? `done (${o.setup.adminEmail})` : "pending"}</p>
          <p className="muted">
            Password-reset email <span className={`pill ${o.email.configured ? "ok" : "bad"}`}>{o.email.configured ? `${o.email.source === "env" ? "container settings" : "configured"} · ${o.email.host}` : "not configured"}</span>
            {!o.email.configured && <> — staff cannot reset their own passwords. <a href={`${BASE}/admin/email`}>Set up email</a>.</>}
          </p>
          <div className="row">
            <a href={o.authentik.adminUrl} target="_blank" rel="noreferrer"><button>Open authentik admin</button></a>
            <a href={o.broker.signOutUrl}><button>Sign out</button></a>
          </div>
        </div>
        <div className="card">
          <h2>Multi-factor authentication</h2>
          <p className="muted">{o.mfaRequired ? `Every sign-in must complete MFA (authenticator app, passkey or security key${o.mfaMethods.sms.enabled ? ", text message code" : ""}${o.mfaMethods.email.enabled ? ", email code" : ""}). Users without a device are asked to enrol one.` : "MFA enforcement is DISABLED. Users may sign in with a password only."}</p>
          <button className={o.mfaRequired ? "danger" : "primary"} disabled={busy} onClick={() => void toggleMfa()}>
            {o.mfaRequired ? "Disable enforcement (logged)" : "Enable enforcement"}
          </button>
          <p className="muted"><a href={`${BASE}/admin/mfa`}>Choose which methods staff may use</a></p>
        </div>
      </div>
    </>
  );
}

type Invite = { emailed: boolean; emailError?: string; link: string | null; validFor: string };

// What the admin sees after an invitation: whether it was emailed, and the same one-time link to
// pass on by hand (it is the link in the email, so handing it over does not cancel the email).
function showInvite(to: string, r: Invite, lead: string) {
  const sent = r.emailed
    ? `${lead} An invitation to set a password was emailed to ${to}.\nIf it does not arrive, give them this one-time link (valid ${r.validFor}):`
    : `${lead} No invitation email was sent${r.emailError ? ` (${r.emailError})` : ""}.\nGive ${to} this one-time link to set a password (valid ${r.validFor}):`;
  if (r.link) window.prompt(sent, r.link);
  else alert(`${lead} ${r.emailed ? `An invitation was emailed to ${to} (valid ${r.validFor}).` : "No invitation could be sent or created; try Resend invite."}`);
}

function UsersPage() {
  const { data: users, error, reload: reloadUsers } = useLoad(() => api<User[]>("/users"));
  const { data: access, reload: reloadAccess } = useLoad(() => api<Access>("/access"));
  const reload = () => {
    reloadUsers();
    reloadAccess();
  };
  // Every registered product gets a box per user. An open product admits every firm user, so its box
  // shows ticked; unticking someone restricts the product (seeded with everyone) and then drops them.
  const apps = (access?.apps ?? []).filter((a) => a.registered).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const restrictedApps = apps.filter((a) => a.restricted);
  const [busy, setBusy] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const act = async (pk: number, fn: () => Promise<unknown>) => {
    setBusy(pk);
    try {
      await fn();
      reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const createUser = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const groups = GROUPS.filter((g) => fd.get(g) === "on");
    const apps = restrictedApps.filter((a) => fd.get(`app:${a.slug}`) === "on").map((a) => a.slug);
    try {
      const r = await api<{ emailed: boolean; emailError?: string; recoveryLink: string | null; validFor?: string; recoveryUrl: string }>("/users", { method: "POST", body: JSON.stringify({ email: fd.get("email"), name: fd.get("name"), groups, apps }) });
      showInvite(String(fd.get("email")), { emailed: r.emailed, emailError: r.emailError, link: r.recoveryLink ?? r.recoveryUrl, validFor: r.validFor ?? "3 days" }, "User created.");
      setShowNew(false);
      reload();
    } catch (err) {
      alert((err as Error).message);
    }
  };
  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Users</h2>
        <button className="primary" onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancel" : "Add user"}</button>
      </div>
      {showNew && (
        <form onSubmit={createUser} className="grid2" style={{ marginBottom: "1rem" }}>
          <label>Name<input name="name" required /></label>
          <label>Email<input name="email" type="email" required /></label>
          <div className="row">{GROUPS.map((g) => (<label key={g} className="row" style={{ gap: ".3rem" }}><input type="checkbox" name={g} defaultChecked={g === "vibe-staff"} />{g}</label>))}</div>
          {apps.length > 0 && (
            <div className="row">
              <span className="muted">Apps:</span>
              {apps.map((a) => (
                <label key={a.slug} className="row" style={{ gap: ".3rem" }} title={a.restricted ? undefined : `${a.displayName} is open to every firm user. Untick someone on the list below to restrict it.`}>
                  <input type="checkbox" name={`app:${a.slug}`} defaultChecked={!a.restricted} disabled={!a.restricted} />
                  {a.displayName}
                </label>
              ))}
            </div>
          )}
          <div><button className="primary" type="submit">Create</button></div>
        </form>
      )}
      {!users ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>User</th><th>Groups</th><th title="Products this person may sign in to. Open products show ticked for everyone; untick someone to restrict that product to the people you choose.">Apps</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.pk}>
                <td>{u.name}<br /><span className="muted">{u.email || u.username}</span>{u.superuser && <> <span className="pill">superuser</span></>}</td>
                <td>
                  <div className="row" style={{ gap: ".25rem" }}>
                    {GROUPS.map((g) => (
                      <label key={g} className="row" style={{ gap: ".2rem", fontSize: ".8rem" }}>
                        <input type="checkbox" checked={u.groups.includes(g)} disabled={busy === u.pk} onChange={(e) => void act(u.pk, () => api(`/users/${u.pk}/groups`, { method: "PUT", body: JSON.stringify({ groups: e.target.checked ? [...u.groups.filter((x) => GROUPS.includes(x)), g] : u.groups.filter((x) => x !== g && GROUPS.includes(x)) }) }))} />
                        {g.replace("vibe-", "")}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  {(() => {
                    const mine = access?.users.find((x) => x.pk === u.pk);
                    if (!access) return <span className="muted">…</span>;
                    if (apps.length === 0) return <span className="muted">no products registered</span>;
                    if (mine?.admin) return <span className="muted" title="vibe-admin members can always sign in to every product">all apps (admin)</span>;
                    const who = u.email || u.username;
                    return (
                      <div className="row" style={{ gap: ".25rem" }}>
                        {apps.map((a) => {
                          const has = a.restricted ? (mine?.apps ?? []).includes(a.slug) : true;
                          return (
                            <label key={a.slug} className="row" style={{ gap: ".2rem", fontSize: ".8rem" }} title={a.restricted ? `${a.displayName} is restricted to the people ticked here` : `${a.displayName} is open to every firm user. Untick to restrict it and leave ${who} out.`}>
                              <input
                                type="checkbox"
                                checked={has}
                                disabled={busy === u.pk}
                                onChange={(e) => {
                                  const on = e.target.checked;
                                  // Memberships of other products stay untouched: send everything they have, plus or minus this one.
                                  const next = on ? [...(mine?.apps ?? []), a.slug] : (mine?.apps ?? []).filter((x) => x !== a.slug);
                                  const setApps = () => api(`/users/${u.pk}/apps`, { method: "PUT", body: JSON.stringify({ apps: next }) });
                                  if (on) return void act(u.pk, setApps);
                                  if (!a.restricted) {
                                    if (!window.confirm(`${a.displayName} is currently open to everyone.\n\nRestrict it to the people ticked on this page? Everyone with an active account keeps access except ${who}, who is signed out of every product now and can sign back in to the apps they still have. Administrators always keep access.`)) return;
                                    return void act(u.pk, async () => {
                                      await api(`/registrations/${a.slug}/access`, { method: "PUT", body: JSON.stringify({ restricted: true, seed: "everyone" }) });
                                      await setApps();
                                    });
                                  }
                                  if (!window.confirm(`Remove ${a.displayName} from ${who}? They are signed out of every product now and can sign back in to the apps they still have.`)) return;
                                  void act(u.pk, setApps);
                                }}
                              />
                              {a.displayName}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })()}
                </td>
                <td><span className={`pill ${u.active ? "ok" : "bad"}`}>{u.active ? "active" : "disabled"}</span></td>
                <td className="muted">{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : u.active ? "never — invitation pending" : "never"}</td>
                <td>
                  <div className="row">
                    <button disabled={busy === u.pk} onClick={() => window.confirm(`Remove all MFA devices for ${u.email}? They will re-enrol at next sign-in.`) && void act(u.pk, () => api(`/users/${u.pk}/mfa-reset`, { method: "POST" }))}>Reset MFA</button>
                    {!u.lastLogin && u.active ? (
                      // Never signed in: they are still waiting on their invitation, not resetting a password.
                      <button disabled={busy === u.pk} title="Email the invitation again (and show its one-time link), valid for another 3 days" onClick={() => window.confirm(`Resend the invitation to ${u.email || u.username}? Their set-password link is renewed for another 3 days; the link in the earlier email keeps working.`) && void act(u.pk, async () => { const r = await api<Invite & { to: string }>(`/users/${u.pk}/invite`, { method: "POST" }); showInvite(r.to, r, "Invitation resent."); })}>Resend invite</button>
                    ) : (
                      <>
                        <button disabled={busy === u.pk} title="Email a one-time set-password link through the recovery flow" onClick={() => void act(u.pk, async () => { const r = await api<{ to: string }>(`/users/${u.pk}/recovery-email`, { method: "POST" }); alert(`Reset email queued for ${r.to}.`); })}>Send reset email</button>
                        <button disabled={busy === u.pk} title="Create a one-time set-password link to hand over in person or by chat" onClick={() => void act(u.pk, async () => { const r = await api<{ link: string }>(`/users/${u.pk}/recovery-link`, { method: "POST" }); window.prompt(`One-time password-reset link for ${u.email || u.username} (valid 30 minutes, shown once):`, r.link); })}>Reset link</button>
                      </>
                    )}
                    <button disabled={busy === u.pk} onClick={() => void act(u.pk, () => api(`/users/${u.pk}/sessions/end`, { method: "POST" }))}>End sessions</button>
                    <button className={u.active ? "danger" : "primary"} disabled={busy === u.pk} onClick={() => void act(u.pk, () => api(`/users/${u.pk}/active`, { method: "POST", body: JSON.stringify({ active: !u.active }) }))}>{u.active ? "Deactivate" : "Activate"}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProductsPage() {
  const { data: regs, error, reload: reloadRegs } = useLoad(() => api<Reg[]>("/registrations"));
  const { data: access, reload: reloadAccess } = useLoad(() => api<Access>("/access"));
  const reload = () => {
    reloadRegs();
    reloadAccess();
  };
  const [verify, setVerify] = useState<Verify[] | null>(null);
  const setAccess = async (r: Reg, restricted: boolean) => {
    let seed: "everyone" | "none" = "none";
    if (restricted) {
      if (!window.confirm(`Restrict ${r.displayName}? Only the people you tick on the Users page (and vibe-admin members) will be able to sign in with single sign-on.`)) return;
      seed = window.confirm("Start with everyone who has an active account, then untick people?\n\nOK = start with everyone\nCancel = start with administrators only") ? "everyone" : "none";
    } else if (!window.confirm(`Open ${r.displayName} to every firm user again? The list of ticked users is kept in case you restrict it later.`)) return;
    try {
      await api(`/registrations/${r.slug}/access`, { method: "PUT", body: JSON.stringify({ restricted, seed }) });
      reload();
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const orphans = (access?.apps ?? []).filter((a) => !a.registered);
  const runVerify = async () => setVerify(await api<Verify[]>("/registrations/verify"));
  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Registered products</h2>
        <button onClick={() => void runVerify()}>Verify all</button>
      </div>
      <p className="muted">Products are registered by the Appliance console (or `POST /registrations` with the console token). Each product decides its own sign-in mode (local / both / oidc_only) in its Settings → Authentication page.</p>
      <p className="muted">Access: a product is open to every firm user until you restrict it (here, or by unticking someone on the Users page); then only the people ticked on the Users page and vibe-admin members can use single sign-on. This does not block a local password in a product that is still in <code>both</code> mode.</p>
      {!regs ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>Product</th><th>Base URL</th><th>Client ID</th><th>Access</th><th>Updated</th><th>Check</th><th /></tr></thead>
          <tbody>
            {regs.map((r) => {
              const v = verify?.find((x) => x.slug === r.slug);
              const a = access?.apps.find((x) => x.slug === r.slug);
              return (
                <tr key={r.slug}>
                  <td>{r.displayName}<br /><span className="muted">{r.slug}</span></td>
                  <td><code>{r.baseUrl}</code></td>
                  <td><code>{r.clientId}</code></td>
                  <td>
                    {r.slug === "vibe-auth-admin" ? <span className="muted">admins only</span> : !a ? <span className="muted">…</span> : (
                      <div className="row" style={{ gap: ".4rem" }}>
                        <span className={`pill ${a.restricted ? "" : "ok"}`}>{a.restricted ? `Restricted · ${a.members} user${a.members === 1 ? "" : "s"}` : "Everyone"}</span>
                        <button onClick={() => void setAccess(r, !a.restricted)}>{a.restricted ? "Open to everyone" : "Restrict"}</button>
                      </div>
                    )}
                  </td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString()}{r.rotatedAt && <><br />rotated {new Date(r.rotatedAt).toLocaleDateString()}</>}</td>
                  <td>{v ? (v.ok ? <span className="pill ok">ok</span> : <span className="pill bad" title={v.problems.join("\n")}>{v.problems.length} problem(s)</span>) : <span className="muted">—</span>}{v && !v.ok && <ul className="muted">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>}</td>
                  <td>{r.slug !== "vibe-auth-admin" && <button className="danger" onClick={() => window.confirm(`Disable SSO registration for ${r.displayName}? The product falls back to local sign-in.`) && api(`/registrations/${r.slug}`, { method: "DELETE" }).then(reload)}>Disable</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {orphans.length > 0 && (
        <p className="muted">
          Restricted but no longer registered (the restriction returns if the product is registered again):{" "}
          {orphans.map((o) => (<span key={o.slug} className="row" style={{ display: "inline-flex", gap: ".3rem", marginRight: ".6rem" }}><code>{o.slug}</code><button onClick={() => window.confirm(`Forget the restriction on ${o.slug}?`) && api(`/access/${o.slug}`, { method: "DELETE" }).then(reload)}>Forget</button></span>))}
        </p>
      )}
    </div>
  );
}

function SourcesPage() {
  const { data: sources, error, reload } = useLoad(() => api<Source[]>("/sources"));
  const [type, setType] = useState<"entra" | "google">("entra");
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      const r = await api<{ callbackUrl: string }>("/sources", { method: "POST", body: JSON.stringify({ type, clientId: fd.get("clientId"), clientSecret: fd.get("clientSecret"), tenantId: fd.get("tenantId") || undefined }) });
      setMsg(`Saved. Register this redirect URI with the provider: ${r.callbackUrl}`);
      reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  if (error) return <p role="alert">{error}</p>;
  return (
    <>
      <div className="card">
        <h2>Federated identity sources</h2>
        <p className="muted">Firms on Microsoft 365 or Google Workspace sign in with their existing accounts. Roles come from Entra App Roles or groups named <code>vibe-*</code>. Local accounts and MFA enforcement keep working alongside.</p>
        {!sources ? <p>Loading…</p> : sources.length === 0 ? <p className="muted">No sources configured.</p> : (
          <table>
            <thead><tr><th>Source</th><th>Type</th><th>Redirect URI (register with provider)</th><th /></tr></thead>
            <tbody>{sources.map((s) => (<tr key={s.slug}><td>{s.name} <span className={`pill ${s.enabled ? "ok" : ""}`}>{s.enabled ? "enabled" : "disabled"}</span></td><td>{s.type}</td><td><code>{s.callbackUrl}</code></td><td><button className="danger" onClick={() => window.confirm(`Remove ${s.name}?`) && api(`/sources/${s.slug}`, { method: "DELETE" }).then(reload)}>Remove</button></td></tr>))}</tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Add or update a source</h2>
        <form onSubmit={submit} className="grid2">
          <label>Provider<select value={type} onChange={(e) => setType(e.target.value as "entra" | "google")}><option value="entra">Microsoft Entra ID</option><option value="google">Google Workspace</option></select></label>
          {type === "entra" && <label>Directory (tenant) ID<input name="tenantId" required placeholder="00000000-0000-0000-0000-000000000000" /></label>}
          <label>Client ID<input name="clientId" required /></label>
          <label>Client secret<input name="clientSecret" type="password" required autoComplete="off" /></label>
          <div><button className="primary" type="submit">Save source</button></div>
        </form>
        {msg && <p className="muted">{msg}</p>}
        <p className="muted">{type === "entra" ? "In Entra: App registrations → your app → Authentication → add the redirect URI shown above; App roles → create vibe-admin / vibe-partner / vibe-manager / vibe-staff / vibe-it and assign users; Token configuration → add the roles and email claims." : "In Google Cloud Console: OAuth client (Web) → add the redirect URI shown above. Map groups by naming Google groups vibe-*."}</p>
      </div>
    </>
  );
}

function EmailPage() {
  const { data: st, error, reload } = useLoad(() => api<EmailStatus>("/email"));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [security, setSecurity] = useState<"starttls" | "ssl" | "none">("starttls");
  useEffect(() => {
    if (st?.source === "admin" && st.security) setSecurity(st.security);
  }, [st]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    void run(async () => {
      await api("/email", { method: "PUT", body: JSON.stringify({ host: fd.get("host"), port: fd.get("port"), security, username: fd.get("username") || undefined, password: fd.get("password") || undefined, from: fd.get("from") }) });
      return "Saved and applied to the recovery flow. Send yourself a test to confirm delivery.";
    });
  };
  if (error) return <p role="alert">{error}</p>;
  if (!st) return <p>Loading…</p>;
  const editing = st.source === "admin" ? st : null;
  return (
    <>
      <div className="card">
        <h2>Outbound email</h2>
        <p className="muted">
          Used for the sign-in page's "Forgot password?" flow and for the reset emails sent from the Users page. Status:{" "}
          <span className={`pill ${st.configured ? "ok" : "bad"}`}>{st.configured ? (st.source === "env" ? "container settings" : "configured here") : "not configured"}</span>
          {st.configured && <> · {st.host}:{st.port} · from {st.from}{st.username ? ` · as ${st.username}` : ""}{st.updatedAt ? ` · saved ${new Date(st.updatedAt).toLocaleString()} by ${st.updatedBy}` : ""}</>}
        </p>
        <p className="muted">Self-service reset page: <code>{st.recoveryUrl}</code></p>
        <div className="row">
          <button className="primary" disabled={busy || !st.configured} onClick={() => void run(async () => { const r = await api<{ to: string }>("/email/test", { method: "POST", body: JSON.stringify({}) }); return `Test email delivered to the mail server for ${r.to}. Check that inbox.`; })}>Send me a test email</button>
          {st.source === "admin" && <button className="danger" disabled={busy} onClick={() => window.confirm("Remove these settings? The recovery flow falls back to the container's AUTHENTIK_EMAIL__* values (if any).") && void run(async () => { await api("/email", { method: "DELETE" }); return "Settings removed."; })}>Remove settings</button>}
        </div>
        {msg && <p className={msg.ok ? "muted" : ""} role={msg.ok ? undefined : "alert"} style={msg.ok ? undefined : { color: "#dc2626" }}>{msg.text}</p>}
      </div>
      <div className="card">
        <h2>{editing ? "Update mail server" : "Add a mail server"}</h2>
        <form onSubmit={save} className="grid2" key={editing?.updatedAt ?? "new"}>
          <label>SMTP host<input name="host" required defaultValue={editing?.host ?? ""} placeholder="smtp.office365.com" autoComplete="off" /></label>
          <label>Port<input name="port" type="number" min={1} max={65535} required defaultValue={editing?.port ?? (security === "ssl" ? 465 : 587)} /></label>
          <label>Encryption<select value={security} onChange={(e) => setSecurity(e.target.value as typeof security)}><option value="starttls">STARTTLS (port 587)</option><option value="ssl">SSL/TLS (port 465)</option><option value="none">None (internal relay only)</option></select></label>
          <label>From address<input name="from" type="email" required defaultValue={editing?.from ?? ""} placeholder="vibe-auth@firm.example" /></label>
          <label>Username (blank = no authentication)<input name="username" defaultValue={editing?.username ?? ""} autoComplete="off" /></label>
          <label>Password{editing?.username ? " (blank keeps the saved one)" : ""}<input name="password" type="password" autoComplete="new-password" /></label>
          <div><button className="primary" type="submit" disabled={busy}>Save</button></div>
        </form>
        <p className="muted">Microsoft 365: smtp.office365.com, port 587, STARTTLS, a mailbox with "Authenticated SMTP" enabled. Google Workspace: smtp.gmail.com, port 587, STARTTLS, an app password. The password is stored encrypted with the broker key and handed to authentik; it is never shown again.</p>
      </div>
    </>
  );
}

function MfaPage() {
  const { data: st, error, reload } = useLoad(() => api<MfaMethods>("/mfa/methods"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [provider, setProvider] = useState<"twilio" | "textlink" | "generic">("twilio");
  useEffect(() => {
    if (st?.sms.provider) setProvider(st.sms.provider);
  }, [st]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const saveSms = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => String(fd.get(k) ?? "").trim() || undefined;
    void run(async () => {
      await api("/mfa/methods/sms", { method: "PUT", body: JSON.stringify({ provider, accountSid: v("accountSid"), url: v("url"), from: v("from"), token: v("token") }) });
      return "Text message codes are on. Staff can add a phone number the next time they are asked to set up a sign-in method.";
    });
  };
  if (error) return <p role="alert">{error}</p>;
  if (!st) return <p>Loading…</p>;
  const sms = st.sms;
  return (
    <>
      <div className="card">
        <h2>Sign-in methods</h2>
        <p className="muted">An authenticator app and a passkey or security key are always available. The two methods below are optional and weaker; turn them on only for staff who cannot use the others. Turning a method off stops its codes being accepted, and anyone who used only that method is asked to set up another at their next sign-in.</p>
        {msg && <p className={msg.ok ? "muted" : ""} role={msg.ok ? undefined : "alert"} style={msg.ok ? undefined : { color: "#dc2626" }}>{msg.text}</p>}
      </div>
      <div className="card">
        <h2>Code by email <span className={`pill ${st.email.enabled ? "ok" : "bad"}`}>{st.email.enabled ? "on" : "off"}</span></h2>
        <p className="muted">Sends a one-time code to the user's own address through the mail server on the Email page. Password-reset mail goes to the same mailbox, so anyone who can read a person's email can sign in as them.</p>
        {!st.email.deliverable && <p className="muted">Outbound email is not configured. <a href={`${BASE}/admin/email`}>Set up a mail server</a> first.</p>}
        <button className={st.email.enabled ? "danger" : "primary"} disabled={busy || (!st.email.enabled && !st.email.deliverable)} onClick={() => void run(async () => { await api("/mfa/methods/email", { method: "PUT", body: JSON.stringify({ enabled: !st.email.enabled }) }); return st.email.enabled ? "Email codes are off." : "Email codes are on."; })}>
          {st.email.enabled ? "Turn off email codes" : "Turn on email codes"}
        </button>
      </div>
      <div className="card">
        <h2>Code by text message <span className={`pill ${sms.enabled ? "ok" : "bad"}`}>{sms.enabled ? `on · ${sms.provider}` : "off"}</span></h2>
        <p className="muted">Sends a one-time code to the user's mobile number through your SMS provider. Each message is billed by the provider.</p>
        <form onSubmit={saveSms} className="grid2" key={`${sms.provider ?? "new"}:${st.updatedAt ?? ""}`}>
          <label>Provider<select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}><option value="twilio">Twilio</option><option value="textlink">TextLink</option><option value="generic">Other (HTTP gateway)</option></select></label>
          {provider === "twilio" && <label>Account SID<input name="accountSid" required defaultValue={sms.provider === "twilio" ? sms.accountSid ?? "" : ""} placeholder="AC…" autoComplete="off" /></label>}
          {provider !== "twilio" && <label>{provider === "textlink" ? "TextLink API base URL" : "Gateway URL"}<input key={provider} name="url" type="url" required defaultValue={sms.provider === provider ? sms.url ?? "" : provider === "textlink" ? "https://textlinksms.com" : ""} autoComplete="off" /></label>}
          {provider !== "textlink" && <label>{provider === "twilio" ? "From number or Messaging Service SID" : "From"}<input key={provider} name="from" required defaultValue={sms.provider === provider ? sms.from ?? "" : ""} placeholder="+15551234567" autoComplete="off" /></label>}
          <label>{provider === "twilio" ? "Auth token" : "API key"}{sms.provider === provider ? " (blank keeps the saved one)" : ""}<input name="token" type="password" autoComplete="new-password" /></label>
          <div className="row">
            <button className="primary" type="submit" disabled={busy}>{sms.enabled ? "Save" : "Turn on text message codes"}</button>
            {sms.enabled && <button className="danger" type="button" disabled={busy} onClick={() => window.confirm("Turn off text message codes? The saved provider key is removed.") && void run(async () => { await api("/mfa/methods/sms", { method: "DELETE" }); return "Text message codes are off."; })}>Turn off</button>}
          </div>
        </form>
        <p className="muted">{provider === "generic" ? "The gateway receives a JSON POST with From, To, Body and Message, and the API key as a Bearer token." : "The key is stored encrypted with the broker key and handed to authentik; it is never shown again."}</p>
      </div>
    </>
  );
}

function AuditPage() {
  const [type, setType] = useState("");
  const { data: events, error } = useLoad(() => api<Audit[]>(`/audit?limit=300${type ? `&type=${encodeURIComponent(type)}` : ""}`), [type]);
  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Audit events</h2>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all</option>
          {["vibe.auth.login", "vibe.auth.logout", "vibe.auth.registration", "vibe.auth.setup", "vibe.auth.mfa", "vibe.auth.settings", "vibe.auth.user", "vibe.auth.role"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {!events ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Details</th></tr></thead>
          <tbody>{events.map((e, i) => { const { type: t, at, ...rest } = e; return (<tr key={i}><td className="muted">{new Date(at).toLocaleString()}</td><td><code>{t}</code></td><td><code>{JSON.stringify(rest)}</code></td></tr>); })}</tbody>
        </table>
      )}
      <p className="muted">Also exported as JSON-lines (VIBE_AUTH_AUDIT_FILE) and, when configured, to Sentinel.</p>
    </div>
  );
}

function App() {
  const current = (): Page => {
    const seg = window.location.pathname.replace(`${BASE}/admin`, "").replace(/^\//, "").split("/")[0] as Page;
    return PAGES.some(([k]) => k === seg) ? seg : "overview";
  };
  const [page, setPage] = useState<Page>(current);
  const go = useCallback((p: Page) => {
    history.pushState(null, "", `${BASE}/admin/${p}`);
    setPage(p);
  }, []);
  useEffect(() => {
    const h = () => setPage(current());
    window.addEventListener("popstate", h);
    return () => window.removeEventListener("popstate", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <header>
        <h1>Vibe Auth</h1>
        <nav>{PAGES.map(([k, label]) => (<a key={k} href={`${BASE}/admin/${k}`} className={page === k ? "active" : ""} onClick={(e) => { e.preventDefault(); go(k); }}>{label}</a>))}</nav>
      </header>
      <main>
        {page === "overview" && <OverviewPage />}
        {page === "users" && <UsersPage />}
        {page === "products" && <ProductsPage />}
        {page === "sources" && <SourcesPage />}
        {page === "email" && <EmailPage />}
        {page === "mfa" && <MfaPage />}
        {page === "audit" && <AuditPage />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
