{
  lib,
  stdenv,
  makeWrapper,
  bun,
  nodejs,
  git,
  openssh,
  python3,
  cloudflared,
  less,
  bash,
  coreutils,
  opencodeCli,
  self,
  version,
}:

let
  # Runtime PATH parity with the Docker image (Dockerfile lines 29-58):
  # the server spawns opencode, git, ssh, python3, and cloudflared. opencode
  # comes from upstream's flake, pinned to the 2.x version OpenChamber
  # requires (nixpkgs' opencode package is the older 1.x line).
  runtimePath = lib.makeBinPath [
    bun
    nodejs
    git
    openssh
    python3
    cloudflared
    less
    bash
    coreutils
    opencodeCli
  ];

  src = lib.cleanSourceWith {
    src = self;
    filter =
      path: _type:
      let
        name = baseNameOf (toString path);
      in
      !lib.elem name [
        "node_modules"
        "dist"
        ".tmp"
        ".turbo"
        ".vite"
        ".direnv"
        ".envrc"
        "result"
      ];
  };

  # Fixed-output derivation pinning the whole bun dependency tree.
  # Mirrors the Dockerfile deps stage: bun install --frozen-lockfile
  # --ignore-scripts. Patches from package.json patchedDependencies are
  # applied by bun itself; native builds are skipped, matching Docker.
  bunDeps = stdenv.mkDerivation {
    pname = "openchamber-bun-deps";
    inherit version src;

    nativeBuildInputs = [ bun ];

    configurePhase = ":";
    buildPhase = ''
      export HOME="$PWD/.bun-home"
      mkdir -p "$HOME"
      bun install --frozen-lockfile --ignore-scripts
    '';
    installPhase = ''
      mkdir -p "$out"
      cp -a node_modules "$out/node_modules"
      find packages -maxdepth 2 -type d -name node_modules | while read -r dir; do
        mkdir -p "$out/$(dirname "$dir")"
        cp -a "$dir" "$out/$dir"
      done
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-+iP2s34D9Dzi4oACY2ZL3T7Xo95ns+jG+cJQ3Der3zA=";

    # Keep node_modules byte-identical to what bun produced (Docker parity):
    # no shebang rewriting, no patchelf, no symlink checks. Workspace .bin
    # symlinks only resolve once this is overlaid on the full source tree.
    dontFixup = true;
  };

  # Shared build: deps + sdk/web build + the runtime layout that both the
  # server CLI and the desktop app consume.
  openchamberCore = stdenv.mkDerivation {
    pname = "openchamber-core";
    inherit version src;

    nativeBuildInputs = [
      bun
      nodejs
    ];

    configurePhase = ''
      cp -a "${bunDeps}"/. .
      chmod -R u+w .
      # The build sandbox has no /usr/bin/env, so point .bin scripts at the
      # store node/bun before running the build.
      patchShebangs node_modules
      for dir in packages/*/node_modules; do
        [ -d "$dir" ] && patchShebangs "$dir"
      done
    '';

    buildPhase = ''
      # Same two commands as the Dockerfile builder stage. The server imports
      # @openchamber/sdk at runtime, so its dist output must exist.
      bun run --cwd packages/sdk build
      bun run build:web
    '';

    installPhase = ''
      appRoot="$out/lib/openchamber"
      mkdir -p "$appRoot/packages/web" "$appRoot/packages/sdk"

      # Runtime layout copied from the Dockerfile runtime stage.
      cp package.json "$appRoot/package.json"
      cp -a node_modules "$appRoot/node_modules"
      if [ -d packages/web/node_modules ]; then
        cp -a packages/web/node_modules "$appRoot/packages/web/node_modules"
      fi
      cp packages/web/package.json "$appRoot/packages/web/package.json"
      cp -a packages/web/bin "$appRoot/packages/web/bin"
      cp -a packages/web/server "$appRoot/packages/web/server"
      cp -a packages/web/dist "$appRoot/packages/web/dist"
      cp packages/sdk/package.json "$appRoot/packages/sdk/package.json"
      cp -a packages/sdk/dist "$appRoot/packages/sdk/dist"
    '';

    passthru = {
      inherit bunDeps src;
    };

    # node_modules must stay pristine (Docker parity); fixup hooks only
    # rewrite and reject things here.
    dontFixup = true;
  };
in
stdenv.mkDerivation {
  pname = "openchamber";
  inherit version;

  dontUnpack = true;
  dontConfigure = true;
  dontBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    mkdir -p "$out/bin"
    makeWrapper "${bun}/bin/bun" "$out/bin/openchamber" \
      --run "cd ${openchamberCore}/lib/openchamber" \
      --add-flags "packages/web/bin/cli.js" \
      --prefix PATH : "${runtimePath}" \
      --set NODE_ENV production \
      --set LANG C.UTF-8
  '';

  passthru = {
    inherit bunDeps src;
    core = openchamberCore;
  };

  meta = {
    description = "Web UI and server for OpenCode sessions";
    homepage = "https://github.com/openchamber/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
