#!/usr/bin/env bash
# Zero-storage audit for the CrossFile signaling server (docs/01 AC8, docs/02 §7).
#
# Three modes:
#   (default) local     — build the Node production bundle, run it under
#                         `strace -f -e trace=openat,openat2,write`, drive a real
#                         create → join → approve → signal → close session through it, then assert
#                         that the process opened no writable file, wrote to no regular file,
#                         touched no database, logged only its startup line, left its cwd empty,
#                         and never echoed the session's roomId/code/display names.
#   --go                — same strace and same 8-step v2 session, but the process under test is
#                         the Go binary: `SKIP_WEB=1 apps/signaling-go/build.sh` then
#                         `apps/signaling-go/bin/crossfile-signaling`. Needs the Go toolchain;
#                         does NOT build or need the Node bundle. SKIP_BUILD=1 reuses an existing
#                         binary. TURN_* is scrubbed so the in-process TURN server stays out of
#                         this audit (the claim under test is "the signaling process writes
#                         nothing", not TURN behaviour).
#   --container         — build and start the docker-compose signaling service with a read-only
#                         rootfs / non-root user / no volumes, run the same session against it,
#                         assert Docker-level read-only + health + single startup log line, prove
#                         writes fail with EROFS, then `docker compose down -v`.
#
# Usage:
#   tests/audit/zero-storage.sh                 # local Node strace audit
#   tests/audit/zero-storage.sh --go            # local Go binary strace audit
#   SKIP_BUILD=1 tests/audit/zero-storage.sh --go   # reuse an existing Go binary
#   tests/audit/zero-storage.sh --container     # container audit (needs Docker)
#   AUDIT_PORT=18787 tests/audit/zero-storage.sh
#   KEEP_TMP=1 tests/audit/zero-storage.sh      # keep trace/logs for inspection
#
# Exit code: 0 = PASS, 1 = FAIL. Never requires sudo: strace traces its own children.
set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "[FAIL] cannot cd to repo root"; exit 1; }

MODE="local"
PORT="${AUDIT_PORT:-18787}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --container) MODE="container" ;;
    --go) MODE="go" ;;
    --local) MODE="local" ;;
    --port) shift; PORT="${1:?--port needs a value}" ;;
    -h|--help) awk 'NR > 1 && /^set -u -o pipefail$/{exit} NR > 1' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[FAIL] unknown argument: $1 (try --help)"; exit 1 ;;
  esac
  shift
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/crossfile-audit.XXXXXX")"
SERVER_LOG="$TMP/server.log"
CLIENT_LOG="$TMP/client.log"
TRACE="$TMP/trace.txt"
AUDIT_CWD="$TMP/cwd"
mkdir -p "$AUDIT_CWD"

STRACE_PID=""
SERVER_PID=""
CONTAINER_ID=""
COMPOSE=(docker compose -p crossfile-audit -f "$ROOT/infra/docker-compose.yml")
FAILED=0

cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$STRACE_PID" ] && kill -0 "$STRACE_PID" 2>/dev/null; then
    kill -TERM "$STRACE_PID" 2>/dev/null || true
  fi
  if [ "$MODE" = "container" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "${KEEP_TMP:-0}" = "1" ]; then
    echo "[EVIDENCE] audit artefacts kept in $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
pass() { say "[PASS] $*"; }
fail() { FAILED=1; say "[FAIL] $*"; }
evidence() { say "[EVIDENCE] $*"; }

