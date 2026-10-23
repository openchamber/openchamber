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
#       opencode input revision recorded in flake.lock). The opencode
#       input first moves to the tag packages/electron pins
#       (opencodeCli.version), which the flake's eval-time assertion enforces.
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

# Both baked hashes live in nix/hashes.json — the single file the bake
# PR touches. flake.lock changes alongside it only when the OpenCode tag
# moves.

log() { printf '[update-hashes] %s\n' "$*"; }

# opencode-hash <file>: the x86_64 node_modules hash baked for the opencode
# input.
opencode_hash() { grep -oP '"opencodeNodeModules": "\Ksha256-[A-Za-z0-9+/=]+(?=")' "$1" | head -1; }

# got-hash <logfile> <drv-name-pattern>: the hash the named failing
# fixed-output derivation reported. A build's closure can hold several FODs
# (bun deps, the opencode CLI's node_modules, the models-dev SDK's), so
# anchor on the derivation name — the first "got:" in the log may belong to
# a different one when more than one pin moved before a run.
got_hash() {
  awk -v re="$2" '
    /hash mismatch in fixed-output derivation/ && $0 ~ re { inblock = 1 }
    inblock && /got:/ { sub(/^.*got:[[:space:]]*/, ""); print; exit }
  ' "$1"
}

# rehash <file> <current-hash> <build-target> <label> <drv-name-pattern>
#   Swap current -> sentinel, build, bake the reported hash, verify.
rehash() {
  local file="$1" current="$2" target="$3" label="$4" drv_re="$5"
  local err got

  if [[ "$current" == "$FAKE_SENTINEL" ]]; then
    log "$label: already at the sentinel — building to capture the real hash"
  else
    sed -i "s|$current|$FAKE_SENTINEL|" "$file"
    log "$label: sentinel set, building to discover the hash"
  fi

  err=$(mktemp)
  if nix build --no-link "$target" -L >"$err" 2>&1; then
    rm -f "$err"
    if [[ "$current" == "$FAKE_SENTINEL" ]]; then
      log "$label: build SUCCEEDED with the sentinel — the derivation is not in this build's closure"
      exit 1
    fi
    log "$label: already up to date ($current)"
    return 0
  fi
  got=$(got_hash "$err" "$drv_re" || true)
  if [[ -z "$got" ]]; then
    log "$label: no hash reported — a different error occurred:"
    head -8 "$err"
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"

  sed -i "s|$FAKE_SENTINEL|$got|" "$file"
  log "$label: baked $got — verifying"
  nix build --no-link "$target" -L >/dev/null
  log "$label: verified"
}

FAKE_SENTINEL="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

bun_file="nix/hashes.json"

# ─── 1. opencode CLI node_modules (upstream flake at the pin) ──
#
# Runs first so every later bake build evaluates a synced pin pair.

# The version source of truth is packages/electron's opencodeCli pin:
# this script follows it, it does not bump it. Bumping the pin (together
# with @opencode/client) is an OpenChamber-side compatibility decision.
cli_version=$(grep -A1 '"opencodeCli"' packages/electron/package.json | grep -oP '"version":\s*"\K[^"]+' | head -1)
[[ -n "$cli_version" ]] || { echo "error: cannot read opencodeCli.version from packages/electron/package.json" >&2; exit 1; }

# Upstream tags are v-prefixed; the pin in packages/electron is not.
tag="v$cli_version"

current_tag=$(grep -oP 'github:anomalyco/opencode/\K[v0-9.]+' flake.nix | head -1)
if [[ "$current_tag" != "$tag" ]]; then
  sed -i "s|github:anomalyco/opencode/[^\"]*|github:anomalyco/opencode/$tag|" flake.nix
  nix flake update opencode >/dev/null
  log "opencode: input moved to $tag (packages/electron pins $cli_version)"
else
  log "opencode: input already at $tag"
fi

cli_hash=$(opencode_hash "$bun_file")
log "opencode-cli: current hash $cli_hash"
rehash "$bun_file" "$cli_hash" ".#opencode-cli.node_modules" "opencode-cli" "opencode-node_modules"

# ─── 2. bun dependencies (openchamber bun.lock) ───────────────

bun_current=$(grep -oP '"bunDeps": "\Ksha256-[A-Za-z0-9+/=]+(?=")' "$bun_file" | head -1)
log "bun-deps: current hash $bun_current"
# Build the FOD itself (via its passthru), not the packages that consume it:
# the hash check happens in the derivation, so the sdk/web builds and the
# server assembly add nothing to the bake.
rehash "$bun_file" "$bun_current" ".#openchamber.bunDeps" "bun-deps" "openchamber-bun-deps"

log "done — commit nix/hashes.json (and flake.lock when the tag moved)"
