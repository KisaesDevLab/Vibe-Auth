/** Minimal, dependency-free HTML pages used by the auth routes. */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#1b1f24}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8eb}}
.card{max-width:28rem;padding:2rem;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12)}
@media(prefers-color-scheme:dark){.card{background:#181b21}}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;line-height:1.5}
a.btn{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none}
code{font-size:.85em}
`;

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="card">${bodyHtml}</main></body></html>`;
}

export function idpUnavailablePage(o: { idpName: string; mode: string; breakglassPath: string; loginPath: string; error?: string }): string {
  const bg =
    o.mode === "oidc_only"
      ? `<p>If you are the firm administrator and need emergency access, use the <a href="${esc(o.breakglassPath)}">break-glass sign-in</a>.</p>`
      : `<p>You can still <a href="${esc(o.loginPath)}">sign in with a local account</a>.</p>`;
  return page(
    "Identity provider unavailable",
    `<h1>${esc(o.idpName)} is unavailable</h1><p>Single sign-on cannot be reached right now. This product keeps working; only sign-in through ${esc(o.idpName)} is affected.</p>${bg}${o.error ? `<p><code>${esc(o.error)}</code></p>` : ""}<a class="btn" href="javascript:location.reload()">Try again</a>`,
  );
}

export function loginErrorPage(o: { title: string; message: string; loginPath: string }): string {
  return page(o.title, `<h1>${esc(o.title)}</h1><p>${esc(o.message)}</p><a class="btn" href="${esc(o.loginPath)}">Back to sign-in</a>`);
}

export function loggedOutPage(o: { loginPath: string; idpName: string }): string {
  return page("Signed out", `<h1>You are signed out</h1><p>Your ${esc(o.idpName)} session and this product's session have ended.</p><a class="btn" href="${esc(o.loginPath)}">Sign in again</a>`);
}

/**
 * JSON for embedding inside an inline <script>. JSON.stringify leaves "<", ">" and "&" alone, so a
 * value containing "</script>" or "<!--" would end the script block, and `message` can carry the
 * IdP's error_description query parameter verbatim. U+2028/2029 are line terminators in older JS.
 */
export function scriptJson(v: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const BACKSLASH = String.fromCharCode(0x5c);
  const escape = (c: string) => BACKSLASH + "u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  return JSON.stringify(v).replace(new RegExp("[<>&" + LS + PS + "]", "g"), escape);
}

/** Result page for the Settings "Test connection" popup: posts a message to the opener and closes. */
export function testResultPage(result: Record<string, unknown>): string {
  const payload = scriptJson({ type: "vibe-auth:test-result", ...result });
  const ok = result.ok === true;
  return page(
    ok ? "Connection test passed" : "Connection test failed",
    `<h1>${ok ? "Connection test passed" : "Connection test failed"}</h1><p>${esc(String(result.message ?? ""))}</p><p>You can close this window.</p>
<script>
try{if(window.opener){window.opener.postMessage(${payload},window.location.origin);setTimeout(function(){window.close()},1500)}}catch(e){}
</script>`,
  );
}

export function loopbackHandoffPage(o: { url: string }): string {
  return page(
    "Returning to the desktop app",
    `<h1>Signed in</h1><p>Returning you to the desktop application…</p><a class="btn" href="${esc(o.url)}">Continue</a><script>location.replace(${scriptJson(o.url)})</script>`,
  );
}
