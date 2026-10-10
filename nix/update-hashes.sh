#!/usr/bin/env bash
# Re-bake the fixed-output dependency hashes after bun.lock or the pinned
# OpenCode tag changes.
#
# IMPORTANT: run this from a COMMITTED tree. Nix's evaluation cache can serve
# stale flake sources for dirty git trees, which makes the script fight its
# own edits (the sentinel swap may not be visible to the build). Commit
# first, run, then commit the baked hash it writes.
#
# Usage:
#   nix run .#update-hashes
#       Re-bake both hashes at the currently locked state (bun.lock, and the
#       opencode input revision recorded in flake.lock).
#   nix run .#update-hashes -- --opencode-tag v2.0.23
#       Additionally move the opencode flake input to a tag, re-lock, and
#       bake its node_modules hash. Keep the tag in sync with
#       packages/electron/package.json (opencodeCli.version).
#
# Mechanism: a build-produced fixed-output derivation can only be hashed by
# building it. Each hash is swapped for a sentinel (fakeSha256), the build
# fails reporting the real hash ("got: sha256-…"), which is then baked back
# and verified with a clean build. This is the same two-pass flow upstream's
# own flake documents; here it is scripted.
set -euo pipefail

[[ -f flake.nix ]] || {
  echo "error: run from the flake root (the directory containing flake.nix)" >&2
  exit 1
}

# NOTE: no NIX variable indirection here. Earlier versions routed nix through
# a variable/array and the nested nix calls failed with parser errors that
# were impossible to reproduce from the shell. Direct calls with the ambient
# flake configuration (enabled system-wide on NixOS) are the reliable form.

log() { printf '[update-hashes] %s\n' "$*"; }

# first-hash <file>: print the first sha256 literal in a file.
first_hash() { grep -oP '"\Ksha256-[A-Za-z0-9+/=]+(?=")' "$1" | head -1; }

# got-hash <logfile>: print the hash the failed FOD reported.
got_hash() {
  grep -oP 'got:\s+\Ksha256-[A-Za-z0-9+/=]+' "$1" | head -1
}

# rehash <file> <current-hash> <build-target> <label>
#   Swap current -> sentinel, build, bake the reported hash, verify.
rehash() {
  local file="$1" current="$2" target="$3" label="$4"
  local err got

  if [[ "$current" == "$FAKE_SENTINEL" ]]; then
    log "$label: already at the sentinel — building to capture the real hash"
  else
    sed -i "s|$current|$FAKE_SENTINEL|" "$file"
    log "$label: sentinel set, building to discover the hash"
  fi

  err=$(mktemp)
  if nix build "$target" -L >"$err" 2>&1; then
    rm -f "$err"
    if [[ "$current" == "$FAKE_SENTINEL" ]]; then
      log "$label: build SUCCEEDED with the sentinel — the derivation is not in this build's closure"
      exit 1
    fi
    log "$label: already up to date ($current)"
    return 0
  fi
  got=$(got_hash "$err" || true)
  if [[ -z "$got" ]]; then
    log "$label: no hash reported — a different error occurred:"
    head -8 "$err"
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"

  sed -i "s|$FAKE_SENTINEL|$got|" "$file"
  log "$label: baked $got — verifying"
  nix build "$target" -L >/dev/null
  log "$label: verified"
}

FAKE_SENTINEL="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

# ─── 1. bun dependencies (openchamber bun.lock) ───────────────

bun_file="nix/package.nix"
bun_current=$(grep -oP 'outputHash = "\Ksha256-[A-Za-z0-9+/=]+' "$bun_file" | head -1)
log "bun-deps: current hash $bun_current"
rehash "$bun_file" "$bun_current" ".#openchamber" "bun-deps"

# ─── 2. opencode CLI node_modules (upstream flake at the pin) ──

if [[ "${1:-}" == "--opencode-tag" ]]; then
  tag="${2:?--opencode-tag needs a value}"
  sed -i "s|github:anomalyco/opencode/[^\"]*|github:anomalyco/opencode/$tag|" flake.nix
  nix flake lock --update-input opencode >/dev/null
  log "opencode: input moved to $tag (keep packages/electron opencodeCli.version in sync)"
fi

flake_hash=$(first_hash flake.nix)
log "opencode-cli: current hash $flake_hash"
rehash "flake.nix" "$flake_hash" ".#opencode-cli" "opencode-cli"

log "done — commit flake.nix and nix/package.nix"
