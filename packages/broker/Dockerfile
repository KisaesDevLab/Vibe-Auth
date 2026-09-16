# Vibe Auth broker — ghcr.io/kisaesdevlab/vibe-auth (amd64, D8). Build context: repository root.
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/client/package.json packages/client/
COPY packages/broker/package.json packages/broker/
COPY test/ref-app/package.json test/ref-app/
RUN pnpm install --frozen-lockfile
COPY packages/client packages/client
COPY packages/broker packages/broker
RUN pnpm --filter @kisaesdevlab/vibe-auth run build && pnpm --filter @kisaesdevlab/vibe-auth-broker run build
RUN pnpm --filter @kisaesdevlab/vibe-auth-broker --prod deploy /out

FROM node:20-alpine
LABEL org.opencontainers.image.title="Vibe Auth broker" \
      org.opencontainers.image.source="https://github.com/KisaesDevLab/Vibe-Auth" \
      com.kisaes.vibe.product="vibe-auth"
WORKDIR /app
COPY --from=build /out /app
COPY deploy/blueprints /app/blueprints
COPY deploy/backup.contract.yaml /app/backup.contract.yaml
COPY packages/broker/hooks /app/hooks
RUN chmod +x /app/hooks/*.sh && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production VIBE_AUTH_PORT=8080 VIBE_AUTH_AUDIT_FILE=/data/audit.jsonl
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=20 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/server.js"]
