#!/usr/bin/env bash
# Re-bake the fixed-output node_modules hash in nix/hashes.json after
# bun.lock changes.
#
# hashes.json is keyed per system ("nodeModules": { "<system>": "sha256-…" })
# because bun installs only the optional native packages matching the
# target cpu/os, so each system produces a different tree. A hash can only
# be measured on a builder for that system: this script bakes the CURRENT
# system only. Run it once per system (on a Mac for aarch64-darwin, on an
# aarch64 builder for aarch64-linux) and combine the results.
#
# IMPORTANT: run this from a COMMITTED tree. Nix's evaluation cache can
# serve stale flake sources for dirty git trees, which makes the script
# fight its own edits (the sentinel swap may not be visible to the build).
# Commit first, run, then commit the baked hash it writes.
#
# Usage:
#   nix run .#update-hashes      (or: bash nix/update-hashes.sh)
#
# Mechanism: a fixed-output derivation's hash can only be learned by
# building it. The current system's hash is swapped for a sentinel
# (fakeSha256), the build fails reporting the real hash ("got: sha256-…"),
# which is baked back and verified with a --rebuild (a plain build could
# silently succeed on a store hit and verify nothing).
#
# History: the previous version of this script targeted a different
# flake shape (it grepped for "bunDeps"/"opencodeNodeModules" keys and
# built .#openchamber.bunDeps / .#opencode-cli.node_modules, none of
# which exist in this repo — the OpenCode CLI's own hashes live in the
# opencode repo). It could not have worked here; this rewrite matches
# the flake as it stands: the FOD is the openchamber package's
# node_modules passthru.
set -euo pipefail

[[ -f flake.nix ]] || {
  echo "error: run from the flake root (the directory containing flake.nix)" >&2
  exit 1
}

# NOTE: no NIX variable indirection here. Earlier versions routed nix
# through a variable/array and the nested nix calls failed with parser
# errors that were impossible to reproduce from the shell. Direct calls
# are the reliable form.

log() { printf '[update-hashes] %s\n' "$*"; }

FAKE_SENTINEL="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
HASH_FILE="nix/hashes.json"

system="$(nix eval --impure --raw --expr builtins.currentSystem)"
current="$(grep -oP "\"$system\": \"\\Ksha256-[A-Za-z0-9+/=]+(?=\")" "$HASH_FILE" | head -1)"
[[ -n "$current" ]] || {
  echo "error: no nodeModules hash for $system in $HASH_FILE" >&2
  exit 1
}
log "$system: current hash $current"

if [[ "$current" == "$FAKE_SENTINEL" ]]; then
  log "$system: already at the sentinel — building to capture the real hash"
else
  # Anchor the swap on this system's line only; the file is one key per line.
  sed -i "/\"$system\":/s|$current|$FAKE_SENTINEL|" "$HASH_FILE"
  log "$system: sentinel set, building to discover the hash"
fi

err=$(mktemp)
if nix build --no-link ".#openchamber.node_modules" -L >"$err" 2>&1; then
  rm -f "$err"
  if [[ "$current" == "$FAKE_SENTINEL" ]]; then
    log "$system: build SUCCEEDED with the sentinel — the derivation is not in this build's closure"
    exit 1
  fi
  log "$system: already up to date ($current)"
  exit 0
fi
# The hash-mismatch error names the failing derivation; anchor on it so a
# stray "got:" from another fixed-output derivation cannot be picked up.
got=$(awk '
  /hash mismatch in fixed-output derivation/ && /openchamber-node_modules/ { inblock = 1 }
  inblock && /got:/ { sub(/^.*got:[[:space:]]*/, ""); print; exit }
' "$err")
if [[ -z "$got" ]]; then
  log "$system: no hash reported — a different error occurred:"
  head -8 "$err"
  rm -f "$err"
  exit 1
fi
rm -f "$err"

sed -i "s|$FAKE_SENTINEL|$got|" "$HASH_FILE"
log "$system: baked $got — verifying with a rebuild"
nix build --no-link --rebuild ".#openchamber.node_modules" >/dev/null
log "$system: verified"

others=$(grep -oP '^\s+"\K[a-z0-9_]+-[a-z0-9]+(?=":)' "$HASH_FILE" | grep -v "^$system$" || true)
if [[ -n "$others" ]]; then
  log "note: hashes for $(echo $others | tr '\n' ' ')were NOT re-measured — no builder for them here"
fi
log "done — commit $HASH_FILE"
