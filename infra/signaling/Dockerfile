# syntax=docker/dockerfile:1
#
# CrossFile signaling image: one static Go binary that serves the embedded web app, the
# `/v1/ws` protocol and an in-process TURN relay (docs/02 §7, docs/03 M4, docs/05 §7.5).
#
# Build context is the repository root (`infra/docker-compose.yml` sets `context: ..`).
#   docker build -f infra/signaling/Dockerfile -t crossfile/signaling:local .
#   docker run --rm --read-only --user 65532:65532 -p 8788:8787 \
#     -e HOST=0.0.0.0 -e PORT=8787 crossfile/signaling:local
#
# Runtime properties that matter for AC8/zero-storage: read-only rootfs works, no volumes,
# no shell, non-root (distroless `nonroot` uid 65532), one startup line on stdout, no access
# logs. There is no Node runtime in the final image; Node appears only in the web-build stage.

# --- stage 1: build the web app (Vite) ------------------------------------------------------
FROM node:22-alpine AS web

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# pnpm version is pinned by package.json#packageManager; corepack reads it.
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

WORKDIR /app

# Manifests first so the install layer is cached independently of sources.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/web/package.json apps/web/package.json
# `--trust-lockfile` skips pnpm's supply-chain-policy network verification, which makes a
# reproducible container build depend on registry metadata round-trips; the committed lockfile
# plus --frozen-lockfile still pin every version. `--ignore-scripts` is deliberate: the
# workspace root's devDependencies (electron-builder chain) are installed even under --filter,
# and pnpm 12 fails the install on their unapproved lifecycle scripts. The Vite build needs no
# lifecycle script.
RUN pnpm install --frozen-lockfile --trust-lockfile --ignore-scripts \
      --filter @crossfile/web...

# Sources needed by the web build (the design system is imported by web styles).
COPY packages/core/src packages/core/src
COPY packages/ui/src packages/ui/src
COPY apps/web apps/web
COPY design design

RUN pnpm --filter @crossfile/web build && test -f apps/web/dist/index.html

# --- stage 2: build the static Go binary with the web app embedded --------------------------
FROM golang:1.23-alpine AS gobuild

# apps/signaling-go/build.sh is a bash script; the alpine Go image ships `sh` only.
RUN apk add --no-cache bash

WORKDIR /src

# Module cache layer first, so source edits do not re-download pion/turn.
COPY apps/signaling-go/go.mod apps/signaling-go/go.sum ./apps/signaling-go/
WORKDIR /src/apps/signaling-go
RUN go mod download

COPY apps/signaling-go/ ./
# `//go:embed all:webdist` needs the directory; replace the clean-checkout placeholder with the
# real build (the .gitkeep copy is harmless). SKIP_WEB=1 because stage 1 already built the app.
COPY --from=web /app/apps/web/dist/ ./webdist/
RUN SKIP_WEB=1 bash build.sh \
 && test -x bin/crossfile-signaling \
 && ls -lh bin/crossfile-signaling

# --- stage 3: runtime — distroless static, non-root, no shell, no package manager -----------
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="crossfile-signaling" \
      org.opencontainers.image.description="CrossFile ephemeral signaling server (Go single binary: web app + WebSocket v2 + in-process TURN, zero storage)" \
      org.opencontainers.image.licenses="MIT"

ENV HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

COPY --from=gobuild --chown=nonroot:nonroot /src/apps/signaling-go/bin/crossfile-signaling /app/crossfile-signaling

# distroless `nonroot` is uid 65532; the process never needs to write.
USER nonroot:nonroot

# HTTP/WS + the in-process TURN listener (the relay port range is published by compose).
EXPOSE 8787 3478/tcp 3478/udp

# docs/02 §7: no request logs, no access logs. stdout carries one startup line only.
ENTRYPOINT ["/app/crossfile-signaling"]
