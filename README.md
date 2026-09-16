# Vibe Auth

Single sign-on for the Vibe product family: a bundled [authentik](https://goauthentik.io) identity provider, a small Node broker that bootstraps it and registers products, and a client package every product embeds.

- **Firms**: [docs/firm/README.md](docs/firm/README.md), [runbooks](docs/firm/runbooks.md)
- **Developers**: [docs/developer.md](docs/developer.md), [integration plan (Phase 8)](docs/INTEGRATION-PLAN.md), [integration checklist](docs/integration-checklist.md), [Entra setup (H1)](docs/entra-setup.md)
- **Build status**: [STATE.md](STATE.md) · **Decisions & discovery**: [VIBE-AUTH-BUILD-PLAN.md](VIBE-AUTH-BUILD-PLAN.md), [COMPAT.md](COMPAT.md), [QUESTIONS.md](QUESTIONS.md)

```
pnpm install && pnpm -r run build && pnpm -r run test
cd test && cp .env.example .env && docker compose --env-file .env up -d --build && node scripts/integration.mjs
```

Artifacts: `@kisaesdevlab/vibe-auth` (GitHub Packages), `ghcr.io/kisaesdevlab/vibe-auth` (broker image, amd64), `deploy/` (compose profile + blueprints).
