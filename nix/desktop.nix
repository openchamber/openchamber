{
  lib,
  stdenv,
  rustPlatform,
  pkg-config,
  cargo-tauri,
  bun,
  nodejs_20,
  cargo,
  rustc,
  jq,
  wrapGAppsHook4,
  makeWrapper,
  dbus,
  glib,
  gtk3,
  libsoup_3,
  librsvg,
  libappindicator-gtk3,
  glib-networking,
  openssl,
  webkitgtk_4_1,
  cairo,
  pango,
  gdk-pixbuf,
  openchamber,
}:
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "openchamber-desktop";
  inherit (openchamber)
    version
    src
    node_modules
    ;

  cargoRoot = "packages/desktop/src-tauri";
  cargoLock.lockFile = ../packages/desktop/src-tauri/Cargo.lock;
  buildAndTestSubdir = finalAttrs.cargoRoot;

  nativeBuildInputs = [
    pkg-config
    cargo-tauri.hook
    bun
    nodejs_20
    cargo
    rustc
    jq
    makeWrapper
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [ wrapGAppsHook4 ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    dbus
    glib
    gtk3
    libsoup_3
    librsvg
    libappindicator-gtk3
    glib-networking
    openssl
    webkitgtk_4_1
    cairo
    pango
    gdk-pixbuf
  ];

  strictDeps = true;

  preBuild = ''
    cp -a ${finalAttrs.node_modules}/{node_modules,packages} .
    chmod -R u+w node_modules packages
    patchShebangs node_modules
    patchShebangs packages/desktop/node_modules 2>/dev/null || true

    mkdir -p packages/desktop/src-tauri/sidecars
    cp ${openchamber}/bin/openchamber packages/desktop/src-tauri/sidecars/openchamber-cli-${stdenv.hostPlatform.rust.rustcTarget}
  '';

  tauriBuildFlags = [
    "--no-sign"
  ];

  postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    mv $out/bin/OpenChamber $out/bin/openchamber-desktop 2>/dev/null || true
    for f in $out/share/applications/*.desktop; do
      sed -i 's|^Exec=OpenChamber$|Exec=openchamber-desktop|' "$f" 2>/dev/null || true
    done
  '';

  meta = {
    description = "OpenChamber Desktop App";
    homepage = "https://github.com/btriapitsyn/openchamber";
    license = lib.licenses.mit;
    mainProgram = "openchamber-desktop";
    inherit (openchamber.meta) platforms;
  };
})
