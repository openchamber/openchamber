# nix — the flake, its derivations, and the hash-bake mechanism

## Ownership

This directory owns everything Nix: the flake's package outputs
(`openchamber`, `openchamber-desktop`/`gui`, `opencode-cli`), the NOS module,
and `nix/update-hashes.sh`, the two-pass bake script that keeps
`nix/hashes.json` true. The upstream opencode flake owns its own derivations
(including `opencode-cli.node_modules`); the Dockerfile owns the container
recipe, and `bunDeps` keeps its install commands in parity with the
Dockerfile's deps stage. Anything that changes how dependencies are fetched
or installed changes both places or explains why not.

## Invariants

- `nix/hashes.json` keys match what `nix/package.nix` reads (`bunCache`,
  `opencodeNodeModules`), and every value is buildable from the committed
  tree. The automated bake PR (`nix/hash-bake`) is the only writer after a
  `bun.lock` or OpenCode pin change.
- The `bunCache` and `opencodeNodeModules` values are keyed per system in
  `nix/hashes.json`, and each equals what a fresh warm install produces from
  the committed `bun.lock` on that system. The `nix-build.yml` build matrix
  proves this on clean linux/arm64/macos runners for every PR touching the
  dependency inputs.
- The `bunDeps` install never touches the network: the Nix sandbox has none.
  The warmed cache must contain every platform variant the flake targets;
  `bun install --offline` silently skips uncached optionals, so the warm
  install fetches linux and darwin variants explicitly.
- The opencode tag in `flake.nix`, `packages/electron/package.json`
  (`opencodeCli.version`), and the `@opencode/client` pin move together. The
  bake script follows the pin; it never bumps it.

## Decisions

### Why a cache FOD and not a node_modules FOD

`bun install` is not reproducible across machines: five CI bake runs in two
days baked five different node_modules output hashes from near-identical
inputs, and every hash but the baking runner's broke someone's build (#5373
broke local builds the day it merged). Fetched content is integrity-pinned by
bun.lock, so the dependency cache is hashable and machine-independent;
node_modules is not. The old design anchored the hash on the one layer bun
cannot make deterministic.

### Why bunDeps is a normal derivation instead of a fixed-output one

A normal derivation is input-addressed: any bun.lock, package.json, patch, or
bun change produces a new derivation automatically, with no bake step. The
sandbox's lack of network turns the warmed cache into the only possible input,
so the pinned set is enforced by construction instead of detected by a
post-hoc hash mismatch. Byte-level node_modules equality across machines is
not claimed; Docker builds never claimed it either.

### Why the warm install fetches all platforms (--os/--cpu/--libc wildcards)

`bun install --offline` skips an uncached optional dependency silently, and
one warmed cache must serve darwin and arm64 builds from the same baked hash.
`--os=linux --os=darwin --cpu='*' --libc='*'` fetches every variant the flake
targets without pulling win32 content.

### Why not bun2nix

bun2nix v2 generates per-package fetchurl derivations and seeds bun's cache by
hand-crafting cache entries, which broke against bun ~1.3.x (bun2nix issue
#77, adopters left), and its patch handling diverges from bun's patch engine
(issue #109). Letting bun warm its own cache is what bun's docs call the most
robust pre-seed, and it keeps the flake free of generated files and extra
inputs.

### Why the bake script passes --option eval-cache false

Nix's evaluation cache can serve stale flake sources for dirty git trees. The
bake script edits `hashes.json` between builds, so on CI the verify step once
re-evaluated the sentinel state and confirmed a hash it never built (the
#5373 incident). The flag makes every nix call see the file as it is on disk.

### Why the hashes are keyed per system

bun's cache FOD is deterministic per platform but not identical across
platforms. Two causes, one fixed and one accepted:

- Fixed: bun writes the cache's index symlinks
  (`cache/<name>/<version>@@@1` → `cache/<name>@<version>@@@1`, scoped ones
  under `cache/@scope/`) with ABSOLUTE targets pointing at the install-time
  cache location. On linux that is the fixed `/build`, so the hash
  reproduced; on darwin the sandbox build directory is randomized per run,
  and the FOD hashed differently on every run. The install phase rewrites
  each index symlink to a relative target (`../<name>@<version>@@@1` — the
  target dir is always the link dir's parent), making the trees
  path-independent.
- Accepted: even with relative targets, darwin's cache hashes differently
  from linux (`iVgH5FZK…` vs `fFOpQaLRrTz…`) — a residual content difference
  in bun's darwin cache we did not chase further. Both values are stable
  across runs on their platforms.

So each platform's hash is baked by running `nix run .#update-hashes` on
that platform (the script bakes only the running system's entries) and is
proven on that platform's CI runner by the build matrix — the same
per-system pattern upstream's own nix/hashes.json uses for their
node_modules.

### Why hash currency is enforced at PR time instead of baked after merge

An earlier iteration baked all three platforms sequentially after merge and
opened one bake PR per dependency bump. The treadmill worked, but it merged
dependency bumps with stale hashes first and fixed them after: main was
briefly broken for anyone building between the two merges, and every bump
cost an extra PR to review. Enforcing at PR time moves the cost to where
the change happens. A PR touching bun.lock or the opencode pin runs the
bake in check mode on all three runners; a stale hash fails the check with
a ready-to-apply diff in the job summary, and applying it is one command
(`nix run .#update-hashes`) for anyone with nix installed.

The trade-off: drift that arrives without a PR — a nixpkgs bump changing
bun, or an admin merge bypassing the check — surfaces on the next PR or a
local build instead of being auto-fixed. A scheduled check can be added
later if that bites. For the check to be meaningful at all, the dependency
layer underneath must be deterministic per platform; on the earlier
machine-relative hashes a PR-time check would compute a different value per
runner and be pure noise.

### Why the flake targets x86_64-linux, aarch64-linux, and aarch64-darwin

The build matrix claims a platform by building the server green on its
runner; the bunCache hash is platform-independent, so no per-platform bake is
needed (the opencode CLI's node_modules falls back to upstream's per-system
hash outside x86_64-linux). The desktop (`nix/gui.nix`) stays
x86_64-linux-only until its own darwin/arm64 runs are verified; the matrix
builds the server package only. If a darwin bun cache quirk ever surfaces
(clonefile against store paths is the known one), `--backend=copyfile` on the
offline install is the escape hatch.
