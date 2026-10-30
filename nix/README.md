# Nix builds

Run the server with `nix run .#openchamber` or build the desktop with `nix build .#openchamber-desktop`.

Server and desktop outputs support `x86_64-linux`, `aarch64-linux` and `aarch64-darwin`. On macOS, the desktop output contains `Applications/OpenChamber.app`; `nix run .#gui` starts its executable. The Nix app is ad-hoc signed, not notarized.

Bun dependencies come from `bun.lock`. The pinned bun2nix converter runs in a Nix derivation, and `fetchBunDeps` fetches each package using its lockfile integrity hash. The dependency installation runs offline with lifecycle scripts disabled. Dependency patches listed in `package.json` are applied when building the cache.

The generated dependency expression stays in the Nix store. Changing `bun.lock` requires no generated file or aggregate dependency hash update. Evaluation requires import-from-derivation and may build the converter before returning a result.

OpenCode uses its upstream Nix dependency recipe and upstream hashes at the revision pinned in `flake.lock`. Its Git and non-registry dependencies require prefetching in the current bun2nix converter, so converting that separate repository's dependency installation is outside this packaging change.

When changing `opencodeCli.version` in `packages/electron/package.json`, update the matching OpenCode tag in `flake.nix` and run `nix flake update opencode`.

Validate changes with `nix build .#openchamber .#openchamber-desktop` and `nix run .#openchamber -- --version`. Desktop launch requires a graphical session.

The `nix-eval` workflow evaluates and builds both packages on native runners for all 3 systems. Evaluation may build the bun2nix converter through import-from-derivation, including with `nix flake check --no-build`.
