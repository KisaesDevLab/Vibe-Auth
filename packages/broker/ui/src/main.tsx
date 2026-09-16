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
  broker: { version: string };
};
type User = { pk: number; username: string; name: string; email: string; active: boolean; superuser: boolean; lastLogin: string | null; groups: string[] };
type Reg = { slug: string; displayName: string; baseUrl: string; clientId: string; status: string; updatedAt: string; rotatedAt: string | null; publicPaths: string[] };
type Verify = { slug: string; ok: boolean; problems: string[]; issuer: string };
type Source = { slug: string; name: string; enabled: boolean; type?: string; callbackUrl: string };
type Audit = { type: string; at: string; [k: string]: unknown };

const GROUPS = ["vibe-admin", "vibe-partner", "vibe-manager", "vibe-staff", "vibe-it"];
const PAGES = [
  ["overview", "Overview"],
  ["users", "Users"],
  ["products", "Products"],
  ["sources", "Identity sources"],
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
          <div className="row">
            <a href={o.authentik.adminUrl} target="_blank" rel="noreferrer"><button>Open authentik admin</button></a>
            <a href={`${BASE}/auth/oidc/logout`}><button>Sign out</button></a>
          </div>
        </div>
        <div className="card">
          <h2>Multi-factor authentication</h2>
          <p className="muted">{o.mfaRequired ? "Every sign-in must complete MFA (TOTP, passkey or security key). Users without a device are asked to enrol one." : "MFA enforcement is DISABLED. Users may sign in with a password only."}</p>
          <button className={o.mfaRequired ? "danger" : "primary"} disabled={busy} onClick={() => void toggleMfa()}>
            {o.mfaRequired ? "Disable enforcement (logged)" : "Enable enforcement"}
          </button>
        </div>
      </div>
    </>
  );
}

function UsersPage() {
  const { data: users, error, reload } = useLoad(() => api<User[]>("/users"));
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
    try {
      const r = await api<{ recoveryUrl: string }>("/users", { method: "POST", body: JSON.stringify({ email: fd.get("email"), name: fd.get("name"), groups }) });
      alert(`User created. Ask them to set a password at:\n${r.recoveryUrl}`);
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
          <div><button className="primary" type="submit">Create</button></div>
        </form>
      )}
      {!users ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>User</th><th>Groups</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
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
                <td><span className={`pill ${u.active ? "ok" : "bad"}`}>{u.active ? "active" : "disabled"}</span></td>
                <td className="muted">{u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "never"}</td>
                <td>
                  <div className="row">
                    <button disabled={busy === u.pk} onClick={() => window.confirm(`Remove all MFA devices for ${u.email}? They will re-enrol at next sign-in.`) && void act(u.pk, () => api(`/users/${u.pk}/mfa-reset`, { method: "POST" }))}>Reset MFA</button>
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
  const { data: regs, error, reload } = useLoad(() => api<Reg[]>("/registrations"));
  const [verify, setVerify] = useState<Verify[] | null>(null);
  const runVerify = async () => setVerify(await api<Verify[]>("/registrations/verify"));
  if (error) return <p role="alert">{error}</p>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Registered products</h2>
        <button onClick={() => void runVerify()}>Verify all</button>
      </div>
      <p className="muted">Products are registered by the Appliance console (or `POST /registrations` with the console token). Each product decides its own sign-in mode (local / both / oidc_only) in its Settings → Authentication page.</p>
      {!regs ? <p>Loading…</p> : (
        <table>
          <thead><tr><th>Product</th><th>Base URL</th><th>Client ID</th><th>Updated</th><th>Check</th><th /></tr></thead>
          <tbody>
            {regs.map((r) => {
              const v = verify?.find((x) => x.slug === r.slug);
              return (
                <tr key={r.slug}>
                  <td>{r.displayName}<br /><span className="muted">{r.slug}</span></td>
                  <td><code>{r.baseUrl}</code></td>
                  <td><code>{r.clientId}</code></td>
                  <td className="muted">{new Date(r.updatedAt).toLocaleString()}{r.rotatedAt && <><br />rotated {new Date(r.rotatedAt).toLocaleDateString()}</>}</td>
                  <td>{v ? (v.ok ? <span className="pill ok">ok</span> : <span className="pill bad" title={v.problems.join("\n")}>{v.problems.length} problem(s)</span>) : <span className="muted">—</span>}{v && !v.ok && <ul className="muted">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>}</td>
                  <td>{r.slug !== "vibe-auth-admin" && <button className="danger" onClick={() => window.confirm(`Disable SSO registration for ${r.displayName}? The product falls back to local sign-in.`) && api(`/registrations/${r.slug}`, { method: "DELETE" }).then(reload)}>Disable</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
        {page === "audit" && <AuditPage />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
