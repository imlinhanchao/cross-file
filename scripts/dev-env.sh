#!/usr/bin/env bash
# CrossFile dev environment — source this, never edit shell rc files.
#   source scripts/dev-env.sh
# Idempotent. Linux (this machine); harmless on macOS (CI/dev peers).

# --- Node / pnpm -------------------------------------------------------------
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# --- Android (Tauri 2 mobile shell) -----------------------------------------
if [ -d "$HOME/Android/Sdk" ]; then
  export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  case ":$PATH:" in
    *":$ANDROID_HOME/platform-tools:"*) ;;
    *) export PATH="$ANDROID_HOME/platform-tools:$PATH" ;;
  esac
  case ":$PATH:" in
    *":$ANDROID_HOME/emulator:"*) ;;
    *) export PATH="$ANDROID_HOME/emulator:$PATH" ;;
  esac
  # Newest NDK present (Tauri 2 needs NDK_HOME pointing at an <ndk>/<version> dir).
  if [ -d "$ANDROID_HOME/ndk" ]; then
    _ndk="$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)"
    [ -n "$_ndk" ] && export NDK_HOME="$ANDROID_HOME/ndk/$_ndk"
    unset _ndk
  fi
fi

# --- JDK ---------------------------------------------------------------------
# Gradle needs a real JDK (javac), not a JRE-only install. Prefer, in order:
# /home/hancel/jdk-21, any /usr/lib/jvm JDK with bin/javac, then the plain JRE.
if [ -z "${JAVA_HOME:-}" ]; then
  for candidate in /home/hancel/jdk-21 /usr/lib/jvm/java-21-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-amd64; do
    if [ -x "$candidate/bin/javac" ]; then
      export JAVA_HOME="$candidate"
      break
    fi
  done
  if [ -z "${JAVA_HOME:-}" ]; then
    for candidate in /usr/lib/jvm/*; do
      if [ -x "$candidate/bin/javac" ]; then
        export JAVA_HOME="$candidate"
        break
      fi
    done
  fi
fi

# --- Cargo / crates.io resilience (see docs/adr/0007) ------------------------
# crates.io was observed timing out on `cargo install tauri-cli`; npm CLI is the
# primary path (see package.json), these only make cargo usable when needed.
export CARGO_HTTP_TIMEOUT="${CARGO_HTTP_TIMEOUT:-120}"
export CARGO_HTTP_LOW_SPEED_LIMIT="${CARGO_HTTP_LOW_SPEED_LIMIT:-1}"
export CARGO_NET_RETRY="${CARGO_NET_RETRY:-10}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crossfile-cargo-target}"
# Uncomment when direct crates.io is slow in this network:
# export CARGO_HTTP_PROXY="http://127.0.0.1:7890"

# --- Local dev origin --------------------------------------------------------
# Dev HTTPS terminates on the existing reverse proxy:
#   https://room.net.time-pack.com  ->  127.0.0.1:5173 (vite)
# Secure context is required (WebCrypto); http LAN origins are unsupported.
export CROSSFILE_DEV_ORIGIN="${CROSSFILE_DEV_ORIGIN:-https://room.net.time-pack.com}"

echo "crossfile dev-env: JAVA_HOME=${JAVA_HOME:-unset} ANDROID_HOME=${ANDROID_HOME:-unset} NDK_HOME=${NDK_HOME:-unset}"
