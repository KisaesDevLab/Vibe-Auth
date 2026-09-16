# Entra ID setup (checkpoint H1)

This is the one step in Phase 1 that a human must perform. It creates the Kisaes production tenant and a `kisaes-test` tenant used by the Phase 2/7 Entra test matrix, and enrols the publisher so the Vibe Auth app registration can be marked "verified publisher".

Record the resulting IDs in `test/.env.entra` (git-ignored; template at `test/.env.entra.example`).

## 1. Kisaes production tenant

1. Sign in at <https://entra.microsoft.com> with the Microsoft account that will own the tenant.
2. **Identity → Overview → Manage tenants → Create**. Choose **Workforce**. Organisation name `Kisaes`, initial domain `kisaes.onmicrosoft.com`, country United States.
3. **Identity → Settings → Domain names → Add custom domain** `kisaes.com`. Add the TXT record it shows at your DNS host, then **Verify**.
4. **Identity → Users → New user → Create user**: `kurt@kisaes.com`, display name Kurt. **Assigned roles → Global Administrator**.
5. Sign in as `kurt@kisaes.com` once and complete MFA registration (Microsoft Authenticator). Confirm at **Protection → Authentication methods → User registration details** that MFA shows *Registered*.
6. **Protection → Conditional Access → Policies → New**: *Require MFA for all users* (target all users, all cloud apps, grant: require multifactor authentication). Enable.
7. Record: **Identity → Overview → Tenant ID** → `ENTRA_PROD_TENANT_ID`.

## 2. `kisaes-test` tenant

1. **Manage tenants → Create → Workforce**. Organisation name `Kisaes Test`, domain `kisaestest.onmicrosoft.com`.
2. Create three users (all with the initial domain), set a password each and note them for `test/.env.entra`:
   | UPN | Display | Purpose |
   |---|---|---|
   | `partner@kisaestest.onmicrosoft.com` | Test Partner | app role `vibe-partner` |
   | `staff@kisaestest.onmicrosoft.com` | Test Staff | app role `vibe-staff` |
   | `nobody@kisaestest.onmicrosoft.com` | Test Nobody | no app role (must be denied) |
3. **Identity → Applications → App registrations → New registration**
   - Name `Vibe Auth (test)`; supported account types *Accounts in this organizational directory only*.
   - Redirect URI (Web): `https://auth.test.local/source/oauth/callback/entra/` — this is Authentik's callback for a source with slug `entra`. Add a second one for the ref-app direct test: `http://localhost:3005/auth/oidc/callback`.
   - **Certificates & secrets → New client secret** (24 months). Record the *value* → `ENTRA_TEST_CLIENT_SECRET`.
   - **Overview**: record *Application (client) ID* → `ENTRA_TEST_CLIENT_ID`, *Directory (tenant) ID* → `ENTRA_TEST_TENANT_ID`.
   - **Token configuration → Add groups claim** → Security groups, emit as *Group ID* for ID token; also **Add optional claim → ID → `email`, `preferred_username`**.
   - **App roles → Create app role** for each of `vibe-admin`, `vibe-partner`, `vibe-manager`, `vibe-staff`, `vibe-it` (allowed member types *Users/Groups*, value = the same string).
   - **Manifest**: set `"accessTokenAcceptedVersion": 2`.
4. **Enterprise applications → Vibe Auth (test) → Users and groups → Add**: assign `partner@…` the role `vibe-partner` and `staff@…` the role `vibe-staff`. Leave `nobody@…` unassigned. Turn **Properties → Assignment required?** to *Yes*.
5. The issuer for this tenant is `https://login.microsoftonline.com/<ENTRA_TEST_TENANT_ID>/v2.0`. Record it as `ENTRA_TEST_ISSUER`.

## 3. Partner Center enrolment and publisher verification

1. <https://partner.microsoft.com/dashboard> → sign in as `kurt@kisaes.com` → **Enroll** in the *Microsoft Cloud Partner Program* (free). Company Kisaes, verify the business email, wait for the legal/business verification (1–5 business days).
2. In Partner Center **Account settings → Identifiers**, copy the **MPN / Partner One ID** → `ENTRA_PARTNER_ID`.
3. In Partner Center **Account settings → User management** add `kurt@kisaes.com` as *Global admin* of the partner account (it must be a user in the Kisaes tenant, not a personal MSA).
4. Back in the **production** tenant: **App registrations → Vibe Auth** (create it with the same settings as §2 but redirect URI `https://auth.<firm-host>/source/oauth/callback/entra/`) → **Branding & properties → Publisher verification → Add MPN ID** → save. Status should become *Verified*. Firms' consent prompts will then show "Kisaes" as a verified publisher.

## 4. Fill `test/.env.entra`

```
ENTRA_PROD_TENANT_ID=
ENTRA_TEST_TENANT_ID=
ENTRA_TEST_ISSUER=https://login.microsoftonline.com/${ENTRA_TEST_TENANT_ID}/v2.0
ENTRA_TEST_CLIENT_ID=
ENTRA_TEST_CLIENT_SECRET=
ENTRA_TEST_USER_PARTNER=partner@kisaestest.onmicrosoft.com
ENTRA_TEST_USER_STAFF=staff@kisaestest.onmicrosoft.com
ENTRA_TEST_USER_NOBODY=nobody@kisaestest.onmicrosoft.com
ENTRA_TEST_PASSWORD=
ENTRA_PARTNER_ID=
```

Then run `node test/scripts/entra-smoke.mjs`, which performs discovery against `ENTRA_TEST_ISSUER` and validates that the `roles` claim is configured (it uses the client-credentials grant to fetch the app manifest via Graph and asserts the five app roles exist). Interactive login tests are part of the Phase 7 matrix.
