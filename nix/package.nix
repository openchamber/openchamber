{
  lib,
  stdenvNoCC,
  bun,
  nodejs_24,
  makeWrapper,
  git,
  openssh,
  opencode,
  src,
  nodeModulesHash ? (lib.importJSON ./hashes.json).nodeModules.${stdenvNoCC.hostPlatform.system},
}:
let
  cleanSrc = lib.cleanSourceWith {
    inherit src;
    filter = path: _type: !(lib.hasInfix "/node_modules" path);
  };

  version = (lib.importJSON "${cleanSrc}/packages/web/package.json").version;

  platform = stdenvNoCC.hostPlatform;
  # bun installs only the optional native packages matching these, so the
  # node_modules output (and its hash) differs per system.
  bunCpu = if platform.isAarch64 then "arm64" else "x64";
  bunOs = if platform.isDarwin then "darwin" else "linux";

  # Fetched with bun, not npm: the fork's patchedDependencies (bun-patches/) cannot be applied by npm.
  node_modules = stdenvNoCC.mkDerivation {
    pname = "openchamber-node_modules";
    inherit version;
    src = cleanSrc;

    impureEnvVars = lib.fetchers.proxyImpureEnvVars;

    nativeBuildInputs = [ bun ];
    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
      bun install --cpu=${bunCpu} --os=${bunOs} --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      find . -type d -name node_modules -prune -exec cp -R --parents {} $out \;
      # Determinism: bun's isolated installer links each store package's
      # dependencies' bins into .bun/<entry>/node_modules/.bin, and whether
      # a given link is created is environment-sensitive — the
      # browserslist <-> update-browserslist-db cyclic peer pair flips
      # between local and CI builds, which kept breaking this
      # fixed-output hash (#449). Nothing in the build or at runtime
      # resolves through these store-internal .bin dirs (the workspace
      # node_modules/.bin dirs are separate and kept), so drop them all:
      # the output tree is then identical no matter which links the
      # local bun happened to create.
      if [ -d $out/node_modules/.bun ]; then
        find $out/node_modules/.bun -mindepth 3 -maxdepth 3 -type d -name .bin -exec rm -rf {} +
      fi
      runHook postInstall
    '';

    dontFixup = true;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = nodeModulesHash;
  };
in
stdenvNoCC.mkDerivation {
  pname = "openchamber";
  inherit version;
  src = cleanSrc;

  nativeBuildInputs = [
    bun
    nodejs_24
    makeWrapper
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -R ${node_modules}/. .
    chmod -R u+w .
    patchShebangs node_modules packages
    bun run --cwd packages/sdk build
    bun run --cwd packages/web build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/openchamber
    cp -R . $out/lib/openchamber/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/openchamber \
      --add-flags $out/lib/openchamber/packages/web/bin/cli.js \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          openssh
          opencode
        ]
      } \
      --set DISABLE_AUTOUPDATER 1 \
      --set npm_config_update_notifier false
    runHook postInstall
  '';

  passthru = { inherit node_modules; };

  meta = {
    description = "OpenChamber built from source";
    license = lib.licenses.mit;
    mainProgram = "openchamber";
    platforms = builtins.attrNames (lib.importJSON ./hashes.json).nodeModules;
  };
}
