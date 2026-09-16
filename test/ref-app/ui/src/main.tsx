import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AuthSettingsPage, LoginPanel, useAuthStatus } from "@kisaes/vibe-auth/react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
const api = (p: string, init?: RequestInit) => fetch(`${BASE}/api${p}`, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init });

function useMe() {
  const [me, setMe] = useState<{ id: string; email: string; role: string } | null | undefined>(undefined);
  const reload = () => api("/me").then(async (r) => setMe(r.ok ? (await r.json()).user : null));
  useEffect(() => void reload(), []);
  return { me, reload };
}

function LocalForm({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const r = await api("/login", { method: "POST", body: JSON.stringify({ username: fd.get("username"), password: fd.get("password") }) });
    if (!r.ok) return setErr((await r.json()).error ?? "failed");
    onDone();
  };
  return (
    <form onSubmit={submit}>
      <input name="username" placeholder="username" autoComplete="username" />
      <input name="password" type="password" placeholder="password" autoComplete="current-password" />
      <button type="submit">Sign in locally</button>
      {err && <p role="alert">{err}</p>}
    </form>
  );
}

function App() {
  const { me, reload } = useMe();
  const { status } = useAuthStatus({ basePath: BASE });
  const path = window.location.pathname.replace(BASE, "") || "/";
  const [view, setView] = useState(path);
  const go = (p: string) => {
    history.pushState(null, "", BASE + p);
    setView(p);
  };
  useEffect(() => {
    const h = () => setView(window.location.pathname.replace(BASE, "") || "/");
    window.addEventListener("popstate", h);
    return () => window.removeEventListener("popstate", h);
  }, []);

  if (me === undefined) return <p>Loading…</p>;

  if (!me) {
    return (
      <main>
        <h1>Ref App</h1>
        <p>Mode: <code>{status?.mode ?? "…"}</code></p>
        <LoginPanel basePath={BASE} returnTo={BASE + "/"} breakglass={view === "/login/local"}>
          <LocalForm onDone={reload} />
        </LoginPanel>
      </main>
    );
  }

  return (
    <main>
      <nav>
        <a href={BASE + "/"} onClick={(e) => (e.preventDefault(), go("/"))}>Home</a>
        {me.role === "admin" && <a href={BASE + "/settings/auth"} onClick={(e) => (e.preventDefault(), go("/settings/auth"))}>Authentication settings</a>}
        <a href={`${BASE}/auth/oidc/logout`}>Sign out</a>
      </nav>
      {view === "/settings/auth" ? (
        <>
          <h1>Settings → Authentication</h1>
          <AuthSettingsPage basePath={BASE} productName="Ref App" />
        </>
      ) : (
        <>
          <h1>Welcome, {me.email}</h1>
          <p>Role: <code>{me.role}</code> · Mode: <code>{status?.mode}</code></p>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