# ---------------------------------------------------------------------------------------------
# Local mode: strace the real production bundle.
# ---------------------------------------------------------------------------------------------
run_local() {
  command -v strace >/dev/null 2>&1 || { fail "strace is not installed (apt install strace); use --container instead"; return 1; }
  command -v node >/dev/null 2>&1 || { fail "node is not installed"; return 1; }
  [ -f node_modules/tsx/package.json ] || { fail "workspace dependencies are missing: run 'pnpm install' first"; return 1; }

  say "== Zero-storage audit (local process, strace) =="
  if ! node infra/signaling/build.mjs "$ROOT" >"$TMP/build.log" 2>&1; then
    fail "could not build the production bundle (infra/signaling/build.mjs)"
    tail -n 20 "$TMP/build.log" | sed 's/^/[EVIDENCE]   /'
    return 1
  fi
  pass "production bundle built (infra/signaling/build/server.cjs)"

  # Scrub proxy variables: the server is local, and proxy warnings would add non-startup lines.
  (
    cd "$AUDIT_CWD" || exit 1
    exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy -u NODE_USE_ENV_PROXY \
      PORT="$PORT" HOST=127.0.0.1 \
      strace -f -qq -s 256 -e trace=openat,openat2,write -o "$TRACE" -- \
      node "$ROOT/infra/signaling/build/server.cjs" >"$SERVER_LOG" 2>&1
  ) &
  STRACE_PID=$!

  local ready=0 i
  for i in $(seq 1 150); do
    SERVER_PID="$(pgrep -P "$STRACE_PID" 2>/dev/null | head -n 1)"
    if grep -q "listening on" "$SERVER_LOG" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$STRACE_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    fail "signaling process did not start under strace"
    tail -n 20 "$SERVER_LOG" 2>/dev/null | sed 's/^/[EVIDENCE]   /'
    tail -n 20 "$TRACE" 2>/dev/null | sed 's/^/[EVIDENCE]   /'
    return 1
  fi
  evidence "server pid=${SERVER_PID:-unknown} (child of strace pid=$STRACE_PID), port=$PORT"
  evidence "server stdout: $(head -n 1 "$SERVER_LOG")"

  # Real session over the audited process (create → join → approve → signal → close).
  node --import tsx tests/audit/signal-client.mts "ws://127.0.0.1:$PORT/v1/ws" >"$CLIENT_LOG" 2>&1
  local client_rc=$?
  grep '^CLIENT OK' "$CLIENT_LOG" | sed 's/^/[EVIDENCE] /'
  if [ "$client_rc" -ne 0 ]; then
    fail "signaling session failed (exit $client_rc)"
    tail -n 10 "$CLIENT_LOG" | sed 's/^/[EVIDENCE]   /'
  fi

  # Graceful SIGTERM, exactly what the container gets on `docker compose down`.
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for i in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  wait "$STRACE_PID" 2>/dev/null || true
  STRACE_PID=""
  evidence "trace: $TRACE ($(wc -l <"$TRACE" 2>/dev/null || echo 0) strace lines), server log: $SERVER_LOG"

  node tests/audit/analyze-trace.mjs \
    --trace "$TRACE" \
    --log "$SERVER_LOG" \
    --client-log "$CLIENT_LOG" \
    --workdir "$AUDIT_CWD"
  return $?
}

# ---------------------------------------------------------------------------------------------
# Go mode: strace the production Go binary (single static binary, web app + TURN embedded).
# Same session and the same assertions as local mode; the Node bundle is never built or used.
# ---------------------------------------------------------------------------------------------
run_go() {
  command -v strace >/dev/null 2>&1 || { fail "strace is not installed (apt install strace)"; return 1; }
  command -v node >/dev/null 2>&1 || { fail "node is not installed (needed for the audit client)"; return 1; }
  [ -f node_modules/tsx/package.json ] || { fail "workspace dependencies are missing: run 'pnpm install' first"; return 1; }
  [ -f apps/signaling-go/go.mod ] || { fail "apps/signaling-go is missing (expected the Go signaling server)"; return 1; }
  local bin="$ROOT/apps/signaling-go/bin/crossfile-signaling"

  say "== Zero-storage audit (Go binary, strace) =="
  if [ "${SKIP_BUILD:-0}" = "1" ] && [ -x "$bin" ]; then
    evidence "SKIP_BUILD=1: reusing existing binary $bin"
  else
    # SKIP_WEB=1: the audit never needs the web app, only the /v1/ws listener.
    if ! env SKIP_WEB=1 bash apps/signaling-go/build.sh >"$TMP/build.log" 2>&1; then
      fail "could not build the Go signaling binary (SKIP_WEB=1 apps/signaling-go/build.sh)"
      tail -n 20 "$TMP/build.log" | sed 's/^/[EVIDENCE]   /'
      return 1
    fi
    pass "Go signaling binary built (SKIP_WEB=1; the Node bundle is not involved)"
  fi
  [ -x "$bin" ] || { fail "Go binary is missing or not executable: $bin"; return 1; }
  local bin_size
  bin_size="$(wc -c <"$bin" | tr -d ' ')"
  evidence "binary: apps/signaling-go/bin/crossfile-signaling ($bin_size bytes)"

  # Scrub proxy and TURN variables: the server is local (no proxy warnings on stdout) and the
  # in-process TURN listener stays out of the signaling-process audit.
  (
    cd "$AUDIT_CWD" || exit 1
    exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
      -u TURN_SECRET -u TURN_URIS -u TURN_EXTERNAL_IP -u TURN_LISTEN_PORT -u TURN_MIN_PORT -u TURN_MAX_PORT \
      PORT="$PORT" HOST=127.0.0.1 \
      strace -f -qq -s 256 -e trace=openat,openat2,write -o "$TRACE" -- \
      "$bin" >"$SERVER_LOG" 2>&1
  ) &
  STRACE_PID=$!

  local ready=0 i
  for i in $(seq 1 150); do
    SERVER_PID="$(pgrep -P "$STRACE_PID" 2>/dev/null | head -n 1)"
    if grep -q "listening on" "$SERVER_LOG" 2>/dev/null; then ready=1; break; fi
    if ! kill -0 "$STRACE_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    fail "Go signaling process did not start under strace"
    tail -n 20 "$SERVER_LOG" 2>/dev/null | sed 's/^/[EVIDENCE]   /'
    tail -n 20 "$TRACE" 2>/dev/null | sed 's/^/[EVIDENCE]   /'
    return 1
  fi
  evidence "server pid=${SERVER_PID:-unknown} (child of strace pid=$STRACE_PID), port=$PORT"
  evidence "server stdout: $(head -n 1 "$SERVER_LOG")"

  # Real session over the audited process (create → 2×join/approve → members/profile broadcast
  # → arbitrary-member signals → close), the same client the Node audit uses.
  node --import tsx tests/audit/signal-client.mts "ws://127.0.0.1:$PORT/v1/ws" >"$CLIENT_LOG" 2>&1
  local client_rc=$?
  grep '^CLIENT OK' "$CLIENT_LOG" | sed 's/^/[EVIDENCE] /'
  if [ "$client_rc" -ne 0 ]; then
    fail "signaling session against the Go binary failed (exit $client_rc)"
    tail -n 10 "$CLIENT_LOG" | sed 's/^/[EVIDENCE]   /'
  fi

  # Graceful SIGTERM, exactly what PM2/systemd sends on redeploy.
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for i in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  wait "$STRACE_PID" 2>/dev/null || true
  STRACE_PID=""
  evidence "trace: $TRACE ($(wc -l <"$TRACE" 2>/dev/null || echo 0) strace lines), server log: $SERVER_LOG"

  node tests/audit/analyze-trace.mjs \
    --trace "$TRACE" \
    --log "$SERVER_LOG" \
    --client-log "$CLIENT_LOG" \
    --workdir "$AUDIT_CWD"
  return $?
}

