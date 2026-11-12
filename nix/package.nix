{
  lib,
  stdenv,
  makeWrapper,
  bun,
  bun2nix,
  callPackage,
  nodejs,
  git,
  openssh,
  python3,
  cloudflared,
  less,
  bash,
  coreutils,
  gnutar,
  bzip2,
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
    # tar + bzip2: the Docker recipe installs them for local dictation
    # model extraction (a .tar.bz2 unpacked via tar, #2887).
    gnutar
    bzip2
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

  bunCache = callPackage ./bun-cache.nix { inherit bun2nix; } src;

  bunDeps = stdenv.mkDerivation {
    pname = "openchamber-bun-deps";
    inherit version src;

    nativeBuildInputs = [
      bun
      bun2nix.hook
    ];
    bunDeps = bunCache;
    dontRunLifecycleScripts = true;
    dontUseBunPatch = true;
    bunInstallFlags = [
      "--offline"
      "--frozen-lockfile"
    ];

    configurePhase = ":";
    buildPhase = ":";
    installPhase = ''
      mkdir -p "$out"
      cp -a node_modules "$out/node_modules"
      find packages -maxdepth 2 -type d -name node_modules | while read -r dir; do
        mkdir -p "$out/$(dirname "$dir")"
        cp -a "$dir" "$out/$dir"
      done
    '';

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
      "aarch64-darwin"
    ];
  };
}
