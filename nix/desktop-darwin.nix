{
  lib,
  stdenvNoCC,
  bun,
  nodejs_24,
  python3,
  electron,
  opencode,
  node_modules,
  src,
}:
let
  cleanSrc = lib.cleanSourceWith {
    inherit src;
    filter = path: _type: !(lib.hasInfix "/node_modules" path);
  };

  version = (lib.importJSON "${cleanSrc}/packages/web/package.json").version;
  electronBuild = (lib.importJSON "${cleanSrc}/packages/electron/package.json").build;
in
stdenvNoCC.mkDerivation {
  pname = "openchamber-desktop";
  inherit version;
  src = cleanSrc;

  nativeBuildInputs = [
    bun
    nodejs_24
    python3
  ];

  # Re-signing a whole bundle needs Apple's /usr/bin/codesign (sigtool only signs
  # single Mach-O files), so this builds with the darwin sandbox off (the default)
  # or relaxed.
  __noChroot = true;

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    export BUN=${lib.getExe bun}
    cp -R ${node_modules}/. .
    chmod -R u+w .
    patchShebangs node_modules packages
    mkdir -p node_modules/@openchamber
    ln -sfn ../../packages/web node_modules/@openchamber/web
    bun run --cwd packages/sdk build
    bun run --cwd packages/electron build:web-assets
    bun run --cwd packages/electron bundle:main
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    libexec=$out/libexec/openchamber-desktop
    mkdir -p $libexec
    cp -R package.json packages node_modules $libexec/
    chmod -R u+w $libexec/packages
    # packages/sdk's own examples depend on @openchamber/sdk (to demonstrate
    # its own API), so bun's workspace install gives each example its own
    # node_modules/@openchamber/sdk -> (several ../.. up) back into
    # packages/sdk itself -- a real filesystem symlink cycle. Harmless for
    # anything that resolves node_modules normally (require/import never
    # walks a whole tree), but anything that does walk the whole tree --
    # notably nix-darwin's system activation, which materializes this
    # derivation's app bundle with `rsync --copy-unsafe-links` -- recurses
    # the cycle until paths exceed ENAMETOOLONG, burning CPU indefinitely
    # without ever producing a usable bundle (reached through packages/web's
    # own node_modules/@openchamber/sdk symlink, since the app needs
    # packages/web). Examples are dev-only, never imported by the packaged
    # app, so prune their node_modules here before anything downstream can
    # walk into them.
    find $libexec/packages -path '*/examples/*/node_modules' -prune -exec rm -rf {} +

    app=$out/Applications/OpenChamber.app
    mkdir -p $out/Applications
    cp -R ${electron}/Applications/Electron.app $app
    chmod -R u+w $app
    mv $app/Contents/MacOS/Electron $app/Contents/MacOS/OpenChamber
    rm -f $app/Contents/Resources/default_app.asar $app/Contents/Resources/electron.icns

    resources=$app/Contents/Resources
    electronSrc=packages/electron

    # A plain directory named "app" (not app.asar) is what Electron loads; the
    # renamed executable makes app.isPackaged true. Dependencies stay in
    # libexec, outside the signed bundle.
    mkdir -p $resources/app/dist-bundle
    cp $electronSrc/package.json $electronSrc/preload.mjs $resources/app/
    cp $electronSrc/dist-bundle/entry.mjs $electronSrc/dist-bundle/main.mjs \
      $electronSrc/dist-bundle/early-startup.mjs $resources/app/dist-bundle/
    ln -s $libexec/node_modules $resources/app/node_modules
    # node_modules/@openchamber/web (built above) is a relative symlink to
    # ../../packages/web, resolved from inside node_modules -- so it needs
    # packages/ as a sibling of node_modules/ here too, or Electron's main
    # process fails at startup with ERR_MODULE_NOT_FOUND on @openchamber/web
    # (early-startup.mjs imports it; introduced in e601f1627, which this
    # packaging was never updated for). The examples/*/node_modules symlink
    # cycle that would otherwise make this unsafe for rsync to walk is
    # pruned from $libexec/packages above.
    ln -s $libexec/packages $resources/app/packages

    # The same extraResources electron-builder copies (packages/electron/package.json).
    cp -R $electronSrc/resources/web-dist $resources/web-dist
    mkdir -p $resources/icons
    cp $electronSrc/resources/icons/icon.ico $electronSrc/resources/icons/icon.png $resources/icons/
    cp -R $electronSrc/resources/icons/tray $resources/icons/tray
    cp $electronSrc/resources/icons/icon.icns $resources/icon.icns
    cp $electronSrc/resources/icons/Assets.car $resources/Assets.car
    mkdir -p $resources/opencode-cli
    ln -s ${lib.getExe opencode} $resources/opencode-cli/opencode

    # Read by updater-capability.mjs: the Nix store is read-only, so the
    # in-app updater must report updates as unsupported.
    echo nix > $resources/package-type

    python3 - $app/Contents/Info.plist <<'EOF'
    import plistlib, sys
    path = sys.argv[1]
    with open(path, "rb") as f:
        info = plistlib.load(f)
    info.update({
        "CFBundleName": "OpenChamber",
        "CFBundleDisplayName": "OpenChamber",
        "CFBundleExecutable": "OpenChamber",
        # Same id as the released app, so macOS treats both as one app.
        "CFBundleIdentifier": "${electronBuild.appId}",
        "CFBundleIconFile": "icon.icns",
        "CFBundleIconName": "AppIcon",
        "CFBundleShortVersionString": "${version}",
        "CFBundleVersion": "${version}",
        "LSApplicationCategoryType": "${electronBuild.mac.category}",
        "NSLocalNetworkUsageDescription": "${electronBuild.mac.extendInfo.NSLocalNetworkUsageDescription}",
    })
    with open(path, "wb") as f:
        plistlib.dump(info, f)
    EOF

    # Changing Info.plist and Resources invalidates Electron's signature;
    # Apple Silicon refuses to launch an invalid one.
    /usr/bin/codesign --force --deep --sign - $app

    mkdir -p $out/bin
    cat > $out/bin/openchamber-desktop <<EOF
    #!/bin/sh
    exec "$app/Contents/MacOS/OpenChamber" "\$@"
    EOF
    chmod +x $out/bin/openchamber-desktop

    runHook postInstall
  '';

  # Fixup would rewrite files inside the signed bundle.
  dontFixup = true;

  meta = {
    description = "Electron desktop client for OpenCode AI agent";
    homepage = "https://github.com/developing-today-forks/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber-desktop";
    platforms = lib.platforms.darwin;
  };
}