# ---------------------------------------------------------------------------------------------
# Container mode: read-only rootfs / non-root / no volumes, same session, then down -v.
# ---------------------------------------------------------------------------------------------
ws_probe() {
  node -e '
    const ws = new WebSocket(process.argv[1]);
    const timer = setTimeout(() => process.exit(1), 3000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); process.exit(0); };
    ws.onerror = () => { clearTimeout(timer); process.exit(1); };
  ' "$1" 2>/dev/null
}

run_container() {
  command -v docker >/dev/null 2>&1 || { fail "docker is not installed; run without --container for the local audit"; return 1; }
  docker compose version >/dev/null 2>&1 || { fail "docker compose plugin is not available"; return 1; }
  command -v node >/dev/null 2>&1 || { fail "node is not installed (needed for the audit client)"; return 1; }

  say "== Zero-storage audit (container, read-only rootfs) =="
  export TURN_SECRET="${TURN_SECRET:-crossfile-audit-$(date +%s)-$RANDOM}"
  export SIGNAL_PORT="$PORT"
  export TURN_URIS="${TURN_URIS:-}"
  evidence "compose project=crossfile-audit, published signaling port=$PORT, TURN_SECRET=(generated/supplied, not printed)"

  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    # Pre-built image (CI, or a sandbox where the docker builder cannot write its state dir).
    evidence "SKIP_BUILD=1: reusing the existing crossfile/signaling:local image"
  else
    say "-- docker compose build signaling"
    if ! "${COMPOSE[@]}" build signaling >"$TMP/build.log" 2>&1; then
      fail "docker compose build signaling failed"
      tail -n 25 "$TMP/build.log" | sed 's/^/[EVIDENCE]   /'
      return 1
    fi
    pass "signaling image built"
  fi

  if ! "${COMPOSE[@]}" up -d --no-build signaling >"$TMP/up.log" 2>&1; then
    fail "docker compose up signaling failed (port $PORT busy?)"
    tail -n 20 "$TMP/up.log" | sed 's/^/[EVIDENCE]   /'
    return 1
  fi
  CONTAINER_ID="$("${COMPOSE[@]}" ps -q signaling 2>/dev/null | head -n 1)"
  if [ -z "$CONTAINER_ID" ]; then
    fail "could not resolve the signaling container id"
    return 1
  fi

  # --- Docker-level immutability assertions ------------------------------------------------
  local readonly_rootfs config_user mount_count binds capdrop security status
  readonly_rootfs="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER_ID" 2>/dev/null)"
  config_user="$(docker inspect -f '{{.Config.User}}' "$CONTAINER_ID" 2>/dev/null)"
  mount_count="$(docker inspect -f '{{len .Mounts}}' "$CONTAINER_ID" 2>/dev/null)"
  binds="$(docker inspect -f '{{json .HostConfig.Binds}}' "$CONTAINER_ID" 2>/dev/null)"
  capdrop="$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$CONTAINER_ID" 2>/dev/null)"
  security="$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$CONTAINER_ID" 2>/dev/null)"

  if [ "$readonly_rootfs" = "true" ]; then pass "container rootfs is read-only (HostConfig.ReadonlyRootfs=true)"; else fail "container rootfs is not read-only (ReadonlyRootfs=$readonly_rootfs)"; fi
  if [ -n "$config_user" ] && [ "$config_user" != "root" ] && [ "$config_user" != "0" ] && [ "$config_user" != "0:0" ]; then
    pass "container runs as non-root user ($config_user)"
  else
    fail "container user is root/empty (Config.User='$config_user')"
  fi
  if [ "$mount_count" = "0" ] && { [ "$binds" = "null" ] || [ "$binds" = "[]" ]; }; then
    pass "container has no volumes or bind mounts (Mounts=0, Binds=$binds)"
  else
    fail "container has mounts (Mounts=$mount_count, Binds=$binds)"
  fi
  case "$capdrop" in *ALL*) pass "all Linux capabilities dropped (CapDrop=$capdrop)" ;; *) fail "capabilities not fully dropped (CapDrop=$capdrop)" ;; esac
  case "$security" in *no-new-privileges*) pass "no-new-privileges is set" ;; *) fail "no-new-privileges is not set (SecurityOpt=$security)" ;; esac

  # --- Wait for health, then run the real session ------------------------------------------
  local i
  status=""
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER_ID" 2>/dev/null)"
    [ "$status" = "healthy" ] && break
    sleep 1
  done
  if [ "$status" = "healthy" ]; then
    pass "container healthcheck reports healthy (node ws probe on /v1/ws)"
  else
    fail "container healthcheck did not become healthy (status=$status)"
    docker logs "$CONTAINER_ID" 2>&1 | tail -n 15 | sed 's/^/[EVIDENCE]   /'
  fi

  for i in $(seq 1 30); do ws_probe "ws://127.0.0.1:$PORT/v1/ws" && break; sleep 0.5; done
  node --import tsx tests/audit/signal-client.mts "ws://127.0.0.1:$PORT/v1/ws" >"$CLIENT_LOG" 2>&1
  local client_rc=$?
  grep '^CLIENT OK' "$CLIENT_LOG" | sed 's/^/[EVIDENCE] /'
  if [ "$client_rc" -eq 0 ]; then
    pass "real signaling session completed against the container"
  else
    fail "signaling session against the container failed (exit $client_rc)"
    tail -n 10 "$CLIENT_LOG" | sed 's/^/[EVIDENCE]   /'
  fi

  # --- stdout has only the startup line ----------------------------------------------------
  docker logs "$CONTAINER_ID" >"$SERVER_LOG" 2>&1
  local log_lines
  log_lines="$(grep -c . "$SERVER_LOG" 2>/dev/null || true)"
  if [ "$log_lines" = "1" ] && head -n 1 "$SERVER_LOG" | grep -q '^\[crossfile-signaling\] listening'; then
    pass "container stdout has exactly the startup line: $(head -n 1 "$SERVER_LOG")"
  else
    fail "container stdout has $log_lines non-empty line(s); expected only the startup line"
    sed 's/^/[EVIDENCE]   /' "$SERVER_LOG" | head -n 10
  fi

  # --- Read-only proof: a write must fail with EROFS (or EACCES) ---------------------------
  local probe_out write_code
  probe_out="$(docker exec "$CONTAINER_ID" node -e '
    const fs = require("node:fs");
    const probe = (path) => {
      try { fs.writeFileSync(path, "audit"); return "WROTE"; }
      catch (error) { return String(error.code || error.message); }
    };
    const app = probe("/app/.audit-probe");
    const tmp = probe("/tmp/.audit-probe");
    console.log(`app=${app} tmp=${tmp}`);
    process.exit(/^(EROFS|EACCES)$/.test(app) && /^(EROFS|EACCES)$/.test(tmp) ? 0 : 1);
  ' 2>&1)"
  write_code=$?
  if [ "$write_code" -eq 0 ]; then
    pass "writes inside the container fail as expected ($probe_out)"
  else
    fail "container filesystem accepted a write ($probe_out)"
  fi

  # --- Clean shutdown ----------------------------------------------------------------------
  if "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1; then
    pass "docker compose down -v completed (container and volumes removed)"
  else
    fail "docker compose down -v failed"
  fi
  CONTAINER_ID=""
}

# ---------------------------------------------------------------------------------------------
case "$MODE" in
  container) run_container; RC=$? ;;
  go) run_go; RC=$? ;;
  *) run_local; RC=$? ;;
esac

if [ "$RC" -eq 0 ] && [ "$FAILED" -eq 0 ]; then
  say "RESULT PASS (zero-storage audit, $MODE)"
  exit 0
fi
say "RESULT FAIL (zero-storage audit, $MODE)"
exit 1
