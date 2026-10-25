#!/usr/bin/env bash
# Re-bake the fixed-output dependency hashes after bun.lock or the pinned
# OpenCode tag changes.
#
# The hashes are keyed per system in nix/hashes.json, and this script bakes
# the entries for the system it runs on. opencodeNodeModules pins the
# OpenCode CLI's node_modules at the locked input revision; bunCache pins
# bun's fetched dependency cache.
#
# The opencode pass runs first so every later bake build evaluates a synced
# pin pair: the opencode input first moves to the tag packages/electron
# pins (opencodeCli.version), which the flake's eval-time assertion
# enforces.
#
# Every nix call passes --option eval-cache false. The evaluation cache can
# serve stale flake sources for dirty git trees, which once made CI's verify
# step confirm the sentinel state instead of the freshly baked hash.
# hashes.json edits go through jq so the per-system nesting stays intact.
#
# Usage:
#   nix run .#update-hashes
#       Re-bake this system's hashes at the currently locked state (bun.lock,
#       and the opencode input revision recorded in flake.lock).
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
# The app wrapper in flake.nix puts jq on PATH.

# The system whose hashes this run bakes and verifies.
sys=$(nix --option eval-cache false eval --raw --impure --expr 'builtins.currentSystem')

bun_file="nix/hashes.json"

log() { printf '[update-hashes] %s\n' "$*"; }

# read_key <key>: the hash baked for this system under <key>, empty if none.
read_key() { jq -r --arg s "$sys" ".[\"$1\"][\$s] // empty" "$bun_file"; }

# set_key <key> <value>: write hashes.json[<key>][<sys>] = <value>.
set_key() {
  jq --arg s "$sys" --arg v "$2" ".[\"$1\"][\$s] = \$v" "$bun_file" > "$bun_file.tmp"
  mv "$bun_file.tmp" "$bun_file"
}

# got-hash <logfile> <drv-name-pattern>: the hash the named failing
# fixed-output derivation reported. A build's closure can hold several FODs
# (the bun cache, the opencode CLI's node_modules, the models-dev SDK's), so
# anchor on the derivation name — the first "got:" in the log may belong to
# a different one when more than one pin moved before a run.
got_hash() {
  awk -v re="$2" '
    /hash mismatch in fixed-output derivation/ && $0 ~ re { inblock = 1 }
    inblock && /got:/ { sub(/^.*got:[[:space:]]*/, ""); print; exit }
  ' "$1"
}

# rehash <key> <target> <label> <drv-name-pattern>
#   Swap this system's hash -> sentinel, build, bake the reported hash,
#   verify. An unset key (a platform never baked before) starts at the
#   sentinel directly.
rehash() {
  local key="$1" target="$2" label="$3" drv_re="$4"
  local err got current

  current=$(read_key "$key")
  if [[ "$current" == "$FAKE_SENTINEL" ]]; then
    log "$label: already at the sentinel — building to capture the real hash"
  else
    if [[ -z "$current" ]]; then
      log "$label: no hash baked for $sys yet — sentinel set, building to discover it"
    else
      log "$label: current hash $current"
      log "$label: sentinel set, building to discover the hash"
    fi
    set_key "$key" "$FAKE_SENTINEL"
  fi

  err=$(mktemp)
  if nix build --option eval-cache false --no-link "$target" -L >"$err" 2>&1; then
    rm -f "$err"
    log "$label: build SUCCEEDED with the sentinel — the derivation is not in this build's closure"
    exit 1
  fi
  got=$(got_hash "$err" "$drv_re" || true)
  if [[ -z "$got" ]]; then
    log "$label: no hash reported — a different error occurred:"
    head -8 "$err"
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"

  set_key "$key" "$got"
  log "$label: baked $got — verifying"
  nix build --option eval-cache false --no-link "$target" -L >/dev/null
  log "$label: verified"
}

FAKE_SENTINEL="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

# ─── 1. opencode CLI node_modules (upstream flake at the pin) ──
#
# Runs first so every later bake build evaluates a synced pin pair.

# The version source of truth is packages/electron's opencodeCli pin:
# this script follows it, it does not bump it. Bumping the pin (together
# with @opencode/client) is an OpenChamber-side compatibility decision.
cli_version=$(grep -A1 '"opencodeCli"' packages/electron/package.json | sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[[ -n "$cli_version" ]] || { echo "error: cannot read opencodeCli.version from packages/electron/package.json" >&2; exit 1; }

# Upstream tags are v-prefixed; the pin in packages/electron is not.
tag="v$cli_version"

current_tag=$(sed -n 's|.*github:anomalyco/opencode/\([v0-9.]*\).*|\1|p' flake.nix | head -1)
if [[ "$current_tag" != "$tag" ]]; then
  # -i.bak rather than plain -i: BSD sed (macOS) requires a backup suffix
  # argument where GNU sed treats it as part of the command.
  sed -i.bak "s|github:anomalyco/opencode/[^\"]*|github:anomalyco/opencode/$tag|" flake.nix
  rm flake.nix.bak
  nix --option eval-cache false flake update opencode >/dev/null
  log "opencode: input moved to $tag (packages/electron pins $cli_version)"
else
  log "opencode: input already at $tag"
fi

rehash opencodeNodeModules ".#opencode-cli.node_modules" "opencode-cli" "opencode-node_modules"

# ─── 2. bun dependency cache (openchamber bun.lock) ───────────

# Build the FOD itself (via its passthru), not the packages that consume it:
# the hash check happens in the derivation, so the sdk/web builds and the
# server assembly add nothing to the bake.
rehash bunCache ".#openchamber.bunCache" "bun-cache" "openchamber-bun-cache"

log "done — commit nix/hashes.json (and flake.lock when the tag moved)"
