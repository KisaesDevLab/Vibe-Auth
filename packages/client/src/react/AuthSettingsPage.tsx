import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { authClient, type AuthSettingsDto, type ClientOptions } from "./api.js";

export interface AuthSettingsPageProps extends ClientOptions {
  /** Optional class names to blend with the product's design system. */
  classNames?: Partial<Record<"root" | "section" | "label" | "input" | "button" | "buttonPrimary" | "buttonDanger" | "table" | "note" | "error", string>>;
  /** Product display name for copy. */
  productName?: string;
}

const s: Record<string, CSSProperties> = {
  root: { display: "grid", gap: "1.5rem", maxWidth: 820 },
  section: { display: "grid", gap: ".6rem", padding: "1rem", border: "1px solid rgba(127,127,127,.3)", borderRadius: 10 },
  label: { display: "grid", gap: ".25rem", fontSize: ".9rem" },
  input: { padding: ".45rem .6rem", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", font: "inherit", background: "transparent", color: "inherit" },
  button: { padding: ".45rem .9rem", borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
  buttonPrimary: { padding: ".45rem .9rem", borderRadius: 6, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", font: "inherit" },
  buttonDanger: { padding: ".45rem .9rem", borderRadius: 6, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", font: "inherit" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: ".9rem" },
  note: { fontSize: ".85rem", opacity: 0.75, margin: 0 },
  error: { color: "#dc2626", fontSize: ".9rem", margin: 0 },
  row: { display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" },
  pill: { display: "inline-block", padding: ".1rem .5rem", borderRadius: 999, fontSize: ".75rem", background: "rgba(127,127,127,.2)" },
};

type Mode = AuthSettingsDto["mode"];

/**
 * Settings → Authentication (Phase 4): mode selector with guards, issuer /
 * client fields, role-map editor seeded with defaults, "Test connection"
 * popup, MFA enforcement toggle with logged acknowledgement, break-glass status.
 */
export function AuthSettingsPage(p: AuthSettingsPageProps) {
  const client = useMemo(() => authClient(p), [p.basePath, p.fetch, p.headers]); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<AuthSettingsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  // Form state
  const [issuer, setIssuer] = useState("");
  const [internalBase, setInternalBase] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [idpName, setIdpName] = useState("");
  const [allowJit, setAllowJit] = useState(true);
  const [requireMfa, setRequireMfa] = useState(false);
  const [defaultRole, setDefaultRole] = useState("");
  const [roleMap, setRoleMap] = useState<Array<{ key: string; role: string }>>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await client.settings();
      setData(d);
      setIssuer(d.stored.issuer ?? d.env.issuer ?? "");
      setInternalBase(d.stored.internalBase ?? d.env.internalBase ?? "");
      setClientId(d.stored.clientId ?? d.env.clientId ?? "");
      setIdpName(d.stored.idpName ?? d.effective?.idpName ?? "");
      setAllowJit(d.effective?.allowJit ?? true);
      setRequireMfa(d.effective?.requireMfaAmr ?? false);
      setDefaultRole(d.effective?.defaultRole ?? "");
      const rm = d.effective?.roleMap ?? d.stored.roleMap ?? {};
      setRoleMap(Object.entries(rm).map(([key, role]) => ({ key, role })));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Test-connection popup listener
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const d = ev.data as { type?: string; ok?: boolean; message?: string };
      if (d?.type !== "vibe-auth:test-result") return;
      setTestMsg(`${d.ok ? "✓" : "✗"} ${d.message ?? ""}`);
      void load();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const d = await client.saveSettings(patch);
      setData(d);
      setClientSecret("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveConnection = () =>
    save({
      issuer,
      internalBase,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      idpName,
      allowJit,
      defaultRole: defaultRole || "",
      roleMap: Object.fromEntries(roleMap.filter((r) => r.key.trim() && r.role).map((r) => [r.key.trim(), r.role])),
    });

  const setMode = async (mode: Mode) => {
    if (mode === "oidc_only") {
      const ok = window.confirm(
        `Switch ${p.productName ?? "this product"} to single sign-on only?\n\nLocal passwords will stop working for everyone except the break-glass account "${data?.breakglass.username}". Make sure you have stored its password.`,
      );
      if (!ok) return;
    }
    await save({ mode });
  };

  const toggleMfa = async (next: boolean) => {
    if (!next) {
      const ok = window.confirm("Disable MFA enforcement for single sign-on logins? This acknowledgement is recorded in the audit log.");
      if (!ok) return;
      await save({ requireMfaAmr: false, mfaAck: true });
    } else await save({ requireMfaAmr: true });
  };

  const test = async () => {
    setTestMsg(null);
    try {
      const { url } = await client.testUrl();
      const w = window.open(url, "vibe-auth-test", "width=520,height=720");
      if (!w) setError("Popup blocked. Allow popups for this site and try again.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cn = (k: keyof NonNullable<AuthSettingsPageProps["classNames"]>) => p.classNames?.[k];
  const st = (k: keyof typeof s, ck?: keyof NonNullable<AuthSettingsPageProps["classNames"]>) => (ck && p.classNames?.[ck] ? undefined : s[k]);

  if (!data) return <div className={cn("root")}>{error ? <p style={st("error", "error")}>{error}</p> : "Loading…"}</div>;

  const modeDesc: Record<Mode, string> = {
    local: "Local passwords only. Single sign-on is off for this product.",
    both: "Local passwords and single sign-on both work.",
    oidc_only: "Single sign-on only. Local passwords are disabled except for the break-glass account.",
  };

  return (
    <div className={cn("root")} style={st("root", "root")}>
      {error && (
        <p className={cn("error")} style={st("error", "error")} role="alert">
          {error}
        </p>
      )}

      <section className={cn("section")} style={st("section", "section")}>
        <h3 style={{ margin: 0 }}>Sign-in mode</h3>
        <div style={s.row}>
          {(data.modes as Mode[]).map((m) => (
            <label key={m} style={{ ...s.row, gap: ".3rem" }}>
              <input type="radio" name="vibe-auth-mode" checked={data.mode === m} disabled={busy || (m !== "local" && !data.effective)} onChange={() => void setMode(m)} />
              <code>{m}</code>
            </label>
          ))}
        </div>
        <p className={cn("note")} style={st("note", "note")}>
          {modeDesc[data.mode]}
        </p>
        {!data.guards.canEnableOidcOnly && (
          <p className={cn("note")} style={st("note", "note")}>
            <strong>oidc_only</strong> requires the break-glass account {data.breakglass.exists ? "(present)" : "(missing — run npx vibe-auth breakglass ensure)"} and a successful connection test in this session
            {data.testLogin.ok ? " (done)" : " (not yet)"}.
          </p>
        )}
      </section>

      <section className={cn("section")} style={st("section", "section")}>
        <h3 style={{ margin: 0 }}>Identity provider</h3>
        <div style={s.row}>
          <span style={s.pill}>{data.idp.reachable ? "reachable" : "unreachable"}</span>
          {data.idp.lastError && <span style={s.note}>{data.idp.lastError}</span>}
          {data.env.issuer && <span style={s.pill}>configured by console</span>}
        </div>
        <label className={cn("label")} style={st("label", "label")}>
          Issuer URL
          <input className={cn("input")} style={st("input", "input")} value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.firm.example/application/o/vibe-tb/" />
        </label>
        <label className={cn("label")} style={st("label", "label")}>
          Internal base URL (optional, server-to-server)
          <input className={cn("input")} style={st("input", "input")} value={internalBase} onChange={(e) => setInternalBase(e.target.value)} placeholder="http://vibe-auth-authentik-server:9000" />
        </label>
        <label className={cn("label")} style={st("label", "label")}>
          Client ID
          <input className={cn("input")} style={st("input", "input")} value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className={cn("label")} style={st("label", "label")}>
          Client secret {data.effective?.hasSecret ? <span style={s.pill}>set</span> : <span style={s.pill}>not set</span>}
          <input className={cn("input")} style={st("input", "input")} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="leave blank to keep" autoComplete="off" />
        </label>
        <label className={cn("label")} style={st("label", "label")}>
          Button label
          <input className={cn("input")} style={st("input", "input")} value={idpName} onChange={(e) => setIdpName(e.target.value)} placeholder="Vibe Auth" />
        </label>
        {data.effective && (
          <p className={cn("note")} style={st("note", "note")}>
            Redirect URI registered with the provider: <code>{data.effective.redirectUri}</code>
          </p>
        )}
      </section>

      <section className={cn("section")} style={st("section", "section")}>
        <h3 style={{ margin: 0 }}>Roles</h3>
        <p className={cn("note")} style={st("note", "note")}>
          Map identity-provider groups (or Entra app roles) to {p.productName ?? "product"} roles. Roles claim <code>{data.effective?.roleClaim ?? "roles"}</code> is preferred; groups claim <code>{data.effective?.groupsClaim ?? "groups"}</code> is the fallback.
        </p>
        <table className={cn("table")} style={st("table", "table")}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Group / app role</th>
              <th style={{ textAlign: "left" }}>{p.productName ?? "Product"} role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {roleMap.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className={cn("input")} style={st("input", "input")} value={r.key} onChange={(e) => setRoleMap(roleMap.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                </td>
                <td>
                  <select className={cn("input")} style={st("input", "input")} value={r.role} onChange={(e) => setRoleMap(roleMap.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                    {data.roles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" className={cn("button")} style={st("button", "button")} onClick={() => setRoleMap(roleMap.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={s.row}>
          <button type="button" className={cn("button")} style={st("button", "button")} onClick={() => setRoleMap([...roleMap, { key: "", role: data.roles[data.roles.length - 1] ?? "" }])}>
            Add mapping
          </button>
          <label className={cn("label")} style={{ ...s.row, gap: ".4rem" }}>
            Default role when nothing matches
            <select className={cn("input")} style={st("input", "input")} value={defaultRole} onChange={(e) => setDefaultRole(e.target.value)}>
              <option value="">(deny sign-in)</option>
              {data.roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label style={{ ...s.row, gap: ".4rem" }}>
          <input type="checkbox" checked={allowJit} onChange={(e) => setAllowJit(e.target.checked)} /> Create accounts automatically on first sign-in (just-in-time)
        </label>
      </section>

      <section className={cn("section")} style={st("section", "section")}>
        <h3 style={{ margin: 0 }}>Security</h3>
        <label style={{ ...s.row, gap: ".4rem" }}>
          <input type="checkbox" checked={requireMfa} disabled={busy} onChange={(e) => void toggleMfa(e.target.checked)} /> Require MFA on the identity provider (checks the <code>amr</code> claim)
        </label>
        <p className={cn("note")} style={st("note", "note")}>
          Break-glass account <code>{data.breakglass.username}</code>: {data.breakglass.exists ? (data.breakglass.active ? "present and active" : "present but inactive") : "not provisioned"}.
        </p>
      </section>

      <div style={s.row}>
        <button type="button" className={cn("buttonPrimary")} style={st("buttonPrimary", "buttonPrimary")} disabled={busy} onClick={() => void saveConnection()}>
          Save
        </button>
        <button type="button" className={cn("button")} style={st("button", "button")} disabled={busy || !data.effective} onClick={() => void test()}>
          Test connection
        </button>
        {testMsg && <span style={s.note}>{testMsg}</span>}
        {data.stored.updatedAt && (
          <span style={s.note}>
            Last saved {new Date(data.stored.updatedAt).toLocaleString()} by {data.stored.updatedBy}
          </span>
        )}
      </div>
    </div>
  );
}
