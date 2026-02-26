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

    # Merge workspace-local deps (dereference bun symlinks)
    if [ -d "packages/web/node_modules" ]; then
      cp -rLn packages/web/node_modules/. $out/lib/openchamber/node_modules/ 2>/dev/null || true
    fi

    # Hoist all deps from bun's canonical store to root node_modules.
    # Bun keeps transitive deps in .bun/node_modules/ as symlinks that
    # are not on Node/bun's standard resolution path from the root.
    bunStore="$out/lib/openchamber/node_modules/.bun/node_modules"
    if [ -d "$bunStore" ]; then
      for entry in "$bunStore"/*; do
        name="$(basename "$entry")"
        if [ -d "$entry" ] && [ "''${name#@}" != "$name" ]; then
          # Scoped package directory (@scope/name)
          mkdir -p "$out/lib/openchamber/node_modules/$name"
          for sub in "$entry"/*; do
            subname="$(basename "$sub")"
            dest="$out/lib/openchamber/node_modules/$name/$subname"
            [ -e "$dest" ] && continue
            cp -rL "$sub" "$dest"
          done
        else
          dest="$out/lib/openchamber/node_modules/$name"
          [ -e "$dest" ] && continue
          cp -rL "$entry" "$dest"
        fi
      done
    fi

    # Remove dangling symlinks and empty dirs
    find $out/lib/openchamber/node_modules -type l | while IFS= read -r link; do
      if [ ! -e "$link" ]; then
        rm "$link"
      fi
    done
    find $out/lib/openchamber/node_modules -type d -empty -delete 2>/dev/null || true

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
