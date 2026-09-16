import { useEffect, useState, type ReactNode } from "react";
import { authClient, type AuthStatusDto, type ClientOptions } from "./api.js";

export interface LoginPanelProps extends ClientOptions {
  /** The product's existing local login form. Hidden in oidc_only mode unless `breakglass` is set. */
  children?: ReactNode;
  /** Render on the hidden break-glass route (/login/local) to show the local form even in oidc_only. */
  breakglass?: boolean;
  /** Where to land after SSO. */
  returnTo?: string;
  /** Optional class names to blend with the product's design system. */
  classNames?: { root?: string; button?: string; divider?: string; note?: string };
  /** Override the SSO button label. */
  label?: (idpName: string) => string;
  /** Called when status is loaded (e.g. to hide the product's own form). */
  onStatus?: (s: AuthStatusDto) => void;
}

/**
 * Login panel: renders the product's local form (children) plus a
 * "Sign in with {IdP}" button, driven by GET /auth/status.
 *   - local: children only
 *   - both: children + IdP button
 *   - oidc_only: IdP button only (children shown only when `breakglass`)
 * The IdP button is a plain link (full navigation) so it works inside Tauri's CSP.
 */
export function LoginPanel(p: LoginPanelProps) {
  const [status, setStatus] = useState<AuthStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = authClient(p);

  useEffect(() => {
    let alive = true;
    client
      .status()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        p.onStatus?.(s);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.basePath]);

  const showLocal = !status || status.localLoginVisible || p.breakglass;
  const showSso = !!status && status.oidc.enabled;
  const label = p.label ?? ((n: string) => `Sign in with ${n}`);

  return (
    <div className={p.classNames?.root} data-vibe-auth-mode={status?.mode ?? "loading"}>
      {showSso && (
        <a
          href={client.startPath(p.returnTo)}
          className={p.classNames?.button}
          data-vibe-auth="sso-button"
          aria-disabled={!status.oidc.reachable}
          style={p.classNames?.button ? undefined : { display: "block", textAlign: "center", padding: "0.6rem 1rem", borderRadius: 8, background: "#2563eb", color: "#fff", textDecoration: "none", opacity: status.oidc.reachable ? 1 : 0.7 }}
        >
          {label(status.oidc.idpName)}
        </a>
      )}
      {showSso && !status.oidc.reachable && (
        <p className={p.classNames?.note} data-vibe-auth="idp-unreachable" style={p.classNames?.note ? undefined : { fontSize: "0.85rem", opacity: 0.8 }}>
          {status.oidc.idpName} is currently unreachable{status.mode === "both" ? "; you can still sign in locally." : "."}
        </p>
      )}
      {showSso && showLocal && p.children && (
        <div className={p.classNames?.divider} role="separator" style={p.classNames?.divider ? undefined : { textAlign: "center", margin: "1rem 0", opacity: 0.6 }}>
          or
        </div>
      )}
      {showLocal && p.children}
      {status?.mode === "oidc_only" && !p.breakglass && (
        <p className={p.classNames?.note} style={p.classNames?.note ? undefined : { fontSize: "0.8rem", opacity: 0.6, marginTop: "1rem" }}>
          Local sign-in is disabled for this product.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
