# syntax=docker/dockerfile:1
#
# Self-hosted CrossFile signaling image (docs/02 §7, docs/03 M4).
#
# Build context is the repository root (`infra/docker-compose.yml` sets `context: ..`) because the
# server imports the pnpm workspace packages. Only the filtered workspace is installed, and the
# final image contains a single pre-bundled file: no node_modules and no source tree.
#
# Runtime is deliberately boring: plain `node /app/server.cjs`, read-only rootfs, non-root user,
# no volumes, no database, one startup log line. See docs/self-host.md for the audit commands.

# --- build stage: install the workspace and bundle the server --------------------------------
FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# pnpm version is pinned by package.json#packageManager; corepack reads it.
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

WORKDIR /app

# Dependency manifests first so the install layer is cached independently of sources.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/signaling/package.json packages/signaling/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/web/package.json apps/web/package.json
# `--trust-lockfile` skips pnpm's supply-chain-policy network verification, which makes a
# reproducible container build depend on registry metadata round-trips. The committed lockfile
# plus --frozen-lockfile still pin every version; bumping a dependency is a reviewed repo change.
# `--ignore-scripts` is deliberate: the workspace root's devDependencies (electron-builder chain)
# are installed even under --filter, and pnpm 12 fails the install on their unapproved lifecycle
# scripts. Neither the esbuild bundle nor the Vite web build needs a lifecycle script.
RUN pnpm install --frozen-lockfile --trust-lockfile --ignore-scripts \
      --filter @crossfile/signaling... --filter @crossfile/web...

# Sources needed by the bundle and the web build (the design system is imported by web styles).
COPY packages/core/src packages/core/src
COPY packages/signaling/src packages/signaling/src
COPY packages/ui/src packages/ui/src
COPY apps/web apps/web
COPY design design
COPY infra/signaling infra/signaling

# esbuild bundles entry.ts + @crossfile/* + ws + zod into one CommonJS file (see build.mjs for why
# the image does not run TypeScript directly).
RUN node infra/signaling/build.mjs /app && node --check infra/signaling/build/server.cjs
# Production single-origin: the build stage also produces the static web app.
# The runtime image must contain the SPA entry; fail the build early if it is missing.
RUN pnpm --filter @crossfile/web build && test -f apps/web/dist/index.html

# --- runtime stage: one file, one process, zero writes ---------------------------------------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="crossfile-signaling" \
      org.opencontainers.image.description="CrossFile ephemeral signaling server (zero storage)" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=/app/public

WORKDIR /app

# Single artifact + static app: no node_modules, no source tree, nothing writable at runtime.
COPY --from=build --chown=node:node /app/infra/signaling/build/server.cjs /app/server.cjs
COPY --from=build --chown=node:node /app/apps/web/dist /app/public

USER node

EXPOSE 8787

# docs/02 §7: no request logs, no access logs. Container logs carry one startup line only.
CMD ["node", "/app/server.cjs"]
