# syntax=docker/dockerfile:1
#
# Two stages. The BUILD stage has everything needed to produce the client bundle (Vite, the
# TypeScript sources, dev dependencies). The RUNTIME stage starts again from a clean base and
# receives only what the server needs to RUN: production dependencies, the server and shared
# sources (Node strips their types itself — no compile step, no `tsx`), and the built client.
# Vite, TypeScript, Vitest, Playwright, ESLint and the rest never reach the final image.

ARG NODE_IMAGE=node:22-alpine

# ── stage 1: build the client ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Layer order is cache order: the lockfile and the three package.json files change rarely, the
# sources change on every commit. Install FIRST, copy sources AFTER — a one-line source change
# then reuses the (slow) `npm ci` layer.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY tsconfig.base.json ./
COPY shared shared
COPY client client

# stamped into the bundle (shown in the corner of the page) and, below, into the server's /health
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}
RUN npm run build -w client

# ── stage 2: run the server ───────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/naerox/clash-of-planes" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_DIR=/app/logs \
    CLIENT_DIST=/app/client/dist \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

# production dependencies of the two packages the server runs (`-w`), nothing from the root or the client
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --include-workspace-root=false -w server -w shared \
    && npm cache clean --force \
    # the image only ever runs `node`: the package managers are ~25 MB of attack surface and size
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn*

COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/client/dist client/dist

# the process does not run as root; it may write only its match logs
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node

EXPOSE 3000

# the platform polls /health too; this is what `docker ps` and compose see
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Exec form: Node is PID 1 and receives SIGTERM itself. `CMD npm start` (or a shell form) would put
# `npm`/`sh` in between; they do not forward the signal, so `docker stop` waits its 10 s and then SIGKILLs.
CMD ["node", "server/src/index.ts"]
