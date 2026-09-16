/**
 * Tauri loopback login helper (Phase 4). Runs in the Tauri webview (JS side).
 *
 * Flow:
 *   1. Start a localhost listener (tauri-plugin-oauth) → port P.
 *   2. Open the SYSTEM browser at `${serverUrl}${basePath}/auth/oidc/start?loopback_port=P`.
 *   3. The product server completes OIDC, then redirects the browser to
 *      `http://127.0.0.1:P/callback?code=<one-time>`.
 *   4. This helper POSTs the code to `${serverUrl}${basePath}/auth/oidc/exchange`
 *      and receives either a bearer token (SessionAdapter.issueToken) or a cookie session.
 *
 * Peer requirements (in the product's Tauri app):
 *   - `@fabianlars/tauri-plugin-oauth` registered in the Rust shell
 *   - `@tauri-apps/plugin-shell` (opens the system browser)
 *   - `@tauri-apps/plugin-http` OR allow the exchange origin in the CSP `connect-src`
 */

export interface LoopbackLoginOptions {
  /** Product server origin, e.g. https://tb.firm.example or https://192.168.1.10 */
  serverUrl: string;
  /** Product base path, e.g. "/tb" in single-host mode. */
  basePath?: string;
  /** Preferred ports (tauri-plugin-oauth picks a free one when omitted). */
  ports?: number[];
  timeoutMs?: number;
  /** Custom fetch (e.g. @tauri-apps/plugin-http fetch) for the exchange call. */
  fetch?: typeof fetch;
}

export interface LoopbackLoginResult {
  token?: string;
  expiresAt?: string;
  user: { id: string; email: string; name?: string; role: string };
}

interface OauthPlugin {
  start(config?: { ports?: number[]; response?: string }): Promise<number>;
  cancel(port: number): Promise<void>;
  onUrl(handler: (url: string) => void): Promise<() => void>;
}

async function loadOauthPlugin(): Promise<OauthPlugin> {
  const name = "@fabianlars/tauri-plugin-oauth";
  try {
    return (await import(/* @vite-ignore */ name)) as unknown as OauthPlugin;
  } catch {
    throw new Error(`vibe-auth/tauri: ${name} is required in the Tauri app`);
  }
}

async function openExternal(url: string): Promise<void> {
  const name = "@tauri-apps/plugin-shell";
  try {
    const shell = (await import(/* @vite-ignore */ name)) as unknown as { open(u: string): Promise<void> };
    await shell.open(url);
  } catch {
    // Fallback for non-Tauri environments (e.g. tests): open a browser tab.
    if (typeof window !== "undefined") window.open(url, "_blank");
    else throw new Error("vibe-auth/tauri: no way to open the system browser");
  }
}

const RESPONSE_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Signed in</h1><p>You can return to the desktop app.</p><script>setTimeout(()=>window.close(),800)</script></body></html>`;

export async function loopbackLogin(o: LoopbackLoginOptions): Promise<LoopbackLoginResult> {
  const oauth = await loadOauthPlugin();
  const base = o.serverUrl.replace(/\/+$/, "") + (o.basePath ?? "").replace(/\/+$/, "");
  const f = o.fetch ?? fetch;

  const port = await oauth.start({ ports: o.ports, response: RESPONSE_HTML });
  let unlisten: (() => void) | undefined;
  try {
    const code = await new Promise<string>((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error("login timed out")), o.timeoutMs ?? 5 * 60_000);
      oauth
        .onUrl((url) => {
          try {
            const u = new URL(url);
            const c = u.searchParams.get("code");
            if (c) {
              clearTimeout(t);
              resolvePromise(c);
            }
          } catch {
            // ignore malformed
          }
        })
        .then((u) => (unlisten = u))
        .catch(reject);
      void openExternal(`${base}/auth/oidc/start?loopback_port=${port}`).catch(reject);
    });

    const res = await f(`${base}/auth/oidc/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "include",
    });
    if (!res.ok) throw new Error(`exchange failed: HTTP ${res.status}`);
    return (await res.json()) as LoopbackLoginResult;
  } finally {
    unlisten?.();
    await oauth.cancel(port).catch(() => undefined);
  }
}
