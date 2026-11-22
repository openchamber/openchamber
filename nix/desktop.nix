{
  lib,
  stdenvNoCC,
  bun,
  nodejs_24,
  makeWrapper,
  copyDesktopItems,
  makeDesktopItem,
  electron,
  git,
  openssh,
  opencode,
  node_modules,
  src,
  commandLineArgs ? "",
}:
let
  cleanSrc = lib.cleanSourceWith {
    inherit src;
    filter = path: _type: !(lib.hasInfix "/node_modules" path);
  };

  version = (lib.importJSON "${cleanSrc}/packages/web/package.json").version;
in
stdenvNoCC.mkDerivation {
  pname = "openchamber-desktop";
  inherit version;
  src = cleanSrc;

  nativeBuildInputs = [
    bun
    nodejs_24
    makeWrapper
    copyDesktopItems
  ];

  desktopItems = [
    (makeDesktopItem {
      name = "openchamber";
      desktopName = "OpenChamber";
      genericName = "Desktop client for OpenCode AI agent";
      comment = "OpenChamber desktop client for OpenCode AI agent";
      exec = "openchamber-desktop";
      icon = "openchamber";
      terminal = false;
      categories = [ "Development" ];
      startupNotify = true;
      startupWMClass = "openchamber";
    })
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    cp -R ${node_modules}/. .
    chmod -R u+w .
    patchShebangs node_modules packages
    mkdir -p node_modules/@openchamber
    ln -sfn ../../packages/web node_modules/@openchamber/web
    bun run --cwd packages/sdk build
    bun run --cwd packages/electron build:web-assets
    bun run --cwd packages/electron bundle:main
    ln -s ../resources packages/electron/dist-bundle/resources
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/libexec/openchamber-desktop
    cp -R package.json packages node_modules $out/libexec/openchamber-desktop/

    install -Dm644 packages/electron/resources/icons/app-icon.svg \
      $out/share/icons/hicolor/scalable/apps/openchamber.svg
    install -Dm644 packages/electron/resources/icons/icon.png \
      $out/share/icons/hicolor/512x512/apps/openchamber.png

    makeWrapper ${lib.getExe electron} $out/bin/openchamber-desktop \
      --add-flags "$out/libexec/openchamber-desktop/packages/electron" \
      --add-flags "''${NIXOS_OZONE_WL:+''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}" \
      --add-flags ${lib.escapeShellArg commandLineArgs} \
      --prefix PATH : ${lib.makeBinPath [ git openssh opencode ]} \
      --set NODE_ENV production

    runHook postInstall
  '';

  meta = {
    description = "Electron desktop client for OpenCode AI agent";
    homepage = "https://github.com/developing-today-forks/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber-desktop";
    platforms = lib.platforms.linux;
  };
}
