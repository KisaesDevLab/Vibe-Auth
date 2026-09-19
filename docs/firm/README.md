# Vibe Auth — firm guide

Vibe Auth gives every member of the firm one sign-in for every Vibe product. It runs on your Appliance next to the products. Nothing changes for a product until you switch it on.

## Turning it on (10 minutes)

1. **Enable Vibe Auth** in the Appliance console → Apps → Vibe Auth → Enable. Wait for the green health badge (about two minutes on first start).
2. **Run the setup wizard.** Console → Identity → "Setup required" shows a link and a one-time token. Open the link, enter your firm name, your name, email and a password (12+ characters). This makes you the first identity administrator.
3. **Sign in once** at the link on the confirmation page and enrol multi-factor authentication (an authenticator app or a security key). MFA is required for everyone by default.
4. **Add your staff** in Vibe Auth → Users (or connect Microsoft 365 / Google Workspace — see below) and put each person in the right group:
   | Group | Meaning in products |
   |---|---|
   | `vibe-admin` | administrator of every product and of Vibe Auth |
   | `vibe-partner` | partner / owner |
   | `vibe-manager` | manager / reviewer |
   | `vibe-staff` | staff / preparer |
   | `vibe-it` | IT administrators: Vibe Auth administration. Note: today this group is also mapped to the administrator role inside each product; to keep IT staff out of a product, restrict that product (below) and do not tick them. |
   New users receive a set-password email (the recovery flow) when outbound email is configured; either way the console shows a one-time link you can hand over in person or by chat. No passwords are ever sent by email.
   **Set up outbound email** (Vibe Auth → Email, or the optional section of the setup wizard): enter your mail server (Microsoft 365: `smtp.office365.com`, port 587, STARTTLS, a mailbox with "Authenticated SMTP" on; Google Workspace: `smtp.gmail.com`, port 587, an app password) and click "Send me a test email". Until this is done, staff cannot use "Forgot password?" on the sign-in page and must ask an administrator for a reset link (Users → "Reset link").
5. **Choose who can use each product (optional).** By default every person in Vibe Auth can sign in to every product. To limit one: Vibe Auth → Products → **Restrict**, then tick people in the **Apps** column on the Users page. `vibe-admin` members can always sign in everywhere. A person who is not ticked sees "Permission denied" when they try, and the product disappears from their app list. Unticking someone signs them out of all products at once; they sign back in to the ones they still have. "Open to everyone" reverses it and keeps your ticked list for later.
   This controls single sign-on only. While a product is in `both` mode, someone who still has a local password for that product can use it; switch the product to `oidc_only` when you need the restriction to be complete.
6. **Switch each product to single sign-on.** Console → Identity → the product → mode:
   - `local` (default): password sign-in only, exactly as before.
   - `both`: password sign-in and a "Sign in with <firm>" button.
   - `oidc_only`: single sign-on only. Only the `vibe-breakglass` emergency account can still use a password (see Runbooks).
   Start with `both`. Each product also has this switch in its own Settings → Authentication page, together with a "Test connection" button.

## Using Microsoft 365 (Entra ID)

Vibe Auth → Identity sources → Microsoft Entra ID. You need an app registration in your Entra tenant:
1. Entra admin centre → App registrations → New registration → Web redirect URI: the URL shown in the Vibe Auth form (`…/source/oauth/callback/entra/`).
2. Certificates & secrets → new client secret → paste the value into Vibe Auth together with the Application (client) ID and Directory (tenant) ID.
3. App roles → create `vibe-admin`, `vibe-partner`, `vibe-manager`, `vibe-staff`, `vibe-it` and assign your users. Token configuration → add the `email` claim.
4. Enterprise applications → Vibe Auth → Properties → Assignment required = Yes.
Staff then click "Microsoft" on the sign-in page. Their group comes from the app role; accounts are matched by verified email.

## Using Google Workspace

Vibe Auth → Identity sources → Google. Create an OAuth client (Web) in Google Cloud Console with the redirect URI shown in the form. Name Google groups `vibe-admin`, `vibe-staff`, … and give the OAuth client the groups scope, or manage groups inside Vibe Auth instead.

## Where things are

| | URL |
|---|---|
| Sign-in page | `https://<your appliance>/auth/` (or `https://auth.<domain>/auth/` in subdomain mode) |
| Vibe Auth admin console | `https://<your appliance>/vibe-auth/admin` |
| Full authentik admin (advanced) | Vibe Auth admin → "Open authentik admin" |

See [runbooks.md](runbooks.md) for emergencies.
