{
  lib,
  stdenvNoCC,
  callPackage,
  bun,
  nodejs_20,
  makeBinaryWrapper,
  node_modules ? callPackage ./node_modules.nix { },
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "openchamber";
  inherit (node_modules) version src;
  inherit node_modules;

  nativeBuildInputs = [
    bun
    nodejs_20
    makeBinaryWrapper
  ];

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    chmod -R u+w node_modules packages

    # Fix #!/usr/bin/env shebangs for nix sandbox
    patchShebangs node_modules
    for ws in packages/*/node_modules; do
      [ -d "$ws" ] && patchShebangs "$ws"
    done

    # Recreate workspace symlinks so vite can resolve @openchamber/*
    mkdir -p node_modules/@openchamber
    ln -sf ../../packages/ui    node_modules/@openchamber/ui
    ln -sf ../../packages/web   node_modules/@openchamber/web

    runHook postConfigure
  '';

  env.HOME = "/tmp";

  buildPhase = ''
    runHook preBuild

    cd packages/web
    node ../../node_modules/vite/bin/vite.js build
    cd ../..

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/openchamber $out/bin

    # Files matching packages/web "files" field
    cp -r packages/web/dist    $out/lib/openchamber/dist
    cp -r packages/web/server  $out/lib/openchamber/server
    cp -r packages/web/bin     $out/lib/openchamber/bin
    cp -r packages/web/public  $out/lib/openchamber/public  2>/dev/null || true
    cp    packages/web/package.json $out/lib/openchamber/package.json

    # Runtime third-party node_modules
    cp -r node_modules $out/lib/openchamber/node_modules

    # Merge workspace-local deps
    if [ -d "packages/web/node_modules" ]; then
      cp -rn packages/web/node_modules/. $out/lib/openchamber/node_modules/ 2>/dev/null || true
    fi

    # Wrapper: run with bun (the project runtime)
    makeBinaryWrapper ${bun}/bin/bun $out/bin/openchamber \
      --add-flags "$out/lib/openchamber/bin/cli.js"

    runHook postInstall
  '';

  meta = {
    description = "Web and desktop UI for the OpenCode AI coding agent";
    homepage = "https://github.com/btriapitsyn/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber";
    inherit (node_modules.meta) platforms;
  };
})
