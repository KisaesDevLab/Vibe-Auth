# Build context: repository root (workspace package needed).
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/client/package.json packages/client/
COPY packages/broker/package.json packages/broker/
COPY test/ref-app/package.json test/ref-app/
RUN pnpm install --frozen-lockfile
COPY packages/client packages/client
COPY test/ref-app test/ref-app
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
RUN pnpm --filter @kisaes/vibe-auth run build && pnpm --filter vibe-auth-ref-app run build
RUN pnpm --filter vibe-auth-ref-app --prod deploy /out

FROM node:20-alpine
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production PORT=3005
EXPOSE 3005
USER node
HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD wget -qO- http://127.0.0.1:3005/api/health || exit 1
CMD ["node", "dist/server.js"]
