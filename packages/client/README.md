# @kisaesdevlab/vibe-auth

Single sign-on for Vibe products: OIDC Authorization Code + PKCE middleware (Express and Fastify), pluggable adapters, break-glass CLI, React components and a Tauri loopback helper. Every product keeps its local login; modes are `local` (default), `both`, `oidc_only`.

```ts
import { createVibeAuth, vibeAuthExpress, guardLocalLogin, createPgStores } from "@kisaesdevlab/vibe-auth";

const stores = createPgStores({ query: (sql, params) => pool.query(sql, params).then(r => r.rows) });
const auth = createVibeAuth({
  product: { slug: "vibe-tb", name: "Trial Balance", roles: { roles: ["admin", "reviewer", "preparer"], adminRole: "admin" } },
  users,            // UserAdapter over your users table
  session,          // SessionAdapter over your session mechanism
  identities: stores.identities, settings: stores.settings, revocations: stores.revocations,
  secretWrap,       // your existing key-wrap (encrypt/decrypt)
  audit,            // your audit writer
  basePath: process.env.VITE_BASE_PATH?.replace(/\/$/, "") ?? "",
});
app.use(express.json(), express.urlencoded({ extended: false }));
app.use(vibeAuthExpress(auth));
app.post("/api/login", guardLocalLogin(auth, req => req.body.username), loginHandler);
await auth.start();
```

Env (written by the Appliance console after registration): `VIBE_OIDC_ISSUER`, `VIBE_OIDC_INTERNAL_BASE`, `VIBE_OIDC_CLIENT_ID`, `VIBE_OIDC_CLIENT_SECRET`, `VIBE_OIDC_PUBLIC_URL`, `VIBE_OIDC_IDP_NAME`; firm-controlled: `VIBE_AUTH_MODE`, `VIBE_OIDC_REQUIRE_MFA_AMR`, `VIBE_OIDC_ROLE_MAP`, `VIBE_OIDC_DEFAULT_ROLE`, `VIBE_OIDC_ALLOW_JIT`, `VIBE_BREAKGLASS_USERNAME`.

Tables: run `sql/auth_identities.sql` in your migrations (or `import { authIdentities, authSettings, authRevocations } from "@kisaesdevlab/vibe-auth/sql/drizzle"`).

React: `import { LoginPanel, AuthSettingsPage } from "@kisaesdevlab/vibe-auth/react"`.
CLI: `npx vibe-auth breakglass ensure|rotate|status` (needs `"vibeAuth": { "adapter": "./dist/vibe-auth-adapter.js" }` in package.json).
Tauri: `import { loopbackLogin } from "@kisaesdevlab/vibe-auth/tauri"`.

See `docs/integration-checklist.md` in the repo for the per-product steps.
